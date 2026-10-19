"""Native WebSocket hooks, read backpressure, forwarding and cancellation."""

import asyncio
from unittest.mock import patch

import pytest
import wsproto
from mitmproxy import connection
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.proxy import events
from mitmproxy.proxy.context import Context
from mitmproxy.proxy.layers import websocket
from mitmproxy.proxy.server import ConnectionHandler, ConnectionIO
from mitmproxy.test import taddons
from mitmproxy.websocket import WebSocketData
from wsproto.connection import Connection as WsprotoConnection
from wsproto.events import Ping, TextMessage

import flow_metadata_keys as metadata_keys
import mitm_addon
import model_websocket_usage
import usage
import websocket_retention
from tests.model_provider_flow_helpers import make_openai_responses_websocket_flow
from tests.model_provider_websocket_helpers import openai_websocket_usage_frame
from tests.usage_helpers import assert_usage_event_rows
from tests.websocket_cooperative_helpers import costly_message


@pytest.mark.parametrize(
    "cancellation", ["none", "hook", "reader", "reader-before-hook", "continuation"]
)
@pytest.mark.parametrize("from_client", [False, True], ids=["server", "client"])
async def test_native_reader_joins_complete_message_hook(
    real_flow,
    tmp_path,
    monkeypatch,
    sync_usage_executor,
    usage_webhook_api,
    cancellation,
    from_client,
):
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    flow.websocket = WebSocketData()
    first_body = costly_message("client" if from_client else "terminal", 250_000)
    second_body = (
        b'{"type":"response.create"}' if from_client else openai_websocket_usage_frame("resp_later")
    )
    sender = WsprotoConnection(
        wsproto.ConnectionType.CLIENT if from_client else wsproto.ConnectionType.SERVER
    )
    prelude = (
        b'{"type":"response.create","generate":false}'
        if from_client
        else b'{"type":"response.output_text.delta","delta":"a"}'
    )
    first_wire = sender.send(TextMessage(prelude.decode())) + sender.send(
        TextMessage(first_body.decode())
    )
    monkeypatch.setattr(websocket_retention, "MAX_RETAINED_MESSAGE_BYTES", 1024)
    later_messages = 64
    second_wire = b"".join(
        sender.send(TextMessage(second_body.decode())) for _ in range(later_messages)
    )
    receiver = WsprotoConnection(
        wsproto.ConnectionType.SERVER if from_client else wsproto.ConnectionType.CLIENT
    )
    opposite_wire = receiver.send(Ping(b"x" * 100)) * 1024
    received: list[bytes] = []
    current_message = bytearray()
    read_sizes: list[int] = []
    peer_read_sizes: list[int] = []
    hook_tasks: list[asyncio.Task] = []
    first_hook_started = asyncio.Event()
    first_hook_finished = asyncio.Event()
    release_hook = asyncio.Event()
    release_continuation = asyncio.Event()
    continuation_started = asyncio.Event()
    terminal = asyncio.Event()
    peer_input_written = asyncio.Event()
    provider_payload_written = asyncio.Event()
    loop = asyncio.get_running_loop()
    heartbeat = loop.create_future()
    provider_done = loop.create_future()
    client_done = loop.create_future()
    reader_task = None
    reads_at_hook = 0
    first_hook = None
    active_hooks = 0
    peak_hooks = 0

    async def provider(reader, writer):
        try:
            writer.write(first_wire)
            await writer.drain()
            await first_hook_started.wait()
            if not cancellation.startswith("reader"):
                writer.write(second_wire)
                await writer.drain()
                provider_payload_written.set()
                if cancellation == "none":
                    await release_continuation.wait()
                    # Keep the peer alive until the queued opposite-direction
                    # control bytes have actually crossed the native layer.
                    await reader.readexactly(len(opposite_wire))
        finally:
            writer.close()
            await writer.wait_closed()
            provider_done.set_result(None)

    async def client(reader, writer):
        async def send_pending_peer_input():
            await first_hook_started.wait()
            # More than one native read is available on the opposite peer
            # while the current message's hook is held. Control frames are
            # valid in either direction and carry no model usage.
            writer.write(opposite_wire)
            await writer.drain()
            peer_input_written.set()

        peer_input = (
            asyncio.create_task(send_pending_peer_input()) if cancellation == "none" else None
        )
        try:
            while data := await reader.read(65535):
                receiver.receive_data(data)
                for event in receiver.events():
                    if isinstance(event, TextMessage):
                        current_message.extend(event.data.encode())
                        if event.message_finished:
                            received.append(bytes(current_message))
                            current_message.clear()
        finally:
            if peer_input is not None:
                peer_input.cancel()
                await asyncio.gather(peer_input, return_exceptions=True)
            writer.close()
            await writer.wait_closed()
            client_done.set_result(None)

    class ProviderReader(asyncio.StreamReader):
        async def read(self, n=-1):
            # This is the real native reader boundary, including after hook
            # inspection has yielded and while its continuation is held.
            assert metadata_keys.WEBSOCKET_INSPECTION not in flow.metadata
            if first_hook_started.is_set():
                assert first_hook_finished.is_set()
                assert cancellation != "none" or release_continuation.is_set()
            read_sizes.append(n)
            return await super().read(n)

    class PeerReader(asyncio.StreamReader):
        async def read(self, n=-1):
            if peer_read_sizes:
                assert metadata_keys.WEBSOCKET_INSPECTION not in flow.metadata
            peer_read_sizes.append(n)
            return await super().read(n)

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
        usage_webhook_api() as webhook,
    ):
        mitm_addon.responseheaders(flow)
        context = Context(flow.client_conn, addon_context.options)
        context.server = flow.server_conn
        context.client.state = connection.ConnectionState.OPEN
        context.server.state = connection.ConnectionState.OPEN
        origin = context.client if from_client else context.server
        destination = context.server if from_client else context.client

        class Handler(ConnectionHandler):
            async def handle_hook(self, hook):
                nonlocal first_hook, reads_at_hook
                if (
                    isinstance(hook, websocket.WebsocketMessageHook)
                    and flow.websocket is not None
                    and len(flow.websocket.messages[-1].content) > 1024
                    and first_hook is None
                ):
                    first_hook = hook
                    reads_at_hook = len(read_sizes)

                    def pulse():
                        heartbeat.set_result(metadata_keys.WEBSOCKET_INSPECTION in flow.metadata)
                        first_hook_started.set()
                        if cancellation == "reader":
                            assert reader_task is not None
                            reader_task.cancel()

                    loop.call_soon(pulse)
                    if cancellation == "hook":
                        task = asyncio.current_task()
                        assert task is not None
                        loop.call_soon(task.cancel)
                try:
                    await addon_context.master.addons.invoke_addon(mitm_addon, hook)
                    if hook is first_hook and cancellation == "none":
                        first_hook_finished.set()
                        await release_hook.wait()
                finally:
                    if hook is first_hook:
                        first_hook_finished.set()
                if isinstance(hook, websocket.WebsocketEndHook):
                    terminal.set()

            async def server_event(self, event):
                await super().server_event(event)
                if (
                    cancellation == "reader-before-hook"
                    and isinstance(event, events.DataReceived)
                    and flow.websocket is not None
                    and flow.websocket.messages
                    and len(flow.websocket.messages[-1].content) > 1024
                    and not first_hook_started.is_set()
                ):
                    first_hook_started.set()
                    heartbeat.set_result(True)
                    assert reader_task is not None
                    reader_task.cancel()
                if (
                    cancellation in ("none", "continuation")
                    and isinstance(event, events.HookCompleted)
                    and event.command is first_hook
                ):
                    continuation_started.set()
                    if cancellation == "continuation":
                        raise asyncio.CancelledError("cancelled after native hook resumed")
                    await release_continuation.wait()

            async def hook_task(self, hook):
                nonlocal active_hooks, peak_hooks
                task = asyncio.current_task()
                assert task is not None
                hook_tasks.append(task)
                active_hooks += 1
                peak_hooks = max(peak_hooks, active_hooks)
                try:
                    await super().hook_task(hook)
                finally:
                    active_hooks -= 1

        handler = Handler(context)
        handler.layer = websocket.WebsocketLayer(context, flow)
        async with (
            await asyncio.start_server(provider, "127.0.0.1", 0) as upstream,
            await asyncio.start_server(client, "127.0.0.1", 0) as downstream,
        ):
            reader = ProviderReader()
            protocol = asyncio.StreamReaderProtocol(reader)
            transport, _ = await loop.create_connection(
                lambda: protocol, "127.0.0.1", upstream.sockets[0].getsockname()[1]
            )
            provider_writer = asyncio.StreamWriter(transport, protocol, reader, loop)
            client_reader = PeerReader()
            client_protocol = asyncio.StreamReaderProtocol(client_reader)
            client_transport, _ = await loop.create_connection(
                lambda: client_protocol, "127.0.0.1", downstream.sockets[0].getsockname()[1]
            )
            client_writer = asyncio.StreamWriter(
                client_transport, client_protocol, client_reader, loop
            )
            handler.transports[origin] = ConnectionIO(reader=reader, writer=provider_writer)
            handler.transports[destination] = ConnectionIO(
                reader=client_reader, writer=client_writer
            )
            await handler.server_event(events.Start())
            # Join native start-hook completion before the TCP reader starts.
            await asyncio.gather(*hook_tasks)
            reader_task = asyncio.create_task(handler.handle_connection(origin))
            handler.transports[origin].handler = reader_task
            destination_task = asyncio.create_task(handler.handle_connection(destination))
            handler.transports[destination].handler = destination_task

            async def complete():
                assert await heartbeat
                if cancellation == "none":
                    await first_hook_finished.wait()
                    await provider_payload_written.wait()
                    await peer_input_written.wait()
                    assert len(read_sizes) == reads_at_hook
                    assert len(peer_read_sizes) == 1
                    release_hook.set()
                    await continuation_started.wait()
                    assert len(read_sizes) == reads_at_hook
                    assert len(peer_read_sizes) == 1
                    release_continuation.set()
                # EOF makes the native layer close both peers and cancel its
                # own reader; explicit reader cancellation follows that path.
                with pytest.raises(asyncio.CancelledError):
                    await reader_task
                await terminal.wait()

            try:
                await asyncio.wait_for(complete(), timeout=10)
                await asyncio.wait_for(client_done, timeout=5)
                usage.flush_usage_events(trigger="test")
            finally:
                release_hook.set()
                release_continuation.set()
                reader_task.cancel()
                await asyncio.gather(reader_task, return_exceptions=True)
                destination_task.cancel()
                await asyncio.gather(destination_task, return_exceptions=True)
                for task in hook_tasks:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*hook_tasks, return_exceptions=True)
                for task in hook_tasks:
                    if not task.cancelled():
                        task.result()
                provider_writer.close()
                client_writer.close()
                await provider_writer.wait_closed()
                await client_writer.wait_closed()
            await provider_done

    if not cancellation.startswith("reader"):
        assert received == [prelude, first_body, *([second_body] * later_messages)]
    assert peak_hooks <= 3
    assert metadata_keys.WEBSOCKET_INSPECTION not in flow.metadata
    assert not model_websocket_usage.is_enabled(flow)
    assert flow.websocket is not None
    assert flow.websocket.messages == []
    expected_rows = []
    if not from_client:
        if cancellation in ("none", "continuation"):
            expected_rows.extend([("gpt-5.5", "tokens.input", 9), ("gpt-5.5", "tokens.output", 4)])
        if not cancellation.startswith("reader"):
            expected_rows.extend([("gpt-5.5", "tokens.input", 10), ("gpt-5.5", "tokens.output", 4)])
    assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)
