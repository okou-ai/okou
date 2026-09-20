#!/usr/bin/env python3
"""
mitmproxy addon for the Okou runner-level network proxy.

This addon runs on the runner HOST (not inside sandboxes) and:
1. Intercepts all HTTPS requests from sandboxes
2. Looks up the source sandbox's runId from the proxy registry
3. Injects auth headers for configured firewall rules (proxy-side token replacement)
4. Logs network activity per-run to JSONL files
5. Reports model-provider failures plus model-provider and connector usage
6. Participates in runner-triggered webhook delivery drain before proxy shutdown
"""

import asyncio
import base64
import binascii
import os
import tempfile
from collections.abc import Awaitable
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, NoReturn

from mitmproxy import connection, ctx, http, tcp, tls
from mitmproxy.addonmanager import Loader

import addon_process_logging

# --- Sub-module imports ---
#
# auth_base_forwarder/body_capture/connector_diagnostics/connector_intent/content_length/
# http_header_syntax/matching/model_provider_failure/model_websocket_usage/registry/
# response_encoding_negotiation/
# response_streaming/
# runner_flush_lifecycle/terminal_usage/upstream_admission/usage/websocket_framing/
# websocket_retention are imported
# by module (not selective `from X import ...`) so that:
#   1. Cross-module calls read as ``auth_base_forwarder.X(...)`` /
#      ``body_capture.X(...)`` / ``connector_diagnostics.X(...)`` /
#      ``connector_intent.X(...)`` /
#      ``content_length.X(...)`` /
#      ``matching.X(...)`` / ``model_provider_failure.X(...)`` /
#      ``model_websocket_usage.X(...)`` / ``registry.X(...)`` /
#      ``response_streaming.X(...)`` / ``runner_flush_lifecycle.X(...)`` /
#      ``terminal_usage.X(...)`` /
#      ``upstream_admission.X(...)`` / ``usage.X(...)`` /
#      ``websocket_framing.X(...)`` / ``websocket_retention.X(...)``, making the
#      module boundary visible at call sites.
#   2. Tests can patch names on the owning module object and affect all
#      callers — no mock-placement pitfalls from copied function bindings.
import auth_base_forwarder
import aws_sigv4_body_admission
import aws_sigv4_hash_executor
import body_capture
import builtin_host_policy
import codex_model_catalog_cache
import codex_output_timing
import connector_diagnostics
import connector_intent
import content_length
import flow_metadata
import flow_metadata_keys as metadata_keys
import http_header_syntax
import http_local_responses
import http_network_log
import matching
import mitmproxy_compat
import model_provider_failure
import model_websocket_usage
import platform_api
import registry
import registry_control
import request_classification
import request_streaming
import response_encoding_negotiation
import response_streaming
import run_usage
import runner_control
import runner_flush_lifecycle
import tcp_logging
import terminal_usage
import upstream_admission
import upstream_destination_binding
import usage
import websocket_framing
import websocket_retention
from auth import (
    FirewallAuthHandlingResult,
    FirewallHeaderPhaseAuthResult,
    aws_sigv4_request_requires_body_for_signing,
    handle_firewall_request,
    is_billable_firewall,
    mark_auth_base_forwarding_saturated,
    mark_auth_base_request_length_required,
    mark_auth_base_request_too_large,
    mark_aws_sigv4_request_admission_saturated,
    mark_aws_sigv4_request_length_required,
    mark_aws_sigv4_request_too_large,
    prepare_firewall_metadata,
    release_aws_sigv4_request_inspection,
    try_apply_stream_safe_firewall_auth_for_requestheaders,
)
from body_limits import STREAM_BUFFER_LIMIT
from firewall_auth_cache import (
    FirewallAuthCacheEntryIdentity,
    FirewallAuthCacheKey,
    invalidate_cached_firewall_headers,
)
from firewall_auth_config import auth_config_injects_ordinary_upstream_credentials
from logging_utils import (
    NETWORK_LOG_MAX_SAFE_SIZE,
    add_firewall_metadata,
    elapsed_ms,
    log_http_network_entry,
    log_proxy_entry,
    project_url_for_proxy_log,
    shutdown_log_writer,
)
from request_authority import AuthorityValidationError, TrustedAuthority, get_trusted_authority

# HTTP status boundaries used in response-phase classification.
_HTTP_STATUS_UNAUTHORIZED = 401
_HTTP_STATUS_BAD_GATEWAY = 502
_HTTP_STATUS_ERROR_MIN = 400  # inclusive: start of 4xx/5xx error range
# Request-header phase state.
# Creator: requestheaders() and header-phase stream/auth helpers.
# Consumer: request() and terminal cleanup.
# Release: auth marker is popped by terminal cleanup.
# _REQUEST_HEADERS_TERMINATED is a flow-local sentinel for request() early exit.
# Match the existing 64 KiB HTTP/2/SigV4 minimum per-field accounting budget.
_MAX_REQUEST_HEADER_FIELDS = 2048
_MAX_REQUEST_HEADER_NAME_BYTES = 4096
_REQUEST_HEADERS_TERMINATED = "_request_headers_terminated"
_FIREWALL_AUTH_APPLIED_IN_REQUESTHEADERS = "_firewall_auth_applied_in_requestheaders"
_STALE_FIREWALL_AUTHORIZATION_METADATA_KEYS = (
    metadata_keys.FIREWALL_BASE,
    metadata_keys.FIREWALL_API_ID,
    metadata_keys.FIREWALL_AUTH_CACHE_KEY,
    metadata_keys.FIREWALL_AUTH_CACHE_ENTRY_IDENTITY,
    metadata_keys.FIREWALL_NAME,
    metadata_keys.FIREWALL_PERMISSION,
    metadata_keys.FIREWALL_RULE_MATCH,
    metadata_keys.FIREWALL_PARAMS,
    metadata_keys.FIREWALL_BILLABLE,
    metadata_keys.FIREWALL_ACTION,
    metadata_keys.FIREWALL_ERROR,
    metadata_keys.CONNECTOR_ROUTE_REASON,
    metadata_keys.CONNECTOR_ROUTE_CANDIDATES,
    metadata_keys.AUTH_RESOLVED_SECRETS,
    metadata_keys.AUTH_REFRESHED_CONNECTORS,
    metadata_keys.AUTH_REFRESHED_SECRETS,
    metadata_keys.AUTH_CACHE_HIT,
    metadata_keys.AUTH_URL_REWRITE,
    metadata_keys.MODEL_USAGE_PROVIDER,
)

_AUTH_BASE_BODYLESS_METHODS = frozenset(("GET", "HEAD"))
_HTTP_RESPONSE_BODYLESS_METHODS = frozenset(("CONNECT", "HEAD"))
_WEBSOCKET_KEY_BYTES = 16
_WEBSOCKET_KEY_BASE64_BYTES = 24
_WEBSOCKET_HANDSHAKE_HEADER_WORK_LIMIT = 8 * 1024
_BufferedRequestBodyCheckKind = Literal["ok", "too_large", "length_required"]


@dataclass(frozen=True)
class _BufferedRequestBodyCheck:
    kind: _BufferedRequestBodyCheckKind
    observed_size: int = 0
    reason: str = ""


# ============================================================================
# Addon Configuration
# ============================================================================


def load(loader: Loader) -> None:
    """Initialize compatibility and process-global state before addon options.

    Exact-version mitmproxy and wsproto compatibility is installed first. An
    unreviewed runtime raises ``RuntimeError`` before custom options are registered.
    """
    mitmproxy_compat.install_runtime_compatibility()
    loader.add_option(
        name="okou_api_url",
        typespec=str,
        default="https://api.okou.ai",
        help="Okou API URL for proxy endpoint",
    )
    loader.add_option(
        name="okou_proxy_registry_path",
        typespec=str,
        # This default is a placeholder shown in `mitmdump --help`; the runner
        # always passes `--set okou_proxy_registry_path=<per-runner path>` (see
        # `proxy::process::spawn_mitmdump` in
        # `crates/runner/src/proxy/process.rs`), so the default is never used in
        # production. Computed via tempfile.gettempdir() so that standalone
        # debugging works on platforms where /tmp is not the system temp dir.
        default=str(Path(tempfile.gettempdir()) / "proxy-registry.json"),
        help="Path to proxy registry file",
    )
    loader.add_option(
        name="okou_builtin_firewall_catalog_cache_path",
        typespec=str,
        default=str(Path(tempfile.gettempdir()) / "builtin-firewall-catalog-cache.json"),
        help="Path to runner builtin firewall catalog cache file",
    )
    loader.add_option(
        name="okou_usage_state_id",
        typespec=str,
        default="",
        help="Runner-generated addon control generation",
    )
    loader.add_option(
        name="okou_control_socket_dir",
        typespec=str,
        default="",
        help="Runner-owned private launch directory for the control socket",
    )
    loader.add_option(
        name="okou_client_session_id",
        typespec=str,
        default="",
        help="Runner-generated client session id for platform API requests",
    )
    loader.add_option(
        name="okou_client_version",
        typespec=str,
        default="",
        help="Runner package version for platform API request attribution",
    )
    loader.add_option(
        name="okou_usage_flush_interval_seconds",
        typespec=float,
        default=usage.DEFAULT_FLUSH_INTERVAL_SECONDS,
        help="Usage-event buffer flush interval in seconds",
    )


def configure(updated: set[str]) -> None:
    platform_api.configure_client_headers(
        client_session_id=ctx.options.okou_client_session_id,
        client_version=ctx.options.okou_client_version,
    )
    model_provider_failure.configure_reporting(
        api_url=get_api_url(),
        bearer_credential=os.environ.get(model_provider_failure.RUNNER_AUTH_ENV, ""),
    )
    if "okou_usage_flush_interval_seconds" in updated:
        usage.configure_usage_buffer(
            flush_interval_seconds=ctx.options.okou_usage_flush_interval_seconds
        )


_runner_control: runner_control.ControlServer | None = None
_registry_control: registry_control.RegistryControl | None = None


def running() -> None:
    global _runner_control, _registry_control

    control_dir = ctx.options.okou_control_socket_dir
    usage_state_id = ctx.options.okou_usage_state_id
    run_usage.initialize(usage_state_id or None)
    if control_dir and usage_state_id:
        registry_owner = registry_control.RegistryControl(
            asyncio.get_running_loop(), get_registry_path()
        )
        control = runner_control.ControlServer(
            Path(control_dir),
            usage_state_id,
            registry_owner,
            runner_flush_lifecycle.DeliveryControl(),
            usage_snapshot=run_usage.snapshot,
        )
        control.start()
        _registry_control = registry_owner
        _runner_control = control


def get_api_url() -> str:
    """Get API URL from options."""
    return ctx.options.okou_api_url


def get_registry_path() -> str:
    """Get registry path from options."""
    return ctx.options.okou_proxy_registry_path


def _request_headers_probe_metadata_keys() -> tuple[str, ...]:
    return (
        *request_classification.REQUEST_HEADERS_PROBE_METADATA_KEYS,
        *connector_intent.REQUEST_HEADERS_PROBE_METADATA_KEYS,
    )


def _classify_request_for_flow(
    flow: http.HTTPFlow,
    *,
    defer_unresolved_public_destination: bool = False,
) -> request_classification.RequestClassification:
    return request_classification.classify_request(
        flow,
        registry_path=get_registry_path(),
        api_url=get_api_url(),
        tls_admission=upstream_admission.tls_admission_for_client(flow.client_conn),
        defer_unresolved_public_destination=defer_unresolved_public_destination,
    )


def _classify_request_for_flow_with_trusted_authority(
    flow: http.HTTPFlow,
    *,
    trusted_authority: TrustedAuthority,
    defer_unresolved_public_destination: bool = False,
) -> request_classification.RequestClassification:
    return request_classification.classify_request_with_trusted_authority(
        flow,
        registry_path=get_registry_path(),
        api_url=get_api_url(),
        tls_admission=upstream_admission.tls_admission_for_client(flow.client_conn),
        trusted_authority=trusted_authority,
        defer_unresolved_public_destination=defer_unresolved_public_destination,
    )


def _request_classification_for_flow(
    flow: http.HTTPFlow,
) -> request_classification.RequestClassification:
    return request_classification.classification_for_request(
        flow,
        registry_path=get_registry_path(),
        api_url=get_api_url(),
        tls_admission=upstream_admission.tls_admission_for_client(flow.client_conn),
    )


def _admit_platform_api_request(flow: http.HTTPFlow) -> bool:
    if not upstream_admission.ensure_bound_destination(
        flow,
        kind="api_allow",
        api_url=get_api_url(),
    ):
        return False
    platform_api.add_vercel_bypass_header(flow.request.headers)
    return True


def _admit_connector_auth_request(
    flow: http.HTTPFlow,
    *,
    platform_connector_auth: bool,
) -> bool:
    if not upstream_admission.ensure_bound_destination(
        flow,
        kind="connector_auth",
        api_url=get_api_url(),
        platform_connector_auth=platform_connector_auth,
    ):
        return False
    if platform_connector_auth:
        platform_api.add_vercel_bypass_header(flow.request.headers)
    return True


def _prebind_requestheaders_upstream_destination(
    flow: http.HTTPFlow,
    classification: request_classification.RequestClassification,
) -> None:
    """Bind privileged upstreams while requestheaders can still retarget."""
    if classification.kind == "api_allow":
        _admit_platform_api_request(flow)
        return
    if classification.kind != "firewall_allow":
        return
    allow = classification.firewall_allow
    if not _firewall_allow_injects_ordinary_upstream_credentials(allow):
        return
    _admit_connector_auth_request(
        flow,
        platform_connector_auth=classification.platform_connector_auth,
    )


def _prebind_bounded_requestheaders_upstream_destination(
    flow: http.HTTPFlow,
) -> request_classification.RequestClassification | None:
    """Classify and prebind while leaving successful probe metadata in place.

    The caller owns restoring requestheaders probe metadata after every call
    unless it retains the returned classification.
    """
    if getattr(ctx, "options", None) is None:
        return None
    api_url = get_api_url()
    try:
        trusted_authority = get_trusted_authority(flow)
    except AuthorityValidationError:
        return None
    flow.metadata[metadata_keys.TRUSTED_AUTHORITY_HOST] = trusted_authority.host
    is_api_destination = upstream_admission.api_destination_matches(
        api_url,
        scheme=flow.request.scheme,
        hostname=trusted_authority.host,
        port=trusted_authority.port,
    )
    if (
        not is_api_destination
        and upstream_admission.has_bound_destination(
            flow,
            allowed_kinds=frozenset(("connector_auth",)),
        )
        and not _request_may_use_aws_sigv4(flow)
    ):
        return None
    classification = _classify_request_for_flow_with_trusted_authority(
        flow,
        trusted_authority=trusted_authority,
        defer_unresolved_public_destination=True,
    )
    _prebind_requestheaders_upstream_destination(flow, classification)
    return classification


def _start_request_timing(flow: http.HTTPFlow) -> None:
    flow_metadata.start_request_timing(flow.metadata)


def _firewall_allow_auth_base(allow: matching.FirewallAllow) -> str | None:
    auth_config = allow.api_entry.get("auth", {})
    auth_base = auth_config.get("base") if isinstance(auth_config, dict) else None
    return auth_base if isinstance(auth_base, str) and auth_base else None


def _firewall_allow_uses_aws_sigv4(allow: matching.FirewallAllow) -> bool:
    auth_config = allow.api_entry.get("auth", {})
    if not isinstance(auth_config, dict):
        return False
    aws_sigv4 = auth_config.get("awsSigv4")
    return isinstance(aws_sigv4, dict) and bool(aws_sigv4)


def _request_may_use_aws_sigv4(flow: http.HTTPFlow) -> bool:
    if any(
        value.lstrip().startswith("AWS4-")
        for value in flow.request.headers.get_all("Authorization")
    ):
        return True
    return "X-Amz-Algorithm" in flow.request.path


def _firewall_allow_injects_ordinary_upstream_credentials(
    allow: matching.FirewallAllow,
) -> bool:
    return auth_config_injects_ordinary_upstream_credentials(allow.api_entry.get("auth"))


def _builtin_host_policy_error_for_firewall_allow(
    flow: http.HTTPFlow,
    allow: matching.FirewallAllow,
) -> builtin_host_policy.BuiltinRuntimeHostPolicyError | None:
    marker_name = builtin_host_policy.BUILTIN_HOST_POLICY_RUNTIME_MARKER
    if marker_name not in allow.api_entry:
        return None
    if not _firewall_allow_injects_ordinary_upstream_credentials(allow):
        return None
    runtime_host_policy = allow.api_entry[marker_name]
    if runtime_host_policy is True:
        runtime_host_policy = allow.api_entry.get("hostPolicy")
    elif not isinstance(runtime_host_policy, builtin_host_policy.CompiledBuiltinHostPolicy):
        return builtin_host_policy.BuiltinRuntimeHostPolicyError(
            reason="invalid_host_policy",
            message=(f'builtin firewall "{allow.name}" runtime host policy state is invalid'),
        )
    trusted_host = flow_metadata.trusted_authority_host(flow.metadata)
    if not trusted_host:
        return builtin_host_policy.BuiltinRuntimeHostPolicyError(
            reason="trusted_authority_unavailable",
            message="trusted request authority is unavailable",
        )
    upstream_endpoint = upstream_destination_binding.bound_destination_endpoint_for_flow(
        flow,
        allowed_kinds=frozenset(("connector_auth",)),
    )
    try:
        builtin_host_policy.validate_credentialed_builtin_request_destination(
            firewall_name=allow.name,
            trusted_host=trusted_host,
            trusted_port=flow.request.port,
            auth_config=allow.api_entry.get("auth"),
            host_policy=runtime_host_policy,
            upstream_endpoint=upstream_endpoint,
        )
    except builtin_host_policy.BuiltinRuntimeHostPolicyError as e:
        return e
    return None


def _has_current_direct_connector_auth_binding(
    flow: http.HTTPFlow,
    *,
    admitted_server: connection.Server,
    require_connected: bool,
) -> bool:
    if flow.server_conn is not admitted_server:
        return False
    if require_connected and not flow.server_conn.connected:
        return False
    return upstream_destination_binding.flow_matches_direct_bound_destination(
        flow,
        allowed_kinds=frozenset(("connector_auth",)),
    )


def _buffered_auth_body_header_check(
    flow: http.HTTPFlow,
    *,
    request_end_stream: bool | None,
    max_body_bytes: int,
    method_allows_missing_content_length: bool,
) -> _BufferedRequestBodyCheck:
    if flow.request.headers.get_all("Transfer-Encoding"):
        return _BufferedRequestBodyCheck(
            kind="length_required",
            reason="transfer_encoding",
        )

    parsed_content_length = content_length.parse(
        flow.request.headers.get_all("Content-Length"),
        max_value=max_body_bytes,
    )
    if parsed_content_length.kind == "missing":
        if not method_allows_missing_content_length:
            return _BufferedRequestBodyCheck(
                kind="length_required",
                reason="missing_content_length",
            )
        if request_end_stream is not True:
            reason = (
                "request_stream_open"
                if request_end_stream is False
                else "request_end_stream_unavailable"
            )
            return _BufferedRequestBodyCheck(kind="length_required", reason=reason)
        return _BufferedRequestBodyCheck(kind="ok")

    if parsed_content_length.kind == "conflicting":
        return _BufferedRequestBodyCheck(
            kind="length_required",
            reason="conflicting_content_length",
        )
    if parsed_content_length.kind == "over_limit":
        return _BufferedRequestBodyCheck(
            kind="too_large",
            observed_size=parsed_content_length.value,
        )
    if parsed_content_length.kind == "valid":
        return _BufferedRequestBodyCheck(kind="ok", observed_size=parsed_content_length.value)
    return _BufferedRequestBodyCheck(
        kind="length_required",
        reason="invalid_content_length",
    )


def _auth_base_body_header_check(
    flow: http.HTTPFlow,
    *,
    request_end_stream: bool | None,
) -> _BufferedRequestBodyCheck:
    return _buffered_auth_body_header_check(
        flow,
        request_end_stream=request_end_stream,
        max_body_bytes=auth_base_forwarder.MAX_AUTH_BASE_REQUEST_BODY_BYTES,
        method_allows_missing_content_length=(
            flow.request.method.upper() in _AUTH_BASE_BODYLESS_METHODS
        ),
    )


def _aws_sigv4_body_header_check(
    flow: http.HTTPFlow,
    *,
    request_end_stream: bool | None,
) -> _BufferedRequestBodyCheck:
    return _buffered_auth_body_header_check(
        flow,
        request_end_stream=request_end_stream,
        max_body_bytes=aws_sigv4_body_admission.MAX_AWS_SIGV4_REQUEST_BODY_BYTES,
        method_allows_missing_content_length=True,
    )


def _request_body_fits_stream_buffer(flow: http.HTTPFlow) -> bool:
    if flow.request.headers.get_all("Transfer-Encoding"):
        return False

    parsed_content_length = content_length.parse(
        flow.request.headers.get_all("Content-Length"),
        max_value=STREAM_BUFFER_LIMIT,
    )
    # requestheaders() does not expose mitmproxy's end_stream flag. Treat
    # missing Content-Length as unknown length even for GET/HEAD because
    # HTTP/2 can carry DATA frames after headers without a length header.
    return parsed_content_length.kind == "valid"


def _restore_request_headers_probe_metadata(
    flow: http.HTTPFlow, snapshot: dict[str, object]
) -> None:
    request_classification.restore_request_headers_probe_metadata(
        flow,
        snapshot,
        extra_keys=connector_intent.REQUEST_HEADERS_PROBE_METADATA_KEYS,
    )


def _http_network_log_entry(
    flow: http.HTTPFlow,
    *,
    action: str,
    status_code: int,
    latency_ms: int,
    request_size: int,
    response_size: int,
) -> tuple[dict, str]:
    url, host, port = http_network_log.target(flow)
    entry = {
        "type": "http",
        "action": action,
        "host": host,
        "port": port,
        "method": flow.request.method,
        "status": status_code,
        "latency_ms": latency_ms,
        "request_size": request_size,
        "response_size": response_size,
    }
    firewall_error = flow_metadata.firewall_error(flow.metadata)
    if firewall_error is not None:
        entry["firewall_error"] = firewall_error
    connector_route_reason = flow_metadata.connector_route_reason(flow.metadata)
    if connector_route_reason is not None:
        entry["connector_route_reason"] = connector_route_reason
    connector_route_candidates = flow_metadata.connector_route_candidates(flow.metadata)
    if connector_route_candidates:
        entry["connector_route_candidates"] = connector_route_candidates
    entry.update(upstream_admission.upstream_binding_log_fields(flow))
    if flow.metadata.get(metadata_keys.BROWSER_USER_AGENT):
        entry["browser_user_agent"] = True
    if flow_metadata.firewall_base(flow.metadata):
        add_firewall_metadata(flow, entry)
    codex_model_catalog_cache.add_network_log_fields(flow, entry)
    return entry, url


def _block_authority_validation_error(flow: http.HTTPFlow, error: AuthorityValidationError) -> None:
    http_local_responses.block_authority_validation_error(flow, error)


def _block_registry_unavailable(
    flow: http.HTTPFlow,
    unavailable: registry.RegistryUnavailable,
) -> None:
    http_local_responses.block_registry_unavailable(flow, unavailable)


def _block_invalid_registry_sandbox(
    flow: http.HTTPFlow,
    invalid_sandbox: registry.InvalidSandboxEntry,
) -> None:
    http_local_responses.block_invalid_registry_sandbox(flow, invalid_sandbox)


def _block_stale_tls_admission(flow: http.HTTPFlow, *, reason: str) -> None:
    http_local_responses.block_stale_tls_admission(flow, reason=reason)


def _block_platform_path_denied(flow: http.HTTPFlow) -> None:
    http_local_responses.block_platform_path_denied(flow)


def _block_firewall_authorization_changed(
    flow: http.HTTPFlow,
    *,
    current_decision: str,
) -> None:
    http_local_responses.block_firewall_authorization_changed(
        flow,
        current_decision=current_decision,
    )


def _block_upstream_destination_unbound(
    flow: http.HTTPFlow,
    *,
    reason: upstream_destination_binding.BindingKind,
) -> None:
    server_address = getattr(flow.server_conn, "address", None)
    diagnostics = upstream_admission.record_unbound_diagnostics(flow, reason=reason)
    http_local_responses.block_upstream_destination_unbound(
        flow,
        reason=reason,
        server_address=server_address,
        diagnostics=diagnostics,
    )


def _block_builtin_host_policy_denied(
    flow: http.HTTPFlow,
    *,
    allow: matching.FirewallAllow,
    error: builtin_host_policy.BuiltinRuntimeHostPolicyError,
) -> None:
    upstream_endpoint = upstream_destination_binding.bound_destination_endpoint_for_flow(
        flow,
        allowed_kinds=frozenset(("connector_auth",)),
    )
    http_local_responses.block_builtin_host_policy_denied(
        flow,
        allow=allow,
        error=error,
        upstream_endpoint=_endpoint_text(upstream_endpoint),
    )


def _endpoint_text(address: tuple[str, int] | None) -> str:
    if address is None:
        return ""
    host, port = address
    return f"{host}:{port}"


def server_connect(data: object) -> None:
    upstream_admission.handle_server_connect(
        data,
        registry_path=get_registry_path(),
        api_url=get_api_url(),
    )


def server_disconnected(data: object) -> None:
    upstream_admission.forget_server_binding_from_event(data)


def server_connect_error(data: object) -> None:
    upstream_admission.forget_server_binding_from_event(data)


# ============================================================================
# TLS ClientHello Handler
# ============================================================================


def tls_clienthello(data: tls.ClientHelloData) -> None:
    upstream_admission.handle_tls_clienthello(
        data,
        registry_path=get_registry_path(),
        api_url=get_api_url(),
    )


def client_disconnected(client: connection.Client) -> None:
    upstream_admission.forget_client(client)


# ============================================================================
# HTTP Request Handler (MITM mode)
# ============================================================================


def requestheaders(flow: http.HTTPFlow) -> Awaitable[None] | None:
    """Handle request-header-only decisions before mitmproxy buffers bodies."""
    request_end_stream = mitmproxy_compat.take_request_end_stream(flow)
    request_header_fields = flow.request.headers.fields
    if len(request_header_fields) > _MAX_REQUEST_HEADER_FIELDS:
        # A local response waits for body completion. Kill before mitmproxy's
        # Expect lookup instead of retaining or rescanning the rejected tuple.
        flow.request.headers.fields = ()
        flow.metadata[_REQUEST_HEADERS_TERMINATED] = True
        flow.kill()
        return None
    if any(len(name) > _MAX_REQUEST_HEADER_NAME_BYTES for name, _value in request_header_fields):
        # A local response waits for body completion. Drop rejected names and
        # kill before mitmproxy's Expect lookup or request-body buffering.
        flow.request.headers.fields = tuple(
            (name, value)
            for name, value in request_header_fields
            if len(name) <= _MAX_REQUEST_HEADER_NAME_BYTES
        )
        flow.metadata[_REQUEST_HEADERS_TERMINATED] = True
        flow.kill()
        return None

    codex_model_catalog_cache.capture_and_strip_prefetch_marker(flow)
    connector_intent.capture_and_strip(flow)

    auth_base_body_check = _auth_base_body_header_check(
        flow,
        request_end_stream=request_end_stream,
    )
    aws_sigv4_body_check = _aws_sigv4_body_header_check(
        flow,
        request_end_stream=request_end_stream,
    )
    body_fits_stream_buffer = (
        auth_base_body_check.kind == "ok" and _request_body_fits_stream_buffer(flow)
    )
    metadata_snapshot = {
        key: flow.metadata[key]
        for key in _request_headers_probe_metadata_keys()
        if key in flow.metadata
    }
    if body_fits_stream_buffer:
        try:
            bounded_classification = _prebind_bounded_requestheaders_upstream_destination(flow)
        except BaseException:
            _restore_request_headers_probe_metadata(flow, metadata_snapshot)
            raise
        if (
            bounded_classification is None
            or bounded_classification.kind != "firewall_allow"
            or _firewall_allow_auth_base(bounded_classification.firewall_allow)
            or not _firewall_allow_uses_aws_sigv4(bounded_classification.firewall_allow)
        ):
            _restore_request_headers_probe_metadata(flow, metadata_snapshot)
            return None
        classification = request_classification.revalidate_classification_for_current_destination(
            flow,
            bounded_classification,
            defer_unresolved_public_destination=True,
        )
    else:
        classification = _classify_request_for_flow(
            flow,
            defer_unresolved_public_destination=True,
        )
    if classification.kind == "public_destination_denied":
        _start_request_timing(flow)
        _block_public_destination_denied(
            flow,
            classification.public_destination_denial,
            send_response=False,
        )
        flow.metadata[_REQUEST_HEADERS_TERMINATED] = True
        flow.kill()
        return None

    if (
        classification.kind == "firewall_allow"
        and connector_diagnostics.maybe_make_connector_owner_local_response(
            flow,
            classification,
            commit=False,
        )
    ):
        flow.metadata[_REQUEST_HEADERS_TERMINATED] = True
        return None

    _prebind_requestheaders_upstream_destination(flow, classification)
    if classification.kind == "firewall_allow":
        allow = classification.firewall_allow
        sandbox_info = classification.sandbox_info
        auth_base = _firewall_allow_auth_base(allow)
        if auth_base_body_check.kind != "ok" and auth_base:
            _start_request_timing(flow)
            prepare_firewall_metadata(flow, allow, sandbox_info)
            proxy_log_path = flow_metadata.proxy_log_path(flow.metadata)
            firewall_base = flow.metadata[metadata_keys.FIREWALL_BASE]
            if auth_base_body_check.kind == "too_large":
                mark_auth_base_request_too_large(
                    flow,
                    proxy_log_path=proxy_log_path,
                    firewall_base=firewall_base,
                    observed_size=auth_base_body_check.observed_size,
                )
            else:
                mark_auth_base_request_length_required(
                    flow,
                    proxy_log_path=proxy_log_path,
                    firewall_base=firewall_base,
                    reason=auth_base_body_check.reason,
                )
            request_classification.pop_cached_classification(flow)
            flow.metadata[_REQUEST_HEADERS_TERMINATED] = True
            flow.kill()
            return None

        if auth_base and auth_base_body_check.kind == "ok":
            try:
                admission = auth_base_forwarder.reserve_forward_request_admission(
                    auth_base_body_check.observed_size
                )
            except (
                auth_base_forwarder.AuthBaseForwardingSaturatedError,
                RuntimeError,
            ):
                _start_request_timing(flow)
                prepare_firewall_metadata(flow, allow, sandbox_info)
                proxy_log_path = flow_metadata.proxy_log_path(flow.metadata)
                firewall_base = flow.metadata[metadata_keys.FIREWALL_BASE]
                mark_auth_base_forwarding_saturated(
                    flow,
                    proxy_log_path=proxy_log_path,
                    firewall_base=firewall_base,
                )
                request_classification.pop_cached_classification(flow)
                flow.metadata[_REQUEST_HEADERS_TERMINATED] = True
                flow.kill()
                return None
            try:
                auth_base_forwarder.attach_forward_request_admission_to_flow(flow, admission)
            except BaseException:
                auth_base_forwarder.release_forward_request_admission(admission)
                raise
            return None

        if _firewall_allow_uses_aws_sigv4(allow):
            can_apply_from_headers = (
                not request_classification.firewall_allow_uses_public_destination(allow)
                and not aws_sigv4_request_requires_body_for_signing(flow)
            )
            if can_apply_from_headers:
                return _try_firewall_request_stream_from_headers(
                    flow,
                    classification=classification,
                    metadata_snapshot=metadata_snapshot,
                    request_end_stream=request_end_stream,
                    capture_body=bool(sandbox_info.get("captureNetworkBodies", False)),
                    aws_sigv4_buffered_fallback=aws_sigv4_body_check,
                )
            _admit_buffered_aws_sigv4_request(
                flow,
                classification=classification,
                body_check=aws_sigv4_body_check,
            )
            return None

    if isinstance(
        classification,
        request_classification.ApiAllow
        | request_classification.BrowserAllow
        | request_classification.FirewallPolicyAllow
        | request_classification.Allow,
    ) and request_classification.should_stream_capture_request(classification):
        if classification.kind == "api_allow" and not _admit_platform_api_request(flow):
            _restore_request_headers_probe_metadata(flow, metadata_snapshot)
            return None
        if classification.kind == "allow":
            connector_diagnostics.record_allow_context(flow, classification)
        request_classification.cache_classification(flow, classification)
        _start_request_timing(flow)
        request_streaming.configure_request_stream(flow)
        return None

    if (
        classification.kind == "firewall_allow"
        and request_classification.should_try_firewall_stream_capture_request(classification)
    ):
        return _try_firewall_request_stream_from_headers(
            flow,
            classification=classification,
            metadata_snapshot=metadata_snapshot,
            request_end_stream=request_end_stream,
            capture_body=True,
            aws_sigv4_buffered_fallback=None,
        )

    _restore_request_headers_probe_metadata(flow, metadata_snapshot)
    return None


def _admit_buffered_aws_sigv4_request(
    flow: http.HTTPFlow,
    *,
    classification: request_classification.FirewallAllow,
    body_check: _BufferedRequestBodyCheck,
) -> None:
    allow = classification.firewall_allow
    sandbox_info = classification.sandbox_info

    if body_check.kind != "ok":
        _start_request_timing(flow)
        prepare_firewall_metadata(flow, allow, sandbox_info)
        proxy_log_path = flow_metadata.proxy_log_path(flow.metadata)
        firewall_base = flow.metadata[metadata_keys.FIREWALL_BASE]
        if body_check.kind == "too_large":
            mark_aws_sigv4_request_too_large(
                flow,
                proxy_log_path=proxy_log_path,
                firewall_base=firewall_base,
                observed_size=body_check.observed_size,
            )
        else:
            mark_aws_sigv4_request_length_required(
                flow,
                proxy_log_path=proxy_log_path,
                firewall_base=firewall_base,
                reason=body_check.reason,
            )
        release_aws_sigv4_request_inspection(flow)
        request_classification.pop_cached_classification(flow)
        flow.metadata[_REQUEST_HEADERS_TERMINATED] = True
        flow.kill()
        return

    try:
        admission = aws_sigv4_body_admission.reserve(body_check.observed_size)
    except aws_sigv4_body_admission.AwsSigV4BodyAdmissionSaturatedError:
        _start_request_timing(flow)
        prepare_firewall_metadata(flow, allow, sandbox_info)
        proxy_log_path = flow_metadata.proxy_log_path(flow.metadata)
        firewall_base = flow.metadata[metadata_keys.FIREWALL_BASE]
        mark_aws_sigv4_request_admission_saturated(
            flow,
            proxy_log_path=proxy_log_path,
            firewall_base=firewall_base,
        )
        release_aws_sigv4_request_inspection(flow)
        request_classification.pop_cached_classification(flow)
        flow.metadata[_REQUEST_HEADERS_TERMINATED] = True
        flow.kill()
        return

    try:
        aws_sigv4_body_admission.attach_to_flow(flow, admission)
    except BaseException:
        aws_sigv4_body_admission.release(admission)
        raise


async def _try_firewall_request_stream_from_headers(
    flow: http.HTTPFlow,
    *,
    classification: request_classification.FirewallAllow,
    metadata_snapshot: dict[str, object],
    request_end_stream: bool | None,
    capture_body: bool,
    aws_sigv4_buffered_fallback: _BufferedRequestBodyCheck | None,
) -> None:
    allow = classification.firewall_allow
    sandbox_info = classification.sandbox_info
    request_headers_snapshot = http.Headers(flow.request.headers.fields)
    request_url_snapshot = flow.request.url

    def restore_request_state() -> None:
        flow.request.url = request_url_snapshot
        flow.request.headers = http.Headers(request_headers_snapshot.fields)

    def fall_back() -> None:
        restore_request_state()
        if aws_sigv4_buffered_fallback is None:
            _restore_request_headers_probe_metadata(flow, metadata_snapshot)
            return
        _admit_buffered_aws_sigv4_request(
            flow,
            classification=classification,
            body_check=aws_sigv4_buffered_fallback,
        )

    if _firewall_allow_injects_ordinary_upstream_credentials(
        allow
    ) and not _admit_connector_auth_request(
        flow,
        platform_connector_auth=classification.platform_connector_auth,
    ):
        fall_back()
        return
    if _builtin_host_policy_error_for_firewall_allow(flow, allow) is not None:
        fall_back()
        return

    _maybe_normalize_accept_encoding_for_body_inspection(flow, allow, sandbox_info)
    _start_request_timing(flow)
    expected_run_id = flow_metadata.run_id(flow.metadata)
    admitted_server = flow.server_conn
    require_connected = flow.server_conn.connected
    try:
        result = await try_apply_stream_safe_firewall_auth_for_requestheaders(
            flow,
            allow,
            sandbox_info,
            revalidate_current_firewall_authorization=lambda: (
                _firewall_authorization_is_current_for_requestheaders(
                    flow,
                    allow,
                    expected_run_id=expected_run_id,
                    admitted_server=admitted_server,
                    require_connected=require_connected,
                )
            ),
        )
    except (asyncio.CancelledError, Exception):
        restore_request_state()
        _restore_request_headers_probe_metadata(flow, metadata_snapshot)
        raise
    if result is FirewallHeaderPhaseAuthResult.REJECTED:
        restore_request_state()
        # A local response waits for body EOF. Preserve auth diagnostics, but
        # kill before mitmproxy sends 100 Continue or consumes the rejected body.
        flow.response = None
        release_aws_sigv4_request_inspection(flow)
        request_classification.pop_cached_classification(flow)
        flow.metadata[_REQUEST_HEADERS_TERMINATED] = True
        flow.kill()
        return
    if result is not FirewallHeaderPhaseAuthResult.APPLIED:
        fall_back()
        return

    terminal_usage.track_flow_if_needed(
        flow,
        is_billable_firewall(allow.name, sandbox_info),
    )
    try:
        request_classification.cache_classification(flow, classification)
        flow.metadata[_FIREWALL_AUTH_APPLIED_IN_REQUESTHEADERS] = True
        await _prepare_codex_catalog_request_with_upstream_revalidation(
            flow,
            allow,
            expected_run_id=expected_run_id,
            admitted_server=admitted_server,
            require_connected=require_connected,
            request_end_stream=request_end_stream is True,
        )
        if flow.response is None:
            model_provider_failure.admit_flow(flow)
            request_streaming.configure_request_stream(flow, capture_body=capture_body)
    except (asyncio.CancelledError, Exception):
        _release_terminal_flow_state(flow, release_tracking=True)
        restore_request_state()
        _restore_request_headers_probe_metadata(flow, metadata_snapshot)
        raise


def _set_firewall_block_response(flow: http.HTTPFlow, result: matching.FirewallBlock) -> None:
    http_local_responses.set_firewall_block_response(flow, result)


def _set_firewall_ambiguous_response(
    flow: http.HTTPFlow,
    result: matching.FirewallAmbiguous,
) -> None:
    http_local_responses.set_firewall_ambiguous_response(flow, result)


def _block_public_destination_denied(
    flow: http.HTTPFlow,
    denial: request_classification.PublicDestinationDenial,
    *,
    send_response: bool = True,
) -> None:
    http_local_responses.block_public_destination_denied(
        flow,
        name=denial.name,
        base=denial.base,
        destination_host=denial.destination_host,
        trusted_authority_host=denial.trusted_authority_host,
        reason=denial.reason,
        send_response=send_response,
    )


def _revalidate_current_firewall_authorization_for_request(
    flow: http.HTTPFlow,
    allow: matching.FirewallAllow,
    *,
    expected_run_id: str,
    admitted_server: connection.Server,
    require_connected: bool,
) -> bool:
    if _firewall_allow_injects_ordinary_upstream_credentials(
        allow
    ) and not _has_current_direct_connector_auth_binding(
        flow,
        admitted_server=admitted_server,
        require_connected=require_connected,
    ):
        _block_upstream_destination_unbound(flow, reason="connector_auth")
        return False

    current_classification = _current_firewall_authorization_classification(flow)
    current_allow = _equivalent_current_firewall_allow(
        current_classification,
        expected_allow=allow,
        expected_run_id=expected_run_id,
    )
    if current_allow is None:
        _block_current_firewall_authorization(flow, current_classification)
        return False

    host_policy_error = _builtin_host_policy_error_for_firewall_allow(
        flow,
        current_allow.firewall_allow,
    )
    if host_policy_error is not None:
        _block_builtin_host_policy_denied(
            flow,
            allow=current_allow.firewall_allow,
            error=host_policy_error,
        )
        return False

    return True


def _current_firewall_authorization_classification(
    flow: http.HTTPFlow,
) -> request_classification.RequestClassification:
    preserved_probe_metadata = {
        key: flow.metadata[key]
        for key in (
            metadata_keys.HTTP_REQUEST_START_MONOTONIC,
            metadata_keys.WEBSOCKET_UPGRADE_REQUEST,
            metadata_keys.AWS_SIGV4_REQUEST_INSPECTION,
            metadata_keys.RESPONSE_ENCODING_NEGOTIATION,
        )
        if key in flow.metadata
    }
    request_classification.restore_request_headers_probe_metadata(
        flow,
        preserved_probe_metadata,
    )
    return _classify_request_for_flow(flow)


def _equivalent_current_firewall_allow(
    classification: request_classification.RequestClassification,
    *,
    expected_allow: matching.FirewallAllow,
    expected_run_id: str,
) -> request_classification.FirewallAllow | None:
    if not isinstance(classification, request_classification.FirewallAllow):
        return None
    current_run_id = classification.sandbox_info.get("runId")
    if current_run_id != expected_run_id:
        return None
    if classification.firewall_allow != expected_allow:
        return None
    return classification


def _firewall_authorization_is_current_for_requestheaders(
    flow: http.HTTPFlow,
    allow: matching.FirewallAllow,
    *,
    expected_run_id: str,
    admitted_server: connection.Server,
    require_connected: bool,
) -> bool:
    if not _has_current_direct_connector_auth_binding(
        flow,
        admitted_server=admitted_server,
        require_connected=require_connected,
    ):
        return False
    current_classification = _current_firewall_authorization_classification(flow)
    current_allow = _equivalent_current_firewall_allow(
        current_classification,
        expected_allow=allow,
        expected_run_id=expected_run_id,
    )
    return current_allow is not None and (
        _builtin_host_policy_error_for_firewall_allow(
            flow,
            current_allow.firewall_allow,
        )
        is None
    )


def _clear_stale_firewall_authorization_metadata(flow: http.HTTPFlow) -> None:
    for key in _STALE_FIREWALL_AUTHORIZATION_METADATA_KEYS:
        flow.metadata.pop(key, None)


def _block_request_classification(
    flow: http.HTTPFlow,
    classification: request_classification.BlockingRequestClassification,
) -> None:
    if classification.kind == "registry_unavailable":
        _block_registry_unavailable(flow, classification.registry_unavailable)
        return
    if classification.kind == "stale_tls_admission":
        _block_stale_tls_admission(flow, reason=classification.stale_tls_reason)
        return
    if classification.kind == "invalid_registry_sandbox":
        _block_invalid_registry_sandbox(flow, classification.invalid_sandbox)
        return
    if classification.kind == "authority_denied":
        _block_authority_validation_error(flow, classification.authority_error)
        return
    if classification.kind == "platform_path_denied":
        _block_platform_path_denied(flow)
        return
    if classification.kind == "gmail_send_blocked":
        http_local_responses.block_gmail_send(flow)
        return
    if classification.kind == "firewall_ambiguous":
        if connector_diagnostics.maybe_make_connector_owner_local_response(
            flow, classification, commit=True
        ):
            return
        _set_firewall_ambiguous_response(flow, classification.firewall_ambiguous)
        return
    if classification.kind == "firewall_block":
        _set_firewall_block_response(flow, classification.firewall_block)
        return
    if classification.kind == "public_destination_denied":
        _block_public_destination_denied(flow, classification.public_destination_denial)
        return
    _unhandled_request_classification(classification)


def _block_current_firewall_authorization(
    flow: http.HTTPFlow,
    classification: request_classification.RequestClassification,
) -> None:
    _clear_stale_firewall_authorization_metadata(flow)
    if isinstance(classification, request_classification.BlockingRequestClassification):
        _block_request_classification(flow, classification)
        return
    _block_firewall_authorization_changed(
        flow,
        current_decision=classification.kind,
    )


async def _prepare_codex_catalog_request_with_upstream_revalidation(
    flow: http.HTTPFlow,
    allow: matching.FirewallAllow,
    *,
    expected_run_id: str,
    admitted_server: connection.Server,
    require_connected: bool,
    request_end_stream: bool,
) -> None:
    """Coordinate catalog preparation with post-wait provider revalidation.

    A successful local cache response never continues to the provider. When
    ``prepare_request()`` reports that this flow waited and no local response exists,
    the suspension may have invalidated its connector binding, registry-backed
    firewall authorization, destination, or host-policy assumptions, so ordinary
    credential-bearing continuation is revalidated before proceeding. See
    ``test_catalog_wait_revalidates_only_provider_continuation`` for owner failure,
    timeout, and local-response coverage across both request hooks.
    """
    waited_for_in_flight = await codex_model_catalog_cache.prepare_request(
        flow,
        request_end_stream=request_end_stream,
    )
    if (
        waited_for_in_flight
        and flow.response is None
        and _firewall_allow_injects_ordinary_upstream_credentials(allow)
    ):
        _revalidate_current_firewall_authorization_for_request(
            flow,
            allow,
            expected_run_id=expected_run_id,
            admitted_server=admitted_server,
            require_connected=require_connected,
        )


def _unhandled_request_classification(classification: NoReturn) -> NoReturn:
    raise AssertionError(f"Unhandled request classification: {classification!r}")


async def request(flow: http.HTTPFlow) -> None:
    """Dispatch a request-phase classification and apply its outcome.

    `request_classification.classification_for_request()` reuses an intentionally
    cached header-phase classification when present and revalidates cached
    firewall allows against the current destination. Otherwise it delegates to
    `request_classification.classify_request()`, which owns the canonical decision
    order. This hook dispatches the current-state result.
    """
    if flow.metadata.get(_REQUEST_HEADERS_TERMINATED):
        auth_base_forwarder.release_forward_request_admission_from_flow(flow)
        aws_sigv4_body_admission.release_from_flow(flow)
        release_aws_sigv4_request_inspection(flow)
        request_classification.pop_cached_classification(flow)
        return

    codex_model_catalog_cache.capture_and_strip_prefetch_marker(flow)
    connector_intent.capture_and_strip(flow)

    if flow.response is not None or flow.error is not None:
        auth_base_forwarder.release_forward_request_admission_from_flow(flow)
        aws_sigv4_body_admission.release_from_flow(flow)
        release_aws_sigv4_request_inspection(flow)
        request_classification.pop_cached_classification(flow)
        return

    try:
        if request_streaming.streamed_request_size(flow) is not None:
            flow.metadata[metadata_keys.REQUEST_STREAM_COMPLETE] = True

        classification = _request_classification_for_flow(flow)
        if classification.kind != "firewall_allow" or not _firewall_allow_auth_base(
            classification.firewall_allow
        ):
            auth_base_forwarder.release_forward_request_admission_from_flow(flow)
        if classification.kind != "firewall_allow" or not _firewall_allow_uses_aws_sigv4(
            classification.firewall_allow
        ):
            aws_sigv4_body_admission.release_from_flow(flow)

        if request_classification.classification_needs_request_timing(classification):
            _start_request_timing(flow)

        if classification.kind == "no_client_ip":
            addon_process_logging.emit_addon_process_event(
                "warn",
                "No client IP available, passing through",
            )
            return
        if isinstance(classification, request_classification.BlockingRequestClassification):
            if isinstance(classification, request_classification.PublicDestinationDenied):
                terminal_usage.release_tracked_flow(flow)
            _block_request_classification(flow, classification)
            return
        if classification.kind == "pass_through":
            return
        if classification.kind == "api_allow":
            if not _admit_platform_api_request(flow):
                _block_upstream_destination_unbound(flow, reason="api_allow")
                return
            flow_metadata.set_firewall_decision(flow.metadata, "ALLOW")
            return
        if classification.kind == "browser_allow":
            # Browser-originated traffic intentionally bypasses connector
            # firewall handling. User-Agent is the short-term heuristic for that
            # business passthrough, not trusted provenance.
            flow_metadata.set_firewall_decision(flow.metadata, "ALLOW")
            flow.metadata[metadata_keys.FIREWALL_BILLABLE] = False
            return
        if classification.kind == "firewall_policy_allow":
            prepare_firewall_metadata(
                flow,
                classification.firewall_allow,
                classification.sandbox_info,
            )
            flow.metadata[metadata_keys.FIREWALL_BILLABLE] = False
            flow.metadata.pop(metadata_keys.MODEL_USAGE_PROVIDER, None)
            flow_metadata.set_firewall_decision(flow.metadata, "ALLOW")
            if _is_websocket_upgrade_request(flow):
                flow.metadata[metadata_keys.WEBSOCKET_UPGRADE_REQUEST] = True
            run_usage.admit(flow)
            return
        if classification.kind == "firewall_allow":
            allow = classification.firewall_allow
            sandbox_info = classification.sandbox_info
            if connector_diagnostics.maybe_make_connector_owner_local_response(
                flow,
                classification,
                commit=True,
            ):
                auth_base_forwarder.release_forward_request_admission_from_flow(flow)
                terminal_usage.release_tracked_flow(flow)
                return
            if flow.metadata.get(_FIREWALL_AUTH_APPLIED_IN_REQUESTHEADERS):
                return
            if _firewall_allow_injects_ordinary_upstream_credentials(
                allow
            ) and not _admit_connector_auth_request(
                flow,
                platform_connector_auth=classification.platform_connector_auth,
            ):
                prepare_firewall_metadata(flow, allow, sandbox_info)
                _block_upstream_destination_unbound(flow, reason="connector_auth")
                return
            host_policy_error = _builtin_host_policy_error_for_firewall_allow(flow, allow)
            if host_policy_error is not None:
                prepare_firewall_metadata(flow, allow, sandbox_info)
                _block_builtin_host_policy_denied(
                    flow,
                    allow=allow,
                    error=host_policy_error,
                )
                return
            _maybe_normalize_accept_encoding_for_body_inspection(flow, allow, sandbox_info)
            run_usage.admit(flow, namespace=allow.name)
            terminal_usage.track_flow_if_needed(
                flow,
                is_billable_firewall(allow.name, sandbox_info),
            )
            expected_run_id = flow_metadata.run_id(flow.metadata)
            admitted_server = flow.server_conn
            require_connected = flow.server_conn.connected
            auth_result = await handle_firewall_request(
                flow,
                allow,
                sandbox_info,
                revalidate_current_firewall_authorization=lambda: (
                    _revalidate_current_firewall_authorization_for_request(
                        flow,
                        allow,
                        expected_run_id=expected_run_id,
                        admitted_server=admitted_server,
                        require_connected=require_connected,
                    )
                ),
            )
            if auth_result is FirewallAuthHandlingResult.LOCAL_RESPONSE:
                # Local firewall/auth errors never reach a provider. They only
                # need pre-tracking to keep shutdown from racing while auth is
                # resolving, so release as soon as the local response exists.
                auth_base_forwarder.release_forward_request_admission_from_flow(flow)
                terminal_usage.release_tracked_flow(flow)
            elif auth_result is FirewallAuthHandlingResult.CONTINUE_UPSTREAM:
                await _prepare_codex_catalog_request_with_upstream_revalidation(
                    flow,
                    allow,
                    expected_run_id=expected_run_id,
                    admitted_server=admitted_server,
                    require_connected=require_connected,
                    request_end_stream=True,
                )
                if flow.response is None:
                    model_provider_failure.admit_flow(flow)
            return

        if classification.kind == "allow":
            connector_diagnostics.record_allow_context(flow, classification)
            flow_metadata.set_firewall_decision(flow.metadata, "ALLOW")
            return

        _unhandled_request_classification(classification)
    except (asyncio.CancelledError, Exception) as error:
        if isinstance(error, Exception) and flow.response is None and flow.error is None:
            flow.response = http_local_responses.make_local_json_response(
                flow,
                500,
                {
                    "error": "request_processing_failed",
                    "message": "Request processing failed",
                },
            )
        flow.metadata.pop(metadata_keys.HTTP_REQUEST_START_MONOTONIC, None)
        auth_base_forwarder.release_forward_request_admission_from_flow(flow)
        aws_sigv4_body_admission.release_from_flow(flow)
        terminal_usage.release_tracked_flow(flow)
        raise
    finally:
        release_aws_sigv4_request_inspection(flow)
        request_classification.pop_cached_classification(flow)


def _maybe_normalize_accept_encoding_for_body_inspection(
    flow: http.HTTPFlow,
    allow: matching.FirewallAllow,
    sandbox_info: dict,
) -> None:
    is_websocket_upgrade = _is_websocket_upgrade_request(flow)
    if is_websocket_upgrade:
        flow.metadata[metadata_keys.WEBSOCKET_UPGRADE_REQUEST] = True
    if _expects_http_response_body_usage_inspection(
        flow,
        allow,
        sandbox_info,
        is_websocket_upgrade=is_websocket_upgrade,
    ):
        flow.metadata[metadata_keys.RESPONSE_ENCODING_NEGOTIATION] = (
            response_encoding_negotiation.normalize_accept_encoding_for_body_inspection(
                flow.request.headers
            )
        )


def _expects_http_response_body_usage_inspection(
    flow: http.HTTPFlow,
    allow: matching.FirewallAllow,
    sandbox_info: dict,
    *,
    is_websocket_upgrade: bool,
) -> bool:
    if flow.request.method.upper() in _HTTP_RESPONSE_BODYLESS_METHODS:
        return False
    if is_websocket_upgrade:
        return False
    if allow.name.startswith("model-provider:") and is_billable_firewall(allow.name, sandbox_info):
        return True
    return is_billable_firewall(allow.name, sandbox_info) and usage.has_connector_response_parser(
        allow.name
    )


def _is_websocket_upgrade_request(flow: http.HTTPFlow) -> bool:
    if flow.request.method.upper() != "GET":
        return False
    if flow.request.http_version != "HTTP/1.1":
        return False
    if not http_header_syntax.header_fields_contain_token(
        flow.request.headers.fields,
        b"upgrade",
        b"websocket",
        max_work_units=_WEBSOCKET_HANDSHAKE_HEADER_WORK_LIMIT,
    ):
        return False
    websocket_key = http_header_syntax.single_header_value(
        flow.request.headers.fields,
        b"sec-websocket-key",
        max_fields=_WEBSOCKET_HANDSHAKE_HEADER_WORK_LIMIT,
        max_value_bytes=_WEBSOCKET_HANDSHAKE_HEADER_WORK_LIMIT,
    )
    if websocket_key is None or not _is_valid_websocket_key(websocket_key):
        return False
    websocket_version = http_header_syntax.single_header_value(
        flow.request.headers.fields,
        b"sec-websocket-version",
        max_fields=_WEBSOCKET_HANDSHAKE_HEADER_WORK_LIMIT,
        max_value_bytes=_WEBSOCKET_HANDSHAKE_HEADER_WORK_LIMIT,
    )
    if websocket_version != b"13":
        return False

    return http_header_syntax.header_fields_contain_token(
        flow.request.headers.fields,
        b"connection",
        b"upgrade",
        max_work_units=_WEBSOCKET_HANDSHAKE_HEADER_WORK_LIMIT,
    )


def _is_valid_websocket_key(value: bytes) -> bool:
    if len(value) != _WEBSOCKET_KEY_BASE64_BYTES:
        return False
    try:
        decoded = base64.b64decode(value, validate=True)
    except binascii.Error:
        return False
    return len(decoded) == _WEBSOCKET_KEY_BYTES


# ============================================================================
# HTTP Response Handlers
# ============================================================================


def responseheaders(flow: http.HTTPFlow) -> None:
    """Install response stream buffering and incremental body parsers."""
    codex_model_catalog_cache.observe_authenticated_models_etag(flow)
    if not codex_model_catalog_cache.handle_response_headers(flow):
        return
    if connector_diagnostics.install_response_stream_if_needed(flow):
        return
    response_streaming.configure_response_stream(
        flow,
        websocket_header_work_limit=_WEBSOCKET_HANDSHAKE_HEADER_WORK_LIMIT,
    )
    codex_model_catalog_cache.wrap_response_stream(flow)


def websocket_message(flow: http.HTTPFlow) -> None:
    """Bound WebSocket history and observe model-provider protocol events."""
    if not flow.websocket or not flow.websocket.messages:
        return

    message = flow.websocket.messages[-1]
    websocket_retention.schedule_message_trim(flow)
    if not flow_metadata.run_id(flow.metadata):
        return
    if getattr(message, "from_client", False):
        failure_client_enabled = model_provider_failure.should_observe_websocket_client_event(flow)
        usage_enabled = model_websocket_usage.is_enabled(flow)
        usage_client_enabled = model_websocket_usage.should_observe_client_event(flow)
        if not failure_client_enabled and not usage_enabled:
            return
        body = message.content.encode() if isinstance(message.content, str) else message.content
        if not failure_client_enabled and not usage_client_enabled:
            event = usage.inspect_openai_responses_event_json(body)
            if usage.is_model_provider_usage_billable(flow):
                codex_output_timing.observe_client_event(flow, event.event_type, message.timestamp)
            return
        event = usage.inspect_openai_responses_client_event_json(body)
        if failure_client_enabled:
            model_provider_failure.observe_websocket_client_event(
                flow,
                request_kind=event.request_kind,
                is_prewarm=event.is_prewarm,
            )
        if usage_enabled and usage.is_model_provider_usage_billable(flow):
            codex_output_timing.observe_client_event(flow, event.event_type, message.timestamp)
        if usage_client_enabled:
            model_websocket_usage.observe_client_event(flow, event)
        return
    body = message.content.encode() if isinstance(message.content, str) else message.content
    failure_enabled = model_provider_failure.should_observe_websocket_server_event(flow)
    usage_enabled = model_websocket_usage.is_enabled(flow)
    if not failure_enabled and not usage_enabled:
        return
    event = usage.inspect_openai_responses_event_json(body)
    if usage_enabled and usage.is_model_provider_usage_billable(flow):
        codex_output_timing.observe_server_event(flow, event.event_type)
    inspection = usage.inspect_openai_responses_server_event(
        event,
        include_lifecycle=(
            model_websocket_usage.should_inspect_server_lifecycle(flow, event)
            if usage_enabled
            else False
        ),
        include_usage=usage_enabled,
        include_failure=failure_enabled,
    )
    if failure_enabled:
        model_provider_failure.observe_websocket_server_event(flow, inspection.failure)
    if usage_enabled:
        model_websocket_usage.feed_usage(flow, inspection)


def _response_size(flow: http.HTTPFlow) -> int:
    if flow.response is None:
        return 0

    streamed_size = response_streaming.streamed_response_size(flow)
    if streamed_size is not None:
        return streamed_size

    parsed_content_length = content_length.parse(
        flow.response.headers.get_all("Content-Length"),
        max_value=NETWORK_LOG_MAX_SAFE_SIZE,
    )
    if parsed_content_length.kind != "valid":
        return 0
    return parsed_content_length.value


def _request_size(flow: http.HTTPFlow) -> int:
    streamed_size = request_streaming.streamed_request_size(flow)
    if streamed_size is not None:
        return streamed_size
    return len(flow.request.raw_content or b"")


def _release_terminal_flow_state(
    flow: http.HTTPFlow,
    *,
    release_tracking: bool,
    release_aws_sigv4_body_admission: bool = True,
) -> None:
    if release_tracking:
        websocket_framing.log_limit_violation(flow)
        websocket_retention.release_terminal_messages(flow)
        terminal_usage.release_model_websocket_terminal_state(flow)
        codex_output_timing.release_flow_state(flow)
    request_classification.pop_cached_classification(flow)
    flow.metadata.pop(_FIREWALL_AUTH_APPLIED_IN_REQUESTHEADERS, None)
    release_aws_sigv4_request_inspection(flow)
    flow.metadata.pop(metadata_keys.WEBSOCKET_UPGRADE_REQUEST, None)
    flow.metadata.pop(metadata_keys.RESPONSE_ENCODING_NEGOTIATION, None)
    request_streaming.release_request_stream_state(flow)
    connector_diagnostics.release_flow_state(flow)
    codex_model_catalog_cache.release_flow_state(flow)
    response_streaming.release_response_stream_state(flow)
    auth_base_forwarder.release_forward_request_admission_from_flow(flow)
    if release_aws_sigv4_body_admission:
        aws_sigv4_body_admission.release_from_flow(flow)
    if release_tracking:
        model_provider_failure.release_flow(flow)
        terminal_usage.release_tracked_flow(flow)
        websocket_framing.release_flow_state(flow)


def websocket_end(flow: http.HTTPFlow) -> None:
    """Settle model-provider failure and usage for a WebSocket-upgraded response."""
    try:
        model_provider_failure.finish_websocket(flow)
        run_id = flow_metadata.run_id(flow.metadata)
        if run_id:
            terminal_usage.report_model_provider_usage_once(flow, run_id)
    finally:
        _release_terminal_flow_state(flow, release_tracking=True)


def _should_retain_model_websocket_tracking(flow: http.HTTPFlow) -> bool:
    return response_streaming.is_confirmed_websocket_upgrade_response(
        flow,
        websocket_header_work_limit=_WEBSOCKET_HANDSHAKE_HEADER_WORK_LIMIT,
    ) and (
        model_websocket_usage.is_enabled(flow)
        or model_provider_failure.should_observe_websocket_server_event(flow)
    )


def response(flow: http.HTTPFlow) -> Awaitable[None] | None:
    try:
        continuation = _handle_response(flow)
    except BaseException:
        _release_terminal_flow_state(
            flow,
            release_tracking=True,
            release_aws_sigv4_body_admission=flow.websocket is None,
        )
        raise
    if continuation is not None:
        return _complete_response(flow, continuation)

    release_tracking = True
    try:
        release_tracking = not _should_retain_model_websocket_tracking(flow)
    finally:
        _release_terminal_flow_state(
            flow,
            release_tracking=release_tracking,
            release_aws_sigv4_body_admission=flow.websocket is None,
        )
    return None


async def _complete_response(
    flow: http.HTTPFlow,
    continuation: Awaitable[None],
) -> None:
    release_tracking = True
    try:
        await continuation
        release_tracking = not _should_retain_model_websocket_tracking(flow)
    finally:
        _release_terminal_flow_state(
            flow,
            release_tracking=release_tracking,
            release_aws_sigv4_body_admission=flow.websocket is None,
        )


def _handle_response(flow: http.HTTPFlow) -> Awaitable[None] | None:
    """
    Handle response and log network activity.
    """
    # Pop before any early return so tracked flows consume timing exactly once.
    start_time = flow.metadata.pop(metadata_keys.HTTP_REQUEST_START_MONOTONIC, None)

    run_id = flow_metadata.run_id(flow.metadata)
    if not run_id:
        # Unregistered sandbox: the request handler returned before populating
        # metadata, so none of this handler's work applies.
        return None

    latency_ms = elapsed_ms(start_time)
    original_url = flow.metadata[metadata_keys.ORIGINAL_URL]
    firewall_action = flow_metadata.firewall_action(flow.metadata)

    connector_diagnostics.maybe_replace_response(flow, original_url=original_url)
    validation = codex_model_catalog_cache.finalize_response(flow)
    if validation is not None:
        return _finish_response_after_catalog_validation(
            flow,
            validation,
            run_id=run_id,
            latency_ms=latency_ms,
            original_url=original_url,
            firewall_action=firewall_action,
        )
    _finish_response_handling(
        flow,
        run_id=run_id,
        latency_ms=latency_ms,
        original_url=original_url,
        firewall_action=firewall_action,
    )
    return None


async def _finish_response_after_catalog_validation(
    flow: http.HTTPFlow,
    validation: Awaitable[None],
    *,
    run_id: str,
    latency_ms: int,
    original_url: str,
    firewall_action: str,
) -> None:
    await validation
    _finish_response_handling(
        flow,
        run_id=run_id,
        latency_ms=latency_ms,
        original_url=original_url,
        firewall_action=firewall_action,
    )


def _finish_response_handling(
    flow: http.HTTPFlow,
    *,
    run_id: str,
    latency_ms: int,
    original_url: str,
    firewall_action: str,
) -> None:

    request_size = _request_size(flow)
    status_code = flow.response.status_code if flow.response else 0
    model_provider_failure.finish_http_response(flow)

    # Log HTTP network entry for this run. DNS/kmsg rows are produced by the
    # Rust runner; api-contracts is the shared network-log schema boundary.
    # [NETWORK_LOG_FIELDS]
    network_log_path = flow_metadata.network_log_path(flow.metadata)
    proxy_log_path = flow_metadata.proxy_log_path(flow.metadata)
    if network_log_path:
        response_size = _response_size(flow)
        log_entry, raw_url = _http_network_log_entry(
            flow,
            action=firewall_action,
            status_code=status_code,
            latency_ms=latency_ms,
            request_size=request_size,
            response_size=response_size,
        )

        # Add captured header names, selected safe header values, and bodies when enabled
        if flow_metadata.should_capture_body(flow.metadata):
            body_capture.add_capture_fields(flow, log_entry)

        log_http_network_entry(network_log_path, log_entry, raw_url)

    response_streaming.finalize_model_sse_usage(flow)
    response_streaming.finalize_model_json_usage(flow, proxy_log_path)

    if not model_websocket_usage.is_enabled(flow):
        run_usage.observe(flow, flow.metadata.get(metadata_keys.MODEL_PROVIDER_USAGE))
        run_usage.finish(flow)

    terminal_usage.report_model_provider_usage_once(flow, run_id)

    # Billable connector usage observation (issue #9504, stage 0).
    response_streaming.finalize_connector_response_state(flow)
    usage.report_connector_usage(flow, run_id)

    # Invalidate firewall header cache on 401 so next request gets fresh headers.
    # Also request a force-refresh so the next /firewall/auth fetch refreshes
    # the access token regardless of DB tokenExpiresAt — the provider just told
    # us the token is no longer valid, overriding whatever the DB believes.
    # request_force_refresh enforces a cooldown so a persistent non-token 401
    # can't amplify into a loop of provider refresh calls (#9860).
    if (
        flow.response
        and flow.response.status_code == _HTTP_STATUS_UNAUTHORIZED
        and flow_metadata.firewall_base(flow.metadata)
    ):
        cache_key = flow.metadata.get(metadata_keys.FIREWALL_AUTH_CACHE_KEY)
        cache_entry_identity = flow.metadata.get(metadata_keys.FIREWALL_AUTH_CACHE_ENTRY_IDENTITY)
        if isinstance(cache_key, FirewallAuthCacheKey) and isinstance(
            cache_entry_identity, FirewallAuthCacheEntryIdentity
        ):
            invalidate_cached_firewall_headers(cache_key, cache_entry_identity)

    # Log HTTP error responses to the per-job proxy JSONL log.
    if flow.response and flow.response.status_code >= _HTTP_STATUS_ERROR_MIN:
        url_projection = project_url_for_proxy_log(original_url)
        log_proxy_entry(
            proxy_log_path,
            "warn",
            f"Response {flow.response.status_code}: {url_projection.value}",
            type="http_error",
            status=flow.response.status_code,
            **url_projection.truncation_fields(),
        )


def error(flow: http.HTTPFlow) -> None:
    try:
        _handle_error(flow)
    finally:
        _release_terminal_flow_state(flow, release_tracking=True)


def _handle_error(flow: http.HTTPFlow) -> None:
    """Handle registered-run terminal work after a connection-level error."""
    start_time = flow.metadata.pop(metadata_keys.HTTP_REQUEST_START_MONOTONIC, None)
    codex_model_catalog_cache.handle_error(flow)

    run_id = flow_metadata.run_id(flow.metadata)
    network_log_path = flow_metadata.network_log_path(flow.metadata)
    proxy_log_path = flow_metadata.proxy_log_path(flow.metadata)

    if not run_id:
        return

    latency_ms = elapsed_ms(start_time)
    original_url = flow.metadata[metadata_keys.ORIGINAL_URL]
    firewall_action = flow_metadata.firewall_action(flow.metadata)

    connector_diagnostics.handle_error(flow)
    model_provider_failure.finish_connection_error(flow)

    request_size = _request_size(flow)
    error_msg = flow.error.msg if flow.error else "unknown error"

    if network_log_path:
        # [NETWORK_LOG_FIELDS] — HTTP error fields; api-contracts is the shared schema boundary.
        log_entry, raw_url = _http_network_log_entry(
            flow,
            action=firewall_action,
            status_code=0,
            latency_ms=latency_ms,
            request_size=request_size,
            response_size=0,
        )
        log_entry["error"] = error_msg

        if flow_metadata.should_capture_body(flow.metadata):
            body_capture.add_capture_fields(flow, log_entry, response_incomplete=True)

        log_http_network_entry(network_log_path, log_entry, raw_url)

    # Report proxy-extracted usage for model provider responses.
    # The SSE parser may have partially populated model_provider_usage before the
    # connection error occurred.  Partial data is better than none.
    response_streaming.finalize_model_sse_usage(flow)
    response_streaming.observe_interrupted_model_json(flow)
    run_usage.observe(flow, flow.metadata.get(metadata_keys.MODEL_PROVIDER_USAGE))
    run_usage.finish(flow, interrupted=True)
    terminal_usage.report_model_provider_usage_once(flow, run_id)

    # Connector parsers opt into interrupted reporting only when accumulated
    # partial observations are independently billable. Ordinary JSON parsers do
    # not opt in because incomplete responses could reach request-side hints.
    if response_streaming.finalize_interrupted_connector_response_state(flow):
        usage.report_connector_usage(flow, run_id)

    url_projection = project_url_for_proxy_log(original_url)
    log_proxy_entry(
        proxy_log_path,
        "warn",
        f"Error: {error_msg}: {url_projection.value}",
        type="connection_error",
        error=error_msg,
        **url_projection.truncation_fields(),
    )


# ============================================================================
# Graceful Shutdown
# ============================================================================


def done():
    """Flush pending reports and forwarding workers before mitmproxy exits.

    The runner flush lifecycle waits for any active delivery worker,
    retries buffered usage and retained diagnostic reports, drains accepted
    requests, and closes admission before this hook shuts down the usage
    executor. Control admission is already closed; pending log prefixes remain
    owned by the JSONL writer. Any retryable usage outcome
    retained by completed workers is then retried synchronously.
    Auth.base forwarding does not need to finish running work during shutdown.
    Its `wait=False` worker shutdown closes admission, wakes or terminates
    affected forwards, cancels pending futures, and best-effort aborts active
    upstream work without joining daemon workers or waiting for slow upstream
    responses. JSONL writer shutdown is also bounded and best-effort; if it times
    out, process shutdown continues with accepted log entries possibly still
    pending. After joining the usage executor, retained billing and diagnostic
    work is drained through synchronous delivery. Model-provider
    failure delivery stops admission and receives one bounded drain window.
    Catalog validation and SigV4 hashing close admission and join their bounded
    off-loop work.
    """
    global _runner_control, _registry_control

    try:
        if _registry_control is not None:
            _registry_control.close()
            _registry_control = None
        if _runner_control is not None:
            _runner_control.stop()
            _runner_control = None
    finally:
        _drain_addon_workers()


def _drain_addon_workers() -> None:
    try:
        runner_flush_lifecycle.drain_and_close()
    finally:
        try:
            try:
                usage.webhook.shutdown_delivery_executor(wait=True)
                runner_flush_lifecycle.drain_delivery_work_after_executor_shutdown()
            finally:
                auth_base_forwarder.shutdown_forward_request_workers(wait=False)
        finally:
            try:
                model_provider_failure.shutdown()
            finally:
                try:
                    codex_model_catalog_cache.shutdown()
                finally:
                    try:
                        aws_sigv4_hash_executor.shutdown()
                    finally:
                        shutdown_log_writer()


# ============================================================================
# TCP Connection Handlers
# ============================================================================


def tcp_start(flow: tcp.TCPFlow) -> None:
    """Apply ``tcp_logging.start()``'s canonical registry-admission contract.

    The delegated contract includes its no-op outcomes and fail-closed flow killing before TCP
    logging metadata is installed.
    """
    tcp_logging.start(flow, registry_path=get_registry_path())


def tcp_message(flow: tcp.TCPFlow) -> None:
    """Preserve byte totals while bounding registered TCP message retention.

    The hook coalesces message events into a deferred drain, which records request and response
    byte totals before clearing retained messages.
    """
    tcp_logging.message(flow)


def tcp_end(flow: tcp.TCPFlow) -> None:
    """Log TCP connection details when it closes."""
    tcp_logging.end(flow)


def tcp_error(flow: tcp.TCPFlow) -> None:
    """Log TCP connection errors."""
    tcp_logging.error(flow)


# mitmproxy addon registration
addons = [
    server_connect,
    server_disconnected,
    server_connect_error,
    tls_clienthello,
    client_disconnected,
    request,
    responseheaders,
    websocket_message,
    websocket_end,
    response,
    error,
    tcp_start,
    tcp_message,
    tcp_end,
    tcp_error,
]
