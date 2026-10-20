"""Real pinned TLS acquisition protects the streamed credential boundary."""

from collections import deque
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from h2.config import H2Configuration
from h2.connection import H2Connection
from h2.events import DataReceived, RequestReceived, StreamEnded
from mitmproxy import connection
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.addons.tlsconfig import TlsConfig
from mitmproxy.proxy import commands, events
from mitmproxy.proxy.layers.http._hooks import HttpRequestHeadersHook
from mitmproxy.proxy.layers.tls import TlsEstablishedServerHook
from mitmproxy.test import taddons
from OpenSSL import SSL

import managed_upload
import mitm_addon
from tests.managed_openrouter_helpers import PATHS, PRESET, sandbox
from tests.managed_wire_helpers import WireSession
from tests.request_handler_helpers import _write_registry
from tests.test_mitmproxy_auth_wait_tls import _tls_material


@pytest.mark.parametrize("alpn", [b"http/1.1", b"h2"])
@pytest.mark.parametrize("certificate", ["valid", "wrong-host", "untrusted"])
async def test_native_managed_tls_checks_before_http_credentials(
    tmp_path, fake_firewall_headers, alpn, certificate
):
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path))
    ca, tls_context = _tls_material(tmp_path, certificate, hostname="openrouter.ai")
    tls_context.set_alpn_select_callback(lambda _peer, _offers: alpn)
    provider = SSL.Connection(tls_context)
    provider.set_accept_state()
    h2 = H2Connection(H2Configuration(client_side=False, header_encoding=None))
    h2.initiate_connection()
    body = b'{"model":"' + PRESET.encode() + b'","messages":[]}'
    wire = (
        b"POST "
        + PATHS["openai-completions"].encode()
        + b" HTTP/1.1\r\nHost: openrouter.ai\r\nContent-Type: application/json\r\nContent-Length: "
        + str(len(body)).encode()
        + b"\r\n\r\n"
        + body
    )
    tls = TlsConfig()
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), tls, mitm_addon) as context,
        fake_firewall_headers(headers={"Authorization": "Bearer verified-managed-tls"}) as fetch,
    ):
        context.options.update(
            confdir=str(tmp_path / "conf"),
            okou_api_url="https://api.okou.ai",
            okou_proxy_registry_path=str(registry),
            ssl_insecure=False,
            ssl_verify_upstream_trusted_ca=str(ca),
        )
        driver = WireSession(context)
        native = driver.native
        native.context.client.alpn_offers = (alpn,)
        mitm_addon.server_connect(
            SimpleNamespace(client=native.context.client, server=native.context.server)
        )
        pending = deque(native.handle_event(events.DataReceived(native.context.client, wire)))
        plaintext = bytearray()
        established = False
        flow = None
        upstream = None
        while pending:
            command = pending.popleft()
            if isinstance(command, commands.StartHook):
                if isinstance(command, HttpRequestHeadersHook):
                    flow = command.flow
                if isinstance(command, TlsEstablishedServerHook):
                    established = True
                await context.master.addons.invoke_addon(tls, command)
                await context.master.addons.invoke_addon(mitm_addon, command)
                pending.extend(native.handle_event(events.HookCompleted(command)))
            elif isinstance(command, commands.OpenConnection):
                fetch.assert_awaited_once()
                upstream = command.connection
                upstream.state = connection.ConnectionState.OPEN
                upstream.peername = ("104.18.32.47", 443)
                pending.extend(native.handle_event(events.OpenConnectionCompleted(command, None)))
            elif (
                isinstance(command, commands.SendData)
                and command.connection is not native.context.client
            ):
                assert upstream is not None
                provider.bio_write(command.data)
                try:
                    provider.do_handshake()
                    while True:
                        raw = provider.recv(65536)
                        assert established
                        plaintext.extend(raw)
                except SSL.WantReadError:
                    pass
                except SSL.Error:
                    assert certificate != "valid"
                try:
                    reply = provider.bio_read(65536)
                except SSL.WantReadError:
                    continue
                pending.extend(native.handle_event(events.DataReceived(upstream, reply)))
        assert flow is not None
        assert upstream is not None
        if certificate != "valid":
            assert not established
            assert not plaintext
            assert upstream.error is not None
            assert "certificate verify failed" in upstream.error.lower()
            assert managed_upload.get(flow) is None
        else:
            assert established
            if alpn == b"h2":
                request_events = h2.receive_data(bytes(plaintext))
                [headers] = [e for e in request_events if isinstance(e, RequestReceived)]
                assert dict(headers.headers)[b"authorization"] == b"Bearer verified-managed-tls"
                assert (
                    b"".join(e.data for e in request_events if isinstance(e, DataReceived)) == body
                )
                assert any(isinstance(e, StreamEnded) for e in request_events)
            else:
                headers, payload = bytes(plaintext).split(b"\r\n\r\n", 1)
                assert b"authorization: bearer verified-managed-tls" in headers.lower()
                assert payload == body
            assert flow.request.raw_content is None
            mitm_addon.error(flow)
            assert managed_upload.get(flow) is None
