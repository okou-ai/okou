"""Shutdown owns late retry callbacks and active synchronous usage delivery."""

import threading
from concurrent.futures import Future, ThreadPoolExecutor
from unittest.mock import patch

import pytest

import mitm_addon
import usage
from tests.pending_helpers import assert_current_pending
from tests.thread_helpers import ThreadUnderTest, wait_for_event
from tests.usage_buffer_helpers import event
from tests.usage_helpers import UsageWebhookServer, install_recording_usage_timer


class _ObservedFlushOwnerLock:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.blocking_acquire_started = threading.Event()

    def acquire(self, blocking: bool = True) -> bool:
        if blocking:
            self.blocking_acquire_started.set()
        return self._lock.acquire(blocking)

    def release(self) -> None:
        self._lock.release()


def test_done_owns_retry_after_late_timer_fires_during_executor_join(
    tmp_path, fresh_usage_executor, mitm_ctx
):
    timers = install_recording_usage_timer()
    pending_path = tmp_path / "usage-pending"
    usage.set_pending_path(str(pending_path))
    release_failed_post = threading.Event()
    release_other_post = threading.Event()
    release_retry_post = threading.Event()
    executor_join_started = threading.Event()
    deliveries: list[Future] = []
    failed_server = UsageWebhookServer()
    failed_server.queue_response(500, release_event=release_failed_post)
    failed_server.queue_response(500)
    failed_server.queue_response(204, release_event=release_retry_post)
    other_server = UsageWebhookServer()
    other_server.queue_response(204, release_event=release_other_post)

    original_submit = fresh_usage_executor.submit
    original_pool_shutdown = ThreadPoolExecutor.shutdown

    def observe_submit(*args, **kwargs):
        future = original_submit(*args, **kwargs)
        deliveries.append(future)
        return future

    def observe_pool_shutdown(pool, wait=True, *, cancel_futures=False):
        # WebhookExecutor has closed admission before entering the pool join.
        executor_join_started.set()
        original_pool_shutdown(pool, wait=wait, cancel_futures=cancel_futures)

    done_thread = ThreadUnderTest(target=mitm_addon.done)
    timer_thread: ThreadUnderTest | None = None
    with (
        failed_server.run(),
        other_server.run(),
        mitm_ctx(),
        patch.object(fresh_usage_executor, "submit", side_effect=observe_submit),
        patch.object(
            ThreadPoolExecutor, "shutdown", autospec=True, side_effect=observe_pool_shutdown
        ),
    ):
        try:
            for server, run_id in ((failed_server, "failed-run"), (other_server, "other-run")):
                usage.buffer_usage_events(
                    server.url(),
                    "synthetic-token",
                    run_id,
                    [event(source_key=run_id)],
                    str(tmp_path / "proxy.jsonl"),
                )
                assert usage.flush_usage_events(trigger="runner") == 1
                assert server.wait_for_request_count(1)

            done_thread.start()
            wait_for_event(executor_join_started, timeout=2, threads=(done_thread,))
            release_failed_post.set()
            deliveries[0].result(timeout=2)

            # Cancel cannot stop a callback that has already entered. Dispatch
            # it explicitly while the other HTTP response still holds the join.
            timer_thread = ThreadUnderTest(target=timers[-1].callback, daemon=True)
            timer_thread.start()
            timer_thread.join_and_raise(timeout=2)
            assert failed_server.request_count == 2
            assert done_thread.is_alive()
            assert_current_pending(
                pending_path,
                flows=0,
                buffered=2,
                reports=1,
                flush_request_id="executor-still-draining",
            )

            release_other_post.set()
            assert failed_server.wait_for_request_count(3)
            assert done_thread.is_alive()
            release_retry_post.set()
            done_thread.join_and_raise(timeout=2)
        finally:
            release_failed_post.set()
            release_other_post.set()
            release_retry_post.set()
            if timer_thread is not None:
                timer_thread.join(timeout=3)
            done_thread.join(timeout=3)
            if timer_thread is not None:
                assert not timer_thread.is_alive()
            assert not done_thread.is_alive()

    assert failed_server.json_bodies() == [failed_server.json_bodies()[0]] * 3
    assert other_server.request_count == 1
    assert all(timer.cancelled for timer in timers)
    assert usage.webhook.pending_delivery_payload_count_for_tests() == 0
    assert_current_pending(
        pending_path, flows=0, buffered=0, reports=0, flush_request_id="done-settled"
    )


@pytest.mark.parametrize("timer_status", [204, 500])
def test_final_drain_waits_for_timer_owned_delivery(tmp_path, fresh_usage_executor, timer_status):
    owner_lock = _ObservedFlushOwnerLock()
    timers = install_recording_usage_timer(flush_owner_lock=owner_lock)
    pending_path = tmp_path / "usage-pending"
    usage.set_pending_path(str(pending_path))
    release_timer_post = threading.Event()
    server = UsageWebhookServer()
    server.queue_response(timer_status, release_event=release_timer_post)
    if timer_status == 500:
        server.queue_response(500)
        server.queue_response(204)

    # The public drain's prerequisite is a joined executor. An already-running
    # timer can still own delivery through the real synchronous fallback.
    fresh_usage_executor.shutdown(wait=True)
    drain_thread = ThreadUnderTest(target=usage.drain_usage_events_after_executor_shutdown)
    with server.run():
        usage.buffer_usage_events(
            server.url(),
            "synthetic-token",
            "timer-run",
            [event(source_key="timer-source")],
            str(tmp_path / "proxy.jsonl"),
        )
        timer_thread = ThreadUnderTest(target=timers[0].callback, daemon=True)
        try:
            timer_thread.start()
            assert server.wait_for_request_count(1)
            drain_thread.start()
            wait_for_event(
                owner_lock.blocking_acquire_started,
                timeout=2,
                threads=(timer_thread, drain_thread),
                message="final drain did not wait for active timer delivery",
            )
            assert drain_thread.is_alive()
            assert_current_pending(
                pending_path,
                flows=0,
                buffered=1,
                reports=1,
                flush_request_id="timer-still-delivering",
            )
            release_timer_post.set()
            timer_thread.join_and_raise(timeout=2)
            drain_thread.join_and_raise(timeout=2)

            expected_requests = 3 if timer_status == 500 else 1
            assert server.json_bodies() == [server.json_bodies()[0]] * expected_requests
            assert len(timers) == 1
            assert timers[0].cancelled
            assert usage.webhook.pending_delivery_payload_count_for_tests() == 0
            assert_current_pending(
                pending_path, flows=0, buffered=0, reports=0, flush_request_id="final-drain-settled"
            )
        finally:
            release_timer_post.set()
            timer_thread.join(timeout=3)
            drain_thread.join(timeout=3)
            assert not timer_thread.is_alive()
            assert not drain_thread.is_alive()
            usage.drain_usage_events_after_executor_shutdown()
