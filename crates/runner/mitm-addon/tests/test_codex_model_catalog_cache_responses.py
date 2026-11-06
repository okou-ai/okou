"""Integration coverage for Codex model catalog cache response handling."""

import json

import brotli  # type: ignore[import-untyped]
import pytest
from mitmproxy import http
from mitmproxy.test import tutils

import codex_model_catalog_cache as catalog_cache
import codex_model_catalog_validation as catalog_validation
import mitm_addon
import response_streaming
from tests.codex_model_catalog_cache_helpers import (
    CATALOG_BODY,
    CATALOG_ETAG,
    catalog_flow,
    catalog_response,
    finish_response,
    install_catalog,
    prepare_miss,
    prepare_prefetch_miss,
)
from tests.flow_helpers import header_map, response_stream


async def test_brotli_miss_without_length_is_cached_and_passed_through(real_flow):
    brotli_flow = catalog_flow(real_flow)
    await prepare_prefetch_miss(brotli_flow)
    brotli_flow.response = catalog_response(encoding="br")
    compressed_body = brotli_flow.response.raw_content or b""
    del brotli_flow.response.headers["Content-Length"]

    mitm_addon.responseheaders(brotli_flow)
    assert callable(brotli_flow.response.stream)
    assert brotli_flow.response.headers["Content-Encoding"] == "br"
    assert "Content-Length" not in brotli_flow.response.headers
    assert response_stream(brotli_flow)(compressed_body) == compressed_body

    finalization = catalog_cache.finalize_response(brotli_flow)
    assert finalization is not None
    await finalization
    assert brotli_flow.response.status_code == 200
    assert brotli_flow.response.raw_content == compressed_body
    assert brotli_flow.response.headers["Content-Encoding"] == "br"
    brotli_telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(brotli_flow, brotli_telemetry)
    brotli_latency = brotli_telemetry.pop("model_catalog_cache_validation_latency_ms")
    assert isinstance(brotli_latency, int)
    assert brotli_latency >= 0
    assert brotli_telemetry == {
        "model_catalog_cache_status": "model_catalog_cold_stored",
        "model_catalog_cache_upstream_encoding": "br",
        "model_catalog_prefetch_role": "producer",
    }
    brotli_hit = catalog_flow(real_flow)
    await catalog_cache.prepare_request(brotli_hit, request_end_stream=True)
    assert brotli_hit.response is not None
    assert brotli_hit.response.content == CATALOG_BODY
    assert "Content-Encoding" not in brotli_hit.response.headers

    identity_flow = catalog_flow(real_flow, version="identity-fallback")
    identity_telemetry = await install_catalog(identity_flow, encoding="identity")
    assert identity_flow.response is not None
    assert response_streaming.streamed_response_size(identity_flow) == len(CATALOG_BODY)
    assert identity_flow.response.raw_content == CATALOG_BODY
    identity_latency = identity_telemetry.pop("model_catalog_cache_validation_latency_ms")
    assert isinstance(identity_latency, int)
    assert identity_latency >= 0
    assert identity_telemetry == {
        "model_catalog_cache_status": "model_catalog_cold_stored",
        "model_catalog_cache_upstream_encoding": "identity",
    }


@pytest.mark.parametrize("encoding", ["br", "gzip"])
async def test_ordinary_owner_rejects_unsolicited_encoded_response(real_flow, encoding: str):
    flow = catalog_flow(real_flow, version=f"unsolicited-{encoding}")
    await prepare_miss(flow)
    upstream_response = catalog_response(encoding=encoding)
    upstream_body = upstream_response.raw_content or b""
    flow.response = upstream_response

    mitm_addon.responseheaders(flow)

    assert flow.response.status_code == 502
    assert "Content-Encoding" not in flow.response.headers
    assert callable(flow.response.stream)
    assert response_stream(flow)(upstream_body) == b""
    assert catalog_cache.finalize_response(flow) is None
    telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(flow, telemetry)
    validation_latency = telemetry.pop("model_catalog_cache_validation_latency_ms")
    assert isinstance(validation_latency, int)
    assert validation_latency >= 0
    expected: dict[str, object] = {
        "model_catalog_cache_status": "model_catalog_cold_not_stored",
        "model_catalog_cache_bypass_reason": "response_encoding",
    }
    if encoding == "br":
        expected["model_catalog_cache_upstream_encoding"] = "br"
    assert telemetry == expected

    retry = catalog_flow(real_flow, version=f"unsolicited-{encoding}")
    await prepare_miss(retry)
    catalog_cache.handle_error(retry)


@pytest.mark.parametrize(
    "transfer_encoding",
    [None, "chunked"],
    ids=["close-delimited", "transfer-encoded"],
)
async def test_ordinary_identity_miss_without_length_streams_and_caches(
    real_flow,
    transfer_encoding: str | None,
):
    version = f"identity-without-length-{transfer_encoding or 'none'}"
    flow = catalog_flow(real_flow, version=version)
    await prepare_miss(flow)
    flow.response = catalog_response()
    del flow.response.headers["Content-Length"]
    if transfer_encoding is not None:
        flow.response.headers["Transfer-Encoding"] = transfer_encoding

    telemetry = await finish_response(flow)

    assert flow.response.status_code == 200
    assert flow.response.raw_content == CATALOG_BODY
    assert "Content-Encoding" not in flow.response.headers
    assert "Content-Length" not in flow.response.headers
    assert telemetry["model_catalog_cache_status"] == "model_catalog_cold_stored"
    hit = catalog_flow(real_flow, version=version)
    await catalog_cache.prepare_request(hit, request_end_stream=True)
    assert hit.response is not None
    assert hit.response.content == CATALOG_BODY


async def test_set_cookie_is_not_replayed_from_cached_brotli_response(real_flow):
    cold = catalog_flow(real_flow, version="set-cookie")
    await prepare_prefetch_miss(cold)
    cold.response = catalog_response(
        encoding="br",
        headers={"Set-Cookie": "catalog_session=opaque; Secure"},
    )
    del cold.response.headers["Content-Length"]

    telemetry = await finish_response(cold)

    assert telemetry["model_catalog_cache_status"] == "model_catalog_cold_stored"
    assert cold.response.headers["Set-Cookie"] == "catalog_session=opaque; Secure"

    hit = catalog_flow(real_flow, version="set-cookie")
    await catalog_cache.prepare_request(hit, request_end_stream=True)
    assert hit.response is not None
    assert hit.response.content == CATALOG_BODY
    assert "Set-Cookie" not in hit.response.headers


@pytest.mark.parametrize(
    ("response", "reason"),
    [
        pytest.param(catalog_response(status=500), "response_status", id="non-success"),
        pytest.param(catalog_response(etag=None), "response_etag", id="missing-etag"),
        pytest.param(
            catalog_response(etag="unquoted"),
            "response_etag",
            id="invalid-etag",
        ),
        pytest.param(
            catalog_response(headers={"Content-Type": "text/plain"}),
            "response_content_type",
            id="wrong-content-type",
        ),
        pytest.param(
            catalog_response(headers={"Cache-Control": "no-store"}),
            "response_cache_control",
            id="no-store",
        ),
        pytest.param(
            catalog_response(headers={"Cache-Control": "max-age=00"}),
            "response_cache_control",
            id="zero-max-age",
        ),
        pytest.param(
            catalog_response(headers={"Cache-Control": "max-age=300"}),
            "response_cache_control",
            id="positive-max-age",
        ),
        pytest.param(
            catalog_response(headers={"Cache-Control": "no-transform"}),
            "response_cache_control",
            id="identity-no-transform",
        ),
        pytest.param(
            catalog_response(headers={"Expires": "Wed, 21 Oct 2037 07:28:00 GMT"}),
            "response_cache_control",
            id="expires",
        ),
        pytest.param(
            catalog_response(headers={"Pragma": "extension, no-cache"}),
            "response_cache_control",
            id="pragma-no-cache",
        ),
        pytest.param(
            catalog_response(headers={"Vary": "Accept-Encoding"}),
            "response_vary",
            id="variant",
        ),
        pytest.param(
            catalog_response(body=b"{broken"),
            "response_json",
            id="malformed-json",
        ),
        pytest.param(
            catalog_response(body=b'{"models":[],"value":NaN}'),
            "response_json",
            id="non-standard-json-constant",
        ),
        pytest.param(
            catalog_response(body=b'{"models":[],"value":1e999}'),
            "response_json",
            id="non-finite-json-number",
        ),
        pytest.param(
            catalog_response(body='{"models":[]}'.encode("utf-16")),
            "response_json",
            id="non-utf8-json",
        ),
        pytest.param(
            catalog_response(
                body=b'{"models":[],"value":' + b"9" * 5000 + b"}",
            ),
            "response_json",
            id="unbounded-json-integer",
        ),
        pytest.param(
            catalog_response(
                body=b'{"models":[],"value":' + b"[" * 50_000 + b"0" + b"]" * 50_000 + b"}",
            ),
            "response_json",
            id="deep-json",
        ),
        pytest.param(
            catalog_response(body=b"[]"),
            "response_shape",
            id="top-level-array",
        ),
        pytest.param(
            catalog_response(body=b"null"),
            "response_shape",
            id="top-level-null",
        ),
        pytest.param(
            catalog_response(body=b"123"),
            "response_shape",
            id="top-level-number",
        ),
        pytest.param(
            catalog_response(body=b'"text"'),
            "response_shape",
            id="top-level-string",
        ),
        pytest.param(
            catalog_response(body=b'{"items":[]}'),
            "response_shape",
            id="wrong-shape",
        ),
        pytest.param(
            catalog_response(headers={"Transfer-Encoding": "chunked"}),
            "response_size",
            id="ambiguous-framing",
        ),
        pytest.param(
            catalog_response(headers={"Content-Length": str(len(CATALOG_BODY) + 1)}),
            "response_body",
            id="length-mismatch",
        ),
        pytest.param(
            catalog_response(
                headers={"Content-Length": str(catalog_validation.MAX_ENTRY_BYTES + 1)}
            ),
            "response_size",
            id="oversized-declaration",
        ),
    ],
)
async def test_invalid_identity_responses_pass_through_without_installing(
    real_flow,
    response: http.Response,
    reason: str,
):
    flow = catalog_flow(real_flow)
    await prepare_miss(flow)
    flow.response = response
    original_status = response.status_code
    original_body = response.raw_content

    telemetry = await finish_response(flow)
    validation_latency = telemetry.pop("model_catalog_cache_validation_latency_ms")

    assert flow.response.status_code == original_status
    assert flow.response.raw_content == original_body
    assert isinstance(validation_latency, int)
    assert validation_latency >= 0
    assert telemetry == {
        "model_catalog_cache_status": "model_catalog_cold_not_stored",
        "model_catalog_cache_bypass_reason": reason,
        "model_catalog_cache_upstream_encoding": "identity",
    }

    retry = catalog_flow(real_flow)
    await prepare_miss(retry)
    catalog_cache.handle_error(retry)


async def test_json_nesting_bound_ignores_structural_characters_inside_strings(real_flow):
    body = json.dumps(
        {
            "models": [],
            "instructions": '[{"escaped":"value"}]' * 256,
        },
        separators=(",", ":"),
    ).encode()
    flow = catalog_flow(real_flow, version="string-syntax")

    telemetry = await install_catalog(flow, body=body)

    assert telemetry["model_catalog_cache_status"] == "model_catalog_cold_stored"
    hit = catalog_flow(real_flow, version="string-syntax")
    await catalog_cache.prepare_request(hit, request_end_stream=True)
    assert hit.response is not None
    assert hit.response.content == body


@pytest.mark.parametrize(
    ("wire_body", "declared_length", "reason"),
    [
        pytest.param(b"not brotli", None, "response_encoding", id="invalid"),
        pytest.param(
            brotli.compress(CATALOG_BODY)[:-1],
            None,
            "response_encoding",
            id="incomplete",
        ),
        pytest.param(
            brotli.compress(b'{"models":[],"value":NaN}'),
            None,
            "response_json",
            id="non-standard-json-constant",
        ),
        pytest.param(
            brotli.compress(b'{"items":[]}'),
            None,
            "response_shape",
            id="wrong-shape",
        ),
        pytest.param(
            brotli.compress(
                b'{"models":[],"padding":"' + b"x" * catalog_validation.MAX_ENTRY_BYTES + b'"}'
            ),
            None,
            "response_size",
            id="decoded-overflow",
        ),
        pytest.param(
            brotli.compress(CATALOG_BODY),
            len(brotli.compress(CATALOG_BODY)) + 1,
            "response_body",
            id="length-mismatch",
        ),
    ],
)
async def test_invalid_streamed_brotli_passes_through_without_installing(
    real_flow,
    wire_body: bytes,
    declared_length: int | None,
    reason: str,
):
    flow = catalog_flow(real_flow)
    await prepare_prefetch_miss(flow)
    length = len(wire_body) if declared_length is None else declared_length
    flow.response = tutils.tresp(
        status_code=200,
        headers=header_map(
            {
                "Content-Type": "application/json",
                "Content-Length": str(length),
                "Content-Encoding": "br",
                "ETag": CATALOG_ETAG,
            }
        ),
        content=wire_body,
    )

    mitm_addon.responseheaders(flow)
    assert flow.response.status_code == 200
    assert callable(flow.response.stream)
    assert response_stream(flow)(wire_body) == wire_body
    finalization = catalog_cache.finalize_response(flow)
    assert finalization is not None
    await finalization

    assert flow.response.status_code == 200
    assert flow.response.raw_content == wire_body
    assert flow.response.headers["Content-Encoding"] == "br"
    telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(flow, telemetry)
    validation_latency = telemetry.pop("model_catalog_cache_validation_latency_ms")
    assert isinstance(validation_latency, int)
    assert validation_latency >= 0
    assert telemetry == {
        "model_catalog_cache_status": "model_catalog_cold_not_stored",
        "model_catalog_cache_bypass_reason": reason,
        "model_catalog_cache_upstream_encoding": "br",
        "model_catalog_prefetch_role": "producer",
    }


@pytest.mark.parametrize(
    "body",
    [
        pytest.param(
            b'{"items":[]}',
            id="invalid-catalog",
        ),
        pytest.param(
            CATALOG_BODY,
            id="valid-non-cacheable-catalog",
        ),
    ],
)
async def test_brotli_cache_policy_bypasses_body_validation(
    real_flow,
    body: bytes,
):
    flow = catalog_flow(real_flow, version=f"cache-policy-{len(body)}")
    await prepare_prefetch_miss(flow)
    flow.response = catalog_response(
        body=body,
        etag=None,
        encoding="br",
        headers={"Cache-Control": "no-store"},
    )
    wire_body = flow.response.raw_content

    telemetry = await finish_response(flow)

    assert flow.response.status_code == 200
    assert flow.response.raw_content == wire_body
    assert telemetry["model_catalog_cache_status"] == "model_catalog_cold_not_stored"
    assert telemetry["model_catalog_cache_bypass_reason"] == "response_cache_control"

    retry = catalog_flow(real_flow, version=f"cache-policy-{len(body)}")
    await prepare_miss(retry)
    catalog_cache.handle_error(retry)


@pytest.mark.parametrize("encoding", ["identity", "br"])
async def test_catalog_responses_with_trailers_are_never_cached(
    real_flow,
    encoding: str,
):
    flow = catalog_flow(real_flow, version=f"trailers-{encoding}")
    if encoding == "br":
        await prepare_prefetch_miss(flow)
    else:
        await prepare_miss(flow)
    flow.response = catalog_response(encoding=encoding)
    flow.response.trailers = header_map({"Digest": "sha-256=:opaque:"})

    telemetry = await finish_response(flow)

    assert telemetry["model_catalog_cache_status"] == "model_catalog_cold_not_stored"
    assert telemetry["model_catalog_cache_bypass_reason"] == "response_body"
    assert flow.response.status_code == 200
    expected_body = brotli.compress(CATALOG_BODY) if encoding == "br" else CATALOG_BODY
    assert flow.response.raw_content == expected_body
    assert flow.response.trailers is not None

    retry = catalog_flow(real_flow, version=f"trailers-{encoding}")
    await prepare_miss(retry)
    catalog_cache.handle_error(retry)


async def test_catalog_response_accepts_long_leading_zero_content_length(real_flow):
    flow = catalog_flow(real_flow, version="leading-zero-content-length")
    await prepare_miss(flow)
    flow.response = catalog_response(
        headers={"Content-Length": "0" * 64 + str(len(CATALOG_BODY))},
    )

    telemetry = await finish_response(flow)

    assert telemetry["model_catalog_cache_status"] == "model_catalog_cold_stored"

    hit = catalog_flow(real_flow, version="leading-zero-content-length")
    await catalog_cache.prepare_request(hit, request_end_stream=True)
    assert hit.response is not None
    assert hit.response.content == CATALOG_BODY


@pytest.mark.parametrize(
    ("encoding", "headers", "reason", "expected_encoding"),
    [
        pytest.param(
            "br",
            {"Content-Length": "0"},
            "response_body",
            "br",
            id="empty-encoded-body",
        ),
        pytest.param(
            "br",
            {"Content-Length": str(catalog_validation.MAX_ENTRY_BYTES + 1)},
            "response_size",
            "br",
            id="encoded-overflow",
        ),
        pytest.param(
            "br",
            {"Content-Length": "9" * 5000},
            "response_size",
            "br",
            id="unbounded-length-integer",
        ),
        pytest.param(
            "br",
            {"Content-Length": "\v0"},
            "response_size",
            "br",
            id="non-ows-content-length",
        ),
        pytest.param(
            "br",
            {"Transfer-Encoding": "chunked"},
            "response_size",
            "br",
            id="ambiguous-framing",
        ),
        pytest.param(
            "br",
            {"Cache-Control": "no-transform"},
            "response_cache_control",
            "br",
            id="brotli-no-transform",
        ),
        pytest.param(
            "gzip",
            {},
            "response_encoding",
            None,
            id="unsupported-encoding",
        ),
    ],
)
async def test_unsafe_encoded_headers_pass_through_without_caching(
    real_flow,
    encoding: str,
    headers: dict[str, str],
    reason: str,
    expected_encoding: str | None,
):
    flow = catalog_flow(real_flow, version=f"unsafe-{encoding}-{reason}")
    await prepare_prefetch_miss(flow)
    response = catalog_response(encoding=encoding, headers=headers)
    if headers.get("Content-Length") == "":
        del response.headers["Content-Length"]
    flow.response = response

    mitm_addon.responseheaders(flow)

    assert flow.response.status_code == 200
    assert callable(flow.response.stream)
    wire_body = response.raw_content or b""
    assert response_stream(flow)(wire_body) == wire_body
    finalization = catalog_cache.finalize_response(flow)
    if finalization is not None:
        await finalization
    assert flow.response.status_code == 200
    assert flow.response.raw_content == wire_body
    telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(flow, telemetry)
    validation_latency = telemetry.pop("model_catalog_cache_validation_latency_ms")
    assert isinstance(validation_latency, int)
    assert validation_latency >= 0
    expected = {
        "model_catalog_cache_status": "model_catalog_cold_not_stored",
        "model_catalog_cache_bypass_reason": reason,
    }
    if expected_encoding is not None:
        expected["model_catalog_cache_upstream_encoding"] = expected_encoding
    expected["model_catalog_prefetch_role"] = "producer"
    assert telemetry == expected


async def test_complete_decoded_body_bound_is_cached(real_flow):
    prefix = b'{"models":[],"padding":"'
    suffix = b'"}'
    exact_body = (
        prefix + b"x" * (catalog_validation.MAX_ENTRY_BYTES - len(prefix) - len(suffix)) + suffix
    )
    exact = catalog_flow(real_flow, version="exact-cap")
    assert (await install_catalog(exact, body=exact_body, encoding="br"))[
        "model_catalog_cache_status"
    ] == "model_catalog_cold_stored"
    exact_hit = catalog_flow(real_flow, version="exact-cap")
    await catalog_cache.prepare_request(exact_hit, request_end_stream=True)
    assert exact_hit.response is not None
    assert exact_hit.response.content == exact_body
