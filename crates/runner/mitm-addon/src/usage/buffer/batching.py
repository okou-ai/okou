"""Deterministic usage webhook materialization, projection and partition bounds."""

import json
from collections.abc import Iterator

from ..idempotency import USAGE_EVENT_NAMESPACE_AGGREGATE, derive_usage_idempotency_key
from .models import (
    MAX_RESOURCE_BATCH_BYTES,
    MAX_RESOURCE_IDS_PER_BATCH,
    USAGE_EVENT_BATCH_SIZE,
    UsageEvent,
    _AggregateBucket,
    _AggregateKey,
    _BufferedSourceEvent,
    _DestinationKey,
    _FlushBatch,
    _FlushEvent,
)


def resource_event_fits(run_id: str, event: UsageEvent) -> bool:
    """Reject an oversized immutable source before it enters buffer ownership."""
    return event.get("protocol") != "x-resource-v1" or (
        len(event.get("resources", [])) <= MAX_RESOURCE_IDS_PER_BATCH
        and _payload_size(run_id, [event]) <= MAX_RESOURCE_BATCH_BYTES
    )


def _payload_size(run_id: str, events: list[UsageEvent]) -> int:
    # Keep the defaults identical to usage.webhook's actual wire serialization.
    return len(json.dumps({"runId": run_id, "events": events}).encode())


def source_event_size(event: UsageEvent) -> int:
    """Size the buffer-owned copy once; legacy batches have no resource byte cap."""
    return len(json.dumps(event).encode()) if event.get("protocol") else 0


def source_event_batches(
    source_events: list[_BufferedSourceEvent],
) -> Iterator[tuple[str, list[UsageEvent]]]:
    """Group immutable events without mixing legacy/v1 or resource UTC dates."""
    groups: dict[tuple[str, str, str], list[_BufferedSourceEvent]] = {}
    for source in source_events:
        protocol = source.event.get("protocol", "")
        day = source.event.get("observedAt", "")[:10] if protocol else ""
        groups.setdefault((source.run_id, protocol, day), []).append(source)

    for (run_id, protocol, _day), events in sorted(groups.items()):
        batch: list[UsageEvent] = []
        resource_count = 0
        empty_payload_bytes = _payload_size(run_id, []) if protocol else 0
        payload_bytes = empty_payload_bytes
        for source in events:
            event = source.event
            event_resource_count = len(event.get("resources", []))
            event_bytes = source.encoded_size
            # Default json.dumps joins array members with ", ".
            appended_bytes = event_bytes + (len(", ") if batch else 0)
            if batch and (
                len(batch) >= USAGE_EVENT_BATCH_SIZE
                or (
                    protocol == "x-resource-v1"
                    and (
                        resource_count + event_resource_count > MAX_RESOURCE_IDS_PER_BATCH
                        or payload_bytes + appended_bytes > MAX_RESOURCE_BATCH_BYTES
                    )
                )
            ):
                yield run_id, batch
                batch = []
                resource_count = 0
                payload_bytes = empty_payload_bytes
                appended_bytes = event_bytes
            batch.append(event)
            resource_count += event_resource_count
            payload_bytes += appended_bytes
        if batch:
            yield run_id, batch


def build_flush_batches(
    buffer_id: str,
    buckets: dict[_DestinationKey, dict[_AggregateKey, list[_AggregateBucket]]],
    source_events: dict[_DestinationKey, list[_BufferedSourceEvent]],
    flush_sequence: int,
) -> list[_FlushBatch]:
    """Materialize detached stores without owning mutable buffer lifecycle state."""
    batches = [
        *_build_aggregate_flush_batches(buffer_id, buckets, flush_sequence),
        *_build_source_event_flush_batches(source_events),
    ]
    batches.sort(key=_flush_batch_sort_key)
    return batches


def _build_aggregate_flush_batches(
    buffer_id: str,
    buckets: dict[_DestinationKey, dict[_AggregateKey, list[_AggregateBucket]]],
    flush_sequence: int,
) -> list[_FlushBatch]:
    batches: list[_FlushBatch] = []
    for destination in sorted(
        buckets,
        key=lambda item: (
            item.url,
            item.sandbox_token,
            item.proxy_log_path,
        ),
    ):
        events_by_run = _events_by_run(buffer_id, destination, buckets[destination], flush_sequence)
        for run_id in sorted(events_by_run):
            events = events_by_run[run_id]
            for start in range(0, len(events), USAGE_EVENT_BATCH_SIZE):
                batch_events = events[start : start + USAGE_EVENT_BATCH_SIZE]
                batches.append(
                    _FlushBatch(
                        url=destination.url,
                        sandbox_token=destination.sandbox_token,
                        payload={
                            "runId": run_id,
                            "events": [event.payload for event in batch_events],
                        },
                        proxy_log_path=destination.proxy_log_path,
                        source_event_count=sum(event.source_event_count for event in batch_events),
                    )
                )
    return batches


def _build_source_event_flush_batches(
    source_events_by_destination: dict[_DestinationKey, list[_BufferedSourceEvent]],
) -> list[_FlushBatch]:
    batches: list[_FlushBatch] = []
    for destination in sorted(
        source_events_by_destination,
        key=lambda item: (
            item.url,
            item.sandbox_token,
            item.proxy_log_path,
        ),
    ):
        for run_id, events in source_event_batches(source_events_by_destination[destination]):
            batches.append(
                _FlushBatch(
                    url=destination.url,
                    sandbox_token=destination.sandbox_token,
                    payload={
                        "runId": run_id,
                        "events": [_source_event_payload(event) for event in events],
                    },
                    proxy_log_path=destination.proxy_log_path,
                    source_event_count=len(events),
                )
            )
    return batches


def _events_by_run(
    buffer_id: str,
    destination: _DestinationKey,
    buckets: dict[_AggregateKey, list[_AggregateBucket]],
    flush_sequence: int,
) -> dict[str, list[_FlushEvent]]:
    events_by_run: dict[str, list[_FlushEvent]] = {}
    for aggregate_key in sorted(
        buckets,
        key=lambda item: (
            item.run_id,
            item.kind,
            item.provider,
            item.category,
        ),
    ):
        segments = buckets[aggregate_key]
        for segment_index, bucket in enumerate(segments):
            event = _FlushEvent(
                payload={
                    "idempotencyKey": _aggregate_idempotency_key(
                        buffer_id,
                        destination,
                        aggregate_key,
                        flush_sequence,
                        segment_index,
                    ),
                    "provider": aggregate_key.provider,
                    "category": aggregate_key.category,
                    "quantity": bucket.quantity,
                    "kind": aggregate_key.kind,
                },
                source_event_count=bucket.source_event_count,
            )
            events_by_run.setdefault(aggregate_key.run_id, []).append(event)
    return events_by_run


def _aggregate_idempotency_key(
    buffer_id: str,
    destination: _DestinationKey,
    aggregate_key: _AggregateKey,
    flush_sequence: int,
    segment_index: int,
) -> str:
    return derive_usage_idempotency_key(
        USAGE_EVENT_NAMESPACE_AGGREGATE,
        (
            buffer_id,
            str(flush_sequence),
            destination.url,
            destination.sandbox_token,
            destination.proxy_log_path,
            aggregate_key.run_id,
            aggregate_key.kind,
            aggregate_key.provider,
            aggregate_key.category,
            str(segment_index),
        ),
    )


def copy_source_event(event: UsageEvent) -> UsageEvent:
    copied: UsageEvent = {
        "idempotencyKey": event["idempotencyKey"],
        "kind": event["kind"],
        "provider": event["provider"],
        "category": event["category"],
        "quantity": event["quantity"],
    }
    if "protocol" in event:
        copied["protocol"] = event["protocol"]
    if "observedAt" in event:
        copied["observedAt"] = event["observedAt"]
    if "resources" in event:
        copied["resources"] = [resource.copy() for resource in event["resources"]]
    if "remainder" in event:
        copied["remainder"] = [item.copy() for item in event["remainder"]]
    return copied


def _source_event_payload(event: UsageEvent) -> dict:
    return dict(copy_source_event(event))


def _flush_batch_sort_key(batch: _FlushBatch) -> tuple[object, ...]:
    run_id = batch.payload.get("runId")
    return (
        batch.url,
        batch.sandbox_token,
        batch.proxy_log_path,
        run_id if isinstance(run_id, str) else "",
    )
