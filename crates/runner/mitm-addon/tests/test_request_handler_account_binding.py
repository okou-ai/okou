"""Published account sources participate in the real request/cache identity."""

import pytest

import mitm_addon
from tests.auth_endpoint_helpers import FakeAuthEndpoint, firewall_auth_success_response
from tests.registry_builtin_helpers import write_catalog_cache
from tests.registry_helpers import write_multi_sandbox_registry


@pytest.mark.parametrize(
    ("custom", "include_alias_metadata"), [(False, False), (False, True), (True, False)]
)
@pytest.mark.parametrize("change_routing", [False, True])
async def test_account_replacement_resolves_new_credentials_and_retains_same_account_cache(
    tmp_path, real_flow, mitm_ctx, custom, include_alias_metadata, change_routing
):
    client_ip = "10.200.0.5"
    name = "account-service"
    custom_id = "550e8400-e29b-41d4-a716-446655440000"
    accounts = [
        "550e8400-e29b-41d4-a716-446655440001",
        "550e8400-e29b-41d4-a716-446655440002",
    ]
    target = (
        {"kind": "custom", "customConnectorId": custom_id}
        if custom
        else {"kind": "builtin", "connectorSlug": name}
    )
    routing_key = f"custom:{custom_id}" if custom else f"builtin:{name}"
    registry_path = tmp_path / "registry.json"
    cache_path = tmp_path / "catalog.json"
    firewall = {
        "name": name,
        "apis": [
            {
                "base": "https://account.example.com/api",
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.TOKEN }}"}},
                "permissions": [],
            }
        ],
    }
    write_catalog_cache(
        cache_path,
        digest="sha256:" + "a" * 64,
        version="account-binding",
        firewalls={name: firewall},
    )

    def publish(account_index, refresh):
        routing = {"workspace": str(account_index) if change_routing else "shared"}
        entry = (
            {"kind": "inline", "customConnectorId": custom_id, "firewall": firewall}
            if custom
            else {"kind": "builtin", "name": name, "baseUrlVars": routing}
        )
        entry["sourceId"] = accounts[account_index]
        sandbox = {
            "runId": "account-binding-run",
            "cliAgentType": "codex",
            "sandboxToken": "sandbox-token",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": str(tmp_path / "network.jsonl"),
            "proxyLogPath": str(tmp_path / "proxy.jsonl"),
            "billableFirewalls": [],
            "firewalls": [entry],
            "connectorRuntimeTargets": [target],
            "connectorRoutingVariables": {routing_key: routing},
            "networkPolicies": {
                name: {
                    "allow": ["read"] if refresh else [],
                    "deny": [],
                    "ask": [],
                    "unknownPolicy": "allow",
                }
            },
        }
        if include_alias_metadata:
            sandbox["secretConnectorMap"] = {"TOKEN": name}
            sandbox["secretConnectorMetadataMap"] = {
                "TOKEN": {"sourceType": "connector", "sourceId": accounts[account_index]}
            }
        next_path = tmp_path / "registry.next.json"
        write_multi_sandbox_registry(next_path, {client_ip: sandbox})
        next_path.replace(registry_path)

    if custom:
        firewall["apis"][0]["id"] = "account-service:0"
    publish(0, False)
    endpoint = FakeAuthEndpoint()
    for account in ("a", "b"):
        endpoint.queue_json_response(
            firewall_auth_success_response({"Authorization": f"Bearer account-{account}"})
        )
    with (
        endpoint.run(),
        mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
            api_url=endpoint.api_url,
        ),
    ):
        for index, account in enumerate(("a", "b")):
            for refresh in (False, True):
                publish(index, refresh)
                flow = real_flow(
                    with_response=False,
                    client_ip=client_ip,
                    host="account.example.com",
                    path="/api",
                    method="POST",
                )
                flow.request.headers["X-Okou-Connector-Intent"] = custom_id if custom else name
                await mitm_addon.request(flow)
                assert flow.response is None
                assert flow.error is None
                assert flow.request.headers["Authorization"] == f"Bearer account-{account}"

    assert len(endpoint.requests) == 2
    for index, request in enumerate(endpoint.requests):
        matched = request.json_body()["matchedFirewall"]
        assert matched["sourceId"] == accounts[index]
        assert matched["routingVariables"] == {
            "workspace": str(index) if change_routing else "shared"
        }
        if include_alias_metadata:
            assert (
                request.json_body()["secretConnectorMetadataMap"]["TOKEN"]["sourceId"]
                == accounts[index]
            )
