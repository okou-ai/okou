"""Firewall AWS SigV4 auth re-signing tests."""

import urllib.parse

import pytest

import auth
import flow_metadata_keys as metadata_keys
from tests.auth_endpoint_helpers import FakeAuthEndpoint
from tests.aws_sigv4_helpers import (
    DEFAULT_SIGV4_TIMESTAMP,
    RESOLVED_AWS_ACCESS_KEY_ID,
    RESOLVED_AWS_SESSION_TOKEN,
    STS_FORM_BODY,
    STS_HOST,
    STS_QUERY,
    aws_credential_scope,
    aws_sigv4_authorization,
    aws_sigv4_header_auth_headers,
    aws_sigv4_presigned_query_path,
    quote_sigv4_value,
    resolved_aws_sigv4_credentials,
)
from tests.firewall_auth_helpers import handle_firewall_request_without_upstream_admission
from tests.firewall_aws_sigv4_helpers import (
    FAR_FUTURE_EXPIRES_AT,
    assert_sigv4_failed_closed,
    aws_allow,
    aws_api_entry,
    aws_auth_response,
    aws_sandbox_info,
    cache_aws_sigv4_credentials,
    handle_firewall_request_with_auth_endpoint,
    make_sts_header_sigv4_flow,
    make_sts_query_sigv4_flow,
    prepare_firewall_request,
)


async def test_re_signs_header_sigv4_request(real_flow, headers, tmp_path, mitm_ctx):
    endpoint = FakeAuthEndpoint()
    flow = real_flow(
        with_response=False,
        host=STS_HOST,
        path="/",
        method="POST",
        request_body=STS_FORM_BODY,
        request_headers=headers(
            *aws_sigv4_header_auth_headers(
                content_type="application/x-www-form-urlencoded",
                authorization=aws_sigv4_authorization(
                    signed_headers="content-type;host;x-amz-date"
                ),
            ),
        ),
    )

    result = await handle_firewall_request_with_auth_endpoint(
        flow,
        tmp_path,
        mitm_ctx,
        endpoint=endpoint,
    )

    assert result is auth.FirewallAuthHandlingResult.CONTINUE_UPSTREAM
    assert flow.response is None
    authorization = flow.request.headers["authorization"]
    assert authorization.startswith("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/")
    assert "PLACEHOLDER" not in authorization
    assert "Signature=placeholder" not in authorization
    assert flow.request.headers["x-amz-security-token"] == RESOLVED_AWS_SESSION_TOKEN
    assert flow.metadata[metadata_keys.AUTH_RESOLVED_SECRETS] == [
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
    ]

    body = endpoint.requests[0].json_body()
    assert body["authAwsSigv4"] == aws_api_entry()["auth"]["awsSigv4"]


async def test_re_signs_header_sigv4_request_to_reference_signature(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    auth_response = aws_auth_response(include_session_token=False)
    api_entry = aws_api_entry(base="https://iam.amazonaws.com", include_session_token=False)
    flow = real_flow(
        with_response=False,
        host="iam.amazonaws.com",
        path="/?Action=ListUsers&Version=2010-05-08",
        method="GET",
        request_headers=headers(
            ("Host", "iam.amazonaws.com"),
            ("Content-Type", "application/x-www-form-urlencoded; charset=utf-8"),
            ("X-Amz-Date", "20150830T123600Z"),
            (
                "Authorization",
                aws_sigv4_authorization(
                    date="20150830",
                    service="iam",
                    signed_headers="content-type;host;x-amz-date",
                ),
            ),
        ),
    )

    result = await handle_firewall_request_with_auth_endpoint(
        flow,
        tmp_path,
        mitm_ctx,
        auth_response=auth_response,
        allow=aws_allow(api_entry, permission="list-users", rule="GET /", rel_path="/"),
    )

    assert result is auth.FirewallAuthHandlingResult.CONTINUE_UPSTREAM
    assert flow.request.headers["authorization"] == (
        "AWS4-HMAC-SHA256 "
        "Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, "
        "SignedHeaders=content-type;host;x-amz-date, "
        "Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7"
    )
    assert "x-amz-security-token" not in flow.request.headers


@pytest.mark.parametrize(
    "path",
    [
        pytest.param("/../x", id="leading-parent"),
        pytest.param("/../../x", id="multiple-leading-parents"),
        pytest.param("/a/../../x", id="over-traversal"),
    ],
)
async def test_re_signs_header_sigv4_request_with_leading_dot_segments(
    path: str,
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    auth_response = aws_auth_response(include_session_token=False)
    api_entry = aws_api_entry(base="https://iam.amazonaws.com", include_session_token=False)
    flow = real_flow(
        with_response=False,
        host="iam.amazonaws.com",
        path=path,
        method="GET",
        request_headers=headers(
            ("Host", "iam.amazonaws.com"),
            ("X-Amz-Date", "20150830T123600Z"),
            (
                "Authorization",
                aws_sigv4_authorization(
                    date="20150830",
                    service="iam",
                ),
            ),
        ),
    )

    result = await handle_firewall_request_with_auth_endpoint(
        flow,
        tmp_path,
        mitm_ctx,
        auth_response=auth_response,
        allow=aws_allow(
            api_entry,
            permission="leading-dot-segments",
            rule="GET /{path+}",
            rel_path=path,
        ),
    )

    assert result is auth.FirewallAuthHandlingResult.CONTINUE_UPSTREAM
    assert flow.response is None
    assert flow.request.url == f"https://iam.amazonaws.com{path}"
    authorization = flow.request.headers["authorization"]
    assert authorization.startswith("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/")
    assert "PLACEHOLDER" not in authorization
    assert "Signature=placeholder" not in authorization


async def test_re_signs_header_sigv4_request_with_encoded_path(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    auth_response = aws_auth_response(include_session_token=False)
    api_entry = aws_api_entry(base="https://iam.amazonaws.com", include_session_token=False)
    flow = real_flow(
        with_response=False,
        host="iam.amazonaws.com",
        path="/a/../long/path%20name/",
        method="GET",
        request_headers=headers(
            ("Host", "iam.amazonaws.com"),
            ("X-Amz-Date", "20150830T123600Z"),
            (
                "Authorization",
                aws_sigv4_authorization(
                    date="20150830",
                    service="iam",
                ),
            ),
        ),
    )

    result = await handle_firewall_request_with_auth_endpoint(
        flow,
        tmp_path,
        mitm_ctx,
        auth_response=auth_response,
        allow=aws_allow(
            api_entry,
            permission="encoded-path",
            rule="GET /{path+}",
            rel_path="/a/../long/path%20name/",
        ),
    )

    assert result is auth.FirewallAuthHandlingResult.CONTINUE_UPSTREAM
    assert flow.request.url == "https://iam.amazonaws.com/a/../long/path%20name/"
    assert flow.request.headers["authorization"] == (
        "AWS4-HMAC-SHA256 "
        "Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, "
        "SignedHeaders=host;x-amz-date, "
        "Signature=f1e30e1649dd37a25de158bbc35c722f3c513f7b1051cb50ec2d351a468824ff"
    )


async def test_re_signs_header_sigv4_request_with_normalized_host(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    auth_response = aws_auth_response(include_session_token=False)
    api_entry = aws_api_entry(base="https://iam.amazonaws.com", include_session_token=False)
    flow = real_flow(
        with_response=False,
        host="IAM.AMAZONAWS.COM",
        path="/",
        method="GET",
        request_headers=headers(
            ("Host", "IAM.AMAZONAWS.COM:443"),
            ("X-Amz-Date", "20150830T123600Z"),
            (
                "Authorization",
                aws_sigv4_authorization(
                    date="20150830",
                    service="iam",
                ),
            ),
        ),
    )

    result = await handle_firewall_request_with_auth_endpoint(
        flow,
        tmp_path,
        mitm_ctx,
        auth_response=auth_response,
        allow=aws_allow(api_entry, permission="normalized-host", rule="GET /", rel_path="/"),
    )

    assert result is auth.FirewallAuthHandlingResult.CONTINUE_UPSTREAM
    assert flow.request.headers["host"] == "iam.amazonaws.com"
    assert flow.request.headers["authorization"] == (
        "AWS4-HMAC-SHA256 "
        "Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, "
        "SignedHeaders=host;x-amz-date, "
        "Signature=91fb24346d00546d6da247c85eb79148080a6e3ae1ac9aa8eae9ccdabfd70b33"
    )


async def test_re_signs_header_sigv4_request_with_trusted_original_url(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    auth_response = aws_auth_response(include_session_token=False)
    api_entry = aws_api_entry(base="https://iam.amazonaws.com", include_session_token=False)
    flow = real_flow(
        with_response=False,
        host="203.0.113.10",
        sni="iam.amazonaws.com",
        path="/",
        method="GET",
        request_headers=headers(
            ("Host", "iam.amazonaws.com"),
            ("X-Amz-Date", "20150830T123600Z"),
            (
                "Authorization",
                aws_sigv4_authorization(
                    date="20150830",
                    service="iam",
                ),
            ),
        ),
    )
    flow.metadata[metadata_keys.TRUSTED_AUTHORITY_HOST] = "iam.amazonaws.com"

    result = await handle_firewall_request_with_auth_endpoint(
        flow,
        tmp_path,
        mitm_ctx,
        auth_response=auth_response,
        allow=aws_allow(api_entry, permission="trusted-url", rule="GET /", rel_path="/"),
    )

    assert result is auth.FirewallAuthHandlingResult.CONTINUE_UPSTREAM
    assert flow.request.url == "https://iam.amazonaws.com/"
    assert flow.request.headers["host"] == "iam.amazonaws.com"
    assert flow.request.headers["authorization"] == (
        "AWS4-HMAC-SHA256 "
        "Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, "
        "SignedHeaders=host;x-amz-date, "
        "Signature=91fb24346d00546d6da247c85eb79148080a6e3ae1ac9aa8eae9ccdabfd70b33"
    )


async def test_re_signs_header_sigv4_request_keeps_resolved_query_with_trusted_url(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    auth_response = aws_auth_response(
        include_session_token=False,
        query={"Trace": "secret-value"},
    )
    api_entry = aws_api_entry(
        base="https://iam.amazonaws.com",
        auth_query={"Trace": "${{ secrets.TRACE }}"},
        include_session_token=False,
    )
    flow = real_flow(
        with_response=False,
        host="203.0.113.10",
        sni="iam.amazonaws.com",
        path="/?Action=ListUsers&Version=2010-05-08",
        method="GET",
        request_headers=headers(
            ("Host", "iam.amazonaws.com"),
            ("Content-Type", "application/x-www-form-urlencoded; charset=utf-8"),
            ("X-Amz-Date", "20150830T123600Z"),
            (
                "Authorization",
                aws_sigv4_authorization(
                    date="20150830",
                    service="iam",
                    signed_headers="content-type;host;x-amz-date",
                ),
            ),
        ),
    )
    flow.metadata[metadata_keys.TRUSTED_AUTHORITY_HOST] = "iam.amazonaws.com"

    result = await handle_firewall_request_with_auth_endpoint(
        flow,
        tmp_path,
        mitm_ctx,
        auth_response=auth_response,
        allow=aws_allow(api_entry, permission="trusted-query", rule="GET /", rel_path="/"),
    )

    assert result is auth.FirewallAuthHandlingResult.CONTINUE_UPSTREAM
    signed_parts = urllib.parse.urlsplit(flow.request.url)
    assert signed_parts.scheme == "https"
    assert signed_parts.netloc == "iam.amazonaws.com"
    assert dict(urllib.parse.parse_qsl(signed_parts.query)) == {
        "Action": "ListUsers",
        "Version": "2010-05-08",
        "Trace": "secret-value",
    }
    assert flow.request.headers["authorization"] == (
        "AWS4-HMAC-SHA256 "
        "Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, "
        "SignedHeaders=content-type;host;x-amz-date, "
        "Signature=22a3e4709cec49fad0f5cb8eac18cb63ab08f1f90b46be84ed239a4687fdcd97"
    )


@pytest.mark.parametrize("expires", ["1", "604800"], ids=["minimum", "maximum"])
async def test_re_signs_query_sigv4_request(real_flow, tmp_path, mitm_ctx, expires):
    flow = real_flow(
        with_response=False,
        host=STS_HOST,
        path=aws_sigv4_presigned_query_path(expires=expires),
        method="GET",
    )

    result = await handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    assert result is auth.FirewallAuthHandlingResult.CONTINUE_UPSTREAM
    assert "authorization" not in flow.request.headers
    query = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(flow.request.url).query))
    assert query["X-Amz-Algorithm"] == "AWS4-HMAC-SHA256"
    assert query["X-Amz-Credential"] == "AKIDEXAMPLE/20260101/us-east-1/sts/aws4_request"
    assert query["X-Amz-Expires"] == expires
    assert query["X-Amz-Security-Token"] == RESOLVED_AWS_SESSION_TOKEN
    assert query["X-Amz-Signature"] != "placeholder"
    assert "PLACEHOLDER" not in flow.request.url


async def test_re_signs_query_sigv4_request_strips_session_token_header(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    flow = real_flow(
        with_response=False,
        host=STS_HOST,
        path=aws_sigv4_presigned_query_path(),
        method="GET",
        request_headers=headers(
            ("Host", "sts.amazonaws.com"),
            ("X-Amz-Security-Token", "placeholder-session-token"),
        ),
    )

    result = await handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    assert result is auth.FirewallAuthHandlingResult.CONTINUE_UPSTREAM
    assert "x-amz-security-token" not in flow.request.headers
    query = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(flow.request.url).query))
    assert query["X-Amz-Security-Token"] == RESOLVED_AWS_SESSION_TOKEN


async def test_re_signs_query_sigv4_request_preserves_literal_plus(
    real_flow,
    tmp_path,
    mitm_ctx,
):
    flow = real_flow(
        with_response=False,
        host=STS_HOST,
        path=aws_sigv4_presigned_query_path(
            leading_query=f"{STS_QUERY}&LiteralPlus=a+b&EncodedPlus=c%2Bd"
        ),
        method="GET",
    )

    result = await handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    assert result is auth.FirewallAuthHandlingResult.CONTINUE_UPSTREAM
    raw_query = urllib.parse.urlsplit(flow.request.url).query
    assert "LiteralPlus=a%2Bb" in raw_query
    query = dict(urllib.parse.parse_qsl(raw_query))
    assert query["LiteralPlus"] == "a+b"
    assert query["EncodedPlus"] == "c+d"


async def test_mixed_header_query_sigv4_request_fails_closed(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    authorization = aws_sigv4_authorization()
    flow = real_flow(
        with_response=False,
        host=STS_HOST,
        path=aws_sigv4_presigned_query_path(),
        method="GET",
        request_headers=headers(
            *aws_sigv4_header_auth_headers(authorization=authorization),
        ),
    )

    result = await handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    assert_sigv4_failed_closed(result, flow, "Ambiguous AWS auth location")
    assert flow.request.headers["authorization"] == authorization


async def test_sigv4a_request_fails_closed(real_flow, headers, tmp_path, mitm_ctx):
    flow = real_flow(
        with_response=False,
        host="s3.amazonaws.com",
        path="/bucket/key",
        request_headers=headers(
            ("Host", "s3.amazonaws.com"),
            ("X-Amz-Date", "20260101T000000Z"),
            (
                "Authorization",
                "AWS4-ECDSA-P256-SHA256 "
                "Credential=PLACEHOLDER/20260101/*/s3/aws4_request, "
                "SignedHeaders=host;x-amz-date, "
                "Signature=placeholder",
            ),
        ),
    )

    result = await handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    assert_sigv4_failed_closed(result, flow, "SigV4A is not supported")


async def test_hmac_sigv4_wildcard_region_fails_closed(real_flow, headers, tmp_path, mitm_ctx):
    flow = real_flow(
        with_response=False,
        host="s3.amazonaws.com",
        path="/bucket/key",
        request_headers=headers(
            ("Host", "s3.amazonaws.com"),
            ("X-Amz-Date", "20260101T000000Z"),
            (
                "Authorization",
                "AWS4-HMAC-SHA256 "
                "Credential=PLACEHOLDER/20260101/*/s3/aws4_request, "
                "SignedHeaders=host;x-amz-date, "
                "Signature=placeholder",
            ),
        ),
    )

    result = await handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    assert_sigv4_failed_closed(result, flow, "Wildcard AWS signing region requires SigV4A")


async def test_header_sigv4_with_malformed_scope_fails_closed(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    flow = make_sts_header_sigv4_flow(
        real_flow,
        headers,
        authorization=aws_sigv4_authorization(
            credential_scope="PLACEHOLDER/20260101/us-east-1%0d%0aX-Bad:x/sts/aws4_request"
        ),
    )

    result = await handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    assert_sigv4_failed_closed(result, flow, "Malformed AWS credential scope")


async def test_header_sigv4_with_control_character_header_fails_closed(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    flow = make_sts_header_sigv4_flow(
        real_flow,
        headers,
        signed_headers="host;x-amz-date;x-test",
        extra_headers=(("X-Test", "a\n b"),),
    )

    result = await handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    assert_sigv4_failed_closed(result, flow, "AWS request header contains invalid text")


async def test_header_sigv4_with_invalid_resolved_access_key_fails_closed(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    flow = make_sts_header_sigv4_flow(real_flow, headers)

    result = await handle_firewall_request_with_auth_endpoint(
        flow,
        tmp_path,
        mitm_ctx,
        auth_response=aws_auth_response(
            access_key_id="AKID/EXAMPLE",
        ),
    )

    assert_sigv4_failed_closed(result, flow, "Invalid AWS access key ID")


async def test_header_sigv4_with_empty_resolved_secret_key_fails_closed(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    allow = aws_allow()
    sandbox_info = aws_sandbox_info(tmp_path)
    flow = make_sts_header_sigv4_flow(real_flow, headers)
    prepare_firewall_request(flow, run_id=sandbox_info["runId"])
    cache_aws_sigv4_credentials(
        tmp_path,
        allow=allow,
        sandbox_info=sandbox_info,
        credentials=resolved_aws_sigv4_credentials(
            secret_access_key="",
            session_token=None,
        ),
    )

    with mitm_ctx():
        result = await handle_firewall_request_without_upstream_admission(
            flow, allow, dict(sandbox_info)
        )

    assert_sigv4_failed_closed(result, flow, "Invalid AWS secret access key")


async def test_header_sigv4_seeded_cache_matches_auth_query_identity(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    api_entry = aws_api_entry(auth_query={"trace": "${{ secrets.TRACE_ID }}"})
    allow = aws_allow(api_entry)
    sandbox_info = aws_sandbox_info(tmp_path)
    flow = make_sts_header_sigv4_flow(real_flow, headers)
    prepare_firewall_request(flow, run_id=sandbox_info["runId"])
    cache_aws_sigv4_credentials(
        tmp_path,
        allow=allow,
        sandbox_info=sandbox_info,
        credentials=resolved_aws_sigv4_credentials(session_token=None),
        query={"trace": "resolved-trace"},
    )

    with mitm_ctx():
        result = await handle_firewall_request_without_upstream_admission(
            flow,
            allow,
            dict(sandbox_info),
        )

    assert result is auth.FirewallAuthHandlingResult.CONTINUE_UPSTREAM
    assert flow.metadata[metadata_keys.AUTH_CACHE_HIT] is True
    assert flow.response is None
    assert flow.request.query["trace"] == "resolved-trace"
    assert flow.request.headers["Authorization"].startswith(
        "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/"
    )


async def test_header_sigv4_cache_miss_when_auth_query_changes(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    cached_allow = aws_allow(aws_api_entry(include_session_token=False))
    active_allow = aws_allow(
        aws_api_entry(
            auth_query={"trace": "${{ secrets.TRACE_ID }}"},
            include_session_token=False,
        )
    )
    sandbox_info = aws_sandbox_info(tmp_path)
    endpoint = FakeAuthEndpoint()
    flow = make_sts_header_sigv4_flow(real_flow, headers)
    cache_aws_sigv4_credentials(
        tmp_path,
        allow=cached_allow,
        sandbox_info=sandbox_info,
        credentials=resolved_aws_sigv4_credentials(session_token=None),
        query={"trace": "cached-trace"},
    )

    result = await handle_firewall_request_with_auth_endpoint(
        flow,
        tmp_path,
        mitm_ctx,
        endpoint=endpoint,
        auth_response=aws_auth_response(
            include_session_token=False,
            query={"trace": "fresh-trace"},
        ),
        allow=active_allow,
        sandbox_info=sandbox_info,
    )

    assert result is auth.FirewallAuthHandlingResult.CONTINUE_UPSTREAM
    assert flow.metadata[metadata_keys.AUTH_CACHE_HIT] is False
    assert len(endpoint.requests) == 1
    assert flow.request.query["trace"] == "fresh-trace"


async def test_header_sigv4_seeded_cache_matches_allow_context_identity(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    api_entry = aws_api_entry(api_id="aws-sts-api")
    allow = aws_allow(api_entry, firewall_name="custom-aws")
    sandbox_info = aws_sandbox_info(tmp_path, billable_firewalls=["custom-aws"])
    flow = make_sts_header_sigv4_flow(real_flow, headers)
    prepare_firewall_request(flow, run_id=sandbox_info["runId"])
    cache_aws_sigv4_credentials(
        tmp_path,
        allow=allow,
        sandbox_info=sandbox_info,
        credentials=resolved_aws_sigv4_credentials(session_token=None),
        expires_at=FAR_FUTURE_EXPIRES_AT,
    )

    with mitm_ctx():
        result = await handle_firewall_request_without_upstream_admission(
            flow, allow, dict(sandbox_info)
        )

    assert result is auth.FirewallAuthHandlingResult.CONTINUE_UPSTREAM
    assert flow.metadata[metadata_keys.AUTH_CACHE_HIT] is True
    assert flow.metadata[metadata_keys.FIREWALL_API_ID] == "aws-sts-api"
    assert flow.metadata[metadata_keys.FIREWALL_BILLABLE] is True
    assert flow.response is None
    assert flow.request.headers["Authorization"].startswith(
        "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/"
    )


async def test_header_sigv4_cache_miss_when_billable_context_changes(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    allow = aws_allow(aws_api_entry(api_id="aws-sts-api", include_session_token=False))
    cached_sandbox_info = aws_sandbox_info(tmp_path)
    active_sandbox_info = aws_sandbox_info(tmp_path, billable_firewalls=["aws"])
    endpoint = FakeAuthEndpoint()
    flow = make_sts_header_sigv4_flow(real_flow, headers)
    cache_aws_sigv4_credentials(
        tmp_path,
        allow=allow,
        sandbox_info=cached_sandbox_info,
        credentials=resolved_aws_sigv4_credentials(session_token=None),
        expires_at=FAR_FUTURE_EXPIRES_AT,
    )

    result = await handle_firewall_request_with_auth_endpoint(
        flow,
        tmp_path,
        mitm_ctx,
        endpoint=endpoint,
        auth_response=aws_auth_response(include_session_token=False),
        allow=allow,
        sandbox_info=active_sandbox_info,
    )

    assert result is auth.FirewallAuthHandlingResult.CONTINUE_UPSTREAM
    assert flow.metadata[metadata_keys.AUTH_CACHE_HIT] is False
    assert flow.metadata[metadata_keys.FIREWALL_API_ID] == "aws-sts-api"
    assert flow.metadata[metadata_keys.FIREWALL_BILLABLE] is True
    assert len(endpoint.requests) == 1


async def test_header_sigv4_without_trusted_original_url_fails_closed(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    allow = aws_allow()
    sandbox_info = aws_sandbox_info(tmp_path)
    flow = make_sts_header_sigv4_flow(real_flow, headers)
    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = sandbox_info["runId"]
    cache_aws_sigv4_credentials(
        tmp_path,
        allow=allow,
        sandbox_info=sandbox_info,
        credentials=resolved_aws_sigv4_credentials(session_token=None),
    )

    with mitm_ctx():
        result = await handle_firewall_request_without_upstream_admission(
            flow, allow, dict(sandbox_info)
        )

    assert_sigv4_failed_closed(result, flow, "AWS request URL is unavailable")


@pytest.mark.parametrize(
    "request_path",
    [
        "//[foo]?Trace=secret-value",
        "/?Trace=secret\nvalue",
    ],
)
async def test_header_sigv4_with_malformed_current_request_target_fails_closed(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
    request_path,
):
    allow = aws_allow()
    sandbox_info = aws_sandbox_info(tmp_path)
    flow = make_sts_header_sigv4_flow(real_flow, headers)
    prepare_firewall_request(flow, run_id=sandbox_info["runId"])
    flow.request.path = request_path
    cache_aws_sigv4_credentials(
        tmp_path,
        allow=allow,
        sandbox_info=sandbox_info,
        credentials=resolved_aws_sigv4_credentials(session_token=None),
    )

    with mitm_ctx():
        result = await handle_firewall_request_without_upstream_admission(
            flow, allow, dict(sandbox_info)
        )

    assert_sigv4_failed_closed(result, flow, "AWS request URL is malformed")


async def test_header_sigv4_with_empty_resolved_session_token_fails_closed(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    allow = aws_allow()
    sandbox_info = aws_sandbox_info(tmp_path)
    flow = make_sts_header_sigv4_flow(real_flow, headers)
    prepare_firewall_request(flow, run_id=sandbox_info["runId"])
    cache_aws_sigv4_credentials(
        tmp_path,
        allow=allow,
        sandbox_info=sandbox_info,
        credentials=resolved_aws_sigv4_credentials(session_token=""),
    )

    with mitm_ctx():
        result = await handle_firewall_request_without_upstream_admission(
            flow, allow, dict(sandbox_info)
        )

    assert_sigv4_failed_closed(result, flow, "Invalid AWS session token")


async def test_header_sigv4_with_real_source_access_key_fails_closed(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    flow = make_sts_header_sigv4_flow(
        real_flow,
        headers,
        authorization=aws_sigv4_authorization(access_key_id=RESOLVED_AWS_ACCESS_KEY_ID),
    )

    result = await handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    assert_sigv4_failed_closed(result, flow, "placeholder access key ID")


async def test_header_sigv4_with_duplicate_credential_fails_closed(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    flow = make_sts_header_sigv4_flow(
        real_flow,
        headers,
        authorization=(
            "AWS4-HMAC-SHA256 "
            "Credential=AKIDEXAMPLE/20260101/us-east-1/sts/aws4_request, "
            "Credential=PLACEHOLDER/20260101/us-east-1/sts/aws4_request, "
            "SignedHeaders=host;x-amz-date, "
            "Signature=placeholder"
        ),
    )

    result = await handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    assert_sigv4_failed_closed(result, flow, "Malformed AWS authorization header")


async def test_header_sigv4_with_duplicate_authorization_headers_fails_closed(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    authorization = aws_sigv4_authorization()
    flow = real_flow(
        with_response=False,
        host="sts.amazonaws.com",
        path="/",
        method="POST",
        request_headers=headers(
            ("Host", STS_HOST),
            ("X-Amz-Date", DEFAULT_SIGV4_TIMESTAMP),
            ("Authorization", authorization),
            ("Authorization", authorization),
        ),
    )

    result = await handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    assert_sigv4_failed_closed(result, flow, "Malformed AWS authorization header")


async def test_header_sigv4_without_signature_fails_closed(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    flow = make_sts_header_sigv4_flow(
        real_flow,
        headers,
        authorization=(
            "AWS4-HMAC-SHA256 "
            "Credential=PLACEHOLDER/20260101/us-east-1/sts/aws4_request, "
            "SignedHeaders=host;x-amz-date"
        ),
    )

    result = await handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    assert_sigv4_failed_closed(result, flow, "Malformed AWS authorization header")


async def test_header_sigv4_with_duplicate_signed_header_fails_closed(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    flow = make_sts_header_sigv4_flow(
        real_flow,
        headers,
        signed_headers="host;host;x-amz-date",
    )

    result = await handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    assert_sigv4_failed_closed(result, flow, "Malformed AWS signed headers")


async def test_header_sigv4_with_missing_signed_header_fails_closed(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    flow = make_sts_header_sigv4_flow(
        real_flow,
        headers,
        signed_headers="host;x-amz-date;x-test",
    )

    result = await handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    assert_sigv4_failed_closed(result, flow, "AWS signed header is missing")


async def test_header_sigv4_without_host_signed_header_fails_closed(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    flow = make_sts_header_sigv4_flow(
        real_flow,
        headers,
        signed_headers="x-amz-date",
    )

    result = await handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    assert_sigv4_failed_closed(result, flow, "AWS signed headers must include host")


async def test_header_sigv4_with_empty_signed_header_segment_fails_closed(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    flow = make_sts_header_sigv4_flow(
        real_flow,
        headers,
        signed_headers="host;;x-amz-date",
    )

    result = await handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    assert_sigv4_failed_closed(result, flow, "Malformed AWS signed headers")


async def test_header_sigv4_without_amz_date_fails_closed(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    flow = make_sts_header_sigv4_flow(
        real_flow,
        headers,
        amz_date=None,
        authorization=aws_sigv4_authorization(signed_headers="host"),
    )

    result = await handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    assert_sigv4_failed_closed(result, flow, "requires x-amz-date")


async def test_header_sigv4_with_malformed_amz_date_fails_closed(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    flow = make_sts_header_sigv4_flow(
        real_flow,
        headers,
        amz_date="not-a-date",
    )

    result = await handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    assert_sigv4_failed_closed(result, flow, "Malformed AWS signing date")


async def test_header_sigv4_with_scope_date_mismatch_fails_closed(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    flow = make_sts_header_sigv4_flow(
        real_flow,
        headers,
        amz_date="20260102T000000Z",
    )

    result = await handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    assert_sigv4_failed_closed(
        result,
        flow,
        "AWS signing date does not match credential scope",
    )


async def test_header_sigv4_with_duplicate_amz_date_fails_closed(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    flow = make_sts_header_sigv4_flow(
        real_flow,
        headers,
        extra_headers=(("X-Amz-Date", "20260101T000001Z"),),
    )

    result = await handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    assert_sigv4_failed_closed(result, flow, "requires a single x-amz-date")


async def test_header_sigv4_with_duplicate_content_hash_fails_closed(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    flow = make_sts_header_sigv4_flow(
        real_flow,
        headers,
        signed_headers="host;x-amz-content-sha256;x-amz-date",
        extra_headers=(
            ("X-Amz-Content-Sha256", "placeholder-hash-1"),
            ("X-Amz-Content-Sha256", "placeholder-hash-2"),
        ),
    )

    result = await handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    assert_sigv4_failed_closed(result, flow, "AWS content hash header is ambiguous")


async def test_header_sigv4_with_empty_content_hash_fails_closed(
    real_flow,
    headers,
    tmp_path,
    mitm_ctx,
):
    flow = make_sts_header_sigv4_flow(
        real_flow,
        headers,
        signed_headers="host;x-amz-content-sha256;x-amz-date",
        extra_headers=(("X-Amz-Content-Sha256", ""),),
    )

    result = await handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    assert_sigv4_failed_closed(result, flow, "AWS content hash header is empty")


async def test_query_sigv4_without_signature_fails_closed(real_flow, tmp_path, mitm_ctx):
    flow = make_sts_query_sigv4_flow(
        real_flow,
        path=aws_sigv4_presigned_query_path(signature=None),
    )

    result = await handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    assert_sigv4_failed_closed(result, flow, "Malformed AWS presigned query")


async def test_query_sigv4_with_real_source_access_key_fails_closed(real_flow, tmp_path, mitm_ctx):
    flow = make_sts_query_sigv4_flow(
        real_flow,
        path=aws_sigv4_presigned_query_path(access_key_id=RESOLVED_AWS_ACCESS_KEY_ID),
    )

    result = await handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    assert_sigv4_failed_closed(result, flow, "placeholder access key ID")


async def test_query_sigv4_with_duplicate_credential_fails_closed(real_flow, tmp_path, mitm_ctx):
    real_credential = quote_sigv4_value(
        aws_credential_scope(access_key_id=RESOLVED_AWS_ACCESS_KEY_ID)
    )
    flow = make_sts_query_sigv4_flow(
        real_flow,
        path=(
            f"{aws_sigv4_presigned_query_path(signature=None)}"
            f"&X-Amz-Credential={real_credential}"
            "&X-Amz-Signature=placeholder"
        ),
    )

    result = await handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    assert_sigv4_failed_closed(result, flow, "Malformed AWS presigned query")


async def test_query_sigv4_with_duplicate_signed_header_fails_closed(
    real_flow,
    tmp_path,
    mitm_ctx,
):
    flow = make_sts_query_sigv4_flow(
        real_flow,
        path=aws_sigv4_presigned_query_path(signed_headers="host;host"),
    )

    result = await handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    assert_sigv4_failed_closed(result, flow, "Malformed AWS signed headers")


async def test_query_sigv4_with_missing_signed_header_fails_closed(
    real_flow,
    tmp_path,
    mitm_ctx,
):
    flow = make_sts_query_sigv4_flow(
        real_flow,
        path=aws_sigv4_presigned_query_path(signed_headers="host;x-test"),
    )

    result = await handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    assert_sigv4_failed_closed(result, flow, "AWS signed header is missing")


async def test_query_sigv4_without_host_signed_header_fails_closed(
    real_flow,
    tmp_path,
    mitm_ctx,
):
    flow = make_sts_query_sigv4_flow(
        real_flow,
        path=aws_sigv4_presigned_query_path(signed_headers="x-test"),
    )
    flow.request.headers["X-Test"] = "signed-value"

    result = await handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    assert_sigv4_failed_closed(result, flow, "AWS signed headers must include host")


@pytest.mark.parametrize(
    "expires",
    [
        pytest.param("0", id="zero"),
        pytest.param("604801", id="above-maximum"),
        pytest.param("sixty", id="text"),
        pytest.param("9" * 5000, id="oversized"),
        pytest.param("1\u0661", id="unicode-digit"),
    ],
)
async def test_query_sigv4_with_invalid_expiry_fails_closed(
    real_flow,
    tmp_path,
    mitm_ctx,
    expires,
):
    flow = make_sts_query_sigv4_flow(
        real_flow,
        path=aws_sigv4_presigned_query_path(expires=expires),
    )

    result = await handle_firewall_request_with_auth_endpoint(flow, tmp_path, mitm_ctx)

    assert_sigv4_failed_closed(result, flow, "Malformed AWS presigned query expiry")
