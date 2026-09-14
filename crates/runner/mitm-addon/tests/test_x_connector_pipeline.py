"""Tests for X connector response and error hook lifecycle."""

import gzip
import json
import zlib
from pathlib import Path

import brotli
import pytest
import zstandard
from mitmproxy.flow import Error

import flow_metadata_keys as metadata_keys
import mitm_addon
import usage
from body_limits import (
    STREAM_BUFFER_LIMIT,
    STREAM_DECODE_CHUNK_LIMIT,
    STREAM_DECODE_EXPANSION_GRACE,
    STREAM_DECODE_MAX_EXPANSION_RATIO,
)
from tests.flow_helpers import response_stream
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.x_flow_helpers import (
    json_body_that_exceeds_integer_digit_limit,
    json_body_that_exceeds_nesting_limit,
    json_body_that_exceeds_x_json_work_limit,
    make_x_pipeline_flow,
    make_x_stream_pipeline_flow,
)


def _compress_body(encoding: str, payload: bytes) -> bytes:
    if encoding == "gzip":
        return gzip.compress(payload)
    if encoding == "deflate":
        return zlib.compress(payload)
    if encoding == "br":
        return brotli.compress(payload)
    if encoding == "zstd":
        return zstandard.ZstdCompressor().compress(payload)
    raise AssertionError(f"unsupported test encoding: {encoding}")


class TestXConnectorResponsePipeline:
    """Tests for X connector usage through responseheaders -> response."""

    @pytest.fixture(autouse=True)
    def _sync_executor(self, sync_usage_executor, usage_webhook_api):
        """All tests here route billing through ``_call_and_get_billing`` which
        inspects webhook delivery inline; the sync executor makes that work
        without each test needing its own ``fresh_usage_executor`` + shutdown.
        """
        self._usage_webhook_api = usage_webhook_api

    def _call_and_get_billing(self, flow, run_id="run-abc-123"):
        """Call report_connector_usage and return the webhook payload(s).

        Relies on the class-level ``_sync_executor`` autouse fixture to
        route submissions inline.
        """
        with self._usage_webhook_api() as webhook:
            start_count = webhook.request_count
            usage.report_connector_usage(flow, run_id)
            usage.flush_usage_events(trigger="test")
        return [
            event
            for request in webhook.requests[start_count:]
            for body in [request.json_body()]
            for event in body["events"]
        ]

    def test_full_response_pipeline_large_x_json_uses_incremental_parser_without_buffer(
        self, tmp_path, real_flow, mitm_ctx
    ):
        """responseheaders + response bill X JSON without a body-prefix copy."""
        flow = make_x_pipeline_flow(real_flow, tmp_path, query="expansions=author_id")

        mitm_addon.responseheaders(flow)
        callback = response_stream(flow)
        callback(b'{"data":[{"id":"1","text":"')
        callback(b"x" * (STREAM_BUFFER_LIMIT + 4096))
        callback(b'"}],"includes":{"users":[{"id":"u1"}]},"meta":{"result_count":1}}')
        assert metadata_keys.STREAM_BUFFER not in flow.metadata
        assert metadata_keys.STREAM_BUFFER_STATE not in flow.metadata

        with self._usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")

        events = webhook.usage_events()
        by_category = {event["category"]: event["quantity"] for event in events}
        assert len(events) == len(by_category)
        assert by_category == {"posts.read": 1, "user.read": 1}

    def test_full_response_pipeline_brotli_x_json_uses_incremental_parser(
        self, tmp_path, real_flow, mitm_ctx
    ):
        flow = make_x_pipeline_flow(real_flow, tmp_path, content_encoding="br")
        payload = b'{"data":[{"id":"1"}],"includes":{"users":[{"id":"u1"}]}}'
        compressed = _compress_body("br", payload)

        with mitm_ctx():
            mitm_addon.responseheaders(flow)
        midpoint = len(compressed) // 2
        response_stream(flow)(compressed[:midpoint])
        response_stream(flow)(compressed[midpoint:])
        response_stream(flow)(b"")
        assert metadata_keys.STREAM_BUFFER not in flow.metadata
        assert metadata_keys.STREAM_BUFFER_STATE not in flow.metadata

        with self._usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")

        events = webhook.usage_events()
        by_category = {event["category"]: event["quantity"] for event in events}
        assert len(events) == len(by_category)
        assert by_category == {"posts.read": 1, "user.read": 1}

    def test_full_response_pipeline_zstd_x_json_uses_bounded_fallback(
        self, tmp_path, real_flow, mitm_ctx
    ):
        flow = make_x_pipeline_flow(real_flow, tmp_path, content_encoding="zstd")
        payload = b'{"data":[{"id":"1"}],"includes":{"users":[{"id":"u1"}]}}'

        with mitm_ctx():
            mitm_addon.responseheaders(flow)
        response_stream(flow)(_compress_body("zstd", payload))
        assert metadata_keys.STREAM_BUFFER in flow.metadata
        assert metadata_keys.STREAM_BUFFER_STATE in flow.metadata

        payloads = self._call_and_get_billing(flow)

        by_category = {event["category"]: event["quantity"] for event in payloads}
        assert len(payloads) == len(by_category)
        assert by_category == {"posts.read": 1, "user.read": 1}
        assert "connector_response_finish" not in flow.metadata
        assert metadata_keys.X_NDJSON_STATE not in flow.metadata

    def test_full_response_pipeline_bounds_buffered_x_json_fallback_work(
        self, tmp_path, real_flow, mitm_ctx
    ):
        encoding_case = "zstd"
        flow = make_x_pipeline_flow(
            real_flow,
            tmp_path,
            path="/2/tweets/search/recent",
            query="query=vm0",
            rule="GET /2/tweets/search/recent",
            content_encoding=encoding_case,
        )
        payload = json_body_that_exceeds_x_json_work_limit()
        compressed = _compress_body(encoding_case, payload)
        assert len(compressed) < STREAM_BUFFER_LIMIT < len(payload)

        with mitm_ctx():
            mitm_addon.responseheaders(flow)
        assert response_stream(flow)(compressed) == compressed

        with self._usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")

        assert webhook.request_count == 0
        entries = read_jsonl_entries_after_flush(
            Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])
        )
        lost_visibility_entries = [
            entry for entry in entries if "unparseable" in entry["message"].lower()
        ]
        assert len(lost_visibility_entries) == 1
        assert lost_visibility_entries[0]["body_truncated"] is False

    @pytest.mark.parametrize("encoding_case", ["gzip", "deflate"])
    def test_full_response_pipeline_bounds_compressed_x_json_work(
        self, tmp_path, real_flow, encoding_case
    ):
        flow = make_x_pipeline_flow(
            real_flow,
            tmp_path,
            path="/2/tweets/search/recent",
            query="query=vm0",
            rule="GET /2/tweets/search/recent",
            content_encoding=encoding_case,
        )
        payload = json_body_that_exceeds_x_json_work_limit()
        compressed = _compress_body(encoding_case, payload)
        allowed_decoded_bytes = max(
            STREAM_DECODE_EXPANSION_GRACE,
            len(compressed) * STREAM_DECODE_MAX_EXPANSION_RATIO,
        )
        assert STREAM_DECODE_CHUNK_LIMIT < len(payload) <= allowed_decoded_bytes

        mitm_addon.responseheaders(flow)
        callback = response_stream(flow)
        assert callback(compressed) == compressed
        corrupt_followup = bytearray(_compress_body(encoding_case, b""))
        checksum_offset = -8 if encoding_case == "gzip" else -1
        corrupt_followup[checksum_offset] ^= 0xFF
        assert callback(bytes(corrupt_followup)) == bytes(corrupt_followup)

        with self._usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")

        assert webhook.request_count == 0
        entries = read_jsonl_entries_after_flush(
            Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])
        )
        lost_visibility_entries = [
            entry for entry in entries if "unparseable" in entry["message"].lower()
        ]
        assert len(lost_visibility_entries) == 1
        entry = lost_visibility_entries[0]
        assert entry["body_truncated"] is False
        assert entry["parse_error"] == "work limit exceeded"

    def test_responseheaders_unsafe_compressed_x_stream_does_not_leave_parser_state(
        self, tmp_path, real_flow, mitm_ctx
    ):
        encoding_case = "zstd"
        flow = make_x_stream_pipeline_flow(real_flow, tmp_path)
        assert flow.response is not None
        flow.response.headers["content-encoding"] = encoding_case

        with mitm_ctx():
            mitm_addon.responseheaders(flow)

        assert "connector_response_finish" not in flow.metadata
        assert metadata_keys.X_NDJSON_STATE not in flow.metadata

    @pytest.mark.parametrize("encoding_case", ["gzip", "deflate", "br", "zstd"])
    def test_full_response_pipeline_truncated_compressed_x_json_does_not_bill(
        self, tmp_path, real_flow, mitm_ctx, encoding_case
    ):
        flow = make_x_pipeline_flow(
            real_flow,
            tmp_path,
            path="/2/tweets/search/recent",
            query="query=vm0",
            sandbox_value="tok-xyz",
            rule="GET /2/tweets/search/recent",
            content_encoding=encoding_case,
        )
        payload = b'{"data":[{"id":"1"}],"meta":{"result_count":1}}'
        compressed = _compress_body(encoding_case, payload)[:-1]

        mitm_addon.responseheaders(flow)
        response_stream(flow)(compressed)

        with self._usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")

        assert webhook.request_count == 0
        proxy_log = Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])
        entries = read_jsonl_entries_after_flush(proxy_log)
        lost_visibility_entries = [
            entry for entry in entries if "unparseable" in entry["message"].lower()
        ]
        assert len(lost_visibility_entries) == 1
        entry = lost_visibility_entries[0]
        assert entry["level"] == "error"
        assert entry["body_truncated"] is False
        assert entry["parse_error"] == "incomplete compressed body"
        assert "connector_response_finish" not in flow.metadata

    def test_full_response_pipeline_x_data_object_bills_single_resource(
        self, tmp_path, real_flow, mitm_ctx
    ):
        """Selective X JSON extraction must count a top-level data object as one resource."""
        flow = make_x_pipeline_flow(
            real_flow,
            tmp_path,
            path="/2/tweets/1",
            rule="GET /2/tweets/{id}",
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(b'{"data":{"id":"1","text":"hello"}}')

        with self._usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")

        events = webhook.usage_events()
        assert len(events) == 1
        assert events[0]["category"] == "posts.read"
        assert events[0]["quantity"] == 1

    def test_full_response_pipeline_x_soft_error_ignores_request_hints(
        self, tmp_path, real_flow, mitm_ctx
    ):
        """Parsed X soft errors must not fall back to URL hints and bill missing resources."""
        flow = make_x_pipeline_flow(real_flow, tmp_path, query="ids=1,2,3")

        mitm_addon.responseheaders(flow)
        response_stream(flow)(
            json.dumps(
                {
                    "errors": [
                        {
                            "title": "Not Found Error",
                            "detail": "Could not find tweets for ids: [1, 2, 3].",
                        }
                    ]
                }
            ).encode()
        )

        with self._usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")

        assert webhook.request_count == 0

    def test_full_response_pipeline_x_root_array_uses_request_hints(
        self, tmp_path, real_flow, mitm_ctx
    ):
        """Non-object JSON roots stay unparsed so request-side hints still bill."""
        flow = make_x_pipeline_flow(real_flow, tmp_path, path="/2/tweets?ids=1,2,3")

        mitm_addon.responseheaders(flow)
        response_stream(flow)(b'[{"id":"1"}]')

        with self._usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")

        events = webhook.usage_events()
        assert len(events) == 1
        assert events[0]["category"] == "posts.read"
        assert events[0]["quantity"] == 3

    def test_full_streaming_pipeline_filtered_stream(self, tmp_path, real_flow, mitm_ctx, headers):
        """End-to-end: responseheaders registers parser, chunks accumulate, response() logs."""
        flow = make_x_stream_pipeline_flow(real_flow, tmp_path)

        # 1. responseheaders - registers NDJSON parser
        mitm_addon.responseheaders(flow)
        callback = response_stream(flow)
        assert metadata_keys.X_NDJSON_STATE in flow.metadata
        assert "connector_response_finish" in flow.metadata

        # 2. Stream chunks (including keep-alives and a mid-line split)
        chunks = [
            b'{"data":{"id":"1"},"includes":{"users":[{"id":"u1"}]}}\n',
            b"\n",  # keep-alive
            b'{"data":{"id":"2"},"includes":{"users":[{"id":"u2"}]}}\n',
            b'{"data":{"id":"3"}',  # split mid-line
            b',"includes":{"users":[{"id":"u3"}]}}\n',
        ]
        for chunk in chunks:
            callback(chunk)

        # 3. Simulated disconnect - response() fires and logs via webhook
        with self._usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")

        # 4. Verify billing payloads
        payloads = webhook.usage_events()
        by_cat = {p["category"]: p["quantity"] for p in payloads}
        assert len(payloads) == len(by_cat)
        assert by_cat == {
            "posts.read": 3,  # 3 primary tweets; no includes.tweets
            "user.read": 3,  # 3 users from includes
        }

    def test_full_streaming_pipeline_counts_final_line_without_newline(
        self, tmp_path, real_flow, mitm_ctx, headers
    ):
        """End-to-end: response() finalizes a complete NDJSON row without trailing newline."""
        flow = make_x_stream_pipeline_flow(real_flow, tmp_path)

        mitm_addon.responseheaders(flow)
        callback = response_stream(flow)
        callback(b'{"data":{"id":"1"}}\n')
        callback(b'{"data":{"id":"2"},"includes":{"users":[{"id":"u2"}]}}')

        with self._usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")

        payloads = webhook.usage_events()
        by_cat = {payload["category"]: payload["quantity"] for payload in payloads}
        assert len(payloads) == len(by_cat)
        assert by_cat == {"posts.read": 2, "user.read": 1}
        assert "connector_response_finish" not in flow.metadata

    def test_full_pipeline_compressed_stream_error_does_not_bill_unverified_rows(
        self, tmp_path, real_flow, mitm_ctx, headers, usage_webhook_api
    ):
        flow = make_x_stream_pipeline_flow(real_flow, tmp_path)
        assert flow.response is not None
        flow.response.headers["content-encoding"] = "gzip"

        mitm_addon.responseheaders(flow)
        callback = response_stream(flow)
        callback(
            gzip.compress(
                b'{"data":{"id":"1"},"includes":{"users":[{"id":"u1"}]}}\n{"data":{"id":"2"}}\n'
            )[:-1]
        )
        assert flow.metadata[metadata_keys.X_NDJSON_STATE]["data_count"] == 2
        flow.error = Error("connection reset by peer")

        with usage_webhook_api() as webhook:
            mitm_addon.error(flow)
            usage.flush_usage_events(trigger="test")

        assert webhook.request_count == 0
        assert metadata_keys.X_NDJSON_STATE not in flow.metadata
        proxy_log = Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])
        entries = read_jsonl_entries_after_flush(proxy_log)
        lost_visibility_entries = [
            entry for entry in entries if "unparseable" in entry["message"].lower()
        ]
        assert len(lost_visibility_entries) == 1
        assert lost_visibility_entries[0]["parse_error"] == "incomplete compressed body"

    def test_full_streaming_pipeline_ignores_malformed_include_values(
        self, tmp_path, real_flow, mitm_ctx, headers
    ):
        """Malformed include values are ignored while valid siblings still bill."""
        flow = make_x_stream_pipeline_flow(real_flow, tmp_path)

        mitm_addon.responseheaders(flow)
        callback = response_stream(flow)
        assert metadata_keys.X_NDJSON_STATE in flow.metadata
        assert "connector_response_finish" in flow.metadata

        callback(
            b'{"data":{"id":"1"},"includes":'
            b'{"users":null,'
            b'"tweets":{"id":"t1"},'
            b'"media":[{"media_key":"m1"}]}}\n'
        )
        state = flow.metadata[metadata_keys.X_NDJSON_STATE]
        assert state["data_count"] == 1
        assert state["includes"] == {"media": 1}
        assert state["lines_parsed"] == 1
        assert state["lines_failed"] == 0

        with self._usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")

        payloads = webhook.usage_events()
        by_cat = {payload["category"]: payload["quantity"] for payload in payloads}
        assert len(payloads) == len(by_cat)
        assert by_cat == {"posts.read": 1, "media.read": 1}

    @pytest.mark.parametrize(
        "failed_line",
        [
            pytest.param(json_body_that_exceeds_nesting_limit(), id="excessive-nesting"),
            pytest.param(json_body_that_exceeds_integer_digit_limit(), id="integer-digit-limit"),
            pytest.param(
                json_body_that_exceeds_x_json_work_limit(),
                id="work-limit",
            ),
        ],
    )
    def test_full_streaming_pipeline_continues_after_uninspectable_json_row(
        self, tmp_path, real_flow, mitm_ctx, headers, failed_line
    ):
        """A hostile NDJSON row must not stop later valid rows from billing."""
        flow = make_x_stream_pipeline_flow(real_flow, tmp_path)

        mitm_addon.responseheaders(flow)
        callback = response_stream(flow)

        callback(failed_line + b'\n{"data":{"id":"1"},"includes":{"users":[{"id":"u1"}]}}\n')

        state = flow.metadata[metadata_keys.X_NDJSON_STATE]
        assert state["lines_failed"] == 1
        assert state["lines_parsed"] == 1
        assert state["data_count"] == 1
        assert state["includes"] == {"users": 1}

        with self._usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")

        payloads = webhook.usage_events()
        by_cat = {payload["category"]: payload["quantity"] for payload in payloads}
        assert len(payloads) == len(by_cat)
        assert by_cat == {"posts.read": 1, "user.read": 1}

    def test_full_streaming_pipeline_accepts_many_shallow_containers(
        self, tmp_path, real_flow, mitm_ctx, headers
    ):
        """The nesting guard does not reject a wide but shallow NDJSON row."""
        flow = make_x_stream_pipeline_flow(real_flow, tmp_path)

        mitm_addon.responseheaders(flow)
        callback = response_stream(flow)
        callback(
            json.dumps(
                {
                    "data": {"id": "1"},
                    "matching_rules": [{} for _ in range(300)],
                }
            ).encode()
            + b"\n"
        )

        state = flow.metadata[metadata_keys.X_NDJSON_STATE]
        assert state["lines_failed"] == 0
        assert state["lines_parsed"] == 1
        assert state["data_count"] == 1

        with self._usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")

        payloads = webhook.usage_events()
        assert len(payloads) == 1
        assert payloads[0]["category"] == "posts.read"
        assert payloads[0]["quantity"] == 1

    def test_full_streaming_pipeline_bounds_unknown_include_categories(
        self, tmp_path, real_flow, mitm_ctx, headers
    ):
        """Long-lived streams fold unknown include overflow into one fallback-priced bucket."""
        flow = make_x_stream_pipeline_flow(real_flow, tmp_path)

        mitm_addon.responseheaders(flow)
        callback = response_stream(flow)
        for index in range(70):
            callback(
                b'{"data":{"id":"'
                + str(index).encode()
                + b'"},"includes":{"future_'
                + str(index).encode()
                + b'":[{"id":"u"}]}}\n'
            )
        callback(b'{"data":{"id":"known"},"includes":{"users":[{"id":"user"}]}}\n')
        state = flow.metadata[metadata_keys.X_NDJSON_STATE]
        assert state["unknown_includes_overflow_count"] == 6
        assert state["includes"]["users"] == 1

        with self._usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")

        payloads = webhook.usage_events()
        by_cat = {payload["category"]: payload["quantity"] for payload in payloads}
        assert len(payloads) == len(by_cat)
        assert by_cat == {
            "posts.read": 71,
            "user.read": 1,
            **{f"includes.future_{index}": 1 for index in range(64)},
            "includes.__overflow__": 6,
        }
        assert all(len(category) <= 100 for category in by_cat)

    def test_response_logs_incremental_x_json_parse_error(self, tmp_path, real_flow, mitm_ctx):
        """Full response hook should audit parse errors from the incremental X JSON parser."""
        flow = make_x_pipeline_flow(
            real_flow,
            tmp_path,
            path="/2/tweets/search/recent",
            query="query=vm0",
            sandbox_value="tok-xyz",
            rule="GET /2/tweets/search/recent",
        )
        mitm_addon.responseheaders(flow)
        response_stream(flow)(b'{"data":[{"id":"1"}')
        assert "connector_response_finish" in flow.metadata

        with self._usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")

        assert webhook.usage_events() == []
        proxy_log = Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])
        entries = read_jsonl_entries_after_flush(proxy_log)
        lost_visibility_entries = [
            entry for entry in entries if "unparseable" in entry["message"].lower()
        ]
        assert len(lost_visibility_entries) == 1
        entry = lost_visibility_entries[0]
        assert entry["level"] == "error"
        assert entry["body_truncated"] is False
        assert isinstance(entry["parse_error"], str)
        assert entry["parse_error"]
        assert "connector_response_finish" not in flow.metadata

    def test_response_logs_x_json_parse_error_after_forensic_buffer_truncates(
        self, tmp_path, real_flow, mitm_ctx
    ):
        """The X JSON parser should stay authoritative after the forensic buffer fills."""
        flow = make_x_pipeline_flow(
            real_flow,
            tmp_path,
            path="/2/tweets/search/recent",
            query="query=vm0",
            sandbox_value="tok-xyz",
            rule="GET /2/tweets/search/recent",
        )
        flow.metadata[metadata_keys.CAPTURE_BODY] = True

        mitm_addon.responseheaders(flow)
        response_stream(flow)(b'{"data":[{"id":"1","text":"' + b"x" * STREAM_BUFFER_LIMIT)
        assert flow.metadata[metadata_keys.STREAM_BUFFER_STATE]["truncated"] is True

        with self._usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")

        assert webhook.usage_events() == []
        proxy_log = Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])
        entries = read_jsonl_entries_after_flush(proxy_log)
        lost_visibility_entries = [
            entry for entry in entries if "unparseable" in entry["message"].lower()
        ]
        assert len(lost_visibility_entries) == 1
        entry = lost_visibility_entries[0]
        assert entry["level"] == "error"
        assert entry["body_truncated"] is False
        assert entry["parse_error"] == "incomplete string"
        assert "connector_response_finish" not in flow.metadata

    def test_response_uses_request_hints_for_incremental_x_json_parse_error(
        self, tmp_path, real_flow, mitm_ctx
    ):
        """Incremental X JSON parser failures should still bill from URL hints."""
        flow = make_x_pipeline_flow(
            real_flow,
            tmp_path,
            path="/2/tweets?ids=1,2,3",
            sandbox_value="tok-xyz",
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(b'{"data":[{"id":"1"}')
        assert "connector_response_finish" in flow.metadata

        with self._usage_webhook_api() as webhook:
            mitm_addon.response(flow)
            usage.flush_usage_events(trigger="test")

        events = webhook.usage_events()
        assert len(events) == 1
        assert events[0]["category"] == "posts.read"
        assert events[0]["quantity"] == 3
        proxy_log = Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])
        entries = read_jsonl_entries_after_flush(proxy_log)
        assert all(entry["level"] != "error" for entry in entries)
        assert all("unparseable" not in entry["message"].lower() for entry in entries)
        assert all("parse_error" not in entry for entry in entries)
        assert "connector_response_finish" not in flow.metadata


class TestXConnectorErrorPipeline:
    """Tests for X connector usage through responseheaders -> error."""

    @pytest.fixture(autouse=True)
    def _sync_executor(self, sync_usage_executor):
        """Run delivery inline for error-pipeline behavior tests."""

    def test_full_pipeline_json_error_does_not_bill_request_hints(
        self, tmp_path, real_flow, mitm_ctx, headers, usage_webhook_api
    ):
        """Interrupted ordinary JSON cannot bill from request-side hints."""
        flow = make_x_pipeline_flow(real_flow, tmp_path, query="ids=1,2,3")

        mitm_addon.responseheaders(flow)
        response_stream(flow)(b'{"data":[')
        flow.error = Error("connection reset by peer")

        with usage_webhook_api() as webhook:
            mitm_addon.error(flow)
            usage.flush_usage_events(trigger="test")

        assert webhook.usage_events() == []
        assert metadata_keys.X_JSON_STATE not in flow.metadata
        assert "connector_response_finish" not in flow.metadata
        assert "connector_response_report_on_interruption" not in flow.metadata

    @pytest.mark.parametrize("encoding_case", ["gzip", "deflate"])
    def test_full_pipeline_complete_compressed_stream_error_reports_verified_rows(
        self, tmp_path, real_flow, usage_webhook_api, encoding_case
    ):
        """A connection error still bills rows from a verified compressed member."""
        flow = make_x_stream_pipeline_flow(real_flow, tmp_path)
        assert flow.response is not None
        flow.response.headers["content-encoding"] = encoding_case

        mitm_addon.responseheaders(flow)
        response_stream(flow)(
            _compress_body(
                encoding_case,
                b'{"data":{"id":"1"},"includes":{"users":[{"id":"u1"}]}}\n{"data":{"id":"2"}}\n',
            )
        )
        assert flow.metadata[metadata_keys.X_NDJSON_STATE]["data_count"] == 2
        flow.error = Error("connection reset by peer")

        with usage_webhook_api() as webhook:
            mitm_addon.error(flow)
            usage.flush_usage_events(trigger="test")

        payloads = webhook.usage_events()
        by_cat = {payload["category"]: payload["quantity"] for payload in payloads}
        assert webhook.request_count == 1
        assert len(payloads) == len(by_cat)
        assert by_cat == {"posts.read": 2, "user.read": 1}

        proxy_log = Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])
        entries = read_jsonl_entries_after_flush(proxy_log)
        assert any(entry["type"] == "connection_error" for entry in entries)
        assert all("unparseable" not in entry["message"].lower() for entry in entries)
        assert all("parse_error" not in entry for entry in entries)
        assert "connector_response_finish" not in flow.metadata
        assert "connector_response_report_on_interruption" not in flow.metadata
        assert metadata_keys.RESPONSE_STREAM_STATE not in flow.metadata
        assert flow.response.stream is False

    def test_full_pipeline_stream_error_without_network_log_reports_verified_rows(
        self, tmp_path, real_flow, mitm_ctx, headers, usage_webhook_api
    ):
        """End-to-end: responseheaders -> partial chunks -> error() reports observed counts.

        Simulates a real scenario: stream opens successfully, a few tweets
        arrive, then the connection resets.  No pre-populated state: the
        incremental parser must have accumulated counts from the chunks.
        """
        flow = make_x_stream_pipeline_flow(real_flow, tmp_path)
        flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = ""
        flow.metadata.pop(metadata_keys.NETWORK_LOG_TARGET)

        # 1. Register parser
        mitm_addon.responseheaders(flow)
        callback = response_stream(flow)
        assert metadata_keys.X_NDJSON_STATE in flow.metadata

        # 2. Receive two complete tweets, then a partial third (cut off)
        callback(b'{"data":{"id":"1"},"includes":{"users":[{"id":"u1"}]}}\n')
        callback(b'{"data":{"id":"2"}}\n')
        callback(b'{"data":{"id":"3"}')  # no trailing newline; connection dies here

        # 3. Connection aborts
        flow.error = Error("connection reset by peer")

        with usage_webhook_api() as webhook:
            mitm_addon.error(flow)
            usage.flush_usage_events(trigger="test")

        # 4. Billing must reflect the 2 complete tweets (partial 3rd is dropped)
        payloads = webhook.usage_events()
        by_cat = {p["category"]: p["quantity"] for p in payloads}
        assert len(payloads) == len(by_cat)
        assert by_cat == {"posts.read": 2, "user.read": 1}
        assert "connector_response_report_on_interruption" not in flow.metadata
        assert not (tmp_path / "network.jsonl").exists()

    def test_full_pipeline_stream_error_counts_complete_final_line_without_newline(
        self, tmp_path, real_flow, mitm_ctx, headers, usage_webhook_api
    ):
        """Connection error finalizes a complete NDJSON row without trailing newline."""
        flow = make_x_stream_pipeline_flow(real_flow, tmp_path)

        mitm_addon.responseheaders(flow)
        callback = response_stream(flow)
        callback(b'{"data":{"id":"1"}}\n')
        callback(b'{"data":{"id":"2"},"includes":{"users":[{"id":"u2"}]}}')
        flow.error = Error("connection reset by peer")

        with usage_webhook_api() as webhook:
            mitm_addon.error(flow)
            usage.flush_usage_events(trigger="test")

        payloads = webhook.usage_events()
        by_cat = {payload["category"]: payload["quantity"] for payload in payloads}
        assert len(payloads) == len(by_cat)
        assert by_cat == {"posts.read": 2, "user.read": 1}
        assert "connector_response_finish" not in flow.metadata
