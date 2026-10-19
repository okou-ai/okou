"""Compiled firewall host-parameterized base matching tests."""

import pytest

import matching
from tests.firewall_helpers import compile_firewalls_or_fail, wrap_firewalls


@pytest.mark.parametrize(
    ("host", "runtime_host", "host_params"),
    [
        ("{sub}.example.com", "api.example.com", {"sub": "api"}),
        ("api-{region}.example.com", "api-us.example.com", {"region": "us"}),
        ("{sub+}.example.com", "a.b.example.com", {"sub": "a.b"}),
        ("{sub*}.example.com", "example.com", {"sub": ""}),
    ],
)
@pytest.mark.parametrize(
    ("base_path", "request_path", "relative_path"),
    [
        ("", "/foo", "/foo"),
        ("/", "/foo", "/foo"),
        ("", "//foo", "//foo"),
        ("/", "//foo", "//foo"),
        ("//", "/foo", None),
        ("//", "//foo", "/foo"),
        ("//", "///foo", "//foo"),
        ("//", "/", "/"),
        ("//", "//", "/"),
        ("///", "//foo", None),
        ("///", "///foo", "/foo"),
        ("///", "////foo", "//foo"),
        ("///", "//", "/"),
    ],
)
def test_parameterized_host_root_slash_scope_selects_compiled_permission(
    host, runtime_host, host_params, base_path, request_path, relative_path
):
    base = f"https://{host}{base_path}"
    url = f"https://{runtime_host}{request_path}"
    firewalls = wrap_firewalls(
        [
            {
                "base": base,
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [{"name": "read", "rules": ["GET /foo"]}],
            }
        ],
        name="example",
    )
    policies = {"example": {"allow": ["read"], "deny": [], "unknownPolicy": "deny"}}

    assert matching.firewall_base_config_is_valid(base)
    expected_match = None if relative_path is None else (relative_path, host_params)
    assert matching.match_base_url(url, base) == expected_match

    result = matching.match_compiled_firewall_request(
        url, "GET", compile_firewalls_or_fail(firewalls), policies
    )

    if relative_path is None:
        assert result is None
    elif relative_path == "/foo":
        assert isinstance(result, matching.FirewallAllow)
        assert result.permission == "read"
        assert result.rel_path == "/foo"
        assert result.params == host_params
        assert result.api_entry["base"] == base
    else:
        assert isinstance(result, matching.FirewallBlock)
        assert result.reason == "unknown_endpoint"
        assert result.path == relative_path


@pytest.mark.parametrize(
    ("base", "url", "expected_host_params"),
    [
        ("https://{sub}.123.example.com", "https://api.123.example.com", {"sub": "api"}),
        ("https://{sub}.0123.example.com", "https://api.0123.example.com", {"sub": "api"}),
        ("https://{sub}.0XABC.example.com", "https://api.0xabc.example.com", {"sub": "api"}),
        (
            "https://api-{region}.123.example.com",
            "https://api-us.123.example.com",
            {"region": "us"},
        ),
        ("https://{sub+}.0123.example.com", "https://a.b.0123.example.com", {"sub": "a.b"}),
        ("https://{sub*}.0xabc.example.com", "https://0xabc.example.com", {"sub": ""}),
    ],
)
def test_compiled_numeric_dns_labels_in_parameterized_hosts(base, url, expected_host_params):
    base = f"{base}/v1/{{org}}"
    url = f"{url}/v1/acme/items/42"
    fws = wrap_firewalls(
        [
            {
                "base": base,
                "auth": {"headers": {}},
                "permissions": [{"name": "read", "rules": ["GET /items/{id}"]}],
            }
        ],
        name="example",
    )
    policies = {"example": {"allow": ["read"], "deny": [], "unknownPolicy": "deny"}}
    compiled_firewalls = compile_firewalls_or_fail(fws)

    assert matching.firewall_base_config_is_valid(base)
    assert matching.match_base_url(url, base) == (
        "/items/42",
        {**expected_host_params, "org": "acme"},
    )

    result = matching.match_compiled_firewall_request(url, "GET", compiled_firewalls, policies)

    assert isinstance(result, matching.FirewallAllow)
    assert result.permission == "read"
    assert result.rel_path == "/items/42"
    assert result.params == {**expected_host_params, "org": "acme", "id": "42"}
    assert (
        matching.match_compiled_firewall_request(
            url.replace(".example.com", ".example.org"), "GET", compiled_firewalls, policies
        )
        is None
    )


def test_compiled_matches_mixed_base_and_greedy_rule():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api-{region}.example.com/v1/{org}",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "upload", "rules": ["POST /upload/{path+}"]},
                ],
            }
        ],
        name="storage",
    )
    url = "https://api-us.example.com/v1/acme/upload/a/b/c"
    policies = {"storage": {"allow": ["upload"], "deny": [], "unknownPolicy": "deny"}}
    compiled = matching.match_compiled_firewall_request(
        url,
        "POST",
        compile_firewalls_or_fail(fws),
        policies,
    )
    assert isinstance(compiled, matching.FirewallAllow)
    assert compiled.params == {
        "region": "us",
        "org": "acme",
        "path": "a/b/c",
    }


def test_compiled_mixed_base_host_rejects_empty_capture():
    fws = wrap_firewalls(
        [
            {
                "base": "https://api-{region}.example.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "read", "rules": ["GET /items/{id}"]},
                ],
            }
        ],
        name="example",
    )
    policies = {"example": {"allow": ["read"], "deny": [], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        "https://api-.example.com/items/123",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert result is None


def test_compiled_host_param_name_preserves_case():
    fws = wrap_firewalls(
        [
            {
                "base": "https://{Org}.example.com/v1/{org}",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "read", "rules": ["GET /projects/{id}"]},
                ],
            }
        ],
        name="example",
    )
    policies = {"example": {"allow": ["read"], "deny": [], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        "https://acme.example.com/v1/team/projects/123",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.params == {"Org": "acme", "org": "team", "id": "123"}


@pytest.mark.parametrize(
    "base",
    [
        "https://{sub}.%7Benv%7D.example.com",
        "https://{a}%2e{b}.example.com",
        "https://{a}%E3%80%82{b}.example.com",
    ],
)
def test_compiled_percent_encoded_host_syntax_does_not_create_params(base):
    fws = wrap_firewalls(
        [
            {
                "base": base,
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "read", "rules": ["GET /projects/{id}"]},
                ],
            }
        ],
        name="example",
    )
    policies = {"example": {"allow": ["read"], "deny": [], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        "https://acme.team.example.com/projects/123",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.reason == "malformed_firewall_config"


@pytest.mark.parametrize(
    "url",
    [
        "https://api.example.com//v1//messages/foo",
        "https://api.example.com/v1//messages/foo",
    ],
)
def test_compiled_parameterized_host_literal_path_does_not_collapse_empty_segments_inside_base(
    url,
):
    fws = wrap_firewalls(
        [
            {
                "base": "https://{sub}.example.com/v1/messages",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "read", "rules": ["GET /foo"]},
                ],
            }
        ],
        name="example",
    )
    policies = {"example": {"allow": ["read"], "deny": [], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        url,
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert result is None


def test_compiled_host_literal_path_rule_preserves_empty_segments_after_base():
    fws = wrap_firewalls(
        [
            {
                "base": "https://{sub}.example.com/v1/messages",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "read", "rules": ["GET /foo"]},
                ],
            }
        ],
        name="example",
    )
    policies = {"example": {"allow": ["read"], "deny": [], "unknownPolicy": "deny"}}

    result = matching.match_compiled_firewall_request(
        "https://api.example.com/v1/messages//foo",
        "GET",
        compile_firewalls_or_fail(fws),
        policies,
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.path == "//foo"
    assert result.reason == "unknown_endpoint"


def test_compiled_matches_greedy_host_base_params():
    fws = wrap_firewalls(
        [
            {
                "base": "https://{sub+}.example.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "read", "rules": ["GET /items/{id}"]},
                ],
            },
            {
                "base": "https://{sub*}.example.org",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [
                    {"name": "empty-read", "rules": ["GET /items/{id}"]},
                ],
            },
        ],
        name="example",
    )
    compiled_firewalls = compile_firewalls_or_fail(fws)
    policies = {
        "example": {
            "allow": ["read", "empty-read"],
            "deny": [],
            "unknownPolicy": "deny",
        }
    }

    url = "https://a.b.example.com/items/123"
    compiled = matching.match_compiled_firewall_request(
        url,
        "GET",
        compiled_firewalls,
        policies,
    )
    assert isinstance(compiled, matching.FirewallAllow)
    assert compiled.params == {"sub": "a.b", "id": "123"}

    url = "https://example.org/items/123"
    compiled = matching.match_compiled_firewall_request(
        url,
        "GET",
        compiled_firewalls,
        policies,
    )
    assert isinstance(compiled, matching.FirewallAllow)
    assert compiled.params == {"sub": "", "id": "123"}


def _aws_firewall():
    return wrap_firewalls(
        [
            {
                "base": "https://{awsHost+}.amazonaws.com",
                "auth": {
                    "awsSigv4": {
                        "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                        "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
                        "sessionToken": "${{ secrets.AWS_SESSION_TOKEN }}",
                    }
                },
                "permissions": [],
            },
            {
                "base": "https://{awsHost+}.amazonaws.com.cn",
                "auth": {
                    "awsSigv4": {
                        "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                        "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
                        "sessionToken": "${{ secrets.AWS_SESSION_TOKEN }}",
                    }
                },
                "permissions": [],
            },
            {
                "base": "https://{awsHost+}.api.aws",
                "auth": {
                    "awsSigv4": {
                        "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                        "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
                        "sessionToken": "${{ secrets.AWS_SESSION_TOKEN }}",
                    }
                },
                "permissions": [],
            },
        ],
        name="aws",
    )


@pytest.mark.parametrize(
    "url",
    [
        "https://sts.amazonaws.com/",
        "https://my-bucket.s3.us-west-2.amazonaws.com/key",
        "https://s3.dualstack.us-west-2.amazonaws.com/my-bucket",
        "https://ec2.us-west-2.api.aws/",
        "https://sts.cn-north-1.amazonaws.com.cn/",
    ],
)
def test_compiled_aws_auth_only_firewall_matches_aws_owned_endpoints(url):
    policies = {"aws": {"allow": [], "deny": [], "unknownPolicy": "allow"}}

    result = matching.match_compiled_firewall_request(
        url,
        "GET",
        compile_firewalls_or_fail(_aws_firewall()),
        policies,
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.permission is None


@pytest.mark.parametrize(
    "url",
    [
        "https://minio.example.com/my-bucket",
        "https://s3.amazonaws.com.evil.example/my-bucket",
        "https://evilamazonaws.com/",
        "https://api.aws.evil.example/",
    ],
)
def test_compiled_aws_auth_only_firewall_rejects_custom_or_lookalike_domains(url):
    policies = {"aws": {"allow": [], "deny": [], "unknownPolicy": "allow"}}

    result = matching.match_compiled_firewall_request(
        url,
        "GET",
        compile_firewalls_or_fail(_aws_firewall()),
        policies,
    )

    assert result is None
