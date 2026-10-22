"""Bounded JSON prefix probing helpers."""

import json
from dataclasses import dataclass
from typing import Literal

TopLevelStringFieldProbeStatus = Literal[
    "found",
    "not_found",
    "incomplete",
    "invalid",
    "non_string",
    "bound_exceeded",
]

_JSON_CONTROL_CHAR_MAX = 0x20
_JSON_HEX_BYTES = frozenset(b"0123456789abcdefABCDEF")
_JSON_WHITESPACE = b" \t\r\n"
_UTF8_SURROGATE_MIN = 0xD800
_UTF8_SURROGATE_MAX = 0xDFFF


@dataclass(frozen=True)
class TopLevelStringFieldProbeResult:
    """Result of probing a JSON object prefix for a top-level string member.

    Status values form the caller-visible contract:

    - ``found``: the first matching top-level member has a complete string value.
    - ``not_found``: a complete top-level object ended before a matching member.
    - ``incomplete``: more bytes are needed before the probe can decide.
    - ``invalid``: the prefix already violates the JSON structure accepted here.
    - ``non_string``: the matching member's value starts with a non-string token.
    - ``bound_exceeded``: a configured key, string, or depth bound stopped probing.

    ``field_seen`` is true only after the first matching top-level member's
    key-colon boundary has been recognized, so the status describes that
    member's value. A bare matching key token without a colon is not seen.
    Matching is top-level only, nested members are skipped, the first duplicate
    wins, and skipped values can still stop probing with ``bound_exceeded``.
    """

    status: TopLevelStringFieldProbeStatus
    value: str | None = None
    field_seen: bool = False


@dataclass(frozen=True)
class _IndexResult:
    status: Literal["ok", "incomplete", "invalid", "bound_exceeded"]
    index: int = 0


@dataclass(frozen=True)
class _StringResult:
    status: Literal["ok", "incomplete", "invalid", "bound_exceeded"]
    value: str | None = None
    index: int = 0


def probe_top_level_string_field(
    body: bytes,
    field_name: str = "type",
    *,
    max_depth: int = 256,
    max_key_bytes: int = 1024,
    max_string_bytes: int = 1024,
) -> TopLevelStringFieldProbeResult:
    """Probe a bounded JSON object prefix for the first top-level string field.

    This is a prefix prefilter, not a complete JSON validator. The probe
    inspects the syntax needed to reach the first matching top-level
    ``field_name``. Once that field's string value is complete, it returns
    ``found`` without scanning or validating trailing bytes. Syntax before
    that value is still inspected; callers that require payload validity must
    perform an authoritative parse of the complete payload after probing.

    Matching is top-level only. Nested fields are skipped, and the first
    duplicate top-level field wins. ``field_seen`` becomes true at the first
    matching key-colon boundary, before the value is classified.

    Args:
        body: JSON bytes or a JSON prefix to inspect.
        field_name: Top-level field name to find.
        max_depth: Bound on nested object and array traversal while skipping
            values before the target field.
        max_key_bytes: Maximum raw bytes scanned in each JSON object key.
        max_string_bytes: Maximum raw bytes scanned in each JSON string value,
            including strings in values skipped before the target.

    All three bounds must be positive integers. Non-integers, including
    booleans, raise ``TypeError``; non-positive integers raise ``ValueError``.
    Exceeding a bound while inspecting earlier keys or values can prevent the
    target field from being reached and returns ``bound_exceeded``.
    """

    _validate_positive_int("max_depth", max_depth)
    _validate_positive_int("max_key_bytes", max_key_bytes)
    _validate_positive_int("max_string_bytes", max_string_bytes)

    i = _skip_json_whitespace(body, 0)
    if i >= len(body):
        return TopLevelStringFieldProbeResult("incomplete")
    if body[i] != ord("{"):
        return TopLevelStringFieldProbeResult("invalid")

    i = _skip_json_whitespace(body, i + 1)
    if i >= len(body):
        return TopLevelStringFieldProbeResult("incomplete")
    if body[i] == ord("}"):
        return _finish_not_found_object(body, i + 1)

    while i < len(body):
        key_result = _read_json_string(body, i, max_bytes=max_key_bytes)
        if key_result.status != "ok":
            return TopLevelStringFieldProbeResult(key_result.status)
        key = key_result.value
        if key is None:
            return TopLevelStringFieldProbeResult("invalid")
        i = _skip_json_whitespace(body, key_result.index)
        if i >= len(body):
            return TopLevelStringFieldProbeResult("incomplete")
        if body[i] != ord(":"):
            return TopLevelStringFieldProbeResult("invalid")
        i = _skip_json_whitespace(body, i + 1)
        if key == field_name:
            if i >= len(body):
                return TopLevelStringFieldProbeResult("incomplete", field_seen=True)
            if body[i] != ord('"'):
                return TopLevelStringFieldProbeResult(
                    "non_string" if _is_json_value_start(body[i]) else "invalid",
                    field_seen=True,
                )
            value_result = _read_json_string(body, i, max_bytes=max_string_bytes)
            if value_result.status != "ok":
                return TopLevelStringFieldProbeResult(value_result.status, field_seen=True)
            return TopLevelStringFieldProbeResult("found", value_result.value, field_seen=True)

        if i >= len(body):
            return TopLevelStringFieldProbeResult("incomplete")

        skip_result = _skip_json_value(
            body,
            i,
            depth=1,
            max_depth=max_depth,
            max_key_bytes=max_key_bytes,
            max_string_bytes=max_string_bytes,
        )
        if skip_result.status != "ok":
            return TopLevelStringFieldProbeResult(skip_result.status)
        i = _skip_json_whitespace(body, skip_result.index)
        if i >= len(body):
            return TopLevelStringFieldProbeResult("incomplete")
        if body[i] == ord("}"):
            return _finish_not_found_object(body, i + 1)
        if body[i] != ord(","):
            return TopLevelStringFieldProbeResult("invalid")
        i = _skip_json_whitespace(body, i + 1)
        if i >= len(body):
            return TopLevelStringFieldProbeResult("incomplete")

    return TopLevelStringFieldProbeResult("incomplete")


def _validate_positive_int(name: str, value: int) -> None:
    if not isinstance(value, int) or isinstance(value, bool):
        raise TypeError(f"{name} must be an integer")
    if value <= 0:
        raise ValueError(f"{name} must be a positive integer")


def _skip_json_whitespace(body: bytes, i: int) -> int:
    while i < len(body) and body[i] in _JSON_WHITESPACE:
        i += 1
    return i


def _finish_not_found_object(body: bytes, i: int) -> TopLevelStringFieldProbeResult:
    i = _skip_json_whitespace(body, i)
    if i == len(body):
        return TopLevelStringFieldProbeResult("not_found")
    return TopLevelStringFieldProbeResult("invalid")


def _scan_json_string_end(
    body: bytes,
    i: int,
    *,
    max_bytes: int,
) -> _IndexResult:
    if i >= len(body) or body[i] != ord('"'):
        return _IndexResult("invalid")
    i += 1
    raw_bytes = 0
    while i < len(body):
        b = body[i]
        if b == ord('"'):
            return _IndexResult("ok", i + 1)
        raw_bytes += 1
        if raw_bytes > max_bytes:
            return _IndexResult("bound_exceeded")
        if b == ord("\\"):
            i += 1
            if i >= len(body):
                return _IndexResult("incomplete")
            escape = body[i]
            raw_bytes += 1
            if raw_bytes > max_bytes:
                return _IndexResult("bound_exceeded")
            if escape == ord("u"):
                if i + 4 >= len(body):
                    return _IndexResult("incomplete")
                if any(hex_byte not in _JSON_HEX_BYTES for hex_byte in body[i + 1 : i + 5]):
                    return _IndexResult("invalid")
                raw_bytes += 4
                if raw_bytes > max_bytes:
                    return _IndexResult("bound_exceeded")
                i += 5
                continue
            if escape not in b'"\\/bfnrt':
                return _IndexResult("invalid")
            i += 1
            continue
        if b < _JSON_CONTROL_CHAR_MAX:
            return _IndexResult("invalid")
        i += 1
    return _IndexResult("incomplete")


def _read_json_string(body: bytes, i: int, *, max_bytes: int) -> _StringResult:
    end_result = _scan_json_string_end(body, i, max_bytes=max_bytes)
    if end_result.status != "ok":
        return _StringResult(end_result.status)
    try:
        value = json.loads(body[i : end_result.index].decode("utf-8"))
    except UnicodeDecodeError, json.JSONDecodeError, ValueError:
        return _StringResult("invalid")
    if not isinstance(value, str) or _contains_surrogate(value):
        return _StringResult("invalid")
    return _StringResult("ok", value, end_result.index)


def _skip_json_string(body: bytes, i: int, *, max_bytes: int) -> _IndexResult:
    string_result = _read_json_string(body, i, max_bytes=max_bytes)
    if string_result.status != "ok":
        return _IndexResult(string_result.status)
    return _IndexResult("ok", string_result.index)


def _skip_json_number(body: bytes, i: int) -> _IndexResult:
    if i < len(body) and body[i] == ord("-"):
        i += 1
    if i >= len(body):
        return _IndexResult("incomplete")

    if body[i] == ord("0"):
        i += 1
        if i < len(body) and ord("0") <= body[i] <= ord("9"):
            return _IndexResult("invalid")
    elif ord("1") <= body[i] <= ord("9"):
        i += 1
        while i < len(body) and ord("0") <= body[i] <= ord("9"):
            i += 1
    else:
        return _IndexResult("invalid")

    if i < len(body) and body[i] == ord("."):
        i += 1
        if i >= len(body):
            return _IndexResult("incomplete")
        if not ord("0") <= body[i] <= ord("9"):
            return _IndexResult("invalid")
        while i < len(body) and ord("0") <= body[i] <= ord("9"):
            i += 1

    if i < len(body) and body[i] in b"eE":
        i += 1
        if i < len(body) and body[i] in b"+-":
            i += 1
        if i >= len(body):
            return _IndexResult("incomplete")
        if not ord("0") <= body[i] <= ord("9"):
            return _IndexResult("invalid")
        while i < len(body) and ord("0") <= body[i] <= ord("9"):
            i += 1

    if i >= len(body):
        return _IndexResult("incomplete")
    return _IndexResult("ok", i)


def _skip_json_array(
    body: bytes,
    i: int,
    *,
    depth: int,
    max_depth: int,
    max_key_bytes: int,
    max_string_bytes: int,
) -> _IndexResult:
    if depth >= max_depth:
        return _IndexResult("bound_exceeded")
    i = _skip_json_whitespace(body, i + 1)
    if i >= len(body):
        return _IndexResult("incomplete")
    if body[i] == ord("]"):
        return _IndexResult("ok", i + 1)

    while i < len(body):
        value_result = _skip_json_value(
            body,
            i,
            depth=depth + 1,
            max_depth=max_depth,
            max_key_bytes=max_key_bytes,
            max_string_bytes=max_string_bytes,
        )
        if value_result.status != "ok":
            return value_result
        i = _skip_json_whitespace(body, value_result.index)
        if i >= len(body):
            return _IndexResult("incomplete")
        if body[i] == ord("]"):
            return _IndexResult("ok", i + 1)
        if body[i] != ord(","):
            return _IndexResult("invalid")
        i = _skip_json_whitespace(body, i + 1)
        if i >= len(body):
            return _IndexResult("incomplete")
    return _IndexResult("incomplete")


def _skip_json_object(
    body: bytes,
    i: int,
    *,
    depth: int,
    max_depth: int,
    max_key_bytes: int,
    max_string_bytes: int,
) -> _IndexResult:
    if depth >= max_depth:
        return _IndexResult("bound_exceeded")
    i = _skip_json_whitespace(body, i + 1)
    if i >= len(body):
        return _IndexResult("incomplete")
    if body[i] == ord("}"):
        return _IndexResult("ok", i + 1)

    while i < len(body):
        key_result = _skip_json_string(body, i, max_bytes=max_key_bytes)
        if key_result.status != "ok":
            return key_result
        i = _skip_json_whitespace(body, key_result.index)
        if i >= len(body):
            return _IndexResult("incomplete")
        if body[i] != ord(":"):
            return _IndexResult("invalid")
        i = _skip_json_whitespace(body, i + 1)
        if i >= len(body):
            return _IndexResult("incomplete")
        value_result = _skip_json_value(
            body,
            i,
            depth=depth + 1,
            max_depth=max_depth,
            max_key_bytes=max_key_bytes,
            max_string_bytes=max_string_bytes,
        )
        if value_result.status != "ok":
            return value_result
        i = _skip_json_whitespace(body, value_result.index)
        if i >= len(body):
            return _IndexResult("incomplete")
        if body[i] == ord("}"):
            return _IndexResult("ok", i + 1)
        if body[i] != ord(","):
            return _IndexResult("invalid")
        i = _skip_json_whitespace(body, i + 1)
        if i >= len(body):
            return _IndexResult("incomplete")
    return _IndexResult("incomplete")


def _skip_json_value(
    body: bytes,
    i: int,
    *,
    depth: int,
    max_depth: int,
    max_key_bytes: int,
    max_string_bytes: int,
) -> _IndexResult:
    i = _skip_json_whitespace(body, i)
    if i >= len(body):
        return _IndexResult("incomplete")
    b = body[i]
    if b == ord('"'):
        return _skip_json_string(body, i, max_bytes=max_string_bytes)
    if b == ord("{"):
        return _skip_json_object(
            body,
            i,
            depth=depth,
            max_depth=max_depth,
            max_key_bytes=max_key_bytes,
            max_string_bytes=max_string_bytes,
        )
    if b == ord("["):
        return _skip_json_array(
            body,
            i,
            depth=depth,
            max_depth=max_depth,
            max_key_bytes=max_key_bytes,
            max_string_bytes=max_string_bytes,
        )
    if b == ord("-") or ord("0") <= b <= ord("9"):
        return _skip_json_number(body, i)
    if b == ord("t"):
        literal = b"true"
    elif b == ord("f"):
        literal = b"false"
    elif b == ord("n"):
        literal = b"null"
    else:
        return _IndexResult("invalid")

    remaining = len(body) - i
    if remaining <= len(literal):
        if body.startswith(literal[:remaining], i):
            return _IndexResult("incomplete")
        return _IndexResult("invalid")
    if body.startswith(literal, i):
        return _IndexResult("ok", i + len(literal))
    return _IndexResult("invalid")


def _is_json_value_start(b: int) -> bool:
    return b in b'{["tfn-' or ord("0") <= b <= ord("9")


def _contains_surrogate(value: str) -> bool:
    return any(_UTF8_SURROGATE_MIN <= ord(ch) <= _UTF8_SURROGATE_MAX for ch in value)
