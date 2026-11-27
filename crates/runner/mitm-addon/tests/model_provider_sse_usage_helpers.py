"""Shared model-provider SSE usage integration-test mechanics."""

import gzip
import zlib
from pathlib import Path

from mitmproxy import http

import flow_metadata_keys as metadata_keys
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush


def compress_zlib_sse(body: bytes, encoding: str) -> bytes:
    if encoding == "gzip":
        return gzip.compress(body)
    assert encoding == "deflate"
    return zlib.compress(body)


def model_sse_parse_warnings(flow: http.HTTPFlow) -> list[dict]:
    proxy_log = Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])
    return [
        entry
        for entry in read_jsonl_entries_after_flush(proxy_log, missing_ok=True)
        if entry.get("message") == "Model provider SSE usage extraction failed"
    ]


def assert_single_model_sse_parse_warning(
    flow: http.HTTPFlow,
    *,
    usage_protocol: str,
    event: str,
    error: str | None = None,
) -> None:
    usage_warnings = model_sse_parse_warnings(flow)
    assert len(usage_warnings) == 1
    warning = usage_warnings[0]
    assert warning["level"] == "warn"
    assert warning["type"] == "usage_event"
    assert warning["usage_protocol"] == usage_protocol
    assert warning["event"] == event
    if error is None:
        assert warning["error"]
    else:
        assert warning["error"] == error
