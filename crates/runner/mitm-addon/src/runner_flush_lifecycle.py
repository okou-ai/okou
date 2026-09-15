"""Runner-triggered usage flush lifecycle owner."""

import signal
import threading
import time
from typing import Literal

import addon_process_logging
import anthropic_accounting
import claude_output_timing
import codex_output_timing
import usage

_RunnerFlushPhase = Literal["running", "draining", "closed"]
_DeliveryFlushTrigger = Literal["runner", "shutdown"]

# Runner-triggered flush protocols:
# - Rust writes `usage-flush-request` with the active usageStateId and a fresh
#   flushRequestId, then sends SIGUSR1 to this addon process.
# - This addon flushes buffered delivery work and writes `usage-pending` with the
#   matching flushRequestId so the runner can observe a fresh snapshot.
# - Rust performs a bounded wait for the acknowledged snapshot to have zero
#   flows, buffered work, and reports before stopping the proxy.
#
# Keep this in sync with usage/counters.py and the Rust wait path in
# crates/runner/src/proxy/flush.rs plus crates/runner/src/cmd/start/mod.rs.
RUNNER_USAGE_FLUSH_SIGNAL = signal.SIGUSR1
# The signal handler must not use a lock-backed flag: it can re-enter the main
# thread while shutdown is consuming a request. CPython Boolean assignment is
# sufficient for this level-triggered flag, just as Event.is_set() was an
# unlocked read; the owner lock below still serializes flush work.
_usage_flush_requested: bool = False
_usage_flush_signal_lock = threading.Lock()
# Running workers own requests under the lock. During shutdown, drain_and_close()
# changes the phase before waiting for that lock and becomes the sole draining owner.
_runner_flush_phase: _RunnerFlushPhase = "running"


def handle_runner_usage_flush_signal(signum: int, _frame: object) -> None:
    """Schedule runner-requested flush work from the SIGUSR1 handler.

    Keep this handler minimal: it may interrupt mitmproxy's event loop, so it
    only records that work is needed and lets the background worker perform
    file I/O and usage flushing.
    """
    global _usage_flush_requested

    del signum
    if _runner_flush_phase == "closed":
        return
    _usage_flush_requested = True
    _start_usage_flush_worker()


def wait_for_runner_usage_flush_worker_to_stop_for_tests(timeout: float = 1.0) -> None:
    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise AssertionError("runner usage flush worker did not stop")

        acquired = _usage_flush_signal_lock.acquire(timeout=remaining)
        if not acquired:
            raise AssertionError("runner usage flush worker did not stop")
        try:
            if not _usage_flush_requested:
                return
        finally:
            _usage_flush_signal_lock.release()
        _start_usage_flush_worker()


def reset_runner_usage_flush_state_for_tests(timeout: float = 1.0) -> None:
    global _runner_flush_phase, _usage_flush_requested

    acquired = _usage_flush_signal_lock.acquire(timeout=timeout)
    if not acquired:
        raise AssertionError("runner usage flush worker did not stop")
    try:
        _runner_flush_phase = "running"
        _usage_flush_requested = False
    finally:
        _usage_flush_signal_lock.release()


def _start_usage_flush_worker() -> None:
    """Start one flush worker, coalescing repeated signals while active."""
    if _runner_flush_phase != "running":
        return
    if not _usage_flush_signal_lock.acquire(blocking=False):
        return
    if _runner_flush_phase != "running":
        _usage_flush_signal_lock.release()
        return

    thread = threading.Thread(
        target=_run_usage_flush_worker,
        name="runner-flush-request",
        daemon=True,
    )
    started = False
    try:
        thread.start()
        started = True
    finally:
        if not started:
            _usage_flush_signal_lock.release()


def _run_usage_flush_worker() -> None:
    """Drain coalesced runner flush requests under the worker lock.

    The request flag can be set again while a flush is running. Loop until no
    request is pending. After releasing the lock, restart for a running-phase
    signal; draining-phase requests belong to ``drain_and_close()``.
    """
    try:
        _drain_runner_usage_flush_requests()
    finally:
        _usage_flush_signal_lock.release()
        if _usage_flush_requested:
            _start_usage_flush_worker()


def _drain_runner_usage_flush_requests() -> None:
    """Drain coalesced runner requests while the caller owns the signal lock."""
    global _usage_flush_requested

    while _usage_flush_requested:
        _usage_flush_requested = False
        _flush_usage_for_runner_request()


def _flush_usage_for_runner_request() -> None:
    """Flush retained delivery work and acknowledge the runner's current request.

    The pending snapshot is written in ``finally`` so the runner can observe
    fresh counters and the current flushRequestId even if flushing fails.
    """
    flush_request_id = usage.read_usage_flush_request_id()
    try:
        _flush_delivery_work(trigger="runner")
    except Exception as exc:
        addon_process_logging.emit_addon_process_event(
            "warn",
            f"Failed to flush delivery work after runner request ({type(exc).__name__})",
        )
    finally:
        usage.write_pending_snapshot(flush_request_id=flush_request_id)


def _flush_delivery_work(*, trigger: _DeliveryFlushTrigger) -> None:
    """Admit billing work before retained diagnostic reports."""
    usage.flush_usage_events(trigger=trigger)
    _retry_retained_diagnostic_reports()


def _retry_retained_diagnostic_reports() -> None:
    """Retry every retained diagnostic source in its established order."""
    anthropic_accounting.retry_all_pending()
    claude_output_timing.retry_all_pending()
    codex_output_timing.retry_all_pending()


def drain_delivery_work_after_executor_shutdown() -> None:
    """Synchronously drain work after the usage executor has been joined.

    The caller must first shut down and join the executor so completed delivery
    callbacks cannot retain new billing work after the usage drain observes an
    empty state. New admissions then use webhook delivery's synchronous fallback.
    """
    usage.drain_usage_events_after_executor_shutdown()
    _retry_retained_diagnostic_reports()


def drain_and_close() -> None:
    """Drain accepted runner flush requests and close further admission."""
    global _runner_flush_phase

    _runner_flush_phase = "draining"
    with _usage_flush_signal_lock:
        try:
            _flush_delivery_work(trigger="shutdown")
            _drain_runner_usage_flush_requests()
        finally:
            # Close admission under the owner lock, then consume the final flag.
            _runner_flush_phase = "closed"
            _drain_runner_usage_flush_requests()
