"""Compiled firewall unknown-policy and unsafe-path tests."""

import pytest

import matching
import path_security
from tests.firewall_helpers import compile_firewalls_or_fail, wrap_firewalls


def test_compiled_matches_unknown_policy_when_api_has_no_permissions():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [],
            }
        ],
        name="example",
    )
    compiled_firewalls = compile_firewalls_or_fail(fws)
    url = "https://api.example.com/items"

    allow_policies = {"example": {"allow": [], "deny": [], "unknownPolicy": "allow"}}
    compiled = matching.match_compiled_firewall_request(
        url,
        "GET",
        compiled_firewalls,
        allow_policies,
    )
    assert isinstance(compiled, matching.FirewallAllow)
    assert compiled.permission is None

    ask_policies = {"example": {"allow": [], "deny": [], "unknownPolicy": "ask"}}
    compiled = matching.match_compiled_firewall_request(
        url,
        "GET",
        compiled_firewalls,
        ask_policies,
    )
    assert isinstance(compiled, matching.FirewallBlock)
    assert compiled.reason == "unknown_endpoint"


@pytest.mark.parametrize(
    "rule",
    [
        pytest.param("ANY /", id="root"),
        pytest.param("ANY /{path+}", id="one-or-more-segments"),
        pytest.param("ANY /{path*}", id="zero-or-more-segments"),
    ],
)
def test_compiled_asterisk_form_skips_endpoint_permissions(rule):
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [{"name": "full-access", "rules": [rule]}],
            }
        ],
        name="example",
    )
    policies = {
        "example": {
            "allow": ["full-access"],
            "deny": [],
            "ask": [],
            "unknownPolicy": "deny",
        }
    }

    result = matching.match_compiled_firewall_request(
        "https://api.example.com",
        "OPTIONS",
        compile_firewalls_or_fail(fws),
        policies,
        is_asterisk_form=True,
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.reason == "unknown_endpoint"
    assert result.path == "*"
    assert result.permissions == ()


def test_compiled_asterisk_form_unknown_allow_preserves_target_identity():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [{"name": "full-access", "rules": ["ANY /"]}],
            }
        ],
        name="example",
    )
    policies = {
        "example": {
            "allow": ["full-access"],
            "deny": [],
            "ask": [],
            "unknownPolicy": "allow",
        }
    }

    result = matching.match_compiled_firewall_request(
        "https://api.example.com",
        "OPTIONS",
        compile_firewalls_or_fail(fws),
        policies,
        is_asterisk_form=True,
    )

    assert isinstance(result, matching.FirewallPolicyAllow)
    assert result.firewall_allow.permission is None
    assert result.firewall_allow.rule is None
    assert result.firewall_allow.rel_path == "*"


def test_compiled_asterisk_form_retains_malformed_auth_failure():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com",
                "auth": {"headers": None},
                "permissions": [],
            }
        ],
        name="example",
    )
    policies = {
        "example": {
            "allow": [],
            "deny": [],
            "ask": [],
            "unknownPolicy": "allow",
        }
    }

    result = matching.match_compiled_firewall_request(
        "https://api.example.com",
        "OPTIONS",
        compile_firewalls_or_fail(fws),
        policies,
        is_asterisk_form=True,
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.reason == "malformed_firewall_config"
    assert result.path == "*"


@pytest.mark.parametrize(
    "url",
    [
        "https://api.example.com/items/../admin",
        "https://api.example.com/items/%2e%2e/admin",
        "https://api.example.com/items/%/admin",
        "https://api.example.com/items/%zz/admin",
        "https://api.example.com/items/%25zz/admin",
        "https://api.example.com/items/%00/admin",
        "https://api.example.com/items/%2500/admin",
        "https://api.example.com/items/%7f/admin",
        "https://api.example.com/items/%ef%bc%8e%ef%bc%8e/admin",
        "https://api.example.com/items/%ef%bc%8f../admin",
        "https://api.example.com/items/%ef%bc%bcadmin",
        "https://api.example.com/items/%ef%bc%852e/admin",
        "https://api.example.com/items/%ff/admin",
        "https://api.example.com/items/%25ff/admin",
        "https://api.example.com/items/%ed%a0%80/admin",
        "https://api.example.com/items\\admin",
        "https://api.example.com/items/%5cadmin",
        "https://api.example.com/items/%5Cadmin",
        "https://api.example.com/items/%5c..%5cadmin",
        "https://api.example.com/items/%5C..%5Cadmin",
    ],
)
def test_compiled_blocks_unsafe_path(url):
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "full-access", "rules": ["ANY /{path+}"]},
                ],
            }
        ],
        name="example",
    )
    policies = {"example": {"allow": ["full-access"], "deny": [], "unknownPolicy": "allow"}}

    compiled = matching.match_compiled_firewall_request(
        url,
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(compiled, matching.FirewallInvalidInput)


def test_compiled_blocks_path_beyond_validation_budget():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [],
            }
        ],
        name="example",
    )
    nested_encoding = "%2525252561"
    path = "/" + nested_encoding
    path += "a" * (path_security.MAX_PATH_VALIDATION_CHARACTERS + 1 - len(path))
    policies = {"example": {"allow": [], "deny": [], "unknownPolicy": "allow"}}

    result = matching.match_compiled_firewall_request(
        "https://api.example.com" + path,
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallInvalidInput)


def test_compiled_allows_encoded_backslash_in_query():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "read", "rules": ["GET /items/{id}"]},
                ],
            }
        ],
        name="example",
    )
    policies = {"example": {"allow": ["read"], "deny": [], "unknownPolicy": "deny"}}

    compiled = matching.match_compiled_firewall_request(
        "https://api.example.com/items/123?next=%5csecret",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(compiled, matching.FirewallAllow)
    assert compiled.permission == "read"


def test_compiled_blocks_unsafe_path_consumed_by_parameterized_base():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com/api/{tenant}",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "admin", "rules": ["GET /admin"]},
                ],
            }
        ],
        name="example",
    )
    url = "https://api.example.com/api/%2e%2e/admin"
    policies = {"example": {"allow": ["admin"], "deny": [], "unknownPolicy": "allow"}}

    compiled = matching.match_compiled_firewall_request(
        url,
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(compiled, matching.FirewallInvalidInput)
    assert compiled.path == "/api/%2e%2e/admin"


def _same_base_read_write_firewall():
    first_api_entry = {
        "base": "https://api.example.com",
        "auth": {"headers": {"Authorization": "Bearer first"}},
        "permissions": [{"name": "read", "rules": ["GET /items/{id}"]}],
    }
    second_api_entry = {
        "base": "https://api.example.com",
        "auth": {"headers": {"Authorization": "Bearer second"}},
        "permissions": [{"name": "write", "rules": ["POST /items/{id}"]}],
    }
    third_api_entry = {
        "base": "https://api.example.com",
        "auth": {"headers": {"Authorization": "Bearer third"}},
        "permissions": [],
    }
    fws = wrap_firewalls(
        [first_api_entry, second_api_entry, third_api_entry],
        name="example",
    )
    policies = {"example": {"allow": ["read", "write"], "deny": [], "unknownPolicy": "allow"}}

    return first_api_entry, second_api_entry, compile_firewalls_or_fail(fws), policies


def test_compiled_caches_safe_path_scan_for_multiple_base_matches(monkeypatch):
    first_api_entry, _, compiled_firewalls, policies = _same_base_read_write_firewall()
    scan_count = 0
    original_has_unsafe_path = matching.has_unsafe_path

    def counting_has_unsafe_path(path: str) -> bool:
        nonlocal scan_count
        scan_count += 1
        return original_has_unsafe_path(path)

    # Narrow performance-contract guard for #17198: the normal allow/block result
    # does not show whether overlapping base matches rescan the same safe path.
    monkeypatch.setattr(matching, "has_unsafe_path", counting_has_unsafe_path)

    no_match = matching.match_compiled_firewall_request(
        "https://other.example.com/items/123",
        "GET",
        compiled_firewalls,
        policies,
    )
    assert no_match is None
    assert scan_count == 0

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/items/123",
        "GET",
        compiled_firewalls,
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.api_entry is first_api_entry
    assert result.permission == "read"
    assert scan_count == 1


def test_compiled_same_base_later_api_entry_can_allow_matching_method():
    _, second_api_entry, compiled_firewalls, policies = _same_base_read_write_firewall()

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/items/123",
        "POST",
        compiled_firewalls,
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.api_entry is second_api_entry
    assert result.permission == "write"


def test_compiled_matches_unknown_policy_when_permissions_are_omitted():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com",
                "auth": {},
            }
        ],
        name="example",
    )
    compiled_firewalls = compile_firewalls_or_fail(fws)
    policies = {"example": {"allow": [], "deny": [], "unknownPolicy": "allow"}}

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/items",
        "GET",
        compiled_firewalls,
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.permission is None


@pytest.mark.parametrize(
    "network_policies",
    [
        None,
        {"example": {"allow": [], "deny": [], "ask": [], "unknownPolicy": "allow"}},
        {"example": {"allow": [], "deny": [], "ask": [], "unknownPolicy": None}},
    ],
)
def test_compiled_unknown_allow_preserves_base_params(network_policies):
    fws = wrap_firewalls(
        [
            {
                "base": "https://{workspace}.example.com/api/{tenant}",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [],
            }
        ],
        name="example",
    )
    compiled_firewalls = compile_firewalls_or_fail(fws)

    result = matching.match_compiled_firewall_request(
        "https://acme.example.com/api/customer-1/users",
        "GET",
        compiled_firewalls,
        network_policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.permission is None
    assert result.rule is None
    assert result.rel_path == "/users"
    assert result.params == {"workspace": "acme", "tenant": "customer-1"}


def test_compiled_unknown_allow_fails_closed_for_conflicting_same_owner_auth():
    first_api_entry = {
        "base": "https://api.example.com",
        "auth": {"headers": {"Authorization": "Bearer first"}},
        "permissions": [],
    }
    second_api_entry = {
        "base": "https://api.example.com",
        "auth": {"headers": {"Authorization": "Bearer second"}},
        "permissions": [],
    }
    fws = wrap_firewalls([first_api_entry, second_api_entry], name="example")
    policies = {"example": {"allow": [], "deny": [], "unknownPolicy": "allow"}}

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/items",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.name == "example"
    assert result.reason == "malformed_firewall_config"


@pytest.mark.parametrize("default_first", [False, True])
def test_compiled_unknown_allow_uses_permissionless_same_owner_api(
    default_first: bool,
):
    default_api_entry = {
        "base": "https://api.example.com",
        "auth": {"headers": {"Authorization": "Bearer default"}},
        "permissions": [],
    }
    route_api_entry = {
        "base": "https://api.example.com",
        "auth": {"headers": {"Authorization": "Bearer route"}},
        "permissions": [{"name": "items-read", "rules": ["GET /items/{id}"]}],
    }
    api_entries = (
        [default_api_entry, route_api_entry]
        if default_first
        else [route_api_entry, default_api_entry]
    )
    fws = wrap_firewalls(api_entries, name="example")
    policies = {
        "example": {
            "allow": ["items-read"],
            "deny": [],
            "unknownPolicy": "allow",
        }
    }

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/profile",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.api_entry is default_api_entry
    assert result.permission is None


def test_compiled_unknown_allow_combines_same_owner_routing_identity():
    auth = {"headers": {"Authorization": "Bearer shared"}}
    first_api_entry = {
        "base": "https://api.example.com",
        "auth": auth,
        "permissions": [],
    }
    second_api_entry = {
        "base": "https://api.example.com",
        "auth": auth,
        "permissions": [],
    }
    fws = wrap_firewalls([first_api_entry, second_api_entry], name="example")
    policies = {"example": {"allow": [], "deny": [], "unknownPolicy": "allow"}}

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/items",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.api_entry is first_api_entry
    assert result.permission is None
    assert result.rule is None
