"""Public destination request-hook tests."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from mitmproxy import connection
from mitmproxy.flow import Error

import auth
import auth_base_forwarder
import builtin_host_policy
import flow_metadata_keys as metadata_keys
import mitm_addon
import public_destination
import request_classification
import upstream_destination_binding
from body_limits import STREAM_BUFFER_LIMIT
from tests.aws_sigv4_helpers import (
    RESOLVED_AWS_ACCESS_KEY_ID,
    aws_sigv4_header_auth_headers,
    resolved_aws_sigv4_credentials,
)
from tests.firewall_auth_helpers import firewall_auth_response
from tests.firewall_helpers import cancel_pending_task
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry
from tests.requestheaders_helpers import _assert_no_request_stream
from tests.upstream_connection_helpers import (
    mark_connected_tls_upstream,
    seed_server_binding,
)


def _write_public_destination_firewall_registry(
    tmp_path,
    *,
    auth_config: dict[str, object] | None = None,
    unknown_policy: str = "deny",
    sandbox_fields: dict[str, object] | None = None,
):
    return _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            firewall_name="example",
            api_entry={
                "base": "https://service.example.com",
                "hostPolicy": {"kind": "publicDestination"},
                "auth": auth_config
                or {"headers": {"Authorization": "Bearer ${{ secrets.EXAMPLE_TOKEN }}"}},
                "permissions": [{"name": "call", "rules": ["ANY /{path+}"]}],
            },
            network_policy={
                "allow": ["call"],
                "deny": [],
                "ask": [],
                "unknownPolicy": unknown_policy,
            },
            sandbox_fields=sandbox_fields,
        ),
    )


def _public_destination_flow(
    real_flow,
    headers,
    *,
    destination_host: str,
    method: str = "GET",
    path: str = "/v1/items",
    extra_headers: tuple[tuple[str, str], ...] = (),
):
    return real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host=destination_host,
        sni="service.example.com",
        path=path,
        method=method,
        request_headers=headers(("Host", "service.example.com"), *extra_headers),
    )


def _track_public_destination_classifications(monkeypatch: pytest.MonkeyPatch) -> list[object]:
    classified_hosts: list[object] = []
    classify_runtime_destination_host = public_destination.classify_runtime_destination_host

    def track(
        runtime_host: object,
    ) -> public_destination.RuntimeDestinationHostClassification:
        classified_hosts.append(runtime_host)
        return classify_runtime_destination_host(runtime_host)

    monkeypatch.setattr(public_destination, "classify_runtime_destination_host", track)
    return classified_hosts


def _assert_public_destination_denied(flow, *, destination_host: str, reason: str) -> None:
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "DENY"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "unsafe_public_destination"
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == "https://service.example.com"
    assert flow.metadata[metadata_keys.FIREWALL_NAME] == "example"
    assert "Authorization" not in flow.request.headers
    body = json.loads(flow.response.content)
    assert body == {
        "error": "unsafe_public_destination",
        "message": "Request blocked: publicDestination resolved to a non-public destination",
        "name": "example",
        "base": "https://service.example.com",
        "destination_host": destination_host,
        "trusted_authority_host": "service.example.com",
        "reason": reason,
    }


def _assert_public_destination_headers_terminated(flow) -> None:
    assert flow.response is None
    assert flow.error is not None
    assert flow.error.msg == Error.KILLED_MESSAGE
    assert flow.live is False
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "DENY"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "unsafe_public_destination"


@pytest.mark.parametrize(
    ("destination_host", "reason"),
    [
        ("10.0.0.1", "non_public_destination"),
        ("127.0.0.1", "non_public_destination"),
        ("169.254.169.254", "non_public_destination"),
        ("::1", "non_public_destination"),
        ("fe80::1", "non_public_destination"),
        ("3fff::1", "non_public_destination"),
        ("service.example.com", "invalid_destination"),
    ],
)
async def test_public_destination_blocks_unsafe_runtime_destination_before_auth(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
    destination_host,
    reason,
):
    reg_path = _write_public_destination_firewall_registry(tmp_path)
    flow = _public_destination_flow(real_flow, headers, destination_host=destination_host)

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    _assert_public_destination_denied(flow, destination_host=destination_host, reason=reason)
    [proxy_log_entry] = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
    assert proxy_log_entry["level"] == "warn"
    assert proxy_log_entry["type"] == "public_destination"
    assert proxy_log_entry["name"] == "example"
    assert proxy_log_entry["firewall_base"] == "https://service.example.com"
    assert proxy_log_entry["destination_host"] == destination_host
    assert proxy_log_entry["trusted_authority_host"] == "service.example.com"
    assert proxy_log_entry["reason"] == reason


@pytest.mark.parametrize(
    "destination_host",
    [
        "93.184.216.34",
        "2001:4860:4860::8888",
    ],
)
async def test_public_destination_allows_public_runtime_destination(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
    monkeypatch,
    destination_host,
):
    reg_path = _write_public_destination_firewall_registry(tmp_path)
    flow = _public_destination_flow(real_flow, headers, destination_host=destination_host)
    classified_hosts = _track_public_destination_classifications(monkeypatch)

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert classified_hosts == [destination_host, destination_host]
    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == "https://service.example.com"
    assert flow.metadata[metadata_keys.FIREWALL_NAME] == "example"
    assert flow.metadata[metadata_keys.FIREWALL_PERMISSION] == "call"
    assert flow.request.headers["Authorization"] == "Bearer x"


@pytest.mark.parametrize(
    ("auth_config", "token_meta"),
    [
        pytest.param(
            {"headers": {"Authorization": "Bearer ${{ secrets.EXAMPLE_TOKEN }}"}},
            firewall_auth_response(
                headers={"Authorization": "Bearer resolved"},
                resolved_secrets=["EXAMPLE_TOKEN"],
            ),
            id="header",
        ),
        pytest.param(
            {"query": {"api_key": "${{ secrets.EXAMPLE_TOKEN }}"}},
            firewall_auth_response(
                headers={},
                query={"api_key": "resolved"},
                resolved_secrets=["EXAMPLE_TOKEN"],
            ),
            id="query",
        ),
        pytest.param(
            {
                "awsSigv4": {
                    "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                    "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
                }
            },
            firewall_auth_response(
                headers={},
                aws_sigv4=resolved_aws_sigv4_credentials(session_token=None),
                resolved_secrets=["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
            ),
            id="aws-sigv4",
        ),
    ],
)
@pytest.mark.parametrize(
    "upstream_change",
    [
        pytest.param("completed", id="disconnect-hook-completed"),
        pytest.param("pending", id="disconnect-hook-pending"),
        pytest.param("peer-changed", id="connected-peer-changed"),
    ],
)
async def test_public_destination_auth_wait_recovers_only_completed_disconnect(
    tmp_path,
    real_flow,
    mitm_ctx,
    headers,
    monkeypatch,
    auth_config,
    token_meta,
    upstream_change,
):
    reg_path = _write_public_destination_firewall_registry(
        tmp_path,
        auth_config=auth_config,
    )
    signing_headers = (
        tuple(aws_sigv4_header_auth_headers(host="service.example.com"))[1:]
        if "awsSigv4" in auth_config
        else ()
    )
    flow = _public_destination_flow(
        real_flow,
        headers,
        destination_host="93.184.216.34",
        extra_headers=signing_headers,
    )
    mark_connected_tls_upstream(
        flow,
        sni="service.example.com",
        server_address=("93.184.216.34", 443),
        peername=("93.184.216.34", 443),
    )
    original_server = flow.server_conn
    original_headers = flow.request.headers.fields
    original_path = flow.request.path
    auth_resolution_entered = asyncio.Event()
    release_auth_resolution = asyncio.Event()

    async def resolve_auth(*_args, **_kwargs):
        auth_resolution_entered.set()
        await release_auth_resolution.wait()
        return token_meta

    auth_fetch = AsyncMock(side_effect=resolve_auth)
    monkeypatch.setattr(auth, "get_firewall_headers", auth_fetch)

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        request_task = asyncio.create_task(mitm_addon.request(flow))
        try:
            await asyncio.wait_for(auth_resolution_entered.wait(), timeout=1)
            if upstream_change == "peer-changed":
                flow.server_conn.peername = ("10.0.0.1", 443)
            else:
                flow.server_conn.state = connection.ConnectionState.CLOSED
                if upstream_change == "completed":
                    mitm_addon.server_disconnected(SimpleNamespace(server=flow.server_conn))
            release_auth_resolution.set()
            await request_task
        finally:
            release_auth_resolution.set()
            await cancel_pending_task(request_task)

    auth_fetch.assert_awaited_once()
    binding_snapshot = upstream_destination_binding.binding_snapshot_for_tests()
    if upstream_change == "completed":
        assert flow.response is None
        assert flow.server_conn is not original_server
        assert flow.server_conn.address == ("service.example.com", 443)
        assert flow.request.host == "service.example.com"
        assert flow.request.headers["Host"] == "service.example.com"
        assert original_server.id not in binding_snapshot
        assert flow.server_conn.id in binding_snapshot
        assert metadata_keys.RECOVERED_FIREWALL_REQUEST in flow.metadata
        assert metadata_keys.RECOVERED_UPSTREAM_ADMITTED not in flow.metadata
        if "awsSigv4" in auth_config:
            assert RESOLVED_AWS_ACCESS_KEY_ID in flow.request.headers["Authorization"]
        elif "headers" in auth_config:
            assert flow.request.headers["Authorization"] == "Bearer resolved"
        else:
            assert flow.request.query["api_key"] == "resolved"
    else:
        assert flow.response is not None
        assert flow.response.status_code == 403
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "upstream_destination_unbound"
        assert flow.request.headers.fields == original_headers
        assert flow.request.path == original_path
        assert flow.server_conn.id in binding_snapshot
        assert metadata_keys.RECOVERED_FIREWALL_REQUEST not in flow.metadata


async def test_public_destination_policy_allow_classifies_public_runtime_destination_once(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
    monkeypatch,
):
    reg_path = _write_public_destination_firewall_registry(
        tmp_path,
        unknown_policy="allow",
    )
    flow = _public_destination_flow(
        real_flow,
        headers,
        destination_host="93.184.216.34",
        method="OPTIONS",
        path="*",
    )
    classified_hosts = _track_public_destination_classifications(monkeypatch)

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_awaited()
    assert classified_hosts == ["93.184.216.34"]
    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert "Authorization" not in flow.request.headers


async def test_public_destination_blocks_prebound_private_original_destination(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_public_destination_firewall_registry(tmp_path)
    flow = _public_destination_flow(real_flow, headers, destination_host="service.example.com")
    flow.server_conn.address = ("service.example.com", 443)
    seed_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        host="service.example.com",
        port=443,
        kinds=frozenset(("connector_auth",)),
        original_address=("10.0.0.1", 443),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    _assert_public_destination_denied(
        flow,
        destination_host="10.0.0.1",
        reason="non_public_destination",
    )


async def test_public_destination_allows_prebound_public_original_destination(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_public_destination_firewall_registry(tmp_path)
    flow = _public_destination_flow(real_flow, headers, destination_host="service.example.com")
    flow.server_conn.address = ("service.example.com", 443)
    seed_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        host="service.example.com",
        port=443,
        kinds=frozenset(("connector_auth",)),
        original_address=("93.184.216.34", 443),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == "https://service.example.com"
    assert flow.metadata[metadata_keys.FIREWALL_NAME] == "example"
    assert flow.metadata[metadata_keys.FIREWALL_PERMISSION] == "call"
    assert flow.request.headers["Authorization"] == "Bearer x"


async def test_public_destination_blocks_private_transparent_host_despite_public_original(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_public_destination_firewall_registry(tmp_path)
    flow = _public_destination_flow(real_flow, headers, destination_host="10.0.0.1")
    flow.server_conn.address = ("service.example.com", 443)
    seed_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        host="service.example.com",
        port=443,
        kinds=frozenset(("connector_auth",)),
        original_address=("93.184.216.34", 443),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    _assert_public_destination_denied(
        flow,
        destination_host="10.0.0.1",
        reason="non_public_destination",
    )


async def test_public_destination_blocks_bracketed_private_host_despite_public_original(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_public_destination_firewall_registry(tmp_path)
    flow = _public_destination_flow(real_flow, headers, destination_host="[::1]")
    flow.server_conn.address = ("service.example.com", 443)
    seed_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        host="service.example.com",
        port=443,
        kinds=frozenset(("connector_auth",)),
        original_address=("93.184.216.34", 443),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    _assert_public_destination_denied(
        flow,
        destination_host="[::1]",
        reason="non_public_destination",
    )


async def test_public_destination_allows_bracketed_public_ipv6_host_with_public_original(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_public_destination_firewall_registry(tmp_path)
    flow = _public_destination_flow(
        real_flow,
        headers,
        destination_host="[2001:4860:4860::8888]",
    )
    flow.server_conn.address = ("service.example.com", 443)
    seed_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        host="service.example.com",
        port=443,
        kinds=frozenset(("connector_auth",)),
        original_address=("2001:4860:4860::8888", 443),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.request.headers["Authorization"] == "Bearer x"


@pytest.mark.parametrize(
    "destination_host",
    [
        "0177.0.0.1",
        "0x7f.0.0.1",
        "2130706433",
        "127.1",
        "127.0.0.1.",
        "93.184.216.34.",
    ],
)
async def test_public_destination_blocks_legacy_ipv4_host_despite_public_original(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers, destination_host
):
    reg_path = _write_public_destination_firewall_registry(tmp_path)
    flow = _public_destination_flow(real_flow, headers, destination_host=destination_host)
    flow.server_conn.address = ("service.example.com", 443)
    seed_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        host="service.example.com",
        port=443,
        kinds=frozenset(("connector_auth",)),
        original_address=("93.184.216.34", 443),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    _assert_public_destination_denied(
        flow,
        destination_host=destination_host,
        reason="invalid_destination",
    )


@pytest.mark.parametrize(
    "destination_host",
    [
        "127%2e0%2e0%2e1",
        "example%2ecom",
        "example%252ecom",
        "example%2dcom",
        "ex%61mple.com",
        "127%zz0.0.1",
    ],
)
async def test_public_destination_blocks_percent_encoded_host_despite_public_original(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers, destination_host
):
    reg_path = _write_public_destination_firewall_registry(tmp_path)
    flow = _public_destination_flow(real_flow, headers, destination_host=destination_host)
    flow.server_conn.address = ("service.example.com", 443)
    seed_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        host="service.example.com",
        port=443,
        kinds=frozenset(("connector_auth",)),
        original_address=("93.184.216.34", 443),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    _assert_public_destination_denied(
        flow,
        destination_host=destination_host,
        reason="invalid_destination",
    )


@pytest.mark.parametrize(
    "destination_host",
    [
        "example/com",
        "example:443",
        "example@evil.com",
        "[service.example.com]",
        " service.example.com ",
    ],
)
async def test_public_destination_blocks_malformed_host_despite_public_original(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers, destination_host
):
    reg_path = _write_public_destination_firewall_registry(tmp_path)
    flow = _public_destination_flow(real_flow, headers, destination_host=destination_host)
    flow.server_conn.address = ("service.example.com", 443)
    seed_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        host="service.example.com",
        port=443,
        kinds=frozenset(("connector_auth",)),
        original_address=("93.184.216.34", 443),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    _assert_public_destination_denied(
        flow,
        destination_host=destination_host,
        reason="invalid_destination",
    )


async def test_public_destination_blocks_prebound_public_original_port_mismatch(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_public_destination_firewall_registry(tmp_path)
    flow = _public_destination_flow(real_flow, headers, destination_host="service.example.com")
    flow.server_conn.address = ("service.example.com", 443)
    seed_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        host="service.example.com",
        port=443,
        kinds=frozenset(("connector_auth",)),
        original_address=("93.184.216.34", 8443),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    _assert_public_destination_denied(
        flow,
        destination_host="",
        reason="missing_destination",
    )


async def test_public_destination_allows_connected_prebound_public_original_destination(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_public_destination_firewall_registry(tmp_path)
    flow = _public_destination_flow(real_flow, headers, destination_host="service.example.com")
    mark_connected_tls_upstream(
        flow,
        sni="service.example.com",
        server_address=("service.example.com", 443),
        peername=("93.184.216.35", 443),
    )
    seed_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        host="service.example.com",
        port=443,
        kinds=frozenset(("connector_auth",)),
        original_address=("93.184.216.34", 443),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.request.headers["Authorization"] == "Bearer x"


async def test_public_destination_classifies_connected_hosts_once_per_admission_check(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
    monkeypatch,
):
    reg_path = _write_public_destination_firewall_registry(tmp_path)
    flow = _public_destination_flow(
        real_flow,
        headers,
        destination_host="service.example.com",
    )
    mark_connected_tls_upstream(
        flow,
        sni="service.example.com",
        server_address=("service.example.com", 443),
        peername=("93.184.216.35", 443),
    )
    classified_hosts = _track_public_destination_classifications(monkeypatch)

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert classified_hosts == [
        "service.example.com",
        "93.184.216.35",
        "93.184.216.35",
        "service.example.com",
    ]
    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.request.headers["Authorization"] == "Bearer x"


async def test_public_destination_blocks_connected_private_transparent_host_despite_public_original(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_public_destination_firewall_registry(tmp_path)
    flow = _public_destination_flow(real_flow, headers, destination_host="10.0.0.1")
    mark_connected_tls_upstream(
        flow,
        sni="service.example.com",
        server_address=("service.example.com", 443),
        peername=("93.184.216.35", 443),
    )
    seed_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        host="service.example.com",
        port=443,
        kinds=frozenset(("connector_auth",)),
        original_address=("93.184.216.34", 443),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    _assert_public_destination_denied(
        flow,
        destination_host="10.0.0.1",
        reason="non_public_destination",
    )


async def test_public_destination_blocks_connected_public_original_port_mismatch(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_public_destination_firewall_registry(tmp_path)
    flow = _public_destination_flow(real_flow, headers, destination_host="service.example.com")
    mark_connected_tls_upstream(
        flow,
        sni="service.example.com",
        server_address=("service.example.com", 443),
        peername=("93.184.216.35", 443),
    )
    seed_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        host="service.example.com",
        port=443,
        kinds=frozenset(("connector_auth",)),
        original_address=("93.184.216.34", 8443),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    _assert_public_destination_denied(
        flow,
        destination_host="",
        reason="missing_destination",
    )


async def test_public_destination_allows_connected_public_transparent_sockname_without_peername(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_public_destination_firewall_registry(tmp_path)
    flow = _public_destination_flow(real_flow, headers, destination_host="service.example.com")
    mark_connected_tls_upstream(
        flow,
        sni="service.example.com",
        server_address=("service.example.com", 443),
        peername=None,
        client_sockname=("93.184.216.34", 443),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.request.headers["Authorization"] == "Bearer x"


async def test_public_destination_blocks_connected_private_transparent_sockname_without_peername(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_public_destination_firewall_registry(tmp_path)
    flow = _public_destination_flow(real_flow, headers, destination_host="service.example.com")
    mark_connected_tls_upstream(
        flow,
        sni="service.example.com",
        server_address=("service.example.com", 443),
        peername=None,
        client_sockname=("10.0.0.1", 443),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    _assert_public_destination_denied(
        flow,
        destination_host="10.0.0.1",
        reason="non_public_destination",
    )


async def test_public_destination_blocks_private_peer_before_public_transparent_sockname(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_public_destination_firewall_registry(tmp_path)
    flow = _public_destination_flow(real_flow, headers, destination_host="service.example.com")
    mark_connected_tls_upstream(
        flow,
        sni="service.example.com",
        server_address=("service.example.com", 443),
        peername=("10.0.0.1", 443),
        client_sockname=("93.184.216.34", 443),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    _assert_public_destination_denied(
        flow,
        destination_host="10.0.0.1",
        reason="non_public_destination",
    )


async def test_public_destination_blocks_private_transparent_host_despite_public_peer(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_public_destination_firewall_registry(tmp_path)
    flow = _public_destination_flow(real_flow, headers, destination_host="10.0.0.1")
    mark_connected_tls_upstream(
        flow,
        sni="service.example.com",
        server_address=("service.example.com", 443),
        peername=("93.184.216.35", 443),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    _assert_public_destination_denied(
        flow,
        destination_host="10.0.0.1",
        reason="non_public_destination",
    )


async def test_public_destination_blocks_private_server_address_despite_public_peer(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_public_destination_firewall_registry(tmp_path)
    flow = _public_destination_flow(real_flow, headers, destination_host="service.example.com")
    mark_connected_tls_upstream(
        flow,
        sni="service.example.com",
        server_address=("10.0.0.1", 443),
        peername=("93.184.216.35", 443),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    _assert_public_destination_denied(
        flow,
        destination_host="10.0.0.1",
        reason="non_public_destination",
    )


async def test_public_destination_blocks_public_server_address_port_mismatch(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_public_destination_firewall_registry(tmp_path)
    flow = _public_destination_flow(real_flow, headers, destination_host="service.example.com")
    flow.server_conn.address = ("93.184.216.34", 8443)

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    _assert_public_destination_denied(
        flow,
        destination_host="",
        reason="missing_destination",
    )


async def test_public_destination_blocks_loopback_peer_before_public_transparent_sockname(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_public_destination_firewall_registry(tmp_path)
    flow = _public_destination_flow(real_flow, headers, destination_host="service.example.com")
    mark_connected_tls_upstream(
        flow,
        sni="service.example.com",
        server_address=("service.example.com", 443),
        peername=("127.0.0.1", 443),
        client_sockname=("93.184.216.34", 443),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    _assert_public_destination_denied(
        flow,
        destination_host="127.0.0.1",
        reason="non_public_destination",
    )


async def test_public_destination_blocks_transparent_sockname_port_mismatch(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_public_destination_firewall_registry(tmp_path)
    flow = _public_destination_flow(real_flow, headers, destination_host="service.example.com")
    mark_connected_tls_upstream(
        flow,
        sni="service.example.com",
        server_address=("service.example.com", 443),
        peername=None,
        client_sockname=("93.184.216.34", 8443),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    _assert_public_destination_denied(
        flow,
        destination_host="",
        reason="missing_destination",
    )


async def test_public_destination_blocks_peer_port_mismatch_before_transparent_sockname(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_public_destination_firewall_registry(tmp_path)
    flow = _public_destination_flow(real_flow, headers, destination_host="service.example.com")
    mark_connected_tls_upstream(
        flow,
        sni="service.example.com",
        server_address=("service.example.com", 443),
        peername=("93.184.216.35", 8443),
        client_sockname=("93.184.216.34", 443),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    _assert_public_destination_denied(
        flow,
        destination_host="",
        reason="missing_destination",
    )


async def test_public_destination_blocks_connected_private_peer_despite_public_original(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_public_destination_firewall_registry(tmp_path)
    flow = _public_destination_flow(real_flow, headers, destination_host="service.example.com")
    mark_connected_tls_upstream(
        flow,
        sni="service.example.com",
        server_address=("service.example.com", 443),
        peername=("10.0.0.1", 443),
    )
    seed_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        host="service.example.com",
        port=443,
        kinds=frozenset(("connector_auth",)),
        original_address=("93.184.216.34", 443),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    _assert_public_destination_denied(
        flow,
        destination_host="10.0.0.1",
        reason="non_public_destination",
    )


async def test_public_destination_blocks_private_original_despite_connected_public_peer(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_public_destination_firewall_registry(tmp_path)
    flow = _public_destination_flow(real_flow, headers, destination_host="service.example.com")
    mark_connected_tls_upstream(
        flow,
        sni="service.example.com",
        server_address=("service.example.com", 443),
        peername=("93.184.216.35", 443),
    )
    seed_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        host="service.example.com",
        port=443,
        kinds=frozenset(("connector_auth",)),
        original_address=("10.0.0.1", 443),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    _assert_public_destination_denied(
        flow,
        destination_host="10.0.0.1",
        reason="non_public_destination",
    )


async def test_public_destination_ignores_stale_prebound_public_original_destination(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_public_destination_firewall_registry(tmp_path)
    flow = _public_destination_flow(real_flow, headers, destination_host="10.0.0.1")
    seed_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        host="service.example.com",
        port=443,
        kinds=frozenset(("connector_auth",)),
        original_address=("93.184.216.34", 443),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    _assert_public_destination_denied(
        flow,
        destination_host="10.0.0.1",
        reason="non_public_destination",
    )


async def test_public_destination_revalidates_connected_peer_after_requestheaders_prebind(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_public_destination_firewall_registry(
        tmp_path,
        sandbox_fields={"captureNetworkBodies": True},
    )
    flow = _public_destination_flow(
        real_flow,
        headers,
        destination_host="93.184.216.34",
        method="POST",
        extra_headers=(("Content-Length", str(mitm_addon.STREAM_BUFFER_LIMIT + 1)),),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        assert mitm_addon.requestheaders(flow) is None
        assert "Authorization" not in flow.request.headers
        assert flow.server_conn.address == ("service.example.com", 443)

        mark_connected_tls_upstream(
            flow,
            sni="service.example.com",
            server_address=("service.example.com", 443),
            peername=("10.0.0.1", 443),
        )

        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    _assert_public_destination_denied(
        flow,
        destination_host="10.0.0.1",
        reason="non_public_destination",
    )


async def test_public_destination_requestheaders_defers_unresolved_hostname_until_connected(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_public_destination_firewall_registry(
        tmp_path,
        sandbox_fields={"captureNetworkBodies": True},
    )
    flow = _public_destination_flow(
        real_flow,
        headers,
        destination_host="service.example.com",
        method="POST",
        extra_headers=(("Content-Length", str(mitm_addon.STREAM_BUFFER_LIMIT + 1)),),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        assert mitm_addon.requestheaders(flow) is None
        assert flow.response is None
        assert flow.error is None
        assert flow.server_conn.address == ("service.example.com", 443)

        mark_connected_tls_upstream(
            flow,
            sni="service.example.com",
            server_address=("service.example.com", 443),
            peername=("93.184.216.35", 443),
        )

        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.request.headers["Authorization"] == "Bearer x"


async def test_public_destination_requestheaders_deferred_hostname_still_blocks_private_peer(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_public_destination_firewall_registry(
        tmp_path,
        sandbox_fields={"captureNetworkBodies": True},
    )
    flow = _public_destination_flow(
        real_flow,
        headers,
        destination_host="service.example.com",
        method="POST",
        extra_headers=(("Content-Length", str(mitm_addon.STREAM_BUFFER_LIMIT + 1)),),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        assert mitm_addon.requestheaders(flow) is None
        assert flow.response is None
        assert flow.error is None

        mark_connected_tls_upstream(
            flow,
            sni="service.example.com",
            server_address=("service.example.com", 443),
            peername=("10.0.0.1", 443),
        )

        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    _assert_public_destination_denied(
        flow,
        destination_host="10.0.0.1",
        reason="non_public_destination",
    )


async def test_public_destination_request_phase_blocks_unresolved_hostname_without_runtime_ip(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_public_destination_firewall_registry(tmp_path)
    flow = _public_destination_flow(real_flow, headers, destination_host="service.example.com")

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    _assert_public_destination_denied(
        flow,
        destination_host="service.example.com",
        reason="invalid_destination",
    )


async def test_public_destination_reclassifies_buffered_auth_base_request(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_public_destination_firewall_registry(
        tmp_path,
        auth_config={"headers": {}, "base": "${{ secrets.WEBHOOK_URL }}"},
    )
    flow = _public_destination_flow(
        real_flow,
        headers,
        destination_host="93.184.216.34",
        method="POST",
        extra_headers=(("Content-Length", str(mitm_addon.STREAM_BUFFER_LIMIT + 1)),),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        assert mitm_addon.requestheaders(flow) is None
        assert request_classification.REQUEST_CLASSIFICATION_METADATA_KEY not in flow.metadata
        assert auth_base_forwarder.forward_request_admission_state_for_tests() == (
            1,
            mitm_addon.STREAM_BUFFER_LIMIT + 1,
        )

        mark_connected_tls_upstream(
            flow,
            sni="service.example.com",
            server_address=("service.example.com", 443),
            peername=("10.0.0.1", 443),
        )

        await mitm_addon.request(flow)

    _assert_public_destination_denied(
        flow,
        destination_host="10.0.0.1",
        reason="non_public_destination",
    )
    assert auth_base_forwarder.forward_request_admission_state_for_tests() == (0, 0)


async def test_public_destination_reclassifies_buffered_auth_base_hostname_request(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_public_destination_firewall_registry(
        tmp_path,
        auth_config={"headers": {}, "base": "${{ secrets.WEBHOOK_URL }}"},
    )
    flow = _public_destination_flow(
        real_flow,
        headers,
        destination_host="service.example.com",
        method="POST",
        extra_headers=(("Content-Length", str(mitm_addon.STREAM_BUFFER_LIMIT + 1)),),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        assert mitm_addon.requestheaders(flow) is None
        assert request_classification.REQUEST_CLASSIFICATION_METADATA_KEY not in flow.metadata
        assert auth_base_forwarder.forward_request_admission_state_for_tests() == (
            1,
            mitm_addon.STREAM_BUFFER_LIMIT + 1,
        )

        mark_connected_tls_upstream(
            flow,
            sni="service.example.com",
            server_address=("service.example.com", 443),
            peername=("10.0.0.1", 443),
        )

        await mitm_addon.request(flow)

    _assert_public_destination_denied(
        flow,
        destination_host="10.0.0.1",
        reason="non_public_destination",
    )
    assert auth_base_forwarder.forward_request_admission_state_for_tests() == (0, 0)


async def test_public_destination_revalidates_cached_policy_allow_classification(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
    monkeypatch,
):
    reg_path = _write_public_destination_firewall_registry(
        tmp_path,
        unknown_policy="allow",
        sandbox_fields={"captureNetworkBodies": True},
    )
    flow = _public_destination_flow(
        real_flow,
        headers,
        destination_host="93.184.216.34",
        method="OPTIONS",
        path="*",
        extra_headers=(("Content-Length", str(mitm_addon.STREAM_BUFFER_LIMIT + 1)),),
    )
    classified_hosts = _track_public_destination_classifications(monkeypatch)

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        assert mitm_addon.requestheaders(flow) is None
        assert classified_hosts == ["93.184.216.34"]
        assert request_classification.REQUEST_CLASSIFICATION_METADATA_KEY in flow.metadata

        mark_connected_tls_upstream(
            flow,
            sni="service.example.com",
            server_address=("service.example.com", 443),
            peername=("10.0.0.1", 443),
        )

        await mitm_addon.request(flow)

    auth_fetch.assert_not_awaited()
    request_phase_classified_hosts = classified_hosts[1:]
    assert "10.0.0.1" in request_phase_classified_hosts
    _assert_public_destination_denied(
        flow,
        destination_host="10.0.0.1",
        reason="non_public_destination",
    )
    assert request_classification.REQUEST_CLASSIFICATION_METADATA_KEY not in flow.metadata


async def test_firewall_allow_header_auth_requestheaders_blocks_public_destination_private_host(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    api_entry: dict[str, object] = {
        "base": "https://strapi.example.com",
        "auth": {"headers": {"Authorization": "Bearer ${{ secrets.TEST_TOKEN }}"}},
        "hostPolicy": {"kind": "publicDestination"},
        builtin_host_policy.BUILTIN_HOST_POLICY_RUNTIME_MARKER: True,
        "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
    }
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            firewall_name="strapi",
            api_entry=api_entry,
            network_policy={
                "allow": ["full-access"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "allow",
            },
            sandbox_fields={"captureNetworkBodies": True},
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="10.0.0.5",
        sni="strapi.example.com",
        method="POST",
        path="/api/articles",
        request_headers=headers(
            ("Host", "strapi.example.com"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        assert requestheaders_result is None
        _assert_no_request_stream(flow)
        assert "Authorization" not in flow.request.headers

        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.response is None
    assert flow.live is False
    assert flow.error is not None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "DENY"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "unsafe_public_destination"
    assert "Authorization" not in flow.request.headers


@pytest.mark.parametrize("request_stream", [False, True])
async def test_public_destination_requestheaders_blocks_before_early_auth(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers, request_stream
):
    reg_path = _write_public_destination_firewall_registry(
        tmp_path,
        sandbox_fields={"captureNetworkBodies": True},
    )
    flow = _public_destination_flow(
        real_flow,
        headers,
        destination_host="10.0.0.1",
        method="POST",
        extra_headers=(("Content-Length", str(mitm_addon.STREAM_BUFFER_LIMIT + 1)),),
    )
    flow.request.stream = request_stream

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        assert requestheaders_result is None
        _assert_public_destination_headers_terminated(flow)
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.request.stream is False
    assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
    [proxy_log_entry] = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
    assert proxy_log_entry["type"] == "public_destination"


async def test_public_destination_requestheaders_kills_unknown_length_before_early_auth(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_public_destination_firewall_registry(
        tmp_path,
        sandbox_fields={"captureNetworkBodies": True},
    )
    flow = _public_destination_flow(
        real_flow,
        headers,
        destination_host="10.0.0.1",
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        assert requestheaders_result is None
        _assert_public_destination_headers_terminated(flow)
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.request.stream is False
    assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
    [proxy_log_entry] = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
    assert proxy_log_entry["type"] == "public_destination"
