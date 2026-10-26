"""Shared HTTP header syntax contract tests.

Exhaustively classify every ASCII code point against the RFC tchar set and
the header-value control-character rule using an independent reference, so a
regression in the shared predicates fails the suite.
"""

from collections.abc import Sequence
from typing import SupportsIndex, overload

import pytest
from mitmproxy import http

import http_header_syntax

# RFC 9110 tchar: "!#$%&'*+-.^_`|~" plus ASCII digits and letters. Deliberately
# independent of http_header_syntax._HTTP_TOKEN_CHARS so mutations are caught.
_TCHAR = frozenset("!#$%&'*+-.^_`|~0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")
_ASCII_CODE_POINTS = range(128)
_TEST_HEADER_WORK_LIMIT = 256


class _FullValueOperationGuard(bytes):
    def __bytes__(self) -> bytes:
        raise AssertionError("guarded header was copied")

    def decode(self, encoding: str = "utf-8", errors: str = "strict") -> str:
        raise AssertionError("guarded header was decoded")

    def split(self, sep: bytes | None = None, maxsplit: int = -1) -> list[bytes]:
        raise AssertionError("guarded header was split")

    def lower(self) -> bytes:
        raise AssertionError("guarded header was lowercased")

    def strip(self, chars: bytes | None = None) -> bytes:
        raise AssertionError(f"guarded header was stripped with chars={chars!r}")


class _ByteReadGuard(_FullValueOperationGuard):
    read_limit = 8

    @overload
    def __getitem__(self, key: SupportsIndex) -> int: ...

    @overload
    def __getitem__(self, key: slice) -> bytes: ...

    def __getitem__(self, key: SupportsIndex | slice) -> int | bytes:
        if isinstance(key, slice) or key.__index__() >= self.read_limit:
            raise AssertionError("token matcher accessed bytes beyond its inspection limit")
        return super().__getitem__(key)


class _EarlyMatchSuffixGuard(_ByteReadGuard):
    read_limit = len(b"websocket,")


class _FieldReadGuard(Sequence[tuple[bytes, bytes]]):
    def __init__(self, fields: tuple[tuple[bytes, bytes], ...], read_limit: int) -> None:
        self.fields = fields
        self.read_limit = read_limit

    def __len__(self) -> int:
        return len(self.fields)

    @overload
    def __getitem__(self, key: int) -> tuple[bytes, bytes]: ...

    @overload
    def __getitem__(self, key: slice) -> Sequence[tuple[bytes, bytes]]: ...

    def __getitem__(self, key: int | slice) -> tuple[bytes, bytes] | Sequence[tuple[bytes, bytes]]:
        if isinstance(key, slice) or key >= self.read_limit:
            raise AssertionError("header lookup accessed fields beyond its inspection limit")
        return self.fields[key]


def _is_forbidden_value_control(char: str) -> bool:
    code_point = ord(char)
    return (code_point <= 0x1F and char != "\t") or code_point == 0x7F


@pytest.mark.parametrize("char", [chr(code_point) for code_point in _ASCII_CODE_POINTS])
def test_is_http_header_name_classifies_every_ascii_code_point(char: str) -> None:
    assert http_header_syntax.is_http_header_name(char) == (char in _TCHAR)


@pytest.mark.parametrize("char", [chr(code_point) for code_point in _ASCII_CODE_POINTS])
def test_has_forbidden_header_value_control_classifies_every_ascii_code_point(
    char: str,
) -> None:
    assert http_header_syntax.has_forbidden_header_value_control(
        char
    ) == _is_forbidden_value_control(char)


def test_is_http_header_name_rejects_empty_name() -> None:
    assert http_header_syntax.is_http_header_name("") is False


@pytest.mark.parametrize(
    "name",
    [
        pytest.param("X|Trace", id="uncommon-tchar-pipe"),
        pytest.param("x-amz-date", id="common-token-name"),
    ],
)
def test_is_http_header_name_accepts_multi_char_tchar_names(name: str) -> None:
    assert http_header_syntax.is_http_header_name(name) is True


@pytest.mark.parametrize(
    "name",
    [
        pytest.param("x y", id="embedded-space"),
        pytest.param("x:y", id="colon"),
        pytest.param("x\ny", id="newline"),
        pytest.param("x\x00y", id="nul"),
        pytest.param("\u00e9", id="non-ascii"),
    ],
)
def test_is_http_header_name_rejects_multi_char_invalid_names(name: str) -> None:
    assert http_header_syntax.is_http_header_name(name) is False


@pytest.mark.parametrize(
    "value",
    [
        pytest.param("a\t b", id="tab-and-space-allowed"),
        pytest.param("plain value", id="printable"),
    ],
)
def test_has_forbidden_header_value_control_accepts_legal_values(value: str) -> None:
    assert http_header_syntax.has_forbidden_header_value_control(value) is False


@pytest.mark.parametrize(
    "value",
    [
        pytest.param("a\n b", id="newline"),
        pytest.param("a\r b", id="carriage-return"),
        pytest.param("a\x00b", id="nul"),
        pytest.param("a\x7fb", id="delete"),
    ],
)
def test_has_forbidden_header_value_control_rejects_control_values(value: str) -> None:
    assert http_header_syntax.has_forbidden_header_value_control(value) is True


def test_has_forbidden_header_value_control_accepts_non_ascii_value() -> None:
    assert http_header_syntax.has_forbidden_header_value_control("\u00e9") is False


@pytest.mark.parametrize(
    ("values", "expected_token", "contains_token"),
    [
        pytest.param((), "upgrade", False, id="empty-values"),
        pytest.param(
            ("keep-alive", "websocket"),
            "websocket",
            True,
            id="repeated-upgrade-values",
        ),
        pytest.param(
            ("keep-alive,\tUpGrAdE ",),
            "upgrade",
            True,
            id="connection-list-case-and-ows",
        ),
        pytest.param(
            ("h2c, websocket\u2028",),
            "websocket",
            False,
            id="trailing-unicode-whitespace",
        ),
        pytest.param(
            ("\u2028upgrade",),
            "upgrade",
            False,
            id="leading-unicode-whitespace",
        ),
        pytest.param(("upgraded",), "upgrade", False, id="nonmatching-token"),
    ],
)
def test_header_fields_contain_token(
    values: tuple[str, ...],
    expected_token: str,
    *,
    contains_token: bool,
) -> None:
    headers = http.Headers([(b"UpGrAdE", value.encode()) for value in values])
    assert (
        http_header_syntax.header_fields_contain_token(
            headers.fields,
            b"upgrade",
            expected_token.encode(),
            max_work_units=_TEST_HEADER_WORK_LIMIT,
        )
        is contains_token
    )


def test_header_fields_contain_token_stops_before_matched_suffix_and_later_fields() -> None:
    value = _EarlyMatchSuffixGuard(b"websocket," + b"\xff" * 10_000)
    headers = http.Headers([(b"Upgrade", value), (b"Upgrade", b"unvisited")])
    fields = _FieldReadGuard(headers.fields, read_limit=1)

    assert http_header_syntax.header_fields_contain_token(
        fields,
        b"upgrade",
        b"websocket",
        max_work_units=_TEST_HEADER_WORK_LIMIT,
    )


def test_header_fields_contain_token_stops_at_byte_work_limit() -> None:
    value = _ByteReadGuard(b"\xff" * 10_000)
    headers = http.Headers([(b"Upgrade", value)])

    assert not http_header_syntax.header_fields_contain_token(
        headers.fields,
        b"upgrade",
        b"websocket",
        max_work_units=9,
    )


@pytest.mark.parametrize("name", [b"upgrade", b"unrelated"])
def test_header_fields_contain_token_bounds_empty_and_unrelated_fields(name: bytes) -> None:
    fields = _FieldReadGuard(((name, b""),) * 10_000, read_limit=8)

    assert not http_header_syntax.header_fields_contain_token(
        fields, b"upgrade", b"websocket", max_work_units=8
    )


@pytest.mark.parametrize(
    ("value", "work_limit", "contains_token"),
    [
        (b"websocket", 9, False),
        (b"websocket", 10, True),
        (b"websocketx", 10, False),
        (b"websocket,ignored", 10, False),
        (b"websocket,ignored", 11, True),
        (b"\tWebSoCkEt \t", 13, True),
    ],
)
def test_header_fields_contain_token_requires_complete_token_within_budget(
    value: bytes, work_limit: int, *, contains_token: bool
) -> None:
    assert (
        http_header_syntax.header_fields_contain_token(
            ((b"upgrade", value),), b"upgrade", b"websocket", max_work_units=work_limit
        )
        is contains_token
    )


def test_raw_header_lookup_does_not_lowercase_oversized_unrelated_names() -> None:
    headers = http.Headers(
        [(_FullValueOperationGuard(b"x" * 10_000), b"ignored"), (b"Upgrade", b"websocket")]
    )

    assert http_header_syntax.header_fields_contain_token(
        headers.fields, b"upgrade", b"websocket", max_work_units=_TEST_HEADER_WORK_LIMIT
    )
    assert (
        http_header_syntax.single_header_value(
            headers.fields, b"upgrade", max_fields=2, max_value_bytes=9
        )
        == b"websocket"
    )


@pytest.mark.parametrize(
    ("values", "expected_value"),
    [
        pytest.param((), None, id="missing-value"),
        pytest.param(
            (" \tdGhlIHNhbXBsZSBub25jZQ==\t ",),
            "dGhlIHNhbXBsZSBub25jZQ==",
            id="websocket-key-ows",
        ),
        pytest.param(("13\u2028",), "13\u2028", id="version-unicode-whitespace"),
        pytest.param((" \t",), "", id="blank-singleton"),
        pytest.param(
            ("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", "duplicate"),
            None,
            id="duplicate-websocket-accept",
        ),
    ],
)
def test_single_header_value(
    values: tuple[str, ...],
    expected_value: str | None,
) -> None:
    headers = http.Headers([(b"SeC-WebSocket-Key", value.encode()) for value in values])
    assert http_header_syntax.single_header_value(
        headers.fields,
        b"sec-websocket-key",
        max_fields=_TEST_HEADER_WORK_LIMIT,
        max_value_bytes=_TEST_HEADER_WORK_LIMIT,
    ) == (None if expected_value is None else expected_value.encode())


def test_single_header_value_rejects_oversized_value_before_strip() -> None:
    value = _FullValueOperationGuard(b"\xff" * 10_000)
    headers = http.Headers([(b"Sec-WebSocket-Key", value)])

    assert (
        http_header_syntax.single_header_value(
            headers.fields, b"sec-websocket-key", max_fields=1, max_value_bytes=8
        )
        is None
    )


def test_single_header_value_rejects_duplicates_before_strip() -> None:
    headers = http.Headers(
        [
            (b"Sec-WebSocket-Key", _FullValueOperationGuard(b"  value  ")),
            (b"Unrelated", b"ignored"),
            (b"sec-websocket-key", _FullValueOperationGuard(b"")),
        ]
    )

    assert (
        http_header_syntax.single_header_value(
            headers.fields, b"sec-websocket-key", max_fields=3, max_value_bytes=9
        )
        is None
    )


def test_single_header_value_rejects_unverified_cardinality_before_traversal() -> None:
    fields = _FieldReadGuard(((b"key", b"value"),) * 10_000, read_limit=0)

    assert (
        http_header_syntax.single_header_value(fields, b"key", max_fields=8, max_value_bytes=8)
        is None
    )


def test_single_header_value_accepts_inclusive_field_and_value_limits() -> None:
    assert (
        http_header_syntax.single_header_value(
            ((b"unrelated", b""), (b"key", b" value \t")),
            b"key",
            max_fields=2,
            max_value_bytes=8,
        )
        == b"value"
    )


def test_single_header_value_preserves_caller_selected_whitespace() -> None:
    assert (
        http_header_syntax.single_header_value(
            ((b"Content-Type", b" \tapplication/json\t "),),
            b"content-type",
            max_fields=1,
            max_value_bytes=32,
            strip_chars=b" ",
        )
        == b"\tapplication/json\t"
    )


def test_single_header_value_stops_at_early_duplicate_without_conversion() -> None:
    fields = _FieldReadGuard(
        (
            (b"Content-Type", _FullValueOperationGuard(b"application/json")),
            (b"cOnTeNt-TyPe", _FullValueOperationGuard(b"application/json")),
            (b"Content-Type", _FullValueOperationGuard(b"x" * 10_000)),
        ),
        read_limit=2,
    )
    assert (
        http_header_syntax.single_header_value(
            fields, b"content-type", max_fields=3, max_value_bytes=512
        )
        is None
    )
