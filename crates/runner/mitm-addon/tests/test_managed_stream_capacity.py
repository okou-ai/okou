"""Pinned H2 native queues, logical IDs, discard and terminal ownership."""

import asyncio
from collections import deque
from unittest.mock import patch

import pytest
from h2.config import H2Configuration
from h2.connection import H2Connection
from h2.events import DataReceived, StreamEnded, StreamReset
from h2.settings import SettingCodes
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.proxy import commands, events
from mitmproxy.proxy.layers.http import (
    GetHttpConnection,
    GetHttpConnectionCompleted,
    HttpStream,
    SendHttp,
)
from mitmproxy.proxy.layers.http._base import ReceiveHttp
from mitmproxy.proxy.layers.http._events import (
    RequestData,
    RequestEndOfMessage,
    RequestHeaders,
    ResponseData,
)
from mitmproxy.proxy.layers.http._hooks import HttpRequestHeadersHook
from mitmproxy.proxy.layers.http._http2 import Http2Client
from mitmproxy.test import taddons

import managed_upload
import mitm_addon
from tests.managed_openrouter_helpers import PRESET, request, sandbox
from tests.managed_wire_helpers import WireSession
from tests.request_handler_helpers import _write_registry
from tests.upstream_connection_helpers import mark_connected_tls_upstream


class CapacitySession:
    logical = 17

    @property
    def upload(self) -> managed_upload.Upload:
        assert self._upload is not None
        return self._upload

    def __init__(self, context):
        self.context = context
        peer = WireSession(context)
        self.stream = HttpStream(peer.native.context.fork(), self.logical)
        list(self.stream.handle_event(events.Start()))
        self.client = Http2Client(self.stream.context.fork())
        self.provider = H2Connection(H2Configuration(client_side=False))
        self.received = bytearray()
        self.response = bytearray()
        self.ended, self.reset = [], []

    async def dispatch(self, batch, *, hold=False):
        pending, held = deque(batch), []
        while pending:
            command = pending.popleft()
            if isinstance(command, commands.StartHook):
                if isinstance(command, HttpRequestHeadersHook):
                    self.flow = command.flow
                    mark_connected_tls_upstream(
                        self.flow,
                        sni="openrouter.ai",
                        server_address=("openrouter.ai", 443),
                        peername=("104.18.32.47", 443),
                    )
                await self.context.master.addons.invoke_addon(mitm_addon, command)
                pending.extend(self.stream.handle_event(events.HookCompleted(command)))
            elif isinstance(command, GetHttpConnection):
                pending.extend(
                    self.stream.handle_event(
                        GetHttpConnectionCompleted(command, (self.flow.server_conn, None))
                    )
                )
            elif isinstance(command, ReceiveHttp):
                pending.extend(self.stream.handle_event(command.event))
            elif isinstance(command, SendHttp):
                if command.connection is self.flow.server_conn:
                    if hold:
                        held.append(command)
                    else:
                        pending.extend(self.client.handle_event(command.event))
                elif isinstance(command.event, ResponseData):
                    self.response.extend(command.event.data)
            elif isinstance(command, commands.SendData):
                for item in self.provider.receive_data(command.data):
                    if isinstance(item, DataReceived):
                        self.received.extend(item.data)
                    elif isinstance(item, StreamEnded):
                        self.ended.append(item.stream_id)
                    elif isinstance(item, StreamReset):
                        self.reset.append(item.stream_id)
        return held

    async def start(self, req, capacity):
        headers = await self.dispatch(
            self.stream.handle_event(RequestHeaders(self.logical, req, False)), hold=True
        )
        self.provider.initiate_connection()
        self.provider.update_settings(
            {SettingCodes.MAX_CONCURRENT_STREAMS: 0}
            if capacity == "slots"
            else {SettingCodes.INITIAL_WINDOW_SIZE: 0}
        )
        await self.dispatch(self.client.handle_event(events.Start()))
        await self.update()
        await self.dispatch(headers)
        self._upload = managed_upload.get(self.flow)
        assert self._upload is not None
        if capacity == "slots":
            assert not self.upload.ready.is_set()

    async def update(self):
        await self.dispatch(
            self.client.handle_event(
                events.DataReceived(self.flow.server_conn, self.provider.data_to_send())
            )
        )

    async def send(self, raw, *, final=False):
        await self.dispatch(self.stream.handle_event(RequestData(self.logical, raw)))
        if final:
            await self.dispatch(self.stream.handle_event(RequestEndOfMessage(self.logical)))

    def queued(self):
        return sum(len(q) for q in self.client.stream_queue.values()) + sum(
            len(q) for q in self.client.h2_conn.stream_buffers.values()
        )


@pytest.mark.parametrize("capacity", ["slots", "window"])
@pytest.mark.parametrize("ending", ["grant", "disconnect", "goaway", "early"])
async def test_native_h2_readiness_and_terminal_progress(
    tmp_path, real_flow, fake_firewall_headers, capacity, ending
):
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path))
    body = b'{"model":"' + PRESET.encode() + b'","messages":[{"content":"' + b"x" * 70_000 + b'"}]}'
    req = request(real_flow, body).request
    req.raw_content = None
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as ctx,
        fake_firewall_headers(),
    ):
        ctx.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry)
        )
        session = CapacitySession(ctx)
        await session.start(req, capacity)
        # A body event can already share the native read that delivered headers.
        await session.send(body[:60_000])
        pending_count = session.queued()
        assert pending_count > 0
        waiting = asyncio.Event()

        async def rest():
            waiting.set()
            await session.upload.ready.wait()
            if session.upload.phase is not managed_upload.Phase.CLOSED:
                await session.send(body[60_000:], final=True)

        producer = asyncio.create_task(rest())
        try:
            await waiting.wait()
            assert not producer.done()
            assert session.queued() == pending_count
            if ending == "grant" or (ending == "early" and capacity == "slots"):
                session.provider.update_settings(
                    {
                        SettingCodes.MAX_CONCURRENT_STREAMS: 1,
                        SettingCodes.INITIAL_WINDOW_SIZE: 0 if ending == "early" else 1_000_000,
                    }
                )
                session.provider.increment_flow_control_window(1_000_000)
                await session.update()
            if ending == "early":
                session.provider.send_headers(1, [(b":status", b"429"), (b"content-length", b"3")])
                session.provider.send_data(1, b"err", end_stream=True)
                await session.update()
            elif ending == "disconnect":
                await session.dispatch(
                    session.client.handle_event(events.ConnectionClosed(session.flow.server_conn))
                )
            elif ending == "goaway":
                session.provider.close_connection()
                await session.update()
            await asyncio.wait_for(producer, 5)
            if ending == "grant":
                assert session.received == body
                assert session.ended == [1]
                assert session.flow.error is None
                assert not session.upload.transport_pending
                mitm_addon.error(session.flow)
            elif ending == "early":
                assert session.response == b"err"
                assert session.flow.response is not None
                assert session.flow.response.status_code == 429
                assert session.flow.error is None
                assert session.reset == [1]
            else:
                assert session.flow.error is not None
                assert not session.ended
            assert not session.client.stream_queue
            assert not session.client.h2_conn.stream_buffers
            assert managed_upload.get(session.flow) is None
        finally:
            producer.cancel()
            await asyncio.gather(producer, return_exceptions=True)
            mitm_addon.error(session.flow)


@pytest.mark.parametrize("capacity", ["slots", "window"])
async def test_rejected_discard_produces_no_queued_data_events(
    tmp_path, real_flow, fake_firewall_headers, capacity
):
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path))
    prefix = b'{"model":"' + PRESET.encode() + b'",'
    bad = b'"provider":{}'
    remaining = b"x" * 1024
    req = request(real_flow).request
    req.headers["Content-Length"] = str(len(prefix) + len(bad) + 64 * len(remaining))
    req.raw_content = None
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as ctx,
        fake_firewall_headers(),
    ):
        ctx.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry)
        )
        session = CapacitySession(ctx)
        await session.start(req, capacity)
        await session.send(prefix)
        accepted = session.queued()
        await session.send(bad)
        assert session.upload.failure is not None
        assert session.upload.validator is None
        assert session.upload.tail == b""
        for _ in range(64):
            await session.upload.ready.wait()
            await session.send(remaining)
        assert session.queued() == accepted
        await session.dispatch(session.stream.handle_event(RequestEndOfMessage(session.logical)))
        assert session.flow.error is not None
        assert not session.ended
        assert not session.client.stream_queue
        assert not session.client.h2_conn.stream_buffers
        assert managed_upload.get(session.flow) is None
