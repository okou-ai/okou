"""Tests for usage webhook delivery admission and accounting."""

import json
import time
import urllib.request
from unittest.mock import patch

import pytest

import usage
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush, read_jsonl_text_after_flush
from tests.pending_helpers import assert_pending
from tests.webhook_test_helpers import (
    SANITIZED_WEBHOOK_URL,
    SENSITIVE_WEBHOOK_URL,
    QueuedUsageExecutor,
    assert_body_free_webhook_entry,
    assert_sensitive_webhook_url_parts_absent,
)


def test_sync_executor_worker_error_preserves_other_pending_reports(tmp_path, sync_usage_executor):
    """Synchronous executor fixture should store worker exceptions on its Future."""
    proxy_log = tmp_path / "proxy.jsonl"
    control_root = tmp_path / "delivery-control"
    other_pending_report = usage.counters.admit_pending_report()

    usage.webhook.enqueue_webhook_delivery(
        "not-a-url",
        "tok",
        {"runId": "run-1", "events": []},
        str(proxy_log),
        "usage_event",
    )

    assert_pending(
        control_root,
        flows=0,
        buffered=0,
        reports=1,
    )
    assert usage.webhook.pending_delivery_payload_count_for_tests() == 0
    assert "non-retryable" in read_jsonl_text_after_flush(proxy_log)
    with pytest.raises(ValueError, match="absolute http"):
        sync_usage_executor.shutdown(wait=True)
    other_pending_report.release()


def test_enqueue_logs_body_free_payload_summary(
    mitm_ctx, tmp_path, sync_usage_executor, usage_webhook_server
):
    proxy_log = tmp_path / "proxy.jsonl"
    control_root = tmp_path / "delivery-control"
    usage_webhook_server.queue_response(204)
    payload = {
        "url": "payload-url",
        "type": "payload-type",
        "attempt": 99,
        "error": "payload-error",
        "runId": "run-1",
        "events": [],
    }

    with mitm_ctx():
        assert usage.webhook.enqueue_webhook_delivery(
            usage_webhook_server.url("/usage"),
            "tok",
            payload,
            str(proxy_log),
            "usage_event",
        )

    assert usage_webhook_server.request_count == 1
    assert usage.webhook.pending_delivery_payload_count_for_tests() == 0
    assert_pending(
        control_root,
        flows=0,
        buffered=0,
        reports=0,
    )
    entries = read_jsonl_entries_after_flush(proxy_log)
    enqueued_entry = entries[0]
    assert enqueued_entry["url"] == usage_webhook_server.url("/usage")
    assert enqueued_entry["type"] == "usage_event"
    assert "attempt" not in enqueued_entry
    assert "error" not in enqueued_entry
    assert_body_free_webhook_entry(enqueued_entry, run_id="run-1", event_count=0)
    assert "payload_bytes" not in enqueued_entry


def test_enqueue_sanitizes_sensitive_webhook_url_in_message(tmp_path, sync_usage_executor):
    proxy_log = tmp_path / "proxy.jsonl"
    control_root = tmp_path / "delivery-control"
    payload = {"runId": "run-1", "events": []}

    with patch.object(
        urllib.request.OpenerDirector,
        "open",
    ) as mock_open:
        assert usage.webhook.enqueue_webhook_delivery(
            SENSITIVE_WEBHOOK_URL,
            "tok",
            payload,
            str(proxy_log),
            "usage_event",
        )
        with pytest.raises(ValueError, match="user information"):
            sync_usage_executor.shutdown(wait=True)

    mock_open.assert_not_called()

    assert usage.webhook.pending_delivery_payload_count_for_tests() == 0
    assert_pending(
        control_root,
        flows=0,
        buffered=0,
        reports=0,
    )
    entries = read_jsonl_entries_after_flush(proxy_log)
    enqueued_entry = entries[0]
    assert enqueued_entry["url"] == SANITIZED_WEBHOOK_URL
    assert enqueued_entry["message"] == f"Webhook POST to {SANITIZED_WEBHOOK_URL} enqueued"
    assert enqueued_entry["type"] == "usage_event"
    assert_body_free_webhook_entry(enqueued_entry, run_id="run-1", event_count=0)
    for entry in entries:
        assert_sensitive_webhook_url_parts_absent(entry)


def test_enqueue_log_failure_releases_delivery_capacity(tmp_path):
    control_root = tmp_path / "delivery-control"
    executor = QueuedUsageExecutor()
    errors = [OSError("disk full"), OSError("disk full")]

    with (
        patch.object(usage.webhook, "usage_executor", executor),
        patch.object(usage.webhook, "_log_webhook_entry", side_effect=errors),
    ):
        for error in errors:
            with pytest.raises(OSError, match="disk full") as exc_info:
                usage.webhook.enqueue_webhook_delivery(
                    "https://api.okou.ai/api/webhooks/agent/usage-event",
                    "tok",
                    {"runId": "run-1", "events": []},
                    str(tmp_path / "proxy.jsonl"),
                    "usage_event",
                )

            assert exc_info.value is error
            assert usage.webhook.pending_delivery_payload_count_for_tests() == 0

    assert not executor.submissions
    assert_pending(control_root, flows=0, buffered=0, reports=0)


def test_submit_failure_rolls_back_pending_report(tmp_path):
    control_root = tmp_path / "delivery-control"

    with (
        patch.object(usage.webhook.usage_executor, "submit", side_effect=OSError("no threads")),
        pytest.raises(OSError, match="no threads"),
    ):
        usage.webhook.enqueue_webhook_delivery(
            "https://api.okou.ai/api/webhooks/agent/usage-event",
            "tok",
            {"runId": "run-1", "events": [{"category": "tokens.input", "quantity": 1}]},
            "",
            "usage_event",
        )

    assert usage.webhook.pending_delivery_payload_count_for_tests() == 0
    assert_pending(control_root, flows=0, buffered=0, reports=0)


def test_sync_fallback_log_failure_rolls_back_pending_report(tmp_path):
    control_root = tmp_path / "delivery-control"

    with (
        patch.object(usage.webhook.usage_executor, "submit", side_effect=RuntimeError("shutdown")),
        patch.object(usage.webhook, "log_proxy_entry", side_effect=[None, OSError("disk full")]),
        pytest.raises(OSError, match="disk full"),
    ):
        usage.webhook.enqueue_webhook_delivery(
            "https://api.okou.ai/api/webhooks/agent/usage-event",
            "tok",
            {"runId": "run-1", "events": [{"category": "tokens.input", "quantity": 1}]},
            str(tmp_path / "proxy.jsonl"),
            "usage_event",
        )

    assert usage.webhook.pending_delivery_payload_count_for_tests() == 0
    assert_pending(
        control_root,
        flows=0,
        buffered=0,
        reports=0,
    )


def test_does_not_admit_when_delivery_capacity_is_saturated(tmp_path):
    proxy_log = tmp_path / "proxy.jsonl"
    control_root = tmp_path / "delivery-control"
    executor = QueuedUsageExecutor()

    with patch.object(usage.webhook, "usage_executor", executor):
        for index in range(usage.webhook.MAX_PENDING_WEBHOOK_PAYLOADS):
            assert usage.webhook.enqueue_webhook_delivery(
                "https://api.okou.ai/api/webhooks/agent/usage-event",
                "tok",
                {"runId": f"run-{index}", "events": []},
                str(proxy_log),
                "usage_event",
            )

        admitted = usage.webhook.enqueue_webhook_delivery(
            "https://api.okou.ai/api/webhooks/agent/usage-event",
            "tok",
            {
                "runId": "run-drop",
                "events": [{"idempotencyKey": "secret-key", "quantity": 1}],
                "payload": "secret-payload",
            },
            str(proxy_log),
            "usage_event",
        )

    assert admitted is False
    assert len(executor.submissions) == usage.webhook.MAX_PENDING_WEBHOOK_PAYLOADS
    assert_pending(
        control_root,
        flows=0,
        buffered=0,
        reports=usage.webhook.MAX_PENDING_WEBHOOK_PAYLOADS,
    )

    entries = read_jsonl_entries_after_flush(proxy_log)
    saturated_entry = entries[-1]
    assert saturated_entry["level"] == "info"
    assert saturated_entry["reason"] == "delivery_saturated"
    assert "not admitted" in saturated_entry["message"]
    assert "saturated" in saturated_entry["message"]
    assert "dropped" not in saturated_entry["message"]
    assert saturated_entry["webhook_delivery_capacity"] == (
        usage.webhook.MAX_PENDING_WEBHOOK_PAYLOADS
    )
    assert saturated_entry["webhook_delivery_pending"] == (
        usage.webhook.MAX_PENDING_WEBHOOK_PAYLOADS
    )
    assert_body_free_webhook_entry(saturated_entry, run_id="run-drop", event_count=1)
    assert "payload_bytes" not in saturated_entry
    assert "secret-payload" not in json.dumps(saturated_entry)


def test_delivery_capacity_released_after_success(
    mitm_ctx, tmp_path, sync_usage_executor, usage_webhook_server
):
    proxy_log = tmp_path / "proxy.jsonl"
    control_root = tmp_path / "delivery-control"
    usage_webhook_server.queue_response(204)

    with mitm_ctx():
        assert usage.webhook.enqueue_webhook_delivery(
            usage_webhook_server.url("/usage"),
            "tok",
            {"runId": "run-1", "events": []},
            str(proxy_log),
            "usage_event",
        )

    assert usage_webhook_server.request_count == 1
    assert usage.webhook.pending_delivery_payload_count_for_tests() == 0
    assert_pending(
        control_root,
        flows=0,
        buffered=0,
        reports=0,
    )


def test_delivery_capacity_released_when_outcome_callback_fails(
    mitm_ctx, tmp_path, sync_usage_executor, usage_webhook_server
):
    proxy_log = tmp_path / "proxy.jsonl"
    control_root = tmp_path / "delivery-control"
    usage_webhook_server.queue_response(204)

    def fail_callback(_outcome: usage.webhook.WebhookDeliveryOutcome) -> None:
        raise RuntimeError("callback failed")

    with mitm_ctx():
        assert usage.webhook.enqueue_webhook_delivery(
            usage_webhook_server.url("/usage"),
            "tok",
            {"runId": "run-1", "events": []},
            str(proxy_log),
            "usage_event",
            delivery_outcome_callback=fail_callback,
        )

    with pytest.raises(RuntimeError, match="callback failed"):
        sync_usage_executor.shutdown(wait=True)

    assert usage_webhook_server.request_count == 1
    assert usage.webhook.pending_delivery_payload_count_for_tests() == 0
    assert_pending(
        control_root,
        flows=0,
        buffered=0,
        reports=0,
    )


def test_delivery_capacity_released_after_retry_exhaustion(
    mitm_ctx, tmp_path, sync_usage_executor, usage_webhook_server
):
    proxy_log = tmp_path / "proxy.jsonl"
    control_root = tmp_path / "delivery-control"
    usage_webhook_server.queue_response(500)
    usage_webhook_server.queue_response(500)

    with mitm_ctx(), patch.object(time, "sleep"):
        assert usage.webhook.enqueue_webhook_delivery(
            usage_webhook_server.url("/usage"),
            "tok",
            {"runId": "run-1", "events": []},
            str(proxy_log),
            "usage_event",
        )

    assert usage_webhook_server.request_count == 2
    assert usage.webhook.pending_delivery_payload_count_for_tests() == 0
    assert_pending(
        control_root,
        flows=0,
        buffered=0,
        reports=0,
    )
