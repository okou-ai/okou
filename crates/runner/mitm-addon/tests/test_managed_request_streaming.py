"""Native wire acceptance of each removed managed limit with bounded peer buffers."""

import hashlib
from collections import deque
from unittest.mock import patch

import h11
import pytest
from h2.config import H2Configuration
from h2.connection import H2Connection
from h2.events import DataReceived, ResponseReceived, StreamEnded
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.proxy import commands, events
from mitmproxy.proxy.layers.http import HTTPMode
from mitmproxy.proxy.layers.http._hooks import HttpRequestHeadersHook
from mitmproxy.test import taddons

import managed_openrouter as managed
import managed_request_body
import mitm_addon
import request_streaming
from tests.managed_openrouter_helpers import PATHS, PI_ATTRIBUTION_HEADERS, PRESET, sandbox
from tests.mitmproxy_http_framing_helpers import start_http_layer
from tests.request_handler_helpers import _write_registry
from tests.upstream_connection_helpers import mark_connected_tls_upstream

_SSE = b'data: {"ok":true}\n\n'


class UploadPeer:
    """Drive native HTTP framing; hash provider bytes without retaining uploads."""

    def __init__(self, context, *, http2):
        self.context = context
        self.http2 = http2
        self.initial = []
        self.client, self.native = start_http_layer(
            context,
            alpn=b"h2" if http2 else b"http/1.1",
            host="openrouter.ai",
            mode=HTTPMode.transparent,
            commands_out=self.initial,
        )
        self.peer = H2Connection(H2Configuration(client_side=True, header_encoding=None))
        self.provider = h11.Connection(h11.SERVER)
        self.flow = None
        self.headers = None
        self.received = 0
        self.digest = hashlib.sha256()
        self.upload_ended = False
        self.response_ended = False
        self.response_bytes = bytearray()

    async def dispatch(self, incoming=None):
        pending = deque(self.initial if incoming is None else self.native.handle_event(incoming))
        self.initial = []
        while pending:
            command = pending.popleft()
            if isinstance(command, commands.StartHook):
                if isinstance(command, HttpRequestHeadersHook):
                    self.flow = command.flow
                    mark_connected_tls_upstream(
                        self.flow,
                        sni="openrouter.ai",
                        server_address=("openrouter.ai", 443),
                        peername=("104.18.32.47", 443),
                    )
                    self.flow.server_conn.alpn = b"http/1.1"
                await self.context.master.addons.invoke_addon(mitm_addon, command)
                pending.extend(self.native.handle_event(events.HookCompleted(command, None)))
            elif isinstance(command, commands.SendData):
                if command.connection == self.client:
                    if self.http2:
                        for event in self.peer.receive_data(command.data):
                            if isinstance(event, ResponseReceived):
                                assert (b":status", b"200") in event.headers
                            elif isinstance(event, DataReceived):
                                self.response_bytes.extend(event.data)
                                self.peer.acknowledge_received_data(
                                    event.flow_controlled_length, event.stream_id
                                )
                            elif isinstance(event, StreamEnded):
                                self.response_ended = True
                    else:
                        self.response_bytes.extend(command.data)
                else:
                    self.provider.receive_data(command.data)
                    while True:
                        event = self.provider.next_event()
                        if event is h11.NEED_DATA or event is h11.PAUSED:
                            break
                        if isinstance(event, h11.Request):
                            self.headers = dict(event.headers)
                        elif isinstance(event, h11.Data):
                            self.received += len(event.data)
                            self.digest.update(event.data)
                        elif isinstance(event, h11.EndOfMessage):
                            self.upload_ended = True
                            break
            elif isinstance(command, commands.OpenConnection):
                pytest.fail("the verified upstream should be reused")
        if self.http2:
            feedback = self.peer.data_to_send()
            if feedback:
                await self.dispatch(events.DataReceived(self.client, feedback))

    async def start(self, length, dialect):
        fields = [
            (b"content-type", b"application/json"),
            (b"content-length", str(length).encode()),
            *((key.lower().encode(), value.encode()) for key, value in PI_ATTRIBUTION_HEADERS),
        ]
        if self.http2:
            self.peer.initiate_connection()
            await self.dispatch()
            self.peer.send_headers(
                1,
                [
                    (b":method", b"POST"),
                    (b":scheme", b"https"),
                    (b":authority", b"openrouter.ai"),
                    (b":path", PATHS[dialect].encode()),
                    *fields,
                ],
            )
            wire = self.peer.data_to_send()
        else:
            wire = (
                b"POST "
                + PATHS[dialect].encode()
                + b" HTTP/1.1\r\nHost: openrouter.ai\r\n"
                + b"".join(key + b": " + value + b"\r\n" for key, value in fields)
                + b"\r\n"
            )
        await self.dispatch(events.DataReceived(self.client, wire))
        assert self.flow is not None
        assert self.flow.error is None
        assert self.headers is not None
        assert self.headers[b"content-length"] == str(length).encode()
        assert self.headers[b"authorization"] == b"Bearer limit-removal"

    async def send(self, chunk, *, end=False):
        if self.http2:
            offset = 0
            while offset < len(chunk):
                capacity = self.peer.local_flow_control_window(1)
                assert capacity > 0, "native ingress must replenish consumed capacity"
                size = min(len(chunk) - offset, capacity, self.peer.max_outbound_frame_size)
                offset_end = offset + size
                self.peer.send_data(
                    1, chunk[offset:offset_end], end_stream=end and offset_end == len(chunk)
                )
                await self.dispatch(events.DataReceived(self.client, self.peer.data_to_send()))
                offset = offset_end
        else:
            await self.dispatch(events.DataReceived(self.client, chunk))

    async def respond(self, *, end=False):
        assert self.flow is not None
        if end:
            wire = self.provider.send(h11.EndOfMessage())
        else:
            wire = self.provider.send(
                h11.Response(
                    status_code=200,
                    headers=[(b"content-type", b"text/event-stream")],
                )
            ) + self.provider.send(h11.Data(data=_SSE))
        await self.dispatch(events.DataReceived(self.flow.server_conn, wire))


@pytest.mark.parametrize("dialect", ["openai-completions", "openai-responses"])
@pytest.mark.parametrize("http2", [False, True])
@pytest.mark.parametrize("capture", [False, True])
@pytest.mark.parametrize(
    ("count", "opaque_bytes"),
    [(1, 40 * 1024 * 1024), (20, 64), (5, 30 * 1024 * 1024)],
    ids=["over-32MiB-body", "over-16-live-requests", "over-128MiB-aggregate"],
)
async def test_removed_managed_limits_through_native_wire(
    tmp_path, fake_firewall_headers, dialect, http2, capture, count, opaque_bytes
):
    info = sandbox(tmp_path, dialect)
    info["captureNetworkBodies"] = capture
    registry = _write_registry(tmp_path, sandbox_info=info)
    key = b"messages" if dialect == "openai-completions" else b"input"
    prefix = b'{"model":"' + PRESET.encode() + b'","' + key + b'":[{"content":"'
    suffix = "\U0001f642".encode() + b'"}]}'
    length = len(prefix) + opaque_bytes + len(suffix)
    # Neither the input fixture nor the provider accumulates complete bodies.
    chunk = b"x" * 16384
    expected = hashlib.sha256()
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as context,
        fake_firewall_headers(headers={"Authorization": "Bearer limit-removal"}),
    ):
        context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry)
        )
        peers = [UploadPeer(context, http2=http2) for _ in range(count)]
        try:
            # All headers coexist before upload: this isolates count/declared-byte admission.
            for peer in peers:
                await peer.start(length, dialect)
            expected.update(prefix)
            for peer in peers:
                await peer.send(prefix)
            # Round-robin input keeps all large uploads live across the old aggregate limit.
            for offset in range(0, opaque_bytes, len(chunk)):
                part = chunk[: min(len(chunk), opaque_bytes - offset)]
                expected.update(part)
                for peer in peers:
                    await peer.send(part)
                    assert peer.flow is not None
                    assert peer.flow.request.raw_content is None
            expected.update(suffix)
            for peer in peers:
                # Split a UTF-8 scalar across native reads.
                await peer.send(suffix[:1])
                await peer.send(suffix[1:], end=True)
                assert peer.flow is not None
                assert peer.upload_ended
                assert peer.received == length
                assert peer.digest.digest() == expected.digest()
                assert request_streaming.streamed_request_size(peer.flow) == length
                await peer.respond()
            # All SSEs are live; none owns a complete upload or an admission lease.
            assert managed.admission_state_for_tests() == (0, 0)
            for peer in peers:
                assert peer.flow is not None
                assert peer.flow.live
                assert peer.flow.error is None
                assert peer.flow.response is not None
                assert peer.flow.response.status_code == 200
                assert peer.flow.request.raw_content is None
                body = managed_request_body.get(peer.flow)
                assert body is not None
                assert body.validator is None
                assert body.tail == b""
                captured = request_streaming.captured_request_stream_body(peer.flow)
                if capture:
                    assert captured is not None
                    assert len(captured.buffer) <= 64 * 1024
                    assert captured.truncated == (length > 64 * 1024)
                else:
                    assert captured is None
                assert _SSE in peer.response_bytes
                if http2:
                    assert not peer.response_ended
                await peer.respond(end=True)
                assert not peer.flow.live
                if http2:
                    assert peer.response_ended
            assert managed.admission_state_for_tests() == (0, 0)
        finally:
            for peer in peers:
                if peer.flow is not None:
                    mitm_addon.error(peer.flow)
