"""Version-bound EOF cleanup and H2 capacity gaps in public streaming APIs.

Normal payload transformation and forwarding use public request.stream. Native
mitmproxy 12.2.3 owns HTTP framing, TLS and queues. Public stream hooks do not
own native EOF finalization, and socket drains do not bound H2 stream buffers.
"""

from mitmproxy.proxy import commands, events, layer
from mitmproxy.proxy.layers.http import HttpStream, SendHttp
from mitmproxy.proxy.layers.http._base import ReceiveHttp
from mitmproxy.proxy.layers.http._events import (
    ErrorCode,
    RequestData,
    RequestEndOfMessage,
    RequestHeaders,
    RequestProtocolError,
    ResponseProtocolError,
)
from mitmproxy.proxy.layers.http._hooks import HttpResponseHook
from mitmproxy.proxy.layers.http._http2 import Http2Client

import managed_request_body

_BRIDGE = "_managed_public_stream_bridge"
_HTTP2_UPLOADS = "_managed_request_uploads"


class _Http2Uploads:
    def __init__(self) -> None:
        self.bodies: dict[int, managed_request_body.StreamBody] = {}

    def update(self, client: Http2Client) -> None:
        for stream_id, body in tuple(self.bodies.items()):
            if body.closed:
                del self.bodies[stream_id]
                continue
            if body.failure is not None:
                # Discarding input no longer needs upstream window capacity.
                body.writable.set()
                continue
            upstream_id = client.our_stream_id.get(stream_id)
            pending = upstream_id is None or client.h2_conn.stream_buffers.get(upstream_id)
            if pending:
                body.writable.clear()
            else:
                body.writable.set()
                if body.validated:
                    body.upload_complete()
                    del self.bodies[stream_id]

    def close_queued(self, client: Http2Client) -> layer.CommandGenerator[None]:
        # Native close_connection only notifies allocated upstream streams.
        for stream_id, body in tuple(self.bodies.items()):
            if stream_id not in client.our_stream_id:
                client.stream_queue.pop(stream_id, None)
                body.close()
                yield ReceiveHttp(
                    ResponseProtocolError(
                        stream_id,
                        "upstream closed before managed upload admission",
                        ErrorCode.CONNECT_FAILED,
                    )
                )


def _install_http2_capacity() -> None:
    current = Http2Client._handle_event
    if hasattr(current, _BRIDGE):
        return

    def handle_event(self: Http2Client, event: events.Event) -> layer.CommandGenerator[None]:
        uploads = getattr(self, _HTTP2_UPLOADS, None)
        if isinstance(event, RequestHeaders):
            body = managed_request_body.from_request(event.request)
            if body is not None:
                if not isinstance(uploads, _Http2Uploads):
                    uploads = _Http2Uploads()
                    setattr(self, _HTTP2_UPLOADS, uploads)
                body.protocol_bound = True
                uploads.bodies[event.stream_id] = body
        if (
            isinstance(event, RequestProtocolError)
            and isinstance(uploads, _Http2Uploads)
            and event.stream_id in uploads.bodies
            and event.stream_id not in self.our_stream_id
        ):
            self.stream_queue.pop(event.stream_id, None)
            uploads.bodies.pop(event.stream_id).close()
            return
        try:
            closed = False
            for command in current(self, event):
                if (
                    isinstance(command, commands.CloseConnection)
                    and command.connection == self.conn
                ):
                    closed = True
                yield command
            if closed and isinstance(uploads, _Http2Uploads):
                for stream_id, body in tuple(uploads.bodies.items()):
                    upstream_id = self.our_stream_id.get(stream_id)
                    if upstream_id is not None:
                        self.h2_conn.stream_buffers.pop(upstream_id, None)
                        body.close()
                yield from uploads.close_queued(self)
        finally:
            if isinstance(uploads, _Http2Uploads):
                uploads.update(self)

    setattr(handle_event, _BRIDGE, True)
    Http2Client._handle_event = handle_event


def _install_early_response_completion() -> None:
    current = HttpStream.send_response
    if hasattr(current, _BRIDGE):
        return

    def send_response(self: HttpStream, already_streamed: bool = False):
        body = managed_request_body.get(self.flow)
        # Parsed EOF may still leave bytes queued by H2 or the TCP writer.
        unfinished = body is not None and body.upload_pending
        native = current(self, already_streamed=already_streamed)
        try:
            for command in native:
                yield command
                if unfinished and isinstance(command, HttpResponseHook):
                    # Native waits for request EOF even after a final response.
                    # Cancel only its unfinished upload, preserving that response.
                    yield SendHttp(
                        RequestProtocolError(
                            self.stream_id, "managed upload ended by response", ErrorCode.CANCEL
                        ),
                        self.context.server,
                    )
                    self.client_state = self.state_done
        finally:
            native.close()

    setattr(send_response, _BRIDGE, True)
    HttpStream.send_response = send_response


def install() -> None:
    _install_http2_capacity()
    _install_early_response_completion()
    current = HttpStream.state_stream_request_body
    if hasattr(current, _BRIDGE):
        return

    def state_stream_request_body(
        self: HttpStream, event: RequestData | RequestEndOfMessage
    ) -> layer.CommandGenerator[None]:
        body = managed_request_body.get(self.flow)
        if body is None:
            yield from current(self, event)
            return
        if isinstance(event, RequestData) and not event.data:
            # Empty non-EOS H2 DATA is legal. The public callback reserves b""
            # for EOF, so only native RequestEndOfMessage may invoke it here.
            return
        native = current(self, event)
        try:
            for command in native:
                if isinstance(event, RequestEndOfMessage) and (
                    body.failure is not None or self.flow.error is not None
                ):
                    # Rejection waits for true EOF. Upstream owns cancellation;
                    # its error handler owns the client hook/error/drop ordering.
                    yield SendHttp(
                        RequestProtocolError(
                            self.stream_id, "managed upload rejected", ErrorCode.CANCEL
                        ),
                        self.context.server,
                    )
                    yield from self.handle_protocol_error(
                        ResponseProtocolError(
                            self.stream_id, "managed upload rejected", ErrorCode.KILL
                        )
                    )
                    return
                yield command
        finally:
            native.close()

    setattr(state_stream_request_body, _BRIDGE, True)
    HttpStream.state_stream_request_body = state_stream_request_body
