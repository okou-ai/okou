"""Tests for model-provider JSON response streaming usage reporting."""

import gzip
import hashlib
import json
import zlib
from pathlib import Path

import brotli
import pytest
import zstandard
from mitmproxy.test import tutils

import flow_metadata_keys as metadata_keys
import logging_utils
import mitm_addon
from body_limits import (
    STREAM_BUFFER_LIMIT,
    STREAM_DECODE_CHUNK_LIMIT,
    STREAM_DECODE_EXPANSION_GRACE,
    STREAM_DECODE_MAX_EXPANSION_RATIO,
)
from tests.flow_helpers import header_map, response_stream
from tests.jsonl_log_helpers import (
    read_jsonl_entries_after_flush,
    read_jsonl_text_after_flush,
)
from tests.model_provider_flow_helpers import model_usage_source_entries
from tests.model_provider_response_helpers import (
    ANTHROPIC_JSON_CASE,
    MODEL_PROVIDER_JSON_CASES,
    OPENAI_RESPONSES_CASE,
    expected_event_quantities,
    expected_model_usage,
    model_provider_flow,
    model_provider_json_case_id,
    run_response,
    standard_success_payload,
)
from usage.quantities import MAX_USAGE_QUANTITY


def _deterministic_low_ratio_text(size: int) -> str:
    chunks: list[str] = []
    seed = b"vm0-zstd-json-streaming-test"
    remaining = size
    while remaining > 0:
        seed = hashlib.sha256(seed).hexdigest().encode()
        fragment = seed.decode()[:remaining]
        chunks.append(fragment)
        remaining -= len(fragment)
    return "".join(chunks)


class TestModelProviderJsonStreaming:
    """Tests for responseheaders-driven model-provider JSON usage extraction."""

    @pytest.fixture(autouse=True)
    def _sync_usage_delivery(self, sync_usage_executor, usage_webhook_api):
        self._usage_webhook_api = usage_webhook_api

    def test_non_billable_json_response_uses_bounded_incremental_parser(
        self,
        tmp_path,
        real_flow,
    ):
        flow = model_provider_flow(
            real_flow,
            tmp_path,
            ANTHROPIC_JSON_CASE,
            billable=False,
        )
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        mitm_addon.responseheaders(flow)

        response_stream(flow)(b"x" * (STREAM_BUFFER_LIMIT + 1000))

        assert "model_json_usage_finish" in flow.metadata
        assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata
        assert metadata_keys.STREAM_BUFFER not in flow.metadata
        assert metadata_keys.STREAM_BUFFER_STATE not in flow.metadata

    def test_json_source_diagnostic_records_aggregate_admission_without_secrets(
        self,
        tmp_path,
        real_flow,
    ):
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow = model_provider_flow(
            real_flow,
            tmp_path,
            OPENAI_RESPONSES_CASE,
            proxy_log_path=proxy_log_path,
        )
        secret_userinfo = "diagnostic-user:diagnostic-password"
        secret_query = "diagnostic-query-secret"
        secret_fragment = "diagnostic-fragment-secret"
        secret_authorization = "Bearer diagnostic-authorization-secret"
        secret_prompt = b"diagnostic-prompt-secret"
        raw_url = (
            f"https://{secret_userinfo}@api.openai.com/"
            + "p" * (logging_utils.URL_LOG_MAX_CHARACTERS + 1)
            + f"?token={secret_query}#{secret_fragment}"
        )
        flow.metadata[metadata_keys.ORIGINAL_URL] = raw_url
        flow.request.headers["authorization"] = secret_authorization
        flow.request.content = secret_prompt
        body = standard_success_payload(OPENAI_RESPONSES_CASE)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(body)
        webhook = run_response(flow, self._usage_webhook_api)

        [source_entry] = model_usage_source_entries(flow)
        assert source_entry["level"] == "info"
        assert source_entry["message"] == "Model provider usage source reported"
        assert source_entry["run_id"] == "run-abc-123"
        assert source_entry["flow_id"] == flow.id
        assert source_entry["source_id"] == flow.id
        assert source_entry["method"] == flow.request.method
        assert source_entry["url"] == "[truncated]"
        assert source_entry["url_truncated"] is True
        assert source_entry["url_original_char_count"] == len(raw_url)
        assert source_entry["transport"] == "http"
        assert source_entry["buffer_mode"] == "aggregate"
        assert source_entry["firewall_name"] == "model-provider:openai-api-key"
        assert source_entry["reported_model"] == OPENAI_RESPONSES_CASE.model
        assert source_entry["provider_response_id"] == OPENAI_RESPONSES_CASE.message_id
        assert source_entry["usage"] == expected_event_quantities(OPENAI_RESPONSES_CASE)

        source_events = source_entry["usage_events"]
        assert {
            event["category"]: event["quantity"] for event in source_events
        } == expected_event_quantities(OPENAI_RESPONSES_CASE)
        assert all(event["buffer_accepted"] is True for event in source_events)
        source_event_keys = {event["source_idempotency_key"] for event in source_events}
        aggregate_event_keys = {event["idempotencyKey"] for event in webhook.usage_events()}
        assert source_event_keys.isdisjoint(aggregate_event_keys)

        serialized = read_jsonl_text_after_flush(proxy_log_path)
        for secret in (
            secret_userinfo,
            secret_query,
            secret_fragment,
            secret_authorization,
            secret_prompt.decode(),
        ):
            assert secret not in serialized
        assert len(serialized.encode()) < 5_000

    def test_capture_enabled_non_success_unsupported_encoding_passes_through(
        self,
        tmp_path,
        real_flow,
    ):
        flow = model_provider_flow(
            real_flow,
            tmp_path,
            ANTHROPIC_JSON_CASE,
        )
        flow.metadata[metadata_keys.CAPTURE_BODY] = True
        flow.response = tutils.tresp(
            status_code=429,
            headers=header_map(
                {
                    "content-type": "application/json",
                    "content-encoding": "private-encoding-value",
                }
            ),
        )
        body = b"unsupported-encoded-provider-error"

        mitm_addon.responseheaders(flow)
        assert flow.response.status_code == 429
        assert response_stream(flow)(body) == body
        assert flow.metadata[metadata_keys.STREAM_BUFFER] == body
        assert flow.metadata[metadata_keys.STREAM_BUFFER_STATE]["truncated"] is False

        webhook = run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0

    def test_full_pipeline_large_model_json_uses_incremental_parser_without_buffer(
        self, tmp_path, real_flow
    ):
        """responseheaders + response report model usage without a body-prefix copy."""
        flow = model_provider_flow(
            real_flow,
            tmp_path,
            ANTHROPIC_JSON_CASE,
            proxy_log_path=tmp_path / "proxy.jsonl",
        )
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        mitm_addon.responseheaders(flow)
        callback = response_stream(flow)
        callback(b'{"id":"msg_1","model":"claude-sonnet-4-6","content":[{"text":"')
        callback(b"x" * (STREAM_BUFFER_LIMIT + 4096))
        callback(b'"}],"usage":{"input_tokens":50,"output_tokens":200}}')
        assert metadata_keys.STREAM_BUFFER not in flow.metadata
        assert metadata_keys.STREAM_BUFFER_STATE not in flow.metadata

        webhook = run_response(flow, self._usage_webhook_api)

        extracted = flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]
        assert extracted["message_id"] == "msg_1"
        assert extracted["model"] == "claude-sonnet-4-6"
        assert extracted["tokens.input"] == 50
        assert extracted["tokens.output"] == 200
        events = webhook.usage_events()
        by_category = {event["category"]: event["quantity"] for event in events}
        assert by_category == {"tokens.input": 50, "tokens.output": 200}

    @pytest.mark.parametrize(
        "provider_case",
        MODEL_PROVIDER_JSON_CASES,
        ids=model_provider_json_case_id,
    )
    def test_full_pipeline_compressed_model_json_reports_usage(
        self, tmp_path, real_flow, provider_case
    ):
        """responseheaders parser should decompress non-SSE model JSON before extraction."""
        flow = model_provider_flow(
            real_flow,
            tmp_path,
            provider_case,
            proxy_log_path=tmp_path / "proxy.jsonl",
        )
        cache_write_tokens = 15 if provider_case.uses_openai_responses else None
        payload = standard_success_payload(
            provider_case,
            cache_write_tokens=cache_write_tokens,
        )
        compressed = gzip.compress(payload)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json", "content-encoding": "gzip"}),
        )

        mitm_addon.responseheaders(flow)
        midpoint = len(compressed) // 2
        response_stream(flow)(compressed[:midpoint])
        response_stream(flow)(compressed[midpoint:])

        webhook = run_response(flow, self._usage_webhook_api)

        extracted = flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]
        expected_usage = expected_model_usage(
            provider_case,
            cache_write_tokens=cache_write_tokens,
        )
        assert extracted["message_id"] == expected_usage["message_id"]
        assert extracted["model"] == expected_usage["model"]
        assert extracted["tokens.input"] == expected_usage["tokens.input"]
        assert extracted["tokens.output"] == expected_usage["tokens.output"]
        if provider_case.uses_openai_responses:
            assert extracted["tokens.cache_read"] == expected_usage["tokens.cache_read"]
            assert extracted["tokens.cache_creation"] == expected_usage["tokens.cache_creation"]
        events = webhook.usage_events()
        by_category = {event["category"]: event["quantity"] for event in events}
        assert len(events) == len(by_category)
        assert by_category == expected_event_quantities(
            provider_case,
            cache_write_tokens=cache_write_tokens,
        )

    @pytest.mark.parametrize(
        "provider_case",
        MODEL_PROVIDER_JSON_CASES,
        ids=model_provider_json_case_id,
    )
    def test_full_pipeline_out_of_range_model_json_quantity_is_rejected(
        self,
        tmp_path,
        real_flow,
        provider_case,
    ):
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow = model_provider_flow(
            real_flow,
            tmp_path,
            provider_case,
            proxy_log_path=proxy_log_path,
        )
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(
            standard_success_payload(
                provider_case,
                input_tokens=MAX_USAGE_QUANTITY + 1,
            )
        )

        webhook = run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
        assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata
        entries = read_jsonl_entries_after_flush(proxy_log_path)
        [warning] = [
            entry
            for entry in entries
            if entry.get("message") == "Model provider JSON usage extraction failed"
        ]
        assert warning["level"] == "warn"
        assert warning["type"] == "usage_event"
        assert warning["error"] == "integer value limit exceeded"

    @pytest.mark.parametrize(
        "provider_case",
        MODEL_PROVIDER_JSON_CASES,
        ids=model_provider_json_case_id,
    )
    def test_full_pipeline_exact_integer_boundary_is_reported(
        self,
        tmp_path,
        real_flow,
        provider_case,
    ):
        flow = model_provider_flow(
            real_flow,
            tmp_path,
            provider_case,
            proxy_log_path=tmp_path / "proxy.jsonl",
        )
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(
            standard_success_payload(
                provider_case,
                input_tokens=MAX_USAGE_QUANTITY,
            )
        )

        webhook = run_response(flow, self._usage_webhook_api)

        input_categories = (
            "tokens.input",
            "tokens.cache_read",
            "tokens.cache_creation",
        )
        assert (
            sum(
                event["quantity"]
                for event in webhook.usage_events()
                if event["category"].startswith(input_categories)
            )
            == MAX_USAGE_QUANTITY
        )

    @pytest.mark.parametrize(
        "provider_case",
        MODEL_PROVIDER_JSON_CASES,
        ids=model_provider_json_case_id,
    )
    @pytest.mark.parametrize("encoding_case", ["gzip", "deflate"])
    def test_full_pipeline_compressed_model_json_work_limit(
        self, tmp_path, real_flow, provider_case, encoding_case
    ):
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow = model_provider_flow(
            real_flow,
            tmp_path,
            provider_case,
            proxy_log_path=proxy_log_path,
        )
        payload = json.dumps(
            {
                "id": provider_case.message_id,
                "model": provider_case.model,
                "usage": {"input_tokens": 50, "output_tokens": 200},
                "padding": [0] * 40_000,
            },
            separators=(",", ":"),
        ).encode()
        compressed = gzip.compress(payload) if encoding_case == "gzip" else zlib.compress(payload)
        allowed_decoded_bytes = max(
            STREAM_DECODE_EXPANSION_GRACE,
            len(compressed) * STREAM_DECODE_MAX_EXPANSION_RATIO,
        )
        assert STREAM_DECODE_CHUNK_LIMIT < len(payload) <= allowed_decoded_bytes
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map(
                {"content-type": "application/json", "content-encoding": encoding_case}
            ),
        )

        mitm_addon.responseheaders(flow)
        callback = response_stream(flow)
        assert callback(compressed) == compressed
        corrupt_followup = bytearray(
            gzip.compress(b"") if encoding_case == "gzip" else zlib.compress(b"")
        )
        checksum_offset = -8 if encoding_case == "gzip" else -1
        corrupt_followup[checksum_offset] ^= 0xFF
        assert callback(bytes(corrupt_followup)) == bytes(corrupt_followup)

        webhook = run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
        assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata
        entries = read_jsonl_entries_after_flush(proxy_log_path)
        usage_warnings = [
            entry
            for entry in entries
            if entry.get("message") == "Model provider JSON usage extraction failed"
        ]
        assert len(usage_warnings) == 1
        assert usage_warnings[0]["level"] == "warn"
        assert usage_warnings[0]["type"] == "usage_event"
        assert usage_warnings[0]["error"] == "work limit exceeded"

    @pytest.mark.parametrize("encoding_case", ["gzip", "deflate"])
    def test_full_pipeline_zlib_expansion_limit_preserves_wire_body_and_rejects_usage(
        self, tmp_path, real_flow, encoding_case
    ):
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow = model_provider_flow(
            real_flow,
            tmp_path,
            ANTHROPIC_JSON_CASE,
            proxy_log_path=proxy_log_path,
        )
        payload = (
            b'{"id":"msg_1","model":"claude-sonnet-4-6","content":[{"text":"'
            + b"A" * (STREAM_DECODE_EXPANSION_GRACE + 1024)
            + b'"}],"usage":{"input_tokens":50,"output_tokens":200}}'
        )
        compressed = gzip.compress(payload) if encoding_case == "gzip" else zlib.compress(payload)
        allowed_decoded_bytes = max(
            STREAM_DECODE_EXPANSION_GRACE,
            len(compressed) * STREAM_DECODE_MAX_EXPANSION_RATIO,
        )
        assert allowed_decoded_bytes < len(payload)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map(
                {"content-type": "application/json", "content-encoding": encoding_case}
            ),
        )

        mitm_addon.responseheaders(flow)
        assert response_stream(flow)(compressed) == compressed

        webhook = run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
        assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata
        entries = read_jsonl_entries_after_flush(proxy_log_path)
        usage_warnings = [
            entry
            for entry in entries
            if entry.get("message") == "Model provider JSON usage extraction failed"
        ]
        assert len(usage_warnings) == 1
        assert usage_warnings[0]["error"] == "decoded body limit exceeded"

    def test_full_pipeline_small_zstd_model_json_uses_bounded_fallback(
        self,
        tmp_path,
        real_flow,
    ):
        flow = model_provider_flow(
            real_flow,
            tmp_path,
            ANTHROPIC_JSON_CASE,
            proxy_log_path=tmp_path / "proxy.jsonl",
        )
        payload = standard_success_payload(ANTHROPIC_JSON_CASE)
        compressed = zstandard.ZstdCompressor().compress(payload)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json", "content-encoding": "zstd"}),
        )

        mitm_addon.responseheaders(flow)
        assert "model_json_usage_finish" in flow.metadata
        response_stream(flow)(compressed)
        assert metadata_keys.STREAM_BUFFER in flow.metadata
        assert metadata_keys.STREAM_BUFFER_STATE in flow.metadata

        webhook = run_response(flow, self._usage_webhook_api)

        extracted = flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]
        expected_usage = expected_model_usage(ANTHROPIC_JSON_CASE)
        assert extracted["message_id"] == expected_usage["message_id"]
        assert extracted["model"] == expected_usage["model"]
        assert extracted["tokens.input"] == expected_usage["tokens.input"]
        assert extracted["tokens.output"] == expected_usage["tokens.output"]
        events = webhook.usage_events()
        by_category = {event["category"]: event["quantity"] for event in events}
        assert by_category == expected_event_quantities(ANTHROPIC_JSON_CASE)

    def test_full_pipeline_large_zstd_model_json_does_not_parse_truncated_fallback(
        self,
        tmp_path,
        real_flow,
    ):
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow = model_provider_flow(
            real_flow,
            tmp_path,
            ANTHROPIC_JSON_CASE,
            proxy_log_path=proxy_log_path,
        )
        payload = json.dumps(
            {
                "id": "msg_zstd_large",
                "model": "claude-sonnet-4-6",
                "content": [{"text": _deterministic_low_ratio_text(STREAM_BUFFER_LIMIT * 8)}],
                "usage": {"input_tokens": 10, "output_tokens": 20},
            }
        ).encode()
        compressed = zstandard.ZstdCompressor().compress(payload)
        assert len(compressed) > STREAM_BUFFER_LIMIT
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json", "content-encoding": "zstd"}),
        )

        mitm_addon.responseheaders(flow)
        assert "model_json_usage_finish" in flow.metadata
        response_stream(flow)(compressed)
        assert len(flow.metadata[metadata_keys.STREAM_BUFFER]) == STREAM_BUFFER_LIMIT
        assert flow.metadata[metadata_keys.STREAM_BUFFER_STATE]["truncated"] is True

        webhook = run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
        assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata
        entries = read_jsonl_entries_after_flush(proxy_log_path)
        usage_warnings = [
            entry
            for entry in entries
            if entry.get("message") == "Model provider JSON usage extraction failed"
        ]
        assert len(usage_warnings) == 1
        assert usage_warnings[0]["error"] == "incomplete compressed body"

    @pytest.mark.parametrize("encoding_case", ["gzip", "deflate"])
    @pytest.mark.parametrize(
        "provider_case",
        MODEL_PROVIDER_JSON_CASES,
        ids=model_provider_json_case_id,
    )
    def test_full_pipeline_truncated_compressed_model_json_does_not_report_usage(
        self, tmp_path, real_flow, encoding_case, provider_case
    ):
        """Incremental JSON usage must reject compressed streams missing a trailer."""
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow = model_provider_flow(
            real_flow,
            tmp_path,
            provider_case,
            proxy_log_path=proxy_log_path,
        )
        payload = standard_success_payload(provider_case)
        if encoding_case == "gzip":
            compressed = gzip.compress(payload)[:-1]
        else:
            compressed = zlib.compress(payload)[:-1]
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map(
                {"content-type": "application/json", "content-encoding": encoding_case}
            ),
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(compressed)

        webhook = run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
        assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata
        entries = read_jsonl_entries_after_flush(proxy_log_path)
        usage_warnings = [
            entry
            for entry in entries
            if entry.get("message") == "Model provider JSON usage extraction failed"
        ]
        assert len(usage_warnings) == 1
        assert usage_warnings[0]["error"] == "incomplete compressed body"

    @pytest.mark.parametrize("encoding_case", ["gzip", "deflate"])
    def test_full_pipeline_corrupt_trailing_zlib_member_does_not_report_decoded_usage(
        self, tmp_path, real_flow, encoding_case
    ):
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow = model_provider_flow(
            real_flow,
            tmp_path,
            ANTHROPIC_JSON_CASE,
            proxy_log_path=proxy_log_path,
        )
        payload = standard_success_payload(ANTHROPIC_JSON_CASE)
        compress = gzip.compress if encoding_case == "gzip" else zlib.compress
        trailing_member = bytearray(compress(b""))
        checksum_offset = -8 if encoding_case == "gzip" else -1
        trailing_member[checksum_offset] ^= 0xFF
        compressed = compress(payload) + bytes(trailing_member)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map(
                {"content-type": "application/json", "content-encoding": encoding_case}
            ),
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(compressed)

        webhook = run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
        assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata
        entries = read_jsonl_entries_after_flush(proxy_log_path)
        usage_warnings = [
            entry
            for entry in entries
            if entry.get("message") == "Model provider JSON usage extraction failed"
        ]
        assert len(usage_warnings) == 1
        assert usage_warnings[0]["error"] == "invalid compressed body"

    @pytest.mark.parametrize("encoding_case", ["gzip", "deflate"])
    def test_full_pipeline_concatenated_zlib_model_json_reports_usage(
        self, tmp_path, real_flow, encoding_case
    ):
        """Streaming decompression should feed later zlib members into JSON usage parsing."""
        provider_case = ANTHROPIC_JSON_CASE
        flow = model_provider_flow(
            real_flow,
            tmp_path,
            provider_case,
            proxy_log_path=tmp_path / "proxy.jsonl",
        )
        payload = standard_success_payload(provider_case)
        if encoding_case == "gzip":
            compressed = gzip.compress(b"") + gzip.compress(payload)
        else:
            compressed = zlib.compress(b"") + zlib.compress(payload)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map(
                {"content-type": "application/json", "content-encoding": encoding_case}
            ),
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(compressed)

        webhook = run_response(flow, self._usage_webhook_api)

        extracted = flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]
        expected_usage = expected_model_usage(provider_case)
        assert extracted["model"] == expected_usage["model"]
        assert extracted["tokens.input"] == expected_usage["tokens.input"]
        assert extracted["tokens.output"] == expected_usage["tokens.output"]
        events = webhook.usage_events()
        by_category = {event["category"]: event["quantity"] for event in events}
        assert by_category == expected_event_quantities(provider_case)

    @pytest.mark.parametrize(
        "provider_case",
        MODEL_PROVIDER_JSON_CASES,
        ids=model_provider_json_case_id,
    )
    def test_full_pipeline_brotli_model_json_streams_usage(
        self, tmp_path, real_flow, provider_case
    ):
        flow = model_provider_flow(
            real_flow,
            tmp_path,
            provider_case,
            proxy_log_path=tmp_path / "proxy.jsonl",
        )
        payload = standard_success_payload(provider_case)
        compressed = brotli.compress(payload)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json", "content-encoding": "br"}),
        )

        mitm_addon.responseheaders(flow)
        midpoint = len(compressed) // 2
        response_stream(flow)(compressed[:midpoint])
        response_stream(flow)(compressed[midpoint:])
        assert metadata_keys.STREAM_BUFFER not in flow.metadata
        assert metadata_keys.STREAM_BUFFER_STATE not in flow.metadata

        webhook = run_response(flow, self._usage_webhook_api)

        extracted = flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]
        expected_usage = expected_model_usage(provider_case)
        assert extracted["model"] == expected_usage["model"]
        assert extracted["tokens.input"] == expected_usage["tokens.input"]
        assert extracted["tokens.output"] == expected_usage["tokens.output"]
        if provider_case.uses_openai_responses:
            assert extracted["tokens.cache_read"] == expected_usage["tokens.cache_read"]
        events = webhook.usage_events()
        by_category = {event["category"]: event["quantity"] for event in events}
        assert by_category == expected_event_quantities(provider_case)

    def test_full_pipeline_incomplete_model_json_does_not_report_partial_usage(
        self, tmp_path, real_flow
    ):
        """Fields seen before EOF are ignored unless the JSON document completes."""
        flow = model_provider_flow(
            real_flow,
            tmp_path,
            ANTHROPIC_JSON_CASE,
            proxy_log_path=tmp_path / "proxy.jsonl",
        )
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(
            b'{"id":"msg_1","model":"claude-sonnet-4-6",'
            b'"usage":{"input_tokens":50,"output_tokens":200}'
        )

        webhook = run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
        proxy_log = Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])
        entries = read_jsonl_entries_after_flush(proxy_log)
        usage_warnings = [
            entry
            for entry in entries
            if entry.get("message") == "Model provider JSON usage extraction failed"
        ]
        assert len(usage_warnings) == 1
        assert usage_warnings[0]["error"] == "incomplete json"

    def test_full_pipeline_corrupt_model_json_encoding_does_not_fallback_to_raw_buffer(
        self, tmp_path, real_flow
    ):
        """A bad Content-Encoding must not parse raw stream_buffer and bill usage."""
        raw_json = json.dumps(
            {
                "id": "msg_1",
                "model": "claude-sonnet-4-6",
                "usage": {"input_tokens": 50, "output_tokens": 200},
            }
        ).encode()
        flow = model_provider_flow(
            real_flow,
            tmp_path,
            ANTHROPIC_JSON_CASE,
            proxy_log_path=tmp_path / "proxy.jsonl",
        )
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json", "content-encoding": "gzip"}),
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(raw_json)

        webhook = run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
        assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata
        assert metadata_keys.STREAM_BUFFER not in flow.metadata

    def test_full_pipeline_model_json_ignores_usage_array_shape(self, tmp_path, real_flow):
        """usage fields inside array elements must not be treated as usage object fields."""
        body = json.dumps(
            {
                "id": "msg_1",
                "model": "claude-sonnet-4-6",
                "usage": [{"input_tokens": 50, "output_tokens": 200}],
            }
        ).encode()
        flow = model_provider_flow(
            real_flow,
            tmp_path,
            ANTHROPIC_JSON_CASE,
            proxy_log_path=tmp_path / "proxy.jsonl",
        )
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(body)

        webhook = run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
