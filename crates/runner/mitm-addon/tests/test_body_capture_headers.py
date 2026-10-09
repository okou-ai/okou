"""Tests for captured network-log header sanitization."""

import pytest
from mitmproxy import http

from body_capture import _sanitize_headers_for_capture as _sanitize_bounded_headers


def _sanitize_headers_for_capture(headers: http.Headers) -> dict[str, str]:
    captured, truncated = _sanitize_bounded_headers(headers)
    assert not truncated
    return captured


class TestSanitizeHeadersForCapture:
    @pytest.mark.parametrize(
        ("name", "value"),
        [
            ("Content-Type", "application/json"),
            ("Content-Type", "multipart/form-data"),
            ("Content-Length", "123"),
            ("Content-Length", "9" * 19),
            ("Content-Encoding", "gzip"),
            ("Accept-Encoding", "gzip, br"),
            ("Accept-Encoding", "GZIP;q=0.5, zstd;q=1"),
            ("Date", "Mon, 08 Jun 2026 03:29:48 GMT"),
            ("CONTENT-TYPE", "text/plain"),
        ],
    )
    def test_allowlisted_header_values_are_preserved(self, headers, name, value):
        result = _sanitize_headers_for_capture(headers((name, value)))
        assert result[name] == value

    @pytest.mark.parametrize(
        ("value", "expected"),
        [
            ("application/json; charset=utf-8", "application/json"),
            (" application/json ", "application/json"),
            (" application/json ; charset=utf-8", "application/json"),
            ('application/json; profile="https://app.example/secret-token"', "application/json"),
            ("application/json; boundary=\r\nsecret-token", "application/json"),
            ("multipart/form-data; boundary=secret-token", "multipart/form-data"),
            ("multipart/form-data; boundary=" + ("x" * 300), "multipart/form-data"),
        ],
    )
    def test_content_type_parameters_are_dropped(self, headers, value, expected):
        result = _sanitize_headers_for_capture(headers(("Content-Type", value)))
        assert result["Content-Type"] == expected

    @pytest.mark.parametrize(
        ("value", "expected"),
        [
            pytest.param(
                (" " * 256) + "application/json",
                "application/json",
                id="leading-at-limit",
            ),
            pytest.param(
                (" " * 257) + "application/json",
                "***",
                id="leading-over-limit",
            ),
            pytest.param(
                "application/json" + (" " * 256),
                "application/json",
                id="trailing-at-limit",
            ),
            pytest.param(
                "application/json" + (" " * 257),
                "***",
                id="trailing-over-limit",
            ),
            pytest.param(
                "application/json" + (" " * 256) + "; charset=utf-8",
                "application/json",
                id="before-parameter-at-limit",
            ),
            pytest.param(
                "application/json" + (" " * 257) + "; charset=utf-8",
                "***",
                id="before-parameter-over-limit",
            ),
        ],
    )
    def test_content_type_optional_whitespace_is_bounded(self, headers, value, expected):
        result = _sanitize_headers_for_capture(headers(("Content-Type", value)))
        assert result["Content-Type"] == expected

    @pytest.mark.parametrize(
        ("name", "value", "expected"),
        [
            ("Accept-Encoding", "\tgzip, br ", "gzip, br"),
            ("Content-Encoding", " gzip\t", "gzip"),
            ("Content-Length", "\t123 ", "123"),
            ("Date", "\tMon, 08 Jun 2026 03:29:48 GMT ", "Mon, 08 Jun 2026 03:29:48 GMT"),
        ],
    )
    def test_allowlisted_header_values_accept_http_optional_whitespace(
        self, headers, name, value, expected
    ):
        result = _sanitize_headers_for_capture(headers((name, value)))
        assert result[name] == expected

    @pytest.mark.parametrize(
        "value",
        [
            "Fri, 31 Feb 2026 03:29:48 GMT",
            "Thu, 31 Apr 2026 03:29:48 GMT",
            "Thu, 29 Feb 2025 03:29:48 GMT",
        ],
    )
    def test_imf_fixdate_values_with_impossible_dates_are_redacted(self, headers, value):
        result = _sanitize_headers_for_capture(headers(("Date", value)))
        assert result["Date"] == "***"

    @pytest.mark.parametrize(
        ("name", "value"),
        [
            ("Content-Type", "https://app.example/private/secret-token"),
            ("Content-Type", "secret-token/secret-token"),
            ("Content-Type", "application/x-secret-token"),
            ("Content-Type", "application/" + ("x" * 300)),
            pytest.param(
                "Content-Type",
                "application/x-secret-token; boundary=" + ("x" * 10_000),
                id="unsupported-type-with-large-parameter",
            ),
            ("Content-Type", "application/json\r\n"),
            ("Content-Length", "secret-token"),
            ("Content-Length", "1" * 20),
            ("Content-Encoding", "secret-token"),
            ("Content-Encoding", "gzip, https://app.example/private/secret-token"),
            ("Content-Encoding", "gzip\f, br"),
            ("Content-Encoding", "compre\u017fs"),
            ("Accept-Encoding", "secret-token"),
            ("Accept-Encoding", "gzip;q=0.5, secret-token;q=0.1"),
            ("Accept-Encoding", "gzip, https://app.example/private/secret-token"),
            ("Accept-Encoding", "gzip;q=0."),
            ("Accept-Encoding", "gzip;q=1."),
            ("Accept-Encoding", "gzip\v, br"),
            ("Accept-Encoding", "gzip\u2028, br"),
            ("Accept-Encoding", "\u2028gzip"),
            ("Accept-Encoding", "gzip\u2028"),
            ("Accept-Encoding", "ident\u0131ty"),
            ("Accept-Encoding", "z\u017ftd"),
            ("Content-Length", "\v123"),
            ("Content-Length", "123\x00"),
            ("Content-Length", "\u2028123"),
            ("Date", "secret-token"),
            ("Date", "\u2028Mon, 08 Jun 2026 03:29:48 GMT"),
            ("Date", "Mon, 08 Jun 2026 03:29:48 GMT secret-token"),
            ("Date", "Mon, 08 Jun 2026 03:29:48 GMT\r\n"),
            ("Date", "Mon, 08 Jun 2026 03:29:48 GMT\r\nSet-Cookie: session=secret"),
        ],
    )
    def test_allowlisted_header_names_with_unexpected_values_are_redacted(
        self, headers, name, value
    ):
        result = _sanitize_headers_for_capture(headers((name, value)))
        assert result[name] == "***"

    @pytest.mark.parametrize(
        "name",
        [
            "Authorization",
            "Cookie",
            "Set-Cookie",
            "Host",
            "Accept",
            "User-Agent",
            "Server",
            "X-Request-Id",
            "traceparent",
            "Tracestate",
        ],
    )
    def test_non_allowlisted_header_values_are_redacted(self, headers, name):
        result = _sanitize_headers_for_capture(headers((name, "captured-value")))
        assert result[name] == "***"

    def test_non_allowlisted_overlong_header_values_are_redacted(self, headers):
        result = _sanitize_headers_for_capture(headers(("Authorization", "x" * 10_000)))
        assert result["Authorization"] == "***"

    def test_overlong_allowlisted_header_values_are_redacted(self, headers):
        result = _sanitize_headers_for_capture(
            headers(
                ("Content-Length", "1" * 257),
                ("Accept-Encoding", ", ".join(["gzip"] * 60)),
            )
        )
        assert result["Content-Length"] == "***"
        assert result["Accept-Encoding"] == "***"

    def test_redacts_non_allowlisted_keeps_allowlisted(self, headers):
        headers = headers(
            ("Content-Type", "application/json"),
            ("Authorization", "Bearer sk-secret-123"),
            ("Host", "api.example.com"),
            ("Cookie", "session=abc"),
            ("Date", "Mon, 08 Jun 2026 03:29:48 GMT"),
        )
        result = _sanitize_headers_for_capture(headers)
        assert result["Content-Type"] == "application/json"
        assert result["Authorization"] == "***"
        assert result["Host"] == "***"
        assert result["Cookie"] == "***"
        assert result["Date"] == "Mon, 08 Jun 2026 03:29:48 GMT"

    def test_allowlist_does_not_normalize_nonstandard_separators(self, headers):
        result = _sanitize_headers_for_capture(headers(("Content_Type", "application/json")))
        assert result["Content_Type"] == "***"

    def test_invalid_header_names_are_redacted(self, headers):
        result = _sanitize_headers_for_capture(
            headers(
                ("X-Bad\r\nInjected: secret", "application/json"),
                ("X-" + ("a" * 300), "gzip"),
                ("Content-Type", "application/json"),
            )
        )
        assert result["[redacted-header-name]"] == "***"
        assert "X-Bad\r\nInjected: secret" not in result
        assert "X-" + ("a" * 300) not in result
        assert result["Content-Type"] == "application/json"
        assert len(result) == 2

    def test_duplicate_headers_keeps_first_case_insensitive(self, headers):
        headers = headers(
            ("Content-Type", "application/json"),
            ("content-type", "text/plain"),
            ("X-Request-Id", "req-first"),
            ("x-request-id", "req-second"),
        )
        result = _sanitize_headers_for_capture(headers)
        assert result["Content-Type"] == "application/json"
        assert "content-type" not in result
        assert result["X-Request-Id"] == "***"
        assert "x-request-id" not in result
        assert len(result) == 2

    @pytest.mark.parametrize(
        ("name", "value"),
        [
            (
                "Location",
                "https://hooks.slack.com/services/T000/B000/secret-token?code=secret",
            ),
            ("Content-Location", "/objects/secret-token?signature=secret"),
            ("Referer", "https://app.example/invite/secret-token?utm=secret"),
            ("Referrer", "/previous/secret-token?pii=secret"),
            (
                "Link",
                '<https://download.example/reset/secret-token?expires=secret>; rel="next"',
            ),
        ],
    )
    def test_reported_url_path_headers_are_redacted(self, headers, name, value):
        result = _sanitize_headers_for_capture(headers((name, value)))
        assert result[name] == "***"

    @pytest.mark.parametrize(
        ("name", "value"),
        [
            ("X-Callback-URL", "https://callback.example/private/secret-token"),
            ("X-Webhook-Endpoint", "https://hooks.example/service/secret-token"),
            ("Next-Page", "https://api.example/items?cursor=secret"),
            ("Download-Target", "/downloads/secret-token"),
        ],
    )
    def test_custom_nonstandard_url_like_headers_are_redacted(self, headers, name, value):
        result = _sanitize_headers_for_capture(headers((name, value)))
        assert result[name] == "***"
