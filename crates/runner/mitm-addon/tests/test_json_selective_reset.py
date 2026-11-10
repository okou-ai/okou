"""Document reuse preserves selective extraction and its fixed configuration."""

from dataclasses import asdict

import pytest

from usage.json_selective import JsonSelectiveExtractor, ScalarField


@pytest.mark.parametrize("finish_first", [False, True])
@pytest.mark.parametrize(
    "first_document",
    [
        b"",
        b'{"id":"old","id":"other","data":[1,2],"includes":{"users":[1]},"meta":{}}',
        b'{"id":"old","data":[',
        b'{"id":"ol',
        b'{"id":"old","n":12',
        b'{"id":"old","unknown":tru',
        b'{"id":"old"} trailing',
        b'{"id":"much-too-long"}',
        b'{"id":"old","unknown":' + b"[" * 8,
    ],
)
def test_reset_starts_a_new_document_with_reusable_observation_storage(
    first_document, finish_first
):
    extractor = JsonSelectiveExtractor(
        scalar_fields={
            ("id",): ScalarField("string", max_bytes=8),
            ("n",): ScalarField("int"),
        },
        scalar_consistency_paths={("id",)},
        array_count_paths={("data",)},
        wildcard_array_count_paths={("includes", "*")},
        object_presence_paths={(), ("meta",)},
        value_presence_paths={("id",), ("meta",)},
        max_depth=4,
    )
    containers = (
        extractor.values,
        extractor.array_counts,
        extractor.wildcard_array_counts,
        extractor.object_present,
        extractor.value_present,
    )
    fields = extractor.scalar_fields
    extractor.feed(first_document)
    first_result = extractor.finish() if finish_first else None
    first_snapshot = asdict(first_result) if first_result is not None else None

    extractor.reset()
    extractor.reset()

    assert extractor.accepts_more_input()
    assert all(not container for container in containers)
    assert extractor.scalar_fields is fields
    assert extractor.selected_scalar_values_are_consistent(("id",))
    assert extractor.observed_scalar_for_diagnostics(("id",)) is None
    assert extractor.values is containers[0]
    assert extractor.array_counts is containers[1]
    assert extractor.wildcard_array_counts is containers[2]
    assert extractor.object_present is containers[3]
    assert extractor.value_present is containers[4]

    extractor.feed(b'{"id":"new","n":7,"data":[1],"includes":{"users":[1,2]},"meta":{}}')
    result = extractor.finish()

    assert result.complete
    assert result.error is None
    assert result.values == {("id",): "new", ("n",): 7}
    assert result.array_counts == {("data",): 1}
    assert result.wildcard_array_counts == {("includes", "*"): {"users": 2}}
    assert result.object_present == {(), ("meta",)}
    assert result.value_present == {("id",), ("meta",)}
    assert extractor.selected_scalar_values_are_consistent(("id",))
    if first_result is not None:
        assert asdict(first_result) == first_snapshot

    snapshot = asdict(result)
    extractor.reset()
    extractor.feed(b"{}")
    assert extractor.finish().complete
    assert asdict(result) == snapshot


@pytest.mark.parametrize(
    "first_document",
    [b"[0,1,2,3]", b'"' + b"\\u0078" * 100 + b'"'],
)
def test_reset_renews_the_document_work_budget_after_exhaustion(first_document):
    extractor = JsonSelectiveExtractor(max_work_units=4)
    extractor.feed(first_document)
    result = extractor.finish()
    assert not result.complete
    assert result.error == "work limit exceeded"

    extractor.reset()
    extractor.feed(b"0")

    assert extractor.finish().complete
