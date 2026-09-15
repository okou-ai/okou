"""Request-body admission framing tests through mitmproxy's real hook pipeline."""

from pathlib import Path
from typing import Literal
from unittest.mock import AsyncMock, patch

import pytest
from mitmproxy import http
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.flow import Error
from mitmproxy.proxy import events
from mitmproxy.proxy.layers.http import HttpLayer
from mitmproxy.proxy.layers.http._hooks import (
    HttpErrorHook,
    HttpRequestHeadersHook,
    HttpRequestHook,
)
from mitmproxy.test import taddons

import auth
import auth_base_forwarder
import aws_sigv4_body_admission
import flow_metadata_keys as metadata_keys
import mitm_addon
from tests.auth_base_forwarder_helpers import fake_forwarder_upstream
from tests.aws_sigv4_helpers import (
    DEFAULT_SIGV4_TIMESTAMP,
    RESOLVED_AWS_ACCESS_KEY_ID,
    STS_HOST,
    aws_sigv4_authorization,
    resolved_aws_sigv4_credentials,
)
from tests.firewall_auth_helpers import firewall_auth_response
from tests.firewall_aws_sigv4_helpers import aws_api_entry
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.mitmproxy_http_framing_helpers import (
    CLIENT_IP,
    PLACEHOLDER_HOST,
    start_http2_request,
    start_http_layer,
)
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry


def _write_auth_base_firewall_registry(tmp_path: Path) -> Path:
    return _write_registry(
        tmp_path,
        client_ip=CLIENT_IP,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            firewall_name="webhook",
            api_entry={
                "base": f"https://{PLACEHOLDER_HOST}",
                "auth": {"headers": {}, "base": "${{ secrets.WEBHOOK_URL }}"},
                "permissions": [{"name": "send", "rules": ["GET /", "HEAD /"]}],
            },
            network_policy={
                "allow": ["send"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
        ),
    )


def _write_aws_sigv4_firewall_registry(tmp_path: Path) -> Path:
    api_entry: dict[str, object] = dict(aws_api_entry())
    api_entry["permissions"] = [
        {
            "name": "identity",
            "rules": ["POST /"],
        }
    ]
    return _write_registry(
        tmp_path,
        client_ip=CLIENT_IP,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            firewall_name="aws",
            api_entry=api_entry,
            network_policy={
                "allow": ["identity"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
        ),
    )


def _start_http1_request(
    addon_context: taddons.context,
    *,
    method: str,
) -> tuple[HttpLayer, HttpRequestHeadersHook]:
    client, http_layer = start_http_layer(addon_context, alpn=b"http/1.1")

    commands = list(
        http_layer.handle_event(
            events.DataReceived(
                client,
                f"{method} / HTTP/1.1\r\nHost: {PLACEHOLDER_HOST}\r\n\r\n".encode(),
            )
        )
    )
    request_headers_hook = next(
        command for command in commands if isinstance(command, HttpRequestHeadersHook)
    )
    return http_layer, request_headers_hook


async def test_http2_open_sigv4_request_without_length_is_rejected_before_body(
    tmp_path: Path,
) -> None:
    registry_path = _write_aws_sigv4_firewall_registry(tmp_path)
    get_headers = AsyncMock()

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        addon_context.options.update(
            okou_api_url="https://api.okou.ai",
            okou_proxy_registry_path=str(registry_path),
        )
        http_layer, request_headers_hook = start_http2_request(
            addon_context,
            method="POST",
            end_stream=False,
            host=STS_HOST,
            regular_headers=(
                (b"x-amz-date", DEFAULT_SIGV4_TIMESTAMP.encode()),
                (b"authorization", aws_sigv4_authorization().encode()),
            ),
        )

        await addon_context.master.addons.invoke_addon(mitm_addon, request_headers_hook)
        flow = request_headers_hook.flow
        commands = list(http_layer.handle_event(events.HookCompleted(request_headers_hook, None)))
        error_hook = next(command for command in commands if isinstance(command, HttpErrorHook))
        await addon_context.master.addons.invoke_addon(mitm_addon, error_hook)

    assert flow.error is not None
    assert flow.error.msg == Error.KILLED_MESSAGE
    assert flow.request.raw_content is None
    assert (
        flow.metadata[metadata_keys.FIREWALL_ERROR]
        == auth.AWS_SIGV4_REQUEST_BODY_LENGTH_REQUIRED_ERROR
    )
    assert aws_sigv4_body_admission.state_for_tests() == (0, 0)
    assert not any(isinstance(command, HttpRequestHook) for command in commands)
    get_headers.assert_not_awaited()


async def test_http2_headers_only_sigv4_request_uses_zero_byte_admission(
    tmp_path: Path,
) -> None:
    registry_path = _write_aws_sigv4_firewall_registry(tmp_path)
    token_meta = firewall_auth_response(
        headers={},
        aws_sigv4=resolved_aws_sigv4_credentials(),
    )
    get_headers = AsyncMock(return_value=token_meta)

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        addon_context.options.update(
            okou_api_url="https://api.okou.ai",
            okou_proxy_registry_path=str(registry_path),
        )
        http_layer, request_headers_hook = start_http2_request(
            addon_context,
            method="POST",
            end_stream=True,
            host=STS_HOST,
            regular_headers=(
                (b"x-amz-date", DEFAULT_SIGV4_TIMESTAMP.encode()),
                (b"authorization", aws_sigv4_authorization().encode()),
            ),
        )

        await addon_context.master.addons.invoke_addon(mitm_addon, request_headers_hook)
        assert aws_sigv4_body_admission.state_for_tests() == (1, 0)
        commands = list(http_layer.handle_event(events.HookCompleted(request_headers_hook, None)))
        request_hook = next(command for command in commands if isinstance(command, HttpRequestHook))
        await addon_context.master.addons.invoke_addon(mitm_addon, request_hook)
        flow = request_hook.flow

        assert f"Credential={RESOLVED_AWS_ACCESS_KEY_ID}/" in flow.request.headers["authorization"]
        assert aws_sigv4_body_admission.state_for_tests() == (1, 0)
        flow.response = http.Response.make(200, b"ok")
        mitm_addon.response(flow)

    get_headers.assert_awaited_once()
    assert aws_sigv4_body_admission.state_for_tests() == (0, 0)


@pytest.mark.parametrize("method", ["GET", "HEAD"])
async def test_http2_open_auth_base_request_without_length_is_rejected_before_body(
    tmp_path: Path,
    method: Literal["GET", "HEAD"],
) -> None:
    registry_path = _write_auth_base_firewall_registry(tmp_path)
    get_headers = AsyncMock()

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        addon_context.options.update(
            okou_api_url="https://api.okou.ai",
            okou_proxy_registry_path=str(registry_path),
        )
        http_layer, request_headers_hook = start_http2_request(
            addon_context,
            method=method,
            end_stream=False,
        )
        original_headers = tuple(request_headers_hook.flow.request.headers.fields)

        await addon_context.master.addons.invoke_addon(mitm_addon, request_headers_hook)
        flow = request_headers_hook.flow
        commands = list(http_layer.handle_event(events.HookCompleted(request_headers_hook, None)))
        error_hook = next(command for command in commands if isinstance(command, HttpErrorHook))
        await addon_context.master.addons.invoke_addon(mitm_addon, error_hook)

    assert flow.error is not None
    assert flow.error.msg == Error.KILLED_MESSAGE
    assert flow.live is False
    assert flow.request.raw_content is None
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "auth_base_request_body_length_required"
    assert auth_base_forwarder.forward_request_admission_state_for_tests() == (0, 0)
    assert not any(isinstance(command, HttpRequestHook) for command in commands)
    assert tuple(flow.request.headers.fields) == original_headers
    get_headers.assert_not_awaited()

    network_log_entry = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")[0]
    assert network_log_entry["request_size"] == 0
    assert network_log_entry["firewall_error"] == "auth_base_request_body_length_required"

    proxy_log_entry = next(
        entry
        for entry in read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
        if "framing_error" in entry
    )
    assert proxy_log_entry["framing_error"] == "request_stream_open"


@pytest.mark.parametrize("http_version", ["HTTP/1.1", "HTTP/2"])
@pytest.mark.parametrize("method", ["GET", "HEAD"])
async def test_headers_only_auth_base_request_without_length_is_forwarded(
    tmp_path: Path,
    http_version: Literal["HTTP/1.1", "HTTP/2"],
    method: Literal["GET", "HEAD"],
) -> None:
    registry_path = _write_auth_base_firewall_registry(tmp_path)
    token_meta = firewall_auth_response(
        headers={},
        base="https://real.example.com/webhook",
        resolved_secrets=["WEBHOOK_URL"],
    )

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
        patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
        fake_forwarder_upstream(status=200, body=b"ok"),
    ):
        addon_context.options.update(
            okou_api_url="https://api.okou.ai",
            okou_proxy_registry_path=str(registry_path),
        )
        if http_version == "HTTP/2":
            http_layer, request_headers_hook = start_http2_request(
                addon_context,
                method=method,
                end_stream=True,
            )
        else:
            http_layer, request_headers_hook = _start_http1_request(
                addon_context,
                method=method,
            )
        original_headers = tuple(request_headers_hook.flow.request.headers.fields)

        await addon_context.master.addons.invoke_addon(mitm_addon, request_headers_hook)
        assert auth_base_forwarder.forward_request_admission_state_for_tests() == (1, 0)
        assert tuple(request_headers_hook.flow.request.headers.fields) == original_headers

        commands = list(http_layer.handle_event(events.HookCompleted(request_headers_hook, None)))
        request_hook = next(command for command in commands if isinstance(command, HttpRequestHook))
        await addon_context.master.addons.invoke_addon(mitm_addon, request_hook)

    assert request_hook.flow.response is not None
    assert request_hook.flow.response.status_code == 200
    assert auth_base_forwarder.forward_request_admission_state_for_tests() == (0, 0)
