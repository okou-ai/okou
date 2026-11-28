"""Compiled firewall base specificity precedence tests."""

import pytest

import connector_intent
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

BROAD_BASE = "https://api.example.com"
ADMIN_BASE = "https://api.example.com/admin"
ADMIN_DELETE_URL = "https://api.example.com/admin/delete"


def broad_firewall(*, base=BROAD_BASE):
    return firewall_entry(
        "broad",
        firewall_api(
            base,
            [firewall_permission("broad", "ANY /{path+}")],
            auth_label="broad",
        ),
    )


def test_more_specific_base_deny_blocks_earlier_broad_allow():
    fws = wrap_firewalls(
        [
            firewall_api(
                BROAD_BASE, [firewall_permission("broad", "ANY /{path+}")], auth_label="broad"
            ),
            firewall_api(
                ADMIN_BASE, [firewall_permission("admin", "GET /delete")], auth_label="admin"
            ),
        ],
        name="example",
    )
    policies = {"example": network_policy(allow=["broad"], deny=["admin"])}

    result = match_compiled_firewalls(ADMIN_DELETE_URL, fws, policies)

    assert isinstance(result, matching.FirewallBlock)
    assert result.base == ADMIN_BASE
    assert result.path == "/delete"
    assert result.permissions == ("admin",)
    assert result.reason == "permission_denied"


@pytest.mark.parametrize(
    ("fws", "network_policies", "expected"),
    [
        pytest.param(
            [
                broad_firewall(),
                firewall_entry("admin", firewall_api(ADMIN_BASE, [], auth_label="admin")),
            ],
            {
                "broad": network_policy(allow=["broad"], unknown_policy="allow"),
                "admin": network_policy(unknown_policy="deny"),
            },
            {
                "base": ADMIN_BASE,
                "name": "admin",
                "path": "/delete",
                "permissions": (),
                "reason": "unknown_endpoint",
            },
            id="specific-unknown-deny-blocks-broad-allow",
        ),
        pytest.param(
            [
                broad_firewall(),
                firewall_entry("admin", firewall_api(ADMIN_BASE, [], auth_label="admin")),
            ],
            matching.compile_network_policies(
                {
                    "broad": network_policy(allow=["broad"], unknown_policy="allow"),
                    "admin": network_policy(unknown_policy="broken"),
                }
            ),
            {
                "base": ADMIN_BASE,
                "name": "admin",
                "path": "/delete",
                "permissions": (),
                "reason": "malformed_network_policy",
            },
            id="specific-invalid-unknown-policy-blocks-broad-allow",
        ),
        pytest.param(
            [
                broad_firewall(),
                firewall_entry(
                    "admin",
                    firewall_api(
                        ADMIN_BASE,
                        [firewall_permission("admin", "GET /{a}literal{b}")],
                        auth_label="admin",
                    ),
                ),
            ],
            {
                "broad": network_policy(allow=["broad"], unknown_policy="allow"),
                "admin": network_policy(allow=["admin"], unknown_policy="allow"),
            },
            {
                "base": ADMIN_BASE,
                "name": "admin",
                "path": "/delete",
                "permissions": (),
                "reason": "malformed_firewall_config",
            },
            id="specific-malformed-rule-blocks-broad-allow",
        ),
        pytest.param(
            [
                broad_firewall(),
                firewall_entry(
                    "admin",
                    firewall_api(
                        ADMIN_BASE,
                        [firewall_permission("admin", "GET /delete")],
                        auth={"headers": None},
                    ),
                ),
            ],
            {
                "broad": network_policy(allow=["broad"], unknown_policy="allow"),
                "admin": network_policy(allow=["admin"], unknown_policy="allow"),
            },
            {
                "base": ADMIN_BASE,
                "name": "admin",
                "path": "/delete",
                "permissions": (),
                "reason": "malformed_firewall_config",
            },
            id="specific-malformed-auth-blocks-broad-allow",
        ),
        pytest.param(
            [
                broad_firewall(),
                firewall_entry(
                    "",
                    firewall_api(
                        ADMIN_BASE,
                        [firewall_permission("admin", "GET /delete")],
                        auth_label="admin",
                    ),
                ),
            ],
            {"broad": network_policy(allow=["broad"], unknown_policy="allow")},
            {
                "base": ADMIN_BASE,
                "name": "",
                "path": "/delete",
                "permissions": (),
                "reason": "malformed_firewall_config",
            },
            id="specific-malformed-firewall-name-blocks-broad-allow",
        ),
        pytest.param(
            [
                broad_firewall(),
                firewall_entry(
                    "admin",
                    firewall_api(
                        f"{ADMIN_BASE}?token=1",
                        [firewall_permission("admin", "GET /delete")],
                        auth_label="admin",
                    ),
                ),
            ],
            {
                "broad": network_policy(allow=["broad"], unknown_policy="allow"),
                "admin": network_policy(allow=["admin"], unknown_policy="allow"),
            },
            {
                "base": f"{ADMIN_BASE}?token=1",
                "name": "admin",
                "path": "/delete",
                "permissions": (),
                "reason": "malformed_firewall_config",
            },
            id="specific-malformed-base-blocks-broad-allow",
        ),
        pytest.param(
            [
                broad_firewall(),
                firewall_entry(
                    "admin",
                    firewall_api(
                        ADMIN_BASE,
                        [firewall_permission("admin", "GET /delete")],
                        auth_label="admin",
                    ),
                ),
            ],
            {
                "broad": network_policy(allow=["broad"], unknown_policy="allow"),
                "admin": {
                    "allow": "admin",
                    "deny": [],
                    "unknownPolicy": "allow",
                },
            },
            {
                "base": ADMIN_BASE,
                "name": "admin",
                "path": "/delete",
                "permissions": (),
                "reason": "malformed_network_policy",
            },
            id="specific-malformed-policy-blocks-broad-allow",
        ),
        pytest.param(
            [
                broad_firewall(),
                firewall_entry(
                    "admin",
                    firewall_api(
                        ADMIN_BASE,
                        [firewall_permission("admin", "GET /delete")],
                        auth_label="admin",
                    ),
                ),
            ],
            matching.compile_network_policies("broken"),
            {
                "base": ADMIN_BASE,
                "name": "admin",
                "path": "/delete",
                "permissions": (),
                "reason": "malformed_network_policy",
            },
            id="top-level-malformed-policy-blocks-broad-allow",
        ),
    ],
)
def test_selected_admin_firewall_block_matrix(fws, network_policies, expected):
    result = match_compiled_firewalls(
        ADMIN_DELETE_URL,
        fws,
        network_policies,
        intent=connector_intent.ConnectorIntent("present", "admin"),
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.base == expected["base"]
    assert result.name == expected["name"]
    assert result.path == expected["path"]
    assert result.permissions == expected["permissions"]
    assert result.reason == expected["reason"]


@pytest.mark.parametrize(
    ("fws", "network_policies", "expected"),
    [
        pytest.param(
            [
                broad_firewall(base="https://{workspace}.example.com"),
                firewall_entry("admin", firewall_api(ADMIN_BASE, [], auth_label="admin")),
            ],
            {
                "broad": network_policy(deny=["broad"]),
                "admin": network_policy(unknown_policy="allow"),
            },
            {
                "base": ADMIN_BASE,
                "authorization": "Bearer admin",
                "name": "admin",
                "permission": None,
                "rule": None,
                "rel_path": "/delete",
            },
            id="specific-unknown-allow-wins-after-broad-deny",
        ),
        pytest.param(
            [
                broad_firewall(),
                firewall_entry(
                    "admin",
                    firewall_api(
                        ADMIN_BASE,
                        [firewall_permission("admin", "GET /delete")],
                        auth_label="admin",
                    ),
                ),
            ],
            {
                "broad": network_policy(deny=["broad"]),
                "admin": network_policy(allow=["admin"]),
            },
            {
                "base": ADMIN_BASE,
                "authorization": "Bearer admin",
                "name": "admin",
                "permission": "admin",
                "rule": "GET /delete",
                "rel_path": "/delete",
            },
            id="specific-allow-wins-after-broad-deny",
        ),
    ],
)
@pytest.mark.parametrize(
    "specific_first",
    [False, True],
    ids=["broad-first", "specific-first"],
)
def test_selected_admin_firewall_allow_matrix(fws, network_policies, expected, specific_first):
    ordered_fws = list(reversed(fws)) if specific_first else fws

    result = match_compiled_firewalls(
        ADMIN_DELETE_URL,
        ordered_fws,
        network_policies,
        intent=connector_intent.ConnectorIntent("present", "admin"),
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.api_entry["base"] == expected["base"]
    assert result.api_entry["auth"]["headers"]["Authorization"] == expected["authorization"]
    assert result.name == expected["name"]
    assert result.permission == expected["permission"]
    assert result.rule == expected["rule"]
    assert result.rel_path == expected["rel_path"]


@pytest.mark.parametrize("specific_first", [False, True], ids=["broad-first", "specific-first"])
@pytest.mark.parametrize("reverse_fallbacks", [False, True], ids=["original", "reversed"])
def test_selected_parameterized_owner_preserves_first_unknown_allow_fallback(
    specific_first, reverse_fallbacks
):
    tenant_base = "https://{workspace}.example.com/api/{tenant}"
    fallback_apis = [
        firewall_api(tenant_base, [], auth_label="tenant"),
        firewall_api(tenant_base, [], auth_label="tenant"),
    ]
    if reverse_fallbacks:
        fallback_apis.reverse()
    fws = [
        broad_firewall(base="https://{workspace}.example.com"),
        firewall_entry(
            "tenant",
            firewall_api(
                tenant_base,
                [firewall_permission("admin", "GET /admin")],
                auth_label="admin",
            ),
            *fallback_apis,
        ),
    ]
    if specific_first:
        fws.reverse()
    policies = {
        "broad": network_policy(deny=["broad"]),
        "tenant": network_policy(unknown_policy="allow"),
    }

    result = matching.match_compiled_firewall_request(
        "https://acme.example.com/api/customer-1/users",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
        intent=connector_intent.ConnectorIntent("present", "tenant"),
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.api_entry is fallback_apis[0]
    assert result.api_entry["auth"]["headers"]["Authorization"] == "Bearer tenant"
    assert result.name == "tenant"
    assert result.permission is None
    assert result.rule is None
    assert result.rel_path == "/users"
    assert result.params == {"workspace": "acme", "tenant": "customer-1"}


def test_selected_parameterized_owner_preserves_base_and_rule_params():
    fws = [
        {
            "name": "broad",
            "apis": [
                {
                    "base": "https://{workspace}.example.com",
                    "auth": {"headers": {"Authorization": "Bearer broad"}},
                    "permissions": [
                        {"name": "broad", "rules": ["ANY /{path+}"]},
                    ],
                }
            ],
        },
        {
            "name": "tenant",
            "apis": [
                {
                    "base": "https://{workspace}.example.com/api/{tenant}",
                    "auth": {"headers": {"Authorization": "Bearer tenant"}},
                    "permissions": [
                        {"name": "user-read", "rules": ["GET /users/{id}"]},
                    ],
                }
            ],
        },
    ]
    policies = {
        "broad": {
            "allow": [],
            "deny": ["broad"],
            "unknownPolicy": "deny",
        },
        "tenant": {
            "allow": ["user-read"],
            "deny": [],
            "unknownPolicy": "deny",
        },
    }

    result = matching.match_compiled_firewall_request(
        "https://acme.example.com/api/customer-1/users/42",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
        intent=connector_intent.ConnectorIntent("present", "tenant"),
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.api_entry["auth"]["headers"]["Authorization"] == "Bearer tenant"
    assert result.name == "tenant"
    assert result.permission == "user-read"
    assert result.rule == "GET /users/{id}"
    assert result.rel_path == "/users/42"
    assert result.params == {
        "workspace": "acme",
        "tenant": "customer-1",
        "id": "42",
    }


def test_parameterized_path_base_deny_blocks_earlier_root_allow():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com",
                "auth": {"headers": {"Authorization": "Bearer root"}},
                "permissions": [
                    {"name": "root", "rules": ["ANY /{path+}"]},
                ],
            },
            {
                "base": "https://api.example.com/v1/{org}",
                "auth": {"headers": {"Authorization": "Bearer org"}},
                "permissions": [
                    {"name": "project", "rules": ["GET /projects/{id}"]},
                ],
            },
        ],
        name="example",
    )
    policies = {
        "example": {
            "allow": ["root"],
            "deny": ["project"],
            "unknownPolicy": "deny",
        }
    }

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/v1/acme/projects/123",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.base == "https://api.example.com/v1/{org}"
    assert result.path == "/projects/123"
    assert result.permissions == ("project",)
    assert result.reason == "permission_denied"


@pytest.mark.parametrize(
    "specific_first",
    [False, True],
    ids=["broad-first", "specific-first"],
)
def test_path_base_deny_blocks_long_static_host_allow_in_both_orders(specific_first):
    host = ".".join(["a"] * 100 + ["com"])
    path_base = "https://{sub+}.com/{tenant}"
    apis = [
        {
            "base": f"https://{host}",
            "auth": {"headers": {"Authorization": "Bearer root"}},
            "permissions": [
                {"name": "root", "rules": ["ANY /{path+}"]},
            ],
        },
        {
            "base": path_base,
            "auth": {"headers": {"Authorization": "Bearer restricted"}},
            "permissions": [
                {"name": "restricted", "rules": ["GET /delete"]},
            ],
        },
    ]
    ordered_apis = list(reversed(apis)) if specific_first else apis
    fws = wrap_firewalls(ordered_apis, name="example")
    policies = {
        "example": {
            "allow": ["root"],
            "deny": ["restricted"],
            "unknownPolicy": "deny",
        }
    }

    result = matching.match_compiled_firewall_request(
        f"https://{host}/admin/delete",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.base == path_base
    assert result.name == "example"
    assert result.path == "/delete"
    assert result.permissions == ("restricted",)
    assert result.reason == "permission_denied"


def test_base_specificity_wins_before_rule_specificity():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com",
                "auth": {"headers": {"Authorization": "Bearer root"}},
                "permissions": [
                    {"name": "root-admin", "rules": ["GET /admin/delete"]},
                ],
            },
            {
                "base": "https://api.example.com/admin",
                "auth": {"headers": {"Authorization": "Bearer admin"}},
                "permissions": [
                    {"name": "admin-catchall", "rules": ["ANY /{path+}"]},
                ],
            },
        ],
        name="example",
    )
    policies = {
        "example": {
            "allow": ["root-admin"],
            "deny": ["admin-catchall"],
            "unknownPolicy": "deny",
        }
    }

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/admin/delete",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.base == "https://api.example.com/admin"
    assert result.path == "/delete"
    assert result.permissions == ("admin-catchall",)
    assert result.reason == "permission_denied"


@pytest.mark.parametrize(
    "specific_first",
    [False, True],
    ids=["broad-first", "specific-first"],
)
def test_static_host_base_deny_blocks_wildcard_host_allow_in_both_orders(specific_first):
    apis = [
        {
            "base": "https://{network}.g.alchemy.com",
            "auth": {"headers": {"Authorization": "Bearer wildcard"}},
            "permissions": [
                {"name": "wildcard", "rules": ["ANY /{path+}"]},
            ],
        },
        {
            "base": "https://api.g.alchemy.com",
            "auth": {"headers": {"Authorization": "Bearer static"}},
            "permissions": [
                {"name": "static", "rules": ["GET /v2/demo"]},
            ],
        },
    ]
    ordered_apis = list(reversed(apis)) if specific_first else apis
    fws = wrap_firewalls(ordered_apis, name="alchemy")
    policies = {
        "alchemy": {
            "allow": ["wildcard"],
            "deny": ["static"],
            "unknownPolicy": "deny",
        }
    }

    result = matching.match_compiled_firewall_request(
        "https://api.g.alchemy.com/v2/demo",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.base == "https://api.g.alchemy.com"
    assert result.name == "alchemy"
    assert result.path == "/v2/demo"
    assert result.permissions == ("static",)
    assert result.reason == "permission_denied"


def test_same_base_specific_deny_blocks_earlier_broad_allow():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com",
                "auth": {"headers": {"Authorization": "Bearer broad"}},
                "permissions": [
                    {"name": "broad", "rules": ["ANY /{path+}"]},
                ],
            },
            {
                "base": "https://api.example.com",
                "auth": {"headers": {"Authorization": "Bearer admin"}},
                "permissions": [
                    {"name": "admin", "rules": ["GET /admin/delete"]},
                ],
            },
        ],
        name="example",
    )
    policies = {
        "example": {
            "allow": ["broad"],
            "deny": ["admin"],
            "unknownPolicy": "deny",
        }
    }

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/admin/delete",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.base == "https://api.example.com"
    assert result.path == "/admin/delete"
    assert result.permissions == ("admin",)
    assert result.reason == "permission_denied"


def test_same_base_specific_deny_discards_earlier_broad_deny_permissions():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api.example.com",
                "auth": {"headers": {"Authorization": "Bearer broad"}},
                "permissions": [
                    {"name": "broad", "rules": ["ANY /{path+}"]},
                ],
            },
            {
                "base": "https://api.example.com",
                "auth": {"headers": {"Authorization": "Bearer admin"}},
                "permissions": [
                    {"name": "admin", "rules": ["GET /admin/delete"]},
                ],
            },
        ],
        name="example",
    )
    policies = {
        "example": {
            "allow": [],
            "deny": ["broad", "admin"],
            "unknownPolicy": "deny",
        }
    }

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/admin/delete",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.base == "https://api.example.com"
    assert result.path == "/admin/delete"
    assert result.permissions == ("admin",)
    assert result.reason == "permission_denied"
