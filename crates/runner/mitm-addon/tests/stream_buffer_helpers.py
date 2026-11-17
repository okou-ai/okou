"""Shared stream-buffer metadata helpers for mitm-addon tests.

These helpers seed the hook-owned metadata keys and required state fields for
tests that consume buffered stream metadata. Tests for byte-limit behavior
should use the real request/response stream callbacks instead.
"""

from mitmproxy import http

import flow_metadata_keys as metadata_keys
import request_streaming
import stream_capture


def set_response_stream_buffer(
    flow: http.HTTPFlow,
    body: bytes,
    *,
    truncated: bool = False,
) -> None:
    """Seed response stream metadata with the hook-owned key/state shape."""
    flow.metadata[metadata_keys.RESPONSE_STREAM_CAPTURE] = stream_capture.StreamCapture(
        bytearray(body), truncated
    )


def set_request_stream_buffer(
    flow: http.HTTPFlow,
    body: bytes,
    *,
    complete: bool = True,
    truncated: bool = False,
) -> None:
    """Seed request stream metadata with the hook-owned key/state shape."""
    flow.metadata[metadata_keys.REQUEST_STREAM_CAPTURE] = stream_capture.StreamCapture(
        bytearray(body), truncated
    )
    flow.metadata[metadata_keys.REQUEST_STREAM_STATE] = {
        "total_bytes": len(body) + 1 if truncated else len(body),
    }
    if complete:
        flow.metadata[metadata_keys.REQUEST_STREAM_COMPLETE] = True
    else:
        flow.metadata.pop(metadata_keys.REQUEST_STREAM_COMPLETE, None)


def request_stream_capture(flow: http.HTTPFlow) -> stream_capture.CapturedStreamBody:
    """Require the public captured request view for a positive capture assertion."""
    captured = request_streaming.captured_request_stream_body(flow)
    assert captured is not None
    return captured


def response_stream_capture(flow: http.HTTPFlow) -> stream_capture.CapturedStreamBody:
    """Require the public captured response view for a positive capture assertion."""
    captured = stream_capture.captured_response_stream_body(flow)
    assert captured is not None
    return captured
