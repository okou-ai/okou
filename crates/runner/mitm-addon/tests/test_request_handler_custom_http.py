"""Custom HTTP API forwarding and its distinct public-destination boundary."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import mitmproxy_rs
import pytest
from mitmproxy import connection, http
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.proxy import events
from mitmproxy.proxy.layers.http import (
    GetHttpConnection,
    GetHttpConnectionCompleted,
    HTTPMode,
    HttpStream,
    SendHttp,
)
from mitmproxy.proxy.layers.http._events import RequestData, RequestEndOfMessage, RequestHeaders
from mitmproxy.proxy.layers.http._hooks import HttpRequestHeadersHook, HttpRequestHook
from mitmproxy.test import taddons, tutils

import auth
import flow_metadata_keys as metadata_keys
import mitm_addon
from tests.firewall_auth_helpers import firewall_auth_response
from tests.mitmproxy_http_framing_helpers import start_http_layer
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry

_CUSTOM_ID = "550e8400-e29b-41d4-a716-446655440000"
_HOST = "api.example.com"
_IP = "93.184.215.14"


def _sandbox(tmp_path, *, auth_mode="headers", base=None, registered=True) -> dict:
    auth_config = {}
    if auth_mode == "headers":
        auth_config = {"headers": {"Authorization": "Bearer ${{ secrets.TOKEN }}"}}
    elif auth_mode == "query":
        auth_config = {"query": {"api_key": "${{ secrets.TOKEN }}"}}
    return _single_firewall_sandbox(
        tmp_path,
        firewall_name="custom-http",
        api_entry={
            "base": base or f"http://{_HOST}/v1",
            "auth": auth_config,
            "permissions": [{"name": "items", "rules": ["ANY /items"]}],
        },
        network_policy={
            "allow": ["items"],
            "deny": [],
            "ask": [],
            "unknownPolicy": "deny",
        },
        custom_connector_id=_CUSTOM_ID,
        sandbox_fields={
            "connectorRuntimeTargets": (
                [{"kind": "custom", "customConnectorId": _CUSTOM_ID}] if registered else []
            ),
        },
    )


@pytest.fixture
def dns(monkeypatch):
    lookup = AsyncMock(return_value=[_IP])
    monkeypatch.setattr(mitmproxy_rs.dns, "DnsResolver", lambda: SimpleNamespace(lookup_ip=lookup))
    return lookup


def _flow(real_flow, headers, *, ip=_IP, host=_HOST, port=80):
    return real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host=ip,
        port=port,
        scheme="http",
        method="POST",
        path="/v1/items",
        request_body=b'{"hello":"world"}',
        request_headers=headers(
            ("Host", host if port == 80 else f"{host}:{port}"),
            ("Content-Length", "17"),
        ),
    )


@pytest.mark.parametrize(
    ("auth_mode", "ip", "answers"),
    [
        ("headers", "8.8.8.8", [_IP]),
        ("none", "10.0.0.1", ["10.0.0.1"]),
    ],
)
async def test_http_authority_requires_its_public_destination(
    tmp_path, real_flow, headers, mitm_ctx, fake_firewall_headers, dns, auth_mode, ip, answers
):
    dns.return_value = answers
    reg = _write_registry(tmp_path, sandbox_info=_sandbox(tmp_path, auth_mode=auth_mode))
    flow = _flow(real_flow, headers, ip=ip)
    with mitm_ctx(registry_path=str(reg)), fake_firewall_headers() as fetch:
        await mitm_addon.request(flow)
    fetch.assert_not_called()
    assert flow.response.status_code == 403
    assert json.loads(flow.response.content)["error"] == "authority_mismatch"


async def test_source_marker_and_custom_id_do_not_authorize_http_credentials(
    tmp_path, real_flow, headers, mitm_ctx, fake_firewall_headers, dns
):
    sandbox = _sandbox(tmp_path, registered=False, base=f"http://{_IP}/v1")
    sandbox["firewalls"][0]["firewall"]["_connectorRuntimeKind"] = "custom"
    reg = _write_registry(tmp_path, sandbox_info=sandbox)
    flow = _flow(real_flow, headers, host=_IP)
    with mitm_ctx(registry_path=str(reg)), fake_firewall_headers() as fetch:
        await mitm_addon.request(flow)
    fetch.assert_not_called()
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "insecure_transport"


@pytest.mark.parametrize("ip", [_IP, "2606:4700:4700::1111"])
async def test_http_ip_literal_and_nondefault_port_are_bound_without_dns(
    tmp_path, real_flow, headers, mitm_ctx, fake_firewall_headers, dns, ip
):
    host = f"[{ip}]" if ":" in ip else ip
    reg = _write_registry(tmp_path, sandbox_info=_sandbox(tmp_path, base=f"http://{host}:8080/v1"))
    flow = _flow(real_flow, headers, ip=ip, host=host, port=8080)
    with mitm_ctx(registry_path=str(reg)), fake_firewall_headers():
        await mitm_addon.request(flow)
    assert flow.response is None
    assert flow.request.headers["Authorization"] == "Bearer x"
    assert flow.server_conn.address == (ip, 8080)
    dns.assert_not_called()


@pytest.mark.parametrize("mutation", ["destination", "ownership"])
async def test_http_auth_wait_revalidates_destination_and_registry(
    tmp_path, real_flow, headers, mitm_ctx, monkeypatch, dns, mutation
):
    sandbox = _sandbox(tmp_path)
    reg = _write_registry(tmp_path, sandbox_info=sandbox)
    flow = _flow(real_flow, headers)
    flow.server_conn.state = connection.ConnectionState.OPEN
    flow.server_conn.peername = (_IP, 80)

    async def resolve(*_args, **_kwargs):
        if mutation == "destination":
            flow.server_conn.peername = ("8.8.8.8", 80)
        else:
            sandbox["connectorRuntimeTargets"] = []
            _write_registry(tmp_path, sandbox_info=sandbox)
        return firewall_auth_response(headers={"Authorization": "Bearer synthetic"})

    monkeypatch.setattr(auth, "get_firewall_headers", AsyncMock(side_effect=resolve))
    with mitm_ctx(registry_path=str(reg)):
        await mitm_addon.request(flow)
    assert flow.response.status_code == 403
    assert "Authorization" not in flow.request.headers


async def test_http_dns_wait_does_not_authorize_a_changed_destination(
    tmp_path, real_flow, headers, mitm_ctx, fake_firewall_headers, dns
):
    reg = _write_registry(tmp_path, sandbox_info=_sandbox(tmp_path))
    flow = _flow(real_flow, headers)
    entered, release = asyncio.Event(), asyncio.Event()

    async def lookup(_host):
        entered.set()
        await release.wait()
        return [_IP]

    dns.side_effect = lookup
    with mitm_ctx(registry_path=str(reg)), fake_firewall_headers() as fetch:
        task = asyncio.create_task(mitm_addon.request(flow))
        await entered.wait()
        flow.server_conn.address = ("8.8.8.8", 80)
        release.set()
        await task
    fetch.assert_not_called()
    assert flow.response.status_code == 403


@pytest.mark.parametrize(
    ("alpn", "auth_mode"),
    [(b"http/1.1", "none"), (b"http/1.1", "headers"), (b"h2", "query")],
)
async def test_native_http_acquisition_keeps_public_ip_and_wire_authority(
    tmp_path, monkeypatch, dns, alpn, auth_mode
):
    reg = _write_registry(
        tmp_path,
        sandbox_info=_sandbox(tmp_path, auth_mode=auth_mode, base=f"http://{_HOST}:8080/v1"),
    )
    fetch = AsyncMock(
        return_value=firewall_auth_response(
            headers={"Authorization": "Bearer native-secret"} if auth_mode == "headers" else {},
            query={"api_key": "native-query-secret"} if auth_mode == "query" else {},
        )
    )
    monkeypatch.setattr(auth, "get_firewall_headers", fetch)
    authority = f"{_HOST}:8080"
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        addon_context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(reg)
        )
        client, layer = start_http_layer(
            addon_context,
            alpn=alpn,
            host=_HOST,
            server_host=_IP,
            server_port=8080,
            mode=HTTPMode.transparent,
        )
        client.tls = False
        client.sni = None
        layer.context.server.tls = False
        stream = HttpStream(layer.context.fork(), 1)
        list(stream.handle_event(events.Start()))
        body = b'{"native":"body"}'
        request = tutils.treq(
            scheme=b"http",
            method=b"POST",
            host=_IP.encode(),
            port=8080,
            path=b"/v1/items?caller=value",
            http_version=b"HTTP/2.0" if alpn == b"h2" else b"HTTP/1.1",
            headers=http.Headers(
                ((b"Host", authority.encode()), (b"Content-Length", str(len(body)).encode()))
            ),
            content=b"",
        )
        if alpn == b"h2":
            request.authority = authority
        history = list(stream.handle_event(RequestHeaders(1, request, end_stream=False)))
        headers_hook = next(cmd for cmd in history if isinstance(cmd, HttpRequestHeadersHook))
        await addon_context.master.addons.invoke_addon(mitm_addon, headers_hook)
        history.extend(stream.handle_event(events.HookCompleted(headers_hook, None)))
        history.extend(stream.handle_event(RequestData(1, body)))
        pending = list(stream.handle_event(RequestEndOfMessage(1)))
        history.extend(pending)
        request_hook = next(cmd for cmd in pending if isinstance(cmd, HttpRequestHook))
        await addon_context.master.addons.invoke_addon(mitm_addon, request_hook)
        assert request_hook.flow.response is None
        pending = list(stream.handle_event(events.HookCompleted(request_hook, None)))
        history.extend(pending)
        acquire = next(cmd for cmd in pending if isinstance(cmd, GetHttpConnection))
        assert acquire.address == (_IP, 8080)
        assert not acquire.tls
        upstream = connection.Server(address=(_IP, 8080), tls=False)
        upstream.state = connection.ConnectionState.OPEN
        upstream.peername = (_IP, 8080)
        history.extend(stream.handle_event(GetHttpConnectionCompleted(acquire, (upstream, None))))
        sends = [cmd for cmd in history if isinstance(cmd, SendHttp)]
        [head] = [cmd.event for cmd in sends if isinstance(cmd.event, RequestHeaders)]
        assert head.request.headers["Host"] == authority
        if alpn == b"h2":
            assert head.request.authority == authority
        if auth_mode == "none":
            fetch.assert_not_called()
        elif auth_mode == "headers":
            assert head.request.headers["Authorization"] == "Bearer native-secret"
        else:
            assert head.request.query["api_key"] == "native-query-secret"
        assert head.request.query["caller"] == "value"
        assert all(cmd.connection is upstream for cmd in sends)
        assert (
            b"".join(cmd.event.data for cmd in sends if isinstance(cmd.event, RequestData)) == body
        )
        assert len([cmd for cmd in sends if isinstance(cmd.event, RequestEndOfMessage)]) == 1
