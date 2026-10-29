"""Trusted request authority validation and URL reconstruction.

Pure functions with no module-level state or I/O.

Host/SNI input is a distinct trust boundary from auth.base targets. This
module rejects percent-encoded authority syntax before using request authority
for firewall matching or credential injection.
"""

import ipaddress
from dataclasses import dataclass
from typing import Final, Literal

from mitmproxy import http

import connection_endpoints
import connector_runtime_metadata
import flow_metadata_keys as metadata_keys
import public_destination
from authority_utils import (
    IPV6_VERSION,
    format_url_host,
    has_ascii_space_or_control,
    is_default_scheme_port,
    parse_authority_port,
)
from host_normalization import normalize_hostname

_FORBIDDEN_HOST_CHARS = frozenset("#%*,/<>?@[\\]^|{}")
_DEFAULT_HTTPS_PORT = 443
_RAW_HOST_HEADER_NAME: Final = b"host"
_HOST_HEADER_FOLD_SEPARATOR_BYTES: Final = len(b", ")
_MAX_HOST_HEADER_BYTES: Final = 4096


@dataclass(frozen=True)
class TrustedAuthority:
    """Authority components trusted by firewall/auth decisions.

    For HTTPS, ``host`` is the normalized TLS SNI after HTTP request authority
    validation. HTTP uses the transparent destination unless a flow-owned custom
    API binding independently pins its asserted domain to a public destination.
    ``url`` is the reconstructed URL used by firewall matching and injection.
    """

    host: str
    port: int
    url: str


@dataclass(frozen=True)
class CustomHttpBinding:
    """Flow-owned proof connecting a custom HTTP authority to a pinned public IP.

    Neither a client Host assertion nor source-provided connector metadata
    creates proof. Credential handling separately rechecks current ownership.
    """

    host: str
    port: int
    endpoint: tuple[str, int]
    client_id: str
    server_id: str


def custom_http_destination_endpoint(flow: http.HTTPFlow) -> tuple[str, int] | None:
    """Require the original IP target and any connected peer to agree publicly."""
    address = connection_endpoints.server_address(flow.server_conn)
    if address is None or address[1] != flow.request.port:
        return None
    if not public_destination.validate_runtime_destination_host(address[0]).allowed:
        return None
    if flow.server_conn.connected:
        peer = connection_endpoints.server_peername(flow.server_conn)
        if peer is not None and (
            peer[1] != address[1]
            or not public_destination.validate_runtime_destination_host(peer[0]).allowed
            or ipaddress.ip_address(peer[0]) != ipaddress.ip_address(address[0])
        ):
            return None
    return address


def custom_http_binding(flow: http.HTTPFlow) -> CustomHttpBinding | None:
    binding = flow.metadata.get(metadata_keys.CUSTOM_HTTP_BINDING)
    return binding if isinstance(binding, CustomHttpBinding) else None


def custom_http_binding_is_current(flow: http.HTTPFlow, binding: CustomHttpBinding) -> bool:
    return (
        flow.request.scheme == "http"
        and flow.request.port == binding.port
        and flow.client_conn.id == binding.client_id
        and flow.server_conn.id == binding.server_id
        and flow.error is None
        and not flow.server_conn.error
        and not flow.server_conn.tls
        and flow.request.host == binding.endpoint[0]
        and custom_http_destination_endpoint(flow) == binding.endpoint
    )


def custom_http_auth_is_allowed(flow: http.HTTPFlow, api_entry: dict, sandbox_info: dict) -> bool:
    """Narrow the HTTP credential exception to the bound registered custom API."""
    binding = custom_http_binding(flow)
    auth_config = api_entry.get("auth", {})
    if not isinstance(auth_config, dict) or any(
        key not in ("headers", "query") for key in auth_config
    ):
        return False
    firewalls = sandbox_info.get("firewalls", ())
    if binding is None or not any(
        connector_runtime_metadata.connector_runtime_kind(firewall) == "custom"
        and any(api_entry is entry for entry in firewall.get("apis", ()))
        for firewall in firewalls
    ):
        return False
    authority = get_trusted_authority(flow)
    return authority.host == binding.host and custom_http_binding_is_current(flow, binding)


AuthorityValidationReason = Literal[
    "missing_sni",
    "invalid_sni",
    "missing_authority",
    "invalid_authority",
    "authority_mismatch",
    "authority_port_mismatch",
]


class AuthorityValidationError(Exception):
    """HTTPS authority or custom HTTP binding failure with a public reason.

    ``reason`` is exposed in proxy logs as ``reason``, network logs as
    ``firewall_error``, and the 403 JSON response body as ``error``.

    Valid reason values:
    - ``missing_sni``: the HTTPS request had no TLS SNI.
    - ``invalid_sni``: the TLS SNI failed hostname normalization.
    - ``missing_authority``: the request had no required Host/``:authority``.
    - ``invalid_authority``: an asserted HTTP authority was ambiguous or failed
      parsing or normalization.
    - ``authority_mismatch``: asserted authorities conflicted, disagreed with TLS
      SNI, or failed the custom HTTP public-destination binding.
    - ``authority_port_mismatch``: an asserted authority port did not match the
      destination port.
    """

    def __init__(
        self,
        reason: AuthorityValidationReason,
        *,
        message: str,
        sni: str | None,
        request_host: str,
        host_header: str | None,
        request_port: int,
        fallback_url: str,
    ) -> None:
        super().__init__(message)
        self.reason: AuthorityValidationReason = reason
        self.message = message
        self.sni = sni
        self.request_host = request_host
        self.host_header = host_header
        self.request_port = request_port
        self.fallback_url = fallback_url


def _host_with_port(scheme: str, host: str, port: int) -> str:
    url_host = format_url_host(host)
    if scheme in ("http", "https") and not is_default_scheme_port(scheme, port):
        return f"{url_host}:{port}"
    return url_host


def _build_url(scheme: str, host: str, port: int, path: str) -> str:
    uri_path = "" if path == "*" else path
    return f"{scheme}://{_host_with_port(scheme, host, port)}{uri_path}"


def _host_headers_within_budget(headers: http.Headers) -> bool:
    """Bound addon Host value work before dependency string access.

    This is not a proxy request-head limit: mitmproxy has already buffered the
    fields before addon hooks run. Separators match ``Headers`` folding so a
    bounded result also bounds duplicate-field decoding and diagnostics.
    """
    host_header_bytes = 0
    has_host_header = False
    for name, value in headers.fields:
        if name.lower() != _RAW_HOST_HEADER_NAME:
            continue
        if has_host_header:
            host_header_bytes += _HOST_HEADER_FOLD_SEPARATOR_BYTES
        host_header_bytes += len(value)
        if host_header_bytes > _MAX_HOST_HEADER_BYTES:
            return False
        has_host_header = True
    return True


def _parse_host_authority(authority: str) -> tuple[str, int | None]:
    if not authority or has_ascii_space_or_control(authority):
        raise ValueError("invalid authority")

    if authority.startswith("["):
        close_index = authority.find("]")
        if close_index == -1:
            raise ValueError("invalid IPv6 authority")
        host = authority[1:close_index]
        rest = authority[close_index + 1 :]
        if rest == "":
            port = None
        elif rest.startswith(":"):
            port = parse_authority_port(rest[1:])
        else:
            raise ValueError("invalid IPv6 authority")
        if "%" in host:
            raise ValueError("IPv6 scope identifiers are not allowed")
        parsed = ipaddress.ip_address(host)
        if parsed.version != IPV6_VERSION:
            raise ValueError("bracketed authority must be IPv6")
        return host, port

    if any(char in _FORBIDDEN_HOST_CHARS or char == "," for char in authority):
        raise ValueError("invalid host authority")
    if authority.count(":") > 1:
        raise ValueError("unbracketed IPv6 authority")
    if ":" not in authority:
        return authority, None

    host, raw_port = authority.rsplit(":", maxsplit=1)
    if not host:
        raise ValueError("missing authority host")
    return host, parse_authority_port(raw_port)


def get_http_authority_assertion(flow: http.HTTPFlow) -> TrustedAuthority:
    """Parse untrusted HTTP assertions; callers must independently bind the IP."""
    fallback_url = _build_url("http", flow.request.host, flow.request.port, flow.request.path)

    def invalid(reason: AuthorityValidationReason, message: str) -> AuthorityValidationError:
        return AuthorityValidationError(
            reason,
            message=message,
            sni=None,
            request_host=flow.request.host,
            host_header=None,
            request_port=flow.request.port,
            fallback_url=fallback_url,
        )

    if not _host_headers_within_budget(flow.request.headers):
        raise invalid("invalid_authority", "Request blocked: invalid HTTP Host authority")
    raw_headers = flow.request.headers.get_all("Host")
    if len(raw_headers) > 1:
        raise invalid("invalid_authority", "Request blocked: multiple HTTP Host fields")
    asserted_host = flow.request.host_header
    if not asserted_host:
        raise invalid("missing_authority", "Request blocked: missing HTTP Host authority")
    assertions = [asserted_host, *raw_headers]
    if flow.request.authority:
        assertions.append(flow.request.authority)
    normalized_host = ""
    for assertion in assertions:
        try:
            host, port = _parse_host_authority(assertion)
            host = normalize_hostname(host)
        except UnicodeError, ValueError:
            raise invalid(
                "invalid_authority", "Request blocked: invalid HTTP Host authority"
            ) from None
        if normalized_host and host != normalized_host:
            raise invalid("authority_mismatch", "Request blocked: conflicting HTTP authorities")
        if (port if port is not None else 80) != flow.request.port:
            raise invalid(
                "authority_port_mismatch", "Request blocked: HTTP authority port mismatch"
            )
        normalized_host = host
    return TrustedAuthority(
        host=normalized_host,
        port=flow.request.port,
        url=_build_url("http", normalized_host, flow.request.port, flow.request.path),
    )


def get_trusted_authority(flow: http.HTTPFlow) -> TrustedAuthority:
    """Resolve the authority trusted for firewall/auth decisions.

    In transparent mode, mitmproxy's request host is the ``SO_ORIGINAL_DST``
    destination. For HTTPS, the TLS SNI is the domain authority used for
    upstream TLS, while Host, HTTP/1 request-target authority, and HTTP/2/3
    ``:authority`` values are only client assertions. Require every HTTP
    authority to agree with SNI before using the URL for firewall matching or
    credential injection. HTTP has no SNI: use its transparent destination unless
    custom API preparation established a still-current public-IP binding. Host
    assertions alone never change authority.

    HTTPS validation and custom HTTP binding failures raise
    ``AuthorityValidationError`` with a documented ``AuthorityValidationReason``.
    """
    scheme = flow.request.scheme
    port = flow.request.port
    path = flow.request.path
    request_host = flow.request.host

    if scheme == "http" and (binding := custom_http_binding(flow)) is not None:
        asserted = get_http_authority_assertion(flow)
        if asserted.host != binding.host or not custom_http_binding_is_current(flow, binding):
            raise AuthorityValidationError(
                "authority_mismatch",
                message="Request blocked: custom HTTP destination binding changed",
                sni=None,
                request_host=request_host,
                host_header=None,
                request_port=port,
                fallback_url=_build_url(scheme, binding.host, port, path),
            )
        return asserted

    if scheme != "https":
        return TrustedAuthority(
            host=request_host,
            port=port,
            url=_build_url(scheme, request_host, port, path),
        )

    host_headers_within_budget = _host_headers_within_budget(flow.request.headers)
    if host_headers_within_budget:
        host_header = flow.request.host_header
        raw_host_headers = flow.request.headers.get_all("Host")
    else:
        host_header = None
        raw_host_headers = []
    raw_sni = getattr(flow.client_conn, "sni", None)
    sni = raw_sni.strip() if isinstance(raw_sni, str) else None

    def _authority_validation_error(
        reason: AuthorityValidationReason,
        *,
        message: str,
        fallback_url: str,
    ) -> AuthorityValidationError:
        return AuthorityValidationError(
            reason,
            message=message,
            sni=sni,
            request_host=request_host,
            host_header=host_header,
            request_port=port,
            fallback_url=fallback_url,
        )

    if not sni:
        raise _authority_validation_error(
            "missing_sni",
            message="Request blocked: HTTPS request is missing TLS SNI",
            fallback_url=_build_url(scheme, request_host, port, path),
        )

    try:
        normalized_sni = normalize_hostname(sni)
    except UnicodeError, ValueError:
        raise _authority_validation_error(
            "invalid_sni",
            message="Request blocked: HTTPS request has invalid TLS SNI",
            fallback_url=_build_url(scheme, request_host, port, path),
        ) from None

    trusted_url = _build_url(scheme, normalized_sni, port, path)
    if not host_headers_within_budget:
        raise _authority_validation_error(
            "invalid_authority",
            message="Request blocked: HTTPS request has invalid Host authority",
            fallback_url=trusted_url,
        )

    if len(raw_host_headers) > 1:
        raise _authority_validation_error(
            "invalid_authority",
            message="Request blocked: HTTPS request has multiple Host fields",
            fallback_url=trusted_url,
        )

    if not host_header:
        raise _authority_validation_error(
            "missing_authority",
            message="Request blocked: HTTPS request is missing Host authority",
            fallback_url=trusted_url,
        )

    authority_assertions: list[tuple[str, int | None]] = [(host_header, None)]
    request_authority = flow.request.authority
    if request_authority:
        if flow.request.is_http2 or flow.request.is_http3:
            if raw_host_headers:
                authority_assertions.append((raw_host_headers[0], None))
        else:
            # Unlike a Host field, an absolute HTTPS URI with no explicit port
            # identifies the default 443 origin.
            authority_assertions.append((request_authority, _DEFAULT_HTTPS_PORT))

    for authority, implicit_port in authority_assertions:
        try:
            parsed_host, explicit_port = _parse_host_authority(authority)
            normalized_authority_host = normalize_hostname(parsed_host)
        except UnicodeError, ValueError:
            raise _authority_validation_error(
                "invalid_authority",
                message="Request blocked: HTTPS request has invalid Host authority",
                fallback_url=trusted_url,
            ) from None

        if normalized_authority_host != normalized_sni:
            raise _authority_validation_error(
                "authority_mismatch",
                message="Request blocked: Host authority does not match TLS SNI",
                fallback_url=trusted_url,
            )

        effective_port = explicit_port if explicit_port is not None else implicit_port
        if effective_port is not None and effective_port != port:
            raise _authority_validation_error(
                "authority_port_mismatch",
                message="Request blocked: Host authority port does not match destination port",
                fallback_url=trusted_url,
            )

    return TrustedAuthority(host=normalized_sni, port=port, url=trusted_url)
