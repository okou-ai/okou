"""OpenAI Responses-shaped model-provider SSE usage integration tests."""

import gzip
import json
import uuid
from pathlib import Path

import brotli
import pytest
from mitmproxy import http
from mitmproxy.flow import Error

import body_decoding
import flow_metadata_keys as metadata_keys
import mitm_addon
from tests.flow_helpers import response_stream
from tests.model_provider_flow_helpers import RealFlowFactory, model_usage_source_entries
from tests.model_provider_sse_usage_helpers import (
    assert_single_model_sse_parse_warning,
    compress_zlib_sse,
    model_provider_sse_flow,
    model_sse_parse_warnings,
    run_error,
    run_response,
)
from usage import flush_usage_events, openai_responses


def _openai_responses_sse_flow(
    tmp_path: Path,
    real_flow: RealFlowFactory,
    *,
    model_usage_provider: str = "gpt-5.5",
) -> http.HTTPFlow:
    flow = model_provider_sse_flow(
        tmp_path,
        real_flow,
        host="openrouter.ai",
        original_url="https://openrouter.ai/api/v1/responses",
        firewall_name="model-provider:openrouter-codex",
        cli_agent_type="codex",
        model_usage_provider=model_usage_provider,
    )
    flow.metadata[metadata_keys.RESPONSE_ENCODING_NEGOTIATION] = "already_stream_decodable"
    return flow


class TestOpenAIResponsesSseUsage:
    """Tests for OpenAI Responses-shaped SSE usage reporting."""

    @pytest.fixture(autouse=True)
    def _sync_usage_delivery(self, sync_usage_executor, usage_webhook_api):
        self._usage_webhook_api = usage_webhook_api

    def test_full_pipeline_model_sse_finalizes_trailing_event(self, tmp_path, real_flow):
        """response() must flush a trailing SSE usage event before reporting."""
        flow = _openai_responses_sse_flow(
            tmp_path,
            real_flow,
            model_usage_provider="gpt-5.6-sol",
        )
        mitm_addon.responseheaders(flow)
        assert metadata_keys.STREAM_BUFFER not in flow.metadata
        assert metadata_keys.STREAM_BUFFER_STATE not in flow.metadata
        response_stream(flow)(
            b"event: response.completed\n"
            b'data: {"response":{"model":"gpt-5.6-sol",'
            b'"usage":{"input_tokens":50,"output_tokens":20,'
            b'"input_tokens_details":{"cached_tokens":10,'
            b'"cache_write_tokens":15}}}}'
        )

        webhook = run_response(flow, self._usage_webhook_api)

        events = webhook.usage_events()
        by_category = {event["category"]: event["quantity"] for event in events}
        assert len(events) == len(by_category)
        assert by_category == {
            "tokens.input": 25,
            "tokens.output": 20,
            "tokens.cache_read": 10,
            "tokens.cache_creation": 15,
        }

    def test_full_pipeline_pi_responses_path_reports_usage(self, tmp_path, real_flow):
        flow = model_provider_sse_flow(
            tmp_path,
            real_flow,
            host="openrouter.ai",
            original_url="https://openrouter.ai/api/v1/responses",
            firewall_name="model-provider:openrouter-codex",
            cli_agent_type="pi",
            model_usage_provider="okou-1.0",
        )
        mitm_addon.responseheaders(flow)
        response_stream(flow)(
            b"event: response.completed\n"
            b'data: {"type":"response.completed","response":{"model":"openai/gpt-6-luna",'
            b'"usage":{"input_tokens":7131,"output_tokens":49,'
            b'"input_tokens_details":{"cached_tokens":5504}}}}\n\n'
        )

        webhook = run_response(flow, self._usage_webhook_api)

        assert {event["category"]: event["quantity"] for event in webhook.usage_events()} == {
            "tokens.input": 1627,
            "tokens.output": 49,
            "tokens.cache_read": 5504,
        }

    def test_full_pipeline_openai_sse_reports_long_context_items(self, tmp_path, real_flow):
        flow = _openai_responses_sse_flow(
            tmp_path,
            real_flow,
            model_usage_provider="gpt-5.6-sol",
        )
        flow.metadata[metadata_keys.MODEL_USAGE_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS] = 272_001
        mitm_addon.responseheaders(flow)
        response_stream(flow)(
            b"event: response.completed\n"
            b'data: {"response":{"model":"gpt-5.6-sol",'
            b'"usage":{"input_tokens":272001,"output_tokens":20,'
            b'"input_tokens_details":{"cached_tokens":70000,'
            b'"cache_write_tokens":2001}}}}\n\n'
        )

        webhook = run_response(flow, self._usage_webhook_api)

        assert {event["category"]: event["quantity"] for event in webhook.usage_events()} == {
            "tokens.input.long_context": 200_000,
            "tokens.output.long_context": 20,
            "tokens.cache_read.long_context": 70_000,
            "tokens.cache_creation.long_context": 2_001,
        }

    def test_full_pipeline_openai_sse_reports_usage_with_oversized_type(self, tmp_path, real_flow):
        flow = _openai_responses_sse_flow(tmp_path, real_flow)
        mitm_addon.responseheaders(flow)
        response_stream(flow)(
            b"event: response.completed\n"
            b'data: {"type":"' + b"x" * 2048 + b'","response":{"model":"gpt-5.5",'
            b'"usage":{"input_tokens":50,"output_tokens":20}}}\n\n'
        )

        webhook = run_response(flow, self._usage_webhook_api)

        events = webhook.usage_events()
        by_category = {event["category"]: event["quantity"] for event in events}
        assert by_category == {
            "tokens.input": 50,
            "tokens.output": 20,
        }
        assert model_sse_parse_warnings(flow) == []

    @pytest.mark.parametrize("capture_body", [False, True])
    def test_brotli_sse_reports_usage(self, tmp_path, real_flow, capture_body):
        flow = _openai_responses_sse_flow(tmp_path, real_flow)
        assert flow.response is not None
        flow.response.headers["content-encoding"] = "br"
        if capture_body:
            flow.metadata[metadata_keys.CAPTURE_BODY] = True
        plaintext = (
            b"event: response.completed\n"
            b'data: {"response":{"id":"resp_sse_1","model":"gpt-5.5",'
            b'"usage":{"input_tokens":50,"output_tokens":20}}}\n\n'
        )

        mitm_addon.responseheaders(flow)
        assert flow.response.status_code == 200
        compressed = brotli.compress(plaintext)
        midpoint = len(compressed) // 2
        assert response_stream(flow)(compressed[:midpoint]) == compressed[:midpoint]
        assert response_stream(flow)(compressed[midpoint:]) == compressed[midpoint:]
        assert (metadata_keys.STREAM_BUFFER in flow.metadata) is capture_body
        assert (metadata_keys.STREAM_BUFFER_STATE in flow.metadata) is capture_body

        webhook = run_response(flow, self._usage_webhook_api)

        assert {event["category"]: event["quantity"] for event in webhook.usage_events()} == {
            "tokens.input": 50,
            "tokens.output": 20,
        }
        assert model_sse_parse_warnings(flow) == []

    def test_full_pipeline_model_sse_reports_response_incomplete_usage(self, tmp_path, real_flow):
        flow = _openai_responses_sse_flow(tmp_path, real_flow)
        mitm_addon.responseheaders(flow)
        response_stream(flow)(
            b"event: response.incomplete\n"
            b'data: {"response":{"id":"resp_incomplete","model":"gpt-5.5",'
            b'"usage":{"input_tokens":8000,"output_tokens":1024,'
            b'"input_tokens_details":{"cached_tokens":2000}}}}\n\n'
        )

        webhook = run_response(flow, self._usage_webhook_api)

        events = webhook.usage_events()
        by_category = {event["category"]: event["quantity"] for event in events}
        assert by_category == {
            "tokens.input": 6000,
            "tokens.output": 1024,
            "tokens.cache_read": 2000,
        }
        assert {event["provider"] for event in events} == {"gpt-5.5"}

    @pytest.mark.parametrize("encoding", ["gzip", "deflate"])
    @pytest.mark.parametrize("hook_name", ["response", "error"])
    def test_full_pipeline_incomplete_compressed_openai_sse_recovers_terminal_usage(
        self, tmp_path, real_flow, encoding, hook_name
    ):
        flow = _openai_responses_sse_flow(tmp_path, real_flow)
        assert flow.response is not None
        flow.response.headers["content-encoding"] = encoding
        plaintext = (
            b"event: response.completed\n"
            b'data: {"response":{"id":"resp_sse_1","model":"gpt-5.5",'
            b'"usage":{"input_tokens":100,"output_tokens":40,'
            b'"input_tokens_details":{"cached_tokens":20,'
            b'"cache_write_tokens":30}}}}\n\n'
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(compress_zlib_sse(plaintext, encoding)[:-1])
        if hook_name == "error":
            flow.error = Error("connection reset by peer")
            webhook = run_error(flow, self._usage_webhook_api)
        else:
            webhook = run_response(flow, self._usage_webhook_api)

        expected = {
            "tokens.input": 50,
            "tokens.output": 40,
            "tokens.cache_read": 20,
            "tokens.cache_creation": 30,
        }
        assert {
            event["category"]: event["quantity"] for event in webhook.usage_events()
        } == expected
        [source_entry] = model_usage_source_entries(flow)
        assert source_entry["source_id"] == flow.id
        assert source_entry["provider_response_id"] == "resp_sse_1"
        assert source_entry["transport"] == "http"
        assert source_entry["buffer_mode"] == "aggregate"
        assert source_entry["usage"] == expected
        assert all(event["buffer_accepted"] is True for event in source_entry["usage_events"])
        assert {
            event["source_idempotency_key"] for event in source_entry["usage_events"]
        }.isdisjoint({event["idempotencyKey"] for event in webhook.usage_events()})
        assert_single_model_sse_parse_warning(
            flow,
            usage_protocol="openai_responses_sse",
            event="compressed_body",
            error=body_decoding.INCOMPLETE_COMPRESSED_BODY,
        )

    @pytest.mark.parametrize(
        ("event_prefix", "event_type"),
        [
            pytest.param(b"event: response.done\n", "response.done", id="done"),
            pytest.param(
                b"event: response.incomplete\n",
                "response.incomplete",
                id="incomplete",
            ),
            pytest.param(b"event: response.failed\n", "response.failed", id="failed"),
            pytest.param(b"", "response.completed", id="eventless"),
        ],
    )
    def test_full_pipeline_incomplete_compressed_openai_sse_recovers_terminal_vocabulary(
        self, tmp_path, real_flow, event_prefix, event_type
    ):
        flow = _openai_responses_sse_flow(tmp_path, real_flow)
        assert flow.response is not None
        flow.response.headers["content-encoding"] = "gzip"
        plaintext = (
            event_prefix
            + b'data: {"type":"'
            + event_type.encode()
            + b'","response":{"model":"gpt-5.5",'
            b'"usage":{"input_tokens":11,"output_tokens":5}}}\n\n'
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(gzip.compress(plaintext)[:-1])
        webhook = run_response(flow, self._usage_webhook_api)

        assert {event["category"]: event["quantity"] for event in webhook.usage_events()} == {
            "tokens.input": 11,
            "tokens.output": 5,
        }

    @pytest.mark.parametrize("truncate_trailer", [False, True], ids=["complete", "incomplete"])
    def test_full_pipeline_openai_recovery_excludes_unknown_event_usage(
        self, tmp_path, real_flow, truncate_trailer
    ):
        flow = _openai_responses_sse_flow(tmp_path, real_flow)
        assert flow.response is not None
        flow.response.headers["content-encoding"] = "gzip"
        plaintext = (
            b"event: response.future_usage\n"
            b'data: {"type":"response.future_usage","response":{"model":"gpt-5.5",'
            b'"usage":{"output_tokens":99}}}\n\n'
            b"event: response.completed\n"
            b'data: {"type":"response.completed","response":{"model":"gpt-5.5",'
            b'"usage":{"input_tokens":10}}}\n\n'
        )
        encoded = gzip.compress(plaintext)
        if truncate_trailer:
            encoded = encoded[:-1]

        mitm_addon.responseheaders(flow)
        response_stream(flow)(encoded)
        webhook = run_response(flow, self._usage_webhook_api)

        expected = {"tokens.input": 10}
        if not truncate_trailer:
            expected["tokens.output"] = 99
        assert {
            event["category"]: event["quantity"] for event in webhook.usage_events()
        } == expected

    @pytest.mark.parametrize(
        "type_fields",
        [
            pytest.param(b'"type":"response.failed",', id="sse-json-conflict"),
            pytest.param(
                b'"type":"response.completed","type":"response.failed",'
                b'"type":"response.completed",',
                id="middle-conflicts-with-matching-ends",
            ),
            pytest.param(
                b'"padding":"'
                + b"x" * (openai_responses._RESPONSES_EVENT_PREFILTER_MAX_BYTES + 1)
                + b'","type":"response.failed","type":"response.completed",',
                id="conflict-after-prefilter-bound",
            ),
            pytest.param(
                b'"padding":"'
                + b"x" * (openai_responses._RESPONSES_EVENT_PREFILTER_MAX_BYTES + 1)
                + b'","type":42,',
                id="invalid-type-after-prefilter-bound",
            ),
        ],
    )
    def test_full_pipeline_incomplete_compressed_openai_sse_rejects_conflicting_identity(
        self, tmp_path, real_flow, type_fields
    ):
        flow = _openai_responses_sse_flow(tmp_path, real_flow)
        assert flow.response is not None
        flow.response.headers["content-encoding"] = "gzip"
        plaintext = (
            b"event: response.completed\n"
            b"data: {" + type_fields + b'"response":{"model":"gpt-5.5",'
            b'"usage":{"input_tokens":11,"output_tokens":5}}}\n\n'
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(gzip.compress(plaintext)[:-1])
        webhook = run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0

    def test_full_pipeline_incomplete_compressed_openai_sse_does_not_flush_partial_event(
        self, tmp_path, real_flow
    ):
        flow = _openai_responses_sse_flow(tmp_path, real_flow)
        assert flow.response is not None
        flow.response.headers["content-encoding"] = "gzip"
        plaintext = (
            b"event: response.completed\n"
            b'data: {"type":"response.completed","response":{"model":"gpt-5.5",'
            b'"usage":{"input_tokens":11,"output_tokens":5}'
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(gzip.compress(plaintext)[:-1])
        webhook = run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0

    @pytest.mark.parametrize("encoding", ["gzip", "deflate"])
    def test_full_pipeline_invalid_compressed_openai_sse_remains_fail_closed(
        self, tmp_path, real_flow, encoding
    ):
        flow = _openai_responses_sse_flow(tmp_path, real_flow)
        assert flow.response is not None
        flow.response.headers["content-encoding"] = encoding
        plaintext = (
            b"event: response.completed\n"
            b'data: {"type":"response.completed","response":{"model":"gpt-5.5",'
            b'"usage":{"input_tokens":11,"output_tokens":5}}}\n\n'
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(compress_zlib_sse(plaintext, encoding) + b"not-compressed")
        webhook = run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
        assert_single_model_sse_parse_warning(
            flow,
            usage_protocol="openai_responses_sse",
            event="compressed_body",
            error=body_decoding.INVALID_COMPRESSED_BODY,
        )

    def test_full_pipeline_decoded_limit_openai_sse_remains_fail_closed(self, tmp_path, real_flow):
        flow = _openai_responses_sse_flow(tmp_path, real_flow)
        assert flow.response is not None
        flow.response.headers["content-encoding"] = "gzip"
        plaintext = (
            b"event: response.completed\n"
            b'data: {"type":"response.completed","response":{"model":"gpt-5.5",'
            b'"usage":{"input_tokens":11,"output_tokens":5}}}\n\n'
            b"event: response.output_text.delta\n"
            b"data: " + b"x" * (5 * 1024 * 1024 + 1)
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(gzip.compress(plaintext))
        webhook = run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
        assert_single_model_sse_parse_warning(
            flow,
            usage_protocol="openai_responses_sse",
            event="compressed_body",
            error=body_decoding.DECODED_BODY_LIMIT_EXCEEDED,
        )

    def test_full_pipeline_response_then_error_emits_recovered_openai_usage_once(
        self, tmp_path, real_flow
    ):
        flow = _openai_responses_sse_flow(tmp_path, real_flow)
        assert flow.response is not None
        flow.response.headers["content-encoding"] = "gzip"
        plaintext = (
            b"event: response.completed\n"
            b'data: {"response":{"model":"gpt-5.5",'
            b'"usage":{"input_tokens":11,"output_tokens":5}}}\n\n'
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(gzip.compress(plaintext)[:-1])
        with self._usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            flow.error = Error("connection reset after response")
            mitm_addon.error(flow)
            flush_usage_events(trigger="test")

        assert [(event["category"], event["quantity"]) for event in webhook.usage_events()] == [
            ("tokens.input", 11),
            ("tokens.output", 5),
        ]

    def test_full_pipeline_openai_sse_logs_truncated_terminal_event(self, tmp_path, real_flow):
        flow = _openai_responses_sse_flow(tmp_path, real_flow)
        mitm_addon.responseheaders(flow)
        response_stream(flow)(
            b"event: response.completed\n"
            b'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt'
        )

        webhook = run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
        assert_single_model_sse_parse_warning(
            flow,
            usage_protocol="openai_responses_sse",
            event="response.completed",
        )

    def test_full_pipeline_openai_sse_logs_truncated_late_event_name(self, tmp_path, real_flow):
        flow = _openai_responses_sse_flow(tmp_path, real_flow)
        mitm_addon.responseheaders(flow)
        response_stream(flow)(
            b'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt\n'
            b"event: response.completed\n\n"
        )

        webhook = run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
        assert_single_model_sse_parse_warning(
            flow,
            usage_protocol="openai_responses_sse",
            event="response.completed",
        )

    @pytest.mark.parametrize("hook_name", ["response", "error"])
    def test_full_pipeline_openai_eventless_incomplete_terminal_sse_warns(
        self, tmp_path, real_flow, hook_name
    ):
        flow = _openai_responses_sse_flow(tmp_path, real_flow)
        mitm_addon.responseheaders(flow)
        response_stream(flow)(
            b'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt'
        )

        if hook_name == "error":
            flow.error = Error("connection reset by peer")
            webhook = run_error(flow, self._usage_webhook_api)
        else:
            webhook = run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
        assert_single_model_sse_parse_warning(
            flow,
            usage_protocol="openai_responses_sse",
            event="response.completed",
        )

    def test_full_pipeline_openai_non_terminal_incomplete_sse_does_not_warn(
        self, tmp_path, real_flow
    ):
        flow = _openai_responses_sse_flow(tmp_path, real_flow)
        mitm_addon.responseheaders(flow)
        response_stream(flow)(
            b"event: response.in_progress\n"
            b'data: {"type":"response.in_progress","response":{"id":"resp_1","model":"gpt'
        )

        webhook = run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
        assert model_sse_parse_warnings(flow) == []

    def test_full_pipeline_model_sse_zero_event_preserves_billed_usage_and_id(
        self, tmp_path, real_flow
    ):
        flow = _openai_responses_sse_flow(tmp_path, real_flow)
        mitm_addon.responseheaders(flow)
        response_stream(flow)(
            b"event: response.completed\n"
            b'data: {"response":{"id":"resp_sse_1","model":"gpt-5.5",'
            b'"usage":{"input_tokens":100,"output_tokens":40}}}\n\n'
            b"event: response.failed\n"
            b'data: {"response":{"id":"resp_sse_empty","model":"gpt-5.6-luna",'
            b'"usage":{"input_tokens":0,"output_tokens":0}}}\n\n'
        )

        webhook = run_response(flow, self._usage_webhook_api)

        events = webhook.usage_events()
        by_category = {event["category"]: event["quantity"] for event in events}
        idempotency_by_category = {event["category"]: event["idempotencyKey"] for event in events}
        assert by_category == {
            "tokens.input": 100,
            "tokens.output": 40,
        }
        assert set(idempotency_by_category) == {"tokens.input", "tokens.output"}
        for key in idempotency_by_category.values():
            uuid.UUID(key)
        assert {event["provider"] for event in events} == {"gpt-5.5"}

    @pytest.mark.parametrize(
        "later_cache_write_tokens",
        [0, None],
        ids=["zero", "omitted"],
    )
    def test_full_pipeline_model_sse_raw_snapshots_preserve_input_partition(
        self,
        tmp_path,
        real_flow,
        later_cache_write_tokens,
    ):
        flow = _openai_responses_sse_flow(tmp_path, real_flow)
        mitm_addon.responseheaders(flow)
        later_input_details = {"cached_tokens": 20}
        if later_cache_write_tokens is not None:
            later_input_details["cache_write_tokens"] = later_cache_write_tokens
        first_snapshot = {
            "type": "response.completed",
            "response": {
                "id": "resp_sse_partition",
                "model": "gpt-5.5",
                "usage": {
                    "input_tokens": 100,
                    "output_tokens": 0,
                    "input_tokens_details": {
                        "cached_tokens": 20,
                        "cache_write_tokens": 30,
                    },
                },
            },
        }
        later_snapshot = {
            "type": "response.done",
            "response": {
                "id": "resp_sse_partition",
                "model": "gpt-5.5",
                "usage": {
                    "input_tokens": 100,
                    "output_tokens": 40,
                    "input_tokens_details": later_input_details,
                },
            },
        }
        response_stream(flow)(
            b"event: response.completed\n"
            + b"data: "
            + json.dumps(first_snapshot).encode()
            + b"\n\n"
            + b"event: response.done\n"
            + b"data: "
            + json.dumps(later_snapshot).encode()
            + b"\n\n"
        )

        webhook = run_response(flow, self._usage_webhook_api)

        events = webhook.usage_events()
        by_category = {event["category"]: event["quantity"] for event in events}
        assert len(events) == len(by_category) == 4
        assert by_category == {
            "tokens.input": 50,
            "tokens.output": 40,
            "tokens.cache_read": 20,
            "tokens.cache_creation": 30,
        }
        assert (
            by_category["tokens.input"]
            + by_category["tokens.cache_read"]
            + by_category["tokens.cache_creation"]
            == 100
        )
