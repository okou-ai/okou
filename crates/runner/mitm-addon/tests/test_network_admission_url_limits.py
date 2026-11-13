"""Bound network admission work through native HTTP and genuine auth transport."""

import json
from pathlib import Path
from unittest.mock import patch

import pytest
from mitmproxy import connection, http
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.proxy import commands, events
from mitmproxy.proxy.layers.http import HTTPMode
from mitmproxy.proxy.layers.http._hooks import HttpRequestHeadersHook, HttpRequestHook
from mitmproxy.test import taddons

import firewall_auth_client
import flow_metadata_keys as metadata_keys
import managed_upload
import mitm_addon
from tests.auth_endpoint_helpers import FakeAuthEndpoint, firewall_auth_success_response
from tests.mitmproxy_http_framing_helpers import CLIENT_IP, start_http_layer
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry
from tests.upstream_connection_helpers import mark_connected_tls_upstream

_HOST = "custom.example.test"
_PORT = 8443
_ORIGIN = f"https://{_HOST}:{_PORT}"
_URL_LIMIT = 65_536
_CONFIG_ID = "550e8400-e29b-41d4-a716-446655440002"
_APP_HEADERS = {"Authorization": "Bearer synthetic-app"}
_NETWORK_HEADERS = {
    "CF-Access-Client-Id": "synthetic-client",
    "CF-Access-Client-Secret": "synthetic-network",
}


def _registry(tmp_path: Path, *, application_auth: bool, network: bool = True) -> Path:
    entry = {
        "id": "custom_network:0",
        "base": f"{_ORIGIN}/api/",
        "auth": {"headers": {"Authorization": "Bearer ${{ secrets.APP }}"}}
        if application_auth
        else {},
    }
    if network:
        entry["networkIntent"] = {
            "kind": "cloudflare_access",
            "configId": _CONFIG_ID,
            "generation": 1,
        }
    return _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            custom_connector_id="550e8400-e29b-41d4-a716-446655440000",
            firewall_name="custom_network",
            include_encrypted_secrets=application_auth,
            api_entry=entry,
            network_policy={"allow": [], "deny": [], "ask": [], "unknownPolicy": "allow"},
        ),
    )


def _queue_auth(endpoint: FakeAuthEndpoint, *, application_auth: bool) -> None:
    endpoint.queue_json_response(
        firewall_auth_success_response({})
        | {
            "networkAdmission": {
                "kind": "cloudflare_access",
                "configId": _CONFIG_ID,
                "generation": 1,
                "headers": _NETWORK_HEADERS,
            }
        }
    )
    if application_auth:
        endpoint.queue_json_response(firewall_auth_success_response(_APP_HEADERS))


@pytest.fixture
def network_serializations(monkeypatch):
    """Observe real serialization, excluding URL-free application identity work."""
    urls = []
    original = firewall_auth_client.FirewallAuthRequest.to_bytes

    def to_bytes(request, *, force_refresh=False):
        if request.network_admission:
            urls.append(request.network_request["url"])
        return original(request, force_refresh=force_refresh)

    monkeypatch.setattr(firewall_auth_client.FirewallAuthRequest, "to_bytes", to_bytes)
    return urls


def _target(case: str) -> bytes:
    prefix = "/api/items?q="
    size = 1024 * 1024 if case == "large" else _URL_LIMIT + int(case.endswith("over"))
    units = size - len(_ORIGIN) - len(prefix)
    character = "界" if case.startswith("bmp-") else "🙂" if case.startswith("astral-") else "x"
    width = 2 if case.startswith("astral-") else 1
    value = (character * (units // width) + "x" * (units % width)).encode()
    return prefix.encode() + value


@pytest.mark.parametrize("hook_phase", ["requestheaders", "request"])
@pytest.mark.parametrize("warm_cache", [False, True], ids=["cold", "warm"])
@pytest.mark.parametrize(
    "case",
    [
        "exact",
        "over",
        "large",
        "bmp-exact",
        "bmp-over",
        "astral-exact",
        "astral-over",
    ],
)
async def test_native_network_admission_url_limit(
    tmp_path, real_flow, network_serializations, hook_phase, warm_cache, case
):
    # The large case also proves that rejection precedes application credentials.
    application_auth = case == "large"
    registry_path = _registry(tmp_path, application_auth=application_auth)
    target = _target(case)
    trusted_url = _ORIGIN + target.decode("utf-8", "surrogateescape")
    rejected = case.endswith("over") or case == "large"
    endpoint = FakeAuthEndpoint()
    if warm_cache or not rejected:
        _queue_auth(endpoint, application_auth=application_auth)

    with (
        endpoint.run(),
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as context,
    ):
        context.options.update(
            okou_api_url=endpoint.api_url, okou_proxy_registry_path=str(registry_path)
        )
        if warm_cache:
            warm = real_flow(
                with_response=False,
                client_ip=CLIENT_IP,
                host="8.8.8.8",
                port=_PORT,
                sni=_HOST,
                path="/api/items?warm=1",
            )
            warm.request.headers["Host"] = f"{_HOST}:{_PORT}"
            mark_connected_tls_upstream(
                warm, sni=_HOST, server_address=("8.8.8.8", _PORT), peername=("8.8.8.8", _PORT)
            )
            await mitm_addon.request(warm)
            assert warm.response is None
            assert (
                warm.request.headers["CF-Access-Client-Secret"]
                == _NETWORK_HEADERS["CF-Access-Client-Secret"]
            )
            warm.response = http.Response.make(200, b"ok")
            mitm_addon.response(warm)
        calls_before = endpoint.request_count
        serializations_before = len(network_serializations)

        client, native = start_http_layer(
            context,
            alpn=b"http/1.1",
            host=_HOST,
            server_host="8.8.8.8",
            server_port=_PORT,
            mode=HTTPMode.transparent,
        )
        # No body or EOF arrives for the header-phase oversized upload.
        length = 1048576 if hook_phase == "requestheaders" and rejected else 0
        head = (
            f"GET {_ORIGIN}".encode()
            + target
            + f" HTTP/1.1\r\nHost: {_HOST}:{_PORT}\r\n".encode()
            + b"Authorization: client-value\r\n"
            + f"Content-Length: {length}\r\n\r\n".encode()
        )
        history = []
        for offset in range(0, len(head), 16 * 1024):
            history.extend(
                native.handle_event(events.DataReceived(client, head[offset : offset + 16 * 1024]))
            )
        [headers_hook] = [cmd for cmd in history if isinstance(cmd, HttpRequestHeadersHook)]
        flow = headers_hook.flow
        assert flow.request.host == "8.8.8.8"
        assert flow.request.data.path == target
        mark_connected_tls_upstream(
            flow, sni=_HOST, server_address=("8.8.8.8", _PORT), peername=("8.8.8.8", _PORT)
        )
        original_headers = flow.request.headers.fields
        subject_hook = headers_hook
        if hook_phase == "request":
            # Exercise the buffered public entry point on the natively parsed
            # request, independently of the earlier header-auth entry point.
            pending = list(native.handle_event(events.HookCompleted(headers_hook)))
            history.extend(pending)
            [subject_hook] = [cmd for cmd in pending if isinstance(cmd, HttpRequestHook)]
        await context.master.addons.invoke_addon(mitm_addon, subject_hook)

        if rejected:
            assert flow.response is not None
            assert flow.response.status_code == 414
            assert flow.response.content is not None
            assert json.loads(flow.response.content)["error"] == "network_admission_url_too_large"
            assert len(flow.response.content) < 1024
            assert flow.request.data.path == target
            assert flow.request.headers.fields == original_headers
            assert endpoint.request_count == calls_before
            assert len(network_serializations) == serializations_before
        else:
            assert flow.response is None
            assert (
                flow.request.headers["CF-Access-Client-Secret"]
                == _NETWORK_HEADERS["CF-Access-Client-Secret"]
            )
            assert endpoint.request_count == calls_before + int(not warm_cache)
            assert len(network_serializations) == serializations_before + int(not warm_cache)
            if not warm_cache:
                assert network_serializations[-1] == trusted_url
                network_request = endpoint.requests[-1].json_body()["networkRequest"]
                assert isinstance(network_request, dict)
                assert network_request["url"] == trusted_url
            # Complete accepted cases at the local auth checkpoint, without a provider.
            flow.response = http.Response.make(200, b"ok")

        pending = list(native.handle_event(events.HookCompleted(subject_hook)))
        while pending:
            command = pending.pop(0)
            history.append(command)
            if isinstance(command, commands.StartHook):
                await context.master.addons.invoke_addon(mitm_addon, command)
                pending.extend(native.handle_event(events.HookCompleted(command)))
        client_bytes = b"".join(
            cmd.data
            for cmd in history
            if isinstance(cmd, commands.SendData) and cmd.connection is client
        )
        assert client_bytes.startswith(b"HTTP/1.1 414" if rejected else b"HTTP/1.1 200")
        if rejected:
            assert b'"error": "network_admission_url_too_large"' in client_bytes
        assert not any(
            isinstance(cmd, (commands.OpenConnection, commands.SendData))
            and isinstance(cmd.connection, connection.Server)
            for cmd in history
        )
        assert not flow.live
        assert flow.error is None
        assert not native.streams
        assert managed_upload.get(flow) is None
        assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
        if rejected and hook_phase == "requestheaders":
            assert flow.request.raw_content is None
            assert not any(isinstance(cmd, HttpRequestHook) for cmd in history)


@pytest.mark.parametrize("hook_phase", ["requestheaders", "request"])
async def test_network_url_limit_does_not_restrict_independent_application_auth(
    tmp_path, real_flow, mitm_ctx, network_serializations, hook_phase
):
    registry_path = _registry(tmp_path, application_auth=True, network=False)
    flow = real_flow(
        with_response=False,
        client_ip=CLIENT_IP,
        host=_HOST,
        port=_PORT,
        path=_target("large").decode(),
    )
    flow.request.headers["Host"] = f"{_HOST}:{_PORT}"
    mark_connected_tls_upstream(
        flow, sni=_HOST, server_address=("8.8.8.8", _PORT), peername=("8.8.8.8", _PORT)
    )
    endpoint = FakeAuthEndpoint()
    endpoint.queue_json_response(firewall_auth_success_response(_APP_HEADERS))
    with endpoint.run(), mitm_ctx(registry_path=str(registry_path), api_url=endpoint.api_url):
        if hook_phase == "requestheaders":
            continuation = mitm_addon.requestheaders(flow)
            if continuation is not None:
                await continuation
        else:
            await mitm_addon.request(flow)
        assert flow.response is None
        assert flow.request.headers["Authorization"] == _APP_HEADERS["Authorization"]
        assert endpoint.request_count == 1
        assert network_serializations == []
        flow.response = http.Response.make(200, b"ok")
        mitm_addon.response(flow)
