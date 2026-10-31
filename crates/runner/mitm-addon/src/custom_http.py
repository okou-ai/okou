"""Bind registered custom HTTP API assertions to public transparent destinations.

HTTP has no TLS identity. Only a matching registry-owned custom API may recover
its domain from Host, after independent DNS agrees with the concrete public IP.
The actual upstream remains IP-pinned, including acquisition after auth waits;
DNS is never substituted for endpoint evidence or used to retarget a connection.
"""

import asyncio
import ipaddress
from collections.abc import Awaitable

import mitmproxy_rs
from mitmproxy import http

import connection_endpoints
import flow_metadata_keys as metadata_keys
import matching
import public_destination
import registry
from request_authority import (
    AuthorityValidationError,
    CustomHttpBinding,
    TrustedAuthority,
    custom_http_binding,
    custom_http_binding_is_current,
    custom_http_destination_endpoint,
    get_http_authority_assertion,
    get_trusted_authority,
)

_DNS_TIMEOUT_SECONDS = 10


class InvalidFirewallInputError(Exception):
    def __init__(
        self, result: matching.FirewallInvalidInput, *, authority: TrustedAuthority
    ) -> None:
        super().__init__("invalid firewall path analysis")
        self.result = result
        self.authority = authority


def _destination_error(flow: http.HTTPFlow) -> AuthorityValidationError:
    return AuthorityValidationError(
        "authority_mismatch",
        message="Request blocked: custom HTTP authority is not bound to a public destination",
        sni=None,
        request_host=flow.request.host,
        host_header=None,
        request_port=flow.request.port,
        fallback_url=get_trusted_authority(flow).url,
    )


def prepare(flow: http.HTTPFlow, *, registry_path: str) -> Awaitable[None] | None:
    """Prepare an HTTP-only proof before classification or any body streaming.

    This does not grant permission: normal current-registry owner selection,
    network policies and auth revalidation still follow. Other HTTP traffic
    keeps transparent IP authority semantics and never trusts Host globally.
    """
    if flow.request.scheme != "http":
        return None
    if custom_http_binding(flow) is not None:
        get_trusted_authority(flow)
        return None
    peer = connection_endpoints.client_peername(flow.client_conn)
    state = registry.load_registry_state(registry_path)
    if peer is None or isinstance(state, registry.RegistryUnavailable):
        return None
    custom_candidates = state.compiled_custom_firewalls.get(peer[0])
    if custom_candidates is None:
        return None

    def matches(url: str) -> bool:
        result = matching.match_compiled_firewall_request(
            url,
            flow.request.method,
            custom_candidates,
            state.compiled_network_policies[peer[0]],
            is_asterisk_form=flow.request.path == "*",
        )
        if isinstance(result, matching.FirewallInvalidInput):
            raise InvalidFirewallInputError(result, authority=original_authority)
        return result is not None

    original_authority = get_trusted_authority(flow)
    original_url = original_authority.url
    try:
        asserted = get_http_authority_assertion(flow)
    except AuthorityValidationError:
        # A malformed assertion cannot opt ordinary traffic into this exception,
        # or bypass public binding for a directly matched custom IP prefix.
        if matches(original_url):
            raise
        return None
    if not matches(asserted.url):
        if matches(original_url):
            raise _destination_error(flow)
        return None

    endpoint = custom_http_destination_endpoint(flow)
    if endpoint is None or flow.error is not None or flow.server_conn.error or flow.server_conn.tls:
        raise _destination_error(flow)
    return _resolve_and_bind(flow, asserted=asserted, endpoint=endpoint)


async def _resolve_and_bind(
    flow: http.HTTPFlow, *, asserted: TrustedAuthority, endpoint: tuple[str, int]
) -> None:
    try:
        literal = ipaddress.ip_address(asserted.host)
    except ValueError:
        try:
            async with asyncio.timeout(_DNS_TIMEOUT_SECONDS):
                addresses = await mitmproxy_rs.dns.DnsResolver().lookup_ip(asserted.host)
            parsed_addresses = tuple(ipaddress.ip_address(address) for address in addresses)
        except OSError, ValueError, TimeoutError:
            raise _destination_error(flow) from None
    else:
        parsed_addresses = (literal,)
    if (
        not parsed_addresses
        or not all(public_destination.ip_address_is_public(address) for address in parsed_addresses)
        or ipaddress.ip_address(endpoint[0]) not in parsed_addresses
        or get_http_authority_assertion(flow) != asserted
        or custom_http_destination_endpoint(flow) != endpoint
    ):
        raise _destination_error(flow)

    # Keep the transparent IP as the request's acquisition target; setting host
    # must not rewrite the caller's wire Host/:authority (mitmproxy property API).
    wire_authority = flow.request.authority
    wire_headers = flow.request.headers.fields
    flow.request.host = endpoint[0]
    flow.request.authority = wire_authority
    flow.request.headers.fields = wire_headers
    binding = CustomHttpBinding(
        host=asserted.host,
        port=asserted.port,
        endpoint=endpoint,
        client_id=flow.client_conn.id,
        server_id=flow.server_conn.id,
    )
    if not custom_http_binding_is_current(flow, binding):
        raise _destination_error(flow)
    flow.metadata[metadata_keys.CUSTOM_HTTP_BINDING] = binding
