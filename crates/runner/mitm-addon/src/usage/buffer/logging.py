"""Proxy-log helpers for usage buffer flushes.

Most flush summaries are ordinary ``usage_event_buffer_flush`` records, but
retained or dropped batches can be billing-impacting underbilling signals:

- ``started`` marks enqueue/admission start.
- ``enqueued`` marks enqueue/admission completion and may include retained
  counters for batches kept for retry.
- ``failed`` marks an enqueue/admission exception and logs at error level.
- ``retained`` marks asynchronous delivery outcomes kept for retry.
- ``dropped`` marks retained batches whose retry budget was exhausted.

For permanent billing webhook delivery failures (for example, HTTP 400),
operators should inspect error-level ``usage_event`` webhook records in the
run's proxy log. These outcomes do not emit ``phase=failed`` flush summaries
and are not retained for retry or reported as retry-budget drops.

Dropped retained billing batches always emit ``usage_underbilling`` with
``reason=retry_budget_exhausted`` and ``underbilling_class=confirmed``.
Shutdown-retained billing batches emit ``usage_underbilling`` with
``reason=shutdown_retained_without_retry`` and ``underbilling_class=risk``.
Failed shutdown admission remains an ordinary error record; its separate
retained-only summary emits the shutdown underbilling signal.

Operators should use ``retained_source_event_count`` and
``retained_webhook_batch_count`` for retained work, and
``dropped_source_event_count`` and ``dropped_webhook_batch_count`` for confirmed
drops. Dropped retained batches also include ``retained_retry_count``. When no
proxy log path exists, ordinary flush records are skipped. Billing underbilling
uses its generic process event.
"""

from __future__ import annotations

import time
from collections.abc import Iterable
from typing import Literal

from logging_utils import log_proxy_entry

from ..underbilling import log_usage_underbilling
from .models import (
    UsageFlushTrigger,
    _FlushSummary,
    _PendingBatch,
)
from .summaries import _build_flush_summaries

type _UsageFlushPhase = Literal["started", "enqueued", "failed", "retained", "dropped"]

_RETRY_BUDGET_EXHAUSTED_REASON = "retry_budget_exhausted"
_SHUTDOWN_RETAINED_WITHOUT_RETRY_REASON = "shutdown_retained_without_retry"
_USAGE_QUANTITY_OUT_OF_RANGE_REASON = "usage_quantity_out_of_range"


def _log_rejected_resource_size(proxy_log_path: str, run_id: str) -> None:
    log_usage_underbilling(
        proxy_log_path,
        "Immutable X resource event exceeds webhook bounds",
        "x_resource_event_too_large",
        "confirmed",
        run_id=run_id,
        log_type="usage_event",
    )


def _log_rejected_usage_quantity(
    proxy_log_path: str,
    run_id: str,
) -> None:
    log_usage_underbilling(
        proxy_log_path,
        "Usage event rejected outside exact-integer range",
        _USAGE_QUANTITY_OUT_OF_RANGE_REASON,
        "confirmed",
        run_id=run_id,
        log_type="usage_event",
    )


def _log_dropped_batches(
    trigger: UsageFlushTrigger,
    flush_sequence: int,
    dropped_batches: list[_PendingBatch],
) -> None:
    if not dropped_batches:
        return
    _log_flush_summaries(
        "dropped",
        trigger,
        flush_sequence,
        _build_flush_summaries([pending_batch.batch for pending_batch in dropped_batches]),
        retained_retry_count=max(
            pending_batch.retained_retry_count for pending_batch in dropped_batches
        ),
    )


def _log_flush_summaries(
    phase: _UsageFlushPhase,
    trigger: UsageFlushTrigger,
    flush_sequence: int,
    summaries: Iterable[_FlushSummary],
    *,
    duration_ms: int | None = None,
    error_type: str | None = None,
    retained_retry_count: int | None = None,
) -> None:
    for summary in summaries:
        retained_webhook_batch_count = summary.retained_webhook_batch_count
        retained_source_event_count = summary.retained_source_event_count
        if phase == "retained":
            retained_webhook_batch_count = summary.webhook_batch_count
            retained_source_event_count = summary.source_event_count
        extra: dict[str, object] = {
            "type": "usage_event_buffer_flush",
            "phase": phase,
            "trigger": trigger,
            "flush_sequence": flush_sequence,
            "source_event_count": summary.source_event_count,
            "aggregate_event_count": summary.aggregate_event_count,
            "webhook_batch_count": summary.webhook_batch_count,
            "dropped_webhook_batch_count": summary.dropped_webhook_batch_count,
            "retained_webhook_batch_count": retained_webhook_batch_count,
            "retained_source_event_count": retained_source_event_count,
            "run_count": len(summary.run_ids),
            "destination_count": len(summary.destinations),
        }
        if phase == "dropped":
            extra["dropped_webhook_batch_count"] = summary.webhook_batch_count
            extra["dropped_source_event_count"] = summary.source_event_count
        if duration_ms is not None:
            extra["duration_ms"] = duration_ms
        if error_type is not None:
            extra["error_type"] = error_type
        if phase == "dropped":
            extra["reason"] = _RETRY_BUDGET_EXHAUSTED_REASON
        if retained_retry_count is not None:
            extra["retained_retry_count"] = retained_retry_count
        level = "error" if phase == "failed" else "info"
        message = f"Usage event buffer flush {phase}"
        if phase == "retained":
            message = "Usage event buffer flush retained for retry"
        elif phase == "dropped":
            level = "error"
            message = "Usage event buffer flush dropped retained batches"
        elif phase == "enqueued" and summary.retained_webhook_batch_count:
            message = "Usage event buffer flush retained webhook batches for retry"
        if phase == "dropped":
            log_usage_underbilling(
                summary.proxy_log_path,
                message,
                _RETRY_BUDGET_EXHAUSTED_REASON,
                "confirmed",
                **extra,
            )
            continue
        if (
            phase in ("enqueued", "retained")
            and trigger == "shutdown"
            and retained_webhook_batch_count
        ):
            message = "Usage event buffer retained shutdown batches without retry"
            log_usage_underbilling(
                summary.proxy_log_path,
                message,
                _SHUTDOWN_RETAINED_WITHOUT_RETRY_REASON,
                "risk",
                **extra,
            )
            continue
        if not summary.proxy_log_path:
            continue
        log_proxy_entry(
            summary.proxy_log_path,
            level,
            message,
            **extra,
        )


def _elapsed_ms(started_at: float) -> int:
    return max(0, int((time.monotonic() - started_at) * 1000))
