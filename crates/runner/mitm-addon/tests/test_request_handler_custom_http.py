"""Custom HTTP APIs recover domain authority only with pinned public IP proof."""

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
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.mitmproxy_http_framing_helpers import start_http_layer
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry
from tests.requestheaders_helpers import await_requestheaders_result

_CUSTOM_ID = "550e8400-e29b-41d4-a716-446655440000"
_HOST = "api.example.com"
_IP = "93.184.215.14"


def _sandbox(tmp_path, *, auth_mode="headers", base=None, registered=True, denied=False) -> dict:
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
            "allow": [] if denied else ["items"],
            "deny": ["items"] if denied else [],
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


def _flow(real_flow, headers, *, ip=_IP, host=_HOST, port=80, connected=False, path="/v1/items"):
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host=ip,
        port=port,
        scheme="http",
        method="POST",
        path=path,
        request_body=b'{"hello":"world"}',
        request_headers=headers(
            ("Host", host if port == 80 else f"{host}:{port}"),
            ("Content-Length", "17"),
        ),
    )
    if connected:
        flow.server_conn.state = connection.ConnectionState.OPEN
        flow.server_conn.peername = (ip, port)
    return flow


@pytest.mark.parametrize("auth_mode", ["none", "headers", "query"])
@pytest.mark.parametrize("connected", [False, True])
@pytest.mark.parametrize("with_headers", [False, True])
async def test_domain_http_connector_uses_real_authority_and_pinned_ip(
    tmp_path, real_flow, headers, mitm_ctx, monkeypatch, dns, auth_mode, connected, with_headers
):
    reg = _write_registry(tmp_path, sandbox_info=_sandbox(tmp_path, auth_mode=auth_mode))
    flow = _flow(real_flow, headers, host="API.EXAMPLE.COM.", connected=connected)
    fetch = AsyncMock(
        return_value=firewall_auth_response(
            headers={"Authorization": "Bearer synthetic"} if auth_mode == "headers" else {},
            query={"api_key": "synthetic-query"} if auth_mode == "query" else {},
        )
    )
    monkeypatch.setattr(auth, "get_firewall_headers", fetch)
    with mitm_ctx(registry_path=str(reg)):
        if with_headers:
            await await_requestheaders_result(mitm_addon.requestheaders(flow))
            assert not flow.request.stream
        await mitm_addon.request(flow)
        assert flow.response is None
        assert flow.metadata[metadata_keys.FIREWALL_BASE] == f"http://{_HOST}/v1"
        assert flow.metadata[metadata_keys.FIREWALL_PERMISSION] == "items"
        assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
        assert flow.request.host == _IP
        assert flow.server_conn.address == (_IP, 80)
        assert not flow.server_conn.tls
        assert flow.request.headers["Host"] == "API.EXAMPLE.COM."
        if auth_mode == "none":
            fetch.assert_not_called()
        elif auth_mode == "headers":
            fetch.assert_awaited_once()
            assert flow.request.headers["Authorization"] == "Bearer synthetic"
        else:
            fetch.assert_awaited_once()
            assert flow.request.query["api_key"] == "synthetic-query"
        flow.response = http.Response.make(200)
        mitm_addon.response(flow)
    dns.assert_awaited_once_with(_HOST)
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["action"] == "ALLOW"
    assert "synthetic-query" not in entry["url"]


@pytest.mark.parametrize("auth_mode", ["none", "headers", "query"])
@pytest.mark.parametrize(
    ("ip", "answers"),
    [
        ("8.8.8.8", [_IP]),
        ("10.0.0.1", ["10.0.0.1"]),
        ("169.254.169.254", ["169.254.169.254"]),
        ("127.0.0.1", ["127.0.0.1"]),
        ("::1", ["::1"]),
        (_IP, [_IP, "10.0.0.1"]),
    ],
)
async def test_http_authority_cannot_claim_another_or_private_destination(
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
    assert "Authorization" not in flow.request.headers
    assert "api_key" not in flow.request.query


@pytest.mark.parametrize("auth_mode", ["none", "headers"])
async def test_http_domain_keeps_permission_denials(
    tmp_path, real_flow, headers, mitm_ctx, fake_firewall_headers, dns, auth_mode
):
    reg = _write_registry(
        tmp_path, sandbox_info=_sandbox(tmp_path, auth_mode=auth_mode, denied=True)
    )
    flow = _flow(real_flow, headers)
    with mitm_ctx(registry_path=str(reg)), fake_firewall_headers() as fetch:
        await mitm_addon.request(flow)
    fetch.assert_not_called()
    assert flow.response.status_code == 403
    assert json.loads(flow.response.content)["reason"] == "permission_denied"


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
    dns.assert_not_called()
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "insecure_transport"


async def test_noncustom_http_does_not_trust_host_globally(
    tmp_path, real_flow, headers, mitm_ctx, fake_firewall_headers, dns
):
    reg = _write_registry(tmp_path, sandbox_info=_sandbox(tmp_path, registered=False))
    flow = _flow(real_flow, headers)
    with mitm_ctx(registry_path=str(reg)), fake_firewall_headers() as fetch:
        await mitm_addon.request(flow)
    assert flow.response is None
    assert flow.metadata[metadata_keys.ORIGINAL_URL] == f"http://{_IP}/v1/items"
    fetch.assert_not_called()
    dns.assert_not_called()


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


@pytest.mark.parametrize(
    "mutation", ["destination", "authority", "permission", "run", "ownership", "owner"]
)
async def test_http_auth_wait_revalidates_destination_and_registry(
    tmp_path, real_flow, headers, mitm_ctx, monkeypatch, dns, mutation
):
    sandbox = _sandbox(tmp_path)
    reg = _write_registry(tmp_path, sandbox_info=sandbox)
    flow = _flow(real_flow, headers, connected=True)

    async def resolve(*_args, **_kwargs):
        if mutation == "destination":
            flow.server_conn.peername = ("8.8.8.8", 80)
        elif mutation == "authority":
            flow.request.headers["Host"] = "other.example.com"
        else:
            if mutation == "permission":
                sandbox["networkPolicies"]["custom-http"]["allow"] = []
                sandbox["networkPolicies"]["custom-http"]["deny"] = ["items"]
            elif mutation == "run":
                sandbox["runId"] = "replacement-run"
            elif mutation == "owner":
                replacement_id = "550e8400-e29b-41d4-a716-446655440001"
                replacement = _sandbox(tmp_path)["firewalls"][0]
                replacement["customConnectorId"] = replacement_id
                replacement["firewall"]["name"] = "replacement-owner"
                sandbox["firewalls"][0]["firewall"]["apis"][0]["base"] = f"http://{_HOST}/v2"
                sandbox["firewalls"].append(replacement)
                sandbox["connectorRuntimeTargets"].append(
                    {"kind": "custom", "customConnectorId": replacement_id}
                )
                sandbox["connectorRoutingVariables"][f"custom:{replacement_id}"] = {}
                sandbox["networkPolicies"]["replacement-owner"] = {
                    "allow": ["items"],
                    "deny": [],
                    "ask": [],
                    "unknownPolicy": "deny",
                }
            else:
                sandbox["connectorRuntimeTargets"] = []
            _write_registry(tmp_path, sandbox_info=sandbox)
        return firewall_auth_response(headers={"Authorization": "Bearer synthetic"})

    monkeypatch.setattr(auth, "get_firewall_headers", AsyncMock(side_effect=resolve))
    with mitm_ctx(registry_path=str(reg)):
        await mitm_addon.request(flow)
    assert flow.response.status_code == (409 if mutation in ("run", "owner") else 403)
    assert "Authorization" not in flow.request.headers


async def test_http_header_rejects_unbound_destination_before_body_streaming(
    tmp_path, real_flow, headers, mitm_ctx, fake_firewall_headers, dns
):
    reg = _write_registry(tmp_path, sandbox_info=_sandbox(tmp_path))
    flow = _flow(real_flow, headers, ip="8.8.8.8")
    with mitm_ctx(registry_path=str(reg)), fake_firewall_headers() as fetch:
        await await_requestheaders_result(mitm_addon.requestheaders(flow))
        await mitm_addon.request(flow)
    fetch.assert_not_called()
    assert flow.response.status_code == 403
    assert not flow.request.stream


@pytest.mark.parametrize("mutation", ["endpoint", "host"])
async def test_http_dns_wait_does_not_authorize_a_changed_request(
    tmp_path, real_flow, headers, mitm_ctx, fake_firewall_headers, dns, mutation
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
        if mutation == "endpoint":
            flow.server_conn.address = ("8.8.8.8", 80)
        else:
            flow.request.headers["Host"] = "other.example.com"
        release.set()
        await task
    fetch.assert_not_called()
    assert flow.response.status_code == 403


async def test_domain_http_connector_preserves_nondefault_port(
    tmp_path, real_flow, headers, mitm_ctx, fake_firewall_headers, dns
):
    reg = _write_registry(tmp_path, sandbox_info=_sandbox(tmp_path, base=f"http://{_HOST}:8080/v1"))
    flow = _flow(real_flow, headers, port=8080)
    with mitm_ctx(registry_path=str(reg)), fake_firewall_headers() as fetch:
        await mitm_addon.request(flow)
    fetch.assert_awaited_once()
    assert flow.response is None
    assert flow.request.headers["Authorization"] == "Bearer x"
    assert flow.request.headers["Host"] == f"{_HOST}:8080"
    assert flow.server_conn.address == (_IP, 8080)
    assert flow.metadata[metadata_keys.ORIGINAL_URL] == f"http://{_HOST}:8080/v1/items"
    dns.assert_awaited_once_with(_HOST)


@pytest.mark.parametrize("conflict", ["duplicate-host", "absolute-authority", "port"])
async def test_http_conflicting_assertions_cannot_resolve_managed_credentials(
    tmp_path, real_flow, headers, mitm_ctx, fake_firewall_headers, dns, conflict
):
    reg = _write_registry(tmp_path, sandbox_info=_sandbox(tmp_path))
    flow = _flow(real_flow, headers)
    if conflict == "duplicate-host":
        flow.request.headers.add("Host", "other.example.com")
    elif conflict == "absolute-authority":
        flow.request.authority = "other.example.com"
    else:
        flow.request.headers["Host"] = f"{_HOST}:81"
    with mitm_ctx(registry_path=str(reg)), fake_firewall_headers() as fetch:
        await mitm_addon.request(flow)
    fetch.assert_not_called()
    dns.assert_not_called()
    assert "Authorization" not in flow.request.headers
    assert flow.metadata[metadata_keys.ORIGINAL_URL] == f"http://{_IP}/v1/items"


@pytest.mark.parametrize("host", ["10.0.0.1", "other.example.com", "10.0.0.1,evil.example.com"])
async def test_noauth_http_ip_prefix_cannot_bypass_public_binding_with_host(
    tmp_path, real_flow, headers, mitm_ctx, fake_firewall_headers, dns, host
):
    reg = _write_registry(
        tmp_path,
        sandbox_info=_sandbox(tmp_path, auth_mode="none", base="http://10.0.0.1/v1"),
    )
    flow = _flow(real_flow, headers, ip="10.0.0.1", host=host)
    with mitm_ctx(registry_path=str(reg)), fake_firewall_headers() as fetch:
        await mitm_addon.request(flow)
    fetch.assert_not_called()
    assert flow.response.status_code == 403


async def test_http_dns_failure_does_not_admit_credentials(
    tmp_path, real_flow, headers, mitm_ctx, fake_firewall_headers, dns
):
    reg = _write_registry(tmp_path, sandbox_info=_sandbox(tmp_path))
    flow = _flow(real_flow, headers)
    dns.side_effect = OSError("synthetic DNS failure")
    with mitm_ctx(registry_path=str(reg)), fake_firewall_headers() as fetch:
        await mitm_addon.request(flow)
    fetch.assert_not_called()
    assert flow.response.status_code == 403


@pytest.mark.parametrize("alpn", [b"http/1.1", b"h2"])
@pytest.mark.parametrize("auth_mode", ["none", "headers", "query"])
async def test_native_http_acquisition_keeps_public_ip_and_wire_authority(
    tmp_path, monkeypatch, dns, alpn, auth_mode
):
    reg = _write_registry(tmp_path, sandbox_info=_sandbox(tmp_path, auth_mode=auth_mode))
    fetch = AsyncMock(
        return_value=firewall_auth_response(
            headers={"Authorization": "Bearer native-secret"} if auth_mode == "headers" else {},
            query={"api_key": "native-query-secret"} if auth_mode == "query" else {},
        )
    )
    monkeypatch.setattr(auth, "get_firewall_headers", fetch)
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
            server_port=80,
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
            port=80,
            path=b"/v1/items?caller=value",
            http_version=b"HTTP/2.0" if alpn == b"h2" else b"HTTP/1.1",
            headers=http.Headers(
                ((b"Host", _HOST.encode()), (b"Content-Length", str(len(body)).encode()))
            ),
            content=b"",
        )
        if alpn == b"h2":
            request.authority = _HOST
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
        assert acquire.address == (_IP, 80)
        assert not acquire.tls
        upstream = connection.Server(address=(_IP, 80), tls=False)
        upstream.state = connection.ConnectionState.OPEN
        upstream.peername = (_IP, 80)
        history.extend(stream.handle_event(GetHttpConnectionCompleted(acquire, (upstream, None))))
        sends = [cmd for cmd in history if isinstance(cmd, SendHttp)]
        [head] = [cmd.event for cmd in sends if isinstance(cmd.event, RequestHeaders)]
        assert head.request.headers["Host"] == _HOST
        if alpn == b"h2":
            assert head.request.authority == _HOST
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
