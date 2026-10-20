"""Tests for built-in registry catalog payload and trust validation."""

import json
from collections.abc import Callable
from unittest.mock import patch

import pytest

import builtin_connector_diagnostics
import builtin_firewall_cache
import matching
import registry
import state_file
from generated.builtin_firewall_cache import BUILTIN_FIREWALL_CATALOG_CACHE_SCHEMA_VERSION
from tests.registry_builtin_helpers import (
    cache_firewall,
    write_catalog_cache,
    write_registry_with_cache,
)
from tests.registry_helpers import (
    assert_invalid_builtin_sandbox,
    builtin_sandbox,
    write_multi_sandbox_registry,
    write_trusted_catalog_cache_text,
)


def _assert_invalid_builtin_sandbox_with_cache(
    *,
    registry_path,
    cache_path,
    mitm_ctx,
    expected_message: str,
) -> None:
    with mitm_ctx(
        registry_path=str(registry_path),
        builtin_firewall_catalog_cache_path=str(cache_path),
    ):
        invalid_sandbox = assert_invalid_builtin_sandbox(registry_path)

    assert expected_message in invalid_sandbox.message


def _assert_cache_firewall_is_invalid(
    tmp_path,
    mitm_ctx,
    firewall: dict,
    *,
    expected_message: str = "catalog cache unavailable: cache_invalid",
    cache_mode: int | None = None,
) -> None:
    registry_path = tmp_path / "registry.json"
    cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
    write_catalog_cache(
        cache_path,
        digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        version="catalog-a",
        firewalls={"fallback": firewall},
    )
    if cache_mode is not None:
        cache_path.chmod(cache_mode)
    write_multi_sandbox_registry(
        registry_path,
        {"10.200.0.1": builtin_sandbox("run-fallback", "fallback")},
    )

    _assert_invalid_builtin_sandbox_with_cache(
        registry_path=registry_path,
        cache_path=cache_path,
        mitm_ctx=mitm_ctx,
        expected_message=expected_message,
    )


class TestRegistryBuiltinCatalogValidation:
    def test_runner_catalog_cache_fstat_failure_reports_unavailable(self, tmp_path):
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        cache_path.write_text("{}")
        error = OSError("fstat failed")

        with patch.object(state_file.os, "fstat", side_effect=error):
            snapshot = builtin_firewall_cache.load_catalog_snapshot(str(cache_path))

        assert snapshot.dependency_file_key is None
        assert snapshot.catalog is None
        assert snapshot.cache_path == str(cache_path.absolute())
        assert snapshot.unavailable_reason == "cache_unavailable"

    def test_runner_catalog_cache_directory_reports_not_regular(self, tmp_path):
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        cache_path.mkdir()

        snapshot = builtin_firewall_cache.load_catalog_snapshot(str(cache_path))

        assert snapshot.dependency_file_key is None
        assert snapshot.catalog is None
        assert snapshot.cache_path == str(cache_path.absolute())
        assert snapshot.unavailable_reason == "cache_not_regular"

    def test_runner_catalog_cache_rejects_initial_oversize_before_parsing(self, tmp_path, mitm_ctx):
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        write_catalog_cache(
            cache_path,
            digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            version="catalog-a",
            firewalls={"fallback": cache_firewall("fallback", "https://cache.example.com")},
        )
        actual_size = cache_path.stat().st_size

        with (
            mitm_ctx(),
            patch.object(
                builtin_firewall_cache,
                "BUILTIN_FIREWALL_CATALOG_MAX_BYTES",
                actual_size - 1,
            ),
            patch.object(
                builtin_firewall_cache.json,
                "loads",
                wraps=builtin_firewall_cache.json.loads,
            ) as spy,
        ):
            snapshot = builtin_firewall_cache.load_catalog_snapshot(str(cache_path))

        assert snapshot.dependency_file_key is not None
        assert snapshot.dependency_file_key.st_size == actual_size
        assert snapshot.catalog is None
        assert snapshot.unavailable_reason == "cache_invalid"
        assert spy.call_count == 0

    def test_runner_catalog_cache_rejects_unsupported_schema_version(self, tmp_path, mitm_ctx):
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        write_catalog_cache(
            cache_path,
            digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            version="catalog-a",
            firewalls={"fallback": cache_firewall("fallback", "https://cache.example.com")},
        )
        raw = json.loads(cache_path.read_text())
        raw["schemaVersion"] = BUILTIN_FIREWALL_CATALOG_CACHE_SCHEMA_VERSION + 1
        write_trusted_catalog_cache_text(cache_path, json.dumps(raw, sort_keys=True))

        with mitm_ctx():
            snapshot = builtin_firewall_cache.load_catalog_snapshot(str(cache_path))

        assert snapshot.dependency_file_key is not None
        assert snapshot.catalog is None
        assert snapshot.unavailable_reason == "cache_invalid"

    @pytest.mark.parametrize(
        "mutate",
        [
            pytest.param(
                lambda raw: raw.__setitem__("schemaVersion", True),
                id="boolean-schema-version",
            ),
            pytest.param(
                lambda raw: raw.__setitem__("catalogVersion", ""),
                id="empty-catalog-version",
            ),
            pytest.param(
                lambda raw: raw.__setitem__("firewalls", {}),
                id="empty-firewalls",
            ),
            pytest.param(
                lambda raw: raw.__setitem__("catalogDigest", "sha512:" + "a" * 64),
                id="wrong-digest-prefix",
            ),
            pytest.param(
                lambda raw: raw.__setitem__(
                    "firewalls",
                    {"": {**raw["firewalls"]["fallback"], "name": ""}},
                ),
                id="empty-firewall-key",
            ),
            pytest.param(
                lambda raw: raw["firewalls"].__setitem__("fallback", []),
                id="non-object-firewall",
            ),
            pytest.param(
                lambda raw: raw["firewalls"]["fallback"].__setitem__("name", "other"),
                id="firewall-name-mismatch",
            ),
            pytest.param(
                lambda raw: raw["firewalls"]["fallback"].__setitem__("apis", [[]]),
                id="non-object-api",
            ),
            pytest.param(
                lambda raw: raw["firewalls"]["fallback"]["apis"][0].__setitem__("base", ""),
                id="empty-api-base",
            ),
            pytest.param(
                lambda raw: raw["firewalls"]["fallback"]["apis"][0].__setitem__("permissions", {}),
                id="non-list-permissions",
            ),
            pytest.param(
                lambda raw: raw["firewalls"]["fallback"]["apis"][0].__setitem__(
                    "permissions", [[]]
                ),
                id="non-object-permission",
            ),
            pytest.param(
                lambda raw: raw["firewalls"]["fallback"]["apis"][0]["permissions"][0].__setitem__(
                    "name", 1
                ),
                id="non-string-permission-name",
            ),
            pytest.param(
                lambda raw: raw["firewalls"]["fallback"]["apis"][0]["permissions"].append(
                    {"name": "read", "rules": ["GET /other"]}
                ),
                id="duplicate-permission-name",
            ),
            pytest.param(
                lambda raw: raw["firewalls"]["fallback"]["apis"][0]["permissions"][0].__setitem__(
                    "rules", [1]
                ),
                id="non-string-rule",
            ),
        ],
    )
    def test_malformed_runner_catalog_cache_shapes_fail_closed(
        self,
        tmp_path,
        mitm_ctx,
        mutate: Callable[[dict], None],
    ) -> None:
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        write_catalog_cache(
            cache_path,
            digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            version="catalog-a",
            firewalls={"fallback": cache_firewall("fallback", "https://cache.example.com")},
        )
        raw = json.loads(cache_path.read_text())
        mutate(raw)
        write_trusted_catalog_cache_text(cache_path, json.dumps(raw, sort_keys=True))

        with mitm_ctx():
            snapshot = builtin_firewall_cache.load_catalog_snapshot(str(cache_path))

        assert snapshot.dependency_file_key is not None
        assert snapshot.catalog is None
        assert snapshot.unavailable_reason == "cache_invalid"

    @pytest.mark.parametrize(
        "template_whitespace",
        [" ", "\ufeff"],
        ids=["space", "byte-order-mark"],
    )
    def test_runner_catalog_cache_accepts_valid_template_base(
        self, tmp_path, mitm_ctx, template_whitespace
    ):
        registry_path = tmp_path / "registry.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        write_multi_sandbox_registry(
            registry_path,
            {
                "10.200.0.1": builtin_sandbox(
                    "run-template",
                    "templated",
                    {"TENANT": "acme"},
                )
            },
        )
        write_catalog_cache(
            cache_path,
            digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            version="catalog-a",
            firewalls={
                "templated": {
                    "name": "templated",
                    "apis": [
                        {
                            "base": (
                                "https://${{"
                                + template_whitespace
                                + "vars.TENANT"
                                + template_whitespace
                                + "}}.example.com"
                            ),
                            "auth": {"headers": {}},
                            "permissions": [{"name": "read", "rules": ["GET /items"]}],
                        }
                    ],
                }
            },
        )

        with mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            context = registry.get_sandbox_context("10.200.0.1", str(registry_path))

        assert context is not None
        sandbox_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert sandbox_info["firewalls"][0]["apis"][0]["base"] == "https://acme.example.com"

    @pytest.mark.parametrize(
        ("escape_prefix", "suffix", "expected_error", "expected_base"),
        [
            pytest.param("%6", "1", None, "https://a.example.com", id="one-hex-digit"),
            pytest.param("%", "61", None, "https://a.example.com", id="two-hex-digits"),
            pytest.param("%c3%", "bc", None, "https://xn--tda.example.com", id="utf8-byte"),
            pytest.param("%c3%b", "c", None, "https://xn--tda.example.com", id="utf8-nibble"),
            pytest.param("%6", "z", "resolved base URL is invalid", None, id="non-hex"),
            pytest.param("%", "6", "resolved base URL is invalid", None, id="incomplete"),
            pytest.param("%", "ff", "resolved base URL is invalid", None, id="invalid-utf8"),
            pytest.param(
                "%c3%", "ff", "resolved base URL is invalid", None, id="invalid-utf8-tail"
            ),
            pytest.param("%", "2f", "resolved base URL is invalid", None, id="encoded-slash"),
            pytest.param("%", "2e", "resolved base URL is invalid", None, id="encoded-dot"),
            pytest.param("%", "25", "resolved base URL is invalid", None, id="encoded-percent"),
            pytest.param("%", "00", "resolved base URL is invalid", None, id="encoded-control"),
            pytest.param("%", "7b", "resolved base URL is invalid", None, id="encoded-parameter"),
            pytest.param(
                "%6", "2", "host policy does not allow resolved host", None, id="unowned-host"
            ),
        ],
    )
    def test_split_hostname_escape_preserves_unrelated_catalog_connector(
        self, tmp_path, mitm_ctx, escape_prefix, suffix, expected_error, expected_base
    ):
        base = "https://" + escape_prefix + "${{ vars.SUFFIX }}.example.com"
        registry_path, cache_path = write_registry_with_cache(
            tmp_path,
            {
                "10.200.0.1": builtin_sandbox("run-template", "templated", {"SUFFIX": suffix}),
                "10.200.0.2": builtin_sandbox("run-static", "static"),
            },
            {
                "templated": {
                    "name": "templated",
                    "apis": [
                        {
                            "base": base,
                            "hostPolicy": {
                                "kind": "providerOwned",
                                "exactHosts": ["a.example.com", "xn--tda.example.com"],
                            },
                            "auth": {"headers": {"Authorization": "Bearer ${{ secrets.TOKEN }}"}},
                            "permissions": [{"name": "read", "rules": ["GET /items"]}],
                        }
                    ],
                },
                "static": cache_firewall("static", "https://api.static.example.com"),
            },
        )

        with mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            snapshot = builtin_firewall_cache.load_catalog_snapshot(str(cache_path))
            state = registry.load_registry_state(str(registry_path))
            template_context = registry.get_sandbox_context("10.200.0.1", str(registry_path))
            static_context = registry.get_sandbox_context("10.200.0.2", str(registry_path))

        assert snapshot.catalog is not None
        assert snapshot.unavailable_reason is None
        assert snapshot.catalog.firewalls["templated"]["apis"][0]["base"] == base
        assert not isinstance(state, registry.RegistryUnavailable)
        assert static_context is not None
        _, static_firewalls, _ = static_context
        allowed = matching.match_compiled_firewall_request(
            "https://api.static.example.com/items",
            "GET",
            static_firewalls,
            {"static": {"allow": ["read"], "unknownPolicy": "deny"}},
        )
        assert isinstance(allowed, matching.FirewallAllow)
        assert (allowed.name, allowed.permission) == ("static", "read")

        if expected_error is not None:
            assert template_context is None
            assert set(state.sandboxes) == {"10.200.0.2"}
            assert set(state.invalid_sandboxes) == {"10.200.0.1"}
            invalid = state.invalid_sandboxes["10.200.0.1"]
            assert invalid.reason == "invalid_firewalls"
            assert expected_error in invalid.message
            return

        assert state.invalid_sandboxes == {}
        assert set(state.sandboxes) == {"10.200.0.1", "10.200.0.2"}
        assert template_context is not None
        template_info, template_firewalls, _ = template_context
        assert template_info["firewalls"][0]["apis"][0]["base"] == (
            "https://" + escape_prefix + suffix + ".example.com"
        )
        allowed = matching.match_compiled_firewall_request(
            expected_base + "/items",
            "GET",
            template_firewalls,
            {"templated": {"allow": ["read"], "unknownPolicy": "deny"}},
        )
        assert isinstance(allowed, matching.FirewallAllow)
        assert (allowed.name, allowed.permission) == ("templated", "read")

    @pytest.mark.parametrize(
        "literal_label",
        ["a" * 62, "a" * 63, "é" * 57, "%C3%A9" * 57],
        ids=["62-characters", "63-characters", "63-byte-idna", "encoded-63-byte-idna"],
    )
    def test_hostname_suffix_template_preserves_unrelated_catalog_connector(
        self, tmp_path, mitm_ctx, literal_label
    ):
        base = "https://" + literal_label + "${{ vars.SUFFIX }}"
        registry_path, cache_path = write_registry_with_cache(
            tmp_path,
            {
                "10.200.0.1": builtin_sandbox(
                    "run-template", "templated", {"SUFFIX": ".example.com"}
                ),
                "10.200.0.2": builtin_sandbox("run-static", "static"),
            },
            {
                "templated": {
                    "name": "templated",
                    "apis": [
                        {
                            "base": base,
                            "hostPolicy": {"kind": "providerOwned", "suffixes": ["example.com"]},
                            "auth": {"headers": {}},
                            "permissions": [{"name": "read", "rules": ["GET /items"]}],
                        }
                    ],
                },
                "static": cache_firewall("static", "https://api.static.example.com"),
            },
        )

        with mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            template_context = registry.get_sandbox_context("10.200.0.1", str(registry_path))
            static_context = registry.get_sandbox_context("10.200.0.2", str(registry_path))

        assert template_context is not None
        template_info, template_firewalls, _ = template_context
        assert template_firewalls is not None
        assert template_info["firewalls"][0]["apis"][0]["base"] == (
            "https://" + literal_label + ".example.com"
        )
        assert static_context is not None
        static_info, static_firewalls, _ = static_context
        assert static_firewalls is not None
        assert static_info["firewalls"][0]["apis"][0]["base"] == "https://api.static.example.com"

    @pytest.mark.parametrize(
        ("base", "vars_map", "expected_base", "expected_error"),
        [
            pytest.param(
                "https://xn--${{ vars.SUFFIX }}.example.com",
                {"SUFFIX": "bcher-kva"},
                "https://xn--bcher-kva.example.com",
                None,
                id="alabel-prefix",
            ),
            pytest.param(
                "https://xn--b${{ vars.SUFFIX }}.example.com",
                {"SUFFIX": "cher-kva"},
                "https://xn--bcher-kva.example.com",
                None,
                id="split-punycode-payload",
            ),
            pytest.param(
                "https://xn--b_${{ vars.SUFFIX }}.example.com",
                {"SUFFIX": "cher-3ya"},
                "https://xn--b_cher-3ya.example.com",
                None,
                id="basic-ascii-underscore",
            ),
            pytest.param(
                "https://xn--b!${{ vars.SUFFIX }}.example.com",
                {"SUFFIX": "cher-3ya"},
                "https://xn--b!cher-3ya.example.com",
                None,
                id="basic-ascii-punctuation",
            ),
            pytest.param(
                "https://%78%6E--${{ vars.SUFFIX }}.example.com",
                {"SUFFIX": "bcher-kva"},
                "https://%78%6E--bcher-kva.example.com",
                None,
                id="encoded-alabel-prefix",
            ),
            pytest.param(
                "https://xn--${{ vars.FIRST }}${{ vars.SECOND }}.example.com",
                {"FIRST": "bcher", "SECOND": "-kva"},
                "https://xn--bcher-kva.example.com",
                None,
                id="adjacent-variables",
            ),
            pytest.param(
                "https://xn--${{ vars.SUFFIX }}.xn--${{ vars.SUFFIX }}.example.com",
                {"SUFFIX": "bcher-kva"},
                "https://xn--bcher-kva.xn--bcher-kva.example.com",
                None,
                id="repeated-variable",
            ),
            pytest.param(
                "https://${{ vars.PREFIX }}xn--${{ vars.SUFFIX }}.example.com",
                {"PREFIX": "a", "SUFFIX": "bcher-kva"},
                "https://axn--bcher-kva.example.com",
                None,
                id="literal-between-variables",
            ),
            pytest.param(
                "https://xn--${{ vars.SUFFIX }}.example.com",
                {"SUFFIX": "a"},
                None,
                "resolved base URL is invalid",
                id="invalid-resolved-alabel",
            ),
            pytest.param(
                "https://xn--${{ vars.SUFFIX }}.example.com",
                {"SUFFIX": "caf-dma"},
                None,
                "host policy does not allow resolved host",
                id="unowned-resolved-alabel",
            ),
        ],
    )
    def test_partial_alabel_template_preserves_unrelated_catalog_connector(
        self, tmp_path, mitm_ctx, base, vars_map, expected_base, expected_error
    ):
        registry_path, cache_path = write_registry_with_cache(
            tmp_path,
            {
                "10.200.0.1": builtin_sandbox("run-template", "templated", vars_map),
                "10.200.0.2": builtin_sandbox("run-static", "static"),
            },
            {
                "templated": {
                    "name": "templated",
                    "apis": [
                        {
                            "base": base,
                            "hostPolicy": {
                                "kind": "providerOwned",
                                "exactHosts": [
                                    "xn--bcher-kva.example.com",
                                    "axn--bcher-kva.example.com",
                                    "xn--bcher-kva.xn--bcher-kva.example.com",
                                    "xn--b_cher-3ya.example.com",
                                    "xn--b!cher-3ya.example.com",
                                ],
                            },
                            "auth": {"headers": {"Authorization": "Bearer ${{ secrets.TOKEN }}"}},
                            "permissions": [{"name": "read", "rules": ["GET /items"]}],
                        }
                    ],
                },
                "static": cache_firewall("static", "https://api.static.example.com"),
            },
        )

        with mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            snapshot = builtin_firewall_cache.load_catalog_snapshot(str(cache_path))
            state = registry.load_registry_state(str(registry_path))
            template_context = registry.get_sandbox_context("10.200.0.1", str(registry_path))
            static_context = registry.get_sandbox_context("10.200.0.2", str(registry_path))

        assert snapshot.catalog is not None
        assert snapshot.unavailable_reason is None
        assert not isinstance(state, registry.RegistryUnavailable)
        assert static_context is not None
        static_info, static_firewalls, _ = static_context
        assert static_firewalls is not None
        assert static_info["firewalls"][0]["apis"][0]["base"] == "https://api.static.example.com"

        if expected_error is not None:
            assert template_context is None
            assert set(state.sandboxes) == {"10.200.0.2"}
            assert set(state.invalid_sandboxes) == {"10.200.0.1"}
            invalid_sandbox = state.invalid_sandboxes["10.200.0.1"]
            assert invalid_sandbox.reason == "invalid_firewalls"
            assert expected_error in invalid_sandbox.message
            return

        assert state.invalid_sandboxes == {}
        assert set(state.sandboxes) == {"10.200.0.1", "10.200.0.2"}
        assert template_context is not None
        template_info, template_firewalls, _ = template_context
        assert template_firewalls is not None
        assert template_info["firewalls"][0]["apis"][0]["base"] == expected_base

    @pytest.mark.parametrize(
        "base",
        [
            pytest.param(
                "https://xn--${{ vars.SUFFIX }}.xn--a.example.com", id="invalid-fixed-alabel"
            ),
            pytest.param("https://xn--%2e${{ vars.SUFFIX }}.example.com", id="encoded-dot"),
            pytest.param("https://xn--%2f${{ vars.SUFFIX }}.example.com", id="encoded-slash"),
            pytest.param("https://xn--%zz${{ vars.SUFFIX }}.example.com", id="malformed-escape"),
            pytest.param("https://xn--%ff${{ vars.SUFFIX }}.example.com", id="invalid-utf8"),
            pytest.param("https://xn--b%2561${{ vars.SUFFIX }}.example.com", id="encoded-percent"),
            pytest.param(
                "https://xn--%7Btenant%7D${{ vars.SUFFIX }}.example.com", id="encoded-parameter"
            ),
            pytest.param(
                "https://xn--" + "a" * 60 + "${{ vars.SUFFIX }}.example.com",
                id="overlong-literal-alabel",
            ),
        ],
    )
    def test_partial_alabel_template_keeps_literal_authority_validation(
        self, tmp_path, mitm_ctx, base
    ):
        _assert_cache_firewall_is_invalid(
            tmp_path, mitm_ctx, {"name": "fallback", "apis": [{"base": base, "auth": {}}]}
        )

    def test_runner_catalog_cache_resolves_whole_host_template_with_path_parameter(
        self, tmp_path, mitm_ctx
    ):
        registry_path = tmp_path / "registry.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        write_multi_sandbox_registry(
            registry_path,
            {
                "10.200.0.1": builtin_sandbox(
                    "run-template",
                    "templated",
                    {"WORKSPACE_HOST": "acme.uspacy.com"},
                )
            },
        )
        write_catalog_cache(
            cache_path,
            digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            version="catalog-a",
            firewalls={
                "templated": {
                    "name": "templated",
                    "apis": [
                        {
                            "base": "https://${{ vars.WORKSPACE_HOST }}/v1/hooks/{hookKey}",
                            "hostPolicy": {
                                "kind": "providerOwned",
                                "suffixes": [".uspacy.com"],
                            },
                            "auth": {"headers": {}},
                            "permissions": [
                                {
                                    "name": "read",
                                    "rules": ["GET /v1/hooks/{hookKey}"],
                                }
                            ],
                        }
                    ],
                }
            },
        )

        with mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            context = registry.get_sandbox_context("10.200.0.1", str(registry_path))

        assert context is not None
        sandbox_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert (
            sandbox_info["firewalls"][0]["apis"][0]["base"]
            == "https://acme.uspacy.com/v1/hooks/{hookKey}"
        )

    @pytest.mark.parametrize(
        ("base", "vars_map", "resolved_base"),
        [
            pytest.param(
                "https://${{ vars.PREFIX }}\u0301.example.com",
                {"PREFIX": "e"},
                "https://e\u0301.example.com",
                id="incomplete-combining-label",
            ),
            pytest.param(
                "https://api\u3002${{ vars.HOST }}.example.com",
                {"HOST": "tenant"},
                "https://api\u3002tenant.example.com",
                id="existing-unicode-label-separator",
            ),
        ],
    )
    def test_hostname_template_preserves_literal_label_syntax(
        self, tmp_path, mitm_ctx, base, vars_map, resolved_base
    ):
        registry_path, cache_path = write_registry_with_cache(
            tmp_path,
            {"10.200.0.1": builtin_sandbox("run-template", "templated", vars_map)},
            {"templated": {"name": "templated", "apis": [{"base": base, "auth": {}}]}},
        )

        with mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            context = registry.get_sandbox_context("10.200.0.1", str(registry_path))

        assert context is not None
        sandbox_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        assert sandbox_info["firewalls"][0]["apis"][0]["base"] == resolved_base

    @pytest.mark.parametrize(
        "raw_json",
        [
            pytest.param("[]", id="array"),
            pytest.param("null", id="null"),
            pytest.param("123", id="number"),
            pytest.param('"text"', id="string"),
        ],
    )
    def test_non_object_runner_catalog_cache_fails_closed(self, tmp_path, mitm_ctx, raw_json):
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        write_trusted_catalog_cache_text(cache_path, raw_json)

        with mitm_ctx():
            snapshot = builtin_firewall_cache.load_catalog_snapshot(str(cache_path))

        assert snapshot.dependency_file_key is not None
        assert snapshot.catalog is None
        assert snapshot.cache_path == str(cache_path.absolute())
        assert snapshot.unavailable_reason == "cache_invalid"

    def test_malformed_runner_catalog_cache_fails_closed(self, tmp_path, mitm_ctx):
        registry_path = tmp_path / "registry.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        write_trusted_catalog_cache_text(cache_path, '{"schemaVersion":1}')
        write_multi_sandbox_registry(
            registry_path,
            {"10.200.0.1": builtin_sandbox("run-fallback", "fallback")},
        )

        _assert_invalid_builtin_sandbox_with_cache(
            registry_path=registry_path,
            cache_path=cache_path,
            mitm_ctx=mitm_ctx,
            expected_message="catalog cache unavailable: cache_invalid",
        )

    def test_empty_api_runner_catalog_cache_fails_closed(self, tmp_path, mitm_ctx):
        registry_path = tmp_path / "registry.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        write_catalog_cache(
            cache_path,
            digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            version="catalog-a",
            firewalls={"fallback": {"name": "fallback", "apis": []}},
        )
        write_multi_sandbox_registry(
            registry_path,
            {"10.200.0.1": builtin_sandbox("run-fallback", "fallback")},
        )

        _assert_invalid_builtin_sandbox_with_cache(
            registry_path=registry_path,
            cache_path=cache_path,
            mitm_ctx=mitm_ctx,
            expected_message="catalog cache unavailable: cache_invalid",
        )

    def test_malformed_static_base_runner_catalog_cache_fails_closed(self, tmp_path, mitm_ctx):
        firewall = cache_firewall("fallback", "https://cache.example.com")
        firewall["apis"][0]["base"] = "not-a-url"
        _assert_cache_firewall_is_invalid(tmp_path, mitm_ctx, firewall)

    @pytest.mark.parametrize(
        "base",
        [
            "https://api.example.com/a/../admin",
            "https://api.example.com/%252e%252e/admin",
            "https://api.example.com/..;version=1/admin",
            "https://api.example.com/%255cadmin",
            "https://api.example.com/v1/../{org}",
            "https://${{ vars.TENANT }}.example.com/v1/../items",
            "${{ vars.API_BASE_URL }}/v1/%2e%2e/items",
        ],
    )
    def test_unsafe_base_runner_catalog_cache_fails_closed(self, tmp_path, mitm_ctx, base):
        firewall = cache_firewall("fallback", base)
        firewall["apis"][0].pop("hostPolicy")

        _assert_cache_firewall_is_invalid(tmp_path, mitm_ctx, firewall)

    def test_malformed_parameterized_base_runner_catalog_cache_fails_closed(
        self, tmp_path, mitm_ctx
    ):
        firewall = cache_firewall("fallback", "https://cache.example.com")
        firewall["apis"][0]["base"] = "https://api.{tenant+}.example.com"
        _assert_cache_firewall_is_invalid(tmp_path, mitm_ctx, firewall)

    def test_malformed_template_base_runner_catalog_cache_fails_closed(self, tmp_path, mitm_ctx):
        firewall = cache_firewall("fallback", "https://cache.example.com")
        firewall["apis"][0]["base"] = "https://${{ secrets.TENANT }}.example.com"
        _assert_cache_firewall_is_invalid(tmp_path, mitm_ctx, firewall)

    def test_python_only_template_whitespace_runner_catalog_cache_fails_closed(
        self, tmp_path, mitm_ctx
    ):
        firewall = cache_firewall("fallback", "https://cache.example.com")
        firewall["apis"][0]["base"] = "https://${{\u0085vars.TENANT\u0085}}.example.com"
        _assert_cache_firewall_is_invalid(tmp_path, mitm_ctx, firewall)

    def test_malformed_template_parameter_base_runner_catalog_cache_fails_closed(
        self, tmp_path, mitm_ctx
    ):
        firewall = cache_firewall("fallback", "https://cache.example.com")
        firewall["apis"][0]["base"] = "https://${{ vars.TENANT }}.{tenant+}.example.com"
        _assert_cache_firewall_is_invalid(tmp_path, mitm_ctx, firewall)

    def test_non_ascii_template_variable_runner_catalog_cache_fails_closed(
        self, tmp_path, mitm_ctx
    ):
        firewall = cache_firewall("fallback", "https://cache.example.com")
        firewall["apis"][0]["base"] = "https://${{ vars.\u00e9 }}.example.com"
        _assert_cache_firewall_is_invalid(tmp_path, mitm_ctx, firewall)

    def test_malformed_auth_base_runner_catalog_cache_fails_closed(self, tmp_path, mitm_ctx):
        firewall = cache_firewall("fallback", "https://cache.example.com")
        firewall["apis"][0]["auth"] = {"base": "http://auth.example.com"}

        _assert_cache_firewall_is_invalid(tmp_path, mitm_ctx, firewall)

    def test_world_writable_runner_catalog_cache_fails_closed(self, tmp_path, mitm_ctx):
        firewall = cache_firewall("fallback", "https://cache.example.com")

        _assert_cache_firewall_is_invalid(
            tmp_path,
            mitm_ctx,
            firewall,
            expected_message="catalog cache unavailable: cache_untrusted",
            cache_mode=0o666,
        )

    def test_world_writable_runner_catalog_cache_reports_untrusted(self, tmp_path, mitm_ctx):
        registry_path = tmp_path / "registry.json"
        cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
        write_catalog_cache(
            cache_path,
            digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            version="catalog-a",
            firewalls={"fallback": cache_firewall("fallback", "https://cache.example.com")},
        )
        cache_path.chmod(0o666)
        write_multi_sandbox_registry(
            registry_path,
            {"10.200.0.1": builtin_sandbox("run-fallback", "fallback")},
        )

        _assert_invalid_builtin_sandbox_with_cache(
            registry_path=registry_path,
            cache_path=cache_path,
            mitm_ctx=mitm_ctx,
            expected_message="catalog cache unavailable: cache_untrusted",
        )

    def test_malformed_aws_sigv4_runner_catalog_cache_fails_closed(self, tmp_path, mitm_ctx):
        firewall = cache_firewall("fallback", "https://cache.example.com")
        del firewall["apis"][0]["auth"]["awsSigv4"]["secretAccessKey"]

        _assert_cache_firewall_is_invalid(tmp_path, mitm_ctx, firewall)

    def test_malformed_host_policy_runner_catalog_cache_fails_closed(self, tmp_path, mitm_ctx):
        firewall = cache_firewall("fallback", "https://cache.example.com")
        firewall["apis"][0]["hostPolicy"] = {
            "kind": "providerOwned",
            "exactHosts": ["127.0.0.1"],
        }

        _assert_cache_firewall_is_invalid(tmp_path, mitm_ctx, firewall)

    def test_malformed_permission_runner_catalog_cache_fails_closed(self, tmp_path, mitm_ctx):
        firewall = cache_firewall("fallback", "https://cache.example.com")
        firewall["apis"][0]["permissions"][0]["rules"] = []

        _assert_cache_firewall_is_invalid(tmp_path, mitm_ctx, firewall)

    @pytest.mark.parametrize("permission_name", ["", "all", "__unknown__"])
    def test_invalid_permission_name_runner_catalog_cache_fails_closed(
        self, tmp_path, mitm_ctx, permission_name
    ):
        firewall = cache_firewall("fallback", "https://cache.example.com")
        firewall["apis"][0]["permissions"][0]["name"] = permission_name
        registry_path, cache_path = write_registry_with_cache(
            tmp_path,
            {"10.200.0.1": builtin_sandbox("run-fallback", "fallback")},
            firewalls={"fallback": firewall},
        )

        with mitm_ctx(
            registry_path=str(registry_path),
            builtin_firewall_catalog_cache_path=str(cache_path),
        ):
            cache_snapshot = builtin_firewall_cache.load_catalog_snapshot(str(cache_path))
            assert cache_snapshot.dependency_file_key is not None
            assert cache_snapshot.catalog is None
            assert cache_snapshot.unavailable_reason == "cache_invalid"

            diagnostic_snapshot = builtin_connector_diagnostics.load_diagnostic_snapshot(
                cache_snapshot
            )
            assert diagnostic_snapshot.catalog_identity is None
            assert diagnostic_snapshot.catalog is None
            assert diagnostic_snapshot.unavailable_reason == "cache_invalid"

            diagnostic_candidate = builtin_connector_diagnostics.find_candidate(
                diagnostic_snapshot,
                "https://cache.example.com/items",
                "GET",
                active_firewall_names=set(),
            )
            assert diagnostic_candidate is None

            invalid_sandbox = assert_invalid_builtin_sandbox(registry_path)
            assert "catalog cache unavailable: cache_invalid" in invalid_sandbox.message

    def test_malformed_rule_runner_catalog_cache_fails_closed(self, tmp_path, mitm_ctx):
        firewall = cache_firewall("fallback", "https://cache.example.com")
        firewall["apis"][0]["permissions"][0]["rules"] = ["GET /items/{path+}/tail"]

        _assert_cache_firewall_is_invalid(tmp_path, mitm_ctx, firewall)
