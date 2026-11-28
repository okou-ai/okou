"""Credential hints select a source before its own permissions are reduced."""

import pytest

import connector_intent
import matching
from tests.firewall_helpers import compile_firewalls_or_fail


@pytest.mark.parametrize(
    ("headers", "query", "owner"),
    [
        (((b"Authorization", b"Bearer fixture-google"),), "", "google"),
        (((b"authorization", b"Bearer fixture-provider"),), "", "antigravity"),
        ((), "?key=fixture%2Bgoogle", "google"),
        (((b"Other", b"Bearer fixture-google"),), "", "antigravity"),
        (((b"Authorization", b"Bearer fixture-google-other"),), "", "antigravity"),
    ],
)
def test_matching_credential_field_selects_owner(headers, query, owner):
    result = matching.match_compiled_firewall_request(
        "https://www.googleapis.com/oauth2/v2/userinfo" + query,
        "GET",
        _overlapping_firewalls(),
        intent=connector_intent.ConnectorIntent("present", "antigravity"),
        request_context=matching.FirewallRequestContext(raw_header_fields=headers),
    )
    assert isinstance(result, matching.FirewallAllow)
    assert result.name == owner


def _overlapping_firewalls():
    return compile_firewalls_or_fail(
        [
            {
                "name": "google",
                "placeholders": {"TOKEN": "fixture-google", "KEY": "fixture+google"},
                "apis": [
                    {
                        "base": "https://www.googleapis.com",
                        "auth": {
                            "headers": {"Authorization": "Bearer ${{ secrets.TOKEN }}"},
                            "query": {"key": "${{ secrets.KEY }}"},
                        },
                        "permissions": [{"name": "profile", "rules": ["GET /oauth2/v2/userinfo"]}],
                    }
                ],
            },
            {
                "name": "antigravity",
                "placeholders": {"TOKEN": "fixture-provider", "UNUSED": "fixture-google"},
                "apis": [
                    {
                        "base": "https://www.googleapis.com/oauth2/v2/userinfo",
                        "auth": {"headers": {"Authorization": "Bearer ${{ secrets.TOKEN }}"}},
                    }
                ],
            },
        ]
    )


def test_selected_owner_denial_does_not_fall_back():
    result = matching.match_compiled_firewall_request(
        "https://www.googleapis.com/oauth2/v2/userinfo",
        "GET",
        _overlapping_firewalls(),
        {"google": {"allow": [], "deny": ["profile"], "unknownPolicy": "deny"}},
        request_context=matching.FirewallRequestContext(
            raw_header_fields=((b"Authorization", b"Bearer fixture-google"),),
        ),
    )
    assert isinstance(result, matching.FirewallBlock)
    assert result.name == "google"
    assert result.reason == "permission_denied"
