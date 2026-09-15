"""Platform API requestheaders upstream-admission tests."""

from pathlib import Path

from mitmproxy import connection, http

import flow_metadata_keys as metadata_keys
import mitm_addon
import platform_api
import platform_api_url
import request_classification
import upstream_admission
import upstream_destination_binding
from body_limits import STREAM_BUFFER_LIMIT
from tests.request_handler_helpers import _sandbox_without_firewalls, _write_registry
from tests.requestheaders_helpers import (
    _assert_no_request_stream,
    track_trusted_authority_validations,
)
from tests.upstream_connection_helpers import (
    mark_connected_tls_upstream,
    seed_server_binding,
)


def _write_api_registry(tmp_path: Path, *, capture_network_bodies: bool) -> Path:
    sandbox_fields: dict[str, object] | None = (
        {"captureNetworkBodies": True} if capture_network_bodies else None
    )
    return _write_registry(
        tmp_path,
        sandbox_info=_sandbox_without_firewalls(tmp_path, sandbox_fields=sandbox_fields),
    )


async def test_api_destination_derivation_reuses_and_refreshes_effective_option(
    tmp_path, real_flow, mitm_ctx, monkeypatch
):
    reg_path = _write_api_registry(tmp_path, capture_network_bodies=False)
    parsed_api_urls: list[str] = []
    parsed_api_hosts: list[str] = []
    parse_api_url = platform_api_url.parse_platform_api_url

    def track_api_url_parse(
        api_url: str,
    ) -> platform_api_url.PlatformApiUrl:
        parsed_api_urls.append(api_url)
        parsed_url = parse_api_url(api_url)
        parsed_api_hosts.append(parsed_url.host)
        return parsed_url

    monkeypatch.setattr(platform_api_url, "parse_platform_api_url", track_api_url_parse)

    def api_flow(*, host: str, scheme: str = "https", port: int = 443) -> http.HTTPFlow:
        return real_flow(
            with_response=False,
            client_ip="10.200.0.5",
            host=host,
            scheme=scheme,
            port=port,
            method="POST",
            path="/api/runs/heartbeat",
        )

    async def drive_request(flow: http.HTTPFlow) -> None:
        assert mitm_addon.requestheaders(flow) is None
        await mitm_addon.request(flow)

    initial_api_url = "HTTPS://API.OKOU.AI"
    with mitm_ctx(registry_path=str(reg_path), api_url=initial_api_url):
        initial_flows = [
            api_flow(host="api.okou.ai"),
            api_flow(host="jobs.api.okou.ai"),
        ]
        for flow in initial_flows:
            await drive_request(flow)
            assert flow.response is None

        assert parsed_api_urls == [initial_api_url]
        assert parsed_api_hosts == ["api.okou.ai"]

        updated_api_url = "http://API.PREVIEW.OKOU.AI:8080"
        mitm_addon.ctx.options.okou_api_url = updated_api_url
        mitm_addon.configure({"okou_api_url"})
        updated_flow = api_flow(
            host="jobs.api.preview.okou.ai",
            scheme="http",
            port=8080,
        )
        await drive_request(updated_flow)

        assert updated_flow.response is None
        updated_binding = upstream_destination_binding.binding_snapshot_for_tests()[
            updated_flow.server_conn.id
        ]
        assert updated_binding.host == "jobs.api.preview.okou.ai"
        assert updated_binding.port == 8080
        assert updated_binding.kinds == frozenset(("api_allow",))
        assert parsed_api_urls == [initial_api_url, updated_api_url]
        assert parsed_api_hosts == ["api.okou.ai", "api.preview.okou.ai"]

        invalid_api_url = "ftp://api.invalid.okou.ai"
        mitm_addon.ctx.options.okou_api_url = invalid_api_url
        mitm_addon.configure({"okou_api_url"})
        invalid_flows = [
            api_flow(host="api.invalid.okou.ai"),
            api_flow(host="jobs.api.invalid.okou.ai"),
        ]
        for flow in invalid_flows:
            await drive_request(flow)
            assert flow.response is None

    bindings = upstream_destination_binding.binding_snapshot_for_tests()
    assert all(flow.server_conn.id not in bindings for flow in invalid_flows)
    assert parsed_api_urls == [initial_api_url, updated_api_url, invalid_api_url]
    assert parsed_api_hosts == ["api.okou.ai", "api.preview.okou.ai"]


async def test_capture_enabled_api_allow_retargets_unconnected_upstream(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_api_registry(tmp_path, capture_network_bodies=True)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.okou.ai",
        method="POST",
        path="/api/webhooks/agent/heartbeat",
        request_headers=headers(
            ("Host", "api.okou.ai"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.requestheaders(flow)

        assert callable(flow.request.stream)
        assert flow.server_conn.address == ("api.okou.ai", 443)

        await mitm_addon.request(flow)

    assert flow.response is None
    assert request_classification.REQUEST_CLASSIFICATION_METADATA_KEY not in flow.metadata
    assert flow.metadata[metadata_keys.REQUEST_STREAM_COMPLETE] is True
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.host == "api.okou.ai"
    assert binding.kinds == frozenset(("api_allow",))
    assert binding.original_address == ("203.0.113.10", 443)


async def test_streamed_api_allow_injects_runner_preview_bypass_before_body(
    tmp_path, real_flow, mitm_ctx, headers, monkeypatch
):
    reg_path = _write_api_registry(tmp_path, capture_network_bodies=True)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="preview-api.vm6.ai",
        method="POST",
        path="/api/chat/events",
        request_headers=headers(
            ("Host", "preview-api.vm6.ai"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )
    monkeypatch.setattr(platform_api, "VERCEL_BYPASS", "preview-secret")

    with mitm_ctx(
        registry_path=str(reg_path),
        api_url="https://preview-api.vm6.ai",
    ):
        mitm_addon.requestheaders(flow)

    assert callable(flow.request.stream)
    assert flow.request.headers["x-vercel-protection-bypass"] == "preview-secret"


async def test_bounded_unsafe_platform_path_does_not_prebind_before_request_denial(
    tmp_path, real_flow, mitm_ctx, headers, monkeypatch
):
    reg_path = _write_api_registry(tmp_path, capture_network_bodies=False)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="preview-api.vm6.ai",
        method="POST",
        path="/api/ordinary/../test/example",
        request_headers=headers(
            ("Host", "preview-api.vm6.ai"),
            ("Content-Length", "4"),
        ),
    )
    monkeypatch.setattr(platform_api, "VERCEL_BYPASS", "preview-secret")

    with mitm_ctx(
        registry_path=str(reg_path),
        api_url="https://preview-api.vm6.ai",
    ):
        mitm_addon.requestheaders(flow)

        _assert_no_request_stream(flow)
        assert flow.response is None
        assert "x-vercel-protection-bypass" not in flow.request.headers
        assert upstream_destination_binding.binding_snapshot_for_tests() == {}

        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "unsafe_platform_path"
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


async def test_streamed_unsafe_platform_path_does_not_start_stream_before_request_denial(
    tmp_path, real_flow, mitm_ctx, headers, monkeypatch
):
    reg_path = _write_api_registry(tmp_path, capture_network_bodies=True)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="preview-api.vm6.ai",
        method="POST",
        path="/api/ordinary/%2e%2e/test/example",
        request_headers=headers(
            ("Host", "preview-api.vm6.ai"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )
    monkeypatch.setattr(platform_api, "VERCEL_BYPASS", "preview-secret")

    with mitm_ctx(
        registry_path=str(reg_path),
        api_url="https://preview-api.vm6.ai",
    ):
        mitm_addon.requestheaders(flow)

        _assert_no_request_stream(flow)
        assert flow.response is None
        assert "x-vercel-protection-bypass" not in flow.request.headers
        assert upstream_destination_binding.binding_snapshot_for_tests() == {}

        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "unsafe_platform_path"
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


async def test_streamed_wrong_scheme_does_not_receive_runner_preview_bypass(
    tmp_path, real_flow, mitm_ctx, headers, monkeypatch
):
    reg_path = _write_api_registry(tmp_path, capture_network_bodies=True)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="preview-api.vm6.ai",
        scheme="http",
        port=443,
        method="POST",
        path="/api/chat/events",
        request_headers=headers(
            ("Host", "preview-api.vm6.ai:443"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )
    monkeypatch.setattr(platform_api, "VERCEL_BYPASS", "preview-secret")

    with mitm_ctx(
        registry_path=str(reg_path),
        api_url="https://preview-api.vm6.ai",
    ):
        mitm_addon.requestheaders(flow)

        assert callable(flow.request.stream)
        assert "x-vercel-protection-bypass" not in flow.request.headers
        assert upstream_destination_binding.binding_snapshot_for_tests() == {}

        await mitm_addon.request(flow)

    assert flow.response is None
    assert "x-vercel-protection-bypass" not in flow.request.headers
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


async def test_cached_api_allow_revalidates_scheme_before_final_bypass_injection(
    tmp_path, real_flow, mitm_ctx, headers, monkeypatch
):
    reg_path = _write_api_registry(tmp_path, capture_network_bodies=True)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="preview-api.vm6.ai",
        method="POST",
        path="/api/chat/events",
        request_headers=headers(
            ("Host", "preview-api.vm6.ai"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )
    monkeypatch.setattr(platform_api, "VERCEL_BYPASS", "")

    with mitm_ctx(
        registry_path=str(reg_path),
        api_url="https://preview-api.vm6.ai",
    ):
        mitm_addon.requestheaders(flow)

        assert callable(flow.request.stream)
        assert request_classification.REQUEST_CLASSIFICATION_METADATA_KEY in flow.metadata
        assert "x-vercel-protection-bypass" not in flow.request.headers

        flow.request.scheme = "http"
        monkeypatch.setattr(platform_api, "VERCEL_BYPASS", "preview-secret")
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "upstream_destination_unbound"
    assert "x-vercel-protection-bypass" not in flow.request.headers


async def test_capture_enabled_api_allow_blocks_connected_unbound_edge_upstream(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_api_registry(tmp_path, capture_network_bodies=True)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.okou.ai",
        method="POST",
        path="/api/webhooks/agent/heartbeat",
        request_headers=headers(
            ("Host", "api.okou.ai"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )
    flow.server_conn.peername = ("203.0.113.10", 443)
    flow.server_conn.state = connection.ConnectionState.OPEN

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.requestheaders(flow)
        _assert_no_request_stream(flow)

        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "upstream_destination_unbound"
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


async def test_capture_enabled_api_allow_uses_authenticated_connected_edge_upstream(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_api_registry(tmp_path, capture_network_bodies=True)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.okou.ai",
        method="POST",
        path="/api/webhooks/agent/heartbeat",
        request_headers=headers(
            ("Authorization", "Bearer tok-conn"),
            ("Host", "api.okou.ai"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )
    mark_connected_tls_upstream(
        flow,
        sni="api.okou.ai",
        server_address=("203.0.113.10", 443),
        peername=("203.0.113.10", 443),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.requestheaders(flow)
        assert callable(flow.request.stream)

        await mitm_addon.request(flow)

    assert flow.response is None
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.host == "api.okou.ai"
    assert binding.kinds == frozenset(("api_allow",))
    assert binding.original_address == ("203.0.113.10", 443)


async def test_capture_enabled_api_allow_uses_connected_upstream_address_when_tls_verified(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_api_registry(tmp_path, capture_network_bodies=True)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="198.18.20.34",
        sni="api.okou.ai",
        method="POST",
        path="/api/webhooks/agent/heartbeat",
        request_headers=headers(
            ("Host", "api.okou.ai"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )
    mark_connected_tls_upstream(
        flow,
        sni="api.okou.ai",
        server_address=("api.okou.ai", 443),
        peername=None,
        client_sockname=("198.18.20.34", 443),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.requestheaders(flow)

        assert callable(flow.request.stream)
        assert flow.server_conn.address == ("api.okou.ai", 443)

        await mitm_addon.request(flow)

    assert flow.response is None
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.host == "api.okou.ai"
    assert binding.kinds == frozenset(("api_allow",))
    assert binding.original_address == ("198.18.20.34", 443)


async def test_capture_enabled_api_allow_uses_prior_client_binding_when_server_conn_changes(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_api_registry(tmp_path, capture_network_bodies=True)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="127.0.0.1",
        sni="api.okou.ai",
        method="POST",
        path="/api/webhooks/agent/heartbeat",
        request_headers=headers(
            ("Host", "api.okou.ai"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )
    mark_connected_tls_upstream(
        flow,
        sni="api.okou.ai",
        server_address=("127.0.0.1", 443),
        peername=None,
        client_sockname=("198.18.20.34", 443),
    )

    server_connect_server = connection.Server(address=("198.18.20.34", 443))
    seed_server_binding(
        server_connect_server,
        client=flow.client_conn,
        host="api.okou.ai",
        port=443,
        kinds=frozenset(("api_allow",)),
        original_address=("198.18.20.34", 443),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.requestheaders(flow)
        assert callable(flow.request.stream)

        await mitm_addon.request(flow)

    assert flow.response is None
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.host == "api.okou.ai"
    assert binding.kinds == frozenset(("api_allow",))
    assert binding.original_address == ("198.18.20.34", 443)


async def test_api_allow_prior_client_binding_endpoint_mismatch_blocks(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_api_registry(tmp_path, capture_network_bodies=True)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="127.0.0.1",
        sni="api.okou.ai",
        method="POST",
        path="/api/webhooks/agent/heartbeat",
        request_headers=headers(
            ("Host", "api.okou.ai"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )
    flow.server_conn.state = connection.ConnectionState.OPEN
    flow.client_conn.sockname = ("203.0.113.10", 443)

    server_connect_server = connection.Server(address=("198.18.20.34", 443))
    seed_server_binding(
        server_connect_server,
        client=flow.client_conn,
        host="api.okou.ai",
        port=443,
        kinds=frozenset(("api_allow",)),
        original_address=("198.18.20.34", 443),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.requestheaders(flow)
        _assert_no_request_stream(flow)

        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "upstream_destination_unbound"
    assert (
        upstream_admission.upstream_binding_diagnostics_for_tests(flow)[
            "client_binding_endpoint_match"
        ]
        is False
    )


async def test_api_allow_current_server_binding_mismatch_blocks_even_with_prior_client_binding(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_api_registry(tmp_path, capture_network_bodies=True)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="127.0.0.1",
        sni="api.okou.ai",
        method="POST",
        path="/api/webhooks/agent/heartbeat",
        request_headers=headers(
            ("Host", "api.okou.ai"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )
    flow.server_conn.state = connection.ConnectionState.OPEN

    server_connect_server = connection.Server(address=("198.18.20.34", 443))
    seed_server_binding(
        server_connect_server,
        client=flow.client_conn,
        host="api.okou.ai",
        port=443,
        kinds=frozenset(("api_allow",)),
        original_address=("198.18.20.34", 443),
    )
    seed_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        host="attacker.example.com",
        port=443,
        kinds=frozenset(("api_allow",)),
        original_address=("203.0.113.10", 443),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.requestheaders(flow)
        _assert_no_request_stream(flow)

        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "upstream_destination_unbound"


async def test_api_allow_small_bounded_body_retargets_unconnected_upstream(
    tmp_path, real_flow, mitm_ctx, headers, monkeypatch
):
    reg_path = _write_api_registry(tmp_path, capture_network_bodies=False)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.okou.ai",
        method="POST",
        path="/api/webhooks/agent/heartbeat",
        request_headers=headers(
            ("Host", "api.okou.ai"),
            ("Content-Length", "4"),
        ),
    )
    validated_flows = track_trusted_authority_validations(monkeypatch)

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        assert mitm_addon.requestheaders(flow) is None

        assert validated_flows == [flow]
        _assert_no_request_stream(flow)
        assert metadata_keys.SANDBOX_RUN_ID not in flow.metadata
        assert metadata_keys.ORIGINAL_URL not in flow.metadata
        assert flow.server_conn.address == ("api.okou.ai", 443)

        await mitm_addon.request(flow)

    assert validated_flows == [flow, flow]
    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.host == "api.okou.ai"
    assert binding.kinds == frozenset(("api_allow",))
    assert binding.original_address == ("203.0.113.10", 443)


async def test_api_allow_unknown_body_length_retargets_unconnected_upstream(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_api_registry(tmp_path, capture_network_bodies=False)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.okou.ai",
        method="POST",
        path="/api/webhooks/agent/heartbeat",
        request_headers=headers(("Host", "api.okou.ai")),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        assert mitm_addon.requestheaders(flow) is None

        _assert_no_request_stream(flow)
        assert metadata_keys.SANDBOX_RUN_ID not in flow.metadata
        assert metadata_keys.ORIGINAL_URL not in flow.metadata
        assert flow.server_conn.address == ("api.okou.ai", 443)

        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.host == "api.okou.ai"
    assert binding.kinds == frozenset(("api_allow",))
    assert binding.original_address == ("203.0.113.10", 443)


def test_api_allow_bounded_prebind_ignores_unregistered_client(
    registry_file, real_flow, mitm_ctx, headers
):
    flow = real_flow(
        with_response=False,
        client_ip="192.168.99.99",
        host="203.0.113.10",
        sni="api.okou.ai",
        method="POST",
        path="/api/webhooks/agent/heartbeat",
        request_headers=headers(
            ("Host", "api.okou.ai"),
            ("Content-Length", "4"),
        ),
    )

    with mitm_ctx(registry_path=str(registry_file), api_url="https://api.okou.ai"):
        assert mitm_addon.requestheaders(flow) is None

    _assert_no_request_stream(flow)
    assert metadata_keys.SANDBOX_RUN_ID not in flow.metadata
    assert metadata_keys.ORIGINAL_URL not in flow.metadata
    assert flow.server_conn.address == ("203.0.113.10", 443)
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}
