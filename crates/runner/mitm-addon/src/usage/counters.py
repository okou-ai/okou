"""Coherent process-local delivery observations; never a billing receipt."""

import threading
from dataclasses import dataclass
from typing import Literal

from .underbilling import log_usage_underbilling

DeliveryOutcome = Literal["success", "retryable_failure", "permanent_failure"]

_counter_lock = threading.Lock()
_buffered_usage_events = 0
_outcomes: dict[DeliveryOutcome, int] = {
    "success": 0,
    "retryable_failure": 0,
    "permanent_failure": 0,
}


@dataclass
class _PendingCounter:
    name: str
    value: int = 0
    underflow_logged: bool = False


_in_flight_flows = _PendingCounter("flows")
_buffered_reports = _PendingCounter("buffered_reports")
_pending_reports = _PendingCounter("reports")


def reset_for_tests() -> None:
    """Reset mutable counter state between tests."""
    global _buffered_usage_events
    with _counter_lock:
        for counter in (_in_flight_flows, _buffered_reports, _pending_reports):
            counter.value = 0
            counter.underflow_logged = False
        _buffered_usage_events = 0
        for outcome in _outcomes:
            _outcomes[outcome] = 0


def delivery_snapshot() -> dict[str, object]:
    """Copy outstanding work and known webhook outcomes without I/O.

    Outcomes count completed delivery attempts (including the existing HTTP
    retry cycle), not individual API attempts, source records or billable units.
    They are process-local and do not account for every pre-admission discard.
    """
    with _counter_lock:
        return {
            "flows": _in_flight_flows.value,
            "buffered": _buffered_usage_events + _buffered_reports.value,
            "reports": _pending_reports.value,
            "outcomes": dict(_outcomes),
        }


def record_delivery_outcome(outcome: DeliveryOutcome) -> None:
    with _counter_lock:
        _outcomes[outcome] += 1


def increment_in_flight_flows() -> None:
    """Track a newly admitted usage flow (call from request).

    Admission is owned by ``terminal_usage.track_flow_if_needed`` and includes
    billable model-provider and connector flows. Holding the count through
    terminal release lets terminal hooks enqueue billing events before the
    runner shutdown drain advances.
    """
    _increment_counter(_in_flight_flows)


def decrement_in_flight_flows() -> None:
    """Mark a tracked in-flight flow as complete (call from response/error)."""
    _decrement_counter(_in_flight_flows)


class _CounterLease:
    """Thread-safe one-shot ownership token for one pending counter unit."""

    def __init__(self, counter: _PendingCounter) -> None:
        self._counter = counter
        self._released = False
        self._lock = threading.Lock()

    def release(self) -> None:
        """Decrement the owned counter once and report repeated release."""
        should_release = False
        should_log = False
        with self._lock:
            if self._released:
                should_log = True
            else:
                self._released = True
                should_release = True

        if should_release:
            _decrement_counter(self._counter)
        if should_log and _mark_counter_underflow(self._counter):
            _log_counter_underflow(self._counter.name)


class PendingReportLease(_CounterLease):
    """Own the runner-visible count for one admitted webhook report.

    Release exactly once after delivery finishes or admission is rolled back.
    Concurrent or repeated release preserves other reports' counts and emits
    the process-wide ``reports`` underflow diagnostic.
    """

    def __init__(self) -> None:
        super().__init__(_pending_reports)


def admit_pending_report() -> PendingReportLease:
    _increment_counter(_pending_reports)
    return PendingReportLease()


class BufferedReportLease(_CounterLease):
    """Own the runner-visible count for one retained, unadmitted webhook report.

    Keep the lease with its report while webhook-delivery admission remains
    retryable, including when admission returns ``False``. Release it exactly
    once after delivery admits the report or after deliberate terminal discard,
    eviction, or reset.

    Premature release can let the runner shutdown drain advance before handoff.
    Failing to release the lease can hold the drain pending until its bounded
    timeout.
    """

    def __init__(self) -> None:
        super().__init__(_buffered_reports)


def admit_buffered_report() -> BufferedReportLease:
    """Count one retained report and return its terminal-release lease.

    Calling this function immediately adds the report to the retained-report
    contribution of the runner-facing aggregate ``buffered`` snapshot. The
    caller must keep the returned lease with the report while webhook-delivery
    admission returns ``False``, then release it according to the lease
    contract. A report rejected before this function is called owns no lease.
    """
    _increment_counter(_buffered_reports)
    return BufferedReportLease()


def _increment_counter(counter: _PendingCounter) -> None:
    with _counter_lock:
        counter.value += 1


def _decrement_counter(counter: _PendingCounter) -> None:
    should_log = False
    with _counter_lock:
        if counter.value > 0:
            counter.value -= 1
        else:
            should_log = _mark_counter_underflow_locked(counter)
    if should_log:
        _log_counter_underflow(counter.name)


def set_buffered_usage_events(count: int) -> None:
    global _buffered_usage_events
    with _counter_lock:
        _buffered_usage_events = max(0, count)


def _mark_counter_underflow(counter: _PendingCounter) -> bool:
    with _counter_lock:
        return _mark_counter_underflow_locked(counter)


def _mark_counter_underflow_locked(counter: _PendingCounter) -> bool:
    if counter.underflow_logged:
        return False
    counter.underflow_logged = True
    return True


def _log_counter_underflow(counter: str) -> None:
    log_usage_underbilling(
        "",
        "Usage pending counter release had no matching admission; keeping counter non-negative.",
        "usage_pending_counter_underflow",
        "risk",
        counter=counter,
    )
