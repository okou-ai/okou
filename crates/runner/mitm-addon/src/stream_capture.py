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

    def append(self, chunk: bytes, *, limit: int) -> bool:
        """Append the fitting prefix and return true only on first truncation.

        Filling the buffer exactly, including an empty chunk at capacity, is complete.
        """
        if self.truncated:
            return False
        remaining = limit - len(self.buffer)
        if len(chunk) <= remaining:
            self.buffer.extend(chunk)
            return False
        self.buffer.extend(chunk[:remaining])
        self.truncated = True
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
