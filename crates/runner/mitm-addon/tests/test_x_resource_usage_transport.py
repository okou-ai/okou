"""Resource usage survives buffering, bounded batching and delivery retries."""

import contextlib
import copy
import json
import urllib.request
import uuid
from datetime import UTC, datetime
from unittest.mock import patch

import pytest

import usage
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.usage_buffer_helpers import RecordingEnqueue, event
from usage.buffer import UsageEvent, seen_source_idempotency_keys
from usage.buffer.models import MAX_RESOURCE_BATCH_BYTES
from usage.counters import delivery_snapshot

_RUN_ID = "00000000-0000-4000-8000-000000000001"
_OTHER_RUN_ID = "00000000-0000-4000-8000-000000000002"


def _resource_event(
    source: str,
    *,
    ids: int = 1,
    observed_at: str = "2026-09-18T12:00:00.000Z",
) -> UsageEvent:
    return {
        "idempotencyKey": str(uuid.uuid5(uuid.NAMESPACE_URL, source)),
        "kind": "connector",
        "provider": "x",
        "category": "posts.read",
        "quantity": ids,
        "protocol": "x-resource-v1",
        "observedAt": observed_at,
        "resources": [{"id": str(index).zfill(32), "occurrences": 1} for index in range(ids)],
        "remainder": [],
    }


def _buffer(tmp_path, events: list[UsageEvent], *, run_id: str = _RUN_ID) -> int:
    # Ordinary admission must also preserve a resource source automatically.
    return usage.buffer_usage_events(
        "https://api.okou.ai/api/webhooks/agent/usage-event",
        "token-a",
        run_id,
        events,
        str(tmp_path / "proxy.jsonl"),
    )


class _Clock(datetime):
    current = datetime(2026, 9, 18, 12, tzinfo=UTC)

    @classmethod
    def now(cls, tz=None):
        return cls.current.astimezone(tz)


def test_resource_admission_copies_nested_fields_and_dedupes_after_flush(tmp_path):
    enqueue = RecordingEnqueue()
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    source = _resource_event("copy")
    assert "resources" in source
    source["quantity"] = 5
    source["resources"][0]["occurrences"] = 3
    source["remainder"] = [{"reason": "missing_id", "quantity": 2}]
    expected = copy.deepcopy(source)
    assert _buffer(tmp_path, [source]) == 1
    source["resources"][0]["id"] = "999"
    source["resources"].append({"id": "42", "occurrences": 1})
    source["remainder"][0]["quantity"] = 500
    source["observedAt"] = "2026-09-19T00:00:00.000Z"

    assert usage.flush_usage_events(trigger="test") == 1
    assert enqueue.last_call.payload["events"] == [expected]
    assert _buffer(tmp_path, [expected]) == 0
    assert usage.flush_usage_events(trigger="test") == 0


def test_resource_batches_partition_protocol_day_and_run(tmp_path):
    enqueue = RecordingEnqueue()
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    sources = [
        _resource_event("today"),
        _resource_event("yesterday", observed_at="2026-09-17T23:59:59.999Z"),
        _resource_event("zero", ids=0),
    ]
    assert _buffer(tmp_path, sources) == 3
    assert _buffer(tmp_path, [event(source_key="legacy-1", quantity=2)]) == 1
    assert _buffer(tmp_path, [event(source_key="legacy-2", quantity=3)]) == 1
    assert _buffer(tmp_path, [_resource_event("other-run")], run_id=_OTHER_RUN_ID) == 1
    usage.flush_usage_events(trigger="test")

    resource_payloads = []
    legacy_payloads = []
    for payload in enqueue.payloads:
        protocols = {item.get("protocol") for item in payload["events"]}
        assert len(protocols) == 1
        if protocols == {"x-resource-v1"}:
            assert len({item["observedAt"][:10] for item in payload["events"]}) == 1
            resource_payloads.append(payload)
        else:
            legacy_payloads.append(payload)
    assert len(resource_payloads) == 3
    assert [item["quantity"] for payload in legacy_payloads for item in payload["events"]] == [5]
    assert any(item == sources[2] for p in resource_payloads for item in p["events"])
    assert {payload["runId"] for payload in resource_payloads} == {_RUN_ID, _OTHER_RUN_ID}


@pytest.mark.parametrize("event_count", [100, 101])
def test_resource_event_count_boundary(tmp_path, event_count):
    enqueue = RecordingEnqueue()
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    sources = [_resource_event(str(index), ids=0) for index in range(event_count)]
    assert _buffer(tmp_path, sources) == event_count
    usage.flush_usage_events(trigger="test")
    assert [len(payload["events"]) for payload in enqueue.payloads] == (
        [100] if event_count == 100 else [100, 1]
    )
    assert [item for payload in enqueue.payloads for item in payload["events"]] == sources


def test_resource_id_batch_bound_counts_entries_across_sources(tmp_path):
    enqueue = RecordingEnqueue()
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    sources = [
        _resource_event("first", ids=600),
        _resource_event("second", ids=400),
        _resource_event("third"),
    ]
    assert _buffer(tmp_path, sources) == 3
    usage.flush_usage_events(trigger="test")
    assert [
        sum(len(item["resources"]) for item in payload["events"]) for payload in enqueue.payloads
    ] == [1000, 1]
    assert [item for payload in enqueue.payloads for item in payload["events"]] == sources


def test_maximum_resource_request_preserves_observations_within_wire_byte_limit(tmp_path):
    enqueue = RecordingEnqueue()
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    sources = [_resource_event(f"source-{index}", ids=10) for index in range(100)]
    assert _buffer(tmp_path, sources) == 100
    usage.flush_usage_events(trigger="test")
    enqueue.assert_called_once()
    payload = enqueue.last_call.payload
    assert payload["runId"] == _RUN_ID
    assert payload["events"] == sources
    assert sum(len(item["resources"]) for item in payload["events"]) == 1000
    assert all(
        len(resource["id"]) == 32 for item in sources for resource in item.get("resources", [])
    )
    assert len(json.dumps(payload).encode()) <= MAX_RESOURCE_BATCH_BYTES


def test_oversized_immutable_source_is_rejected_without_rekeying(tmp_path):
    enqueue = RecordingEnqueue()
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    source = _resource_event("large", ids=1001)
    assert _buffer(tmp_path, [source]) == 0
    assert usage.flush_usage_events(trigger="test") == 0
    enqueue.assert_not_called()
    assert seen_source_idempotency_keys([source["idempotencyKey"]]) == set()
    entries = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
    assert any(entry.get("reason") == "x_resource_event_too_large" for entry in entries)


def test_resource_id_heavy_batches_trigger_existing_flush_threshold(tmp_path):
    enqueue = RecordingEnqueue()
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    for index in range(3):
        assert _buffer(tmp_path, [_resource_event(str(index), ids=1000)]) == 1
    enqueue.assert_not_called()
    assert _buffer(tmp_path, [_resource_event("fourth", ids=1000)]) == 1
    assert enqueue.call_count == 4
    assert delivery_snapshot()["buffered"] == 0


def test_partial_saturation_keeps_resource_payload_unchanged(tmp_path):
    def saturate_second(_url, _token, payload, _path, _log_type):
        return payload["events"][0]["idempotencyKey"] == first["idempotencyKey"]

    first = _resource_event("first", ids=1000)
    second = _resource_event("second", ids=1000)
    enqueue = RecordingEnqueue(side_effect=saturate_second)
    usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)
    assert _buffer(tmp_path, [first, second]) == 2
    assert usage.flush_usage_events(trigger="test") == 1
    retained = json.dumps(enqueue.last_call.payload).encode()
    assert delivery_snapshot()["buffered"] == 1
    enqueue.side_effect = None
    enqueue.clear()
    assert usage.flush_usage_events(trigger="test") == 1
    assert json.dumps(enqueue.last_call.payload).encode() == retained
    assert delivery_snapshot()["buffered"] == 0


def test_resource_http_retries_and_shutdown_keep_same_wire_payload(tmp_path, sync_usage_executor):
    opened: list[bytes] = []

    def open_request(request, *, timeout):
        assert timeout == 10
        opened.append(request.data)
        if len(opened) <= 2:
            raise TimeoutError("synthetic retry")
        return contextlib.nullcontext()

    _Clock.current = datetime(2026, 9, 18, 12, tzinfo=UTC)
    source = _resource_event("retry")
    _buffer(tmp_path, [source])
    with (
        patch.object(usage.webhook, "datetime", _Clock),
        patch.object(urllib.request.OpenerDirector, "open", side_effect=open_request),
        patch.object(usage.webhook.time, "sleep"),
    ):
        assert usage.flush_usage_events(trigger="test") == 1
        assert delivery_snapshot()["buffered"] == 1
        sync_usage_executor.shutdown(wait=True)
        usage.drain_usage_events_after_executor_shutdown()
    assert len(opened) == 3
    assert opened[0] == opened[1] == opened[2]
    assert json.loads(opened[0])["events"] == [source]
    snapshot = delivery_snapshot()
    assert snapshot["buffered"] == snapshot["reports"] == 0
    assert snapshot["outcomes"] == {
        "success": 1,
        "retryable_failure": 1,
        "permanent_failure": 0,
    }
    assert usage.webhook.pending_delivery_payload_count_for_tests() == 0


@pytest.mark.parametrize("expired", [False, True])
def test_resource_observation_uses_two_utc_dates_not_rolling_48_hours(
    tmp_path, sync_usage_executor, expired
):
    del sync_usage_executor
    _Clock.current = datetime(2026, 9, 19, 0, tzinfo=UTC)
    source = _resource_event(
        "expiry", observed_at="2026-09-17T23:59:59.999Z" if expired else "2026-09-18T00:00:00.000Z"
    )
    _buffer(tmp_path, [source])
    with (
        patch.object(usage.webhook, "datetime", _Clock),
        patch.object(
            urllib.request.OpenerDirector, "open", return_value=contextlib.nullcontext()
        ) as opened,
    ):
        assert usage.flush_usage_events(trigger="test") == 1
    assert opened.call_count == (0 if expired else 1)
    assert delivery_snapshot()["buffered"] == delivery_snapshot()["reports"] == 0
    outcomes = delivery_snapshot()["outcomes"]
    assert isinstance(outcomes, dict)
    assert outcomes["permanent_failure"] == int(expired)
    if expired:
        entries = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
        assert any(entry.get("reason") == "x_resource_observation_expired" for entry in entries)
    assert usage.flush_usage_events(trigger="test") == 0


def test_resource_http_retry_rechecks_day_after_first_attempt(tmp_path, sync_usage_executor):
    del sync_usage_executor
    _Clock.current = datetime(2026, 9, 18, 23, 59, 59, tzinfo=UTC)
    source = _resource_event("midnight", observed_at="2026-09-17T23:59:59.999Z")
    opened: list[bytes] = []

    def open_request(request, *, timeout):
        assert timeout == 10
        opened.append(request.data)
        _Clock.current = datetime(2026, 9, 19, 0, tzinfo=UTC)
        raise TimeoutError("response lost across midnight")

    _buffer(tmp_path, [source])
    with (
        patch.object(usage.webhook, "datetime", _Clock),
        patch.object(urllib.request.OpenerDirector, "open", side_effect=open_request),
        patch.object(usage.webhook.time, "sleep"),
    ):
        assert usage.flush_usage_events(trigger="test") == 1
    assert len(opened) == 1
    assert json.loads(opened[0])["events"] == [source]
    snapshot = delivery_snapshot()
    assert snapshot["buffered"] == snapshot["reports"] == 0
    assert snapshot["outcomes"] == {
        "success": 0,
        "retryable_failure": 0,
        "permanent_failure": 1,
    }
    assert usage.webhook.pending_delivery_payload_count_for_tests() == 0
    assert usage.flush_usage_events(trigger="test") == 0


def test_expired_retained_source_does_not_discard_newer_live_source(tmp_path, sync_usage_executor):
    del sync_usage_executor
    _Clock.current = datetime(2026, 9, 18, 23, 59, 59, tzinfo=UTC)
    old_source = _resource_event("retained-old", observed_at="2026-09-17T23:59:59.999Z")
    new_source = _resource_event("live-new", observed_at="2026-09-18T23:59:59.999Z")
    opened: list[bytes] = []

    def open_request(request, *, timeout):
        assert timeout == 10
        opened.append(request.data)
        if len(opened) <= 2:
            raise TimeoutError("synthetic unavailable upstream")
        return contextlib.nullcontext()

    _buffer(tmp_path, [old_source])
    with (
        patch.object(usage.webhook, "datetime", _Clock),
        patch.object(urllib.request.OpenerDirector, "open", side_effect=open_request),
        patch.object(usage.webhook.time, "sleep"),
    ):
        assert usage.flush_usage_events(trigger="test") == 1
        assert delivery_snapshot()["buffered"] == 1
        _buffer(tmp_path, [new_source])
        _Clock.current = datetime(2026, 9, 19, 0, tzinfo=UTC)
        assert usage.flush_usage_events(trigger="test") == 2
    assert len(opened) == 3
    assert opened[0] == opened[1]
    assert json.loads(opened[2])["events"] == [new_source]
    snapshot = delivery_snapshot()
    assert snapshot["buffered"] == snapshot["reports"] == 0
    assert snapshot["outcomes"] == {
        "success": 1,
        "retryable_failure": 1,
        "permanent_failure": 1,
    }
    assert usage.webhook.pending_delivery_payload_count_for_tests() == 0
