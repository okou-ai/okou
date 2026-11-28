"""Compiled firewall malformed config precedence and interaction tests."""

import connector_intent
import matching
from tests.firewall_helpers import (
    compile_firewalls_or_fail,
    firewall_api,
    firewall_entry,
    firewall_permission,
    match_compiled_firewalls,
    network_policy,
)

ITEMS_BASE = "https://api.example.com"
ITEMS_RULE = "GET /items/{id}"
ITEMS_URL = "https://api.example.com/items/123"
ITEMS_READ_PERMISSION = "items-read"


def _specific_items_firewall():
    return firewall_entry(
        "specific",
        firewall_api(
            ITEMS_BASE,
            [firewall_permission(ITEMS_READ_PERMISSION, ITEMS_RULE)],
            auth_label="specific",
        ),
    )


def test_denied_match_takes_priority_over_malformed_config_reason():
    fws = [
        firewall_entry(
            "github",
            firewall_api(
                "https://api.github.com",
                [
                    firewall_permission("bad", "GET /repos/{a}literal{b}"),
                    firewall_permission("repo-read", "GET /repos/{owner}/{repo}"),
                ],
            ),
        )
    ]
    policies = {
        "github": network_policy(
            deny=["repo-read"],
            unknown_policy="allow",
        )
    }

    result = match_compiled_firewalls(
        "https://api.github.com/repos/org/repo",
        fws,
        policies,
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.permissions == ("repo-read",)
    assert result.reason == "permission_denied"


def test_valid_later_permission_can_still_allow_after_malformed_rule():
    fws = [
        firewall_entry(
            "github",
            firewall_api(
                "https://api.github.com",
                [
                    firewall_permission("bad", "GET /repos/{a}literal{b}"),
                    firewall_permission("repo-read", "GET /repos/{owner}/{repo}"),
                ],
            ),
        )
    ]
    policies = {
        "github": network_policy(
            allow=["bad", "repo-read"],
            unknown_policy="allow",
        )
    }

    result = match_compiled_firewalls(
        "https://api.github.com/repos/org/repo",
        fws,
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.permission == "repo-read"


def test_malformed_config_takes_priority_over_later_unknown_allow():
    fws = [
        firewall_entry(
            "bad",
            firewall_api(
                "https://api.example.com",
                [firewall_permission("bad-read", "GET /items/{a}literal{b}")],
                auth_label="bad",
            ),
        ),
        firewall_entry(
            "broad",
            firewall_api(
                "https://api.example.com",
                [],
                auth_label="broad",
            ),
        ),
    ]
    policies = {
        "bad": network_policy(allow=["bad-read"], unknown_policy="allow"),
        "broad": network_policy(unknown_policy="allow"),
    }

    result = match_compiled_firewalls(
        "https://api.example.com/items/123",
        fws,
        policies,
        intent=connector_intent.ConnectorIntent("present", "bad"),
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.reason == "malformed_firewall_config"


def test_malformed_config_takes_priority_over_malformed_unknown_policy():
    fws = [
        firewall_entry(
            "example",
            firewall_api(
                "https://api.example.com",
                [firewall_permission("bad-read", "GET /items/{a}literal{b}")],
            ),
        )
    ]
    policies = {
        "example": network_policy(
            allow=["bad-read"],
            unknown_policy="broken",
        )
    }

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/items/123",
        "GET",
        compile_firewalls_or_fail(fws),
        matching.compile_network_policies(policies),
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.permissions == ()
    assert result.reason == "malformed_firewall_config"


def test_valid_later_permission_can_still_allow_after_malformed_base():
    fws = [
        firewall_entry(
            "broad",
            firewall_api(
                "https://api.{sub+}.example.com",
                [firewall_permission("bad-read", "GET /items/{id}")],
                auth_label="broad",
            ),
        ),
        firewall_entry(
            "specific",
            firewall_api(
                "https://api.us.example.com",
                [firewall_permission("items-read", "GET /items/{id}")],
                auth_label="specific",
            ),
        ),
    ]
    policies = {
        "broad": network_policy(allow=["bad-read"], unknown_policy="allow"),
        "specific": network_policy(allow=["items-read"], unknown_policy="deny"),
    }

    result = match_compiled_firewalls(
        "https://api.us.example.com/items/123",
        fws,
        policies,
        intent=connector_intent.ConnectorIntent("present", "specific"),
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.name == "specific"
    assert result.permission == "items-read"


def test_valid_later_permission_can_still_allow_after_malformed_auth():
    fws = [
        firewall_entry(
            "broad",
            firewall_api(
                "https://api.example.com",
                [firewall_permission("bad-read", "GET /items/{id}")],
                auth={"headers": None},
            ),
        ),
        firewall_entry(
            "specific",
            firewall_api(
                "https://api.example.com",
                [firewall_permission("items-read", "GET /items/{id}")],
                auth_label="specific",
            ),
        ),
    ]
    policies = {
        "broad": network_policy(allow=["bad-read"], unknown_policy="allow"),
        "specific": network_policy(allow=["items-read"], unknown_policy="deny"),
    }

    result = match_compiled_firewalls(
        "https://api.example.com/items/123",
        fws,
        policies,
        intent=connector_intent.ConnectorIntent("present", "specific"),
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.name == "specific"
    assert result.permission == "items-read"


# Malformed network policy precedence


def test_later_malformed_policy_wins_after_earlier_unknown_allow():
    fws = [
        firewall_entry(
            "broad",
            firewall_api(ITEMS_BASE, [], auth_label="broad"),
        ),
        _specific_items_firewall(),
    ]
    policies = {
        "broad": network_policy(unknown_policy="allow"),
        "specific": {"deny": "items-read", "unknownPolicy": "deny"},
    }

    result = matching.match_compiled_firewall_request(
        ITEMS_URL,
        "GET",
        compile_firewalls_or_fail(fws),
        matching.compile_network_policies(policies),
        intent=connector_intent.ConnectorIntent("present", "specific"),
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.name == "specific"
    assert result.permissions == ()
    assert result.reason == "malformed_network_policy"


def test_later_allowed_firewall_wins_after_earlier_malformed_policy_match():
    fws = [
        firewall_entry(
            "broad",
            firewall_api(
                ITEMS_BASE,
                [firewall_permission("broad-read", ITEMS_RULE)],
                auth_label="broad",
            ),
        ),
        _specific_items_firewall(),
    ]
    policies = {
        "broad": "denied",
        "specific": network_policy(allow=[ITEMS_READ_PERMISSION]),
    }
    compiled = matching.match_compiled_firewall_request(
        ITEMS_URL,
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
        connector_intent.ConnectorIntent("present", "specific"),
    )
    assert isinstance(compiled, matching.FirewallAllow)
    assert compiled.name == "specific"
    assert compiled.permission == "items-read"
