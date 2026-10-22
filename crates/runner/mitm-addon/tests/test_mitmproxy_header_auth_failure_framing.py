"""Header auth delivers its local error before terminating a rejected upload."""

import json
from pathlib import Path
from typing import Literal
from unittest.mock import AsyncMock, patch

import h11
import pytest
from h2 import events as h2_events
from h2.config import H2Configuration
from h2.connection import H2Connection
from h2.settings import SettingCodes
from mitmproxy import connection
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.proxy import commands, events
from mitmproxy.proxy.layers.http import HTTPMode
from mitmproxy.proxy.layers.http._hooks import (
    HttpRequestHeadersHook,
    HttpRequestHook,
    HttpResponseHook,
)
from mitmproxy.proxy.layers.http._http2 import Http2Server
from mitmproxy.test import taddons

import auth
import firewall_auth_client
import flow_metadata_keys as metadata_keys
import managed_upload
import mitm_addon
from body_limits import STREAM_BUFFER_LIMIT
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.managed_openrouter_helpers import PATHS, sandbox
from tests.mitmproxy_http_framing_helpers import start_http_layer
from tests.request_handler_helpers import _write_github_firewall_registry, _write_registry


@pytest.mark.parametrize(
    ("target", "framing"),
    [
        ("connector", "content-length"),
        ("connector", "chunked"),
        ("connector", "http2"),
        ("openai-completions", "content-length"),
        ("openai-completions", "http2"),
        ("openai-responses", "content-length"),
        ("openai-responses", "http2"),
    ],
)
@pytest.mark.parametrize("capture_body", [False, True])
@pytest.mark.parametrize("body_queued", [False, True], ids=["headers-only", "queued-body"])
@pytest.mark.parametrize(
    ("auth_error", "error_code", "action", "status_code"),
    [
        pytest.param(
            firewall_auth_client.ConnectorNotConfiguredError("synthetic missing connector"),
            "connector_not_configured",
            "BLOCK",
            424,
            id="missing-connector",
        ),
        pytest.param(
            RuntimeError("synthetic auth backend unavailable"),
            "auth_failed",
            "ALLOW",
            502,
            id="backend-error",
        ),
        pytest.param(
            firewall_auth_client.InsufficientCreditsError("synthetic insufficient credits"),
            "insufficient_credits",
            "BLOCK",
            402,
            id="insufficient-credits",
        ),
    ],
)
async def test_failed_header_auth_responds_before_body_eof(
    tmp_path: Path,
    target: str,
    framing: Literal["content-length", "chunked", "http2"],
    capture_body: bool,
    body_queued: bool,
    auth_error: Exception,
    error_code: str,
    action: str,
    status_code: int,
) -> None:
    if target == "connector":
        registry_path = _write_github_firewall_registry(
            tmp_path, sandbox_fields={"captureNetworkBodies": capture_body}
        )
        host, path = "api.github.com", "/repos/octocat/hello"
    else:
        info = sandbox(tmp_path, target)
        info["captureNetworkBodies"] = capture_body
        registry_path = _write_registry(tmp_path, sandbox_info=info)
        host, path = "openrouter.ai", PATHS[target]
    auth_fetch = AsyncMock(side_effect=auth_error)
    body_fragment = b"x" * 16384
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
        patch.object(auth, "get_firewall_headers", auth_fetch),
    ):
        addon_context.options.update(
            okou_api_url="https://api.okou.ai",
            okou_proxy_registry_path=str(registry_path),
        )
        client, http_layer = start_http_layer(
            addon_context,
            alpn=b"h2" if framing == "http2" else b"http/1.1",
            host=host,
            mode=HTTPMode.transparent,
        )
        http2 = None
        http1 = None
        if framing == "http2":
            http2 = H2Connection(H2Configuration(client_side=True, header_encoding=None))
            http2.initiate_connection()
            http2.send_headers(
                1,
                [
                    (b":method", b"POST"),
                    (b":scheme", b"https"),
                    (b":authority", host.encode()),
                    (b":path", path.encode()),
                    (b"expect", b"100-continue"),
                    (b"content-type", b"application/json"),
                    (b"content-length", str(STREAM_BUFFER_LIMIT + 1).encode()),
                ],
                end_stream=False,
            )
            request_head = http2.data_to_send()
            http2.send_data(1, body_fragment, end_stream=False)
            partial_body = http2.data_to_send()
        else:
            http1 = h11.Connection(h11.CLIENT)
            http1.send(
                h11.Request(
                    method="POST",
                    target=path,
                    headers=[
                        ("Host", host),
                        ("Transfer-Encoding", "chunked")
                        if framing == "chunked"
                        else ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
                    ],
                )
            )
            body_header = (
                "Transfer-Encoding: chunked\r\n"
                if framing == "chunked"
                else f"Content-Length: {STREAM_BUFFER_LIMIT + 1}\r\n"
            )
            request_head = (
                f"POST {path} HTTP/1.1\r\nHost: {host}\r\n"
                "Content-Type: application/json\r\nExpect: 100-continue\r\n" + body_header + "\r\n"
            ).encode()
            partial_body = (
                f"{len(body_fragment):x}\r\n".encode() + body_fragment + b"\r\n"
                if framing == "chunked"
                else body_fragment
            )

        all_commands = list(http_layer.handle_event(events.DataReceived(client, request_head)))
        headers_hook = next(
            command for command in all_commands if isinstance(command, HttpRequestHeadersHook)
        )
        if body_queued:
            # The HTTP layer remains paused for auth while a client continues uploading.
            all_commands.extend(http_layer.handle_event(events.DataReceived(client, partial_body)))
        await addon_context.master.addons.invoke_addon(mitm_addon, headers_hook)
        pending = list(http_layer.handle_event(events.HookCompleted(headers_hook, None)))
        while pending:
            command = pending.pop(0)
            all_commands.append(command)
            if isinstance(command, commands.StartHook):
                await addon_context.master.addons.invoke_addon(mitm_addon, command)
                pending.extend(http_layer.handle_event(events.HookCompleted(command, None)))

        flow = headers_hook.flow
        client_bytes = b"".join(
            command.data
            for command in all_commands
            if isinstance(command, commands.SendData) and command.connection is client
        )
        if http2 is None:
            assert http1 is not None
            assert any(
                isinstance(command, commands.CloseTcpConnection)
                and command.connection is client
                and command.half_close
                for command in all_commands
            )
            http1.receive_data(client_bytes)
            reply = http1.next_event()
            assert isinstance(reply, h11.Response)
            assert reply.status_code == status_code
            assert dict(reply.headers)[b"connection"] == b"close"
            response_body = bytearray()
            while isinstance(item := http1.next_event(), h11.Data):
                response_body.extend(item.data)
            assert isinstance(item, h11.EndOfMessage)
        else:
            client_events = http2.receive_data(client_bytes)
            [reply] = [
                event for event in client_events if isinstance(event, h2_events.ResponseReceived)
            ]
            assert dict(reply.headers)[b":status"] == str(status_code).encode()
            response_body = b"".join(
                event.data for event in client_events if isinstance(event, h2_events.DataReceived)
            )
            [ended] = [event for event in client_events if isinstance(event, h2_events.StreamEnded)]
            for event in client_events:
                if isinstance(event, h2_events.StreamReset):
                    assert event.error_code == 0
                    assert client_events.index(event) > client_events.index(ended)
            assert not any(
                isinstance(event, h2_events.InformationalResponseReceived)
                for event in client_events
            )
            assert not any(
                isinstance(command, commands.CloseConnection) and command.connection is client
                for command in all_commands
            )

        assert json.loads(response_body)["error"] == error_code
        assert sum(isinstance(command, HttpResponseHook) for command in all_commands) == 1
        assert not any(isinstance(command, HttpRequestHook) for command in all_commands)
        assert not any(
            isinstance(command, (commands.OpenConnection, commands.SendData))
            and isinstance(command.connection, connection.Server)
            for command in all_commands
        )
        assert flow.live is False
        assert flow.error is None
        assert flow.response is not None
        assert flow.response.status_code == status_code
        assert flow.request.raw_content is None
        assert flow.request.stream is False
        assert "Authorization" not in flow.request.headers
        assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
        assert managed_upload.get(flow) is None
        assert not http_layer.streams
        auth_fetch.assert_awaited_once()

        network_entries = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
        assert len(network_entries) == 1
        assert network_entries[0]["action"] == action
        assert network_entries[0]["firewall_error"] == error_code
        assert network_entries[0]["request_size"] == 0
        assert network_entries[0]["status"] == status_code
        proxy_entries = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
        assert any(str(auth_error) in entry["message"] for entry in proxy_entries)


@pytest.mark.parametrize("dialect", ["openai-completions", "openai-responses"])
@pytest.mark.parametrize("initial_window", [0, 1])
@pytest.mark.parametrize(
    "ending", ["complete", "exact-credit", "reset", "disconnect", "protocol-error"]
)
async def test_h2_auth_error_waits_for_response_credit_without_blocking_siblings(
    tmp_path, dialect, initial_window, ending
):
    info = sandbox(tmp_path, dialect)
    registry = _write_registry(tmp_path, sandbox_info=info)
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as context,
        patch.object(
            auth,
            "get_firewall_headers",
            AsyncMock(side_effect=firewall_auth_client.InsufficientCreditsError("no credits")),
        ),
    ):
        context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry)
        )
        client, native = start_http_layer(
            context, alpn=b"h2", host="openrouter.ai", mode=HTTPMode.transparent
        )
        guest = H2Connection(H2Configuration(client_side=True, header_encoding=None))
        guest.initiate_connection()
        guest.update_settings({SettingCodes.INITIAL_WINDOW_SIZE: initial_window})
        received, history = [], []

        async def drive(event=None):
            pending = list(
                native.handle_event(event or events.DataReceived(client, guest.data_to_send()))
            )
            while pending:
                command = pending.pop(0)
                history.append(command)
                if isinstance(command, commands.StartHook):
                    await context.master.addons.invoke_addon(mitm_addon, command)
                    pending.extend(native.handle_event(events.HookCompleted(command)))
                elif isinstance(command, commands.SendData) and command.connection is client:
                    received.extend(guest.receive_data(command.data))
                elif isinstance(command, commands.OpenConnection):
                    pytest.fail("rejected auth must not open an upstream connection")
                elif isinstance(command, commands.SendData):
                    pytest.fail("rejected auth must not forward upstream bytes")

        def start(stream_id):
            guest.send_headers(
                stream_id,
                [
                    (b":method", b"POST"),
                    (b":scheme", b"https"),
                    (b":authority", b"openrouter.ai"),
                    (b":path", PATHS[dialect].encode()),
                    (b"content-type", b"application/json"),
                    (b"content-length", b"1000000"),
                ],
            )

        def body(stream_id):
            return b"".join(
                event.data
                for event in received
                if isinstance(event, h2_events.DataReceived) and event.stream_id == stream_id
            )

        def ended(stream_id):
            return any(
                isinstance(event, h2_events.StreamEnded) and event.stream_id == stream_id
                for event in received
            )

        start(1)
        await drive()
        [reply] = [event for event in received if isinstance(event, h2_events.ResponseReceived)]
        assert dict(reply.headers)[b":status"] == b"402"
        assert len(body(1)) == initial_window
        assert not ended(1)
        assert not any(isinstance(event, h2_events.StreamReset) for event in received)

        # The original caller can still upload while its response is credit-blocked.
        guest.send_data(1, b"private-rejected-upload", end_stream=False)
        start(3)
        guest.increment_flow_control_window(4096, stream_id=3)
        await drive()
        assert ended(3)
        assert json.loads(body(3))["error"] == "insufficient_credits"
        assert not ended(1)
        assert len(body(1)) == initial_window

        guest.increment_flow_control_window(1, stream_id=1)
        await drive()
        assert len(body(1)) == initial_window + 1
        assert not ended(1)
        if ending in ("complete", "exact-credit"):
            remaining = int(dict(reply.headers)[b"content-length"]) - len(body(1))
            guest.increment_flow_control_window(
                remaining if ending == "exact-credit" else 4096, stream_id=1
            )
            await drive()
            assert ended(1)
            assert json.loads(body(1))["error"] == "insufficient_credits"
            [reset] = [
                event
                for event in received
                if isinstance(event, h2_events.StreamReset) and event.stream_id == 1
            ]
            assert reset.error_code == 0
        elif ending == "reset":
            guest.reset_stream(1)
            await drive()
        elif ending == "protocol-error":
            # A PING frame must have an eight-byte payload. Native protocol
            # rejection closes this connection while the local DATA is queued.
            await drive(events.DataReceived(client, b"\x00\x00\x00\x06\x00\x00\x00\x00\x00"))
            assert any(isinstance(event, h2_events.ConnectionTerminated) for event in received)
        else:
            await drive(events.ConnectionClosed(client))

        server = native.connections[client]
        assert isinstance(server, Http2Server)
        assert not server.streams
        assert not server.h2_conn.stream_buffers
        assert not server.h2_conn.stream_trailers
        assert not native.streams
        assert not any(
            isinstance(command, commands.CloseConnection) for command in history
        ) or ending in ("disconnect", "protocol-error")
        flows = [command.flow for command in history if isinstance(command, HttpRequestHeadersHook)]
        assert len(flows) == 2
        for flow in flows:
            assert not flow.live
            assert managed_upload.get(flow) is None
            assert flow.request.raw_content is None
        entries = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
        assert len(entries) == 2
        assert all(entry["status"] == 402 for entry in entries)
