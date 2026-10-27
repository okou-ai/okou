"""Client representation-header selection contracts for auth.base rewrites."""

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
