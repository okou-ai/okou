"""Request preparation and HTTPS transport for auth.base URL rewrites.

The addon forwards auth.base requests itself because mitmproxy's eager
connection has already connected to the placeholder IP. This module owns
the low-level HTTP and destination-validation details for that forward path.
"""

import asyncio
import errno
import http.client as http_client
import ipaddress
import socket
import ssl
import threading
import time
import urllib.parse
from collections.abc import Callable
from contextlib import suppress
from typing import NamedTuple, Protocol

import mitmproxy_rs
from mitmproxy import http

import public_destination
from authority_utils import (
    IPV6_VERSION,
    authority_has_empty_port,
    format_url_host,
    percent_decode_host,
    raw_authority_host,
)
from host_normalization import normalize_idna_hostname
from http_header_syntax import has_forbidden_header_value_control, is_http_header_name
from runtime_url_parsing import split_runtime_url

HOP_BY_HOP: frozenset[str] = frozenset(
    (
        "connection",
        "keep-alive",
        "proxy-connection",
        "proxy-authenticate",
        "proxy-authorization",
        "transfer-encoding",
        "te",
        "trailer",
        "upgrade",
    )
)
DEFAULT_HTTPS_PORT = 443
MAX_AUTH_BASE_REQUEST_BODY_BYTES = 32 * 1024 * 1024
MAX_AUTH_BASE_RESPONSE_BODY_BYTES = 32 * 1024 * 1024
_PERCENT_DECODED_UPSTREAM_HOST_SYNTAX_CHARS = frozenset("{}*.\u3002\uff0e\uff61,")
_UPSTREAM_HOST_FORBIDDEN_CHARS = frozenset("{}*")
_https_context: ssl.SSLContext | None = None
_https_context_lock = threading.Lock()
_dns_resolver: "_AddressResolver | None" = None


class _AddressResolver(Protocol):
    async def lookup_ip(self, host: str) -> list[str]:
        raise NotImplementedError


class ForwardRequestAbort(Protocol):
    """Cancellation and socket ownership consumed by auth.base transport."""

    def register_async_cancel(self, cancel: Callable[[], object]) -> None:
        raise NotImplementedError

    def clear_async_cancel(self, cancel: Callable[[], object]) -> None:
        raise NotImplementedError

    def register_socket(self, sock: socket.socket) -> None:
        raise NotImplementedError

    def replace_socket(self, current: socket.socket, replacement: socket.socket) -> None:
        raise NotImplementedError

    def clear_socket(self, sock: socket.socket) -> None:
        raise NotImplementedError

    def raise_if_aborted(self) -> None:
        raise NotImplementedError


class ForwardedResponseTooLargeError(Exception):
    """Raised when an auth.base upstream response exceeds the local body cap."""


class ForwardedRequestTooLargeError(Exception):
    """Raised when an auth.base forwarded request body exceeds the local cap."""


class AuthBaseForwardingDeadlineExceededError(Exception):
    """Raised when one auth.base forwarding attempt exceeds its total lifetime."""


class UnsafeAuthBaseDestinationError(Exception):
    """Raised when an auth.base upstream destination is not public internet."""


class InvalidResolvedAuthHeaderError(Exception):
    """Raised when resolved auth data contains an invalid HTTP header."""


class InvalidAuthBaseRequestHeadersError(Exception):
    """Raised when client representation headers cannot be forwarded safely."""


class ValidatedAddress(NamedTuple):
    family: socket.AddressFamily
    host: str
    port: int


class PreparedForwardRequest(NamedTuple):
    host: str
    port: int | None
    target: str


type _SocketAddress = tuple[str, int] | tuple[str, int, int, int]


def reset_transport_state_for_tests() -> None:
    """Reset auth.base resolver and TLS caches between tests."""
    global _dns_resolver
    global _https_context

    with _https_context_lock:
        _https_context = None
    _dns_resolver = None


def _validated_socket_address(address: ValidatedAddress) -> _SocketAddress:
    if address.family == socket.AF_INET6:
        return address.host, address.port, 0, 0
    return address.host, address.port


def remaining_deadline_seconds(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise AuthBaseForwardingDeadlineExceededError("auth.base forwarding deadline exceeded")
    return remaining


def _create_https_context() -> ssl.SSLContext:
    context = ssl.create_default_context()
    context.set_alpn_protocols(["http/1.1"])
    if context.post_handshake_auth is not None:
        context.post_handshake_auth = True
    return context


def _get_https_context() -> ssl.SSLContext:
    global _https_context

    context = _https_context
    if context is not None:
        return context

    with _https_context_lock:
        context = _https_context
        if context is None:
            context = _create_https_context()
            _https_context = context
        return context


class _ValidatedTLSConnection(http_client.HTTPConnection):
    default_port = DEFAULT_HTTPS_PORT

    def __init__(
        self,
        host: str,
        port: int | None,
        *,
        deadline: float,
        abort_handle: ForwardRequestAbort,
        validated_addresses: tuple[ValidatedAddress, ...],
    ) -> None:
        super().__init__(
            host,
            port=port,
            timeout=remaining_deadline_seconds(deadline),
        )
        self._abort_handle = abort_handle
        self._abort_socket: socket.socket | None = None
        self._deadline = deadline
        self._validated_addresses = validated_addresses
        self._context = _get_https_context()

    def _close_and_clear_socket(self, sock: socket.socket) -> None:
        self._abort_handle.clear_socket(sock)
        if self._abort_socket is sock:
            self._abort_socket = None
        with suppress(Exception):
            sock.close()

    def _release_abort_socket(self) -> None:
        """Release abort ownership after response and connection cleanup."""
        sock = self._abort_socket
        self._abort_socket = None
        if sock is not None:
            self._abort_handle.clear_socket(sock)

    def _connect_raw_socket(self) -> socket.socket:
        last_error: OSError | None = None
        for address in self._validated_addresses:
            self._abort_handle.raise_if_aborted()
            try:
                raw_sock = socket.socket(address.family, socket.SOCK_STREAM)
            except OSError as exc:
                last_error = exc
                continue
            try:
                self._abort_handle.register_socket(raw_sock)
                self._abort_socket = raw_sock
                raw_sock.settimeout(remaining_deadline_seconds(self._deadline))
                raw_sock.connect(_validated_socket_address(address))
                self._abort_handle.raise_if_aborted()
            except OSError as exc:
                last_error = exc
                self._close_and_clear_socket(raw_sock)
                continue
            except Exception:
                self._close_and_clear_socket(raw_sock)
                raise
            return raw_sock
        if last_error is not None:
            raise last_error
        raise OSError("address resolver returned an empty list")

    def connect(self) -> None:
        raw_sock = self._connect_raw_socket()
        try:
            raw_sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError as exc:
            if exc.errno != errno.ENOPROTOOPT:
                self._close_and_clear_socket(raw_sock)
                raise
        try:
            wrapped_sock = self._context.wrap_socket(
                raw_sock,
                server_hostname=self.host,
                do_handshake_on_connect=False,
            )
            if wrapped_sock is not raw_sock:
                self._abort_handle.replace_socket(raw_sock, wrapped_sock)
                self._abort_socket = wrapped_sock
            self.sock = wrapped_sock
            self.set_remaining_timeout()
            wrapped_sock.do_handshake()
        except Exception:
            current_sock = self.sock
            self.sock = None
            self._close_and_clear_socket(current_sock if current_sock is not None else raw_sock)
            raise

    def set_remaining_timeout(self) -> None:
        self._abort_handle.raise_if_aborted()
        if self.sock is not None:
            self.sock.settimeout(remaining_deadline_seconds(self._deadline))


def _make_validated_https_connection(
    host: str,
    port: int | None,
    *,
    deadline: float,
    abort_handle: ForwardRequestAbort,
    validated_addresses: tuple[ValidatedAddress, ...],
) -> _ValidatedTLSConnection:
    return _ValidatedTLSConnection(
        host,
        port=port,
        deadline=deadline,
        abort_handle=abort_handle,
        validated_addresses=validated_addresses,
    )


def header_pairs(headers) -> list[tuple[str, str]]:
    """Normalize a supported header container into ordered header pairs.

    Plain dict inputs use their normal items. Header containers with an
    ``items`` method use ``items(multi=True)`` when supported, preserving
    repeated mitmproxy headers, then fall back to ``items()``. Other inputs
    are treated as iterable ``(name, value)`` pairs.
    """
    if isinstance(headers, dict):
        return list(headers.items())
    if hasattr(headers, "items"):
        try:
            return list(headers.items(multi=True))
        except TypeError:
            return list(headers.items())
    return list(headers)


def _connection_header_names(headers: list[tuple[str, str]]) -> set[str]:
    names: set[str] = set()
    for header_name, header_value in headers:
        if header_name.lower() != "connection":
            continue
        for token in header_value.split(","):
            token = token.strip().lower()
            if token:
                names.add(token)
    return names


def _filter_header_pairs(
    headers,
    *,
    extra_excluded: set[str] | None = None,
) -> list[tuple[str, str]]:
    pairs = header_pairs(headers)
    excluded = set(HOP_BY_HOP)
    excluded.update(_connection_header_names(pairs))
    if extra_excluded:
        excluded.update(extra_excluded)
    return [(name, value) for name, value in pairs if name.lower() not in excluded]


def forwarded_request_header_pairs(headers) -> list[tuple[str, str]]:
    """Return request headers that can be forwarded to an auth.base target.

    Hop-by-hop headers and headers named by ``Connection`` are removed.
    ``Host``, ``Content-Length``, and ``Transfer-Encoding`` are also excluded
    because the forwarder recomputes request authority and framing.
    """
    return _filter_header_pairs(
        headers,
        extra_excluded={"host", "content-length", "transfer-encoding"},
    )


def forwarded_auth_base_client_header_pairs(
    headers,
) -> list[tuple[str, str]]:
    """Select representation metadata allowed to cross an auth.base rewrite."""
    raw_pairs = header_pairs(headers)
    content_type_count = sum(1 for name, _value in raw_pairs if name.lower() == "content-type")
    if content_type_count > 1:
        raise InvalidAuthBaseRequestHeadersError(
            "auth.base requests must contain at most one Content-Type header"
        )

    return [
        (name, value)
        for name, value in forwarded_request_header_pairs(raw_pairs)
        if name.lower() in {"content-type", "content-encoding"}
    ]


def _validate_resolved_auth_header_pair(header_name: str, header_value: str) -> None:
    if not isinstance(header_name, str) or not is_http_header_name(header_name):
        raise InvalidResolvedAuthHeaderError("Resolved auth header name is invalid")
    if not isinstance(header_value, str) or has_forbidden_header_value_control(header_value):
        raise InvalidResolvedAuthHeaderError(f"Resolved auth header {header_name} value is invalid")
    try:
        header_value.encode("latin-1")
    except UnicodeEncodeError as exc:
        raise InvalidResolvedAuthHeaderError(
            f"Resolved auth header {header_name} value is invalid"
        ) from exc


def resolved_auth_header_pairs(headers) -> list[tuple[str, str]]:
    """Validate, filter, and canonicalize resolved auth headers for injection.

    Each resolved header name and value is validated before any pair is
    returned; invalid pairs raise ``InvalidResolvedAuthHeaderError``. Accepted
    names are ASCII and accepted values map one-to-one to wire bytes through
    Latin-1. Transport, authority, and framing headers are then dropped using
    all Connection nominations. Case-equivalent names retain the first spelling
    and position, with the last value winning. This helper does not merge with
    or replace client headers; callers that combine resolved and client headers
    own that policy.
    """
    pairs = header_pairs(headers)
    for name, value in pairs:
        _validate_resolved_auth_header_pair(name, value)
    filtered_pairs = _filter_header_pairs(
        pairs,
        extra_excluded={"host", "content-length", "transfer-encoding"},
    )
    resolved_pairs_by_name: dict[str, tuple[str, str]] = {}
    for name, value in filtered_pairs:
        normalized_name = name.lower()
        existing_pair = resolved_pairs_by_name.get(normalized_name)
        first_name = existing_pair[0] if existing_pair is not None else name
        resolved_pairs_by_name[normalized_name] = (first_name, value)
    return list(resolved_pairs_by_name.values())


def trusted_request_header_pairs(headers) -> list[tuple[str, str]]:
    """Validate and filter trusted injected headers through the resolved-auth path."""
    return resolved_auth_header_pairs(headers)


def _filter_response_headers(headers: list[tuple[str, str]]) -> http.Headers:
    """Strip hop-by-hop headers from an upstream response.

    The response body is fully read, so headers like transfer-encoding must
    not be forwarded. Headers named by Connection are hop-by-hop too.

    ``HTTPResponse.getheaders()`` exposes raw field octets through a one-to-one
    ISO-8859-1 decode. Encode with the same codec to restore those octets for
    mitmproxy's byte-backed header container.
    """
    return http.Headers(
        (name.encode("latin-1"), value.encode("latin-1"))
        for name, value in _filter_header_pairs(headers)
    )


def _normalized_forward_request_host(parsed: urllib.parse.SplitResult) -> str:
    raw_host = raw_authority_host(parsed.netloc)
    if raw_host is None:
        if parsed.netloc:
            raise ValueError("Invalid upstream URL: invalid host")
        raise ValueError("Invalid upstream URL: missing host")

    decoded = percent_decode_host(
        raw_host.hostname,
        syntax_chars=_PERCENT_DECODED_UPSTREAM_HOST_SYNTAX_CHARS,
    )
    if decoded.invalid_encoding or decoded.decoded_syntax:
        raise ValueError("Invalid upstream URL: invalid host")
    if any(char in decoded.value for char in _UPSTREAM_HOST_FORBIDDEN_CHARS):
        raise ValueError("Invalid upstream URL: invalid host")

    if raw_host.bracketed:
        try:
            parsed_ip = ipaddress.ip_address(decoded.value)
        except ValueError as exc:
            raise ValueError("Invalid upstream URL: invalid host") from exc
        if parsed_ip.version != IPV6_VERSION or parsed_ip.scope_id is not None:
            raise ValueError("Invalid upstream URL: invalid host")
        return parsed_ip.compressed.lower()

    try:
        return normalize_idna_hostname(decoded.value)
    except (UnicodeError, ValueError) as exc:
        raise ValueError("Invalid upstream URL: invalid host") from exc


def _host_header(host: str, port: int | None) -> str:
    formatted_host = format_url_host(host)
    if port is None or port == DEFAULT_HTTPS_PORT:
        return formatted_host
    return f"{formatted_host}:{port}"


def _request_target(parsed: urllib.parse.SplitResult) -> str:
    path = parsed.path or "/"
    if parsed.query:
        return f"{path}?{parsed.query}"
    return path


def _connection_factory(scheme: str):
    if scheme == "https":
        return _make_validated_https_connection
    raise ValueError(f"Unsupported URL scheme: {scheme}")


def _reject_userinfo(parsed: urllib.parse.SplitResult) -> None:
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("Unsupported URL authority: userinfo is not allowed")


def _outbound_request_headers(
    headers: list[tuple[str, str]],
    host: str,
    port: int | None,
    body: bytes | None,
) -> list[tuple[str, str]]:
    filtered = forwarded_request_header_pairs(headers)
    outbound = [("Host", _host_header(host, port)), *filtered]
    if body is not None:
        outbound.append(("Content-Length", str(len(body))))
    return outbound


def _read_response_body(resp) -> bytes:
    body = resp.read(MAX_AUTH_BASE_RESPONSE_BODY_BYTES + 1)
    if len(body) > MAX_AUTH_BASE_RESPONSE_BODY_BYTES:
        raise ForwardedResponseTooLargeError("Forwarded auth.base response body too large")
    remaining = resp.length
    if remaining is not None and remaining > 0:
        raise http_client.IncompleteRead(body, remaining)
    return body


def validate_request_body_size(body: bytes | None) -> None:
    if body is not None and len(body) > MAX_AUTH_BASE_REQUEST_BODY_BYTES:
        raise ForwardedRequestTooLargeError("Forwarded auth.base request body too large")


def request_body_size(body: bytes | None) -> int:
    return len(body) if body is not None else 0


def _is_public_unicast_address(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    return public_destination.ip_address_is_public(address)


def _raise_unsafe_destination() -> None:
    raise UnsafeAuthBaseDestinationError("Unsafe auth.base upstream destination")


def _get_dns_resolver() -> _AddressResolver:
    global _dns_resolver

    resolver = _dns_resolver
    if resolver is None:
        resolver = mitmproxy_rs.dns.DnsResolver()
        _dns_resolver = resolver
    return resolver


def _validated_address(address: ipaddress.IPv4Address | ipaddress.IPv6Address, port: int):
    family = socket.AF_INET6 if address.version == IPV6_VERSION else socket.AF_INET
    return ValidatedAddress(family, address.compressed, port)


async def resolve_validated_addresses(
    host: str,
    port: int,
    abort_handle: ForwardRequestAbort,
) -> tuple[ValidatedAddress, ...]:
    try:
        literal_address = ipaddress.ip_address(host)
    except ValueError:
        lookup_future = asyncio.ensure_future(_get_dns_resolver().lookup_ip(host))

        def cancel_lookup() -> object:
            return lookup_future.cancel()

        abort_handle.register_async_cancel(cancel_lookup)
        try:
            resolved_hosts = await lookup_future
        finally:
            abort_handle.clear_async_cancel(cancel_lookup)
    else:
        resolved_hosts = [literal_address.compressed]

    seen: set[str] = set()
    addresses: list[ValidatedAddress] = []
    for resolved_host in resolved_hosts:
        address = ipaddress.ip_address(resolved_host)
        key = address.compressed
        if key in seen:
            continue
        seen.add(key)
        if not _is_public_unicast_address(address):
            _raise_unsafe_destination()
        addresses.append(_validated_address(address, port))
    if not addresses:
        raise ValueError("Invalid upstream URL: host did not resolve")
    return tuple(addresses)


def prepare_forward_request(url: str) -> PreparedForwardRequest:
    parsed = split_runtime_url(url)
    _connection_factory(parsed.scheme.lower())
    _reject_userinfo(parsed)
    host = _normalized_forward_request_host(parsed)
    if authority_has_empty_port(parsed.netloc):
        raise ValueError("Invalid upstream URL: invalid port")
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("Invalid upstream URL: invalid port") from exc
    return PreparedForwardRequest(host, port, _request_target(parsed))


def forward_request_sync(
    prepared: PreparedForwardRequest,
    method: str,
    headers: list[tuple[str, str]],
    body: bytes | None,
    validated_addresses: tuple[ValidatedAddress, ...],
    abort_handle: ForwardRequestAbort,
    deadline: float,
) -> tuple[int, bytes, http.Headers]:
    """Forward an HTTPS request to the real URL and return (status, body, headers).

    Security: only https URLs are allowed, and redirects are returned
    to the sandbox client instead of being followed inside the addon.
    """
    abort_handle.raise_if_aborted()
    conn = _make_validated_https_connection(
        prepared.host,
        port=prepared.port,
        deadline=deadline,
        abort_handle=abort_handle,
        validated_addresses=validated_addresses,
    )
    resp = None
    try:
        conn.putrequest(
            method,
            prepared.target,
            skip_host=True,
            skip_accept_encoding=True,
        )
        for header_name, header_value in _outbound_request_headers(
            headers,
            prepared.host,
            prepared.port,
            body,
        ):
            conn.putheader(header_name, header_value)
        conn.endheaders(body)
        conn.set_remaining_timeout()
        resp = conn.getresponse()
        conn.set_remaining_timeout()
        resp_body = _read_response_body(resp)
        return resp.status, resp_body, _filter_response_headers(resp.getheaders())
    finally:
        try:
            if resp is not None:
                resp.close()
        finally:
            try:
                conn.close()
            finally:
                conn._release_abort_socket()
