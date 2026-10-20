"""Native H1 early final responses and resets release public upload state."""

from unittest.mock import patch

import pytest
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.proxy import commands, events
from mitmproxy.proxy.layers.http import SendHttp
from mitmproxy.proxy.layers.http._base import ReceiveHttp
from mitmproxy.proxy.layers.http._events import RequestData, RequestHeaders, ResponseData
from mitmproxy.proxy.layers.http._http1 import Http1Client
from mitmproxy.test import taddons

import managed_openrouter as managed
import mitm_addon
from tests.managed_openrouter_helpers import PRESET, sandbox
from tests.managed_request_transport_helpers import begin_upload
from tests.request_handler_helpers import _write_registry


@pytest.mark.parametrize("status", [200, 302, 429, None])
async def test_native_h1_early_final_or_disconnect_cancels_unfinished_upload(
    tmp_path,
    fake_firewall_headers,
    status,
):
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path))
    prefix = b'{"model":"' + PRESET.encode() + b'","messages":[{"content":"' + b"x" * 20_000
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as context,
        fake_firewall_headers(),
    ):
        context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry)
        )
        stream, flow = await begin_upload(context, len(prefix) + 100_000)
        upstream = Http1Client(stream.context.fork())
        closed = []
        response_body = bytearray()

        async def relay(pending):
            queue = list(pending)
            while queue:
                command = queue.pop(0)
                if isinstance(command, commands.StartHook):
                    await context.master.addons.invoke_addon(mitm_addon, command)
                    queue.extend(stream.handle_event(events.HookCompleted(command, None)))
                elif isinstance(command, ReceiveHttp):
                    queue.extend(stream.handle_event(command.event))
                elif isinstance(command, SendHttp) and command.connection == flow.server_conn:
                    queue.extend(upstream.handle_event(command.event))
                elif isinstance(command, SendHttp) and isinstance(command.event, ResponseData):
                    response_body.extend(command.event.data)
                elif isinstance(command, commands.CloseConnection):
                    closed.append(command.connection)

        await relay(upstream.handle_event(events.Start()))
        await relay(upstream.handle_event(RequestHeaders(1, flow.request, False)))
        await relay(stream.handle_event(RequestData(1, prefix)))
        assert managed.admission_state_for_tests()[0] == 1
        incoming = (
            events.ConnectionClosed(flow.server_conn)
            if status is None
            else events.DataReceived(
                flow.server_conn,
                f"HTTP/1.1 {status} Final\r\nContent-Length: 3\r\n\r\nerr".encode(),
            )
        )
        await relay(upstream.handle_event(incoming))
        assert managed.admission_state_for_tests() == (0, 0)
        if status is None:
            assert flow.error is not None
        else:
            assert flow.error is None
            assert flow.response is not None
            assert flow.response.status_code == status
            assert response_body == b"err"
            assert flow.server_conn in closed
