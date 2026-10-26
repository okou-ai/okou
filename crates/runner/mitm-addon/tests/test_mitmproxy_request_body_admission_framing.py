"""Request-body admission framing tests through mitmproxy's real hook pipeline."""

import sys
from pathlib import Path
from types import FrameType
from typing import Literal
from unittest.mock import AsyncMock, patch

import pytest
from hyperframe.frame import DataFrame
from mitmproxy import http
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.flow import Error
from mitmproxy.proxy import commands, events
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
import content_length as content_length_parser
import flow_metadata_keys as metadata_keys
import managed_upload_runtime
import mitm_addon
import mitmproxy_compat
import usage
from tests.auth_base_forwarder_helpers import fake_forwarder_upstream
from tests.aws_sigv4_helpers import (
    DEFAULT_SIGV4_TIMESTAMP,
    RESOLVED_AWS_ACCESS_KEY_ID,
    STS_FORM_BODY,
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


def _write_aws_sigv4_firewall_registry(
    tmp_path: Path,
    *,
    rules: list[str] | None = None,
) -> Path:
    api_entry: dict[str, object] = dict(aws_api_entry())
    api_entry["permissions"] = [
        {
            "name": "identity",
            "rules": ["POST /"] if rules is None else rules,
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


@pytest.mark.parametrize("protocol", ["http1", "http2"])
@pytest.mark.parametrize("saturated", [False, True], ids=["admitted", "saturated"])
async def test_pending_action_admission_precedes_native_body_buffering(
    tmp_path: Path, monkeypatch, protocol: str, saturated: bool
) -> None:
    registry_path = _write_aws_sigv4_firewall_registry(
        tmp_path, rules=["POST / AWS sigv4=sts action=GetCallerIdentity"]
    )
    get_headers = AsyncMock(
        return_value=firewall_auth_response(headers={}, aws_sigv4=resolved_aws_sigv4_credentials())
    )
    if saturated:
        monkeypatch.setattr(aws_sigv4_body_admission, "MAX_ADMITTED_AWS_SIGV4_REQUESTS", 0)
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        addon_context.options.update(
            okou_api_url="https://api.okou.ai",
            okou_proxy_registry_path=str(registry_path),
        )
        regular_headers = (
            (b"x-amz-date", DEFAULT_SIGV4_TIMESTAMP.encode()),
            (b"authorization", aws_sigv4_authorization().encode()),
            (b"content-type", b"application/x-www-form-urlencoded"),
            (b"content-length", str(len(STS_FORM_BODY)).encode()),
        )
        if protocol == "http2":
            http_layer, headers_hook = start_http2_request(
                addon_context,
                method="POST",
                end_stream=False,
                host=STS_HOST,
                regular_headers=regular_headers,
            )
            data_frame = DataFrame(1)
            data_frame.data = STS_FORM_BODY
            data_frame.flags.add("END_STREAM")
            body_wire = data_frame.serialize()
        else:
            client, http_layer = start_http_layer(addon_context, alpn=b"http/1.1", host=STS_HOST)
            head = (
                b"POST / HTTP/1.1\r\nHost: "
                + STS_HOST.encode()
                + b"\r\n"
                + b"".join(name + b": " + value + b"\r\n" for name, value in regular_headers)
                + b"\r\n"
            )
            pending = list(http_layer.handle_event(events.DataReceived(client, head)))
            headers_hook = next(cmd for cmd in pending if isinstance(cmd, HttpRequestHeadersHook))
            body_wire = STS_FORM_BODY

        await addon_context.master.addons.invoke_addon(mitm_addon, headers_hook)
        flow = headers_hook.flow
        assert flow.request.raw_content is None
        get_headers.assert_not_awaited()
        pending = list(http_layer.handle_event(events.HookCompleted(headers_hook, None)))
        assert not any(isinstance(cmd, HttpRequestHook) for cmd in pending)
        if saturated:
            assert flow.error is not None
            error_hook = next(cmd for cmd in pending if isinstance(cmd, HttpErrorHook))
            await addon_context.master.addons.invoke_addon(mitm_addon, error_hook)
            assert aws_sigv4_body_admission.state_for_tests() == (0, 0)
            get_headers.assert_not_awaited()
            return

        assert aws_sigv4_body_admission.state_for_tests() == (1, len(STS_FORM_BODY))
        pending = list(http_layer.handle_event(events.DataReceived(flow.client_conn, body_wire)))
        request_hook = next(cmd for cmd in pending if isinstance(cmd, HttpRequestHook))
        assert flow.request.raw_content == STS_FORM_BODY
        await addon_context.master.addons.invoke_addon(mitm_addon, request_hook)
        assert f"Credential={RESOLVED_AWS_ACCESS_KEY_ID}/" in flow.request.headers["authorization"]
        assert aws_sigv4_body_admission.state_for_tests() == (1, len(STS_FORM_BODY))
        flow.response = http.Response.make(200, b"ok")
        mitm_addon.response(flow)

    get_headers.assert_awaited_once()
    assert aws_sigv4_body_admission.state_for_tests() == (0, 0)


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


@pytest.mark.parametrize(
    ("content_length", "firewall_kind", "mismatched_authority"),
    [
        pytest.param("9" * 5000, "aws", False, id="long-positive"),
        pytest.param("0" * 5000, "aws", False, id="long-zero"),
        pytest.param("0" * 5000 + "1", "aws", False, id="long-leading-zero-positive"),
        pytest.param("0" * (1024 * 1024), "aws", False, id="large-zero-aws"),
        pytest.param("0" * (1024 * 1024), "auth-base", False, id="large-zero-auth-base"),
        pytest.param("0" * (1024 * 1024), "aws", True, id="large-zero-authority-mismatch"),
    ],
)
async def test_http1_rejected_content_length_skips_addon_body_work(
    tmp_path: Path,
    content_length: str,
    firewall_kind: str,
    mismatched_authority: bool,
) -> None:
    if firewall_kind == "aws":
        registry_path = _write_aws_sigv4_firewall_registry(
            tmp_path,
            rules=["POST / AWS sigv4=sts action=GetCallerIdentity"],
        )
        host = STS_HOST
        method = "POST"
    else:
        registry_path = _write_auth_base_firewall_registry(tmp_path)
        host = PLACEHOLDER_HOST
        method = "GET"
    authorization = aws_sigv4_authorization()
    get_headers = AsyncMock()
    length_parse_calls = 0
    classified_calls = 0
    end_stream_markers: list[object] = []

    def observe_header_work(frame: FrameType, event: str, result: object) -> None:
        nonlocal length_parse_calls, classified_calls
        if event == "call":
            if frame.f_code is content_length_parser.parse.__code__:
                length_parse_calls += 1
            elif frame.f_code is managed_upload_runtime.headers_classified.__code__:
                classified_calls += 1
        elif (
            event == "return" and frame.f_code is mitmproxy_compat.take_request_end_stream.__code__
        ):
            end_stream_markers.append(result)

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        addon_context.options.update(
            okou_api_url="https://api.okou.ai",
            okou_proxy_registry_path=str(registry_path),
        )
        client, http_layer = start_http_layer(
            addon_context,
            alpn=b"http/1.1",
            host=host,
        )
        # Absolute-form retains the destination when native validation rejects
        # headers before the usual Host normalization.
        host_header = "other.example.com" if mismatched_authority else host
        request_head = (
            f"{method} https://{host}/ HTTP/1.1\r\nHost: {host_header}\r\n"
            f"X-Amz-Date: {DEFAULT_SIGV4_TIMESTAMP}\r\nAuthorization: {authorization}\r\n"
            f"Content-Length: {content_length}\r\n\r\n"
        ).encode()
        all_commands = list(http_layer.handle_event(events.DataReceived(client, request_head)))
        request_headers_hook = next(
            command for command in all_commands if isinstance(command, HttpRequestHeadersHook)
        )
        flow = request_headers_hook.flow
        assert flow.error is not None
        original_error = flow.error

        previous_profile = sys.getprofile()
        sys.setprofile(observe_header_work)
        try:
            await addon_context.master.addons.invoke_addon(mitm_addon, request_headers_hook)
        finally:
            sys.setprofile(previous_profile)
        assert length_parse_calls == 0
        assert classified_calls == 1
        assert end_stream_markers == [False]
        assert mitmproxy_compat.take_request_end_stream(flow) is None
        assert flow.error is original_error
        assert flow.request.raw_content is None
        assert aws_sigv4_body_admission.state_for_tests() == (0, 0)
        assert auth_base_forwarder.forward_request_admission_state_for_tests() == (0, 0)
        assert usage.counters.delivery_snapshot()["flows"] == 0
        get_headers.assert_not_awaited()
        header_commands = list(
            http_layer.handle_event(events.HookCompleted(request_headers_hook, None))
        )
        all_commands.extend(header_commands)
        error_hook = next(
            command for command in header_commands if isinstance(command, HttpErrorHook)
        )
        await addon_context.master.addons.invoke_addon(mitm_addon, error_hook)
        all_commands.extend(http_layer.handle_event(events.HookCompleted(error_hook, None)))

    assert flow.error is original_error
    assert flow.live is False
    assert flow.request.raw_content is None
    assert flow.request.headers["Authorization"] == authorization
    assert not any(isinstance(command, HttpRequestHook) for command in all_commands)
    assert not any(
        isinstance(command, (commands.OpenConnection, commands.SendData))
        and command.connection is flow.server_conn
        for command in all_commands
    )
    assert any(
        isinstance(command, commands.CloseConnection) and command.connection is client
        for command in all_commands
    )
    client_bytes = b"".join(
        command.data
        for command in all_commands
        if isinstance(command, commands.SendData) and command.connection is client
    )
    assert client_bytes.startswith(b"HTTP/1.1 400")
    get_headers.assert_not_awaited()
    assert aws_sigv4_body_admission.state_for_tests() == (0, 0)
    assert auth_base_forwarder.forward_request_admission_state_for_tests() == (0, 0)
    assert usage.counters.delivery_snapshot()["flows"] == 0
    assert flow.metadata[metadata_keys.SANDBOX_RUN_ID] == "run-conn-1"
    [network_entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert network_entry["status"] == 0
    assert network_entry["error"] == original_error.msg
    assert network_entry["url"] == f"https://{host}/"
    assert network_entry["host"] == host
    [proxy_entry] = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
    assert proxy_entry["type"] == "connection_error"
    assert proxy_entry["error"] == original_error.msg


@pytest.mark.parametrize("action_rule", [False, True], ids=["path-rule", "action-rule"])
async def test_http2_open_sigv4_request_without_length_is_rejected_before_body(
    tmp_path: Path,
    action_rule: bool,
) -> None:
    registry_path = _write_aws_sigv4_firewall_registry(
        tmp_path,
        rules=["POST / AWS sigv4=sts action=GetCallerIdentity"] if action_rule else None,
    )
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
