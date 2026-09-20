"""Shared flow metadata access helpers.

This module owns only stable shape/default helpers for cross-module metadata
reads plus narrow shared state transitions. Domain-specific lifecycle state
stays with the module that creates and releases it.
"""

import time
from collections.abc import Mapping, MutableMapping

import flow_metadata_keys as metadata_keys


def _metadata_str(meta: Mapping[str, object], key: str, default: str = "") -> str:
    value = meta.get(key)
    return value if isinstance(value, str) else default


def _metadata_optional_str(meta: Mapping[str, object], key: str) -> str | None:
    value = meta.get(key)
    return value if isinstance(value, str) else None


def _metadata_bool(meta: Mapping[str, object], key: str, default: bool = False) -> bool:
    value = meta.get(key)
    return value if isinstance(value, bool) else default


def run_id(meta: Mapping[str, object]) -> str:
    return _metadata_str(meta, metadata_keys.SANDBOX_RUN_ID)


def network_log_path(meta: Mapping[str, object]) -> str:
    return _metadata_str(meta, metadata_keys.SANDBOX_NETWORK_LOG_PATH)


def proxy_log_path(meta: Mapping[str, object]) -> str:
    return _metadata_str(meta, metadata_keys.SANDBOX_PROXY_LOG_PATH)


def sandbox_auth_key(meta: Mapping[str, object]) -> str:
    return _metadata_str(meta, metadata_keys.SANDBOX_AUTH_KEY)


def cli_agent_type(meta: Mapping[str, object]) -> str:
    return _metadata_str(meta, metadata_keys.CLI_AGENT_TYPE)


def original_url(meta: Mapping[str, object]) -> str:
    return _metadata_str(meta, metadata_keys.ORIGINAL_URL)


def trusted_authority_host(meta: Mapping[str, object]) -> str:
    return _metadata_str(meta, metadata_keys.TRUSTED_AUTHORITY_HOST)


def firewall_base(meta: Mapping[str, object]) -> str:
    return _metadata_str(meta, metadata_keys.FIREWALL_BASE)


def firewall_name(meta: Mapping[str, object]) -> str:
    return _metadata_str(meta, metadata_keys.FIREWALL_NAME)


def firewall_permission(meta: Mapping[str, object]) -> str:
    return _metadata_str(meta, metadata_keys.FIREWALL_PERMISSION)


def firewall_action(meta: Mapping[str, object], default: str = "ALLOW") -> str:
    return _metadata_str(meta, metadata_keys.FIREWALL_ACTION, default)


def firewall_error(meta: Mapping[str, object]) -> str | None:
    return _metadata_optional_str(meta, metadata_keys.FIREWALL_ERROR)


def connector_route_reason(meta: Mapping[str, object]) -> str | None:
    return _metadata_optional_str(meta, metadata_keys.CONNECTOR_ROUTE_REASON)


def connector_route_candidates(meta: Mapping[str, object]) -> list[str]:
    value = meta.get(metadata_keys.CONNECTOR_ROUTE_CANDIDATES)
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        return []
    return list(value)


def is_firewall_billable(meta: Mapping[str, object]) -> bool:
    return _metadata_bool(meta, metadata_keys.FIREWALL_BILLABLE)


def should_capture_body(meta: Mapping[str, object]) -> bool:
    return _metadata_bool(meta, metadata_keys.CAPTURE_BODY)


def model_usage_provider(meta: Mapping[str, object]) -> str:
    return _metadata_str(meta, metadata_keys.MODEL_USAGE_PROVIDER)


def start_request_timing(meta: MutableMapping[str, object]) -> None:
    if metadata_keys.HTTP_REQUEST_START_MONOTONIC not in meta:
        meta[metadata_keys.HTTP_REQUEST_START_MONOTONIC] = time.monotonic()


def set_firewall_decision(
    meta: MutableMapping[str, object],
    action: str,
    *,
    error: str | None = None,
) -> None:
    meta[metadata_keys.FIREWALL_ACTION] = action
    if error is not None:
        meta[metadata_keys.FIREWALL_ERROR] = error
