"""Raw WebSocket header budgets through mitmproxy's HTTP/1 request hooks."""

from pathlib import Path
from unittest.mock import patch

import pytest
from mitmproxy import http
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.proxy import events
from mitmproxy.proxy.layers.http._hooks import HttpRequestHeadersHook, HttpRequestHook
from mitmproxy.test import taddons

import flow_metadata_keys as metadata_keys
import mitm_addon
from tests.mitmproxy_http_framing_helpers import start_http_layer
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry

_WORK_LIMIT = 8 * 1024
_LARGE_VALUE = b"\xff" * (1024 * 1024)
_KEY = b"dGhlIHNhbXBsZSBub25jZQ=="


@pytest.mark.parametrize(
    ("header_name", "values", "is_upgrade"),
    [
        pytest.param(b"Sec-WebSocket-Key", (_LARGE_VALUE,), False, id="oversized-key"),
        pytest.param(b"Sec-WebSocket-Version", (_LARGE_VALUE,), False, id="oversized-version"),
        pytest.param(b"Sec-WebSocket-Key", (_KEY, _LARGE_VALUE), False, id="duplicate-key"),
        pytest.param(
            b"Sec-WebSocket-Version", (b"13", _LARGE_VALUE), False, id="duplicate-version"
        ),
        pytest.param(
            b"Upgrade", (b"websocket," + _LARGE_VALUE, _LARGE_VALUE), True, id="early-upgrade"
        ),
        pytest.param(
            b"Connection", (b"Upgrade," + _LARGE_VALUE, _LARGE_VALUE), True, id="early-connection"
        ),
        pytest.param(b"Upgrade", (_LARGE_VALUE + b",websocket",), False, id="late-upgrade"),
        pytest.param(b"Connection", (_LARGE_VALUE + b",upgrade",), False, id="late-connection"),
    ],
)
async def test_http1_handshake_classification_bounds_raw_value_conversion(
    tmp_path: Path,
    fake_firewall_headers,
    header_name: bytes,
    values: tuple[bytes, ...],
    *,
    is_upgrade: bool,
) -> None:
    firewall_name = "model-provider:openai-api-key"
    registry_path = _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            firewall_name=firewall_name,
            api_entry={
                "base": "https://api.openai.com/v1/responses",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [],
            },
            network_policy={"allow": [], "deny": [], "ask": [], "unknownPolicy": "allow"},
            billable_firewalls=[firewall_name],
            sandbox_fields={"modelUsageProvider": "gpt-5.5"},
        ),
    )
    fields = [
        (b"Host", b"api.openai.com"),
        (b"Upgrade", b"websocket"),
        (b"Connection", b"upgrade"),
        (b"Sec-WebSocket-Key", _KEY),
        (b"Sec-WebSocket-Version", b"13"),
        (b"Accept-Encoding", b"br"),
    ]
    fields = [(name, value) for name, value in fields if name != header_name]
    fields.extend((header_name, value) for value in values)
    wire = (
        b"GET https://api.openai.com/v1/responses HTTP/1.1\r\n"
        + b"\r\n".join(name + b": " + value for name, value in fields)
        + b"\r\n\r\n"
    )
    real_native = http._native

    def reject_oversized_conversion(value: bytes) -> str:
        assert len(value) <= _WORK_LIMIT, "hook decoded an oversized raw handshake field"
        return real_native(value)

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
        fake_firewall_headers(headers={"Authorization": "Bearer managed-secret"}),
    ):
        addon_context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry_path)
        )
        client, http_layer = start_http_layer(
            addon_context, alpn=b"http/1.1", host="api.openai.com"
        )
        initial_commands = list(http_layer.handle_event(events.DataReceived(client, wire)))
        headers_hook = next(
            command for command in initial_commands if isinstance(command, HttpRequestHeadersHook)
        )
        with patch.object(http, "_native", reject_oversized_conversion):
            await addon_context.master.addons.invoke_addon(mitm_addon, headers_hook)

        header_commands = list(http_layer.handle_event(events.HookCompleted(headers_hook, None)))
        request_hook = next(
            command for command in header_commands if isinstance(command, HttpRequestHook)
        )
        with patch.object(http, "_native", reject_oversized_conversion):
            await addon_context.master.addons.invoke_addon(mitm_addon, request_hook)

    flow = request_hook.flow
    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.request.headers["Authorization"] == "Bearer managed-secret"
    assert bool(flow.metadata.get(metadata_keys.WEBSOCKET_UPGRADE_REQUEST)) is is_upgrade
    assert (metadata_keys.RESPONSE_ENCODING_NEGOTIATION not in flow.metadata) is is_upgrade
    assert (
        tuple(value for name, value in flow.request.headers.fields if name == header_name) == values
    )
