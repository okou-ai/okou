"""Pure, bounded acceptance policy for immutable Codex catalog responses.

The cache owns flow state, worker admission, cancellation and result publication.
This module reads only its input values and fixed policy; it retains no cache state.
Header preflight and completed-snapshot validation share these same rules.
"""

import json
import math
from dataclasses import dataclass, field
from typing import NoReturn

from mitmproxy import http

import body_decoding
import content_encoding
import content_length
import http_header_syntax

MAX_ENTRY_BYTES = 1024 * 1024
_MAX_RESPONSE_CACHE_POLICY_FIELDS = 8 * 1024
_MAX_RESPONSE_CACHE_POLICY_VALUE_BYTES = 8 * 1024
_MAX_RESPONSE_ETAG_FIELDS = 8 * 1024
_MAX_RESPONSE_ETAG_VALUE_BYTES = 8 * 1024
_MAX_ETAG_BYTES = 512
_RAW_CONTENT_TYPE = b"content-type"
_MAX_CONTENT_TYPE_FIELDS = 8 * 1024
_MAX_CONTENT_TYPE_BYTES = 256
_MAX_JSON_NESTING = 128
_MIN_QUOTED_ETAG_BYTES = 2
ASCII_CONTROL_BOUNDARY = 0x20
ASCII_DELETE = 0x7F
_HTTP_STATUS_OK = 200
BROTLI_ENCODING = "br"
IDENTITY_ENCODING = "identity"
_UNSAFE_RESPONSE_CACHE_CONTROL = frozenset(
    (
        "must-revalidate",
        "no-cache",
        "no-store",
        "proxy-revalidate",
        "max-age",
        "s-maxage",
        "no-transform",
    )
)


@dataclass(frozen=True)
class ResponseValidationSnapshot:
    status_code: int
    header_fields: tuple[tuple[bytes, bytes], ...] = field(repr=False)
    has_trailers: bool
    body: bytes = field(repr=False)
    upstream_encoding: str | None
    compressed_content_length: int | None


@dataclass(frozen=True)
class ValidatedResponse:
    body: bytes = field(repr=False)
    content_type: str
    etag: str = field(repr=False)


def _strict_utf8_bytes(value: str) -> bytes | None:
    try:
        return value.encode()
    except UnicodeEncodeError:
        return None


def usable_etag_value(value: str) -> str | None:
    value = value.strip()
    if not value or value == "*":
        return None
    encoded = _strict_utf8_bytes(value)
    if encoded is None or len(encoded) > _MAX_ETAG_BYTES:
        return None
    opaque = value[2:] if value.startswith("W/") else value
    if (
        len(opaque) < _MIN_QUOTED_ETAG_BYTES
        or not opaque.startswith('"')
        or not opaque.endswith('"')
        or any(
            character == '"'
            or ord(character) <= ASCII_CONTROL_BOUNDARY
            or ord(character) == ASCII_DELETE
            for character in opaque[1:-1]
        )
    ):
        return None
    return value


def _single_usable_etag(headers: http.Headers) -> str | None:
    raw_value = http_header_syntax.single_header_value(
        headers.fields,
        b"etag",
        max_fields=_MAX_RESPONSE_ETAG_FIELDS,
        max_value_bytes=_MAX_RESPONSE_ETAG_VALUE_BYTES,
    )
    if raw_value is None:
        return None
    return usable_etag_value(raw_value.decode("utf-8", "surrogateescape"))


def single_content_encoding(values: tuple[str, ...]) -> str | None:
    if not values:
        return IDENTITY_ENCODING
    tokens = [
        token.strip().lower() for value in values for token in value.split(",") if token.strip()
    ]
    if len(tokens) != 1:
        return None
    return tokens[0]


def _response_cache_control_is_unsafe(headers: http.Headers) -> bool:
    """Decline optional storage before decoding any policy values on exhaustion."""
    fields = headers.fields
    if len(fields) > _MAX_RESPONSE_CACHE_POLICY_FIELDS:
        return True

    policy_fields: list[tuple[bytes, bytes]] = []
    remaining_bytes = _MAX_RESPONSE_CACHE_POLICY_VALUE_BYTES
    for raw_name, raw_value in fields:
        if len(raw_name) not in (len(b"cache-control"), len(b"pragma"), len(b"expires")):
            continue
        name = raw_name.lower()
        if name == b"expires":
            return True
        if name not in (b"cache-control", b"pragma"):
            continue
        if len(raw_value) > remaining_bytes:
            return True
        remaining_bytes -= len(raw_value)
        policy_fields.append((name, raw_value))

    # Values stay separate: only their raw bytes consume the aggregate budget.
    # Preserve mitmproxy's decoding and the existing string whitespace rules.
    for name, raw_value in policy_fields:
        value = raw_value.decode("utf-8", "surrogateescape")
        start = 0
        while start < len(value):
            end = value.find(",", start)
            if end == -1:
                end = len(value)
            token = value[start:end]
            if name == b"cache-control":
                if token.partition("=")[0].strip().lower() in _UNSAFE_RESPONSE_CACHE_CONTROL:
                    return True
            elif token.strip().lower() == "no-cache":
                return True
            start = end + 1
    return False


def _bounded_content_type(headers: http.Headers) -> str | None:
    """Preflight all raw values and folding separators before converting any value."""
    values = http_header_syntax.bounded_header_values(
        headers.fields,
        _RAW_CONTENT_TYPE,
        max_fields=_MAX_CONTENT_TYPE_FIELDS,
        max_value_bytes=_MAX_CONTENT_TYPE_BYTES,
        separator_bytes=len(", "),
    )
    if values is None:
        return None
    try:
        return ", ".join(value.decode("utf-8") for value in values)
    except UnicodeDecodeError:
        return None


def _content_type_is_json(content_type: str) -> bool:
    media_type = content_type.partition(";")[0].strip().lower()
    return media_type == "application/json" or (
        media_type.startswith("application/") and media_type.endswith("+json")
    )


def _reject_non_json_constant(_value: str) -> NoReturn:
    raise ValueError("non-standard JSON constant")


def _parse_finite_json_float(value: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed):
        raise ValueError("non-finite JSON number")
    return parsed


def _json_nesting_is_bounded(document: str) -> bool:
    depth = 0
    in_string = False
    escaped = False
    for character in document:
        if in_string:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            continue
        if character == '"':
            in_string = True
        elif character in "[{":
            depth += 1
            if depth > _MAX_JSON_NESTING:
                return False
        elif character in "]}":
            depth -= 1
    return True


def parse_content_length(headers: http.Headers) -> content_length.ContentLengthResult:
    return content_length.parse(
        headers.get_all("Content-Length"),
        max_value=MAX_ENTRY_BYTES,
    )


def response_headers_bypass_reason(
    status_code: int,
    headers: http.Headers,
    *,
    allow_brotli: bool = False,
) -> str | None:
    if status_code != _HTTP_STATUS_OK:
        return "response_status"
    encoding_values = content_encoding.read_values(headers)
    if encoding_values is None:
        return "response_encoding"
    encoding = single_content_encoding(encoding_values)
    if encoding != IDENTITY_ENCODING and not (allow_brotli and encoding == BROTLI_ENCODING):
        return "response_encoding"
    content_type = _bounded_content_type(headers)
    if content_type is None or not _content_type_is_json(content_type):
        return "response_content_type"
    if _response_cache_control_is_unsafe(headers):
        return "response_cache_control"
    for name, _ in headers.fields:
        if len(name) == len(b"vary") and name.lower() == b"vary":
            return "response_vary"
    if _single_usable_etag(headers) is None:
        return "response_etag"
    parsed_content_length = parse_content_length(headers)
    if parsed_content_length.kind not in ("missing", "valid") or (
        parsed_content_length.kind == "valid" and headers.get_all("Transfer-Encoding")
    ):
        return "response_size"
    return None


def validate_response_snapshot(
    snapshot: ResponseValidationSnapshot,
) -> ValidatedResponse | str:
    headers = http.Headers(snapshot.header_fields)
    body = snapshot.body
    if snapshot.upstream_encoding == BROTLI_ENCODING:
        if (
            snapshot.compressed_content_length is not None
            and len(body) != snapshot.compressed_content_length
        ) or snapshot.has_trailers:
            return "response_body"
        body, decode_error = body_decoding.decompress_json_usage_body(
            body,
            headers,
            max_output=MAX_ENTRY_BYTES,
        )
        if decode_error == body_decoding.DECODED_BODY_LIMIT_EXCEEDED:
            return "response_size"
        if decode_error is not None:
            return "response_encoding"

    bypass_reason = response_headers_bypass_reason(
        snapshot.status_code,
        headers,
        allow_brotli=snapshot.upstream_encoding == BROTLI_ENCODING,
    )
    if bypass_reason is not None:
        return bypass_reason
    if snapshot.has_trailers:
        return "response_body"

    parsed_content_length = parse_content_length(headers)
    if (
        snapshot.upstream_encoding == IDENTITY_ENCODING
        and parsed_content_length.kind == "valid"
        and parsed_content_length.value != len(body)
    ):
        return "response_body"
    try:
        document = body.decode("utf-8")
    except UnicodeDecodeError:
        return "response_json"
    if not _json_nesting_is_bounded(document):
        return "response_json"
    try:
        payload = json.loads(
            document,
            parse_constant=_reject_non_json_constant,
            parse_float=_parse_finite_json_float,
        )
    except ValueError, RecursionError:
        return "response_json"
    if not isinstance(payload, dict) or not isinstance(payload.get("models"), list):
        return "response_shape"
    content_type = headers.get("Content-Type", "")
    etag = _single_usable_etag(headers)
    if etag is None:
        return "response_etag"
    return ValidatedResponse(body=body, content_type=content_type, etag=etag)
