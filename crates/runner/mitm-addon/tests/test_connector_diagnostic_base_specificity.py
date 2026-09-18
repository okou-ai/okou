"""Base-specific connector diagnostics through the production addon hooks."""

import json

import pytest
from mitmproxy import http
from mitmproxy.test import tutils

import mitm_addon
from tests.connector_diagnostic_helpers import (
    _shared_base_catalog_firewall,
    write_connector_diagnostic_catalog_cache,
)
from tests.flow_helpers import header_map, response_stream
from tests.request_handler_helpers import (
    _sandbox_without_firewalls,
    _single_firewall_sandbox,
    _write_registry,
)
from tests.requestheaders_helpers import await_requestheaders_result


def _overlapping_catalog(*, broad_connectors=2, specific_rule="GET /items/{id}"):
    specific = _shared_base_catalog_firewall(
        "specific",
        "SPECIFIC_TOKEN",
        permissions=[{"name": "read", "rules": [specific_rule]}],
    )
    specific["apis"][0]["base"] = "https://shared.example.com/special"
    firewalls = {"specific": specific}
    if broad_connectors >= 1:
        firewalls["broad-a"] = _shared_base_catalog_firewall(
            "broad-a",
            "BROAD_A_TOKEN",
            permissions=[{"name": "read", "rules": ["GET /special/items/{id}"]}],
        )
    if broad_connectors >= 2:
        firewalls["broad-b"] = _shared_base_catalog_firewall(
            "broad-b",
            "BROAD_B_TOKEN",
            permissions=[{"name": "read", "rules": ["GET /elsewhere/{id}"]}],
        )
    return firewalls


def _complete_response(flow: http.HTTPFlow, *, upstream_status: int, streamed: bool) -> bytes:
    flow.response = tutils.tresp(
        status_code=upstream_status,
        headers=header_map({"content-type": "text/plain"}),
        content=b"upstream",
    )
    if streamed:
        mitm_addon.responseheaders(flow)
        stream = response_stream(flow)
        chunks: list[bytes] = []
        for chunk in (b"upstream", b""):
            result = stream(chunk)
            if isinstance(result, bytes):
                chunks.append(result)
            else:
                chunks.extend(result)
        content = b"".join(chunks)
        mitm_addon.response(flow)
    else:
        mitm_addon.response(flow)
        content = flow.response.content
        assert content is not None
    assert flow.response.status_code == upstream_status
    return content


@pytest.mark.parametrize(
    ("broad_connectors", "specific_rule"),
    [
        (0, "GET /items/{id}"),
        (1, "GET /items/{id}"),
        (2, "GET /items/{id}"),
        (2, "POST /other/{id}"),
    ],
)
@pytest.mark.parametrize("upstream_status", [401, 403])
@pytest.mark.parametrize("streamed", [False, True])
async def test_unique_specific_base_keeps_ownership_when_broader_siblings_are_added(
    tmp_path, real_flow, mitm_ctx, broad_connectors, specific_rule, upstream_status, streamed
):
    write_connector_diagnostic_catalog_cache(
        tmp_path,
        firewalls=_overlapping_catalog(
            broad_connectors=broad_connectors,
            specific_rule=specific_rule,
        ),
    )
    reg_path = _write_registry(tmp_path, sandbox_info=_sandbox_without_firewalls(tmp_path))
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="shared.example.com",
        path="/special/items/123",
        method="GET",
    )

    with mitm_ctx(registry_path=str(reg_path)):
        await mitm_addon.request(flow)
        assert flow.response is None
        content = _complete_response(flow, upstream_status=upstream_status, streamed=streamed)

    body = json.loads(content)
    assert body["connector"] == "specific"
    assert body["envNames"] == ["SPECIFIC_TOKEN"]
    assert body["base"] == "https://shared.example.com/special"
    assert body["upstreamStatus"] == upstream_status


@pytest.mark.parametrize(
    ("specific_rule", "sibling_rule", "expected_connector"),
    [
        ("GET /items/{id}", "GET /other/{id}", "specific"),
        ("GET /items/{id}", "GET /items/123", None),
        ("GET /other/{id}", "GET /elsewhere/{id}", None),
    ],
)
@pytest.mark.parametrize("upstream_status", [401, 403])
@pytest.mark.parametrize("streamed", [False, True])
async def test_shared_specific_base_resolves_only_its_own_route_owners(
    tmp_path,
    real_flow,
    mitm_ctx,
    specific_rule,
    sibling_rule,
    expected_connector,
    upstream_status,
    streamed,
):
    firewalls = _overlapping_catalog(specific_rule=specific_rule)
    sibling = _shared_base_catalog_firewall(
        "specific-sibling",
        "SIBLING_TOKEN",
        permissions=[{"name": "read", "rules": [sibling_rule]}],
    )
    sibling["apis"][0]["base"] = "https://shared.example.com/special"
    firewalls["specific-sibling"] = sibling
    # A winning connector may also own a broader API with a matching rule.
    firewalls["specific"]["apis"].append(firewalls["broad-a"]["apis"][0])
    write_connector_diagnostic_catalog_cache(tmp_path, firewalls=firewalls)
    reg_path = _write_registry(tmp_path, sandbox_info=_sandbox_without_firewalls(tmp_path))
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="shared.example.com",
        path="/special/items/123",
        method="GET",
    )

    with mitm_ctx(registry_path=str(reg_path)):
        await mitm_addon.request(flow)
        assert flow.response is None
        content = _complete_response(flow, upstream_status=upstream_status, streamed=streamed)

    assert flow.response is not None
    if expected_connector is None:
        assert content == b"upstream"
        assert flow.response.headers["content-type"] == "text/plain"
    else:
        body = json.loads(content)
        assert body["connector"] == expected_connector
        assert body["envNames"] == ["SPECIFIC_TOKEN"]
        assert body["base"] == "https://shared.example.com/special"
        assert body["upstreamStatus"] == upstream_status


@pytest.mark.parametrize("suppression", ["active-owner", "model-provider"])
@pytest.mark.parametrize("upstream_status", [401, 403])
@pytest.mark.parametrize("streamed", [False, True])
async def test_suppressed_specific_owner_does_not_fall_back_to_broader_connector(
    tmp_path, real_flow, mitm_ctx, suppression, upstream_status, streamed
):
    firewalls = _overlapping_catalog()
    sandbox_info = _sandbox_without_firewalls(tmp_path)
    if suppression == "active-owner":
        # Keep the catalog owner active while this URL takes ordinary Allow.
        sandbox_info = _single_firewall_sandbox(
            tmp_path,
            firewall_name="specific",
            api_entry={
                "base": "https://shared.example.com/runtime",
                "auth": {},
                "permissions": [{"name": "read", "rules": ["GET /{path+}"]}],
            },
            network_policy={"allow": ["read"], "deny": [], "ask": [], "unknownPolicy": "deny"},
        )
    else:
        provider = _shared_base_catalog_firewall(
            "model-provider:test",
            "PROVIDER_TOKEN",
            permissions=[{"name": "read", "rules": ["GET /items/{id}"]}],
        )
        provider["apis"][0]["base"] = "https://shared.example.com/special"
        firewalls["model-provider:test"] = provider
    write_connector_diagnostic_catalog_cache(tmp_path, firewalls=firewalls)
    reg_path = _write_registry(tmp_path, sandbox_info=sandbox_info)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="shared.example.com",
        path="/special/items/123",
        method="GET",
    )

    with mitm_ctx(registry_path=str(reg_path)):
        await mitm_addon.request(flow)
        assert flow.response is None
        content = _complete_response(flow, upstream_status=upstream_status, streamed=streamed)

    assert content == b"upstream"
    assert flow.response is not None
    assert flow.response.headers["content-type"] == "text/plain"


@pytest.mark.parametrize("requestheaders_first", [False, True])
@pytest.mark.parametrize("shared_specific_base", [False, True])
@pytest.mark.parametrize("include_intent", [False, True])
async def test_broader_shared_owners_cannot_interrupt_active_request_authentication(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    requestheaders_first,
    shared_specific_base,
    include_intent,
):
    firewalls = _overlapping_catalog()
    if shared_specific_base:
        sibling = _shared_base_catalog_firewall("specific-sibling", "SIBLING_TOKEN")
        sibling["apis"][0]["base"] = "https://shared.example.com/special"
        firewalls["specific-sibling"] = sibling
    write_connector_diagnostic_catalog_cache(tmp_path, firewalls=firewalls)
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            firewall_name="broad-b",
            api_entry=firewalls["broad-b"]["apis"][0],
            network_policy={"allow": ["read"], "deny": [], "ask": [], "unknownPolicy": "allow"},
            sandbox_fields={"captureNetworkBodies": True},
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="shared.example.com",
        path="/special/items/123",
        method="GET",
    )
    if include_intent:
        flow.request.headers["X-Okou-Connector-Intent"] = "broad-b"
    if requestheaders_first:
        flow.request.headers["Content-Length"] = str(mitm_addon.STREAM_BUFFER_LIMIT + 1)

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer active"}),
    ):
        if requestheaders_first:
            pending = mitm_addon.requestheaders(flow)
            await await_requestheaders_result(pending)
            assert flow.response is None
            assert callable(flow.request.stream)
            assert flow.request.headers["Authorization"] == "Bearer active"
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.request.headers["Authorization"] == "Bearer active"
    assert "X-Okou-Connector-Intent" not in flow.request.headers
