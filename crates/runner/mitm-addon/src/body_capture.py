"""Capture-mode header/body sanitization for persistent network logs."""

import base64
import re
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
from itertools import islice
from typing import Literal

from mitmproxy import http

import body_decoding
import flow_metadata_keys as metadata_keys
import request_streaming
import response_streaming
from body_limits import BODY_CAPTURE_LIMIT

_REDACTED_HEADER_VALUE = "***"

_TEXT_APPLICATION_SUBTYPES = frozenset(
    {
        "graphql",
        "javascript",
        "json",
        "json-seq",
        "x-ndjson",
        "x-www-form-urlencoded",
        "xml",
    }
)

_HTTP_FIELD_NAME_PATTERN = re.compile(r"[!#$%&'*+\-.^_`|~0-9A-Za-z]+")
# RFC 6838 section 4.2 limits registered media type names to 127 ASCII characters.
_MEDIA_TYPE_NAME_PATTERN = re.compile(r"[0-9A-Za-z][!#$&+\-.^_0-9A-Za-z]{0,126}")
_HTTP_KNOWN_CONTENT_CODING_PATTERN = r"(?:br|compress|deflate|gzip|identity|zstd)"
_HTTP_OPTIONAL_WHITESPACE_PATTERN = r"[ \t]*"
_HTTP_ENCODING_PATTERN = (
    rf"(?:{_HTTP_KNOWN_CONTENT_CODING_PATTERN}|\*)"
    rf"(?:{_HTTP_OPTIONAL_WHITESPACE_PATTERN};"
    rf"{_HTTP_OPTIONAL_WHITESPACE_PATTERN}q="
    r"(?:0(?:\.[0-9]{1,3})?|1(?:\.0{1,3})?))?"
)
_HTTP_IMF_FIXDATE_PATTERN = re.compile(
    r"(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), "
    r"(?:0[1-9]|[12][0-9]|3[01]) "
    r"(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) "
    r"[0-9]{4} "
    r"(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9] GMT"
)
_UNSAFE_CAPTURE_HEADER_VALUE_CHARS = re.compile(r"[\x00-\x08\x0A-\x1F\x7F]")
_HTTP_OPTIONAL_WHITESPACE = " \t"
_MAX_CAPTURE_HEADER_NAME_LENGTH = 256
_MAX_CAPTURE_HEADER_VALUE_TO_PRESERVE = 256
_MAX_CAPTURE_HEADER_FIELDS = 512
_MAX_CAPTURE_HEADER_BYTES = 32 * 1024
_MAX_CAPTURE_HEADER_INSPECTION_FIELDS = 2_048
_CAPTURE_HEADER_FOLD_SEPARATOR_BYTES = len(b", ")
_BODY_CAPTURE_DEPENDENCY_HEADER_NAMES = frozenset(
    {
        b"content-encoding",
        b"content-type",
    }
)
_BODY_CAPTURE_DEPENDENCY_HEADER_NAME_LENGTHS = frozenset(
    len(name) for name in _BODY_CAPTURE_DEPENDENCY_HEADER_NAMES
)
_REDACTED_HEADER_NAME = "[redacted-header-name]"
_VALUE_PRESERVING_CAPTURE_CONTENT_TYPES = frozenset(
    {
        "application/graphql",
        "application/javascript",
        "application/json",
        "application/octet-stream",
        "application/pdf",
        "application/x-ndjson",
        "application/x-www-form-urlencoded",
        "application/xml",
        "image/gif",
        "image/jpeg",
        "image/png",
        "image/webp",
        "multipart/form-data",
        "text/csv",
        "text/event-stream",
        "text/html",
        "text/plain",
        "text/xml",
    }
)
_MAX_CAPTURE_CONTENT_TYPE_MEDIA_TYPE_LENGTH = max(
    len(media_type) for media_type in _VALUE_PRESERVING_CAPTURE_CONTENT_TYPES
)

# Captured header values are untrusted persistent-log data by default. Preserve
# only low-risk protocol metadata that matches conservative HTTP value shapes.
_VALUE_PRESERVING_CAPTURE_HEADER_PATTERNS: dict[str, re.Pattern[str]] = {
    "accept-encoding": re.compile(
        rf"{_HTTP_ENCODING_PATTERN}"
        rf"(?:{_HTTP_OPTIONAL_WHITESPACE_PATTERN},"
        rf"{_HTTP_OPTIONAL_WHITESPACE_PATTERN}{_HTTP_ENCODING_PATTERN})*",
        re.IGNORECASE | re.ASCII,
    ),
    "content-encoding": re.compile(
        rf"{_HTTP_KNOWN_CONTENT_CODING_PATTERN}"
        rf"(?:{_HTTP_OPTIONAL_WHITESPACE_PATTERN},"
        rf"{_HTTP_OPTIONAL_WHITESPACE_PATTERN}{_HTTP_KNOWN_CONTENT_CODING_PATTERN})*",
        re.IGNORECASE | re.ASCII,
    ),
    "content-length": re.compile(r"(?:0|[1-9][0-9]{0,18})"),
}


def _is_text_content(content_type: str) -> bool:
    """Check if content-type indicates text-like content worth capturing."""
    if not content_type:
        return True  # assume text when unspecified
    media_type = content_type.partition(";")[0].strip()
    type_name, separator, subtype_name = media_type.partition("/")
    if (
        separator != "/"
        or _MEDIA_TYPE_NAME_PATTERN.fullmatch(type_name) is None
        or _MEDIA_TYPE_NAME_PATTERN.fullmatch(subtype_name) is None
    ):
        return False

    normalized_type = type_name.lower()
    normalized_subtype = subtype_name.lower()
    return (
        normalized_type == "text"
        or (normalized_type == "application" and normalized_subtype in _TEXT_APPLICATION_SUBTYPES)
        or normalized_subtype.endswith("+json")
    )


def _encode_body(
    content: bytes,
    content_type: str,
    *,
    truncated_at_limit: bool = False,
) -> tuple[str | None, str | None]:
    """Encode an exact bounded body prefix without losing invalid bytes.

    A known limit-truncated prefix may omit only a terminal incomplete UTF-8
    sequence. Every other UTF-8 error preserves the exact prefix as base64.
    """
    if not _is_text_content(content_type):
        return None, None  # skip binary bodies
    try:
        return content.decode("utf-8"), "utf-8"
    except UnicodeDecodeError as error:
        if (
            truncated_at_limit
            and error.end == len(content)
            and error.reason == "unexpected end of data"
        ):
            return content[: error.start].decode("utf-8"), "utf-8"
        return base64.b64encode(content).decode("ascii"), "base64"


def _is_http_date_header_value(value: str) -> bool:
    if _HTTP_IMF_FIXDATE_PATTERN.fullmatch(value) is None:
        return False
    try:
        parsedate_to_datetime(value)
    except (TypeError, ValueError, IndexError, OverflowError):
        return False
    return True


def _sanitize_content_type_for_capture(value: str) -> str | None:
    media_start: int | None = None
    media_end = 0
    optional_whitespace_length = 0

    for index, char in enumerate(value):
        if char in "\r\n":
            return None
        if char == ";":
            return _preserved_capture_content_type(value, media_start, media_end)
        if media_start is None:
            if char in _HTTP_OPTIONAL_WHITESPACE:
                optional_whitespace_length += 1
                if optional_whitespace_length > _MAX_CAPTURE_HEADER_VALUE_TO_PRESERVE:
                    return None
                continue
            media_start = index
            optional_whitespace_length = 0
        if char in _HTTP_OPTIONAL_WHITESPACE:
            optional_whitespace_length += 1
            if optional_whitespace_length > _MAX_CAPTURE_HEADER_VALUE_TO_PRESERVE:
                return None
            continue
        optional_whitespace_length = 0
        media_end = index + 1
        if media_end - media_start > _MAX_CAPTURE_CONTENT_TYPE_MEDIA_TYPE_LENGTH:
            return None

    if media_start is None or media_end == media_start:
        return None
    return _preserved_capture_content_type(value, media_start, media_end)


def _preserved_capture_content_type(
    value: str,
    media_start: int | None,
    media_end: int,
) -> str | None:
    if media_start is None or media_end == media_start:
        return None
    media_type = value[media_start:media_end].lower()
    if media_type not in _VALUE_PRESERVING_CAPTURE_CONTENT_TYPES:
        return None
    return media_type


def _sanitize_allowed_capture_header_value(name: str, value: str) -> str | None:
    normalized_name = name.strip().lower()

    if normalized_name == "content-type":
        return _sanitize_content_type_for_capture(value)

    pattern = _VALUE_PRESERVING_CAPTURE_HEADER_PATTERNS.get(normalized_name)
    if normalized_name != "date" and pattern is None:
        return None

    if len(value) > _MAX_CAPTURE_HEADER_VALUE_TO_PRESERVE:
        return None
    if _UNSAFE_CAPTURE_HEADER_VALUE_CHARS.search(value) is not None:
        return None
    normalized_value = value.strip(_HTTP_OPTIONAL_WHITESPACE)
    if normalized_name == "date":
        return normalized_value if _is_http_date_header_value(normalized_value) else None

    if pattern is None:
        return None
    if pattern.fullmatch(normalized_value) is None:
        return None
    return normalized_value


def _sanitize_header_value_for_capture(name: str, value: str) -> str:
    return _sanitize_allowed_capture_header_value(name, value) or _REDACTED_HEADER_VALUE


def _sanitize_header_name_for_capture(name: str) -> str:
    if len(name) > _MAX_CAPTURE_HEADER_NAME_LENGTH:
        return _REDACTED_HEADER_NAME
    if _HTTP_FIELD_NAME_PATTERN.fullmatch(name) is None:
        return _REDACTED_HEADER_NAME
    return name


@dataclass(frozen=True)
class _CaptureHeaderInspection:
    serialized: dict[str, str]
    serialized_truncated: bool
    body_dependency_headers: http.Headers | None


def _has_valid_body_capture_content_type(headers: http.Headers) -> bool:
    values = headers.get_all("content-type")
    if not values:
        return True
    if len(values) != 1:
        return False

    value = values[0]
    if _UNSAFE_CAPTURE_HEADER_VALUE_CHARS.search(value) is not None:
        return False
    media_type = value.partition(";")[0].strip(_HTTP_OPTIONAL_WHITESPACE)
    type_name, separator, subtype_name = media_type.partition("/")
    return (
        separator == "/"
        and _MEDIA_TYPE_NAME_PATTERN.fullmatch(type_name) is not None
        and _MEDIA_TYPE_NAME_PATTERN.fullmatch(subtype_name) is not None
    )


def _has_valid_body_capture_content_encoding(headers: http.Headers) -> bool:
    values = headers.get_all("content-encoding")
    if not values:
        return True

    folded_value = ", ".join(values)
    if _UNSAFE_CAPTURE_HEADER_VALUE_CHARS.search(folded_value) is not None:
        return False
    for raw_coding in folded_value.split(","):
        coding = raw_coding.strip(_HTTP_OPTIONAL_WHITESPACE)
        if not coding or _HTTP_FIELD_NAME_PATTERN.fullmatch(coding) is None:
            return False
    return True


def _has_valid_body_capture_dependencies(headers: http.Headers) -> bool:
    if not _has_valid_body_capture_content_type(headers):
        return False
    return _has_valid_body_capture_content_encoding(headers)


def _body_capture_dependency_header_name(raw_name: bytes) -> bytes | None:
    if len(raw_name) not in _BODY_CAPTURE_DEPENDENCY_HEADER_NAME_LENGTHS:
        return None
    normalized_name = raw_name.lower()
    if normalized_name not in _BODY_CAPTURE_DEPENDENCY_HEADER_NAMES:
        return None
    return normalized_name


def _inspect_headers_for_capture(
    headers: http.Headers, *, inspect_body_dependencies: bool = True
) -> _CaptureHeaderInspection:
    """Inspect bounded serialization and body dependencies before string access.

    Serialization stops decoding at its prefix limit. Body dependencies require
    a complete scan within the total raw-field limit, including unrelated fields.
    The raw tuple length detects exhaustion without traversing its tail. When
    discovery cannot finish or no body needs capture, only serialize the prefix.
    """
    result: dict[str, str] = {}
    seen_names: set[str] = set()
    dependency_fields: list[tuple[bytes, bytes]] = []
    dependency_names: set[bytes] = set()
    dependency_bytes = 0
    dependency_field_count = 0
    dependencies_within_budget = (
        inspect_body_dependencies and len(headers.fields) <= _MAX_CAPTURE_HEADER_INSPECTION_FIELDS
    )
    captured_bytes = 0
    serialized_truncated = False
    for index, (raw_name, raw_value) in enumerate(
        islice(headers.fields, _MAX_CAPTURE_HEADER_INSPECTION_FIELDS)
    ):
        if not serialized_truncated:
            field_bytes = len(raw_name) + len(raw_value)
            if (
                index >= _MAX_CAPTURE_HEADER_FIELDS
                or field_bytes > _MAX_CAPTURE_HEADER_BYTES - captured_bytes
            ):
                serialized_truncated = True
            else:
                captured_bytes += field_bytes
                name = raw_name.decode("utf-8", "surrogateescape")
                value = raw_value.decode("utf-8", "surrogateescape")
                captured_name = _sanitize_header_name_for_capture(name)
                case_insensitive_name = captured_name.lower()
                if case_insensitive_name not in seen_names:
                    seen_names.add(case_insensitive_name)
                    result[captured_name] = _sanitize_header_value_for_capture(captured_name, value)

        normalized_raw_name = (
            _body_capture_dependency_header_name(raw_name) if dependencies_within_budget else None
        )
        if normalized_raw_name is not None:
            fold_separator_bytes = (
                _CAPTURE_HEADER_FOLD_SEPARATOR_BYTES
                if normalized_raw_name in dependency_names
                else 0
            )
            dependency_bytes += len(raw_value) + fold_separator_bytes
            dependency_field_count += 1
            if (
                dependency_field_count > _MAX_CAPTURE_HEADER_FIELDS
                or dependency_bytes > _MAX_CAPTURE_HEADER_BYTES
            ):
                dependencies_within_budget = False
            else:
                dependency_fields.append((raw_name, raw_value))
            dependency_names.add(normalized_raw_name)

        if serialized_truncated and not dependencies_within_budget:
            break

    if not dependencies_within_budget:
        return _CaptureHeaderInspection(result, serialized_truncated, None)

    dependency_headers = http.Headers(dependency_fields)
    if not _has_valid_body_capture_dependencies(dependency_headers):
        dependency_headers = None
    return _CaptureHeaderInspection(result, serialized_truncated, dependency_headers)


def _sanitize_headers_for_capture(headers: http.Headers) -> tuple[dict[str, str], bool]:
    """Build a bounded header prefix safe for persistent network logs."""
    inspection = _inspect_headers_for_capture(headers, inspect_body_dependencies=False)
    return inspection.serialized, inspection.serialized_truncated


def _set_body_capture_failure(
    log_entry: dict,
    side: Literal["request", "response"],
    body: bytes,
    *,
    truncated: bool = False,
) -> None:
    if truncated:
        log_entry[f"{side}_body_truncated"] = True
    if body:
        log_entry[f"{side}_body_encoding"] = "binary"


def _set_body_fields(
    log_entry: dict,
    side: Literal["request", "response"],
    body: bytes,
    content_type: str,
    *,
    already_truncated: bool = False,
    truncated_at_limit: bool = False,
) -> None:
    body_exceeds_limit = len(body) > BODY_CAPTURE_LIMIT
    truncated = already_truncated or truncated_at_limit or body_exceeds_limit
    if truncated:
        # Truncation describes capture completeness, even when no body string is emitted.
        log_entry[f"{side}_body_truncated"] = True

    if not body:
        return

    bounded_body = body[:BODY_CAPTURE_LIMIT]
    encoded, encoding = _encode_body(
        bounded_body,
        content_type,
        truncated_at_limit=(truncated_at_limit or body_exceeds_limit)
        and len(body) >= BODY_CAPTURE_LIMIT,
    )
    if encoded is None:
        log_entry[f"{side}_body_encoding"] = "binary"
        return

    log_entry[f"{side}_body"] = encoded
    log_entry[f"{side}_body_encoding"] = encoding


def add_capture_fields(
    flow: http.HTTPFlow,
    log_entry: dict,
    *,
    response_incomplete: bool = False,
) -> None:
    """Add capture-mode request/response fields to ``log_entry`` in place.

    # [NETWORK_LOG_FIELDS] — capture-only fields in the shared network log schema.
    # Fields: request_headers, request_headers_truncated, request_body,
    #         request_body_encoding, request_body_truncated, response_headers,
    #         response_headers_truncated, response_body, response_body_encoding,
    #         response_body_truncated

    Capture is an opt-in persistent-log boundary. Header values are redacted by
    default; only constrained protocol metadata is preserved: normalized
    allowlisted ``content-type`` media types (with parameters removed), valid
    ``accept-encoding`` and ``content-encoding`` codings, decimal
    ``content-length``, and valid IMF-fixdate ``date`` values. Unsafe,
    malformed, or overlong values are represented as ``***``. Header names
    must be HTTP field-name-shaped and at most 256 characters; invalid or
    overlong names are represented as ``[redacted-header-name]``. Only the
    first case-insensitive occurrence of each captured name is retained.

    Each serialized header map is a prefix bounded to 512 fields and 32 KiB of
    raw name/value bytes. ``*_headers_truncated`` means that this serialized
    prefix did not contain every header field; it does not describe body
    capture. Total inspection is capped at 2,048 raw fields per side, including
    unrelated fields. Body dependencies require a complete scan within that
    limit and retain their separate 512-field and 32-KiB value budgets. Dependency
    discovery is skipped when no body bytes need capture or the raw field count
    exceeds the limit; a partial scan must not imply absent metadata. Within
    the limit, dependencies after the serialized prefix still apply to body
    capture. Multiple ``content-type`` values are ambiguous, while repeated
    ``content-encoding`` fields are folded
    and validated. Malformed, unsafe, or over-budget dependency metadata fails
    body capture closed.

    Bodies are bounded by ``BODY_CAPTURE_LIMIT`` (currently 64 KiB) after
    decoding. Empty bodies have no body or encoding field. Text-like bodies are
    emitted as UTF-8 when valid, or as base64 when invalid bytes must be
    preserved. Non-text bodies, failed decoding, and invalid body dependencies
    omit the body and use ``binary`` when a non-empty body was observed.
    ``*_body_truncated`` records incomplete, suppressed, stream-truncated, or
    body-size-limited capture and is independent of whether a body string is
    emitted. A terminal incomplete UTF-8 sequence caused by the size limit is
    removed so the bounded prefix can remain UTF-8; other invalid prefixes use
    base64.

    Request bodies prefer request streaming metadata when requestheaders()
    installed a safe capped stream before mitmproxy buffered the body.

    ``response_incomplete`` marks response capture as semantically incomplete
    when a terminal error interrupts delivery. It is separate from the stream
    buffer's size-limit truncation state so an arbitrary interrupted UTF-8
    prefix preserves its exact bytes.

    Response bodies prefer streaming metadata from
    ``response_streaming.configure_response_stream()`` because that path keeps a
    bounded raw wire-byte buffer and records whether it was truncated. Bounded
    ``flow.response.raw_content`` decoding is used only when no stream
    buffer metadata exists. These sources intentionally use different decode
    policies: retained stream buffers use best-effort ``decompress_body()``,
    which can preserve original wire bytes or partial decoded output after a
    decode problem, while buffered ``raw_content`` uses the strict
    ``decode_response_body_for_network_log_capture()`` helper. A strict
    ``None`` result omits a non-empty buffered body and marks it ``binary``;
    ``b""`` remains a successful empty result with no body field.
    """
    request_body_suppressed = bool(flow.metadata.get(metadata_keys.SUPPRESS_REQUEST_BODY_CAPTURE))
    request_stream_body = (
        None if request_body_suppressed else request_streaming.captured_request_stream_body(flow)
    )
    # Request headers (always available)
    request_inspection = _inspect_headers_for_capture(
        flow.request.headers,
        inspect_body_dependencies=not request_body_suppressed
        and bool(
            request_stream_body.buffer
            if request_stream_body is not None
            else flow.request.raw_content
        ),
    )
    log_entry["request_headers"] = request_inspection.serialized
    if request_inspection.serialized_truncated:
        log_entry["request_headers_truncated"] = True

    # Request body
    if request_body_suppressed:
        log_entry["request_body_truncated"] = True
    else:
        if request_stream_body is not None:
            request_stream_incomplete = (
                flow.metadata.get(metadata_keys.REQUEST_STREAM_COMPLETE) is not True
            )
            raw_request_body = bytes(request_stream_body.buffer)
            request_dependency_headers = request_inspection.body_dependency_headers
            if request_dependency_headers is None:
                _set_body_capture_failure(
                    log_entry,
                    "request",
                    raw_request_body,
                    truncated=request_stream_body.truncated or request_stream_incomplete,
                )
            else:
                req_ct = request_dependency_headers.get("content-type", "")
                request_body = body_decoding.decode_request_body_for_network_log_capture(
                    raw_request_body,
                    request_dependency_headers,
                    max_output=BODY_CAPTURE_LIMIT + 1,
                )
                if request_body is None:
                    _set_body_capture_failure(
                        log_entry,
                        "request",
                        raw_request_body,
                        truncated=request_stream_body.truncated or request_stream_incomplete,
                    )
                else:
                    _set_body_fields(
                        log_entry,
                        "request",
                        request_body,
                        req_ct,
                        already_truncated=request_stream_incomplete,
                        truncated_at_limit=request_stream_body.truncated,
                    )
        elif flow.request.raw_content:
            request_dependency_headers = request_inspection.body_dependency_headers
            if request_dependency_headers is None:
                _set_body_capture_failure(log_entry, "request", flow.request.raw_content)
            else:
                req_ct = request_dependency_headers.get("content-type", "")
                request_body = body_decoding.decode_request_body_for_network_log_capture(
                    flow.request.raw_content,
                    request_dependency_headers,
                    max_output=BODY_CAPTURE_LIMIT + 1,
                )
                if request_body is None:
                    log_entry["request_body_encoding"] = "binary"
                else:
                    _set_body_fields(log_entry, "request", request_body, req_ct)

    # Response headers
    if flow.response:
        stream_body = response_streaming.captured_response_stream_body(flow)
        stream_truncated = False
        if stream_body is not None:
            stream_truncated = stream_body.truncated
            raw_response_body = bytes(stream_body.buffer)
        else:
            raw_response_body = flow.response.raw_content
        response_inspection = _inspect_headers_for_capture(
            flow.response.headers, inspect_body_dependencies=bool(raw_response_body)
        )
        log_entry["response_headers"] = response_inspection.serialized
        if response_inspection.serialized_truncated:
            log_entry["response_headers_truncated"] = True
        if raw_response_body is None:
            return

        response_dependency_headers = response_inspection.body_dependency_headers
        if response_dependency_headers is None:
            _set_body_capture_failure(
                log_entry,
                "response",
                raw_response_body,
                truncated=stream_truncated or response_incomplete,
            )
            return

        if stream_body is not None:
            body = body_decoding.decompress_body(
                raw_response_body,
                response_dependency_headers,
                max_output=BODY_CAPTURE_LIMIT + 1,
            )
        else:
            body = body_decoding.decode_response_body_for_network_log_capture(
                raw_response_body,
                response_dependency_headers,
                max_output=BODY_CAPTURE_LIMIT + 1,
            )
        if body is None:
            _set_body_capture_failure(
                log_entry,
                "response",
                raw_response_body,
                truncated=stream_truncated or response_incomplete,
            )
            return
        res_ct = response_dependency_headers.get("content-type", "")
        # Also check decompressed size in case it expanded beyond the limit.
        _set_body_fields(
            log_entry,
            "response",
            body,
            res_ct,
            already_truncated=response_incomplete,
            truncated_at_limit=stream_truncated,
        )
