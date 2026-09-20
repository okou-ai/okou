"""Direct X connector usage reporting tests."""

import json

import pytest

import flow_metadata_keys as metadata_keys
from tests.jsonl_log_helpers import jsonl_exists_after_flush, read_jsonl_entries_after_flush


def test_skips_on_server_error(x_usage, tmp_path, real_flow):
    flow = x_usage.make_flow(real_flow, tmp_path, status=500)
    assert x_usage.call_and_get_billing(flow) == []


def test_skips_on_rate_limit(x_usage, tmp_path, real_flow):
    flow = x_usage.make_flow(real_flow, tmp_path, status=429)
    assert x_usage.call_and_get_billing(flow) == []


def test_skips_on_empty_permission(x_usage, tmp_path, real_flow):
    """Unknown-endpoint-allow has no stable pricing key."""
    flow = x_usage.make_flow(real_flow, tmp_path, permission="")
    assert x_usage.call_and_get_billing(flow) == []


def test_skips_on_empty_run_id(x_usage, tmp_path, real_flow):
    flow = x_usage.make_flow(real_flow, tmp_path)
    assert x_usage.call_and_get_billing(flow, run_id="") == []


@pytest.mark.parametrize(
    "firewall_billable",
    [
        pytest.param(True, id="billable"),
        pytest.param(False, id="not-billable"),
        pytest.param(None, id="missing"),
    ],
)
def test_connector_billing_requires_billable_metadata(
    x_usage, tmp_path, real_flow, firewall_billable
):
    body = json.dumps({"data": [{"id": "1"}, {"id": "2"}]}).encode()
    flow = x_usage.make_flow(real_flow, tmp_path, query="ids=1,2", body=body)
    if firewall_billable is None:
        flow.metadata.pop(metadata_keys.FIREWALL_BILLABLE)
    else:
        flow.metadata[metadata_keys.FIREWALL_BILLABLE] = firewall_billable

    events = x_usage.call_and_get_billing(flow)

    if firewall_billable is not True:
        assert events == []
        return

    [event] = events
    assert {
        "kind": event["kind"],
        "provider": event["provider"],
        "category": event["category"],
        "quantity": event["quantity"],
    } == {
        "kind": "connector",
        "provider": "x",
        "category": "posts.read",
        "quantity": 2,
    }


def test_skips_when_no_response(x_usage, tmp_path, real_flow):
    flow = x_usage.make_flow(real_flow, tmp_path)
    flow.response = None
    assert x_usage.call_and_get_billing(flow) == []


def test_skips_webhook_without_sandbox_token(x_usage, tmp_path, real_flow):
    """When sandbox token is empty, no webhook is enqueued and underbilling is logged."""
    body = json.dumps({"data": {"id": "1", "text": "hi"}}).encode()
    flow = x_usage.make_flow(
        real_flow, tmp_path, path="/2/tweets/1", body=body, rule="GET /2/tweets/{id}"
    )
    flow.metadata[metadata_keys.SANDBOX_AUTH_KEY] = ""
    assert x_usage.call_and_get_billing(flow) == []

    proxy_log = tmp_path / "proxy.jsonl"
    [entry] = read_jsonl_entries_after_flush(proxy_log)
    assert entry["level"] == "error"
    assert entry["message"] == "Cannot report usage event: missing sandbox_token or api_url"
    assert entry["type"] == "usage_underbilling"
    assert entry["reason"] == "missing_reporting_context"
    assert entry["underbilling_class"] == "confirmed"
    assert entry["component"] == "mitm_addon"
    assert entry["run_id"] == "run-abc-123"
    assert entry["firewall_name"] == "x"
    assert entry["permission"] == "tweet.read"
    assert entry["missing_sandbox_token"] is True
    assert entry["missing_api_url"] is False


def test_zero_count_without_sandbox_token_does_not_log_underbilling(x_usage, tmp_path, real_flow):
    """Missing reporting context is irrelevant when there are no usage events."""
    body = json.dumps({"data": [], "meta": {"result_count": 0}}).encode()
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets/search/recent",
        query="query=nothing",
        body=body,
        rule="GET /2/tweets/search/recent",
    )
    flow.metadata[metadata_keys.SANDBOX_AUTH_KEY] = ""

    assert x_usage.call_and_get_billing(flow) == []
    assert not jsonl_exists_after_flush(tmp_path / "proxy.jsonl")


def test_unparseable_no_hints_without_sandbox_token_logs_only_visibility_loss(
    x_usage, tmp_path, real_flow
):
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets/search/recent",
        query="query=nothing",
        body=b"not json",
        rule="GET /2/tweets/search/recent",
    )
    flow.metadata[metadata_keys.SANDBOX_AUTH_KEY] = ""

    assert x_usage.call_and_get_billing(flow) == []

    entries = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
    underbilling_reasons = [
        entry["reason"] for entry in entries if entry.get("type") == "usage_underbilling"
    ]
    assert underbilling_reasons == ["unparseable_usage_response"]
