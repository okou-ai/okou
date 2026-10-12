"""Cryptographic TLS on native post-auth connection acquisition, without live networking."""

from collections import deque
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Literal
from unittest.mock import patch

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID
from h2.config import H2Configuration
from h2.connection import H2Connection
from h2.events import DataReceived, RequestReceived, StreamEnded
from mitmproxy import connection
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.addons.tlsconfig import TlsConfig
from mitmproxy.proxy import commands, events
from mitmproxy.proxy.layers.http import HttpLayer, SendHttp
from mitmproxy.proxy.layers.http._hooks import HttpErrorHook
from mitmproxy.proxy.layers.tls import (
    TlsEstablishedServerHook,
    TlsFailedServerHook,
    TlsStartServerHook,
)
from mitmproxy.test import taddons
from OpenSSL import SSL

import mitm_addon
from tests.test_mitmproxy_auth_wait_disconnect import (
    _BODY,
    _HOST,
    _TOKEN,
    _pause_native_stream,
    _write_recovery_registry,
)

type CertificateCase = Literal["valid", "wrong-host", "untrusted"]


def _tls_material(tmp_path: Path, certificate_case: CertificateCase) -> tuple[Path, SSL.Context]:
    now = datetime.now(UTC)
    trusted_key = ec.generate_private_key(ec.SECP256R1())
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Synthetic trust root")])
    root = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(trusted_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=1))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .sign(trusted_key, hashes.SHA256())
    )
    trusted_ca = tmp_path / "upstream-root.pem"
    trusted_ca.write_bytes(root.public_bytes(serialization.Encoding.PEM))
    signer = (
        ec.generate_private_key(ec.SECP256R1()) if certificate_case == "untrusted" else trusted_key
    )
    server_key = ec.generate_private_key(ec.SECP256R1())
    host = "other.example" if certificate_case == "wrong-host" else _HOST
    leaf = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, host)]))
        .issuer_name(subject)
        .public_key(server_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=1))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(host)]), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .sign(signer, hashes.SHA256())
    )
    server_context = SSL.Context(SSL.TLS_SERVER_METHOD)
    server_context.use_certificate(leaf)
    server_context.use_privatekey(server_key)
    return trusted_ca, server_context


@pytest.mark.parametrize("alpn", [b"http/1.1", b"h2"])
@pytest.mark.parametrize("certificate_case", ["valid", "wrong-host", "untrusted"])
async def test_native_tls_verifies_authorized_hostname_before_http(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    alpn: bytes,
    certificate_case: CertificateCase,
) -> None:
    registry_path = _write_recovery_registry(tmp_path)
    trusted_ca, server_context = _tls_material(tmp_path, certificate_case)
    server_context.set_alpn_select_callback(lambda _ssl, _offers: alpn)
    peer = SSL.Connection(server_context)
    peer.set_accept_state()
    plaintext = bytearray()
    tls_established = False
    tls_failed = False
    tls_config = TlsConfig()
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), tls_config, mitm_addon) as addon_context,
    ):
        addon_context.options.update(
            confdir=str(tmp_path / "conf"),
            okou_api_url="https://api.okou.ai",
            okou_proxy_registry_path=str(registry_path),
            ssl_insecure=False,
            ssl_verify_upstream_trusted_ca=str(trusted_ca),
        )
        stream, flow, get_connection, history, fetch = await _pause_native_stream(
            addon_context, monkeypatch, alpn=alpn, phase="buffered"
        )
        flow.client_conn.alpn_offers = (alpn,)
        parent = stream.context.layers[-2]
        assert isinstance(parent, HttpLayer)
        parent.streams[1] = stream
        parent.command_sources[get_connection] = stream
        selected = list(parent.get_connection(get_connection))
        history.extend(selected)
        [opening] = [cmd for cmd in selected if isinstance(cmd, commands.OpenConnection)]
        replacement = opening.connection
        assert isinstance(replacement, connection.Server)
        assert replacement.address == (_HOST, 443)
        assert replacement.sni == _HOST
        replacement.state = connection.ConnectionState.OPEN
        replacement.peername = ("104.18.33.47", 443)
        pending = deque(parent.handle_event(events.OpenConnectionCompleted(opening, None)))
        steps = 0
        while pending:
            steps += 1
            assert steps < 100, "native TLS did not settle"
            command = pending.popleft()
            history.append(command)
            if isinstance(command, commands.StartHook):
                if isinstance(command, TlsStartServerHook):
                    await addon_context.master.addons.invoke_addon(tls_config, command)
                elif isinstance(command, TlsEstablishedServerHook):
                    assert not plaintext
                    tls_established = True
                elif isinstance(command, TlsFailedServerHook):
                    tls_failed = True
                elif isinstance(command, HttpErrorHook):
                    # Terminal addon cleanup is real; the downstream synthetic HTTP
                    # parser has no socket/client input and need not encode this error.
                    await addon_context.master.addons.invoke_addon(mitm_addon, command)
                    break
                pending.extend(parent.handle_event(events.HookCompleted(command, None)))
            elif isinstance(command, commands.SendData) and command.connection is replacement:
                peer.bio_write(command.data)
                try:
                    peer.do_handshake()
                    while True:
                        plaintext.extend(peer.recv(65536))
                except SSL.WantReadError:
                    pass
                except SSL.Error:
                    assert certificate_case != "valid"
                try:
                    wire = peer.bio_read(65536)
                except SSL.WantReadError:
                    continue
                pending.extend(parent.handle_event(events.DataReceived(replacement, wire)))
        fetch.assert_awaited_once()
        upstream_http = [
            cmd for cmd in history if isinstance(cmd, SendHttp) and cmd.connection is replacement
        ]
        if certificate_case == "valid":
            assert tls_established
            assert not tls_failed
            assert flow.server_conn is replacement
            assert replacement.certificate_list
            if alpn == b"http/1.1":
                assert _TOKEN.encode() in plaintext
                assert _BODY.rstrip(b" ") in plaintext
            else:
                h2_peer = H2Connection(config=H2Configuration(client_side=False))
                h2_peer.initiate_connection()
                received = h2_peer.receive_data(bytes(plaintext))
                [request] = [event for event in received if isinstance(event, RequestReceived)]
                assert dict(request.headers)[b"authorization"] == _TOKEN.encode()
                assert dict(request.headers)[b":authority"] == b"API.GITHUB.COM.:443"
                assert b"".join(
                    event.data for event in received if isinstance(event, DataReceived)
                ) == _BODY.rstrip(b" ")
                assert len([event for event in received if isinstance(event, StreamEnded)]) == 1
            assert flow.response is None
            mitm_addon.error(flow)
        else:
            assert tls_failed
            assert not tls_established
            assert replacement.error is not None
            assert "certificate verify failed" in replacement.error.lower()
            assert not plaintext
            assert not upstream_http
