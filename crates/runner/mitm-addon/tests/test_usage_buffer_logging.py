"""Tests for usage-buffer flush logging."""

import json

import pytest

import usage
from tests.usage_buffer_helpers import (
    DeliveryOutcomeCallback,
    RecordingEnqueue,
    event,
    flush_log_entries,
)


def test_flush_logs_aggregate_summary_without_token(tmp_path):
    enqueue = RecordingEnqueue()
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    proxy_log_path = tmp_path / "proxy.jsonl"

    usage.buffer_usage_events(
        "https://api.test/api/webhooks/run/usage-event",
        "secret-token",
        "run-1",
        [
            event(source_key="source-1", category="tokens.input", quantity=10),
            event(source_key="source-2", category="tokens.output", quantity=5),
        ],
        str(proxy_log_path),
    )

    assert usage.flush_usage_events(trigger="test") == 1

    enqueue.assert_called_once()
    entries = flush_log_entries(proxy_log_path)
    assert [entry["phase"] for entry in entries] == ["started", "enqueued"]
    assert [entry["message"] for entry in entries] == [
        "Usage event buffer flush started",
        "Usage event buffer flush enqueued",
    ]
    for entry in entries:
        assert entry["level"] == "info"
        assert entry["type"] == "usage_event_buffer_flush"
        assert entry["trigger"] == "test"
        assert entry["flush_sequence"] == 1
        assert entry["source_event_count"] == 2
        assert entry["aggregate_event_count"] == 2
        assert entry["webhook_batch_count"] == 1
        assert entry["run_count"] == 1
        assert entry["destination_count"] == 1
        assert "secret-token" not in json.dumps(entry)
    assert "duration_ms" not in entries[0]
    assert isinstance(entries[1]["duration_ms"], int)
    assert entries[1]["duration_ms"] >= 0


def test_flush_logs_isolate_summaries_across_proxy_log_paths(tmp_path):
    enqueue = RecordingEnqueue(return_value=False)
    usage.reset_usage_buffer_for_tests(
        enqueue_webhook=enqueue,
        max_retained_batch_retries=0,
    )
    proxy_a_log_path = tmp_path / "proxy-a.jsonl"
    proxy_b_log_path = tmp_path / "proxy-b.jsonl"

    usage.buffer_usage_events(
        "https://api-a-one.test/api/webhooks/run/usage-event",
        "token-a-one",
        "run-a-1",
        [
            event(source_key="source-a-1", category="tokens.input", quantity=10),
            event(source_key="source-a-2", category="tokens.output", quantity=5),
        ],
        str(proxy_a_log_path),
    )
    usage.buffer_usage_events(
        "https://api-a-two.test/api/webhooks/run/usage-event",
        "token-a-two",
        "run-a-2",
        [event(source_key="source-a-3", category="tokens.input", quantity=7)],
        str(proxy_a_log_path),
    )
    usage.buffer_usage_events(
        "https://api-b.test/api/webhooks/run/usage-event",
        "token-b",
        "run-b-1",
        [event(source_key="source-b-1", category="tokens.output", quantity=3)],
        str(proxy_b_log_path),
    )

    assert usage.flush_usage_events(trigger="test") == 0

    enqueue.assert_called_once()
    expected_summaries = {
        proxy_a_log_path: {
            "source_event_count": 3,
            "aggregate_event_count": 3,
            "webhook_batch_count": 2,
            "run_count": 2,
            "destination_count": 2,
        },
        proxy_b_log_path: {
            "source_event_count": 1,
            "aggregate_event_count": 1,
            "webhook_batch_count": 1,
            "run_count": 1,
            "destination_count": 1,
        },
    }
    all_entries = []
    for proxy_log_path, expected_counts in expected_summaries.items():
        entries = flush_log_entries(proxy_log_path)
        all_entries.extend(entries)
        assert [entry["phase"] for entry in entries] == ["started", "enqueued", "dropped"]
        assert [entry["type"] for entry in entries] == [
            "usage_event_buffer_flush",
            "usage_event_buffer_flush",
            "usage_underbilling",
        ]
        for entry in entries:
            for field, expected_count in expected_counts.items():
                assert entry[field] == expected_count
        dropped_entry = entries[2]
        assert dropped_entry["reason"] == "retry_budget_exhausted"
        assert dropped_entry["underbilling_class"] == "confirmed"
        assert dropped_entry["dropped_source_event_count"] == expected_counts["source_event_count"]
        assert (
            dropped_entry["dropped_webhook_batch_count"] == expected_counts["webhook_batch_count"]
        )

    serialized_entries = json.dumps(all_entries)
    for token in ("token-a-one", "token-a-two", "token-b"):
        assert token not in serialized_entries


def test_flush_logs_retained_webhook_batches(tmp_path):
    enqueue = RecordingEnqueue(return_value=False)
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    proxy_log_path = tmp_path / "proxy.jsonl"

    usage.buffer_usage_events(
        "https://api.test/api/webhooks/run/usage-event",
        "secret-token",
        "run-1",
        [event(source_key="source-1")],
        str(proxy_log_path),
    )

    assert usage.flush_usage_events(trigger="test") == 0

    enqueue.assert_called_once()
    entries = flush_log_entries(proxy_log_path)
    assert [entry["phase"] for entry in entries] == ["started", "enqueued"]
    assert entries[0]["dropped_webhook_batch_count"] == 0
    assert entries[0]["retained_webhook_batch_count"] == 0
    assert entries[1]["level"] == "info"
    assert entries[1]["message"] == "Usage event buffer flush retained webhook batches for retry"
    assert entries[1]["dropped_webhook_batch_count"] == 0
    assert entries[1]["retained_webhook_batch_count"] == 1
    assert entries[1]["retained_source_event_count"] == 1
    assert entries[1]["webhook_batch_count"] == 1
    assert "secret-token" not in json.dumps(entries)


def test_flush_logs_delivery_retry_retained_counts(tmp_path):
    callbacks: list[DeliveryOutcomeCallback] = []

    def enqueue_webhook(
        url: str,
        sandbox_token: str,
        payload: dict,
        path: str,
        log_type: str,
        delivery_outcome_callback: DeliveryOutcomeCallback,
    ) -> bool:
        del url, sandbox_token, payload, path, log_type
        callbacks.append(delivery_outcome_callback)
        return True

    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue_webhook)
    proxy_log_path = tmp_path / "proxy.jsonl"

    usage.buffer_usage_events(
        "https://api.test/api/webhooks/run/usage-event",
        "secret-token",
        "run-1",
        [
            event(source_key="source-1", category="tokens.input", quantity=10),
            event(source_key="source-2", category="tokens.output", quantity=5),
        ],
        str(proxy_log_path),
    )

    assert usage.flush_usage_events(trigger="test") == 1
    callbacks[0]("retryable_failure")

    entries = flush_log_entries(proxy_log_path)
    assert [entry["phase"] for entry in entries] == ["started", "enqueued", "retained"]
    retained_entry = entries[2]
    assert retained_entry["level"] == "info"
    assert retained_entry["message"] == "Usage event buffer flush retained for retry"
    assert retained_entry["source_event_count"] == 2
    assert retained_entry["webhook_batch_count"] == 1
    assert retained_entry["retained_webhook_batch_count"] == 1
    assert retained_entry["retained_source_event_count"] == 2
    assert "secret-token" not in json.dumps(entries)


def test_flush_logs_failure_without_token(tmp_path):
    def fail_enqueue(
        url: str,
        sandbox_token: str,
        payload: dict,
        path: str,
        log_type: str,
    ) -> bool:
        del url, sandbox_token, payload, path, log_type
        raise RuntimeError("secret-token")

    enqueue = RecordingEnqueue(side_effect=fail_enqueue)
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    proxy_log_path = tmp_path / "proxy.jsonl"

    usage.buffer_usage_events(
        "https://api.test/api/webhooks/run/usage-event",
        "secret-token",
        "run-1",
        [event(source_key="source-1")],
        str(proxy_log_path),
    )

    with pytest.raises(RuntimeError, match="secret-token"):
        usage.flush_usage_events(trigger="test")

    enqueue.assert_called_once()
    entries = flush_log_entries(proxy_log_path)
    assert [entry["phase"] for entry in entries] == ["started", "failed"]
    assert entries[1]["level"] == "error"
    assert entries[1]["message"] == "Usage event buffer flush failed"
    assert entries[1]["error_type"] == "RuntimeError"
    assert entries[1]["retained_webhook_batch_count"] == 1
    assert entries[1]["retained_source_event_count"] == 1
    assert isinstance(entries[1]["duration_ms"], int)
    assert entries[1]["duration_ms"] >= 0
    assert "secret-token" not in json.dumps(entries)


def test_flush_logs_only_unfinished_batch_after_partial_failure(tmp_path):
    attempted_runs: list[str] = []

    def fail_second_enqueue(
        url: str,
        sandbox_token: str,
        payload: dict,
        path: str,
        log_type: str,
    ) -> bool:
        del url, sandbox_token, path, log_type
        attempted_runs.append(payload["runId"])
        if payload["runId"] == "run-2":
            raise OSError("secret-token")
        return True

    enqueue = RecordingEnqueue(side_effect=fail_second_enqueue)
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    proxy_log_path = tmp_path / "proxy.jsonl"
    for run_id, source_key in (("run-1", "source-1"), ("run-2", "source-2")):
        usage.buffer_usage_events(
            "https://api.test/api/webhooks/run/usage-event",
            "secret-token",
            run_id,
            [event(source_key=source_key)],
            str(proxy_log_path),
        )

    with pytest.raises(OSError, match="secret-token"):
        usage.flush_usage_events(trigger="test")

    assert attempted_runs == ["run-1", "run-2"]
    entries = flush_log_entries(proxy_log_path)
    assert [entry["phase"] for entry in entries] == ["started", "failed"]
    failed_entry = entries[1]
    assert failed_entry["level"] == "error"
    assert failed_entry["error_type"] == "OSError"
    assert failed_entry["source_event_count"] == 2
    assert failed_entry["webhook_batch_count"] == 2
    assert failed_entry["retained_webhook_batch_count"] == 1
    assert failed_entry["retained_source_event_count"] == 1
    assert "secret-token" not in json.dumps(entries)


def test_flush_failure_excludes_retry_budget_drop_from_retained_counts(tmp_path):
    def fail_enqueue(
        url: str,
        sandbox_token: str,
        payload: dict,
        path: str,
        log_type: str,
    ) -> bool:
        del url, sandbox_token, payload, path, log_type
        raise OSError("secret-token")

    usage.reset_usage_buffer_for_tests(
        enqueue_webhook=RecordingEnqueue(side_effect=fail_enqueue),
        max_retained_batch_retries=0,
    )
    proxy_log_path = tmp_path / "proxy.jsonl"
    usage.buffer_usage_events(
        "https://api.test/api/webhooks/run/usage-event",
        "secret-token",
        "run-1",
        [event(source_key="source-1")],
        str(proxy_log_path),
    )

    with pytest.raises(OSError, match="secret-token"):
        usage.flush_usage_events(trigger="test")

    entries = flush_log_entries(proxy_log_path)
    assert [entry["phase"] for entry in entries] == ["started", "failed", "dropped"]
    failed_entry = entries[1]
    assert failed_entry["source_event_count"] == 1
    assert failed_entry["webhook_batch_count"] == 1
    assert failed_entry["retained_webhook_batch_count"] == 0
    assert failed_entry["retained_source_event_count"] == 0
    dropped_entry = entries[2]
    assert dropped_entry["type"] == "usage_underbilling"
    assert dropped_entry["reason"] == "retry_budget_exhausted"
    assert dropped_entry["dropped_webhook_batch_count"] == 1
    assert dropped_entry["dropped_source_event_count"] == 1
    assert "secret-token" not in json.dumps(entries)
