"""Integration coverage for Codex model catalog cache request and hook lifecycle."""

import asyncio
import json
import urllib.parse
from pathlib import Path
from types import SimpleNamespace
from typing import Literal
from unittest.mock import patch

import pytest
from mitmproxy import connection, http
from mitmproxy.flow import Error

import codex_model_catalog_cache as catalog_cache
import flow_metadata_keys as metadata_keys
import mitm_addon
import request_classification
import upstream_destination_binding
import usage
from tests.codex_model_catalog_cache_helpers import (
    CATALOG_BODY,
    catalog_flow,
    catalog_response,
    finish_response,
    install_catalog,
    prepare_miss,
    prepare_prefetch_miss,
    responses_flow,
)
from tests.flow_helpers import header_map, response_stream
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.pending_helpers import assert_pending
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry
from tests.requestheaders_helpers import await_requestheaders_result
from tests.upstream_connection_helpers import mark_connected_tls_upstream


class _DecodeGuardPrefetchMarker(bytes):
    def decode(self, encoding: str = "utf-8", errors: str = "strict") -> str:
        raise AssertionError("Codex prefetch marker must not be decoded")


class _DecodeGuardAcceptEncoding(bytes):
    def decode(self, encoding: str = "utf-8", errors: str = "strict") -> str:
        raise AssertionError("bypassed Accept-Encoding must not be decoded")


def _set_catalog_query(flow: http.HTTPFlow, raw_query: str) -> None:
    path = f"/backend-api/codex/models?{raw_query}"
    flow.request.path = path
    flow.metadata[metadata_keys.ORIGINAL_URL] = f"https://chatgpt.com{path}"


async def test_request_bypasses_do_not_touch_unrelated_traffic(real_flow):
    conditional = catalog_flow(
        real_flow,
        extra_headers={"If-None-Match": '"guest-etag"'},
    )
    await catalog_cache.prepare_request(conditional, request_end_stream=True)
    assert conditional.response is None
    telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(conditional, telemetry)
    assert telemetry == {
        "model_catalog_cache_status": "model_catalog_bypass",
        "model_catalog_cache_bypass_reason": "request_conditions",
    }
    assert conditional.request.headers["If-None-Match"] == '"guest-etag"'
    assert conditional.request.headers["Accept-Encoding"] == "identity"

    unrelated = responses_flow(real_flow)
    unrelated.response = catalog_response()
    mitm_addon.responseheaders(unrelated)
    assert callable(unrelated.response.stream)


async def test_streaming_catalog_request_bypasses_fresh_cache(real_flow):
    with patch.object(catalog_cache.time, "monotonic", return_value=100.0):
        await install_catalog(catalog_flow(real_flow))
        flow = catalog_flow(real_flow)

        def external_stream(chunk: bytes) -> bytes:
            return chunk

        flow.request.stream = external_stream

        await catalog_cache.prepare_request(flow, request_end_stream=True)

    assert flow.response is None
    assert flow.request.stream is external_stream
    assert flow.request.headers["Accept-Encoding"] == "identity"
    assert "_codex_model_catalog_cache_state" not in flow.metadata
    telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(flow, telemetry)
    assert telemetry == {
        "model_catalog_cache_status": "model_catalog_bypass",
        "model_catalog_cache_bypass_reason": "request_streaming",
    }


async def test_unbounded_request_content_length_is_rejected_without_parsing(real_flow):
    flow = catalog_flow(
        real_flow,
        extra_headers={"Content-Length": "9" * 5000},
    )

    await catalog_cache.prepare_request(flow, request_end_stream=True)

    telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(flow, telemetry)
    assert telemetry == {
        "model_catalog_cache_status": "model_catalog_bypass",
        "model_catalog_cache_bypass_reason": "request_framing",
    }
    assert flow.request.headers["Accept-Encoding"] == "identity"


@pytest.mark.parametrize("content_length", ["\v0", "\f0"], ids=["vertical-tab", "form-feed"])
async def test_non_ows_request_content_length_bypasses_catalog_cache(
    real_flow,
    content_length: str,
):
    flow = catalog_flow(
        real_flow,
        extra_headers={"Content-Length": content_length},
    )

    await catalog_cache.prepare_request(flow, request_end_stream=True)

    telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(flow, telemetry)
    assert telemetry == {
        "model_catalog_cache_status": "model_catalog_bypass",
        "model_catalog_cache_bypass_reason": "request_framing",
    }
    assert flow.request.headers["Accept-Encoding"] == "identity"


@pytest.mark.parametrize(
    ("method", "request_end_stream", "body", "remove_account", "original_url", "reason"),
    [
        pytest.param("POST", True, b"", False, None, "request_method", id="method"),
        pytest.param("GET", False, b"", False, None, "request_framing", id="open-stream"),
        pytest.param("GET", True, b"x", False, None, "request_body", id="body"),
        pytest.param("GET", True, b"", True, None, "request_identity", id="identity"),
        pytest.param(
            "GET",
            True,
            b"",
            False,
            "https://chatgpt.com/backend-api/codex/models?client_version=0.145.0&extra=1",
            "request_url",
            id="query",
        ),
        pytest.param(
            "GET",
            True,
            b"",
            False,
            "https://chatgpt.com/backend-api/codex/models?invalid\udcff=1",
            "request_url",
            id="surrogate-escaped-query",
        ),
    ],
)
async def test_unsafe_catalog_requests_never_enter_cache(
    real_flow,
    method: str,
    request_end_stream: bool,
    body: bytes,
    remove_account: bool,
    original_url: str | None,
    reason: str,
):
    flow = catalog_flow(real_flow, method=method)
    if body:
        flow.request.raw_content = body
        flow.request.headers["Content-Length"] = str(len(body))
    if remove_account:
        del flow.request.headers["ChatGPT-Account-ID"]
    if original_url is not None:
        flow.metadata[metadata_keys.ORIGINAL_URL] = original_url

    await catalog_cache.prepare_request(flow, request_end_stream=request_end_stream)

    assert flow.response is None
    assert flow.request.headers["Accept-Encoding"] == "identity"
    telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(flow, telemetry)
    assert telemetry == {
        "model_catalog_cache_status": "model_catalog_bypass",
        "model_catalog_cache_bypass_reason": reason,
    }


async def test_fully_percent_encoded_maximum_catalog_query_reuses_canonical_cache(real_flow):
    encoded_name = "".join(f"%{byte:02X}" for byte in b"client_version")
    raw_query = f"{encoded_name}={'%61' * 128}"
    assert len(raw_query.encode()) == catalog_cache.MAX_CATALOG_QUERY_BYTES

    encoded_flow = catalog_flow(real_flow, version="a" * 128)
    _set_catalog_query(encoded_flow, raw_query)
    await install_catalog(encoded_flow)
    catalog_cache.release_flow_state(encoded_flow)

    canonical_flow = catalog_flow(real_flow, version="a" * 128)
    await catalog_cache.prepare_request(canonical_flow, request_end_stream=True)

    assert canonical_flow.response is not None
    assert canonical_flow.response.content == CATALOG_BODY


@pytest.mark.parametrize(
    "raw_query",
    [
        pytest.param("client_version=%FF", id="invalid-value-ff"),
        pytest.param("client_version=%FE", id="invalid-value-fe"),
        pytest.param("client_version=bad\udcff", id="surrogate-value"),
        pytest.param("%FF=0.145.0", id="invalid-name"),
    ],
)
async def test_invalid_utf8_catalog_query_never_reuses_or_populates_cache(
    real_flow,
    raw_query: str,
):
    valid_flow = catalog_flow(real_flow, version="\ufffd")
    await install_catalog(valid_flow)
    catalog_cache.release_flow_state(valid_flow)

    invalid_flow = catalog_flow(real_flow)
    _set_catalog_query(invalid_flow, raw_query)

    await catalog_cache.prepare_request(invalid_flow, request_end_stream=True)

    assert invalid_flow.response is None
    telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(invalid_flow, telemetry)
    assert telemetry == {
        "model_catalog_cache_status": "model_catalog_bypass",
        "model_catalog_cache_bypass_reason": "request_url",
    }

    invalid_flow.response = catalog_response(body=b'{"models":[{"slug":"invalid"}]}')
    assert await finish_response(invalid_flow) == telemetry

    valid_hit = catalog_flow(real_flow, version="\ufffd")
    await catalog_cache.prepare_request(valid_hit, request_end_stream=True)

    assert valid_hit.response is not None
    assert valid_hit.response.content == CATALOG_BODY


@pytest.mark.parametrize(
    ("raw_query", "character_bounded"),
    [
        pytest.param(
            "client_version="
            + "a" * (catalog_cache.MAX_CATALOG_QUERY_BYTES - len("client_version=") + 1),
            False,
            id="characters",
        ),
        pytest.param(
            "client_version="
            + "é" * ((catalog_cache.MAX_CATALOG_QUERY_BYTES - len("client_version=")) // 2 + 1),
            True,
            id="utf8-bytes",
        ),
    ],
)
async def test_oversized_catalog_query_bypasses_before_pair_parsing(
    real_flow,
    raw_query: str,
    character_bounded: bool,
):
    assert (len(raw_query) <= catalog_cache.MAX_CATALOG_QUERY_BYTES) is character_bounded
    assert len(raw_query.encode()) > catalog_cache.MAX_CATALOG_QUERY_BYTES
    flow = catalog_flow(real_flow)
    _set_catalog_query(flow, raw_query)

    with patch.object(
        urllib.parse,
        "parse_qsl",
        side_effect=AssertionError("oversized catalog query must not be parsed"),
    ):
        await catalog_cache.prepare_request(flow, request_end_stream=True)

    assert flow.response is None
    assert flow.request.path == f"/backend-api/codex/models?{raw_query}"
    telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(flow, telemetry)
    assert telemetry == {
        "model_catalog_cache_status": "model_catalog_bypass",
        "model_catalog_cache_bypass_reason": "request_url",
    }


async def test_high_cardinality_catalog_query_bypasses_before_percent_decoding(real_flow):
    raw_query = "&".join(["x="] * 64)
    assert len(raw_query.encode()) <= catalog_cache.MAX_CATALOG_QUERY_BYTES
    flow = catalog_flow(real_flow)
    _set_catalog_query(flow, raw_query)
    real_parse_qsl = urllib.parse.parse_qsl

    with (
        patch.object(urllib.parse, "parse_qsl", wraps=real_parse_qsl) as parse_qsl,
        patch.object(
            urllib.parse,
            "unquote_plus",
            side_effect=AssertionError("over-cardinality catalog query must not be decoded"),
        ),
    ):
        await catalog_cache.prepare_request(flow, request_end_stream=True)

    parse_qsl.assert_called_once_with(
        raw_query,
        keep_blank_values=True,
        strict_parsing=True,
        encoding="utf-8",
        errors="strict",
        max_num_fields=catalog_cache.MAX_CATALOG_QUERY_FIELDS,
    )
    assert flow.response is None
    assert flow.request.path == f"/backend-api/codex/models?{raw_query}"
    telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(flow, telemetry)
    assert telemetry == {
        "model_catalog_cache_status": "model_catalog_bypass",
        "model_catalog_cache_bypass_reason": "request_url",
    }


@pytest.mark.parametrize(
    ("raw_values", "eligible"),
    [
        pytest.param((), True, id="absent"),
        pytest.param((b"identity",), True, id="identity"),
        pytest.param((b" \tIdEnTiTy\t ",), True, id="case-and-whitespace"),
        pytest.param((b"\xc2\xa0identity\xe2\x80\xa8",), True, id="unicode-whitespace"),
        pytest.param((b"",), False, id="empty"),
        pytest.param((b" \t",), False, id="whitespace"),
        pytest.param((b", ,",), False, id="empty-items"),
        pytest.param((b"", b""), False, id="repeated-empty"),
        pytest.param((b", identity, ,",), True, id="identity-with-empty-items"),
        pytest.param((b"", b"identity", b" , "), True, id="identity-in-repeated-fields"),
        pytest.param((b"identity, identity",), False, id="duplicate-identity-items"),
        pytest.param((b"identity", b"identity"), False, id="duplicate-identity-fields"),
        pytest.param((b"gzip",), False, id="encoded"),
        pytest.param((b"identity, br",), False, id="mixed-encodings"),
        pytest.param((b"identity;q=1",), False, id="parameterized-identity"),
        pytest.param((b"*;q=0",), False, id="wildcard"),
        pytest.param((b"\xffidentity",), False, id="invalid-utf8"),
        pytest.param((b" " * (64 * 1024 - 8) + b"identity",), True, id="exact-budget"),
        pytest.param(
            (b"," * (64 * 1024 - 8) + b"identity",), True, id="many-empty-items-at-budget"
        ),
        pytest.param(
            (b" " * (32 * 1024), b" " * (32 * 1024 - 8) + b"identity"),
            True,
            id="aggregate-exact-budget",
        ),
        pytest.param((b" " * (64 * 1024 - 7) + b"identity",), False, id="first-over-budget"),
    ],
)
async def test_accept_encoding_controls_fresh_catalog_reuse(real_flow, raw_values, eligible):
    await install_catalog(catalog_flow(real_flow))
    flow = catalog_flow(real_flow)
    flow.request.headers.set_all("Accept-Encoding", [])
    flow.request.headers.fields += tuple((b"aCcEpT-EnCoDiNg", value) for value in raw_values)
    original_fields = flow.request.headers.fields

    await catalog_cache.prepare_request(flow, request_end_stream=True)

    assert flow.request.headers.fields == original_fields
    if eligible:
        assert flow.response is not None
        assert flow.response.content == CATALOG_BODY
    else:
        assert flow.response is None
        telemetry: dict[str, object] = {}
        catalog_cache.add_network_log_fields(flow, telemetry)
        assert telemetry == {
            "model_catalog_cache_status": "model_catalog_bypass",
            "model_catalog_cache_bypass_reason": "request_encoding",
        }


async def test_accept_encoding_budget_excludes_unrelated_values(real_flow):
    await install_catalog(catalog_flow(real_flow))
    flow = catalog_flow(real_flow)
    flow.request.headers.fields += ((b"X-Unrelated", b"x" * (64 * 1024 + 1)),)
    original_fields = flow.request.headers.fields

    await catalog_cache.prepare_request(flow, request_end_stream=True)

    assert flow.request.headers.fields == original_fields
    assert flow.response is not None
    assert flow.response.content == CATALOG_BODY


@pytest.mark.parametrize("leading_value", [b"gzip", b"identity,identity"])
async def test_accept_encoding_bypass_stops_before_decoding_later_fields(real_flow, leading_value):
    flow = catalog_flow(real_flow)
    flow.request.headers.set_all("Accept-Encoding", [])
    flow.request.headers.fields += (
        (b"Accept-Encoding", leading_value),
        (b"accept-encoding", _DecodeGuardAcceptEncoding(b"identity")),
    )
    original_fields = flow.request.headers.fields

    await catalog_cache.prepare_request(flow, request_end_stream=True)

    assert flow.response is None
    assert flow.request.headers.fields == original_fields
    telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(flow, telemetry)
    assert telemetry == {
        "model_catalog_cache_status": "model_catalog_bypass",
        "model_catalog_cache_bypass_reason": "request_encoding",
    }


@pytest.mark.parametrize("entry_point", ["request", "requestheaders"])
@pytest.mark.parametrize("billable", [False, True], ids=["non-billable", "billable"])
@pytest.mark.parametrize("repeated", [False, True], ids=["single-field", "aggregate-overflow"])
async def test_over_budget_accept_encoding_bypasses_catalog_without_decoding(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    entry_point: Literal["request", "requestheaders"],
    billable: bool,
    repeated: bool,
):
    if repeated:
        encoding_fields = (
            (b"Accept-Encoding", _DecodeGuardAcceptEncoding(b" " * (32 * 1024))),
            (b"accept-encoding", _DecodeGuardAcceptEncoding(b" " * (32 * 1024 - 7) + b"identity")),
        )
    else:
        encoding_fields = (
            (b"aCcEpT-EnCoDiNg", _DecodeGuardAcceptEncoding(b"gzip," * (64 * 1024 // 5) + b"br")),
        )
    registry_path = _write_codex_registry(
        tmp_path, capture=entry_point == "requestheaders", billable=billable
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="chatgpt.com",
        method="GET",
        path="/backend-api/codex/models?client_version=0.145.0",
        request_headers=http.Headers(((b"Host", b"chatgpt.com"), *encoding_fields)),
    )
    flow.metadata["_request_end_stream"] = True
    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(
            headers={
                "Authorization": "Bearer resolved-token",
                "ChatGPT-Account-ID": "resolved-account",
            }
        ),
    ):
        if entry_point == "requestheaders":
            await await_requestheaders_result(mitm_addon.requestheaders(flow))
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.request.headers["Authorization"] == "Bearer resolved-token"
    assert (
        tuple(
            (name, value)
            for name, value in flow.request.headers.fields
            if name.lower() == b"accept-encoding"
        )
        == encoding_fields
    )
    if billable:
        assert flow.metadata[metadata_keys.RESPONSE_ENCODING_NEGOTIATION] == "preserved_work_budget"
    telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(flow, telemetry)
    assert telemetry == {
        "model_catalog_cache_status": "model_catalog_bypass",
        "model_catalog_cache_bypass_reason": "request_encoding",
    }


def _write_codex_registry(tmp_path: Path, *, capture: bool, billable: bool = False) -> Path:
    firewall_name = "model-provider:codex-oauth-token"
    return _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            run_id="run-catalog-cache",
            firewall_name=firewall_name,
            api_entry={
                "base": "https://chatgpt.com/backend-api/codex",
                "auth": {
                    "headers": {
                        "Authorization": "Bearer ${{ secrets.CHATGPT_ACCESS_TOKEN }}",
                        "ChatGPT-Account-ID": "${{ secrets.CHATGPT_ACCOUNT_ID }}",
                    }
                },
                "permissions": [
                    {
                        "name": "codex:api",
                        "rules": ["GET /{path*}", "POST /{path*}"],
                    }
                ],
            },
            network_policy={
                "allow": ["codex:api"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
            billable_firewalls=[firewall_name] if billable else None,
            sandbox_fields={
                "captureNetworkBodies": capture,
                "cliAgentType": "codex",
            },
        ),
    )


async def test_both_firewall_auth_paths_prepare_catalog_cache(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
):
    resolved_headers = {
        "Authorization": "Bearer resolved-token",
        "ChatGPT-Account-ID": "resolved-account",
    }

    request_registry = _write_codex_registry(tmp_path, capture=False)
    request_flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="chatgpt.com",
        method="GET",
        path="/backend-api/codex/models?client_version=0.145.0",
        request_headers=header_map(
            {
                "Host": "chatgpt.com",
                "Accept-Encoding": "identity",
                "Content-Length": "0",
                "X-Okou-Codex-Model-Catalog-Prefetch": "1",
            }
        ),
    )
    with (
        mitm_ctx(registry_path=str(request_registry), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers=resolved_headers),
    ):
        await mitm_addon.request(request_flow)
    assert request_flow.request.headers["Accept-Encoding"] == "br"
    assert "X-Okou-Codex-Model-Catalog-Prefetch" not in request_flow.request.headers
    request_flow.response = catalog_response(encoding="br")
    request_telemetry = await finish_response(request_flow)
    assert request_telemetry["model_catalog_prefetch_role"] == "producer"

    header_registry = _write_codex_registry(tmp_path, capture=True)
    header_flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="chatgpt.com",
        method="GET",
        path="/backend-api/codex/models?client_version=0.145.0",
        request_headers=header_map(
            {
                "Host": "chatgpt.com",
                "Accept-Encoding": "identity",
                "X-Okou-Codex-Model-Catalog-Prefetch": "1",
            }
        ),
    )
    header_flow.metadata["_request_end_stream"] = True
    with (
        mitm_ctx(registry_path=str(header_registry), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers=resolved_headers),
    ):
        requestheaders_result = mitm_addon.requestheaders(header_flow)
        await await_requestheaders_result(requestheaders_result)

    assert header_flow.response is not None
    assert header_flow.response.status_code == 200
    assert header_flow.response.content == CATALOG_BODY
    assert header_flow.response.stream is False
    assert "X-Okou-Codex-Model-Catalog-Prefetch" not in header_flow.request.headers


@pytest.mark.parametrize(
    ("marker_values", "expected_prefetch"),
    [
        pytest.param((_DecodeGuardPrefetchMarker(b"1"),), True, id="exact"),
        pytest.param(
            (
                _DecodeGuardPrefetchMarker(b"1"),
                _DecodeGuardPrefetchMarker(b"1"),
            ),
            False,
            id="repeated",
        ),
        pytest.param((_DecodeGuardPrefetchMarker(b""),), False, id="empty"),
        pytest.param((_DecodeGuardPrefetchMarker(b"\xff"),), False, id="non-ascii"),
        pytest.param(
            (_DecodeGuardPrefetchMarker(b"x" * (1024 * 1024)),),
            False,
            id="oversized",
        ),
    ],
)
async def test_prefetch_marker_requires_one_exact_raw_value_across_request_hooks(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    marker_values: tuple[bytes, ...],
    expected_prefetch: bool,
):
    registry_path = _write_codex_registry(tmp_path, capture=False)
    request_headers = http.Headers(
        [
            (b"Host", b"chatgpt.com"),
            (b"Accept-Encoding", b"identity"),
            (b"Content-Length", b"0"),
            *((b"x-Okou-Codex-Model-Catalog-Prefetch", value) for value in marker_values),
        ]
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="chatgpt.com",
        method="GET",
        path="/backend-api/codex/models?client_version=0.145.0",
        request_headers=request_headers,
    )
    flow.metadata["_request_end_stream"] = True

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(
            headers={
                "Authorization": "Bearer resolved-token",
                "ChatGPT-Account-ID": "resolved-account",
            }
        ),
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        assert requestheaders_result is None
        assert all(
            name.lower() != b"x-okou-codex-model-catalog-prefetch"
            for name, _ in flow.request.headers.fields
        )
        assert (
            flow.metadata.get("_codex_model_catalog_prefetch_request") is True
        ) is expected_prefetch

        await mitm_addon.request(flow)

    assert all(
        name.lower() != b"x-okou-codex-model-catalog-prefetch"
        for name, _ in flow.request.headers.fields
    )
    assert (flow.metadata.get("_codex_model_catalog_prefetch_request") is True) is expected_prefetch
    assert flow.request.headers["Accept-Encoding"] == ("br" if expected_prefetch else "identity")
    catalog_cache.release_flow_state(flow)


@pytest.mark.parametrize("entry_point", ["request", "requestheaders"])
@pytest.mark.parametrize("owner_result", ["failure", "timeout", "local-response"])
async def test_catalog_wait_revalidates_only_provider_continuation(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    monkeypatch: pytest.MonkeyPatch,
    entry_point: Literal["request", "requestheaders"],
    owner_result: Literal["failure", "timeout", "local-response"],
):
    if owner_result == "timeout":
        monkeypatch.setattr(catalog_cache, "MAX_IN_FLIGHT_WAIT_SECONDS", 0.1)

    resolved_headers = {
        "Authorization": "Bearer resolved-token",
        "ChatGPT-Account-ID": "resolved-account",
    }
    owner = catalog_flow(
        real_flow,
        auth_value="resolved-token",
        account="resolved-account",
    )
    await prepare_miss(owner)

    registry_path = _write_codex_registry(
        tmp_path,
        capture=entry_point == "requestheaders",
        billable=True,
    )
    follower_headers = {
        "Host": "chatgpt.com",
        "Accept-Encoding": "identity",
    }
    if entry_point == "request":
        follower_headers["Content-Length"] = "0"
    follower = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="chatgpt.com",
        method="GET",
        path="/backend-api/codex/models?client_version=0.145.0",
        request_headers=header_map(follower_headers),
    )
    follower.metadata["_request_end_stream"] = True
    mark_connected_tls_upstream(
        follower,
        sni="chatgpt.com",
        server_address=("203.0.113.10", 443),
        peername=("203.0.113.10", 443),
    )

    follower_task: asyncio.Task[None] | None = None
    try:
        with (
            mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
            fake_firewall_headers(headers=resolved_headers),
        ):
            if entry_point == "request":
                follower_task = asyncio.create_task(mitm_addon.request(follower))
            else:
                follower_task = asyncio.create_task(
                    await_requestheaders_result(mitm_addon.requestheaders(follower))
                )

            await asyncio.sleep(0)
            assert not follower_task.done()
            assert follower.request.headers["Authorization"] == "Bearer resolved-token"
            assert follower.request.headers["ChatGPT-Account-ID"] == "resolved-account"
            assert follower.metadata["_usage_flow_tracked"] is True
            assert (
                follower.server_conn.id in upstream_destination_binding.binding_snapshot_for_tests()
            )

            follower.server_conn.state = connection.ConnectionState.CLOSED
            mitm_addon.server_disconnected(SimpleNamespace(server=follower.server_conn))
            assert (
                follower.server_conn.id
                not in upstream_destination_binding.binding_snapshot_for_tests()
            )

            if owner_result == "failure":
                owner.error = Error("upstream reset")
                catalog_cache.handle_error(owner)
            elif owner_result == "local-response":
                owner.response = catalog_response()
                await finish_response(owner)

            await follower_task
            if entry_point == "requestheaders":
                await mitm_addon.request(follower)

            assert follower.response is not None
            if owner_result != "local-response":
                assert follower.response.status_code == 403
                assert (
                    follower.metadata[metadata_keys.FIREWALL_ERROR]
                    == "upstream_destination_unbound"
                )
                assert metadata_keys.REQUEST_STREAM_BUFFER not in follower.metadata
                assert metadata_keys.REQUEST_STREAM_BUFFER_STATE not in follower.metadata
            else:
                assert follower.response.status_code == 200
                assert follower.response.content == CATALOG_BODY
                assert follower.metadata.get(metadata_keys.FIREWALL_ERROR) is None

            mitm_addon.responseheaders(follower)
            mitm_addon.response(follower)
    finally:
        if follower_task is not None:
            if not follower_task.done():
                follower_task.cancel()
            _ = await asyncio.gather(follower_task, return_exceptions=True)
        catalog_cache.handle_error(owner)
        if follower.metadata.get("_usage_flow_tracked"):
            mitm_addon.response(follower)

    assert "_usage_flow_tracked" not in follower.metadata
    assert "_codex_model_catalog_cache_state" not in follower.metadata
    assert "_codex_model_catalog_cache_telemetry" not in follower.metadata
    assert mitm_addon._FIREWALL_AUTH_APPLIED_IN_REQUESTHEADERS not in follower.metadata
    assert metadata_keys.REQUEST_STREAM_BUFFER not in follower.metadata
    assert metadata_keys.REQUEST_STREAM_BUFFER_STATE not in follower.metadata


async def test_cancelled_requestheaders_catalog_follower_releases_usage_tracking(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
):
    pending_path = tmp_path / "usage-pending"
    usage.set_pending_path(str(pending_path), usage_state_id="test-usage-state-id")
    resolved_headers = {
        "Authorization": "Bearer resolved-token",
        "ChatGPT-Account-ID": "resolved-account",
    }
    owner = catalog_flow(
        real_flow,
        auth_value="resolved-token",
        account="resolved-account",
    )
    await prepare_miss(owner)

    registry_path = _write_codex_registry(tmp_path, capture=True, billable=True)
    follower = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="chatgpt.com",
        method="GET",
        path="/backend-api/codex/models?client_version=0.145.0",
        request_headers=header_map(
            {
                "Host": "chatgpt.com",
                "Accept-Encoding": "identity",
            }
        ),
    )
    follower.metadata["_request_end_stream"] = True
    follower_task: asyncio.Task[None] | None = None
    try:
        with (
            mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
            fake_firewall_headers(headers=resolved_headers),
        ):
            follower_task = asyncio.create_task(
                await_requestheaders_result(mitm_addon.requestheaders(follower))
            )
            await asyncio.sleep(0)
            assert not follower_task.done()

            follower_task.cancel()
            (cancelled_result,) = await asyncio.gather(follower_task, return_exceptions=True)
            assert isinstance(cancelled_result, asyncio.CancelledError)
    finally:
        if follower_task is not None and not follower_task.done():
            follower_task.cancel()
            _ = await asyncio.gather(follower_task, return_exceptions=True)
        catalog_cache.handle_error(owner)

    usage.write_pending_snapshot(flush_request_id="after-cancel")
    assert_pending(
        pending_path,
        flows=0,
        buffered=0,
        reports=0,
        flush_request_id="after-cancel",
    )
    assert "_usage_flow_tracked" not in follower.metadata
    assert request_classification.REQUEST_CLASSIFICATION_METADATA_KEY not in follower.metadata
    assert mitm_addon._FIREWALL_AUTH_APPLIED_IN_REQUESTHEADERS not in follower.metadata
    assert metadata_keys.HTTP_REQUEST_START_MONOTONIC not in follower.metadata
    assert metadata_keys.REQUEST_STREAM_BUFFER not in follower.metadata
    assert metadata_keys.REQUEST_STREAM_BUFFER_STATE not in follower.metadata


async def test_network_log_contains_bounded_encoding_telemetry_and_cleanup(
    tmp_path,
    real_flow,
    mitm_ctx,
):
    flow = catalog_flow(
        real_flow,
        auth_value="sensitive-auth",
        account="sensitive-account",
    )
    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = str(tmp_path / "network.jsonl")
    await prepare_prefetch_miss(flow)
    flow.response = catalog_response(encoding="br")
    mitm_addon.responseheaders(flow)
    compressed_body = flow.response.raw_content or b""
    assert response_stream(flow)(compressed_body) == compressed_body

    with mitm_ctx():
        continuation = mitm_addon.response(flow)
        assert continuation is not None
        await continuation

    [entry] = read_jsonl_entries_after_flush(tmp_path / "network.jsonl")
    assert entry["model_catalog_cache_status"] == "model_catalog_cold_stored"
    assert entry["model_catalog_cache_upstream_encoding"] == "br"
    assert entry["model_catalog_prefetch_role"] == "producer"
    assert entry["model_catalog_cache_validation_latency_ms"] >= 0
    assert entry["response_size"] == len(compressed_body)
    serialized = json.dumps(entry)
    assert "sensitive-auth" not in serialized
    assert "sensitive-account" not in serialized
    assert "catalog-v1" not in serialized
    assert "gpt-test" not in serialized
    assert "_codex_model_catalog_cache_state" not in flow.metadata
    assert "_codex_model_catalog_cache_telemetry" not in flow.metadata
    assert "_codex_model_catalog_prefetch_request" not in flow.metadata
    assert flow.response is not None
    assert flow.response.status_code == 200
    assert flow.response.raw_content == compressed_body
    assert flow.response.headers["Content-Encoding"] == "br"
    assert flow.response.stream is False
