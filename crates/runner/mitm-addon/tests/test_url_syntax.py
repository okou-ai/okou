"""Shared runtime URL syntax policy tests."""

from collections.abc import Iterator
from itertools import product

import pytest

import url_syntax


class _NoPythonCharacterAccess(str):
    def __iter__(self) -> Iterator[str]:
        raise AssertionError("safe URL syntax checks must not iterate the input in Python")

    def __getitem__(self, key: int | slice) -> str:
        raise IndexError("safe URL syntax checks must not index the input in Python")


def _numeric_unsafe_url_codepoint_policy(value: str) -> bool:
    return any(
        ord(char) < url_syntax.ASCII_CONTROL_MAX
        or ord(char) == url_syntax.ASCII_DELETE
        or 0xD800 <= ord(char) <= 0xDFFF
        for char in value
    )


@pytest.mark.parametrize("codepoint", range(url_syntax.ASCII_CONTROL_MAX))
def test_unsafe_url_codepoint_rejects_every_c0_control(codepoint: int):
    assert url_syntax.has_unsafe_url_codepoint(chr(codepoint))


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        pytest.param("", False, id="empty"),
        pytest.param(" ", False, id="ascii-space"),
        pytest.param("\x7f", True, id="ascii-delete"),
        pytest.param("\ud800", True, id="surrogate-min"),
        pytest.param("\udfff", True, id="surrogate-max"),
        pytest.param("ordinary URL text", False, id="printable-ascii"),
        pytest.param("café/東京/🙂", False, id="printable-unicode"),
        pytest.param("\x80", False, id="accepted-c1-control"),
        pytest.param("\x85", False, id="accepted-next-line"),
        pytest.param("\u00a0", False, id="accepted-no-break-space"),
        pytest.param("\u200b", False, id="accepted-zero-width-space"),
        pytest.param("\u2028", False, id="accepted-line-separator"),
        pytest.param("\u2060", False, id="accepted-word-joiner"),
        pytest.param("prefix\u200bsuffix\udfff", True, id="fallback-finds-late-surrogate"),
    ],
)
def test_unsafe_url_codepoint_contract(value: str, expected: bool):
    assert url_syntax.has_unsafe_url_codepoint(value) is expected


def test_unsafe_url_codepoint_matches_numeric_policy_for_every_codepoint():
    for codepoint in range(0x110000):
        value = chr(codepoint)
        expected = (
            codepoint < url_syntax.ASCII_CONTROL_MAX
            or codepoint == url_syntax.ASCII_DELETE
            or 0xD800 <= codepoint <= 0xDFFF
        )
        # Keep the exhaustive oracle without running pytest's assertion
        # explanation machinery for each of the 1,114,112 successful checks.
        if url_syntax.has_unsafe_url_codepoint(value) is not expected:
            pytest.fail(f"unexpected URL syntax result for U+{codepoint:04X}")


def test_unsafe_url_codepoint_matches_numeric_policy_for_mixed_strings():
    boundary_values = (
        "a",
        "é",
        "🙂",
        " ",
        "\\",
        "\x00",
        "\x1f",
        "\x7f",
        "\x80",
        "\x85",
        "\u00a0",
        "\u200b",
        "\u2028",
        "\ud800",
        "\udfff",
    )
    for parts in product(boundary_values, repeat=3):
        value = f"prefix{''.join(parts)}suffix"
        assert url_syntax.has_unsafe_url_codepoint(value) == _numeric_unsafe_url_codepoint_policy(
            value
        )


@pytest.mark.parametrize(
    "value",
    [
        pytest.param(" ", id="space"),
        pytest.param("\t", id="tab"),
        pytest.param("\n", id="line-feed"),
        pytest.param("\r", id="carriage-return"),
        pytest.param("\f", id="form-feed"),
        pytest.param("\v", id="vertical-tab"),
    ],
)
def test_raw_whitespace_rejects_exact_ascii_set(value: str):
    assert url_syntax.has_raw_whitespace(value)


@pytest.mark.parametrize(
    "value",
    [
        pytest.param("", id="empty"),
        pytest.param("ordinary-url-text", id="printable-ascii"),
        pytest.param("café/東京/🙂", id="printable-unicode"),
        pytest.param("\x85", id="next-line"),
        pytest.param("\u00a0", id="no-break-space"),
        pytest.param("\u1680", id="ogham-space-mark"),
        pytest.param("\u2003", id="em-space"),
        pytest.param("\u2028", id="line-separator"),
        pytest.param("\u2029", id="paragraph-separator"),
        pytest.param("\u3000", id="ideographic-space"),
    ],
)
def test_raw_whitespace_accepts_values_outside_exact_ascii_set(value: str):
    assert not url_syntax.has_raw_whitespace(value)


@pytest.mark.parametrize(
    ("value", "allow_backslash", "expected"),
    [
        pytest.param("", False, False, id="empty"),
        pytest.param("https://api.example.com/path", False, False, id="safe"),
        pytest.param("https://api.example.com\\path", False, True, id="backslash-rejected"),
        pytest.param("https://api.example.com\\path", True, False, id="backslash-allowed"),
        pytest.param("https://api.example.com\\path ", True, True, id="space-still-rejected"),
        pytest.param("https://api.example.com\\pa\tth", True, True, id="tab-still-rejected"),
        pytest.param("https://api.example.com\\pa\x00th", True, True, id="control-still-rejected"),
        pytest.param(
            "https://api.example.com\\pa\ud800th", True, True, id="surrogate-still-rejected"
        ),
    ],
)
def test_unsafe_runtime_url_syntax_contract(
    value: str,
    allow_backslash: bool,
    expected: bool,
):
    assert (
        url_syntax.has_unsafe_runtime_url_syntax(value, allow_backslash=allow_backslash) is expected
    )


@pytest.mark.parametrize(
    ("value", "expected_unsafe"),
    [
        pytest.param("", False, id="empty"),
        pytest.param("https://api.example.com/path?query=value", False, id="printable-ascii"),
        pytest.param("https://api.example.com/café/東京/🙂", False, id="printable-unicode"),
        pytest.param("https://api.example.com/path\u200b", False, id="accepted-non-printable"),
        pytest.param("https://api.example.com/café\ud800", True, id="forbidden-surrogate"),
    ],
)
def test_url_syntax_bypasses_python_character_access(value: str, expected_unsafe: bool):
    guarded_value = _NoPythonCharacterAccess(value)

    assert url_syntax.has_unsafe_url_codepoint(guarded_value) is expected_unsafe
    assert not url_syntax.has_raw_whitespace(guarded_value)
    assert url_syntax.has_unsafe_runtime_url_syntax(guarded_value) is expected_unsafe
