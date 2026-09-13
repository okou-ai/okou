"""Connector-intent capture and removal across both private header names."""

import pytest
from mitmproxy import http

import connector_intent

_CANONICAL_HEADER = "X-Okou-Connector-Intent"
_LEGACY_HEADER = "X-VM0-Connector-Intent"
_PRIVATE_RAW_NAMES = (b"x-okou-connector-intent", b"x-vm0-connector-intent")
_MAX_CONNECTOR_INTENT_BYTES = 64


class _DecodeGuardConnectorIntent(bytes):
    def decode(self, encoding: str = "utf-8", errors: str = "strict") -> str:
        raise AssertionError("oversized connector intent must not be decoded")


def _assert_private_headers_are_not_forwarded(flow: http.HTTPFlow) -> None:
    """Assert neither private name survives on the request the proxy forwards."""
    assert all(
        name.lower() not in _PRIVATE_RAW_NAMES for name, _value in flow.request.headers.fields
    )


@pytest.mark.parametrize(
    "header_name",
    [
        pytest.param("x-okou-connector-intent", id="canonical-lowercase"),
        pytest.param("X-Okou-Connector-Intent", id="canonical-titlecase"),
        pytest.param("X-OKOU-CONNECTOR-INTENT", id="canonical-uppercase"),
        pytest.param("x-vm0-connector-intent", id="legacy-lowercase"),
        pytest.param("X-VM0-Connector-Intent", id="legacy-titlecase"),
        pytest.param("X-VM0-CONNECTOR-INTENT", id="legacy-uppercase"),
    ],
)
def test_either_header_name_is_captured_and_removed(real_flow, headers, header_name):
    flow = real_flow(
        with_response=False,
        request_headers=headers(("Host", "example.com"), (header_name, " primary ")),
    )

    connector_intent.capture_and_strip(flow)

    assert connector_intent.from_flow(flow) == connector_intent.ConnectorIntent(
        "present", "primary"
    )
    _assert_private_headers_are_not_forwarded(flow)


def test_canonical_name_wins_when_both_names_appear_once_each(real_flow, headers):
    flow = real_flow(
        with_response=False,
        request_headers=headers(
            ("Host", "example.com"),
            (_LEGACY_HEADER, "legacy"),
            (_CANONICAL_HEADER, "canonical"),
        ),
    )

    connector_intent.capture_and_strip(flow)

    assert connector_intent.from_flow(flow) == connector_intent.ConnectorIntent(
        "present", "canonical"
    )
    _assert_private_headers_are_not_forwarded(flow)


@pytest.mark.parametrize(
    "header_name",
    [
        pytest.param(_CANONICAL_HEADER, id="canonical"),
        pytest.param(_LEGACY_HEADER, id="legacy"),
    ],
)
def test_repeating_a_single_name_stays_malformed(real_flow, headers, header_name):
    flow = real_flow(
        with_response=False,
        request_headers=headers(
            ("Host", "example.com"),
            (header_name, "primary"),
            (header_name, "auditor"),
        ),
    )

    connector_intent.capture_and_strip(flow)

    assert connector_intent.from_flow(flow) == connector_intent.MALFORMED
    assert connector_intent._VALUE_METADATA_KEY not in flow.metadata
    _assert_private_headers_are_not_forwarded(flow)


def test_repeated_canonical_name_stays_malformed_beside_one_legacy_name(real_flow, headers):
    flow = real_flow(
        with_response=False,
        request_headers=headers(
            ("Host", "example.com"),
            (_CANONICAL_HEADER, "primary"),
            (_CANONICAL_HEADER, "auditor"),
            (_LEGACY_HEADER, "legacy"),
        ),
    )

    connector_intent.capture_and_strip(flow)

    assert connector_intent.from_flow(flow) == connector_intent.MALFORMED
    assert connector_intent._VALUE_METADATA_KEY not in flow.metadata
    _assert_private_headers_are_not_forwarded(flow)


@pytest.mark.parametrize(
    "header_name",
    [
        pytest.param(_CANONICAL_HEADER, id="canonical"),
        pytest.param(_LEGACY_HEADER, id="legacy"),
    ],
)
@pytest.mark.parametrize(
    "value",
    [
        pytest.param("", id="empty"),
        pytest.param("   ", id="blank"),
        pytest.param("primary,auditor", id="list"),
    ],
)
def test_unusable_value_is_malformed_for_either_name(real_flow, headers, header_name, value):
    flow = real_flow(
        with_response=False,
        request_headers=headers(("Host", "example.com"), (header_name, value)),
    )

    connector_intent.capture_and_strip(flow)

    assert connector_intent.from_flow(flow) == connector_intent.MALFORMED
    assert connector_intent._VALUE_METADATA_KEY not in flow.metadata
    _assert_private_headers_are_not_forwarded(flow)


@pytest.mark.parametrize(
    "raw_header_name",
    [
        pytest.param(b"x-Okou-Connector-Intent", id="canonical"),
        pytest.param(b"x-VM0-Connector-Intent", id="legacy"),
    ],
)
def test_oversized_value_is_malformed_without_decoding_for_either_name(real_flow, raw_header_name):
    oversized_value = _DecodeGuardConnectorIntent(b"x" * (_MAX_CONNECTOR_INTENT_BYTES + 1))
    flow = real_flow(
        with_response=False,
        request_headers=http.Headers(
            [(b"Host", b"example.com"), (raw_header_name, oversized_value)]
        ),
    )

    connector_intent.capture_and_strip(flow)

    assert connector_intent.from_flow(flow) == connector_intent.MALFORMED
    assert connector_intent._VALUE_METADATA_KEY not in flow.metadata
    _assert_private_headers_are_not_forwarded(flow)


def test_already_captured_flow_still_removes_both_names(real_flow, headers):
    flow = real_flow(
        with_response=False,
        request_headers=headers(
            ("Host", "example.com"),
            (_CANONICAL_HEADER, "canonical"),
            (_LEGACY_HEADER, "legacy"),
        ),
    )
    flow.metadata[connector_intent._STATUS_METADATA_KEY] = "absent"

    connector_intent.capture_and_strip(flow)

    assert connector_intent.from_flow(flow) == connector_intent.ABSENT
    _assert_private_headers_are_not_forwarded(flow)


def test_absent_intent_leaves_unrelated_headers_untouched(real_flow, headers):
    flow = real_flow(
        with_response=False,
        request_headers=headers(("Host", "example.com"), ("X-Trace", "kept")),
    )

    connector_intent.capture_and_strip(flow)

    assert connector_intent.from_flow(flow) == connector_intent.ABSENT
    assert flow.request.headers.fields == ((b"Host", b"example.com"), (b"X-Trace", b"kept"))
