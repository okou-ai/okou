"""Shared H2 capacity waits must preserve the input needed to release storage."""

import asyncio
import json
from contextlib import contextmanager
from threading import Event
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from h2.config import H2Configuration
from h2.connection import H2Connection
from h2.events import DataReceived, PingAckReceived, RequestReceived, ResponseReceived, StreamEnded
from mitmproxy import connection
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.flow import Error
from mitmproxy.proxy import events
from mitmproxy.proxy.context import Context
from mitmproxy.proxy.layers.http import HttpLayer, HTTPMode
from mitmproxy.proxy.layers.http._events import RequestData
from mitmproxy.proxy.layers.http._hooks import HttpRequestHeadersHook
from mitmproxy.proxy.mode_servers import ProxyConnectionHandler
from mitmproxy.proxy.server import ConnectionHandler, ConnectionIO
from mitmproxy.test import taddons

import managed_openrouter as managed
import managed_request_body
import managed_request_transport
import mitm_addon
from tests.managed_openrouter_helpers import PATHS, PI_ATTRIBUTION_HEADERS, payload, sandbox
from tests.managed_request_transport_helpers import begin_upload, finish_hooks
from tests.request_handler_helpers import _write_registry
from tests.upstream_connection_helpers import mark_connected_tls_upstream


@pytest.fixture(params=[False, True])
async def task_factory(request):
    loop = asyncio.get_running_loop()
    previous = loop.get_task_factory()
    if request.param:
        loop.set_task_factory(asyncio.eager_task_factory)
    try:
        yield
    finally:
        loop.set_task_factory(previous)


@pytest.mark.parametrize("first_complete", [False, True])
@pytest.mark.parametrize("pre_reserved", [False, True])
async def test_shared_http2_capacity_preserves_progress_and_recovers(
    tmp_path, fake_firewall_headers, task_factory, first_complete, pre_reserved
):
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path))
    value = payload()
    value["messages"][0]["content"] = "x" * 12000
    first = json.dumps(value).encode()
    value["messages"][0]["content"] = "y" * 12000
    second = json.dumps(value).encode()
    assert len(first) == len(second)
    loop = asyncio.get_running_loop()
    first_written, first_blocked, second_receiving, ping_ack, finished, retry_finished = (
        asyncio.Event(),
        asyncio.Event(),
        asyncio.Event(),
        asyncio.Event(),
        asyncio.Event(),
        asyncio.Event(),
    )
    release_first = Event()
    first_receiving = asyncio.Event()
    file_ready = first_blocked if first_complete else first_written
    close_peers = asyncio.Event()
    guest_closed, provider_closed = asyncio.Event(), asyncio.Event()
    guest_writer_ready, provider_done, retry_done = (
        loop.create_future(),
        loop.create_future(),
        loop.create_future(),
    )
    peer = H2Connection(H2Configuration(client_side=True, header_encoding=None))
    statuses, responses, ended, flows, hooks, files = {}, {}, set(), [], [], []
    real_file = managed_request_body.tempfile.TemporaryFile
    first_wire_size: list[int] = []
    first_file_index = -1

    class ObservedFile:
        def __init__(self, file, index):
            self.file = file
            self.first = index == first_file_index
            self.tracked = self.first

        def write(self, data):
            if self.first and first_complete:
                self.first = False
                loop.call_soon_threadsafe(first_blocked.set)
                release_first.wait()
            written = self.file.write(data)
            if self.tracked:
                loop.call_soon_threadsafe(first_written.set)
            return written

        def read(self, size):
            return self.file.read(size)

        def seek(self, offset):
            return self.file.seek(offset)

    @contextmanager
    def temporary_file(*args, **kwargs):
        with real_file(*args, **kwargs) as file:
            files.append(file)
            yield ObservedFile(file, len(files) - 1)

    class GuestReader(asyncio.StreamReader):
        def __init__(self):
            super().__init__()
            self.first = True

        async def read(self, n=-1):
            if self.first:
                self.first = False
                assert 0 < first_wire_size[0] <= n
                return await super().readexactly(first_wire_size[0])
            return await super().read(n)

    def headers(stream_id, length):
        peer.send_headers(
            stream_id,
            [
                (b":method", b"POST"),
                (b":scheme", b"https"),
                (b":authority", b"openrouter.ai"),
                (b":path", PATHS["openai-completions"].encode()),
                (b"content-type", b"application/json"),
                (b"content-length", str(length).encode()),
                *((key.lower().encode(), val.encode()) for key, val in PI_ATTRIBUTION_HEADERS),
            ],
        )

    def data(stream_id, raw, *, end_stream=False):
        for offset in range(0, len(raw), 16000):
            peer.send_data(stream_id, raw[offset : offset + 16000])
        if end_stream:
            peer.end_stream(stream_id)

    async def guest(reader, writer):
        peer.initiate_connection()
        headers(1, len(first))
        if first_complete:
            data(1, first[:1000])
            data(1, first[1000:], end_stream=True)
        else:
            data(1, first[:1000])
        if first_complete or pre_reserved:
            headers(3, len(second))
            data(3, second[:1000])
            data(3, second[1000:], end_stream=True)
        initial = peer.data_to_send()
        first_wire_size.append(len(initial))
        writer.write(initial)
        await writer.drain()
        guest_writer_ready.set_result(writer)
        try:
            while raw := await reader.read(65535):
                for event in peer.receive_data(raw):
                    if isinstance(event, ResponseReceived):
                        statuses[event.stream_id] = int(dict(event.headers)[b":status"])
                    elif isinstance(event, DataReceived):
                        responses.setdefault(event.stream_id, bytearray()).extend(event.data)
                        peer.acknowledge_received_data(
                            event.flow_controlled_length, event.stream_id
                        )
                    elif isinstance(event, StreamEnded):
                        ended.add(event.stream_id)
                        if {1, 3} <= ended:
                            finished.set()
                        if 5 in ended:
                            retry_finished.set()
                    elif isinstance(event, PingAckReceived):
                        ping_ack.set()
                outgoing = peer.data_to_send()
                if outgoing:
                    writer.write(outgoing)
                    await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()
            guest_closed.set()

    async def provider(reader, writer):
        upstream = H2Connection(H2Configuration(client_side=False, header_encoding=None))
        upstream.initiate_connection()
        request_headers, request_bodies, provided = {}, {}, []
        try:
            while raw := await reader.read(65535):
                for event in upstream.receive_data(raw):
                    if isinstance(event, RequestReceived):
                        request_headers[event.stream_id] = dict(event.headers)
                    elif isinstance(event, DataReceived):
                        request_bodies.setdefault(event.stream_id, bytearray()).extend(event.data)
                        upstream.acknowledge_received_data(
                            event.flow_controlled_length, event.stream_id
                        )
                    elif isinstance(event, StreamEnded):
                        result = (
                            request_headers[event.stream_id],
                            bytes(request_bodies[event.stream_id]),
                        )
                        provided.append(result)
                        (provider_done if len(provided) == 1 else retry_done).set_result(result)
                        upstream.send_headers(
                            event.stream_id, [(b":status", b"200"), (b"content-length", b"2")]
                        )
                        upstream.send_data(event.stream_id, b"{}", end_stream=True)
                writer.write(upstream.data_to_send())
                await writer.drain()
                if len(provided) == 2:
                    await close_peers.wait()
                    return
        except Exception as error:
            for future in (provider_done, retry_done):
                if not future.done():
                    future.set_exception(error)
        finally:
            writer.close()
            await writer.wait_closed()
            provider_closed.set()

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        patch.object(managed_request_body.tempfile, "TemporaryFile", temporary_file),
        patch.object(
            managed_request_body.shutil,
            "disk_usage",
            return_value=SimpleNamespace(free=2 * len(first)),
        ),
        taddons.context(Proxyserver(), mitm_addon) as context,
        fake_firewall_headers(headers={"Authorization": "Bearer shared-capacity"}) as auth,
    ):
        context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry)
        )
        holder_flow = None
        if pre_reserved:
            # A different native ingress initially owns all capacity. Both
            # shared-connection requests therefore meet the admission queue.
            holder, holder_flow = await begin_upload(context, len(first))
            await finish_hooks(context, holder, holder.handle_event(RequestData(1, first)))
        first_file_index = len(files)
        client = connection.Client(
            peername=("10.200.0.5", 12345),
            sockname=("127.0.0.1", 8080),
            state=connection.ConnectionState.OPEN,
            tls=True,
            alpn=b"h2",
            sni="openrouter.ai",
        )
        native_context = Context(client, context.options)
        native_context.server.address = ("openrouter.ai", 443)
        native_context.server.tls = True
        native = HttpLayer(native_context, HTTPMode.transparent)

        class Handler(ProxyConnectionHandler):
            def __init__(self):
                ConnectionHandler.__init__(self, native_context)
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
                elif (
                    isinstance(hook, managed_request_transport.ManagedRequestBodyHook)
                    and hook.stage == "receive"
                ):
                    if hook.flow is flows[0]:
                        first_receiving.set()
                    elif len(flows) == 2 and hook.flow is flows[1]:
                        second_receiving.set()
                await super().handle_hook(hook)

            async def hook_task(self, hook):
                hooks.append(asyncio.current_task())
                await super().hook_task(hook)

            async def open_connection(self, command):
                raise AssertionError("the fixture's verified H2 upstream should be reused")

        handler = Handler()
        handler.layer = native
        async with (
            await asyncio.start_server(guest, "127.0.0.1", 0) as guest_server,
            await asyncio.start_server(provider, "127.0.0.1", 0) as provider_server,
        ):
            gr = GuestReader()
            protocol = asyncio.StreamReaderProtocol(gr)
            transport, _ = await loop.create_connection(
                lambda: protocol, "127.0.0.1", guest_server.sockets[0].getsockname()[1]
            )
            gw = asyncio.StreamWriter(transport, protocol, gr, loop)
            pr, pw = await asyncio.open_connection(
                "127.0.0.1", provider_server.sockets[0].getsockname()[1]
            )
            server = native_context.server
            handler.transports[client] = ConnectionIO(reader=gr, writer=gw)
            handler.transports[server] = ConnectionIO(reader=pr, writer=pw)
            await handler.server_event(events.Start())
            readers = [
                asyncio.create_task(handler.handle_connection(conn)) for conn in (client, server)
            ]
            for conn, task in zip((client, server), readers, strict=True):
                handler.transports[conn].handler = task
            try:
                source = await guest_writer_ready
                await asyncio.wait_for(
                    (first_receiving if pre_reserved else file_ready).wait(),
                    5,
                )
                if pre_reserved:
                    ready = loop.create_future()
                    loop.call_soon(ready.set_result, None)
                    await ready
                    queued_first = managed_request_body.get(flows[0])
                    assert queued_first is not None
                    assert queued_first.waiter is not None
                    assert not queued_first.waiter.done()
                if not first_complete and not pre_reserved:
                    headers(3, len(second))
                    data(3, second[:1000])
                    data(3, second[1000:], end_stream=True)
                    source.write(peer.data_to_send())
                    await source.drain()
                await asyncio.wait_for(second_receiving.wait(), 5)
                pulse = loop.create_future()
                loop.call_soon(pulse.set_result, None)
                await pulse
                assert flows[0].client_conn is flows[1].client_conn
                if holder_flow is not None:
                    holder_flow.error = Error("other upload disconnected")
                    mitm_addon.error(holder_flow)
                    await asyncio.wait_for(file_ready.wait(), 5)
                if first_complete:
                    # Its complete input, including EOF, is already in native
                    # state. Slow file work can free space without this reader.
                    queued = managed_request_body.get(flows[1])
                    assert queued is not None
                    assert queued.waiter is not None
                    assert not queued.waiter.done()
                    release_first.set()
                else:
                    # Complete the one already-pending read with a control
                    # frame before sending the bytes that free the reservation.
                    peer.ping(b"progress")
                    source.write(peer.data_to_send())
                    await source.drain()
                    await asyncio.wait_for(ping_ack.wait(), 5)
                    data(1, first[1000:], end_stream=True)
                    source.write(peer.data_to_send())
                    await source.drain()
                head, forwarded = await asyncio.wait_for(asyncio.shield(provider_done), 5)
                assert forwarded == first
                assert head[b"authorization"] == b"Bearer shared-capacity"
                await asyncio.wait_for(finished.wait(), 5)
                assert statuses == {1: 200, 3: 200 if first_complete else 503}
                assert responses[1] == b"{}"
                if not first_complete:
                    auth.assert_awaited_once()
                    assert b"body_storage_busy" in responses[3]
                    assert b"yyyyyyyy" not in responses[3]
                    headers(5, len(second))
                    data(5, second, end_stream=True)
                    source.write(peer.data_to_send())
                    await source.drain()
                head, forwarded = await asyncio.wait_for(asyncio.shield(retry_done), 5)
                assert forwarded == second
                assert head[b"authorization"] == b"Bearer shared-capacity"
                if not first_complete:
                    await asyncio.wait_for(retry_finished.wait(), 5)
                    assert statuses[5] == 200
                    assert responses[5] == b"{}"
                assert auth.await_count == 2
                assert managed.admission_state_for_tests() == (0, 0)
                assert all(file.closed for file in files)
            finally:
                release_first.set()
                close_peers.set()
                for task in [*readers, *hooks]:
                    if task is not None:
                        task.cancel()
                await asyncio.gather(
                    *[task for task in [*readers, *hooks] if task is not None],
                    return_exceptions=True,
                )
                for flow in flows:
                    mitm_addon.error(flow)
                if holder_flow is not None:
                    mitm_addon.error(holder_flow)
                for writer in (gw, pw):
                    writer.close()
                    await writer.wait_closed()
                await asyncio.wait_for(guest_closed.wait(), 5)
                await asyncio.wait_for(provider_closed.wait(), 5)
                for future in (provider_done, retry_done):
                    if future.done() and not future.cancelled():
                        future.exception()
