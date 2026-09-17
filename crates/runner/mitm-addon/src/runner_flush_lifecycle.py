"""Coalesced delivery work, independent of control waiters and proxy hooks."""

import asyncio
import threading
from typing import Literal

import addon_process_logging
import anthropic_accounting
import claude_output_timing
import codex_output_timing
import usage

_condition = threading.Condition()
_closed = False
_active = False
_requested = False
_flush_failures = 0
DRAIN_TIMEOUT_SECONDS = 4.0
DRAIN_POLL_SECONDS = 0.05
FLUSH_RETRY_SECONDS = 1.0


class DeliveryControl:
    """One bounded observer on the control loop; the worker owns actual work."""

    def __init__(self) -> None:
        self._draining = False

    def flush(self) -> Literal["admitted", "coalesced", "closed"]:
        return request_flush()

    def status(self) -> dict[str, object]:
        return {**snapshot(), "drainActive": self._draining}

    async def drain(self) -> dict[str, object] | None:
        if self._draining:
            return None
        self._draining = True
        try:
            loop = asyncio.get_running_loop()
            deadline = loop.time() + DRAIN_TIMEOUT_SECONDS
            next_flush = loop.time()
            while True:
                now = loop.time()
                if now >= next_flush:
                    request_flush()
                    next_flush = now + FLUSH_RETRY_SECONDS
                state = self.status()
                if not any(
                    state[key]
                    for key in ("flows", "buffered", "reports", "workerActive", "wakePending")
                ):
                    return {"state": "quiescent", "snapshot": state}
                remaining = deadline - loop.time()
                if remaining <= 0:
                    return {"state": "deadline", "snapshot": state}
                await asyncio.sleep(min(DRAIN_POLL_SECONDS, remaining))
        finally:
            # Retiring this observer never releases the worker or API owners.
            self._draining = False


def reset_runner_usage_flush_state_for_tests(timeout: float = 1.0) -> None:
    global _closed, _requested, _flush_failures

    wait_for_runner_usage_flush_worker_to_stop_for_tests(timeout)
    with _condition:
        _closed = False
        _requested = False
        _flush_failures = 0


def wait_for_runner_usage_flush_worker_to_stop_for_tests(timeout: float = 1.0) -> None:
    with _condition:
        if not _condition.wait_for(lambda: not _active, timeout):
            raise AssertionError("runner delivery flush worker did not stop")


def request_flush() -> Literal["admitted", "coalesced", "closed"]:
    """Admit one wake, retaining at most one further wake behind the worker."""
    global _active, _requested

    with _condition:
        if _closed:
            return "closed"
        _requested = True
        if _active:
            return "coalesced"
        _active = True
        try:
            threading.Thread(target=_run_worker, name="runner-delivery", daemon=True).start()
        except Exception:
            _active = False
            _requested = False
            _condition.notify_all()
            raise
    return "admitted"


def snapshot() -> dict[str, object]:
    """Read a coherent short projection, never waiting for delivery work."""
    with _condition:
        return {
            **usage.delivery_snapshot(),
            "workerActive": _active,
            "wakePending": _requested,
            "closed": _closed,
            "flushFailures": _flush_failures,
        }


def _run_worker() -> None:
    global _active, _requested, _flush_failures

    while True:
        with _condition:
            if not _requested:
                _active = False
                _condition.notify_all()
                return
            _requested = False
        try:
            _flush_delivery_work(trigger="runner")
        except Exception as exc:
            # This boundary owns errors even after its control caller leaves.
            with _condition:
                _flush_failures += 1
            addon_process_logging.emit_addon_process_event(
                "warn", f"Failed to flush delivery work after runner request ({type(exc).__name__})"
            )


def _flush_delivery_work(*, trigger: Literal["runner", "shutdown"]) -> None:
    usage.flush_usage_events(trigger=trigger)
    _retry_retained_diagnostic_reports()


def _retry_retained_diagnostic_reports() -> None:
    anthropic_accounting.retry_all_pending()
    claude_output_timing.retry_all_pending()
    codex_output_timing.retry_all_pending()


def drain_delivery_work_after_executor_shutdown() -> None:
    """Join delivery callbacks first; their retained work now delivers synchronously."""
    usage.drain_usage_events_after_executor_shutdown()
    _retry_retained_diagnostic_reports()


def drain_and_close() -> None:
    """Close admission and join actual work before handing off to final shutdown.

    The Runner's outer process-stop deadline remains the bound for kernel/network
    stalls. Releasing this owner at a caller deadline could race executor teardown.
    """
    global _closed

    with _condition:
        _closed = True
        _condition.wait_for(lambda: not _active)
    _flush_delivery_work(trigger="shutdown")
