"""Auth-base request body and requestheaders tests for the request hook."""

import json
from unittest.mock import AsyncMock, patch

import pytest
from mitmproxy import http
from mitmproxy.flow import Error

import auth
import auth_base_forwarder
import flow_metadata_keys as metadata_keys
import mitm_addon
import request_classification
import upstream_destination_binding
from tests.auth_base_client_header_helpers import UnconvertedHeaderValue
from tests.auth_base_forwarder_helpers import fake_forwarder_upstream
from tests.buffered_auth_body_framing_cases import (
    BufferedAuthBodyFramingRejectionCase,
    buffered_auth_body_framing_case_id,
    buffered_auth_body_framing_rejection_cases,
)
from tests.firewall_auth_helpers import firewall_auth_response
from tests.jsonl_log_helpers import read_jsonl_text_after_flush
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry

_BROWSER_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) HeadlessChrome/126.0.0.0 Safari/537.36"
)


def _write_auth_base_firewall_registry(
    tmp_path,
    *,
    auth_config: dict[str, object] | None = None,
    sandbox_fields: dict[str, object] | None = None,
):
    auth_config = auth_config or {"headers": {}, "base": "${{ secrets.WEBHOOK_URL }}"}
    return _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            firewall_name="webhook",
            api_entry={
                "base": "https://placeholder.example.com",
                "auth": auth_config,
                "permissions": [{"name": "send", "rules": ["ANY /"]}],
            },
            network_policy={
                "allow": ["send"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
            sandbox_fields=sandbox_fields,
        ),
    )


async def test_oversized_auth_base_request_does_not_capture_request_body(
    tmp_path, real_flow, mitm_ctx, headers
):
    request_body = b'{"secret":"super-secret-body"}'
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            firewall_name="webhook",
            api_entry={
                "base": "https://placeholder.example.com",
                "auth": {"headers": {}, "base": "${{ secrets.WEBHOOK_URL }}"},
                "permissions": [{"name": "send", "rules": ["POST /"]}],
            },
            network_policy={
                "allow": ["send"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
            sandbox_fields={"captureNetworkBodies": True},
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="placeholder.example.com",
        method="POST",
        path="/",
        request_headers=headers(
            ("Host", "placeholder.example.com"),
            ("Content-Type", "application/json"),
        ),
        request_body=request_body,
    )
    get_headers = AsyncMock()

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        patch.object(auth, "MAX_AUTH_BASE_REQUEST_BODY_BYTES", 4),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        await mitm_addon.request(flow)
        mitm_addon.response(flow)

    get_headers.assert_not_called()
    assert flow.response is not None
    assert flow.response.status_code == 413
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "auth_base_request_body_too_large"
    assert flow.metadata[metadata_keys.SUPPRESS_REQUEST_BODY_CAPTURE] is True

    network_log_text = read_jsonl_text_after_flush(tmp_path / "net.jsonl")
    assert "super-secret-body" not in network_log_text
    network_log_entry = json.loads(network_log_text)
    assert "request_body" not in network_log_entry
    assert network_log_entry["request_body_truncated"] is True
    assert network_log_entry["firewall_error"] == "auth_base_request_body_too_large"

    proxy_log_text = read_jsonl_text_after_flush(tmp_path / "proxy.jsonl")
    assert "super-secret-body" not in proxy_log_text


async def test_auth_base_requestheaders_rejects_oversized_content_length_before_auth(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_auth_base_firewall_registry(
        tmp_path,
        auth_config={
            "headers": {"Authorization": "Bearer ${{ secrets.WEBHOOK_TOKEN }}"},
            "base": "${{ secrets.WEBHOOK_URL }}",
        },
        sandbox_fields={"captureNetworkBodies": True},
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="placeholder.example.com",
        method="POST",
        path="/",
        request_headers=headers(
            ("Host", "placeholder.example.com"),
            ("Content-Type", "application/json"),
            ("Content-Length", str(auth.MAX_AUTH_BASE_REQUEST_BODY_BYTES + 1)),
        ),
    )
    get_headers = AsyncMock()

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        mitm_addon.requestheaders(flow)
        await mitm_addon.request(flow)
        mitm_addon.error(flow)

    get_headers.assert_not_called()
    assert flow.response is None
    assert flow.error is not None
    assert flow.error.msg == Error.KILLED_MESSAGE
    assert flow.live is False
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "auth_base_request_body_too_large"
    assert flow.server_conn.id in upstream_destination_binding.binding_snapshot_for_tests()

    network_log_text = read_jsonl_text_after_flush(tmp_path / "net.jsonl")
    network_log_entry = json.loads(network_log_text)
    assert network_log_entry["error"] == Error.KILLED_MESSAGE
    assert network_log_entry["request_size"] == 0
    assert "request_body" not in network_log_entry
    assert network_log_entry["firewall_error"] == "auth_base_request_body_too_large"

    proxy_log_text = read_jsonl_text_after_flush(tmp_path / "proxy.jsonl")
    assert "auth.base request body too large" in proxy_log_text


async def test_auth_base_requestheaders_rejects_saturated_admission_before_auth(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_auth_base_firewall_registry(
        tmp_path,
        sandbox_fields={"captureNetworkBodies": True},
    )
    declared_size = mitm_addon.STREAM_BUFFER_LIMIT + 1
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="placeholder.example.com",
        method="POST",
        path="/",
        request_headers=headers(
            ("Host", "placeholder.example.com"),
            ("Content-Type", "application/json"),
            ("Content-Length", str(declared_size)),
        ),
    )
    get_headers = AsyncMock()

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        patch.object(
            auth_base_forwarder,
            "MAX_ADMITTED_AUTH_BASE_REQUEST_BODY_BYTES",
            declared_size - 1,
        ),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        mitm_addon.requestheaders(flow)
        await mitm_addon.request(flow)
        mitm_addon.error(flow)

    get_headers.assert_not_called()
    assert flow.response is None
    assert flow.error is not None
    assert flow.error.msg == Error.KILLED_MESSAGE
    assert flow.live is False
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == auth.AUTH_BASE_FORWARDING_SATURATED_ERROR
    assert flow.metadata[metadata_keys.SUPPRESS_REQUEST_BODY_CAPTURE] is True
    assert metadata_keys.AUTH_BASE_FORWARD_ADMISSION not in flow.metadata
    assert auth_base_forwarder.forward_request_admission_state_for_tests() == (0, 0)

    network_log_text = read_jsonl_text_after_flush(tmp_path / "net.jsonl")
    network_log_entry = json.loads(network_log_text)
    assert network_log_entry["error"] == Error.KILLED_MESSAGE
    assert network_log_entry["request_size"] == 0
    assert "request_body" not in network_log_entry
    assert network_log_entry["firewall_error"] == auth.AUTH_BASE_FORWARDING_SATURATED_ERROR


def test_auth_base_requestheaders_releases_new_admission_after_attach_failure(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_auth_base_firewall_registry(tmp_path)
    declared_size = mitm_addon.STREAM_BUFFER_LIMIT + 1
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="placeholder.example.com",
        method="POST",
        path="/",
        request_headers=headers(
            ("Host", "placeholder.example.com"),
            ("Content-Length", str(declared_size)),
        ),
    )
    original_admission = auth_base_forwarder.reserve_forward_request_admission(4)
    auth_base_forwarder.attach_forward_request_admission_to_flow(flow, original_admission)

    try:
        with (
            mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
            pytest.raises(RuntimeError, match="already attached"),
        ):
            mitm_addon.requestheaders(flow)

        assert flow.metadata[metadata_keys.AUTH_BASE_FORWARD_ADMISSION] is original_admission
        assert auth_base_forwarder.forward_request_admission_state_for_tests() == (1, 4)
    finally:
        auth_base_forwarder.release_forward_request_admission_from_flow(flow)

    assert metadata_keys.AUTH_BASE_FORWARD_ADMISSION not in flow.metadata
    assert auth_base_forwarder.forward_request_admission_state_for_tests() == (0, 0)


@pytest.mark.parametrize(
    "method",
    ["GET", "HEAD", "POST", "PUT", "PATCH", "OPTIONS", "TRACE"],
)
async def test_auth_base_requestheaders_rejects_missing_content_length(
    tmp_path, real_flow, mitm_ctx, headers, method
):
    reg_path = _write_auth_base_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="placeholder.example.com",
        method=method,
        path="/",
        request_headers=headers(
            ("Host", "placeholder.example.com"),
        ),
    )
    get_headers = AsyncMock()

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        mitm_addon.requestheaders(flow)
        await mitm_addon.request(flow)

    get_headers.assert_not_called()
    assert flow.response is None
    assert flow.error is not None
    assert flow.error.msg == Error.KILLED_MESSAGE
    assert flow.live is False
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == ("auth_base_request_body_length_required")


@pytest.mark.parametrize(
    "framing_case",
    buffered_auth_body_framing_rejection_cases(
        max_body_bytes=auth_base_forwarder.MAX_AUTH_BASE_REQUEST_BODY_BYTES
    ),
    ids=buffered_auth_body_framing_case_id,
)
async def test_auth_base_requestheaders_rejects_shared_body_framing(
    tmp_path,
    real_flow,
    mitm_ctx,
    headers,
    framing_case: BufferedAuthBodyFramingRejectionCase,
):
    reg_path = _write_auth_base_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="placeholder.example.com",
        method="POST",
        path="/",
        request_headers=headers(
            ("Host", "placeholder.example.com"),
            *framing_case.header_pairs,
        ),
    )
    get_headers = AsyncMock()

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        mitm_addon.requestheaders(flow)
        await mitm_addon.request(flow)

    expected_error = (
        "auth_base_request_body_too_large"
        if framing_case.kind == "too_large"
        else "auth_base_request_body_length_required"
    )
    get_headers.assert_not_called()
    assert flow.response is None
    assert flow.error is not None
    assert flow.error.msg == Error.KILLED_MESSAGE
    assert flow.live is False
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == expected_error


async def test_browser_auth_base_requestheaders_skips_body_framing_rejection(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_auth_base_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="placeholder.example.com",
        method="POST",
        path="/",
        request_headers=headers(
            ("Host", "placeholder.example.com"),
            ("User-Agent", _BROWSER_USER_AGENT),
        ),
    )
    get_headers = AsyncMock()

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        mitm_addon.requestheaders(flow)
        await mitm_addon.request(flow)

    get_headers.assert_not_called()
    assert flow.response is None
    assert flow.error is None
    assert flow.live is True
    assert metadata_keys.FIREWALL_ERROR not in flow.metadata
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata[metadata_keys.FIREWALL_BILLABLE] is False
    assert metadata_keys.FIREWALL_BASE not in flow.metadata
    assert metadata_keys.FIREWALL_NAME not in flow.metadata
    assert metadata_keys.FIREWALL_PERMISSION not in flow.metadata
    assert metadata_keys.FIREWALL_RULE_MATCH not in flow.metadata
    assert metadata_keys.FIREWALL_PARAMS not in flow.metadata
    assert metadata_keys.FIREWALL_API_ID not in flow.metadata
    assert metadata_keys.MODEL_USAGE_PROVIDER not in flow.metadata


async def test_auth_base_requestheaders_rejects_extreme_content_length_before_auth(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_auth_base_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="placeholder.example.com",
        method="POST",
        path="/",
        request_headers=headers(
            ("Host", "placeholder.example.com"),
            ("Content-Length", "9" * 5000),
        ),
    )
    get_headers = AsyncMock()

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        mitm_addon.requestheaders(flow)
        await mitm_addon.request(flow)

    get_headers.assert_not_called()
    assert flow.response is None
    assert flow.error is not None
    assert flow.error.msg == Error.KILLED_MESSAGE
    assert flow.live is False
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "auth_base_request_body_too_large"


async def test_auth_base_requestheaders_accepts_matching_duplicate_content_length(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_auth_base_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="placeholder.example.com",
        method="POST",
        path="/",
        request_headers=headers(
            ("Host", "placeholder.example.com"),
            ("Content-Length", "4"),
            ("Content-Length", "4"),
        ),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.requestheaders(flow)

    assert flow.response is None
    assert flow.error is None
    assert flow.live is True
    assert metadata_keys.FIREWALL_ERROR not in flow.metadata


async def test_requestheaders_skips_registry_for_bounded_body_headers(real_flow, headers):
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="placeholder.example.com",
        method="POST",
        path="/",
        request_headers=headers(
            ("Host", "placeholder.example.com"),
            ("Content-Length", "4"),
        ),
    )

    mitm_addon.requestheaders(flow)

    assert flow.response is None
    assert metadata_keys.SANDBOX_RUN_ID not in flow.metadata
    assert metadata_keys.ORIGINAL_URL not in flow.metadata


async def test_auth_base_requestheaders_accepts_body_at_limit(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_auth_base_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="placeholder.example.com",
        method="POST",
        path="/",
        request_headers=headers(
            ("Host", "placeholder.example.com"),
            ("Content-Length", str(auth.MAX_AUTH_BASE_REQUEST_BODY_BYTES)),
        ),
        request_body=b"ok",
    )
    token_meta = firewall_auth_response(
        headers={},
        base="https://real.example.com/webhook",
        resolved_secrets=["WEBHOOK_URL"],
    )
    mock_forward = AsyncMock(return_value=(200, b"ok", {}))

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
        patch.object(auth, "forward_request", mock_forward),
    ):
        mitm_addon.requestheaders(flow)
        assert flow.response is None
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 200
    assert mock_forward.call_args is not None
    assert mock_forward.call_args[0][3] == b"ok"


async def test_auth_base_requestheaders_admission_released_after_success(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_auth_base_firewall_registry(
        tmp_path,
        auth_config={
            "headers": {"Authorization": "Bearer ${{ secrets.WEBHOOK_TOKEN }}"},
            "base": "${{ secrets.WEBHOOK_URL }}",
        },
    )
    request_body = b"x" * (mitm_addon.STREAM_BUFFER_LIMIT + 1)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="placeholder.example.com",
        method="POST",
        path="/",
        request_headers=headers(
            ("Host", "placeholder.example.com"),
            ("Content-Length", str(len(request_body))),
        ),
        request_body=request_body,
    )
    token_meta = firewall_auth_response(
        headers={"Authorization": "Bearer resolved"},
        base="https://real.example.com/webhook",
        resolved_secrets=["WEBHOOK_URL"],
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
        fake_forwarder_upstream(status=202, body=b"accepted"),
    ):
        mitm_addon.requestheaders(flow)
        assert auth_base_forwarder.forward_request_admission_state_for_tests() == (
            1,
            len(request_body),
        )
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 202
    assert flow.response.content == b"accepted"
    assert flow.server_conn.id in upstream_destination_binding.binding_snapshot_for_tests()
    assert auth_base_forwarder.forward_request_admission_state_for_tests() == (0, 0)


async def test_auth_base_buffered_request_revalidates_registry_before_auth(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_auth_base_firewall_registry(tmp_path)
    declared_size = mitm_addon.STREAM_BUFFER_LIMIT + 1
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="placeholder.example.com",
        method="POST",
        path="/",
        request_headers=headers(
            ("Host", "placeholder.example.com"),
            ("X-Client", "original"),
            ("Content-Length", str(declared_size)),
        ),
        request_body=b"body",
    )
    original_headers = tuple(flow.request.headers.fields)
    get_headers = AsyncMock()

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        assert mitm_addon.requestheaders(flow) is None
        assert auth_base_forwarder.forward_request_admission_state_for_tests() == (
            1,
            declared_size,
        )
        assert request_classification.REQUEST_CLASSIFICATION_METADATA_KEY not in flow.metadata

        reg_path.unlink()
        await mitm_addon.request(flow)

    get_headers.assert_not_awaited()
    assert flow.response is not None
    assert flow.response.status_code == 503
    assert json.loads(flow.response.content)["error"] == "registry_unavailable"
    assert tuple(flow.request.headers.fields) == original_headers
    assert auth_base_forwarder.forward_request_admission_state_for_tests() == (0, 0)


async def test_auth_base_requestheaders_admission_released_on_auth_failure(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_auth_base_firewall_registry(tmp_path)
    declared_size = mitm_addon.STREAM_BUFFER_LIMIT + 1
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="placeholder.example.com",
        method="POST",
        path="/",
        request_headers=headers(
            ("Host", "placeholder.example.com"),
            ("Content-Length", str(declared_size)),
        ),
        request_body=b"ok",
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        patch.object(
            auth,
            "get_firewall_headers",
            AsyncMock(side_effect=RuntimeError("auth service unavailable")),
        ),
    ):
        mitm_addon.requestheaders(flow)
        assert auth_base_forwarder.forward_request_admission_state_for_tests() == (
            1,
            declared_size,
        )
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 502
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "auth_failed"
    assert auth_base_forwarder.forward_request_admission_state_for_tests() == (0, 0)


async def test_auth_base_requestheaders_admission_released_when_resolved_base_missing(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_auth_base_firewall_registry(
        tmp_path,
        auth_config={
            "headers": {"Authorization": "Bearer ${{ secrets.TOKEN }}"},
            "base": "${{ secrets.WEBHOOK_URL }}",
        },
    )
    declared_size = mitm_addon.STREAM_BUFFER_LIMIT + 1
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="placeholder.example.com",
        method="POST",
        path="/",
        request_headers=headers(
            ("Host", "placeholder.example.com"),
            ("Content-Length", str(declared_size)),
        ),
        request_body=b"ok",
    )
    token_meta = firewall_auth_response(
        headers={"Authorization": "Bearer resolved"},
        resolved_secrets=["WEBHOOK_URL"],
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
    ):
        mitm_addon.requestheaders(flow)
        assert auth_base_forwarder.forward_request_admission_state_for_tests() == (
            1,
            declared_size,
        )
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 502
    assert json.loads(flow.response.content)["error"] == "auth_failed"
    assert "Authorization" not in flow.request.headers
    assert metadata_keys.AUTH_BASE_FORWARD_ADMISSION not in flow.metadata
    assert auth_base_forwarder.forward_request_admission_state_for_tests() == (0, 0)


@pytest.mark.parametrize("nominate_content_type", [False, True], ids=["ordinary", "nominated"])
async def test_auth_base_duplicate_content_type_releases_requestheaders_admission(
    tmp_path, real_flow, mitm_ctx, headers, nominate_content_type
):
    reg_path = _write_auth_base_firewall_registry(tmp_path)
    declared_size = mitm_addon.STREAM_BUFFER_LIMIT + 1
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="placeholder.example.com",
        method="POST",
        path="/",
        request_headers=headers(
            ("Host", "placeholder.example.com"),
            ("Content-Length", str(declared_size)),
            ("Content-Type", "application/json"),
            ("content-type", "text/plain"),
        ),
        request_body=b"ok",
    )
    flow.request.headers.fields += (
        (b"X-Discard-Me", UnconvertedHeaderValue(b"x" * (1024 * 1024))),
        (b"Connection", b"CoNtEnT-TyPe" if nominate_content_type else b"X-Discard-Me"),
    )
    get_headers = AsyncMock()
    mock_forward = AsyncMock()

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
        patch.object(auth, "forward_request", mock_forward),
    ):
        mitm_addon.requestheaders(flow)
        assert auth_base_forwarder.forward_request_admission_state_for_tests() == (
            1,
            declared_size,
        )
        await mitm_addon.request(flow)

    get_headers.assert_not_called()
    mock_forward.assert_not_called()
    assert flow.response is not None
    assert flow.response.status_code == 400
    assert json.loads(flow.response.content)["error"] == ("invalid_auth_base_request_headers")
    assert metadata_keys.AUTH_BASE_FORWARD_ADMISSION not in flow.metadata
    assert auth_base_forwarder.forward_request_admission_state_for_tests() == (0, 0)


@pytest.mark.parametrize(
    "nominations",
    [(), (b"CoNtEnT-TyPe",), (b"CONTENT-encoding",), (b"content-type", b"content-encoding")],
    ids=["none", "content-type", "content-encoding", "both-repeated-connection"],
)
async def test_auth_base_hooks_skip_discarded_values_and_forward_representation_headers(
    tmp_path, real_flow, mitm_ctx, headers, nominations
):
    reg_path = _write_auth_base_firewall_registry(
        tmp_path,
        auth_config={
            "headers": {"Authorization": "Bearer ${{ secrets.WEBHOOK_TOKEN }}"},
            "base": "${{ secrets.WEBHOOK_URL }}",
        },
    )
    request_body = b'{"message":"hello"}'
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="placeholder.example.com",
        method="POST",
        request_headers=headers(
            ("Host", "placeholder.example.com"),
            ("Content-Length", str(len(request_body))),
            ("cOnTeNt-TyPe", "application/json; charset=utf-8"),
            ("Content-Encoding", "identity"),
        ),
        request_body=request_body,
    )
    ignored_value = UnconvertedHeaderValue(b"x" * (1024 * 1024))
    flow.request.headers.fields += (
        (b"X-Discard-Me", ignored_value),
        (b"x-dIsCaRd-Me", ignored_value),
        (b"X-Discard-Me", ignored_value),
        *((b"cOnNeCtIoN", value) for value in nominations),
    )
    token_meta = firewall_auth_response(
        headers={"Authorization": "Bearer resolved"},
        base="https://real.example.com/webhook",
        resolved_secrets=["WEBHOOK_URL"],
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
        fake_forwarder_upstream(status=202, body=b"accepted") as upstream,
    ):
        mitm_addon.requestheaders(flow)
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 202
    assert flow.response.content == b"accepted"
    nominated_names = {name.lower() for name in nominations}
    assert upstream.socket.request_header_values("Content-Type") == (
        [] if b"content-type" in nominated_names else ["application/json; charset=utf-8"]
    )
    assert upstream.socket.request_header_values("Content-Encoding") == (
        [] if b"content-encoding" in nominated_names else ["identity"]
    )
    assert upstream.socket.request_header_values("Authorization") == ["Bearer resolved"]
    assert upstream.socket.request_header_values("X-Discard-Me") == []
    assert upstream.socket.request_header_values("Connection") == []
    assert bytes(upstream.socket.sent).endswith(b"\r\n\r\n" + request_body)
    assert metadata_keys.AUTH_BASE_FORWARD_ADMISSION not in flow.metadata
    assert auth_base_forwarder.forward_request_admission_state_for_tests() == (0, 0)


async def test_auth_base_requestheaders_admission_released_when_request_already_has_response(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_auth_base_firewall_registry(
        tmp_path,
        auth_config={
            "headers": {"Authorization": "Bearer ${{ secrets.WEBHOOK_TOKEN }}"},
            "base": "${{ secrets.WEBHOOK_URL }}",
        },
    )
    declared_size = mitm_addon.STREAM_BUFFER_LIMIT + 1
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="placeholder.example.com",
        method="POST",
        path="/",
        request_headers=headers(
            ("Host", "placeholder.example.com"),
            ("Content-Length", str(declared_size)),
        ),
        request_body=b"ok",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.requestheaders(flow)
        assert auth_base_forwarder.forward_request_admission_state_for_tests() == (
            1,
            declared_size,
        )
        flow.response = http.Response.make(204)
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 204
    assert metadata_keys.AUTH_BASE_FORWARD_ADMISSION not in flow.metadata
    assert flow.server_conn.id in upstream_destination_binding.binding_snapshot_for_tests()
    assert auth_base_forwarder.forward_request_admission_state_for_tests() == (0, 0)
