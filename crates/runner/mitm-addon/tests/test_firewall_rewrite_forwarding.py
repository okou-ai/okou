"""auth.base rewrite forwarding handler tests."""

import asyncio
import gzip
import json
from unittest.mock import AsyncMock, MagicMock, patch
from urllib.parse import parse_qs, urlparse

import pytest

import auth
import auth_base_forwarder as forwarder
import flow_metadata_keys as metadata_keys
from tests.auth_base_forwarder_helpers import fake_forwarder_upstream
from tests.firewall_auth_helpers import handle_firewall_request_without_upstream_admission
from tests.firewall_rewrite_helpers import make_forwarding_rewrite_inputs
from tests.jsonl_log_helpers import read_jsonl_text_after_flush


def _request_line_parts(upstream) -> tuple[str, str, str]:
    return upstream.socket.request_lines()[0].split(" ", 2)


class TestAuthBaseUrlRewriteForwarding:
    """auth.base rewrite forwarding handler tests."""

    async def test_url_rewrite_uses_real_forwarder_response(
        self, headers, real_flow, mitm_ctx, tmp_path
    ):
        """Handler auth.base rewrites should drive the real forwarder path."""
        request_body = b'{"message":"hello"}'
        flow, allow, sandbox_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            path="/hook?client=visible",
            resolved_base="https://real.example.com/webhook/secret?base=trusted",
            rel_path="/send",
            method="POST",
            request_body=request_body,
            request_headers=headers(
                ("Host", "firewall-placeholder.vm3.ai"),
                ("Authorization", "Bearer agent"),
                ("Cookie", "session=agent"),
                ("X-Api-Key", "agent-api-key"),
                ("X-Repeat", "one"),
                ("X-Repeat", "two"),
                ("X-Keep", "client"),
                ("cOnTeNt-TyPe", "application/json; charset=utf-8"),
            ),
            auth_overrides={
                "headers": {
                    "Authorization": "Bearer ${{ secrets.TOKEN }}",
                    "X-Custom": "${{ secrets.CUSTOM }}",
                    "X-Latin-1": "${{ secrets.LATIN_1 }}",
                },
                "query": {"api_key": "${{ secrets.API_KEY }}"},
            },
            token_overrides={
                "headers": {
                    "Authorization": "Bearer real-token",
                    "X-Custom": "injected-value",
                    "X-Latin-1": "café",
                },
                "query": {"api_key": "resolved-key"},
                "resolved_secrets": ["WEBHOOK", "API_KEY"],
                "refreshed_connectors": ["discord"],
                "refreshed_secrets": ["WEBHOOK"],
                "cache_hit": False,
            },
        )
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH] = str(proxy_log_path)

        with (
            fake_forwarder_upstream(
                status=201,
                body=b'{"ok":true}',
                headers=[
                    ("Set-Cookie", "a=1"),
                    ("Set-Cookie", "b=2"),
                    ("Content-Type", "application/json"),
                    ("X-Upstream", "real"),
                ],
            ) as upstream,
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            result = await handle_firewall_request_without_upstream_admission(
                flow, allow, sandbox_info
            )

        assert result is auth.FirewallAuthHandlingResult.INLINE_PROVIDER_RESPONSE
        assert upstream.resolve_calls == ["real.example.com"]
        assert upstream.connect_calls
        assert upstream.connect_calls[0] == ("93.184.216.34", 443)
        assert upstream.contexts[0].server_hostnames == ["real.example.com"]

        request_line = upstream.socket.request_lines()[0]
        _method, request_target, _version = request_line.split(" ", 2)
        rewritten = urlparse(f"https://real.example.com{request_target}")
        rewritten_query = parse_qs(rewritten.query, keep_blank_values=True)
        assert request_line.startswith("POST ")
        assert rewritten.path == "/webhook/secret/send"
        assert rewritten_query == {
            "base": ["trusted"],
            "client": ["visible"],
            "api_key": ["resolved-key"],
        }
        assert upstream.socket.request_header_values("Host") == ["real.example.com"]
        assert upstream.socket.request_header_values("Authorization") == ["Bearer real-token"]
        assert upstream.socket.request_header_values("X-Custom") == ["injected-value"]
        assert upstream.socket.request_header_values("X-Latin-1") == ["café"]
        assert b"X-Latin-1: caf\xe9\r\n" in upstream.socket.sent
        assert upstream.socket.request_header_values("X-Repeat") == []
        assert upstream.socket.request_header_values("X-Keep") == []
        assert upstream.socket.request_header_values("Cookie") == []
        assert upstream.socket.request_header_values("X-Api-Key") == []
        assert upstream.socket.request_header_values("Content-Type") == [
            "application/json; charset=utf-8"
        ]
        assert "cOnTeNt-TyPe: application/json; charset=utf-8" in upstream.socket.request_lines()
        assert upstream.socket.request_header_values("Content-Length") == [str(len(request_body))]
        assert upstream.socket.request_text().endswith("\r\n\r\n" + request_body.decode("ascii"))

        assert flow.response is not None
        assert flow.response.status_code == 201
        assert flow.response.content == b'{"ok":true}'
        response_pairs = list(flow.response.headers.items(multi=True))
        assert response_pairs.count(("Set-Cookie", "a=1")) == 1
        assert response_pairs.count(("Set-Cookie", "b=2")) == 1
        assert ("Content-Type", "application/json") in response_pairs
        assert ("X-Upstream", "real") in response_pairs

        assert flow.metadata[metadata_keys.AUTH_URL_REWRITE] is True
        assert flow.metadata[metadata_keys.AUTH_RESOLVED_SECRETS] == ["WEBHOOK", "API_KEY"]
        assert flow.metadata[metadata_keys.AUTH_REFRESHED_CONNECTORS] == ["discord"]
        assert flow.metadata[metadata_keys.AUTH_REFRESHED_SECRETS] == ["WEBHOOK"]
        assert flow.metadata[metadata_keys.AUTH_CACHE_HIT] is False
        assert metadata_keys.FIREWALL_ERROR not in flow.metadata

        assert flow.request.path == "/hook?client=visible"
        assert flow.request.headers["Authorization"] == "Bearer agent"
        assert flow.request.headers["Cookie"] == "session=agent"
        assert flow.request.headers["X-Api-Key"] == "agent-api-key"
        assert "X-Custom" not in flow.request.headers
        assert "api_key" not in flow.request.query
        assert flow.request.query["client"] == "visible"

        log_text = await asyncio.to_thread(read_jsonl_text_after_flush, proxy_log_path)
        assert "Firewall URL rewrite:" in log_text
        assert "real-token" not in log_text
        assert "webhook/secret" not in log_text

    @pytest.mark.parametrize(
        ("value", "expected_content"),
        [
            pytest.param(" token", b"token", id="leading-space"),
            pytest.param("token ", b"token", id="trailing-space"),
            pytest.param("\ttoken\t", b"token", id="surrounding-tabs"),
            pytest.param(" \ttoken\t ", b"token", id="mixed-ows"),
            pytest.param(" \t ", b"", id="only-ows"),
            pytest.param("", b"", id="empty"),
            pytest.param(" \tone \t two\t ", b"one \t two", id="internal-whitespace"),
            pytest.param(" \t\xa0caf\xe9\x85\t ", b"\xa0caf\xe9\x85", id="latin-1-content"),
        ],
    )
    async def test_url_rewrite_forwards_header_content_with_optional_whitespace(
        self, real_flow, mitm_ctx, tmp_path, value: str, expected_content: bytes
    ):
        flow, allow, sandbox_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            method="POST",
            request_body=b"{}",
            token_overrides={"headers": {"X-Custom": value}},
        )
        with (
            fake_forwarder_upstream(headers=[("Content-Length", "2")]) as upstream,
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            result = await handle_firewall_request_without_upstream_admission(
                flow, allow, sandbox_info
            )

        assert result is auth.FirewallAuthHandlingResult.INLINE_PROVIDER_RESPONSE
        assert flow.response is not None
        assert flow.response.status_code == 200
        assert flow.response.content == b"ok"
        assert flow.metadata[metadata_keys.AUTH_URL_REWRITE] is True
        assert metadata_keys.FIREWALL_ERROR not in flow.metadata
        assert b"X-Custom: " + expected_content + b"\r\n" in upstream.socket.sent
        assert upstream.socket.request_text().count("POST ") == 1
        assert bytes(upstream.socket.sent).split(b"\r\n\r\n", 1)[1] == b"{}"
        assert len(upstream.sockets) == 1
        assert upstream.socket.closed
        assert upstream.socket.response_file is not None
        assert upstream.socket.response_file.closed
        assert forwarder.forward_request_admission_state_for_tests() == (0, 0)

    @pytest.mark.parametrize(
        ("content_encodings", "coded_body", "decoded_body"),
        [
            pytest.param(
                ("gzip",),
                gzip.compress(b'{"ok":true}', mtime=0),
                b'{"ok":true}',
                id="gzip",
            ),
            pytest.param(
                ("x-first", "x-second"),
                b"opaque-coded-response",
                None,
                id="repeated-unknown",
            ),
        ],
    )
    async def test_url_rewrite_preserves_encoded_response_representation(
        self,
        real_flow,
        mitm_ctx,
        tmp_path,
        content_encodings: tuple[str, ...],
        coded_body: bytes,
        decoded_body: bytes | None,
    ):
        flow, allow, sandbox_info, token_meta = make_forwarding_rewrite_inputs(real_flow, tmp_path)
        chunked_body = b"%x\r\n" % len(coded_body) + coded_body + b"\r\n0\r\n\r\n"
        response_headers = [("Content-Encoding", value) for value in content_encodings]
        response_headers.append(("Transfer-Encoding", "chunked"))

        with (
            fake_forwarder_upstream(body=chunked_body, headers=response_headers),
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            result = await handle_firewall_request_without_upstream_admission(
                flow, allow, sandbox_info
            )

        assert result is auth.FirewallAuthHandlingResult.INLINE_PROVIDER_RESPONSE
        assert flow.response is not None
        assert flow.response.raw_content == coded_body
        assert flow.response.headers.get_all("Content-Encoding") == list(content_encodings)
        assert flow.response.headers["Content-Length"] == str(len(coded_body))
        assert "Transfer-Encoding" not in flow.response.headers
        if decoded_body is not None:
            assert flow.response.content == decoded_body

    @pytest.mark.parametrize(
        ("method", "status"),
        [
            pytest.param("HEAD", 200, id="head"),
            pytest.param("GET", 304, id="not-modified"),
        ],
    )
    @pytest.mark.parametrize(
        ("response_headers", "expected_content_lengths"),
        [
            pytest.param(
                [("Content-Length", "123")],
                ["123"],
                id="representation-length",
            ),
            pytest.param([], [], id="absent"),
            pytest.param([("Content-Length", "123, 123")], [], id="comma-list"),
            pytest.param(
                [("Content-Length", "123"), ("Content-Length", "123")],
                [],
                id="repeated",
            ),
        ],
    )
    async def test_url_rewrite_preserves_bodyless_response_content_length(
        self,
        real_flow,
        mitm_ctx,
        tmp_path,
        method: str,
        status: int,
        response_headers: list[tuple[str, str]],
        expected_content_lengths: list[str],
    ):
        flow, allow, sandbox_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            method=method,
        )

        with (
            fake_forwarder_upstream(status=status, body=b"", headers=response_headers),
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            result = await handle_firewall_request_without_upstream_admission(
                flow, allow, sandbox_info
            )

        assert result is auth.FirewallAuthHandlingResult.INLINE_PROVIDER_RESPONSE
        assert flow.response is not None
        assert flow.response.status_code == status
        assert flow.response.raw_content == b""
        assert flow.response.headers.get_all("Content-Length") == expected_content_lengths

    @pytest.mark.parametrize(("method", "status"), [("HEAD", 200), ("GET", 304)])
    @pytest.mark.parametrize(
        "response_headers",
        [
            [("Content-Length", "123"), ("Content-Length", "124")],
            [("Content-Length", "invalid")],
        ],
        ids=["conflicting", "malformed"],
    )
    async def test_url_rewrite_rejects_invalid_bodyless_response_framing(
        self, real_flow, mitm_ctx, tmp_path, method: str, status: int, response_headers
    ):
        flow, allow, sandbox_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow, tmp_path, method=method
        )
        with (
            fake_forwarder_upstream(status=status, body=b"", headers=response_headers) as upstream,
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            result = await handle_firewall_request_without_upstream_admission(
                flow, allow, sandbox_info
            )

        assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "url_rewrite_forward_failed"
        assert metadata_keys.AUTH_URL_REWRITE not in flow.metadata
        assert upstream.socket.closed
        assert upstream.socket.response_file is not None
        assert upstream.socket.response_file.closed
        assert forwarder.forward_request_admission_state_for_tests() == (0, 0)

    @pytest.mark.parametrize(
        "status",
        [
            pytest.param(204, id="no-content"),
            pytest.param(205, id="reset-content"),
        ],
    )
    async def test_url_rewrite_does_not_restore_content_length_for_empty_head_status(
        self, real_flow, mitm_ctx, tmp_path, status: int
    ):
        flow, allow, sandbox_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            method="HEAD",
        )

        with (
            fake_forwarder_upstream(
                status=status,
                body=b"",
                headers=[("Content-Length", "123")],
            ),
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            result = await handle_firewall_request_without_upstream_admission(
                flow, allow, sandbox_info
            )

        assert result is auth.FirewallAuthHandlingResult.INLINE_PROVIDER_RESPONSE
        assert flow.response is not None
        assert flow.response.status_code == status
        assert flow.response.raw_content == b""
        assert flow.response.headers.get_all("Content-Length") == ["0"]

    async def test_url_rewrite_sends_resolved_auth_headers(
        self, headers, real_flow, mitm_ctx, tmp_path
    ):
        """auth.headers are forwarded without mutating the placeholder request."""
        flow, allow, sandbox_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            resolved_base="https://discord.com/api/webhooks/123/abc",
            request_headers=headers(
                ("Host", "firewall-placeholder.vm3.ai"),
                ("Authorization", "Bearer agent"),
                ("X-Api-Key", "agent-api-key"),
            ),
            auth_overrides={
                "headers": {
                    "Authorization": "Bearer ${{ secrets.TOKEN }}",
                    "X-Api-Key": "${{ secrets.API_KEY }}",
                    "X-Custom": "${{ secrets.CUSTOM }}",
                }
            },
        )
        token_meta["headers"] = {
            "Authorization": "Bearer real-token",
            "X-Api-Key": "real-api-key",
            "X-Custom": "injected-value",
        }
        with (
            fake_forwarder_upstream() as upstream,
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await handle_firewall_request_without_upstream_admission(flow, allow, sandbox_info)
        assert flow.metadata[metadata_keys.AUTH_URL_REWRITE] is True
        assert upstream.socket.request_header_values("Authorization") == ["Bearer real-token"]
        assert upstream.socket.request_header_values("X-Api-Key") == ["real-api-key"]
        assert upstream.socket.request_header_values("X-Custom") == ["injected-value"]
        assert flow.request.headers["Authorization"] == "Bearer agent"
        assert flow.request.headers["X-Api-Key"] == "agent-api-key"
        assert "X-Custom" not in flow.request.headers

    async def test_url_rewrite_drops_non_representation_client_headers(
        self, headers, real_flow, mitm_ctx, tmp_path
    ):
        """auth.base forwarding does not inherit arbitrary client headers."""
        flow, allow, sandbox_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            request_headers=headers(
                ("Host", "firewall-placeholder.vm3.ai"),
                ("Connection", "Content-Type, Content-Encoding"),
                ("Content-Type", "application/json"),
                ("Content-Encoding", "gzip"),
                ("Authorization", "Bearer agent"),
                ("authorization", "Bearer lower-agent"),
                ("AUTHORIZATION", "Bearer upper-agent"),
                ("Cookie", "session=agent"),
                ("X-Api-Key", "agent-api-key"),
                ("X-Auth-Token", "agent-auth-token"),
                ("Private-Token", "agent-private-token"),
                ("Accept", "application/json"),
                ("User-Agent", "agent-client"),
                ("Reap-Version", "2025-02-14"),
                ("X-Api-Version", "2025-11-01"),
                (
                    "X-Snowflake-Authorization-Token-Type",
                    "PROGRAMMATIC_ACCESS_TOKEN",
                ),
                ("X-Repeat", "one"),
                ("X-Repeat", "two"),
                ("X-Keep", "client"),
            ),
        )
        token_meta["headers"] = {}
        with (
            fake_forwarder_upstream() as upstream,
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await handle_firewall_request_without_upstream_admission(flow, allow, sandbox_info)

        assert upstream.socket.request_header_values("Connection") == []
        assert upstream.socket.request_header_values("Authorization") == []
        assert upstream.socket.request_header_values("Cookie") == []
        assert upstream.socket.request_header_values("X-Api-Key") == []
        assert upstream.socket.request_header_values("X-Auth-Token") == []
        assert upstream.socket.request_header_values("Private-Token") == []
        assert upstream.socket.request_header_values("Accept") == []
        assert upstream.socket.request_header_values("User-Agent") == []
        assert upstream.socket.request_header_values("Reap-Version") == []
        assert upstream.socket.request_header_values("X-Api-Version") == []
        assert upstream.socket.request_header_values("X-Snowflake-Authorization-Token-Type") == []
        assert upstream.socket.request_header_values("X-Repeat") == []
        assert upstream.socket.request_header_values("X-Keep") == []
        assert upstream.socket.request_header_values("Content-Type") == []
        assert upstream.socket.request_header_values("Content-Encoding") == []
        request_headers = list(flow.request.headers.items(multi=True))
        assert ("Authorization", "Bearer agent") in request_headers
        assert ("authorization", "Bearer lower-agent") in request_headers
        assert ("AUTHORIZATION", "Bearer upper-agent") in request_headers
        assert flow.request.headers["Cookie"] == "session=agent"

    async def test_url_rewrite_preserves_coded_body_metadata_and_auth_override(
        self, headers, real_flow, mitm_ctx, tmp_path
    ):
        """Representation metadata stays ordered and trusted auth can override it."""
        request_body = b"\x1f\x8b\x08\x00coded-body"
        flow, allow, sandbox_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            method="POST",
            request_body=request_body,
            request_headers=headers(
                ("Host", "firewall-placeholder.vm3.ai"),
                ("Connection", "X-Remove"),
                ("X-Remove", "drop"),
                ("X-Repeat", "one"),
                ("X-Repeat", "two"),
                ("Content-Encoding", "gzip"),
                ("content-encoding", "br"),
                ("Content-Type", "application/client"),
            ),
            auth_overrides={
                "headers": {
                    "content-type": "${{ vars.CONTENT_TYPE }}",
                    "Authorization": "Bearer ${{ secrets.TOKEN }}",
                }
            },
        )
        token_meta["headers"] = {
            "content-type": "application/provider",
            "Authorization": "Bearer real",
        }
        with (
            fake_forwarder_upstream() as upstream,
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await handle_firewall_request_without_upstream_admission(flow, allow, sandbox_info)

        assert upstream.socket.request_header_values("Connection") == []
        assert upstream.socket.request_header_values("X-Remove") == []
        assert upstream.socket.request_header_values("X-Repeat") == []
        assert upstream.socket.request_header_values("Content-Encoding") == ["gzip", "br"]
        assert upstream.socket.request_header_values("Content-Type") == ["application/provider"]
        assert upstream.socket.request_header_values("Authorization") == ["Bearer real"]
        request_lines = upstream.socket.request_lines()
        assert request_lines.index("Content-Encoding: gzip") < request_lines.index(
            "content-encoding: br"
        )
        assert bytes(upstream.socket.sent).endswith(b"\r\n\r\n" + request_body)

    async def test_url_rewrite_filters_client_and_injected_unsafe_headers(
        self, headers, real_flow, mitm_ctx, tmp_path
    ):
        """Client and resolved transport-owned headers are stripped."""
        flow, allow, sandbox_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            request_headers=headers(
                ("Connection", "Authorization"),
                ("Host", "evil-client.example.com"),
                ("Content-Length", "123"),
                ("Transfer-Encoding", "chunked"),
                ("Keep-Alive", "timeout=5"),
                ("Proxy-Authenticate", "Basic realm=client"),
                ("Proxy-Authorization", "Basic client"),
                ("Proxy-Connection", "keep-alive"),
                ("TE", "trailers"),
                ("Trailer", "X-Client-Trailer"),
                ("Upgrade", "websocket"),
                ("Authorization", "Bearer agent"),
                ("X-Keep", "client"),
            ),
            auth_overrides={
                "headers": dict.fromkeys(
                    (
                        "Connection",
                        "Keep-Alive",
                        "Host",
                        "Content-Length",
                        "Transfer-Encoding",
                        "Proxy-Authenticate",
                        "Proxy-Authorization",
                        "Proxy-Connection",
                        "TE",
                        "Trailer",
                        "Upgrade",
                        "Authorization",
                        "X-Injected",
                    ),
                    "${{ secrets.VALUE }}",
                )
            },
        )
        token_meta["headers"] = {
            "Connection": "Authorization, X-Injected",
            "Keep-Alive": "timeout=5",
            "Host": "evil.example.com",
            "Content-Length": "999",
            "Transfer-Encoding": "chunked",
            "Proxy-Authenticate": "Basic realm=proxy",
            "Proxy-Authorization": "Basic secret",
            "Proxy-Connection": "keep-alive",
            "TE": "trailers",
            "Trailer": "X-Trailer",
            "Upgrade": "websocket",
            "Authorization": "Bearer real",
            "X-Injected": "trusted",
        }
        with (
            fake_forwarder_upstream() as upstream,
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await handle_firewall_request_without_upstream_admission(flow, allow, sandbox_info)

        assert upstream.socket.request_header_values("Connection") == []
        assert upstream.socket.request_header_values("Content-Length") == []
        assert upstream.socket.request_header_values("Host") == ["discord.com"]
        assert upstream.socket.request_header_values("Keep-Alive") == []
        assert upstream.socket.request_header_values("Proxy-Authenticate") == []
        assert upstream.socket.request_header_values("Proxy-Authorization") == []
        assert upstream.socket.request_header_values("Proxy-Connection") == []
        assert upstream.socket.request_header_values("TE") == []
        assert upstream.socket.request_header_values("Trailer") == []
        assert upstream.socket.request_header_values("Transfer-Encoding") == []
        assert upstream.socket.request_header_values("Upgrade") == []
        assert upstream.socket.request_header_values("Authorization") == []
        assert upstream.socket.request_header_values("X-Injected") == []
        assert upstream.socket.request_header_values("X-Keep") == []

    @pytest.mark.parametrize(
        "invalid_value",
        [
            pytest.param("bad\r\nX-Injected: value", id="newline"),
            pytest.param("snowman ☃", id="non-latin-1"),
        ],
    )
    async def test_forward_request_rejects_invalid_injected_header(
        self, real_flow, mitm_ctx, tmp_path, invalid_value: str
    ):
        """Invalid resolved auth headers fail before auth.base forwarding."""
        flow, allow, sandbox_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            resolved_base="https://discord.com/api/webhooks/123/abc",
            auth_overrides={
                "headers": {
                    "Authorization": "Bearer ${{ secrets.TOKEN }}",
                    "X-Test": "${{ secrets.TEST }}",
                }
            },
        )
        token_meta["headers"] = {
            "Authorization": "Bearer real-token",
            "X-Test": invalid_value,
        }
        mock_forward = AsyncMock(return_value=(200, b"ok", {}))
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            result = await handle_firewall_request_without_upstream_admission(
                flow, allow, sandbox_info
            )

        assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
        mock_forward.assert_not_called()
        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "invalid_resolved_auth_header"
        body = json.loads(flow.response.content)
        assert body["error"] == "invalid_resolved_auth_header"

    @pytest.mark.parametrize(
        ("content_type", "request_body"),
        [
            ("application/json; charset=utf-8", b'{"message":"hello"}'),
            ("application/x-www-form-urlencoded", b"message=hello+world"),
            (
                "multipart/form-data; boundary=vm0-boundary",
                b"--vm0-boundary\r\nContent-Disposition: form-data; name=message\r\n\r\nhello\r\n"
                b"--vm0-boundary--\r\n",
            ),
        ],
        ids=["json", "form", "multipart"],
    )
    async def test_url_rewrite_preserves_one_exact_content_type(
        self,
        headers,
        real_flow,
        mitm_ctx,
        tmp_path,
        content_type: str,
        request_body: bytes,
    ):
        flow, allow, sandbox_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            method="POST",
            request_body=request_body,
            request_headers=headers(
                ("cOnTeNt-TyPe", content_type),
                ("X-Drop", "client-metadata"),
            ),
        )

        with (
            fake_forwarder_upstream() as upstream,
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await handle_firewall_request_without_upstream_admission(flow, allow, sandbox_info)

        assert f"cOnTeNt-TyPe: {content_type}" in upstream.socket.request_lines()
        assert upstream.socket.request_header_values("X-Drop") == []
        assert bytes(upstream.socket.sent).endswith(b"\r\n\r\n" + request_body)

    async def test_duplicate_content_type_returns_400_before_auth_or_forwarding(
        self,
        headers,
        real_flow,
        mitm_ctx,
        tmp_path,
    ):
        flow, allow, sandbox_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            method="POST",
            request_body=b"body",
            request_headers=headers(
                ("Content-Type", "application/json"),
                ("content-type", "text/plain"),
            ),
        )
        get_headers = AsyncMock(return_value=token_meta)
        mock_forward = AsyncMock()

        with (
            patch.object(auth, "get_firewall_headers", get_headers),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            result = await handle_firewall_request_without_upstream_admission(
                flow, allow, sandbox_info
            )

        assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
        get_headers.assert_not_called()
        mock_forward.assert_not_called()
        assert flow.response is not None
        assert flow.response.status_code == 400
        assert json.loads(flow.response.content) == {
            "error": "invalid_auth_base_request_headers",
            "message": "auth.base requests must contain at most one Content-Type header",
            "permission": allow.name,
            "base": allow.api_entry["base"],
        }
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == ("invalid_auth_base_request_headers")

    async def test_url_rewrite_sends_raw_body_for_any_method(self, real_flow, mitm_ctx, tmp_path):
        """auth.base forwarding does not drop bodies for non-POST methods."""
        request_body = b"\x00\xffdelete-body"
        flow, allow, sandbox_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            method="DELETE",
            request_body=request_body,
        )
        with (
            fake_forwarder_upstream() as upstream,
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await handle_firewall_request_without_upstream_admission(flow, allow, sandbox_info)

        method, _request_target, _version = _request_line_parts(upstream)
        assert method == "DELETE"
        assert upstream.socket.request_header_values("Content-Length") == [str(len(request_body))]
        assert bytes(upstream.socket.sent).endswith(b"\r\n\r\n" + request_body)

    async def test_url_rewrite_sends_empty_raw_body_with_zero_content_length(
        self, real_flow, mitm_ctx, tmp_path
    ):
        """An explicit empty body is distinct from no body for Content-Length."""
        flow, allow, sandbox_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            method="POST",
            request_body=b"",
        )
        with (
            fake_forwarder_upstream() as upstream,
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await handle_firewall_request_without_upstream_admission(flow, allow, sandbox_info)

        method, _request_target, _version = _request_line_parts(upstream)
        assert method == "POST"
        assert upstream.socket.request_header_values("Content-Length") == ["0"]
        assert upstream.socket.request_text().endswith("\r\n\r\n")

    async def test_url_rewrite_sends_absent_body_without_content_length(
        self, real_flow, mitm_ctx, tmp_path
    ):
        """A request with no raw body remains distinct from an explicit empty body."""
        flow, allow, sandbox_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            method="GET",
            request_body=None,
        )
        with (
            fake_forwarder_upstream() as upstream,
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await handle_firewall_request_without_upstream_admission(flow, allow, sandbox_info)

        method, _request_target, _version = _request_line_parts(upstream)
        assert method == "GET"
        assert upstream.socket.request_header_values("Content-Length") == []
        assert upstream.socket.request_text().endswith("\r\n\r\n")

    async def test_url_rewrite_accepts_body_at_limit(self, real_flow, mitm_ctx, tmp_path):
        flow, allow, sandbox_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            method="POST",
            request_body=b"1234",
        )
        get_headers = AsyncMock(return_value=token_meta)
        with (
            fake_forwarder_upstream() as upstream,
            patch.object(auth, "MAX_AUTH_BASE_REQUEST_BODY_BYTES", 4),
            patch.object(auth, "get_firewall_headers", get_headers),
            mitm_ctx(),
        ):
            await handle_firewall_request_without_upstream_admission(flow, allow, sandbox_info)

        assert get_headers.await_count == 1
        assert upstream.socket.request_header_values("Content-Length") == ["4"]
        assert upstream.socket.request_text().endswith("\r\n\r\n1234")
        assert flow.response is not None
        assert flow.response.status_code == 200

    async def test_oversized_request_body_returns_413_before_auth_resolution(
        self, real_flow, mitm_ctx, tmp_path
    ):
        request_body = b"super-secret-body"
        flow, allow, sandbox_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            method="POST",
            request_body=request_body,
            auth_overrides={"headers": {"Authorization": "Bearer ${{ secrets.TOKEN }}"}},
            token_overrides={
                "base": "https://real.example.com/webhook/super-secret-token",
                "headers": {"Authorization": "Bearer real-token"},
            },
        )
        get_headers = AsyncMock(return_value=token_meta)
        mock_forward = AsyncMock()
        mock_log = MagicMock()
        with (
            patch.object(auth, "MAX_AUTH_BASE_REQUEST_BODY_BYTES", 4),
            patch.object(auth, "get_firewall_headers", get_headers),
            patch.object(auth, "forward_request", mock_forward),
            patch.object(auth, "log_proxy_entry", mock_log),
            mitm_ctx(),
        ):
            result = await handle_firewall_request_without_upstream_admission(
                flow, allow, sandbox_info
            )

        assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
        get_headers.assert_not_called()
        mock_forward.assert_not_called()
        assert flow.response is not None
        assert flow.response.status_code == 413
        body = json.loads(flow.response.content)
        assert body == {
            "error": "auth_base_request_body_too_large",
            "message": "auth.base request body too large",
            "permission": allow.name,
            "base": allow.api_entry["base"],
        }
        assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "auth_base_request_body_too_large"
        assert metadata_keys.AUTH_URL_REWRITE not in flow.metadata
        assert metadata_keys.AUTH_RESOLVED_SECRETS not in flow.metadata
        response_text = flow.response.text
        assert "super-secret-body" not in response_text
        assert "super-secret-token" not in response_text
        assert "Bearer real-token" not in response_text
        assert "iv:tag:data" not in response_text
        assert mock_log.call_args is not None
        _args, kwargs = mock_log.call_args
        assert kwargs["firewall_base"] == allow.api_entry["base"]
        assert kwargs["request_body_size_bytes"] == len(request_body)
        assert kwargs["request_body_limit_bytes"] == 4
        for log_call in mock_log.call_args_list:
            assert "super-secret-body" not in json.dumps(log_call.args)
            assert "super-secret-token" not in json.dumps(log_call.args)
            assert "Bearer real-token" not in json.dumps(log_call.args)
            assert "iv:tag:data" not in json.dumps(log_call.args)
            assert "super-secret-body" not in json.dumps(log_call.kwargs)
            assert "super-secret-token" not in json.dumps(log_call.kwargs)
            assert "Bearer real-token" not in json.dumps(log_call.kwargs)
            assert "iv:tag:data" not in json.dumps(log_call.kwargs)

    async def test_forward_request_too_large_error_returns_413(self, real_flow, mitm_ctx, tmp_path):
        flow, allow, sandbox_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            method="POST",
            request_body=b"1234",
            resolved_base="https://real.example.com/webhook/super-secret-token",
            auth_overrides={"headers": {"Authorization": "Bearer ${{ secrets.TOKEN }}"}},
            token_overrides={"headers": {"Authorization": "Bearer real-token"}},
        )
        mock_forward = AsyncMock(side_effect=forwarder.ForwardedRequestTooLargeError())
        mock_log = MagicMock()
        with (
            patch.object(auth, "MAX_AUTH_BASE_REQUEST_BODY_BYTES", 100),
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            patch.object(auth, "log_proxy_entry", mock_log),
            mitm_ctx(),
        ):
            result = await handle_firewall_request_without_upstream_admission(
                flow, allow, sandbox_info
            )

        assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
        assert mock_forward.call_count == 1
        assert flow.response is not None
        assert flow.response.status_code == 413
        body = json.loads(flow.response.content)
        assert body["error"] == "auth_base_request_body_too_large"
        assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "auth_base_request_body_too_large"
        assert metadata_keys.AUTH_URL_REWRITE not in flow.metadata
        assert "url_rewrite_forward_failed" not in flow.response.text
        assert "super-secret-token" not in flow.response.text
        assert "Bearer real-token" not in flow.response.text
        for log_call in mock_log.call_args_list:
            assert "super-secret-token" not in json.dumps(log_call.args)
            assert "Bearer real-token" not in json.dumps(log_call.args)
            assert "super-secret-token" not in json.dumps(log_call.kwargs)
            assert "Bearer real-token" not in json.dumps(log_call.kwargs)

    async def test_non_auth_base_rule_does_not_use_auth_base_body_cap(
        self, real_flow, mitm_ctx, tmp_path
    ):
        flow, allow, sandbox_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            method="POST",
            request_body=b"12345",
            auth_overrides={
                "base": None,
                "headers": {"Authorization": "Bearer ${{ secrets.TOKEN }}"},
            },
            token_overrides={
                "base": None,
                "headers": {"Authorization": "Bearer real-token"},
            },
        )
        get_headers = AsyncMock(return_value=token_meta)
        with (
            patch.object(auth, "MAX_AUTH_BASE_REQUEST_BODY_BYTES", 4),
            patch.object(auth, "get_firewall_headers", get_headers),
            mitm_ctx(),
        ):
            result = await handle_firewall_request_without_upstream_admission(
                flow, allow, sandbox_info
            )

        assert result is auth.FirewallAuthHandlingResult.CONTINUE_UPSTREAM
        assert get_headers.await_count == 1
        assert flow.response is None
        assert flow.request.headers["Authorization"] == "Bearer real-token"
        assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
        assert metadata_keys.FIREWALL_ERROR not in flow.metadata
        assert metadata_keys.AUTH_URL_REWRITE not in flow.metadata

    async def test_forward_failure_returns_502(self, headers, real_flow, mitm_ctx, tmp_path):
        """forward_request exception produces a 502 error response and marks
        firewall_error without falling through to the success-path metadata.

        Regression for #10341: the except block previously lacked a ``return``,
        so ``auth_url_rewrite`` and a misleading ``Firewall URL rewrite`` info
        log were emitted on failure, and ``firewall_error`` was left unset —
        making failed rewrites indistinguishable from successful ones in
        dashboards."""
        flow, allow, sandbox_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            path="/hook?client=visible",
            request_headers=headers(
                ("Host", "firewall-placeholder.vm3.ai"),
                ("Authorization", "Bearer agent"),
            ),
            auth_overrides={
                "headers": {
                    "Authorization": "Bearer ${{ secrets.TOKEN }}",
                    "X-Custom": "${{ secrets.CUSTOM }}",
                },
                "query": {"api_key": "${{ secrets.API_KEY }}"},
            },
            token_overrides={
                "headers": {
                    "Authorization": "Bearer real-token",
                    "X-Custom": "injected-value",
                },
                "query": {"api_key": "resolved-key"},
                "resolved_secrets": ["WEBHOOK"],
                "refreshed_connectors": ["discord"],
                "refreshed_secrets": ["WEBHOOK"],
                "cache_hit": False,
            },
        )
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH] = str(proxy_log_path)
        mock_forward = AsyncMock(side_effect=Exception("connection refused"))
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            result = await handle_firewall_request_without_upstream_admission(
                flow, allow, sandbox_info
            )
        assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
        failed_url = mock_forward.call_args[0][0]
        failed_query = parse_qs(urlparse(failed_url).query, keep_blank_values=True)
        failed_headers = mock_forward.call_args[0][2]
        assert failed_query["api_key"] == ["resolved-key"]
        assert failed_query["client"] == ["visible"]
        assert ("Authorization", "Bearer agent") not in failed_headers
        assert ("Authorization", "Bearer real-token") in failed_headers
        assert ("X-Custom", "injected-value") in failed_headers
        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.response.headers["Content-Type"] == "application/json"
        body = json.loads(flow.response.content)
        assert body["error"] == "url_rewrite_forward_failed"
        assert body["message"] == "Failed to forward request to upstream"
        assert body["permission"] == allow.name
        assert body["base"] == allow.api_entry["base"]
        assert "connectors" not in body
        # Failure must not masquerade as a successful rewrite.
        assert metadata_keys.AUTH_URL_REWRITE not in flow.metadata
        assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "url_rewrite_forward_failed"
        assert metadata_keys.AUTH_RESOLVED_SECRETS not in flow.metadata
        assert metadata_keys.AUTH_REFRESHED_CONNECTORS not in flow.metadata
        assert metadata_keys.AUTH_REFRESHED_SECRETS not in flow.metadata
        assert metadata_keys.AUTH_CACHE_HIT not in flow.metadata
        assert flow.request.headers["Authorization"] == "Bearer agent"
        assert "X-Custom" not in flow.request.headers
        assert "api_key" not in flow.request.query
        assert flow.request.query["client"] == "visible"
        # Success-path log line must not be written.
        log_text = await asyncio.to_thread(read_jsonl_text_after_flush, proxy_log_path)
        assert "URL rewrite forward failed" in log_text
        assert "Firewall URL rewrite:" not in log_text
        assert f"Firewall {allow.api_entry['base']}:" not in log_text

    async def test_forward_saturation_returns_dedicated_local_error(
        self, headers, real_flow, mitm_ctx, tmp_path
    ):
        flow, allow, sandbox_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            path="/hook",
            request_headers=headers(("Host", "firewall-placeholder.vm3.ai")),
            token_overrides={
                "headers": {},
                "resolved_secrets": ["WEBHOOK"],
                "refreshed_connectors": [],
                "refreshed_secrets": [],
                "cache_hit": False,
            },
        )
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH] = str(proxy_log_path)
        mock_forward = AsyncMock(side_effect=forwarder.AuthBaseForwardingSaturatedError())
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            result = await handle_firewall_request_without_upstream_admission(
                flow, allow, sandbox_info
            )

        assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
        assert flow.response is not None
        assert flow.response.status_code == 503
        body = json.loads(flow.response.content)
        assert body["error"] == auth.AUTH_BASE_FORWARDING_SATURATED_ERROR
        assert body["message"] == "auth.base forwarding is temporarily saturated"
        assert body["permission"] == allow.name
        assert body["base"] == allow.api_entry["base"]
        assert metadata_keys.AUTH_URL_REWRITE not in flow.metadata
        assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
        assert (
            flow.metadata[metadata_keys.FIREWALL_ERROR] == auth.AUTH_BASE_FORWARDING_SATURATED_ERROR
        )
        assert flow.metadata[metadata_keys.SUPPRESS_REQUEST_BODY_CAPTURE] is True

        log_text = await asyncio.to_thread(read_jsonl_text_after_flush, proxy_log_path)
        assert "auth.base forwarding admission saturated" in log_text
        assert "URL rewrite forward failed" not in log_text
        assert "Firewall URL rewrite:" not in log_text
