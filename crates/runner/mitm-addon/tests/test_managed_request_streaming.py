"""Large public-stream uploads, exact bytes and SSE-independent release."""

import hashlib
import json
from unittest.mock import patch

import pytest
from mitmproxy import http
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.proxy.layers.http import SendHttp
from mitmproxy.proxy.layers.http._events import (
    RequestData,
    RequestEndOfMessage,
    ResponseEndOfMessage,
    ResponseHeaders,
)
from mitmproxy.test import taddons

import managed_openrouter as managed
import mitm_addon
import request_streaming
from tests.managed_openrouter_helpers import PRESET, payload, sandbox
from tests.managed_request_transport_helpers import begin_upload, finish_hooks
from tests.request_handler_helpers import _write_registry


@pytest.mark.parametrize("dialect", ["openai-completions", "openai-responses"])
@pytest.mark.parametrize("http2", [False, True])
async def test_large_body_is_streamed_exactly_and_freed_before_sse(
    tmp_path,
    fake_firewall_headers,
    dialect,
    http2,
):
    info = sandbox(tmp_path, dialect)
    info["captureNetworkBodies"] = True
    registry = _write_registry(tmp_path, sandbox_info=info)
    key = b"messages" if dialect == "openai-completions" else b"input"
    prefix = b'{"model":"' + PRESET.encode() + b'","' + key + b'":[{"content":"'
    body = prefix + b"x" * (33 * 1024 * 1024) + "\U0001f642".encode() + b'"}]}'
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as context,
        fake_firewall_headers(headers={"Authorization": "Bearer managed-stream"}) as auth_fetch,
    ):
        context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry)
        )
        stream, flow = await begin_upload(context, len(body), dialect=dialect, http2=http2)
        sent = []
        for offset in range(0, len(body), 65535):
            observed = await finish_hooks(
                context, stream, stream.handle_event(RequestData(1, body[offset : offset + 65535]))
            )
            sent.extend(observed)
            assert not stream.request_body_buf
            assert flow.request.raw_content is None
            auth_fetch.assert_awaited_once()
        assert (
            sum(
                len(c.event.data)
                for c in sent
                if isinstance(c, SendHttp) and isinstance(c.event, RequestData)
            )
            == len(body) - 1
        )
        sent.extend(
            await finish_hooks(context, stream, stream.handle_event(RequestEndOfMessage(1)))
        )
        auth_fetch.assert_awaited_once()
        assert flow.request.headers["Content-Length"] == str(len(body))
        assert flow.request.headers["Authorization"] == "Bearer managed-stream"
        digest = hashlib.sha256()
        size = 0
        for command in sent:
            if isinstance(command, SendHttp) and isinstance(command.event, RequestData):
                assert len(command.event.data) <= 64 * 1024
                size += len(command.event.data)
                digest.update(command.event.data)
        assert size == len(body)
        assert digest.digest() == hashlib.sha256(body).digest()
        assert managed.admission_state_for_tests() == (0, 0)
        assert flow.request.raw_content is None
        assert request_streaming.streamed_request_size(flow) == len(body)
        captured = request_streaming.captured_request_stream_body(flow)
        assert captured is not None
        assert captured.truncated
        assert len(captured.buffer) == 64 * 1024
        await finish_hooks(
            context,
            stream,
            stream.handle_event(
                ResponseHeaders(
                    1,
                    http.Response.make(200, headers={"Content-Type": "text/event-stream"}),
                    False,
                )
            ),
        )
        assert flow.live
        assert managed.admission_state_for_tests() == (0, 0)
        await finish_hooks(context, stream, stream.handle_event(ResponseEndOfMessage(1)))


async def test_more_than_sixteen_managed_responses_do_not_hold_upload_admission(
    tmp_path,
    fake_firewall_headers,
):
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path))
    body = json.dumps(payload()).encode()
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as context,
        fake_firewall_headers(),
    ):
        context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry)
        )
        uploads = [await begin_upload(context, len(body)) for _ in range(20)]
        for stream, flow in uploads:
            await finish_hooks(context, stream, stream.handle_event(RequestData(1, body)))
            await finish_hooks(context, stream, stream.handle_event(RequestEndOfMessage(1)))
            await finish_hooks(
                context,
                stream,
                stream.handle_event(
                    ResponseHeaders(
                        1,
                        http.Response.make(200, headers={"Content-Type": "text/event-stream"}),
                        False,
                    )
                ),
            )
            assert flow.error is None
            assert flow.live
        assert managed.admission_state_for_tests() == (0, 0)
        for stream, _flow in uploads:
            await finish_hooks(context, stream, stream.handle_event(ResponseEndOfMessage(1)))
