"""Request-hook firewall authentication lifecycle tests."""

import asyncio
import json
from unittest.mock import AsyncMock, patch

import pytest
from mitmproxy import connection
from mitmproxy.test import tutils

import auth
import firewall_auth_cache as auth_cache
import firewall_auth_client as auth_client
import flow_metadata_keys as metadata_keys
import mitm_addon
import state_file
import upstream_destination_binding
from body_limits import STREAM_BUFFER_LIMIT
from tests.auth_base_forwarder_helpers import fake_forwarder_upstream
from tests.auth_endpoint_helpers import FakeAuthEndpoint, firewall_auth_success_response
from tests.auth_state_helpers import (
    cached_headers,
    force_refresh_pending,
    has_auth_state,
    require_cached_headers,
)
from tests.firewall_auth_helpers import firewall_auth_response
from tests.firewall_helpers import cancel_pending_task
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.request_handler_helpers import (
    _single_firewall_sandbox,
    _write_github_firewall_registry,
    _write_registry,
)
from tests.requestheaders_helpers import await_requestheaders_result
from tests.upstream_connection_helpers import mark_connected_tls_upstream


def _resolved_firewall_auth() -> auth_client.FirewallAuthSuccess:
    return auth_client.FirewallAuthSuccess(
        payload=auth_client.FirewallAuthPayload(
            headers={"Authorization": "Bearer resolved"},
        )
    )


async def test_repeated_firewall_requests_reuse_snapshot_auth_identity(
    tmp_path, real_flow, mitm_ctx
):
    reg_path = _write_github_firewall_registry(
        tmp_path,
        sandbox_fields={
            "_firewallAuthIdentityCache": {
                "entries": {"forged": {"authIdentity": "caller-controlled"}}
            },
            "_firewall_auth_registry_generation": "caller-controlled",
        },
    )
    flows = [
        real_flow(
            with_response=False,
            client_ip="10.200.0.5",
            host="api.github.com",
            path="/repos",
        )
        for _ in range(2)
    ]
    auth_fetch = AsyncMock(return_value=_resolved_firewall_auth())

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        patch.object(auth_cache, "fetch_firewall_headers", auth_fetch),
        patch.object(
            auth,
            "_build_firewall_auth_identity",
            wraps=auth._build_firewall_auth_identity,
        ) as build_identity,
    ):
        for flow in flows:
            await mitm_addon.request(flow)

    first_key = flows[0].metadata[metadata_keys.FIREWALL_AUTH_CACHE_KEY]
    second_key = flows[1].metadata[metadata_keys.FIREWALL_AUTH_CACHE_KEY]
    assert first_key == second_key
    assert first_key.auth_identity != "caller-controlled"
    assert type(first_key.registry_generation) is int
    assert build_identity.call_count == 1
    auth_fetch.assert_awaited_once()
    assert flows[0].metadata[metadata_keys.AUTH_CACHE_HIT] is False
    assert flows[1].metadata[metadata_keys.AUTH_CACHE_HIT] is True
    assert flows[0].request.headers["Authorization"] == "Bearer resolved"
    assert flows[1].request.headers["Authorization"] == "Bearer resolved"


async def test_initial_firewall_fetch_reuses_identity_request_bytes(tmp_path, real_flow, mitm_ctx):
    reg_path = _write_github_firewall_registry(tmp_path)
    endpoint = FakeAuthEndpoint()
    endpoint.queue_json_response(
        firewall_auth_success_response({"Authorization": "Bearer initial"})
    )
    endpoint.queue_json_response(
        firewall_auth_success_response({"Authorization": "Bearer refreshed"})
    )
    flows = [
        real_flow(
            with_response=False,
            client_ip="10.200.0.5",
            host="api.github.com",
            path="/repos",
        )
        for _ in range(3)
    ]
    serialized_force_refresh: list[bool] = []
    original_to_bytes = auth_client.FirewallAuthRequest.to_bytes

    def observe_to_bytes(
        request: auth_client.FirewallAuthRequest,
        *,
        force_refresh: bool = False,
    ) -> bytes:
        serialized_force_refresh.append(force_refresh)
        return original_to_bytes(request, force_refresh=force_refresh)

    with (
        endpoint.run(),
        mitm_ctx(registry_path=str(reg_path), api_url=endpoint.api_url),
        patch.object(auth_client.FirewallAuthRequest, "to_bytes", new=observe_to_bytes),
    ):
        await mitm_addon.request(flows[0])
        cache_key = flows[0].metadata[metadata_keys.FIREWALL_AUTH_CACHE_KEY]

        await mitm_addon.request(flows[1])

        auth_cache.invalidate_cached_firewall_headers(
            cache_key,
            flows[1].metadata[metadata_keys.FIREWALL_AUTH_CACHE_ENTRY_IDENTITY],
        )
        await mitm_addon.request(flows[2])

    assert serialized_force_refresh == [False, True]
    assert endpoint.request_count == 2
    assert [flow.metadata[metadata_keys.FIREWALL_AUTH_CACHE_KEY] for flow in flows] == [
        cache_key
    ] * 3
    assert flows[0].metadata[metadata_keys.AUTH_CACHE_HIT] is False
    assert flows[1].metadata[metadata_keys.AUTH_CACHE_HIT] is True
    assert flows[2].metadata[metadata_keys.AUTH_CACHE_HIT] is False
    assert flows[0].request.headers["Authorization"] == "Bearer initial"
    assert flows[1].request.headers["Authorization"] == "Bearer initial"
    assert flows[2].request.headers["Authorization"] == "Bearer refreshed"

    normal_body = endpoint.requests[0].json_body()
    refreshed_body = endpoint.requests[1].json_body()
    assert "forceRefresh" not in normal_body
    assert refreshed_body == normal_body | {"forceRefresh": True}


async def test_late_401_does_not_invalidate_refreshed_auth_entry(tmp_path, real_flow, mitm_ctx):
    reg_path = _write_github_firewall_registry(tmp_path)
    endpoint = FakeAuthEndpoint()
    endpoint.queue_json_response(firewall_auth_success_response({"Authorization": "Bearer v1"}))
    endpoint.queue_json_response(firewall_auth_success_response({"Authorization": "Bearer v2"}))
    flows = [
        real_flow(
            with_response=False,
            client_ip="10.200.0.5",
            host="api.github.com",
            path="/repos",
        )
        for _ in range(4)
    ]
    request_a, request_b, request_c, request_d = flows

    with endpoint.run(), mitm_ctx(registry_path=str(reg_path), api_url=endpoint.api_url):
        await mitm_addon.request(request_a)
        await mitm_addon.request(request_b)

        cache_key = request_a.metadata[metadata_keys.FIREWALL_AUTH_CACHE_KEY]
        v1_identity = request_a.metadata[metadata_keys.FIREWALL_AUTH_CACHE_ENTRY_IDENTITY]
        assert request_a.request.headers["Authorization"] == "Bearer v1"
        assert request_b.request.headers["Authorization"] == "Bearer v1"
        assert request_b.metadata[metadata_keys.FIREWALL_AUTH_CACHE_ENTRY_IDENTITY] is v1_identity

        request_a.response = tutils.tresp(status_code=401)
        mitm_addon.response(request_a)
        assert cached_headers(cache_key) is None
        assert force_refresh_pending(cache_key)

        await mitm_addon.request(request_c)
        v2_identity = request_c.metadata[metadata_keys.FIREWALL_AUTH_CACHE_ENTRY_IDENTITY]
        assert v2_identity is not v1_identity
        assert request_c.request.headers["Authorization"] == "Bearer v2"
        assert not force_refresh_pending(cache_key)

        request_b.response = tutils.tresp(status_code=401)
        mitm_addon.response(request_b)
        assert require_cached_headers(cache_key).headers == {"Authorization": "Bearer v2"}
        assert not force_refresh_pending(cache_key)

        await mitm_addon.request(request_d)

    assert endpoint.request_count == 2
    assert "forceRefresh" not in endpoint.requests[0].json_body()
    assert endpoint.requests[1].json_body()["forceRefresh"] is True
    assert request_d.metadata[metadata_keys.AUTH_CACHE_HIT] is True
    assert request_d.request.headers["Authorization"] == "Bearer v2"
    assert request_d.metadata[metadata_keys.FIREWALL_AUTH_CACHE_ENTRY_IDENTITY] is v2_identity


async def test_head_firewall_auth_failure_is_bodyless(tmp_path, real_flow, mitm_ctx, headers):
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            api_entry={
                "base": "https://api.github.com",
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"}},
                "permissions": [{"name": "read-repos", "rules": ["HEAD /repos"]}],
            },
            network_policy={
                "allow": ["read-repos"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        method="HEAD",
        path="/repos",
        request_headers=headers(("Host", "api.github.com")),
    )
    mark_connected_tls_upstream(
        flow,
        sni="api.github.com",
        server_address=("203.0.113.10", 443),
        peername=("203.0.113.10", 443),
    )
    auth_fetch = AsyncMock(side_effect=RuntimeError("auth backend unavailable"))

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", auth_fetch),
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.response is not None
    assert flow.response.status_code == 502
    assert flow.response.raw_content == b""
    assert flow.response.headers["Content-Type"] == "application/json"
    assert flow.response.headers.get_all("Content-Length") == []
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "auth_failed"
    assert "Authorization" not in flow.request.headers
    [proxy_log_entry] = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
    assert proxy_log_entry["level"] == "error"
    assert proxy_log_entry["type"] == "firewall"
    assert proxy_log_entry["firewall_base"] == "https://api.github.com"


async def test_custom_connector_id_is_forwarded_with_matched_firewall(
    tmp_path, real_flow, mitm_ctx
):
    custom_connector_id = "550e8400-e29b-41d4-a716-446655440000"
    source_id = "550e8400-e29b-41d4-a716-446655440001"
    firewall_name = "custom_connector_550e8400e29b41d4a716446655440000"
    api_id = f"{firewall_name}:0"
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            firewall_name=firewall_name,
            custom_connector_id=custom_connector_id,
            source_id=source_id,
            api_entry={
                "id": api_id,
                "base": "https://custom.example.test/api/",
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.CUSTOM_TOKEN }}"}},
            },
            network_policy={
                "allow": [],
                "deny": [],
                "ask": [],
                "unknownPolicy": "allow",
            },
            sandbox_fields={
                "connectorRoutingVariables": {
                    f"custom:{custom_connector_id}": {"subdomain": "münich"}
                }
            },
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="custom.example.test",
        path="/api/items",
    )
    auth_fetch = AsyncMock(return_value=_resolved_firewall_auth())

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        patch.object(auth_cache, "fetch_firewall_headers", auth_fetch),
    ):
        await mitm_addon.request(flow)

    assert flow.metadata[metadata_keys.FIREWALL_AUTH_CACHE_KEY].api_id == api_id
    auth_fetch.assert_awaited_once()
    await_args = auth_fetch.await_args
    assert await_args is not None
    request = await_args.args[0]
    assert request.to_body()["matchedFirewall"] == {
        "name": firewall_name,
        "apiId": api_id,
        "customConnectorId": custom_connector_id,
        "sourceId": source_id,
        "routingVariables": {"subdomain": "münich"},
    }
    assert flow.request.headers["Authorization"] == "Bearer resolved"


async def test_connector_sources_partition_firewall_auth_cache_identity(
    tmp_path, real_flow, mitm_ctx
):
    custom_connector_id = "550e8400-e29b-41d4-a716-446655440000"
    firewall_name = "custom_connector_550e8400e29b41d4a716446655440000"
    api_id = f"{firewall_name}:0"

    def sandbox(source_id: str) -> dict[str, object]:
        return _single_firewall_sandbox(
            tmp_path,
            run_id="run-source-cache",
            firewall_name=firewall_name,
            custom_connector_id=custom_connector_id,
            source_id=source_id,
            api_entry={
                "id": api_id,
                "base": "https://custom.example.test/api/",
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.CUSTOM_TOKEN }}"}},
            },
            network_policy={
                "allow": [],
                "deny": [],
                "ask": [],
                "unknownPolicy": "allow",
            },
        )

    reg_path = tmp_path / "registry.json"
    reg_path.write_text(
        json.dumps(
            {
                "sandboxes": {
                    "10.200.0.5": sandbox("550e8400-e29b-41d4-a716-446655440001"),
                    "10.200.0.6": sandbox("550e8400-e29b-41d4-a716-446655440002"),
                }
            }
        )
    )
    first_flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="custom.example.test",
        path="/api/items",
    )
    second_flow = real_flow(
        with_response=False,
        client_ip="10.200.0.6",
        host="custom.example.test",
        path="/api/items",
    )
    auth_fetch = AsyncMock(return_value=_resolved_firewall_auth())

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        patch.object(auth_cache, "fetch_firewall_headers", auth_fetch),
    ):
        await mitm_addon.request(first_flow)
        await mitm_addon.request(second_flow)

    first_key = first_flow.metadata[metadata_keys.FIREWALL_AUTH_CACHE_KEY]
    second_key = second_flow.metadata[metadata_keys.FIREWALL_AUTH_CACHE_KEY]
    assert first_key.run_id == second_key.run_id
    assert first_key.api_id == second_key.api_id
    assert first_key.auth_identity != second_key.auth_identity
    assert auth_fetch.await_count == 2


async def test_builtin_connector_routing_variables_are_forwarded_with_matched_firewall(
    tmp_path, real_flow, mitm_ctx
):
    source_id = "550e8400-e29b-41d4-a716-446655440001"
    reg_path = _write_github_firewall_registry(
        tmp_path,
        source_id=source_id,
        sandbox_fields={
            "connectorRoutingVariables": {"builtin:github": {"GITHUB_HOST": "münich.example.test"}}
        },
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        path="/repos",
    )
    auth_fetch = AsyncMock(return_value=_resolved_firewall_auth())

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        patch.object(auth_cache, "fetch_firewall_headers", auth_fetch),
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    await_args = auth_fetch.await_args
    assert await_args is not None
    request = await_args.args[0]
    assert request.to_body()["matchedFirewall"] == {
        "name": "github",
        "apiId": flow.metadata[metadata_keys.FIREWALL_API_ID],
        "base": "https://api.github.com",
        "connectorSlug": "github",
        "sourceId": source_id,
        "routingVariables": {"GITHUB_HOST": "münich.example.test"},
    }


async def test_custom_firewall_change_during_auth_discards_stale_credentials(
    tmp_path, real_flow, mitm_ctx
):
    custom_connector_id = "550e8400-e29b-41d4-a716-446655440000"
    firewall_name = "custom_connector_550e8400e29b41d4a716446655440000"

    def write_firewall(auth_scheme: str):
        return _write_registry(
            tmp_path,
            sandbox_info=_single_firewall_sandbox(
                tmp_path,
                firewall_name=firewall_name,
                custom_connector_id=custom_connector_id,
                api_entry={
                    "id": f"{firewall_name}:0",
                    "base": "https://custom.example.test/api/",
                    "auth": {
                        "headers": {
                            "Authorization": f"{auth_scheme} ${{{{ secrets.CUSTOM_TOKEN }}}}"
                        }
                    },
                },
                network_policy={
                    "allow": [],
                    "deny": [],
                    "ask": [],
                    "unknownPolicy": "allow",
                },
            ),
        )

    reg_path = write_firewall("Bearer")
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="custom.example.test",
        path="/api/items",
    )
    auth_resolution_entered = asyncio.Event()
    release_auth_resolution = asyncio.Event()

    async def resolve_auth(*_args, **_kwargs):
        auth_resolution_entered.set()
        await release_auth_resolution.wait()
        return firewall_auth_response(
            headers={"Authorization": "Bearer stale"},
            query={},
            resolved_secrets=["CUSTOM_TOKEN"],
        )

    auth_fetch = AsyncMock(side_effect=resolve_auth)
    request_task: asyncio.Task[None] | None = None
    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", auth_fetch),
    ):
        request_task = asyncio.create_task(mitm_addon.request(flow))
        try:
            await asyncio.wait_for(auth_resolution_entered.wait(), timeout=1)
            write_firewall("Token")
            release_auth_resolution.set()
            await asyncio.wait_for(request_task, timeout=1)
        finally:
            release_auth_resolution.set()
            await cancel_pending_task(request_task)

    auth_fetch.assert_awaited_once()
    assert flow.response is not None
    assert flow.response.status_code == 409
    assert json.loads(flow.response.content)["error"] == "firewall_authorization_changed"
    assert "Authorization" not in flow.request.headers


async def test_requestheaders_and_request_share_snapshot_auth_identity(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_github_firewall_registry(
        tmp_path,
        sandbox_fields={"captureNetworkBodies": True},
    )
    streamed_flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        method="POST",
        path="/repos/octocat/hello",
        request_headers=headers(
            ("Host", "api.github.com"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )
    normal_flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        path="/repos",
    )
    auth_fetch = AsyncMock(return_value=_resolved_firewall_auth())

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        patch.object(auth_cache, "fetch_firewall_headers", auth_fetch),
        patch.object(
            auth,
            "_build_firewall_auth_identity",
            wraps=auth._build_firewall_auth_identity,
        ) as build_identity,
    ):
        requestheaders_result = mitm_addon.requestheaders(streamed_flow)
        await await_requestheaders_result(requestheaders_result)
        await mitm_addon.request(streamed_flow)
        await mitm_addon.request(normal_flow)

    streamed_key = streamed_flow.metadata[metadata_keys.FIREWALL_AUTH_CACHE_KEY]
    normal_key = normal_flow.metadata[metadata_keys.FIREWALL_AUTH_CACHE_KEY]
    assert streamed_key == normal_key
    assert build_identity.call_count == 1
    auth_fetch.assert_awaited_once()
    assert streamed_flow.metadata[metadata_keys.AUTH_CACHE_HIT] is False
    assert normal_flow.metadata[metadata_keys.AUTH_CACHE_HIT] is True
    assert streamed_flow.request.headers["Authorization"] == "Bearer resolved"
    assert normal_flow.request.headers["Authorization"] == "Bearer resolved"


async def test_registry_reload_replaces_firewall_auth_identity(tmp_path, real_flow, mitm_ctx):
    reg_path = _write_github_firewall_registry(tmp_path)
    flows = [
        real_flow(
            with_response=False,
            client_ip="10.200.0.5",
            host="api.github.com",
            path="/repos",
        )
        for _ in range(3)
    ]
    auth_fetch = AsyncMock(return_value=_resolved_firewall_auth())
    registry_identities: list[state_file.StateFileIdentity] = []

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        patch.object(auth_cache, "fetch_firewall_headers", auth_fetch),
        patch.object(
            auth,
            "_build_firewall_auth_identity",
            wraps=auth._build_firewall_auth_identity,
        ) as build_identity,
    ):
        for index, flow in enumerate(flows):
            if index:
                _write_github_firewall_registry(
                    tmp_path,
                    sandbox_fields={"encryptedSecrets": f"iv:tag:data-updated-{index}"},
                )
            with state_file.open_state_file(
                reg_path,
                description="proxy registry",
            ) as opened_file:
                registry_identities.append(opened_file.identity)
            await mitm_addon.request(flow)

    keys = [flow.metadata[metadata_keys.FIREWALL_AUTH_CACHE_KEY] for flow in flows]
    assert registry_identities[0] != registry_identities[1]
    assert registry_identities[1] != registry_identities[2]
    assert {key.run_id for key in keys} == {"run-conn-1"}
    assert {key.api_id for key in keys} == {"run-conn-1:0"}
    assert len({key.auth_identity for key in keys}) == 3
    assert len({key.registry_generation for key in keys}) == 3
    assert not has_auth_state(keys[0])
    assert not has_auth_state(keys[1])
    assert cached_headers(keys[2]) is not None
    assert build_identity.call_count == 3
    assert auth_fetch.await_count == 3


async def test_registry_reload_reuses_unchanged_firewall_auth_identity(
    tmp_path, real_flow, mitm_ctx
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flows = [
        real_flow(
            with_response=False,
            client_ip="10.200.0.5",
            host="api.github.com",
            path="/repos",
        )
        for _ in range(2)
    ]
    auth_fetch = AsyncMock(return_value=_resolved_firewall_auth())

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        patch.object(auth_cache, "fetch_firewall_headers", auth_fetch),
        patch.object(
            auth,
            "_build_firewall_auth_identity",
            wraps=auth._build_firewall_auth_identity,
        ) as build_identity,
    ):
        await mitm_addon.request(flows[0])
        _write_github_firewall_registry(
            tmp_path,
            sandbox_fields={"captureNetworkBodies": False},
        )
        await mitm_addon.request(flows[1])

    first_key = flows[0].metadata[metadata_keys.FIREWALL_AUTH_CACHE_KEY]
    second_key = flows[1].metadata[metadata_keys.FIREWALL_AUTH_CACHE_KEY]
    assert first_key == second_key
    assert first_key.registry_generation != second_key.registry_generation
    assert build_identity.call_count == 2
    auth_fetch.assert_awaited_once()
    assert flows[1].metadata[metadata_keys.AUTH_CACHE_HIT] is True


async def test_registry_reload_coalesces_unchanged_in_flight_firewall_auth(
    tmp_path, real_flow, mitm_ctx
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flows = [
        real_flow(
            with_response=False,
            client_ip="10.200.0.5",
            host="api.github.com",
            path="/repos",
        )
        for _ in range(2)
    ]
    auth_fetch_started = asyncio.Event()
    release_auth_fetch = asyncio.Event()

    async def fetch_auth(
        request: auth_client.FirewallAuthRequest,
        *,
        force_refresh: bool,
    ) -> auth_client.FirewallAuthSuccess:
        assert request.encrypted_secrets == "iv:tag:data"
        assert force_refresh is False
        auth_fetch_started.set()
        await release_auth_fetch.wait()
        return _resolved_firewall_auth()

    requests: list[asyncio.Task[None] | None] = [None, None]
    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        patch.object(auth_cache, "fetch_firewall_headers", side_effect=fetch_auth) as auth_fetch,
    ):
        requests[0] = asyncio.create_task(mitm_addon.request(flows[0]))
        try:
            await asyncio.wait_for(auth_fetch_started.wait(), timeout=1)
            _write_github_firewall_registry(
                tmp_path,
                sandbox_fields={"captureNetworkBodies": False},
            )
            requests[1] = asyncio.create_task(mitm_addon.request(flows[1]))
            release_auth_fetch.set()
            await asyncio.gather(*(request for request in requests if request is not None))
        finally:
            release_auth_fetch.set()
            for request in requests:
                await cancel_pending_task(request)

    first_key = flows[0].metadata[metadata_keys.FIREWALL_AUTH_CACHE_KEY]
    second_key = flows[1].metadata[metadata_keys.FIREWALL_AUTH_CACHE_KEY]
    assert first_key == second_key
    assert first_key.registry_generation != second_key.registry_generation
    auth_fetch.assert_awaited_once()
    assert flows[0].request.headers["Authorization"] == "Bearer resolved"
    assert flows[1].request.headers["Authorization"] == "Bearer resolved"


async def test_superseded_fetch_completion_does_not_repopulate_auth_state(
    tmp_path, real_flow, mitm_ctx
):
    reg_path = _write_github_firewall_registry(tmp_path)
    old_flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        path="/repos",
    )
    new_flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        path="/repos",
    )
    old_fetch_started = asyncio.Event()
    release_old_fetch = asyncio.Event()

    async def fetch_auth(
        request: auth_client.FirewallAuthRequest,
        *,
        force_refresh: bool,
    ) -> auth_client.FirewallAuthSuccess:
        assert force_refresh is False
        if request.encrypted_secrets == "iv:tag:data":
            old_fetch_started.set()
            await release_old_fetch.wait()
            return auth_client.FirewallAuthSuccess(
                payload=auth_client.FirewallAuthPayload(headers={"Authorization": "Bearer old"})
            )
        return auth_client.FirewallAuthSuccess(
            payload=auth_client.FirewallAuthPayload(headers={"Authorization": "Bearer new"})
        )

    old_request: asyncio.Task[None] | None = None
    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        patch.object(auth_cache, "fetch_firewall_headers", side_effect=fetch_auth) as auth_fetch,
    ):
        old_request = asyncio.create_task(mitm_addon.request(old_flow))
        try:
            await asyncio.wait_for(old_fetch_started.wait(), timeout=1)
            _write_github_firewall_registry(
                tmp_path,
                sandbox_fields={"encryptedSecrets": "iv:tag:data-updated"},
            )
            await mitm_addon.request(new_flow)

            old_key = old_flow.metadata[metadata_keys.FIREWALL_AUTH_CACHE_KEY]
            new_key = new_flow.metadata[metadata_keys.FIREWALL_AUTH_CACHE_KEY]
            assert not has_auth_state(old_key)
            assert cached_headers(new_key) is not None

            release_old_fetch.set()
            await asyncio.wait_for(old_request, timeout=1)
        finally:
            release_old_fetch.set()
            await cancel_pending_task(old_request)

    assert auth_fetch.await_count == 2
    assert old_flow.response is None
    assert old_flow.request.headers["Authorization"] == "Bearer old"
    assert not has_auth_state(old_key)
    assert require_cached_headers(new_key).headers == {"Authorization": "Bearer new"}


async def test_superseded_401_does_not_mutate_current_auth_state(tmp_path, real_flow, mitm_ctx):
    reg_path = _write_github_firewall_registry(tmp_path)
    flows = [
        real_flow(
            with_response=False,
            client_ip="10.200.0.5",
            host="api.github.com",
            path="/repos",
        )
        for _ in range(2)
    ]
    auth_fetch = AsyncMock(
        side_effect=(
            auth_client.FirewallAuthSuccess(
                payload=auth_client.FirewallAuthPayload(headers={"Authorization": "Bearer old"})
            ),
            auth_client.FirewallAuthSuccess(
                payload=auth_client.FirewallAuthPayload(headers={"Authorization": "Bearer new"})
            ),
        )
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        patch.object(auth_cache, "fetch_firewall_headers", auth_fetch),
    ):
        await mitm_addon.request(flows[0])
        _write_github_firewall_registry(
            tmp_path,
            sandbox_fields={"encryptedSecrets": "iv:tag:data-updated"},
        )
        await mitm_addon.request(flows[1])
        old_key = flows[0].metadata[metadata_keys.FIREWALL_AUTH_CACHE_KEY]
        new_key = flows[1].metadata[metadata_keys.FIREWALL_AUTH_CACHE_KEY]
        flows[0].response = tutils.tresp(status_code=401)
        mitm_addon.response(flows[0])

    assert not has_auth_state(old_key)
    assert require_cached_headers(new_key).headers == {"Authorization": "Bearer new"}
    assert not force_refresh_pending(new_key)


async def test_local_response_preserves_shared_binding_for_concurrent_auth(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            api_entry={
                "base": "https://api.github.com",
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"}},
                "permissions": [
                    {
                        "name": "read-repos",
                        "rules": ["GET /repos/{owner}/{repo}"],
                    },
                ],
            },
            network_policy={
                "allow": ["read-repos"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
        ),
    )
    allowed_flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        path="/repos/octocat/hello",
        request_headers=headers(("Host", "api.github.com")),
    )
    mark_connected_tls_upstream(
        allowed_flow,
        sni="api.github.com",
        server_address=("203.0.113.10", 443),
        peername=("203.0.113.10", 443),
    )
    denied_flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        path="/orgs",
        request_headers=headers(("Host", "api.github.com")),
    )
    denied_flow.client_conn = allowed_flow.client_conn
    denied_flow.server_conn = allowed_flow.server_conn

    auth_resolution_entered = asyncio.Event()
    release_auth_resolution = asyncio.Event()

    async def resolve_auth(*_args, **_kwargs):
        auth_resolution_entered.set()
        await release_auth_resolution.wait()
        return firewall_auth_response(
            headers={"Authorization": "Bearer resolved"},
        )

    auth_fetch = AsyncMock(side_effect=resolve_auth)
    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", auth_fetch),
    ):
        allowed_task = asyncio.create_task(mitm_addon.request(allowed_flow))
        try:
            await asyncio.wait_for(auth_resolution_entered.wait(), timeout=1)
            assert (
                allowed_flow.server_conn.id
                in upstream_destination_binding.binding_snapshot_for_tests()
            )

            await mitm_addon.request(denied_flow)

            assert denied_flow.response is not None
            assert denied_flow.response.status_code == 403
            assert (
                allowed_flow.server_conn.id
                in upstream_destination_binding.binding_snapshot_for_tests()
            )

            release_auth_resolution.set()
            _ = await allowed_task
        finally:
            release_auth_resolution.set()
            await cancel_pending_task(allowed_task)

    auth_fetch.assert_awaited_once()
    assert allowed_flow.response is None
    assert allowed_flow.request.headers["Authorization"] == "Bearer resolved"
    assert allowed_flow.metadata.get(metadata_keys.FIREWALL_ERROR) is None


@pytest.mark.parametrize(
    "auth_config",
    [
        {"headers": {"Authorization": "Bearer ${{ secrets.API_TOKEN }}"}},
        {"query": {"api_key": "${{ secrets.API_TOKEN }}"}},
        {
            "awsSigv4": {
                "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
            }
        },
        {"base": "${{ secrets.WEBHOOK_URL }}"},
    ],
    ids=["headers", "query", "aws-sigv4", "auth-base"],
)
async def test_http_firewall_with_managed_credentials_blocks_before_auth(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    auth_config,
):
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            api_entry={
                "base": "http://api.github.com",
                "auth": auth_config,
                "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
            },
            network_policy={
                "allow": ["full-access"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
        ),
    )
    flow = real_flow(
        with_response=False,
        scheme="http",
        port=80,
        client_ip="10.200.0.5",
        host="api.github.com",
        path="/repos/octocat/hello",
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "insecure_transport"
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == "http://api.github.com"
    assert "Authorization" not in flow.request.headers
    body = json.loads(flow.response.content)
    assert body == {
        "error": "insecure_transport",
        "message": "Firewall credentials cannot be injected over non-HTTPS transport",
        "permission": "github",
        "base": "http://api.github.com",
    }
    [proxy_log_entry] = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
    assert proxy_log_entry["level"] == "warn"
    assert proxy_log_entry["type"] == "firewall"
    assert proxy_log_entry["firewall_base"] == "http://api.github.com"
    assert proxy_log_entry["request_scheme"] == "http"


async def test_http_firewall_without_managed_credentials_still_matches(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
):
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            api_entry={
                "base": "http://api.github.com",
                "auth": {"headers": {}},
                "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
            },
            network_policy={
                "allow": ["full-access"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
        ),
    )
    flow = real_flow(
        with_response=False,
        scheme="http",
        port=80,
        client_ip="10.200.0.5",
        host="api.github.com",
        path="/repos/octocat/hello",
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={}) as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == "http://api.github.com"
    assert "Authorization" not in flow.request.headers


@pytest.mark.parametrize("request_method", ["trace", "track"])
@pytest.mark.parametrize(
    "auth_config",
    [
        {"headers": {"Authorization": "Bearer ${{ secrets.API_TOKEN }}"}},
        {"query": {"api_key": "${{ secrets.API_TOKEN }}"}},
        {
            "awsSigv4": {
                "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
            }
        },
        {"base": "${{ secrets.WEBHOOK_URL }}"},
    ],
    ids=["headers", "query", "aws-sigv4", "auth-base"],
)
async def test_reflection_method_firewall_with_managed_credentials_blocks_before_auth(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
    auth_config,
    request_method,
):
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            api_entry={
                "base": "https://api.github.com",
                "auth": auth_config,
                "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
            },
            network_policy={
                "allow": ["full-access"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        method=request_method,
        path="/diagnostic?client=visible",
        request_headers=headers(
            ("Host", "api.github.com"),
            ("X-Client-Header", "visible"),
        ),
    )
    original_headers = tuple(flow.request.headers.fields)
    original_path = flow.request.path
    original_url = flow.request.url

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
        fake_forwarder_upstream(body=b"Authorization: Bearer reflected-by-request") as upstream,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert upstream.resolve_calls == []
    assert upstream.connect_calls == []
    assert upstream.sockets == []
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "unsafe_auth_method"
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == "https://api.github.com"
    assert tuple(flow.request.headers.fields) == original_headers
    assert flow.request.path == original_path
    assert flow.request.url == original_url
    body = json.loads(flow.response.content)
    assert body == {
        "error": "unsafe_auth_method",
        "message": (
            f"Firewall credentials cannot be injected into {request_method.upper()} requests"
        ),
        "permission": "github",
        "base": "https://api.github.com",
    }
    [proxy_log_entry] = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
    assert proxy_log_entry["level"] == "warn"
    assert proxy_log_entry["type"] == "firewall"
    assert proxy_log_entry["firewall_base"] == "https://api.github.com"
    assert proxy_log_entry["request_method"] == request_method.upper()


@pytest.mark.parametrize("request_method", ["trace", "track"])
async def test_reflection_method_firewall_without_managed_credentials_still_matches(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    request_method,
):
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            api_entry={
                "base": "https://api.github.com",
                "auth": {},
                "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
            },
            network_policy={
                "allow": ["full-access"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
            include_encrypted_secrets=False,
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        method=request_method,
        path="/diagnostic",
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={}) as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata.get(metadata_keys.FIREWALL_ERROR) is None
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == "https://api.github.com"


async def test_non_reflection_method_with_managed_credentials_still_matches(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        method="PROPFIND",
        path="/webdav/resource",
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert flow.request.headers["Authorization"] == "Bearer resolved"
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata.get(metadata_keys.FIREWALL_ERROR) is None


@pytest.mark.parametrize(
    "auth_config",
    [
        {"headers": {"Authorization": "Bearer ${{ secrets.API_TOKEN }}"}},
        {"query": {"api_key": "${{ secrets.API_TOKEN }}"}},
        {
            "awsSigv4": {
                "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
            }
        },
    ],
    ids=["headers", "query", "aws-sigv4"],
)
async def test_https_firewall_with_ordinary_credentials_blocks_when_upstream_is_unbound(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
    auth_config,
):
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            api_entry={
                "base": "https://api.github.com",
                "auth": auth_config,
                "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
            },
            network_policy={
                "allow": ["full-access"],
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
        sni="api.github.com",
        path="/repos/octocat/hello",
        request_headers=headers(("Host", "api.github.com")),
    )
    flow.server_conn.state = connection.ConnectionState.OPEN

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == "upstream_destination_unbound"
    assert body["reason"] == "connector_auth"
    assert body["base"] == "https://api.github.com"
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "upstream_destination_unbound"
    assert "Authorization" not in flow.request.headers


async def test_firewall_auth_cancellation_preserves_upstream_binding(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            api_entry={
                "base": "https://api.github.com",
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"}},
                "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
            },
            network_policy={
                "allow": ["full-access"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "allow",
            },
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.github.com",
        path="/repos/octocat/hello",
        request_headers=headers(("Host", "api.github.com")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", AsyncMock(side_effect=asyncio.CancelledError)),
        pytest.raises(asyncio.CancelledError),
    ):
        await mitm_addon.request(flow)

    assert flow.server_conn.id in upstream_destination_binding.binding_snapshot_for_tests()
