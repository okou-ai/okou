"""Lock-protected mutable state for the usage buffer.

State ownership
---------------
Callers hold ``UsageEventBuffer._lock`` for every state transition. Accepted
source records are represented by exactly one of these work domains:

* *Live* work is still mutable in the aggregate and source-preserving event
  stores. ``snapshot_live_flush()`` atomically replaces those stores with empty
  ones and transfers their contents to one pending flush.
* *Pending* work is a batch snapshot eligible for selection, or a retained
  snapshot waiting for a later retry. Selecting a pending flush and calling
  ``begin_delivery()`` transfers its ownership to the delivering domain.
* *Delivering* work has entered webhook admission and remains here until every
  admitted callback is resolved. Successful or permanent outcomes leave the
  state; retryable or unadmitted batches return to pending ownership unless the
  retry budget drops them.

``_seen_source_keys`` is admission history, not a work domain. Accepted source
and atomic admission keys survive flush boundaries in this process. The history
is bounded by insertion order: duplicate checks do not refresh an entry,
overflow evicts the earliest inserted keys, and ``clear()`` resets the history
along with all work domains.

Admission and callback ordering
-------------------------------
``begin_delivery()`` counts the entire pending flush before admission starts
because a delivery callback may complete synchronously inside the enqueue call.
Each callback decrements ``remaining_batch_count`` and records a retryable
outcome when applicable. Admission completion then reconciles that callback
state with the admitted prefix:

* When admitted callbacks remain unresolved, the admitted prefix stays in the
  delivering domain, ``remaining_batch_count`` becomes the number of unresolved
  admitted callbacks, and the unadmitted suffix is retained as pending work.
* When no admitted callback remains, including when no batch was admitted, the
  retryable admitted batches and unadmitted suffix are retained together and
  delivering ownership ends.

Callbacks that finish the delivering flush first remove its ownership, so later
admission reconciliation cannot retain a second copy. Retryable callbacks are
rebuilt in original batch order rather than callback-completion order.

Retry eligibility and ordering
------------------------------
A retained flush records the current flush generation and is ineligible for the
rest of that flush invocation; a later invocation has a new generation and may
select it. Pending flushes remain FIFO. Original flush batch indices preserve
same-flush order when callbacks finish out of order or retain additional
fragments later.

Each retention increments the batch's retained retry count. A batch already at
the configured maximum is dropped instead of returning to pending ownership.
Delivering work is not schedulable, and ``_active_enqueue_count`` blocks another
selection only while admission is active; after admission returns, newer live
work may be flushed while older delivery callbacks are still outstanding.

Observable count and verification
---------------------------------
``buffered_source_event_count()`` sums original source records represented by
live stores, retained pending flushes, and delivering flushes. Aggregated
batches therefore contribute their source-record count, not their payload-event
count. Admission history and active-enqueue bookkeeping are excluded.

The integration contracts for these invariants live in
``tests/test_usage_buffer_flush_failures.py``,
``tests/test_usage_buffer_timer_shutdown.py``, and
``tests/test_usage_buffer_idempotency.py``.
"""

from __future__ import annotations

import uuid
from collections import OrderedDict
from collections.abc import Iterable

from ..idempotency import USAGE_EVENT_NAMESPACE_AGGREGATE, derive_usage_idempotency_key
from ..quantities import MAX_USAGE_QUANTITY, is_usage_quantity
from ..webhook import WebhookDeliveryOutcome
from .batching import resource_event_fits, source_event_batches, source_event_size
from .logging import _log_rejected_resource_size, _log_rejected_usage_quantity
from .models import (
    MAX_AGGREGATE_BUCKETS,
    MAX_BUFFERED_SOURCE_EVENTS,
    MAX_BUFFERED_WEBHOOK_BATCHES,
    MAX_RETAINED_USAGE_BATCH_RETRIES,
    MAX_SOURCE_IDEMPOTENCY_KEYS,
    USAGE_EVENT_BATCH_SIZE,
    UsageEvent,
    UsageFlushTrigger,
    _AggregateBucket,
    _AggregateKey,
    _BatchAdmissionResult,
    _BufferedSourceEvent,
    _DeliveringFlush,
    _DeliveryCompletion,
    _DestinationKey,
    _FlushBatch,
    _FlushEvent,
    _PendingBatch,
    _PendingFlush,
    _RetainBatchesResult,
)
from .summaries import _pending_flush_from_batches, _pending_flush_from_pending_batches


class _UsageBufferState:
    """Mutable usage work state; callers must hold UsageEventBuffer._lock."""

    def __init__(
        self, *, max_retained_batch_retries: int = MAX_RETAINED_USAGE_BATCH_RETRIES
    ) -> None:
        self._max_retained_batch_retries = max_retained_batch_retries
        self._buffer_id = str(uuid.uuid4())
        self._flush_sequence = 0
        self._buckets: dict[
            _DestinationKey,
            dict[_AggregateKey, list[_AggregateBucket]],
        ] = {}
        self._source_events: dict[_DestinationKey, list[_BufferedSourceEvent]] = {}
        # Keep source and atomic admission keys across flushes so lifecycle
        # duplicates do not become distinct server-side rows.
        self._seen_source_keys: OrderedDict[str, None] = OrderedDict()
        self._source_event_count = 0
        self._active_enqueue_count = 0
        self._pending_flushes: list[_PendingFlush] = []
        self._delivering_flushes: dict[int, _DeliveringFlush] = {}

    def clear(self) -> None:
        self._buckets = {}
        self._source_events = {}
        self._seen_source_keys.clear()
        self._source_event_count = 0
        self._active_enqueue_count = 0
        self._pending_flushes = []
        self._delivering_flushes = {}

    def add_events(
        self,
        url: str,
        sandbox_token: str,
        run_id: str,
        events: Iterable[UsageEvent],
        proxy_log_path: str,
        *,
        preserve_source_idempotency: bool,
        atomic_source_key: str | None,
        accepted_source_keys: set[str] | None,
    ) -> int:
        if atomic_source_key is not None:
            events = tuple(events)
            if any(not is_usage_quantity(event["quantity"]) for event in events):
                _log_rejected_usage_quantity(proxy_log_path, run_id)
                return 0
            if any(not resource_event_fits(run_id, event) for event in events):
                _log_rejected_resource_size(proxy_log_path, run_id)
                return 0
            batch_source_keys = {event["idempotencyKey"] for event in events}
            if (
                atomic_source_key in self._seen_source_keys
                or len(batch_source_keys) != len(events)
                or any(source_key in self._seen_source_keys for source_key in batch_source_keys)
            ):
                return 0

        buckets: dict[_AggregateKey, list[_AggregateBucket]] | None = None
        source_events: list[_BufferedSourceEvent] | None = None
        destination = _DestinationKey(
            url=url,
            sandbox_token=sandbox_token,
            proxy_log_path=proxy_log_path,
        )
        accepted_count = 0
        for event in events:
            if not is_usage_quantity(event["quantity"]):
                _log_rejected_usage_quantity(proxy_log_path, run_id)
                continue
            if not resource_event_fits(run_id, event):
                _log_rejected_resource_size(proxy_log_path, run_id)
                continue
            source_key = event["idempotencyKey"]
            if source_key in self._seen_source_keys:
                continue
            self._seen_source_keys[source_key] = None
            if preserve_source_idempotency or event.get("protocol") == "x-resource-v1":
                if source_events is None:
                    source_events = self._source_events.setdefault(destination, [])
                copied = _copy_event(event)
                source_events.append(
                    _BufferedSourceEvent(
                        run_id=run_id,
                        event=copied,
                        encoded_size=source_event_size(copied),
                    )
                )
            else:
                if buckets is None:
                    buckets = self._buckets.setdefault(destination, {})
                aggregate_key = _AggregateKey(
                    run_id=run_id,
                    kind=event["kind"],
                    provider=event["provider"],
                    category=event["category"],
                )
                segments = buckets.setdefault(aggregate_key, [])
                if not segments or segments[-1].quantity + event["quantity"] > MAX_USAGE_QUANTITY:
                    segments.append(_AggregateBucket())
                bucket = segments[-1]
                bucket.quantity += event["quantity"]
                bucket.source_event_count += 1
            self._source_event_count += 1
            accepted_count += 1
            if accepted_source_keys is not None:
                accepted_source_keys.add(source_key)
        # Insert the admission key after its member keys so its bounded
        # insertion-order lifetime covers the entire group.
        if atomic_source_key is not None and accepted_count > 0:
            self._seen_source_keys[atomic_source_key] = None
        self._evict_source_keys()
        return accepted_count

    def _evict_source_keys(self) -> None:
        while len(self._seen_source_keys) > MAX_SOURCE_IDEMPOTENCY_KEYS:
            self._seen_source_keys.popitem(last=False)

    def seen_source_idempotency_keys(self, source_keys: Iterable[str]) -> set[str]:
        """Return candidate source keys retained by admission history."""
        return {source_key for source_key in source_keys if source_key in self._seen_source_keys}

    def should_flush(self) -> bool:
        if self._source_event_count >= MAX_BUFFERED_SOURCE_EVENTS:
            return True
        aggregate_bucket_count = sum(
            len(segments) for buckets in self._buckets.values() for segments in buckets.values()
        )
        if aggregate_bucket_count >= MAX_AGGREGATE_BUCKETS:
            return True
        return self._estimated_webhook_batch_count() >= MAX_BUFFERED_WEBHOOK_BATCHES

    def _estimated_webhook_batch_count(self) -> int:
        count = 0
        for buckets in self._buckets.values():
            events_by_run: dict[str, int] = {}
            for aggregate_key, segments in buckets.items():
                events_by_run[aggregate_key.run_id] = events_by_run.get(
                    aggregate_key.run_id, 0
                ) + len(segments)
            count += sum(
                (event_count + USAGE_EVENT_BATCH_SIZE - 1) // USAGE_EVENT_BATCH_SIZE
                for event_count in events_by_run.values()
            )
        for source_events in self._source_events.values():
            count += sum(1 for _ in source_event_batches(source_events))
        return count

    def has_schedulable_work(self) -> bool:
        return bool(self._pending_flushes or self._source_event_count)

    def has_active_enqueue(self) -> bool:
        return bool(self._active_enqueue_count)

    def has_available_pending_flushes(self, flush_generation: int) -> bool:
        return any(
            pending_flush.retry_after_flush_generation != flush_generation
            for pending_flush in self._pending_flushes
        )

    def pop_pending_flush(self, flush_generation: int) -> _PendingFlush:
        selected_index: int | None = None
        for index, pending_flush in enumerate(self._pending_flushes):
            if pending_flush.retry_after_flush_generation == flush_generation:
                continue
            selected_index = index
            break
        if selected_index is None:
            raise RuntimeError("no pending flush is available for this flush generation")
        pending_flush = self._pending_flushes.pop(selected_index)
        pending_flush.retry_after_flush_generation = 0
        return pending_flush

    def snapshot_live_flush(self) -> _PendingFlush | None:
        if not self._buckets and not self._source_events:
            self._source_event_count = 0
            return None

        self._flush_sequence += 1
        flush_sequence = self._flush_sequence
        buckets = self._buckets
        source_events = self._source_events
        self._buckets = {}
        self._source_events = {}
        self._source_event_count = 0
        batches = [
            *self._build_flush_batches(buckets, flush_sequence),
            *self._build_source_event_flush_batches(source_events),
        ]
        batches.sort(key=_flush_batch_sort_key)
        return _pending_flush_from_batches(flush_sequence, batches)

    def begin_delivery(
        self,
        pending_flush: _PendingFlush,
        trigger: UsageFlushTrigger,
        flush_generation: int,
    ) -> None:
        self._active_enqueue_count += 1
        self._delivering_flushes[id(pending_flush)] = _DeliveringFlush(
            pending_flush=pending_flush,
            trigger=trigger,
            flush_generation=flush_generation,
            remaining_batch_count=len(pending_flush.batches),
        )

    def complete_enqueue(self) -> None:
        self._active_enqueue_count = max(0, self._active_enqueue_count - 1)

    def fail_enqueue(
        self, pending_flush: _PendingFlush, flush_generation: int
    ) -> _RetainBatchesResult:
        if self._delivering_flushes.pop(id(pending_flush), None) is not None:
            retain_result = self._retain_batches_for_retry(
                pending_flush.flush_sequence,
                pending_flush.batches,
                flush_generation,
            )
        else:
            retain_result = _RetainBatchesResult(retained_batches=[], dropped_batches=[])
        self.complete_enqueue()
        return retain_result

    def record_delivery_outcome(
        self,
        pending_flush: _PendingFlush,
        pending_batch: _PendingBatch,
        outcome: WebhookDeliveryOutcome,
    ) -> _DeliveryCompletion | None:
        delivering_flush = self._delivering_flushes.get(id(pending_flush))
        if delivering_flush is None:
            return None

        if outcome == "retryable_failure":
            delivering_flush.retryable_batches.append(pending_batch)
        delivering_flush.remaining_batch_count -= 1
        if delivering_flush.remaining_batch_count > 0:
            return None

        del self._delivering_flushes[id(pending_flush)]
        completed_flush = delivering_flush.pending_flush
        retryable_batch_ids = {
            id(pending_batch) for pending_batch in delivering_flush.retryable_batches
        }
        retryable_batches = [
            pending_batch
            for pending_batch in completed_flush.batches
            if id(pending_batch) in retryable_batch_ids
        ]
        retain_result = self._retain_batches_for_retry(
            completed_flush.flush_sequence,
            retryable_batches,
            delivering_flush.flush_generation,
        )
        return _DeliveryCompletion(
            pending_flush=completed_flush,
            trigger=delivering_flush.trigger,
            retained_batches=retain_result.retained_batches,
            dropped_batches=retain_result.dropped_batches,
        )

    def complete_admission(
        self, pending_flush: _PendingFlush, admission_result: _BatchAdmissionResult
    ) -> _RetainBatchesResult:
        delivering_flush = self._delivering_flushes.get(id(pending_flush))
        retain_result = _RetainBatchesResult(retained_batches=[], dropped_batches=[])
        if delivering_flush is not None and admission_result.retained_batches:
            admitted_batches = pending_flush.batches[: admission_result.admitted_batch_count]
            completed_outcome_count = (
                len(pending_flush.batches) - delivering_flush.remaining_batch_count
            )
            remaining_admitted_count = (
                admission_result.admitted_batch_count - completed_outcome_count
            )
            if admitted_batches and remaining_admitted_count > 0:
                retain_result = self._retain_batches_for_retry(
                    pending_flush.flush_sequence,
                    admission_result.retained_batches,
                    delivering_flush.flush_generation,
                )
                delivering_flush.pending_flush = _pending_flush_from_pending_batches(
                    pending_flush.flush_sequence,
                    admitted_batches,
                )
                delivering_flush.remaining_batch_count = remaining_admitted_count
            else:
                retryable_batch_ids = {
                    id(pending_batch) for pending_batch in delivering_flush.retryable_batches
                }
                batches_to_retain = [
                    pending_batch
                    for index, pending_batch in enumerate(pending_flush.batches)
                    if index >= admission_result.admitted_batch_count
                    or id(pending_batch) in retryable_batch_ids
                ]
                retain_result = self._retain_batches_for_retry(
                    pending_flush.flush_sequence,
                    batches_to_retain,
                    delivering_flush.flush_generation,
                )
                del self._delivering_flushes[id(pending_flush)]
        self.complete_enqueue()
        return retain_result

    def _retain_batches_for_retry(
        self,
        flush_sequence: int,
        pending_batches: list[_PendingBatch],
        flush_generation: int,
    ) -> _RetainBatchesResult:
        retained_batches: list[_PendingBatch] = []
        dropped_batches: list[_PendingBatch] = []
        for pending_batch in pending_batches:
            if pending_batch.retained_retry_count >= self._max_retained_batch_retries:
                dropped_batches.append(pending_batch)
            else:
                retained_batches.append(
                    _PendingBatch(
                        batch=pending_batch.batch,
                        flush_batch_index=pending_batch.flush_batch_index,
                        retained_retry_count=pending_batch.retained_retry_count + 1,
                    )
                )
        if retained_batches:
            retained_flush = _pending_flush_from_pending_batches(flush_sequence, retained_batches)
            retained_flush.retry_after_flush_generation = flush_generation
            retained_batch_index = retained_flush.batches[0].flush_batch_index
            for index, pending_flush in enumerate(self._pending_flushes):
                if (
                    pending_flush.flush_sequence == retained_flush.flush_sequence
                    and pending_flush.batches[0].flush_batch_index > retained_batch_index
                ):
                    self._pending_flushes.insert(index, retained_flush)
                    break
            else:
                self._pending_flushes.append(retained_flush)
        return _RetainBatchesResult(
            retained_batches=retained_batches,
            dropped_batches=dropped_batches,
        )

    def buffered_source_event_count(self) -> int:
        return (
            self._source_event_count
            + sum(pending_flush.source_event_count for pending_flush in self._pending_flushes)
            + sum(
                delivering_flush.pending_flush.source_event_count
                for delivering_flush in self._delivering_flushes.values()
            )
        )

    def _build_flush_batches(
        self,
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
            events_by_run = self._events_by_run(destination, buckets[destination], flush_sequence)
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
                            source_event_count=sum(
                                event.source_event_count for event in batch_events
                            ),
                        )
                    )
        return batches

    def _build_source_event_flush_batches(
        self,
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
        self,
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
                        "idempotencyKey": self._aggregate_idempotency_key(
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
        self,
        destination: _DestinationKey,
        aggregate_key: _AggregateKey,
        flush_sequence: int,
        segment_index: int,
    ) -> str:
        return derive_usage_idempotency_key(
            USAGE_EVENT_NAMESPACE_AGGREGATE,
            (
                self._buffer_id,
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


def _copy_event(event: UsageEvent) -> UsageEvent:
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
    return dict(_copy_event(event))


def _flush_batch_sort_key(batch: _FlushBatch) -> tuple[object, ...]:
    run_id = batch.payload.get("runId")
    return (
        batch.url,
        batch.sandbox_token,
        batch.proxy_log_path,
        run_id if isinstance(run_id, str) else "",
    )
