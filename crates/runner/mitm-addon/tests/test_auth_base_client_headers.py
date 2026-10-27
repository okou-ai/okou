"""Client representation-header selection contracts for auth.base rewrites."""

import sys
import tracemalloc

import pytest
from mitmproxy import http

import auth_base_transport as transport
from tests.auth_base_client_header_helpers import UnconvertedHeaderValue


class _MultiHeaders:
    def __init__(self, pairs):
        self.pairs = pairs

    def items(self, multi=False):
        return self.pairs if multi else dict(self.pairs).items()


class _ItemsHeaders:
    def __init__(self, pairs):
        self.pairs = pairs

    def items(self):
        return self.pairs


class _UnsplitConnectionValue(str):
    def split(self, sep=None, maxsplit=-1):
        raise AssertionError("materialized arbitrary auth.base Connection nominations")


def _representation_headers(connection_values, *, native):
    pairs = [
        ("cOnTeNt-TyPe", "application/json"),
        ("Content-Encoding", "gzip"),
        ("CONTENT-ENCODING", "br"),
        *(("cOnNeCtIoN", value) for value in connection_values),
    ]
    if native:
        return http.Headers(
            (name.encode(), value.encode("utf-8", "surrogateescape")) for name, value in pairs
        )
    return pairs


def test_native_headers_select_representation_before_converting_ignored_values():
    ignored_value = UnconvertedHeaderValue(b"x" * (1024 * 1024))
    headers = http.Headers(
        (
            (b"X-Discard-Me", ignored_value),
            (b"cOnTeNt-EnCoDiNg", b"gzip"),
            (b"x-dIsCaRd-Me", ignored_value),
            (b"cOnTeNt-TyPe", b'application/json; profile="caf\xc3\xa9"'),
            (b"X-Discard-Me", ignored_value),
            (b"CONTENT-ENCODING", b"br"),
            (b"Authorization", ignored_value),
            (b"Connection", b"X-Discard-Me, Authorization"),
        )
    )

    assert transport.forwarded_auth_base_client_header_pairs(headers) == [
        ("cOnTeNt-EnCoDiNg", "gzip"),
        ("cOnTeNt-TyPe", 'application/json; profile="café"'),
        ("CONTENT-ENCODING", "br"),
    ]


def test_native_representation_values_preserve_surrogateescape_decoding():
    headers = http.Headers(((b"Content-Type", b'text/plain; profile="caf\xe9"'),))

    assert transport.forwarded_auth_base_client_header_pairs(headers) == [
        ("Content-Type", 'text/plain; profile="caf\udce9"')
    ]


@pytest.mark.parametrize(
    ("connections", "expected"),
    [
        ((), [("Content-Type", "application/json"), ("Content-Encoding", "gzip")]),
        ((b"X-Discard-Me, \tCoNtEnT-TyPe ",), [("Content-Encoding", "gzip")]),
        ((b" content-ENCODING ",), [("Content-Type", "application/json")]),
        ((b"CONTENT-type, X-Discard-Me", b" , content-encoding, "), []),
    ],
    ids=["none", "content-type", "content-encoding", "repeated-connection"],
)
def test_native_connection_nominations_preserve_representation_exclusions(connections, expected):
    headers = http.Headers(
        (
            (b"Content-Type", b"application/json"),
            (b"X-Discard-Me", UnconvertedHeaderValue(b"ignored")),
            (b"Content-Encoding", b"gzip"),
            *((b"cOnNeCtIoN", value) for value in connections),
        )
    )

    assert transport.forwarded_auth_base_client_header_pairs(headers) == expected


@pytest.mark.parametrize("connection", [b"", b"CoNtEnT-TyPe"], ids=["ordinary", "nominated"])
def test_native_duplicate_content_type_is_rejected_before_connection_exclusion(connection):
    headers = http.Headers(
        (
            (b"X-Discard-Me", UnconvertedHeaderValue(b"ignored")),
            (b"Content-Type", b"application/json"),
            (b"content-type", b"text/plain"),
            (b"Connection", connection),
        )
    )

    with pytest.raises(transport.InvalidAuthBaseRequestHeadersError, match="at most one"):
        transport.forwarded_auth_base_client_header_pairs(headers)


@pytest.mark.parametrize(
    "make_headers",
    [dict, _MultiHeaders, _ItemsHeaders, list, iter],
    ids=["dict", "multi-items", "items-only", "pairs", "one-shot-iterator"],
)
def test_supported_header_containers_preserve_order_values_and_connection_rules(make_headers):
    pairs = [
        ("cOnTeNt-EnCoDiNg", "gzip"),
        ("Content-Type", "application/json; charset=utf-8"),
        ("CONTENT-ENCODING", "br"),
        ("Connection", "Content-Type, X-Drop"),
        ("X-Drop", "ignored"),
    ]

    assert transport.forwarded_auth_base_client_header_pairs(make_headers(pairs)) == [
        ("cOnTeNt-EnCoDiNg", "gzip"),
        ("CONTENT-ENCODING", "br"),
    ]


def test_multi_item_container_preserves_same_name_representation_fields():
    headers = _MultiHeaders([("Content-Encoding", "gzip"), ("Content-Encoding", "br")])

    assert transport.forwarded_auth_base_client_header_pairs(headers) == [
        ("Content-Encoding", "gzip"),
        ("Content-Encoding", "br"),
    ]


@pytest.mark.parametrize("native", [True, False], ids=["native", "text"])
def test_connection_values_are_not_decoded_or_split_into_arbitrary_nominations(native):
    value = "content-type, content-encoding," + ",".join(f"x{i:06x}" for i in range(131_072))
    if native:
        headers = http.Headers(
            (
                (b"Connection", UnconvertedHeaderValue(value.encode())),
                (b"Content-Type", b"application/json"),
                (b"Content-Encoding", b"gzip"),
            )
        )
    else:
        headers = _representation_headers([_UnsplitConnectionValue(value)], native=False)

    assert transport.forwarded_auth_base_client_header_pairs(headers) == []


@pytest.mark.parametrize("native", [True, False], ids=["native", "text"])
@pytest.mark.parametrize(
    "shape",
    ["unmatched", "both-first", "one-last", "long-token", "long-whitespace", "repeated-name"],
)
def test_connection_selection_has_bounded_peak_allocation(native, shape):
    # Build the input before tracing so the bound measures selection, not the fixture.
    suffix = ",".join(f"x{i:06x}" for i in range(131_072))
    values = {
        "unmatched": suffix,
        "both-first": "content-type, content-encoding," + suffix,
        "one-last": suffix + ",content-type",
        "long-token": "x" * len(suffix) + ",content-type",
        "long-whitespace": "\u3000" * 131_072 + "content-type" + "\u3000" * 131_072,
        "repeated-name": "content-type," * 65_536 + "content-encoding",
    }
    headers = _representation_headers([values[shape]], native=native)
    expected = [("cOnTeNt-TyPe", "application/json")] if shape == "unmatched" else []
    if shape not in {"both-first", "repeated-name"}:
        expected += [("Content-Encoding", "gzip"), ("CONTENT-ENCODING", "br")]

    tracemalloc.start()
    try:
        selected = transport.forwarded_auth_base_client_header_pairs(headers)
        peak_bytes = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()

    assert selected == expected
    # Far below a full input copy, and generous relative to fixed selector state.
    assert peak_bytes < 128 * 1024


@pytest.mark.parametrize("native", [True, False], ids=["native", "text"])
@pytest.mark.parametrize(
    "whitespace",
    [chr(codepoint) for codepoint in range(sys.maxunicode + 1) if chr(codepoint).isspace()],
    ids=lambda value: f"u{ord(value):04x}",
)
def test_connection_nominations_preserve_all_unicode_strip_whitespace(native, whitespace):
    headers = _representation_headers(
        [f",{whitespace}CoNtEnT-TyPe{whitespace},", f"{whitespace}CONTENT-ENCODING{whitespace}"],
        native=native,
    )

    assert transport.forwarded_auth_base_client_header_pairs(headers) == []


@pytest.mark.parametrize("native", [True, False], ids=["native", "text"])
@pytest.mark.parametrize(
    "value",
    [
        "x-content-type,content-encoding-extra",
        '"content-type",content-encoding=x',
        "content type,content\t-encoding",
        "content-type\u200b,\u200bcontent-encoding",
        "content-type\udcff,\udcffcontent-encoding",
        "content-type\x00,\x00content-encoding",
        "content-encod\u0131ng,content-encod\u0130ng",
    ],
)
def test_connection_nominations_require_exact_names_with_ascii_case_folding(native, value):
    headers = _representation_headers([value], native=native)

    assert transport.forwarded_auth_base_client_header_pairs(headers) == [
        ("cOnTeNt-TyPe", "application/json"),
        ("Content-Encoding", "gzip"),
        ("CONTENT-ENCODING", "br"),
    ]


@pytest.mark.parametrize("native", [True, False], ids=["native", "text"])
def test_repeated_connection_fields_union_nominations_and_still_reject_duplicate_type(native):
    pairs = [
        ("Connection", "Content-Type, x-other"),
        ("Content-Type", "application/json"),
        ("connection", "content-encoding"),
        ("Content-Encoding", "gzip"),
        ("content-type", "text/plain"),
    ]
    headers = (
        http.Headers((name.encode(), value.encode()) for name, value in pairs) if native else pairs
    )

    with pytest.raises(transport.InvalidAuthBaseRequestHeadersError, match="at most one"):
        transport.forwarded_auth_base_client_header_pairs(headers)
