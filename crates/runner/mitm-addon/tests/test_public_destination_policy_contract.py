"""Shared public destination address policy contract tests."""

from pathlib import Path

import pytest

import public_destination
from tests.contract_cases import contract_case_name, load_named_contract_cases

_CONTRACT_PATH = (
    Path(__file__).resolve().parents[4]
    / "turbo"
    / "packages"
    / "connectors"
    / "src"
    / "__tests__"
    / "public-destination-policy-contract.json"
)


_ADDRESS_POLICY_CASES = load_named_contract_cases(_CONTRACT_PATH, "addressPolicyCases")


@pytest.mark.parametrize("case", _ADDRESS_POLICY_CASES, ids=contract_case_name)
def test_public_destination_address_policy_matches_shared_contract(
    case: dict[str, object],
) -> None:
    address = case["address"]
    assert isinstance(address, str)
    expected_public = case["expectedPublic"]
    assert isinstance(expected_public, bool)

    assert public_destination.public_ip_literal_is_public(address) is expected_public
