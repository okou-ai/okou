"""Anthropic Messages SSE usage and accounting integration tests."""

import gzip
import json
import threading
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import patch

import pytest
from mitmproxy import http
from mitmproxy.flow import Error

import anthropic_accounting
import body_decoding
import flow_metadata_keys as metadata_keys
import mitm_addon
import response_streaming
import usage
from tests.flow_helpers import response_stream
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.model_provider_flow_helpers import RealFlowFactory
from tests.model_provider_sse_usage_helpers import (
    assert_single_model_sse_parse_warning,
    compress_zlib_sse,
    model_provider_sse_flow,
    model_sse_parse_warnings,
    run_error,
    run_response,
)
from tests.pending_helpers import assert_pending
from tests.thread_helpers import ThreadUnderTest, wait_for_event
from tests.usage_buffer_helpers import event as usage_event
from tests.usage_helpers import (
    CapturedWebhookRequest,
    UsageWebhookServer,
    fresh_usage_executor_context,
)
from tests.webhook_test_helpers import (
    QueuedUsageExecutor,
    request_runner_usage_flush,
)

_TELEMETRY_PATH = "/api/webhooks/agent/telemetry"


def _anthropic_messages_sse_flow(
    tmp_path: Path,
    real_flow: RealFlowFactory,
) -> http.HTTPFlow:
    flow = model_provider_sse_flow(
        tmp_path,
        real_flow,
        host="api.anthropic.com",
        original_url="https://api.anthropic.com/v1/messages",
        firewall_name="model-provider:anthropic-api-key",
        model_usage_provider="claude-sonnet-4-6",
    )
    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "00000000-0000-0000-0000-000000025133"
    return flow


def _feed_incomplete_anthropic_sse_without_recoverable_usage(
    flow: http.HTTPFlow,
    *,
    encoding: str = "gzip",
) -> None:
    assert flow.response is not None
    flow.response.headers["content-encoding"] = encoding
    plaintext = (
        b"event: message_start\n"
        b'data: {"type":"message_start","message":{"model":"claude-sonnet-4-6",'
        b'"usage":{"input_tokens":0,"output_tokens":0}}}\n\n'
        b"event: message_stop\n"
        b'data: {"type":"message_stop"}\n\n'
    )
    mitm_addon.responseheaders(flow)
    response_stream(flow)(compress_zlib_sse(plaintext, encoding)[:-1])


def _anthropic_accounting_requests(
    webhook: UsageWebhookServer,
) -> list[CapturedWebhookRequest]:
    return [request for request in webhook.requests if request.path == _TELEMETRY_PATH]


def _anthropic_accounting_operations(
    webhook: UsageWebhookServer,
) -> list[dict[str, object]]:
    operations: list[dict[str, object]] = []
    for request in _anthropic_accounting_requests(webhook):
        request_operations = request.json_body().get("sandboxOperations")
        assert isinstance(request_operations, list)
        for operation in request_operations:
            assert isinstance(operation, dict)
            operations.append(operation)
    return operations


class TestAnthropicMessagesSseUsage:
    """Tests for Anthropic Messages SSE usage and accounting."""

    @pytest.fixture(autouse=True)
    def _sync_usage_delivery(self, sync_usage_executor, usage_webhook_api):
        self._usage_webhook_api = usage_webhook_api

    @pytest.mark.parametrize("encoding", ["gzip", "deflate"])
    @pytest.mark.parametrize("hook_name", ["response", "error"])
    @pytest.mark.parametrize(
        ("include_message_stop", "expected_status"),
        [
            (False, "recovered_partial"),
            (True, "recovered_terminal"),
        ],
        ids=["partial", "terminal"],
    )
    def test_full_pipeline_incomplete_compressed_anthropic_sse_recovers_complete_usage_events(
        self,
        tmp_path,
        real_flow,
        encoding,
        hook_name,
        include_message_stop,
        expected_status,
    ):
        flow = _anthropic_messages_sse_flow(tmp_path, real_flow)
        assert flow.response is not None
        flow.response.headers["content-encoding"] = encoding
        plaintext = (
            b"event: message_start\n"
            b'data: {"type":"message_start","message":{"id":"msg_private",'
            b'"model":"claude-sonnet-4-6","usage":{"input_tokens":101,'
            b'"cache_read_input_tokens":202,"cache_creation_input_tokens":303,'
            b'"output_tokens":1}}}\n\n'
            b"event: content_block_delta\n"
            b'data: {"type":"content_block_delta","delta":{"text":"sensitive-body"}}\n\n'
            b"event: message_delta\n"
            b'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},'
            b'"usage":{"output_tokens":404}}\n\n'
            + (
                b'event: message_stop\ndata: {"type":"message_stop"}\n\n'
                if include_message_stop
                else b""
            )
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(compress_zlib_sse(plaintext, encoding)[:-1])

        if hook_name == "error":
            flow.error = Error("connection reset by peer")
            webhook = run_error(flow, self._usage_webhook_api)
        else:
            assert hook_name == "response"
            webhook = run_response(flow, self._usage_webhook_api)

        expected_quantities = {
            "tokens.input": 101,
            "tokens.output": 404,
            "tokens.cache_read": 202,
            "tokens.cache_creation": 303,
        }
        assert {
            event["category"]: event["quantity"] for event in webhook.usage_events()
        } == expected_quantities
        assert_single_model_sse_parse_warning(
            flow,
            usage_protocol="anthropic_messages_sse",
            event="compressed_body",
            error=body_decoding.INCOMPLETE_COMPRESSED_BODY,
        )

        [request] = _anthropic_accounting_requests(webhook)
        assert request.header("authorization") == "Bearer tok-xyz"
        payload = request.json_body()
        assert payload["runId"] == "00000000-0000-0000-0000-000000025133"
        [operation] = _anthropic_accounting_operations(webhook)
        assert set(operation) == {
            "ts",
            "action_type",
            "duration_ms",
            "success",
            "error",
        }
        assert operation["action_type"] == f"anthropic_sse_incomplete_{expected_status}"
        assert operation["duration_ms"] == 0
        assert operation["success"] is False
        assert operation["error"] == body_decoding.INCOMPLETE_COMPRESSED_BODY
        assert datetime.fromisoformat(str(operation["ts"])).tzinfo == UTC
        serialized_request = request.body
        for excluded in [
            b"msg_private",
            b"claude-sonnet-4-6",
            b"sensitive-body",
            b"tokens.",
        ]:
            assert excluded not in serialized_request

    @pytest.mark.parametrize("encoding", ["gzip", "deflate"])
    def test_full_pipeline_incomplete_anthropic_sse_emits_no_recoverable_usage_status(
        self, tmp_path, real_flow, encoding
    ):
        flow = _anthropic_messages_sse_flow(tmp_path, real_flow)
        _feed_incomplete_anthropic_sse_without_recoverable_usage(
            flow,
            encoding=encoding,
        )
        webhook = run_response(flow, self._usage_webhook_api)

        assert webhook.usage_events() == []
        [operation] = _anthropic_accounting_operations(webhook)
        assert operation["action_type"] == "anthropic_sse_incomplete_no_recoverable_usage"
        assert_single_model_sse_parse_warning(
            flow,
            usage_protocol="anthropic_messages_sse",
            event="compressed_body",
            error=body_decoding.INCOMPLETE_COMPRESSED_BODY,
        )

    def test_incomplete_anthropic_accounting_missing_run_id_is_not_retained(
        self,
        tmp_path: Path,
        real_flow: RealFlowFactory,
        mitm_ctx,
        usage_webhook_server: UsageWebhookServer,
    ) -> None:
        flow = _anthropic_messages_sse_flow(tmp_path, real_flow)
        control_root = tmp_path

        with mitm_ctx(api_url=usage_webhook_server.api_url):
            _feed_incomplete_anthropic_sse_without_recoverable_usage(flow)
            flow.metadata[metadata_keys.SANDBOX_RUN_ID] = ""
            response_streaming.finalize_model_sse_usage(flow)

            assert _anthropic_accounting_requests(usage_webhook_server) == []
            assert_pending(
                control_root,
                flows=0,
                buffered=0,
                reports=0,
            )

            request_runner_usage_flush()

            assert _anthropic_accounting_requests(usage_webhook_server) == []
            assert_pending(
                control_root,
                flows=0,
                buffered=0,
                reports=0,
            )

    @pytest.mark.parametrize(
        ("sandbox_token", "has_api_url"),
        [
            pytest.param("", True, id="missing-sandbox-token"),
            pytest.param("tok-xyz", False, id="missing-api-url"),
        ],
    )
    def test_incomplete_anthropic_accounting_missing_reporting_context_is_not_retained(
        self,
        tmp_path: Path,
        real_flow: RealFlowFactory,
        mitm_ctx,
        usage_webhook_server: UsageWebhookServer,
        sandbox_token: str,
        has_api_url: bool,
    ) -> None:
        flow = _anthropic_messages_sse_flow(tmp_path, real_flow)
        flow.metadata[metadata_keys.SANDBOX_AUTH_KEY] = sandbox_token
        control_root = tmp_path
        api_url = usage_webhook_server.api_url if has_api_url else ""

        with mitm_ctx(api_url=api_url):
            _feed_incomplete_anthropic_sse_without_recoverable_usage(flow)
            mitm_addon.response(flow)

            assert _anthropic_accounting_requests(usage_webhook_server) == []
            assert_pending(
                control_root,
                flows=0,
                buffered=0,
                reports=0,
            )

            request_runner_usage_flush()

            assert _anthropic_accounting_requests(usage_webhook_server) == []
            assert_pending(
                control_root,
                flows=0,
                buffered=0,
                reports=0,
            )

    def test_saturated_incomplete_anthropic_accounting_retries_through_runner_flush(
        self,
        tmp_path: Path,
        real_flow,
        mitm_ctx,
        usage_webhook_server: UsageWebhookServer,
    ) -> None:
        flow = _anthropic_messages_sse_flow(tmp_path, real_flow)
        executor = QueuedUsageExecutor()
        control_root = tmp_path

        with (
            mitm_ctx(api_url=usage_webhook_server.api_url),
            patch.object(usage.webhook, "usage_executor", executor),
        ):
            for index in range(usage.webhook.MAX_PENDING_WEBHOOK_PAYLOADS):
                assert usage.webhook.enqueue_webhook_delivery(
                    usage_webhook_server.url("/filler"),
                    "tok-xyz",
                    {"runId": f"filler-{index}", "events": []},
                    str(tmp_path / "filler.jsonl"),
                    "usage_event",
                )

            _feed_incomplete_anthropic_sse_without_recoverable_usage(flow)
            mitm_addon.response(flow)
            retained_at = datetime.now(UTC)

            assert _anthropic_accounting_requests(usage_webhook_server) == []
            assert_pending(
                control_root,
                flows=0,
                buffered=1,
                reports=usage.webhook.MAX_PENDING_WEBHOOK_PAYLOADS,
            )

            assert (
                usage.buffer_usage_events(
                    usage_webhook_server.url("/usage-priority"),
                    "tok-xyz",
                    "usage-priority",
                    [usage_event(source_key="usage-priority")],
                    str(tmp_path / "proxy.jsonl"),
                )
                == 1
            )
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
            request_runner_usage_flush()

        [request] = _anthropic_accounting_requests(usage_webhook_server)
        assert request.json_body()["runId"] == "00000000-0000-0000-0000-000000025133"
        [operation] = _anthropic_accounting_operations(usage_webhook_server)
        assert operation["action_type"] == "anthropic_sse_incomplete_no_recoverable_usage"
        assert datetime.fromisoformat(str(operation["ts"])) <= retained_at
        assert [
            captured.path
            for captured in usage_webhook_server.requests
            if captured.path != "/filler"
        ] == ["/usage-priority", _TELEMETRY_PATH]
        assert usage.webhook.pending_delivery_payload_count_for_tests() == 0

    def test_done_retries_incomplete_anthropic_accounting_after_executor_join(
        self,
        tmp_path: Path,
        real_flow,
        mitm_ctx,
        usage_webhook_server: UsageWebhookServer,
    ) -> None:
        flow = _anthropic_messages_sse_flow(tmp_path, real_flow)
        control_root = tmp_path / "delivery-control"
        filler_log_path = tmp_path / "filler.jsonl"
        release_fillers = threading.Event()
        executor_shutdown_started = threading.Event()

        for _ in range(usage.webhook.USAGE_WEBHOOK_WORKERS):
            usage_webhook_server.queue_response(204, release_event=release_fillers)

        with fresh_usage_executor_context() as executor:
            original_shutdown = executor.shutdown

            def shutdown_executor(*, wait: bool) -> None:
                executor_shutdown_started.set()
                original_shutdown(wait=wait)

            with (
                mitm_ctx(api_url=usage_webhook_server.api_url),
                patch.object(executor, "shutdown", side_effect=shutdown_executor),
                patch.object(
                    mitm_addon.auth_base_forwarder,
                    "shutdown_forward_request_workers",
                ),
                patch.object(mitm_addon, "shutdown_log_writer"),
            ):
                done_thread = ThreadUnderTest(target=mitm_addon.done)
                try:
                    for index in range(usage.webhook.MAX_PENDING_WEBHOOK_PAYLOADS):
                        assert usage.webhook.enqueue_webhook_delivery(
                            usage_webhook_server.url("/filler"),
                            "tok-xyz",
                            {"runId": f"filler-{index}", "events": []},
                            str(filler_log_path),
                            "usage_event",
                        )
                    assert usage_webhook_server.wait_for_request_count(
                        usage.webhook.USAGE_WEBHOOK_WORKERS
                    )

                    _feed_incomplete_anthropic_sse_without_recoverable_usage(flow)
                    mitm_addon.response(flow)
                    assert _anthropic_accounting_requests(usage_webhook_server) == []
                    assert_pending(
                        control_root,
                        flows=0,
                        buffered=1,
                        reports=usage.webhook.MAX_PENDING_WEBHOOK_PAYLOADS,
                    )

                    done_thread.start()
                    wait_for_event(
                        executor_shutdown_started,
                        timeout=1,
                        threads=(done_thread,),
                        message="done did not begin executor shutdown",
                    )
                    assert done_thread.is_alive()
                    release_fillers.set()
                    done_thread.join_and_raise(timeout=2)
                finally:
                    release_fillers.set()
                    done_thread.join(timeout=2)

        [request] = _anthropic_accounting_requests(usage_webhook_server)
        assert request.json_body()["runId"] == "00000000-0000-0000-0000-000000025133"
        [operation] = _anthropic_accounting_operations(usage_webhook_server)
        assert operation["action_type"] == "anthropic_sse_incomplete_no_recoverable_usage"
        assert usage.webhook.pending_delivery_payload_count_for_tests() == 0
        assert_pending(
            control_root,
            flows=0,
            buffered=0,
            reports=0,
        )

    def test_incomplete_anthropic_accounting_retention_overflow_is_action_specific(
        self,
        tmp_path: Path,
        real_flow,
        mitm_ctx,
        usage_webhook_server: UsageWebhookServer,
    ) -> None:
        first_flow = _anthropic_messages_sse_flow(tmp_path, real_flow)
        first_flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-retained"
        overflow_flow = _anthropic_messages_sse_flow(tmp_path, real_flow)
        overflow_flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-overflow"
        executor = QueuedUsageExecutor()
        control_root = tmp_path / "delivery-control"

        with (
            mitm_ctx(api_url=usage_webhook_server.api_url),
            patch.object(usage.webhook, "usage_executor", executor),
            patch.object(anthropic_accounting, "MAX_RETAINED_REPORTS", 1),
        ):
            for index in range(usage.webhook.MAX_PENDING_WEBHOOK_PAYLOADS):
                assert usage.webhook.enqueue_webhook_delivery(
                    usage_webhook_server.url("/filler"),
                    "tok-xyz",
                    {"runId": f"filler-{index}", "events": []},
                    str(tmp_path / "filler.jsonl"),
                    "usage_event",
                )

            _feed_incomplete_anthropic_sse_without_recoverable_usage(first_flow)
            mitm_addon.response(first_flow)
            _feed_incomplete_anthropic_sse_without_recoverable_usage(overflow_flow)
            mitm_addon.response(overflow_flow)

            assert_pending(
                control_root,
                flows=0,
                buffered=1,
                reports=usage.webhook.MAX_PENDING_WEBHOOK_PAYLOADS,
            )
            overflow_entries = [
                entry
                for entry in read_jsonl_entries_after_flush(
                    Path(overflow_flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])
                )
                if entry.get("reason") == "anthropic_accounting_retention_saturated"
            ]
            [overflow_entry] = overflow_entries
            assert overflow_entry["type"] == "usage_underbilling"
            assert overflow_entry["underbilling_class"] == "risk"
            assert overflow_entry["component"] == "mitm_addon"
            assert overflow_entry["action_type"] == (
                "anthropic_sse_incomplete_no_recoverable_usage"
            )
            assert overflow_entry["run_id"] == "run-overflow"
            assert overflow_entry["retained_report_capacity"] == 1
            assert "tok-xyz" not in json.dumps(overflow_entry)

            anthropic_accounting.reset_for_tests()
            assert_pending(
                control_root,
                flows=0,
                buffered=0,
                reports=usage.webhook.MAX_PENDING_WEBHOOK_PAYLOADS,
            )
            executor.run_all()

        assert_pending(
            control_root,
            flows=0,
            buffered=0,
            reports=0,
        )
        assert _anthropic_accounting_requests(usage_webhook_server) == []
        assert usage.webhook.pending_delivery_payload_count_for_tests() == 0

    def test_full_pipeline_incomplete_compressed_anthropic_sse_does_not_flush_fragment(
        self, tmp_path, real_flow
    ):
        flow = _anthropic_messages_sse_flow(tmp_path, real_flow)
        assert flow.response is not None
        flow.response.headers["content-encoding"] = "gzip"
        plaintext = (
            b"event: message_start\n"
            b'data: {"type":"message_start","message":{"model":"claude-sonnet-4-6",'
            b'"usage":{"input_tokens":50,"output_tokens":0}}}\n\n'
            b"event: message_delta\n"
            b'data: {"type":"message_delta","usage":{"output_tokens":987654}}'
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(gzip.compress(plaintext)[:-1])
        webhook = run_response(flow, self._usage_webhook_api)

        assert {event["category"]: event["quantity"] for event in webhook.usage_events()} == {
            "tokens.input": 50
        }
        [operation] = _anthropic_accounting_operations(webhook)
        assert operation["action_type"] == "anthropic_sse_incomplete_recovered_partial"
        assert b"987654" not in _anthropic_accounting_requests(webhook)[0].body

    @pytest.mark.parametrize("encoding", ["gzip", "deflate"])
    def test_full_pipeline_invalid_compressed_anthropic_sse_remains_fail_closed(
        self, tmp_path, real_flow, encoding
    ):
        flow = _anthropic_messages_sse_flow(tmp_path, real_flow)
        assert flow.response is not None
        flow.response.headers["content-encoding"] = encoding
        plaintext = (
            b"event: message_start\n"
            b'data: {"type":"message_start","message":{"model":"claude-sonnet-4-6",'
            b'"usage":{"input_tokens":50}}}\n\n'
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(compress_zlib_sse(plaintext, encoding) + b"not-compressed")
        webhook = run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
        assert _anthropic_accounting_operations(webhook) == []
        assert_single_model_sse_parse_warning(
            flow,
            usage_protocol="anthropic_messages_sse",
            event="compressed_body",
            error=body_decoding.INVALID_COMPRESSED_BODY,
        )

    def test_full_pipeline_decoded_limit_anthropic_sse_remains_fail_closed(
        self, tmp_path, real_flow
    ):
        flow = _anthropic_messages_sse_flow(tmp_path, real_flow)
        assert flow.response is not None
        flow.response.headers["content-encoding"] = "gzip"
        plaintext = (
            b"event: message_start\n"
            b'data: {"type":"message_start","message":{"model":"claude-sonnet-4-6",'
            b'"usage":{"input_tokens":50}}}\n\n'
            b"event: content_block_delta\n"
            b"data: " + b"x" * (5 * 1024 * 1024 + 1)
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(gzip.compress(plaintext))
        webhook = run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
        assert _anthropic_accounting_operations(webhook) == []
        assert_single_model_sse_parse_warning(
            flow,
            usage_protocol="anthropic_messages_sse",
            event="compressed_body",
            error=body_decoding.DECODED_BODY_LIMIT_EXCEEDED,
        )

    def test_full_pipeline_response_then_error_emits_recovered_usage_and_telemetry_once(
        self, tmp_path, real_flow, mitm_ctx
    ):
        flow = _anthropic_messages_sse_flow(tmp_path, real_flow)
        assert flow.response is not None
        flow.response.headers["content-encoding"] = "gzip"
        plaintext = (
            b"event: message_start\n"
            b'data: {"type":"message_start","message":{"model":"claude-sonnet-4-6",'
            b'"usage":{"input_tokens":50}}}\n\n'
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(gzip.compress(plaintext)[:-1])
        webhook = UsageWebhookServer()
        with webhook.run(), mitm_ctx(api_url=webhook.api_url):
            mitm_addon.response(flow)
            flow.error = Error("connection reset after response")
            mitm_addon.error(flow)
            usage.flush_usage_events(trigger="test")

        assert [(event["category"], event["quantity"]) for event in webhook.usage_events()] == [
            ("tokens.input", 50)
        ]
        assert [
            operation["action_type"] for operation in _anthropic_accounting_operations(webhook)
        ] == ["anthropic_sse_incomplete_recovered_partial"]
        assert_single_model_sse_parse_warning(
            flow,
            usage_protocol="anthropic_messages_sse",
            event="compressed_body",
            error=body_decoding.INCOMPLETE_COMPRESSED_BODY,
        )

    def test_full_pipeline_anthropic_sse_logs_truncated_message_start(self, tmp_path, real_flow):
        flow = model_provider_sse_flow(
            tmp_path,
            real_flow,
            host="api.anthropic.com",
            original_url="https://api.anthropic.com/v1/messages",
            firewall_name="model-provider:anthropic-api-key",
            model_usage_provider="claude-sonnet-4-6",
        )
        mitm_addon.responseheaders(flow)
        response_stream(flow)(
            b'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","mod'
        )

        webhook = run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
        assert_single_model_sse_parse_warning(
            flow,
            usage_protocol="anthropic_messages_sse",
            event="message_start",
        )

    def test_full_pipeline_anthropic_sse_error_logs_truncated_message_start(
        self, tmp_path, real_flow
    ):
        flow = model_provider_sse_flow(
            tmp_path,
            real_flow,
            host="api.anthropic.com",
            original_url="https://api.anthropic.com/v1/messages",
            firewall_name="model-provider:anthropic-api-key",
            model_usage_provider="claude-sonnet-4-6",
        )
        mitm_addon.responseheaders(flow)
        response_stream(flow)(
            b'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","mod'
        )
        flow.error = Error("connection reset by peer")

        webhook = run_error(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
        assert_single_model_sse_parse_warning(
            flow,
            usage_protocol="anthropic_messages_sse",
            event="message_start",
        )

    def test_full_pipeline_anthropic_sse_logs_malformed_message_start(self, tmp_path, real_flow):
        flow = model_provider_sse_flow(
            tmp_path,
            real_flow,
            host="api.anthropic.com",
            original_url="https://api.anthropic.com/v1/messages",
            firewall_name="model-provider:anthropic-api-key",
            model_usage_provider="claude-sonnet-4-6",
        )
        mitm_addon.responseheaders(flow)
        response_stream(flow)(b"event: message_start\ndata: {invalid json}\n\n")

        webhook = run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
        assert_single_model_sse_parse_warning(
            flow,
            usage_protocol="anthropic_messages_sse",
            event="message_start",
        )

    def test_full_pipeline_anthropic_sse_logs_truncated_message_delta_after_start(
        self, tmp_path, real_flow
    ):
        flow = model_provider_sse_flow(
            tmp_path,
            real_flow,
            host="api.anthropic.com",
            original_url="https://api.anthropic.com/v1/messages",
            firewall_name="model-provider:anthropic-api-key",
            model_usage_provider="claude-sonnet-4-6",
        )
        mitm_addon.responseheaders(flow)
        response_stream(flow)(
            b"event: message_start\n"
            b'data: {"type":"message_start","message":{"id":"msg_1",'
            b'"model":"claude-sonnet-4-6","usage":{"input_tokens":50}}}\n\n'
            b"event: message_delta\n"
            b'data: {"type":"message_delta","usage":{"output_tokens":'
        )

        webhook = run_response(flow, self._usage_webhook_api)

        events = webhook.usage_events()
        by_category = {event["category"]: event["quantity"] for event in events}
        assert by_category == {"tokens.input": 50}
        assert {event["provider"] for event in events} == {"claude-sonnet-4-6"}
        assert_single_model_sse_parse_warning(
            flow,
            usage_protocol="anthropic_messages_sse",
            event="message_delta",
        )

    def test_full_pipeline_eventless_incomplete_anthropic_usage_sse_warns(
        self, tmp_path, real_flow
    ):
        flow = model_provider_sse_flow(
            tmp_path,
            real_flow,
            host="api.anthropic.com",
            original_url="https://api.anthropic.com/v1/messages",
            firewall_name="model-provider:anthropic-api-key",
            model_usage_provider="claude-sonnet-4-6",
        )
        mitm_addon.responseheaders(flow)
        response_stream(flow)(
            b'data: {"type":"message_start","message":{"id":"msg_1","model":"claude'
        )

        webhook = run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
        assert_single_model_sse_parse_warning(
            flow,
            usage_protocol="anthropic_messages_sse",
            event="message_start",
        )

    def test_full_pipeline_anthropic_non_usage_incomplete_sse_does_not_warn(
        self, tmp_path, real_flow
    ):
        flow = model_provider_sse_flow(
            tmp_path,
            real_flow,
            host="api.anthropic.com",
            original_url="https://api.anthropic.com/v1/messages",
            firewall_name="model-provider:anthropic-api-key",
            model_usage_provider="claude-sonnet-4-6",
        )
        mitm_addon.responseheaders(flow)
        response_stream(flow)(
            b"event: content_block_delta\n"
            b'data: {"type":"content_block_delta","delta":{"text":"hello'
        )

        webhook = run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
        assert model_sse_parse_warnings(flow) == []
