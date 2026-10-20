"""Public header authorization, streaming policy and terminal cleanup."""

import asyncio
from unittest.mock import AsyncMock, patch

import pytest
from mitmproxy import http
from mitmproxy.flow import Error

import auth
import flow_metadata_keys as metadata_keys
import managed_openrouter as managed
import mitm_addon
from tests.firewall_auth_helpers import firewall_auth_response
from tests.managed_openrouter_helpers import (
    PI_ATTRIBUTION_HEADERS,
    model_config,
    payload,
    prepare_request_headers,
    request,
    sandbox,
)
from tests.request_handler_helpers import _write_registry
from tests.upstream_connection_helpers import mark_connected_tls_upstream, seed_server_binding


@pytest.mark.parametrize("dialect", ["openai-completions", "openai-responses"])
@pytest.mark.parametrize("large", [False, True])
async def test_header_auth_and_public_stream_preserve_the_complete_body(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, dialect, large
):
    info = sandbox(tmp_path, dialect)
    path = _write_registry(tmp_path, sandbox_info=info)
    body = payload(dialect)
    body["messages" if dialect == "openai-completions" else "input"][0]["content"] = "x" * (
        100_000 if large else 1
    )
    flow = request(real_flow, body, dialect)
    raw = flow.request.raw_content
    flow.request.raw_content = None
    flow.request.headers["X-Okou-Connector-Intent"] = "openrouter"
    flow.request.headers["Accept-Encoding"] = "gzip, zstd, br"
    with (
        mitm_ctx(registry_path=str(path)),
        fake_firewall_headers(headers={"Authorization": "Bearer managed-token"}) as auth_fetch,
    ):
        await prepare_request_headers(flow)
        auth_fetch.assert_awaited_once()
        assert flow.error is None
        assert callable(flow.request.stream)
        assert "X-Okou-Connector-Intent" not in flow.request.headers
        mark_connected_tls_upstream(
            flow,
            sni="openrouter.ai",
            server_address=("openrouter.ai", 443),
            peername=("104.18.32.47", 443),
        )
        first = flow.request.stream(raw)
        last = flow.request.stream(b"")
        assert isinstance(first, bytes)
        assert isinstance(last, bytes)
        forwarded = first + last
        assert forwarded == raw
        await mitm_addon.request(flow)
        assert flow.response is None
        assert flow.request.raw_content is None
        assert flow.request.headers["Authorization"] == "Bearer managed-token"
        assert flow.request.headers["Accept-Encoding"] == "gzip, br"
        for name, value in PI_ATTRIBUTION_HEADERS:
            assert flow.request.headers[name] == value
        assert managed.admission_state_for_tests() == (0, 0)
        flow.response = http.Response.make(200, b"{}", {"Content-Type": "application/json"})
        mitm_addon.response(flow)
    assert managed.admission_state_for_tests() == (0, 0)


@pytest.mark.parametrize("dialect", ["openai-completions", "openai-responses"])
@pytest.mark.parametrize(
    "override", [{"model": "@preset/another"}, {"provider": {}}, {"preset": "@preset/another"}]
)
async def test_invalid_stream_aborts_after_accepted_header_auth(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, dialect, override
):
    path = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path, dialect))
    body = {**payload(dialect), **override}
    flow = request(real_flow, body, dialect)
    with (
        mitm_ctx(registry_path=str(path)),
        fake_firewall_headers(headers={"Authorization": "Bearer must-not-appear"}) as auth_fetch,
    ):
        raw, flow.request.raw_content = flow.request.raw_content, None
        await prepare_request_headers(flow)
        auth_fetch.assert_awaited_once()
        assert callable(flow.request.stream)
        assert flow.request.stream(raw) == b""
        assert flow.error is not None
        assert flow.response is None
        assert flow.metadata[metadata_keys.SUPPRESS_REQUEST_BODY_CAPTURE] is True
        mitm_addon.error(flow)
    assert managed.admission_state_for_tests() == (0, 0)


@pytest.mark.parametrize(
    "case", ["policy", "length", "encoding", "header", "transfer", "websocket"]
)
async def test_header_phase_fails_closed_without_auth_or_body_retention(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, case
):
    info = sandbox(tmp_path)
    flow = request(real_flow)
    if case == "policy":
        info.pop("piModelConfig")
    elif case == "length":
        del flow.request.headers["Content-Length"]
    elif case == "encoding":
        flow.request.headers["Content-Encoding"] = "gzip"
    elif case == "header":
        flow.request.headers["x-OPENROUTER-preset"] = "untrusted"
    elif case == "transfer":
        flow.request.headers["Transfer-Encoding"] = "chunked"
    else:
        flow.request.method = "GET"
        flow.request.headers["Upgrade"] = "websocket"
        flow.request.headers["Connection"] = "upgrade"
    path = _write_registry(tmp_path, sandbox_info=info)
    flow.request.raw_content = None
    with mitm_ctx(registry_path=str(path)), fake_firewall_headers() as auth_fetch:
        assert mitm_addon.requestheaders(flow) is None
        await mitm_addon.request(flow)
    assert flow.error is not None
    assert flow.request.stream is False
    auth_fetch.assert_not_called()
    assert managed.admission_state_for_tests() == (0, 0)


async def test_changed_captured_preset_during_auth_cannot_authorize_an_old_request(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers
):
    info = sandbox(tmp_path)
    path = _write_registry(tmp_path, sandbox_info=info)
    flow = request(real_flow)

    async def resolve(*_args, **_kwargs):
        replacement = {**info, "piModelConfig": model_config(preset="@preset/new")}
        _write_registry(tmp_path, sandbox_info=replacement)
        return firewall_auth_response(headers={"Authorization": "Bearer must-not-appear"})

    with (
        mitm_ctx(registry_path=str(path)),
        patch.object(auth, "get_firewall_headers", AsyncMock(side_effect=resolve)),
    ):
        flow.request.raw_content = None
        await prepare_request_headers(flow)
        assert flow.error is not None
        assert flow.response is None
        assert flow.request.headers["Authorization"] == "Bearer sandbox-placeholder"
        mitm_addon.error(flow)
    assert managed.admission_state_for_tests() == (0, 0)


async def test_cancelled_header_auth_releases_the_validator(tmp_path, real_flow, mitm_ctx):
    path = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path))
    flow = request(real_flow)
    with (
        mitm_ctx(registry_path=str(path)),
        patch.object(auth, "get_firewall_headers", AsyncMock(side_effect=asyncio.CancelledError)),
    ):
        flow.request.raw_content = None
        with pytest.raises(asyncio.CancelledError):
            await prepare_request_headers(flow)
    assert managed.admission_state_for_tests() == (0, 0)


@pytest.mark.parametrize("ip_target", [False, True])
async def test_existing_upstream_binding_cannot_skip_managed_body_admission(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, ip_target
):
    path = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path))
    flow = request(real_flow)
    length = len(flow.request.raw_content)
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
    with mitm_ctx(registry_path=str(path)), fake_firewall_headers() as auth_fetch:
        await prepare_request_headers(flow)
        assert flow.error is None
        assert callable(flow.request.stream)
        assert managed.admission_state_for_tests() == (1, length)
        auth_fetch.assert_awaited_once()
        flow.error = Error("client disconnected during body")
        mitm_addon.error(flow)
    assert managed.admission_state_for_tests() == (0, 0)


async def test_partial_body_error_releases_validation_ownership(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers
):
    path = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path))
    first, second, replacement = (request(real_flow) for _ in range(3))
    length = len(first.request.raw_content)
    for flow in (first, second, replacement):
        flow.request.raw_content = None
    with mitm_ctx(registry_path=str(path)), fake_firewall_headers() as auth_fetch:
        await prepare_request_headers(first)
        assert managed.admission_state_for_tests() == (1, length)
        await prepare_request_headers(second)
        assert second.error is None
        assert managed.admission_state_for_tests() == (2, 2 * length)
        first.error = Error("client disconnected during body")
        mitm_addon.error(first)
        mitm_addon.error(first)
        assert managed.admission_state_for_tests() == (1, length)
        mitm_addon.error(second)
        await prepare_request_headers(replacement)
        assert replacement.error is None
        mitm_addon.error(replacement)
        assert auth_fetch.await_count == 3
    assert managed.admission_state_for_tests() == (0, 0)


@pytest.mark.parametrize("owner", ["openrouter", "model-provider:claude-code-oauth-token"])
async def test_other_credential_owners_keep_their_own_request_policy(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, owner
):
    info = sandbox(tmp_path)
    info["firewalls"][0]["firewall"]["name"] = owner
    info["networkPolicies"][owner] = info["networkPolicies"].pop(managed.OWNER)
    info.pop("piModelConfig")
    path = _write_registry(tmp_path, sandbox_info=info)
    flow = request(real_flow, {"model": "user-chosen-model", "provider": {"sort": "price"}})
    with (
        mitm_ctx(registry_path=str(path)),
        fake_firewall_headers(headers={"Authorization": "Bearer owner-token"}) as auth_fetch,
    ):
        await mitm_addon.request(flow)
        auth_fetch.assert_awaited_once()
        assert flow.response is None
        assert flow.request.headers["Authorization"] == "Bearer owner-token"
        assert flow.metadata[metadata_keys.FIREWALL_NAME] == owner
    assert managed.admission_state_for_tests() == (0, 0)
