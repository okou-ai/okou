"""Version-locked bridges for mitmproxy state that public hooks omit."""

import wsproto
from mitmproxy import flow, http, version
from mitmproxy.proxy import commands, events, layer
from mitmproxy.proxy.layers.http import HttpStream
from mitmproxy.proxy.layers.http._events import RequestHeaders
from mitmproxy.proxy.layers.http._hooks import HttpRequestHeadersHook
from mitmproxy.proxy.layers.tcp import TcpErrorHook, TCPLayer

import websocket_framing

# The contract test in ``crates/runner/src/deps.rs`` enforces alignment with
# the runner artifact and Python test dependency. Re-audit the private
# imports, generators, and WebSocket extension behavior before accepting
# another version.
_SUPPORTED_MITMPROXY_VERSION = "12.2.3"
_SUPPORTED_WSPROTO_VERSION = "1.3.2"
_BRIDGE_MARKER_ATTRIBUTE = "_request_end_stream_bridge"
_REQUEST_END_STREAM_METADATA = "_request_end_stream"
_TCP_START_MARKER_ATTRIBUTE = "_tcp_start_kill_bridge"


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
    _install_tcp_start_kill_bridge()
    websocket_framing.install_websocket_framing()


def _install_tcp_start_kill_bridge() -> None:
    """Enforce a killed TCP start before upstream open or buffered payload replay."""
    current_handler = TCPLayer.start
    if hasattr(current_handler, _TCP_START_MARKER_ATTRIBUTE):
        return
    if TCPLayer._handle_event is not current_handler:
        raise RuntimeError("mitmproxy TCPLayer has an incompatible start handler")

    def start(self: TCPLayer, _: events.Event) -> layer.CommandGenerator[None]:
        tcp_flow = self.flow
        if tcp_flow is None:
            yield from current_handler(self, _)
            return

        command_generator = current_handler(self, _)
        try:
            # For a non-ignored flow, 12.2.3 first yields TcpStartHook. Its
            # completion has no reply; the remaining commands use native delegation.
            yield next(command_generator)
            if tcp_flow.error is not None and tcp_flow.error.msg == flow.Error.KILLED_MESSAGE:
                command_generator.close()
                # Retire the relay before queued events or the error hook resume.
                self._handle_event = lambda event: self.done(event)
                yield commands.CloseConnection(self.context.client)
                yield commands.CloseConnection(self.context.server)
                yield TcpErrorHook(tcp_flow)
            else:
                yield from command_generator
        finally:
            command_generator.close()

    # The pinned class binds its initial event handler to start at definition time.
    # Its start/done parameter names differ from Layer._handle_event's annotation.
    def handle_event(self: TCPLayer, event: events.Event) -> layer.CommandGenerator[None]:
        return start(self, event)

    setattr(start, _TCP_START_MARKER_ATTRIBUTE, True)
    TCPLayer.start = start
    TCPLayer._handle_event = handle_event


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


def take_request_end_stream(flow: http.HTTPFlow) -> bool | None:
    """Consume the internal end-of-stream marker for one requestheaders hook."""
    value = flow.metadata.pop(_REQUEST_END_STREAM_METADATA, None)
    return value if isinstance(value, bool) else None
