"""Shared wire fixtures connect real X hooks and delivery to API contract tests."""

import json
from datetime import datetime
from pathlib import Path

import pytest
from mitmproxy import http
from mitmproxy.flow import Error

import mitm_addon
import usage
from tests.flow_helpers import response_stream
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry
from tests.usage_helpers import fresh_usage_executor_context
from usage.providers.connectors import x_resources

_CONTRACT_PATH = (
    Path(__file__).resolve().parents[4]
    / "turbo/packages/api-contracts/src/contracts/__tests__/fixtures/x-resource-observations.json"
)
_CASES = json.loads(_CONTRACT_PATH.read_text())["cases"]


@pytest.mark.parametrize("case", _CASES, ids=lambda case: case["name"])
async def test_real_x_hooks_deliver_shared_wire_contract(
    case: dict,
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    usage_webhook_server,
    monkeypatch,
):
    # The fixed fixture clock is the only internal control: callers cannot
    # complete a provider response at a chosen UTC millisecond in real time.
    class Clock(datetime):
        value = datetime.fromisoformat(case["chunks"][0]["observedAt"])

        @classmethod
        def now(cls, tz=None):
            return cls.value.astimezone(tz)

    monkeypatch.setattr(x_resources, "datetime", Clock)
    monkeypatch.setattr(usage.webhook, "datetime", Clock)
    request = case["request"]
    request_path = request["path"].split("?", 1)[0]
    sandbox = _single_firewall_sandbox(
        tmp_path,
        run_id=case["runId"],
        sandbox_marker="x-resource-contract-token",
        firewall_name="x",
        billable_firewalls=["x"],
        api_entry={
            "base": "https://api.x.com",
            "auth": {"headers": {"Authorization": "Bearer synthetic-secret"}},
            "permissions": [
                {
                    "name": request["permission"],
                    "rules": [f"{request['method']} {request_path}"],
                }
            ],
        },
        network_policy={"allow": [request["permission"]], "deny": [], "unknownPolicy": "deny"},
    )
    registry_path = _write_registry(tmp_path, sandbox_info=sandbox)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.x.com",
        path=request["path"],
        method=request["method"],
    )
    # mitmproxy supplies this immutable flow identity; the literal golden source
    # UUIDs below are not recomputed with the producer's idempotency helper.
    flow.id = case["flowId"]
    with (
        mitm_ctx(registry_path=str(registry_path), api_url=usage_webhook_server.api_url),
        fake_firewall_headers(headers={"Authorization": "Bearer synthetic-resolved"}),
        fresh_usage_executor_context(),
    ):
        await mitm_addon.request(flow)
        assert flow.response is None
        assert flow.request.headers["Authorization"] == "Bearer synthetic-resolved"
        flow.response = http.Response.make(200, b"", {"Content-Type": "application/json"})
        mitm_addon.responseheaders(flow)
        stream = response_stream(flow)
        for index, chunk in enumerate(case["chunks"]):
            Clock.value = datetime.fromisoformat(chunk["observedAt"])
            body = chunk["body"].encode()
            assert stream(body) == body
            if case["completion"] == "error":
                usage.flush_usage_events(trigger="test")
                # Both complete rows must reach HTTP while the NDJSON response
                # is still open, including the row before the malformed tail.
                assert usage_webhook_server.wait_for_request_count(index + 1)
        if case["completion"] == "response":
            stream(b"")
            mitm_addon.response(flow)
        else:
            flow.error = Error("synthetic stream interruption")
            mitm_addon.error(flow)
        usage.flush_usage_events(trigger="test")
        assert usage_webhook_server.wait_for_request_count(len(case["expectedPayloads"]))
        mitm_addon.response(flow)
        flow.error = Error("duplicate terminal notification")
        mitm_addon.error(flow)
        usage.flush_usage_events(trigger="test")

    captured = usage_webhook_server.requests
    assert [request.json_body() for request in captured] == case["expectedPayloads"]
    for request in captured:
        assert request.method == "POST"
        assert request.path == "/api/webhooks/agent/usage-event"
        assert request.header("authorization") == "Bearer x-resource-contract-token"
        assert request.header("content-type") == "application/json"
        assert len(request.body) <= 256 * 1024
