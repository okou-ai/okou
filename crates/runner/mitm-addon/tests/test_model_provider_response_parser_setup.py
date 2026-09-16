"""Model-provider response parser setup integration tests."""

import gzip
import json
from typing import cast

import pytest
from mitmproxy.test import tutils

import flow_metadata_keys as metadata_keys
import mitm_addon
import response_streaming
import usage
from tests.flow_helpers import header_map, response_stream
from tests.jsonl_log_helpers import jsonl_exists_after_flush
from tests.x_flow_helpers import make_x_response_flow


class TestModelJsonResponseInspectorProtocolDispatch:
    """Tests exhaustive dispatch for the shared model JSON inspector."""

    def test_unsupported_protocol_fails_explicitly(self):
        unsupported_protocol = cast(usage.ModelUsageProtocol, "unsupported")

        with pytest.raises(AssertionError, match="Expected code to be unreachable"):
            usage.create_model_json_response_inspector(
                unsupported_protocol,
                include_usage=True,
                include_failure=False,
            )


class TestModelJsonFailureMessageOverflow:
    """Pin the current optional-message contract for each active consumer set."""

    @pytest.mark.parametrize("chunk_size", [None, 1], ids=["whole-body", "byte-at-a-time"])
    @pytest.mark.parametrize(
        ("include_usage", "message_size", "expected_valid", "expected_codes"),
        [
            pytest.param(False, 512, True, ("billing_error",), id="failure-only-at-limit"),
            pytest.param(False, 513, False, (), id="failure-only-over-limit"),
            pytest.param(True, 512, True, ("billing_error",), id="combined-at-limit"),
            pytest.param(True, 513, True, ("billing_error",), id="combined-over-limit"),
        ],
    )
    def test_known_code_with_bounded_optional_message(
        self,
        include_usage: bool,
        message_size: int,
        expected_valid: bool,
        expected_codes: tuple[str, ...],
        chunk_size: int | None,
    ) -> None:
        body = json.dumps(
            {"type": "error", "error": {"type": "billing_error", "message": "x" * message_size}}
        ).encode()
        inspector = usage.create_model_json_response_inspector(
            "anthropic_messages",
            include_usage=include_usage,
            include_failure=True,
        )
        step = len(body) if chunk_size is None else chunk_size
        for start in range(0, len(body), step):
            if not inspector.accepts_more_input():
                break
            inspector.feed(body[start : start + step])

        inspection = inspector.finish()

        assert inspection.failure.is_valid is expected_valid
        assert inspection.failure.failure_codes == expected_codes
        assert inspection.usage is None
        assert inspection.usage_error is None


class TestResponseHeadersModelJsonParser:
    """Tests for model-provider JSON parser setup in responseheaders()."""

    @pytest.mark.parametrize(
        "content_type",
        [
            'application/json; profile="text/event-stream"',
            "text/event-stream+json",
        ],
    )
    def test_non_sse_media_type_uses_json_parser(self, real_flow, content_type):
        flow = real_flow(with_response=False, host="api.openai.com")
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": content_type}),
        )
        flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:openai-api-key"
        flow.metadata[metadata_keys.CLI_AGENT_TYPE] = "codex"
        flow.metadata[metadata_keys.FIREWALL_BILLABLE] = True
        flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "gpt-5.5"

        mitm_addon.responseheaders(flow)

        assert response_streaming.uses_model_json_fallback(
            flow,
            websocket_header_work_limit=8 * 1024,
        )
        assert "model_json_usage_finish" in flow.metadata
        assert "model_sse_usage_finish" not in flow.metadata
        body = b'{"model":"gpt-5.5","usage":{"input_tokens":12,"output_tokens":7}}'
        assert response_stream(flow)(body) == body

        response_streaming.finalize_model_json_usage(flow, "")

        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == {
            "model": "gpt-5.5",
            "tokens.input": 12,
            "tokens.output": 7,
        }

    def test_brotli_model_json_uses_incremental_parser(self, real_flow, mitm_ctx):
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json", "content-encoding": "br"}),
        )
        flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:anthropic-api-key"
        flow.metadata[metadata_keys.FIREWALL_BILLABLE] = True
        flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "claude-sonnet-4-6"

        with mitm_ctx():
            mitm_addon.responseheaders(flow)

        assert callable(response_stream(flow))
        assert "model_json_usage_finish" in flow.metadata
        assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata


class TestBodyBearingConnectModelResponseParserAdmission:
    """Tests body-bearing CONNECT responses at the shared model parser gate."""

    @pytest.mark.parametrize(
        ("response_status", "content_encoding"),
        [
            pytest.param(300, "", id="redirect-boundary"),
            pytest.param(500, "gzip", id="provider-failure"),
        ],
    )
    def test_non_success_response_uses_json_parser(
        self,
        real_flow,
        tmp_path,
        mitm_ctx,
        response_status: int,
        content_encoding: str,
    ) -> None:
        flow = real_flow(
            with_response=False,
            host="api.openai.com",
            path="/v1/chat/completions",
            method="CONNECT",
        )
        response_headers = {"content-type": "application/json"}
        if content_encoding:
            response_headers["content-encoding"] = content_encoding
        flow.response = tutils.tresp(
            status_code=response_status,
            headers=header_map(response_headers),
        )
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow.metadata.update(
            {
                metadata_keys.SANDBOX_PROXY_LOG_PATH: str(proxy_log_path),
                metadata_keys.FIREWALL_NAME: "model-provider:openai-api-key",
                metadata_keys.FIREWALL_BILLABLE: True,
                metadata_keys.MODEL_USAGE_PROVIDER: "gpt-5.5",
            }
        )
        body = b'{"model":"gpt-5.5","usage":{"prompt_tokens":12,"completion_tokens":7}}'
        wire_body = gzip.compress(body) if content_encoding else body

        with mitm_ctx():
            mitm_addon.responseheaders(flow)

            assert "model_json_usage_finish" in flow.metadata
            assert "model_sse_usage_finish" not in flow.metadata
            assert "model_websocket_usage_enabled" not in flow.metadata
            assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata
            assert response_stream(flow)(wire_body) == wire_body

            response_streaming.finalize_model_json_usage(flow, str(proxy_log_path))

        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == {
            "model": "gpt-5.5",
            "tokens.input": 12,
            "tokens.output": 7,
        }
        assert not jsonl_exists_after_flush(proxy_log_path)


class TestBodylessModelResponseParserAdmission:
    """Tests HTTP body semantics at the shared model response parser gate."""

    @pytest.mark.parametrize(
        ("request_method", "response_status", "content_type", "content_encoding"),
        [
            pytest.param("GET", 103, "application/json", "", id="informational"),
            pytest.param("GET", 204, "application/json", "", id="no-content"),
            pytest.param("GET", 205, "application/json", "", id="reset-content"),
            pytest.param("GET", 304, "application/json", "", id="not-modified"),
            pytest.param("HEAD", 200, "application/json", "", id="head"),
            pytest.param("CONNECT", 200, "application/json", "", id="successful-connect"),
            pytest.param("GET", 204, "application/json", "gzip", id="gzip"),
            pytest.param("GET", 204, "application/json", "deflate", id="deflate"),
            pytest.param("GET", 204, "text/event-stream", "", id="sse"),
        ],
    )
    def test_bodyless_response_skips_usage_parser_and_keeps_byte_accounting(
        self,
        real_flow,
        tmp_path,
        mitm_ctx,
        request_method: str,
        response_status: int,
        content_type: str,
        content_encoding: str,
    ) -> None:
        flow = real_flow(
            with_response=False,
            host="api.anthropic.com",
            path="/v1/messages",
            method=request_method,
        )
        response_headers = {"content-type": content_type}
        if content_encoding:
            response_headers["content-encoding"] = content_encoding
        flow.response = tutils.tresp(
            status_code=response_status,
            headers=header_map(response_headers),
        )
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow.metadata.update(
            {
                metadata_keys.SANDBOX_PROXY_LOG_PATH: str(proxy_log_path),
                metadata_keys.FIREWALL_NAME: "model-provider:anthropic-api-key",
                metadata_keys.FIREWALL_BILLABLE: True,
                metadata_keys.MODEL_USAGE_PROVIDER: "claude-sonnet-4-6",
            }
        )

        with mitm_ctx():
            mitm_addon.responseheaders(flow)

            assert "model_json_usage_finish" not in flow.metadata
            assert "model_sse_usage_finish" not in flow.metadata
            assert "model_websocket_usage_enabled" not in flow.metadata
            assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata

            unexpected_wire_bytes = b"bodyless-response-wire-bytes"
            assert response_stream(flow)(unexpected_wire_bytes) == unexpected_wire_bytes
            assert flow.metadata[metadata_keys.RESPONSE_STREAM_STATE]["total_bytes"] == len(
                unexpected_wire_bytes
            )

            response_streaming.finalize_model_sse_usage(flow)
            response_streaming.finalize_model_json_usage(flow, str(proxy_log_path))

        assert not jsonl_exists_after_flush(proxy_log_path)


class TestResponseHeadersSseParser:
    """Tests for SSE parser setup in responseheaders()."""

    def test_sets_up_sse_parser_for_model_provider(self, real_flow, headers):
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "text/event-stream"})
        )
        flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:anthropic-api-key"
        flow.metadata[metadata_keys.FIREWALL_BILLABLE] = True
        flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "claude-sonnet-4-6"

        mitm_addon.responseheaders(flow)

        assert metadata_keys.MODEL_PROVIDER_USAGE in flow.metadata
        assert isinstance(flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE], dict)
        assert "model_sse_usage_finish" in flow.metadata
        assert "model_json_usage_finish" not in flow.metadata
        # Feed SSE data through the callback
        callback = response_stream(flow)
        callback(
            b"event: message_start\n"
            b'data: {"type":"message_start","message":'
            b'{"model":"claude-sonnet-4-6",'
            b'"usage":{"input_tokens":42}}}\n\n'
        )
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]["model"] == "claude-sonnet-4-6"
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]["tokens.input"] == 42

    def test_sets_up_sse_parser_with_case_insensitive_content_type(self, real_flow):
        flow = real_flow(with_response=False, host="api.openai.com")
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "Text/Event-Stream; Charset=UTF-8"}),
        )
        flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:openai-api-key"
        flow.metadata[metadata_keys.CLI_AGENT_TYPE] = "codex"
        flow.metadata[metadata_keys.FIREWALL_BILLABLE] = True
        flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "gpt-5.5"

        mitm_addon.responseheaders(flow)

        assert metadata_keys.MODEL_PROVIDER_USAGE in flow.metadata
        callback = response_stream(flow)
        callback(
            b"event: response.completed\n"
            b'data: {"response":{"model":"gpt-5.5",'
            b'"usage":{"output_tokens":5}}}\n\n'
        )
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]["model"] == "gpt-5.5"
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]["tokens.output"] == 5

    def test_finalizes_sse_parser_for_trailing_event_without_blank_line(self, real_flow):
        flow = real_flow(with_response=False, host="api.openai.com")
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "text/event-stream"}),
        )
        flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:openai-api-key"
        flow.metadata[metadata_keys.CLI_AGENT_TYPE] = "codex"
        flow.metadata[metadata_keys.FIREWALL_BILLABLE] = True
        flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "gpt-5.5"

        mitm_addon.responseheaders(flow)

        callback = response_stream(flow)
        callback(
            b"event: response.completed\n"
            b'data: {"response":{"model":"gpt-5.5",'
            b'"usage":{"output_tokens":7}}}\n'
        )
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == {}

        response_streaming.finalize_model_sse_usage(flow)

        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]["model"] == "gpt-5.5"
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]["tokens.output"] == 7

    def test_sets_up_openai_sse_parser_for_openai_model_provider(self, real_flow, headers):
        flow = real_flow(with_response=False, host="api.openai.com")
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "text/event-stream"}),
        )
        flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:openai-api-key"
        flow.metadata[metadata_keys.CLI_AGENT_TYPE] = "codex"
        flow.metadata[metadata_keys.FIREWALL_BILLABLE] = True
        flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "gpt-5.5"

        mitm_addon.responseheaders(flow)

        assert metadata_keys.MODEL_PROVIDER_USAGE in flow.metadata
        callback = response_stream(flow)
        callback(
            b"event: response.completed\n"
            b'data: {"response":{"model":"gpt-5.5",'
            b'"usage":{"input_tokens":42,'
            b'"input_tokens_details":{"cached_tokens":12}}}}\n\n'
        )
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]["model"] == "gpt-5.5"
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]["tokens.input"] == 30
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]["tokens.cache_read"] == 12

    def test_codex_oauth_model_provider_uses_openai_sse_parser(self, real_flow):
        flow = real_flow(with_response=False, host="chatgpt.com")
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "text/event-stream"}),
        )
        flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:codex-oauth-token"
        flow.metadata[metadata_keys.CLI_AGENT_TYPE] = "codex"
        flow.metadata[metadata_keys.FIREWALL_BILLABLE] = True
        flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "gpt-5.5"

        mitm_addon.responseheaders(flow)

        assert metadata_keys.MODEL_PROVIDER_USAGE in flow.metadata
        callback = response_stream(flow)
        callback(
            b"event: response.completed\n"
            b'data: {"response":{"model":"gpt-5.5",'
            b'"usage":{"input_tokens":42,'
            b'"input_tokens_details":{"cached_tokens":12}}}}\n\n'
        )
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]["model"] == "gpt-5.5"
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]["tokens.input"] == 30
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]["tokens.cache_read"] == 12

    @pytest.mark.parametrize("cli_agent_type", [None, ""])
    def test_default_cli_agent_type_uses_anthropic_sse_parser(self, real_flow, cli_agent_type):
        flow = real_flow(with_response=False, host="chatgpt.com")
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "text/event-stream"}),
        )
        flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:codex-oauth-token"
        if cli_agent_type is not None:
            flow.metadata[metadata_keys.CLI_AGENT_TYPE] = cli_agent_type
        flow.metadata[metadata_keys.FIREWALL_BILLABLE] = True
        flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "claude-sonnet-4-6"

        mitm_addon.responseheaders(flow)

        callback = response_stream(flow)
        callback(
            b"event: message_start\n"
            b'data: {"type":"message_start","message":'
            b'{"model":"claude-sonnet-4-6",'
            b'"usage":{"input_tokens":42}}}\n\n'
        )
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]["model"] == "claude-sonnet-4-6"
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]["tokens.input"] == 42

    def test_decompresses_gzip_sse_before_parsing(self, real_flow, headers):
        """Compressed SSE streams must be decompressed before usage extraction."""
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map(
                {
                    "content-type": "text/event-stream; charset=utf-8",
                    "content-encoding": "gzip",
                }
            ),
        )
        flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:anthropic-api-key"
        flow.metadata[metadata_keys.FIREWALL_BILLABLE] = True
        flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "claude-sonnet-4-6"

        mitm_addon.responseheaders(flow)

        assert metadata_keys.MODEL_PROVIDER_USAGE in flow.metadata
        callback = response_stream(flow)
        plaintext = (
            b"event: message_start\n"
            b'data: {"type":"message_start","message":'
            b'{"model":"claude-sonnet-4-6",'
            b'"usage":{"input_tokens":99}}}\n\n'
        )
        compressed = gzip.compress(plaintext)
        # Callback returns original compressed bytes to client
        result = callback(compressed)
        assert result == compressed
        # But parser receives decompressed data
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]["model"] == "claude-sonnet-4-6"
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]["tokens.input"] == 99

    def test_no_sse_parser_for_non_model_provider(self, real_flow, headers):
        flow = real_flow(with_response=False, host="api.github.com")
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "text/event-stream"})
        )
        flow.metadata[metadata_keys.FIREWALL_NAME] = "github"
        flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "claude-sonnet-4-6"

        mitm_addon.responseheaders(flow)

        assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata
        assert "model_json_usage_finish" not in flow.metadata
        assert "model_sse_usage_finish" not in flow.metadata

    def test_billable_json_response_uses_json_parser(self, real_flow, headers):
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "application/json"})
        )
        flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:anthropic-api-key"
        flow.metadata[metadata_keys.FIREWALL_BILLABLE] = True
        flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "claude-sonnet-4-6"

        mitm_addon.responseheaders(flow)

        assert "model_json_usage_finish" in flow.metadata
        assert "model_sse_usage_finish" not in flow.metadata

    def test_billable_sse_parser_does_not_require_model_usage_provider(self, real_flow, headers):
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "text/event-stream"})
        )
        flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:anthropic-api-key"
        flow.metadata[metadata_keys.FIREWALL_BILLABLE] = True

        mitm_addon.responseheaders(flow)

        assert metadata_keys.MODEL_PROVIDER_USAGE in flow.metadata
        assert isinstance(flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE], dict)
        assert "model_sse_usage_finish" in flow.metadata

    def test_non_billable_model_provider_skips_sse_usage_parser(self, real_flow, headers):
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "text/event-stream"})
        )
        flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:anthropic-api-key"
        flow.metadata[metadata_keys.FIREWALL_BILLABLE] = False
        flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "claude-sonnet-4-6"

        mitm_addon.responseheaders(flow)

        assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata
        assert "model_sse_usage_finish" not in flow.metadata

    def test_no_sse_parser_without_firewall_name(self, real_flow, headers):
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "text/event-stream"})
        )
        flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "claude-sonnet-4-6"
        # Model metadata alone must not classify the flow as a model provider.

        mitm_addon.responseheaders(flow)

        assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata
        assert "model_json_usage_finish" not in flow.metadata
        assert "model_sse_usage_finish" not in flow.metadata

    @pytest.mark.parametrize("firewall_name", [None, 42])
    def test_malformed_firewall_name_skips_usage_parsers(self, real_flow, firewall_name):
        flow = make_x_response_flow(
            real_flow,
            path="/2/tweets/search/stream",
            firewall_name=firewall_name,
        )

        mitm_addon.responseheaders(flow)

        assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata
        assert "model_json_usage_finish" not in flow.metadata
        assert "model_sse_usage_finish" not in flow.metadata
        assert "connector_response_finish" not in flow.metadata
        assert metadata_keys.X_NDJSON_STATE not in flow.metadata
