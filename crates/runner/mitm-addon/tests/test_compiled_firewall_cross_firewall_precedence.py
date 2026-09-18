"""Compiled firewall cross-firewall and permission ordering precedence tests."""

import pytest

import connector_intent
import connector_runtime_metadata
import matching
from tests.firewall_helpers import (
    compile_firewalls_or_fail,
    firewall_api,
    firewall_entry,
    firewall_permission,
    match_compiled_firewalls,
    network_policy,
    wrap_firewalls,
)

ITEMS_BASE = "https://api.example.com"
ITEMS_RULE = "GET /items/{id}"
ITEMS_URL = "https://api.example.com/items/123"
ITEMS_READ_PERMISSION = "items-read"
AUDIT_READ_PERMISSION = "audit-read"


def _broad_firewall():
    return firewall_entry(
        "broad",
        firewall_api(ITEMS_BASE, [], auth_label="broad"),
    )


def _specific_firewall():
    return firewall_entry(
        "specific",
        firewall_api(
            ITEMS_BASE,
            [firewall_permission(ITEMS_READ_PERMISSION, ITEMS_RULE)],
            auth_label="specific",
        ),
    )


def _primary_firewall():
    return firewall_entry(
        "primary",
        firewall_api(
            ITEMS_BASE,
            [firewall_permission(ITEMS_READ_PERMISSION, ITEMS_RULE)],
            auth_label="primary",
        ),
    )


def _auditor_firewall():
    return firewall_entry(
        "auditor",
        firewall_api(
            ITEMS_BASE,
            [firewall_permission(AUDIT_READ_PERMISSION, ITEMS_RULE)],
            auth_label="auditor",
        ),
    )


def _runtime_firewall(
    kind: connector_runtime_metadata.ConnectorRuntimeKind,
    name: str,
    base: str,
    *,
    auth_label: str,
) -> dict:
    firewall = firewall_entry(
        name,
        firewall_api(base, [], auth_label=auth_label),
    )
    connector_runtime_metadata.mark_connector_runtime_kind(firewall, kind)
    return firewall


@pytest.mark.parametrize(
    ("builtin_base", "custom_base"),
    [
        ("https://api.example.com/v1/", "https://api.example.com/v1/"),
        ("https://api.example.com/v1/", "https://api.example.com/"),
        ("https://api.example.com/", "https://api.example.com/v1/"),
    ],
)
def test_registered_custom_candidate_wins_equal_broader_and_narrower_bases(
    builtin_base: str,
    custom_base: str,
) -> None:
    firewalls = [
        _runtime_firewall(
            "builtin",
            "builtin-service",
            builtin_base,
            auth_label="builtin",
        ),
        _runtime_firewall(
            "custom",
            "custom-service",
            custom_base,
            auth_label="custom",
        ),
    ]
    policies = {
        "builtin-service": network_policy(unknown_policy="allow"),
        "custom-service": network_policy(unknown_policy="allow"),
    }

    result = match_compiled_firewalls(
        "https://api.example.com/v1/items/123",
        firewalls,
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.name == "custom-service"
    assert result.api_entry["auth"]["headers"]["Authorization"] == "Bearer custom"


def test_denied_registered_custom_candidate_does_not_fall_back_to_builtin() -> None:
    builtin = _runtime_firewall(
        "builtin",
        "builtin-service",
        ITEMS_BASE,
        auth_label="builtin",
    )
    custom = firewall_entry(
        "custom-service",
        firewall_api(
            ITEMS_BASE,
            [firewall_permission(ITEMS_READ_PERMISSION, ITEMS_RULE)],
            auth_label="custom",
        ),
    )
    connector_runtime_metadata.mark_connector_runtime_kind(custom, "custom")

    result = match_compiled_firewalls(
        ITEMS_URL,
        [builtin, custom],
        {
            "builtin-service": network_policy(unknown_policy="allow"),
            "custom-service": network_policy(deny=[ITEMS_READ_PERMISSION]),
        },
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.name == "custom-service"
    assert result.reason == "permission_denied"


@pytest.mark.parametrize("selected_kind", ["builtin", "custom"])
def test_explicit_connector_intent_selects_registered_owner(selected_kind: str) -> None:
    builtin = _runtime_firewall("builtin", "builtin-service", ITEMS_BASE, auth_label="builtin")
    custom = _runtime_firewall("custom", "custom-service", ITEMS_BASE, auth_label="custom")
    custom_id = "00000000-0000-4000-8000-000000000002"
    custom["customConnectorId"] = custom_id
    selected_intent = "builtin-service" if selected_kind == "builtin" else custom_id
    policies = {
        "builtin-service": network_policy(unknown_policy="allow"),
        "custom-service": network_policy(unknown_policy="allow"),
    }

    result = match_compiled_firewalls(
        ITEMS_URL,
        [builtin, custom],
        policies,
        intent=connector_intent.ConnectorIntent("present", selected_intent),
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.name == f"{selected_kind}-service"
    assert result.api_entry["auth"]["headers"]["Authorization"] == f"Bearer {selected_kind}"


@pytest.mark.parametrize("remaining_kind", ["builtin", "custom"])
def test_removed_explicit_owner_cannot_fall_through_to_remaining_owner(remaining_kind: str) -> None:
    remaining = _runtime_firewall(
        "builtin" if remaining_kind == "builtin" else "custom",
        "remaining",
        ITEMS_BASE,
        auth_label="remaining",
    )
    result = match_compiled_firewalls(
        ITEMS_URL,
        [remaining],
        {"remaining": network_policy(unknown_policy="allow")},
        intent=connector_intent.ConnectorIntent("present", "removed-owner"),
    )

    assert isinstance(result, matching.FirewallAmbiguous)
    assert result.reason == "connector_intent_not_candidate"


def test_malformed_registered_custom_candidate_does_not_fall_back_to_builtin() -> None:
    builtin = _runtime_firewall(
        "builtin",
        "builtin-service",
        ITEMS_BASE,
        auth_label="builtin",
    )
    custom = firewall_entry(
        "custom-service",
        firewall_api(ITEMS_BASE, [], auth={"headers": None}),
    )
    connector_runtime_metadata.mark_connector_runtime_kind(custom, "custom")

    result = match_compiled_firewalls(
        ITEMS_URL,
        [builtin, custom],
        {
            "builtin-service": network_policy(unknown_policy="allow"),
            "custom-service": network_policy(unknown_policy="allow"),
        },
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.name == "custom-service"
    assert result.reason == "malformed_firewall_config"


def test_registered_custom_precedence_keeps_same_tier_and_neutral_ambiguity() -> None:
    first_custom = _runtime_firewall(
        "custom",
        "first-custom",
        ITEMS_BASE,
        auth_label="first",
    )
    second_custom = _runtime_firewall(
        "custom",
        "second-custom",
        ITEMS_BASE,
        auth_label="second",
    )
    neutral = firewall_entry(
        "neutral",
        firewall_api(ITEMS_BASE, [], auth_label="neutral"),
    )
    policies = {
        name: network_policy(unknown_policy="allow")
        for name in ("first-custom", "second-custom", "neutral")
    }

    same_tier = match_compiled_firewalls(
        ITEMS_URL,
        [first_custom, second_custom],
        policies,
    )
    neutral_overlap = match_compiled_firewalls(
        ITEMS_URL,
        [first_custom, neutral],
        policies,
    )

    assert isinstance(same_tier, matching.FirewallAmbiguous)
    assert same_tier.candidates == ("first-custom", "second-custom")
    assert isinstance(neutral_overlap, matching.FirewallAmbiguous)
    assert neutral_overlap.candidates == ("first-custom", "neutral")


def test_compiled_matches_ask_permission_block():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.github.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "repo-read", "rules": ["GET /repos/{owner}/{repo}"]},
                ],
            }
        ],
        name="github",
    )
    policies = {
        "github": {
            "allow": [],
            "ask": ["repo-read"],
            "deny": [],
            "unknownPolicy": "allow",
        }
    }
    url = "https://api.github.com/repos/org/repo"
    compiled = matching.match_compiled_firewall_request(
        url,
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )
    assert isinstance(compiled, matching.FirewallBlock)
    assert compiled.permissions == ("repo-read",)
    assert compiled.reason == "permission_denied"


@pytest.mark.parametrize("broad_unknown_policy", ["deny", "allow", "broken"])
def test_later_allowed_firewall_wins_after_earlier_unknown_match(
    broad_unknown_policy,
):
    fws = [
        _broad_firewall(),
        _specific_firewall(),
    ]
    policies = {
        "broad": network_policy(unknown_policy=broad_unknown_policy),
        "specific": network_policy(allow=[ITEMS_READ_PERMISSION]),
    }
    compiled = match_compiled_firewalls(ITEMS_URL, fws, policies)
    assert isinstance(compiled, matching.FirewallAllow)
    assert compiled.name == "specific"
    assert compiled.permission == "items-read"


def test_specific_permission_api_wins_after_earlier_unknown_same_firewall():
    fws = [
        {
            "name": "meta-ads",
            "apis": [
                {
                    "base": "https://graph.facebook.com",
                    "auth": {"headers": {"Authorization": "Bearer user-token"}},
                    "permissions": [],
                },
                {
                    "base": "https://graph.facebook.com",
                    "auth": {},
                    "permissions": [
                        {
                            "name": "page-token-ads-posts",
                            "rules": ["GET /v{version}/{page_id}/ads_posts"],
                        },
                    ],
                },
            ],
        },
    ]
    result = matching.match_compiled_firewall_request(
        "https://graph.facebook.com/v22.0/1169814336217013/ads_posts?limit=1",
        "GET",
        compile_firewalls_or_fail(fws),
        None,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.name == "meta-ads"
    assert result.permission == "page-token-ads-posts"
    assert result.api_entry["auth"] == {}


def test_later_denied_firewall_wins_after_earlier_unknown_allow():
    fws = [
        _broad_firewall(),
        _specific_firewall(),
    ]
    policies = {
        "broad": network_policy(unknown_policy="allow"),
        "specific": network_policy(deny=[ITEMS_READ_PERMISSION]),
    }

    result = match_compiled_firewalls(ITEMS_URL, fws, policies)

    assert isinstance(result, matching.FirewallBlock)
    assert result.name == "specific"
    assert result.permissions == ("items-read",)
    assert result.reason == "permission_denied"


def test_equal_route_owners_require_connector_intent():
    fws = [
        _auditor_firewall(),
        _primary_firewall(),
    ]
    policies = {
        "auditor": network_policy(deny=[AUDIT_READ_PERMISSION]),
        "primary": network_policy(allow=[ITEMS_READ_PERMISSION]),
    }

    result = match_compiled_firewalls(ITEMS_URL, fws, policies)

    assert isinstance(result, matching.FirewallAmbiguous)
    assert result.candidates == ("auditor", "primary")
    assert result.reason == "connector_intent_required"


@pytest.mark.parametrize(
    "fws",
    [
        [_auditor_firewall(), _primary_firewall()],
        [_primary_firewall(), _auditor_firewall()],
    ],
)
def test_connector_intent_selects_allowed_route_owner_in_both_orders(fws):
    policies = {
        "primary": network_policy(allow=[ITEMS_READ_PERMISSION]),
        "auditor": network_policy(deny=[AUDIT_READ_PERMISSION]),
    }

    result = match_compiled_firewalls(
        ITEMS_URL,
        fws,
        policies,
        intent=connector_intent.ConnectorIntent("present", "primary"),
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.api_entry["auth"]["headers"]["Authorization"] == "Bearer primary"
    assert result.name == "primary"
    assert result.permission == "items-read"
    assert result.rule == "GET /items/{id}"


def test_connector_intent_enforces_selected_denied_owner_without_fallback():
    fws = [
        _auditor_firewall(),
        _primary_firewall(),
    ]
    policies = {
        "auditor": network_policy(deny=[AUDIT_READ_PERMISSION]),
        "primary": network_policy(deny=[ITEMS_READ_PERMISSION]),
    }

    result = match_compiled_firewalls(
        ITEMS_URL,
        fws,
        policies,
        intent=connector_intent.ConnectorIntent("present", "auditor"),
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.name == "auditor"
    assert result.permissions == ("audit-read",)
    assert result.reason == "permission_denied"


@pytest.mark.parametrize(
    ("intent", "reason"),
    [
        (connector_intent.MALFORMED, "malformed_connector_intent"),
        (
            connector_intent.ConnectorIntent("present", "inactive"),
            "connector_intent_not_candidate",
        ),
    ],
)
def test_unusable_connector_intent_fails_closed(intent, reason):
    fws = [_primary_firewall(), _auditor_firewall()]
    policies = {
        "primary": network_policy(allow=[ITEMS_READ_PERMISSION]),
        "auditor": network_policy(allow=[AUDIT_READ_PERMISSION]),
    }

    result = match_compiled_firewalls(ITEMS_URL, fws, policies, intent=intent)

    assert isinstance(result, matching.FirewallAmbiguous)
    assert result.reason == reason
    assert result.candidates == ("auditor", "primary")
