"""Delivery admission and outcomes through real control sockets and HTTP peers."""

import asyncio
import hashlib
import json
import threading
import time
from uuid import uuid4

import pytest

import logging_utils
import mitm_addon
import registry_control
import runner_control
import runner_flush_lifecycle
import usage
from tests.control_helpers import (
    control_connection,
    exchange,
    frame,
    log_flush_request,
    registry_apply_request,
    status_request,
)
from tests.pending_helpers import result_data
from tests.process_log_helpers import capture_addon_process_events
from tests.registry_helpers import write_simple_registry
from tests.thread_helpers import ThreadUnderTest
from tests.usage_buffer_helpers import event
from tests.usage_helpers import UsageWebhookServer, install_recording_usage_timer


def request(method, generation="generation-1"):
    return status_request(generation) | {"method": method}


def data(directory, method="delivery.status"):
    response = exchange(directory, request(method))
    return result_data(response)


def wait_state(directory, predicate):
    deadline = time.monotonic() + 3
    while True:
        state = data(directory)
        if predicate(state):
            return state
        assert time.monotonic() < deadline, state
        time.sleep(0.01)


@pytest.fixture
async def control(tmp_path):
    owner = registry_control.RegistryControl(
        asyncio.get_running_loop(), str(tmp_path / "registry.json")
    )
    server = runner_control.ControlServer(
        tmp_path, "generation-1", owner, runner_flush_lifecycle.DeliveryControl()
    )
    server.start()
    try:
        yield server
    finally:
        owner.close()
        server.stop()


def buffer(server, tmp_path, source="source-1"):
    usage.buffer_usage_events(
        server.url(),
        "synthetic-token",
        "run-1",
        [event(source_key=source)],
        str(tmp_path / "proxy.jsonl"),
    )


async def test_blocked_http_delivery_allows_status_logs_and_registry_enforcement(
    tmp_path, control, fresh_usage_executor, mitm_ctx, real_flow
):
    install_recording_usage_timer()
    release = threading.Event()
    api = UsageWebhookServer()
    api.queue_response(204, release_event=release)
    path = tmp_path / "registry.json"
    write_simple_registry(path)
    run_id = str(uuid4())
    log_path = tmp_path / f"network-{run_id}.jsonl"
    with api.run(), mitm_ctx(registry_path=str(path)):
        try:
            buffer(api, tmp_path)
            assert data(tmp_path, "delivery.flush")["state"] == "admitted"
            assert api.wait_for_request_count(1)
            assert data(tmp_path)["reports"] == 1
            assert exchange(tmp_path)["data"] == {"state": "running"}
            logging_utils.log_proxy_entry(str(log_path), "info", "delivery is still blocked")
            flushed = exchange(tmp_path, log_flush_request(log_path, run_id))
            assert result_data(flushed)["state"] == "processed"
            assert json.loads(log_path.read_text())["message"] == "delivery is still blocked"
            expected = hashlib.sha256(path.read_bytes()).hexdigest()
            applied = await asyncio.to_thread(exchange, tmp_path, registry_apply_request(expected))
            assert result_data(applied)["state"] == "applied"
            path.write_text("{invalid")
            rejected = await asyncio.to_thread(exchange, tmp_path, registry_apply_request(expected))
            assert result_data(rejected)["state"] == "rejected"
            flow = real_flow(with_response=False)
            await mitm_addon.request(flow)
            assert flow.response.status_code == 503
            assert data(tmp_path)["reports"] == 1
        finally:
            release.set()
        receipt = await asyncio.to_thread(data, tmp_path, "delivery.drain")
        assert receipt["state"] == "quiescent"
        assert receipt["snapshot"]["outcomes"]["success"] == 1
        assert api.request_count == 1


@pytest.mark.parametrize("status", [204, 400, 500])
async def test_quiescence_reports_real_delivery_outcomes_and_retained_retry(
    tmp_path, control, fresh_usage_executor, status
):
    install_recording_usage_timer()
    api = UsageWebhookServer()
    api.queue_response(status)
    if status == 500:
        api.queue_response(500)
        api.queue_response(204)
    with api.run():
        buffer(api, tmp_path)
        receipt = await asyncio.to_thread(data, tmp_path, "delivery.drain")
    assert receipt["state"] == "quiescent"
    snapshot = receipt["snapshot"]
    assert snapshot["reports"] == snapshot["buffered"] == 0
    assert snapshot["outcomes"] == {
        "success": int(status != 400),
        "retryable_failure": int(status == 500),
        "permanent_failure": int(status == 400),
    }
    bodies = api.json_bodies()
    assert len(bodies) == (3 if status == 500 else 1)
    assert all(body == bodies[0] for body in bodies)


async def test_drain_overload_deadline_and_disconnect_leave_http_delivery_owned(
    tmp_path, control, fresh_usage_executor
):
    install_recording_usage_timer()
    release = threading.Event()
    api = UsageWebhookServer()
    api.queue_response(204, release_event=release)
    with api.run():
        try:
            buffer(api, tmp_path)
            with control_connection(tmp_path) as disconnected:
                disconnected.sendall(frame(json.dumps(request("delivery.drain")).encode()))
                assert api.wait_for_request_count(1)
                wait_state(tmp_path, lambda state: state["drainActive"])
                assert exchange(tmp_path, request("delivery.drain"))["code"] == "busy"
            # The request socket is gone; actual HTTP ownership remains intact.
            assert data(tmp_path)["reports"] == 1
            assert exchange(tmp_path)["type"] == "result"
            # Wait past the production four-second observation deadline.
            deadline = time.monotonic() + 6
            while data(tmp_path)["drainActive"]:
                assert time.monotonic() < deadline
                await asyncio.sleep(0.02)
            assert data(tmp_path)["reports"] == 1
            assert api.request_count == 1
        finally:
            release.set()
        assert (await asyncio.to_thread(data, tmp_path, "delivery.drain"))["state"] == "quiescent"
        assert api.request_count == 1


async def test_blocked_flush_owner_coalesces_wakes_and_hands_off_to_shutdown(
    tmp_path, control, fresh_usage_executor
):
    # Hold the real buffer's admitted synchronous fallback at the external HTTP
    # boundary; this keeps the flush worker itself busy, not only its executor.
    install_recording_usage_timer()
    fresh_usage_executor.shutdown(wait=True)
    release = threading.Event()
    api = UsageWebhookServer()
    api.queue_response(204, release_event=release)
    done = ThreadUnderTest(target=mitm_addon.done)
    done_started = False
    with api.run():
        try:
            buffer(api, tmp_path)
            assert data(tmp_path, "delivery.flush")["state"] == "admitted"
            assert api.wait_for_request_count(1)
            buffer(api, tmp_path, "source-2")
            for _ in range(32):
                assert data(tmp_path, "delivery.flush")["state"] == "coalesced"
            state = data(tmp_path)
            assert state["workerActive"]
            assert state["wakePending"]
            receipt = await asyncio.to_thread(data, tmp_path, "delivery.drain")
            assert receipt["state"] == "deadline"
            assert receipt["snapshot"]["workerActive"]
            done.start()
            done_started = True
            wait_state(tmp_path, lambda state: state["closed"])
            assert done.is_alive()
            assert exchange(tmp_path, request("delivery.flush"))["code"] == "not_ready"
            assert api.request_count == 1
        finally:
            release.set()
            if done_started:
                done.join_and_raise(timeout=3)
        assert api.request_count == 2
        state = data(tmp_path)
        assert state["outcomes"]["success"] == 2
        assert state["reports"] == state["buffered"] == 0


async def test_stale_generation_and_caller_selected_run_cannot_dispatch(tmp_path, control):
    assert (
        exchange(tmp_path, request("delivery.flush", "old-generation"))["code"]
        == "stale_generation"
    )
    for method in ("delivery.flush", "delivery.status", "delivery.drain"):
        selected_run = request(method) | {"params": {"runId": "replacement-run"}}
        assert exchange(tmp_path, selected_run)["code"] == "invalid_request"
    assert data(tmp_path)["workerActive"] is False


async def test_worker_start_failure_is_redacted_and_admission_recovers(
    tmp_path, control, monkeypatch
):
    start = threading.Thread.start

    def fail_worker(thread):
        if thread.name == "runner-delivery":
            raise RuntimeError("credential-must-not-escape")
        return start(thread)

    monkeypatch.setattr(threading.Thread, "start", fail_worker)
    failed = exchange(tmp_path, request("delivery.flush"))
    assert failed["code"] == "internal_error"
    assert "credential" not in json.dumps(failed)
    assert data(tmp_path)["workerActive"] is False
    monkeypatch.setattr(threading.Thread, "start", start)
    assert (await asyncio.to_thread(data, tmp_path, "delivery.drain"))["state"] == "quiescent"


async def test_worker_failure_after_admission_preserves_work_and_allows_later_delivery(
    tmp_path, control, fresh_usage_executor
):
    started = threading.Event()
    release = threading.Event()
    attempted = []

    def enqueue(url, token, payload, path, log_type, callback):
        attempted.append(payload)
        if len(attempted) == 1:
            started.set()
            assert release.wait(3), "test did not release failed admission"
            raise OSError("synthetic-private-credential")
        return usage.webhook.enqueue_webhook_delivery(url, token, payload, path, log_type, callback)

    # Reuse the buffer's admission fault seam; observe recovery through the real
    # control socket and HTTP delivery instead of replacing the flush worker.
    install_recording_usage_timer(enqueue_webhook=enqueue)
    api = UsageWebhookServer()
    api.queue_response(204)
    with api.run(), capture_addon_process_events() as log:
        try:
            buffer(api, tmp_path)
            assert data(tmp_path, "delivery.flush")["state"] == "admitted"
            assert started.wait(2)
            assert data(tmp_path)["workerActive"]
        finally:
            release.set()
        state = wait_state(tmp_path, lambda state: not state["workerActive"])
        assert state["flushFailures"] == 1
        assert state["buffered"] == 1
        assert state["reports"] == 0
        assert api.request_count == 0
        log.warn.assert_called_once()
        assert "OSError" in log.warn.call_args.args[0]
        assert "synthetic-private-credential" not in log.warn.call_args.args[0]
        receipt = await asyncio.to_thread(data, tmp_path, "delivery.drain")
        assert receipt["state"] == "quiescent"
        assert receipt["snapshot"]["flushFailures"] == 1
        assert receipt["snapshot"]["outcomes"]["success"] == 1
        assert api.json_bodies() == [attempted[0]]
        assert attempted == [attempted[0], attempted[0]]
