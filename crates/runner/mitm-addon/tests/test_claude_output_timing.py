"""Tests for Claude Code provider-output timing observations."""

import gzip
import json
from datetime import UTC, datetime
from itertools import pairwise
from pathlib import Path
from unittest.mock import patch

import pytest
from mitmproxy import http
from mitmproxy.flow import Error

import claude_output_timing
import flow_metadata_keys as metadata_keys
import mitm_addon
import usage
from tests.flow_helpers import response_stream
from tests.jsonl_log_helpers import read_jsonl_text_after_flush
from tests.model_provider_flow_helpers import make_model_provider_sse_flow
from tests.pending_helpers import assert_pending
from tests.usage_buffer_helpers import event as usage_event
from tests.usage_helpers import CapturedWebhookRequest, UsageWebhookServer
from tests.webhook_test_helpers import (
    QueuedUsageExecutor,
    request_runner_usage_flush,
)

_TELEMETRY_PATH = "/api/webhooks/agent/telemetry"
_FIRST_MESSAGE_START = "claude_proxy_first_message_start"
_FIRST_THINKING_OR_TEXT_BLOCK_START = "claude_proxy_first_thinking_or_text_block_start"
_FIRST_TEXT_BLOCK_START = "claude_proxy_first_text_block_start"


def _claude_sse_flow(
    real_flow,
    tmp_path: Path,
    *,
    cli_agent_type: str | None = "claude-code",
    model_usage_provider: str | None = "claude-sonnet-4-6",
) -> http.HTTPFlow:
    return make_model_provider_sse_flow(
        real_flow,
        tmp_path,
        host="api.anthropic.com",
        original_url="https://api.anthropic.com/v1/messages",
        firewall_name="model-provider:anthropic-api-key",
        cli_agent_type=cli_agent_type,
        model_usage_provider=model_usage_provider,
    )


def _message_start(*, secret: str | None = None, include_usage: bool = True) -> bytes:
    content: list[dict[str, str]] = []
    if secret is not None:
        content.append({"type": "text", "text": secret})
    message: dict[str, object] = {
        "id": "msg_1",
        "model": "claude-sonnet-4-6",
        "content": content,
    }
    if include_usage:
        message["usage"] = {"input_tokens": 50, "output_tokens": 1}
    return _sse_event(
        "message_start",
        {
            "type": "message_start",
            "message": message,
        },
    )


def _content_block_start(block_type: str, *, secret: str | None = None) -> bytes:
    content_block: dict[str, str] = {"type": block_type}
    if secret is not None:
        content_block["content"] = secret
        content_block["text"] = secret
        content_block["thinking"] = secret
    return _sse_event(
        "content_block_start",
        {
            "type": "content_block_start",
            "index": 0,
            "content_block": content_block,
        },
    )


def _sse_event(event_type: str, payload: dict[str, object]) -> bytes:
    return (
        f"event: {event_type}\n".encode()
        + b"data: "
        + json.dumps(payload, separators=(",", ":")).encode()
        + b"\n\n"
    )


def _timing_requests(webhook: UsageWebhookServer) -> list[CapturedWebhookRequest]:
    return [request for request in webhook.requests if request.path == _TELEMETRY_PATH]


def _operations(requests: list[CapturedWebhookRequest]) -> list[dict[str, object]]:
    operations: list[dict[str, object]] = []
    for request in requests:
        body = request.json_body()
        request_operations = body.get("sandboxOperations")
        assert isinstance(request_operations, list)
        for operation in request_operations:
            assert isinstance(operation, dict)
            operations.append(operation)
    return operations


def _feed(flow: http.HTTPFlow, *events: bytes) -> None:
    callback = response_stream(flow)
    for event in events:
        assert callback(event) == event


@pytest.mark.parametrize("thinking_type", ["thinking", "redacted_thinking"])
def test_reports_content_free_lifecycle_milestones_and_preserves_usage(
    tmp_path: Path,
    real_flow,
    mitm_ctx,
    usage_webhook_server: UsageWebhookServer,
    sync_usage_executor,
    thinking_type: str,
) -> None:
    flow = _claude_sse_flow(real_flow, tmp_path)
    proxy_log = Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])
    secret = "provider-secret-that-must-not-be-reported"

    with mitm_ctx(api_url=usage_webhook_server.api_url):
        mitm_addon.responseheaders(flow)
        _feed(
            flow,
            _message_start(secret=secret),
            _content_block_start(thinking_type, secret=secret),
            _content_block_start("text", secret=secret),
        )
        mitm_addon.response(flow)
        usage.flush_usage_events(trigger="test")

    requests = _timing_requests(usage_webhook_server)
    assert [len(request.json_body()["sandboxOperations"]) for request in requests] == [
        1,
        1,
        1,
    ]
    assert all(request.header("authorization") == "Bearer tok-xyz" for request in requests)

    operations = _operations(requests)
    assert [operation["action_type"] for operation in operations] == [
        _FIRST_MESSAGE_START,
        _FIRST_THINKING_OR_TEXT_BLOCK_START,
        _FIRST_TEXT_BLOCK_START,
    ]
    assert all(operation["duration_ms"] == 0 for operation in operations)
    assert all(operation["success"] is True for operation in operations)
    timestamps = [datetime.fromisoformat(str(operation["ts"])) for operation in operations]
    assert timestamps == sorted(timestamps)
    assert all(timestamp.tzinfo == UTC for timestamp in timestamps)
    assert all(request.json_body()["runId"] == "run-abc-123" for request in requests)

    usage_events = usage_webhook_server.usage_events()
    assert {event["category"]: event["quantity"] for event in usage_events} == {
        "tokens.input": 50,
        "tokens.output": 1,
    }
    serialized_requests = b"".join(request.body for request in requests)
    assert secret.encode() not in serialized_requests
    assert secret not in read_jsonl_text_after_flush(proxy_log)


def test_content_block_first_retains_broad_and_text_milestones(
    tmp_path: Path,
    real_flow,
    mitm_ctx,
    usage_webhook_server: UsageWebhookServer,
    sync_usage_executor,
) -> None:
    flow = _claude_sse_flow(real_flow, tmp_path)
    secret = "provider-secret-that-must-not-be-reported"

    with mitm_ctx(api_url=usage_webhook_server.api_url):
        mitm_addon.responseheaders(flow)
        _feed(flow, _content_block_start("text", secret=secret))
        mitm_addon.response(flow)

    requests = _timing_requests(usage_webhook_server)
    assert [len(request.json_body()["sandboxOperations"]) for request in requests] == [2]
    operations = _operations(requests)
    assert [operation["action_type"] for operation in operations] == [
        _FIRST_THINKING_OR_TEXT_BLOCK_START,
        _FIRST_TEXT_BLOCK_START,
    ]
    assert operations[0]["ts"] == operations[1]["ts"]
    assert all(request.json_body()["runId"] == "run-abc-123" for request in requests)
    assert secret.encode() not in b"".join(request.body for request in requests)


def test_tool_turns_reconnects_and_reused_sandboxes_preserve_run_boundaries(
    tmp_path: Path,
    real_flow,
    mitm_ctx,
    usage_webhook_server: UsageWebhookServer,
    sync_usage_executor,
) -> None:
    with mitm_ctx(api_url=usage_webhook_server.api_url):
        tool_only = _claude_sse_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(tool_only)
        _feed(tool_only, _message_start(), _content_block_start("tool_use"))
        mitm_addon.response(tool_only)

        later_turn = _claude_sse_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(later_turn)
        _feed(
            later_turn,
            _message_start(),
            _content_block_start("thinking"),
            _content_block_start("text"),
        )
        mitm_addon.response(later_turn)

        reconnect = _claude_sse_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(reconnect)
        _feed(
            reconnect,
            _message_start(),
            _content_block_start("redacted_thinking"),
            _content_block_start("text"),
        )
        mitm_addon.response(reconnect)

        reused_sandbox_run = _claude_sse_flow(real_flow, tmp_path)
        reused_sandbox_run.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-reused-sandbox"
        mitm_addon.responseheaders(reused_sandbox_run)
        _feed(
            reused_sandbox_run,
            _message_start(),
            _content_block_start("thinking"),
            _content_block_start("text"),
        )
        mitm_addon.response(reused_sandbox_run)

    operations_by_run: dict[str, list[dict[str, object]]] = {}
    for request in _timing_requests(usage_webhook_server):
        body = request.json_body()
        run_id = body["runId"]
        assert isinstance(run_id, str)
        operations_by_run.setdefault(run_id, []).extend(_operations([request]))

    expected_actions = [
        _FIRST_MESSAGE_START,
        _FIRST_THINKING_OR_TEXT_BLOCK_START,
        _FIRST_TEXT_BLOCK_START,
    ]
    assert {
        run_id: [operation["action_type"] for operation in operations]
        for run_id, operations in operations_by_run.items()
    } == {
        "run-abc-123": expected_actions,
        "run-reused-sandbox": expected_actions,
    }


def test_irrelevant_flows_and_events_do_not_report_timings(
    tmp_path: Path,
    real_flow,
    mitm_ctx,
    usage_webhook_server: UsageWebhookServer,
    sync_usage_executor,
) -> None:
    with mitm_ctx(api_url=usage_webhook_server.api_url):
        for flow in (
            _claude_sse_flow(real_flow, tmp_path, cli_agent_type="codex"),
            _claude_sse_flow(real_flow, tmp_path, cli_agent_type=None),
        ):
            mitm_addon.responseheaders(flow)
            _feed(flow, _message_start(), _content_block_start("text"))

        non_sse = _claude_sse_flow(real_flow, tmp_path)
        assert non_sse.response is not None
        non_sse.response.headers["content-type"] = "application/json"
        mitm_addon.responseheaders(non_sse)
        _feed(non_sse, _message_start(), _content_block_start("text"))

        tool_only = _claude_sse_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(tool_only)
        _feed(tool_only, _content_block_start("tool_use"))

        mismatched = _claude_sse_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(mismatched)
        _feed(
            mismatched,
            _sse_event(
                "content_block_start",
                {
                    "type": "message_start",
                    "content_block": {"type": "text"},
                },
            ),
            _sse_event(
                "content_block_delta",
                {
                    "type": "content_block_delta",
                    "delta": {"type": "text_delta", "text": "secret"},
                },
            ),
        )

    assert _timing_requests(usage_webhook_server) == []


def test_gzip_chunks_are_observed_without_changing_forwarded_bytes(
    tmp_path: Path,
    real_flow,
    mitm_ctx,
    usage_webhook_server: UsageWebhookServer,
    sync_usage_executor,
) -> None:
    flow = _claude_sse_flow(real_flow, tmp_path)
    assert flow.response is not None
    flow.response.headers["content-encoding"] = "gzip"
    plaintext = _message_start() + _content_block_start("text")
    compressed = gzip.compress(plaintext)

    with mitm_ctx(api_url=usage_webhook_server.api_url):
        mitm_addon.responseheaders(flow)
        callback = response_stream(flow)
        offsets = (0, 1, 7, len(compressed) // 2, len(compressed))
        for start, end in pairwise(offsets):
            chunk = compressed[start:end]
            assert callback(chunk) == chunk
        mitm_addon.response(flow)

    assert [
        operation["action_type"]
        for operation in _operations(_timing_requests(usage_webhook_server))
    ] == [
        _FIRST_MESSAGE_START,
        _FIRST_THINKING_OR_TEXT_BLOCK_START,
        _FIRST_TEXT_BLOCK_START,
    ]


@pytest.mark.parametrize(
    ("sandbox_token", "api_url"),
    [
        pytest.param("", "https://api.test", id="missing-sandbox-token"),
        pytest.param("tok-xyz", "", id="missing-api-url"),
    ],
)
def test_incomplete_context_retains_timing_until_complete_retry(
    tmp_path: Path,
    real_flow,
    mitm_ctx,
    sandbox_token: str,
    api_url: str,
) -> None:
    control_root = tmp_path / "delivery-control"
    delivery_available = False
    admission_calls: list[tuple[str, str, dict[str, object], str, str]] = []

    def enqueue_timing_delivery(
        url: str,
        admitted_sandbox_token: str,
        payload: dict[str, object],
        proxy_log_path: str,
        log_type: str,
    ) -> bool:
        admission_calls.append((url, admitted_sandbox_token, payload, proxy_log_path, log_type))
        return delivery_available

    incomplete_flow = _claude_sse_flow(real_flow, tmp_path)
    incomplete_flow.metadata[metadata_keys.SANDBOX_AUTH_KEY] = sandbox_token

    with patch.object(
        usage.webhook,
        "enqueue_webhook_delivery",
        side_effect=enqueue_timing_delivery,
    ):
        first_event_started_at = datetime.now(UTC)
        with mitm_ctx(api_url=api_url):
            mitm_addon.responseheaders(incomplete_flow)
            _feed(incomplete_flow, _message_start(include_usage=False))
            first_event_finished_at = datetime.now(UTC)
            mitm_addon.response(incomplete_flow)

        assert admission_calls == []
        assert_pending(
            control_root,
            flows=0,
            buffered=0,
            reports=0,
        )

        delivery_available = True
        complete_flow = _claude_sse_flow(real_flow, tmp_path)
        with mitm_ctx(api_url="https://api.test"):
            mitm_addon.responseheaders(complete_flow)
            _feed(complete_flow, _message_start(include_usage=False))
            mitm_addon.response(complete_flow)

    [(url, admitted_token, payload, proxy_log_path, log_type)] = admission_calls
    assert url == "https://api.test/api/webhooks/agent/telemetry"
    assert admitted_token == "tok-xyz"
    assert proxy_log_path == str(tmp_path / "proxy.jsonl")
    assert log_type == "claude_output_timing"
    assert payload["runId"] == "run-abc-123"
    operations = payload["sandboxOperations"]
    assert isinstance(operations, list)
    [operation] = operations
    assert isinstance(operation, dict)
    assert operation == {
        "ts": operation["ts"],
        "action_type": _FIRST_MESSAGE_START,
        "duration_ms": 0,
        "success": True,
    }
    observed_at_value = operation["ts"]
    assert isinstance(observed_at_value, str)
    observed_at = datetime.fromisoformat(observed_at_value)
    assert first_event_started_at <= observed_at <= first_event_finished_at
    assert_pending(
        control_root,
        flows=0,
        buffered=0,
        reports=0,
    )


def test_eviction_and_reset_release_retained_buffered_report(
    tmp_path: Path,
    real_flow,
    mitm_ctx,
) -> None:
    control_root = tmp_path / "delivery-control"

    with (
        mitm_ctx(api_url="https://api.test"),
        patch.object(
            usage.webhook,
            "enqueue_webhook_delivery",
            return_value=False,
        ),
        patch.object(claude_output_timing._store, "_max_tracked_runs", 1),
    ):
        first_flow = _claude_sse_flow(real_flow, tmp_path)
        first_flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-first"
        mitm_addon.responseheaders(first_flow)
        _feed(first_flow, _message_start(include_usage=False))

        second_flow = _claude_sse_flow(real_flow, tmp_path)
        second_flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-second"
        mitm_addon.responseheaders(second_flow)
        _feed(second_flow, _message_start(include_usage=False))

        assert_pending(
            control_root,
            flows=0,
            buffered=1,
            reports=0,
        )

        claude_output_timing.reset_for_tests()

    assert_pending(
        control_root,
        flows=0,
        buffered=0,
        reports=0,
    )


def test_lru_hit_recency_preserves_recent_buffered_report(
    tmp_path: Path,
    real_flow,
    mitm_ctx,
) -> None:
    control_root = tmp_path / "delivery-control"
    delivery_available = False

    def enqueue_timing_delivery(
        _url: str,
        _sandbox_token: str,
        _payload: dict[str, object],
        _proxy_log_path: str,
        _log_type: str,
    ) -> bool:
        return delivery_available

    def claude_flow(run_id: str) -> http.HTTPFlow:
        flow = _claude_sse_flow(real_flow, tmp_path)
        flow.metadata[metadata_keys.SANDBOX_RUN_ID] = run_id
        mitm_addon.responseheaders(flow)
        return flow

    with (
        mitm_ctx(api_url="https://api.test"),
        patch.object(
            usage.webhook,
            "enqueue_webhook_delivery",
            side_effect=enqueue_timing_delivery,
        ),
        patch.object(claude_output_timing._store, "_max_tracked_runs", 2),
    ):
        first_flow = claude_flow("run-a")
        _feed(first_flow, _message_start(include_usage=False))

        second_flow = claude_flow("run-b")
        _feed(second_flow, _message_start(include_usage=False))

        mitm_addon.response(claude_flow("run-a"))

        overflow_flow = claude_flow("run-c")
        _feed(overflow_flow, _message_start(include_usage=False))

        assert_pending(
            control_root,
            flows=0,
            buffered=2,
            reports=0,
        )

        delivery_available = True
        mitm_addon.response(claude_flow("run-b"))
        assert_pending(
            control_root,
            flows=0,
            buffered=2,
            reports=0,
        )

        mitm_addon.response(claude_flow("run-a"))
        assert_pending(
            control_root,
            flows=0,
            buffered=1,
            reports=0,
        )


@pytest.mark.parametrize("terminal_hook", ["response", "error"])
def test_repeated_runner_flush_retries_saturated_timing_after_terminal(
    tmp_path: Path,
    real_flow,
    mitm_ctx,
    usage_webhook_server: UsageWebhookServer,
    terminal_hook: str,
) -> None:
    flow = _claude_sse_flow(real_flow, tmp_path)
    executor = QueuedUsageExecutor()
    control_root = tmp_path
    secret = "provider-secret-that-must-not-be-reported"

    with (
        mitm_ctx(api_url=usage_webhook_server.api_url),
        patch.object(usage.webhook, "usage_executor", executor),
    ):
        mitm_addon.responseheaders(flow)
        for index in range(usage.webhook.MAX_PENDING_WEBHOOK_PAYLOADS):
            assert usage.webhook.enqueue_webhook_delivery(
                usage_webhook_server.url("/filler"),
                "tok-xyz",
                {"runId": f"filler-{index}", "events": []},
                str(tmp_path / "filler.jsonl"),
                "usage_event",
            )

        _feed(flow, _message_start(secret=secret, include_usage=False))
        assert _timing_requests(usage_webhook_server) == []

        if terminal_hook == "error":
            flow.error = Error("connection reset by peer")
            mitm_addon.error(flow)
        else:
            mitm_addon.response(flow)

        usage.buffer_usage_events(
            usage_webhook_server.url("/usage-priority"),
            "tok-xyz",
            f"usage-priority-{terminal_hook}",
            [usage_event(source_key=f"source-{terminal_hook}")],
            str(tmp_path / "proxy.jsonl"),
        )
        first_flush_started_at = datetime.now(UTC)
        request_runner_usage_flush()
        assert_pending(
            control_root,
            flows=0,
            buffered=2,
            reports=usage.webhook.MAX_PENDING_WEBHOOK_PAYLOADS,
        )

        executor.run_next()
        request_runner_usage_flush()
        assert_pending(
            control_root,
            flows=0,
            buffered=2,
            reports=usage.webhook.MAX_PENDING_WEBHOOK_PAYLOADS,
        )

        executor.run_last()
        request_runner_usage_flush()
        assert_pending(
            control_root,
            flows=0,
            buffered=0,
            reports=usage.webhook.MAX_PENDING_WEBHOOK_PAYLOADS,
        )

        executor.run_all()
        request_runner_usage_flush()
        assert_pending(
            control_root,
            flows=0,
            buffered=0,
            reports=0,
        )

    [request] = _timing_requests(usage_webhook_server)
    [operation] = _operations([request])
    assert operation["action_type"] == _FIRST_MESSAGE_START
    assert datetime.fromisoformat(str(operation["ts"])) <= first_flush_started_at
    assert secret.encode() not in request.body
    assert [
        captured.path for captured in usage_webhook_server.requests if captured.path != "/filler"
    ] == ["/usage-priority", _TELEMETRY_PATH]
    assert usage.webhook.pending_delivery_payload_count_for_tests() == 0
    assert flow.response is not None
    assert flow.response.stream is False
