"""Shared captured stream-body writes, metadata access, validation and release."""

from dataclasses import dataclass, field
from typing import NamedTuple

from mitmproxy import http

import flow_metadata_keys as metadata_keys


class CapturedStreamBody(NamedTuple):
    buffer: bytearray
    truncated: bool


@dataclass(slots=True, repr=False)
class StreamCapture:
    """Own a retained raw prefix and its truncation state together."""

    buffer: bytearray = field(default_factory=bytearray)
    truncated: bool = False

    def append(self, chunk: bytes, *, limit: int) -> None:
        if not self.truncated and append_captured_chunk(self.buffer, chunk, limit=limit):
            self.truncated = True


def append_captured_chunk(buffer: bytearray, chunk: bytes, *, limit: int) -> bool:
    """Append the fitting raw prefix and return whether this chunk overflowed.

    Callers own capture admission and skip writes once their buffer is truncated.
    Filling the buffer exactly, including an empty chunk at capacity, is complete.
    """
    remaining = limit - len(buffer)
    if len(chunk) <= remaining:
        buffer.extend(chunk)
        return False
    buffer.extend(chunk[:remaining])
    return True


def captured_stream_body(
    capture: StreamCapture | None,
) -> CapturedStreamBody | None:
    """Return the current view of a writer-owned capture, including an empty one."""
    if capture is None:
        return None
    return CapturedStreamBody(capture.buffer, capture.truncated)


def captured_response_stream_body(flow: http.HTTPFlow) -> CapturedStreamBody | None:
    """Read the response capture owned by streaming."""
    return captured_stream_body(flow.metadata.get(metadata_keys.RESPONSE_STREAM_CAPTURE))


def clear_response_capture_state(flow: http.HTTPFlow) -> None:
    """Remove byte accounting and optional body capture, leaving callbacks to their owners."""
    flow.metadata.pop(metadata_keys.RESPONSE_STREAM_STATE, None)
    flow.metadata.pop(metadata_keys.RESPONSE_STREAM_CAPTURE, None)
