"""Complete native HTTP dispatch preserves managed uploads and responses."""

import json
from collections import deque
from unittest.mock import patch

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
import mitm_addon
from tests.managed_openrouter_helpers import PATHS, PI_ATTRIBUTION_HEADERS, payload, sandbox
from tests.mitmproxy_http_framing_helpers import start_http_layer
from tests.request_handler_helpers import _write_registry
from tests.upstream_connection_helpers import mark_connected_tls_upstream


@pytest.mark.parametrize("dialect", ["openai-completions", "openai-responses"])
@pytest.mark.parametrize(("http2", "empty_data"), [(False, False), (True, False), (True, True)])
async def test_complete_native_framing_forwards_original_body_and_provider_response(
    tmp_path,
    fake_firewall_headers,
    dialect,
    http2,
    empty_data,
):
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path, dialect))
    value = payload(dialect)
    value["messages" if dialect == "openai-completions" else "input"][0]["content"] = "x" * 40000
    body = json.dumps(value).encode()
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as context,
        fake_firewall_headers(headers={"Authorization": "Bearer native-framing"}) as auth_fetch,
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
        fields = [
            (b"content-type", b"application/json"),
            (b"content-length", str(len(body)).encode()),
            *((key.lower().encode(), value.encode()) for key, value in PI_ATTRIBUTION_HEADERS),
        ]
        peer = H2Connection(H2Configuration(client_side=True, header_encoding=None))
        if http2:
            peer.initiate_connection()
            peer.send_headers(
                1,
                [
                    (b":method", b"POST"),
                    (b":scheme", b"https"),
                    (b":authority", b"openrouter.ai"),
                    (b":path", PATHS[dialect].encode()),
                    *fields,
                ],
            )
            if empty_data:
                peer.send_data(1, b"")
            for offset in range(0, len(body), 16384):
                peer.send_data(1, body[offset : offset + 16384])
            if empty_data:
                peer.send_data(1, b"")
            peer.end_stream(1)
            wire = peer.data_to_send()
        else:
            wire = (
                b"POST "
                + PATHS[dialect].encode()
                + b" HTTP/1.1\r\nHost: openrouter.ai\r\n"
                + b"".join(key + b": " + value + b"\r\n" for key, value in fields)
                + b"\r\n"
                + body
            )
        upstream, downstream, flows = bytearray(), bytearray(), []

        async def dispatch(incoming):
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
                        flow.server_conn.alpn = b"http/1.1"
                    await context.master.addons.invoke_addon(mitm_addon, command)
                    pending.extend(native.handle_event(events.HookCompleted(command, None)))
                elif isinstance(command, commands.SendData):
                    (downstream if command.connection == client else upstream).extend(command.data)
                elif isinstance(command, commands.OpenConnection):
                    pytest.fail("the existing verified upstream connection should be reused")

        await dispatch(events.DataReceived(client, wire))
        assert len(flows) == 1
        flow = flows[0]
        assert flow.error is None
        auth_fetch.assert_awaited_once()
        head, forwarded = bytes(upstream).split(b"\r\n\r\n", 1)
        assert b"authorization: bearer native-framing" in head.lower()
        assert b"content-length: " + str(len(body)).encode() in head.lower()
        assert forwarded == body
        assert managed.admission_state_for_tests() == (0, 0)
        await dispatch(
            events.DataReceived(
                flow.server_conn,
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}",
            )
        )
        assert flow.error is None
        assert flow.response is not None
        assert flow.response.status_code == 200
        if http2:
            response = peer.receive_data(bytes(downstream))
            assert len([item for item in response if isinstance(item, ResponseReceived)]) == 1
            assert (
                b"".join(item.data for item in response if isinstance(item, DataReceived)) == b"{}"
            )
            assert len([item for item in response if isinstance(item, StreamEnded)]) == 1
        else:
            assert bytes(downstream).endswith(b"\r\n\r\n{}")
