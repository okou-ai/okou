"""Delivery lifetime across infrastructure failures that HTTP input cannot cause.

Use real executors and HTTP delivery; inject only the OS thread-start failure.
Weak references expose retained caller data that HTTP success cannot detect.
"""

import gc
import multiprocessing
import threading
import weakref
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from unittest.mock import patch

import pytest

import thread_pool
import usage
from tests.pending_helpers import assert_pending


class _Payload(dict):
    pass


@pytest.fixture
def observed_pools() -> Iterator[list[ThreadPoolExecutor]]:
    pools: list[ThreadPoolExecutor] = []

    class ObservedPool(ThreadPoolExecutor):
        def __init__(self, **kwargs) -> None:
            super().__init__(**kwargs)
            pools.append(self)

    # Observe the real standard-library executor, without changing submission.
    with patch.object(thread_pool, "ThreadPoolExecutor", ObservedPool):
        yield pools


@pytest.mark.parametrize("error_type", [RuntimeError, OSError])
@pytest.mark.parametrize("failed_worker", [0, 2], ids=["first-worker", "third-worker"])
def test_repeated_start_failure_releases_completed_delivery_data(
    tmp_path, usage_webhook_server, fresh_usage_executor, observed_pools, error_type, failed_worker
):
    control_root = tmp_path / "delivery-control"
    payload_refs: list[weakref.ReferenceType[_Payload]] = []
    snapshot_refs: list[weakref.ReferenceType[_Payload]] = []
    outcomes: list[tuple[int, usage.webhook.WebhookDeliveryOutcome]] = []
    start = threading.Thread.start

    def fail_start(thread: threading.Thread) -> None:
        if thread.name == f"usage-test_{failed_worker}":
            raise error_type("worker creation failed")
        start(thread)

    def enqueue(index: int) -> None:
        snapshot = _Payload(events=[{"quantity": 1}] * 100)
        payload = _Payload(runId=f"run-{index}", events=snapshot["events"])
        payload_refs.append(weakref.ref(payload))
        snapshot_refs.append(weakref.ref(snapshot))

        def on_outcome(outcome: usage.webhook.WebhookDeliveryOutcome) -> None:
            assert snapshot["events"]
            outcomes.append((index, outcome))
            assert usage.webhook.pending_delivery_payload_count_for_tests() == 1
            assert_pending(control_root, flows=0, buffered=0, reports=1)

        assert usage.webhook.enqueue_webhook_delivery(
            usage_webhook_server.url(),
            "tok",
            payload,
            "",
            "usage_event",
            on_outcome,
        )

    try:
        with patch.object(threading.Thread, "start", fail_start):
            for index in range(64):
                error_context = (
                    pytest.raises(OSError, match="worker creation failed")
                    if error_type is OSError
                    else nullcontext()
                )
                with error_context:
                    enqueue(index)
                del error_context

            expected = 0 if error_type is OSError else 64
            assert usage_webhook_server.request_count == expected
            assert outcomes == [(index, "success") for index in range(expected)]
            assert usage.webhook.pending_delivery_payload_count_for_tests() == 0
            assert_pending(control_root, flows=0, buffered=0, reports=0)
            gc.collect()
            assert all(ref() is None for ref in payload_refs)
            assert all(ref() is None for ref in snapshot_refs)

            # Queue observations are required: clearing payloads alone could
            # leave an unbounded number of empty tasks behind. Deliberately
            # retain failed pools to verify cleanup without relying on GC.
            assert observed_pools
            assert all(pool._work_queue.qsize() <= 1 for pool in observed_pools)
            assert all(not thread.is_alive() for pool in observed_pools for thread in pool._threads)
            pool_refs = [weakref.ref(pool) for pool in observed_pools]
            observed_pools.clear()
            gc.collect()
            assert all(ref() is None for ref in pool_refs)

        # Recovery must not replay completed or rolled-back work.
        enqueue(64)
        fresh_usage_executor.shutdown(wait=True)
        assert usage_webhook_server.request_count == expected + 1
        assert outcomes == [(index, "success") for index in range(expected)] + [(64, "success")]
        gc.collect()
        assert all(ref() is None for ref in payload_refs)
        assert all(ref() is None for ref in snapshot_refs)
        assert_pending(control_root, flows=0, buffered=0, reports=0)
    finally:
        fresh_usage_executor.shutdown(wait=True, cancel_futures=True)


def test_healthy_pool_preserves_capacity_and_drains_admitted_work(
    tmp_path, usage_webhook_server, fresh_usage_executor
):
    control_root = tmp_path / "delivery-control"
    release_requests = threading.Event()
    outcomes: list[usage.webhook.WebhookDeliveryOutcome] = []
    capacity = usage.webhook.MAX_PENDING_WEBHOOK_PAYLOADS
    workers = usage.webhook.USAGE_WEBHOOK_WORKERS
    for _ in range(workers):
        usage_webhook_server.queue_response(204, release_event=release_requests)

    def enqueue(index: int) -> bool:
        return usage.webhook.enqueue_webhook_delivery(
            usage_webhook_server.url(),
            "tok",
            {"runId": f"run-{index}", "events": []},
            "",
            "usage_event",
            outcomes.append,
        )

    try:
        for index in range(capacity):
            assert enqueue(index)
        assert usage_webhook_server.wait_for_request_count(workers)
        assert not enqueue(capacity)
        assert usage_webhook_server.request_count == workers
        assert usage.webhook.pending_delivery_payload_count_for_tests() == capacity
        assert_pending(control_root, flows=0, buffered=0, reports=capacity)

        fresh_usage_executor.shutdown(wait=False)
        assert outcomes == []
        assert_pending(control_root, flows=0, buffered=0, reports=capacity)
    finally:
        release_requests.set()
        fresh_usage_executor.shutdown(wait=True)

    assert {body["runId"] for body in usage_webhook_server.json_bodies()} == {
        f"run-{index}" for index in range(capacity)
    }
    assert usage_webhook_server.request_count == capacity
    assert outcomes == ["success"] * capacity
    assert usage.webhook.pending_delivery_payload_count_for_tests() == 0
    assert_pending(control_root, flows=0, buffered=0, reports=0)


def test_shutdown_before_first_delivery_uses_synchronous_fallback(
    usage_webhook_server, fresh_usage_executor
):
    outcomes: list[usage.webhook.WebhookDeliveryOutcome] = []
    caller = threading.current_thread()

    def on_outcome(outcome: usage.webhook.WebhookDeliveryOutcome) -> None:
        assert threading.current_thread() is caller
        outcomes.append(outcome)

    fresh_usage_executor.shutdown(wait=True)
    assert usage.webhook.enqueue_webhook_delivery(
        usage_webhook_server.url(), "tok", {"events": []}, "", "usage_event", on_outcome
    )
    assert usage_webhook_server.request_count == 1
    assert outcomes == ["success"]
    assert usage.webhook.pending_delivery_payload_count_for_tests() == 0


def _enqueue_during_shutdown_join(url: str) -> None:
    joining = threading.Event()
    join = threading.Thread.join
    outcomes: list[tuple[str, usage.webhook.WebhookDeliveryOutcome]] = []

    def observe_join(thread: threading.Thread, timeout: float | None = None) -> None:
        if thread.name.startswith("usage_"):
            joining.set()
        join(thread, timeout)

    def on_outcome(outcome: usage.webhook.WebhookDeliveryOutcome) -> None:
        outcomes.append(("A", outcome))
        shutdown_started = joining.wait(timeout=5)
        assert shutdown_started
        admitted = usage.webhook.enqueue_webhook_delivery(
            url,
            "tok",
            {"runId": "B", "events": []},
            "",
            "usage_event",
            lambda value: outcomes.append(("B", value)),
        )
        assert admitted

    with patch.object(threading.Thread, "join", observe_join):
        admitted = usage.webhook.enqueue_webhook_delivery(
            url, "tok", {"runId": "A", "events": []}, "", "usage_event", on_outcome
        )
        assert admitted
        usage.webhook.shutdown_delivery_executor(wait=True)
    assert outcomes == [("A", "success"), ("B", "success")]
    assert usage.webhook.pending_delivery_payload_count_for_tests() == 0


def test_shutdown_join_allows_callback_to_enqueue_again(usage_webhook_server):
    # Isolate a potential deadlock in a process so timeout can terminate all
    # executor threads. Thread.join is the real infrastructure boundary that
    # tells the callback shutdown is waiting; no scheduling sleeps are needed.
    process = multiprocessing.get_context("spawn").Process(
        target=_enqueue_during_shutdown_join,
        args=(usage_webhook_server.url(),),
        name="webhook-shutdown-reentry",
    )
    process.start()
    try:
        process.join(timeout=15)
        assert not process.is_alive(), "webhook callback deadlocked during executor shutdown"
        assert process.exitcode == 0
    finally:
        if process.is_alive():
            process.kill()
            process.join(timeout=5)
        process.close()

    assert [body["runId"] for body in usage_webhook_server.json_bodies()] == ["A", "B"]
