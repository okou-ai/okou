"""Tests for model-provider WebSocket prewarm usage correlation."""

import json
from pathlib import Path

import pytest
from mitmproxy import http

import flow_metadata_keys as metadata_keys
import mitm_addon
import model_websocket_usage
import openai_responses_events
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
    feed_websocket_client_message,
    feed_websocket_server_message,
    openai_websocket_usage_frame,
)
from tests.usage_helpers import assert_usage_event_rows
from usage.quantities import MAX_USAGE_QUANTITY


@pytest.fixture(autouse=True)
def deferred_websocket_trim_scheduler(
    monkeypatch: pytest.MonkeyPatch,
) -> list[ScheduledWebSocketTrim]:
    return capture_deferred_websocket_trims(monkeypatch)


def _openai_websocket_created_frame(response_id: str) -> bytes:
    return json.dumps(
        {
            "type": "response.created",
            "response": {"id": response_id},
        }
    ).encode()


def _correlation_entries(flow: http.HTTPFlow) -> list[dict[str, object]]:
    proxy_log = Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])
    if not jsonl_exists_after_flush(proxy_log):
        return []
    return [
        entry
        for entry in read_jsonl_entries_after_flush(proxy_log)
        if entry.get("type") == "model_usage_correlation"
    ]


class TestModelProviderWebSocketPrewarmUsage:
    """Tests for exact non-generating response source exclusion."""

    @pytest.fixture(autouse=True)
    def _sync_usage_delivery(self, sync_usage_executor, usage_webhook_api):
        self._usage_webhook_api = usage_webhook_api

    @pytest.mark.parametrize("terminal_event", sorted(openai_responses_events.TERMINAL_EVENTS))
    def test_model_websocket_dense_terminal_uses_one_full_body_parse(
        self,
        tmp_path,
        real_flow,
        monkeypatch: pytest.MonkeyPatch,
        terminal_event: str,
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)
        full_body_feeds = capture_openai_responses_extractor_feeds(monkeypatch)
        client_frame = json.dumps({"type": "response.create", "generate": False}).encode()
        dense_terminal = (
            b'{"type":"'
            + terminal_event.encode()
            + b'","padding":['
            + b",".join([b"0"] * 20_000)
            + b'],"response":{"id":"dense-prewarm","model":"gpt-5.5",'
            b'"usage":{"input_tokens":9,"output_tokens":4}}}'
        )

        with self._usage_webhook_api() as webhook:
            feed_websocket_client_message(flow, client_frame)
            assert full_body_feeds.count(client_frame) == 1
            feed_websocket_server_message(
                flow,
                _openai_websocket_created_frame("dense-prewarm"),
            )
            full_body_feeds.clear()
            feed_websocket_server_message(flow, dense_terminal)
            mitm_addon.websocket_end(flow)
            usage.flush_usage_events(trigger="test")

        assert full_body_feeds.count(dense_terminal) == 1
        assert webhook.usage_events() == []
        [ignored_entry] = [
            entry
            for entry in model_usage_source_entries(flow)
            if entry.get("disposition") == "ignored"
        ]
        assert ignored_entry["provider_response_id"] == "dense-prewarm"
        assert ignored_entry["reason"] == "responses_generate_false"
        assert not _correlation_entries(flow)

    def test_model_websocket_ignores_late_usage_after_usage_free_terminal(
        self,
        tmp_path,
        real_flow,
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        with self._usage_webhook_api() as webhook:
            feed_websocket_client_message(
                flow,
                json.dumps({"type": "response.create", "generate": False}).encode(),
            )
            feed_websocket_server_message(flow, _openai_websocket_created_frame("warm-late"))
            feed_websocket_server_message(
                flow,
                b'{"type":"response.completed","response":{"id":"warm-late"}}',
            )
            feed_websocket_server_message(
                flow,
                b'{"type":"response.done","response":{"id":"warm-late",'
                b'"model":"gpt-5.5","usage":{"input_tokens":17,"output_tokens":0}}}',
            )
            mitm_addon.websocket_end(flow)
            usage.flush_usage_events(trigger="test")

        assert webhook.usage_events() == []
        [ignored_entry] = [
            entry
            for entry in model_usage_source_entries(flow)
            if entry.get("disposition") == "ignored"
        ]
        assert ignored_entry["provider_response_id"] == "warm-late"
        assert ignored_entry["reason"] == "responses_generate_false"
        assert ignored_entry["usage"] == {"tokens.input": 17}
        assert not _correlation_entries(flow)

    def test_model_websocket_terminal_usage_error_settles_prewarm_correlation(
        self,
        tmp_path,
        real_flow,
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)
        proxy_log = Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])

        with self._usage_webhook_api() as webhook:
            feed_websocket_client_message(
                flow,
                json.dumps({"type": "response.create", "generate": False}).encode(),
            )
            feed_websocket_server_message(flow, _openai_websocket_created_frame("bad-prewarm"))
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame(
                    "bad-prewarm",
                    input_tokens=MAX_USAGE_QUANTITY + 1,
                    output_tokens=0,
                ),
            )

            feed_websocket_client_message(
                flow,
                json.dumps({"type": "response.create", "generate": False}).encode(),
            )
            feed_websocket_server_message(flow, _openai_websocket_created_frame("next-prewarm"))
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame(
                    "next-prewarm",
                    input_tokens=7,
                    output_tokens=0,
                ),
            )
            mitm_addon.websocket_end(flow)
            usage.flush_usage_events(trigger="test")

        assert webhook.usage_events() == []
        [warning] = [
            entry
            for entry in read_jsonl_entries_after_flush(proxy_log)
            if entry.get("message") == "Model provider WebSocket usage extraction failed"
        ]
        assert warning["error"] == "integer value limit exceeded"
        [ignored_entry] = [
            entry
            for entry in model_usage_source_entries(flow)
            if entry.get("disposition") == "ignored"
        ]
        assert ignored_entry["provider_response_id"] == "next-prewarm"
        assert ignored_entry["reason"] == "responses_generate_false"
        assert not _correlation_entries(flow)

    def test_model_websocket_logs_each_prewarm_source_once_across_late_duplicate(
        self,
        tmp_path,
        real_flow,
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        with self._usage_webhook_api() as webhook:
            feed_websocket_client_message(
                flow,
                json.dumps({"type": "response.create", "generate": False}).encode(),
            )
            feed_websocket_server_message(flow, _openai_websocket_created_frame("warm-first"))
            first_usage = openai_websocket_usage_frame(
                "warm-first",
                input_tokens=5,
                output_tokens=0,
            )
            feed_websocket_server_message(flow, first_usage)

            feed_websocket_client_message(
                flow,
                json.dumps({"type": "response.create", "generate": False}).encode(),
            )
            feed_websocket_server_message(flow, _openai_websocket_created_frame("warm-second"))
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame(
                    "warm-second",
                    input_tokens=7,
                    output_tokens=0,
                ),
            )
            feed_websocket_server_message(flow, first_usage)
            mitm_addon.websocket_end(flow)
            usage.flush_usage_events(trigger="test")

        assert webhook.usage_events() == []
        ignored_entries = [
            entry
            for entry in model_usage_source_entries(flow)
            if entry.get("disposition") == "ignored"
        ]
        assert [entry["provider_response_id"] for entry in ignored_entries] == [
            "warm-first",
            "warm-second",
        ]
        assert not _correlation_entries(flow)

    def test_model_websocket_ignored_response_cap_fails_open(
        self,
        tmp_path,
        real_flow,
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        with self._usage_webhook_api() as webhook:
            for index in range(100):
                response_id = f"warm-retained-{index}"
                feed_websocket_client_message(
                    flow,
                    json.dumps({"type": "response.create", "generate": False}).encode(),
                )
                feed_websocket_server_message(
                    flow,
                    _openai_websocket_created_frame(response_id),
                )
                feed_websocket_server_message(
                    flow,
                    json.dumps(
                        {
                            "type": "response.completed",
                            "response": {"id": response_id},
                        }
                    ).encode(),
                )

            feed_websocket_client_message(
                flow,
                json.dumps({"type": "response.create", "generate": False}).encode(),
            )
            feed_websocket_server_message(flow, _openai_websocket_created_frame("warm-over-cap"))
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame(
                    "warm-over-cap",
                    input_tokens=9,
                    output_tokens=0,
                ),
            )
            mitm_addon.websocket_end(flow)
            usage.flush_usage_events(trigger="test")

        expected_rows = [("gpt-5.5", "tokens.input", 9)]
        assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)
        assert not any(
            entry.get("disposition") == "ignored" for entry in model_usage_source_entries(flow)
        )
        [correlation_entry] = _correlation_entries(flow)
        assert correlation_entry["reason"] == "correlation_cap"

    def test_model_websocket_ignores_bound_prewarm_and_reports_normal_input_only_turn(
        self,
        tmp_path,
        real_flow,
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)
        sensitive_marker = "prewarm-sensitive-marker"
        prewarm_request = json.dumps(
            {
                "type": "response.create",
                "input": [{"role": "user", "content": sensitive_marker * 300}],
                "tools": [{"name": "test-tool", "description": "x" * 5000}],
                "generate": False,
            }
        ).encode()

        with self._usage_webhook_api() as webhook:
            feed_websocket_client_message(flow, prewarm_request)
            feed_websocket_server_message(flow, _openai_websocket_created_frame("warm-1"))
            prewarm_usage = openai_websocket_usage_frame(
                "warm-1",
                input_tokens=6050,
                output_tokens=0,
            )
            feed_websocket_server_message(flow, prewarm_usage)

            feed_websocket_client_message(
                flow,
                json.dumps({"type": "response.create", "input": []}).encode(),
            )
            feed_websocket_server_message(flow, _openai_websocket_created_frame("resp-1"))
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame(
                    "resp-1",
                    input_tokens=10,
                    output_tokens=0,
                ),
            )
            feed_websocket_server_message(flow, prewarm_usage)
            mitm_addon.websocket_end(flow)
            usage.flush_usage_events(trigger="test")

        expected_rows = [("gpt-5.5", "tokens.input", 10)]
        assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)
        ignored_entries = [
            entry
            for entry in model_usage_source_entries(flow)
            if entry.get("disposition") == "ignored"
        ]
        [ignored_entry] = ignored_entries
        assert ignored_entry["reason"] == "responses_generate_false"
        assert ignored_entry["provider_response_id"] == "warm-1"
        assert ignored_entry["source_id"] == f"{flow.id}:warm-1"
        assert ignored_entry["usage"] == {"tokens.input": 6050}
        assert ignored_entry["usage_events"] == []
        assert ignored_entry["url"] == "https://openrouter.ai/api/v1/responses"
        proxy_log = Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])
        assert sensitive_marker not in proxy_log.read_text()
        assert model_provider_usage_sources(flow) == {}
        assert model_websocket_usage.is_enabled(flow) is False
        assert "_model_websocket_prewarm_state" not in flow.metadata

    def test_model_websocket_ignored_id_fails_open_after_ambiguity(self, tmp_path, real_flow):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        with self._usage_webhook_api() as webhook:
            feed_websocket_client_message(
                flow,
                json.dumps({"type": "response.create", "generate": False}).encode(),
            )
            feed_websocket_server_message(flow, _openai_websocket_created_frame("warm-ambiguous"))
            duplicate_terminal = openai_websocket_usage_frame(
                "warm-ambiguous",
                input_tokens=5,
                output_tokens=0,
            )
            feed_websocket_server_message(flow, duplicate_terminal)

            feed_websocket_client_message(flow, b"not-json")
            feed_websocket_server_message(flow, duplicate_terminal)
            mitm_addon.websocket_end(flow)
            usage.flush_usage_events(trigger="test")

        expected_rows = [("gpt-5.5", "tokens.input", 5)]
        assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)
        source_entries = model_usage_source_entries(flow)
        ignored_entries = [
            entry for entry in source_entries if entry.get("disposition") == "ignored"
        ]
        assert len(ignored_entries) == 1
        reported_entries = [
            entry
            for entry in source_entries
            if entry.get("disposition") != "ignored"
            and entry.get("provider_response_id") == "warm-ambiguous"
        ]
        assert len(reported_entries) == 1
        [correlation_entry] = _correlation_entries(flow)
        assert correlation_entry["reason"] == "unknown_client_event"

    def test_model_websocket_duplicate_terminal_stays_idempotent_with_active_request(
        self,
        tmp_path,
        real_flow,
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        with self._usage_webhook_api() as webhook:
            feed_websocket_client_message(
                flow,
                json.dumps({"type": "response.create", "generate": False}).encode(),
            )
            feed_websocket_server_message(flow, _openai_websocket_created_frame("warm-duplicate"))
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame("warm-duplicate", input_tokens=5, output_tokens=0),
            )

            feed_websocket_client_message(
                flow,
                json.dumps({"type": "response.create"}).encode(),
            )
            feed_websocket_server_message(flow, _openai_websocket_created_frame("normal-active"))
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame("warm-duplicate", input_tokens=5, output_tokens=0),
            )
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame("normal-active", input_tokens=4, output_tokens=0),
            )
            mitm_addon.websocket_end(flow)
            usage.flush_usage_events(trigger="test")

        expected_rows = [("gpt-5.5", "tokens.input", 4)]
        assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)
        assert not _correlation_entries(flow)

    def test_model_websocket_reused_older_ignored_id_fails_open(self, tmp_path, real_flow):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        with self._usage_webhook_api() as webhook:
            feed_websocket_client_message(
                flow,
                json.dumps({"type": "response.create", "generate": False}).encode(),
            )
            feed_websocket_server_message(flow, _openai_websocket_created_frame("reused-id"))
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame("reused-id", input_tokens=5, output_tokens=0),
            )

            feed_websocket_client_message(
                flow,
                json.dumps({"type": "response.create", "generate": False}).encode(),
            )
            feed_websocket_server_message(flow, _openai_websocket_created_frame("later-warm"))
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame("later-warm", input_tokens=6, output_tokens=0),
            )

            feed_websocket_client_message(
                flow,
                json.dumps({"type": "response.create"}).encode(),
            )
            feed_websocket_server_message(flow, _openai_websocket_created_frame("reused-id"))
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame("reused-id", input_tokens=7, output_tokens=0),
            )
            mitm_addon.websocket_end(flow)
            usage.flush_usage_events(trigger="test")

        expected_rows = [("gpt-5.5", "tokens.input", 7)]
        assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)
        source_entries = model_usage_source_entries(flow)
        ignored_entries = [
            entry for entry in source_entries if entry.get("disposition") == "ignored"
        ]
        assert [entry["provider_response_id"] for entry in ignored_entries] == [
            "reused-id",
            "later-warm",
        ]
        reported_entries = [
            entry
            for entry in source_entries
            if entry.get("disposition") != "ignored"
            and entry.get("provider_response_id") == "reused-id"
        ]
        assert len(reported_entries) == 1
        [correlation_entry] = _correlation_entries(flow)
        assert correlation_entry["reason"] == "invalid_lifecycle"

    def test_model_websocket_reused_ignored_id_without_created_fails_open(
        self,
        tmp_path,
        real_flow,
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        with self._usage_webhook_api() as webhook:
            feed_websocket_client_message(
                flow,
                json.dumps({"type": "response.create", "generate": False}).encode(),
            )
            feed_websocket_server_message(flow, _openai_websocket_created_frame("reused-id"))
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame("reused-id", input_tokens=5, output_tokens=0),
            )

            feed_websocket_client_message(
                flow,
                json.dumps({"type": "response.create"}).encode(),
            )
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame("reused-id", input_tokens=7, output_tokens=0),
            )
            mitm_addon.websocket_end(flow)
            usage.flush_usage_events(trigger="test")

        expected_rows = [("gpt-5.5", "tokens.input", 7)]
        assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)
        source_entries = model_usage_source_entries(flow)
        ignored_entries = [
            entry for entry in source_entries if entry.get("disposition") == "ignored"
        ]
        assert len(ignored_entries) == 1
        reported_entries = [
            entry
            for entry in source_entries
            if entry.get("disposition") != "ignored"
            and entry.get("provider_response_id") == "reused-id"
        ]
        assert len(reported_entries) == 1
        [correlation_entry] = _correlation_entries(flow)
        assert correlation_entry["reason"] == "invalid_lifecycle"

    @pytest.mark.parametrize(
        "client_requests",
        [
            pytest.param(
                [
                    {"type": "response.create"},
                    {"type": "response.create", "generate": False},
                ],
                id="normal-then-prewarm",
            ),
            pytest.param(
                [
                    {"type": "response.create", "generate": False},
                    {"type": "response.create"},
                ],
                id="prewarm-then-normal",
            ),
        ],
    )
    def test_model_websocket_overlapping_creates_fail_open(
        self,
        tmp_path,
        real_flow,
        client_requests: list[dict[str, object]],
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        with self._usage_webhook_api() as webhook:
            for request in client_requests:
                feed_websocket_client_message(flow, json.dumps(request).encode())
            feed_websocket_server_message(flow, _openai_websocket_created_frame("overlap-1"))
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame("overlap-1", input_tokens=10, output_tokens=0),
            )
            feed_websocket_server_message(flow, _openai_websocket_created_frame("overlap-2"))
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame("overlap-2", input_tokens=6, output_tokens=0),
            )
            mitm_addon.websocket_end(flow)
            usage.flush_usage_events(trigger="test")

        expected_rows = [
            ("gpt-5.5", "tokens.input", 10),
            ("gpt-5.5", "tokens.input", 6),
        ]
        assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)
        assert not any(
            entry.get("disposition") == "ignored" for entry in model_usage_source_entries(flow)
        )
        [correlation_entry] = _correlation_entries(flow)
        assert correlation_entry["reason"] == "overlapping_request"
        assert correlation_entry["transport"] == "websocket"

    def test_model_websocket_active_overlap_fails_open(self, tmp_path, real_flow):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        with self._usage_webhook_api() as webhook:
            feed_websocket_client_message(
                flow,
                json.dumps({"type": "response.create"}).encode(),
            )
            feed_websocket_server_message(flow, _openai_websocket_created_frame("active-normal"))
            feed_websocket_client_message(
                flow,
                json.dumps({"type": "response.create", "generate": False}).encode(),
            )
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame("active-normal", input_tokens=14, output_tokens=0),
            )
            feed_websocket_server_message(flow, _openai_websocket_created_frame("active-warm"))
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame("active-warm", input_tokens=5, output_tokens=0),
            )
            mitm_addon.websocket_end(flow)
            usage.flush_usage_events(trigger="test")

        expected_rows = [
            ("gpt-5.5", "tokens.input", 14),
            ("gpt-5.5", "tokens.input", 5),
        ]
        assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)
        assert not any(
            entry.get("disposition") == "ignored" for entry in model_usage_source_entries(flow)
        )
        [correlation_entry] = _correlation_entries(flow)
        assert correlation_entry["reason"] == "overlapping_request"

    def test_model_websocket_unknown_client_event_emits_one_content_free_diagnostic(
        self,
        tmp_path,
        real_flow,
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)
        marker = "unknown-client-sensitive-marker"

        with self._usage_webhook_api() as webhook:
            feed_websocket_client_message(
                flow,
                json.dumps({"type": "response.create", "generate": False}).encode(),
            )
            feed_websocket_client_message(
                flow,
                json.dumps({"type": "future.request", "input": marker}).encode(),
            )
            feed_websocket_server_message(flow, _openai_websocket_created_frame("unknown-1"))
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame("unknown-1", input_tokens=8, output_tokens=0),
            )
            feed_websocket_client_message(flow, b"not-json")
            feed_websocket_server_message(flow, _openai_websocket_created_frame("unknown-2"))
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame("unknown-2", input_tokens=7, output_tokens=0),
            )
            mitm_addon.websocket_end(flow)
            usage.flush_usage_events(trigger="test")

        expected_rows = [
            ("gpt-5.5", "tokens.input", 8),
            ("gpt-5.5", "tokens.input", 7),
        ]
        assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)
        assert not any(
            entry.get("disposition") == "ignored" for entry in model_usage_source_entries(flow)
        )
        correlation_entries = _correlation_entries(flow)
        assert len(correlation_entries) == 1
        assert correlation_entries[0]["reason"] == "unknown_client_event"
        assert marker not in json.dumps(correlation_entries)

    def test_model_websocket_server_error_fails_open(self, tmp_path, real_flow):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        with self._usage_webhook_api() as webhook:
            feed_websocket_client_message(
                flow,
                json.dumps({"type": "response.create", "generate": False}).encode(),
            )
            feed_websocket_server_message(flow, b'{"type":"error","error":{"code":"busy"}}')
            feed_websocket_server_message(flow, _openai_websocket_created_frame("error-1"))
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame("error-1", input_tokens=9, output_tokens=0),
            )
            mitm_addon.websocket_end(flow)
            usage.flush_usage_events(trigger="test")

        expected_rows = [("gpt-5.5", "tokens.input", 9)]
        assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)
        assert not any(
            entry.get("disposition") == "ignored" for entry in model_usage_source_entries(flow)
        )
        [correlation_entry] = _correlation_entries(flow)
        assert correlation_entry["reason"] == "server_error"

    def test_model_websocket_correlation_cap_stays_bounded_and_fails_open(
        self,
        tmp_path,
        real_flow,
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)
        over_budget_error = b'{"type":"error","padding":[' + b",".join([b"0"] * 40_000) + b"]}"

        with self._usage_webhook_api() as webhook:
            feed_websocket_client_message(
                flow,
                json.dumps({"type": "response.create", "generate": False}).encode(),
            )
            feed_websocket_server_message(flow, over_budget_error)
            feed_websocket_server_message(flow, _openai_websocket_created_frame("cap-1"))
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame("cap-1", input_tokens=11, output_tokens=0),
            )
            mitm_addon.websocket_end(flow)
            usage.flush_usage_events(trigger="test")

        expected_rows = [("gpt-5.5", "tokens.input", 11)]
        assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)
        assert not any(
            entry.get("disposition") == "ignored" for entry in model_usage_source_entries(flow)
        )
        correlation_entries = _correlation_entries(flow)
        assert len(correlation_entries) == 1
        assert correlation_entries[0]["reason"] == "correlation_cap"

    def test_model_websocket_client_correlation_cap_fails_open(self, tmp_path, real_flow):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)
        over_budget_request = (
            b'{"type":"response.create","generate":false,"padding":['
            + b",".join([b"0"] * 40_000)
            + b"]}"
        )

        with self._usage_webhook_api() as webhook:
            feed_websocket_client_message(flow, over_budget_request)
            feed_websocket_server_message(flow, _openai_websocket_created_frame("client-cap-1"))
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame("client-cap-1", input_tokens=12, output_tokens=0),
            )
            mitm_addon.websocket_end(flow)
            usage.flush_usage_events(trigger="test")

        expected_rows = [("gpt-5.5", "tokens.input", 12)]
        assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)
        assert not any(
            entry.get("disposition") == "ignored" for entry in model_usage_source_entries(flow)
        )
        [correlation_entry] = _correlation_entries(flow)
        assert correlation_entry["reason"] == "correlation_cap"

    def test_model_websocket_unbound_prewarm_usage_fails_open(self, tmp_path, real_flow):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        with self._usage_webhook_api() as webhook:
            feed_websocket_client_message(
                flow,
                json.dumps({"type": "response.create", "generate": False}).encode(),
            )
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame(
                    "warm-without-created",
                    input_tokens=12,
                    output_tokens=0,
                ),
            )
            feed_websocket_server_message(
                flow,
                _openai_websocket_created_frame("response-after-unbound-terminal"),
            )
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame(
                    "response-after-unbound-terminal",
                    input_tokens=4,
                    output_tokens=0,
                ),
            )
            usage.flush_usage_events(trigger="test")

        expected_rows = [
            ("gpt-5.5", "tokens.input", 12),
            ("gpt-5.5", "tokens.input", 4),
        ]
        assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)
        assert not any(
            entry.get("disposition") == "ignored" for entry in model_usage_source_entries(flow)
        )

    def test_model_websocket_prewarm_with_missing_created_id_fails_open(
        self,
        tmp_path,
        real_flow,
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        with self._usage_webhook_api() as webhook:
            feed_websocket_client_message(
                flow,
                json.dumps({"type": "response.create", "generate": False}).encode(),
            )
            feed_websocket_server_message(
                flow,
                json.dumps({"type": "response.created", "response": {}}).encode(),
            )
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame(
                    "unbound-response",
                    input_tokens=6,
                    output_tokens=0,
                ),
            )
            usage.flush_usage_events(trigger="test")

        expected_rows = [("gpt-5.5", "tokens.input", 6)]
        assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)

    @pytest.mark.parametrize(
        "client_request",
        [
            b'{"type":"response.create"}',
            b'{"type":"response.create","generate":true}',
            b'{"type":"response.create","generate":"false"}',
            b'{"type":"response.create","generate":true,"generate":false}',
            b'{"type":"other","type":"response.create","generate":false}',
        ],
    )
    def test_model_websocket_non_prewarm_requests_retain_input_only_usage(
        self,
        tmp_path,
        real_flow,
        client_request: bytes,
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        with self._usage_webhook_api() as webhook:
            feed_websocket_client_message(flow, client_request)
            feed_websocket_server_message(flow, _openai_websocket_created_frame("resp-input-only"))
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame(
                    "resp-input-only",
                    input_tokens=9,
                    output_tokens=0,
                ),
            )
            usage.flush_usage_events(trigger="test")

        expected_rows = [("gpt-5.5", "tokens.input", 9)]
        assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)

    def test_model_websocket_conflicting_created_ids_fail_open(self, tmp_path, real_flow):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        with self._usage_webhook_api() as webhook:
            feed_websocket_client_message(
                flow,
                json.dumps({"type": "response.create", "generate": False}).encode(),
            )
            feed_websocket_server_message(
                flow,
                b'{"type":"response.created","response":{"id":"first","id":"second"}}',
            )
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame(
                    "second",
                    input_tokens=11,
                    output_tokens=0,
                ),
            )
            usage.flush_usage_events(trigger="test")

        expected_rows = [("gpt-5.5", "tokens.input", 11)]
        assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)

    def test_model_websocket_conflicting_terminal_ids_fail_open(self, tmp_path, real_flow):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        with self._usage_webhook_api() as webhook:
            feed_websocket_client_message(
                flow,
                json.dumps({"type": "response.create", "generate": False}).encode(),
            )
            feed_websocket_server_message(
                flow,
                _openai_websocket_created_frame("warm-ambiguous"),
            )
            feed_websocket_server_message(
                flow,
                b'{"type":"response.completed","response":'
                b'{"id":"other","id":"warm-ambiguous","model":"gpt-5.5",'
                b'"usage":{"input_tokens":13,"output_tokens":0}}}',
            )
            usage.flush_usage_events(trigger="test")

        expected_rows = [("gpt-5.5", "tokens.input", 13)]
        assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)
        assert not any(
            entry.get("disposition") == "ignored" for entry in model_usage_source_entries(flow)
        )

    def test_model_websocket_usage_free_conflicting_terminal_id_fails_open(
        self,
        tmp_path,
        real_flow,
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)
        sensitive_marker = "conflicting-terminal-sensitive-marker"

        with self._usage_webhook_api() as webhook:
            feed_websocket_client_message(
                flow,
                json.dumps({"type": "response.create", "generate": False}).encode(),
            )
            feed_websocket_server_message(
                flow,
                _openai_websocket_created_frame("warm-active"),
            )
            feed_websocket_server_message(
                flow,
                json.dumps(
                    {
                        "type": "response.completed",
                        "response": {
                            "id": "other-response",
                            "output": [
                                {
                                    "type": "message",
                                    "content": [{"type": "output_text", "text": sensitive_marker}],
                                }
                            ],
                        },
                    }
                ).encode(),
            )
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame(
                    "warm-active",
                    input_tokens=17,
                    output_tokens=0,
                ),
            )
            usage.flush_usage_events(trigger="test")

        expected_rows = [("gpt-5.5", "tokens.input", 17)]
        assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)
        assert not any(
            entry.get("disposition") == "ignored" for entry in model_usage_source_entries(flow)
        )
        correlation_entries = _correlation_entries(flow)
        assert len(correlation_entries) == 1
        assert correlation_entries[0]["reason"] == "invalid_lifecycle"
        assert sensitive_marker not in json.dumps(correlation_entries)

    def test_model_websocket_malformed_client_frame_retires_unbound_prewarm(
        self,
        tmp_path,
        real_flow,
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        with self._usage_webhook_api() as webhook:
            feed_websocket_client_message(
                flow,
                json.dumps({"type": "response.create", "generate": False}).encode(),
            )
            feed_websocket_client_message(flow, b'{"type":"response.create"')
            feed_websocket_server_message(flow, _openai_websocket_created_frame("resp-after-bad"))
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame(
                    "resp-after-bad",
                    input_tokens=8,
                    output_tokens=0,
                ),
            )
            usage.flush_usage_events(trigger="test")

        expected_rows = [("gpt-5.5", "tokens.input", 8)]
        assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)

    def test_model_websocket_prewarm_state_isolated_by_flow(self, tmp_path, real_flow):
        prewarm_flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        normal_flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(prewarm_flow)
        mitm_addon.responseheaders(normal_flow)

        with self._usage_webhook_api() as webhook:
            feed_websocket_client_message(
                prewarm_flow,
                json.dumps({"type": "response.create", "generate": False}).encode(),
            )
            feed_websocket_server_message(
                prewarm_flow,
                _openai_websocket_created_frame("shared-response-id"),
            )
            feed_websocket_server_message(
                prewarm_flow,
                openai_websocket_usage_frame(
                    "shared-response-id",
                    input_tokens=5,
                    output_tokens=0,
                ),
            )

            feed_websocket_client_message(
                normal_flow,
                json.dumps({"type": "response.create"}).encode(),
            )
            feed_websocket_server_message(
                normal_flow,
                _openai_websocket_created_frame("shared-response-id"),
            )
            feed_websocket_server_message(
                normal_flow,
                openai_websocket_usage_frame(
                    "shared-response-id",
                    input_tokens=7,
                    output_tokens=0,
                ),
            )
            feed_websocket_client_message(
                normal_flow,
                json.dumps({"type": "response.create", "generate": False}).encode(),
            )
            feed_websocket_server_message(
                normal_flow,
                _openai_websocket_created_frame("second-prewarm"),
            )
            feed_websocket_server_message(
                normal_flow,
                openai_websocket_usage_frame(
                    "second-prewarm",
                    input_tokens=6,
                    output_tokens=0,
                ),
            )
            usage.flush_usage_events(trigger="test")

        expected_rows = [("gpt-5.5", "tokens.input", 7)]
        assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)
        ignored_entries = [
            entry
            for entry in model_usage_source_entries(prewarm_flow)
            if entry.get("disposition") == "ignored"
        ]
        assert {
            (entry["flow_id"], entry["provider_response_id"], entry["usage"]["tokens.input"])
            for entry in ignored_entries
        } == {
            (prewarm_flow.id, "shared-response-id", 5),
            (normal_flow.id, "second-prewarm", 6),
        }
