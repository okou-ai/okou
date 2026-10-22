"""An incomplete socket upload receives its local error without a body-EOF wait."""

import asyncio
import json
import socket
from unittest.mock import AsyncMock, patch

import pytest
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.proxy.layers.http import HTTPMode
from mitmproxy.proxy.layers.http._hooks import HttpRequestHeadersHook
from mitmproxy.proxy.mode_servers import ProxyConnectionHandler
from mitmproxy.proxy.server import ConnectionHandler, ConnectionIO
from mitmproxy.test import taddons

import auth
import firewall_auth_client
import managed_upload
import mitm_addon
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.managed_openrouter_helpers import PATHS, sandbox
from tests.mitmproxy_http_framing_helpers import start_http_layer
from tests.request_handler_helpers import _write_registry


@pytest.fixture(params=[False, True], ids=["ordinary", "eager"])
async def scheduling(request):
    loop = asyncio.get_running_loop()
    original = loop.get_task_factory()
    if request.param:
        loop.set_task_factory(asyncio.eager_task_factory)
    try:
        yield
    finally:
        loop.set_task_factory(original)


@pytest.mark.parametrize("dialect", ["openai-completions", "openai-responses"])
@pytest.mark.parametrize("upload", [False, True], ids=["withheld-body", "blocked-upload"])
async def test_credit_rejection_reaches_incomplete_socket_caller(
    tmp_path, scheduling, dialect, upload
):
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path, dialect))
    accepted = asyncio.Queue()
    entered, release = asyncio.Event(), asyncio.Event()
    flows, hooks = [], []

    async def accept(reader, writer):
        accepted.put_nowait((reader, writer))

    async def deny(*_args, **_kwargs):
        entered.set()
        await release.wait()
        raise firewall_auth_client.InsufficientCreditsError("synthetic no credits")

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as context,
        patch.object(auth, "get_firewall_headers", AsyncMock(side_effect=deny)),
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
                await super().handle_hook(hook)

            async def hook_task(self, hook):
                hooks.append(asyncio.current_task())
                await super().hook_task(hook)

        handler = Handler()
        handler.layer = native
        async with await asyncio.start_server(accept, "127.0.0.1", 0) as listener:
            port = listener.sockets[0].getsockname()[1]
            guest_in, guest_out = await asyncio.open_connection("127.0.0.1", port)
            reader, writer = await accepted.get()
            guest_out.get_extra_info("socket").setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 4096)
            guest_out.transport.set_write_buffer_limits(high=1024, low=512)
            handler.transports[client] = ConnectionIO(reader=reader, writer=writer)
            task = asyncio.create_task(handler.handle_connection(client))
            handler.transports[client].handler = task
            writing = None
            try:
                guest_out.write(
                    (
                        f"POST {PATHS[dialect]} HTTP/1.1\r\nHost: openrouter.ai\r\n"
                        "Content-Type: application/json\r\nContent-Length: 8000000\r\n\r\n"
                    ).encode()
                )
                await guest_out.drain()
                await asyncio.wait_for(entered.wait(), 5)
                if upload:
                    guest_out.write(b"private-upload" * 100_000)
                    assert guest_out.transport.get_write_buffer_size() > 0
                    writing = asyncio.create_task(guest_out.drain())
                release.set()
                head = await asyncio.wait_for(guest_in.readuntil(b"\r\n\r\n"), 5)
                assert head.startswith(b"HTTP/1.1 402")
                headers = {
                    key.lower(): value.strip()
                    for line in head.split(b"\r\n")[1:-2]
                    for key, value in [line.split(b":", 1)]
                }
                assert headers[b"connection"] == b"close"
                body = await asyncio.wait_for(
                    guest_in.readexactly(int(headers[b"content-length"])), 5
                )
                assert json.loads(body)["error"] == "insufficient_credits"
                # The caller has received the final error and cancels its upload.
                # A full proxy-side close before this point races Node fetch writes.
                guest_out.transport.abort()
                results = await asyncio.wait_for(
                    asyncio.gather(
                        task,
                        *[hook for hook in hooks if hook is not None],
                        return_exceptions=True,
                    ),
                    5,
                )
                assert all(
                    result is None or isinstance(result, asyncio.CancelledError)
                    for result in results
                )
                [flow] = flows
                assert not flow.live
                assert flow.error is None
                assert flow.request.raw_content is None
                assert managed_upload.get(flow) is None
                assert not native.streams
            finally:
                release.set()
                guest_out.transport.abort()
                writer.transport.abort()
                owned = [task, *[hook for hook in hooks if hook is not None]]
                if writing is not None:
                    owned.append(writing)
                for owned_task in owned:
                    owned_task.cancel()
                await asyncio.gather(*owned, return_exceptions=True)
                await asyncio.gather(
                    guest_out.wait_closed(), writer.wait_closed(), return_exceptions=True
                )
        [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
        assert entry["status"] == 402
        assert entry["request_size"] == 0
