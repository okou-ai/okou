"""Native HTTP streams retain separate sandbox counts through response EOF."""

import json
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

import managed_openrouter as managed
import mitm_addon
from tests.managed_openrouter_helpers import (
    PATHS,
    PI_ATTRIBUTION_HEADERS,
    payload,
    write_sandbox_registry,
)
from tests.mitmproxy_http_framing_helpers import start_http_layer
from tests.upstream_connection_helpers import mark_connected_tls_upstream

CLIENT_IPS = ("10.200.0.5", "10.200.0.6")


async def _finish_hooks(context, stream, pending):
    queue = list(pending)
    while queue:
        command = queue.pop(0)
        if isinstance(command, commands.StartHook):
            await context.master.addons.invoke_addon(mitm_addon, command)
            queue.extend(stream.handle_event(events.HookCompleted(command, None)))


async def _start_stream(context, dialect, http2, peer, body):
    client, layer = start_http_layer(
        context,
        alpn=b"h2" if http2 else b"http/1.1",
        host="openrouter.ai",
        mode=HTTPMode.transparent,
    )
    client.peername = peer
    stream = HttpStream(layer.context.fork(), 1)
    list(stream.handle_event(events.Start()))
    req = tutils.treq(
        scheme=b"https",
        method=b"POST",
        host=b"openrouter.ai",
        port=443,
        path=PATHS[dialect].encode(),
        http_version=b"HTTP/2.0" if http2 else b"HTTP/1.1",
        headers=http.Headers(
            (
                (b"Host", b"openrouter.ai"),
                (b"Content-Type", b"application/json"),
                (b"Content-Length", str(len(body)).encode()),
                (b"Authorization", b"Bearer sandbox-placeholder"),
            )
        ),
        content=None,
    )
    for name, value in PI_ATTRIBUTION_HEADERS:
        req.headers[name] = value
    if http2:
        req.authority = "openrouter.ai"
    pending = list(stream.handle_event(RequestHeaders(1, req, end_stream=False)))
    hook = next(c for c in pending if isinstance(c, HttpRequestHeadersHook))
    flow = hook.flow
    mark_connected_tls_upstream(
        flow,
        sni="openrouter.ai",
        server_address=("openrouter.ai", 443),
        peername=("104.18.32.47", 443),
    )
    await context.master.addons.invoke_addon(mitm_addon, hook)
    pending = list(stream.handle_event(events.HookCompleted(hook, None)))
    assert not any(isinstance(c, (GetHttpConnection, SendHttp)) for c in pending)
    await _finish_hooks(context, stream, pending)
    return stream, flow


async def _forward_and_start_response(context, stream, flow, body):
    pending = list(stream.handle_event(RequestData(1, body)))
    assert not any(isinstance(c, (GetHttpConnection, SendHttp)) for c in pending)
    pending = list(stream.handle_event(RequestEndOfMessage(1)))
    hook = next(c for c in pending if isinstance(c, HttpRequestHook))
    await context.master.addons.invoke_addon(mitm_addon, hook)
    pending = list(stream.handle_event(events.HookCompleted(hook, None)))
    acquire = next(c for c in pending if isinstance(c, GetHttpConnection))
    sent = list(stream.handle_event(GetHttpConnectionCompleted(acquire, (flow.server_conn, None))))
    headers = [
        c.event for c in sent if isinstance(c, SendHttp) and isinstance(c.event, RequestHeaders)
    ]
    assert len(headers) == 1
    assert headers[0].request.headers["Authorization"] == "Bearer synthetic-managed"
    assert (
        b"".join(
            c.event.data
            for c in sent
            if isinstance(c, SendHttp) and isinstance(c.event, RequestData)
        )
        == body
    )
    response = http.Response.make(200, b"", {"Content-Type": "text/event-stream"})
    pending = list(stream.handle_event(ResponseHeaders(1, response, end_stream=False)))
    await _finish_hooks(context, stream, pending)


@pytest.mark.parametrize("dialect", ["openai-completions", "openai-responses"])
@pytest.mark.parametrize("http2", [False, True], ids=["http1", "http2"])
async def test_open_response_blocks_only_its_sandbox_until_native_eof(
    tmp_path, fake_firewall_headers, monkeypatch, dialect, http2
):
    # The hook-level regression exercises the default 16. One slot isolates the
    # native transport lifetime without duplicating 16 HTTP streams per peer.
    monkeypatch.setattr(managed, "MAX_ADMITTED_REQUESTS", 1)
    path = write_sandbox_registry(tmp_path, dialect, CLIENT_IPS)
    body = json.dumps(payload(dialect)).encode()
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as context,
        fake_firewall_headers(headers={"Authorization": "Bearer synthetic-managed"}) as auth_fetch,
    ):
        context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(path)
        )
        first_stream, first = await _start_stream(
            context, dialect, http2, (CLIENT_IPS[0], 12000), body
        )
        assert first.error is None
        auth_fetch.assert_not_called()
        await _forward_and_start_response(context, first_stream, first, body)

        other_stream, other = await _start_stream(
            context, dialect, http2, (CLIENT_IPS[1], 12000), body
        )
        assert other.error is None
        await _forward_and_start_response(context, other_stream, other, body)

        _, blocked = await _start_stream(context, dialect, http2, (CLIENT_IPS[0], 13000), body)
        assert blocked.error is not None
        assert blocked.request.headers["Authorization"] == "Bearer sandbox-placeholder"

        pending = list(first_stream.handle_event(ResponseEndOfMessage(1)))
        await _finish_hooks(context, first_stream, pending)
        replacement_stream, replacement = await _start_stream(
            context, dialect, http2, (CLIENT_IPS[0], 14000), body
        )
        assert replacement.error is None
        await _forward_and_start_response(context, replacement_stream, replacement, body)
        for stream in (other_stream, replacement_stream):
            pending = list(stream.handle_event(ResponseEndOfMessage(1)))
            await _finish_hooks(context, stream, pending)
    assert managed.admission_state_for_tests() == (0, 0)
