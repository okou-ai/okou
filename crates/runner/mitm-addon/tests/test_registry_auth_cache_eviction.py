"""Tests for registry-driven auth-cache eviction."""

import json

import registry
from firewall_auth_cache import FIREWALL_AUTH_REGISTRY_GENERATION_ATTRIBUTE
from tests.auth_state_helpers import (
    auth_cache_key,
    cached_headers,
    force_refresh_pending,
    has_auth_state,
    last_force_refresh_monotonic_at,
    mark_force_refresh,
    set_cached_headers,
    set_last_force_refresh_monotonic_at,
)
from tests.process_log_helpers import capture_addon_process_events
from tests.registry_helpers import write_firewall_registry, write_simple_registry


class TestRegistryAuthCacheEviction:
    def test_registry_path_switch_evicts_header_cache(self, tmp_path):
        path_a = tmp_path / "registry-a.json"
        path_b = tmp_path / "registry-b.json"
        write_simple_registry(path_a, run_id="run-one")
        # Retain the run so run-removal cleanup cannot mask path-switch eviction.
        write_simple_registry(path_b, run_id="run-one")
        first_registry = registry.load_registry(str(path_a))
        first_generation = getattr(
            first_registry["10.200.0.1"],
            FIREWALL_AUTH_REGISTRY_GENERATION_ATTRIBUTE,
        )
        cache_key = auth_cache_key(run_id="run-one", api_id="api-0")
        set_cached_headers(
            cache_key,
            headers={"Authorization": "Bearer old"},
        )
        assert has_auth_state(cache_key)

        second_registry = registry.load_registry(str(path_b))
        second_generation = getattr(
            second_registry["10.200.0.1"],
            FIREWALL_AUTH_REGISTRY_GENERATION_ATTRIBUTE,
        )

        assert not has_auth_state(cache_key)
        assert type(first_generation) is int
        assert type(second_generation) is int
        assert second_generation > first_generation

    def test_evicts_header_cache_on_run_removal(self, registry_file):
        """When a run disappears from registry, its header cache entries are evicted."""
        registry.load_registry(str(registry_file))  # initial load (has run-abc-123)

        # Simulate cached headers, locks, markers, and refresh timestamps
        # for run-abc-123
        removed_key = auth_cache_key(run_id="run-abc-123", api_id="api-0")
        retained_key = auth_cache_key(run_id="run-other", api_id="api-0")
        set_cached_headers(
            removed_key,
            headers={"Authorization": "Bearer tok"},
        )
        mark_force_refresh(removed_key)
        set_last_force_refresh_monotonic_at(removed_key, 100.0)
        # Also cache for run-other (will appear in new registry)
        set_cached_headers(
            retained_key,
            headers={"Authorization": "Bearer other"},
        )
        mark_force_refresh(retained_key)
        set_last_force_refresh_monotonic_at(retained_key, 200.0)

        # Update registry: remove run-abc-123, add run-other
        new_data = {
            "sandboxes": {
                "10.200.0.99": {
                    "runId": "run-other",
                    "billableFirewalls": [],
                    "cliAgentType": "claude-code",
                }
            },
            "updatedAt": 0,
        }
        registry_file.write_text(json.dumps(new_data))

        registry.load_registry(str(registry_file))  # reload triggers eviction

        # run-abc-123 state should be evicted (no longer in registry)
        assert not has_auth_state(removed_key)
        # run-other state should remain (still in registry)
        assert cached_headers(retained_key)
        assert force_refresh_pending(retained_key)
        assert last_force_refresh_monotonic_at(retained_key) == 200.0

    def test_repeated_missing_registry_does_not_re_evict_auth_state(
        self,
        registry_file,
    ):
        registry.load_registry(str(registry_file))

        old_cache_key = auth_cache_key(run_id="run-abc-123", api_id="api-0")
        set_cached_headers(
            old_cache_key,
            headers={"Authorization": "Bearer tok"},
        )
        mark_force_refresh(old_cache_key)
        set_last_force_refresh_monotonic_at(old_cache_key, 100.0)

        registry_file.unlink()

        with capture_addon_process_events():
            first_state = registry.load_registry_state(str(registry_file))

        assert isinstance(first_state, registry.RegistryUnavailable)
        assert first_state.reason == "stat_failed"
        assert not has_auth_state(old_cache_key)

        new_cache_key = auth_cache_key(run_id="run-after-failure", api_id="api-0")
        set_cached_headers(
            new_cache_key,
            headers={"Authorization": "Bearer after-failure"},
        )
        mark_force_refresh(new_cache_key)
        set_last_force_refresh_monotonic_at(new_cache_key, 200.0)

        with capture_addon_process_events():
            second_state = registry.load_registry_state(str(registry_file))

        assert isinstance(second_state, registry.RegistryUnavailable)
        assert second_state.reason == "stat_failed"
        assert cached_headers(new_cache_key)
        assert force_refresh_pending(new_cache_key)
        assert last_force_refresh_monotonic_at(new_cache_key) == 200.0

    def test_repeated_oversized_registry_does_not_re_evict_auth_state(
        self,
        registry_file,
    ):
        registry.load_registry(str(registry_file))

        old_cache_key = auth_cache_key(run_id="run-abc-123", api_id="api-0")
        set_cached_headers(
            old_cache_key,
            headers={"Authorization": "Bearer tok"},
        )
        mark_force_refresh(old_cache_key)
        set_last_force_refresh_monotonic_at(old_cache_key, 100.0)

        with registry_file.open("wb") as oversized_registry:
            oversized_registry.truncate(registry.MAX_REGISTRY_BYTES + 1)

        with capture_addon_process_events():
            first_state = registry.load_registry_state(str(registry_file))

        assert isinstance(first_state, registry.RegistryUnavailable)
        assert first_state.reason == "read_failed"
        assert not has_auth_state(old_cache_key)

        new_cache_key = auth_cache_key(run_id="run-after-failure", api_id="api-0")
        set_cached_headers(
            new_cache_key,
            headers={"Authorization": "Bearer after-failure"},
        )
        mark_force_refresh(new_cache_key)
        set_last_force_refresh_monotonic_at(new_cache_key, 200.0)

        with capture_addon_process_events():
            second_state = registry.load_registry_state(str(registry_file))

        assert isinstance(second_state, registry.RegistryUnavailable)
        assert second_state.reason == "read_failed"
        assert cached_headers(new_cache_key)
        assert force_refresh_pending(new_cache_key)
        assert last_force_refresh_monotonic_at(new_cache_key) == 200.0

    def test_repeated_parse_failure_does_not_re_evict_auth_state(
        self,
        registry_file,
    ):
        """Unavailable registry clears auth state once when ownership is unknown."""
        registry.load_registry(str(registry_file))

        old_cache_key = auth_cache_key(run_id="run-abc-123", api_id="api-0")
        set_cached_headers(
            old_cache_key,
            headers={"Authorization": "Bearer tok"},
        )
        mark_force_refresh(old_cache_key)
        set_last_force_refresh_monotonic_at(old_cache_key, 100.0)

        registry_file.write_text("{ broken while evicting cache")

        with capture_addon_process_events():
            assert registry.load_registry(str(registry_file)) == {}

        assert not has_auth_state(old_cache_key)

        new_cache_key = auth_cache_key(run_id="run-after-failure", api_id="api-0")
        set_cached_headers(
            new_cache_key,
            headers={"Authorization": "Bearer after-failure"},
        )
        mark_force_refresh(new_cache_key)
        set_last_force_refresh_monotonic_at(new_cache_key, 200.0)

        with capture_addon_process_events():
            assert registry.load_registry(str(registry_file)) == {}

        assert cached_headers(new_cache_key)
        assert force_refresh_pending(new_cache_key)
        assert last_force_refresh_monotonic_at(new_cache_key) == 200.0

    def test_evicts_marker_only_auth_state_on_run_removal(self, registry_file):
        """Registry eviction removes auth state even when it has no cached headers."""
        registry.load_registry(str(registry_file))

        cache_key = auth_cache_key(run_id="run-abc-123", api_id="api-0")
        mark_force_refresh(cache_key)
        set_last_force_refresh_monotonic_at(cache_key, 100.0)

        registry_file.write_text(json.dumps({"sandboxes": {}, "updatedAt": 0}))

        registry.load_registry(str(registry_file))

        assert not has_auth_state(cache_key)

    def test_registry_entries_without_run_id_do_not_keep_header_cache(self, registry_file):
        """Registry entries with missing or blank runId are not active cache owners."""
        registry.load_registry(str(registry_file))

        blank_run_key = auth_cache_key(run_id="", api_id="api-0")
        active_run_key = auth_cache_key(run_id="run-active", api_id="api-0")
        set_cached_headers(blank_run_key, headers={})
        mark_force_refresh(blank_run_key)
        set_last_force_refresh_monotonic_at(blank_run_key, 100.0)
        set_cached_headers(active_run_key, headers={})
        mark_force_refresh(active_run_key)
        set_last_force_refresh_monotonic_at(active_run_key, 200.0)

        registry_file.write_text(
            json.dumps(
                {
                    "sandboxes": {
                        "10.200.0.1": {"runId": "", "billableFirewalls": []},
                        "10.200.0.2": {"billableFirewalls": []},
                        "10.200.0.3": {
                            "runId": "run-active",
                            "billableFirewalls": [],
                            "cliAgentType": "claude-code",
                        },
                        "10.200.0.4": {"runId": "  \t", "billableFirewalls": []},
                        "10.200.0.5": {
                            "runId": " run-active ",
                            "billableFirewalls": [],
                        },
                    },
                    "updatedAt": 0,
                }
            )
        )

        with capture_addon_process_events():
            registry.load_registry(str(registry_file))

        assert not has_auth_state(blank_run_key)
        assert cached_headers(active_run_key)
        assert force_refresh_pending(active_run_key)
        assert last_force_refresh_monotonic_at(active_run_key) == 200.0

    def test_valid_entry_becoming_invalid_evicts_context_and_cache(self, tmp_path):
        registry_file = tmp_path / "registry.json"
        write_firewall_registry(registry_file)

        context = registry.get_sandbox_context("10.200.0.1", str(registry_file))
        assert context is not None
        _, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        cache_key = auth_cache_key(run_id="run-abc-123", api_id="api-0")
        set_cached_headers(
            cache_key,
            headers={"Authorization": "Bearer tok"},
        )

        registry_file.write_text(
            json.dumps(
                {
                    "sandboxes": {
                        "10.200.0.1": {"runId": ""},
                    },
                    "updatedAt": 0,
                }
            )
        )

        with capture_addon_process_events():
            state = registry.load_registry_state(str(registry_file))

        assert not isinstance(state, registry.RegistryUnavailable)
        assert state.sandboxes == {}
        assert set(state.invalid_sandboxes) == {"10.200.0.1"}
        assert state.compiled_firewalls == {}
        assert state.compiled_network_policies == {}
        assert registry.get_sandbox_context("10.200.0.1", str(registry_file)) is None
        assert not has_auth_state(cache_key)

    def test_invalid_sandbox_entries_do_not_block_header_cache_eviction(self, registry_file):
        """Invalid sandbox entries are not active cache owners."""
        registry.load_registry(str(registry_file))

        old_run_key = auth_cache_key(run_id="run-old", api_id="api-0")
        active_run_key = auth_cache_key(run_id="run-active", api_id="api-0")
        set_cached_headers(old_run_key, headers={})
        mark_force_refresh(old_run_key)
        set_last_force_refresh_monotonic_at(old_run_key, 100.0)
        set_cached_headers(active_run_key, headers={})
        mark_force_refresh(active_run_key)
        set_last_force_refresh_monotonic_at(active_run_key, 200.0)

        registry_file.write_text(
            json.dumps(
                {
                    "sandboxes": {
                        "10.200.0.1": {
                            "runId": "run-active",
                            "billableFirewalls": [],
                            "cliAgentType": "claude-code",
                        },
                        "10.200.0.2": None,
                        "10.200.0.3": "broken",
                    },
                    "updatedAt": 0,
                }
            )
        )

        with capture_addon_process_events():
            registry.load_registry(str(registry_file))

        assert not has_auth_state(old_run_key)
        assert cached_headers(active_run_key)
        assert force_refresh_pending(active_run_key)
        assert last_force_refresh_monotonic_at(active_run_key) == 200.0
