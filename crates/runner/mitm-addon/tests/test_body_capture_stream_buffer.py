"""Tests for body capture request and response stream-buffer contracts."""

import base64
import gzip
from typing import NamedTuple

import pytest

import flow_metadata_keys as metadata_keys
from body_capture import add_capture_fields
from body_limits import STREAM_BUFFER_LIMIT
from tests.stream_buffer_helpers import set_request_stream_buffer, set_response_stream_buffer


class _StreamCaptureDirection(NamedTuple):
    body_kind: str
    body_field: str
    encoding_field: str
    truncated_field: str
    raw_body: str


_STREAM_CAPTURE_DIRECTIONS = [
    pytest.param(
        _StreamCaptureDirection(
            body_kind="request",
            body_field="request_body",
            encoding_field="request_body_encoding",
            truncated_field="request_body_truncated",
            raw_body="raw request body",
        ),
        id="request",
    ),
    pytest.param(
        _StreamCaptureDirection(
            body_kind="response",
            body_field="response_body",
            encoding_field="response_body_encoding",
            truncated_field="response_body_truncated",
            raw_body="raw response body",
        ),
        id="response",
    ),
]


def _stream_contract_flow(real_flow):
    return real_flow(
        method="POST",
        host="api.example.com",
        request_content_type="text/plain",
        request_body=b"raw request body",
        response_content_type="text/plain",
        response_body=b"raw response body",
        include_request_id=True,
    )


def _set_stream_capture_metadata(
    flow,
    direction: _StreamCaptureDirection,
    body: bytes,
    *,
    truncated: bool = False,
) -> None:
    if direction.body_kind == "request":
        set_request_stream_buffer(flow, body, truncated=truncated)
    else:
        set_response_stream_buffer(flow, body, truncated=truncated)


class TestBodyCaptureStreamBuffer:
    @pytest.mark.parametrize("direction", _STREAM_CAPTURE_DIRECTIONS)
    def test_absent_stream_capture_uses_raw_body(self, real_flow, direction):
        flow = _stream_contract_flow(real_flow)
        entry = {}
        add_capture_fields(flow, entry)
        assert entry[direction.body_field] == direction.raw_body
        assert entry[direction.encoding_field] == "utf-8"
        assert direction.truncated_field not in entry

    @pytest.mark.parametrize("direction", _STREAM_CAPTURE_DIRECTIONS)
    def test_empty_stream_capture_keeps_body_empty(self, real_flow, direction):
        flow = _stream_contract_flow(real_flow)
        _set_stream_capture_metadata(flow, direction, b"")
        entry = {}
        add_capture_fields(flow, entry)
        assert direction.body_field not in entry
        assert direction.encoding_field not in entry
        assert direction.truncated_field not in entry

    @pytest.mark.parametrize("direction", _STREAM_CAPTURE_DIRECTIONS)
    @pytest.mark.parametrize("truncated", [False, True], ids=["complete", "truncated"])
    def test_non_empty_stream_buffer_preserves_truncation(self, real_flow, direction, truncated):
        flow = _stream_contract_flow(real_flow)
        _set_stream_capture_metadata(
            flow,
            direction,
            b"streamed body",
            truncated=truncated,
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert entry[direction.body_field] == "streamed body"
        assert entry[direction.encoding_field] == "utf-8"
        if truncated:
            assert entry[direction.truncated_field] is True
        else:
            assert direction.truncated_field not in entry

    def test_truncated_request_stream_buffer_trims_incomplete_utf8(self, real_flow):
        body = b"x" * (STREAM_BUFFER_LIMIT - 1) + b"\xe2"
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="text/plain",
            include_request_id=True,
        )
        set_request_stream_buffer(flow, body, truncated=True)
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["request_body"] == "x" * (STREAM_BUFFER_LIMIT - 1)
        assert entry["request_body_encoding"] == "utf-8"
        assert entry["request_body_truncated"] is True

    def test_incomplete_request_stream_buffer_marks_truncation(self, real_flow):
        body = b'{"partial": true}'
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            include_request_id=True,
        )
        set_request_stream_buffer(flow, body, complete=False)
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["request_body"] == '{"partial": true}'
        assert entry["request_body_encoding"] == "utf-8"
        assert entry["request_body_truncated"] is True

    def test_incomplete_request_at_limit_preserves_partial_utf8(self, real_flow):
        body = b"x" * (STREAM_BUFFER_LIMIT - 1) + b"\xe2"
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="text/plain",
            include_request_id=True,
        )
        set_request_stream_buffer(flow, body, complete=False)
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["request_body_encoding"] == "base64"
        assert base64.b64decode(entry["request_body"]) == body
        assert entry["request_body_truncated"] is True

    def test_empty_incomplete_request_stream_buffer_marks_truncation(self, real_flow):
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            include_request_id=True,
        )
        set_request_stream_buffer(flow, b"", complete=False)
        entry = {}
        add_capture_fields(flow, entry)
        assert "request_body" not in entry
        assert "request_body_encoding" not in entry
        assert entry["request_body_truncated"] is True

    @pytest.mark.parametrize(
        ("complete", "expected_truncated"),
        [
            pytest.param(True, False, id="complete"),
            pytest.param(False, True, id="incomplete"),
        ],
    )
    def test_empty_failed_request_stream_decode_omits_encoding(
        self, real_flow, complete, expected_truncated
    ):
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="text/plain",
            request_encoding="compress",
            include_request_id=True,
        )
        set_request_stream_buffer(flow, b"", complete=complete)
        entry = {}
        add_capture_fields(flow, entry)
        assert "request_body" not in entry
        assert "request_body_encoding" not in entry
        if expected_truncated:
            assert entry["request_body_truncated"] is True
        else:
            assert "request_body_truncated" not in entry

    def test_binary_request_stream_buffer_truncated_marks_truncation(self, real_flow):
        body = b"\x00" * STREAM_BUFFER_LIMIT
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/octet-stream",
            include_request_id=True,
        )
        set_request_stream_buffer(flow, body, truncated=True)
        entry = {}
        add_capture_fields(flow, entry)
        assert "request_body" not in entry
        assert entry["request_body_encoding"] == "binary"
        assert entry["request_body_truncated"] is True

    @pytest.mark.parametrize(
        ("complete", "truncated", "expected_truncated"),
        [
            pytest.param(True, True, True, id="truncated-buffer"),
            pytest.param(False, False, True, id="incomplete-stream"),
            pytest.param(True, False, False, id="complete-malformed-body"),
        ],
    )
    def test_failed_request_stream_decode_preserves_capture_completeness(
        self, real_flow, complete, truncated, expected_truncated
    ):
        body = gzip.compress(b"streamed request body")[:-1]
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="text/plain",
            request_encoding="gzip",
            include_request_id=True,
        )
        set_request_stream_buffer(flow, body, complete=complete, truncated=truncated)
        entry = {}
        add_capture_fields(flow, entry)
        assert "request_body" not in entry
        assert entry["request_body_encoding"] == "binary"
        if expected_truncated:
            assert entry["request_body_truncated"] is True
        else:
            assert "request_body_truncated" not in entry

    def test_suppressed_request_body_marks_truncated_without_buffer(self, real_flow):
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            response_content_type="application/json",
            include_request_id=True,
        )
        flow.metadata[metadata_keys.SUPPRESS_REQUEST_BODY_CAPTURE] = True
        entry = {}
        add_capture_fields(flow, entry)
        assert "request_body" not in entry
        assert "request_body_encoding" not in entry
        assert entry["request_body_truncated"] is True

    def test_suppressed_request_body_ignores_retained_stream_body(self, real_flow):
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            response_content_type="application/json",
            include_request_id=True,
        )
        flow.metadata[metadata_keys.SUPPRESS_REQUEST_BODY_CAPTURE] = True
        set_request_stream_buffer(flow, b"hidden")
        entry = {}
        add_capture_fields(flow, entry)
        assert "request_body" not in entry
        assert "request_body_encoding" not in entry
        assert entry["request_body_truncated"] is True

    def test_truncated_response_stream_buffer_trims_incomplete_utf8(self, real_flow):
        body = b"y" * (STREAM_BUFFER_LIMIT - 2) + "𝄞".encode()[:2]
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            response_content_type="text/plain",
            include_request_id=True,
        )
        set_response_stream_buffer(flow, body, truncated=True)
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["response_body"] == "y" * (STREAM_BUFFER_LIMIT - 2)
        assert entry["response_body_encoding"] == "utf-8"
        assert entry["response_body_truncated"] is True

    def test_invalid_stream_boundaries_preserve_truncated_base64(self, real_flow):
        request_body = b"r" * (STREAM_BUFFER_LIMIT - 1) + b"\xff"
        response_body = b"s" * (STREAM_BUFFER_LIMIT - 1) + b"\xf5"
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="text/plain",
            response_content_type="text/plain",
            include_request_id=True,
        )
        set_request_stream_buffer(flow, request_body, truncated=True)
        set_response_stream_buffer(flow, response_body, truncated=True)
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["request_body_encoding"] == "base64"
        assert base64.b64decode(entry["request_body"]) == request_body
        assert entry["request_body_truncated"] is True
        assert entry["response_body_encoding"] == "base64"
        assert base64.b64decode(entry["response_body"]) == response_body
        assert entry["response_body_truncated"] is True

    def test_binary_stream_buffer_exactly_at_limit_not_truncated(self, real_flow):
        body = b"\x00" * STREAM_BUFFER_LIMIT
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            response_content_type="application/octet-stream",
            include_request_id=True,
        )
        set_response_stream_buffer(flow, body)
        entry = {}
        add_capture_fields(flow, entry)
        assert "response_body" not in entry
        assert entry["response_body_encoding"] == "binary"
        assert "response_body_truncated" not in entry

    def test_binary_stream_buffer_truncated_marks_truncation(self, real_flow):
        body = b"\x00" * STREAM_BUFFER_LIMIT
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            response_content_type="application/octet-stream",
            include_request_id=True,
        )
        set_response_stream_buffer(flow, body, truncated=True)
        entry = {}
        add_capture_fields(flow, entry)
        assert "response_body" not in entry
        assert entry["response_body_encoding"] == "binary"
        assert entry["response_body_truncated"] is True

    def test_stream_buffer_gzip_decompressed(self, real_flow):
        """Gzip-compressed stream_buffer should be decompressed for capture."""
        original = b'{"result": "ok"}'
        compressed = gzip.compress(original)
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            include_request_id=True,
            response_content_type="application/json",
            response_encoding="gzip",
        )
        set_response_stream_buffer(flow, compressed)
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["response_body"] == '{"result": "ok"}'
        assert entry["response_body_encoding"] == "utf-8"

    def test_stream_buffer_gzip_empty_body_skips_body(self, real_flow):
        """Bug #10287: a gzip frame that decompresses to b"" must not leak
        the ~20 B compressed framing into ``response_body`` as base64."""
        compressed = gzip.compress(b"")
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            include_request_id=True,
            response_content_type="application/json",
            response_encoding="gzip",
        )
        set_response_stream_buffer(flow, compressed)
        entry = {}
        add_capture_fields(flow, entry)
        assert "response_body" not in entry
        assert "response_body_encoding" not in entry
        assert "response_headers" in entry  # headers still captured

    def test_truncated_stream_buffer_gzip_prefix_marks_truncation(self, real_flow):
        compressed = gzip.compress(b"hello world")[:10]
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            include_request_id=True,
            response_content_type="application/json",
            response_encoding="gzip",
        )
        set_response_stream_buffer(flow, compressed, truncated=True)
        entry = {}
        add_capture_fields(flow, entry)
        assert "response_body" not in entry
        assert "response_body_encoding" not in entry
        assert entry["response_body_truncated"] is True
        assert "response_headers" in entry
