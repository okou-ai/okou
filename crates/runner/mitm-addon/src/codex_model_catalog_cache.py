"""Bounded runner-process cache for authenticated Codex model catalogs.

Cache identity
--------------
Entries and in-flight owners are keyed by the canonical catalog URL and an HMAC-SHA256
digest of the length-delimited ``Authorization`` and ``ChatGPT-Account-ID`` values. The
HMAC key is random and process-local, so cache keys do not retain raw credentials and digest
values are process-specific. Both URL and credential identity must match before a response
can be reused.

Hook lifecycle
--------------
``mitm_addon`` owns the integration order:

1. ``requestheaders()`` and ``request()`` call ``capture_and_strip_prefetch_marker()``
   before the authenticated request path calls ``prepare_request()``. Preparation may
   bypass, serve a fresh local response, wait for the current owner, or reserve capacity
   for a new or replacement owner. If a wait ends without a local response, the addon's helper
   revalidates ordinary credential-bearing upstream continuation before proceeding.
2. ``responseheaders()`` calls ``observe_authenticated_models_etag()`` before
   ``handle_response_headers()``. For an eligible cold response that continues through the
   normal pipeline, the addon configures the downstream stream before
   ``wrap_response_stream()`` composes bounded catalog capture around it.
3. ``response()`` calls ``finalize_response()`` after the complete streamed response is
   available. Eligible captures are validated off the event loop before publication;
   ``error()`` calls ``handle_error()`` for upstream transport failure.
4. Response completion, response exceptions, transport errors, and WebSocket termination
   all reach ``release_flow_state()`` through the addon's terminal cleanup. Cleanup must
   remain last so pending validation and composed stream ownership have finished first.

Single-flight ownership
-----------------------
At most one in-flight owner is current for a cache key, and followers wait on that owner's
future. Every owner path must publish either the stored entry or a no-entry result before
releasing reserved flow capacity, so followers wake and may recheck the cache or become a
replacement owner. Publication and capacity release are idempotent, and an old owner may
remove itself only while it is still current; terminal cleanup supplies the no-entry fallback
for abandoned flows.

Validation uses a cache-owned single-worker executor. Failed submissions cancel its queued
work before releasing admission; the next response can create a new executor. Once a future
is returned, cancellation waits for validation and publication to finish. Addon shutdown
closes validation admission and joins the worker without cancelling accepted futures.

Response modes and authenticated ETags
---------------------------------------
Ordinary owners require identity responses. Prefetch owners request Brotli; for an eligible
Brotli response, the compressed stream passes downstream unchanged while validation decodes
the bounded capture. A successful response to an authenticated Codex Responses request can
separately carry ``x-models-etag``; that signal is scoped to the same credential digest,
renews matching entries, removes mismatches, and prevents an in-flight catalog response with
a conflicting ETag from being stored.

Keep this contract synchronized with the owning ``mitm_addon`` hooks and these focused test
modules:

- ``test_codex_model_catalog_cache_coordination.py``
- ``test_codex_model_catalog_cache_lifecycle.py``
- ``test_codex_model_catalog_cache_responses.py``
- ``test_codex_model_catalog_cache_hooks.py``
- ``test_codex_model_catalog_cache_async_validation.py``
"""

import asyncio
import hashlib
import hmac
import json
import math
import secrets
import time
import urllib.parse
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Iterable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import NoReturn

from mitmproxy import http

import body_decoding
import content_length
import flow_metadata
from runtime_url_parsing import split_runtime_url

FRESH_SECONDS = 60.0
MAX_ENTRY_BYTES = 1024 * 1024
MAX_ENTRIES = 32
MAX_TOTAL_BYTES = 16 * 1024 * 1024
MAX_IN_FLIGHT_REQUESTS = MAX_TOTAL_BYTES // MAX_ENTRY_BYTES
MAX_WAITERS_PER_KEY = MAX_IN_FLIGHT_REQUESTS
MAX_TOTAL_WAITERS = MAX_IN_FLIGHT_REQUESTS * 2
MAX_IN_FLIGHT_WAIT_SECONDS = 10.0
_FIREWALL_NAME = "model-provider:codex-oauth-token"
_CATALOG_HOST = "chatgpt.com"
_CATALOG_PATH = "/backend-api/codex/models"
_RESPONSES_PATH = "/backend-api/codex/responses"
_CLIENT_VERSION_QUERY_NAME = "client_version"
_MAX_CLIENT_VERSION_BYTES = 128
_PERCENT_ENCODED_CHARACTERS_PER_BYTE = 3
MAX_CATALOG_QUERY_FIELDS = 1
# The name and value may encode every byte as %XX; the separating "=" stays literal.
MAX_CATALOG_QUERY_BYTES = (
    _PERCENT_ENCODED_CHARACTERS_PER_BYTE
    * (len(_CLIENT_VERSION_QUERY_NAME.encode()) + _MAX_CLIENT_VERSION_BYTES)
    + 1
)
_RAW_ACCEPT_ENCODING = b"accept-encoding"
# Match the normalizer's inclusive 64 KiB aggregate raw-value budget. Oversized
# requests bypass this optional cache without decoding or rewriting their values.
_MAX_ACCEPT_ENCODING_VALUE_BYTES = 64 * 1024
_MAX_ETAG_BYTES = 512
_MAX_CONTENT_TYPE_BYTES = 256
_MAX_JSON_NESTING = 128
_MAX_TELEMETRY_MILLISECONDS = 2_147_483_647
_MIN_QUOTED_ETAG_BYTES = 2
_ASCII_CONTROL_BOUNDARY = 0x20
_ASCII_DELETE = 0x7F
_HTTP_STATUS_SWITCHING_PROTOCOLS = 101
_HTTP_STATUS_OK = 200
_HTTP_STATUS_BAD_GATEWAY = 502
_FLOW_STATE = "_codex_model_catalog_cache_state"
_FLOW_TELEMETRY = "_codex_model_catalog_cache_telemetry"
_PREFETCH_REQUEST = "_codex_model_catalog_prefetch_request"
_PREFETCH_HEADER = "X-Okou-Codex-Model-Catalog-Prefetch"
_RAW_PREFETCH_HEADER = b"x-okou-codex-model-catalog-prefetch"
_BROTLI_ENCODING = "br"
_IDENTITY_ENCODING = "identity"
_REQUEST_CONDITIONAL_HEADERS = (
    "If-Match",
    "If-Modified-Since",
    "If-None-Match",
    "If-Range",
    "If-Unmodified-Since",
    "Range",
)
_REVALIDATION_CACHE_CONTROL = frozenset(
    ("must-revalidate", "no-cache", "no-store", "proxy-revalidate")
)
_NO_TRANSFORM_CACHE_CONTROL = "no-transform"

_ResponseStream = Callable[[bytes], bytes | Iterable[bytes]]


@dataclass(frozen=True)
class _CacheKey:
    url: str
    credential_digest: bytes = field(repr=False)


@dataclass(frozen=True)
class _CacheEntry:
    body: bytes = field(repr=False)
    content_type: str
    etag: str = field(repr=False)
    validated_at: float
    prefetched: bool


@dataclass(frozen=True)
class _ResponseValidationSnapshot:
    status_code: int
    header_fields: tuple[tuple[bytes, bytes], ...] = field(repr=False)
    has_trailers: bool
    body: bytes = field(repr=False)
    upstream_encoding: str | None
    compressed_content_length: int | None


@dataclass(frozen=True)
class _ValidatedResponse:
    body: bytes = field(repr=False)
    content_type: str
    etag: str = field(repr=False)


@dataclass
class _FlowTelemetry:
    status: str
    bypass_reason: str | None = None
    entry_age_ms: int | None = None
    validation_latency_ms: int | None = None
    eviction_count: int = 0
    upstream_encoding: str | None = None
    prefetch_role: str | None = None


@dataclass
class _InFlight:
    future: asyncio.Future[_CacheEntry | None] = field(repr=False)
    prefetch_owner: bool
    waiters: int = 0
    observed_etag: str | None = field(default=None, repr=False)


@dataclass
class _FlowState:
    key: _CacheKey
    request_started_at: float
    entry_age_ms: int | None
    in_flight: _InFlight = field(repr=False)
    prefetch_owner: bool = False
    upstream_encoding: str | None = None
    compressed_content_length: int | None = None
    capture: bytearray | None = field(default=None, repr=False)
    capture_overflow: bool = False
    downstream_stream: _ResponseStream | None = field(default=None, repr=False)
    wrapper_stream: _ResponseStream | None = field(default=None, repr=False)
    finalized: bool = False
    capacity_reserved: bool = True
    result_published: bool = False


_entries: OrderedDict[_CacheKey, _CacheEntry] = OrderedDict()
_in_flight: dict[_CacheKey, _InFlight] = {}
_owned_body_bytes = 0
_active_flow_states = 0
_process_hmac_key = secrets.token_bytes(32)
_validation_loop: asyncio.AbstractEventLoop | None = None
_validation_semaphore: asyncio.Semaphore | None = None
_validation_executor: ThreadPoolExecutor | None = None
_validation_shut_down = False


def _bounded_milliseconds(seconds: float) -> int:
    return min(_MAX_TELEMETRY_MILLISECONDS, max(0, int(seconds * 1000)))


def _age_milliseconds(entry: _CacheEntry, now: float) -> int:
    return _bounded_milliseconds(now - entry.validated_at)


def _remove_entry(key: _CacheKey) -> bool:
    global _owned_body_bytes
    entry = _entries.pop(key, None)
    if entry is None:
        return False
    _owned_body_bytes -= len(entry.body)
    return True


def _reserve_flow_capacity() -> bool:
    global _active_flow_states
    if _active_flow_states >= MAX_IN_FLIGHT_REQUESTS:
        return False
    _active_flow_states += 1
    return True


def _release_flow_capacity(state: _FlowState) -> None:
    global _active_flow_states
    if not state.result_published:
        _publish_result(state, None)
    if state.capacity_reserved:
        _active_flow_states -= 1
        state.capacity_reserved = False
    state.capture = None


def _publish_result(state: _FlowState, entry: _CacheEntry | None) -> None:
    if state.result_published:
        return
    state.result_published = True
    if _in_flight.get(state.key) is state.in_flight:
        del _in_flight[state.key]
    if not state.in_flight.future.done():
        state.in_flight.future.set_result(entry)


def _waiter_capacity_available(in_flight: _InFlight) -> bool:
    return (
        in_flight.waiters < MAX_WAITERS_PER_KEY
        and sum(candidate.waiters for candidate in _in_flight.values()) < MAX_TOTAL_WAITERS
    )


def _replace_entry(key: _CacheKey, entry: _CacheEntry) -> int:
    global _owned_body_bytes
    _remove_entry(key)
    _entries[key] = entry
    _owned_body_bytes += len(entry.body)

    evictions = 0
    while len(_entries) > MAX_ENTRIES or _owned_body_bytes > MAX_TOTAL_BYTES:
        oldest_key = next(iter(_entries))
        _remove_entry(oldest_key)
        evictions += 1
    return evictions


def _length_delimited(value: str) -> bytes:
    encoded = value.encode()
    return len(encoded).to_bytes(8, "big") + encoded


def _credential_digest(flow: http.HTTPFlow) -> bytes | None:
    authorization_values = flow.request.headers.get_all("Authorization")
    account_values = flow.request.headers.get_all("ChatGPT-Account-ID")
    if len(authorization_values) != 1 or len(account_values) != 1:
        return None
    authorization = authorization_values[0]
    account = account_values[0]
    if not authorization or not account:
        return None
    material = _length_delimited(authorization) + _length_delimited(account)
    return hmac.new(_process_hmac_key, material, hashlib.sha256).digest()


def _split_expected_url(original_url: str) -> urllib.parse.SplitResult | None:
    try:
        parsed = split_runtime_url(original_url)
        port = parsed.port
    except ValueError:
        return None
    if (
        parsed.scheme.lower() != "https"
        or parsed.hostname is None
        or parsed.hostname.lower() != _CATALOG_HOST
        or port not in (None, 443)
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
    ):
        return None
    return parsed


def _catalog_url(original_url: str) -> str | None:
    parsed = _split_expected_url(original_url)
    if parsed is None or parsed.path != _CATALOG_PATH:
        return None
    raw_query = parsed.query
    # Bound the allocation used to reconstruct mitmproxy's surrogate-escaped path bytes.
    if (
        len(raw_query) > MAX_CATALOG_QUERY_BYTES
        or len(raw_query.encode("utf-8", "surrogateescape")) > MAX_CATALOG_QUERY_BYTES
    ):
        return None
    try:
        query = urllib.parse.parse_qsl(
            raw_query,
            keep_blank_values=True,
            strict_parsing=True,
            encoding="utf-8",
            errors="strict",
            max_num_fields=MAX_CATALOG_QUERY_FIELDS,
        )
    except ValueError:
        return None
    if len(query) != MAX_CATALOG_QUERY_FIELDS or query[0][0] != _CLIENT_VERSION_QUERY_NAME:
        return None
    client_version = query[0][1]
    if not client_version:
        return None
    try:
        encoded_client_version = client_version.encode()
    except UnicodeEncodeError:
        return None
    if len(encoded_client_version) > _MAX_CLIENT_VERSION_BYTES or any(
        ord(character) < _ASCII_CONTROL_BOUNDARY or ord(character) == _ASCII_DELETE
        for character in client_version
    ):
        return None
    encoded_version = urllib.parse.quote(client_version, safe="")
    return f"https://{_CATALOG_HOST}{_CATALOG_PATH}?{_CLIENT_VERSION_QUERY_NAME}={encoded_version}"


def _is_catalog_path(original_url: str) -> bool:
    parsed = _split_expected_url(original_url)
    return parsed is not None and parsed.path == _CATALOG_PATH


def _is_responses_path(original_url: str) -> bool:
    parsed = _split_expected_url(original_url)
    if parsed is None:
        return False
    return parsed.path == _RESPONSES_PATH or parsed.path.startswith(f"{_RESPONSES_PATH}/")


def _strict_utf8_bytes(value: str) -> bytes | None:
    try:
        return value.encode()
    except UnicodeEncodeError:
        return None


def _usable_etag_value(value: str) -> str | None:
    value = value.strip()
    if not value or value == "*":
        return None
    encoded = _strict_utf8_bytes(value)
    if encoded is None or len(encoded) > _MAX_ETAG_BYTES:
        return None
    opaque = value[2:] if value.startswith("W/") else value
    if (
        len(opaque) < _MIN_QUOTED_ETAG_BYTES
        or not opaque.startswith('"')
        or not opaque.endswith('"')
        or any(
            character == '"'
            or ord(character) <= _ASCII_CONTROL_BOUNDARY
            or ord(character) == _ASCII_DELETE
            for character in opaque[1:-1]
        )
    ):
        return None
    return value


def _single_usable_etag(headers: http.Headers) -> str | None:
    values = headers.get_all("ETag")
    if len(values) != 1:
        return None
    return _usable_etag_value(values[0])


def _single_content_encoding(headers: http.Headers) -> str | None:
    values = headers.get_all("Content-Encoding")
    if not values:
        return _IDENTITY_ENCODING
    tokens = [
        token.strip().lower() for value in values for token in value.split(",") if token.strip()
    ]
    if len(tokens) != 1:
        return None
    return tokens[0]


def _request_accepts_encoded_response(headers: http.Headers) -> bool:
    remaining_bytes = _MAX_ACCEPT_ENCODING_VALUE_BYTES
    has_header = False
    for raw_name, raw_value in headers.fields:
        if raw_name.lower() != _RAW_ACCEPT_ENCODING:
            continue
        has_header = True
        if len(raw_value) > remaining_bytes:
            return True
        remaining_bytes -= len(raw_value)
    if not has_header:
        return False

    has_identity = False
    for raw_name, raw_value in headers.fields:
        if raw_name.lower() != _RAW_ACCEPT_ENCODING:
            continue
        # Preserve mitmproxy's decoding and the existing string whitespace rules,
        # but stop before decoding later fields once a token requires bypassing.
        value = raw_value.decode("utf-8", "surrogateescape")
        start = 0
        while start < len(value):
            end = value.find(",", start)
            if end == -1:
                end = len(value)
            token = value[start:end].strip()
            if token:
                if has_identity or token.lower() != _IDENTITY_ENCODING:
                    return True
                has_identity = True
            start = end + 1
    return not has_identity


def _cache_control_directive_names(headers: http.Headers) -> set[str]:
    return {
        token.partition("=")[0].strip().lower()
        for value in headers.get_all("Cache-Control")
        for token in value.split(",")
        if token.strip()
    }


def _response_cache_control_is_unsafe(headers: http.Headers) -> bool:
    if headers.get_all("Expires"):
        return True
    directive_names = _cache_control_directive_names(headers)
    if (
        directive_names.intersection(_REVALIDATION_CACHE_CONTROL)
        or directive_names.intersection(("max-age", "s-maxage"))
        or _NO_TRANSFORM_CACHE_CONTROL in directive_names
    ):
        return True
    return any(
        token.strip().lower() == "no-cache"
        for value in headers.get_all("Pragma")
        for token in value.split(",")
    )


def _content_type_is_json(content_type: str) -> bool:
    media_type = content_type.partition(";")[0].strip().lower()
    return media_type == "application/json" or (
        media_type.startswith("application/") and media_type.endswith("+json")
    )


def _reject_non_json_constant(_value: str) -> NoReturn:
    raise ValueError("non-standard JSON constant")


def _parse_finite_json_float(value: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed):
        raise ValueError("non-finite JSON number")
    return parsed


def _json_nesting_is_bounded(document: str) -> bool:
    depth = 0
    in_string = False
    escaped = False
    for character in document:
        if in_string:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            continue
        if character == '"':
            in_string = True
        elif character in "[{":
            depth += 1
            if depth > _MAX_JSON_NESTING:
                return False
        elif character in "]}":
            depth -= 1
    return True


def _parse_content_length(headers: http.Headers) -> content_length.ContentLengthResult:
    return content_length.parse(
        headers.get_all("Content-Length"),
        max_value=MAX_ENTRY_BYTES,
    )


def _set_telemetry(
    flow: http.HTTPFlow,
    status: str,
    *,
    bypass_reason: str | None = None,
    entry_age_ms: int | None = None,
    validation_latency_ms: int | None = None,
    eviction_count: int = 0,
    upstream_encoding: str | None = None,
    prefetch_role: str | None = None,
) -> None:
    flow.metadata[_FLOW_TELEMETRY] = _FlowTelemetry(
        status=status,
        bypass_reason=bypass_reason,
        entry_age_ms=entry_age_ms,
        validation_latency_ms=validation_latency_ms,
        eviction_count=eviction_count,
        upstream_encoding=upstream_encoding,
        prefetch_role=prefetch_role,
    )


def _set_not_stored(
    flow: http.HTTPFlow,
    state: _FlowState,
    reason: str,
    *,
    now: float | None = None,
) -> None:
    completed_at = time.monotonic() if now is None else now
    _set_telemetry(
        flow,
        "model_catalog_cold_not_stored",
        bypass_reason=reason,
        entry_age_ms=state.entry_age_ms,
        validation_latency_ms=_bounded_milliseconds(completed_at - state.request_started_at),
        upstream_encoding=state.upstream_encoding,
        prefetch_role="producer" if state.prefetch_owner else None,
    )


def _make_catalog_response(entry: _CacheEntry) -> http.Response:
    return http.Response.make(
        200,
        entry.body,
        {
            "Content-Type": entry.content_type,
            "ETag": entry.etag,
        },
    )


def _request_bypass_reason(
    flow: http.HTTPFlow,
    *,
    request_end_stream: bool,
) -> str | None:
    if flow.request.method.upper() != "GET":
        return "request_method"
    if not request_end_stream:
        return "request_framing"
    if flow.request.raw_content:
        return "request_body"
    if flow.request.stream:
        return "request_streaming"
    parsed_content_length = _parse_content_length(flow.request.headers)
    if (
        flow.request.headers.get_all("Transfer-Encoding")
        or parsed_content_length.kind in ("invalid", "conflicting", "over_limit")
        or (parsed_content_length.kind == "valid" and parsed_content_length.value > 0)
    ):
        return "request_framing"
    if any(flow.request.headers.get_all(name) for name in _REQUEST_CONDITIONAL_HEADERS):
        return "request_conditions"
    if flow.request.headers.get_all("Cache-Control") or flow.request.headers.get_all("Pragma"):
        return "request_cache_control"
    if _request_accepts_encoded_response(flow.request.headers):
        return "request_encoding"
    return None


def capture_and_strip_prefetch_marker(flow: http.HTTPFlow) -> None:
    """Capture the runner-only prefetch marker without forwarding it upstream."""
    raw_value: bytes | None = None
    repeated = False
    for name, value in flow.request.headers.fields:
        if name.lower() != _RAW_PREFETCH_HEADER:
            continue
        if raw_value is not None:
            repeated = True
            break
        raw_value = value

    if raw_value is None:
        return
    flow.request.headers.set_all(_PREFETCH_HEADER, [])
    if not repeated and len(raw_value) == 1 and raw_value == b"1":
        flow.metadata[_PREFETCH_REQUEST] = True


async def prepare_request(flow: http.HTTPFlow, *, request_end_stream: bool) -> bool:
    """Serve or prepare a catalog request and report whether it crossed a wait.

    ``True`` means the request waited for at least one in-flight owner. The wait may
    end through owner success, failure or release, timeout, invalidation, or
    replacement, and the waiter may subsequently become the replacement owner. A
    local cache response does not continue upstream. Otherwise, a caller that may
    inject ordinary upstream credentials must revalidate the current upstream
    continuation before proceeding after a ``True`` result.

    ``mitm_addon._prepare_codex_catalog_request_with_upstream_revalidation()``
    implements this contract. Its focused lifecycle coverage is
    ``test_catalog_wait_revalidates_only_provider_continuation``.
    """
    if _FLOW_STATE in flow.metadata or _FLOW_TELEMETRY in flow.metadata:
        return False
    if flow_metadata.firewall_name(flow.metadata) != _FIREWALL_NAME:
        return False

    original_url = flow_metadata.original_url(flow.metadata)
    if not _is_catalog_path(original_url):
        return False

    canonical_url = _catalog_url(original_url)
    if canonical_url is None:
        _set_telemetry(flow, "model_catalog_bypass", bypass_reason="request_url")
        return False

    bypass_reason = _request_bypass_reason(
        flow,
        request_end_stream=request_end_stream,
    )
    if bypass_reason is not None:
        _set_telemetry(flow, "model_catalog_bypass", bypass_reason=bypass_reason)
        return False

    credential_digest = _credential_digest(flow)
    if credential_digest is None:
        _set_telemetry(flow, "model_catalog_bypass", bypass_reason="request_identity")
        return False

    key = _CacheKey(canonical_url, credential_digest)
    is_prefetch = flow.metadata.get(_PREFETCH_REQUEST) is True
    wait_deadline: float | None = None

    while True:
        now = time.monotonic()
        entry = _entries.get(key)
        if entry is not None:
            entry_age_ms = _age_milliseconds(entry, now)
            if now - entry.validated_at < FRESH_SECONDS:
                _entries.move_to_end(key)
                flow.response = _make_catalog_response(entry)
                _set_telemetry(
                    flow,
                    "model_catalog_fresh_hit",
                    entry_age_ms=entry_age_ms,
                    prefetch_role=(
                        "completed_consumer" if entry.prefetched and not is_prefetch else None
                    ),
                )
                return wait_deadline is not None
            _remove_entry(key)
        else:
            entry_age_ms = None

        in_flight = _in_flight.get(key)
        if in_flight is not None:
            if not _waiter_capacity_available(in_flight):
                _set_telemetry(
                    flow,
                    "model_catalog_bypass",
                    bypass_reason="request_capacity",
                    entry_age_ms=entry_age_ms,
                )
                return wait_deadline is not None
            if wait_deadline is None:
                wait_deadline = now + MAX_IN_FLIGHT_WAIT_SECONDS
            remaining_wait_seconds = wait_deadline - now
            if remaining_wait_seconds <= 0:
                _set_telemetry(
                    flow,
                    "model_catalog_bypass",
                    bypass_reason="request_capacity",
                    entry_age_ms=entry_age_ms,
                )
                return True
            joined_prefetch = in_flight.prefetch_owner and not is_prefetch
            in_flight.waiters += 1
            try:
                completed_entry = await asyncio.wait_for(
                    asyncio.shield(in_flight.future),
                    timeout=remaining_wait_seconds,
                )
            except TimeoutError:
                _set_telemetry(
                    flow,
                    "model_catalog_bypass",
                    bypass_reason="request_capacity",
                    entry_age_ms=entry_age_ms,
                )
                return True
            finally:
                in_flight.waiters -= 1
            if completed_entry is None:
                continue
            if _entries.get(key) is not completed_entry:
                continue
            completed_at = time.monotonic()
            if completed_at - completed_entry.validated_at >= FRESH_SECONDS:
                continue
            flow.response = _make_catalog_response(completed_entry)
            _set_telemetry(
                flow,
                "model_catalog_fresh_hit",
                entry_age_ms=_age_milliseconds(completed_entry, completed_at),
                prefetch_role="inflight_consumer" if joined_prefetch else None,
            )
            return True

        if not _reserve_flow_capacity():
            _set_telemetry(
                flow,
                "model_catalog_bypass",
                bypass_reason="request_capacity",
                entry_age_ms=entry_age_ms,
            )
            return wait_deadline is not None
        in_flight = _InFlight(
            future=asyncio.get_running_loop().create_future(),
            prefetch_owner=is_prefetch,
        )
        _in_flight[key] = in_flight
        state = _FlowState(
            key=key,
            request_started_at=now,
            entry_age_ms=entry_age_ms,
            in_flight=in_flight,
            prefetch_owner=is_prefetch,
        )
        flow.metadata[_FLOW_STATE] = state
        if is_prefetch:
            flow.request.headers["Accept-Encoding"] = _BROTLI_ENCODING
        return wait_deadline is not None


def _response_headers_bypass_reason(
    status_code: int,
    headers: http.Headers,
    *,
    allow_brotli: bool = False,
) -> str | None:
    if status_code != _HTTP_STATUS_OK:
        return "response_status"
    encoding = _single_content_encoding(headers)
    if encoding != _IDENTITY_ENCODING and not (allow_brotli and encoding == _BROTLI_ENCODING):
        return "response_encoding"
    content_type = headers.get("Content-Type", "")
    encoded_content_type = _strict_utf8_bytes(content_type)
    if (
        encoded_content_type is None
        or len(encoded_content_type) > _MAX_CONTENT_TYPE_BYTES
        or not _content_type_is_json(content_type)
    ):
        return "response_content_type"
    if _response_cache_control_is_unsafe(headers):
        return "response_cache_control"
    if headers.get_all("Vary"):
        return "response_vary"
    if _single_usable_etag(headers) is None:
        return "response_etag"
    parsed_content_length = _parse_content_length(headers)
    if parsed_content_length.kind not in ("missing", "valid") or (
        parsed_content_length.kind == "valid" and headers.get_all("Transfer-Encoding")
    ):
        return "response_size"
    return None


def _renew_entry(key: _CacheKey, entry: _CacheEntry, now: float) -> _CacheEntry:
    renewed = _CacheEntry(
        body=entry.body,
        content_type=entry.content_type,
        etag=entry.etag,
        validated_at=now,
        prefetched=entry.prefetched,
    )
    _replace_entry(key, renewed)
    return renewed


def _bypass_response(
    flow: http.HTTPFlow,
    state: _FlowState,
    reason: str,
) -> None:
    _set_not_stored(flow, state, reason)
    state.finalized = True
    _release_flow_capacity(state)


def _discard_upstream_response_body(_chunk: bytes) -> bytes:
    return b""


def _reject_encoded_response(
    flow: http.HTTPFlow,
    state: _FlowState,
) -> None:
    _set_not_stored(flow, state, "response_encoding")
    state.finalized = True
    _release_flow_capacity(state)
    flow.response = http.Response.make(
        _HTTP_STATUS_BAD_GATEWAY,
        b"",
        {"Content-Type": "text/plain"},
    )
    flow.response.stream = _discard_upstream_response_body


def handle_response_headers(flow: http.HTTPFlow) -> bool:
    """Prepare catalog handling and tell mitm_addon.responseheaders() whether to continue.

    Return False when the hook must stop the normal response-header pipeline: either for a
    fresh response served from the local catalog cache or for an encoded ordinary response
    replaced with a fixed proxy error. Return True for all other flows, including unrelated
    traffic, cache bypasses, and eligible cold responses. For an eligible cold response,
    ordinary streaming is installed before wrap_response_stream() composes the bounded catalog
    capture.

    ``mitm_addon.responseheaders()`` implements this contract. Focused coverage is
    ``test_fresh_hit_is_partitioned_and_expiry_never_uses_conditions`` for the stop branch and
    ``test_request_bypasses_do_not_touch_unrelated_traffic`` for continuation.
    """
    state = flow.metadata.get(_FLOW_STATE)
    telemetry = flow.metadata.get(_FLOW_TELEMETRY)
    if isinstance(telemetry, _FlowTelemetry) and telemetry.status == "model_catalog_fresh_hit":
        return False
    if not isinstance(state, _FlowState) or flow.response is None:
        return True

    encoding = _single_content_encoding(flow.response.headers)
    if encoding == _IDENTITY_ENCODING:
        state.upstream_encoding = _IDENTITY_ENCODING
        bypass_reason = _response_headers_bypass_reason(
            flow.response.status_code,
            flow.response.headers,
        )
        if bypass_reason is not None:
            _bypass_response(flow, state, bypass_reason)
        return True
    if not state.prefetch_owner:
        if encoding == _BROTLI_ENCODING:
            state.upstream_encoding = _BROTLI_ENCODING
        _reject_encoded_response(flow, state)
        return False
    if encoding != _BROTLI_ENCODING:
        _bypass_response(flow, state, "response_encoding")
        return True

    state.upstream_encoding = _BROTLI_ENCODING
    bypass_reason = _response_headers_bypass_reason(
        flow.response.status_code,
        flow.response.headers,
        allow_brotli=True,
    )
    if bypass_reason is not None:
        _bypass_response(flow, state, bypass_reason)
        return True

    compressed_content_length = _parse_content_length(flow.response.headers)
    state.compressed_content_length = (
        compressed_content_length.value if compressed_content_length.kind == "valid" else None
    )
    return True


def wrap_response_stream(flow: http.HTTPFlow) -> None:
    """Capture an eligible upstream 200 while preserving the existing stream."""
    state = flow.metadata.get(_FLOW_STATE)
    if (
        not isinstance(state, _FlowState)
        or state.finalized
        or flow.response is None
        or _response_headers_bypass_reason(
            flow.response.status_code,
            flow.response.headers,
            allow_brotli=state.upstream_encoding == _BROTLI_ENCODING,
        )
        is not None
    ):
        return
    downstream = flow.response.stream
    if not callable(downstream):
        _set_not_stored(flow, state, "response_stream")
        return

    state.capture = bytearray()
    state.downstream_stream = downstream

    def capture_and_stream(chunk: bytes) -> bytes | Iterable[bytes]:
        if state.capture is not None and not state.capture_overflow:
            remaining = MAX_ENTRY_BYTES - len(state.capture)
            if len(chunk) <= remaining:
                state.capture.extend(chunk)
            else:
                state.capture.extend(chunk[:remaining])
                state.capture_overflow = True
        return downstream(chunk)

    state.wrapper_stream = capture_and_stream
    flow.response.stream = capture_and_stream


def _unwrap_response_stream(flow: http.HTTPFlow, state: _FlowState) -> None:
    response = flow.response
    if (
        response is not None
        and state.wrapper_stream is not None
        and response.stream is state.wrapper_stream
    ):
        response.stream = state.downstream_stream or False
    state.wrapper_stream = None
    state.downstream_stream = None


def _validate_response_snapshot(
    snapshot: _ResponseValidationSnapshot,
) -> _ValidatedResponse | str:
    headers = http.Headers(snapshot.header_fields)
    body = snapshot.body
    if snapshot.upstream_encoding == _BROTLI_ENCODING:
        if (
            snapshot.compressed_content_length is not None
            and len(body) != snapshot.compressed_content_length
        ) or snapshot.has_trailers:
            return "response_body"
        body, decode_error = body_decoding.decompress_json_usage_body(
            body,
            headers,
            max_output=MAX_ENTRY_BYTES,
        )
        if decode_error == body_decoding.DECODED_BODY_LIMIT_EXCEEDED:
            return "response_size"
        if decode_error is not None:
            return "response_encoding"

    bypass_reason = _response_headers_bypass_reason(
        snapshot.status_code,
        headers,
        allow_brotli=snapshot.upstream_encoding == _BROTLI_ENCODING,
    )
    if bypass_reason is not None:
        return bypass_reason
    if snapshot.has_trailers:
        return "response_body"

    parsed_content_length = _parse_content_length(headers)
    if (
        snapshot.upstream_encoding == _IDENTITY_ENCODING
        and parsed_content_length.kind == "valid"
        and parsed_content_length.value != len(body)
    ):
        return "response_body"
    try:
        document = body.decode("utf-8")
    except UnicodeDecodeError:
        return "response_json"
    if not _json_nesting_is_bounded(document):
        return "response_json"
    try:
        payload = json.loads(
            document,
            parse_constant=_reject_non_json_constant,
            parse_float=_parse_finite_json_float,
        )
    except (ValueError, RecursionError):
        return "response_json"
    if not isinstance(payload, dict) or not isinstance(payload.get("models"), list):
        return "response_shape"
    content_type = headers.get("Content-Type", "")
    etag = _single_usable_etag(headers)
    if etag is None:
        return "response_etag"
    return _ValidatedResponse(body=body, content_type=content_type, etag=etag)


def _validation_semaphore_for_running_loop() -> asyncio.Semaphore:
    global _validation_loop, _validation_semaphore
    loop = asyncio.get_running_loop()
    if _validation_loop is not loop or _validation_semaphore is None:
        _validation_loop = loop
        _validation_semaphore = asyncio.Semaphore(1)
    return _validation_semaphore


async def _validate_response_off_loop(
    snapshot: _ResponseValidationSnapshot,
) -> tuple[_ValidatedResponse | str, asyncio.CancelledError | None]:
    global _validation_executor
    semaphore = _validation_semaphore_for_running_loop()
    async with semaphore:
        if _validation_shut_down:
            raise RuntimeError("Catalog validation is shut down")
        if _validation_executor is None:
            _validation_executor = ThreadPoolExecutor(
                max_workers=1,
                thread_name_prefix="codex-catalog-validation",
            )
        executor = _validation_executor
        loop = asyncio.get_running_loop()
        try:
            validation = loop.run_in_executor(executor, _validate_response_snapshot, snapshot)
        except BaseException:
            # submit() queues before starting a worker and may raise without returning
            # its future. Own and drain that queue before the caller releases admission.
            _validation_executor = None
            executor.shutdown(wait=True, cancel_futures=True)
            raise
        cancellation: asyncio.CancelledError | None = None
        while True:
            try:
                result = await asyncio.shield(validation)
                return result, cancellation
            except asyncio.CancelledError as error:
                if cancellation is None:
                    cancellation = error


async def _finalize_response_snapshot(
    flow: http.HTTPFlow,
    state: _FlowState,
    snapshot: _ResponseValidationSnapshot,
) -> None:
    try:
        validated, cancellation = await _validate_response_off_loop(snapshot)
        completed_at = time.monotonic()
        if isinstance(validated, str):
            _set_not_stored(flow, state, validated, now=completed_at)
        else:
            observed_etag = state.in_flight.observed_etag
            if state.key in _entries or (
                observed_etag is not None and observed_etag != validated.etag
            ):
                _set_not_stored(flow, state, "concurrent_change", now=completed_at)
            else:
                entry = _CacheEntry(
                    body=validated.body,
                    content_type=validated.content_type,
                    etag=validated.etag,
                    validated_at=completed_at,
                    prefetched=state.prefetch_owner,
                )
                evictions = _replace_entry(state.key, entry)
                _publish_result(state, entry)
                _set_telemetry(
                    flow,
                    "model_catalog_cold_stored",
                    entry_age_ms=state.entry_age_ms,
                    validation_latency_ms=_bounded_milliseconds(
                        completed_at - state.request_started_at
                    ),
                    eviction_count=evictions,
                    upstream_encoding=state.upstream_encoding,
                    prefetch_role="producer" if state.prefetch_owner else None,
                )
        if cancellation is not None:
            raise cancellation
    finally:
        _release_flow_capacity(state)


def finalize_response(flow: http.HTTPFlow) -> Awaitable[None] | None:
    """Start validation for one complete catalog response when eligible."""
    state = flow.metadata.get(_FLOW_STATE)
    if not isinstance(state, _FlowState) or state.finalized:
        return None
    state.finalized = True
    try:
        _unwrap_response_stream(flow, state)
        response = flow.response
        if response is None:
            _set_not_stored(flow, state, "response_missing")
            _release_flow_capacity(state)
            return None
        if state.capture is None or state.capture_overflow:
            _set_not_stored(flow, state, "response_size")
            _release_flow_capacity(state)
            return None
        body = bytes(state.capture)
        state.capture = None
        snapshot = _ResponseValidationSnapshot(
            status_code=response.status_code,
            header_fields=tuple(response.headers.fields),
            has_trailers=bool(response.trailers),
            body=body,
            upstream_encoding=state.upstream_encoding,
            compressed_content_length=state.compressed_content_length,
        )
    except BaseException:
        _release_flow_capacity(state)
        raise
    return _finalize_response_snapshot(flow, state, snapshot)


def handle_error(flow: http.HTTPFlow) -> None:
    """Record an upstream catalog failure."""
    state = flow.metadata.get(_FLOW_STATE)
    if not isinstance(state, _FlowState) or state.finalized:
        return
    state.finalized = True
    try:
        _unwrap_response_stream(flow, state)
        _set_not_stored(flow, state, "transport_error")
    finally:
        _release_flow_capacity(state)


def observe_authenticated_models_etag(flow: http.HTTPFlow) -> None:
    """Use an authenticated Responses signal to confirm or invalidate entries."""
    if (
        flow_metadata.firewall_name(flow.metadata) != _FIREWALL_NAME
        or flow.response is None
        or flow.response.status_code not in (_HTTP_STATUS_SWITCHING_PROTOCOLS, _HTTP_STATUS_OK)
        or not _is_responses_path(flow_metadata.original_url(flow.metadata))
    ):
        return
    values = flow.response.headers.get_all("x-models-etag")
    if len(values) != 1:
        return
    signal_etag = _usable_etag_value(values[0])
    if signal_etag is None:
        return
    credential_digest = _credential_digest(flow)
    if credential_digest is None:
        return

    for key, in_flight in _in_flight.items():
        if key.credential_digest == credential_digest:
            in_flight.observed_etag = signal_etag

    keys = [key for key in _entries if key.credential_digest == credential_digest]
    if not keys:
        return
    matching_keys = [key for key in keys if _entries[key].etag == signal_etag]
    mismatching_keys = [key for key in keys if _entries[key].etag != signal_etag]
    for key in mismatching_keys:
        _remove_entry(key)
    if not matching_keys:
        _set_telemetry(flow, "model_catalog_etag_invalidated")
        return

    now = time.monotonic()
    ages = [_age_milliseconds(_entries[key], now) for key in matching_keys]
    for key in matching_keys:
        _renew_entry(key, _entries[key], now)
    _set_telemetry(
        flow,
        "model_catalog_etag_confirmed",
        entry_age_ms=max(ages),
    )


def add_network_log_fields(flow: http.HTTPFlow, entry: dict[str, object]) -> None:
    """Project bounded cache telemetry onto one network-log row."""
    # [NETWORK_LOG_FIELDS] — shared schema and UI boundary is api-contracts.
    telemetry = flow.metadata.get(_FLOW_TELEMETRY)
    if not isinstance(telemetry, _FlowTelemetry):
        return
    entry["model_catalog_cache_status"] = telemetry.status
    if telemetry.bypass_reason is not None:
        entry["model_catalog_cache_bypass_reason"] = telemetry.bypass_reason
    if telemetry.entry_age_ms is not None:
        entry["model_catalog_cache_entry_age_ms"] = telemetry.entry_age_ms
    if telemetry.validation_latency_ms is not None:
        entry["model_catalog_cache_validation_latency_ms"] = telemetry.validation_latency_ms
    if telemetry.eviction_count:
        entry["model_catalog_cache_eviction_count"] = telemetry.eviction_count
    if telemetry.upstream_encoding is not None:
        entry["model_catalog_cache_upstream_encoding"] = telemetry.upstream_encoding
    if telemetry.prefetch_role is not None:
        entry["model_catalog_prefetch_role"] = telemetry.prefetch_role


def release_flow_state(flow: http.HTTPFlow) -> None:
    """Release cache-owned flow metadata and restore a composed stream callback."""
    state = flow.metadata.pop(_FLOW_STATE, None)
    if isinstance(state, _FlowState):
        _unwrap_response_stream(flow, state)
        _release_flow_capacity(state)
    flow.metadata.pop(_FLOW_TELEMETRY, None)
    flow.metadata.pop(_PREFETCH_REQUEST, None)


def shutdown() -> None:
    """Close validation admission and join accepted work before addon exit."""
    global _validation_executor, _validation_shut_down
    _validation_shut_down = True
    executor = _validation_executor
    _validation_executor = None
    if executor is not None:
        # Accepted futures must complete: their continuations still own publication
        # and flow capacity, including when the awaiting task has been cancelled.
        executor.shutdown(wait=True)


def reset_for_tests() -> None:
    """Reset process cache ownership between tests."""
    global _active_flow_states, _owned_body_bytes, _process_hmac_key
    global _validation_loop, _validation_semaphore, _validation_shut_down
    shutdown()
    for in_flight in _in_flight.values():
        if not in_flight.future.done():
            in_flight.future.set_result(None)
    _in_flight.clear()
    _entries.clear()
    _owned_body_bytes = 0
    _active_flow_states = 0
    _process_hmac_key = secrets.token_bytes(32)
    _validation_loop = None
    _validation_semaphore = None
    _validation_shut_down = False
