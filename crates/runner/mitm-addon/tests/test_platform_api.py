"""Integration tests for shared platform API request construction."""

import uuid
from unittest.mock import patch

import pytest

import platform_api


class TestNormalizeProxyUrl:
    @pytest.mark.parametrize(
        ("proxy_url", "expected"),
        [
            pytest.param(
                "proxy-user:proxy-password@faß.proxy:8123",
                "proxy-user:proxy-password@xn--fa-hia.proxy:8123",
                id="authority",
            ),
            pytest.param(
                "//proxy-user:proxy-password@faß.proxy:8123",
                "//proxy-user:proxy-password@xn--fa-hia.proxy:8123",
                id="prefixed-authority",
            ),
            pytest.param(
                "http://proxy-user:proxy-password@faß.proxy:8123",
                "http://proxy-user:proxy-password@xn--fa-hia.proxy:8123",
                id="url",
            ),
            pytest.param(
                "[2001:0DB8:0:0:0:0:0:1]:8443",
                "[2001:db8::1]:8443",
                id="ipv6-authority",
            ),
        ],
    )
    def test_canonicalizes_hostname_and_preserves_proxy_form(
        self,
        proxy_url: str,
        expected: str,
    ):
        assert platform_api.normalize_proxy_url(proxy_url) == expected


class TestMakeApiRequest:
    def test_builds_platform_api_request_with_standard_headers(self, mitm_ctx):
        with (
            mitm_ctx(
                client_session_id="runner-session-direct",
                client_version="runner-version-direct",
            ),
            patch.object(platform_api, "VERCEL_BYPASS", ""),
        ):
            req = platform_api.make_api_request(
                "https://api.okou.ai/api/webhooks/run/firewall/auth",
                b"{}",
                "tok-xyz",
            )

        assert req.full_url == "https://api.okou.ai/api/webhooks/run/firewall/auth"
        assert req.data == b"{}"
        headers = dict(req.header_items())
        assert headers["Content-type"] == "application/json"
        assert headers["Authorization"] == "Bearer tok-xyz"
        assert headers["User-agent"] == "vm0-mitm-addon/1.0"
        normalized_headers = {name.lower(): value for name, value in headers.items()}
        assert normalized_headers["x-client-version"] == "runner-version-direct"
        assert normalized_headers["x-client-type"] == "MitmAddon"
        assert normalized_headers["x-client-session-id"] == "runner-session-direct"
        uuid.UUID(normalized_headers["x-client-request-id"])

    def test_marks_credentials_as_unredirected(self, mitm_ctx):
        with (
            mitm_ctx(),
            patch.object(platform_api, "VERCEL_BYPASS", "secret-bypass-value"),
        ):
            req = platform_api.make_api_request(
                "https://api.okou.ai/api/webhooks/run/firewall/auth",
                b"{}",
                "tok-xyz",
            )

        redirected_headers = {name.lower(): value for name, value in req.headers.items()}
        unredirected_headers = {
            name.lower(): value for name, value in req.unredirected_hdrs.items()
        }
        assert "authorization" not in redirected_headers
        assert "x-vercel-protection-bypass" not in redirected_headers
        assert unredirected_headers["authorization"] == "Bearer tok-xyz"
        assert unredirected_headers["x-vercel-protection-bypass"] == "secret-bypass-value"

    @pytest.mark.parametrize(
        ("url", "expected"),
        [
            pytest.param(
                "https://faß.de.:443/base?event=1#batch",
                "https://xn--fa-hia.de:443/base?event=1#batch",
                id="unicode",
            ),
            pytest.param(
                "https://xn--fa-hia.de/base",
                "https://xn--fa-hia.de/base",
                id="alabel",
            ),
            pytest.param(
                "https://api。okou.ai/base",
                "https://api.okou.ai/base",
                id="idna-dot",
            ),
            pytest.param(
                "http://192.0.2.10:8080/base",
                "http://192.0.2.10:8080/base",
                id="ipv4",
            ),
            pytest.param(
                "https://[2001:0DB8:0:0:0:0:0:1]:8443/base",
                "https://[2001:db8::1]:8443/base",
                id="ipv6",
            ),
        ],
    )
    def test_canonicalizes_platform_hostname_identity(self, url: str, expected: str):
        req = platform_api.make_api_request(url, b"{}", "tok-xyz")

        assert req.full_url == expected

    @pytest.mark.parametrize(
        "url",
        [
            pytest.param(
                "https://\uff26\uff2f\uff2f.okou.ai/base",
                id="unsafe-compatibility-alias",
            ),
            pytest.param("http://127.1/base", id="noncanonical-ipv4"),
        ],
    )
    def test_rejects_noncanonical_platform_hostname_identity(self, url: str):
        with pytest.raises(UnicodeError):
            platform_api.make_api_request(url, b"{}", "tok-xyz")

    @pytest.mark.parametrize(
        ("url", "message"),
        [
            pytest.param(
                "https://user:secret@api.okou.ai/base",
                "user information",
                id="userinfo",
            ),
            pytest.param("https://api.okou.ai:/base", "invalid port", id="empty-port"),
            pytest.param("https://api.okou.ai:65536/base", "invalid port", id="port-range"),
        ],
    )
    def test_rejects_invalid_platform_authority(self, url: str, message: str):
        with pytest.raises(ValueError, match=message):
            platform_api.make_api_request(url, b"{}", "tok-xyz")

    def test_malformed_platform_authority_does_not_expose_credentials(self):
        password = "sensitive-platform-password"
        url = f"https://platform-user:{password}@api\uff1aokou.ai/base"

        with pytest.raises(ValueError, match="Platform API URL is invalid") as exc_info:
            platform_api.make_api_request(url, b"{}", "tok-xyz")

        assert password not in str(exc_info.value)
        assert url not in str(exc_info.value)

    @pytest.mark.parametrize(
        "url",
        [
            pytest.param("file:///etc/passwd", id="file"),
            pytest.param("ftp://example.com/api", id="ftp"),
            pytest.param(
                "//api.okou.ai/api/webhooks/run/firewall/auth",
                id="scheme-relative",
            ),
            pytest.param("https:path-without-host", id="https-without-host"),
        ],
    )
    def test_rejects_non_absolute_http_urls(self, url: str):
        with pytest.raises(ValueError, match="absolute http"):
            platform_api.make_api_request(url, b"{}", "tok-xyz")
