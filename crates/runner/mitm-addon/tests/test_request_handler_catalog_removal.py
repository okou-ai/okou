"""Active-run request behavior when a valid catalog removes a connector."""

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

import auth
import flow_metadata_keys as metadata_keys
import mitm_addon
import registry
from tests.firewall_auth_helpers import firewall_auth_response
from tests.firewall_helpers import cancel_pending_task
from tests.registry_builtin_helpers import write_catalog_cache
from tests.registry_helpers import write_multi_sandbox_registry

_CLIENT_IP = "10.200.0.5"
_REMOVED = "removed"
_RETAINED = "retained"


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
