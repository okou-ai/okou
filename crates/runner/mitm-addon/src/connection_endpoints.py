"""Read-only helpers for mitmproxy connection identity and endpoint shapes."""

import ipaddress
from dataclasses import dataclass

_ADDRESS_PAIR_LENGTH = 2


@dataclass(frozen=True, slots=True)
class ConnectedIpEndpoint:
    """Parsed connected IP with its original endpoint text.

    This value records IP screening performed by this module. It is not proof of TLS identity,
    destination ownership, authorization, or public routability.
    """

    address: tuple[str, int]
    parsed_ip: ipaddress.IPv4Address | ipaddress.IPv6Address


def connection_id(connection: object) -> str | None:
    """Return the original truthy string ID without proving ownership or authorization."""
    connection_id = getattr(connection, "id", None)
    if isinstance(connection_id, str) and connection_id:
        return connection_id
    return None


def client_peername(client: object) -> tuple[str, int] | None:
    """Return the client peer address pair after shape validation without parsing its host."""
    return address_pair(getattr(client, "peername", None))


def server_address(server: object) -> tuple[str, int] | None:
    return address_pair(getattr(server, "address", None))


def server_peername(server: object) -> tuple[str, int] | None:
    return address_pair(getattr(server, "peername", None))


def connection_sockname(connection: object) -> tuple[str, int] | None:
    return address_pair(getattr(connection, "sockname", None))


def address_pair(address: object) -> tuple[str, int] | None:
    """Return the first host-port pair from a mitmproxy address tuple.

    ``address`` must be a tuple with at least two elements whose first two values are a
    ``str`` host and an ``int`` port. Additional elements, such as IPv6 flowinfo and scope ID
    fields, are ignored. This validates shape only: it neither parses the host nor validates the
    port value. Unusable shapes return ``None``.
    """
    if not isinstance(address, tuple) or len(address) < _ADDRESS_PAIR_LENGTH:
        return None
    host, port = address[:_ADDRESS_PAIR_LENGTH]
    if not isinstance(host, str) or not isinstance(port, int):
        return None
    return host, port


def diagnostic_text(address: tuple[str, int] | None) -> str:
    """Render diagnostic endpoint text, preserving the original host and port.

    Missing endpoints render as empty text. IPv6 hosts remain unbracketed;
    this representation is not a URL or HTTP authority.
    """
    if address is None:
        return ""
    host, port = address
    return f"{host}:{port}"


def authoritative_connected_endpoint(endpoint: object) -> ConnectedIpEndpoint | None:
    """Return parsed evidence from an acceptable connected IP endpoint.

    The endpoint must have an ``address_pair`` shape and its host must parse as an IPv4 or IPv6
    literal. DNS names, malformed endpoints, loopback addresses, and unspecified addresses return
    ``None``. Other parsed IP address categories are not filtered: ``authoritative`` describes
    connected endpoint evidence, not public routability. Accepted inputs retain their first
    original ``(host, port)`` pair alongside the parsed IP. Additional tuple elements are
    discarded, while the host and port values themselves are not normalized.
    """
    endpoint_pair = address_pair(endpoint)
    if endpoint_pair is None:
        return None
    endpoint_host, _endpoint_port = endpoint_pair
    try:
        endpoint_ip = ipaddress.ip_address(endpoint_host)
    except ValueError:
        return None
    if endpoint_ip.is_loopback or endpoint_ip.is_unspecified:
        return None
    return ConnectedIpEndpoint(address=endpoint_pair, parsed_ip=endpoint_ip)


def connected_ip_destination_endpoint(
    server: object,
    *,
    port: int,
    extra_endpoints: tuple[tuple[str, int] | None, ...] = (),
) -> ConnectedIpEndpoint | None:
    """Resolve connected IP evidence for ``port`` using fail-closed precedence.

    Check ``server.peername`` and then ``server.address``. The first authoritative primary
    endpoint is final: return it when its port matches, or return ``None`` without consulting
    lower-priority evidence when it does not.

    Only when neither primary endpoint is authoritative are ``extra_endpoints`` checked in order.
    Non-authoritative and wrong-port extras are skipped, and the first authoritative matching-port
    extra is returned. ``None`` means no acceptable evidence established the requested destination,
    including when an authoritative primary endpoint contradicted the requested port.
    """
    peername = authoritative_connected_endpoint(server_peername(server))
    if peername is not None:
        return peername if peername.address[1] == port else None

    address = authoritative_connected_endpoint(server_address(server))
    if address is not None:
        return address if address.address[1] == port else None

    for extra_endpoint in extra_endpoints:
        endpoint = authoritative_connected_endpoint(extra_endpoint)
        if endpoint is not None and endpoint.address[1] == port:
            return endpoint

    return None
