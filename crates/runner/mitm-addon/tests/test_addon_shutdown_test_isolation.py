"""Real shutdown tests must not close the executor owned by later tests."""

import multiprocessing
import threading
from pathlib import Path

import pytest

import usage
from tests.usage_helpers import UsageWebhookServer

_ADDON_ROOT = Path(__file__).resolve().parents[1]


def _check_executor_after_shutdown_test(node_id: str) -> None:
    original = usage.webhook.usage_executor
    caller = threading.current_thread()
    try:
        assert original.submit(threading.current_thread).result(timeout=5) is not caller
        assert pytest.main(["-q", str(_ADDON_ROOT / node_id)]) == pytest.ExitCode.OK

        # pytest.main has returned, including every fixture's teardown. A probe
        # inside the selected test would miss restoration-before-cleanup leaks.
        assert usage.webhook.usage_executor is original
        assert original.submit(threading.current_thread).result(timeout=5) is not caller

        completed = threading.Event()
        outcomes: list[tuple[usage.webhook.WebhookDeliveryOutcome, threading.Thread]] = []

        def on_outcome(outcome: usage.webhook.WebhookDeliveryOutcome) -> None:
            outcomes.append((outcome, threading.current_thread()))
            completed.set()

        payload = {"runId": "run-after-shutdown-test", "events": []}
        server = UsageWebhookServer()
        with server.run():
            assert usage.webhook.enqueue_webhook_delivery(
                server.url(), "synthetic-token", payload, "", "usage_event", on_outcome
            )
            assert completed.wait(timeout=5), "subsequent webhook delivery did not finish"
            assert server.json_bodies() == [payload]
            assert len(outcomes) == 1
            outcome, worker = outcomes[0]
            assert outcome == "success"
            assert worker is not caller, "subsequent delivery used the synchronous fallback"
    finally:
        original.shutdown(wait=True)


@pytest.mark.parametrize(
    "node_id",
    [
        pytest.param(
            "tests/test_codex_model_catalog_cache_async_validation.py::"
            "test_done_joins_catalog_validation_and_closes_admission[False]",
            id="catalog-shutdown",
        ),
        pytest.param(
            "tests/test_codex_model_catalog_cache_async_validation.py::"
            "test_done_joins_catalog_validation_and_closes_admission[True]",
            id="catalog-shutdown-after-forwarding-error",
        ),
        pytest.param(
            "tests/test_request_handler_aws_sigv4_hash_executor.py::"
            "test_done_joins_hashes_and_closes_hashing[False]",
            id="sigv4-shutdown",
        ),
        pytest.param(
            "tests/test_request_handler_aws_sigv4_hash_executor.py::"
            "test_done_joins_hashes_and_closes_hashing[True]",
            id="sigv4-shutdown-after-catalog-error",
        ),
        pytest.param(
            "tests/test_addon_configuration.py::TestAddonConfiguration::"
            "test_running_serves_status_and_log_flush",
            id="control-cleanup",
        ),
        pytest.param(
            "tests/test_addon_configuration.py::TestAddonConfiguration::"
            "test_running_can_retry_control_thread_start_failure",
            id="control-cleanup-after-start-retry",
        ),
    ],
)
def test_shutdown_test_preserves_default_executor_after_all_teardown(node_id: str) -> None:
    # Spawn rather than fork: the probe must start with its own usable original
    # executor, independent of the parent suite's test order and worker state.
    process = multiprocessing.get_context("spawn").Process(
        target=_check_executor_after_shutdown_test,
        args=(node_id,),
        name="addon-shutdown-test-isolation",
    )
    process.start()
    try:
        process.join(timeout=30)
        assert not process.is_alive(), f"shutdown test or subsequent delivery hung: {node_id}"
        assert process.exitcode == 0, f"shutdown test leaked executor lifecycle state: {node_id}"
    finally:
        if process.is_alive():
            process.kill()
            process.join(timeout=5)
        process.close()
