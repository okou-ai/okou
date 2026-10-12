"""Real pinned read loop, HTTP stream hooks and response inspection backpressure."""

import asyncio
import gzip
from unittest.mock import patch

import pytest
from mitmproxy import connection
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.proxy import commands, events, layer
from mitmproxy.proxy.context import Context
from mitmproxy.proxy.layers.http import HttpStream, SendHttp
from mitmproxy.proxy.layers.http._events import ResponseData, ResponseEndOfMessage
from mitmproxy.proxy.layers.http._hooks import HttpResponseHook
from mitmproxy.proxy.server import ConnectionHandler, ConnectionIO
from mitmproxy.test import taddons

import flow_metadata_keys as metadata_keys
import mitm_addon
import mitmproxy_compat
import usage
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.model_sse_cooperative_helpers import (
    make_model_sse_pipeline_flow,
    model_sse_terminal,
    model_sse_update,
)
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
            else:
                yield command


@pytest.mark.parametrize(
    ("cancel_inspection", "response_kind"),
    [
        pytest.param(False, "x", id="complete-x", marks=pytest.mark.shard_cost(10)),
        pytest.param(False, "model-sse", id="complete-model-sse", marks=pytest.mark.shard_cost(2)),
        pytest.param(True, "x", id="cancel-hook-x"),
        pytest.param(True, "model-sse", id="cancel-hook-model-sse"),
    ],
)
async def test_native_read_loop_waits_for_inspection_and_hook_completion(
    real_flow, tmp_path, sync_usage_executor, usage_webhook_api, cancel_inspection, response_kind
):
    if response_kind == "x":
        flow = make_x_pipeline_flow(
            real_flow, tmp_path, path="/2/tweets/search/stream", content_encoding="gzip"
        )
        first_wire = gzip.compress(b"{}\n" * 100_000)
        second_wire = gzip.compress(b'{"data":{"id":"1"}}\n')
        expected_first_work = 100_000
    else:
        flow = make_model_sse_pipeline_flow(real_flow, tmp_path)
        first_wire = gzip.compress(
            b"".join(model_sse_update("anthropic", index) for index in range(1, 10_001))
        )
        second_wire = gzip.compress(model_sse_terminal("anthropic", 10_001))
        expected_first_work = 10_000
    assert len(first_wire) < 65_535

    def observed_work():
        if response_kind == "x":
            return flow.metadata[metadata_keys.X_NDJSON_STATE]["lines_parsed"]
        return flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE].get("tokens.output", 0)

    pulse = asyncio.Event()
    loop = asyncio.get_running_loop()
    heartbeat = loop.create_future()
    provider_done = loop.create_future()
    client_done = loop.create_future()
    terminal_done = loop.create_future()
    received = bytearray()
    read_sizes: list[int] = []

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
            read_sizes.append(n)
            if len(read_sizes) == 2:
                # The second chunk is already available; the production read
                # loop must not request it until all first-chunk work finishes.
                if cancel_inspection:
                    if response_kind == "x":
                        assert flow.metadata[metadata_keys.X_JSON_STATE]["body_parsed"] is False
                    else:
                        assert observed_work() <= 8
                else:
                    assert observed_work() == expected_first_work
            data = await super().read(n)
            if len(read_sizes) == 1:

                def observe_pulse():
                    heartbeat.set_result((len(read_sizes), observed_work()))
                    pulse.set()

                loop.call_soon(observe_pulse)
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
            async def handle_hook(self, hook):
                if cancel_inspection and isinstance(hook, mitmproxy_compat.ResponseInspectionHook):
                    task = asyncio.current_task()
                    assert task is not None
                    loop.call_soon(task.cancel)
                await addon_context.master.addons.invoke_addon(mitm_addon, hook)
                if isinstance(hook, HttpResponseHook):
                    terminal_done.set_result(None)

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
            try:
                await asyncio.wait_for(handler.handle_connection(context.server), timeout=15)
                await asyncio.wait_for(terminal_done, timeout=5)
                usage.flush_usage_events(trigger="test")
            finally:
                provider_writer.close()
                client_writer.close()
                await provider_writer.wait_closed()
                await client_writer.wait_closed()
            await provider_done
            await client_done

    reads_at_pulse, rows_at_pulse = await heartbeat
    assert reads_at_pulse == 1
    assert 0 < rows_at_pulse <= 8
    assert read_sizes == [65535, 65535, 65535]
    assert received == first_wire + second_wire
    if cancel_inspection:
        assert webhook.usage_events() == []
        if response_kind == "x":
            assert flow.metadata[metadata_keys.X_JSON_STATE]["parse_error"] == (
                "response inspection interrupted"
            )
        else:
            assert 0 < observed_work() <= 8
        entries = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
        assert any(entry.get("reason") == "response_inspection_interrupted" for entry in entries)
    elif response_kind == "x":
        (event,) = webhook.usage_events()
        assert event["quantity"] == 1
        assert event["resources"] == [{"id": "1", "occurrences": 1}]
    else:
        assert observed_work() == 10_001
        assert webhook.usage_events() == []
    assert flow.response is not None
    assert flow.response.stream is False
