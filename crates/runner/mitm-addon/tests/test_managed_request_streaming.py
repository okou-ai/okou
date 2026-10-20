"""Large uploads, policy partitions, storage waits and SSE-independent release."""

import asyncio
import hashlib
import json
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from mitmproxy import http
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.proxy.layers.http import GetHttpConnection, GetHttpConnectionCompleted, SendHttp
from mitmproxy.proxy.layers.http._events import (
    RequestData,
    RequestEndOfMessage,
    RequestHeaders,
    ResponseEndOfMessage,
    ResponseHeaders,
)
from mitmproxy.test import taddons

import managed_openrouter as managed
import managed_request_body
import mitm_addon
import request_streaming
from tests.managed_openrouter_helpers import PRESET, payload, sandbox
from tests.managed_request_transport_helpers import begin_upload, finish_hooks
from tests.request_handler_helpers import _write_registry


async def complete_upload(context, stream, flow):
    pending = await finish_hooks(context, stream, stream.handle_event(RequestEndOfMessage(1)))
    acquire = next(command for command in pending if isinstance(command, GetHttpConnection))
    return await finish_hooks(
        context,
        stream,
        stream.handle_event(GetHttpConnectionCompleted(acquire, (flow.server_conn, None))),
    )


@pytest.mark.parametrize("dialect", ["openai-completions", "openai-responses"])
@pytest.mark.parametrize("http2", [False, True])
async def test_large_body_is_spooled_replayed_exactly_and_freed_before_sse(
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
        for offset in range(0, len(body), 65535):
            observed = await finish_hooks(
                context, stream, stream.handle_event(RequestData(1, body[offset : offset + 65535]))
            )
            assert not any(
                isinstance(command, (SendHttp, GetHttpConnection)) for command in observed
            )
            assert not stream.request_body_buf
            assert flow.request.raw_content is None
            auth_fetch.assert_not_called()
        sent = await complete_upload(context, stream, flow)
        auth_fetch.assert_awaited_once()
        request_head = next(
            command.event
            for command in sent
            if isinstance(command, SendHttp) and isinstance(command.event, RequestHeaders)
        )
        assert request_head.end_stream is False
        assert request_head.request.headers["Content-Length"] == str(len(body))
        assert request_head.request.headers["Authorization"] == "Bearer managed-stream"
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
        assert flow.request.raw_content == b""
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
            await complete_upload(context, stream, flow)
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


@pytest.mark.parametrize("cancel_waiter", [False, True])
async def test_storage_waits_and_cancelled_waiter_recovers_without_resolving_auth(
    tmp_path,
    fake_firewall_headers,
    cancel_waiter,
):
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path))
    body = json.dumps(payload()).encode()
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        patch.object(
            managed_request_body.shutil,
            "disk_usage",
            return_value=SimpleNamespace(free=2 * len(body)),
        ),
        taddons.context(Proxyserver(), mitm_addon) as context,
        fake_firewall_headers() as auth_fetch,
    ):
        context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry)
        )
        first, first_flow = await begin_upload(context, len(body))
        second, second_flow = await begin_upload(context, len(body))
        await finish_hooks(context, first, first.handle_event(RequestData(1, body)))
        waiting = asyncio.create_task(
            finish_hooks(context, second, second.handle_event(RequestData(1, body)))
        )
        # A ready callback runs only after the receiving hook has yielded to
        # filesystem/admission work; no deadline is used as a synchronization.
        ready = asyncio.get_running_loop().create_future()
        asyncio.get_running_loop().call_soon(ready.set_result, None)
        await ready
        assert not waiting.done()
        auth_fetch.assert_not_called()
        if cancel_waiter:
            waiting.cancel()
            with pytest.raises(asyncio.CancelledError):
                await waiting
            assert second_flow.error is not None
        await complete_upload(context, first, first_flow)
        if not cancel_waiter:
            await asyncio.wait_for(waiting, 5)
            await complete_upload(context, second, second_flow)
        else:
            mitm_addon.error(second_flow)
        assert managed.admission_state_for_tests() == (0, 0)
        for stream, flow in ((first, first_flow), (second, second_flow)):
            if flow.error is None:
                await finish_hooks(
                    context,
                    stream,
                    stream.handle_event(ResponseHeaders(1, http.Response.make(200), False)),
                )
                await finish_hooks(context, stream, stream.handle_event(ResponseEndOfMessage(1)))


@pytest.mark.parametrize(
    "invalid", [None, "late-duplicate", "last-server-tool", "trailing-data", "incomplete"]
)
async def test_partitioned_unicode_and_every_tool_are_checked_before_auth(
    tmp_path,
    fake_firewall_headers,
    invalid,
):
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path))
    value = payload()
    value["messages"][0]["content"] = 'quote " slash \\ 中文 \U0001f642'
    value["tools"] = [
        {"type": "function", "function": {"name": "one"}},
        {"type": "function", "function": {"name": "two"}},
    ]
    if invalid == "last-server-tool":
        value["tools"][-1]["type"] = "openrouter:subagent"
    body = json.dumps(value, ensure_ascii=False).encode()
    if invalid == "late-duplicate":
        body = body[:-1] + b',"mo\\u0064el":"' + PRESET.encode() + b'"}'
    elif invalid == "trailing-data":
        body += b"{}"
    elif invalid == "incomplete":
        body = body[:-1]
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as context,
        fake_firewall_headers() as auth_fetch,
    ):
        context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry)
        )
        stream, flow = await begin_upload(context, len(body))
        for byte in body:
            await finish_hooks(context, stream, stream.handle_event(RequestData(1, bytes([byte]))))
            auth_fetch.assert_not_called()
        if invalid is None:
            await complete_upload(context, stream, flow)
            assert flow.error is None
            await finish_hooks(
                context,
                stream,
                stream.handle_event(ResponseHeaders(1, http.Response.make(200), False)),
            )
            await finish_hooks(context, stream, stream.handle_event(ResponseEndOfMessage(1)))
        else:
            observed = await finish_hooks(
                context, stream, stream.handle_event(RequestEndOfMessage(1))
            )
            assert not any(isinstance(command, GetHttpConnection) for command in observed)
            auth_fetch.assert_not_called()
            assert flow.response is not None
            assert flow.response.status_code == 403
        assert managed.admission_state_for_tests() == (0, 0)
