"""Bounded HTTP transport shared by host-side platform API callers.

Callers build their own requests and interpret the returned status and body.
Platform authorization stays at the origin and proxy authorization stays at
the proxy boundary.

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
bypass rules. HTTP proxy endpoints accept ``http://host:port``, ``host:port``, and ``//host:port``
forms; an HTTPS or other proxy endpoint is rejected. CONNECT targets always include the effective
origin port, even when the platform URL omits it.
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
CONNECT and TLS, request writing, and response parsing. Complete persistent responses return their
connection to a bounded idle pool. A reset retires that pool for future requests; active exchanges
retain their connections until completion. Exceptions and cancellation discard the owned stream.
Pool retirement does not replay an ambiguous request or extend its deadline.

Proxy CONNECT response headers and h11 incomplete events are bounded at 64 KiB. The origin response
body is bounded at ``MAX_RESPONSE_BODY_BYTES`` (256 KiB). One monotonic
``REQUEST_DEADLINE_SECONDS`` deadline (10 seconds by default) covers DNS, connection
racing, proxy CONNECT, TLS, request writing, response headers, and the bounded response body.
The caller can read the active phase from ``RequestProgress`` when handling a deadline.
"""

import asyncio
import base64
import errno
import io
import ipaddress
import socket
import ssl
import urllib.error
import urllib.parse
import urllib.request
from contextlib import suppress
from dataclasses import dataclass, field, replace
from email.message import Message
from enum import StrEnum
from typing import NamedTuple, Protocol

import h11
import mitmproxy_rs

import platform_api
import platform_http_pool

MAX_RESPONSE_BODY_BYTES = 256 * 1024
REQUEST_DEADLINE_SECONDS = 10.0
_MAX_RESPONSE_HEADER_BYTES = 64 * 1024
# RFC 8305's default cadence; four slots keep the oldest path eligible for about one second.
_CONNECTION_ATTEMPT_DELAY_SECONDS = 0.25
_MAX_CONCURRENT_CONNECTION_ATTEMPTS = 4
_DEFAULT_HTTP_PORT = 80
_DEFAULT_HTTPS_PORT = 443
_IPV6_VERSION = 6
_HTTP_STATUS_LINE_MIN_PARTS = 2
_HTTP_STATUS_INFORMATIONAL_MIN = 100
_HTTP_STATUS_SUCCESS_MIN = 200
_HTTP_STATUS_REDIRECTION_MIN = 300
_HTTP_STATUS_SWITCHING_PROTOCOLS = 101
_dns_resolver: _AddressResolver | None = None
_https_context: ssl.SSLContext | None = None
_connection_pools: platform_http_pool.ConnectionPools | None = None
_transport_closed = False


class ResponseTooLargeError(Exception):
    """Raised when the platform returns a response body above the local cap."""


class RequestPhase(StrEnum):
    """Bounded transport phase active when a platform request deadline expires."""

    DNS = "dns"
    CONNECT = "connect"
    PROXY_CONNECT = "proxy_connect"
    TLS = "tls"
    REQUEST_WRITE = "request_write"
    RESPONSE_HEADERS = "response_headers"
    RESPONSE_BODY = "response_body"


class _AddressResolver(Protocol):
    async def lookup_ip(self, host: str) -> list[str]:
        raise NotImplementedError


class _ResolvedAddress(NamedTuple):
    family: socket.AddressFamily
    host: str
    port: int


@dataclass
class RequestProgress:
    phase: RequestPhase = RequestPhase.DNS


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
class HttpResponse:
    status: int
    reason: str
    headers: Message
    body: bytes

    @property
    def ok(self) -> bool:
        return _HTTP_STATUS_SUCCESS_MIN <= self.status < _HTTP_STATUS_REDIRECTION_MIN

    def as_http_error(self, url: str) -> urllib.error.HTTPError:
        return urllib.error.HTTPError(
            url, self.status, self.reason, self.headers, io.BytesIO(self.body)
        )


def reset_transport_state_for_tests() -> None:
    """Reset lazily created network state between event-loop tests."""
    global _dns_resolver
    global _https_context
    global _connection_pools
    global _transport_closed

    close_transport()
    _dns_resolver = None
    _https_context = None
    _connection_pools = None
    _transport_closed = False


def close_transport() -> None:
    """Fence new dispatch and close idle sockets without aborting active exchanges."""
    global _transport_closed
    _transport_closed = True
    if _connection_pools is not None:
        _connection_pools.close()


def _get_connection_pools() -> platform_http_pool.ConnectionPools:
    global _connection_pools
    if _transport_closed:
        raise RuntimeError("Platform HTTP transport is closed")
    if _connection_pools is None:
        _connection_pools = platform_http_pool.ConnectionPools()
    return _connection_pools


def _get_dns_resolver() -> _AddressResolver:
    global _dns_resolver

    if _dns_resolver is None:
        _dns_resolver = mitmproxy_rs.dns.DnsResolver()
    return _dns_resolver


def _get_https_context() -> ssl.SSLContext:
    global _https_context

    if _https_context is None:
        context = ssl.create_default_context()
        context.set_alpn_protocols(["http/1.1"])
        _https_context = context
    return _https_context


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
    proxy_url = normalized_proxy
    if normalized_proxy.startswith("//"):
        proxy_url = f"http:{normalized_proxy}"
    elif "://" not in normalized_proxy:
        proxy_url = f"http://{normalized_proxy}"
    parsed = urllib.parse.urlsplit(proxy_url)
    if parsed.scheme.lower() != "http":
        raise ValueError("Platform HTTP supports only HTTP environment proxies")
    if parsed.hostname is None:
        raise ValueError("Invalid platform HTTP proxy URL")
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise ValueError("Invalid platform HTTP proxy URL")
    return (
        parsed.hostname,
        _parsed_port(parsed, _DEFAULT_HTTP_PORT, subject="platform HTTP proxy"),
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
        raise socket.gaierror(socket.EAI_NONAME, "Platform HTTP host did not resolve")
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
        raise OSError("Platform HTTP connection failed")

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
        next_attempt_at = loop.time() + _CONNECTION_ATTEMPT_DELAY_SECONDS

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

            for attempt in sorted(done, key=attempts.__getitem__):
                address_index = attempts.pop(attempt)
                try:
                    connected_socket = attempt.result()
                except OSError as exc:
                    if last_error is None or address_index > last_error[0]:
                        last_error = (address_index, exc)
                else:
                    unclaimed_sockets.append(connected_socket)

            if unclaimed_sockets:
                winner_socket = unclaimed_sockets[0]
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
                if len(attempts) >= _MAX_CONCURRENT_CONNECTION_ATTEMPTS:
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
        raise OSError("Platform HTTP connection failed")
    raise last_error[1]


async def _read_proxy_connect_status(sock: socket.socket) -> tuple[int, bool]:
    loop = asyncio.get_running_loop()
    buffer = bytearray()
    header_terminator = b"\r\n\r\n"
    search_start = 0
    total_header_bytes = 0
    while True:
        header_end = buffer.find(header_terminator, search_start)
        if header_end < 0:
            remaining_bytes = _MAX_RESPONSE_HEADER_BYTES - total_header_bytes
            if len(buffer) > remaining_bytes:
                raise ValueError("Platform HTTP proxy response headers too large")
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
        if total_header_bytes > _MAX_RESPONSE_HEADER_BYTES:
            raise ValueError("Platform HTTP proxy response headers too large")
        status_line = header_block.split(b"\r\n", 1)[0]
        parts = status_line.split(b" ", 2)
        if len(parts) < _HTTP_STATUS_LINE_MIN_PARTS or not parts[0].startswith(b"HTTP/"):
            raise ValueError("Invalid platform HTTP proxy response")
        try:
            status = int(parts[1])
        except ValueError as exc:
            raise ValueError("Invalid platform HTTP proxy response") from exc
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
        raise OSError(f"Platform HTTP proxy CONNECT failed with status {status}")
    if has_trailing_data:
        raise ValueError("Platform HTTP proxy sent data before TLS")


async def _open_stream(
    plan: _ConnectionPlan,
    progress: RequestProgress,
    tls_context: ssl.SSLContext | None,
) -> platform_http_pool.ConnectedStream:
    progress.phase = RequestPhase.DNS
    addresses = await _resolve_addresses(plan.connect_host, plan.connect_port)
    progress.phase = RequestPhase.CONNECT
    sock = await _open_connected_socket(addresses)
    try:
        if plan.use_proxy_tunnel:
            progress.phase = RequestPhase.PROXY_CONNECT
            await _establish_proxy_tunnel(sock, plan)
        if plan.origin_scheme == "https":
            progress.phase = RequestPhase.TLS
            reader, writer = await asyncio.open_connection(
                sock=sock,
                limit=_MAX_RESPONSE_HEADER_BYTES,
                ssl=tls_context,
                server_hostname=plan.origin_host,
            )
        else:
            reader, writer = await asyncio.open_connection(
                sock=sock,
                limit=_MAX_RESPONSE_HEADER_BYTES,
            )
    except BaseException:
        _abort_socket(sock)
        raise
    return platform_http_pool.ConnectedStream(reader, writer, sock)


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
    transport: platform_http_pool.HttpConnection,
    progress: RequestProgress,
) -> HttpResponse:
    connection = transport.protocol
    response_event: h11.Response | h11.InformationalResponse | None = None
    body = bytearray()
    progress.phase = RequestPhase.RESPONSE_HEADERS
    while True:
        event = connection.next_event()
        if event is h11.NEED_DATA:
            connection.receive_data(await transport.read(64 * 1024))
            continue
        if event is h11.PAUSED:
            raise h11.RemoteProtocolError("Unexpected HTTP protocol switch")
        if isinstance(event, h11.InformationalResponse):
            if event.status_code == _HTTP_STATUS_SWITCHING_PROTOCOLS:
                return HttpResponse(
                    event.status_code,
                    event.reason.decode("latin-1"),
                    _response_headers(event),
                    b"",
                )
            continue
        if isinstance(event, h11.Response):
            response_event = event
            progress.phase = RequestPhase.RESPONSE_BODY
            continue
        if isinstance(event, h11.Data):
            if response_event is None:
                raise h11.RemoteProtocolError("Received HTTP response body before headers")
            if len(body) + len(event.data) > MAX_RESPONSE_BODY_BYTES:
                raise ResponseTooLargeError("Platform HTTP response body too large")
            body.extend(event.data)
            continue
        if isinstance(event, h11.EndOfMessage):
            if response_event is None:
                raise h11.RemoteProtocolError("Received HTTP response without headers")
            return HttpResponse(
                response_event.status_code,
                response_event.reason.decode("latin-1"),
                _response_headers(response_event),
                bytes(body),
            )
        if isinstance(event, h11.ConnectionClosed):
            raise h11.RemoteProtocolError("HTTP connection closed before response completed")
        raise h11.RemoteProtocolError("Unexpected HTTP response event")


async def send(
    req: urllib.request.Request,
    body: bytes,
    progress: RequestProgress,
) -> HttpResponse:
    """Exchange one request within the caller's deadline without replaying it."""
    plan = _build_connection_plan(req)
    pools = _get_connection_pools()
    # Paths and application auth are request-local. Proxy credentials and TLS
    # trust belong to connection identity and must never cross pooled routes.
    tls_context = _get_https_context() if plan.origin_scheme == "https" else None
    key = (replace(plan, request_target=""), tls_context)
    while True:
        generation = pools.acquire_generation()
        pooled = await generation.take(key)
        if not generation.retired:
            break
        if pooled is not None:
            pooled.close(generation.loop)
    try:
        if pooled is None:
            stream = await _open_stream(plan, progress, tls_context)
            pooled = platform_http_pool.HttpConnection(
                stream,
                h11.Connection(
                    h11.CLIENT,
                    max_incomplete_event_size=_MAX_RESPONSE_HEADER_BYTES,
                ),
            )
        stream, connection = pooled.stream, pooled.protocol
        progress.phase = RequestPhase.REQUEST_WRITE
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
        response = await _read_http_response(pooled, progress)
        if not generation.release(key, pooled):
            stream.writer.close()
            with suppress(OSError):
                await stream.writer.wait_closed()
            stream.socket.close()
        return response
    except BaseException as exc:
        if platform_http_pool.is_connection_reset(exc):
            pools.retire(generation)
        if pooled is not None:
            pooled.close(generation.loop)
        raise
