"""Failed header auth terminates uploads through the real mitmproxy HTTP layer."""

from pathlib import Path
from typing import Literal
from unittest.mock import AsyncMock, patch

import pytest
from h2 import events as h2_events
from h2.config import H2Configuration
from h2.connection import H2Connection
from mitmproxy import connection
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.flow import Error
from mitmproxy.proxy import commands, events
from mitmproxy.proxy.layers.http import HTTPMode
from mitmproxy.proxy.layers.http._hooks import (
    HttpErrorHook,
    HttpRequestHeadersHook,
    HttpRequestHook,
)
from mitmproxy.test import taddons

import auth
import firewall_auth_client
import flow_metadata_keys as metadata_keys
import mitm_addon
from body_limits import STREAM_BUFFER_LIMIT
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.mitmproxy_http_framing_helpers import start_http_layer
from tests.request_handler_helpers import _write_github_firewall_registry


@pytest.mark.parametrize("framing", ["content-length", "chunked", "http2"])
@pytest.mark.parametrize("body_queued", [False, True], ids=["headers-only", "queued-body"])
@pytest.mark.parametrize(
    ("auth_error", "error_code", "action"),
    [
        pytest.param(
            firewall_auth_client.ConnectorNotConfiguredError("synthetic missing connector"),
            "connector_not_configured",
            "BLOCK",
            id="missing-connector",
        ),
        pytest.param(
            RuntimeError("synthetic auth backend unavailable"),
            "auth_failed",
            "ALLOW",
            id="backend-error",
        ),
    ],
)
async def test_failed_header_auth_terminates_before_body_eof(
    tmp_path: Path,
    framing: Literal["content-length", "chunked", "http2"],
    body_queued: bool,
    auth_error: Exception,
    error_code: str,
    action: str,
) -> None:
    registry_path = _write_github_firewall_registry(
        tmp_path, sandbox_fields={"captureNetworkBodies": True}
    )
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
            host="api.github.com",
            mode=HTTPMode.transparent,
        )
        http2 = None
        if framing == "http2":
            http2 = H2Connection(H2Configuration(client_side=True, header_encoding=None))
            http2.initiate_connection()
            http2.send_headers(
                1,
                [
                    (b":method", b"POST"),
                    (b":scheme", b"https"),
                    (b":authority", b"api.github.com"),
                    (b":path", b"/repos/octocat/hello"),
                    (b"expect", b"100-continue"),
                ],
                end_stream=False,
            )
            request_head = http2.data_to_send()
            http2.send_data(1, body_fragment, end_stream=False)
            partial_body = http2.data_to_send()
        else:
            body_header = (
                "Transfer-Encoding: chunked\r\n"
                if framing == "chunked"
                else f"Content-Length: {STREAM_BUFFER_LIMIT + 1}\r\n"
            )
            request_head = (
                "POST /repos/octocat/hello HTTP/1.1\r\n"
                "Host: api.github.com\r\nExpect: 100-continue\r\n" + body_header + "\r\n"
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
            assert any(
                isinstance(command, commands.CloseConnection) and command.connection is client
                for command in all_commands
            )
            assert client_bytes == b""
        else:
            client_events = http2.receive_data(client_bytes)
            assert any(
                isinstance(event, h2_events.StreamReset) and event.stream_id == 1
                for event in client_events
            )
            assert not any(
                isinstance(
                    event, (h2_events.ResponseReceived, h2_events.InformationalResponseReceived)
                )
                for event in client_events
            )
            assert not any(
                isinstance(command, commands.CloseConnection) and command.connection is client
                for command in all_commands
            )

        assert any(isinstance(command, HttpErrorHook) for command in all_commands)
        assert not any(isinstance(command, HttpRequestHook) for command in all_commands)
        assert not any(
            isinstance(command, (commands.OpenConnection, commands.SendData))
            and isinstance(command.connection, connection.Server)
            for command in all_commands
        )
        assert flow.live is False
        assert flow.error is not None
        assert flow.error.msg == Error.KILLED_MESSAGE
        assert flow.response is None
        assert flow.request.raw_content is None
        assert flow.request.stream is False
        assert "Authorization" not in flow.request.headers
        assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
        auth_fetch.assert_awaited_once()

        network_entries = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
        assert len(network_entries) == 1
        assert network_entries[0]["action"] == action
        assert network_entries[0]["firewall_error"] == error_code
        assert network_entries[0]["request_size"] == 0
        assert network_entries[0]["status"] == 0
        proxy_entries = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
        assert any(str(auth_error) in entry["message"] for entry in proxy_entries)
