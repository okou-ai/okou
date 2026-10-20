"""Native reader timeout/cancellation releases rejected uploads without EOF."""

import asyncio
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
from tests.managed_openrouter_helpers import PATHS, PRESET, sandbox
from tests.mitmproxy_http_framing_helpers import start_http_layer
from tests.request_handler_helpers import _write_registry
from tests.upstream_connection_helpers import mark_connected_tls_upstream


@pytest.mark.parametrize("ending", ["timeout", "cancel"])
async def test_native_reader_cleans_rejected_upload_that_never_reaches_eof(
    tmp_path, fake_firewall_headers, ending
):
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path))
    prefix = b'{"model":"' + PRESET.encode() + b'",'
    rejected = b'"provider":{},"metadata":{"private":"not-forwarded"}'
    peers, hooks, flows = asyncio.Queue(), [], []
    discarding = asyncio.Event()

    async def accepted(reader, writer):
        peers.put_nowait((reader, writer))

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as context,
        fake_firewall_headers(headers={"Authorization": "Bearer deferred-timeout"}),
    ):
        context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry)
        )
        client, native = start_http_layer(
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
                    hook.flow.server_conn.alpn = b"http/1.1"
                await super().handle_hook(hook)

            async def hook_task(self, hook):
                hooks.append(asyncio.current_task())
                await super().hook_task(hook)

            async def drain_writers(self):
                await super().drain_writers()
                if flows:
                    stored = managed_request_body.get(flows[0])
                    if stored is not None and stored.failure is not None:
                        discarding.set()

        handler = Handler()
        handler.layer = native
        async with await asyncio.start_server(accepted, "127.0.0.1", 0) as listener:
            port = listener.sockets[0].getsockname()[1]
            guest_reader, guest_writer = await asyncio.open_connection("127.0.0.1", port)
            guest_peer_reader, guest_peer_writer = await peers.get()
            provider_reader, provider_writer = await asyncio.open_connection("127.0.0.1", port)
            provider_peer_reader, provider_peer_writer = await peers.get()
            server = native.context.server
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
            tail = None
            try:
                guest_peer_writer.write(
                    b"POST "
                    + PATHS["openai-completions"].encode()
                    + b" HTTP/1.1\r\nHost: openrouter.ai\r\nContent-Type: application/json\r\n"
                    + b"Content-Length: "
                    + str(len(prefix) + len(rejected) + 1).encode()
                    + b"\r\n\r\n"
                    + prefix
                )
                await guest_peer_writer.drain()
                head = await asyncio.wait_for(provider_peer_reader.readuntil(b"\r\n\r\n"), 5)
                assert b"authorization: bearer deferred-timeout" in head.lower()
                assert (
                    await asyncio.wait_for(provider_peer_reader.readexactly(len(prefix)), 5)
                    == prefix
                )
                guest_peer_writer.write(rejected)
                await guest_peer_writer.drain()
                await asyncio.wait_for(discarding.wait(), 5)
                [flow] = flows
                stored = managed_request_body.get(flow)
                assert stored is not None
                assert stored.failure is not None
                assert stored.validator is None
                assert stored.tail == b""
                assert flow.error is None
                assert flow.live
                tail = asyncio.create_task(provider_peer_reader.read())
                if ending == "timeout":
                    # Exercise the real watchdog callback, not an artificial sleep.
                    await handler.on_timeout()
                else:
                    readers[0].cancel("cancel rejected upload")
                await asyncio.wait_for(asyncio.gather(*readers, return_exceptions=True), 5)
                await asyncio.gather(
                    *[task for task in hooks if task is not None], return_exceptions=True
                )
                assert await asyncio.wait_for(tail, 5) == b""
                assert flow.error is not None
                assert not flow.live
                assert stored.closed
                assert managed.admission_state_for_tests() == (0, 0)
                assert not handler.transports
                assert not native.streams
                assert await asyncio.wait_for(guest_peer_reader.read(), 5) == b""
            finally:
                for task in [*readers, *hooks, tail]:
                    if task is not None:
                        task.cancel()
                await asyncio.gather(
                    *[task for task in [*readers, *hooks, tail] if task is not None],
                    return_exceptions=True,
                )
                for writer in (
                    guest_writer,
                    guest_peer_writer,
                    provider_writer,
                    provider_peer_writer,
                ):
                    writer.close()
                await asyncio.gather(
                    guest_writer.wait_closed(),
                    guest_peer_writer.wait_closed(),
                    provider_writer.wait_closed(),
                    provider_peer_writer.wait_closed(),
                    return_exceptions=True,
                )
                for flow in flows:
                    mitm_addon.error(flow)
