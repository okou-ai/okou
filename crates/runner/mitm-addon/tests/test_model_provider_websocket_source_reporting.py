"""Tests for model-provider WebSocket source reporting and admission."""

import json
from pathlib import Path

import pytest
from mitmproxy import http

import flow_metadata_keys as metadata_keys
import mitm_addon
import usage
from tests.jsonl_log_helpers import jsonl_exists_after_flush, read_jsonl_entries_after_flush
from tests.model_provider_flow_helpers import (
    make_openai_responses_websocket_flow,
    model_provider_usage_sources,
    model_usage_source_entries,
)
from tests.model_provider_websocket_helpers import (
    ScheduledWebSocketTrim,
    capture_deferred_websocket_trims,
    capture_openai_responses_extractor_feeds,
    feed_websocket_server_message,
    feed_websocket_server_text_message,
    openai_websocket_usage_frame,
    set_websocket_message,
)
from tests.usage_helpers import assert_usage_event_rows
from usage.quantities import MAX_USAGE_QUANTITY


@pytest.fixture(autouse=True)
def deferred_websocket_trim_scheduler(
    monkeypatch: pytest.MonkeyPatch,
) -> list[ScheduledWebSocketTrim]:
    return capture_deferred_websocket_trims(monkeypatch)


class TestModelProviderWebSocketUsageSourceRelease:
    """Tests for sources that cannot be delivered to the usage webhook."""

    def test_model_websocket_missing_billing_context_logs_underbilling_and_releases_source(
        self, tmp_path, real_flow, mitm_ctx
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)
        flow.metadata[metadata_keys.SANDBOX_AUTH_KEY] = ""
        proxy_log = Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])

        with mitm_ctx(api_url="https://api.okou.ai"):
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame(
                    "resp_ws_missing_context",
                    input_tokens=10,
                    output_tokens=4,
                ),
            )

        assert model_provider_usage_sources(flow) == {}
        entries = read_jsonl_entries_after_flush(proxy_log)
        [entry] = [entry for entry in entries if entry.get("type") == "usage_underbilling"]
        [source_entry] = [entry for entry in entries if entry.get("type") == "model_usage_source"]
        assert entry["type"] == "usage_underbilling"
        assert entry["reason"] == "missing_reporting_context"
        assert entry["underbilling_class"] == "confirmed"
        assert entry["run_id"] == "run-abc-123"
        assert entry["firewall_name"] == "model-provider:openai-api-key"
        assert entry["missing_sandbox_token"] is True
        assert entry["missing_api_url"] is False
        assert all(event["buffer_accepted"] is False for event in source_entry["usage_events"])

    def test_model_websocket_missing_api_url_releases_positive_source(
        self, tmp_path, real_flow, mitm_ctx
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)
        proxy_log = Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])

        with mitm_ctx(api_url=""):
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame(
                    "resp_ws_missing_api_url",
                    input_tokens=10,
                    output_tokens=4,
                ),
            )

        assert model_provider_usage_sources(flow) == {}
        [entry] = [
            entry
            for entry in read_jsonl_entries_after_flush(proxy_log)
            if entry.get("type") == "usage_underbilling"
        ]
        assert entry["reason"] == "missing_reporting_context"
        assert entry["missing_sandbox_token"] is False
        assert entry["missing_api_url"] is True

    def test_model_websocket_missing_context_releases_zero_only_source(self, tmp_path, real_flow):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)
        flow.metadata[metadata_keys.SANDBOX_AUTH_KEY] = ""
        proxy_log = Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])

        feed_websocket_server_message(
            flow,
            openai_websocket_usage_frame(
                "resp_ws_zero_missing_context",
                input_tokens=0,
                output_tokens=0,
            ),
        )

        assert model_provider_usage_sources(flow) == {}
        assert not jsonl_exists_after_flush(proxy_log)

    def test_model_websocket_missing_api_url_releases_zero_only_source(
        self, tmp_path, real_flow, mitm_ctx
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)
        proxy_log = Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])

        with mitm_ctx(api_url=""):
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame(
                    "resp_ws_zero_missing_api_url",
                    input_tokens=0,
                    output_tokens=0,
                ),
            )

        assert model_provider_usage_sources(flow) == {}
        assert not jsonl_exists_after_flush(proxy_log)


class TestModelProviderWebSocketSourceReporting:
    """Tests for model-provider WebSocket source reporting."""

    @pytest.fixture(autouse=True)
    def _sync_usage_delivery(self, sync_usage_executor, usage_webhook_api):
        self._usage_webhook_api = usage_webhook_api

    def _run_websocket_message_and_end(self, flow: http.HTTPFlow):
        with self._usage_webhook_api() as webhook:
            mitm_addon.websocket_message(flow)
            mitm_addon.websocket_end(flow)
            usage.flush_usage_events(trigger="test")
        return webhook

    def test_full_pipeline_model_websocket_reports_usage(
        self,
        tmp_path,
        real_flow,
        monkeypatch: pytest.MonkeyPatch,
    ):
        """Codex Responses WebSocket frames should bill like SSE events."""
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)
        full_body_feeds = capture_openai_responses_extractor_feeds(monkeypatch)
        assert flow.metadata["model_websocket_usage_enabled"] is True
        assert "model_json_usage_finish" not in flow.metadata
        assert "model_sse_usage_finish" not in flow.metadata
        assert metadata_keys.STREAM_BUFFER not in flow.metadata
        assert metadata_keys.STREAM_BUFFER_STATE not in flow.metadata

        terminal_frame = json.dumps(
            {
                "type": "response.completed",
                "response": {
                    "id": "resp_ws_1",
                    "model": "gpt-5.5",
                    "usage": {
                        "input_tokens": 50,
                        "output_tokens": 20,
                        "input_tokens_details": {
                            "cached_tokens": 10,
                            "cache_write_tokens": 15,
                        },
                    },
                },
            }
        ).encode()
        set_websocket_message(
            flow,
            from_client=False,
            content=terminal_frame,
        )

        webhook = self._run_websocket_message_and_end(flow)

        assert full_body_feeds.count(terminal_frame) == 1
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == {}
        assert model_provider_usage_sources(flow) == {}
        assert_usage_event_rows(
            webhook.usage_events(),
            "provider",
            [
                ("gpt-5.5", "tokens.input", 25),
                ("gpt-5.5", "tokens.output", 20),
                ("gpt-5.5", "tokens.cache_read", 10),
                ("gpt-5.5", "tokens.cache_creation", 15),
            ],
        )
        [source_entry] = model_usage_source_entries(flow)
        assert source_entry["flow_id"] == flow.id
        assert source_entry["source_id"] == f"{flow.id}:resp_ws_1"
        assert source_entry["provider_response_id"] == "resp_ws_1"
        assert source_entry["transport"] == "websocket"
        assert source_entry["buffer_mode"] == "source"
        assert source_entry["method"] == "GET"
        assert source_entry["url"] == "https://api.openai.com/v1/responses"
        assert all(event["buffer_accepted"] is True for event in source_entry["usage_events"])
        assert {event["source_idempotency_key"] for event in source_entry["usage_events"]} == {
            event["idempotencyKey"] for event in webhook.usage_events()
        }

    def test_model_websocket_work_limit_warns_and_later_frame_reports(
        self,
        tmp_path,
        real_flow,
        monkeypatch: pytest.MonkeyPatch,
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)
        proxy_log = Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])
        full_body_feeds = capture_openai_responses_extractor_feeds(monkeypatch)
        over_budget_frame = (
            b'{"type":"response.completed","response":{"id":"resp_partial",'
            b'"model":"gpt-5.5","usage":{"input_tokens":100,"output_tokens":40}},'
            b'"padding":[' + b",".join([b"0"] * 40_000) + b"]}"
        )

        with self._usage_webhook_api() as webhook:
            feed_websocket_server_message(flow, over_budget_frame)

            assert flow.websocket is not None
            assert flow.websocket.messages[-1].content == over_budget_frame
            assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == {}
            assert model_provider_usage_sources(flow) == {}

            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame(
                    "resp_after_limit",
                    input_tokens=7,
                    output_tokens=3,
                ),
            )
            usage.flush_usage_events(trigger="test")

        assert full_body_feeds.count(over_budget_frame) == 1
        proxy_entries = read_jsonl_entries_after_flush(proxy_log)
        warning_entries = [
            entry
            for entry in proxy_entries
            if entry.get("message") == "Model provider WebSocket usage extraction failed"
        ]
        [warning] = warning_entries
        assert warning["level"] == "warn"
        assert warning["type"] == "usage_event"
        assert warning["usage_protocol"] == "openai_responses_websocket"
        assert warning["error"] == "work_limit_exceeded"
        [correlation_entry] = [
            entry for entry in proxy_entries if entry.get("type") == "model_usage_correlation"
        ]
        assert correlation_entry["reason"] == "correlation_cap"
        assert model_provider_usage_sources(flow) == {}
        expected_rows = [
            ("gpt-5.5", "tokens.input", 7),
            ("gpt-5.5", "tokens.output", 3),
        ]
        assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)

    def test_model_websocket_out_of_range_quantity_warns_without_correlation_failure(
        self,
        tmp_path,
        real_flow,
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)
        proxy_log = Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])

        with self._usage_webhook_api() as webhook:
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame(
                    "resp_out_of_range",
                    input_tokens=MAX_USAGE_QUANTITY + 1,
                    output_tokens=3,
                ),
            )
            usage.flush_usage_events(trigger="test")

        assert webhook.request_count == 0
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == {}
        assert model_provider_usage_sources(flow) == {}
        proxy_entries = read_jsonl_entries_after_flush(proxy_log)
        [warning] = [
            entry
            for entry in proxy_entries
            if entry.get("message") == "Model provider WebSocket usage extraction failed"
        ]
        assert warning["error"] == "integer value limit exceeded"
        assert not any(entry.get("type") == "model_usage_correlation" for entry in proxy_entries)

    def test_model_websocket_text_frame_reports_usage(self, tmp_path, real_flow):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        with self._usage_webhook_api() as webhook:
            feed_websocket_server_text_message(
                flow,
                json.dumps(
                    {
                        "type": "response.completed",
                        "response": {
                            "id": "resp_ws_text",
                            "model": "gpt-5.5",
                            "usage": {"input_tokens": 3, "output_tokens": 2},
                        },
                    }
                ),
            )
            usage.flush_usage_events(trigger="test")

        assert model_provider_usage_sources(flow) == {}
        expected_rows = [
            ("gpt-5.5", "tokens.input", 3),
            ("gpt-5.5", "tokens.output", 2),
        ]
        assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)

    def test_model_websocket_ignores_client_messages(self, tmp_path, real_flow):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)
        set_websocket_message(
            flow,
            from_client=True,
            content=json.dumps(
                {
                    "type": "response.completed",
                    "response": {
                        "id": "resp_ws_1",
                        "model": "gpt-5.5",
                        "usage": {"input_tokens": 50, "output_tokens": 20},
                    },
                }
            ).encode(),
        )

        webhook = self._run_websocket_message_and_end(flow)

        assert webhook.request_count == 0
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == {}
        assert model_provider_usage_sources(flow) == {}
