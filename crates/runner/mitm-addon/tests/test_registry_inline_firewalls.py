"""Tests for inline registry firewalls outside the built-in catalog cache."""

import os

import pytest

import matching
import registry
from tests.registry_builtin_helpers import (
    cache_firewall,
    first_firewall_core,
    write_catalog_cache,
)
from tests.registry_helpers import inline_sandbox, write_multi_sandbox_registry

_CUSTOM_CONNECTOR_ID = "550e8400-e29b-41d4-a716-446655440000"
_CLOUDFLARE_INTENT = {
    "kind": "cloudflare_access",
    "configId": "550e8400-e29b-41d4-a716-446655440002",
    "generation": 1,
}


class TestRegistryInlineFirewalls:
    @pytest.mark.parametrize(
        "intent",
        [
            pytest.param({"kind": "direct"}, id="direct"),
            pytest.param(_CLOUDFLARE_INTENT, id="cloudflare-min-generation"),
            pytest.param(
                _CLOUDFLARE_INTENT | {"generation": 2**31 - 1}, id="cloudflare-max-generation"
            ),
        ],
    )
    def test_valid_custom_network_intent_matches(self, tmp_path, mitm_ctx, intent):
        path = tmp_path / "registry.json"
        sandbox = inline_sandbox("run-custom-network")
        entry = sandbox["firewalls"][0]
        entry["customConnectorId"] = _CUSTOM_CONNECTOR_ID
        sandbox["connectorRuntimeTargets"] = [
            {"kind": "custom", "customConnectorId": _CUSTOM_CONNECTOR_ID}
        ]
        entry["firewall"]["apis"][0]["networkIntent"] = intent
        write_multi_sandbox_registry(path, {"10.200.0.1": sandbox})

        with mitm_ctx():
            context = registry.get_sandbox_context("10.200.0.1", str(path))

        assert context is not None
        _, compiled, policies = context
        assert compiled is not None
        result = matching.match_compiled_firewall_request(
            "https://api.example.com/items", "GET", compiled, policies
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.api_entry["networkIntent"] == intent

    @pytest.mark.parametrize(
        "intent",
        [
            pytest.param([], id="list"),
            pytest.param("direct", id="string"),
            pytest.param(True, id="boolean"),
            pytest.param({}, id="missing-kind"),
            pytest.param({"kind": "unknown"}, id="unsupported-kind"),
            pytest.param({"kind": "direct", "generation": 1}, id="direct-extra-field"),
            pytest.param(
                {"kind": "cloudflare_access", "generation": 1}, id="cloudflare-missing-config-id"
            ),
            pytest.param(_CLOUDFLARE_INTENT | {"configId": None}, id="cloudflare-null-config-id"),
            pytest.param(
                _CLOUDFLARE_INTENT | {"configId": "not-a-uuid"}, id="cloudflare-invalid-config-id"
            ),
            pytest.param(
                _CLOUDFLARE_INTENT | {"configId": 1}, id="cloudflare-non-string-config-id"
            ),
            pytest.param(
                {"kind": "cloudflare_access", "configId": _CLOUDFLARE_INTENT["configId"]},
                id="cloudflare-missing-generation",
            ),
            pytest.param(
                _CLOUDFLARE_INTENT | {"generation": None}, id="cloudflare-null-generation"
            ),
            pytest.param(
                _CLOUDFLARE_INTENT | {"generation": True}, id="cloudflare-boolean-generation"
            ),
            pytest.param(
                _CLOUDFLARE_INTENT | {"generation": "1"}, id="cloudflare-string-generation"
            ),
            pytest.param(
                _CLOUDFLARE_INTENT | {"generation": 1.0}, id="cloudflare-integer-valued-float"
            ),
            pytest.param(
                _CLOUDFLARE_INTENT | {"generation": 1.5}, id="cloudflare-fractional-generation"
            ),
            pytest.param(_CLOUDFLARE_INTENT | {"generation": 0}, id="cloudflare-zero-generation"),
            pytest.param(
                _CLOUDFLARE_INTENT | {"generation": -1}, id="cloudflare-negative-generation"
            ),
            pytest.param(
                _CLOUDFLARE_INTENT | {"generation": 2**31}, id="cloudflare-generation-overflow"
            ),
            pytest.param(_CLOUDFLARE_INTENT | {"extra": True}, id="cloudflare-extra-field"),
        ],
    )
    def test_invalid_custom_network_intent_rejects_only_affected_sandbox(
        self, tmp_path, mitm_ctx, intent
    ):
        path = tmp_path / "registry.json"
        sandbox = inline_sandbox("run-invalid-network")
        entry = sandbox["firewalls"][0]
        entry["customConnectorId"] = _CUSTOM_CONNECTOR_ID
        sandbox["connectorRuntimeTargets"] = [
            {"kind": "custom", "customConnectorId": _CUSTOM_CONNECTOR_ID}
        ]
        entry["firewall"]["apis"][0]["networkIntent"] = intent
        write_multi_sandbox_registry(
            path,
            {"10.200.0.1": sandbox, "10.200.0.2": inline_sandbox("run-valid")},
        )

        with mitm_ctx():
            state = registry.load_registry_state(str(path))
            invalid_context = registry.get_sandbox_context("10.200.0.1", str(path))
            valid_context = registry.get_sandbox_context("10.200.0.2", str(path))

        assert not isinstance(state, registry.RegistryUnavailable)
        assert set(state.sandboxes) == {"10.200.0.2"}
        assert set(state.invalid_sandboxes) == {"10.200.0.1"}
        assert state.invalid_sandboxes["10.200.0.1"].reason == "invalid_firewalls"
        assert invalid_context is None
        assert valid_context is not None
        _, compiled, policies = valid_context
        assert compiled is not None
        result = matching.match_compiled_firewall_request(
            "https://api.example.com/items", "GET", compiled, policies
        )
        assert isinstance(result, matching.FirewallAllow)

    def test_inline_firewalls_do_not_share_compiled_core(self, tmp_path):
        path = tmp_path / "registry.json"
        write_multi_sandbox_registry(
            path,
            {
                "10.200.0.1": inline_sandbox("run-inline-a"),
                "10.200.0.2": inline_sandbox("run-inline-b"),
            },
        )

        first_context = registry.get_sandbox_context("10.200.0.1", str(path))
        second_context = registry.get_sandbox_context("10.200.0.2", str(path))

        assert first_context is not None
        assert second_context is not None
        first_sandbox_info, first_compiled, first_policies = first_context
        second_sandbox_info, second_compiled, second_policies = second_context
        assert first_compiled is not None
        assert second_compiled is not None
        assert first_firewall_core(first_compiled) is not first_firewall_core(second_compiled)

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
        assert first_result.api_entry is first_sandbox_info["firewalls"][0]["apis"][0]
        assert second_result.api_entry is second_sandbox_info["firewalls"][0]["apis"][0]

    @pytest.mark.parametrize("custom", [False, True])
    def test_inline_only_registry_ignores_catalog_cache_changes(self, tmp_path, mitm_ctx, custom):
        registry_path = tmp_path / "registry.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        sandbox = inline_sandbox("run-inline")
        if custom:
            custom_id = "550e8400-e29b-41d4-a716-446655440000"
            sandbox["firewalls"][0]["customConnectorId"] = custom_id
            sandbox["connectorRuntimeTargets"] = [
                {"kind": "custom", "customConnectorId": custom_id}
            ]
        write_multi_sandbox_registry(
            registry_path,
            {"10.200.0.1": sandbox},
        )
        write_catalog_cache(
            cache_path,
            digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            version="catalog-a",
            firewalls={"unused": cache_firewall("unused", "https://unused-a.example.com")},
        )
        os.utime(cache_path, ns=(1_700_000_000_000_000_000, 1_700_000_000_000_000_000))

        with mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            first_context = registry.get_sandbox_context("10.200.0.1", str(registry_path))
            write_catalog_cache(
                cache_path,
                digest="sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                version="catalog-b",
                firewalls={"unused": cache_firewall("unused", "https://unused-b.example.com")},
            )
            os.utime(cache_path, ns=(1_700_000_000_000_000_001, 1_700_000_000_000_000_001))
            second_context = registry.get_sandbox_context("10.200.0.1", str(registry_path))

        assert first_context is not None
        assert second_context is not None
        _first_sandbox_info, first_compiled, _first_policies = first_context
        _second_sandbox_info, second_compiled, _second_policies = second_context
        assert first_compiled is not None
        assert second_compiled is not None
        assert first_firewall_core(first_compiled) is first_firewall_core(second_compiled)

    def test_inline_firewall_api_ids_preserve_custom_ids_and_global_positions(self, tmp_path):
        path = tmp_path / "registry.json"
        sandbox = inline_sandbox("run-inline")
        first_api = sandbox["firewalls"][0]["firewall"]["apis"][0]
        first_api["id"] = "custom-api-id"
        sandbox["firewalls"].append(
            {
                "kind": "inline",
                "firewall": {
                    "name": "upload",
                    "apis": [{**first_api, "id": "", "base": "https://upload.example.com"}],
                },
            }
        )
        write_multi_sandbox_registry(path, {"10.200.0.1": sandbox})

        context = registry.get_sandbox_context("10.200.0.1", str(path))

        assert context is not None
        sandbox_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert [firewall["apis"][0]["id"] for firewall in sandbox_info["firewalls"]] == [
            "custom-api-id",
            "run-inline:1",
        ]

    def test_missing_inline_apis_rejects_only_affected_sandbox(self, tmp_path, mitm_ctx):
        path = tmp_path / "registry.json"
        malformed_sandbox = inline_sandbox("run-malformed")
        del malformed_sandbox["firewalls"][0]["firewall"]["apis"]
        write_multi_sandbox_registry(
            path,
            {
                "10.200.0.1": malformed_sandbox,
                "10.200.0.2": inline_sandbox("run-valid"),
            },
        )

        with mitm_ctx():
            state = registry.load_registry_state(str(path))
            valid_context = registry.get_sandbox_context("10.200.0.2", str(path))

        assert not isinstance(state, registry.RegistryUnavailable)
        assert set(state.sandboxes) == {"10.200.0.2"}
        invalid_sandbox = state.invalid_sandboxes["10.200.0.1"]
        assert invalid_sandbox.reason == "invalid_firewalls"
        assert invalid_sandbox.message == "inline firewall apis must be a list"
        assert valid_context is not None
        _, compiled_firewalls, _ = valid_context
        assert compiled_firewalls is not None

    def test_malformed_custom_connector_apis_reject_only_affected_sandbox(self, tmp_path, mitm_ctx):
        path = tmp_path / "registry.json"
        malformed_sandbox = inline_sandbox("run-malformed")
        malformed_entry = malformed_sandbox["firewalls"][0]
        malformed_entry["customConnectorId"] = "550e8400-e29b-41d4-a716-446655440000"
        malformed_entry["firewall"]["apis"] = None
        write_multi_sandbox_registry(
            path,
            {
                "10.200.0.1": malformed_sandbox,
                "10.200.0.2": inline_sandbox("run-valid"),
            },
        )

        with mitm_ctx():
            state = registry.load_registry_state(str(path))
            valid_context = registry.get_sandbox_context("10.200.0.2", str(path))

        assert not isinstance(state, registry.RegistryUnavailable)
        assert set(state.sandboxes) == {"10.200.0.2"}
        invalid_sandbox = state.invalid_sandboxes["10.200.0.1"]
        assert invalid_sandbox.reason == "invalid_firewalls"
        assert invalid_sandbox.message == "inline firewall apis must be a list"
        assert valid_context is not None
        _, compiled_firewalls, _ = valid_context
        assert compiled_firewalls is not None

    def test_non_string_inline_custom_connector_id_rejects_only_affected_sandbox(
        self, tmp_path, mitm_ctx
    ):
        path = tmp_path / "registry.json"
        malformed_sandbox = inline_sandbox("run-malformed")
        malformed_sandbox["firewalls"][0]["customConnectorId"] = 1
        write_multi_sandbox_registry(
            path,
            {
                "10.200.0.1": malformed_sandbox,
                "10.200.0.2": inline_sandbox("run-valid"),
            },
        )

        with mitm_ctx():
            state = registry.load_registry_state(str(path))
            malformed_context = registry.get_sandbox_context("10.200.0.1", str(path))
            valid_context = registry.get_sandbox_context("10.200.0.2", str(path))

        assert not isinstance(state, registry.RegistryUnavailable)
        assert set(state.sandboxes) == {"10.200.0.2"}
        assert set(state.invalid_sandboxes) == {"10.200.0.1"}
        invalid_sandbox = state.invalid_sandboxes["10.200.0.1"]
        assert invalid_sandbox.reason == "invalid_firewalls"
        assert invalid_sandbox.message == "inline firewall customConnectorId must be a UUID"
        assert malformed_context is None
        assert valid_context is not None
        _, compiled_firewalls, _ = valid_context
        assert compiled_firewalls is not None
