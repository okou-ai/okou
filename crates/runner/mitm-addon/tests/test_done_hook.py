"""Tests for mitm addon shutdown hooks."""

import threading
from collections.abc import Callable
from unittest.mock import MagicMock, patch

import pytest

import mitm_addon
import runner_flush_lifecycle
import usage
from tests.pending_helpers import assert_pending
from tests.thread_helpers import ThreadUnderTest, wait_for_event
from tests.usage_buffer_helpers import RecordingEnqueue, event, flush_log_entries
from tests.usage_helpers import UsageWebhookServer, install_recording_usage_timer


class TestDoneHook:
    """Tests for the done() graceful shutdown hook."""

    def test_done_shuts_down_executor(self):
        """done() should call shutdown(wait=True) on the executor."""
        mock_executor = MagicMock()
        with (
            patch.object(usage, "flush_usage_events") as flush_usage_events,
            patch.object(usage.webhook, "usage_executor", mock_executor),
            patch.object(
                mitm_addon.auth_base_forwarder,
                "shutdown_forward_request_workers",
            ) as shutdown_forward_request_workers,
            patch.object(mitm_addon, "shutdown_log_writer") as shutdown_log_writer,
        ):
            mitm_addon.done()
        flush_usage_events.assert_called_once_with(trigger="shutdown")
        # concurrent.futures boundary: done() must gracefully shut down the pool (#9991).
        mock_executor.shutdown.assert_called_once_with(wait=True)
        shutdown_forward_request_workers.assert_called_once_with(wait=False)
        shutdown_log_writer.assert_called_once_with()

    @pytest.mark.parametrize(
        ("failure_point", "expected_calls"),
        [
            pytest.param(
                "initial-flush",
                (
                    "usage-executor:shutdown:wait=True",
                    "usage:drain",
                    "auth-base:shutdown:wait=False",
                    "model-provider:shutdown",
                    "jsonl:shutdown",
                ),
                id="initial-delivery-flush",
            ),
            pytest.param(
                "usage-executor",
                (
                    "usage-executor:shutdown:wait=True",
                    "auth-base:shutdown:wait=False",
                    "model-provider:shutdown",
                    "jsonl:shutdown",
                ),
                id="usage-executor-shutdown",
            ),
            pytest.param(
                "usage-drain",
                (
                    "usage-executor:shutdown:wait=True",
                    "usage:drain",
                    "auth-base:shutdown:wait=False",
                    "model-provider:shutdown",
                    "jsonl:shutdown",
                ),
                id="post-executor-usage-drain",
            ),
            pytest.param(
                "auth-base",
                (
                    "usage-executor:shutdown:wait=True",
                    "usage:drain",
                    "auth-base:shutdown:wait=False",
                    "model-provider:shutdown",
                    "jsonl:shutdown",
                ),
                id="auth-base-worker-shutdown",
            ),
            pytest.param(
                "model-provider",
                (
                    "usage-executor:shutdown:wait=True",
                    "usage:drain",
                    "auth-base:shutdown:wait=False",
                    "model-provider:shutdown",
                    "jsonl:shutdown",
                ),
                id="model-provider-reporter-shutdown",
            ),
        ],
    )
    def test_done_preserves_downstream_cleanup_after_delivery_failure(
        self,
        failure_point: str,
        expected_calls: tuple[str, ...],
    ) -> None:
        failure = RuntimeError(f"{failure_point} failed")
        calls: list[str] = []

        def shutdown_usage_executor(*, wait: bool) -> None:
            calls.append(f"usage-executor:shutdown:wait={wait}")
            if failure_point == "usage-executor":
                raise failure

        def drain_usage_events() -> None:
            calls.append("usage:drain")
            if failure_point == "usage-drain":
                raise failure

        def shutdown_auth_base(*, wait: bool) -> None:
            calls.append(f"auth-base:shutdown:wait={wait}")
            if failure_point == "auth-base":
                raise failure

        def shutdown_model_provider() -> None:
            calls.append("model-provider:shutdown")
            if failure_point == "model-provider":
                raise failure

        def shutdown_jsonl() -> None:
            calls.append("jsonl:shutdown")

        mock_executor = MagicMock()
        mock_executor.shutdown.side_effect = shutdown_usage_executor

        with (
            patch.object(
                runner_flush_lifecycle,
                "drain_and_close",
                side_effect=failure if failure_point == "initial-flush" else None,
            ) as drain_and_close,
            patch.object(usage.webhook, "usage_executor", mock_executor),
            patch.object(
                usage,
                "drain_usage_events_after_executor_shutdown",
                side_effect=drain_usage_events,
            ),
            patch.object(
                mitm_addon.auth_base_forwarder,
                "shutdown_forward_request_workers",
                side_effect=shutdown_auth_base,
            ),
            patch.object(
                mitm_addon.model_provider_failure,
                "shutdown",
                side_effect=shutdown_model_provider,
            ),
            patch.object(mitm_addon, "shutdown_log_writer", side_effect=shutdown_jsonl),
            pytest.raises(RuntimeError) as exc_info,
        ):
            mitm_addon.done()

        drain_and_close.assert_called_once_with()
        assert exc_info.value is failure
        assert calls == list(expected_calls)

    def test_done_retries_shutdown_delivery_after_executor_join(
        self,
        tmp_path,
        fresh_usage_executor,
        mitm_ctx,
    ):
        control_root = tmp_path / "delivery-control"
        proxy_log_path = tmp_path / "proxy.jsonl"
        timers = install_recording_usage_timer()
        server = UsageWebhookServer()
        server.queue_response(500)
        server.queue_response(500)
        server.queue_response(204)

        with (
            server.run(),
            mitm_ctx(),
            patch.object(usage.webhook.time, "sleep"),
            patch.object(mitm_addon.auth_base_forwarder, "shutdown_forward_request_workers"),
            patch.object(mitm_addon, "shutdown_log_writer"),
        ):
            usage.buffer_usage_events(
                server.url(),
                "token-a",
                "run-1",
                [event(source_key="source-1")],
                str(proxy_log_path),
            )
            mitm_addon.done()

        assert server.request_count == 3
        assert server.json_bodies() == [server.json_bodies()[0]] * 3
        assert len(timers) == 1
        assert timers[0].cancelled is True
        assert_pending(
            control_root,
            flows=0,
            buffered=0,
            reports=0,
        )

    def test_done_waits_for_preexisting_delivery_before_final_retry(
        self,
        tmp_path,
        fresh_usage_executor,
        mitm_ctx,
    ):
        control_root = tmp_path / "delivery-control"
        proxy_log_path = tmp_path / "proxy.jsonl"
        timers = install_recording_usage_timer()
        release_first_post = threading.Event()
        executor_shutdown_started = threading.Event()
        server = UsageWebhookServer()
        server.queue_response(500, release_event=release_first_post)
        server.queue_response(500)
        server.queue_response(204)

        original_shutdown = fresh_usage_executor.shutdown

        def shutdown_executor(*, wait: bool) -> None:
            executor_shutdown_started.set()
            original_shutdown(wait=wait)

        with (
            server.run(),
            mitm_ctx(),
            patch.object(usage.webhook.time, "sleep"),
            patch.object(
                fresh_usage_executor,
                "shutdown",
                side_effect=shutdown_executor,
            ),
            patch.object(mitm_addon.auth_base_forwarder, "shutdown_forward_request_workers"),
            patch.object(mitm_addon, "shutdown_log_writer"),
        ):
            usage.buffer_usage_events(
                server.url(),
                "token-a",
                "run-1",
                [event(source_key="source-1")],
                str(proxy_log_path),
            )
            assert usage.flush_usage_events(trigger="runner") == 1
            assert server.wait_for_request_count(1)

            done_thread = ThreadUnderTest(target=mitm_addon.done)
            try:
                done_thread.start()
                wait_for_event(
                    executor_shutdown_started,
                    timeout=1,
                    threads=(done_thread,),
                    message="done did not begin executor shutdown",
                )
                assert done_thread.is_alive()
                release_first_post.set()
                done_thread.join_and_raise(timeout=1)
            finally:
                release_first_post.set()
                done_thread.join(timeout=1)

        assert server.request_count == 3
        assert server.json_bodies() == [server.json_bodies()[0]] * 3
        assert len(timers) == 1
        assert all(timer.cancelled for timer in timers)
        assert_pending(
            control_root,
            flows=0,
            buffered=0,
            reports=0,
        )

    def test_done_drops_repeatedly_retained_delivery_at_existing_retry_budget(
        self,
        tmp_path,
    ):
        control_root = tmp_path / "delivery-control"
        proxy_log_path = tmp_path / "proxy.jsonl"
        lifecycle_calls: list[str] = []

        def reject_delivery(
            url: str,
            sandbox_token: str,
            payload: dict,
            path: str,
            log_type: str,
            delivery_outcome_callback: Callable[[usage.webhook.WebhookDeliveryOutcome], None],
        ) -> bool:
            del url, sandbox_token, payload, path, log_type, delivery_outcome_callback
            lifecycle_calls.append("enqueue")
            return False

        enqueue = RecordingEnqueue(side_effect=reject_delivery)
        timers = install_recording_usage_timer(
            enqueue_webhook=enqueue,
            max_retained_batch_retries=1,
        )
        mock_executor = MagicMock()
        mock_executor.shutdown.side_effect = lambda *, wait: lifecycle_calls.append(
            f"shutdown:{wait}"
        )
        usage.buffer_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "secret-token",
            "run-1",
            [event(source_key="source-1")],
            str(proxy_log_path),
        )

        with (
            patch.object(usage.webhook, "usage_executor", mock_executor),
            patch.object(mitm_addon.auth_base_forwarder, "shutdown_forward_request_workers"),
            patch.object(mitm_addon, "shutdown_log_writer"),
        ):
            mitm_addon.done()

        assert lifecycle_calls == ["enqueue", "shutdown:True", "enqueue"]
        assert enqueue.payloads == [enqueue.payloads[0]] * 2
        assert len(timers) == 1
        assert timers[0].cancelled is True
        assert_pending(
            control_root,
            flows=0,
            buffered=0,
            reports=0,
        )
        dropped_entries = [
            entry for entry in flush_log_entries(proxy_log_path) if entry["phase"] == "dropped"
        ]
        assert len(dropped_entries) == 1
        assert dropped_entries[0]["reason"] == "retry_budget_exhausted"
        assert dropped_entries[0]["underbilling_class"] == "confirmed"
