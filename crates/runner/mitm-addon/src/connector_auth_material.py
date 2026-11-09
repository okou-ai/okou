"""Read-only, bounded request authentication-material inspection for connector diagnostics.

These observations never authorize credentials or mutate requests. The lifecycle
owner decides whether present/unknown material suppresses diagnostics or blocks
an inactive-owner credential conflict. Each call retains its existing raw header
and query budgets; exhaustion remains indeterminate.
"""

import urllib.parse
from typing import Literal

from mitmproxy import http

import builtin_connector_diagnostics
import runtime_url_parsing

_AuthMaterialStatus = Literal["absent", "present", "unknown"]

MAX_CONNECTOR_DIAGNOSTIC_QUERY_CHARACTERS = 64 * 1024
MAX_CONNECTOR_DIAGNOSTIC_QUERY_FIELDS = 8 * 1024
MAX_CONNECTOR_DIAGNOSTIC_HEADER_FIELDS = 1024
MAX_CONNECTOR_DIAGNOSTIC_HEADER_NAME_BYTES = 1024
MAX_CONNECTOR_DIAGNOSTIC_HEADER_TOTAL_NAME_BYTES = 16 * 1024
MAX_CONNECTOR_DIAGNOSTIC_HEADER_VALUE_BYTES = 16 * 1024
MAX_CONNECTOR_DIAGNOSTIC_HEADER_TOTAL_VALUE_BYTES = 64 * 1024

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


def request_may_have_auth_material(
    flow: http.HTTPFlow,
    candidate: builtin_connector_diagnostics.ConnectorDiagnosticCandidate,
    original_url: str,
) -> bool:
    """Return whether auth is present or bounded header/query inspection is inconclusive."""
    return request_auth_material_status(flow, candidate, original_url) != "absent"


def request_auth_material_status(
    flow: http.HTTPFlow,
    candidate: builtin_connector_diagnostics.ConnectorDiagnosticCandidate,
    original_url: str,
) -> _AuthMaterialStatus:
    header_status = _request_headers_auth_material_status(flow, candidate.auth_header_names)
    if header_status == "present":
        return header_status

    configured_query_params = set(candidate.auth_query_param_names)
    normalized_configured_query_params = {name.lower() for name in candidate.auth_query_param_names}
    try:
        parsed = runtime_url_parsing.split_runtime_url(original_url)
    except ValueError:
        return header_status

    query = parsed.query
    if len(query) > MAX_CONNECTOR_DIAGNOSTIC_QUERY_CHARACTERS:
        return "unknown"

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
                return "unknown"

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
                    return "present"

        field_start = field_end + 1

    return header_status


def _request_headers_auth_material_status(
    flow: http.HTTPFlow, configured_header_names: tuple[str, ...]
) -> _AuthMaterialStatus:
    """Inspect raw fields once, suppressing optional diagnostics when a budget is exhausted.

    Name/field limits apply independently to the configured lookup and request
    scan. Values share one byte budget across relevant names and duplicates.
    Check raw sizes before normalization or UTF-8/surrogateescape decoding;
    never decode unrelated values or inspect fields after finding credentials.
    These per-invocation limits do not reject or modify the request.
    """
    if len(configured_header_names) > MAX_CONNECTOR_DIAGNOSTIC_HEADER_FIELDS:
        return "unknown"
    auth_headers: set[bytes] = set(_GENERIC_AUTH_HEADER_NAMES)
    configured_name_bytes = 0
    for name in configured_header_names:
        # Bound string work before encoding, then enforce the actual byte limit.
        if len(name) > MAX_CONNECTOR_DIAGNOSTIC_HEADER_NAME_BYTES:
            return "unknown"
        raw_name = name.lower().encode("utf-8", "surrogateescape")
        configured_name_bytes += len(raw_name)
        if (
            len(raw_name) > MAX_CONNECTOR_DIAGNOSTIC_HEADER_NAME_BYTES
            or configured_name_bytes > MAX_CONNECTOR_DIAGNOSTIC_HEADER_TOTAL_NAME_BYTES
        ):
            return "unknown"
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
            return "unknown"
        normalized_name = raw_name.lower()
        if normalized_name not in auth_headers:
            continue
        value_bytes += len(raw_value)
        if (
            len(raw_value) > MAX_CONNECTOR_DIAGNOSTIC_HEADER_VALUE_BYTES
            or value_bytes > MAX_CONNECTOR_DIAGNOSTIC_HEADER_TOTAL_VALUE_BYTES
        ):
            return "unknown"
        value = raw_value.decode("utf-8", "surrogateescape")
        if _header_value_has_auth_material(normalized_name, value):
            return "present"
    return "absent"


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
