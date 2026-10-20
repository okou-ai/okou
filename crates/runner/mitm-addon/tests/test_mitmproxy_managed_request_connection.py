"""Native framing and asynchronous connection dispatch share one upload owner."""

import asyncio
import json
from contextlib import contextmanager
from threading import Event
from unittest.mock import patch

import pytest
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.proxy.layers.http import HTTPMode
from mitmproxy.proxy.layers.http._hooks import HttpRequestHeadersHook
from mitmproxy.proxy.mode_servers import ProxyConnectionHandler
from mitmproxy.proxy.server import ConnectionHandler, ConnectionIO
from mitmproxy.test import taddons

import managed_openrouter as managed
import managed_request_body
import mitm_addon
from tests.managed_openrouter_helpers import PATHS, PI_ATTRIBUTION_HEADERS, payload, sandbox
from tests.mitmproxy_http_framing_helpers import start_http_layer
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


@pytest.mark.parametrize("dialect", ["openai-completions", "openai-responses"])
@pytest.mark.parametrize("blocked_first_write", [False, True])
async def test_native_framing_and_hook_tasks_complete_a_managed_request(
    tmp_path,
    fake_firewall_headers,
    dialect,
    task_factory,
    blocked_first_write,
):
    info = sandbox(tmp_path, dialect)
    registry = _write_registry(tmp_path, sandbox_info=info)
    value = payload(dialect)
    value["messages" if dialect == "openai-completions" else "input"][0]["content"] = "x" * 180000
    body = json.dumps(value).encode()
    wire = (
        b"POST "
        + PATHS[dialect].encode()
        + b" HTTP/1.1\r\nHost: openrouter.ai\r\nContent-Type: application/json\r\nContent-Length: "
        + str(len(body)).encode()
        + b"\r\n"
        + b"".join(f"{key}: {value}\r\n".encode() for key, value in PI_ATTRIBUTION_HEADERS)
        + b"\r\n"
        + body
    )
    loop = asyncio.get_running_loop()
    first_packet_size = 20000 if blocked_first_write else len(wire)
    first_write_started, send_rest, second_read = asyncio.Event(), asyncio.Event(), asyncio.Event()
    release_write = Event()
    read_calls = []
    guest_done, provider_done = loop.create_future(), loop.create_future()
    close_peers = asyncio.Event()
    hooks, flows = [], []
    response = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}"

    class GuestReader(asyncio.StreamReader):
        async def read(self, n=-1):
            index = len(read_calls)
            read_calls.append(n)
            data = (
                await super().readexactly(first_packet_size)
                if blocked_first_write and index == 0
                else await super().read(n)
            )
            if index == 1:
                second_read.set()
            return data

    real_file = managed_request_body.tempfile.TemporaryFile

    class GatedFile:
        def __init__(self, file):
            self.file = file
            self.first_write = True

        def write(self, data):
            if blocked_first_write and self.first_write:
                self.first_write = False
                loop.call_soon_threadsafe(first_write_started.set)
                release_write.wait()
            return self.file.write(data)

        def read(self, size):
            return self.file.read(size)

        def seek(self, offset):
            return self.file.seek(offset)

    @contextmanager
    def temporary_file(*args, **kwargs):
        with real_file(*args, **kwargs) as file:
            yield GatedFile(file)

    async def guest(reader, writer):
        try:
            writer.write(wire[:first_packet_size])
            await writer.drain()
            if blocked_first_write:
                await send_rest.wait()
                writer.write(wire[first_packet_size:])
                await writer.drain()
            head = await reader.readuntil(b"\r\n\r\n")
            content = await reader.readexactly(2)
            guest_done.set_result((head, content))
            await close_peers.wait()
        except Exception as error:
            guest_done.set_exception(error)
        finally:
            writer.close()
            await writer.wait_closed()

    async def provider(reader, writer):
        try:
            head = await reader.readuntil(b"\r\n\r\n")
            content = await reader.readexactly(len(body))
            provider_done.set_result((head, content))
            writer.write(response)
            await writer.drain()
            await close_peers.wait()
        except Exception as error:
            provider_done.set_exception(error)
        finally:
            writer.close()
            await writer.wait_closed()

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        patch.object(managed_request_body.tempfile, "TemporaryFile", temporary_file),
        taddons.context(Proxyserver(), mitm_addon) as context,
        fake_firewall_headers(headers={"Authorization": "Bearer native-connection"}) as auth_fetch,
    ):
        context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry)
        )
        _, native = start_http_layer(
            context, alpn=b"http/1.1", host="openrouter.ai", mode=HTTPMode.transparent
        )

        class Handler(ProxyConnectionHandler):
            def __init__(self):
                # Keep the fixture's prepared native HTTP context and sockets,
                # while exercising the concrete production hook dispatcher.
                ConnectionHandler.__init__(self, native.context)
                self.master = context.master

            async def handle_hook(self, hook):
                if isinstance(hook, HttpRequestHeadersHook):
                    flow = hook.flow
                    flows.append(flow)
                    mark_connected_tls_upstream(
                        flow,
                        sni="openrouter.ai",
                        server_address=("openrouter.ai", 443),
                        peername=("104.18.32.47", 443),
                    )
                    flow.server_conn.alpn = b"http/1.1"
                await super().handle_hook(hook)

            async def hook_task(self, hook):
                hooks.append(asyncio.current_task())
                await super().hook_task(hook)

        handler = Handler()
        handler.layer = native
        async with (
            await asyncio.start_server(guest, "127.0.0.1", 0) as guest_server,
            await asyncio.start_server(provider, "127.0.0.1", 0) as provider_server,
        ):
            guest_reader = GuestReader()
            guest_protocol = asyncio.StreamReaderProtocol(guest_reader)
            guest_transport, _ = await loop.create_connection(
                lambda: guest_protocol, "127.0.0.1", guest_server.sockets[0].getsockname()[1]
            )
            guest_writer = asyncio.StreamWriter(guest_transport, guest_protocol, guest_reader, loop)
            provider_reader, provider_writer = await asyncio.open_connection(
                "127.0.0.1", provider_server.sockets[0].getsockname()[1]
            )
            client, server = native.context.client, native.context.server
            handler.transports[client] = ConnectionIO(reader=guest_reader, writer=guest_writer)
            handler.transports[server] = ConnectionIO(
                reader=provider_reader, writer=provider_writer
            )
            readers = [
                asyncio.create_task(handler.handle_connection(client)),
                asyncio.create_task(handler.handle_connection(server)),
            ]
            for connection, task in zip((client, server), readers, strict=True):
                handler.transports[connection].handler = task
            try:
                if blocked_first_write:
                    await asyncio.wait_for(first_write_started.wait(), 5)
                    auth_fetch.assert_not_called()
                    send_rest.set()
                    await asyncio.wait_for(second_read.wait(), 5)
                    pulse = loop.create_future()
                    loop.call_soon(pulse.set_result, None)
                    await pulse
                    # One read may already be pending when headers finish.
                    # Its return must join the first managed receive instead
                    # of continuing to queue the rest of the request in RAM.
                    assert read_calls == [65535, 65535]
                    release_write.set()
                head, forwarded = await asyncio.wait_for(asyncio.shield(provider_done), 5)
                assert forwarded == body
                assert b"authorization: bearer native-connection" in head.lower()
                head, content = await asyncio.wait_for(asyncio.shield(guest_done), 5)
                assert head.startswith(b"HTTP/1.1 200")
                assert content == b"{}"
                auth_fetch.assert_awaited_once()
                assert len(flows) == 1
                assert flows[0].error is None
                assert managed.admission_state_for_tests() == (0, 0)
            finally:
                release_write.set()
                send_rest.set()
                close_peers.set()
                for task in [*readers, *hooks]:
                    if task is not None:
                        task.cancel()
                await asyncio.gather(
                    *[task for task in [*readers, *hooks] if task is not None],
                    return_exceptions=True,
                )
                for writer in (guest_writer, provider_writer):
                    writer.close()
                    await writer.wait_closed()
                for flow in flows:
                    mitm_addon.error(flow)
                for done in (guest_done, provider_done):
                    if done.done() and not done.cancelled():
                        done.exception()
