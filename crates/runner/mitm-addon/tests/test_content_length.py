"""Protocol contract for shared Content-Length field parsing."""

from itertools import chain, product

import pytest
from mitmproxy import http

import content_length

_MAX_VALUE = 1000


def _header_values(*values: str) -> list[str]:
    headers = http.Headers([(b"content-length", value.encode("latin-1")) for value in values])
    return headers.get_all("Content-Length")


def _reference_parse_content_length(
    values: list[str], *, max_value: int
) -> content_length.ContentLengthResult:
    first_normalized: str | None = None

    for field_value in values:
        for part in field_value.split(","):
            token = part.strip(" \t")
            if not token or not token.isascii() or not token.isdecimal():
                return content_length.ContentLengthResult("invalid")

            normalized = token.lstrip("0") or "0"
            if first_normalized is None:
                first_normalized = normalized
            elif normalized != first_normalized:
                return content_length.ContentLengthResult("conflicting")

    if first_normalized is None:
        return content_length.ContentLengthResult("missing")
    if len(first_normalized) > len(str(max_value)):
        return content_length.ContentLengthResult("over_limit", max_value + 1)

    parsed_value = int(first_normalized)
    if parsed_value > max_value:
        return content_length.ContentLengthResult("over_limit", parsed_value)
    return content_length.ContentLengthResult("valid", parsed_value)


@pytest.mark.parametrize(
    ("values", "expected_value"),
    [
        pytest.param(["42"], 42, id="plain"),
        pytest.param([" \t42\t "], 42, id="http-optional-whitespace"),
        pytest.param(["00000000000042"], 42, id="leading-zeros"),
        pytest.param(["0" * 5000], 0, id="long-zero"),
        pytest.param(["42, 042"], 42, id="matching-comma-list"),
    ],
)
def test_valid_content_length(values: list[str], expected_value: int):
    assert content_length.parse(values, max_value=_MAX_VALUE) == (
        content_length.ContentLengthResult("valid", expected_value)
    )


def test_matching_repeated_content_length_fields():
    assert content_length.parse(
        _header_values("00042", "42"),
        max_value=_MAX_VALUE,
    ) == content_length.ContentLengthResult("valid", 42)


@pytest.mark.parametrize(
    "values",
    [
        pytest.param(["42,"], id="trailing-empty-part"),
        pytest.param([",42"], id="leading-empty-part"),
        pytest.param(["42,,42"], id="interior-empty-part"),
        pytest.param(["+42"], id="positive-sign"),
        pytest.param(["-42"], id="negative-sign"),
        pytest.param(["\u0664\u0662"], id="unicode-digits"),
        pytest.param(["\v42"], id="vertical-tab"),
        pytest.param(["\f42"], id="form-feed"),
    ],
)
def test_invalid_content_length(values: list[str]):
    assert content_length.parse(values, max_value=_MAX_VALUE) == (
        content_length.ContentLengthResult("invalid")
    )


@pytest.mark.parametrize(
    "values",
    [
        pytest.param(["42, 43"], id="comma-list"),
        pytest.param(_header_values("42", "43"), id="repeated-fields"),
        pytest.param(["1, 10"], id="comma-list-shorter-first"),
        pytest.param(["10, 1"], id="comma-list-longer-first"),
        pytest.param(_header_values("1", "10"), id="repeated-fields-shorter-first"),
        pytest.param(_header_values("10", "1"), id="repeated-fields-longer-first"),
        pytest.param(["0001, 0010"], id="comma-list-leading-zeros-shorter-first"),
        pytest.param(["0010, 0001"], id="comma-list-leading-zeros-longer-first"),
        pytest.param(
            _header_values("0001", "0010"),
            id="repeated-fields-leading-zeros-shorter-first",
        ),
        pytest.param(
            _header_values("0010", "0001"),
            id="repeated-fields-leading-zeros-longer-first",
        ),
        pytest.param(["9" * 5000, "8" * 5000], id="distinct-huge-values"),
    ],
)
def test_conflicting_content_length(values: list[str]):
    assert content_length.parse(values, max_value=_MAX_VALUE) == (
        content_length.ContentLengthResult("conflicting")
    )


@pytest.mark.parametrize("max_value", [0, 9, 10, 1000])
def test_bounded_content_length_differential(max_value: int):
    atoms = (
        "",
        "0",
        "00",
        "1",
        "01",
        "9",
        "10",
        "010",
        "99",
        "999",
        "1000",
        "1001",
        "10000",
        "x",
        "+1",
        "1x",
    )
    wrappers = (("", ""), (" ", " "), ("\t", "\t"))
    field_values = tuple(f"{prefix}{atom}{suffix}" for atom in atoms for prefix, suffix in wrappers)
    cases = chain(
        ([],),
        ([field_value] for field_value in field_values),
        ([first, second] for first, second in product(field_values, repeat=2)),
        ([first, second, first] for first, second in product(field_values, repeat=2)),
        ([first, second, "x"] for first, second in product(field_values, repeat=2)),
        ([f"{first},{second}"] for first, second in product(field_values, repeat=2)),
        ([first, f"{second},{first}"] for first, second in product(field_values, repeat=2)),
    )

    for values in cases:
        expected = _reference_parse_content_length(values, max_value=max_value)
        actual = content_length.parse(values, max_value=max_value)
        assert actual == expected, f"values={values!r}, max_value={max_value}"


@pytest.mark.parametrize(
    ("values", "expected_value"),
    [
        pytest.param(["9" * 5000], 1001, id="very-long"),
        pytest.param(["9" * 5000, "9" * 5000], 1001, id="matching-huge-values"),
    ],
)
def test_over_limit_content_length(values: list[str], expected_value: int):
    assert content_length.parse(values, max_value=_MAX_VALUE) == (
        content_length.ContentLengthResult("over_limit", expected_value)
    )
