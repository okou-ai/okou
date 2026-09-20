"""X (Twitter) connector billing and usage reporting.

Computes per-permission billable resource counts from successful requests
through the X firewall and buffers their source events for platform upload.
"""

import urllib.parse
from collections.abc import Callable
from typing import NamedTuple

from mitmproxy import http

import billing_body
import body_decoding
import flow_metadata
import flow_metadata_keys as metadata_keys
import matching
import request_streaming
import stream_capture
from body_limits import REQUEST_BODY_BILLING_INSPECTION_LIMIT
from logging_utils import log_proxy_entry

from ...buffer import UsageEvent, buffer_source_usage_events
from ...idempotency import USAGE_EVENT_NAMESPACE_CONNECTOR, derive_usage_idempotency_key
from ...reporting_context import (
    log_usage_reporting_context_missing,
    usage_reporting_context,
)
from ...underbilling import log_usage_underbilling
from .response_parser import ConnectorResponseParser
from .x_billing import (
    INCLUDES_OVERFLOW_CATEGORY,
    MAX_UNKNOWN_INCLUDE_CATEGORIES,
    bucket_needs_body_refinement,
    classify_bucket,
    include_billing_category,
    refine_bucket_with_body,
)
from .x_resources import observed_at, resource_event
from .x_response_inspection import (
    as_non_negative_response_count,
    is_stream_path,
    parse_json_response_fields_from_body,
)
from .x_response_inspection import (
    create_response_parser as create_x_response_parser,
)

# HTTP 2xx success range (RFC 9110). Also defined in ``response_streaming.py``
# and ``x_response_inspection.py``; kept local to avoid a constants module for a
# simple bound. The upper bound is ``REDIRECT_MIN`` (300) because 300 is the
# first 3xx — using ``status < _HTTP_STATUS_REDIRECT_MIN`` reads as "still in
# 2xx" without the ambiguity of an ``OK_MAX`` that is itself excluded.
_HTTP_STATUS_OK_MIN = 200
_HTTP_STATUS_REDIRECT_MIN = 300

_COUNT_ENDPOINTS = frozenset(
    {
        "/2/tweets/counts/recent",
        "/2/tweets/counts/all",
    }
)


def _is_count_path(path: str) -> bool:
    return path in _COUNT_ENDPOINTS


def _strip_request_target_query(request_target: str) -> str:
    query_start = request_target.find("?")
    path_or_url = request_target if query_start == -1 else request_target[:query_start]
    scheme_separator = path_or_url.find("://")
    if scheme_separator != -1 and path_or_url[:scheme_separator].lower() in {"http", "https"}:
        authority_start = scheme_separator + len("://")
        path_start = path_or_url.find("/", authority_start)
        return "" if path_start == -1 else path_or_url[path_start:]
    return path_or_url


_REQUEST_BODY_REFINEMENT_LIMIT = REQUEST_BODY_BILLING_INSPECTION_LIMIT
_REQUEST_QUERY_HINT_MAX_BYTES = 64 * 1024
_REQUEST_QUERY_HINT_KEY_MAX_CHARS = 128
_REQUEST_QUERY_HINT_VALUE_MAX_BYTES = 16 * 1024
_REQUEST_ID_LIKE_QUERY_KEYS = frozenset({"ids", "usernames"})
_REQUEST_MAX_RESULTS_QUERY_KEY = "max_results"
_ASCII_CODEPOINT_LIMIT = 128


class _RequestFallbackHintPolicy(NamedTuple):
    id_query_key: str | None
    id_count_max: int | None
    max_results_min: int | None
    max_results_max: int | None


class _ResponseUsageContext(NamedTuple):
    permission: str
    request_path: str
    endpoint_bucket: str


_REQUEST_IDS_100_HINT_POLICY = _RequestFallbackHintPolicy("ids", 100, None, None)
_REQUEST_USERNAMES_100_HINT_POLICY = _RequestFallbackHintPolicy("usernames", 100, None, None)
_REQUEST_PAGE_1_TO_100_HINT_POLICY = _RequestFallbackHintPolicy(None, None, 1, 100)
_REQUEST_PAGE_5_TO_100_HINT_POLICY = _RequestFallbackHintPolicy(None, None, 5, 100)
_REQUEST_PAGE_10_TO_100_HINT_POLICY = _RequestFallbackHintPolicy(None, None, 10, 100)
_REQUEST_PAGE_1_TO_1000_HINT_POLICY = _RequestFallbackHintPolicy(None, None, 1, 1000)


_REQUEST_FALLBACK_HINT_POLICY_SPECS: tuple[tuple[str, _RequestFallbackHintPolicy], ...] = (
    # X query hints are trusted only for documented count-source parameters on
    # billable generated-firewall GET paths. App-only paths stay omitted because
    # ``classify_bucket`` skips them before fallback parsing.
    ("/2/spaces", _REQUEST_IDS_100_HINT_POLICY),
    ("/2/tweets", _REQUEST_IDS_100_HINT_POLICY),
    ("/2/tweets/analytics", _REQUEST_IDS_100_HINT_POLICY),
    ("/2/users", _REQUEST_IDS_100_HINT_POLICY),
    ("/2/users/by", _REQUEST_USERNAMES_100_HINT_POLICY),
    ("/2/users/public_keys", _REQUEST_IDS_100_HINT_POLICY),
    ("/2/chat/conversations", _REQUEST_PAGE_1_TO_100_HINT_POLICY),
    ("/2/communities/search", _REQUEST_PAGE_10_TO_100_HINT_POLICY),
    ("/2/dm_conversations/with/{participant_id}/dm_events", _REQUEST_PAGE_1_TO_100_HINT_POLICY),
    ("/2/dm_conversations/{id}/dm_events", _REQUEST_PAGE_1_TO_100_HINT_POLICY),
    ("/2/dm_events", _REQUEST_PAGE_1_TO_100_HINT_POLICY),
    ("/2/lists/{id}/followers", _REQUEST_PAGE_1_TO_100_HINT_POLICY),
    ("/2/lists/{id}/members", _REQUEST_PAGE_1_TO_100_HINT_POLICY),
    ("/2/lists/{id}/tweets", _REQUEST_PAGE_1_TO_100_HINT_POLICY),
    ("/2/news/search", _REQUEST_PAGE_1_TO_100_HINT_POLICY),
    ("/2/notes/search/notes_written", _REQUEST_PAGE_1_TO_100_HINT_POLICY),
    ("/2/notes/search/posts_eligible_for_notes", _REQUEST_PAGE_1_TO_100_HINT_POLICY),
    ("/2/spaces/search", _REQUEST_PAGE_1_TO_100_HINT_POLICY),
    ("/2/spaces/{id}/buyers", _REQUEST_PAGE_1_TO_100_HINT_POLICY),
    ("/2/spaces/{id}/tweets", _REQUEST_PAGE_1_TO_100_HINT_POLICY),
    ("/2/tweets/search/recent", _REQUEST_PAGE_10_TO_100_HINT_POLICY),
    ("/2/tweets/{id}/liking_users", _REQUEST_PAGE_1_TO_100_HINT_POLICY),
    ("/2/tweets/{id}/quote_tweets", _REQUEST_PAGE_10_TO_100_HINT_POLICY),
    ("/2/tweets/{id}/retweeted_by", _REQUEST_PAGE_1_TO_100_HINT_POLICY),
    ("/2/tweets/{id}/retweets", _REQUEST_PAGE_1_TO_100_HINT_POLICY),
    ("/2/users/reposts_of_me", _REQUEST_PAGE_1_TO_100_HINT_POLICY),
    ("/2/users/search", _REQUEST_PAGE_1_TO_1000_HINT_POLICY),
    ("/2/users/{id}/affiliates", _REQUEST_PAGE_1_TO_1000_HINT_POLICY),
    ("/2/users/{id}/blocking", _REQUEST_PAGE_1_TO_1000_HINT_POLICY),
    ("/2/users/{id}/bookmarks", _REQUEST_PAGE_1_TO_100_HINT_POLICY),
    ("/2/users/{id}/bookmarks/folders", _REQUEST_PAGE_1_TO_100_HINT_POLICY),
    ("/2/users/{id}/followed_lists", _REQUEST_PAGE_1_TO_100_HINT_POLICY),
    ("/2/users/{id}/followers", _REQUEST_PAGE_1_TO_1000_HINT_POLICY),
    ("/2/users/{id}/following", _REQUEST_PAGE_1_TO_1000_HINT_POLICY),
    ("/2/users/{id}/liked_tweets", _REQUEST_PAGE_5_TO_100_HINT_POLICY),
    ("/2/users/{id}/list_memberships", _REQUEST_PAGE_1_TO_100_HINT_POLICY),
    ("/2/users/{id}/mentions", _REQUEST_PAGE_5_TO_100_HINT_POLICY),
    ("/2/users/{id}/muting", _REQUEST_PAGE_1_TO_1000_HINT_POLICY),
    ("/2/users/{id}/owned_lists", _REQUEST_PAGE_1_TO_100_HINT_POLICY),
    ("/2/users/{id}/timelines/reverse_chronological", _REQUEST_PAGE_1_TO_100_HINT_POLICY),
    ("/2/users/{id}/tweets", _REQUEST_PAGE_5_TO_100_HINT_POLICY),
)


def _compile_request_fallback_hint_policies(
    specs: tuple[tuple[str, _RequestFallbackHintPolicy], ...],
) -> tuple[tuple[matching.CompiledPathPattern, _RequestFallbackHintPolicy], ...]:
    compiled_policies: list[tuple[matching.CompiledPathPattern, _RequestFallbackHintPolicy]] = []
    for path_pattern, policy in specs:
        compiled_pattern = matching.compile_path_pattern(path_pattern)
        if compiled_pattern is None:
            raise ValueError(f"invalid X fallback hint path pattern: {path_pattern}")
        compiled_policies.append((compiled_pattern, policy))
    return tuple(compiled_policies)


_REQUEST_FALLBACK_HINT_POLICIES = _compile_request_fallback_hint_policies(
    _REQUEST_FALLBACK_HINT_POLICY_SPECS
)


def _count_bounded_non_empty_comma_segments(value: str, max_count: int) -> int | None:
    count = 0
    for segment in value.split(","):
        if not segment.strip():
            continue
        count += 1
        if count > max_count:
            return None
    return count


def _empty_request_query_fallback_hints() -> dict:
    return {"request_ids_count": None, "max_results": None}


def _parse_request_metadata(original_url: str) -> dict:
    """Extract path-level request metadata from an X API request.

    Returns a dict with:
      - ``is_count_endpoint``: bool - True when the request path is an X Post
        Counts endpoint whose ``data`` array contains time buckets instead of
        returned posts.

    Query-derived fallback hints are handled separately by
    :func:`_parse_request_query_fallback_hints`.

    Parses the dispatcher-required original URL rather than ``pretty_url`` to
    stay consistent with the rest of the addon.
    """
    return {"is_count_endpoint": _is_count_path(urllib.parse.urlparse(original_url).path)}


def _decode_request_query_hint_key(raw_key: str) -> str | None:
    if len(raw_key) > _REQUEST_QUERY_HINT_KEY_MAX_CHARS:
        return None
    if raw_key in _REQUEST_ID_LIKE_QUERY_KEYS or raw_key == _REQUEST_MAX_RESULTS_QUERY_KEY:
        return raw_key
    if "%" not in raw_key and "+" not in raw_key:
        return None

    decoded_key = urllib.parse.unquote_plus(raw_key)
    if decoded_key in _REQUEST_ID_LIKE_QUERY_KEYS or decoded_key == _REQUEST_MAX_RESULTS_QUERY_KEY:
        return decoded_key
    return None


def _request_fallback_hint_policy_for_path(path: str) -> _RequestFallbackHintPolicy | None:
    for pattern, policy in _REQUEST_FALLBACK_HINT_POLICIES:
        if matching.match_compiled_path(path, pattern) is not None:
            return policy
    return None


def _parse_bounded_positive_decimal(value: str, min_value: int, max_value: int) -> int | None:
    if not value or any(char < "0" or char > "9" for char in value):
        return None
    if value.startswith("0"):
        return None
    if len(value) > len(str(max_value)):
        return None

    parsed = int(value)
    if min_value <= parsed <= max_value:
        return parsed
    return None


def _slice_exceeds_query_hint_byte_limit(value: str, start: int, end: int, max_bytes: int) -> bool:
    if end - start > max_bytes:
        return True

    size = 0
    for index in range(start, end):
        char = value[index]
        if ord(char) < _ASCII_CODEPOINT_LIMIT:
            size += 1
        else:
            try:
                size += len(char.encode("utf-8"))
            except UnicodeEncodeError:
                return True
        if size > max_bytes:
            return True
    return False


def _exceeds_query_hint_byte_limit(value: str, max_bytes: int) -> bool:
    return _slice_exceeds_query_hint_byte_limit(value, 0, len(value), max_bytes)


def _get_bounded_original_request_query(original_url: str) -> str | None:
    query_start = original_url.find("?")
    if query_start == -1:
        return ""

    value_start = query_start + 1
    fragment_start = original_url.find("#", value_start)
    value_end = len(original_url) if fragment_start == -1 else fragment_start
    if _slice_exceeds_query_hint_byte_limit(
        original_url, value_start, value_end, _REQUEST_QUERY_HINT_MAX_BYTES
    ):
        return None

    if fragment_start == -1:
        return original_url[value_start:]
    return original_url[value_start:fragment_start]


def _parse_request_query_fallback_hints(original_url: str) -> dict:
    """Extract endpoint-scoped count hints for unparseable non-count GETs.

    This intentionally does not call ``parse_qs``.  Successful X responses
    normally bill from the parsed response body, so query hints are only a
    fallback for lost response visibility.  ``report_usage`` merges these
    fields only when a non-count GET response was not parsed.  Even then, the
    scanner trusts a query hint only when the current endpoint documents that
    hint as count visibility, and caps work on hostile query strings instead of
    materializing every parameter.

    Returns ``request_ids_count`` and ``max_results``.
    """
    policy = _request_fallback_hint_policy_for_path(urllib.parse.urlparse(original_url).path)
    if policy is None:
        return _empty_request_query_fallback_hints()

    query = _get_bounded_original_request_query(original_url)
    if query is None:
        return _empty_request_query_fallback_hints()

    ids_count = 0
    max_results: int | None = None
    max_results_seen = False
    start = 0
    while start <= len(query):
        end = query.find("&", start)
        if end == -1:
            end = len(query)
        raw_pair = query[start:end]
        if raw_pair:
            raw_key, separator, raw_value = raw_pair.partition("=")
            if separator and raw_value:
                hint_key = _decode_request_query_hint_key(raw_key)
                if hint_key is not None:
                    id_count_max = policy.id_count_max if hint_key == policy.id_query_key else None
                    max_results_min = (
                        policy.max_results_min
                        if hint_key == _REQUEST_MAX_RESULTS_QUERY_KEY and not max_results_seen
                        else None
                    )
                    max_results_max = (
                        policy.max_results_max
                        if hint_key == _REQUEST_MAX_RESULTS_QUERY_KEY and not max_results_seen
                        else None
                    )
                    if id_count_max is not None or (
                        max_results_min is not None and max_results_max is not None
                    ):
                        if _exceeds_query_hint_byte_limit(
                            raw_value, _REQUEST_QUERY_HINT_VALUE_MAX_BYTES
                        ):
                            return _empty_request_query_fallback_hints()

                        decoded_value = urllib.parse.unquote_plus(raw_value)
                        if id_count_max is not None:
                            remaining = id_count_max - ids_count
                            value_count = _count_bounded_non_empty_comma_segments(
                                decoded_value, remaining
                            )
                            if value_count is None:
                                ids_count = 0
                                break
                            ids_count += value_count
                        elif max_results_min is not None and max_results_max is not None:
                            max_results_seen = True
                            max_results = _parse_bounded_positive_decimal(
                                decoded_value,
                                max_results_min,
                                max_results_max,
                            )

        if end == len(query):
            break
        start = end + 1

    return {"request_ids_count": ids_count or None, "max_results": max_results}


def _parse_response_metadata(flow: http.HTTPFlow) -> dict:
    """Extract billing-relevant fields from an X API response body.

    Returns a dict with at least ``body_parsed`` and ``body_truncated``
    markers, plus optional fields when the JSON is parseable:

      - ``response_data_count``: int — ``len(data)`` for a list payload,
        ``1`` for a single object payload.
      - ``response_includes``: dict[str, int] — counts per ``includes.<key>``.
      - ``response_result_count``: int — ``meta.result_count`` from search
        / paginated endpoints.
      - ``response_total_tweet_count``: int — ``meta.total_tweet_count``
        from ``/2/tweets/counts/*`` endpoints, where ``data`` carries time
        buckets, not tweets.

    For X NDJSON streaming endpoints with a configured parser, the shared
    response streaming wrapper feeds an incremental parser that populates
    ``flow.metadata[metadata_keys.X_NDJSON_STATE]`` as response bytes arrive.
    When that state is present we return its accumulated counters directly
    (``body_format: "ndjson"``) and skip the legacy buffered fallback, since
    forensic stream buffers are capped at ``STREAM_BUFFER_LIMIT`` and don't
    contain the full response. For streams, ``body_truncated`` is always
    ``False`` because NDJSON billing does not parse from that capped capture
    buffer; decoder/parser completeness is reported separately from forensic
    buffer truncation.

    Ordinary X JSON responses handled by the incremental decoder/parser path
    publish ``flow.metadata[metadata_keys.X_JSON_STATE]`` at normal response
    finalization. When present, that state is authoritative over the capped
    forensic buffer and buffered fallback because this path is fed decoded
    response chunks independently of that buffer. Its
    ``body_truncated=False`` therefore means billing inspection was not capped
    by the forensic buffer; it does not mean the optional forensic capture
    retained the full response. Parser and decoder failures are reported
    separately through ``parse_error``.

    Only when neither incremental state is present does the buffered JSON
    fallback parse ``flow.metadata[metadata_keys.STREAM_BUFFER]``. On that path,
    ``body_truncated`` retains ``STREAM_BUFFER_STATE["truncated"]`` because the
    capped buffer is the billing input. Buffered fallback failures (truncated
    buffer, malformed JSON, unexpected shape) leave ``body_parsed=False`` and
    emit no count fields, so analysis can distinguish "field absent in
    response" from "we couldn't parse it". NDJSON stream parser failures are
    reported through ``ndjson_lines_failed``.

    Focused coverage is
    ``test_forensic_buffer_truncation_does_not_stop_x_json_parser`` for complete
    incremental state after capture truncation,
    ``test_response_logs_x_json_parse_error_after_forensic_buffer_truncates``
    for incremental parse-error state after capture truncation, and
    ``test_truncated_buffer_with_no_hints_skips_billing`` for the buffered
    fallback branch.
    """
    result: dict = {"body_parsed": False, "body_truncated": False}

    # Streaming branch: NDJSON parser accumulated counts in flow.metadata
    # during response chunks.  Use those directly — the stream_buffer is
    # intentionally tiny (64 KB) for streams and does NOT hold the body.
    #
    # Keep body_truncated False: the capture truncation flag reflects only
    # the forensic cap, while NDJSON billing uses parser state instead of
    # the retained bytes. Reporting body_truncated=True here
    # would misleadingly tie billing reliability to capture truncation.
    ndjson_state = flow.metadata.get(metadata_keys.X_NDJSON_STATE)
    if ndjson_state is not None:
        result["body_parsed"] = True
        result["body_format"] = "ndjson"
        result["response_data_count"] = ndjson_state["data_count"]
        if ndjson_state["includes"]:
            result["response_includes"] = dict(ndjson_state["includes"])
        unknown_includes_overflow_count = ndjson_state.get("unknown_includes_overflow_count", 0)
        if unknown_includes_overflow_count:
            result["response_unknown_includes_overflow_count"] = unknown_includes_overflow_count
        result["ndjson_lines_parsed"] = ndjson_state["lines_parsed"]
        result["ndjson_lines_failed"] = ndjson_state["lines_failed"]
        return result

    json_state = flow.metadata.get(metadata_keys.X_JSON_STATE)
    if isinstance(json_state, dict):
        return {**result, **json_state}

    captured_body = stream_capture.captured_response_stream_body(flow)
    if captured_body is None:
        return result
    result["body_truncated"] = captured_body.truncated
    if not flow.response:
        return result
    body, decode_error = body_decoding.decode_captured_json_usage_body(
        captured_body, flow.response.headers
    )
    if decode_error is not None:
        result["parse_error"] = decode_error
        return result
    fields = parse_json_response_fields_from_body(body)
    if fields is None:
        return result

    result["body_parsed"] = True
    result.update(fields)
    return result


def _request_body_for_billing_refinement(flow: http.HTTPFlow) -> bytes | None:
    """Select the authoritative request body eligible for billing refinement.

    When present, stream capture is authoritative over ``flow.request.raw_content``:
    only a complete, non-truncated capture is returned. Raw content is used only
    when no stream capture exists.
    """
    captured = request_streaming.captured_request_stream_body(flow)
    if captured is not None:
        if (
            flow.metadata.get(metadata_keys.REQUEST_STREAM_COMPLETE) is True
            and not captured.truncated
        ):
            return bytes(captured.buffer)
        return None
    return flow.request.raw_content


def _compute_billable_counts(
    method: str,
    req_meta: dict,
    resp_meta: dict,
    endpoint_bucket: str,
    log_warn: Callable[[str, dict], None] = lambda *_: None,
) -> dict[str, int]:
    """Derive per-bucket billable resource counts for an X request.

    Returns a dict mapping X billing bucket name → resource count.  The
    caller emits one ``usage_event`` row per key in that dict.  Bucket
    names correspond to X's published pricing buckets (see
    :mod:`.x_billing`).

    Writes (non-GET) always count as ``{endpoint_bucket: 1}`` regardless
    of response shape — X write endpoints don't support expansions.

    Reads (GET):

    X bills per post returned ("only successful responses that return
    data are billed"), so the primary count must reflect what was
    actually in the response, not what was requested.

    - **Body parsed, count endpoint**: use ``meta.total_tweet_count``.
      ``data`` is a time-bucket array for count endpoints, not returned
      posts.
    - **Body parsed, other endpoints**: ``max(data_count, result_count)`` —
      trust the actual response.  Soft errors (HTTP 200 + ``errors`` array,
      no ``data``) and zero-result searches yield primary 0, which is skipped
      from the returned dict so no empty ``usage_event`` row is created.
    - **Body NOT parsed**: fall back to endpoint-scoped request-side hints
      ``max(request_ids_count, max_results, 1)``.  When the URL carries no
      trusted hints we emit no ``usage_event`` row; :func:`report_usage`
      detects that state and writes an error log so ops can audit.
    - **Includes**: each ``includes.<key>`` is normalized to a billing
      bucket through :func:`include_billing_category`, a bounded safe synthetic
      ``includes.<key>`` category, or the fixed overflow category used for
      server-side fallback pricing.  Counts at the same bucket are summed.
    """
    if method != "GET":
        return {endpoint_bucket: 1}

    data = resp_meta.get("response_data_count") or 0
    result = resp_meta.get("response_result_count") or 0

    if resp_meta.get("body_parsed"):
        if req_meta.get("is_count_endpoint"):
            total = as_non_negative_response_count(resp_meta.get("response_total_tweet_count"))
            primary = 0 if total is None else total
        else:
            # Body was parsed — trust actual response counts.
            # Soft errors (no data field) and empty searches correctly yield 0.
            primary = max(data, result)
    else:
        if req_meta.get("is_count_endpoint"):
            primary = 0
        else:
            # Body couldn't be parsed — fall back to request-side hints.
            # With no hints at all we leave primary at 0 and let the caller
            # log this loss of visibility; blind-guessing a quantity risks
            # over-charging by a large factor on small real responses.
            ids = req_meta.get("request_ids_count") or 0
            max_r = req_meta.get("max_results") or 0
            primary = max(ids, max_r, 1) if any((ids, max_r)) else 0

    counts: dict[str, int] = {}
    if primary > 0:
        counts[endpoint_bucket] = primary

    if req_meta.get("is_count_endpoint"):
        return counts

    overflow_includes_count = 0
    synthetic_include_categories: set[str] = set()
    includes = resp_meta.get("response_includes") or {}
    for key, n in includes.items():
        if n <= 0:
            continue
        include_category = include_billing_category(key)
        if include_category.kind == "synthetic":
            if (
                include_category.category in synthetic_include_categories
                or len(synthetic_include_categories) < MAX_UNKNOWN_INCLUDE_CATEGORIES
            ):
                synthetic_include_categories.add(include_category.category)
            else:
                overflow_includes_count += n
                continue
            # Emit a synthetic per-key category so the billing processor
            # can apply its server-side fallback price and ops can track
            # each unknown type independently in ``usage_event``.
            log_warn(
                "X includes key unrecognised — "
                "emitting synthetic category for server-side fallback",
                {
                    "includes_key": key,
                    "includes_count": n,
                    "category": include_category.category,
                },
            )

        if include_category.kind == "overflow":
            overflow_includes_count += n
            continue

        counts[include_category.category] = counts.get(include_category.category, 0) + n

    overflow_includes_count += resp_meta.get("response_unknown_includes_overflow_count") or 0
    if overflow_includes_count > 0:
        counts[INCLUDES_OVERFLOW_CATEGORY] = (
            counts.get(INCLUDES_OVERFLOW_CATEGORY, 0) + overflow_includes_count
        )
        log_warn(
            "X includes overflow — emitting bounded category for server-side fallback",
            {
                "includes_count": overflow_includes_count,
                "category": INCLUDES_OVERFLOW_CATEGORY,
            },
        )

    return counts


def _response_usage_context(flow: http.HTTPFlow) -> _ResponseUsageContext | None:
    if not flow.response or not (
        _HTTP_STATUS_OK_MIN <= flow.response.status_code < _HTTP_STATUS_REDIRECT_MIN
    ):
        return None
    permission = flow_metadata.firewall_permission(flow.metadata)
    if not permission:
        return None
    method = flow.request.method.upper()
    request_path = _strip_request_target_query(flow.request.path)
    endpoint_bucket = classify_bucket(permission, method, request_path)
    if endpoint_bucket is None:
        return None
    return _ResponseUsageContext(permission, request_path, endpoint_bucket)


def needs_response_buffer_fallback(flow: http.HTTPFlow) -> bool:
    """Return whether X billing may consume a buffered response body."""
    context = _response_usage_context(flow)
    return context is not None and not is_stream_path(context.request_path)


def create_response_parser(
    flow: http.HTTPFlow, original_url: str
) -> ConnectorResponseParser | None:
    """Compose validated stream observations with the existing X billing policy."""
    if is_stream_path(urllib.parse.urlparse(original_url).path):
        flow.metadata[metadata_keys.X_RESOURCE_STREAM_REPORTED] = True

    def report_row(response: dict, ordinal: int) -> None:
        run_id = flow_metadata.run_id(flow.metadata)
        if run_id:
            _report_usage(flow, run_id, original_url, response=response, row=ordinal)

    return create_x_response_parser(flow, original_url, on_row=report_row)


def report_usage(flow: http.HTTPFlow, run_id: str, original_url: str) -> None:
    if flow.metadata.get(metadata_keys.X_RESOURCE_STREAM_REPORTED):
        if not flow.metadata.get(metadata_keys.X_RESOURCE_REPORTED):
            flow.metadata[metadata_keys.X_RESOURCE_REPORTED] = True
            _report_usage(flow, run_id, original_url, report_events=False)
        return
    if flow.metadata.get(metadata_keys.X_RESOURCE_REPORTED):
        return
    flow.metadata[metadata_keys.X_RESOURCE_REPORTED] = True
    _report_usage(flow, run_id, original_url)


def _report_usage(
    flow: http.HTTPFlow,
    run_id: str,
    original_url: str,
    *,
    response: dict | None = None,
    row: int | None = None,
    report_events: bool = True,
) -> None:
    """Compute billable resource observations and buffer them for upload.

    Derives per-permission billable resource counts from the request and
    response, then buffers their source events for batched upload via
    ``/api/webhooks/agent/usage-event``.

    **Caller contract**: the dispatcher in
    :mod:`usage.providers.connectors` guarantees ``run_id`` is non-empty,
    ``flow.metadata[metadata_keys.FIREWALL_BILLABLE]`` is True,
    ``flow.metadata[metadata_keys.FIREWALL_NAME] == "x"``, and
    ``original_url`` is a non-empty string before calling this. Those gates are
    not re-checked here.

    Additional X-specific skip conditions:

    - response status is outside 2xx (failures aren't billable)
    - ``firewall_permission`` is empty (unknown-endpoint-allow has no
      stable pricing key)
    - ``firewall_permission`` is not mapped to an X billing bucket
      (e.g. the ``"app-only"`` scope for BearerToken-only endpoints)
    """
    response_context = _response_usage_context(flow)
    if response_context is None:
        return
    firewall_name = flow_metadata.firewall_name(flow.metadata)
    permission = response_context.permission
    method = flow.request.method.upper()
    # mitmproxy's ``flow.request.path`` is the raw request-target — it
    # includes the query string.  Strip it without parsing query params so
    # literal-suffix overrides (e.g. ``/2/tweets/{id}/retweeted_by``) still
    # match requests that carry ``?max_results=10`` or similar.
    request_path = response_context.request_path
    endpoint_bucket = response_context.endpoint_bucket
    if bucket_needs_body_refinement(endpoint_bucket, method, request_path):
        request_body = billing_body.decode_request_body_for_billing(
            _request_body_for_billing_refinement(flow),
            flow.request.headers,
            max_raw=_REQUEST_BODY_REFINEMENT_LIMIT,
            max_decoded=_REQUEST_BODY_REFINEMENT_LIMIT,
        )
        endpoint_bucket = refine_bucket_with_body(
            endpoint_bucket,
            method,
            request_path,
            request_body,
        )

    req_meta = _parse_request_metadata(original_url)
    resp_meta = response if response is not None else _parse_response_metadata(flow)
    # Query-derived request hints are not general request metadata.  They are
    # merged only when billing lost response visibility for a non-count GET.
    req_meta.update(
        _parse_request_query_fallback_hints(original_url)
        if (
            method == "GET"
            and not req_meta["is_count_endpoint"]
            and not resp_meta.get("body_parsed")
        )
        else _empty_request_query_fallback_hints()
    )
    proxy_log_path = flow_metadata.proxy_log_path(flow.metadata)

    # Structured context common to every billing-side proxy log entry
    # for this flow — threaded into the helper so the log firing at the
    # fallback site can still identify the request for ops auditing.
    log_context = {
        "type": "usage_event",
        "run_id": run_id,
        "firewall_name": firewall_name,
        "permission": permission,
        "method": flow.request.method,
        "url": original_url,
    }

    def _log_warn(message: str, extra: dict) -> None:
        # Merge so extra keys win over log_context on collision.  Python
        # would otherwise raise TypeError on duplicate kwargs, turning a
        # logging path into a request-crashing one.
        log_proxy_entry(proxy_log_path, "warn", message, **{**log_context, **extra})

    billable_counts = _compute_billable_counts(
        method, req_meta, resp_meta, endpoint_bucket, log_warn=_log_warn
    )

    ndjson_lines_failed = resp_meta.get("ndjson_lines_failed", 0)
    if ndjson_lines_failed > 0:
        log_usage_underbilling(
            proxy_log_path,
            "X NDJSON response contained unparseable rows — billing visibility is incomplete",
            "unparseable_ndjson_rows",
            "risk",
            **log_context,
            ndjson_lines_failed=ndjson_lines_failed,
            ndjson_lines_parsed=resp_meta["ndjson_lines_parsed"],
            response_data_count=resp_meta["response_data_count"],
        )

    # Loud-but-zero billing path: GET with an unparseable response body and
    # no reliable count source.  We deliberately emit nothing rather than
    # blind-guess a quantity — the error log carries enough context for ops
    # to audit and, if needed, back-charge manually.
    missing_count_visibility = bool(req_meta.get("is_count_endpoint")) or (
        req_meta.get("request_ids_count") is None and req_meta.get("max_results") is None
    )
    if method == "GET" and not resp_meta.get("body_parsed") and missing_count_visibility:
        log_extra: dict[str, object] = {
            "body_truncated": bool(resp_meta.get("body_truncated")),
        }
        parse_error = resp_meta.get("parse_error")
        if isinstance(parse_error, str) and (parse_error := parse_error.strip()):
            log_extra["parse_error"] = parse_error
        log_usage_underbilling(
            proxy_log_path,
            (
                "X count endpoint response unparseable — skipping billing"
                if req_meta.get("is_count_endpoint")
                else "X response unparseable and request carries no count hints — skipping billing"
            ),
            "unparseable_usage_response",
            "confirmed",
            **log_context,
            **log_extra,
        )

    if (
        method == "GET"
        and req_meta.get("is_count_endpoint")
        and resp_meta.get("body_parsed")
        and as_non_negative_response_count(resp_meta.get("response_total_tweet_count")) is None
    ):
        log_usage_underbilling(
            proxy_log_path,
            "X count endpoint response missing total_tweet_count — skipping billing",
            "missing_count_endpoint_total",
            "confirmed",
            **log_context,
            body_truncated=bool(resp_meta.get("body_truncated")),
            response_data_count=resp_meta.get("response_data_count") or 0,
        )

    # Buffer source events for batched platform upload.
    if not billable_counts or not report_events:
        return

    reporting_context = usage_reporting_context(flow)
    if not reporting_context.is_complete:
        log_usage_reporting_context_missing(
            reporting_context,
            run_id,
            firewall_name,
            permission=permission,
        )
        return
    events: list[UsageEvent] = []
    observation_time = resp_meta.get("observed_at") or observed_at()
    for category, qty in billable_counts.items():
        # UUIDv5 from stable source inputs. The usage buffer uses this key to
        # dedupe duplicate response/error observations before delivery.
        idempotency_key = derive_usage_idempotency_key(
            USAGE_EVENT_NAMESPACE_CONNECTOR,
            (run_id, flow.id, category) if row is None else (run_id, flow.id, str(row), category),
        )
        event: UsageEvent = {
            "idempotencyKey": idempotency_key,
            "kind": "connector",
            "provider": firewall_name,
            "category": category,
            "quantity": qty,
        }
        if method == "GET" and category in {"posts.read", "user.read"}:
            event = resource_event(
                event,
                resp_meta,
                endpoint_bucket=endpoint_bucket,
                path=urllib.parse.urlparse(original_url).path,
                observation_time=observation_time,
                count_endpoint=req_meta["is_count_endpoint"],
            )
        events.append(event)
    buffer_source_usage_events(
        reporting_context.usage_event_url(),
        reporting_context.sandbox_token,
        run_id,
        events,
        reporting_context.proxy_log_path,
    )
