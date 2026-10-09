"""Native acquisition forwards an authorized request once after an auth-wait close.

The dependency owns connection selection and sending. TCP completion is controlled;
cryptographic TLS rejection is exercised separately, not modeled as a certificate field.
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
import mitm_addon
import upstream_destination_binding
from body_limits import STREAM_BUFFER_LIMIT
from tests.firewall_auth_helpers import firewall_auth_response
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.mitmproxy_http_framing_helpers import start_http_layer
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry
from tests.upstream_connection_helpers import mark_connected_tls_upstream

type Phase = Literal["buffered", "headers"]
_HOST = "api.github.com"
_AUTHORITY = "API.GITHUB.COM.:443"
_BODY = b'{"name":"synthetic"}' + b" " * STREAM_BUFFER_LIMIT
_TOKEN = "Bearer synthetic-secret"


def _write_recovery_registry(tmp_path: Path) -> Path:
    return _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            api_entry={
                "base": f"https://{_HOST}",
                "auth": {
                    "headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"},
                    "query": {"managed": "${{ secrets.GITHUB_TOKEN }}"},
                },
                "permissions": [{"name": "repos", "rules": ["ANY /repos/{path+}"]}],
            },
            network_policy={"allow": ["repos"], "deny": [], "ask": [], "unknownPolicy": "deny"},
            sandbox_fields={"captureNetworkBodies": True},
        ),
    )


async def _pause_native_stream(
    addon_context: taddons.context,
    monkeypatch: pytest.MonkeyPatch,
    *,
    alpn: bytes,
    phase: Phase,
    original_transport_error: bool = False,
) -> tuple[HttpStream, http.HTTPFlow, GetHttpConnection, list[commands.Command], AsyncMock]:
    _, http_layer = start_http_layer(
        addon_context, alpn=alpn, host=_HOST, server_host="104.18.32.47", mode=HTTPMode.transparent
    )
    stream = HttpStream(http_layer.context.fork(), 1)
    list(stream.handle_event(events.Start()))
    body = _BODY if phase == "headers" else _BODY.rstrip(b" ")
    request = tutils.treq(
        scheme=b"https",
        method=b"POST",
        host=_HOST.encode(),
        port=443,
        path=b"/repos/okou-ai/okou",
        http_version=b"HTTP/2.0" if alpn == b"h2" else b"HTTP/1.1",
        headers=http.Headers(
            ((b"Host", _AUTHORITY.encode()), (b"Content-Length", str(len(body)).encode()))
        ),
        content=b"",
    )
    if alpn == b"h2":
        request.authority = _AUTHORITY
    history = list(stream.handle_event(RequestHeaders(1, request, end_stream=False)))
    headers_hook = next(cmd for cmd in history if isinstance(cmd, HttpRequestHeadersHook))
    flow = headers_hook.flow
    mark_connected_tls_upstream(
        flow, sni=_HOST, server_address=("104.18.32.47", 443), peername=("104.18.32.47", 443)
    )
    original_server = flow.server_conn

    async def resolve(*_args, **_kwargs):
        assert upstream_destination_binding.has_server_binding(original_server)
        assert "Authorization" not in flow.request.headers
        original_server.state = connection.ConnectionState.CLOSED
        if original_transport_error:
            original_server.error = "synthetic original acquisition failure"
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
        history.extend(stream.handle_event(RequestData(1, body)))
        pending = list(stream.handle_event(RequestEndOfMessage(1)))
        history.extend(pending)
        request_hook = next(cmd for cmd in pending if isinstance(cmd, HttpRequestHook))
        await addon_context.master.addons.invoke_addon(mitm_addon, request_hook)
        pending = list(stream.handle_event(events.HookCompleted(request_hook, None)))
        history.extend(pending)
    assert flow.response is None, flow.response.get_text() if flow.response else ""
    assert flow.server_conn is original_server
    assert flow.error is None
    assert original_server.error == (
        "synthetic original acquisition failure" if original_transport_error else None
    )
    assert not upstream_destination_binding.has_server_binding(original_server)
    get_connection = next(cmd for cmd in pending if isinstance(cmd, GetHttpConnection))
    assert get_connection.address == (_HOST, 443)
    assert get_connection.tls
    assert flow.request.headers["Host"] == _AUTHORITY
    assert not any(isinstance(cmd, SendHttp) for cmd in history)
    return stream, flow, get_connection, history, fetch


@pytest.mark.parametrize("alpn", [b"http/1.1", b"h2"])
@pytest.mark.parametrize("phase", ["buffered", "headers"])
@pytest.mark.parametrize("original_transport_error", [False, True])
async def test_native_acquisition_preserves_request_and_sends_once(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    alpn: bytes,
    phase: Phase,
    original_transport_error: bool,
) -> None:
    registry_path = _write_recovery_registry(tmp_path)
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        addon_context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry_path)
        )
        stream, flow, get_connection, history, fetch = await _pause_native_stream(
            addon_context,
            monkeypatch,
            alpn=alpn,
            phase=phase,
            original_transport_error=original_transport_error,
        )
        replacement = connection.Server(address=(_HOST, 443), tls=True)
        proof_flow = http.HTTPFlow(flow.client_conn, replacement)
        mark_connected_tls_upstream(
            proof_flow, sni=_HOST, server_address=(_HOST, 443), peername=("104.18.33.47", 443)
        )
        history.extend(
            stream.handle_event(GetHttpConnectionCompleted(get_connection, (replacement, None)))
        )
        if phase == "headers":
            history.extend(stream.handle_event(RequestData(1, _BODY)))
            pending = list(stream.handle_event(RequestEndOfMessage(1)))
            history.extend(pending)
            request_hook = next(cmd for cmd in pending if isinstance(cmd, HttpRequestHook))
            await addon_context.master.addons.invoke_addon(mitm_addon, request_hook)
            history.extend(stream.handle_event(events.HookCompleted(request_hook, None)))
        fetch.assert_awaited_once()
        body = _BODY if phase == "headers" else _BODY.rstrip(b" ")
        sends = [cmd for cmd in history if isinstance(cmd, SendHttp)]
        heads = [cmd for cmd in sends if isinstance(cmd.event, RequestHeaders)]
        assert len(heads) == 1
        assert all(cmd.connection is replacement for cmd in sends)
        head = heads[0].event
        assert isinstance(head, RequestHeaders)
        assert head.request.headers["Authorization"] == _TOKEN
        assert head.request.headers["Host"] == _AUTHORITY
        if alpn == b"h2":
            assert head.request.authority == _AUTHORITY
        assert (
            b"".join(cmd.event.data for cmd in sends if isinstance(cmd.event, RequestData)) == body
        )
        assert len([cmd for cmd in sends if isinstance(cmd.event, RequestEndOfMessage)]) == 1
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
        [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
        assert entry["url"] == f"https://{_HOST}/repos/okou-ai/okou"
        assert "synthetic-query" not in json.dumps(entry)
        assert _TOKEN not in json.dumps(entry)


@pytest.mark.parametrize("alpn", [b"http/1.1", b"h2"])
@pytest.mark.parametrize("pool_case", ["empty", "unrelated", "closed", "verified"])
@pytest.mark.parametrize("original_transport_error", [False, True])
async def test_normal_factory_selects_authorized_tls_destination(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    alpn: bytes,
    pool_case: str,
    original_transport_error: bool,
) -> None:
    registry_path = _write_recovery_registry(tmp_path)
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        addon_context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry_path)
        )
        stream, flow, get_connection, _, _ = await _pause_native_stream(
            addon_context,
            monkeypatch,
            alpn=alpn,
            phase="headers",
            original_transport_error=original_transport_error,
        )
        parent = stream.context.layers[-2]
        assert isinstance(parent, HttpLayer)
        pooled = None
        if pool_case != "empty":
            pool_host = "other.example" if pool_case == "unrelated" else _HOST
            pooled = connection.Server(address=(pool_host, 443), tls=True)
            proof_flow = http.HTTPFlow(flow.client_conn, pooled)
            mark_connected_tls_upstream(
                proof_flow,
                sni=pool_host,
                server_address=(pool_host, 443),
                peername=("104.18.33.47", 443),
            )
            pooled.alpn = alpn
            pool_context = parent.context.fork()
            pool_context.server = pooled
            pool_layer = HttpClient(pool_context)
            parent.connections[pooled] = pool_layer
            parent.waiting_for_establishment[pooled] = []
            list(parent.event_to_child(pool_layer, events.Start()))
            if pool_case == "closed":
                pooled.state = connection.ConnectionState.CLOSED
        parent.command_sources[get_connection] = stream
        selected = list(parent.get_connection(get_connection))
        opening = [cmd for cmd in selected if isinstance(cmd, commands.OpenConnection)]
        if pool_case == "verified":
            assert not opening
            assert flow.server_conn is pooled
            assert any(isinstance(cmd, commands.SendData) for cmd in selected)
        else:
            assert len(opening) == 1
            assert opening[0].connection.address == (_HOST, 443)
            assert opening[0].connection.sni == _HOST
            assert not any(isinstance(cmd, SendHttp) for cmd in selected)
        if pooled is not None:
            assert pooled in parent.connections
            assert parent.connections[pooled] is pool_layer
        mitm_addon.error(flow)
