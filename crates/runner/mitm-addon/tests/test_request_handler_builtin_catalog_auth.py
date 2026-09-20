"""Builtin MCP authentication follows the runner-owned catalog firewall."""

import pytest

import flow_metadata_keys as metadata_keys
import mitm_addon
from tests.auth_endpoint_helpers import FakeAuthEndpoint, firewall_auth_success_response
from tests.registry_builtin_helpers import write_catalog_cache
from tests.registry_helpers import write_multi_sandbox_registry
from tests.requestheaders_helpers import await_requestheaders_result

_CLIENT_IP = "10.200.0.5"
_BUILTIN = "automatic-service"
_CUSTOM = "overlapping-custom"
_SOURCE_ID = "550e8400-e29b-41d4-a716-446655440001"
_CUSTOM_ID = "550e8400-e29b-41d4-a716-446655440000"
_BASE = "https://shared.example.com/server"


def _firewall(name: str, *, oauth: bool, base: str = _BASE) -> dict:
    return {
        "name": name,
        "apis": [
            {
                "id": f"{name}:0",
                "base": base,
                "auth": (
                    {"headers": {"Authorization": "Bearer ${{ secrets.MCP_ACCESS_TOKEN }}"}}
                    if oauth
                    else {}
                ),
                "permissions": [],
            }
        ],
    }


def _replace_catalog(cache_path, *, present: bool, oauth: bool, base: str = _BASE) -> None:
    next_path = cache_path.with_name("catalog.next.json")
    builtin = _firewall(_BUILTIN, oauth=oauth, base=base)
    builtin["apis"][0].pop("id")
    other = _firewall("other-service", oauth=False)
    other["apis"][0].pop("id")
    firewalls = {"other-service": other}
    if present:
        firewalls[_BUILTIN] = builtin
    write_catalog_cache(
        next_path,
        digest="sha256:" + ("a" if present else "b") * 64,
        version="present" if present else "removed",
        firewalls=firewalls,
    )
    next_path.replace(cache_path)


@pytest.mark.parametrize("oauth", [False, True])
@pytest.mark.parametrize("requestheaders_first", [False, True])
async def test_builtin_catalog_auth_removal_and_reinsertion_keep_selected_owner(
    tmp_path, real_flow, mitm_ctx, oauth, requestheaders_first
):
    registry_path = tmp_path / "registry.json"
    cache_path = tmp_path / "catalog.json"
    sandbox = {
        "runId": "builtin-catalog-auth",
        "cliAgentType": "codex",
        "sandboxToken": "sandbox-token",
        "encryptedSecrets": "iv:tag:data",
        "captureNetworkBodies": True,
        "networkLogPath": str(tmp_path / "network.jsonl"),
        "proxyLogPath": str(tmp_path / "proxy.jsonl"),
        "billableFirewalls": [],
        "firewalls": [
            {
                "kind": "builtin",
                "name": _BUILTIN,
                "sourceId": _SOURCE_ID,
            },
            {
                "kind": "inline",
                "sourceId": _CUSTOM_ID,
                "customConnectorId": _CUSTOM_ID,
                "firewall": _firewall(_CUSTOM, oauth=True),
            },
        ],
        "connectorRuntimeTargets": [
            {"kind": "builtin", "connectorSlug": _BUILTIN},
            {"kind": "custom", "customConnectorId": _CUSTOM_ID},
        ],
        "connectorRoutingVariables": {f"builtin:{_BUILTIN}": {}, f"custom:{_CUSTOM_ID}": {}},
        "networkPolicies": {
            name: {"allow": [], "deny": [], "ask": [], "unknownPolicy": "allow"}
            for name in (_BUILTIN, _CUSTOM)
        },
    }
    write_multi_sandbox_registry(registry_path, {_CLIENT_IP: sandbox})
    _replace_catalog(cache_path, present=True, oauth=oauth)
    endpoint = FakeAuthEndpoint()
    if oauth:
        endpoint.queue_json_response(
            firewall_auth_success_response({"Authorization": "Bearer selected-account"})
        )
    endpoint.queue_json_response(
        firewall_auth_success_response({"Authorization": "Bearer custom-account"})
    )

    flows = []
    with (
        endpoint.run(),
        mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
            api_url=endpoint.api_url,
        ),
    ):
        for present, intent in [
            (True, _BUILTIN),
            (False, _BUILTIN),
            (False, _CUSTOM_ID),
            (True, _BUILTIN),
        ]:
            _replace_catalog(cache_path, present=present, oauth=oauth)
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
                result = mitm_addon.requestheaders(flow)
                if result is not None:
                    await await_requestheaders_result(result)
            await mitm_addon.request(flow)
            flows.append(flow)

    before, removed, custom, restored = flows
    for flow in flows:
        assert flow.response is None
        assert flow.error is None
    for flow in (before, restored):
        assert flow.metadata[metadata_keys.FIREWALL_NAME] == _BUILTIN
        assert flow.request.headers.get("Authorization") == (
            "Bearer selected-account" if oauth else None
        )
    assert metadata_keys.FIREWALL_NAME not in removed.metadata
    assert "Authorization" not in removed.request.headers
    assert custom.metadata[metadata_keys.FIREWALL_NAME] == _CUSTOM
    assert custom.request.headers["Authorization"] == "Bearer custom-account"
    assert endpoint.request_count == (2 if oauth else 1)
    if oauth:
        matched = endpoint.requests[0].json_body()["matchedFirewall"]
        assert isinstance(matched, dict)
        assert matched["sourceId"] == _SOURCE_ID
        assert matched["connectorSlug"] == _BUILTIN
        assert matched["base"] == _BASE


@pytest.mark.parametrize("requestheaders_first", [False, True])
async def test_builtin_catalog_auth_uses_current_catalog_destination(
    tmp_path, real_flow, mitm_ctx, requestheaders_first
):
    registry_path = tmp_path / "registry.json"
    cache_path = tmp_path / "catalog.json"
    sandbox = {
        "runId": "builtin-catalog-auth-destination",
        "cliAgentType": "codex",
        "sandboxToken": "sandbox-token",
        "encryptedSecrets": "iv:tag:data",
        "networkLogPath": str(tmp_path / "network.jsonl"),
        "proxyLogPath": str(tmp_path / "proxy.jsonl"),
        "billableFirewalls": [],
        "firewalls": [
            {
                "kind": "builtin",
                "name": _BUILTIN,
                "sourceId": _SOURCE_ID,
            }
        ],
        "connectorRuntimeTargets": [{"kind": "builtin", "connectorSlug": _BUILTIN}],
        "connectorRoutingVariables": {f"builtin:{_BUILTIN}": {}},
        "networkPolicies": {
            _BUILTIN: {"allow": [], "deny": [], "ask": [], "unknownPolicy": "allow"}
        },
    }
    write_multi_sandbox_registry(registry_path, {_CLIENT_IP: sandbox})
    _replace_catalog(
        cache_path,
        present=True,
        oauth=True,
        base="https://replacement.example.com/server",
    )
    endpoint = FakeAuthEndpoint()
    endpoint.queue_json_response(
        {"error": {"code": "CONNECTOR_NOT_CONFIGURED", "message": "Connector not configured"}},
        status=424,
    )
    with (
        endpoint.run(),
        mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
            api_url=endpoint.api_url,
        ),
    ):
        flow = real_flow(
            with_response=False,
            client_ip=_CLIENT_IP,
            host="replacement.example.com",
            path="/server",
            method="POST",
        )
        flow.request.headers["X-Okou-Connector-Intent"] = _BUILTIN
        if requestheaders_first:
            flow.request.headers["Content-Length"] = str(mitm_addon.STREAM_BUFFER_LIMIT + 1)
            result = mitm_addon.requestheaders(flow)
            if result is not None:
                await await_requestheaders_result(result)
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert "Authorization" not in flow.request.headers
    assert endpoint.request_count == 1
    matched = endpoint.requests[0].json_body()["matchedFirewall"]
    assert isinstance(matched, dict)
    assert matched["base"] == "https://replacement.example.com/server"
    assert matched["sourceId"] == _SOURCE_ID
