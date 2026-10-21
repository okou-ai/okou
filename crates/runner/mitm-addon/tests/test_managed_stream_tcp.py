"""Actual socket backpressure must not block the opposite response reader."""

import asyncio
import socket
from unittest.mock import patch

import pytest
from h2.config import H2Configuration
from h2.connection import H2Connection
from h2.events import RequestReceived
from h2.settings import SettingCodes
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.proxy.layers.http._hooks import HttpRequestHeadersHook, HttpResponseHeadersHook
from mitmproxy.proxy.mode_servers import ProxyConnectionHandler
from mitmproxy.proxy.server import ConnectionHandler, ConnectionIO
from mitmproxy.test import taddons

import managed_upload
import mitm_addon
from tests.firewall_auth_helpers import firewall_auth_response
from tests.managed_openrouter_helpers import PATHS, PRESET, sandbox
from tests.managed_wire_helpers import WireSession
from tests.request_handler_helpers import _write_registry
from tests.upstream_connection_helpers import mark_connected_tls_upstream


@pytest.fixture(params=[False, True], ids=["ordinary", "eager"])
async def scheduling(request):
    loop = asyncio.get_running_loop()
    prior = loop.get_task_factory()
    if request.param:
        loop.set_task_factory(asyncio.eager_task_factory)
    try:
        yield
    finally:
        loop.set_task_factory(prior)


@pytest.mark.parametrize("http2", [False, True])
@pytest.mark.parametrize("status", [200, 429])
@pytest.mark.parametrize("upload_state", ["receiving", "parsed", "response-first"])
async def test_split_early_response_with_blocked_upload_writer(
    tmp_path, fake_firewall_headers, scheduling, http2, status, upload_state
):
    parsed_eof = upload_state != "receiving"
    response_first = upload_state == "response-first"
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path))
    body = (
        b'{"model":"'
        + PRESET.encode()
        + b'","messages":[{"content":"'
        + b"x" * (60_000 if parsed_eof else 2 * 1024 * 1024)
        + b'"}]}'
    )
    header = (
        b"POST "
        + PATHS["openai-completions"].encode()
        + b" HTTP/1.1\r\nHost: openrouter.ai\r\nContent-Type: application/json\r\nContent-Length: "
        + str(len(body)).encode()
        + b"\r\n\r\n"
    )
    connections = asyncio.Queue()
    stopped, response_headers = asyncio.Event(), asyncio.Event()
    provider_ready = asyncio.Event()
    flows, hooks = [], []

    async def accept(reader, writer):
        connections.put_nowait((reader, writer))

    class GuestReader(asyncio.StreamReader):
        reads = 0

        async def read(self, n=-1):
            self.reads += 1
            if parsed_eof and self.reads <= 2:
                expected = len(header) if self.reads == 1 else len(body)
                assert expected <= n
                return await super().readexactly(expected)
            return await super().read(n)

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as context,
        fake_firewall_headers(headers={"Authorization": "Bearer tcp-fixture"}),
    ):
        context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry)
        )
        native = WireSession(context).native

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
                    hook.flow.server_conn.alpn = b"h2" if http2 else b"http/1.1"
                await super().handle_hook(hook)
                if isinstance(hook, HttpResponseHeadersHook):
                    response_headers.set()

            async def hook_task(self, hook):
                hooks.append(asyncio.current_task())
                await super().hook_task(hook)

        handler = Handler()
        handler.layer = native
        async with await asyncio.start_server(accept, "127.0.0.1", 0) as listener:
            port = listener.sockets[0].getsockname()[1]
            listener.sockets[0].setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
            guest_reader = GuestReader()
            loop = asyncio.get_running_loop()
            protocol = asyncio.StreamReaderProtocol(guest_reader)
            guest_transport, _ = await loop.create_connection(lambda: protocol, "127.0.0.1", port)
            guest_writer = asyncio.StreamWriter(guest_transport, protocol, guest_reader, loop)
            guest_in, guest_out = await connections.get()
            provider_reader, provider_writer = await asyncio.open_connection("127.0.0.1", port)
            provider_in, provider_out = await connections.get()
            provider_writer.get_extra_info("socket").setsockopt(
                socket.SOL_SOCKET, socket.SO_SNDBUF, 4096
            )
            provider_writer.transport.set_write_buffer_limits(high=1024, low=512)
            native_drain = provider_writer.drain

            async def observe_drain():
                if provider_writer.transport.get_write_buffer_size() > 1024:
                    stopped.set()
                await native_drain()

            async def client():
                guest_out.write(header)
                await guest_out.drain()
                if parsed_eof:
                    await provider_ready.wait()
                guest_out.write(body)
                await guest_out.drain()
                head = await guest_in.readuntil(b"\r\n\r\n")
                reply = await guest_in.readexactly(3)
                return head, reply

            async def provider():
                h2 = H2Connection(H2Configuration(client_side=False, header_encoding=None))

                async def response_prefix():
                    if http2:
                        h2.send_headers(
                            1, [(b":status", str(status).encode()), (b"content-length", b"3")]
                        )
                        h2.send_data(1, b"a")
                        provider_out.write(h2.data_to_send())
                    else:
                        provider_out.write(
                            f"HTTP/1.1 {status} Final\r\nContent-Length: 3\r\n\r\na".encode()
                        )
                    await provider_out.drain()
                    await response_headers.wait()

                if http2:
                    h2.initiate_connection()
                    h2.update_settings({SettingCodes.INITIAL_WINDOW_SIZE: 4 * 1024 * 1024})
                    h2.increment_flow_control_window(4 * 1024 * 1024)
                    head = None
                    while head is None:
                        wire = await provider_in.read(65535)
                        assert wire
                        for event in h2.receive_data(wire):
                            if isinstance(event, RequestReceived):
                                head = dict(event.headers)
                        provider_out.write(h2.data_to_send())
                        await provider_out.drain()
                    assert head[b"authorization"] == b"Bearer tcp-fixture"
                else:
                    head = await provider_in.readuntil(b"\r\n\r\n")
                    assert b"authorization: bearer tcp-fixture" in head.lower()
                if response_first:
                    await response_prefix()
                provider_out.transport.pause_reading()
                provider_ready.set()
                await stopped.wait()
                upload = managed_upload.get(flows[0])
                assert upload is not None
                assert upload.transport_pending
                assert flows[0].request.raw_content is None
                if parsed_eof:
                    assert upload.phase is managed_upload.Phase.COMPLETE
                    assert upload.validator is None
                    assert upload.tail == b""
                else:
                    assert upload.received < len(body)
                if not response_first:
                    await response_prefix()
                if http2:
                    h2.send_data(1, b"bc", end_stream=True)
                    provider_out.write(h2.data_to_send())
                else:
                    provider_out.write(b"bc")
                await provider_out.drain()

            client_conn, server_conn = native.context.client, native.context.server
            handler.transports[client_conn] = ConnectionIO(reader=guest_reader, writer=guest_writer)
            handler.transports[server_conn] = ConnectionIO(
                reader=provider_reader, writer=provider_writer
            )
            with patch.object(provider_writer, "drain", observe_drain):
                readers = [
                    asyncio.create_task(handler.handle_connection(conn))
                    for conn in (client_conn, server_conn)
                ]
                for conn, task in zip((client_conn, server_conn), readers, strict=True):
                    handler.transports[conn].handler = task
                clients = [asyncio.create_task(client()), asyncio.create_task(provider())]
                try:
                    (head, reply), _ = await asyncio.wait_for(asyncio.gather(*clients), 5)
                    assert head.startswith(f"HTTP/1.1 {status}".encode())
                    assert reply == b"abc"
                    assert stopped.is_set()
                    assert flows[0].error is None
                    assert not flows[0].live
                    assert managed_upload.get(flows[0]) is None
                finally:
                    provider_out.transport.resume_reading()
                    for writer in (guest_writer, guest_out, provider_writer, provider_out):
                        writer.transport.abort()
                    for task in [*readers, *clients, *hooks]:
                        if task is not None:
                            task.cancel()
                    await asyncio.gather(
                        *[t for t in [*readers, *clients, *hooks] if t is not None],
                        return_exceptions=True,
                    )
                    await asyncio.gather(
                        *[
                            w.wait_closed()
                            for w in (guest_writer, guest_out, provider_writer, provider_out)
                        ],
                        return_exceptions=True,
                    )
                    for flow in flows:
                        mitm_addon.error(flow)


@pytest.mark.parametrize("ending", ["complete", "cancel", "timeout"])
async def test_native_header_wait_binds_before_body_reads_and_resumes_on_cancel(
    tmp_path, fake_firewall_headers, scheduling, ending
):
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path))
    body = (
        b'{"model":"' + PRESET.encode() + b'","messages":[{"content":"' + b"x" * 200_000 + b'"}]}'
    )
    if ending == "timeout":
        body = body[:-1] + b',"provider":{}}'
    header = (
        b"POST "
        + PATHS["openai-completions"].encode()
        + b" HTTP/1.1\r\nHost: openrouter.ai\r\nContent-Type: application/json\r\nContent-Length: "
        + str(len(body) + (1 if ending == "timeout" else 0)).encode()
        + b"\r\n\r\n"
    )
    accepted = asyncio.Queue()
    entered, release = asyncio.Event(), asyncio.Event()
    discarded = asyncio.Event()
    hooks, flows, reads = [], [], []

    async def accept(reader, writer):
        accepted.put_nowait((reader, writer))

    async def credentials(*_args, **_kwargs):
        entered.set()
        await release.wait()
        return firewall_auth_response(headers={"Authorization": "Bearer header-owned"})

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as context,
        fake_firewall_headers() as fetch,
    ):
        fetch.side_effect = credentials
        context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry)
        )
        native = WireSession(context).native

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
                await super().handle_hook(hook)

            async def hook_task(self, hook):
                hooks.append((hook, asyncio.current_task()))
                await super().hook_task(hook)

            async def drain_writers(self):
                await super().drain_writers()
                if flows:
                    upload = managed_upload.get(flows[0])
                    if upload is not None and upload.phase is managed_upload.Phase.REJECTED:
                        discarded.set()

        handler = Handler()
        handler.layer = native
        async with await asyncio.start_server(accept, "127.0.0.1", 0) as listener:
            port = listener.sockets[0].getsockname()[1]
            client_reader, client_writer = await asyncio.open_connection("127.0.0.1", port)
            guest_in, guest_out = await accepted.get()
            server_reader, server_writer = await asyncio.open_connection("127.0.0.1", port)
            provider_in, provider_out = await accepted.get()
            original_read = client_reader.read

            async def observe_read(n=-1):
                reads.append(n)
                return await original_read(n)

            client_conn, server_conn = native.context.client, native.context.server
            handler.transports[client_conn] = ConnectionIO(
                reader=client_reader, writer=client_writer
            )
            handler.transports[server_conn] = ConnectionIO(
                reader=server_reader, writer=server_writer
            )
            with patch.object(client_reader, "read", observe_read):
                readers = [
                    asyncio.create_task(handler.handle_connection(c))
                    for c in (client_conn, server_conn)
                ]
                for conn, task in zip((client_conn, server_conn), readers, strict=True):
                    handler.transports[conn].handler = task
                provider_read = None
                try:
                    guest_out.write(header + body[:1000])
                    await guest_out.drain()
                    await asyncio.wait_for(entered.wait(), 5)
                    upload = managed_upload.get(flows[0])
                    assert upload is not None
                    guest_out.write(body[1000:])
                    await guest_out.drain()
                    turn = asyncio.get_running_loop().create_future()
                    asyncio.get_running_loop().call_soon(turn.set_result, None)
                    await turn
                    assert reads == [65535]
                    assert upload.received == 0
                    assert flows[0].request.raw_content is None
                    if ending == "cancel":
                        task = next(
                            task for hook, task in hooks if isinstance(hook, HttpRequestHeadersHook)
                        )
                        assert task is not None
                        task.cancel()
                        await asyncio.gather(task, return_exceptions=True)
                        assert flows[0].error is not None
                        assert not flows[0].live
                        assert await asyncio.wait_for(guest_in.read(), 5) == b""
                        assert managed_upload.get(flows[0]) is None
                        provider_read = asyncio.create_task(provider_in.read())
                    elif ending == "timeout":
                        release.set()
                        await asyncio.wait_for(discarded.wait(), 5)
                        head = await asyncio.wait_for(provider_in.readuntil(b"\r\n\r\n"), 5)
                        assert b"authorization: bearer header-owned" in head.lower()
                        await handler.on_timeout()
                        await asyncio.wait_for(asyncio.gather(*readers, return_exceptions=True), 5)
                        assert flows[0].error is not None
                        assert not flows[0].live
                        assert upload.validator is None
                        assert upload.tail == b""
                        assert managed_upload.get(flows[0]) is None
                        assert await asyncio.wait_for(guest_in.read(), 5) == b""
                        provider_read = asyncio.create_task(provider_in.read())
                    else:
                        release.set()
                        head = await asyncio.wait_for(provider_in.readuntil(b"\r\n\r\n"), 5)
                        assert b"authorization: bearer header-owned" in head.lower()
                        assert await asyncio.wait_for(provider_in.readexactly(len(body)), 5) == body
                        provider_out.write(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
                        await provider_out.drain()
                        assert (
                            await asyncio.wait_for(guest_in.readuntil(b"\r\n\r\n"), 5)
                        ).startswith(b"HTTP/1.1 200")
                        assert await asyncio.wait_for(guest_in.readexactly(2), 5) == b"{}"
                        assert managed_upload.get(flows[0]) is None
                finally:
                    release.set()
                    for writer in (client_writer, guest_out, server_writer, provider_out):
                        writer.transport.abort()
                    tasks = [*readers, *[t for _, t in hooks if t is not None]]
                    for task in tasks:
                        task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
                    await asyncio.gather(
                        *[
                            w.wait_closed()
                            for w in (client_writer, guest_out, server_writer, provider_out)
                        ],
                        return_exceptions=True,
                    )
                    if provider_read is not None:
                        forwarded = await asyncio.wait_for(provider_read, 5)
                        if ending == "timeout":
                            assert forwarded
                            assert body.startswith(forwarded)
                            assert len(forwarded) < len(body)
                            assert b'"provider"' not in forwarded
                        else:
                            assert forwarded == b""
                    for flow in flows:
                        mitm_addon.error(flow)
