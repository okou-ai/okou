"""API capability propagation through the real registry and request hook."""

import pytest

import flow_metadata
import flow_metadata_keys as metadata_keys
import mitm_addon
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry


def _sandbox(tmp_path, fields):
    return _single_firewall_sandbox(
        tmp_path,
        firewall_name="x",
        billable_firewalls=["x"],
        api_entry={
            "base": "https://api.x.com",
            "auth": {"headers": {"Authorization": "Bearer secret"}},
            "permissions": [{"name": "tweet.read", "rules": ["GET /2/tweets"]}],
        },
        network_policy={"allow": ["tweet.read"], "deny": [], "unknownPolicy": "deny"},
        sandbox_fields=fields,
    )


@pytest.mark.parametrize("start_date", [None, "2026-09-17", "2099-01-01"])
async def test_registry_capability_reaches_matched_request(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, start_date
):
    fields = (
        {"xResourceBilling": {"protocol": "x-resource-v1", "startDate": start_date}}
        if start_date is not None
        else {}
    )
    sandbox = _sandbox(tmp_path, fields)
    registry_path = _write_registry(tmp_path, sandbox_info=sandbox)
    flow = real_flow(
        with_response=False, client_ip="10.200.0.5", host="api.x.com", path="/2/tweets"
    )
    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}),
    ):
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.request.headers["Authorization"] == "Bearer resolved"
    capability = flow_metadata.x_resource_billing(flow.metadata)
    if start_date is None:
        assert capability is None
    else:
        assert capability == flow_metadata.XResourceBilling("x-resource-v1", start_date)
        # An in-flight request retains its original immutable capability if the
        # registry changes while its response is still pending.
        _write_registry(tmp_path, sandbox_info=_sandbox(tmp_path, {}))
        next_flow = real_flow(
            with_response=False, client_ip="10.200.0.5", host="api.x.com", path="/2/tweets"
        )
        with (
            mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
            fake_firewall_headers(headers={"Authorization": "Bearer resolved"}),
        ):
            await mitm_addon.request(next_flow)
        assert next_flow.response is None
        assert flow_metadata.x_resource_billing(next_flow.metadata) is None
        assert flow_metadata.x_resource_billing(flow.metadata) == capability


@pytest.mark.parametrize(
    "capability",
    [
        None,
        "x-resource-v1",
        {},
        {"protocol": "x-resource-v2", "startDate": "2099-01-01"},
        {"protocol": "x-resource-v1", "startDate": "2099-02-30"},
        {"protocol": "x-resource-v1", "startDate": "20990101"},
        {"protocol": "x-resource-v1", "startDate": "2099-01-01", "bindingId": "x"},
    ],
)
async def test_invalid_advertised_capability_blocks_before_upstream(
    tmp_path, real_flow, mitm_ctx, capability
):
    registry_path = _write_registry(
        tmp_path, sandbox_info=_sandbox(tmp_path, {"xResourceBilling": capability})
    )
    flow = real_flow(
        with_response=False, client_ip="10.200.0.5", host="api.x.com", path="/2/tweets"
    )
    with mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 503
    assert flow.response.json()["reason"] == "invalid_x_resource_billing"
    assert flow.request.headers.get("Authorization") is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"
