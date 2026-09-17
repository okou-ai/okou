"""Registry authorization revalidation across firewall-auth waits."""

import asyncio
import hashlib
import json
from pathlib import Path
from typing import Literal, cast
from unittest.mock import AsyncMock

import pytest
from mitmproxy import http, tls

import auth
import auth_base_forwarder
import connector_intent
import flow_metadata_keys as metadata_keys
import mitm_addon
import registry_control
import request_classification
import runner_control
from body_limits import STREAM_BUFFER_LIMIT
from tests.auth_base_forwarder_helpers import (
    fake_forwarder_upstream,
    forwarder_concurrency_harness,
)
from tests.control_helpers import exchange, registry_apply_request
from tests.firewall_auth_helpers import firewall_auth_response
from tests.firewall_helpers import cancel_pending_task
from tests.registry_builtin_helpers import write_registry_with_cache
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry
from tests.requestheaders_helpers import _assert_no_request_stream, await_requestheaders_result
from tests.upstream_connection_helpers import mark_connected_tls_upstream

type HookPhase = Literal["request", "requestheaders"]
type RegistryMutation = Literal["remove", "replace_run", "revoke_permission"]

_CLIENT_IP = "10.200.0.5"
_FIREWALL_NAME = "model-provider:test"
_ORIGINAL_RUN_ID = "run-before-auth-wait"
_RESOLVED_AUTHORIZATION = "Bearer resolved-for-old-authorization"
_RESOLVED_AUTH_BASE = "https://webhook.example.com/deliver"
_CUSTOM_CONNECTOR_ID = "550e8400-e29b-41d4-a716-446655440000"
_CANDIDATE_BUILTIN_NAME = "github"
_CANDIDATE_CUSTOM_NAME = "custom_connector_550e8400e29b41d4a716446655440000"


def _registry_sandbox(
    tmp_path: Path,
    *,
    run_id: str = _ORIGINAL_RUN_ID,
    allow_repos: bool = True,
    allow_unrelated_orgs: bool = False,
    auth_base: bool = False,
    enforce_public_destination: bool = False,
) -> dict[str, object]:
    allowed_permissions = ["repos-write"] if allow_repos else []
    denied_permissions = [] if allow_repos else ["repos-write"]
    if allow_unrelated_orgs:
        allowed_permissions.append("orgs-write")
    else:
        denied_permissions.append("orgs-write")
    auth_config: dict[str, object]
    api_base: str
    if auth_base:
        auth_config = {"base": "${{ secrets.WEBHOOK_URL }}"}
        api_base = "https://placeholder.example.com"
    else:
        auth_config = {
            "headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"},
            "query": {"managed": "${{ secrets.GITHUB_TOKEN }}"},
        }
        api_base = "https://api.github.com"
    api_entry: dict[str, object] = {
        "base": api_base,
        "auth": auth_config,
        "permissions": [
            {"name": "repos-write", "rules": ["POST /repos/{path+}"]},
            {"name": "orgs-write", "rules": ["POST /orgs/{path+}"]},
        ],
    }
    if enforce_public_destination:
        api_entry["hostPolicy"] = {"kind": "publicDestination"}

    return _single_firewall_sandbox(
        tmp_path,
        run_id=run_id,
        firewall_name=_FIREWALL_NAME,
        api_entry=api_entry,
        network_policy={
            "allow": allowed_permissions,
            "deny": denied_permissions,
            "ask": [],
            "unknownPolicy": "deny",
        },
        billable_firewalls=[_FIREWALL_NAME],
        sandbox_fields={"captureNetworkBodies": True, "modelUsageProvider": "test"},
    )


def _switchable_permission_sandbox(
    tmp_path: Path,
    *,
    allowed_permission: str,
) -> dict[str, object]:
    permissions = ("repos-primary", "repos-secondary")
    denied_permission = next(
        permission for permission in permissions if permission != allowed_permission
    )
    return _single_firewall_sandbox(
        tmp_path,
        run_id=_ORIGINAL_RUN_ID,
        firewall_name=_FIREWALL_NAME,
        api_entry={
            "base": "https://api.github.com",
            "auth": {
                "headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"},
                "query": {"managed": "${{ secrets.GITHUB_TOKEN }}"},
            },
            "permissions": [
                {"name": permission, "rules": ["POST /repos/{path+}"]} for permission in permissions
            ],
        },
        network_policy={
            "allow": [allowed_permission],
            "deny": [denied_permission],
            "ask": [],
            "unknownPolicy": "deny",
        },
        billable_firewalls=[_FIREWALL_NAME],
        sandbox_fields={"captureNetworkBodies": True, "modelUsageProvider": "test"},
    )


def _candidate_precedence_sandbox(tmp_path: Path, *, custom_available: bool) -> dict[str, object]:
    firewalls: list[dict[str, object]] = [{"kind": "builtin", "name": _CANDIDATE_BUILTIN_NAME}]
    network_policies: dict[str, dict[str, object]] = {
        _CANDIDATE_BUILTIN_NAME: {
            "allow": ["repos-write"],
            "deny": [],
            "ask": [],
            "unknownPolicy": "deny",
        }
    }
    sandbox: dict[str, object] = {
        "runId": _ORIGINAL_RUN_ID,
        "cliAgentType": "claude-code",
        "sandboxToken": "candidate-precedence-token",
        "networkLogPath": str(tmp_path / "net.jsonl"),
        "proxyLogPath": str(tmp_path / "proxy.jsonl"),
        "encryptedSecrets": "iv:tag:data",
        "connectorRuntimeTargets": [
            {"kind": "builtin", "connectorSlug": _CANDIDATE_BUILTIN_NAME},
            {"kind": "custom", "customConnectorId": _CUSTOM_CONNECTOR_ID},
        ],
        "connectorRoutingVariables": {f"custom:{_CUSTOM_CONNECTOR_ID}": {}},
        "firewalls": firewalls,
        "networkPolicies": network_policies,
        "billableFirewalls": [_CANDIDATE_BUILTIN_NAME],
    }
    if not custom_available:
        sandbox["omittedCustomConnectorIds"] = [_CUSTOM_CONNECTOR_ID]
        return sandbox

    firewalls.append(
        {
            "kind": "inline",
            "customConnectorId": _CUSTOM_CONNECTOR_ID,
            "firewall": {
                "name": _CANDIDATE_CUSTOM_NAME,
                "apis": [
                    {
                        "base": "https://api.github.com",
                        "auth": {
                            "headers": {"Authorization": "Bearer ${{ secrets.CUSTOM_TOKEN }}"}
                        },
                        "permissions": [
                            {
                                "name": "custom-repos-write",
                                "rules": ["POST /repos/{path+}"],
                            }
                        ],
                    }
                ],
            },
        }
    )
    network_policies[_CANDIDATE_CUSTOM_NAME] = {
        "allow": ["custom-repos-write"],
        "deny": [],
        "ask": [],
        "unknownPolicy": "deny",
    }
    return sandbox


def _candidate_builtin_firewall() -> dict[str, object]:
    return {
        "name": _CANDIDATE_BUILTIN_NAME,
        "apis": [
            {
                "base": "https://api.github.com",
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"}},
                "permissions": [{"name": "repos-write", "rules": ["POST /repos/{path+}"]}],
            }
        ],
    }


def _publish_registry(registry_path: Path, *, sandbox_info: dict[str, object] | None) -> None:
    """Publish a complete registry snapshot with the runner's atomic-replace shape."""
    next_path = registry_path.with_name("registry.next.json")
    sandboxes = {} if sandbox_info is None else {_CLIENT_IP: sandbox_info}
    next_path.write_text(json.dumps({"sandboxes": sandboxes}), encoding="utf-8")
    next_path.replace(registry_path)


def _mutate_registry(
    registry_path: Path,
    tmp_path: Path,
    mutation: RegistryMutation,
    *,
    auth_base: bool = False,
) -> None:
    if mutation == "remove":
        _publish_registry(registry_path, sandbox_info=None)
        return
    if mutation == "replace_run":
        _publish_registry(
            registry_path,
            sandbox_info=_registry_sandbox(
                tmp_path,
                run_id="run-replacement-after-auth-wait",
                auth_base=auth_base,
            ),
        )
        return
    _publish_registry(
        registry_path,
        sandbox_info=_registry_sandbox(tmp_path, allow_repos=False, auth_base=auth_base),
    )


def _firewall_flow(
    real_flow,
    make_tls_data,
    *,
    auth_base: bool = False,
    upstream_endpoint: tuple[str, int] = ("172.66.0.243", 443),
) -> tuple[http.HTTPFlow, tls.ClientHelloData]:
    host = "placeholder.example.com" if auth_base else "api.github.com"
    flow = real_flow(
        with_response=False,
        client_ip=_CLIENT_IP,
        host=host,
        sni=host,
        method="POST",
        path="/repos/octocat/hello?client=visible",
        request_headers=http.Headers(
            (
                (b"Host", host.encode()),
                (b"Content-Length", str(STREAM_BUFFER_LIMIT + 1).encode()),
            )
        ),
    )
    client_id = f"client-firewall-auth-revalidation-{'base' if auth_base else 'ordinary'}"
    flow.client_conn.id = client_id
    mark_connected_tls_upstream(
        flow,
        sni=host,
        server_address=upstream_endpoint,
        peername=upstream_endpoint,
    )
    tls_data = make_tls_data(
        client_ip=_CLIENT_IP,
        sni=host,
        client_id=client_id,
        server_address=upstream_endpoint,
        server_peername=upstream_endpoint,
        server_connected=True,
        server_id=flow.server_conn.id,
    )
    return flow, cast(tls.ClientHelloData, tls_data)


def _resolved_firewall_auth(*, auth_base: bool = False) -> dict[str, object]:
    if auth_base:
        return firewall_auth_response(
            headers={},
            base=_RESOLVED_AUTH_BASE,
            resolved_secrets=["WEBHOOK_URL"],
        )
    return firewall_auth_response(
        headers={"Authorization": _RESOLVED_AUTHORIZATION},
        query={"managed": "resolved-for-old-authorization"},
        resolved_secrets=["GITHUB_TOKEN"],
    )


def _assert_current_denial(flow: http.HTTPFlow, mutation: RegistryMutation) -> None:
    assert flow.response is not None
    assert flow.response.content is not None
    body = json.loads(flow.response.content)
    if mutation == "remove":
        assert flow.response.status_code == 503
        assert body["error"] == "stale_tls_admission"
        assert body["reason"] == "registry_entry_missing"
        assert metadata_keys.SANDBOX_RUN_ID not in flow.metadata
    elif mutation == "replace_run":
        assert flow.response.status_code == 503
        assert body["error"] == "stale_tls_admission"
        assert body["reason"] == "run_id_mismatch"
        assert metadata_keys.SANDBOX_RUN_ID not in flow.metadata
    else:
        assert flow.response.status_code == 403
        assert body["error"] == "permission_denied"
        assert body["reason"] == "permission_denied"
        assert body["permissions"] == ["repos-write"]
        assert flow.metadata[metadata_keys.SANDBOX_RUN_ID] == _ORIGINAL_RUN_ID

    assert flow.metadata.get(metadata_keys.FIREWALL_AUTH_CACHE_KEY) is None
    assert request_classification.REQUEST_CLASSIFICATION_METADATA_KEY not in flow.metadata
    assert "_usage_flow_tracked" not in flow.metadata


def _assert_auth_base_forward_rejected(
    flow: http.HTTPFlow,
    *,
    original_path: str,
    registry_mutation: RegistryMutation,
) -> None:
    assert flow.request.headers["Host"] == "placeholder.example.com"
    assert flow.request.headers.get("Authorization") is None
    assert flow.request.path == original_path
    for key in (
        metadata_keys.AUTH_RESOLVED_SECRETS,
        metadata_keys.AUTH_REFRESHED_CONNECTORS,
        metadata_keys.AUTH_REFRESHED_SECRETS,
        metadata_keys.AUTH_CACHE_HIT,
        metadata_keys.AUTH_URL_REWRITE,
    ):
        assert key not in flow.metadata
    assert auth_base_forwarder.forward_request_admission_state_for_tests() == (0, 0)
    _assert_current_denial(flow, registry_mutation)


@pytest.mark.parametrize("hook_phase", ["request", "requestheaders"])
@pytest.mark.parametrize("apply_via_control", [False, True])
@pytest.mark.parametrize(
    "registry_mutation",
    ["remove", "replace_run", "revoke_permission"],
)
async def test_registry_change_during_auth_blocks_old_authorization(
    tmp_path,
    real_flow,
    make_tls_data,
    mitm_ctx,
    monkeypatch,
    hook_phase: HookPhase,
    registry_mutation: RegistryMutation,
    apply_via_control: bool,
):
    registry_path = _write_registry(
        tmp_path,
        client_ip=_CLIENT_IP,
        sandbox_info=_registry_sandbox(tmp_path),
    )
    flow, tls_data = _firewall_flow(real_flow, make_tls_data)
    flow.metadata["preexisting"] = "keep"
    original_metadata = dict(flow.metadata)
    original_headers = flow.request.headers.fields
    original_path = flow.request.path
    auth_resolution_entered = asyncio.Event()
    release_auth_resolution = asyncio.Event()

    async def resolve_auth(*_args, **_kwargs):
        auth_resolution_entered.set()
        await release_auth_resolution.wait()
        return _resolved_firewall_auth()

    auth_fetch = AsyncMock(side_effect=resolve_auth)
    monkeypatch.setattr(auth, "get_firewall_headers", auth_fetch)

    hook_task: asyncio.Task[None] | None = None
    with mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"):
        mitm_addon.tls_clienthello(tls_data)
        if hook_phase == "request":
            hook_task = asyncio.create_task(mitm_addon.request(flow))
        else:
            hook_task = asyncio.create_task(
                await_requestheaders_result(mitm_addon.requestheaders(flow))
            )
        try:
            await asyncio.wait_for(auth_resolution_entered.wait(), timeout=1)
            _mutate_registry(registry_path, tmp_path, registry_mutation)
            if apply_via_control:
                owner = registry_control.RegistryControl(
                    asyncio.get_running_loop(), str(registry_path)
                )
                server = runner_control.ControlServer(tmp_path, "generation-1", owner)
                server.start()
                try:
                    digest = hashlib.sha256(registry_path.read_bytes()).hexdigest()
                    receipt = await asyncio.to_thread(
                        exchange, tmp_path, registry_apply_request(digest)
                    )
                    data = receipt["data"]
                    assert isinstance(data, dict)
                    assert data["state"] == "applied"
                finally:
                    owner.close()
                    server.stop()
            release_auth_resolution.set()
            await asyncio.gather(hook_task)
        finally:
            release_auth_resolution.set()
            await cancel_pending_task(hook_task)

        if hook_phase == "requestheaders":
            assert flow.response is None
            assert flow.error is None
            restored_metadata = {
                key: value
                for key, value in flow.metadata.items()
                if key not in connector_intent.REQUEST_HEADERS_PROBE_METADATA_KEYS
            }
            assert restored_metadata == original_metadata
            assert connector_intent.from_flow(flow) == connector_intent.ABSENT
            assert flow.request.headers.fields == original_headers
            assert flow.request.path == original_path
            assert mitm_addon._FIREWALL_AUTH_APPLIED_IN_REQUESTHEADERS not in flow.metadata
            _assert_no_request_stream(flow)

            await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    if hook_phase == "requestheaders":
        assert flow.request.headers.fields == original_headers
    else:
        assert flow.request.headers.get("Host") == "api.github.com"
        assert flow.request.headers.get("Content-Length") == str(STREAM_BUFFER_LIMIT + 1)
        assert flow.request.headers.get("Accept-Encoding") == "identity"
    assert flow.request.path == original_path
    assert flow.request.headers.get("Authorization") is None
    _assert_current_denial(flow, registry_mutation)


async def test_public_destination_policy_added_during_auth_blocks_private_destination(
    tmp_path,
    real_flow,
    make_tls_data,
    mitm_ctx,
    monkeypatch,
):
    registry_path = _write_registry(
        tmp_path,
        client_ip=_CLIENT_IP,
        sandbox_info=_registry_sandbox(tmp_path),
    )
    private_endpoint = ("10.0.0.1", 443)
    flow, tls_data = _firewall_flow(
        real_flow,
        make_tls_data,
        upstream_endpoint=private_endpoint,
    )
    original_path = flow.request.path
    auth_resolution_entered = asyncio.Event()
    release_auth_resolution = asyncio.Event()

    async def resolve_auth(*_args, **_kwargs):
        auth_resolution_entered.set()
        await release_auth_resolution.wait()
        return _resolved_firewall_auth()

    auth_fetch = AsyncMock(side_effect=resolve_auth)
    monkeypatch.setattr(auth, "get_firewall_headers", auth_fetch)

    request_task: asyncio.Task[None] | None = None
    with mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"):
        mitm_addon.tls_clienthello(tls_data)
        request_task = asyncio.create_task(mitm_addon.request(flow))
        try:
            await asyncio.wait_for(auth_resolution_entered.wait(), timeout=1)
            _publish_registry(
                registry_path,
                sandbox_info=_registry_sandbox(tmp_path, enforce_public_destination=True),
            )
            release_auth_resolution.set()
            await asyncio.gather(request_task)
        finally:
            release_auth_resolution.set()
            await cancel_pending_task(request_task)

    auth_fetch.assert_awaited_once()
    assert flow.request.headers.get("Host") == "api.github.com"
    assert flow.request.headers.get("Content-Length") == str(STREAM_BUFFER_LIMIT + 1)
    assert flow.request.headers.get("Accept-Encoding") == "identity"
    assert flow.request.path == original_path
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.response.content is not None
    assert json.loads(flow.response.content) == {
        "error": "unsafe_public_destination",
        "message": "Request blocked: publicDestination resolved to a non-public destination",
        "name": _FIREWALL_NAME,
        "base": "https://api.github.com",
        "destination_host": private_endpoint[0],
        "trusted_authority_host": "api.github.com",
        "reason": "non_public_destination",
    }
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "DENY"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "unsafe_public_destination"
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == "https://api.github.com"
    assert flow.metadata[metadata_keys.FIREWALL_NAME] == _FIREWALL_NAME
    assert flow.request.stream is False
    assert flow.request.headers.get("Authorization") is None
    assert flow.request.query.get("managed") is None
    assert flow.metadata.get(metadata_keys.FIREWALL_AUTH_CACHE_KEY) is None
    assert "_usage_flow_tracked" not in flow.metadata


@pytest.mark.parametrize("hook_phase", ["request", "requestheaders"])
async def test_unrelated_same_run_policy_change_keeps_equivalent_authorization(
    tmp_path,
    real_flow,
    make_tls_data,
    mitm_ctx,
    monkeypatch,
    hook_phase: HookPhase,
):
    registry_path = _write_registry(
        tmp_path,
        client_ip=_CLIENT_IP,
        sandbox_info=_registry_sandbox(tmp_path),
    )
    flow, tls_data = _firewall_flow(real_flow, make_tls_data)
    auth_resolution_entered = asyncio.Event()
    release_auth_resolution = asyncio.Event()

    async def resolve_auth(*_args, **_kwargs):
        auth_resolution_entered.set()
        await release_auth_resolution.wait()
        return _resolved_firewall_auth()

    auth_fetch = AsyncMock(side_effect=resolve_auth)
    monkeypatch.setattr(auth, "get_firewall_headers", auth_fetch)

    hook_task: asyncio.Task[None] | None = None
    with mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"):
        mitm_addon.tls_clienthello(tls_data)
        if hook_phase == "request":
            hook_task = asyncio.create_task(mitm_addon.request(flow))
        else:
            hook_task = asyncio.create_task(
                await_requestheaders_result(mitm_addon.requestheaders(flow))
            )
        try:
            await asyncio.wait_for(auth_resolution_entered.wait(), timeout=1)
            _publish_registry(
                registry_path,
                sandbox_info=_registry_sandbox(tmp_path, allow_unrelated_orgs=True),
            )
            release_auth_resolution.set()
            await asyncio.gather(hook_task)
        finally:
            release_auth_resolution.set()
            await cancel_pending_task(hook_task)

        if hook_phase == "requestheaders":
            await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert flow.request.headers["Authorization"] == _RESOLVED_AUTHORIZATION
    assert flow.request.query["managed"] == "resolved-for-old-authorization"
    assert flow.metadata[metadata_keys.SANDBOX_RUN_ID] == _ORIGINAL_RUN_ID
    assert (
        flow.metadata[metadata_keys.RESPONSE_ENCODING_NEGOTIATION] == "rewritten_stream_decodable"
    )


async def test_different_same_run_allow_decision_fails_closed_without_old_credentials(
    tmp_path,
    real_flow,
    make_tls_data,
    mitm_ctx,
    monkeypatch,
):
    registry_path = _write_registry(
        tmp_path,
        client_ip=_CLIENT_IP,
        sandbox_info=_switchable_permission_sandbox(tmp_path, allowed_permission="repos-primary"),
    )
    flow, tls_data = _firewall_flow(real_flow, make_tls_data)
    original_path = flow.request.path
    auth_resolution_entered = asyncio.Event()
    release_auth_resolution = asyncio.Event()

    async def resolve_auth(*_args, **_kwargs):
        auth_resolution_entered.set()
        await release_auth_resolution.wait()
        return _resolved_firewall_auth()

    auth_fetch = AsyncMock(side_effect=resolve_auth)
    monkeypatch.setattr(auth, "get_firewall_headers", auth_fetch)

    request_task: asyncio.Task[None] | None = None
    with mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"):
        mitm_addon.tls_clienthello(tls_data)
        request_task = asyncio.create_task(mitm_addon.request(flow))
        try:
            await asyncio.wait_for(auth_resolution_entered.wait(), timeout=1)
            _publish_registry(
                registry_path,
                sandbox_info=_switchable_permission_sandbox(
                    tmp_path,
                    allowed_permission="repos-secondary",
                ),
            )
            release_auth_resolution.set()
            await asyncio.gather(request_task)
        finally:
            release_auth_resolution.set()
            await cancel_pending_task(request_task)

    auth_fetch.assert_awaited_once()
    assert flow.request.headers.get("Host") == "api.github.com"
    assert flow.request.headers.get("Content-Length") == str(STREAM_BUFFER_LIMIT + 1)
    assert flow.request.headers.get("Accept-Encoding") == "identity"
    assert flow.request.path == original_path
    assert flow.response is not None
    assert flow.response.status_code == 409
    assert flow.response.content is not None
    assert json.loads(flow.response.content) == {
        "error": "firewall_authorization_changed",
        "message": (
            "Request blocked: firewall authorization changed while credentials were resolving"
        ),
    }
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "firewall_authorization_changed"
    assert flow.metadata.get(metadata_keys.FIREWALL_AUTH_CACHE_KEY) is None
    assert "_usage_flow_tracked" not in flow.metadata


async def test_custom_owner_change_during_auth_discards_builtin_credentials(
    tmp_path,
    real_flow,
    make_tls_data,
    mitm_ctx,
    monkeypatch,
):
    registry_path, cache_path = write_registry_with_cache(
        tmp_path,
        {_CLIENT_IP: _candidate_precedence_sandbox(tmp_path, custom_available=False)},
        {_CANDIDATE_BUILTIN_NAME: _candidate_builtin_firewall()},
    )
    flow, tls_data = _firewall_flow(real_flow, make_tls_data)
    auth_resolution_entered = asyncio.Event()
    release_auth_resolution = asyncio.Event()

    async def resolve_auth(*_args, **_kwargs):
        auth_resolution_entered.set()
        await release_auth_resolution.wait()
        return _resolved_firewall_auth()

    auth_fetch = AsyncMock(side_effect=resolve_auth)
    monkeypatch.setattr(auth, "get_firewall_headers", auth_fetch)

    request_task: asyncio.Task[None] | None = None
    with mitm_ctx(
        registry_path=str(registry_path),
        builtin_firewall_catalog_cache_path=str(cache_path),
        api_url="https://api.okou.ai",
    ):
        mitm_addon.tls_clienthello(tls_data)
        request_task = asyncio.create_task(mitm_addon.request(flow))
        try:
            await asyncio.wait_for(auth_resolution_entered.wait(), timeout=1)
            _publish_registry(
                registry_path,
                sandbox_info=_candidate_precedence_sandbox(tmp_path, custom_available=True),
            )
            release_auth_resolution.set()
            await asyncio.gather(request_task)
        finally:
            release_auth_resolution.set()
            await cancel_pending_task(request_task)

    auth_fetch.assert_awaited_once()
    assert flow.response is not None
    assert flow.response.status_code == 409
    assert flow.response.content is not None
    assert json.loads(flow.response.content)["error"] == "firewall_authorization_changed"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "firewall_authorization_changed"
    assert flow.request.headers.get("Authorization") is None
    assert flow.request.query.get("managed") is None
    assert flow.metadata.get(metadata_keys.FIREWALL_AUTH_CACHE_KEY) is None
    assert "_usage_flow_tracked" not in flow.metadata


@pytest.mark.parametrize(
    "registry_mutation",
    ["remove", "replace_run", "revoke_permission"],
)
async def test_auth_base_registry_change_during_auth_blocks_resolved_forward(
    tmp_path,
    real_flow,
    make_tls_data,
    mitm_ctx,
    monkeypatch,
    registry_mutation: RegistryMutation,
):
    registry_path = _write_registry(
        tmp_path,
        client_ip=_CLIENT_IP,
        sandbox_info=_registry_sandbox(tmp_path, auth_base=True),
    )
    flow, tls_data = _firewall_flow(real_flow, make_tls_data, auth_base=True)
    original_path = flow.request.path
    auth_resolution_entered = asyncio.Event()
    release_auth_resolution = asyncio.Event()

    async def resolve_auth(*_args, **_kwargs):
        auth_resolution_entered.set()
        await release_auth_resolution.wait()
        return _resolved_firewall_auth(auth_base=True)

    auth_fetch = AsyncMock(side_effect=resolve_auth)
    forward_request = AsyncMock()
    monkeypatch.setattr(auth, "get_firewall_headers", auth_fetch)
    monkeypatch.setattr(auth, "forward_request", forward_request)

    request_task: asyncio.Task[None] | None = None
    with mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"):
        mitm_addon.tls_clienthello(tls_data)
        assert mitm_addon.requestheaders(flow) is None
        assert auth_base_forwarder.forward_request_admission_state_for_tests() == (
            1,
            STREAM_BUFFER_LIMIT + 1,
        )

        request_task = asyncio.create_task(mitm_addon.request(flow))
        try:
            await asyncio.wait_for(auth_resolution_entered.wait(), timeout=1)
            assert flow.metadata["_usage_flow_tracked"] is True
            _mutate_registry(
                registry_path,
                tmp_path,
                registry_mutation,
                auth_base=True,
            )
            release_auth_resolution.set()
            await asyncio.gather(request_task)
        finally:
            release_auth_resolution.set()
            await cancel_pending_task(request_task)

    auth_fetch.assert_awaited_once()
    forward_request.assert_not_awaited()
    _assert_auth_base_forward_rejected(
        flow,
        original_path=original_path,
        registry_mutation=registry_mutation,
    )


@pytest.mark.parametrize(
    "registry_mutation",
    ["remove", "replace_run", "revoke_permission"],
)
async def test_auth_base_registry_change_while_waiting_for_active_slot_blocks_forward(
    tmp_path,
    real_flow,
    make_tls_data,
    mitm_ctx,
    monkeypatch,
    registry_mutation: RegistryMutation,
):
    registry_path = _write_registry(
        tmp_path,
        client_ip=_CLIENT_IP,
        sandbox_info=_registry_sandbox(tmp_path, auth_base=True),
    )
    flow, tls_data = _firewall_flow(real_flow, make_tls_data, auth_base=True)
    original_path = flow.request.path
    auth_resolution_entered = asyncio.Event()
    release_auth_resolution = asyncio.Event()

    async def resolve_auth(*_args, **_kwargs):
        auth_resolution_entered.set()
        await release_auth_resolution.wait()
        return _resolved_firewall_auth(auth_base=True)

    auth_fetch = AsyncMock(side_effect=resolve_auth)
    monkeypatch.setattr(auth, "get_firewall_headers", auth_fetch)

    request_task: asyncio.Task[None] | None = None
    monkeypatch.setattr(auth_base_forwarder, "MAX_CONCURRENT_AUTH_BASE_FORWARDS", 1)
    with mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"):
        async with forwarder_concurrency_harness() as (scenario, upstream):
            mitm_addon.tls_clienthello(tls_data)
            assert mitm_addon.requestheaders(flow) is None
            blocking_task = scenario.track_task(
                asyncio.create_task(
                    auth_base_forwarder.forward_request(
                        "https://occupied.example.com",
                        "GET",
                        [],
                        None,
                    )
                )
            )
            assert await scenario.wait_started(1)

            request_task = asyncio.create_task(mitm_addon.request(flow))
            try:
                await asyncio.wait_for(auth_resolution_entered.wait(), timeout=1)
                registry_mutated = asyncio.Event()

                def mutate_registry() -> None:
                    _mutate_registry(
                        registry_path,
                        tmp_path,
                        registry_mutation,
                        auth_base=True,
                    )
                    registry_mutated.set()

                release_auth_resolution.set()
                asyncio.get_running_loop().call_soon(mutate_registry)
                await asyncio.wait_for(registry_mutated.wait(), timeout=1)
                assert metadata_keys.AUTH_BASE_FORWARD_ADMISSION not in flow.metadata
                assert flow.metadata["_usage_flow_tracked"] is True
                scenario.release()
                await asyncio.gather(request_task, blocking_task)
            finally:
                release_auth_resolution.set()
                scenario.release()
                await cancel_pending_task(request_task)

            assert scenario.started == 1
            assert upstream.resolve_calls == ["occupied.example.com", "webhook.example.com"]

    auth_fetch.assert_awaited_once()
    _assert_auth_base_forward_rejected(
        flow,
        original_path=original_path,
        registry_mutation=registry_mutation,
    )


@pytest.mark.parametrize(
    "registry_mutation",
    ["remove", "replace_run", "revoke_permission"],
)
async def test_auth_base_registry_change_while_waiting_for_dns_blocks_forward(
    tmp_path,
    real_flow,
    make_tls_data,
    mitm_ctx,
    monkeypatch,
    registry_mutation: RegistryMutation,
):
    registry_path = _write_registry(
        tmp_path,
        client_ip=_CLIENT_IP,
        sandbox_info=_registry_sandbox(tmp_path, auth_base=True),
    )
    flow, tls_data = _firewall_flow(real_flow, make_tls_data, auth_base=True)
    original_path = flow.request.path
    auth_fetch = AsyncMock(return_value=_resolved_firewall_auth(auth_base=True))
    monkeypatch.setattr(auth, "get_firewall_headers", auth_fetch)
    dns_entered = asyncio.Event()
    release_dns = asyncio.Event()

    async def resolve_after_release(_host: str) -> list[str]:
        dns_entered.set()
        await release_dns.wait()
        return ["93.184.216.34"]

    request_task: asyncio.Task[None] | None = None
    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
        fake_forwarder_upstream(lookup_side_effect=resolve_after_release) as upstream,
    ):
        mitm_addon.tls_clienthello(tls_data)
        assert mitm_addon.requestheaders(flow) is None
        request_task = asyncio.create_task(mitm_addon.request(flow))
        try:
            await asyncio.wait_for(dns_entered.wait(), timeout=1)
            assert flow.metadata["_usage_flow_tracked"] is True
            _mutate_registry(
                registry_path,
                tmp_path,
                registry_mutation,
                auth_base=True,
            )
            release_dns.set()
            await asyncio.gather(request_task)
        finally:
            release_dns.set()
            await cancel_pending_task(request_task)

        assert upstream.resolve_calls == ["webhook.example.com"]
        assert upstream.socket_calls == []

    auth_fetch.assert_awaited_once()
    _assert_auth_base_forward_rejected(
        flow,
        original_path=original_path,
        registry_mutation=registry_mutation,
    )


async def test_auth_base_unrelated_policy_change_keeps_equivalent_authorization(
    tmp_path,
    real_flow,
    make_tls_data,
    mitm_ctx,
    monkeypatch,
):
    registry_path = _write_registry(
        tmp_path,
        client_ip=_CLIENT_IP,
        sandbox_info=_registry_sandbox(tmp_path, auth_base=True),
    )
    flow, tls_data = _firewall_flow(real_flow, make_tls_data, auth_base=True)
    auth_resolution_entered = asyncio.Event()
    release_auth_resolution = asyncio.Event()

    async def resolve_auth(*_args, **_kwargs):
        auth_resolution_entered.set()
        await release_auth_resolution.wait()
        return _resolved_firewall_auth(auth_base=True)

    auth_fetch = AsyncMock(side_effect=resolve_auth)
    monkeypatch.setattr(auth, "get_firewall_headers", auth_fetch)

    request_task: asyncio.Task[None] | None = None
    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
        fake_forwarder_upstream(status=202, body=b"accepted") as upstream,
    ):
        mitm_addon.tls_clienthello(tls_data)
        assert mitm_addon.requestheaders(flow) is None
        request_task = asyncio.create_task(mitm_addon.request(flow))
        try:
            await asyncio.wait_for(auth_resolution_entered.wait(), timeout=1)
            _publish_registry(
                registry_path,
                sandbox_info=_registry_sandbox(
                    tmp_path,
                    allow_unrelated_orgs=True,
                    auth_base=True,
                ),
            )
            release_auth_resolution.set()
            await asyncio.gather(request_task)
        finally:
            release_auth_resolution.set()
            await cancel_pending_task(request_task)

        assert flow.response is not None
        assert flow.response.status_code == 202
        assert flow.response.content == b"accepted"
        assert flow.metadata[metadata_keys.AUTH_URL_REWRITE] is True
        assert flow.metadata[metadata_keys.SANDBOX_RUN_ID] == _ORIGINAL_RUN_ID
        assert upstream.resolve_calls == ["webhook.example.com"]
        assert upstream.connect_calls == [("93.184.216.34", 443)]
        assert auth_base_forwarder.forward_request_admission_state_for_tests() == (0, 0)
        mitm_addon.response(flow)

    auth_fetch.assert_awaited_once()
    assert "_usage_flow_tracked" not in flow.metadata
