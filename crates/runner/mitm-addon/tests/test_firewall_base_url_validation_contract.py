"""Shared firewall base URL validation contract tests."""

from pathlib import Path

import pytest

import builtin_base_url
import builtin_firewall_cache
import matching
from tests.contract_cases import contract_case_name, load_named_contract_cases
from tests.registry_builtin_helpers import write_catalog_cache

_CONTRACT_PATH = (
    Path(__file__).resolve().parents[4]
    / "turbo"
    / "packages"
    / "connectors"
    / "src"
    / "__tests__"
    / "firewall-base-url-validation-contract.json"
)


_BASE_URL_VALIDATION_CASES = load_named_contract_cases(_CONTRACT_PATH, "baseUrlValidationCases")
_CATALOG_BASE_URL_VALIDATION_CASES = load_named_contract_cases(
    _CONTRACT_PATH, "catalogBaseUrlValidationCases"
)
_BASE_URL_TEMPLATE_RESOLUTION_CASES = load_named_contract_cases(
    _CONTRACT_PATH, "baseUrlTemplateResolutionCases"
)


@pytest.mark.parametrize("case", _BASE_URL_VALIDATION_CASES, ids=contract_case_name)
def test_firewall_base_url_config_validity_matches_shared_contract(
    case: dict[str, object],
) -> None:
    base = case["base"]
    assert isinstance(base, str)
    expected_valid = case["expectedValid"]
    assert isinstance(expected_valid, bool)

    assert matching.firewall_base_config_is_valid(base) is expected_valid


@pytest.mark.parametrize("case", _CATALOG_BASE_URL_VALIDATION_CASES, ids=contract_case_name)
def test_firewall_catalog_base_url_validity_matches_shared_contract(
    case: dict[str, object],
    tmp_path: Path,
    mitm_ctx,
) -> None:
    base = case["base"]
    assert isinstance(base, str)
    expected_valid = case["expectedValid"]
    assert isinstance(expected_valid, bool)
    raw_vars = case["vars"]
    assert isinstance(raw_vars, dict)
    vars_map: dict[str, str] = {}
    for name, value in raw_vars.items():
        assert isinstance(name, str)
        assert isinstance(value, str)
        vars_map[name] = value
    expected_resolved_base = case["expectedResolvedBase"]
    assert expected_resolved_base is None or isinstance(expected_resolved_base, str)

    cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
    write_catalog_cache(
        cache_path,
        digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        version="catalog-contract",
        firewalls={
            "contract": {
                "name": "contract",
                "apis": [{"base": base, "auth": {}}],
            }
        },
    )
    with mitm_ctx():
        snapshot = builtin_firewall_cache.load_catalog_snapshot(str(cache_path))

    assert (snapshot.catalog is not None) is expected_valid
    assert snapshot.unavailable_reason == (None if expected_valid else "cache_invalid")

    if expected_resolved_base is None:
        with pytest.raises(builtin_base_url.BuiltinBaseUrlResolutionError):
            builtin_base_url.resolve_base_url_template(
                firewall_name="contract",
                base=base,
                vars_map=vars_map,
            )
        return

    assert (
        builtin_base_url.resolve_base_url_template(
            firewall_name="contract",
            base=base,
            vars_map=vars_map,
        )
        == expected_resolved_base
    )


@pytest.mark.parametrize("case", _BASE_URL_TEMPLATE_RESOLUTION_CASES, ids=contract_case_name)
def test_firewall_base_url_template_resolution_matches_shared_contract(
    case: dict[str, object],
    tmp_path: Path,
    mitm_ctx,
) -> None:
    base = case["base"]
    assert isinstance(base, str)
    raw_vars = case["vars"]
    assert isinstance(raw_vars, dict)
    vars_map: dict[str, str] = {}
    for name, value in raw_vars.items():
        assert isinstance(name, str)
        assert isinstance(value, str)
        vars_map[name] = value
    expected_resolved_base = case["expectedResolvedBase"]
    assert expected_resolved_base is None or isinstance(expected_resolved_base, str)

    if expected_resolved_base is None:
        with pytest.raises(builtin_base_url.BuiltinBaseUrlResolutionError):
            builtin_base_url.resolve_base_url_template(
                firewall_name="contract",
                base=base,
                vars_map=vars_map,
            )
        return

    assert (
        builtin_base_url.resolve_base_url_template(
            firewall_name="contract",
            base=base,
            vars_map=vars_map,
        )
        == expected_resolved_base
    )

    cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
    write_catalog_cache(
        cache_path,
        digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        version="catalog-contract",
        firewalls={
            "contract": {
                "name": "contract",
                "apis": [{"base": base, "auth": {}}],
            }
        },
    )
    with mitm_ctx():
        snapshot = builtin_firewall_cache.load_catalog_snapshot(str(cache_path))

    assert snapshot.catalog is not None
    assert snapshot.unavailable_reason is None
