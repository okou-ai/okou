"""Response hook integration tests for firewall auth recovery."""

import time
from pathlib import Path
from unittest.mock import patch

from mitmproxy import http
from mitmproxy.test import tutils

import firewall_auth_cache as auth_cache
import flow_metadata_keys as metadata_keys
import http_network_log
import mitm_addon
import registry
from tests.auth_state_helpers import (
    auth_cache_key,
    auth_state_is_empty,
    cached_headers,
    force_refresh_pending,
    has_auth_state,
    set_cached_headers,
    set_last_force_refresh_monotonic_at,
)
from tests.flow_helpers import header_map
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.registry_helpers import write_simple_registry


def test_401_firewall_cache_invalidation(real_flow, mitm_ctx):
    """401 response with firewall_base pops the cache entry and marks force-refresh (#9860)."""
    flow = real_flow(with_response=False, host="api.github.com")
    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-conn-1"

    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = ""
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.FIREWALL_BASE] = "https://api.github.com"
    flow.metadata[metadata_keys.FIREWALL_API_ID] = "run-conn-1:0"
    flow.metadata[metadata_keys.ORIGINAL_URL] = "https://api.github.com/repos"

    flow.response = tutils.tresp(status_code=401, headers=http.Headers())

    # Pre-populate firewall header cache with the request auth identity key.
    cache_key = auth_cache_key(run_id="run-conn-1", api_id="run-conn-1:0")
    flow.metadata[metadata_keys.FIREWALL_AUTH_CACHE_KEY] = cache_key
    cache_entry_identity = set_cached_headers(
        cache_key, headers={"Authorization": "Bearer old-token"}
    )
    flow.metadata[metadata_keys.FIREWALL_AUTH_CACHE_ENTRY_IDENTITY] = cache_entry_identity

    with mitm_ctx():
        mitm_addon.response(flow)

    # Cache entry should have been removed
    assert cached_headers(cache_key) is None
    # Force-refresh marker must be set so the next /firewall/auth fetch
    # refreshes the token regardless of DB tokenExpiresAt (#9860).
    assert force_refresh_pending(cache_key)


def test_invalid_content_length_without_network_log_does_not_block_401_cache_invalidation(
    real_flow, mitm_ctx
):
    """Malformed log-only response size metadata must not block 401 auth recovery."""
    flow = real_flow(with_response=False, host="api.github.com")
    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-conn-invalid-length"

    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = ""
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.FIREWALL_BASE] = "https://api.github.com"
    flow.metadata[metadata_keys.FIREWALL_API_ID] = "run-conn-invalid-length:0"
    flow.metadata[metadata_keys.ORIGINAL_URL] = "https://api.github.com/repos"

    flow.response = tutils.tresp(
        status_code=401,
        headers=header_map({"content-length": "not-an-int"}),
    )

    cache_key = auth_cache_key(
        run_id="run-conn-invalid-length",
        api_id="run-conn-invalid-length:0",
    )
    flow.metadata[metadata_keys.FIREWALL_AUTH_CACHE_KEY] = cache_key
    cache_entry_identity = set_cached_headers(
        cache_key, headers={"Authorization": "Bearer old-token"}
    )
    flow.metadata[metadata_keys.FIREWALL_AUTH_CACHE_ENTRY_IDENTITY] = cache_entry_identity

    with mitm_ctx():
        mitm_addon.response(flow)

    assert cached_headers(cache_key) is None
    assert force_refresh_pending(cache_key)


def test_invalid_content_length_with_network_log_does_not_block_401_cache_invalidation(
    tmp_path, real_flow, mitm_ctx
):
    """Malformed network-log response size metadata must not block 401 auth recovery."""
    flow = real_flow(with_response=False, host="api.github.com")
    log_path = str(tmp_path / "network.jsonl")
    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-conn-invalid-length-log"

    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = log_path
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.FIREWALL_BASE] = "https://api.github.com"
    flow.metadata[metadata_keys.FIREWALL_API_ID] = "run-conn-invalid-length-log:0"
    flow.metadata[metadata_keys.ORIGINAL_URL] = "https://api.github.com/repos"
    http_network_log.set_target(
        flow,
        url="https://api.github.com/repos",
        host="api.github.com",
        port=443,
    )

    flow.response = tutils.tresp(
        status_code=401,
        headers=header_map({"content-length": "not-an-int"}),
    )

    cache_key = auth_cache_key(
        run_id="run-conn-invalid-length-log",
        api_id="run-conn-invalid-length-log:0",
    )
    flow.metadata[metadata_keys.FIREWALL_AUTH_CACHE_KEY] = cache_key
    cache_entry_identity = set_cached_headers(
        cache_key, headers={"Authorization": "Bearer old-token"}
    )
    flow.metadata[metadata_keys.FIREWALL_AUTH_CACHE_ENTRY_IDENTITY] = cache_entry_identity

    with mitm_ctx():
        mitm_addon.response(flow)

    entry = read_jsonl_entries_after_flush(Path(log_path))[0]
    assert entry["response_size"] == 0
    assert cached_headers(cache_key) is None
    assert force_refresh_pending(cache_key)


def test_late_401_does_not_recreate_registry_evicted_auth_state(tmp_path, real_flow, mitm_ctx):
    """A response from an evicted run must not reacquire auth-state ownership."""
    registry_file = tmp_path / "registry.json"
    write_simple_registry(registry_file, run_id="run-conn-old")
    registry.load_registry_state(str(registry_file))

    flow = real_flow(with_response=False, host="api.github.com")
    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-conn-old"
    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = ""
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.FIREWALL_BASE] = "https://api.github.com"
    flow.metadata[metadata_keys.FIREWALL_API_ID] = "run-conn-old:0"
    flow.metadata[metadata_keys.ORIGINAL_URL] = "https://api.github.com/repos"
    flow.response = tutils.tresp(status_code=401, headers=http.Headers())

    cache_key = auth_cache_key(run_id="run-conn-old", api_id="run-conn-old:0")
    flow.metadata[metadata_keys.FIREWALL_AUTH_CACHE_KEY] = cache_key
    cache_entry_identity = set_cached_headers(
        cache_key, headers={"Authorization": "Bearer old-token"}
    )
    flow.metadata[metadata_keys.FIREWALL_AUTH_CACHE_ENTRY_IDENTITY] = cache_entry_identity

    registry_file.write_text('{"updatedAt": 1, "sandboxes": {}}')
    removed_run_state = registry.load_registry_state(str(registry_file))
    assert not has_auth_state(cache_key)

    with mitm_ctx():
        mitm_addon.response(flow)

    assert not has_auth_state(cache_key)
    assert registry.load_registry_state(str(registry_file)) is removed_run_state
    assert not has_auth_state(cache_key)


def test_401_within_cooldown_does_not_re_mark(real_flow, mitm_ctx):
    """A second 401 within the force-refresh cooldown window must NOT
    re-mark — otherwise a persistent non-token 401 (scope, resource-
    level reject) would amplify into a loop of OAuth refresh calls and
    hit the provider's rate limits (#9860)."""
    flow = real_flow(with_response=False, host="api.github.com")
    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-conn-cd"
    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = ""
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.FIREWALL_BASE] = "https://api.github.com"
    flow.metadata[metadata_keys.FIREWALL_API_ID] = "run-conn-cd:0"
    flow.metadata[metadata_keys.ORIGINAL_URL] = "https://api.github.com/repos"
    flow.response = tutils.tresp(status_code=401, headers=http.Headers())

    cache_key = auth_cache_key(run_id="run-conn-cd", api_id="run-conn-cd:0")
    flow.metadata[metadata_keys.FIREWALL_AUTH_CACHE_KEY] = cache_key
    cache_entry_identity = set_cached_headers(
        cache_key, headers={"Authorization": "Bearer cached-token"}
    )
    flow.metadata[metadata_keys.FIREWALL_AUTH_CACHE_ENTRY_IDENTITY] = cache_entry_identity
    # Simulate: a forced refresh JUST completed a moment ago
    set_last_force_refresh_monotonic_at(cache_key, time.monotonic())

    with mitm_ctx():
        mitm_addon.response(flow)

    # The stale cached headers must still be cleared even when the
    # cooldown suppresses another forced refresh marker.
    assert cached_headers(cache_key) is None
    # Marker was suppressed by the cooldown
    assert not force_refresh_pending(cache_key)


def test_401_after_cooldown_re_marks(real_flow, mitm_ctx):
    """Once the cooldown has elapsed, a subsequent 401 re-marks — the
    rate limit only throttles, it doesn't permanently lock out real
    token-invalidation recovery (#9860)."""
    flow = real_flow(with_response=False, host="api.github.com")
    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-conn-re"
    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = ""
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.FIREWALL_BASE] = "https://api.github.com"
    flow.metadata[metadata_keys.FIREWALL_API_ID] = "run-conn-re:0"
    flow.metadata[metadata_keys.ORIGINAL_URL] = "https://api.github.com/repos"
    flow.response = tutils.tresp(status_code=401, headers=http.Headers())

    cache_key = auth_cache_key(run_id="run-conn-re", api_id="run-conn-re:0")
    flow.metadata[metadata_keys.FIREWALL_AUTH_CACHE_KEY] = cache_key
    cache_entry_identity = set_cached_headers(
        cache_key, headers={"Authorization": "Bearer cached-token"}
    )
    flow.metadata[metadata_keys.FIREWALL_AUTH_CACHE_ENTRY_IDENTITY] = cache_entry_identity
    # Simulate: last forced refresh happened well before the cooldown window
    set_last_force_refresh_monotonic_at(cache_key, 0.0)

    with patch.object(auth_cache.time, "monotonic", return_value=10_000.0), mitm_ctx():
        mitm_addon.response(flow)

    # Cooldown elapsed → marker re-added
    assert force_refresh_pending(cache_key)


def test_401_after_cooldown_re_marks_when_wall_clock_steps_back(real_flow, mitm_ctx):
    """Cooldown uses monotonic elapsed time, not wall-clock time."""
    flow = real_flow(with_response=False, host="api.github.com")
    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-conn-skew"
    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = ""
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.FIREWALL_BASE] = "https://api.github.com"
    flow.metadata[metadata_keys.FIREWALL_API_ID] = "run-conn-skew:0"
    flow.metadata[metadata_keys.ORIGINAL_URL] = "https://api.github.com/repos"
    flow.response = tutils.tresp(status_code=401, headers=http.Headers())

    cache_key = auth_cache_key(run_id="run-conn-skew", api_id="run-conn-skew:0")
    flow.metadata[metadata_keys.FIREWALL_AUTH_CACHE_KEY] = cache_key
    cache_entry_identity = set_cached_headers(
        cache_key, headers={"Authorization": "Bearer cached-token"}
    )
    flow.metadata[metadata_keys.FIREWALL_AUTH_CACHE_ENTRY_IDENTITY] = cache_entry_identity
    set_last_force_refresh_monotonic_at(cache_key, 1000.0)

    with (
        patch.object(auth_cache.time, "monotonic", return_value=1121.0),
        patch.object(auth_cache.time, "time", return_value=10.0),
        mitm_ctx(),
    ):
        mitm_addon.response(flow)

    assert cached_headers(cache_key) is None
    assert force_refresh_pending(cache_key)


def test_401_without_auth_cache_key_does_not_synthesize_state(real_flow, mitm_ctx):
    """401 invalidation requires the full request auth identity cache key."""
    flow = real_flow(with_response=False, host="api.github.com")
    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-conn-no-key"
    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = ""
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.FIREWALL_BASE] = "https://api.github.com"
    flow.metadata[metadata_keys.FIREWALL_API_ID] = "run-conn-no-key:0"
    flow.metadata[metadata_keys.ORIGINAL_URL] = "https://api.github.com/repos"
    flow.response = tutils.tresp(status_code=401, headers=http.Headers())

    assert auth_state_is_empty()

    with mitm_ctx():
        mitm_addon.response(flow)

    assert auth_state_is_empty()
