"""Complete rejected header auth before its upload finishes.

Installed only by the exact-version mitmproxy compatibility owner. Public local
responses wait for request EOF in 12.2.3; these responses already have a terminal
authorization decision and must not enter that buffering/waiting state.
Native H1 discards later upload data after the HTTP flow has completed; its
framing, peer disconnect and existing TCP timeout own receive-side retirement.
"""

from mitmproxy import http
from mitmproxy.proxy import commands, events, layer
from mitmproxy.proxy.layers.http import HttpStream, SendHttp
from mitmproxy.proxy.layers.http._events import ResponseEndOfMessage
from mitmproxy.proxy.layers.http._hooks import HttpResponseHeadersHook
from mitmproxy.proxy.layers.http._http2 import Http2Server

_MARKER = "_okou_header_auth_response"
_PENDING = "_okou_header_auth_responses_pending"


class _LocalResponseEnd(ResponseEndOfMessage):
    """Retire the rejected H2 upload only after this response has been sent."""


class _PendingResponses:
    def __init__(self) -> None:
        self.streams: set[int] = set()


def mark(flow: http.HTTPFlow) -> None:
    flow.metadata[_MARKER] = True


def take(flow: http.HTTPFlow) -> bool:
    return flow.metadata.pop(_MARKER, False) is True


def send(stream: HttpStream) -> layer.CommandGenerator[None]:
    """Use native hooks/framing, skipping the rejected request-body state."""
    if stream.flow.response is None:
        raise RuntimeError("Header auth rejection requires its local response")
    http1 = not (stream.flow.request.is_http2 or stream.flow.request.is_http3)
    if http1:
        stream.flow.response.headers["Connection"] = "close"
    stream.client_state = stream.state_done
    try:
        yield HttpResponseHeadersHook(stream.flow)
        for command in stream.send_response():
            if isinstance(command, SendHttp) and isinstance(command.event, ResponseEndOfMessage):
                yield SendHttp(_LocalResponseEnd(stream.stream_id), command.connection)
            else:
                yield command
        if http1:
            # A full close can race a still-writing fetch caller and replace the
            # delivered response with EPIPE. FIN only our write half; native H1
            # discards the rejected upload until its framing ends or it disconnects.
            yield commands.CloseTcpConnection(stream.context.client, half_close=True)
    finally:
        # DATA already queued behind a hook may resume after DropStream.
        stream.client_state = stream.server_state = stream.state_errored


def install() -> None:
    native = Http2Server._handle_event
    if hasattr(native, _MARKER):
        return

    def handle(self: Http2Server, event: events.Event) -> layer.CommandGenerator[None]:
        pending = getattr(self, _PENDING, None)
        if isinstance(event, _LocalResponseEnd):
            if not isinstance(pending, _PendingResponses):
                pending = _PendingResponses()
                setattr(self, _PENDING, pending)
            pending.streams.add(event.stream_id)
        else:
            yield from native(self, event)
        if not isinstance(pending, _PendingResponses):
            return
        if isinstance(event, events.ConnectionClosed):
            for stream_id in pending.streams:
                self.h2_conn.stream_buffers.pop(stream_id, None)
                self.h2_conn.stream_trailers.pop(stream_id, None)
            pending.streams.clear()
            delattr(self, _PENDING)
            return
        for stream_id in tuple(pending.streams):
            if self.is_open_for_us(stream_id) and not self.h2_conn.stream_buffers.get(stream_id):
                # Queueing an empty EOM behind blocked DATA makes native flush
                # require extra credit even when every response byte was sent.
                # Once DATA drains, native EOM needs no flow-control credit.
                yield from native(self, ResponseEndOfMessage(stream_id))
            if self.is_closed(stream_id):
                # Native protocol-error closure switches directly to done, so
                # a later ConnectionClosed event cannot release queued DATA.
                self.h2_conn.stream_buffers.pop(stream_id, None)
                self.h2_conn.stream_trailers.pop(stream_id, None)
                pending.streams.remove(stream_id)
                self.streams.pop(stream_id, None)
            elif not self.is_open_for_us(stream_id):
                # END_STREAM is now on the wire. Resetting while DATA is still
                # waiting for peer credit would clear the native response buffer.
                self.h2_conn.reset_stream(stream_id, error_code=0)
                self.streams.pop(stream_id, None)
                pending.streams.remove(stream_id)
        data = self.h2_conn.data_to_send()
        if data:
            yield commands.SendData(self.conn, data)
        if not pending.streams:
            delattr(self, _PENDING)

    setattr(handle, _MARKER, True)
    Http2Server._handle_event = handle
