"""Response hook integration tests for connector diagnostics."""

import json
import urllib.parse

import pytest
from mitmproxy.test import tutils

import connector_diagnostics
import flow_metadata_keys as metadata_keys
import mitm_addon
from tests.connector_diagnostic_helpers import (
    record_connector_diagnostic_requestheaders_context,
    write_connector_diagnostic_capture_registry,
    write_connector_diagnostic_catalog_cache,
    write_shared_base_diagnostic_catalog,
)
from tests.flow_helpers import header_map, response_stream
from tests.jsonl_log_helpers import (
    jsonl_exists_after_flush,
    read_jsonl_entries_after_flush,
)
from tests.request_handler_helpers import (
    _sandbox_without_firewalls,
    _single_firewall_sandbox,
    _write_registry,
)


def _drain_connector_diagnostic_response_stream(flow, *, upstream_chunk: bytes = b"upstream"):
    stream = response_stream(flow)
    assert stream(upstream_chunk) == ()
    diagnostic_body = stream(b"")
    assert isinstance(diagnostic_body, bytes)
    assert json.loads(diagnostic_body)["error"] == "connector_not_configured_for_run"
    assert stream(b"") == ()
    return diagnostic_body


@pytest.mark.parametrize("upstream_status", [401, 403])
async def test_replaces_unauthenticated_connector_auth_error_body(
    tmp_path,
    real_flow,
    mitm_ctx,
    upstream_status,
):
    reg_path = write_connector_diagnostic_capture_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro",
        method="POST",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        await mitm_addon.request(flow)
        assert flow.response is None
        assert metadata_keys.CONNECTOR_DIAGNOSTIC_SLUG not in flow.metadata
        flow.metadata[metadata_keys.ORIGINAL_URL] = (
            "https://fal.run/fal-ai/nano-banana-pro?debug=secret#fragment"
        )
        flow.response = tutils.tresp(
            status_code=upstream_status,
            headers=header_map({"content-type": "text/plain", "content-length": "8"}),
            content=b"upstream",
        )
        flow.metadata[metadata_keys.RESPONSE_STREAM_STATE] = {"total_bytes": 8}
        mitm_addon.response(flow)

    assert flow.response.status_code == upstream_status
    assert flow.response.headers["content-type"] == "application/json"
    content = flow.response.content
    assert content is not None
    body = json.loads(content)
    assert body == {
        "error": "connector_not_configured_for_run",
        "connector": "fal",
        "reason": "not_configured_for_run",
        "message": (
            "fal is not configured for this run. FAL_TOKEN is unavailable, "
            "so credentials cannot be injected."
        ),
        "envNames": ["FAL_TOKEN"],
        "base": "https://fal.run",
        "upstreamStatus": upstream_status,
    }
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["action"] == "ALLOW"
    assert entry["status"] == upstream_status
    assert entry["firewall_error"] == "connector_not_configured_for_run"
    assert entry["connector_diagnostic_slug"] == "fal"
    assert entry["connector_diagnostic_reason"] == "not_configured_for_run"
    assert entry["connector_diagnostic_env_names"] == ["FAL_TOKEN"]
    assert entry["connector_diagnostic_base"] == "https://fal.run"
    assert entry["response_size"] == len(content)
    assert metadata_keys.RESPONSE_STREAM_STATE not in flow.metadata
    proxy_entry = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")[0]
    assert proxy_entry["type"] == "connector_diagnostic"
    assert proxy_entry["connector"] == "fal"
    assert proxy_entry["upstream_status"] == upstream_status
    assert proxy_entry["url"] == "https://fal.run/fal-ai/nano-banana-pro"
    assert proxy_entry["message"].endswith(f": {proxy_entry['url']}")
    serialized_proxy_entry = json.dumps(proxy_entry)
    assert "debug=secret" not in serialized_proxy_entry
    assert "#fragment" not in serialized_proxy_entry
    assert "url_truncated" not in proxy_entry
    assert "url_original_char_count" not in proxy_entry


async def test_replaces_buffered_head_401_with_bodyless_diagnostic(tmp_path, real_flow, mitm_ctx):
    reg_path = write_connector_diagnostic_capture_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro",
        method="HEAD",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        record_connector_diagnostic_requestheaders_context(flow)
        flow.response = tutils.tresp(
            status_code=401,
            headers=header_map(
                {
                    "content-encoding": "gzip",
                    "content-length": "8",
                    "content-type": "text/plain",
                    "transfer-encoding": "chunked",
                }
            ),
            content=b"upstream",
        )
        mitm_addon.response(flow)

    assert flow.response.status_code == 401
    assert flow.response.raw_content == b""
    assert flow.response.headers["Content-Type"] == "application/json"
    assert flow.response.headers.get_all("Content-Length") == []
    assert "Content-Encoding" not in flow.response.headers
    assert "Transfer-Encoding" not in flow.response.headers
    assert flow.metadata[metadata_keys.CONNECTOR_DIAGNOSTIC_SLUG] == "fal"
    [network_entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert network_entry["response_size"] == 0
    assert "response_body" not in network_entry
    [connector_entry, http_error_entry] = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
    assert connector_entry["type"] == "connector_diagnostic"
    assert http_error_entry["type"] == "http_error"


async def test_active_shared_base_owner_preserves_ordinary_allow_401(tmp_path, real_flow, mitm_ctx):
    write_shared_base_diagnostic_catalog(
        tmp_path,
        active_permissions=[
            {
                "name": "messages-read",
                "rules": ["GET /messages/{id}"],
            }
        ],
        inactive_permissions=[
            {
                "name": "other-read",
                "rules": ["GET /other/{id}"],
            }
        ],
    )
    # Keep the catalog owner active while a nonmatching runtime base forces ordinary Allow.
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            firewall_name="active-shared",
            api_entry={
                "base": "https://shared.example.com/runtime",
                "auth": {
                    "headers": {
                        "Authorization": "Bearer ${{ secrets.ACTIVE_TOKEN }}",
                    }
                },
                "permissions": [
                    {
                        "name": "runtime-read",
                        "rules": ["GET /{path+}"],
                    }
                ],
            },
            network_policy={
                "allow": ["runtime-read"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
            sandbox_fields={"captureNetworkBodies": True},
        ),
    )
    upstream_body = b"upstream auth error"
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="shared.example.com",
        path="/messages/123",
        method="GET",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        record_connector_diagnostic_requestheaders_context(flow)
        flow.response = tutils.tresp(
            status_code=401,
            headers=header_map({"content-type": "text/plain"}),
            content=upstream_body,
        )
        mitm_addon.responseheaders(flow)
        assert response_stream(flow)(upstream_body) == upstream_body
        mitm_addon.response(flow)

    assert flow.response.status_code == 401
    assert flow.response.headers["content-type"] == "text/plain"
    assert flow.response.content == upstream_body
    assert metadata_keys.FIREWALL_ERROR not in flow.metadata
    assert metadata_keys.CONNECTOR_DIAGNOSTIC_SLUG not in flow.metadata
    [network_entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert network_entry["status"] == 401
    assert network_entry["response_size"] == len(upstream_body)
    assert "firewall_error" not in network_entry
    assert "connector_diagnostic_slug" not in network_entry
    [proxy_entry] = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
    assert proxy_entry["type"] == "http_error"
    assert proxy_entry["status"] == 401


async def test_streams_unauthenticated_connector_401_diagnostic_without_upstream_body(
    tmp_path, real_flow, mitm_ctx
):
    reg_path = write_connector_diagnostic_capture_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro",
        method="POST",
    )
    upstream_chunk = b"discarded-upstream-body-" * 1024

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        record_connector_diagnostic_requestheaders_context(flow)
        flow.response = tutils.tresp(
            status_code=401,
            headers=header_map(
                {
                    "content-encoding": "gzip",
                    "content-length": "10485760",
                    "content-type": "text/plain",
                    "transfer-encoding": "chunked",
                }
            ),
            content=b"upstream",
        )
        mitm_addon.responseheaders(flow)
        diagnostic_body = _drain_connector_diagnostic_response_stream(
            flow,
            upstream_chunk=upstream_chunk,
        )
        assert not jsonl_exists_after_flush(tmp_path / "proxy.jsonl")
        flow.response.trailers = header_map({"x-upstream-trailer": "discarded"})
        mitm_addon.response(flow)

    content = flow.response.content
    assert content is not None
    assert content == diagnostic_body
    assert json.loads(content)["error"] == "connector_not_configured_for_run"
    assert flow.response.headers["content-type"] == "application/json"
    assert flow.response.headers["content-length"] == str(len(diagnostic_body))
    assert "content-encoding" not in flow.response.headers
    assert "transfer-encoding" not in flow.response.headers
    assert flow.response.trailers is None
    assert flow.response.stream is False
    assert metadata_keys.STREAM_BUFFER not in flow.metadata
    assert metadata_keys.STREAM_BUFFER_STATE not in flow.metadata
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["response_size"] == len(diagnostic_body)
    response_headers = {name.lower(): value for name, value in entry["response_headers"].items()}
    assert response_headers["content-type"] == "application/json"
    assert response_headers["content-length"] == str(len(diagnostic_body))
    assert json.loads(entry["response_body"])["error"] == "connector_not_configured_for_run"
    assert "discarded-upstream-body" not in entry["response_body"]
    assert entry["response_body_encoding"] == "utf-8"
    proxy_entries = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
    assert sum(entry["type"] == "connector_diagnostic" for entry in proxy_entries) == 1


def test_responseheaders_preserves_upstream_for_query_over_inspection_limit(
    tmp_path,
    real_flow,
    mitm_ctx,
):
    reg_path = write_connector_diagnostic_capture_registry(tmp_path)
    query = "noise=" + "x" * (
        connector_diagnostics.MAX_CONNECTOR_DIAGNOSTIC_QUERY_CHARACTERS - len("noise=") + 1
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path=f"/fal-ai/nano-banana-pro?{query}",
        method="POST",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        record_connector_diagnostic_requestheaders_context(flow)
        flow.response = tutils.tresp(
            status_code=401,
            headers=header_map({"content-type": "text/plain"}),
            content=b"upstream",
        )

        urllib.parse.urlsplit.cache_clear()
        try:
            urllib.parse.urlsplit("https://stable-config.example.com")
            stable_cache = urllib.parse.urlsplit.cache_info()
            mitm_addon.responseheaders(flow)
            assert urllib.parse.urlsplit.cache_info() == stable_cache
        finally:
            urllib.parse.urlsplit.cache_clear()

        assert metadata_keys.CONNECTOR_DIAGNOSTIC_SLUG not in flow.metadata
        assert metadata_keys.CONNECTOR_DIAGNOSTIC_REASON not in flow.metadata
        assert response_stream(flow)(b"upstream") == b"upstream"
        mitm_addon.response(flow)

    assert flow.response.status_code == 401
    assert flow.response.content == b"upstream"
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert "firewall_error" not in entry


@pytest.mark.parametrize(
    ("query", "expect_diagnostic"),
    [
        (
            "&".join(["x"] * connector_diagnostics.MAX_CONNECTOR_DIAGNOSTIC_QUERY_FIELDS),
            True,
        ),
        (
            "&".join(["x"] * (connector_diagnostics.MAX_CONNECTOR_DIAGNOSTIC_QUERY_FIELDS + 1)),
            False,
        ),
        (
            "noise="
            + "x"
            * (connector_diagnostics.MAX_CONNECTOR_DIAGNOSTIC_QUERY_CHARACTERS - len("noise=")),
            True,
        ),
        (
            "noise="
            + "x"
            * (connector_diagnostics.MAX_CONNECTOR_DIAGNOSTIC_QUERY_CHARACTERS - len("noise=") + 1),
            False,
        ),
    ],
    ids=["field-limit", "over-field-limit", "character-limit", "over-character-limit"],
)
async def test_query_inspection_boundaries_control_connector_401_diagnostic(
    tmp_path,
    real_flow,
    mitm_ctx,
    query,
    expect_diagnostic,
):
    reg_path = write_connector_diagnostic_capture_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path=f"/fal-ai/nano-banana-pro?{query}",
        method="POST",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        await mitm_addon.request(flow)
        assert flow.response is None
        flow.response = tutils.tresp(
            status_code=401,
            headers=header_map({"content-type": "text/plain"}),
            content=b"upstream",
        )
        mitm_addon.response(flow)

    assert flow.response.status_code == 401
    content = flow.response.content
    assert content is not None
    if expect_diagnostic:
        assert json.loads(content)["error"] == "connector_not_configured_for_run"
        assert flow.metadata[metadata_keys.CONNECTOR_DIAGNOSTIC_SLUG] == "fal"
    else:
        assert content == b"upstream"
        assert metadata_keys.CONNECTOR_DIAGNOSTIC_SLUG not in flow.metadata


@pytest.mark.parametrize(
    "query",
    [
        "API%5fKEY=user+token",
        "api_key=&noise=x&api_key=user-token",
        "api_key=user=token",
        "api_key=%ZZ",
        "api_key=user-token&"
        + "&".join(["x"] * (connector_diagnostics.MAX_CONNECTOR_DIAGNOSTIC_QUERY_FIELDS + 1)),
    ],
    ids=["percent-plus", "duplicate", "first-equals", "invalid-percent", "auth-before-limit"],
)
async def test_encoded_query_auth_preserves_connector_401(
    tmp_path,
    real_flow,
    mitm_ctx,
    query,
):
    reg_path = write_connector_diagnostic_capture_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path=f"/fal-ai/nano-banana-pro?{query}",
        method="POST",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        await mitm_addon.request(flow)
        assert flow.response is None
        flow.response = tutils.tresp(
            status_code=401,
            headers=header_map({"content-type": "text/plain"}),
            content=b"upstream auth error",
        )
        mitm_addon.response(flow)

    assert flow.response.status_code == 401
    assert flow.response.content == b"upstream auth error"
    assert metadata_keys.CONNECTOR_DIAGNOSTIC_SLUG not in flow.metadata


@pytest.mark.parametrize(
    ("path", "request_header_pairs"),
    [
        ("/items", [("X-Workspace-Session", "user-provided")]),
        ("/items?workspace_session=user-provided", []),
        ("/items?WORKSPACE%5FSESSION=user+provided", []),
    ],
    ids=["configured-header", "configured-query", "encoded-configured-query"],
)
async def test_configured_auth_preserves_connector_401(
    tmp_path,
    real_flow,
    mitm_ctx,
    headers,
    path,
    request_header_pairs,
):
    write_connector_diagnostic_catalog_cache(
        tmp_path,
        firewalls={
            "configured-auth": {
                "name": "configured-auth",
                "apis": [
                    {
                        "base": "https://configured.example.com",
                        "hostPolicy": {
                            "kind": "providerOwned",
                            "exactHosts": ["configured.example.com"],
                        },
                        "auth": {
                            "headers": {
                                "X-Workspace-Session": "${{ secrets.WORKSPACE_TOKEN }}",
                            },
                            "query": {
                                "workspace_session": "${{ secrets.WORKSPACE_TOKEN }}",
                            },
                        },
                        "permissions": [{"name": "read", "rules": ["GET /items"]}],
                    }
                ],
            }
        },
    )
    reg_path = _write_registry(tmp_path, sandbox_info=_sandbox_without_firewalls(tmp_path))
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="configured.example.com",
        path=path,
        request_headers=headers(
            ("Host", "configured.example.com"),
            *request_header_pairs,
        ),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        await mitm_addon.request(flow)
        assert flow.response is None
        flow.response = tutils.tresp(
            status_code=401,
            headers=header_map({"content-type": "text/plain"}),
            content=b"upstream auth error",
        )
        mitm_addon.response(flow)

    assert flow.response.status_code == 401
    assert flow.response.content == b"upstream auth error"
    assert metadata_keys.CONNECTOR_DIAGNOSTIC_SLUG not in flow.metadata


async def test_restores_connector_diagnostic_body_when_headers_end_stream(
    tmp_path, real_flow, mitm_ctx
):
    reg_path = write_connector_diagnostic_capture_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro",
        method="POST",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        record_connector_diagnostic_requestheaders_context(flow)
        flow.response = tutils.tresp(
            status_code=401,
            headers=header_map({"content-type": "text/plain"}),
            content=b"",
        )
        mitm_addon.responseheaders(flow)
        flow.response.data.content = b""
        mitm_addon.response(flow)

    content = flow.response.content
    assert content is not None
    body = json.loads(content)
    assert body["error"] == "connector_not_configured_for_run"
    assert flow.response.headers["content-type"] == "application/json"
    assert flow.response.headers["content-length"] == str(len(content))
    assert flow.response.stream is False

    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["response_size"] == len(content)
    assert json.loads(entry["response_body"])["error"] == "connector_not_configured_for_run"


async def test_head_response_stream_emits_no_diagnostic_body(tmp_path, real_flow, mitm_ctx):
    reg_path = write_connector_diagnostic_capture_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro",
        method="HEAD",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        record_connector_diagnostic_requestheaders_context(flow)
        flow.response = tutils.tresp(
            status_code=401,
            headers=header_map(
                {
                    "content-length": "8",
                    "content-type": "text/plain",
                    "transfer-encoding": "chunked",
                }
            ),
            content=b"upstream",
        )
        mitm_addon.responseheaders(flow)
        stream = response_stream(flow)
        assert stream(b"unexpected upstream body") == ()
        assert stream(b"") == b""
        mitm_addon.response(flow)

    assert flow.response.status_code == 401
    assert flow.response.raw_content == b""
    assert flow.response.headers["Content-Type"] == "application/json"
    assert flow.response.headers.get_all("Content-Length") == []
    assert "Transfer-Encoding" not in flow.response.headers
    [network_entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert network_entry["response_size"] == 0
    assert "response_body" not in network_entry


async def test_streams_connector_401_when_user_auth_is_present(
    tmp_path, real_flow, mitm_ctx, headers
):
    write_connector_diagnostic_catalog_cache(tmp_path)
    reg_path = _write_registry(tmp_path, sandbox_info=_sandbox_without_firewalls(tmp_path))
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro",
        method="POST",
        request_headers=headers(
            ("Host", "fal.run"),
            ("Authorization", "Key user-provided"),
        ),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        await mitm_addon.request(flow)
        flow.response = tutils.tresp(
            status_code=401,
            headers=header_map({"content-type": "text/plain"}),
            content=b"upstream auth error",
        )
        mitm_addon.responseheaders(flow)
        assert response_stream(flow)(b"upstream auth error") == b"upstream auth error"
        mitm_addon.response(flow)

    assert flow.response.content == b"upstream auth error"


async def test_streamed_connector_401_with_user_auth_keeps_upstream_response(
    tmp_path, real_flow, mitm_ctx, headers
):
    write_connector_diagnostic_catalog_cache(tmp_path)
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_sandbox_without_firewalls(
            tmp_path, sandbox_fields={"captureNetworkBodies": True}
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro",
        method="POST",
        request_headers=headers(
            ("Host", "fal.run"),
            ("Authorization", "Key user-provided"),
        ),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.requestheaders(flow)
        request_stream = flow.request.stream
        assert callable(request_stream)
        assert request_stream(b"partial request") == b"partial request"
        await mitm_addon.request(flow)
        flow.response = tutils.tresp(
            status_code=401,
            headers=header_map({"content-type": "text/plain"}),
            content=b"upstream auth error",
        )
        mitm_addon.responseheaders(flow)
        assert response_stream(flow)(b"upstream auth error") == b"upstream auth error"
        mitm_addon.response(flow)

    assert flow.response.content == b"upstream auth error"
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["status"] == 401
    assert entry["request_size"] == len(b"partial request")
    assert "firewall_error" not in entry


async def test_streamed_connector_401_with_query_auth_keeps_upstream_response(
    tmp_path, real_flow, mitm_ctx
):
    write_connector_diagnostic_catalog_cache(tmp_path)
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_sandbox_without_firewalls(
            tmp_path, sandbox_fields={"captureNetworkBodies": True}
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro?auth=token",
        method="POST",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.requestheaders(flow)
        request_stream = flow.request.stream
        assert callable(request_stream)
        assert request_stream(b"partial request") == b"partial request"
        await mitm_addon.request(flow)
        flow.response = tutils.tresp(
            status_code=401,
            headers=header_map({"content-type": "text/plain"}),
            content=b"upstream query auth error",
        )
        mitm_addon.responseheaders(flow)
        assert response_stream(flow)(b"upstream query auth error") == b"upstream query auth error"
        mitm_addon.response(flow)

    assert flow.response.content == b"upstream query auth error"
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["status"] == 401
    assert entry["request_size"] == len(b"partial request")
    assert "firewall_error" not in entry


@pytest.mark.parametrize(
    "request_completed", [False, True], ids=["before-request", "after-request"]
)
async def test_streamed_connector_401_gets_diagnostic(
    tmp_path, real_flow, mitm_ctx, request_completed
):
    write_connector_diagnostic_catalog_cache(tmp_path)
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_sandbox_without_firewalls(
            tmp_path, sandbox_fields={"captureNetworkBodies": True}
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro",
        method="POST",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.requestheaders(flow)
        request_stream = flow.request.stream
        assert callable(request_stream)
        assert request_stream(b"partial request") == b"partial request"
        if request_completed:
            await mitm_addon.request(flow)
        assert flow.response is None
        flow.response = tutils.tresp(
            status_code=401,
            headers=header_map({"content-type": "text/plain"}),
            content=b"upstream auth error",
        )
        mitm_addon.responseheaders(flow)
        diagnostic_body = _drain_connector_diagnostic_response_stream(flow)
        mitm_addon.response(flow)

    content = flow.response.content
    assert content is not None
    assert content == diagnostic_body
    body = json.loads(content)
    assert body["error"] == "connector_not_configured_for_run"
    assert body["connector"] == "fal"
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["status"] == 401
    assert entry["request_size"] == len(b"partial request")
    assert entry["firewall_error"] == "connector_not_configured_for_run"
    assert entry["connector_diagnostic_slug"] == "fal"
    assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
    assert metadata_keys.REQUEST_STREAM_BUFFER_STATE not in flow.metadata


def test_streamed_authenticated_connector_401_before_request_keeps_upstream_response(
    tmp_path, real_flow, mitm_ctx, headers
):
    write_connector_diagnostic_catalog_cache(tmp_path)
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_sandbox_without_firewalls(
            tmp_path, sandbox_fields={"captureNetworkBodies": True}
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro",
        method="POST",
        request_headers=headers(
            ("Host", "fal.run"),
            ("Authorization", "Key user-provided"),
        ),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.requestheaders(flow)
        request_stream = flow.request.stream
        assert callable(request_stream)
        assert request_stream(b"partial request") == b"partial request"
        flow.response = tutils.tresp(
            status_code=401,
            headers=header_map({"content-type": "text/plain"}),
            content=b"upstream auth error",
        )
        mitm_addon.responseheaders(flow)
        assert response_stream(flow)(b"upstream auth error") == b"upstream auth error"
        mitm_addon.response(flow)

    assert flow.response.content == b"upstream auth error"
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["status"] == 401
    assert entry["request_size"] == len(b"partial request")
    assert "firewall_error" not in entry
    assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
    assert metadata_keys.REQUEST_STREAM_BUFFER_STATE not in flow.metadata


def test_streamed_query_authenticated_connector_401_before_request_keeps_upstream_response(
    tmp_path, real_flow, mitm_ctx
):
    write_connector_diagnostic_catalog_cache(tmp_path)
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_sandbox_without_firewalls(
            tmp_path, sandbox_fields={"captureNetworkBodies": True}
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro?api_key=user-token",
        method="POST",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.requestheaders(flow)
        request_stream = flow.request.stream
        assert callable(request_stream)
        assert request_stream(b"partial request") == b"partial request"
        flow.response = tutils.tresp(
            status_code=401,
            headers=header_map({"content-type": "text/plain"}),
            content=b"upstream query auth error",
        )
        mitm_addon.responseheaders(flow)
        assert response_stream(flow)(b"upstream query auth error") == b"upstream query auth error"
        mitm_addon.response(flow)

    assert flow.response.content == b"upstream query auth error"
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["status"] == 401
    assert entry["request_size"] == len(b"partial request")
    assert "firewall_error" not in entry
    assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
    assert metadata_keys.REQUEST_STREAM_BUFFER_STATE not in flow.metadata


def test_streamed_browser_connector_403_before_request_keeps_upstream_response(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_sandbox_without_firewalls(
            tmp_path, sandbox_fields={"captureNetworkBodies": True}
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro",
        method="POST",
        request_headers=headers(
            ("Host", "fal.run"),
            (
                "User-Agent",
                "Mozilla/5.0 AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
            ),
        ),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.requestheaders(flow)
        request_stream = flow.request.stream
        assert callable(request_stream)
        assert request_stream(b"partial request") == b"partial request"
        flow.response = tutils.tresp(
            status_code=403,
            headers=header_map({"content-type": "text/plain"}),
            content=b"browser upstream body",
        )
        mitm_addon.responseheaders(flow)
        assert response_stream(flow)(b"browser upstream body") == b"browser upstream body"
        mitm_addon.response(flow)

    assert flow.response.content == b"browser upstream body"
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["status"] == 403
    assert entry["request_size"] == len(b"partial request")
    assert entry["browser_user_agent"] is True
    assert "firewall_error" not in entry
    assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
    assert metadata_keys.REQUEST_STREAM_BUFFER_STATE not in flow.metadata


def test_streamed_api_allow_response_before_request_logs_without_firewall_context(
    tmp_path, real_flow, mitm_ctx
):
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_sandbox_without_firewalls(
            tmp_path, sandbox_fields={"captureNetworkBodies": True}
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.okou.ai",
        path="/api/runs",
        method="POST",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.requestheaders(flow)
        request_stream = flow.request.stream
        assert callable(request_stream)
        assert request_stream(b"partial request") == b"partial request"
        flow.response = tutils.tresp(
            status_code=401,
            headers=header_map({"content-type": "text/plain"}),
            content=b"api auth error",
        )
        mitm_addon.responseheaders(flow)
        assert response_stream(flow)(b"api auth error") == b"api auth error"
        mitm_addon.response(flow)

    assert flow.response.content == b"api auth error"
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["action"] == "ALLOW"
    assert entry["status"] == 401
    assert entry["request_size"] == len(b"partial request")
    assert entry["response_size"] == len(b"api auth error")
    assert "firewall_base" not in entry
    assert "firewall_error" not in entry
    assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
    assert metadata_keys.REQUEST_STREAM_BUFFER_STATE not in flow.metadata


async def test_replaces_connector_401_body_when_auth_header_has_empty_bearer_token(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = write_connector_diagnostic_capture_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro",
        method="POST",
        request_headers=headers(
            ("Host", "fal.run"),
            ("Authorization", "Bearer "),
        ),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        record_connector_diagnostic_requestheaders_context(flow)
        flow.response = tutils.tresp(
            status_code=401,
            headers=header_map({"content-type": "text/plain"}),
            content=b"upstream empty auth error",
        )
        mitm_addon.responseheaders(flow)
        diagnostic_body = _drain_connector_diagnostic_response_stream(flow)
        mitm_addon.response(flow)

    content = flow.response.content
    assert content is not None
    assert content == diagnostic_body
    body = json.loads(content)
    assert body["error"] == "connector_not_configured_for_run"
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["firewall_error"] == "connector_not_configured_for_run"


async def test_replaces_connector_401_body_when_only_proxy_authorization_is_present(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = write_connector_diagnostic_capture_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro",
        method="POST",
        request_headers=headers(
            ("Host", "fal.run"),
            ("Proxy-Authorization", "Basic proxy-secret"),
        ),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        record_connector_diagnostic_requestheaders_context(flow)
        flow.response = tutils.tresp(
            status_code=401,
            headers=header_map({"content-type": "text/plain"}),
            content=b"upstream proxy auth error",
        )
        mitm_addon.responseheaders(flow)
        diagnostic_body = _drain_connector_diagnostic_response_stream(flow)
        mitm_addon.response(flow)

    content = flow.response.content
    assert content is not None
    assert content == diagnostic_body
    body = json.loads(content)
    assert body["error"] == "connector_not_configured_for_run"
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["firewall_error"] == "connector_not_configured_for_run"


async def test_replaces_connector_401_body_when_auth_header_has_empty_key_token(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = write_connector_diagnostic_capture_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro",
        method="POST",
        request_headers=headers(
            ("Host", "fal.run"),
            ("Authorization", "Key "),
        ),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        record_connector_diagnostic_requestheaders_context(flow)
        flow.response = tutils.tresp(
            status_code=401,
            headers=header_map({"content-type": "text/plain"}),
            content=b"upstream empty key auth error",
        )
        mitm_addon.responseheaders(flow)
        diagnostic_body = _drain_connector_diagnostic_response_stream(flow)
        mitm_addon.response(flow)

    content = flow.response.content
    assert content is not None
    assert content == diagnostic_body
    body = json.loads(content)
    assert body["error"] == "connector_not_configured_for_run"
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["firewall_error"] == "connector_not_configured_for_run"


async def test_replaces_connector_401_body_when_auth_query_param_is_empty(
    tmp_path, real_flow, mitm_ctx
):
    reg_path = write_connector_diagnostic_capture_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro?api_key=",
        method="POST",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        record_connector_diagnostic_requestheaders_context(flow)
        flow.response = tutils.tresp(
            status_code=401,
            headers=header_map({"content-type": "text/plain"}),
            content=b"upstream empty query auth error",
        )
        mitm_addon.responseheaders(flow)
        diagnostic_body = _drain_connector_diagnostic_response_stream(flow)
        mitm_addon.response(flow)

    content = flow.response.content
    assert content is not None
    assert content == diagnostic_body
    body = json.loads(content)
    assert body["error"] == "connector_not_configured_for_run"
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["firewall_error"] == "connector_not_configured_for_run"


async def test_preserves_connector_401_body_when_user_auth_is_present(
    tmp_path, real_flow, mitm_ctx, headers
):
    write_connector_diagnostic_catalog_cache(tmp_path)
    reg_path = _write_registry(tmp_path, sandbox_info=_sandbox_without_firewalls(tmp_path))
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro",
        method="POST",
        request_headers=headers(
            ("Host", "fal.run"),
            ("Authorization", "Key user-provided"),
        ),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        await mitm_addon.request(flow)
        flow.response = tutils.tresp(
            status_code=401,
            headers=header_map({"content-type": "text/plain"}),
            content=b"upstream auth error",
        )
        mitm_addon.responseheaders(flow)
        assert metadata_keys.CONNECTOR_DIAGNOSTIC_SLUG not in flow.metadata
        assert metadata_keys.CONNECTOR_DIAGNOSTIC_REASON not in flow.metadata
        assert metadata_keys.CONNECTOR_DIAGNOSTIC_ENV_NAMES not in flow.metadata
        assert metadata_keys.CONNECTOR_DIAGNOSTIC_BASE not in flow.metadata
        mitm_addon.response(flow)

    assert flow.response.status_code == 401
    assert flow.response.content == b"upstream auth error"
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert "firewall_error" not in entry


async def test_preserves_model_provider_401_body_without_connector_diagnostic(
    tmp_path, real_flow, mitm_ctx
):
    reg_path = _write_registry(tmp_path, sandbox_info=_sandbox_without_firewalls(tmp_path))
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.openai.com",
        path="/v1/responses",
        method="POST",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        await mitm_addon.request(flow)
        assert metadata_keys.CONNECTOR_DIAGNOSTIC_SLUG not in flow.metadata
        flow.response = tutils.tresp(
            status_code=401,
            headers=header_map({"content-type": "application/json"}),
            content=b'{"error":"provider auth error"}',
        )
        mitm_addon.response(flow)

    assert flow.response.status_code == 401
    assert flow.response.content == b'{"error":"provider auth error"}'
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["status"] == 401
    assert "firewall_error" not in entry


async def test_preserves_connector_401_body_when_query_auth_is_present(
    tmp_path, real_flow, mitm_ctx
):
    write_connector_diagnostic_catalog_cache(tmp_path)
    reg_path = _write_registry(tmp_path, sandbox_info=_sandbox_without_firewalls(tmp_path))
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro?auth=token",
        method="POST",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        await mitm_addon.request(flow)
        flow.response = tutils.tresp(
            status_code=401,
            headers=header_map({"content-type": "text/plain"}),
            content=b"upstream query auth error",
        )
        mitm_addon.response(flow)

    assert flow.response.status_code == 401
    assert flow.response.content == b"upstream query auth error"
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert "firewall_error" not in entry


async def test_cached_connector_candidate_keeps_specific_query_auth_hint(
    tmp_path, real_flow, mitm_ctx
):
    write_connector_diagnostic_catalog_cache(tmp_path)
    reg_path = _write_registry(tmp_path, sandbox_info=_sandbox_without_firewalls(tmp_path))
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.openweathermap.org",
        path="/data/2.5/weather?appid=user-token",
        method="GET",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        await mitm_addon.request(flow)
        flow.response = tutils.tresp(
            status_code=401,
            headers=header_map({"content-type": "text/plain"}),
            content=b"upstream query auth error",
        )
        mitm_addon.responseheaders(flow)
        flow.metadata[metadata_keys.CONNECTOR_DIAGNOSTIC_SLUG] = "openweather"
        flow.metadata[metadata_keys.CONNECTOR_DIAGNOSTIC_REASON] = "not_configured_for_run"
        flow.metadata[metadata_keys.CONNECTOR_DIAGNOSTIC_ENV_NAMES] = ["OPENWEATHER_TOKEN"]
        flow.metadata[metadata_keys.CONNECTOR_DIAGNOSTIC_BASE] = "https://api.openweathermap.org"
        mitm_addon.response(flow)

    assert flow.response.status_code == 401
    assert flow.response.content == b"upstream query auth error"
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert "firewall_error" not in entry


@pytest.mark.parametrize("status_code", [200, 404, 500])
async def test_preserves_non_auth_connector_response(
    tmp_path,
    real_flow,
    mitm_ctx,
    status_code,
):
    write_connector_diagnostic_catalog_cache(tmp_path)
    reg_path = _write_registry(tmp_path, sandbox_info=_sandbox_without_firewalls(tmp_path))
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro",
        method="POST",
    )
    upstream_body = f"upstream-{status_code}".encode()

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        await mitm_addon.request(flow)
        assert flow.response is None
        flow.response = tutils.tresp(
            status_code=status_code,
            headers=header_map(
                {
                    "content-type": "text/plain",
                    "x-upstream-result": "preserved",
                }
            ),
            content=upstream_body,
        )
        mitm_addon.response(flow)

    assert flow.response.status_code == status_code
    assert flow.response.content == upstream_body
    assert flow.response.headers["x-upstream-result"] == "preserved"
    assert metadata_keys.FIREWALL_ERROR not in flow.metadata
    assert metadata_keys.CONNECTOR_DIAGNOSTIC_SLUG not in flow.metadata
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["status"] == status_code
    assert "firewall_error" not in entry
    assert "connector_diagnostic_slug" not in entry


async def test_preserves_browser_403_body_for_connector_candidate(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_registry(tmp_path, sandbox_info=_sandbox_without_firewalls(tmp_path))
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro",
        method="POST",
        request_headers=headers(
            ("Host", "fal.run"),
            (
                "User-Agent",
                "Mozilla/5.0 AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
            ),
        ),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        await mitm_addon.request(flow)
        flow.response = tutils.tresp(
            status_code=403,
            headers=header_map({"content-type": "text/plain"}),
            content=b"browser upstream body",
        )
        mitm_addon.response(flow)

    assert flow.response.content == b"browser upstream body"
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["browser_user_agent"] is True
