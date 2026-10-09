"""Tests for thread helper failure propagation."""

from __future__ import annotations

import threading
import traceback

import pytest

from tests.thread_helpers import ThreadUnderTest, wait_for_event


def test_join_and_raise_propagates_worker_assertion_with_traceback():
    def fail_in_worker() -> None:
        raise AssertionError("worker assertion failed")

    thread = ThreadUnderTest(target=fail_in_worker)
    thread.start()

    with pytest.raises(AssertionError, match="worker assertion failed") as exc_info:
        thread.join_and_raise(timeout=1)

    captured_traceback = exc_info.value.__traceback__
    assert captured_traceback is not None
    traceback_functions = [frame.name for frame in traceback.extract_tb(captured_traceback)]
    assert "fail_in_worker" in traceback_functions
    assert not thread.is_alive()


def test_raise_if_failed_reports_completed_worker_failure():
    target_signaled = threading.Event()
    release = threading.Event()

    def fail_then_signal() -> None:
        try:
            raise RuntimeError("worker failed")
        finally:
            target_signaled.set()
            release.wait()

    thread = ThreadUnderTest(target=fail_then_signal)
    try:
        thread.start()
        assert target_signaled.wait(timeout=1)
        assert thread.is_alive()
        # The target has signaled, but the wrapper has not captured its failure.
        thread.raise_if_failed()

        release.set()
        thread.join(timeout=1)
        assert not thread.is_alive()

        with pytest.raises(RuntimeError, match="worker failed"):
            thread.raise_if_failed()
    finally:
        release.set()
        thread.join(timeout=1)
        assert not thread.is_alive()


def test_wait_for_event_raises_worker_failure_before_timeout_message():
    event = threading.Event()

    def fail_without_signaling() -> None:
        raise RuntimeError("worker failed before event")

    thread = ThreadUnderTest(target=fail_without_signaling)
    thread.start()
    thread.join(timeout=1)
    assert not thread.is_alive()

    # Publish the worker failure before exercising the unset-event timeout branch.
    with pytest.raises(RuntimeError, match="worker failed before event"):
        wait_for_event(
            event,
            timeout=0,
            threads=(thread,),
            message="event was not signaled",
        )


def test_wait_for_event_raises_worker_failure_even_when_event_is_set():
    event = threading.Event()
    target_signaled = threading.Event()
    release = threading.Event()

    def signal_then_fail() -> None:
        try:
            event.set()
            raise RuntimeError("worker failed after event")
        finally:
            target_signaled.set()
            release.wait()

    thread = ThreadUnderTest(target=signal_then_fail)
    try:
        thread.start()
        assert target_signaled.wait(timeout=1)
        assert thread.is_alive()
        # An already-set event does not imply the worker failure is published.
        wait_for_event(event, timeout=1, threads=(thread,))

        release.set()
        thread.join(timeout=1)
        assert not thread.is_alive()

        with pytest.raises(RuntimeError, match="worker failed after event"):
            wait_for_event(
                event,
                timeout=1,
                threads=(thread,),
                message="event was not signaled",
            )
    finally:
        release.set()
        thread.join(timeout=1)
        assert not thread.is_alive()


def test_join_and_raise_propagates_pytest_outcome_failures():
    def fail_worker() -> None:
        pytest.fail("worker pytest failure")

    thread = ThreadUnderTest(target=fail_worker)
    thread.start()

    with pytest.raises(pytest.fail.Exception, match="worker pytest failure"):
        thread.join_and_raise(timeout=1)

    assert not thread.is_alive()


def test_join_and_raise_propagates_custom_base_exception_from_worker():
    class WorkerAbort(BaseException):
        pass

    def abort_worker() -> None:
        raise WorkerAbort("worker aborted")

    thread = ThreadUnderTest(target=abort_worker)
    thread.start()

    with pytest.raises(WorkerAbort, match="worker aborted"):
        thread.join_and_raise(timeout=1)

    assert not thread.is_alive()


def test_join_and_raise_propagates_system_exit_from_worker():
    def exit_worker() -> None:
        raise SystemExit(7)

    thread = ThreadUnderTest(target=exit_worker)
    thread.start()

    with pytest.raises(SystemExit) as exc_info:
        thread.join_and_raise(timeout=1)

    assert exc_info.value.code == 7
    assert not thread.is_alive()


def test_join_and_raise_propagates_keyboard_interrupt_from_worker():
    def interrupt_worker() -> None:
        raise KeyboardInterrupt

    thread = ThreadUnderTest(target=interrupt_worker)
    thread.start()

    with pytest.raises(KeyboardInterrupt):
        thread.join_and_raise(timeout=1)

    assert not thread.is_alive()


def test_join_and_raise_fails_when_thread_is_still_running():
    started = threading.Event()
    release = threading.Event()

    def wait_until_released() -> None:
        started.set()
        release.wait()

    thread = ThreadUnderTest(target=wait_until_released)

    try:
        thread.start()
        assert started.wait(timeout=1)

        with pytest.raises(AssertionError, match="thread did not finish before timeout"):
            thread.join_and_raise(timeout=0)
    finally:
        release.set()
        thread.join(timeout=1)

    assert not thread.is_alive()


def test_join_and_raise_fails_when_thread_was_not_started():
    thread = ThreadUnderTest(target=lambda: None)

    with pytest.raises(AssertionError, match="thread was not started"):
        thread.join_and_raise(timeout=1)


def test_wait_for_event_fails_when_worker_thread_was_not_started():
    event = threading.Event()
    thread = ThreadUnderTest(target=lambda: None)
    event.set()

    with pytest.raises(AssertionError, match="thread was not started"):
        wait_for_event(
            event,
            timeout=1,
            threads=(thread,),
            message="event was not signaled",
        )
