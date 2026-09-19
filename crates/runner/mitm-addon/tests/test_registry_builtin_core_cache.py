"""Tests for compiled built-in registry core-cache behavior and lifecycle."""

import os
from unittest.mock import patch

import pytest

import builtin_firewall_cache
import matching
import registry
import registry_firewalls
from tests.registry_builtin_helpers import (
    cache_firewall,
    first_firewall_core,
    github_cache_firewall,
    write_catalog_cache,
    write_registry_with_cache,
)
from tests.registry_helpers import builtin_sandbox, inline_sandbox, write_multi_sandbox_registry


def _zendesk_cache_firewall() -> dict:
    return {
        "name": "zendesk",
        "apis": [
            {
                "base": "https://${{ vars.ZENDESK_SUBDOMAIN }}.zendesk.com",
                "auth": {"headers": {}},
                "permissions": [{"name": "read", "rules": ["GET /api/v2/tickets"]}],
            }
        ],
    }


class TestRegistryBuiltinCoreCache:
    def test_repeated_builtin_firewall_refs_share_core_but_keep_sandbox_api_ids(
        self, tmp_path, mitm_ctx
    ):
        first_source_id = "550e8400-e29b-41d4-a716-446655440001"
        second_source_id = "550e8400-e29b-41d4-a716-446655440002"
        first_sandbox = builtin_sandbox("run-github-a", "github")
        second_sandbox = builtin_sandbox("run-github-b", "github")
        first_sandbox["firewalls"][0]["sourceId"] = first_source_id
        second_sandbox["firewalls"][0]["sourceId"] = second_source_id
        path, cache_path = write_registry_with_cache(
            tmp_path,
            {
                "10.200.0.1": first_sandbox,
                "10.200.0.2": second_sandbox,
            },
            {"github": github_cache_firewall()},
        )

        with mitm_ctx(
            registry_path=str(path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            first_context = registry.get_sandbox_context("10.200.0.1", str(path))
            second_context = registry.get_sandbox_context("10.200.0.2", str(path))

        assert first_context is not None
        assert second_context is not None
        first_sandbox_info, first_compiled, first_policies = first_context
        second_sandbox_info, second_compiled, second_policies = second_context
        assert first_compiled is not None
        assert second_compiled is not None
        assert first_firewall_core(first_compiled) is first_firewall_core(second_compiled)

        first_result = matching.match_compiled_firewall_request(
            "https://api.github.com/repos/vm0-ai/vm0",
            "GET",
            first_compiled,
            first_policies,
        )
        second_result = matching.match_compiled_firewall_request(
            "https://api.github.com/repos/vm0-ai/vm0",
            "GET",
            second_compiled,
            second_policies,
        )

        assert isinstance(first_result, matching.FirewallAllow)
        assert isinstance(second_result, matching.FirewallAllow)
        assert first_result.api_entry is first_sandbox_info["firewalls"][0]["apis"][0]
        assert second_result.api_entry is second_sandbox_info["firewalls"][0]["apis"][0]
        assert first_result.api_entry["id"] == "run-github-a:0"
        assert second_result.api_entry["id"] == "run-github-b:0"
        assert first_result.api_entry["sourceId"] == first_source_id
        assert second_result.api_entry["sourceId"] == second_source_id

    @pytest.mark.parametrize("builtin_index", [0, 1], ids=["builtin-first", "inline-first"])
    def test_mixed_builtin_and_inline_firewalls_preserve_order_and_cache_semantics(
        self, tmp_path, mitm_ctx, builtin_index: int
    ):
        inline_index = 1 - builtin_index
        expected_names = ["github", "example"]
        if builtin_index == 1:
            expected_names.reverse()

        def mixed_sandbox(run_id: str) -> dict:
            builtin_entry = builtin_sandbox(run_id, "github")["firewalls"][0]
            inline_entry = inline_sandbox(run_id)["firewalls"][0]
            firewalls = [builtin_entry, inline_entry]
            if builtin_index == 1:
                firewalls.reverse()
            return {
                "runId": run_id,
                "billableFirewalls": [],
                "cliAgentType": "claude-code",
                "firewalls": firewalls,
            }

        path, cache_path = write_registry_with_cache(
            tmp_path,
            {
                "10.200.0.1": mixed_sandbox("run-mixed-a"),
                "10.200.0.2": mixed_sandbox("run-mixed-b"),
            },
            {"github": github_cache_firewall()},
        )

        with mitm_ctx(
            registry_path=str(path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            first_context = registry.get_sandbox_context("10.200.0.1", str(path))
            second_context = registry.get_sandbox_context("10.200.0.2", str(path))

        assert first_context is not None
        assert second_context is not None
        first_sandbox_info, first_compiled, first_policies = first_context
        second_sandbox_info, second_compiled, _second_policies = second_context
        assert first_compiled is not None
        assert second_compiled is not None

        assert [firewall["name"] for firewall in first_sandbox_info["firewalls"]] == expected_names
        assert [firewall.name for firewall in first_compiled.firewalls] == expected_names
        assert [firewall.name for firewall in second_compiled.firewalls] == expected_names
        assert [firewall["apis"][0]["id"] for firewall in first_sandbox_info["firewalls"]] == [
            "run-mixed-a:0",
            "run-mixed-a:1",
        ]
        assert [firewall["apis"][0]["id"] for firewall in second_sandbox_info["firewalls"]] == [
            "run-mixed-b:0",
            "run-mixed-b:1",
        ]

        builtin_result = matching.match_compiled_firewall_request(
            "https://api.github.com/repos/vm0-ai/vm0",
            "GET",
            first_compiled,
            first_policies,
        )
        inline_result = matching.match_compiled_firewall_request(
            "https://api.example.com/items",
            "GET",
            first_compiled,
            first_policies,
        )

        assert isinstance(builtin_result, matching.FirewallAllow)
        assert isinstance(inline_result, matching.FirewallAllow)
        assert builtin_result.api_entry is first_sandbox_info["firewalls"][builtin_index]["apis"][0]
        assert inline_result.api_entry is first_sandbox_info["firewalls"][inline_index]["apis"][0]
        assert (
            first_compiled.firewalls[builtin_index].core
            is second_compiled.firewalls[builtin_index].core
        )
        assert (
            first_compiled.firewalls[inline_index].core
            is not second_compiled.firewalls[inline_index].core
        )

    def test_builtin_firewall_refs_share_static_payload_but_keep_sandbox_api_shells(
        self, tmp_path, mitm_ctx
    ):
        auth = {"headers": {"Authorization": "Bearer ${{ secrets.API_TOKEN }}"}}
        permissions = [{"name": "read-items", "rules": ["GET /items"]}]
        path, cache_path = write_registry_with_cache(
            tmp_path,
            {
                "10.200.0.1": builtin_sandbox("run-large-a", "large"),
                "10.200.0.2": builtin_sandbox("run-large-b", "large"),
            },
            {
                "large": {
                    "name": "large",
                    "apis": [
                        {
                            "base": "https://api.example.com",
                            "auth": auth,
                            "permissions": permissions,
                        },
                        {
                            "base": "https://upload.example.com",
                            "auth": auth,
                            "permissions": permissions,
                        },
                    ],
                }
            },
        )

        with mitm_ctx(
            registry_path=str(path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            first_context = registry.get_sandbox_context("10.200.0.1", str(path))
            second_context = registry.get_sandbox_context("10.200.0.2", str(path))

        assert first_context is not None
        assert second_context is not None
        first_sandbox_info, first_compiled, first_policies = first_context
        second_sandbox_info, second_compiled, second_policies = second_context
        assert first_compiled is not None
        assert second_compiled is not None
        assert first_firewall_core(first_compiled) is first_firewall_core(second_compiled)

        first_firewall = first_sandbox_info["firewalls"][0]
        second_firewall = second_sandbox_info["firewalls"][0]
        assert first_firewall is not second_firewall
        assert first_firewall["apis"] is not second_firewall["apis"]

        first_api = first_firewall["apis"][0]
        second_api = second_firewall["apis"][0]
        assert first_api is not second_api
        assert first_api["id"] == "run-large-a:0"
        assert second_api["id"] == "run-large-b:0"
        assert first_api["permissions"] is second_api["permissions"]
        assert first_api["auth"] is second_api["auth"]

        first_result = matching.match_compiled_firewall_request(
            "https://api.example.com/items",
            "GET",
            first_compiled,
            first_policies,
        )
        second_result = matching.match_compiled_firewall_request(
            "https://api.example.com/items",
            "GET",
            second_compiled,
            second_policies,
        )

        assert isinstance(first_result, matching.FirewallAllow)
        assert isinstance(second_result, matching.FirewallAllow)
        assert first_result.api_entry is first_api
        assert second_result.api_entry is second_api

    def test_builtin_refs_with_different_base_url_vars_do_not_share_core(self, tmp_path, mitm_ctx):
        path, cache_path = write_registry_with_cache(
            tmp_path,
            {
                "10.200.0.1": builtin_sandbox(
                    "run-zendesk-a",
                    "zendesk",
                    {"ZENDESK_SUBDOMAIN": "acme"},
                ),
                "10.200.0.2": builtin_sandbox(
                    "run-zendesk-b",
                    "zendesk",
                    {"ZENDESK_SUBDOMAIN": "beta"},
                ),
            },
            {"zendesk": _zendesk_cache_firewall()},
        )

        with mitm_ctx(
            registry_path=str(path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            first_context = registry.get_sandbox_context("10.200.0.1", str(path))
            second_context = registry.get_sandbox_context("10.200.0.2", str(path))

        assert first_context is not None
        assert second_context is not None
        first_sandbox_info, first_compiled, first_policies = first_context
        second_sandbox_info, second_compiled, second_policies = second_context
        assert first_compiled is not None
        assert second_compiled is not None
        assert first_firewall_core(first_compiled) is not first_firewall_core(second_compiled)
        assert first_sandbox_info["firewalls"][0]["apis"][0]["base"] == "https://acme.zendesk.com"
        assert second_sandbox_info["firewalls"][0]["apis"][0]["base"] == "https://beta.zendesk.com"

        first_result = matching.match_compiled_firewall_request(
            "https://acme.zendesk.com/api/v2/tickets",
            "GET",
            first_compiled,
            first_policies,
        )
        second_result = matching.match_compiled_firewall_request(
            "https://beta.zendesk.com/api/v2/tickets",
            "GET",
            second_compiled,
            second_policies,
        )

        assert isinstance(first_result, matching.FirewallAllow)
        assert isinstance(second_result, matching.FirewallAllow)
        assert first_result.api_entry is first_sandbox_info["firewalls"][0]["apis"][0]
        assert second_result.api_entry is second_sandbox_info["firewalls"][0]["apis"][0]

    def test_builtin_compile_cache_is_scoped_to_registry_path(self, tmp_path, mitm_ctx):
        path_a = tmp_path / "registry-a.json"
        path_b = tmp_path / "registry-b.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        data = {"10.200.0.1": builtin_sandbox("run-github", "github")}
        write_multi_sandbox_registry(path_a, data)
        write_multi_sandbox_registry(path_b, data)
        write_catalog_cache(
            cache_path,
            digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            version="catalog-a",
            firewalls={"github": github_cache_firewall()},
        )

        with mitm_ctx(
            registry_path=str(path_a),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            first_context = registry.get_sandbox_context("10.200.0.1", str(path_a))
        with mitm_ctx(
            registry_path=str(path_b),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            second_context = registry.get_sandbox_context("10.200.0.1", str(path_b))

        assert first_context is not None
        assert second_context is not None
        _, first_compiled, _ = first_context
        _, second_compiled, _ = second_context
        assert first_compiled is not None
        assert second_compiled is not None
        assert first_firewall_core(first_compiled) is not first_firewall_core(second_compiled)

    def test_omitted_builtin_entry_does_not_poison_valid_sandbox_core_cache(
        self, tmp_path, mitm_ctx
    ):
        path, cache_path = write_registry_with_cache(
            tmp_path,
            {
                "10.200.0.1": builtin_sandbox("run-github", "github"),
                "10.200.0.2": builtin_sandbox("run-missing", "missing-firewall"),
            },
            {"github": github_cache_firewall()},
        )

        with (
            mitm_ctx(
                registry_path=str(path),
                builtin_firewall_catalog_cache_path=str(cache_path),
            ),
        ):
            valid_context = registry.get_sandbox_context("10.200.0.1", str(path))
            omitted_context = registry.get_sandbox_context("10.200.0.2", str(path))
            state = registry.load_registry_state(str(path))

        assert valid_context is not None
        assert omitted_context is not None
        assert not isinstance(state, registry.RegistryUnavailable)
        assert state.invalid_sandboxes == {}
        assert state.omitted_builtin_firewalls == {"10.200.0.2": frozenset({"missing-firewall"})}
        omitted_sandbox, omitted_compiled, _ = omitted_context
        assert omitted_sandbox["firewalls"] == []
        assert omitted_compiled is None
        _, compiled_firewalls, compiled_policies = valid_context
        assert compiled_firewalls is not None
        result = matching.match_compiled_firewall_request(
            "https://api.github.com/repos/vm0-ai/vm0",
            "GET",
            compiled_firewalls,
            compiled_policies,
        )
        assert isinstance(result, matching.FirewallAllow)

    def test_builtin_core_cache_prunes_inactive_keys_on_registry_reload(self, tmp_path, mitm_ctx):
        path = tmp_path / "registry.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        write_catalog_cache(
            cache_path,
            digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            version="catalog-a",
            firewalls={
                "cache-a": {
                    "name": "cache-a",
                    "apis": [
                        {
                            "base": "https://api-a.example.com",
                            "auth": {"headers": {"Authorization": "Bearer token"}},
                            "permissions": [{"name": "read", "rules": ["GET /items"]}],
                        }
                    ],
                },
                "cache-b": {
                    "name": "cache-b",
                    "apis": [
                        {
                            "base": "https://api-b.example.com",
                            "auth": {"headers": {"Authorization": "Bearer token"}},
                            "permissions": [{"name": "read", "rules": ["GET /items"]}],
                        }
                    ],
                },
            },
        )
        write_multi_sandbox_registry(
            path, {"10.200.0.1": builtin_sandbox("run-cache-a", "cache-a")}
        )
        os.utime(path, ns=(1_700_000_000_000_000_000, 1_700_000_000_000_000_000))

        with mitm_ctx(
            registry_path=str(path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            first_context = registry.get_sandbox_context("10.200.0.1", str(path))

        assert first_context is not None
        assert len(registry._registry_state.builtin_firewall_core_cache) == 1
        first_cache_key = next(iter(registry._registry_state.builtin_firewall_core_cache))
        assert first_cache_key[0] == "cache-a"

        write_multi_sandbox_registry(
            path, {"10.200.0.1": builtin_sandbox("run-cache-b", "cache-b")}
        )
        os.utime(path, ns=(1_700_000_000_000_000_001, 1_700_000_000_000_000_001))
        with mitm_ctx(
            registry_path=str(path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            second_context = registry.get_sandbox_context("10.200.0.1", str(path))

        assert second_context is not None
        assert len(registry._registry_state.builtin_firewall_core_cache) == 1
        second_cache_key = next(iter(registry._registry_state.builtin_firewall_core_cache))
        assert second_cache_key[0] == "cache-b"

    def test_registry_unavailable_clears_compiled_core_but_retains_shared_catalog(
        self, tmp_path, mitm_ctx
    ):
        path = tmp_path / "registry.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        write_catalog_cache(
            cache_path,
            digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            version="catalog-a",
            firewalls={"cache-a": cache_firewall("cache-a", "https://api-a.example.com")},
        )
        write_multi_sandbox_registry(
            path, {"10.200.0.1": builtin_sandbox("run-cache-a", "cache-a")}
        )

        with mitm_ctx(
            registry_path=str(path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            context = registry.get_sandbox_context("10.200.0.1", str(path))
            assert context is not None
            assert len(registry._registry_state.builtin_firewall_core_cache) == 1
            retained_catalog = builtin_firewall_cache.load_catalog_snapshot(str(cache_path)).catalog
            assert retained_catalog is not None

            path.write_text("{ broken")
            unavailable = registry.load_registry_state(str(path))

        assert isinstance(unavailable, registry.RegistryUnavailable)
        assert unavailable.reason == "parse_failed"
        assert registry._registry_state.builtin_firewall_core_cache == {}
        with patch.object(os, "read", side_effect=AssertionError("unexpected catalog reread")):
            cached = builtin_firewall_cache.load_catalog_snapshot(str(cache_path))
        assert cached.catalog is retained_catalog

    def test_registry_dropping_builtin_entries_retains_shared_catalog(self, tmp_path, mitm_ctx):
        path = tmp_path / "registry.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        write_catalog_cache(
            cache_path,
            digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            version="catalog-a",
            firewalls={"cache-a": cache_firewall("cache-a", "https://api-a.example.com")},
        )
        write_multi_sandbox_registry(
            path, {"10.200.0.1": builtin_sandbox("run-cache-a", "cache-a")}
        )
        os.utime(path, ns=(1_700_000_000_000_000_000, 1_700_000_000_000_000_000))

        with mitm_ctx(
            registry_path=str(path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            context = registry.get_sandbox_context("10.200.0.1", str(path))
            assert context is not None
            retained_catalog = builtin_firewall_cache.load_catalog_snapshot(str(cache_path)).catalog
            assert retained_catalog is not None

            write_multi_sandbox_registry(path, {"10.200.0.1": inline_sandbox("run-inline")})
            os.utime(path, ns=(1_700_000_000_000_000_001, 1_700_000_000_000_000_001))
            inline_context = registry.get_sandbox_context("10.200.0.1", str(path))

        assert inline_context is not None
        with patch.object(os, "read", side_effect=AssertionError("unexpected catalog reread")):
            cached = builtin_firewall_cache.load_catalog_snapshot(str(cache_path))
        assert cached.catalog is retained_catalog

    def test_no_builtin_registry_fast_path_retains_shared_catalog(self, tmp_path, mitm_ctx):
        path = tmp_path / "registry.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        write_catalog_cache(
            cache_path,
            digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            version="catalog-a",
            firewalls={"cache-a": cache_firewall("cache-a", "https://api-a.example.com")},
        )
        write_multi_sandbox_registry(path, {"10.200.0.1": inline_sandbox("run-inline")})

        with mitm_ctx(
            registry_path=str(path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            first_context = registry.get_sandbox_context("10.200.0.1", str(path))
            assert first_context is not None

            snapshot = registry_firewalls.load_catalog_snapshot(str(cache_path))
            assert snapshot.catalog is not None
            assert snapshot.dependency_file_key is not None
            assert snapshot.dependency_file_key.absolute_path == str(cache_path.absolute())
            assert snapshot.catalog.identity.source == "cache"
            assert snapshot.catalog.identity.catalog_version == "catalog-a"
            assert snapshot.catalog.identity.file_key == snapshot.dependency_file_key

            second_context = registry.get_sandbox_context("10.200.0.1", str(path))

        assert second_context is not None
        with patch.object(os, "read", side_effect=AssertionError("unexpected catalog reread")):
            cached = builtin_firewall_cache.load_catalog_snapshot(str(cache_path))
        assert cached.catalog is snapshot.catalog
