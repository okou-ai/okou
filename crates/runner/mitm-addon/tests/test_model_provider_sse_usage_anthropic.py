"""Anthropic Messages SSE usage diagnostics integration tests."""

from pathlib import Path

import pytest
from mitmproxy import http
from mitmproxy.flow import Error

import body_decoding
import flow_metadata_keys as metadata_keys
import mitm_addon
from tests.flow_helpers import response_stream
from tests.model_provider_flow_helpers import RealFlowFactory
from tests.model_provider_sse_usage_helpers import (
    assert_single_model_sse_parse_warning,
    compress_zlib_sse,
    model_provider_sse_flow,
    model_sse_parse_warnings,
    run_error,
    run_response,
)


def _claude_code_sse_flow(
    tmp_path: Path,
    real_flow: RealFlowFactory,
) -> http.HTTPFlow:
    flow = model_provider_sse_flow(
        tmp_path,
        real_flow,
        host="api.anthropic.com",
        original_url="https://api.anthropic.com/v1/messages",
        firewall_name="model-provider:claude-code-oauth-token",
        cli_agent_type="claude-code",
        model_usage_provider=None,
    )
    flow.metadata[metadata_keys.FIREWALL_BILLABLE] = False
    return flow


class TestAnthropicMessagesSseUsage:
    """Tests for Anthropic Messages SSE usage diagnostics."""

    @pytest.fixture(autouse=True)
    def _sync_usage_delivery(self, sync_usage_executor, usage_webhook_api):
        self._usage_webhook_api = usage_webhook_api

    @pytest.mark.parametrize("encoding", ["gzip", "deflate"])
    def test_full_pipeline_invalid_compressed_anthropic_sse_logs_warning(
        self, tmp_path, real_flow, encoding
    ):
        flow = _claude_code_sse_flow(tmp_path, real_flow)
        assert flow.response is not None
        flow.response.headers["content-encoding"] = encoding
        plaintext = (
            b"event: message_start\n"
            b'data: {"type":"message_start","message":{"model":"claude-sonnet-4-6",'
            b'"usage":{"input_tokens":50}}}\n\n'
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(compress_zlib_sse(plaintext, encoding) + b"not-compressed")
        run_response(flow, self._usage_webhook_api)

        assert_single_model_sse_parse_warning(
            flow,
            usage_protocol="anthropic_messages_sse",
            event="compressed_body",
            error=body_decoding.INVALID_COMPRESSED_BODY,
        )

    def test_full_pipeline_decoded_limit_anthropic_sse_logs_warning(self, tmp_path, real_flow):
        flow = _claude_code_sse_flow(tmp_path, real_flow)
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
        response_stream(flow)(compress_zlib_sse(plaintext, "gzip"))
        run_response(flow, self._usage_webhook_api)

        assert_single_model_sse_parse_warning(
            flow,
            usage_protocol="anthropic_messages_sse",
            event="compressed_body",
            error=body_decoding.DECODED_BODY_LIMIT_EXCEEDED,
        )

    def test_full_pipeline_anthropic_sse_logs_truncated_message_start(self, tmp_path, real_flow):
        flow = _claude_code_sse_flow(tmp_path, real_flow)
        mitm_addon.responseheaders(flow)
        response_stream(flow)(
            b'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","mod'
        )

        run_response(flow, self._usage_webhook_api)

        assert_single_model_sse_parse_warning(
            flow,
            usage_protocol="anthropic_messages_sse",
            event="message_start",
        )

    def test_full_pipeline_anthropic_sse_error_logs_truncated_message_start(
        self, tmp_path, real_flow
    ):
        flow = _claude_code_sse_flow(tmp_path, real_flow)
        mitm_addon.responseheaders(flow)
        response_stream(flow)(
            b'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","mod'
        )
        flow.error = Error("connection reset by peer")

        run_error(flow, self._usage_webhook_api)

        assert_single_model_sse_parse_warning(
            flow,
            usage_protocol="anthropic_messages_sse",
            event="message_start",
        )

    def test_full_pipeline_anthropic_sse_logs_malformed_message_start(self, tmp_path, real_flow):
        flow = _claude_code_sse_flow(tmp_path, real_flow)
        mitm_addon.responseheaders(flow)
        response_stream(flow)(b"event: message_start\ndata: {invalid json}\n\n")

        run_response(flow, self._usage_webhook_api)

        assert_single_model_sse_parse_warning(
            flow,
            usage_protocol="anthropic_messages_sse",
            event="message_start",
        )

    def test_full_pipeline_anthropic_sse_logs_truncated_message_delta_after_start(
        self, tmp_path, real_flow
    ):
        flow = _claude_code_sse_flow(tmp_path, real_flow)
        mitm_addon.responseheaders(flow)
        response_stream(flow)(
            b"event: message_start\n"
            b'data: {"type":"message_start","message":{"id":"msg_1",'
            b'"model":"claude-sonnet-4-6","usage":{"input_tokens":50}}}\n\n'
            b"event: message_delta\n"
            b'data: {"type":"message_delta","usage":{"output_tokens":'
        )

        run_response(flow, self._usage_webhook_api)

        assert_single_model_sse_parse_warning(
            flow,
            usage_protocol="anthropic_messages_sse",
            event="message_delta",
        )

    def test_full_pipeline_eventless_incomplete_anthropic_usage_sse_warns(
        self, tmp_path, real_flow
    ):
        flow = _claude_code_sse_flow(tmp_path, real_flow)
        mitm_addon.responseheaders(flow)
        response_stream(flow)(
            b'data: {"type":"message_start","message":{"id":"msg_1","model":"claude'
        )

        run_response(flow, self._usage_webhook_api)

        assert_single_model_sse_parse_warning(
            flow,
            usage_protocol="anthropic_messages_sse",
            event="message_start",
        )

    def test_full_pipeline_anthropic_non_usage_incomplete_sse_does_not_warn(
        self, tmp_path, real_flow
    ):
        flow = _claude_code_sse_flow(tmp_path, real_flow)
        mitm_addon.responseheaders(flow)
        response_stream(flow)(
            b"event: content_block_delta\n"
            b'data: {"type":"content_block_delta","delta":{"text":"hello'
        )

        run_response(flow, self._usage_webhook_api)

        assert model_sse_parse_warnings(flow) == []
