"""Tests for registry built-in base URL variable resolution."""

import json
from collections.abc import Iterator
from unittest.mock import MagicMock

import pytest

import builtin_firewall_cache
import builtin_host_policy
import registry
from tests.builtin_firewall_cache_helpers import serialize_builtin_firewall_catalog_cache
from tests.process_log_helpers import capture_addon_process_events
from tests.registry_helpers import (
    assert_invalid_builtin_sandbox,
    write_trusted_catalog_cache_text,
)
from tests.registry_helpers import (
    write_builtin_firewall_registry as _write_builtin_firewall_registry,
)

_TEST_BUILTIN_FIREWALLS: dict[str, dict] = {}


class _RegistryOptions:
    def __init__(self) -> None:
        self.okou_builtin_firewall_catalog_cache_path = ""


@pytest.fixture(autouse=True)
def registry_ctx(monkeypatch) -> Iterator[MagicMock]:
    options = _RegistryOptions()
    monkeypatch.setattr(builtin_firewall_cache.ctx, "options", options, raising=False)
    _TEST_BUILTIN_FIREWALLS.clear()
    with capture_addon_process_events() as log:
        yield log


def install_test_builtin_firewall(
    *,
    name: str,
    base: str,
    host_policy: dict | None = None,
) -> None:
    api = {
        "base": base,
        "auth": {"headers": {"Authorization": "Bearer ${{ secrets.API_TOKEN }}"}},
        "permissions": [{"name": "read", "rules": ["GET /items"]}],
    }
    if host_policy is not None:
        api["hostPolicy"] = host_policy
    _TEST_BUILTIN_FIREWALLS[name] = {"name": name, "apis": [api]}


def _cache_path_for_registry(path):
    return path.with_name(f"{path.stem}-builtin-firewall-catalog-cache.json")


def _write_catalog_cache(path, firewalls: dict[str, dict]) -> None:
    write_trusted_catalog_cache_text(
        path,
        serialize_builtin_firewall_catalog_cache(
            digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            version="catalog-test",
            firewalls=firewalls,
        ),
    )


def _builtin_firewall(name: str) -> dict:
    base_by_name = {
        "jira": "https://${{ vars.JIRA_DOMAIN }}",
        "n8n": "${{ vars.N8N_BASE_URL }}/api/v1",
        "shopify": "https://${{ vars.SHOPIFY_SHOP }}.myshopify.com/admin/api/2025-01",
        "snowflake": "https://${{ vars.SNOWFLAKE_ACCOUNT }}.snowflakecomputing.com/api",
        "strapi": "${{ vars.STRAPI_BASE_URL }}",
        "zendesk": "https://${{ vars.ZENDESK_SUBDOMAIN }}.zendesk.com",
    }
    host_policy_by_name = {
        "jira": {"kind": "providerOwned", "suffixes": ["atlassian.net"]},
        "n8n": {"kind": "publicDestination"},
        "shopify": {"kind": "providerOwned", "suffixes": ["myshopify.com"]},
        "snowflake": {"kind": "providerOwned", "suffixes": ["snowflakecomputing.com"]},
        "strapi": {"kind": "publicDestination"},
    }
    api = {
        "base": base_by_name[name],
        "auth": {"headers": {"Authorization": "Bearer ${{ secrets.API_TOKEN }}"}},
        "permissions": [{"name": "read", "rules": ["GET /items"]}],
    }
    host_policy = host_policy_by_name.get(name)
    if host_policy is not None:
        api["hostPolicy"] = host_policy
    return {"name": name, "apis": [api]}


def write_builtin_firewall_registry(
    path,
    *,
    run_id: str,
    name: str,
    base_url_vars: dict[str, str],
    cache_firewall: dict | None = None,
) -> None:
    _write_builtin_firewall_registry(
        path,
        run_id=run_id,
        name=name,
        base_url_vars=base_url_vars,
    )
    firewall = cache_firewall or _TEST_BUILTIN_FIREWALLS.get(name) or _builtin_firewall(name)
    cache_path = _cache_path_for_registry(path)
    _write_catalog_cache(cache_path, {firewall["name"]: firewall})
    builtin_firewall_cache.ctx.options.okou_builtin_firewall_catalog_cache_path = str(cache_path)


class TestRegistryBuiltinBaseUrlVars:
    def test_builtin_firewall_entry_resolves_dynamic_base_url_vars(self, tmp_path):
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-zendesk",
            name="zendesk",
            base_url_vars={"ZENDESK_SUBDOMAIN": "acme"},
        )

        context = registry.get_sandbox_context("10.200.0.1", str(path))

        assert context is not None
        sandbox_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert sandbox_info["firewalls"][0]["apis"][0]["base"] == "https://acme.zendesk.com"

    def test_builtin_trailing_authority_fragment_resolves_with_provider_policy(self, tmp_path):
        name = "audit"
        install_test_builtin_firewall(
            name=name,
            base="https://api-${{ vars.HOST }}/v1",
            host_policy={"kind": "providerOwned", "suffixes": ["example.com"]},
        )
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id=f"run-{name}",
            name=name,
            base_url_vars={"HOST": "tenant.example.com"},
        )

        context = registry.get_sandbox_context("10.200.0.1", str(path))

        assert context is not None
        sandbox_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        api = sandbox_info["firewalls"][0]["apis"][0]
        assert api["base"] == "https://api-tenant.example.com/v1"
        assert isinstance(
            api[builtin_host_policy.BUILTIN_HOST_POLICY_RUNTIME_MARKER],
            builtin_host_policy.CompiledBuiltinHostPolicy,
        )

    def test_builtin_firewall_entry_resolves_ecmascript_whitespace_template(self, tmp_path):
        name = "ecmascript-whitespace"
        install_test_builtin_firewall(
            name=name,
            base="https://${{\ufeffvars.TENANT\ufeff}}.example.com",
            host_policy={"kind": "providerOwned", "suffixes": ["example.com"]},
        )
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id=f"run-{name}",
            name=name,
            base_url_vars={"TENANT": "acme"},
        )

        context = registry.get_sandbox_context("10.200.0.1", str(path))

        assert context is not None
        sandbox_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert sandbox_info["firewalls"][0]["apis"][0]["base"] == "https://acme.example.com"

    @pytest.mark.parametrize(
        ("base_url_vars", "expected_message"),
        [
            ([], "baseUrlVars must be an object"),
            ({"ZENDESK_SUBDOMAIN": 1}, "baseUrlVars must contain string values"),
        ],
    )
    def test_malformed_base_url_vars_reject_sandbox(
        self, tmp_path, base_url_vars: object, expected_message: str
    ) -> None:
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-zendesk",
            name="zendesk",
            base_url_vars={"ZENDESK_SUBDOMAIN": "acme"},
        )
        data = json.loads(path.read_text())
        data["sandboxes"]["10.200.0.1"]["firewalls"][0]["baseUrlVars"] = base_url_vars
        path.write_text(json.dumps(data))

        invalid_sandbox = assert_invalid_builtin_sandbox(path)
        state = registry.load_registry_state(str(path))
        assert not isinstance(state, registry.RegistryUnavailable)
        assert "10.200.0.1" not in state.sandboxes
        assert invalid_sandbox.message == expected_message

    def test_builtin_fixed_provider_suffix_rejects_authority_escape(self, tmp_path):
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-shopify",
            name="shopify",
            base_url_vars={"SHOPIFY_SHOP": "attacker.example:443/capture"},
        )

        invalid_sandbox = assert_invalid_builtin_sandbox(path)
        assert 'base URL variable "SHOPIFY_SHOP"' in invalid_sandbox.message

    def test_builtin_fixed_provider_suffix_rejects_encoded_structure(self, tmp_path):
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-shopify",
            name="shopify",
            base_url_vars={"SHOPIFY_SHOP": "attacker.example%3A443%2Fcapture"},
        )

        invalid_sandbox = assert_invalid_builtin_sandbox(path)
        assert 'base URL variable "SHOPIFY_SHOP"' in invalid_sandbox.message

    def test_builtin_fixed_provider_suffix_accepts_multi_label_fragment(self, tmp_path):
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-snowflake",
            name="snowflake",
            base_url_vars={"SNOWFLAKE_ACCOUNT": "xy12345.us-east-1.aws"},
        )

        context = registry.get_sandbox_context("10.200.0.1", str(path))

        assert context is not None
        sandbox_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert sandbox_info["firewalls"][0]["apis"][0]["base"] == (
            "https://xy12345.us-east-1.aws.snowflakecomputing.com/api"
        )

    def test_builtin_fixed_provider_suffix_rejects_path_injection(self, tmp_path):
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-snowflake",
            name="snowflake",
            base_url_vars={"SNOWFLAKE_ACCOUNT": "xy12345.us-east-1.aws/capture"},
        )

        invalid_sandbox = assert_invalid_builtin_sandbox(path)
        assert 'base URL variable "SNOWFLAKE_ACCOUNT"' in invalid_sandbox.message

    def test_builtin_provider_owned_whole_authority_accepts_allowed_host(self, tmp_path):
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-jira",
            name="jira",
            base_url_vars={"JIRA_DOMAIN": "acme.atlassian.net"},
        )

        context = registry.get_sandbox_context("10.200.0.1", str(path))

        assert context is not None
        sandbox_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert sandbox_info["firewalls"][0]["apis"][0]["base"] == "https://acme.atlassian.net"

    def test_builtin_host_policy_marks_resolved_api_for_runtime_enforcement(self, tmp_path):
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-jira",
            name="jira",
            base_url_vars={"JIRA_DOMAIN": "acme.atlassian.net"},
        )

        context = registry.get_sandbox_context("10.200.0.1", str(path))

        assert context is not None
        sandbox_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        api = sandbox_info["firewalls"][0]["apis"][0]
        assert isinstance(
            api[builtin_host_policy.BUILTIN_HOST_POLICY_RUNTIME_MARKER],
            builtin_host_policy.CompiledBuiltinHostPolicy,
        )

    def test_builtin_provider_owned_accepts_idna_dot_equivalent_host(self, tmp_path):
        for index, dot in enumerate(("\u3002", "\uff0e", "\uff61")):
            path = tmp_path / f"registry-{index}.json"
            host = f"acme{dot}atlassian{dot}net"
            write_builtin_firewall_registry(
                path,
                run_id=f"run-jira-{index}",
                name="jira",
                base_url_vars={"JIRA_DOMAIN": host},
            )

            context = registry.get_sandbox_context("10.200.0.1", str(path))

            assert context is not None
            sandbox_info, compiled_firewalls, _ = context
            assert compiled_firewalls is not None
            assert sandbox_info["firewalls"][0]["apis"][0]["base"] == f"https://{host}"

    def test_builtin_provider_owned_rejects_unsafe_idna_compatibility_host(self, tmp_path):
        install_test_builtin_firewall(
            name="unsafe-provider-host",
            base="https://fa\u212a.example.com",
            host_policy={"kind": "providerOwned", "suffixes": ["example.com"]},
        )
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-unsafe-provider-host",
            name="unsafe-provider-host",
            base_url_vars={},
        )

        invalid_sandbox = assert_invalid_builtin_sandbox(path)
        assert "catalog cache unavailable: cache_invalid" in invalid_sandbox.message

    def test_builtin_provider_owned_accepts_percent_encoded_idna_host(self, tmp_path):
        install_test_builtin_firewall(
            name="encoded-provider-host",
            base="https://${{ vars.API_HOST }}",
            host_policy={"kind": "providerOwned", "suffixes": ["example.com"]},
        )
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-encoded-provider-host",
            name="encoded-provider-host",
            base_url_vars={"API_HOST": "b%C3%BCcher.example.com"},
        )

        context = registry.get_sandbox_context("10.200.0.1", str(path))

        assert context is not None
        sandbox_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert sandbox_info["firewalls"][0]["apis"][0]["base"] == (
            "https://b%C3%BCcher.example.com"
        )

    def test_builtin_public_destination_rejects_unsafe_idna_compatibility_host(self, tmp_path):
        install_test_builtin_firewall(
            name="unsafe-public-host",
            base="https://fa\u212a.example.com",
            host_policy={"kind": "publicDestination"},
        )
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-unsafe-public-host",
            name="unsafe-public-host",
            base_url_vars={},
        )

        invalid_sandbox = assert_invalid_builtin_sandbox(path)
        assert "catalog cache unavailable: cache_invalid" in invalid_sandbox.message

    def test_builtin_public_destination_rejects_empty_port_authority(self, tmp_path):
        install_test_builtin_firewall(
            name="empty-port-public-host",
            base="https://example.com:",
            host_policy={"kind": "publicDestination"},
        )
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-empty-port-public-host",
            name="empty-port-public-host",
            base_url_vars={},
        )

        invalid_sandbox = assert_invalid_builtin_sandbox(path)
        assert "catalog cache unavailable: cache_invalid" in invalid_sandbox.message

    def test_builtin_public_destination_rejects_wildcard_hosts(self, tmp_path):
        for index, value in enumerate(("https://*.example.com", "https://%2a.example.com")):
            path = tmp_path / f"registry-{index}.json"
            write_builtin_firewall_registry(
                path,
                run_id="run-strapi",
                name="strapi",
                base_url_vars={"STRAPI_BASE_URL": value},
            )

            invalid_sandbox = assert_invalid_builtin_sandbox(path)
            assert "resolved base URL is invalid" in invalid_sandbox.message

    def test_builtin_public_destination_rejects_userinfo(self, tmp_path):
        for index, value in enumerate(
            ("https://user@example.com", "https://user:pass@example.com")
        ):
            path = tmp_path / f"registry-userinfo-{index}.json"
            write_builtin_firewall_registry(
                path,
                run_id="run-strapi",
                name="strapi",
                base_url_vars={"STRAPI_BASE_URL": value},
            )

            invalid_sandbox = assert_invalid_builtin_sandbox(path)
            assert "resolved base URL is invalid" in invalid_sandbox.message

    def test_builtin_provider_owned_whole_authority_rejects_unowned_hosts(self, tmp_path):
        for value in [
            "attacker.example",
            "evil-atlassian.net",
            "atlassian.net.evil",
            "127.0.0.1",
        ]:
            path = tmp_path / f"registry-{value.replace('/', '-')}.json"
            write_builtin_firewall_registry(
                path,
                run_id="run-jira",
                name="jira",
                base_url_vars={"JIRA_DOMAIN": value},
            )

            invalid_sandbox = assert_invalid_builtin_sandbox(path)
            assert "host policy does not allow resolved host" in invalid_sandbox.message

    @pytest.mark.parametrize(
        ("host_policy", "expected_message"),
        [
            pytest.param(
                {"kind": "providerOwned", "exactHosts": [".api.example.com"]},
                "exactHosts must be fixed hostnames with at least two labels",
                id="provider-owned-exact-leading-dot",
            ),
            pytest.param(
                {"kind": "providerOwned", "exactHosts": ["127.0.0.1"]},
                "exactHosts must be fixed hostnames with at least two labels",
                id="provider-owned-exact-ip-literal",
            ),
            pytest.param(
                {"kind": "providerOwned", "exactHosts": ["0177.0.0.1"]},
                "exactHosts must be fixed hostnames with at least two labels",
                id="provider-owned-exact-ipv4-like",
            ),
            pytest.param(
                {"kind": "providerOwned", "exactHosts": ["api.例子.com"]},
                "exactHosts must be fixed hostnames with at least two labels",
                id="provider-owned-exact-non-ascii",
            ),
            pytest.param(
                {"kind": "providerOwned", "suffixes": ["*.example.com"]},
                "suffixes must be fixed hostnames with at least two labels",
                id="provider-owned-suffix-wildcard",
            ),
            pytest.param(
                {"kind": "providerOwned", "suffixes": ["..example.com"]},
                "suffixes must be fixed hostnames with at least two labels",
                id="provider-owned-suffix-empty-label",
            ),
            pytest.param(
                {"kind": "providerOwned", "suffixes": ["com"]},
                "suffixes must be fixed hostnames with at least two labels",
                id="provider-owned-suffix-single-label",
            ),
            pytest.param(
                {
                    "kind": "providerOwned",
                    "suffixes": ["example.com"],
                    "allowNonDefaultPort": "true",
                },
                "hostPolicy.allowNonDefaultPort must be a boolean",
                id="provider-owned-non-boolean-port-policy",
            ),
            pytest.param(
                {"kind": "providerOwned", "suffixes": ["example.com"], "extra": True},
                "hostPolicy has unsupported keys: extra",
                id="provider-owned-unsupported-key",
            ),
            pytest.param(
                {"kind": "publicDestination", "extra": True},
                "hostPolicy has unsupported keys: extra",
                id="public-destination-unsupported-key",
            ),
        ],
    )
    def test_builtin_rejects_invalid_host_policies(
        self,
        tmp_path,
        host_policy: dict,
        expected_message: str,
        registry_ctx: MagicMock,
    ) -> None:
        name = "invalid-host-policy"
        install_test_builtin_firewall(
            name=name,
            base="https://${{ vars.API_HOST }}",
            host_policy=host_policy,
        )
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id=f"run-{name}",
            name=name,
            base_url_vars={"API_HOST": "api.example.com"},
        )

        invalid_sandbox = assert_invalid_builtin_sandbox(path)

        warning_messages = [call.args[0] for call in registry_ctx.warn.call_args_list]
        assert any(expected_message in message for message in warning_messages)
        assert "catalog cache unavailable: cache_invalid" in invalid_sandbox.message

    def test_builtin_provider_owned_whole_authority_rejects_non_default_port(self, tmp_path):
        install_test_builtin_firewall(
            name="provider-owned-port",
            base="https://${{ vars.API_HOST }}:444/v1",
            host_policy={"kind": "providerOwned", "suffixes": ["example.com"]},
        )
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-provider-owned-port",
            name="provider-owned-port",
            base_url_vars={"API_HOST": "api.example.com"},
        )

        invalid_sandbox = assert_invalid_builtin_sandbox(path)
        assert "host policy does not allow non-default ports" in invalid_sandbox.message

    def test_builtin_whole_authority_rejects_path_injection(self, tmp_path):
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-jira",
            name="jira",
            base_url_vars={"JIRA_DOMAIN": "attacker.example/capture"},
        )

        invalid_sandbox = assert_invalid_builtin_sandbox(path)
        assert 'base URL variable "JIRA_DOMAIN"' in invalid_sandbox.message

    def test_builtin_base_url_var_rejects_firewall_parameter_syntax(self, tmp_path):
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-strapi",
            name="strapi",
            base_url_vars={"STRAPI_BASE_URL": "https://{host}.example.test"},
        )

        invalid_sandbox = assert_invalid_builtin_sandbox(path)
        assert 'base URL variable "STRAPI_BASE_URL"' in invalid_sandbox.message

    def test_builtin_base_url_var_rejects_unicode_whitespace(self, tmp_path):
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-strapi",
            name="strapi",
            base_url_vars={"STRAPI_BASE_URL": "https://strapi.example.test/work\u00a0flows"},
        )

        invalid_sandbox = assert_invalid_builtin_sandbox(path)
        assert 'base URL variable "STRAPI_BASE_URL"' in invalid_sandbox.message

    def test_builtin_public_destination_accepts_public_host_with_port(self, tmp_path):
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-strapi",
            name="strapi",
            base_url_vars={"STRAPI_BASE_URL": "https://strapi.example.test:8443"},
        )

        context = registry.get_sandbox_context("10.200.0.1", str(path))

        assert context is not None
        sandbox_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert sandbox_info["firewalls"][0]["apis"][0]["base"] == (
            "https://strapi.example.test:8443"
        )

    def test_builtin_public_destination_accepts_public_ip_literals(self, tmp_path):
        for value in [
            "https://8.8.8.8",
            "https://[2606:4700:4700::1111]",
        ]:
            path = tmp_path / f"registry-{abs(hash(value))}.json"
            write_builtin_firewall_registry(
                path,
                run_id="run-strapi",
                name="strapi",
                base_url_vars={"STRAPI_BASE_URL": value},
            )

            context = registry.get_sandbox_context("10.200.0.1", str(path))

            assert context is not None
            sandbox_info, compiled_firewalls, _ = context
            assert compiled_firewalls is not None
            assert sandbox_info["firewalls"][0]["apis"][0]["base"] == value

    def test_builtin_public_destination_rejects_non_public_ip_literals(self, tmp_path):
        for value in [
            "https://127.0.0.1",
            "https://[::1]",
        ]:
            path = tmp_path / f"registry-{abs(hash(value))}.json"
            write_builtin_firewall_registry(
                path,
                run_id="run-strapi",
                name="strapi",
                base_url_vars={"STRAPI_BASE_URL": value},
            )

            invalid_sandbox = assert_invalid_builtin_sandbox(path)
            assert "host policy does not allow non-public IP literal" in invalid_sandbox.message

    def test_builtin_public_destination_rejects_trailing_dot_ip_literal(self, tmp_path):
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-strapi",
            name="strapi",
            base_url_vars={"STRAPI_BASE_URL": "https://8.8.8.8."},
        )

        invalid_sandbox = assert_invalid_builtin_sandbox(path)
        assert "host policy does not allow non-public IP literal" in invalid_sandbox.message

    def test_builtin_public_destination_rejects_scoped_ip_literal(self, tmp_path):
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-strapi",
            name="strapi",
            base_url_vars={"STRAPI_BASE_URL": "https://[2606:4700:4700::1111%25lo]"},
        )

        invalid_sandbox = assert_invalid_builtin_sandbox(path)
        assert 'builtin firewall "strapi" resolved base URL is invalid' in invalid_sandbox.message

    def test_builtin_public_destination_rejects_bracketed_ipv4_literal(self, tmp_path):
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-strapi",
            name="strapi",
            base_url_vars={"STRAPI_BASE_URL": "https://[8.8.8.8]"},
        )

        invalid_sandbox = assert_invalid_builtin_sandbox(path)
        assert 'builtin firewall "strapi" resolved base URL is invalid' in invalid_sandbox.message

    def test_builtin_public_destination_rejects_ipvfuture_literal(self, tmp_path):
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-strapi",
            name="strapi",
            base_url_vars={"STRAPI_BASE_URL": "https://[v1.invalid]"},
        )

        invalid_sandbox = assert_invalid_builtin_sandbox(path)
        assert 'builtin firewall "strapi" resolved base URL is invalid' in invalid_sandbox.message

    @pytest.mark.parametrize(
        "value",
        [
            "https://strapi.example.test?next=/../",
            "https://strapi.example.test#next=/../",
        ],
    )
    def test_builtin_base_url_does_not_treat_query_or_fragment_as_path(self, tmp_path, value):
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-strapi",
            name="strapi",
            base_url_vars={"STRAPI_BASE_URL": value},
        )

        invalid_sandbox = assert_invalid_builtin_sandbox(path)
        assert 'builtin firewall "strapi" resolved base URL is invalid' in invalid_sandbox.message

    def test_builtin_base_url_prefix_preserves_fixed_path_suffix(self, tmp_path):
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-n8n",
            name="n8n",
            base_url_vars={"N8N_BASE_URL": "https://n8n.example.test/workflows"},
        )

        context = registry.get_sandbox_context("10.200.0.1", str(path))

        assert context is not None
        sandbox_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert sandbox_info["firewalls"][0]["apis"][0]["base"] == (
            "https://n8n.example.test/workflows/api/v1"
        )

    def test_builtin_base_url_prefix_accepts_encoded_path_separator(self, tmp_path):
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-n8n",
            name="n8n",
            base_url_vars={"N8N_BASE_URL": "https://n8n.example.test/work%2fflows"},
        )

        context = registry.get_sandbox_context("10.200.0.1", str(path))

        assert context is not None
        sandbox_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert sandbox_info["firewalls"][0]["apis"][0]["base"] == (
            "https://n8n.example.test/work%2fflows/api/v1"
        )

    def test_builtin_base_url_prefix_rejects_path_dot_segments(self, tmp_path):
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-n8n",
            name="n8n",
            base_url_vars={"N8N_BASE_URL": "https://n8n.example.test/workflows/.."},
        )

        invalid_sandbox = assert_invalid_builtin_sandbox(path)
        assert (
            'base URL variable "N8N_BASE_URL" must not contain unsafe path segments '
            "before a fixed path suffix"
        ) in invalid_sandbox.message

    def test_builtin_base_url_prefix_rejects_encoded_path_dot_segments(self, tmp_path):
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-n8n",
            name="n8n",
            base_url_vars={"N8N_BASE_URL": "https://n8n.example.test/workflows/%2e%2e"},
        )

        invalid_sandbox = assert_invalid_builtin_sandbox(path)
        assert (
            'base URL variable "N8N_BASE_URL" must not contain unsafe path segments '
            "before a fixed path suffix"
        ) in invalid_sandbox.message

    def test_builtin_path_segment_var_accepts_fixed_suffix(self, tmp_path):
        install_test_builtin_firewall(
            name="tenant-path",
            base="https://api.example.test/accounts/${{ vars.TENANT }}/v1",
        )
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-tenant-path",
            name="tenant-path",
            base_url_vars={"TENANT": "acme:prod"},
        )

        context = registry.get_sandbox_context("10.200.0.1", str(path))

        assert context is not None
        sandbox_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert sandbox_info["firewalls"][0]["apis"][0]["base"] == (
            "https://api.example.test/accounts/acme:prod/v1"
        )

    def test_builtin_path_segment_var_rejects_path_injection(self, tmp_path):
        install_test_builtin_firewall(
            name="tenant-path",
            base="https://api.example.test/accounts/${{ vars.TENANT }}/v1",
        )
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-tenant-path",
            name="tenant-path",
            base_url_vars={"TENANT": "acme/../admin"},
        )

        invalid_sandbox = assert_invalid_builtin_sandbox(path)
        assert 'base URL variable "TENANT"' in invalid_sandbox.message

    def test_builtin_path_segment_var_rejects_encoded_path_separator(self, tmp_path):
        install_test_builtin_firewall(
            name="tenant-path",
            base="https://api.example.test/accounts/${{ vars.TENANT }}/v1",
        )
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-tenant-path",
            name="tenant-path",
            base_url_vars={"TENANT": "acme%252fprod"},
        )

        invalid_sandbox = assert_invalid_builtin_sandbox(path)
        assert 'base URL variable "TENANT"' in invalid_sandbox.message

    def test_builtin_path_segment_var_rejects_dot_segment(self, tmp_path):
        install_test_builtin_firewall(
            name="tenant-path",
            base="https://api.example.test/accounts/${{ vars.TENANT }}/v1",
        )
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-tenant-path",
            name="tenant-path",
            base_url_vars={"TENANT": "%2e%2e"},
        )

        invalid_sandbox = assert_invalid_builtin_sandbox(path)
        assert 'base URL variable "TENANT"' in invalid_sandbox.message

    def test_builtin_path_segment_var_rejects_path_parameter_dot_segment(self, tmp_path):
        install_test_builtin_firewall(
            name="tenant-path",
            base="https://api.example.test/accounts/${{ vars.TENANT }}/v1",
        )
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-tenant-path",
            name="tenant-path",
            base_url_vars={"TENANT": "..;type=folder"},
        )

        invalid_sandbox = assert_invalid_builtin_sandbox(path)
        assert 'base URL variable "TENANT"' in invalid_sandbox.message

    def test_builtin_path_segment_var_rejects_nested_encoded_dot_segment(self, tmp_path):
        install_test_builtin_firewall(
            name="tenant-path",
            base="https://api.example.test/accounts/${{ vars.TENANT }}/v1",
        )
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-tenant-path",
            name="tenant-path",
            base_url_vars={"TENANT": "%252e%252e"},
        )

        invalid_sandbox = assert_invalid_builtin_sandbox(path)
        assert 'base URL variable "TENANT"' in invalid_sandbox.message

    def test_builtin_path_segment_var_rejects_compatibility_dot_segment(self, tmp_path):
        install_test_builtin_firewall(
            name="tenant-path",
            base="https://api.example.test/accounts/${{ vars.TENANT }}/v1",
        )
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-tenant-path",
            name="tenant-path",
            base_url_vars={"TENANT": "\uff0e\uff0e"},
        )

        invalid_sandbox = assert_invalid_builtin_sandbox(path)
        assert 'base URL variable "TENANT"' in invalid_sandbox.message

    def test_builtin_path_var_allows_dot_outside_dot_segment(self, tmp_path):
        install_test_builtin_firewall(
            name="path-fragment",
            base="https://api.example.test/v${{ vars.VERSION }}",
        )
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-path-fragment",
            name="path-fragment",
            base_url_vars={"VERSION": "%2e1"},
        )

        context = registry.get_sandbox_context("10.200.0.1", str(path))

        assert context is not None
        sandbox_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert sandbox_info["firewalls"][0]["apis"][0]["base"] == ("https://api.example.test/v%2e1")

    def test_builtin_path_vars_reject_combined_dot_segment(self, tmp_path):
        install_test_builtin_firewall(
            name="multi-path-segment",
            base="https://api.example.test/accounts/${{ vars.A }}${{ vars.B }}/v1",
        )
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-multi-path-segment",
            name="multi-path-segment",
            base_url_vars={"A": ".", "B": "."},
        )

        invalid_sandbox = assert_invalid_builtin_sandbox(path)
        assert "resolved base URL has unsafe path segments" in invalid_sandbox.message

    def test_builtin_path_vars_accept_combined_safe_segment(self, tmp_path):
        install_test_builtin_firewall(
            name="multi-path-segment",
            base="https://api.example.test/accounts/${{ vars.A }}${{ vars.B }}/v1",
        )
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-multi-path-segment",
            name="multi-path-segment",
            base_url_vars={"A": "v", "B": "1"},
        )

        context = registry.get_sandbox_context("10.200.0.1", str(path))

        assert context is not None
        sandbox_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert sandbox_info["firewalls"][0]["apis"][0]["base"] == (
            "https://api.example.test/accounts/v1/v1"
        )

    def test_builtin_port_var_accepts_numeric_port(self, tmp_path):
        install_test_builtin_firewall(
            name="port-api",
            base="https://api.example.test:${{ vars.API_PORT }}/v1",
        )
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-port-api",
            name="port-api",
            base_url_vars={"API_PORT": "8443"},
        )

        context = registry.get_sandbox_context("10.200.0.1", str(path))

        assert context is not None
        sandbox_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert sandbox_info["firewalls"][0]["apis"][0]["base"] == (
            "https://api.example.test:8443/v1"
        )

    def test_builtin_port_var_rejects_non_numeric_port(self, tmp_path):
        install_test_builtin_firewall(
            name="port-api",
            base="https://api.example.test:${{ vars.API_PORT }}/v1",
        )
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-port-api",
            name="port-api",
            base_url_vars={"API_PORT": "443/path"},
        )

        invalid_sandbox = assert_invalid_builtin_sandbox(path)
        assert 'base URL variable "API_PORT"' in invalid_sandbox.message

    def test_credentialed_builtin_firewall_entry_rejects_http_dynamic_base(self, tmp_path):
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-strapi",
            name="strapi",
            base_url_vars={"STRAPI_BASE_URL": "http://strapi.example.test"},
        )

        invalid_sandbox = assert_invalid_builtin_sandbox(path)
        assert "credentialed base URL must use https" in invalid_sandbox.message

    def test_credentialed_builtin_firewall_entry_accepts_https_dynamic_base(self, tmp_path):
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-strapi",
            name="strapi",
            base_url_vars={"STRAPI_BASE_URL": "https://strapi.example.test"},
        )

        context = registry.get_sandbox_context("10.200.0.1", str(path))

        assert context is not None
        sandbox_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert sandbox_info["firewalls"][0]["apis"][0]["base"] == ("https://strapi.example.test")

    def test_builtin_firewall_entry_missing_dynamic_var_rejects_sandbox(self, tmp_path):
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-zendesk",
            name="zendesk",
            base_url_vars={},
        )

        invalid_sandbox = assert_invalid_builtin_sandbox(path)
        assert "ZENDESK_SUBDOMAIN" in invalid_sandbox.message

    def test_builtin_firewall_entry_does_not_read_top_level_vars(self, tmp_path):
        path = tmp_path / "registry.json"
        path.write_text(
            json.dumps(
                {
                    "sandboxes": {
                        "10.200.0.1": {
                            "runId": "run-zendesk",
                            "billableFirewalls": [],
                            "cliAgentType": "claude-code",
                            "vars": {"ZENDESK_SUBDOMAIN": "top-level"},
                            "firewalls": [{"kind": "builtin", "name": "zendesk"}],
                        }
                    },
                    "updatedAt": 0,
                }
            )
        )
        cache_path = _cache_path_for_registry(path)
        _write_catalog_cache(cache_path, {"zendesk": _builtin_firewall("zendesk")})
        builtin_firewall_cache.ctx.options.okou_builtin_firewall_catalog_cache_path = str(
            cache_path
        )

        invalid_sandbox = assert_invalid_builtin_sandbox(path)
        assert "ZENDESK_SUBDOMAIN" in invalid_sandbox.message

    def test_unknown_builtin_firewall_entry_is_omitted(self, tmp_path):
        path = tmp_path / "registry.json"
        write_builtin_firewall_registry(
            path,
            run_id="run-missing",
            name="missing-firewall",
            base_url_vars={},
            cache_firewall=_builtin_firewall("zendesk"),
        )

        context = registry.get_sandbox_context("10.200.0.1", str(path))
        state = registry.load_registry_state(str(path))

        assert context is not None
        sandbox_info, compiled_firewalls, _ = context
        assert sandbox_info["firewalls"] == []
        assert compiled_firewalls is None
        assert not isinstance(state, registry.RegistryUnavailable)
        assert state.invalid_sandboxes == {}
        assert state.omitted_builtin_firewalls == {"10.200.0.1": frozenset({"missing-firewall"})}
