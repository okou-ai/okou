"""Bounded raw Content-Type classification through the response-header hook."""

from typing import SupportsIndex, overload
from unittest.mock import patch

import pytest
from mitmproxy import http
from mitmproxy.net.http import http1

import flow_metadata_keys as metadata_keys
import http_response_classification
import mitm_addon
import response_streaming
from tests.flow_helpers import response_stream

_FIELD_LIMIT = 8 * 1024
_PREFIX_LIMIT = 8 * 1024
_SSE_MEDIA_TYPE = b"text/event-stream"
_JSON_USAGE = b'{"model":"gpt-5.5","usage":{"input_tokens":12,"output_tokens":7}}'
_SSE_USAGE = b'event: response.completed\ndata: {"response":' + _JSON_USAGE + b"}\n\n"


def _make_flow(real_flow, fields: tuple[tuple[bytes, bytes], ...]) -> http.HTTPFlow:
    flow = real_flow(host="api.openai.com", path="/v1/responses", method="POST")
    flow.response.headers = http.Headers(fields)
    flow.metadata.update(
        {
            metadata_keys.FIREWALL_NAME: "model-provider:openai-api-key",
            metadata_keys.FIREWALL_BILLABLE: True,
            metadata_keys.CLI_AGENT_TYPE: "codex",
            metadata_keys.MODEL_USAGE_PROVIDER: "gpt-5.5",
            metadata_keys.RESPONSE_ENCODING_NEGOTIATION: "already_stream_decodable",
        }
    )
    return flow


def _assert_stream_classification(flow: http.HTTPFlow, *, is_sse: bool) -> None:
    assert flow.response is not None
    request_fields = flow.request.headers.fields
    response_fields = flow.response.headers.fields
    original_native = http._native

    def reject_oversized_conversion(value: bytes) -> str:
        assert len(value) <= _PREFIX_LIMIT, "classifier decoded an oversized header value"
        return original_native(value)

    with patch.object(http, "_native", reject_oversized_conversion):
        mitm_addon.responseheaders(flow)
        assert (
            response_streaming.uses_model_json_fallback(flow, websocket_header_work_limit=8 * 1024)
            is not is_sse
        )

    assert ("model_sse_usage_finish" in flow.metadata) is is_sse
    assert ("model_json_usage_finish" in flow.metadata) is not is_sse
    body = _SSE_USAGE if is_sse else _JSON_USAGE
    stream = response_stream(flow)
    assert stream(body) == body
    assert stream(b"") == b""
    response_streaming.finalize_model_sse_usage(flow)
    response_streaming.finalize_model_json_usage(flow, "")
    assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == {
        "model": "gpt-5.5",
        "tokens.input": 12,
        "tokens.output": 7,
    }
    assert flow.request.headers.fields == request_fields
    assert flow.response.headers.fields == response_fields


@pytest.mark.parametrize("padding_byte", [b"x", b"\xff"], ids=["ascii", "non-utf8"])
def test_http1_large_parameter_preserves_sse_without_full_conversion(real_flow, padding_byte):
    value = b'Text/Event-Stream; pad="' + padding_byte * (1024 * 1024) + b'"'
    flow = _make_flow(real_flow, ())
    flow.response = http1.read_response_head([b"HTTP/1.1 200 OK", b"Content-Type: " + value])

    _assert_stream_classification(flow, is_sse=True)

    assert flow.response.headers.fields == ((b"Content-Type", value),)


@pytest.mark.parametrize(
    ("values", "is_sse"),
    [
        pytest.param((), False, id="missing"),
        pytest.param((b"",), False, id="empty"),
        pytest.param((b" \tText/Event-Stream\t ; Charset=UTF-8",), True, id="case-and-ows"),
        pytest.param((b"\vtext/event-stream",), False, id="non-http-whitespace"),
        pytest.param((b"text/event-stream", b"application/json"), False, id="repeated"),
        pytest.param(
            (b"text/event-stream; charset=utf-8", b"application/json"),
            False,
            id="repeated-parameterized-first",
        ),
        pytest.param((b"", b"text/event-stream"), False, id="empty-first-duplicate"),
        pytest.param(
            (_SSE_MEDIA_TYPE + b" " * (_PREFIX_LIMIT - len(_SSE_MEDIA_TYPE)),),
            True,
            id="actual-end-at-limit",
        ),
        pytest.param(
            (_SSE_MEDIA_TYPE + b" " * (_PREFIX_LIMIT - len(_SSE_MEDIA_TYPE) - 1) + b";pad=x",),
            True,
            id="separator-last-inspectable-byte",
        ),
        pytest.param(
            (_SSE_MEDIA_TYPE + b" " * (_PREFIX_LIMIT - len(_SSE_MEDIA_TYPE)) + b";pad=x",),
            False,
            id="separator-beyond-limit",
        ),
        pytest.param(
            (_SSE_MEDIA_TYPE + b" " * (_PREFIX_LIMIT - len(_SSE_MEDIA_TYPE)) + b"x",),
            False,
            id="truncated-prefix-is-not-field-end",
        ),
        pytest.param(
            (_SSE_MEDIA_TYPE + b" " * (_PREFIX_LIMIT - len(_SSE_MEDIA_TYPE) + 1),),
            False,
            id="actual-end-beyond-limit",
        ),
        pytest.param((b" " * _PREFIX_LIMIT + _SSE_MEDIA_TYPE,), False, id="late-media-type"),
    ],
)
def test_response_hook_uses_complete_bounded_singleton(real_flow, values, *, is_sse: bool):
    flow = _make_flow(real_flow, tuple((b"cOnTeNt-TyPe", value) for value in values))

    _assert_stream_classification(flow, is_sse=is_sse)


@pytest.mark.parametrize(
    "field_count",
    [_FIELD_LIMIT, _FIELD_LIMIT + 1],
)
def test_response_hook_bounds_field_count(real_flow, mitm_ctx, field_count: int):
    fields = ((b"X-Padding", b""),) * (field_count - 1) + ((b"Content-Type", b"text/event-stream"),)
    flow = _make_flow(real_flow, fields)

    if field_count == _FIELD_LIMIT:
        _assert_stream_classification(flow, is_sse=True)
    else:
        # Excess fields also prevent the decoder from establishing identity.
        with mitm_ctx():
            mitm_addon.responseheaders(flow)
        assert flow.response is not None
        assert flow.response.status_code == 502
        assert response_stream(flow)(_SSE_USAGE) == b""


def test_response_hook_checks_duplicates_after_early_sse_match(real_flow):
    fields = (
        ((b"Content-Type", b"text/event-stream; charset=utf-8"),)
        + ((b"X-Padding", b""),) * (_FIELD_LIMIT - 2)
        + ((b"CONTENT-TYPE", b"application/json"),)
    )

    _assert_stream_classification(_make_flow(real_flow, fields), is_sse=False)


class _NoNormalizeName(bytes):
    def lower(self) -> bytes:
        raise AssertionError("classifier normalized a name before checking its budget")


class _GuardedParameterValue(bytes):
    def __bytes__(self) -> bytes:
        raise AssertionError("classifier copied the complete parameterized value")

    def decode(self, encoding: str = "utf-8", errors: str = "strict") -> str:
        raise AssertionError("classifier decoded the complete parameterized value")

    def partition(self, sep: bytes) -> tuple[bytes, bytes, bytes]:
        raise AssertionError("classifier copied the parameter suffix")

    def split(self, sep: bytes | None = None, maxsplit: int = -1) -> list[bytes]:
        raise AssertionError("classifier split the complete parameterized value")

    def strip(self, chars: bytes | None = None) -> bytes:
        raise AssertionError("classifier stripped the complete parameterized value")

    def lower(self) -> bytes:
        raise AssertionError("classifier normalized the complete parameterized value")

    def find(self, sub, start=0, end=None) -> int:
        assert end is not None
        assert 0 <= start <= end <= _PREFIX_LIMIT
        return super().find(sub, start, end)

    @overload
    def __getitem__(self, key: SupportsIndex) -> int: ...

    @overload
    def __getitem__(self, key: slice) -> bytes: ...

    def __getitem__(self, key: SupportsIndex | slice) -> int | bytes:
        if isinstance(key, slice):
            assert key.stop is not None
            assert 0 <= key.stop <= len(_SSE_MEDIA_TYPE)
        else:
            assert 0 <= key.__index__() <= len(_SSE_MEDIA_TYPE)
        return super().__getitem__(key)


def test_classifier_never_copies_parameter_suffix_or_normalizes_oversized_names():
    response = http.Response.make(200)
    response.headers.fields = (
        (_NoNormalizeName(b"X" * (1024 * 1024)), b"ignored"),
        (b"Content-Type", _GuardedParameterValue(_SSE_MEDIA_TYPE + b";" + b"x" * (1024 * 1024))),
    )

    assert http_response_classification.has_event_stream_media_type(response)


def test_classifier_rejects_excess_fields_before_name_normalization():
    response = http.Response.make(200)
    response.headers.fields = ((_NoNormalizeName(b"Content-Type"), b"text/event-stream"),) * (
        _FIELD_LIMIT + 1
    )

    assert not http_response_classification.has_event_stream_media_type(response)
