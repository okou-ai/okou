"""Integration tests for trusted model-provider failure reduction."""

import gzip
import hashlib
import json
import threading
import urllib.request
import zlib
from concurrent.futures import Future
from pathlib import Path
from typing import Literal
from unittest.mock import patch

import pytest
import zstandard
from mitmproxy import http
from mitmproxy.connection import ConnectionState
from mitmproxy.flow import Error
from mitmproxy.net.http import http1

import body_decoding
import flow_metadata_keys as metadata_keys
import mitm_addon
import model_provider_failure
import platform_api
import usage.anthropic_messages as anthropic_messages
import usage.model_json as model_json
import usage.openai_responses as openai_responses
from body_limits import STREAM_BUFFER_LIMIT
from model_provider_failure_executor import FailureReportExecutor
from tests.flow_helpers import header_map, response_stream
from tests.jsonl_log_helpers import jsonl_exists_after_flush, read_jsonl_entries_after_flush
from tests.model_provider_flow_helpers import make_openai_responses_websocket_flow
from tests.model_provider_websocket_helpers import (
    capture_deferred_websocket_trims,
    capture_openai_responses_extractor_feeds,
    feed_websocket_client_message,
    feed_websocket_server_message,
)
from tests.thread_helpers import ThreadUnderTest, wait_for_event

_REPORT_CAPACITY = 16
_REPORT_WORKERS = 4
_RETRY_AFTER_FIELD_LIMIT = 8 * 1024
_RETRY_AFTER_VALUE_LIMIT = 8 * 1024


def _make_flow(
    real_flow,
    proxy_log_path: Path,
    *,
    firewall_name: str = "model-provider:openai-api-key",
    request_path: str = "/v1/chat/completions",
    request_method: str = "POST",
    response_status: int = 200,
    response_body: bytes | None = None,
    response_headers: http.Headers | None = None,
):
    flow = real_flow(
        host="api.openai.com",
        path=request_path,
        method=request_method,
        response_status=response_status,
        response_body=response_body,
        response_headers=response_headers,
    )
    flow.metadata.update(
        {
            metadata_keys.SANDBOX_RUN_ID: "run-model-failure",
            metadata_keys.SANDBOX_PROXY_LOG_PATH: str(proxy_log_path),
            metadata_keys.ORIGINAL_URL: f"https://api.openai.com{request_path}",
            metadata_keys.FIREWALL_NAME: firewall_name,
            metadata_keys.FIREWALL_BILLABLE: True,
            metadata_keys.FIREWALL_ACTION: "ALLOW",
        }
    )
    return flow


@pytest.fixture(autouse=True)
def model_provider_failure_api(usage_webhook_server, mitm_ctx, monkeypatch):
    bearer_credential = str(id(usage_webhook_server))
    monkeypatch.setenv(model_provider_failure.RUNNER_AUTH_ENV, bearer_credential)
    with mitm_ctx(api_url=usage_webhook_server.api_url):
        mitm_addon.configure(set())
        yield usage_webhook_server
    model_provider_failure.drain_reports_for_tests()


def _reported_payloads(model_provider_failure_api) -> list[dict[str, object]]:
    model_provider_failure.drain_reports_for_tests()
    return [request.json_body() for request in model_provider_failure_api.requests]


def _suppressed_failure_entries(flow: http.HTTPFlow) -> list[dict[str, object]]:
    proxy_log = Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])
    if not jsonl_exists_after_flush(proxy_log):
        return []
    return [
        entry
        for entry in read_jsonl_entries_after_flush(proxy_log)
        if entry.get("type") == "model_provider_failure"
        and entry.get("disposition") == "suppressed"
    ]


def _finish_http_flow(flow, *, body: bytes | None, mitm_ctx) -> None:
    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)
    stream = response_stream(flow)
    if body is not None:
        stream(body)
    stream(b"")
    with mitm_ctx():
        mitm_addon.response(flow)


def _enqueue_provider_unavailable(real_flow, proxy_log_path: Path):
    flow = _make_flow(real_flow, proxy_log_path, response_status=503)
    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)
    return flow


def _finish_upstream_transport_failure(real_flow, proxy_log_path: Path, mitm_ctx):
    flow = _make_flow(real_flow, proxy_log_path)
    flow.response = None
    model_provider_failure.admit_flow(flow)
    flow.error = Error("connection reset by peer")
    with mitm_ctx():
        mitm_addon.error(flow)
    return flow


def _queue_blocked_reports(
    real_flow,
    proxy_log_path: Path,
    model_provider_failure_api,
    release_delivery: threading.Event,
    *,
    count: int,
):
    flows = []
    for _ in range(count):
        model_provider_failure_api.queue_response(204, release_event=release_delivery)
        flows.append(_enqueue_provider_unavailable(real_flow, proxy_log_path))
    return flows


def _report_omissions(proxy_log_path: Path) -> list[dict[str, object]]:
    return [
        entry
        for entry in read_jsonl_entries_after_flush(proxy_log_path)
        if entry.get("type") == "model_provider_failure" and entry.get("disposition") == "omitted"
    ]


def _assert_queued_reports_cancelled(
    proxy_log_path: Path,
    flows: list[http.HTTPFlow],
) -> None:
    shutdown_entries = [
        entry for entry in _report_omissions(proxy_log_path) if entry.get("reason") == "shutdown"
    ]
    assert len(shutdown_entries) == _REPORT_CAPACITY - _REPORT_WORKERS
    assert len({entry["flow_id"] for entry in shutdown_entries}) == len(shutdown_entries)
    flow_ids = {flow.id for flow in flows}
    for entry in shutdown_entries:
        flow_id = entry["flow_id"]
        assert isinstance(flow_id, str)
        assert flow_id in flow_ids
        _assert_report_omission_entry(entry, flow_id=flow_id, reason="shutdown")


def _assert_report_omission_entry(
    entry: dict[str, object],
    *,
    flow_id: str,
    reason: str,
    failure_kind: str = "provider_unavailable",
    **details: str | int,
) -> None:
    assert entry == {
        "timestamp": entry["timestamp"],
        "level": "warn",
        "message": "Model provider failure report omitted",
        "type": "model_provider_failure",
        "disposition": "omitted",
        "reason": reason,
        "run_id": "run-model-failure",
        "flow_id": flow_id,
        "firewall_name": "model-provider:openai-api-key",
        "failure_kind": failure_kind,
        **details,
    }


def _assert_single_report_omission(
    proxy_log_path: Path,
    *,
    flow_id: str,
    reason: str,
    failure_kind: str = "provider_unavailable",
    **details: str | int,
) -> None:
    [entry] = _report_omissions(proxy_log_path)
    _assert_report_omission_entry(
        entry,
        flow_id=flow_id,
        reason=reason,
        failure_kind=failure_kind,
        **details,
    )


def _restart_reporter_after_callbacks(model_provider_failure_api) -> None:
    """Reset reporting only after every executor callback has returned."""
    original_shutdown = FailureReportExecutor.shutdown

    def shutdown_and_wait(
        executor: FailureReportExecutor,
        *,
        wait: bool,
    ) -> None:
        original_shutdown(executor, wait=True)

    with patch.object(FailureReportExecutor, "shutdown", shutdown_and_wait):
        model_provider_failure.shutdown()
    model_provider_failure.reset_for_tests()
    model_provider_failure.configure_reporting(
        api_url=model_provider_failure_api.api_url,
        bearer_credential=str(id(model_provider_failure_api)),
    )


def _assert_full_report_capacity(
    real_flow,
    proxy_log_path: Path,
    model_provider_failure_api,
) -> None:
    release_delivery = threading.Event()
    initial_request_count = model_provider_failure_api.request_count
    try:
        _queue_blocked_reports(
            real_flow,
            proxy_log_path,
            model_provider_failure_api,
            release_delivery,
            count=_REPORT_WORKERS,
        )
        assert model_provider_failure_api.wait_for_request_count(
            initial_request_count + _REPORT_WORKERS
        )
        _queue_blocked_reports(
            real_flow,
            proxy_log_path,
            model_provider_failure_api,
            release_delivery,
            count=_REPORT_CAPACITY - _REPORT_WORKERS,
        )

        overflow_flow = _enqueue_provider_unavailable(real_flow, proxy_log_path)

        assert model_provider_failure_api.request_count == initial_request_count + _REPORT_WORKERS
        _assert_single_report_omission(
            proxy_log_path,
            flow_id=overflow_flow.id,
            reason="delivery_saturated",
        )
    finally:
        release_delivery.set()
        try:
            model_provider_failure.drain_reports_for_tests()
        finally:
            _restart_reporter_after_callbacks(model_provider_failure_api)

    assert model_provider_failure_api.request_count == initial_request_count + _REPORT_CAPACITY


def _assert_single_reclaimed_report_slot(
    real_flow,
    proxy_log_path: Path,
    model_provider_failure_api,
    release_target: threading.Event,
    *,
    initial_request_count: int,
    target_outbound_count: int,
) -> None:
    release_delivery = threading.Event()
    try:
        _queue_blocked_reports(
            real_flow,
            proxy_log_path,
            model_provider_failure_api,
            release_delivery,
            count=_REPORT_WORKERS - 1,
        )
        assert model_provider_failure_api.wait_for_request_count(
            initial_request_count + target_outbound_count + _REPORT_WORKERS - 1
        )
        _queue_blocked_reports(
            real_flow,
            proxy_log_path,
            model_provider_failure_api,
            release_delivery,
            count=_REPORT_CAPACITY - _REPORT_WORKERS,
        )

        release_target.set()
        assert model_provider_failure_api.wait_for_request_count(
            initial_request_count + target_outbound_count + _REPORT_WORKERS
        )

        _enqueue_provider_unavailable(real_flow, proxy_log_path)
        overflow_flow = _enqueue_provider_unavailable(real_flow, proxy_log_path)

        assert (
            model_provider_failure_api.request_count
            == initial_request_count + target_outbound_count + _REPORT_WORKERS
        )
        _assert_single_report_omission(
            proxy_log_path,
            flow_id=overflow_flow.id,
            reason="delivery_saturated",
        )
    finally:
        release_target.set()
        release_delivery.set()
        try:
            model_provider_failure.drain_reports_for_tests()
        finally:
            _restart_reporter_after_callbacks(model_provider_failure_api)

    assert (
        model_provider_failure_api.request_count
        == initial_request_count + target_outbound_count + _REPORT_CAPACITY
    )


def test_rate_limit_response_reports_normalized_failure(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        response_status=429,
        response_headers=header_map({"retry-after": "120"}),
    )

    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)

    assert _reported_payloads(model_provider_failure_api) == [
        {"failureKind": "rate_limit", "retryAfterSeconds": 120}
    ]
    request = model_provider_failure_api.requests[0]
    assert request.method == "POST"
    assert request.path == "/api/runners/runs/run-model-failure/model-provider-failures"
    assert request.header("authorization") == f"Bearer {id(model_provider_failure_api)}"

    with mitm_ctx():
        mitm_addon.response(flow)


def test_openrouter_edge_timeout_reports_normalized_failure(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        firewall_name="model-provider:openrouter-api-key",
        request_path="/api/v1/messages",
        response_status=524,
    )

    _finish_http_flow(flow, body=None, mitm_ctx=mitm_ctx)

    assert _reported_payloads(model_provider_failure_api) == [{"failureKind": "timeout"}]


def test_report_http_failure_logs_omission_and_reclaims_capacity(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    proxy_log_path = tmp_path / "http-error.jsonl"
    release_target = threading.Event()
    initial_request_count = model_provider_failure_api.request_count
    model_provider_failure_api.queue_response(404, release_event=release_target)
    flow = _make_flow(
        real_flow,
        proxy_log_path,
        response_status=503,
    )

    _finish_http_flow(flow, body=None, mitm_ctx=mitm_ctx)

    assert flow.response is not None
    assert flow.response.status_code == 503
    assert model_provider_failure_api.wait_for_request_count(initial_request_count + 1)
    assert model_provider_failure_api.requests[initial_request_count].json_body() == {
        "failureKind": "provider_unavailable"
    }
    _assert_single_reclaimed_report_slot(
        real_flow,
        tmp_path / "http-error-recovery.jsonl",
        model_provider_failure_api,
        release_target,
        initial_request_count=initial_request_count,
        target_outbound_count=1,
    )
    _assert_single_report_omission(
        proxy_log_path,
        flow_id=flow.id,
        reason="http_error",
        http_status=404,
    )


@pytest.mark.parametrize("connection_source", ["provider_response", "upstream_transport"])
def test_connection_report_http_failure_preserves_source_and_reclaims_capacity(
    tmp_path,
    real_flow,
    mitm_ctx,
    connection_source: str,
    model_provider_failure_api,
):
    proxy_log_path = tmp_path / "connection-http-error.jsonl"
    release_target = threading.Event()
    initial_request_count = model_provider_failure_api.request_count
    model_provider_failure_api.queue_response(400, release_event=release_target)
    request_timeouts: list[float] = []
    original_open = urllib.request.OpenerDirector.open

    def record_timeout(opener, request, *, timeout: float):
        request_timeouts.append(timeout)
        return original_open(opener, request, timeout=timeout)

    body = b'{"error":{"code":"connection_error"}}'
    with patch.object(urllib.request.OpenerDirector, "open", record_timeout):
        if connection_source == "upstream_transport":
            flow = _finish_upstream_transport_failure(real_flow, proxy_log_path, mitm_ctx)
        else:
            flow = _make_flow(real_flow, proxy_log_path, response_body=body)
            _finish_http_flow(flow, body=body, mitm_ctx=mitm_ctx)

        assert model_provider_failure_api.wait_for_request_count(initial_request_count + 1)

    request = model_provider_failure_api.requests[initial_request_count]
    assert request.json_body() == {
        "failureKind": "connection",
        "connectionSource": connection_source,
    }
    assert request.method == "POST"
    assert request.path == "/api/runners/runs/run-model-failure/model-provider-failures"
    assert request.header("authorization") == f"Bearer {id(model_provider_failure_api)}"
    assert request_timeouts == [10]
    _assert_single_reclaimed_report_slot(
        real_flow,
        tmp_path / "connection-http-error-recovery.jsonl",
        model_provider_failure_api,
        release_target,
        initial_request_count=initial_request_count,
        target_outbound_count=1,
    )
    _assert_single_report_omission(
        proxy_log_path,
        flow_id=flow.id,
        reason="http_error",
        failure_kind="connection",
        http_status=400,
    )
    if connection_source == "upstream_transport":
        assert flow.response is None
        assert flow.error is not None
        assert flow.error.msg == "connection reset by peer"
    else:
        assert flow.response is not None
        assert flow.response.status_code == 200
        assert flow.response.content == body
        assert flow.error is None


def test_source_aware_non_400_failure_is_not_retried(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    proxy_log_path = tmp_path / "source-aware-non-400.jsonl"
    model_provider_failure_api.queue_response(404)

    flow = _finish_upstream_transport_failure(real_flow, proxy_log_path, mitm_ctx)

    assert _reported_payloads(model_provider_failure_api) == [
        {
            "failureKind": "connection",
            "connectionSource": "upstream_transport",
        }
    ]
    _assert_single_report_omission(
        proxy_log_path,
        flow_id=flow.id,
        reason="http_error",
        failure_kind="connection",
        http_status=404,
    )


def test_source_less_400_failure_is_not_retried(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    proxy_log_path = tmp_path / "source-less-400.jsonl"
    model_provider_failure_api.queue_response(400)
    flow = _make_flow(real_flow, proxy_log_path, response_status=503)

    _finish_http_flow(flow, body=None, mitm_ctx=mitm_ctx)

    assert _reported_payloads(model_provider_failure_api) == [
        {"failureKind": "provider_unavailable"}
    ]
    _assert_single_report_omission(
        proxy_log_path,
        flow_id=flow.id,
        reason="http_error",
        http_status=400,
    )


def test_report_transport_failure_logs_omission_and_reclaims_capacity(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    proxy_log_path = tmp_path / "delivery-failed.jsonl"
    initial_request_count = model_provider_failure_api.request_count
    target_delivery_started = threading.Event()
    release_target = threading.Event()
    original_build_api_opener = platform_api.build_api_opener
    target_delivery = True

    def build_target_then_real_opener():
        nonlocal target_delivery
        if target_delivery:
            target_delivery = False
            target_delivery_started.set()
            release_target.wait()
            raise ConnectionError("delivery unavailable")
        return original_build_api_opener()

    flow = _make_flow(real_flow, proxy_log_path, response_status=503)

    with patch.object(
        platform_api,
        "build_api_opener",
        side_effect=build_target_then_real_opener,
    ):
        try:
            _finish_http_flow(flow, body=None, mitm_ctx=mitm_ctx)
            wait_for_event(
                target_delivery_started,
                timeout=1,
                message="target failure report did not begin delivery",
            )
            _assert_single_reclaimed_report_slot(
                real_flow,
                tmp_path / "delivery-failed-recovery.jsonl",
                model_provider_failure_api,
                release_target,
                initial_request_count=initial_request_count,
                target_outbound_count=0,
            )
        finally:
            release_target.set()

    assert flow.response is not None
    assert flow.response.status_code == 503
    _assert_single_report_omission(
        proxy_log_path,
        flow_id=flow.id,
        reason="delivery_failed",
        error_type="ConnectionError",
    )


def test_drain_waits_for_completed_report_callback_cleanup(
    tmp_path,
    real_flow,
    model_provider_failure_api,
):
    release_delivery = threading.Event()
    callback_started = threading.Event()
    release_callback = threading.Event()
    original_finish_report = model_provider_failure._finish_report

    def hold_callback_cleanup(
        future: Future[int],
        context: model_provider_failure._ReportContext,
    ) -> None:
        callback_started.set()
        release_callback.wait()
        original_finish_report(future, context)

    model_provider_failure_api.queue_response(204, release_event=release_delivery)
    with patch.object(model_provider_failure, "_finish_report", hold_callback_cleanup):
        try:
            _enqueue_provider_unavailable(real_flow, tmp_path / "callback-cleanup.jsonl")
            assert model_provider_failure_api.wait_for_request_count(1)
            release_delivery.set()
            wait_for_event(
                callback_started,
                timeout=1,
                message="failure report callback did not begin cleanup",
            )

            with pytest.raises(
                TimeoutError,
                match="1 model-provider failure report callbacks did not finish",
            ):
                model_provider_failure.drain_reports_for_tests(timeout=0)
        finally:
            release_delivery.set()
            release_callback.set()
            model_provider_failure.drain_reports_for_tests()

    with model_provider_failure._report_lock:
        assert not model_provider_failure._report_futures
    _assert_full_report_capacity(
        real_flow,
        tmp_path / "callback-cleanup-recovery.jsonl",
        model_provider_failure_api,
    )


def test_successful_reports_reclaim_every_capacity_slot(
    tmp_path,
    real_flow,
    model_provider_failure_api,
):
    _assert_full_report_capacity(
        real_flow,
        tmp_path / "first-capacity-cycle.jsonl",
        model_provider_failure_api,
    )
    _assert_full_report_capacity(
        real_flow,
        tmp_path / "second-capacity-cycle.jsonl",
        model_provider_failure_api,
    )


def test_executor_submission_failure_reclaims_capacity(
    tmp_path,
    real_flow,
    model_provider_failure_api,
):
    _enqueue_provider_unavailable(real_flow, tmp_path / "submit-initialized.jsonl")
    model_provider_failure.drain_reports_for_tests()
    proxy_log_path = tmp_path / "submit-failed.jsonl"
    with patch.object(
        FailureReportExecutor,
        "submit",
        side_effect=RuntimeError("executor shut down"),
    ):
        flow = _enqueue_provider_unavailable(real_flow, proxy_log_path)

    assert model_provider_failure_api.request_count == 1
    _assert_single_report_omission(
        proxy_log_path,
        flow_id=flow.id,
        reason="reporter_shut_down",
    )
    _assert_full_report_capacity(
        real_flow,
        tmp_path / "submit-failed-recovery.jsonl",
        model_provider_failure_api,
    )


@pytest.mark.parametrize("started_workers", [0, 2], ids=["cold", "partial"])
@pytest.mark.parametrize("shutdown_before_recovery", [False, True], ids=["recover", "shutdown"])
def test_worker_start_failure_drops_reports_and_recovers_capacity(
    tmp_path,
    real_flow,
    model_provider_failure_api,
    started_workers,
    shutdown_before_recovery,
):
    _restart_reporter_after_callbacks(model_provider_failure_api)
    proxy_log_path = tmp_path / "worker-start-failed.jsonl"
    original_start = threading.Thread.start
    started_threads: list[threading.Thread] = []
    failed_starts = 0

    def start_with_reporter_failure(thread: threading.Thread) -> None:
        nonlocal failed_starts
        if thread.name.startswith("model-provider-failure_"):
            if thread.name == f"model-provider-failure_{started_workers}":
                failed_starts += 1
                raise RuntimeError("can't start new thread")
            started_threads.append(thread)
        original_start(thread)

    try:
        with patch.object(threading.Thread, "start", start_with_reporter_failure):
            flows = []
            for index in range(_REPORT_CAPACITY + _REPORT_WORKERS):
                flow = _make_flow(real_flow, proxy_log_path, response_status=503)
                flow.metadata[metadata_keys.SANDBOX_RUN_ID] = f"run-start-failed-{index}"
                model_provider_failure.admit_flow(flow)
                mitm_addon.responseheaders(flow)
                flows.append(flow)

        assert failed_starts == len(flows)
        assert all(not thread.is_alive() for thread in started_threads)
        assert model_provider_failure_api.request_count == 0
        model_provider_failure.drain_reports_for_tests(timeout=0)

        if shutdown_before_recovery:
            _restart_reporter_after_callbacks(model_provider_failure_api)

        _enqueue_provider_unavailable(real_flow, tmp_path / "worker-start-recovered.jsonl")
        model_provider_failure.drain_reports_for_tests()
        _restart_reporter_after_callbacks(model_provider_failure_api)

        [request] = model_provider_failure_api.requests
        assert request.path == "/api/runners/runs/run-model-failure/model-provider-failures"
        assert request.json_body() == {"failureKind": "provider_unavailable"}
        omissions = _report_omissions(proxy_log_path)
        assert len(omissions) == len(flows)
        assert {entry["flow_id"] for entry in omissions} == {flow.id for flow in flows}
        assert {entry["run_id"] for entry in omissions} == {
            f"run-start-failed-{index}" for index in range(len(flows))
        }
        assert all(entry["reason"] == "worker_start_failed" for entry in omissions)
        _assert_full_report_capacity(
            real_flow,
            tmp_path / "worker-start-capacity.jsonl",
            model_provider_failure_api,
        )
    finally:
        _restart_reporter_after_callbacks(model_provider_failure_api)
        for thread in started_threads:
            thread.join(timeout=1)
            assert not thread.is_alive()


def test_shutdown_cancels_queued_reports(
    tmp_path,
    real_flow,
    model_provider_failure_api,
):
    proxy_log_path = tmp_path / "shutdown.jsonl"
    release_delivery = threading.Event()
    executor_shutdown_started = threading.Event()
    for _ in range(_REPORT_WORKERS):
        model_provider_failure_api.queue_response(204, release_event=release_delivery)
    flows = [
        _enqueue_provider_unavailable(real_flow, proxy_log_path) for _ in range(_REPORT_CAPACITY)
    ]

    assert model_provider_failure_api.wait_for_request_count(_REPORT_WORKERS)

    original_shutdown = FailureReportExecutor.shutdown

    def observe_shutdown(
        executor: FailureReportExecutor,
        *,
        wait: bool,
    ) -> None:
        original_shutdown(executor, wait=wait)
        executor_shutdown_started.set()

    shutdown_thread = ThreadUnderTest(target=model_provider_failure.shutdown)
    try:
        with patch.object(FailureReportExecutor, "shutdown", observe_shutdown):
            shutdown_thread.start()
            wait_for_event(
                executor_shutdown_started,
                timeout=1,
                threads=(shutdown_thread,),
                message="failure reporter did not begin executor shutdown",
            )
            release_delivery.set()
            shutdown_thread.join_and_raise(timeout=3)
    finally:
        release_delivery.set()
        shutdown_thread.join(timeout=3)

    assert model_provider_failure_api.request_count == _REPORT_WORKERS
    _assert_queued_reports_cancelled(proxy_log_path, flows)

    _restart_reporter_after_callbacks(model_provider_failure_api)
    _assert_full_report_capacity(
        real_flow,
        tmp_path / "shutdown-recovery.jsonl",
        model_provider_failure_api,
    )


def test_shutdown_timeout_returns_with_running_reports_blocked(
    tmp_path,
    real_flow,
    model_provider_failure_api,
):
    proxy_log_path = tmp_path / "shutdown-timeout.jsonl"
    rejected_log_path = tmp_path / "shutdown-timeout-rejected.jsonl"
    release_delivery = threading.Event()
    executor_shutdown_started = threading.Event()
    continue_shutdown = threading.Event()
    for _ in range(_REPORT_WORKERS):
        model_provider_failure_api.queue_response(204, release_event=release_delivery)
    flows = [
        _enqueue_provider_unavailable(real_flow, proxy_log_path) for _ in range(_REPORT_CAPACITY)
    ]

    assert model_provider_failure_api.wait_for_request_count(_REPORT_WORKERS)

    original_shutdown = FailureReportExecutor.shutdown

    def pause_after_executor_shutdown(
        executor: FailureReportExecutor,
        *,
        wait: bool,
    ) -> None:
        original_shutdown(executor, wait=wait)
        executor_shutdown_started.set()
        if not continue_shutdown.wait(timeout=1):
            raise AssertionError("failure reporter shutdown test did not release executor shutdown")

    shutdown_thread = ThreadUnderTest(target=model_provider_failure.shutdown)
    try:
        with (
            patch.object(model_provider_failure, "_REPORT_TIMEOUT_SECONDS", 0.01),
            patch.object(FailureReportExecutor, "shutdown", pause_after_executor_shutdown),
        ):
            shutdown_thread.start()
            wait_for_event(
                executor_shutdown_started,
                timeout=1,
                threads=(shutdown_thread,),
                message="failure reporter did not begin executor shutdown",
            )
            assert shutdown_thread.is_alive()

            rejected_flow = _enqueue_provider_unavailable(real_flow, rejected_log_path)
            assert model_provider_failure_api.request_count == _REPORT_WORKERS
            _assert_single_report_omission(
                rejected_log_path,
                flow_id=rejected_flow.id,
                reason="reporting_not_configured",
            )

            continue_shutdown.set()
            shutdown_thread.join_and_raise(timeout=1)

        assert not release_delivery.is_set()
    finally:
        continue_shutdown.set()
        release_delivery.set()
        shutdown_thread.join(timeout=1)
        model_provider_failure.drain_reports_for_tests()

    assert model_provider_failure_api.request_count == _REPORT_WORKERS
    _assert_queued_reports_cancelled(proxy_log_path, flows)

    _restart_reporter_after_callbacks(model_provider_failure_api)
    _assert_full_report_capacity(
        real_flow,
        tmp_path / "shutdown-timeout-recovery.jsonl",
        model_provider_failure_api,
    )


@pytest.mark.parametrize(
    ("status", "retry_after", "expected_kind", "expected_seconds"),
    [
        (429, "0", "rate_limit", 1),
        (429, "000120", "rate_limit", 120),
        (503, "301", "provider_unavailable", 300),
        pytest.param(
            503,
            "9" * 5_000,
            "provider_unavailable",
            300,
            id="long-numeric-delay",
        ),
        pytest.param(
            429,
            "0" * (_RETRY_AFTER_VALUE_LIMIT - 3) + "120",
            "rate_limit",
            120,
            id="leading-zeroes-at-value-limit",
        ),
        pytest.param(
            503,
            "9" * _RETRY_AFTER_VALUE_LIMIT,
            "provider_unavailable",
            300,
            id="clamped-at-value-limit",
        ),
        pytest.param(
            429,
            "0" * _RETRY_AFTER_VALUE_LIMIT,
            "rate_limit",
            1,
            id="zero-at-value-limit",
        ),
    ],
)
def test_numeric_retry_after_is_clamped(
    tmp_path,
    real_flow,
    mitm_ctx,
    status: int,
    retry_after: str,
    expected_kind: str,
    expected_seconds: int,
    model_provider_failure_api,
):
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        response_status=status,
        response_headers=header_map({"retry-after": retry_after}),
    )

    _finish_http_flow(flow, body=None, mitm_ctx=mitm_ctx)

    assert _reported_payloads(model_provider_failure_api) == [
        {"failureKind": expected_kind, "retryAfterSeconds": expected_seconds}
    ]


@pytest.mark.parametrize(
    ("status", "retry_after_values", "expected_kind"),
    [
        (429, (), "rate_limit"),
        (429, ("",), "rate_limit"),
        (429, ("invalid",), "rate_limit"),
        (429, ("Fri, 21 Aug 2026 12:00:00 GMT",), "rate_limit"),
        (429, ("120", "121"), "rate_limit"),
        (429, ("", "120"), "rate_limit"),
        (429, (" 120",), "rate_limit"),
        (429, ("120\t",), "rate_limit"),
        (429, ("١٢٠",), "rate_limit"),
        (429, ("120,121",), "rate_limit"),
        pytest.param(
            503,
            ("9" * (_RETRY_AFTER_VALUE_LIMIT + 1),),
            "provider_unavailable",
            id="over-value-limit",
        ),
        (401, ("120",), "authentication"),
    ],
)
def test_unusable_retry_after_is_omitted(
    tmp_path,
    real_flow,
    mitm_ctx,
    status: int,
    retry_after_values: tuple[str, ...],
    expected_kind: str,
    model_provider_failure_api,
):
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        response_status=status,
        response_headers=http.Headers(
            [(b"retry-after", value.encode()) for value in retry_after_values]
        ),
    )

    _finish_http_flow(flow, body=None, mitm_ctx=mitm_ctx)

    assert _reported_payloads(model_provider_failure_api) == [{"failureKind": expected_kind}]


def _assert_retry_after_header_report(
    flow: http.HTTPFlow,
    model_provider_failure_api,
    expected_payload: dict[str, object],
) -> None:
    assert flow.response is not None
    fields = flow.response.headers.fields
    model_provider_failure.admit_flow(flow)
    original_native = http._native

    def reject_oversized_conversion(value: bytes) -> str:
        assert len(value) <= _RETRY_AFTER_VALUE_LIMIT, "decoded an oversized header value"
        return original_native(value)

    with patch.object(http, "_native", reject_oversized_conversion):
        mitm_addon.responseheaders(flow)

    assert _reported_payloads(model_provider_failure_api) == [expected_payload]
    assert flow.response.headers.fields == fields
    model_provider_failure.release_flow(flow)


@pytest.mark.parametrize(
    ("status", "failure_kind"), [(429, "rate_limit"), (503, "provider_unavailable")]
)
@pytest.mark.parametrize("padding", [b"0", b"\xff"], ids=["ascii", "non-utf8"])
@pytest.mark.parametrize("copies", [1, 2], ids=["singleton", "duplicate"])
def test_retry_after_http1_oversized_values_are_omitted_without_conversion(
    tmp_path, real_flow, model_provider_failure_api, status, failure_kind, padding, copies
):
    flow = _make_flow(real_flow, tmp_path / "proxy.jsonl")
    value = padding * (1024 * 1024) + b"120"
    flow.response = http1.read_response_head(
        [f"HTTP/1.1 {status} Error".encode(), *[b"Retry-After: " + value] * copies]
    )

    _assert_retry_after_header_report(
        flow, model_provider_failure_api, {"failureKind": failure_kind}
    )


class _UninspectedRetryAfter(bytes):
    def __bytes__(self) -> bytes:
        raise AssertionError("copied an unusable Retry-After value")

    def decode(self, encoding: str = "utf-8", errors: str = "strict") -> str:
        raise AssertionError("decoded an unusable Retry-After value")

    def isdigit(self) -> bool:
        raise AssertionError("scanned an unusable Retry-After value")

    def lstrip(self, chars: bytes | None = None) -> bytes:
        raise AssertionError("stripped an unusable Retry-After value")

    def strip(self, chars: bytes | None = None) -> bytes:
        raise AssertionError("stripped an unusable Retry-After value")


@pytest.mark.parametrize(
    "values",
    [
        pytest.param((_UninspectedRetryAfter(b"120"), b"121"), id="duplicate"),
        pytest.param((_UninspectedRetryAfter(b""), b"120"), id="empty-first-duplicate"),
        pytest.param(
            (_UninspectedRetryAfter(b"0" * (_RETRY_AFTER_VALUE_LIMIT + 1)),), id="oversized"
        ),
    ],
)
def test_retry_after_rejects_unusable_values_before_inspection(
    tmp_path, real_flow, model_provider_failure_api, values
):
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        response_status=429,
        response_headers=http.Headers((b"Retry-After", value) for value in values),
    )

    _assert_retry_after_header_report(
        flow, model_provider_failure_api, {"failureKind": "rate_limit"}
    )


class _UnnormalizedRetryAfterName(bytes):
    def lower(self) -> bytes:
        raise AssertionError("normalized a header name before checking its budget")


@pytest.mark.parametrize("field_count", [_RETRY_AFTER_FIELD_LIMIT, _RETRY_AFTER_FIELD_LIMIT + 1])
def test_retry_after_header_field_budget(
    tmp_path, real_flow, model_provider_failure_api, field_count
):
    fields = ((b"X-Padding", b""),) * (field_count - 1) + ((b"rEtRy-AfTeR", b"120"),)
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        response_status=429,
        response_headers=http.Headers(fields),
    )
    expected: dict[str, object] = {"failureKind": "rate_limit"}
    if field_count <= _RETRY_AFTER_FIELD_LIMIT:
        expected["retryAfterSeconds"] = 120

    _assert_retry_after_header_report(flow, model_provider_failure_api, expected)


def test_retry_after_checks_late_duplicate_before_inspection(
    tmp_path, real_flow, model_provider_failure_api
):
    fields = (
        ((b"Retry-After", _UninspectedRetryAfter(b"120")),)
        + ((b"X-Padding", b""),) * (_RETRY_AFTER_FIELD_LIMIT - 2)
        + ((b"RETRY-AFTER", b"121"),)
    )
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        response_status=429,
        response_headers=http.Headers(fields),
    )

    _assert_retry_after_header_report(
        flow, model_provider_failure_api, {"failureKind": "rate_limit"}
    )


@pytest.mark.parametrize("excess_fields", [False, True], ids=["oversized-name", "excess-fields"])
def test_retry_after_response_hook_checks_budgets_before_normalizing_names(
    tmp_path, real_flow, model_provider_failure_api, *, excess_fields
):
    fields = (
        ((_UnnormalizedRetryAfterName(b"Retry-After"), b"120"),) * (_RETRY_AFTER_FIELD_LIMIT + 1)
        if excess_fields
        else ((_UnnormalizedRetryAfterName(b"X" * (1024 * 1024)), b""), (b"Retry-After", b"120"))
    )
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        response_status=429,
        response_headers=http.Headers(fields),
    )
    expected: dict[str, object] = {"failureKind": "rate_limit"}
    if not excess_fields:
        expected["retryAfterSeconds"] = 120

    _assert_retry_after_header_report(flow, model_provider_failure_api, expected)

    assert flow.response.status_code == 429
    assert flow.response.headers.fields == fields
    assert response_stream(flow)(b"upstream-error") == b"upstream-error"
    assert response_stream(flow)(b"") == b""


def test_later_success_does_not_retract_report(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    proxy_log_path = tmp_path / "proxy.jsonl"
    failed_flow = _make_flow(real_flow, proxy_log_path, response_status=503)
    _finish_http_flow(failed_flow, body=None, mitm_ctx=mitm_ctx)

    success_body = b'{"choices":[]}'
    success_flow = _make_flow(real_flow, proxy_log_path, response_body=success_body)
    _finish_http_flow(success_flow, body=success_body, mitm_ctx=mitm_ctx)

    assert _reported_payloads(model_provider_failure_api) == [
        {"failureKind": "provider_unavailable"}
    ]


@pytest.mark.parametrize(
    ("request_method", "response_status"),
    [
        pytest.param("POST", 103, id="informational"),
        pytest.param("POST", 204, id="no-content"),
        pytest.param("POST", 205, id="reset-content"),
        pytest.param("POST", 304, id="not-modified"),
        pytest.param("HEAD", 200, id="head"),
        pytest.param("CONNECT", 200, id="successful-connect"),
    ],
)
def test_bodyless_response_skips_usage_and_failure_observers(
    tmp_path,
    real_flow,
    mitm_ctx,
    request_method: str,
    response_status: int,
    model_provider_failure_api,
):
    body = b'{"status":"failed","error":{"code":"server_error"}}'
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        request_path="/v1/responses",
        request_method=request_method,
        response_status=response_status,
        response_body=body,
        response_headers=header_map({"content-type": "application/json"}),
    )
    flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "gpt-5.5"

    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)

    assert "model_json_usage_finish" not in flow.metadata
    assert "model_sse_usage_finish" not in flow.metadata
    stream = response_stream(flow)
    assert stream(body) == body
    stream(b"")
    with mitm_ctx():
        mitm_addon.response(flow)

    assert _reported_payloads(model_provider_failure_api) == []


@pytest.mark.parametrize(
    ("content_types", "body", "usage_finish_key"),
    [
        pytest.param(
            (b"Text/Event-Stream; Charset=UTF-8",),
            b"event: error\n"
            b'data: {"type":"error","code":"server_error",'
            b'"message":"provider failed","param":null}\n\n',
            "model_sse_usage_finish",
            id="parameterized-sse",
        ),
        pytest.param(
            (b'application/json; profile="text/event-stream"',),
            b'{"status":"failed","error":{"code":"server_error"}}',
            "model_json_usage_finish",
            id="sse-profile-lookalike",
        ),
        pytest.param(
            (b"text/event-stream+json",),
            b'{"status":"failed","error":{"code":"server_error"}}',
            "model_json_usage_finish",
            id="sse-suffix-lookalike",
        ),
        pytest.param(
            (b"text/event-stream; pad=" + b"\xff" * (1024 * 1024),),
            b"event: error\n"
            b'data: {"type":"error","code":"server_error",'
            b'"message":"provider failed","param":null}\n\n',
            "model_sse_usage_finish",
            id="oversized-parameterized-sse",
        ),
        pytest.param(
            (b"text/event-stream; charset=utf-8", b"\xff" * (1024 * 1024)),
            b'{"status":"failed","error":{"code":"server_error"}}',
            "model_json_usage_finish",
            id="repeated-content-type",
        ),
        pytest.param(
            (b"text/event-stream" + b" " * (8 * 1024),),
            b'{"status":"failed","error":{"code":"server_error"}}',
            "model_json_usage_finish",
            id="exhausted-media-type-prefix",
        ),
    ],
)
def test_media_type_classification_is_shared_by_usage_and_failure_observers(
    tmp_path,
    real_flow,
    mitm_ctx,
    content_types: tuple[bytes, ...],
    body: bytes,
    usage_finish_key: str,
    model_provider_failure_api,
):
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        request_path="/v1/responses",
        response_body=body,
        response_headers=http.Headers((b"Content-Type", value) for value in content_types),
    )
    flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "gpt-5.5"
    assert flow.response is not None
    original_fields = flow.response.headers.fields
    original_native = http._native

    def reject_oversized_conversion(value: bytes) -> str:
        assert len(value) <= 8 * 1024, "shared classifier decoded an oversized header"
        return original_native(value)

    model_provider_failure.admit_flow(flow)
    with patch.object(http, "_native", reject_oversized_conversion):
        mitm_addon.responseheaders(flow)

    assert flow.response.headers.fields == original_fields
    assert usage_finish_key in flow.metadata
    other_usage_finish_key = (
        "model_json_usage_finish"
        if usage_finish_key == "model_sse_usage_finish"
        else "model_sse_usage_finish"
    )
    assert other_usage_finish_key not in flow.metadata
    stream = response_stream(flow)
    assert stream(body) == body
    stream(b"")
    with mitm_ctx():
        mitm_addon.response(flow)

    assert _reported_payloads(model_provider_failure_api) == [
        {"failureKind": "provider_unavailable"}
    ]


@pytest.mark.parametrize("content_encoding", ["", "gzip", "deflate"])
def test_combined_sse_response_uses_one_decoder_and_one_dense_event_parse(
    tmp_path,
    real_flow,
    mitm_ctx,
    content_encoding: str,
    model_provider_failure_api,
):
    dense_values = b",".join([b"0"] * 2_000)
    plaintext = (
        b"event: response.failed\n"
        b'data: {"type":"response.failed","response":{"id":"resp-shared",'
        b'"model":"gpt-5.5","usage":{"input_tokens":12,"output_tokens":3},'
        b'"error":{"code":"server_error"}},"padding":[' + dense_values + b"]}\n\n"
    )
    if content_encoding == "gzip":
        body = gzip.compress(plaintext)
    elif content_encoding == "deflate":
        body = zlib.compress(plaintext)
    else:
        body = plaintext
    headers = {"content-type": "text/event-stream"}
    if content_encoding:
        headers["content-encoding"] = content_encoding
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        request_path="/v1/responses",
        response_body=body,
        response_headers=header_map(headers),
    )
    flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "gpt-5.5"
    model_provider_failure.admit_flow(flow)

    with (
        patch.object(
            body_decoding,
            "create_stream_decode_session",
            wraps=body_decoding.create_stream_decode_session,
        ) as create_decoder,
        patch.object(
            openai_responses,
            "JsonSelectiveExtractor",
            wraps=openai_responses.JsonSelectiveExtractor,
        ) as create_extractor,
    ):
        mitm_addon.responseheaders(flow)
        stream = response_stream(flow)
        stream(body)
        stream(b"")
        with mitm_ctx():
            mitm_addon.response(flow)

        assert create_decoder.call_count == 1
        assert create_extractor.call_count == 1

    assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == {
        "message_id": "resp-shared",
        "model": "gpt-5.5",
        "tokens.input": 12,
        "tokens.output": 3,
    }
    assert _reported_payloads(model_provider_failure_api) == [
        {"failureKind": "provider_unavailable"}
    ]


@pytest.mark.parametrize("content_encoding", ["", "zstd"])
def test_combined_json_response_uses_one_decoder_and_one_parse(
    tmp_path,
    real_flow,
    mitm_ctx,
    content_encoding: str,
    model_provider_failure_api,
):
    body = (
        b'{"id":"resp-json","model":"gpt-5.5","status":"failed",'
        b'"usage":{"input_tokens":9,"output_tokens":4},'
        b'"error":{"code":"server_error"}}'
    )
    wire_body = zstandard.ZstdCompressor().compress(body) if content_encoding else body
    response_headers = {"content-type": "application/json"}
    if content_encoding:
        response_headers["content-encoding"] = content_encoding
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        request_path="/v1/responses",
        response_body=wire_body,
        response_headers=header_map(response_headers),
    )
    flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "gpt-5.5"
    model_provider_failure.admit_flow(flow)

    with (
        patch.object(
            body_decoding,
            "create_stream_decode_session",
            wraps=body_decoding.create_stream_decode_session,
        ) as create_decoder,
        patch.object(
            model_json,
            "JsonSelectiveExtractor",
            wraps=model_json.JsonSelectiveExtractor,
        ) as create_extractor,
        patch.object(
            model_provider_failure,
            "JsonSelectiveExtractor",
            wraps=model_provider_failure.JsonSelectiveExtractor,
        ) as create_legacy_extractor,
        patch.object(
            openai_responses,
            "JsonSelectiveExtractor",
            wraps=openai_responses.JsonSelectiveExtractor,
        ) as create_legacy_usage_extractor,
        patch.object(
            body_decoding,
            "decompress_json_usage_body",
            wraps=body_decoding.decompress_json_usage_body,
        ) as decompress_body,
    ):
        mitm_addon.responseheaders(flow)
        stream = response_stream(flow)
        stream(wire_body)
        stream(b"")
        with mitm_ctx():
            mitm_addon.response(flow)

        assert create_decoder.call_count == 1
        assert create_extractor.call_count == 1
        assert create_legacy_extractor.call_count == 0
        assert create_legacy_usage_extractor.call_count == 0
        assert decompress_body.call_count == (1 if content_encoding else 0)

    assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == {
        "message_id": "resp-json",
        "model": "gpt-5.5",
        "tokens.input": 9,
        "tokens.output": 4,
    }
    assert _reported_payloads(model_provider_failure_api) == [
        {"failureKind": "provider_unavailable"}
    ]


def test_failure_only_zstd_json_response_uses_bounded_buffer(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    body = b'{"type":"response.failed","error":{"code":"server_error"}}'
    wire_body = zstandard.ZstdCompressor().compress(body)
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        request_path="/v1/responses",
        response_body=wire_body,
        response_headers=header_map(
            {"content-type": "application/json", "content-encoding": "zstd"}
        ),
    )
    model_provider_failure.admit_flow(flow)

    mitm_addon.responseheaders(flow)

    assert metadata_keys.MODEL_USAGE_PROVIDER not in flow.metadata
    assert metadata_keys.STREAM_BUFFER in flow.metadata
    stream = response_stream(flow)
    stream(wire_body)
    stream(b"")
    with mitm_ctx():
        mitm_addon.response(flow)

    assert _reported_payloads(model_provider_failure_api) == [
        {"failureKind": "provider_unavailable"}
    ]


def test_truncated_zstd_json_buffer_does_not_report_failure(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    padding = hashlib.shake_256(b"vm0-zstd-failure-buffer").hexdigest(STREAM_BUFFER_LIMIT * 2)
    body = (
        b'{"type":"response.failed","error":{"code":"server_error"},"padding":"'
        + padding.encode()
        + b'"}'
    )
    wire_body = zstandard.ZstdCompressor().compress(body)
    assert len(wire_body) > STREAM_BUFFER_LIMIT
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        request_path="/v1/responses",
        response_body=wire_body,
        response_headers=header_map(
            {"content-type": "application/json", "content-encoding": "zstd"}
        ),
    )
    model_provider_failure.admit_flow(flow)

    mitm_addon.responseheaders(flow)
    stream = response_stream(flow)
    stream(wire_body)
    assert flow.metadata[metadata_keys.STREAM_BUFFER_STATE]["truncated"] is True
    stream(b"")
    with mitm_ctx():
        mitm_addon.response(flow)

    assert _reported_payloads(model_provider_failure_api) == []


def test_combined_sse_known_ordinary_deltas_skip_full_json_parse(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    cases = (
        (
            "model-provider:openai-api-key",
            "/v1/responses",
            b"event: response.output_text.delta\n"
            b'data: {"type":"response.output_text.delta","delta":"hello"}\n\n',
            openai_responses,
        ),
        (
            "model-provider:anthropic-api-key",
            "/v1/messages",
            b"event: content_block_delta\n"
            b'data: {"type":"content_block_delta","delta":{"text":"hello"}}\n\n',
            anthropic_messages,
        ),
    )

    for index, (firewall_name, request_path, body, provider_module) in enumerate(cases):
        flow = _make_flow(
            real_flow,
            tmp_path / f"proxy-{index}.jsonl",
            firewall_name=firewall_name,
            request_path=request_path,
            response_body=body,
            response_headers=header_map({"content-type": "text/event-stream"}),
        )
        flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "test-model"
        model_provider_failure.admit_flow(flow)
        with patch.object(
            provider_module,
            "JsonSelectiveExtractor",
            wraps=provider_module.JsonSelectiveExtractor,
        ) as create_extractor:
            mitm_addon.responseheaders(flow)
            stream = response_stream(flow)
            stream(body)
            stream(b"")
            with mitm_ctx():
                mitm_addon.response(flow)

            assert create_extractor.call_count == 0

    assert _reported_payloads(model_provider_failure_api) == []


def test_combined_sse_work_limit_does_not_retry_full_parse(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    proxy_log_path = tmp_path / "proxy.jsonl"
    dense_values = b",".join([b"0"] * 40_000)
    body = (
        b"event: response.completed\n"
        b'data: {"type":"response.completed","response":{"id":"resp-limited",'
        b'"model":"gpt-5.5","usage":{"input_tokens":12,"output_tokens":3}},'
        b'"padding":[' + dense_values + b"]}\n\n"
    )
    flow = _make_flow(
        real_flow,
        proxy_log_path,
        request_path="/v1/responses",
        response_body=body,
        response_headers=header_map({"content-type": "text/event-stream"}),
    )
    flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "gpt-5.5"
    model_provider_failure.admit_flow(flow)

    with (
        patch.object(
            openai_responses,
            "JsonSelectiveExtractor",
            wraps=openai_responses.JsonSelectiveExtractor,
        ) as create_extractor,
        patch.object(
            model_provider_failure,
            "JsonSelectiveExtractor",
            wraps=model_provider_failure.JsonSelectiveExtractor,
        ) as create_legacy_extractor,
        mitm_ctx(),
    ):
        mitm_addon.responseheaders(flow)
        stream = response_stream(flow)
        stream(body)
        stream(b"")
        mitm_addon.response(flow)

        assert create_extractor.call_count == 1
        assert create_legacy_extractor.call_count == 0

    assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == {}
    warnings = [
        entry
        for entry in read_jsonl_entries_after_flush(proxy_log_path)
        if entry.get("message") == "Model provider SSE usage extraction failed"
    ]
    assert [warning["error"] for warning in warnings] == ["work limit exceeded"]
    assert _reported_payloads(model_provider_failure_api) == []


def test_combined_sse_failure_field_overflow_preserves_usage_and_fails_closed(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    body = (
        b"event: response.failed\n"
        b'data: {"type":"response.failed","response":{"id":"resp-overflow",'
        b'"model":"gpt-5.5","usage":{"input_tokens":8,"output_tokens":2},'
        b'"error":{"code":"' + b"x" * 129 + b'"}}}\n\n'
    )
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        request_path="/v1/responses",
        response_body=body,
        response_headers=header_map({"content-type": "text/event-stream"}),
    )
    flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "gpt-5.5"
    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)
    stream = response_stream(flow)
    stream(body)
    stream(b"")
    with mitm_ctx():
        mitm_addon.response(flow)

    assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == {
        "message_id": "resp-overflow",
        "model": "gpt-5.5",
        "tokens.input": 8,
        "tokens.output": 2,
    }
    assert _reported_payloads(model_provider_failure_api) == []


def test_combined_sse_overlapping_escaped_field_keeps_failure_byte_limit(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    body = (
        b"event: response.failed\n"
        b'data: {"type":"'
        + rb"\u0061"
        * 22
        + b'","type":"response.failed","response":{"id":"resp-escaped",'
        b'"model":"gpt-5.5","usage":{"input_tokens":5,"output_tokens":1},'
        b'"error":{"code":"server_error"}}}\n\n'
    )
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        request_path="/v1/responses",
        response_body=body,
        response_headers=header_map({"content-type": "text/event-stream"}),
    )
    flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "gpt-5.5"
    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)
    stream = response_stream(flow)
    stream(body)
    stream(b"")
    with mitm_ctx():
        mitm_addon.response(flow)

    assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == {
        "message_id": "resp-escaped",
        "model": "gpt-5.5",
        "tokens.input": 5,
        "tokens.output": 1,
    }
    assert _reported_payloads(model_provider_failure_api) == []


@pytest.mark.parametrize(
    ("firewall_name", "request_path", "body", "expected_kind"),
    [
        (
            "model-provider:anthropic-api-key",
            "/v1/messages",
            b'{"type":"error","error":{"type":"overloaded_error"}}',
            "provider_unavailable",
        ),
        (
            "model-provider:openai-api-key",
            "/v1/chat/completions",
            b'{"error":{"code":"invalid_api_key"}}',
            "authentication",
        ),
        (
            "model-provider:openai-api-key",
            "/v1/chat/completions",
            b'{"error":{"code":"insufficient_quota"}}',
            "billing",
        ),
        (
            "model-provider:openai-api-key",
            "/v1/chat/completions",
            b'{"error":{"code":"rate_limit_error"}}',
            "rate_limit",
        ),
        (
            "model-provider:openai-api-key",
            "/v1/chat/completions",
            b'{"error":{"code":"timeout_error"}}',
            "timeout",
        ),
        (
            "model-provider:openai-api-key",
            "/v1/chat/completions",
            b'{"error":{"code":"connection_error"}}',
            "connection",
        ),
        (
            "model-provider:openai-api-key",
            "/v1/responses",
            b'{"status":"failed","error":{"code":"server_error"}}',
            "provider_unavailable",
        ),
        (
            "model-provider:deepseek",
            "/responses",
            b'{"status":"failed","error":{"code":"server_error"}}',
            "provider_unavailable",
        ),
    ],
)
def test_protocol_json_failures_are_reported(
    tmp_path,
    real_flow,
    mitm_ctx,
    firewall_name: str,
    request_path: str,
    body: bytes,
    expected_kind: str,
    model_provider_failure_api,
):
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        firewall_name=firewall_name,
        request_path=request_path,
        response_body=body,
    )

    _finish_http_flow(flow, body=body, mitm_ctx=mitm_ctx)

    expected_payload = {"failureKind": expected_kind}
    if expected_kind == "connection":
        expected_payload["connectionSource"] = "provider_response"
    assert _reported_payloads(model_provider_failure_api) == [expected_payload]


@pytest.mark.parametrize(
    ("request_path", "response_status"),
    [
        ("/v1/models", 429),
        ("/v1/chat/completions", 403),
    ],
)
def test_ineligible_http_response_is_not_reported(
    tmp_path,
    real_flow,
    mitm_ctx,
    request_path: str,
    response_status: int,
    model_provider_failure_api,
):
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        request_path=request_path,
        response_status=response_status,
    )

    _finish_http_flow(flow, body=None, mitm_ctx=mitm_ctx)

    assert _reported_payloads(model_provider_failure_api) == []


@pytest.mark.parametrize(
    ("firewall_name", "request_path"),
    [
        ("model-provider:openrouter-api-key", "/api/v1/messages"),
        ("model-provider:openrouter-codex", "/api/v1/responses"),
    ],
)
@pytest.mark.parametrize(
    ("body", "expected_payloads"),
    [
        (
            b'{"error":{"code":400,"message":"Invalid tool definition: '
            b'function is required","metadata":{"error_type":"invalid_request"}}}',
            [],
        ),
        (
            b'{"error":{"metadata":{"error_type":"provider_unavailable"}}}',
            [{"failureKind": "provider_unavailable"}],
        ),
    ],
)
def test_openrouter_http_500_is_classified_from_body(
    tmp_path,
    real_flow,
    mitm_ctx,
    firewall_name: str,
    request_path: str,
    body: bytes,
    expected_payloads: list[dict[str, str]],
    model_provider_failure_api,
):
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        firewall_name=firewall_name,
        request_path=request_path,
        response_status=500,
        response_body=body,
    )

    _finish_http_flow(flow, body=body, mitm_ctx=mitm_ctx)

    assert _reported_payloads(model_provider_failure_api) == expected_payloads


def test_overlapping_inference_flows_report_independent_failures(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    proxy_log_path = tmp_path / "proxy.jsonl"
    first_flow = _make_flow(real_flow, proxy_log_path, response_status=429)
    second_flow = _make_flow(real_flow, proxy_log_path, response_status=503)
    model_provider_failure.admit_flow(first_flow)
    model_provider_failure.admit_flow(second_flow)

    for flow in (first_flow, second_flow):
        mitm_addon.responseheaders(flow)
        with mitm_ctx():
            mitm_addon.response(flow)

    payloads = _reported_payloads(model_provider_failure_api)
    assert len(payloads) == 2
    assert {"failureKind": "rate_limit"} in payloads
    assert {"failureKind": "provider_unavailable"} in payloads


@pytest.mark.parametrize(
    ("firewall_name", "request_path", "body", "expected_kind"),
    [
        (
            "model-provider:anthropic-api-key",
            "/v1/messages",
            b'event: error\ndata: {"type":"error","error":{"type":"api_error"}}\n\n',
            "provider_unavailable",
        ),
        (
            "model-provider:openrouter-codex",
            "/api/v1/chat/completions",
            b'data: {"choices":[{"error":{"metadata":{"error_type":"provider_overloaded"}}}]}\n\n',
            "provider_unavailable",
        ),
        (
            "model-provider:openrouter-codex",
            "/api/v1/responses",
            b"event: response.failed\n"
            b'data: {"type":"response.failed","response":{"status":"failed",'
            b'"error":{"code":"server_error"},"error_type":"authentication"}}\n\n',
            "authentication",
        ),
        (
            "model-provider:openai-api-key",
            "/v1/responses",
            b"event: error\n"
            b'data: {"type":"error","code":"server_error",'
            b'"message":"provider failed","param":null}\n\n',
            "provider_unavailable",
        ),
        (
            "model-provider:openai-api-key",
            "/v1/responses",
            b"event: response.failed\n"
            b'data: {"type":"response.failed","response":{'
            b'"error":{"code":"connection"}}}\n\n',
            "connection",
        ),
    ],
)
def test_protocol_sse_failures_are_reported(
    tmp_path,
    real_flow,
    mitm_ctx,
    firewall_name: str,
    request_path: str,
    body: bytes,
    expected_kind: str,
    model_provider_failure_api,
):
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        firewall_name=firewall_name,
        request_path=request_path,
        response_body=body,
        response_headers=header_map({"content-type": "text/event-stream"}),
    )

    _finish_http_flow(flow, body=body, mitm_ctx=mitm_ctx)

    expected_payload = {"failureKind": expected_kind}
    if expected_kind == "connection":
        expected_payload["connectionSource"] = "provider_response"
    assert _reported_payloads(model_provider_failure_api) == [expected_payload]


@pytest.mark.parametrize("payload_size", [4095, 4096, 4097])
@pytest.mark.parametrize("chunk_size", [None, 7], ids=["whole", "split"])
@pytest.mark.parametrize(
    ("event_name", "reports_later_failure"),
    [
        ("response.completed", False),
        ("response.done", False),
        ("response.failed", False),
        ("response.incomplete", False),
        ("response.error", False),
        ("error", False),
        ("vendor.delta", False),
        ("response.output_text.delta", True),
        (None, True),
    ],
)
def test_responses_sse_capture_keeps_framing_identity_across_prefix_bound(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
    payload_size: int,
    chunk_size: int | None,
    event_name: str | None,
    reports_later_failure: bool,
):
    payload_prefix = b'{"type":"response.output_text.delta","padding":"'
    payload = payload_prefix + b"x" * (payload_size - len(payload_prefix) - 2) + b'"}'
    event_prefix = b"" if event_name is None else f"event: {event_name}\n".encode()
    body = (
        event_prefix + b"data: " + payload + b"\n\n"
        b"event: response.failed\n"
        b'data: {"type":"response.failed","response":{'
        b'"error":{"code":"server_error"}}}\n\n'
    )
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        request_path="/v1/responses",
        response_body=body,
        response_headers=header_map({"content-type": "text/event-stream"}),
    )

    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)
    stream = response_stream(flow)
    chunk_size = len(body) if chunk_size is None else chunk_size
    for offset in range(0, len(body), chunk_size):
        chunk = body[offset : offset + chunk_size]
        assert stream(chunk) == chunk
    assert stream(b"") == b""

    expected = [{"failureKind": "provider_unavailable"}] if reports_later_failure else []
    assert _reported_payloads(model_provider_failure_api) == expected

    with mitm_ctx():
        mitm_addon.response(flow)

    assert _reported_payloads(model_provider_failure_api) == expected


def test_conflicting_sse_event_type_is_not_reported(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    body = (
        b"event: response.completed\n"
        b'data: {"type":"response.failed","response":{'
        b'"error":{"code":"server_error"}}}\n\n'
    )
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        request_path="/v1/responses",
        response_body=body,
        response_headers=header_map({"content-type": "text/event-stream"}),
    )

    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)
    response_stream(flow)(body)

    assert _reported_payloads(model_provider_failure_api) == []

    with mitm_ctx():
        mitm_addon.response(flow)


def test_uninspectable_billable_success_is_not_reported_as_provider_failure(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        firewall_name="model-provider:anthropic-api-key",
        request_path="/v1/messages",
        response_headers=header_map(
            {
                "content-type": "text/event-stream",
                "content-encoding": "zstd",
            }
        ),
    )
    flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "claude-sonnet-4-6"
    flow.metadata[metadata_keys.RESPONSE_ENCODING_NEGOTIATION] = "already_stream_decodable"

    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)

    assert flow.response is not None
    assert flow.response.status_code == 502
    stream = response_stream(flow)
    assert stream(b"uninspectable upstream bytes") == b""
    assert stream(b"") == b""

    with mitm_ctx():
        mitm_addon.response(flow)

    assert _reported_payloads(model_provider_failure_api) == []


def test_sse_failure_is_reported_before_response_hook(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    body = (
        b"event: response.failed\n"
        b'data: {"type":"response.failed","response":{'
        b'"error":{"code":"server_error"}}}\n\n'
    )
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        request_path="/v1/responses",
        response_body=body,
        response_headers=header_map({"content-type": "text/event-stream"}),
    )
    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)
    response_stream(flow)(body)

    assert _reported_payloads(model_provider_failure_api) == [
        {"failureKind": "provider_unavailable"}
    ]

    with mitm_ctx():
        mitm_addon.response(flow)


def test_discarded_sse_failure_settles_unknown_before_later_failure(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    body = (
        b"event: response.failed\n"
        b'data: {"type":"response.failed","response":{\n' + b"x" * 4097 + b"\n\n"
        b"event: response.failed\n"
        b'data: {"type":"response.failed","response":{'
        b'"error":{"code":"server_error"}}}\n\n'
    )
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        request_path="/v1/responses",
        response_body=body,
        response_headers=header_map({"content-type": "text/event-stream"}),
    )
    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)
    stream = response_stream(flow)
    stream(body)
    stream(b"")

    assert _reported_payloads(model_provider_failure_api) == []

    with mitm_ctx():
        mitm_addon.response(flow)

    assert _reported_payloads(model_provider_failure_api) == []


def test_json_failure_is_reported_at_stream_end_before_response_hook(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    body = b'{"status":"failed","error":{"code":"server_error"}}'
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        request_path="/v1/responses",
        response_body=body,
    )
    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)
    stream = response_stream(flow)
    stream(body)

    assert _reported_payloads(model_provider_failure_api) == []

    stream(b"")

    assert _reported_payloads(model_provider_failure_api) == [
        {"failureKind": "provider_unavailable"}
    ]

    with mitm_ctx():
        mitm_addon.response(flow)


def test_connection_error_is_reported(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    _finish_upstream_transport_failure(real_flow, tmp_path / "proxy.jsonl", mitm_ctx)

    assert _reported_payloads(model_provider_failure_api) == [
        {
            "failureKind": "connection",
            "connectionSource": "upstream_transport",
        }
    ]


def test_client_disconnect_is_not_reported(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    flow = _make_flow(real_flow, tmp_path / "proxy.jsonl")
    flow.response = None
    flow.client_conn.state = ConnectionState.CLOSED
    flow.server_conn.state = ConnectionState.OPEN
    model_provider_failure.admit_flow(flow)
    flow.error = Error("client disconnected")

    with mitm_ctx():
        mitm_addon.error(flow)

    assert _reported_payloads(model_provider_failure_api) == []


def test_terminal_sse_success_wins_over_late_connection_error(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    body = b'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        firewall_name="model-provider:anthropic-api-key",
        request_path="/v1/messages",
        response_body=body,
        response_headers=header_map({"content-type": "text/event-stream"}),
    )
    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)
    response_stream(flow)(body)
    flow.error = Error("connection reset after terminal event")

    with mitm_ctx():
        mitm_addon.error(flow)

    assert _reported_payloads(model_provider_failure_api) == []


def test_generic_http_error_interruption_is_not_reported(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    flow = _make_flow(real_flow, tmp_path / "proxy.jsonl", response_status=400)
    model_provider_failure.admit_flow(flow)
    flow.error = Error("connection reset while reading error body")

    with mitm_ctx():
        mitm_addon.error(flow)

    assert _reported_payloads(model_provider_failure_api) == []


def test_openrouter_stable_failure_survives_response_interruption(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    body = b'{"error":{"metadata":{"error_type":"provider_unavailable"}}}'
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        firewall_name="model-provider:openrouter-codex",
        request_path="/api/v1/responses",
        response_status=500,
        response_body=body,
    )
    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)
    response_stream(flow)(body)
    flow.error = Error("connection reset after error body")

    with mitm_ctx():
        mitm_addon.error(flow)

    assert _reported_payloads(model_provider_failure_api) == [
        {"failureKind": "provider_unavailable"}
    ]


def test_trailing_sse_failure_is_settled_once_during_response_interruption(
    tmp_path,
    real_flow,
    mitm_ctx,
    model_provider_failure_api,
):
    body = (
        b"event: response.failed\n"
        b'data: {"type":"response.failed","response":{'
        b'"error":{"code":"connection_error"}}}'
    )
    flow = _make_flow(
        real_flow,
        tmp_path / "proxy.jsonl",
        request_path="/v1/responses",
        response_body=body,
        response_headers=header_map({"content-type": "text/event-stream"}),
    )
    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)
    response_stream(flow)(body)
    flow.error = Error("connection reset after trailing failure event")

    with mitm_ctx():
        mitm_addon.error(flow)

    assert _reported_payloads(model_provider_failure_api) == [
        {
            "failureKind": "connection",
            "connectionSource": "provider_response",
        }
    ]


@pytest.mark.parametrize(
    ("failure_code", "expected_payload"),
    [
        (
            "service_unavailable",
            {"failureKind": "provider_unavailable"},
        ),
        (
            "connection_error",
            {
                "failureKind": "connection",
                "connectionSource": "provider_response",
            },
        ),
    ],
)
def test_websocket_failure_is_reported(
    tmp_path,
    real_flow,
    mitm_ctx,
    monkeypatch: pytest.MonkeyPatch,
    failure_code: str,
    expected_payload: dict[str, str],
    model_provider_failure_api,
):
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    capture_deferred_websocket_trims(monkeypatch)
    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)
    full_body_feeds = capture_openai_responses_extractor_feeds(monkeypatch)
    failed_frame = (
        b'{"type":"response.failed","response":{"id":"resp-1",'
        b'"error":{"code":"' + failure_code.encode() + b'"}}}'
    )

    with mitm_ctx():
        mitm_addon.response(flow)
        feed_websocket_client_message(flow, b'{"type":"response.create"}')
        feed_websocket_server_message(
            flow,
            b'{"type":"response.created","response":{"id":"resp-1"}}',
        )
        feed_websocket_server_message(
            flow,
            failed_frame,
        )
        mitm_addon.websocket_end(flow)

    assert full_body_feeds.count(failed_frame) == 1
    assert _reported_payloads(model_provider_failure_api) == [expected_payload]


def test_websocket_known_delta_skips_full_parse_without_disabling_failure_state(
    tmp_path,
    real_flow,
    mitm_ctx,
    monkeypatch: pytest.MonkeyPatch,
    model_provider_failure_api,
):
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    capture_deferred_websocket_trims(monkeypatch)
    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)
    full_body_feeds = capture_openai_responses_extractor_feeds(monkeypatch)
    delta_frame = b'{"type":"response.output_text.delta","delta":"hello"}'

    with mitm_ctx():
        mitm_addon.response(flow)
        feed_websocket_client_message(flow, b'{"type":"response.create"}')
        feed_websocket_server_message(flow, delta_frame)
        assert full_body_feeds.count(delta_frame) == 0
        feed_websocket_server_message(
            flow,
            b'{"type":"response.created","response":{"id":"resp-after-delta"}}',
        )
        feed_websocket_server_message(
            flow,
            b'{"type":"response.failed","response":{"id":"resp-after-delta",'
            b'"error":{"code":"service_unavailable"}}}',
        )
        mitm_addon.websocket_end(flow)

    assert _reported_payloads(model_provider_failure_api) == [
        {"failureKind": "provider_unavailable"}
    ]


@pytest.mark.parametrize(
    ("client_state", "server_state", "expected"),
    [
        (
            ConnectionState.OPEN,
            ConnectionState.CLOSED,
            [
                {
                    "failureKind": "connection",
                    "connectionSource": "upstream_transport",
                }
            ],
        ),
        (ConnectionState.CLOSED, ConnectionState.OPEN, []),
    ],
)
def test_websocket_connection_outcome_uses_connection_direction(
    tmp_path,
    real_flow,
    mitm_ctx,
    monkeypatch: pytest.MonkeyPatch,
    client_state: ConnectionState,
    server_state: ConnectionState,
    expected: list[dict[str, str]],
    model_provider_failure_api,
):
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    flow.client_conn.state = client_state
    flow.server_conn.state = server_state
    capture_deferred_websocket_trims(monkeypatch)
    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)

    with mitm_ctx():
        mitm_addon.response(flow)
        feed_websocket_client_message(flow, b'{"type":"response.create"}')
        flow.error = Error("connection closed")
        mitm_addon.error(flow)

    assert _reported_payloads(model_provider_failure_api) == expected


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        (429, {"failureKind": "rate_limit", "retryAfterSeconds": 120}),
        (400, None),
    ],
)
def test_websocket_upgrade_http_outcome_is_classified(
    tmp_path,
    real_flow,
    mitm_ctx,
    status: int,
    expected: dict[str, str | int] | None,
    model_provider_failure_api,
):
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    assert flow.response is not None
    flow.response.status_code = status
    flow.response.headers = header_map({"retry-after": "120"})

    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)

    expected_reports = [] if expected is None else [expected]
    assert _reported_payloads(model_provider_failure_api) == expected_reports

    with mitm_ctx():
        mitm_addon.response(flow)

    assert _reported_payloads(model_provider_failure_api) == expected_reports


def test_websocket_top_level_error_is_reported(
    tmp_path,
    real_flow,
    mitm_ctx,
    monkeypatch: pytest.MonkeyPatch,
    model_provider_failure_api,
):
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    capture_deferred_websocket_trims(monkeypatch)
    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)

    with mitm_ctx():
        mitm_addon.response(flow)
        feed_websocket_client_message(flow, b'{"type":"response.create"}')
        feed_websocket_server_message(
            flow,
            b'{"type":"error","code":"server_error","message":"provider failed","param":null}',
        )
        mitm_addon.websocket_end(flow)

    assert _reported_payloads(model_provider_failure_api) == [
        {"failureKind": "provider_unavailable"}
    ]


@pytest.mark.parametrize(
    ("client_body", "active"),
    [
        pytest.param(b'{"type":"response.create"}', False, id="normal-pending"),
        pytest.param(b'{"type":"response.create"}', True, id="normal-active"),
        pytest.param(
            b'{"type":"response.create","generate":false}',
            False,
            id="prewarm-pending",
        ),
        pytest.param(
            b'{"type":"response.create","generate":false}',
            True,
            id="prewarm-active",
        ),
    ],
)
def test_websocket_shutdown_does_not_report_unfinished_request(
    tmp_path,
    real_flow,
    mitm_ctx,
    monkeypatch: pytest.MonkeyPatch,
    client_body: bytes,
    active: bool,
    model_provider_failure_api,
):
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    capture_deferred_websocket_trims(monkeypatch)
    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)

    with mitm_ctx():
        mitm_addon.response(flow)
        feed_websocket_client_message(flow, client_body)
        if active:
            feed_websocket_server_message(
                flow,
                b'{"type":"response.created","response":{"id":"unfinished"}}',
            )
        mitm_addon.websocket_end(flow)

    assert _reported_payloads(model_provider_failure_api) == []
    assert _suppressed_failure_entries(flow) == []


@pytest.mark.parametrize(
    ("events", "reason"),
    [
        pytest.param(
            (
                (
                    "client",
                    b'{"type":"future.request","input":"failure-sensitive-marker"}',
                ),
            ),
            "unknown_client_event",
            id="unknown-client-event",
        ),
        pytest.param(
            (
                ("client", b'{"type":"response.create"}'),
                ("client", b'{"type":"response.create"}'),
            ),
            "overlapping_websocket_requests",
            id="overlapping-pending-requests",
        ),
        pytest.param(
            (
                ("client", b'{"type":"response.create"}'),
                (
                    "server",
                    b'{"type":"response.created","response":{"id":"active"}}',
                ),
                ("client", b'{"type":"response.create"}'),
            ),
            "overlapping_websocket_requests",
            id="overlapping-active-request",
        ),
        pytest.param(
            (("server", b"not-json-failure-sensitive-marker"),),
            "invalid_server_event",
            id="invalid-server-json",
        ),
        pytest.param(
            (
                (
                    "server",
                    b'{"type":"response.created","response":{"id":"orphan"}}',
                ),
            ),
            "invalid_websocket_lifecycle",
            id="created-without-pending-request",
        ),
        pytest.param(
            (
                ("client", b'{"type":"response.create"}'),
                ("server", b'{"type":"response.created","response":{}}'),
            ),
            "invalid_websocket_lifecycle",
            id="created-without-response-id",
        ),
        pytest.param(
            (
                ("client", b'{"type":"response.create"}'),
                (
                    "server",
                    b'{"type":"response.created","response":{"id":"first"}}',
                ),
                (
                    "server",
                    b'{"type":"response.created","response":{"id":"duplicate"}}',
                ),
            ),
            "invalid_websocket_lifecycle",
            id="duplicate-created-event",
        ),
        pytest.param(
            (
                ("client", b'{"type":"response.create"}'),
                (
                    "server",
                    b'{"type":"response.failed","response":{"id":"before-created"}}',
                ),
            ),
            "invalid_websocket_lifecycle",
            id="terminal-before-created",
        ),
        pytest.param(
            (
                ("client", b'{"type":"response.create"}'),
                (
                    "server",
                    b'{"type":"response.created","response":{"id":"expected"}}',
                ),
                (
                    "server",
                    b'{"type":"response.failed","response":{"id":"mismatched"}}',
                ),
            ),
            "invalid_websocket_lifecycle",
            id="mismatched-terminal-response-id",
        ),
        pytest.param(
            (
                ("client", b'{"type":"response.create"}'),
                (
                    "server",
                    b'{"type":"response.created","response":{"id":"expected"}}',
                ),
                ("server", b'{"type":"response.failed","response":{}}'),
            ),
            "invalid_websocket_lifecycle",
            id="terminal-without-response-id",
        ),
    ],
)
def test_websocket_ambiguous_lifecycle_is_suppressed_once(
    tmp_path,
    real_flow,
    mitm_ctx,
    monkeypatch: pytest.MonkeyPatch,
    events: tuple[tuple[Literal["client", "server"], bytes], ...],
    reason: str,
    model_provider_failure_api,
):
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    capture_deferred_websocket_trims(monkeypatch)
    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)

    with mitm_ctx():
        mitm_addon.response(flow)
        for sender, body in events:
            if sender == "client":
                feed_websocket_client_message(flow, body)
            else:
                feed_websocket_server_message(flow, body)
        feed_websocket_client_message(flow, b'{"type":"response.create"}')
        feed_websocket_server_message(
            flow,
            b'{"type":"response.created","response":{"id":"later"}}',
        )
        feed_websocket_server_message(
            flow,
            b'{"type":"response.failed","response":{"id":"later",'
            b'"error":{"code":"service_unavailable"}}}',
        )
        mitm_addon.websocket_end(flow)

    assert _reported_payloads(model_provider_failure_api) == []
    [entry] = _suppressed_failure_entries(flow)
    assert set(entry) == {
        "timestamp",
        "level",
        "message",
        "type",
        "disposition",
        "reason",
        "run_id",
        "flow_id",
        "firewall_name",
    }
    assert entry["level"] == "warn"
    assert entry["message"] == "Model provider failure evidence suppressed"
    assert entry["type"] == "model_provider_failure"
    assert entry["disposition"] == "suppressed"
    assert entry["reason"] == reason
    assert entry["run_id"] == "run-abc-123"
    assert entry["flow_id"] == flow.id
    assert entry["firewall_name"] == "model-provider:openai-api-key"
    assert "failure-sensitive-marker" not in json.dumps(entry)


@pytest.mark.parametrize(
    "unmatched_event",
    [
        pytest.param(
            b'{"type":"response.failed","response":{"id":"orphan",'
            b'"error":{"code":"service_unavailable"}}}',
            id="terminal",
        ),
        pytest.param(
            b'{"type":"error","code":"server_error"}',
            id="error",
        ),
    ],
)
def test_websocket_unmatched_event_does_not_poison_later_request(
    tmp_path,
    real_flow,
    mitm_ctx,
    monkeypatch: pytest.MonkeyPatch,
    unmatched_event: bytes,
    model_provider_failure_api,
):
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    capture_deferred_websocket_trims(monkeypatch)
    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)

    with mitm_ctx():
        mitm_addon.response(flow)
        feed_websocket_server_message(flow, unmatched_event)
        feed_websocket_client_message(flow, b'{"type":"response.create"}')
        feed_websocket_server_message(
            flow,
            b'{"type":"response.created","response":{"id":"matched"}}',
        )
        feed_websocket_server_message(
            flow,
            b'{"type":"response.failed","response":{"id":"matched",'
            b'"error":{"code":"service_unavailable"}}}',
        )
        mitm_addon.websocket_end(flow)

    assert _reported_payloads(model_provider_failure_api) == [
        {"failureKind": "provider_unavailable"}
    ]
    assert _suppressed_failure_entries(flow) == []


@pytest.mark.parametrize(
    "initial_client_body",
    [
        pytest.param(b'{"type":"response.create"}', id="normal"),
        pytest.param(
            b'{"type":"response.create","generate":false}',
            id="prewarm",
        ),
    ],
)
def test_websocket_matching_terminal_clears_state_for_later_request(
    tmp_path,
    real_flow,
    mitm_ctx,
    monkeypatch: pytest.MonkeyPatch,
    initial_client_body: bytes,
    model_provider_failure_api,
):
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    capture_deferred_websocket_trims(monkeypatch)
    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)

    with mitm_ctx():
        mitm_addon.response(flow)
        feed_websocket_client_message(flow, initial_client_body)
        feed_websocket_server_message(
            flow,
            b'{"type":"response.created","response":{"id":"completed"}}',
        )
        feed_websocket_server_message(
            flow,
            b'{"type":"response.completed","response":{"id":"completed"}}',
        )
        feed_websocket_client_message(flow, b'{"type":"response.create"}')
        feed_websocket_server_message(
            flow,
            b'{"type":"response.created","response":{"id":"later"}}',
        )
        feed_websocket_server_message(
            flow,
            b'{"type":"response.failed","response":{"id":"later",'
            b'"error":{"code":"service_unavailable"}}}',
        )
        mitm_addon.websocket_end(flow)

    assert _reported_payloads(model_provider_failure_api) == [
        {"failureKind": "provider_unavailable"}
    ]
    assert _suppressed_failure_entries(flow) == []


def test_websocket_error_clears_state_for_later_request(
    tmp_path,
    real_flow,
    mitm_ctx,
    monkeypatch: pytest.MonkeyPatch,
    model_provider_failure_api,
):
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    capture_deferred_websocket_trims(monkeypatch)
    model_provider_failure.admit_flow(flow)
    mitm_addon.responseheaders(flow)

    with mitm_ctx():
        mitm_addon.response(flow)
        feed_websocket_client_message(
            flow,
            b'{"type":"response.create","generate":false}',
        )
        feed_websocket_server_message(flow, b'{"type":"error","code":"server_error"}')
        feed_websocket_client_message(flow, b'{"type":"response.create"}')
        feed_websocket_server_message(
            flow,
            b'{"type":"response.created","response":{"id":"later"}}',
        )
        feed_websocket_server_message(
            flow,
            b'{"type":"response.failed","response":{"id":"later",'
            b'"error":{"code":"service_unavailable"}}}',
        )
        mitm_addon.websocket_end(flow)

    assert _reported_payloads(model_provider_failure_api) == [
        {"failureKind": "provider_unavailable"}
    ]
    assert _suppressed_failure_entries(flow) == []
