"""Production addon/native HTTP drivers for managed upload contracts."""

from mitmproxy import http
from mitmproxy.proxy import commands, events
from mitmproxy.proxy.layers.http import HTTPMode, HttpStream
from mitmproxy.proxy.layers.http._events import RequestHeaders
from mitmproxy.proxy.layers.http._hooks import HttpRequestHeadersHook
from mitmproxy.test import tutils

import mitm_addon
from tests.managed_openrouter_helpers import PATHS, PI_ATTRIBUTION_HEADERS
from tests.mitmproxy_http_framing_helpers import start_http_layer
from tests.upstream_connection_helpers import mark_connected_tls_upstream


async def finish_hooks(context, stream, pending):
    observed = []
    queue = list(pending)
    while queue:
        command = queue.pop(0)
        observed.append(command)
        if isinstance(command, commands.StartHook):
            await context.master.addons.invoke_addon(mitm_addon, command)
            queue.extend(stream.handle_event(events.HookCompleted(command, None)))
    return observed


async def begin_upload(context, length, *, dialect="openai-completions", http2=False):
    _, layer = start_http_layer(
        context,
        alpn=b"h2" if http2 else b"http/1.1",
        host="openrouter.ai",
        mode=HTTPMode.transparent,
    )
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
            [
                (b"Host", b"openrouter.ai"),
                (b"Content-Type", b"application/json"),
                (b"Content-Length", str(length).encode()),
            ]
        ),
        content=None,
    )
    for key, value in PI_ATTRIBUTION_HEADERS:
        req.headers[key] = value
    if http2:
        req.authority = "openrouter.ai"
    pending = list(stream.handle_event(RequestHeaders(1, req, end_stream=False)))
    hook = next(item for item in pending if isinstance(item, HttpRequestHeadersHook))
    mark_connected_tls_upstream(
        hook.flow,
        sni="openrouter.ai",
        server_address=("openrouter.ai", 443),
        peername=("104.18.32.47", 443),
    )
    await finish_hooks(context, stream, pending)
    return stream, hook.flow
