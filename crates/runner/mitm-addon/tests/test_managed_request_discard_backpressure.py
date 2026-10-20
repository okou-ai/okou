"""Rejected input must not enqueue empty payloads behind H2 backpressure."""

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
import request_streaming
from tests.managed_openrouter_helpers import PRESET, sandbox
from tests.managed_request_transport_helpers import begin_upload
from tests.request_handler_helpers import _write_registry


@pytest.mark.parametrize("capacity", ["stream-slots", "window"])
async def test_discarded_input_does_not_grow_blocked_native_h2_queues(
    tmp_path, fake_firewall_headers, capacity
):
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path))
    prefix = b'{"model":"' + PRESET.encode() + b'",'
    rejected = b'"provider":{}'
    discarded = b"x" * 4096
    chunks = 64
    length = len(prefix) + len(rejected) + chunks * len(discarded)
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as context,
        fake_firewall_headers(headers={"Authorization": "Bearer discard-backpressure"}),
    ):
        context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry)
        )
        stream, flow = await begin_upload(context, length, http2=True)
        stored = managed_request_body.get(flow)
        assert stored is not None
        upstream = Http2Client(stream.context.fork())
        peer = H2Connection(H2Configuration(client_side=False, header_encoding=None))
        peer.initiate_connection()
        peer.update_settings(
            {SettingCodes.MAX_CONCURRENT_STREAMS: 0}
            if capacity == "stream-slots"
            else {SettingCodes.INITIAL_WINDOW_SIZE: 0}
        )
        received, heads, ended, resets = bytearray(), [], [], []

        async def deliver(pending):
            queue = list(pending)
            while queue:
                command = queue.pop(0)
                if isinstance(command, ReceiveHttp):
                    queue.extend(stream.handle_event(command.event))
                elif isinstance(command, commands.StartHook):
                    await context.master.addons.invoke_addon(mitm_addon, command)
                    queue.extend(stream.handle_event(events.HookCompleted(command)))
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

        def queued_events():
            return sum(len(queue) for queue in upstream.stream_queue.values()) + sum(
                len(queue) for queue in upstream.h2_conn.stream_buffers.values()
            )

        try:
            await deliver(upstream.handle_event(events.Start()))
            await deliver(
                upstream.handle_event(events.DataReceived(flow.server_conn, peer.data_to_send()))
            )
            await deliver(upstream.handle_event(RequestHeaders(1, flow.request, False)))
            # Headers, this small prefix and the failing frame can already be
            # buffered within one native read before its reader waits on capacity.
            await deliver(stream.handle_event(RequestData(1, prefix)))
            pending_prefix = queued_events()
            assert pending_prefix > 0
            await deliver(stream.handle_event(RequestData(1, rejected)))
            assert stored.failure is not None
            assert stored.validator is None
            assert stored.tail == b""
            for _ in range(chunks):
                await stored.wait_ready()
                await deliver(stream.handle_event(RequestData(1, discarded)))
            assert stored.received == length
            assert request_streaming.streamed_request_size(flow) == length
            # Bytes alone miss a growing queue of zero-length RequestData or
            # SendH2Data objects. Discarding must leave native retention bounded.
            assert queued_events() == pending_prefix
            await deliver(stream.handle_event(RequestEndOfMessage(1)))
            assert flow.error is not None
            assert not flow.live
            assert received == b""
            assert ended == []
            if capacity == "window":
                assert len(heads) == 1
                assert dict(heads[0])[b"authorization"] == b"Bearer discard-backpressure"
                assert resets == [1]
                assert upstream.h2_conn.open_outbound_streams == 0
            else:
                assert heads == []
            assert not upstream.stream_queue
            assert not upstream.h2_conn.stream_buffers
            assert managed.admission_state_for_tests() == (0, 0)
        finally:
            mitm_addon.error(flow)
