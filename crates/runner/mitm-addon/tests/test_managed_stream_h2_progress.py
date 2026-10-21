"""Detection must preserve native H2 progress while upstream DATA is queued."""

import asyncio
from unittest.mock import patch

import pytest
from h2.config import H2Configuration
from h2.connection import H2Connection
from h2.events import DataReceived, RequestReceived, ResponseReceived, StreamEnded, StreamReset
from h2.settings import SettingCodes
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.proxy import commands
from mitmproxy.proxy.layers.http import HttpClient
from mitmproxy.proxy.layers.http._hooks import HttpRequestHeadersHook, HttpResponseHeadersHook
from mitmproxy.proxy.layers.http._http2 import Http2Client
from mitmproxy.proxy.mode_servers import ProxyConnectionHandler
from mitmproxy.proxy.server import ConnectionHandler, ConnectionIO
from mitmproxy.test import taddons

import managed_upload
import mitm_addon
from tests.managed_openrouter_helpers import PATHS, PRESET, sandbox
from tests.managed_wire_helpers import WireSession
from tests.request_handler_helpers import _write_registry
from tests.upstream_connection_helpers import mark_connected_tls_upstream


@pytest.mark.parametrize("parallel", [False, True], ids=["same", "sibling"])
@pytest.mark.parametrize("detection", [False, True], ids=["passthrough", "managed"])
@pytest.mark.parametrize("dialect", ["openai-completions", "openai-responses"])
@pytest.mark.parametrize("eager", [False, True], ids=["ordinary", "eager"])
async def test_response_credit_while_upload_has_no_upstream_window(
    tmp_path, fake_firewall_headers, parallel, detection, dialect, eager
):
    loop = asyncio.get_running_loop()
    factory = loop.get_task_factory()
    if eager:
        loop.set_task_factory(asyncio.eager_task_factory)
    key = b"messages" if dialect == "openai-completions" else b"input"
    prefix = b'{"model":"' + PRESET.encode() + b'","' + key + b'":[{"content":"'
    body = prefix + b"x" * (2 * 1024 * 1024) + b'"}]}'
    small_body = b'{"model":"' + PRESET.encode() + b'","' + key + b'":[]}'
    warmup = b": ready\n\n" if parallel else b""
    reply = b": " + b"x" * 100_000 + b"\n\n"
    target = len(warmup) + len(reply)
    upload_stream = 3 if parallel else 1
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path, dialect))
    accepted = asyncio.Queue()
    queued, provider_ready, received_prefix = asyncio.Event(), asyncio.Event(), asyncio.Event()
    flows, hooks = [], []
    response, window_updates = bytearray(), 0
    reset = False

    async def accept(reader, writer):
        accepted.put_nowait((reader, writer))

    try:
        with (
            patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
            taddons.context(Proxyserver(), *([mitm_addon] if detection else [])) as context,
            fake_firewall_headers(headers={"Authorization": "Bearer h2-progress"}),
        ):
            if detection:
                context.options.update(
                    okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry)
                )
            wire = WireSession(context, client_h2=True, provider_h2=True)
            native = wire.native
            native.context.server.alpn = b"h2"

            class Handler(ProxyConnectionHandler):
                def __init__(self):
                    ConnectionHandler.__init__(self, native.context)
                    self.master = context.master

                async def handle_hook(self, hook):
                    if isinstance(hook, HttpRequestHeadersHook):
                        flows.append(hook.flow)
                        mark_connected_tls_upstream(
                            hook.flow,
                            sni="openrouter.ai",
                            server_address=("openrouter.ai", 443),
                            peername=("104.18.32.47", 443),
                        )
                        hook.flow.server_conn.alpn = b"h2"
                        if not detection:
                            hook.flow.request.stream = True
                    elif not detection and isinstance(hook, HttpResponseHeadersHook):
                        assert hook.flow.response is not None
                        hook.flow.response.stream = True
                    await super().handle_hook(hook)

                async def drain_writers(self):
                    upstream = native.connections.get(native.context.server)
                    if isinstance(upstream, HttpClient):
                        upstream = upstream.child_layer
                    if isinstance(upstream, Http2Client) and upstream.h2_conn.stream_buffers:
                        queued.set()
                    await super().drain_writers()

                async def hook_task(self, hook):
                    hooks.append(asyncio.current_task())
                    await super().hook_task(hook)

            handler = Handler()
            handler.layer = native
            async with await asyncio.start_server(accept, "127.0.0.1", 0) as listener:
                port = listener.sockets[0].getsockname()[1]
                guest_reader, guest_writer = await asyncio.open_connection("127.0.0.1", port)
                guest_in, guest_out = await accepted.get()
                provider_reader, provider_writer = await asyncio.open_connection("127.0.0.1", port)
                provider_in, provider_out = await accepted.get()

                async def guest():
                    nonlocal window_updates
                    peer = H2Connection(H2Configuration(client_side=True, header_encoding=None))
                    ended = False

                    def headers(stream, length):
                        peer.send_headers(
                            stream,
                            [
                                (b":method", b"POST"),
                                (b":scheme", b"https"),
                                (b":authority", b"openrouter.ai"),
                                (b":path", PATHS[dialect].encode()),
                                (b"authorization", b"Bearer h2-progress"),
                                (b"content-type", b"application/json"),
                                (b"content-length", str(length).encode()),
                            ],
                        )

                    async def receive():
                        nonlocal ended, window_updates
                        data = await guest_in.read(65535)
                        assert data
                        for event in peer.receive_data(data):
                            if isinstance(event, ResponseReceived):
                                assert dict(event.headers)[b":status"] == b"200"
                            elif isinstance(event, DataReceived):
                                assert event.stream_id == 1
                                response.extend(event.data)
                                peer.acknowledge_received_data(
                                    event.flow_controlled_length, event.stream_id
                                )
                            elif isinstance(event, StreamEnded):
                                assert event.stream_id == 1
                                ended = True
                        feedback = peer.data_to_send()
                        if feedback:
                            window_updates += len(feedback)
                            guest_out.write(feedback)
                            await guest_out.drain()

                    peer.initiate_connection()
                    headers(1, len(small_body) if parallel else len(body))
                    if parallel:
                        peer.send_data(1, small_body, end_stream=True)
                    guest_out.write(peer.data_to_send())
                    await guest_out.drain()
                    while peer.local_flow_control_window(1) < len(body) or len(response) < len(
                        warmup
                    ):
                        await receive()
                    if parallel:
                        headers(upload_stream, len(body))
                        guest_out.write(peer.data_to_send())
                        await guest_out.drain()
                    await provider_ready.wait()
                    for offset in range(0, len(body), peer.max_outbound_frame_size):
                        chunk = body[offset : offset + peer.max_outbound_frame_size]
                        peer.send_data(
                            upload_stream, chunk, end_stream=offset + len(chunk) == len(body)
                        )
                    guest_out.write(peer.data_to_send())
                    await guest_out.drain()
                    while len(response) < target:
                        await receive()
                    assert response == warmup + reply
                    received_prefix.set()
                    while not ended:
                        await receive()
                    assert response == warmup + reply + b"\n"

                async def provider():
                    nonlocal reset
                    peer = H2Connection(H2Configuration(client_side=False, header_encoding=None))
                    peer.initiate_connection()
                    peer.update_settings(
                        {SettingCodes.INITIAL_WINDOW_SIZE: 4 * 1024 * 1024 if parallel else 0}
                    )
                    peer.increment_flow_control_window(4 * 1024 * 1024)
                    header = None
                    while header is None:
                        data = await provider_in.read(65535)
                        assert data
                        for event in peer.receive_data(data):
                            if (
                                isinstance(event, RequestReceived)
                                and event.stream_id == upload_stream
                            ):
                                header = dict(event.headers)
                            elif (
                                isinstance(event, StreamEnded) and parallel and event.stream_id == 1
                            ):
                                peer.send_headers(
                                    1,
                                    [
                                        (b":status", b"200"),
                                        (b"content-length", str(target + 1).encode()),
                                        (b"content-type", b"text/event-stream"),
                                    ],
                                )
                                peer.send_data(1, warmup)
                        provider_out.write(peer.data_to_send())
                        await provider_out.drain()
                    assert header[b"authorization"] == b"Bearer h2-progress"
                    if parallel:
                        peer.update_settings({SettingCodes.INITIAL_WINDOW_SIZE: 0})
                        provider_out.write(peer.data_to_send())
                        await provider_out.drain()
                    provider_ready.set()
                    await queued.wait()
                    # This isolates the detector's protocol-capacity wait from
                    # the native TCP-drain stall also present without detection.
                    assert provider_writer.transport.get_write_buffer_size() == 0
                    if parallel and detection:
                        prior = managed_upload.get(flows[0])
                        assert prior is not None
                        assert prior.phase is managed_upload.Phase.COMPLETE
                        assert not prior.transport_pending
                    if not parallel:
                        peer.send_headers(
                            1,
                            [
                                (b":status", b"200"),
                                (b"content-length", str(target + 1).encode()),
                                (b"content-type", b"text/event-stream"),
                            ],
                        )
                    for offset in range(0, len(reply), peer.max_outbound_frame_size):
                        peer.send_data(1, reply[offset : offset + peer.max_outbound_frame_size])
                    provider_out.write(peer.data_to_send())
                    await provider_out.drain()
                    await received_prefix.wait()
                    peer.send_data(1, b"\n", end_stream=True)
                    provider_out.write(peer.data_to_send())
                    await provider_out.drain()
                    if detection and not parallel:
                        while not reset:
                            data = await provider_in.read(65535)
                            assert data
                            reset = any(
                                isinstance(event, StreamReset) and event.stream_id == upload_stream
                                for event in peer.receive_data(data)
                            )

                client_conn, server_conn = native.context.client, native.context.server
                handler.transports[client_conn] = ConnectionIO(
                    reader=guest_reader, writer=guest_writer
                )
                handler.transports[server_conn] = ConnectionIO(
                    reader=provider_reader, writer=provider_writer
                )
                for command in wire.initial:
                    assert isinstance(command, commands.SendData)
                    assert command.connection is client_conn
                    guest_writer.write(command.data)
                await guest_writer.drain()
                readers = [
                    asyncio.create_task(handler.handle_connection(conn))
                    for conn in (client_conn, server_conn)
                ]
                for conn, task in zip((client_conn, server_conn), readers, strict=True):
                    handler.transports[conn].handler = task
                clients = [asyncio.create_task(guest()), asyncio.create_task(provider())]
                try:
                    await asyncio.wait_for(asyncio.gather(*clients), 5)
                    assert queued.is_set()
                    assert window_updates > 0
                    if detection:
                        assert flows[0].error is None
                        assert not flows[0].live
                        assert managed_upload.get(flows[0]) is None
                finally:
                    writers = (guest_writer, guest_out, provider_writer, provider_out)
                    for writer in writers:
                        writer.transport.abort()
                    tasks = [task for task in [*readers, *clients, *hooks] if task is not None]
                    for task in tasks:
                        task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
                    await asyncio.gather(
                        *[writer.wait_closed() for writer in writers], return_exceptions=True
                    )
                    for flow in flows:
                        mitm_addon.error(flow)
    finally:
        loop.set_task_factory(factory)
