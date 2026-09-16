"""Local HTTP response construction for mitm addon request hook outcomes."""

import json
import urllib.parse
from collections.abc import Callable
from typing import Final

from mitmproxy import http

import builtin_host_policy
import flow_metadata
import flow_metadata_keys as metadata_keys
import http_network_log
import matching
import registry
from logging_utils import log_proxy_entry
from request_authority import AuthorityValidationError
from runtime_url_parsing import split_runtime_url, strip_url_query_and_fragment

_BUILTIN_HOST_POLICY_DENIED_ERROR: Final = "builtin_host_policy_denied"
_AMBIGUOUS_CONNECTOR_ROUTE_ERROR: Final = "ambiguous_connector_route"
_FIREWALL_AUTHORIZATION_CHANGED_ERROR: Final = "firewall_authorization_changed"
_STALE_TLS_ADMISSION_ERROR: Final = "stale_tls_admission"
_UNSAFE_PLATFORM_PATH_ERROR: Final = "unsafe_platform_path"
_UPSTREAM_DESTINATION_UNBOUND_ERROR: Final = "upstream_destination_unbound"
_HTTP_STATUS_CONFLICT = 409


def _diagnostic_url_without_query_or_fragment(original_url: str) -> str:
    retained_url = strip_url_query_and_fragment(original_url)
    parts = split_runtime_url(retained_url)
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


def apply_synthetic_json_response_content(
    flow: http.HTTPFlow,
    response: http.Response,
    content_factory: Callable[[], bytes],
) -> bytes:
    """Apply method-aware JSON content framing to a synthetic response."""
    is_head_request = flow.request.method.upper() == "HEAD"
    content = b"" if is_head_request else content_factory()
    response.content = content
    response.headers["Content-Type"] = "application/json"
    if is_head_request:
        del response.headers["Content-Length"]
    return content


def make_local_json_response(
    flow: http.HTTPFlow,
    status_code: int,
    body: dict[str, object],
) -> http.Response:
    response = http.Response.make(status_code)
    apply_synthetic_json_response_content(
        flow,
        response,
        lambda: json.dumps(body).encode(),
    )
    return response


def block_authority_validation_error(
    flow: http.HTTPFlow,
    error: AuthorityValidationError,
) -> None:
    proxy_log_path = flow_metadata.proxy_log_path(flow.metadata)
    flow.metadata[metadata_keys.ORIGINAL_URL] = error.fallback_url
    http_network_log.set_target_from_url(flow, error.fallback_url)
    flow_metadata.set_firewall_decision(flow.metadata, "DENY", error=error.reason)

    log_proxy_entry(
        proxy_log_path,
        "warn",
        error.message,
        type="authority_validation",
        reason=error.reason,
        sni=error.sni,
        request_host=error.request_host,
        host_header=error.host_header,
        request_port=error.request_port,
    )

    flow.response = make_local_json_response(
        flow,
        403,
        {
            "error": error.reason,
            "message": error.message,
            "sni": error.sni,
            "request_host": error.request_host,
            "host_header": error.host_header,
            "request_port": error.request_port,
        },
    )


def block_registry_unavailable(
    flow: http.HTTPFlow,
    unavailable: registry.RegistryUnavailable,
) -> None:
    """Block the flow with a fail-closed 503 response for an unavailable registry.

    The JSON response contains the fixed ``registry_unavailable`` error, the
    fixed user-visible ``message`` ``Proxy registry is unavailable``, and the
    ``reason`` copied from ``RegistryUnavailable.reason``. The response message
    is intentionally distinct from ``RegistryUnavailable.message``, which
    remains detailed internal failure context.
    """
    flow_metadata.set_firewall_decision(
        flow.metadata,
        "BLOCK",
        error="registry_unavailable",
    )
    flow.response = make_local_json_response(
        flow,
        503,
        {
            "error": "registry_unavailable",
            "message": "Proxy registry is unavailable",
            "reason": unavailable.reason,
        },
    )


def block_invalid_registry_sandbox(
    flow: http.HTTPFlow,
    invalid_sandbox: registry.InvalidSandboxEntry,
) -> None:
    """Block a flow for an invalid registry sandbox with a fail-closed 503.

    The JSON response contains the fixed ``invalid_registry_sandbox`` error,
    ``message`` copied verbatim from ``InvalidSandboxEntry.message``, and
    ``reason`` copied verbatim from ``InvalidSandboxEntry.reason``. The reason
    is the stable category; the message is detailed validation text for the
    individual sandbox entry.
    """
    flow_metadata.set_firewall_decision(
        flow.metadata,
        "BLOCK",
        error="invalid_registry_sandbox",
    )
    flow.response = make_local_json_response(
        flow,
        503,
        {
            "error": "invalid_registry_sandbox",
            "message": invalid_sandbox.message,
            "reason": invalid_sandbox.reason,
        },
    )


def block_stale_tls_admission(flow: http.HTTPFlow, *, reason: str) -> None:
    flow_metadata.set_firewall_decision(
        flow.metadata,
        "BLOCK",
        error=_STALE_TLS_ADMISSION_ERROR,
    )
    flow.response = make_local_json_response(
        flow,
        503,
        {
            "error": _STALE_TLS_ADMISSION_ERROR,
            "message": (
                "Request blocked: TLS admission is no longer backed by a valid "
                "proxy registry sandbox"
            ),
            "reason": reason,
        },
    )


def block_platform_path_denied(flow: http.HTTPFlow) -> None:
    message = "Request blocked: unsafe platform API path"
    proxy_log_path = flow_metadata.proxy_log_path(flow.metadata)
    log_proxy_entry(
        proxy_log_path,
        "warn",
        message,
        type="platform_path_admission",
        reason=_UNSAFE_PLATFORM_PATH_ERROR,
    )
    flow_metadata.set_firewall_decision(
        flow.metadata,
        "BLOCK",
        error=_UNSAFE_PLATFORM_PATH_ERROR,
    )
    flow.response = make_local_json_response(
        flow,
        403,
        {
            "error": _UNSAFE_PLATFORM_PATH_ERROR,
            "message": message,
        },
    )


def block_firewall_authorization_changed(
    flow: http.HTTPFlow,
    *,
    current_decision: str,
) -> None:
    proxy_log_path = flow_metadata.proxy_log_path(flow.metadata)
    log_proxy_entry(
        proxy_log_path,
        "warn",
        "Request blocked: firewall authorization changed while credentials were resolving",
        type="firewall_authorization",
        current_decision=current_decision,
    )
    flow_metadata.set_firewall_decision(
        flow.metadata,
        "BLOCK",
        error=_FIREWALL_AUTHORIZATION_CHANGED_ERROR,
    )
    flow.response = make_local_json_response(
        flow,
        _HTTP_STATUS_CONFLICT,
        {
            "error": _FIREWALL_AUTHORIZATION_CHANGED_ERROR,
            "message": (
                "Request blocked: firewall authorization changed while credentials were resolving"
            ),
        },
    )


def block_upstream_destination_unbound(
    flow: http.HTTPFlow,
    *,
    reason: str,
    server_address: object,
    diagnostics: dict[str, object],
) -> None:
    trusted_host = flow_metadata.trusted_authority_host(flow.metadata)
    proxy_log_path = flow_metadata.proxy_log_path(flow.metadata)
    log_proxy_entry(
        proxy_log_path,
        "warn",
        "Request blocked: upstream destination is not bound to the trusted authority",
        type="upstream_destination_binding",
        reason=reason,
        trusted_host=trusted_host,
        request_host=flow.request.host,
        request_port=flow.request.port,
        server_address=server_address,
        diagnostics=diagnostics,
    )
    flow_metadata.set_firewall_decision(
        flow.metadata,
        "BLOCK",
        error=_UPSTREAM_DESTINATION_UNBOUND_ERROR,
    )
    body: dict[str, object] = {
        "error": _UPSTREAM_DESTINATION_UNBOUND_ERROR,
        "message": "Request blocked: upstream destination is not bound to trusted authority",
        "reason": reason,
        "trusted_host": trusted_host,
        "request_host": flow.request.host,
        "request_port": flow.request.port,
    }
    firewall_base = flow_metadata.firewall_base(flow.metadata)
    if firewall_base:
        body["base"] = firewall_base
    flow.response = make_local_json_response(
        flow,
        403,
        body,
    )


def block_builtin_host_policy_denied(
    flow: http.HTTPFlow,
    *,
    allow: matching.FirewallAllow,
    error: builtin_host_policy.BuiltinRuntimeHostPolicyError,
    upstream_endpoint: str,
) -> None:
    proxy_log_path = flow_metadata.proxy_log_path(flow.metadata)
    trusted_host = flow_metadata.trusted_authority_host(flow.metadata)
    log_proxy_entry(
        proxy_log_path,
        "warn",
        "Request blocked: builtin firewall host policy rejected credential injection",
        type="builtin_host_policy",
        name=allow.name,
        reason=error.reason,
        trusted_host=trusted_host,
        request_port=flow.request.port,
        upstream_endpoint=upstream_endpoint,
    )
    flow_metadata.set_firewall_decision(
        flow.metadata,
        "BLOCK",
        error=_BUILTIN_HOST_POLICY_DENIED_ERROR,
    )
    body: dict[str, object] = {
        "error": _BUILTIN_HOST_POLICY_DENIED_ERROR,
        "message": "Request blocked: builtin firewall host policy rejected credential injection",
        "reason": error.reason,
        "name": allow.name,
        "trusted_host": trusted_host,
        "request_port": flow.request.port,
    }
    firewall_base = flow_metadata.firewall_base(flow.metadata)
    if firewall_base:
        body["base"] = firewall_base
    flow.response = make_local_json_response(
        flow,
        403,
        body,
    )


def block_gmail_send(flow: http.HTTPFlow) -> None:
    error_code = "gmail_send_blocked"
    flow_metadata.set_firewall_decision(flow.metadata, "DENY", error=error_code)
    flow.response = make_local_json_response(
        flow,
        403,
        {
            # Gmail SDKs extract error.message when rendering an HTTP failure.
            "error": {
                "code": 403,
                "status": "PERMISSION_DENIED",
                "errors": [{"domain": "okou", "reason": error_code}],
                "message": (
                    "Direct Gmail API sending and Gmail batch requests are disabled. "
                    "Use okou mail draft --file <message.eml> to create a Gmail draft "
                    "(see okou mail draft --help). If a draft already exists, reuse it. "
                    "In Web chat, run okou mail link <gmail-draft-id> and return the review URL "
                    "so the user can review and send. Outside Web chat, ask the user to review "
                    "and send the draft in Gmail. Permission grants cannot unblock direct sending. "
                    "For batch reads or draft edits, use individual API requests."
                ),
            },
        },
    )


def set_firewall_block_response(flow: http.HTTPFlow, result: matching.FirewallBlock) -> None:
    proxy_log_path = flow_metadata.proxy_log_path(flow.metadata)
    if result.reason == "malformed_network_policy":
        block_message = "malformed network policy"
        response_message = "Request blocked: malformed network policy"
    elif result.reason == "unsafe_path":
        block_message = "unsafe path"
        response_message = "Request blocked: unsafe path"
    else:
        block_message = "no matching permission"
        response_message = "Request blocked: no matching permission rule"
    log_proxy_entry(
        proxy_log_path,
        "warn",
        f"Firewall {result.name}: {block_message} for {result.method} {result.path}",
        type="firewall_block",
        name=result.name,
        reason=result.reason,
    )
    flow_metadata.set_firewall_decision(flow.metadata, "DENY")
    flow.metadata[metadata_keys.FIREWALL_BASE] = result.base
    flow.metadata[metadata_keys.FIREWALL_NAME] = result.name
    flow.metadata[metadata_keys.FIREWALL_PERMISSION] = (
        result.permissions[0] if len(result.permissions) == 1 else ""
    )
    original_url = flow.metadata[metadata_keys.ORIGINAL_URL]
    diagnostic_url = _diagnostic_url_without_query_or_fragment(original_url)
    flow.response = make_local_json_response(
        flow,
        403,
        {
            "error": "permission_denied",
            "message": response_message,
            "method": result.method,
            "path": result.path,
            "url": diagnostic_url,
            "name": result.name,
            "permissions": list(result.permissions),
            "reason": result.reason,
            "base": result.base,
        },
    )


def set_firewall_ambiguous_response(
    flow: http.HTTPFlow,
    result: matching.FirewallAmbiguous,
) -> None:
    """Return a local conflict before any connector credential is selected."""
    proxy_log_path = flow_metadata.proxy_log_path(flow.metadata)
    candidates = list(result.candidates)
    log_proxy_entry(
        proxy_log_path,
        "warn",
        f"Ambiguous connector route for {result.method} {result.path}",
        type="firewall_ambiguous",
        reason=result.reason,
        candidates=candidates,
    )
    flow_metadata.set_firewall_decision(
        flow.metadata,
        "DENY",
        error=_AMBIGUOUS_CONNECTOR_ROUTE_ERROR,
    )
    flow.metadata[metadata_keys.CONNECTOR_ROUTE_REASON] = result.reason
    flow.metadata[metadata_keys.CONNECTOR_ROUTE_CANDIDATES] = candidates
    original_url = flow.metadata[metadata_keys.ORIGINAL_URL]
    diagnostic_url = _diagnostic_url_without_query_or_fragment(original_url)
    flow.response = make_local_json_response(
        flow,
        _HTTP_STATUS_CONFLICT,
        {
            "error": _AMBIGUOUS_CONNECTOR_ROUTE_ERROR,
            "message": "Request blocked: connector route requires explicit intent",
            "reason": result.reason,
            "method": result.method,
            "path": result.path,
            "url": diagnostic_url,
            "candidates": candidates,
        },
    )


def block_public_destination_denied(
    flow: http.HTTPFlow,
    *,
    name: str,
    base: str,
    destination_host: str,
    trusted_authority_host: str,
    reason: str,
    send_response: bool = True,
) -> None:
    """Record a public-destination denial and optionally install its local response.

    Both modes disable request streaming, record the DENY decision with the
    ``unsafe_public_destination`` error and firewall base/name, and emit the redacted
    public-destination proxy warning. When ``send_response`` is ``True``, this also installs
    the JSON HTTP 403 response. When it is ``False``, the function leaves ``flow.response``
    unchanged and does not terminate the flow; the caller must terminate it and prevent
    later request dispatch.
    """
    proxy_log_path = flow_metadata.proxy_log_path(flow.metadata)
    flow.request.stream = False
    flow_metadata.set_firewall_decision(
        flow.metadata,
        "DENY",
        error="unsafe_public_destination",
    )
    flow.metadata[metadata_keys.FIREWALL_BASE] = base
    flow.metadata[metadata_keys.FIREWALL_NAME] = name

    log_proxy_entry(
        proxy_log_path,
        "warn",
        "Request blocked: publicDestination resolved to a non-public destination",
        type="public_destination",
        name=name,
        firewall_base=base,
        destination_host=destination_host,
        trusted_authority_host=trusted_authority_host,
        reason=reason,
    )

    if send_response:
        flow.response = make_local_json_response(
            flow,
            403,
            {
                "error": "unsafe_public_destination",
                "message": (
                    "Request blocked: publicDestination resolved to a non-public destination"
                ),
                "name": name,
                "base": base,
                "destination_host": destination_host,
                "trusted_authority_host": trusted_authority_host,
                "reason": reason,
            },
        )
