"""Public managed header auth, streamed policy and terminal ownership."""

import asyncio
from unittest.mock import AsyncMock, patch

import pytest
from mitmproxy import http
from mitmproxy.flow import Error

import auth
import flow_metadata_keys as metadata_keys
import managed_openrouter as managed
import managed_upload
import mitm_addon
from tests.firewall_auth_helpers import firewall_auth_response
from tests.managed_openrouter_helpers import (
    PI_ATTRIBUTION_HEADERS,
    authorize_headers,
    model_config,
    payload,
    request,
    sandbox,
)
from tests.request_handler_helpers import _write_registry
from tests.upstream_connection_helpers import mark_connected_tls_upstream, seed_server_binding


@pytest.mark.parametrize("dialect", ["openai-completions", "openai-responses"])
@pytest.mark.parametrize("large", [False, True])
async def test_stream_auth_and_original_bytes_without_raw_body_retention(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, dialect, large
):
    info = sandbox(tmp_path, dialect)
    registry = _write_registry(tmp_path, sandbox_info=info)
    value = payload(dialect)
    value["messages" if dialect == "openai-completions" else "input"][0]["content"] = (
        "x" * 100_000 if large else "x"
    )
    flow = request(real_flow, value, dialect)
    raw, flow.request.raw_content = flow.request.raw_content, None
    flow.request.headers["X-Okou-Connector-Intent"] = "openrouter"
    flow.request.headers["Accept-Encoding"] = "gzip, zstd, br"
    with (
        mitm_ctx(registry_path=str(registry)),
        fake_firewall_headers(headers={"Authorization": "Bearer managed-token"}) as fetch,
    ):
        await authorize_headers(flow)
        fetch.assert_awaited_once()
        assert flow.error is None
        assert callable(flow.request.stream)
        assert "X-Okou-Connector-Intent" not in flow.request.headers
        assert flow.request.headers["Authorization"] == "Bearer managed-token"
        mark_connected_tls_upstream(
            flow,
            sni="openrouter.ai",
            server_address=("openrouter.ai", 443),
            peername=("104.18.32.47", 443),
        )
        assert flow.request.stream(raw) == raw[:-1]
        upload = managed_upload.get(flow)
        assert upload is not None
        assert upload.validator is None
        assert upload.tail == raw[-1:]
        assert flow.request.stream(b"") == raw[-1:]
        await mitm_addon.request(flow)
        assert flow.error is None
        assert flow.response is None
        assert flow.request.raw_content is None
        assert upload.tail == b""
        assert flow.request.headers["Accept-Encoding"] == "gzip, br"
        for key, value in PI_ATTRIBUTION_HEADERS:
            assert flow.request.headers[key] == value
        flow.response = http.Response.make(200, b"{}", {"Content-Type": "application/json"})
        mitm_addon.response(flow)
        assert managed_upload.get(flow) is None


@pytest.mark.parametrize("dialect", ["openai-completions", "openai-responses"])
@pytest.mark.parametrize(
    "override",
    [
        {"model": "@preset/another"},
        {"provider": {}},
        {"preset": "@preset/another"},
    ],
)
async def test_stream_policy_failure_discards_without_capture_or_billing(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, dialect, override
):
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path, dialect))
    flow = request(real_flow, {**payload(dialect), **override}, dialect)
    raw, flow.request.raw_content = flow.request.raw_content, None
    with mitm_ctx(registry_path=str(registry)), fake_firewall_headers() as fetch:
        await authorize_headers(flow)
        fetch.assert_awaited_once()
        assert callable(flow.request.stream)
        assert flow.request.stream(raw) == ()
        assert flow.request.stream(b"later-private-input") == ()
        assert flow.response is None
        assert flow.metadata[metadata_keys.SUPPRESS_REQUEST_BODY_CAPTURE] is True
        assert flow.metadata[metadata_keys.FIREWALL_BILLABLE] is False
        upload = managed_upload.get(flow)
        assert upload is not None
        assert upload.failure is not None
        assert upload.validator is None
        assert upload.tail == b""
        mitm_addon.error(flow)
        assert managed_upload.get(flow) is None


@pytest.mark.parametrize(
    "case", ["policy", "length", "encoding", "header", "transfer", "websocket"]
)
async def test_invalid_headers_terminate_before_credentials_and_buffering(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, case
):
    info, flow = sandbox(tmp_path), request(real_flow)
    if case == "policy":
        info.pop("piModelConfig")
    elif case == "length":
        del flow.request.headers["Content-Length"]
    elif case == "encoding":
        flow.request.headers["Content-Encoding"] = "gzip"
    elif case == "header":
        flow.request.headers["X-OpenRouter-Preset"] = "untrusted"
    elif case == "transfer":
        flow.request.headers["Transfer-Encoding"] = "chunked"
    else:
        flow.request.method = "GET"
        flow.request.headers["Upgrade"] = "websocket"
        flow.request.headers["Connection"] = "upgrade"
    registry = _write_registry(tmp_path, sandbox_info=info)
    flow.request.raw_content = None
    with mitm_ctx(registry_path=str(registry)), fake_firewall_headers() as fetch:
        await authorize_headers(flow)
        await mitm_addon.request(flow)
        fetch.assert_not_called()
    assert flow.error is not None
    assert flow.request.stream is False
    assert managed_upload.get(flow) is None


async def test_preset_change_during_header_auth_rejects_original_request(
    tmp_path, real_flow, mitm_ctx
):
    info = sandbox(tmp_path)
    registry = _write_registry(tmp_path, sandbox_info=info)
    flow = request(real_flow)
    flow.request.raw_content = None

    async def changed(*_args, **_kwargs):
        _write_registry(
            tmp_path, sandbox_info={**info, "piModelConfig": model_config(preset="@preset/new")}
        )
        return firewall_auth_response(headers={"Authorization": "Bearer must-not-appear"})

    with (
        mitm_ctx(registry_path=str(registry)),
        patch.object(auth, "get_firewall_headers", AsyncMock(side_effect=changed)),
    ):
        await authorize_headers(flow)
        assert flow.error is not None
        assert flow.response is None
        assert flow.request.headers["Authorization"] == "Bearer sandbox-placeholder"
        assert managed_upload.get(flow) is None


async def test_header_auth_cancellation_releases_parser(tmp_path, real_flow, mitm_ctx):
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path))
    flow = request(real_flow)
    flow.request.raw_content = None
    with (
        mitm_ctx(registry_path=str(registry)),
        patch.object(auth, "get_firewall_headers", AsyncMock(side_effect=asyncio.CancelledError)),
        pytest.raises(asyncio.CancelledError),
    ):
        await authorize_headers(flow)
    assert managed_upload.get(flow) is None


@pytest.mark.parametrize("ip_target", [False, True])
async def test_existing_binding_still_selects_policy_stream(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, ip_target
):
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path))
    flow = request(real_flow)
    flow.request.raw_content = None
    if ip_target:
        flow.request.host = "203.0.113.10"
        flow.request.headers["Host"] = "openrouter.ai"
        flow.client_conn.sni = "openrouter.ai"
    seed_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        host="openrouter.ai",
        port=443,
        kinds=frozenset(("connector_auth",)),
        original_address=("203.0.113.10", 443),
    )
    flow.server_conn.address = ("openrouter.ai", 443)
    with mitm_ctx(registry_path=str(registry)), fake_firewall_headers() as fetch:
        await authorize_headers(flow)
        fetch.assert_awaited_once()
        assert flow.error is None
        assert callable(flow.request.stream)
        flow.error = Error("client disconnected during upload")
        mitm_addon.error(flow)
        mitm_addon.error(flow)
    assert managed_upload.get(flow) is None


@pytest.mark.parametrize("owner", ["openrouter", "model-provider:claude-code-oauth-token"])
async def test_other_credential_owners_keep_their_own_request_policy(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, owner
):
    info = sandbox(tmp_path)
    info["firewalls"][0]["firewall"]["name"] = owner
    info["networkPolicies"][owner] = info["networkPolicies"].pop(managed.OWNER)
    info.pop("piModelConfig")
    registry = _write_registry(tmp_path, sandbox_info=info)
    flow = request(real_flow, {"model": "user-chosen-model", "provider": {"sort": "price"}})
    with (
        mitm_ctx(registry_path=str(registry)),
        fake_firewall_headers(headers={"Authorization": "Bearer owner-token"}) as fetch,
    ):
        await mitm_addon.request(flow)
        fetch.assert_awaited_once()
        assert flow.response is None
        assert flow.request.headers["Authorization"] == "Bearer owner-token"
        assert flow.metadata[metadata_keys.FIREWALL_NAME] == owner
    assert managed_upload.get(flow) is None
