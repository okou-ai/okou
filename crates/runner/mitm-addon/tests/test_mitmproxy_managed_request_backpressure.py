"""Real pinned TCP readers/writers must join managed receive and replay work."""

import asyncio
from unittest.mock import patch

import pytest
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.proxy import commands, events, layer
from mitmproxy.proxy.layers.http import (
    DropStream,
    GetHttpConnection,
    GetHttpConnectionCompleted,
    SendHttp,
)
from mitmproxy.proxy.layers.http._events import RequestData, RequestEndOfMessage, RequestHeaders
from mitmproxy.proxy.layers.http._hooks import HttpRequestHook
from mitmproxy.proxy.server import ConnectionHandler, ConnectionIO
from mitmproxy.test import taddons

import managed_openrouter as managed
import managed_request_body
import managed_request_transport
import mitm_addon
from tests.managed_openrouter_helpers import PRESET, sandbox
from tests.managed_request_transport_helpers import begin_upload
from tests.request_handler_helpers import _write_registry


class _ManagedPeerLayer(layer.Layer):
    """Fixture sockets around the real HttpStream; framing has separate coverage."""

    def __init__(self, context, stream, length, sent, heads):
        super().__init__(context)
        self.stream = stream
        self.remaining = length
        self.sent = sent
        self.heads = heads

    def _handle_event(self, event):
        if isinstance(event, events.ConnectionClosed):
            return
        if isinstance(event, events.DataReceived):
            self.remaining -= len(event.data)
            incoming: list[events.Event] = [RequestData(1, event.data)]
            if self.remaining == 0:
                incoming.append(RequestEndOfMessage(1))
        else:
            incoming = [event]
        for item in incoming:
            queue = list(self.stream.handle_event(item))
            while queue:
                command = queue.pop(0)
                if isinstance(command, GetHttpConnection):
                    queue.extend(
                        self.stream.handle_event(
                            GetHttpConnectionCompleted(
                                command,
                                (self.stream.flow.server_conn, None),
                            )
                        )
                    )
                elif isinstance(command, SendHttp):
                    if isinstance(command.event, RequestHeaders):
                        self.heads.append(command.event)
                    elif isinstance(command.event, RequestData):
                        yield commands.SendData(self.context.server, command.event.data)
                    elif isinstance(command.event, RequestEndOfMessage):
                        self.sent.set()
                elif not isinstance(command, DropStream):
                    yield command


@pytest.mark.parametrize("cancel_stage", [None, "receive", "auth", "replay"])
async def test_native_reader_and_writer_backpressure_and_hook_cancellation(
    tmp_path,
    fake_firewall_headers,
    cancel_stage,
):
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path))
    body = (
        b'{"model":"' + PRESET.encode() + b'","messages":[{"content":"' + b"x" * 180_000 + b'"}]}'
    )
    chunks = [body[offset : offset + 50_000] for offset in range(0, len(body), 50_000)]
    loop = asyncio.get_running_loop()
    receive_entered, release_receive = asyncio.Event(), asyncio.Event()
    replay_entered, release_replay = asyncio.Event(), asyncio.Event()
    auth_entered = asyncio.Event()
    send_rest, close_guest, close_provider = asyncio.Event(), asyncio.Event(), asyncio.Event()
    guest_done, provider_done = loop.create_future(), loop.create_future()
    uploaded, provider_received = asyncio.Event(), asyncio.Event()
    read_sizes, heads, hook_tasks = [], [], []
    stage_tasks = {}
    received = bytearray()

    async def guest(_reader, writer):
        try:
            writer.write(chunks[0])
            await writer.drain()
            await send_rest.wait()
            for chunk in chunks[1:]:
                writer.write(chunk)
            await writer.drain()
            await close_guest.wait()
        finally:
            writer.close()
            await writer.wait_closed()
            guest_done.set_result(None)

    async def provider(reader, writer):
        try:
            while len(received) < len(body):
                chunk = await reader.read(65535)
                if not chunk:
                    break
                received.extend(chunk)
            if len(received) == len(body):
                provider_received.set()
            await close_provider.wait()
        finally:
            writer.close()
            await writer.wait_closed()
            provider_done.set_result(None)

    class GuestReader(asyncio.StreamReader):
        async def read(self, n=-1):
            assert stored is not None
            index = len(read_sizes)
            read_sizes.append(n)
            if index < len(chunks):
                if index:
                    assert release_receive.is_set() or (
                        cancel_stage == "receive" and flow.error is not None and stored.closed
                    )
                return await super().readexactly(len(chunks[index]))
            assert uploaded.is_set() or cancel_stage is not None
            return await super().read(n)

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
        fake_firewall_headers() as auth_fetch,
    ):
        addon_context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry)
        )
        stream, flow = await begin_upload(addon_context, len(body))
        stored = managed_request_body.get(flow)
        assert stored is not None
        context = stream.context

        class Handler(ConnectionHandler):
            async def handle_hook(self, hook):
                if isinstance(hook, HttpRequestHook) and cancel_stage == "auth":
                    auth_entered.set()
                    await asyncio.Event().wait()
                await addon_context.master.addons.invoke_addon(mitm_addon, hook)
                if (
                    isinstance(hook, managed_request_transport.ManagedRequestBodyHook)
                    and hook.stage == "receive"
                    and not receive_entered.is_set()
                ):
                    receive_entered.set()
                    await release_receive.wait()

            async def hook_task(self, hook):
                task = asyncio.current_task()
                hook_tasks.append(task)
                if isinstance(hook, managed_request_transport.ManagedRequestBodyHook):
                    stage_tasks.setdefault(hook.stage, task)
                elif isinstance(hook, HttpRequestHook):
                    stage_tasks.setdefault("auth", task)
                await super().hook_task(hook)

        handler = Handler(context)
        handler.layer = _ManagedPeerLayer(context, stream, len(body), uploaded, heads)
        async with (
            await asyncio.start_server(guest, "127.0.0.1", 0) as guest_server,
            await asyncio.start_server(provider, "127.0.0.1", 0) as provider_server,
        ):
            reader = GuestReader()
            protocol = asyncio.StreamReaderProtocol(reader)
            transport, _ = await loop.create_connection(
                lambda: protocol, "127.0.0.1", guest_server.sockets[0].getsockname()[1]
            )
            guest_writer = asyncio.StreamWriter(transport, protocol, reader, loop)
            provider_reader, provider_writer = await asyncio.open_connection(
                "127.0.0.1", provider_server.sockets[0].getsockname()[1]
            )
            original_drain = provider_writer.drain

            async def drain_provider():
                if stored.validated and not stored.closed:
                    replay_entered.set()
                    await release_replay.wait()
                await original_drain()

            handler.transports[context.client] = ConnectionIO(reader=reader, writer=guest_writer)
            handler.transports[context.server] = ConnectionIO(
                reader=provider_reader, writer=provider_writer
            )
            reader_task = asyncio.create_task(handler.handle_connection(context.client))
            handler.transports[context.client].handler = reader_task

            async def exercise():
                await receive_entered.wait()
                send_rest.set()
                pulse = loop.create_future()
                loop.call_soon(pulse.set_result, None)
                await pulse
                assert read_sizes == [65535]
                assert not received
                assert not heads
                auth_fetch.assert_not_called()
                if cancel_stage == "receive":
                    stage_tasks["receive"].cancel()
                    await asyncio.gather(stage_tasks["receive"], return_exceptions=True)
                    assert flow.error is not None
                    return
                release_receive.set()
                if cancel_stage == "auth":
                    await auth_entered.wait()
                    auth_fetch.assert_not_called()
                    stage_tasks["auth"].cancel()
                    await asyncio.gather(stage_tasks["auth"], return_exceptions=True)
                    assert flow.error is not None
                    return
                await replay_entered.wait()
                assert read_sizes == [65535] * len(chunks)
                assert not received
                assert len(heads) == 1
                assert not heads[0].end_stream
                assert flow.request.raw_content == b""
                assert not stream.request_body_buf
                if cancel_stage == "replay":
                    stage_tasks["replay"].cancel()
                    await asyncio.gather(stage_tasks["replay"], return_exceptions=True)
                    assert flow.error is not None
                    return
                release_replay.set()
                await uploaded.wait()
                await provider_received.wait()
                assert received == body
                assert managed.admission_state_for_tests() == (0, 0)
                assert stored.file is None
                assert stored.upload_done.is_set()

            try:
                with patch.object(provider_writer, "drain", drain_provider):
                    await asyncio.wait_for(exercise(), 10)
                assert managed.admission_state_for_tests() == (0, 0)
            finally:
                release_receive.set()
                release_replay.set()
                send_rest.set()
                close_guest.set()
                close_provider.set()
                reader_task.cancel()
                await asyncio.gather(reader_task, return_exceptions=True)
                for task in hook_tasks:
                    if task is not None:
                        task.cancel()
                await asyncio.gather(
                    *[task for task in hook_tasks if task is not None], return_exceptions=True
                )
                mitm_addon.error(flow)
                guest_writer.close()
                provider_writer.close()
                await guest_writer.wait_closed()
                await provider_writer.wait_closed()
                for task in [reader_task, *hook_tasks]:
                    if task is not None and task.done() and not task.cancelled():
                        task.result()
            await asyncio.wait_for(guest_done, 5)
            await asyncio.wait_for(provider_done, 5)
    if cancel_stage in {"receive", "auth"}:
        auth_fetch.assert_not_called()
        assert not received
        assert not heads
