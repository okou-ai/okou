"""Shared firewall semantics contract tests."""

import json
from pathlib import Path

import pytest

import connector_intent
import matching
from firewall_matching.patterns import _split_path_segments

_CONTRACT_PATH = (
    Path(__file__).resolve().parents[4]
    / "turbo"
    / "packages"
    / "connectors"
    / "src"
    / "__tests__"
    / "firewall-semantics-contract.json"
)


def _contract_cases(raw_contract: dict[str, object], key: str) -> list[dict[str, object]]:
    cases = raw_contract[key]
    assert isinstance(cases, list)
    assert all(isinstance(case, dict) for case in cases)
    return cases


def _load_cases() -> tuple[
    list[dict[str, object]],
    list[dict[str, object]],
    list[dict[str, object]],
    list[dict[str, object]],
    list[dict[str, object]],
    list[dict[str, object]],
    list[dict[str, object]],
    list[dict[str, object]],
]:
    raw_contract = json.loads(_CONTRACT_PATH.read_text())
    assert isinstance(raw_contract, dict)

    return (
        _contract_cases(raw_contract, "awsRuleValidationCases"),
        _contract_cases(raw_contract, "segmentParseCases"),
        _contract_cases(raw_contract, "pathSplitCases"),
        _contract_cases(raw_contract, "pathMatchCases"),
        _contract_cases(raw_contract, "hostMatchCases"),
        _contract_cases(raw_contract, "pathPrefixMatchCases"),
        _contract_cases(raw_contract, "baseUrlMatchCases"),
        _contract_cases(raw_contract, "finalDecisionCases"),
    )


def _case_name(case: dict[str, object]) -> str:
    name = case["name"]
    assert isinstance(name, str)
    return name


def _expected_kind(expected: dict[str, object]) -> str:
    kind = expected["kind"]
    assert isinstance(kind, str)
    return kind


def _relative_path_from_segments(segments: list[str], consumed: int) -> str:
    rest = "/".join(segments[consumed:])
    return "/" if rest == "" else f"/{rest}"


def _assert_params_match(
    actual: dict[str, str] | None,
    expected: dict[str, object],
) -> None:
    if _expected_kind(expected) == "no-match":
        assert actual is None
        return

    params = expected["params"]
    assert isinstance(params, dict)
    assert all(isinstance(key, str) for key in params)
    assert all(isinstance(value, str) for value in params.values())
    assert actual == params


def _assert_relative_path_match(
    actual: str | None,
    expected: dict[str, object],
) -> None:
    if _expected_kind(expected) == "no-match":
        assert actual is None
        return

    relative_path = expected["relativePath"]
    assert isinstance(relative_path, str)
    assert actual == relative_path


(
    _AWS_RULE_VALIDATION_CASES,
    _SEGMENT_PARSE_CASES,
    _PATH_SPLIT_CASES,
    _PATH_MATCH_CASES,
    _HOST_MATCH_CASES,
    _PATH_PREFIX_MATCH_CASES,
    _BASE_URL_MATCH_CASES,
    _FINAL_DECISION_CASES,
) = _load_cases()


@pytest.mark.parametrize("case", _AWS_RULE_VALIDATION_CASES, ids=_case_name)
def test_aws_rule_validation_matches_shared_contract(case: dict[str, object]):
    rule = case["rule"]
    assert isinstance(rule, str)
    valid = case["valid"]
    assert isinstance(valid, bool)

    assert matching.firewall_rule_is_valid(rule) is valid


def _normalize_final_decision(result: object | None) -> dict[str, object]:
    if result is None:
        return {"kind": "no_match"}
    if isinstance(result, matching.FirewallAllow):
        base = result.api_entry["base"]
        assert isinstance(base, str)
        normalized: dict[str, object] = {
            "kind": "allow",
            "firewallName": result.name,
            "base": base,
            "relativePath": result.rel_path,
        }
        if result.permission is not None:
            normalized["permission"] = result.permission
        if result.rule is not None:
            normalized["rule"] = result.rule
        return normalized
    if isinstance(result, matching.FirewallBlock):
        return {
            "kind": "block",
            "firewallName": result.name,
            "base": result.base,
            "relativePath": result.path,
            "reason": result.reason,
            "permissions": list(result.permissions),
        }
    if isinstance(result, matching.FirewallAmbiguous):
        return {
            "kind": "ambiguous",
            "method": result.method,
            "path": result.path,
            "candidates": list(result.candidates),
            "reason": result.reason,
        }
    raise TypeError(f"unexpected firewall decision result: {result!r}")


@pytest.mark.parametrize("case", _SEGMENT_PARSE_CASES, ids=_case_name)
def test_segment_parsing_matches_shared_contract(case: dict[str, object]):
    segment = case["segment"]
    assert isinstance(segment, str)

    expected = case["expected"]
    assert isinstance(expected, dict)

    actual = matching.parse_segment(segment)
    expected_kind = expected["kind"]
    assert isinstance(expected_kind, str)

    if expected_kind == "error":
        assert actual["kind"] == "error"
        reason_includes = expected["reasonIncludes"]
        assert isinstance(reason_includes, str)
        reason = actual["reason"]
        assert isinstance(reason, str)
        assert reason_includes in reason
        return

    assert actual == expected


@pytest.mark.parametrize("case", _PATH_SPLIT_CASES, ids=_case_name)
def test_path_splitting_matches_shared_contract(case: dict[str, object]):
    path = case["path"]
    assert isinstance(path, str)

    expected = case["expected"]
    assert isinstance(expected, list)
    assert all(isinstance(segment, str) for segment in expected)

    assert _split_path_segments(path) == expected


@pytest.mark.parametrize("case", _PATH_MATCH_CASES, ids=_case_name)
def test_path_matching_matches_shared_contract(case: dict[str, object]):
    path = case["path"]
    assert isinstance(path, str)
    pattern = case["pattern"]
    assert isinstance(pattern, str)

    expected = case["expected"]
    assert isinstance(expected, dict)

    _assert_params_match(matching.match_path(path, pattern), expected)


@pytest.mark.parametrize("case", _HOST_MATCH_CASES, ids=_case_name)
def test_host_matching_matches_shared_contract(case: dict[str, object]):
    host = case["host"]
    assert isinstance(host, str)
    pattern = case["pattern"]
    assert isinstance(pattern, str)

    expected = case["expected"]
    assert isinstance(expected, dict)

    _assert_params_match(matching.match_host(host, pattern), expected)


@pytest.mark.parametrize("case", _PATH_PREFIX_MATCH_CASES, ids=_case_name)
def test_path_prefix_matching_matches_shared_contract(case: dict[str, object]):
    path = case["path"]
    assert isinstance(path, str)
    pattern = case["pattern"]
    assert isinstance(pattern, str)

    expected = case["expected"]
    assert isinstance(expected, dict)

    path_segments = _split_path_segments(path)
    pattern_segments = _split_path_segments(pattern)
    result = matching.match_path_prefix(path_segments, pattern_segments)
    actual_relative_path = (
        None if result is None else _relative_path_from_segments(path_segments, result[1])
    )
    _assert_relative_path_match(actual_relative_path, expected)


@pytest.mark.parametrize("case", _BASE_URL_MATCH_CASES, ids=_case_name)
def test_base_url_matching_matches_shared_contract(case: dict[str, object]):
    url = case["url"]
    assert isinstance(url, str)
    base = case["base"]
    assert isinstance(base, str)

    expected = case["expected"]
    assert isinstance(expected, dict)

    result = matching.match_base_url(url, base)
    actual_relative_path = None if result is None else result[0]
    _assert_relative_path_match(actual_relative_path, expected)


@pytest.mark.parametrize("case", _FINAL_DECISION_CASES, ids=_case_name)
def test_final_decision_matches_shared_contract(case: dict[str, object]):
    firewalls = case["firewalls"]
    request = case["request"]
    assert isinstance(request, dict)
    method = request["method"]
    assert isinstance(method, str)
    url = request["url"]
    assert isinstance(url, str)
    expected = case["expected"]
    assert isinstance(expected, dict)

    raw_intent = request.get("connectorIntent")
    intent = connector_intent.ABSENT
    if isinstance(raw_intent, dict):
        status = raw_intent.get("status")
        if status == "malformed":
            intent = connector_intent.MALFORMED
        elif status == "present":
            value = raw_intent.get("value")
            assert isinstance(value, str)
            intent = connector_intent.ConnectorIntent("present", value)

    compiled_firewalls = matching.compile_firewalls(firewalls)
    result = matching.match_compiled_firewall_request(
        url,
        method,
        compiled_firewalls,
        case.get("networkPolicies"),
        intent,
    )

    assert _normalize_final_decision(result) == expected
