"""Sandbox count isolation with one process-wide retained-body byte budget."""

import asyncio
import json
from unittest.mock import AsyncMock, patch

import pytest
from mitmproxy import http
from mitmproxy.flow import Error

import auth
import managed_openrouter as managed
import mitm_addon
from tests.managed_openrouter_helpers import request, write_sandbox_registry

CLIENT_IPS = ("10.200.0.5", "10.200.0.6")


@pytest.mark.parametrize("dialect", ["openai-completions", "openai-responses"])
@pytest.mark.parametrize("terminal", ["response", "error"])
async def test_each_sandbox_has_sixteen_slots_until_its_streams_terminate(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, dialect, terminal
):
    path = write_sandbox_registry(tmp_path, dialect, CLIENT_IPS)
    streams = []
    with (
        mitm_ctx(registry_path=str(path)),
        fake_firewall_headers(headers={"Authorization": "Bearer managed-token"}),
    ):
        for ip in CLIENT_IPS:
            for index in range(16):
                flow = request(real_flow, dialect=dialect)
                flow.client_conn.peername = (ip, 12000 + index)
                flow.request.headers["X-Session-Id"] = f"session-{index}"
                assert mitm_addon.requestheaders(flow) is None
                assert flow.error is None
                await mitm_addon.request(flow)
                assert flow.response is None
                assert flow.request.headers["Authorization"] == "Bearer managed-token"
                flow.response = http.Response.make(200, b"", {"Content-Type": "text/event-stream"})
                mitm_addon.responseheaders(flow)
                streams.append(flow)

            blocked = request(real_flow, dialect=dialect)
            blocked.client_conn.peername = (ip, 13000)
            blocked.request.headers["X-Session-Id"] = "another-session"
            assert mitm_addon.requestheaders(blocked) is None
            assert blocked.error is not None
            assert blocked.request.headers["Authorization"] == "Bearer sandbox-placeholder"

        assert managed.admission_state_for_tests()[0] == 32
        first = streams.pop(0)
        if terminal == "response":
            mitm_addon.response(first)
        else:
            first.error = Error("stream disconnected")
            mitm_addon.error(first)
            mitm_addon.error(first)

        replacement = request(real_flow, dialect=dialect)
        assert mitm_addon.requestheaders(replacement) is None
        assert replacement.error is None
        await mitm_addon.request(replacement)
        assert replacement.response is None
        assert replacement.request.headers["Authorization"] == "Bearer managed-token"
        streams.append(replacement)

        still_full = request(real_flow, dialect=dialect)
        still_full.client_conn.peername = (CLIENT_IPS[1], 14000)
        assert mitm_addon.requestheaders(still_full) is None
        assert still_full.error is not None

        for flow in streams:
            flow.error = Error("test peer disconnected")
            mitm_addon.error(flow)
    assert managed.admission_state_for_tests() == (0, 0)


@pytest.mark.parametrize("dialect", ["openai-completions", "openai-responses"])
async def test_sandboxes_share_the_aggregate_body_byte_budget(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, monkeypatch, dialect
):
    path = write_sandbox_registry(tmp_path, dialect, CLIENT_IPS)
    first, blocked, replacement = (request(real_flow, dialect=dialect) for _ in range(3))
    length = len(first.request.raw_content)
    monkeypatch.setattr(managed, "MAX_ADMITTED_BODY_BYTES", length)
    for flow in (blocked, replacement):
        flow.client_conn.peername = (CLIENT_IPS[1], 12345)
    for flow in (first, blocked, replacement):
        flow.request.raw_content = None
    with mitm_ctx(registry_path=str(path)), fake_firewall_headers() as auth_fetch:
        assert mitm_addon.requestheaders(first) is None
        assert first.error is None
        assert mitm_addon.requestheaders(blocked) is None
        assert blocked.error is not None
        first.error = Error("partial body disconnected")
        mitm_addon.error(first)
        assert mitm_addon.requestheaders(replacement) is None
        assert replacement.error is None
        mitm_addon.error(first)
        assert managed.admission_state_for_tests() == (1, length)
        replacement.error = Error("partial body disconnected")
        mitm_addon.error(replacement)
        auth_fetch.assert_not_called()
    assert managed.admission_state_for_tests() == (0, 0)


async def test_auth_cancellation_frees_only_its_sandbox_slot(
    tmp_path, real_flow, mitm_ctx, monkeypatch
):
    path = write_sandbox_registry(tmp_path, "openai-completions", CLIENT_IPS)
    monkeypatch.setattr(managed, "MAX_ADMITTED_REQUESTS", 1)
    other = request(real_flow)
    other.client_conn.peername = (CLIENT_IPS[1], 12345)
    cancelled, replacement, still_full = (request(real_flow) for _ in range(3))
    still_full.client_conn.peername = (CLIENT_IPS[1], 14000)
    with (
        mitm_ctx(registry_path=str(path)),
        patch.object(auth, "get_firewall_headers", AsyncMock(side_effect=asyncio.CancelledError)),
    ):
        assert mitm_addon.requestheaders(other) is None
        assert other.error is None
        assert mitm_addon.requestheaders(cancelled) is None
        assert cancelled.error is None
        with pytest.raises(asyncio.CancelledError):
            await mitm_addon.request(cancelled)
        assert mitm_addon.requestheaders(replacement) is None
        assert replacement.error is None
        assert mitm_addon.requestheaders(still_full) is None
        assert still_full.error is not None
        for flow in (other, replacement):
            flow.error = Error("partial body disconnected")
            mitm_addon.error(flow)
    assert managed.admission_state_for_tests() == (0, 0)


async def test_reused_sandbox_ip_retains_its_draining_request_count(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, monkeypatch
):
    path = write_sandbox_registry(tmp_path, "openai-completions", CLIENT_IPS)
    monkeypatch.setattr(managed, "MAX_ADMITTED_REQUESTS", 1)
    first, blocked, replacement, other = (request(real_flow) for _ in range(4))
    other.client_conn.peername = (CLIENT_IPS[1], 12345)
    with mitm_ctx(registry_path=str(path)), fake_firewall_headers() as auth_fetch:
        assert mitm_addon.requestheaders(first) is None
        assert first.error is None
        registrations = json.loads(path.read_text())
        registrations["sandboxes"][CLIENT_IPS[0]]["runId"] = "run-reused-sandbox"
        next_path = path.with_suffix(".next.json")
        next_path.write_text(json.dumps(registrations))
        next_path.replace(path)
        assert mitm_addon.requestheaders(blocked) is None
        assert blocked.error is not None
        assert mitm_addon.requestheaders(other) is None
        assert other.error is None
        first.error = Error("old sandbox disconnected")
        mitm_addon.error(first)
        assert mitm_addon.requestheaders(replacement) is None
        assert replacement.error is None
        for flow in (other, replacement):
            flow.error = Error("partial body disconnected")
            mitm_addon.error(flow)
        auth_fetch.assert_not_called()
    assert managed.admission_state_for_tests() == (0, 0)
