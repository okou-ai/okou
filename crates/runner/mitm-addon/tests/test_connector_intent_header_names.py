"""Connector-intent capture and removal for the private header name."""

import pytest
from mitmproxy import http

import connector_intent

_CANONICAL_HEADER = "X-Okou-Connector-Intent"
_PRIVATE_RAW_NAME = b"x-okou-connector-intent"
_MAX_CONNECTOR_INTENT_BYTES = 64


class _DecodeGuardConnectorIntent(bytes):
    def decode(self, encoding: str = "utf-8", errors: str = "strict") -> str:
        raise AssertionError("oversized connector intent must not be decoded")


def _assert_private_header_is_not_forwarded(flow: http.HTTPFlow) -> None:
    """Assert the private name does not survive on the request the proxy forwards."""
    assert all(name.lower() != _PRIVATE_RAW_NAME for name, _value in flow.request.headers.fields)


@pytest.mark.parametrize(
    "header_name",
    [
        pytest.param("x-okou-connector-intent", id="lowercase"),
        pytest.param("X-Okou-Connector-Intent", id="titlecase"),
        pytest.param("X-OKOU-CONNECTOR-INTENT", id="uppercase"),
    ],
)
def test_header_name_is_captured_and_removed(real_flow, headers, header_name):
    flow = real_flow(
        with_response=False,
        request_headers=headers(("Host", "example.com"), (header_name, " primary ")),
    )

    connector_intent.capture_and_strip(flow)

    assert connector_intent.from_flow(flow) == connector_intent.ConnectorIntent(
        "present", "primary"
    )
    _assert_private_header_is_not_forwarded(flow)


def test_repeating_the_name_stays_malformed(real_flow, headers):
    flow = real_flow(
        with_response=False,
        request_headers=headers(
            ("Host", "example.com"),
            (_CANONICAL_HEADER, "primary"),
            (_CANONICAL_HEADER, "auditor"),
        ),
    )

    connector_intent.capture_and_strip(flow)

    assert connector_intent.from_flow(flow) == connector_intent.MALFORMED
    assert connector_intent._VALUE_METADATA_KEY not in flow.metadata
    _assert_private_header_is_not_forwarded(flow)


@pytest.mark.parametrize(
    "value",
    [
        pytest.param("", id="empty"),
        pytest.param("   ", id="blank"),
        pytest.param("primary,auditor", id="list"),
    ],
)
def test_unusable_value_is_malformed(real_flow, headers, value):
    flow = real_flow(
        with_response=False,
        request_headers=headers(("Host", "example.com"), (_CANONICAL_HEADER, value)),
    )

    connector_intent.capture_and_strip(flow)

    assert connector_intent.from_flow(flow) == connector_intent.MALFORMED
    assert connector_intent._VALUE_METADATA_KEY not in flow.metadata
    _assert_private_header_is_not_forwarded(flow)


def test_oversized_value_is_malformed_without_decoding(real_flow):
    oversized_value = _DecodeGuardConnectorIntent(b"x" * (_MAX_CONNECTOR_INTENT_BYTES + 1))
    flow = real_flow(
        with_response=False,
        request_headers=http.Headers(
            [(b"Host", b"example.com"), (b"x-Okou-Connector-Intent", oversized_value)]
        ),
    )

    connector_intent.capture_and_strip(flow)

    assert connector_intent.from_flow(flow) == connector_intent.MALFORMED
    assert connector_intent._VALUE_METADATA_KEY not in flow.metadata
    _assert_private_header_is_not_forwarded(flow)


def test_already_captured_flow_still_removes_the_name(real_flow, headers):
    flow = real_flow(
        with_response=False,
        request_headers=headers(
            ("Host", "example.com"),
            (_CANONICAL_HEADER, "canonical"),
        ),
    )
    flow.metadata[connector_intent._STATUS_METADATA_KEY] = "absent"

    connector_intent.capture_and_strip(flow)

    assert connector_intent.from_flow(flow) == connector_intent.ABSENT
    _assert_private_header_is_not_forwarded(flow)


def test_absent_intent_leaves_unrelated_headers_untouched(real_flow, headers):
    flow = real_flow(
        with_response=False,
        request_headers=headers(("Host", "example.com"), ("X-Trace", "kept")),
    )

    connector_intent.capture_and_strip(flow)

    assert connector_intent.from_flow(flow) == connector_intent.ABSENT
    assert flow.request.headers.fields == ((b"Host", b"example.com"), (b"X-Trace", b"kept"))
