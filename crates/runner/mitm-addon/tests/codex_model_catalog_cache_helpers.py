"""Shared flow and response builders for Codex model catalog cache tests."""

import json

import brotli  # type: ignore[import-untyped]
from mitmproxy import http
from mitmproxy.test import tutils

import codex_model_catalog_cache as catalog_cache
import flow_metadata_keys as metadata_keys
import http_network_log
import mitm_addon
from tests.flow_helpers import header_map, response_stream

CATALOG_BODY = json.dumps(
    {
        "models": [
            {
                "slug": "gpt-test",
                "display_name": "GPT Test",
            }
        ]
    },
    separators=(",", ":"),
).encode()
CATALOG_ETAG = '"catalog-v1"'


def catalog_flow(
    real_flow,
    *,
    version: str = "0.145.0",
    auth_value: str = "auth-a",
    account: str = "account-a",
    method: str = "GET",
    extra_headers: dict[str, str] | None = None,
) -> http.HTTPFlow:
    request_headers = {
        "Host": "chatgpt.com",
        "Authorization": f"Bearer {auth_value}",
        "ChatGPT-Account-ID": account,
        "Accept-Encoding": "identity",
        "Content-Length": "0",
    }
    if extra_headers is not None:
        request_headers.update(extra_headers)
    flow = real_flow(
        with_response=False,
        host="chatgpt.com",
        method=method,
        path=f"/backend-api/codex/models?client_version={version}",
        request_headers=header_map(request_headers),
    )
    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-catalog-cache"
    flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:codex-oauth-token"
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    original_url = f"https://chatgpt.com/backend-api/codex/models?client_version={version}"
    flow.metadata[metadata_keys.ORIGINAL_URL] = original_url
    http_network_log.set_target(
        flow,
        url=original_url,
        host="chatgpt.com",
        port=flow.request.port,
    )
    return flow


def responses_flow(
    real_flow,
    *,
    auth_value: str = "auth-a",
    account: str = "account-a",
    etag: str = CATALOG_ETAG,
    status: int = 200,
) -> http.HTTPFlow:
    flow = real_flow(
        host="chatgpt.com",
        method="POST",
        path="/backend-api/codex/responses",
        request_headers=header_map(
            {
                "Host": "chatgpt.com",
                "Authorization": f"Bearer {auth_value}",
                "ChatGPT-Account-ID": account,
            }
        ),
        response_headers=header_map(
            {
                "Content-Type": "text/event-stream",
                "x-models-etag": etag,
            }
        ),
        response_status=status,
    )
    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-catalog-cache"
    flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:codex-oauth-token"
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = "https://chatgpt.com/backend-api/codex/responses"
    http_network_log.set_target(
        flow,
        url="https://chatgpt.com/backend-api/codex/responses",
        host="chatgpt.com",
        port=flow.request.port,
    )
    return flow


def catalog_response(
    *,
    body: bytes = CATALOG_BODY,
    etag: str | None = CATALOG_ETAG,
    status: int = 200,
    encoding: str = "identity",
    headers: dict[str, str] | None = None,
) -> http.Response:
    wire_body = brotli.compress(body) if encoding == "br" else body
    response_headers = {
        "Content-Type": "application/json",
        "Content-Length": str(len(wire_body)),
    }
    if encoding != "identity":
        response_headers["Content-Encoding"] = encoding
    if etag is not None:
        response_headers["ETag"] = etag
    if headers is not None:
        response_headers.update(headers)
    return tutils.tresp(
        status_code=status,
        headers=header_map(response_headers),
        content=wire_body,
    )


async def prepare_miss(flow: http.HTTPFlow, *, expected_encoding: str = "identity") -> None:
    await catalog_cache.prepare_request(flow, request_end_stream=True)
    assert flow.response is None
    assert flow.request.headers["Accept-Encoding"] == expected_encoding
    assert "If-None-Match" not in flow.request.headers


async def prepare_prefetch_miss(flow: http.HTTPFlow) -> None:
    flow.request.headers["X-Okou-Codex-Model-Catalog-Prefetch"] = "1"
    catalog_cache.capture_and_strip_prefetch_marker(flow)
    await prepare_miss(flow, expected_encoding="br")


async def finish_response(flow: http.HTTPFlow) -> dict[str, object]:
    assert flow.response is not None
    wire_body = flow.response.raw_content or b""
    mitm_addon.responseheaders(flow)
    if callable(flow.response.stream):
        stream = response_stream(flow)
        split = len(wire_body) // 2
        assert stream(wire_body[:split]) == wire_body[:split]
        assert stream(wire_body[split:]) == wire_body[split:]
    finalization = catalog_cache.finalize_response(flow)
    if finalization is not None:
        await finalization
    telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(flow, telemetry)
    return telemetry


async def install_catalog(
    flow: http.HTTPFlow,
    *,
    body: bytes = CATALOG_BODY,
    etag: str = CATALOG_ETAG,
    encoding: str = "identity",
) -> dict[str, object]:
    if encoding == "br":
        await prepare_prefetch_miss(flow)
    else:
        await prepare_miss(flow)
    flow.response = catalog_response(body=body, etag=etag, encoding=encoding)
    return await finish_response(flow)
