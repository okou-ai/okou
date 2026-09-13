"""Connector diagnostic hook lifecycle for mitmproxy HTTP flows.

``mitm_addon`` owns hook orchestration, while this module owns connector-intent
handling, flow-scoped diagnostic lookup state, response replacement, diagnostic
proxy logging, and diagnostic stream cleanup. Catalog compilation and matching
remain in ``builtin_connector_diagnostics``.

Lifecycle:

- ``requestheaders()`` and ``request()`` both capture connector intent before
  classification and strip the private header before forwarding. A provisional
  header-phase classification may restore the exported probe metadata when it
  falls through to the request hook.
- The header hook may probe an unknown-endpoint firewall allow with
  ``commit=False``. A miss does not persist a newly selected snapshot, while a
  successful local diagnostic pins the snapshot it used. Carried-forward
  ordinary allow flows call ``record_allow_context()`` before request streaming.
- The request hook uses ``commit=True`` for the committed unknown-endpoint path
  and calls ``record_allow_context()`` for ordinary allows. These paths pin one
  diagnostic catalog snapshot so later response and error handling cannot
  switch catalog generations during the same flow.
- ``responseheaders()`` offers eligible 401/403 responses to
  ``install_response_stream_if_needed()`` before installing general response
  streaming. A diagnostic stream suppresses the upstream body and emits its
  replacement content once, except that HEAD remains bodyless.
- ``response()`` completes streamed replacement or handles buffered 401/403
  replacement before network logging. ``error()`` preserves connection errors
  while finalizing any replacement already installed after 401/403 headers.
- Terminal response, error, and WebSocket cleanup call ``release_flow_state()``
  from exception-safe cleanup to release diagnostic-private state and detach an
  installed diagnostic stream callback.

Connector-intent capture and request-header probe metadata live in
``connector_intent``. Terminal release here instead owns diagnostic-private
snapshot, lookup, candidate, ownership, stream, and log guard state. Public
diagnostic/firewall metadata used for observable logging and generic response-
stream state have separate owners.

Client-visible connector availability response contract:

The diagnostic response is JSON with ``Content-Type: application/json`` and
contains this stable field set::

    {
        "error": "connector_not_configured_for_run",
        "connector": "<connector-slug>",
        "reason": "not_configured_for_run",
        "message": "<human-readable explanation>",
        "envNames": ["<credential-alias-name>"],
        "base": "https://<static-built-in-base>",
        "upstreamStatus": 0,
    }

``error`` is the machine-readable discriminator. ``connector`` is the matched
connector slug. ``reason`` describes the diagnostic condition; the first
supported reason is ``not_configured_for_run``. ``message`` is human-readable
context and is not a stable parsing surface. ``envNames`` lists credential
alias names referenced by the connector configuration, never credential
values. ``base`` is the matched static built-in base. ``upstreamStatus`` is
``0`` for a pre-upstream local diagnostic and is the preserved upstream
``401`` or ``403`` for a response-hook diagnostic.

There are two HTTP status modes for the same JSON contract. An inactive
shared-base owner can be diagnosed before upstream authentication with HTTP
``424`` and ``upstreamStatus: 0``. An ordinary eligible request is diagnosed
only after an upstream ``401`` or ``403``; the response keeps that upstream
status and records the same value in ``upstreamStatus``. Buffered and streamed
replacement paths use the same JSON body. A streamed replacement discards
upstream chunks and emits the diagnostic body once at end-of-stream. HEAD
responses keep the diagnostic status and metadata but have no body or
``Content-Length``. Replacement removes incompatible upstream
``Content-Encoding``, ``Content-Length``, and ``Transfer-Encoding`` headers and
discards trailers before applying JSON framing.

Authentication inspection has per-invocation header and query work budgets.
An exhausted budget leaves authentication indeterminate and suppresses this
optional diagnostic, preserving ordinary request and response handling. It
does not reject requests or change their headers.

This is an agent-visible compatibility contract. Consumers should branch on
stable machine-readable fields such as ``error`` and ``reason`` rather than
``message``, tolerate additive unknown fields, and receive a coordinated
contract update before existing fields are removed or their meanings change.
"""

import json
import urllib.parse

from mitmproxy import http

import builtin_connector_diagnostics
import connector_intent
import flow_metadata
import flow_metadata_keys as metadata_keys
import http_local_responses
import matching
import request_classification
import runtime_url_parsing
from logging_utils import log_proxy_entry, project_url_for_proxy_log

_HTTP_STATUS_UNAUTHORIZED = 401
_HTTP_STATUS_FORBIDDEN = 403
_HTTP_STATUS_FAILED_DEPENDENCY = 424

MAX_CONNECTOR_DIAGNOSTIC_QUERY_CHARACTERS = 64 * 1024
MAX_CONNECTOR_DIAGNOSTIC_QUERY_FIELDS = 8 * 1024
MAX_CONNECTOR_DIAGNOSTIC_HEADER_FIELDS = 1024
MAX_CONNECTOR_DIAGNOSTIC_HEADER_NAME_BYTES = 1024
MAX_CONNECTOR_DIAGNOSTIC_HEADER_TOTAL_NAME_BYTES = 16 * 1024
MAX_CONNECTOR_DIAGNOSTIC_HEADER_VALUE_BYTES = 16 * 1024
MAX_CONNECTOR_DIAGNOSTIC_HEADER_TOTAL_VALUE_BYTES = 64 * 1024

_CONNECTOR_DIAGNOSTIC_ELIGIBLE = "_connector_diagnostic_eligible"
_CONNECTOR_DIAGNOSTIC_ACTIVE_FIREWALL_NAMES = "_connector_diagnostic_active_firewall_names"
_CONNECTOR_DIAGNOSTIC_CATALOG_SNAPSHOT = "_connector_diagnostic_catalog_snapshot"
_CONNECTOR_DIAGNOSTIC_LOOKUP_DONE = "_connector_diagnostic_lookup_done"
_CONNECTOR_DIAGNOSTIC_CANDIDATE = "_connector_diagnostic_candidate"
_CONNECTOR_DIAGNOSTIC_AUTH_HEADER_NAMES = "_connector_diagnostic_auth_header_names"
_CONNECTOR_DIAGNOSTIC_AUTH_QUERY_PARAM_NAMES = "_connector_diagnostic_auth_query_param_names"
_CONNECTOR_DIAGNOSTIC_RESPONSE_REPLACED_IN_HEADERS = (
    "_connector_diagnostic_response_replaced_in_headers"
)
_CONNECTOR_DIAGNOSTIC_RESPONSE_BODY = "_connector_diagnostic_response_body"
_CONNECTOR_DIAGNOSTIC_RESPONSE_STREAM_BODY_SENT = "_connector_diagnostic_response_stream_body_sent"
_CONNECTOR_DIAGNOSTIC_RESPONSE_STREAM_CALLBACK = "_connector_diagnostic_response_stream_callback"
_CONNECTOR_DIAGNOSTIC_PROXY_ENTRY_LOGGED = "_connector_diagnostic_proxy_entry_logged"
_CONNECTOR_DIAGNOSTIC_OWNERSHIP_REASON = "_connector_diagnostic_ownership_reason"
_CONNECTOR_DIAGNOSTIC_OWNERSHIP_CANDIDATES = "_connector_diagnostic_ownership_candidates"
_CONNECTOR_DIAGNOSTIC_OWNERSHIP_HINT_STATUS = "_connector_diagnostic_ownership_hint_status"

_EMPTY_RESPONSE_STREAM_CHUNKS: tuple[bytes, ...] = ()
_GENERIC_AUTH_HEADER_NAMES = frozenset(
    (
        b"authorization",
        b"x-api-key",
        b"api-key",
    )
)
_GENERIC_AUTH_QUERY_PARAM_NAMES = frozenset(
    (
        "access_token",
        "api_key",
        "apikey",
        "app_key",
        "auth",
        "authorization",
        "key",
        "token",
    )
)
_AUTH_SCHEMES_REQUIRING_CREDENTIAL = frozenset(
    (
        "api-key",
        "apikey",
        "basic",
        "bearer",
        "digest",
        "key",
        "oauth",
        "oauth2",
        "token",
    )
)


def record_allow_context(
    flow: http.HTTPFlow,
    classification: request_classification.Allow,
) -> None:
    """Pin diagnostic lookup context for an eligible ordinary allow flow.

    Request-header callers use this before carrying a streamed ``allow``
    classification into ``request()``; request callers use it to defer
    diagnostic resolution until an upstream response. A browser flow, existing
    diagnostic, asterisk-form target, or incomplete original-URL context is a
    no-op.

    Catalog matching is only a diagnostic hint, not proof that an ordinary
    request requires connector credentials. Preserve the original request and
    wait for an upstream 401/403 to provide the auth-failure signal before
    resolving an inactive connector candidate.

    On success, the flow records diagnostic eligibility, active firewall names,
    and one classification-compatible catalog snapshot. Response phases resolve
    candidates only from that pinned snapshot.
    """
    if classification.is_asterisk_form:
        return
    if flow.metadata.get(metadata_keys.BROWSER_USER_AGENT):
        return
    if metadata_keys.CONNECTOR_DIAGNOSTIC_SLUG in flow.metadata:
        return

    sandbox_info = classification.sandbox_info
    original_url = flow.metadata.get(metadata_keys.ORIGINAL_URL)
    if not isinstance(original_url, str):
        return

    flow.metadata[_CONNECTOR_DIAGNOSTIC_ELIGIBLE] = True
    flow.metadata[_CONNECTOR_DIAGNOSTIC_ACTIVE_FIREWALL_NAMES] = tuple(
        sorted(_active_firewall_names(sandbox_info))
    )
    _pin_diagnostic_snapshot(flow, classification)


def maybe_make_firewall_allow_local_response(
    flow: http.HTTPFlow,
    classification: request_classification.FirewallAllow,
    *,
    commit: bool,
) -> bool:
    """Diagnose an inactive shared-base owner for an unknown endpoint.

    This applies only to a non-browser ``firewall_allow`` whose matched firewall
    has no permission/rule for the endpoint and whose sandbox and original-URL
    context is complete. ``requestheaders()`` passes ``commit=False`` for its
    provisional probe; ``request()`` passes ``commit=True`` for the committed
    path.

    ``commit`` controls catalog snapshot retention, not response construction.
    Once snapshot selection is reached, the committed path pins that snapshot
    even when ownership resolution misses or request auth material suppresses a
    diagnostic. The provisional path pins only when it actually builds the
    local response.

    Return ``True`` only after installing and logging the pre-upstream mode of
    the module's connector availability response contract: a local HTTP 424
    response with ``upstreamStatus`` set to ``0`` and the selected candidate
    and ownership metadata. HEAD keeps the same diagnostic status and metadata
    without response content. The caller must stop normal request dispatch on
    ``True``.
    """
    if _is_browser_diagnostic_skip(flow):
        return False

    allow = classification.firewall_allow
    sandbox_info = classification.sandbox_info
    if not _firewall_allow_is_unknown_endpoint(allow):
        return False

    original_url = flow_metadata.original_url(flow.metadata)
    if not original_url:
        return False

    diagnostic_snapshot = _select_diagnostic_snapshot(flow, classification)
    if commit:
        flow.metadata[_CONNECTOR_DIAGNOSTIC_CATALOG_SNAPSHOT] = diagnostic_snapshot
    resolution = builtin_connector_diagnostics.resolve_shared_base_ownership(
        diagnostic_snapshot,
        original_url,
        flow.request.method,
        active_firewall_names=_active_firewall_names(sandbox_info),
        matched_firewall_name=allow.name,
        connector_intent=_present_connector_intent_from_flow(flow),
    )
    if resolution is None or resolution.candidate is None:
        return False

    candidate = resolution.candidate
    if _request_may_have_auth_material(flow, candidate, original_url):
        return False

    flow.metadata[_CONNECTOR_DIAGNOSTIC_CATALOG_SNAPSHOT] = diagnostic_snapshot
    flow_metadata.start_request_timing(flow.metadata)
    _set_failure_metadata(flow, candidate)
    flow.metadata[_CONNECTOR_DIAGNOSTIC_OWNERSHIP_REASON] = resolution.reason
    flow.metadata[_CONNECTOR_DIAGNOSTIC_OWNERSHIP_CANDIDATES] = resolution.candidate_connector_slugs
    flow.metadata[_CONNECTOR_DIAGNOSTIC_OWNERSHIP_HINT_STATUS] = resolution.hint_status
    flow_metadata.set_firewall_decision(flow.metadata, "ALLOW")
    flow.response = _make_local_response(
        flow,
        candidate,
        upstream_status=0,
    )
    _log_proxy_entry(
        flow,
        original_url=original_url,
        upstream_status=0,
    )
    return True


def install_response_stream_if_needed(flow: http.HTTPFlow) -> bool:
    """Install diagnostic replacement during the response-header phase.

    ``responseheaders()`` must call this before general response streaming. For
    an eligible unauthenticated 401/403, it applies the response-hook mode of
    the module's connector availability response contract: the response keeps
    its upstream status and records it in ``upstreamStatus``. It replaces the
    response content and framing headers, caches the diagnostic content, and
    installs a callback that discards upstream chunks and emits that content
    once at end-of-stream. HEAD caches and emits empty content without a
    Content-Length field.

    Return ``True`` only when this module owns ``flow.response.stream``; the
    caller must then skip installing another stream callback. ``False`` means no
    diagnostic callback was installed, although candidate lookup may have
    populated flow-private cache state.
    """
    if flow.response is None:
        return False
    if flow.response.status_code not in (
        _HTTP_STATUS_UNAUTHORIZED,
        _HTTP_STATUS_FORBIDDEN,
    ):
        return False
    if _is_browser_diagnostic_skip(flow):
        return False

    original_url = flow.metadata.get(metadata_keys.ORIGINAL_URL)
    if not isinstance(original_url, str):
        return False
    candidate = _resolve_candidate(flow, original_url=original_url)
    if candidate is None:
        return False
    if _request_may_have_auth_material(flow, candidate, original_url):
        return False

    upstream_status = flow.response.status_code
    _set_failure_metadata(flow, candidate)
    body = _replace_response_content(
        flow,
        candidate,
        upstream_status=upstream_status,
    )
    if body is None:
        return False
    flow.metadata[_CONNECTOR_DIAGNOSTIC_RESPONSE_BODY] = body
    flow.metadata[_CONNECTOR_DIAGNOSTIC_RESPONSE_REPLACED_IN_HEADERS] = True

    def stream_connector_diagnostic_response(chunk: bytes) -> bytes | tuple[bytes, ...]:
        if chunk:
            return _EMPTY_RESPONSE_STREAM_CHUNKS
        if flow.metadata.get(_CONNECTOR_DIAGNOSTIC_RESPONSE_STREAM_BODY_SENT):
            return _EMPTY_RESPONSE_STREAM_CHUNKS
        flow.metadata[_CONNECTOR_DIAGNOSTIC_RESPONSE_STREAM_BODY_SENT] = True
        return body

    flow.response.stream = stream_connector_diagnostic_response
    flow.metadata[_CONNECTOR_DIAGNOSTIC_RESPONSE_STREAM_CALLBACK] = (
        stream_connector_diagnostic_response
    )
    return True


def maybe_replace_response(
    flow: http.HTTPFlow,
    *,
    original_url: str,
) -> None:
    """Complete connector diagnostic handling during the response hook.

    Call this before response sizing, network logging, and usage finalization.
    If response headers already installed diagnostic streaming, this clears
    trailers, restores the cached body when the stream did not emit it, and
    records the proxy entry at most once. Otherwise it may replace a buffered
    401/403 body for an eligible request without user auth material. In either
    response-hook case, the JSON body follows the module's connector
    availability response contract and retains the eligible upstream status in
    both the HTTP response and ``upstreamStatus``.

    Non-401/403 responses, browser flows, missing candidates, and authenticated
    requests keep their upstream response unchanged.
    """
    if flow.response is None:
        return
    if flow.metadata.get(_CONNECTOR_DIAGNOSTIC_RESPONSE_REPLACED_IN_HEADERS):
        flow.response.trailers = None
        body = flow.metadata.get(_CONNECTOR_DIAGNOSTIC_RESPONSE_BODY)
        if isinstance(body, bytes) and not flow.metadata.get(
            _CONNECTOR_DIAGNOSTIC_RESPONSE_STREAM_BODY_SENT
        ):
            http_local_responses.apply_synthetic_json_response_content(
                flow,
                flow.response,
                lambda: body,
            )
        _log_proxy_entry(
            flow,
            original_url=original_url,
            upstream_status=flow.response.status_code,
        )
        return
    if flow.response.status_code not in (
        _HTTP_STATUS_UNAUTHORIZED,
        _HTTP_STATUS_FORBIDDEN,
    ):
        return
    if _is_browser_diagnostic_skip(flow):
        return

    candidate = _resolve_candidate(flow, original_url=original_url)
    if candidate is None:
        return
    upstream_status = flow.response.status_code
    if _request_may_have_auth_material(flow, candidate, original_url):
        return

    _set_failure_metadata(flow, candidate)
    _replace_response_content(
        flow,
        candidate,
        upstream_status=upstream_status,
    )
    _log_proxy_entry(
        flow,
        original_url=original_url,
        upstream_status=upstream_status,
    )


def handle_error(flow: http.HTTPFlow) -> None:
    """Finalize a response-header diagnostic after a connection error.

    Connection errors before an upstream 401/403 remain unchanged. When response
    headers already established a diagnostic replacement, discard upstream
    trailers before terminal cleanup detaches the owned stream callback.
    """
    if (
        flow.metadata.get(_CONNECTOR_DIAGNOSTIC_RESPONSE_REPLACED_IN_HEADERS)
        and flow.response is not None
    ):
        flow.response.trailers = None


def release_flow_state(flow: http.HTTPFlow) -> None:
    """Release diagnostic-private state after a terminal flow hook.

    ``response()``, ``error()``, and terminal WebSocket cleanup call this from a
    ``finally`` path after diagnostic processing. It removes the pinned catalog,
    lookup/candidate/auth context, ownership details, stream replacement state,
    and proxy-log guard. It detaches ``flow.response.stream`` only when the
    installed callback is the one owned by this module.

    Request-header connector-intent probe metadata and public diagnostic or
    firewall metadata are not release-owned here. General response-stream state
    is released separately by its own lifecycle owner.
    """
    flow.metadata.pop(_CONNECTOR_DIAGNOSTIC_CATALOG_SNAPSHOT, None)
    flow.metadata.pop(_CONNECTOR_DIAGNOSTIC_ELIGIBLE, None)
    flow.metadata.pop(_CONNECTOR_DIAGNOSTIC_ACTIVE_FIREWALL_NAMES, None)
    flow.metadata.pop(_CONNECTOR_DIAGNOSTIC_LOOKUP_DONE, None)
    flow.metadata.pop(_CONNECTOR_DIAGNOSTIC_CANDIDATE, None)
    flow.metadata.pop(_CONNECTOR_DIAGNOSTIC_AUTH_HEADER_NAMES, None)
    flow.metadata.pop(_CONNECTOR_DIAGNOSTIC_AUTH_QUERY_PARAM_NAMES, None)
    flow.metadata.pop(_CONNECTOR_DIAGNOSTIC_OWNERSHIP_REASON, None)
    flow.metadata.pop(_CONNECTOR_DIAGNOSTIC_OWNERSHIP_CANDIDATES, None)
    flow.metadata.pop(_CONNECTOR_DIAGNOSTIC_OWNERSHIP_HINT_STATUS, None)
    stream_callback = flow.metadata.pop(_CONNECTOR_DIAGNOSTIC_RESPONSE_STREAM_CALLBACK, None)
    flow.metadata.pop(_CONNECTOR_DIAGNOSTIC_RESPONSE_BODY, None)
    flow.metadata.pop(_CONNECTOR_DIAGNOSTIC_RESPONSE_STREAM_BODY_SENT, None)
    flow.metadata.pop(_CONNECTOR_DIAGNOSTIC_RESPONSE_REPLACED_IN_HEADERS, None)
    flow.metadata.pop(_CONNECTOR_DIAGNOSTIC_PROXY_ENTRY_LOGGED, None)
    if stream_callback is not None and flow.response and flow.response.stream is stream_callback:
        flow.response.stream = False


def _present_connector_intent_from_flow(flow: http.HTTPFlow) -> str | None:
    intent = connector_intent.from_flow(flow)
    return intent.value if intent.status == "present" else None


def _active_firewall_names(sandbox_info: dict) -> set[str]:
    raw_firewalls = sandbox_info.get("firewalls")
    if not isinstance(raw_firewalls, list):
        return set()

    names: set[str] = set()
    for firewall in raw_firewalls:
        if not isinstance(firewall, dict):
            continue
        name = firewall.get("name")
        if isinstance(name, str) and name:
            names.add(name)
    return names


def _candidate_from_flow(
    flow: http.HTTPFlow,
) -> builtin_connector_diagnostics.ConnectorDiagnosticCandidate | None:
    meta = flow.metadata
    connector_slug = meta.get(metadata_keys.CONNECTOR_DIAGNOSTIC_SLUG)
    reason = meta.get(metadata_keys.CONNECTOR_DIAGNOSTIC_REASON)
    base = meta.get(metadata_keys.CONNECTOR_DIAGNOSTIC_BASE)
    if not (
        isinstance(connector_slug, str)
        and connector_slug
        and isinstance(reason, str)
        and reason
        and isinstance(base, str)
        and base
    ):
        return None

    env_names = _metadata_str_tuple(meta.get(metadata_keys.CONNECTOR_DIAGNOSTIC_ENV_NAMES))
    auth_header_names = _metadata_str_tuple(meta.get(_CONNECTOR_DIAGNOSTIC_AUTH_HEADER_NAMES))
    auth_query_param_names = _metadata_str_tuple(
        meta.get(_CONNECTOR_DIAGNOSTIC_AUTH_QUERY_PARAM_NAMES)
    )
    return builtin_connector_diagnostics.ConnectorDiagnosticCandidate(
        connector_slug=connector_slug,
        reason=reason,
        env_names=env_names,
        base=base,
        auth_header_names=auth_header_names,
        auth_query_param_names=auth_query_param_names,
    )


def _cached_candidate_from_flow(
    flow: http.HTTPFlow,
) -> builtin_connector_diagnostics.ConnectorDiagnosticCandidate | None:
    candidate = flow.metadata.get(_CONNECTOR_DIAGNOSTIC_CANDIDATE)
    if isinstance(candidate, builtin_connector_diagnostics.ConnectorDiagnosticCandidate):
        return candidate
    return None


def _diagnostic_snapshot_from_flow(
    flow: http.HTTPFlow,
) -> builtin_connector_diagnostics.DiagnosticCatalogSnapshot | None:
    snapshot = flow.metadata.get(_CONNECTOR_DIAGNOSTIC_CATALOG_SNAPSHOT)
    if isinstance(snapshot, builtin_connector_diagnostics.DiagnosticCatalogSnapshot):
        return snapshot
    return None


def _select_diagnostic_snapshot(
    flow: http.HTTPFlow,
    classification: request_classification.Allow
    | request_classification.FirewallAllow
    | None = None,
) -> builtin_connector_diagnostics.DiagnosticCatalogSnapshot:
    pinned = _diagnostic_snapshot_from_flow(flow)
    if pinned is not None:
        return pinned
    preferred = (
        classification.builtin_firewall_catalog_snapshot if classification is not None else None
    )
    return builtin_connector_diagnostics.load_diagnostic_snapshot(preferred)


def _pin_diagnostic_snapshot(
    flow: http.HTTPFlow,
    classification: request_classification.Allow
    | request_classification.FirewallAllow
    | None = None,
) -> builtin_connector_diagnostics.DiagnosticCatalogSnapshot:
    snapshot = _select_diagnostic_snapshot(flow, classification)
    flow.metadata[_CONNECTOR_DIAGNOSTIC_CATALOG_SNAPSHOT] = snapshot
    return snapshot


def _resolve_candidate(
    flow: http.HTTPFlow,
    *,
    original_url: str,
) -> builtin_connector_diagnostics.ConnectorDiagnosticCandidate | None:
    candidate = _cached_candidate_from_flow(flow)
    if candidate is not None:
        return candidate
    candidate = _candidate_from_flow(flow)
    if candidate is not None:
        return candidate
    if flow.metadata.get(_CONNECTOR_DIAGNOSTIC_LOOKUP_DONE):
        return None
    if flow.metadata.get(_CONNECTOR_DIAGNOSTIC_ELIGIBLE) is not True:
        return None
    if not original_url:
        return None
    if _is_browser_diagnostic_skip(flow):
        return None

    diagnostic_snapshot = _diagnostic_snapshot_from_flow(flow)
    if diagnostic_snapshot is None:
        return None
    flow.metadata[_CONNECTOR_DIAGNOSTIC_LOOKUP_DONE] = True
    candidate = builtin_connector_diagnostics.find_candidate(
        diagnostic_snapshot,
        original_url,
        flow.request.method,
        active_firewall_names=set(
            _metadata_str_tuple(flow.metadata.get(_CONNECTOR_DIAGNOSTIC_ACTIVE_FIREWALL_NAMES))
        ),
    )
    if candidate is not None:
        flow.metadata[_CONNECTOR_DIAGNOSTIC_CANDIDATE] = candidate
    return candidate


def _metadata_str_tuple(value: object) -> tuple[str, ...]:
    if not isinstance(value, (list, tuple)):
        return ()
    result: list[str] = []
    for item in value:
        if not isinstance(item, str):
            return ()
        result.append(item)
    return tuple(result)


def _set_failure_metadata(
    flow: http.HTTPFlow,
    candidate: builtin_connector_diagnostics.ConnectorDiagnosticCandidate,
) -> None:
    flow.metadata[_CONNECTOR_DIAGNOSTIC_CANDIDATE] = candidate
    flow.metadata[_CONNECTOR_DIAGNOSTIC_AUTH_HEADER_NAMES] = candidate.auth_header_names
    flow.metadata[_CONNECTOR_DIAGNOSTIC_AUTH_QUERY_PARAM_NAMES] = candidate.auth_query_param_names
    flow.metadata[metadata_keys.FIREWALL_BASE] = candidate.base
    flow.metadata[metadata_keys.FIREWALL_NAME] = candidate.connector_slug
    flow.metadata[metadata_keys.FIREWALL_PERMISSION] = ""
    flow.metadata[metadata_keys.FIREWALL_RULE_MATCH] = ""
    flow.metadata[metadata_keys.FIREWALL_BILLABLE] = False
    flow.metadata[metadata_keys.FIREWALL_ERROR] = "connector_not_configured_for_run"
    flow.metadata[metadata_keys.CONNECTOR_DIAGNOSTIC_SLUG] = candidate.connector_slug
    flow.metadata[metadata_keys.CONNECTOR_DIAGNOSTIC_REASON] = candidate.reason
    flow.metadata[metadata_keys.CONNECTOR_DIAGNOSTIC_ENV_NAMES] = list(candidate.env_names)
    flow.metadata[metadata_keys.CONNECTOR_DIAGNOSTIC_BASE] = candidate.base


def _response_body(
    candidate: builtin_connector_diagnostics.ConnectorDiagnosticCandidate,
    *,
    upstream_status: int,
) -> bytes:
    body = {
        "error": "connector_not_configured_for_run",
        "connector": candidate.connector_slug,
        "reason": candidate.reason,
        "message": _message(candidate),
        "envNames": list(candidate.env_names),
        "base": candidate.base,
        "upstreamStatus": upstream_status,
    }
    return json.dumps(body, separators=(",", ":")).encode()


def _set_diagnostic_response_content(
    flow: http.HTTPFlow,
    response: http.Response,
    candidate: builtin_connector_diagnostics.ConnectorDiagnosticCandidate,
    *,
    upstream_status: int,
) -> bytes:
    return http_local_responses.apply_synthetic_json_response_content(
        flow,
        response,
        lambda: _response_body(candidate, upstream_status=upstream_status),
    )


def _make_local_response(
    flow: http.HTTPFlow,
    candidate: builtin_connector_diagnostics.ConnectorDiagnosticCandidate,
    *,
    upstream_status: int,
) -> http.Response:
    response = http.Response.make(_HTTP_STATUS_FAILED_DEPENDENCY)
    _set_diagnostic_response_content(
        flow,
        response,
        candidate,
        upstream_status=upstream_status,
    )
    return response


def _message(
    candidate: builtin_connector_diagnostics.ConnectorDiagnosticCandidate,
) -> str:
    if not candidate.env_names:
        return (
            f"{candidate.connector_slug} is not configured for this run. "
            "Credentials cannot be injected."
        )
    env_names = ", ".join(candidate.env_names)
    verb = "is" if len(candidate.env_names) == 1 else "are"
    return (
        f"{candidate.connector_slug} is not configured for this run. "
        f"{env_names} {verb} unavailable, so credentials cannot be injected."
    )


def _request_may_have_auth_material(
    flow: http.HTTPFlow,
    candidate: builtin_connector_diagnostics.ConnectorDiagnosticCandidate,
    original_url: str,
) -> bool:
    """Return whether auth is present or bounded header/query inspection is inconclusive."""
    if _request_headers_may_have_auth_material(flow, candidate.auth_header_names):
        return True

    configured_query_params = set(candidate.auth_query_param_names)
    normalized_configured_query_params = {name.lower() for name in candidate.auth_query_param_names}
    try:
        parsed = runtime_url_parsing.split_runtime_url(original_url)
    except ValueError:
        return False

    query = parsed.query
    if len(query) > MAX_CONNECTOR_DIAGNOSTIC_QUERY_CHARACTERS:
        return True

    field_count = 0
    field_start = 0
    query_end = len(query)
    while field_start < query_end:
        field_end = query.find("&", field_start)
        if field_end == -1:
            field_end = query_end

        if field_start < field_end:
            field_count += 1
            if field_count > MAX_CONNECTOR_DIAGNOSTIC_QUERY_FIELDS:
                return True

            separator_index = query.find("=", field_start, field_end)
            name_end = field_end if separator_index == -1 else separator_index
            name = urllib.parse.unquote_plus(query[field_start:name_end])
            normalized_name = name.lower()
            is_auth_param = (
                name in configured_query_params
                or normalized_name in normalized_configured_query_params
                or normalized_name in _GENERIC_AUTH_QUERY_PARAM_NAMES
            )
            if is_auth_param:
                value_start = field_end if separator_index == -1 else separator_index + 1
                value = urllib.parse.unquote_plus(query[value_start:field_end])
                if _query_param_has_auth_material(value):
                    return True

        field_start = field_end + 1

    return False


def _request_headers_may_have_auth_material(
    flow: http.HTTPFlow, configured_header_names: tuple[str, ...]
) -> bool:
    """Inspect raw fields once, suppressing optional diagnostics when a budget is exhausted.

    Name/field limits apply independently to the configured lookup and request
    scan. Values share one byte budget across relevant names and duplicates.
    Check raw sizes before normalization or UTF-8/surrogateescape decoding;
    never decode unrelated values or inspect fields after finding credentials.
    These per-invocation limits do not reject or modify the request.
    """
    if len(configured_header_names) > MAX_CONNECTOR_DIAGNOSTIC_HEADER_FIELDS:
        return True
    auth_headers: set[bytes] = set(_GENERIC_AUTH_HEADER_NAMES)
    configured_name_bytes = 0
    for name in configured_header_names:
        # Bound string work before encoding, then enforce the actual byte limit.
        if len(name) > MAX_CONNECTOR_DIAGNOSTIC_HEADER_NAME_BYTES:
            return True
        raw_name = name.lower().encode("utf-8", "surrogateescape")
        configured_name_bytes += len(raw_name)
        if (
            len(raw_name) > MAX_CONNECTOR_DIAGNOSTIC_HEADER_NAME_BYTES
            or configured_name_bytes > MAX_CONNECTOR_DIAGNOSTIC_HEADER_TOTAL_NAME_BYTES
        ):
            return True
        auth_headers.add(raw_name.lower())

    name_bytes = 0
    value_bytes = 0
    for index, (raw_name, raw_value) in enumerate(flow.request.headers.fields):
        name_bytes += len(raw_name)
        if (
            index >= MAX_CONNECTOR_DIAGNOSTIC_HEADER_FIELDS
            or len(raw_name) > MAX_CONNECTOR_DIAGNOSTIC_HEADER_NAME_BYTES
            or name_bytes > MAX_CONNECTOR_DIAGNOSTIC_HEADER_TOTAL_NAME_BYTES
        ):
            return True
        normalized_name = raw_name.lower()
        if normalized_name not in auth_headers:
            continue
        value_bytes += len(raw_value)
        if (
            len(raw_value) > MAX_CONNECTOR_DIAGNOSTIC_HEADER_VALUE_BYTES
            or value_bytes > MAX_CONNECTOR_DIAGNOSTIC_HEADER_TOTAL_VALUE_BYTES
        ):
            return True
        value = raw_value.decode("utf-8", "surrogateescape")
        if _header_value_has_auth_material(normalized_name, value):
            return True
    return False


def _header_value_has_auth_material(name: bytes, value: str) -> bool:
    stripped = value.strip()
    if not stripped:
        return False
    if name not in (b"authorization", b"proxy-authorization"):
        return True

    return _scheme_auth_value_has_credential(stripped)


def _scheme_auth_value_has_credential(stripped: str) -> bool:
    parts = stripped.split(None, 1)
    if len(parts) == 1:
        return parts[0].lower() not in _AUTH_SCHEMES_REQUIRING_CREDENTIAL
    return bool(parts[1].strip())


def _query_param_has_auth_material(value: str) -> bool:
    return bool(value.strip())


def _replace_response_content(
    flow: http.HTTPFlow,
    candidate: builtin_connector_diagnostics.ConnectorDiagnosticCandidate,
    *,
    upstream_status: int,
) -> bytes | None:
    if flow.response is None:
        return None
    flow.metadata.pop(metadata_keys.RESPONSE_STREAM_STATE, None)
    flow.metadata.pop(metadata_keys.STREAM_BUFFER, None)
    flow.metadata.pop(metadata_keys.STREAM_BUFFER_STATE, None)
    for header in ("content-encoding", "content-length", "transfer-encoding"):
        if header in flow.response.headers:
            del flow.response.headers[header]
    flow.response.trailers = None
    return _set_diagnostic_response_content(
        flow,
        flow.response,
        candidate,
        upstream_status=upstream_status,
    )


def _log_proxy_entry(
    flow: http.HTTPFlow,
    *,
    original_url: str,
    upstream_status: int,
) -> None:
    if flow.metadata.get(_CONNECTOR_DIAGNOSTIC_PROXY_ENTRY_LOGGED):
        return
    candidate = _candidate_from_flow(flow)
    if candidate is None:
        return
    url_projection = project_url_for_proxy_log(original_url)
    extra: dict[str, object] = {}
    ownership_reason = flow.metadata.get(_CONNECTOR_DIAGNOSTIC_OWNERSHIP_REASON)
    if isinstance(ownership_reason, str) and ownership_reason:
        extra["ownership_reason"] = ownership_reason
    ownership_candidates = flow.metadata.get(_CONNECTOR_DIAGNOSTIC_OWNERSHIP_CANDIDATES)
    if isinstance(ownership_candidates, tuple) and all(
        isinstance(candidate, str) for candidate in ownership_candidates
    ):
        extra["ownership_candidates"] = list(ownership_candidates)
    ownership_hint_status = flow.metadata.get(_CONNECTOR_DIAGNOSTIC_OWNERSHIP_HINT_STATUS)
    if isinstance(ownership_hint_status, str) and ownership_hint_status:
        extra["ownership_hint_status"] = ownership_hint_status
    extra.update(url_projection.truncation_fields())
    log_proxy_entry(
        flow_metadata.proxy_log_path(flow.metadata),
        "warn",
        f"{candidate.connector_slug} is not configured for this run: {url_projection.value}",
        type="connector_diagnostic",
        connector=candidate.connector_slug,
        reason=candidate.reason,
        upstream_status=upstream_status,
        url=url_projection,
        **extra,
    )
    flow.metadata[_CONNECTOR_DIAGNOSTIC_PROXY_ENTRY_LOGGED] = True


def _firewall_allow_is_unknown_endpoint(allow: matching.FirewallAllow) -> bool:
    return allow.permission is None and allow.rule is None


def _is_browser_diagnostic_skip(flow: http.HTTPFlow) -> bool:
    return bool(
        flow.metadata.get(metadata_keys.BROWSER_USER_AGENT)
        or request_classification.is_browser_passthrough_heuristic(flow)
    )
