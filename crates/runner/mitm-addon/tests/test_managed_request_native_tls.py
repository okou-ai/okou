"""Managed spooling resumes real native connection acquisition and TLS."""

import json
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
from mitmproxy.proxy.layers.http import HTTPMode
from mitmproxy.proxy.layers.http._hooks import HttpRequestHeadersHook
from mitmproxy.proxy.layers.tls import TlsEstablishedServerHook
from mitmproxy.test import taddons
from OpenSSL import SSL

import managed_openrouter as managed
import mitm_addon
from tests.managed_openrouter_helpers import PATHS, PI_ATTRIBUTION_HEADERS, payload, sandbox
from tests.mitmproxy_http_framing_helpers import start_http_layer
from tests.request_handler_helpers import _write_registry
from tests.test_mitmproxy_auth_wait_tls import _tls_material
from tests.upstream_connection_helpers import mark_connected_tls_upstream


@pytest.mark.parametrize("dialect", ["openai-completions", "openai-responses"])
@pytest.mark.parametrize("upstream_alpn", [b"http/1.1", b"h2"])
@pytest.mark.parametrize("connection_case", ["unconnected", "auth-disconnect"])
@pytest.mark.parametrize("certificate_case", ["valid", "wrong-host", "untrusted"])
async def test_managed_body_acquires_tls_connection_and_receives_response(
    tmp_path, fake_firewall_headers, dialect, upstream_alpn, connection_case, certificate_case
):
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path, dialect))
    trusted_ca, server_context = _tls_material(
        tmp_path, certificate_case, server_hostname=managed.HOST
    )
    server_context.set_alpn_select_callback(lambda _ssl, _offers: upstream_alpn)
    tls_peer = SSL.Connection(server_context)
    tls_peer.set_accept_state()
    http2 = H2Connection(H2Configuration(client_side=False))
    value = payload(dialect)
    value["messages" if dialect == "openai-completions" else "input"][0]["content"] = "x" * 40000
    body = json.dumps(value).encode()
    wire = (
        b"POST "
        + PATHS[dialect].encode()
        + b" HTTP/1.1\r\nHost: openrouter.ai\r\nContent-Type: application/json\r\nContent-Length: "
        + str(len(body)).encode()
        + b"\r\n"
        + b"".join(f"{key}: {value}\r\n".encode() for key, value in PI_ATTRIBUTION_HEADERS)
        + b"\r\n"
        + body
    )
    downstream, plaintext, forwarded = bytearray(), bytearray(), bytearray()
    request_headers = {}
    response_sent = False
    tls_established = False
    http2_started = False
    upstream = None
    flow = None
    tls_config = TlsConfig()
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), tls_config, mitm_addon) as context,
        fake_firewall_headers(headers={"Authorization": "Bearer native-managed-tls"}) as auth,
    ):
        context.options.update(
            confdir=str(tmp_path / "conf"),
            okou_api_url="https://api.okou.ai",
            okou_proxy_registry_path=str(registry),
            ssl_insecure=False,
            ssl_verify_upstream_trusted_ca=str(trusted_ca),
        )
        client, native = start_http_layer(
            context,
            alpn=b"http/1.1",
            host=managed.HOST,
            server_host="104.18.32.47",
            mode=HTTPMode.transparent,
        )
        client.sockname = ("104.18.32.47", 443)
        client.alpn_offers = (upstream_alpn,)
        mitm_addon.server_connect(SimpleNamespace(client=client, server=native.context.server))

        async def resolve_auth(*_args, **_kwargs):
            assert flow is not None
            if connection_case == "auth-disconnect":
                flow.server_conn.state = connection.ConnectionState.CLOSED
                mitm_addon.server_disconnected(SimpleNamespace(server=flow.server_conn))
            return auth.return_value

        auth.side_effect = resolve_auth
        pending = deque(native.handle_event(events.DataReceived(client, wire)))
        steps = 0
        while pending:
            steps += 1
            assert steps < 1000, "native managed TLS did not settle"
            command = pending.popleft()
            if isinstance(command, commands.StartHook):
                if isinstance(command, HttpRequestHeadersHook):
                    flow = command.flow
                    if connection_case == "auth-disconnect":
                        mark_connected_tls_upstream(
                            flow,
                            sni=managed.HOST,
                            server_address=(managed.HOST, 443),
                            peername=("104.18.32.47", 443),
                        )
                if isinstance(command, TlsEstablishedServerHook):
                    tls_established = True
                await context.master.addons.invoke_addon(tls_config, command)
                await context.master.addons.invoke_addon(mitm_addon, command)
                pending.extend(native.handle_event(events.HookCompleted(command, None)))
            elif isinstance(command, commands.OpenConnection):
                auth.assert_awaited_once()
                upstream = command.connection
                assert upstream.address == (managed.HOST, 443)
                assert upstream.sni == managed.HOST
                upstream.state = connection.ConnectionState.OPEN
                upstream.peername = ("104.18.32.47", 443)
                pending.extend(native.handle_event(events.OpenConnectionCompleted(command, None)))
            elif isinstance(command, commands.SendData):
                if command.connection is client:
                    downstream.extend(command.data)
                    continue
                assert upstream is not None
                assert command.connection is upstream
                tls_peer.bio_write(command.data)
                try:
                    tls_peer.do_handshake()
                    if upstream_alpn == b"h2" and not http2_started:
                        http2_started = True
                        http2.initiate_connection()
                        tls_peer.send(http2.data_to_send())
                    while True:
                        chunk = tls_peer.recv(65536)
                        assert tls_established
                        if upstream_alpn == b"http/1.1":
                            plaintext.extend(chunk)
                            if b"\r\n\r\n" in plaintext:
                                head, content = bytes(plaintext).split(b"\r\n\r\n", 1)
                                if len(content) == len(body) and not response_sent:
                                    request_headers = {
                                        key.lower(): value.strip()
                                        for key, value in (
                                            line.split(b":", 1) for line in head.split(b"\r\n")[1:]
                                        )
                                    }
                                    forwarded.extend(content)
                                    response_sent = True
                                    tls_peer.send(
                                        b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                                        b"Content-Length: 2\r\n\r\n{}"
                                    )
                        else:
                            for event in http2.receive_data(chunk):
                                if isinstance(event, RequestReceived):
                                    request_headers = dict(event.headers)
                                elif isinstance(event, DataReceived):
                                    forwarded.extend(event.data)
                                    http2.acknowledge_received_data(
                                        event.flow_controlled_length, event.stream_id
                                    )
                                elif isinstance(event, StreamEnded):
                                    response_sent = True
                                    http2.send_headers(
                                        event.stream_id,
                                        [(b":status", b"200"), (b"content-length", b"2")],
                                    )
                                    http2.send_data(event.stream_id, b"{}", end_stream=True)
                            outgoing = http2.data_to_send()
                            if outgoing:
                                tls_peer.send(outgoing)
                except SSL.WantReadError:
                    pass
                except SSL.Error:
                    assert certificate_case != "valid"
                try:
                    outgoing = tls_peer.bio_read(65536)
                except SSL.WantReadError:
                    continue
                pending.extend(native.handle_event(events.DataReceived(upstream, outgoing)))
        assert flow is not None
        if certificate_case != "valid":
            assert upstream is not None
            assert upstream.error is not None
            assert "certificate verify failed" in upstream.error.lower()
            assert not tls_established
            assert not request_headers
            assert not forwarded
            assert not plaintext
            assert downstream.startswith(b"HTTP/1.1 502")
            assert managed.admission_state_for_tests() == (0, 0)
            return
        assert flow.error is None
        assert flow.response is None or flow.response.status_code == 200, flow.response.get_text()
        assert tls_established
        assert request_headers[b"authorization"] == b"Bearer native-managed-tls"
        assert request_headers[b"content-length"] == str(len(body)).encode()
        assert bytes(forwarded) == body
        assert response_sent
        assert downstream.startswith(b"HTTP/1.1 200")
        assert downstream.endswith(b"\r\n\r\n{}")
        assert managed.admission_state_for_tests() == (0, 0)
