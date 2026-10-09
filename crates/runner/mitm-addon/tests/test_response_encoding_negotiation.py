"""Safe response encoding negotiation for usage-inspected requests."""

from collections.abc import Callable
from pathlib import Path

import pytest
from mitmproxy import http

import body_decoding
import flow_metadata_keys as metadata_keys
import mitm_addon
import response_encoding_negotiation
from tests.flow_helpers import response_stream
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry
from tests.requestheaders_helpers import await_requestheaders_result

_MODEL_PROVIDER_FIREWALL_NAME = "model-provider:openrouter-codex"
_MODEL_PROVIDER_HOST = "openrouter.ai"
_MODEL_PROVIDER_PATH = "/api/v1/responses"
_SUBSCRIPTION_FIREWALL_NAME = "model-provider:claude-code-oauth-token"
_SUBSCRIPTION_HOST = "api.anthropic.com"
_SUBSCRIPTION_PATH = "/v1/messages"
_X_FIREWALL_NAME = "x"
_X_HOST = "api.x.com"
_X_PATH = "/2/users/by"
_ACCEPT_ENCODING = "Accept-Encoding"
_MAX_ACCEPT_ENCODING_VALUE_BYTES = 64 * 1024
_WEBSOCKET_HEADER_WORK_LIMIT = 8 * 1024
_WEBSOCKET_KEY = "dGhlIHNhbXBsZSBub25jZQ=="
_BROWSER_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) HeadlessChrome/126.0.0.0 Safari/537.36"
)


class _DecodeGuardAcceptEncoding(bytes):
    def decode(self, encoding: str = "utf-8", errors: str = "strict") -> str:
        raise AssertionError("over-budget Accept-Encoding must not be decoded")


@pytest.mark.parametrize(
    ("header_pairs", "values"),
    [
        pytest.param([], ["identity"], id="absent"),
        pytest.param(
            [("Accept-Encoding", "identity")],
            ["identity"],
            id="identity-already-normalized",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip")],
            ["gzip"],
            id="gzip-already-normalized",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip, zstd, br")],
            ["gzip, br"],
            id="drops-zstd-keeps-stream-decodable-codings",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip;q=0, deflate;q=0.5, identity;q=1")],
            ["deflate;q=0.5, identity;q=1"],
            id="drops-safe-q-zero",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip;q=1., zstd")],
            ["gzip;q=1."],
            id="accepts-q-one-zero-digit-fraction",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip;q=0., gzip;q=1, zstd")],
            ["identity"],
            id="rejects-q-zero-zero-digit-fraction",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip;q=0.5, identity;q=0., zstd")],
            ["gzip;q=0.5, identity;q=0"],
            id="preserves-identity-zero-digit-fraction-rejection",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip, *;q=0., zstd")],
            ["gzip, identity;q=0"],
            id="preserves-wildcard-zero-digit-fraction-rejection",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip, identity;q=0, zstd")],
            ["gzip, identity;q=0"],
            id="preserves-explicit-identity-rejection-with-safe-coding",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip, *;q=0, zstd")],
            ["gzip, identity;q=0"],
            id="preserves-wildcard-identity-rejection-with-safe-coding",
        ),
        pytest.param(
            [("Accept-Encoding", "zstd, br, *")],
            ["br"],
            id="drops-zstd-and-wildcard-keeps-brotli",
        ),
        pytest.param(
            [("Accept-Encoding", "identity;q=0, zstd")],
            ["identity;q=0, zstd"],
            id="respects-explicit-identity-rejection",
        ),
        pytest.param(
            [("Accept-Encoding", "*;q=0, zstd")],
            ["*;q=0, zstd"],
            id="wildcard-zero-rejects-implicit-identity",
        ),
        pytest.param(
            [("Accept-Encoding", "zstd, br, *;q=0.5, identity;q=0")],
            ["br, gzip;q=0.5, deflate;q=0.5, identity;q=0"],
            id="wildcard-allows-safe-compression-when-identity-rejected",
        ),
        pytest.param(
            [("Accept-Encoding", "zstd, br, *, identity;q=0")],
            ["br, gzip, deflate, identity;q=0"],
            id="wildcard-default-q-allows-safe-compression-when-identity-rejected",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip;q=0, zstd, *;q=0.5, identity;q=0")],
            ["deflate;q=0.5, br;q=0.5, identity;q=0"],
            id="wildcard-safe-compression-respects-explicit-safe-rejection",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip;q=0.2, zstd, *;q=0.8, identity;q=0")],
            ["gzip;q=0.2, deflate;q=0.8, br;q=0.8, identity;q=0"],
            id="wildcard-adds-missing-safe-compression-after-explicit-safe-coding",
        ),
        pytest.param(
            [("Accept-Encoding", "deflate, br"), ("Accept-Encoding", "*;q=0.5, identity;q=0")],
            ["deflate, br, gzip;q=0.5, identity;q=0"],
            id="wildcard-adds-missing-safe-compression-across-header-fields",
        ),
        pytest.param(
            [
                (
                    "Accept-Encoding",
                    "gzip;q=0, deflate;q=0, zstd, *;q=0.5, identity;q=0",
                )
            ],
            ["br;q=0.5, identity;q=0"],
            id="wildcard-adds-brotli-when-zlib-codings-are-rejected",
        ),
        pytest.param(
            [("Accept-Encoding", "*;q=0.5, *;q=0, identity;q=0, zstd")],
            ["*;q=0.5, *;q=0, identity;q=0, zstd"],
            id="duplicate-wildcard-rejection-wins",
        ),
        pytest.param(
            [("Accept-Encoding", "GZip;q=1, zstd"), ("Accept-Encoding", "deflate;q=0.5, br")],
            ["gzip;q=1, deflate;q=0.5, br"],
            id="case-insensitive-and-multiple-fields",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip, gzip;q=0.5, deflate")],
            ["gzip, deflate"],
            id="collapses-duplicate-safe-codings",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip;q=1, gzip;q=0, zstd")],
            ["identity"],
            id="duplicate-safe-coding-rejection-wins-after-acceptance",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip;q=0, gzip;q=1, zstd")],
            ["identity"],
            id="duplicate-safe-coding-rejection-wins-before-acceptance",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip;q=1;q=0, zstd")],
            ["identity"],
            id="duplicate-q-parameter-is-not-readvertised",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip;foo=bar, zstd")],
            ["identity"],
            id="non-q-parameter-is-not-readvertised",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip;q=0.5;foo=bar, zstd")],
            ["identity"],
            id="q-with-extra-parameter-is-not-readvertised",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip;, zstd")],
            ["identity"],
            id="empty-parameter-is-not-readvertised",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip\u2028, zstd")],
            ["identity"],
            id="unicode-whitespace-suffix-is-not-readvertised",
        ),
        pytest.param(
            [("Accept-Encoding", "\u2028gzip, zstd")],
            ["identity"],
            id="unicode-whitespace-prefix-is-not-readvertised",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip\v, zstd")],
            ["identity"],
            id="vertical-tab-suffix-is-not-readvertised",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip\n, zstd")],
            ["identity"],
            id="newline-suffix-is-not-readvertised",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip;q=0.5\u2028, zstd")],
            ["identity"],
            id="unicode-whitespace-q-value-is-not-readvertised",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip, identity;q=1, identity;q=0, zstd")],
            ["gzip, identity;q=0"],
            id="duplicate-identity-rejection-is-preserved-with-safe-coding",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip;q=2, zstd")],
            ["identity"],
            id="invalid-q-value-not-readvertised",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip;q=1.0000, zstd")],
            ["identity"],
            id="q-value-with-too-many-digits-not-readvertised",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip;q=.5, zstd")],
            ["identity"],
            id="q-value-without-leading-zero-not-readvertised",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip;q=1e-1, zstd")],
            ["identity"],
            id="exponent-q-value-not-readvertised",
        ),
        pytest.param(
            [("Accept-Encoding", "identity;q=bogus, zstd")],
            ["identity"],
            id="malformed-identity-q-is-not-explicit-rejection",
        ),
        pytest.param(
            [("Accept-Encoding", "identity;q=0.0000, zstd")],
            ["identity"],
            id="malformed-identity-zero-is-not-explicit-rejection",
        ),
    ],
)
def test_normalize_accept_encoding_for_body_inspection(
    headers,
    header_pairs: list[tuple[str, str]],
    values: list[str],
) -> None:
    request_headers = headers(*header_pairs)

    response_encoding_negotiation.normalize_accept_encoding_for_body_inspection(request_headers)
    assert request_headers.get_all(_ACCEPT_ENCODING) == values


@pytest.mark.parametrize(
    ("header_pairs", "outcome"),
    [
        pytest.param([], "rewritten_stream_decodable", id="absent"),
        pytest.param(
            [("Accept-Encoding", "gzip")],
            "already_stream_decodable",
            id="already-safe",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip, zstd")],
            "rewritten_stream_decodable",
            id="unsafe-coding-removed",
        ),
        pytest.param(
            [("Accept-Encoding", "gzip;q=bogus, br")],
            "rewritten_stream_decodable",
            id="malformed-coding-rewritten",
        ),
        pytest.param(
            [("Accept-Encoding", "br, zstd, *;q=0.5, identity;q=0")],
            "rewritten_stream_decodable",
            id="wildcard-expanded",
        ),
        pytest.param(
            [
                (
                    "Accept-Encoding",
                    "gzip;q=0, deflate;q=0, br;q=0, identity;q=0",
                )
            ],
            "preserved_client_constraints",
            id="all-safe-representations-rejected",
        ),
    ],
)
def test_normalization_reports_bounded_negotiation_outcome(
    headers,
    header_pairs: list[tuple[str, str]],
    outcome: response_encoding_negotiation.ResponseEncodingNegotiationOutcome,
) -> None:
    request_headers = headers(*header_pairs)

    assert (
        response_encoding_negotiation.normalize_accept_encoding_for_body_inspection(request_headers)
        == outcome
    )


def test_normalization_accepts_exact_raw_value_budget(headers) -> None:
    raw_value = (
        "gzip," * ((_MAX_ACCEPT_ENCODING_VALUE_BYTES - len("zstd  ")) // len("gzip,")) + "zstd  "
    )
    assert len(raw_value.encode()) == _MAX_ACCEPT_ENCODING_VALUE_BYTES
    request_headers = headers((_ACCEPT_ENCODING, raw_value))

    outcome = response_encoding_negotiation.normalize_accept_encoding_for_body_inspection(
        request_headers
    )

    assert outcome == "rewritten_stream_decodable"
    assert request_headers.get_all(_ACCEPT_ENCODING) == ["gzip"]


def test_normalization_preserves_first_over_budget_raw_value_without_decoding() -> None:
    guarded_value = _DecodeGuardAcceptEncoding(b"x" * (_MAX_ACCEPT_ENCODING_VALUE_BYTES + 1))
    original_fields = ((b"aCcEpT-EnCoDiNg", guarded_value),)
    request_headers = http.Headers(original_fields)

    outcome = response_encoding_negotiation.normalize_accept_encoding_for_body_inspection(
        request_headers
    )

    assert outcome == "preserved_work_budget"
    assert request_headers.fields == original_fields


def test_normalization_combines_repeated_raw_value_budget_without_decoding() -> None:
    guarded_first = _DecodeGuardAcceptEncoding(b"x" * (_MAX_ACCEPT_ENCODING_VALUE_BYTES // 2))
    guarded_second = _DecodeGuardAcceptEncoding(b"y" * (_MAX_ACCEPT_ENCODING_VALUE_BYTES // 2 + 1))
    original_fields = (
        (b"Accept-Encoding", guarded_first),
        (b"accept-encoding", guarded_second),
    )
    request_headers = http.Headers(original_fields)

    outcome = response_encoding_negotiation.normalize_accept_encoding_for_body_inspection(
        request_headers
    )

    assert outcome == "preserved_work_budget"
    assert request_headers.fields == original_fields


def test_explicit_normalized_encodings_create_stream_decode_sessions(headers) -> None:
    supported_encodings = body_decoding.stream_decodable_content_encodings()
    request_headers = headers(
        (
            _ACCEPT_ENCODING,
            ", ".join((*supported_encodings, "zstd")),
        )
    )

    response_encoding_negotiation.normalize_accept_encoding_for_body_inspection(request_headers)

    normalized_encodings = tuple(
        raw_coding.strip().partition(";")[0]
        for value in request_headers.get_all(_ACCEPT_ENCODING)
        for raw_coding in value.split(",")
    )
    assert normalized_encodings == supported_encodings
    for encoding in normalized_encodings:
        session = body_decoding.create_stream_decode_session(
            headers(("Content-Encoding", encoding)),
            lambda _chunk: None,
        )
        assert session is not None


def test_wildcard_expansion_uses_stream_decoder_capability_order(headers) -> None:
    request_headers = headers((_ACCEPT_ENCODING, "zstd, *;q=0.5, identity;q=0"))

    response_encoding_negotiation.normalize_accept_encoding_for_body_inspection(request_headers)

    compression_encodings = tuple(
        encoding
        for encoding in body_decoding.stream_decodable_content_encodings()
        if encoding != "identity"
    )
    assert request_headers.get_all(_ACCEPT_ENCODING) == [
        ", ".join((*[f"{encoding};q=0.5" for encoding in compression_encodings], "identity;q=0"))
    ]
    for encoding in compression_encodings:
        session = body_decoding.create_stream_decode_session(
            headers(("Content-Encoding", encoding)),
            lambda _chunk: None,
        )
        assert session is not None


def _model_provider_registry(
    tmp_path: Path,
    *,
    model_usage_provider: object = "gpt-5.5",
    billable: bool = True,
    capture_network_bodies: bool = False,
    rule_method: str = "POST",
) -> Path:
    firewall_name = _MODEL_PROVIDER_FIREWALL_NAME if billable else _SUBSCRIPTION_FIREWALL_NAME
    host = _MODEL_PROVIDER_HOST if billable else _SUBSCRIPTION_HOST
    path = _MODEL_PROVIDER_PATH if billable else _SUBSCRIPTION_PATH
    sandbox_fields: dict[str, object] = {}
    if model_usage_provider is not None:
        sandbox_fields["modelUsageProvider"] = model_usage_provider
    if capture_network_bodies:
        sandbox_fields["captureNetworkBodies"] = True

    return _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            firewall_name=firewall_name,
            api_entry={
                "base": f"https://{host}",
                "auth": {"headers": {"Authorization": "Bearer test-key"}},
                "permissions": [{"name": "inference", "rules": [f"{rule_method} {path}"]}],
            },
            network_policy={
                "allow": ["inference"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
            billable_firewalls=[firewall_name] if billable else None,
            sandbox_fields=sandbox_fields,
        ),
    )


def _connector_registry(
    tmp_path: Path,
    *,
    firewall_name: str,
    host: str,
    path: str,
    billable: bool,
    capture_network_bodies: bool = False,
    include_encrypted_secrets: bool = True,
) -> Path:
    sandbox_fields: dict[str, object] = {}
    if capture_network_bodies:
        sandbox_fields["captureNetworkBodies"] = True

    return _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            firewall_name=firewall_name,
            api_entry={
                "base": f"https://{host}",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [{"name": "read", "rules": [f"GET {path}"]}],
            },
            network_policy={
                "allow": ["read"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
            billable_firewalls=[firewall_name] if billable else None,
            include_encrypted_secrets=include_encrypted_secrets,
            sandbox_fields=sandbox_fields,
        ),
    )


def _request_flow(
    real_flow: Callable[..., http.HTTPFlow],
    headers: Callable[..., http.Headers],
    *,
    host: str,
    path: str,
    method: str,
    accept_encoding: str | None,
    extra_headers: tuple[tuple[str, str], ...] = (),
) -> http.HTTPFlow:
    header_pairs = [("Host", host)]
    if accept_encoding is not None:
        header_pairs.append((_ACCEPT_ENCODING, accept_encoding))
    header_pairs.extend(extra_headers)
    return real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host=host,
        path=path,
        method=method,
        request_headers=headers(*header_pairs),
    )


async def test_billable_model_provider_request_normalizes_accept_encoding_before_auth(
    tmp_path: Path,
    real_flow: Callable[..., http.HTTPFlow],
    headers: Callable[..., http.Headers],
    mitm_ctx,
    fake_firewall_headers,
) -> None:
    reg_path = _model_provider_registry(tmp_path)
    flow = _request_flow(
        real_flow,
        headers,
        host=_MODEL_PROVIDER_HOST,
        path=_MODEL_PROVIDER_PATH,
        method="POST",
        accept_encoding="gzip, zstd, br",
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.request.headers[_ACCEPT_ENCODING] == "gzip, br"
    assert flow.request.headers["Authorization"] == "Bearer x"
    assert (
        flow.metadata[metadata_keys.RESPONSE_ENCODING_NEGOTIATION] == "rewritten_stream_decodable"
    )


async def test_billable_model_provider_request_preserves_over_budget_accept_encoding(
    tmp_path: Path,
    real_flow: Callable[..., http.HTTPFlow],
    mitm_ctx,
    fake_firewall_headers,
) -> None:
    reg_path = _model_provider_registry(tmp_path)
    guarded_value = _DecodeGuardAcceptEncoding(b"x" * (_MAX_ACCEPT_ENCODING_VALUE_BYTES + 1))
    accept_encoding_field = (b"Accept-Encoding", guarded_value)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host=_MODEL_PROVIDER_HOST,
        path=_MODEL_PROVIDER_PATH,
        method="POST",
        request_headers=http.Headers(
            [
                (b"Host", _MODEL_PROVIDER_HOST.encode()),
                accept_encoding_field,
            ]
        ),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert accept_encoding_field in flow.request.headers.fields
    assert flow.request.headers["Authorization"] == "Bearer x"
    assert flow.metadata[metadata_keys.RESPONSE_ENCODING_NEGOTIATION] == "preserved_work_budget"


async def test_billable_model_provider_without_accept_encoding_sets_identity(
    tmp_path: Path,
    real_flow: Callable[..., http.HTTPFlow],
    headers: Callable[..., http.Headers],
    mitm_ctx,
    fake_firewall_headers,
) -> None:
    reg_path = _model_provider_registry(tmp_path)
    flow = _request_flow(
        real_flow,
        headers,
        host=_MODEL_PROVIDER_HOST,
        path=_MODEL_PROVIDER_PATH,
        method="POST",
        accept_encoding=None,
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    assert flow.request.headers[_ACCEPT_ENCODING] == "identity"
    assert (
        flow.metadata[metadata_keys.RESPONSE_ENCODING_NEGOTIATION] == "rewritten_stream_decodable"
    )


async def test_billable_connector_with_response_parser_normalizes_accept_encoding(
    tmp_path: Path,
    real_flow: Callable[..., http.HTTPFlow],
    headers: Callable[..., http.Headers],
    mitm_ctx,
    fake_firewall_headers,
) -> None:
    reg_path = _connector_registry(
        tmp_path,
        firewall_name=_X_FIREWALL_NAME,
        host=_X_HOST,
        path=_X_PATH,
        billable=True,
    )
    flow = _request_flow(
        real_flow,
        headers,
        host=_X_HOST,
        path=_X_PATH,
        method="GET",
        accept_encoding="deflate, zstd",
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    assert flow.request.headers[_ACCEPT_ENCODING] == "deflate"
    assert (
        flow.metadata[metadata_keys.RESPONSE_ENCODING_NEGOTIATION] == "rewritten_stream_decodable"
    )


async def test_billable_connector_without_response_parser_keeps_accept_encoding(
    tmp_path: Path,
    real_flow: Callable[..., http.HTTPFlow],
    headers: Callable[..., http.Headers],
    mitm_ctx,
    fake_firewall_headers,
) -> None:
    reg_path = _connector_registry(
        tmp_path,
        firewall_name="stripe",
        host="api.stripe.com",
        path="/v1/charges",
        billable=True,
    )
    flow = _request_flow(
        real_flow,
        headers,
        host="api.stripe.com",
        path="/v1/charges",
        method="GET",
        accept_encoding="gzip, zstd, br",
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    assert flow.request.headers[_ACCEPT_ENCODING] == "gzip, zstd, br"
    assert metadata_keys.RESPONSE_ENCODING_NEGOTIATION not in flow.metadata


async def test_non_billable_model_provider_keeps_accept_encoding(
    tmp_path: Path,
    real_flow: Callable[..., http.HTTPFlow],
    headers: Callable[..., http.Headers],
    mitm_ctx,
    fake_firewall_headers,
) -> None:
    reg_path = _model_provider_registry(tmp_path, billable=False, model_usage_provider=None)
    flow = _request_flow(
        real_flow,
        headers,
        host=_SUBSCRIPTION_HOST,
        path=_SUBSCRIPTION_PATH,
        method="POST",
        accept_encoding="gzip, zstd, br",
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    assert flow.request.headers[_ACCEPT_ENCODING] == "gzip, zstd, br"
    assert metadata_keys.RESPONSE_ENCODING_NEGOTIATION not in flow.metadata


async def test_header_phase_stream_safe_auth_normalizes_accept_encoding_before_auth(
    tmp_path: Path,
    real_flow: Callable[..., http.HTTPFlow],
    headers: Callable[..., http.Headers],
    mitm_ctx,
    fake_firewall_headers,
) -> None:
    reg_path = _connector_registry(
        tmp_path,
        firewall_name=_X_FIREWALL_NAME,
        host=_X_HOST,
        path=_X_PATH,
        billable=True,
        capture_network_bodies=True,
    )
    flow = _request_flow(
        real_flow,
        headers,
        host=_X_HOST,
        path=_X_PATH,
        method="GET",
        accept_encoding="gzip, zstd, br",
        extra_headers=(("Content-Length", str(mitm_addon.STREAM_BUFFER_LIMIT + 1)),),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        await await_requestheaders_result(requestheaders_result)
        assert flow.request.headers[_ACCEPT_ENCODING] == "gzip, br"
        assert flow.request.headers["Authorization"] == "Bearer x"
        assert (
            flow.metadata[metadata_keys.RESPONSE_ENCODING_NEGOTIATION]
            == "rewritten_stream_decodable"
        )
        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.request.headers[_ACCEPT_ENCODING] == "gzip, br"


async def test_header_phase_stream_safe_auth_preserves_over_budget_accept_encoding(
    tmp_path: Path,
    real_flow: Callable[..., http.HTTPFlow],
    mitm_ctx,
    fake_firewall_headers,
) -> None:
    reg_path = _connector_registry(
        tmp_path,
        firewall_name=_X_FIREWALL_NAME,
        host=_X_HOST,
        path=_X_PATH,
        billable=True,
        capture_network_bodies=True,
    )
    guarded_value = _DecodeGuardAcceptEncoding(b"x" * (_MAX_ACCEPT_ENCODING_VALUE_BYTES + 1))
    accept_encoding_field = (b"aCcEpT-EnCoDiNg", guarded_value)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host=_X_HOST,
        path=_X_PATH,
        method="GET",
        request_headers=http.Headers(
            [
                (b"Host", _X_HOST.encode()),
                accept_encoding_field,
                (b"Content-Length", str(mitm_addon.STREAM_BUFFER_LIMIT + 1).encode()),
            ]
        ),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        await await_requestheaders_result(requestheaders_result)
        assert accept_encoding_field in flow.request.headers.fields
        assert flow.request.headers["Authorization"] == "Bearer x"
        assert flow.metadata[metadata_keys.RESPONSE_ENCODING_NEGOTIATION] == "preserved_work_budget"
        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert accept_encoding_field in flow.request.headers.fields


async def test_header_phase_auth_fallback_restores_encoding_negotiation(
    tmp_path: Path,
    real_flow: Callable[..., http.HTTPFlow],
    headers: Callable[..., http.Headers],
    mitm_ctx,
    fake_firewall_headers,
) -> None:
    reg_path = _connector_registry(
        tmp_path,
        firewall_name=_X_FIREWALL_NAME,
        host=_X_HOST,
        path=_X_PATH,
        billable=True,
        capture_network_bodies=True,
        include_encrypted_secrets=False,
    )
    original_accept_encoding = "gzip, zstd, br"
    flow = _request_flow(
        real_flow,
        headers,
        host=_X_HOST,
        path=_X_PATH,
        method="GET",
        accept_encoding=original_accept_encoding,
        extra_headers=(("Content-Length", str(mitm_addon.STREAM_BUFFER_LIMIT + 1)),),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        await await_requestheaders_result(requestheaders_result)

    auth_fetch.assert_not_called()
    assert flow.request.headers[_ACCEPT_ENCODING] == original_accept_encoding
    assert metadata_keys.RESPONSE_ENCODING_NEGOTIATION not in flow.metadata


async def test_header_phase_websocket_auth_fallback_restores_upgrade_marker(
    tmp_path: Path,
    real_flow: Callable[..., http.HTTPFlow],
    headers: Callable[..., http.Headers],
    mitm_ctx,
    fake_firewall_headers,
) -> None:
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            firewall_name=_X_FIREWALL_NAME,
            api_entry={
                "base": f"https://{_X_HOST}",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [{"name": "read", "rules": [f"GET {_X_PATH}"]}],
            },
            network_policy={
                "allow": ["read"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
            billable_firewalls=[_X_FIREWALL_NAME],
            include_encrypted_secrets=False,
            sandbox_fields={"captureNetworkBodies": True},
        ),
    )
    flow = _request_flow(
        real_flow,
        headers,
        host=_X_HOST,
        path=_X_PATH,
        method="GET",
        accept_encoding="gzip, zstd, br",
        extra_headers=(
            ("Connection", "keep-alive, Upgrade"),
            ("Upgrade", "websocket"),
            ("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ=="),
            ("Sec-WebSocket-Version", "13"),
            ("Content-Length", str(mitm_addon.STREAM_BUFFER_LIMIT + 1)),
        ),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        await await_requestheaders_result(requestheaders_result)

    auth_fetch.assert_not_called()
    assert metadata_keys.WEBSOCKET_UPGRADE_REQUEST not in flow.metadata
    assert metadata_keys.RESPONSE_ENCODING_NEGOTIATION not in flow.metadata
    assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
    assert flow.request.headers[_ACCEPT_ENCODING] == "gzip, zstd, br"


@pytest.mark.parametrize(
    "extra_headers",
    [
        pytest.param(
            (
                ("Connection", "keep-alive, Upgrade"),
                ("Upgrade", "websocket"),
                ("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ=="),
                ("Sec-WebSocket-Version", "13"),
            ),
            id="standard",
        ),
        pytest.param(
            (
                ("Connection", "keep-alive, Upgrade"),
                ("Upgrade", "h2c, WebSocket"),
                ("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ=="),
                ("Sec-WebSocket-Version", "13"),
            ),
            id="upgrade-token-list",
        ),
        pytest.param(
            (
                ("Connection", "keep-alive, Upgrade"),
                ("Upgrade", "h2c"),
                ("Upgrade", "websocket"),
                ("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ=="),
                ("Sec-WebSocket-Version", "13"),
            ),
            id="repeated-upgrade-header",
        ),
        pytest.param(
            (
                ("Connection", "Upgrade," + "x" * 10_000),
                ("Upgrade", "websocket"),
                ("Sec-WebSocket-Key", _WEBSOCKET_KEY),
                ("Sec-WebSocket-Version", "13"),
            ),
            id="connection-token-before-oversized-suffix",
        ),
        pytest.param(
            (
                ("Connection", "Upgrade"),
                ("Upgrade", "websocket"),
                (
                    "Sec-WebSocket-Key",
                    " " * (_WEBSOCKET_HEADER_WORK_LIMIT - len(_WEBSOCKET_KEY)) + _WEBSOCKET_KEY,
                ),
                ("Sec-WebSocket-Version", "13"),
            ),
            id="websocket-key-at-raw-work-boundary",
        ),
    ],
)
async def test_model_provider_websocket_upgrade_injects_auth_and_keeps_accept_encoding(
    tmp_path: Path,
    real_flow: Callable[..., http.HTTPFlow],
    headers: Callable[..., http.Headers],
    mitm_ctx,
    fake_firewall_headers,
    extra_headers: tuple[tuple[str, str], ...],
) -> None:
    firewall_name = "model-provider:openrouter-codex"
    host = "openrouter.ai"
    # Match the generated OpenAI model-provider firewall; upstream endpoint
    # WebSocket validity is outside the request-hook auth injection boundary.
    path = "/api/v1/responses"
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            firewall_name=firewall_name,
            api_entry={
                "base": f"https://{host}{path}",
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.OPENAI_API_KEY }}"}},
                "permissions": [],
            },
            network_policy={
                "allow": [],
                "deny": [],
                "ask": [],
                "unknownPolicy": "allow",
            },
            sandbox_fields={"modelUsageProvider": "gpt-5.5"},
        ),
    )
    flow = _request_flow(
        real_flow,
        headers,
        host=host,
        path=path,
        method="GET",
        accept_encoding="gzip, zstd, br",
        extra_headers=extra_headers,
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == f"https://{host}{path}"
    assert flow.metadata[metadata_keys.FIREWALL_NAME] == firewall_name
    assert flow.metadata[metadata_keys.FIREWALL_PERMISSION] == ""
    assert flow.request.headers["Authorization"] == "Bearer x"
    assert flow.request.headers[_ACCEPT_ENCODING] == "gzip, zstd, br"
    assert metadata_keys.RESPONSE_ENCODING_NEGOTIATION not in flow.metadata


@pytest.mark.parametrize(
    ("firewall_name", "host", "path", "content_type", "content_encoding"),
    [
        pytest.param(
            _X_FIREWALL_NAME,
            _X_HOST,
            "/2/tweets/search/stream",
            "application/x-ndjson",
            "zstd",
            id="connector-stream",
        ),
        pytest.param(
            _MODEL_PROVIDER_FIREWALL_NAME,
            _MODEL_PROVIDER_HOST,
            _MODEL_PROVIDER_PATH,
            "application/json",
            "unsupported-encoding",
            id="model-json",
        ),
        pytest.param(
            _MODEL_PROVIDER_FIREWALL_NAME,
            _MODEL_PROVIDER_HOST,
            _MODEL_PROVIDER_PATH,
            "text/event-stream",
            "zstd",
            id="model-sse",
        ),
    ],
)
@pytest.mark.parametrize("header_phase", [False, True], ids=["request", "requestheaders"])
async def test_upgrade_request_rejects_uninspectable_http_response(
    tmp_path: Path,
    real_flow: Callable[..., http.HTTPFlow],
    headers: Callable[..., http.Headers],
    mitm_ctx,
    fake_firewall_headers,
    firewall_name: str,
    host: str,
    path: str,
    content_type: str,
    content_encoding: str,
    header_phase: bool,
) -> None:
    if firewall_name == _MODEL_PROVIDER_FIREWALL_NAME:
        reg_path = _model_provider_registry(
            tmp_path,
            rule_method="GET",
            capture_network_bodies=header_phase,
        )
    else:
        reg_path = _connector_registry(
            tmp_path,
            firewall_name=firewall_name,
            host=host,
            path=path,
            billable=True,
            capture_network_bodies=header_phase,
        )
    flow = _request_flow(
        real_flow,
        headers,
        host=host,
        path=path,
        method="GET",
        accept_encoding="gzip, zstd, br",
        extra_headers=(
            ("Connection", "Upgrade"),
            ("Upgrade", "websocket"),
            ("Sec-WebSocket-Key", _WEBSOCKET_KEY),
            ("Sec-WebSocket-Version", "13"),
        ),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(),
    ):
        if header_phase:
            await await_requestheaders_result(mitm_addon.requestheaders(flow))
        await mitm_addon.request(flow)

        assert flow.response is None
        assert flow.metadata[metadata_keys.WEBSOCKET_UPGRADE_REQUEST] is True
        assert metadata_keys.RESPONSE_ENCODING_NEGOTIATION not in flow.metadata
        assert flow.request.headers[_ACCEPT_ENCODING] == "gzip, zstd, br"

        flow.response = http.Response.make(
            200,
            b"",
            {"Content-Type": content_type},
        )
        # Assign the upstream encoding after make(), which otherwise strips unsupported codecs.
        flow.response.headers["Content-Encoding"] = content_encoding
        mitm_addon.responseheaders(flow)

    assert flow.response.status_code == 502
    assert flow.response.content == b""
    stream = response_stream(flow)
    assert stream(b"upstream chunk one") == b""
    assert stream(b"upstream chunk two") == b""
    assert stream(b"") == b""
    [entry] = [
        entry
        for entry in read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
        if entry.get("type") == "usage_underbilling"
    ]
    assert entry["status_code"] == 200
    assert entry["inspection_disposition"] == "fail_closed"
    assert entry["request_encoding_negotiation"] is None


@pytest.mark.parametrize(
    ("method", "rule_method"),
    [
        pytest.param("HEAD", "HEAD", id="head"),
        pytest.param("CONNECT", "ANY", id="connect"),
    ],
)
async def test_response_bodyless_usage_inspected_methods_keep_accept_encoding(
    tmp_path: Path,
    real_flow: Callable[..., http.HTTPFlow],
    headers: Callable[..., http.Headers],
    mitm_ctx,
    fake_firewall_headers,
    method: str,
    rule_method: str,
) -> None:
    reg_path = _model_provider_registry(tmp_path, rule_method=rule_method)
    flow = _request_flow(
        real_flow,
        headers,
        host=_MODEL_PROVIDER_HOST,
        path=_MODEL_PROVIDER_PATH,
        method=method,
        accept_encoding="gzip, zstd, br",
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    assert flow.request.headers[_ACCEPT_ENCODING] == "gzip, zstd, br"
    assert flow.request.headers["Authorization"] == "Bearer x"
    assert metadata_keys.RESPONSE_ENCODING_NEGOTIATION not in flow.metadata


@pytest.mark.parametrize(
    "extra_headers",
    [
        pytest.param(
            (
                ("Connection", "keep-alive, Upgrade"),
                ("Upgrade", "websocket\u2028"),
                ("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ=="),
                ("Sec-WebSocket-Version", "13"),
            ),
            id="invalid-upgrade-value-whitespace",
        ),
        pytest.param(
            (
                ("Connection", "keep-alive, \u2028Upgrade"),
                ("Upgrade", "websocket"),
                ("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ=="),
                ("Sec-WebSocket-Version", "13"),
            ),
            id="invalid-connection-token-whitespace",
        ),
        pytest.param(
            (
                ("Upgrade", "websocket"),
                ("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ=="),
                ("Sec-WebSocket-Version", "13"),
            ),
            id="missing-connection-upgrade-token",
        ),
        pytest.param(
            (
                ("Connection", "keep-alive, Upgrade"),
                ("Upgrade", "websocket"),
                ("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ=="),
                ("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ=="),
                ("Sec-WebSocket-Version", "13"),
            ),
            id="duplicate-websocket-key",
        ),
        pytest.param(
            (
                ("Connection", "keep-alive, Upgrade"),
                ("Upgrade", "websocket"),
                ("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ=="),
                ("Sec-WebSocket-Version", "13"),
                ("Sec-WebSocket-Version", "12"),
            ),
            id="duplicate-websocket-version",
        ),
        pytest.param(
            (
                ("Connection", "keep-alive, Upgrade"),
                ("Upgrade", "websocket"),
                ("Sec-WebSocket-Version", "13"),
            ),
            id="missing-websocket-key",
        ),
        pytest.param(
            (
                ("Connection", "keep-alive, Upgrade"),
                ("Upgrade", "websocket"),
                ("Sec-WebSocket-Key", "   "),
                ("Sec-WebSocket-Version", "13"),
            ),
            id="blank-websocket-key",
        ),
        pytest.param(
            (
                ("Connection", "keep-alive, Upgrade"),
                ("Upgrade", "websocket"),
                ("Sec-WebSocket-Key", "not base64"),
                ("Sec-WebSocket-Version", "13"),
            ),
            id="invalid-websocket-key-base64",
        ),
        pytest.param(
            (
                ("Connection", "keep-alive, Upgrade"),
                ("Upgrade", "websocket"),
                ("Sec-WebSocket-Key", "c2hvcnQ="),
                ("Sec-WebSocket-Version", "13"),
            ),
            id="invalid-websocket-key-length",
        ),
        pytest.param(
            (
                ("Connection", "keep-alive, Upgrade"),
                ("Upgrade", "websocket"),
                ("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ=="),
            ),
            id="missing-websocket-version",
        ),
        pytest.param(
            (
                ("Connection", "keep-alive, Upgrade"),
                ("Upgrade", "websocket"),
                ("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ=="),
                ("Sec-WebSocket-Version", "12"),
            ),
            id="unsupported-websocket-version",
        ),
        pytest.param(
            (
                ("Connection", "Upgrade"),
                ("Upgrade", "x" * (_WEBSOCKET_HEADER_WORK_LIMIT + 1)),
                ("Sec-WebSocket-Key", _WEBSOCKET_KEY),
                ("Sec-WebSocket-Version", "13"),
            ),
            id="upgrade-token-work-limit",
        ),
        pytest.param(
            (
                ("Connection", "Upgrade"),
                ("Upgrade", "websocket"),
                (
                    "Sec-WebSocket-Key",
                    " " * (_WEBSOCKET_HEADER_WORK_LIMIT + 1) + _WEBSOCKET_KEY,
                ),
                ("Sec-WebSocket-Version", "13"),
            ),
            id="websocket-key-raw-work-limit",
        ),
    ],
)
async def test_invalid_websocket_upgrade_normalizes_accept_encoding(
    tmp_path: Path,
    real_flow: Callable[..., http.HTTPFlow],
    headers: Callable[..., http.Headers],
    mitm_ctx,
    fake_firewall_headers,
    extra_headers: tuple[tuple[str, str], ...],
) -> None:
    reg_path = _model_provider_registry(tmp_path, rule_method="GET")
    flow = _request_flow(
        real_flow,
        headers,
        host=_MODEL_PROVIDER_HOST,
        path=_MODEL_PROVIDER_PATH,
        method="GET",
        accept_encoding="gzip, zstd, br",
        extra_headers=extra_headers,
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    assert flow.request.headers[_ACCEPT_ENCODING] == "gzip, br"


async def test_invalid_websocket_upgrade_method_normalizes_accept_encoding(
    tmp_path: Path,
    real_flow: Callable[..., http.HTTPFlow],
    headers: Callable[..., http.Headers],
    mitm_ctx,
    fake_firewall_headers,
) -> None:
    reg_path = _model_provider_registry(tmp_path)
    flow = _request_flow(
        real_flow,
        headers,
        host=_MODEL_PROVIDER_HOST,
        path=_MODEL_PROVIDER_PATH,
        method="POST",
        accept_encoding="gzip, zstd, br",
        extra_headers=(
            ("Connection", "keep-alive, Upgrade"),
            ("Upgrade", "websocket"),
            ("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ=="),
            ("Sec-WebSocket-Version", "13"),
        ),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    assert flow.request.headers[_ACCEPT_ENCODING] == "gzip, br"


@pytest.mark.parametrize("http_version", ["HTTP/1.0", "HTTP/2.0", "HTTP/3"])
async def test_invalid_websocket_upgrade_http_version_normalizes_accept_encoding(
    tmp_path: Path,
    real_flow: Callable[..., http.HTTPFlow],
    headers: Callable[..., http.Headers],
    mitm_ctx,
    fake_firewall_headers,
    http_version: str,
) -> None:
    reg_path = _model_provider_registry(tmp_path, rule_method="GET")
    flow = _request_flow(
        real_flow,
        headers,
        host=_MODEL_PROVIDER_HOST,
        path=_MODEL_PROVIDER_PATH,
        method="GET",
        accept_encoding="gzip, zstd, br",
        extra_headers=(
            ("Connection", "keep-alive, Upgrade"),
            ("Upgrade", "websocket"),
            ("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ=="),
            ("Sec-WebSocket-Version", "13"),
        ),
    )
    flow.request.http_version = http_version

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    assert flow.request.headers[_ACCEPT_ENCODING] == "gzip, br"


def test_oversized_websocket_key_is_rejected_before_base64_decode(monkeypatch) -> None:
    def fail_decode(_value: str, *, validate: bool) -> bytes:
        raise AssertionError(f"oversized key reached Base64 decoder with validate={validate}")

    monkeypatch.setattr(mitm_addon.base64, "b64decode", fail_decode)

    assert not mitm_addon._is_valid_websocket_key(b"A" * 25)


async def test_browser_passthrough_keeps_accept_encoding_for_parser_connector(
    tmp_path: Path,
    real_flow: Callable[..., http.HTTPFlow],
    headers: Callable[..., http.Headers],
    mitm_ctx,
    fake_firewall_headers,
) -> None:
    reg_path = _connector_registry(
        tmp_path,
        firewall_name=_X_FIREWALL_NAME,
        host=_X_HOST,
        path=_X_PATH,
        billable=True,
    )
    flow = _request_flow(
        real_flow,
        headers,
        host=_X_HOST,
        path=_X_PATH,
        method="GET",
        accept_encoding="gzip, zstd, br",
        extra_headers=(("User-Agent", _BROWSER_USER_AGENT),),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.request.headers[_ACCEPT_ENCODING] == "gzip, zstd, br"
    assert metadata_keys.RESPONSE_ENCODING_NEGOTIATION not in flow.metadata
