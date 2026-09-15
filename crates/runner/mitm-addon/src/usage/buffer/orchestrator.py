"""Thread-safe orchestration for usage buffer flushes."""

from __future__ import annotations

import random
import threading
import time
from collections.abc import Callable, Iterable
from typing import Protocol

from ..counters import set_buffered_usage_events
from ..webhook import WebhookDeliveryOutcome, enqueue_webhook_delivery
from .logging import (
    _elapsed_ms,
    _log_dropped_batches,
    _log_flush_summaries,
)
from .models import (
    DEFAULT_FLUSH_INTERVAL_SECONDS,
    DEFAULT_FLUSH_JITTER_RATIO,
    MAX_RETAINED_USAGE_BATCH_RETRIES,
    UsageEvent,
    UsageFlushTrigger,
    _BatchAdmissionResult,
    _BatchEnqueueError,
    _DeliveryCompletion,
    _PendingBatch,
    _PendingFlush,
    _RetainBatchesResult,
)
from .state import _UsageBufferState
from .summaries import _apply_retained_batch_counts, _build_flush_summaries

_jitter_rng = random.SystemRandom()


class _TimerHandle(Protocol):
    daemon: bool

    def start(self) -> None:
        """Start the scheduled callback."""

    def cancel(self) -> None:
        """Cancel the scheduled callback."""


_TimerFactory = Callable[[float, Callable[[], None]], _TimerHandle]
_DeliveryOutcomeCallback = Callable[[WebhookDeliveryOutcome], None]
_EnqueueWebhook = Callable[[str, str, dict, str, str, _DeliveryOutcomeCallback], bool]


def _log_shutdown_retained_batches(
    trigger: UsageFlushTrigger,
    flush_sequence: int,
    retained_batches: list[_PendingBatch],
) -> None:
    if not retained_batches or trigger != "shutdown":
        return
    _log_flush_summaries(
        "retained",
        trigger,
        flush_sequence,
        _build_flush_summaries([pending_batch.batch for pending_batch in retained_batches]),
    )


class _FlushOwnerLock(Protocol):
    def acquire(self, blocking: bool = True) -> bool:
        raise NotImplementedError

    def release(self) -> None:
        raise NotImplementedError


class UsageEventBuffer:
    """Thread-safe process-local usage report buffer."""

    def __init__(
        self,
        *,
        flush_interval_seconds: float = DEFAULT_FLUSH_INTERVAL_SECONDS,
        jitter_ratio: float = DEFAULT_FLUSH_JITTER_RATIO,
        timer_enabled: bool = True,
        timer_factory: _TimerFactory | None = None,
        enqueue_webhook: _EnqueueWebhook | None = None,
        flush_owner_lock: _FlushOwnerLock | None = None,
        max_retained_batch_retries: int = MAX_RETAINED_USAGE_BATCH_RETRIES,
    ) -> None:
        self._lock = threading.Lock()
        # Serializes snapshot/enqueue ownership. Ordinary flushes defer if busy;
        # lifecycle drains wait so their acknowledgement snapshots follow drain
        # ownership instead of only recording signal receipt.
        self._flush_owner_lock: _FlushOwnerLock = (
            flush_owner_lock if flush_owner_lock is not None else threading.Lock()
        )
        self._enqueue_webhook = enqueue_webhook
        self._state = _UsageBufferState(max_retained_batch_retries=max_retained_batch_retries)
        self._flush_interval_seconds = max(1.0, flush_interval_seconds)
        self._jitter_ratio = max(0.0, jitter_ratio)
        self._timer_enabled = timer_enabled
        self._timer_factory = timer_factory if timer_factory is not None else self._make_timer
        self._timer: _TimerHandle | None = None
        self._flush_generation = 0
        self._draining = False

    def configure(self, *, flush_interval_seconds: float) -> None:
        """Update runtime buffer settings."""
        with self._lock:
            self._flush_interval_seconds = max(1.0, flush_interval_seconds)

    def buffer_usage_events(
        self,
        url: str,
        sandbox_token: str,
        run_id: str,
        events: Iterable[UsageEvent],
        proxy_log_path: str,
        *,
        preserve_source_idempotency: bool = False,
        atomic_source_key: str | None = None,
        accepted_source_keys: set[str] | None = None,
    ) -> int:
        """Add source events, collect accepted keys when requested, and maybe flush."""
        flush_now = False
        timer_to_start: _TimerHandle | None = None
        with self._lock:
            accepted_count = self._state.add_events(
                url,
                sandbox_token,
                run_id,
                events,
                proxy_log_path,
                preserve_source_idempotency=preserve_source_idempotency,
                atomic_source_key=atomic_source_key,
                accepted_source_keys=accepted_source_keys,
            )
            if accepted_count == 0:
                timer_to_start = self._schedule_timer_if_buffered_locked()
            elif self._state.should_flush():
                flush_now = True
            else:
                timer_to_start = self._schedule_timer_locked()
            self._sync_buffered_counter_locked()

        if timer_to_start is not None:
            self._start_timer(timer_to_start)
        if flush_now:
            self._flush_usage_events(trigger="threshold")
        return accepted_count

    def flush_usage_events(self, *, trigger: UsageFlushTrigger) -> int:
        """Attempt to admit buffered webhook batches for ``trigger``.

        ``runner`` and ``shutdown`` wait for flush ownership. ``timer``,
        ``threshold``, and ``test`` defer when another invocation owns the
        flush; when timers are enabled, the buffered work remains eligible for
        a later timer.

        Return the number of webhook batches admitted by this invocation. Zero
        does not prove that the buffer is empty. Admission does not wait for
        final delivery or retained-retry completion. Non-shutdown triggers
        schedule retained work for a later timer when timers are enabled, until
        the first shutdown flush begins. Shutdown stops timer scheduling and
        leaves retained work for the final post-executor drain.
        """
        return self._flush_usage_events(trigger=trigger)

    def seen_source_idempotency_keys(self, source_keys: Iterable[str]) -> set[str]:
        """Return candidate source keys retained by admission history."""
        with self._lock:
            return self._state.seen_source_idempotency_keys(source_keys)

    def drain_usage_events_after_executor_shutdown(self) -> None:
        """Synchronously drain work retained by completed executor callbacks.

        The caller must first shut down and join the usage executor so no
        earlier asynchronous delivery can retain another batch after this
        method observes an empty schedulable state. Flush ownership also waits
        for any timer already delivering through synchronous fallback, including
        its callback and counter cleanup. New deliveries use that same fallback.
        """
        self._begin_shutdown()
        self._flush_owner_lock.acquire()
        try:
            while True:
                with self._lock:
                    if not self._state.has_schedulable_work():
                        return
                self._flush_usage_events_owned(trigger="shutdown")
        finally:
            self._flush_owner_lock.release()

    def close(self) -> None:
        """Cancel the pending timer and discard buffered usage state.

        This clears live events, retained retries, active delivery bookkeeping,
        and source idempotency keys without flushing or waiting for delivery.
        Callers that need pending usage must first stop producers and complete
        the appropriate flush and drain lifecycle, including any required
        delivery wait.

        The instance remains usable with its existing configuration, but its
        work and source idempotency state starts empty after this call.
        """
        with self._lock:
            timer = self._pop_timer_locked()
            self._state.clear()
            self._draining = False
            self._sync_buffered_counter_locked()
        if timer is not None:
            timer.cancel()

    def _flush_usage_events(self, *, trigger: UsageFlushTrigger) -> int:
        if trigger == "shutdown":
            self._begin_shutdown()
        if not self._acquire_flush_ownership(trigger):
            self._defer_unowned_flush(trigger)
            return 0

        try:
            return self._flush_usage_events_owned(trigger=trigger)
        finally:
            self._flush_owner_lock.release()

    def _begin_shutdown(self) -> None:
        # Stop callback-owned retries before waiting for an active flush or the
        # executor. Timer cancellation alone cannot stop an entered callback.
        with self._lock:
            self._draining = True
            timer = self._pop_timer_locked()
        if timer is not None:
            timer.cancel()

    def _acquire_flush_ownership(self, trigger: UsageFlushTrigger) -> bool:
        return self._flush_owner_lock.acquire(blocking=trigger in ("runner", "shutdown"))

    def _defer_unowned_flush(self, trigger: UsageFlushTrigger) -> None:
        timer_to_cancel: _TimerHandle | None = None
        timer_to_start: _TimerHandle | None = None
        with self._lock:
            if trigger == "timer":
                timer_to_cancel = self._pop_timer_locked()
            if trigger != "shutdown":
                timer_to_start = self._schedule_timer_if_buffered_locked()
            self._sync_buffered_counter_locked()
        if timer_to_cancel is not None:
            timer_to_cancel.cancel()
        if timer_to_start is not None:
            self._start_timer(timer_to_start)

    def _flush_usage_events_owned(self, *, trigger: UsageFlushTrigger) -> int:
        if trigger == "timer":
            with self._lock:
                if self._draining:
                    return 0
        flushed_batch_count = 0
        snapshot_live = True
        self._flush_generation += 1
        flush_generation = self._flush_generation
        if trigger in ("shutdown", "timer"):
            with self._lock:
                timer = self._pop_timer_locked()
            if timer is not None:
                timer.cancel()

        while True:
            timer_to_start: _TimerHandle | None = None
            with self._lock:
                pending_flush, live_snapshot_attempted = self._next_pending_flush_locked(
                    snapshot_live=snapshot_live,
                    flush_generation=flush_generation,
                )
                if live_snapshot_attempted and trigger != "shutdown":
                    snapshot_live = False
                if pending_flush is None:
                    if trigger != "shutdown":
                        timer_to_start = self._schedule_timer_if_buffered_locked()
                    self._sync_buffered_counter_locked()
                else:
                    self._state.begin_delivery(pending_flush, trigger, flush_generation)
                    self._sync_buffered_counter_locked()

            if timer_to_start is not None:
                self._start_timer(timer_to_start)
            if pending_flush is None:
                return flushed_batch_count

            started_at = time.monotonic()
            try:
                admission_result = self._enqueue_pending_flush(
                    pending_flush,
                    trigger,
                    started_at=started_at,
                )
            except _BatchEnqueueError as exc:
                duration_ms = _elapsed_ms(started_at)
                with self._lock:
                    retain_result = self._state.complete_admission(
                        pending_flush, exc.admission_result
                    )
                    timer_to_start = self._prepare_failed_flush_retention_locked(
                        trigger,
                        schedule_retry=bool(retain_result.retained_batches),
                    )
                self._finish_failed_flush_retention(
                    trigger,
                    pending_flush,
                    retain_result,
                    duration_ms,
                    exc.original,
                    timer_to_start,
                )
                raise exc.original from exc
            except Exception as exc:
                duration_ms = _elapsed_ms(started_at)
                with self._lock:
                    retain_result = self._state.fail_enqueue(pending_flush, flush_generation)
                    timer_to_start = self._prepare_failed_flush_retention_locked(
                        trigger,
                        schedule_retry=True,
                    )
                self._finish_failed_flush_retention(
                    trigger,
                    pending_flush,
                    retain_result,
                    duration_ms,
                    exc,
                    timer_to_start,
                )
                raise

            flushed_batch_count += admission_result.admitted_batch_count
            timer_to_start = None
            with self._lock:
                retain_result = self._state.complete_admission(pending_flush, admission_result)
                if retain_result.retained_batches and trigger != "shutdown":
                    timer_to_start = self._schedule_timer_if_buffered_locked()
                self._sync_buffered_counter_locked()
            if retain_result.dropped_batches:
                _log_dropped_batches(
                    trigger,
                    pending_flush.flush_sequence,
                    retain_result.dropped_batches,
                )
            if timer_to_start is not None:
                self._start_timer(timer_to_start)
            if admission_result.retained_batches:
                return flushed_batch_count

    def _prepare_failed_flush_retention_locked(
        self,
        trigger: UsageFlushTrigger,
        *,
        schedule_retry: bool,
    ) -> _TimerHandle | None:
        timer_to_start = None
        if schedule_retry and trigger != "shutdown":
            timer_to_start = self._schedule_timer_if_buffered_locked()
        self._sync_buffered_counter_locked()
        return timer_to_start

    def _finish_failed_flush_retention(
        self,
        trigger: UsageFlushTrigger,
        pending_flush: _PendingFlush,
        retain_result: _RetainBatchesResult,
        duration_ms: int,
        error: Exception,
        timer_to_start: _TimerHandle | None,
    ) -> None:
        _apply_retained_batch_counts(
            pending_flush.summaries,
            retain_result.retained_batches,
        )
        _log_flush_summaries(
            "failed",
            trigger,
            pending_flush.flush_sequence,
            pending_flush.summaries,
            duration_ms=duration_ms,
            error_type=type(error).__name__,
        )
        if retain_result.dropped_batches:
            _log_dropped_batches(
                trigger,
                pending_flush.flush_sequence,
                retain_result.dropped_batches,
            )
        _log_shutdown_retained_batches(
            trigger,
            pending_flush.flush_sequence,
            retain_result.retained_batches,
        )
        if timer_to_start is not None:
            self._start_timer(timer_to_start)

    def _enqueue_pending_flush(
        self,
        pending_flush: _PendingFlush,
        trigger: UsageFlushTrigger,
        *,
        started_at: float,
    ) -> _BatchAdmissionResult:
        _log_flush_summaries(
            "started", trigger, pending_flush.flush_sequence, pending_flush.summaries
        )
        admission_result = _enqueue_batches(
            pending_flush.batches,
            (
                self._enqueue_webhook
                if self._enqueue_webhook is not None
                else enqueue_webhook_delivery
            ),
            lambda pending_batch: self._make_delivery_outcome_callback(
                pending_flush,
                pending_batch,
                trigger,
            ),
        )
        _apply_retained_batch_counts(pending_flush.summaries, admission_result.retained_batches)
        _log_flush_summaries(
            "enqueued",
            trigger,
            pending_flush.flush_sequence,
            pending_flush.summaries,
            duration_ms=_elapsed_ms(started_at),
        )
        return admission_result

    def _make_delivery_outcome_callback(
        self,
        pending_flush: _PendingFlush,
        pending_batch: _PendingBatch,
        trigger: UsageFlushTrigger,
    ) -> _DeliveryOutcomeCallback:
        def callback(outcome: WebhookDeliveryOutcome) -> None:
            self._record_delivery_outcome(
                pending_flush,
                pending_batch,
                outcome,
                trigger,
            )

        return callback

    def _record_delivery_outcome(
        self,
        pending_flush: _PendingFlush,
        pending_batch: _PendingBatch,
        outcome: WebhookDeliveryOutcome,
        trigger: UsageFlushTrigger,
    ) -> None:
        timer_to_start: _TimerHandle | None = None
        completion: _DeliveryCompletion | None = None
        with self._lock:
            completion = self._state.record_delivery_outcome(pending_flush, pending_batch, outcome)
            if (
                completion is not None
                and completion.retained_batches
                and completion.trigger != "shutdown"
            ):
                timer_to_start = self._schedule_timer_if_buffered_locked()
            self._sync_buffered_counter_locked()

        if completion is not None and completion.retained_batches:
            _log_flush_summaries(
                "retained",
                completion.trigger,
                completion.pending_flush.flush_sequence,
                _build_flush_summaries(
                    [pending_batch.batch for pending_batch in completion.retained_batches]
                ),
            )
        if completion is not None and completion.dropped_batches:
            _log_dropped_batches(
                completion.trigger,
                completion.pending_flush.flush_sequence,
                completion.dropped_batches,
            )
        if timer_to_start is not None:
            self._start_timer(timer_to_start)

    def _start_timer(self, timer: _TimerHandle) -> None:
        try:
            timer.start()
        except Exception:
            with self._lock:
                if self._timer is timer:
                    self._timer = None
            raise

    def _sync_buffered_counter_locked(self) -> None:
        set_buffered_usage_events(self._state.buffered_source_event_count())

    def _schedule_timer_locked(self) -> _TimerHandle | None:
        if self._draining or not self._timer_enabled or self._timer is not None:
            return None
        delay = self._next_delay_seconds()
        timer = self._timer_factory(delay, self._flush_from_timer)
        timer.daemon = True
        self._timer = timer
        return timer

    def _schedule_timer_if_buffered_locked(self) -> _TimerHandle | None:
        if not self._state.has_schedulable_work():
            return None
        return self._schedule_timer_locked()

    def _pop_timer_locked(self) -> _TimerHandle | None:
        timer = self._timer
        self._timer = None
        return timer

    def _flush_from_timer(self) -> None:
        self.flush_usage_events(trigger="timer")

    def _next_delay_seconds(self) -> float:
        jitter = self._flush_interval_seconds * self._jitter_ratio
        return max(0.001, self._flush_interval_seconds + _jitter_rng.uniform(-jitter, jitter))

    def _next_pending_flush_locked(
        self, *, snapshot_live: bool, flush_generation: int
    ) -> tuple[_PendingFlush | None, bool]:
        if self._state.has_active_enqueue():
            return None, False
        if self._state.has_available_pending_flushes(flush_generation):
            timer = self._pop_timer_locked()
            if timer is not None:
                timer.cancel()
            return self._state.pop_pending_flush(flush_generation), False
        if not snapshot_live:
            return None, False
        timer = self._pop_timer_locked()
        if timer is not None:
            timer.cancel()
        return self._state.snapshot_live_flush(), True

    @staticmethod
    def _make_timer(delay: float, callback: Callable[[], None]) -> threading.Timer:
        return threading.Timer(delay, callback)


def _enqueue_batches(
    batches: list[_PendingBatch],
    enqueue_webhook: _EnqueueWebhook,
    delivery_outcome_callback: Callable[[_PendingBatch], _DeliveryOutcomeCallback],
) -> _BatchAdmissionResult:
    for index, pending_batch in enumerate(batches):
        batch = pending_batch.batch
        try:
            admitted = enqueue_webhook(
                batch.url,
                batch.sandbox_token,
                batch.payload,
                batch.proxy_log_path,
                "usage_event",
                delivery_outcome_callback(pending_batch),
            )
        except Exception as exc:
            raise _BatchEnqueueError(
                exc,
                _BatchAdmissionResult(
                    admitted_batch_count=index,
                    retained_batches=batches[index:],
                ),
            ) from exc
        if admitted is False:
            return _BatchAdmissionResult(
                admitted_batch_count=index,
                retained_batches=batches[index:],
            )
    return _BatchAdmissionResult(
        admitted_batch_count=len(batches),
        retained_batches=[],
    )
