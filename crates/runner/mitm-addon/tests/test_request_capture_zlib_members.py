"""Request-capture member bounds through admitted buffered SigV4 flows."""

import zlib
from unittest.mock import AsyncMock, patch

import pytest
from mitmproxy import http

import auth
import aws_sigv4_body_admission
import flow_metadata_keys as metadata_keys
import mitm_addon
from body_limits import BODY_CAPTURE_LIMIT
from tests.aws_sigv4_helpers import RESOLVED_AWS_ACCESS_KEY_ID
from tests.body_decode_helpers import track_zlib_decompressor
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.test_request_handler_aws_sigv4_body import (
    _header_auth_flow,
    _resolved_token_meta,
    _write_aws_registry,
)


@pytest.mark.parametrize("encoding", ["gzip", "deflate"])
@pytest.mark.parametrize("many_members", [False, True], ids=["at-budget", "admission-limit"])
@pytest.mark.parametrize("decoded_body", [b"", b"x" * BODY_CAPTURE_LIMIT], ids=["empty", "prefix"])
async def test_buffered_sigv4_request_capture_bounds_empty_member_work(
    tmp_path, real_flow, headers, mitm_ctx, monkeypatch, encoding, many_members, decoded_body
):
    wbits = 16 + zlib.MAX_WBITS if encoding == "gzip" else zlib.MAX_WBITS
    first_member = zlib.compress(decoded_body, wbits=wbits)
    empty_member = zlib.compress(b"", wbits=wbits)
    max_body = aws_sigv4_body_admission.MAX_AWS_SIGV4_REQUEST_BODY_BYTES
    empty_count = (max_body - len(first_member)) // len(empty_member) if many_members else 63
    body = first_member + empty_member * empty_count
    assert len(body) <= max_body
    registry_path = _write_aws_registry(tmp_path, capture_body=True)
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
        assert flow.request.raw_content == body
        assert flow.request.headers["Content-Encoding"] == encoding
        assert f"Credential={RESOLVED_AWS_ACCESS_KEY_ID}/" in flow.request.headers["authorization"]
        assert aws_sigv4_body_admission.state_for_tests() == (1, len(body))

        stats = track_zlib_decompressor(monkeypatch, "zlib_decoding.zlib.decompressobj")
        flow.response = http.Response.make(400, b"synthetic upstream rejection")
        assert mitm_addon.response(flow) is None

    get_headers.assert_awaited_once()
    assert stats["objects"] == 64
    assert stats["calls"] <= 66
    assert stats["max_input"] <= 1024
    assert stats["max_unused_data"] <= 1024
    assert flow.request.raw_content == body
    assert flow.response.status_code == 400
    assert flow.response.raw_content == b"synthetic upstream rejection"
    assert aws_sigv4_body_admission.state_for_tests() == (0, 0)
    assert metadata_keys.AWS_SIGV4_BODY_ADMISSION not in flow.metadata
    assert metadata_keys.AWS_SIGV4_REQUEST_INSPECTION not in flow.metadata

    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["status"] == 400
    assert entry["request_size"] == len(body)
    if many_members:
        assert "request_body" not in entry
        assert entry["request_body_encoding"] == "binary"
    elif decoded_body:
        assert entry["request_body"] == decoded_body.decode("ascii")
        assert entry["request_body_encoding"] == "utf-8"
        assert "request_body_truncated" not in entry
    else:
        assert "request_body" not in entry
        assert "request_body_encoding" not in entry
