"""X connector response parser integration tests."""

import gzip
import zlib

import brotli
import pytest

import flow_metadata_keys as metadata_keys
import mitm_addon
import response_streaming
from body_limits import LARGE_RESPONSE_DECOMPRESS_LIMIT, STREAM_BUFFER_LIMIT
from tests.flow_helpers import response_stream
from tests.x_flow_helpers import (
    json_body_that_exceeds_x_json_work_limit,
    make_x_response_flow,
)

_OVERSIZED_NDJSON_LINE_BYTES = LARGE_RESPONSE_DECOMPRESS_LIMIT + 1024


class TestBodylessXResponseParserAdmission:
    """Tests HTTP body semantics at the shared connector response parser gate."""

    @pytest.mark.parametrize(
        ("request_method", "response_status", "content_encoding", "path"),
        [
            pytest.param("GET", 204, "", "/2/tweets", id="no-content"),
            pytest.param("GET", 205, "", "/2/tweets", id="reset-content"),
            pytest.param("HEAD", 200, "", "/2/tweets", id="head"),
            pytest.param("CONNECT", 200, "", "/2/tweets", id="successful-connect"),
            pytest.param("GET", 204, "gzip", "/2/tweets", id="gzip"),
            pytest.param("GET", 204, "deflate", "/2/tweets", id="deflate"),
            pytest.param(
                "GET",
                204,
                "",
                "/2/tweets/search/stream",
                id="ndjson-constructor-state",
            ),
        ],
    )
    def test_bodyless_response_skips_parser_and_keeps_byte_accounting(
        self,
        real_flow,
        request_method: str,
        response_status: int,
        content_encoding: str,
        path: str,
    ) -> None:
        flow = make_x_response_flow(
            real_flow,
            path=path,
            response_status=response_status,
            content_encoding=content_encoding,
        )
        flow.request.method = request_method

        mitm_addon.responseheaders(flow)

        assert "connector_response_finish" not in flow.metadata
        assert "connector_response_report_on_interruption" not in flow.metadata
        assert metadata_keys.X_JSON_STATE not in flow.metadata
        assert metadata_keys.X_NDJSON_STATE not in flow.metadata

        unexpected_wire_bytes = b"bodyless-response-wire-bytes"
        assert response_stream(flow)(unexpected_wire_bytes) == unexpected_wire_bytes
        assert flow.metadata[metadata_keys.RESPONSE_STREAM_STATE]["total_bytes"] == len(
            unexpected_wire_bytes
        )

        response_streaming.finalize_connector_response_state(flow)

        assert metadata_keys.X_JSON_STATE not in flow.metadata
        assert metadata_keys.X_NDJSON_STATE not in flow.metadata


class TestNdjsonExtractor:
    """Tests for X NDJSON extraction through responseheaders (issue #9534)."""

    def _stream_flow(self, real_flow, *, capture_body=False):
        flow = make_x_response_flow(real_flow, path="/2/tweets/search/stream")
        if capture_body:
            flow.metadata[metadata_keys.CAPTURE_BODY] = True
        mitm_addon.responseheaders(flow)
        return flow

    def _stream_parser(self, real_flow):
        flow = self._stream_flow(real_flow)
        return response_stream(flow), flow.metadata[metadata_keys.X_NDJSON_STATE]

    def test_single_line(self, real_flow):
        parse, state = self._stream_parser(real_flow)
        parse(b'{"data":{"id":"1"},"includes":{"users":[{"id":"u1"}]}}\n')
        assert state["data_count"] == 1
        assert state["includes"] == {"users": 1}
        assert state["lines_parsed"] == 1
        assert state["lines_failed"] == 0

    def test_multiple_lines_aggregate_counts(self, real_flow):
        parse, state = self._stream_parser(real_flow)
        parse(b'{"data":{"id":"1"},"includes":{"users":[{"id":"u1"}]}}\n')
        parse(b'{"data":{"id":"2"},"includes":{"users":[{"id":"u2"},{"id":"u3"}]}}\n')
        assert state["data_count"] == 2
        assert state["includes"] == {"users": 3}
        assert state["lines_parsed"] == 2

    def test_forensic_buffer_truncation_does_not_stop_parser(self, real_flow):
        flow = self._stream_flow(real_flow, capture_body=True)
        parse = response_stream(flow)
        state = flow.metadata[metadata_keys.X_NDJSON_STATE]

        parse(b'{"data":{"id":"1"}}\n' + b"x" * (200 * 1024))

        assert len(flow.metadata[metadata_keys.STREAM_BUFFER]) == STREAM_BUFFER_LIMIT
        assert flow.metadata[metadata_keys.STREAM_BUFFER_STATE]["truncated"] is True
        assert state["data_count"] == 1
        assert "connector_response_finish" in flow.metadata

    @pytest.mark.parametrize("content_encoding", ["gzip", "br"])
    def test_decompresses_stream_before_parsing(self, real_flow, content_encoding):
        ndjson_body = (
            b'{"data":{"id":"1"},"includes":{"users":[{"id":"u1"}]}}\n'
            b'{"data":{"id":"2"},"includes":{"users":[{"id":"u2"}]}}\n'
            b'{"data":{"id":"3"},"includes":{"users":[{"id":"u3"}]}}\n'
        )
        compressed = (
            gzip.compress(ndjson_body)
            if content_encoding == "gzip"
            else brotli.compress(ndjson_body)
        )
        flow = make_x_response_flow(
            real_flow,
            path="/2/tweets/search/stream",
            content_encoding=content_encoding,
        )

        mitm_addon.responseheaders(flow)

        mid = len(compressed) // 2
        response_stream(flow)(compressed[:mid])
        response_stream(flow)(compressed[mid:])
        state = flow.metadata[metadata_keys.X_NDJSON_STATE]
        assert state["data_count"] == 3
        assert state["includes"] == {"users": 3}
        assert "connector_response_finish" in flow.metadata

    def test_chunked_line_split_mid_json(self, real_flow):
        parse, state = self._stream_parser(real_flow)
        parse(b'{"data":{"id":"1"},"include')
        parse(b's":{"users":[{"id":"u1"}]}}\n')
        assert state["data_count"] == 1
        assert state["includes"] == {"users": 1}
        assert state["lines_parsed"] == 1

    def test_keep_alive_blank_lines(self, real_flow):
        parse, state = self._stream_parser(real_flow)
        parse(b"\n\n")
        parse(b'{"data":{"id":"1"}}\n')
        parse(b"\n")
        parse(b'{"data":{"id":"2"}}\n')
        assert state["data_count"] == 2
        assert state["lines_parsed"] == 2

    def test_crlf_line_endings(self, real_flow):
        parse, state = self._stream_parser(real_flow)
        parse(b'{"data":{"id":"1"}}\r\n{"data":{"id":"2"}}\r\n')
        assert state["data_count"] == 2
        assert state["lines_parsed"] == 2

    def test_crlf_line_ending_split_across_chunks(self, real_flow):
        parse, state = self._stream_parser(real_flow)
        parse(b'{"data":{"id":"1"}}\r')
        parse(b'\n{"data":{"id":"2"}}\r\n')
        assert state["data_count"] == 2
        assert state["lines_parsed"] == 2
        assert state["lines_failed"] == 0

    def test_malformed_line_increments_failures(self, real_flow):
        parse, state = self._stream_parser(real_flow)
        parse(b'{"data":{"id":"1"}}\n')
        parse(b"not json at all\n")
        parse(b'{"data":{"id":"2"}}\n')
        assert state["data_count"] == 2
        assert state["lines_parsed"] == 2
        assert state["lines_failed"] == 1

    @pytest.mark.parametrize(
        "failed_line",
        [
            pytest.param(
                b'{"data":{"id":"blocked"},"includes":{"users":[{},{},{}]},'
                b'"matching_rules":[' + b",".join([b"0"] * 40_000) + b"]}",
                id="dense-array",
            ),
            pytest.param(
                json_body_that_exceeds_x_json_work_limit(),
                id="dense-objects",
            ),
        ],
    )
    @pytest.mark.parametrize("split_failed_row", [False, True], ids=["one-chunk", "split-row"])
    def test_work_limited_line_forwards_and_recovers(
        self,
        real_flow,
        failed_line,
        split_failed_row,
    ):
        parse, state = self._stream_parser(real_flow)
        valid_line = b'{"data":{"id":"after"},"includes":{"users":[{}]}}\n'
        body = failed_line + b"\n" + valid_line
        chunks = (
            [body]
            if not split_failed_row
            else [body[:37], body[37 : len(failed_line) + 1], valid_line]
        )

        for chunk in chunks:
            assert parse(chunk) == chunk

        assert state["lines_failed"] == 1
        assert state["lines_parsed"] == 1
        assert state["data_count"] == 1
        assert state["includes"] == {"users": 1}

    def test_byte_cap_line_with_bulk_discarded_string_is_accepted(self, real_flow):
        parse, state = self._stream_parser(real_flow)
        prefix = b'{"data":{"id":"1"},"discarded":"'
        suffix = b'"}'
        line = (
            prefix + b"x" * (LARGE_RESPONSE_DECOMPRESS_LIMIT - len(prefix) - len(suffix)) + suffix
        )
        body = line + b"\n"

        assert len(line) == LARGE_RESPONSE_DECOMPRESS_LIMIT
        assert parse(body) == body
        assert state["lines_failed"] == 0
        assert state["lines_parsed"] == 1
        assert state["data_count"] == 1

    def test_invalid_utf8_line_increments_failures_and_continues(self, real_flow):
        parse, state = self._stream_parser(real_flow)
        parse(b'\x80{"data":{"id":"bad"}}\n{"data":{"id":"after"}}\n')

        assert state["data_count"] == 1
        assert state["lines_parsed"] == 1
        assert state["lines_failed"] == 1

    def test_truncated_trailing_line_not_counted(self, real_flow):
        """Connection drops mid-line — partial trailing line stays in buf, not counted."""
        parse, state = self._stream_parser(real_flow)
        parse(b'{"data":{"id":"1"}}\n{"data":{"id":"2"}')  # no trailing \n
        assert state["data_count"] == 1
        assert state["lines_parsed"] == 1

    def test_complete_trailing_line_without_newline_counted_on_finish(self, real_flow):
        flow = self._stream_flow(real_flow)
        parse = response_stream(flow)
        state = flow.metadata[metadata_keys.X_NDJSON_STATE]

        parse(b'{"data":{"id":"1"},"includes":{"users":[{"id":"u1"}]}}')
        response_streaming.finalize_connector_response_state(flow)

        assert state["data_count"] == 1
        assert state["includes"] == {"users": 1}
        assert state["lines_parsed"] == 1
        assert state["lines_failed"] == 0

    def test_incomplete_trailing_line_without_newline_fails_on_finish(self, real_flow):
        flow = self._stream_flow(real_flow)
        parse = response_stream(flow)
        state = flow.metadata[metadata_keys.X_NDJSON_STATE]

        parse(b'{"data":{"id":"1"}}\n{"data":{"id":"2"}')
        response_streaming.finalize_connector_response_state(flow)

        assert state["data_count"] == 1
        assert state["lines_parsed"] == 1
        assert state["lines_failed"] == 1

    @pytest.mark.parametrize("tail", [b"", b"\r", b"\r\r"])
    def test_blank_trailing_line_ignored_on_finish(self, real_flow, tail):
        flow = self._stream_flow(real_flow)
        parse = response_stream(flow)
        state = flow.metadata[metadata_keys.X_NDJSON_STATE]

        parse(b'{"data":{"id":"1"}}\n' + tail)
        response_streaming.finalize_connector_response_state(flow)

        assert state["data_count"] == 1
        assert state["lines_parsed"] == 1
        assert state["lines_failed"] == 0

    def test_trailing_line_finish_is_idempotent(self, real_flow):
        flow = self._stream_flow(real_flow)
        parse = response_stream(flow)
        state = flow.metadata[metadata_keys.X_NDJSON_STATE]

        parse(b'{"data":{"id":"1"}}')
        response_streaming.finalize_connector_response_state(flow)
        finalized = dict(state)
        finalized["includes"] = dict(state["includes"])
        response_streaming.finalize_connector_response_state(flow)

        assert state == finalized

    def test_oversized_line_tail_not_counted_on_finish(self, real_flow):
        flow = self._stream_flow(real_flow)
        parse = response_stream(flow)
        state = flow.metadata[metadata_keys.X_NDJSON_STATE]
        big = b"x" * _OVERSIZED_NDJSON_LINE_BYTES

        parse(big)
        parse(b'{"data":{"id":"tail"}}')
        response_streaming.finalize_connector_response_state(flow)

        assert state["data_count"] == 0
        assert state["lines_parsed"] == 0
        assert state["lines_failed"] == 1

    def test_empty_chunks_safe(self, real_flow):
        parse, state = self._stream_parser(real_flow)
        parse(b"")
        parse(b'{"data":{"id":"1"}}\n')
        parse(b"")
        assert state["data_count"] == 1

    def test_oversized_line_dropped(self, real_flow):
        """Oversized line is dropped; subsequent lines parse normally."""
        parse, state = self._stream_parser(real_flow)
        big = b"x" * _OVERSIZED_NDJSON_LINE_BYTES
        parse(big)
        parse(b"\n")
        parse(b'{"data":{"id":"after"}}\n')
        assert state["data_count"] == 1
        assert state["lines_parsed"] == 1
        assert state["lines_failed"] == 1

    def test_oversized_line_discards_until_newline(self, real_flow):
        """A valid-looking tail of an overlong line must not be counted as its own row."""
        parse, state = self._stream_parser(real_flow)
        big = b"x" * _OVERSIZED_NDJSON_LINE_BYTES
        parse(big)
        parse(b'{"data":{"id":"tail"}}\n')
        parse(b'{"data":{"id":"next"}}\n')

        assert state["data_count"] == 1
        assert state["lines_parsed"] == 1
        assert state["lines_failed"] == 1

    def test_oversized_line_with_newline_continues_in_same_chunk(self, real_flow):
        """Dropping an overlong row should not discard valid later rows in the same chunk."""
        parse, state = self._stream_parser(real_flow)
        big = b"x" * _OVERSIZED_NDJSON_LINE_BYTES
        parse(big + b'\n{"data":{"id":"after"}}\n')

        assert state["data_count"] == 1
        assert state["lines_parsed"] == 1
        assert state["lines_failed"] == 1

    def test_includes_multiple_keys(self, real_flow):
        parse, state = self._stream_parser(real_flow)
        parse(
            b'{"data":{"id":"1"},"includes":'
            b'{"users":[{"id":"u1"}],'
            b'"tweets":[{"id":"t1"},{"id":"t2"}],'
            b'"media":[{"id":"m1"}]}}\n'
        )
        assert state["includes"] == {"users": 1, "tweets": 2, "media": 1}

    def test_unknown_include_keys_are_bounded_and_known_keys_continue(self, real_flow):
        parse, state = self._stream_parser(real_flow)

        for index in range(70):
            parse(
                b'{"data":{"id":"'
                + str(index).encode()
                + b'"},"includes":{"future_'
                + str(index).encode()
                + b'":[{"id":"u"}]}}\n'
            )
        parse(b'{"data":{"id":"known"},"includes":{"users":[{"id":"user"}]}}\n')

        unknown_keys = [key for key in state["includes"] if key.startswith("future_")]
        assert len(unknown_keys) == 64
        assert state["unknown_includes_overflow_count"] == 6
        assert state["includes"]["users"] == 1
        assert state["data_count"] == 71
        assert state["lines_failed"] == 0

    def test_unsafe_unknown_include_keys_overflow(self, real_flow):
        parse, state = self._stream_parser(real_flow)
        overlong_key = b"x" * 92

        parse(
            b'{"data":{"id":"1"},"includes":{"'
            + overlong_key
            + b'":[{"id":"long"}],"bad/key":[{"id":"one"},{"id":"two"}],'
            b'"__overflow__":[{"id":"reserved"}]}}\n'
        )

        assert state["includes"] == {}
        assert state["unknown_includes_overflow_count"] == 4
        assert state["data_count"] == 1
        assert state["lines_failed"] == 0

    def test_data_array_not_counted(self, real_flow):
        """Line where top-level ``data`` is an array (not a dict) contributes 0 to data_count."""
        parse, state = self._stream_parser(real_flow)
        parse(b'{"data":[1,2,3]}\n')
        assert state["data_count"] == 0
        assert state["lines_parsed"] == 1

    def test_non_dict_top_level_skipped(self, real_flow):
        parse, state = self._stream_parser(real_flow)
        parse(b'"some string"\n')
        parse(b"42\n")
        parse(b'{"data":{"id":"1"}}\n')
        assert state["lines_parsed"] == 3
        assert state["data_count"] == 1


class TestXJsonFinalize:
    """Tests for finalizing non-streaming X JSON parser state."""

    def _billable_x_json_flow(self, real_flow):
        return make_x_response_flow(real_flow)

    def test_no_registered_x_json_finalizer_is_noop(self, real_flow):
        flow = real_flow(with_response=False, host="api.x.com", path="/2/tweets")

        response_streaming.finalize_connector_response_state(flow)

        assert metadata_keys.X_JSON_STATE not in flow.metadata

    def test_finalizes_successful_x_json_state(self, real_flow):
        flow = self._billable_x_json_flow(real_flow)
        mitm_addon.responseheaders(flow)
        assert "connector_response_finish" in flow.metadata

        response_stream(flow)(b'{"data":[{"id":"1"}]}')
        response_streaming.finalize_connector_response_state(flow)

        state = dict(flow.metadata[metadata_keys.X_JSON_STATE])
        assert "connector_response_finish" not in flow.metadata
        assert state["body_parsed"] is True
        assert state["response_data_count"] == 1
        assert "parse_error" not in state

        response_streaming.finalize_connector_response_state(flow)
        assert flow.metadata[metadata_keys.X_JSON_STATE] == state

    def test_finalizes_x_json_state_without_negative_counts(self, real_flow):
        flow = self._billable_x_json_flow(real_flow)
        mitm_addon.responseheaders(flow)

        response_stream(flow)(
            b'{"data":[{"id":"1"}],"meta":{"result_count":-1,"total_tweet_count":-2}}'
        )
        response_streaming.finalize_connector_response_state(flow)

        state = flow.metadata[metadata_keys.X_JSON_STATE]
        assert state["body_parsed"] is True
        assert state["body_truncated"] is False
        assert state["response_data_count"] == 1
        assert "response_result_count" not in state
        assert "response_total_tweet_count" not in state

    def test_protocol_shaped_data_array_stays_within_work_limit(self, real_flow):
        flow = self._billable_x_json_flow(real_flow)
        data_item = b'{"id":"123456"}'
        body = b'{"data":[' + b",".join([data_item] * 3_600) + b"]}"

        mitm_addon.responseheaders(flow)
        assert response_stream(flow)(body) == body
        response_streaming.finalize_connector_response_state(flow)

        state = flow.metadata[metadata_keys.X_JSON_STATE]
        assert state["body_parsed"] is True
        assert state["body_truncated"] is False
        assert state["response_data_count"] == 3_600
        assert "parse_error" not in state

    @pytest.mark.parametrize(
        "chunk_size",
        [
            pytest.param(2, id="two-byte"),
            pytest.param(None, id="whole-body"),
        ],
    )
    def test_escaped_discarded_strings_stay_within_work_limit_across_chunks(
        self,
        real_flow,
        chunk_size,
    ):
        discarded_property = b',"' + b"k" * 26 + b'":"q\\"s\\\\"'
        body = b'{"data":[{"id":"1"}]' + discarded_property * 13_104 + b"}   "
        assert len(body) == 497_976
        resolved_chunk_size = len(body) if chunk_size is None else chunk_size
        flow = self._billable_x_json_flow(real_flow)

        mitm_addon.responseheaders(flow)
        callback = response_stream(flow)
        for offset in range(0, len(body), resolved_chunk_size):
            chunk = body[offset : offset + resolved_chunk_size]
            assert callback(chunk) == chunk
        response_streaming.finalize_connector_response_state(flow)

        state = flow.metadata[metadata_keys.X_JSON_STATE]
        assert state["body_parsed"] is True
        assert state["body_truncated"] is False
        assert state["response_data_count"] == 1
        assert "parse_error" not in state

    def test_x_json_work_limit_discards_partial_state_and_next_flow_recovers(self, real_flow):
        body = json_body_that_exceeds_x_json_work_limit()
        flow = self._billable_x_json_flow(real_flow)
        mitm_addon.responseheaders(flow)
        callback = response_stream(flow)
        midpoint = len(body) // 2

        assert callback(body[:midpoint]) == body[:midpoint]
        assert callback(body[midpoint:]) == body[midpoint:]
        response_streaming.finalize_connector_response_state(flow)

        state = dict(flow.metadata[metadata_keys.X_JSON_STATE])
        assert state["body_parsed"] is False
        assert state["body_truncated"] is False
        assert state["parse_error"] == "work limit exceeded"
        assert "response_data_count" not in state
        assert "resource_identities" not in state
        response_streaming.finalize_connector_response_state(flow)
        assert flow.metadata[metadata_keys.X_JSON_STATE] == state

        next_flow = self._billable_x_json_flow(real_flow)
        mitm_addon.responseheaders(next_flow)
        response_stream(next_flow)(b'{"data":[{"id":"after"}]}')
        response_streaming.finalize_connector_response_state(next_flow)

        next_state = next_flow.metadata[metadata_keys.X_JSON_STATE]
        assert next_state["body_parsed"] is True
        assert next_state["body_truncated"] is False
        assert next_state["response_data_count"] == 1
        assert "parse_error" not in next_state

    def test_forensic_buffer_truncation_does_not_stop_x_json_parser(self, real_flow):
        flow = make_x_response_flow(
            real_flow,
            path="/2/users/by",
            original_url="https://api.x.com/2/users/by?ids=1,2,3",
        )
        flow.metadata[metadata_keys.CAPTURE_BODY] = True
        mitm_addon.responseheaders(flow)

        callback = response_stream(flow)
        callback(b'{"data":[{"id":"1","text":"')
        callback(b"x" * (200 * 1024))
        callback(
            b'"}],"includes":{"users":[{"id":"u1"}]},'
            b'"meta":{"result_count":1,"total_tweet_count":2}}'
        )
        response_streaming.finalize_connector_response_state(flow)

        assert len(flow.metadata[metadata_keys.STREAM_BUFFER]) == STREAM_BUFFER_LIMIT
        assert flow.metadata[metadata_keys.STREAM_BUFFER_STATE]["truncated"] is True
        assert metadata_keys.X_NDJSON_STATE not in flow.metadata
        state = flow.metadata[metadata_keys.X_JSON_STATE]
        assert state["body_parsed"] is True
        assert state["response_data_count"] == 1
        assert state["response_includes"] == {"users": 1}
        assert state["response_result_count"] == 1
        assert state["response_total_tweet_count"] == 2

    def test_decompresses_gzip_x_json_before_parsing(self, real_flow):
        body = (
            b'{"data":[{"id":"1"},{"id":"2"}],'
            b'"includes":{"users":[{"id":"u1"}]},'
            b'"meta":{"result_count":2,"total_tweet_count":3}}'
        )
        flow = make_x_response_flow(real_flow, content_encoding="gzip")

        mitm_addon.responseheaders(flow)

        response_stream(flow)(gzip.compress(body))
        response_streaming.finalize_connector_response_state(flow)
        state = flow.metadata[metadata_keys.X_JSON_STATE]
        assert state["response_data_count"] == 2
        assert state["response_includes"] == {"users": 1}
        assert state["response_result_count"] == 2
        assert state["response_total_tweet_count"] == 3

    @pytest.mark.parametrize("encoding", ["gzip", "deflate"])
    def test_concatenated_zlib_x_json_feeds_later_members(self, real_flow, encoding):
        body = (
            b'{"data":[{"id":"1"},{"id":"2"}],'
            b'"includes":{"users":[{"id":"u1"}]},'
            b'"meta":{"result_count":2,"total_tweet_count":3}}'
        )
        if encoding == "gzip":
            compressed = gzip.compress(b"") + gzip.compress(body)
        else:
            compressed = zlib.compress(b"") + zlib.compress(body)
        flow = make_x_response_flow(real_flow, content_encoding=encoding)

        mitm_addon.responseheaders(flow)
        response_stream(flow)(compressed)
        response_streaming.finalize_connector_response_state(flow)

        state = flow.metadata[metadata_keys.X_JSON_STATE]
        assert state["body_parsed"] is True
        assert state["response_data_count"] == 2
        assert state["response_includes"] == {"users": 1}
        assert state["response_result_count"] == 2
        assert state["response_total_tweet_count"] == 3

    def test_finalizes_x_json_parse_error(self, real_flow):
        flow = self._billable_x_json_flow(real_flow)
        mitm_addon.responseheaders(flow)
        assert "connector_response_finish" in flow.metadata

        response_stream(flow)(b'{"data":[1')
        response_streaming.finalize_connector_response_state(flow)

        state = dict(flow.metadata[metadata_keys.X_JSON_STATE])
        assert "connector_response_finish" not in flow.metadata
        assert state["body_parsed"] is False
        assert isinstance(state["parse_error"], str)
        assert state["parse_error"]

        response_streaming.finalize_connector_response_state(flow)
        assert flow.metadata[metadata_keys.X_JSON_STATE] == state

    def test_finalizes_non_object_x_json_without_parse_error(self, real_flow):
        flow = self._billable_x_json_flow(real_flow)
        mitm_addon.responseheaders(flow)
        assert "connector_response_finish" in flow.metadata

        response_stream(flow)(b"[1,2,3]")
        response_streaming.finalize_connector_response_state(flow)

        state = flow.metadata[metadata_keys.X_JSON_STATE]
        assert "connector_response_finish" not in flow.metadata
        assert state["body_parsed"] is False
        assert "parse_error" not in state
