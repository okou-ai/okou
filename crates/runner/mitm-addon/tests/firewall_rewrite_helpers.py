"""Shared helpers for auth.base rewrite handler tests."""

from urllib.parse import urlparse

import flow_metadata_keys as metadata_keys
from tests.firewall_auth_helpers import firewall_auth_response, make_allow


def _make_rewrite_inputs(
    real_flow,
    tmp_path,
    *,
    path="/hook",
    seed_url=None,
    resolved_base="https://discord.com/api/webhooks/123/abc",
    rel_path="/",
    method="GET",
    request_body=None,
    request_headers=None,
    api_base="https://firewall-placeholder.vm3.ai/discord-webhook/hook",
    auth_overrides=None,
    token_overrides=None,
    match_overrides=None,
):
    # ``seed_url`` lets callers specify a scheme://host/path?query to seed
    # the request without mutating read-only mitmproxy Request properties.
    if seed_url:
        parsed = urlparse(seed_url)
        host = parsed.hostname or "firewall-placeholder.vm3.ai"
        real_path = parsed.path or "/"
        if parsed.query:
            real_path = f"{real_path}?{parsed.query}"
        flow = real_flow(
            with_response=False,
            host=host,
            path=real_path,
            method=method,
            request_body=request_body,
            request_headers=request_headers,
        )
    else:
        flow = real_flow(
            with_response=False,
            host="firewall-placeholder.vm3.ai",
            path=path,
            method=method,
            request_body=request_body,
            request_headers=request_headers,
        )
    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "test-run"

    auth_config = {"headers": {}, "base": "${{ secrets.WEBHOOK }}"}
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
        "networkLogPath": str(tmp_path / "net.jsonl"),
        "billableFirewalls": [],
    }
    allow_kwargs = {
        "name": "test",
        "permission": "send",
        "rule": "POST /",
        "params": {},
        "rel_path": rel_path,
    }
    if match_overrides:
        allow_kwargs.update(match_overrides)
    allow = make_allow(api_entry, **allow_kwargs)
    token_meta = firewall_auth_response(
        headers={},
        base=resolved_base,
        resolved_secrets=["WEBHOOK"],
    )
    if token_overrides:
        token_meta.update(token_overrides)
    return flow, allow, sandbox_info, token_meta


def make_success_rewrite_inputs(
    real_flow,
    tmp_path,
    *,
    path="/hook",
    seed_url=None,
    resolved_base="https://discord.com/api/webhooks/123/abc",
    rel_path="/",
    api_base="https://firewall-placeholder.vm3.ai/discord-webhook/hook",
    auth_overrides=None,
    token_overrides=None,
    match_overrides=None,
):
    return _make_rewrite_inputs(
        real_flow,
        tmp_path,
        path=path,
        seed_url=seed_url,
        resolved_base=resolved_base,
        rel_path=rel_path,
        api_base=api_base,
        auth_overrides=auth_overrides,
        token_overrides=token_overrides,
        match_overrides=match_overrides,
    )


def make_forwarding_rewrite_inputs(
    real_flow,
    tmp_path,
    *,
    path="/hook",
    resolved_base="https://discord.com/api/webhooks/123/abc",
    rel_path="/",
    method="GET",
    request_body=None,
    request_headers=None,
    api_base="https://firewall-placeholder.vm3.ai/discord-webhook/hook",
    auth_overrides=None,
    token_overrides=None,
    match_overrides=None,
):
    return _make_rewrite_inputs(
        real_flow,
        tmp_path,
        path=path,
        resolved_base=resolved_base,
        rel_path=rel_path,
        method=method,
        request_body=request_body,
        request_headers=request_headers,
        api_base=api_base,
        auth_overrides=auth_overrides,
        token_overrides=token_overrides,
        match_overrides=match_overrides,
    )


def make_safety_rewrite_inputs(
    real_flow,
    tmp_path,
    *,
    path="/hook",
    resolved_base="https://discord.com/api/webhooks/123/abc",
    request_headers=None,
    auth_overrides=None,
    token_overrides=None,
):
    return _make_rewrite_inputs(
        real_flow,
        tmp_path,
        path=path,
        resolved_base=resolved_base,
        request_headers=request_headers,
        auth_overrides=auth_overrides,
        token_overrides=token_overrides,
    )
