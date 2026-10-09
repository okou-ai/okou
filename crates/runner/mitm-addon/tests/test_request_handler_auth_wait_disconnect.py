"""Request authorization is independent of the original socket's lifetime."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from mitmproxy import connection, ctx, http
from mitmproxy.flow import Error

import auth
import mitm_addon
import request_streaming
import upstream_destination_binding
from body_limits import STREAM_BUFFER_LIMIT
from tests.firewall_auth_helpers import firewall_auth_response
from tests.request_handler_helpers import _write_github_firewall_registry, _write_registry
from tests.requestheaders_helpers import await_requestheaders_result
from tests.upstream_connection_helpers import mark_connected_tls_upstream

_INTERRUPTIONS = (
    "none",
    "closed",
    "half-closed",
    "unconnected-replacement",
    "connected-replacement",
    "closed-server-error",
    "connected-server-error",
    "flow-error",
    "streamed",
    "streamed-without-flag",
    "revoked",
    "replaced-run",
    "changed-owner",
    "changed-permission",
    "changed-port",
    "changed-scheme",
    "changed-authority",
    "changed-method",
    "changed-path",
    "wrong-connected-sni",
    "insecure",
    "public-lost-binding",
    "public-failed-acquisition",
)


@pytest.mark.parametrize(
    ("phase", "interruption"),
    [
        (phase, interruption)
        for phase in ("request", "requestheaders")
        for interruption in _INTERRUPTIONS
        # publicDestination does not perform header-phase auth/stream preparation.
        if phase == "request"
        or interruption not in {"public-lost-binding", "public-failed-acquisition"}
    ],
)
async def test_auth_wait_checks_request_identity_not_socket_lifetime(
    tmp_path, real_flow, mitm_ctx, monkeypatch, phase: str, interruption: str
) -> None:
    registry_path = _write_github_firewall_registry(
        tmp_path, sandbox_fields={"captureNetworkBodies": True}
    )
    if interruption in {"public-lost-binding", "public-failed-acquisition"}:
        sandbox = json.loads(registry_path.read_text())["sandboxes"]["10.200.0.5"]
        sandbox["firewalls"][0]["firewall"]["apis"][0]["hostPolicy"] = {"kind": "publicDestination"}
        _write_registry(tmp_path, sandbox_info=sandbox)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="104.18.32.47",
        sni="api.github.com",
        method="POST",
        path="/repos/okou-ai/okou",
        request_headers=http.Headers(
            (
                (b"Host", b"API.GITHUB.COM.:443"),
                (b"Content-Length", str(STREAM_BUFFER_LIMIT + 1).encode()),
            )
        ),
    )
    body = b'{"name":"synthetic"}' if phase == "request" else b""
    flow.request.content = body
    flow.request.headers["Content-Length"] = str(
        len(body) if phase == "request" else STREAM_BUFFER_LIMIT + 1
    )
    mark_connected_tls_upstream(
        flow,
        sni="api.github.com",
        server_address=("104.18.32.47", 443),
        peername=("104.18.32.47", 443),
    )
    original_server = flow.server_conn
    entered = asyncio.Event()
    resume = asyncio.Event()

    async def resolve(*_args, **_kwargs):
        entered.set()
        await resume.wait()
        return firewall_auth_response(headers={"Authorization": "Bearer synthetic-secret"})

    fetch = AsyncMock(side_effect=resolve)
    monkeypatch.setattr(auth, "get_firewall_headers", fetch)
    with mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"):
        hook = (
            mitm_addon.request(flow)
            if phase == "request"
            else await_requestheaders_result(mitm_addon.requestheaders(flow))
        )
        task = asyncio.create_task(hook)
        try:
            await asyncio.wait_for(entered.wait(), timeout=2)
            assert "Authorization" not in flow.request.headers
            if interruption != "none":
                original_server.state = connection.ConnectionState.CLOSED
                if interruption != "public-failed-acquisition":
                    mitm_addon.server_disconnected(SimpleNamespace(server=original_server))
            if interruption == "half-closed":
                original_server.state = connection.ConnectionState.CAN_WRITE
            elif interruption in {"closed-server-error", "public-failed-acquisition"}:
                original_server.error = "synthetic transport error"
            elif interruption == "connected-server-error":
                mark_connected_tls_upstream(
                    flow,
                    sni="api.github.com",
                    server_address=("104.18.32.47", 443),
                    peername=("104.18.32.47", 443),
                )
                original_server.error = "synthetic transport error"
            elif interruption == "flow-error":
                flow.error = Error("synthetic HTTP flow failure")
            elif interruption == "unconnected-replacement":
                flow.server_conn = connection.Server(address=("other.example", 443))
            elif interruption in {"connected-replacement", "wrong-connected-sni"}:
                flow.server_conn = connection.Server(address=("104.18.33.47", 443))
                mark_connected_tls_upstream(
                    flow,
                    sni="other.example"
                    if interruption == "wrong-connected-sni"
                    else "api.github.com",
                    server_address=("104.18.33.47", 443),
                    peername=("104.18.33.47", 443),
                )
            elif interruption == "streamed":
                flow.request.stream = True
            elif interruption == "streamed-without-flag":
                request_streaming.configure_request_stream(flow)
                assert callable(flow.request.stream)
                flow.request.stream(b"already forwarded")
                flow.request.stream = False
            elif interruption in {"revoked", "replaced-run", "changed-owner", "changed-permission"}:
                sandbox = json.loads(registry_path.read_text())["sandboxes"]["10.200.0.5"]
                if interruption == "revoked":
                    sandbox["networkPolicies"]["github"]["allow"] = []
                    sandbox["networkPolicies"]["github"]["deny"] = ["full-access"]
                elif interruption == "changed-owner":
                    sandbox["firewalls"][0]["firewall"]["name"] = "replacement-owner"
                    sandbox["networkPolicies"]["replacement-owner"] = sandbox[
                        "networkPolicies"
                    ].pop("github")
                elif interruption == "changed-permission":
                    sandbox["firewalls"][0]["firewall"]["apis"][0]["permissions"][0]["name"] = (
                        "replacement-permission"
                    )
                    sandbox["networkPolicies"]["github"]["allow"] = ["replacement-permission"]
                else:
                    sandbox["runId"] = "replacement-run"
                _write_registry(tmp_path, sandbox_info=sandbox)
            elif interruption == "changed-port":
                flow.request.port = 8443
            elif interruption == "changed-scheme":
                flow.request.scheme = "http"
            elif interruption == "changed-authority":
                flow.request.headers["Host"] = "other.example"
            elif interruption == "changed-method":
                flow.request.method = "DELETE"
            elif interruption == "changed-path":
                flow.request.path = "/repos/other"
            elif interruption == "insecure":
                ctx.options.ssl_insecure = True
            resume.set()
            await asyncio.wait_for(task, timeout=2)
        finally:
            resume.set()
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

        fetch.assert_awaited_once()
        allowed = interruption in {
            "none",
            "closed",
            "half-closed",
            "closed-server-error",
            "unconnected-replacement",
            "connected-replacement",
        }
        if not allowed:
            assert "Authorization" not in flow.request.headers
            if phase == "request":
                assert flow.response is not None
                assert flow.response.status_code >= 400
            else:
                assert not callable(flow.request.stream)
            return
        assert flow.response is None
        assert flow.request.headers["Authorization"] == "Bearer synthetic-secret"
        assert flow.request.headers["Host"] == "API.GITHUB.COM.:443"
        assert flow.request.raw_content == body
        if interruption in {
            "closed",
            "half-closed",
            "closed-server-error",
            "unconnected-replacement",
        }:
            assert flow.request.host == "api.github.com"
            assert not flow.server_conn.connected
            assert not upstream_destination_binding.has_server_binding(flow.server_conn)
            if interruption != "unconnected-replacement":
                assert flow.server_conn is original_server
        if phase == "requestheaders":
            assert callable(flow.request.stream)


@pytest.mark.parametrize("phase", ["request", "requestheaders"])
async def test_initial_unconnected_error_preserves_authorized_preparation(
    tmp_path, real_flow, mitm_ctx, monkeypatch, phase: str
) -> None:
    registry_path = _write_github_firewall_registry(tmp_path)
    body = b'{"name":"synthetic"}'
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="104.18.32.47",
        sni="api.github.com",
        method="POST",
        path="/repos/okou-ai/okou",
        request_headers=http.Headers(((b"Host", b"API.GITHUB.COM.:443"),)),
    )
    flow.request.content = body
    flow.request.headers["Content-Length"] = str(len(body))
    original_server = flow.server_conn
    original_server.state = connection.ConnectionState.CLOSED
    original_server.error = "synthetic original acquisition failure"
    fetch = AsyncMock(
        return_value=firewall_auth_response(headers={"Authorization": "Bearer synthetic-secret"})
    )
    monkeypatch.setattr(auth, "get_firewall_headers", fetch)

    with mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"):
        try:
            if phase == "requestheaders":
                preparation = mitm_addon.requestheaders(flow)
                if preparation is not None:
                    await preparation
                assert "Authorization" not in flow.request.headers
            await mitm_addon.request(flow)
            fetch.assert_awaited_once()
            assert flow.response is None
            assert flow.error is None
            assert flow.request.host == "api.github.com"
            assert flow.request.headers["Authorization"] == "Bearer synthetic-secret"
            assert flow.request.headers["Host"] == "API.GITHUB.COM.:443"
            assert flow.request.raw_content == body
            assert flow.server_conn is original_server
            assert original_server.error == "synthetic original acquisition failure"
            assert not original_server.connected
        finally:
            mitm_addon.error(flow)
