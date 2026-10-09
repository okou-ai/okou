"""Pinned HTTP connection-selection and before-send recovery contracts.

TCP/TLS completion is controlled: these tests run the actual HttpStream state
machine with real connection objects, not a provider request or POST retry.
"""

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Literal
from unittest.mock import AsyncMock, patch

import pytest
from mitmproxy import connection, http
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.proxy import commands, events
from mitmproxy.proxy.layers.http import (
    GetHttpConnection,
    GetHttpConnectionCompleted,
    HttpClient,
    HttpLayer,
    HTTPMode,
    HttpStream,
    SendHttp,
)
from mitmproxy.proxy.layers.http._events import (
    RequestData,
    RequestEndOfMessage,
    RequestHeaders,
    ResponseData,
    ResponseEndOfMessage,
    ResponseHeaders,
)
from mitmproxy.proxy.layers.http._hooks import HttpRequestHeadersHook, HttpRequestHook
from mitmproxy.test import taddons, tutils

import auth
import flow_metadata_keys as metadata_keys
import mitm_addon
import mitmproxy_compat
import upstream_destination_binding
from body_limits import STREAM_BUFFER_LIMIT
from tests.firewall_auth_helpers import firewall_auth_response
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.mitmproxy_http_framing_helpers import start_http_layer
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry
from tests.upstream_connection_helpers import mark_connected_tls_upstream, seed_server_binding

type Phase = Literal["buffered", "headers"]
_HOST = "api.github.com"
_AUTHORITY = "API.GITHUB.COM.:443"
_BODY = b'{"name":"synthetic"}' + b" " * STREAM_BUFFER_LIMIT
_TOKEN = "Bearer synthetic-secret"


def _write_recovery_registry(tmp_path: Path, *, phase: Phase) -> Path:
    api: dict[str, object] = {
        "base": f"https://{_HOST}",
        "auth": {
            "headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"},
            "query": {"managed": "${{ secrets.GITHUB_TOKEN }}"},
        },
        "permissions": [{"name": "repos", "rules": ["ANY /repos/{path+}"]}],
    }
    if phase == "buffered":
        api["hostPolicy"] = {"kind": "publicDestination"}
    return _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            api_entry=api,
            network_policy={"allow": ["repos"], "deny": [], "ask": [], "unknownPolicy": "deny"},
            sandbox_fields={"captureNetworkBodies": True},
        ),
    )


async def _pause_recovered_stream(
    addon_context: taddons.context,
    monkeypatch: pytest.MonkeyPatch,
    *,
    alpn: bytes,
    phase: Phase,
) -> tuple[HttpStream, http.HTTPFlow, GetHttpConnection, list[commands.Command], AsyncMock]:
    _, http_layer = start_http_layer(
        addon_context,
        alpn=alpn,
        host=_HOST,
        server_host="104.18.32.47",
        mode=HTTPMode.transparent,
    )
    stream = HttpStream(http_layer.context.fork(), 1)
    list(stream.handle_event(events.Start()))
    request = tutils.treq(
        scheme=b"https",
        method=b"POST",
        host=_HOST.encode(),
        port=443,
        path=b"/repos/okou-ai/okou",
        http_version=b"HTTP/2.0" if alpn == b"h2" else b"HTTP/1.1",
        headers=http.Headers(
            ((b"Host", _AUTHORITY.encode()), (b"Content-Length", str(len(_BODY)).encode()))
        ),
        content=b"",
    )
    if alpn == b"h2":
        request.authority = _AUTHORITY
    history = list(stream.handle_event(RequestHeaders(1, request, end_stream=False)))
    headers_hook = next(cmd for cmd in history if isinstance(cmd, HttpRequestHeadersHook))
    flow = headers_hook.flow
    mark_connected_tls_upstream(
        flow,
        sni=_HOST,
        server_address=("104.18.32.47", 443),
        peername=("104.18.32.47", 443),
    )
    original_server = flow.server_conn

    async def resolve(*_args, **_kwargs):
        assert upstream_destination_binding.has_server_binding(original_server)
        assert "Authorization" not in flow.request.headers
        original_server.state = connection.ConnectionState.CLOSED
        mitm_addon.server_disconnected(SimpleNamespace(server=original_server))
        return firewall_auth_response(
            headers={"Authorization": _TOKEN}, query={"managed": "synthetic-query"}
        )

    fetch = AsyncMock(side_effect=resolve)
    monkeypatch.setattr(auth, "get_firewall_headers", fetch)
    await addon_context.master.addons.invoke_addon(mitm_addon, headers_hook)
    pending = list(stream.handle_event(events.HookCompleted(headers_hook, None)))
    history.extend(pending)
    if phase == "buffered":
        assert not any(isinstance(cmd, GetHttpConnection) for cmd in pending)
        history.extend(stream.handle_event(RequestData(1, _BODY)))
        pending = list(stream.handle_event(RequestEndOfMessage(1)))
        history.extend(pending)
        request_hook = next(cmd for cmd in pending if isinstance(cmd, HttpRequestHook))
        await addon_context.master.addons.invoke_addon(mitm_addon, request_hook)
        pending = list(stream.handle_event(events.HookCompleted(request_hook, None)))
        history.extend(pending)
    assert flow.response is None, flow.response.get_text() if flow.response else ""
    assert flow.server_conn is not original_server
    assert metadata_keys.RECOVERED_FIREWALL_REQUEST in flow.metadata
    get_connection = next(cmd for cmd in pending if isinstance(cmd, GetHttpConnection))
    assert get_connection.address == (_HOST, 443)
    assert get_connection.tls
    assert flow.request.headers["Host"] == _AUTHORITY
    assert not any(isinstance(cmd, SendHttp) for cmd in history)
    return stream, flow, get_connection, history, fetch


def _verified_replacement(flow: http.HTTPFlow) -> connection.Server:
    replacement = connection.Server(address=(_HOST, 443), tls=True)
    proof_flow = http.HTTPFlow(flow.client_conn, replacement)
    mark_connected_tls_upstream(
        proof_flow,
        sni=_HOST,
        server_address=(_HOST, 443),
        peername=("104.18.33.47", 443),
    )
    return replacement


@pytest.mark.parametrize("alpn", [b"http/1.1", b"h2"])
@pytest.mark.parametrize("phase", ["buffered", "headers"])
@pytest.mark.parametrize("prebound", [False, True])
async def test_recovered_actual_connection_is_checked_before_single_send(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, alpn: bytes, phase: Phase, prebound: bool
) -> None:
    registry_path = _write_recovery_registry(tmp_path, phase=phase)
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        addon_context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry_path)
        )
        stream, flow, get_connection, history, fetch = await _pause_recovered_stream(
            addon_context, monkeypatch, alpn=alpn, phase=phase
        )
        replacement = _verified_replacement(flow)
        if prebound:
            # Real server_connect may record DNS eligibility before TLS/peer IP
            # is known. The ready hook must refresh it from verified live proof.
            seed_server_binding(
                replacement,
                client=flow.client_conn,
                host=_HOST,
                port=443,
                kinds=frozenset(("connector_auth",)),
                original_address=(_HOST, 443),
            )
        assert get_connection.connection_spec_matches(replacement)
        pending = list(
            stream.handle_event(GetHttpConnectionCompleted(get_connection, (replacement, None)))
        )
        history.extend(pending)
        ready = next(
            cmd for cmd in pending if isinstance(cmd, mitmproxy_compat.OkouUpstreamReadyHook)
        )
        assert flow.server_conn is replacement
        assert not any(isinstance(cmd, SendHttp) for cmd in history)
        await addon_context.master.addons.invoke_addon(mitm_addon, ready)
        assert flow.metadata[metadata_keys.RECOVERED_UPSTREAM_ADMITTED] is True
        assert flow.metadata[metadata_keys.ORIGINAL_URL] == f"https://{_HOST}/repos/okou-ai/okou"
        history.extend(stream.handle_event(events.HookCompleted(ready, None)))
        if phase == "headers":
            history.extend(stream.handle_event(RequestData(1, _BODY)))
            pending = list(stream.handle_event(RequestEndOfMessage(1)))
            history.extend(pending)
            request_hook = next(cmd for cmd in pending if isinstance(cmd, HttpRequestHook))
            await addon_context.master.addons.invoke_addon(mitm_addon, request_hook)
            history.extend(stream.handle_event(events.HookCompleted(request_hook, None)))
        fetch.assert_awaited_once()
        sends = [cmd for cmd in history if isinstance(cmd, SendHttp)]
        heads = [cmd for cmd in sends if isinstance(cmd.event, RequestHeaders)]
        assert len(heads) == 1
        assert all(cmd.connection is replacement for cmd in sends)
        head = heads[0].event
        assert isinstance(head, RequestHeaders)
        assert head.request.headers["Authorization"] == _TOKEN
        assert head.request.headers["Host"] == _AUTHORITY
        assert head.request.query["managed"] == "synthetic-query"
        if alpn == b"h2":
            assert head.request.authority == _AUTHORITY
        assert (
            b"".join(cmd.event.data for cmd in sends if isinstance(cmd.event, RequestData)) == _BODY
        )
        assert len([cmd for cmd in sends if isinstance(cmd.event, RequestEndOfMessage)]) == 1
        assert metadata_keys.RECOVERED_FIREWALL_REQUEST not in flow.metadata
        assert metadata_keys.RECOVERED_UPSTREAM_ADMITTED not in flow.metadata
        assert flow.metadata[metadata_keys.UPSTREAM_REQUEST_STARTED] is True
        assert upstream_destination_binding.flow_matches_direct_bound_destination(
            flow, allowed_kinds=frozenset(("connector_auth",))
        )
        assert set(upstream_destination_binding.binding_snapshot_for_tests()) == {replacement.id}
        pending = list(
            stream.handle_event(ResponseHeaders(1, http.Response.make(200), end_stream=False))
        )
        response_headers_hook = next(cmd for cmd in pending if isinstance(cmd, commands.StartHook))
        await addon_context.master.addons.invoke_addon(mitm_addon, response_headers_hook)
        list(stream.handle_event(events.HookCompleted(response_headers_hook, None)))
        list(stream.handle_event(ResponseData(1, b"{}")))
        pending = list(stream.handle_event(ResponseEndOfMessage(1)))
        response_hook = next(cmd for cmd in pending if isinstance(cmd, commands.StartHook))
        await addon_context.master.addons.invoke_addon(mitm_addon, response_hook)
        list(stream.handle_event(events.HookCompleted(response_hook, None)))
        [network_entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
        assert network_entry["url"] == f"https://{_HOST}/repos/okou-ai/okou"
        assert "synthetic-query" not in json.dumps(network_entry)
        assert _TOKEN not in json.dumps(network_entry)
        assert metadata_keys.UPSTREAM_REQUEST_STARTED not in flow.metadata


@pytest.mark.parametrize("alpn", [b"http/1.1", b"h2"])
@pytest.mark.parametrize(
    "invalid",
    [
        "wrong-sni",
        "missing-tls",
        "missing-cert",
        "ssl-insecure",
        "wrong-port",
        "missing-endpoint",
        "private-ip",
        "revoked",
        "replaced-run",
        "changed-authority",
        "missing-handler",
        "handler-error",
    ],
)
async def test_invalid_actual_replacement_never_forwards_credentials_or_body(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, alpn: bytes, invalid: str
) -> None:
    registry_path = _write_recovery_registry(tmp_path, phase="buffered")
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        addon_context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry_path)
        )
        stream, flow, get_connection, history, _ = await _pause_recovered_stream(
            addon_context, monkeypatch, alpn=alpn, phase="buffered"
        )
        replacement = _verified_replacement(flow)
        has_existing_binding = invalid in {
            "wrong-sni",
            "missing-tls",
            "missing-cert",
            "ssl-insecure",
        }
        if has_existing_binding:
            seed_server_binding(
                replacement,
                client=flow.client_conn,
                host=_HOST,
                port=443,
                kinds=frozenset(("connector_auth",)),
                original_address=("104.18.33.47", 443),
            )
        if invalid == "wrong-sni":
            replacement.sni = "attacker.example"
        elif invalid == "missing-tls":
            replacement.timestamp_tls_setup = None
        elif invalid == "missing-cert":
            replacement.certificate_list = ()
        elif invalid == "ssl-insecure":
            addon_context.options.update(ssl_insecure=True)
        elif invalid == "wrong-port":
            replacement.peername = ("104.18.33.47", 8443)
        elif invalid == "missing-endpoint":
            replacement.peername = None
        elif invalid == "private-ip":
            replacement.peername = ("127.0.0.1", 443)
        elif invalid in {"revoked", "replaced-run"}:
            data = json.loads(registry_path.read_text())
            sandbox = data["sandboxes"]["10.200.0.5"]
            if invalid == "revoked":
                sandbox["networkPolicies"]["github"]["allow"] = []
                sandbox["networkPolicies"]["github"]["deny"] = ["repos"]
            else:
                sandbox["runId"] = "replacement-run"
            _write_registry(tmp_path, sandbox_info=sandbox)
        elif invalid == "changed-authority":
            flow.request.headers["Host"] = "attacker.example"
        pending = list(
            stream.handle_event(GetHttpConnectionCompleted(get_connection, (replacement, None)))
        )
        history.extend(pending)
        ready = next(
            cmd for cmd in pending if isinstance(cmd, mitmproxy_compat.OkouUpstreamReadyHook)
        )
        if invalid == "handler-error":

            def failed_admission(_flow: http.HTTPFlow) -> None:
                raise RuntimeError("synthetic late admission failure")

            monkeypatch.setattr(mitm_addon, "okou_upstream_ready", failed_admission)
            await addon_context.master.addons.trigger_event(ready)
        elif invalid != "missing-handler":
            await addon_context.master.addons.invoke_addon(mitm_addon, ready)
        pending = list(stream.handle_event(events.HookCompleted(ready, None)))
        history.extend(pending)
        while pending:
            hook = next((cmd for cmd in pending if isinstance(cmd, commands.StartHook)), None)
            if hook is None:
                break
            await addon_context.master.addons.invoke_addon(mitm_addon, hook)
            pending = list(stream.handle_event(events.HookCompleted(hook, None)))
            history.extend(pending)
        assert flow.response is not None
        assert flow.response.status_code >= 400
        assert not any(
            isinstance(cmd, SendHttp) and cmd.connection is replacement for cmd in history
        )
        client_data = b"".join(
            cmd.event.data
            for cmd in history
            if isinstance(cmd, SendHttp) and isinstance(cmd.event, ResponseData)
        )
        assert client_data
        assert _TOKEN.encode() not in client_data
        assert b"synthetic-query" not in client_data
        assert metadata_keys.RECOVERED_FIREWALL_REQUEST not in flow.metadata
        assert metadata_keys.RECOVERED_UPSTREAM_ADMITTED not in flow.metadata
        remaining = upstream_destination_binding.binding_snapshot_for_tests()
        assert set(remaining) == ({replacement.id} if has_existing_binding else set())
        if has_existing_binding:
            assert remaining[replacement.id].original_address == ("104.18.33.47", 443)


@pytest.mark.parametrize("alpn", [b"http/1.1", b"h2"])
@pytest.mark.parametrize("pooled", [False, True])
async def test_real_http_pool_selection_uses_authority_and_rejects_wrong_tls_identity(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, alpn: bytes, pooled: bool
) -> None:
    registry_path = _write_recovery_registry(tmp_path, phase="buffered")
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        addon_context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry_path)
        )
        stream, flow, get_connection, _, _ = await _pause_recovered_stream(
            addon_context, monkeypatch, alpn=alpn, phase="buffered"
        )
        parent = stream.context.layers[-2]
        assert isinstance(parent, HttpLayer)
        parent.command_sources[get_connection] = stream
        if pooled:
            replacement = _verified_replacement(flow)
            replacement.sni = "attacker.example"
            replacement.alpn = alpn
            pool_context = parent.context.fork()
            pool_context.server = replacement
            parent.connections[replacement] = HttpClient(pool_context)
        selected = list(parent.get_connection(get_connection))
        assert not any(isinstance(cmd, SendHttp) for cmd in selected)
        if pooled:
            ready = next(
                cmd for cmd in selected if isinstance(cmd, mitmproxy_compat.OkouUpstreamReadyHook)
            )
            assert flow.server_conn is replacement
            await addon_context.master.addons.invoke_addon(mitm_addon, ready)
            assert flow.response is not None
            assert flow.response.status_code == 403
            assert metadata_keys.RECOVERED_UPSTREAM_ADMITTED not in flow.metadata
        else:
            opening = [cmd for cmd in selected if isinstance(cmd, commands.OpenConnection)]
            assert len(opening) == 1
            assert opening[0].connection.address == (_HOST, 443)
            assert opening[0].connection.sni == _HOST


def test_before_send_bridge_installation_is_idempotent_and_version_locked(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mitmproxy_compat.install_runtime_compatibility()
    installed = HttpStream.make_server_connection
    mitmproxy_compat.install_runtime_compatibility()
    assert HttpStream.make_server_connection is installed
    monkeypatch.setattr(mitmproxy_compat.version, "VERSION", "unreviewed-version")
    with pytest.raises(RuntimeError, match=r"requires mitmproxy 12\.2\.3"):
        mitmproxy_compat.install_runtime_compatibility()
    assert HttpStream.make_server_connection is installed
