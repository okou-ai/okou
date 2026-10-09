"""Version-locked bridges for mitmproxy state that public hooks omit."""

import asyncio
from contextvars import ContextVar
from dataclasses import dataclass, field

import wsproto
from mitmproxy import http, version
from mitmproxy.proxy import commands, events, layer
from mitmproxy.proxy.layers.http import HttpStream
from mitmproxy.proxy.layers.http._events import RequestHeaders
from mitmproxy.proxy.layers.http._hooks import HttpRequestHeadersHook
from mitmproxy.proxy.server import ConnectionHandler

import response_streaming
import websocket_framing

# The contract test in ``crates/runner/src/deps.rs`` enforces alignment with
# the runner artifact and Python test dependency. Re-audit the private
# imports, generators, and WebSocket extension behavior before accepting
# another version.
_SUPPORTED_MITMPROXY_VERSION = "12.2.3"
_SUPPORTED_WSPROTO_VERSION = "1.3.2"
_BRIDGE_MARKER_ATTRIBUTE = "_request_end_stream_bridge"
_REQUEST_END_STREAM_METADATA = "_request_end_stream"
_RESPONSE_INSPECTION_BRIDGE = "_response_inspection_bridge"
_INSPECTION_CHECKPOINTS: ContextVar[list["ResponseInspectionHook"] | None] = ContextVar(
    "response_inspection_checkpoints", default=None
)


@dataclass
class ResponseInspectionHook(commands.StartHook):
    """Pause one HTTP stream until its current wire callback is inspected."""

    name = "responseinspection"
    flow: http.HTTPFlow
    completed: asyncio.Future[None] | None = field(default=None, repr=False)

    def args(self) -> list[http.HTTPFlow]:
        return [self.flow]


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
    websocket_framing.install_websocket_framing()


def _install_request_end_stream_bridge() -> None:
    """Expose RequestHeaders.end_stream to the matching public hook once."""
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

            try:
                completion: object = yield command
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

    In 12.2.3, handle_connection awaits server_event between 65,535-byte reads.
    A hook alone does not backpressure those reads. Join the complete hook task
    (including HookCompleted and any buffered body events it resumes), not just
    the parser future, before allowing the read loop to continue.
    """
    current_stream = HttpStream.state_stream_response_body
    if hasattr(current_stream, _RESPONSE_INSPECTION_BRIDGE):
        return
    current_event = ConnectionHandler.server_event
    current_hook = ConnectionHandler.hook_task

    def state_stream_response_body(
        self: HttpStream, event: events.Event
    ) -> layer.CommandGenerator[None]:
        for command in current_stream(self, event):
            if response_streaming.has_pending_connector_inspection(self.flow):
                checkpoint = ResponseInspectionHook(self.flow)
                checkpoints = _INSPECTION_CHECKPOINTS.get()
                if checkpoints is not None:
                    checkpoint.completed = asyncio.get_running_loop().create_future()
                    checkpoints.append(checkpoint)
                yield checkpoint
            yield command

    async def server_event(self: ConnectionHandler, event: events.Event) -> None:
        checkpoints: list[ResponseInspectionHook] = []
        token = _INSPECTION_CHECKPOINTS.set(checkpoints)
        try:
            await current_event(self, event)
        finally:
            _INSPECTION_CHECKPOINTS.reset(token)
        try:
            for checkpoint in checkpoints:
                if checkpoint.completed is not None:
                    await asyncio.shield(checkpoint.completed)
        except BaseException:
            for checkpoint in checkpoints:
                response_streaming.abandon_connector_inspection(checkpoint.flow)
            raise

    async def hook_task(self: ConnectionHandler, hook: commands.StartHook) -> None:
        if not isinstance(hook, ResponseInspectionHook):
            await current_hook(self, hook)
            return
        try:
            await current_hook(self, hook)
        except BaseException:
            response_streaming.abandon_connector_inspection(hook.flow)
            # The stock hook task does not resume a stream after an exception.
            # Release our checkpoint with explicitly unparsed state instead of
            # leaving an indefinitely paused event queue behind.
            if hook.blocking:
                await self.server_event(events.HookCompleted(hook))
            raise
        finally:
            if hook.completed is not None and not hook.completed.done():
                hook.completed.set_result(None)

    setattr(state_stream_response_body, _RESPONSE_INSPECTION_BRIDGE, True)
    HttpStream.state_stream_response_body = state_stream_response_body
    ConnectionHandler.server_event = server_event
    ConnectionHandler.hook_task = hook_task


def take_request_end_stream(flow: http.HTTPFlow) -> bool | None:
    """Consume the internal end-of-stream marker for one requestheaders hook."""
    value = flow.metadata.pop(_REQUEST_END_STREAM_METADATA, None)
    return value if isinstance(value, bool) else None
