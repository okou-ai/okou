"""Pinned native capacity/terminal gaps for public managed request streaming.

Payload parsing and transformation live in request.stream. These adapters keep
HTTP framing, connection selection, TLS and error/response hooks with mitmproxy.
"""

import asyncio
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Protocol

from mitmproxy import connection, http
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
from mitmproxy.proxy.server import ConnectionHandler

from managed_upload import Phase, Upload, from_request, get

_PATCHED = "_okou_managed_upload_runtime"
_CONNECTION_READERS = "_okou_managed_upload_readers"
_H2_CAPACITY = "_okou_managed_h2_capacity"
_current_reader: ContextVar["Reader | None"] = ContextVar("managed_upload_reader", default=None)


class DrainWriter(Protocol):
    async def drain(self) -> None: ...


@dataclass
class _HeaderWork:
    classified: asyncio.Future[None]
    finished: asyncio.Future[None]
    upload: Upload | None = None


class _ConnectionReaders:
    def __init__(self) -> None:
        self.readers: set[Reader] = set()


class Reader:
    """Pending uploads belong to their connection reader, never a global scan."""

    def __init__(self, handler: ConnectionHandler, conn: connection.Connection) -> None:
        self.handler = handler
        self.connection = conn
        self.uploads: set[Upload] = set()
        self.headers: dict[str, _HeaderWork] = {}
        self.closed = False
        group = getattr(handler, _CONNECTION_READERS, None)
        if not isinstance(group, _ConnectionReaders):
            group = _ConnectionReaders()
            setattr(handler, _CONNECTION_READERS, group)
        self.group = group
        group.readers.add(self)

    def attach(self, upload: Upload) -> None:
        if self.closed:
            upload.close()
            return
        self.uploads.add(upload)
        upload.detach_reader = lambda: self.uploads.discard(upload)
        if upload.flow is not None:
            work = self.headers.get(upload.flow.id)
            if work is not None:
                work.upload = upload

    async def wait_capacity(self) -> None:
        while pending := [
            work.classified for work in self.headers.values() if not work.classified.done()
        ]:
            # A native hook is scheduled, not necessarily started, when the
            # read dispatch returns. Classification must bind its upload first.
            for ready in pending:
                await asyncio.shield(ready)
        for work in tuple(self.headers.values()):
            if work.upload is not None:
                # Include HookCompleted. Waking on parser release alone lets a
                # cancelled header race the reader into the native event lock,
                # where dependency cancellation skips its socket-close guard.
                await asyncio.shield(work.finished)
        for upload in tuple(self.uploads):
            await upload.ready.wait()

    def socket_drained(self) -> None:
        for upload in tuple(self.uploads):
            if upload.phase is Phase.COMPLETE and upload.ready.is_set():
                upload.drained()

    def downstream(self) -> set[DrainWriter] | None:
        """Only the matching client writers may gate an active provider reader."""
        writers: set[DrainWriter] | None = None
        for reader in self.group.readers:
            for upload in reader.uploads:
                flow = upload.flow
                if flow is not None and flow.server_conn is self.connection:
                    if writers is None:
                        writers = set()
                    transport = self.handler.transports.get(flow.client_conn)
                    if transport is not None and transport.writer is not None:
                        writers.add(transport.writer)
        return writers

    def close(self) -> None:
        self.closed = True
        for work in self.headers.values():
            if not work.classified.done():
                work.classified.set_result(None)
            if not work.finished.done():
                work.finished.set_result(None)
        for upload in tuple(self.uploads):
            upload.close()
        self.group.readers.discard(self)


@contextmanager
def reader_scope(handler: ConnectionHandler, conn: connection.Connection) -> Iterator[Reader]:
    reader = Reader(handler, conn)
    token = _current_reader.set(reader)
    try:
        yield reader
    finally:
        _current_reader.reset(token)
        reader.close()


def register(upload: Upload) -> None:
    reader = _current_reader.get()
    if reader is not None:
        reader.attach(upload)


def defer_headers(flow: http.HTTPFlow) -> None:
    reader = _current_reader.get()
    if reader is not None and not reader.closed:
        loop = asyncio.get_running_loop()
        reader.headers[flow.id] = _HeaderWork(loop.create_future(), loop.create_future())


def headers_classified(flow: http.HTTPFlow) -> None:
    reader = _current_reader.get()
    if reader is not None:
        work = reader.headers.get(flow.id)
        if work is not None and not work.classified.done():
            work.classified.set_result(None)


def header_upload(flow: http.HTTPFlow) -> Upload | None:
    reader = _current_reader.get()
    work = reader.headers.get(flow.id) if reader is not None else None
    return work.upload if work is not None else None


def header_finished(flow: http.HTTPFlow) -> None:
    headers_classified(flow)
    reader = _current_reader.get()
    if reader is not None:
        work = reader.headers.pop(flow.id, None)
        if work is not None and not work.finished.done():
            work.finished.set_result(None)


class _H2Capacity:
    def __init__(self) -> None:
        self.pending: dict[int, Upload] = {}

    def refresh(self, client: Http2Client) -> None:
        for logical_id, upload in tuple(self.pending.items()):
            if upload.phase is Phase.CLOSED:
                del self.pending[logical_id]
            elif upload.phase is Phase.REJECTED:
                upload.ready.set()
            else:
                upstream_id = client.our_stream_id.get(logical_id)
                if upstream_id is None or client.h2_conn.stream_buffers.get(upstream_id):
                    upload.ready.clear()
                else:
                    upload.ready.set()
                    if upload.phase is Phase.COMPLETE:
                        if upload.detach_reader is None:
                            upload.drained()
                        del self.pending[logical_id]

    def close_unallocated(self, client: Http2Client) -> layer.CommandGenerator[None]:
        for logical_id, upload in tuple(self.pending.items()):
            if logical_id not in client.our_stream_id:
                client.stream_queue.pop(logical_id, None)
                upload.close()
                yield ReceiveHttp(
                    ResponseProtocolError(
                        logical_id, "managed upload connection closed", ErrorCode.CONNECT_FAILED
                    )
                )


def install() -> None:
    """Called only after the owning compatibility layer verifies exact pins."""
    _install_capacity()
    _install_request_end()
    _install_response_end()


def _install_capacity() -> None:
    native = Http2Client._handle_event
    if hasattr(native, _PATCHED):
        return

    def handle(self: Http2Client, event: events.Event) -> layer.CommandGenerator[None]:
        capacity = getattr(self, _H2_CAPACITY, None)
        if isinstance(event, RequestHeaders):
            upload = from_request(event.request)
            if upload is not None:
                if not isinstance(capacity, _H2Capacity):
                    capacity = _H2Capacity()
                    setattr(self, _H2_CAPACITY, capacity)
                upload.native_h2 = True
                capacity.pending[event.stream_id] = upload
        if isinstance(capacity, _H2Capacity) and isinstance(event, RequestProtocolError):
            logical_id = event.stream_id
            if logical_id in capacity.pending and logical_id not in self.our_stream_id:
                self.stream_queue.pop(logical_id, None)
                capacity.pending.pop(logical_id).close()
                return
        try:
            closed = False
            for command in native(self, event):
                if (
                    isinstance(command, commands.CloseConnection)
                    and command.connection == self.conn
                ):
                    closed = True
                    if isinstance(capacity, _H2Capacity):
                        for logical_id in capacity.pending:
                            upstream_id = self.our_stream_id.get(logical_id)
                            if upstream_id is not None:
                                self.h2_conn.stream_buffers.pop(upstream_id, None)
                yield command
            if closed and isinstance(capacity, _H2Capacity):
                yield from capacity.close_unallocated(self)
        finally:
            if isinstance(capacity, _H2Capacity):
                capacity.refresh(self)

    setattr(handle, _PATCHED, True)
    Http2Client._handle_event = handle


def _install_request_end() -> None:
    native = HttpStream.state_stream_request_body
    if hasattr(native, _PATCHED):
        return

    def stream_body(
        self: HttpStream, event: RequestData | RequestEndOfMessage
    ) -> layer.CommandGenerator[None]:
        upload = get(self.flow)
        if upload is None:
            yield from native(self, event)
            return
        if isinstance(event, RequestData) and not event.data:
            return
        running = native(self, event)
        try:
            for command in running:
                if isinstance(event, RequestEndOfMessage) and upload.phase is Phase.REJECTED:
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
            if (
                isinstance(event, RequestEndOfMessage)
                and not upload.native_h2
                and upload.detach_reader is None
            ):
                upload.drained()
        finally:
            running.close()

    setattr(stream_body, _PATCHED, True)
    HttpStream.state_stream_request_body = stream_body


def _install_response_end() -> None:
    native = HttpStream.send_response
    if hasattr(native, _PATCHED):
        return

    def response(self: HttpStream, already_streamed: bool = False):
        upload = get(self.flow)
        pending = upload is not None and upload.transport_pending
        running = native(self, already_streamed=already_streamed)
        try:
            for command in running:
                yield command
                if pending and isinstance(command, HttpResponseHook):
                    yield SendHttp(
                        RequestProtocolError(
                            self.stream_id, "managed upload completed by response", ErrorCode.CANCEL
                        ),
                        self.context.server,
                    )
                    self.client_state = self.state_done
        finally:
            running.close()

    setattr(response, _PATCHED, True)
    HttpStream.send_response = response
