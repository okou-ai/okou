"""Connector requestheaders upstream-admission tests."""

import asyncio
import urllib.parse
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from mitmproxy import connection, http

import auth
import flow_metadata_keys as metadata_keys
import mitm_addon
import registry
import request_classification
import upstream_admission
import upstream_destination_binding
from body_limits import STREAM_BUFFER_LIMIT
from tests.firewall_auth_helpers import firewall_auth_response
from tests.firewall_helpers import cancel_pending_task
from tests.request_handler_helpers import (
    _single_firewall_sandbox,
    _write_github_firewall_registry,
    _write_registry,
)
from tests.requestheaders_helpers import (
    _assert_no_request_stream,
    await_requestheaders_result,
    track_trusted_authority_validations,
)
from tests.upstream_connection_helpers import (
    mark_connected_tls_upstream,
    seed_server_binding,
    track_normalized_binding_ip_parses,
)


async def test_firewall_allow_current_server_binding_address_mismatch_blocks(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(
        tmp_path,
        sandbox_fields={"captureNetworkBodies": True},
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.99",
        sni="api.github.com",
        method="POST",
        path="/repos/octocat/hello",
        request_headers=headers(
            ("Host", "api.github.com"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )
    flow.server_conn.address = ("203.0.113.99", 443)
    seed_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        host="api.github.com",
        port=443,
        kinds=frozenset(("connector_auth",)),
        original_address=("172.66.0.243", 443),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        await await_requestheaders_result(requestheaders_result)
        _assert_no_request_stream(flow)
        assert "Authorization" not in flow.request.headers

        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "upstream_destination_unbound"
    diagnostics = upstream_admission.upstream_binding_diagnostics_for_tests(flow)
    assert diagnostics["direct_binding_present"] is True
    assert diagnostics["server_connected"] is False
    assert diagnostics["server_address"] == "203.0.113.99:443"
    assert flow.server_conn.id in upstream_destination_binding.binding_snapshot_for_tests()


async def test_test_connector_bounded_requestheaders_uses_connector_binding(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers, monkeypatch
):
    reg_path = _write_registry(
        tmp_path,
        client_ip="10.200.0.5",
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            firewall_name="test-oauth",
            api_entry={
                "base": "https://api.okou.ai/api/test/oauth-provider",
                "auth": {"headers": {"Authorization": "Bearer x"}},
                "permissions": [{"name": "echo", "rules": ["GET /echo"]}],
            },
            network_policy={
                "allow": ["echo"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.okou.ai",
        path="/api/test/oauth-provider/echo",
        request_headers=headers(
            ("Host", "api.okou.ai"),
            ("x-okou-test-endpoint-bypass", "preview-secret"),
        ),
    )
    monkeypatch.setenv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret")
    admission_derivations: list[tuple[tuple[tuple[str, int], ...], tuple[str, ...]]] = []
    active_destinations: list[tuple[str, int]] | None = None
    active_api_urls: list[str] | None = None
    ensure_bound_destination = upstream_admission.ensure_bound_destination
    normalize_upstream_destination = upstream_destination_binding.normalize_upstream_destination
    parse_api_url = urllib.parse.urlparse

    def track_ensure_bound_destination(
        tracked_flow: http.HTTPFlow,
        *,
        kind: upstream_destination_binding.BindingKind,
        api_url: str,
    ) -> bool:
        nonlocal active_destinations, active_api_urls
        destinations: list[tuple[str, int]] = []
        api_urls: list[str] = []
        active_destinations = destinations
        active_api_urls = api_urls
        try:
            return ensure_bound_destination(
                tracked_flow,
                kind=kind,
                api_url=api_url,
            )
        finally:
            admission_derivations.append((tuple(destinations), tuple(api_urls)))
            active_destinations = None
            active_api_urls = None

    def track_normalized_destination(
        *,
        host: str,
        port: int,
    ) -> upstream_destination_binding.NormalizedUpstreamDestination:
        if active_destinations is not None:
            active_destinations.append((host, port))
        return normalize_upstream_destination(host=host, port=port)

    def track_api_url_parse(
        api_url: str,
        scheme: str = "",
        allow_fragments: bool = True,
    ) -> urllib.parse.ParseResult:
        if active_api_urls is not None:
            active_api_urls.append(api_url)
        return parse_api_url(
            api_url,
            scheme=scheme,
            allow_fragments=allow_fragments,
        )

    monkeypatch.setattr(
        upstream_admission,
        "ensure_bound_destination",
        track_ensure_bound_destination,
    )
    monkeypatch.setattr(
        upstream_destination_binding,
        "normalize_upstream_destination",
        track_normalized_destination,
    )
    monkeypatch.setattr(
        urllib.parse,
        "urlparse",
        track_api_url_parse,
    )
    expected_cached_api_derivation = (
        (("api.okou.ai", 443),),
        (),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
    ):
        assert mitm_addon.requestheaders(flow) is None
        assert admission_derivations == [expected_cached_api_derivation]
        _assert_no_request_stream(flow)
        assert flow.server_conn.address == ("api.okou.ai", 443)

        await mitm_addon.request(flow)

    assert admission_derivations == [
        expected_cached_api_derivation,
        expected_cached_api_derivation,
    ]
    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert flow.request.headers["Authorization"] == "Bearer resolved"
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.host == "api.okou.ai"
    assert binding.kinds == frozenset(("connector_auth",))
    assert binding.original_address == ("203.0.113.10", 443)


def test_normalized_binding_matches_noncanonical_raw_authority(
    real_flow,
    headers,
):
    flow = real_flow(
        with_response=False,
        host="api.github.com",
        sni="api.github.com",
        request_headers=headers(("Host", "api.github.com")),
    )
    flow.metadata[metadata_keys.TRUSTED_AUTHORITY_HOST] = "API.GITHUB.COM."
    flow.server_conn.address = ("api.github.com", 443)
    destination = upstream_destination_binding.normalize_upstream_destination(
        host="API.GITHUB.COM.",
        port=443,
    )
    assert destination.host == "api.github.com"
    assert destination.port == 443
    upstream_destination_binding.record_normalized_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        destination=destination,
        kinds=frozenset(("connector_auth",)),
        original_address=("203.0.113.10", 443),
    )

    assert upstream_admission.has_bound_destination(
        flow,
        allowed_kinds=frozenset(("connector_auth",)),
    )


def test_normalized_binding_ignores_server_without_usable_id():
    destination = upstream_destination_binding.normalize_upstream_destination(
        host="api.github.com",
        port=443,
    )

    upstream_destination_binding.record_normalized_server_binding(
        SimpleNamespace(id=None),
        destination=destination,
        kinds=frozenset(("connector_auth",)),
        original_address=("203.0.113.10", 443),
    )

    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


async def test_test_connector_bounded_requestheaders_without_bypass_blocks(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers, monkeypatch
):
    reg_path = _write_registry(
        tmp_path,
        client_ip="10.200.0.5",
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            firewall_name="test-oauth",
            api_entry={
                "base": "https://api.okou.ai/api/test/oauth-provider",
                "auth": {"headers": {"Authorization": "Bearer x"}},
                "permissions": [{"name": "echo", "rules": ["GET /echo"]}],
            },
            network_policy={
                "allow": ["echo"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.okou.ai",
        path="/api/test/oauth-provider/echo",
        request_headers=headers(
            ("Host", "api.okou.ai"),
            ("x-okou-test-endpoint-bypass", "wrong-secret"),
        ),
    )
    monkeypatch.setenv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret")

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
    ):
        assert mitm_addon.requestheaders(flow) is None
        _assert_no_request_stream(flow)
        assert flow.server_conn.address == ("203.0.113.10", 443)

        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "upstream_destination_unbound"
    assert "Authorization" not in flow.request.headers
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


async def test_firewall_allow_header_auth_requestheaders_falls_back_when_upstream_is_unbound(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(
        tmp_path,
        sandbox_fields={"captureNetworkBodies": True},
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.github.com",
        method="POST",
        path="/repos/octocat/hello",
        request_headers=headers(
            ("Host", "api.github.com"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )
    flow.server_conn.state = connection.ConnectionState.OPEN

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        await await_requestheaders_result(requestheaders_result)
        _assert_no_request_stream(flow)
        assert "Authorization" not in flow.request.headers

        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "upstream_destination_unbound"


async def test_firewall_allow_header_auth_uses_connected_upstream_when_tls_verified(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(
        tmp_path,
        sandbox_fields={"captureNetworkBodies": True},
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="172.66.0.243",
        sni="api.github.com",
        method="POST",
        path="/repos/octocat/hello",
        request_headers=headers(
            ("Host", "api.github.com"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )
    mark_connected_tls_upstream(
        flow,
        sni="api.github.com",
        server_address=("172.66.0.243", 443),
        peername=("172.66.0.243", 443),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        await await_requestheaders_result(requestheaders_result)

        assert callable(flow.request.stream)
        assert metadata_keys.REQUEST_STREAM_BUFFER in flow.metadata
        assert flow.server_conn.address == ("172.66.0.243", 443)
        assert flow.request.headers["Authorization"] == "Bearer resolved"

        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert flow.metadata[metadata_keys.REQUEST_STREAM_COMPLETE] is True
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.host == "api.github.com"
    assert binding.kinds == frozenset(("connector_auth",))
    assert binding.original_address == ("172.66.0.243", 443)


@pytest.mark.parametrize("disconnect_during_auth", [False, True], ids=["connected", "disconnected"])
async def test_firewall_allow_header_auth_revalidates_connection_after_auth_wait(
    tmp_path,
    real_flow,
    mitm_ctx,
    headers,
    monkeypatch,
    disconnect_during_auth,
):
    reg_path = _write_registry(
        tmp_path,
        client_ip="10.200.0.5",
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            firewall_name="example",
            api_entry={
                "base": "https://service.example.com",
                "auth": {
                    "headers": {"Authorization": "Bearer ${{ secrets.EXAMPLE_TOKEN }}"},
                    "query": {"api_key": "${{ secrets.EXAMPLE_TOKEN }}"},
                },
                "permissions": [{"name": "write", "rules": ["POST /items"]}],
            },
            network_policy={
                "allow": ["write"],
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
        host="93.184.216.34",
        sni="service.example.com",
        method="POST",
        path="/items?client=visible",
        request_headers=headers(
            ("Host", "service.example.com"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )
    mark_connected_tls_upstream(
        flow,
        sni="service.example.com",
        server_address=("93.184.216.34", 443),
        peername=("93.184.216.34", 443),
    )
    flow.metadata["preexisting"] = "keep"
    original_headers = flow.request.headers.fields
    original_path = flow.request.path
    auth_resolution_entered = asyncio.Event()
    release_auth_resolution = asyncio.Event()

    async def resolve_auth(*_args, **_kwargs):
        auth_resolution_entered.set()
        await release_auth_resolution.wait()
        return firewall_auth_response(
            headers={"Authorization": "Bearer resolved"},
            query={"api_key": "resolved"},
            resolved_secrets=["EXAMPLE_TOKEN"],
        )

    auth_fetch = AsyncMock(side_effect=resolve_auth)
    monkeypatch.setattr(auth, "get_firewall_headers", auth_fetch)

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        requestheaders_task = asyncio.create_task(
            await_requestheaders_result(mitm_addon.requestheaders(flow))
        )
        try:
            await asyncio.wait_for(auth_resolution_entered.wait(), timeout=1)
            if disconnect_during_auth:
                flow.server_conn.state = connection.ConnectionState.CLOSED
                mitm_addon.server_disconnected(SimpleNamespace(server=flow.server_conn))
            release_auth_resolution.set()
            await requestheaders_task
        finally:
            release_auth_resolution.set()
            await cancel_pending_task(requestheaders_task)

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert flow.error is None
    assert flow.metadata["preexisting"] == "keep"
    if disconnect_during_auth:
        _assert_no_request_stream(flow)
        assert flow.request.headers.fields == original_headers
        assert flow.request.path == original_path
        for key in request_classification.REQUEST_HEADERS_PROBE_METADATA_KEYS:
            assert key not in flow.metadata
        assert flow.server_conn.id not in upstream_destination_binding.binding_snapshot_for_tests()
    else:
        assert callable(flow.request.stream)
        assert flow.request.headers["Authorization"] == "Bearer resolved"
        assert dict(flow.request.query) == {"client": "visible", "api_key": "resolved"}
        assert flow.server_conn.id in upstream_destination_binding.binding_snapshot_for_tests()


async def test_firewall_allow_header_auth_blocks_without_verified_connected_tls(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(
        tmp_path,
        sandbox_fields={"captureNetworkBodies": True},
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.99",
        sni="api.github.com",
        method="POST",
        path="/repos/octocat/hello",
        request_headers=headers(
            ("Host", "api.github.com"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )
    flow.server_conn.peername = ("203.0.113.99", 443)
    flow.server_conn.state = connection.ConnectionState.OPEN
    flow.client_conn.sockname = ("172.66.0.243", 443)

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        await await_requestheaders_result(requestheaders_result)
        _assert_no_request_stream(flow)
        assert "Authorization" not in flow.request.headers

        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "upstream_destination_unbound"
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


@pytest.mark.parametrize(
    "peername",
    [
        pytest.param(("203.0.113.99", 443), id="ip-mismatch"),
        pytest.param(("198.18.20.34", 8443), id="port-mismatch"),
    ],
)
async def test_firewall_allow_prior_client_binding_endpoint_mismatch_blocks(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
    peername: tuple[str, int],
):
    reg_path = _write_github_firewall_registry(
        tmp_path,
        sandbox_fields={"captureNetworkBodies": True},
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.github.com",
        method="POST",
        path="/repos/octocat/hello",
        request_headers=headers(
            ("Host", "api.github.com"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )
    flow.server_conn.peername = peername
    flow.server_conn.address = ("api.github.com", 443)
    flow.server_conn.state = connection.ConnectionState.OPEN
    flow.client_conn.sockname = ("198.18.20.34", 443)

    server_connect_server = connection.Server(address=("198.18.20.34", 443))
    seed_server_binding(
        server_connect_server,
        client=flow.client_conn,
        host="api.github.com",
        port=443,
        kinds=frozenset(("connector_auth",)),
        original_address=("198.18.20.34", 443),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        await await_requestheaders_result(requestheaders_result)
        _assert_no_request_stream(flow)
        assert "Authorization" not in flow.request.headers

        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "upstream_destination_unbound"
    assert (
        upstream_admission.upstream_binding_diagnostics_for_tests(flow)[
            "client_binding_endpoint_match"
        ]
        is False
    )


async def test_firewall_allow_prior_client_binding_scan_parses_live_endpoint_once(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers, monkeypatch
):
    reg_path = _write_github_firewall_registry(
        tmp_path,
        sandbox_fields={"captureNetworkBodies": True},
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.99",
        sni="api.github.com",
        method="POST",
        path="/repos/octocat/hello",
        request_headers=headers(
            ("Host", "api.github.com"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )
    flow.server_conn.peername = ("203.0.113.99", 443)
    flow.server_conn.address = ("api.github.com", 443)
    flow.server_conn.state = connection.ConnectionState.OPEN
    for index in range(8):
        prior_server = connection.Server(address=(f"198.18.20.{index + 1}", 443))
        seed_server_binding(
            prior_server,
            client=flow.client_conn,
            host="api.github.com",
            port=443,
            kinds=frozenset(("connector_auth",)),
            original_address=prior_server.address,
        )
    binding_ip_parses = track_normalized_binding_ip_parses(monkeypatch)

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        await await_requestheaders_result(requestheaders_result)
        _assert_no_request_stream(flow)

        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "upstream_destination_unbound"
    assert binding_ip_parses
    for parses in binding_ip_parses:
        assert len(parses) == 9
        assert parses.count("203.0.113.99") == 1


async def test_firewall_allow_prior_client_binding_endpoint_match_still_requires_tls(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(
        tmp_path,
        sandbox_fields={"captureNetworkBodies": True},
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="172.66.0.243",
        sni="api.github.com",
        method="POST",
        path="/repos/octocat/hello",
        request_headers=headers(
            ("Host", "api.github.com"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )
    flow.server_conn.peername = ("172.66.0.243", 443)
    flow.server_conn.state = connection.ConnectionState.OPEN

    server_connect_server = connection.Server(address=("172.66.0.243", 443))
    seed_server_binding(
        server_connect_server,
        client=flow.client_conn,
        host="api.github.com",
        port=443,
        kinds=frozenset(("connector_auth",)),
        original_address=("172.66.0.243", 443),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        await await_requestheaders_result(requestheaders_result)
        _assert_no_request_stream(flow)
        assert "Authorization" not in flow.request.headers

        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "upstream_destination_unbound"
    assert (
        upstream_admission.upstream_binding_diagnostics_for_tests(flow)[
            "client_binding_endpoint_match"
        ]
        is True
    )
    assert flow.server_conn.id not in upstream_destination_binding.binding_snapshot_for_tests()


async def test_firewall_allow_header_auth_unconnected_skips_prior_client_binding_scan(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers, monkeypatch
):
    reg_path = _write_github_firewall_registry(
        tmp_path,
        sandbox_fields={"captureNetworkBodies": True},
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.github.com",
        method="POST",
        path="/repos/octocat/hello",
        request_headers=headers(
            ("Host", "api.github.com"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )
    prior_server = connection.Server(address=("198.18.20.34", 443))
    seed_server_binding(
        prior_server,
        client=flow.client_conn,
        host="api.github.com",
        port=443,
        kinds=frozenset(("connector_auth",)),
        original_address=("198.18.20.34", 443),
    )
    client_binding_lookups = 0
    matching_client_bindings = upstream_destination_binding._matching_client_bindings

    def track_matching_client_bindings(
        client: object,
        *,
        host: str,
        port: int,
        allowed_kinds: frozenset[upstream_destination_binding.BindingKind],
    ) -> tuple[upstream_destination_binding.UpstreamDestinationBinding, ...]:
        nonlocal client_binding_lookups
        client_binding_lookups += 1
        return matching_client_bindings(
            client,
            host=host,
            port=port,
            allowed_kinds=allowed_kinds,
        )

    monkeypatch.setattr(
        upstream_destination_binding,
        "_matching_client_bindings",
        track_matching_client_bindings,
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        await await_requestheaders_result(requestheaders_result)

        assert callable(flow.request.stream)
        assert metadata_keys.REQUEST_STREAM_BUFFER in flow.metadata
        assert flow.server_conn.address == ("api.github.com", 443)
        assert flow.request.headers["Authorization"] == "Bearer resolved"

        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert request_classification.REQUEST_CLASSIFICATION_METADATA_KEY not in flow.metadata
    assert flow.metadata[metadata_keys.REQUEST_STREAM_COMPLETE] is True
    assert client_binding_lookups == 0
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.host == "api.github.com"
    assert binding.kinds == frozenset(("connector_auth",))
    assert binding.original_address == ("203.0.113.10", 443)


async def test_firewall_allow_small_bounded_body_retargets_unconnected_upstream(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers, monkeypatch
):
    reg_path = _write_github_firewall_registry(
        tmp_path,
        sandbox_fields={"captureNetworkBodies": True},
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.github.com",
        method="POST",
        path="/repos/octocat/hello",
        request_headers=headers(("Host", "api.github.com"), ("Content-Length", "4")),
    )
    validated_flows = track_trusted_authority_validations(monkeypatch)

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
    ):
        assert mitm_addon.requestheaders(flow) is None
        assert validated_flows == [flow]
        _assert_no_request_stream(flow)
        assert metadata_keys.SANDBOX_RUN_ID not in flow.metadata
        assert metadata_keys.ORIGINAL_URL not in flow.metadata
        assert flow.server_conn.address == ("api.github.com", 443)

        await mitm_addon.request(flow)

    # Header prebinding, request dispatch, and the post-auth authorization guard
    # each validate the current trusted authority before credential mutation.
    assert validated_flows == [flow, flow, flow]
    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert flow.request.headers["Authorization"] == "Bearer resolved"
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.host == "api.github.com"
    assert binding.kinds == frozenset(("connector_auth",))
    assert binding.original_address == ("203.0.113.10", 443)


def test_bounded_requestheaders_keeps_matching_connector_binding_without_classification(
    tmp_path, real_flow, mitm_ctx, headers, monkeypatch
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.github.com",
        method="POST",
        path="/repos/octocat/hello",
        request_headers=headers(("Host", "api.github.com"), ("Content-Length", "4")),
    )
    seed_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        host="api.github.com",
        port=443,
        kinds=frozenset(("connector_auth",)),
        original_address=("203.0.113.10", 443),
    )
    flow.server_conn.address = ("api.github.com", 443)
    validated_flows = track_trusted_authority_validations(monkeypatch)
    registry_loads: list[str] = []
    load_registry_state = registry.load_registry_state

    def track_registry_load(registry_path: str) -> registry.RegistryState:
        registry_loads.append(registry_path)
        return load_registry_state(registry_path)

    monkeypatch.setattr(registry, "load_registry_state", track_registry_load)

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        assert mitm_addon.requestheaders(flow) is None

    assert validated_flows == [flow]
    assert registry_loads == []
    _assert_no_request_stream(flow)
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.host == "api.github.com"
    assert binding.kinds == frozenset(("connector_auth",))


async def test_firewall_allow_small_bounded_body_uses_connected_upstream_when_tls_verified(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(
        tmp_path,
        sandbox_fields={"captureNetworkBodies": True},
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="172.66.0.243",
        sni="api.github.com",
        method="POST",
        path="/repos/octocat/hello",
        request_headers=headers(("Host", "api.github.com"), ("Content-Length", "4")),
    )
    mark_connected_tls_upstream(
        flow,
        sni="api.github.com",
        server_address=("172.66.0.243", 443),
        peername=("172.66.0.243", 443),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
    ):
        assert mitm_addon.requestheaders(flow) is None
        _assert_no_request_stream(flow)
        assert metadata_keys.SANDBOX_RUN_ID not in flow.metadata
        assert metadata_keys.ORIGINAL_URL not in flow.metadata
        assert flow.server_conn.address == ("172.66.0.243", 443)

        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert flow.request.headers["Authorization"] == "Bearer resolved"
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.host == "api.github.com"
    assert binding.kinds == frozenset(("connector_auth",))
    assert binding.original_address == ("172.66.0.243", 443)


async def test_firewall_allow_small_bounded_body_blocks_without_verified_connected_tls(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(
        tmp_path,
        sandbox_fields={"captureNetworkBodies": True},
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.99",
        sni="api.github.com",
        method="POST",
        path="/repos/octocat/hello",
        request_headers=headers(("Host", "api.github.com"), ("Content-Length", "4")),
    )
    flow.server_conn.peername = ("203.0.113.99", 443)
    flow.server_conn.state = connection.ConnectionState.OPEN
    flow.client_conn.sockname = ("172.66.0.243", 443)

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
    ):
        assert mitm_addon.requestheaders(flow) is None
        _assert_no_request_stream(flow)
        assert metadata_keys.SANDBOX_RUN_ID not in flow.metadata
        assert metadata_keys.ORIGINAL_URL not in flow.metadata

        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "upstream_destination_unbound"
    assert "Authorization" not in flow.request.headers
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


async def test_firewall_allow_unknown_body_length_retargets_unconnected_upstream(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.github.com",
        method="POST",
        path="/repos/octocat/hello",
        request_headers=headers(("Host", "api.github.com")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
    ):
        assert mitm_addon.requestheaders(flow) is None
        _assert_no_request_stream(flow)
        assert metadata_keys.SANDBOX_RUN_ID not in flow.metadata
        assert metadata_keys.ORIGINAL_URL not in flow.metadata
        assert flow.server_conn.address == ("api.github.com", 443)

        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert flow.request.headers["Authorization"] == "Bearer resolved"
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.host == "api.github.com"
    assert binding.kinds == frozenset(("connector_auth",))
    assert binding.original_address == ("203.0.113.10", 443)
