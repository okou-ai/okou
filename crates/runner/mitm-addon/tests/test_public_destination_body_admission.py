"""Deferred destination uploads have bounded admission before body or credentials."""

import asyncio
from pathlib import Path
from typing import Literal
from unittest.mock import AsyncMock, patch

import pytest
from h2.config import H2Configuration
from h2.connection import H2Connection
from mitmproxy import connection, http
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.flow import Error
from mitmproxy.proxy import commands, events
from mitmproxy.proxy.layers.http import (
    GetHttpConnection,
    GetHttpConnectionCompleted,
    HTTPMode,
    HttpStream,
    SendHttp,
)
from mitmproxy.proxy.layers.http._events import (
    RequestData,
    RequestEndOfMessage,
    RequestHeaders,
    ResponseEndOfMessage,
    ResponseHeaders,
)
from mitmproxy.proxy.layers.http._hooks import HttpRequestHeadersHook, HttpRequestHook
from mitmproxy.test import taddons, tutils

import auth
import flow_metadata_keys as metadata_keys
import mitm_addon
import public_destination_body_admission
from body_limits import STREAM_BUFFER_LIMIT
from tests.firewall_helpers import cancel_pending_task
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.mitmproxy_http_framing_helpers import start_http2_request, start_http_layer
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry
from tests.upstream_connection_helpers import mark_connected_tls_upstream

_HOST = "service.example.com"


def _write_deferred_registry(
    tmp_path: Path, *, capture_body: bool, auth_config: dict[str, object] | None = None
) -> Path:
    return _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            api_entry={
                "base": f"https://{_HOST}",
                "hostPolicy": {"kind": "publicDestination"},
                "auth": (
                    auth_config
                    if auth_config is not None
                    else {"headers": {"Authorization": "Bearer ${{ secrets.API_TOKEN }}"}}
                ),
                "permissions": [{"name": "upload", "rules": ["POST /upload"]}],
            },
            network_policy={"allow": ["upload"], "deny": [], "ask": [], "unknownPolicy": "allow"},
            sandbox_fields={"captureNetworkBodies": capture_body},
        ),
    )


async def test_headers_only_http2_deferred_request_needs_no_declared_body_length(
    tmp_path: Path, fake_firewall_headers
) -> None:
    registry_path = _write_deferred_registry(tmp_path, capture_body=False)
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
    ):
        addon_context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry_path)
        )
        layer, headers_hook = start_http2_request(
            addon_context, method="POST", end_stream=True, host=_HOST, path="/upload"
        )
        await addon_context.master.addons.invoke_addon(mitm_addon, headers_hook)
        assert headers_hook.flow.error is None
        auth_fetch.assert_not_awaited()
        pending = list(layer.handle_event(events.HookCompleted(headers_hook, None)))
        request_hook = next(cmd for cmd in pending if isinstance(cmd, HttpRequestHook))
        flow = request_hook.flow
        assert flow.request.raw_content == b""
        mark_connected_tls_upstream(
            flow, sni=_HOST, server_address=(_HOST, 443), peername=("93.184.216.34", 443)
        )
        await addon_context.master.addons.invoke_addon(mitm_addon, request_hook)
        assert flow.response is None
        assert flow.request.headers["Authorization"] == "Bearer resolved"
        auth_fetch.assert_awaited_once()
        flow.response = http.Response.make(200)
        mitm_addon.response(flow)

    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["request_size"] == 0
    assert entry["status"] == 200
    assert not any(key.startswith("request_body") for key in entry)


@pytest.mark.parametrize("capture_body", [False, True])
@pytest.mark.parametrize("policy_only", [False, True], ids=["credentials", "policy-only"])
@pytest.mark.parametrize("framing", ["oversized", "chunked", "http2-open"])
async def test_deferred_unbounded_upload_terminates_before_consumption(
    tmp_path: Path,
    fake_firewall_headers,
    capture_body: bool,
    policy_only: bool,
    framing: Literal["oversized", "chunked", "http2-open"],
) -> None:
    registry_path = _write_deferred_registry(tmp_path, capture_body=capture_body)
    method = "OPTIONS" if policy_only else "POST"
    path = "*" if policy_only else "/upload"
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
        fake_firewall_headers() as auth_fetch,
    ):
        addon_context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry_path)
        )
        client, layer = start_http_layer(
            addon_context,
            alpn=b"h2" if framing == "http2-open" else b"http/1.1",
            host=_HOST,
        )
        if framing == "http2-open":
            http2 = H2Connection(H2Configuration(client_side=True, header_encoding=None))
            http2.initiate_connection()
            http2.send_headers(
                1,
                [
                    (b":method", method.encode()),
                    (b":scheme", b"https"),
                    (b":authority", _HOST.encode()),
                    (b":path", path.encode()),
                ],
                end_stream=False,
            )
            request_head = http2.data_to_send()
        else:
            oversized_length = public_destination_body_admission.MAX_REQUEST_BODY_BYTES + 1
            body_header = (
                "Transfer-Encoding: chunked\r\n"
                if framing == "chunked"
                else f"Content-Length: {oversized_length}\r\n"
            )
            request_head = (
                f"{method} {path} HTTP/1.1\r\nHost: {_HOST}\r\nExpect: 100-continue\r\n"
                + body_header
                + "\r\n"
            ).encode()
        history = list(layer.handle_event(events.DataReceived(client, request_head)))
        headers_hook = next(cmd for cmd in history if isinstance(cmd, HttpRequestHeadersHook))
        await addon_context.master.addons.invoke_addon(mitm_addon, headers_hook)
        pending = list(layer.handle_event(events.HookCompleted(headers_hook, None)))
        while pending:
            command = pending.pop(0)
            history.append(command)
            if isinstance(command, commands.StartHook):
                await addon_context.master.addons.invoke_addon(mitm_addon, command)
                pending.extend(layer.handle_event(events.HookCompleted(command, None)))

        flow = headers_hook.flow
        auth_fetch.assert_not_awaited()
        assert flow.error is not None
        assert flow.error.msg == Error.KILLED_MESSAGE
        assert flow.request.raw_content is None
        assert "Authorization" not in flow.request.headers
        assert not any(isinstance(cmd, HttpRequestHook) for cmd in history)
        assert not any(
            isinstance(cmd, (commands.OpenConnection, commands.SendData))
            and isinstance(cmd.connection, connection.Server)
            for cmd in history
        )

    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["request_size"] == 0
    assert entry["firewall_error"] == (
        "public_destination_request_body_too_large"
        if framing == "oversized"
        else "public_destination_request_body_length_required"
    )


@pytest.mark.parametrize(
    "auth_config",
    [
        {"base": "${{ secrets.WEBHOOK_URL }}"},
        {
            "awsSigv4": {
                "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
            }
        },
    ],
    ids=["auth-base", "sigv4"],
)
def test_policy_only_deferred_upload_uses_body_budget_without_auth(
    tmp_path, real_flow, mitm_ctx, headers, fake_firewall_headers, auth_config
):
    registry_path = _write_deferred_registry(tmp_path, capture_body=False, auth_config=auth_config)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host=_HOST,
        method="OPTIONS",
        path="*",
        request_headers=headers(
            ("Host", _HOST),
            ("Content-Length", str(public_destination_body_admission.MAX_REQUEST_BODY_BYTES + 1)),
        ),
    )
    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        assert mitm_addon.requestheaders(flow) is None
    assert flow.error is not None
    assert (
        flow.metadata[metadata_keys.FIREWALL_ERROR] == "public_destination_request_body_too_large"
    )
    auth_fetch.assert_not_awaited()


@pytest.mark.parametrize("capture_body", [False, True])
async def test_bounded_deferred_upload_forwards_after_authorization_and_releases_after_response(
    tmp_path: Path, real_flow, fake_firewall_headers, headers, capture_body: bool
) -> None:
    registry_path = _write_deferred_registry(tmp_path, capture_body=capture_body)
    body = b"x" * (STREAM_BUFFER_LIMIT + 1)
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
    ):
        addon_context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry_path)
        )
        _, layer = start_http_layer(
            addon_context, alpn=b"http/1.1", host=_HOST, mode=HTTPMode.transparent
        )
        stream = HttpStream(layer.context.fork(), 1)
        list(stream.handle_event(events.Start()))
        request = tutils.treq(
            scheme=b"https",
            method=b"POST",
            host=_HOST.encode(),
            port=443,
            path=b"/upload",
            headers=http.Headers(
                ((b"Host", _HOST.encode()), (b"Content-Length", str(len(body)).encode()))
            ),
            content=None,
        )
        pending = list(stream.handle_event(RequestHeaders(1, request, end_stream=False)))
        headers_hook = next(cmd for cmd in pending if isinstance(cmd, HttpRequestHeadersHook))
        await addon_context.master.addons.invoke_addon(mitm_addon, headers_hook)
        pending = list(stream.handle_event(events.HookCompleted(headers_hook, None)))
        assert not any(isinstance(cmd, (GetHttpConnection, SendHttp)) for cmd in pending)
        auth_fetch.assert_not_awaited()
        pending = list(stream.handle_event(RequestData(1, body)))
        assert not any(isinstance(cmd, SendHttp) for cmd in pending)
        pending = list(stream.handle_event(RequestEndOfMessage(1)))
        request_hook = next(cmd for cmd in pending if isinstance(cmd, HttpRequestHook))
        flow = request_hook.flow
        mark_connected_tls_upstream(
            flow, sni=_HOST, server_address=(_HOST, 443), peername=("93.184.216.34", 443)
        )
        await addon_context.master.addons.invoke_addon(mitm_addon, request_hook)
        pending = list(stream.handle_event(events.HookCompleted(request_hook, None)))
        get_connection = next(cmd for cmd in pending if isinstance(cmd, GetHttpConnection))
        sent = list(
            stream.handle_event(
                GetHttpConnectionCompleted(get_connection, (flow.server_conn, None))
            )
        )
        [head] = [
            cmd.event
            for cmd in sent
            if isinstance(cmd, SendHttp) and isinstance(cmd.event, RequestHeaders)
        ]
        assert head.request.headers["Authorization"] == "Bearer resolved"
        assert (
            b"".join(
                cmd.event.data
                for cmd in sent
                if isinstance(cmd, SendHttp) and isinstance(cmd.event, RequestData)
            )
            == body
        )
        auth_fetch.assert_awaited_once()

        def probe_upload():
            probe = real_flow(
                with_response=False,
                client_ip="10.200.0.5",
                host=_HOST,
                method="POST",
                path="/upload",
                request_headers=headers(("Host", _HOST), ("Content-Length", str(len(body)))),
            )
            assert mitm_addon.requestheaders(probe) is None
            return probe

        # Completion still retains the native body until terminal consumers finish.
        other_uploads = [probe_upload() for _ in range(15)]
        assert all(probe.error is None for probe in other_uploads)
        assert probe_upload().error is not None

        pending = list(
            stream.handle_event(ResponseHeaders(1, http.Response.make(200), end_stream=False))
        )
        response_headers_hook = next(cmd for cmd in pending if isinstance(cmd, commands.StartHook))
        await addon_context.master.addons.invoke_addon(mitm_addon, response_headers_hook)
        list(stream.handle_event(events.HookCompleted(response_headers_hook, None)))
        pending = list(stream.handle_event(ResponseEndOfMessage(1)))
        response_hook = next(cmd for cmd in pending if isinstance(cmd, commands.StartHook))
        await addon_context.master.addons.invoke_addon(mitm_addon, response_hook)
        list(stream.handle_event(events.HookCompleted(response_hook, None)))
        replacement = probe_upload()
        assert replacement.error is None
        assert probe_upload().error is not None
        for probe in [*other_uploads, replacement]:
            probe.error = Error("test client closed")
            mitm_addon.error(probe)

    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["request_size"] == len(body)
    assert entry["status"] == 200
    if not capture_body:
        assert not any(key.startswith("request_body") for key in entry)


@pytest.mark.parametrize("capture_body", [False, True])
@pytest.mark.parametrize(
    ("body_size", "capacity"),
    [(STREAM_BUFFER_LIMIT + 1, 16), (32 * 1024 * 1024, 4)],
    ids=["count-budget", "byte-budget"],
)
def test_deferred_upload_budget_recovers_after_disconnect(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers, capture_body, body_size, capacity
):
    registry_path = _write_deferred_registry(tmp_path, capture_body=capture_body)

    def upload_flow():
        return real_flow(
            with_response=False,
            client_ip="10.200.0.5",
            host=_HOST,
            method="POST",
            path="/upload",
            request_headers=headers(("Host", _HOST), ("Content-Length", str(body_size))),
        )

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        admitted = [upload_flow() for _ in range(capacity)]
        for flow in admitted:
            assert mitm_addon.requestheaders(flow) is None
            assert flow.error is None
            assert flow.request.stream is False
            assert "Authorization" not in flow.request.headers

        rejected = upload_flow()
        assert mitm_addon.requestheaders(rejected) is None
        assert rejected.error is not None
        assert rejected.metadata[metadata_keys.FIREWALL_ERROR] == (
            "public_destination_request_body_admission_saturated"
        )
        admitted[0].error = Error("client disconnected before upload EOF")
        mitm_addon.error(admitted[0])
        # Repeated terminal notification must not free another live reservation.
        mitm_addon.error(admitted[0])
        replacement = upload_flow()
        assert mitm_addon.requestheaders(replacement) is None
        assert replacement.error is None
        still_full = upload_flow()
        assert mitm_addon.requestheaders(still_full) is None
        assert still_full.error is not None
        assert still_full.metadata[metadata_keys.FIREWALL_ERROR] == (
            "public_destination_request_body_admission_saturated"
        )
        auth_fetch.assert_not_awaited()
        for flow in [*admitted[1:], replacement]:
            flow.error = Error("test client closed")
            mitm_addon.error(flow)


async def test_deferred_body_admission_releases_on_request_cancellation(
    tmp_path, real_flow, mitm_ctx, headers, monkeypatch
):
    registry_path = _write_deferred_registry(tmp_path, capture_body=False)
    body_size = public_destination_body_admission.MAX_REQUEST_BODY_BYTES

    def upload_flow():
        return real_flow(
            with_response=False,
            client_ip="10.200.0.5",
            host=_HOST,
            method="POST",
            path="/upload",
            request_headers=headers(("Host", _HOST), ("Content-Length", str(body_size))),
        )

    entered = asyncio.Event()
    release_auth = asyncio.Event()

    async def resolve_auth(*_args, **_kwargs):
        entered.set()
        await release_auth.wait()

    auth_fetch = AsyncMock(side_effect=resolve_auth)
    monkeypatch.setattr(auth, "get_firewall_headers", auth_fetch)
    request_task = None
    with mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"):
        flows = [upload_flow() for _ in range(4)]
        for flow in flows:
            assert mitm_addon.requestheaders(flow) is None
            assert flow.error is None
        mark_connected_tls_upstream(
            flows[0], sni=_HOST, server_address=(_HOST, 443), peername=("93.184.216.34", 443)
        )
        try:
            request_task = asyncio.create_task(mitm_addon.request(flows[0]))
            await asyncio.wait_for(entered.wait(), timeout=1)
            await cancel_pending_task(request_task)
            replacement = upload_flow()
            assert mitm_addon.requestheaders(replacement) is None
            assert replacement.error is None
            assert "Authorization" not in flows[0].request.headers
            auth_fetch.assert_awaited_once()
            flows.append(replacement)
        finally:
            release_auth.set()
            await cancel_pending_task(request_task)
            for flow in flows:
                flow.error = Error("test client closed")
                mitm_addon.error(flow)
