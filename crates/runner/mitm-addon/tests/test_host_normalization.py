"""Shared hostname identity policy tests."""

import sys
import unicodedata
from unittest.mock import patch

import pytest

import host_normalization
from tests.host_normalization_cases import (
    INVALID_IDNA_HOSTNAME_CASES,
    OVERRANGE_IPV4_HOSTNAME_CASES,
)


def test_ascii_hostname_bypasses_unicode_pipeline():
    with (
        patch.object(
            host_normalization,
            "normalize",
            wraps=host_normalization.normalize,
        ) as unicode_normalize,
        patch.object(
            host_normalization,
            "category",
            wraps=host_normalization.category,
        ) as unicode_category,
        patch.object(
            host_normalization,
            "bidirectional",
            wraps=host_normalization.bidirectional,
        ) as unicode_bidirectional,
    ):
        normalized = host_normalization.normalize_idna_hostname("API.GITHUB.COM")

    assert normalized == "api.github.com"
    unicode_normalize.assert_not_called()
    unicode_category.assert_not_called()
    unicode_bidirectional.assert_not_called()


def test_unicode_label_reuses_normalized_text():
    with (
        patch.object(
            host_normalization,
            "_normalize_label_text",
            wraps=host_normalization._normalize_label_text,
        ) as normalize_label_text,
        patch.object(
            host_normalization,
            "_validate_normalized_label_text",
            wraps=host_normalization._validate_normalized_label_text,
        ) as validate_normalized_label_text,
    ):
        normalized = host_normalization.normalize_idna_label("faß")

    assert normalized == "xn--fa-hia"
    normalize_label_text.assert_called_once_with("faß")
    validate_normalized_label_text.assert_called_once_with("faß")


def test_overlength_unicode_label_skips_normalized_text_validation():
    oversized_label = "".join(chr(0x4E00 + index) for index in range(1365))
    with (
        patch.object(
            host_normalization,
            "_normalize_label_text",
            wraps=host_normalization._normalize_label_text,
        ) as normalize_label_text,
        patch.object(
            host_normalization,
            "_validate_normalized_label_text",
            wraps=host_normalization._validate_normalized_label_text,
        ) as validate_normalized_label_text,
        pytest.raises(UnicodeError, match="IDNA label too long"),
    ):
        host_normalization.normalize_idna_label(oversized_label)

    normalize_label_text.assert_called_once_with(oversized_label)
    validate_normalized_label_text.assert_not_called()


@pytest.mark.parametrize(
    ("label", "expected"),
    [
        pytest.param("API", "api", id="mixed-case"),
        pytest.param("A" * 63, "a" * 63, id="maximum-length"),
        pytest.param(
            "!\"$&'()*+-;=_`{}~",
            "!\"$&'()*+-;=_`{}~",
            id="permissive-punctuation",
        ),
        pytest.param("XN--BCHER-KVA", "xn--bcher-kva", id="canonical-alabel"),
    ],
)
def test_ascii_label_contract(label, expected):
    assert host_normalization.normalize_idna_label(label) == expected


@pytest.mark.parametrize(
    ("label", "expected"),
    [
        pytest.param("e\u0301" * 57, f"xn--9c{'a' * 57}", id="decomposed-latin"),
        pytest.param(
            "\u1100\u1161\u11a8" * 56,
            f"xn--p39{'a' * 56}",
            id="decomposed-hangul",
        ),
    ],
)
def test_decomposed_unicode_label_at_dns_limit_is_accepted(label, expected):
    normalized = host_normalization.normalize_idna_label(label)

    assert normalized == expected
    assert len(normalized) == 63
    assert host_normalization.normalize_idna_label(normalized) == normalized


def test_unicode_database_preserves_canonical_composition_bound():
    # The early raw-label limit must remain conservative after Unicode upgrades.
    maximum_decomposition = max(
        len(unicodedata.normalize("NFD", chr(codepoint))) for codepoint in range(sys.maxunicode + 1)
    )

    assert maximum_decomposition <= host_normalization._MAX_CANONICAL_DECOMPOSITION_LENGTH


@pytest.mark.parametrize("mark_count", [118, 128, 256, 512, 1023])
def test_impossible_combining_label_is_rejected_before_unicode_normalization(mark_count):
    # 237 code points is the first impossible raw length; 4,093 UTF-8 bytes
    # remains within the HTTP Host budget at the largest size.
    label = "a" + "\u0315" * mark_count + "\u0300" * mark_count

    with (
        patch.object(
            host_normalization,
            "normalize",
            side_effect=AssertionError("impossible label reached Unicode normalization"),
        ),
        pytest.raises(UnicodeError, match="IDNA label too long"),
    ):
        host_normalization.normalize_idna_label(label)


def test_combining_label_within_raw_budget_still_has_to_fit_dns_limit():
    label = "ab" + "\u0315" * 117 + "\u0300" * 117
    assert len(label) == 236

    with pytest.raises(UnicodeError, match="IDNA label too long"):
        host_normalization.normalize_idna_label(label)


@pytest.mark.parametrize("hostname", INVALID_IDNA_HOSTNAME_CASES)
def test_rejects_invalid_idna_hostname(hostname):
    with pytest.raises(UnicodeError):
        host_normalization.normalize_idna_hostname(hostname)


@pytest.mark.parametrize("hostname", OVERRANGE_IPV4_HOSTNAME_CASES)
def test_rejects_overrange_ipv4_hostname_octet(hostname):
    with pytest.raises(UnicodeError) as exc_info:
        host_normalization.normalize_idna_hostname(hostname)

    assert type(exc_info.value) is UnicodeError
    assert str(exc_info.value) == "non-canonical IPv4 address"


@pytest.mark.parametrize(
    ("hostname", "expected"),
    [
        pytest.param("2001:0DB8:0:0::1", "2001:db8::1", id="compressed-ipv6"),
        pytest.param("192.0.2.1", "192.0.2.1", id="canonical-ipv4"),
        pytest.param("BÜCHER.example", "xn--bcher-kva.example", id="idna"),
    ],
)
def test_normalize_hostname_canonicalizes_ip_and_idna(hostname, expected):
    assert host_normalization.normalize_hostname(hostname) == expected


@pytest.mark.parametrize(
    ("hostname", "message"),
    [
        pytest.param("2001:db8::1%eth0", "IPv6 scope identifiers are not allowed", id="scope-id"),
        pytest.param("example,com", "invalid hostname", id="comma"),
        pytest.param("example%2ecom", "invalid hostname", id="percent-encoding"),
        pytest.param("192.0.2.1:443", "invalid IPv6 hostname", id="colon-ipv4"),
    ],
)
def test_normalize_hostname_rejects_boundary_syntax(hostname, message):
    with pytest.raises(ValueError, match=message):
        host_normalization.normalize_hostname(hostname)


@pytest.mark.parametrize(
    ("label", "expected_message"),
    [
        pytest.param("", "empty IDNA label", id="empty"),
        pytest.param(".", "invalid IDNA label", id="dot"),
        pytest.param("a#b", "invalid IDNA label", id="forbidden-punctuation"),
        pytest.param("a b", "invalid IDNA label", id="space"),
        pytest.param("a\tb", "invalid IDNA label", id="whitespace"),
        pytest.param("a\x00b", "invalid IDNA label", id="control"),
        pytest.param("a\x7fb", "invalid IDNA label", id="delete"),
        pytest.param("A" * 64, "IDNA label too long", id="over-maximum-length"),
        pytest.param("xn--a", "invalid IDNA A-label", id="invalid-alabel"),
        pytest.param("#" * 64, "invalid IDNA label", id="validation-precedes-length"),
    ],
)
def test_rejects_invalid_ascii_label(label, expected_message):
    with pytest.raises(UnicodeError) as exc_info:
        host_normalization.normalize_idna_label(label)

    assert type(exc_info.value) is UnicodeError
    assert str(exc_info.value) == expected_message
