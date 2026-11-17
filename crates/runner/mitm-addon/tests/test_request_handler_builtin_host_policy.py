"""Built-in host policy request hook integration tests."""

import json
from collections.abc import Iterator

import pytest

import builtin_host_policy
import flow_metadata_keys as metadata_keys
import mitm_addon
import registry
import request_classification
import request_streaming
import upstream_destination_binding
from body_limits import STREAM_BUFFER_LIMIT
from tests.builtin_firewall_cache_helpers import serialize_builtin_firewall_catalog_cache
from tests.registry_helpers import write_trusted_catalog_cache_text
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry
from tests.requestheaders_helpers import (
    _assert_no_request_stream,
    await_requestheaders_result,
)


class _FailOnIterationList(list[str]):
    def __iter__(self) -> Iterator[str]:
        raise AssertionError("resolved host policy lists must not be reparsed during requests")


class _FailOnIterationDict(dict[str, object]):
    def __iter__(self) -> Iterator[str]:
        raise AssertionError("resolved host policy objects must not be reparsed during requests")


def _write_host_policy_registry(
    tmp_path,
    *,
    firewall_name: str,
    base: str,
    host_policy: dict[str, object],
    marked_builtin: bool = True,
    sandbox_fields: dict[str, object] | None = None,
):
    api_entry: dict[str, object] = {
        "base": base,
        "auth": {"headers": {"Authorization": "Bearer ${{ secrets.TEST_TOKEN }}"}},
        "hostPolicy": host_policy,
        "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
    }
    if marked_builtin:
        api_entry[builtin_host_policy.BUILTIN_HOST_POLICY_RUNTIME_MARKER] = True
    return _write_registry(
        tmp_path,
        client_ip="10.200.0.5",
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            firewall_name=firewall_name,
            api_entry=api_entry,
            network_policy={
                "allow": ["full-access"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
            sandbox_fields=sandbox_fields,
        ),
    )


def _write_resolved_host_policy_registry(
    tmp_path,
    *,
    firewall_name: str,
    base: str,
    host_policy: dict[str, object],
):
    registry_path = _write_registry(
        tmp_path,
        client_ip="10.200.0.5",
        sandbox_info={
            "runId": "run-resolved-host-policy",
            "billableFirewalls": [],
            "cliAgentType": "claude-code",
            "sandboxToken": "tok-resolved-host-policy",
            "encryptedSecrets": "iv:tag:data",
            "networkLogPath": str(tmp_path / "net.jsonl"),
            "proxyLogPath": str(tmp_path / "proxy.jsonl"),
            "firewalls": [{"kind": "builtin", "name": firewall_name}],
            "networkPolicies": {
                firewall_name: {
                    "allow": ["full-access"],
                    "deny": [],
                    "ask": [],
                    "unknownPolicy": "deny",
                }
            },
        },
    )
    write_trusted_catalog_cache_text(
        tmp_path / "builtin-firewall-catalog-cache.json",
        serialize_builtin_firewall_catalog_cache(
            digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            version="catalog-test",
            firewalls={
                firewall_name: {
                    "name": firewall_name,
                    "apis": [
                        {
                            "base": base,
                            "auth": {
                                "headers": {"Authorization": "Bearer ${{ secrets.TEST_TOKEN }}"}
                            },
                            "hostPolicy": host_policy,
                            "permissions": [
                                {
                                    "name": "full-access",
                                    "rules": ["ANY /{path+}"],
                                }
                            ],
                        }
                    ],
                },
            },
        ),
    )
    return registry_path


async def test_runtime_host_policy_blocks_public_destination_private_endpoint(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_host_policy_registry(
        tmp_path,
        firewall_name="strapi",
        base="https://strapi.example.com",
        host_policy={"kind": "publicDestination"},
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="10.0.0.5",
        sni="strapi.example.com",
        path="/api/articles",
        request_headers=headers(("Host", "strapi.example.com")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == "unsafe_public_destination"
    assert body["reason"] == "non_public_destination"
    assert body["destination_host"] == "10.0.0.5"
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "DENY"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "unsafe_public_destination"
    auth_fetch.assert_not_called()
    assert "Authorization" not in flow.request.headers


async def test_runtime_host_policy_allows_public_destination_public_endpoint(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_host_policy_registry(
        tmp_path,
        firewall_name="strapi",
        base="https://strapi.example.com",
        host_policy={"kind": "publicDestination"},
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="8.8.8.8",
        sni="strapi.example.com",
        path="/api/articles",
        request_headers=headers(("Host", "strapi.example.com")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.request.headers["Authorization"] == "Bearer x"
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    auth_fetch.assert_awaited_once()


async def test_runtime_host_policy_blocks_public_destination_hostname_without_ip_endpoint(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers
):
    reg_path = _write_host_policy_registry(
        tmp_path,
        firewall_name="strapi",
        base="https://strapi.example.com",
        host_policy={"kind": "publicDestination"},
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="strapi.example.com",
        path="/api/articles",
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == "unsafe_public_destination"
    assert body["reason"] == "invalid_destination"
    assert body["destination_host"] == "strapi.example.com"
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "DENY"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "unsafe_public_destination"
    auth_fetch.assert_not_called()
    assert "Authorization" not in flow.request.headers


async def test_runtime_host_policy_blocks_public_destination_private_request_host(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers
):
    reg_path = _write_host_policy_registry(
        tmp_path,
        firewall_name="strapi",
        base="https://10.0.0.5",
        host_policy={"kind": "publicDestination"},
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="10.0.0.5",
        path="/api/articles",
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == "unsafe_public_destination"
    assert body["reason"] == "non_public_destination"
    assert body["destination_host"] == "10.0.0.5"
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "DENY"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "unsafe_public_destination"
    auth_fetch.assert_not_called()
    assert "Authorization" not in flow.request.headers


async def test_runtime_host_policy_enforces_inline_public_destination_policy(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_host_policy_registry(
        tmp_path,
        firewall_name="strapi",
        base="https://strapi.example.com",
        host_policy={"kind": "publicDestination"},
        marked_builtin=False,
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="10.0.0.5",
        sni="strapi.example.com",
        path="/api/articles",
        request_headers=headers(("Host", "strapi.example.com")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == "unsafe_public_destination"
    assert body["reason"] == "non_public_destination"
    assert body["destination_host"] == "10.0.0.5"
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "DENY"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "unsafe_public_destination"
    auth_fetch.assert_not_called()
    assert "Authorization" not in flow.request.headers


async def test_runtime_host_policy_rejects_malformed_provider_policy(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_host_policy_registry(
        tmp_path,
        firewall_name="malformed-provider",
        base="https://api.com",
        host_policy={"kind": "providerOwned", "suffixes": ["com"]},
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.com",
        path="/v1/items",
        request_headers=headers(("Host", "api.com")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == "builtin_host_policy_denied"
    assert body["reason"] == "invalid_host_policy"
    auth_fetch.assert_not_called()
    assert "Authorization" not in flow.request.headers


@pytest.mark.parametrize(
    ("base", "host_header", "sni", "port", "expected_reason"),
    [
        (
            "https://attacker.example.com",
            "attacker.example.com",
            "attacker.example.com",
            443,
            "provider_host_not_allowed",
        ),
        (
            "https://acme.atlassian.net:8443",
            "acme.atlassian.net:8443",
            "acme.atlassian.net",
            8443,
            "provider_non_default_port",
        ),
    ],
)
async def test_runtime_host_policy_blocks_provider_owned_request_authority(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
    base,
    host_header,
    sni,
    port,
    expected_reason,
):
    reg_path = _write_host_policy_registry(
        tmp_path,
        firewall_name="jira",
        base=base,
        host_policy={"kind": "providerOwned", "suffixes": ["atlassian.net"]},
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        port=port,
        sni=sni,
        path="/rest/api/3/myself",
        request_headers=headers(("Host", host_header)),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == "builtin_host_policy_denied"
    assert body["reason"] == expected_reason
    auth_fetch.assert_not_called()
    assert "Authorization" not in flow.request.headers


async def test_runtime_host_policy_allows_provider_owned_request_authority(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_host_policy_registry(
        tmp_path,
        firewall_name="jira",
        base="https://acme.atlassian.net",
        host_policy={"kind": "providerOwned", "suffixes": ["atlassian.net"]},
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="acme.atlassian.net",
        path="/rest/api/3/myself",
        request_headers=headers(("Host", "acme.atlassian.net")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.request.headers["Authorization"] == "Bearer x"
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    auth_fetch.assert_awaited_once()


async def test_runtime_host_policy_blocks_requestheaders_credential_injection(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_host_policy_registry(
        tmp_path,
        firewall_name="jira",
        base="https://attacker.example.com",
        host_policy={"kind": "providerOwned", "suffixes": ["atlassian.net"]},
        sandbox_fields={"captureNetworkBodies": True},
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="attacker.example.com",
        method="POST",
        path="/rest/api/3/myself",
        request_headers=headers(
            ("Host", "attacker.example.com"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        await await_requestheaders_result(requestheaders_result)

        binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
        assert binding.host == "attacker.example.com"
        assert binding.kinds == frozenset(("connector_auth",))
        auth_fetch.assert_not_called()
        _assert_no_request_stream(flow)
        assert mitm_addon._FIREWALL_AUTH_APPLIED_IN_REQUESTHEADERS not in flow.metadata
        assert "Authorization" not in flow.request.headers
        assert flow.response is None

        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == "builtin_host_policy_denied"
    assert body["reason"] == "provider_host_not_allowed"
    auth_fetch.assert_not_called()
    assert "Authorization" not in flow.request.headers


async def test_runtime_host_policy_allows_requestheaders_credential_injection(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_host_policy_registry(
        tmp_path,
        firewall_name="jira",
        base="https://acme.atlassian.net",
        host_policy={"kind": "providerOwned", "suffixes": ["atlassian.net"]},
        sandbox_fields={"captureNetworkBodies": True},
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="acme.atlassian.net",
        method="POST",
        path="/rest/api/3/myself",
        request_headers=headers(
            ("Host", "acme.atlassian.net"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        await await_requestheaders_result(requestheaders_result)

        binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
        assert binding.host == "acme.atlassian.net"
        assert binding.kinds == frozenset(("connector_auth",))
        auth_fetch.assert_awaited_once()
        assert flow.request.headers["Authorization"] == "Bearer resolved"
        assert callable(flow.request.stream)
        assert request_streaming.captured_request_stream_body(flow) is not None
        assert flow.metadata[mitm_addon._FIREWALL_AUTH_APPLIED_IN_REQUESTHEADERS] is True
        assert request_classification.REQUEST_CLASSIFICATION_METADATA_KEY in flow.metadata

        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert request_classification.REQUEST_CLASSIFICATION_METADATA_KEY not in flow.metadata
    assert flow.metadata[metadata_keys.REQUEST_STREAM_COMPLETE] is True


async def test_resolved_host_policy_reuses_compiled_policy_across_requests(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_resolved_host_policy_registry(
        tmp_path,
        firewall_name="jira",
        base="https://acme.atlassian.net",
        host_policy={"kind": "providerOwned", "suffixes": ["atlassian.net"]},
    )
    flows = [
        real_flow(
            with_response=False,
            client_ip="10.200.0.5",
            host="203.0.113.10",
            sni="acme.atlassian.net",
            path=f"/rest/api/3/items/{index}",
            request_headers=headers(("Host", "acme.atlassian.net")),
        )
        for index in range(2)
    ]

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        context = registry.get_sandbox_context("10.200.0.5", str(reg_path))
        assert context is not None
        sandbox_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        api = sandbox_info["firewalls"][0]["apis"][0]
        assert isinstance(
            api[builtin_host_policy.BUILTIN_HOST_POLICY_RUNTIME_MARKER],
            builtin_host_policy.CompiledBuiltinHostPolicy,
        )
        raw_host_policy = api["hostPolicy"]
        assert isinstance(raw_host_policy, dict)
        assert raw_host_policy["suffixes"] == ["atlassian.net"]
        raw_host_policy["suffixes"] = _FailOnIterationList(["atlassian.net"])

        for flow in flows:
            await mitm_addon.request(flow)

    for flow in flows:
        assert flow.response is None
        assert flow.request.headers["Authorization"] == "Bearer x"
        assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert auth_fetch.await_count == 2


async def test_resolved_public_destination_host_policy_uses_compiled_policy(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_resolved_host_policy_registry(
        tmp_path,
        firewall_name="strapi",
        base="https://strapi.example.com",
        host_policy={"kind": "publicDestination"},
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="8.8.8.8",
        sni="strapi.example.com",
        path="/api/articles",
        request_headers=headers(("Host", "strapi.example.com")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        context = registry.get_sandbox_context("10.200.0.5", str(reg_path))
        assert context is not None
        sandbox_info, compiled_firewalls, _ = context
        assert compiled_firewalls is not None
        api = sandbox_info["firewalls"][0]["apis"][0]
        assert isinstance(
            api[builtin_host_policy.BUILTIN_HOST_POLICY_RUNTIME_MARKER],
            builtin_host_policy.CompiledBuiltinHostPolicy,
        )
        raw_host_policy = api["hostPolicy"]
        assert raw_host_policy == {"kind": "publicDestination"}
        api["hostPolicy"] = _FailOnIterationDict({"kind": "publicDestination"})

        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.request.headers["Authorization"] == "Bearer x"
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    auth_fetch.assert_awaited_once()


async def test_runtime_host_policy_rejects_invalid_runtime_marker(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_host_policy_registry(
        tmp_path,
        firewall_name="jira",
        base="https://acme.atlassian.net",
        host_policy={"kind": "providerOwned", "suffixes": ["atlassian.net"]},
    )
    registry_data = json.loads(reg_path.read_text())
    api = registry_data["sandboxes"]["10.200.0.5"]["firewalls"][0]["firewall"]["apis"][0]
    api[builtin_host_policy.BUILTIN_HOST_POLICY_RUNTIME_MARKER] = "invalid"
    reg_path.write_text(json.dumps(registry_data))
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="acme.atlassian.net",
        path="/rest/api/3/myself",
        request_headers=headers(("Host", "acme.atlassian.net")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == "builtin_host_policy_denied"
    assert body["reason"] == "invalid_host_policy"
    auth_fetch.assert_not_called()
    assert "Authorization" not in flow.request.headers
