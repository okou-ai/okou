"""Pinned native request-body interception; HTTP framing stays with mitmproxy."""

import asyncio
from collections.abc import Callable
from dataclasses import dataclass, field
from http import HTTPStatus
from typing import Literal

from mitmproxy import http
from mitmproxy.proxy import commands, events, layer
from mitmproxy.proxy.layers.http import HttpStream, SendHttp
from mitmproxy.proxy.layers.http._base import ReceiveHttp
from mitmproxy.proxy.layers.http._events import (
    ErrorCode,
    RequestData,
    RequestEndOfMessage,
    RequestHeaders,
    RequestProtocolError,
    RequestTrailers,
    ResponseData,
    ResponseEndOfMessage,
    ResponseHeaders,
    ResponseProtocolError,
)
from mitmproxy.proxy.layers.http._hooks import HttpRequestHook
from mitmproxy.proxy.layers.http._http1 import Http1Client
from mitmproxy.proxy.layers.http._http2 import Http2Client

import managed_request_body

_BRIDGE = "_managed_request_body_bridge"
_REQUEST_HOOK_RESUMED = "_managed_request_hook_resumed"
_BODY_EVENT_ATTRIBUTE = "_managed_request_upload"
_HTTP2_UPLOADS = "_managed_request_uploads"
_HTTP1_UPLOAD = "_managed_request_upload"


def _observe_response(
    body: managed_request_body.TemporaryBody | None, command: commands.Command
) -> bool:
    if body is None or body.closed or not isinstance(command, ReceiveHttp):
        return False
    event = command.event
    if isinstance(event, ResponseHeaders):
        body.early_response_status = event.response.status_code
    if isinstance(event, ResponseProtocolError) or (
        isinstance(event, ResponseEndOfMessage)
        and body.early_response_status is not None
        and body.early_response_status >= HTTPStatus.BAD_REQUEST
    ):
        body.stop()
        return True
    if isinstance(event, ResponseData):
        body.early_response_bytes += len(event.data)
        if body.early_response_bytes > managed_request_body.CHUNK_BYTES:
            body.failure = "upstream_response_buffer"
            body.close()
    return False


def _observe_commands(native, observe) -> layer.CommandGenerator[None]:
    try:
        command = next(native)
        while True:
            observe(command)
            try:
                completion = yield command
            except GeneratorExit:
                raise
            except BaseException as error:
                command = native.throw(error)
            else:
                command = native.send(completion)
    except StopIteration:
        return
    finally:
        native.close()


def _install_http1_upload_progress() -> None:
    current = Http1Client._handle_event
    if hasattr(current, _BRIDGE):
        return

    def handle_event(self: Http1Client, event: events.Event) -> layer.CommandGenerator[None]:
        body = getattr(event, _BODY_EVENT_ATTRIBUTE, None)
        if isinstance(event, RequestHeaders) and isinstance(
            body, managed_request_body.TemporaryBody
        ):
            setattr(self, _HTTP1_UPLOAD, body)
        else:
            body = getattr(self, _HTTP1_UPLOAD, None)
        if (
            isinstance(event, RequestEndOfMessage)
            and isinstance(body, managed_request_body.TemporaryBody)
            and body.stopped
        ):
            # An early final response is already complete. Closing aborts the
            # incomplete upload without emitting an invalid HTTP/1 terminator.
            yield commands.CloseConnection(self.conn)
            return
        if isinstance(body, managed_request_body.TemporaryBody) and not body.closed:
            yield from _observe_commands(
                current(self, event), lambda command: _observe_response(body, command)
            )
        else:
            yield from current(self, event)

    setattr(handle_event, _BRIDGE, True)
    Http1Client._handle_event = handle_event


def request_hook_resumed(hook: HttpRequestHook) -> bool:
    return getattr(hook, _REQUEST_HOOK_RESUMED, False) is True


class _Http2Uploads:
    def __init__(self) -> None:
        self.bodies: dict[int, managed_request_body.TemporaryBody] = {}

    def update(self, client: Http2Client) -> None:
        for stream_id, body in tuple(self.bodies.items()):
            if body.closed:
                del self.bodies[stream_id]
                continue
            upstream_id = client.our_stream_id.get(stream_id)
            pending = upstream_id is None or client.h2_conn.stream_buffers.get(upstream_id)
            if pending:
                body.replay_ready.clear()
            else:
                body.replay_ready.set()


def _install_http2_upload_progress() -> None:
    current = Http2Client._handle_event
    if hasattr(current, _BRIDGE):
        return

    def handle_event(self: Http2Client, event: events.Event) -> layer.CommandGenerator[None]:
        uploads = getattr(self, _HTTP2_UPLOADS, None)
        body = getattr(event, _BODY_EVENT_ATTRIBUTE, None)
        if isinstance(event, RequestHeaders) and isinstance(
            body, managed_request_body.TemporaryBody
        ):
            if not isinstance(uploads, _Http2Uploads):
                uploads = _Http2Uploads()
                setattr(self, _HTTP2_UPLOADS, uploads)
            uploads.bodies[event.stream_id] = body
        try:

            def observe(command):
                if isinstance(uploads, _Http2Uploads) and isinstance(command, ReceiveHttp):
                    body = uploads.bodies.get(command.event.stream_id)
                    if _observe_response(body, command):
                        upstream_id = self.our_stream_id.get(command.event.stream_id)
                        if upstream_id is not None and not self.is_closed(upstream_id):
                            # The complete error response can still reach the
                            # client. Reset only the unfinished outbound body.
                            self.h2_conn.reset_stream(upstream_id)

            if isinstance(uploads, _Http2Uploads) and uploads.bodies:
                yield from _observe_commands(current(self, event), observe)
            else:
                yield from current(self, event)
        finally:
            if isinstance(uploads, _Http2Uploads):
                uploads.update(self)

    setattr(handle_event, _BRIDGE, True)
    Http2Client._handle_event = handle_event


@dataclass
class ManagedRequestBodyHook(commands.StartHook):
    """Join one receive, finish, or replay step and its native continuation."""

    name = "managedrequestbody"
    flow: http.HTTPFlow
    stage: Literal["receive", "finish", "replay"]
    data: bytes = field(default=b"", repr=False)
    completed: asyncio.Future[None] | None = field(default=None, repr=False)
    resumed: bool = False

    def args(self) -> list[object]:
        return [self.flow, self.stage, self.data]


def install(register: Callable[[ManagedRequestBodyHook], None]) -> None:
    _install_http1_upload_progress()
    _install_http2_upload_progress()
    current = HttpStream.state_consume_request_body
    if hasattr(current, _BRIDGE):
        return

    def state_consume_request_body(
        self: HttpStream,
        event: events.Event,
    ) -> layer.CommandGenerator[None]:
        body = managed_request_body.get(self.flow)
        if body is None:
            yield from current(self, event)
            return

        def checkpoint(stage: Literal["receive", "finish", "replay"], data: bytes = b""):
            hook = ManagedRequestBodyHook(self.flow, stage, data)
            # The finish checkpoint owns the entire upload continuation.
            # Replay hooks drain writers, but do not accumulate one completed
            # reader checkpoint per outbound chunk while that owner waits.
            if stage != "replay":
                register(hook)
            try:
                yield hook
            finally:
                hook.resumed = True
                hook.data = b""

        if isinstance(event, RequestData):
            yield from checkpoint("receive", event.data)
            yield from self.check_killed(True)
            return
        if isinstance(event, RequestTrailers):
            self.flow.request.trailers = event.trailers
            return
        if not isinstance(event, RequestEndOfMessage):
            yield from current(self, event)
            return

        yield from checkpoint("finish")
        if (yield from self.check_killed(True)):
            return
        # The native buffer remains empty; the normal request hook performs
        # current authorization before native connection acquisition and TLS.
        native = current(self, event)
        try:
            command = next(native)
            while True:
                if isinstance(command, SendHttp) and command.connection == self.context.server:
                    if isinstance(command.event, RequestHeaders):
                        command.event.end_stream = False
                        setattr(command.event, _BODY_EVENT_ATTRIBUTE, body)
                    elif isinstance(command.event, RequestEndOfMessage):
                        while not body.closed:
                            yield from checkpoint("replay")
                            if self.flow.error is not None:
                                yield SendHttp(
                                    RequestProtocolError(
                                        self.stream_id,
                                        "managed upload interrupted",
                                        ErrorCode.CANCEL,
                                    ),
                                    self.context.server,
                                )
                            if (yield from self.check_killed(True)):
                                return
                            chunk = body.take_chunk()
                            if not chunk:
                                break
                            yield SendHttp(RequestData(self.stream_id, chunk), self.context.server)
                            body.replayed += len(chunk)
                            del chunk
                try:
                    if isinstance(command, HttpRequestHook):
                        setattr(command, _REQUEST_HOOK_RESUMED, False)
                        try:
                            completion = yield command
                        finally:
                            setattr(command, _REQUEST_HOOK_RESUMED, True)
                    else:
                        completion = yield command
                except GeneratorExit:
                    raise
                except BaseException as error:
                    command = native.throw(error)
                else:
                    command = native.send(completion)
        except StopIteration:
            return
        finally:
            native.close()

    setattr(state_consume_request_body, _BRIDGE, True)
    HttpStream.state_consume_request_body = state_consume_request_body
