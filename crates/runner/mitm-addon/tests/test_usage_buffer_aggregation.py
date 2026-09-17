"""Tests for usage-buffer aggregation and flush thresholds."""

import uuid

import usage
import usage.buffer as usage_buffer
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.pending_helpers import assert_pending
from tests.usage_buffer_helpers import RecordingEnqueue, event
from usage.quantities import MAX_USAGE_QUANTITY


def test_flush_aggregates_same_bucket_and_dedupes_source_key(tmp_path):
    enqueue = RecordingEnqueue()
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    proxy_log_path = str(tmp_path / "proxy.jsonl")

    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [
            event(source_key="source-1", quantity=10),
            event(source_key="source-2", quantity=5),
            event(source_key="source-1", quantity=100),
        ],
        proxy_log_path,
    )

    enqueue.assert_not_called()
    assert usage.flush_usage_events(trigger="test") == 1

    enqueue.assert_called_once()
    payload = enqueue.last_call.payload
    assert payload["runId"] == "run-1"
    assert payload["events"] == [
        {
            "idempotencyKey": payload["events"][0]["idempotencyKey"],
            "kind": "model",
            "provider": "claude-sonnet-4-6",
            "category": "tokens.input",
            "quantity": 15,
        }
    ]
    uuid.UUID(payload["events"][0]["idempotencyKey"])
    assert enqueue.last_call.proxy_log_path == proxy_log_path


def test_flush_segments_aggregate_before_quantity_exceeds_exact_integer_range(tmp_path):
    enqueue = RecordingEnqueue()
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)

    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [
            event(source_key="source-1", quantity=MAX_USAGE_QUANTITY),
            event(source_key="source-2", quantity=1),
        ],
        str(tmp_path / "proxy.jsonl"),
    )

    assert usage.flush_usage_events(trigger="test") == 1
    enqueue.assert_called_once()
    events = enqueue.last_call.payload["events"]
    assert [flushed_event["quantity"] for flushed_event in events] == [
        MAX_USAGE_QUANTITY,
        1,
    ]
    assert len({flushed_event["idempotencyKey"] for flushed_event in events}) == 2


def test_rejects_out_of_range_source_quantity_before_recording_idempotency(tmp_path):
    enqueue = RecordingEnqueue()
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    proxy_log_path = tmp_path / "proxy.jsonl"
    accepted_source_keys: set[str] = set()

    assert (
        usage.buffer_source_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-1",
            [event(source_key="source-1", quantity=MAX_USAGE_QUANTITY + 1)],
            str(proxy_log_path),
            accepted_source_keys=accepted_source_keys,
        )
        == 0
    )
    assert accepted_source_keys == set()
    assert (
        usage.buffer_source_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-1",
            [event(source_key="source-1", quantity=1)],
            str(proxy_log_path),
            accepted_source_keys=accepted_source_keys,
        )
        == 1
    )

    assert usage.flush_usage_events(trigger="test") == 1
    assert enqueue.last_call.payload["events"][0]["quantity"] == 1
    [warning] = [
        entry
        for entry in read_jsonl_entries_after_flush(proxy_log_path)
        if entry.get("reason") == "usage_quantity_out_of_range"
    ]
    assert warning["type"] == "usage_underbilling"
    assert warning["underbilling_class"] == "confirmed"
    assert "quantity" not in warning


def test_out_of_range_atomic_group_rejects_every_member_before_idempotency(tmp_path):
    enqueue = RecordingEnqueue()
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    proxy_log_path = str(tmp_path / "proxy.jsonl")
    source_events = [
        event(source_key="source-input", quantity=10),
        event(
            source_key="source-cache-read",
            category="tokens.cache_read",
            quantity=MAX_USAGE_QUANTITY + 1,
        ),
    ]

    assert (
        usage.buffer_source_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-1",
            source_events,
            proxy_log_path,
            atomic_source_key="input-partition-1",
        )
        == 0
    )
    source_events[1]["quantity"] = 4
    assert (
        usage.buffer_source_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-1",
            source_events,
            proxy_log_path,
            atomic_source_key="input-partition-1",
        )
        == 2
    )

    assert usage.flush_usage_events(trigger="test") == 1
    assert [flushed_event["quantity"] for flushed_event in enqueue.last_call.payload["events"]] == [
        10,
        4,
    ]


def test_source_preserving_usage_buffer_keeps_source_idempotency_keys(tmp_path):
    enqueue = RecordingEnqueue()
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    accepted_source_keys: set[str] = set()

    usage.buffer_source_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [
            event(source_key="source-1", quantity=10),
            event(source_key="source-2", quantity=5),
            event(source_key="source-1", quantity=100),
        ],
        str(tmp_path / "proxy.jsonl"),
        accepted_source_keys=accepted_source_keys,
    )
    assert accepted_source_keys == {"source-1", "source-2"}
    assert usage.flush_usage_events(trigger="test") == 1

    enqueue.assert_called_once()
    assert enqueue.last_call.payload == {
        "runId": "run-1",
        "events": [
            {
                "idempotencyKey": "source-1",
                "kind": "model",
                "provider": "claude-sonnet-4-6",
                "category": "tokens.input",
                "quantity": 10,
            },
            {
                "idempotencyKey": "source-2",
                "kind": "model",
                "provider": "claude-sonnet-4-6",
                "category": "tokens.input",
                "quantity": 5,
            },
        ],
    }


def test_source_preserving_atomic_group_rejects_repeated_group_key(tmp_path):
    enqueue = RecordingEnqueue()
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    proxy_log_path = str(tmp_path / "proxy.jsonl")
    accepted_source_keys: set[str] = set()

    assert (
        usage.buffer_source_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-1",
            [],
            proxy_log_path,
            atomic_source_key="input-partition-1",
        )
        == 0
    )
    assert (
        usage.buffer_source_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-1",
            [
                event(source_key="source-input", quantity=10),
                event(
                    source_key="source-cache-read",
                    category="tokens.cache_read",
                    quantity=4,
                ),
            ],
            proxy_log_path,
            atomic_source_key="input-partition-1",
            accepted_source_keys=accepted_source_keys,
        )
        == 2
    )
    assert accepted_source_keys == {"source-input", "source-cache-read"}
    rejected_source_keys: set[str] = set()
    assert (
        usage.buffer_source_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-1",
            [
                event(
                    source_key="source-cache-creation",
                    category="tokens.cache_creation",
                    quantity=3,
                )
            ],
            proxy_log_path,
            atomic_source_key="input-partition-1",
            accepted_source_keys=rejected_source_keys,
        )
        == 0
    )
    assert rejected_source_keys == set()

    assert usage.flush_usage_events(trigger="test") == 1
    enqueue.assert_called_once()
    assert enqueue.last_call.payload == {
        "runId": "run-1",
        "events": [
            {
                "idempotencyKey": "source-input",
                "kind": "model",
                "provider": "claude-sonnet-4-6",
                "category": "tokens.input",
                "quantity": 10,
            },
            {
                "idempotencyKey": "source-cache-read",
                "kind": "model",
                "provider": "claude-sonnet-4-6",
                "category": "tokens.cache_read",
                "quantity": 4,
            },
        ],
    }


def test_source_preserving_atomic_group_rejects_when_member_key_was_seen(tmp_path):
    enqueue = RecordingEnqueue()
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    proxy_log_path = str(tmp_path / "proxy.jsonl")
    url = "https://api.test/api/webhooks/agent/usage-event"

    assert (
        usage.buffer_source_usage_events(
            url,
            "token-a",
            "run-1",
            [event(source_key="source-input", quantity=10)],
            proxy_log_path,
        )
        == 1
    )
    assert (
        usage.buffer_source_usage_events(
            url,
            "token-a",
            "run-1",
            [
                event(source_key="source-input", quantity=20),
                event(
                    source_key="source-cache-read",
                    category="tokens.cache_read",
                    quantity=8,
                ),
            ],
            proxy_log_path,
            atomic_source_key="input-partition-1",
        )
        == 0
    )

    assert usage.flush_usage_events(trigger="test") == 1
    enqueue.assert_called_once()
    assert enqueue.last_call.payload == {
        "runId": "run-1",
        "events": [
            {
                "idempotencyKey": "source-input",
                "kind": "model",
                "provider": "claude-sonnet-4-6",
                "category": "tokens.input",
                "quantity": 10,
            }
        ],
    }


def test_source_preserving_atomic_group_rejects_duplicate_member_keys(tmp_path):
    enqueue = RecordingEnqueue()
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    proxy_log_path = str(tmp_path / "proxy.jsonl")

    assert (
        usage.buffer_source_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-1",
            [
                event(source_key="source-duplicate", quantity=10),
                event(
                    source_key="source-duplicate",
                    category="tokens.cache_read",
                    quantity=4,
                ),
            ],
            proxy_log_path,
            atomic_source_key="input-partition-1",
        )
        == 0
    )
    assert usage.flush_usage_events(trigger="test") == 0
    enqueue.assert_not_called()

    assert (
        usage.buffer_source_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-1",
            [
                event(source_key="source-input", quantity=10),
                event(
                    source_key="source-cache-read",
                    category="tokens.cache_read",
                    quantity=4,
                ),
            ],
            proxy_log_path,
            atomic_source_key="input-partition-1",
        )
        == 2
    )
    assert usage.flush_usage_events(trigger="test") == 1
    enqueue.assert_called_once()
    assert [
        flushed_event["idempotencyKey"] for flushed_event in enqueue.last_call.payload["events"]
    ] == ["source-input", "source-cache-read"]


def test_flush_keeps_runs_categories_providers_and_destinations_separate(tmp_path):
    enqueue = RecordingEnqueue()
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    proxy_a_log_path = str(tmp_path / "proxy-a.jsonl")
    proxy_b_log_path = str(tmp_path / "proxy-b.jsonl")

    usage.buffer_usage_events(
        "https://api-a.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [
            event(source_key="source-1", category="tokens.input", quantity=10),
            event(source_key="source-2", category="tokens.output", quantity=5),
        ],
        proxy_a_log_path,
    )
    usage.buffer_usage_events(
        "https://api-a.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-2",
        [event(source_key="source-3", category="tokens.input", quantity=7)],
        proxy_a_log_path,
    )
    usage.buffer_usage_events(
        "https://api-b.test/api/webhooks/agent/usage-event",
        "token-b",
        "run-1",
        [
            event(
                source_key="source-4",
                category="posts.read",
                quantity=3,
                kind="connector",
                provider="x",
            )
        ],
        proxy_b_log_path,
    )

    assert usage.flush_usage_events(trigger="test") == 3
    assert enqueue.call_count == 3
    routed_batches = {
        (
            call.url,
            call.sandbox_token,
            call.proxy_log_path,
            call.log_type,
            call.payload["runId"],
            frozenset(
                (
                    flushed_event["kind"],
                    flushed_event["provider"],
                    flushed_event["category"],
                    flushed_event["quantity"],
                )
                for flushed_event in call.payload["events"]
            ),
        )
        for call in enqueue.calls
    }
    assert routed_batches == {
        (
            "https://api-a.test/api/webhooks/agent/usage-event",
            "token-a",
            proxy_a_log_path,
            "usage_event",
            "run-1",
            frozenset(
                {
                    ("model", "claude-sonnet-4-6", "tokens.input", 10),
                    ("model", "claude-sonnet-4-6", "tokens.output", 5),
                }
            ),
        ),
        (
            "https://api-a.test/api/webhooks/agent/usage-event",
            "token-a",
            proxy_a_log_path,
            "usage_event",
            "run-2",
            frozenset({("model", "claude-sonnet-4-6", "tokens.input", 7)}),
        ),
        (
            "https://api-b.test/api/webhooks/agent/usage-event",
            "token-b",
            proxy_b_log_path,
            "usage_event",
            "run-1",
            frozenset({("connector", "x", "posts.read", 3)}),
        ),
    }


def test_flush_splits_aggregate_events_at_webhook_limit(tmp_path):
    enqueue = RecordingEnqueue()
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    events = [
        event(source_key=f"source-{index}", category=f"category-{index}") for index in range(101)
    ]

    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        events,
        str(tmp_path / "proxy.jsonl"),
    )

    payloads = enqueue.payloads
    assert [len(payload["events"]) for payload in payloads] == [100, 1]
    assert {payload["runId"] for payload in payloads} == {"run-1"}
    all_events = [flushed_event for payload in payloads for flushed_event in payload["events"]]
    idempotency_keys = [flushed_event["idempotencyKey"] for flushed_event in all_events]
    assert len(idempotency_keys) == 101
    assert len(set(idempotency_keys)) == 101
    for idempotency_key in idempotency_keys:
        uuid.UUID(idempotency_key)


def test_flushes_when_buffered_webhook_batch_count_reaches_bound(tmp_path):
    enqueue = RecordingEnqueue()
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)

    for index in range(3):
        usage.buffer_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            f"run-{index}",
            [event(source_key=f"source-{index}")],
            str(tmp_path / "proxy.jsonl"),
        )
    enqueue.assert_not_called()

    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-3",
        [event(source_key="source-3")],
        str(tmp_path / "proxy.jsonl"),
    )

    assert [payload["runId"] for payload in enqueue.payloads] == [
        "run-0",
        "run-1",
        "run-2",
        "run-3",
    ]


def test_flushes_when_aggregate_bucket_count_reaches_exact_bound(tmp_path):
    enqueue = RecordingEnqueue()
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)

    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [
            event(source_key=f"source-{index}", category=f"category-{index}")
            for index in range(usage_buffer.MAX_AGGREGATE_BUCKETS - 1)
        ],
        str(tmp_path / "proxy.jsonl"),
    )
    enqueue.assert_not_called()

    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [
            event(
                source_key=f"source-{usage_buffer.MAX_AGGREGATE_BUCKETS - 1}",
                category=f"category-{usage_buffer.MAX_AGGREGATE_BUCKETS - 1}",
            )
        ],
        str(tmp_path / "proxy.jsonl"),
    )

    enqueue.assert_called_once()
    payload = enqueue.last_call.payload
    assert payload["runId"] == "run-1"
    assert len(payload["events"]) == usage_buffer.MAX_AGGREGATE_BUCKETS


def test_flushes_when_safe_quantity_segments_reach_aggregate_bucket_bound(tmp_path):
    enqueue = RecordingEnqueue()
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)

    accepted = usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [
            event(
                source_key=f"source-{index}",
                quantity=MAX_USAGE_QUANTITY,
            )
            for index in range(usage_buffer.MAX_AGGREGATE_BUCKETS)
        ],
        str(tmp_path / "proxy.jsonl"),
    )

    assert accepted == usage_buffer.MAX_AGGREGATE_BUCKETS
    enqueue.assert_called_once()
    events = enqueue.last_call.payload["events"]
    assert len(events) == usage_buffer.MAX_AGGREGATE_BUCKETS
    assert all(flushed_event["quantity"] == MAX_USAGE_QUANTITY for flushed_event in events)
    assert len({flushed_event["idempotencyKey"] for flushed_event in events}) == len(events)


def test_flushes_when_source_event_count_reaches_bound(tmp_path):
    control_root = tmp_path / "delivery-control"
    enqueue = RecordingEnqueue()
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    events = [
        event(source_key=f"source-{index}", quantity=1)
        for index in range(usage_buffer.MAX_BUFFERED_SOURCE_EVENTS)
    ]

    accepted = usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        events,
        str(tmp_path / "proxy.jsonl"),
    )

    assert accepted == usage_buffer.MAX_BUFFERED_SOURCE_EVENTS
    enqueue.assert_called_once()
    payload = enqueue.last_call.payload
    assert payload["runId"] == "run-1"
    assert payload["events"] == [
        {
            "idempotencyKey": payload["events"][0]["idempotencyKey"],
            "kind": "model",
            "provider": "claude-sonnet-4-6",
            "category": "tokens.input",
            "quantity": usage_buffer.MAX_BUFFERED_SOURCE_EVENTS,
        }
    ]
    assert_pending(
        control_root,
        flows=0,
        buffered=0,
        reports=0,
    )


def test_empty_flush_is_noop():
    enqueue = RecordingEnqueue()
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)

    assert usage.flush_usage_events(trigger="test") == 0

    enqueue.assert_not_called()
