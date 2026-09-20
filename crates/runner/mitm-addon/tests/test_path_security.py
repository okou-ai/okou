"""Tests for URL path safety helpers."""

import urllib.parse
from unittest.mock import patch

import pytest

import path_security


@pytest.mark.parametrize(
    "path",
    [
        "/api/./admin",
        "/api/../admin",
        "/api/%2e/admin",
        "/api/%2e%2e/admin",
        "/api/%2E%2E/admin",
        "/api/%2e%2e%2fadmin",
        "/api/foo%2F..",
        "/api/..;matrix=1/admin",
        "/api/%2e%2e%3bmatrix=1/admin",
        "/api/%252e%252e/admin",
        "/api/%252E%252E/admin",
        "/api/%252e%252e%253bmatrix=1/admin",
        "/api/%252e%252e%252fadmin",
        "/api/%252f..",
    ],
)
def test_has_unsafe_path_blocks_dot_segments(path):
    assert path_security.has_unsafe_path(path) is True


@pytest.mark.parametrize(
    "decode_passes",
    [
        pytest.param(path_security._MAX_PERCENT_DECODE_PASSES - 1, id="below-limit"),
        pytest.param(path_security._MAX_PERCENT_DECODE_PASSES, id="at-limit"),
        pytest.param(path_security._MAX_PERCENT_DECODE_PASSES + 1, id="over-limit"),
    ],
)
def test_has_unsafe_path_blocks_nested_dot_segments_at_decode_limit(decode_passes: int):
    encoded = "%2e"
    for _ in range(decode_passes - 1):
        encoded = urllib.parse.quote(encoded, safe="")

    assert path_security.has_unsafe_path(f"/api/{encoded}/admin") is True


@pytest.mark.parametrize(
    "path",
    [
        "/api\\admin",
        "/api/%5cadmin",
        "/api/%5Cadmin",
        "/api/%5c..%5cadmin",
        "/api/%5C..%5Cadmin",
        "/api/foo%5cbar",
        "/api/%255cadmin",
        "/api/%255C..%255Cadmin",
    ],
)
def test_has_unsafe_path_blocks_backslashes(path):
    assert path_security.has_unsafe_path(path) is True


@pytest.mark.parametrize(
    "path",
    [
        "/api/%/admin",
        "/api/%2/admin",
        "/api/%zz/admin",
        "/api/%2e%zz/admin",
        "/api/%25zz/admin",
    ],
)
def test_has_unsafe_path_blocks_invalid_percent_escapes(path):
    assert path_security.has_unsafe_path(path) is True


@pytest.mark.parametrize(
    "path",
    [
        "/api/%00/admin",
        "/api/%0a/admin",
        "/api/%7f/admin",
        "/api/%2500/admin",
    ],
)
def test_has_unsafe_path_blocks_percent_encoded_unsafe_codepoints(path):
    assert path_security.has_unsafe_path(path) is True


@pytest.mark.parametrize(
    "path",
    [
        "/api/\x00/admin",
        "/api/\x1f/admin",
        "/api/\x7f/admin",
        "/api/\ud800/admin",
    ],
)
def test_has_unsafe_path_blocks_raw_unsafe_codepoints(path):
    assert path_security.has_unsafe_path(path) is True


@pytest.mark.parametrize(
    "path",
    [
        "/api/%ef%bc%8e%ef%bc%8e/admin",
        "/api/%ef%bc%8e./admin",
        "/api/%ef%bc%8f../admin",
        "/api/..%ef%bc%8fadmin",
        "/api/%ef%bc%bc..%ef%bc%bcadmin",
        "/api/%ef%bc%852e/admin",
        "/api/\u2024\u2024/admin",
        "/api/\u2025/admin",
        "/api/\ufe52\ufe52/admin",
        "/api/\ufe30/admin",
        "/api/..\u037ematrix/admin",
        "/api/\ufe68admin",
        "/api/\ufe6a2e/admin",
    ],
)
def test_has_unsafe_path_blocks_compatibility_normalized_syntax(path):
    assert path_security.has_unsafe_path(path) is True


@pytest.mark.parametrize(
    "path",
    [
        "/api/%ff/admin",
        "/api/%c0%af../admin",
        "/api/%ed%a0%80/admin",
        "/api/%25ff/admin",
        "/api/%25ed%25a0%2580/admin",
    ],
)
def test_has_unsafe_path_blocks_invalid_percent_encoded_utf8(path):
    assert path_security.has_unsafe_path(path) is True


@pytest.mark.parametrize(
    "path",
    [
        "",
        "/",
        "/api/users",
        "/api/..hidden/admin",
        "/api/a..b/admin",
        "/api/callback;matrix=1",
        "/api/user name",
        "/api/foo%2Fbar",
        "/api/foo%252Fbar",
        "/api/%E2%9C%93",
        "/api/✓",
        "/api/%ef%bc%a1",
        "/api/%ef%bc%8e%ef%bc%8ehidden",
        "/api/foo%ef%bc%8fbar",
        "/api/foo\u2024bar",
        "/api/\u2024\u2024hidden",
        "/api/\u2025hidden",
        "/api/%2e%2ehidden",
        "/api/%252e%252ehidden",
    ],
)
def test_has_unsafe_path_allows_regular_segments(path):
    assert path_security.has_unsafe_path(path) is False


def test_has_unsafe_path_allows_maximum_length_nested_encoding():
    encoded = "%61"
    for _ in range(4):
        encoded = urllib.parse.quote(encoded, safe="")
    path = "/" + encoded
    path += "a" * (path_security.MAX_PATH_VALIDATION_CHARACTERS - len(path))

    assert len(path) == path_security.MAX_PATH_VALIDATION_CHARACTERS
    assert path_security.has_unsafe_path(path) is False


def test_has_unsafe_path_blocks_over_budget_before_compatibility_pipeline():
    encoded = "%2e"
    for _ in range(5):
        encoded = urllib.parse.quote(encoded, safe="")
    path = "/" + encoded
    path += "a" * (path_security.MAX_PATH_VALIDATION_CHARACTERS + 1 - len(path))

    with (
        patch.object(path_security.urllib.parse, "unquote_to_bytes") as percent_decode,
        patch.object(path_security.unicodedata, "normalize") as unicode_normalize,
    ):
        unsafe = path_security.has_unsafe_path(path)

    assert len(path) == path_security.MAX_PATH_VALIDATION_CHARACTERS + 1
    assert unsafe is True
    percent_decode.assert_not_called()
    unicode_normalize.assert_not_called()


def test_plain_ascii_path_bypasses_compatibility_pipeline():
    with (
        patch.object(
            path_security.urllib.parse,
            "unquote_to_bytes",
            wraps=path_security.urllib.parse.unquote_to_bytes,
        ) as percent_decode,
        patch.object(
            path_security.unicodedata,
            "normalize",
            wraps=path_security.unicodedata.normalize,
        ) as unicode_normalize,
    ):
        unsafe = path_security.has_unsafe_path("/repos/okou-ai/okou/issues/24254.json;view=full")

    assert unsafe is False
    percent_decode.assert_not_called()
    unicode_normalize.assert_not_called()
