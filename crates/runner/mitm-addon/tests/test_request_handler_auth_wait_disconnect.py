"""Pre-forward destination recovery across asynchronous credential resolution."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from mitmproxy import connection, http
from mitmproxy.flow import Error

import auth
import flow_metadata_keys as metadata_keys
import mitm_addon
import request_streaming
import upstream_destination_binding
from tests.firewall_auth_helpers import firewall_auth_response
from tests.request_handler_helpers import _write_github_firewall_registry, _write_registry
from tests.upstream_connection_helpers import mark_connected_tls_upstream


@pytest.mark.parametrize(
    "interruption",
    [
        "none",
        "closed",
        "half-closed",
        "errored",
        "replaced",
        "streamed",
        "streamed-without-flag",
        "transport-started",
        "revoked",
        "replaced-run",
        "changed-authority",
        "changed-method",
        "changed-path",
    ],
)
async def test_auth_wait_recovers_only_unchanged_presend_closed_upstream(
    tmp_path, real_flow, mitm_ctx, monkeypatch, interruption: str
) -> None:
    registry_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="104.18.32.47",
        sni="api.github.com",
        method="POST",
        path="/repos/okou-ai/okou",
        request_headers=http.Headers(((b"Host", b"API.GITHUB.COM.:443"),)),
    )
    flow.request.content = b'{"name":"synthetic"}'
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
        task = asyncio.create_task(mitm_addon.request(flow))
        try:
            await asyncio.wait_for(entered.wait(), timeout=2)
            assert "Authorization" not in flow.request.headers
            if interruption != "none":
                original_server.state = connection.ConnectionState.CLOSED
                mitm_addon.server_disconnected(SimpleNamespace(server=original_server))
                assert not upstream_destination_binding.has_server_binding(original_server)
            if interruption == "half-closed":
                original_server.state = connection.ConnectionState.CAN_WRITE
            elif interruption == "errored":
                original_server.error = "synthetic transport error"
            elif interruption == "replaced":
                flow.server_conn = connection.Server(address=("attacker.example", 443))
            elif interruption == "streamed":
                flow.request.stream = True
            elif interruption == "streamed-without-flag":
                request_streaming.configure_request_stream(flow)
                assert callable(flow.request.stream)
                flow.request.stream(b"already forwarded")
                flow.request.stream = False
            elif interruption == "transport-started":
                flow.metadata[metadata_keys.UPSTREAM_REQUEST_STARTED] = True
            elif interruption in {"revoked", "replaced-run"}:
                sandbox = json.loads(registry_path.read_text())["sandboxes"]["10.200.0.5"]
                if interruption == "revoked":
                    sandbox["networkPolicies"]["github"]["allow"] = []
                    sandbox["networkPolicies"]["github"]["deny"] = ["full-access"]
                else:
                    sandbox["runId"] = "replacement-run"
                _write_registry(tmp_path, sandbox_info=sandbox)
            elif interruption == "changed-authority":
                flow.request.headers["Host"] = "attacker.example"
            elif interruption == "changed-method":
                flow.request.method = "DELETE"
            elif interruption == "changed-path":
                flow.request.path = "/repos/other"
            resume.set()
            await asyncio.wait_for(task, timeout=2)
        finally:
            resume.set()
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

        fetch.assert_awaited_once()
        if interruption not in {"none", "closed"}:
            assert flow.response is not None
            assert flow.response.status_code == 403
            assert "Authorization" not in flow.request.headers
            assert metadata_keys.RECOVERED_FIREWALL_REQUEST not in flow.metadata
            return
        assert flow.response is None
        assert flow.request.headers["Authorization"] == "Bearer synthetic-secret"
        assert flow.request.headers["Host"] == "API.GITHUB.COM.:443"
        assert flow.request.raw_content == b'{"name":"synthetic"}'
        if interruption == "closed":
            assert flow.server_conn is not original_server
            assert flow.server_conn.address == ("api.github.com", 443)
            assert flow.request.host == "api.github.com"
            assert not flow.server_conn.connected
            assert upstream_destination_binding.has_server_binding(flow.server_conn)
            assert metadata_keys.RECOVERED_FIREWALL_REQUEST in flow.metadata
            # A replacement failing before the late gate must not retain state.
            flow.error = Error("synthetic replacement failure")
            mitm_addon.error(flow)
            assert metadata_keys.RECOVERED_FIREWALL_REQUEST not in flow.metadata
            assert not upstream_destination_binding.has_server_binding(flow.server_conn)
        else:
            assert flow.server_conn is original_server
            assert flow.request.host == "104.18.32.47"
            assert metadata_keys.RECOVERED_FIREWALL_REQUEST not in flow.metadata
