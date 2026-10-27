"""Brotli capture work and wire invariants through admitted SigV4 hooks."""

import base64
import hashlib
from unittest.mock import AsyncMock, patch

import brotli
import pytest
from mitmproxy import http
from mitmproxy.flow import Error

import auth
import aws_sigv4_body_admission
import flow_metadata_keys as metadata_keys
import mitm_addon
from body_limits import BODY_CAPTURE_LIMIT
from tests.aws_sigv4_helpers import RESOLVED_AWS_ACCESS_KEY_ID
from tests.body_decode_helpers import track_brotli_decompressor
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.test_request_handler_aws_sigv4_body import (
    _header_auth_flow,
    _resolved_token_meta,
    _write_aws_registry,
)


def _metadata_brotli_body(wire_size: int, decoded_body: bytes) -> bytes:
    """Build RFC 7932 metadata and uncompressed blocks with a 16 KiB window."""
    suffix = bytearray()
    for offset in range(0, len(decoded_body), 65_536):
        block = decoded_body[offset : offset + 65_536]
        # Non-final block, four length nibbles, then ISUNCOMPRESSED=1.
        suffix.extend((((len(block) - 1) << 3) | (1 << 19)).to_bytes(3, "little"))
        suffix.extend(block)
    suffix.append(3)  # ISLAST=1, ISLASTEMPTY=1.

    max_metadata = 1 << 24
    block_count = (wire_size - len(suffix) + max_metadata + 3) // (max_metadata + 4)
    metadata_left = wire_size - len(suffix) - 4 * block_count
    wire = bytearray()
    for index in range(block_count):
        block_size = min(metadata_left, max_metadata)
        # First block starts after WBITS=0 (16 KiB); later blocks start at bit 0.
        shift = 1 if index == 0 else 0
        # ISLAST=0, MNIBBLES=3, reserved=0, MSKIPBYTES=3, then MSKIPLEN.
        header = (3 << (shift + 1)) | (3 << (shift + 4))
        header |= (block_size - 1) << (shift + 6)
        wire.extend(header.to_bytes(4, "little"))
        wire.extend(b"m" * block_size)
        metadata_left -= block_size
    wire.extend(suffix)
    assert len(wire) == wire_size
    result = bytes(wire)
    # Independently validate the complete fixture before instrumentation.
    assert brotli.decompress(result) == decoded_body
    return result


async def _capture_sigv4_request(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
    monkeypatch,
    *,
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
    flow.request.headers["Content-Encoding"] = "br"
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

        stats = track_brotli_decompressor(monkeypatch)
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
    assert flow.request.headers["Content-Encoding"] == "br"
    assert aws_sigv4_body_admission.state_for_tests() == (0, 0)
    assert metadata_keys.AWS_SIGV4_BODY_ADMISSION not in flow.metadata
    assert metadata_keys.AWS_SIGV4_REQUEST_INSPECTION not in flow.metadata

    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["request_size"] == len(body)
    assert entry["status"] == (0 if terminal_error else 400)
    if terminal_error:
        assert entry["error"] == "synthetic upstream disconnect"
    return stats, entry


@pytest.mark.parametrize("capture_body", [False, True], ids=["capture-off", "capture-on"])
@pytest.mark.parametrize("terminal_error", [False, True], ids=["response", "error"])
@pytest.mark.parametrize(
    ("wire_size", "decoded_body"),
    [
        pytest.param(128 * 1024, b"", id="at-budget-empty"),
        pytest.param(128 * 1024, b"ordinary request", id="at-budget-text"),
        pytest.param(128 * 1024 + 1, b"", id="over-budget-empty"),
        pytest.param(128 * 1024 + 1, b"ordinary request", id="over-budget-text"),
        pytest.param(32 * 1024 * 1024 - 7, b"", id="near-admission-limit"),
    ],
)
async def test_buffered_sigv4_brotli_capture_input_budget(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
    monkeypatch,
    capture_body,
    terminal_error,
    wire_size,
    decoded_body,
):
    body = _metadata_brotli_body(wire_size, decoded_body)
    stats, entry = await _capture_sigv4_request(
        tmp_path,
        real_flow,
        headers,
        mitm_ctx,
        monkeypatch,
        body=body,
        capture_body=capture_body,
        terminal_error=terminal_error,
    )

    if capture_body and wire_size <= 128 * 1024:
        assert stats["objects"] == 1
        assert 0 < stats["calls"] <= 128
        assert stats["input_bytes"] == wire_size
        assert 0 < stats["max_input"] <= 1024
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


@pytest.mark.parametrize("kind", ["text", "incompressible", "prefix", "invalid", "incomplete"])
async def test_buffered_sigv4_brotli_capture_preserves_within_budget_contracts(
    tmp_path, real_flow, headers, mitm_ctx, monkeypatch, kind
):
    if kind == "incompressible":
        decoded_body = hashlib.shake_256(b"brotli capture boundary").digest(BODY_CAPTURE_LIMIT)
    elif kind == "prefix":
        decoded_body = b"x" * (BODY_CAPTURE_LIMIT + 1)
    else:
        decoded_body = b"ordinary request"
    body = brotli.compress(decoded_body)
    if kind == "invalid":
        body = b"not brotli at all"
    elif kind == "incomplete":
        body = body[:-1]

    stats, entry = await _capture_sigv4_request(
        tmp_path,
        real_flow,
        headers,
        mitm_ctx,
        monkeypatch,
        body=body,
        capture_body=True,
        terminal_error=False,
    )

    assert stats["objects"] == 1
    assert 0 < stats["calls"] <= 128
    assert 0 < stats["input_bytes"] <= 128 * 1024
    assert 0 < stats["max_input"] <= 1024
    assert stats["max_output_buffer_limit"] <= BODY_CAPTURE_LIMIT + 2
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
