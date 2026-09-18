"""Firewall auth flow orchestration and request mutation.

This module keeps mitmproxy HTTPFlow metadata, header/query injection,
auth.base forwarding, local failure responses, and AWS SigV4 signing together.
Cache state and platform API calls live in dedicated owner modules.
"""

import asyncio
import hashlib
import json
import urllib.parse
from collections.abc import Callable
from dataclasses import dataclass, field
from enum import Enum

from mitmproxy import http

import aws_sigv4_hash_executor
import flow_metadata
import flow_metadata_keys as metadata_keys
import http_local_responses
import matching
from auth_base_forwarder import (
    AuthBaseForwardingSaturatedError,
    ForwardRequestPreSubmitRejectedError,
    forward_request,
    release_forward_request_admission_from_flow,
    take_forward_request_admission_from_flow,
)
from auth_base_rewrite import (
    MAX_AUTH_BASE_QUERY_PAIRS,
    AuthBaseQueryTooManyPairsError,
    build_rewrite_url,
)
from auth_base_transport import (
    MAX_AUTH_BASE_REQUEST_BODY_BYTES,
    ForwardedRequestTooLargeError,
    InvalidAuthBaseRequestHeadersError,
    InvalidResolvedAuthHeaderError,
    forwarded_auth_base_client_header_pairs,
    header_pairs,
    resolved_auth_header_pairs,
)
from aws_sigv4 import (
    AwsSigV4BodyHash,
    AwsSigV4Credentials,
    AwsSigV4RequestInspection,
    AwsSigV4SigningError,
    hash_request_body,
    inspect_request,
    sign_request,
)
from aws_sigv4_body_admission import MAX_AWS_SIGV4_REQUEST_BODY_BYTES
from firewall_auth_cache import (
    FIREWALL_AUTH_REGISTRY_GENERATION_ATTRIBUTE,
    FirewallAuthCacheEntryIdentity,
    FirewallAuthCacheKey,
    FirewallAuthFetchSaturatedError,
    InvalidBillableAuthExpiryError,
    get_firewall_headers,
)
from firewall_auth_client import (
    ConnectorNotConfiguredError,
    FirewallAuthApiError,
    FirewallAuthRequest,
    InsufficientCreditsError,
)
from firewall_auth_config import auth_config_injects_credentials
from logging_utils import log_proxy_entry
from runtime_url_parsing import split_runtime_url
from url_syntax import has_unsafe_runtime_url_syntax


class FirewallAuthHandlingResult(Enum):
    """Request ownership outcome after firewall auth handling."""

    CONTINUE_UPSTREAM = "continue_upstream"
    INLINE_PROVIDER_RESPONSE = "inline_provider_response"
    LOCAL_RESPONSE = "local_response"


class FirewallHeaderPhaseAuthResult(Enum):
    """Firewall auth result for requestheaders() stream-capture probing."""

    APPLIED = "applied"
    FALLBACK = "fallback"
    REJECTED = "rejected"


class _FirewallAuthPlanFailure(Enum):
    """Canonical pre-resolution policy failure for both hook phases."""

    UNSAFE_METHOD = "unsafe_method"
    METHOD_OVERRIDE = "method_override"
    INSECURE_TRANSPORT = "insecure_transport"
    AUTH_UNAVAILABLE = "auth_unavailable"


type CurrentFirewallAuthorizationGuard = Callable[[], bool]


_HTTP_STATUS_INFORMATIONAL_MIN = 100
_HTTP_STATUS_SUCCESS_MIN = 200
_HTTP_STATUS_NO_CONTENT = 204
_HTTP_STATUS_RESET_CONTENT = 205
_HTTP_STATUS_NOT_MODIFIED = 304
_HTTP_STATUS_CLIENT_ERROR_MIN = 400
_HTTP_STATUS_SERVER_ERROR_MIN = 500
AUTH_BASE_FORWARDING_SATURATED_ERROR = "auth_base_forwarding_saturated"
FIREWALL_AUTH_FETCH_SATURATED_ERROR = "firewall_auth_fetch_saturated"
AWS_SIGV4_REQUEST_BODY_ADMISSION_SATURATED_ERROR = "aws_sigv4_request_body_admission_saturated"
AWS_SIGV4_REQUEST_BODY_LENGTH_REQUIRED_ERROR = "aws_sigv4_request_body_length_required"
AWS_SIGV4_REQUEST_BODY_TOO_LARGE_ERROR = "aws_sigv4_request_body_too_large"
# Auth-base uses a separately named request-target policy because its forwarding
# behavior can evolve independently, while the shared 64 KiB scale remains well
# above ordinary connector request targets.
MAX_AUTH_BASE_REQUEST_TARGET_BYTES = 64 * 1024
# Managed SigV4 request inspection uses the pinned HTTP/2 stack's 64 KiB
# decompressed header-list policy. HPACK accounts for 32 bytes of overhead per
# field; using the same formula also bounds HTTP/1 header count before decoding.
MAX_AWS_SIGV4_REQUEST_TARGET_BYTES = 64 * 1024
MAX_AWS_SIGV4_REQUEST_HEADER_LIST_BYTES = 64 * 1024
AWS_SIGV4_REQUEST_HEADER_FIELD_OVERHEAD_BYTES = 32
MAX_AWS_SIGV4_REQUEST_HEADER_FIELDS = (
    MAX_AWS_SIGV4_REQUEST_HEADER_LIST_BYTES // AWS_SIGV4_REQUEST_HEADER_FIELD_OVERHEAD_BYTES
)
_FIREWALL_AUTH_IDENTITY_CACHE_KEY = "_firewallAuthIdentityCache"
_MISSING_AWS_SIGV4_ORIGINAL_URL = object()


@dataclass(frozen=True)
class _FirewallAuthIdentityCacheEntry:
    """One resolved API identity retained for its sandbox snapshot lifetime."""

    api_entry: dict = field(repr=False)
    auth_identity: str


@dataclass(frozen=True)
class _ResolvedFirewallAuthIdentity:
    """Content identity and request-local body preparation for one lookup."""

    auth_identity: str
    auth_request: FirewallAuthRequest = field(repr=False)


@dataclass
class _FirewallAuthIdentityCache:
    """Lazy auth identities owned by one published sandbox registry snapshot."""

    entries: dict[tuple[int, str, str], _FirewallAuthIdentityCacheEntry] = field(
        default_factory=dict
    )


@dataclass(frozen=True)
class _AwsSigV4FlowRepresentationIdentity:
    """Immutable raw objects that identify one flow request representation."""

    original_url: object = field(repr=False)
    raw_path: bytes = field(repr=False)
    raw_header_fields: tuple[tuple[bytes, bytes], ...] = field(repr=False)

    def is_current(self, other: "_AwsSigV4FlowRepresentationIdentity") -> bool:
        return (
            self.original_url is other.original_url
            and self.raw_path is other.raw_path
            and self.raw_header_fields is other.raw_header_fields
        )


@dataclass(frozen=True)
class _AwsSigV4RequestInput:
    """Bounded decoded input passed to the low-level SigV4 boundary."""

    url: str = field(repr=False)
    headers: tuple[tuple[str, str], ...] = field(repr=False)


@dataclass(frozen=True)
class _AwsSigV4FlowInspection:
    """Flow-local inspection result for one immutable raw representation."""

    identity: _AwsSigV4FlowRepresentationIdentity = field(repr=False)
    request_input: _AwsSigV4RequestInput | None = field(repr=False)
    inspection: AwsSigV4RequestInspection | None = field(repr=False)

    @property
    def requires_body(self) -> bool:
        if self.inspection is None:
            return True
        return self.inspection.requires_body


@dataclass(frozen=True)
class _FirewallAuthContext:
    """Request-local firewall auth inputs for the hook orchestration path."""

    allow: matching.FirewallAllow
    firewall_base: str
    proxy_log_path: str
    auth_request: FirewallAuthRequest
    auth_cache_key: FirewallAuthCacheKey


@dataclass(frozen=True)
class _FirewallAuthPlan:
    """Pure firewall-auth policy shared by requestheaders and request hooks."""

    injects_credentials: bool
    needs_resolution: bool
    uses_auth_base: bool
    uses_aws_sigv4: bool
    body_dependent: bool
    failure: _FirewallAuthPlanFailure | None


@dataclass(frozen=True)
class _ResolvedFirewallAuth:
    """Validated auth-service result consumed by either hook phase."""

    token_meta: dict
    headers: dict
    query: dict | None
    base: str | None
    aws_sigv4: AwsSigV4Credentials | None
    cache_entry_identity: FirewallAuthCacheEntryIdentity | None


def is_billable_firewall(firewall_name: str, sandbox_info: dict) -> bool:
    """Return whether this firewall should emit connector/model usage."""
    return firewall_name in sandbox_info["billableFirewalls"]


def _prepare_firewall_metadata(
    flow: http.HTTPFlow,
    allow: matching.FirewallAllow,
    sandbox_info: dict,
) -> None:
    """Store firewall match metadata once before auth resolution starts."""
    api_entry = allow.api_entry
    firewall_base = api_entry["base"]
    api_id = api_entry.get("id", firewall_base)
    firewall_billable = is_billable_firewall(allow.name, sandbox_info)

    flow.metadata[metadata_keys.FIREWALL_BASE] = firewall_base
    flow.metadata[metadata_keys.FIREWALL_API_ID] = api_id
    flow.metadata[metadata_keys.FIREWALL_NAME] = allow.name
    flow.metadata[metadata_keys.FIREWALL_PERMISSION] = allow.permission or ""
    flow.metadata[metadata_keys.FIREWALL_RULE_MATCH] = allow.rule or ""
    flow.metadata[metadata_keys.FIREWALL_PARAMS] = allow.params
    flow.metadata[metadata_keys.FIREWALL_BILLABLE] = firewall_billable
    flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = sandbox_info.get("modelUsageProvider")


def prepare_firewall_metadata(
    flow: http.HTTPFlow,
    allow: matching.FirewallAllow,
    sandbox_info: dict,
) -> None:
    """Store matched-firewall metadata for callers outside this module."""
    _prepare_firewall_metadata(flow, allow, sandbox_info)


def _build_firewall_auth_context(
    flow: http.HTTPFlow,
    allow: matching.FirewallAllow,
    sandbox_info: dict,
    *,
    needs_resolution: bool,
) -> _FirewallAuthContext:
    """Capture request-local auth inputs after matched-firewall metadata exists."""
    api_entry = allow.api_entry
    auth_config = api_entry.get("auth", {})
    firewall_base = flow.metadata[metadata_keys.FIREWALL_BASE]
    api_id = flow.metadata[metadata_keys.FIREWALL_API_ID]
    run_id = flow_metadata.run_id(flow.metadata)
    custom_connector_id = api_entry.get("customConnectorId")
    source_id = api_entry.get("sourceId")
    connector_routing_variables = sandbox_info.get("connectorRoutingVariables", {})
    matched_firewall: dict | None = None
    if needs_resolution and isinstance(custom_connector_id, str):
        routing_variables = connector_routing_variables.get(f"custom:{custom_connector_id}")
        if not isinstance(routing_variables, dict):
            raise TypeError("custom connector routing variables are missing from proxy registry")
        matched_firewall = {
            "name": allow.name,
            "apiId": api_id,
            "customConnectorId": custom_connector_id,
            "routingVariables": routing_variables,
            **({"sourceId": source_id} if isinstance(source_id, str) else {}),
        }
    elif needs_resolution:
        routing_variables = connector_routing_variables.get(f"builtin:{allow.name}")
        if isinstance(routing_variables, dict):
            matched_firewall = {
                "name": allow.name,
                "apiId": api_id,
                "connectorSlug": allow.name,
                "routingVariables": routing_variables,
                **({"sourceId": source_id} if isinstance(source_id, str) else {}),
            }
    auth_request = FirewallAuthRequest(
        sandbox_token=sandbox_info.get("sandboxToken", ""),
        encrypted_secrets=sandbox_info.get("encryptedSecrets") or "",
        auth_headers=auth_config.get("headers", {}),
        auth_base=auth_config.get("base"),
        auth_query=auth_config.get("query"),
        auth_aws_sigv4=auth_config.get("awsSigv4"),
        secret_connector_map=sandbox_info.get("secretConnectorMap"),
        secret_connector_metadata_map=sandbox_info.get("secretConnectorMetadataMap"),
        vars_map=sandbox_info.get("vars"),
        firewall_billable=bool(flow.metadata[metadata_keys.FIREWALL_BILLABLE]),
        matched_firewall=matched_firewall,
    )
    resolved_identity = _cached_firewall_auth_identity(
        sandbox_info=sandbox_info,
        api_entry=api_entry,
        firewall_name=allow.name,
        firewall_base=firewall_base,
        auth_request=auth_request,
    )
    auth_cache_key = FirewallAuthCacheKey(
        run_id=run_id,
        api_id=api_id,
        auth_identity=resolved_identity.auth_identity,
        registry_generation=_firewall_auth_registry_generation(sandbox_info),
    )
    flow.metadata[metadata_keys.FIREWALL_AUTH_CACHE_KEY] = auth_cache_key
    return _FirewallAuthContext(
        allow=allow,
        firewall_base=firewall_base,
        proxy_log_path=flow_metadata.proxy_log_path(flow.metadata),
        auth_request=resolved_identity.auth_request,
        auth_cache_key=auth_cache_key,
    )


def _firewall_auth_registry_generation(sandbox_info: dict) -> int | None:
    generation = getattr(sandbox_info, FIREWALL_AUTH_REGISTRY_GENERATION_ATTRIBUTE, None)
    if isinstance(generation, bool) or not isinstance(generation, int):
        return None
    return generation


def _build_firewall_auth_identity(
    *,
    firewall_name: str,
    firewall_base: str,
    auth_request: FirewallAuthRequest,
) -> _ResolvedFirewallAuthIdentity:
    normal_body = auth_request.to_bytes(force_refresh=False)
    sandbox_token_sha256 = hashlib.sha256(auth_request.sandbox_token.encode("utf-8")).hexdigest()
    material = {
        "firewallName": firewall_name,
        "firewallBase": firewall_base,
        "authBodySha256": hashlib.sha256(normal_body).hexdigest(),
        "sandboxTokenSha256": sandbox_token_sha256,
    }
    canonical_json = json.dumps(material, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return _ResolvedFirewallAuthIdentity(
        auth_identity=hashlib.sha256(canonical_json).hexdigest(),
        auth_request=auth_request.with_prepared_normal_body(normal_body),
    )


def _cached_firewall_auth_identity(
    *,
    sandbox_info: dict,
    api_entry: dict,
    firewall_name: str,
    firewall_base: str,
    auth_request: FirewallAuthRequest,
) -> _ResolvedFirewallAuthIdentity:
    cache = sandbox_info.get(_FIREWALL_AUTH_IDENTITY_CACHE_KEY)
    if not isinstance(cache, _FirewallAuthIdentityCache):
        cache = _FirewallAuthIdentityCache()
        sandbox_info[_FIREWALL_AUTH_IDENTITY_CACHE_KEY] = cache

    key = (id(api_entry), firewall_name, firewall_base)
    entry = cache.entries.get(key)
    if entry is not None and entry.api_entry is api_entry:
        return _ResolvedFirewallAuthIdentity(
            auth_identity=entry.auth_identity,
            auth_request=auth_request,
        )

    resolved_identity = _build_firewall_auth_identity(
        firewall_name=firewall_name,
        firewall_base=firewall_base,
        auth_request=auth_request,
    )
    cache.entries[key] = _FirewallAuthIdentityCacheEntry(
        api_entry=api_entry,
        auth_identity=resolved_identity.auth_identity,
    )
    return resolved_identity


def _request_method_forbids_managed_credentials(method: str) -> bool:
    return method.upper() in ("TRACE", "TRACK")


def _set_matched_firewall_failure_response(
    flow: http.HTTPFlow,
    *,
    status: int,
    action: str,
    error_code: str,
    message: str,
    permission: str,
    connectors: list[str] | None = None,
    failure_reason: str | None = None,
) -> None:
    """Set the common matched-firewall auth/forward failure response."""
    # `firewall_action` records the firewall permission decision
    # (ALLOW/DENY/BLOCK); `firewall_error` records post-decision execution
    # failures. They are orthogonal: for example, action=ALLOW can pair with
    # an auth or forwarding error when the firewall granted the request but
    # the addon could not fulfill it. See #10493.
    firewall_base = flow.metadata[metadata_keys.FIREWALL_BASE]
    _mark_matched_firewall_failure(flow, action=action, error_code=error_code)
    body: dict[str, object] = {
        "error": error_code,
        "message": message,
        "permission": permission,
        "base": firewall_base,
    }
    if connectors:
        body["connectors"] = connectors
    if failure_reason:
        body["failureReason"] = failure_reason
    flow.response = http_local_responses.make_local_json_response(
        flow,
        status,
        body,
    )


def _mark_matched_firewall_failure(
    flow: http.HTTPFlow,
    *,
    action: str,
    error_code: str,
) -> None:
    flow_metadata.set_firewall_decision(flow.metadata, action, error=error_code)


def _merge_auth_headers(
    headers,
    auth_headers: dict[str, str],
) -> list[tuple[str, str]]:
    """Append resolved auth headers after replacing same-name client pairs.

    Resolved auth headers are validated and filtered before merge. Any client
    header pair with the same lowercased name is removed so the resolved value
    wins in the auth.base rewrite path.
    """
    pairs = header_pairs(headers)
    auth_pairs = resolved_auth_header_pairs(auth_headers)
    override_names = {name.lower() for name, _value in auth_pairs}
    return [
        (name, value) for name, value in pairs if name.lower() not in override_names
    ] + auth_pairs


def _record_firewall_auth_success_metadata(
    flow: http.HTTPFlow,
    resolved_auth: _ResolvedFirewallAuth,
) -> None:
    token_meta = resolved_auth.token_meta
    flow_metadata.set_firewall_decision(flow.metadata, "ALLOW")
    flow.metadata[metadata_keys.AUTH_RESOLVED_SECRETS] = token_meta.get("resolved_secrets", [])
    flow.metadata[metadata_keys.AUTH_REFRESHED_CONNECTORS] = token_meta.get(
        "refreshed_connectors", []
    )
    flow.metadata[metadata_keys.AUTH_REFRESHED_SECRETS] = token_meta.get("refreshed_secrets", [])
    flow.metadata[metadata_keys.AUTH_CACHE_HIT] = token_meta.get("cache_hit", False)
    if resolved_auth.cache_entry_identity is not None:
        flow.metadata[metadata_keys.FIREWALL_AUTH_CACHE_ENTRY_IDENTITY] = (
            resolved_auth.cache_entry_identity
        )


def _empty_firewall_auth_metadata() -> dict:
    return {
        "headers": {},
        "resolved_secrets": [],
        "refreshed_connectors": [],
        "refreshed_secrets": [],
        "cache_hit": False,
    }


def _auth_config_uses_body_dependent_auth(
    flow: http.HTTPFlow,
    auth_config: object,
) -> bool:
    if not isinstance(auth_config, dict):
        return False
    auth_base = auth_config.get("base")
    if isinstance(auth_base, str) and auth_base:
        return True
    auth_aws_sigv4 = auth_config.get("awsSigv4")
    return (
        isinstance(auth_aws_sigv4, dict)
        and bool(auth_aws_sigv4)
        and aws_sigv4_request_requires_body_for_signing(flow)
    )


def _build_firewall_auth_plan(
    flow: http.HTTPFlow,
    allow: matching.FirewallAllow,
    sandbox_info: dict,
) -> _FirewallAuthPlan:
    """Derive shared firewall-auth policy without mutating request state."""
    auth_config = allow.api_entry.get("auth", {})
    uses_auth_base = (
        isinstance(auth_config, dict)
        and isinstance(auth_config.get("base"), str)
        and bool(auth_config["base"])
    )
    uses_aws_sigv4 = (
        isinstance(auth_config, dict)
        and isinstance(auth_config.get("awsSigv4"), dict)
        and bool(auth_config["awsSigv4"])
    )
    injects_credentials = auth_config_injects_credentials(auth_config)
    needs_resolution = injects_credentials or is_billable_firewall(allow.name, sandbox_info)

    failure = None
    if injects_credentials and _request_method_forbids_managed_credentials(flow.request.method):
        failure = _FirewallAuthPlanFailure.UNSAFE_METHOD
    elif injects_credentials and "x-http-method-override" in flow.request.headers:
        # The firewall authorizes the wire method. Providers such as Mailchimp
        # can reinterpret this header as DELETE even when only POST is allowed.
        failure = _FirewallAuthPlanFailure.METHOD_OVERRIDE
    elif injects_credentials and flow.request.scheme.lower() != "https":
        failure = _FirewallAuthPlanFailure.INSECURE_TRANSPORT
    elif needs_resolution and not sandbox_info.get("encryptedSecrets"):
        failure = _FirewallAuthPlanFailure.AUTH_UNAVAILABLE

    return _FirewallAuthPlan(
        injects_credentials=injects_credentials,
        needs_resolution=needs_resolution,
        uses_auth_base=uses_auth_base,
        uses_aws_sigv4=uses_aws_sigv4,
        body_dependent=_auth_config_uses_body_dependent_auth(flow, auth_config),
        failure=failure,
    )


async def _resolve_firewall_auth(
    plan: _FirewallAuthPlan,
    context: _FirewallAuthContext,
) -> dict:
    if not plan.needs_resolution:
        return _empty_firewall_auth_metadata()
    return await get_firewall_headers(
        context.auth_cache_key,
        context.auth_request,
    )


def _validate_resolved_firewall_auth(
    plan: _FirewallAuthPlan,
    token_meta: object,
) -> _ResolvedFirewallAuth:
    if not isinstance(token_meta, dict):
        raise TypeError("resolved firewall auth metadata must be an object")

    headers = token_meta.get("headers")
    if not isinstance(headers, dict):
        raise TypeError("resolved auth headers are missing")
    query = token_meta.get("query")
    if query is not None and not isinstance(query, dict):
        raise TypeError("resolved auth query must be an object")

    base_value = token_meta.get("base")
    if plan.uses_auth_base:
        if not isinstance(base_value, str) or not base_value:
            raise ValueError("resolved auth base is missing")
        base = base_value
    else:
        if base_value is not None:
            raise ValueError("resolved auth base is unexpected")
        base = None

    aws_sigv4_value = token_meta.get("aws_sigv4")
    if plan.uses_aws_sigv4:
        if not isinstance(aws_sigv4_value, AwsSigV4Credentials):
            raise ValueError("resolved AWS SigV4 credentials are missing")
        aws_sigv4 = aws_sigv4_value
    else:
        if aws_sigv4_value is not None:
            raise ValueError("resolved AWS SigV4 credentials are unexpected")
        aws_sigv4 = None

    cache_entry_identity_value = token_meta.get("cache_entry_identity")
    if plan.needs_resolution:
        if not isinstance(cache_entry_identity_value, FirewallAuthCacheEntryIdentity):
            raise TypeError("resolved auth cache entry identity is missing")
        cache_entry_identity = cache_entry_identity_value
    else:
        if cache_entry_identity_value is not None:
            raise ValueError("resolved auth cache entry identity is unexpected")
        cache_entry_identity = None

    return _ResolvedFirewallAuth(
        token_meta=token_meta,
        headers=headers,
        query=query,
        base=base,
        aws_sigv4=aws_sigv4,
        cache_entry_identity=cache_entry_identity,
    )


def _restore_header_phase_probe_state(
    flow: http.HTTPFlow,
    *,
    metadata_snapshot: dict,
    request_headers_snapshot: http.Headers,
    request_url_snapshot: str,
) -> None:
    flow.metadata.clear()
    flow.metadata.update(metadata_snapshot)
    flow.request.url = request_url_snapshot
    flow.request.headers = http.Headers(request_headers_snapshot.fields)


def _apply_header_query_injection(
    flow: http.HTTPFlow,
    *,
    headers: dict[str, str],
    resolved_query: dict | None,
) -> None:
    auth_pairs = resolved_auth_header_pairs(headers)
    if auth_pairs:
        resolved_fields_by_name: dict[bytes, tuple[bytes, bytes]] = {}
        for header_name, header_value in auth_pairs:
            encoded_name = header_name.encode("ascii")
            resolved_fields_by_name[encoded_name.lower()] = (
                encoded_name,
                header_value.encode("latin-1"),
            )

        remaining_fields = resolved_fields_by_name.copy()
        merged_fields: list[tuple[bytes, bytes]] = []
        for header_name, header_value in flow.request.headers.fields:
            normalized_name = header_name.lower()
            if normalized_name in remaining_fields:
                _resolved_name, resolved_value = remaining_fields.pop(normalized_name)
                merged_fields.append((header_name, resolved_value))
            elif normalized_name not in resolved_fields_by_name:
                merged_fields.append((header_name, header_value))
        merged_fields.extend(remaining_fields.values())
        flow.request.headers.fields = tuple(merged_fields)
    if resolved_query:
        remaining_query = resolved_query.copy()
        merged_query: list[tuple[str, str]] = []
        for key, value in flow.request.query.fields:
            if key in remaining_query:
                merged_query.append((key, remaining_query.pop(key)))
            elif key not in resolved_query:
                merged_query.append((key, value))
        merged_query.extend(remaining_query.items())
        flow.request.query = merged_query


def _trusted_aws_sigv4_url(flow: http.HTTPFlow) -> str:
    url = flow.metadata.get(metadata_keys.ORIGINAL_URL)
    if not isinstance(url, str):
        raise AwsSigV4SigningError("AWS request URL is unavailable")
    if has_unsafe_runtime_url_syntax(url, allow_backslash=True):
        raise AwsSigV4SigningError("AWS request URL is malformed")

    try:
        original = split_runtime_url(url)
    except ValueError as e:
        raise AwsSigV4SigningError("AWS request URL is malformed") from e

    if has_unsafe_runtime_url_syntax(flow.request.path, allow_backslash=True):
        raise AwsSigV4SigningError("AWS request URL is malformed")
    try:
        current_query = split_runtime_url(flow.request.path).query
    except ValueError as e:
        raise AwsSigV4SigningError("AWS request URL is malformed") from e
    if current_query == original.query:
        return url
    return urllib.parse.urlunsplit(
        (original.scheme, original.netloc, original.path, current_query, original.fragment)
    )


def _aws_sigv4_flow_representation_identity(
    flow: http.HTTPFlow,
) -> _AwsSigV4FlowRepresentationIdentity:
    return _AwsSigV4FlowRepresentationIdentity(
        original_url=flow.metadata.get(
            metadata_keys.ORIGINAL_URL,
            _MISSING_AWS_SIGV4_ORIGINAL_URL,
        ),
        raw_path=flow.request.data.path,
        raw_header_fields=flow.request.headers.fields,
    )


def _bounded_aws_sigv4_request_input(flow: http.HTTPFlow) -> _AwsSigV4RequestInput:
    raw_path = flow.request.data.path
    if len(raw_path) > MAX_AWS_SIGV4_REQUEST_TARGET_BYTES:
        raise AwsSigV4SigningError("AWS request target is too large")

    raw_header_fields = flow.request.headers.fields
    if len(raw_header_fields) > MAX_AWS_SIGV4_REQUEST_HEADER_FIELDS:
        raise AwsSigV4SigningError("AWS request headers are too large")

    header_list_size = 0
    for name, value in raw_header_fields:
        header_list_size += len(name) + len(value) + AWS_SIGV4_REQUEST_HEADER_FIELD_OVERHEAD_BYTES
        if header_list_size > MAX_AWS_SIGV4_REQUEST_HEADER_LIST_BYTES:
            raise AwsSigV4SigningError("AWS request headers are too large")

    return _AwsSigV4RequestInput(
        url=_trusted_aws_sigv4_url(flow),
        headers=tuple(header_pairs(flow.request.headers)),
    )


def _inspect_aws_sigv4_flow(flow: http.HTTPFlow) -> _AwsSigV4FlowInspection:
    identity = _aws_sigv4_flow_representation_identity(flow)
    cached = flow.metadata.get(metadata_keys.AWS_SIGV4_REQUEST_INSPECTION)
    if isinstance(cached, _AwsSigV4FlowInspection):
        if cached.identity.is_current(identity):
            return cached
        # Restoration or reclassification may replace immutable containers with
        # equal values. Value comparison is safe only after the cached input passed
        # the target/header bounds; rebind once so later consumers use the O(1) path.
        if cached.request_input is not None and cached.identity == identity:
            rebound = _AwsSigV4FlowInspection(
                identity=identity,
                request_input=cached.request_input,
                inspection=cached.inspection,
            )
            flow.metadata[metadata_keys.AWS_SIGV4_REQUEST_INSPECTION] = rebound
            return rebound

    try:
        request_input = _bounded_aws_sigv4_request_input(flow)
    except AwsSigV4SigningError:
        result = _AwsSigV4FlowInspection(
            identity=identity,
            request_input=None,
            inspection=None,
        )
    else:
        try:
            inspection = inspect_request(
                url=request_input.url,
                headers=list(request_input.headers),
            )
        except AwsSigV4SigningError:
            inspection = None
        result = _AwsSigV4FlowInspection(
            identity=identity,
            request_input=request_input,
            inspection=inspection,
        )
    flow.metadata[metadata_keys.AWS_SIGV4_REQUEST_INSPECTION] = result
    return result


def release_aws_sigv4_request_inspection(flow: http.HTTPFlow) -> None:
    """Release reusable SigV4 request state from one flow."""
    flow.metadata.pop(metadata_keys.AWS_SIGV4_REQUEST_INSPECTION, None)


def aws_sigv4_request_requires_body_for_signing(flow: http.HTTPFlow) -> bool:
    """Conservatively classify whether a configured SigV4 request needs its body."""
    return _inspect_aws_sigv4_flow(flow).requires_body


def _request_path_query(flow: http.HTTPFlow) -> str:
    if has_unsafe_runtime_url_syntax(flow.request.path, allow_backslash=True):
        raise ValueError("unsafe request target")
    return urllib.parse.urlparse(flow.request.path).query


def _sign_flow_request_with_aws_sigv4(
    flow: http.HTTPFlow,
    credentials: AwsSigV4Credentials,
    *,
    precomputed_body_hash: AwsSigV4BodyHash | None = None,
) -> None:
    state = _inspect_aws_sigv4_flow(flow)
    try:
        request_input = state.request_input or _bounded_aws_sigv4_request_input(flow)
        signed_url, signed_headers = sign_request(
            method=flow.request.method,
            url=request_input.url,
            headers=list(request_input.headers),
            body=flow.request.raw_content,
            credentials=credentials,
            precomputed_body_hash=precomputed_body_hash,
            inspection=state.inspection,
        )
        flow.request.url = signed_url
        flow.request.headers = http.Headers(
            [(name.encode(), value.encode()) for name, value in signed_headers]
        )
    finally:
        release_aws_sigv4_request_inspection(flow)


async def _precompute_aws_sigv4_body_hash(
    flow: http.HTTPFlow,
    *,
    plan: _FirewallAuthPlan,
    resolved_auth: _ResolvedFirewallAuth,
) -> AwsSigV4BodyHash | None:
    if plan.uses_auth_base or not plan.uses_aws_sigv4:
        return None
    if resolved_auth.aws_sigv4 is None:
        return None
    flow_inspection = _inspect_aws_sigv4_flow(flow)
    if flow_inspection.inspection is None or not flow_inspection.requires_body:
        return None

    hash_future = asyncio.get_running_loop().run_in_executor(
        aws_sigv4_hash_executor.get_executor(),
        hash_request_body,
        flow.request.raw_content,
    )
    try:
        return await asyncio.shield(hash_future)
    except asyncio.CancelledError:
        while not hash_future.done():
            try:
                await asyncio.shield(hash_future)
            except asyncio.CancelledError:
                continue
            except Exception:
                break
        if not hash_future.cancelled():
            hash_future.exception()
        raise


def _set_url_rewrite_forward_failed(
    flow: http.HTTPFlow,
    *,
    allow: matching.FirewallAllow,
    proxy_log_path: str,
    firewall_base: str,
    error_type: str,
) -> None:
    log_proxy_entry(
        proxy_log_path,
        "error",
        "URL rewrite forward failed",
        type="firewall",
        firewall_base=firewall_base,
        error_type=error_type,
    )
    _set_matched_firewall_failure_response(
        flow,
        status=502,
        action="ALLOW",
        error_code="url_rewrite_forward_failed",
        message="Failed to forward request to upstream",
        permission=allow.name,
    )


def _log_auth_base_forwarding_saturated(
    flow: http.HTTPFlow,
    *,
    proxy_log_path: str,
    firewall_base: str,
) -> None:
    flow.metadata[metadata_keys.SUPPRESS_REQUEST_BODY_CAPTURE] = True
    log_proxy_entry(
        proxy_log_path,
        "warn",
        "auth.base forwarding admission saturated",
        type="firewall",
        firewall_base=firewall_base,
    )


def _set_auth_base_forwarding_saturated(
    flow: http.HTTPFlow,
    *,
    allow: matching.FirewallAllow,
    proxy_log_path: str,
    firewall_base: str,
) -> None:
    _log_auth_base_forwarding_saturated(
        flow,
        proxy_log_path=proxy_log_path,
        firewall_base=firewall_base,
    )
    _set_matched_firewall_failure_response(
        flow,
        status=503,
        action="ALLOW",
        error_code=AUTH_BASE_FORWARDING_SATURATED_ERROR,
        message="auth.base forwarding is temporarily saturated",
        permission=allow.name,
    )


def mark_auth_base_forwarding_saturated(
    flow: http.HTTPFlow,
    *,
    proxy_log_path: str,
    firewall_base: str,
) -> None:
    """Record auth.base forwarding saturation before killing the flow."""
    _log_auth_base_forwarding_saturated(
        flow,
        proxy_log_path=proxy_log_path,
        firewall_base=firewall_base,
    )
    _mark_matched_firewall_failure(
        flow,
        action="ALLOW",
        error_code=AUTH_BASE_FORWARDING_SATURATED_ERROR,
    )


def _request_body_exceeds_auth_base_limit(flow: http.HTTPFlow) -> bool:
    body = flow.request.raw_content
    return body is not None and len(body) > MAX_AUTH_BASE_REQUEST_BODY_BYTES


def _set_auth_base_request_target_too_large(
    flow: http.HTTPFlow,
    *,
    allow: matching.FirewallAllow,
    proxy_log_path: str,
    firewall_base: str,
) -> None:
    request_target_size = len(flow.request.data.path)
    log_proxy_entry(
        proxy_log_path,
        "warn",
        "auth.base request target too large",
        type="firewall",
        firewall_base=firewall_base,
        request_target_size_bytes=request_target_size,
        request_target_limit_bytes=MAX_AUTH_BASE_REQUEST_TARGET_BYTES,
    )
    _set_matched_firewall_failure_response(
        flow,
        status=414,
        action="ALLOW",
        error_code="auth_base_request_target_too_large",
        message="auth.base request target is too large",
        permission=allow.name,
    )


def _set_auth_base_query_too_many_pairs(
    flow: http.HTTPFlow,
    *,
    allow: matching.FirewallAllow,
    proxy_log_path: str,
    firewall_base: str,
) -> None:
    log_proxy_entry(
        proxy_log_path,
        "warn",
        "auth.base rewritten query has too many pairs",
        type="firewall",
        firewall_base=firewall_base,
        query_pair_limit=MAX_AUTH_BASE_QUERY_PAIRS,
    )
    _set_matched_firewall_failure_response(
        flow,
        status=414,
        action="ALLOW",
        error_code="auth_base_query_too_many_pairs",
        message="auth.base rewritten query has too many parameters",
        permission=allow.name,
    )


def _log_auth_base_request_too_large(
    flow: http.HTTPFlow,
    *,
    proxy_log_path: str,
    firewall_base: str,
    observed_size: int | None = None,
) -> None:
    if observed_size is None:
        body = flow.request.raw_content
        observed_size = len(body) if body is not None else 0
    flow.metadata[metadata_keys.SUPPRESS_REQUEST_BODY_CAPTURE] = True
    log_proxy_entry(
        proxy_log_path,
        "warn",
        "auth.base request body too large",
        type="firewall",
        firewall_base=firewall_base,
        request_body_size_bytes=observed_size,
        request_body_limit_bytes=MAX_AUTH_BASE_REQUEST_BODY_BYTES,
    )


def _set_auth_base_request_too_large(
    flow: http.HTTPFlow,
    *,
    allow: matching.FirewallAllow,
    proxy_log_path: str,
    firewall_base: str,
    observed_size: int | None = None,
) -> None:
    _log_auth_base_request_too_large(
        flow,
        proxy_log_path=proxy_log_path,
        firewall_base=firewall_base,
        observed_size=observed_size,
    )
    _set_matched_firewall_failure_response(
        flow,
        status=413,
        action="ALLOW",
        error_code="auth_base_request_body_too_large",
        message="auth.base request body too large",
        permission=allow.name,
    )


def mark_auth_base_request_too_large(
    flow: http.HTTPFlow,
    *,
    proxy_log_path: str,
    firewall_base: str,
    observed_size: int,
) -> None:
    """Record an auth.base oversized-body failure before killing the flow."""
    _log_auth_base_request_too_large(
        flow,
        proxy_log_path=proxy_log_path,
        firewall_base=firewall_base,
        observed_size=observed_size,
    )
    _mark_matched_firewall_failure(
        flow,
        action="ALLOW",
        error_code="auth_base_request_body_too_large",
    )


def mark_auth_base_request_length_required(
    flow: http.HTTPFlow,
    *,
    proxy_log_path: str,
    firewall_base: str,
    reason: str,
) -> None:
    """Record unbounded auth.base body framing before killing the flow."""
    flow.metadata[metadata_keys.SUPPRESS_REQUEST_BODY_CAPTURE] = True
    log_proxy_entry(
        proxy_log_path,
        "warn",
        "auth.base request body requires a valid Content-Length",
        type="firewall",
        firewall_base=firewall_base,
        framing_error=reason,
        request_body_limit_bytes=MAX_AUTH_BASE_REQUEST_BODY_BYTES,
    )
    _mark_matched_firewall_failure(
        flow,
        action="ALLOW",
        error_code="auth_base_request_body_length_required",
    )


def _log_aws_sigv4_request_too_large(
    flow: http.HTTPFlow,
    *,
    proxy_log_path: str,
    firewall_base: str,
    observed_size: int | None = None,
) -> None:
    if observed_size is None:
        body = flow.request.raw_content
        observed_size = len(body) if body is not None else 0
    flow.metadata[metadata_keys.SUPPRESS_REQUEST_BODY_CAPTURE] = True
    log_proxy_entry(
        proxy_log_path,
        "warn",
        "AWS SigV4 request body too large",
        type="firewall",
        firewall_base=firewall_base,
        request_body_size_bytes=observed_size,
        request_body_limit_bytes=MAX_AWS_SIGV4_REQUEST_BODY_BYTES,
    )


def _set_aws_sigv4_request_too_large(
    flow: http.HTTPFlow,
    *,
    allow: matching.FirewallAllow,
    proxy_log_path: str,
    firewall_base: str,
) -> None:
    _log_aws_sigv4_request_too_large(
        flow,
        proxy_log_path=proxy_log_path,
        firewall_base=firewall_base,
    )
    _set_matched_firewall_failure_response(
        flow,
        status=413,
        action="ALLOW",
        error_code=AWS_SIGV4_REQUEST_BODY_TOO_LARGE_ERROR,
        message="AWS SigV4 request body too large",
        permission=allow.name,
    )


def mark_aws_sigv4_request_too_large(
    flow: http.HTTPFlow,
    *,
    proxy_log_path: str,
    firewall_base: str,
    observed_size: int,
) -> None:
    """Record an oversized body-dependent SigV4 request before killing it."""
    _log_aws_sigv4_request_too_large(
        flow,
        proxy_log_path=proxy_log_path,
        firewall_base=firewall_base,
        observed_size=observed_size,
    )
    _mark_matched_firewall_failure(
        flow,
        action="ALLOW",
        error_code=AWS_SIGV4_REQUEST_BODY_TOO_LARGE_ERROR,
    )


def mark_aws_sigv4_request_length_required(
    flow: http.HTTPFlow,
    *,
    proxy_log_path: str,
    firewall_base: str,
    reason: str,
) -> None:
    """Record unbounded SigV4 body framing before killing the flow."""
    flow.metadata[metadata_keys.SUPPRESS_REQUEST_BODY_CAPTURE] = True
    log_proxy_entry(
        proxy_log_path,
        "warn",
        "AWS SigV4 request body requires a valid Content-Length",
        type="firewall",
        firewall_base=firewall_base,
        framing_error=reason,
        request_body_limit_bytes=MAX_AWS_SIGV4_REQUEST_BODY_BYTES,
    )
    _mark_matched_firewall_failure(
        flow,
        action="ALLOW",
        error_code=AWS_SIGV4_REQUEST_BODY_LENGTH_REQUIRED_ERROR,
    )


def mark_aws_sigv4_request_admission_saturated(
    flow: http.HTTPFlow,
    *,
    proxy_log_path: str,
    firewall_base: str,
) -> None:
    """Record aggregate SigV4 body admission saturation before killing the flow."""
    flow.metadata[metadata_keys.SUPPRESS_REQUEST_BODY_CAPTURE] = True
    log_proxy_entry(
        proxy_log_path,
        "warn",
        "AWS SigV4 request-body admission saturated",
        type="firewall",
        firewall_base=firewall_base,
    )
    _mark_matched_firewall_failure(
        flow,
        action="ALLOW",
        error_code=AWS_SIGV4_REQUEST_BODY_ADMISSION_SATURATED_ERROR,
    )


def _preflight_firewall_auth(
    flow: http.HTTPFlow,
    context: _FirewallAuthContext,
    plan: _FirewallAuthPlan,
) -> FirewallAuthHandlingResult | None:
    """Handle local firewall auth failures that must happen before auth resolution."""
    if plan.uses_auth_base and len(flow.request.data.path) > MAX_AUTH_BASE_REQUEST_TARGET_BYTES:
        _set_auth_base_request_target_too_large(
            flow,
            allow=context.allow,
            proxy_log_path=context.proxy_log_path,
            firewall_base=context.firewall_base,
        )
        return FirewallAuthHandlingResult.LOCAL_RESPONSE

    if plan.uses_auth_base and _request_body_exceeds_auth_base_limit(flow):
        _set_auth_base_request_too_large(
            flow,
            allow=context.allow,
            proxy_log_path=context.proxy_log_path,
            firewall_base=context.firewall_base,
        )
        return FirewallAuthHandlingResult.LOCAL_RESPONSE

    body = flow.request.raw_content
    if (
        plan.uses_aws_sigv4
        and aws_sigv4_request_requires_body_for_signing(flow)
        and body is not None
        and len(body) > MAX_AWS_SIGV4_REQUEST_BODY_BYTES
    ):
        _set_aws_sigv4_request_too_large(
            flow,
            allow=context.allow,
            proxy_log_path=context.proxy_log_path,
            firewall_base=context.firewall_base,
        )
        return FirewallAuthHandlingResult.LOCAL_RESPONSE

    if plan.failure is _FirewallAuthPlanFailure.UNSAFE_METHOD:
        request_method = flow.request.method.upper()
        log_proxy_entry(
            context.proxy_log_path,
            "warn",
            f"Refusing to inject firewall credentials into {request_method} request",
            type="firewall",
            firewall_base=context.firewall_base,
            request_method=request_method,
        )
        _set_matched_firewall_failure_response(
            flow,
            status=403,
            action="BLOCK",
            error_code="unsafe_auth_method",
            message=f"Firewall credentials cannot be injected into {request_method} requests",
            permission=context.allow.name,
        )
        return FirewallAuthHandlingResult.LOCAL_RESPONSE

    if plan.failure is _FirewallAuthPlanFailure.METHOD_OVERRIDE:
        log_proxy_entry(
            context.proxy_log_path,
            "warn",
            "Refusing to inject firewall credentials into an HTTP method override request",
            type="firewall",
            firewall_base=context.firewall_base,
        )
        _set_matched_firewall_failure_response(
            flow,
            status=403,
            action="BLOCK",
            error_code="unsafe_auth_method_override",
            message="Use the actual HTTP method instead of X-HTTP-Method-Override",
            permission=context.allow.name,
        )
        return FirewallAuthHandlingResult.LOCAL_RESPONSE

    if plan.failure is _FirewallAuthPlanFailure.INSECURE_TRANSPORT:
        request_scheme = flow.request.scheme.lower()
        log_proxy_entry(
            context.proxy_log_path,
            "warn",
            "Refusing to inject firewall credentials over non-HTTPS transport",
            type="firewall",
            firewall_base=context.firewall_base,
            request_scheme=request_scheme,
        )
        _set_matched_firewall_failure_response(
            flow,
            status=403,
            action="BLOCK",
            error_code="insecure_transport",
            message="Firewall credentials cannot be injected over non-HTTPS transport",
            permission=context.allow.name,
        )
        return FirewallAuthHandlingResult.LOCAL_RESPONSE

    if plan.failure is _FirewallAuthPlanFailure.AUTH_UNAVAILABLE:
        log_proxy_entry(
            context.proxy_log_path,
            "error",
            f"No encryptedSecrets for firewall rule {context.firewall_base}",
            type="firewall",
            firewall_base=context.firewall_base,
        )
        _set_matched_firewall_failure_response(
            flow,
            status=502,
            action="ALLOW",
            error_code="auth_unavailable",
            message="Auth secrets not configured",
            permission=context.allow.name,
        )
        return FirewallAuthHandlingResult.LOCAL_RESPONSE

    return None


def _set_firewall_auth_resolution_failure(
    flow: http.HTTPFlow,
    context: _FirewallAuthContext,
    exc: Exception,
) -> FirewallAuthHandlingResult:
    """Map auth-resolution exceptions to local responses and metadata."""
    if isinstance(exc, FirewallAuthFetchSaturatedError):
        flow.metadata[metadata_keys.SUPPRESS_REQUEST_BODY_CAPTURE] = True
        log_proxy_entry(
            context.proxy_log_path,
            "warn",
            "Firewall auth fetch admission saturated",
            type="firewall",
            firewall_base=context.firewall_base,
        )
        _set_matched_firewall_failure_response(
            flow,
            status=503,
            action="ALLOW",
            error_code=FIREWALL_AUTH_FETCH_SATURATED_ERROR,
            message="Firewall auth is temporarily saturated",
            permission=context.allow.name,
        )
        return FirewallAuthHandlingResult.LOCAL_RESPONSE

    if isinstance(exc, ConnectorNotConfiguredError):
        log_proxy_entry(
            context.proxy_log_path,
            "info",
            f"Connector not configured for {context.firewall_base}: {exc}",
            type="firewall",
            firewall_base=context.firewall_base,
        )
        _set_matched_firewall_failure_response(
            flow,
            status=424,
            action="BLOCK",
            error_code="connector_not_configured",
            message=str(exc),
            permission=context.allow.name,
            connectors=[context.allow.name] if context.allow.name else None,
        )
        return FirewallAuthHandlingResult.LOCAL_RESPONSE

    if isinstance(exc, InsufficientCreditsError):
        log_proxy_entry(
            context.proxy_log_path,
            "warn",
            f"Billable firewall auth denied for {context.firewall_base}: {exc}",
            type="firewall",
            firewall_base=context.firewall_base,
        )
        _set_matched_firewall_failure_response(
            flow,
            status=402,
            action="BLOCK",
            error_code="insufficient_credits",
            message=str(exc),
            permission=context.allow.name,
        )
        return FirewallAuthHandlingResult.LOCAL_RESPONSE

    if isinstance(exc, InvalidBillableAuthExpiryError):
        log_message = (
            "Billable firewall auth response returned invalid expiresAt "
            f"for {context.firewall_base}: {exc}"
        )
        log_proxy_entry(
            context.proxy_log_path,
            "error",
            log_message,
            type="firewall",
            firewall_base=context.firewall_base,
        )
        _set_matched_firewall_failure_response(
            flow,
            status=502,
            action="ALLOW",
            error_code="invalid_auth_expiry",
            message=str(exc),
            permission=context.allow.name,
        )
        return FirewallAuthHandlingResult.LOCAL_RESPONSE

    if isinstance(exc, FirewallAuthApiError):
        log_proxy_entry(
            context.proxy_log_path,
            "error",
            f"Firewall auth API failed for {context.firewall_base}: {exc.code}",
            type="firewall",
            firewall_base=context.firewall_base,
            error_code=exc.code,
        )
        _set_matched_firewall_failure_response(
            flow,
            status=exc.status,
            action=(
                "BLOCK"
                if _HTTP_STATUS_CLIENT_ERROR_MIN <= exc.status < _HTTP_STATUS_SERVER_ERROR_MIN
                else "ALLOW"
            ),
            error_code=exc.code,
            message=str(exc),
            permission=context.allow.name,
            connectors=exc.connectors,
            failure_reason=exc.failure_reason,
        )
        return FirewallAuthHandlingResult.LOCAL_RESPONSE

    log_proxy_entry(
        context.proxy_log_path,
        "error",
        f"Firewall header fetch failed: {exc}",
        type="firewall",
        firewall_base=context.firewall_base,
    )
    _set_matched_firewall_failure_response(
        flow,
        status=502,
        action="ALLOW",
        error_code="auth_failed",
        message=f"Failed to resolve auth headers: {exc}",
        permission=context.allow.name,
    )
    return FirewallAuthHandlingResult.LOCAL_RESPONSE


def _set_invalid_resolved_auth_header_response(
    flow: http.HTTPFlow,
    *,
    allow: matching.FirewallAllow,
    proxy_log_path: str,
    firewall_base: str,
    error: InvalidResolvedAuthHeaderError,
) -> None:
    log_proxy_entry(
        proxy_log_path,
        "error",
        "Invalid resolved auth header",
        type="firewall",
        firewall_base=firewall_base,
        error_type=type(error).__name__,
    )
    _set_matched_firewall_failure_response(
        flow,
        status=502,
        action="ALLOW",
        error_code="invalid_resolved_auth_header",
        message=str(error),
        permission=allow.name,
    )


async def _apply_url_rewrite(
    flow: http.HTTPFlow,
    *,
    allow: matching.FirewallAllow,
    resolved_base: str,
    client_representation_headers: list[tuple[str, str]],
    headers: dict[str, str],
    resolved_query: dict | None,
    firewall_base: str,
    proxy_log_path: str,
    revalidate_current_firewall_authorization: CurrentFirewallAuthorizationGuard,
) -> FirewallAuthHandlingResult:
    # The addon forwards the request itself because mitmproxy's eager
    # connection already connected to the placeholder IP. Setting
    # flow.response bypasses the upstream connection entirely.
    try:
        orig_query = _request_path_query(flow)
        new_url = build_rewrite_url(resolved_base, allow.rel_path, orig_query, resolved_query)
    except AuthBaseQueryTooManyPairsError:
        _set_auth_base_query_too_many_pairs(
            flow,
            allow=allow,
            proxy_log_path=proxy_log_path,
            firewall_base=firewall_base,
        )
        return FirewallAuthHandlingResult.LOCAL_RESPONSE
    except ValueError as e:
        _set_url_rewrite_forward_failed(
            flow,
            allow=allow,
            proxy_log_path=proxy_log_path,
            firewall_base=firewall_base,
            error_type=type(e).__name__,
        )
        return FirewallAuthHandlingResult.LOCAL_RESPONSE

    # These client pairs were selected before auth resolution. Trusted resolved
    # auth is applied only after that fresh-request boundary is established.
    req_headers = _merge_auth_headers(client_representation_headers, headers)
    req_body = flow.request.raw_content if flow.request.raw_content is not None else None

    try:
        admission = take_forward_request_admission_from_flow(flow)
        status, resp_raw_content, resp_headers = await forward_request(
            new_url,
            flow.request.method,
            req_headers,
            req_body,
            admission=admission,
            pre_submit_guard=revalidate_current_firewall_authorization,
        )
        is_head_representation = flow.request.method == "HEAD" and not (
            _HTTP_STATUS_INFORMATIONAL_MIN <= status < _HTTP_STATUS_SUCCESS_MIN
            or status in (_HTTP_STATUS_NO_CONTENT, _HTTP_STATUS_RESET_CONTENT)
        )
        preserves_representation_length = is_head_representation or (
            flow.request.method == "GET" and status == _HTTP_STATUS_NOT_MODIFIED
        )
        representation_content_length: str | None = None
        if preserves_representation_length:
            content_lengths = resp_headers.get_all("Content-Length")
            if len(content_lengths) == 1:
                candidate = content_lengths[0].strip(" \t")
                if candidate.isascii() and candidate.isdigit():
                    representation_content_length = candidate
        content_encodings = [
            value
            for name, value in header_pairs(resp_headers)
            if name.lower() == "content-encoding"
        ]
        if content_encodings:
            del resp_headers["Content-Encoding"]
        # The forwarder returns representation bytes, but Response.make expects
        # decoded content. Hide the codings while it normalizes response framing.
        flow.response = http.Response.make(status, resp_raw_content, resp_headers)
        if preserves_representation_length:
            del flow.response.headers["Content-Length"]
            if representation_content_length is not None:
                flow.response.headers["Content-Length"] = representation_content_length
        if content_encodings:
            flow.response.headers.set_all("Content-Encoding", content_encodings)
    except ForwardRequestPreSubmitRejectedError:
        return FirewallAuthHandlingResult.LOCAL_RESPONSE
    except ForwardedRequestTooLargeError:
        _set_auth_base_request_too_large(
            flow,
            allow=allow,
            proxy_log_path=proxy_log_path,
            firewall_base=firewall_base,
        )
        return FirewallAuthHandlingResult.LOCAL_RESPONSE
    except AuthBaseForwardingSaturatedError:
        _set_auth_base_forwarding_saturated(
            flow,
            allow=allow,
            proxy_log_path=proxy_log_path,
            firewall_base=firewall_base,
        )
        return FirewallAuthHandlingResult.LOCAL_RESPONSE
    except Exception as e:
        _set_url_rewrite_forward_failed(
            flow,
            allow=allow,
            proxy_log_path=proxy_log_path,
            firewall_base=firewall_base,
            error_type=type(e).__name__,
        )
        return FirewallAuthHandlingResult.LOCAL_RESPONSE

    flow.metadata[metadata_keys.AUTH_URL_REWRITE] = True
    log_proxy_entry(
        proxy_log_path,
        "info",
        f"Firewall URL rewrite: {firewall_base} -> [redacted]",
        type="firewall",
        firewall_base=firewall_base,
    )
    return FirewallAuthHandlingResult.INLINE_PROVIDER_RESPONSE


async def _apply_resolved_firewall_auth(
    flow: http.HTTPFlow,
    *,
    context: _FirewallAuthContext,
    resolved_auth: _ResolvedFirewallAuth,
    auth_base_client_headers: list[tuple[str, str]] | None,
    aws_sigv4_body_hash: AwsSigV4BodyHash | None,
    revalidate_current_firewall_authorization: CurrentFirewallAuthorizationGuard,
) -> FirewallAuthHandlingResult:
    """Apply resolved firewall auth and return request ownership outcome."""
    try:
        if resolved_auth.base is not None:
            if auth_base_client_headers is None:
                return _set_firewall_auth_resolution_failure(
                    flow,
                    context,
                    ValueError("auth.base client request headers are unavailable"),
                )
            return await _apply_url_rewrite(
                flow,
                allow=context.allow,
                resolved_base=resolved_auth.base,
                client_representation_headers=auth_base_client_headers,
                headers=resolved_auth.headers,
                resolved_query=resolved_auth.query,
                firewall_base=context.firewall_base,
                proxy_log_path=context.proxy_log_path,
                revalidate_current_firewall_authorization=(
                    revalidate_current_firewall_authorization
                ),
            )

        release_forward_request_admission_from_flow(flow)
        _apply_header_query_injection(
            flow,
            headers=resolved_auth.headers,
            resolved_query=resolved_auth.query,
        )
    except InvalidResolvedAuthHeaderError as e:
        _set_invalid_resolved_auth_header_response(
            flow,
            allow=context.allow,
            proxy_log_path=context.proxy_log_path,
            firewall_base=context.firewall_base,
            error=e,
        )
        return FirewallAuthHandlingResult.LOCAL_RESPONSE

    if resolved_auth.aws_sigv4 is not None:
        try:
            _sign_flow_request_with_aws_sigv4(
                flow,
                resolved_auth.aws_sigv4,
                precomputed_body_hash=aws_sigv4_body_hash,
            )
        except AwsSigV4SigningError as e:
            _set_matched_firewall_failure_response(
                flow,
                status=502,
                action="ALLOW",
                error_code="aws_sigv4_auth_failed",
                message=str(e),
                permission=context.allow.name,
            )
            return FirewallAuthHandlingResult.LOCAL_RESPONSE
    return FirewallAuthHandlingResult.CONTINUE_UPSTREAM


def _finalize_firewall_auth_success(
    flow: http.HTTPFlow,
    context: _FirewallAuthContext,
    resolved_auth: _ResolvedFirewallAuth,
) -> None:
    """Record successful auth metadata and proxy log after auth application."""
    _record_firewall_auth_success_metadata(flow, resolved_auth)

    trusted_host = flow_metadata.trusted_authority_host(flow.metadata) or flow.request.pretty_host
    log_proxy_entry(
        context.proxy_log_path,
        "info",
        f"Firewall {context.firewall_base}: {trusted_host}",
        type="firewall",
        firewall_base=context.firewall_base,
        host=trusted_host,
        request_host_header=flow.request.host_header,
    )


def _finish_firewall_auth_result(
    flow: http.HTTPFlow, result: FirewallAuthHandlingResult
) -> FirewallAuthHandlingResult:
    if result is FirewallAuthHandlingResult.LOCAL_RESPONSE:
        release_forward_request_admission_from_flow(flow)
    return result


async def handle_firewall_request(
    flow: http.HTTPFlow,
    allow: matching.FirewallAllow,
    sandbox_info: dict,
    *,
    revalidate_current_firewall_authorization: CurrentFirewallAuthorizationGuard,
) -> FirewallAuthHandlingResult:
    """Handle firewall auth and return who owns the next response lifecycle.

    The required guard runs after resolution and before managed credential
    application. A rejecting caller must first create its local response; this
    function then returns ``LOCAL_RESPONSE`` without applying resolved data.
    """
    try:
        plan = _build_firewall_auth_plan(flow, allow, sandbox_info)
        _prepare_firewall_metadata(flow, allow, sandbox_info)
        context = _build_firewall_auth_context(
            flow, allow, sandbox_info, needs_resolution=plan.needs_resolution
        )

        preflight_result = _preflight_firewall_auth(flow, context, plan)
        if preflight_result is not None:
            return _finish_firewall_auth_result(flow, preflight_result)

        auth_base_client_headers: list[tuple[str, str]] | None = None
        if plan.uses_auth_base:
            try:
                auth_base_client_headers = forwarded_auth_base_client_header_pairs(
                    flow.request.headers
                )
            except InvalidAuthBaseRequestHeadersError as exc:
                log_proxy_entry(
                    context.proxy_log_path,
                    "warn",
                    "Invalid auth.base request headers",
                    type="firewall",
                    firewall_base=context.firewall_base,
                    error_type=type(exc).__name__,
                )
                _set_matched_firewall_failure_response(
                    flow,
                    status=400,
                    action="ALLOW",
                    error_code="invalid_auth_base_request_headers",
                    message=str(exc),
                    permission=context.allow.name,
                )
                return _finish_firewall_auth_result(
                    flow,
                    FirewallAuthHandlingResult.LOCAL_RESPONSE,
                )

        try:
            token_meta = await _resolve_firewall_auth(plan, context)
            resolved_auth = _validate_resolved_firewall_auth(plan, token_meta)
        except Exception as exc:
            return _finish_firewall_auth_result(
                flow,
                _set_firewall_auth_resolution_failure(flow, context, exc),
            )

        aws_sigv4_body_hash = await _precompute_aws_sigv4_body_hash(
            flow,
            plan=plan,
            resolved_auth=resolved_auth,
        )

        if plan.injects_credentials and not revalidate_current_firewall_authorization():
            return _finish_firewall_auth_result(
                flow,
                FirewallAuthHandlingResult.LOCAL_RESPONSE,
            )

        auth_result = await _apply_resolved_firewall_auth(
            flow,
            context=context,
            resolved_auth=resolved_auth,
            auth_base_client_headers=auth_base_client_headers,
            aws_sigv4_body_hash=aws_sigv4_body_hash,
            revalidate_current_firewall_authorization=(revalidate_current_firewall_authorization),
        )
        if auth_result is FirewallAuthHandlingResult.LOCAL_RESPONSE:
            return _finish_firewall_auth_result(flow, auth_result)

        _finalize_firewall_auth_success(flow, context, resolved_auth)
        return auth_result
    except BaseException:
        release_forward_request_admission_from_flow(flow)
        raise


async def try_apply_stream_safe_firewall_auth_for_requestheaders(
    flow: http.HTTPFlow,
    allow: matching.FirewallAllow,
    sandbox_info: dict,
    *,
    revalidate_current_firewall_authorization: CurrentFirewallAuthorizationGuard,
) -> FirewallHeaderPhaseAuthResult:
    """Resolve header/query firewall auth before request streaming.

    Resolution failures retain the canonical local response and diagnostics;
    the caller must terminate the upload instead of waiting for its body. Other
    unsuccessful probes, including current-authorization rejection, restore the
    snapshot and fall back before mutation.
    """
    metadata_snapshot = dict(flow.metadata)
    request_headers_snapshot = http.Headers(flow.request.headers.fields)
    request_url_snapshot = flow.request.url

    plan = _build_firewall_auth_plan(flow, allow, sandbox_info)
    if plan.body_dependent or plan.failure is not None:
        _restore_header_phase_probe_state(
            flow,
            metadata_snapshot=metadata_snapshot,
            request_headers_snapshot=request_headers_snapshot,
            request_url_snapshot=request_url_snapshot,
        )
        return FirewallHeaderPhaseAuthResult.FALLBACK

    _prepare_firewall_metadata(flow, allow, sandbox_info)
    context = _build_firewall_auth_context(
        flow, allow, sandbox_info, needs_resolution=plan.needs_resolution
    )

    try:
        token_meta = await _resolve_firewall_auth(plan, context)
    except asyncio.CancelledError:
        _restore_header_phase_probe_state(
            flow,
            metadata_snapshot=metadata_snapshot,
            request_headers_snapshot=request_headers_snapshot,
            request_url_snapshot=request_url_snapshot,
        )
        raise
    except Exception as exc:
        _set_firewall_auth_resolution_failure(flow, context, exc)
        return FirewallHeaderPhaseAuthResult.REJECTED

    try:
        resolved_auth = _validate_resolved_firewall_auth(plan, token_meta)
    except (TypeError, ValueError):
        _restore_header_phase_probe_state(
            flow,
            metadata_snapshot=metadata_snapshot,
            request_headers_snapshot=request_headers_snapshot,
            request_url_snapshot=request_url_snapshot,
        )
        return FirewallHeaderPhaseAuthResult.FALLBACK

    if plan.injects_credentials and not revalidate_current_firewall_authorization():
        _restore_header_phase_probe_state(
            flow,
            metadata_snapshot=metadata_snapshot,
            request_headers_snapshot=request_headers_snapshot,
            request_url_snapshot=request_url_snapshot,
        )
        return FirewallHeaderPhaseAuthResult.FALLBACK

    try:
        _apply_header_query_injection(
            flow,
            headers=resolved_auth.headers,
            resolved_query=resolved_auth.query,
        )
        if resolved_auth.aws_sigv4 is not None:
            _sign_flow_request_with_aws_sigv4(flow, resolved_auth.aws_sigv4)
    except Exception:
        _restore_header_phase_probe_state(
            flow,
            metadata_snapshot=metadata_snapshot,
            request_headers_snapshot=request_headers_snapshot,
            request_url_snapshot=request_url_snapshot,
        )
        return FirewallHeaderPhaseAuthResult.FALLBACK

    _finalize_firewall_auth_success(flow, context, resolved_auth)
    return FirewallHeaderPhaseAuthResult.APPLIED
