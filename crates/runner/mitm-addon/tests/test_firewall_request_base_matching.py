"""Raw firewall request base matching tests through the compiled matcher."""

import matching
from tests.firewall_helpers import grant_all, match_request_with_raw_firewalls, wrap_firewalls


class TestFirewallRequestBaseMatching:
    """Tests for request-layer base URL matching through raw firewall config."""

    def test_exact_base_no_path(self):
        """URL equals base exactly (rest='') → rel_path='/' → matches root rule."""
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "root", "rules": ["GET /"]}],
                }
            ]
        )
        result = match_request_with_raw_firewalls(
            "https://api.github.com", "GET", fw_configs, network_policies=grant_all(fw_configs)
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.permission == "root"

    def test_trailing_slash_on_url(self):
        """A trailing slash is a distinct path segment for permission rules."""
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "p", "rules": ["GET /repos"]}],
                }
            ]
        )
        result = match_request_with_raw_firewalls(
            "https://api.github.com/repos/",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallBlock)
        assert result.reason == "unknown_endpoint"

    def test_trailing_slash_on_base_config(self):
        """Base URL with trailing slash still matches (rstrip strips it)."""
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://api.github.com/",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "p", "rules": ["GET /repos"]}],
                }
            ]
        )
        result = match_request_with_raw_firewalls(
            "https://api.github.com/repos",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallAllow)

    def test_port_boundary_rejected(self):
        """Port in URL (rest starts with ':') is not a valid path boundary."""
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "p", "rules": ["ANY /{path+}"]}],
                }
            ]
        )
        result = match_request_with_raw_firewalls(
            "https://api.github.com:8443/repos",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert result is None

    def test_evil_domain_not_matched(self):
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://api.github.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "p", "rules": ["ANY /{path+}"]}],
                }
            ]
        )
        result = match_request_with_raw_firewalls(
            "https://api.github.com.evil.com/steal",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert result is None

    def test_parameterized_host_allows(self):
        """Base URL with {subdomain} in host matches dynamically."""
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://{subdomain}.example.com",
                    "auth": {"headers": {"Authorization": "Basic ${{ secrets.AUTH }}"}},
                    "permissions": [{"name": "tickets", "rules": ["GET /api/v2/tickets"]}],
                }
            ],
            name="test-subdomain",
        )
        result = match_request_with_raw_firewalls(
            "https://acme.example.com/api/v2/tickets",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.name == "test-subdomain"
        assert result.permission == "tickets"
        assert result.params == {"subdomain": "acme"}

    def test_parameterized_host_blocks_no_permission(self):
        """Base URL with host param matches but no rule → block."""
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://{subdomain}.example.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "tickets", "rules": ["GET /api/v2/tickets"]}],
                }
            ],
            name="test-subdomain",
        )
        result = match_request_with_raw_firewalls(
            "https://acme.example.com/api/v2/users",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallBlock)
        assert result.name == "test-subdomain"

    def test_parameterized_host_no_match_returns_none(self):
        """Different domain entirely → None (pass-through)."""
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://{subdomain}.example.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "p", "rules": ["ANY /{path+}"]}],
                }
            ]
        )
        result = match_request_with_raw_firewalls(
            "https://api.github.com/repos",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert result is None

    def test_parameterized_path_allows(self):
        """Base URL with {param} in path matches dynamically."""
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://api.example.com/v1/{org}",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "projects", "rules": ["GET /projects/{id}"]}],
                }
            ]
        )
        result = match_request_with_raw_firewalls(
            "https://api.example.com/v1/acme/projects/123",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.params == {"org": "acme", "id": "123"}

    def test_parameterized_host_and_path(self):
        """Both host and path params extracted."""
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://{tenant}.api.example.com/v1/{org}",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "data", "rules": ["GET /data"]}],
                }
            ]
        )
        result = match_request_with_raw_firewalls(
            "https://us.api.example.com/v1/acme/data",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.params == {"tenant": "us", "org": "acme"}

    def test_greedy_host_param_matches_multi_level(self):
        """Greedy {sub+} in host matches multiple subdomain levels."""
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://{sub+}.example.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "p", "rules": ["GET /api"]}],
                }
            ]
        )
        result = match_request_with_raw_firewalls(
            "https://a.b.c.example.com/api",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.params["sub"] == "a.b.c"

    def test_greedy_star_host_param_matches_zero(self):
        """Greedy {sub*} in host matches zero subdomains."""
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://{sub*}.example.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "p", "rules": ["GET /api"]}],
                }
            ]
        )
        result = match_request_with_raw_firewalls(
            "https://example.com/api", "GET", fw_configs, network_policies=grant_all(fw_configs)
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.params["sub"] == ""

    def test_mixed_static_and_parameterized_bases(self):
        """Static and parameterized bases in same config both work."""
        fw_configs = [
            {
                "name": "github",
                "apis": [
                    {
                        "base": "https://api.github.com",
                        "auth": {"headers": {}},
                        "permissions": [{"name": "p", "rules": ["ANY /{path+}"]}],
                    }
                ],
            },
            {
                "name": "test-subdomain",
                "apis": [
                    {
                        "base": "https://{sub}.example.com",
                        "auth": {"headers": {}},
                        "permissions": [{"name": "p", "rules": ["ANY /{path+}"]}],
                    }
                ],
            },
        ]
        gh = match_request_with_raw_firewalls(
            "https://api.github.com/repos",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(gh, matching.FirewallAllow)
        assert gh.name == "github"

        zd = match_request_with_raw_firewalls(
            "https://acme.example.com/api/v2/tickets",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(zd, matching.FirewallAllow)
        assert zd.name == "test-subdomain"
        assert zd.params["sub"] == "acme"

    def test_parameterized_host_with_query_string(self):
        """Parameterized base URL + query string in request."""
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://{sub}.example.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "tickets", "rules": ["GET /api/v2/tickets"]}],
                }
            ]
        )
        result = match_request_with_raw_firewalls(
            "https://acme.example.com/api/v2/tickets?page=2",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert isinstance(result, matching.FirewallAllow)
        assert result.params["sub"] == "acme"

    def test_parameterized_host_rejects_nonstandard_port(self):
        """Non-standard port must NOT match — prevents auth header leaking to rogue server."""
        fw_configs = wrap_firewalls(
            [
                {
                    "base": "https://{sub}.example.com",
                    "auth": {"headers": {}},
                    "permissions": [{"name": "p", "rules": ["ANY /{path+}"]}],
                }
            ]
        )
        result = match_request_with_raw_firewalls(
            "https://acme.example.com:8443/api",
            "GET",
            fw_configs,
            network_policies=grant_all(fw_configs),
        )
        assert result is None
