"""Shared request streaming state for size, capture logging, and X billing.

When this module installs its pass-through callback, the callback counts every
chunk. Callers requesting diagnostic capture or billing inspection also retain a
capped prefix. Inspection alone does not enable persisted network body capture.

Configuration preserves any existing callable stream without composing with it.
When setup first finds an externally owned callback, it creates no addon
observation or capture state, so the size and capture helpers return ``None``. A
repeated call for this module's callback leaves its existing state intact.
Terminal response and error handling retain installed metadata through connector
usage reporting, then release it.
"""

from mitmproxy import http

import flow_metadata_keys as metadata_keys
import stream_capture
from body_limits import STREAM_BUFFER_LIMIT

_REQUEST_STREAM_CALLBACK = "_request_stream_callback"


def configure_request_stream(
    flow: http.HTTPFlow,
    *,
    capture_body: bool = True,
    inspect_body: bool = False,
) -> None:
    """Install size observation and an optional capped capture/inspection prefix.

    If the request stream is already callable, preserve it without composition
    and do not create or reset addon request-stream metadata. An external callback
    encountered before addon setup therefore leaves no addon size or capture state,
    while repeated addon configuration retains the state installed by the first
    call.
    """
    if callable(flow.request.stream):
        return

    buf = bytearray()
    state = {"truncated": False, "total_bytes": 0}
    buf_limit = STREAM_BUFFER_LIMIT
    retain_body = capture_body or inspect_body

    def stream_and_buffer(chunk: bytes) -> bytes:
        state["total_bytes"] += len(chunk)
        if retain_body and not state["truncated"]:
            remaining = buf_limit - len(buf)
            if len(chunk) <= remaining:
                buf.extend(chunk)
            else:
                buf.extend(chunk[:remaining])
                state["truncated"] = True
        return chunk

    flow.request.stream = stream_and_buffer
    if retain_body:
        flow.metadata[metadata_keys.REQUEST_STREAM_BUFFER] = buf
    flow.metadata[metadata_keys.REQUEST_STREAM_BUFFER_STATE] = state
    flow.metadata[_REQUEST_STREAM_CALLBACK] = stream_and_buffer


def streamed_request_size(flow: http.HTTPFlow) -> int | None:
    """Return total request bytes observed by the request stream callback."""
    state = flow.metadata.get(metadata_keys.REQUEST_STREAM_BUFFER_STATE)
    if state is None:
        return None
    return int(state["total_bytes"])


def captured_request_stream_body(flow: http.HTTPFlow) -> stream_capture.CapturedStreamBody | None:
    """Return buffered bytes and truncation state to capture and billing consumers.

    Request completeness is recorded separately in ``REQUEST_STREAM_COMPLETE``.
    """
    stream_buf = flow.metadata.get(metadata_keys.REQUEST_STREAM_BUFFER)
    stream_state = flow.metadata.get(metadata_keys.REQUEST_STREAM_BUFFER_STATE)
    return stream_capture.captured_stream_body(
        stream_buf,
        stream_state,
        body_kind="request",
        buffer_key=metadata_keys.REQUEST_STREAM_BUFFER,
        state_key=metadata_keys.REQUEST_STREAM_BUFFER_STATE,
        writer="request_streaming.configure_request_stream()",
    )


def release_request_stream_state(flow: http.HTTPFlow) -> None:
    """Release shared stream state after terminal consumers have finished.

    Terminal cleanup calls this after network logging and applicable connector
    usage reporting.
    """
    stream_callback = flow.metadata.pop(_REQUEST_STREAM_CALLBACK, None)
    flow.metadata.pop(metadata_keys.REQUEST_STREAM_BUFFER, None)
    flow.metadata.pop(metadata_keys.REQUEST_STREAM_BUFFER_STATE, None)
    flow.metadata.pop(metadata_keys.REQUEST_STREAM_COMPLETE, None)
    if stream_callback is not None and flow.request.stream is stream_callback:
        flow.request.stream = False
