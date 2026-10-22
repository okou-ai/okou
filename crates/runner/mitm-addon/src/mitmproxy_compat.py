"""Version-locked bridges for mitmproxy state that public hooks omit.

Prefer public addon hooks and dependency APIs. Keep monkey patches and private
state access to the minimum required by a demonstrated missing capability,
delegate protocol logic to upstream, and retire bridges when public APIs suffice.
Prefer state-specific boundaries over shared event dispatch.
See the compatibility policy in docs/runner/mitm-addon-contracts.md.
"""

import asyncio
from contextvars import ContextVar
from dataclasses import dataclass, field

import wsproto
from mitmproxy import http, version
from mitmproxy.connection import Connection
from mitmproxy.proxy import commands, events, layer
from mitmproxy.proxy.layers import websocket
from mitmproxy.proxy.layers.http import HttpStream, SendHttp
from mitmproxy.proxy.layers.http._events import RequestHeaders
from mitmproxy.proxy.layers.http._hooks import HttpRequestHeadersHook
from mitmproxy.proxy.server import ConnectionHandler

import header_auth_response
import managed_upload
import managed_upload_runtime
import model_websocket_usage
import response_streaming
import websocket_framing
import websocket_inspection
import websocket_retention

# The contract test in ``crates/runner/src/deps.rs`` enforces alignment with
# the runner artifact and Python test dependency. Re-audit the private
# imports, generators, and WebSocket extension behavior before accepting
# another version.
_SUPPORTED_MITMPROXY_VERSION = "12.3.0"
_SUPPORTED_WSPROTO_VERSION = "1.3.2"
_BRIDGE_MARKER_ATTRIBUTE = "_request_end_stream_bridge"
_REQUEST_END_STREAM_METADATA = "_request_end_stream"
_RESPONSE_INSPECTION_BRIDGE = "_response_inspection_bridge"
_MANAGED_HEADERS_WAITING = "_okou_managed_headers_waiting"
_INSPECTION_CHECKPOINTS: ContextVar[list[_InspectionHook] | None] = ContextVar(
    "response_inspection_checkpoints", default=None
)


@dataclass
class ResponseInspectionHook(commands.StartHook):
    """Pause one HTTP stream until its current wire callback is inspected."""

    name = "responseinspection"
    flow: http.HTTPFlow
    completed: asyncio.Future[None] | None = field(default=None, repr=False)
    resumed: bool = False

    def args(self) -> list[http.HTTPFlow]:
        return [self.flow]


@dataclass
class _WebsocketInspectionCheckpoint:
    """Track a native message hook without registering another event class."""

    flow: http.HTTPFlow
    completed: asyncio.Future[None] | None = field(default=None, repr=False)
    started: bool = False
    abandoned: bool = False
    resumed: bool = False


type _InspectionHook = ResponseInspectionHook | _WebsocketInspectionCheckpoint
_WEBSOCKET_CHECKPOINT_ATTRIBUTE = "_okou_websocket_inspection_checkpoint"
_ACTIVE_WEBSOCKET_CHECKPOINT = "_okou_active_websocket_inspection_checkpoint"


def _abandon_inspection(checkpoint: _InspectionHook) -> None:
    if isinstance(checkpoint, _WebsocketInspectionCheckpoint):
        if not checkpoint.started and not checkpoint.abandoned:
            model_websocket_usage.interrupt_inspection(checkpoint.flow)
        checkpoint.abandoned = True
        websocket_inspection.release(checkpoint.flow)
    else:
        response_streaming.abandon_response_inspection(checkpoint.flow)


@dataclass
class _ReaderInspectionCheckpoints:
    owner: asyncio.Task[object] | None
    managed: managed_upload_runtime.Reader
    pending: list[_InspectionHook] = field(default_factory=list)
    closed: bool = False
    provider_writers: set[managed_upload_runtime.DrainWriter] | None = None


_READER_INSPECTION: ContextVar[_ReaderInspectionCheckpoints | None] = ContextVar(
    "reader_response_inspection", default=None
)


def install_runtime_compatibility() -> None:
    """Install all exact-version mitmproxy compatibility adaptations."""
    if version.VERSION != _SUPPORTED_MITMPROXY_VERSION:
        raise RuntimeError(
            "Okou's runtime compatibility layer requires mitmproxy "
            f"{_SUPPORTED_MITMPROXY_VERSION}; found {version.VERSION}"
        )
    if wsproto.__version__ != _SUPPORTED_WSPROTO_VERSION:
        raise RuntimeError(
            "Okou's runtime compatibility layer requires wsproto "
            f"{_SUPPORTED_WSPROTO_VERSION}; found {wsproto.__version__}"
        )

    _install_request_end_stream_bridge()
    _install_response_inspection_bridge()
    managed_upload_runtime.install()
    header_auth_response.install()
    websocket_framing.install_websocket_framing()


def _install_request_end_stream_bridge() -> None:
    """Expose RequestHeaders.end_stream to the matching public hook once.

    Patch only the request-header state; upstream retains framing and protocol
    decisions without an extra shared-dispatch filter.
    """
    current_handler = HttpStream.state_wait_for_request_headers
    if hasattr(current_handler, _BRIDGE_MARKER_ATTRIBUTE):
        return

    def state_wait_for_request_headers(
        self: HttpStream,
        event: RequestHeaders,
    ) -> layer.CommandGenerator[None]:
        command_generator = current_handler(self, event)
        try:
            command = next(command_generator)
        except StopIteration:
            return

        while True:
            if isinstance(command, HttpRequestHeadersHook):
                command.flow.metadata[_REQUEST_END_STREAM_METADATA] = event.end_stream
                managed_upload_runtime.defer_headers(command.flow)

            try:
                if isinstance(command, HttpRequestHeadersHook):
                    setattr(command, _MANAGED_HEADERS_WAITING, True)
                    try:
                        completion: object = yield command
                    finally:
                        setattr(command, _MANAGED_HEADERS_WAITING, False)
                    if header_auth_response.take(command.flow) and command.flow.error is None:
                        command_generator.close()
                        yield from header_auth_response.send(self)
                        return
                else:
                    completion = yield command
                if isinstance(command, SendHttp) and isinstance(command.event, RequestHeaders):
                    upload = managed_upload.from_request(command.event.request)
                    if upload is not None and not upload.native_h2:
                        upload.ready.set()
            except GeneratorExit:
                command_generator.close()
                raise
            except BaseException as error:
                try:
                    command = command_generator.throw(error)
                except StopIteration:
                    return
            else:
                try:
                    command = command_generator.send(completion)
                except StopIteration:
                    return

    setattr(state_wait_for_request_headers, _BRIDGE_MARKER_ATTRIBUTE, True)
    HttpStream.state_wait_for_request_headers = state_wait_for_request_headers


def _install_response_inspection_bridge() -> None:
    """Pause the stream AND its connection reader, outside the event lock.

    In 12.3.0, handle_connection catches cancellation in drain_writers, but not
    in DataReceived dispatch. Join reader checkpoints in that native boundary
    so cancellation still closes the connection and completes its HTTP flows.
    A hook alone does not backpressure those reads. Join the complete hook task
    (including HookCompleted and any buffered body events it resumes), not just
    the parser future, before allowing the read loop to continue.
    Insert checkpoints only in the streamed-response state and activated
    Responses WebSocket message hooks, keeping protocol dispatch with upstream.
    """
    current_stream = HttpStream.state_stream_response_body
    if hasattr(current_stream, _RESPONSE_INSPECTION_BRIDGE):
        return
    current_event = ConnectionHandler.server_event
    current_hook = ConnectionHandler.hook_task
    current_connection = ConnectionHandler.handle_connection
    current_drain = ConnectionHandler.drain_writers
    current_relay = websocket.WebsocketLayer.relay_messages

    def register_checkpoint(checkpoint: _InspectionHook) -> None:
        checkpoints = _INSPECTION_CHECKPOINTS.get()
        if checkpoints is not None:
            checkpoint.completed = asyncio.get_running_loop().create_future()
            checkpoints.append(checkpoint)

    def state_stream_response_body(
        self: HttpStream, event: events.Event
    ) -> layer.CommandGenerator[None]:
        for command in current_stream(self, event):
            if response_streaming.has_pending_response_inspection(self.flow):
                checkpoint = ResponseInspectionHook(self.flow)
                register_checkpoint(checkpoint)
                try:
                    yield checkpoint
                finally:
                    checkpoint.resumed = True
            yield command

    def relay_messages(
        self: websocket.WebsocketLayer, event: events.Event
    ) -> layer.CommandGenerator[None]:
        for command in current_relay(self, event):
            if isinstance(
                command, websocket.WebsocketMessageHook
            ) and model_websocket_usage.is_enabled(command.flow):
                checkpoint = _WebsocketInspectionCheckpoint(command.flow)
                register_checkpoint(checkpoint)
                setattr(command, _WEBSOCKET_CHECKPOINT_ATTRIBUTE, checkpoint)
                websocket_retention.hold_message(command.flow)
                try:
                    yield command
                finally:
                    checkpoint.resumed = True
                    websocket_retention.release_message(command.flow)
            else:
                yield command

    async def server_event(self: ConnectionHandler, event: events.Event) -> None:
        checkpoints: list[_InspectionHook] = []
        reader = _READER_INSPECTION.get()
        if (
            reader is not None
            and reader.owner is asyncio.current_task()
            and isinstance(event, events.DataReceived)
        ):
            reader.provider_writers = reader.managed.downstream()
        token = _INSPECTION_CHECKPOINTS.set(checkpoints)
        try:
            await current_event(self, event)
        finally:
            _INSPECTION_CHECKPOINTS.reset(token)
        for checkpoint in checkpoints:
            if isinstance(checkpoint, _WebsocketInspectionCheckpoint):
                setattr(self, _ACTIVE_WEBSOCKET_CHECKPOINT, checkpoint)
        reader = _READER_INSPECTION.get()
        if reader is not None and (
            (isinstance(event, events.DataReceived) and reader.owner is asyncio.current_task())
            or (
                isinstance(event, events.HookCompleted)
                and isinstance(event.command, websocket.WebsocketMessageHook)
            )
        ):
            # A single read can contain many small WebSocket messages. Transfer
            # successor checkpoints to the reader instead of retaining a chain
            # of native hook tasks waiting on all later messages in that read.
            if reader.closed:
                for checkpoint in checkpoints:
                    _abandon_inspection(checkpoint)
            else:
                reader.pending.extend(checkpoints)
        else:
            await join_checkpoints(checkpoints)

    async def join_checkpoints(checkpoints: list[_InspectionHook]) -> None:
        try:
            for checkpoint in checkpoints:
                if checkpoint.completed is not None:
                    await asyncio.shield(checkpoint.completed)
        except BaseException:
            for checkpoint in checkpoints:
                _abandon_inspection(checkpoint)
            raise

    async def handle_connection(self: ConnectionHandler, connection: Connection) -> None:
        with managed_upload_runtime.reader_scope(self, connection) as managed:
            reader = _ReaderInspectionCheckpoints(asyncio.current_task(), managed)
            token = _READER_INSPECTION.set(reader)
            try:
                await current_connection(self, connection)
            finally:
                _READER_INSPECTION.reset(token)
                reader.closed = True
                for checkpoint in reader.pending:
                    _abandon_inspection(checkpoint)

    async def drain_writers(self: ConnectionHandler) -> None:
        reader = _READER_INSPECTION.get()
        # Native hook tasks inherit the reader's context, but their buffered
        # HookCompleted continuations must keep their own checkpoint joins.
        if reader is not None and reader.owner is asyncio.current_task():
            while True:
                checkpoints, reader.pending = reader.pending, []
                active = getattr(self, _ACTIVE_WEBSOCKET_CHECKPOINT, None)
                if (
                    isinstance(active, _WebsocketInspectionCheckpoint)
                    and active.completed is not None
                    and not active.completed.done()
                    and all(checkpoint is not active for checkpoint in checkpoints)
                ):
                    # The opposite WebSocket reader may have delivered a read
                    # while this layer was paused. Both readers must wait;
                    # otherwise its buffered DataReceived queue can grow.
                    checkpoints.append(active)
                if not checkpoints:
                    break
                await join_checkpoints(checkpoints)
            await reader.managed.wait_capacity()
            if reader.provider_writers is not None:
                for writer in reader.provider_writers:
                    try:
                        await writer.drain()
                    except OSError as error:
                        for transport in tuple(self.transports.values()):
                            if transport.writer is writer and transport.handler is not None:
                                transport.handler.cancel(f"Error sending data: {error}")
                return
        await current_drain(self)
        if reader is not None and reader.owner is asyncio.current_task():
            reader.managed.socket_drained()

    async def hook_task(self: ConnectionHandler, hook: commands.StartHook) -> None:
        checkpoint = (
            hook
            if isinstance(hook, ResponseInspectionHook)
            else getattr(hook, _WEBSOCKET_CHECKPOINT_ATTRIBUTE, None)
        )
        if not isinstance(checkpoint, (ResponseInspectionHook, _WebsocketInspectionCheckpoint)):
            try:
                await current_hook(self, hook)
            except BaseException:
                if isinstance(hook, HttpRequestHeadersHook):
                    upload = managed_upload.get(hook.flow) or managed_upload_runtime.header_upload(
                        hook.flow
                    )
                    if upload is not None:
                        upload.close()
                        if hook.flow.killable:
                            hook.flow.kill()
                        if getattr(hook, _MANAGED_HEADERS_WAITING, False):
                            await self.server_event(events.HookCompleted(hook))
                raise
            finally:
                if isinstance(hook, HttpRequestHeadersHook):
                    managed_upload_runtime.header_finished(hook.flow)
            return
        try:
            if isinstance(checkpoint, _WebsocketInspectionCheckpoint):
                if checkpoint.abandoned:
                    if hook.blocking:
                        await self.server_event(events.HookCompleted(hook))
                    return
                checkpoint.started = True
            await current_hook(self, hook)
        except BaseException:
            _abandon_inspection(checkpoint)
            # The stock hook task does not resume a stream after an exception.
            # Release our checkpoint with explicitly unparsed state instead of
            # leaving an indefinitely paused event queue behind.
            if hook.blocking and not checkpoint.resumed:
                await self.server_event(events.HookCompleted(hook))
            raise
        finally:
            if checkpoint.completed is not None and not checkpoint.completed.done():
                checkpoint.completed.set_result(None)
            if getattr(self, _ACTIVE_WEBSOCKET_CHECKPOINT, None) is checkpoint:
                delattr(self, _ACTIVE_WEBSOCKET_CHECKPOINT)

    setattr(state_stream_response_body, _RESPONSE_INSPECTION_BRIDGE, True)
    HttpStream.state_stream_response_body = state_stream_response_body
    websocket.WebsocketLayer.relay_messages = relay_messages
    ConnectionHandler.server_event = server_event
    ConnectionHandler.hook_task = hook_task
    ConnectionHandler.handle_connection = handle_connection
    ConnectionHandler.drain_writers = drain_writers


def take_request_end_stream(flow: http.HTTPFlow) -> bool | None:
    """Consume the internal end-of-stream marker for one requestheaders hook."""
    value = flow.metadata.pop(_REQUEST_END_STREAM_METADATA, None)
    return value if isinstance(value, bool) else None
