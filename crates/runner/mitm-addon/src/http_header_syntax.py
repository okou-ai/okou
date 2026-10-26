"""Shared HTTP header syntax helpers.

These helpers only implement dependency-light syntax rules. Callers keep ownership of their
trust-boundary-specific encoding rules, exception types, and error messages.
"""

from collections.abc import Sequence

_HTTP_TOKEN_CHARS: frozenset[str] = frozenset(
    "!#$%&'*+-.^_`|~0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
)
_ASCII_CONTROL_MAX = 0x1F
_ASCII_DELETE = 0x7F
_HTTP_OWS_BYTES = b" \t"
_HTTP_LIST_DELIMITER = ord(",")


def is_http_header_name(value: str) -> bool:
    """Return whether ``value`` is a non-empty ASCII HTTP ``tchar`` sequence.

    The accepted characters are RFC 9110's ``tchar`` punctuation
    (``!#$%&'*+-.^_`|~``), ASCII digits, and ASCII letters. Empty strings and
    every other character, including non-ASCII characters, are rejected. This
    helper does not apply caller-specific encoding, exception, or error-message
    policies.
    """
    return bool(value) and all(char in _HTTP_TOKEN_CHARS for char in value)


def has_forbidden_header_value_control(value: str) -> bool:
    """Return whether ``value`` contains a forbidden header-value control.

    C0 controls (U+0000 through U+001F) are rejected except for HTAB (U+0009),
    as is DEL (U+007F). All other characters, including non-ASCII characters,
    are outside this predicate's rejection set. Callers remain responsible for
    any encoding or additional validation required at their trust boundary.
    """
    return any(
        (ord(char) <= _ASCII_CONTROL_MAX and char != "\t") or ord(char) == _ASCII_DELETE
        for char in value
    )


def header_fields_contain_token(
    fields: Sequence[tuple[bytes, bytes]],
    name: bytes,
    expected: bytes,
    *,
    max_work_units: int,
) -> bool:
    """Return whether a raw ``name`` field contains ``expected`` as a list token.

    Matching consumes one work unit per visited field and one per inspected
    matching-value byte, without decoding values. It stops at ``max_work_units``
    and fails closed without scanning remaining fields or bytes. A complete early
    match returns before an irrelevant suffix. Only HTTP OWS (SP and HTAB) is
    ignored at token edges, and comparison is ASCII case-insensitive. Callers
    provide lowercase ASCII ``name`` and ``expected`` and a trust-boundary limit.
    """
    expected_upper = expected.upper()
    work_units = 0

    for field_index in range(len(fields)):
        if work_units >= max_work_units:
            return False
        raw_name, value = fields[field_index]
        work_units += 1
        if len(raw_name) != len(name) or raw_name.lower() != name:
            continue
        token_matches = True
        matched_chars = 0

        value_index = 0
        while value_index < len(value):
            if work_units >= max_work_units:
                return False
            char = value[value_index]
            value_index += 1
            work_units += 1

            if char == _HTTP_LIST_DELIMITER:
                if token_matches and matched_chars == len(expected):
                    return True
                token_matches = True
                matched_chars = 0
                continue

            if not token_matches:
                continue
            if matched_chars == 0 and char in _HTTP_OWS_BYTES:
                continue
            if matched_chars == len(expected):
                if char not in _HTTP_OWS_BYTES:
                    token_matches = False
                continue
            expected_char = expected[matched_chars]
            if char == expected_char or char == expected_upper[matched_chars]:
                matched_chars += 1
            else:
                token_matches = False

        if token_matches and matched_chars == len(expected):
            return True

    return False


def single_header_value(
    fields: Sequence[tuple[bytes, bytes]],
    name: bytes,
    *,
    max_fields: int,
    max_value_bytes: int,
    strip_chars: bytes = _HTTP_OWS_BYTES,
) -> bytes | None:
    """Return one bounded raw value with caller-selected stripping, or ``None``.

    Reject excess field count, missing/repeated ``name`` fields, and values above
    ``max_value_bytes`` before stripping or decoding anything. Check cardinality
    across the complete bounded field tuple before copying a singleton. Strip SP
    and HTAB by default; callers can select narrower whitespace semantics. A blank
    singleton returns empty bytes. Callers provide lowercase ASCII ``name`` and
    remain responsible for content validation.
    """
    if len(fields) > max_fields:
        return None
    value: bytes | None = None
    for raw_name, raw_value in fields:
        if len(raw_name) != len(name) or raw_name.lower() != name:
            continue
        if value is not None or len(raw_value) > max_value_bytes:
            return None
        value = raw_value
    if value is None:
        return None
    return value.strip(strip_chars)
