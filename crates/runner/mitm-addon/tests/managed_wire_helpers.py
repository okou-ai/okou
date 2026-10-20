"""Native HTTP peers with incremental provider digests and bounded wire input."""

import hashlib
from collections import deque

import h11
import pytest
from h2.config import H2Configuration
from h2.connection import H2Connection
from h2.events import DataReceived, RequestReceived, StreamEnded, StreamReset
from mitmproxy import connection, http
from mitmproxy.proxy import commands, events
from mitmproxy.proxy.context import Context
from mitmproxy.proxy.layers.http import HttpLayer, HTTPMode
from mitmproxy.proxy.layers.http._hooks import HttpRequestHeadersHook

import mitm_addon
from tests.managed_openrouter_helpers import PATHS, PI_ATTRIBUTION_HEADERS
from tests.upstream_connection_helpers import mark_connected_tls_upstream


class WireSession:
    def __init__(self, context, *, client_h2=False, provider_h2=False):
        self.context = context
        self.client_h2 = client_h2
        self.provider_h2 = provider_h2
        self.client = connection.Client(
            peername=("10.200.0.5", 12345),
            sockname=("127.0.0.1", 8080),
            state=connection.ConnectionState.OPEN,
            tls=True,
            alpn=b"h2" if client_h2 else b"http/1.1",
            sni="openrouter.ai",
        )
        native_context = Context(self.client, context.options)
        native_context.server.address = ("openrouter.ai", 443)
        native_context.server.tls = True
        self.native = HttpLayer(native_context, HTTPMode.transparent)
        self.initial = list(self.native.handle_event(events.Start()))
        self.guest = H2Connection(H2Configuration(client_side=True, header_encoding=None))
        self.provider = H2Connection(H2Configuration(client_side=False, header_encoding=None))
        self.http1 = h11.Connection(h11.SERVER)
        self.provider.initiate_connection()
        self._flow: http.HTTPFlow | None = None
        self.request_headers: dict[bytes, bytes] = {}
        self.digest = hashlib.sha256()
        self.received = 0
        self.upstream_ended = False
        self.upstream_reset = False
        self.response = bytearray()
        self.response_ended = False
        self.closed = []

    @property
    def flow(self) -> http.HTTPFlow:
        assert self._flow is not None, "start must establish the native flow"
        return self._flow

    def close(self) -> None:
        if self._flow is not None:
            mitm_addon.error(self._flow)

    async def drive(self, event=None):
        pending = deque(self.initial if event is None else self.native.handle_event(event))
        self.initial = []
        while pending:
            command = pending.popleft()
            if isinstance(command, commands.StartHook):
                if isinstance(command, HttpRequestHeadersHook):
                    self._flow = command.flow
                    mark_connected_tls_upstream(
                        self.flow,
                        sni="openrouter.ai",
                        server_address=("openrouter.ai", 443),
                        peername=("104.18.32.47", 443),
                    )
                    self.flow.server_conn.alpn = b"h2" if self.provider_h2 else b"http/1.1"
                await self.context.master.addons.invoke_addon(mitm_addon, command)
                pending.extend(self.native.handle_event(events.HookCompleted(command)))
            elif isinstance(command, commands.SendData):
                if command.connection is self.client:
                    if self.client_h2:
                        for reply in self.guest.receive_data(command.data):
                            if isinstance(reply, DataReceived):
                                self.response.extend(reply.data)
                                self.guest.acknowledge_received_data(
                                    reply.flow_controlled_length, reply.stream_id
                                )
                            elif isinstance(reply, StreamEnded):
                                self.response_ended = True
                        feedback = self.guest.data_to_send()
                        if feedback:
                            pending.extend(
                                self.native.handle_event(events.DataReceived(self.client, feedback))
                            )
                    else:
                        self.response.extend(command.data)
                elif self.provider_h2:
                    for item in self.provider.receive_data(command.data):
                        if isinstance(item, RequestReceived):
                            self.request_headers = dict(item.headers)
                        elif isinstance(item, DataReceived):
                            self.digest.update(item.data)
                            self.received += len(item.data)
                            self.provider.acknowledge_received_data(
                                item.flow_controlled_length, item.stream_id
                            )
                        elif isinstance(item, StreamEnded):
                            self.upstream_ended = True
                        elif isinstance(item, StreamReset):
                            self.upstream_reset = True
                    feedback = self.provider.data_to_send()
                    if feedback:
                        pending.extend(
                            self.native.handle_event(
                                events.DataReceived(command.connection, feedback)
                            )
                        )
                else:
                    self.http1.receive_data(command.data)
                    while True:
                        item = self.http1.next_event()
                        if item is h11.NEED_DATA or item is h11.PAUSED:
                            break
                        if isinstance(item, h11.Request):
                            self.request_headers = dict(item.headers)
                        elif isinstance(item, h11.Data):
                            self.digest.update(item.data)
                            self.received += len(item.data)
                        elif isinstance(item, h11.EndOfMessage):
                            self.upstream_ended = True
                            break
            elif isinstance(command, commands.OpenConnection):
                pytest.fail("wire fixture must reuse its verified upstream")
            elif isinstance(command, commands.CloseConnection):
                self.closed.append(command.connection)

    async def start(self, length, dialect, *, expect_stream=True):
        if self.client_h2:
            self.guest.initiate_connection()
        await self.drive()
        headers = [
            (b"content-type", b"application/json"),
            (b"content-length", str(length).encode()),
            *((key.lower().encode(), value.encode()) for key, value in PI_ATTRIBUTION_HEADERS),
        ]
        if self.client_h2:
            self.guest.send_headers(
                1,
                [
                    (b":method", b"POST"),
                    (b":scheme", b"https"),
                    (b":authority", b"openrouter.ai"),
                    (b":path", PATHS[dialect].encode()),
                    *headers,
                ],
            )
            wire = self.guest.data_to_send()
        else:
            wire = b"POST " + PATHS[dialect].encode() + b" HTTP/1.1\r\nHost: openrouter.ai\r\n"
            wire += b"".join(key + b": " + value + b"\r\n" for key, value in headers) + b"\r\n"
        await self.drive(events.DataReceived(self.client, wire))
        assert self._flow is not None
        assert self.flow.error is None
        if expect_stream:
            assert self.request_headers
            assert self.request_headers[b"content-length"] == str(length).encode()

    async def write(self, content, *, final=False):
        if self.client_h2:
            offset = 0
            while offset < len(content):
                count = min(
                    len(content) - offset,
                    self.guest.local_flow_control_window(1),
                    self.guest.max_outbound_frame_size,
                )
                assert count > 0, "native peer must replenish consumed ingress capacity"
                self.guest.send_data(
                    1,
                    content[offset : offset + count],
                    end_stream=final and offset + count == len(content),
                )
                await self.drive(events.DataReceived(self.client, self.guest.data_to_send()))
                offset += count
            if not content:
                self.guest.send_data(1, b"", end_stream=final)
                await self.drive(events.DataReceived(self.client, self.guest.data_to_send()))
        else:
            await self.drive(events.DataReceived(self.client, content))

    async def respond(self, *, final=False, first=True, status=200):
        assert self.flow is not None
        if self.provider_h2:
            if first:
                self.provider.send_headers(
                    1, [(b":status", str(status).encode()), (b"content-type", b"text/event-stream")]
                )
            self.provider.send_data(1, b"data: {}\n\n", end_stream=final)
            wire = self.provider.data_to_send()
        else:
            wire = b""
            if first:
                wire += self.http1.send(
                    h11.Response(
                        status_code=status, headers=[(b"content-type", b"text/event-stream")]
                    )
                )
            wire += self.http1.send(h11.Data(data=b"data: {}\n\n"))
            if final:
                wire += self.http1.send(h11.EndOfMessage())
        await self.drive(events.DataReceived(self.flow.server_conn, wire))
