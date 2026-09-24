"""Client and response parsing for the runner firewall auth endpoint.

Transport contract
------------------
``fetch_firewall_headers`` serializes one firewall-auth request, builds the platform request through
``platform_api.make_api_request``, selects a connection route, performs the HTTP exchange, and
parses the bounded response. The request body preserves ``FirewallAuthRequest``'s omission semantics
and stable JSON serialization. The bearer ``Authorization`` header belongs to the platform origin.
Proxy credentials come from the selected environment proxy and must stay at the proxy boundary.

The route depends on the origin scheme and the environment proxy decision:

=================  ===============================  ================================================
Origin             Direct or ``no_proxy``            HTTP environment proxy
=================  ===============================  ================================================
HTTP               Connect to the origin and send    Connect to the proxy and send an absolute-form
                   the path/query target.            target; ``Host`` remains the origin authority.
HTTPS              Connect to the origin, negotiate  Connect to the proxy, issue ``CONNECT`` for the
                   TLS for the origin, and send     origin authority, then negotiate origin TLS
                   the path/query target.            through the tunnel and send the path/query
                                                     target.
=================  ===============================  ================================================

Proxy selection uses the standard environment settings for the origin scheme and ``no_proxy``
bypass rules. Only HTTP proxy endpoints are supported; an HTTPS or other proxy endpoint is rejected.
CONNECT targets always include the effective origin port, even when the platform URL omits it.
For an HTTP origin, proxy authorization is sent in ``Proxy-Authorization`` on the absolute-form
request. For an HTTPS origin, it is sent only on ``CONNECT`` and is never forwarded through the
tunnel to the origin. After ``CONNECT`` succeeds, any bytes already buffered from the proxy are
rejected before TLS. Origin certificate verification and SNI use the origin hostname, not the proxy
hostname.

The transport resolves hostnames through the add-on DNS resolver (literal IP addresses bypass DNS),
normalizes and deduplicates the resolved addresses, and attempts them in resolver order. The first
attempt starts immediately; later attempts are staggered by 0.25 seconds and at most four attempts
are active at once. Among completed successes, the lowest original address index is the
deterministic winner. Failed, cancelled, losing, and still-pending attempts are aborted. The winning
socket is handed to the stream wrapper, which owns it together with the stream writer through proxy
CONNECT and TLS, request writing, and response parsing. Normal completion closes the writer and raw
socket. Exceptions and cancellation abort both transports.

Proxy CONNECT response headers and h11 incomplete events are bounded at 64 KiB. The origin response
body is bounded at ``MAX_FIREWALL_AUTH_RESPONSE_BODY_BYTES`` (256 KiB). One monotonic
``FIREWALL_AUTH_FETCH_DEADLINE_SECONDS`` deadline (10 seconds by default) covers DNS, connection
racing, proxy CONNECT, TLS, request writing, response headers, and the bounded response body.
Deadline errors retain the active phase from that closed transport vocabulary.
"""

import asyncio
import base64
import errno
import io
import ipaddress
import json
import math
import socket
import ssl
import urllib.error
import urllib.parse
import urllib.request
from contextlib import suppress
from dataclasses import dataclass, field, replace
from email.message import Message
from enum import StrEnum
from typing import NamedTuple, Protocol, TypeGuard

import h11
import mitmproxy_rs

import platform_api
from aws_sigv4 import AwsSigV4Credentials

MAX_FIREWALL_AUTH_RESPONSE_BODY_BYTES = 256 * 1024
FIREWALL_AUTH_FETCH_DEADLINE_SECONDS = 10.0
_MAX_FIREWALL_AUTH_RESPONSE_HEADER_BYTES = 64 * 1024
# RFC 8305's default cadence; four slots keep the oldest path eligible for about one second.
_FIREWALL_AUTH_CONNECTION_ATTEMPT_DELAY_SECONDS = 0.25
_MAX_CONCURRENT_FIREWALL_AUTH_CONNECTION_ATTEMPTS = 4
_DEFAULT_HTTP_PORT = 80
_DEFAULT_HTTPS_PORT = 443
_IPV6_VERSION = 6
_HTTP_STATUS_LINE_MIN_PARTS = 2
_HTTP_STATUS_INFORMATIONAL_MIN = 100
_HTTP_STATUS_SUCCESS_MIN = 200
_HTTP_STATUS_REDIRECTION_MIN = 300
_HTTP_STATUS_SWITCHING_PROTOCOLS = 101
_STRUCTURED_FIREWALL_AUTH_ERROR_CODES = frozenset(
    {
        "FORBIDDEN",
        "TOKEN_REFRESH_FAILED",
        "TOKEN_ACCESS_RESOLUTION_FAILED",
    }
)
_FIREWALL_AUTH_FAILURE_REASONS = frozenset({"upstream_provider", "reconnect_required"})
_dns_resolver: "_AddressResolver | None" = None
_https_context: ssl.SSLContext | None = None


class ConnectorNotConfiguredError(Exception):
    """Raised when the auth endpoint returns 424 — connector not linked or misconfigured."""


class InsufficientCreditsError(Exception):
    """Raised when the auth endpoint denies billable firewall auth for credits."""


class FirewallAuthResponseTooLargeError(Exception):
    """Raised when /firewall/auth returns a response body above the local cap."""


class FirewallAuthFetchPhase(StrEnum):
    """Bounded transport phase active when a firewall auth fetch deadline expires."""

    DNS = "dns"
    CONNECT = "connect"
    PROXY_CONNECT = "proxy_connect"
    TLS = "tls"
    REQUEST_WRITE = "request_write"
    RESPONSE_HEADERS = "response_headers"
    RESPONSE_BODY = "response_body"


class FirewallAuthDeadlineExceededError(Exception):
    """Raised when one /firewall/auth request exceeds its total lifetime."""

    def __init__(self, phase: FirewallAuthFetchPhase):
        super().__init__(f"Firewall auth fetch deadline exceeded during {phase.value}")
        self.phase = phase


class FirewallAuthApiError(Exception):
    """Raised for general /firewall/auth errors recognized by the runner.

    The recognized codes are ``FORBIDDEN``, ``TOKEN_REFRESH_FAILED``, and
    ``TOKEN_ACCESS_RESOLUTION_FAILED``. A string-list ``connectors`` value is
    preserved. The wire ``failureReason`` is preserved as ``failure_reason``
    only for ``upstream_provider`` and ``reconnect_required``.
    """

    def __init__(
        self,
        *,
        status: int,
        code: str,
        message: str,
        connectors: list[str] | None = None,
        failure_reason: str | None = None,
    ):
        super().__init__(message)
        self.status = status
        self.code = code
        self.connectors = connectors
        self.failure_reason = failure_reason


class _AddressResolver(Protocol):
    async def lookup_ip(self, host: str) -> list[str]:
        raise NotImplementedError


class _ResolvedAddress(NamedTuple):
    family: socket.AddressFamily
    host: str
    port: int


class _ConnectedStream(NamedTuple):
    reader: asyncio.StreamReader
    writer: asyncio.StreamWriter
    socket: socket.socket


@dataclass
class _FirewallAuthFetchProgress:
    phase: FirewallAuthFetchPhase = FirewallAuthFetchPhase.DNS


@dataclass(frozen=True)
class _ConnectionPlan:
    origin_scheme: str
    origin_host: str
    origin_port: int
    origin_authority: str
    connect_host: str
    connect_port: int
    request_target: str
    use_proxy_tunnel: bool = False
    proxy_authorization: str | None = field(default=None, repr=False)


@dataclass(frozen=True)
class _HttpResponse:
    status: int
    reason: str
    headers: Message
    body: bytes


@dataclass(frozen=True)
class FirewallAuthRequest:
    """Inputs sent to the runner firewall auth webhook."""

    encrypted_secrets: str = field(repr=False)
    auth_headers: dict
    sandbox_token: str = field(repr=False)
    auth_base: str | None = None
    auth_query: dict | None = None
    auth_aws_sigv4: dict | None = None
    secret_connector_map: dict | None = None
    secret_connector_metadata_map: dict | None = None
    vars_map: dict | None = None
    firewall_billable: bool = False
    matched_firewall: dict | None = None
    prepared_normal_body: bytes | None = field(default=None, repr=False, compare=False)

    def to_body(self, *, force_refresh: bool = False) -> dict:
        """Build the webhook JSON body while preserving omission semantics."""
        body: dict = {
            "encryptedSecrets": self.encrypted_secrets,
            "authHeaders": self.auth_headers,
        }
        if self.auth_base:
            body["authBase"] = self.auth_base
        if self.auth_query:
            body["authQuery"] = self.auth_query
        if self.auth_aws_sigv4:
            body["authAwsSigv4"] = self.auth_aws_sigv4
        if self.secret_connector_map:
            body["secretConnectorMap"] = self.secret_connector_map
        if self.secret_connector_metadata_map:
            body["secretConnectorMetadataMap"] = self.secret_connector_metadata_map
        if self.vars_map:
            body["vars"] = self.vars_map
        if self.firewall_billable:
            body["firewallBillable"] = True
        if self.matched_firewall is not None:
            body["matchedFirewall"] = self.matched_firewall
        if force_refresh:
            body["forceRefresh"] = True
        return body

    def to_bytes(self, *, force_refresh: bool = False) -> bytes:
        """Serialize the webhook body with stable content-derived bytes."""
        return json.dumps(
            self.to_body(force_refresh=force_refresh),
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")

    def with_prepared_normal_body(self, body: bytes) -> "FirewallAuthRequest":
        """Attach normal request bytes for the request-local fetch path."""
        return replace(self, prepared_normal_body=body)


@dataclass(frozen=True)
class FirewallAuthPayload:
    """Cacheable /firewall/auth data applied to outbound requests."""

    headers: dict[str, str]
    resolved_secrets: list[str] = field(default_factory=list)
    base: str | None = None
    query: dict[str, str] | None = None
    aws_sigv4: AwsSigV4Credentials | None = None


@dataclass(frozen=True)
class FirewallAuthSuccess:
    """Validated /firewall/auth success response consumed by the auth cache."""

    payload: FirewallAuthPayload
    expires_at: int | float | None = None
    refreshed_connectors: list[str] = field(default_factory=list)
    refreshed_secrets: list[str] = field(default_factory=list)


def reset_transport_state_for_tests() -> None:
    """Reset lazily created network state between event-loop tests."""
    global _dns_resolver
    global _https_context

    _dns_resolver = None
    _https_context = None


def _get_dns_resolver() -> _AddressResolver:
    global _dns_resolver

    resolver = _dns_resolver
    if resolver is None:
        resolver = mitmproxy_rs.dns.DnsResolver()
        _dns_resolver = resolver
    return resolver


def _get_https_context() -> ssl.SSLContext:
    global _https_context

    context = _https_context
    if context is None:
        context = ssl.create_default_context()
        context.set_alpn_protocols(["http/1.1"])
        _https_context = context
    return context


def _format_authority(host: str, port: int, *, include_port: bool) -> str:
    rendered_host = f"[{host}]" if ":" in host else host
    return f"{rendered_host}:{port}" if include_port else rendered_host


def _parsed_port(parsed: urllib.parse.SplitResult, default_port: int, *, subject: str) -> int:
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError(f"Invalid {subject} port") from exc
    return default_port if port is None else port


def _proxy_authorization(parsed: urllib.parse.SplitResult) -> str | None:
    if parsed.username is None:
        return None
    username = urllib.parse.unquote(parsed.username)
    password = urllib.parse.unquote(parsed.password or "")
    encoded = base64.b64encode(f"{username}:{password}".encode()).decode("ascii")
    return f"Basic {encoded}"


def _proxy_plan(
    *,
    scheme: str,
    origin_authority: str,
) -> tuple[str, int, str | None] | None:
    configured_proxy = urllib.request.getproxies().get(scheme)
    if not configured_proxy:
        return None
    normalized_proxy = platform_api.normalize_proxy_url(configured_proxy)
    if urllib.request.proxy_bypass(origin_authority):
        return None
    proxy_url = normalized_proxy if "://" in normalized_proxy else f"http://{normalized_proxy}"
    parsed = urllib.parse.urlsplit(proxy_url)
    if parsed.scheme.lower() != "http":
        raise ValueError("Firewall auth supports only HTTP environment proxies")
    if parsed.hostname is None:
        raise ValueError("Invalid firewall auth HTTP proxy URL")
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise ValueError("Invalid firewall auth HTTP proxy URL")
    return (
        parsed.hostname,
        _parsed_port(parsed, _DEFAULT_HTTP_PORT, subject="firewall auth HTTP proxy"),
        _proxy_authorization(parsed),
    )


def _build_connection_plan(req: urllib.request.Request) -> _ConnectionPlan:
    parsed = urllib.parse.urlsplit(req.full_url)
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"} or parsed.hostname is None:
        raise ValueError("Platform API URL must be an absolute http(s) URL")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("Platform API URL must not contain user information")

    default_port = _DEFAULT_HTTPS_PORT if scheme == "https" else _DEFAULT_HTTP_PORT
    origin_host = parsed.hostname
    origin_port = _parsed_port(parsed, default_port, subject="platform API")
    origin_authority = _format_authority(
        origin_host,
        origin_port,
        include_port=parsed.port is not None,
    )
    path = parsed.path or "/"
    origin_target = f"{path}?{parsed.query}" if parsed.query else path
    proxy = _proxy_plan(scheme=scheme, origin_authority=origin_authority)
    if proxy is None:
        return _ConnectionPlan(
            origin_scheme=scheme,
            origin_host=origin_host,
            origin_port=origin_port,
            origin_authority=origin_authority,
            connect_host=origin_host,
            connect_port=origin_port,
            request_target=origin_target,
        )

    proxy_host, proxy_port, proxy_authorization = proxy
    request_target = (
        urllib.parse.urlunsplit((scheme, origin_authority, path, parsed.query, ""))
        if scheme == "http"
        else origin_target
    )
    return _ConnectionPlan(
        origin_scheme=scheme,
        origin_host=origin_host,
        origin_port=origin_port,
        origin_authority=origin_authority,
        connect_host=proxy_host,
        connect_port=proxy_port,
        request_target=request_target,
        use_proxy_tunnel=scheme == "https",
        proxy_authorization=proxy_authorization,
    )


async def _resolve_addresses(host: str, port: int) -> tuple[_ResolvedAddress, ...]:
    try:
        literal_address = ipaddress.ip_address(host)
    except ValueError:
        resolved_hosts = await _get_dns_resolver().lookup_ip(host)
    else:
        resolved_hosts = [literal_address.compressed]

    addresses: list[_ResolvedAddress] = []
    seen: set[str] = set()
    for resolved_host in resolved_hosts:
        address = ipaddress.ip_address(resolved_host)
        normalized = address.compressed
        if normalized in seen:
            continue
        seen.add(normalized)
        family = socket.AF_INET6 if address.version == _IPV6_VERSION else socket.AF_INET
        addresses.append(_ResolvedAddress(family, normalized, port))
    if not addresses:
        raise socket.gaierror(socket.EAI_NONAME, "Firewall auth host did not resolve")
    return tuple(addresses)


def _abort_socket(sock: socket.socket) -> None:
    with suppress(OSError):
        sock.shutdown(socket.SHUT_RDWR)
    with suppress(OSError):
        sock.close()


async def _connect_socket(address: _ResolvedAddress) -> socket.socket:
    sock = socket.socket(address.family, socket.SOCK_STREAM)
    try:
        sock.setblocking(False)
        socket_address: tuple[str, int] | tuple[str, int, int, int]
        if address.family == socket.AF_INET6:
            socket_address = (address.host, address.port, 0, 0)
        else:
            socket_address = (address.host, address.port)
        await asyncio.get_running_loop().sock_connect(sock, socket_address)
        try:
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError as exc:
            if exc.errno != errno.ENOPROTOOPT:
                raise
    except BaseException:
        _abort_socket(sock)
        raise
    return sock


async def _abort_connection_attempts(
    attempts: tuple[asyncio.Task[socket.socket], ...],
) -> None:
    for attempt in attempts:
        attempt.cancel()
    await asyncio.gather(*attempts, return_exceptions=True)
    for attempt in attempts:
        if attempt.cancelled():
            continue
        if attempt.exception() is None:
            _abort_socket(attempt.result())


async def _open_connected_socket(
    addresses: tuple[_ResolvedAddress, ...],
) -> socket.socket:
    if not addresses:
        raise OSError("Firewall auth connection failed")

    loop = asyncio.get_running_loop()
    attempts: dict[asyncio.Task[socket.socket], int] = {}
    unclaimed_sockets: list[socket.socket] = []
    next_address_index = 0
    next_attempt_at = loop.time()
    last_error: tuple[int, OSError] | None = None

    def start_next_attempt() -> None:
        nonlocal next_address_index
        nonlocal next_attempt_at

        attempt = asyncio.create_task(_connect_socket(addresses[next_address_index]))
        attempts[attempt] = next_address_index
        next_address_index += 1
        next_attempt_at = loop.time() + _FIREWALL_AUTH_CONNECTION_ATTEMPT_DELAY_SECONDS

    start_next_attempt()
    try:
        while attempts:
            wait_timeout = (
                max(0.0, next_attempt_at - loop.time())
                if next_address_index < len(addresses)
                else None
            )
            done, _pending = await asyncio.wait(
                attempts,
                timeout=wait_timeout,
                return_when=asyncio.FIRST_COMPLETED,
            )

            successful_attempts: list[tuple[int, socket.socket]] = []
            for attempt in sorted(done, key=attempts.__getitem__):
                address_index = attempts.pop(attempt)
                try:
                    connected_socket = attempt.result()
                except OSError as exc:
                    if last_error is None or address_index > last_error[0]:
                        last_error = (address_index, exc)
                else:
                    unclaimed_sockets.append(connected_socket)
                    successful_attempts.append((address_index, connected_socket))

            if successful_attempts:
                winner_socket = successful_attempts[0][1]
                for connected_socket in unclaimed_sockets:
                    if connected_socket is not winner_socket:
                        _abort_socket(connected_socket)
                unclaimed_sockets[:] = [winner_socket]
                await _abort_connection_attempts(tuple(attempts))
                attempts.clear()
                unclaimed_sockets.clear()
                return winner_socket

            if not attempts:
                if next_address_index >= len(addresses):
                    break
                start_next_attempt()
                continue

            if next_address_index < len(addresses) and loop.time() >= next_attempt_at:
                if len(attempts) >= _MAX_CONCURRENT_FIREWALL_AUTH_CONNECTION_ATTEMPTS:
                    oldest_attempt = min(attempts, key=attempts.__getitem__)
                    attempts.pop(oldest_attempt)
                    await _abort_connection_attempts((oldest_attempt,))
                start_next_attempt()
    finally:
        for connected_socket in unclaimed_sockets:
            _abort_socket(connected_socket)
        if attempts:
            await _abort_connection_attempts(tuple(attempts))

    if last_error is None:
        raise OSError("Firewall auth connection failed")
    raise last_error[1]


def _abort_stream(stream: _ConnectedStream) -> None:
    try:
        stream.writer.transport.abort()
    finally:
        _abort_socket(stream.socket)


async def _read_proxy_connect_status(sock: socket.socket) -> tuple[int, bool]:
    loop = asyncio.get_running_loop()
    buffer = bytearray()
    header_terminator = b"\r\n\r\n"
    search_start = 0
    total_header_bytes = 0
    while True:
        header_end = buffer.find(header_terminator, search_start)
        if header_end < 0:
            remaining_bytes = _MAX_FIREWALL_AUTH_RESPONSE_HEADER_BYTES - total_header_bytes
            if len(buffer) > remaining_bytes:
                raise ValueError("Firewall auth HTTP proxy response headers too large")
            previous_buffer_end = len(buffer)
            chunk = await loop.sock_recv(sock, remaining_bytes + 1 - len(buffer))
            if not chunk:
                raise asyncio.IncompleteReadError(bytes(buffer), None)
            buffer.extend(chunk)
            # A terminator crossing this read can start only in the last three old bytes.
            search_start = max(
                0,
                previous_buffer_end - len(header_terminator) + 1,
            )
            continue

        header_end += len(header_terminator)
        header_block = bytes(buffer[:header_end])
        del buffer[:header_end]
        search_start = 0
        total_header_bytes += len(header_block)
        if total_header_bytes > _MAX_FIREWALL_AUTH_RESPONSE_HEADER_BYTES:
            raise ValueError("Firewall auth HTTP proxy response headers too large")
        status_line = header_block.split(b"\r\n", 1)[0]
        parts = status_line.split(b" ", 2)
        if len(parts) < _HTTP_STATUS_LINE_MIN_PARTS or not parts[0].startswith(b"HTTP/"):
            raise ValueError("Invalid firewall auth HTTP proxy response")
        try:
            status = int(parts[1])
        except ValueError as exc:
            raise ValueError("Invalid firewall auth HTTP proxy response") from exc
        if not _HTTP_STATUS_INFORMATIONAL_MIN <= status < _HTTP_STATUS_SUCCESS_MIN:
            return status, bool(buffer)


async def _establish_proxy_tunnel(
    sock: socket.socket,
    plan: _ConnectionPlan,
) -> None:
    connect_authority = _format_authority(plan.origin_host, plan.origin_port, include_port=True)
    lines = [
        f"CONNECT {connect_authority} HTTP/1.1",
        f"Host: {connect_authority}",
    ]
    if plan.proxy_authorization is not None:
        lines.append(f"Proxy-Authorization: {plan.proxy_authorization}")
    loop = asyncio.get_running_loop()
    await loop.sock_sendall(sock, ("\r\n".join(lines) + "\r\n\r\n").encode("latin-1"))
    status, has_trailing_data = await _read_proxy_connect_status(sock)
    if not _HTTP_STATUS_SUCCESS_MIN <= status < _HTTP_STATUS_REDIRECTION_MIN:
        raise OSError(f"Firewall auth HTTP proxy CONNECT failed with status {status}")
    if has_trailing_data:
        raise ValueError("Firewall auth HTTP proxy sent data before TLS")


async def _open_stream(
    plan: _ConnectionPlan,
    progress: _FirewallAuthFetchProgress,
) -> _ConnectedStream:
    progress.phase = FirewallAuthFetchPhase.DNS
    addresses = await _resolve_addresses(plan.connect_host, plan.connect_port)
    progress.phase = FirewallAuthFetchPhase.CONNECT
    sock = await _open_connected_socket(addresses)
    try:
        if plan.use_proxy_tunnel:
            progress.phase = FirewallAuthFetchPhase.PROXY_CONNECT
            await _establish_proxy_tunnel(sock, plan)
        if plan.origin_scheme == "https":
            progress.phase = FirewallAuthFetchPhase.TLS
            reader, writer = await asyncio.open_connection(
                sock=sock,
                limit=_MAX_FIREWALL_AUTH_RESPONSE_HEADER_BYTES,
                ssl=_get_https_context(),
                server_hostname=plan.origin_host,
            )
        else:
            reader, writer = await asyncio.open_connection(
                sock=sock,
                limit=_MAX_FIREWALL_AUTH_RESPONSE_HEADER_BYTES,
            )
    except BaseException:
        _abort_socket(sock)
        raise
    return _ConnectedStream(reader, writer, sock)


def _request_headers(
    req: urllib.request.Request,
    plan: _ConnectionPlan,
    body: bytes,
) -> list[tuple[bytes, bytes]]:
    excluded_headers = {"connection", "content-length", "host", "proxy-authorization"}
    headers = [
        (name.encode("ascii"), value.encode("latin-1"))
        for name, value in req.header_items()
        if name.lower() not in excluded_headers
    ]
    headers.extend(
        (
            (b"Host", plan.origin_authority.encode("ascii")),
            (b"Content-Length", str(len(body)).encode("ascii")),
            (b"Connection", b"close"),
        )
    )
    if plan.proxy_authorization is not None and not plan.use_proxy_tunnel:
        headers.append((b"Proxy-Authorization", plan.proxy_authorization.encode("latin-1")))
    return headers


def _response_headers(event: h11.Response | h11.InformationalResponse) -> Message:
    headers = Message()
    for name, value in event.headers:
        headers.add_header(name.decode("ascii"), value.decode("latin-1"))
    return headers


async def _read_http_response(
    reader: asyncio.StreamReader,
    connection: h11.Connection,
    progress: _FirewallAuthFetchProgress,
) -> _HttpResponse:
    response_event: h11.Response | h11.InformationalResponse | None = None
    body = bytearray()
    progress.phase = FirewallAuthFetchPhase.RESPONSE_HEADERS
    while True:
        event = connection.next_event()
        if event is h11.NEED_DATA:
            connection.receive_data(await reader.read(64 * 1024))
            continue
        if event is h11.PAUSED:
            raise h11.RemoteProtocolError("Unexpected HTTP protocol switch")
        if isinstance(event, h11.InformationalResponse):
            if event.status_code == _HTTP_STATUS_SWITCHING_PROTOCOLS:
                return _HttpResponse(
                    event.status_code,
                    event.reason.decode("latin-1"),
                    _response_headers(event),
                    b"",
                )
            continue
        if isinstance(event, h11.Response):
            response_event = event
            progress.phase = FirewallAuthFetchPhase.RESPONSE_BODY
            continue
        if isinstance(event, h11.Data):
            if response_event is None:
                raise h11.RemoteProtocolError("Received HTTP response body before headers")
            if len(body) + len(event.data) > MAX_FIREWALL_AUTH_RESPONSE_BODY_BYTES:
                raise FirewallAuthResponseTooLargeError("Firewall auth response body too large")
            body.extend(event.data)
            continue
        if isinstance(event, h11.EndOfMessage):
            if response_event is None:
                raise h11.RemoteProtocolError("Received HTTP response without headers")
            return _HttpResponse(
                response_event.status_code,
                response_event.reason.decode("latin-1"),
                _response_headers(response_event),
                bytes(body),
            )
        if isinstance(event, h11.ConnectionClosed):
            raise h11.RemoteProtocolError("HTTP connection closed before response completed")
        raise h11.RemoteProtocolError("Unexpected HTTP response event")


async def _perform_http_request(
    req: urllib.request.Request,
    plan: _ConnectionPlan,
    body: bytes,
    progress: _FirewallAuthFetchProgress,
) -> _HttpResponse:
    stream = await _open_stream(plan, progress)
    connection = h11.Connection(
        h11.CLIENT,
        max_incomplete_event_size=_MAX_FIREWALL_AUTH_RESPONSE_HEADER_BYTES,
    )
    try:
        progress.phase = FirewallAuthFetchPhase.REQUEST_WRITE
        stream.writer.write(
            connection.send(
                h11.Request(
                    method=req.get_method(),
                    target=plan.request_target,
                    headers=_request_headers(req, plan, body),
                )
            )
        )
        stream.writer.write(connection.send(h11.Data(data=body)))
        stream.writer.write(connection.send(h11.EndOfMessage()))
        await stream.writer.drain()
        response = await _read_http_response(stream.reader, connection, progress)
        stream.writer.close()
        with suppress(OSError):
            await stream.writer.wait_closed()
        stream.socket.close()
        return response
    except BaseException:
        _abort_stream(stream)
        raise


def _firewall_auth_api_error_from_envelope(
    status: int,
    error_info: dict,
) -> FirewallAuthApiError | None:
    code = error_info.get("code")
    message = error_info.get("message")
    if not isinstance(code, str) or not isinstance(message, str):
        return None
    if code not in _STRUCTURED_FIREWALL_AUTH_ERROR_CODES:
        return None
    connectors = error_info.get("connectors")
    if isinstance(connectors, list) and all(isinstance(item, str) for item in connectors):
        parsed_connectors = connectors
    else:
        parsed_connectors = None
    failure_reason = error_info.get("failureReason")
    parsed_failure_reason = (
        failure_reason
        if isinstance(failure_reason, str) and failure_reason in _FIREWALL_AUTH_FAILURE_REASONS
        else None
    )
    return FirewallAuthApiError(
        status=status,
        code=code,
        message=message,
        connectors=parsed_connectors,
        failure_reason=parsed_failure_reason,
    )


_MALFORMED_FIREWALL_AUTH_SUCCESS = "Firewall auth endpoint returned malformed success response"


def _malformed_firewall_auth_success(message: str) -> ValueError:
    return ValueError(f"{_MALFORMED_FIREWALL_AUTH_SUCCESS}: {message}")


def _parse_string_map(value: object, field_name: str) -> dict[str, str]:
    if not isinstance(value, dict):
        raise _malformed_firewall_auth_success(f"{field_name} must be an object")

    parsed: dict[str, str] = {}
    for key, item in value.items():
        if not isinstance(key, str):
            raise _malformed_firewall_auth_success(f"{field_name} keys must be strings")
        if not isinstance(item, str):
            raise _malformed_firewall_auth_success(f"{field_name} values must be strings")
        parsed[key] = item
    return parsed


def _parse_optional_string_map(
    decoded: dict[object, object], field_name: str
) -> dict[str, str] | None:
    value = decoded.get(field_name)
    if value is None:
        return None
    return _parse_string_map(value, field_name)


def _parse_optional_string(decoded: dict[object, object], field_name: str) -> str | None:
    value = decoded.get(field_name)
    if value is None:
        return None
    if not isinstance(value, str):
        raise _malformed_firewall_auth_success(f"{field_name} must be a string")
    if value == "":
        raise _malformed_firewall_auth_success(f"{field_name} must not be empty")
    return value


def _parse_required_string_list(decoded: dict[object, object], field_name: str) -> list[str]:
    if field_name not in decoded:
        raise _malformed_firewall_auth_success(f"{field_name} is required")
    value = decoded[field_name]
    if not isinstance(value, list):
        raise _malformed_firewall_auth_success(f"{field_name} must be an array")
    if not all(isinstance(item, str) for item in value):
        raise _malformed_firewall_auth_success(f"{field_name} values must be strings")
    return list(value)


def is_supported_expiry(value: object) -> TypeGuard[int | float]:
    """Return whether an expiry is a finite number supported by the runtime."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _parse_expires_at(decoded: dict[object, object]) -> int | float | None:
    if "expiresAt" not in decoded:
        raise _malformed_firewall_auth_success("expiresAt is required")
    value = decoded["expiresAt"]
    if value is None:
        return None
    if not is_supported_expiry(value):
        raise _malformed_firewall_auth_success("expiresAt must be a finite number or null")
    return value


def _parse_optional_aws_sigv4_credentials(
    decoded: dict[object, object],
) -> AwsSigV4Credentials | None:
    if "awsSigv4" not in decoded:
        return None
    value = decoded["awsSigv4"]
    if not isinstance(value, dict):
        raise _malformed_firewall_auth_success("awsSigv4 must be an object")
    access_key_id = value.get("accessKeyId")
    secret_access_key = value.get("secretAccessKey")
    if not isinstance(access_key_id, str) or not access_key_id:
        raise _malformed_firewall_auth_success("awsSigv4.accessKeyId is required")
    if not isinstance(secret_access_key, str) or not secret_access_key:
        raise _malformed_firewall_auth_success("awsSigv4.secretAccessKey is required")
    if "sessionToken" in value and value["sessionToken"] is None:
        raise _malformed_firewall_auth_success("sessionToken must be a string")
    return AwsSigV4Credentials(
        access_key_id=access_key_id,
        secret_access_key=secret_access_key,
        session_token=_parse_optional_string(value, "sessionToken"),
    )


def _parse_firewall_auth_success(
    decoded: object,
    request: FirewallAuthRequest,
) -> FirewallAuthSuccess:
    if not isinstance(decoded, dict):
        raise _malformed_firewall_auth_success("response must be an object")

    decoded_map: dict[object, object] = decoded
    if "headers" not in decoded_map:
        raise _malformed_firewall_auth_success("headers is required")

    headers = _parse_string_map(decoded_map["headers"], "headers")
    expires_at = _parse_expires_at(decoded_map)
    resolved_secrets = _parse_required_string_list(decoded_map, "resolvedSecrets")
    refreshed_connectors = _parse_required_string_list(decoded_map, "refreshedConnectors")
    refreshed_secrets = _parse_required_string_list(decoded_map, "refreshedSecrets")
    base = _parse_optional_string(decoded_map, "base")
    query = _parse_optional_string_map(decoded_map, "query")
    aws_sigv4 = _parse_optional_aws_sigv4_credentials(decoded_map)

    if set(headers) != set(request.auth_headers):
        raise _malformed_firewall_auth_success(
            "headers must match the configured auth header names"
        )
    if set(query or {}) != set(request.auth_query or {}):
        raise _malformed_firewall_auth_success("query must match the configured auth query names")
    if (base is not None) != (request.auth_base is not None):
        raise _malformed_firewall_auth_success("base presence must match the configured auth base")
    if (aws_sigv4 is not None) != (request.auth_aws_sigv4 is not None):
        raise _malformed_firewall_auth_success(
            "awsSigv4 presence must match the configured auth mode"
        )
    request_session_token_present = (
        request.auth_aws_sigv4 is not None
        and request.auth_aws_sigv4.get("sessionToken") is not None
    )
    response_session_token_present = aws_sigv4 is not None and aws_sigv4.session_token is not None
    if response_session_token_present != request_session_token_present:
        raise _malformed_firewall_auth_success(
            "awsSigv4.sessionToken presence must match the configured auth mode"
        )

    payload = FirewallAuthPayload(
        headers=headers,
        resolved_secrets=resolved_secrets,
        base=base,
        query=query,
        aws_sigv4=aws_sigv4,
    )
    return FirewallAuthSuccess(
        payload=payload,
        expires_at=expires_at,
        refreshed_connectors=refreshed_connectors,
        refreshed_secrets=refreshed_secrets,
    )


def _raise_firewall_auth_http_error(response: _HttpResponse, url: str) -> None:
    """Raise the mapped runner exception for a non-success auth response.

    ``CONNECTOR_NOT_CONFIGURED`` and ``INSUFFICIENT_CREDITS`` map to their
    specialized exceptions. Recognized general codes map to
    ``FirewallAuthApiError``. Responses that match neither path, including
    envelopes without a usable code and otherwise unknown codes, retain the
    original ``urllib.error.HTTPError``.

    Preserving a new endpoint error requires an intentional specialized branch
    or ``_STRUCTURED_FIREWALL_AUTH_ERROR_CODES`` update plus focused client and
    handling tests. Propagating a new ``failureReason`` also requires updating
    ``_FIREWALL_AUTH_FAILURE_REASONS`` and those tests.
    """
    error = urllib.error.HTTPError(
        url,
        response.status,
        response.reason,
        response.headers,
        io.BytesIO(response.body),
    )
    try:
        error_body: object = json.loads(response.body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise error from None
    if not isinstance(error_body, dict):
        raise error from None
    error_info = error_body.get("error")
    if not isinstance(error_info, dict):
        raise error from None
    error_message = error_info.get("message")
    if error_info.get("code") == "CONNECTOR_NOT_CONFIGURED":
        raise ConnectorNotConfiguredError(
            error_message if isinstance(error_message, str) else "Connector not configured",
        ) from None
    if error_info.get("code") == "INSUFFICIENT_CREDITS":
        raise InsufficientCreditsError(
            error_message if isinstance(error_message, str) else "Insufficient credits",
        ) from None
    api_error = _firewall_auth_api_error_from_envelope(response.status, error_info)
    if api_error is None:
        raise error from None
    raise api_error from None


async def fetch_firewall_headers(
    request: FirewallAuthRequest,
    *,
    force_refresh: bool = False,
) -> FirewallAuthSuccess:
    """Resolve auth headers via server-side decryption.

    request.encrypted_secrets is the encrypted runtime secret namespace. After API-side
    decryption, keys are the `NAME` in `${{ secrets.NAME }}` and values are the
    real secret values.

    request.secret_connector_map maps firewall auth secret env aliases (the
    `NAME` in `${{ secrets.NAME }}`) to the connector or provider owner that
    can refresh/resolve access. request.secret_connector_metadata_map uses the
    same keys to add source details when the owner alone is not enough to
    locate access storage.

    When request.secret_connector_map is provided, the auth endpoint can refresh
    expired access tokens and returns an expiresAt timestamp for TTL caching.
    For billable firewall auth, expiresAt is also bounded by the server-side
    credit authorization lease.

    When force_refresh is True, the endpoint refreshes access tokens regardless
    of DB tokenExpiresAt — used after the upstream returns 401 (#9860).

    One monotonic deadline covers cancellable DNS, connect, TLS, request write,
    response headers, and the bounded response body.
    """
    api_url = platform_api.get_api_url()
    url = f"{api_url}/api/webhooks/agent/firewall/auth"
    body = (
        request.prepared_normal_body
        if not force_refresh and request.prepared_normal_body is not None
        else request.to_bytes(force_refresh=force_refresh)
    )
    req = platform_api.make_api_request(url, body, request.sandbox_token)
    plan = _build_connection_plan(req)
    progress = _FirewallAuthFetchProgress()
    timeout = asyncio.timeout(FIREWALL_AUTH_FETCH_DEADLINE_SECONDS)
    try:
        async with timeout:
            response = await _perform_http_request(req, plan, body, progress)
    except TimeoutError:
        if timeout.expired():
            raise FirewallAuthDeadlineExceededError(progress.phase) from None
        raise
    except h11.ProtocolError:
        raise ValueError("Firewall auth HTTP protocol error") from None

    if not _HTTP_STATUS_SUCCESS_MIN <= response.status < _HTTP_STATUS_REDIRECTION_MIN:
        _raise_firewall_auth_http_error(response, url)
    decoded: object = json.loads(response.body)
    return _parse_firewall_auth_success(decoded, request)
