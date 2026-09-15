"""Bodyless response framing tests through mitmproxy's real hook pipeline."""

from pathlib import Path
from typing import Literal
from unittest.mock import patch

import pytest
from h2 import events as h2_events
from h2.config import H2Configuration
from h2.connection import H2Connection
from mitmproxy import connection
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.proxy import commands, events
from mitmproxy.proxy.layers.http import HttpLayer, HttpStream, SendHttp
from mitmproxy.proxy.layers.http._events import (
    ResponseData,
    ResponseEndOfMessage,
    ResponseHeaders,
)
from mitmproxy.proxy.layers.http._hooks import (
    HttpRequestHeadersHook,
    HttpRequestHook,
    HttpResponseHeadersHook,
    HttpResponseHook,
)
from mitmproxy.test import taddons, tutils

import flow_metadata_keys as metadata_keys
import mitm_addon
from tests.connector_diagnostic_helpers import (
    record_connector_diagnostic_requestheaders_context,
    write_connector_diagnostic_capture_registry,
)
from tests.flow_helpers import header_map
from tests.mitmproxy_http_framing_helpers import CLIENT_IP, start_http_layer
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry


def _start_head_firewall_request(
    addon_context: taddons.context,
    *,
    protocol: Literal["http1", "http2"],
) -> tuple[connection.Client, H2Connection | None, HttpLayer, HttpRequestHeadersHook]:
    alpn = b"h2" if protocol == "http2" else b"http/1.1"
    client, http_layer = start_http_layer(
        addon_context,
        alpn=alpn,
        host="api.github.com",
    )
    http2: H2Connection | None = None
    if protocol == "http2":
        http2 = H2Connection(H2Configuration(client_side=True, header_encoding=None))
        http2.initiate_connection()
        http2.send_headers(
            1,
            [
                (b":method", b"HEAD"),
                (b":scheme", b"https"),
                (b":authority", b"api.github.com"),
                (b":path", b"/orgs"),
            ],
            end_stream=True,
        )
        request_bytes = http2.data_to_send()
    else:
        request_bytes = b"HEAD /orgs HTTP/1.1\r\nHost: api.github.com\r\n\r\n"

    request_commands = list(http_layer.handle_event(events.DataReceived(client, request_bytes)))
    request_headers_hook = next(
        command for command in request_commands if isinstance(command, HttpRequestHeadersHook)
    )
    return client, http2, http_layer, request_headers_hook


@pytest.mark.parametrize("protocol", ["http1", "http2"])
async def test_head_firewall_block_emits_no_response_data(
    tmp_path: Path,
    protocol: Literal["http1", "http2"],
) -> None:
    registry_path = _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            api_entry={
                "base": "https://api.github.com",
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"}},
                "permissions": [
                    {
                        "name": "read-repos",
                        "rules": ["GET /repos/{owner}/{repo}"],
                    }
                ],
            },
            network_policy={
                "allow": ["read-repos"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
        ),
    )

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        addon_context.options.update(
            okou_api_url="https://api.okou.ai",
            okou_proxy_registry_path=str(registry_path),
        )
        client, http2, http_layer, request_headers_hook = _start_head_firewall_request(
            addon_context,
            protocol=protocol,
        )
        await addon_context.master.addons.invoke_addon(mitm_addon, request_headers_hook)
        all_commands = list(
            http_layer.handle_event(events.HookCompleted(request_headers_hook, None))
        )

        request_hook = next(
            command for command in all_commands if isinstance(command, HttpRequestHook)
        )
        await addon_context.master.addons.invoke_addon(mitm_addon, request_hook)
        after_request = list(http_layer.handle_event(events.HookCompleted(request_hook, None)))
        all_commands.extend(after_request)

        response_headers_hook = next(
            command for command in after_request if isinstance(command, HttpResponseHeadersHook)
        )
        await addon_context.master.addons.invoke_addon(mitm_addon, response_headers_hook)
        after_response_headers = list(
            http_layer.handle_event(events.HookCompleted(response_headers_hook, None))
        )
        all_commands.extend(after_response_headers)

        response_hook = next(
            command for command in after_response_headers if isinstance(command, HttpResponseHook)
        )
        await addon_context.master.addons.invoke_addon(mitm_addon, response_hook)
        all_commands.extend(http_layer.handle_event(events.HookCompleted(response_hook, None)))

    flow = request_headers_hook.flow
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.response.raw_content == b""
    assert flow.response.headers["Content-Type"] == "application/json"
    assert flow.response.headers.get_all("Content-Length") == []
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "DENY"
    assert not any(isinstance(command, commands.OpenConnection) for command in all_commands)

    client_bytes = b"".join(
        command.data
        for command in all_commands
        if isinstance(command, commands.SendData) and command.connection is client
    )
    if protocol == "http1":
        response_head, separator, response_body = client_bytes.partition(b"\r\n\r\n")
        assert separator == b"\r\n\r\n"
        assert response_head.startswith(b"HTTP/1.1 403 ")
        assert b"content-length:" not in response_head.lower()
        assert response_body == b""
    else:
        assert http2 is not None
        response_events = http2.receive_data(client_bytes)
        response_headers = next(
            event for event in response_events if isinstance(event, h2_events.ResponseReceived)
        )
        assert dict(response_headers.headers)[b":status"] == b"403"
        assert b"content-length" not in dict(response_headers.headers)
        assert not any(isinstance(event, h2_events.DataReceived) for event in response_events)
        assert any(isinstance(event, h2_events.StreamEnded) for event in response_events)


async def test_head_connector_diagnostic_emits_no_response_data(
    tmp_path: Path,
    real_flow,
) -> None:
    registry_path = write_connector_diagnostic_capture_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip=CLIENT_IP,
        host="fal.run",
        path="/fal-ai/nano-banana-pro",
        method="HEAD",
    )

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        addon_context.options.update(
            okou_api_url="https://api.okou.ai",
            okou_builtin_firewall_catalog_cache_path=str(
                tmp_path / "builtin-firewall-catalog-cache.json"
            ),
            okou_proxy_registry_path=str(registry_path),
        )
        record_connector_diagnostic_requestheaders_context(flow)
        _, http_layer = start_http_layer(
            addon_context,
            alpn=b"h2",
            host="fal.run",
        )
        stream = HttpStream(http_layer.context.fork(), 1)
        list(stream.handle_event(events.Start()))
        stream.flow = flow
        flow.live = True
        stream.client_state = stream.state_done
        stream.server_state = stream.state_wait_for_response_headers

        upstream_response = tutils.tresp(
            status_code=401,
            headers=header_map(
                {
                    "Content-Length": "8",
                    "Content-Type": "text/plain",
                }
            ),
            content=b"",
        )
        response_header_commands = list(
            stream.handle_event(ResponseHeaders(1, upstream_response, end_stream=True))
        )
        response_headers_hook = next(
            command
            for command in response_header_commands
            if isinstance(command, HttpResponseHeadersHook)
        )
        await addon_context.master.addons.invoke_addon(
            mitm_addon,
            response_headers_hook,
        )
        after_headers = list(stream.handle_event(events.HookCompleted(response_headers_hook, None)))

        end_commands = list(stream.handle_event(ResponseEndOfMessage(1)))
        response_hook = next(
            command for command in end_commands if isinstance(command, HttpResponseHook)
        )
        await addon_context.master.addons.invoke_addon(mitm_addon, response_hook)
        after_response = list(stream.handle_event(events.HookCompleted(response_hook, None)))

    assert flow.response is not None
    assert flow.response.status_code == 401
    assert flow.response.raw_content == b""
    assert flow.response.headers["Content-Type"] == "application/json"
    assert flow.response.headers.get_all("Content-Length") == []
    client_events = [
        command.event
        for command in [*after_headers, *end_commands, *after_response]
        if isinstance(command, SendHttp)
    ]
    assert any(
        isinstance(event, ResponseHeaders)
        and event.response.status_code == 401
        and event.end_stream
        for event in client_events
    )
    assert not any(isinstance(event, ResponseData) for event in client_events)
    assert any(isinstance(event, ResponseEndOfMessage) for event in client_events)
