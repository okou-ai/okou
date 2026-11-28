"""Tests for bounded complete-stream zlib traversal."""

import zlib

import pytest

from tests.body_decode_helpers import track_zlib_decompressor
from zlib_decoding import decode_zlib_bounded

_GZIP_WBITS = 16 + zlib.MAX_WBITS
_ZLIB_WBITS = zlib.MAX_WBITS
_RAW_WBITS = -zlib.MAX_WBITS
_ZLIB_INPUT_BOUND = 1024


def _compress(body: bytes, wbits: int) -> bytes:
    return zlib.compress(body, wbits=wbits)


@pytest.mark.parametrize("wbits", [_GZIP_WBITS, _ZLIB_WBITS, _RAW_WBITS])
def test_complete_single_member(wbits):
    body = b"complete body"

    result = decode_zlib_bounded(_compress(body, wbits), wbits=wbits, max_output=len(body))

    assert result.body == body
    assert result.status == "complete"
    assert result.completed_members == 1


@pytest.mark.parametrize("wbits", [_GZIP_WBITS, _ZLIB_WBITS, _RAW_WBITS])
def test_complete_concatenated_members(wbits):
    first = b"first"
    second = b"second"
    compressed = _compress(first, wbits) + _compress(second, wbits)

    result = decode_zlib_bounded(
        compressed,
        wbits=wbits,
        max_output=len(first) + len(second),
    )

    assert result.body == first + second
    assert result.status == "complete"
    assert result.completed_members == 2


@pytest.mark.parametrize("wbits", [_GZIP_WBITS, _ZLIB_WBITS, _RAW_WBITS])
@pytest.mark.parametrize("tail_kind", ["garbage", "second-member"])
def test_one_member_limit_reports_trailing_data(wbits, tail_kind):
    first = b"first"
    tail = b"trailing garbage" if tail_kind == "garbage" else _compress(b"second", wbits)

    result = decode_zlib_bounded(
        _compress(first, wbits) + tail,
        wbits=wbits,
        max_output=1024,
        max_members=1,
    )

    assert result.body == first
    assert result.status == "trailing_data"
    assert result.completed_members == 1


@pytest.mark.parametrize("wbits", [_GZIP_WBITS, _ZLIB_WBITS])
def test_invalid_first_member(wbits):
    result = decode_zlib_bounded(b"not compressed", wbits=wbits, max_output=1024)

    assert result.body == b""
    assert result.status == "invalid"
    assert result.completed_members == 0


@pytest.mark.parametrize("wbits", [_GZIP_WBITS, _ZLIB_WBITS, _RAW_WBITS])
def test_incomplete_first_member_retains_bounded_prefix(wbits):
    body = b"incomplete body" * 100
    compressed = _compress(body, wbits)

    result = decode_zlib_bounded(compressed[:-1], wbits=wbits, max_output=len(body))

    assert body.startswith(result.body)
    assert result.status == "incomplete"
    assert result.completed_members == 0


@pytest.mark.parametrize("wbits", [_GZIP_WBITS, _ZLIB_WBITS])
def test_invalid_later_member_retains_structural_prefix(wbits):
    first = b"first"
    corrupt_member = bytearray(_compress(b"second" * 1024, wbits))
    corrupt_member[-1] ^= 0xFF

    result = decode_zlib_bounded(
        _compress(first, wbits) + bytes(corrupt_member),
        wbits=wbits,
        max_output=16 * 1024,
    )

    assert result.body.startswith(first)
    assert result.status == "invalid"
    assert result.completed_members == 1


@pytest.mark.parametrize("wbits", [_GZIP_WBITS, _ZLIB_WBITS, _RAW_WBITS])
def test_incomplete_later_member_retains_bounded_prefix(wbits):
    first = b"first"
    second = b"second" * 100
    compressed = _compress(first, wbits) + _compress(second, wbits)[:-1]

    result = decode_zlib_bounded(compressed, wbits=wbits, max_output=1024)

    assert result.body.startswith(first)
    assert (first + second).startswith(result.body)
    assert result.status == "incomplete"
    assert result.completed_members == 1


@pytest.mark.parametrize("wbits", [_GZIP_WBITS, _ZLIB_WBITS, _RAW_WBITS])
def test_exact_limit_validates_empty_trailing_members(wbits):
    body = b"A" * 32
    compressed = _compress(body, wbits) + _compress(b"", wbits) + _compress(b"", wbits)

    result = decode_zlib_bounded(compressed, wbits=wbits, max_output=len(body))

    assert result.body == body
    assert result.status == "complete"
    assert result.completed_members == 3


@pytest.mark.parametrize("wbits", [_GZIP_WBITS, _ZLIB_WBITS, _RAW_WBITS])
def test_exact_limit_rejects_nonempty_trailing_member_without_retaining_probe(wbits):
    body = b"A" * 32
    compressed = _compress(body, wbits) + _compress(b"B", wbits)

    result = decode_zlib_bounded(compressed, wbits=wbits, max_output=len(body))

    assert result.body == body
    assert result.status == "output_limit_exceeded"
    assert result.completed_members == 1


@pytest.mark.parametrize("wbits", [_GZIP_WBITS, _ZLIB_WBITS])
def test_exact_limit_classifies_invalid_trailing_data(wbits):
    body = b"A" * 32

    result = decode_zlib_bounded(
        _compress(body, wbits) + b"not compressed",
        wbits=wbits,
        max_output=len(body),
    )

    assert result.body == body
    assert result.status == "invalid"
    assert result.completed_members == 1


@pytest.mark.parametrize("wbits", [_GZIP_WBITS, _ZLIB_WBITS, _RAW_WBITS])
def test_exact_limit_classifies_incomplete_trailing_member(wbits):
    body = b"A" * 32
    trailing = _compress(b"", wbits)

    result = decode_zlib_bounded(
        _compress(body, wbits) + trailing[:-1],
        wbits=wbits,
        max_output=len(body),
    )

    assert result.body == body
    assert result.status == "incomplete"
    assert result.completed_members == 1


@pytest.mark.parametrize("wbits", [_GZIP_WBITS, _ZLIB_WBITS, _RAW_WBITS])
def test_single_member_output_over_limit_is_capped(wbits):
    body = b"A" * 33

    result = decode_zlib_bounded(_compress(body, wbits), wbits=wbits, max_output=32)

    assert result.body == body[:32]
    assert result.status == "output_limit_exceeded"
    assert result.completed_members == 0


@pytest.mark.parametrize("wbits", [_GZIP_WBITS, _ZLIB_WBITS, _RAW_WBITS])
def test_concatenated_output_over_limit_is_capped(wbits):
    first = b"A" * 16
    second = b"B" * 17

    result = decode_zlib_bounded(
        _compress(first, wbits) + _compress(second, wbits),
        wbits=wbits,
        max_output=32,
    )

    assert result.body == first + second[:16]
    assert result.status == "output_limit_exceeded"
    assert result.completed_members == 1


def test_empty_source_is_complete_without_members():
    result = decode_zlib_bounded(b"", wbits=_GZIP_WBITS, max_output=0)

    assert result.body == b""
    assert result.status == "complete"
    assert result.completed_members == 0


@pytest.mark.parametrize("wbits", [_GZIP_WBITS, _ZLIB_WBITS, _RAW_WBITS])
def test_zero_output_budget_accepts_empty_stream(wbits):
    result = decode_zlib_bounded(_compress(b"", wbits), wbits=wbits, max_output=0)

    assert result.body == b""
    assert result.status == "complete"
    assert result.completed_members == 1


@pytest.mark.parametrize("wbits", [_GZIP_WBITS, _ZLIB_WBITS, _RAW_WBITS])
def test_zero_output_budget_detects_output_without_retaining_probe(wbits):
    result = decode_zlib_bounded(_compress(b"x", wbits), wbits=wbits, max_output=0)

    assert result.body == b""
    assert result.status == "output_limit_exceeded"
    assert result.completed_members == 0


def test_many_members_use_bounded_input_and_tail(monkeypatch):
    member = _compress(b"", _GZIP_WBITS)
    compressed = member * (64 * 1024 // len(member))
    stats = track_zlib_decompressor(monkeypatch, "zlib_decoding.zlib.decompressobj")

    result = decode_zlib_bounded(compressed, wbits=_GZIP_WBITS, max_output=0)

    assert result.status == "complete"
    assert result.completed_members == len(compressed) // len(member)
    assert stats["calls"] > 0
    assert stats["max_input"] <= _ZLIB_INPUT_BOUND
    assert stats["max_unused_data"] <= _ZLIB_INPUT_BOUND


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        pytest.param({"max_output": -1}, "max_output", id="negative-output"),
        pytest.param({"max_output": 0, "max_members": 0}, "max_members", id="zero-members"),
    ],
)
def test_invalid_bounds_raise_value_error(kwargs, message):
    with pytest.raises(ValueError, match=message):
        decode_zlib_bounded(b"", wbits=_GZIP_WBITS, **kwargs)
