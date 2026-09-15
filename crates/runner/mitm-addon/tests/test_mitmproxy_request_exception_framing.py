"""Request exception framing through mitmproxy's real hook pipeline."""

from pathlib import Path
from unittest.mock import patch

from h2 import events as h2_events
from h2.config import H2Configuration
from h2.connection import H2Connection
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.proxy import commands, events
from mitmproxy.proxy.layers.http import SendHttp
from mitmproxy.proxy.layers.http._events import RequestHeaders
from mitmproxy.proxy.layers.http._hooks import (
    HttpRequestHeadersHook,
    HttpRequestHook,
    HttpResponseHeadersHook,
    HttpResponseHook,
)
from mitmproxy.test import taddons

import codex_model_catalog_cache
import mitm_addon
from tests.mitmproxy_http_framing_helpers import start_http_layer
from tests.request_handler_helpers import _write_github_firewall_registry


async def test_post_auth_request_exception_fails_closed_after_dispatch(
    tmp_path: Path,
    caplog,
    fake_firewall_headers,
) -> None:
    registry_path = _write_github_firewall_registry(tmp_path)
    resolved_token = "Bearer resolved-token"

    async def fail_catalog_preparation(*_args, **_kwargs) -> bool:
        raise RuntimeError("post-auth request failure")

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
        fake_firewall_headers(headers={"Authorization": resolved_token}),
    ):
        addon_context.options.update(
            okou_api_url="https://api.okou.ai",
            okou_proxy_registry_path=str(registry_path),
        )
        client, http_layer = start_http_layer(
            addon_context,
            alpn=b"h2",
            host="api.github.com",
        )
        http2 = H2Connection(H2Configuration(client_side=True, header_encoding=None))
        http2.initiate_connection()
        http2.send_headers(
            1,
            [
                (b":method", b"GET"),
                (b":scheme", b"https"),
                (b":authority", b"api.github.com"),
                (b":path", b"/repos/vm0-ai/vm0"),
            ],
            end_stream=True,
        )
        all_commands = list(
            http_layer.handle_event(events.DataReceived(client, http2.data_to_send()))
        )
        request_headers_hook = next(
            command for command in all_commands if isinstance(command, HttpRequestHeadersHook)
        )
        await addon_context.master.addons.invoke_addon(
            mitm_addon,
            request_headers_hook,
        )
        after_request_headers = list(
            http_layer.handle_event(events.HookCompleted(request_headers_hook, None))
        )
        all_commands.extend(after_request_headers)

        request_hook = next(
            command for command in after_request_headers if isinstance(command, HttpRequestHook)
        )
        flow = request_hook.flow
        assert "Authorization" not in flow.request.headers

        with patch.object(
            codex_model_catalog_cache,
            "prepare_request",
            fail_catalog_preparation,
        ):
            await addon_context.master.addons.trigger_event(request_hook)

        assert flow.request.headers["Authorization"] == resolved_token
        after_request = list(http_layer.handle_event(events.HookCompleted(request_hook, None)))
        all_commands.extend(after_request)

        response_headers_hook = next(
            command for command in after_request if isinstance(command, HttpResponseHeadersHook)
        )
        await addon_context.master.addons.invoke_addon(
            mitm_addon,
            response_headers_hook,
        )
        after_response_headers = list(
            http_layer.handle_event(events.HookCompleted(response_headers_hook, None))
        )
        all_commands.extend(after_response_headers)

        response_hook = next(
            command for command in after_response_headers if isinstance(command, HttpResponseHook)
        )
        await addon_context.master.addons.invoke_addon(mitm_addon, response_hook)
        all_commands.extend(http_layer.handle_event(events.HookCompleted(response_hook, None)))

    assert flow.response is not None
    assert flow.response.status_code == 500
    assert flow.response.json() == {
        "error": "request_processing_failed",
        "message": "Request processing failed",
    }
    assert flow.live is False
    assert any(
        "Addon error: post-auth request failure" in record.getMessage() for record in caplog.records
    )
    assert not any(isinstance(command, commands.OpenConnection) for command in all_commands)
    assert not any(
        isinstance(command, SendHttp)
        and isinstance(command.event, RequestHeaders)
        and command.connection is flow.server_conn
        for command in all_commands
    )

    client_bytes = b"".join(
        command.data
        for command in all_commands
        if isinstance(command, commands.SendData) and command.connection is client
    )
    assert resolved_token.encode() not in client_bytes
    response_events = http2.receive_data(client_bytes)
    response_headers = next(
        event for event in response_events if isinstance(event, h2_events.ResponseReceived)
    )
    assert dict(response_headers.headers)[b":status"] == b"500"
    assert (
        b"".join(
            event.data for event in response_events if isinstance(event, h2_events.DataReceived)
        )
        == flow.response.content
    )
    assert any(isinstance(event, h2_events.StreamEnded) for event in response_events)
