"""Total-work contracts for bounded selective JSON extraction."""

import pytest

from usage.json_selective import JsonSelectiveExtractor, ScalarField


@pytest.mark.parametrize(
    ("payload", "exact_work_units"),
    [
        (b"[" + (b"0," * 10)[:-1] + b"]", 22),
        (b"{" + b",".join([b'"x":0'] * 10) + b"}", 43),
        (b"   null", 5),
        (b'"' + b"\\n" * 17 + b'"', 3),
        (b'"' + b"\xe2\x98\x83" * 11 + b'"', 3),
        (b'"' + b"x" * (64 * 1024 - 1) + b"\xc3\xa9" + b'"', 4),
        (b'"' + b"x" * (64 * 1024 - 1) + b"\xe2\x98\x83" + b'"', 4),
        (b'"' + b"x" * (64 * 1024 - 1) + b"\xf0\x9f\x98\x80" + b'"', 4),
        (b'"' + b"x" * (64 * 1024 + 1) + b'"', 4),
    ],
    ids=[
        "dense-array",
        "dense-object",
        "whitespace",
        "escaped-string",
        "non-ascii-string",
        "two-byte-crosses-bulk-boundary",
        "utf8-crosses-bulk-boundary",
        "four-byte-crosses-bulk-boundary",
        "bulk-ascii-string",
    ],
)
def test_work_limit_is_exact_and_chunk_independent(
    payload: bytes,
    exact_work_units: int,
):
    for chunk_size in (1, 7, 4093, len(payload)):
        extractor = JsonSelectiveExtractor(max_work_units=exact_work_units)
        for offset in range(0, len(payload), chunk_size):
            extractor.feed(payload[offset : offset + chunk_size])

        assert extractor.finish().complete is True

        limited = JsonSelectiveExtractor(max_work_units=exact_work_units - 1)
        for offset in range(0, len(payload), chunk_size):
            limited.feed(payload[offset : offset + chunk_size])
        result = limited.finish()

        assert result.complete is False
        assert result.error == "work limit exceeded"
        assert result.values == {}
        assert result.array_counts == {}
        assert result.wildcard_array_counts == {}
        assert result.object_present == set()


def test_discarded_string_work_limit_is_chunk_independent_after_escape():
    payload = b'{"' + b"k" * 26 + b'":"q\\"s\\\\"}'

    for chunk_size in (1, 2, 3, 7, len(payload)):
        extractor = JsonSelectiveExtractor(
            scalar_fields={("target",): ScalarField("int")},
            max_work_units=7,
        )
        for offset in range(0, len(payload), chunk_size):
            extractor.feed(payload[offset : offset + chunk_size])

        assert extractor.finish().complete is True

        limited = JsonSelectiveExtractor(
            scalar_fields={("target",): ScalarField("int")},
            max_work_units=6,
        )
        for offset in range(0, len(payload), chunk_size):
            limited.feed(payload[offset : offset + chunk_size])
        result = limited.finish()

        assert result.complete is False
        assert result.error == "work limit exceeded"
        assert result.values == {}
        assert result.array_counts == {}
        assert result.wildcard_array_counts == {}
        assert result.object_present == set()


def test_default_extractor_has_no_total_work_limit():
    element_count = 40_000
    extractor = JsonSelectiveExtractor(array_count_paths={()})

    extractor.feed(b"[" + (b"0," * element_count)[:-1] + b"]")
    result = extractor.finish()

    assert result.complete is True
    assert result.array_counts == {(): element_count}
