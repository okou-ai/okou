"""Successful auth.base rewrite handler tests."""

import asyncio
from unittest.mock import AsyncMock, patch

import auth
import flow_metadata_keys as metadata_keys
from tests.auth_base_forwarder_helpers import fake_forwarder_upstream
from tests.firewall_auth_helpers import (
    firewall_auth_response,
    handle_firewall_request_without_upstream_admission,
)
from tests.firewall_rewrite_helpers import make_allow, make_success_rewrite_inputs
from tests.jsonl_log_helpers import read_jsonl_text_after_flush


def _allow_current_firewall_authorization() -> bool:
    return True


class TestAuthBaseUrlRewriteSuccess:
    """Successful auth.base rewrite handler tests."""

    async def test_no_url_rewrite_when_auth_base_absent(self, real_flow, mitm_ctx, tmp_path):
        """Without auth.base, no URL rewriting happens (existing behavior)."""
        flow = real_flow(with_response=False, host="api.github.com", path="/repos")
        flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "test-run"
        original_url = flow.request.url
        api_entry = {
            "id": "run-1:0",
            "base": "https://api.github.com",
            "auth": {"headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"}},
        }
        sandbox_info = {
            "runId": "run-1",
            "sandboxToken": "tok-xyz",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": str(tmp_path / "net.jsonl"),
            "billableFirewalls": [],
        }
        allow = make_allow(
            api_entry,
            name="github",
            permission="repo-read",
            rule="GET /repos/{owner}/{repo}",
        )
        token_meta = firewall_auth_response(
            headers={"Authorization": "Bearer real-token"},
            resolved_secrets=["GITHUB_TOKEN"],
        )
        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await handle_firewall_request_without_upstream_admission(flow, allow, sandbox_info)
        # URL should not be modified
        assert flow.request.url == original_url
        assert flow.request.headers["Authorization"] == "Bearer real-token"

    async def test_sets_auth_url_rewrite_metadata_and_response(self, real_flow, mitm_ctx, tmp_path):
        """auth_url_rewrite metadata is set and flow.response is populated via forward_request."""
        flow, allow, sandbox_info, token_meta = make_success_rewrite_inputs(
            real_flow,
            tmp_path,
            token_overrides={
                "resolved_secrets": ["WEBHOOK"],
                "refreshed_connectors": ["discord"],
                "refreshed_secrets": ["WEBHOOK"],
                "cache_hit": False,
            },
        )
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH] = str(proxy_log_path)
        with (
            fake_forwarder_upstream(
                body=b'{"ok":true}', headers=[("Content-Type", "application/json")]
            ),
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            result = await auth.handle_firewall_request(
                flow,
                allow,
                sandbox_info,
                revalidate_current_firewall_authorization=_allow_current_firewall_authorization,
            )
        assert result is auth.FirewallAuthHandlingResult.INLINE_PROVIDER_RESPONSE
        assert flow.metadata[metadata_keys.AUTH_URL_REWRITE] is True
        assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
        assert flow.metadata[metadata_keys.AUTH_RESOLVED_SECRETS] == ["WEBHOOK"]
        assert flow.metadata[metadata_keys.AUTH_REFRESHED_CONNECTORS] == ["discord"]
        assert flow.metadata[metadata_keys.AUTH_REFRESHED_SECRETS] == ["WEBHOOK"]
        assert flow.metadata[metadata_keys.AUTH_CACHE_HIT] is False
        assert flow.response is not None
        assert flow.response.status_code == 200
        log_text = await asyncio.to_thread(read_jsonl_text_after_flush, proxy_log_path)
        assert "Firewall URL rewrite:" in log_text
        assert f"Firewall {allow.api_entry['base']}:" in log_text

    async def test_upstream_error_response_is_forwarded(self, real_flow, mitm_ctx, tmp_path):
        """A non-2xx upstream response is still a successful local forward."""
        flow, allow, sandbox_info, token_meta = make_success_rewrite_inputs(real_flow, tmp_path)
        with (
            fake_forwarder_upstream(
                status=500,
                body=b'{"error":"upstream"}',
                headers=[("Content-Type", "application/json")],
            ),
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            result = await handle_firewall_request_without_upstream_admission(
                flow, allow, sandbox_info
            )

        assert result is auth.FirewallAuthHandlingResult.INLINE_PROVIDER_RESPONSE
        assert flow.response is not None
        assert flow.response.status_code == 500
        assert flow.response.content == b'{"error":"upstream"}'
        assert flow.metadata[metadata_keys.AUTH_URL_REWRITE] is True
        assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
        assert metadata_keys.FIREWALL_ERROR not in flow.metadata

    async def test_no_auth_url_rewrite_metadata_when_no_base(self, real_flow, mitm_ctx, tmp_path):
        """auth_url_rewrite metadata is absent when no URL rewrite happens."""
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
            "networkLogPath": str(tmp_path / "net.jsonl"),
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
        assert metadata_keys.AUTH_URL_REWRITE not in flow.metadata
        # Standard header injection happened
        assert flow.request.headers["Authorization"] == "Bearer real"
