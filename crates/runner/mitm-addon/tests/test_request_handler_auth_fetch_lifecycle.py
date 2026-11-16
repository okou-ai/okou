"""A completed auth fetch must not poison later requests after setup recovers."""

import asyncio
from contextlib import nullcontext

import pytest
from mitmproxy import http
from mitmproxy.utils import asyncio_utils

import mitm_addon
from tests.auth_endpoint_helpers import FakeAuthEndpoint, firewall_auth_success_response
from tests.request_handler_helpers import _write_github_firewall_registry
from tests.upstream_connection_helpers import mark_connected_tls_upstream


@pytest.mark.parametrize("eager", [False, True], ids=["default", "eager"])
async def test_request_recovers_after_pre_io_auth_failure(
    tmp_path, real_flow, mitm_ctx, monkeypatch, eager: bool
):
    for name in (
        "http_proxy",
        "HTTP_PROXY",
        "https_proxy",
        "HTTPS_PROXY",
        "all_proxy",
        "ALL_PROXY",
        "no_proxy",
        "NO_PROXY",
    ):
        monkeypatch.delenv(name, raising=False)
    registry_path = _write_github_firewall_registry(tmp_path)
    endpoint = FakeAuthEndpoint()
    endpoint.queue_json_response(
        firewall_auth_success_response({"Authorization": "Bearer recovered-synthetic"})
    )

    def make_flow() -> http.HTTPFlow:
        flow = real_flow(
            with_response=False,
            client_ip="10.200.0.5",
            host="api.github.com",
            path="/repos/okou-ai/okou",
        )
        mark_connected_tls_upstream(
            flow,
            sni="api.github.com",
            server_address=("104.18.32.47", 443),
            peername=("104.18.32.47", 443),
        )
        return flow

    failed, recovered = make_flow(), make_flow()
    with (
        endpoint.run(),
        mitm_ctx(registry_path=str(registry_path), api_url=endpoint.api_url),
        asyncio_utils.set_eager_task_factory() if eager else nullcontext(),
    ):
        monkeypatch.setenv("http_proxy", "https://127.0.0.1:9")
        await mitm_addon.request(failed)
        assert failed.response is not None
        assert failed.response.status_code == 502
        assert failed.response.json()["error"] == "auth_failed"
        assert failed.request.headers.get("Authorization") is None

        checkpoint: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        asyncio.get_running_loop().call_soon(checkpoint.set_result, None)
        await checkpoint
        monkeypatch.delenv("http_proxy")
        await mitm_addon.request(recovered)

    assert recovered.response is None
    assert recovered.request.headers["Authorization"] == "Bearer recovered-synthetic"
    assert endpoint.request_count == 1
