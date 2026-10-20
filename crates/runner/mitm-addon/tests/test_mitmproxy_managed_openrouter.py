"""Native streamed requests forward prefixes and abort rejected documents."""

import asyncio
import json
from pathlib import Path
from unittest.mock import patch

import pytest
from mitmproxy import http
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.proxy.layers.http import SendHttp
from mitmproxy.proxy.layers.http._events import (
    RequestData,
    RequestEndOfMessage,
    RequestProtocolError,
    RequestTrailers,
    ResponseEndOfMessage,
    ResponseHeaders,
    ResponseProtocolError,
)
from mitmproxy.test import taddons

import managed_openrouter as managed
import managed_request_body
import mitm_addon
import request_streaming
from logging_utils import flush_log_path
from tests.managed_openrouter_helpers import PRESET, sandbox
from tests.managed_request_transport_helpers import begin_upload, finish_hooks
from tests.request_handler_helpers import _write_registry


@pytest.mark.parametrize("dialect", ["openai-completions", "openai-responses"])
@pytest.mark.parametrize("http2", [False, True])
@pytest.mark.parametrize(
    "case",
    [
        "late-override",
        "duplicate",
        "trailers",
        "incomplete",
        "trailing",
        "accepted",
        "invalid-utf8",
        "missing-model",
        "last-byte",
        "nonfinite",
        "changed-policy",
        "short",
        "long",
    ],
)
async def test_public_prefix_forwarding_and_native_terminal_cancellation(
    tmp_path,
    fake_firewall_headers,
    dialect,
    http2,
    case,
):
    info = sandbox(tmp_path, dialect)
    check_capture = case == "late-override" and dialect == "openai-completions" and not http2
    if check_capture:
        info["captureNetworkBodies"] = True
    registry = _write_registry(tmp_path, sandbox_info=info)
    key = b"messages" if dialect == "openai-completions" else b"input"
    prefix = b'{"' + key + b'":[{"content":"private-prompt-canary' + b"x" * 100_000
    suffix = b'"}],"model":"' + PRESET.encode() + b'"'
    if case == "late-override":
        suffix += b',"provider":{}'
    elif case == "duplicate":
        suffix += b',"model":"' + PRESET.encode() + b'"'
    elif case == "missing-model":
        suffix = b'"}]'
    elif case == "nonfinite":
        suffix += b',"temperature":1e999'
    suffix += b"}"
    if case == "incomplete":
        suffix = suffix[:-1]
    elif case == "trailing":
        suffix += b"{}"
    elif case == "last-byte":
        suffix = suffix[:-1] + b"]"
    elif case == "invalid-utf8":
        prefix += b"\xff"
    body = prefix + suffix
    declared = len(body) + (1 if case == "short" else -1 if case == "long" else 0)
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as context,
        fake_firewall_headers(headers={"Authorization": "Bearer public-stream"}) as auth,
    ):
        context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry)
        )
        stream, flow = await begin_upload(context, declared, dialect=dialect, http2=http2)
        auth.assert_awaited_once()
        assert callable(flow.request.stream)
        first = prefix[:80_000]
        observed = await finish_hooks(context, stream, stream.handle_event(RequestData(1, first)))
        if check_capture:
            captured = request_streaming.captured_request_stream_body(flow)
            assert captured is not None
            assert b"private-prompt-canary" in captured.buffer
        assert (
            b"".join(
                c.event.data
                for c in observed
                if isinstance(c, SendHttp)
                and c.connection == flow.server_conn
                and isinstance(c.event, RequestData)
            )
            == first
        )
        for fragment in (prefix[80_000:], suffix):
            observed.extend(
                await finish_hooks(context, stream, stream.handle_event(RequestData(1, fragment)))
            )
            if flow.error is not None:
                break
        if flow.error is None and case == "trailers":
            observed.extend(
                await finish_hooks(
                    context,
                    stream,
                    stream.handle_event(
                        RequestTrailers(1, http.Headers([(b"x-openrouter-preset", b"other")]))
                    ),
                )
            )
        if case == "changed-policy":
            info["piModelConfig"]["model"] = "@preset/replaced"
            _write_registry(tmp_path, sandbox_info=info)
        stored = managed_request_body.get(flow)
        assert stored is not None
        if stored.failure is not None:
            assert stored.validator is None
            assert stored.tail == b""
            assert flow.error is None
            assert not any(
                isinstance(c, SendHttp) and isinstance(c.event, RequestProtocolError)
                for c in observed
            )
        if flow.error is None:
            observed.extend(
                await finish_hooks(context, stream, stream.handle_event(RequestEndOfMessage(1)))
            )
        outbound = [
            c.event
            for c in observed
            if isinstance(c, SendHttp) and c.connection == flow.server_conn
        ]
        forwarded = b"".join(c.data for c in outbound if isinstance(c, RequestData))
        if case == "accepted":
            assert flow.error is None
            assert forwarded == body
            assert len([c for c in outbound if isinstance(c, RequestEndOfMessage)]) == 1
            await finish_hooks(
                context,
                stream,
                stream.handle_event(ResponseHeaders(1, http.Response.make(200), False)),
            )
            await finish_hooks(context, stream, stream.handle_event(ResponseEndOfMessage(1)))
        else:
            assert flow.error is not None
            assert not any(isinstance(c, RequestEndOfMessage) for c in outbound)
            assert any(isinstance(c, RequestProtocolError) for c in outbound)
            assert any(
                isinstance(c, SendHttp) and isinstance(c.event, ResponseProtocolError)
                for c in observed
            )
            assert len(forwarded) < declared
            if check_capture:
                path = Path(info["networkLogPath"])
                assert await asyncio.to_thread(flush_log_path, str(path))
                text = await asyncio.to_thread(path.read_text)
                records = [json.loads(line) for line in text.splitlines()]
                assert len(records) == 1
                assert records[0]["request_size"] == len(body)
                assert records[0]["request_body_truncated"] is True
                assert "request_body" not in records[0]
                assert "private-prompt-canary" not in text
        assert not stream.request_body_buf
        assert flow.request.raw_content is None
        assert managed.admission_state_for_tests() == (0, 0)
