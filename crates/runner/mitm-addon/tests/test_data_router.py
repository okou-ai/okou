"""Data Router billing identity through the production request and response hooks."""

import asyncio
import json
import time
import uuid
from unittest.mock import AsyncMock, patch

import pytest
from mitmproxy import http

import firewall_auth_cache
import firewall_auth_client
import mitm_addon
from tests.pending_helpers import assert_pending
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry


def router_registry(tmp_path, *, owner="data-router"):
    return _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            run_id=str(uuid.uuid4()),
            firewall_name=owner,
            billable_firewalls=[owner],
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


async def test_each_router_response_registers_its_own_id_after_upstream(
    tmp_path, real_flow, mitm_ctx
):
    path = router_registry(tmp_path)
    flows = [router_flow(real_flow), router_flow(real_flow)]
    ids = [str(uuid.uuid4()), str(uuid.uuid4())]
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
                    ),
                    expires_at=time.time() + 3600,
                )
            ),
        ) as auth_fetch,
        patch.object(firewall_auth_client, "post_platform_json", registration),
    ):
        for flow, request_id in zip(flows, ids, strict=True):
            assert mitm_addon.requestheaders(flow) is None
            await mitm_addon.request(flow)
            assert flow.response is None
            assert flow.request.headers["Authorization"] == "Bearer service-token"
            assert "X-Okou-Data-Request-Id" not in flow.request.headers
            assert registration.await_count == flows.index(flow)
            flow.response = http.Response.make(
                200, b"unparsed vendor result", {"X-Okou-Data-Request-Id": request_id}
            )
            completion = mitm_addon.response(flow)
            assert completion is not None
            await completion
            assert flow.response.content == b"unparsed vendor result"
    assert auth_fetch.await_count == 1
    assert registration.await_count == 2
    for request_id, call in zip(ids, registration.await_args_list, strict=True):
        assert call.args[0] == "https://api.okou.ai/api/webhooks/agent/data-request"
        assert json.loads(call.args[1]) == {
            "runId": json.loads(path.read_text())["sandboxes"]["10.200.0.5"]["runId"],
            "requestId": request_id,
        }


@pytest.mark.parametrize("status", [200, 502])
async def test_response_completion_waits_for_registration_including_provider_errors(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, status
):
    path = router_registry(tmp_path)
    flow = router_flow(real_flow)
    started = asyncio.Event()
    released = asyncio.Event()

    async def register(*_args):
        started.set()
        await released.wait()

    with (
        mitm_ctx(registry_path=str(path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer service-token"}),
        patch.object(firewall_auth_client, "post_platform_json", register),
    ):
        await mitm_addon.request(flow)
        flow.response = http.Response.make(
            status, b"provider response", {"X-Okou-Data-Request-Id": str(uuid.uuid4())}
        )
        pending = mitm_addon.response(flow)
        assert pending is not None

        async def complete_response():
            await pending

        async with asyncio.TaskGroup() as group:
            completion = group.create_task(complete_response())
            try:
                await started.wait()
                assert not completion.done()
                assert_pending(tmp_path / "delivery-control", flows=1, buffered=0, reports=0)
            finally:
                released.set()
        assert_pending(tmp_path / "delivery-control", flows=0, buffered=0, reports=0)
        assert flow.response.status_code == status
        assert flow.response.content == b"provider response"


async def test_failed_response_registration_is_reported_without_replaying_upstream(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers
):
    path = router_registry(tmp_path)
    flow = router_flow(real_flow)
    registration = AsyncMock(side_effect=TimeoutError)
    with (
        mitm_ctx(registry_path=str(path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer service-token"}),
        patch.object(firewall_auth_client, "post_platform_json", registration),
    ):
        await mitm_addon.request(flow)
        registration.assert_not_awaited()
        flow.response = http.Response.make(
            200, b"already executed", {"X-Okou-Data-Request-Id": str(uuid.uuid4())}
        )
        pending = mitm_addon.response(flow)
        assert pending is not None
        with pytest.raises(TimeoutError):
            await pending
    registration.assert_awaited_once()
    assert flow.response.content == b"already executed"


@pytest.mark.parametrize(
    ("method", "name"),
    [("tools/list", ""), ("tools/call", "billing_get"), ("tools/call", "pricing_list")],
)
async def test_control_responses_without_identity_are_not_registered(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, method, name
):
    path = router_registry(tmp_path)
    flow = router_flow(real_flow, method=method, name=name)
    registration = AsyncMock()
    with (
        mitm_ctx(registry_path=str(path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer service-token"}),
        patch.object(firewall_auth_client, "post_platform_json", registration),
    ):
        await mitm_addon.request(flow)
        assert "X-Okou-Data-Request-Id" not in flow.request.headers
        flow.response = http.Response.make(200, b"control response")
        pending = mitm_addon.response(flow)
        assert pending is not None
        await pending
    registration.assert_not_awaited()


async def test_another_provider_cannot_register_a_router_response_id(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers
):
    path = router_registry(tmp_path, owner="github")
    flow = router_flow(real_flow)
    registration = AsyncMock()
    with (
        mitm_ctx(registry_path=str(path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer service-token"}),
        patch.object(firewall_auth_client, "post_platform_json", registration),
    ):
        await mitm_addon.request(flow)
        flow.response = http.Response.make(
            200, b"another provider", {"X-Okou-Data-Request-Id": str(uuid.uuid4())}
        )
        assert mitm_addon.response(flow) is None
    registration.assert_not_awaited()
