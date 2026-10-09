"""Tests for firewall auth query injection."""

from unittest.mock import AsyncMock, patch
from urllib.parse import parse_qs, urlparse

import pytest
from mitmproxy import http

import auth
import flow_metadata_keys as metadata_keys
from tests.firewall_auth_helpers import (
    apply_requestheaders_auth_without_upstream_admission,
    firewall_auth_response,
    handle_firewall_request_without_upstream_admission,
    make_allow,
)
from tests.firewall_rewrite_helpers import make_forwarding_rewrite_inputs


def make_query_inputs(
    real_flow,
    *,
    host="api.github.com",
    path="/repos",
    api_base="https://serpapi.com",
    auth_overrides=None,
    token_overrides=None,
    match_overrides=None,
):
    flow = real_flow(with_response=False, host=host, path=path)
    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "test-run"
    auth_config = {
        "headers": {},
        "query": {"api_key": "${{ secrets.SERPAPI_TOKEN }}"},
    }
    if auth_overrides:
        auth_config.update(auth_overrides)
    api_entry = {
        "id": "run-1:0",
        "base": api_base,
        "auth": auth_config,
    }
    sandbox_info = {
        "runId": "run-1",
        "sandboxToken": "tok",
        "encryptedSecrets": "iv:tag:data",
        "billableFirewalls": [],
    }
    allow_kwargs = {
        "name": "serpapi",
        "permission": "search",
        "rule": "GET /search",
        "params": {},
    }
    if match_overrides:
        allow_kwargs.update(match_overrides)
    allow = make_allow(api_entry, **allow_kwargs)
    token_meta = firewall_auth_response(
        headers={},
        resolved_secrets=["SERPAPI_TOKEN"],
        query={"api_key": "resolved-key-123"},
    )
    if token_overrides:
        token_meta.update(token_overrides)
    return flow, allow, sandbox_info, token_meta


# =========================================================================
# auth.query injection
# =========================================================================


class TestAuthQueryInjection:
    """Tests for query parameter injection via auth.query."""

    @pytest.mark.parametrize(
        ("hook_phase", "expected_result"),
        [
            pytest.param(
                "request",
                auth.FirewallAuthHandlingResult.CONTINUE_UPSTREAM,
                id="request",
            ),
            pytest.param(
                "requestheaders",
                auth.FirewallHeaderPhaseAuthResult.APPLIED,
                id="requestheaders",
            ),
        ],
    )
    async def test_query_params_are_merged_with_one_query_read_and_write(
        self,
        real_flow,
        mitm_ctx,
        monkeypatch,
        hook_phase,
        expected_result,
    ):
        bulk_query = {f"bulk_{index}": f"value_{index}" for index in range(64)}
        resolved_query = {
            "managed": "resolved-managed",
            "new_first": "first",
            **bulk_query,
            "duplicate": "resolved-duplicate",
            "new_last": "last",
        }
        flow, allow, sandbox_info, token_meta = make_query_inputs(
            real_flow,
            host="serpapi.com",
            path=(
                "/search;matrix=1?managed=old-1&keep=1&managed=old-2"
                "&repeat=one&repeat=two&empty=&duplicate=old-1&duplicate=old-2#fragment"
            ),
            auth_overrides={
                "query": dict.fromkeys(resolved_query, "${{ secrets.VALUE }}"),
            },
            token_overrides={"query": resolved_query},
        )
        query_reads = 0
        query_writes = 0
        original_get_query = http.Request._get_query
        original_set_query = http.Request._set_query

        def counted_get_query(request):
            nonlocal query_reads
            query_reads += 1
            return original_get_query(request)

        def counted_set_query(request, query_data):
            nonlocal query_writes
            query_writes += 1
            return original_set_query(request, query_data)

        monkeypatch.setattr(http.Request, "_get_query", counted_get_query)
        monkeypatch.setattr(http.Request, "_set_query", counted_set_query)

        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            if hook_phase == "request":
                result = await handle_firewall_request_without_upstream_admission(
                    flow, allow, sandbox_info
                )
            else:
                result = await apply_requestheaders_auth_without_upstream_admission(
                    flow, allow, sandbox_info
                )

        assert result is expected_result
        assert (query_reads, query_writes) == (1, 1)
        assert list(flow.request.query.items(multi=True)) == [
            ("managed", "resolved-managed"),
            ("keep", "1"),
            ("repeat", "one"),
            ("repeat", "two"),
            ("empty", ""),
            ("duplicate", "resolved-duplicate"),
            ("new_first", "first"),
            *bulk_query.items(),
            ("new_last", "last"),
        ]
        parsed_url = urlparse(flow.request.url)
        assert parsed_url.params == "matrix=1"
        assert parsed_url.fragment == "fragment"

    async def test_query_params_injected_on_standard_path(self, real_flow, mitm_ctx):
        """Resolved auth.query params are injected into flow.request.query."""
        flow, allow, sandbox_info, token_meta = make_query_inputs(
            real_flow,
            auth_overrides={
                "query": {
                    "api_key": "${{ secrets.SERPAPI_TOKEN }}",
                    "empty_auth": "${{ vars.EMPTY }}",
                    "space": "${{ vars.SPACE }}",
                },
            },
            token_overrides={
                "query": {
                    "api_key": "resolved-key-123",
                    "empty_auth": "",
                    "space": "a b",
                }
            },
        )
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            result = await handle_firewall_request_without_upstream_admission(
                flow, allow, sandbox_info
            )
        assert result is auth.FirewallAuthHandlingResult.CONTINUE_UPSTREAM
        assert metadata_keys.AUTH_URL_REWRITE not in flow.metadata
        assert flow.request.query["api_key"] == "resolved-key-123"
        assert flow.request.query["empty_auth"] == ""
        assert flow.request.query["space"] == "a b"

    async def test_query_param_overwrites_existing_key(self, real_flow, mitm_ctx):
        """auth.query overwrites a query param already present in the original request."""
        flow, allow, sandbox_info, token_meta = make_query_inputs(
            real_flow,
            host="serpapi.com",
            path=(
                "/search?api_key=agent-value&api_key=stale-value"
                "&q=test&empty=&repeat=one&repeat=two"
            ),
            token_overrides={"query": {"api_key": "real-secret-key"}},
        )
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await handle_firewall_request_without_upstream_admission(flow, allow, sandbox_info)
        # auth.query overwrites the agent's api_key
        assert flow.request.query["api_key"] == "real-secret-key"
        assert list(flow.request.query.get_all("api_key")) == ["real-secret-key"]
        # Other query params are preserved
        assert flow.request.query["q"] == "test"
        assert flow.request.query["empty"] == ""
        query_items = list(flow.request.query.items(multi=True))
        assert query_items.count(("repeat", "one")) == 1
        assert query_items.count(("repeat", "two")) == 1

    async def test_query_params_with_headers_simultaneously(self, real_flow, mitm_ctx):
        """auth.query and auth.headers can coexist on the standard path."""
        flow, allow, sandbox_info, token_meta = make_query_inputs(
            real_flow,
            api_base="https://example.com",
            auth_overrides={
                "headers": {"Authorization": "Bearer ${{ secrets.TOKEN }}"},
                "query": {"key": "${{ secrets.QUERY_KEY }}"},
            },
            token_overrides={
                "headers": {"Authorization": "Bearer real-token"},
                "resolved_secrets": ["TOKEN", "QUERY_KEY"],
                "query": {"key": "resolved-query-value"},
            },
            match_overrides={"name": "ex", "permission": "read", "rule": "GET /data"},
        )
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await handle_firewall_request_without_upstream_admission(flow, allow, sandbox_info)
        assert flow.request.headers["Authorization"] == "Bearer real-token"
        assert flow.request.query["key"] == "resolved-query-value"

    async def test_query_params_merged_into_rewrite_url(
        self, real_flow, mitm_ctx, headers, tmp_path
    ):
        """auth.query params are forwarded without mutating the placeholder request."""
        flow, allow, sandbox_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            path="/hook?client=visible",
            request_headers=headers(
                ("Authorization", "Bearer agent"),
                ("Cookie", "session=agent"),
                ("X-Api-Key", "agent-api-key"),
                ("X-Keep", "client"),
            ),
            api_base="https://firewall-placeholder.vm3.ai/webhook/hook",
            resolved_base="https://real-api.com/webhook/secret",
            auth_overrides={"query": {"api_key": "${{ secrets.KEY }}"}},
            token_overrides={
                "resolved_secrets": ["WEBHOOK", "KEY"],
                "query": {"api_key": "resolved-key-456"},
            },
        )
        mock_forward = AsyncMock(return_value=(200, b"ok", {}))
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            await handle_firewall_request_without_upstream_admission(flow, allow, sandbox_info)
        assert flow.metadata[metadata_keys.AUTH_URL_REWRITE] is True
        # Verify the forwarded URL contains the auth.query params
        call_args = mock_forward.call_args
        forwarded_url = call_args[0][0]
        req_headers = call_args[0][2]
        forwarded_header_names = {name.lower() for name, _value in req_headers}
        query = parse_qs(urlparse(forwarded_url).query)
        assert query["api_key"] == ["resolved-key-456"]
        assert query["client"] == ["visible"]
        assert forwarded_url.startswith("https://real-api.com/webhook/secret")
        assert "authorization" not in forwarded_header_names
        assert "cookie" not in forwarded_header_names
        assert "x-api-key" not in forwarded_header_names
        assert "x-keep" not in forwarded_header_names
        assert "api_key" not in flow.request.query
        assert flow.request.query["client"] == "visible"
        assert flow.request.headers["Authorization"] == "Bearer agent"
        assert flow.request.headers["Cookie"] == "session=agent"

    async def test_query_params_overwrite_existing_rewrite_url_keys(
        self, real_flow, mitm_ctx, tmp_path
    ):
        """auth.query overwrites duplicate keys while preserving other query values."""
        flow, allow, sandbox_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            path="/hook?api_key=agent-key&q=test&empty=&repeat=one&repeat=two",
            api_base="https://firewall-placeholder.vm3.ai/webhook/hook",
            resolved_base=(
                "https://real-api.com/webhook/secret?api_key=base-key&mode=fast&base_empty="
            ),
            auth_overrides={
                "query": {
                    "api_key": "${{ secrets.KEY }}",
                    "empty_auth": "${{ vars.EMPTY }}",
                    "space": "${{ vars.SPACE }}",
                },
            },
            token_overrides={
                "resolved_secrets": ["WEBHOOK", "KEY"],
                "query": {
                    "api_key": "resolved-key-456",
                    "empty_auth": "",
                    "space": "a b",
                },
            },
        )
        mock_forward = AsyncMock(return_value=(200, b"ok", {}))
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            await handle_firewall_request_without_upstream_admission(flow, allow, sandbox_info)

        forwarded = urlparse(mock_forward.call_args[0][0])
        query = parse_qs(forwarded.query, keep_blank_values=True)
        assert forwarded.scheme == "https"
        assert forwarded.netloc == "real-api.com"
        assert forwarded.path == "/webhook/secret"
        assert query["api_key"] == ["resolved-key-456"]
        assert query["mode"] == ["fast"]
        assert query["base_empty"] == [""]
        assert query["q"] == ["test"]
        assert query["empty"] == [""]
        assert query["empty_auth"] == [""]
        assert query["space"] == ["a b"]
        assert query["repeat"] == ["one", "two"]

    async def test_query_params_preserve_rewrite_path_params(self, real_flow, mitm_ctx, tmp_path):
        """auth.query merging must not strip URL path params from the rewrite target."""
        flow, allow, sandbox_info, token_meta = make_forwarding_rewrite_inputs(
            real_flow,
            tmp_path,
            path="/hook/callback;matrix=1?q=test",
            api_base="https://firewall-placeholder.vm3.ai/webhook/hook",
            resolved_base="https://real-api.com/webhook/secret;v=1?mode=fast",
            rel_path="/callback;matrix=1",
            auth_overrides={"query": {"api_key": "${{ secrets.KEY }}"}},
            token_overrides={
                "resolved_secrets": ["WEBHOOK", "KEY"],
                "query": {"api_key": "resolved-key"},
            },
        )
        mock_forward = AsyncMock(return_value=(200, b"ok", {}))
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            patch.object(auth, "forward_request", mock_forward),
            mitm_ctx(),
        ):
            await handle_firewall_request_without_upstream_admission(flow, allow, sandbox_info)

        forwarded = urlparse(mock_forward.call_args[0][0])
        assert forwarded.path == "/webhook/secret;v=1/callback"
        assert forwarded.params == "matrix=1"
        query = parse_qs(forwarded.query, keep_blank_values=True)
        assert query == {
            "mode": ["fast"],
            "q": ["test"],
            "api_key": ["resolved-key"],
        }

    async def test_no_query_injection_when_absent(self, real_flow, mitm_ctx):
        """No query modification when auth.query is not present."""
        flow = real_flow(with_response=False, host="api.github.com", path="/repos")
        flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "test-run"
        api_entry = {
            "id": "run-1:0",
            "base": "https://api.github.com",
            "auth": {"headers": {"Authorization": "Bearer ${{ secrets.TOKEN }}"}},
        }
        sandbox_info = {
            "runId": "run-1",
            "sandboxToken": "tok",
            "encryptedSecrets": "iv:tag:data",
            "billableFirewalls": [],
        }
        allow = make_allow(
            api_entry, name="gh", permission="read", rule="GET /repos/{owner}/{repo}"
        )
        token_meta = firewall_auth_response(
            headers={"Authorization": "Bearer real"},
            resolved_secrets=["TOKEN"],
        )
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await handle_firewall_request_without_upstream_admission(flow, allow, sandbox_info)
        assert flow.request.headers["Authorization"] == "Bearer real"
        # No query params should have been added
        assert len(flow.request.query) == 0
