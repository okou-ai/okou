"""Tests for usage reporting idempotency across mitmproxy hooks."""

import time
import uuid

import pytest
from mitmproxy.flow import Error
from mitmproxy.test import tutils

import flow_metadata_keys as metadata_keys
import mitm_addon
import usage
from tests.flow_helpers import header_map
from tests.model_provider_flow_helpers import make_model_provider_flow


class TestUsageReportingIdempotency:
    """Tests for duplicate-reporting guards and stable usage sources."""

    @pytest.fixture(autouse=True)
    def _sync_executor(self, sync_usage_executor):
        """Run delivery inline for idempotency behavior tests."""

    def test_response_then_error_does_not_enqueue_model_usage_twice(
        self, tmp_path, real_flow, mitm_ctx, usage_webhook_api
    ):
        """If mitmproxy fires both hooks for one flow, model usage reports once."""
        flow = make_model_provider_flow(
            real_flow,
            tmp_path,
            host="openrouter.ai",
            original_url="https://openrouter.ai/api/v1/responses",
            firewall_name="model-provider:openrouter-codex",
            cli_agent_type="codex",
        )
        flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] = {
            "model": "gpt-5.5",
            "tokens.input": 0,
            "tokens.output": 20,
        }
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )
        flow.metadata[metadata_keys.HTTP_REQUEST_START_MONOTONIC] = time.monotonic()

        with usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            assert metadata_keys.HTTP_REQUEST_START_MONOTONIC not in flow.metadata
            flow.error = Error("connection reset after response")
            mitm_addon.error(flow)
            usage.flush_usage_events(trigger="test")

        events = webhook.usage_events()
        assert [(event["category"], event["quantity"]) for event in events] == [
            ("tokens.output", 20)
        ]

    def test_empty_model_usage_does_not_block_later_error_usage(
        self, tmp_path, real_flow, mitm_ctx, usage_webhook_api
    ):
        """A no-event response pass must not mark the flow reported."""
        flow = make_model_provider_flow(
            real_flow,
            tmp_path,
            host="openrouter.ai",
            original_url="https://openrouter.ai/api/v1/responses",
            firewall_name="model-provider:openrouter-codex",
            cli_agent_type="codex",
        )
        flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] = {
            "model": "gpt-5.5",
            "tokens.input": 0,
        }
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        with usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            assert webhook.request_count == 0

            flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]["tokens.output"] = 20
            flow.error = Error("connection reset after response")
            mitm_addon.error(flow)
            usage.flush_usage_events(trigger="test")

        events = webhook.usage_events()
        assert [event["category"] for event in events] == ["tokens.output"]

    def test_reports_usage_without_provider_message_id(
        self, tmp_path, real_flow, mitm_ctx, headers, usage_webhook_api
    ):
        log_path = str(tmp_path / "network.jsonl")
        flow = make_model_provider_flow(
            real_flow,
            tmp_path,
            host="openrouter.ai",
            original_url="https://openrouter.ai/api/v1/responses",
            firewall_name="model-provider:openrouter-codex",
            run_id="run-fallback",
            network_log_path=log_path,
            model_usage_provider="claude-sonnet-4-6",
        )
        flow.id = "flow-uuid-xyz-123"
        flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] = {
            "model": "claude-sonnet-4-6",
            "tokens.input": 10,
            # no message_id set
        }
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "text/event-stream"})
        )

        with usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")

        assert webhook.request_count == 1
        requests_by_path = {request.path: request for request in webhook.requests}
        body = requests_by_path["/api/webhooks/agent/usage-event"].json_body()
        assert body["events"][0]["quantity"] == 10
        assert body["events"][0]["provider"] == "claude-sonnet-4-6"
        billing_key = body["events"][0]["idempotencyKey"]
        uuid.UUID(billing_key)

    def test_reports_usage_with_provider_message_id(
        self, tmp_path, real_flow, mitm_ctx, headers, usage_webhook_api
    ):
        """Provider message_id metadata must not block ordinary usage reporting."""
        log_path = str(tmp_path / "network.jsonl")
        flow = make_model_provider_flow(
            real_flow,
            tmp_path,
            host="openrouter.ai",
            original_url="https://openrouter.ai/api/v1/responses",
            firewall_name="model-provider:openrouter-codex",
            run_id="run-preserved",
            network_log_path=log_path,
            model_usage_provider="claude-sonnet-4-6",
        )
        flow.id = "flow-should-not-win"
        flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] = {
            "model": "claude-sonnet-4-6",
            "message_id": "resp_real_provider_id",
            "tokens.input": 10,
        }
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "text/event-stream"})
        )

        with usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")

        assert webhook.request_count == 1
        requests_by_path = {request.path: request for request in webhook.requests}
        body = requests_by_path["/api/webhooks/agent/usage-event"].json_body()
        assert body["events"][0]["quantity"] == 10
        assert body["events"][0]["provider"] == "claude-sonnet-4-6"
        billing_key = body["events"][0]["idempotencyKey"]
        uuid.UUID(billing_key)
