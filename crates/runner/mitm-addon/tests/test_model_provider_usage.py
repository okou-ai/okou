"""Tests for model provider usage reporting."""

import uuid

import pytest
from mitmproxy.test import tutils

import flow_metadata_keys as metadata_keys
import mitm_addon
import usage
from tests.flow_helpers import header_map
from tests.jsonl_log_helpers import (
    jsonl_exists_after_flush,
    read_jsonl_entries_after_flush,
)
from tests.model_provider_flow_helpers import make_model_provider_usage_reporting_flow


class TestReportModelProviderUsage:
    """Tests for report_model_provider_usage helper."""

    @pytest.fixture(autouse=True)
    def _sync_executor(self, sync_usage_executor):
        """Run delivery inline for reporting behavior tests."""

    def test_reports_usage_for_model_provider(self, tmp_path, real_flow, usage_webhook_api):
        """Model-provider usage reaches the webhook boundary with correct payload."""
        flow = make_model_provider_usage_reporting_flow(
            real_flow,
            tmp_path,
            model_usage_provider="claude-opus-4-6",
            usage={
                "model": "claude-sonnet-4-6",
                "message_id": "msg-usage-1",
                "tokens.input": 100,
                "tokens.output": 50,
                "tokens.cache_read": 25,
                "tokens.cache_creation": 10,
            },
        )

        with usage_webhook_api() as webhook:
            usage.report_model_provider_usage(flow, "run-abc-123")
            assert webhook.request_count == 0
            usage.flush_usage_events(trigger="test")

        assert webhook.request_count == 1
        assert webhook.requests[0].path == "/api/webhooks/agent/usage-event"
        body = webhook.requests[0].json_body()
        assert body["runId"] == "run-abc-123"
        assert set(body) == {"runId", "events"}
        by_category = {event["category"]: event for event in body["events"]}
        assert {
            category: {key: value for key, value in event.items() if key != "idempotencyKey"}
            for category, event in by_category.items()
        } == {
            "tokens.input": {
                "kind": "model",
                "provider": "claude-opus-4-6",
                "category": "tokens.input",
                "quantity": 100,
            },
            "tokens.output": {
                "kind": "model",
                "provider": "claude-opus-4-6",
                "category": "tokens.output",
                "quantity": 50,
            },
            "tokens.cache_read": {
                "kind": "model",
                "provider": "claude-opus-4-6",
                "category": "tokens.cache_read",
                "quantity": 25,
            },
            "tokens.cache_creation": {
                "kind": "model",
                "provider": "claude-opus-4-6",
                "category": "tokens.cache_creation",
                "quantity": 10,
            },
        }
        for event in body["events"]:
            uuid.UUID(event["idempotencyKey"])

    @pytest.mark.parametrize(
        ("input_tokens", "expected_suffix"),
        [(272_000, ""), (272_001, ".long_context")],
    )
    def test_classifies_long_context_usage_at_model_boundary(
        self,
        tmp_path,
        real_flow,
        usage_webhook_api,
        input_tokens,
        expected_suffix,
    ):
        flow = make_model_provider_usage_reporting_flow(
            real_flow,
            tmp_path,
            host="api.openai.com",
            original_url="https://api.openai.com/v1/responses",
            firewall_name="model-provider:openai-api-key",
            model_usage_provider="catalog-model-pricing",
            usage={
                "tokens.input": input_tokens,
                "tokens.output": 7,
            },
        )
        flow.metadata[metadata_keys.MODEL_USAGE_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS] = 272_001

        with usage_webhook_api() as webhook:
            usage.report_model_provider_usage(flow, "run-abc-123")
            usage.flush_usage_events(trigger="test")

        by_category = {event["category"]: event["quantity"] for event in webhook.usage_events()}
        assert by_category == {
            f"tokens.input{expected_suffix}": input_tokens,
            f"tokens.output{expected_suffix}": 7,
        }

    def test_cache_partitions_select_long_context(
        self,
        tmp_path,
        real_flow,
        usage_webhook_api,
    ):
        flow = make_model_provider_usage_reporting_flow(
            real_flow,
            tmp_path,
            host="api.openai.com",
            original_url="https://api.openai.com/v1/responses",
            firewall_name="model-provider:openai-api-key",
            model_usage_provider="gpt-5.6-sol",
            usage={
                "service_tier": "priority",
                "tokens.input": 200_000,
                "tokens.output": 9,
                "tokens.cache_read": 70_000,
                "tokens.cache_creation": 2_001,
            },
        )
        flow.metadata[metadata_keys.MODEL_USAGE_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS] = 272_001

        with usage_webhook_api() as webhook:
            usage.report_model_provider_usage(flow, "run-abc-123")
            usage.flush_usage_events(trigger="test")

        assert {event["category"]: event["quantity"] for event in webhook.usage_events()} == {
            "tokens.input.long_context.fast": 200_000,
            "tokens.output.long_context.fast": 9,
            "tokens.cache_read.long_context.fast": 70_000,
            "tokens.cache_creation.long_context.fast": 2_001,
        }

    @pytest.mark.parametrize(
        ("service_tier", "input_tokens", "expected_suffix"),
        [
            (None, 400_000, ""),
            ("priority", 400_000, ".fast"),
            (None, 400_001, ".long_context"),
            ("priority", 400_001, ".long_context.fast"),
        ],
    )
    def test_unmapped_provider_uses_captured_route_threshold(
        self,
        tmp_path,
        real_flow,
        usage_webhook_api,
        service_tier,
        input_tokens,
        expected_suffix,
    ):
        """A provider absent from the generated map classifies by the captured threshold.

        The provider id, model and threshold are all unknown to the generated
        map; the threshold is the one the API captured from the run's route.
        Total input counts uncached input plus cache reads.
        """
        flow = make_model_provider_usage_reporting_flow(
            real_flow,
            tmp_path,
            host="api.openai.com",
            original_url="https://api.openai.com/v1/responses",
            firewall_name="model-provider:openai-api-key",
            model_usage_provider="catalog-new-model-pricing",
            usage={
                "model": "catalog-new-upstream",
                **({"service_tier": service_tier} if service_tier else {}),
                "tokens.input": input_tokens - 1_000,
                "tokens.output": 7,
                "tokens.cache_read": 1_000,
            },
        )
        flow.metadata[metadata_keys.MODEL_USAGE_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS] = 400_001

        with usage_webhook_api() as webhook:
            usage.report_model_provider_usage(flow, "run-new-model")
            usage.flush_usage_events(trigger="test")

        assert {
            (event["provider"], event["category"]): event["quantity"]
            for event in webhook.usage_events()
        } == {
            ("catalog-new-model-pricing", f"tokens.input{expected_suffix}"): input_tokens - 1_000,
            ("catalog-new-model-pricing", f"tokens.output{expected_suffix}"): 7,
            ("catalog-new-model-pricing", f"tokens.cache_read{expected_suffix}"): 1_000,
        }

    def test_registry_threshold_overrides_generated_threshold(
        self,
        tmp_path,
        real_flow,
        usage_webhook_api,
    ):
        """The API-captured threshold is authoritative for a mapped provider too."""
        flow = make_model_provider_usage_reporting_flow(
            real_flow,
            tmp_path,
            host="api.openai.com",
            original_url="https://api.openai.com/v1/responses",
            firewall_name="model-provider:openai-api-key",
            model_usage_provider="gpt-6-luna",
            usage={"tokens.input": 200_001, "tokens.output": 7},
        )
        flow.metadata[metadata_keys.MODEL_USAGE_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS] = 200_001

        with usage_webhook_api() as webhook:
            usage.report_model_provider_usage(flow, "run-explicit-threshold")
            usage.flush_usage_events(trigger="test")

        assert {event["category"]: event["quantity"] for event in webhook.usage_events()} == {
            "tokens.input.long_context": 200_001,
            "tokens.output.long_context": 7,
        }

    @pytest.mark.parametrize(
        ("service_tier", "expected_suffix"),
        [(None, ""), ("priority", ".fast")],
    )
    def test_explicit_single_tier_does_not_use_generated_threshold(
        self,
        tmp_path,
        real_flow,
        usage_webhook_api,
        service_tier,
        expected_suffix,
    ):
        """A single-tier route bills base categories at any input length."""
        flow = make_model_provider_usage_reporting_flow(
            real_flow,
            tmp_path,
            host="api.openai.com",
            original_url="https://api.openai.com/v1/responses",
            firewall_name="model-provider:openai-api-key",
            model_usage_provider="gpt-6-luna",
            usage={
                **({"service_tier": service_tier} if service_tier else {}),
                "tokens.input": 300_000,
                "tokens.output": 7,
            },
        )
        flow.metadata[metadata_keys.MODEL_USAGE_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS] = 0

        with usage_webhook_api() as webhook:
            usage.report_model_provider_usage(flow, "run-explicit-single-tier")
            usage.flush_usage_events(trigger="test")

        assert {event["category"]: event["quantity"] for event in webhook.usage_events()} == {
            f"tokens.input{expected_suffix}": 300_000,
            f"tokens.output{expected_suffix}": 7,
        }

    def test_aggregate_buffer_keeps_base_and_long_context_items_separate(
        self,
        tmp_path,
        real_flow,
        usage_webhook_api,
    ):
        flows = []
        for input_tokens in (10, 272_001):
            flow = make_model_provider_usage_reporting_flow(
                real_flow,
                tmp_path,
                host="api.openai.com",
                original_url="https://api.openai.com/v1/responses",
                firewall_name="model-provider:openai-api-key",
                model_usage_provider="gpt-5.5",
                usage={"tokens.input": input_tokens},
            )
            flow.metadata[metadata_keys.MODEL_USAGE_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS] = 272_001
            flows.append(flow)

        with usage_webhook_api() as webhook:
            for flow in flows:
                usage.report_model_provider_usage(flow, "run-abc-123")
            usage.flush_usage_events(trigger="test")

        assert {event["category"]: event["quantity"] for event in webhook.usage_events()} == {
            "tokens.input": 10,
            "tokens.input.long_context": 272_001,
        }

    def test_falls_back_to_response_model_then_unknown(
        self, tmp_path, real_flow, usage_webhook_api
    ):
        """Provider falls back only when selected built-in model metadata is absent."""
        flow = make_model_provider_usage_reporting_flow(
            real_flow,
            tmp_path,
            model_usage_provider=None,
            usage={
                "message_id": "msg-usage-1",
                "tokens.input": 100,
            },
        )

        with usage_webhook_api() as webhook:
            usage.report_model_provider_usage(flow, "run-abc-123")
            usage.flush_usage_events(trigger="test")

        body = webhook.requests[0].json_body()
        assert body["events"][0]["provider"] == "unknown"

        flow = make_model_provider_usage_reporting_flow(
            real_flow,
            tmp_path,
            model_usage_provider=None,
            usage={
                "message_id": "msg-usage-2",
                "model": "claude-sonnet-4-6",
                "tokens.input": 100,
            },
        )
        with usage_webhook_api() as webhook:
            usage.report_model_provider_usage(flow, "run-abc-123")
            usage.flush_usage_events(trigger="test")

        body = webhook.requests[-1].json_body()
        assert body["events"][0]["provider"] == "claude-sonnet-4-6"

    def test_skips_when_no_positive_token_quantities(self, tmp_path, real_flow, usage_webhook_api):
        flow = make_model_provider_usage_reporting_flow(
            real_flow,
            tmp_path,
            usage={
                "message_id": "msg-usage-1",
                "tokens.input": 0,
                "tokens.output": -1,
                "tokens.cache_read": "10",
                "tokens.cache_creation": True,
            },
        )

        with usage_webhook_api() as webhook:
            usage.report_model_provider_usage(flow, "run-abc-123")
            usage.flush_usage_events(trigger="test")

        assert webhook.request_count == 0

    def test_skips_when_firewall_not_billable(self, tmp_path, real_flow, usage_webhook_api):
        """Should NOT report usage when firewall_billable is False.

        Simulates a user supplying their own Anthropic key — the web layer
        does not list the firewall in billableFirewalls, so no platform
        credits should be charged.
        """
        flow = make_model_provider_usage_reporting_flow(
            real_flow,
            tmp_path,
            firewall_billable=False,
            usage={"tokens.input": 100},
        )

        with usage_webhook_api() as webhook:
            usage.report_model_provider_usage(flow, "run-abc-123")
            usage.flush_usage_events(trigger="test")

        assert webhook.request_count == 0

    def test_billable_model_provider_reports_billing(self, tmp_path, real_flow, usage_webhook_api):
        flow = make_model_provider_usage_reporting_flow(
            real_flow,
            tmp_path,
            firewall_name="model-provider:vm0",
            usage={
                "message_id": "msg-built-in-usage-1",
                "tokens.input": 100,
            },
        )

        with usage_webhook_api() as webhook:
            usage.report_model_provider_usage(flow, "run-abc-123")
            usage.flush_usage_events(trigger="test")

        assert webhook.request_count == 1
        assert webhook.requests[0].path == "/api/webhooks/agent/usage-event"
        usage_body = webhook.requests[0].json_body()
        assert usage_body["events"][0]["provider"] == "claude-sonnet-4-6"
        uuid.UUID(usage_body["events"][0]["idempotencyKey"])

    def test_billable_model_provider_uses_response_model_without_context_model(
        self, tmp_path, real_flow, usage_webhook_api
    ):
        flow = make_model_provider_usage_reporting_flow(
            real_flow,
            tmp_path,
            firewall_name="model-provider:vm0",
            model_usage_provider=None,
            usage={
                "model": "claude-sonnet-4-6",
                "message_id": "msg-built-in-usage-1",
                "tokens.input": 100,
            },
        )

        with usage_webhook_api() as webhook:
            accepted = usage.report_model_provider_usage(flow, "run-abc-123")
            usage.flush_usage_events(trigger="test")

        assert accepted is True
        assert webhook.request_count == 1
        assert webhook.usage_events()[0]["provider"] == "claude-sonnet-4-6"

    def test_skips_non_model_provider(self, tmp_path, real_flow, usage_webhook_api):
        """Should NOT reach the webhook boundary for non-model-provider requests."""
        flow = make_model_provider_usage_reporting_flow(
            real_flow,
            tmp_path,
            host="api.github.com",
            original_url="https://api.github.com/",
            firewall_name="github",
            usage={"tokens.input": 50},
        )

        with usage_webhook_api() as webhook:
            usage.report_model_provider_usage(flow, "run-abc-123")
            usage.flush_usage_events(trigger="test")

        assert webhook.request_count == 0

    @pytest.mark.parametrize("firewall_name", [None, 42])
    def test_skips_malformed_firewall_name(
        self, tmp_path, real_flow, usage_webhook_api, firewall_name
    ):
        flow = make_model_provider_usage_reporting_flow(
            real_flow,
            tmp_path,
            usage={"tokens.input": 50},
        )
        flow.metadata[metadata_keys.FIREWALL_NAME] = firewall_name

        with usage_webhook_api() as webhook:
            accepted = usage.report_model_provider_usage(flow, "run-abc-123")
            usage.flush_usage_events(trigger="test")

        assert accepted is False
        assert webhook.request_count == 0

    def test_skips_when_no_model_provider_usage(self, tmp_path, real_flow, usage_webhook_api):
        """Should NOT reach the webhook boundary when model_provider_usage is absent."""
        flow = make_model_provider_usage_reporting_flow(real_flow, tmp_path)
        # No model_provider_usage in metadata

        with usage_webhook_api() as webhook:
            usage.report_model_provider_usage(flow, "run-abc-123")
            usage.flush_usage_events(trigger="test")

        assert webhook.request_count == 0

    def test_skips_when_no_run_id(self, tmp_path, real_flow, usage_webhook_api):
        """Should NOT reach the webhook boundary when run_id is empty."""
        flow = make_model_provider_usage_reporting_flow(
            real_flow,
            tmp_path,
            usage={"tokens.input": 50},
        )

        with usage_webhook_api() as webhook:
            usage.report_model_provider_usage(flow, "")
            usage.flush_usage_events(trigger="test")

        assert webhook.request_count == 0

    def test_logs_underbilling_when_missing_sandbox_token(self, tmp_path, real_flow, mitm_ctx):
        """Should emit an alertable underbilling signal when sandbox_token is empty."""
        proxy_log = tmp_path / "proxy-run-abc-123.jsonl"
        flow = make_model_provider_usage_reporting_flow(
            real_flow,
            tmp_path,
            sandbox_token="",
            proxy_log_path=proxy_log,
            usage={"tokens.input": 50},
        )

        with mitm_ctx(api_url="https://api.okou.ai"):
            usage.report_model_provider_usage(flow, "run-abc-123")

        assert jsonl_exists_after_flush(proxy_log)
        [entry] = read_jsonl_entries_after_flush(proxy_log)
        assert entry["level"] == "error"
        assert entry["message"] == "Cannot report usage event: missing sandbox_token or api_url"
        assert entry["type"] == "usage_underbilling"
        assert entry["reason"] == "missing_reporting_context"
        assert entry["underbilling_class"] == "confirmed"
        assert entry["component"] == "mitm_addon"
        assert entry["run_id"] == "run-abc-123"
        assert entry["firewall_name"] == "model-provider:anthropic-api-key"
        assert entry["missing_sandbox_token"] is True
        assert entry["missing_api_url"] is False

    def test_logs_underbilling_when_missing_api_url(self, tmp_path, real_flow, mitm_ctx):
        """Should emit an alertable underbilling signal when api_url is empty."""
        proxy_log = tmp_path / "proxy-run-abc-123.jsonl"
        flow = make_model_provider_usage_reporting_flow(
            real_flow,
            tmp_path,
            proxy_log_path=proxy_log,
            usage={"tokens.input": 50},
        )

        with mitm_ctx(api_url=""):
            usage.report_model_provider_usage(flow, "run-abc-123")
            usage.flush_usage_events(trigger="test")

        assert jsonl_exists_after_flush(proxy_log)
        [entry] = read_jsonl_entries_after_flush(proxy_log)
        assert entry["level"] == "error"
        assert entry["message"] == "Cannot report usage event: missing sandbox_token or api_url"
        assert entry["type"] == "usage_underbilling"
        assert entry["reason"] == "missing_reporting_context"
        assert entry["underbilling_class"] == "confirmed"
        assert entry["component"] == "mitm_addon"
        assert entry["run_id"] == "run-abc-123"
        assert entry["firewall_name"] == "model-provider:anthropic-api-key"
        assert entry["missing_sandbox_token"] is False
        assert entry["missing_api_url"] is True

    def test_source_dedupe_uses_flow_id_when_message_id_missing(
        self, tmp_path, real_flow, usage_webhook_api
    ):
        flow = make_model_provider_usage_reporting_flow(
            real_flow,
            tmp_path,
            usage={
                "model": "claude-sonnet-4-6",
                "tokens.input": 10,
            },
        )
        flow.id = "flow-uuid-xyz-123"

        with usage_webhook_api() as webhook:
            usage.report_model_provider_usage(flow, "run-fallback")
            usage.report_model_provider_usage(flow, "run-fallback")
            usage.flush_usage_events(trigger="test")

        body = webhook.requests[0].json_body()
        assert body["events"][0]["quantity"] == 10

    def test_source_dedupe_uses_flow_id_when_message_id_present(
        self, tmp_path, real_flow, usage_webhook_api
    ):
        flow = make_model_provider_usage_reporting_flow(
            real_flow,
            tmp_path,
            usage={
                "model": "claude-sonnet-4-6",
                "message_id": "msg_real_anthropic_id",
                "tokens.input": 10,
            },
        )
        flow.id = "flow-uuid-xyz-123"

        with usage_webhook_api() as webhook:
            usage.report_model_provider_usage(flow, "run-fallback")
            usage.report_model_provider_usage(flow, "run-fallback")
            usage.flush_usage_events(trigger="test")

        body = webhook.requests[0].json_body()
        assert body["events"][0]["quantity"] == 10

    def test_source_dedupe_aggregates_model_provider_usage_sources(
        self, tmp_path, real_flow, usage_webhook_api
    ):
        flow = make_model_provider_usage_reporting_flow(
            real_flow,
            tmp_path,
            host="api.openai.com",
            original_url="https://api.openai.com/v1/responses",
            firewall_name="model-provider:openai-api-key",
            model_usage_provider="gpt-5.5",
            usage_sources={
                "resp_ws_1": {
                    "model": "gpt-5.5",
                    "message_id": "resp_ws_1",
                    "tokens.input": 10,
                },
                "resp_ws_2": {
                    "model": "gpt-5.5",
                    "message_id": "resp_ws_2",
                    "tokens.input": 3,
                },
            },
        )
        flow.id = "flow-uuid-xyz-123"

        with usage_webhook_api() as webhook:
            usage.report_model_provider_usage(flow, "run-websocket")
            usage.report_model_provider_usage(flow, "run-websocket")
            usage.flush_usage_events(trigger="test")

        assert webhook.request_count == 1
        assert webhook.requests[0].path == "/api/webhooks/agent/usage-event"
        usage_body = webhook.requests[0].json_body()
        assert [
            {key: value for key, value in event.items() if key != "idempotencyKey"}
            for event in usage_body["events"]
        ] == [
            {
                "kind": "model",
                "provider": "gpt-5.5",
                "category": "tokens.input",
                "quantity": 13,
            }
        ]
        uuid.UUID(usage_body["events"][0]["idempotencyKey"])

    def test_source_dedupe_separates_billing_sources_by_response_model_without_context_model(
        self, tmp_path, real_flow, usage_webhook_api
    ):
        flow = make_model_provider_usage_reporting_flow(
            real_flow,
            tmp_path,
            host="api.openai.com",
            original_url="https://api.openai.com/v1/responses",
            firewall_name="model-provider:openai-api-key",
            model_usage_provider=None,
            usage_sources={
                "resp_ws_1": {
                    "model": "gpt-5.5",
                    "message_id": "resp_ws_1",
                    "tokens.input": 10,
                },
                "resp_ws_2": {
                    "model": "gpt-5.6-luna",
                    "message_id": "resp_ws_2",
                    "tokens.input": 3,
                },
            },
        )
        flow.id = "flow-uuid-xyz-123"

        with usage_webhook_api() as webhook:
            usage.report_model_provider_usage(flow, "run-websocket")
            usage.flush_usage_events(trigger="test")

        assert webhook.request_count == 1
        assert webhook.requests[0].path == "/api/webhooks/agent/usage-event"
        usage_body = webhook.requests[0].json_body()
        assert {
            (event["provider"], event["category"]): event["quantity"]
            for event in usage_body["events"]
        } == {
            ("gpt-5.5", "tokens.input"): 10,
            ("gpt-5.6-luna", "tokens.input"): 3,
        }

    def test_source_dedupe_skips_malformed_model_provider_usage_sources(
        self, tmp_path, real_flow, usage_webhook_api
    ):
        flow = make_model_provider_usage_reporting_flow(
            real_flow,
            tmp_path,
            host="api.openai.com",
            original_url="https://api.openai.com/v1/responses",
            firewall_name="model-provider:openai-api-key",
            model_usage_provider="gpt-5.5",
        )
        flow.id = "flow-uuid-xyz-123"
        flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE_SOURCES] = {
            "resp_invalid": "invalid",
            "": {"model": "gpt-5.5", "tokens.input": 10},
            42: {"model": "gpt-5.6-luna", "tokens.input": 3},
        }

        with usage_webhook_api() as webhook:
            accepted = usage.report_model_provider_usage(flow, "run-websocket")
            usage.flush_usage_events(trigger="test")

        assert accepted is False
        assert webhook.request_count == 0

    def test_source_dedupe_separates_flows_when_message_id_missing(
        self, tmp_path, real_flow, usage_webhook_api
    ):
        first = make_model_provider_usage_reporting_flow(
            real_flow,
            tmp_path,
            usage={
                "model": "claude-sonnet-4-6",
                "tokens.input": 10,
            },
        )
        first.id = "flow-first"
        second = make_model_provider_usage_reporting_flow(
            real_flow,
            tmp_path,
            usage={
                "model": "claude-sonnet-4-6",
                "tokens.input": 10,
            },
        )
        second.id = "flow-second"

        with usage_webhook_api() as webhook:
            usage.report_model_provider_usage(first, "run-fallback")
            usage.report_model_provider_usage(second, "run-fallback")
            usage.flush_usage_events(trigger="test")

        body = webhook.requests[0].json_body()
        assert body["events"][0]["quantity"] == 20

    def test_source_dedupe_separates_flows_when_message_id_matches(
        self, tmp_path, real_flow, usage_webhook_api
    ):
        first = make_model_provider_usage_reporting_flow(
            real_flow,
            tmp_path,
            usage={
                "model": "claude-sonnet-4-6",
                "message_id": "msg_real_anthropic_id",
                "tokens.input": 10,
            },
        )
        first.id = "flow-first"
        second = make_model_provider_usage_reporting_flow(
            real_flow,
            tmp_path,
            usage={
                "model": "claude-sonnet-4-6",
                "message_id": "msg_real_anthropic_id",
                "tokens.input": 10,
            },
        )
        second.id = "flow-second"

        with usage_webhook_api() as webhook:
            usage.report_model_provider_usage(first, "run-preserved")
            usage.report_model_provider_usage(second, "run-preserved")
            usage.flush_usage_events(trigger="test")

        body = webhook.requests[0].json_body()
        assert body["events"][0]["quantity"] == 20


class TestModelProviderResponseHookUsage:
    """Tests for response hook wiring into model-provider usage reporting."""

    def test_full_path_response_to_webhook(
        self, tmp_path, real_flow, fresh_usage_executor, usage_webhook_api
    ):
        """Integration test for the response hook's terminal model-usage lifecycle.

        The response hook reaches terminal one-shot reporting through
        ``terminal_usage.report_model_provider_usage_once()``, which buffers
        billing payloads through the public ``usage`` facade. The explicit
        ``usage.flush_usage_events(trigger="test")`` call admits the buffer to
        retry-capable webhook enqueue and delivery, and
        this test verifies the successful loopback HTTP requests. It does not
        trigger a delivery retry.
        """
        flow = make_model_provider_usage_reporting_flow(
            real_flow,
            tmp_path,
            run_id="run-int-001",
            usage={
                "model": "claude-sonnet-4-6",
                "tokens.input": 100,
                "tokens.output": 500,
            },
        )
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "text/event-stream"})
        )

        with usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            # Flush the executor to ensure the background POST completes.
            usage.flush_usage_events(trigger="test")
            usage.webhook.usage_executor.shutdown(wait=True)

        assert webhook.request_count == 1
        assert webhook.requests[0].path == "/api/webhooks/agent/usage-event"
        body = webhook.requests[0].json_body()
        assert body["runId"] == "run-int-001"
        by_category = {event["category"]: event for event in body["events"]}
        assert by_category["tokens.input"]["quantity"] == 100
        assert by_category["tokens.output"]["quantity"] == 500
        assert by_category["tokens.input"]["provider"] == "claude-sonnet-4-6"
