"""Tests for usage-buffer idempotency and rejected-event boundaries."""

import uuid

import usage
import usage.buffer as usage_buffer
from tests.usage_buffer_helpers import RecordingEnqueue, event


def test_rejected_events_do_not_leave_empty_destination_buckets(tmp_path):
    enqueue = RecordingEnqueue()
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)

    assert (
        usage.buffer_usage_events(
            "https://api-empty.test/api/webhooks/run/usage-event",
            "token-empty",
            "run-empty",
            [],
            str(tmp_path / "empty-proxy.jsonl"),
        )
        == 0
    )
    assert usage.flush_usage_events(trigger="test") == 0
    enqueue.assert_not_called()

    assert (
        usage.buffer_usage_events(
            "https://api-a.test/api/webhooks/run/usage-event",
            "token-a",
            "run-1",
            [event(source_key="source-1")],
            str(tmp_path / "proxy-a.jsonl"),
        )
        == 1
    )

    assert (
        usage.buffer_usage_events(
            "https://api-b.test/api/webhooks/run/usage-event",
            "token-b",
            "run-2",
            [event(source_key="source-1")],
            str(tmp_path / "proxy-b.jsonl"),
        )
        == 0
    )

    assert usage.flush_usage_events(trigger="test") == 1

    enqueue.assert_called_once()
    assert enqueue.last_call.url == "https://api-a.test/api/webhooks/run/usage-event"
    assert enqueue.last_call.sandbox_token == "token-a"
    assert enqueue.last_call.payload["runId"] == "run-1"


def test_aggregate_buffer_collects_only_accepted_source_keys(tmp_path):
    enqueue = RecordingEnqueue()
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    proxy_log_path = str(tmp_path / "proxy.jsonl")
    accepted_source_keys: set[str] = set()

    accepted_count = usage.buffer_usage_events(
        "https://api.test/api/webhooks/run/usage-event",
        "token-a",
        "run-1",
        [
            event(source_key="source-1", quantity=10),
            event(source_key="source-1", quantity=100),
            event(source_key="source-2", quantity=5),
        ],
        proxy_log_path,
        accepted_source_keys=accepted_source_keys,
    )

    assert accepted_count == 2
    assert accepted_source_keys == {"source-1", "source-2"}

    duplicate_keys: set[str] = set()
    assert (
        usage.buffer_usage_events(
            "https://api.test/api/webhooks/run/usage-event",
            "token-a",
            "run-1",
            [event(source_key="source-1", quantity=200)],
            proxy_log_path,
            accepted_source_keys=duplicate_keys,
        )
        == 0
    )
    assert duplicate_keys == set()

    assert usage.flush_usage_events(trigger="test") == 1
    assert enqueue.last_call.payload["events"][0]["quantity"] == 15


def test_aggregate_idempotency_key_changes_between_flush_batches(tmp_path):
    enqueue = RecordingEnqueue()
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    proxy_log_path = str(tmp_path / "proxy.jsonl")

    usage.buffer_usage_events(
        "https://api.test/api/webhooks/run/usage-event",
        "token-a",
        "run-1",
        [event(source_key="source-1", quantity=10)],
        proxy_log_path,
    )
    usage.flush_usage_events(trigger="test")
    usage.buffer_usage_events(
        "https://api.test/api/webhooks/run/usage-event",
        "token-a",
        "run-1",
        [event(source_key="source-2", quantity=10)],
        proxy_log_path,
    )
    usage.flush_usage_events(trigger="test")

    keys = [payload["events"][0]["idempotencyKey"] for payload in enqueue.payloads]
    assert len(keys) == 2
    assert keys[0] != keys[1]
    for key in keys:
        uuid.UUID(key)


def test_source_dedupe_survives_flush_boundary(tmp_path):
    enqueue = RecordingEnqueue()
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    proxy_log_path = str(tmp_path / "proxy.jsonl")

    usage.buffer_usage_events(
        "https://api.test/api/webhooks/run/usage-event",
        "token-a",
        "run-1",
        [event(source_key="source-1", quantity=10)],
        proxy_log_path,
    )
    usage.flush_usage_events(trigger="test")
    usage.buffer_usage_events(
        "https://api.test/api/webhooks/run/usage-event",
        "token-a",
        "run-1",
        [event(source_key="source-1", quantity=10)],
        proxy_log_path,
    )
    usage.flush_usage_events(trigger="test")

    enqueue.assert_called_once()


def test_source_dedupe_accepts_evicted_oldest_key_after_bound(tmp_path):
    enqueue = RecordingEnqueue()
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    proxy_log_path = str(tmp_path / "proxy.jsonl")
    source_key_count = usage_buffer.MAX_SOURCE_IDEMPOTENCY_KEYS + 1
    events = [event(source_key=f"source-{index}", quantity=1) for index in range(source_key_count)]

    accepted = usage.buffer_usage_events(
        "https://api.test/api/webhooks/run/usage-event",
        "token-a",
        "run-1",
        events,
        proxy_log_path,
    )

    assert accepted == source_key_count
    assert enqueue.call_count == 1
    first_payload = enqueue.calls[0].payload
    assert first_payload["events"][0]["quantity"] == source_key_count

    assert (
        usage.buffer_usage_events(
            "https://api.test/api/webhooks/run/usage-event",
            "token-a",
            "run-1",
            [
                event(source_key="source-0", quantity=1),
                event(source_key="source-1", quantity=100),
            ],
            proxy_log_path,
        )
        == 1
    )
    assert usage.flush_usage_events(trigger="test") == 1

    assert enqueue.call_count == 2
    second_payload = enqueue.calls[1].payload
    assert second_payload["events"][0]["quantity"] == 1


def test_aggregate_idempotency_key_separates_webhook_destinations(tmp_path):
    enqueue = RecordingEnqueue()
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    proxy_log_path = str(tmp_path / "proxy.jsonl")

    for token in ("token-a", "token-b"):
        usage.buffer_usage_events(
            "https://api.test/api/webhooks/run/usage-event",
            token,
            "run-1",
            [event(source_key=f"source-{token}", quantity=10)],
            proxy_log_path,
        )
    usage.flush_usage_events(trigger="test")

    keys = [payload["events"][0]["idempotencyKey"] for payload in enqueue.payloads]
    assert len(keys) == 2
    assert keys[0] != keys[1]
