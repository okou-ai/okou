"""Native H2 windows, stream slots, resets and closure bound public uploads."""

import asyncio
from unittest.mock import patch

import pytest
from h2.config import H2Configuration
from h2.connection import H2Connection
from h2.events import DataReceived, RequestReceived, StreamEnded, StreamReset
from h2.settings import SettingCodes
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.proxy import commands, events
from mitmproxy.proxy.layers.http import SendHttp
from mitmproxy.proxy.layers.http._base import ReceiveHttp
from mitmproxy.proxy.layers.http._events import RequestData, RequestEndOfMessage, RequestHeaders
from mitmproxy.proxy.layers.http._http2 import Http2Client
from mitmproxy.test import taddons

import managed_openrouter as managed
import managed_request_body
import mitm_addon
from tests.managed_openrouter_helpers import PRESET, sandbox
from tests.managed_request_transport_helpers import begin_upload
from tests.request_handler_helpers import _write_registry


@pytest.mark.parametrize(
    "case",
    [
        "window",
        "stream-slots",
        "reset",
        "early-success",
        "early-error",
        "disconnect",
        "queued-disconnect",
        "queued-goaway",
        "queued-policy-error",
    ],
)
async def test_public_upload_waits_for_native_h2_capacity(
    tmp_path,
    fake_firewall_headers,
    case,
):
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path))
    raw = b'{"model":"' + PRESET.encode() + b'","messages":[{"content":"' + b"x" * 200_000 + b'"}]}'
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as context,
        fake_firewall_headers(),
    ):
        context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry)
        )
        stream, flow = await begin_upload(context, len(raw), http2=True)
        stored = managed_request_body.get(flow)
        assert stored is not None
        upstream = Http2Client(stream.context.fork())
        peer = H2Connection(H2Configuration(client_side=False, header_encoding=None))
        peer.initiate_connection()
        queued = case.startswith("queued-") or case == "stream-slots"
        if queued:
            peer.update_settings({SettingCodes.MAX_CONCURRENT_STREAMS: 0})
        received, heads, ended, resets = bytearray(), [], [], []
        paused = asyncio.Event()

        async def deliver(pending):
            queue = list(pending)
            while queue:
                command = queue.pop(0)
                if isinstance(command, ReceiveHttp):
                    queue.extend(stream.handle_event(command.event))
                elif isinstance(command, commands.StartHook):
                    await context.master.addons.invoke_addon(mitm_addon, command)
                    queue.extend(stream.handle_event(events.HookCompleted(command, None)))
                elif isinstance(command, SendHttp) and command.connection == flow.server_conn:
                    queue.extend(upstream.handle_event(command.event))
                elif isinstance(command, commands.SendData):
                    for item in peer.receive_data(command.data):
                        if isinstance(item, DataReceived):
                            received.extend(item.data)
                        elif isinstance(item, RequestReceived):
                            heads.append(item.headers)
                        elif isinstance(item, StreamEnded):
                            ended.append(item.stream_id)
                        elif isinstance(item, StreamReset):
                            resets.append(item.stream_id)

        await deliver(upstream.handle_event(events.Start()))
        await deliver(
            upstream.handle_event(events.DataReceived(flow.server_conn, peer.data_to_send()))
        )
        await deliver(upstream.handle_event(RequestHeaders(1, flow.request, end_stream=False)))

        async def produce():
            for offset in range(0, len(raw), 65535):
                if not stored.writable.is_set():
                    paused.set()
                await stored.wait_ready()
                if stored.closed:
                    return
                await deliver(stream.handle_event(RequestData(1, raw[offset : offset + 65535])))
            await stored.wait_ready()
            if not stored.closed:
                await deliver(stream.handle_event(RequestEndOfMessage(1)))

        producer = asyncio.create_task(produce())
        try:
            await asyncio.wait_for(paused.wait(), 5)
            assert not producer.done()
            buffered = sum(
                len(item.data)
                for queue in upstream.h2_conn.stream_buffers.values()
                for item in queue
            )
            assert buffered <= 65535
            assert stored.validator is not None
            assert not stored.tail
            assert not ended
            if queued:
                assert not received
                assert not heads
                assert sum(len(queue) for queue in upstream.stream_queue.values()) == 1
            else:
                assert len(received) == 65535
            if case == "window":
                peer.increment_flow_control_window(1_000_000)
                peer.increment_flow_control_window(1_000_000, stream_id=1)
            elif case == "stream-slots":
                peer.update_settings(
                    {
                        SettingCodes.MAX_CONCURRENT_STREAMS: 1,
                        SettingCodes.INITIAL_WINDOW_SIZE: 1_000_000,
                    }
                )
                peer.increment_flow_control_window(1_000_000)
            elif case == "reset":
                peer.reset_stream(1)
            elif case.startswith("early-"):
                peer.send_headers(
                    1,
                    [(b":status", b"200" if case == "early-success" else b"429")],
                    end_stream=True,
                )
            elif case == "queued-goaway":
                peer.close_connection()
            elif case == "queued-policy-error":
                # A body event already buffered with headers can be rejected
                # before an upstream stream slot has been allocated.
                await deliver(stream.handle_event(RequestData(1, b'{"provider":')))
            if case in {"disconnect", "queued-disconnect"}:
                await deliver(upstream.handle_event(events.ConnectionClosed(flow.server_conn)))
            elif case != "queued-policy-error":
                await deliver(
                    upstream.handle_event(
                        events.DataReceived(flow.server_conn, peer.data_to_send())
                    )
                )
            await asyncio.wait_for(producer, 5)
            if case in {"window", "stream-slots"}:
                assert received == raw
                assert ended == [1]
                assert flow.error is None
            elif case.startswith("early-"):
                assert flow.response is not None
                assert flow.response.status_code == (200 if case == "early-success" else 429)
                assert flow.error is None
                assert resets == [1]
            else:
                assert flow.error is not None
                assert not ended
            assert not upstream.h2_conn.stream_buffers
            assert not upstream.stream_queue
            assert managed.admission_state_for_tests() == (0, 0)
        finally:
            producer.cancel()
            await asyncio.gather(producer, return_exceptions=True)
            mitm_addon.error(flow)
