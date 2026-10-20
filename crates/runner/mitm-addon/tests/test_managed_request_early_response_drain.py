"""A complete early response must not wait for a blocked upstream TCP writer."""

import asyncio
import socket
from unittest.mock import patch

import pytest
from h2.config import H2Configuration
from h2.connection import H2Connection
from h2.events import RequestReceived
from h2.settings import SettingCodes
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.proxy.layers.http import HTTPMode
from mitmproxy.proxy.layers.http._hooks import HttpRequestHeadersHook
from mitmproxy.proxy.mode_servers import ProxyConnectionHandler
from mitmproxy.proxy.server import ConnectionHandler, ConnectionIO
from mitmproxy.test import taddons

import managed_openrouter as managed
import mitm_addon
from tests.managed_openrouter_helpers import PATHS, PRESET, sandbox
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
@pytest.mark.parametrize("http2", [False, True])
@pytest.mark.parametrize("status", [200, 429])
async def test_early_response_completes_while_upstream_writer_is_backpressured(
    tmp_path, fake_firewall_headers, task_factory, dialect, http2, status
):
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path, dialect))
    key = b"messages" if dialect == "openai-completions" else b"input"
    body = (
        b'{"model":"'
        + PRESET.encode()
        + b'","'
        + key
        + b'":[{"content":"'
        + b"x" * (2 * 1024 * 1024)
        + b'"}]}'
    )
    wire = (
        b"POST "
        + PATHS[dialect].encode()
        + b" HTTP/1.1\r\nHost: openrouter.ai\r\nContent-Type: application/json\r\nContent-Length: "
        + str(len(body)).encode()
        + b"\r\n\r\n"
        + body
    )
    loop = asyncio.get_running_loop()
    backpressured, close_peers = asyncio.Event(), asyncio.Event()
    guest_done, provider_done = loop.create_future(), loop.create_future()
    peer_writers, peer_tasks, flows, hooks = [], [], [], []

    async def guest(reader, writer):
        peer_tasks.append(asyncio.current_task())
        peer_writers.append(writer)
        try:
            writer.write(wire)
            await writer.drain()
            head = await reader.readuntil(b"\r\n\r\n")
            content = await reader.readexactly(3)
            guest_done.set_result((head, content))
            await close_peers.wait()
        except Exception as error:
            guest_done.set_exception(error)
        finally:
            writer.close()

    async def provider(reader, writer):
        peer_tasks.append(asyncio.current_task())
        peer_writers.append(writer)
        try:
            peer = H2Connection(H2Configuration(client_side=False, header_encoding=None))
            if http2:
                peer.initiate_connection()
                peer.update_settings({SettingCodes.INITIAL_WINDOW_SIZE: 4 * 1024 * 1024})
                peer.increment_flow_control_window(4 * 1024 * 1024)
                head = None
                while head is None:
                    raw = await reader.read(65535)
                    assert raw, "provider closed before request headers"
                    for event in peer.receive_data(raw):
                        if isinstance(event, RequestReceived):
                            head = b"\n".join(name + b": " + value for name, value in event.headers)
                    writer.write(peer.data_to_send())
                    await writer.drain()
            else:
                head = await reader.readuntil(b"\r\n\r\n")
            writer.transport.pause_reading()
            await backpressured.wait()
            if http2:
                peer.send_headers(
                    1, [(b":status", str(status).encode()), (b"content-length", b"3")]
                )
                peer.send_data(1, b"err", end_stream=True)
                writer.write(peer.data_to_send())
            else:
                writer.write(f"HTTP/1.1 {status} Final\r\nContent-Length: 3\r\n\r\nerr".encode())
            await writer.drain()
            provider_done.set_result(head)
            await close_peers.wait()
        except Exception as error:
            provider_done.set_exception(error)
        finally:
            writer.transport.resume_reading()
            writer.close()

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as context,
        fake_firewall_headers(headers={"Authorization": "Bearer early-response"}) as auth_fetch,
    ):
        context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry)
        )
        _, native = start_http_layer(
            context, alpn=b"http/1.1", host="openrouter.ai", mode=HTTPMode.transparent
        )

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

            async def hook_task(self, hook):
                hooks.append(asyncio.current_task())
                await super().hook_task(hook)

        handler = Handler()
        handler.layer = native
        async with (
            await asyncio.start_server(guest, "127.0.0.1", 0) as guest_server,
            await asyncio.start_server(provider, "127.0.0.1", 0, limit=1024) as provider_server,
        ):
            provider_server.sockets[0].setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
            guest_reader, guest_writer = await asyncio.open_connection(
                "127.0.0.1", guest_server.sockets[0].getsockname()[1]
            )
            provider_reader, provider_writer = await asyncio.open_connection(
                "127.0.0.1", provider_server.sockets[0].getsockname()[1]
            )
            provider_writer.get_extra_info("socket").setsockopt(
                socket.SOL_SOCKET, socket.SO_SNDBUF, 4096
            )
            provider_writer.transport.set_write_buffer_limits(high=1024, low=512)
            original_drain = provider_writer.drain

            async def observe_drain():
                if provider_writer.transport.get_write_buffer_size() > 1024:
                    backpressured.set()
                await original_drain()

            client, server = native.context.client, native.context.server
            handler.transports[client] = ConnectionIO(reader=guest_reader, writer=guest_writer)
            handler.transports[server] = ConnectionIO(
                reader=provider_reader, writer=provider_writer
            )
            with patch.object(provider_writer, "drain", observe_drain):
                readers = [
                    asyncio.create_task(handler.handle_connection(client)),
                    asyncio.create_task(handler.handle_connection(server)),
                ]
                for connection, task in zip((client, server), readers, strict=True):
                    handler.transports[connection].handler = task
                try:
                    head = await asyncio.wait_for(asyncio.shield(provider_done), 5)
                    assert b"authorization: bearer early-response" in head.lower()
                    head, content = await asyncio.wait_for(asyncio.shield(guest_done), 5)
                    assert head.startswith(f"HTTP/1.1 {status}".encode())
                    assert content == b"err"
                    assert backpressured.is_set()
                    assert not close_peers.is_set()
                    auth_fetch.assert_awaited_once()
                    assert len(flows) == 1
                    assert flows[0].error is None
                    assert managed.admission_state_for_tests() == (0, 0)
                finally:
                    close_peers.set()
                    for writer in peer_writers:
                        writer.transport.resume_reading()
                        writer.transport.abort()
                    for task in [*readers, *hooks, *peer_tasks]:
                        if task is not None:
                            task.cancel()
                    await asyncio.gather(
                        *[task for task in [*readers, *hooks, *peer_tasks] if task is not None],
                        return_exceptions=True,
                    )
                    for writer in (guest_writer, provider_writer):
                        writer.transport.abort()
                    await asyncio.gather(
                        guest_writer.wait_closed(),
                        provider_writer.wait_closed(),
                        return_exceptions=True,
                    )
                    for flow in flows:
                        mitm_addon.error(flow)
                    for done in (guest_done, provider_done):
                        if not done.done():
                            done.cancel()
                        if done.done() and not done.cancelled():
                            done.exception()
