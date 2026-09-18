"""X connector response inspection.

Incrementally extracts billing-relevant fields from X JSON and NDJSON
responses and publishes parser-owned flow metadata for X usage reporting.
"""

import urllib.parse
from collections.abc import Callable
from typing import TypedDict

from mitmproxy import http

import flow_metadata_keys as metadata_keys
from body_limits import LARGE_RESPONSE_DECOMPRESS_LIMIT

from ...json_selective import (
    JsonExtractionResult,
    JsonSelectiveExtractor,
    ScalarField,
)
from .response_parser import ConnectorResponseParser
from .x_billing import MAX_UNKNOWN_INCLUDE_CATEGORIES, include_billing_category
from .x_resources import IDENTITY_BODY_LIMIT, inspect_identities, observed_at

# HTTP 2xx success range (RFC 9110). Also defined in ``response_streaming.py``
# and ``x.py``; kept local to avoid a constants module for a simple bound.
_HTTP_STATUS_OK_MIN = 200
_HTTP_STATUS_REDIRECT_MIN = 300

# X v2 NDJSON streaming endpoint paths (exact match — ``/2/tweets/search/stream/rules``
# is a regular request/response endpoint for rules management, NOT a stream).
# Streams deliver one JSON object per line, possibly for hours. The shared
# response streaming wrapper feeds the X NDJSON parser incrementally so billing
# extraction does not retain the response body. Capture mode independently keeps
# a capped raw-wire prefix.
_STREAM_ENDPOINTS = frozenset(
    {
        "/2/tweets/search/stream",
        "/2/tweets/sample/stream",
        "/2/tweets/sample10/stream",
        "/2/tweets/compliance/stream",
        "/2/users/compliance/stream",
    }
)


def is_stream_path(path: str) -> bool:
    """Return True when *path* is one of the X v2 NDJSON streaming endpoints.

    Exact match only — ``/2/tweets/search/stream/rules`` (rules management)
    must NOT match because it's a regular JSON request/response, not a stream.
    """
    return path in _STREAM_ENDPOINTS


# Single NDJSON line cap matches ``LARGE_RESPONSE_DECOMPRESS_LIMIT``. A real X
# tweet line (``data`` + ``includes`` +
# ``matching_rules`` with full expansion) should never approach this size;
# exceeding it indicates malformed or hostile upstream data, so the parser
# discards that row through its terminating newline to protect memory.
_MAX_NDJSON_LINE_BYTES = LARGE_RESPONSE_DECOMPRESS_LIMIT
# Bound dense syntax and slow scalar inspection across one non-streaming X JSON
# response while retaining the selective parser's bulk discarded-string path.
_MAX_JSON_RESPONSE_WORK_UNITS = 65_536
# Bound dense syntax and slow scalar inspection while keeping multi-megabyte
# ordinary discarded strings on the selective parser's bulk-scan path.
_MAX_NDJSON_ROW_WORK_UNITS = 65_536

_X_JSON_RESULT_COUNT_FIELDS = {
    ("meta", "result_count"): ScalarField("int", max_bytes=64),
    ("meta", "total_tweet_count"): ScalarField("int", max_bytes=64),
}


def as_non_negative_response_count(value: object) -> int | None:
    """Return an X response count only when it is a non-negative integer."""
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def _create_x_json_selective_extractor() -> JsonSelectiveExtractor:
    return JsonSelectiveExtractor(
        scalar_fields=_X_JSON_RESULT_COUNT_FIELDS,
        array_count_paths={("data",), ("errors",)},
        wildcard_array_count_paths={("includes", "*")},
        object_presence_paths={(), ("data",)},
        max_work_units=_MAX_JSON_RESPONSE_WORK_UNITS,
    )


def _create_x_ndjson_row_extractor() -> JsonSelectiveExtractor:
    return JsonSelectiveExtractor(
        wildcard_array_count_paths={("includes", "*")},
        object_presence_paths={("data",)},
        max_work_units=_MAX_NDJSON_ROW_WORK_UNITS,
    )


def _parse_x_json_response_fields(extracted: JsonExtractionResult) -> dict:
    result: dict = {}

    data_count = extracted.array_counts.get(("data",))
    if data_count is not None:
        result["response_data_count"] = data_count
    elif ("data",) in extracted.object_present:
        result["response_data_count"] = 1

    errors_count = extracted.array_counts.get(("errors",), 0)
    if errors_count:
        result["response_errors_count"] = errors_count

    includes = extracted.wildcard_array_counts.get(("includes", "*"), {})
    if includes:
        result["response_includes"] = dict(includes)

    result_count = as_non_negative_response_count(extracted.values.get(("meta", "result_count")))
    if result_count is not None:
        result["response_result_count"] = result_count

    total_tweet_count = as_non_negative_response_count(
        extracted.values.get(("meta", "total_tweet_count"))
    )
    if total_tweet_count is not None:
        result["response_total_tweet_count"] = total_tweet_count

    return result


def parse_json_response_fields_from_body(body: bytes) -> dict | None:
    """Extract billing-relevant fields from one complete X JSON body."""
    extractor = _create_x_json_selective_extractor()
    extractor.feed(body)
    extracted = extractor.finish()
    if not extracted.complete or () not in extracted.object_present:
        return None
    result = _parse_x_json_response_fields(extracted)
    result["resource_identities"] = inspect_identities(body)
    result["observed_at"] = observed_at()
    return result


class _NdjsonState(TypedDict):
    """Accumulated parser state for an X NDJSON stream.

    Populated by :class:`_NdjsonExtractor` and read by X usage reporting when
    emitting the billing log entry.
    """

    data_count: int
    """Number of lines whose top-level ``data`` is a dict (one tweet per line)."""
    includes: dict[str, int]
    """Running sum of ``len(includes.<key>)`` across all lines, per key."""
    unknown_includes_overflow_count: int
    """Unknown include quantities routed to the bounded overflow category."""
    lines_parsed: int
    """JSON-parseable non-blank lines."""
    lines_failed: int
    """Lines that failed JSON decoding or exceeded the single-line safety cap."""


class _NdjsonExtractor:
    """Incremental NDJSON parser for X v2 streaming responses.

    X v2 streaming endpoints deliver one JSON object per line separated by
    ``\\n`` (or ``\\r\\n``), with blank lines as keep-alives. Each tweet
    line typically has the shape::

        {"data": {...tweet...}, "includes": {...}, "matching_rules": [...]}

    ``feed`` processes raw response bytes incrementally so billing extraction
    does not buffer the full body. The shared response streaming wrapper may
    still maintain a capped forensic ``stream_buffer`` independently. ``state``
    is a dict that accumulates:

    - ``data_count``: int — number of lines whose top-level ``data`` is a
      dict (one tweet per line). Lines whose ``data`` is an array or
      absent contribute 0 to this counter but still bump ``lines_parsed``.
    - ``includes``: dict[str, int] — running sum across all lines of
      ``len(includes.<key>)`` for known expansion keys and the first bounded
      set of safe unknown keys.
    - ``unknown_includes_overflow_count``: int — running sum of unknown
      include quantities that are unsafe for category emission or exceed the
      per-stream unknown-category budget.
    - ``lines_parsed``: int — JSON-parseable non-blank lines.
    - ``lines_failed``: int — lines that failed JSON validation or exceeded a
      single-line inspection bound.

    The parser keeps a ``line_buf`` holding the in-flight partial line across
    chunk boundaries. If a single line ever exceeds
    :data:`_MAX_NDJSON_LINE_BYTES`, the whole line is discarded until its
    terminating newline. Complete rows are validated with bounded selective
    extraction so unrelated fields are not materialized. ``finish`` finalizes a
    complete trailing line that arrived without a final ``\\n`` and treats
    malformed, incomplete, or inspection-bound-exceeding trailing data as a
    failed, unbilled line.
    """

    def __init__(self, on_row: Callable[[dict, int], None]) -> None:
        self.state: _NdjsonState = {
            "data_count": 0,
            "includes": {},
            "unknown_includes_overflow_count": 0,
            "lines_parsed": 0,
            "lines_failed": 0,
        }
        self._unknown_include_keys: set[str] = set()
        self._line_buf = bytearray()
        self._discarding_overlong_line = False
        self._finished = False
        self._on_row = on_row

    def feed(self, chunk: bytes) -> None:
        """Process one decoded response-body chunk."""
        start = 0
        while start < len(chunk):
            newline = chunk.find(b"\n", start)
            end = len(chunk) if newline == -1 else newline
            fragment_len = end - start

            if self._discarding_overlong_line:
                if newline == -1:
                    return
                self._discarding_overlong_line = False
                start = newline + 1
                continue

            if len(self._line_buf) + fragment_len > _MAX_NDJSON_LINE_BYTES:
                self._line_buf.clear()
                self.state["lines_failed"] += 1
                if newline == -1:
                    self._discarding_overlong_line = True
                    return
                start = newline + 1
                continue

            self._line_buf.extend(chunk[start:end])
            if newline == -1:
                return

            line = bytes(self._line_buf)
            self._line_buf.clear()
            self._parse_line(line)
            start = newline + 1

    def finish(self) -> None:
        """Finalize a complete trailing line that was not newline-terminated."""
        if self._finished:
            return
        self._finished = True
        if self._discarding_overlong_line:
            self._line_buf.clear()
            self._discarding_overlong_line = False
            return
        if not self._line_buf:
            return
        line = bytes(self._line_buf)
        self._line_buf.clear()
        self._parse_line(line)

    def _parse_line(self, raw_line: bytes) -> None:
        line = raw_line.rstrip(b"\r")
        if not line:
            return  # keep-alive blank line
        extractor = _create_x_ndjson_row_extractor()
        extractor.feed(line)
        extracted = extractor.finish()
        if not extracted.complete:
            self.state["lines_failed"] += 1
            return
        previous_includes = dict(self.state["includes"])
        previous_overflow = self.state["unknown_includes_overflow_count"]
        self.state["lines_parsed"] += 1
        if ("data",) in extracted.object_present:
            self.state["data_count"] += 1
        includes = extracted.wildcard_array_counts.get(("includes", "*"), {})
        for key, count in includes.items():
            self._record_include_count(key, count)
        self._on_row(
            {
                "body_parsed": True,
                "body_truncated": False,
                "body_format": "ndjson",
                "response_data_count": int(("data",) in extracted.object_present),
                "response_includes": {
                    key: count - previous_includes.get(key, 0)
                    for key, count in self.state["includes"].items()
                    if count > previous_includes.get(key, 0)
                },
                "response_unknown_includes_overflow_count": (
                    self.state["unknown_includes_overflow_count"] - previous_overflow
                ),
                "resource_identities": inspect_identities(line, ndjson=True),
                "observed_at": observed_at(),
            },
            self.state["lines_parsed"],
        )

    def _record_include_count(self, key: str, count: int) -> None:
        if count <= 0:
            return

        billing_category = include_billing_category(key)
        if billing_category.kind == "known":
            self.state["includes"][key] = self.state["includes"].get(key, 0) + count
            return

        if billing_category.kind == "synthetic" and (
            key in self._unknown_include_keys
            or len(self._unknown_include_keys) < MAX_UNKNOWN_INCLUDE_CATEGORIES
        ):
            self._unknown_include_keys.add(key)
            self.state["includes"][key] = self.state["includes"].get(key, 0) + count
            return

        self.state["unknown_includes_overflow_count"] += count


class _XJsonResponseExtractor:
    """Incrementally extract billing metadata from non-streaming X JSON."""

    def __init__(self) -> None:
        self._extractor = _create_x_json_selective_extractor()
        self._identity_body: bytearray | None = bytearray()

    def feed(self, chunk: bytes) -> None:
        self._extractor.feed(chunk)
        if self._identity_body is not None:
            if len(self._identity_body) + len(chunk) <= IDENTITY_BODY_LIMIT:
                self._identity_body.extend(chunk)
            else:
                self._identity_body = None

    def accepts_more_input(self) -> bool:
        """Return whether the document parser can still consume input."""

        return self._extractor.accepts_more_input()

    def finish(self) -> tuple[dict, str | None]:
        result: dict = {
            "body_parsed": False,
            "body_truncated": False,
            "observed_at": observed_at(),
        }
        extracted = self._extractor.finish()
        if not extracted.complete:
            return result, extracted.error
        if () not in extracted.object_present:
            return result, None

        result["body_parsed"] = True
        result.update(_parse_x_json_response_fields(extracted))
        result["resource_identities"] = inspect_identities(
            bytes(self._identity_body) if self._identity_body is not None else None
        )
        self._identity_body = None
        return result, None


def create_response_parser(
    flow: http.HTTPFlow,
    original_url: str,
    *,
    on_row: Callable[[dict, int], None],
) -> ConnectorResponseParser | None:
    """Create the X response-body parser needed for this flow, if any."""
    if not flow.response:
        return None

    status_code = flow.response.status_code
    if _HTTP_STATUS_OK_MIN <= status_code < _HTTP_STATUS_REDIRECT_MIN:
        # Use the dispatcher-required original URL so parser registration and
        # final request metadata cannot diverge.
        stream_path = urllib.parse.urlparse(original_url).path
        if is_stream_path(stream_path):
            extractor = _NdjsonExtractor(on_row)
            # Deliberately NOT "model_provider_usage" — that key routes through
            # report_model_provider_usage and triggers the model-provider webhook.
            # x_ndjson_state is only consumed by report_connector_usage.
            flow.metadata[metadata_keys.X_NDJSON_STATE] = extractor.state

            def finish_ndjson_decode_error(error: str) -> None:
                flow.metadata.pop(metadata_keys.X_NDJSON_STATE, None)
                flow.metadata[metadata_keys.X_JSON_STATE] = {
                    "body_parsed": False,
                    "body_truncated": False,
                    "body_format": "ndjson",
                    "parse_error": error,
                }

            return ConnectorResponseParser(
                feed=extractor.feed,
                report_on_interruption=True,
                finish=extractor.finish,
                finish_decode_error=finish_ndjson_decode_error,
            )

    if not (_HTTP_STATUS_OK_MIN <= status_code < _HTTP_STATUS_REDIRECT_MIN):
        return None

    extractor = _XJsonResponseExtractor()

    def finish_json_state() -> None:
        state, error = extractor.finish()
        if error:
            state["parse_error"] = error
        flow.metadata[metadata_keys.X_JSON_STATE] = state

    def finish_json_decode_error(error: str) -> None:
        flow.metadata[metadata_keys.X_JSON_STATE] = {
            "body_parsed": False,
            "body_truncated": False,
            "parse_error": error,
        }

    return ConnectorResponseParser(
        feed=extractor.feed,
        report_on_interruption=False,
        finish=finish_json_state,
        finish_decode_error=finish_json_decode_error,
        should_continue=extractor.accepts_more_input,
    )
