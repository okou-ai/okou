"""Body-dependent AWS permissions must reserve capacity before buffering."""

import asyncio
import json
from unittest.mock import AsyncMock, patch

import pytest
from mitmproxy import http
from mitmproxy.flow import Error

import auth
import aws_sigv4_body_admission
import flow_metadata_keys as metadata_keys
import mitm_addon
import request_classification
from tests.aws_sigv4_helpers import (
    RESOLVED_AWS_ACCESS_KEY_ID,
    STS_FORM_BODY,
    STS_HOST,
    aws_sigv4_header_auth_headers,
    resolved_aws_sigv4_credentials,
)
from tests.firewall_auth_helpers import firewall_auth_response
from tests.firewall_aws_sigv4_helpers import aws_api_entry
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry


def _registry(tmp_path, *, unknown_policy="deny"):
    api = dict(aws_api_entry())
    api["permissions"] = [
        {"name": "identity", "rules": ["POST / AWS sigv4=sts action=GetCallerIdentity"]}
    ]
    return _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            firewall_name="aws",
            api_entry=api,
            network_policy={
                "allow": ["identity"],
                "deny": [],
                "ask": [],
                "unknownPolicy": unknown_policy,
            },
        ),
    )


def _flow(real_flow, headers, *, size=None):
    return real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host=STS_HOST,
        method="POST",
        path="/",
        request_body=None,
        request_headers=headers(
            *aws_sigv4_header_auth_headers(
                content_type="application/x-www-form-urlencoded",
                extra_headers=(
                    ("Content-Length", str(len(STS_FORM_BODY) if size is None else size)),
                ),
            )
        ),
    )


@pytest.mark.parametrize("unknown_policy", ["deny", "ask"])
@pytest.mark.parametrize("terminal", ["response", "error"])
async def test_pending_action_reserves_before_body_and_signs_after_permission_check(
    tmp_path, real_flow, headers, mitm_ctx, unknown_policy, terminal
):
    registry_path = _registry(tmp_path, unknown_policy=unknown_policy)
    flow = _flow(real_flow, headers)
    get_headers = AsyncMock(
        return_value=firewall_auth_response(headers={}, aws_sigv4=resolved_aws_sigv4_credentials())
    )

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        assert flow.request.raw_content is None
        assert mitm_addon.requestheaders(flow) is None
        assert flow.response is None
        assert flow.error is None
        assert not flow.request.stream
        assert request_classification.cached_classification(flow) is None
        assert aws_sigv4_body_admission.state_for_tests() == (1, len(STS_FORM_BODY))
        get_headers.assert_not_awaited()

        flow.request.raw_content = STS_FORM_BODY
        await mitm_addon.request(flow)

        assert flow.response is None
        assert flow.metadata[metadata_keys.FIREWALL_PERMISSION] == "identity"
        assert f"Credential={RESOLVED_AWS_ACCESS_KEY_ID}/" in flow.request.headers["authorization"]
        assert aws_sigv4_body_admission.state_for_tests() == (1, len(STS_FORM_BODY))
        if terminal == "response":
            flow.response = http.Response.make(200, b"ok")
            mitm_addon.response(flow)
        else:
            flow.error = Error("connection closed")
            mitm_addon.error(flow)

    get_headers.assert_awaited_once()
    assert aws_sigv4_body_admission.state_for_tests() == (0, 0)


@pytest.mark.parametrize(
    ("limit_name", "limit"),
    [
        ("MAX_ADMITTED_AWS_SIGV4_REQUESTS", 1),
        ("MAX_ADMITTED_AWS_SIGV4_REQUEST_BODY_BYTES", len(STS_FORM_BODY)),
    ],
    ids=["count", "bytes"],
)
async def test_pending_action_rejects_exhausted_capacity_before_buffering(
    tmp_path, real_flow, headers, mitm_ctx, monkeypatch, limit_name, limit
):
    registry_path = _registry(tmp_path)
    admitted = _flow(real_flow, headers)
    rejected = _flow(real_flow, headers)
    get_headers = AsyncMock()
    monkeypatch.setattr(aws_sigv4_body_admission, limit_name, limit)

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        assert mitm_addon.requestheaders(admitted) is None
        assert aws_sigv4_body_admission.state_for_tests() == (1, len(STS_FORM_BODY))
        assert mitm_addon.requestheaders(rejected) is None
        assert rejected.error is not None
        assert rejected.request.raw_content is None
        assert rejected.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"
        assert rejected.metadata[metadata_keys.FIREWALL_ERROR] == (
            auth.AWS_SIGV4_REQUEST_BODY_ADMISSION_SATURATED_ERROR
        )
        rejected.request.raw_content = STS_FORM_BODY
        await mitm_addon.request(rejected)
        assert aws_sigv4_body_admission.state_for_tests() == (1, len(STS_FORM_BODY))
        admitted.error = Error("upload disconnected")
        mitm_addon.error(admitted)

    get_headers.assert_not_awaited()
    assert aws_sigv4_body_admission.state_for_tests() == (0, 0)


@pytest.mark.parametrize(
    "body",
    [
        b"Action=DeleteIdentity",
        b"Action=GetCallerIdentity&Action=DeleteIdentity",
        b"Action=\xff",
        STS_FORM_BODY + b"&Padding=" + b"x" * (64 * 1024),
    ],
    ids=["unallowed-action", "ambiguous-action", "invalid-utf8", "oversized-form"],
)
async def test_pending_action_checks_completed_body_and_releases_denied_capacity(
    tmp_path, real_flow, headers, mitm_ctx, body
):
    registry_path = _registry(tmp_path)
    flow = _flow(real_flow, headers, size=len(body))
    authorization = flow.request.headers["authorization"]
    get_headers = AsyncMock()

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        assert mitm_addon.requestheaders(flow) is None
        assert aws_sigv4_body_admission.state_for_tests() == (1, len(body))
        flow.request.raw_content = body
        await mitm_addon.request(flow)
        assert flow.response is not None
        assert flow.response.status_code == 403
        assert flow.response.json()["reason"] == "unknown_endpoint"
        assert flow.request.headers["authorization"] == authorization
        mitm_addon.response(flow)

    get_headers.assert_not_awaited()
    assert aws_sigv4_body_admission.state_for_tests() == (0, 0)


@pytest.mark.parametrize(
    ("name", "value", "expected_error"),
    [
        ("Content-Length", None, auth.AWS_SIGV4_REQUEST_BODY_LENGTH_REQUIRED_ERROR),
        ("Transfer-Encoding", "chunked", auth.AWS_SIGV4_REQUEST_BODY_LENGTH_REQUIRED_ERROR),
        ("Content-Length", "invalid", auth.AWS_SIGV4_REQUEST_BODY_LENGTH_REQUIRED_ERROR),
        ("Content-Length", str(33 * 1024 * 1024), auth.AWS_SIGV4_REQUEST_BODY_TOO_LARGE_ERROR),
    ],
)
def test_pending_action_rejects_unbounded_framing_before_buffering(
    tmp_path, real_flow, headers, mitm_ctx, name, value, expected_error
):
    registry_path = _registry(tmp_path)
    flow = _flow(real_flow, headers)
    if value is None:
        del flow.request.headers[name]
    else:
        flow.request.headers[name] = value
    get_headers = AsyncMock()
    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        assert mitm_addon.requestheaders(flow) is None
    assert flow.error is not None
    assert flow.request.raw_content is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == expected_error
    get_headers.assert_not_called()
    assert aws_sigv4_body_admission.state_for_tests() == (0, 0)


async def test_pending_action_rechecks_current_policy_after_buffering(
    tmp_path, real_flow, headers, mitm_ctx
):
    registry_path = _registry(tmp_path)
    flow = _flow(real_flow, headers)
    get_headers = AsyncMock()
    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        assert mitm_addon.requestheaders(flow) is None
        assert aws_sigv4_body_admission.state_for_tests() == (1, len(STS_FORM_BODY))
        payload = json.loads(registry_path.read_text())
        policy = payload["sandboxes"]["10.200.0.5"]["networkPolicies"]["aws"]
        policy["allow"] = []
        policy["deny"] = ["identity"]
        registry_path.write_text(json.dumps(payload))
        flow.request.raw_content = STS_FORM_BODY
        await mitm_addon.request(flow)
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.response.json()["reason"] == "permission_denied"
    get_headers.assert_not_awaited()
    assert aws_sigv4_body_admission.state_for_tests() == (0, 0)


async def test_pending_action_cancellation_releases_capacity(
    tmp_path, real_flow, headers, mitm_ctx
):
    registry_path = _registry(tmp_path)
    flow = _flow(real_flow, headers)
    get_headers = AsyncMock(side_effect=asyncio.CancelledError)
    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        assert mitm_addon.requestheaders(flow) is None
        assert aws_sigv4_body_admission.state_for_tests() == (1, len(STS_FORM_BODY))
        flow.request.raw_content = STS_FORM_BODY
        with pytest.raises(asyncio.CancelledError):
            await mitm_addon.request(flow)
    assert RESOLVED_AWS_ACCESS_KEY_ID not in flow.request.headers["authorization"]
    assert aws_sigv4_body_admission.state_for_tests() == (0, 0)


async def test_payload_dependent_signing_without_admission_fails_before_credentials_or_hash(
    tmp_path, real_flow, headers, mitm_ctx
):
    registry_path = _registry(tmp_path)
    flow = _flow(real_flow, headers)
    flow.request.raw_content = STS_FORM_BODY
    authorization = flow.request.headers["authorization"]
    get_headers = AsyncMock()
    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
        patch.object(auth, "hash_request_body", side_effect=AssertionError("unadmitted hash")),
        pytest.raises(RuntimeError, match="admission is missing"),
    ):
        await mitm_addon.request(flow)
    assert flow.response is not None
    assert flow.response.status_code == 500
    assert flow.request.headers["authorization"] == authorization
    get_headers.assert_not_awaited()
    assert aws_sigv4_body_admission.state_for_tests() == (0, 0)
