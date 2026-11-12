"""Observation contracts for bounded selective JSON extraction."""

import json
import sys
from types import FrameType

import pytest

from usage import json_selective
from usage.json_selective import FIRST_ARRAY_ELEMENT, JsonSelectiveExtractor, ScalarField

_COMMON_SCALAR_FIELDS = {
    ("id",): ScalarField("string"),
    ("model",): ScalarField("string"),
    ("usage", "input_tokens"): ScalarField("int"),
    ("usage", "output_tokens"): ScalarField("int"),
    ("meta", "result_count"): ScalarField("int"),
    ("meta", "total_tweet_count"): ScalarField("int"),
}
_COMMON_ARRAY_COUNT_PATHS = {("data",), ("errors",)}
_COMMON_WILDCARD_ARRAY_COUNT_PATHS = {("includes", "*")}
_COMMON_OBJECT_PRESENCE_PATHS = {(), ("data",)}
_WILDCARD_INTERNAL_MARKER_KEYS = frozenset(
    (
        "\0__json_selective_unknown_key__",
        "\0__json_selective_array_element__",
    )
)


def _get_path(data: object, path: tuple[str, ...]) -> tuple[object, bool]:
    cur = data
    for key in path:
        if not isinstance(cur, dict) or key not in cur:
            return None, False
        cur = cur[key]
    return cur, True


def _expected_common_extraction(data: object):
    values = {}
    for path, field in _COMMON_SCALAR_FIELDS.items():
        value, found = _get_path(data, path)
        if not found:
            continue
        if (field.kind == "string" and isinstance(value, str)) or (
            field.kind == "int" and isinstance(value, int) and not isinstance(value, bool)
        ):
            values[path] = value

    array_counts = {}
    for path in _COMMON_ARRAY_COUNT_PATHS:
        value, found = _get_path(data, path)
        if found and isinstance(value, list):
            array_counts[path] = len(value)

    wildcard_array_counts = {}
    includes = data.get("includes") if isinstance(data, dict) else None
    if isinstance(includes, dict):
        counts = {
            key: len(value)
            for key, value in includes.items()
            if isinstance(key, str)
            and isinstance(value, list)
            and key not in _WILDCARD_INTERNAL_MARKER_KEYS
        }
        if counts:
            wildcard_array_counts[("includes", "*")] = counts

    object_present = set()
    if isinstance(data, dict):
        object_present.add(())
        if isinstance(data.get("data"), dict):
            object_present.add(("data",))

    return values, array_counts, wildcard_array_counts, object_present


def _common_extractor() -> JsonSelectiveExtractor:
    return JsonSelectiveExtractor(
        scalar_fields=_COMMON_SCALAR_FIELDS,
        array_count_paths=_COMMON_ARRAY_COUNT_PATHS,
        wildcard_array_count_paths=_COMMON_WILDCARD_ARRAY_COUNT_PATHS,
        object_presence_paths=_COMMON_OBJECT_PRESENCE_PATHS,
    )


def test_diagnostic_scalar_can_observe_completed_value_in_incomplete_json():
    extractor = JsonSelectiveExtractor(scalar_fields={("type",): ScalarField("string")})

    extractor.feed(b'{"type":"message_start","message":{"id":"msg_1","mod')
    result = extractor.finish()

    assert result.complete is False
    assert result.values == {}
    assert extractor.observed_scalar_for_diagnostics(("type",)) == "message_start"


def test_diagnostic_scalar_does_not_return_stale_duplicate_value():
    extractor = JsonSelectiveExtractor(scalar_fields={("type",): ScalarField("string")})

    extractor.feed(b'{"type":"message_start","type":"message_delta')
    result = extractor.finish()

    assert result.complete is False
    assert result.values == {}
    assert extractor.observed_scalar_for_diagnostics(("type",)) is None


def test_common_extraction_matches_json_loads_across_chunk_sizes():
    payloads = [
        (
            b'{"id":"msg_1","model":"claude\\n\\u2603",'
            b'"content":[{"text":"ignored"}],'
            b'"usage":{"input_tokens":10,"output_tokens":5},'
            b'"data":[{"id":"1"},{"id":"2"}],"errors":[{"title":"bad"}],'
            b'"includes":{"users":[{"id":"u1"},{"id":"u2"}],"tweets":[{"id":"t1"}]},'
            b'"meta":{"result_count":3}}'
        ),
        (
            b'{"id":"msg_2","data":{"id":"1"},'
            b'"usage":{"input_tokens":0,"output_tokens":7},'
            b'"meta":{"total_tweet_count":9}}'
        ),
        (
            b'{"includes":{"\\u0000__json_selective_unknown_key__":[{"id":"internal-1"}],'
            b'"\\u0000__json_selective_array_element__":[{"id":"internal-2"}],'
            b'"\\u0000__json_selective_custom":[{"id":"custom-1"},{"id":"custom-2"}]}}'
        ),
    ]

    for payload in payloads:
        expected = _expected_common_extraction(json.loads(payload))
        for chunk_size in (1, 2, 3, 5, 8, 13):
            extractor = _common_extractor()
            for idx in range(0, len(payload), chunk_size):
                extractor.feed(payload[idx : idx + chunk_size])
            result = extractor.finish()

            assert result.complete is True
            assert (
                result.values,
                result.array_counts,
                result.wildcard_array_counts,
                result.object_present,
            ) == expected


def test_extracts_selected_scalars_across_chunks():
    extractor = JsonSelectiveExtractor(
        scalar_fields={
            ("model",): ScalarField("string"),
            ("usage", "input_tokens"): ScalarField("int"),
        }
    )

    extractor.feed(b'{"mo')
    extractor.feed(b'del":"claude","usage":{"input_')
    extractor.feed(b'tokens":42}}')
    result = extractor.finish()

    assert result.complete is True
    assert result.values == {
        ("model",): "claude",
        ("usage", "input_tokens"): 42,
    }


def test_counts_arrays_and_wildcard_child_arrays():
    extractor = JsonSelectiveExtractor(
        array_count_paths={("data",), ("errors",)},
        wildcard_array_count_paths={("includes", "*")},
    )

    extractor.feed(
        b'{"data":[{"id":"1"},{"id":"2"}],'
        b'"errors":[{"title":"bad"}],'
        b'"includes":{"users":[{"id":"u1"}],"tweets":[{"id":"t1"},{"id":"t2"}]}}'
    )
    result = extractor.finish()

    assert result.complete is True
    assert result.array_counts == {("data",): 2, ("errors",): 1}
    assert result.wildcard_array_counts == {("includes", "*"): {"users": 1, "tweets": 2}}


def test_counts_all_matching_wildcard_patterns():
    extractor = JsonSelectiveExtractor(
        wildcard_array_count_paths={("a", "*"), ("*", "b")},
    )

    extractor.feed(b'{"a":{"b":[{"id":"1"},{"id":"2"}]}}')
    result = extractor.finish()

    assert result.complete is True
    assert result.wildcard_array_counts == {
        ("a", "*"): {"b": 2},
        ("*", "b"): {"a": 2},
    }


def test_wildcard_pattern_collects_keys_after_wildcard_segment():
    extractor = JsonSelectiveExtractor(wildcard_array_count_paths={("*", "items")})

    extractor.feed(b'{"a":{"items":[1,2]},"b":{"items":[3]}}')
    result = extractor.finish()

    assert result.complete is True
    assert result.wildcard_array_counts == {("*", "items"): {"a": 2, "b": 1}}


def test_mixed_paths_match_collection_prefixes_once_per_object_across_chunks():
    generic_match_calls = 0
    generic_match_code = json_selective._matches_any_path_pattern.__code__

    # Profile the public parser operation so the real matcher stays in place
    # while calls provide a deterministic performance contract.
    def count_generic_match_calls(frame: FrameType, event: str, _arg: object) -> None:
        nonlocal generic_match_calls
        if event == "call" and frame.f_code is generic_match_code:
            generic_match_calls += 1

    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")},
        wildcard_array_count_paths={("*", "items")},
    )
    chunks = (
        b'{"alpha":{"empty":{},"noise":{"deep":1},"first":0,',
        b'"second":0,"items":[1,2]},"usage":{"input_',
        b'tokens":7}}',
    )

    previous_profile = sys.getprofile()
    sys.setprofile(count_generic_match_calls)
    try:
        for chunk in chunks:
            extractor.feed(chunk)
    finally:
        sys.setprofile(previous_profile)
    result = extractor.finish()

    assert result.complete is True
    assert result.values == {("usage", "input_tokens"): 7}
    assert result.wildcard_array_counts == {("*", "items"): {"alpha": 2}}
    # The wildcard prefix is checked at most once for "alpha" and once for its
    # unselected "noise" object, never for the empty object or every key.
    assert generic_match_calls <= 2


def test_leading_wildcard_does_not_match_array_element_marker():
    extractor = JsonSelectiveExtractor(wildcard_array_count_paths={("*", "items")})

    extractor.feed(b'[{"items":[1,2]}]')
    result = extractor.finish()

    assert result.complete is True
    assert result.wildcard_array_counts == {}


def test_counts_empty_arrays_as_zero():
    extractor = JsonSelectiveExtractor(array_count_paths={("data",), ("errors",)})

    extractor.feed(b'{"data":[],"errors":[]}')
    result = extractor.finish()

    assert result.complete is True
    assert result.array_counts == {("data",): 0, ("errors",): 0}


def test_array_element_object_does_not_record_parent_object_presence():
    extractor = JsonSelectiveExtractor(
        array_count_paths={("data",)},
        object_presence_paths={(), ("data",)},
    )

    extractor.feed(b'{"data":[{"id":"1"}]}')
    result = extractor.finish()

    assert result.complete is True
    assert result.array_counts == {("data",): 1}
    assert result.object_present == {()}


def test_array_element_object_fields_do_not_match_object_paths():
    extractor = JsonSelectiveExtractor(
        scalar_fields={
            ("model",): ScalarField("string"),
            ("usage", "input_tokens"): ScalarField("int"),
        },
        wildcard_array_count_paths={("includes", "*")},
    )

    extractor.feed(
        b'[{"model":"claude","usage":{"input_tokens":7},"includes":{"users":[{"id":"u1"}]}}]'
    )
    result = extractor.finish()

    assert result.complete is True
    assert result.values == {}
    assert result.wildcard_array_counts == {}


def test_selects_only_first_array_element_across_chunks():
    prompt_tokens_path = (
        "choices",
        FIRST_ARRAY_ELEMENT,
        "usage",
        "prompt_tokens",
    )
    usage_path = ("choices", FIRST_ARRAY_ELEMENT, "usage")
    payload = b'{"choices":[{"usage":{"prompt_tokens":7}},{"usage":{"prompt_tokens":99}}]}'

    for chunk_size in (1, 2, 5, len(payload)):
        extractor = JsonSelectiveExtractor(
            scalar_fields={prompt_tokens_path: ScalarField("int")},
            object_presence_paths={usage_path},
            value_presence_paths={usage_path},
        )
        for offset in range(0, len(payload), chunk_size):
            extractor.feed(payload[offset : offset + chunk_size])
        result = extractor.finish()

        assert result.complete is True
        assert result.values == {prompt_tokens_path: 7}
        assert result.object_present == {usage_path}
        assert result.value_present == {usage_path}


def test_first_array_element_marker_cannot_match_an_object_key():
    prompt_tokens_path = (
        "choices",
        FIRST_ARRAY_ELEMENT,
        "usage",
        "prompt_tokens",
    )
    extractor = JsonSelectiveExtractor(scalar_fields={prompt_tokens_path: ScalarField("int")})

    extractor.feed(
        b'{"choices":{"\\u0000__json_selective_array_element__":{"usage":{"prompt_tokens":99}}}}'
    )
    result = extractor.finish()

    assert result.complete is True
    assert result.values == {}


def test_array_value_fields_do_not_match_object_paths():
    extractor = JsonSelectiveExtractor(
        scalar_fields={
            ("model",): ScalarField("string"),
            ("usage", "input_tokens"): ScalarField("int"),
        }
    )

    extractor.feed(b'{"model":"claude","usage":[{"input_tokens":7}]}')
    result = extractor.finish()

    assert result.complete is True
    assert result.values == {("model",): "claude"}


def test_root_array_object_does_not_record_root_object_presence():
    extractor = JsonSelectiveExtractor(object_presence_paths={()})

    extractor.feed(b'[{"id":"1"}]')
    result = extractor.finish()

    assert result.complete is True
    assert result.object_present == set()


def test_duplicate_scalar_parent_uses_last_value():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")}
    )

    extractor.feed(b'{"usage":{"input_tokens":7},"usage":{}}')
    result = extractor.finish()

    assert result.complete is True
    assert result.values == {}


def test_duplicate_array_path_uses_last_value_kind():
    extractor = JsonSelectiveExtractor(
        array_count_paths={("data",)},
        object_presence_paths={("data",)},
    )

    extractor.feed(b'{"data":[{"id":"1"},{"id":"2"}],"data":{"id":"3"}}')
    result = extractor.finish()

    assert result.complete is True
    assert result.array_counts == {}
    assert result.object_present == {("data",)}


def test_duplicate_object_path_replaced_by_array_clears_presence():
    extractor = JsonSelectiveExtractor(
        array_count_paths={("data",)},
        object_presence_paths={("data",)},
    )

    extractor.feed(b'{"data":{"id":"1"},"data":[]}')
    result = extractor.finish()

    assert result.complete is True
    assert result.array_counts == {("data",): 0}
    assert result.object_present == set()


def test_duplicate_wildcard_parent_clears_previous_counts():
    extractor = JsonSelectiveExtractor(wildcard_array_count_paths={("includes", "*")})

    extractor.feed(b'{"includes":{"users":[{"id":"1"},{"id":"2"}]},"includes":{}}')
    result = extractor.finish()

    assert result.complete is True
    assert result.wildcard_array_counts == {}


def test_duplicate_wildcard_child_uses_last_array_count():
    extractor = JsonSelectiveExtractor(wildcard_array_count_paths={("includes", "*")})

    extractor.feed(b'{"includes":{"users":[{"id":"1"},{"id":"2"}],"users":[]}}')
    result = extractor.finish()

    assert result.complete is True
    assert result.wildcard_array_counts == {("includes", "*"): {"users": 0}}


def test_duplicate_wildcard_prefix_keeps_unrelated_keys():
    extractor = JsonSelectiveExtractor(wildcard_array_count_paths={("*", "items")})

    extractor.feed(b'{"a":{"items":[1,2]},"b":{"items":[3]},"b":{}}')
    result = extractor.finish()

    assert result.complete is True
    assert result.wildcard_array_counts == {("*", "items"): {"a": 2}}


def test_records_object_presence():
    extractor = JsonSelectiveExtractor(object_presence_paths={("data",)})

    extractor.feed(b'{"data":{"id":"1"}}')
    result = extractor.finish()

    assert result.complete is True
    assert result.object_present == {("data",)}


@pytest.mark.parametrize(
    "value",
    [b"null", b"false", b"0", b'"text"', b"[]", b"{}"],
)
def test_records_any_selected_value_presence(value):
    extractor = JsonSelectiveExtractor(value_presence_paths={("usage",)})

    extractor.feed(b'{"usage":' + value + b"}")
    result = extractor.finish()

    assert result.complete is True
    assert result.value_present == {("usage",)}


def test_duplicate_parent_clears_descendant_value_presence():
    extractor = JsonSelectiveExtractor(
        value_presence_paths={("usage",), ("usage", "cached_tokens")}
    )

    extractor.feed(b'{"usage":{"cached_tokens":7},"usage":null}')
    result = extractor.finish()

    assert result.complete is True
    assert result.value_present == {("usage",)}


def test_rejects_excessive_depth():
    extractor = JsonSelectiveExtractor(max_depth=2)

    extractor.feed(b'{"a":{"b":{"c":1}}}')
    result = extractor.finish()

    assert result.complete is False
    assert result.error == "max depth exceeded"


def test_default_depth_allows_deep_unselected_subtree():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")}
    )
    depth = 80

    extractor.feed(b'{"content":')
    extractor.feed(b'{"x":' * depth)
    extractor.feed(b"0")
    extractor.feed(b"}" * depth)
    extractor.feed(b',"usage":{"input_tokens":7}}')
    result = extractor.finish()

    assert result.complete is True
    assert result.values == {("usage", "input_tokens"): 7}


def test_rejects_too_many_wildcard_keys():
    extractor = JsonSelectiveExtractor(
        wildcard_array_count_paths={("includes", "*")},
        max_wildcard_keys=1,
    )

    extractor.feed(b'{"includes":{"users":[],"tweets":[]}}')
    result = extractor.finish()

    assert result.complete is False
    assert result.error == "max wildcard keys exceeded"


@pytest.mark.parametrize(
    ("kind", "first", "different", "wrong", "first_value", "different_value"),
    [
        pytest.param("string", b'"a"', b'"b"', b"0", "a", "b", id="string"),
        pytest.param("int", b"1", b"2", b"true", 1, 2, id="integer"),
        pytest.param("bool", b"false", b"true", b"0", False, True, id="boolean"),
    ],
)
def test_scalar_consistency_retains_overwritten_occurrences(
    kind, first, different, wrong, first_value, different_value
):
    path = ("p", "v")
    cases = [
        (b'{"p":{"v":' + first + b"}}", {path: first_value}, True),
        (b'{"p":{"v":' + first + b',"v":' + first + b"}}", {path: first_value}, True),
        (
            b'{"p":{"v":' + first + b',"v":' + different + b"}}",
            {path: different_value},
            False,
        ),
        (b'{"p":{"v":' + wrong + b',"v":' + first + b"}}", {path: first_value}, False),
        (b'{"p":{"v":' + first + b',"v":' + wrong + b"}}", {}, False),
        (b'{"p":{"v":' + first + b'},"p":{}}', {}, True),
    ]
    for payload, expected_values, expected_consistent in cases:
        for chunk_size in (1, len(payload)):
            extractor = JsonSelectiveExtractor(
                scalar_fields={path: ScalarField(kind)}, scalar_consistency_paths={path}
            )
            for offset in range(0, len(payload), chunk_size):
                extractor.feed(payload[offset : offset + chunk_size])
            result = extractor.finish()

            assert result.complete, (payload, chunk_size)
            assert result.values == expected_values, (payload, chunk_size)
            assert extractor.selected_scalar_values_are_consistent(path) is expected_consistent, (
                payload,
                chunk_size,
            )
