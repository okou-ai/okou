"""Native HTTP-state proof that managed inference waits for full validation."""

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
    RequestTrailers,
    ResponseEndOfMessage,
    ResponseHeaders,
)
from mitmproxy.proxy.layers.http._hooks import HttpRequestHeadersHook
from mitmproxy.test import taddons, tutils

import managed_openrouter as managed
import mitm_addon
from tests.managed_openrouter_helpers import PATHS, PI_ATTRIBUTION_HEADERS, PRESET, sandbox
from tests.mitmproxy_http_framing_helpers import start_http_layer
from tests.request_handler_helpers import _write_registry
from tests.upstream_connection_helpers import mark_connected_tls_upstream


async def _finish_hooks(context, stream, pending):
    observed = []
    queue = list(pending)
    while queue:
        command = queue.pop(0)
        observed.append(command)
        if isinstance(command, commands.StartHook):
            await context.master.addons.invoke_addon(mitm_addon, command)
            queue.extend(stream.handle_event(events.HookCompleted(command, None)))
    return observed


@pytest.mark.parametrize("dialect", ["openai-completions", "openai-responses"])
@pytest.mark.parametrize("http2", [False, True], ids=["http1", "http2"])
@pytest.mark.parametrize("case", ["late-override", "trailers", "accepted"])
async def test_complete_body_is_validated_before_any_upstream_request(
    tmp_path, fake_firewall_headers, dialect, http2, case
):
    path = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path, dialect))
    # The policy-changing field is deliberately beyond the diagnostic prefix.
    key = b"messages" if dialect == "openai-completions" else b"input"
    body = b'{"' + key + b'":[{"role":"user","content":"' + b"x" * 100_000
    body += b'"}],"model":"' + PRESET.encode() + b'","stream":true'
    body += b',"provider":{}}' if case == "late-override" else b"}"
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as context,
        fake_firewall_headers(headers={"Authorization": "Bearer synthetic-managed"}) as auth_fetch,
    ):
        context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(path)
        )
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
                (
                    (b"Host", b"openrouter.ai"),
                    (b"Content-Type", b"application/json"),
                    (b"Content-Length", str(len(body)).encode()),
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
        observed = list(stream.handle_event(events.HookCompleted(hook, None)))
        assert not any(isinstance(c, (GetHttpConnection, SendHttp)) for c in observed)
        assert flow.request.stream is False
        auth_fetch.assert_not_called()
        for fragment in (body[:80_000], body[80_000:]):
            pending = list(stream.handle_event(RequestData(1, fragment)))
            assert not any(isinstance(c, (GetHttpConnection, SendHttp)) for c in pending)
            observed.extend(await _finish_hooks(context, stream, pending))
            assert not stream.request_body_buf
            assert flow.request.raw_content is None
            auth_fetch.assert_not_called()
        if case == "trailers":
            pending = list(
                stream.handle_event(
                    RequestTrailers(1, http.Headers([(b"X-OpenRouter-Preset", b"other")]))
                )
            )
            assert not any(isinstance(c, (GetHttpConnection, SendHttp)) for c in pending)
        pending = list(stream.handle_event(RequestEndOfMessage(1)))
        pending = await _finish_hooks(context, stream, pending)
        if case != "accepted":
            observed.extend(pending)
            auth_fetch.assert_not_called()
            assert flow.response is not None
            assert flow.response.status_code == 403
            assert not any(isinstance(c, GetHttpConnection) for c in observed)
            assert not any(
                isinstance(c, SendHttp) and isinstance(c.event, (RequestHeaders, RequestData))
                for c in observed
            )
        else:
            auth_fetch.assert_awaited_once()
            connection = next(c for c in pending if isinstance(c, GetHttpConnection))
            sent = list(
                stream.handle_event(
                    GetHttpConnectionCompleted(connection, (flow.server_conn, None))
                )
            )
            sent = await _finish_hooks(context, stream, sent)
            heads = [
                c.event
                for c in sent
                if isinstance(c, SendHttp) and isinstance(c.event, RequestHeaders)
            ]
            assert len(heads) == 1
            assert heads[0].request.headers["Authorization"] == "Bearer synthetic-managed"
            for name, value in PI_ATTRIBUTION_HEADERS:
                assert heads[0].request.headers[name] == value
            assert (
                b"".join(
                    c.event.data
                    for c in sent
                    if isinstance(c, SendHttp) and isinstance(c.event, RequestData)
                )
                == body
            )
            assert flow.request.raw_content == b""
            assert managed.admission_state_for_tests() == (0, 0)
            pending = list(
                stream.handle_event(ResponseHeaders(1, http.Response.make(200), end_stream=False))
            )
            await _finish_hooks(context, stream, pending)
            pending = list(stream.handle_event(ResponseEndOfMessage(1)))
            await _finish_hooks(context, stream, pending)
    assert managed.admission_state_for_tests() == (0, 0)
