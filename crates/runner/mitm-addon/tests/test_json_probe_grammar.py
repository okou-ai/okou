"""Differential grammar tests for bounded JSON field probing."""

import hashlib
import json
from typing import Literal, cast

import pytest

from usage.json_probe import (
    TopLevelStringFieldProbeResult,
    probe_top_level_string_field,
)


class _ObjectPairs(list[tuple[str, object]]):
    pass


_BoundName = Literal["max_depth", "max_key_bytes", "max_string_bytes"]

_GENERATION_SEED = "issue-29791-json-probe-v1"
_GENERATED_DOCUMENT_COUNT = 256
_MAX_GENERATED_DEPTH = 3
_MAX_GENERATED_WIDTH = 3
_JSON_WHITESPACE = (b"", b" ", b"\n", b"\t")
_GENERATED_NON_TARGET_KEYS = (
    "padding",
    "metadata",
    "type_hint",
    'quoted"key',
    "雪",
)
_GENERATED_NESTED_KEYS = (*_GENERATED_NON_TARGET_KEYS, "type")
_GENERATED_STRINGS = (
    "",
    "plain",
    'quoted " value',
    "line\nbreak",
    "back\\slash",
    "雪",
    "😀",
)
_GENERATED_NUMBERS = (
    b"0",
    b"-0",
    b"17",
    b"-42",
    b"3.125",
    b"-2.5e+3",
    b"6.02E-4",
)
_GENERATED_TARGET_STRINGS = (
    "",
    "response.completed",
    'quoted " target',
    "line\nbreak",
    "雪",
    "😀",
)
_GENERATED_NON_STRING_TARGETS = (b"null", b"true", b"0", b"[]", b"{}")
_MALFORMED_VALUES: dict[str, bytes] = {
    "string-invalid-escape": b'"bad\\q"',
    "string-control-character": b'"bad\x1fvalue"',
    "number-leading-zero": b"01",
    "number-missing-fraction-digit": b"1.",
    "number-missing-exponent-digit": b"1e+",
    "literal-altered-true": b"trux",
    "literal-overlong-false": b"falsex",
    "array-trailing-comma": b"[0,]",
    "array-missing-comma": b"[0 1]",
    "array-duplicate-comma": b"[0,,1]",
    "object-trailing-comma": b'{"key":0,}',
    "object-missing-comma": b'{"key":0 "next":1}',
    "object-missing-colon": b'{"key" 0}',
}


def _generated_index(case_index: int, salt: str, size: int) -> int:
    # A stable hash provides reproducible choices without random.Random, which
    # the add-on's security lint rejects through S311.
    payload = f"{_GENERATION_SEED}:{case_index}:{salt}".encode()
    digest = hashlib.sha256(payload).digest()
    return int.from_bytes(digest[:8]) % size


def _generated_whitespace(case_index: int, salt: str) -> bytes:
    return _JSON_WHITESPACE[
        _generated_index(case_index, f"{salt}:whitespace", len(_JSON_WHITESPACE))
    ]


def _generated_json_string(case_index: int, salt: str, value: str) -> bytes:
    ensure_ascii = _generated_index(case_index, f"{salt}:ensure-ascii", 2) == 0
    return json.dumps(value, ensure_ascii=ensure_ascii).encode()


def _generated_json_array(
    case_index: int,
    salt: str,
    values: list[bytes],
) -> bytes:
    separator = (
        _generated_whitespace(case_index, f"{salt}:separator-before")
        + b","
        + _generated_whitespace(case_index, f"{salt}:separator-after")
    )
    return (
        b"["
        + _generated_whitespace(case_index, f"{salt}:open")
        + separator.join(values)
        + _generated_whitespace(case_index, f"{salt}:close")
        + b"]"
    )


def _generated_json_object(
    case_index: int,
    salt: str,
    members: list[tuple[bytes, bytes]],
) -> bytes:
    rendered_members = [
        key
        + _generated_whitespace(case_index, f"{salt}:member:{index}:colon-before")
        + b":"
        + _generated_whitespace(case_index, f"{salt}:member:{index}:colon-after")
        + value
        for index, (key, value) in enumerate(members)
    ]
    separator = (
        _generated_whitespace(case_index, f"{salt}:separator-before")
        + b","
        + _generated_whitespace(case_index, f"{salt}:separator-after")
    )
    return (
        b"{"
        + _generated_whitespace(case_index, f"{salt}:open")
        + separator.join(rendered_members)
        + _generated_whitespace(case_index, f"{salt}:close")
        + b"}"
    )


def _generated_json_scalar(case_index: int, salt: str) -> bytes:
    scalar_kind = _generated_index(case_index, f"{salt}:kind", 5)
    if scalar_kind == 0:
        value = _GENERATED_STRINGS[
            _generated_index(case_index, f"{salt}:string", len(_GENERATED_STRINGS))
        ]
        return _generated_json_string(case_index, salt, value)
    if scalar_kind == 1:
        return _GENERATED_NUMBERS[
            _generated_index(case_index, f"{salt}:number", len(_GENERATED_NUMBERS))
        ]
    return (b"true", b"false", b"null")[scalar_kind - 2]


def _generated_json_value(case_index: int, salt: str, depth: int) -> bytes:
    if depth >= _MAX_GENERATED_DEPTH:
        return _generated_json_scalar(case_index, salt)

    value_kind = _generated_index(case_index, f"{salt}:value-kind", 7)
    if value_kind < 5:
        return _generated_json_scalar(case_index, salt)

    width = _generated_index(case_index, f"{salt}:width", _MAX_GENERATED_WIDTH + 1)
    if value_kind == 5:
        return _generated_json_array(
            case_index,
            salt,
            [
                _generated_json_value(case_index, f"{salt}:item:{index}", depth + 1)
                for index in range(width)
            ],
        )

    members = []
    for index in range(width):
        member_salt = f"{salt}:member:{index}"
        key = _GENERATED_NESTED_KEYS[
            _generated_index(case_index, f"{member_salt}:key", len(_GENERATED_NESTED_KEYS))
        ]
        members.append(
            (
                _generated_json_string(case_index, f"{member_salt}:key", key),
                _generated_json_value(case_index, f"{member_salt}:value", depth + 1),
            )
        )
    return _generated_json_object(case_index, salt, members)


def _generated_axis_value(case_index: int) -> bytes:
    axis = case_index % 8
    if axis == 0:
        value = _GENERATED_STRINGS[(case_index // 8) % len(_GENERATED_STRINGS)]
        return _generated_json_string(case_index, "axis:string", value)
    if axis == 1:
        return _GENERATED_NUMBERS[(case_index // 8) % len(_GENERATED_NUMBERS)]
    if axis == 2:
        return b"true"
    if axis == 3:
        return b"false"
    if axis == 4:
        return b"null"
    if axis == 5:
        return _generated_json_array(
            case_index,
            "axis:array",
            [_generated_json_value(case_index, "axis:array:item", 1)],
        )
    if axis == 6:
        return _generated_json_object(
            case_index,
            "axis:object",
            [
                (
                    _generated_json_string(case_index, "axis:object:key", "nested"),
                    _generated_json_value(case_index, "axis:object:value", 1),
                )
            ],
        )
    nested_object = _generated_json_object(
        case_index,
        "axis:nested:object",
        [
            (
                _generated_json_string(case_index, "axis:nested:key", "type"),
                _generated_json_value(case_index, "axis:nested:value", 2),
            )
        ],
    )
    return _generated_json_array(case_index, "axis:nested:array", [nested_object])


def _generated_target_key(case_index: int, duplicate_index: int = 0) -> bytes:
    if (case_index + duplicate_index) % 4 == 0:
        return b'"ty\\u0070e"'
    return _generated_json_string(case_index, f"target:{duplicate_index}:key", "type")


def _generated_target_string(case_index: int, duplicate_index: int = 0) -> bytes:
    value = _GENERATED_TARGET_STRINGS[
        (case_index // 6 + duplicate_index) % len(_GENERATED_TARGET_STRINGS)
    ]
    return _generated_json_string(case_index, f"target:{duplicate_index}:value", value)


def _generated_document(case_index: int) -> bytes:
    padding_key_value = _GENERATED_NON_TARGET_KEYS[
        _generated_index(case_index, "padding:key", len(_GENERATED_NON_TARGET_KEYS))
    ]
    padding_member = (
        _generated_json_string(case_index, "padding:key", padding_key_value),
        _generated_axis_value(case_index),
    )
    other_member = (
        _generated_json_string(case_index, "other:key", "other"),
        _generated_json_value(case_index, "other:value", 0),
    )
    target_shape = case_index % 6
    target_member = (_generated_target_key(case_index), _generated_target_string(case_index))
    if target_shape == 0:
        members = [padding_member, other_member]
    elif target_shape == 1:
        members = [target_member, padding_member, other_member]
    elif target_shape == 2:
        members = [padding_member, other_member, target_member]
    elif target_shape == 3:
        non_string = _GENERATED_NON_STRING_TARGETS[
            (case_index // 6) % len(_GENERATED_NON_STRING_TARGETS)
        ]
        members = [padding_member, (_generated_target_key(case_index), non_string), other_member]
    elif target_shape == 4:
        duplicate_member = (
            _generated_target_key(case_index, 1),
            _generated_target_string(case_index, 1),
        )
        members = [target_member, padding_member, duplicate_member]
    else:
        non_string = _GENERATED_NON_STRING_TARGETS[
            (case_index // 6) % len(_GENERATED_NON_STRING_TARGETS)
        ]
        duplicate_member = (
            _generated_target_key(case_index, 1),
            _generated_target_string(case_index, 1),
        )
        members = [
            (_generated_target_key(case_index), non_string),
            padding_member,
            duplicate_member,
        ]

    return (
        _generated_whitespace(case_index, "document:before")
        + _generated_json_object(case_index, "document", members)
        + _generated_whitespace(case_index, "document:after")
    )


_GENERATED_DOCUMENTS = tuple(
    _generated_document(case_index) for case_index in range(_GENERATED_DOCUMENT_COUNT)
)


_VALID_DOCUMENTS: dict[str, bytes] = {
    "empty-object": b"{}",
    "field-first": b'{"type":"response.completed","padding":[]}',
    "field-late-all-kinds": (
        b'{"string":"text","integer":0,"number":-2.5e+3,'
        b'"true":true,"false":false,"null":null,'
        b'"array":[1,{"nested":[]}],"object":{"type":"nested"},'
        b'"type":"response.output_text.delta"}'
    ),
    "nested-only": b'{"metadata":{"type":"nested"},"items":[{"type":"also_nested"}]}',
    "whitespace-and-escapes": (
        b'{\n  "ty\\u0070e" : "response.\\u0063ompleted",\n  "padding" : null\n}'
    ),
    "duplicate-string": b'{"type":"first","type":"second"}',
    "duplicate-non-string": b'{"type":null,"type":"second"}',
    "non-string-array": b'{"type":[]}',
}


def _expected_probe_result(
    body: bytes,
    field_name: str = "type",
) -> TopLevelStringFieldProbeResult:
    decoded: object = json.loads(body, object_pairs_hook=_ObjectPairs)
    assert isinstance(decoded, _ObjectPairs)

    for key, value in decoded:
        if key != field_name:
            continue
        if isinstance(value, str):
            return TopLevelStringFieldProbeResult("found", value, field_seen=True)
        return TopLevelStringFieldProbeResult("non_string", field_seen=True)

    return TopLevelStringFieldProbeResult("not_found")


@pytest.mark.parametrize(
    "value",
    [
        pytest.param(b'"text"', id="string"),
        pytest.param(b"-12", id="integer"),
        pytest.param(b"-2.5e+3", id="fractional-exponent-number"),
        pytest.param(b"true", id="true"),
        pytest.param(b"false", id="false"),
        pytest.param(b"null", id="null"),
        pytest.param(b"[]", id="empty-array"),
        pytest.param(b'[0,"x",true,null,{},[]]', id="non-empty-array"),
        pytest.param(b"{}", id="empty-object"),
        pytest.param(b'{"nested":[false,{"deep":null}]}', id="non-empty-object"),
    ],
)
def test_probe_skips_every_json_value_kind_before_selected_field(value: bytes):
    body = b'{"padding":' + value + b',"type":"response.completed"}'

    result = probe_top_level_string_field(body)

    assert result == TopLevelStringFieldProbeResult(
        "found",
        "response.completed",
        field_seen=True,
    )


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        pytest.param(
            b'{"type":"ok"}',
            TopLevelStringFieldProbeResult("found", "ok", field_seen=True),
            id="found",
        ),
        pytest.param(
            b'{"padding":[]}',
            TopLevelStringFieldProbeResult("not_found"),
            id="not-found",
        ),
        pytest.param(
            b'{"padding":[]',
            TopLevelStringFieldProbeResult("incomplete"),
            id="truncated-after-value",
        ),
        pytest.param(
            b'{"padding":[],',
            TopLevelStringFieldProbeResult("incomplete"),
            id="truncated-after-comma",
        ),
        pytest.param(
            b'{"padding" []}',
            TopLevelStringFieldProbeResult("invalid"),
            id="missing-colon",
        ),
        pytest.param(
            b'{"padding":[] "type":"ok"}',
            TopLevelStringFieldProbeResult("invalid"),
            id="missing-comma",
        ),
        pytest.param(
            b'{"padding":[],}',
            TopLevelStringFieldProbeResult("invalid"),
            id="trailing-comma",
        ),
        pytest.param(
            b'{"type":[]}',
            TopLevelStringFieldProbeResult("non_string", field_seen=True),
            id="non-string",
        ),
    ],
)
def test_probe_reports_complete_result_at_separator_and_truncation_boundaries(
    body: bytes,
    expected: TopLevelStringFieldProbeResult,
):
    assert probe_top_level_string_field(body) == expected


def test_probe_reports_complete_result_when_configured_bounds_are_exceeded():
    assert probe_top_level_string_field(
        b'{"padding":"longer","type":"ok"}',
        max_string_bytes=4,
    ) == TopLevelStringFieldProbeResult("bound_exceeded")
    assert probe_top_level_string_field(
        b'{"type":"longer"}',
        max_string_bytes=4,
    ) == TopLevelStringFieldProbeResult("bound_exceeded", field_seen=True)
    assert probe_top_level_string_field(
        b'{"padding":{},"type":"ok"}',
        max_depth=1,
    ) == TopLevelStringFieldProbeResult("bound_exceeded")


@pytest.mark.parametrize(
    "body",
    _VALID_DOCUMENTS.values(),
    ids=_VALID_DOCUMENTS.keys(),
)
def test_probe_matches_json_oracle_for_complete_valid_objects(body: bytes):
    assert probe_top_level_string_field(body) == _expected_probe_result(body)


@pytest.mark.parametrize(
    "body",
    _VALID_DOCUMENTS.values(),
    ids=_VALID_DOCUMENTS.keys(),
)
def test_probe_valid_document_prefixes_are_incomplete_or_correctly_terminal(body: bytes):
    expected = _expected_probe_result(body)

    for end in range(len(body) + 1):
        prefix = body[:end]
        result = probe_top_level_string_field(prefix)

        if result.status == "incomplete":
            assert result.value is None
        else:
            assert result == expected, f"unexpected result at byte {end}: {prefix!r}"


def test_probe_matches_json_oracle_for_generated_valid_objects():
    for case_index, body in enumerate(_GENERATED_DOCUMENTS):
        expected = _expected_probe_result(body)

        assert probe_top_level_string_field(body) == expected, (
            f"seed={_GENERATION_SEED} case={case_index} body={body!r}"
        )


def test_probe_generated_valid_document_prefixes_are_incomplete_or_terminal():
    for case_index, body in enumerate(_GENERATED_DOCUMENTS):
        expected = _expected_probe_result(body)

        for end in range(len(body) + 1):
            prefix = body[:end]
            result = probe_top_level_string_field(prefix)
            if result.status == "incomplete":
                assert result.value is None, (
                    f"seed={_GENERATION_SEED} case={case_index} byte={end} prefix={prefix!r}"
                )
            else:
                assert result == expected, (
                    f"seed={_GENERATION_SEED} case={case_index} byte={end} prefix={prefix!r}"
                )


@pytest.mark.parametrize(
    ("case_index", "malformed_value"),
    [
        pytest.param(case_index, malformed_value, id=name)
        for case_index, (name, malformed_value) in enumerate(_MALFORMED_VALUES.items())
    ],
)
def test_probe_generated_malformed_values_never_find_later_target(
    case_index: int,
    malformed_value: bytes,
):
    body = _generated_json_object(
        case_index,
        "malformed",
        [
            (_generated_json_string(case_index, "malformed:key", "padding"), malformed_value),
            (_generated_target_key(case_index), _generated_target_string(case_index)),
        ],
    )

    for end in range(len(body) + 1):
        prefix = body[:end]
        result = probe_top_level_string_field(prefix)

        assert result.status != "found", (
            f"seed={_GENERATION_SEED} case={case_index} byte={end} prefix={prefix!r}"
        )

    assert probe_top_level_string_field(body) == TopLevelStringFieldProbeResult("invalid")


def _probe_with_bound(bound_name: _BoundName, bound_value: int):
    if bound_name == "max_depth":
        return probe_top_level_string_field(b"{}", max_depth=bound_value)
    if bound_name == "max_key_bytes":
        return probe_top_level_string_field(b"{}", max_key_bytes=bound_value)
    return probe_top_level_string_field(b"{}", max_string_bytes=bound_value)


@pytest.mark.parametrize("bound_name", ["max_depth", "max_key_bytes", "max_string_bytes"])
@pytest.mark.parametrize("invalid_value", [True, 1.5, "1", None])
def test_probe_rejects_non_integer_bounds(bound_name: _BoundName, invalid_value: object):
    with pytest.raises(TypeError, match=rf"^{bound_name} must be an integer$"):
        _probe_with_bound(bound_name, cast(int, invalid_value))


@pytest.mark.parametrize("bound_name", ["max_depth", "max_key_bytes", "max_string_bytes"])
@pytest.mark.parametrize("invalid_value", [0, -1])
def test_probe_rejects_non_positive_bounds(bound_name: _BoundName, invalid_value: int):
    with pytest.raises(ValueError, match=rf"^{bound_name} must be a positive integer$"):
        _probe_with_bound(bound_name, invalid_value)


@pytest.mark.parametrize(
    ("max_key_bytes", "expected"),
    [
        pytest.param(
            5,
            TopLevelStringFieldProbeResult("bound_exceeded"),
            id="below-escaped-key-source-length",
        ),
        pytest.param(
            6,
            TopLevelStringFieldProbeResult("found", "ok", field_seen=True),
            id="at-escaped-key-source-length",
        ),
    ],
)
def test_probe_enforces_raw_key_byte_boundary(
    max_key_bytes: int,
    expected: TopLevelStringFieldProbeResult,
):
    assert (
        probe_top_level_string_field(
            b'{"\\u006b":null,"t":"ok"}',
            "t",
            max_key_bytes=max_key_bytes,
        )
        == expected
    )


@pytest.mark.parametrize(
    ("body", "max_string_bytes", "expected"),
    [
        pytest.param(
            b'{"t":"\\u0061"}',
            5,
            TopLevelStringFieldProbeResult("bound_exceeded", field_seen=True),
            id="selected-below-escaped-source-length",
        ),
        pytest.param(
            b'{"t":"\\u0061"}',
            6,
            TopLevelStringFieldProbeResult("found", "a", field_seen=True),
            id="selected-at-escaped-source-length",
        ),
        pytest.param(
            b'{"padding":"\\u0061","t":"ok"}',
            5,
            TopLevelStringFieldProbeResult("bound_exceeded"),
            id="skipped-below-escaped-source-length",
        ),
        pytest.param(
            b'{"padding":"\\u0061","t":"ok"}',
            6,
            TopLevelStringFieldProbeResult("found", "ok", field_seen=True),
            id="skipped-at-escaped-source-length",
        ),
    ],
)
def test_probe_enforces_raw_string_byte_boundary(
    body: bytes,
    max_string_bytes: int,
    expected: TopLevelStringFieldProbeResult,
):
    assert (
        probe_top_level_string_field(
            body,
            "t",
            max_string_bytes=max_string_bytes,
        )
        == expected
    )


@pytest.mark.parametrize(
    ("body", "max_depth", "expected"),
    [
        pytest.param(
            b'{"padding":[{}],"t":"ok"}',
            2,
            TopLevelStringFieldProbeResult("bound_exceeded"),
            id="array-object-below-required-depth",
        ),
        pytest.param(
            b'{"padding":[{}],"t":"ok"}',
            3,
            TopLevelStringFieldProbeResult("found", "ok", field_seen=True),
            id="array-object-at-required-depth",
        ),
        pytest.param(
            b'{"padding":{"nested":[]},"t":"ok"}',
            2,
            TopLevelStringFieldProbeResult("bound_exceeded"),
            id="object-array-below-required-depth",
        ),
        pytest.param(
            b'{"padding":{"nested":[]},"t":"ok"}',
            3,
            TopLevelStringFieldProbeResult("found", "ok", field_seen=True),
            id="object-array-at-required-depth",
        ),
    ],
)
def test_probe_enforces_nested_container_depth_boundary(
    body: bytes,
    max_depth: int,
    expected: TopLevelStringFieldProbeResult,
):
    assert (
        probe_top_level_string_field(
            body,
            "t",
            max_depth=max_depth,
        )
        == expected
    )
