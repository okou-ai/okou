"""Webhook ownership across real executor failures after work is queued."""

import threading
from collections.abc import Callable, Iterator
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import contextmanager, nullcontext
from unittest.mock import patch

import pytest

import usage
from tests.pending_helpers import assert_pending

_THREAD_PREFIX = "webhook-partial-submit"


class _ObservedExecutor(ThreadPoolExecutor):
    def __init__(self, *, max_workers: int = 1) -> None:
        super().__init__(max_workers=max_workers, thread_name_prefix=_THREAD_PREFIX)
        self.returned_futures: list[Future] = []

    def submit(self, fn, /, *args, **kwargs) -> Future:
        future = super().submit(fn, *args, **kwargs)
        self.returned_futures.append(future)
        return future


@contextmanager
def _fail_worker_start(
    error: Exception,
    *,
    before_failure: Callable[[], None] | None = None,
) -> Iterator[None]:
    start = threading.Thread.start

    def start_or_fail(thread: threading.Thread) -> None:
        if thread.name.startswith(_THREAD_PREFIX):
            if before_failure is not None:
                before_failure()
            raise error
        start(thread)

    with patch.object(threading.Thread, "start", start_or_fail):
        yield


@pytest.mark.parametrize("callback_fails", [False, True])
def test_fallback_owns_delivery_after_worker_start_failure(
    tmp_path, usage_webhook_server, capsys, callback_fails
):
    control_root = tmp_path / "delivery-control"
    other_report = usage.counters.admit_pending_report()
    outcomes: list[tuple[str, usage.webhook.WebhookDeliveryOutcome]] = []

    def enqueue(run_id: str) -> bool:
        def on_outcome(outcome: usage.webhook.WebhookDeliveryOutcome) -> None:
            outcomes.append((run_id, outcome))
            assert usage.webhook.pending_delivery_payload_count_for_tests() == 1
            assert_pending(control_root, flows=0, buffered=0, reports=2)
            if callback_fails and run_id == "A":
                raise RuntimeError("callback failed")

        return usage.webhook.enqueue_webhook_delivery(
            usage_webhook_server.url(),
            "tok",
            {"runId": run_id, "events": []},
            "",
            "usage_event",
            delivery_outcome_callback=on_outcome,
        )

    try:
        with (
            _ObservedExecutor() as executor,
            patch.object(usage.webhook, "usage_executor", executor),
        ):
            error_context = (
                pytest.raises(RuntimeError, match="callback failed")
                if callback_fails
                else nullcontext()
            )
            with _fail_worker_start(RuntimeError("can't start new thread")), error_context:
                assert enqueue("A")

            assert [body["runId"] for body in usage_webhook_server.json_bodies()] == ["A"]
            assert outcomes == [("A", "success")]
            assert usage.webhook.pending_delivery_payload_count_for_tests() == 0
            assert_pending(control_root, flows=0, buffered=0, reports=1)

            # Recover worker creation and drain A's surviving work item before B.
            assert enqueue("B")
            executor.shutdown(wait=True)

            assert [body["runId"] for body in usage_webhook_server.json_bodies()] == ["A", "B"]
            assert outcomes == [("A", "success"), ("B", "success")]
            for future in executor.returned_futures:
                future.result(timeout=5)

        assert usage.webhook.pending_delivery_payload_count_for_tests() == 0
        assert_pending(control_root, flows=0, buffered=0, reports=1)
        assert "usage_pending_counter_underflow" not in capsys.readouterr().err
    finally:
        other_report.release()


def test_existing_worker_owns_delivery_before_submit_raises(tmp_path, usage_webhook_server, capsys):
    control_root = tmp_path / "delivery-control"
    other_report = usage.counters.admit_pending_report()
    worker_occupied = threading.Event()
    release_worker = threading.Event()
    callback_started = threading.Event()
    release_callback = threading.Event()
    outcomes: list[usage.webhook.WebhookDeliveryOutcome] = []

    def occupy_worker() -> None:
        worker_occupied.set()
        assert release_worker.wait(timeout=5)

    def on_outcome(outcome: usage.webhook.WebhookDeliveryOutcome) -> None:
        outcomes.append(outcome)
        if threading.current_thread().name.startswith(_THREAD_PREFIX):
            callback_started.set()
            assert release_callback.wait(timeout=5)

    def let_existing_worker_claim() -> None:
        release_worker.set()
        assert callback_started.wait(timeout=5)

    try:
        with (
            _ObservedExecutor(max_workers=2) as executor,
            patch.object(usage.webhook, "usage_executor", executor),
        ):
            try:
                executor.submit(occupy_worker)
                assert worker_occupied.wait(timeout=5)
                with _fail_worker_start(
                    RuntimeError("can't start new thread"),
                    before_failure=let_existing_worker_claim,
                ):
                    assert usage.webhook.enqueue_webhook_delivery(
                        usage_webhook_server.url(),
                        "tok",
                        {"runId": "A", "events": []},
                        "",
                        "usage_event",
                        delivery_outcome_callback=on_outcome,
                    )

                # Submission recovered while the worker still owns its callback and counters.
                assert [body["runId"] for body in usage_webhook_server.json_bodies()] == ["A"]
                assert outcomes == ["success"]
                assert usage.webhook.pending_delivery_payload_count_for_tests() == 1
                assert_pending(control_root, flows=0, buffered=0, reports=2)
            finally:
                release_worker.set()
                release_callback.set()

            executor.shutdown(wait=True)
            for future in executor.returned_futures:
                future.result(timeout=5)

        assert usage.webhook.pending_delivery_payload_count_for_tests() == 0
        assert_pending(control_root, flows=0, buffered=0, reports=1)
        assert outcomes == ["success"]
        assert "usage_pending_counter_underflow" not in capsys.readouterr().err
    finally:
        other_report.release()


def test_partial_submit_rollback_preserves_next_delivery(tmp_path, usage_webhook_server, capsys):
    control_root = tmp_path / "delivery-control"
    outcomes: list[tuple[str, usage.webhook.WebhookDeliveryOutcome]] = []

    def enqueue(run_id: str) -> bool:
        def on_outcome(outcome: usage.webhook.WebhookDeliveryOutcome) -> None:
            outcomes.append((run_id, outcome))
            assert usage.webhook.pending_delivery_payload_count_for_tests() == 1
            assert_pending(control_root, flows=0, buffered=0, reports=1)

        return usage.webhook.enqueue_webhook_delivery(
            usage_webhook_server.url(),
            "tok",
            {"runId": run_id, "events": []},
            "",
            "usage_event",
            delivery_outcome_callback=on_outcome,
        )

    with (
        _ObservedExecutor() as executor,
        patch.object(usage.webhook, "usage_executor", executor),
    ):
        with (
            _fail_worker_start(OSError("worker creation failed")),
            pytest.raises(OSError, match="worker creation failed"),
        ):
            enqueue("A")

        assert usage_webhook_server.request_count == 0
        assert outcomes == []
        assert usage.webhook.pending_delivery_payload_count_for_tests() == 0
        assert_pending(control_root, flows=0, buffered=0, reports=0)

        assert enqueue("B")
        executor.shutdown(wait=True)

        assert [body["runId"] for body in usage_webhook_server.json_bodies()] == ["B"]
        assert outcomes == [("B", "success")]
        for future in executor.returned_futures:
            future.result(timeout=5)

    assert usage.webhook.pending_delivery_payload_count_for_tests() == 0
    assert_pending(control_root, flows=0, buffered=0, reports=0)
    assert "usage_pending_counter_underflow" not in capsys.readouterr().err
