"""Tests for ordinary request and response body capture fields."""

import base64
import gzip
import zlib

import brotli
import pytest
import zstandard

from body_capture import add_capture_fields
from body_limits import BODY_CAPTURE_LIMIT
from tests.body_decode_helpers import pseudo_random_ascii, track_zstd_decompressor


def _track_zlib_max_input(monkeypatch) -> dict[str, int]:
    real_factory = zlib.decompressobj
    stats = {"max_input": 0}

    class TrackingDecompressionObj:
        def __init__(self, wrapped):
            self._wrapped = wrapped

        def decompress(self, chunk, *args, **kwargs):
            stats["max_input"] = max(stats["max_input"], len(chunk))
            return self._wrapped.decompress(chunk, *args, **kwargs)

        @property
        def eof(self):
            return self._wrapped.eof

        @property
        def unconsumed_tail(self):
            return self._wrapped.unconsumed_tail

    def factory(*args, **kwargs):
        return TrackingDecompressionObj(real_factory(*args, **kwargs))

    monkeypatch.setattr("body_decoding.zlib.decompressobj", factory)
    return stats


class TestAddCaptureFields:
    def test_captures_request_body(self, real_flow):
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            response_content_type="application/json",
            include_request_id=True,
            request_body=b'{"prompt": "hello"}',
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["request_body"] == '{"prompt": "hello"}'
        assert entry["request_body_encoding"] == "utf-8"
        assert "request_body_truncated" not in entry

    def test_captures_response_body(self, real_flow):
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            response_content_type="application/json",
            include_request_id=True,
            response_body=b'{"result": "ok"}',
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["response_body"] == '{"result": "ok"}'
        assert entry["response_body_encoding"] == "utf-8"

    def test_captures_structured_json_response_without_preserving_header_value(self, real_flow):
        flow = real_flow(
            method="POST",
            host="api.example.com",
            response_body=b'{"title": "Invalid request"}',
            response_content_type="application/problem+json",
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["response_body"] == '{"title": "Invalid request"}'
        assert entry["response_body_encoding"] == "utf-8"
        assert entry["response_headers"]["Content-Type"] == "***"

    def test_captures_request_headers(self, real_flow):
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            response_content_type="application/json",
            include_request_id=True,
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert "request_headers" in entry
        assert entry["request_headers"]["Content-Type"] == "application/json"
        assert entry["request_headers"]["Host"] == "***"

    def test_captures_response_headers(self, real_flow):
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            response_content_type="application/json",
            include_request_id=True,
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert "response_headers" in entry
        assert entry["response_headers"]["Content-Type"] == "application/json"
        assert entry["response_headers"]["X-Request-Id"] == "***"

    def test_captured_non_allowlisted_headers_are_redacted(self, real_flow, headers):
        flow = real_flow(
            method="GET",
            host="api.example.com",
            request_headers=headers(
                ("Host", "api.example.com"),
                ("Referer", "https://app.example/page?token=secret#fragment"),
            ),
            response_headers=headers(
                ("Location", "https://client.example/callback?code=secret#fragment"),
            ),
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["request_headers"]["Host"] == "***"
        assert entry["request_headers"]["Referer"] == "***"
        assert entry["response_headers"]["Location"] == "***"

    def test_captured_content_type_values_are_sanitized(self, real_flow, headers):
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_headers=headers(
                ("Host", "api.example.com"),
                ("Content-Type", 'application/json; profile="https://app.example/secret"'),
            ),
            response_headers=headers(
                ("Content-Type", "application/x-secret-token"),
            ),
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["request_headers"]["Content-Type"] == "application/json"
        assert entry["response_headers"]["Content-Type"] == "***"

    def test_captured_invalid_header_names_are_redacted(self, real_flow, headers):
        flow = real_flow(
            method="GET",
            host="api.example.com",
            request_headers=headers(
                ("X-Bad\r\nInjected: secret", "application/json"),
            ),
            response_headers=headers(
                ("X-" + ("a" * 300), "gzip"),
            ),
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["request_headers"] == {"[redacted-header-name]": "***"}
        assert entry["response_headers"] == {"[redacted-header-name]": "***"}

    def test_response_headers_redacts_sensitive(self, real_flow, headers):
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            response_content_type="application/json",
            include_request_id=True,
        )
        flow.response.headers = headers(
            ("Set-Cookie", "session=abc"),
            ("Content-Type", "text/html"),
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["response_headers"]["Set-Cookie"] == "***"
        assert entry["response_headers"]["Content-Type"] == "text/html"

    def test_no_response_headers_when_no_response(self, real_flow):
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            response_content_type="application/json",
            include_request_id=True,
            with_response=False,
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert "response_headers" not in entry

    def test_truncates_large_request_body(self, real_flow):
        body = b"x" * (BODY_CAPTURE_LIMIT + 1000)
        flow = real_flow(
            method="POST",
            host="api.example.com",
            response_content_type="application/json",
            include_request_id=True,
            request_body=body,
            request_content_type="text/plain",
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["request_body_truncated"] is True
        assert len(entry["request_body"]) == BODY_CAPTURE_LIMIT

    def test_request_gzip_zip_bomb_capped_without_full_content_decode(self, real_flow, monkeypatch):
        original = b"x" * (BODY_CAPTURE_LIMIT + 4096)
        compressed = gzip.compress(original)
        assert len(compressed) < BODY_CAPTURE_LIMIT
        flow = real_flow(
            method="POST",
            host="api.example.com",
            response_content_type="application/json",
            include_request_id=True,
            request_body=compressed,
            request_content_type="text/plain",
            request_encoding="gzip",
            response_body=b"ok",
        )

        def fail_full_decode(*_args, **_kwargs):
            raise AssertionError("request capture must not access flow.request.content")

        monkeypatch.setattr(flow.request, "get_content", fail_full_decode)

        entry = {}
        add_capture_fields(flow, entry)

        assert entry["request_body_truncated"] is True
        assert len(entry["request_body"]) == BODY_CAPTURE_LIMIT
        assert set(entry["request_body"]) == {"x"}

    def test_request_gzip_exact_limit_not_truncated(self, real_flow):
        original = b"x" * BODY_CAPTURE_LIMIT
        compressed = gzip.compress(original)
        assert len(compressed) < BODY_CAPTURE_LIMIT
        flow = real_flow(
            method="POST",
            host="api.example.com",
            response_content_type="application/json",
            include_request_id=True,
            request_body=compressed,
            request_content_type="text/plain",
            request_encoding="gzip",
            response_body=b"ok",
        )
        entry = {}
        add_capture_fields(flow, entry)

        assert "request_body_truncated" not in entry
        assert len(entry["request_body"]) == BODY_CAPTURE_LIMIT

    def test_truncates_large_response_body(self, real_flow):
        body = b"y" * (BODY_CAPTURE_LIMIT + 1000)
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            include_request_id=True,
            response_body=body,
            response_content_type="text/plain",
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["response_body_truncated"] is True
        assert len(entry["response_body"]) == BODY_CAPTURE_LIMIT

    def test_no_body_fields_when_empty(self, real_flow):
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            response_content_type="application/json",
            include_request_id=True,
            request_body=None,
            response_body=None,
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert "request_body" not in entry
        assert "request_body_encoding" not in entry  # no body = no encoding
        assert "response_body" not in entry
        assert "response_body_encoding" not in entry  # no body = no encoding
        assert "request_headers" in entry  # headers always captured
        assert "response_headers" in entry  # headers captured despite empty body

    def test_request_body_gzip_empty_skips_body_and_captures_response(self, real_flow):
        compressed = gzip.compress(b"")
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            response_content_type="application/json",
            include_request_id=True,
            request_body=compressed,
            request_encoding="gzip",
            response_body=b'{"ok": true}',
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert "request_body" not in entry
        assert "request_body_encoding" not in entry
        assert "request_headers" in entry
        assert entry["response_body"] == '{"ok": true}'
        assert entry["response_body_encoding"] == "utf-8"

    def test_request_body_invalid_gzip_is_hidden_as_binary(self, real_flow):
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="text/plain",
            request_encoding="gzip",
            request_body=b"not gzip at all",
            response_content_type="application/json",
            response_body=b'{"ok": true}',
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert "request_body" not in entry
        assert entry["request_body_encoding"] == "binary"

    def test_request_body_incomplete_gzip_is_hidden_as_binary(self, real_flow):
        body = b"hello request body" * 100
        compressed = gzip.compress(body)
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="text/plain",
            request_encoding="gzip",
            request_body=compressed[:-1],
            response_content_type="application/json",
            response_body=b'{"ok": true}',
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert "request_body" not in entry
        assert entry["request_body_encoding"] == "binary"

    def test_request_body_unknown_content_encoding_is_hidden_as_binary(self, real_flow):
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="text/plain",
            request_encoding="x-custom",
            request_body=b"opaque request body",
            response_content_type="application/json",
            response_body=b'{"ok": true}',
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert "request_body" not in entry
        assert entry["request_body_encoding"] == "binary"

    def test_response_decompression_error_skips_body(self, real_flow):
        # Content-Encoding: gzip + non-gzip bytes makes the bounded capture
        # decoder fail, which add_capture_fields is expected to hide.
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            response_content_type="application/json",
            include_request_id=True,
            request_body=b"ok",
            response_body=b"not gzip at all",
            response_encoding="gzip",
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert "request_body" in entry  # request body still captured
        assert "response_headers" in entry  # headers captured before body access
        assert "response_body" not in entry  # response body skipped
        assert entry["response_body_encoding"] == "binary"  # marked as binary

    def test_response_unsupported_encoding_skips_body(self, real_flow):
        flow = real_flow(
            method="POST",
            host="api.example.com",
            response_content_type="text/plain",
            response_body=b"opaque response body",
            response_encoding="x-custom",
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert "response_body" not in entry
        assert entry["response_body_encoding"] == "binary"

    @pytest.mark.parametrize("encoding", ["gzip", "deflate"])
    def test_response_preserves_mitmproxy_compatible_zlib_variants(self, real_flow, encoding):
        body = b"compatible response body"
        if encoding == "gzip":
            compressed = zlib.compress(body)
        else:
            compressor = zlib.compressobj(wbits=-zlib.MAX_WBITS)
            compressed = compressor.compress(body) + compressor.flush()
        flow = real_flow(
            method="POST",
            host="api.example.com",
            response_content_type="text/plain",
            response_body=compressed,
            response_encoding=encoding,
        )

        entry = {}
        add_capture_fields(flow, entry)

        assert entry["response_body"] == body.decode()
        assert entry["response_body_encoding"] == "utf-8"

    def test_response_large_gzip_bounds_compressed_input_chunks(self, real_flow, monkeypatch):
        body = pseudo_random_ascii(BODY_CAPTURE_LIMIT * 4)
        compressed = gzip.compress(body)
        assert len(compressed) > 1024
        stats = _track_zlib_max_input(monkeypatch)
        flow = real_flow(
            method="POST",
            host="api.example.com",
            response_content_type="text/plain",
            response_body=compressed,
            response_encoding="gzip",
        )

        entry = {}
        add_capture_fields(flow, entry)

        assert entry["response_body_truncated"] is True
        assert len(entry["response_body"]) == BODY_CAPTURE_LIMIT
        assert stats["max_input"] <= 1024

    def test_response_incomplete_brotli_skips_body(self, real_flow):
        body = b"incomplete response body" * 100
        flow = real_flow(
            method="POST",
            host="api.example.com",
            response_content_type="text/plain",
            response_body=brotli.compress(body)[:-1],
            response_encoding="br",
        )

        entry = {}
        add_capture_fields(flow, entry)

        assert "response_body" not in entry
        assert entry["response_body_encoding"] == "binary"

    def test_response_incomplete_zstd_frame_skips_body(self, real_flow):
        compressed = zstandard.ZstdCompressor().compress(b"incomplete response body")
        flow = real_flow(
            method="POST",
            host="api.example.com",
            response_content_type="text/plain",
            response_body=compressed[:-1],
            response_encoding="zstd",
        )

        entry = {}
        add_capture_fields(flow, entry)

        assert "response_body" not in entry
        assert entry["response_body_encoding"] == "binary"

    def test_response_incomplete_trailing_zstd_frame_skips_body(self, real_flow):
        compressor = zstandard.ZstdCompressor()
        compressed = (
            compressor.compress(b"first response frame")
            + compressor.compress(b"incomplete trailing frame")[:-1]
        )
        flow = real_flow(
            method="POST",
            host="api.example.com",
            response_content_type="text/plain",
            response_body=compressed,
            response_encoding="zstd",
        )

        entry = {}
        add_capture_fields(flow, entry)

        assert "response_body" not in entry
        assert entry["response_body_encoding"] == "binary"

    def test_response_zstd_concatenated_frames_capture_all_frames(self, real_flow):
        first = b"first response frame"
        second = b" and second response frame"
        compressor = zstandard.ZstdCompressor()
        compressed = compressor.compress(first) + compressor.compress(second)
        flow = real_flow(
            method="POST",
            host="api.example.com",
            response_content_type="text/plain",
            response_body=compressed,
            response_encoding="zstd",
        )

        entry = {}
        add_capture_fields(flow, entry)

        assert entry["response_body"] == (first + second).decode()
        assert entry["response_body_encoding"] == "utf-8"

    def test_response_zstd_trailing_garbage_skips_body(self, real_flow):
        compressed = zstandard.ZstdCompressor().compress(b"response body")
        flow = real_flow(
            method="POST",
            host="api.example.com",
            response_content_type="text/plain",
            response_body=compressed + b"garbage",
            response_encoding="zstd",
        )

        entry = {}
        add_capture_fields(flow, entry)

        assert "response_body" not in entry
        assert entry["response_body_encoding"] == "binary"

    def test_response_zstd_zip_bomb_bounds_decoded_output(self, real_flow, monkeypatch):
        compressed = zstandard.ZstdCompressor().compress(b"x" * (BODY_CAPTURE_LIMIT * 4))
        stats = track_zstd_decompressor(monkeypatch, BODY_CAPTURE_LIMIT + 1)
        flow = real_flow(
            method="POST",
            host="api.example.com",
            response_content_type="text/plain",
            response_body=compressed,
            response_encoding="zstd",
        )

        entry = {}
        add_capture_fields(flow, entry)

        assert entry["response_body_truncated"] is True
        assert len(entry["response_body"]) == BODY_CAPTURE_LIMIT
        assert 0 < stats["max_output_request"] <= BODY_CAPTURE_LIMIT + 1
        assert stats["output_bytes"] == BODY_CAPTURE_LIMIT + 1

    def test_request_decompression_error_marks_body_binary(self, real_flow):
        # Request capture decodes the captured stream buffer or raw_content with the
        # bounded helper. Malformed gzip returns None, so add_capture_fields marks the
        # body binary without accessing flow.request.content.
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            response_content_type="application/json",
            include_request_id=True,
            request_body=b"not gzip at all",
            request_encoding="gzip",
            response_body=b"ok",
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert "request_body" not in entry  # body skipped
        assert entry["request_body_encoding"] == "binary"  # marked as binary
        assert "request_headers" in entry  # headers still captured
        assert "response_body" in entry  # response unaffected

    def test_request_unsupported_encoding_marks_body_binary(self, real_flow):
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="text/plain",
            request_encoding="x-custom",
            response_content_type="application/json",
            include_request_id=True,
            request_body=b"opaque",
            response_body=b"ok",
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert "request_body" not in entry
        assert entry["request_body_encoding"] == "binary"

    def test_binary_request_body_marks_encoding(self, real_flow):
        flow = real_flow(
            method="POST",
            host="api.example.com",
            response_content_type="application/json",
            include_request_id=True,
            request_body=b"\x89PNG\r\n",
            request_content_type="image/png",
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert "request_body" not in entry
        assert entry["request_body_encoding"] == "binary"
        assert "request_body_truncated" not in entry
        assert "request_headers" in entry  # headers still captured

    def test_large_binary_request_body_marks_truncated(self, real_flow):
        flow = real_flow(
            method="POST",
            host="api.example.com",
            response_content_type="application/json",
            include_request_id=True,
            request_body=b"\x89PNG" + b"\x00" * BODY_CAPTURE_LIMIT,
            request_content_type="image/png",
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert "request_body" not in entry
        assert entry["request_body_encoding"] == "binary"
        assert entry["request_body_truncated"] is True
        assert "request_headers" in entry

    def test_binary_response_body_marks_encoding(self, real_flow):
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            include_request_id=True,
            response_body=b"\x00\x01\x02",
            response_content_type="application/octet-stream",
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert "response_body" not in entry
        assert entry["response_body_encoding"] == "binary"
        assert "response_body_truncated" not in entry

    def test_large_binary_response_body_marks_truncated(self, real_flow):
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            include_request_id=True,
            response_body=b"\x00" * (BODY_CAPTURE_LIMIT + 1),
            response_content_type="application/octet-stream",
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert "response_body" not in entry
        assert entry["response_body_encoding"] == "binary"
        assert entry["response_body_truncated"] is True

    def test_request_body_exactly_at_limit_not_truncated(self, real_flow):
        body = b"x" * BODY_CAPTURE_LIMIT
        flow = real_flow(
            method="POST",
            host="api.example.com",
            response_content_type="application/json",
            include_request_id=True,
            request_body=body,
            request_content_type="text/plain",
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert "request_body_truncated" not in entry
        assert len(entry["request_body"]) == BODY_CAPTURE_LIMIT

    def test_response_body_exactly_at_limit_not_truncated(self, real_flow):
        body = b"y" * BODY_CAPTURE_LIMIT
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            include_request_id=True,
            response_body=body,
            response_content_type="text/plain",
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert "response_body_truncated" not in entry
        assert len(entry["response_body"]) == BODY_CAPTURE_LIMIT

    def test_complete_body_at_limit_with_incomplete_utf8_uses_base64(self, real_flow):
        body = b"x" * (BODY_CAPTURE_LIMIT - 1) + b"\xe2"
        flow = real_flow(
            method="POST",
            host="api.example.com",
            response_content_type="application/json",
            include_request_id=True,
            request_body=body,
            request_content_type="text/plain",
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["request_body_encoding"] == "base64"
        assert base64.b64decode(entry["request_body"]) == body
        assert "request_body_truncated" not in entry

    @pytest.mark.parametrize("character", ["é", "€", "𝄞"])
    def test_truncation_preserves_utf8_boundary(self, real_flow, character):
        body = b"x" * (BODY_CAPTURE_LIMIT - 1) + character.encode()
        flow = real_flow(
            method="POST",
            host="api.example.com",
            response_content_type="application/json",
            include_request_id=True,
            request_body=body,
            request_content_type="text/plain",
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["request_body_truncated"] is True
        assert entry["request_body_encoding"] == "utf-8"
        assert entry["request_body"] == "x" * (BODY_CAPTURE_LIMIT - 1)

    def test_text_request_with_binary_response(self, real_flow):
        flow = real_flow(
            method="POST",
            host="api.example.com",
            include_request_id=True,
            request_body=b'{"q": "test"}',
            response_body=b"\x89PNG\r\n",
            request_content_type="application/json",
            response_content_type="image/png",
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["request_body"] == '{"q": "test"}'
        assert "response_body" not in entry
        assert entry["response_body_encoding"] == "binary"

    def test_both_bodies_binary(self, real_flow):
        flow = real_flow(
            method="POST",
            host="api.example.com",
            include_request_id=True,
            request_body=b"\x89PNG",
            response_body=b"\x1f\x8b\x08",
            request_content_type="image/png",
            response_content_type="application/gzip",
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert "request_body" not in entry
        assert entry["request_body_encoding"] == "binary"
        assert "response_body" not in entry
        assert entry["response_body_encoding"] == "binary"
        assert "request_headers" in entry
        assert "response_headers" in entry

    def test_both_request_and_response(self, real_flow):
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_content_type="application/json",
            response_content_type="application/json",
            include_request_id=True,
            request_body=b'{"q": "test"}',
            response_body=b'{"a": "result"}',
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["request_body"] == '{"q": "test"}'
        assert entry["response_body"] == '{"a": "result"}'
        assert entry["request_headers"]["Host"] == "***"

    def test_non_utf8_text_bodies_capture_base64(self, real_flow):
        request_body = b"\xff\xfe request"
        response_body = b"\xff\xfe response"
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_body=request_body,
            request_content_type="text/plain",
            response_body=response_body,
            response_content_type="text/plain",
            include_request_id=True,
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["request_body_encoding"] == "base64"
        assert base64.b64decode(entry["request_body"]) == request_body
        assert entry["response_body_encoding"] == "base64"
        assert base64.b64decode(entry["response_body"]) == response_body

    def test_large_non_utf8_text_bodies_capture_truncated_base64(self, real_flow):
        request_body = b"\xff" + b"r" * BODY_CAPTURE_LIMIT
        response_body = b"\xfe" + b"s" * BODY_CAPTURE_LIMIT
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_body=request_body,
            request_content_type="text/plain",
            response_body=response_body,
            response_content_type="text/plain",
            include_request_id=True,
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["request_body_encoding"] == "base64"
        assert base64.b64decode(entry["request_body"]) == request_body[:BODY_CAPTURE_LIMIT]
        assert entry["request_body_truncated"] is True
        assert entry["response_body_encoding"] == "base64"
        assert base64.b64decode(entry["response_body"]) == response_body[:BODY_CAPTURE_LIMIT]
        assert entry["response_body_truncated"] is True

    def test_invalid_boundary_bytes_preserve_truncated_base64(self, real_flow):
        request_body = b"r" * (BODY_CAPTURE_LIMIT - 1) + b"\xff" + b"x"
        response_body = b"s" * (BODY_CAPTURE_LIMIT - 1) + b"\xfe" + b"y"
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_body=request_body,
            request_content_type="text/plain",
            response_body=response_body,
            response_content_type="text/plain",
            include_request_id=True,
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["request_body_encoding"] == "base64"
        assert base64.b64decode(entry["request_body"]) == request_body[:BODY_CAPTURE_LIMIT]
        assert entry["request_body_truncated"] is True
        assert entry["response_body_encoding"] == "base64"
        assert base64.b64decode(entry["response_body"]) == response_body[:BODY_CAPTURE_LIMIT]
        assert entry["response_body_truncated"] is True

    @pytest.mark.parametrize(
        "invalid_suffix",
        [b"\xc0", b"\xf5", b"\xe0\x80", b"\xed\xa0", b"\xf0\x80", b"\xf4\x90"],
    )
    def test_invalid_utf8_suffix_preserves_truncated_base64(self, real_flow, invalid_suffix):
        body = b"x" * (BODY_CAPTURE_LIMIT - len(invalid_suffix)) + invalid_suffix + b"z"
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_body=body,
            request_content_type="text/plain",
            response_content_type="application/json",
            include_request_id=True,
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["request_body_encoding"] == "base64"
        assert base64.b64decode(entry["request_body"]) == body[:BODY_CAPTURE_LIMIT]
        assert entry["request_body_truncated"] is True

    def test_earlier_invalid_byte_preserves_split_utf8_suffix_in_base64(self, real_flow):
        body = b"\xff" + b"x" * (BODY_CAPTURE_LIMIT - 2) + "€".encode()
        flow = real_flow(
            method="POST",
            host="api.example.com",
            request_body=body,
            request_content_type="text/plain",
            response_content_type="application/json",
            include_request_id=True,
        )
        entry = {}
        add_capture_fields(flow, entry)
        assert entry["request_body_encoding"] == "base64"
        assert base64.b64decode(entry["request_body"]) == body[:BODY_CAPTURE_LIMIT]
        assert entry["request_body_truncated"] is True
