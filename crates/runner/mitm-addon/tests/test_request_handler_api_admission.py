"""Platform API admission request hook integration tests."""

import json

import pytest
from mitmproxy import connection

import flow_metadata_keys as metadata_keys
import mitm_addon
import platform_api
import platform_api_url
import registry
import request_classification
import upstream_destination_binding
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry
from tests.upstream_connection_helpers import (
    bind_flow_upstream,
    mark_connected_tls_upstream,
)


async def test_matching_sni_and_host_blocks_connected_platform_api_edge_when_unbound(
    registry_file, real_flow, mitm_ctx, headers
):
    flow = real_flow(
        with_response=False,
        host="203.0.113.10",
        sni="api.okou.ai",
        path="/api/webhooks/agent/heartbeat",
        request_headers=headers(("Host", "api.okou.ai")),
    )
    flow.server_conn.state = connection.ConnectionState.OPEN

    with mitm_ctx(registry_path=str(registry_file), api_url="https://api.okou.ai"):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == "upstream_destination_unbound"
    assert body["reason"] == "api_allow"
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"


async def test_matching_sni_and_host_allows_authenticated_connected_platform_api_edge(
    registry_file, real_flow, mitm_ctx, headers
):
    flow = real_flow(
        with_response=False,
        host="203.0.113.10",
        sni="api.okou.ai",
        method="POST",
        path="/api/webhooks/agent/heartbeat",
        request_headers=headers(
            ("Authorization", "Bearer tok-xyz"),
            ("Host", "api.okou.ai"),
        ),
    )
    mark_connected_tls_upstream(
        flow,
        sni="api.okou.ai",
        server_address=("203.0.113.10", 443),
        peername=("203.0.113.10", 443),
    )

    with mitm_ctx(registry_path=str(registry_file), api_url="https://api.okou.ai"):
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.host == "api.okou.ai"
    assert binding.kinds == frozenset(("api_allow",))
    assert binding.original_address == ("203.0.113.10", 443)


async def test_matching_sni_and_host_retargets_unconnected_platform_api_auto_allow(
    registry_file, real_flow, mitm_ctx, headers
):
    flow = real_flow(
        with_response=False,
        host="203.0.113.10",
        sni="api.okou.ai",
        path="/api/runs/heartbeat",
        request_headers=headers(("Host", "api.okou.ai")),
    )

    with mitm_ctx(registry_path=str(registry_file), api_url="https://api.okou.ai"):
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.server_conn.address == ("api.okou.ai", 443)
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.host == "api.okou.ai"
    assert binding.kinds == frozenset(("api_allow",))
    assert binding.original_address == ("203.0.113.10", 443)


async def test_platform_api_auto_allow_injects_runner_preview_bypass(
    registry_file, real_flow, mitm_ctx, monkeypatch
):
    flow = real_flow(
        with_response=False,
        host="preview-api.vm6.ai",
        path="/api/chat-threads/thread-id/metadata",
    )
    monkeypatch.setattr(platform_api, "VERCEL_BYPASS", "preview-secret")

    with mitm_ctx(
        registry_path=str(registry_file),
        api_url="https://preview-api.vm6.ai",
    ):
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.request.headers["x-vercel-protection-bypass"] == "preview-secret"


@pytest.mark.parametrize(
    "path",
    [
        pytest.param("/api/ordinary/../test/example", id="literal-dot-segment"),
        pytest.param(
            "/api/ordinary/%2e%2e/test/example",
            id="encoded-dot-segment",
        ),
        pytest.param("/api\\test\\example", id="backslash"),
        pytest.param("/api/ordinary/%zz/test/example", id="malformed-escape"),
    ],
)
async def test_platform_api_unsafe_paths_fail_closed_before_binding_or_bypass(
    registry_file, real_flow, mitm_ctx, monkeypatch, path
):
    flow = real_flow(
        with_response=False,
        host="preview-api.vm6.ai",
        path=path,
    )
    monkeypatch.setattr(platform_api, "VERCEL_BYPASS", "preview-secret")

    with mitm_ctx(
        registry_path=str(registry_file),
        api_url="https://preview-api.vm6.ai",
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    assert json.loads(flow.response.content) == {
        "error": "unsafe_platform_path",
        "message": "Request blocked: unsafe platform API path",
    }
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "unsafe_platform_path"
    assert "x-vercel-protection-bypass" not in flow.request.headers
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


async def test_platform_api_unsafe_browser_path_does_not_fall_through_to_browser_allow(
    registry_file, real_flow, mitm_ctx, headers, monkeypatch
):
    flow = real_flow(
        with_response=False,
        host="preview-api.vm6.ai",
        path="/api/ordinary/../test/example",
        request_headers=headers(
            ("Host", "preview-api.vm6.ai"),
            ("User-Agent", "Mozilla/5.0 Chrome/151.0.0.0 Safari/537.36"),
        ),
    )
    monkeypatch.setattr(platform_api, "VERCEL_BYPASS", "preview-secret")

    with mitm_ctx(
        registry_path=str(registry_file),
        api_url="https://preview-api.vm6.ai",
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "unsafe_platform_path"
    assert flow.metadata[metadata_keys.BROWSER_USER_AGENT] is True
    assert "x-vercel-protection-bypass" not in flow.request.headers
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


async def test_platform_api_safe_repeated_separator_path_remains_auto_allowed(
    registry_file, real_flow, mitm_ctx, monkeypatch
):
    flow = real_flow(
        with_response=False,
        host="preview-api.vm6.ai",
        path="/api//test/example",
    )
    monkeypatch.setattr(platform_api, "VERCEL_BYPASS", "preview-secret")

    with mitm_ctx(
        registry_path=str(registry_file),
        api_url="https://preview-api.vm6.ai",
    ):
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.request.headers["x-vercel-protection-bypass"] == "preview-secret"
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.kinds == frozenset(("api_allow",))


async def test_non_api_request_does_not_receive_runner_preview_bypass(
    registry_file, real_flow, mitm_ctx, monkeypatch
):
    flow = real_flow(with_response=False, host="example.com", path="/resource")
    monkeypatch.setattr(platform_api, "VERCEL_BYPASS", "preview-secret")

    with mitm_ctx(
        registry_path=str(registry_file),
        api_url="https://preview-api.vm6.ai",
    ):
        await mitm_addon.request(flow)

    assert "x-vercel-protection-bypass" not in flow.request.headers


async def test_matching_sni_and_host_allows_bound_platform_api_auto_allow(
    registry_file, real_flow, mitm_ctx, headers
):
    flow = real_flow(
        with_response=False,
        host="203.0.113.10",
        sni="api.okou.ai",
        path="/api/runs/heartbeat",
        request_headers=headers(("Host", "api.okou.ai")),
    )
    bind_flow_upstream(flow, host="api.okou.ai", kinds=frozenset(("api_allow",)))

    with mitm_ctx(registry_path=str(registry_file), api_url="https://api.okou.ai"):
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"


@pytest.mark.parametrize(
    ("api_url", "host", "scheme", "port", "expected_api_allow"),
    [
        pytest.param(
            "https://api.okou.ai",
            "api.okou.ai",
            "https",
            443,
            True,
            id="https-default-port",
        ),
        pytest.param(
            "http://api.okou.ai",
            "api.okou.ai",
            "http",
            80,
            True,
            id="http-default-port",
        ),
        pytest.param(
            "https://api.okou.ai:8443",
            "api.okou.ai",
            "https",
            8443,
            True,
            id="explicit-non-default-port",
        ),
        pytest.param(
            "https://api.okou.ai",
            "preview.api.okou.ai",
            "https",
            443,
            True,
            id="subdomain",
        ),
        pytest.param(
            "https://api.okou.ai",
            "notapi.okou.ai",
            "https",
            443,
            False,
            id="adjacent-label",
        ),
        pytest.param(
            "https://api.okou.ai",
            "api.okou.ai.example.com",
            "https",
            443,
            False,
            id="superdomain",
        ),
        pytest.param(
            "https://api.okou.ai",
            "api.okou.ai",
            "https",
            8443,
            False,
            id="wrong-default-port",
        ),
        pytest.param(
            "https://api.okou.ai:8443",
            "api.okou.ai",
            "https",
            443,
            False,
            id="wrong-explicit-port",
        ),
        pytest.param(
            "https://api.okou.ai",
            "api.okou.ai",
            "http",
            443,
            False,
            id="https-configured-http-observed",
        ),
        pytest.param(
            "http://api.okou.ai:443",
            "api.okou.ai",
            "https",
            443,
            False,
            id="http-configured-https-observed",
        ),
    ],
)
async def test_platform_api_auto_allow_respects_authority_boundary(
    registry_file,
    real_flow,
    mitm_ctx,
    monkeypatch,
    api_url,
    host,
    scheme,
    port,
    expected_api_allow,
):
    flow = real_flow(
        with_response=False,
        host=host,
        scheme=scheme,
        port=port,
    )
    monkeypatch.setattr(platform_api, "VERCEL_BYPASS", "preview-secret")

    with (
        mitm_ctx(registry_path=str(registry_file), api_url=api_url),
    ):
        await mitm_addon.request(flow)

    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    bindings = upstream_destination_binding.binding_snapshot_for_tests()
    if expected_api_allow:
        binding = bindings[flow.server_conn.id]
        assert binding.host == host
        assert binding.port == port
        assert binding.kinds == frozenset(("api_allow",))
        assert flow.request.headers["x-vercel-protection-bypass"] == "preview-secret"
    else:
        assert bindings == {}
        assert "x-vercel-protection-bypass" not in flow.request.headers


async def test_malformed_platform_api_url_is_cached_as_non_match(
    registry_file,
    real_flow,
    mitm_ctx,
    monkeypatch,
    malformed_platform_api_url,
):
    parsed_api_urls: list[str] = []
    parse_api_url = platform_api_url.parse_platform_api_url

    def track_api_url_parse(
        api_url: str,
    ) -> platform_api_url.PlatformApiUrl:
        parsed_api_urls.append(api_url)
        return parse_api_url(api_url)

    monkeypatch.setattr(platform_api_url, "parse_platform_api_url", track_api_url_parse)
    flows = [
        real_flow(with_response=False, host="api.okou.ai"),
        real_flow(with_response=False, host="api.okou.ai"),
    ]
    monkeypatch.setattr(platform_api, "VERCEL_BYPASS", "preview-secret")

    with mitm_ctx(
        registry_path=str(registry_file),
        api_url=malformed_platform_api_url,
    ):
        for flow in flows:
            await mitm_addon.request(flow)

        assert parsed_api_urls == [malformed_platform_api_url]

        updated_api_url = "ftp://api.okou.ai"
        mitm_addon.ctx.options.okou_api_url = updated_api_url
        mitm_addon.configure({"okou_api_url"})
        updated_flow = real_flow(with_response=False, host="api.okou.ai")
        flows.append(updated_flow)
        await mitm_addon.request(updated_flow)

    for flow in flows:
        assert flow.response is None
        assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
        assert "x-vercel-protection-bypass" not in flow.request.headers
    assert parsed_api_urls == [malformed_platform_api_url, updated_api_url]
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


async def test_platform_api_wrong_port_uses_matching_firewall_deny_policy(
    tmp_path,
    real_flow,
    mitm_ctx,
):
    reg_path = _write_registry(
        tmp_path,
        client_ip="10.200.0.5",
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            firewall_name="alternate-api-port",
            api_entry={
                "base": "https://api.okou.ai:8443",
                "auth": {"headers": {}},
                "permissions": [{"name": "read", "rules": ["GET /restricted"]}],
            },
            network_policy={
                "allow": [],
                "deny": ["read"],
                "ask": [],
                "unknownPolicy": "allow",
            },
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.okou.ai",
        port=8443,
        path="/restricted",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["reason"] == "permission_denied"
    assert body["permissions"] == ["read"]
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "DENY"
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


async def test_platform_api_wrong_scheme_uses_matching_firewall_deny_policy(
    tmp_path,
    real_flow,
    mitm_ctx,
):
    reg_path = _write_registry(
        tmp_path,
        client_ip="10.200.0.5",
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            firewall_name="plaintext-api-port",
            api_entry={
                "base": "http://api.okou.ai:443",
                "auth": {"headers": {}},
                "permissions": [{"name": "read", "rules": ["GET /restricted"]}],
            },
            network_policy={
                "allow": [],
                "deny": ["read"],
                "ask": [],
                "unknownPolicy": "allow",
            },
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.okou.ai",
        scheme="http",
        port=443,
        path="/restricted",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["reason"] == "permission_denied"
    assert body["permissions"] == ["read"]
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "DENY"
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


async def test_platform_api_wrong_port_uses_normal_connector_auth(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
):
    reg_path = _write_registry(
        tmp_path,
        client_ip="10.200.0.5",
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            firewall_name="alternate-api-port",
            api_entry={
                "base": "https://api.okou.ai:8443",
                "auth": {
                    "headers": {
                        "Authorization": "Bearer ${{ secrets.API_TOKEN }}",
                    }
                },
                "permissions": [{"name": "read", "rules": ["GET /restricted"]}],
            },
            network_policy={
                "allow": ["read"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.okou.ai",
        port=8443,
        path="/restricted",
        request_headers=headers(("Host", "api.okou.ai:8443")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved-api-token"}) as auth_fetch,
    ):
        assert mitm_addon.requestheaders(flow) is None
        binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
        assert binding.host == "api.okou.ai"
        assert binding.port == 8443
        assert binding.kinds == frozenset(("connector_auth",))

        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == "https://api.okou.ai:8443"
    assert flow.request.headers["Authorization"] == "Bearer resolved-api-token"


async def test_registry_unavailable_blocks_platform_api_auto_allow(
    registry_file, real_flow, mitm_ctx
):
    registry.load_registry(str(registry_file))
    registry_file.write_text("{ broken registry")
    flow = real_flow(with_response=False, host="api.okou.ai")

    with mitm_ctx(registry_path=str(registry_file), api_url="https://api.okou.ai"):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 503
    assert json.loads(flow.response.content) == {
        "error": "registry_unavailable",
        "message": "Proxy registry is unavailable",
        "reason": "parse_failed",
    }
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "registry_unavailable"
    assert metadata_keys.SANDBOX_RUN_ID not in flow.metadata


async def test_unknown_cached_classification_does_not_bypass_registry_gate(
    tmp_path,
    real_flow,
    mitm_ctx,
):
    reg_path = tmp_path / "proxy-registry.json"
    reg_path.write_text("{ broken registry")
    flow = real_flow(with_response=False, host="api.okou.ai")
    flow.metadata[request_classification.REQUEST_CLASSIFICATION_METADATA_KEY] = object()

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 503
    assert json.loads(flow.response.content)["error"] == "registry_unavailable"
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"
    assert request_classification.REQUEST_CLASSIFICATION_METADATA_KEY not in flow.metadata


@pytest.mark.parametrize(
    "path",
    [
        pytest.param("/api/test/oauth-provider/echo", id="pathname"),
        pytest.param(
            "/api/test/oauth-provider/echo?visible=1#fragment",
            id="query-and-fragment",
        ),
    ],
)
async def test_platform_api_test_paths_skip_auto_allow(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
    monkeypatch,
    path,
):
    """`/api/test/*` routes exist to exercise the firewall pipeline itself.

    If they entered the platform API auto-allow fast path, the test-oauth E2E test
    would never get proxy-injected Authorization headers and the pipeline it's
    supposed to exercise would be silently bypassed. The carve-out instead lets the
    registered firewall match these paths and run `handle_firewall_request`.
    """
    reg_path = _write_registry(
        tmp_path,
        client_ip="10.200.0.1",
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            run_id="run-test-oauth",
            sandbox_marker="tok-test",
            firewall_name="test-oauth",
            api_entry={
                "base": "https://api.okou.ai/api/test/oauth-provider",
                "auth": {
                    "headers": {
                        "Authorization": "Bearer ${{ secrets.TEST_OAUTH_TOKEN }}",
                    }
                },
                "permissions": [{"name": "echo", "rules": ["GET /echo"]}],
            },
            network_policy=None,
        ),
    )

    flow = real_flow(
        with_response=False,
        host="api.okou.ai",
        path=path,
        request_headers=headers(
            ("Host", "api.okou.ai"),
            ("x-okou-test-endpoint-bypass", "preview-secret"),
        ),
    )
    monkeypatch.setenv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret")

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(
            headers={"Authorization": "Bearer resolved-test-token"}
        ) as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.request.headers["Authorization"] == "Bearer resolved-test-token"
    assert (
        flow.metadata[metadata_keys.FIREWALL_BASE] == "https://api.okou.ai/api/test/oauth-provider"
    )
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.kinds == frozenset(("connector_auth",))


async def test_platform_api_non_test_paths_auto_allow_before_firewall_auth(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers
):
    reg_path = _write_registry(
        tmp_path,
        client_ip="10.200.0.1",
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            run_id="run-platform-api",
            sandbox_marker="tok-platform",
            firewall_name="platform-api",
            api_entry={
                "base": "https://api.okou.ai",
                "auth": {
                    "headers": {
                        "Authorization": "Bearer ${{ secrets.PLATFORM_API_TOKEN }}",
                    }
                },
                "permissions": [{"name": "runs", "rules": ["GET /api/runs"]}],
            },
            network_policy=None,
        ),
    )
    flow = real_flow(with_response=False, host="api.okou.ai", path="/api/runs")

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert "Authorization" not in flow.request.headers
    assert metadata_keys.FIREWALL_BASE not in flow.metadata
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.kinds == frozenset(("api_allow",))
