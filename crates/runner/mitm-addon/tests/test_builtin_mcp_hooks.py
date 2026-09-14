"""Builtin MCP uses endpoint-scoped firewall admission, not tool permissions."""

from unittest.mock import AsyncMock, patch

import pytest

import firewall_auth_cache
import flow_metadata_keys as metadata_keys
import mitm_addon
from tests.builtin_firewall_cache_helpers import serialize_builtin_firewall_catalog_cache
from tests.firewall_auth_helpers import firewall_auth_success
from tests.registry_helpers import write_trusted_catalog_cache_text
from tests.request_handler_helpers import _write_registry

ACCOUNT_ID = "550e8400-e29b-41d4-a716-446655440001"


def write_mcp_registry(tmp_path, strategy):
    auth_config = (
        {"headers": {"Authorization": "Bearer ${{ secrets.MCP_TOKEN }}"}}
        if strategy == "headers"
        else {"query": {"api_key": "${{ secrets.MCP_TOKEN }}"}}
        if strategy == "query"
        else {}
    )
    path = _write_registry(
        tmp_path,
        sandbox_info={
            "runId": "run-builtin-mcp",
            "cliAgentType": "claude-code",
            "sandboxToken": "sandbox-token",
            "encryptedSecrets": "iv:tag:data",
            "connectorRoutingVariables": {"builtin:service": {}, "builtin:service-mcp": {}},
            "secretConnectorMap": {"MCP_TOKEN": "service-mcp"},
            "secretConnectorMetadataMap": {
                "MCP_TOKEN": {"sourceType": "connector", "sourceId": ACCOUNT_ID}
            },
            "billableFirewalls": [],
            "networkLogPath": str(tmp_path / "network.jsonl"),
            "proxyLogPath": str(tmp_path / "proxy.jsonl"),
            "firewalls": [
                {
                    "kind": "builtin",
                    "name": "service",
                    "sourceId": "550e8400-e29b-41d4-a716-446655440002",
                },
                {"kind": "builtin", "name": "service-mcp", "sourceId": ACCOUNT_ID},
            ],
            "networkPolicies": {
                "service": {"allow": [], "deny": ["read"], "ask": [], "unknownPolicy": "deny"},
                "service-mcp": {"allow": [], "deny": [], "ask": [], "unknownPolicy": "allow"},
            },
        },
    )
    write_trusted_catalog_cache_text(
        tmp_path / "builtin-firewall-catalog-cache.json",
        serialize_builtin_firewall_catalog_cache(
            digest="sha256:" + "a" * 64,
            version="builtin-mcp-test",
            firewalls={
                "service": {
                    "name": "service",
                    "apis": [
                        {
                            "base": "https://tools.example.com",
                            "auth": {"headers": {"Authorization": "Bearer http-only"}},
                            "permissions": [{"name": "read", "rules": ["ANY /{path+}"]}],
                        }
                    ],
                },
                "service-mcp": {
                    "name": "service-mcp",
                    "apis": [
                        {
                            "base": "https://tools.example.com/mcp",
                            "auth": auth_config,
                            "hostPolicy": {"kind": "publicDestination"},
                            "permissions": [],
                        }
                    ],
                },
            },
        ),
    )
    return path


@pytest.mark.parametrize("strategy", ["none", "headers", "query"])
@pytest.mark.parametrize("method", ["POST", "GET", "DELETE"])
async def test_builtin_mcp_auth_and_private_intent_through_hooks(
    tmp_path, real_flow, mitm_ctx, headers, strategy, method
):
    path = write_mcp_registry(tmp_path, strategy)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="93.184.216.34",
        sni="tools.example.com",
        method=method,
        path="/mcp",
        request_headers=headers(
            ("Host", "tools.example.com"),
            ("X-Okou-Connector-Intent", "service-mcp"),
            ("Content-Type", "application/json"),
        ),
    )
    response = firewall_auth_success(
        headers={"Authorization": "Bearer resolved-mcp"} if strategy == "headers" else {},
        query={"api_key": "resolved-mcp"} if strategy == "query" else None,
    )
    with (
        mitm_ctx(registry_path=str(path), api_url="https://api.okou.ai"),
        patch.object(
            firewall_auth_cache, "fetch_firewall_headers", AsyncMock(return_value=response)
        ) as fetch_auth,
    ):
        result = mitm_addon.requestheaders(flow)
        if result is not None:
            await result
        await mitm_addon.request(flow)
    assert flow.response is None
    assert "X-Okou-Connector-Intent" not in flow.request.headers
    assert flow.metadata[metadata_keys.FIREWALL_NAME] == "service-mcp"
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert "http-only" not in str(flow.request.headers)
    if strategy == "none":
        fetch_auth.assert_not_called()
        assert "Authorization" not in flow.request.headers
        assert "api_key" not in flow.request.query
    else:
        fetch_auth.assert_awaited_once()
        assert fetch_auth.await_args is not None
        request = fetch_auth.await_args.args[0]
        assert request.matched_firewall["sourceId"] == ACCOUNT_ID
        if strategy == "headers":
            assert flow.request.headers["Authorization"] == "Bearer resolved-mcp"
        else:
            assert flow.request.query["api_key"] == "resolved-mcp"


@pytest.mark.parametrize("request_path", ["/mcp-elsewhere", "/api/items", "/"])
async def test_builtin_mcp_cannot_use_http_sibling_outside_endpoint(
    tmp_path, real_flow, mitm_ctx, headers, request_path
):
    path = write_mcp_registry(tmp_path, "headers")
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="93.184.216.34",
        sni="tools.example.com",
        method="POST",
        path=request_path,
        request_headers=headers(
            ("Host", "tools.example.com"), ("X-Okou-Connector-Intent", "service-mcp")
        ),
    )
    with (
        mitm_ctx(registry_path=str(path), api_url="https://api.okou.ai"),
        patch.object(firewall_auth_cache, "fetch_firewall_headers", AsyncMock()) as fetch_auth,
    ):
        await mitm_addon.request(flow)
    fetch_auth.assert_not_called()
    assert flow.response is not None
    assert flow.response.status_code >= 400
    assert "Authorization" not in flow.request.headers
    assert "X-Okou-Connector-Intent" not in flow.request.headers
