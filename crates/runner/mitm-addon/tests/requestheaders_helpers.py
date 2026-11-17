"""Shared helpers for requestheaders() hook tests."""

import inspect
from collections.abc import Awaitable
from typing import cast

import pytest
from mitmproxy import http

import request_authority
import request_classification
import request_streaming


async def await_requestheaders_result(result: object) -> None:
    """Await the async requestheaders() path, failing if the hook stayed sync."""
    if not inspect.isawaitable(result):
        raise AssertionError("expected requestheaders() to return an awaitable")
    return await cast(Awaitable[None], result)


def _assert_no_request_stream(flow: http.HTTPFlow) -> None:
    """Assert that requestheaders left no stream or classification state."""
    assert flow.request.stream is False
    assert request_streaming.captured_request_stream_body(flow) is None
    assert request_streaming.streamed_request_size(flow) is None
    assert request_classification.REQUEST_CLASSIFICATION_METADATA_KEY not in flow.metadata


def track_trusted_authority_validations(
    monkeypatch: pytest.MonkeyPatch,
) -> list[http.HTTPFlow]:
    """Wrap current validator bindings and return validated flows."""
    validated_flows: list[http.HTTPFlow] = []
    get_trusted_authority = request_authority.get_trusted_authority

    def track(flow: http.HTTPFlow) -> request_authority.TrustedAuthority:
        validated_flows.append(flow)
        return get_trusted_authority(flow)

    monkeypatch.setattr(request_authority, "get_trusted_authority", track)
    monkeypatch.setattr(request_classification, "get_trusted_authority", track)
    return validated_flows
