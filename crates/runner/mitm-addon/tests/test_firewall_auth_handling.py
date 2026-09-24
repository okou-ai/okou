"""Direct firewall auth orchestration integration tests."""

import asyncio
import json
import os
import urllib.error
from collections.abc import Callable
from typing import Literal
from unittest.mock import AsyncMock, patch

import pytest
from mitmproxy import http

import auth
import auth_base_forwarder
import firewall_auth_cache as auth_cache
import firewall_auth_client as auth_client
import flow_metadata_keys as metadata_keys
import matching
import platform_api
from request_authority import get_trusted_authority
from tests.auth_endpoint_helpers import FakeAuthEndpoint, firewall_auth_success_response
from tests.auth_state_helpers import cached_headers
from tests.aws_sigv4_helpers import (
    DEFAULT_SIGV4_TIMESTAMP,
    RESOLVED_AWS_SESSION_TOKEN,
    STS_FORM_BODY,
    STS_HOST,
    aws_sigv4_authorization,
    resolved_aws_sigv4_credentials,
)
from tests.firewall_auth_helpers import (
    firewall_auth_response,
    firewall_auth_success,
    handle_firewall_request_without_upstream_admission,
)
from tests.firewall_helpers import cancel_pending_task
from tests.jsonl_log_helpers import read_jsonl_text_after_flush

_MALFORMED_SUCCESS_PREFIX = "Firewall auth endpoint returned malformed success response"
_MISSING_FIELD = object()
type HookPhase = Literal["request", "requestheaders"]


def _fail_if_current_firewall_authorization_is_revalidated() -> bool:
    raise AssertionError("current firewall authorization guard must not run")


def _allow_current_firewall_authorization() -> bool:
    return True


async def _run_firewall_auth_phase(
    hook_phase: HookPhase,
    flow: http.HTTPFlow,
    allow: matching.FirewallAllow,
    sandbox_info: dict,
    *,
    revalidate: Callable[[], bool] = _allow_current_firewall_authorization,
) -> auth.FirewallAuthHandlingResult | auth.FirewallHeaderPhaseAuthResult:
    if hook_phase == "request":
        return await auth.handle_firewall_request(
            flow,
            allow,
            sandbox_info,
            revalidate_current_firewall_authorization=revalidate,
        )
    return await auth.try_apply_stream_safe_firewall_auth_for_requestheaders(
        flow,
        allow,
        sandbox_info,
        revalidate_current_firewall_authorization=revalidate,
    )


def _allow(
    api_entry: dict,
    *,
    name: str = "github",
    permission: str | None = "repo-read",
    params: dict[str, str] | None = None,
    rule: str | None = "GET /repos/{owner}/{repo}",
    rel_path: str = "/",
) -> matching.FirewallAllow:
    return matching.FirewallAllow(api_entry, name, permission, dict(params or {}), rule, rel_path)


def _firewall_flow(
    real_flow,
    *,
    host: str = "api.github.com",
    path: str = "/repos",
    run_id: str = "test-run",
):
    flow = real_flow(with_response=False, host=host, path=path)
    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = run_id
    return flow


def _api_entry(
    *,
    base: str = "https://api.github.com",
    auth_config: dict | None = None,
    api_id: str | None = None,
) -> dict:
    auth_config_copy = _copy_auth_config(auth_config)
    entry = {
        "base": base,
        "auth": auth_config_copy,
    }
    if api_id is not None:
        entry["id"] = api_id
    return entry


def _copy_auth_config(auth_config: dict | None) -> dict:
    if auth_config is None:
        return {"headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"}}

    copied = dict(auth_config)
    for key in ("headers", "query"):
        value = copied.get(key)
        if isinstance(value, dict):
            copied[key] = dict(value)
    return copied


def _sandbox_info(
    tmp_path=None,
    *,
    run_id: str = "run-1",
    sandbox_marker: str = "tok-xyz",
    encrypted_secrets: str = "iv:tag:data",
    include_encrypted_secrets: bool = True,
    billable_firewalls: list[str] | None = None,
    network_log_path: str | None = None,
) -> dict:
    if network_log_path is None:
        if tmp_path is None:
            raise ValueError("tmp_path or network_log_path is required")
        network_log_path = str(tmp_path / "net.jsonl")

    sandbox_info: dict[str, object] = {
        "runId": run_id,
        "sandboxToken": sandbox_marker,
        "networkLogPath": network_log_path,
        "billableFirewalls": list(billable_firewalls or []),
    }
    if include_encrypted_secrets:
        sandbox_info["encryptedSecrets"] = encrypted_secrets
    return sandbox_info


class TestHandleFirewallRequest:
    async def test_success_injects_headers_and_audit_metadata(
        self, real_flow, headers, mitm_ctx, tmp_path
    ):
        flow = _firewall_flow(real_flow)
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH] = str(proxy_log_path)
        api_entry = _api_entry(
            api_id="run-1:0",
            auth_config={"headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"}},
        )
        sandbox_info = _sandbox_info(tmp_path)
        allow = _allow(api_entry, params={"owner": "octocat", "repo": "hello"})
        token_meta = firewall_auth_response(
            headers={"Authorization": "Bearer real-token", "X-Custom": "value"},
            resolved_secrets=["GITHUB_TOKEN"],
        )

        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            result = await handle_firewall_request_without_upstream_admission(
                flow, allow, sandbox_info
            )

        assert result is auth.FirewallAuthHandlingResult.CONTINUE_UPSTREAM

        # Headers injected
        assert flow.request.headers["Authorization"] == "Bearer real-token"
        assert flow.request.headers["X-Custom"] == "value"

        # Token replacement metadata
        assert flow.metadata[metadata_keys.AUTH_RESOLVED_SECRETS] == ["GITHUB_TOKEN"]
        assert flow.metadata[metadata_keys.AUTH_REFRESHED_CONNECTORS] == []
        assert flow.metadata[metadata_keys.AUTH_REFRESHED_SECRETS] == []
        assert flow.metadata[metadata_keys.AUTH_CACHE_HIT] is False

        # Core metadata
        assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
        assert flow.metadata[metadata_keys.FIREWALL_BASE] == "https://api.github.com"
        assert flow.metadata[metadata_keys.FIREWALL_API_ID] == "run-1:0"

        # Audit metadata
        assert flow.metadata[metadata_keys.FIREWALL_NAME] == "github"
        assert flow.metadata[metadata_keys.FIREWALL_PERMISSION] == "repo-read"
        assert flow.metadata[metadata_keys.FIREWALL_RULE_MATCH] == "GET /repos/{owner}/{repo}"
        assert flow.metadata[metadata_keys.FIREWALL_PARAMS] == {"owner": "octocat", "repo": "hello"}
        log_text = await asyncio.to_thread(read_jsonl_text_after_flush, proxy_log_path)
        assert "Firewall https://api.github.com: api.github.com" in log_text

    @pytest.mark.parametrize("hook_phase", ["request", "requestheaders"])
    async def test_empty_auth_config_preserves_existing_authorization(
        self,
        real_flow,
        mitm_ctx,
        tmp_path,
        hook_phase: HookPhase,
    ):
        flow = real_flow(
            with_response=False,
            host="api.cloudflare.com",
            path="/client/v4/pages/assets/upload",
            method="POST",
        )
        flow.request.headers["Authorization"] = "Bearer upload-jwt"
        flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "test-run"
        api_entry = _api_entry(
            base="https://api.cloudflare.com/client",
            auth_config={},
            api_id="run-1:1",
        )
        sandbox_info = _sandbox_info(tmp_path, include_encrypted_secrets=False)
        allow = _allow(
            api_entry,
            name="cloudflare",
            permission="page.write",
            rule="POST /v4/pages/assets/upload",
            rel_path="/v4/pages/assets/upload",
        )
        mock_get_firewall_headers = AsyncMock()

        with (
            patch.object(auth, "get_firewall_headers", mock_get_firewall_headers),
            mitm_ctx(),
        ):
            result = await _run_firewall_auth_phase(hook_phase, flow, allow, sandbox_info)

        expected_result = (
            auth.FirewallAuthHandlingResult.CONTINUE_UPSTREAM
            if hook_phase == "request"
            else auth.FirewallHeaderPhaseAuthResult.APPLIED
        )
        assert result is expected_result
        mock_get_firewall_headers.assert_not_called()
        assert flow.request.headers["Authorization"] == "Bearer upload-jwt"
        assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
        assert flow.metadata[metadata_keys.FIREWALL_NAME] == "cloudflare"
        assert flow.metadata[metadata_keys.FIREWALL_PERMISSION] == "page.write"
        assert flow.metadata[metadata_keys.AUTH_CACHE_HIT] is False

    @pytest.mark.parametrize("hook_phase", ["request", "requestheaders"])
    async def test_billable_only_auth_does_not_require_upstream_admission(
        self,
        real_flow,
        mitm_ctx,
        tmp_path,
        hook_phase: HookPhase,
    ):
        flow = _firewall_flow(real_flow)
        api_entry = _api_entry(auth_config={})
        sandbox_info = _sandbox_info(tmp_path, billable_firewalls=["github"])
        allow = _allow(api_entry)
        token_meta = firewall_auth_response(headers={})

        get_firewall_headers = AsyncMock(return_value=token_meta)

        with patch.object(auth, "get_firewall_headers", get_firewall_headers), mitm_ctx():
            result = await _run_firewall_auth_phase(
                hook_phase,
                flow,
                allow,
                sandbox_info,
                revalidate=_fail_if_current_firewall_authorization_is_revalidated,
            )

        expected_result = (
            auth.FirewallAuthHandlingResult.CONTINUE_UPSTREAM
            if hook_phase == "request"
            else auth.FirewallHeaderPhaseAuthResult.APPLIED
        )
        assert result is expected_result
        get_firewall_headers.assert_awaited_once()
        assert flow.response is None

    @pytest.mark.parametrize("hook_phase", ["request", "requestheaders"])
    @pytest.mark.parametrize(
        ("method", "scheme", "include_encrypted_secrets", "status", "error_code"),
        [
            pytest.param("TRACE", "https", True, 403, "unsafe_auth_method", id="unsafe-method"),
            pytest.param("GET", "http", True, 403, "insecure_transport", id="insecure-transport"),
            pytest.param("GET", "https", False, 502, "auth_unavailable", id="missing-secret"),
        ],
    )
    async def test_policy_failures_have_phase_specific_effects(
        self,
        real_flow,
        mitm_ctx,
        tmp_path,
        hook_phase: HookPhase,
        method: str,
        scheme: str,
        include_encrypted_secrets: bool,
        status: int,
        error_code: str,
    ):
        flow = real_flow(
            with_response=False,
            host="api.github.com",
            method=method,
            scheme=scheme,
        )
        flow.metadata.update(
            {
                metadata_keys.SANDBOX_RUN_ID: "test-run",
                "preexisting": "keep",
            }
        )
        original_metadata = dict(flow.metadata)
        original_url = flow.request.url
        original_headers = flow.request.headers.fields
        api_entry = _api_entry()
        sandbox_info = _sandbox_info(
            tmp_path,
            include_encrypted_secrets=include_encrypted_secrets,
        )
        allow = _allow(api_entry)
        get_firewall_headers = AsyncMock()

        with patch.object(auth, "get_firewall_headers", get_firewall_headers), mitm_ctx():
            result = await _run_firewall_auth_phase(
                hook_phase,
                flow,
                allow,
                sandbox_info,
                revalidate=_fail_if_current_firewall_authorization_is_revalidated,
            )

        get_firewall_headers.assert_not_called()
        if hook_phase == "requestheaders":
            assert result is auth.FirewallHeaderPhaseAuthResult.FALLBACK
            assert flow.response is None
            assert flow.metadata == original_metadata
            assert flow.request.url == original_url
            assert flow.request.headers.fields == original_headers
            return

        assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
        assert flow.response is not None
        assert flow.response.status_code == status
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == error_code

    async def test_auth_cache_identity_tracks_request_auth_inputs(
        self, real_flow, mitm_ctx, tmp_path
    ):
        """Same run/api entries must not share headers across auth input changes."""
        api_entry = _api_entry(
            api_id="run-1:0",
            auth_config={"headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"}},
        )
        allow = _allow(api_entry)
        first_flow = _firewall_flow(real_flow, run_id="run-1")
        second_flow = _firewall_flow(real_flow, run_id="run-1")
        first_sandbox_info = _sandbox_info(
            tmp_path, run_id="run-1", encrypted_secrets="encrypted-first"
        )
        second_sandbox_info = _sandbox_info(
            tmp_path, run_id="run-1", encrypted_secrets="encrypted-second"
        )
        mock_fetch = AsyncMock(
            side_effect=[
                firewall_auth_success(headers={"Authorization": "Bearer first"}),
                firewall_auth_success(headers={"Authorization": "Bearer second"}),
            ]
        )

        with patch.object(auth_cache, "fetch_firewall_headers", mock_fetch), mitm_ctx():
            first_result = await handle_firewall_request_without_upstream_admission(
                first_flow, allow, first_sandbox_info
            )
            second_result = await handle_firewall_request_without_upstream_admission(
                second_flow, allow, second_sandbox_info
            )

        assert first_result is auth.FirewallAuthHandlingResult.CONTINUE_UPSTREAM
        assert second_result is auth.FirewallAuthHandlingResult.CONTINUE_UPSTREAM
        assert first_flow.request.headers["Authorization"] == "Bearer first"
        assert second_flow.request.headers["Authorization"] == "Bearer second"
        assert mock_fetch.call_count == 2

        first_cache_key = first_flow.metadata[metadata_keys.FIREWALL_AUTH_CACHE_KEY]
        second_cache_key = second_flow.metadata[metadata_keys.FIREWALL_AUTH_CACHE_KEY]
        assert first_cache_key.run_id == "run-1"
        assert first_cache_key.api_id == "run-1:0"
        assert second_cache_key.run_id == "run-1"
        assert second_cache_key.api_id == "run-1:0"
        assert first_cache_key.auth_identity != second_cache_key.auth_identity

    @pytest.mark.parametrize(
        "changed_input",
        [
            "firewall-name",
            "firewall-base",
            "auth-headers",
            "auth-base",
            "auth-query",
            "auth-aws-sigv4",
            "encrypted-secrets",
            "secret-connector-map",
            "secret-connector-metadata-map",
            "vars",
            "billable",
            "sandbox-token",
        ],
    )
    async def test_auth_cache_identity_distinguishes_all_auth_inputs(
        self, real_flow, mitm_ctx, tmp_path, changed_input
    ):
        default_auth = {"headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"}}
        changed_auth = default_auth
        first_name = "github"
        second_name = first_name
        first_base = "https://api.github.com"
        second_base = first_base
        first_sandbox_info = _sandbox_info(tmp_path, run_id="run-1")
        second_sandbox_info = _sandbox_info(tmp_path, run_id="run-1")

        if changed_input == "firewall-name":
            second_name = "github-enterprise"
        elif changed_input == "firewall-base":
            second_base = "https://api.github.com/v1"
        elif changed_input == "auth-headers":
            changed_auth = {"headers": {"Authorization": "Bearer ${{ secrets.OTHER_TOKEN }}"}}
        elif changed_input == "auth-base":
            changed_auth = {
                **default_auth,
                "base": "${{ secrets.WEBHOOK_URL }}",
            }
        elif changed_input == "auth-query":
            changed_auth = {
                **default_auth,
                "query": {"api_key": "${{ secrets.QUERY_KEY }}"},
            }
        elif changed_input == "auth-aws-sigv4":
            changed_auth = {
                **default_auth,
                "awsSigv4": {
                    "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                    "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
                },
            }
        elif changed_input == "encrypted-secrets":
            second_sandbox_info["encryptedSecrets"] = "encrypted-updated"
        elif changed_input == "secret-connector-map":
            second_sandbox_info["secretConnectorMap"] = {"GITHUB_TOKEN": "github"}
        elif changed_input == "secret-connector-metadata-map":
            second_sandbox_info["secretConnectorMetadataMap"] = {"GITHUB_TOKEN": {"kind": "oauth"}}
        elif changed_input == "vars":
            second_sandbox_info["vars"] = {"TEAM": "vm0"}
        elif changed_input == "billable":
            second_sandbox_info["billableFirewalls"] = [second_name]
        elif changed_input == "sandbox-token":
            second_sandbox_info["sandboxToken"] = "sandbox-token-updated"
        else:
            raise AssertionError(f"Unhandled auth identity input: {changed_input}")

        first_api_entry = _api_entry(
            base=first_base,
            api_id="run-1:0",
            auth_config=default_auth,
        )
        second_api_entry = _api_entry(
            base=second_base,
            api_id="run-1:0",
            auth_config=changed_auth,
        )
        first_flow = _firewall_flow(real_flow, run_id="run-1")
        second_flow = _firewall_flow(real_flow, run_id="run-1")
        mock_get_firewall_headers = AsyncMock(return_value=firewall_auth_response())

        with (
            patch.object(auth, "get_firewall_headers", mock_get_firewall_headers),
            mitm_ctx(),
        ):
            await handle_firewall_request_without_upstream_admission(
                first_flow,
                _allow(first_api_entry, name=first_name),
                first_sandbox_info,
            )
            await handle_firewall_request_without_upstream_admission(
                second_flow,
                _allow(second_api_entry, name=second_name),
                second_sandbox_info,
            )

        assert mock_get_firewall_headers.await_count == 2
        first_cache_key = first_flow.metadata[metadata_keys.FIREWALL_AUTH_CACHE_KEY]
        second_cache_key = second_flow.metadata[metadata_keys.FIREWALL_AUTH_CACHE_KEY]
        assert first_cache_key.run_id == second_cache_key.run_id == "run-1"
        assert first_cache_key.api_id == second_cache_key.api_id == "run-1:0"
        assert first_cache_key.auth_identity != second_cache_key.auth_identity

    @pytest.mark.parametrize("hook_phase", ["request", "requestheaders"])
    async def test_standard_auth_filters_unsafe_resolved_headers(
        self,
        real_flow,
        headers,
        mitm_ctx,
        tmp_path,
        hook_phase: HookPhase,
    ):
        flow = _firewall_flow(
            real_flow,
            path="/repos?existing=1",
        )
        api_entry = _api_entry(
            auth_config={
                "headers": dict.fromkeys(
                    (
                        "Connection",
                        "Host",
                        "Content-Length",
                        "Transfer-Encoding",
                        "Keep-Alive",
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
                ),
                "query": {"api_key": "${{ secrets.API_KEY }}"},
            },
        )
        sandbox_info = _sandbox_info(tmp_path)
        allow = _allow(api_entry)
        token_meta = firewall_auth_response(
            headers={
                "Connection": "Authorization, X-Injected",
                "Host": "evil.example.com",
                "Content-Length": "999",
                "Transfer-Encoding": "chunked",
                "Keep-Alive": "timeout=5",
                "Proxy-Authenticate": "Basic realm=proxy",
                "Proxy-Authorization": "Basic secret",
                "Proxy-Connection": "keep-alive",
                "TE": "trailers",
                "Trailer": "X-Trailer",
                "Upgrade": "websocket",
                "Authorization": "Bearer real-token",
                "X-Injected": "trusted",
            },
        )
        token_meta["query"] = {"api_key": "secret"}

        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            result = await _run_firewall_auth_phase(hook_phase, flow, allow, sandbox_info)

        expected_result = (
            auth.FirewallAuthHandlingResult.CONTINUE_UPSTREAM
            if hook_phase == "request"
            else auth.FirewallHeaderPhaseAuthResult.APPLIED
        )
        assert result is expected_result
        header_names = {name.lower() for name, _value in flow.request.headers.items(multi=True)}
        assert flow.request.headers["Host"] == "api.github.com"
        assert "connection" not in header_names
        assert "content-length" not in header_names
        assert "transfer-encoding" not in header_names
        assert "keep-alive" not in header_names
        assert "proxy-authenticate" not in header_names
        assert "proxy-authorization" not in header_names
        assert "proxy-connection" not in header_names
        assert "te" not in header_names
        assert "trailer" not in header_names
        assert "upgrade" not in header_names
        assert "authorization" not in header_names
        assert "x-injected" not in header_names
        assert flow.request.query["existing"] == "1"
        assert flow.request.query["api_key"] == "secret"

    async def test_standard_auth_filters_unsafe_headers_before_aws_sigv4_signing(
        self, headers, real_flow, mitm_ctx, tmp_path
    ):
        placeholder_authorization = aws_sigv4_authorization(
            signed_headers="content-type;host;x-amz-date"
        )
        flow = real_flow(
            with_response=False,
            host=STS_HOST,
            path="/",
            method="POST",
            request_body=STS_FORM_BODY,
            request_headers=headers(
                ("Host", STS_HOST),
                ("Content-Type", "application/x-www-form-urlencoded"),
                ("X-Amz-Date", DEFAULT_SIGV4_TIMESTAMP),
                ("Authorization", placeholder_authorization),
            ),
        )
        flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "test-run"
        flow.metadata[metadata_keys.ORIGINAL_URL] = get_trusted_authority(flow).url
        api_entry = _api_entry(
            base="https://sts.amazonaws.com",
            auth_config={
                "headers": {"Host": "${{ secrets.UNSAFE_HOST }}"},
                "awsSigv4": {
                    "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                    "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
                    "sessionToken": "${{ secrets.AWS_SESSION_TOKEN }}",
                },
            },
        )
        sandbox_info = _sandbox_info(tmp_path)
        allow = _allow(api_entry, rule="POST /", rel_path="/")
        token_meta = firewall_auth_response(
            headers={
                "Host": "evil.example.com",
                "X-Amz-Meta-Test": "trusted-meta",
            },
        )
        token_meta["aws_sigv4"] = resolved_aws_sigv4_credentials()

        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            result = await handle_firewall_request_without_upstream_admission(
                flow, allow, sandbox_info
            )

        assert result is auth.FirewallAuthHandlingResult.CONTINUE_UPSTREAM
        assert flow.request.headers["host"] == STS_HOST
        assert flow.request.headers["x-amz-meta-test"] == "trusted-meta"
        assert flow.request.headers["x-amz-security-token"] == RESOLVED_AWS_SESSION_TOKEN
        assert (
            "Credential=AKIDEXAMPLE/20260101/us-east-1/sts/aws4_request"
            in flow.request.headers["authorization"]
        )
        assert "evil.example.com" not in flow.request.headers["authorization"]

    @pytest.mark.parametrize("hook_phase", ["request", "requestheaders"])
    async def test_stream_safe_aws_sigv4_applies_in_both_phases(
        self,
        headers,
        real_flow,
        mitm_ctx,
        tmp_path,
        hook_phase: HookPhase,
    ):
        flow = real_flow(
            with_response=False,
            host=STS_HOST,
            path="/",
            method="POST",
            request_headers=headers(
                ("Host", STS_HOST),
                ("X-Amz-Date", DEFAULT_SIGV4_TIMESTAMP),
                ("X-Amz-Content-Sha256", "UNSIGNED-PAYLOAD"),
                (
                    "Authorization",
                    aws_sigv4_authorization(signed_headers="host;x-amz-content-sha256;x-amz-date"),
                ),
            ),
        )
        flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "test-run"
        flow.metadata[metadata_keys.ORIGINAL_URL] = get_trusted_authority(flow).url
        api_entry = _api_entry(
            base="https://sts.amazonaws.com",
            auth_config={
                "awsSigv4": {
                    "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                    "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
                    "sessionToken": "${{ secrets.AWS_SESSION_TOKEN }}",
                }
            },
        )
        sandbox_info = _sandbox_info(tmp_path)
        allow = _allow(api_entry, rule="POST /", rel_path="/")
        token_meta = firewall_auth_response()
        token_meta["aws_sigv4"] = resolved_aws_sigv4_credentials()
        get_firewall_headers = AsyncMock(return_value=token_meta)

        with patch.object(auth, "get_firewall_headers", get_firewall_headers), mitm_ctx():
            result = await _run_firewall_auth_phase(hook_phase, flow, allow, sandbox_info)

        expected_result = (
            auth.FirewallAuthHandlingResult.CONTINUE_UPSTREAM
            if hook_phase == "request"
            else auth.FirewallHeaderPhaseAuthResult.APPLIED
        )
        assert result is expected_result
        get_firewall_headers.assert_awaited_once()
        assert flow.request.headers["x-amz-content-sha256"] == "UNSIGNED-PAYLOAD"
        assert flow.request.headers["x-amz-security-token"] == RESOLVED_AWS_SESSION_TOKEN
        assert "Credential=AKIDEXAMPLE/" in flow.request.headers["authorization"]

    async def test_requestheaders_auth_application_failure_restores_probe_state(
        self,
        real_flow,
        mitm_ctx,
        tmp_path,
    ):
        flow = _firewall_flow(real_flow, path="/repos?existing=1")
        flow.request.headers["X-Client"] = "original"
        flow.metadata["preexisting"] = "keep"
        original_metadata = dict(flow.metadata)
        original_url = flow.request.url
        original_headers = flow.request.headers.fields
        api_entry = _api_entry(
            auth_config={
                "headers": {"Authorization": "Bearer ${{ secrets.API_TOKEN }}"},
                "query": {"api_key": "${{ secrets.API_TOKEN }}"},
            },
        )
        sandbox_info = _sandbox_info(tmp_path)
        allow = _allow(api_entry)
        token_meta = firewall_auth_response(headers={"Authorization": "Bearer managed-token"})
        token_meta["query"] = {"api_key": "managed-query"}
        get_firewall_headers = AsyncMock(return_value=token_meta)
        revalidation_count = 0
        mutation_observed = False
        set_query = flow.request._set_query

        def revalidate() -> bool:
            nonlocal revalidation_count
            revalidation_count += 1
            return True

        def set_query_then_fail(query: list[tuple[str, str]]) -> None:
            nonlocal mutation_observed
            set_query(query)
            assert flow.request.headers["Authorization"] == "Bearer managed-token"
            assert flow.request.query["api_key"] == "managed-query"
            assert flow.request.url != original_url
            assert flow.metadata[metadata_keys.FIREWALL_BASE] == "https://api.github.com"
            mutation_observed = True
            raise RuntimeError("query setter failed after mutation")

        with (
            patch.object(auth, "get_firewall_headers", get_firewall_headers),
            patch.object(flow.request, "_set_query", set_query_then_fail),
            mitm_ctx(),
        ):
            result = await _run_firewall_auth_phase(
                "requestheaders",
                flow,
                allow,
                sandbox_info,
                revalidate=revalidate,
            )

        get_firewall_headers.assert_awaited_once()
        assert revalidation_count == 1
        assert mutation_observed is True
        assert result is auth.FirewallHeaderPhaseAuthResult.FALLBACK
        assert flow.metadata == original_metadata
        assert flow.request.url == original_url
        assert flow.request.headers.fields == original_headers
        assert "Authorization" not in flow.request.headers
        assert "api_key" not in flow.request.query
        assert metadata_keys.FIREWALL_AUTH_CACHE_KEY not in flow.metadata

    @pytest.mark.parametrize("hook_phase", ["request", "requestheaders"])
    async def test_unexpected_resolved_auth_base_fails_closed_in_both_phases(
        self,
        real_flow,
        mitm_ctx,
        tmp_path,
        hook_phase: HookPhase,
    ):
        flow = _firewall_flow(real_flow)
        flow.metadata["preexisting"] = "keep"
        original_metadata = dict(flow.metadata)
        original_url = flow.request.url
        original_headers = flow.request.headers.fields
        api_entry = _api_entry()
        sandbox_info = _sandbox_info(tmp_path)
        allow = _allow(api_entry)
        token_meta = firewall_auth_response(headers={"Authorization": "Bearer token"})
        token_meta["base"] = "https://unexpected.example.com"

        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            result = await _run_firewall_auth_phase(hook_phase, flow, allow, sandbox_info)

        if hook_phase == "requestheaders":
            assert result is auth.FirewallHeaderPhaseAuthResult.FALLBACK
            assert flow.response is None
            assert flow.metadata == original_metadata
            assert flow.request.url == original_url
            assert flow.request.headers.fields == original_headers
            return

        assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "auth_failed"
        assert "Authorization" not in flow.request.headers

    @pytest.mark.parametrize("hook_phase", ["request", "requestheaders"])
    @pytest.mark.parametrize(
        "cache_entry_identity",
        [pytest.param(None, id="missing"), pytest.param(object(), id="malformed")],
    )
    async def test_invalid_cache_entry_identity_fails_closed_in_both_phases(
        self,
        real_flow,
        mitm_ctx,
        tmp_path,
        hook_phase: HookPhase,
        cache_entry_identity: object | None,
    ):
        flow = _firewall_flow(real_flow)
        flow.metadata["preexisting"] = "keep"
        original_metadata = dict(flow.metadata)
        api_entry = _api_entry()
        sandbox_info = _sandbox_info(tmp_path)
        allow = _allow(api_entry)
        token_meta = firewall_auth_response(headers={"Authorization": "Bearer token"})
        if cache_entry_identity is None:
            token_meta.pop("cache_entry_identity")
        else:
            token_meta["cache_entry_identity"] = cache_entry_identity

        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            result = await _run_firewall_auth_phase(hook_phase, flow, allow, sandbox_info)

        if hook_phase == "requestheaders":
            assert result is auth.FirewallHeaderPhaseAuthResult.FALLBACK
            assert flow.response is None
            assert flow.metadata == original_metadata
            return

        assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "auth_failed"
        assert metadata_keys.FIREWALL_AUTH_CACHE_ENTRY_IDENTITY not in flow.metadata

    @pytest.mark.parametrize("hook_phase", ["request", "requestheaders"])
    async def test_missing_resolved_aws_sigv4_fails_closed_in_both_phases(
        self,
        headers,
        real_flow,
        mitm_ctx,
        tmp_path,
        hook_phase: HookPhase,
    ):
        flow = real_flow(
            with_response=False,
            host=STS_HOST,
            method="POST",
            request_headers=headers(
                ("Host", STS_HOST),
                ("X-Amz-Date", DEFAULT_SIGV4_TIMESTAMP),
                ("X-Amz-Content-Sha256", "UNSIGNED-PAYLOAD"),
                (
                    "Authorization",
                    aws_sigv4_authorization(signed_headers="host;x-amz-content-sha256;x-amz-date"),
                ),
            ),
        )
        flow.metadata.update(
            {
                metadata_keys.SANDBOX_RUN_ID: "test-run",
                metadata_keys.ORIGINAL_URL: get_trusted_authority(flow).url,
                "preexisting": "keep",
            }
        )
        original_metadata = dict(flow.metadata)
        original_url = flow.request.url
        original_headers = flow.request.headers.fields
        api_entry = _api_entry(
            base="https://sts.amazonaws.com",
            auth_config={
                "awsSigv4": {
                    "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                    "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
                }
            },
        )
        sandbox_info = _sandbox_info(tmp_path)
        allow = _allow(api_entry, rule="POST /", rel_path="/")
        token_meta = firewall_auth_response()

        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            result = await _run_firewall_auth_phase(hook_phase, flow, allow, sandbox_info)

        if hook_phase == "requestheaders":
            assert result is auth.FirewallHeaderPhaseAuthResult.FALLBACK
            assert flow.response is None
            assert flow.metadata == original_metadata
            assert flow.request.url == original_url
            assert flow.request.headers.fields == original_headers
            return

        assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "auth_failed"

    @pytest.mark.parametrize(
        "resolved_headers",
        [
            pytest.param({"": "value"}, id="empty-name"),
            pytest.param({"Bad\nName": "value"}, id="newline-name"),
            pytest.param({":authority": "evil.example.com"}, id="pseudo-header-name"),
            pytest.param({"X-Test": "bad\r\nX-Injected: value"}, id="newline-value"),
            pytest.param({"X-Test": "snowman ☃"}, id="non-latin-1-value"),
        ],
    )
    async def test_standard_auth_rejects_malformed_resolved_headers(
        self,
        resolved_headers: dict[str, str],
        real_flow,
        mitm_ctx,
        tmp_path,
    ):
        flow = _firewall_flow(real_flow, path="/repos?existing=1")
        api_entry = _api_entry(
            auth_config={
                "headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"},
                "query": {"api_key": "${{ secrets.GITHUB_TOKEN }}"},
            },
        )
        sandbox_info = _sandbox_info(tmp_path)
        allow = _allow(api_entry)
        token_meta = firewall_auth_response(
            headers={
                **resolved_headers,
                "Authorization": "Bearer real-token",
            },
        )
        token_meta["query"] = {"api_key": "secret"}

        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            result = await handle_firewall_request_without_upstream_admission(
                flow, allow, sandbox_info
            )

        assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "invalid_resolved_auth_header"
        assert "Authorization" not in flow.request.headers
        assert "api_key" not in flow.request.query
        assert flow.request.query["existing"] == "1"
        body = json.loads(flow.response.content)
        assert body["error"] == "invalid_resolved_auth_header"
        assert body["permission"] == "github"
        assert body["base"] == "https://api.github.com"

    async def test_empty_billable_firewalls_is_not_billable(
        self, real_flow, headers, mitm_ctx, tmp_path
    ):
        flow = _firewall_flow(real_flow)
        api_entry = _api_entry(api_id="run-1:0")
        sandbox_info = _sandbox_info(tmp_path)
        allow = _allow(api_entry, rule="GET /repos")
        token_meta = firewall_auth_response()

        with (
            patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
            mitm_ctx(),
        ):
            await handle_firewall_request_without_upstream_admission(flow, allow, sandbox_info)

        assert flow.metadata[metadata_keys.FIREWALL_BILLABLE] is False

    async def test_fetch_admission_saturation_returns_redacted_503(
        self, real_flow, mitm_ctx, tmp_path
    ):
        encrypted_secrets = "encrypted-sensitive-payload"
        sandbox_token = "sensitive-sandbox-token"
        flow = _firewall_flow(real_flow)
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH] = str(proxy_log_path)
        endpoint = FakeAuthEndpoint()
        api_entry = _api_entry()
        sandbox_info = _sandbox_info(
            tmp_path,
            encrypted_secrets=encrypted_secrets,
            sandbox_marker=sandbox_token,
        )
        allow = _allow(api_entry)

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(auth_cache, "MAX_ADMITTED_FIREWALL_AUTH_FETCHES", 0),
        ):
            result = await handle_firewall_request_without_upstream_admission(
                flow, allow, sandbox_info
            )

        assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
        assert endpoint.request_count == 0
        assert flow.response is not None
        assert flow.response.status_code == 503
        assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
        assert (
            flow.metadata[metadata_keys.FIREWALL_ERROR] == auth.FIREWALL_AUTH_FETCH_SATURATED_ERROR
        )
        assert flow.metadata[metadata_keys.SUPPRESS_REQUEST_BODY_CAPTURE] is True
        assert "Authorization" not in flow.request.headers
        body = json.loads(flow.response.content)
        assert body == {
            "error": "firewall_auth_fetch_saturated",
            "message": "Firewall auth is temporarily saturated",
            "permission": "github",
            "base": "https://api.github.com",
        }
        log_text = await asyncio.to_thread(read_jsonl_text_after_flush, proxy_log_path)
        assert "Firewall auth fetch admission saturated" in log_text
        assert encrypted_secrets not in log_text
        assert sandbox_token not in log_text

    async def test_failure_returns_502(self, real_flow, headers, mitm_ctx, tmp_path):
        flow = _firewall_flow(real_flow)
        api_entry = _api_entry()
        sandbox_info = _sandbox_info(tmp_path)
        allow = _allow(api_entry)

        with (
            patch.object(
                auth,
                "get_firewall_headers",
                AsyncMock(side_effect=Exception("API unreachable")),
            ),
            mitm_ctx(),
            patch.object(platform_api, "get_api_url", return_value="https://api.okou.ai"),
        ):
            result = await handle_firewall_request_without_upstream_admission(
                flow, allow, sandbox_info
            )

        assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "auth_failed"
        body = json.loads(flow.response.content)
        assert body["error"] == "auth_failed"
        assert "API unreachable" in body["message"]
        assert body["permission"] == "github"
        assert body["base"] == "https://api.github.com"
        assert "connectors" not in body

    @pytest.mark.parametrize(
        ("network_error", "expected_message"),
        [
            (
                urllib.error.URLError("connection refused"),
                "connection refused",
            ),
            (
                TimeoutError("timed out"),
                "timed out",
            ),
            (
                ConnectionResetError("connection reset"),
                "connection reset",
            ),
            (
                auth_client.FirewallAuthDeadlineExceededError(
                    auth_client.FirewallAuthFetchPhase.RESPONSE_HEADERS
                ),
                "Firewall auth fetch deadline exceeded during response_headers",
            ),
        ],
        ids=["url-error", "socket-timeout", "connection-reset", "deadline-phase"],
    )
    async def test_auth_endpoint_transport_failure_returns_502(
        self,
        network_error: Exception,
        expected_message: str,
        real_flow,
        mitm_ctx,
        tmp_path,
    ):
        flow = _firewall_flow(real_flow)
        api_entry = _api_entry()
        sandbox_info = _sandbox_info(tmp_path)
        allow = _allow(api_entry)

        class FailingResolver:
            async def lookup_ip(self, host: str) -> list[str]:
                assert host == "auth-endpoint.invalid"
                raise network_error

        proxy_environment = {
            "http_proxy": "",
            "HTTP_PROXY": "",
            "https_proxy": "",
            "HTTPS_PROXY": "",
            "all_proxy": "",
            "ALL_PROXY": "",
            "no_proxy": "",
            "NO_PROXY": "",
        }
        with (
            patch.dict(os.environ, proxy_environment),
            patch.object(auth_client, "_dns_resolver", FailingResolver()),
            mitm_ctx(api_url="http://auth-endpoint.invalid"),
        ):
            await handle_firewall_request_without_upstream_admission(flow, allow, sandbox_info)

        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "auth_failed"
        assert "Authorization" not in flow.request.headers
        body = json.loads(flow.response.content)
        assert body["error"] == "auth_failed"
        assert expected_message in body["message"]
        assert body["permission"] == "github"
        assert body["base"] == "https://api.github.com"
        assert "connectors" not in body

    async def test_malformed_success_response_returns_502_without_auth_mutation(
        self,
        real_flow,
        mitm_ctx,
        tmp_path,
    ):
        flow = _firewall_flow(real_flow, path="/repos?existing=1")
        api_entry = _api_entry(
            auth_config={
                "headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"},
                "query": {"api_key": "${{ secrets.GITHUB_TOKEN }}"},
            },
        )
        sandbox_info = _sandbox_info(tmp_path)
        allow = _allow(api_entry)
        endpoint = FakeAuthEndpoint()
        endpoint.queue_response(200, body=b"not-json")

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
        ):
            await handle_firewall_request_without_upstream_admission(flow, allow, sandbox_info)

        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "auth_failed"
        assert "Authorization" not in flow.request.headers
        assert "api_key" not in flow.request.query
        assert flow.request.query["existing"] == "1"
        assert cached_headers(flow.metadata[metadata_keys.FIREWALL_AUTH_CACHE_KEY]) is None
        body = json.loads(flow.response.content)
        assert body["error"] == "auth_failed"
        assert body["permission"] == "github"
        assert body["base"] == "https://api.github.com"
        assert "connectors" not in body

    @pytest.mark.parametrize(
        ("field_name", "invalid_value", "expected_reason"),
        [
            pytest.param(
                "expiresAt",
                _MISSING_FIELD,
                "expiresAt is required",
                id="expires-at-missing",
            ),
            pytest.param(
                "expiresAt",
                True,
                "expiresAt must be a finite number or null",
                id="expires-at-bool",
            ),
            pytest.param(
                "expiresAt",
                "123",
                "expiresAt must be a finite number or null",
                id="expires-at-string",
            ),
            pytest.param(
                "expiresAt",
                [],
                "expiresAt must be a finite number or null",
                id="expires-at-array",
            ),
            pytest.param(
                "expiresAt",
                float("nan"),
                "expiresAt must be a finite number or null",
                id="expires-at-nan",
            ),
            pytest.param(
                "expiresAt",
                float("inf"),
                "expiresAt must be a finite number or null",
                id="expires-at-positive-infinity",
            ),
            pytest.param(
                "expiresAt",
                float("-inf"),
                "expiresAt must be a finite number or null",
                id="expires-at-negative-infinity",
            ),
            pytest.param(
                "expiresAt",
                10**400,
                "expiresAt must be a finite number or null",
                id="expires-at-oversized-integer",
            ),
            pytest.param(
                "resolvedSecrets",
                _MISSING_FIELD,
                "resolvedSecrets is required",
                id="resolved-secrets-missing",
            ),
            pytest.param(
                "resolvedSecrets",
                None,
                "resolvedSecrets must be an array",
                id="resolved-secrets-null",
            ),
            pytest.param(
                "resolvedSecrets",
                "TOKEN",
                "resolvedSecrets must be an array",
                id="resolved-secrets-string",
            ),
            pytest.param(
                "resolvedSecrets",
                [123],
                "resolvedSecrets values must be strings",
                id="resolved-secrets-item-number",
            ),
            pytest.param(
                "refreshedConnectors",
                _MISSING_FIELD,
                "refreshedConnectors is required",
                id="refreshed-connectors-missing",
            ),
            pytest.param(
                "refreshedConnectors",
                None,
                "refreshedConnectors must be an array",
                id="refreshed-connectors-null",
            ),
            pytest.param(
                "refreshedConnectors",
                "github",
                "refreshedConnectors must be an array",
                id="refreshed-connectors-string",
            ),
            pytest.param(
                "refreshedConnectors",
                [123],
                "refreshedConnectors values must be strings",
                id="refreshed-connectors-item-number",
            ),
            pytest.param(
                "refreshedSecrets",
                _MISSING_FIELD,
                "refreshedSecrets is required",
                id="refreshed-secrets-missing",
            ),
            pytest.param(
                "refreshedSecrets",
                None,
                "refreshedSecrets must be an array",
                id="refreshed-secrets-null",
            ),
            pytest.param(
                "refreshedSecrets",
                "TOKEN",
                "refreshedSecrets must be an array",
                id="refreshed-secrets-string",
            ),
            pytest.param(
                "refreshedSecrets",
                [None],
                "refreshedSecrets values must be strings",
                id="refreshed-secrets-item-null",
            ),
        ],
    )
    async def test_invalid_required_success_metadata_is_not_cached_or_applied(
        self,
        field_name: str,
        invalid_value: object,
        expected_reason: str,
        real_flow,
        mitm_ctx,
        tmp_path,
    ):
        flow = _firewall_flow(real_flow, path="/repos?existing=1")
        api_entry = _api_entry(
            auth_config={
                "headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"},
                "query": {"api_key": "${{ secrets.GITHUB_TOKEN }}"},
            },
        )
        sandbox_info = _sandbox_info(tmp_path)
        allow = _allow(api_entry)
        response = firewall_auth_success_response(
            {"Authorization": "Bearer resolved"},
            resolved_secrets=["GITHUB_TOKEN"],
        )
        response["query"] = {"api_key": "resolved-key"}
        if invalid_value is _MISSING_FIELD:
            response.pop(field_name)
        else:
            response[field_name] = invalid_value
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response(response)

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
        ):
            result = await handle_firewall_request_without_upstream_admission(
                flow,
                allow,
                sandbox_info,
            )

        assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "auth_failed"
        assert "Authorization" not in flow.request.headers
        assert "api_key" not in flow.request.query
        assert flow.request.query["existing"] == "1"
        assert cached_headers(flow.metadata[metadata_keys.FIREWALL_AUTH_CACHE_KEY]) is None
        body = json.loads(flow.response.content)
        assert body["error"] == "auth_failed"
        assert body["message"] == (
            f"Failed to resolve auth headers: {_MALFORMED_SUCCESS_PREFIX}: {expected_reason}"
        )

    async def test_strategy_inconsistent_success_returns_502_without_auth_mutation(
        self,
        real_flow,
        mitm_ctx,
        tmp_path,
    ):
        flow = _firewall_flow(real_flow, path="/repos?existing=1")
        api_entry = _api_entry(
            auth_config={
                "headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"},
                "base": "${{ secrets.WEBHOOK_URL }}",
                "query": {"api_key": "${{ secrets.GITHUB_TOKEN }}"},
            },
        )
        sandbox_info = _sandbox_info(tmp_path)
        allow = _allow(api_entry)
        response = firewall_auth_success_response({"Authorization": "Bearer resolved"}) | {
            "query": {"api_key": "resolved-key"},
        }
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response(response)

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
        ):
            result = await handle_firewall_request_without_upstream_admission(
                flow, allow, sandbox_info
            )

        assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
        assert flow.response is not None
        assert flow.response.status_code == 502
        assert json.loads(flow.response.content)["error"] == "auth_failed"
        assert "Authorization" not in flow.request.headers
        assert "api_key" not in flow.request.query
        assert flow.request.query["existing"] == "1"
        assert cached_headers(flow.metadata[metadata_keys.FIREWALL_AUTH_CACHE_KEY]) is None
        assert metadata_keys.AUTH_URL_REWRITE not in flow.metadata

    async def test_oversized_success_response_returns_502_without_auth_mutation(
        self,
        real_flow,
        mitm_ctx,
        tmp_path,
    ):
        flow = _firewall_flow(real_flow, path="/repos?existing=1")
        api_entry = _api_entry(
            auth_config={
                "headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"},
                "query": {"api_key": "${{ secrets.GITHUB_TOKEN }}"},
            },
        )
        sandbox_info = _sandbox_info(tmp_path)
        allow = _allow(api_entry)
        response_body = json.dumps({"headers": {"Authorization": "Bearer tok"}}).encode()
        endpoint = FakeAuthEndpoint()
        endpoint.queue_response(200, body=response_body)

        with (
            endpoint.run(),
            patch.object(
                auth_client,
                "MAX_FIREWALL_AUTH_RESPONSE_BODY_BYTES",
                len(response_body) - 1,
            ),
            mitm_ctx(api_url=endpoint.api_url),
        ):
            await handle_firewall_request_without_upstream_admission(flow, allow, sandbox_info)

        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "auth_failed"
        assert "Authorization" not in flow.request.headers
        assert "api_key" not in flow.request.query
        assert flow.request.query["existing"] == "1"
        assert cached_headers(flow.metadata[metadata_keys.FIREWALL_AUTH_CACHE_KEY]) is None
        body = json.loads(flow.response.content)
        assert body["error"] == "auth_failed"
        assert "Firewall auth response body too large" in body["message"]
        assert body["permission"] == "github"
        assert body["base"] == "https://api.github.com"
        assert "connectors" not in body

    async def test_malformed_json_success_response_returns_502_without_auth_mutation(
        self,
        real_flow,
        mitm_ctx,
        tmp_path,
    ):
        flow = _firewall_flow(real_flow, path="/repos?existing=1")
        api_entry = _api_entry(
            auth_config={
                "headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"},
                "query": {"api_key": "${{ secrets.GITHUB_TOKEN }}"},
            },
        )
        sandbox_info = _sandbox_info(tmp_path)
        allow = _allow(api_entry)
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response({"headers": []})

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
        ):
            await handle_firewall_request_without_upstream_admission(flow, allow, sandbox_info)

        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "auth_failed"
        assert "Authorization" not in flow.request.headers
        assert "api_key" not in flow.request.query
        assert flow.request.query["existing"] == "1"
        assert cached_headers(flow.metadata[metadata_keys.FIREWALL_AUTH_CACHE_KEY]) is None
        body = json.loads(flow.response.content)
        assert body["error"] == "auth_failed"
        assert _MALFORMED_SUCCESS_PREFIX in body["message"]
        assert body["permission"] == "github"
        assert body["base"] == "https://api.github.com"
        assert "connectors" not in body

    async def test_structured_api_error_is_preserved(self, real_flow, mitm_ctx, tmp_path):
        flow = _firewall_flow(real_flow)
        api_entry = _api_entry()
        sandbox_info = _sandbox_info(tmp_path)
        allow = _allow(api_entry)
        api_error = auth_client.FirewallAuthApiError(
            status=502,
            code="TOKEN_REFRESH_FAILED",
            message="Access token expired and refresh failed for: codex-oauth-token.",
            connectors=["codex-oauth-token"],
            failure_reason="upstream_provider",
        )

        with (
            patch.object(
                auth,
                "get_firewall_headers",
                AsyncMock(side_effect=api_error),
            ),
            mitm_ctx(),
            patch.object(platform_api, "get_api_url", return_value="https://api.okou.ai"),
        ):
            result = await handle_firewall_request_without_upstream_admission(
                flow, allow, sandbox_info
            )

        assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "TOKEN_REFRESH_FAILED"
        body = json.loads(flow.response.content)
        assert body["error"] == "TOKEN_REFRESH_FAILED"
        assert body["message"] == "Access token expired and refresh failed for: codex-oauth-token."
        assert body["permission"] == "github"
        assert body["connectors"] == ["codex-oauth-token"]
        assert body["failureReason"] == "upstream_provider"

    async def test_structured_api_4xx_error_blocks_without_auth_mutation(
        self, real_flow, mitm_ctx, tmp_path
    ):
        flow = _firewall_flow(real_flow, path="/repos?existing=1")
        api_entry = _api_entry(
            auth_config={
                "headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"},
                "query": {"api_key": "${{ secrets.GITHUB_TOKEN }}"},
            },
        )
        sandbox_info = _sandbox_info(tmp_path)
        allow = _allow(api_entry)
        api_error = auth_client.FirewallAuthApiError(
            status=403,
            code="FORBIDDEN",
            message="Firewall auth denied",
        )

        with (
            patch.object(
                auth,
                "get_firewall_headers",
                AsyncMock(side_effect=api_error),
            ),
            mitm_ctx(),
        ):
            result = await handle_firewall_request_without_upstream_admission(
                flow, allow, sandbox_info
            )

        assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
        assert flow.response is not None
        assert flow.response.status_code == 403
        assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "FORBIDDEN"
        assert "Authorization" not in flow.request.headers
        assert "api_key" not in flow.request.query
        assert flow.request.query["existing"] == "1"
        body = json.loads(flow.response.content)
        assert body["error"] == "FORBIDDEN"
        assert body["message"] == "Firewall auth denied"
        assert body["permission"] == "github"
        assert body["base"] == "https://api.github.com"
        assert "connectors" not in body

    async def test_invalid_billable_auth_expiry_returns_502(self, real_flow, mitm_ctx, tmp_path):
        flow = _firewall_flow(real_flow)
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH] = str(proxy_log_path)
        api_entry = _api_entry()
        sandbox_info = _sandbox_info(tmp_path, billable_firewalls=["github"])
        allow = _allow(api_entry)

        with (
            patch.object(
                auth_cache,
                "fetch_firewall_headers",
                AsyncMock(
                    return_value=firewall_auth_success(
                        headers={"Authorization": "Bearer token"},
                        base="https://forward.example/secret",
                        query={"api_key": "secret"},
                        expires_at=None,
                    )
                ),
            ),
            mitm_ctx(),
        ):
            result = await handle_firewall_request_without_upstream_admission(
                flow, allow, sandbox_info
            )

        assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "invalid_auth_expiry"
        assert "Authorization" not in flow.request.headers
        assert metadata_keys.AUTH_URL_REWRITE not in flow.metadata
        assert "api_key" not in flow.request.query
        assert cached_headers(flow.metadata[metadata_keys.FIREWALL_AUTH_CACHE_KEY]) is None
        body = json.loads(flow.response.content)
        assert body["error"] == "invalid_auth_expiry"
        assert "valid cache expiry" in body["message"]
        assert body["permission"] == "github"
        assert body["base"] == "https://api.github.com"
        assert "connectors" not in body
        log_text = await asyncio.to_thread(read_jsonl_text_after_flush, proxy_log_path)
        assert "invalid expiresAt" in log_text

    async def test_no_response_set_on_success(self, real_flow, headers, mitm_ctx):
        """On success, flow.response should remain None (request continues to origin)."""
        flow = _firewall_flow(real_flow)
        api_entry = _api_entry()
        sandbox_info = _sandbox_info(network_log_path="")
        allow = _allow(api_entry)

        with (
            patch.object(
                auth,
                "get_firewall_headers",
                AsyncMock(
                    return_value=firewall_auth_response(
                        headers={"Auth": "tok"},
                    )
                ),
            ),
            mitm_ctx(),
        ):
            await handle_firewall_request_without_upstream_admission(flow, allow, sandbox_info)

        assert flow.response is None

    async def test_connector_not_configured_returns_424(
        self, real_flow, headers, mitm_ctx, tmp_path
    ):
        """When connector is enabled but not linked, return 424 with missing secrets."""
        flow = _firewall_flow(real_flow)
        api_entry = _api_entry()
        sandbox_info = _sandbox_info(tmp_path)
        allow = _allow(api_entry)

        with (
            patch.object(
                auth,
                "get_firewall_headers",
                AsyncMock(
                    side_effect=auth_client.ConnectorNotConfiguredError(
                        "Connector not configured",
                    )
                ),
            ),
            mitm_ctx(),
            patch.object(platform_api, "get_api_url", return_value="https://api.okou.ai"),
        ):
            result = await handle_firewall_request_without_upstream_admission(
                flow, allow, sandbox_info
            )

        assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
        assert flow.response is not None
        assert flow.response.status_code == 424
        assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "connector_not_configured"
        body = json.loads(flow.response.content)
        assert body["error"] == "connector_not_configured"
        assert body["message"] == "Connector not configured"
        assert body["connectors"] == ["github"]
        assert body["permission"] == "github"
        assert body["base"] == "https://api.github.com"

    async def test_insufficient_credits_returns_402(self, real_flow, headers, mitm_ctx, tmp_path):
        """Billable firewall auth denied for credits returns 402 and blocks usage."""
        flow = _firewall_flow(real_flow)
        api_entry = _api_entry()
        sandbox_info = _sandbox_info(tmp_path, billable_firewalls=["github"])
        allow = _allow(api_entry)

        with (
            patch.object(
                auth,
                "get_firewall_headers",
                AsyncMock(side_effect=auth_client.InsufficientCreditsError("Insufficient credits")),
            ),
            mitm_ctx(),
            patch.object(platform_api, "get_api_url", return_value="https://api.okou.ai"),
        ):
            result = await handle_firewall_request_without_upstream_admission(
                flow, allow, sandbox_info
            )

        assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
        assert flow.response is not None
        assert flow.response.status_code == 402
        assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "insufficient_credits"
        body = json.loads(flow.response.content)
        assert body["error"] == "insufficient_credits"
        assert body["message"] == "Insufficient credits"
        assert body["permission"] == "github"
        assert body["base"] == "https://api.github.com"
        assert "connectors" not in body

    async def test_connector_not_configured_without_name_omits_connectors(
        self, real_flow, headers, mitm_ctx, tmp_path
    ):
        """Connector slugs are only returned when the firewall name is known."""
        flow = _firewall_flow(real_flow)
        api_entry = _api_entry()
        sandbox_info = _sandbox_info(tmp_path)
        allow = _allow(api_entry, name="", permission=None, rule=None)

        with (
            patch.object(
                auth,
                "get_firewall_headers",
                AsyncMock(
                    side_effect=auth_client.ConnectorNotConfiguredError(
                        "Connector not configured",
                    )
                ),
            ),
            mitm_ctx(),
            patch.object(platform_api, "get_api_url", return_value="https://api.okou.ai"),
        ):
            await handle_firewall_request_without_upstream_admission(flow, allow, sandbox_info)

        assert flow.response is not None
        assert flow.response.status_code == 424
        assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "connector_not_configured"
        body = json.loads(flow.response.content)
        assert body["error"] == "connector_not_configured"
        assert body["message"] == "Connector not configured"
        assert body["permission"] == ""
        assert body["base"] == "https://api.github.com"
        assert "connectors" not in body

    async def test_missing_vars_only_returns_424(self, real_flow, headers, mitm_ctx, tmp_path):
        """When connector is not configured, return 424 with its slug."""
        flow = _firewall_flow(real_flow)
        api_entry = _api_entry(base="https://hcti.io")
        sandbox_info = _sandbox_info(tmp_path)
        allow = _allow(api_entry, name="htmlcsstoimage")

        with (
            patch.object(
                auth,
                "get_firewall_headers",
                AsyncMock(
                    side_effect=auth_client.ConnectorNotConfiguredError(
                        "Connector not configured",
                    )
                ),
            ),
            mitm_ctx(),
            patch.object(platform_api, "get_api_url", return_value="https://api.okou.ai"),
        ):
            await handle_firewall_request_without_upstream_admission(flow, allow, sandbox_info)

        assert flow.response is not None
        assert flow.response.status_code == 424
        body = json.loads(flow.response.content)
        assert body["error"] == "connector_not_configured"
        assert body["connectors"] == ["htmlcsstoimage"]
        assert body["base"] == "https://hcti.io"

    async def test_missing_encrypted_secrets_returns_502(self, real_flow, headers, mitm_ctx):
        """When encryptedSecrets is missing from sandbox_info, return 502."""
        flow = _firewall_flow(real_flow)
        api_entry = _api_entry(
            auth_config={"headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"}}
        )
        sandbox_info = _sandbox_info(network_log_path="", include_encrypted_secrets=False)
        allow = _allow(api_entry)
        admission = auth_base_forwarder.reserve_forward_request_admission(42)
        auth_base_forwarder.attach_forward_request_admission_to_flow(flow, admission)

        with mitm_ctx():
            result = await handle_firewall_request_without_upstream_admission(
                flow, allow, sandbox_info
            )

        assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "auth_unavailable"
        body = json.loads(flow.response.content)
        assert body["error"] == "auth_unavailable"
        assert body["message"] == "Auth secrets not configured"
        assert body["permission"] == "github"
        assert body["base"] == "https://api.github.com"
        assert "connectors" not in body
        assert metadata_keys.AUTH_BASE_FORWARD_ADMISSION not in flow.metadata
        assert auth_base_forwarder.forward_request_admission_state_for_tests() == (0, 0)

    async def test_cancelled_auth_resolution_releases_forward_admission(
        self, real_flow, mitm_ctx, tmp_path
    ):
        flow = _firewall_flow(real_flow)
        api_entry = _api_entry()
        sandbox_info = _sandbox_info(tmp_path)
        allow = _allow(api_entry)
        admission = auth_base_forwarder.reserve_forward_request_admission(42)
        auth_base_forwarder.attach_forward_request_admission_to_flow(flow, admission)
        auth_resolution_entered = asyncio.Event()
        release_auth_resolution = asyncio.Event()

        async def wait_for_auth_resolution(*_args, **_kwargs):
            auth_resolution_entered.set()
            await release_auth_resolution.wait()

        with (
            mitm_ctx(),
            patch.object(
                auth,
                "get_firewall_headers",
                AsyncMock(side_effect=wait_for_auth_resolution),
            ),
        ):
            task = asyncio.create_task(
                handle_firewall_request_without_upstream_admission(flow, allow, sandbox_info)
            )
            try:
                await asyncio.wait_for(auth_resolution_entered.wait(), timeout=1)
                task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    _ = await task
            finally:
                release_auth_resolution.set()
                await cancel_pending_task(task)

        assert metadata_keys.AUTH_BASE_FORWARD_ADMISSION not in flow.metadata
        assert auth_base_forwarder.forward_request_admission_state_for_tests() == (0, 0)
