"""auth.base rewrite safety and fail-closed handler tests."""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch
from urllib.parse import urlparse

import pytest
from mitmproxy import http

import auth
import auth_base_forwarder as forwarder
import auth_base_rewrite
import flow_metadata_keys as metadata_keys
from tests.auth_base_forwarder_helpers import fake_forwarder_upstream
from tests.firewall_auth_helpers import handle_firewall_request_without_upstream_admission
from tests.firewall_rewrite_helpers import make_safety_rewrite_inputs
from tests.jsonl_log_helpers import read_jsonl_text_after_flush


class TestAuthBaseUrlRewriteSafety:
    """auth.base rewrite safety and fail-closed handler tests."""

    async def test_forward_failure_does_not_log_resolved_url_secret(
        self, real_flow, mitm_ctx, tmp_path
    ):
        """Forward errors must not leak secret-bearing resolved auth.base URLs."""
        flow, allow, sandbox_info, token_meta = make_safety_rewrite_inputs(
            real_flow,
            tmp_path,
            resolved_base="https://real.example.com/webhook/super-secret-token",
        )
        mock_forward = AsyncMock(
            side_effect=Exception("failed https://real.example.com/webhook/super-secret-token")
        )
        mock_log = MagicMock()
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            patch.object(auth, "log_proxy_entry", mock_log),
            mitm_ctx(),
        ):
            await handle_firewall_request_without_upstream_admission(flow, allow, sandbox_info)

        assert flow.response is not None
        assert b"super-secret-token" not in flow.response.content
        for log_call in mock_log.call_args_list:
            assert "super-secret-token" not in json.dumps(log_call.args)
            assert "super-secret-token" not in json.dumps(log_call.kwargs)

    async def test_blocked_forward_destination_returns_502_without_mutating_request(
        self, headers, real_flow, mitm_ctx, tmp_path
    ):
        """Forwarder destination guard failures use the local rewrite failure path."""
        flow, allow, sandbox_info, token_meta = make_safety_rewrite_inputs(
            real_flow,
            tmp_path,
            path="/hook?client=visible",
            request_headers=headers(
                ("Host", "firewall-placeholder.vm3.ai"),
                ("Authorization", "Bearer agent"),
            ),
            resolved_base="https://127.0.0.1/webhook/super-secret-token",
            token_overrides={
                "headers": {
                    "Authorization": "Bearer real-token",
                    "X-Custom": "injected-value",
                },
                "query": {"api_key": "resolved-key"},
            },
        )
        mock_forward = AsyncMock(
            side_effect=forwarder.UnsafeAuthBaseDestinationError(
                "Unsafe auth.base upstream destination"
            )
        )
        mock_log = MagicMock()

        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            patch.object(auth, "log_proxy_entry", mock_log),
            mitm_ctx(),
        ):
            await handle_firewall_request_without_upstream_admission(flow, allow, sandbox_info)

        assert mock_forward.call_count == 1
        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "url_rewrite_forward_failed"
        assert metadata_keys.AUTH_URL_REWRITE not in flow.metadata
        assert flow.request.headers["Authorization"] == "Bearer agent"
        assert "X-Custom" not in flow.request.headers
        assert "api_key" not in flow.request.query
        assert flow.request.query["client"] == "visible"
        assert "super-secret-token" not in flow.response.text
        for log_call in mock_log.call_args_list:
            assert "super-secret-token" not in json.dumps(log_call.args)
            assert "super-secret-token" not in json.dumps(log_call.kwargs)

    async def test_real_forwarder_destination_rejection_returns_502_without_leaking_url(
        self, headers, real_flow, mitm_ctx, tmp_path
    ):
        """Handler maps real forwarder destination rejection to local failure."""
        flow, allow, sandbox_info, token_meta = make_safety_rewrite_inputs(
            real_flow,
            tmp_path,
            path="/hook?client=visible",
            request_headers=headers(
                ("Host", "firewall-placeholder.vm3.ai"),
                ("Authorization", "Bearer agent"),
            ),
            resolved_base="https://real.example.com/webhook/super-secret-token",
            token_overrides={
                "headers": {
                    "Authorization": "Bearer real-token",
                    "X-Custom": "injected-value",
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
            fake_forwarder_upstream(addresses=("127.0.0.1",)) as upstream,
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            result = await handle_firewall_request_without_upstream_admission(
                flow, allow, sandbox_info
            )

        assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
        assert upstream.resolve_calls == ["real.example.com"]
        assert upstream.connect_calls == []

        assert flow.response is not None
        assert flow.response.status_code == 502
        body = json.loads(flow.response.content)
        assert body["error"] == "url_rewrite_forward_failed"
        assert body["message"] == "Failed to forward request to upstream"
        assert body["permission"] == allow.name
        assert body["base"] == allow.api_entry["base"]
        assert "connectors" not in body

        assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "url_rewrite_forward_failed"
        assert metadata_keys.AUTH_URL_REWRITE not in flow.metadata
        assert metadata_keys.AUTH_RESOLVED_SECRETS not in flow.metadata
        assert metadata_keys.AUTH_REFRESHED_CONNECTORS not in flow.metadata
        assert metadata_keys.AUTH_REFRESHED_SECRETS not in flow.metadata
        assert metadata_keys.AUTH_CACHE_HIT not in flow.metadata

        assert flow.request.headers["Authorization"] == "Bearer agent"
        assert flow.request.path == "/hook?client=visible"
        assert "X-Custom" not in flow.request.headers
        assert "api_key" not in flow.request.query
        assert flow.request.query["client"] == "visible"
        assert "super-secret-token" not in flow.response.text

        log_text = await asyncio.to_thread(read_jsonl_text_after_flush, proxy_log_path)
        assert "URL rewrite forward failed" in log_text
        assert "Firewall URL rewrite:" not in log_text
        assert "super-secret-token" not in log_text
        assert "real-token" not in log_text

    async def test_oversized_cached_resolved_base_fails_closed_before_forwarding(
        self, headers, real_flow, mitm_ctx, tmp_path
    ):
        resolved_base_prefix = "https://real.example.com/webhook/super-secret-token-"
        resolved_base = resolved_base_prefix + "x" * (
            auth_base_rewrite.MAX_RESOLVED_AUTH_BASE_CHARACTERS + 1 - len(resolved_base_prefix)
        )
        flow, allow, sandbox_info, token_meta = make_safety_rewrite_inputs(
            real_flow,
            tmp_path,
            path="/hook?client=visible",
            request_headers=headers(
                ("Host", "firewall-placeholder.vm3.ai"),
                ("Authorization", "Bearer agent"),
            ),
            resolved_base=resolved_base,
            token_overrides={
                "headers": {
                    "Authorization": "Bearer real-token",
                    "X-Custom": "injected-value",
                },
                "query": {"api_key": "resolved-key"},
                "cache_hit": True,
            },
        )
        get_headers = AsyncMock(return_value=token_meta)
        mock_forward = AsyncMock()
        mock_log = MagicMock()

        with (
            patch.object(auth, "get_firewall_headers", get_headers),
            patch.object(auth, "forward_request", mock_forward),
            patch.object(auth, "log_proxy_entry", mock_log),
            mitm_ctx(),
        ):
            result = await handle_firewall_request_without_upstream_admission(
                flow, allow, sandbox_info
            )

        assert len(resolved_base) == auth_base_rewrite.MAX_RESOLVED_AUTH_BASE_CHARACTERS + 1
        assert token_meta["cache_hit"] is True
        get_headers.assert_awaited_once()
        mock_forward.assert_not_awaited()
        assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
        assert flow.response is not None
        assert flow.response.status_code == 502
        assert json.loads(flow.response.content)["error"] == "url_rewrite_forward_failed"
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "url_rewrite_forward_failed"
        assert metadata_keys.AUTH_URL_REWRITE not in flow.metadata
        assert metadata_keys.AUTH_CACHE_HIT not in flow.metadata
        assert flow.request.headers["Authorization"] == "Bearer agent"
        assert "X-Custom" not in flow.request.headers
        assert "api_key" not in flow.request.query
        assert flow.request.query["client"] == "visible"
        assert "super-secret-token" not in flow.response.text
        assert "super-secret-token" not in json.dumps(mock_log.call_args_list)

    @pytest.mark.parametrize(
        ("extra_bytes", "accepted"),
        [
            pytest.param(0, True, id="exact-limit"),
            pytest.param(1, False, id="over-limit"),
        ],
    )
    async def test_request_target_size_boundary(
        self,
        real_flow,
        mitm_ctx,
        tmp_path,
        extra_bytes: int,
        accepted: bool,
    ):
        path_prefix = "/hook?"
        request_path = path_prefix + "x" * (
            auth.MAX_AUTH_BASE_REQUEST_TARGET_BYTES - len(path_prefix) + extra_bytes
        )
        flow, allow, sandbox_info, token_meta = make_safety_rewrite_inputs(
            real_flow,
            tmp_path,
            path=request_path,
            resolved_base="https://real.example.com/webhook/super-secret-token?base=trusted",
        )
        assert len(flow.request.data.path) == (
            auth.MAX_AUTH_BASE_REQUEST_TARGET_BYTES + extra_bytes
        )
        get_headers = AsyncMock(return_value=token_meta)
        mock_forward = AsyncMock(return_value=(200, b"", http.Headers()))
        mock_log = MagicMock()

        with (
            patch.object(auth, "get_firewall_headers", get_headers),
            patch.object(auth, "forward_request", mock_forward),
            patch.object(auth, "log_proxy_entry", mock_log),
            mitm_ctx(),
        ):
            result = await handle_firewall_request_without_upstream_admission(
                flow, allow, sandbox_info
            )

        assert flow.request.path == request_path
        if accepted:
            assert result is auth.FirewallAuthHandlingResult.INLINE_PROVIDER_RESPONSE
            get_headers.assert_awaited_once()
            mock_forward.assert_awaited_once()
            assert flow.response is not None
            assert flow.response.status_code == 200
            assert flow.metadata[metadata_keys.AUTH_URL_REWRITE] is True
            assert metadata_keys.FIREWALL_ERROR not in flow.metadata
            return

        assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
        get_headers.assert_not_awaited()
        mock_forward.assert_not_awaited()
        assert flow.response is not None
        assert flow.response.status_code == 414
        assert json.loads(flow.response.content)["error"] == "auth_base_request_target_too_large"
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "auth_base_request_target_too_large"
        assert metadata_keys.AUTH_URL_REWRITE not in flow.metadata
        assert metadata_keys.AUTH_RESOLVED_SECRETS not in flow.metadata
        [limit_log] = [
            call
            for call in mock_log.call_args_list
            if call.args[2] == "auth.base request target too large"
        ]
        assert limit_log.kwargs["request_target_size_bytes"] == (
            auth.MAX_AUTH_BASE_REQUEST_TARGET_BYTES + 1
        )
        assert limit_log.kwargs["request_target_limit_bytes"] == (
            auth.MAX_AUTH_BASE_REQUEST_TARGET_BYTES
        )
        assert "super-secret-token" not in flow.response.text
        assert "super-secret-token" not in json.dumps(mock_log.call_args_list)

    @pytest.mark.parametrize(
        ("client_segments", "separator", "raw_pair", "accepted"),
        [
            pytest.param(
                auth_base_rewrite.MAX_AUTH_BASE_QUERY_PAIRS - 2,
                "&",
                "x",
                True,
                id="exact-aggregate-limit",
            ),
            pytest.param(
                auth_base_rewrite.MAX_AUTH_BASE_QUERY_PAIRS - 1,
                ";",
                "",
                False,
                id="over-limit-empty-semicolon-segments",
            ),
        ],
    )
    async def test_trusted_query_pair_boundary(
        self,
        real_flow,
        mitm_ctx,
        tmp_path,
        client_segments: int,
        separator: str,
        raw_pair: str,
        accepted: bool,
    ):
        client_query = separator.join([raw_pair] * client_segments)
        request_path = f"/hook?{client_query}"
        flow, allow, sandbox_info, token_meta = make_safety_rewrite_inputs(
            real_flow,
            tmp_path,
            path=request_path,
            resolved_base="https://real.example.com/webhook/super-secret-token?base=trusted",
            auth_overrides={
                "headers": {"Authorization": "Bearer ${{ secrets.TOKEN }}"},
                "query": {"api_key": "${{ secrets.API_KEY }}"},
            },
            token_overrides={
                "headers": {"Authorization": "Bearer real-token"},
                "query": {"api_key": "resolved-secret"},
                "resolved_secrets": ["TOKEN", "API_KEY"],
            },
        )
        get_headers = AsyncMock(return_value=token_meta)
        mock_forward = AsyncMock(return_value=(200, b"", http.Headers()))
        mock_log = MagicMock()

        with (
            patch.object(auth, "get_firewall_headers", get_headers),
            patch.object(auth, "forward_request", mock_forward),
            patch.object(auth, "log_proxy_entry", mock_log),
            mitm_ctx(),
        ):
            result = await handle_firewall_request_without_upstream_admission(
                flow, allow, sandbox_info
            )

        get_headers.assert_awaited_once()
        assert flow.request.path == request_path
        assert "Authorization" not in flow.request.headers
        assert "api_key" not in flow.request.query
        if accepted:
            assert result is auth.FirewallAuthHandlingResult.INLINE_PROVIDER_RESPONSE
            mock_forward.assert_awaited_once()
            assert flow.response is not None
            assert flow.response.status_code == 200
            assert flow.metadata[metadata_keys.AUTH_URL_REWRITE] is True
            assert metadata_keys.FIREWALL_ERROR not in flow.metadata
            return

        assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
        mock_forward.assert_not_awaited()
        assert flow.response is not None
        assert flow.response.status_code == 414
        assert json.loads(flow.response.content)["error"] == "auth_base_query_too_many_pairs"
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "auth_base_query_too_many_pairs"
        assert metadata_keys.AUTH_URL_REWRITE not in flow.metadata
        assert metadata_keys.AUTH_RESOLVED_SECRETS not in flow.metadata
        [limit_log] = [
            call
            for call in mock_log.call_args_list
            if call.args[2] == "auth.base rewritten query has too many pairs"
        ]
        assert limit_log.kwargs["query_pair_limit"] == auth_base_rewrite.MAX_AUTH_BASE_QUERY_PAIRS
        assert "super-secret-token" not in flow.response.text
        assert "resolved-secret" not in flow.response.text
        assert "super-secret-token" not in json.dumps(mock_log.call_args_list)
        assert "resolved-secret" not in json.dumps(mock_log.call_args_list)

    async def test_forwarded_url_uses_resolved_query_over_base_and_client_aliases(
        self, real_flow, mitm_ctx, tmp_path
    ):
        flow, allow, sandbox_info, token_meta = make_safety_rewrite_inputs(
            real_flow,
            tmp_path,
            path="/hook?api_key=client;reg%69on=client&client=%C3%A9&&api%5fkey=client2",
            resolved_base="https://real.example.com/webhook/super-secret-token?api%5Fkey=base;region=us",
            auth_overrides={"query": {"api_key": "${{ secrets.API_KEY }}"}},
            token_overrides={"query": {"api_key": "resolved-secret"}},
        )
        mock_forward = AsyncMock(return_value=(200, b"", http.Headers()))

        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            result = await handle_firewall_request_without_upstream_admission(
                flow, allow, sandbox_info
            )

        assert result is auth.FirewallAuthHandlingResult.INLINE_PROVIDER_RESPONSE
        mock_forward.assert_awaited_once()
        assert mock_forward.call_args.args[0] == (
            "https://real.example.com/webhook/super-secret-token"
            "?region=us&client=%C3%A9&api_key=resolved-secret"
        )

    async def test_truncated_upstream_response_returns_502_without_partial_body(
        self, headers, real_flow, mitm_ctx, tmp_path
    ):
        partial_body = b'{"secret":"partial-upstream-secret"}'
        flow, allow, sandbox_info, token_meta = make_safety_rewrite_inputs(
            real_flow,
            tmp_path,
            path="/hook?client=visible",
            request_headers=headers(
                ("Host", "firewall-placeholder.vm3.ai"),
                ("Authorization", "Bearer agent"),
            ),
            resolved_base="https://real.example.com/webhook/super-secret-token",
            token_overrides={
                "headers": {
                    "Authorization": "Bearer real-token",
                    "X-Custom": "injected-value",
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
                body=partial_body,
                headers=[("Content-Length", str(len(partial_body) + 5))],
            ) as upstream,
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            result = await handle_firewall_request_without_upstream_admission(
                flow, allow, sandbox_info
            )

        assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
        assert upstream.socket.response_file is not None
        assert upstream.socket.response_file.closed
        assert upstream.socket.closed

        assert flow.response is not None
        assert flow.response.status_code == 502
        response_body = json.loads(flow.response.content)
        assert response_body["error"] == "url_rewrite_forward_failed"
        assert response_body["message"] == "Failed to forward request to upstream"
        assert partial_body not in flow.response.content

        assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "url_rewrite_forward_failed"
        assert metadata_keys.AUTH_URL_REWRITE not in flow.metadata
        assert metadata_keys.AUTH_RESOLVED_SECRETS not in flow.metadata
        assert metadata_keys.AUTH_REFRESHED_CONNECTORS not in flow.metadata
        assert metadata_keys.AUTH_REFRESHED_SECRETS not in flow.metadata
        assert metadata_keys.AUTH_CACHE_HIT not in flow.metadata

        assert flow.request.headers["Authorization"] == "Bearer agent"
        assert flow.request.path == "/hook?client=visible"
        assert "X-Custom" not in flow.request.headers
        assert "api_key" not in flow.request.query
        assert flow.request.query["client"] == "visible"

        log_text = await asyncio.to_thread(read_jsonl_text_after_flush, proxy_log_path)
        assert "URL rewrite forward failed" in log_text
        assert "IncompleteRead" in log_text
        assert "Firewall URL rewrite:" not in log_text
        assert "partial-upstream-secret" not in log_text
        assert "super-secret-token" not in log_text
        assert "real-token" not in log_text

    async def test_resolved_base_http_fails_closed_without_forwarding(
        self, headers, real_flow, mitm_ctx, tmp_path
    ):
        """Secret-backed auth.base upstream URLs must not use cleartext HTTP."""
        flow, allow, sandbox_info, token_meta = make_safety_rewrite_inputs(
            real_flow,
            tmp_path,
            path="/hook?client=visible",
            request_headers=headers(
                ("Host", "firewall-placeholder.vm3.ai"),
                ("Authorization", "Bearer agent"),
            ),
            resolved_base="http://real.example.com/webhook/super-secret-token",
            token_overrides={
                "headers": {
                    "Authorization": "Bearer real-token",
                    "X-Custom": "injected-value",
                },
                "query": {"api_key": "resolved-key"},
            },
        )
        mock_forward = AsyncMock()
        mock_log = MagicMock()
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            patch.object(auth, "log_proxy_entry", mock_log),
            mitm_ctx(),
        ):
            await handle_firewall_request_without_upstream_admission(flow, allow, sandbox_info)

        assert mock_forward.call_count == 0
        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "url_rewrite_forward_failed"
        assert "super-secret-token" not in flow.response.text
        assert flow.request.headers["Authorization"] == "Bearer agent"
        assert "X-Custom" not in flow.request.headers
        assert "api_key" not in flow.request.query
        assert flow.request.query["client"] == "visible"
        for log_call in mock_log.call_args_list:
            assert "super-secret-token" not in json.dumps(log_call.args)
            assert "super-secret-token" not in json.dumps(log_call.kwargs)

    async def test_resolved_base_fragment_fails_closed_without_forwarding(
        self, real_flow, mitm_ctx, tmp_path
    ):
        """Secret-backed auth.base fragments must not be silently dropped."""
        flow, allow, sandbox_info, token_meta = make_safety_rewrite_inputs(
            real_flow,
            tmp_path,
            resolved_base="https://real.example.com/webhook/super-secret-token#fragment",
        )
        mock_forward = AsyncMock()
        mock_log = MagicMock()
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            patch.object(auth, "log_proxy_entry", mock_log),
            mitm_ctx(),
        ):
            await handle_firewall_request_without_upstream_admission(flow, allow, sandbox_info)

        assert mock_forward.call_count == 0
        assert flow.response is not None
        assert flow.response.status_code == 502
        assert "super-secret-token" not in flow.response.text
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "url_rewrite_forward_failed"
        for log_call in mock_log.call_args_list:
            assert "super-secret-token" not in json.dumps(log_call.args)
            assert "super-secret-token" not in json.dumps(log_call.kwargs)

    async def test_resolved_base_bracketed_non_ipv6_fails_closed_without_forwarding(
        self, real_flow, mitm_ctx, tmp_path
    ):
        """Secret-backed auth.base bracket syntax must be limited to IPv6 literals."""
        flow, allow, sandbox_info, token_meta = make_safety_rewrite_inputs(
            real_flow,
            tmp_path,
            resolved_base="https://[v1.invalid]/webhook/super-secret-token",
        )
        mock_forward = AsyncMock()
        mock_log = MagicMock()
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            patch.object(auth, "log_proxy_entry", mock_log),
            mitm_ctx(),
        ):
            await handle_firewall_request_without_upstream_admission(flow, allow, sandbox_info)

        assert mock_forward.call_count == 0
        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "url_rewrite_forward_failed"
        assert "super-secret-token" not in flow.response.text
        for log_call in mock_log.call_args_list:
            assert "super-secret-token" not in json.dumps(log_call.args)
            assert "super-secret-token" not in json.dumps(log_call.kwargs)

    @pytest.mark.parametrize(
        "request_path",
        [
            "//[foo]?client=visible",
            "/hook?client=visible\nsecret",
        ],
    )
    async def test_malformed_request_target_fails_closed_without_forwarding(
        self, real_flow, mitm_ctx, tmp_path, request_path
    ):
        """Malformed request target query extraction must use the local rewrite failure path."""
        flow, allow, sandbox_info, token_meta = make_safety_rewrite_inputs(
            real_flow,
            tmp_path,
            path=request_path,
            resolved_base="https://real.example.com/webhook/super-secret-token",
        )
        mock_forward = AsyncMock()
        mock_log = MagicMock()
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            patch.object(auth, "log_proxy_entry", mock_log),
            mitm_ctx(),
        ):
            await handle_firewall_request_without_upstream_admission(flow, allow, sandbox_info)

        assert mock_forward.call_count == 0
        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "url_rewrite_forward_failed"
        assert metadata_keys.AUTH_URL_REWRITE not in flow.metadata
        assert "super-secret-token" not in flow.response.text
        for log_call in mock_log.call_args_list:
            assert "super-secret-token" not in json.dumps(log_call.args)
            assert "super-secret-token" not in json.dumps(log_call.kwargs)

    @pytest.mark.parametrize(
        "resolved_base",
        [
            "https://real.example.com/webhook/%5csuper-secret-token",
            "https://real.example.com/webhook/%255csuper-secret-token",
            "https://real.example.com/webhook/%zzsuper-secret-token",
            "https://real.example.com/webhook/%25zzsuper-secret-token",
            "https://real.example.com/webhook/%00super-secret-token",
            "https://real.example.com/webhook/%2500super-secret-token",
            "https://real.example.com/webhook/%7fsuper-secret-token",
            "https://real.example.com/webhook/%ef%bc%8e%ef%bc%8e/super-secret-token",
            "https://real.example.com/webhook/%ef%bc%8f../super-secret-token",
            "https://real.example.com/webhook/%ef%bc%bcsuper-secret-token",
            "https://real.example.com/webhook/%ef%bc%852esuper-secret-token",
            "https://real.example.com/webhook/%ffsuper-secret-token",
            "https://real.example.com/webhook/%25ffsuper-secret-token",
            "https://real.example.com/webhook/%ed%a0%80super-secret-token",
        ],
    )
    async def test_resolved_base_unsafe_path_fails_closed_without_forwarding(
        self, real_flow, mitm_ctx, tmp_path, resolved_base
    ):
        """Secret-backed auth.base paths must reject unsafe path syntax."""
        flow, allow, sandbox_info, token_meta = make_safety_rewrite_inputs(
            real_flow,
            tmp_path,
            resolved_base=resolved_base,
        )
        mock_forward = AsyncMock()
        mock_log = MagicMock()
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            patch.object(auth, "log_proxy_entry", mock_log),
            mitm_ctx(),
        ):
            await handle_firewall_request_without_upstream_admission(flow, allow, sandbox_info)

        assert mock_forward.call_count == 0
        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "url_rewrite_forward_failed"
        for log_call in mock_log.call_args_list:
            assert "super-secret-token" not in json.dumps(log_call.args)
            assert "super-secret-token" not in json.dumps(log_call.kwargs)

    async def test_empty_resolved_base_fails_closed(self, real_flow, mitm_ctx, tmp_path):
        flow, allow, sandbox_info, token_meta = make_safety_rewrite_inputs(
            real_flow,
            tmp_path,
            auth_overrides={
                "headers": {"Authorization": "Bearer ${{ secrets.TOKEN }}"},
                "query": {"api_key": "${{ secrets.API_KEY }}"},
            },
            token_overrides={
                "headers": {"Authorization": "Bearer real-token"},
                "query": {"api_key": "resolved-key"},
                "resolved_secrets": ["TOKEN", "API_KEY"],
            },
        )
        token_meta["base"] = ""
        original_url = urlparse(flow.request.url)
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            result = await handle_firewall_request_without_upstream_admission(
                flow, allow, sandbox_info
            )
        updated_url = urlparse(flow.request.url)
        assert updated_url.scheme == original_url.scheme
        assert updated_url.netloc == original_url.netloc
        assert updated_url.path == original_url.path
        assert metadata_keys.AUTH_URL_REWRITE not in flow.metadata
        assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
        assert flow.response is not None
        assert flow.response.status_code == 502
        assert json.loads(flow.response.content)["error"] == "auth_failed"
        assert "Authorization" not in flow.request.headers
        assert "api_key" not in flow.request.query
        assert metadata_keys.AUTH_RESOLVED_SECRETS not in flow.metadata
