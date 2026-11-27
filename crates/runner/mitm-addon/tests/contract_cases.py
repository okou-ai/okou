"""Load named test cases from shared JSON contract fixtures."""

import json
from pathlib import Path


def contract_case_name(case: dict[str, object]) -> str:
    name = case["name"]
    assert isinstance(name, str)
    return name


def load_named_contract_cases(path: Path, key: str) -> list[dict[str, object]]:
    raw_contract = json.loads(path.read_text(encoding="utf-8"))
    assert isinstance(raw_contract, dict)
    cases = raw_contract[key]
    assert isinstance(cases, list)
    assert cases
    assert all(isinstance(case, dict) for case in cases)
    names = [contract_case_name(case) for case in cases]
    assert len(names) == len(set(names))
    return cases
