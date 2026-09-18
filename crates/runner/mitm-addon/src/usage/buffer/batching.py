"""Source-preserving webhook partitions and actual encoded request bounds."""

import json
from collections.abc import Iterator

from .models import (
    MAX_RESOURCE_BATCH_BYTES,
    MAX_RESOURCE_IDS_PER_BATCH,
    USAGE_EVENT_BATCH_SIZE,
    UsageEvent,
    _BufferedSourceEvent,
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
