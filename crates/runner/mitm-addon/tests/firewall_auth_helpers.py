"""Shared helpers for firewall auth tests."""

from collections.abc import Mapping

from mitmproxy import http

import auth
import firewall_auth_client as auth_client
import matching
from aws_sigv4 import AwsSigV4Credentials


def firewall_auth_request(
    auth_headers: Mapping[str, str] | None = None,
    host_authority: str = "tok-xyz",
    *,
    auth_base: str | None = None,
    auth_query: Mapping[str, str] | None = None,
    auth_aws_sigv4: Mapping[str, object] | None = None,
    secret_connector_map: Mapping[str, str] | None = None,
    secret_connector_metadata_map: Mapping[str, object] | None = None,
    vars_map: Mapping[str, str] | None = None,
    firewall_billable: bool = False,
) -> auth_client.FirewallAuthRequest:
    """Build a firewall auth request for cache and client integration tests."""
    return auth_client.FirewallAuthRequest(
        auth_headers=dict(auth_headers or {}),
        firewall_token=host_authority,
        auth_base=auth_base,
        auth_query=dict(auth_query) if auth_query is not None else None,
        auth_aws_sigv4=dict(auth_aws_sigv4) if auth_aws_sigv4 is not None else None,
        secret_connector_map=(
            dict(secret_connector_map) if secret_connector_map is not None else None
        ),
        secret_connector_metadata_map=(
            dict(secret_connector_metadata_map)
            if secret_connector_metadata_map is not None
            else None
        ),
        vars_map=dict(vars_map) if vars_map is not None else None,
        firewall_billable=firewall_billable,
    )


def firewall_auth_success(
    *,
    headers: Mapping[str, str],
    expires_at: int | float | None = None,
    resolved_secrets: list[str] | None = None,
    refreshed_connectors: list[str] | None = None,
    refreshed_secrets: list[str] | None = None,
    base: str | None = None,
    query: Mapping[str, str] | None = None,
    aws_sigv4: AwsSigV4Credentials | None = None,
) -> auth_client.FirewallAuthSuccess:
    """Build a validated firewall auth result for cache and handler tests."""
    return auth_client.FirewallAuthSuccess(
        payload=auth_client.FirewallAuthPayload(
            headers=dict(headers),
            resolved_secrets=list(resolved_secrets or []),
            base=base,
            query=dict(query) if query is not None else None,
            aws_sigv4=aws_sigv4,
        ),
        expires_at=expires_at,
        refreshed_connectors=list(refreshed_connectors or []),
        refreshed_secrets=list(refreshed_secrets or []),
    )


def firewall_auth_response(
    *,
    headers: Mapping[str, str] | None = None,
    resolved_secrets: list[str] | None = None,
    refreshed_connectors: list[str] | None = None,
    refreshed_secrets: list[str] | None = None,
    cache_hit: bool = False,
    cache_entry_identity: auth.FirewallAuthCacheEntryIdentity | None = None,
    base: str | None = None,
    query: Mapping[str, str] | None = None,
    aws_sigv4: AwsSigV4Credentials | None = None,
) -> dict:
    """Build a successful cache-to-handler response for ``get_firewall_headers``.

    Unlike ``firewall_auth_success``, this includes the cache-owned identity.
    Each call owns fresh containers and a fresh identity unless a caller passes
    the identity of the same cached entry. Malformed-response tests should
    explicitly corrupt the result instead of making this builder accept errors.
    """
    response: dict = {
        "headers": dict(headers or {}),
        "resolved_secrets": list(resolved_secrets or []),
        "refreshed_connectors": list(refreshed_connectors or []),
        "refreshed_secrets": list(refreshed_secrets or []),
        "cache_hit": cache_hit,
        "cache_entry_identity": (
            cache_entry_identity
            if cache_entry_identity is not None
            else auth.FirewallAuthCacheEntryIdentity()
        ),
    }
    if base is not None:
        response["base"] = base
    if query is not None:
        response["query"] = dict(query)
    if aws_sigv4 is not None:
        response["aws_sigv4"] = aws_sigv4
    return response


def _allow_current_firewall_authorization() -> bool:
    return True


async def handle_firewall_request_without_upstream_admission(
    flow: http.HTTPFlow,
    allow: matching.FirewallAllow,
    sandbox_info: dict,
) -> auth.FirewallAuthHandlingResult:
    """Exercise firewall auth independently of production upstream admission."""
    return await auth.handle_firewall_request(
        flow,
        allow,
        sandbox_info,
        revalidate_current_firewall_authorization=_allow_current_firewall_authorization,
    )


async def apply_requestheaders_auth_without_upstream_admission(
    flow: http.HTTPFlow,
    allow: matching.FirewallAllow,
    sandbox_info: dict,
) -> auth.FirewallHeaderPhaseAuthResult:
    """Exercise early firewall auth independently of production admission."""
    return await auth.try_apply_stream_safe_firewall_auth_for_requestheaders(
        flow,
        allow,
        sandbox_info,
        revalidate_current_firewall_authorization=_allow_current_firewall_authorization,
    )


def make_allow(
    api_entry: dict,
    *,
    name: str = "test",
    permission: str | None = "send",
    params: dict[str, str] | None = None,
    rule: str | None = "POST /",
    rel_path: str = "/",
) -> matching.FirewallAllow:
    return matching.FirewallAllow(api_entry, name, permission, params or {}, rule, rel_path)
