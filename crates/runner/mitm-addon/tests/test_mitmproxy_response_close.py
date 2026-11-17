"""Native HTTP/1 completion must settle inspection before closing its reader."""

import asyncio
import json
from unittest.mock import patch

import pytest
from mitmproxy import connection
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.proxy import commands, events, layer
from mitmproxy.proxy.context import Context
from mitmproxy.proxy.layers.http import DropStream, HttpStream, SendHttp
from mitmproxy.proxy.layers.http._base import ReceiveHttp
from mitmproxy.proxy.layers.http._events import (
    RequestEndOfMessage,
    RequestHeaders,
    ResponseData,
    ResponseHeaders,
)
from mitmproxy.proxy.layers.http._hooks import HttpResponseHook
from mitmproxy.proxy.layers.http._http1 import Http1Client
from mitmproxy.proxy.server import ConnectionHandler, ConnectionIO
from mitmproxy.test import taddons

import mitm_addon
import mitmproxy_compat
import usage
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.model_json_cooperative_helpers import make_model_json_pipeline_flow, model_json_body
from tests.model_sse_cooperative_helpers import (
    make_model_sse_pipeline_flow,
    model_sse_terminal,
    model_sse_update,
)
from tests.x_flow_helpers import make_x_pipeline_flow


class _Http1ResponsePeers(layer.Layer):
    """Compose native HTTP/1 framing and stream hooks with fixture TCP peers.

    The request/response headers' addon admission is prepared by the normal flow
    fixtures. Unlike the response-event driver, this adapter lets Http1Client
    produce EndOfMessage and CloseConnection in the same native wire read.
    """

    def __init__(self, context: Context, stream: HttpStream) -> None:
        super().__init__(context)
        self.stream = stream
        self.http1 = Http1Client(context.fork())
        list(self.http1.handle_event(events.Start()))
        assert stream.flow is not None
        list(self.http1.handle_event(RequestHeaders(1, stream.flow.request, True)))
        list(self.http1.handle_event(RequestEndOfMessage(1)))

    def _handle_event(self, event: events.Event) -> layer.CommandGenerator[None]:
        if isinstance(event, events.HookCompleted):
            yield from self._stream_event(event)
            return
        for command in self.http1.handle_event(event):
            if isinstance(command, ReceiveHttp):
                if not isinstance(command.event, ResponseHeaders):
                    yield from self._stream_event(command.event)
            else:
                yield command

    def _stream_event(self, event: events.Event) -> layer.CommandGenerator[None]:
        for command in self.stream.handle_event(event):
            if isinstance(command, SendHttp):
                if isinstance(command.event, ResponseData):
                    yield commands.SendData(self.context.client, command.event.data)
            elif not isinstance(command, DropStream):
                yield command


@pytest.mark.parametrize("response_kind", ["x", "model-json", "model-sse"])
@pytest.mark.parametrize(
    "terminal",
    ["keep-alive", "request-close", "response-close", "http2-downgrade", "external-cancel"],
)
async def test_http1_close_preserves_inspection_and_external_cancellation(
    real_flow, tmp_path, sync_usage_executor, usage_webhook_api, response_kind, terminal
):
    await _exercise_http1_response(
        real_flow, tmp_path, usage_webhook_api, response_kind, terminal, large=True
    )


@pytest.mark.parametrize("terminal", ["request-close", "response-close"])
async def test_http1_close_without_deferred_work(
    real_flow, tmp_path, sync_usage_executor, usage_webhook_api, terminal
):
    await _exercise_http1_response(
        real_flow, tmp_path, usage_webhook_api, "x", terminal, large=False
    )


async def _exercise_http1_response(
    real_flow, tmp_path, usage_webhook_api, response_kind, terminal, *, large
):
    if response_kind == "x":
        flow = make_x_pipeline_flow(
            real_flow,
            tmp_path,
            path="/2/users/1/tweets",
            query="max_results=100",
            permission="users.read",
            rule="GET /2/users/{id}/tweets",
        )
        body = json.dumps(
            {
                "data": [
                    {"id": str(10**18 + i), "text": "a" * 400} for i in range(100 if large else 1)
                ],
                "includes": {"users": [{"id": str(20 + i)} for i in range(3)]},
            }
        ).encode()
    elif response_kind == "model-json":
        flow = make_model_json_pipeline_flow(real_flow, tmp_path, encoding="", billable=True)
        body = model_json_body(characters=6_000)
    else:
        flow = make_model_sse_pipeline_flow(real_flow, tmp_path, encoding="", billable=True)
        body = model_sse_update("anthropic", 7) + b"\n" * 100
        body += model_sse_terminal("anthropic", 999)

    assert flow.response is not None
    flow.response.headers.pop("content-encoding", None)
    flow.request.http_version = "HTTP/2.0" if terminal == "http2-downgrade" else "HTTP/1.1"
    flow.request.headers.pop("connection", None)
    if terminal == "request-close":
        flow.request.headers["connection"] = "close"
    close_response = terminal in {"response-close", "external-cancel"}
    if close_response:
        flow.response.headers["connection"] = "close"
    wire = (
        b"HTTP/1.1 200 OK\r\nContent-Type: "
        + flow.response.headers["content-type"].encode()
        + b"\r\nContent-Length: "
        + str(len(body)).encode()
        + b"\r\n"
        + (b"Connection: close\r\n" if close_response else b"")
        + b"\r\n"
        + body
    )
    assert len(wire) < 65_535

    loop = asyncio.get_running_loop()
    release_provider = asyncio.Event()
    hook_started = asyncio.Event()
    release_hook = asyncio.Event()
    terminal_done = asyncio.Event()
    client_body = loop.create_future()
    client_done = loop.create_future()
    provider_done = loop.create_future()
    hook_tasks: list[asyncio.Task[None]] = []
    closed_connections = []

    async def provider(_reader, writer):
        try:
            writer.write(wire)
            await writer.drain()
            await release_provider.wait()
        finally:
            writer.close()
            await writer.wait_closed()
            provider_done.set_result(None)

    async def client(reader, writer):
        try:
            client_body.set_result(await reader.readexactly(len(body)))
        except asyncio.IncompleteReadError as error:
            client_body.set_exception(error)
        finally:
            writer.close()
            await writer.wait_closed()
            client_done.set_result(None)

    class ProviderReader(asyncio.StreamReader):
        first = True

        async def read(self, n=-1):
            if self.first:
                self.first = False
                # Guarantee final data, EOM and native close share one callback;
                # TCP itself need not preserve the provider's write boundary.
                assert len(wire) <= n
                return await super().readexactly(len(wire))
            return await super().read(n)

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
        usage_webhook_api() as webhook,
    ):
        mitm_addon.responseheaders(flow)
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
                    closed_connections.append(event.connection)
                await super().server_event(event)

            async def handle_hook(self, hook):
                if isinstance(hook, mitmproxy_compat.ResponseInspectionHook):
                    hook_started.set()
                    if terminal == "external-cancel":
                        await release_hook.wait()
                await addon_context.master.addons.invoke_addon(mitm_addon, hook)
                if isinstance(hook, HttpResponseHook):
                    terminal_done.set()

            async def hook_task(self, hook):
                task = asyncio.current_task()
                assert task is not None
                hook_tasks.append(task)
                await super().hook_task(hook)

        handler = Handler(context)
        handler.layer = _Http1ResponsePeers(context, stream)
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
                if terminal == "external-cancel":
                    await asyncio.wait_for(hook_started.wait(), timeout=5)
                    # This close comes from another task, outside the reader's
                    # context. It must interrupt held parsing immediately.
                    handler.close_connection(context.server, False)
                if terminal != "keep-alive":
                    with pytest.raises(asyncio.CancelledError, match="closed by command"):
                        await asyncio.wait_for(reader_task, timeout=5)
                    assert provider_writer.is_closing()
                    assert context.server not in handler.transports
                    assert closed_connections == [context.server]
                release_hook.set()
                await asyncio.wait_for(terminal_done.wait(), timeout=5)
                assert await asyncio.wait_for(asyncio.shield(client_body), timeout=5) == body
                usage.flush_usage_events(trigger="test")
            finally:
                release_hook.set()
                release_provider.set()
                reader_task.cancel()
                await asyncio.gather(reader_task, return_exceptions=True)
                for task in hook_tasks:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*hook_tasks, return_exceptions=True)
                provider_writer.close()
                client_writer.close()
                await provider_writer.wait_closed()
                await client_writer.wait_closed()
                await asyncio.wait_for(provider_done, timeout=5)
                await asyncio.wait_for(client_done, timeout=5)
                for task in hook_tasks:
                    if not task.cancelled():
                        task.result()

    interrupted = terminal == "external-cancel"
    quantities = {event["category"]: event["quantity"] for event in webhook.usage_events()}
    if response_kind == "x":
        assert quantities == (
            {"posts.read": 100}
            if interrupted
            else {"posts.read": 100 if large else 1, "user.read": 3}
        )
        if interrupted:
            assert webhook.usage_events()[0]["remainder"] == [
                {"reason": "parse_fallback", "quantity": 100}
            ]
        else:
            assert all(not event["remainder"] for event in webhook.usage_events())
    elif response_kind == "model-json":
        assert quantities == ({} if interrupted else {"tokens.input": 50, "tokens.output": 200})
    else:
        assert quantities == {"tokens.output": 7 if interrupted else 999}
    interruptions = [
        entry
        for entry in read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
        if entry.get("reason") == "response_inspection_interrupted"
    ]
    assert len(interruptions) == int(interrupted)
