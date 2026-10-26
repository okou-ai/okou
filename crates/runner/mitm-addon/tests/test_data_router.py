"""Data Router correlation through the production request hooks."""

import json
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
import mitm_addon
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.mitmproxy_http_framing_helpers import start_http2_request, start_http_layer
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry
from tests.upstream_connection_helpers import mark_connected_tls_upstream


def router_registry(tmp_path):
    return _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            run_id=str(uuid.uuid4()),
            firewall_name="data-router",
            api_entry={
                "base": "https://data.okou.ai/mcp",
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.OKOU_DATA_TOKEN }}"}},
                "permissions": [{"name": "call", "rules": ["ANY /{path*}"]}],
            },
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


async def test_cached_credentials_still_register_each_request_before_upstream(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers
):
    path = router_registry(tmp_path)
    flows = [router_flow(real_flow), router_flow(real_flow)]
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
                    )
                )
            ),
        ) as auth_fetch,
        patch.object(firewall_auth_client, "post_platform_json", registration),
    ):
        for flow in flows:
            assert mitm_addon.requestheaders(flow) is None
            assert not callable(flow.request.stream)
            assert registration.await_count == flows.index(flow)
            await mitm_addon.request(flow)
            assert flow.response is None
            assert flow.request.headers["Authorization"] == "Bearer service-token"
    assert auth_fetch.await_count == 1
    assert registration.await_count == 2
    ids = [flow.request.headers["X-Okou-Data-Request-Id"] for flow in flows]
    assert len(set(ids)) == 2
    for request_id, call in zip(ids, registration.await_args_list, strict=True):
        assert str(uuid.UUID(request_id)) == request_id
        assert json.loads(call.args[1])["requestId"] == request_id


async def test_failed_registration_blocks_paid_execution(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers
):
    path = router_registry(tmp_path)
    flow = router_flow(real_flow)
    with (
        mitm_ctx(registry_path=str(path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer service-token"}),
        patch.object(
            firewall_auth_client, "post_platform_json", AsyncMock(side_effect=TimeoutError)
        ),
        pytest.raises(TimeoutError),
    ):
        await mitm_addon.request(flow)
    assert flow.response is not None
    assert flow.response.status_code == 500
    assert "X-Okou-Data-Request-Id" not in flow.request.headers


async def test_control_requests_do_not_register_or_keep_forged_identity(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers
):
    path = router_registry(tmp_path)
    flows = [
        router_flow(real_flow, method="tools/list"),
        router_flow(real_flow, name="billing_get"),
    ]
    registration = AsyncMock()
    with (
        mitm_ctx(registry_path=str(path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer service-token"}),
        patch.object(firewall_auth_client, "post_platform_json", registration),
    ):
        for flow in flows:
            await mitm_addon.request(flow)
            assert "X-Okou-Data-Request-Id" not in flow.request.headers
    registration.assert_not_awaited()


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
async def test_native_body_at_inclusive_limit_registers_before_upstream(
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
        registration.assert_awaited_once()
        [registered] = registration.await_args_list
        assert (
            json.loads(registered.args[1])["requestId"]
            == flow.request.headers["X-Okou-Data-Request-Id"]
        )
        flow.response = http.Response.make(200)
        mitm_addon.response(flow)


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
        mitm_addon.response(flow)
