"""Native H1/H2 EOF and disconnect cleanup after public body discard."""

from collections import deque
from unittest.mock import patch

import pytest
from h2.config import H2Configuration
from h2.connection import H2Connection
from h2.events import DataReceived, RequestReceived, StreamEnded, StreamReset
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.proxy import commands, events
from mitmproxy.proxy.layers.http import HTTPMode
from mitmproxy.proxy.layers.http._hooks import HttpRequestHeadersHook
from mitmproxy.test import taddons

import managed_openrouter as managed
import managed_request_body
import mitm_addon
import request_streaming
from tests.managed_openrouter_helpers import PATHS, PRESET, sandbox
from tests.mitmproxy_http_framing_helpers import start_http_layer
from tests.request_handler_helpers import _write_registry
from tests.upstream_connection_helpers import mark_connected_tls_upstream


@pytest.mark.parametrize("dialect", ["openai-completions", "openai-responses"])
@pytest.mark.parametrize(
    ("http2", "ending"),
    [(False, "eof"), (True, "eof"), (False, "disconnect"), (True, "disconnect"), (True, "reset")],
)
async def test_rejected_body_discards_until_native_eof_or_client_termination(
    tmp_path, fake_firewall_headers, dialect, http2, ending
):
    info = sandbox(tmp_path, dialect)
    info["captureNetworkBodies"] = True
    registry = _write_registry(tmp_path, sandbox_info=info)
    prefix = b'{"model":"' + PRESET.encode() + b'",'
    invalid = b'"provider":'
    remainder = b'{},"metadata":{"private":"discard-canary"}}'
    body = prefix + invalid + remainder
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as context,
        fake_firewall_headers(headers={"Authorization": "Bearer deferred"}) as auth,
    ):
        context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry)
        )
        client, native = start_http_layer(
            context,
            alpn=b"h2" if http2 else b"http/1.1",
            host="openrouter.ai",
            mode=HTTPMode.transparent,
        )
        guest = H2Connection(H2Configuration(client_side=True, header_encoding=None))
        provider = H2Connection(H2Configuration(client_side=False, header_encoding=None))
        upstream, downstream, closed, flows, ended, resets = (
            bytearray(),
            bytearray(),
            [],
            [],
            [],
            [],
        )
        provider_ready = False

        async def dispatch(incoming):
            nonlocal provider_ready
            pending = deque(native.handle_event(incoming))
            while pending:
                command = pending.popleft()
                if isinstance(command, commands.StartHook):
                    if isinstance(command, HttpRequestHeadersHook):
                        flow = command.flow
                        flows.append(flow)
                        mark_connected_tls_upstream(
                            flow,
                            sni="openrouter.ai",
                            server_address=("openrouter.ai", 443),
                            peername=("104.18.32.47", 443),
                        )
                        flow.server_conn.alpn = b"h2" if http2 else b"http/1.1"
                    await context.master.addons.invoke_addon(mitm_addon, command)
                    pending.extend(native.handle_event(events.HookCompleted(command, None)))
                elif isinstance(command, commands.SendData):
                    if command.connection == client:
                        downstream.extend(command.data)
                    elif http2:
                        if not provider_ready:
                            provider.initiate_connection()
                            provider_ready = True
                        for event in provider.receive_data(command.data):
                            if isinstance(event, DataReceived):
                                upstream.extend(event.data)
                            elif isinstance(event, StreamEnded):
                                ended.append(event.stream_id)
                            elif isinstance(event, StreamReset):
                                resets.append(event.stream_id)
                            elif isinstance(event, RequestReceived):
                                assert dict(event.headers)[b"authorization"] == b"Bearer deferred"
                        reply = provider.data_to_send()
                        if reply:
                            pending.extend(
                                native.handle_event(events.DataReceived(command.connection, reply))
                            )
                    else:
                        upstream.extend(command.data)
                elif isinstance(command, commands.CloseConnection):
                    closed.append(command.connection)
                elif isinstance(command, commands.OpenConnection):
                    pytest.fail("the verified native upstream should be reused")

        if http2:
            guest.initiate_connection()
            guest.send_headers(
                1,
                [
                    (b":method", b"POST"),
                    (b":scheme", b"https"),
                    (b":authority", b"openrouter.ai"),
                    (b":path", PATHS[dialect].encode()),
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode()),
                ],
            )
            guest.send_data(1, prefix)
            first = guest.data_to_send()
        else:
            first = (
                b"POST "
                + PATHS[dialect].encode()
                + b" HTTP/1.1\r\nHost: openrouter.ai\r\nContent-Type: application/json\r\n"
                + b"Content-Length: "
                + str(len(body)).encode()
                + b"\r\n\r\n"
                + prefix
            )
        await dispatch(events.DataReceived(client, first))
        [flow] = flows
        stored = managed_request_body.get(flow)
        assert stored is not None
        if not http2:
            assert bytes(upstream).split(b"\r\n\r\n", 1)[1] == prefix
        else:
            assert upstream == prefix
        accepted = bytes(upstream)

        async def send_chunk(chunk):
            if http2:
                guest.send_data(1, chunk)
                chunk = guest.data_to_send()
            await dispatch(events.DataReceived(client, chunk))

        await send_chunk(invalid)
        assert stored.failure is not None
        assert stored.validator is None
        assert stored.tail == b""
        await send_chunk(remainder[:-1])
        assert bytes(upstream) == accepted
        assert stored.received == len(body) - 1
        assert request_streaming.streamed_request_size(flow) == len(body) - 1
        assert not ended
        if http2:
            await send_chunk(b"")

        if ending == "eof":
            await send_chunk(remainder[-1:])
            if http2:
                guest.end_stream(1)
                await dispatch(events.DataReceived(client, guest.data_to_send()))
        elif ending == "disconnect":
            await dispatch(events.ConnectionClosed(client))
        else:
            guest.reset_stream(1)
            await dispatch(events.DataReceived(client, guest.data_to_send()))

        auth.assert_awaited_once()
        assert flow.error is not None
        assert not flow.live
        assert bytes(upstream) == accepted
        assert not ended
        assert stored.closed
        assert managed.admission_state_for_tests() == (0, 0)
        assert not native.streams
        if http2:
            assert resets == [1]
            if ending == "eof":
                assert any(
                    isinstance(event, StreamReset)
                    for event in guest.receive_data(bytes(downstream))
                )
        else:
            assert flow.server_conn in closed
