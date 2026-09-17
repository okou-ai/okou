"""Decoder header work limits through response hooks and observable usage delivery."""

import gzip
import zlib

import brotli
import pytest
import zstandard
from mitmproxy import http

import billing_body
import body_decoding
import flow_metadata_keys as metadata_keys
import mitm_addon
from tests.content_encoding_cases import (
    BUDGET_CASES,
    encoding_budget_fields,
    encoding_inspections,
)
from tests.flow_helpers import response_stream
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.model_provider_response_helpers import (
    OPENAI_RESPONSES_CASE,
    expected_event_quantities,
    model_provider_flow,
    run_response,
    standard_success_payload,
)
from tests.x_flow_helpers import make_x_pipeline_flow

pytestmark = pytest.mark.usefixtures("sync_usage_executor")

_FIELD_LIMIT = 8 * 1024
_VALUE_LIMIT = 8 * 1024
_BUDGET_REASON = "content encoding header inspection limit exceeded"


@pytest.mark.parametrize("encoding", ["identity", "gzip"])
@pytest.mark.parametrize(("budget", "size", "in_budget"), BUDGET_CASES)
def test_request_capture_shares_raw_encoding_budgets(encoding, budget, size, *, in_budget):
    body = b'{"text":"hello world"}'
    wire_body = gzip.compress(body) if encoding == "gzip" else body
    fields = encoding_budget_fields((), encoding, budget, size)

    captured = body_decoding.decode_request_body_for_network_log_capture(
        wire_body, http.Headers(fields)
    )

    assert captured == (body if in_budget and budget != "aggregate" else None)
    assert bool(encoding_inspections(fields)) is in_budget


class _UnnormalizedName(bytes):
    def lower(self) -> bytes:
        raise AssertionError("normalized a raw name before checking its budget")


class _UninspectedValue(bytes):
    def decode(self, encoding: str = "utf-8", errors: str = "strict") -> str:
        raise AssertionError("decoded a raw value before checking its budget")

    def strip(self, chars: bytes | None = None) -> bytes:
        raise AssertionError("stripped a raw value before checking its budget")

    def lower(self) -> bytes:
        raise AssertionError("normalized a raw value before checking its budget")


def test_billing_reader_skips_oversized_unrelated_names():
    body = b'{"text":"hello world"}'
    headers = http.Headers(
        (
            (_UnnormalizedName(b"X" * (1024 * 1024)), _UninspectedValue(b"ignored")),
            (b"Content-Encoding", b"identity"),
        )
    )

    assert billing_body.decode_request_body_for_billing(body, headers) == body


def test_billing_reader_checks_field_count_before_normalizing_names():
    headers = http.Headers(
        ((_UnnormalizedName(b"X-Unrelated"), _UninspectedValue(b"ignored")),) * (_FIELD_LIMIT + 1)
    )

    assert billing_body.decode_request_body_for_billing(b'{"text":"hello world"}', headers) is None


def _model_flow(real_flow, tmp_path, fields) -> http.HTTPFlow:
    flow = model_provider_flow(
        real_flow,
        tmp_path,
        OPENAI_RESPONSES_CASE,
        proxy_log_path=tmp_path / "proxy.jsonl",
    )
    flow.request.method = "POST"
    flow.request.path = "/v1/responses"
    flow.response = http.Response.make(200)
    flow.response.headers = http.Headers(fields)
    flow.metadata[metadata_keys.RESPONSE_ENCODING_NEGOTIATION] = "already_stream_decodable"
    return flow


def _assert_model_usage(flow, body: bytes, usage_webhook_api) -> None:
    assert flow.response is not None
    upstream_response = flow.response
    fields = upstream_response.headers.fields
    request_fields = flow.request.headers.fields

    mitm_addon.responseheaders(flow)
    assert flow.response.status_code == 200
    stream = response_stream(flow)
    for offset in range(0, len(body), 17):
        chunk = body[offset : offset + 17]
        assert stream(chunk) == chunk
    assert stream(b"") == b""
    webhook = run_response(flow, usage_webhook_api)

    assert {event["category"]: event["quantity"] for event in webhook.usage_events()} == (
        expected_event_quantities(OPENAI_RESPONSES_CASE)
    )
    assert flow.response is upstream_response
    assert flow.response.headers.fields == fields
    assert flow.request.headers.fields == request_fields


@pytest.mark.parametrize("encoding", ["", "identity", "gzip", "deflate", "br", "zstd"])
def test_oversized_unrelated_fields_preserve_codecs_and_usage(
    real_flow, tmp_path, usage_webhook_api, encoding
):
    body = standard_success_payload(OPENAI_RESPONSES_CASE)
    if encoding == "gzip":
        body = gzip.compress(body)
    elif encoding == "deflate":
        body = zlib.compress(body)
    elif encoding == "br":
        body = brotli.compress(body)
    elif encoding == "zstd":
        body = zstandard.ZstdCompressor().compress(body)
    fields = (
        (_UnnormalizedName(b"X" * (1024 * 1024)), _UninspectedValue(b"x" * (1024 * 1024))),
        (b"Content-Type", b"application/json"),
        (b"cOnTeNt-EnCoDiNg", b" \t" + encoding.upper().encode() + b"\t "),
    )

    _assert_model_usage(_model_flow(real_flow, tmp_path, fields), body, usage_webhook_api)


@pytest.mark.parametrize("is_sse", [False, True], ids=["json", "sse"])
def test_exact_field_and_value_limits_preserve_usage(
    real_flow, tmp_path, usage_webhook_api, *, is_sse
):
    body = standard_success_payload(OPENAI_RESPONSES_CASE)
    if is_sse:
        body = b'event: response.completed\ndata: {"response":' + body + b"}\n\n"
    fields = (
        ((b"X-Padding", b""),) * (_FIELD_LIMIT - 2)
        + ((b"Content-Type", b"text/event-stream" if is_sse else b"application/json"),)
        + ((b"Content-Encoding", b" " * (_VALUE_LIMIT - len(b"gzip")) + b"gzip"),)
    )

    _assert_model_usage(
        _model_flow(real_flow, tmp_path, fields), gzip.compress(body), usage_webhook_api
    )


_OVER_BUDGET_FIELDS = [
    pytest.param(
        ((_UnnormalizedName(b"Content-Encoding"), _UninspectedValue(b"identity")),)
        * (_FIELD_LIMIT + 1),
        id="excess-fields-before-normalization",
    ),
    pytest.param(
        ((_UnnormalizedName(b"X-Unrelated"), b""),) * (_FIELD_LIMIT + 1),
        id="excess-fields-without-encoding",
    ),
    pytest.param(
        ((b"Content-Encoding", _UninspectedValue(b" " * (_VALUE_LIMIT + 1))),),
        id="oversized-blank-value",
    ),
    pytest.param(
        ((b"Content-Encoding", _UninspectedValue(b"gzip" + b" " * _VALUE_LIMIT)),),
        id="oversized-supported-prefix",
    ),
    pytest.param(
        (
            (b"Content-Encoding", _UninspectedValue(b" " * (_VALUE_LIMIT // 2))),
            (b"CONTENT-ENCODING", _UninspectedValue(b" " * (_VALUE_LIMIT // 2))),
        ),
        id="aggregate-values-plus-folding",
    ),
]


@pytest.mark.parametrize("fields", _OVER_BUDGET_FIELDS)
@pytest.mark.parametrize("consumer", ["model-json", "model-sse", "connector"])
def test_over_budget_billable_response_is_rejected_without_upstream_body(
    real_flow, tmp_path, mitm_ctx, usage_webhook_api, fields, consumer
):
    if consumer == "connector":
        flow = make_x_pipeline_flow(real_flow, tmp_path)
        flow.metadata[metadata_keys.RESPONSE_ENCODING_NEGOTIATION] = "already_stream_decodable"
    else:
        flow = _model_flow(real_flow, tmp_path, ())
    assert flow.response is not None
    flow.response.headers = http.Headers(
        (
            (
                b"Content-Type",
                b"text/event-stream" if consumer == "model-sse" else b"application/json",
            ),
            *fields,
        )
    )
    upstream_response = flow.response
    upstream_fields = upstream_response.headers.fields

    with mitm_ctx():
        mitm_addon.responseheaders(flow)

    assert flow.response.status_code == 502
    assert flow.response.raw_content == b""
    assert response_stream(flow)(b"uninspectable-upstream") == b""
    assert response_stream(flow)(b"") == b""
    assert upstream_response.headers.fields == upstream_fields
    [entry] = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
    assert entry["reason"] == "response_encoding_not_stream_decodable"
    assert entry["inspection_disposition"] == "fail_closed"
    assert entry["decode_skip_reason"] == _BUDGET_REASON
    assert run_response(flow, usage_webhook_api).usage_events() == []


@pytest.mark.parametrize("fields", _OVER_BUDGET_FIELDS)
def test_terminal_and_capture_decoders_keep_their_uninspectable_policies(fields):
    headers = http.Headers(fields)
    body = b'{"usage":{"input_tokens":123}}'

    assert not body_decoding.can_stream_decode_usage(headers)
    assert not body_decoding.can_decode_json_usage_body(headers)
    assert body_decoding.decompress_json_usage_body(body, headers) == (b"", _BUDGET_REASON)
    assert body_decoding.decode_response_body_for_network_log_capture(body, headers) is None
    assert body_decoding.decode_request_body_for_network_log_capture(body, headers) is None
    assert body_decoding.decompress_body(body, headers) == body


@pytest.mark.parametrize(
    "values",
    [
        pytest.param((), id="missing"),
        pytest.param((b"",), id="empty"),
        pytest.param((b"\xc2\xa0IdEnTiTy\xc2\xa0",), id="existing-unicode-whitespace"),
    ],
)
def test_in_budget_identity_semantics_preserve_usage(
    real_flow, tmp_path, usage_webhook_api, values
):
    flow = _model_flow(real_flow, tmp_path, tuple((b"Content-Encoding", value) for value in values))

    _assert_model_usage(flow, standard_success_payload(OPENAI_RESPONSES_CASE), usage_webhook_api)


@pytest.mark.parametrize(
    "values",
    [
        pytest.param((b"identity", b"identity"), id="duplicate"),
        pytest.param((b"", b""), id="empty-duplicates"),
        pytest.param((b"gzip, br",), id="coding-list"),
        pytest.param((b"\xff",), id="non-utf8"),
        pytest.param(
            (b" " * (_VALUE_LIMIT // 2 - 1), b" " * (_VALUE_LIMIT // 2 - 1)),
            id="folded-value-exact-limit",
        ),
    ],
)
def test_in_budget_unsupported_encodings_remain_rejected(real_flow, tmp_path, mitm_ctx, values):
    fields = tuple((b"Content-Encoding", value) for value in values)
    flow = _model_flow(real_flow, tmp_path, fields)

    with mitm_ctx():
        mitm_addon.responseheaders(flow)

    assert flow.response is not None
    assert flow.response.status_code == 502
    assert response_stream(flow)(b"upstream-body") == b""
    [entry] = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
    assert entry["decode_skip_reason"] == "unsupported content encoding"


@pytest.mark.parametrize(
    ("billable", "status"),
    [(False, 200), (True, 429), (True, 204)],
)
def test_over_budget_uninspected_responses_keep_pass_through(
    real_flow, tmp_path, mitm_ctx, *, billable, status
):
    fields = ((b"Content-Encoding", _UninspectedValue(b" " * (_VALUE_LIMIT + 1))),)
    flow = _model_flow(real_flow, tmp_path, fields)
    flow.metadata[metadata_keys.FIREWALL_BILLABLE] = billable
    assert flow.response is not None
    flow.response.status_code = status
    upstream_response = flow.response

    with mitm_ctx():
        mitm_addon.responseheaders(flow)

    assert flow.response is upstream_response
    assert flow.response.status_code == status
    assert flow.response.headers.fields == fields
    if status != 204:
        assert response_stream(flow)(b"upstream-body") == b"upstream-body"
    assert response_stream(flow)(b"") == b""
