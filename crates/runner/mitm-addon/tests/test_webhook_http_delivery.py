"""Tests for usage webhook HTTP delivery behavior."""

import base64
import json
import os
import socket
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from unittest.mock import patch

import pytest

import flow_metadata_keys as metadata_keys
import platform_api
import usage
from tests.jsonl_log_helpers import (
    jsonl_exists_after_flush,
    read_jsonl_entries_after_flush,
    read_jsonl_text_after_flush,
)
from tests.pending_helpers import assert_pending
from tests.webhook_test_helpers import (
    SANITIZED_WEBHOOK_URL,
    assert_body_free_webhook_entry,
    assert_client_headers,
    assert_sensitive_webhook_url_parts_absent,
    model_usage_flow,
)


def _report_and_flush_model_usage(flow, *, run_id: str = "run-1") -> None:
    usage.report_model_provider_usage(flow, run_id)
    usage.flush_usage_events(trigger="test")


def test_does_not_follow_redirects(tmp_path, real_flow, sync_usage_executor, usage_webhook_api):
    flow = model_usage_flow(real_flow, tmp_path)

    with usage_webhook_api() as webhook:
        webhook.queue_response(
            302,
            headers=(("Location", webhook.url("/redirected")),),
        )
        _report_and_flush_model_usage(flow)

    assert [request.path for request in webhook.requests] == ["/api/webhooks/agent/usage-event"]
    log_entries = read_jsonl_entries_after_flush(
        Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])
    )
    assert any("permanent HTTP error" in entry["message"] for entry in log_entries)


def test_rejects_invalid_url_before_open(tmp_path, sync_usage_executor):
    proxy_log = tmp_path / "proxy.jsonl"
    payload = {"url": "payload-url", "runId": "run-1", "events": []}
    payload_bytes = len(json.dumps(payload).encode())

    with patch.object(urllib.request.OpenerDirector, "open") as mock_open:
        assert usage.webhook.enqueue_webhook_delivery(
            "file:///etc/passwd",
            "tok",
            payload,
            str(proxy_log),
            "usage_event",
        )
        with pytest.raises(ValueError, match="absolute http"):
            sync_usage_executor.shutdown(wait=True)

    mock_open.assert_not_called()
    entries = read_jsonl_entries_after_flush(proxy_log)
    messages = [entry["message"] for entry in entries]
    assert sum("non-retryable" in message for message in messages) == 1
    assert all("retrying" not in message for message in messages)
    assert all("failed after" not in message for message in messages)
    error_entry = entries[-1]
    assert error_entry["url"] == "file:///etc/passwd"
    assert "non-retryable" in error_entry["message"]
    assert_body_free_webhook_entry(
        error_entry,
        run_id="run-1",
        event_count=0,
        payload_bytes=payload_bytes,
    )


@pytest.mark.parametrize(
    "raw_url",
    [
        pytest.param(
            "https:////user:pass@api.okou.ai/path?token=secret#frag",
            id="extra-slashes",
        ),
        pytest.param(
            "https: //user:pass@api.okou.ai/path?token=secret#frag",
            id="space-before-separators",
        ),
    ],
)
def test_rejects_malformed_sensitive_url_without_logging_credentials(
    tmp_path, sync_usage_executor, raw_url
):
    proxy_log = tmp_path / "proxy.jsonl"
    sanitized_url = "https://api.okou.ai/path"
    payload = {"runId": "run-1", "events": []}
    payload_bytes = len(json.dumps(payload).encode())

    with patch.object(urllib.request.OpenerDirector, "open") as mock_open:
        assert usage.webhook.enqueue_webhook_delivery(
            raw_url,
            "tok",
            payload,
            str(proxy_log),
            "usage_event",
        )
        with pytest.raises(ValueError, match="absolute http"):
            sync_usage_executor.shutdown(wait=True)

    mock_open.assert_not_called()
    entries = read_jsonl_entries_after_flush(proxy_log)
    error_entry = entries[-1]
    assert error_entry["url"] == sanitized_url
    assert sanitized_url in error_entry["message"]
    assert "absolute http" in error_entry["error"]
    assert "non-retryable" in error_entry["message"]
    assert_body_free_webhook_entry(
        error_entry,
        run_id="run-1",
        event_count=0,
        payload_bytes=payload_bytes,
    )
    for entry in entries:
        assert_sensitive_webhook_url_parts_absent(entry)


def test_closes_http_error_response(tmp_path, real_flow, sync_usage_executor, usage_webhook_api):
    flow = model_usage_flow(real_flow, tmp_path)
    real_close = urllib.error.HTTPError.close
    response_closed_states: list[bool] = []

    def close_and_record(error: urllib.error.HTTPError) -> None:
        real_close(error)
        response_closed_states.append(error.fp.closed)

    with (
        usage_webhook_api() as webhook,
        patch.object(time, "sleep"),
        patch.object(urllib.error.HTTPError, "close", close_and_record),
    ):
        webhook.queue_response(500)
        webhook.queue_response(500)
        _report_and_flush_model_usage(flow)

    assert webhook.request_count == 2
    assert response_closed_states == [True, True]


def test_succeeds_on_first_attempt(tmp_path, real_flow, sync_usage_executor, usage_webhook_api):
    flow = model_usage_flow(real_flow, tmp_path)
    flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] = {
        "model": "claude-sonnet-4-6",
        "tokens.input": 100,
    }

    with usage_webhook_api() as webhook:
        _report_and_flush_model_usage(flow)

    assert webhook.request_count == 1
    request = webhook.requests[0]
    assert request.method == "POST"
    assert request.path == "/api/webhooks/agent/usage-event"
    assert request.header("content-type") == "application/json"
    assert request.header("authorization") == "Bearer tok"
    assert request.header("user-agent") == "vm0-mitm-addon/1.0"
    assert_client_headers(request)
    body = request.json_body()
    assert body["runId"] == "run-1"
    assert set(body) == {"runId", "events"}
    uuid.UUID(body["events"][0]["idempotencyKey"])
    assert [
        {key: value for key, value in event.items() if key != "idempotencyKey"}
        for event in body["events"]
    ] == [
        {
            "kind": "model",
            "provider": "claude-sonnet-4-6",
            "category": "tokens.input",
            "quantity": 100,
        }
    ]

    payload_bytes = len(json.dumps(body).encode())
    log_entries = read_jsonl_entries_after_flush(
        Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])
    )
    webhook_entries = [entry for entry in log_entries if entry["type"] == "usage_event"]
    assert len(webhook_entries) == 2
    assert {entry["level"] for entry in webhook_entries} == {"info"}
    assert any("enqueued" in entry["message"] for entry in webhook_entries)
    assert any("succeeded" in entry["message"] for entry in webhook_entries)
    for entry in webhook_entries:
        assert_body_free_webhook_entry(
            entry,
            run_id="run-1",
            event_count=1,
            payload_bytes=None if "enqueued" in entry["message"] else payload_bytes,
        )


def test_environment_proxy_uses_canonical_hostname_and_credentials(
    tmp_path,
    sync_usage_executor,
    usage_webhook_server,
):
    resolved_hosts: list[str] = []
    real_getaddrinfo = socket.getaddrinfo

    def resolve_proxy(
        host: str,
        port: int,
        family: int = 0,
        socket_type: int = 0,
        proto: int = 0,
        flags: int = 0,
    ):
        resolved_hosts.append(host)
        return real_getaddrinfo("127.0.0.1", port, family, socket_type, proto, flags)

    proxy_port = usage_webhook_server.api_url.rsplit(":", maxsplit=1)[1]
    proxy_environment = {
        "http_proxy": f"http://proxy-user:proxy-password@faß.proxy:{proxy_port}",
        "HTTP_PROXY": "",
        "all_proxy": "",
        "ALL_PROXY": "",
        "no_proxy": "",
        "NO_PROXY": "",
    }
    payload = {"runId": "run-1", "events": []}
    with (
        patch.dict(os.environ, proxy_environment),
        patch.object(socket, "getaddrinfo", side_effect=resolve_proxy),
        patch.object(usage.webhook, "_opener", platform_api.build_api_opener()),
    ):
        assert usage.webhook.enqueue_webhook_delivery(
            "http://platform.example:8123/usage",
            "tok",
            payload,
            str(tmp_path / "proxy.jsonl"),
            "usage_event",
        )
        sync_usage_executor.shutdown(wait=True)

    expected_proxy_authorization = "Basic " + base64.b64encode(b"proxy-user:proxy-password").decode(
        "ascii"
    )
    assert resolved_hosts == ["xn--fa-hia.proxy"]
    assert usage_webhook_server.request_count == 1
    request = usage_webhook_server.requests[0]
    assert request.path == "http://platform.example:8123/usage"
    assert request.header("proxy-authorization") == expected_proxy_authorization
    assert request.header("authorization") == "Bearer tok"


def test_environment_proxy_respects_no_proxy(
    tmp_path,
    sync_usage_executor,
    usage_webhook_server,
):
    proxy_environment = {
        "http_proxy": "http://proxy-user:proxy-password@127.0.0.1:1",
        "HTTP_PROXY": "",
        "all_proxy": "",
        "ALL_PROXY": "",
        "no_proxy": "127.0.0.1",
        "NO_PROXY": "127.0.0.1",
    }
    with (
        patch.dict(os.environ, proxy_environment),
        patch.object(usage.webhook, "_opener", platform_api.build_api_opener()),
    ):
        assert usage.webhook.enqueue_webhook_delivery(
            usage_webhook_server.url("/usage"),
            "tok",
            {"runId": "run-1", "events": []},
            str(tmp_path / "proxy.jsonl"),
            "usage_event",
        )
        sync_usage_executor.shutdown(wait=True)

    assert usage_webhook_server.request_count == 1
    request = usage_webhook_server.requests[0]
    assert request.path == "/usage"
    assert request.header("proxy-authorization") is None


def test_environment_proxy_rejects_unsafe_hostname_before_dns(
    tmp_path,
    sync_usage_executor,
):
    proxy_environment = {
        "http_proxy": "http://proxy-user:proxy-password@\uff26\uff2f\uff2f.proxy:8123",
        "HTTP_PROXY": "",
        "all_proxy": "",
        "ALL_PROXY": "",
        "no_proxy": "platform.example",
        "NO_PROXY": "platform.example",
    }
    with (
        patch.dict(os.environ, proxy_environment),
        patch.object(socket, "getaddrinfo") as mock_getaddrinfo,
        patch.object(usage.webhook, "_opener", platform_api.build_api_opener()),
    ):
        assert usage.webhook.enqueue_webhook_delivery(
            "http://platform.example:8123/usage",
            "tok",
            {"runId": "run-1", "events": []},
            str(tmp_path / "proxy.jsonl"),
            "usage_event",
        )
        with pytest.raises(UnicodeError, match="unsafe IDNA compatibility mapping"):
            sync_usage_executor.shutdown(wait=True)

    mock_getaddrinfo.assert_not_called()


@pytest.mark.parametrize(
    "proxy_prefix",
    [
        pytest.param("http://", id="url"),
        pytest.param("", id="authority"),
    ],
)
def test_malformed_environment_proxy_does_not_expose_credentials_before_dns(
    tmp_path,
    sync_usage_executor,
    proxy_prefix: str,
):
    password = "sensitive-proxy-password"
    proxy_environment = {
        "http_proxy": f"{proxy_prefix}proxy-user:{password}@proxy\uff1ahost:8123",
        "HTTP_PROXY": "",
        "all_proxy": "",
        "ALL_PROXY": "",
        "no_proxy": "",
        "NO_PROXY": "",
    }
    with (
        patch.dict(os.environ, proxy_environment),
        patch.object(socket, "getaddrinfo") as mock_getaddrinfo,
        patch.object(usage.webhook, "_opener", platform_api.build_api_opener()),
    ):
        assert usage.webhook.enqueue_webhook_delivery(
            "http://platform.example:8123/usage",
            "tok",
            {"runId": "run-1", "events": []},
            str(tmp_path / "proxy.jsonl"),
            "usage_event",
        )
        with pytest.raises(ValueError, match="Proxy URL is invalid") as exc_info:
            sync_usage_executor.shutdown(wait=True)

    assert password not in str(exc_info.value)
    mock_getaddrinfo.assert_not_called()


def test_adds_vercel_bypass_header(tmp_path, real_flow, sync_usage_executor, usage_webhook_api):
    flow = model_usage_flow(real_flow, tmp_path)

    with (
        patch.object(platform_api, "VERCEL_BYPASS", "bypass-secret"),
        usage_webhook_api() as webhook,
    ):
        _report_and_flush_model_usage(flow)

    assert webhook.requests[0].header("x-vercel-protection-bypass") == "bypass-secret"


def test_retries_on_failure(tmp_path, real_flow, sync_usage_executor, usage_webhook_api):
    flow = model_usage_flow(real_flow, tmp_path)

    with (
        usage_webhook_api() as webhook,
        patch.object(time, "sleep") as mock_sleep,
    ):
        webhook.queue_response(500)
        webhook.queue_response(204)
        _report_and_flush_model_usage(flow)

    assert webhook.request_count == 2
    mock_sleep.assert_called_once_with(0.5)


def test_gives_up_after_retry_budget(tmp_path, real_flow, sync_usage_executor, usage_webhook_api):
    flow = model_usage_flow(real_flow, tmp_path)
    proxy_log = Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])

    with (
        usage_webhook_api() as webhook,
        patch.object(time, "sleep"),
    ):
        webhook.queue_response(500)
        webhook.queue_response(500)
        _report_and_flush_model_usage(flow)

    assert webhook.request_count == 2
    assert jsonl_exists_after_flush(proxy_log)
    assert "2 attempts" in read_jsonl_text_after_flush(proxy_log)
    entries = read_jsonl_entries_after_flush(proxy_log)
    assert all(entry["level"] != "error" for entry in entries)


def test_retry_exhaustion_logs_body_free_payload_summary_with_colliding_fields(
    tmp_path, sync_usage_executor, usage_webhook_server
):
    proxy_log = tmp_path / "proxy.jsonl"
    payload = {
        "url": "payload-url",
        "type": "payload-type",
        "attempt": 99,
        "error": "payload-error",
        "runId": "run-1",
        "events": [],
    }
    payload_bytes = len(json.dumps(payload).encode())
    usage_webhook_server.queue_response(500)
    usage_webhook_server.queue_response(500)

    with patch.object(time, "sleep") as mock_sleep:
        assert usage.webhook.enqueue_webhook_delivery(
            usage_webhook_server.url("/usage"),
            "tok",
            payload,
            str(proxy_log),
            "usage_event",
        )
        sync_usage_executor.shutdown(wait=True)

    assert usage_webhook_server.request_count == 2
    mock_sleep.assert_called_once_with(0.5)
    attempt_entries = [
        entry for entry in read_jsonl_entries_after_flush(proxy_log) if "attempt" in entry
    ]
    assert [entry["attempt"] for entry in attempt_entries] == [1, 2]
    assert attempt_entries[-1]["delivery_outcome"] == "retryable_failure"
    assert all(entry["url"] == usage_webhook_server.url("/usage") for entry in attempt_entries)
    assert all(entry["type"] == "usage_event" for entry in attempt_entries)
    assert all("payload-error" not in entry["error"] for entry in attempt_entries)
    for entry in attempt_entries:
        assert_body_free_webhook_entry(
            entry,
            run_id="run-1",
            event_count=0,
            payload_bytes=payload_bytes,
        )


def test_retry_success_logs_body_free_payload_summary_with_colliding_fields(
    tmp_path, sync_usage_executor, usage_webhook_server
):
    proxy_log = tmp_path / "proxy.jsonl"
    payload = {
        "url": "payload-url",
        "type": "payload-type",
        "attempt": 99,
        "error": "payload-error",
        "runId": "run-1",
        "events": [],
    }
    payload_bytes = len(json.dumps(payload).encode())
    usage_webhook_server.queue_response(500)
    usage_webhook_server.queue_response(204)

    with patch.object(time, "sleep") as mock_sleep:
        assert usage.webhook.enqueue_webhook_delivery(
            usage_webhook_server.url("/usage"),
            "tok",
            payload,
            str(proxy_log),
            "usage_event",
        )
        sync_usage_executor.shutdown(wait=True)

    assert usage_webhook_server.request_count == 2
    mock_sleep.assert_called_once_with(0.5)
    attempt_entries = [
        entry for entry in read_jsonl_entries_after_flush(proxy_log) if "attempt" in entry
    ]
    assert [entry["attempt"] for entry in attempt_entries] == [1, 2]
    assert "succeeded" in attempt_entries[-1]["message"]
    assert all(entry["url"] == usage_webhook_server.url("/usage") for entry in attempt_entries)
    assert all(entry["type"] == "usage_event" for entry in attempt_entries)
    assert "error" not in attempt_entries[-1]
    for entry in attempt_entries:
        assert_body_free_webhook_entry(
            entry,
            run_id="run-1",
            event_count=0,
            payload_bytes=payload_bytes,
        )


def test_http_408_is_retryable(tmp_path, real_flow, sync_usage_executor, usage_webhook_api):
    flow = model_usage_flow(real_flow, tmp_path)

    with (
        usage_webhook_api() as webhook,
        patch.object(time, "sleep") as mock_sleep,
    ):
        webhook.queue_response(408)
        webhook.queue_response(204)
        _report_and_flush_model_usage(flow)

    assert webhook.request_count == 2
    mock_sleep.assert_called_once_with(0.5)


def test_http_429_is_retryable(tmp_path, real_flow, sync_usage_executor, usage_webhook_api):
    flow = model_usage_flow(real_flow, tmp_path)
    proxy_log = Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])

    with (
        usage_webhook_api() as webhook,
        patch.object(time, "sleep") as mock_sleep,
    ):
        webhook.queue_response(429)
        webhook.queue_response(429)
        _report_and_flush_model_usage(flow)

    assert webhook.request_count == 2
    mock_sleep.assert_called_once_with(0.5)
    entries = [entry for entry in read_jsonl_entries_after_flush(proxy_log) if "attempt" in entry]
    assert [entry["level"] for entry in entries] == ["info", "info"]
    assert entries[-1]["delivery_outcome"] == "retryable_failure"


def test_url_error_is_retryable(tmp_path, sync_usage_executor):
    proxy_log = tmp_path / "proxy.jsonl"
    payload = {"runId": "run-1", "events": []}
    payload_bytes = len(json.dumps(payload).encode())

    with (
        patch.object(
            urllib.request.OpenerDirector,
            "open",
            side_effect=urllib.error.URLError("connection refused"),
        ) as mock_open,
        patch.object(time, "sleep") as mock_sleep,
    ):
        assert usage.webhook.enqueue_webhook_delivery(
            "https://api.okou.ai/api/webhooks/agent/usage-event",
            "tok",
            payload,
            str(proxy_log),
            "usage_event",
        )
        sync_usage_executor.shutdown(wait=True)

    assert mock_open.call_count == 2
    mock_sleep.assert_called_once_with(0.5)
    entries = [entry for entry in read_jsonl_entries_after_flush(proxy_log) if "attempt" in entry]
    assert [entry["level"] for entry in entries] == ["info", "info"]
    assert [entry["attempt"] for entry in entries] == [1, 2]
    assert entries[-1]["delivery_outcome"] == "retryable_failure"
    for entry in entries:
        assert_body_free_webhook_entry(
            entry,
            run_id="run-1",
            event_count=0,
            payload_bytes=payload_bytes,
        )


def test_retry_failure_sanitizes_sensitive_webhook_url_in_message_and_error(
    tmp_path, sync_usage_executor
):
    proxy_log = tmp_path / "proxy.jsonl"
    payload = {"runId": "run-1", "events": []}
    payload_bytes = len(json.dumps(payload).encode())
    retry_url = "https://api.okou.ai/api/webhooks/agent/usage-event?token=secret#frag"
    url_without_fragment = retry_url.removesuffix("#frag")

    with patch.object(
        urllib.request.OpenerDirector,
        "open",
        side_effect=urllib.error.URLError(f"failed {retry_url} and {url_without_fragment}"),
    ):
        assert usage.webhook.enqueue_webhook_delivery(
            retry_url,
            "tok",
            payload,
            str(proxy_log),
            "usage_event",
        )
        sync_usage_executor.shutdown(wait=True)

    entries = read_jsonl_entries_after_flush(proxy_log)
    failure_entry = entries[-1]
    assert failure_entry["url"] == SANITIZED_WEBHOOK_URL
    assert SANITIZED_WEBHOOK_URL in failure_entry["message"]
    assert SANITIZED_WEBHOOK_URL in failure_entry["error"]
    assert "failed after 2 attempts" in failure_entry["message"]
    assert_body_free_webhook_entry(
        failure_entry,
        run_id="run-1",
        event_count=0,
        payload_bytes=payload_bytes,
    )
    for entry in entries:
        assert_sensitive_webhook_url_parts_absent(entry)


def test_http_400_is_permanent(tmp_path, real_flow, sync_usage_executor, usage_webhook_api):
    flow = model_usage_flow(real_flow, tmp_path)
    proxy_log = Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])

    with usage_webhook_api() as webhook:
        webhook.queue_response(400)
        _report_and_flush_model_usage(flow)

    assert webhook.request_count == 1
    entries = [entry for entry in read_jsonl_entries_after_flush(proxy_log) if "attempt" in entry]
    assert len(entries) == 1
    assert entries[0]["level"] == "error"
    assert entries[0]["attempt"] == 1
    assert "permanent HTTP error" in entries[0]["message"]


def test_other_webhook_404_remains_an_error(
    tmp_path,
    sync_usage_executor,
    usage_webhook_server,
):
    proxy_log = tmp_path / "proxy.jsonl"
    usage_webhook_server.queue_response(404)

    assert usage.webhook.enqueue_webhook_delivery(
        usage_webhook_server.url("/api/webhooks/agent/usage-event"),
        "tok",
        {"runId": "run-1", "events": []},
        str(proxy_log),
        "usage_event",
    )
    sync_usage_executor.shutdown(wait=True)

    entries = [entry for entry in read_jsonl_entries_after_flush(proxy_log) if "attempt" in entry]
    assert len(entries) == 1
    assert entries[0]["level"] == "error"
    assert "permanent HTTP error" in entries[0]["message"]
    assert "transition_drop" not in entries[0]


def test_payload_serialization_error_logs_body_free_summary(tmp_path, sync_usage_executor):
    proxy_log = tmp_path / "proxy.jsonl"

    assert usage.webhook.enqueue_webhook_delivery(
        "https://api.okou.ai/api/webhooks/agent/usage-event",
        "tok",
        {"runId": "run-1", "events": [object()]},
        str(proxy_log),
        "usage_event",
    )
    with pytest.raises(TypeError, match="not JSON serializable"):
        sync_usage_executor.shutdown(wait=True)

    entries = read_jsonl_entries_after_flush(proxy_log)
    error_entry = entries[-1]
    assert error_entry["level"] == "error"
    assert error_entry["attempt"] == 1
    assert "non-retryable" in error_entry["message"]
    assert_body_free_webhook_entry(
        error_entry,
        run_id="run-1",
        event_count=1,
    )


def test_falls_back_to_sync_after_shutdown(
    tmp_path, real_flow, fresh_usage_executor, usage_webhook_api
):
    """After executor shutdown, delivery happens synchronously before return."""
    control_root = tmp_path / "delivery-control"
    flow = model_usage_flow(real_flow, tmp_path)
    flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] = {"tokens.input": 42}
    usage.flush_usage_events(trigger="test")
    usage.webhook.usage_executor.shutdown(wait=True)

    with usage_webhook_api() as webhook:
        usage.report_model_provider_usage(flow, "run-1")
        usage.flush_usage_events(trigger="test")
        assert webhook.request_count == 1

    body = webhook.requests[0].json_body()
    assert body["runId"] == "run-1"
    assert body["events"][0]["quantity"] == 42
    assert body["events"][0]["category"] == "tokens.input"
    assert_pending(control_root, flows=0, buffered=0, reports=0)
