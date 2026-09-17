"""Shared captured stream-body metadata access and validation."""

from typing import NamedTuple

from mitmproxy import http

import flow_metadata_keys as metadata_keys


class CapturedStreamBody(NamedTuple):
    buffer: bytearray
    truncated: bool


def captured_stream_body(
    stream_buf: bytearray | None,
    stream_state: object,
    *,
    body_kind: str,
    buffer_key: str,
    state_key: str,
    writer: str,
) -> CapturedStreamBody | None:
    """Return captured bytes and truncation state from writer-owned metadata."""
    if stream_buf is None:
        return None

    stream_truncated = False
    if stream_buf:
        if not isinstance(stream_state, dict) or "truncated" not in stream_state:
            state_description = (
                f"keys={sorted(str(key) for key in stream_state)}"
                if isinstance(stream_state, dict)
                else f"type={type(stream_state).__name__}"
            )
            raise RuntimeError(
                f"Invalid {body_kind} body capture metadata: {buffer_key} is "
                f"present and non-empty (len={len(stream_buf)}) but "
                f"{state_key} is missing the truncated flag. "
                f"{writer} must set {buffer_key} and {state_key} together "
                f"({state_key} {state_description})."
            )
        stream_truncated = bool(stream_state["truncated"])
    elif stream_state is not None and not isinstance(stream_state, dict):
        raise RuntimeError(
            f"Invalid {body_kind} body capture metadata: {buffer_key} is "
            f"empty but {state_key} is not a dict "
            f"({state_key} type={type(stream_state).__name__})."
        )
    elif stream_state:
        stream_truncated = bool(stream_state.get("truncated", False))

    return CapturedStreamBody(stream_buf, stream_truncated)


def captured_response_stream_body(flow: http.HTTPFlow) -> CapturedStreamBody | None:
    """Read the response bytes and truncation state written together by streaming."""
    return captured_stream_body(
        flow.metadata.get(metadata_keys.STREAM_BUFFER),
        flow.metadata.get(metadata_keys.STREAM_BUFFER_STATE),
        body_kind="response",
        buffer_key=metadata_keys.STREAM_BUFFER,
        state_key=metadata_keys.STREAM_BUFFER_STATE,
        writer="response_streaming.configure_response_stream()",
    )
