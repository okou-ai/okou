"""Real HTTP/2 flow control and stream admission must bound replay queues."""

import asyncio
from unittest.mock import patch

import pytest
from h2.config import H2Configuration
from h2.connection import H2Connection
from h2.events import DataReceived, RequestReceived, StreamEnded
from h2.settings import SettingCodes
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.proxy import commands, events
from mitmproxy.proxy.layers.http import (
    GetHttpConnection,
    GetHttpConnectionCompleted,
    SendHttp,
)
from mitmproxy.proxy.layers.http._base import ReceiveHttp
from mitmproxy.proxy.layers.http._events import RequestData, RequestEndOfMessage, RequestHeaders
from mitmproxy.proxy.layers.http._http2 import Http2Client
from mitmproxy.test import taddons

import managed_openrouter as managed
import managed_request_body
import mitm_addon
from tests.managed_openrouter_helpers import PRESET, sandbox
from tests.managed_request_transport_helpers import begin_upload, finish_hooks
from tests.request_handler_helpers import _write_registry


@pytest.mark.parametrize(
    "blocked_by", ["window", "stream-slots", "reset", "early-error", "early-data"]
)
async def test_http2_replay_waits_for_protocol_capacity_without_queuing_the_body(
    tmp_path,
    fake_firewall_headers,
    blocked_by,
):
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path))
    body = (
        b'{"model":"' + PRESET.encode() + b'","messages":[{"content":"' + b"x" * 200_000 + b'"}]}'
    )
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as context,
        fake_firewall_headers(),
    ):
        context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry)
        )
        stream, flow = await begin_upload(context, len(body), http2=True)
        for offset in range(0, len(body), 65535):
            await finish_hooks(
                context, stream, stream.handle_event(RequestData(1, body[offset : offset + 65535]))
            )
        pending = await finish_hooks(context, stream, stream.handle_event(RequestEndOfMessage(1)))
        acquire = next(command for command in pending if isinstance(command, GetHttpConnection))
        upstream = Http2Client(stream.context.fork())
        peer = H2Connection(H2Configuration(client_side=False, header_encoding=None))
        peer.initiate_connection()
        if blocked_by == "stream-slots":
            peer.update_settings(
                {
                    SettingCodes.MAX_CONCURRENT_STREAMS: 0,
                    SettingCodes.INITIAL_WINDOW_SIZE: 1_000_000,
                }
            )
            peer.increment_flow_control_window(1_000_000)
        received = bytearray()
        headers, ended = [], []
        downstream = []

        def deliver(native_commands):
            for command in native_commands:
                if isinstance(command, ReceiveHttp):
                    assert not list(stream.handle_event(command.event))
                elif isinstance(command, commands.SendData):
                    for item in peer.receive_data(command.data):
                        if isinstance(item, DataReceived):
                            received.extend(item.data)
                        elif isinstance(item, RequestReceived):
                            headers.append(item.headers)
                        elif isinstance(item, StreamEnded):
                            ended.append(item.stream_id)

        deliver(upstream.handle_event(events.Start()))
        deliver(upstream.handle_event(events.DataReceived(flow.server_conn, peer.data_to_send())))
        paused = asyncio.Event()

        async def relay(pending_commands):
            queue = list(pending_commands)
            while queue:
                command = queue.pop(0)
                if isinstance(command, commands.StartHook):
                    await context.master.addons.invoke_addon(mitm_addon, command)
                    queue.extend(stream.handle_event(events.HookCompleted(command, None)))
                elif isinstance(command, SendHttp):
                    if command.connection != flow.server_conn:
                        downstream.append(command.event)
                        continue
                    deliver(upstream.handle_event(command.event))
                    if isinstance(command.event, (RequestData, RequestHeaders)):
                        stored = managed_request_body.get(flow)
                        assert stored is not None
                        if not stored.replay_ready.is_set():
                            paused.set()

        replay = asyncio.create_task(
            relay(
                stream.handle_event(GetHttpConnectionCompleted(acquire, (flow.server_conn, None)))
            )
        )
        try:
            await asyncio.wait_for(paused.wait(), 5)
            assert not replay.done()
            assert not ended
            stored = managed_request_body.get(flow)
            assert stored is not None
            assert stored.file is not None
            assert stored.worker is None
            assert managed.admission_state_for_tests() == (1, len(body))
            if blocked_by in {"window", "reset", "early-error", "early-data"}:
                assert stored.file.tell() == 64 * 1024
                assert len(received) == 65535
                buffered = sum(
                    len(item.data)
                    for queue in upstream.h2_conn.stream_buffers.values()
                    for item in queue
                )
                assert buffered <= 64 * 1024
                if blocked_by == "reset":
                    peer.reset_stream(1)
                elif blocked_by == "early-error":
                    peer.send_headers(1, [(b":status", b"429")], end_stream=True)
                elif blocked_by == "early-data":
                    peer.send_headers(1, [(b":status", b"200")])
                    for _ in range(5):
                        peer.send_data(1, b"e" * 16384)
                else:
                    peer.increment_flow_control_window(1_000_000)
                    peer.increment_flow_control_window(1_000_000, stream_id=1)
            else:
                assert stored.file.tell() == 0
                assert not received
                assert not headers
                assert sum(len(queue) for queue in upstream.stream_queue.values()) == 1
                peer.update_settings({SettingCodes.MAX_CONCURRENT_STREAMS: 1})
            deliver(
                upstream.handle_event(events.DataReceived(flow.server_conn, peer.data_to_send()))
            )
            await asyncio.wait_for(replay, 5)
            if blocked_by in {"reset", "early-error", "early-data"}:
                assert len(received) == 65535
                assert not ended
                if blocked_by == "early-error":
                    assert flow.response is not None
                    assert flow.response.status_code == 429
                    assert flow.error is None
                else:
                    assert flow.error is not None
            else:
                assert received == body
                assert ended == [1]
            assert len(headers) == 1
            assert not upstream.h2_conn.stream_buffers
            assert managed.admission_state_for_tests() == (0, 0)
        finally:
            replay.cancel()
            await asyncio.gather(replay, return_exceptions=True)
            mitm_addon.error(flow)
