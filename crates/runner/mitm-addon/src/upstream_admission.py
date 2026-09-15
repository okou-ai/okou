"""TLS and upstream destination admission lifecycle owner."""

import os
from dataclasses import dataclass
from typing import Final, Literal

from mitmproxy import connection, ctx, http, tls

import connection_endpoints
import flow_metadata
import matching
import path_security
import platform_api_url
import registry
import upstream_destination_binding
from host_normalization import normalize_hostname
from runtime_url_parsing import strip_url_query_and_fragment

TLS_ADMISSION_VALID_REGISTRY_SANDBOX: Final = "valid_registry_sandbox"
TLS_ADMISSION_INVALID_REGISTRY_SANDBOX: Final = "invalid_registry_sandbox"
TLS_ADMISSION_REGISTRY_UNAVAILABLE: Final = "registry_unavailable"

_TEST_ENDPOINT_PATH_PREFIX: Final = "/api/test/"
_TEST_ENDPOINT_BYPASS_HEADER: Final = "x-okou-test-endpoint-bypass"
_UPSTREAM_BINDING_DIAGNOSTICS = "_upstream_binding_diagnostics"

TlsAdmissionKind = Literal[
    "valid_registry_sandbox",
    "invalid_registry_sandbox",
    "registry_unavailable",
]
PlatformRequestPathDecision = Literal["api_allow", "firewall", "deny"]
_tls_admissions: dict[str, "TlsAdmission"] = {}


@dataclass(frozen=True)
class TlsAdmission:
    client_ip: str
    kind: TlsAdmissionKind
    run_id: str | None = None
    sni: str | None = None


_api_destination_cache: tuple[str, platform_api_url.PlatformApiUrl | None] | None = None


def _client_connection_id(client: object) -> str | None:
    client_id = getattr(client, "id", None)
    if isinstance(client_id, str) and client_id:
        return client_id
    return None


def record_tls_admission(client: object, admission: TlsAdmission) -> None:
    client_id = _client_connection_id(client)
    if client_id is not None:
        _tls_admissions[client_id] = admission


def tls_admission_for_client(client: object) -> TlsAdmission | None:
    client_id = _client_connection_id(client)
    if client_id is None:
        return None
    return _tls_admissions.get(client_id)


def forget_tls_admission(client: object) -> None:
    client_id = _client_connection_id(client)
    if client_id is not None:
        _tls_admissions.pop(client_id, None)


def reset_tls_admission_state_for_tests() -> None:
    _tls_admissions.clear()


def reset_api_destination_cache_for_tests() -> None:
    global _api_destination_cache
    _api_destination_cache = None


def _connected_verified_tls_destination_endpoint(
    server: object,
    *,
    host: str,
    port: int,
    extra_endpoints: tuple[tuple[str, int] | None, ...] = (),
) -> tuple[str, int] | None:
    """Return verified live endpoint evidence for the exact TLS destination.

    After the caller establishes that ``server`` remains connected, a non-``None`` result supplies
    the remaining evidence for the ``connected_address`` trust precondition of
    ``upstream_destination_binding.refresh_server_binding_connected_address_if_matching()``. The
    upstream TLS connection is verified for normalized SNI ``host``, carries certificate evidence
    without a connection error, and has authoritative connected endpoint evidence for ``port``.

    The fail-closed ``without_verified_tls`` and positive ``after_retargeting`` integration cases
    in ``tests/test_request_handler_connector_admission.py`` exercise this contract.
    """
    if bool(getattr(getattr(ctx, "options", object()), "ssl_insecure", False)):
        return None
    if not bool(getattr(server, "tls_established", False)):
        return None
    if getattr(server, "error", None):
        return None
    server_sni = getattr(server, "sni", None)
    if not isinstance(server_sni, str):
        return None
    try:
        normalized_sni = normalize_hostname(server_sni)
    except (UnicodeError, ValueError):
        return None
    if normalized_sni != host:
        return None
    if not getattr(server, "certificate_list", ()):
        return None

    # mitmproxy verifies the upstream certificate against server.sni when
    # ssl_insecure is false. At this point the connected IP is authenticated as
    # the same host we plan to bind, so CDN/Anycast DNS drift does not matter.
    connected_endpoint = connection_endpoints.connected_ip_destination_endpoint(
        server,
        port=port,
        extra_endpoints=extra_endpoints,
    )
    return connected_endpoint.address if connected_endpoint is not None else None


def _request_has_platform_test_endpoint_bypass(flow: http.HTTPFlow) -> bool:
    if platform_request_path_decision(flow.request.path) != "firewall":
        return False
    expected_bypass = os.environ.get("VERCEL_AUTOMATION_BYPASS_SECRET", "")
    if not expected_bypass:
        return False
    return flow.request.headers.get(_TEST_ENDPOINT_BYPASS_HEADER) == expected_bypass


def platform_request_path_decision(path: str) -> PlatformRequestPathDecision:
    pathname = strip_url_query_and_fragment(path)
    if path_security.has_unsafe_path(pathname):
        return "deny"
    if pathname.startswith(_TEST_ENDPOINT_PATH_PREFIX):
        return "firewall"
    return "api_allow"


def api_destination_matches(
    api_url: str,
    *,
    scheme: str,
    hostname: str,
    port: int,
) -> bool:
    api_destination = _api_destination(api_url)
    if api_destination is None:
        return False
    return _scheme_hostname_port_matches_api_destination(
        scheme=scheme,
        hostname=hostname,
        port=port,
        api_destination=api_destination,
    )


def _scheme_hostname_port_matches_api_destination(
    *,
    scheme: str,
    hostname: str,
    port: int,
    api_destination: platform_api_url.PlatformApiUrl,
) -> bool:
    return (
        scheme.lower() == api_destination.scheme
        and port == api_destination.port
        and (hostname == api_destination.host or hostname.endswith(f".{api_destination.host}"))
    )


def _api_destination(
    api_url: str,
) -> platform_api_url.PlatformApiUrl | None:
    global _api_destination_cache
    cached = _api_destination_cache
    if cached is not None and cached[0] == api_url:
        return cached[1]

    try:
        api_destination = platform_api_url.parse_platform_api_url(api_url)
    except (UnicodeError, ValueError):
        api_destination = None
    _api_destination_cache = (api_url, api_destination)
    return api_destination


def _server_connect_binding_kinds(
    *,
    hostname: str,
    port: int,
    compiled_firewalls: matching.CompiledFirewallSet | None,
    is_api_destination: bool,
) -> frozenset[upstream_destination_binding.BindingKind]:
    kinds: set[upstream_destination_binding.BindingKind] = set()
    if is_api_destination:
        kinds.add("api_allow")
    if (
        not is_api_destination
        and compiled_firewalls is not None
        and compiled_firewalls.matches_ordinary_credential_authority(
            hostname,
            port,
        )
    ):
        kinds.add("connector_auth")
    return frozenset(kinds)


def _bind_privileged_upstream_destination(
    *,
    client: object,
    server: connection.Server,
    raw_sni: object,
    registry_state: registry.RegistryState,
    client_ip: str,
    run_id: str,
    api_url: str,
) -> None:
    if isinstance(registry_state, registry.RegistryUnavailable):
        return

    tls_admission = tls_admission_for_client(client)
    if tls_admission is not None and (
        tls_admission.client_ip != client_ip
        or tls_admission.kind != TLS_ADMISSION_VALID_REGISTRY_SANDBOX
        or (tls_admission.run_id is not None and tls_admission.run_id != run_id)
    ):
        return

    if not isinstance(raw_sni, str) or not raw_sni.strip():
        return

    address = connection_endpoints.server_address(server)
    if address is None:
        return
    _original_host, port = address
    try:
        destination = upstream_destination_binding.normalize_upstream_destination(
            host=raw_sni.strip(),
            port=port,
        )
    except (UnicodeError, ValueError):
        return
    is_api_destination = api_destination_matches(
        api_url,
        scheme="https",
        hostname=destination.host,
        port=destination.port,
    )
    reusable_kind: upstream_destination_binding.BindingKind = (
        "api_allow" if is_api_destination else "connector_auth"
    )
    if upstream_destination_binding.reuse_server_binding_kind_if_matching(
        server,
        client=client,
        destination=destination,
        kind=reusable_kind,
    ):
        return

    kinds = _server_connect_binding_kinds(
        hostname=destination.host,
        port=destination.port,
        compiled_firewalls=registry_state.compiled_firewalls.get(client_ip),
        is_api_destination=is_api_destination,
    )
    if not kinds:
        return

    if upstream_destination_binding.has_server_binding(server):
        if all(
            upstream_destination_binding.add_server_binding_kind_if_matching(
                server,
                client=client,
                destination=destination,
                kind=kind,
            )
            for kind in kinds
        ):
            return
        return

    if bool(getattr(server, "connected", False)):
        return

    server.address = (destination.host, destination.port)

    upstream_destination_binding.record_normalized_server_binding(
        server,
        client=client,
        destination=destination,
        kinds=kinds,
        original_address=address,
    )


def handle_server_connect(
    data: object,
    *,
    registry_path: str,
    api_url: str,
) -> None:
    """Prebind an eligible privileged HTTPS upstream from trusted connection identity.

    The event must expose client and server connections, a client peer IP registered in the
    current available registry, and usable SNI. The hook prefers client SNI and falls back to
    recorded ClientHello SNI. Any TLS admission record must identify the same client IP and a valid
    registry sandbox, and its recorded run identity must match the current run. Missing, stale,
    malformed, or untrusted inputs return without retargeting the server or creating or extending
    a binding.

    The normalized SNI host and current server destination port select one binding purpose. The
    configured HTTPS platform API host and its subdomains at the configured port qualify for
    ``api_allow``. Every other exact HTTPS authority qualifies for ``connector_auth`` only when the
    current sandbox's compiled firewall set admits ordinary credential mutation there. A matching
    direct binding that already has the selected kind may be reused; otherwise the selected purpose
    must currently qualify before a matching binding is extended or a new binding is recorded. A
    nonmatching binding is preserved.

    Without a matching binding, only an unconnected server may be retargeted and bound; SNI alone
    never binds an already-connected server. This connection-phase binding records eligibility,
    not HTTP request authorization. Request handling must still authorize the current request
    before platform API allowance or connector credential mutation.
    """
    client = getattr(data, "client", None)
    server = getattr(data, "server", None)
    if client is None or server is None:
        return

    client_peername = connection_endpoints.client_peername(client)
    client_ip = client_peername[0] if client_peername is not None else None
    if not client_ip:
        return

    registry_state = registry.load_registry_state(registry_path)
    if isinstance(registry_state, registry.RegistryUnavailable):
        return

    sandbox_info = registry_state.sandboxes.get(client_ip)
    if sandbox_info is None:
        return

    run_id = sandbox_info.get("runId", "")
    tls_admission = tls_admission_for_client(client)
    raw_sni = getattr(client, "sni", None)
    if not raw_sni and tls_admission is not None:
        raw_sni = tls_admission.sni
    _bind_privileged_upstream_destination(
        client=client,
        server=server,
        raw_sni=raw_sni,
        registry_state=registry_state,
        client_ip=client_ip,
        run_id=run_id,
        api_url=api_url,
    )


def handle_tls_clienthello(
    data: tls.ClientHelloData,
    *,
    registry_path: str,
    api_url: str,
) -> None:
    """Apply the MITM admission decision for a TLS ClientHello.

    With no client peer IP, leave the interception decision unchanged. Valid registry
    sandboxes stay intercepted and may prebind a privileged upstream. Invalid sandbox
    entries and unavailable registry lookups also stay intercepted, preserving the
    request hook's fail-closed path. When the connection can be keyed, these outcomes
    record ``valid_registry_sandbox`` with run and SNI identity,
    ``invalid_registry_sandbox``, or ``registry_unavailable`` respectively.

    Only a client IP positively absent from a successfully loaded registry clears prior admission
    state and switches to passthrough. TLS admission is connection identity evidence for later
    classification, not cached authorization; current request-time registry state remains
    authoritative for enforcement.
    """
    client_peername = connection_endpoints.client_peername(data.context.client)
    client_ip = client_peername[0] if client_peername is not None else None
    if not client_ip:
        return

    registry_state = registry.load_registry_state(registry_path)
    if isinstance(registry_state, registry.RegistryUnavailable):
        record_tls_admission(
            data.context.client,
            TlsAdmission(
                client_ip=client_ip,
                kind=TLS_ADMISSION_REGISTRY_UNAVAILABLE,
            ),
        )
        return

    sandbox_info = registry_state.sandboxes.get(client_ip)
    if sandbox_info is not None:
        run_id = sandbox_info.get("runId", "")
        raw_sni = data.client_hello.sni
        record_tls_admission(
            data.context.client,
            TlsAdmission(
                client_ip=client_ip,
                kind=TLS_ADMISSION_VALID_REGISTRY_SANDBOX,
                run_id=run_id,
                sni=raw_sni if isinstance(raw_sni, str) else None,
            ),
        )
        _bind_privileged_upstream_destination(
            client=data.context.client,
            server=data.context.server,
            raw_sni=raw_sni,
            registry_state=registry_state,
            client_ip=client_ip,
            run_id=run_id,
            api_url=api_url,
        )
        return

    if client_ip in registry_state.invalid_sandboxes:
        record_tls_admission(
            data.context.client,
            TlsAdmission(
                client_ip=client_ip,
                kind=TLS_ADMISSION_INVALID_REGISTRY_SANDBOX,
            ),
        )
        return

    # Not a registered sandbox - pass through without MITM interception.
    # This is critical for CIDR-based rules where all sandbox traffic is redirected.
    forget_tls_admission(data.context.client)
    data.ignore_connection = True


def has_bound_destination(
    flow: http.HTTPFlow,
    *,
    allowed_kinds: frozenset[upstream_destination_binding.BindingKind],
) -> bool:
    """Return whether the flow authority matches binding evidence for a kind.

    This delegates to
    ``upstream_destination_binding.flow_matches_bound_destination``. A ``True``
    result does not prove a durable direct binding exists: it may be an
    unconnected, retargetable normalized-address match or a prior-client match.
    Callers that need durable direct admission must still require
    ``upstream_destination_binding.has_server_binding`` or use
    ``ensure_bound_destination``.
    """
    return upstream_destination_binding.flow_matches_bound_destination(
        flow,
        allowed_kinds=allowed_kinds,
    )


def _bind_flow_upstream_destination(
    flow: http.HTTPFlow,
    *,
    destination: upstream_destination_binding.NormalizedUpstreamDestination,
    kind: upstream_destination_binding.BindingKind,
) -> bool:
    original_address = connection_endpoints.server_address(flow.server_conn)
    has_server_binding = upstream_destination_binding.has_server_binding(flow.server_conn)

    if has_server_binding:
        if upstream_destination_binding.add_server_binding_kind_if_matching(
            flow.server_conn,
            client=flow.client_conn,
            destination=destination,
            kind=kind,
        ):
            return True
        if flow.server_conn.connected:
            connected_address = _connected_verified_tls_destination_endpoint(
                flow.server_conn,
                host=destination.host,
                port=destination.port,
                extra_endpoints=(connection_endpoints.connection_sockname(flow.client_conn),),
            )
            if connected_address is None:
                return False
            return (
                upstream_destination_binding.refresh_server_binding_connected_address_if_matching(
                    flow.server_conn,
                    client=flow.client_conn,
                    destination=destination,
                    kind=kind,
                    connected_address=connected_address,
                )
            )
        return False

    if flow.server_conn.connected:
        connected_address = _connected_verified_tls_destination_endpoint(
            flow.server_conn,
            host=destination.host,
            port=destination.port,
            extra_endpoints=(connection_endpoints.connection_sockname(flow.client_conn),),
        )
        if connected_address is None:
            return False
        original_address = connected_address
    else:
        flow.server_conn.address = (destination.host, destination.port)

    upstream_destination_binding.record_normalized_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        destination=destination,
        kinds=frozenset((kind,)),
        original_address=original_address,
    )
    return True


def ensure_bound_destination(
    flow: http.HTTPFlow,
    *,
    kind: upstream_destination_binding.BindingKind,
    api_url: str,
) -> bool:
    """Admit the flow's trusted authority for one privileged binding kind.

    ``flow`` must already carry validated trusted-authority metadata and the
    request, client, and server connection state to bind. ``kind`` selects the
    privileged purpose, while ``api_url`` identifies the platform API origin.
    ``api_allow`` requires the current scheme and authority to match that origin;
    ``connector_auth`` on that origin requires the gated test-endpoint bypass
    before either binding or reusing a destination.

    A direct server binding may be reused, extended with ``kind``, or refreshed
    only while its authority and current destination remain valid. Otherwise an
    unconnected server may be retargeted and bound to the normalized authority;
    a connected server requires current verified upstream TLS and authoritative
    endpoint evidence rather than fresh DNS. Client-associated matches are not
    durable proof for the current server connection, so they still pass through
    the direct binding path.

    Return ``True`` only when the current server connection is directly admitted
    for the flow authority, port, and requested kind. ``False`` does not create a
    response and must not be treated as admission: request-header callers may use
    the attempt for best-effort prebinding or defer the decision, but terminal
    callers must fail closed before API auto-allow or ordinary connector
    credential injection.
    """
    trusted_host = flow_metadata.trusted_authority_host(flow.metadata)
    if not trusted_host:
        return False
    try:
        destination = upstream_destination_binding.normalize_upstream_destination(
            host=trusted_host,
            port=flow.request.port,
        )
    except (UnicodeError, ValueError):
        return False

    api_destination = _api_destination(api_url)
    is_api_destination = api_destination is not None and (
        _scheme_hostname_port_matches_api_destination(
            scheme=flow.request.scheme,
            hostname=destination.host,
            port=destination.port,
            api_destination=api_destination,
        )
    )
    if kind == "api_allow" and not is_api_destination:
        return False
    # Synthetic test providers live on the platform API preview host but
    # intentionally exercise connector auth injection instead of API auto-allow.
    # Keep this path limited to test endpoints gated by the same internal
    # bypass secret that the API route validates.
    if (
        kind == "connector_auth"
        and is_api_destination
        and not _request_has_platform_test_endpoint_bypass(flow)
    ):
        return False

    allowed_kinds = frozenset((kind,))
    has_bound = upstream_destination_binding.flow_matches_normalized_destination(
        flow,
        destination=destination,
        allowed_kinds=allowed_kinds,
    )
    if has_bound and upstream_destination_binding.has_server_binding(flow.server_conn):
        return True
    # If has_bound is true here, it is only an unconnected address or
    # prior-client match. That is retargetable, not durable proof for later
    # keepalive reuse, and connected flows still need current upstream TLS proof.
    return _bind_flow_upstream_destination(
        flow,
        destination=destination,
        kind=kind,
    )


def forget_server_binding(server: object) -> None:
    upstream_destination_binding.forget_server_binding(server)


def forget_server_binding_from_event(data: object) -> None:
    server = getattr(data, "server", data)
    forget_server_binding(server)


def forget_client(client: object) -> None:
    forget_tls_admission(client)
    upstream_destination_binding.forget_client_bindings(client)


def _endpoint_text(address: tuple[str, int] | None) -> str:
    if address is None:
        return ""
    host, port = address
    return f"{host}:{port}"


def record_unbound_diagnostics(
    flow: http.HTTPFlow,
    *,
    reason: upstream_destination_binding.BindingKind,
) -> dict[str, object]:
    trusted_host = flow_metadata.trusted_authority_host(flow.metadata)
    diagnostics = upstream_destination_binding.diagnostic_snapshot_for_flow(
        flow,
        allowed_kinds=frozenset((reason,)),
    )
    diagnostics.update(
        {
            "reason": reason,
            "trusted_host": trusted_host,
            "request_host": flow.request.host,
            "request_port": flow.request.port,
            "server_connected": bool(getattr(flow.server_conn, "connected", False)),
            "server_address": _endpoint_text(connection_endpoints.server_address(flow.server_conn)),
            "server_peername": _endpoint_text(
                connection_endpoints.server_peername(flow.server_conn)
            ),
            "server_sockname": _endpoint_text(
                connection_endpoints.connection_sockname(flow.server_conn)
            ),
            "client_sockname": _endpoint_text(
                connection_endpoints.connection_sockname(flow.client_conn)
            ),
        }
    )
    flow.metadata[_UPSTREAM_BINDING_DIAGNOSTICS] = diagnostics
    return diagnostics


def upstream_binding_log_fields(flow: http.HTTPFlow) -> dict[str, str | int | bool]:
    # [NETWORK_LOG_FIELDS] — shared schema and UI boundary is api-contracts.
    diagnostics = flow.metadata.get(_UPSTREAM_BINDING_DIAGNOSTICS)
    if not isinstance(diagnostics, dict):
        return {}
    return {
        f"upstream_binding_{key}": value
        for key, value in diagnostics.items()
        if isinstance(value, (str, int, bool))
    }


def upstream_binding_diagnostics_for_tests(flow: http.HTTPFlow) -> dict[str, object]:
    diagnostics = flow.metadata.get(_UPSTREAM_BINDING_DIAGNOSTICS)
    if not isinstance(diagnostics, dict):
        return {}
    return diagnostics
