"""Shared HTTP request classification contract for mitmproxy hooks.

This module owns the classification result consumed by both `requestheaders()`
and `request()`. The header hook may classify as a probe before mitmproxy has
buffered the request body. It caches the classification only when header-phase
authorization is complete and mitmproxy may start upstream streaming before the
request hook. Body-admission paths keep their admission state separately so the
request hook classifies them against current registry state before upstream
dispatch.

The request hook consumes a cached classification when present, otherwise it
performs a fresh classification. Cached classifications are scoped to a single
flow and must be popped by terminal, response/error, and final request paths so
stale decisions cannot leak into later hook handling for the same flow.
"""

from dataclasses import dataclass, field
from typing import Literal, Protocol

from mitmproxy import http

import connection_endpoints
import connector_intent
import flow_metadata
import flow_metadata_keys as metadata_keys
import gmail_send
import http_network_log
import matching
import public_destination
import registry
import registry_firewalls
import upstream_admission
import upstream_destination_binding
from request_authority import AuthorityValidationError, TrustedAuthority, get_trusted_authority

REQUEST_CLASSIFICATION_METADATA_KEY = "_request_classification"
# Metadata that the requestheaders probe path may write while using this
# classification result. Restore it when the probe is not carried forward into
# request handling.
REQUEST_HEADERS_PROBE_METADATA_KEYS = (
    metadata_keys.SANDBOX_RUN_ID,
    metadata_keys.SANDBOX_NETWORK_LOG_PATH,
    metadata_keys.SANDBOX_PROXY_LOG_PATH,
    metadata_keys.CAPTURE_BODY,
    metadata_keys.SANDBOX_AUTH_KEY,
    metadata_keys.CLI_AGENT_TYPE,
    metadata_keys.BROWSER_USER_AGENT,
    metadata_keys.WEBSOCKET_UPGRADE_REQUEST,
    metadata_keys.RESPONSE_ENCODING_NEGOTIATION,
    metadata_keys.ORIGINAL_URL,
    metadata_keys.TRUSTED_AUTHORITY_HOST,
    metadata_keys.NETWORK_LOG_TARGET,
    metadata_keys.HTTP_REQUEST_START_MONOTONIC,
    metadata_keys.AWS_SIGV4_REQUEST_INSPECTION,
)

_BROWSER_USER_AGENT_MARKERS = (
    " chrome/",
    " chromium/",
    " crios/",
    " edg/",
    " firefox/",
    " fxios/",
    " headlesschrome/",
    " opr/",
    " safari/",
)
# User-Agent is only a spoofable business passthrough signal. Values above this
# budget conservatively continue through ordinary firewall classification.
_MAX_BROWSER_USER_AGENT_BYTES = 4096

type StaleTlsAdmissionReason = Literal[
    "client_ip_missing",
    "client_ip_mismatch",
    "registry_entry_missing",
    "run_id_mismatch",
]
type _PublicDestinationClassifications = dict[
    str,
    public_destination.RuntimeDestinationHostClassification,
]


class TlsAdmissionView(Protocol):
    """TLS admission facts captured before HTTP request classification."""

    @property
    def client_ip(self) -> str:
        raise NotImplementedError

    @property
    def run_id(self) -> str | None:
        raise NotImplementedError


@dataclass(frozen=True)
class PublicDestinationDenial:
    """Runtime publicDestination denial returned with its logging context."""

    name: str
    base: str
    trusted_authority_host: str
    destination_host: str
    reason: public_destination.DestinationDenialReason


@dataclass(frozen=True)
class NoClientIp:
    kind: Literal["no_client_ip"] = field(init=False, default="no_client_ip")


@dataclass(frozen=True)
class PassThrough:
    kind: Literal["pass_through"] = field(init=False, default="pass_through")


@dataclass(frozen=True)
class RegistryUnavailable:
    registry_unavailable: registry.RegistryUnavailable
    kind: Literal["registry_unavailable"] = field(init=False, default="registry_unavailable")


@dataclass(frozen=True)
class StaleTlsAdmission:
    stale_tls_reason: StaleTlsAdmissionReason
    kind: Literal["stale_tls_admission"] = field(init=False, default="stale_tls_admission")


@dataclass(frozen=True)
class InvalidRegistrySandbox:
    invalid_sandbox: registry.InvalidSandboxEntry
    kind: Literal["invalid_registry_sandbox"] = field(
        init=False, default="invalid_registry_sandbox"
    )


@dataclass(frozen=True)
class AuthorityDenied:
    sandbox_info: dict
    authority_error: AuthorityValidationError
    kind: Literal["authority_denied"] = field(init=False, default="authority_denied")


@dataclass(frozen=True)
class ApiAllow:
    sandbox_info: dict
    kind: Literal["api_allow"] = field(init=False, default="api_allow")


@dataclass(frozen=True)
class PlatformPathDenied:
    sandbox_info: dict
    kind: Literal["platform_path_denied"] = field(
        init=False,
        default="platform_path_denied",
    )


@dataclass(frozen=True)
class BrowserAllow:
    sandbox_info: dict
    kind: Literal["browser_allow"] = field(init=False, default="browser_allow")


@dataclass(frozen=True)
class GmailSendBlocked:
    sandbox_info: dict
    kind: Literal["gmail_send_blocked"] = field(init=False, default="gmail_send_blocked")


@dataclass(frozen=True)
class FirewallAmbiguous:
    sandbox_info: dict
    firewall_ambiguous: matching.FirewallAmbiguous
    builtin_firewall_catalog_snapshot: registry_firewalls.BuiltinFirewallCatalogSnapshot | None
    kind: Literal["firewall_ambiguous"] = field(init=False, default="firewall_ambiguous")


@dataclass(frozen=True)
class FirewallBlock:
    sandbox_info: dict
    firewall_block: matching.FirewallBlock
    kind: Literal["firewall_block"] = field(init=False, default="firewall_block")


@dataclass(frozen=True)
class FirewallAllow:
    sandbox_info: dict
    firewall_allow: matching.FirewallAllow
    builtin_firewall_catalog_snapshot: registry_firewalls.BuiltinFirewallCatalogSnapshot | None
    kind: Literal["firewall_allow"] = field(init=False, default="firewall_allow")


@dataclass(frozen=True)
class FirewallPolicyAllow:
    sandbox_info: dict
    firewall_allow: matching.FirewallAllow
    kind: Literal["firewall_policy_allow"] = field(
        init=False,
        default="firewall_policy_allow",
    )


@dataclass(frozen=True)
class PublicDestinationDenied:
    sandbox_info: dict
    public_destination_denial: PublicDestinationDenial
    kind: Literal["public_destination_denied"] = field(
        init=False,
        default="public_destination_denied",
    )


@dataclass(frozen=True)
class Allow:
    sandbox_info: dict
    builtin_firewall_catalog_snapshot: registry_firewalls.BuiltinFirewallCatalogSnapshot | None
    is_asterisk_form: bool
    kind: Literal["allow"] = field(init=False, default="allow")


# This must remain a runtime union because cached metadata is validated with
# ``isinstance`` before it is returned to request handling. Blocking members
# own a canonical local response in both primary dispatch and revalidation.
BlockingRequestClassification = (
    RegistryUnavailable
    | StaleTlsAdmission
    | InvalidRegistrySandbox
    | AuthorityDenied
    | PlatformPathDenied
    | GmailSendBlocked
    | FirewallAmbiguous
    | FirewallBlock
    | PublicDestinationDenied
)
RequestClassification = (
    NoClientIp
    | PassThrough
    | BlockingRequestClassification
    | ApiAllow
    | BrowserAllow
    | FirewallAllow
    | FirewallPolicyAllow
    | Allow
)


def cache_classification(flow: http.HTTPFlow, classification: RequestClassification) -> None:
    """Cache a header-phase classification for request-phase reuse.

    Callers must cache only after header-phase authorization is complete and
    mitmproxy may start upstream streaming before the request hook. Reserving
    buffered body admission alone does not authorize reuse. Terminal and
    early-response paths must pop the cached value.
    """

    flow.metadata[REQUEST_CLASSIFICATION_METADATA_KEY] = classification


def pop_cached_classification(flow: http.HTTPFlow) -> RequestClassification | None:
    """Remove and return the flow-scoped cached classification, if present."""

    classification = flow.metadata.pop(REQUEST_CLASSIFICATION_METADATA_KEY, None)
    return classification if isinstance(classification, RequestClassification) else None


def cached_classification(flow: http.HTTPFlow) -> RequestClassification | None:
    """Return the flow-scoped cached classification without consuming it."""

    classification = flow.metadata.get(REQUEST_CLASSIFICATION_METADATA_KEY)
    return classification if isinstance(classification, RequestClassification) else None


def classification_for_request(
    flow: http.HTTPFlow,
    *,
    registry_path: str,
    api_url: str,
    tls_admission: TlsAdmissionView | None,
) -> RequestClassification:
    """Return a classification valid for the current request state.

    The request hook reuses a header-phase cached classification when one was
    intentionally carried forward. Cached firewall allows are revalidated
    against the current runtime destination because the endpoint may have
    changed between hooks. Otherwise, this classifies the current flow.
    """

    classification = cached_classification(flow)
    if classification is None:
        return classify_request(
            flow,
            registry_path=registry_path,
            api_url=api_url,
            tls_admission=tls_admission,
        )
    return revalidate_classification_for_current_destination(flow, classification)


def revalidate_classification_for_current_destination(
    flow: http.HTTPFlow,
    classification: RequestClassification,
    *,
    defer_unresolved_public_destination: bool = False,
) -> RequestClassification:
    """Recheck destination-dependent policy for an existing classification."""

    if isinstance(classification, FirewallAllow | FirewallPolicyAllow):
        public_destination_denial = current_public_destination_denial(
            flow,
            classification.firewall_allow,
            defer_unresolved_hostnames=defer_unresolved_public_destination,
        )
        if public_destination_denial is not None:
            return PublicDestinationDenied(
                sandbox_info=classification.sandbox_info,
                public_destination_denial=public_destination_denial,
            )
    return classification


def classify_request(
    flow: http.HTTPFlow,
    *,
    registry_path: str,
    api_url: str,
    tls_admission: TlsAdmissionView | None,
    defer_unresolved_public_destination: bool = False,
) -> RequestClassification:
    """Classify a flow and write metadata needed by downstream hook handling.

    The decision order is registry/TLS admission, registered sandbox resolution,
    trusted authority validation, platform path admission, platform API allow,
    browser passthrough, fixed Gmail send restriction, firewall match, publicDestination validation,
    and default allow.

    After registry and TLS admission checks accept a registered sandbox,
    classification stores sandbox/run metadata on the flow. Once trusted authority
    validation succeeds, it stores the original URL, trusted authority host, and
    network log target. Browser passthrough detection also records its metadata
    marker. Header-phase callers that use this as a probe must snapshot and
    restore those metadata fields if they do not carry the classification
    forward.

    `defer_unresolved_public_destination` is for header-phase classification
    before the runtime endpoint may be fully known. A deferred `firewall_allow`
    still requires request-phase publicDestination revalidation before the flow
    is allowed to proceed.
    """
    return _classify_request(
        flow,
        registry_path=registry_path,
        api_url=api_url,
        tls_admission=tls_admission,
        trusted_authority=None,
        defer_unresolved_public_destination=defer_unresolved_public_destination,
    )


def classify_request_with_trusted_authority(
    flow: http.HTTPFlow,
    *,
    registry_path: str,
    api_url: str,
    tls_admission: TlsAdmissionView | None,
    trusted_authority: TrustedAuthority,
    defer_unresolved_public_destination: bool = False,
) -> RequestClassification:
    """Classify using authority validated from this unchanged synchronous flow.

    Call this only immediately after `get_trusted_authority(flow)`, without
    yielding or mutating request or SNI state. All other callers must use
    `classify_request()`.
    """
    return _classify_request(
        flow,
        registry_path=registry_path,
        api_url=api_url,
        tls_admission=tls_admission,
        trusted_authority=trusted_authority,
        defer_unresolved_public_destination=defer_unresolved_public_destination,
    )


def _classify_request(
    flow: http.HTTPFlow,
    *,
    registry_path: str,
    api_url: str,
    tls_admission: TlsAdmissionView | None,
    trusted_authority: TrustedAuthority | None,
    defer_unresolved_public_destination: bool,
) -> RequestClassification:
    client_peername = connection_endpoints.client_peername(flow.client_conn)
    client_ip = client_peername[0] if client_peername is not None else None

    if not client_ip:
        if tls_admission is not None:
            return StaleTlsAdmission(
                stale_tls_reason="client_ip_missing",
            )
        return NoClientIp()

    registry_state = registry.load_registry_state(registry_path)
    if isinstance(registry_state, registry.RegistryUnavailable):
        return RegistryUnavailable(
            registry_unavailable=registry_state,
        )

    if tls_admission is not None and tls_admission.client_ip != client_ip:
        return StaleTlsAdmission(
            stale_tls_reason="client_ip_mismatch",
        )

    sandbox_info = registry_state.sandboxes.get(client_ip)
    if sandbox_info is None:
        invalid_sandbox = registry_state.invalid_sandboxes.get(client_ip)
        if invalid_sandbox is not None:
            return InvalidRegistrySandbox(
                invalid_sandbox=invalid_sandbox,
            )
        if tls_admission is not None:
            return StaleTlsAdmission(
                stale_tls_reason="registry_entry_missing",
            )
        return PassThrough()

    run_id = sandbox_info.get("runId", "")
    if (
        tls_admission is not None
        and tls_admission.run_id is not None
        and tls_admission.run_id != run_id
    ):
        return StaleTlsAdmission(
            stale_tls_reason="run_id_mismatch",
        )

    _store_registered_request_metadata(flow, sandbox_info=sandbox_info, run_id=run_id)

    if is_browser_passthrough_heuristic(flow):
        flow.metadata[metadata_keys.BROWSER_USER_AGENT] = True

    if trusted_authority is None:
        try:
            trusted_authority = get_trusted_authority(flow)
        except AuthorityValidationError as e:
            return AuthorityDenied(
                sandbox_info=sandbox_info,
                authority_error=e,
            )

    original_url = trusted_authority.url
    _store_trusted_authority_metadata(
        flow,
        original_url=original_url,
        host=trusted_authority.host,
        port=trusted_authority.port,
    )

    if upstream_admission.api_destination_matches(
        api_url,
        scheme=flow.request.scheme,
        hostname=trusted_authority.host,
        port=trusted_authority.port,
    ):
        platform_path_decision = upstream_admission.platform_request_path_decision(
            flow.request.path
        )
        if platform_path_decision == "deny":
            return PlatformPathDenied(sandbox_info=sandbox_info)
        if platform_path_decision == "api_allow":
            return ApiAllow(sandbox_info=sandbox_info)

    if flow.metadata.get(metadata_keys.BROWSER_USER_AGENT):
        return BrowserAllow(sandbox_info=sandbox_info)

    if gmail_send.blocks_gmail_send(trusted_authority.host, flow.request.path):
        return GmailSendBlocked(sandbox_info=sandbox_info)

    is_asterisk_form = flow.request.path == "*"
    intent = connector_intent.from_flow(flow)
    omitted_builtin_firewalls = registry_state.omitted_builtin_firewalls.get(
        client_ip,
        frozenset(),
    )
    omitted_custom_connector_ids = registry_state.omitted_custom_connector_ids.get(
        client_ip,
        frozenset(),
    )
    if intent.status == "present" and (
        intent.value in omitted_builtin_firewalls or intent.value in omitted_custom_connector_ids
    ):
        return Allow(
            sandbox_info=sandbox_info,
            builtin_firewall_catalog_snapshot=(registry_state.builtin_firewall_catalog_snapshot),
            is_asterisk_form=is_asterisk_form,
        )

    compiled_firewalls = registry_state.compiled_firewalls.get(client_ip)
    compiled_network_policies = registry_state.compiled_network_policies[client_ip]
    if compiled_firewalls:
        result = matching.match_compiled_firewall_request(
            original_url,
            flow.request.method,
            compiled_firewalls,
            compiled_network_policies,
            intent,
            is_asterisk_form=is_asterisk_form,
        )
        if isinstance(result, matching.FirewallAmbiguous):
            return FirewallAmbiguous(
                sandbox_info=sandbox_info,
                firewall_ambiguous=result,
                builtin_firewall_catalog_snapshot=registry_state.builtin_firewall_catalog_snapshot,
            )
        if isinstance(result, matching.FirewallBlock):
            return FirewallBlock(
                sandbox_info=sandbox_info,
                firewall_block=result,
            )
        if isinstance(result, matching.FirewallAllow | matching.FirewallPolicyAllow):
            firewall_allow = (
                result.firewall_allow
                if isinstance(result, matching.FirewallPolicyAllow)
                else result
            )
            public_destination_denial = _public_destination_denial(
                flow,
                firewall_allow,
                trusted_authority_host=trusted_authority.host,
                defer_unresolved_hostnames=defer_unresolved_public_destination,
            )
            if public_destination_denial is not None:
                return PublicDestinationDenied(
                    sandbox_info=sandbox_info,
                    public_destination_denial=public_destination_denial,
                )
            if isinstance(result, matching.FirewallPolicyAllow):
                return FirewallPolicyAllow(
                    sandbox_info=sandbox_info,
                    firewall_allow=firewall_allow,
                )
            return FirewallAllow(
                sandbox_info=sandbox_info,
                firewall_allow=firewall_allow,
                builtin_firewall_catalog_snapshot=(
                    registry_state.builtin_firewall_catalog_snapshot
                ),
            )

    return Allow(
        sandbox_info=sandbox_info,
        builtin_firewall_catalog_snapshot=registry_state.builtin_firewall_catalog_snapshot,
        is_asterisk_form=is_asterisk_form,
    )


def classification_needs_request_timing(classification: RequestClassification) -> bool:
    return classification.kind in (
        "authority_denied",
        "api_allow",
        "platform_path_denied",
        "browser_allow",
        "gmail_send_blocked",
        "firewall_ambiguous",
        "firewall_block",
        "firewall_allow",
        "firewall_policy_allow",
        "public_destination_denied",
        "allow",
    )


def should_stream_capture_request(classification: RequestClassification) -> bool:
    if not isinstance(classification, ApiAllow | BrowserAllow | FirewallPolicyAllow | Allow):
        return False
    return bool(classification.sandbox_info.get("captureNetworkBodies", False))


def should_try_firewall_stream_capture_request(classification: RequestClassification) -> bool:
    if not isinstance(classification, FirewallAllow):
        return False
    allow = classification.firewall_allow
    if firewall_allow_uses_public_destination(allow):
        return False
    return bool(classification.sandbox_info.get("captureNetworkBodies", False))


def firewall_allow_uses_public_destination(allow: matching.FirewallAllow) -> bool:
    host_policy = allow.api_entry.get("hostPolicy")
    return isinstance(host_policy, dict) and host_policy.get("kind") == "publicDestination"


def current_public_destination_denial(
    flow: http.HTTPFlow,
    allow: matching.FirewallAllow,
    *,
    defer_unresolved_hostnames: bool = False,
) -> PublicDestinationDenial | None:
    """Revalidate an existing firewall allow against the current runtime destination.

    Header-phase publicDestination checks may defer unresolved runtime hostnames
    until the request phase can observe the final destination. Callers must opt
    into that header-phase behavior explicitly.
    """

    trusted_authority_host = flow_metadata.trusted_authority_host(flow.metadata)
    if not trusted_authority_host:
        try:
            trusted_authority_host = get_trusted_authority(flow).host
        except AuthorityValidationError:
            trusted_authority_host = ""
    return _public_destination_denial(
        flow,
        allow,
        trusted_authority_host=trusted_authority_host,
        defer_unresolved_hostnames=defer_unresolved_hostnames,
    )


def is_browser_passthrough_heuristic(flow: http.HTTPFlow) -> bool:
    # Short-term business passthrough heuristic for browser-originated traffic.
    # This is not trusted browser provenance: any sandbox client can set this
    # header. The spoofable User-Agent heuristic is currently accepted as a
    # known tradeoff until runner-owned browser provenance is prioritized again.
    user_agent_bytes = 0
    has_user_agent = False
    for name, value in flow.request.headers.fields:
        if name.lower() != b"user-agent":
            continue
        if has_user_agent:
            user_agent_bytes += len(b", ")
        user_agent_bytes += len(value)
        if user_agent_bytes > _MAX_BROWSER_USER_AGENT_BYTES:
            return False
        has_user_agent = True

    if not has_user_agent:
        return False

    user_agent = flow.request.headers.get("User-Agent")
    if not user_agent:
        return False

    normalized = f" {user_agent.lower()}"
    return "mozilla/" in normalized and any(
        marker in normalized for marker in _BROWSER_USER_AGENT_MARKERS
    )


def restore_request_headers_probe_metadata(
    flow: http.HTTPFlow,
    snapshot: dict[str, object],
    *,
    extra_keys: tuple[str, ...] = (),
) -> None:
    """Restore metadata after a requestheaders classification probe.

    `REQUEST_HEADERS_PROBE_METADATA_KEYS` covers the metadata touched by this
    module and adjacent requestheaders processing that depends on the
    classification result. `extra_keys` lets callers restore companion probe
    metadata owned by other modules, such as connector diagnostics.
    """

    for key in (*REQUEST_HEADERS_PROBE_METADATA_KEYS, *extra_keys):
        if key in snapshot:
            flow.metadata[key] = snapshot[key]
        else:
            flow.metadata.pop(key, None)


def _store_registered_request_metadata(
    flow: http.HTTPFlow,
    *,
    sandbox_info: dict,
    run_id: str,
) -> None:
    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = run_id
    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = sandbox_info.get("networkLogPath", "")
    flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH] = sandbox_info.get("proxyLogPath", "")
    flow.metadata[metadata_keys.CAPTURE_BODY] = sandbox_info.get("captureNetworkBodies", False)
    flow.metadata[metadata_keys.SANDBOX_AUTH_KEY] = sandbox_info.get("sandboxToken", "")
    flow.metadata[metadata_keys.CLI_AGENT_TYPE] = sandbox_info["cliAgentType"]


def _store_trusted_authority_metadata(
    flow: http.HTTPFlow,
    *,
    original_url: str,
    host: str,
    port: int,
) -> None:
    flow.metadata[metadata_keys.ORIGINAL_URL] = original_url
    flow.metadata[metadata_keys.TRUSTED_AUTHORITY_HOST] = host
    http_network_log.set_target(
        flow,
        url=original_url,
        host=host,
        port=port,
    )


def _public_destination_denial(
    flow: http.HTTPFlow,
    allow: matching.FirewallAllow,
    *,
    trusted_authority_host: str,
    defer_unresolved_hostnames: bool = False,
) -> PublicDestinationDenial | None:
    host_policy = allow.api_entry.get("hostPolicy")
    if not isinstance(host_policy, dict) or host_policy.get("kind") != "publicDestination":
        return None

    validation = _public_destination_runtime_denial(
        flow,
        defer_unresolved_hostnames=defer_unresolved_hostnames,
    )
    if validation is None:
        return None

    raw_base = allow.api_entry.get("base", "")
    base = raw_base if isinstance(raw_base, str) else ""
    if validation.reason is None:
        raise RuntimeError("publicDestination denial is missing a reason")
    return PublicDestinationDenial(
        name=allow.name,
        base=base,
        trusted_authority_host=trusted_authority_host,
        destination_host=validation.destination_host,
        reason=validation.reason,
    )


def _public_destination_runtime_denial(
    flow: http.HTTPFlow,
    *,
    defer_unresolved_hostnames: bool = False,
) -> public_destination.RuntimeDestinationCheck | None:
    classifications: _PublicDestinationClassifications = {}
    for classification in _public_destination_runtime_hosts(flow, classifications):
        validation = classification.validation
        if (
            not validation.allowed
            and defer_unresolved_hostnames
            and classification.deferable_hostname
        ):
            continue
        if not validation.allowed:
            return validation
    return None


def _public_destination_runtime_host_classification(
    runtime_host: object,
    classifications: _PublicDestinationClassifications,
) -> public_destination.RuntimeDestinationHostClassification:
    if not isinstance(runtime_host, str):
        return public_destination.classify_runtime_destination_host(runtime_host)

    classification = classifications.get(runtime_host)
    if classification is None:
        classification = public_destination.classify_runtime_destination_host(runtime_host)
        classifications[runtime_host] = classification
    return classification


def _public_destination_runtime_hosts(
    flow: http.HTTPFlow,
    classifications: _PublicDestinationClassifications,
) -> tuple[public_destination.RuntimeDestinationHostClassification, ...]:
    original_address = upstream_destination_binding.server_binding_original_address(
        flow.server_conn
    )

    if flow.server_conn.connected:
        hosts = _public_destination_original_and_request_hosts(
            flow,
            original_address,
            classifications,
        )
        hosts.extend(_public_destination_connected_runtime_hosts(flow, classifications))
        return tuple(hosts)

    if original_address is not None:
        return tuple(
            _public_destination_original_and_request_hosts(
                flow,
                original_address,
                classifications,
            )
        )

    server_address = connection_endpoints.server_address(flow.server_conn)
    if server_address is not None:
        return (
            _public_destination_runtime_host_classification(
                _public_destination_endpoint_host_for_request(flow, server_address),
                classifications,
            ),
        )

    return (
        _public_destination_runtime_host_classification(
            flow.request.host,
            classifications,
        ),
    )


def _public_destination_endpoint_host_for_request(
    flow: http.HTTPFlow,
    endpoint: tuple[str, int],
) -> str | None:
    endpoint_host, endpoint_port = endpoint
    if endpoint_port != flow.request.port:
        return None
    return endpoint_host


def _public_destination_original_and_request_hosts(
    flow: http.HTTPFlow,
    original_address: tuple[str, int] | None,
    classifications: _PublicDestinationClassifications,
) -> list[public_destination.RuntimeDestinationHostClassification]:
    hosts: list[public_destination.RuntimeDestinationHostClassification] = []
    if original_address is not None:
        endpoint_host = _public_destination_endpoint_host_for_request(flow, original_address)
        endpoint_classification = _public_destination_runtime_host_classification(
            endpoint_host,
            classifications,
        )
        if (
            endpoint_host is None
            or not endpoint_classification.is_hostname
            or not flow.server_conn.connected
        ):
            hosts.append(endpoint_classification)
    request_classification = _public_destination_runtime_host_classification(
        flow.request.host,
        classifications,
    )
    if not request_classification.is_hostname:
        hosts.append(request_classification)
    return hosts


def _public_destination_connected_runtime_hosts(
    flow: http.HTTPFlow,
    classifications: _PublicDestinationClassifications,
) -> tuple[public_destination.RuntimeDestinationHostClassification, ...]:
    hosts: list[public_destination.RuntimeDestinationHostClassification] = []
    for endpoint in (
        connection_endpoints.server_peername(flow.server_conn),
        connection_endpoints.server_address(flow.server_conn),
    ):
        if endpoint is None:
            continue

        endpoint_host, endpoint_port = endpoint
        classification = _public_destination_runtime_host_classification(
            endpoint_host,
            classifications,
        )
        if classification.is_hostname:
            continue

        if endpoint_port != flow.request.port:
            hosts.append(
                _public_destination_runtime_host_classification(
                    None,
                    classifications,
                )
            )
            continue

        hosts.append(classification)

    if hosts:
        return tuple(hosts)

    connected_endpoint = connection_endpoints.connected_ip_destination_endpoint(
        flow.server_conn,
        port=flow.request.port,
        extra_endpoints=(connection_endpoints.connection_sockname(flow.client_conn),),
    )
    return (
        _public_destination_runtime_host_classification(
            connected_endpoint.address[0] if connected_endpoint is not None else None,
            classifications,
        ),
    )
