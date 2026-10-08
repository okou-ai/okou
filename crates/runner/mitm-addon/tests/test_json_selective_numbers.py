"""Number and literal contracts for bounded selective JSON extraction."""

import json
from itertools import pairwise
from typing import Literal, Never

import pytest

from usage.json_selective import (
    JSON_INTEGER_VALUE_LIMIT_EXCEEDED,
    JsonExtractionResult,
    JsonSelectiveExtractor,
    Path,
    ScalarField,
)

_NumberLayout = Literal[
    "root-eof",
    "selected-object-close",
    "unselected-object-comma",
    "unselected-array-close",
]
_NumberFeedMode = Literal["whole", "bytewise", "transitions"]

_SENTINEL_MEMBER = (
    b'"sentinel":{"value":7,"items":[0,1],"includes":{"users":[{}]},"object":{},"present":true}'
)
_SENTINEL_VALUES: dict[Path, object] = {("sentinel", "value"): 7}
_SENTINEL_ARRAY_COUNTS: dict[Path, int] = {("sentinel", "items"): 2}
_SENTINEL_WILDCARD_ARRAY_COUNTS = {("sentinel", "includes", "*"): {"users": 1}}
_SENTINEL_OBJECT_PRESENT: set[Path] = {("sentinel", "object")}
_SENTINEL_VALUE_PRESENT: set[Path] = {("sentinel", "present")}

# Each row names the public grammar path it protects and splits at every
# transition inside the token. Delimiter and EOF transitions come from layouts.
_NUMBER_CASES = [
    # start, after_minus, zero, and int transitions and accepting states
    pytest.param(b"0", (), id="valid-zero"),
    pytest.param(b"-0", (1,), id="valid-after-minus-zero"),
    pytest.param(b"1", (), id="valid-int"),
    pytest.param(b"-1", (1,), id="valid-after-minus-int"),
    pytest.param(b"10", (1,), id="valid-int-digit"),
    # dot and frac transitions and accepting states
    pytest.param(b"0.1", (1, 2), id="valid-zero-fraction"),
    pytest.param(b"1.25", (1, 2, 3), id="valid-fraction-digit"),
    # exp, exp_sign, and exp_digits transitions and accepting states
    pytest.param(b"0e1", (1, 2), id="valid-zero-exponent"),
    pytest.param(b"1e1", (1, 2), id="valid-exponent-digits"),
    pytest.param(b"1E+2", (1, 2, 3), id="valid-uppercase-positive-exponent"),
    pytest.param(b"1e-2", (1, 2, 3), id="valid-negative-exponent"),
    pytest.param(b"1e23", (1, 2, 3), id="valid-exponent-digit-continuation"),
    pytest.param(b"-2.5e+3", (1, 2, 3, 4, 5, 6), id="valid-fraction-exponent"),
    # states that are invalid when a delimiter or EOF finalizes the token
    pytest.param(b"-", (), id="incomplete-after-minus"),
    pytest.param(b"1.", (1,), id="incomplete-dot"),
    pytest.param(b"1e", (1,), id="incomplete-exponent"),
    pytest.param(b"1e+", (1, 2), id="incomplete-positive-exponent-sign"),
    pytest.param(b"1e-", (1, 2), id="incomplete-negative-exponent-sign"),
    # invalid exits from every public-reachable nonterminal and accepting phase
    pytest.param(b"-x", (1,), id="invalid-after-minus-exit"),
    pytest.param(b"--1", (1, 2), id="invalid-after-minus-second-sign"),
    pytest.param(b"00", (1,), id="invalid-zero-digit"),
    pytest.param(b"01", (1,), id="invalid-leading-zero"),
    pytest.param(b"0x", (1,), id="invalid-zero-exit"),
    pytest.param(b"1x", (1,), id="invalid-int-exit"),
    pytest.param(b"1.x", (1, 2), id="invalid-dot-exit-regression"),
    pytest.param(b"1.0x", (1, 2, 3), id="invalid-fraction-exit"),
    pytest.param(b"1e.", (1, 2), id="invalid-exponent-exit"),
    pytest.param(b"1e+x", (1, 2, 3), id="invalid-positive-exponent-sign-exit"),
    pytest.param(b"1e-x", (1, 2, 3), id="invalid-negative-exponent-sign-exit"),
    pytest.param(b"1e1x", (1, 2, 3), id="invalid-exponent-digits-exit"),
    pytest.param(b"1e1.", (1, 2, 3), id="invalid-exponent-digits-dot"),
    # _start_value rejects these before _NumberState can be created.
    pytest.param(b"+1", (1,), id="invalid-public-entry-plus"),
    pytest.param(b".1", (1,), id="invalid-public-entry-dot"),
]

_NUMBER_LAYOUTS = [
    pytest.param("root-eof", id="root-eof"),
    pytest.param("selected-object-close", id="selected-object-close"),
    pytest.param("unselected-object-comma", id="unselected-object-comma"),
    pytest.param("unselected-array-close", id="unselected-array-close"),
]

_NUMBER_FEED_MODES = [
    pytest.param("whole", id="whole"),
    pytest.param("bytewise", id="bytewise"),
    pytest.param("transitions", id="transition-splits"),
]


def _reject_nonstandard_json_constant(value: str) -> Never:
    raise ValueError(value)


def _strict_json_loads(payload: bytes) -> object:
    return json.loads(payload, parse_constant=_reject_nonstandard_json_constant)


def _number_document(number: bytes, layout: _NumberLayout) -> tuple[bytes, int]:
    if layout == "root-eof":
        prefix = b""
        suffix = b""
    elif layout == "selected-object-close":
        prefix = b"{" + _SENTINEL_MEMBER + b',"selected":'
        suffix = b"}"
    elif layout == "unselected-object-comma":
        prefix = b'{"ignored":'
        suffix = b"," + _SENTINEL_MEMBER + b"}"
    else:
        prefix = b'{"ignored":['
        suffix = b"]," + _SENTINEL_MEMBER + b"}"
    return prefix + number + suffix, len(prefix)


def _number_extractor(layout: _NumberLayout) -> JsonSelectiveExtractor:
    scalar_fields = {path: ScalarField("int") for path in _SENTINEL_VALUES}
    if layout == "selected-object-close":
        scalar_fields[("selected",)] = ScalarField("int")
    return JsonSelectiveExtractor(
        scalar_fields=scalar_fields,
        array_count_paths=set(_SENTINEL_ARRAY_COUNTS),
        wildcard_array_count_paths=set(_SENTINEL_WILDCARD_ARRAY_COUNTS),
        object_presence_paths=_SENTINEL_OBJECT_PRESENT,
        value_presence_paths=_SENTINEL_VALUE_PRESENT,
    )


def _number_chunks(
    payload: bytes,
    number_start: int,
    number_length: int,
    number_splits: tuple[int, ...],
    feed_mode: _NumberFeedMode,
) -> tuple[bytes, ...]:
    if feed_mode == "whole":
        return (payload,)
    if feed_mode == "bytewise":
        return tuple(payload[index : index + 1] for index in range(len(payload)))

    number_end = number_start + number_length
    boundaries = sorted(
        {
            0,
            number_start,
            *(number_start + split for split in number_splits),
            number_end,
            len(payload),
        }
    )
    return tuple(payload[start:end] for start, end in pairwise(boundaries) if start != end)


def _assert_no_observations(result: JsonExtractionResult) -> None:
    assert result.values == {}
    assert result.array_counts == {}
    assert result.wildcard_array_counts == {}
    assert result.object_present == set()
    assert result.value_present == set()


@pytest.mark.parametrize(("number", "number_splits"), _NUMBER_CASES)
@pytest.mark.parametrize("layout", _NUMBER_LAYOUTS)
@pytest.mark.parametrize("feed_mode", _NUMBER_FEED_MODES)
def test_number_acceptance_matches_strict_json_across_streaming_boundaries(
    number: bytes,
    number_splits: tuple[int, ...],
    layout: _NumberLayout,
    feed_mode: _NumberFeedMode,
):
    payload, number_start = _number_document(number, layout)
    try:
        _strict_json_loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        expected_complete = False
    else:
        expected_complete = True

    extractor = _number_extractor(layout)
    for chunk in _number_chunks(
        payload,
        number_start,
        len(number),
        number_splits,
        feed_mode,
    ):
        extractor.feed(chunk)
    result = extractor.finish()

    assert result.complete is expected_complete
    if not expected_complete:
        _assert_no_observations(result)
        return

    if layout == "root-eof":
        _assert_no_observations(result)
        return

    expected_values = dict(_SENTINEL_VALUES)
    if layout == "selected-object-close":
        selected_value = _strict_json_loads(number)
        if isinstance(selected_value, int) and not isinstance(selected_value, bool):
            expected_values[("selected",)] = selected_value

    assert result.values == expected_values
    assert result.array_counts == _SENTINEL_ARRAY_COUNTS
    assert result.wildcard_array_counts == _SENTINEL_WILDCARD_ARRAY_COUNTS
    assert result.object_present == _SENTINEL_OBJECT_PRESENT
    assert result.value_present == _SENTINEL_VALUE_PRESENT


@pytest.mark.parametrize("feed_mode", _NUMBER_FEED_MODES)
def test_rejects_exact_invalid_decimal_regression(feed_mode: _NumberFeedMode):
    number = b"1.x"
    prefix = b'{"x":'
    payload = prefix + number + b"}"
    extractor = JsonSelectiveExtractor()

    for chunk in _number_chunks(payload, len(prefix), len(number), (1, 2), feed_mode):
        extractor.feed(chunk)
    result = extractor.finish()

    assert result.complete is False
    _assert_no_observations(result)


def test_rejects_oversized_number():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")},
        max_number_bytes=3,
    )

    extractor.feed(b'{"usage":{"input_tokens":1234}}')
    result = extractor.finish()

    assert result.complete is False
    assert result.error == "number limit exceeded"


def test_rejects_oversized_number_with_field_limit():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int", max_bytes=3)},
        max_number_bytes=128,
    )

    extractor.feed(b'{"usage":{"input_tokens":1234}}')
    result = extractor.finish()

    assert result.complete is False
    assert result.error == "number limit exceeded"


@pytest.mark.parametrize("feed_mode", ["whole", "bytewise"])
def test_selected_integer_value_limit_accepts_boundary_and_rejects_larger_value(
    feed_mode: _NumberFeedMode,
):
    maximum = 9_007_199_254_740_991
    scalar_fields = {("usage", "input_tokens"): ScalarField("int", max_int_value=maximum)}

    accepted = JsonSelectiveExtractor(scalar_fields=scalar_fields)
    accepted_payload = f'{{"usage":{{"input_tokens":{maximum}}}}}'.encode()
    for chunk in _number_chunks(
        accepted_payload,
        accepted_payload.index(str(maximum).encode()),
        len(str(maximum)),
        (),
        feed_mode,
    ):
        accepted.feed(chunk)

    accepted_result = accepted.finish()
    assert accepted_result.complete is True
    assert accepted_result.values == {("usage", "input_tokens"): maximum}

    rejected = JsonSelectiveExtractor(scalar_fields=scalar_fields)
    rejected_payload = f'{{"usage":{{"input_tokens":{maximum + 1}}}}}'.encode()
    for chunk in _number_chunks(
        rejected_payload,
        rejected_payload.index(str(maximum + 1).encode()),
        len(str(maximum + 1)),
        (),
        feed_mode,
    ):
        rejected.feed(chunk)

    rejected_result = rejected.finish()
    assert rejected_result.complete is False
    assert rejected_result.error == JSON_INTEGER_VALUE_LIMIT_EXCEEDED
    _assert_no_observations(rejected_result)


def test_integer_value_limit_requires_integer_field():
    with pytest.raises(
        ValueError,
        match="scalar field max_int_value requires an integer field",
    ):
        ScalarField("string", max_int_value=10)


def test_rejects_oversized_unselected_number():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")},
        max_number_bytes=3,
    )

    extractor.feed(b'{"content":{"score":1234567890},"usage":{"input_tokens":7}}')
    result = extractor.finish()

    assert result.complete is False
    assert result.error == "number limit exceeded"
    assert result.values == {}


def test_skips_unselected_number_at_limit_without_storing_value():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")},
        max_number_bytes=3,
    )

    extractor.feed(b'{"content":{"score":123},"usage":{"input_tokens":7}}')
    result = extractor.finish()

    assert result.complete is True
    assert result.values == {("usage", "input_tokens"): 7}


@pytest.mark.parametrize(
    ("number", "splits"),
    [
        ("1e3", (1, 2, 3)),
        ("1E-3", (1, 2, 3, 4)),
        ("-2.5e+3", (5, 6, 7)),
    ],
)
def test_preserves_selected_values_after_chunked_unselected_exponents(
    number: str, splits: tuple[int, ...]
):
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")}
    )
    prefix = b'{"meta":{"score":'
    suffix = b'},"usage":{"input_tokens":7}}'
    extractor.feed(prefix)
    boundaries = (0, *splits, len(number))
    for start, end in pairwise(boundaries):
        extractor.feed(number[start:end].encode())
    extractor.feed(suffix)

    result = extractor.finish()

    assert result.complete is True
    assert result.values == {("usage", "input_tokens"): 7}


@pytest.mark.parametrize("number", ["1e", "1e+"])
def test_rejects_incomplete_exponents(number: str):
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")}
    )

    extractor.feed(f'{{"meta":{{"score":{number}}},"usage":{{"input_tokens":7}}}}'.encode())
    result = extractor.finish()

    assert result.complete is False
    assert result.error == "invalid number"
    assert result.values == {}
    assert result.array_counts == {}
    assert result.wildcard_array_counts == {}
    assert result.object_present == set()


def test_rejects_oversized_unselected_exponent():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")},
        max_number_bytes=3,
    )

    extractor.feed(b'{"meta":{"score":1e10},"usage":{"input_tokens":7}}')
    result = extractor.finish()

    assert result.complete is False
    assert result.error == "number limit exceeded"
    assert result.values == {}


def test_rejects_oversized_unselected_root_number_at_eof():
    extractor = JsonSelectiveExtractor(max_number_bytes=3)

    extractor.feed(b"1234")
    result = extractor.finish()

    assert result.complete is False
    assert result.error == "number limit exceeded"
    assert result.values == {}


def test_rejects_oversized_unselected_number_across_chunks():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")},
        max_number_bytes=3,
    )

    extractor.feed(b'{"content":{"score":12')
    extractor.feed(b'34},"usage":{"input_tokens":7}}')
    result = extractor.finish()

    assert result.complete is False
    assert result.error == "number limit exceeded"
    assert result.values == {}


def test_rejects_invalid_unselected_number_before_limit_exceeded():
    extractor = JsonSelectiveExtractor(max_number_bytes=3)

    extractor.feed(b'{"content":{"score":12x}}')
    result = extractor.finish()

    assert result.complete is False
    assert result.error == "invalid number"
    assert result.values == {}


def test_rejects_invalid_unselected_number():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")}
    )

    extractor.feed(b'{"content":{"score":01},"usage":{"input_tokens":7}}')
    result = extractor.finish()

    assert result.complete is False
    assert result.error == "invalid number"


def test_extracts_root_number_at_eof():
    extractor = JsonSelectiveExtractor(scalar_fields={(): ScalarField("int")})

    extractor.feed(b"42")
    result = extractor.finish()

    assert result.complete is True
    assert result.values == {(): 42}


def test_finishes_selected_number_when_delimiter_arrives_next_chunk():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")}
    )

    extractor.feed(b'{"usage":{"input_tokens":42')
    extractor.feed(b"}}")
    result = extractor.finish()

    assert result.complete is True
    assert result.values == {("usage", "input_tokens"): 42}


def test_selected_float_is_valid_json_but_not_an_int_value():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")}
    )

    extractor.feed(b'{"usage":{"input_tokens":1.5}}')
    result = extractor.finish()

    assert result.complete is True
    assert result.values == {}


def test_rejects_invalid_json_number():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")}
    )

    extractor.feed(b'{"usage":{"input_tokens":01}}')
    result = extractor.finish()

    assert result.complete is False
    assert result.error == "invalid number"


def test_incomplete_json_discards_seen_values():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")}
    )

    extractor.feed(b'{"usage":{"input_tokens":42}')
    result = extractor.finish()

    assert result.complete is False
    assert result.values == {}


def test_incomplete_json_after_number_reports_error():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")}
    )

    extractor.feed(b'{"usage":{"input_tokens":42')
    result = extractor.finish()

    assert result.complete is False
    assert result.error == "incomplete json"
    assert result.values == {}


def test_incomplete_literal_reports_error():
    extractor = JsonSelectiveExtractor()

    extractor.feed(b'{"ok":tru')
    result = extractor.finish()

    assert result.complete is False
    assert result.error == "incomplete literal"


def test_split_literals_continue_to_later_selected_fields():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")}
    )

    extractor.feed(b'{"ok":tr')
    extractor.feed(b'ue,"missing":nul')
    extractor.feed(b'l,"off":fal')
    extractor.feed(b'se,"usage":{"input_tokens":7}}')
    result = extractor.finish()

    assert result.complete is True
    assert result.values == {("usage", "input_tokens"): 7}
