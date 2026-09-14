"""Integration tests for firewall auth header injection."""

import json
from unittest.mock import AsyncMock, patch

import pytest
from mitmproxy import http

import auth
import flow_metadata_keys as metadata_keys
from tests.auth_base_forwarder_helpers import fake_forwarder_upstream
from tests.firewall_auth_helpers import (
    apply_requestheaders_auth_without_upstream_admission,
    firewall_auth_response,
    handle_firewall_request_without_upstream_admission,
    make_allow,
)


@pytest.mark.parametrize("hook_phase", ["request", "requestheaders", "auth.base"])
async def test_resolved_header_collisions_have_one_final_value_across_auth_paths(
    real_flow,
    mitm_ctx,
    hook_phase,
):
    resolved_headers = {
        "Authorization": "Bearer synthetic-first",
        "X-Label": "first",
        "authorization": "Bearer synthetic-final",
        "X-After": "after",
        "x-label": "café",
        "Connection": "X-First-Hop",
        "connection": "X-Last-Hop",
        "X-First-Hop": "filtered-first",
        "X-Last-Hop": "filtered-last",
    }
    flow = real_flow(
        with_response=False,
        host="api.example.com",
        method="POST",
        path="/resource",
        request_body=b"payload",
        request_headers=http.Headers(
            [
                (b"Host", b"api.example.com"),
                (b"aUtHoRiZaTiOn", b"client-first"),
                (b"X-Raw", b"caf\xe9"),
                (b"AUTHORIZATION", b"client-second"),
                (b"Content-Type", b"application/json"),
                (b"Content-Encoding", b"gzip"),
                (b"content-encoding", b"br"),
                (b"Content-Length", b"7"),
            ]
        ),
    )
    original_fields = flow.request.headers.fields
    auth_config: dict = {
        "headers": dict.fromkeys(resolved_headers, "${{ secrets.VALUE }}"),
    }
    resolved_base = None
    if hook_phase == "auth.base":
        auth_config["base"] = "${{ secrets.BASE }}"
        resolved_base = "https://upstream.example.com"
    allow = make_allow(
        {"base": "https://api.example.com", "auth": auth_config},
        rule="POST /resource",
        rel_path="/resource",
    )
    sandbox_info = {
        "runId": "run-1",
        "sandboxToken": "tok",
        "encryptedSecrets": "iv:tag:data",
        "billableFirewalls": [],
    }
    token_meta = firewall_auth_response(headers=resolved_headers, base=resolved_base)

    with (
        patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
        fake_forwarder_upstream(headers=[("Set-Cookie", "a=1"), ("Set-Cookie", "b=2")]) as upstream,
        mitm_ctx(),
    ):
        if hook_phase == "requestheaders":
            result = await apply_requestheaders_auth_without_upstream_admission(
                flow, allow, sandbox_info
            )
        else:
            result = await handle_firewall_request_without_upstream_admission(
                flow, allow, sandbox_info
            )

    if hook_phase == "auth.base":
        assert result is auth.FirewallAuthHandlingResult.INLINE_PROVIDER_RESPONSE
        assert flow.response is not None
        assert flow.response.status_code == 200
        assert flow.response.content == b"ok"
        assert flow.response.headers.get_all("Set-Cookie") == ["a=1", "b=2"]
        assert flow.request.headers.fields == original_fields
        assert upstream.socket.sent == (
            b"POST /resource HTTP/1.1\r\n"
            b"Host: upstream.example.com\r\n"
            b"Content-Type: application/json\r\n"
            b"Content-Encoding: gzip\r\n"
            b"content-encoding: br\r\n"
            b"Authorization: Bearer synthetic-final\r\n"
            b"X-Label: caf\xe9\r\n"
            b"X-After: after\r\n"
            b"Content-Length: 7\r\n"
            b"\r\npayload"
        )
    else:
        expected_result = (
            auth.FirewallHeaderPhaseAuthResult.APPLIED
            if hook_phase == "requestheaders"
            else auth.FirewallAuthHandlingResult.CONTINUE_UPSTREAM
        )
        assert result is expected_result
        assert flow.response is None
        assert flow.request.headers.fields == (
            (b"Host", b"api.example.com"),
            (b"aUtHoRiZaTiOn", b"Bearer synthetic-final"),
            (b"X-Raw", b"caf\xe9"),
            (b"Content-Type", b"application/json"),
            (b"Content-Encoding", b"gzip"),
            (b"content-encoding", b"br"),
            (b"Content-Length", b"7"),
            (b"X-Label", b"caf\xe9"),
            (b"X-After", b"after"),
        )


@pytest.mark.parametrize("hook_phase", ["request", "requestheaders", "auth.base"])
@pytest.mark.parametrize(
    "invalid_headers",
    [
        pytest.param(
            {"Authorization": "bad\r\nX-Injected: value", "authorization": "valid"},
            id="shadowed-newline-value",
        ),
        pytest.param(
            {"X-Label": "snowman ☃", "x-label": "valid"},
            id="shadowed-non-latin-1-value",
        ),
        pytest.param({"Host": "bad\r\nX-Injected: value"}, id="filtered-invalid-value"),
    ],
)
async def test_invalid_resolved_headers_cannot_be_hidden_by_collision_or_filtering(
    real_flow,
    mitm_ctx,
    hook_phase,
    invalid_headers,
):
    flow = real_flow(
        with_response=False,
        host="api.example.com",
        path="/resource?existing=1",
        request_headers=http.Headers(
            [(b"Host", b"api.example.com"), (b"Authorization", b"client")]
        ),
    )
    original_fields = flow.request.headers.fields
    original_url = flow.request.url
    auth_config: dict = {
        "headers": dict.fromkeys(invalid_headers, "${{ secrets.VALUE }}"),
        "query": {"api_key": "${{ secrets.VALUE }}"},
    }
    resolved_base = None
    if hook_phase == "auth.base":
        auth_config["base"] = "${{ secrets.BASE }}"
        resolved_base = "https://upstream.example.com"
    allow = make_allow(
        {"base": "https://api.example.com", "auth": auth_config},
        rule="GET /resource",
        rel_path="/resource",
    )
    sandbox_info = {
        "runId": "run-1",
        "sandboxToken": "tok",
        "encryptedSecrets": "iv:tag:data",
        "billableFirewalls": [],
    }
    token_meta = firewall_auth_response(
        headers=invalid_headers, base=resolved_base, query={"api_key": "synthetic-secret"}
    )

    with (
        patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
        fake_forwarder_upstream() as upstream,
        mitm_ctx(),
    ):
        if hook_phase == "requestheaders":
            result = await apply_requestheaders_auth_without_upstream_admission(
                flow, allow, sandbox_info
            )
        else:
            result = await handle_firewall_request_without_upstream_admission(
                flow, allow, sandbox_info
            )

    assert flow.request.headers.fields == original_fields
    assert flow.request.url == original_url
    assert upstream.sockets == []
    if hook_phase == "requestheaders":
        assert result is auth.FirewallHeaderPhaseAuthResult.FALLBACK
        assert flow.response is None
    else:
        assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
        assert flow.response is not None
        assert flow.response.status_code == 502
        assert json.loads(flow.response.content)["error"] == "invalid_resolved_auth_header"


@pytest.mark.parametrize(
    ("hook_phase", "expected_result"),
    [
        pytest.param(
            "request",
            auth.FirewallAuthHandlingResult.CONTINUE_UPSTREAM,
            id="request",
        ),
        pytest.param(
            "requestheaders",
            auth.FirewallHeaderPhaseAuthResult.APPLIED,
            id="requestheaders",
        ),
    ],
)
async def test_bulk_headers_preserve_semantics_without_per_header_rebuilds(
    real_flow,
    mitm_ctx,
    monkeypatch,
    hook_phase,
    expected_result,
):
    bulk_headers = {f"X-Bulk-{index:04d}": f"resolved-{index}" for index in range(512)}
    resolved_headers = {
        "X-Managed": "resolved-first",
        "x-managed": "resolved-final",
        "Connection": "X-Connection-Only",
        "X-Connection-Only": "filtered",
        "Host": "resolved.example.com",
        "Content-Length": "999",
        "Transfer-Encoding": "chunked",
        "Proxy-Authorization": "Basic filtered",
        "X-Latin-1": "café",
        **bulk_headers,
    }
    flow = real_flow(
        with_response=False,
        host="api.example.com",
        path="/resource",
        request_headers=http.Headers(
            [
                (b"Host", b"api.example.com"),
                (b"X-Keep", b"one"),
                (b"x-managed", b"client-first"),
                (b"X-Raw", b"caf\xe9"),
                (b"X-Keep", b"two"),
                (b"X-MANAGED", b"client-second"),
                (b"X-Bulk-0000", b"client-bulk"),
                (b"Content-Length", b"7"),
            ]
        ),
    )
    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "test-run"
    allow = make_allow(
        {
            "base": "https://api.example.com",
            "auth": {
                "headers": dict.fromkeys(resolved_headers, "${{ secrets.VALUE }}"),
            },
        },
        name="example",
        permission="read",
        rule="GET /resource",
    )
    sandbox_info = {
        "runId": "run-1",
        "sandboxToken": "tok",
        "encryptedSecrets": "iv:tag:data",
        "billableFirewalls": [],
    }
    token_meta = firewall_auth_response(
        headers=resolved_headers,
        resolved_secrets=["VALUE"],
    )
    header_set_all_calls = 0
    original_set_all = http.Headers.set_all

    def counted_set_all(headers, name, values):
        nonlocal header_set_all_calls
        header_set_all_calls += 1
        return original_set_all(headers, name, values)

    monkeypatch.setattr(http.Headers, "set_all", counted_set_all)

    with (
        patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
        mitm_ctx(),
    ):
        if hook_phase == "request":
            result = await handle_firewall_request_without_upstream_admission(
                flow, allow, sandbox_info
            )
        else:
            result = await apply_requestheaders_auth_without_upstream_admission(
                flow, allow, sandbox_info
            )

    assert result is expected_result
    assert header_set_all_calls == 0
    assert flow.request.headers.fields == (
        (b"Host", b"api.example.com"),
        (b"X-Keep", b"one"),
        (b"x-managed", b"resolved-final"),
        (b"X-Raw", b"caf\xe9"),
        (b"X-Keep", b"two"),
        (b"X-Bulk-0000", b"resolved-0"),
        (b"Content-Length", b"7"),
        (b"X-Latin-1", b"caf\xe9"),
        *((name.encode(), value.encode()) for name, value in list(bulk_headers.items())[1:]),
    )
