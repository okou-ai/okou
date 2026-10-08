"""Tests for server-catalog connector diagnostic URL classification."""

import json
from pathlib import Path

import pytest

import builtin_connector_diagnostics
import builtin_firewall_cache

_TEMPLATE_CONTRACT_PATH = (
    Path(__file__).resolve().parents[4]
    / "turbo"
    / "packages"
    / "connectors"
    / "src"
    / "__tests__"
    / "firewall-template-reference-contract.json"
)


def _contract_case_name(case: dict[str, object]) -> str:
    name = case["name"]
    assert isinstance(name, str)
    return name


def _load_basic_template_cases() -> list[dict[str, object]]:
    raw_contract = json.loads(_TEMPLATE_CONTRACT_PATH.read_text(encoding="utf-8"))
    assert isinstance(raw_contract, dict)
    cases = raw_contract["basicTemplateCases"]
    assert isinstance(cases, list)
    assert cases
    assert all(isinstance(case, dict) for case in cases)
    return cases


_BASIC_TEMPLATE_CASES = _load_basic_template_cases()

_TEST_FILE_KEY = builtin_firewall_cache.CatalogFileKey(
    absolute_path="/test/catalog.json",
    st_dev=1,
    st_ino=1,
    st_mtime_ns=1,
    st_size=1,
)


def _firewall(
    name: str,
    token_name: str,
    *,
    permissions: list[dict] | None = None,
    base: str = "https://shared.example.com",
    auth: dict | None = None,
) -> dict:
    resolved_auth = (
        {
            "headers": {
                "Authorization": f"Bearer ${{{{ secrets.{token_name} }}}}",
            }
        }
        if auth is None
        else auth
    )
    return {
        "name": name,
        "apis": [
            {
                "base": base,
                "auth": resolved_auth,
                "permissions": permissions or [],
            }
        ],
    }


def _diagnostic_snapshot(
    firewalls: list[dict],
) -> builtin_connector_diagnostics.DiagnosticCatalogSnapshot:
    raw_snapshot = builtin_firewall_cache.BuiltinFirewallCatalogSnapshot(
        dependency_file_key=_TEST_FILE_KEY,
        catalog=builtin_firewall_cache.BuiltinFirewallCatalog(
            identity=builtin_firewall_cache.CatalogIdentity(
                source="cache",
                catalog_digest="sha256:" + "0" * 64,
                catalog_version="test",
                file_key=_TEST_FILE_KEY,
            ),
            firewalls={firewall["name"]: firewall for firewall in firewalls},
        ),
        cache_path=_TEST_FILE_KEY.absolute_path,
    )
    return builtin_connector_diagnostics._compile_diagnostic_snapshot(raw_snapshot)


def test_classifies_static_connector_without_permission_method_enforcement():
    snapshot = _diagnostic_snapshot(
        [
            _firewall(
                "catalog-connector",
                "SERVICE_TOKEN",
                base="https://service.example.com/api",
                auth={
                    "headers": {
                        "Authorization": "Bearer ${{ secrets.SERVICE_TOKEN }}",
                    },
                    "query": {"tenant": "${{ vars.TENANT_ID }}"},
                },
                permissions=[{"name": "read", "rules": ["GET /items/{id}"]}],
            )
        ]
    )

    candidate = builtin_connector_diagnostics.find_candidate(
        snapshot,
        "https://service.example.com/api/unlisted",
        "POST",
        active_firewall_names=set(),
    )

    assert candidate == builtin_connector_diagnostics.ConnectorDiagnosticCandidate(
        connector_slug="catalog-connector",
        reason="not_configured_for_run",
        env_names=("SERVICE_TOKEN", "TENANT_ID"),
        base="https://service.example.com/api",
        auth_header_names=("Authorization",),
        auth_query_param_names=("tenant",),
    )


def test_skips_active_connector_name():
    snapshot = _diagnostic_snapshot(
        [_firewall("active", "ACTIVE_TOKEN", base="https://active.example.com")]
    )

    candidate = builtin_connector_diagnostics.find_candidate(
        snapshot,
        "https://active.example.com/items",
        "GET",
        active_firewall_names={"active"},
    )

    assert candidate is None


def test_classifies_static_base_with_literal_unbalanced_brace():
    snapshot = _diagnostic_snapshot(
        [
            _firewall(
                "literal-brace",
                "LITERAL_BRACE_TOKEN",
                base="https://literal.example.com/{literal",
            )
        ]
    )

    candidate = builtin_connector_diagnostics.find_candidate(
        snapshot,
        "https://literal.example.com/{literal/item",
        "GET",
        active_firewall_names=set(),
    )

    assert candidate is not None
    assert candidate.connector_slug == "literal-brace"
    assert candidate.env_names == ("LITERAL_BRACE_TOKEN",)


def test_skips_parameterized_catalog_base_urls():
    snapshot = _diagnostic_snapshot(
        [
            _firewall(
                "parameterized",
                "PARAMETERIZED_TOKEN",
                base="https://parameterized.example.com/{tenant}",
            )
        ]
    )

    candidate = builtin_connector_diagnostics.find_candidate(
        snapshot,
        "https://parameterized.example.com/acme/item",
        "GET",
        active_firewall_names=set(),
    )

    assert candidate is None


def test_skips_static_connector_without_injectable_auth_references():
    snapshot = _diagnostic_snapshot(
        [
            _firewall(
                "literal-auth",
                "UNUSED_TOKEN",
                base="https://literal-auth.example.com",
                auth={"headers": {"Authorization": "Bearer fixed"}},
            )
        ]
    )

    candidate = builtin_connector_diagnostics.find_candidate(
        snapshot,
        "https://literal-auth.example.com/items",
        "GET",
        active_firewall_names=set(),
    )

    assert candidate is None


def test_skips_static_connector_with_reference_looking_basic_literals():
    snapshot = _diagnostic_snapshot(
        [
            _firewall(
                "literal-auth",
                "UNUSED_TOKEN",
                base="https://literal-auth.example.com",
                auth={
                    "headers": {
                        "Authorization": '${{ basic("secrets.FAKE", "vars.FAKE") }}',
                        "X-Bare": "secrets.BARE vars.BARE",
                        "X-Nested": (
                            '${{ basic("${{ secrets.NESTED_FAKE }}", "${{ vars.NESTED_FAKE }}") }}'
                        ),
                    }
                },
            )
        ]
    )

    candidate = builtin_connector_diagnostics.find_candidate(
        snapshot,
        "https://literal-auth.example.com/items",
        "GET",
        active_firewall_names=set(),
    )

    assert candidate is None


def test_classifies_mixed_basic_auth_with_only_real_references():
    snapshot = _diagnostic_snapshot(
        [
            _firewall(
                "mixed-auth",
                "UNUSED_TOKEN",
                base="https://mixed-auth.example.com",
                auth={
                    "headers": {
                        "Authorization": '${{ basic("secrets.FAKE", secrets.REAL_TOKEN) }}',
                        "X-Bare": "secrets.BARE",
                        "X-Nested": (
                            '${{ basic("${{ secrets.NESTED_FAKE }}", secrets.REAL_TOKEN) }}'
                        ),
                        "X-Second": '${{\t basic(vars.REAL_USER, "vars.FAKE") \r}}',
                        "X-Simple": "Bearer ${{ vars.SIMPLE_VAR }}",
                    }
                },
            )
        ]
    )

    candidate = builtin_connector_diagnostics.find_candidate(
        snapshot,
        "https://mixed-auth.example.com/items",
        "GET",
        active_firewall_names=set(),
    )

    assert candidate is not None
    assert candidate.env_names == ("REAL_TOKEN", "REAL_USER", "SIMPLE_VAR")


def test_diagnostic_simple_references_use_ecmascript_whitespace():
    snapshot = _diagnostic_snapshot(
        [
            _firewall(
                "whitespace-auth",
                "UNUSED_TOKEN",
                base="https://whitespace-auth.example.com",
                auth={
                    "headers": {
                        "X-Ecma": "${{\ufeffsecrets.ECMA_TOKEN\ufeff}}",
                        "X-Python": "${{\u0085secrets.PYTHON_TOKEN\u0085}}",
                    }
                },
            )
        ]
    )

    candidate = builtin_connector_diagnostics.find_candidate(
        snapshot,
        "https://whitespace-auth.example.com/items",
        "GET",
        active_firewall_names=set(),
    )

    assert candidate is not None
    assert candidate.env_names == ("ECMA_TOKEN",)


@pytest.mark.parametrize("case", _BASIC_TEMPLATE_CASES, ids=_contract_case_name)
def test_diagnostic_basic_templates_match_connector_contract(case: dict[str, object]) -> None:
    template = case["template"]
    expected_names = case["expectedDiagnosticNames"]
    assert isinstance(template, str)
    assert isinstance(expected_names, list)
    assert all(isinstance(name, str) for name in expected_names)
    snapshot = _diagnostic_snapshot(
        [
            _firewall(
                "template-contract",
                "UNUSED_TOKEN",
                base="https://template-contract.example.com",
                auth={"headers": {"Authorization": template}},
            )
        ]
    )

    candidate = builtin_connector_diagnostics.find_candidate(
        snapshot,
        "https://template-contract.example.com/items",
        "GET",
        active_firewall_names=set(),
    )

    if not expected_names:
        assert candidate is None
        return
    assert candidate is not None
    assert candidate.env_names == tuple(expected_names)


def test_malformed_basic_auth_keeps_later_valid_templates_visible():
    snapshot = _diagnostic_snapshot(
        [
            _firewall(
                "malformed-auth",
                "UNUSED_TOKEN",
                base="https://malformed-auth.example.com",
                auth={
                    "headers": {
                        "Authorization": (
                            'prefix ${{ basic("unterminated '
                            "${{ basic(secrets.USER, secrets.PASS) }}"
                        ),
                        "X-Escaped": (
                            'prefix ${{ basic("bad '
                            "${{ basic(secrets.USER, secrets.PASS) }}"
                            '\\", secrets.SKIP) }}'
                        ),
                        "X-Long": "${{ basic(" + "\t" * 20_000,
                        "X-Repeated": ('${{ basic("' + "\t" * 20) * 1_000,
                    }
                },
            )
        ]
    )

    candidate = builtin_connector_diagnostics.find_candidate(
        snapshot,
        "https://malformed-auth.example.com/items",
        "GET",
        active_firewall_names=set(),
    )

    assert candidate is not None
    assert candidate.env_names == ("USER", "PASS")


def test_model_provider_route_excludes_connector_on_same_host():
    snapshot = _diagnostic_snapshot(
        [
            _firewall(
                "catalog-connector",
                "CONNECTOR_TOKEN",
                base="https://provider.example.com",
                permissions=[{"name": "agents", "rules": ["GET /v1/agents"]}],
            ),
            _firewall(
                "model-provider:synthetic",
                "PROVIDER_TOKEN",
                base="https://provider.example.com",
                permissions=[{"name": "messages", "rules": ["POST /v1/messages"]}],
            ),
        ]
    )

    excluded = builtin_connector_diagnostics.find_candidate(
        snapshot,
        "https://provider.example.com/v1/messages",
        "POST",
        active_firewall_names=set(),
    )
    connector = builtin_connector_diagnostics.find_candidate(
        snapshot,
        "https://provider.example.com/v1/agents",
        "GET",
        active_firewall_names=set(),
    )

    assert excluded is None
    assert connector is not None
    assert connector.connector_slug == "catalog-connector"


def test_find_candidate_suppresses_shared_base_only_candidates():
    snapshot = _diagnostic_snapshot(
        [
            _firewall("first", "FIRST_TOKEN"),
            _firewall("second", "SECOND_TOKEN"),
        ]
    )

    candidate = builtin_connector_diagnostics.find_candidate(
        snapshot,
        "https://shared.example.com/messages/123",
        "GET",
        active_firewall_names=set(),
    )

    assert candidate is None


def test_literal_only_connector_does_not_create_shared_base_ambiguity():
    snapshot = _diagnostic_snapshot(
        [
            _firewall("credentialed", "REAL_TOKEN"),
            _firewall(
                "literal-only",
                "UNUSED_TOKEN",
                auth={
                    "headers": {
                        "Authorization": '${{ basic("secrets.FAKE", "fixed") }}',
                    }
                },
            ),
        ]
    )

    candidate = builtin_connector_diagnostics.find_candidate(
        snapshot,
        "https://shared.example.com/messages/123",
        "GET",
        active_firewall_names=set(),
    )

    assert candidate is not None
    assert candidate.connector_slug == "credentialed"
    assert candidate.env_names == ("REAL_TOKEN",)


def test_find_candidate_selects_unique_shared_base_route_owner():
    snapshot = _diagnostic_snapshot(
        [
            _firewall("active", "ACTIVE_TOKEN"),
            _firewall(
                "inactive",
                "INACTIVE_TOKEN",
                auth={
                    "headers": {
                        "X-Inactive-Token": "${{ secrets.INACTIVE_HEADER_TOKEN }}",
                    },
                    "query": {
                        "inactive_token": "${{ secrets.INACTIVE_QUERY_TOKEN }}",
                    },
                },
                permissions=[{"name": "read", "rules": ["GET /messages/{id}"]}],
            ),
        ]
    )

    candidate = builtin_connector_diagnostics.find_candidate(
        snapshot,
        "https://shared.example.com/messages/123",
        "GET",
        active_firewall_names={"active"},
    )

    assert candidate == builtin_connector_diagnostics.ConnectorDiagnosticCandidate(
        connector_slug="inactive",
        reason="not_configured_for_run",
        env_names=("INACTIVE_HEADER_TOKEN", "INACTIVE_QUERY_TOKEN"),
        base="https://shared.example.com",
        auth_header_names=("X-Inactive-Token",),
        auth_query_param_names=("inactive_token",),
    )


def test_find_candidate_suppresses_multiple_shared_base_route_owners():
    snapshot = _diagnostic_snapshot(
        [
            _firewall(
                "first",
                "FIRST_TOKEN",
                permissions=[{"name": "read", "rules": ["GET /messages/{id}"]}],
            ),
            _firewall(
                "second",
                "SECOND_TOKEN",
                permissions=[{"name": "read", "rules": ["GET /messages/{id}"]}],
            ),
        ]
    )

    candidate = builtin_connector_diagnostics.find_candidate(
        snapshot,
        "https://shared.example.com/messages/123",
        "GET",
        active_firewall_names=set(),
    )

    assert candidate is None


def test_find_candidate_distinguishes_repeated_slash_bases():
    permissions = [{"name": "read", "rules": ["GET /{path+}"]}]
    snapshot = _diagnostic_snapshot(
        [
            _firewall(
                "broader",
                "BROADER_TOKEN",
                base="https://api.example.com/v1",
                permissions=permissions,
            ),
            _firewall(
                "repeated",
                "REPEATED_TOKEN",
                base="https://api.example.com/v1//",
                permissions=permissions,
            ),
        ]
    )

    candidate = builtin_connector_diagnostics.find_candidate(
        snapshot,
        "https://api.example.com/v1//foo",
        "GET",
        active_firewall_names=set(),
    )

    assert candidate == builtin_connector_diagnostics.ConnectorDiagnosticCandidate(
        connector_slug="repeated",
        reason="not_configured_for_run",
        env_names=("REPEATED_TOKEN",),
        base="https://api.example.com/v1//",
        auth_header_names=("Authorization",),
        auth_query_param_names=(),
    )


def test_shared_base_ownership_selects_route_specific_inactive_sibling():
    snapshot = _diagnostic_snapshot(
        [
            _firewall(
                "active",
                "ACTIVE_TOKEN",
                permissions=[{"name": "read", "rules": ["GET /active/{id}"]}],
            ),
            _firewall(
                "inactive",
                "INACTIVE_TOKEN",
                permissions=[{"name": "read", "rules": ["GET /messages/{id}"]}],
            ),
        ]
    )

    resolution = builtin_connector_diagnostics.resolve_shared_base_ownership(
        snapshot,
        "https://shared.example.com/messages/123",
        "GET",
        active_firewall_names={"active"},
        matched_firewall_name="active",
    )

    assert resolution is not None
    assert resolution.reason == "route_owner"
    assert resolution.candidate is not None
    assert resolution.candidate.connector_slug == "inactive"


def test_shared_base_ownership_suppresses_base_only_candidate():
    snapshot = _diagnostic_snapshot(
        [
            _firewall("active", "ACTIVE_TOKEN"),
            _firewall("inactive", "INACTIVE_TOKEN"),
        ]
    )

    resolution = builtin_connector_diagnostics.resolve_shared_base_ownership(
        snapshot,
        "https://shared.example.com/messages/123",
        "GET",
        active_firewall_names={"active"},
        matched_firewall_name="active",
    )

    assert resolution is not None
    assert resolution.candidate is None
    assert resolution.reason == "base_only"


def test_shared_base_active_route_owner_suppresses_inactive_diagnostic():
    snapshot = _diagnostic_snapshot(
        [
            _firewall(
                "active",
                "ACTIVE_TOKEN",
                permissions=[{"name": "read", "rules": ["GET /active/{id}"]}],
            ),
            _firewall("inactive", "INACTIVE_TOKEN"),
        ]
    )

    resolution = builtin_connector_diagnostics.resolve_shared_base_ownership(
        snapshot,
        "https://shared.example.com/active/123",
        "GET",
        active_firewall_names={"active"},
        matched_firewall_name="active",
    )

    assert resolution is not None
    assert resolution.candidate is None
    assert resolution.reason == "active_route_owner"


def test_shared_base_ownership_normalizes_static_base_keys():
    snapshot = _diagnostic_snapshot(
        [
            _firewall(
                "active",
                "ACTIVE_TOKEN",
                base="https://Shared.Example.com.:443/api/",
                permissions=[{"name": "read", "rules": ["GET /active/{id}"]}],
            ),
            _firewall(
                "inactive",
                "INACTIVE_TOKEN",
                base="https://shared.example.com/api",
                permissions=[{"name": "read", "rules": ["GET /messages/{id}"]}],
            ),
        ]
    )

    resolution = builtin_connector_diagnostics.resolve_shared_base_ownership(
        snapshot,
        "https://shared.example.com/api/messages/123",
        "GET",
        active_firewall_names={"active"},
        matched_firewall_name="active",
    )

    assert resolution is not None
    assert resolution.reason == "route_owner"
    assert resolution.candidate is not None
    assert resolution.candidate.connector_slug == "inactive"
