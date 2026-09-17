"""Cross-provider integration tests for provider-output timing stores."""

import sys
import threading
from datetime import UTC, datetime
from pathlib import Path
from types import FrameType, TracebackType
from typing import Self
from unittest.mock import patch

import pytest
from mitmproxy import http

import claude_output_timing
import codex_output_timing
import flow_metadata_keys as metadata_keys
import usage
from tests.model_provider_flow_helpers import (
    make_model_provider_sse_flow,
    make_openai_responses_websocket_flow,
)
from tests.pending_helpers import assert_pending
from tests.thread_helpers import ThreadUnderTest, wait_for_event
from tests.usage_helpers import UsageWebhookServer
from tests.webhook_test_helpers import QueuedUsageExecutor

_FIRST_GENERATED_RESPONSE_CREATE_SENT = "codex_proxy_first_generated_response_create_sent"
_FIRST_GENERATED_RESPONSE_CREATED = "codex_proxy_first_generated_response_created"
_FIRST_OUTPUT_ITEM_ADDED = "codex_proxy_first_output_item_added"
_FIRST_OUTPUT_TEXT_DELTA = "codex_proxy_first_output_text_delta"
_FIRST_TEXT_IN_FIRST_GENERATED_RESPONSE = "codex_proxy_first_text_in_first_generated_response"
_TELEMETRY_PATH = "/api/webhooks/agent/telemetry"


class _RetryContentionLock:
    """Release a gated retry when a provider event reaches its held store lock."""

    def __init__(self, release_retry: threading.Event) -> None:
        self._lock = threading.Lock()
        self._release_retry = release_retry
        self.contention_started = threading.Event()

    def __enter__(self) -> Self:
        if self._lock.acquire(blocking=False):
            return self

        self.contention_started.set()
        self._release_retry.set()
        if not self._lock.acquire(timeout=1):
            raise AssertionError("provider timing transition did not acquire the retry lock")
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        del exc_type, exc, traceback
        self._lock.release()


class _RetryConcurrencyHarness:
    def __init__(self, control_root: Path, *, retry_admitted: bool) -> None:
        self.control_root = control_root
        self.retry_admitted = retry_admitted
        self.executor = QueuedUsageExecutor()
        self.release_retry = threading.Event()
        self.retry_admission_started = threading.Event()
        self.retry_admission_resolved = threading.Event()
        self.retry_finished = threading.Event()
        self.concurrent_admission = threading.Event()
        self.contention_lock = _RetryContentionLock(self.release_retry)
        self.admission_attempts: list[dict[str, object]] = []
        self.accepted_payloads: list[dict[str, object]] = []
        self.successful_admissions = 0
        self._admission_attempt_lock = threading.Lock()
        self._original_enqueue = usage.webhook.enqueue_webhook_delivery
        self.retry_thread = ThreadUnderTest(
            target=self._retry_all_pending,
            name="provider-timing-retry",
        )

    @property
    def expected_successful_admissions(self) -> int:
        return 2 if self.retry_admitted else 1

    def enqueue_timing_delivery(
        self,
        url: str,
        sandbox_token: str,
        payload: dict[str, object],
        proxy_log_path: str,
        log_type: str,
    ) -> bool:
        with self._admission_attempt_lock:
            self.admission_attempts.append(payload)
            attempt = len(self.admission_attempts)

        if attempt == 1:
            return False
        if attempt == 2:
            return self._admit_retry(
                url,
                sandbox_token,
                payload,
                proxy_log_path,
                log_type,
            )
        if attempt == 3:
            return self._admit_new_milestone(
                url,
                sandbox_token,
                payload,
                proxy_log_path,
                log_type,
            )
        raise AssertionError(f"unexpected timing admission attempt {attempt}")

    def assert_pending(
        self,
        *,
        buffered: int,
        reports: int,
    ) -> None:
        assert_pending(
            self.control_root,
            flows=0,
            buffered=buffered,
            reports=reports,
        )
        assert usage.webhook.pending_delivery_payload_count_for_tests() == reports

    def finish_retry_and_deliver(self) -> None:
        self.release_retry.set()
        try:
            self.retry_thread.join_and_raise(timeout=1)
        finally:
            self.executor.run_all()

    def _admit_retry(
        self,
        url: str,
        sandbox_token: str,
        payload: dict[str, object],
        proxy_log_path: str,
        log_type: str,
    ) -> bool:
        self.retry_admission_started.set()
        try:
            if not self.release_retry.wait(timeout=1):
                raise AssertionError("concurrent provider event did not release timing retry")
            if not self.retry_admitted:
                self.assert_pending(
                    buffered=1,
                    reports=0,
                )
                return False
            return self._admit_through_real_webhook(
                url,
                sandbox_token,
                payload,
                proxy_log_path,
                log_type,
            )
        finally:
            self.retry_admission_resolved.set()

    def _admit_new_milestone(
        self,
        url: str,
        sandbox_token: str,
        payload: dict[str, object],
        proxy_log_path: str,
        log_type: str,
    ) -> bool:
        if not self.retry_admission_resolved.is_set():
            self.concurrent_admission.set()
            self.release_retry.set()
            if not self.retry_finished.wait(timeout=1):
                raise AssertionError("unserialized timing retry did not finish")
        return self._admit_through_real_webhook(
            url,
            sandbox_token,
            payload,
            proxy_log_path,
            log_type,
        )

    def _admit_through_real_webhook(
        self,
        url: str,
        sandbox_token: str,
        payload: dict[str, object],
        proxy_log_path: str,
        log_type: str,
    ) -> bool:
        self.assert_pending(
            buffered=1,
            reports=self.successful_admissions,
        )
        assert self._original_enqueue(
            url,
            sandbox_token,
            payload,
            proxy_log_path,
            log_type,
        )
        self.accepted_payloads.append(payload)
        self.successful_admissions += 1
        self.assert_pending(
            buffered=1,
            reports=self.successful_admissions,
        )
        return True

    def _retry_all_pending(self) -> None:
        try:
            codex_output_timing.retry_all_pending()
        finally:
            self.retry_finished.set()


def _assert_delivered_timing_operations(
    usage_webhook_server: UsageWebhookServer,
    harness: _RetryConcurrencyHarness,
    *,
    client_received_at: float,
    created_at: str,
    output_item_at: str,
    text_at: str,
) -> None:
    delivered_requests = [
        request for request in usage_webhook_server.requests if request.path == _TELEMETRY_PATH
    ]
    delivered_payloads = [request.json_body() for request in delivered_requests]
    assert delivered_payloads == harness.accepted_payloads

    expected_payload_sizes = [3, 2] if harness.retry_admitted else [5]
    delivered_operations: list[dict[str, object]] = []
    actual_payload_sizes: list[int] = []
    for payload in delivered_payloads:
        operations = payload.get("sandboxOperations")
        assert isinstance(operations, list)
        actual_payload_sizes.append(len(operations))
        for operation in operations:
            assert isinstance(operation, dict)
            delivered_operations.append(operation)
    assert actual_payload_sizes == expected_payload_sizes

    expected_operations = [
        (
            _FIRST_GENERATED_RESPONSE_CREATE_SENT,
            datetime.fromtimestamp(client_received_at, UTC).isoformat(),
        ),
        (_FIRST_GENERATED_RESPONSE_CREATED, created_at),
        (_FIRST_OUTPUT_ITEM_ADDED, output_item_at),
        (_FIRST_OUTPUT_TEXT_DELTA, text_at),
        (_FIRST_TEXT_IN_FIRST_GENERATED_RESPONSE, text_at),
    ]
    assert [
        (operation.get("action_type"), operation.get("ts")) for operation in delivered_operations
    ] == expected_operations


def test_provider_stores_keep_independent_lru_capacity(
    tmp_path: Path,
    real_flow,
    mitm_ctx,
) -> None:
    control_root = tmp_path / "delivery-control"
    delivery_available = False
    admitted: list[tuple[str, str]] = []

    def enqueue_timing_delivery(
        _url: str,
        _sandbox_token: str,
        payload: dict[str, object],
        _proxy_log_path: str,
        log_type: str,
    ) -> bool:
        if not delivery_available:
            return False
        run_id = payload["runId"]
        assert isinstance(run_id, str)
        admitted.append((log_type, run_id))
        return True

    def claude_flow(run_id: str) -> http.HTTPFlow:
        flow = make_model_provider_sse_flow(
            real_flow,
            tmp_path,
            host="api.anthropic.com",
            original_url="https://api.anthropic.com/v1/messages",
            firewall_name="model-provider:anthropic-api-key",
            cli_agent_type="claude-code",
            model_usage_provider="claude-sonnet-4-6",
        )
        flow.metadata[metadata_keys.SANDBOX_RUN_ID] = run_id
        return flow

    with (
        mitm_ctx(api_url="https://api.test"),
        patch.object(
            usage.webhook,
            "enqueue_webhook_delivery",
            side_effect=enqueue_timing_delivery,
        ),
        patch.object(codex_output_timing._store, "_max_tracked_runs", 1),
        patch.object(claude_output_timing._store, "_max_tracked_runs", 1),
    ):
        codex_flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        codex_flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-shared"
        codex_output_timing.observe_server_event(codex_flow, "response.created")
        codex_output_timing.observe_server_event(codex_flow, "response.output_item.added")

        claude_output_timing.observe_lifecycle_event(
            claude_flow("run-shared"),
            "message_start",
            None,
        )

        assert_pending(
            control_root,
            flows=0,
            buffered=2,
            reports=0,
        )

        claude_output_timing.observe_lifecycle_event(
            claude_flow("run-claude-recent"),
            "message_start",
            None,
        )

        assert_pending(
            control_root,
            flows=0,
            buffered=2,
            reports=0,
        )

        delivery_available = True
        claude_output_timing.retry_all_pending()
        assert_pending(
            control_root,
            flows=0,
            buffered=1,
            reports=0,
        )

        codex_output_timing.retry_all_pending()

    assert_pending(
        control_root,
        flows=0,
        buffered=0,
        reports=0,
    )
    assert admitted == [
        ("claude_output_timing", "run-claude-recent"),
        ("codex_output_timing", "run-shared"),
    ]


def test_retry_all_pending_visits_only_retryable_runs_in_current_lru_order(
    tmp_path: Path,
    real_flow,
    mitm_ctx,
) -> None:
    control_root = tmp_path / "delivery-control"
    delivery_available = True
    admission_results: list[bool] = []
    attempted_run_ids: list[str] = []
    admitted_run_ids: list[str] = []

    def enqueue_timing_delivery(
        _url: str,
        _sandbox_token: str,
        payload: dict[str, object],
        _proxy_log_path: str,
        _log_type: str,
    ) -> bool:
        run_id = payload["runId"]
        assert isinstance(run_id, str)
        attempted_run_ids.append(run_id)
        admitted = admission_results.pop(0) if admission_results else delivery_available
        if admitted:
            admitted_run_ids.append(run_id)
        return admitted

    def codex_flow(run_id: str) -> http.HTTPFlow:
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        flow.metadata[metadata_keys.SANDBOX_RUN_ID] = run_id
        return flow

    def observe_generated_response(flow: http.HTTPFlow) -> None:
        codex_output_timing.observe_server_event(flow, "response.created")
        codex_output_timing.observe_server_event(flow, "response.output_item.added")

    admission_code = type(codex_output_timing._store)._admit_retained_locked.__code__

    def retry_and_capture_visits() -> list[str]:
        visited_run_ids: list[str] = []

        def capture_visit(frame: FrameType, event: str, _arg: object) -> None:
            if event != "call" or frame.f_code is not admission_code:
                return
            run_id = frame.f_locals.get("run_id")
            assert isinstance(run_id, str)
            visited_run_ids.append(run_id)

        previous_profile = sys.getprofile()
        sys.setprofile(capture_visit)
        try:
            codex_output_timing.retry_all_pending()
        finally:
            sys.setprofile(previous_profile)
        return visited_run_ids

    with (
        mitm_ctx(api_url="https://api.test"),
        patch.object(
            usage.webhook,
            "enqueue_webhook_delivery",
            side_effect=enqueue_timing_delivery,
        ),
    ):
        for index in range(128):
            observe_generated_response(codex_flow(f"run-completed-{index}"))

        delivery_available = False
        older_pending_flow = codex_flow("run-pending-older")
        newer_pending_flow = codex_flow("run-pending-newer")
        observe_generated_response(older_pending_flow)
        observe_generated_response(newer_pending_flow)

        assert_pending(
            control_root,
            flows=0,
            buffered=2,
            reports=0,
        )

        codex_output_timing.observe_server_event(older_pending_flow, "response.completed")

        attempted_run_ids.clear()
        admitted_run_ids.clear()
        admission_results.extend((True, False))
        assert retry_and_capture_visits() == ["run-pending-newer", "run-pending-older"]
        assert attempted_run_ids == ["run-pending-newer", "run-pending-older"]
        assert admitted_run_ids == ["run-pending-newer"]
        assert_pending(
            control_root,
            flows=0,
            buffered=1,
            reports=0,
        )

        attempted_run_ids.clear()
        admission_results.append(True)
        assert retry_and_capture_visits() == ["run-pending-older"]
        assert attempted_run_ids == ["run-pending-older"]
        assert admitted_run_ids == ["run-pending-newer", "run-pending-older"]
        assert_pending(
            control_root,
            flows=0,
            buffered=0,
            reports=0,
        )

        attempted_run_ids.clear()
        assert retry_and_capture_visits() == []
        assert attempted_run_ids == []
        assert admitted_run_ids == ["run-pending-newer", "run-pending-older"]


@pytest.mark.parametrize(
    "retry_admitted",
    [
        pytest.param(True, id="retry-admitted"),
        pytest.param(False, id="retry-capacity-rejected"),
    ],
)
def test_retry_serializes_with_new_codex_milestone(
    tmp_path: Path,
    real_flow,
    mitm_ctx,
    usage_webhook_server: UsageWebhookServer,
    retry_admitted: bool,
) -> None:
    control_root = tmp_path / "delivery-control"
    harness = _RetryConcurrencyHarness(control_root, retry_admitted=retry_admitted)

    client_received_at = 1_700_000_000.125
    created_at = "2023-11-14T22:13:21.125000+00:00"
    output_item_at = "2023-11-14T22:13:22.125000+00:00"
    text_at = "2023-11-14T22:13:23.125000+00:00"
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)

    with (
        mitm_ctx(api_url=usage_webhook_server.api_url),
        patch.object(
            usage.webhook,
            "enqueue_webhook_delivery",
            side_effect=harness.enqueue_timing_delivery,
        ),
        patch.object(usage.webhook, "usage_executor", harness.executor),
        patch.object(codex_output_timing._store, "_lock", harness.contention_lock),
        patch.object(
            codex_output_timing,
            "_observation_time",
            side_effect=(created_at, output_item_at, text_at),
        ),
    ):
        codex_output_timing.observe_client_event(flow, "response.create", client_received_at)
        codex_output_timing.observe_server_event(flow, "response.created")
        codex_output_timing.observe_server_event(flow, "response.output_item.added")

        harness.assert_pending(
            buffered=1,
            reports=0,
        )

        harness.retry_thread.start()
        try:
            wait_for_event(
                harness.retry_admission_started,
                timeout=1,
                threads=(harness.retry_thread,),
                message="timing retry did not reach webhook admission",
            )
            codex_output_timing.observe_server_event(flow, "response.output_text.delta")
            harness.retry_thread.join_and_raise(timeout=1)

            assert harness.contention_lock.contention_started.is_set()
            assert not harness.concurrent_admission.is_set()
            assert len(harness.admission_attempts) == 3

            assert harness.successful_admissions == harness.expected_successful_admissions
            harness.assert_pending(
                buffered=0,
                reports=harness.expected_successful_admissions,
            )
        finally:
            harness.finish_retry_and_deliver()

        harness.assert_pending(
            buffered=0,
            reports=0,
        )

    _assert_delivered_timing_operations(
        usage_webhook_server,
        harness,
        client_received_at=client_received_at,
        created_at=created_at,
        output_item_at=output_item_at,
        text_at=text_at,
    )
