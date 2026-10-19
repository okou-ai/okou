"""Trusted request authority URL utility tests."""

import pytest
from mitmproxy import http

from request_authority import get_trusted_authority

_MAX_HOST_HEADER_BYTES = 4096


class _DecodeGuardHost(bytes):
    def decode(self, encoding: str = "utf-8", errors: str = "strict") -> str:
        raise AssertionError("untrusted Host must not be decoded")


class TestTrustedAuthorityUrl:
    @pytest.mark.parametrize(
        ("scheme", "port", "expected_url"),
        [
            pytest.param("https", 443, "https://example.com/", id="https-default-port"),
            pytest.param("http", 80, "http://example.com/", id="http-default-port"),
            pytest.param("https", 8443, "https://example.com:8443/", id="https-non-default-port"),
            pytest.param("http", 8080, "http://example.com:8080/", id="http-non-default-port"),
            pytest.param("https", 80, "https://example.com:80/", id="https-explicit-http-port"),
            pytest.param("http", 443, "http://example.com:443/", id="http-explicit-https-port"),
        ],
    )
    def test_omits_only_scheme_default_ports(self, real_flow, scheme, port, expected_url):
        flow = real_flow(host="example.com", port=port, scheme=scheme)
        trusted = get_trusted_authority(flow)
        assert trusted.host == "example.com"
        assert trusted.port == port
        assert trusted.url == expected_url

    def test_https_non_standard_port(self, real_flow):
        # Pins two invariants at once for the #10082 regression:
        # - scheme comes from the TLS handshake, not from the port (so
        #   :8443 stays ``https://``, not ``http://`` as before the fix);
        # - the destination port is included even when the Host header
        #   has no port (the Host-lacks-port precondition is asserted
        #   below — mitmproxy's ``pretty_url`` would drop the port here,
        #   which is why we don't use it).
        flow = real_flow(host="example.com", port=8443)
        assert flow.request.headers.get("Host") == "example.com"
        trusted = get_trusted_authority(flow)
        assert trusted.host == "example.com"
        assert trusted.port == 8443
        assert trusted.url == "https://example.com:8443/"

    def test_with_path_and_query(self, real_flow):
        flow = real_flow(host="api.example.com", port=443, path="/v1/data?key=val")
        trusted = get_trusted_authority(flow)
        assert trusted.host == "api.example.com"
        assert trusted.port == 443
        assert trusted.url == "https://api.example.com/v1/data?key=val"

    @pytest.mark.parametrize(
        ("port", "expected_url"),
        [
            pytest.param(443, "https://api.example.com", id="default-port"),
            pytest.param(8443, "https://api.example.com:8443", id="non-default-port"),
        ],
    )
    def test_asterisk_form_contributes_an_empty_uri_path(
        self,
        real_flow,
        port,
        expected_url,
    ):
        flow = real_flow(
            host="api.example.com",
            port=port,
            method="OPTIONS",
            path="*",
        )

        trusted = get_trusted_authority(flow)
        assert trusted.host == "api.example.com"
        assert trusted.port == port
        assert trusted.url == expected_url
        assert flow.request.path == "*"

    def test_https_uses_sni_for_transparent_destination(self, real_flow, headers):
        flow = real_flow(
            host="203.0.113.10",
            sni="api.example.com",
            path="/v1/data?key=val",
            request_headers=headers(("Host", "api.example.com")),
        )
        trusted = get_trusted_authority(flow)
        assert trusted.host == "api.example.com"
        assert trusted.port == 443
        assert trusted.url == "https://api.example.com/v1/data?key=val"

    def test_https_accepts_trailing_dot_authority_equivalence(self, real_flow, headers):
        flow = real_flow(
            host="203.0.113.10",
            sni="api.example.com.",
            path="/v1/data",
            request_headers=headers(("Host", "API.EXAMPLE.COM.")),
        )
        trusted = get_trusted_authority(flow)
        assert trusted.host == "api.example.com"
        assert trusted.port == 443
        assert trusted.url == "https://api.example.com/v1/data"

    def test_http_uses_request_host_not_host_header(self, real_flow, headers):
        flow = real_flow(
            scheme="http",
            host="203.0.113.10",
            port=80,
            path="/v1/data",
            request_headers=headers(("Host", "api.example.com")),
        )
        trusted = get_trusted_authority(flow)
        assert trusted.host == "203.0.113.10"
        assert trusted.port == 80
        assert trusted.url == "http://203.0.113.10/v1/data"

    def test_http_does_not_decode_host_header(self, real_flow):
        request_headers = http.Headers(
            [(b"Host", _DecodeGuardHost(b"x" * (_MAX_HOST_HEADER_BYTES + 1)))]
        )
        flow = real_flow(
            scheme="http",
            host="203.0.113.10",
            port=80,
            path="/v1/data",
            request_headers=request_headers,
        )

        trusted = get_trusted_authority(flow)

        assert trusted.host == "203.0.113.10"
        assert trusted.port == 80
        assert trusted.url == "http://203.0.113.10/v1/data"

    def test_http_brackets_ipv6_request_host(self, real_flow, headers):
        flow = real_flow(
            scheme="http",
            host="2001:db8::1",
            port=8080,
            path="/v1/data",
            request_headers=headers(("Host", "api.example.com")),
        )
        trusted = get_trusted_authority(flow)
        assert trusted.host == "2001:db8::1"
        assert trusted.port == 8080
        assert trusted.url == "http://[2001:db8::1]:8080/v1/data"

    def test_https_brackets_ipv6_sni(self, real_flow, headers):
        flow = real_flow(
            host="2001:db8::1",
            port=8443,
            sni="2001:db8::1",
            path="/v1/data",
            request_headers=headers(("Host", "[2001:db8::1]")),
        )
        trusted = get_trusted_authority(flow)
        assert trusted.host == "2001:db8::1"
        assert trusted.port == 8443
        assert trusted.url == "https://[2001:db8::1]:8443/v1/data"


class TestTrustedAuthoritySuccess:
    def test_accepts_exact_raw_host_header_byte_budget(self, real_flow, headers):
        host_prefix = "bücher.example:"
        host_suffix = "443"
        zero_padding = "0" * (
            _MAX_HOST_HEADER_BYTES - len(host_prefix.encode()) - len(host_suffix.encode())
        )
        host_header = f"{host_prefix}{zero_padding}{host_suffix}"
        assert len(host_header.encode()) == _MAX_HOST_HEADER_BYTES
        flow = real_flow(
            with_response=False,
            host="203.0.113.10",
            sni="xn--bcher-kva.example",
            path="/repos",
            request_headers=headers(("Host", host_header)),
        )

        trusted = get_trusted_authority(flow)

        assert trusted.host == "xn--bcher-kva.example"
        assert trusted.port == 443
        assert trusted.url == "https://xn--bcher-kva.example/repos"

    @pytest.mark.parametrize(
        "host_header",
        [
            pytest.param("api.github.com:443", id="explicit-default-port"),
            pytest.param("api.github.com:000443", id="zero-padded-default-port"),
        ],
    )
    def test_accepts_equivalent_host_authority_default_https_port(
        self, real_flow, headers, host_header
    ):
        flow = real_flow(
            with_response=False,
            host="203.0.113.10",
            sni="api.github.com",
            path="/repos",
            request_headers=headers(("Host", host_header)),
        )

        trusted = get_trusted_authority(flow)

        assert trusted.host == "api.github.com"
        assert trusted.port == 443
        assert trusted.url == "https://api.github.com/repos"

    @pytest.mark.parametrize(
        "host_header",
        [
            pytest.param("api.github.com", id="host-without-port"),
            pytest.param("api.github.com:8443", id="host-with-matching-port"),
        ],
    )
    def test_accepts_matching_non_default_host_authority_port(
        self, real_flow, headers, host_header
    ):
        flow = real_flow(
            with_response=False,
            host="203.0.113.10",
            port=8443,
            sni="api.github.com",
            path="/repos",
            request_headers=headers(("Host", host_header)),
        )

        trusted = get_trusted_authority(flow)

        assert trusted.host == "api.github.com"
        assert trusted.port == 8443
        assert trusted.url == "https://api.github.com:8443/repos"

    @pytest.mark.parametrize(
        ("request_port", "request_authority", "expected_url"),
        [
            pytest.param(
                443,
                "API.GITHUB.COM.",
                "https://api.github.com/repos",
                id="normalized-host",
            ),
            pytest.param(
                443,
                "api.github.com:000443",
                "https://api.github.com/repos",
                id="explicit-default-port",
            ),
            pytest.param(
                8443,
                "api.github.com:8443",
                "https://api.github.com:8443/repos",
                id="matching-nondefault-port",
            ),
        ],
    )
    def test_accepts_matching_http1_request_target_authority(
        self,
        real_flow,
        headers,
        request_port,
        request_authority,
        expected_url,
    ):
        flow = real_flow(
            with_response=False,
            host="203.0.113.10",
            port=request_port,
            sni="api.github.com",
            path="/repos",
            request_headers=headers(("Host", "api.github.com")),
        )
        flow.request.authority = request_authority

        trusted = get_trusted_authority(flow)

        assert flow.request.http_version == "HTTP/1.1"
        assert flow.request.authority == request_authority
        assert trusted.host == "api.github.com"
        assert trusted.port == request_port
        assert trusted.url == expected_url

    @pytest.mark.parametrize(
        "host_header",
        [
            pytest.param("[2001:db8::1]", id="ipv6-without-port"),
            pytest.param("[2001:db8::1]:8443", id="ipv6-with-matching-port"),
        ],
    )
    def test_accepts_matching_ipv6_host_authority(self, real_flow, headers, host_header):
        flow = real_flow(
            with_response=False,
            host="2001:db8::1",
            port=8443,
            sni="2001:db8::1",
            path="/repos",
            request_headers=headers(("Host", host_header)),
        )

        trusted = get_trusted_authority(flow)

        assert trusted.host == "2001:db8::1"
        assert trusted.port == 8443
        assert trusted.url == "https://[2001:db8::1]:8443/repos"

    def test_accepts_canonical_ipv6_host_authority(self, real_flow, headers):
        flow = real_flow(
            with_response=False,
            host="2001:0db8::1",
            port=8443,
            sni="2001:0db8::1",
            path="/repos",
            request_headers=headers(("Host", "[2001:db8::1]:8443")),
        )

        trusted = get_trusted_authority(flow)

        assert trusted.host == "2001:db8::1"
        assert trusted.port == 8443
        assert trusted.url == "https://[2001:db8::1]:8443/repos"

    @pytest.mark.parametrize(
        ("sni", "host_header", "expected_host", "expected_url"),
        [
            pytest.param(
                "api.github.com",
                "API.GITHUB.COM",
                "api.github.com",
                "https://api.github.com/repos",
                id="case-insensitive-host",
            ),
            pytest.param(
                "API.GITHUB.COM.",
                "api.github.com.",
                "api.github.com",
                "https://api.github.com/repos",
                id="trailing-dot",
            ),
            pytest.param(
                "bücher.example",
                "xn--bcher-kva.example",
                "xn--bcher-kva.example",
                "https://xn--bcher-kva.example/repos",
                id="unicode-sni-punycode-host",
            ),
            pytest.param(
                "xn--bcher-kva.example",
                "bücher.example",
                "xn--bcher-kva.example",
                "https://xn--bcher-kva.example/repos",
                id="punycode-sni-unicode-host",
            ),
            pytest.param(
                "xn--mgba3gch31f.example",
                "xn--mgba3gch31f.example",
                "xn--mgba3gch31f.example",
                "https://xn--mgba3gch31f.example/repos",
                id="persian-without-joiner",
            ),
            pytest.param(
                "faß.de",
                "xn--fa-hia.de",
                "xn--fa-hia.de",
                "https://xn--fa-hia.de/repos",
                id="eszett",
            ),
            pytest.param(
                "\u03c2.example",
                "xn--3xa.example",
                "xn--3xa.example",
                "https://xn--3xa.example/repos",
                id="greek-final-sigma",
            ),
            pytest.param(
                "a\u03a3.example",
                "xn--a-0mb.example",
                "xn--a-0mb.example",
                "https://xn--a-0mb.example/repos",
                id="greek-capital-sigma",
            ),
            pytest.param(
                "\u13be.example",
                "xn--09d.example",
                "xn--09d.example",
                "https://xn--09d.example/repos",
                id="cherokee-capital",
            ),
            pytest.param(
                "\uab8e.example",
                "xn--09d.example",
                "xn--09d.example",
                "https://xn--09d.example/repos",
                id="cherokee-small",
            ),
            pytest.param(
                "\u1fb3.example",
                "xn--mxaq.example",
                "xn--mxaq.example",
                "https://xn--mxaq.example/repos",
                id="greek-iota-subscript",
            ),
            pytest.param(
                "\u1f86.example",
                "xn--uxa190l.example",
                "xn--uxa190l.example",
                "https://xn--uxa190l.example/repos",
                id="greek-prosgegrammeni",
            ),
            pytest.param(
                "\u0345.example",
                "xn--uxa.example",
                "xn--uxa.example",
                "https://xn--uxa.example/repos",
                id="combining-ypogegrammeni",
            ),
            pytest.param(
                "\u1c82.example",
                "xn--n1a.example",
                "xn--n1a.example",
                "https://xn--n1a.example/repos",
                id="cyrillic-narrow-o",
            ),
            pytest.param(
                "\u1c85.example",
                "xn--r1a.example",
                "xn--r1a.example",
                "https://xn--r1a.example/repos",
                id="cyrillic-small-dze",
            ),
            pytest.param(
                "\U0001d6d3.example",
                "xn--4xa.example",
                "xn--4xa.example",
                "https://xn--4xa.example/repos",
                id="math-bold-small-final-sigma",
            ),
            pytest.param(
                "a\u0754.example",
                "xn--a-63c.example",
                "xn--a-63c.example",
                "https://xn--a-63c.example/repos",
                id="arabic-letter-bee",
            ),
            pytest.param(
                "z\u1fc3\u08f2\u17b6.example",
                "xn--z-cmbg264c9ov.example",
                "xn--z-cmbg264c9ov.example",
                "https://xn--z-cmbg264c9ov.example/repos",
                id="mixed-valid-idna",
            ),
            pytest.param(
                "\u0663\u067a.example",
                "xn--cib0c.example",
                "xn--cib0c.example",
                "https://xn--cib0c.example/repos",
                id="arabic-indic-digit-context",
            ),
            pytest.param(
                "\u0663\u067a\u0663.example",
                "xn--ciba2e.example",
                "xn--ciba2e.example",
                "https://xn--ciba2e.example/repos",
                id="arabic-indic-digit-sandwich",
            ),
            pytest.param(
                "a1\u0663.example",
                "xn--a1-iyd.example",
                "xn--a1-iyd.example",
                "https://xn--a1-iyd.example/repos",
                id="latin-digit-arabic-indic",
            ),
        ],
    )
    def test_accepts_authority_host_normalization_equivalence(
        self,
        real_flow,
        headers,
        sni,
        host_header,
        expected_host,
        expected_url,
    ):
        flow = real_flow(
            with_response=False,
            host="203.0.113.10",
            sni=sni,
            path="/repos",
            request_headers=headers(("Host", host_header)),
        )

        trusted = get_trusted_authority(flow)

        assert trusted.host == expected_host
        assert trusted.port == 443
        assert trusted.url == expected_url
