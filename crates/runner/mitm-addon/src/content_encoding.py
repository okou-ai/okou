"""Bounded Content-Encoding acquisition with caller-owned codec and list policies."""

from mitmproxy import http

_HEADER_NAME = b"content-encoding"
_MAX_FIELDS = 8 * 1024
_MAX_VALUE_BYTES = 8 * 1024
_VALUE_SEPARATOR = ", "


def read_values(headers: http.Headers) -> tuple[str, ...] | None:
    """Return bounded values, an empty tuple for missing fields, or None on exhaustion.

    Check the complete raw field and aggregate value budgets before converting
    any value. Count comma-space folding separators even for callers that parse
    values separately. In-budget values retain mitmproxy's UTF-8/surrogateescape
    semantics; callers decide how to interpret missing, blank, or repeated fields.
    """
    fields = headers.fields
    if len(fields) > _MAX_FIELDS:
        return None

    values: list[bytes] = []
    value_bytes = 0
    for name, value in fields:
        if len(name) != len(_HEADER_NAME) or name.lower() != _HEADER_NAME:
            continue
        value_bytes += len(value)
        if values:
            value_bytes += len(_VALUE_SEPARATOR)
        if value_bytes > _MAX_VALUE_BYTES:
            return None
        values.append(value)
    return tuple(value.decode("utf-8", "surrogateescape") for value in values)


def read_folded(headers: http.Headers) -> str | None:
    """Read a normalized folded encoding, or None when inspection is exhausted."""
    values = read_values(headers)
    if values is None:
        return None
    return _VALUE_SEPARATOR.join(values).strip().lower()
