"""Tests for low-level firewall host matching."""

import pytest

import matching


class TestMatchHost:
    def test_exact_host(self):
        assert matching.match_host("api.github.com", "api.github.com") == {}

    def test_single_param(self):
        result = matching.match_host("acme.example.com", "{subdomain}.example.com")
        assert result == {"subdomain": "acme"}

    def test_single_param_no_match_multi_level(self):
        """Single {param} must not match multiple host segments."""
        result = matching.match_host("a.b.example.com", "{subdomain}.example.com")
        assert result is None

    def test_greedy_plus_matches_multi(self):
        result = matching.match_host("a.b.c.example.com", "{sub+}.example.com")
        assert result == {"sub": "a.b.c"}

    def test_greedy_plus_preserves_runtime_host_case(self):
        result = matching.match_host("Foo.Bar.example.com", "{sub+}.example.com")
        assert result == {"sub": "Foo.Bar"}

    def test_greedy_plus_matches_single(self):
        result = matching.match_host("x.example.com", "{sub+}.example.com")
        assert result == {"sub": "x"}

    def test_greedy_plus_rejects_zero(self):
        result = matching.match_host("example.com", "{sub+}.example.com")
        assert result is None

    def test_greedy_star_matches_multi(self):
        result = matching.match_host("a.b.example.com", "{sub*}.example.com")
        assert result == {"sub": "a.b"}

    def test_greedy_star_preserves_runtime_host_case(self):
        result = matching.match_host("Foo.Bar.example.com", "{sub*}.example.com")
        assert result == {"sub": "Foo.Bar"}

    def test_greedy_star_matches_zero(self):
        result = matching.match_host("example.com", "{sub*}.example.com")
        assert result == {"sub": ""}

    @pytest.mark.parametrize("pattern", ["foo.{sub+}.example.com", "foo.{sub*}.example.com"])
    def test_greedy_param_rejects_non_leading_position(self, pattern):
        assert matching.match_host("foo.bar.example.com", pattern) is None

    def test_literal_mismatch(self):
        assert matching.match_host("api.gitlab.com", "api.github.com") is None

    def test_case_insensitive(self):
        assert matching.match_host("API.GitHub.COM", "api.github.com") == {}

    def test_host_too_few_segments(self):
        assert matching.match_host("github.com", "api.github.com") is None

    def test_param_name_preserves_case(self):
        """Param names should preserve original case from the pattern."""
        result = matching.match_host("acme.example.com", "{Subdomain}.example.com")
        assert result is not None
        assert "Subdomain" in result
        assert result["Subdomain"] == "acme"


# =========================================================================
# match_path_prefix
# =========================================================================
