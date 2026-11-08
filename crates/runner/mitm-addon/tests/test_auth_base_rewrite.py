"""Tests for URL reconstruction and rewrite utilities."""

import urllib.parse
from collections.abc import Iterator

import pytest

import auth_base_rewrite


class _FailOnIterationQuery(str):
    def __iter__(self) -> Iterator[str]:
        raise AssertionError("original query must not be tokenized without trusted query sources")


class _FailOnContentScanBase(str):
    def __contains__(self, key: str) -> bool:
        raise AssertionError("oversized resolved base must be rejected before content scanning")


class TestBuildRewriteUrl:
    """Tests for build_rewrite_url pure URL construction."""

    def test_simple_base_no_rel_path(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://discord.com/api/webhooks/123/abc",
            "/",
            "",
        )
        assert url == "https://discord.com/api/webhooks/123/abc"

    def test_multi_segment_rel_path(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://example.com/base",
            "/a/b/c",
            "",
        )
        assert url == "https://example.com/base/a/b/c"

    def test_base_treats_single_terminal_slash_as_optional(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://example.com/base/",
            "/a",
            "",
        )
        assert url == "https://example.com/base/a"

    def test_base_preserves_repeated_terminal_empty_segments(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://example.com/base//",
            "/a",
            "",
        )
        assert url == "https://example.com/base//a"

    def test_root_base_preserves_repeated_terminal_empty_segments(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://example.com//",
            "/a",
            "",
        )
        assert url == "https://example.com//a"

    def test_base_with_query_no_orig_query(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://example.com/hook?token=secret",
            "/",
            "",
        )
        assert url == "https://example.com/hook?token=secret"

    def test_resolved_base_accepts_exact_character_limit(self):
        prefix = "https://example.com/"
        base = prefix + "x" * (auth_base_rewrite.MAX_RESOLVED_AUTH_BASE_CHARACTERS - len(prefix))

        url = auth_base_rewrite.build_rewrite_url(base, "/", "")

        assert len(base) == auth_base_rewrite.MAX_RESOLVED_AUTH_BASE_CHARACTERS
        assert url == base

    def test_oversized_resolved_base_rejected_before_content_scan(self):
        base = _FailOnContentScanBase(
            "x" * (auth_base_rewrite.MAX_RESOLVED_AUTH_BASE_CHARACTERS + 1)
        )

        with pytest.raises(ValueError, match="must not exceed 8192 characters"):
            auth_base_rewrite.build_rewrite_url(base, "/", "")

    def test_resolved_base_does_not_enter_global_parse_cache(self):
        urllib.parse.urlsplit.cache_clear()
        try:
            urllib.parse.urlsplit("https://stable-config.example.com")
            stable_cache = urllib.parse.urlsplit.cache_info()

            url = auth_base_rewrite.build_rewrite_url(
                "https://hooks.example.com/webhook/secret?token=trusted",
                "/events",
                "client=visible",
            )

            assert url == (
                "https://hooks.example.com/webhook/secret/events?token=trusted&client=visible"
            )
            assert urllib.parse.urlsplit.cache_info() == stable_cache
        finally:
            urllib.parse.urlsplit.cache_clear()

    def test_base_unicode_host_normalized_for_forwarding(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://bücher.example:8443/hook",
            "/sub",
            "",
        )
        assert url == "https://xn--bcher-kva.example:8443/hook/sub"

    def test_base_percent_encoded_host_normalized_for_forwarding(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://b%C3%BCcher.example/hook",
            "/sub",
            "",
        )
        assert url == "https://xn--bcher-kva.example/hook/sub"

    def test_base_explicit_default_port_preserved_for_forwarding(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://example.com:443/hook",
            "/sub",
            "",
        )
        assert url == "https://example.com:443/hook/sub"

    def test_base_unicode_path_and_query_are_encoded_for_forwarding(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://example.com/hook/路径?token=é",
            "/子",
            "from=请求",
        )
        assert (
            url == "https://example.com/hook/%E8%B7%AF%E5%BE%84/%E5%AD%90"
            "?token=%C3%A9&from=%E8%AF%B7%E6%B1%82"
        )

    def test_existing_percent_encoded_path_and_query_are_not_double_encoded(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://example.com/hook/%E8%B7%AF%E5%BE%84?token=%C3%A9",
            "/%E5%AD%90",
            "from=%E8%AF%B7%E6%B1%82",
        )
        assert (
            url == "https://example.com/hook/%E8%B7%AF%E5%BE%84/%E5%AD%90"
            "?token=%C3%A9&from=%E8%AF%B7%E6%B1%82"
        )

    @pytest.mark.parametrize(
        ("base", "message"),
        [
            ("https://example.com/hook#secret-fragment", "fragment"),
            ("https://example.com/hook\n", "whitespace"),
            ("https://example.com\\hook", "backslash"),
            ("https://example.com/\x00hook", "control characters or invalid Unicode"),
            ("https://example.com/\x7fhook", "control characters or invalid Unicode"),
            ("https://example.com/\ud800hook", "control characters or invalid Unicode"),
            ("ftp://example.com/hook", "scheme"),
            ("http://example.com/hook", "scheme must be https"),
            ("https:///hook", "missing host"),
            ("https://user:pass@example.com/hook", "userinfo"),
            ("https://exa mple.com/hook", "whitespace"),
            ("https://example.com:99999/hook", "Port out of range"),
            ("https://example.com:/hook", "invalid port"),
            ("https://[::1/hook", "Invalid IPv6 URL"),
            ("https://[v1.invalid]/hook", "invalid host"),
            ("https://example%2ecom/hook", "unsafe percent encoding"),
            ("https://example%2ccom/hook", "unsafe percent encoding"),
            ("https://example%3a443.com/hook", "invalid host"),
            ("https://{tenant}.example.com/hook", "invalid host"),
            ("https://example.com/hook/%2e%2e/admin", "unsafe path"),
            ("https://example.com/hook/..;matrix=1/admin", "unsafe path"),
            ("https://example.com/hook/%252e%252e/admin", "unsafe path"),
            ("https://example.com/hook/%/admin", "unsafe path"),
            ("https://example.com/hook/%zz/admin", "unsafe path"),
            ("https://example.com/hook/%25zz/admin", "unsafe path"),
            ("https://example.com/hook/%00/admin", "unsafe path"),
            ("https://example.com/hook/%2500/admin", "unsafe path"),
            ("https://example.com/hook/%7f/admin", "unsafe path"),
            ("https://example.com/hook/%ef%bc%8e%ef%bc%8e/admin", "unsafe path"),
            ("https://example.com/hook/%ef%bc%8f../admin", "unsafe path"),
            ("https://example.com/hook/%ef%bc%bcadmin", "unsafe path"),
            ("https://example.com/hook/%ef%bc%852e/admin", "unsafe path"),
            ("https://example.com/hook/%ff/admin", "unsafe path"),
            ("https://example.com/hook/%25ff/admin", "unsafe path"),
            ("https://example.com/hook/%ed%a0%80/admin", "unsafe path"),
            ("https://example.com/hook/%5csecret", "unsafe path"),
            ("https://example.com/hook/%5Csecret", "unsafe path"),
            ("https://example.com/hook/%255csecret", "unsafe path"),
            ("https://%7bparam%7d.example/hook", "unsafe percent encoding"),
            ("https://example%zz.com/hook", "invalid percent encoding"),
            ("https://api%FF.example.com/hook", "host has invalid percent encoding"),
            ("https://0177.0.0.1/hook", "invalid host"),
            ("https://0177.0.0.1?token=static", "invalid host"),
            ("https://0x7f.0.0.1/hook", "invalid host"),
            ("https://2130706433/hook", "invalid host"),
            ("https://127.1/hook", "invalid host"),
            ("https://127。0。0。1/hook", "invalid host"),
            ("https://127。0。0。1?token=static", "invalid host"),
            ("https://127.0.0.1。/hook", "invalid host"),
            ("https://\uff11\uff12\uff17.\uff10.\uff10.\uff11/hook", "invalid host"),
            ("https://fa\u212a.example/hook", "invalid host"),
            ("https://\u212a.example/hook", "invalid host"),
        ],
    )
    def test_invalid_resolved_base_rejected(self, base, message):
        with pytest.raises(ValueError, match=message):
            auth_base_rewrite.build_rewrite_url(
                base,
                "/",
                "",
            )

    @pytest.mark.parametrize(
        "resolved_query",
        [
            pytest.param(None, id="absent"),
            pytest.param({}, id="empty"),
        ],
    )
    def test_query_free_trusted_sources_do_not_tokenize_original_query(
        self,
        resolved_query: dict[str, str] | None,
    ):
        query = _FailOnIterationQuery(
            "blank=&;duplicate=first&&duplicate=second;encoded=%E8%AF%B7%E6%B1%82&unicode=请求"
        )

        url = auth_base_rewrite.build_rewrite_url(
            "https://example.com/hook",
            "/",
            query,
            resolved_query,
        )

        assert url == (
            "https://example.com/hook?blank=&;duplicate=first&&duplicate=second;"
            "encoded=%E8%AF%B7%E6%B1%82&unicode=%E8%AF%B7%E6%B1%82"
        )

    def test_base_query_allows_raw_at_sign(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://example.com/hook?token=a@b",
            "/",
            "",
        )
        assert url == "https://example.com/hook?token=a@b"

    def test_base_query_allows_encoded_backslash(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://example.com/hook?next=%5csecret",
            "/",
            "",
        )
        assert url == "https://example.com/hook?next=%5csecret"

    def test_rel_path_with_both_queries_merged(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://example.com/hook?token=abc",
            "/sub",
            "extra=1",
        )
        assert url == "https://example.com/hook/sub?token=abc&extra=1"

    def test_original_duplicate_query_key_dropped(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://example.com/hook?token=secret",
            "/",
            "token=attacker&wait=true",
        )
        assert url == "https://example.com/hook?token=secret&wait=true"

    def test_original_duplicate_query_key_followed_by_empty_segment_dropped(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://example.com/hook?token=secret",
            "/",
            "token=attacker&&wait=true",
        )
        assert url == "https://example.com/hook?token=secret&wait=true"

    def test_original_duplicate_query_key_preceded_by_empty_segment_dropped(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://example.com/hook?token=secret",
            "/",
            "wait=true&&token=attacker",
        )
        assert url == "https://example.com/hook?token=secret&wait=true"

    def test_all_original_duplicate_query_keys_dropped(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://example.com/hook?token=secret",
            "/",
            "token=first&token=second",
        )
        assert url == "https://example.com/hook?token=secret"

    def test_original_encoded_duplicate_query_key_dropped(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://example.com/hook?token=secret",
            "/",
            "to%6ben=attacker&wait=true",
        )
        assert url == "https://example.com/hook?token=secret&wait=true"

    def test_original_duplicate_of_encoded_trusted_base_query_key_dropped(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://example.com/hook?to%6ben=secret",
            "/",
            "token=attacker&wait=true",
        )
        assert url == "https://example.com/hook?to%6ben=secret&wait=true"

    def test_original_plus_encoded_duplicate_query_key_dropped(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://example.com/hook?api+key=secret",
            "/",
            "api%20key=attacker&wait=true",
        )
        assert url == "https://example.com/hook?api+key=secret&wait=true"

    def test_original_semicolon_duplicate_query_key_dropped(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://example.com/hook?token=secret",
            "/",
            "wait=true;token=attacker",
        )
        assert url == "https://example.com/hook?token=secret&wait=true"

    def test_original_semicolon_duplicate_before_kept_pair_uses_source_separator(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://example.com/hook?token=secret",
            "/",
            "token=attacker;wait=true",
        )
        assert url == "https://example.com/hook?token=secret&wait=true"

    def test_original_semicolon_duplicate_between_kept_pairs_uses_safe_separator(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://example.com/hook?token=secret",
            "/",
            "keep=1;token=attacker;wait=true",
        )
        assert url == "https://example.com/hook?token=secret&keep=1&wait=true"

    def test_duplicate_trusted_base_query_keys_preserved(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://example.com/hook?token=first&token=second",
            "/",
            "token=attacker&wait=true",
        )
        assert url == "https://example.com/hook?token=first&token=second&wait=true"

    def test_duplicate_trusted_base_query_keys_with_semicolon_preserved(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://example.com/hook?token=first;token=second",
            "/",
            "token=attacker&wait=true",
        )
        assert url == "https://example.com/hook?token=first;token=second&wait=true"

    def test_blank_trusted_base_query_value_is_authoritative(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://example.com/hook?token=",
            "/",
            "token=attacker&wait=true",
        )
        assert url == "https://example.com/hook?token=&wait=true"

    def test_valueless_trusted_base_query_key_is_authoritative(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://example.com/hook?token",
            "/",
            "token=attacker&wait=true",
        )
        assert url == "https://example.com/hook?token&wait=true"

    def test_empty_trusted_base_query_key_is_authoritative(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://example.com/hook?=secret",
            "/",
            "=attacker&wait=true",
        )
        assert url == "https://example.com/hook?=secret&wait=true"

    def test_empty_trusted_base_query_segments_do_not_block_empty_original_key(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://example.com/hook?&&region=us",
            "/",
            "=agent&q=test",
        )
        assert url == "https://example.com/hook?&&region=us&=agent&q=test"

    def test_auth_query_overrides_base_and_original_query(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://example.com/hook?api_key=base&region=us",
            "/",
            "api_key=agent&q=test",
            {"api_key": "trusted key"},
        )
        assert url == "https://example.com/hook?region=us&q=test&api_key=trusted+key"

    def test_auth_query_empty_key_overrides_base_and_original_empty_keys(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://example.com/hook?=base&region=us",
            "/",
            "=agent&q=test",
            {"": "trusted"},
        )
        assert url == "https://example.com/hook?region=us&q=test&=trusted"

    def test_auth_query_overrides_base_query_without_leading_empty_segment(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://example.com/hook?api_key=base&&region=us",
            "/",
            "q=test",
            {"api_key": "trusted key"},
        )
        assert url == "https://example.com/hook?region=us&q=test&api_key=trusted+key"

    def test_auth_query_overrides_base_query_without_trailing_empty_segment(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://example.com/hook?region=us&&api_key=base",
            "/",
            "q=test",
            {"api_key": "trusted key"},
        )
        assert url == "https://example.com/hook?region=us&q=test&api_key=trusted+key"

    def test_auth_query_overrides_all_lower_priority_duplicates(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://example.com/hook?api_key=base",
            "/",
            "api_key=agent",
            {"api_key": "trusted key"},
        )
        assert url == "https://example.com/hook?api_key=trusted+key"

    def test_auth_query_overrides_duplicate_trusted_base_query_keys(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://example.com/hook?api_key=first&api_key=second&region=us",
            "/",
            "api_key=agent&q=test",
            {"api_key": "trusted key"},
        )
        assert url == "https://example.com/hook?region=us&q=test&api_key=trusted+key"

    def test_auth_query_overrides_encoded_base_and_original_query_keys(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://example.com/hook?api%5Fkey=base&region=us",
            "/",
            "api%5fkey=agent&q=test",
            {"api_key": "trusted key"},
        )
        assert url == "https://example.com/hook?region=us&q=test&api_key=trusted+key"

    def test_auth_query_overrides_plus_encoded_lower_priority_keys(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://example.com/hook?api+key=base&region=us",
            "/",
            "api%20key=agent&q=test",
            {"api key": "trusted key"},
        )
        assert url == "https://example.com/hook?region=us&q=test&api+key=trusted+key"

    def test_auth_query_overrides_semicolon_base_without_prefixing_kept_pair(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://example.com/hook?api_key=base;region=us",
            "/",
            "q=test",
            {"api_key": "trusted key"},
        )
        assert url == "https://example.com/hook?region=us&q=test&api_key=trusted+key"

    def test_auth_query_overrides_semicolon_base_between_kept_pairs(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://example.com/hook?tenant=one;api_key=base;region=us",
            "/",
            "q=test",
            {"api_key": "trusted key"},
        )
        assert url == "https://example.com/hook?tenant=one&region=us&q=test&api_key=trusted+key"

    def test_auth_query_filter_preserves_existing_semicolon_value(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://example.com/hook?redirect=a;b&api_key=base&region=us",
            "/",
            "q=test",
            {"api_key": "trusted key"},
        )
        assert url == "https://example.com/hook?redirect=a;b&region=us&q=test&api_key=trusted+key"

    def test_base_path_params_are_preserved(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://example.com/hook;v=1?token=abc",
            "/sub;mode=fast",
            "extra=1",
        )
        assert url == "https://example.com/hook;v=1/sub;mode=fast?token=abc&extra=1"

    def test_trailing_slash_on_base_deduped(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://example.com/hook/",
            "/sub",
            "",
        )
        assert url == "https://example.com/hook/sub"

    def test_root_rel_path_keeps_base_path(self):
        url = auth_base_rewrite.build_rewrite_url(
            "https://example.com/hook",
            "/",
            "",
        )
        assert url == "https://example.com/hook"

    @pytest.mark.parametrize(
        "rel_path",
        [
            "/admin\\settings",
            "/./admin",
            "/../admin",
            "/%2e/admin",
            "/%2e%2e/admin",
            "/%2e%2e%2fadmin",
            "/..;matrix=1/admin",
            "/%252e%252e/admin",
            "/%252e%252e%252fadmin",
            "/%/admin",
            "/%zz/admin",
            "/%25zz/admin",
            "/%00/admin",
            "/%2500/admin",
            "/%7f/admin",
            "/%ef%bc%8e%ef%bc%8e/admin",
            "/%ef%bc%8f../admin",
            "/%ef%bc%bcadmin",
            "/%ef%bc%852e/admin",
            "/%ff/admin",
            "/%25ff/admin",
            "/%ed%a0%80/admin",
            "/%5cadmin",
            "/%5Cadmin",
            "/%5c..%5cadmin",
            "/%5C..%5Cadmin",
            "/%255cadmin",
        ],
    )
    def test_unsafe_rel_path_is_rejected(self, rel_path):
        with pytest.raises(ValueError, match="Unsafe rewrite path"):
            auth_base_rewrite.build_rewrite_url(
                "https://example.com/hook",
                rel_path,
                "",
            )
