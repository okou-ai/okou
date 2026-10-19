"""HTTP protocol, bounds, and cleanup tests for auth.base forwarding."""

from unittest.mock import patch

import h11
import pytest

import auth_base_forwarder as forwarder
import auth_base_transport as transport
from tests.auth_base_forwarder_helpers import FakeSocket, fake_forwarder_upstream


class TestAuthBaseForwarderRequestBehavior:
    async def test_returns_redirect_response_without_following(self):
        with fake_forwarder_upstream(
            status=302,
            body=b"",
            headers=[("Location", "https://evil.example.com")],
        ):
            status, body, headers = await forwarder.forward_request(
                "https://example.com/redirect",
                "GET",
                [],
                None,
            )

        assert status == 302
        assert body == b""
        assert headers["Location"] == "https://evil.example.com"

    async def test_repeated_request_headers_are_written_individually(self):
        with fake_forwarder_upstream() as upstream:
            await forwarder.forward_request(
                "https://example.com/path?x=1",
                "GET",
                [("X-Repeat", "one"), ("X-Repeat", "two")],
                None,
            )

        assert upstream.socket.request_lines()[0] == "GET /path?x=1 HTTP/1.1"
        assert upstream.socket.request_header_values("Host") == ["example.com"]
        assert upstream.socket.request_header_values("X-Repeat") == ["one", "two"]
        assert upstream.socket.request_header_values("Content-Length") == []

    async def test_absent_body_strips_stale_content_length(self):
        with fake_forwarder_upstream() as upstream:
            await forwarder.forward_request(
                "https://example.com/path",
                "POST",
                [("Content-Length", "999"), ("X-Keep", "ok")],
                None,
            )

        assert upstream.socket.request_header_values("Content-Length") == []
        assert upstream.socket.request_header_values("X-Keep") == ["ok"]
        assert upstream.socket.request_text().endswith("\r\n\r\n")

    @pytest.mark.parametrize(
        ("url", "expected_target"),
        [
            pytest.param(
                "https://example.com?wait=true",
                "/?wait=true",
                id="root-query",
            ),
            pytest.param(
                "https://example.com/path?x=1#client-only-secret",
                "/path?x=1",
                id="omit-fragment",
            ),
            pytest.param(
                "https://example.com/%2Fsecret/a%20b?x=a%2Fb&x=&space=a+b",
                "/%2Fsecret/a%20b?x=a%2Fb&x=&space=a+b",
                id="encoded-path-duplicate-query",
            ),
            pytest.param(
                "https://example.com/hook;v=1/sub;mode=fast?x=1",
                "/hook;v=1/sub;mode=fast?x=1",
                id="path-params",
            ),
        ],
    )
    async def test_request_target_preserves_url_parts(self, url: str, expected_target: str):
        with fake_forwarder_upstream() as upstream:
            await forwarder.forward_request(url, "GET", [], None)

        assert upstream.socket.request_lines()[0] == f"GET {expected_target} HTTP/1.1"

    @pytest.mark.parametrize(
        (
            "url",
            "expected_dns_host",
            "expected_connection_port",
            "expected_host_header",
        ),
        [
            pytest.param(
                "https://example.com:443/path",
                "example.com",
                443,
                "example.com",
                id="https-default-port",
            ),
            pytest.param(
                "https://[2001:4860:4860::8888]:444/path",
                "2001:4860:4860::8888",
                444,
                "[2001:4860:4860::8888]:444",
                id="ipv6-non-default-port",
            ),
            pytest.param(
                "https://[2001:4860:4860::8888]/path",
                "2001:4860:4860::8888",
                443,
                "[2001:4860:4860::8888]",
                id="ipv6-no-port",
            ),
            pytest.param(
                "https://[2001:4860:4860::8888]:443/path",
                "2001:4860:4860::8888",
                443,
                "[2001:4860:4860::8888]",
                id="ipv6-https-default-port",
            ),
            pytest.param(
                "https://[2001:4860:4860::8888]:80/path",
                "2001:4860:4860::8888",
                80,
                "[2001:4860:4860::8888]:80",
                id="ipv6-https-http-default-port",
            ),
        ],
    )
    async def test_url_authority_sets_connection_target_and_host_header(
        self,
        url: str,
        expected_dns_host: str,
        expected_connection_port: int,
        expected_host_header: str,
    ):
        with fake_forwarder_upstream() as upstream:
            await forwarder.forward_request(
                url,
                "GET",
                [],
                None,
            )

        expected_resolve_calls = [] if ":" in expected_dns_host else [expected_dns_host]
        assert upstream.resolve_calls == expected_resolve_calls
        expected_connect_address = (
            (expected_dns_host, expected_connection_port, 0, 0)
            if ":" in expected_dns_host
            else ("93.184.216.34", expected_connection_port)
        )
        assert upstream.connect_calls == [expected_connect_address]
        assert upstream.socket.request_header_values("Host") == [expected_host_header]

    async def test_filters_request_hop_by_hop_headers_and_recomputes_content_length(self):
        with fake_forwarder_upstream() as upstream:
            await forwarder.forward_request(
                "https://example.com:444/path",
                "PUT",
                [
                    ("Host", "agent.example.com"),
                    ("Connection", "X-Remove, Keep-Alive"),
                    ("X-Remove", "secret"),
                    ("Keep-Alive", "timeout=5"),
                    ("Proxy-Authorization", "Basic secret"),
                    ("Content-Length", "999"),
                    ("Transfer-Encoding", "chunked"),
                    ("X-Keep", "ok"),
                ],
                b"abc",
            )

        assert upstream.socket.request_header_values("Connection") == []
        assert upstream.socket.request_header_values("X-Remove") == []
        assert upstream.socket.request_header_values("Keep-Alive") == []
        assert upstream.socket.request_header_values("Proxy-Authorization") == []
        assert upstream.socket.request_header_values("Transfer-Encoding") == []
        assert upstream.socket.request_header_values("Host") == ["example.com:444"]
        assert upstream.socket.request_header_values("X-Keep") == ["ok"]
        assert upstream.socket.request_header_values("Content-Length") == ["3"]
        assert upstream.socket.request_text().endswith("\r\n\r\nabc")

    async def test_explicit_empty_body_sets_zero_content_length(self):
        with fake_forwarder_upstream() as upstream:
            await forwarder.forward_request(
                "https://example.com/path",
                "POST",
                [],
                b"",
            )

        assert upstream.socket.request_header_values("Content-Length") == ["0"]
        assert upstream.socket.request_text().endswith("\r\n\r\n")

    async def test_preserves_response_header_octets_duplicates_and_filters_connection_names(self):
        raw_response = (
            b"HTTP/1.1 200 OK\r\n"
            b"X-Bytes: caf\xe9\r\n"
            b"Set-Cookie: a=1\r\n"
            b"Set-Cookie: b=2\r\n"
            b"Connection: X-Remove\r\n"
            b"X-Remove: drop\r\n"
            b"X-Keep: ok\r\n"
            b"\r\n"
            b"ok"
        )

        with fake_forwarder_upstream(socket_factory=lambda: FakeSocket(raw_response)):
            status, body, headers = await forwarder.forward_request(
                "https://example.com",
                "GET",
                [],
                None,
            )

        assert status == 200
        assert body == b"ok"
        assert headers.fields == (
            (b"X-Bytes", b"caf\xe9"),
            (b"Set-Cookie", b"a=1"),
            (b"Set-Cookie", b"b=2"),
            (b"X-Keep", b"ok"),
        )

    async def test_filters_hop_by_hop_response_headers(self):
        with fake_forwarder_upstream(
            body=b"2\r\nok\r\n0\r\n\r\n",
            headers=[
                ("Content-Type", "application/json"),
                ("Transfer-Encoding", "chunked"),
                ("Connection", "keep-alive"),
                ("Proxy-Authenticate", "Basic realm=proxy"),
                ("X-Custom", "value"),
            ],
        ):
            _status, _body, headers = await forwarder.forward_request(
                "https://example.com",
                "GET",
                [],
                None,
            )

        assert _body == b"ok"
        assert "Content-Type" in headers
        assert "X-Custom" in headers
        assert "Transfer-Encoding" not in headers
        assert "Connection" not in headers
        assert "Proxy-Authenticate" not in headers


class TestAuthBaseForwarderResponseBodyLimit:
    async def test_accepts_body_at_limit(self):
        with (
            patch.object(transport, "MAX_AUTH_BASE_RESPONSE_BODY_BYTES", 4),
            fake_forwarder_upstream(body=b"1234") as upstream,
        ):
            status, body, _headers = await forwarder.forward_request(
                "https://example.com",
                "GET",
                [],
                None,
            )

        assert status == 200
        assert body == b"1234"
        assert upstream.socket.response_file is not None
        assert upstream.socket.response_file.closed
        assert upstream.socket.closed

    async def test_accepts_complete_fixed_length_body_at_limit(self):
        with (
            patch.object(transport, "MAX_AUTH_BASE_RESPONSE_BODY_BYTES", 4),
            fake_forwarder_upstream(
                body=b"1234",
                headers=[("Content-Length", "4")],
            ),
        ):
            status, body, _headers = await forwarder.forward_request(
                "https://example.com",
                "GET",
                [],
                None,
            )

        assert status == 200
        assert body == b"1234"

    async def test_rejects_body_over_limit_and_closes_resources(self):
        with (
            patch.object(transport, "MAX_AUTH_BASE_RESPONSE_BODY_BYTES", 4),
            fake_forwarder_upstream(body=b"12345") as upstream,
            pytest.raises(transport.ForwardedResponseTooLargeError),
        ):
            await forwarder.forward_request("https://example.com", "GET", [], None)

        assert upstream.socket.response_file is not None
        assert upstream.socket.response_file.closed
        assert upstream.socket.closed

    async def test_rejects_truncated_fixed_length_body_and_closes_resources(self):
        with (
            patch.object(transport, "MAX_AUTH_BASE_RESPONSE_BODY_BYTES", 4),
            fake_forwarder_upstream(
                body=b"123",
                headers=[("Content-Length", "4")],
            ) as upstream,
            pytest.raises(h11.RemoteProtocolError),
        ):
            await forwarder.forward_request("https://example.com", "GET", [], None)

        assert upstream.socket.response_file is not None
        assert upstream.socket.response_file.closed
        assert upstream.socket.closed

    @pytest.mark.parametrize(
        ("method", "status"),
        [
            pytest.param("HEAD", 200, id="head"),
            pytest.param("GET", 204, id="no-content"),
            pytest.param("GET", 304, id="not-modified"),
        ],
    )
    async def test_accepts_no_body_semantics_with_content_length(self, method: str, status: int):
        with fake_forwarder_upstream(
            status=status,
            body=b"",
            headers=[("Content-Length", "4")],
        ):
            response_status, body, _headers = await forwarder.forward_request(
                "https://example.com",
                method,
                [],
                None,
            )

        assert response_status == status
        assert body == b""


class TestAuthBaseForwarderRequestBodyLimit:
    async def test_accepts_body_at_limit(self):
        with (
            patch.object(transport, "MAX_AUTH_BASE_REQUEST_BODY_BYTES", 4),
            fake_forwarder_upstream() as upstream,
        ):
            status, body, _headers = await forwarder.forward_request(
                "https://example.com",
                "POST",
                [],
                b"1234",
            )

        assert status == 200
        assert body == b"ok"
        assert upstream.socket.request_text().endswith("\r\n\r\n1234")

    async def test_rejects_body_over_limit_before_connection_setup(self):
        with (
            patch.object(transport, "MAX_AUTH_BASE_REQUEST_BODY_BYTES", 4),
            fake_forwarder_upstream() as upstream,
            pytest.raises(transport.ForwardedRequestTooLargeError),
        ):
            await forwarder.forward_request(
                "https://example.com",
                "POST",
                [],
                b"12345",
            )

        assert upstream.resolve_calls == []


class TestAuthBaseForwarderResourceCleanup:
    def test_duplicate_flow_admission_attach_does_not_overwrite_existing(self, real_flow):
        flow = real_flow(with_response=False)
        first = forwarder.reserve_forward_request_admission(7)
        second = forwarder.reserve_forward_request_admission(11)

        try:
            forwarder.attach_forward_request_admission_to_flow(flow, first)

            with pytest.raises(RuntimeError, match="already attached"):
                forwarder.attach_forward_request_admission_to_flow(flow, second)

            assert forwarder.forward_request_admission_state_for_tests() == (2, 18)
        finally:
            forwarder.release_forward_request_admission_from_flow(flow)
            forwarder.release_forward_request_admission(first)
            forwarder.release_forward_request_admission(second)

        assert forwarder.forward_request_admission_state_for_tests() == (0, 0)

    async def test_oversized_body_releases_supplied_admission_before_upstream_setup(self):
        with (
            patch.object(transport, "MAX_AUTH_BASE_REQUEST_BODY_BYTES", 4),
            patch.object(forwarder, "MAX_ADMITTED_AUTH_BASE_FORWARDS", 1),
            patch.object(forwarder, "MAX_ADMITTED_AUTH_BASE_REQUEST_BODY_BYTES", 4),
            fake_forwarder_upstream() as upstream,
        ):
            admission = forwarder.reserve_forward_request_admission(4)

            with pytest.raises(transport.ForwardedRequestTooLargeError):
                await forwarder.forward_request(
                    "https://example.com",
                    "POST",
                    [],
                    b"12345",
                    admission=admission,
                )

            assert forwarder.forward_request_admission_state_for_tests() == (0, 0)
            replacement = forwarder.reserve_forward_request_admission(4)
            try:
                assert forwarder.forward_request_admission_state_for_tests() == (1, 4)
            finally:
                forwarder.release_forward_request_admission(replacement)

        assert forwarder.forward_request_admission_state_for_tests() == (0, 0)
        assert upstream.resolve_calls == []
        assert upstream.sockets == []
        assert upstream.connect_calls == []

    async def test_resize_saturation_releases_only_supplied_admission(self):
        with (
            patch.object(forwarder, "MAX_ADMITTED_AUTH_BASE_FORWARDS", 2),
            patch.object(forwarder, "MAX_ADMITTED_AUTH_BASE_REQUEST_BODY_BYTES", 4),
            fake_forwarder_upstream() as upstream,
        ):
            unrelated = forwarder.reserve_forward_request_admission(3)
            admission = forwarder.reserve_forward_request_admission(1)
            replacement = None
            try:
                assert forwarder.forward_request_admission_state_for_tests() == (2, 4)

                with pytest.raises(forwarder.AuthBaseForwardingSaturatedError):
                    await forwarder.forward_request(
                        "https://example.com",
                        "POST",
                        [],
                        b"12",
                        admission=admission,
                    )

                assert forwarder.forward_request_admission_state_for_tests() == (1, 3)
                replacement = forwarder.reserve_forward_request_admission(1)
                assert forwarder.forward_request_admission_state_for_tests() == (2, 4)
            finally:
                forwarder.release_forward_request_admission(unrelated)
                if replacement is not None:
                    forwarder.release_forward_request_admission(replacement)

        assert forwarder.forward_request_admission_state_for_tests() == (0, 0)
        assert upstream.resolve_calls == []
        assert upstream.sockets == []
        assert upstream.connect_calls == []

    async def test_closes_response_and_connection_on_success(self):
        with fake_forwarder_upstream(headers=[("Content-Type", "application/json")]) as upstream:
            status, body, _ = await forwarder.forward_request(
                "https://example.com", "GET", [], None
            )

        assert status == 200
        assert body == b"ok"
        assert upstream.socket.response_file is not None
        assert upstream.socket.response_file.closed
        assert upstream.socket.closed

    async def test_preserves_duplicate_headers_on_error_status(self):
        with fake_forwarder_upstream(
            status=429,
            body=b"rate limited",
            headers=[
                ("WWW-Authenticate", "Bearer realm=one"),
                ("WWW-Authenticate", "Bearer realm=two"),
                ("Content-Type", "text/plain"),
            ],
        ) as upstream:
            status, body, headers = await forwarder.forward_request(
                "https://example.com", "GET", [], None
            )

        assert status == 429
        assert body == b"rate limited"
        assert headers.get_all("WWW-Authenticate") == ["Bearer realm=one", "Bearer realm=two"]
        assert headers["Content-Type"] == "text/plain"
        assert upstream.socket.response_file is not None
        assert upstream.socket.response_file.closed
        assert upstream.socket.closed

    async def test_closes_response_when_read_raises(self):
        with (
            fake_forwarder_upstream(read_side_effect=OSError("socket closed")) as upstream,
            pytest.raises(OSError, match="socket closed"),
        ):
            await forwarder.forward_request("https://example.com", "GET", [], None)

        assert upstream.socket.response_file is not None
        assert upstream.socket.response_file.closed
        assert upstream.socket.closed

    async def test_closes_connection_when_request_raises(self):
        with (
            fake_forwarder_upstream(send_side_effect=ConnectionError("connect failed")) as upstream,
            pytest.raises(ConnectionError, match="connect failed"),
        ):
            await forwarder.forward_request("https://example.com", "GET", [], None)

        assert upstream.socket.response_file is None
        assert upstream.socket.closed

    async def test_closes_connection_when_getresponse_raises(self):
        with (
            fake_forwarder_upstream(
                socket_factory=lambda: FakeSocket(b"not an HTTP response\r\n")
            ) as upstream,
            pytest.raises(h11.RemoteProtocolError),
        ):
            await forwarder.forward_request("https://example.com", "GET", [], None)

        assert upstream.socket.response_file is not None
        assert upstream.socket.response_file.closed
        assert upstream.socket.closed
