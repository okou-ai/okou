"""Exercise independently cached network admission through the public request hooks."""

import asyncio
import threading
import time
from types import SimpleNamespace
from unittest.mock import patch

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
    return firewall_auth_success_response({}, expires_at=time.time() + 3600) | {
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


@pytest.mark.parametrize(
    ("application_auth", "upstream_status", "application_challenge"),
    [
        (application_auth, upstream_status, None)
        for application_auth in (False, True)
        for upstream_status in (200, 401, 403)
    ]
    + [
        (True, 401, "Bearer"),
        (True, 401, 'bEaReR\trealm="application"'),
        (True, 401, "Basic"),
        (True, 401, 'Basic realm="application"'),
        (True, 401, "Bearerish"),
        pytest.param(True, 401, 'Digest realm="gateway", Bearer', id="combined-bearer"),
        pytest.param(True, 401, 'Bearer, Basic realm="gateway"', id="bare-combined"),
        pytest.param(True, 401, 'Digest realm="quoted, Bearer"', id="quoted-bearer"),
        pytest.param(True, 401, r'Digest realm="escaped \", Bearer, inside"', id="escaped-quote"),
        pytest.param(True, 401, 'Digest realm="gateway", bearer = "value"', id="auth-param"),
    ],
)
async def test_network_cache_reuses_success_and_rechecks_rejection_without_refreshing_app_auth(
    tmp_path,
    real_flow,
    mitm_ctx,
    application_auth,
    upstream_status,
    application_challenge,
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
            "networkIntent": {"kind": "cloudflare_access", "configId": _CONFIG_ID, "generation": 1},
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
    if upstream_status in (401, 403):
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
                flow.response = http.Response.make(
                    upstream_status,
                    b'{"error":"invalid_grant"}',
                    headers={"WWW-Authenticate": application_challenge}
                    if application_challenge
                    else {},
                )
                continuation = mitm_addon.response(flow)
                if continuation is not None:
                    await continuation
                assert flow.response.status_code == upstream_status
                assert flow.response.content == b'{"error":"invalid_grant"}'
    assert [flow.request.headers["CF-Access-Client-Secret"] for flow in flows] == [
        "first-pair",
        "rotated-pair" if upstream_status in (401, 403) else "first-pair",
    ]
    bodies = [request.json_body() for request in endpoint.requests]
    network = [body for body in bodies if body.get("networkAdmission")]
    expected_network_queries = 2 if upstream_status in (401, 403) else 1
    assert len(network) == expected_network_queries
    assert all("encryptedSecrets" not in body for body in network)
    assert all(body["authHeaders"] == {} for body in network)
    for body in network:
        request_target = body["networkRequest"]
        assert isinstance(request_target, dict)
        assert request_target["url"] == "https://custom.example.test/api/items"
    assert len(bodies) == expected_network_queries + int(application_auth)
    assert all(not body.get("forceRefresh") for body in bodies)
    if application_auth:
        assert flows[1].metadata[metadata_keys.AUTH_CACHE_HIT] is True
        assert [flow.request.headers["Authorization"] for flow in flows] == [
            "Bearer app",
            "Bearer app",
        ]
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
            "networkIntent": {"kind": "cloudflare_access", "configId": _CONFIG_ID, "generation": 1},
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
            "networkIntent": {"kind": "cloudflare_access", "configId": _CONFIG_ID, "generation": 1},
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


def _cached_sandbox(
    tmp_path, *, generation=1, application_auth=False, direct=False, run_id="network-run"
):
    return _single_firewall_sandbox(
        tmp_path,
        run_id=run_id,
        custom_connector_id=_CUSTOM_ID,
        firewall_name="custom_network",
        include_encrypted_secrets=application_auth,
        api_entry={
            "id": "custom_network:0",
            "base": "https://custom.example.test/api/",
            "auth": {"headers": {"Authorization": "Bearer ${{ secrets.APP }}"}}
            if application_auth
            else {},
            "networkIntent": {"kind": "direct"}
            if direct
            else {
                "kind": "cloudflare_access",
                "configId": _CONFIG_ID,
                "generation": generation,
            },
        },
        network_policy={"allow": [], "deny": [], "ask": [], "unknownPolicy": "allow"},
    )


def _cached_flow(real_flow, path="/api/items"):
    flow = real_flow(
        with_response=False, client_ip="10.200.0.5", host="custom.example.test", path=path
    )
    mark_connected_tls_upstream(
        flow, sni="custom.example.test", server_address=("8.8.8.8", 443), peername=("8.8.8.8", 443)
    )
    return flow


async def _authenticate(flow):
    continuation = mitm_addon.requestheaders(flow)
    if continuation is not None:
        await continuation
    await mitm_addon.request(flow)


async def _complete(flow, status=200):
    flow.response = http.Response.make(status)
    continuation = mitm_addon.response(flow)
    if continuation is not None:
        await continuation


@pytest.mark.parametrize("direct", [False, True])
async def test_warm_network_lease_skips_api_across_allowed_urls_and_keeps_recipient_scope(
    tmp_path, real_flow, mitm_ctx, direct
):
    path = _write_registry(tmp_path, sandbox_info=_cached_sandbox(tmp_path, direct=direct))
    endpoint = FakeAuthEndpoint()
    response = (
        firewall_auth_success_response({}, expires_at=time.time() + 30)
        | {"networkAdmission": {"kind": "direct"}}
        if direct
        else _network_response("cached-pair", 1)
    )
    endpoint.queue_json_response(response)
    with endpoint.run(), mitm_ctx(registry_path=str(path), api_url=endpoint.api_url):
        for url in ["/api/items/one", "/api/items/two"]:
            flow = _cached_flow(real_flow, url)
            await _authenticate(flow)
            assert flow.response is None
            assert flow.request.headers.get("CF-Access-Client-Secret") == (
                None if direct else "cached-pair"
            )
            await _complete(flow)
        outside = _cached_flow(real_flow, "/outside/items")
        await _authenticate(outside)
        assert "CF-Access-Client-Secret" not in outside.request.headers
        await _complete(outside)
    assert endpoint.request_count == 1


@pytest.mark.parametrize("transition", ["rotate", "bind", "clear"])
async def test_registry_network_changes_invalidate_only_network_cache(
    tmp_path, real_flow, mitm_ctx, transition
):
    path = _write_registry(
        tmp_path,
        sandbox_info=_cached_sandbox(tmp_path, application_auth=True, direct=transition == "bind"),
    )
    endpoint = FakeAuthEndpoint()
    direct = firewall_auth_success_response({}, expires_at=time.time() + 30) | {
        "networkAdmission": {"kind": "direct"}
    }
    endpoint.queue_json_response(
        direct if transition == "bind" else _network_response("original-pair", 1)
    )
    endpoint.queue_json_response(firewall_auth_success_response({"Authorization": "Bearer app"}))
    endpoint.queue_json_response(
        direct if transition == "clear" else _network_response("new-pair", 2)
    )
    with endpoint.run(), mitm_ctx(registry_path=str(path), api_url=endpoint.api_url):
        first = _cached_flow(real_flow)
        await _authenticate(first)
        assert first.response is None
        assert first.request.headers.get("CF-Access-Client-Secret") == (
            None if transition == "bind" else "original-pair"
        )
        await _complete(first)
        _write_registry(
            tmp_path,
            sandbox_info=_cached_sandbox(
                tmp_path, generation=2, application_auth=True, direct=transition == "clear"
            ),
        )
        second = _cached_flow(real_flow)
        await _authenticate(second)
        assert second.response is None
        assert second.request.headers.get("CF-Access-Client-Secret") == (
            None if transition == "clear" else "new-pair"
        )
        assert second.request.headers["Authorization"] == "Bearer app"
        assert second.metadata[metadata_keys.AUTH_CACHE_HIT] is True
        await _complete(second)
    assert endpoint.request_count == 3
    assert [bool(x.json_body().get("networkAdmission")) for x in endpoint.requests] == [
        True,
        False,
        True,
    ]


async def test_monotonic_network_expiry_rechecks_without_notification_and_fails_closed(
    tmp_path, real_flow, mitm_ctx
):
    path = _write_registry(tmp_path, sandbox_info=_cached_sandbox(tmp_path))
    endpoint = FakeAuthEndpoint()
    endpoint.queue_json_response(_network_response("original-pair", 1))
    endpoint.queue_json_response(_network_response("rotated-pair", 2))
    endpoint.queue_json_response(
        {"error": {"code": "UNAVAILABLE", "message": "Unavailable"}}, status=503
    )
    clock = SimpleNamespace(wall=time.time(), monotonic=1000.0)
    cache_clock = SimpleNamespace(time=lambda: clock.wall, monotonic=lambda: clock.monotonic)
    with (
        endpoint.run(),
        mitm_ctx(registry_path=str(path), api_url=endpoint.api_url),
        patch("firewall_auth_cache.time", cache_clock),
    ):
        for index, expected in enumerate(["original-pair", "rotated-pair", None]):
            if index:
                # Wall time does not advance: the independent monotonic cap owns expiry.
                clock.monotonic += 31
            flow = _cached_flow(real_flow)
            await _authenticate(flow)
            if expected is None:
                assert flow.response is not None
                assert flow.response.status_code >= 400
                assert "CF-Access-Client-Secret" not in flow.request.headers
            else:
                assert flow.response is None
                assert flow.request.headers["CF-Access-Client-Secret"] == expected
            await _complete(flow)
    assert endpoint.request_count == 3


async def test_network_result_without_expiry_cannot_forward_credentials(
    tmp_path, real_flow, mitm_ctx
):
    path = _write_registry(tmp_path, sandbox_info=_cached_sandbox(tmp_path))
    endpoint = FakeAuthEndpoint()
    endpoint.queue_json_response(_network_response("unleased-pair", 1) | {"expiresAt": None})
    flow = _cached_flow(real_flow)
    with endpoint.run(), mitm_ctx(registry_path=str(path), api_url=endpoint.api_url):
        await _authenticate(flow)
        assert flow.response is not None
        assert flow.response.status_code >= 400
        assert "CF-Access-Client-Secret" not in flow.request.headers
        await _complete(flow)
    assert endpoint.request_count == 1


async def test_concurrent_network_miss_survives_cancelled_leader_and_coalesces(
    tmp_path, real_flow, mitm_ctx
):
    path = _write_registry(tmp_path, sandbox_info=_cached_sandbox(tmp_path))
    endpoint = FakeAuthEndpoint()
    release = threading.Event()
    endpoint.queue_json_response(_network_response("shared-pair", 1), release_event=release)
    flows = [_cached_flow(real_flow) for _ in range(3)]
    with endpoint.run(), mitm_ctx(registry_path=str(path), api_url=endpoint.api_url):
        tasks = [asyncio.create_task(_authenticate(flow)) for flow in flows]
        try:
            assert await asyncio.to_thread(endpoint.wait_for_request_count, 1)
            tasks[0].cancel()
            with pytest.raises(asyncio.CancelledError):
                await tasks[0]
            release.set()
            await asyncio.gather(*tasks[1:])
            for flow in flows[1:]:
                assert flow.response is None
                assert flow.request.headers["CF-Access-Client-Secret"] == "shared-pair"
                await _complete(flow)
        finally:
            release.set()
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
    assert endpoint.request_count == 1


async def test_late_rejection_cannot_invalidate_a_replaced_network_lease(
    tmp_path, real_flow, mitm_ctx
):
    path = _write_registry(tmp_path, sandbox_info=_cached_sandbox(tmp_path))
    endpoint = FakeAuthEndpoint()
    endpoint.queue_json_response(_network_response("old-pair", 1))
    endpoint.queue_json_response(_network_response("new-pair", 2))
    clock = SimpleNamespace(wall=time.time(), monotonic=1000.0)
    cache_clock = SimpleNamespace(time=lambda: clock.wall, monotonic=lambda: clock.monotonic)
    with (
        endpoint.run(),
        mitm_ctx(registry_path=str(path), api_url=endpoint.api_url),
        patch("firewall_auth_cache.time", cache_clock),
    ):
        old = _cached_flow(real_flow)
        await _authenticate(old)
        assert old.response is None
        clock.monotonic += 31
        current = _cached_flow(real_flow)
        await _authenticate(current)
        assert current.response is None
        assert current.request.headers["CF-Access-Client-Secret"] == "new-pair"
        await _complete(old, 401)
        later = _cached_flow(real_flow)
        await _authenticate(later)
        assert later.response is None
        assert later.request.headers["CF-Access-Client-Secret"] == "new-pair"
        await _complete(current)
        await _complete(later)
    assert endpoint.request_count == 2
