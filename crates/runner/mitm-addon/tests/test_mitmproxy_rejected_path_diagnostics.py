"""Bound rejected-path diagnostics through the real HTTP/1 hook pipeline."""

import json
import urllib.parse
from collections import deque
from pathlib import Path
from unittest.mock import patch

import pytest
from mitmproxy import connection, http
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.proxy import commands, events
from mitmproxy.proxy.layers.http._hooks import (
    HttpRequestHeadersHook,
    HttpRequestHook,
    HttpResponseHeadersHook,
    HttpResponseHook,
)
from mitmproxy.test import taddons

import flow_metadata_keys as metadata_keys
import http_local_responses
import mitm_addon
from tests.mitmproxy_http_framing_helpers import start_http_layer
from tests.request_handler_helpers import _write_github_firewall_registry

_DIAGNOSTIC_LIMIT = 131_072
_TRUNCATION_MARKER = "...[truncated]"
_ORIGIN = "https://api.github.com"


async def _drive_rejected_http1_request(
    addon_context: taddons.context, *, method: str, target: bytes
) -> tuple[http.HTTPFlow, bytes, list[commands.Command]]:
    client, layer = start_http_layer(addon_context, alpn=b"http/1.1", host="api.github.com")
    wire = method.encode() + b" " + target + b" HTTP/1.1\r\nHost: api.github.com\r\n\r\n"
    pending: deque[commands.Command] = deque()
    for offset in range(0, len(wire), 16_384):
        pending.extend(
            layer.handle_event(events.DataReceived(client, wire[offset : offset + 16_384]))
        )
    all_commands: list[commands.Command] = []
    flow = None
    while pending:
        command = pending.popleft()
        all_commands.append(command)
        if isinstance(command, HttpRequestHeadersHook):
            flow = command.flow
        if isinstance(
            command,
            (HttpRequestHeadersHook, HttpRequestHook, HttpResponseHeadersHook, HttpResponseHook),
        ):
            await addon_context.master.addons.invoke_addon(mitm_addon, command)
            pending.extend(layer.handle_event(events.HookCompleted(command, None)))
    assert flow is not None
    client_bytes = b"".join(
        command.data
        for command in all_commands
        if isinstance(command, commands.SendData) and command.connection is client
    )
    return flow, client_bytes, all_commands


@pytest.mark.parametrize(
    ("method", "path_size", "fill", "suffix"),
    [
        pytest.param("GET", 1024, "x", "?private=query#fragment", id="ordinary"),
        pytest.param("GET", _DIAGNOSTIC_LIMIT, "x", "", id="exact-bound"),
        pytest.param("GET", _DIAGNOSTIC_LIMIT + 1, "x", "", id="over-bound"),
        pytest.param("GET", 1024 * 1024, "x", "", id="megabyte"),
        pytest.param("GET", 1024 * 1024, '"', "", id="json-escaped"),
        pytest.param("GET", 1024, "x", "?private=" + "s" * 200_000, id="large-query"),
        pytest.param("GET", 1024, "x", "#private=" + "s" * 200_000, id="large-fragment"),
        pytest.param("HEAD", 1024 * 1024, "x", "?private=query#fragment", id="head"),
    ],
)
async def test_rejected_path_diagnostics_are_bounded_before_materialization(
    tmp_path: Path,
    fake_firewall_headers,
    method: str,
    path_size: int,
    fill: str,
    suffix: str,
) -> None:
    registry_path = _write_github_firewall_registry(tmp_path)
    prefix = "/repos/../"
    path = prefix + fill * (path_size - len(prefix))
    original_url = _ORIGIN + path + suffix
    parsed_urls: list[str] = []
    response_bodies: list[dict[str, object]] = []
    real_split = http_local_responses.split_runtime_url
    real_make_response = http_local_responses.make_local_json_response

    def bounded_split(value: str) -> urllib.parse.SplitResult:
        assert len(value) <= _DIAGNOSTIC_LIMIT
        parsed_urls.append(value)
        return real_split(value)

    def bounded_make_response(
        flow: http.HTTPFlow, status: int, body: dict[str, object]
    ) -> http.Response:
        assert isinstance(body["path"], str)
        assert isinstance(body["url"], str)
        assert len(body["path"]) <= _DIAGNOSTIC_LIMIT
        assert len(body["url"]) <= _DIAGNOSTIC_LIMIT
        response_bodies.append(body)
        return real_make_response(flow, status, body)

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
        fake_firewall_headers() as auth_fetch,
        patch.object(http_local_responses, "split_runtime_url", bounded_split),
        patch.object(http_local_responses, "make_local_json_response", bounded_make_response),
    ):
        addon_context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry_path)
        )
        flow, client_bytes, all_commands = await _drive_rejected_http1_request(
            addon_context, method=method, target=original_url.encode()
        )

    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.request.path == path + suffix
    assert flow.metadata[metadata_keys.ORIGINAL_URL] == original_url
    assert "Authorization" not in flow.request.headers
    auth_fetch.assert_not_awaited()
    assert not any(
        isinstance(command, (commands.OpenConnection, commands.SendData))
        and isinstance(command.connection, connection.Server)
        for command in all_commands
    )
    assert len(parsed_urls) == 1
    assert len(response_bodies) == 1
    body = response_bodies[0]
    if len(path) <= _DIAGNOSTIC_LIMIT:
        expected_path = path
    else:
        expected_path = path[: _DIAGNOSTIC_LIMIT - len(_TRUNCATION_MARKER)] + _TRUNCATION_MARKER
    retained_url = _ORIGIN + path
    if len(retained_url) <= _DIAGNOSTIC_LIMIT:
        expected_url = retained_url
    else:
        expected_url = (
            retained_url[: _DIAGNOSTIC_LIMIT - len(_TRUNCATION_MARKER)] + _TRUNCATION_MARKER
        )
    assert parsed_urls == [expected_url]
    assert body == {
        "error": "permission_denied",
        "reason": "unsafe_path",
        "message": "Request blocked: unsafe path",
        "method": method,
        "path": expected_path,
        "url": expected_url,
        "permissions": [],
    }
    response_head, separator, response_body = client_bytes.partition(b"\r\n\r\n")
    assert response_head.startswith(b"HTTP/1.1 403 ")
    assert separator == b"\r\n\r\n"
    assert b"content-type: application/json" in response_head.lower()
    if method == "HEAD":
        assert response_body == b""
        assert flow.response.raw_content == b""
        assert b"content-length:" not in response_head.lower()
    else:
        assert response_body == flow.response.raw_content
        assert json.loads(response_body) == body
        assert int(flow.response.headers["Content-Length"]) == len(response_body)
        # JSON's largest scalar escape is a 12-byte surrogate pair.
        assert len(response_body) <= 2 * 12 * _DIAGNOSTIC_LIMIT + 1024
