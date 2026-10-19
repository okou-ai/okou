"""Codex OAuth requests use the authenticated ChatGPT backend API firewall."""

import json

import pytest

import flow_metadata_keys as metadata_keys
import mitm_addon
from tests.auth_endpoint_helpers import FakeAuthEndpoint, firewall_auth_success_response
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.registry_builtin_helpers import write_registry_with_cache


def _codex_registry(tmp_path):
    firewall_name = "model-provider:codex-oauth-token"
    backend_base = "https://chatgpt.com/backend-api"
    return write_registry_with_cache(
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
                        "allow": ["codex:api"],
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
                        "base": backend_base,
                        "auth": {
                            "headers": {
                                "Authorization": "Bearer ${{ secrets.CHATGPT_ACCESS_TOKEN }}",
                                "ChatGPT-Account-ID": "${{ secrets.CHATGPT_ACCOUNT_ID }}",
                            }
                        },
                        "permissions": [
                            {"name": "codex:api", "rules": ["GET /{path*}", "POST /{path*}"]}
                        ],
                    }
                ],
            }
        },
    )


async def test_codex_backend_api_auth_covers_get_and_post(tmp_path, real_flow, mitm_ctx):
    registry_path, catalog_path = _codex_registry(tmp_path)
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
    post = request("POST", "/backend-api/wham/rate-limit-reset-credits/consume")
    subpath = request("GET", "/backend-api/wham/accounts/check/extra")
    neighbor = request("GET", "/backend-api/wham/settings/user")
    wrong_method = request("DELETE", "/backend-api/wham/accounts/check")
    outside_base = request("GET", "/backend-api-other/wham/accounts/check")

    with (
        endpoint.run(),
        mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(catalog_path),
            api_url=endpoint.api_url,
        ),
    ):
        for flow in (discovery, post, subpath, neighbor, wrong_method, outside_base):
            await mitm_addon.request(flow)

    for flow in (discovery, post, subpath, neighbor):
        assert flow.response is None
        assert flow.metadata[metadata_keys.FIREWALL_BASE] == "https://chatgpt.com/backend-api"
        assert flow.metadata[metadata_keys.FIREWALL_PERMISSION] == "codex:api"
        assert flow.request.headers["Authorization"] == "Bearer resolved-token"
        assert flow.request.headers["ChatGPT-Account-ID"] == "resolved-account"
    assert endpoint.request_count == 1

    assert wrong_method.response is not None
    assert wrong_method.response.status_code == 403
    assert wrong_method.request.headers["Authorization"] == "Bearer guest-placeholder"
    assert outside_base.response is None
    assert metadata_keys.FIREWALL_NAME not in outside_base.metadata
    assert outside_base.request.headers["Authorization"] == "Bearer guest-placeholder"


@pytest.mark.parametrize(
    ("reason", "connectors", "status", "expected_level", "expected_diagnostic"),
    [
        (
            "reconnect_required",
            ["codex-oauth-token"],
            502,
            "info",
            "codex_oauth_reconnect_required",
        ),
        ("upstream_provider", ["codex-oauth-token"], 502, "error", "TOKEN_REFRESH_FAILED"),
        (None, ["codex-oauth-token"], 502, "error", "TOKEN_REFRESH_FAILED"),
        ("reconnect_required", ["other-connector"], 502, "error", "TOKEN_REFRESH_FAILED"),
        ("reconnect_required", ["codex-oauth-token"], 500, "error", "TOKEN_REFRESH_FAILED"),
    ],
)
async def test_codex_workspace_auth_failure_preserves_reconnect_evidence(
    tmp_path, real_flow, mitm_ctx, reason, connectors, status, expected_level, expected_diagnostic
):
    registry_path, catalog_path = _codex_registry(tmp_path)
    endpoint = FakeAuthEndpoint()
    error = {
        "code": "TOKEN_REFRESH_FAILED",
        "message": "Access token refresh failed.",
        "connectors": connectors,
    }
    if reason is not None:
        error["failureReason"] = reason
    endpoint.queue_json_response({"error": error}, status=status)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="chatgpt.com",
        method="GET",
        path="/backend-api/wham/accounts/check",
    )
    with (
        endpoint.run(),
        mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(catalog_path),
            api_url=endpoint.api_url,
        ),
    ):
        await mitm_addon.request(flow)
        mitm_addon.response(flow)

    assert endpoint.request_count == 1
    assert flow.response is not None
    assert flow.response.status_code == status
    response = json.loads(flow.response.get_text())
    assert response["error"] == "TOKEN_REFRESH_FAILED"
    assert response["connectors"] == connectors
    assert response.get("failureReason") == reason
    network = read_jsonl_entries_after_flush(tmp_path / "network.jsonl")
    assert len(network) == 1
    assert network[0]["firewall_error"] == expected_diagnostic
    assert network[0]["firewall_name"] == "model-provider:codex-oauth-token"
    proxy = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
    auth_errors = [entry for entry in proxy if entry.get("error_code") == "TOKEN_REFRESH_FAILED"]
    assert len(auth_errors) == 1
    assert auth_errors[0]["level"] == expected_level
