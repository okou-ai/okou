"""Network and proxy logging utilities.

Functions for writing JSONL network log entries, per-job proxy diagnostic
log entries, and extracting firewall metadata.
"""

import json
import time
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime

from mitmproxy import http

import addon_process_logging
import flow_metadata
import flow_metadata_keys as metadata_keys
import jsonl_writer
import network_log_sanitization

_PROXY_LOG_RESERVED_FIELDS = {"timestamp", "level", "message"}

# Network log size fields are consumed as JavaScript numbers downstream.
NETWORK_LOG_MAX_SAFE_SIZE = 9_007_199_254_740_991

# Network rows limit the complete request URL; proxy diagnostics apply the same
# number to the query-free value they retain.
URL_LOG_MAX_CHARACTERS = 1_000_000
HTTP_NETWORK_LOG_MAX_JSONL_BYTES = 1_000_000
_TRUNCATED_URL = "[truncated]"


@dataclass(frozen=True)
class _ProxyLogUrlProjection:
    value: str
    original_char_count: int | None = None

    def truncation_fields(self) -> dict[str, object]:
        if self.original_char_count is None:
            return {}
        return {
            "url_truncated": True,
            "url_original_char_count": self.original_char_count,
        }


def elapsed_ms(start_time: float | None) -> int:
    if not start_time:
        return 0
    return max(0, int((time.monotonic() - start_time) * 1000))


def _utc_log_timestamp() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _encode_jsonl_entry(entry: dict, log_name: str) -> bytes | None:
    """Best-effort JSONL encoding for proxy-hook logging paths."""
    try:
        return (json.dumps(entry) + "\n").encode()
    except Exception as e:
        addon_process_logging.emit_addon_process_event(
            "warn",
            f"Failed to encode {log_name} log: {type(e).__name__}: {e}",
        )

    return None


def _write_jsonl_entry(log_path: str, entry: dict, log_name: str) -> None:
    """Best-effort JSONL write for proxy-hook logging paths."""
    if not log_path:
        return
    line = _encode_jsonl_entry(entry, log_name)
    if line is None:
        return

    jsonl_writer.write_jsonl_line(log_path, line, log_name)


def flush_log_path(log_path: str, *, timeout: float | None = None) -> bool:
    """Wait until accepted JSONL writes for a path have been processed.

    Failed append attempts count as processed and are reported through addon
    process events on stderr without affecting the result. ``False`` only means a
    configured timeout expired with accepted writes still pending; ``True`` does
    not confirm that every line was persisted.

    See ``addon_process_logging.emit_addon_process_event`` for the structured
    stderr transport.
    """
    return jsonl_writer.flush_log_path(log_path, timeout=timeout)


def flush_all_logs() -> None:
    """Wait until accepted JSONL writes for all paths have been processed.

    Failed append attempts count as processed and are reported through addon
    process events on stderr; completion of this call does not confirm that every
    line was persisted.

    See ``addon_process_logging.emit_addon_process_event`` for the structured
    stderr transport.
    """
    jsonl_writer.flush_all_logs()


def shutdown_log_writer() -> None:
    """Request the default bounded JSONL writer shutdown.

    If the writer times out, it logs a warning and can leave accepted entries
    pending; this wrapper does not report completion.
    """
    jsonl_writer.shutdown_writer()


def reset_log_writer_for_tests() -> None:
    """Reset JSONL writer state between tests."""
    jsonl_writer.reset_for_tests()


def log_network_entry(log_path: str, entry: dict) -> None:
    """Write a network log entry to the per-run JSONL file."""
    if not log_path:
        return
    log_entry = {**entry, "timestamp": _utc_log_timestamp()}
    _write_jsonl_entry(log_path, log_entry, "network")


def _http_network_log_omission_entry(entry: dict, original_url_char_count: int) -> dict:
    return {
        **entry,
        "url": _TRUNCATED_URL,
        "url_truncated": True,
        "url_original_char_count": original_url_char_count,
    }


def log_http_network_entry(log_path: str, entry: dict, raw_url: str) -> None:
    """Write an HTTP network log without unbounded URL serialization work."""
    if not log_path:
        return

    original_url_char_count = len(raw_url)
    log_entry = {**entry, "timestamp": _utc_log_timestamp()}
    if original_url_char_count > URL_LOG_MAX_CHARACTERS:
        _write_jsonl_entry(
            log_path,
            _http_network_log_omission_entry(log_entry, original_url_char_count),
            "network",
        )
        return

    log_entry["url"] = network_log_sanitization.sanitize_request_url_for_network_log(raw_url)
    line = _encode_jsonl_entry(log_entry, "network")
    if line is None:
        return

    if len(line) > HTTP_NETWORK_LOG_MAX_JSONL_BYTES:
        omission_line = _encode_jsonl_entry(
            _http_network_log_omission_entry(log_entry, original_url_char_count),
            "network",
        )
        if omission_line is not None and len(omission_line) <= HTTP_NETWORK_LOG_MAX_JSONL_BYTES:
            line = omission_line

    jsonl_writer.write_jsonl_line(log_path, line, "network")


def project_url_for_proxy_log(raw_url: str) -> _ProxyLogUrlProjection:
    """Project a request URL without unbounded retained-path processing."""
    value = network_log_sanitization.sanitize_url_for_network_log_with_retained_limit(
        raw_url,
        URL_LOG_MAX_CHARACTERS,
    )
    if value is None:
        return _ProxyLogUrlProjection(_TRUNCATED_URL, len(raw_url))
    return _ProxyLogUrlProjection(value)


def sanitize_proxy_log_extra_value(key: str, value: object) -> object:
    """Sanitize the narrow set of proxy-log extras owned by this module.

    Only the exact ``url`` field is treated specially.  Raw strings are
    sanitized here; a projection produced by this module is
    already safe and is unwrapped without repeated URL processing.  Every
    other field is returned unchanged; this helper is not a general
    secret-redaction boundary for arbitrary proxy-log data.
    """
    if key == "url":
        if isinstance(value, _ProxyLogUrlProjection):
            return value.value
        if isinstance(value, str):
            return network_log_sanitization.sanitize_url_for_network_log(value)
    return value


def log_proxy_entry(
    proxy_log_path: str,
    log_level: str,
    log_message: str,
    /,
    **extra: object,
) -> None:
    """Write a best-effort per-job proxy diagnostic JSONL entry.

    The logger owns the canonical ``timestamp``, ``level``, and ``message``
    fields; extras with those exact names are ignored and cannot override
    them.  Among remaining extras, an exact raw string ``url`` is sanitized by
    ``sanitize_proxy_log_extra_value``; a projection from this module is
    unwrapped without repeated processing.  All other extras are written as
    provided, so callers must pass only values that are safe to persist and
    JSON-serializable.

    Do not assume broad redaction for raw headers, bodies, cookies, tokens,
    or arbitrary nested values.  Usage underbilling signals should use the
    dedicated usage-underbilling helper for that logging contract.
    """
    entry: dict = {
        "timestamp": _utc_log_timestamp(),
        "level": log_level,
        "message": log_message,
    }
    for key, value in extra.items():
        if key not in _PROXY_LOG_RESERVED_FIELDS:
            entry[key] = sanitize_proxy_log_extra_value(key, value)
    _write_jsonl_entry(proxy_log_path, entry, "proxy")


def _metadata_str(meta: Mapping[str, object], key: str, default: str = "") -> str:
    value = meta.get(key)
    return value if isinstance(value, str) else default


def _metadata_optional_str(meta: Mapping[str, object], key: str) -> str | None:
    value = meta.get(key)
    return value if isinstance(value, str) else None


def _metadata_optional_bool(meta: Mapping[str, object], key: str) -> bool | None:
    value = meta.get(key)
    return value if isinstance(value, bool) else None


def _metadata_str_list(meta: Mapping[str, object], key: str) -> list[str] | None:
    value = meta.get(key)
    if not isinstance(value, list):
        return None
    result: list[str] = []
    for item in value:
        if not isinstance(item, str):
            return None
        result.append(item)
    return result


def _metadata_str_record(meta: Mapping[str, object], key: str) -> dict[str, str] | None:
    value = meta.get(key)
    if not isinstance(value, dict):
        return None
    result: dict[str, str] = {}
    for item_key, item_value in value.items():
        if not isinstance(item_key, str) or not isinstance(item_value, str):
            return None
        result[item_key] = item_value
    return result


def add_firewall_metadata(flow: http.HTTPFlow, log_entry: dict) -> None:
    """Copy firewall and auth metadata from flow into a log entry."""
    # [NETWORK_LOG_FIELDS] — keep in sync with all network log schemas
    meta = flow.metadata
    connector_diagnostic_slug = _metadata_optional_str(
        meta,
        metadata_keys.CONNECTOR_DIAGNOSTIC_SLUG,
    )
    log_entry["firewall_base"] = flow_metadata.firewall_base(meta)
    log_entry["firewall_name"] = flow_metadata.firewall_name(meta)
    log_entry["firewall_permission"] = flow_metadata.firewall_permission(meta)
    log_entry["firewall_rule_match"] = _metadata_str(meta, metadata_keys.FIREWALL_RULE_MATCH)
    log_entry["firewall_billable"] = flow_metadata.is_firewall_billable(meta)

    # Optional fields — only include when present with the network-log schema type.
    for log_key, value in (
        ("firewall_params", _metadata_str_record(meta, metadata_keys.FIREWALL_PARAMS)),
        (
            "connector_diagnostic_slug",
            connector_diagnostic_slug,
        ),
        (
            "connector_diagnostic_reason",
            _metadata_optional_str(meta, metadata_keys.CONNECTOR_DIAGNOSTIC_REASON),
        ),
        (
            "connector_diagnostic_env_names",
            _metadata_str_list(meta, metadata_keys.CONNECTOR_DIAGNOSTIC_ENV_NAMES),
        ),
        (
            "connector_diagnostic_base",
            _metadata_optional_str(meta, metadata_keys.CONNECTOR_DIAGNOSTIC_BASE),
        ),
        (
            "auth_resolved_secrets",
            _metadata_str_list(meta, metadata_keys.AUTH_RESOLVED_SECRETS),
        ),
        (
            "auth_refreshed_connectors",
            _metadata_str_list(meta, metadata_keys.AUTH_REFRESHED_CONNECTORS),
        ),
        (
            "auth_refreshed_secrets",
            _metadata_str_list(meta, metadata_keys.AUTH_REFRESHED_SECRETS),
        ),
        ("auth_cache_hit", _metadata_optional_bool(meta, metadata_keys.AUTH_CACHE_HIT)),
        ("auth_url_rewrite", _metadata_optional_bool(meta, metadata_keys.AUTH_URL_REWRITE)),
    ):
        if value is not None:
            log_entry[log_key] = value
