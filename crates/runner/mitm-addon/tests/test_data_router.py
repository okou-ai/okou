"""Data Router correlation through the production request hooks."""

import json
import uuid
from unittest.mock import AsyncMock, patch

import pytest

import firewall_auth_cache
import firewall_auth_client
import mitm_addon
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry


def router_registry(tmp_path):
    return _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            run_id=str(uuid.uuid4()),
            firewall_name="data-router",
            api_entry={
                "base": "https://data.okou.ai/mcp",
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.OKOU_DATA_TOKEN }}"}},
                "permissions": [{"name": "call", "rules": ["ANY /{path*}"]}],
            },
            network_policy={"allow": ["call"], "deny": [], "ask": [], "unknownPolicy": "deny"},
        ),
    )


def router_flow(real_flow, *, method="tools/call", name="web_search"):
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="data.okou.ai",
        method="POST",
        path="/mcp",
    )
    flow.request.headers["X-Okou-Data-Request-Id"] = "sandbox-forged"
    flow.request.content = json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": method, "params": {"name": name, "arguments": {}}}
    ).encode()
    return flow


async def test_cached_credentials_still_register_each_request_before_upstream(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers
):
    path = router_registry(tmp_path)
    flows = [router_flow(real_flow), router_flow(real_flow)]
    registration = AsyncMock()
    with (
        mitm_ctx(registry_path=str(path), api_url="https://api.okou.ai"),
        patch.object(
            firewall_auth_cache,
            "fetch_firewall_headers",
            AsyncMock(
                return_value=firewall_auth_client.FirewallAuthSuccess(
                    payload=firewall_auth_client.FirewallAuthPayload(
                        headers={"Authorization": "Bearer service-token"}
                    )
                )
            ),
        ) as auth_fetch,
        patch.object(firewall_auth_client, "post_platform_json", registration),
    ):
        for flow in flows:
            assert mitm_addon.requestheaders(flow) is None
            assert not callable(flow.request.stream)
            assert registration.await_count == flows.index(flow)
            await mitm_addon.request(flow)
            assert flow.response is None
            assert flow.request.headers["Authorization"] == "Bearer service-token"
    assert auth_fetch.await_count == 1
    assert registration.await_count == 2
    ids = [flow.request.headers["X-Okou-Data-Request-Id"] for flow in flows]
    assert len(set(ids)) == 2
    for request_id, call in zip(ids, registration.await_args_list, strict=True):
        assert str(uuid.UUID(request_id)) == request_id
        assert json.loads(call.args[1])["requestId"] == request_id


async def test_failed_registration_blocks_paid_execution(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers
):
    path = router_registry(tmp_path)
    flow = router_flow(real_flow)
    with (
        mitm_ctx(registry_path=str(path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer service-token"}),
        patch.object(
            firewall_auth_client, "post_platform_json", AsyncMock(side_effect=TimeoutError)
        ),
        pytest.raises(TimeoutError),
    ):
        await mitm_addon.request(flow)
    assert flow.response is not None
    assert flow.response.status_code == 500
    assert "X-Okou-Data-Request-Id" not in flow.request.headers


async def test_control_requests_do_not_register_or_keep_forged_identity(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers
):
    path = router_registry(tmp_path)
    flows = [
        router_flow(real_flow, method="tools/list"),
        router_flow(real_flow, name="billing_get"),
    ]
    registration = AsyncMock()
    with (
        mitm_ctx(registry_path=str(path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer service-token"}),
        patch.object(firewall_auth_client, "post_platform_json", registration),
    ):
        for flow in flows:
            await mitm_addon.request(flow)
            assert "X-Okou-Data-Request-Id" not in flow.request.headers
    registration.assert_not_awaited()
