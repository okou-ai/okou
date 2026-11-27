"""Shared connector-template reference grammar contract tests."""

from pathlib import Path

import pytest

import connector_template_syntax
from tests.contract_cases import contract_case_name, load_named_contract_cases

_CONTRACT_PATH = (
    Path(__file__).resolve().parents[4]
    / "turbo"
    / "packages"
    / "connectors"
    / "src"
    / "__tests__"
    / "firewall-template-reference-contract.json"
)


def _expected_references(case: dict[str, object]) -> list[tuple[str, str, int, int]]:
    template = case["template"]
    assert isinstance(template, str)
    raw_references = case["expectedReferences"]
    assert isinstance(raw_references, list)
    references: list[tuple[str, str, int, int]] = []
    search_start = 0
    for raw_reference in raw_references:
        assert isinstance(raw_reference, dict)
        namespace = raw_reference["namespace"]
        name = raw_reference["name"]
        source = raw_reference["source"]
        assert isinstance(namespace, str)
        assert isinstance(name, str)
        assert isinstance(source, str)
        assert source
        start = template.find(source, search_start)
        assert start != -1
        end = start + len(source)
        references.append((namespace, name, start, end))
        search_start = end
    return references


_SIMPLE_REFERENCE_CASES = load_named_contract_cases(_CONTRACT_PATH, "simpleReferenceCases")


@pytest.mark.parametrize("case", _SIMPLE_REFERENCE_CASES, ids=contract_case_name)
def test_simple_reference_scanner_matches_connector_contract(case: dict[str, object]) -> None:
    template = case["template"]
    assert isinstance(template, str)

    references = tuple(connector_template_syntax.iter_simple_references(template))

    assert [
        (reference.namespace, reference.name, reference.start, reference.end)
        for reference in references
    ] == _expected_references(case)
