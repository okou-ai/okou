"""Real pinned read loop, HTTP stream hooks and response inspection backpressure."""

import asyncio
import gzip
from unittest.mock import patch

import pytest
from mitmproxy import connection
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.proxy import commands, events, layer
from mitmproxy.proxy.context import Context
from mitmproxy.proxy.layers.http import DropStream, HttpStream, SendHttp
from mitmproxy.proxy.layers.http._events import ResponseData, ResponseEndOfMessage
from mitmproxy.proxy.layers.http._hooks import HttpErrorHook, HttpResponseHook
from mitmproxy.proxy.server import ConnectionHandler, ConnectionIO
from mitmproxy.test import taddons

import flow_metadata_keys as metadata_keys
import mitm_addon
import mitmproxy_compat
import response_streaming
import terminal_usage
import usage
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.model_json_cooperative_helpers import make_model_json_pipeline_flow, model_json_body
from tests.model_sse_cooperative_helpers import (
    make_model_sse_pipeline_flow,
    model_sse_terminal,
    model_sse_update,
)
from tests.pending_helpers import assert_pending
from tests.x_flow_helpers import make_x_pipeline_flow


class _ResponsePeerLayer(layer.Layer):
    """Adapt fixture TCP bytes to real HttpStream events; no inspector replacement.

    HTTP header parsing is covered by the existing framing suites. This driver
    makes the actual ConnectionHandler read loop and its native hook-task and
    HookCompleted machinery testable with fixture-owned provider/client sockets.
    """

    def __init__(self, context: Context, stream: HttpStream) -> None:
        super().__init__(context)
        self.stream = stream

    def _handle_event(self, event: events.Event) -> layer.CommandGenerator[None]:
        if isinstance(event, events.DataReceived):
            event = ResponseData(1, event.data)
        elif isinstance(event, events.ConnectionClosed):
            event = ResponseEndOfMessage(1)
        for command in self.stream.handle_event(event):
            if isinstance(command, SendHttp):
                if isinstance(command.event, ResponseData):
                    yield commands.SendData(self.context.client, command.event.data)
            elif not isinstance(command, DropStream):
                yield command


@pytest.mark.parametrize(
    ("cancel_inspection", "response_kind"),
    [
        pytest.param(False, "x", id="complete-x", marks=pytest.mark.shard_cost(10)),
        pytest.param(False, "model-sse", id="complete-model-sse", marks=pytest.mark.shard_cost(2)),
        pytest.param(False, "model-json", id="complete-model-json"),
        pytest.param(True, "x", id="cancel-hook-x"),
        pytest.param(True, "model-sse", id="cancel-hook-model-sse"),
        pytest.param(True, "model-json", id="cancel-hook-model-json"),
    ],
)
@pytest.mark.parametrize("split_first_chunk", [False, True], ids=["whole-gzip", "gzip-prefix"])
async def test_native_read_loop_waits_for_inspection_and_hook_completion(
    real_flow,
    tmp_path,
    sync_usage_executor,
    usage_webhook_api,
    cancel_inspection,
    response_kind,
    split_first_chunk,
):
    if response_kind == "x":
        flow = make_x_pipeline_flow(
            real_flow, tmp_path, path="/2/tweets/search/stream", content_encoding="gzip"
        )
        first_wire = gzip.compress(b"{}\n" * 100_000)
        second_wire = gzip.compress(b'{"data":{"id":"1"}}\n')
        expected_first_work = 100_000
    elif response_kind == "model-json":
        flow = make_model_json_pipeline_flow(real_flow, tmp_path)
        body = model_json_body()
        first_wire = gzip.compress(body[:-2])
        second_wire = gzip.compress(body[-2:])
        # JSON has no authoritative prefix observations, even with usage first.
        expected_first_work = 0
    else:
        flow = make_model_sse_pipeline_flow(real_flow, tmp_path)
        first_wire = gzip.compress(
            b"".join(model_sse_update("anthropic", index) for index in range(1, 10_001))
        )
        second_wire = gzip.compress(model_sse_terminal("anthropic", 10_001))
        expected_first_work = 10_000
    assert len(first_wire) < 65_535
    # A gzip header alone produces no decoded row/event. The reader assembles
    # these explicit chunks; TCP is free to split or coalesce either write.
    first_chunks = [first_wire[:10], first_wire[10:]] if split_first_chunk else [first_wire]
    wire_chunks = [*first_chunks, second_wire]

    def observed_work():
        if response_kind == "x":
            return flow.metadata[metadata_keys.X_NDJSON_STATE]["lines_parsed"]
        return flow.metadata.get(metadata_keys.MODEL_PROVIDER_USAGE, {}).get("tokens.output", 0)

    pulse = asyncio.Event()
    inspection_drained = asyncio.Event()
    release_hook = asyncio.Event()
    hook_continued = asyncio.Event()
    release_continuation = asyncio.Event()
    inspection_completed = asyncio.Event()
    loop = asyncio.get_running_loop()
    heartbeat = loop.create_future()
    provider_done = loop.create_future()
    client_done = loop.create_future()
    terminal_done = loop.create_future()
    received = bytearray()
    read_sizes: list[int] = []
    returned_sizes: list[int] = []
    hook_tasks: list[asyncio.Task[None]] = []

    async def provider(_reader, writer):
        try:
            writer.write(first_wire)
            await writer.drain()
            # Make another chunk available while inspection is still pending.
            await pulse.wait()
            writer.write(second_wire)
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()
            provider_done.set_result(None)

    async def client(reader, writer):
        try:
            while data := await reader.read(65535):
                received.extend(data)
        finally:
            writer.close()
            await writer.wait_closed()
            client_done.set_result(None)

    class ProviderReader(asyncio.StreamReader):
        async def read(self, n=-1):
            read_index = len(read_sizes)
            read_sizes.append(n)
            assert not response_streaming.has_pending_response_inspection(flow)
            if split_first_chunk and read_index == 1:
                assert observed_work() == 0
            if read_index == len(first_chunks):
                # The heartbeat releases the second member during inspection.
                # Its read must wait for all first-member work or cancellation.
                assert inspection_completed.is_set()
                if cancel_inspection:
                    if response_kind == "x":
                        assert flow.metadata[metadata_keys.X_JSON_STATE]["body_parsed"] is False
                    else:
                        assert observed_work() <= 8
                else:
                    assert observed_work() == expected_first_work
            if read_index < len(wire_chunks):
                chunk_size = len(wire_chunks[read_index])
                assert chunk_size <= n
                data = await super().readexactly(chunk_size)
            else:
                data = await super().read(n)
            returned_sizes.append(len(data))
            return data

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
        usage_webhook_api() as webhook,
    ):
        mitm_addon.responseheaders(flow)
        context = Context(flow.client_conn, addon_context.options)
        context.server = flow.server_conn
        # The fixture peer only sends a response, so EOF closes this side.
        context.server.state = connection.ConnectionState.CAN_READ
        stream = HttpStream(context.fork(), 1)
        list(stream.handle_event(events.Start()))
        stream.flow = flow
        stream.client_state = stream.state_done
        stream.server_state = stream.state_stream_response_body

        class Handler(ConnectionHandler):
            async def server_event(self, event):
                await super().server_event(event)
                if (
                    not cancel_inspection
                    and isinstance(event, events.HookCompleted)
                    and isinstance(event.command, mitmproxy_compat.ResponseInspectionHook)
                ):
                    hook_continued.set()
                    await release_continuation.wait()

            async def handle_hook(self, hook):
                if isinstance(hook, mitmproxy_compat.ResponseInspectionHook):

                    def observe_pulse():
                        heartbeat.set_result(
                            (
                                len(read_sizes),
                                observed_work(),
                                response_streaming.has_pending_response_inspection(flow),
                            )
                        )
                        pulse.set()

                    # Queue inside the hook so only yielding inspection lets
                    # this callback observe pending work before the next read.
                    loop.call_soon(observe_pulse)
                    if cancel_inspection:
                        task = asyncio.current_task()
                        assert task is not None
                        loop.call_soon(task.cancel)
                await addon_context.master.addons.invoke_addon(mitm_addon, hook)
                if isinstance(hook, mitmproxy_compat.ResponseInspectionHook):
                    inspection_drained.set()
                    await release_hook.wait()
                if isinstance(hook, HttpResponseHook):
                    terminal_done.set_result(None)

            async def hook_task(self, hook):
                task = asyncio.current_task()
                assert task is not None
                hook_tasks.append(task)
                try:
                    await super().hook_task(hook)
                finally:
                    if isinstance(hook, mitmproxy_compat.ResponseInspectionHook):
                        inspection_completed.set()

        handler = Handler(context)
        handler.layer = _ResponsePeerLayer(context, stream)
        async with (
            await asyncio.start_server(provider, "127.0.0.1", 0) as upstream,
            await asyncio.start_server(client, "127.0.0.1", 0) as downstream,
        ):
            upstream_port = upstream.sockets[0].getsockname()[1]
            downstream_port = downstream.sockets[0].getsockname()[1]
            reader = ProviderReader()
            protocol = asyncio.StreamReaderProtocol(reader)
            transport, _ = await loop.create_connection(
                lambda: protocol, "127.0.0.1", upstream_port
            )
            provider_writer = asyncio.StreamWriter(transport, protocol, reader, loop)
            client_reader, client_writer = await asyncio.open_connection(
                "127.0.0.1", downstream_port
            )
            handler.transports[context.server] = ConnectionIO(reader=reader, writer=provider_writer)
            handler.transports[context.client] = ConnectionIO(
                reader=client_reader, writer=client_writer
            )
            reader_task = asyncio.create_task(handler.handle_connection(context.server))
            handler.transports[context.server].handler = reader_task

            async def complete_reader():
                if not cancel_inspection:
                    await inspection_drained.wait()
                    await asyncio.shield(provider_done)
                    # Parsing has finished and the next member/EOF are available,
                    # but the complete native hook is deliberately still pending.
                    assert observed_work() == expected_first_work
                    assert read_sizes == [65535] * len(first_chunks)
                    assert not reader_task.done()
                    release_hook.set()
                    # HookCompleted dispatch has run, but its continuation has
                    # not returned to the checkpoint owner yet.
                    await hook_continued.wait()
                    assert read_sizes == [65535] * len(first_chunks)
                    assert not reader_task.done()
                    release_continuation.set()
                await asyncio.shield(reader_task)

            try:
                try:
                    await asyncio.wait_for(complete_reader(), timeout=15)
                except TimeoutError as error:
                    work = (
                        flow.metadata.get(metadata_keys.X_NDJSON_STATE, {}).get("lines_parsed")
                        if response_kind == "x"
                        else observed_work()
                    )
                    raise AssertionError(
                        "native inspection did not complete: "
                        f"work={work}/{expected_first_work}, "
                        f"pending={response_streaming.has_pending_response_inspection(flow)}, "
                        f"parser_done={inspection_drained.is_set()}, "
                        f"hook_released={release_hook.is_set()}, reads={returned_sizes}, "
                        f"hook_continued={hook_continued.is_set()}, "
                        f"continuation_released={release_continuation.is_set()}, "
                        f"inspection_completed={inspection_completed.is_set()}, "
                        f"hooks={[(task.get_name(), task.done()) for task in hook_tasks]}"
                    ) from error
                await asyncio.wait_for(terminal_done, timeout=5)
                for task in hook_tasks:
                    if not task.cancelled():
                        await task
                usage.flush_usage_events(trigger="test")
            finally:
                release_hook.set()
                release_continuation.set()
                reader_task.cancel()
                await asyncio.gather(reader_task, return_exceptions=True)
                for task in hook_tasks:
                    task.cancel()
                await asyncio.gather(*hook_tasks, return_exceptions=True)
                provider_writer.close()
                client_writer.close()
                await provider_writer.wait_closed()
                await client_writer.wait_closed()
                # Cleanup must preserve native failures behind a barrier timeout.
                for task in [reader_task, *hook_tasks]:
                    if task.done() and not task.cancelled():
                        task.result()
            await provider_done
            await client_done

    reads_at_pulse, rows_at_pulse, pending_at_pulse = await heartbeat
    assert reads_at_pulse == len(first_chunks)
    if response_kind == "model-json":
        assert rows_at_pulse == 0
    else:
        assert 0 < rows_at_pulse <= 8
    assert pending_at_pulse is True
    assert read_sizes == [65535] * (len(wire_chunks) + 1)
    assert returned_sizes == [*(len(chunk) for chunk in wire_chunks), 0]
    assert received == first_wire + second_wire
    if cancel_inspection:
        assert webhook.usage_events() == []
        if response_kind == "x":
            assert flow.metadata[metadata_keys.X_JSON_STATE]["parse_error"] == (
                "response inspection interrupted"
            )
        elif response_kind == "model-json":
            assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata
        else:
            assert 0 < observed_work() <= 8
        entries = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
        assert any(entry.get("reason") == "response_inspection_interrupted" for entry in entries)
    elif response_kind == "x":
        (event,) = webhook.usage_events()
        assert event["quantity"] == 1
        assert event["resources"] == [{"id": "1", "occurrences": 1}]
    elif response_kind == "model-json":
        assert observed_work() == 200
        assert webhook.usage_events() == []
    else:
        assert observed_work() == 10_001
        assert webhook.usage_events() == []
    assert flow.response is not None
    assert flow.response.stream is False
    assert not response_streaming.has_pending_response_inspection(flow)


@pytest.mark.parametrize("cancel_point", ["cooperative-drain", "paused-hook", "socket-read"])
@pytest.mark.parametrize("response_kind", ["x", "model-sse", "model-json"])
async def test_native_reader_cancellation_preserves_connection_and_flow_cleanup(
    real_flow, tmp_path, sync_usage_executor, usage_webhook_api, cancel_point, response_kind
):
    if response_kind == "x":
        flow = make_x_pipeline_flow(
            real_flow, tmp_path, path="/2/tweets/search/stream", content_encoding="gzip"
        )
        body = b'{"data":{"id":"1"}}\n' + b"{}\n" * 100
        body += b'{"data":{"id":"2"}}\n'
    elif response_kind == "model-json":
        flow = make_model_json_pipeline_flow(real_flow, tmp_path, billable=True)
        body = model_json_body()
    else:
        flow = make_model_sse_pipeline_flow(real_flow, tmp_path, billable=True)
        body = model_sse_update("anthropic", 7) + b"\n" * 100
        body += model_sse_terminal("anthropic", 999)
    wire = gzip.compress(body)
    loop = asyncio.get_running_loop()
    allow_hook = asyncio.Event()
    inspection_done = loop.create_future()
    terminal_done = loop.create_future()
    provider_done = loop.create_future()
    client_done = loop.create_future()
    received = bytearray()
    read_sizes: list[int] = []
    closed_events: list[events.ConnectionClosed] = []
    terminal_hooks: list[commands.StartHook] = []

    async def provider(reader, writer):
        try:
            writer.write(wire)
            await writer.drain()
            # Stay open: native cancellation, rather than provider EOF, must
            # close the upstream writer and complete the HTTP flow.
            assert await reader.read() == b""
        finally:
            writer.close()
            await writer.wait_closed()
            provider_done.set_result(None)

    async def client(reader, writer):
        try:
            while data := await reader.read(65535):
                received.extend(data)
        finally:
            writer.close()
            await writer.wait_closed()
            client_done.set_result(None)

    class ProviderReader(asyncio.StreamReader):
        async def read(self, n=-1):
            read_sizes.append(n)
            if len(read_sizes) == 1:
                # Fix the inspected callback boundary without assuming that
                # TCP preserves the provider's write as one read.
                assert len(wire) <= n
                return await super().readexactly(len(wire))
            if cancel_point == "socket-read" and len(read_sizes) == 2:
                loop.call_soon(handler.close_connection, context.server, False)
            return await super().read(n)

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
        usage_webhook_api() as webhook,
    ):
        mitm_addon.responseheaders(flow)
        terminal_usage.track_flow_if_needed(flow, True)
        assert_pending(tmp_path / "control", flows=1, buffered=0, reports=0)
        context = Context(flow.client_conn, addon_context.options)
        context.server = flow.server_conn
        context.server.state = connection.ConnectionState.CAN_READ
        stream = HttpStream(context.fork(), 1)
        list(stream.handle_event(events.Start()))
        stream.flow = flow
        stream.client_state = stream.state_done
        stream.server_state = stream.state_stream_response_body

        class Handler(ConnectionHandler):
            async def server_event(self, event):
                if isinstance(event, events.ConnectionClosed):
                    closed_events.append(event)
                await super().server_event(event)

            async def handle_hook(self, hook):
                if isinstance(hook, mitmproxy_compat.ResponseInspectionHook):
                    assert response_streaming.has_pending_response_inspection(flow)
                    if cancel_point != "socket-read":
                        loop.call_soon(handler.close_connection, context.server, False)
                    if cancel_point == "paused-hook":
                        await allow_hook.wait()
                await addon_context.master.addons.invoke_addon(mitm_addon, hook)
                if isinstance(hook, HttpResponseHook | HttpErrorHook):
                    terminal_hooks.append(hook)
                    terminal_done.set_result(None)

            async def hook_task(self, hook):
                try:
                    await super().hook_task(hook)
                finally:
                    if isinstance(hook, mitmproxy_compat.ResponseInspectionHook):
                        inspection_done.set_result(None)

        handler = Handler(context)
        handler.layer = _ResponsePeerLayer(context, stream)
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
            client_reader, client_writer = await asyncio.open_connection(
                "127.0.0.1", downstream.sockets[0].getsockname()[1]
            )
            server_io = ConnectionIO(reader=reader, writer=provider_writer)
            handler.transports[context.server] = server_io
            handler.transports[context.client] = ConnectionIO(
                reader=client_reader, writer=client_writer
            )
            reader_task = asyncio.create_task(handler.handle_connection(context.server))
            server_io.handler = reader_task
            try:
                with pytest.raises(asyncio.CancelledError, match="closed by command"):
                    await asyncio.wait_for(reader_task, timeout=5)
                # Native teardown must finish even while the hook is held.
                # These checks precede all fixture fallback writer closure.
                assert provider_writer.is_closing()
                assert context.server not in handler.transports
                assert [event.connection for event in closed_events] == [context.server]
                allow_hook.set()
                await asyncio.wait_for(inspection_done, timeout=5)
                await asyncio.wait_for(terminal_done, timeout=5)
                assert len(terminal_hooks) == 1
                assert flow.response is not None
                assert flow.response.stream is False
                assert metadata_keys.RESPONSE_STREAM_STATE not in flow.metadata
                assert "_response_inspection" not in flow.metadata
                assert "_response_stream_callback" not in flow.metadata
                assert "model_sse_usage_finish" not in flow.metadata
                assert "model_json_usage_finish" not in flow.metadata
                assert "connector_response_finish" not in flow.metadata
                assert not response_streaming.has_pending_response_inspection(flow)
                usage.flush_usage_events(trigger="test")
                assert_pending(tmp_path / "control", flows=0, buffered=0, reports=0)
            finally:
                allow_hook.set()
                reader_task.cancel()
                await asyncio.gather(reader_task, return_exceptions=True)
                try:
                    await asyncio.wait_for(asyncio.shield(inspection_done), timeout=5)
                finally:
                    provider_writer.close()
                    client_writer.close()
                    await provider_writer.wait_closed()
                    await client_writer.wait_closed()
            await asyncio.wait_for(provider_done, timeout=5)
            await asyncio.wait_for(client_done, timeout=5)

    assert read_sizes == [65535] * (2 if cancel_point == "socket-read" else 1)
    assert received == wire
    reported = webhook.usage_events()
    if response_kind == "x":
        expected_ids = ["1", "2"] if cancel_point == "socket-read" else ["1"]
        assert [event["resources"] for event in reported] == [
            [{"id": resource_id, "occurrences": 1}] for resource_id in expected_ids
        ]
        assert all(event["quantity"] == 1 for event in reported)
        if cancel_point != "socket-read":
            assert metadata_keys.X_NDJSON_STATE not in flow.metadata
            assert flow.metadata[metadata_keys.X_JSON_STATE]["body_parsed"] is False
            assert flow.metadata[metadata_keys.X_JSON_STATE]["parse_error"] == (
                "response inspection interrupted"
            )
    elif response_kind == "model-json":
        if cancel_point == "socket-read":
            assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]["tokens.output"] == 200
            assert {event["category"]: event["quantity"] for event in reported} == {
                "tokens.input": 50,
                "tokens.output": 200,
            }
        else:
            assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata
            assert reported == []
    else:
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]["tokens.output"] == (
            999 if cancel_point == "socket-read" else 7
        )
        assert len(reported) == 1
        assert reported[0]["quantity"] == (999 if cancel_point == "socket-read" else 7)
    assert len({event["idempotencyKey"] for event in reported}) == len(reported)
    entries = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
    interruptions = [
        entry for entry in entries if entry.get("reason") == "response_inspection_interrupted"
    ]
    assert len(interruptions) == (0 if cancel_point == "socket-read" else 1)
