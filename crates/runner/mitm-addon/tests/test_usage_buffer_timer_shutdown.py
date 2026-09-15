"""Tests for usage-buffer timer and shutdown flush behavior."""

import json
import threading
from collections.abc import Callable

import pytest

import usage
import usage.buffer as usage_buffer
from tests.pending_helpers import assert_current_pending
from tests.thread_helpers import ThreadUnderTest, wait_for_event
from tests.usage_buffer_helpers import (
    RecordingEnqueue,
    event,
    flush_log_entries,
)
from tests.usage_helpers import RecordingTimer, install_recording_usage_timer


class _InstrumentedFlushOwnerLock:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._occupied = False
        self.acquire_modes: list[bool] = []
        self.release_call_count = 0
        self.blocking_acquire_started = threading.Event()

    def acquire(self, blocking: bool = True) -> bool:
        self.acquire_modes.append(blocking)
        if blocking:
            self.blocking_acquire_started.set()
        if self._occupied and blocking:
            raise AssertionError("test-held flush ownership must not be acquired blocking")
        return self._lock.acquire(blocking)

    def release(self) -> None:
        self.release_call_count += 1
        if self._occupied:
            raise AssertionError("test-held flush ownership must not be released")
        self._lock.release()

    def occupy(self) -> None:
        assert self._lock.acquire(blocking=False)
        self._occupied = True

    def relinquish(self) -> None:
        assert self._occupied
        self._occupied = False
        self._lock.release()


class _FalseyTimerFactory:
    def __init__(self) -> None:
        self.timers: list[RecordingTimer] = []

    def __bool__(self) -> bool:
        return False

    def __call__(self, delay: float, callback: Callable[[], None]) -> RecordingTimer:
        timer = RecordingTimer(delay, callback)
        self.timers.append(timer)
        return timer


class _FalseyFlushOwnerLock(_InstrumentedFlushOwnerLock):
    def __bool__(self) -> bool:
        return False


class _FailingRecordingTimer(RecordingTimer):
    def start(self) -> None:
        raise RuntimeError("can't start new thread")


class _BlockingFailingRecordingTimer(_FailingRecordingTimer):
    def __init__(
        self,
        delay: float,
        callback: Callable[[], None],
        *,
        start_entered: threading.Event,
        release_start: threading.Event,
    ) -> None:
        super().__init__(delay, callback)
        self._start_entered = start_entered
        self._release_start = release_start

    def start(self) -> None:
        self._start_entered.set()
        assert self._release_start.wait(timeout=1), "timer start was not released"
        super().start()


def test_usage_buffer_test_injections_accept_falsey_timer_factory_and_lock(tmp_path):
    enqueue = RecordingEnqueue()
    timer_factory = _FalseyTimerFactory()
    flush_owner_lock = _FalseyFlushOwnerLock()
    usage.reset_usage_buffer_for_tests(
        timer_enabled=True,
        timer_factory=timer_factory,
        enqueue_webhook=enqueue,
        flush_owner_lock=flush_owner_lock,
    )

    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [event(source_key="source-1", quantity=10)],
        str(tmp_path / "proxy.jsonl"),
    )

    assert len(timer_factory.timers) == 1
    assert timer_factory.timers[0].started is True
    enqueue.assert_not_called()

    timer_factory.timers[0].callback()

    enqueue.assert_called_once()
    assert enqueue.last_call.payload["runId"] == "run-1"
    assert flush_owner_lock.acquire_modes == [False]


def test_timer_flush_reschedules_when_flush_owner_is_busy(tmp_path):
    enqueue = RecordingEnqueue()
    flush_owner_lock = _InstrumentedFlushOwnerLock()
    timers = install_recording_usage_timer(
        enqueue_webhook=enqueue,
        flush_owner_lock=flush_owner_lock,
    )
    pending_path = tmp_path / "usage-pending"
    usage.set_pending_path(str(pending_path))
    usage.buffer_source_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [event(source_key="source-1", quantity=10)],
        str(tmp_path / "proxy.jsonl"),
    )

    assert len(timers) == 1
    assert timers[0].started is True

    flush_owner_lock.occupy()
    try:
        timers[0].callback()

        enqueue.assert_not_called()
        assert flush_owner_lock.acquire_modes == [False]
        assert flush_owner_lock.release_call_count == 0
        assert timers[0].cancelled is True
        assert len(timers) == 2
        assert timers[1].started is True
        assert timers[1].cancelled is False
        assert_current_pending(
            pending_path,
            flows=0,
            buffered=1,
            reports=0,
            flush_request_id="timer-owner-busy",
        )
    finally:
        flush_owner_lock.relinquish()

    timers[1].callback()

    enqueue.assert_called_once()
    assert enqueue.last_call.payload["runId"] == "run-1"
    assert enqueue.last_call.payload["events"][0]["idempotencyKey"] == "source-1"
    assert flush_owner_lock.acquire_modes == [False, False]
    assert flush_owner_lock.release_call_count == 1
    assert len(timers) == 2
    assert timers[1].cancelled is True
    assert_current_pending(
        pending_path,
        flows=0,
        buffered=0,
        reports=0,
        flush_request_id="timer-owner-retry-drained",
    )


def test_shutdown_flush_waits_for_active_timer_flush_and_drains_live_usage(tmp_path):
    flush_owner_lock = _InstrumentedFlushOwnerLock()
    timer_enqueue_started = threading.Event()
    release_timer_enqueue = threading.Event()
    shutdown_returned = threading.Event()
    shutdown_results: list[int] = []
    enqueued_runs: list[str] = []
    enqueue_call_count = 0
    pending_path = tmp_path / "usage-pending"

    def enqueue_webhook(url, sandbox_token, payload, path, log_type):
        nonlocal enqueue_call_count
        enqueue_call_count += 1
        enqueued_runs.append(payload["runId"])
        if payload["runId"] == "run-1":
            timer_enqueue_started.set()
            usage.buffer_usage_events(
                url,
                sandbox_token,
                "run-2",
                [event(source_key="source-2")],
                path,
            )
            assert len(timers) == 2
            assert release_timer_enqueue.wait(timeout=1)
        assert log_type == "usage_event"

    enqueue = RecordingEnqueue(side_effect=enqueue_webhook)
    timers = install_recording_usage_timer(
        enqueue_webhook=enqueue,
        flush_owner_lock=flush_owner_lock,
    )
    usage.set_pending_path(str(pending_path))
    proxy_log_path = str(tmp_path / "proxy.jsonl")
    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [event(source_key="source-1")],
        proxy_log_path,
    )
    assert len(timers) == 1

    def shutdown_flush():
        shutdown_results.append(usage.flush_usage_events(trigger="shutdown"))
        shutdown_returned.set()

    timer_thread = ThreadUnderTest(target=timers[0].callback)
    shutdown_thread = ThreadUnderTest(target=shutdown_flush)

    try:
        timer_thread.start()
        wait_for_event(
            timer_enqueue_started,
            timeout=1,
            threads=(timer_thread,),
            message="timer enqueue did not start",
        )

        shutdown_thread.start()
        wait_for_event(
            flush_owner_lock.blocking_acquire_started,
            timeout=1,
            threads=(timer_thread, shutdown_thread),
            message="shutdown flush did not block on the active timer flush",
        )
        assert not shutdown_returned.is_set()
        assert enqueue_call_count == 1

        release_timer_enqueue.set()
        timer_thread.join_and_raise(timeout=1)
        shutdown_thread.join_and_raise(timeout=1)

        assert not timer_thread.is_alive()
        assert not shutdown_thread.is_alive()
        assert shutdown_returned.is_set()
        assert shutdown_results == [1]
        assert enqueued_runs == ["run-1", "run-2"]
        assert len(timers) == 2
        assert timers[1].cancelled is True
        assert_current_pending(
            pending_path,
            flows=0,
            buffered=0,
            reports=0,
            flush_request_id="shutdown-wait-drained",
        )
    finally:
        release_timer_enqueue.set()
        timer_thread.join(timeout=1)
        shutdown_thread.join(timeout=1)


def test_shutdown_flush_retries_active_timer_failure_without_rescheduling_timer(tmp_path):
    flush_owner_lock = _InstrumentedFlushOwnerLock()
    first_enqueue_started = threading.Event()
    release_first_enqueue = threading.Event()
    shutdown_returned = threading.Event()
    shutdown_results: list[int] = []
    enqueued_run_ids: list[str] = []
    enqueued_idempotency_keys: list[str] = []
    timer_errors: list[str] = []
    pending_path = tmp_path / "usage-pending"

    def enqueue_webhook(url, sandbox_token, payload, path, log_type):
        del url, sandbox_token, path
        assert log_type == "usage_event"
        enqueued_run_ids.append(payload["runId"])
        enqueued_idempotency_keys.append(payload["events"][0]["idempotencyKey"])
        if len(enqueued_run_ids) == 1:
            first_enqueue_started.set()
            assert release_first_enqueue.wait(timeout=1)
            raise OSError("timer failed")

    enqueue = RecordingEnqueue(side_effect=enqueue_webhook)
    timers = install_recording_usage_timer(
        enqueue_webhook=enqueue,
        flush_owner_lock=flush_owner_lock,
    )
    usage.set_pending_path(str(pending_path))
    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [event(source_key="source-1")],
        str(tmp_path / "proxy.jsonl"),
    )
    assert len(timers) == 1

    def timer_flush():
        try:
            timers[0].callback()
        except OSError as exc:
            timer_errors.append(str(exc))

    def shutdown_flush():
        shutdown_results.append(usage.flush_usage_events(trigger="shutdown"))
        shutdown_returned.set()

    timer_thread = ThreadUnderTest(target=timer_flush)
    shutdown_thread = ThreadUnderTest(target=shutdown_flush)

    try:
        timer_thread.start()
        wait_for_event(
            first_enqueue_started,
            timeout=1,
            threads=(timer_thread,),
            message="first timer enqueue did not start",
        )

        shutdown_thread.start()
        wait_for_event(
            flush_owner_lock.blocking_acquire_started,
            timeout=1,
            threads=(timer_thread, shutdown_thread),
            message="shutdown flush did not block on the failed active timer flush",
        )
        assert not shutdown_returned.is_set()

        release_first_enqueue.set()
        timer_thread.join_and_raise(timeout=1)
        shutdown_thread.join_and_raise(timeout=1)

        assert not timer_thread.is_alive()
        assert not shutdown_thread.is_alive()
        assert timer_errors == ["timer failed"]
        assert shutdown_results == [1]
        assert enqueued_run_ids == ["run-1", "run-1"]
        assert enqueued_idempotency_keys[0] == enqueued_idempotency_keys[1]
        assert len(timers) == 1
        assert timers[0].cancelled is True
        assert_current_pending(
            pending_path,
            flows=0,
            buffered=0,
            reports=0,
            flush_request_id="shutdown-retry-drained",
        )
    finally:
        release_first_enqueue.set()
        timer_thread.join(timeout=1)
        shutdown_thread.join(timeout=1)


def test_shutdown_flush_drains_usage_deferred_by_threshold_flush_while_waiting(tmp_path):
    flush_owner_lock = _InstrumentedFlushOwnerLock()
    timer_enqueue_started = threading.Event()
    release_timer_enqueue = threading.Event()
    shutdown_returned = threading.Event()
    shutdown_results: list[int] = []
    enqueued_run_ids: list[str] = []
    pending_path = tmp_path / "usage-pending"

    def enqueue_webhook(url, sandbox_token, payload, path, log_type):
        del url, sandbox_token
        assert log_type == "usage_event"
        enqueued_run_ids.append(payload["runId"])
        if payload["runId"] == "run-1":
            timer_enqueue_started.set()
            assert release_timer_enqueue.wait(timeout=1)
        assert path.endswith("proxy.jsonl")

    enqueue = RecordingEnqueue(side_effect=enqueue_webhook)
    timers = install_recording_usage_timer(
        enqueue_webhook=enqueue,
        flush_owner_lock=flush_owner_lock,
    )
    usage.set_pending_path(str(pending_path))
    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [event(source_key="source-1")],
        str(tmp_path / "proxy.jsonl"),
    )
    assert len(timers) == 1

    def shutdown_flush():
        shutdown_results.append(usage.flush_usage_events(trigger="shutdown"))
        shutdown_returned.set()

    timer_thread = ThreadUnderTest(target=timers[0].callback)
    shutdown_thread = ThreadUnderTest(target=shutdown_flush)

    try:
        timer_thread.start()
        wait_for_event(
            timer_enqueue_started,
            timeout=1,
            threads=(timer_thread,),
            message="timer enqueue did not start",
        )

        shutdown_thread.start()
        wait_for_event(
            flush_owner_lock.blocking_acquire_started,
            timeout=1,
            threads=(timer_thread, shutdown_thread),
            message="shutdown flush did not block on the active timer flush",
        )

        usage.buffer_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-2",
            [
                event(source_key=f"source-deferred-{index}", category=f"category-{index}")
                for index in range(usage_buffer.MAX_AGGREGATE_BUCKETS)
            ],
            str(tmp_path / "proxy.jsonl"),
        )
        assert not shutdown_returned.is_set()
        assert len(timers) == 1

        release_timer_enqueue.set()
        timer_thread.join_and_raise(timeout=1)
        shutdown_thread.join_and_raise(timeout=1)

        assert not timer_thread.is_alive()
        assert not shutdown_thread.is_alive()
        assert shutdown_results == [1]
        assert enqueued_run_ids == ["run-1", "run-2"]
        assert len(timers) == 1
        assert timers[0].cancelled is True
        assert_current_pending(
            pending_path,
            flows=0,
            buffered=0,
            reports=0,
            flush_request_id="shutdown-threshold-drained",
        )
    finally:
        release_timer_enqueue.set()
        timer_thread.join(timeout=1)
        shutdown_thread.join(timeout=1)


def test_shutdown_flush_drains_live_usage_buffered_during_own_enqueue(tmp_path):
    enqueued_runs: list[str] = []
    pending_path = tmp_path / "usage-pending"

    def enqueue_webhook(url, sandbox_token, payload, path, log_type):
        enqueued_runs.append(payload["runId"])
        if payload["runId"] == "run-1":
            usage.buffer_usage_events(
                url,
                sandbox_token,
                "run-2",
                [event(source_key="source-2")],
                path,
            )
            assert len(timers) == 1
        assert log_type == "usage_event"

    enqueue = RecordingEnqueue(side_effect=enqueue_webhook)
    timers = install_recording_usage_timer(enqueue_webhook=enqueue)
    proxy_log_path = str(tmp_path / "proxy.jsonl")
    usage.set_pending_path(str(pending_path))
    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [event(source_key="source-1")],
        proxy_log_path,
    )
    assert len(timers) == 1

    assert usage.flush_usage_events(trigger="shutdown") == 2

    assert enqueued_runs == ["run-1", "run-2"]
    assert len(timers) == 1
    assert timers[0].cancelled is True
    assert_current_pending(
        pending_path,
        flows=0,
        buffered=0,
        reports=0,
        flush_request_id="shutdown-own-enqueue-drained",
    )


def test_shutdown_flush_failure_preserves_retry_without_rescheduling_timer(tmp_path):
    pending_path = tmp_path / "usage-pending"

    def fail_enqueue(url, sandbox_token, payload, path, log_type):
        del url, sandbox_token, payload, path, log_type
        raise OSError("shutdown failed")

    enqueue = RecordingEnqueue(side_effect=fail_enqueue)
    timers = install_recording_usage_timer(enqueue_webhook=enqueue)
    proxy_log_path = tmp_path / "proxy.jsonl"
    usage.set_pending_path(str(pending_path))
    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [event(source_key="source-1")],
        str(proxy_log_path),
    )
    assert len(timers) == 1

    with pytest.raises(OSError, match="shutdown failed"):
        usage.flush_usage_events(trigger="shutdown")

    assert len(timers) == 1
    assert timers[0].cancelled is True
    assert_current_pending(
        pending_path,
        flows=0,
        buffered=1,
        reports=0,
        flush_request_id="shutdown-retained",
    )
    entries = flush_log_entries(proxy_log_path)
    assert [entry["phase"] for entry in entries] == ["started", "failed", "retained"]
    failed_entry = entries[1]
    assert failed_entry["type"] == "usage_event_buffer_flush"
    assert failed_entry["retained_source_event_count"] == 1
    assert failed_entry["retained_webhook_batch_count"] == 1
    retained_entry = entries[2]
    assert retained_entry["level"] == "error"
    assert retained_entry["type"] == "usage_underbilling"
    assert retained_entry["reason"] == "shutdown_retained_without_retry"
    assert retained_entry["underbilling_class"] == "risk"
    assert retained_entry["component"] == "mitm_addon"
    assert retained_entry["source_event_count"] == 1
    assert retained_entry["webhook_batch_count"] == 1
    assert retained_entry["retained_source_event_count"] == 1
    assert retained_entry["retained_webhook_batch_count"] == 1

    enqueue.side_effect = None
    enqueue.clear()
    assert usage.flush_usage_events(trigger="test") == 1

    enqueue.assert_called_once()
    assert enqueue.last_call.payload["runId"] == "run-1"
    assert_current_pending(
        pending_path,
        flows=0,
        buffered=0,
        reports=0,
        flush_request_id="shutdown-drained",
    )


def test_shutdown_partial_enqueue_failure_retains_unfinished_without_rescheduling_timer(
    tmp_path,
):
    pending_path = tmp_path / "usage-pending"
    attempted_runs: list[str] = []

    def fail_second_batch(url, sandbox_token, payload, path, log_type):
        del url, sandbox_token, path, log_type
        attempted_runs.append(payload["runId"])
        if payload["runId"] == "run-2":
            raise OSError("shutdown second batch failed")
        return True

    enqueue = RecordingEnqueue(side_effect=fail_second_batch)
    timers = install_recording_usage_timer(enqueue_webhook=enqueue)
    proxy_log_path = tmp_path / "proxy.jsonl"
    usage.set_pending_path(str(pending_path))
    for run_id, source_key in (("run-1", "source-1"), ("run-2", "source-2")):
        usage.buffer_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            run_id,
            [event(source_key=source_key)],
            str(proxy_log_path),
        )
    assert len(timers) == 1

    with pytest.raises(OSError, match="shutdown second batch failed"):
        usage.flush_usage_events(trigger="shutdown")

    assert attempted_runs == ["run-1", "run-2"]
    assert len(timers) == 1
    assert timers[0].cancelled is True
    assert_current_pending(
        pending_path,
        flows=0,
        buffered=1,
        reports=0,
        flush_request_id="shutdown-partial-retained",
    )
    entries = flush_log_entries(proxy_log_path)
    assert [entry["phase"] for entry in entries] == ["started", "failed", "retained"]
    failed_entry = entries[1]
    assert failed_entry["type"] == "usage_event_buffer_flush"
    assert failed_entry["source_event_count"] == 2
    assert failed_entry["webhook_batch_count"] == 2
    assert failed_entry["retained_source_event_count"] == 1
    assert failed_entry["retained_webhook_batch_count"] == 1
    retained_entry = entries[2]
    assert retained_entry["level"] == "error"
    assert retained_entry["type"] == "usage_underbilling"
    assert retained_entry["trigger"] == "shutdown"
    assert retained_entry["reason"] == "shutdown_retained_without_retry"
    assert retained_entry["source_event_count"] == 1
    assert retained_entry["webhook_batch_count"] == 1
    assert retained_entry["retained_source_event_count"] == 1
    assert retained_entry["retained_webhook_batch_count"] == 1

    enqueue.side_effect = None
    enqueue.clear()
    assert usage.flush_usage_events(trigger="test") == 1

    enqueue.assert_called_once()
    assert enqueue.last_call.payload["runId"] == "run-2"
    assert_current_pending(
        pending_path,
        flows=0,
        buffered=0,
        reports=0,
        flush_request_id="shutdown-partial-drained",
    )


def test_shutdown_saturated_flush_retains_without_rescheduling_timer(tmp_path):
    pending_path = tmp_path / "usage-pending"
    proxy_log_path = tmp_path / "proxy.jsonl"
    enqueue = RecordingEnqueue(return_value=False)
    timers = install_recording_usage_timer(enqueue_webhook=enqueue)
    usage.set_pending_path(str(pending_path))
    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [event(source_key="source-1")],
        str(proxy_log_path),
    )
    assert len(timers) == 1

    assert usage.flush_usage_events(trigger="shutdown") == 0

    enqueue.assert_called_once()
    assert len(timers) == 1
    assert timers[0].cancelled is True
    assert_current_pending(
        pending_path,
        flows=0,
        buffered=1,
        reports=0,
        flush_request_id="shutdown-saturated",
    )
    retained_entries = [
        entry
        for entry in flush_log_entries(proxy_log_path)
        if entry.get("reason") == "shutdown_retained_without_retry"
    ]
    assert len(retained_entries) == 1
    assert retained_entries[0]["level"] == "error"
    assert retained_entries[0]["type"] == "usage_underbilling"
    assert retained_entries[0]["reason"] == "shutdown_retained_without_retry"
    assert retained_entries[0]["underbilling_class"] == "risk"
    assert retained_entries[0]["component"] == "mitm_addon"
    assert retained_entries[0]["trigger"] == "shutdown"
    assert retained_entries[0]["retained_source_event_count"] == 1
    assert retained_entries[0]["retained_webhook_batch_count"] == 1

    enqueue.return_value = True
    enqueue.clear()
    assert usage.flush_usage_events(trigger="test") == 1

    enqueue.assert_called_once()
    assert enqueue.last_call.payload["runId"] == "run-1"
    assert_current_pending(
        pending_path,
        flows=0,
        buffered=0,
        reports=0,
        flush_request_id="shutdown-saturated-drained",
    )


def test_timer_saturated_flush_reschedules_retry_without_real_sleep(tmp_path):
    pending_path = tmp_path / "usage-pending"
    enqueue = RecordingEnqueue(return_value=False)
    timers = install_recording_usage_timer(enqueue_webhook=enqueue)
    usage.set_pending_path(str(pending_path))
    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [event(source_key="source-1")],
        str(tmp_path / "proxy.jsonl"),
    )
    assert len(timers) == 1
    assert timers[0].started is True

    timers[0].callback()

    enqueue.assert_called_once()
    assert len(timers) == 2
    assert timers[0].cancelled is True
    assert timers[1].started is True
    assert_current_pending(
        pending_path,
        flows=0,
        buffered=1,
        reports=0,
        flush_request_id="timer-retained",
    )

    enqueue.return_value = True
    enqueue.clear()
    timers[1].callback()

    enqueue.assert_called_once()
    assert enqueue.last_call.payload["runId"] == "run-1"
    assert timers[1].cancelled is True
    assert_current_pending(
        pending_path,
        flows=0,
        buffered=0,
        reports=0,
        flush_request_id="timer-drained",
    )


def test_failed_timer_start_allows_idempotent_replay_to_reschedule(tmp_path):
    pending_path = tmp_path / "usage-pending"
    enqueue = RecordingEnqueue()
    timers: list[RecordingTimer] = []

    def timer_factory(delay: float, callback: Callable[[], None]) -> RecordingTimer:
        timer = (
            _FailingRecordingTimer(delay, callback)
            if not timers
            else RecordingTimer(delay, callback)
        )
        timers.append(timer)
        return timer

    usage.reset_usage_buffer_for_tests(
        timer_enabled=True,
        timer_factory=timer_factory,
        enqueue_webhook=enqueue,
    )
    usage.set_pending_path(str(pending_path))
    source_event = event(source_key="source-1", quantity=10)
    proxy_log_path = str(tmp_path / "proxy.jsonl")

    with pytest.raises(RuntimeError, match="can't start new thread"):
        usage.buffer_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-1",
            [source_event],
            proxy_log_path,
        )

    assert len(timers) == 1
    assert timers[0].started is False
    assert_current_pending(pending_path, flows=0, buffered=1, reports=0)

    assert (
        usage.buffer_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-1",
            [source_event],
            proxy_log_path,
        )
        == 0
    )

    assert len(timers) == 2
    assert timers[1].started is True
    enqueue.assert_not_called()

    timers[1].callback()

    enqueue.assert_called_once()
    assert enqueue.last_call.payload["events"][0]["quantity"] == 10
    assert_current_pending(pending_path, flows=0, buffered=0, reports=0)


def test_failed_retained_retry_timer_allows_idempotent_replay_to_reschedule(tmp_path):
    pending_path = tmp_path / "usage-pending"
    enqueue = RecordingEnqueue(return_value=False)
    timers: list[RecordingTimer] = []

    def timer_factory(delay: float, callback: Callable[[], None]) -> RecordingTimer:
        timer = (
            _FailingRecordingTimer(delay, callback)
            if len(timers) == 1
            else RecordingTimer(delay, callback)
        )
        timers.append(timer)
        return timer

    usage.reset_usage_buffer_for_tests(
        timer_enabled=True,
        timer_factory=timer_factory,
        enqueue_webhook=enqueue,
    )
    usage.set_pending_path(str(pending_path))
    source_event = event(source_key="source-1", quantity=10)
    proxy_log_path = str(tmp_path / "proxy.jsonl")
    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [source_event],
        proxy_log_path,
    )

    with pytest.raises(RuntimeError, match="can't start new thread"):
        timers[0].callback()

    assert len(timers) == 2
    assert timers[0].cancelled is True
    assert timers[1].started is False
    assert_current_pending(pending_path, flows=0, buffered=1, reports=0)

    enqueue.return_value = True
    enqueue.clear()
    assert (
        usage.buffer_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-1",
            [source_event],
            proxy_log_path,
        )
        == 0
    )

    assert len(timers) == 3
    assert timers[2].started is True

    timers[2].callback()

    enqueue.assert_called_once()
    assert enqueue.last_call.payload["events"][0]["quantity"] == 10
    assert_current_pending(pending_path, flows=0, buffered=0, reports=0)


def test_failed_old_timer_start_does_not_clear_newer_timer(tmp_path):
    pending_path = tmp_path / "usage-pending"
    enqueue = RecordingEnqueue()
    start_entered = threading.Event()
    release_start = threading.Event()
    timers: list[RecordingTimer] = []

    def timer_factory(delay: float, callback: Callable[[], None]) -> RecordingTimer:
        timer = (
            _BlockingFailingRecordingTimer(
                delay,
                callback,
                start_entered=start_entered,
                release_start=release_start,
            )
            if not timers
            else RecordingTimer(delay, callback)
        )
        timers.append(timer)
        return timer

    usage.reset_usage_buffer_for_tests(
        timer_enabled=True,
        timer_factory=timer_factory,
        enqueue_webhook=enqueue,
    )
    usage.set_pending_path(str(pending_path))
    proxy_log_path = str(tmp_path / "proxy.jsonl")

    def buffer_first_event() -> None:
        usage.buffer_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-1",
            [event(source_key="source-1")],
            proxy_log_path,
        )

    buffer_thread = ThreadUnderTest(target=buffer_first_event)
    buffer_thread.start()
    wait_for_event(start_entered, timeout=1, threads=[buffer_thread])

    try:
        assert usage.flush_usage_events(trigger="test") == 1
        enqueue.clear()
        usage.buffer_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-1",
            [event(source_key="source-2")],
            proxy_log_path,
        )
        assert len(timers) == 2
        assert timers[1].started is True
    finally:
        release_start.set()
        buffer_thread.join(timeout=1)

    assert buffer_thread.is_alive() is False
    with pytest.raises(RuntimeError, match="can't start new thread"):
        buffer_thread.raise_if_failed()

    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [event(source_key="source-3")],
        proxy_log_path,
    )

    assert len(timers) == 2

    timers[1].callback()

    enqueue.assert_called_once()
    assert enqueue.last_call.payload["events"][0]["quantity"] == 2
    assert_current_pending(pending_path, flows=0, buffered=0, reports=0)


def test_timer_flush_uses_scheduled_callback_without_real_sleep(tmp_path):
    enqueue = RecordingEnqueue()
    timers = install_recording_usage_timer(enqueue_webhook=enqueue)

    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [event(source_key="source-1", quantity=10)],
        str(tmp_path / "proxy.jsonl"),
    )

    assert len(timers) == 1
    assert timers[0].started is True
    assert 24 <= timers[0].delay <= 36
    enqueue.assert_not_called()

    timers[0].callback()

    enqueue.assert_called_once()
    assert timers[0].cancelled is True
    assert enqueue.last_call.payload["events"][0]["quantity"] == 10


def test_timer_flush_failure_reschedules_retry_without_real_sleep(tmp_path):
    pending_path = tmp_path / "usage-pending"

    def fail_enqueue(url, sandbox_token, payload, path, log_type):
        del url, sandbox_token, payload, path, log_type
        raise OSError("no threads")

    enqueue = RecordingEnqueue(side_effect=fail_enqueue)
    timers = install_recording_usage_timer(enqueue_webhook=enqueue)
    usage.set_pending_path(str(pending_path))

    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [event(source_key="source-1", quantity=10)],
        str(tmp_path / "proxy.jsonl"),
    )

    assert len(timers) == 1
    assert timers[0].started is True

    with pytest.raises(OSError, match="no threads"):
        timers[0].callback()

    assert timers[0].cancelled is True
    assert len(timers) == 2
    assert timers[1].started is True
    assert timers[1].cancelled is False
    assert_current_pending(
        pending_path,
        flows=0,
        buffered=1,
        reports=0,
        flush_request_id="timer-failure-retained",
    )


def test_timer_delivery_failure_after_enqueue_reschedules_retry(tmp_path):
    callbacks: list[Callable[[usage.webhook.WebhookDeliveryOutcome], None]] = []
    enqueued_keys: list[str] = []
    pending_path = tmp_path / "usage-pending"

    def enqueue_webhook(url, sandbox_token, payload, path, delivery_log_type, delivery_callback):
        del url, sandbox_token, path
        assert delivery_log_type == "usage_event"
        enqueued_keys.append(payload["events"][0]["idempotencyKey"])
        if len(enqueued_keys) == 1:
            callbacks.append(delivery_callback)
        else:
            delivery_callback("success")
        return True

    timers = install_recording_usage_timer(enqueue_webhook=enqueue_webhook)
    usage.set_pending_path(str(pending_path))
    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-1",
        [event(source_key="source-1", quantity=10)],
        str(tmp_path / "proxy.jsonl"),
    )

    timers[0].callback()

    assert len(callbacks) == 1
    assert len(timers) == 1
    assert_current_pending(
        pending_path,
        flows=0,
        buffered=1,
        reports=0,
        flush_request_id="timer-delivering",
    )
    callbacks[0]("retryable_failure")

    assert_current_pending(
        pending_path,
        flows=0,
        buffered=1,
        reports=0,
        flush_request_id="timer-delivery-retained",
    )
    assert len(timers) == 2
    assert timers[1].started is True
    assert timers[1].cancelled is False

    timers[1].callback()

    assert enqueued_keys == [enqueued_keys[0], enqueued_keys[0]]
    assert_current_pending(
        pending_path,
        flows=0,
        buffered=0,
        reports=0,
        flush_request_id="timer-delivery-drained",
    )


def test_timer_delivery_retry_budget_exhaustion_drops_retained_usage(tmp_path):
    pending_path = tmp_path / "usage-pending"
    proxy_log_path = tmp_path / "proxy.jsonl"
    usage.set_pending_path(str(pending_path))

    def enqueue_retryable_failure(
        url: str,
        sandbox_token: str,
        payload: dict,
        path: str,
        log_type: str,
        delivery_outcome_callback: Callable[[usage.webhook.WebhookDeliveryOutcome], None],
    ) -> bool:
        del url, sandbox_token, payload, path
        assert log_type == "usage_event"
        delivery_outcome_callback("retryable_failure")
        return True

    timers = install_recording_usage_timer(
        enqueue_webhook=enqueue_retryable_failure,
        max_retained_batch_retries=1,
    )
    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "secret-token",
        "run-1",
        [event(source_key="source-1", quantity=10)],
        str(proxy_log_path),
    )

    timers[0].callback()

    assert_current_pending(
        pending_path,
        flows=0,
        buffered=1,
        reports=0,
        flush_request_id="retained",
    )
    assert len(timers) == 2
    assert timers[1].started is True

    timers[1].callback()

    assert_current_pending(
        pending_path,
        flows=0,
        buffered=0,
        reports=0,
        flush_request_id="request-1",
    )
    assert len(timers) == 2
    entries = flush_log_entries(proxy_log_path)
    dropped_entries = [entry for entry in entries if entry["phase"] == "dropped"]
    assert len(dropped_entries) == 1
    assert dropped_entries[0]["level"] == "error"
    assert dropped_entries[0]["type"] == "usage_underbilling"
    assert dropped_entries[0]["reason"] == "retry_budget_exhausted"
    assert dropped_entries[0]["underbilling_class"] == "confirmed"
    assert dropped_entries[0]["component"] == "mitm_addon"
    assert dropped_entries[0]["source_event_count"] == 1
    assert dropped_entries[0]["dropped_source_event_count"] == 1
    assert dropped_entries[0]["dropped_webhook_batch_count"] == 1
    assert dropped_entries[0]["retained_retry_count"] == 1
    assert "secret-token" not in str(dropped_entries)


def test_shutdown_saturated_retry_budget_exhaustion_drops_without_rescheduling_timer(
    tmp_path,
):
    pending_path = tmp_path / "usage-pending"
    proxy_log_path = tmp_path / "proxy.jsonl"

    enqueue = RecordingEnqueue(return_value=False)
    timers = install_recording_usage_timer(
        enqueue_webhook=enqueue,
        max_retained_batch_retries=1,
    )
    usage.set_pending_path(str(pending_path))
    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "secret-token",
        "run-1",
        [event(source_key="source-1")],
        str(proxy_log_path),
    )

    assert usage.flush_usage_events(trigger="shutdown") == 0
    assert len(timers) == 1
    assert timers[0].cancelled is True
    assert_current_pending(
        pending_path,
        flows=0,
        buffered=1,
        reports=0,
        flush_request_id="shutdown-retry-retained",
    )

    enqueue.clear()
    assert usage.flush_usage_events(trigger="shutdown") == 0

    enqueue.assert_called_once()
    assert len(timers) == 1
    assert_current_pending(
        pending_path,
        flows=0,
        buffered=0,
        reports=0,
        flush_request_id="shutdown-retry-dropped",
    )
    dropped_entries = [
        entry for entry in flush_log_entries(proxy_log_path) if entry["phase"] == "dropped"
    ]
    assert len(dropped_entries) == 1
    assert dropped_entries[0]["level"] == "error"
    assert dropped_entries[0]["type"] == "usage_underbilling"
    assert dropped_entries[0]["trigger"] == "shutdown"
    assert dropped_entries[0]["reason"] == "retry_budget_exhausted"
    assert dropped_entries[0]["underbilling_class"] == "confirmed"
    assert dropped_entries[0]["component"] == "mitm_addon"


def test_shutdown_retry_exhaustion_logs_underbilling_without_proxy_log_path(mitm_ctx):
    enqueue = RecordingEnqueue(return_value=False)
    install_recording_usage_timer(
        enqueue_webhook=enqueue,
        max_retained_batch_retries=1,
    )
    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "secret-token",
        "run-1",
        [event(source_key="source-1")],
        "",
    )

    with mitm_ctx() as log:
        assert usage.flush_usage_events(trigger="shutdown") == 0
        enqueue.clear()
        assert usage.flush_usage_events(trigger="shutdown") == 0

    fields = [call.args[1] for call in log.error.call_args_list]
    assert any(
        field["type"] == "usage_underbilling"
        and field["reason"] == "shutdown_retained_without_retry"
        and field["underbilling_class"] == "risk"
        and field["component"] == "mitm_addon"
        for field in fields
    )
    assert any(
        field["type"] == "usage_underbilling"
        and field["reason"] == "retry_budget_exhausted"
        and field["underbilling_class"] == "confirmed"
        and field["component"] == "mitm_addon"
        for field in fields
    )
    assert all("secret-token" not in json.dumps(field) for field in fields)


def test_threshold_flush_cancels_scheduled_timer_and_allows_reschedule(tmp_path):
    enqueue = RecordingEnqueue()
    timers = install_recording_usage_timer(enqueue_webhook=enqueue)

    for index in range(usage_buffer.MAX_BUFFERED_WEBHOOK_BATCHES - 1):
        usage.buffer_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            f"run-{index}",
            [event(source_key=f"source-{index}")],
            str(tmp_path / "proxy.jsonl"),
        )

    assert len(timers) == 1
    assert timers[0].started is True
    assert timers[0].cancelled is False
    enqueue.assert_not_called()

    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-threshold",
        [event(source_key="source-threshold")],
        str(tmp_path / "proxy.jsonl"),
    )

    assert timers[0].cancelled is True
    assert enqueue.call_count == usage_buffer.MAX_BUFFERED_WEBHOOK_BATCHES

    usage.buffer_usage_events(
        "https://api.test/api/webhooks/agent/usage-event",
        "token-a",
        "run-next",
        [event(source_key="source-next")],
        str(tmp_path / "proxy.jsonl"),
    )

    assert len(timers) == 2
    assert timers[1].started is True
    assert timers[1].cancelled is False
