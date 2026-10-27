"""Single-member capture work and wire invariants through admitted SigV4 hooks."""

import base64
import hashlib
import zlib
from unittest.mock import AsyncMock, patch

import pytest
from mitmproxy import http
from mitmproxy.flow import Error

import auth
import aws_sigv4_body_admission
import flow_metadata_keys as metadata_keys
import mitm_addon
from body_capture import add_capture_fields
from body_decoding import decompress_json_usage_body
from body_limits import BODY_CAPTURE_LIMIT
from tests.aws_sigv4_helpers import RESOLVED_AWS_ACCESS_KEY_ID
from tests.body_decode_helpers import track_zlib_decompressor
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.test_request_handler_aws_sigv4_body import (
    _header_auth_flow,
    _resolved_token_meta,
    _write_aws_registry,
)


def _single_member_body(encoding: str, wire_size: int, decoded_body: bytes) -> bytes:
    """Add no-output metadata/blocks to an independently validated single member."""
    wbits = 16 + zlib.MAX_WBITS if encoding == "gzip" else zlib.MAX_WBITS
    compressed = zlib.compress(decoded_body, wbits=wbits)
    padding_size = wire_size - len(compressed)
    if encoding == "gzip":
        # RFC 1952 FNAME flag, followed by a zero-terminated name after the header.
        body = (
            compressed[:3]
            + bytes([compressed[3] | 8])
            + compressed[4:10]
            + b"m" * (padding_size - 1)
            + b"\0"
            + compressed[10:]
        )
    else:
        # Empty non-final stored blocks are five bytes. An empty fixed-Huffman
        # block followed by an empty stored block is six bytes, ending aligned.
        # Mix them to reach the exact boundary without producing any output.
        six_byte_blocks = padding_size % 5
        five_byte_blocks = (padding_size - 6 * six_byte_blocks) // 5
        padding = (
            b"\x02\x00\x00\x00\xff\xff" * six_byte_blocks
            + b"\x00\x00\x00\xff\xff" * five_byte_blocks
        )
        body = compressed[:2] + padding + compressed[2:]
    assert len(body) == wire_size
    assert zlib.decompress(body, wbits=wbits) == decoded_body
    return body


async def _capture_sigv4_request(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
    monkeypatch,
    *,
    encoding: str,
    body: bytes,
    capture_body: bool,
    terminal_error: bool,
):
    registry_path = _write_aws_registry(tmp_path, capture_body=capture_body)
    flow = _header_auth_flow(
        real_flow,
        headers,
        body=body,
        content_length=str(len(body)),
        content_type="text/plain",
    )
    flow.request.headers["Content-Encoding"] = encoding
    get_headers = AsyncMock(return_value=_resolved_token_meta())

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        assert mitm_addon.requestheaders(flow) is None
        assert aws_sigv4_body_admission.state_for_tests() == (1, len(body))
        assert not callable(flow.request.stream)

        await mitm_addon.request(flow)
        assert flow.response is None
        assert f"Credential={RESOLVED_AWS_ACCESS_KEY_ID}/" in flow.request.headers["authorization"]
        signed_headers = flow.request.headers.fields
        assert aws_sigv4_body_admission.state_for_tests() == (1, len(body))

        stats = track_zlib_decompressor(monkeypatch, "zlib_decoding.zlib.decompressobj")
        if terminal_error:
            flow.error = Error("synthetic upstream disconnect")
            assert mitm_addon.error(flow) is None
            assert flow.response is None
        else:
            flow.response = http.Response.make(400, b"synthetic upstream rejection")
            assert mitm_addon.response(flow) is None
            assert flow.response.status_code == 400
            assert flow.response.raw_content == b"synthetic upstream rejection"

    get_headers.assert_awaited_once()
    assert flow.request.raw_content == body
    assert flow.request.headers.fields == signed_headers
    assert flow.request.headers["Content-Encoding"] == encoding
    assert aws_sigv4_body_admission.state_for_tests() == (0, 0)
    assert metadata_keys.AWS_SIGV4_BODY_ADMISSION not in flow.metadata
    assert metadata_keys.AWS_SIGV4_REQUEST_INSPECTION not in flow.metadata

    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["request_size"] == len(body)
    assert entry["status"] == (0 if terminal_error else 400)
    if terminal_error:
        assert entry["error"] == "synthetic upstream disconnect"
    return stats, entry


@pytest.mark.parametrize("encoding", ["gzip", "deflate"])
@pytest.mark.parametrize("capture_body", [False, True], ids=["capture-off", "capture-on"])
@pytest.mark.parametrize("terminal_error", [False, True], ids=["response", "error"])
@pytest.mark.parametrize(
    ("wire_size", "decoded_body"),
    [
        pytest.param(128 * 1024, b"", id="at-budget-empty"),
        pytest.param(128 * 1024, b"ordinary request", id="at-budget-text"),
        pytest.param(128 * 1024 + 1, b"", id="over-budget-empty"),
        pytest.param(128 * 1024 + 1, b"ordinary request", id="over-budget-text"),
        pytest.param(32 * 1024 * 1024, b"", id="admission-limit"),
    ],
)
async def test_buffered_sigv4_zlib_capture_input_budget(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
    monkeypatch,
    encoding,
    capture_body,
    terminal_error,
    wire_size,
    decoded_body,
):
    body = _single_member_body(encoding, wire_size, decoded_body)
    stats, entry = await _capture_sigv4_request(
        tmp_path,
        real_flow,
        headers,
        mitm_ctx,
        monkeypatch,
        encoding=encoding,
        body=body,
        capture_body=capture_body,
        terminal_error=terminal_error,
    )

    if capture_body and wire_size <= 128 * 1024:
        assert stats["objects"] == 1
        assert 0 < stats["calls"] <= 128
        assert stats["input_bytes"] == wire_size
        assert stats["max_input"] == 1024
        assert stats["output_bytes"] == len(decoded_body)
        if decoded_body:
            assert entry["request_body"] == decoded_body.decode("ascii")
            assert entry["request_body_encoding"] == "utf-8"
            assert "request_body_truncated" not in entry
        else:
            assert "request_body" not in entry
            assert "request_body_encoding" not in entry
    else:
        assert stats["objects"] == 0
        assert stats["calls"] == 0
        assert stats["input_bytes"] == 0
        assert "request_body" not in entry
        if capture_body:
            assert entry["request_body_encoding"] == "binary"
        else:
            assert "request_body_encoding" not in entry


@pytest.mark.parametrize("encoding", ["gzip", "deflate"])
@pytest.mark.parametrize("kind", ["text", "incompressible", "prefix", "invalid", "incomplete"])
async def test_buffered_sigv4_zlib_capture_preserves_within_budget_contracts(
    tmp_path, real_flow, headers, mitm_ctx, monkeypatch, encoding, kind
):
    if kind == "incompressible":
        decoded_body = hashlib.shake_256(b"zlib capture boundary").digest(BODY_CAPTURE_LIMIT)
    elif kind == "prefix":
        decoded_body = b"x" * (2 * BODY_CAPTURE_LIMIT)
    else:
        decoded_body = b"ordinary request"
    wbits = 16 + zlib.MAX_WBITS if encoding == "gzip" else zlib.MAX_WBITS
    body = zlib.compress(decoded_body, wbits=wbits)
    if kind == "invalid":
        body = b"not compressed"
    elif kind == "incomplete":
        body = body[:-1]

    stats, entry = await _capture_sigv4_request(
        tmp_path,
        real_flow,
        headers,
        mitm_ctx,
        monkeypatch,
        encoding=encoding,
        body=body,
        capture_body=True,
        terminal_error=False,
    )

    assert stats["objects"] == 1
    assert 0 < stats["calls"] <= 128
    assert 0 < stats["input_bytes"] <= 128 * 1024
    assert 0 < stats["max_input"] <= 1024
    assert stats["max_output_request"] <= BODY_CAPTURE_LIMIT + 2
    if kind in ("invalid", "incomplete"):
        assert "request_body" not in entry
        assert entry["request_body_encoding"] == "binary"
    elif kind == "incompressible":
        assert entry["request_body_encoding"] == "base64"
        assert base64.b64decode(entry["request_body"]) == decoded_body
        assert "request_body_truncated" not in entry
    else:
        assert entry["request_body"] == decoded_body[:BODY_CAPTURE_LIMIT].decode("ascii")
        assert entry["request_body_encoding"] == "utf-8"
        assert entry.get("request_body_truncated", False) == (kind == "prefix")


@pytest.mark.parametrize("encoding", ["gzip", "deflate"])
def test_large_zlib_input_keeps_response_capture_and_json_usage_policy(
    real_flow, headers, encoding
):
    decoded_body = b"ordinary response"
    body = _single_member_body(encoding, 128 * 1024 + 1, decoded_body)
    flow = real_flow(
        request_body=b"ordinary request",
        response_body=body,
        response_content_type="text/plain",
    )
    flow.response.headers["Content-Encoding"] = encoding
    entry = {}

    add_capture_fields(flow, entry)

    assert entry["request_body"] == "ordinary request"
    assert entry["response_body"] == decoded_body.decode("ascii")
    assert entry["response_body_encoding"] == "utf-8"
    assert "response_body_truncated" not in entry
    assert decompress_json_usage_body(body, headers(("Content-Encoding", encoding))) == (
        decoded_body,
        None,
    )
