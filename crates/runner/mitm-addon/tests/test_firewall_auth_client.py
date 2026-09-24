"""Integration tests for the firewall auth client and response protocol."""

import asyncio
import base64
import datetime
import errno
import json
import os
import socket
import ssl
import time
import urllib.error
import uuid
from collections.abc import AsyncIterator, Callable, Coroutine
from contextlib import asynccontextmanager, nullcontext, suppress
from dataclasses import dataclass, field
from pathlib import Path
from unittest.mock import patch

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
from mitmproxy import http
from mitmproxy.net.http.http1 import read_request_head

import firewall_auth_cache as auth_cache
import firewall_auth_client as auth_client
import platform_api
from aws_sigv4 import AwsSigV4Credentials
from tests.auth_endpoint_helpers import FakeAuthEndpoint, firewall_auth_success_response
from tests.auth_state_helpers import auth_cache_key, cached_headers, require_cached_headers
from tests.firewall_auth_helpers import firewall_auth_request

_MALFORMED_SUCCESS_PREFIX = "Firewall auth endpoint returned malformed success response"
_EMPTY_PROXY_ENVIRONMENT = {
    "http_proxy": "",
    "HTTP_PROXY": "",
    "https_proxy": "",
    "HTTPS_PROXY": "",
    "all_proxy": "",
    "ALL_PROXY": "",
    "no_proxy": "",
    "NO_PROXY": "",
}


def _https_proxy_environment(proxy_url: str) -> dict[str, str]:
    return _EMPTY_PROXY_ENVIRONMENT | {"https_proxy": proxy_url}


@dataclass(frozen=True)
class _RawHttpRequest:
    method: str
    target: str
    headers: dict[str, str]
    body: bytes


type _TestServerHandler = Callable[
    [asyncio.StreamReader, asyncio.StreamWriter], Coroutine[object, object, None]
]
type _SocketAddress = tuple[str, int] | tuple[str, int, int, int]
type _SockConnect = Callable[[socket.socket, _SocketAddress], Coroutine[object, object, None]]
_REAL_SOCKET = socket.socket


class _LifecycleSocket(_REAL_SOCKET):
    def __init__(
        self,
        family: int = -1,
        socket_type: int = -1,
        proto: int = -1,
        fileno: int | None = None,
        *,
        tcp_nodelay_error: OSError | None = None,
    ) -> None:
        super().__init__(family, socket_type, proto, fileno)
        self._tcp_nodelay_error = tcp_nodelay_error
        self.setsockopt_calls: list[tuple[int, int, int]] = []
        self.shutdown_calls: list[int] = []
        self.close_call_count = 0

    def setsockopt(self, level: int, optname: int, value: int) -> None:
        self.setsockopt_calls.append((level, optname, value))
        if (
            level == socket.IPPROTO_TCP
            and optname == socket.TCP_NODELAY
            and self._tcp_nodelay_error is not None
        ):
            raise self._tcp_nodelay_error
        super().setsockopt(level, optname, value)

    def shutdown(self, how: int) -> None:
        self.shutdown_calls.append(how)
        super().shutdown(how)

    def close(self) -> None:
        self.close_call_count += 1
        super().close()


@dataclass
class _LifecycleSocketFactory:
    constructor_errors: tuple[OSError | None, ...] = ()
    tcp_nodelay_errors: tuple[OSError | None, ...] = ()
    constructor_families: list[int] = field(default_factory=list)
    sockets: list[_LifecycleSocket] = field(default_factory=list)

    def __call__(
        self,
        family: int = -1,
        socket_type: int = -1,
        proto: int = -1,
        fileno: int | None = None,
    ) -> socket.socket:
        if fileno is not None:
            return _REAL_SOCKET(family, socket_type, proto, fileno)
        constructor_index = len(self.constructor_families)
        self.constructor_families.append(family)
        constructor_error = (
            self.constructor_errors[constructor_index]
            if constructor_index < len(self.constructor_errors)
            else None
        )
        if constructor_error is not None:
            raise constructor_error
        socket_index = len(self.sockets)
        tcp_nodelay_error = (
            self.tcp_nodelay_errors[socket_index]
            if socket_index < len(self.tcp_nodelay_errors)
            else None
        )
        created = _LifecycleSocket(
            family,
            socket_type,
            proto,
            tcp_nodelay_error=tcp_nodelay_error,
        )
        self.sockets.append(created)
        return created


@dataclass
class _OrderedResolver:
    expected_host: str
    addresses: tuple[str, ...]
    lookups: list[str] = field(default_factory=list)

    async def lookup_ip(self, host: str) -> list[str]:
        self.lookups.append(host)
        assert host == self.expected_host
        return list(self.addresses)


@dataclass
class _PendingSockConnect:
    real_connect: _SockConnect
    attempted_addresses: list[_SocketAddress] = field(default_factory=list)
    cancelled_addresses: list[_SocketAddress] = field(default_factory=list)
    sockets: list[socket.socket] = field(default_factory=list)
    active_count: int = 0
    max_active_count: int = 0

    async def __call__(self, sock: socket.socket, address: _SocketAddress) -> None:
        self.attempted_addresses.append(address)
        self.sockets.append(sock)
        self.active_count += 1
        self.max_active_count = max(self.max_active_count, self.active_count)
        try:
            if address[0] == "127.0.0.1":
                await self.real_connect(sock, address)
            else:
                await asyncio.Future()
        except asyncio.CancelledError:
            self.cancelled_addresses.append(address)
            raise
        finally:
            self.active_count -= 1


@dataclass
class _SimultaneousSockConnect:
    real_connect: _SockConnect
    target_address: _SocketAddress
    participant_count: int
    attempted_addresses: list[_SocketAddress] = field(default_factory=list)
    completed_addresses: list[_SocketAddress] = field(default_factory=list)
    sockets_by_address: dict[_SocketAddress, socket.socket] = field(default_factory=dict)
    barrier: asyncio.Barrier = field(init=False)

    def __post_init__(self) -> None:
        self.barrier = asyncio.Barrier(self.participant_count)

    async def __call__(self, sock: socket.socket, address: _SocketAddress) -> None:
        self.attempted_addresses.append(address)
        self.sockets_by_address[address] = sock
        await self.real_connect(sock, self.target_address)
        await self.barrier.wait()
        self.completed_addresses.append(address)


@asynccontextmanager
async def _run_test_server(
    handler: _TestServerHandler,
    *,
    ssl_context: ssl.SSLContext | None = None,
) -> AsyncIterator[int]:
    client_tasks: set[asyncio.Task[None]] = set()
    client_writers: set[asyncio.StreamWriter] = set()
    closing = False

    async def run_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            await handler(reader, writer)
        finally:
            # Do not suspend here: teardown cancellation must not replace a
            # handler failure while its writer is closing.
            writer.close()

    def client_connected(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        if closing:
            writer.transport.abort()
            return
        client_writers.add(writer)
        client_tasks.add(asyncio.create_task(run_client(reader, writer)))

    server = await asyncio.start_server(
        client_connected,
        "127.0.0.1",
        0,
        ssl=ssl_context,
    )
    assert server.sockets
    socket_address = server.sockets[0].getsockname()
    port = socket_address[1]
    assert isinstance(port, int)
    try:
        yield port
    finally:
        closing = True
        server.close()
        for task in client_tasks:
            if not task.done():
                task.cancel()
        # wait_closed also waits for accepted connections. Abort them before
        # joining handlers, including tasks cancelled before their wrapper starts.
        for writer in client_writers:
            writer.transport.abort()
        results = await asyncio.gather(*client_tasks, return_exceptions=True)
        await server.wait_closed()
        for result in results:
            if isinstance(result, BaseException) and not isinstance(result, asyncio.CancelledError):
                raise result


async def _read_raw_http_request(reader: asyncio.StreamReader) -> _RawHttpRequest:
    header_block = await reader.readuntil(b"\r\n\r\n")
    lines = header_block[:-4].split(b"\r\n")
    method, target, _version = lines[0].decode("ascii").split(" ", 2)
    headers: dict[str, str] = {}
    for line in lines[1:]:
        name, value = line.split(b":", 1)
        headers[name.decode("ascii").lower()] = value.decode("latin-1").strip()
    content_length = int(headers.get("content-length", "0"))
    body = await reader.readexactly(content_length)
    return _RawHttpRequest(method, target, headers, body)


async def _close_test_writer(writer: asyncio.StreamWriter) -> None:
    writer.close()
    with suppress(OSError):
        await writer.wait_closed()


class TestRunTestServer:
    @pytest.mark.parametrize("exit_kind", ["normal", "error", "cancel"])
    async def test_exit_cleans_up_active_handler(self, exit_kind: str):
        handler_started = asyncio.Event()
        finish_body = asyncio.Event()
        port_ready = asyncio.get_running_loop().create_future()
        handler_tasks: list[asyncio.Task[None]] = []
        server_writers: list[asyncio.StreamWriter] = []
        body_error = ValueError("controlled test body failure")
        client_writer: asyncio.StreamWriter | None = None

        async def handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            task = asyncio.current_task()
            assert task is not None
            handler_tasks.append(task)
            server_writers.append(writer)
            handler_started.set()
            await asyncio.Event().wait()

        async def run_server() -> None:
            async with _run_test_server(handle_client) as port:
                port_ready.set_result(port)
                await finish_body.wait()
                if exit_kind == "error":
                    raise body_error

        server_task = asyncio.create_task(run_server())
        try:
            async with asyncio.timeout(2.0):
                port = await port_ready
                client_reader, client_writer = await asyncio.open_connection("127.0.0.1", port)
                await handler_started.wait()
                if exit_kind == "cancel":
                    server_task.cancel()
                    with pytest.raises(asyncio.CancelledError):
                        await server_task
                elif exit_kind == "error":
                    finish_body.set()
                    with pytest.raises(
                        ValueError, match="controlled test body failure"
                    ) as exc_info:
                        await server_task
                    assert exc_info.value is body_error
                else:
                    finish_body.set()
                    await server_task

                assert handler_tasks[0].done()
                assert handler_tasks[0].cancelled()
                assert server_writers[0].is_closing()
                assert await client_reader.read() == b""
        finally:
            # Rescue resources even when the helper under test fails to tear down.
            server_task.cancel()
            for task in handler_tasks:
                task.cancel()
            for writer in server_writers:
                writer.transport.abort()
            await asyncio.gather(server_task, *handler_tasks, return_exceptions=True)
            if client_writer is not None:
                await _close_test_writer(client_writer)

    @pytest.mark.parametrize(
        ("handler_fails", "wait_for_completion"),
        [
            pytest.param(False, True, id="success"),
            pytest.param(True, True, id="exception"),
            pytest.param(True, False, id="exception-during-exit"),
        ],
    )
    async def test_completed_handler_closes_writer_and_preserves_error(
        self, handler_fails: bool, wait_for_completion: bool
    ):
        handler_done = asyncio.Event()
        handler_returning = asyncio.Event()
        handler_tasks: list[asyncio.Task[None]] = []
        server_writers: list[asyncio.StreamWriter] = []
        handler_error = AssertionError("controlled handler failure")
        client_writer: asyncio.StreamWriter | None = None

        async def handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            task = asyncio.current_task()
            assert task is not None
            handler_tasks.append(task)
            server_writers.append(writer)
            task.add_done_callback(lambda _: handler_done.set())
            handler_returning.set()
            if handler_fails:
                raise handler_error

        async def run_scenario() -> None:
            nonlocal client_writer
            with (
                pytest.raises(AssertionError, match="controlled handler failure")
                if handler_fails
                else nullcontext()
            ) as exc_info:
                async with _run_test_server(handle_client) as port:
                    client_reader, client_writer = await asyncio.open_connection("127.0.0.1", port)
                    await (handler_done if wait_for_completion else handler_returning).wait()
                    if not handler_fails:
                        assert await client_reader.read() == b""
            if handler_fails:
                assert exc_info is not None
                assert exc_info.value is handler_error
            assert handler_tasks[0].done()
            assert not handler_tasks[0].cancelled()
            assert server_writers[0].is_closing()
            assert await client_reader.read() == b""

        scenario_task = asyncio.create_task(run_scenario())
        try:
            done, _ = await asyncio.wait({scenario_task}, timeout=2.0)
            assert done, "test server did not close the completed handler's connection"
            await scenario_task
        finally:
            for writer in server_writers:
                writer.transport.abort()
            for task in handler_tasks:
                task.cancel()
            scenario_task.cancel()
            await asyncio.gather(scenario_task, *handler_tasks, return_exceptions=True)
            if client_writer is not None:
                await _close_test_writer(client_writer)


def _success_response_bytes(
    *,
    headers: dict[str, str] | None = None,
) -> bytes:
    body = json.dumps(firewall_auth_success_response(headers or {})).encode()
    return (
        b"HTTP/1.1 200 OK\r\n"
        + f"Content-Length: {len(body)}\r\n".encode("ascii")
        + b"Content-Type: application/json\r\nConnection: close\r\n\r\n"
        + body
    )


async def _write_success_response(
    writer: asyncio.StreamWriter,
    *,
    headers: dict[str, str] | None = None,
) -> None:
    writer.write(_success_response_bytes(headers=headers))
    await writer.drain()
    await _close_test_writer(writer)


async def _relay_test_stream(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
) -> None:
    try:
        with suppress(ConnectionError):
            while data := await reader.read(64 * 1024):
                writer.write(data)
                await writer.drain()
    finally:
        await _close_test_writer(writer)


async def _trickle_until_peer_disconnect(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    peer_closed: asyncio.Event,
) -> None:
    peer_eof = asyncio.create_task(reader.read())
    try:
        with suppress(ConnectionResetError):
            while not peer_eof.done():
                writer.write(b" ")
                await writer.drain()
                await asyncio.sleep(0.02)
            remaining_request_body = await peer_eof
            assert remaining_request_body == b""
    finally:
        if not peer_eof.done():
            peer_eof.cancel()
            with suppress(asyncio.CancelledError):
                await peer_eof
        await _close_test_writer(writer)
    peer_closed.set()


def _create_tls_server(
    tmp_path: Path,
    *,
    hostname: str = "localhost",
) -> tuple[ssl.SSLContext, Path]:
    ca_key = ec.generate_private_key(ec.SECP256R1())
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Firewall auth test CA")])
    now = datetime.datetime.now(datetime.UTC)
    ca_certificate = (
        x509.CertificateBuilder()
        .subject_name(ca_name)
        .issuer_name(ca_name)
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=False,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=True,
                crl_sign=True,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False
        )
        .sign(ca_key, hashes.SHA256())
    )
    ca_path = tmp_path / "ca.pem"
    ca_path.write_bytes(ca_certificate.public_bytes(serialization.Encoding.PEM))

    private_key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, hostname)])
    certificate = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(ca_name)
        .public_key(private_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(hostname)]), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()),
            critical=False,
        )
        .sign(ca_key, hashes.SHA256())
    )
    certificate_path = tmp_path / "localhost-cert.pem"
    private_key_path = tmp_path / "localhost-key.pem"
    certificate_path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    private_key_path.write_bytes(
        private_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        )
    )

    server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server_context.load_cert_chain(certificate_path, private_key_path)
    return server_context, ca_path


def _tls_trust_environment(ca_path: Path) -> dict[str, str]:
    return {"SSL_CERT_FILE": str(ca_path), "SSL_CERT_DIR": "", "SSLKEYLOGFILE": ""}


class TestFetchFirewallHeaders:
    async def test_sends_request_and_maps_basic_success(self, mitm_ctx):
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response(
            firewall_auth_success_response({"Authorization": "Bearer tok"})
        )

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
        ):
            result = await auth_client.fetch_firewall_headers(
                firewall_auth_request(
                    auth_headers={"Authorization": "Bearer ${{ secrets.TOKEN }}"}
                ),
            )

        assert result.payload.headers == {"Authorization": "Bearer tok"}
        assert result.payload.base is None
        assert result.payload.query is None

        assert endpoint.request_count == 1
        request = endpoint.requests[0]
        assert request.method == "POST"
        assert request.path == "/api/webhooks/agent/firewall/auth"
        assert request.headers["authorization"] == "Bearer tok-xyz"
        assert request.headers["content-type"] == "application/json"
        assert request.headers["user-agent"] == "vm0-mitm-addon/1.0"
        assert request.headers["x-client-version"] == "runner-version-test"
        assert request.headers["x-client-type"] == "MitmAddon"
        assert request.headers["x-client-session-id"] == "runner-session-test"
        uuid.UUID(request.headers["x-client-request-id"])
        assert "x-vercel-protection-bypass" not in request.headers
        assert request.json_body() == {
            "encryptedSecrets": "iv:tag:data",
            "authHeaders": {"Authorization": "Bearer ${{ secrets.TOKEN }}"},
        }

    async def test_success_response_shape_is_mapped(self, mitm_ctx):
        expires_at = time.time() + 30
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response(
            firewall_auth_success_response(
                {
                    "Authorization": "Bearer tok",
                    "X-Custom": "custom",
                },
                expires_at=expires_at,
                resolved_secrets=["API_TOKEN"],
                refreshed_connectors=["notion"],
                refreshed_secrets=["NOTION_TOKEN"],
            )
            | {
                "base": "https://example.com/webhook/secret",
                "query": {"api_key": "resolved-key"},
                "futureField": {"ignored": True},
            }
        )

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
        ):
            result = await auth_client.fetch_firewall_headers(
                firewall_auth_request(
                    auth_headers={
                        "Authorization": "Bearer ${{ secrets.TOKEN }}",
                        "X-Custom": "${{ secrets.CUSTOM }}",
                    },
                    auth_base="${{ secrets.WEBHOOK_URL }}",
                    auth_query={"api_key": "${{ secrets.API_KEY }}"},
                )
            )

        assert result.payload.headers == {
            "Authorization": "Bearer tok",
            "X-Custom": "custom",
        }
        assert result.payload.base == "https://example.com/webhook/secret"
        assert result.payload.query == {"api_key": "resolved-key"}
        assert result.payload.aws_sigv4 is None
        assert result.expires_at == expires_at
        assert result.payload.resolved_secrets == ["API_TOKEN"]
        assert result.refreshed_connectors == ["notion"]
        assert result.refreshed_secrets == ["NOTION_TOKEN"]
        assert not hasattr(result, "futureField")

    @pytest.mark.parametrize(
        ("response", "expected_reason"),
        [
            pytest.param(
                firewall_auth_success_response(
                    {"Authorization": "Bearer sensitive-resolved-token"},
                )
                | {"query": {"tenant": "resolved-tenant"}},
                "headers must match the configured auth header names",
                id="missing-header",
            ),
            pytest.param(
                firewall_auth_success_response(
                    {
                        "Authorization": "Bearer sensitive-resolved-token",
                        "X-Secondary": "sensitive-secondary-token",
                    },
                )
                | {"query": {}},
                "query must match the configured auth query names",
                id="missing-query",
            ),
        ],
    )
    async def test_response_must_include_all_configured_header_and_query_entries(
        self,
        mitm_ctx,
        response: dict[str, object],
        expected_reason: str,
    ):
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response(response)

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
            pytest.raises(ValueError, match=_MALFORMED_SUCCESS_PREFIX) as exc_info,
        ):
            await auth_client.fetch_firewall_headers(
                firewall_auth_request(
                    auth_headers={
                        "Authorization": "Bearer ${{ secrets.PRIMARY_TOKEN }}",
                        "X-Secondary": "${{ secrets.SECONDARY_TOKEN }}",
                    },
                    auth_query={"tenant": "${{ secrets.TENANT }}"},
                )
            )

        message = str(exc_info.value)
        assert message == f"{_MALFORMED_SUCCESS_PREFIX}: {expected_reason}"
        assert "sensitive-resolved-token" not in message

    @pytest.mark.parametrize(
        "session_token",
        [
            pytest.param(None, id="without-session-token"),
            pytest.param("session-token", id="with-session-token"),
        ],
    )
    async def test_sigv4_success_response_is_cached(
        self,
        mitm_ctx,
        session_token: str | None,
    ):
        request_aws_sigv4 = {
            "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
            "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
        }
        response_aws_sigv4: dict[str, object] = {
            "accessKeyId": "access-key-id",
            "secretAccessKey": "secret-access-key",
            "futureField": {"ignored": True},
        }
        if session_token is not None:
            request_aws_sigv4["sessionToken"] = "${{ secrets.AWS_SESSION_TOKEN }}"
            response_aws_sigv4["sessionToken"] = session_token

        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response(
            firewall_auth_success_response({})
            | {
                "awsSigv4": response_aws_sigv4,
            }
        )
        cache_key = auth_cache_key()

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
        ):
            result = await auth_cache.get_firewall_headers(
                cache_key,
                firewall_auth_request(auth_aws_sigv4=request_aws_sigv4),
            )

        expected_credentials = AwsSigV4Credentials(
            "access-key-id",
            "secret-access-key",
            session_token,
        )
        assert result["aws_sigv4"] == expected_credentials
        assert require_cached_headers(cache_key).aws_sigv4 == expected_credentials

    @pytest.mark.parametrize(
        ("aws_sigv4", "expected_reason"),
        [
            pytest.param(None, "awsSigv4 must be an object", id="sigv4-null"),
            pytest.param([], "awsSigv4 must be an object", id="sigv4-array"),
            pytest.param(
                {"secretAccessKey": "secret-access-key"},
                "awsSigv4.accessKeyId is required",
                id="access-key-missing",
            ),
            pytest.param(
                {"accessKeyId": "", "secretAccessKey": "secret-access-key"},
                "awsSigv4.accessKeyId is required",
                id="access-key-empty",
            ),
            pytest.param(
                {"accessKeyId": None, "secretAccessKey": "secret-access-key"},
                "awsSigv4.accessKeyId is required",
                id="access-key-null",
            ),
            pytest.param(
                {"accessKeyId": 123, "secretAccessKey": "secret-access-key"},
                "awsSigv4.accessKeyId is required",
                id="access-key-number",
            ),
            pytest.param(
                {"accessKeyId": "access-key-id"},
                "awsSigv4.secretAccessKey is required",
                id="secret-key-missing",
            ),
            pytest.param(
                {"accessKeyId": "access-key-id", "secretAccessKey": ""},
                "awsSigv4.secretAccessKey is required",
                id="secret-key-empty",
            ),
            pytest.param(
                {"accessKeyId": "access-key-id", "secretAccessKey": None},
                "awsSigv4.secretAccessKey is required",
                id="secret-key-null",
            ),
            pytest.param(
                {"accessKeyId": "access-key-id", "secretAccessKey": 123},
                "awsSigv4.secretAccessKey is required",
                id="secret-key-number",
            ),
            pytest.param(
                {
                    "accessKeyId": "access-key-id",
                    "secretAccessKey": "secret-access-key",
                    "sessionToken": "",
                },
                "sessionToken must not be empty",
                id="session-token-empty",
            ),
            pytest.param(
                {
                    "accessKeyId": "access-key-id",
                    "secretAccessKey": "secret-access-key",
                    "sessionToken": None,
                },
                "sessionToken must be a string",
                id="session-token-null",
            ),
            pytest.param(
                {
                    "accessKeyId": "access-key-id",
                    "secretAccessKey": "secret-access-key",
                    "sessionToken": 123,
                },
                "sessionToken must be a string",
                id="session-token-number",
            ),
        ],
    )
    async def test_malformed_sigv4_response_is_not_cached(
        self,
        mitm_ctx,
        aws_sigv4: object,
        expected_reason: str,
    ):
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response(firewall_auth_success_response({}) | {"awsSigv4": aws_sigv4})
        cache_key = auth_cache_key()

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
            pytest.raises(ValueError, match=_MALFORMED_SUCCESS_PREFIX) as exc_info,
        ):
            await auth_cache.get_firewall_headers(
                cache_key,
                firewall_auth_request(
                    auth_aws_sigv4={
                        "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                        "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
                    }
                ),
            )

        assert str(exc_info.value) == f"{_MALFORMED_SUCCESS_PREFIX}: {expected_reason}"
        assert cached_headers(cache_key) is None

    @pytest.mark.parametrize(
        ("auth_request", "response"),
        [
            (
                firewall_auth_request(auth_base="${{ secrets.WEBHOOK_URL }}"),
                firewall_auth_success_response({}),
            ),
            (
                firewall_auth_request(),
                firewall_auth_success_response({}) | {"base": "https://hooks.example.com/secret"},
            ),
            (
                firewall_auth_request(auth_base="${{ secrets.WEBHOOK_URL }}"),
                firewall_auth_success_response({}) | {"base": ""},
            ),
            (
                firewall_auth_request(
                    auth_aws_sigv4={
                        "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                        "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
                    }
                ),
                firewall_auth_success_response({}),
            ),
            (
                firewall_auth_request(),
                firewall_auth_success_response({})
                | {
                    "awsSigv4": {
                        "accessKeyId": "access-key-id",
                        "secretAccessKey": "secret-access-key",
                    },
                },
            ),
            (
                firewall_auth_request(
                    auth_aws_sigv4={
                        "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                        "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
                    }
                ),
                firewall_auth_success_response({})
                | {
                    "awsSigv4": {
                        "accessKeyId": "access-key-id",
                        "secretAccessKey": "secret-access-key",
                        "sessionToken": "session-token",
                    },
                },
            ),
            (
                firewall_auth_request(
                    auth_aws_sigv4={
                        "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                        "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
                        "sessionToken": "${{ secrets.AWS_SESSION_TOKEN }}",
                    }
                ),
                firewall_auth_success_response({})
                | {
                    "awsSigv4": {
                        "accessKeyId": "access-key-id",
                        "secretAccessKey": "secret-access-key",
                    },
                },
            ),
            (
                firewall_auth_request(auth_headers={"Authorization": "template"}),
                firewall_auth_success_response({"X-Unexpected": "value"}),
            ),
            (
                firewall_auth_request(auth_query={"api_key": "template"}),
                firewall_auth_success_response({}) | {"query": {"unexpected": "value"}},
            ),
        ],
        ids=[
            "missing-base",
            "unexpected-base",
            "empty-base",
            "missing-sigv4",
            "unexpected-sigv4",
            "unexpected-session-token",
            "missing-session-token",
            "header-name-mismatch",
            "query-name-mismatch",
        ],
    )
    async def test_rejects_response_inconsistent_with_request(
        self,
        mitm_ctx,
        auth_request: auth_client.FirewallAuthRequest,
        response: dict[str, object],
    ):
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response(response)

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
            pytest.raises(ValueError, match=_MALFORMED_SUCCESS_PREFIX),
        ):
            await auth_client.fetch_firewall_headers(auth_request)

    async def test_inconsistent_response_is_not_cached(self, mitm_ctx):
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response(firewall_auth_success_response({}))
        cache_key = auth_cache_key()

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
            pytest.raises(ValueError, match=_MALFORMED_SUCCESS_PREFIX),
        ):
            await auth_cache.get_firewall_headers(
                cache_key,
                firewall_auth_request(auth_base="${{ secrets.WEBHOOK_URL }}"),
            )

        assert cached_headers(cache_key) is None

    async def test_sends_optional_request_body_fields(self, mitm_ctx):
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response(
            firewall_auth_success_response({}, expires_at=time.time() + 30)
            | {
                "base": "https://hooks.example.com/secret",
                "query": {"api_key": "resolved-key"},
            }
        )

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
        ):
            await auth_client.fetch_firewall_headers(
                firewall_auth_request(
                    secret_connector_map={"TOKEN": "notion"},
                    secret_connector_metadata_map={"TOKEN": {"kind": "oauth"}},
                    vars_map={"TEAM": "vm0"},
                    auth_base="${{ secrets.WEBHOOK_URL }}",
                    auth_query={"api_key": "${{ secrets.API_KEY }}"},
                    firewall_billable=True,
                ),
                force_refresh=True,
            )

        body = endpoint.requests[0].json_body()
        assert body["encryptedSecrets"] == "iv:tag:data"
        assert body["authHeaders"] == {}
        assert body["secretConnectorMap"] == {"TOKEN": "notion"}
        assert body["secretConnectorMetadataMap"] == {"TOKEN": {"kind": "oauth"}}
        assert body["vars"] == {"TEAM": "vm0"}
        assert body["authBase"] == "${{ secrets.WEBHOOK_URL }}"
        assert body["authQuery"] == {"api_key": "${{ secrets.API_KEY }}"}
        assert "authAwsSigv4" not in body
        assert body["firewallBillable"] is True
        assert body["forceRefresh"] is True
        assert "firewallName" not in body
        assert "modelUsageProvider" not in body

    async def test_sends_sigv4_request_body(self, mitm_ctx):
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response(
            firewall_auth_success_response({})
            | {
                "awsSigv4": {
                    "accessKeyId": "access-key-id",
                    "secretAccessKey": "secret-access-key",
                    "sessionToken": "session-token",
                },
            }
        )

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
        ):
            await auth_client.fetch_firewall_headers(
                firewall_auth_request(
                    auth_aws_sigv4={
                        "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                        "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
                        "sessionToken": "${{ secrets.AWS_SESSION_TOKEN }}",
                    }
                ),
            )

        assert endpoint.requests[0].json_body() == {
            "encryptedSecrets": "iv:tag:data",
            "authHeaders": {},
            "authAwsSigv4": {
                "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
                "sessionToken": "${{ secrets.AWS_SESSION_TOKEN }}",
            },
        }

    async def test_omits_empty_optional_request_body_fields(self, mitm_ctx):
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response(firewall_auth_success_response({}))

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
        ):
            await auth_client.fetch_firewall_headers(
                firewall_auth_request(
                    auth_query={},
                    secret_connector_map={},
                    secret_connector_metadata_map={},
                    vars_map={},
                    firewall_billable=False,
                ),
                force_refresh=False,
            )

        assert endpoint.requests[0].json_body() == {
            "encryptedSecrets": "iv:tag:data",
            "authHeaders": {},
        }

    def test_request_repr_omits_sensitive_values(self):
        request = firewall_auth_request(
            encrypted_secrets="secret-encrypted-payload",
            sandbox_auth="secret-sandbox-token",
        )

        rendered = repr(request)

        assert "secret-encrypted-payload" not in rendered
        assert "secret-sandbox-token" not in rendered

    async def test_includes_vercel_bypass_header(self, mitm_ctx):
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response(firewall_auth_success_response({}))
        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(platform_api, "VERCEL_BYPASS", "secret-bypass-value"),
        ):
            await auth_client.fetch_firewall_headers(firewall_auth_request())

        assert endpoint.requests[0].headers["x-vercel-protection-bypass"] == "secret-bypass-value"

    @pytest.mark.parametrize("status", [301, 302, 303])
    async def test_rejects_cross_origin_redirect_without_forwarding_credentials(
        self,
        status: int,
        mitm_ctx,
    ):
        source = FakeAuthEndpoint()
        target = FakeAuthEndpoint()

        with target.run():
            source.queue_response(
                status,
                headers=(("Location", f"{target.api_url}/redirected"),),
            )
            with (
                source.run(),
                mitm_ctx(api_url=source.api_url),
                patch.object(platform_api, "VERCEL_BYPASS", "secret-bypass-value"),
                pytest.raises(urllib.error.HTTPError) as exc_info,
            ):
                await auth_client.fetch_firewall_headers(firewall_auth_request())

        assert exc_info.value.code == status
        assert source.request_count == 1
        request = source.requests[0]
        assert request.method == "POST"
        assert request.headers["authorization"] == "Bearer tok-xyz"
        assert request.headers["x-vercel-protection-bypass"] == "secret-bypass-value"
        assert target.requests == ()

    async def test_invalid_api_url_raises_before_network_io(self):
        with (
            patch.object(platform_api, "get_api_url", return_value="file:///etc/passwd"),
            pytest.raises(ValueError, match="absolute http"),
        ):
            await auth_client.fetch_firewall_headers(firewall_auth_request())

    async def test_424_connector_not_configured_raises_custom_error(self, mitm_ctx):
        """Auth endpoint 424 CONNECTOR_NOT_CONFIGURED raises ConnectorNotConfiguredError."""
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response(
            {
                "error": {
                    "message": "Connector not configured",
                    "code": "CONNECTOR_NOT_CONFIGURED",
                }
            },
            status=424,
        )

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
        ):
            with pytest.raises(auth_client.ConnectorNotConfiguredError) as exc_info:
                await auth_client.fetch_firewall_headers(firewall_auth_request())
            assert "Connector not configured" in str(exc_info.value)

    async def test_402_insufficient_credits_raises_custom_error(self, mitm_ctx):
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response(
            {
                "error": {
                    "message": "Insufficient credits",
                    "code": "INSUFFICIENT_CREDITS",
                }
            },
            status=402,
        )

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
        ):
            with pytest.raises(auth_client.InsufficientCreditsError) as exc_info:
                await auth_client.fetch_firewall_headers(firewall_auth_request())
            assert "Insufficient credits" in str(exc_info.value)

    @pytest.mark.parametrize(
        (
            "status",
            "code",
            "message",
            "connectors",
            "failure_reason",
            "expected_failure_reason",
        ),
        [
            (
                424,
                "TOKEN_ACCESS_RESOLUTION_FAILED",
                "Token access resolution failed for: notion.",
                ["notion"],
                None,
                None,
            ),
            (
                403,
                "FORBIDDEN",
                "Invalid model-provider secret owner",
                None,
                None,
                None,
            ),
            (
                502,
                "TOKEN_REFRESH_FAILED",
                "Access token expired and refresh failed for: codex-oauth-token.",
                ["codex-oauth-token"],
                "upstream_provider",
                "upstream_provider",
            ),
            (
                502,
                "TOKEN_REFRESH_FAILED",
                "Access token expired and refresh failed for: notion.",
                ["notion"],
                "provider_rate_limited",
                None,
            ),
        ],
        ids=[
            "token-access-resolution",
            "forbidden",
            "token-refresh",
            "unknown-failure-reason",
        ],
    )
    async def test_current_structured_error_raises_custom_error(
        self,
        mitm_ctx,
        status: int,
        code: str,
        message: str,
        connectors: list[str] | None,
        failure_reason: str | None,
        expected_failure_reason: str | None,
    ):
        """Current auth endpoint errors should preserve their code and connectors."""
        error_info: dict[str, object] = {
            "message": message,
            "code": code,
        }
        if connectors is not None:
            error_info["connectors"] = connectors
        if failure_reason is not None:
            error_info["failureReason"] = failure_reason
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response({"error": error_info}, status=status)

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
            pytest.raises(auth_client.FirewallAuthApiError) as exc_info,
        ):
            await auth_client.fetch_firewall_headers(firewall_auth_request())

        assert exc_info.value.status == status
        assert exc_info.value.code == code
        assert str(exc_info.value) == message
        assert exc_info.value.connectors == connectors
        assert exc_info.value.failure_reason == expected_failure_reason

    async def test_structured_http_error_at_body_limit_is_preserved(self, mitm_ctx):
        error_body = json.dumps(
            {
                "error": {
                    "message": "Access token expired and refresh failed for: notion.",
                    "code": "TOKEN_REFRESH_FAILED",
                }
            }
        ).encode()
        endpoint = FakeAuthEndpoint()
        endpoint.queue_response(502, body=error_body)

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(
                auth_client,
                "MAX_FIREWALL_AUTH_RESPONSE_BODY_BYTES",
                len(error_body),
            ),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
            pytest.raises(auth_client.FirewallAuthApiError) as exc_info,
        ):
            await auth_client.fetch_firewall_headers(firewall_auth_request())

        assert exc_info.value.code == "TOKEN_REFRESH_FAILED"

    async def test_http_error_over_body_limit_raises(self, mitm_ctx):
        error_body = json.dumps(
            {
                "error": {
                    "message": "Access token expired and refresh failed for: notion.",
                    "code": "TOKEN_REFRESH_FAILED",
                }
            }
        ).encode()
        endpoint = FakeAuthEndpoint()
        endpoint.queue_response(502, body=error_body)

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(
                auth_client,
                "MAX_FIREWALL_AUTH_RESPONSE_BODY_BYTES",
                len(error_body) - 1,
            ),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
            pytest.raises(
                auth_client.FirewallAuthResponseTooLargeError,
                match="Firewall auth response body too large",
            ),
        ):
            await auth_client.fetch_firewall_headers(firewall_auth_request())

    @pytest.mark.parametrize(
        "error_body",
        [
            pytest.param(b"\xff", id="invalid-utf8"),
            b"not-json",
            b'"plain string"',
            b"[1, 2, 3]",
            b"{}",
            json.dumps({"error": "not-a-dict"}).encode(),
            json.dumps({"error": None}).encode(),
            json.dumps({"error": {}}).encode(),
            json.dumps({"error": {"message": "Bad Request", "code": "BAD_REQUEST"}}).encode(),
        ],
    )
    async def test_malformed_http_error_envelope_reraises_http_error(
        self,
        mitm_ctx,
        error_body: bytes,
    ):
        endpoint = FakeAuthEndpoint()
        endpoint.queue_response(400, body=error_body)

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
            pytest.raises(urllib.error.HTTPError) as exc_info,
        ):
            await auth_client.fetch_firewall_headers(firewall_auth_request())

        assert exc_info.value.code == 400

    @pytest.mark.parametrize(
        ("code", "status", "exception_type", "default_message"),
        [
            (
                "CONNECTOR_NOT_CONFIGURED",
                424,
                auth_client.ConnectorNotConfiguredError,
                "Connector not configured",
            ),
            (
                "INSUFFICIENT_CREDITS",
                402,
                auth_client.InsufficientCreditsError,
                "Insufficient credits",
            ),
        ],
    )
    async def test_known_error_with_non_string_message_uses_default(
        self,
        mitm_ctx,
        code: str,
        status: int,
        exception_type: type[Exception],
        default_message: str,
    ):
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response(
            {
                "error": {
                    "message": None,
                    "code": code,
                }
            },
            status=status,
        )

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
            pytest.raises(exception_type) as exc_info,
        ):
            await auth_client.fetch_firewall_headers(firewall_auth_request())

        assert str(exc_info.value) == default_message

    async def test_async_wrapper_uses_api_url_from_ctx(self, mitm_ctx):
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response(firewall_auth_success_response({"Auth": "tok"}))

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
        ):
            result = await auth_client.fetch_firewall_headers(
                firewall_auth_request(
                    encrypted_secrets="enc",
                    auth_headers={"Auth": "${{ secrets.TOKEN }}"},
                    sandbox_auth="sandbox-tok",
                )
            )

        assert result.payload.headers == {"Auth": "tok"}
        assert endpoint.requests[0].path == "/api/webhooks/agent/firewall/auth"


class TestFirewallAuthSuccessParser:
    @pytest.mark.parametrize(
        "body",
        [
            pytest.param([], id="array"),
            pytest.param(None, id="null"),
            pytest.param("plain string", id="string"),
            pytest.param(123, id="number"),
            pytest.param(
                {
                    "expiresAt": None,
                    "resolvedSecrets": [],
                    "refreshedConnectors": [],
                    "refreshedSecrets": [],
                },
                id="missing-headers",
            ),
            pytest.param(firewall_auth_success_response({}) | {"headers": []}, id="headers-array"),
            pytest.param(
                firewall_auth_success_response({}) | {"headers": {"Authorization": 123}},
                id="header-value-number",
            ),
            pytest.param(
                firewall_auth_success_response({}) | {"base": []},
                id="base-array",
            ),
            pytest.param(
                firewall_auth_success_response({}) | {"base": ""},
                id="base-empty",
            ),
            pytest.param(
                firewall_auth_success_response({}) | {"query": []},
                id="query-array",
            ),
            pytest.param(
                firewall_auth_success_response({}) | {"query": {"api_key": 123}},
                id="query-value-number",
            ),
            pytest.param(
                firewall_auth_success_response({}) | {"resolvedSecrets": "TOKEN"},
                id="resolved-secrets-string",
            ),
            pytest.param(
                firewall_auth_success_response({}) | {"refreshedConnectors": [123]},
                id="refreshed-connectors-number",
            ),
            pytest.param(
                firewall_auth_success_response({}) | {"refreshedSecrets": [None]},
                id="refreshed-secrets-null",
            ),
        ],
    )
    def test_malformed_success_response_shape_raises_value_error(self, body: object):
        with pytest.raises(ValueError, match=_MALFORMED_SUCCESS_PREFIX):
            auth_client._parse_firewall_auth_success(body, firewall_auth_request())


class TestFirewallAuthAsyncTransport:
    async def test_https_trusted_matching_certificate_sends_and_caches_auth(
        self, mitm_ctx, tmp_path: Path
    ):
        server_context, ca_path = _create_tls_server(tmp_path)
        requests: list[_RawHttpRequest] = []
        cache_key = auth_cache_key()
        request = firewall_auth_request(
            auth_headers={"Authorization": "Bearer ${{ secrets.TOKEN }}"}
        )
        expected_headers = {"Authorization": "Bearer resolved-test-token"}

        async def handle_client(
            reader: asyncio.StreamReader,
            writer: asyncio.StreamWriter,
        ) -> None:
            requests.append(await _read_raw_http_request(reader))
            await _write_success_response(writer, headers=expected_headers)

        async with _run_test_server(handle_client, ssl_context=server_context) as port:
            with (
                patch.dict(os.environ, _EMPTY_PROXY_ENVIRONMENT | _tls_trust_environment(ca_path)),
                patch.object(
                    auth_client,
                    "_dns_resolver",
                    _OrderedResolver(expected_host="localhost", addresses=("127.0.0.1",)),
                ),
                patch.object(platform_api, "VERCEL_BYPASS", ""),
                mitm_ctx(api_url=f"https://localhost:{port}"),
            ):
                result = await auth_cache.get_firewall_headers(cache_key, request)
                cached = await auth_cache.get_firewall_headers(cache_key, request)

        assert result["headers"] == expected_headers
        assert result["cache_hit"] is False
        assert cached["headers"] == expected_headers
        assert cached["cache_hit"] is True
        assert len(requests) == 1
        assert requests[0].method == "POST"
        assert requests[0].target == "/api/webhooks/agent/firewall/auth"
        assert requests[0].headers["authorization"] == "Bearer tok-xyz"
        assert requests[0].body == request.to_bytes()

    @pytest.mark.parametrize(
        ("hostname", "trusted", "error_message"),
        [
            pytest.param("localhost", False, "unable to get local issuer", id="untrusted-issuer"),
            pytest.param("wrong.example", True, "Hostname mismatch", id="wrong-hostname"),
        ],
    )
    async def test_https_rejects_invalid_peer_without_sending_or_caching_auth(
        self, mitm_ctx, tmp_path: Path, hostname: str, trusted: bool, error_message: str
    ):
        server_context, ca_path = _create_tls_server(tmp_path, hostname=hostname)
        if not trusted:
            unrelated_ca_dir = tmp_path / "unrelated"
            unrelated_ca_dir.mkdir()
            _, ca_path = _create_tls_server(unrelated_ca_dir)
        requests: list[_RawHttpRequest] = []
        socket_factory = _LifecycleSocketFactory()
        cache_key = auth_cache_key()
        request = firewall_auth_request(
            auth_headers={"Authorization": "Bearer ${{ secrets.TOKEN }}"}
        )

        async def handle_client(
            reader: asyncio.StreamReader,
            writer: asyncio.StreamWriter,
        ) -> None:
            requests.append(await _read_raw_http_request(reader))
            await _write_success_response(writer, headers={"Authorization": "Bearer forged-token"})

        async with _run_test_server(handle_client, ssl_context=server_context) as port:
            with (
                patch.dict(os.environ, _EMPTY_PROXY_ENVIRONMENT | _tls_trust_environment(ca_path)),
                patch.object(
                    auth_client,
                    "_dns_resolver",
                    _OrderedResolver(expected_host="localhost", addresses=("127.0.0.1",)),
                ),
                patch.object(auth_client.socket, "socket", side_effect=socket_factory),
                patch.object(platform_api, "VERCEL_BYPASS", ""),
                mitm_ctx(api_url=f"https://localhost:{port}"),
            ):
                for attempt in range(2):
                    with pytest.raises(ssl.SSLCertVerificationError, match=error_message):
                        await auth_cache.get_firewall_headers(cache_key, request)
                    assert cached_headers(cache_key) is None
                    assert requests == []
                    assert len(socket_factory.sockets) == attempt + 1
                    assert all(sock.fileno() == -1 for sock in socket_factory.sockets)

    @pytest.mark.parametrize(
        "framing",
        [
            pytest.param("chunked", id="chunked"),
            pytest.param("eof", id="eof-delimited"),
            pytest.param("informational", id="informational-before-content-length"),
        ],
    )
    async def test_accepts_http_11_response_framing(self, framing: str, mitm_ctx):
        response_body = json.dumps(firewall_auth_success_response({})).encode()
        requests: list[_RawHttpRequest] = []

        async def handle_client(
            reader: asyncio.StreamReader,
            writer: asyncio.StreamWriter,
        ) -> None:
            requests.append(await _read_raw_http_request(reader))
            if framing == "chunked":
                midpoint = len(response_body) // 2
                chunks = (response_body[:midpoint], response_body[midpoint:])
                encoded_chunks = b"".join(
                    f"{len(chunk):x}\r\n".encode("ascii") + chunk + b"\r\n" for chunk in chunks
                )
                response = (
                    b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n"
                    b"Connection: close\r\n\r\n" + encoded_chunks + b"0\r\n\r\n"
                )
            elif framing == "eof":
                response = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n" + response_body
            else:
                response = (
                    b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\n"
                    + f"Content-Length: {len(response_body)}\r\n".encode("ascii")
                    + b"Connection: close\r\n\r\n"
                    + response_body
                )
            writer.write(response)
            await writer.drain()
            await _close_test_writer(writer)

        async with _run_test_server(handle_client) as port:
            with (
                mitm_ctx(api_url=f"http://127.0.0.1:{port}"),
                patch.object(platform_api, "VERCEL_BYPASS", ""),
            ):
                result = await auth_client.fetch_firewall_headers(firewall_auth_request())

        assert result.payload.headers == {}
        assert len(requests) == 1
        assert requests[0].method == "POST"
        assert requests[0].target == "/api/webhooks/agent/firewall/auth"

    async def test_uses_connected_socket_when_tcp_nodelay_is_unsupported(self, mitm_ctx):
        requests: list[_RawHttpRequest] = []
        socket_factory = _LifecycleSocketFactory(
            tcp_nodelay_errors=(OSError(errno.ENOPROTOOPT, "not supported"),)
        )

        async def handle_client(
            reader: asyncio.StreamReader,
            writer: asyncio.StreamWriter,
        ) -> None:
            requests.append(await _read_raw_http_request(reader))
            await _write_success_response(writer)

        async with _run_test_server(handle_client) as port:
            with (
                patch.dict(os.environ, _EMPTY_PROXY_ENVIRONMENT),
                patch.object(auth_client.socket, "socket", side_effect=socket_factory),
                patch.object(platform_api, "VERCEL_BYPASS", ""),
                mitm_ctx(api_url=f"http://127.0.0.1:{port}"),
            ):
                result = await auth_client.fetch_firewall_headers(firewall_auth_request())

        assert result.payload.headers == {}
        assert len(requests) == 1
        assert len(socket_factory.sockets) == 1
        connected_socket = socket_factory.sockets[0]
        assert connected_socket.setsockopt_calls == [(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)]
        assert connected_socket.shutdown_calls == []

    async def test_aborts_connected_socket_when_tcp_nodelay_setup_fails(self, mitm_ctx):
        tcp_nodelay_error = OSError(errno.EINVAL, "setsockopt failed")
        socket_factory = _LifecycleSocketFactory(tcp_nodelay_errors=(tcp_nodelay_error,))

        async def handle_client(
            reader: asyncio.StreamReader,
            writer: asyncio.StreamWriter,
        ) -> None:
            await reader.read()
            await _close_test_writer(writer)

        async with _run_test_server(handle_client) as port:
            with (
                patch.dict(os.environ, _EMPTY_PROXY_ENVIRONMENT),
                patch.object(auth_client.socket, "socket", side_effect=socket_factory),
                patch.object(platform_api, "VERCEL_BYPASS", ""),
                mitm_ctx(api_url=f"http://127.0.0.1:{port}"),
                pytest.raises(OSError, match=r"setsockopt failed$") as exc_info,
            ):
                await auth_client.fetch_firewall_headers(firewall_auth_request())

        assert exc_info.value is tcp_nodelay_error
        assert len(socket_factory.sockets) == 1
        failed_socket = socket_factory.sockets[0]
        assert failed_socket.setsockopt_calls == [(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)]
        assert failed_socket.shutdown_calls == [socket.SHUT_RDWR]
        assert failed_socket.close_call_count == 1

    async def test_uses_later_address_after_tcp_nodelay_setup_failure(self, mitm_ctx):
        requests: list[_RawHttpRequest] = []
        loop = asyncio.get_running_loop()
        socket_factory = _LifecycleSocketFactory(
            tcp_nodelay_errors=(OSError(errno.EINVAL, "setsockopt failed"), None)
        )
        resolver = _OrderedResolver(
            expected_host="firewall-auth.invalid",
            addresses=("192.0.2.2", "192.0.2.1"),
        )

        async def handle_client(
            reader: asyncio.StreamReader,
            writer: asyncio.StreamWriter,
        ) -> None:
            try:
                request = await _read_raw_http_request(reader)
            except asyncio.IncompleteReadError:
                await _close_test_writer(writer)
                return
            requests.append(request)
            await _write_success_response(writer)

        async with _run_test_server(handle_client) as port:
            connect_probe = _SimultaneousSockConnect(
                loop.sock_connect,
                ("127.0.0.1", port),
                participant_count=2,
            )
            expected_addresses: list[_SocketAddress] = [
                ("192.0.2.2", port),
                ("192.0.2.1", port),
            ]
            with (
                patch.dict(os.environ, _EMPTY_PROXY_ENVIRONMENT),
                patch.object(auth_client, "_dns_resolver", resolver),
                patch.object(auth_client.socket, "socket", side_effect=socket_factory),
                patch.object(loop, "sock_connect", new=connect_probe),
                patch.object(
                    auth_client,
                    "_FIREWALL_AUTH_CONNECTION_ATTEMPT_DELAY_SECONDS",
                    0.0,
                ),
                patch.object(platform_api, "VERCEL_BYPASS", ""),
                mitm_ctx(api_url=f"http://firewall-auth.invalid:{port}"),
            ):
                result = await auth_client.fetch_firewall_headers(firewall_auth_request())

        assert result.payload.headers == {}
        assert len(requests) == 1
        assert connect_probe.attempted_addresses == expected_addresses
        assert set(connect_probe.completed_addresses) == set(expected_addresses)
        failed_socket = connect_probe.sockets_by_address[expected_addresses[0]]
        winner_socket = connect_probe.sockets_by_address[expected_addresses[1]]
        assert isinstance(failed_socket, _LifecycleSocket)
        assert isinstance(winner_socket, _LifecycleSocket)
        assert failed_socket.setsockopt_calls == [(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)]
        assert failed_socket.shutdown_calls == [socket.SHUT_RDWR]
        assert failed_socket.close_call_count == 1
        assert winner_socket.setsockopt_calls == [(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)]
        assert winner_socket.shutdown_calls == []

    async def test_uses_later_address_after_socket_creation_failure(self, mitm_ctx):
        requests: list[_RawHttpRequest] = []
        loop = asyncio.get_running_loop()
        socket_factory = _LifecycleSocketFactory(
            constructor_errors=(OSError(errno.EAFNOSUPPORT, "address family unsupported"), None)
        )
        resolver = _OrderedResolver(
            expected_host="firewall-auth.invalid",
            addresses=("2001:db8::1", "192.0.2.1"),
        )

        async def handle_client(
            reader: asyncio.StreamReader,
            writer: asyncio.StreamWriter,
        ) -> None:
            requests.append(await _read_raw_http_request(reader))
            await _write_success_response(writer)

        async with _run_test_server(handle_client) as port:
            connect_probe = _SimultaneousSockConnect(
                loop.sock_connect,
                ("127.0.0.1", port),
                participant_count=1,
            )
            expected_address: _SocketAddress = ("192.0.2.1", port)
            with (
                patch.dict(os.environ, _EMPTY_PROXY_ENVIRONMENT),
                patch.object(auth_client, "_dns_resolver", resolver),
                patch.object(auth_client.socket, "socket", side_effect=socket_factory),
                patch.object(loop, "sock_connect", new=connect_probe),
                patch.object(platform_api, "VERCEL_BYPASS", ""),
                mitm_ctx(api_url=f"http://firewall-auth.invalid:{port}"),
            ):
                result = await auth_client.fetch_firewall_headers(firewall_auth_request())

        assert result.payload.headers == {}
        assert len(requests) == 1
        assert resolver.lookups == ["firewall-auth.invalid"]
        assert socket_factory.constructor_families == [socket.AF_INET6, socket.AF_INET]
        assert connect_probe.attempted_addresses == [expected_address]
        assert connect_probe.completed_addresses == [expected_address]
        assert len(socket_factory.sockets) == 1
        winner_socket = socket_factory.sockets[0]
        assert winner_socket.setsockopt_calls == [(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)]
        assert winner_socket.shutdown_calls == []
        assert winner_socket.fileno() == -1

    async def test_propagates_final_socket_creation_error(self, mitm_ctx):
        final_error = OSError(errno.EMFILE, "file table overflow")
        socket_factory = _LifecycleSocketFactory(
            constructor_errors=(
                OSError(errno.EAFNOSUPPORT, "address family unsupported"),
                final_error,
            )
        )
        resolver = _OrderedResolver(
            expected_host="firewall-auth.invalid",
            addresses=("2001:db8::1", "192.0.2.1"),
        )

        with (
            patch.dict(os.environ, _EMPTY_PROXY_ENVIRONMENT),
            patch.object(auth_client, "_dns_resolver", resolver),
            patch.object(auth_client.socket, "socket", side_effect=socket_factory),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
            mitm_ctx(api_url="http://firewall-auth.invalid"),
            pytest.raises(OSError, match=r"file table overflow$") as exc_info,
        ):
            await auth_client.fetch_firewall_headers(firewall_auth_request())

        assert exc_info.value is final_error
        assert resolver.lookups == ["firewall-auth.invalid"]
        assert socket_factory.constructor_families == [socket.AF_INET6, socket.AF_INET]
        assert socket_factory.sockets == []

    async def test_retries_next_resolved_address_after_connect_failure(self, mitm_ctx):
        class OrderedResolver:
            async def lookup_ip(self, host: str) -> list[str]:
                assert host == "firewall-auth.invalid"
                return ["127.0.0.2", "127.0.0.1"]

        requests: list[_RawHttpRequest] = []
        client_sockets: list[socket.socket] = []
        real_socket = socket.socket

        def create_socket(
            family: int = -1,
            socket_type: int = -1,
            proto: int = -1,
            fileno: int | None = None,
        ) -> socket.socket:
            created = real_socket(family, socket_type, proto, fileno)
            if fileno is None:
                client_sockets.append(created)
            return created

        async def handle_client(
            reader: asyncio.StreamReader,
            writer: asyncio.StreamWriter,
        ) -> None:
            requests.append(await _read_raw_http_request(reader))
            await _write_success_response(writer)

        async with _run_test_server(handle_client) as port:
            with (
                patch.dict(os.environ, _EMPTY_PROXY_ENVIRONMENT),
                patch.object(auth_client, "_dns_resolver", OrderedResolver()),
                patch.object(auth_client.socket, "socket", side_effect=create_socket),
                patch.object(platform_api, "VERCEL_BYPASS", ""),
                mitm_ctx(api_url=f"http://firewall-auth.invalid:{port}"),
            ):
                result = await auth_client.fetch_firewall_headers(firewall_auth_request())

        assert result.payload.headers == {}
        assert len(requests) == 1
        assert len(client_sockets) == 2
        assert client_sockets[0].fileno() == -1

    async def test_aborts_other_successful_connections_in_same_batch(self, mitm_ctx):
        requests: list[_RawHttpRequest] = []

        async def handle_client(
            reader: asyncio.StreamReader,
            writer: asyncio.StreamWriter,
        ) -> None:
            try:
                request = await _read_raw_http_request(reader)
            except asyncio.IncompleteReadError:
                await _close_test_writer(writer)
                return
            requests.append(request)
            await _write_success_response(writer)

        loop = asyncio.get_running_loop()
        socket_factory = _LifecycleSocketFactory()
        resolver = _OrderedResolver(
            expected_host="firewall-auth.invalid",
            addresses=("192.0.2.2", "192.0.2.1"),
        )
        real_open_connection = asyncio.open_connection
        handoff_states: list[tuple[_LifecycleSocket, list[int], int]] = []

        async def record_open_connection(
            *,
            sock: socket.socket,
            limit: int,
        ) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
            assert isinstance(sock, _LifecycleSocket)
            handoff_states.append((sock, list(sock.shutdown_calls), sock.close_call_count))
            return await real_open_connection(sock=sock, limit=limit)

        async with _run_test_server(handle_client) as port:
            connect_probe = _SimultaneousSockConnect(
                loop.sock_connect,
                ("127.0.0.1", port),
                participant_count=2,
            )
            expected_addresses: list[_SocketAddress] = [
                ("192.0.2.2", port),
                ("192.0.2.1", port),
            ]
            with (
                patch.dict(os.environ, _EMPTY_PROXY_ENVIRONMENT),
                patch.object(auth_client, "_dns_resolver", resolver),
                patch.object(auth_client.socket, "socket", side_effect=socket_factory),
                patch.object(loop, "sock_connect", new=connect_probe),
                patch.object(auth_client.asyncio, "open_connection", new=record_open_connection),
                patch.object(
                    auth_client,
                    "_FIREWALL_AUTH_CONNECTION_ATTEMPT_DELAY_SECONDS",
                    0.0,
                ),
                patch.object(platform_api, "VERCEL_BYPASS", ""),
                mitm_ctx(api_url=f"http://firewall-auth.invalid:{port}"),
            ):
                result = await auth_client.fetch_firewall_headers(firewall_auth_request())

        assert result.payload.headers == {}
        assert len(requests) == 1
        assert connect_probe.attempted_addresses == expected_addresses
        assert set(connect_probe.completed_addresses) == set(expected_addresses)

        winner_socket = connect_probe.sockets_by_address[expected_addresses[0]]
        loser_socket = connect_probe.sockets_by_address[expected_addresses[1]]
        assert isinstance(winner_socket, _LifecycleSocket)
        assert isinstance(loser_socket, _LifecycleSocket)
        assert handoff_states == [(winner_socket, [], 0)]
        assert loser_socket.shutdown_calls == [socket.SHUT_RDWR]
        assert loser_socket.close_call_count == 1

    async def test_aborts_winner_when_stream_wrapping_fails(self, mitm_ctx):
        async def handle_client(
            reader: asyncio.StreamReader,
            writer: asyncio.StreamWriter,
        ) -> None:
            await reader.read()
            await _close_test_writer(writer)

        socket_factory = _LifecycleSocketFactory()
        handoff_states: list[tuple[_LifecycleSocket, list[int], int]] = []

        async def fail_open_connection(
            *,
            sock: socket.socket,
            limit: int,
        ) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
            assert limit == auth_client._MAX_FIREWALL_AUTH_RESPONSE_HEADER_BYTES
            assert isinstance(sock, _LifecycleSocket)
            handoff_states.append((sock, list(sock.shutdown_calls), sock.close_call_count))
            raise OSError("stream wrapping failed")

        async with _run_test_server(handle_client) as port:
            with (
                patch.dict(os.environ, _EMPTY_PROXY_ENVIRONMENT),
                patch.object(auth_client.socket, "socket", side_effect=socket_factory),
                patch.object(auth_client.asyncio, "open_connection", new=fail_open_connection),
                patch.object(platform_api, "VERCEL_BYPASS", ""),
                mitm_ctx(api_url=f"http://127.0.0.1:{port}"),
                pytest.raises(OSError, match=r"^stream wrapping failed$"),
            ):
                await auth_client.fetch_firewall_headers(firewall_auth_request())

        assert len(socket_factory.sockets) == 1
        winner_socket = socket_factory.sockets[0]
        assert handoff_states == [(winner_socket, [], 0)]
        assert winner_socket.shutdown_calls == [socket.SHUT_RDWR]
        assert winner_socket.close_call_count == 1

    async def test_connects_to_second_address_while_first_connect_is_pending(self, mitm_ctx):
        requests: list[_RawHttpRequest] = []

        async def handle_client(
            reader: asyncio.StreamReader,
            writer: asyncio.StreamWriter,
        ) -> None:
            requests.append(await _read_raw_http_request(reader))
            await _write_success_response(writer)

        loop = asyncio.get_running_loop()
        connect_probe = _PendingSockConnect(loop.sock_connect)
        resolver = _OrderedResolver(
            expected_host="firewall-auth.invalid",
            addresses=("192.0.2.1", "127.0.0.1"),
        )
        async with _run_test_server(handle_client) as port:
            with (
                patch.dict(os.environ, _EMPTY_PROXY_ENVIRONMENT),
                patch.object(auth_client, "_dns_resolver", resolver),
                patch.object(loop, "sock_connect", new=connect_probe),
                patch.object(
                    auth_client,
                    "_FIREWALL_AUTH_CONNECTION_ATTEMPT_DELAY_SECONDS",
                    0.01,
                ),
                patch.object(auth_client, "FIREWALL_AUTH_FETCH_DEADLINE_SECONDS", 0.2),
                patch.object(platform_api, "VERCEL_BYPASS", ""),
                mitm_ctx(api_url=f"http://firewall-auth.invalid:{port}"),
            ):
                result = await auth_client.fetch_firewall_headers(firewall_auth_request())

        assert result.payload.headers == {}
        assert len(requests) == 1
        assert [address[0] for address in connect_probe.attempted_addresses] == [
            "192.0.2.1",
            "127.0.0.1",
        ]
        assert connect_probe.cancelled_addresses == [("192.0.2.1", port)]
        assert connect_probe.max_active_count == 2
        assert connect_probe.active_count == 0
        assert all(sock.fileno() == -1 for sock in connect_probe.sockets)

    async def test_deduplicates_normalized_addresses_before_connection_racing(self, mitm_ctx):
        requests: list[_RawHttpRequest] = []

        async def handle_client(
            reader: asyncio.StreamReader,
            writer: asyncio.StreamWriter,
        ) -> None:
            requests.append(await _read_raw_http_request(reader))
            await _write_success_response(writer)

        loop = asyncio.get_running_loop()
        connect_probe = _PendingSockConnect(loop.sock_connect)
        resolver = _OrderedResolver(
            expected_host="firewall-auth.invalid",
            addresses=(
                "192.0.2.1",
                "192.0.2.1",
                "2001:0db8::1",
                "2001:db8::1",
                "192.0.2.2",
                "127.0.0.1",
            ),
        )
        async with _run_test_server(handle_client) as port:
            with (
                patch.dict(os.environ, _EMPTY_PROXY_ENVIRONMENT),
                patch.object(auth_client, "_dns_resolver", resolver),
                patch.object(loop, "sock_connect", new=connect_probe),
                patch.object(
                    auth_client,
                    "_FIREWALL_AUTH_CONNECTION_ATTEMPT_DELAY_SECONDS",
                    0.0,
                ),
                patch.object(platform_api, "VERCEL_BYPASS", ""),
                mitm_ctx(api_url=f"http://firewall-auth.invalid:{port}"),
            ):
                result = await auth_client.fetch_firewall_headers(firewall_auth_request())

        assert result.payload.headers == {}
        assert len(requests) == 1
        attempted_hosts = [address[0] for address in connect_probe.attempted_addresses]
        assert attempted_hosts == [
            "192.0.2.1",
            "2001:db8::1",
            "192.0.2.2",
            "127.0.0.1",
        ]
        assert len(attempted_hosts) == len(set(attempted_hosts))
        assert {address[0] for address in connect_probe.cancelled_addresses} == {
            "192.0.2.1",
            "2001:db8::1",
            "192.0.2.2",
        }
        assert connect_probe.max_active_count == 4
        assert connect_probe.active_count == 0
        assert all(sock.fileno() == -1 for sock in connect_probe.sockets)

    async def test_bounds_pending_connects_and_reaches_address_beyond_window(self, mitm_ctx):
        requests: list[_RawHttpRequest] = []

        async def handle_client(
            reader: asyncio.StreamReader,
            writer: asyncio.StreamWriter,
        ) -> None:
            requests.append(await _read_raw_http_request(reader))
            await _write_success_response(writer)

        pending_hosts = tuple(f"192.0.2.{index}" for index in range(1, 6))
        loop = asyncio.get_running_loop()
        connect_probe = _PendingSockConnect(loop.sock_connect)
        resolver = _OrderedResolver(
            expected_host="firewall-auth.invalid",
            addresses=(*pending_hosts, "127.0.0.1"),
        )
        async with _run_test_server(handle_client) as port:
            with (
                patch.dict(os.environ, _EMPTY_PROXY_ENVIRONMENT),
                patch.object(auth_client, "_dns_resolver", resolver),
                patch.object(loop, "sock_connect", new=connect_probe),
                patch.object(
                    auth_client,
                    "_FIREWALL_AUTH_CONNECTION_ATTEMPT_DELAY_SECONDS",
                    0.01,
                ),
                patch.object(auth_client, "FIREWALL_AUTH_FETCH_DEADLINE_SECONDS", 0.5),
                patch.object(platform_api, "VERCEL_BYPASS", ""),
                mitm_ctx(api_url=f"http://firewall-auth.invalid:{port}"),
            ):
                result = await auth_client.fetch_firewall_headers(firewall_auth_request())

        assert result.payload.headers == {}
        assert len(requests) == 1
        assert [address[0] for address in connect_probe.attempted_addresses] == [
            *pending_hosts,
            "127.0.0.1",
        ]
        assert {address[0] for address in connect_probe.cancelled_addresses} == set(pending_hosts)
        assert connect_probe.max_active_count == 4
        assert connect_probe.active_count == 0
        assert all(sock.fileno() == -1 for sock in connect_probe.sockets)

    async def test_total_deadline_cancels_pending_connection_attempts(self, mitm_ctx):
        pending_hosts = tuple(f"192.0.2.{index}" for index in range(1, 4))
        loop = asyncio.get_running_loop()
        connect_probe = _PendingSockConnect(loop.sock_connect)
        resolver = _OrderedResolver(
            expected_host="firewall-auth.invalid",
            addresses=pending_hosts,
        )
        with (
            patch.dict(os.environ, _EMPTY_PROXY_ENVIRONMENT),
            patch.object(auth_client, "_dns_resolver", resolver),
            patch.object(loop, "sock_connect", new=connect_probe),
            patch.object(
                auth_client,
                "_FIREWALL_AUTH_CONNECTION_ATTEMPT_DELAY_SECONDS",
                0.01,
            ),
            patch.object(auth_client, "FIREWALL_AUTH_FETCH_DEADLINE_SECONDS", 0.1),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
            mitm_ctx(api_url="http://firewall-auth.invalid"),
            pytest.raises(auth_client.FirewallAuthDeadlineExceededError) as exc_info,
        ):
            await auth_client.fetch_firewall_headers(firewall_auth_request())

        assert exc_info.value.phase is auth_client.FirewallAuthFetchPhase.CONNECT
        assert [address[0] for address in connect_probe.attempted_addresses] == list(pending_hosts)
        assert {address[0] for address in connect_probe.cancelled_addresses} == set(pending_hosts)
        assert connect_probe.max_active_count == 3
        assert connect_probe.active_count == 0
        assert all(sock.fileno() == -1 for sock in connect_probe.sockets)

    async def test_protocol_error_does_not_expose_response_bytes(self, mitm_ctx):
        sensitive_response_bytes = b"sensitive-resolved-auth-value"

        async def handle_client(
            reader: asyncio.StreamReader,
            writer: asyncio.StreamWriter,
        ) -> None:
            await _read_raw_http_request(reader)
            writer.write(
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n"
                b"Connection: close\r\n\r\n" + sensitive_response_bytes + b"\r\n"
            )
            await writer.drain()
            await _close_test_writer(writer)

        async with _run_test_server(handle_client) as port:
            with (
                mitm_ctx(api_url=f"http://127.0.0.1:{port}"),
                patch.object(platform_api, "VERCEL_BYPASS", ""),
                pytest.raises(ValueError, match=r"^Firewall auth HTTP protocol error$") as exc_info,
            ):
                await auth_client.fetch_firewall_headers(firewall_auth_request())

        assert str(exc_info.value) == "Firewall auth HTTP protocol error"
        assert sensitive_response_bytes.decode() not in str(exc_info.value)

    async def test_total_deadline_aborts_a_trickling_response(self, mitm_ctx):
        request_received = asyncio.Event()
        peer_closed = asyncio.Event()

        async def handle_client(
            reader: asyncio.StreamReader,
            writer: asyncio.StreamWriter,
        ) -> None:
            await _read_raw_http_request(reader)
            request_received.set()
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 1000000\r\nConnection: close\r\n\r\n")
            await writer.drain()
            await _trickle_until_peer_disconnect(reader, writer, peer_closed)

        async with _run_test_server(handle_client) as port:
            with (
                mitm_ctx(api_url=f"http://127.0.0.1:{port}"),
                patch.object(auth_client, "FIREWALL_AUTH_FETCH_DEADLINE_SECONDS", 0.5),
                patch.object(platform_api, "VERCEL_BYPASS", ""),
                pytest.raises(auth_client.FirewallAuthDeadlineExceededError) as exc_info,
            ):
                await auth_client.fetch_firewall_headers(
                    firewall_auth_request(
                        encrypted_secrets="sensitive-encrypted-secrets",
                        sandbox_auth="sensitive-sandbox-token",
                    )
                )

            await asyncio.wait_for(request_received.wait(), timeout=2.0)
            await asyncio.wait_for(peer_closed.wait(), timeout=2.0)

        assert exc_info.value.phase is auth_client.FirewallAuthFetchPhase.RESPONSE_BODY
        assert str(exc_info.value) == ("Firewall auth fetch deadline exceeded during response_body")
        assert "sensitive-encrypted-secrets" not in str(exc_info.value)
        assert "sensitive-sandbox-token" not in str(exc_info.value)

    async def test_total_deadline_attributes_a_stalled_response_header_wait(self, mitm_ctx):
        request_received = asyncio.Event()
        peer_closed = asyncio.Event()

        async def handle_client(
            reader: asyncio.StreamReader,
            writer: asyncio.StreamWriter,
        ) -> None:
            await _read_raw_http_request(reader)
            request_received.set()
            with suppress(ConnectionResetError):
                while await reader.read(64 * 1024):
                    pass
            peer_closed.set()
            await _close_test_writer(writer)

        async with _run_test_server(handle_client) as port:
            with (
                mitm_ctx(api_url=f"http://127.0.0.1:{port}"),
                patch.object(auth_client, "FIREWALL_AUTH_FETCH_DEADLINE_SECONDS", 0.1),
                patch.object(platform_api, "VERCEL_BYPASS", ""),
                pytest.raises(auth_client.FirewallAuthDeadlineExceededError) as exc_info,
            ):
                await auth_client.fetch_firewall_headers(firewall_auth_request())

            await asyncio.wait_for(request_received.wait(), timeout=2.0)
            await asyncio.wait_for(peer_closed.wait(), timeout=2.0)

        assert exc_info.value.phase is auth_client.FirewallAuthFetchPhase.RESPONSE_HEADERS
        assert str(exc_info.value) == (
            "Firewall auth fetch deadline exceeded during response_headers"
        )

    async def test_total_deadline_aborts_a_stalled_tls_handshake(self, mitm_ctx):
        handshake_started = asyncio.Event()
        peer_closed = asyncio.Event()

        async def handle_client(
            reader: asyncio.StreamReader,
            writer: asyncio.StreamWriter,
        ) -> None:
            await reader.readexactly(1)
            handshake_started.set()
            with suppress(ConnectionResetError):
                while await reader.read(64 * 1024):
                    pass
            peer_closed.set()
            await _close_test_writer(writer)

        proxy_environment = {
            "http_proxy": "",
            "HTTP_PROXY": "",
            "https_proxy": "",
            "HTTPS_PROXY": "",
            "all_proxy": "",
            "ALL_PROXY": "",
            "no_proxy": "",
            "NO_PROXY": "",
        }
        async with _run_test_server(handle_client) as port:
            with (
                patch.dict(os.environ, proxy_environment),
                mitm_ctx(api_url=f"https://127.0.0.1:{port}"),
                patch.object(auth_client, "FIREWALL_AUTH_FETCH_DEADLINE_SECONDS", 0.5),
                pytest.raises(auth_client.FirewallAuthDeadlineExceededError) as exc_info,
            ):
                await auth_client.fetch_firewall_headers(firewall_auth_request())

            await asyncio.wait_for(handshake_started.wait(), timeout=2.0)
            await asyncio.wait_for(peer_closed.wait(), timeout=2.0)

        assert exc_info.value.phase is auth_client.FirewallAuthFetchPhase.TLS

    async def test_total_deadline_cancels_dns_lookup_before_connect(self, mitm_ctx):
        class BlockingResolver:
            def __init__(self) -> None:
                self.started = asyncio.Event()
                self.cancelled = asyncio.Event()

            async def lookup_ip(self, host: str) -> list[str]:
                assert host == "firewall-auth.invalid"
                self.started.set()
                try:
                    await asyncio.Future()
                except asyncio.CancelledError:
                    self.cancelled.set()
                    raise
                raise AssertionError("unreachable")

        resolver = BlockingResolver()
        proxy_environment = {
            "http_proxy": "",
            "HTTP_PROXY": "",
            "https_proxy": "",
            "HTTPS_PROXY": "",
            "all_proxy": "",
            "ALL_PROXY": "",
            "no_proxy": "",
            "NO_PROXY": "",
        }
        with (
            patch.dict(os.environ, proxy_environment),
            patch.object(auth_client, "_dns_resolver", resolver),
            patch.object(auth_client, "FIREWALL_AUTH_FETCH_DEADLINE_SECONDS", 0.05),
            mitm_ctx(api_url="http://firewall-auth.invalid"),
            pytest.raises(auth_client.FirewallAuthDeadlineExceededError) as exc_info,
        ):
            await auth_client.fetch_firewall_headers(firewall_auth_request())

        assert exc_info.value.phase is auth_client.FirewallAuthFetchPhase.DNS
        assert resolver.started.is_set()
        assert resolver.cancelled.is_set()

    async def test_shared_deadline_failure_releases_key_and_does_not_block_other_key(
        self,
        mitm_ctx,
    ):
        requests: list[_RawHttpRequest] = []
        first_request_received = asyncio.Event()
        first_peer_closed = asyncio.Event()

        async def handle_client(
            reader: asyncio.StreamReader,
            writer: asyncio.StreamWriter,
        ) -> None:
            requests.append(await _read_raw_http_request(reader))
            request_number = len(requests)
            if request_number != 1:
                await _write_success_response(writer)
                return

            first_request_received.set()
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 1000000\r\nConnection: close\r\n\r\n")
            await writer.drain()
            await _trickle_until_peer_disconnect(reader, writer, first_peer_closed)

        shared_key = auth_cache_key(api_id="shared")
        unrelated_key = auth_cache_key(api_id="unrelated")
        request = firewall_auth_request()
        async with _run_test_server(handle_client) as port:
            with (
                mitm_ctx(api_url=f"http://127.0.0.1:{port}"),
                patch.object(auth_client, "FIREWALL_AUTH_FETCH_DEADLINE_SECONDS", 0.5),
                patch.object(platform_api, "VERCEL_BYPASS", ""),
            ):
                leader = asyncio.create_task(auth_cache.get_firewall_headers(shared_key, request))
                await asyncio.wait_for(first_request_received.wait(), timeout=2.0)
                followers = [
                    asyncio.create_task(auth_cache.get_firewall_headers(shared_key, request))
                    for _ in range(2)
                ]
                unrelated = await auth_cache.get_firewall_headers(unrelated_key, request)
                shared_results = await asyncio.gather(
                    leader,
                    *followers,
                    return_exceptions=True,
                )
                await asyncio.wait_for(first_peer_closed.wait(), timeout=2.0)
                retry = await auth_cache.get_firewall_headers(shared_key, request)

        assert unrelated["headers"] == {}
        assert unrelated["cache_hit"] is False
        assert all(
            isinstance(result, auth_client.FirewallAuthDeadlineExceededError)
            for result in shared_results
        )
        assert all(
            result.phase is auth_client.FirewallAuthFetchPhase.RESPONSE_BODY
            for result in shared_results
            if isinstance(result, auth_client.FirewallAuthDeadlineExceededError)
        )
        assert len({id(result) for result in shared_results}) == 1
        assert retry["headers"] == {}
        assert retry["cache_hit"] is False
        assert len(requests) == 3

    async def test_http_environment_proxy_uses_absolute_form_and_proxy_credentials(
        self,
        mitm_ctx,
    ):
        proxy = FakeAuthEndpoint()
        proxy.queue_json_response(firewall_auth_success_response({}))
        resolver = _OrderedResolver(
            expected_host="xn--fa-hia.proxy",
            addresses=("127.0.0.1",),
        )

        with proxy.run():
            proxy_url = proxy.api_url.removeprefix("http://").replace(
                "127.0.0.1",
                "proxy-user:proxy-password@faß.proxy",
            )
            proxy_environment = {
                "http_proxy": proxy_url,
                "HTTP_PROXY": "",
                "all_proxy": "",
                "ALL_PROXY": "",
                "no_proxy": "",
                "NO_PROXY": "",
            }
            with (
                patch.dict(os.environ, proxy_environment),
                patch.object(auth_client, "_dns_resolver", resolver),
                mitm_ctx(api_url="http://platform.example:8123"),
                patch.object(platform_api, "VERCEL_BYPASS", ""),
            ):
                result = await auth_client.fetch_firewall_headers(firewall_auth_request())

        expected_proxy_authorization = "Basic " + base64.b64encode(
            b"proxy-user:proxy-password"
        ).decode("ascii")
        assert result.payload.headers == {}
        assert proxy.request_count == 1
        assert proxy.requests[0].path == (
            "http://platform.example:8123/api/webhooks/agent/firewall/auth"
        )
        assert proxy.requests[0].headers["host"] == "platform.example:8123"
        assert proxy.requests[0].headers["proxy-authorization"] == expected_proxy_authorization
        assert proxy.requests[0].headers["authorization"] == "Bearer tok-xyz"

    async def test_environment_proxy_rejects_unsafe_hostname_before_dns(self, mitm_ctx):
        resolved_hosts: list[str] = []

        class RecordingResolver:
            async def lookup_ip(self, host: str) -> list[str]:
                resolved_hosts.append(host)
                return []

        proxy_environment = {
            "http_proxy": "http://proxy-user:proxy-password@\uff26\uff2f\uff2f.proxy:8123",
            "HTTP_PROXY": "",
            "all_proxy": "",
            "ALL_PROXY": "",
            "no_proxy": "platform.example",
            "NO_PROXY": "platform.example",
        }
        with (
            patch.dict(os.environ, proxy_environment),
            patch.object(auth_client, "_dns_resolver", RecordingResolver()),
            mitm_ctx(api_url="http://platform.example:8123"),
            pytest.raises(UnicodeError, match="unsafe IDNA compatibility mapping"),
        ):
            await auth_client.fetch_firewall_headers(firewall_auth_request())

        assert resolved_hosts == []

    async def test_no_proxy_bypasses_environment_proxy(self, mitm_ctx):
        origin = FakeAuthEndpoint()
        proxy = FakeAuthEndpoint()
        origin.queue_json_response(firewall_auth_success_response({}))

        with origin.run(), proxy.run():
            proxy_environment = {
                "http_proxy": proxy.api_url,
                "HTTP_PROXY": "",
                "all_proxy": "",
                "ALL_PROXY": "",
                "no_proxy": "127.0.0.1",
                "NO_PROXY": "127.0.0.1",
            }
            with (
                patch.dict(os.environ, proxy_environment),
                mitm_ctx(api_url=origin.api_url),
                patch.object(platform_api, "VERCEL_BYPASS", ""),
            ):
                await auth_client.fetch_firewall_headers(firewall_auth_request())

        assert origin.request_count == 1
        assert proxy.request_count == 0

    @pytest.mark.parametrize(
        ("origin_authority", "connect_authority"),
        [
            ("platform.example", "platform.example:443"),
            ("platform.example:443", "platform.example:443"),
            ("platform.example:8443", "platform.example:8443"),
            ("[2001:db8::1]", "[2001:db8::1]:443"),
            ("[2001:db8::1]:443", "[2001:db8::1]:443"),
            ("[2001:db8::1]:8443", "[2001:db8::1]:8443"),
        ],
    )
    async def test_https_proxy_connect_failure_preserves_status_with_response_body(
        self,
        mitm_ctx,
        origin_authority: str,
        connect_authority: str,
    ):
        proxy_requests: list[_RawHttpRequest] = []
        response_body = b"proxy authentication required"

        async def handle_proxy(
            reader: asyncio.StreamReader,
            writer: asyncio.StreamWriter,
        ) -> None:
            proxy_requests.append(await _read_raw_http_request(reader))
            writer.write(
                b"HTTP/1.1 407 Proxy Authentication Required\r\n"
                + f"Content-Length: {len(response_body)}\r\n\r\n".encode("ascii")
                + response_body
            )
            await writer.drain()
            await _close_test_writer(writer)

        async with _run_test_server(handle_proxy) as proxy_port:
            with (
                patch.dict(
                    os.environ,
                    _https_proxy_environment(f"http://127.0.0.1:{proxy_port}"),
                ),
                patch.object(platform_api, "VERCEL_BYPASS", ""),
                mitm_ctx(api_url=f"https://{origin_authority}"),
                pytest.raises(
                    OSError,
                    match=r"^Firewall auth HTTP proxy CONNECT failed with status 407$",
                ) as exc_info,
            ):
                await auth_client.fetch_firewall_headers(firewall_auth_request())

        assert len(proxy_requests) == 1
        assert proxy_requests[0].method == "CONNECT"
        assert proxy_requests[0].target == connect_authority
        assert proxy_requests[0].headers["host"] == connect_authority
        assert response_body.decode() not in str(exc_info.value)

    async def test_https_proxy_connect_scans_fragmented_headers_incrementally(
        self,
        mitm_ctx,
    ):
        header_terminator = b"\r\n\r\n"
        response = (
            b"HTTP/1.1 100 Continue\r\nX-Info: ready\r\n\r\n"
            b"HTTP/1.1 407 Proxy Authentication Required\r\nX-Fill: "
            + b"x" * 4096
            + header_terminator
        )
        search_misses: asyncio.Queue[None] = asyncio.Queue()
        find_calls: list[tuple[int, int]] = []

        class FindTrackingBytearray(bytearray):
            def find(self, sub: bytes, start: int = 0, end: int | None = None) -> int:
                find_calls.append((len(self), start))
                result = super().find(sub, start) if end is None else super().find(sub, start, end)
                if result < 0:
                    search_misses.put_nowait(None)
                return result

        async def handle_proxy(
            reader: asyncio.StreamReader,
            writer: asyncio.StreamWriter,
        ) -> None:
            await _read_raw_http_request(reader)
            for offset in range(len(response)):
                await search_misses.get()
                writer.write(response[offset : offset + 1])
                await writer.drain()
            await _close_test_writer(writer)

        async with _run_test_server(handle_proxy) as proxy_port:
            with (
                patch.dict(
                    os.environ,
                    _https_proxy_environment(f"http://127.0.0.1:{proxy_port}"),
                ),
                patch.object(auth_client, "bytearray", FindTrackingBytearray, create=True),
                patch.object(platform_api, "VERCEL_BYPASS", ""),
                mitm_ctx(api_url="https://platform.example"),
                pytest.raises(
                    OSError,
                    match=r"^Firewall auth HTTP proxy CONNECT failed with status 407$",
                ),
            ):
                await auth_client.fetch_firewall_headers(firewall_auth_request())

        search_windows = [buffer_length - start for buffer_length, start in find_calls]
        assert len(find_calls) == len(response) + 2
        assert max(search_windows) <= len(header_terminator)
        assert sum(search_windows) <= len(response) * len(header_terminator)

    async def test_https_proxy_connect_bounds_response_headers_and_closes_socket(
        self,
        mitm_ctx,
    ):
        proxy_requests: list[_RawHttpRequest] = []
        proxy_peer_closed = asyncio.Event()

        async def handle_proxy(
            reader: asyncio.StreamReader,
            writer: asyncio.StreamWriter,
        ) -> None:
            proxy_requests.append(await _read_raw_http_request(reader))
            writer.write(
                b"HTTP/1.1 100 Continue\r\nX-Fill: "
                + b"x" * auth_client._MAX_FIREWALL_AUTH_RESPONSE_HEADER_BYTES
            )
            with suppress(ConnectionError):
                await writer.drain()
            with suppress(ConnectionResetError):
                while await reader.read(64 * 1024):
                    pass
            proxy_peer_closed.set()
            await _close_test_writer(writer)

        async with _run_test_server(handle_proxy) as proxy_port:
            with (
                patch.dict(
                    os.environ,
                    _https_proxy_environment(f"http://127.0.0.1:{proxy_port}"),
                ),
                patch.object(platform_api, "VERCEL_BYPASS", ""),
                mitm_ctx(api_url="https://platform.example"),
                pytest.raises(
                    ValueError,
                    match=r"^Firewall auth HTTP proxy response headers too large$",
                ),
            ):
                await auth_client.fetch_firewall_headers(firewall_auth_request())

            await asyncio.wait_for(proxy_peer_closed.wait(), timeout=2.0)

        assert len(proxy_requests) == 1
        assert proxy_requests[0].method == "CONNECT"
        assert proxy_requests[0].target == "platform.example:443"

    async def test_total_deadline_aborts_stalled_https_proxy_connect(
        self,
        mitm_ctx,
    ):
        connect_received = asyncio.Event()
        proxy_peer_closed = asyncio.Event()

        async def handle_proxy(
            reader: asyncio.StreamReader,
            writer: asyncio.StreamWriter,
        ) -> None:
            await _read_raw_http_request(reader)
            connect_received.set()
            with suppress(ConnectionResetError):
                while await reader.read(64 * 1024):
                    pass
            proxy_peer_closed.set()
            await _close_test_writer(writer)

        async with _run_test_server(handle_proxy) as proxy_port:
            with (
                patch.dict(
                    os.environ,
                    _https_proxy_environment(f"http://127.0.0.1:{proxy_port}"),
                ),
                patch.object(auth_client, "FIREWALL_AUTH_FETCH_DEADLINE_SECONDS", 0.1),
                patch.object(platform_api, "VERCEL_BYPASS", ""),
                mitm_ctx(api_url="https://platform.example"),
                pytest.raises(auth_client.FirewallAuthDeadlineExceededError) as exc_info,
            ):
                await auth_client.fetch_firewall_headers(firewall_auth_request())

            await asyncio.wait_for(connect_received.wait(), timeout=2.0)
            await asyncio.wait_for(proxy_peer_closed.wait(), timeout=2.0)

        assert exc_info.value.phase is auth_client.FirewallAuthFetchPhase.PROXY_CONNECT

    @pytest.mark.parametrize(
        ("origin_authority", "connect_authority"),
        [
            ("localhost", "localhost:443"),
            ("localhost:443", "localhost:443"),
            ("localhost:8443", "localhost:8443"),
        ],
    )
    async def test_https_proxy_connect_preserves_origin_tls_and_isolates_credentials(
        self,
        mitm_ctx,
        tmp_path: Path,
        origin_authority: str,
        connect_authority: str,
    ):
        server_context, ca_path = _create_tls_server(tmp_path)
        origin_requests: list[_RawHttpRequest] = []
        proxy_requests: list[http.Request] = []

        async def handle_origin(
            reader: asyncio.StreamReader,
            writer: asyncio.StreamWriter,
        ) -> None:
            origin_requests.append(await _read_raw_http_request(reader))
            await _write_success_response(
                writer, headers={"Authorization": "Bearer resolved-token"}
            )

        async with _run_test_server(handle_origin, ssl_context=server_context) as origin_port:

            async def handle_proxy(
                client_reader: asyncio.StreamReader,
                client_writer: asyncio.StreamWriter,
            ) -> None:
                header_block = await client_reader.readuntil(b"\r\n\r\n")
                try:
                    request = read_request_head(header_block[:-4].split(b"\r\n"))
                except ValueError:
                    client_writer.write(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n")
                    await client_writer.drain()
                    await _close_test_writer(client_writer)
                    return
                proxy_requests.append(request)
                assert request.method == "CONNECT"
                assert request.authority == connect_authority
                # Map the validated synthetic target to an unprivileged loopback TLS endpoint.
                origin_reader, origin_writer = await asyncio.open_connection(
                    "127.0.0.1",
                    origin_port,
                )
                client_writer.write(
                    b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 Connection Established\r\n\r\n"
                )
                await client_writer.drain()

                try:
                    await asyncio.gather(
                        _relay_test_stream(client_reader, origin_writer),
                        _relay_test_stream(origin_reader, client_writer),
                    )
                finally:
                    await _close_test_writer(origin_writer)
                    await _close_test_writer(client_writer)

            async with _run_test_server(handle_proxy) as proxy_port:
                proxy_url = f"http://proxy-user:proxy-password@127.0.0.1:{proxy_port}"
                with (
                    patch.dict(
                        os.environ,
                        _https_proxy_environment(proxy_url) | _tls_trust_environment(ca_path),
                    ),
                    patch.object(platform_api, "VERCEL_BYPASS", ""),
                    mitm_ctx(api_url=f"https://{origin_authority}"),
                ):
                    result = await auth_client.fetch_firewall_headers(
                        firewall_auth_request(
                            auth_headers={"Authorization": "Bearer ${{ secrets.TOKEN }}"}
                        )
                    )

        expected_proxy_authorization = "Basic " + base64.b64encode(
            b"proxy-user:proxy-password"
        ).decode("ascii")
        assert result.payload.headers == {"Authorization": "Bearer resolved-token"}
        assert len(proxy_requests) == 1
        assert proxy_requests[0].method == "CONNECT"
        assert proxy_requests[0].authority == connect_authority
        assert proxy_requests[0].headers["host"] == connect_authority
        assert proxy_requests[0].headers["proxy-authorization"] == expected_proxy_authorization
        assert "authorization" not in proxy_requests[0].headers
        assert len(origin_requests) == 1
        assert origin_requests[0].method == "POST"
        assert origin_requests[0].target == "/api/webhooks/agent/firewall/auth"
        assert origin_requests[0].headers["host"] == origin_authority
        assert origin_requests[0].headers["authorization"] == "Bearer tok-xyz"
        assert json.loads(origin_requests[0].body) == {
            "encryptedSecrets": "iv:tag:data",
            "authHeaders": {"Authorization": "Bearer ${{ secrets.TOKEN }}"},
        }
        assert "proxy-authorization" not in origin_requests[0].headers

    async def test_https_proxy_connect_rejects_pre_tls_response_bytes(
        self,
        mitm_ctx,
        tmp_path: Path,
    ):
        server_context, ca_path = _create_tls_server(tmp_path)
        origin_requests: list[_RawHttpRequest] = []
        proxy_requests: list[_RawHttpRequest] = []
        proxy_peer_closed = asyncio.Event()

        async def handle_origin(
            reader: asyncio.StreamReader,
            writer: asyncio.StreamWriter,
        ) -> None:
            origin_requests.append(await _read_raw_http_request(reader))
            await _write_success_response(writer)

        async with _run_test_server(handle_origin, ssl_context=server_context) as origin_port:

            async def handle_proxy(
                client_reader: asyncio.StreamReader,
                client_writer: asyncio.StreamWriter,
            ) -> None:
                proxy_requests.append(await _read_raw_http_request(client_reader))
                origin_reader, origin_writer = await asyncio.open_connection(
                    "127.0.0.1",
                    origin_port,
                )
                client_writer.write(
                    b"HTTP/1.1 200 Connection Established\r\n\r\n"
                    + _success_response_bytes(
                        headers={"Authorization": "Bearer proxy-forged-token"}
                    )
                )
                await client_writer.drain()

                async def relay_client_to_origin() -> None:
                    try:
                        await _relay_test_stream(client_reader, origin_writer)
                    finally:
                        proxy_peer_closed.set()

                try:
                    await asyncio.gather(
                        relay_client_to_origin(),
                        _relay_test_stream(origin_reader, client_writer),
                    )
                finally:
                    await _close_test_writer(origin_writer)
                    await _close_test_writer(client_writer)

            async with _run_test_server(handle_proxy) as proxy_port:
                with (
                    patch.dict(
                        os.environ,
                        _https_proxy_environment(f"http://127.0.0.1:{proxy_port}")
                        | _tls_trust_environment(ca_path),
                    ),
                    patch.object(platform_api, "VERCEL_BYPASS", ""),
                    mitm_ctx(api_url=f"https://localhost:{origin_port}"),
                    pytest.raises(
                        ValueError,
                        match=r"^Firewall auth HTTP proxy sent data before TLS$",
                    ),
                ):
                    await auth_client.fetch_firewall_headers(
                        firewall_auth_request(
                            auth_headers={
                                "Authorization": "Bearer ${{ secrets.TOKEN }}",
                            }
                        )
                    )

                await asyncio.wait_for(proxy_peer_closed.wait(), timeout=2.0)

        assert len(proxy_requests) == 1
        assert proxy_requests[0].method == "CONNECT"
        assert proxy_requests[0].target == f"localhost:{origin_port}"
        assert origin_requests == []
