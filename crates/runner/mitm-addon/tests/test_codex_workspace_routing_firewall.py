"""Codex workspace routing uses only its exact authenticated firewall route."""

import flow_metadata_keys as metadata_keys
import mitm_addon
from tests.auth_endpoint_helpers import FakeAuthEndpoint, firewall_auth_success_response
from tests.registry_builtin_helpers import write_registry_with_cache


async def test_codex_workspace_discovery_auth_is_scoped_to_exact_get(tmp_path, real_flow, mitm_ctx):
    firewall_name = "model-provider:codex-oauth-token"
    discovery_base = "https://chatgpt.com/backend-api/wham/accounts/check"
    registry_path, catalog_path = write_registry_with_cache(
        tmp_path,
        {
            "10.200.0.5": {
                "runId": "codex-workspace-routing",
                "cliAgentType": "codex",
                "sandboxToken": "sandbox-token",
                "encryptedSecrets": "iv:tag:data",
                "networkLogPath": str(tmp_path / "network.jsonl"),
                "proxyLogPath": str(tmp_path / "proxy.jsonl"),
                "billableFirewalls": [],
                "firewalls": [{"kind": "builtin", "name": firewall_name}],
                "networkPolicies": {
                    firewall_name: {
                        "allow": ["codex:workspace-routing"],
                        "deny": [],
                        "ask": [],
                        "unknownPolicy": "deny",
                    }
                },
            }
        },
        {
            firewall_name: {
                "name": firewall_name,
                "apis": [
                    {
                        "base": discovery_base,
                        "auth": {
                            "headers": {
                                "Authorization": "Bearer ${{ secrets.CHATGPT_ACCESS_TOKEN }}",
                                "ChatGPT-Account-ID": "${{ secrets.CHATGPT_ACCOUNT_ID }}",
                            }
                        },
                        "permissions": [{"name": "codex:workspace-routing", "rules": ["GET /"]}],
                    }
                ],
            }
        },
    )
    endpoint = FakeAuthEndpoint()
    endpoint.queue_json_response(
        firewall_auth_success_response(
            {
                "Authorization": "Bearer resolved-token",
                "ChatGPT-Account-ID": "resolved-account",
            }
        )
    )

    def request(method: str, path: str):
        flow = real_flow(
            with_response=False,
            client_ip="10.200.0.5",
            host="chatgpt.com",
            method=method,
            path=path,
        )
        flow.request.headers["Authorization"] = "Bearer guest-placeholder"
        flow.request.headers["ChatGPT-Account-ID"] = "guest-placeholder-account"
        return flow

    discovery = request("GET", "/backend-api/wham/accounts/check")
    wrong_method = request("POST", "/backend-api/wham/accounts/check")
    subpath = request("GET", "/backend-api/wham/accounts/check/extra")
    neighbor = request("GET", "/backend-api/wham/settings/user")

    with (
        endpoint.run(),
        mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(catalog_path),
            api_url=endpoint.api_url,
        ),
    ):
        for flow in (discovery, wrong_method, subpath, neighbor):
            await mitm_addon.request(flow)

    assert discovery.response is None
    assert discovery.metadata[metadata_keys.FIREWALL_BASE] == discovery_base
    assert discovery.metadata[metadata_keys.FIREWALL_PERMISSION] == "codex:workspace-routing"
    assert discovery.request.headers["Authorization"] == "Bearer resolved-token"
    assert discovery.request.headers["ChatGPT-Account-ID"] == "resolved-account"
    assert endpoint.request_count == 1

    for flow in (wrong_method, subpath):
        assert flow.response is not None
        assert flow.request.headers["Authorization"] == "Bearer guest-placeholder"

    assert neighbor.response is None
    assert metadata_keys.FIREWALL_NAME not in neighbor.metadata
    assert neighbor.request.headers["Authorization"] == "Bearer guest-placeholder"
