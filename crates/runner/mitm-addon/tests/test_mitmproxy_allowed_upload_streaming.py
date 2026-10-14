"""Allowed uploads forward before EOF with bounded retention in real HttpStream.

TCP acquisition is controlled; TLS admission uses the existing verified-upstream
fixture. Cryptographic TLS verification is covered by the native auth-wait suite.
"""

from pathlib import Path
from typing import Literal
from unittest.mock import patch

import pytest
from mitmproxy import http
from mitmproxy.addons.proxyserver import Proxyserver
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

import flow_metadata_keys as metadata_keys
import mitm_addon
import request_streaming
import usage
from body_limits import STREAM_BUFFER_LIMIT
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.mitmproxy_http_framing_helpers import start_http_layer
from tests.request_handler_helpers import (
    _sandbox_without_firewalls,
    _single_firewall_sandbox,
    _write_registry,
)
from tests.upstream_connection_helpers import mark_connected_tls_upstream

type RequestKind = Literal["api", "browser", "policy", "credentials"]
type Framing = Literal["content-length", "chunked", "http2"]

_BROWSER_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) Chrome/126.0.0.0 Safari/537.36"
_CHUNK_SIZE = 64 * 1024
_TOKEN = "Bearer synthetic-upload-token"


def _upload_sandbox(
    tmp_path: Path,
    *,
    request_kind: RequestKind,
    capture_body: bool,
    billable: bool = False,
    upload_path: str = "/2/media/upload",
) -> dict[str, object]:
    sandbox_fields: dict[str, object] = {"captureNetworkBodies": capture_body}
    if request_kind in ("policy", "credentials"):
        permission = "tweet.write" if upload_path == "/2/tweets" else "media.write"
        return _single_firewall_sandbox(
            tmp_path,
            firewall_name="x",
            api_entry={
                "base": "https://api.x.com",
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.X_TOKEN }}"}},
                "permissions": [
                    {
                        "name": permission,
                        "rules": [
                            "POST /known" if request_kind == "policy" else f"POST {upload_path}"
                        ],
                    }
                ],
            },
            network_policy={
                "allow": [permission],
                "deny": [],
                "ask": [],
                "unknownPolicy": "allow",
            },
            billable_firewalls=["x"] if billable else None,
            sandbox_fields=sandbox_fields,
        )
    return _sandbox_without_firewalls(tmp_path, sandbox_fields=sandbox_fields)


async def _start_upload(
    addon_context: taddons.context,
    *,
    request_kind: RequestKind,
    framing: Framing,
    upload_size: int,
    upload_path: str = "/2/media/upload",
) -> tuple[HttpStream, http.HTTPFlow]:
    host = (
        "api.okou.ai"
        if request_kind == "api"
        else "api.x.com"
        if request_kind in ("policy", "credentials")
        else "example.com"
    )
    _, http_layer = start_http_layer(
        addon_context,
        alpn=b"h2" if framing == "http2" else b"http/1.1",
        host=host,
        mode=HTTPMode.transparent,
    )
    stream = HttpStream(http_layer.context.fork(), 1)
    list(stream.handle_event(events.Start()))
    header_fields = [
        (b"Host", host.encode()),
        (b"Content-Type", b"text/plain"),
        (
            b"User-Agent",
            _BROWSER_USER_AGENT.encode() if request_kind == "browser" else b"synthetic-client",
        ),
    ]
    if framing == "content-length":
        header_fields.append((b"Content-Length", str(upload_size).encode()))
    elif framing == "chunked":
        header_fields.append((b"Transfer-Encoding", b"chunked"))
    request = tutils.treq(
        scheme=b"https",
        method=b"OPTIONS" if request_kind == "policy" else b"POST",
        host=host.encode(),
        port=443,
        path=b"*" if request_kind == "policy" else upload_path.encode(),
        http_version=b"HTTP/2.0" if framing == "http2" else b"HTTP/1.1",
        headers=http.Headers(tuple(header_fields)),
        content=None,
    )
    if framing == "http2":
        request.authority = host
    pending = list(stream.handle_event(RequestHeaders(1, request, end_stream=False)))
    headers_hook = next(cmd for cmd in pending if isinstance(cmd, HttpRequestHeadersHook))
    flow = headers_hook.flow
    mark_connected_tls_upstream(
        flow, sni=host, server_address=(host, 443), peername=("104.18.32.47", 443)
    )
    await addon_context.master.addons.invoke_addon(mitm_addon, headers_hook)
    pending = list(stream.handle_event(events.HookCompleted(headers_hook, None)))
    get_connection = next((cmd for cmd in pending if isinstance(cmd, GetHttpConnection)), None)
    assert get_connection is not None, "authorized upload must acquire upstream before body EOF"
    pending = list(
        stream.handle_event(GetHttpConnectionCompleted(get_connection, (flow.server_conn, None)))
    )
    [head] = [
        cmd.event
        for cmd in pending
        if isinstance(cmd, SendHttp) and isinstance(cmd.event, RequestHeaders)
    ]
    assert head.request.headers["Host"] == host
    if request_kind == "credentials":
        assert head.request.headers["Authorization"] == _TOKEN
    else:
        assert "Authorization" not in head.request.headers
    return stream, flow


async def _finish_upload(addon_context: taddons.context, stream: HttpStream) -> None:
    pending = list(stream.handle_event(RequestEndOfMessage(1)))
    request_hook = next(cmd for cmd in pending if isinstance(cmd, HttpRequestHook))
    await addon_context.master.addons.invoke_addon(mitm_addon, request_hook)
    completed = list(stream.handle_event(events.HookCompleted(request_hook, None)))
    assert (
        len(
            [
                cmd
                for cmd in completed
                if isinstance(cmd, SendHttp) and isinstance(cmd.event, RequestEndOfMessage)
            ]
        )
        == 1
    )
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


@pytest.mark.parametrize("request_kind", ["api", "browser", "policy", "credentials"])
@pytest.mark.parametrize("framing", ["content-length", "chunked", "http2"])
@pytest.mark.parametrize("capture_body", [False, True])
@pytest.mark.parametrize("upload_size", [8 * 1024 * 1024, 32 * 1024 * 1024], ids=["8MiB", "32MiB"])
async def test_allowed_upload_forwards_before_eof_with_bounded_retention(
    tmp_path: Path,
    fake_firewall_headers,
    request_kind: RequestKind,
    framing: Framing,
    capture_body: bool,
    upload_size: int,
) -> None:
    registry_path = _write_registry(
        tmp_path,
        sandbox_info=_upload_sandbox(
            tmp_path, request_kind=request_kind, capture_body=capture_body
        ),
    )
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
        fake_firewall_headers(headers={"Authorization": _TOKEN}) as auth_fetch,
    ):
        addon_context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry_path)
        )
        stream, flow = await _start_upload(
            addon_context, request_kind=request_kind, framing=framing, upload_size=upload_size
        )
        forwarded_size = 0
        for index in range(upload_size // _CHUNK_SIZE):
            # Distinct chunks catch native accumulation without retaining test output.
            chunk = f"{index:08d}".encode() * (_CHUNK_SIZE // 8)
            pending = list(stream.handle_event(RequestData(1, chunk)))
            [sent] = [
                cmd
                for cmd in pending
                if isinstance(cmd, SendHttp) and isinstance(cmd.event, RequestData)
            ]
            assert isinstance(sent.event, RequestData)
            assert sent.connection is flow.server_conn
            assert sent.event.data == chunk
            forwarded_size += len(sent.event.data)
            assert len(stream.request_body_buf) == 0
            assert flow.request.raw_content is None
            captured = request_streaming.captured_request_stream_body(flow)
            if capture_body:
                assert captured is not None
                assert len(captured.buffer) <= STREAM_BUFFER_LIMIT
            else:
                assert captured is None
                assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata

        assert forwarded_size == upload_size
        assert request_streaming.streamed_request_size(flow) == upload_size
        await _finish_upload(addon_context, stream)
        if request_kind == "credentials":
            auth_fetch.assert_awaited_once()
        else:
            auth_fetch.assert_not_awaited()

    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["request_size"] == upload_size
    assert entry["status"] == 200
    if capture_body:
        assert entry["request_body"] == "00000000" * (STREAM_BUFFER_LIMIT // 8)
        assert entry["request_body_truncated"] is True
    else:
        assert not any(key.startswith("request_body") for key in entry)
    assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
    assert metadata_keys.REQUEST_STREAM_BUFFER_STATE not in flow.metadata
    assert flow.request.stream is False


async def test_uncaptured_billable_upload_preserves_usage(
    tmp_path: Path, fake_firewall_headers, usage_webhook_server, sync_usage_executor
) -> None:
    registry_path = _write_registry(
        tmp_path,
        sandbox_info=_upload_sandbox(
            tmp_path, request_kind="credentials", capture_body=False, billable=True
        ),
    )
    body = b"synthetic upload" * STREAM_BUFFER_LIMIT
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
        fake_firewall_headers(headers={"Authorization": _TOKEN}) as auth_fetch,
    ):
        addon_context.options.update(
            okou_api_url=usage_webhook_server.api_url,
            okou_proxy_registry_path=str(registry_path),
        )
        stream, flow = await _start_upload(
            addon_context,
            request_kind="credentials",
            framing="content-length",
            upload_size=len(body),
        )
        pending = list(stream.handle_event(RequestData(1, body)))
        assert (
            b"".join(
                cmd.event.data
                for cmd in pending
                if isinstance(cmd, SendHttp) and isinstance(cmd.event, RequestData)
            )
            == body
        )
        await _finish_upload(addon_context, stream)
        usage.flush_usage_events(trigger="test")
        auth_fetch.assert_awaited_once()

    [event] = usage_webhook_server.usage_events()
    assert event["provider"] == "x"
    assert event["category"] == "content.create_with_url"
    assert event["quantity"] == 1
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["request_size"] == len(body)
    assert not any(key.startswith("request_body") for key in entry)
    assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
    assert flow.request.stream is False


@pytest.mark.parametrize("framing", ["chunked", "http2"])
@pytest.mark.parametrize(
    ("body", "expected_category"),
    [
        (b'{"text":"hello"}', "content.create"),
        (b'{"text":"https://example.com"}', "content.create_with_url"),
        (b'{"text":"hello"}' + b" " * STREAM_BUFFER_LIMIT, "content.create_with_url"),
    ],
    ids=["plain", "with-url", "over-inspection-limit"],
)
async def test_uncaptured_unknown_length_tweet_keeps_bounded_billing_refinement(
    tmp_path: Path,
    fake_firewall_headers,
    usage_webhook_server,
    sync_usage_executor,
    framing: Framing,
    body: bytes,
    expected_category: str,
) -> None:
    registry_path = _write_registry(
        tmp_path,
        sandbox_info=_upload_sandbox(
            tmp_path,
            request_kind="credentials",
            capture_body=False,
            billable=True,
            upload_path="/2/tweets",
        ),
    )
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
        fake_firewall_headers(headers={"Authorization": _TOKEN}),
    ):
        addon_context.options.update(
            okou_api_url=usage_webhook_server.api_url,
            okou_proxy_registry_path=str(registry_path),
        )
        stream, flow = await _start_upload(
            addon_context,
            request_kind="credentials",
            framing=framing,
            upload_size=len(body),
            upload_path="/2/tweets",
        )
        pending = list(stream.handle_event(RequestData(1, body)))
        assert (
            b"".join(
                cmd.event.data
                for cmd in pending
                if isinstance(cmd, SendHttp) and isinstance(cmd.event, RequestData)
            )
            == body
        )
        assert len(stream.request_body_buf) == 0
        captured = request_streaming.captured_request_stream_body(flow)
        assert captured is not None
        assert len(captured.buffer) <= STREAM_BUFFER_LIMIT
        await _finish_upload(addon_context, stream)
        usage.flush_usage_events(trigger="test")

    [event] = usage_webhook_server.usage_events()
    assert event["provider"] == "x"
    assert event["category"] == expected_category
    assert event["quantity"] == 1
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["request_size"] == len(body)
    assert not any(key.startswith("request_body") for key in entry)
    assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
    assert flow.request.stream is False
