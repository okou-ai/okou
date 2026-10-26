"""Data Router billing identity through the production request and response hooks."""

import asyncio
import json
import time
import uuid
from pathlib import Path
from typing import Literal
from unittest.mock import AsyncMock, patch

import pytest
from hyperframe.frame import DataFrame
from mitmproxy import connection, http
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.proxy import commands, events
from mitmproxy.proxy.layers.http._hooks import HttpRequestHeadersHook, HttpRequestHook
from mitmproxy.test import taddons

import firewall_auth_cache
import firewall_auth_client
import flow_metadata_keys as metadata_keys
import mitm_addon
import public_destination_body_admission
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.mitmproxy_http_framing_helpers import start_http2_request, start_http_layer
from tests.pending_helpers import assert_pending
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry
from tests.upstream_connection_helpers import mark_connected_tls_upstream


def router_registry(tmp_path, *, owner="data-router", public_destination: bool = False):
    api_entry: dict[str, object] = {
        "base": "https://data.okou.ai/mcp",
        "auth": {"headers": {"Authorization": "Bearer ${{ secrets.OKOU_DATA_TOKEN }}"}},
        "permissions": [{"name": "call", "rules": ["ANY /{path*}"]}],
    }
    if public_destination:
        api_entry["hostPolicy"] = {"kind": "publicDestination"}
    return _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            run_id=str(uuid.uuid4()),
            firewall_name=owner,
            billable_firewalls=[owner],
            api_entry=api_entry,
            network_policy={"allow": ["call"], "deny": [], "ask": [], "unknownPolicy": "deny"},
        ),
    )


def router_flow(real_flow, *, method="tools/call", name="web_search"):
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="data.okou.ai",
        method="POST",
        path="/mcp",
    )
    flow.request.headers["X-Okou-Data-Request-Id"] = "sandbox-forged"
    flow.request.content = json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": method, "params": {"name": name, "arguments": {}}}
    ).encode()
    return flow


async def test_each_router_response_registers_its_own_id_after_upstream(
    tmp_path, real_flow, mitm_ctx
):
    path = router_registry(tmp_path)
    flows = [router_flow(real_flow), router_flow(real_flow)]
    ids = [str(uuid.uuid4()), str(uuid.uuid4())]
    registration = AsyncMock()
    with (
        mitm_ctx(registry_path=str(path), api_url="https://api.okou.ai"),
        patch.object(
            firewall_auth_cache,
            "fetch_firewall_headers",
            AsyncMock(
                return_value=firewall_auth_client.FirewallAuthSuccess(
                    payload=firewall_auth_client.FirewallAuthPayload(
                        headers={"Authorization": "Bearer service-token"}
                    ),
                    expires_at=time.time() + 3600,
                )
            ),
        ) as auth_fetch,
        patch.object(firewall_auth_client, "post_platform_json", registration),
    ):
        for flow, request_id in zip(flows, ids, strict=True):
            assert mitm_addon.requestheaders(flow) is None
            await mitm_addon.request(flow)
            assert flow.response is None
            assert flow.request.headers["Authorization"] == "Bearer service-token"
            assert "X-Okou-Data-Request-Id" not in flow.request.headers
            assert registration.await_count == flows.index(flow)
            flow.response = http.Response.make(
                200, b"unparsed vendor result", {"X-Okou-Data-Request-Id": request_id}
            )
            completion = mitm_addon.response(flow)
            assert completion is not None
            await completion
            assert flow.response.content == b"unparsed vendor result"
    assert auth_fetch.await_count == 1
    assert registration.await_count == 2
    for request_id, call in zip(ids, registration.await_args_list, strict=True):
        assert call.args[0] == "https://api.okou.ai/api/webhooks/agent/data-request"
        assert json.loads(call.args[1]) == {
            "runId": json.loads(path.read_text())["sandboxes"]["10.200.0.5"]["runId"],
            "requestId": request_id,
        }


@pytest.mark.parametrize("status", [200, 502])
async def test_response_completion_waits_for_registration_including_provider_errors(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, status
):
    path = router_registry(tmp_path)
    flow = router_flow(real_flow)
    started = asyncio.Event()
    released = asyncio.Event()

    async def register(*_args):
        started.set()
        await released.wait()

    with (
        mitm_ctx(registry_path=str(path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer service-token"}),
        patch.object(firewall_auth_client, "post_platform_json", register),
    ):
        await mitm_addon.request(flow)
        flow.response = http.Response.make(
            status, b"provider response", {"X-Okou-Data-Request-Id": str(uuid.uuid4())}
        )
        pending = mitm_addon.response(flow)
        assert pending is not None

        async def complete_response():
            await pending

        async with asyncio.TaskGroup() as group:
            completion = group.create_task(complete_response())
            try:
                await started.wait()
                assert not completion.done()
                assert_pending(tmp_path / "delivery-control", flows=1, buffered=0, reports=0)
            finally:
                released.set()
        assert_pending(tmp_path / "delivery-control", flows=0, buffered=0, reports=0)
        assert flow.response.status_code == status
        assert flow.response.content == b"provider response"


async def test_failed_response_registration_is_reported_without_replaying_upstream(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers
):
    path = router_registry(tmp_path)
    flow = router_flow(real_flow)
    registration = AsyncMock(side_effect=TimeoutError)
    with (
        mitm_ctx(registry_path=str(path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer service-token"}),
        patch.object(firewall_auth_client, "post_platform_json", registration),
    ):
        await mitm_addon.request(flow)
        registration.assert_not_awaited()
        flow.response = http.Response.make(
            200, b"already executed", {"X-Okou-Data-Request-Id": str(uuid.uuid4())}
        )
        pending = mitm_addon.response(flow)
        assert pending is not None
        with pytest.raises(TimeoutError):
            await pending
    registration.assert_awaited_once()
    assert flow.response.content == b"already executed"


@pytest.mark.parametrize(
    ("method", "name"),
    [("tools/list", ""), ("tools/call", "billing_get"), ("tools/call", "pricing_list")],
)
async def test_control_responses_without_identity_are_not_registered(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, method, name
):
    path = router_registry(tmp_path)
    flow = router_flow(real_flow, method=method, name=name)
    registration = AsyncMock()
    with (
        mitm_ctx(registry_path=str(path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer service-token"}),
        patch.object(firewall_auth_client, "post_platform_json", registration),
    ):
        await mitm_addon.request(flow)
        assert "X-Okou-Data-Request-Id" not in flow.request.headers
        flow.response = http.Response.make(200, b"control response")
        pending = mitm_addon.response(flow)
        assert pending is not None
        await pending
    registration.assert_not_awaited()


async def test_another_provider_cannot_register_a_router_response_id(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers
):
    path = router_registry(tmp_path, owner="github")
    flow = router_flow(real_flow)
    registration = AsyncMock()
    with (
        mitm_ctx(registry_path=str(path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer service-token"}),
        patch.object(firewall_auth_client, "post_platform_json", registration),
    ):
        await mitm_addon.request(flow)
        flow.response = http.Response.make(
            200, b"another provider", {"X-Okou-Data-Request-Id": str(uuid.uuid4())}
        )
        assert mitm_addon.response(flow) is None
    registration.assert_not_awaited()


async def test_body_limit_preserves_public_destination_admission(
    tmp_path: Path, real_flow, mitm_ctx, monkeypatch, fake_firewall_headers
) -> None:
    path = router_registry(tmp_path, public_destination=True)
    flow = router_flow(real_flow)
    flow.request.raw_content = None
    flow.request.headers["Content-Length"] = str(128 * 1024)
    monkeypatch.setattr(public_destination_body_admission, "MAX_ADMITTED_REQUESTS", 0)
    with (
        mitm_ctx(registry_path=str(path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        assert mitm_addon.requestheaders(flow) is None
        assert flow.error is not None
        assert (
            flow.metadata[metadata_keys.FIREWALL_ERROR]
            == "public_destination_request_body_admission_saturated"
        )
        auth_fetch.assert_not_awaited()


def _start_router_request(
    addon_context: taddons.context,
    *,
    protocol: str,
    headers: tuple[tuple[bytes, bytes], ...],
    end_stream: bool = False,
):
    if protocol == "http2":
        return start_http2_request(
            addon_context,
            method="POST",
            end_stream=end_stream,
            host="data.okou.ai",
            path="/mcp",
            regular_headers=headers,
        )
    client, layer = start_http_layer(addon_context, alpn=b"http/1.1", host="data.okou.ai")
    head = (
        b"POST /mcp HTTP/1.1\r\nHost: data.okou.ai\r\n"
        + b"".join(name + b": " + value + b"\r\n" for name, value in headers)
        + b"\r\n"
    )
    pending = list(layer.handle_event(events.DataReceived(client, head)))
    hook = next(cmd for cmd in pending if isinstance(cmd, HttpRequestHeadersHook))
    return layer, hook


def _body_wire(protocol: str, body: bytes) -> bytes:
    if protocol == "http1":
        return body
    wire = bytearray()
    for start in range(0, len(body), 16 * 1024):
        frame = DataFrame(1)
        frame.data = body[start : start + 16 * 1024]
        if start + len(frame.data) == len(body):
            frame.flags.add("END_STREAM")
        wire.extend(frame.serialize())
    return bytes(wire)


@pytest.mark.parametrize(
    ("protocol", "framing"),
    [
        ("http1", "oversized"),
        ("http2", "oversized"),
        ("http1", "chunked"),
        ("http2", "unknown"),
    ],
)
async def test_body_limit_rejects_before_native_buffering_or_registration(
    tmp_path: Path,
    fake_firewall_headers,
    protocol: str,
    framing: Literal["oversized", "chunked", "unknown"],
) -> None:
    registry_path = router_registry(tmp_path)
    headers = ((b"expect", b"100-continue"),)
    if framing == "oversized":
        headers += ((b"content-length", b"1048577"),)
    elif framing == "chunked":
        headers += ((b"transfer-encoding", b"chunked"),)
    registration = AsyncMock()
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
        fake_firewall_headers() as auth_fetch,
        patch.object(firewall_auth_client, "post_platform_json", registration),
    ):
        addon_context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry_path)
        )
        layer, headers_hook = _start_router_request(
            addon_context, protocol=protocol, headers=headers
        )
        stream = next(iter(layer.streams.values()))
        flow = headers_hook.flow
        # Data already queued behind the blocking native header hook must also
        # be retired without reaching the native body accumulator.
        queued_body = b"1\r\nx\r\n0\r\n\r\n" if framing == "chunked" else b"x"
        list(
            layer.handle_event(
                events.DataReceived(flow.client_conn, _body_wire(protocol, queued_body))
            )
        )
        await addon_context.master.addons.invoke_addon(mitm_addon, headers_hook)
        pending = list(layer.handle_event(events.HookCompleted(headers_hook, None)))
        history = []
        while pending:
            cmd = pending.pop(0)
            history.append(cmd)
            if isinstance(cmd, commands.StartHook):
                await addon_context.master.addons.invoke_addon(mitm_addon, cmd)
                pending.extend(layer.handle_event(events.HookCompleted(cmd, None)))

        assert flow.error is not None
        assert flow.request.raw_content is None
        assert len(stream.request_body_buf) == 0
        assert not any(isinstance(cmd, HttpRequestHook) for cmd in history)
        assert not any(
            isinstance(cmd, (commands.OpenConnection, commands.SendData))
            and isinstance(cmd.connection, connection.Server)
            for cmd in history
        )
        auth_fetch.assert_not_awaited()
        registration.assert_not_awaited()

    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["request_size"] == 0
    assert entry["firewall_error"] == (
        "data_router_request_body_too_large"
        if framing == "oversized"
        else "data_router_request_body_length_required"
    )


@pytest.mark.parametrize("protocol", ["http1", "http2"])
@pytest.mark.parametrize("body_size", [256, 1024 * 1024], ids=["small", "limit"])
async def test_native_body_at_inclusive_limit_registers_router_response(
    tmp_path: Path, fake_firewall_headers, protocol: str, body_size: int
) -> None:
    registry_path = router_registry(tmp_path)
    payload = json.dumps({"method": "tools/call", "params": {"name": "web_search"}}).encode()
    body = payload + b" " * (body_size - len(payload))
    registration = AsyncMock()
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
        fake_firewall_headers(headers={"Authorization": "Bearer service-token"}) as auth_fetch,
        patch.object(firewall_auth_client, "post_platform_json", registration),
    ):
        addon_context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry_path)
        )
        layer, headers_hook = _start_router_request(
            addon_context,
            protocol=protocol,
            headers=((b"content-length", str(len(body)).encode()),),
        )
        flow = headers_hook.flow
        await addon_context.master.addons.invoke_addon(mitm_addon, headers_hook)
        assert flow.error is None
        assert not flow.request.stream
        assert flow.request.raw_content is None
        auth_fetch.assert_not_awaited()
        registration.assert_not_awaited()
        list(layer.handle_event(events.HookCompleted(headers_hook, None)))
        pending = list(
            layer.handle_event(events.DataReceived(flow.client_conn, _body_wire(protocol, body)))
        )
        request_hook = next(cmd for cmd in pending if isinstance(cmd, HttpRequestHook))
        assert flow.request.raw_content == body
        mark_connected_tls_upstream(
            flow,
            sni="data.okou.ai",
            server_address=("data.okou.ai", 443),
            peername=("93.184.216.34", 443),
        )
        await addon_context.master.addons.invoke_addon(mitm_addon, request_hook)
        assert flow.response is None
        assert flow.request.headers["Authorization"] == "Bearer service-token"
        auth_fetch.assert_awaited_once()
        assert "X-Okou-Data-Request-Id" not in flow.request.headers
        registration.assert_not_awaited()
        request_id = str(uuid.uuid4())
        flow.response = http.Response.make(200, b"", {"X-Okou-Data-Request-Id": request_id})
        completion = mitm_addon.response(flow)
        assert completion is not None
        await completion
        registration.assert_awaited_once()
        [registered] = registration.await_args_list
        assert json.loads(registered.args[1])["requestId"] == request_id


@pytest.mark.parametrize("protocol", ["http1", "http2"])
async def test_native_headers_only_requests_do_not_need_a_body_length(
    tmp_path: Path, fake_firewall_headers, protocol: str
) -> None:
    registry_path = router_registry(tmp_path)
    registration = AsyncMock()
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
        fake_firewall_headers(headers={"Authorization": "Bearer service-token"}),
        patch.object(firewall_auth_client, "post_platform_json", registration),
    ):
        addon_context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry_path)
        )
        layer, headers_hook = _start_router_request(
            addon_context, protocol=protocol, headers=(), end_stream=True
        )
        await addon_context.master.addons.invoke_addon(mitm_addon, headers_hook)
        assert headers_hook.flow.error is None
        pending = list(layer.handle_event(events.HookCompleted(headers_hook, None)))
        request_hook = next(cmd for cmd in pending if isinstance(cmd, HttpRequestHook))
        flow = request_hook.flow
        mark_connected_tls_upstream(
            flow,
            sni="data.okou.ai",
            server_address=("data.okou.ai", 443),
            peername=("93.184.216.34", 443),
        )
        await addon_context.master.addons.invoke_addon(mitm_addon, request_hook)
        assert flow.response is None
        assert flow.request.raw_content == b""
        registration.assert_not_awaited()
        flow.response = http.Response.make(200)
        completion = mitm_addon.response(flow)
        assert completion is not None
        await completion
        registration.assert_not_awaited()
