"""AWS credential transitions through the production request hooks."""

import hashlib
from pathlib import Path

import pytest
from mitmproxy import http

import mitm_addon
from tests.auth_endpoint_helpers import FakeAuthEndpoint
from tests.aws_sigv4_helpers import (
    RESOLVED_AWS_ACCESS_KEY_ID,
    RESOLVED_AWS_SESSION_TOKEN,
    STS_FORM_BODY,
    STS_HOST,
    aws_credential_scope,
    aws_sigv4_authorization,
    aws_sigv4_header_auth_headers,
)
from tests.firewall_aws_sigv4_helpers import aws_api_entry, aws_auth_response
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry
from tests.requestheaders_helpers import await_requestheaders_result


def _write_aws_registry(tmp_path: Path, *, resolved_session_token: bool) -> Path:
    api_entry: dict[str, object] = dict(aws_api_entry(include_session_token=resolved_session_token))
    api_entry["permissions"] = [{"name": "identity", "rules": ["POST /"]}]
    return _write_registry(
        tmp_path,
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


def _header_auth_flow(
    real_flow,
    headers,
    *,
    source_session_token: bool,
    explicit_payload_hash: bool,
) -> http.HTTPFlow:
    signed_headers = ["content-type", "host", "x-amz-date"]
    extra_headers = [("Content-Length", str(len(STS_FORM_BODY)))]
    if source_session_token:
        signed_headers.append("x-amz-security-token")
        extra_headers.append(("X-Amz-Security-Token", "placeholder-session-token"))
    if explicit_payload_hash:
        signed_headers.append("x-amz-content-sha256")
        extra_headers.append(("X-Amz-Content-Sha256", hashlib.sha256(STS_FORM_BODY).hexdigest()))
    return real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host=STS_HOST,
        path="/",
        method="POST",
        request_headers=headers(
            *aws_sigv4_header_auth_headers(
                content_type="application/x-www-form-urlencoded",
                authorization=aws_sigv4_authorization(
                    signed_headers=";".join(sorted(signed_headers)),
                ),
                extra_headers=extra_headers,
            )
        ),
    )


@pytest.mark.parametrize(
    "source_session_token", [False, True], ids=["source-keys", "source-session"]
)
@pytest.mark.parametrize(
    (
        "explicit_payload_hash",
        "resolved_session_token",
        "expected_signed_headers",
        "expected_signature",
    ),
    [
        pytest.param(
            False,
            False,
            "content-type;host;x-amz-date",
            "197db8074db52404d6af8ed7c6a21e045c08961aba4c8221d7f940d85ed08620",
            id="buffered-resolved-keys",
        ),
        pytest.param(
            False,
            True,
            "content-type;host;x-amz-date;x-amz-security-token",
            "1735aaa47d56839a3157c545e28e02eb8fa1526da431e9fc980b7414df9c4f53",
            id="buffered-resolved-session",
        ),
        pytest.param(
            True,
            False,
            "content-type;host;x-amz-content-sha256;x-amz-date",
            "f2d7322d26276071ed0c5c96d797945e52eb2e08140f40d21452f76dccb18890",
            id="streaming-resolved-keys",
        ),
        pytest.param(
            True,
            True,
            "content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token",
            "9f5784aa42a96cf5909802941fa083c9cd8e088f6c21a40a666b8a9dfc18abf4",
            id="streaming-resolved-session",
        ),
    ],
)
async def test_header_sigv4_session_token_follows_resolved_credentials(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
    source_session_token: bool,
    explicit_payload_hash: bool,
    resolved_session_token: bool,
    expected_signed_headers: str,
    expected_signature: str,
) -> None:
    registry_path = _write_aws_registry(tmp_path, resolved_session_token=resolved_session_token)
    flow = _header_auth_flow(
        real_flow,
        headers,
        source_session_token=source_session_token,
        explicit_payload_hash=explicit_payload_hash,
    )
    endpoint = FakeAuthEndpoint()
    endpoint.queue_json_response(aws_auth_response(include_session_token=resolved_session_token))
    # Fixed vectors were calculated independently with SHA-256/HMAC, without the production signer.
    expected_authorization = (
        "AWS4-HMAC-SHA256 "
        f"Credential={aws_credential_scope(access_key_id=RESOLVED_AWS_ACCESS_KEY_ID)}, "
        f"SignedHeaders={expected_signed_headers}, Signature={expected_signature}"
    )

    with endpoint.run(), mitm_ctx(registry_path=str(registry_path), api_url=endpoint.api_url):
        requestheaders_result = mitm_addon.requestheaders(flow)
        if explicit_payload_hash:
            await await_requestheaders_result(requestheaders_result)
        else:
            assert requestheaders_result is None
        assert flow.response is None
        if explicit_payload_hash:
            assert flow.request.headers["authorization"] == expected_authorization
            assert callable(flow.request.stream)
            assert flow.request.stream(STS_FORM_BODY) == STS_FORM_BODY
            assert flow.request.stream(b"") == b""
        else:
            assert flow.request.stream is False
            flow.request.raw_content = STS_FORM_BODY

        await mitm_addon.request(flow)

        assert flow.response is None
        assert flow.request.headers["authorization"] == expected_authorization
        if resolved_session_token:
            assert flow.request.headers.get_all("x-amz-security-token") == [
                RESOLVED_AWS_SESSION_TOKEN
            ]
        else:
            assert "x-amz-security-token" not in flow.request.headers
        assert flow.request.url == f"https://{STS_HOST}/"
        if not explicit_payload_hash:
            assert flow.request.raw_content == STS_FORM_BODY
        assert len(endpoint.requests) == 1

        flow.response = http.Response.make(200, b"ok")
        mitm_addon.response(flow)


@pytest.mark.parametrize("explicit_payload_hash", [False, True], ids=["buffered", "streaming"])
async def test_header_sigv4_missing_unrelated_signed_header_fails_closed(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
    explicit_payload_hash: bool,
) -> None:
    registry_path = _write_aws_registry(tmp_path, resolved_session_token=False)
    flow = _header_auth_flow(
        real_flow,
        headers,
        source_session_token=True,
        explicit_payload_hash=explicit_payload_hash,
    )
    del flow.request.headers["content-type"]
    endpoint = FakeAuthEndpoint()
    endpoint.queue_json_response(aws_auth_response(include_session_token=False))

    with endpoint.run(), mitm_ctx(registry_path=str(registry_path), api_url=endpoint.api_url):
        requestheaders_result = mitm_addon.requestheaders(flow)
        if explicit_payload_hash:
            await await_requestheaders_result(requestheaders_result)
        else:
            assert requestheaders_result is None
        flow.request.raw_content = STS_FORM_BODY
        await mitm_addon.request(flow)

        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.response.json()["error"] == "aws_sigv4_auth_failed"
        assert flow.response.json()["message"] == "AWS signed header is missing"
        assert len(endpoint.requests) == 1
