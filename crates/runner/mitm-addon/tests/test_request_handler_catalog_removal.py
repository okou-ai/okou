"""Active-run request behavior when a valid catalog removes a connector."""

import asyncio
import json
import threading
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

import auth
import firewall_auth_cache as auth_cache
import flow_metadata_keys as metadata_keys
import mitm_addon
import registry
from tests.auth_endpoint_helpers import FakeAuthEndpoint, firewall_auth_success_response
from tests.firewall_auth_helpers import firewall_auth_response
from tests.firewall_helpers import cancel_pending_task
from tests.registry_builtin_helpers import write_catalog_cache
from tests.registry_helpers import write_multi_sandbox_registry
from tests.requestheaders_helpers import await_requestheaders_result

_CLIENT_IP = "10.200.0.5"
_REMOVED = "removed"
_RETAINED = "retained"
_MCP_SOURCE_ID = "550e8400-e29b-41d4-a716-446655440001"


def _firewall(name: str, base: str) -> dict[str, object]:
    secret_name = f"{name.upper()}_TOKEN"
    return {
        "name": name,
        "apis": [
            {
                "base": base,
                "auth": {
                    "headers": {
                        "Authorization": f"Bearer ${{{{ secrets.{secret_name} }}}}",
                    }
                },
                "permissions": [
                    {
                        "name": "items.read",
                        "rules": ["GET /items/{id}"],
                    }
                ],
            }
        ],
    }


def _active_sandbox(tmp_path: Path) -> dict[str, object]:
    return {
        "runId": "run-catalog-removal",
        "cliAgentType": "codex",
        "sandboxToken": "sandbox-token",
        "networkLogPath": str(tmp_path / "network.jsonl"),
        "proxyLogPath": str(tmp_path / "proxy.jsonl"),
        "encryptedSecrets": "iv:tag:data",
        "firewalls": [
            {"kind": "builtin", "name": _REMOVED},
            {"kind": "builtin", "name": _RETAINED},
        ],
        "networkPolicies": {
            name: {
                "allow": ["items.read"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            }
            for name in (_REMOVED, _RETAINED)
        },
        "billableFirewalls": [],
    }


def _write_active_state(
    tmp_path: Path,
    *,
    removed_base: str,
    retained_base: str,
) -> tuple[Path, Path]:
    registry_path = tmp_path / "registry.json"
    cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
    write_multi_sandbox_registry(registry_path, {_CLIENT_IP: _active_sandbox(tmp_path)})
    write_catalog_cache(
        cache_path,
        digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        version="catalog-a",
        firewalls={
            _REMOVED: _firewall(_REMOVED, removed_base),
            _RETAINED: _firewall(_RETAINED, retained_base),
        },
    )
    return registry_path, cache_path


def _remove_from_catalog(cache_path: Path, *, retained_base: str) -> None:
    next_path = cache_path.with_name("builtin-firewall-catalog-cache.next.json")
    write_catalog_cache(
        next_path,
        digest="sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        version="catalog-b",
        firewalls={_RETAINED: _firewall(_RETAINED, retained_base)},
    )
    next_path.replace(cache_path)


def _write_account_mcp_state(tmp_path: Path, *, credentialed: bool = False) -> tuple[Path, Path]:
    registry_path = tmp_path / "registry.json"
    cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
    sandbox = {
        **_active_sandbox(tmp_path),
        "captureNetworkBodies": True,
        "firewalls": [
            {
                "kind": "builtin",
                "name": _REMOVED,
                "sourceId": _MCP_SOURCE_ID,
            },
            {"kind": "builtin", "name": _RETAINED},
        ],
        "connectorRoutingVariables": {f"builtin:{_REMOVED}": {}},
        "networkPolicies": {
            name: {"allow": [], "deny": [], "ask": [], "unknownPolicy": "allow"}
            for name in (_REMOVED, _RETAINED)
        },
    }
    write_multi_sandbox_registry(registry_path, {_CLIENT_IP: sandbox})
    write_catalog_cache(
        cache_path,
        digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        version="catalog-a",
        firewalls={
            _REMOVED: {
                "name": _REMOVED,
                "apis": [
                    {
                        "base": "https://shared.example.com",
                        "auth": (
                            {"headers": {"Authorization": "Bearer ${{ secrets.MCP_TOKEN }}"}}
                            if credentialed
                            else {}
                        ),
                        "permissions": [],
                    }
                ],
            },
            _RETAINED: _firewall(_RETAINED, "https://shared.example.com"),
        },
    )
    return registry_path, cache_path


@pytest.mark.parametrize("requestheaders_first", [False, True])
async def test_authenticated_builtin_mcp_account_lease_rechecks_deleted_account(
    tmp_path, real_flow, mitm_ctx, requestheaders_first
):
    registry_path, cache_path = _write_account_mcp_state(tmp_path, credentialed=True)
    endpoint = FakeAuthEndpoint()
    endpoint.queue_json_response(
        firewall_auth_success_response(
            {"Authorization": "Bearer selected-account"},
            expires_at=1030,
        )
    )
    endpoint.queue_json_response(
        {"error": {"code": "CONNECTOR_NOT_CONFIGURED", "message": "Account was deleted"}},
        status=424,
    )
    flows = [
        real_flow(
            with_response=False,
            client_ip=_CLIENT_IP,
            host="shared.example.com",
            path="/server",
            method="POST",
        )
        for _ in range(3)
    ]
    for flow in flows:
        flow.request.headers["X-Okou-Connector-Intent"] = _REMOVED
        if requestheaders_first:
            flow.request.headers["Content-Length"] = str(mitm_addon.STREAM_BUFFER_LIMIT + 1)

    with (
        endpoint.run(),
        mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
            api_url=endpoint.api_url,
        ),
        patch.object(auth_cache.time, "time", return_value=1000) as clock,
    ):
        for index, flow in enumerate(flows):
            clock.return_value = 1031 if index == 2 else 1000
            if requestheaders_first:
                await await_requestheaders_result(mitm_addon.requestheaders(flow))
            await mitm_addon.request(flow)

    assert endpoint.request_count == 2
    for request in endpoint.requests:
        matched = request.json_body()["matchedFirewall"]
        assert isinstance(matched, dict)
        assert matched["sourceId"] == _MCP_SOURCE_ID
        assert matched["connectorSlug"] == _REMOVED
    for flow in flows[:2]:
        assert flow.response is None
        assert flow.error is None
        assert flow.request.headers.get("Authorization") == "Bearer selected-account"
    denied = flows[2]
    if requestheaders_first:
        assert denied.error is not None
    else:
        assert denied.response is not None
        assert denied.response.status_code == 424
    assert denied.metadata[metadata_keys.FIREWALL_ERROR] == "connector_not_configured"
    assert "Authorization" not in denied.request.headers


@pytest.mark.parametrize("requestheaders_first", [False, True])
@pytest.mark.parametrize("has_auth_context", [False, True])
@pytest.mark.parametrize("connector_kind", ["builtin", "custom"])
async def test_no_auth_mcp_skips_account_validation(
    tmp_path, real_flow, mitm_ctx, requestheaders_first, has_auth_context, connector_kind
):
    registry_path, cache_path = _write_account_mcp_state(tmp_path)
    registry_data = json.loads(registry_path.read_text())
    sandbox = registry_data["sandboxes"][_CLIENT_IP]
    intent = _REMOVED
    if connector_kind == "custom":
        custom_id = "550e8400-e29b-41d4-a716-446655440000"
        sandbox["firewalls"][0] = {
            "kind": "inline",
            "customConnectorId": custom_id,
            "sourceId": _MCP_SOURCE_ID,
            "firewall": {
                "name": _REMOVED,
                "apis": [
                    {
                        "base": "https://shared.example.com",
                        "auth": {},
                        "permissions": [],
                    }
                ],
            },
        }
        sandbox["connectorRoutingVariables"] = {f"custom:{custom_id}": {}}
        intent = custom_id
    if not has_auth_context:
        sandbox.pop("encryptedSecrets")
        sandbox.pop("connectorRoutingVariables")
    registry_path.write_text(json.dumps(registry_data))
    endpoint = FakeAuthEndpoint()
    endpoint.queue_json_response(
        {"error": {"code": "CONNECTOR_NOT_CONFIGURED", "message": "Account was deleted"}},
        status=424,
    )
    flow = real_flow(
        with_response=False,
        client_ip=_CLIENT_IP,
        host="shared.example.com",
        path="/server",
        method="POST",
    )
    flow.request.headers["X-Okou-Connector-Intent"] = intent
    if requestheaders_first:
        flow.request.headers["Content-Length"] = str(mitm_addon.STREAM_BUFFER_LIMIT + 1)

    with (
        endpoint.run(),
        mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
            api_url=endpoint.api_url,
        ),
    ):
        if requestheaders_first:
            await await_requestheaders_result(mitm_addon.requestheaders(flow))
            assert flow.request.stream is not False
        await mitm_addon.request(flow)

    assert endpoint.request_count == 0
    assert flow.response is None
    assert flow.error is None
    assert flow.metadata[metadata_keys.FIREWALL_NAME] == _REMOVED
    assert "Authorization" not in flow.request.headers


@pytest.mark.parametrize("requestheaders_first", [False, True])
async def test_authenticated_builtin_owner_removed_during_account_check_is_rejected(
    tmp_path, real_flow, mitm_ctx, requestheaders_first
):
    registry_path, cache_path = _write_account_mcp_state(tmp_path, credentialed=True)
    endpoint = FakeAuthEndpoint()
    release_auth = threading.Event()
    endpoint.queue_json_response(
        firewall_auth_success_response({"Authorization": "Bearer selected-account"}),
        release_event=release_auth,
    )
    flow = real_flow(
        with_response=False,
        client_ip=_CLIENT_IP,
        host="shared.example.com",
        path="/server",
        method="POST",
    )
    flow.request.headers["X-Okou-Connector-Intent"] = _REMOVED
    if requestheaders_first:
        flow.request.headers["Content-Length"] = str(mitm_addon.STREAM_BUFFER_LIMIT + 1)

    hook_task: asyncio.Task[None] | None = None
    with (
        endpoint.run(),
        mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
            api_url=endpoint.api_url,
        ),
    ):
        hook = (
            await_requestheaders_result(mitm_addon.requestheaders(flow))
            if requestheaders_first
            else mitm_addon.request(flow)
        )
        hook_task = asyncio.create_task(hook)
        try:
            assert await asyncio.to_thread(endpoint.wait_for_request_count, 1)
            registry_data = json.loads(registry_path.read_text())
            sandbox = registry_data["sandboxes"][_CLIENT_IP]
            sandbox["firewalls"] = [{"kind": "builtin", "name": _RETAINED}]
            sandbox["connectorRoutingVariables"] = {}
            next_path = registry_path.with_name("registry.next.json")
            next_path.write_text(json.dumps(registry_data))
            next_path.replace(registry_path)
            release_auth.set()
            await hook_task
        finally:
            release_auth.set()
            await cancel_pending_task(hook_task)
        if requestheaders_first:
            assert flow.request.stream is False
            await mitm_addon.request(flow)

    assert endpoint.request_count == 1
    assert flow.response is not None
    assert flow.response.status_code == 424
    assert json.loads(flow.response.content)["error"] == "connector_not_configured_for_run"
    assert "Authorization" not in flow.request.headers


@pytest.mark.parametrize(
    ("removed_host", "retained_host", "include_intent"),
    [
        ("removed.example.com", "retained.example.com", False),
        ("shared.example.com", "shared.example.com", True),
    ],
    ids=["unique-endpoint", "shared-endpoint"],
)
async def test_removed_connector_becomes_ordinary_request_without_auth(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
    removed_host,
    retained_host,
    include_intent,
):
    removed_base = f"https://{removed_host}"
    retained_base = f"https://{retained_host}"
    registry_path, cache_path = _write_active_state(
        tmp_path,
        removed_base=removed_base,
        retained_base=retained_base,
    )
    _remove_from_catalog(cache_path, retained_base=retained_base)
    registry.reset_cache_for_tests()
    removed_intent = (("X-Okou-Connector-Intent", _REMOVED),) if include_intent else ()
    retained_intent = (("X-Okou-Connector-Intent", _RETAINED),) if include_intent else ()
    removed_flow = real_flow(
        with_response=False,
        client_ip=_CLIENT_IP,
        host=removed_host,
        path="/items/123",
        request_headers=headers(
            ("Host", removed_host),
            *removed_intent,
        ),
    )
    retained_flow = real_flow(
        with_response=False,
        client_ip=_CLIENT_IP,
        host=retained_host,
        path="/items/123",
        request_headers=headers(
            ("Host", retained_host),
            *retained_intent,
        ),
    )

    with (
        mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
            api_url="https://api.okou.ai",
        ),
        fake_firewall_headers(headers={"Authorization": "Bearer retained"}) as auth_fetch,
    ):
        state = registry.load_registry_state(str(registry_path))
        await mitm_addon.request(removed_flow)
        await mitm_addon.request(retained_flow)

    assert not isinstance(state, registry.RegistryUnavailable)
    assert state.invalid_sandboxes == {}
    assert state.omitted_builtin_firewalls == {_CLIENT_IP: frozenset({_REMOVED})}
    assert [firewall["name"] for firewall in state.sandboxes[_CLIENT_IP]["firewalls"]] == [
        _RETAINED
    ]
    auth_fetch.assert_awaited_once()
    assert removed_flow.response is None
    assert removed_flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert metadata_keys.FIREWALL_NAME not in removed_flow.metadata
    assert "Authorization" not in removed_flow.request.headers
    assert "X-Okou-Connector-Intent" not in removed_flow.request.headers
    assert retained_flow.response is None
    assert retained_flow.metadata[metadata_keys.FIREWALL_NAME] == _RETAINED
    assert retained_flow.request.headers["Authorization"] == "Bearer retained"


async def test_custom_connector_id_selects_active_owner_and_does_not_fall_through_after_removal(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
):
    custom_connector_id = "550e8400-e29b-41d4-a716-446655440000"
    custom_name = "custom_connector_550e8400e29b41d4a716446655440000"
    sibling_name = "retained-custom-sibling"
    shared_host = "shared.example.com"
    registry_path = tmp_path / "registry.json"
    write_multi_sandbox_registry(
        registry_path,
        {
            _CLIENT_IP: {
                "runId": "run-custom-removal",
                "cliAgentType": "codex",
                "sandboxToken": "sandbox-token",
                "networkLogPath": str(tmp_path / "network.jsonl"),
                "proxyLogPath": str(tmp_path / "proxy.jsonl"),
                "encryptedSecrets": "iv:tag:data",
                "firewalls": [
                    {
                        "kind": "inline",
                        "firewall": _firewall(
                            custom_name,
                            f"https://{shared_host}",
                        ),
                        "customConnectorId": custom_connector_id,
                    },
                    {
                        "kind": "inline",
                        "firewall": _firewall(
                            sibling_name,
                            f"https://{shared_host}",
                        ),
                    },
                ],
                "networkPolicies": {
                    name: {
                        "allow": ["items.read"],
                        "deny": [],
                        "ask": [],
                        "unknownPolicy": "deny",
                    }
                    for name in (custom_name, sibling_name)
                },
                "connectorRoutingVariables": {f"custom:{custom_connector_id}": {}},
                "billableFirewalls": [],
            }
        },
    )
    active_flow = real_flow(
        with_response=False,
        client_ip=_CLIENT_IP,
        host=shared_host,
        path="/items/123",
        request_headers=headers(
            ("Host", shared_host),
            ("X-Okou-Connector-Intent", custom_connector_id),
        ),
    )
    removed_flow = real_flow(
        with_response=False,
        client_ip=_CLIENT_IP,
        host=shared_host,
        path="/items/123",
        request_headers=headers(
            ("Host", shared_host),
            ("X-Okou-Connector-Intent", custom_connector_id),
        ),
    )

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer selected"}) as auth_fetch,
    ):
        await mitm_addon.request(active_flow)
        write_multi_sandbox_registry(
            registry_path,
            {
                _CLIENT_IP: {
                    "runId": "run-custom-removal",
                    "cliAgentType": "codex",
                    "sandboxToken": "sandbox-token",
                    "networkLogPath": str(tmp_path / "network.jsonl"),
                    "proxyLogPath": str(tmp_path / "proxy.jsonl"),
                    "encryptedSecrets": "iv:tag:data",
                    "connectorRoutingVariables": {f"custom:{custom_connector_id}": {}},
                    "firewalls": [
                        {
                            "kind": "inline",
                            "firewall": _firewall(
                                sibling_name,
                                f"https://{shared_host}",
                            ),
                        }
                    ],
                    "networkPolicies": {
                        sibling_name: {
                            "allow": ["items.read"],
                            "deny": [],
                            "ask": [],
                            "unknownPolicy": "deny",
                        }
                    },
                    "omittedCustomConnectorIds": [custom_connector_id],
                    "billableFirewalls": [],
                }
            },
        )
        registry.reset_cache_for_tests()
        state = registry.load_registry_state(str(registry_path))
        await mitm_addon.request(removed_flow)

    assert not isinstance(state, registry.RegistryUnavailable)
    assert state.omitted_custom_connector_ids == {_CLIENT_IP: frozenset({custom_connector_id})}
    auth_fetch.assert_awaited_once()
    assert active_flow.response is None
    assert active_flow.metadata[metadata_keys.FIREWALL_NAME] == custom_name
    assert active_flow.request.headers["Authorization"] == "Bearer selected"
    assert removed_flow.response is None
    assert removed_flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert metadata_keys.FIREWALL_NAME not in removed_flow.metadata
    assert "Authorization" not in removed_flow.request.headers


@pytest.mark.parametrize("selected_kind", ["builtin", "custom", "unknown"])
async def test_shared_builtin_custom_endpoint_injects_only_explicit_owner(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers, selected_kind
):
    builtin_name = "builtin-mcp"
    custom_name = "custom-mcp"
    custom_id = "550e8400-e29b-41d4-a716-446655440000"
    registry_path = tmp_path / "registry.json"
    cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
    sandbox = {
        **_active_sandbox(tmp_path),
        "firewalls": [
            {"kind": "builtin", "name": builtin_name},
            {
                "kind": "inline",
                "customConnectorId": custom_id,
                "firewall": _firewall(custom_name, "https://shared.example.com"),
            },
        ],
        "connectorRoutingVariables": {f"builtin:{builtin_name}": {}, f"custom:{custom_id}": {}},
        "networkPolicies": {
            name: {"allow": ["items.read"], "deny": [], "ask": [], "unknownPolicy": "deny"}
            for name in (builtin_name, custom_name)
        },
    }
    write_multi_sandbox_registry(registry_path, {_CLIENT_IP: sandbox})
    write_catalog_cache(
        cache_path,
        digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        version="catalog-a",
        firewalls={builtin_name: _firewall(builtin_name, "https://shared.example.com")},
    )
    intent = {"builtin": builtin_name, "custom": custom_id, "unknown": "unavailable"}[selected_kind]
    flow = real_flow(
        with_response=False,
        client_ip=_CLIENT_IP,
        host="shared.example.com",
        path="/items/123",
        request_headers=headers(
            ("Host", "shared.example.com"), ("X-Okou-Connector-Intent", intent)
        ),
    )
    with (
        mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
            api_url="https://api.okou.ai",
        ),
        fake_firewall_headers(headers={"Authorization": f"Bearer {selected_kind}"}) as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert "X-Okou-Connector-Intent" not in flow.request.headers
    if selected_kind == "unknown":
        auth_fetch.assert_not_awaited()
        assert flow.response is not None
        assert flow.response.status_code == 409
        assert "Authorization" not in flow.request.headers
    else:
        auth_fetch.assert_awaited_once()
        assert flow.response is None
        assert flow.metadata[metadata_keys.FIREWALL_NAME] == f"{selected_kind}-mcp"
        assert flow.request.headers["Authorization"] == f"Bearer {selected_kind}"


async def test_catalog_removal_during_auth_revalidation_discards_old_credentials(
    tmp_path,
    real_flow,
    mitm_ctx,
    monkeypatch,
    headers,
):
    removed_base = "https://removed.example.com"
    retained_base = "https://retained.example.com"
    registry_path, cache_path = _write_active_state(
        tmp_path,
        removed_base=removed_base,
        retained_base=retained_base,
    )
    flow = real_flow(
        with_response=False,
        client_ip=_CLIENT_IP,
        host="removed.example.com",
        path="/items/123",
        request_headers=headers(
            ("Host", "removed.example.com"),
            ("X-Okou-Connector-Intent", _REMOVED),
        ),
    )
    auth_resolution_entered = asyncio.Event()
    release_auth_resolution = asyncio.Event()

    async def resolve_auth(*_args, **_kwargs):
        auth_resolution_entered.set()
        await release_auth_resolution.wait()
        return firewall_auth_response(
            headers={"Authorization": "Bearer stale"},
            query={},
            resolved_secrets=["REMOVED_TOKEN"],
        )

    auth_fetch = AsyncMock(side_effect=resolve_auth)
    monkeypatch.setattr(auth, "get_firewall_headers", auth_fetch)
    request_task: asyncio.Task[None] | None = None

    with mitm_ctx(
        registry_path=str(registry_path),
        builtin_firewall_catalog_cache_path=str(cache_path),
        api_url="https://api.okou.ai",
    ):
        request_task = asyncio.create_task(mitm_addon.request(flow))
        try:
            await asyncio.wait_for(auth_resolution_entered.wait(), timeout=1)
            _remove_from_catalog(cache_path, retained_base=retained_base)
            release_auth_resolution.set()
            _ = await request_task
        finally:
            release_auth_resolution.set()
            await cancel_pending_task(request_task)

    auth_fetch.assert_awaited_once()
    assert flow.response is not None
    assert flow.response.status_code == 409
    assert json.loads(flow.response.content)["error"] == "firewall_authorization_changed"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "firewall_authorization_changed"
    assert "Authorization" not in flow.request.headers
