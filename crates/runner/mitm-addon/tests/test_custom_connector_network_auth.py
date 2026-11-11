"""Exercise independent network admission through the public request hooks."""

import pytest
from mitmproxy import http

import flow_metadata_keys as metadata_keys
import mitm_addon
from tests.auth_endpoint_helpers import FakeAuthEndpoint, firewall_auth_success_response
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry
from tests.upstream_connection_helpers import mark_connected_tls_upstream

_CUSTOM_ID = "550e8400-e29b-41d4-a716-446655440000"
_CONFIG_ID = "550e8400-e29b-41d4-a716-446655440002"


def _network_response(secret: str, generation: int) -> dict:
    return firewall_auth_success_response({}) | {
        "networkAdmission": {
            "kind": "cloudflare_access",
            "configId": _CONFIG_ID,
            "generation": generation,
            "headers": {
                "CF-Access-Client-Id": "service-id",
                "CF-Access-Client-Secret": secret,
            },
        }
    }


@pytest.mark.parametrize("application_auth", [False, True])
@pytest.mark.parametrize("upstream_status", [200, 401, 403])
async def test_each_physical_request_admits_network_even_with_cached_or_no_app_auth(
    tmp_path, real_flow, mitm_ctx, application_auth, upstream_status
):
    sandbox = _single_firewall_sandbox(
        tmp_path,
        custom_connector_id=_CUSTOM_ID,
        firewall_name="custom_network",
        include_encrypted_secrets=application_auth,
        api_entry={
            "id": "custom_network:0",
            "base": "https://custom.example.test/api/",
            "auth": {"headers": {"Authorization": "Bearer ${{ secrets.APP }}"}}
            if application_auth
            else {},
            "networkIntent": {"kind": "cloudflare_access", "configId": _CONFIG_ID},
        },
        network_policy={"allow": [], "deny": [], "ask": [], "unknownPolicy": "allow"},
    )
    reg_path = _write_registry(tmp_path, sandbox_info=sandbox)
    endpoint = FakeAuthEndpoint()
    endpoint.queue_json_response(_network_response("first-pair", 1))
    if application_auth:
        endpoint.queue_json_response(
            firewall_auth_success_response({"Authorization": "Bearer app"})
        )
    endpoint.queue_json_response(_network_response("rotated-pair", 2))
    flows = [
        real_flow(
            with_response=False,
            client_ip="10.200.0.5",
            host="custom.example.test",
            path="/api/items",
        )
        for _ in range(2)
    ]
    for flow in flows:
        mark_connected_tls_upstream(
            flow,
            sni="custom.example.test",
            server_address=("8.8.8.8", 443),
            peername=("8.8.8.8", 443),
        )
    with endpoint.run(), mitm_ctx(registry_path=str(reg_path), api_url=endpoint.api_url):
        for index, flow in enumerate(flows):
            header_continuation = mitm_addon.requestheaders(flow)
            if header_continuation is not None:
                await header_continuation
            await mitm_addon.request(flow)
            assert flow.response is None
            if index == 0:
                flow.response = http.Response.make(upstream_status)
                continuation = mitm_addon.response(flow)
                if continuation is not None:
                    await continuation
    assert [flow.request.headers["CF-Access-Client-Secret"] for flow in flows] == [
        "first-pair",
        "rotated-pair",
    ]
    bodies = [request.json_body() for request in endpoint.requests]
    network = [body for body in bodies if body.get("networkAdmission")]
    assert len(network) == 2
    assert all("encryptedSecrets" not in body for body in network)
    assert all(body["authHeaders"] == {} for body in network)
    for body in network:
        request_target = body["networkRequest"]
        assert isinstance(request_target, dict)
        assert request_target["url"] == "https://custom.example.test/api/items"
    assert len(bodies) == (3 if application_auth else 2)
    if application_auth:
        assert flows[1].metadata[metadata_keys.AUTH_CACHE_HIT] is True
        assert all(flow.request.headers["Authorization"] == "Bearer app" for flow in flows)
    for flow in flows:
        if flow.response is None:
            flow.response = http.Response.make(200)
            continuation = mitm_addon.response(flow)
            if continuation is not None:
                await continuation
        assert metadata_keys.CUSTOM_NETWORK_ADMISSION not in flow.metadata
    serialized_logs = "".join(path.read_text() for path in tmp_path.glob("*.jsonl"))
    assert "first-pair" not in serialized_logs
    assert "rotated-pair" not in serialized_logs
    assert "service-id" not in serialized_logs


async def test_rejected_network_admission_stops_before_application_auth(
    tmp_path, real_flow, mitm_ctx
):
    sandbox = _single_firewall_sandbox(
        tmp_path,
        custom_connector_id=_CUSTOM_ID,
        firewall_name="custom_network",
        api_entry={
            "id": "custom_network:0",
            "base": "https://custom.example.test/api/",
            "auth": {"headers": {"Authorization": "Bearer ${{ secrets.APP }}"}},
            "networkIntent": {"kind": "cloudflare_access", "configId": _CONFIG_ID},
        },
        network_policy={"allow": [], "deny": [], "ask": [], "unknownPolicy": "allow"},
    )
    reg_path = _write_registry(tmp_path, sandbox_info=sandbox)
    endpoint = FakeAuthEndpoint()
    endpoint.queue_json_response(
        {"error": {"code": "FORBIDDEN", "message": "Network authority changed"}}, status=403
    )
    flow = real_flow(
        with_response=False, client_ip="10.200.0.5", host="custom.example.test", path="/api/items"
    )
    mark_connected_tls_upstream(
        flow, sni="custom.example.test", server_address=("8.8.8.8", 443), peername=("8.8.8.8", 443)
    )
    with endpoint.run(), mitm_ctx(registry_path=str(reg_path), api_url=endpoint.api_url):
        await mitm_addon.request(flow)
    assert flow.response is not None
    assert flow.response.status_code >= 400
    assert endpoint.request_count == 1
    assert "Authorization" not in flow.request.headers
    assert "CF-Access-Client-Secret" not in flow.request.headers


@pytest.mark.parametrize("peername", [("10.0.0.1", 443), None])
async def test_network_only_credentials_require_a_current_public_tls_peer(
    tmp_path, real_flow, mitm_ctx, peername
):
    sandbox = _single_firewall_sandbox(
        tmp_path,
        custom_connector_id=_CUSTOM_ID,
        firewall_name="custom_network",
        include_encrypted_secrets=False,
        api_entry={
            "id": "custom_network:0",
            "base": "https://custom.example.test/api/",
            "auth": {},
            "hostPolicy": {"kind": "publicDestination"},
            "networkIntent": {"kind": "cloudflare_access", "configId": _CONFIG_ID},
        },
        network_policy={"allow": [], "deny": [], "ask": [], "unknownPolicy": "allow"},
    )
    reg_path = _write_registry(tmp_path, sandbox_info=sandbox)
    endpoint = FakeAuthEndpoint()
    endpoint.queue_json_response(_network_response("protected-pair", 1))
    flow = real_flow(
        with_response=False, client_ip="10.200.0.5", host="custom.example.test", path="/api/items"
    )
    mark_connected_tls_upstream(
        flow,
        sni="custom.example.test",
        server_address=("custom.example.test", 443),
        peername=peername,
    )
    with endpoint.run(), mitm_ctx(registry_path=str(reg_path), api_url=endpoint.api_url):
        await mitm_addon.request(flow)
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert "CF-Access-Client-Id" not in flow.request.headers
    assert "CF-Access-Client-Secret" not in flow.request.headers
    assert endpoint.request_count == 0
