"""Initial zstd capture work through admitted buffered SigV4 request hooks."""

from unittest.mock import AsyncMock, patch

import pytest
import zstandard
from mitmproxy import http

import auth
import aws_sigv4_body_admission
import flow_metadata_keys as metadata_keys
import mitm_addon
from body_limits import BODY_CAPTURE_LIMIT
from tests.aws_sigv4_helpers import RESOLVED_AWS_ACCESS_KEY_ID
from tests.body_decode_helpers import track_zstd_reader
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.test_request_handler_aws_sigv4_body import (
    _header_auth_flow,
    _resolved_token_meta,
    _write_aws_registry,
)


@pytest.mark.parametrize("capture_body", [False, True], ids=["capture-off", "capture-on"])
@pytest.mark.parametrize("many_frames", [False, True], ids=["64-frames", "admission-limit"])
@pytest.mark.parametrize("decoded_body", [b"", b"x" * BODY_CAPTURE_LIMIT], ids=["empty", "prefix"])
async def test_buffered_sigv4_request_capture_bounds_initial_zstd_work(
    tmp_path, real_flow, headers, mitm_ctx, monkeypatch, capture_body, many_frames, decoded_body
):
    compressor = zstandard.ZstdCompressor()
    first_frame = compressor.compress(decoded_body)
    empty_frame = compressor.compress(b"")
    max_body = aws_sigv4_body_admission.MAX_AWS_SIGV4_REQUEST_BODY_BYTES
    empty_count = (max_body - len(first_frame)) // len(empty_frame) if many_frames else 63
    body = first_frame + empty_frame * empty_count
    assert len(body) <= max_body
    if many_frames:
        assert max_body - len(body) < len(empty_frame)
    registry_path = _write_aws_registry(tmp_path, capture_body=capture_body)
    flow = _header_auth_flow(
        real_flow,
        headers,
        body=body,
        content_length=str(len(body)),
        content_type="text/plain",
    )
    flow.request.headers["Content-Encoding"] = "zstd"
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
        assert flow.request.headers["Content-Encoding"] == "zstd"
        assert f"Credential={RESOLVED_AWS_ACCESS_KEY_ID}/" in flow.request.headers["authorization"]
        assert aws_sigv4_body_admission.state_for_tests() == (1, len(body))

        stats = track_zstd_reader(monkeypatch, max_output=BODY_CAPTURE_LIMIT + 2)
        flow.response = http.Response.make(400, b"synthetic upstream rejection")
        assert mitm_addon.response(flow) is None

    get_headers.assert_awaited_once()
    # Count bytes offered to the initial native reader, not just the later
    # validator's already-bounded decoder construction. Oversized capture must
    # stop before either pass; the small control retains real codec execution.
    if capture_body and not many_frames:
        assert stats["readers"] == 1
        assert stats["input_bytes"] == len(body)
        assert stats["validation_objects"] == 64
    else:
        assert stats["readers"] == 0
        assert stats["input_bytes"] == 0
        assert stats["validation_objects"] == 0
    assert flow.request.raw_content == body
    assert flow.request.headers["Content-Encoding"] == "zstd"
    assert flow.response.status_code == 400
    assert flow.response.raw_content == b"synthetic upstream rejection"
    assert aws_sigv4_body_admission.state_for_tests() == (0, 0)
    assert metadata_keys.AWS_SIGV4_BODY_ADMISSION not in flow.metadata
    assert metadata_keys.AWS_SIGV4_REQUEST_INSPECTION not in flow.metadata

    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["status"] == 400
    assert entry["request_size"] == len(body)
    if capture_body and many_frames:
        assert "request_body" not in entry
        assert entry["request_body_encoding"] == "binary"
    elif capture_body and decoded_body:
        assert entry["request_body"] == decoded_body.decode("ascii")
        assert entry["request_body_encoding"] == "utf-8"
        assert "request_body_truncated" not in entry
    else:
        assert "request_body" not in entry
        assert "request_body_encoding" not in entry
