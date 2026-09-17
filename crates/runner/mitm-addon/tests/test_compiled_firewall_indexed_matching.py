"""Indexed compiled firewall matcher compatibility and scan guardrails."""

import hashlib
import json
from copy import deepcopy
from functools import partial
from itertools import product

import pytest

import connector_intent
import matching
import path_security
from firewall_matching import base_url as firewall_base_url
from firewall_matching import patterns as firewall_patterns
from tests.firewall_helpers import (
    compile_firewalls_or_fail,
    firewall_api,
    firewall_entry,
    firewall_permission,
    network_policy,
    wrap_firewalls,
)


def _assert_indexed_matches_linear(
    url,
    method,
    firewalls,
    network_policies,
    intent=None,
    *,
    is_asterisk_form=False,
):
    compiled = compile_firewalls_or_fail(firewalls)

    indexed = matching.match_compiled_firewall_request(
        url,
        method,
        compiled,
        network_policies,
        intent,
        is_asterisk_form=is_asterisk_form,
    )
    linear = matching._match_compiled_firewall_request_linear(
        url,
        method,
        compiled,
        network_policies,
        intent,
        is_asterisk_form=is_asterisk_form,
    )

    assert indexed == linear
    return indexed


_GENERATED_CASE_SEED = 28934
_GENERATED_CASE_COUNT = 256
_GENERATED_AXIS_VALUES = (
    (
        "base",
        (
            "static-root",
            "static-nested",
            "parameterized-host",
            "repeated-slash",
        ),
    ),
    (
        "topology",
        (
            "single-owner",
            "unrelated-owner",
            "unrelated-api",
            "overlapping-api",
            "shared-owner",
            "shared-owner-with-unrelated-api",
        ),
    ),
    (
        "rule",
        (
            "literal",
            "segment-parameter",
            "mixed-parameter",
            "greedy-parameter",
            "any-before-exact",
            "competing-specificity",
        ),
    ),
    (
        "policy",
        (
            "allow-permissions",
            "deny-permissions",
            "ask-permissions",
            "unknown-allow",
            "unknown-deny",
            "unknown-ask",
            "absent",
            "malformed-permissions",
        ),
    ),
    (
        "request",
        (
            "matching",
            "lowercase-method",
            "method-mismatch",
            "unknown-path",
            "unmatched-authority",
            "encoded-slash",
            "unsafe-path",
            "asterisk-form",
        ),
    ),
    (
        "intent",
        (
            "absent",
            "target-owner",
            "non-candidate",
            "malformed",
        ),
    ),
    (
        "malformed",
        (
            "none",
            "auth",
            "rule",
            "base",
            "firewall-name",
        ),
    ),
)

_GENERATED_BASES = {
    "static-root": ("https://api.example.com", "https://api.example.com"),
    "static-nested": ("https://api.example.com/v1", "https://api.example.com/v1"),
    "parameterized-host": (
        "https://{tenant}.example.com/v1",
        "https://acme.example.com/v1",
    ),
    "repeated-slash": ("https://api.example.com//v1", "https://api.example.com//v1"),
}

_GENERATED_INTENTS = {
    "absent": connector_intent.ABSENT,
    "target-owner": connector_intent.ConnectorIntent("present", "target"),
    "non-candidate": connector_intent.ConnectorIntent("present", "missing"),
    "malformed": connector_intent.MALFORMED,
}


def _generated_position_key(axis_salt, position):
    # A stable hash permutation is reproducible without random.Random, which
    # the add-on's security lint correctly rejects through S311. The even axis
    # salts make this committed 256-row corpus pairwise-complete; the coverage
    # assertion below guards that property if the axes change.
    payload = f"{_GENERATED_CASE_SEED}:{axis_salt}:{position}".encode()
    return hashlib.sha256(payload).digest()


def _generated_variant_rows():
    decks = []
    for axis_index, (_axis_name, values) in enumerate(_GENERATED_AXIS_VALUES):
        repeat_count = (_GENERATED_CASE_COUNT + len(values) - 1) // len(values)
        balanced_values = (values * repeat_count)[:_GENERATED_CASE_COUNT]
        positions = list(range(_GENERATED_CASE_COUNT))
        positions.sort(key=partial(_generated_position_key, (axis_index + 1) * 2))
        decks.append(tuple(balanced_values[position] for position in positions))
    return tuple(zip(*decks, strict=True))


def _assert_generated_pairwise_coverage(variant_rows):
    for left_index, (left_name, left_values) in enumerate(_GENERATED_AXIS_VALUES):
        for right_index in range(left_index + 1, len(_GENERATED_AXIS_VALUES)):
            right_name, right_values = _GENERATED_AXIS_VALUES[right_index]
            expected = set(product(left_values, right_values))
            observed = {(row[left_index], row[right_index]) for row in variant_rows}
            missing = expected - observed
            assert not missing, f"missing generated {left_name}/{right_name} pairs: {missing}"


def _generated_permissions(rule_variant, name_prefix="target"):
    if rule_variant == "literal":
        return [firewall_permission(f"{name_prefix}-primary", "GET /items/item-7")], "/items/item-7"
    if rule_variant == "segment-parameter":
        return [firewall_permission(f"{name_prefix}-primary", "GET /items/{id}")], "/items/7"
    if rule_variant == "mixed-parameter":
        return [
            firewall_permission(f"{name_prefix}-primary", "GET /items/item-{id}")
        ], "/items/item-7"
    if rule_variant == "greedy-parameter":
        return [
            firewall_permission(f"{name_prefix}-primary", "GET /files/{path+}")
        ], "/files/reports/7"
    if rule_variant == "any-before-exact":
        return [
            firewall_permission(
                f"{name_prefix}-primary",
                "ANY /items/{id}",
                "GET /items/{id}",
            )
        ], "/items/7"
    if rule_variant == "competing-specificity":
        return [
            firewall_permission(f"{name_prefix}-first", "GET /items/{id}"),
            firewall_permission(f"{name_prefix}-second", "GET /items/{item}"),
        ], "/items/7"
    raise AssertionError(f"unknown generated rule variant: {rule_variant}")


def _generated_firewalls(base, request_prefix, permissions, topology, malformed):
    target_api = firewall_api(base, deepcopy(permissions))
    target_firewall = firewall_entry("target", target_api)
    firewalls = [target_firewall]

    if topology == "single-owner":
        pass
    elif topology == "unrelated-owner":
        firewalls.insert(
            0,
            firewall_entry(
                "unrelated",
                firewall_api(
                    "https://unrelated.example.com/v9",
                    deepcopy(permissions),
                    auth_label="unrelated",
                ),
            ),
        )
    elif topology == "unrelated-api":
        target_firewall["apis"].insert(
            0,
            firewall_api(
                "https://unrelated.example.com/v9",
                deepcopy(permissions),
                auth_label="unrelated",
            ),
        )
    elif topology == "overlapping-api":
        target_firewall["apis"].append(
            firewall_api(
                f"{base}/nested",
                deepcopy(permissions),
                auth_label="nested",
            )
        )
        request_prefix = f"{request_prefix}/nested"
    elif topology == "shared-owner":
        firewalls.append(
            firewall_entry(
                "secondary",
                firewall_api(base, deepcopy(permissions), auth_label="secondary"),
            )
        )
    elif topology == "shared-owner-with-unrelated-api":
        target_firewall["apis"].insert(
            0,
            firewall_api(
                "https://unrelated.example.com/v9",
                deepcopy(permissions),
                auth_label="unrelated",
            ),
        )
        firewalls.append(
            firewall_entry(
                "secondary",
                firewall_api(base, deepcopy(permissions), auth_label="secondary"),
            )
        )
    else:
        raise AssertionError(f"unknown generated topology variant: {topology}")

    if malformed == "none":
        pass
    elif malformed == "auth":
        target_api["auth"] = {"headers": None}
    elif malformed == "rule":
        target_api["permissions"][0]["rules"].insert(0, None)
    elif malformed == "base":
        target_api["base"] = f"{base}?source=malformed"
    elif malformed == "firewall-name":
        target_firewall["name"] = ""
    else:
        raise AssertionError(f"unknown generated malformed variant: {malformed}")

    return firewalls, request_prefix


def _generated_permission_names(firewall):
    names = []
    for api_entry in firewall["apis"]:
        for permission in api_entry["permissions"]:
            name = permission["name"]
            if name not in names:
                names.append(name)
    return names


def _generated_policies(firewalls, policy_variant):
    if policy_variant == "absent":
        return None

    policies = {}
    for firewall in firewalls:
        name = firewall["name"]
        permission_names = _generated_permission_names(firewall)
        if policy_variant == "allow-permissions":
            policy = network_policy(allow=permission_names, unknown_policy="deny")
        elif policy_variant == "deny-permissions":
            policy = network_policy(deny=permission_names, unknown_policy="deny")
        elif policy_variant == "ask-permissions":
            policy = network_policy(ask=permission_names, unknown_policy="deny")
        elif policy_variant == "unknown-allow":
            policy = network_policy(unknown_policy="allow")
        elif policy_variant == "unknown-deny":
            policy = network_policy(unknown_policy="deny")
        elif policy_variant == "unknown-ask":
            policy = network_policy(unknown_policy="ask")
        elif policy_variant == "malformed-permissions":
            policy = {
                "allow": permission_names[0],
                "deny": [],
                "ask": [],
                "unknownPolicy": "allow",
            }
        else:
            raise AssertionError(f"unknown generated policy variant: {policy_variant}")
        policies[name] = policy
    return policies


def _generated_request(request_variant, request_prefix, matching_suffix):
    if request_variant == "matching":
        return f"{request_prefix}{matching_suffix}", "GET", False
    if request_variant == "lowercase-method":
        return f"{request_prefix}{matching_suffix}", "get", False
    if request_variant == "method-mismatch":
        return f"{request_prefix}{matching_suffix}", "POST", False
    if request_variant == "unknown-path":
        return f"{request_prefix}/unknown/7", "GET", False
    if request_variant == "unmatched-authority":
        return f"https://outside.example.com{matching_suffix}", "GET", False
    if request_variant == "encoded-slash":
        return f"{request_prefix}/items/acme%2Fteam", "GET", False
    if request_variant == "unsafe-path":
        return f"{request_prefix}/items/%2e%2e/secret", "GET", False
    if request_variant == "asterisk-form":
        return request_prefix, "OPTIONS", True
    raise AssertionError(f"unknown generated request variant: {request_variant}")


def _generated_match_case(variants):
    (
        base_variant,
        topology_variant,
        rule_variant,
        policy_variant,
        request_variant,
        intent_variant,
        malformed_variant,
    ) = variants
    base, request_prefix = _GENERATED_BASES[base_variant]
    permissions, matching_suffix = _generated_permissions(rule_variant)
    firewalls, request_prefix = _generated_firewalls(
        base,
        request_prefix,
        permissions,
        topology_variant,
        malformed_variant,
    )
    network_policies = _generated_policies(firewalls, policy_variant)
    url, method, is_asterisk_form = _generated_request(
        request_variant,
        request_prefix,
        matching_suffix,
    )
    return (
        firewalls,
        network_policies,
        url,
        method,
        _GENERATED_INTENTS[intent_variant],
        is_asterisk_form,
    )


def test_generated_indexed_matching_matches_linear():
    variant_rows = _generated_variant_rows()
    _assert_generated_pairwise_coverage(variant_rows)

    for case_index, variants in enumerate(variant_rows):
        firewalls, network_policies, url, method, intent, is_asterisk_form = _generated_match_case(
            variants
        )
        compiled = compile_firewalls_or_fail(firewalls)
        indexed = matching.match_compiled_firewall_request(
            url,
            method,
            compiled,
            network_policies,
            intent,
            is_asterisk_form=is_asterisk_form,
        )
        linear = matching._match_compiled_firewall_request_linear(
            url,
            method,
            compiled,
            network_policies,
            intent,
            is_asterisk_form=is_asterisk_form,
        )
        failure_input = {
            "seed": _GENERATED_CASE_SEED,
            "caseIndex": case_index,
            "variants": dict(
                zip(
                    (axis_name for axis_name, _values in _GENERATED_AXIS_VALUES),
                    variants,
                    strict=True,
                )
            ),
            "url": url,
            "method": method,
            "isAsteriskForm": is_asterisk_form,
            "intent": {"status": intent.status, "value": intent.value},
            "firewalls": firewalls,
            "networkPolicies": network_policies,
        }
        assert indexed == linear, json.dumps(failure_input, indent=2, sort_keys=True)


def test_indexed_matches_linear_for_asterisk_form_unknown_policy():
    firewalls = [
        firewall_entry(
            "example",
            firewall_api(
                "https://api.example.com",
                [firewall_permission("full-access", "ANY /")],
            ),
        )
    ]
    policies = {
        "example": network_policy(
            allow=["full-access"],
            unknown_policy="deny",
        )
    }

    result = _assert_indexed_matches_linear(
        "https://api.example.com",
        "OPTIONS",
        firewalls,
        policies,
        is_asterisk_form=True,
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.reason == "unknown_endpoint"
    assert result.path == "*"


def test_indexed_matches_linear_for_asterisk_form_owner_ambiguity():
    firewalls = [
        firewall_entry(
            "primary",
            firewall_api("https://api.example.com", []),
        ),
        firewall_entry(
            "auditor",
            firewall_api("https://api.example.com", []),
        ),
    ]
    policies = {
        "primary": network_policy(unknown_policy="allow"),
        "auditor": network_policy(unknown_policy="allow"),
    }

    result = _assert_indexed_matches_linear(
        "https://api.example.com",
        "OPTIONS",
        firewalls,
        policies,
        is_asterisk_form=True,
    )

    assert isinstance(result, matching.FirewallAmbiguous)
    assert result.path == "*"
    assert result.candidates == ("auditor", "primary")


def _long_path(prefix, segment_count=1000):
    return prefix + "/" + "/".join(f"seg-{index}" for index in range(segment_count))


def _segment_path(segment_count=1100):
    return "/" + "/".join(f"seg-{index}" for index in range(segment_count))


def test_indexed_matches_linear_for_unrelated_authority_candidates():
    firewalls = [
        firewall_entry(
            "unrelated",
            firewall_api(
                "https://api.unrelated.example.com",
                [firewall_permission("unrelated-read", "GET /items/{id}")],
            ),
        ),
        firewall_entry(
            "target",
            firewall_api(
                "https://api.example.com",
                [firewall_permission("items-read", "GET /items/{id}")],
            ),
        ),
    ]
    policies = {
        "unrelated": network_policy(allow=["unrelated-read"]),
        "target": network_policy(allow=["items-read"]),
    }

    result = _assert_indexed_matches_linear(
        "https://api.example.com/items/123",
        "GET",
        firewalls,
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.name == "target"
    assert result.permission == "items-read"


def test_indexed_matches_linear_for_specific_malformed_auth_precedence():
    firewalls = [
        firewall_entry(
            "broad",
            firewall_api(
                "https://api.example.com",
                [firewall_permission("broad", "ANY /{path+}")],
            ),
        ),
        firewall_entry(
            "admin",
            firewall_api(
                "https://api.example.com/admin",
                [firewall_permission("admin-read", "GET /delete")],
                auth={"headers": None},
            ),
        ),
    ]
    policies = {
        "broad": network_policy(allow=["broad"], unknown_policy="allow"),
        "admin": network_policy(allow=["admin-read"], unknown_policy="allow"),
    }

    result = _assert_indexed_matches_linear(
        "https://api.example.com/admin/delete",
        "GET",
        firewalls,
        policies,
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.name == "admin"
    assert result.reason == "malformed_firewall_config"


def test_indexed_matches_linear_for_parameterized_base_fallback():
    firewalls = [
        firewall_entry(
            "zendesk",
            firewall_api(
                "https://{subdomain}.zendesk.com/api",
                [firewall_permission("tickets-read", "GET /v2/tickets/{id}")],
            ),
        )
    ]
    policies = {"zendesk": network_policy(allow=["tickets-read"])}

    result = _assert_indexed_matches_linear(
        "https://acme.zendesk.com/api/v2/tickets/123",
        "GET",
        firewalls,
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.params == {"subdomain": "acme", "id": "123"}


def test_indexed_matches_linear_for_malformed_network_policy_precedence():
    firewalls = [
        firewall_entry(
            "example",
            firewall_api(
                "https://api.example.com",
                [firewall_permission("items-read", "GET /items/{id}")],
            ),
        )
    ]
    policies = {"example": {"allow": "items-read", "deny": [], "unknownPolicy": "allow"}}

    result = _assert_indexed_matches_linear(
        "https://api.example.com/items/123",
        "GET",
        firewalls,
        policies,
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.reason == "malformed_network_policy"


def test_indexed_matches_linear_for_any_and_exact_method_order():
    api_entry = firewall_api(
        "https://api.example.com",
        [
            firewall_permission(
                "items-read",
                "ANY /items/{id}",
                "GET /items/{id}",
            )
        ],
    )
    firewalls = wrap_firewalls([api_entry], name="example")
    policies = {"example": network_policy(allow=["items-read"])}

    result = _assert_indexed_matches_linear(
        "https://api.example.com/items/123",
        "GET",
        firewalls,
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.rule == "ANY /items/{id}"


def test_indexed_matches_linear_for_greedy_and_mixed_rule_specificity():
    api_entry = firewall_api(
        "https://api.example.com",
        [
            firewall_permission("files-greedy", "GET /files/{path+}"),
            firewall_permission("files-slug", "GET /files/file-{slug}"),
        ],
    )
    firewalls = wrap_firewalls([api_entry], name="example")
    policies = {"example": network_policy(allow=["files-greedy", "files-slug"])}

    result = _assert_indexed_matches_linear(
        "https://api.example.com/files/file-readme",
        "GET",
        firewalls,
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.permission == "files-slug"
    assert result.params == {"slug": "readme"}


def test_indexed_matches_linear_for_ambiguous_cross_firewall_denials():
    firewalls = [
        firewall_entry(
            "auditor",
            firewall_api(
                "https://api.example.com",
                [firewall_permission("audit-read", "GET /items/{id}")],
            ),
        ),
        firewall_entry(
            "primary",
            firewall_api(
                "https://api.example.com",
                [firewall_permission("items-read", "GET /items/{id}")],
            ),
        ),
    ]
    policies = {
        "auditor": network_policy(deny=["audit-read"]),
        "primary": network_policy(deny=["items-read"]),
    }

    result = _assert_indexed_matches_linear(
        "https://api.example.com/items/123",
        "GET",
        firewalls,
        policies,
    )

    assert isinstance(result, matching.FirewallAmbiguous)
    assert result.candidates == ("auditor", "primary")

    selected = _assert_indexed_matches_linear(
        "https://api.example.com/items/123",
        "GET",
        firewalls,
        policies,
        connector_intent.ConnectorIntent("present", "primary"),
    )
    assert isinstance(selected, matching.FirewallBlock)
    assert selected.name == "primary"
    assert selected.permissions == ("items-read",)


def test_indexed_matching_skips_unrelated_static_authority_base_checks(monkeypatch):
    firewalls = [
        firewall_entry(
            f"unrelated-{index}",
            firewall_api(
                f"https://api-{index}.example.com",
                [firewall_permission(f"items-read-{index}", "GET /items/{id}")],
            ),
        )
        for index in range(200)
    ]
    firewalls.append(
        firewall_entry(
            "target",
            firewall_api(
                "https://api.example.com",
                [firewall_permission("items-read", "GET /items/{id}")],
            ),
        )
    )
    policies = {
        firewall["name"]: network_policy(allow=[firewall["apis"][0]["permissions"][0]["name"]])
        for firewall in firewalls
    }
    compiled = compile_firewalls_or_fail(firewalls)
    base_match_count = 0
    original_match_base = matching._match_compiled_base_url_parts

    def counting_match_base(url_parts, base):
        nonlocal base_match_count
        base_match_count += 1
        return original_match_base(url_parts, base)

    monkeypatch.setattr(matching, "_match_compiled_base_url_parts", counting_match_base)

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/items/123",
        "GET",
        compiled,
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.name == "target"
    assert base_match_count == 1


def test_indexed_matching_skips_unrelated_literal_rule_path_checks(monkeypatch):
    permissions = [
        firewall_permission(f"unrelated-{index}", f"GET /items/unrelated-{index}")
        for index in range(500)
    ]
    permissions.append(firewall_permission("target", "GET /items/target"))
    firewalls = wrap_firewalls(
        [
            firewall_api(
                "https://api.example.com",
                permissions,
            )
        ],
        name="large",
    )
    policies = {
        "large": network_policy(
            allow=[permission["name"] for permission in permissions],
            unknown_policy="deny",
        )
    }
    compiled = compile_firewalls_or_fail(firewalls)
    path_match_count = 0
    original_allowed_match = matching._match_compiled_path_segments

    def counting_allowed_match(path_segs, pattern_segs):
        nonlocal path_match_count
        path_match_count += 1
        return original_allowed_match(path_segs, pattern_segs)

    monkeypatch.setattr(matching, "_match_compiled_path_segments", counting_allowed_match)

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/items/target",
        "GET",
        compiled,
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.permission == "target"
    assert path_match_count == 1


@pytest.mark.parametrize(
    ("blocked", "expected_capture_count"),
    [
        (True, 0),
        (False, 1),
    ],
)
def test_indexed_matching_bounds_param_capture_for_same_specificity_fallbacks(
    monkeypatch,
    blocked,
    expected_capture_count,
):
    nonmatching_rule = "GET /{prefix}-nope/{path+}"
    repeated_rule = "GET /{prefix}-good/{path+}"
    firewalls = wrap_firewalls(
        [
            firewall_api(
                "https://api.example.com",
                [firewall_permission("irrelevant", *([nonmatching_rule] * 128))],
            ),
            firewall_api(
                "https://api.example.com",
                [firewall_permission("files-read", *([repeated_rule] * 128))],
            ),
        ],
        name="large",
    )
    policies = {
        "large": network_policy(
            allow=[] if blocked else ["files-read"],
            deny=["files-read"] if blocked else [],
        )
    }
    compiled = compile_firewalls_or_fail(firewalls)
    capture_count = 0
    original_capture_match = matching._match_compiled_path_segments

    # Narrow performance-contract guard: the public decision does not reveal
    # whether route discovery retained params for every matching fallback.
    def counting_capture_match(path_segs, pattern_segs):
        nonlocal capture_count
        capture_count += 1
        return original_capture_match(path_segs, pattern_segs)

    monkeypatch.setattr(matching, "_match_compiled_path_segments", counting_capture_match)

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/a-good/b/c",
        "GET",
        compiled,
        policies,
    )

    if blocked:
        assert isinstance(result, matching.FirewallBlock)
        assert result.permissions == ("files-read",)
    else:
        assert isinstance(result, matching.FirewallAllow)
        assert result.permission == "files-read"
        assert result.params == {"prefix": "a", "path": "b/c"}
    assert capture_count == expected_capture_count


def test_indexed_matches_linear_for_root_static_base_with_long_path():
    firewalls = wrap_firewalls(
        [
            firewall_api(
                "https://api.example.com",
                [firewall_permission("files-read", "GET /files/{path+}")],
            )
        ],
        name="example",
    )
    policies = {"example": network_policy(allow=["files-read"])}

    result = _assert_indexed_matches_linear(
        f"https://api.example.com{_long_path('/files')}",
        "GET",
        firewalls,
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.name == "example"
    assert result.permission == "files-read"


def test_indexed_matches_linear_for_nested_static_base_with_long_suffix():
    firewalls = wrap_firewalls(
        [
            firewall_api(
                "https://api.example.com/admin",
                [firewall_permission("files-read", "GET /files/{path+}")],
            )
        ],
        name="example",
    )
    policies = {"example": network_policy(allow=["files-read"])}

    result = _assert_indexed_matches_linear(
        f"https://api.example.com/admin{_long_path('/files')}",
        "GET",
        firewalls,
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.rel_path.startswith("/files/")
    assert result.permission == "files-read"


def test_indexed_matches_linear_for_repeated_slash_static_base():
    firewalls = wrap_firewalls(
        [
            firewall_api(
                "https://api.example.com//v1",
                [firewall_permission("files-read", "GET /files/{path+}")],
            )
        ],
        name="example",
    )
    policies = {"example": network_policy(allow=["files-read"])}

    result = _assert_indexed_matches_linear(
        "https://api.example.com//v1/files//report",
        "GET",
        firewalls,
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.params == {"path": "/report"}


def test_indexed_matches_linear_for_encoded_slash_under_static_base():
    firewalls = wrap_firewalls(
        [
            firewall_api(
                "https://api.example.com/v1",
                [firewall_permission("repo-read", "GET /repos/{owner}/{repo}")],
            )
        ],
        name="example",
    )
    policies = {"example": network_policy(allow=["repo-read"])}

    result = _assert_indexed_matches_linear(
        "https://api.example.com/v1/repos/acme%2Fteam/project",
        "GET",
        firewalls,
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.params == {"owner": "acme%2Fteam", "repo": "project"}


def test_indexed_matching_long_path_bounds_rule_candidate_segment_work(monkeypatch):
    class CountingPathSegments(list[str]):
        def __init__(self, segments):
            super().__init__(segments)
            self.segment_reads = 0

        def __iter__(self):
            for segment in super().__iter__():
                self.segment_reads += 1
                yield segment

        def __getitem__(self, key):
            if isinstance(key, slice):
                self.segment_reads += len(range(*key.indices(len(self))))
            else:
                self.segment_reads += 1
            return super().__getitem__(key)

    original_candidates = matching._indexed_rule_candidates
    candidate_lookups = 0

    # The allow result cannot expose cumulative prefix copying. Observe only
    # candidate selection so downstream greedy parameter capture stays unrestricted.
    def bounded_candidates(api_entry, upper_method, rel_path_segs):
        nonlocal candidate_lookups
        segments = CountingPathSegments(rel_path_segs)
        candidates = original_candidates(api_entry, upper_method, segments)
        # Allow both method tries and extra linear scans/copies, but not prefix sums.
        assert segments.segment_reads > 0
        assert segments.segment_reads <= 4 * len(segments), (
            "rule candidate segment work exceeded the linear budget"
        )
        candidate_lookups += 1
        return candidates

    monkeypatch.setattr(matching, "_indexed_rule_candidates", bounded_candidates)

    firewalls = wrap_firewalls(
        [
            firewall_api(
                "https://api.example.com",
                [firewall_permission("files-read", "GET /files/{path+}")],
            )
        ],
        name="example",
    )
    policies = {"example": network_policy(allow=["files-read"])}
    compiled = compile_firewalls_or_fail(firewalls)

    result = matching.match_compiled_firewall_request(
        f"https://api.example.com{_long_path('/files')}",
        "GET",
        compiled,
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.permission == "files-read"
    assert candidate_lookups > 0


def test_oversized_slash_paths_do_not_materialize_complete_segment_lists(monkeypatch):
    policies = {"example": network_policy(unknown_policy="allow")}
    static_firewalls = compile_firewalls_or_fail(
        wrap_firewalls([firewall_api("https://api.example.com", [])], name="example")
    )
    parameterized_firewalls = compile_firewalls_or_fail(
        wrap_firewalls(
            [firewall_api("https://api.example.com/{tenant}", [])],
            name="example",
        )
    )
    original_split = firewall_patterns._split_path_segments
    original_iter = matching._iter_path_segments

    def reject_oversized_split(path):
        if len(path) > path_security.MAX_PATH_VALIDATION_CHARACTERS:
            raise AssertionError("oversized request path reached complete segment materialization")
        return original_split(path)

    def reject_oversized_iteration(path):
        if len(path) > path_security.MAX_PATH_VALIDATION_CHARACTERS:
            raise AssertionError("static root lookup advanced the oversized path iterator")
        yield from original_iter(path)

    monkeypatch.setattr(firewall_patterns, "_split_path_segments", reject_oversized_split)
    monkeypatch.setattr(firewall_base_url, "_split_path_segments", reject_oversized_split)
    monkeypatch.setattr(matching, "_split_path_segments", reject_oversized_split)
    monkeypatch.setattr(matching, "_iter_path_segments", reject_oversized_iteration)

    oversized_path = "/tenant" + "/" * path_security.MAX_PATH_VALIDATION_CHARACTERS
    static_result = matching.match_compiled_firewall_request(
        "https://api.example.com" + oversized_path,
        "GET",
        static_firewalls,
        policies,
    )
    parameterized_result = matching.match_compiled_firewall_request(
        "https://api.example.com" + oversized_path,
        "GET",
        parameterized_firewalls,
        policies,
    )
    unrelated_result = matching.match_compiled_firewall_request(
        "https://unrelated.example.com" + oversized_path,
        "GET",
        parameterized_firewalls,
        policies,
    )

    assert isinstance(static_result, matching.FirewallBlock)
    assert static_result.reason == "unsafe_path"
    assert isinstance(parameterized_result, matching.FirewallBlock)
    assert parameterized_result.reason == "unsafe_path"
    assert unrelated_result is None


def test_indexed_matching_handles_deep_static_base_trie():
    deep_base_path = _segment_path()
    firewalls = wrap_firewalls(
        [
            firewall_api(
                f"https://api.example.com{deep_base_path}",
                [firewall_permission("root-read", "GET /")],
            )
        ],
        name="example",
    )
    policies = {"example": network_policy(allow=["root-read"])}

    result = _assert_indexed_matches_linear(
        f"https://api.example.com{deep_base_path}",
        "GET",
        firewalls,
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.permission == "root-read"


def test_indexed_matching_handles_deep_literal_rule_trie():
    deep_rule_path = _segment_path()
    firewalls = wrap_firewalls(
        [
            firewall_api(
                "https://api.example.com",
                [firewall_permission("deep-read", f"GET {deep_rule_path}")],
            )
        ],
        name="example",
    )
    policies = {"example": network_policy(allow=["deep-read"])}

    result = _assert_indexed_matches_linear(
        f"https://api.example.com{deep_rule_path}",
        "GET",
        firewalls,
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.permission == "deep-read"
