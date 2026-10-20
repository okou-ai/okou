"""Early native HTTP/1 errors abort upload without losing the provider response."""

from unittest.mock import patch

import pytest
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.proxy import commands, events
from mitmproxy.proxy.layers.http import (
    GetHttpConnection,
    GetHttpConnectionCompleted,
    SendHttp,
)
from mitmproxy.proxy.layers.http._base import ReceiveHttp
from mitmproxy.proxy.layers.http._events import RequestData, RequestEndOfMessage, ResponseData
from mitmproxy.proxy.layers.http._http1 import Http1Client
from mitmproxy.test import taddons

import managed_openrouter as managed
import mitm_addon
from tests.managed_openrouter_helpers import PRESET, sandbox
from tests.managed_request_transport_helpers import begin_upload, finish_hooks
from tests.request_handler_helpers import _write_registry


@pytest.mark.parametrize("case", ["early-error", "disconnect", "early-data"])
async def test_upstream_early_response_or_disconnect_releases_spooled_upload(
    tmp_path,
    fake_firewall_headers,
    case,
):
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path))
    body = (
        b'{"model":"' + PRESET.encode() + b'","messages":[{"content":"' + b"x" * 200_000 + b'"}]}'
    )
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as context,
        fake_firewall_headers(),
    ):
        context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry)
        )
        stream, flow = await begin_upload(context, len(body))
        for offset in range(0, len(body), 65535):
            await finish_hooks(
                context, stream, stream.handle_event(RequestData(1, body[offset : offset + 65535]))
            )
        pending = await finish_hooks(context, stream, stream.handle_event(RequestEndOfMessage(1)))
        acquire = next(command for command in pending if isinstance(command, GetHttpConnection))
        upstream = Http1Client(stream.context.fork())
        list(upstream.handle_event(events.Start()))
        queue = list(
            stream.handle_event(GetHttpConnectionCompleted(acquire, (flow.server_conn, None)))
        )
        bytes_sent, injected, closed = 0, False, False
        response_body = bytearray()

        def receive_response(event):
            for command in upstream.handle_event(event):
                if isinstance(command, ReceiveHttp):
                    assert not list(stream.handle_event(command.event))

        while queue:
            command = queue.pop(0)
            if isinstance(command, commands.StartHook):
                await context.master.addons.invoke_addon(mitm_addon, command)
                queue.extend(stream.handle_event(events.HookCompleted(command, None)))
            elif isinstance(command, SendHttp) and isinstance(command.event, ResponseData):
                response_body.extend(command.event.data)
            elif isinstance(command, SendHttp) and command.connection == flow.server_conn:
                for outbound in upstream.handle_event(command.event):
                    if isinstance(outbound, commands.CloseConnection):
                        closed = True
                if isinstance(command.event, RequestData):
                    bytes_sent += len(command.event.data)
                    if not injected:
                        injected = True
                        if case == "early-error":
                            response = (
                                b"HTTP/1.1 429 Too Many Requests\r\nContent-Length: 3\r\n\r\nerr"
                            )
                            receive_response(events.DataReceived(flow.server_conn, response))
                        elif case == "early-data":
                            response = (
                                b"HTTP/1.1 200 OK\r\nContent-Length: 100000\r\n\r\n" + b"e" * 65537
                            )
                            receive_response(events.DataReceived(flow.server_conn, response))
                        else:
                            receive_response(events.ConnectionClosed(flow.server_conn))
        assert bytes_sent == 64 * 1024
        assert managed.admission_state_for_tests() == (0, 0)
        if case == "early-error":
            assert closed
            assert flow.error is None
            assert flow.response is not None
            assert flow.response.status_code == 429
            assert response_body == b"err"
        else:
            assert flow.error is not None
