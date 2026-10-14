"""Firewall-denied uploads terminate through the native HTTP transport."""

import json
from collections import deque
from pathlib import Path
from typing import Literal
from unittest.mock import AsyncMock, patch

import h11
import pytest
from h2 import events as h2_events
from h2.config import H2Configuration
from h2.connection import H2Connection
from mitmproxy import connection
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.flow import Error
from mitmproxy.proxy import commands, events
from mitmproxy.proxy.layers.http import HttpLayer, HTTPMode
from mitmproxy.proxy.layers.http._hooks import (
    HttpErrorHook,
    HttpRequestHeadersHook,
    HttpRequestHook,
)
from mitmproxy.test import taddons

import auth
import auth_base_forwarder
import aws_sigv4_body_admission
import flow_metadata_keys as metadata_keys
import mitm_addon
import request_classification
import usage
from body_limits import STREAM_BUFFER_LIMIT
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.mitmproxy_http_framing_helpers import start_http_layer
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry
from tests.usage_helpers import UsageWebhookServer

pytestmark = pytest.mark.usefixtures("sync_usage_executor")


def _denied_upload_registry(tmp_path: Path, *, capture_body: bool) -> Path:
    return _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            api_entry={
                "base": "https://api.github.com",
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"}},
                "permissions": [{"name": "upload", "rules": ["POST /upload"]}],
            },
            network_policy={
                "allow": [],
                "deny": ["upload"],
                "ask": [],
                "unknownPolicy": "deny",
            },
            billable_firewalls=["github"],
            sandbox_fields={"captureNetworkBodies": capture_body},
        ),
    )


async def _drive_http_event(
    addon_context: taddons.context,
    http_layer: HttpLayer,
    event: events.Event,
) -> list[commands.Command]:
    pending = deque(http_layer.handle_event(event))
    observed: list[commands.Command] = []
    while pending:
        command = pending.popleft()
        observed.append(command)
        if isinstance(command, commands.StartHook):
            await addon_context.master.addons.invoke_addon(mitm_addon, command)
            pending.extend(http_layer.handle_event(events.HookCompleted(command, None)))
    return observed


def _client_bytes(observed: list[commands.Command], client: connection.Client) -> bytes:
    return b"".join(
        command.data
        for command in observed
        if isinstance(command, commands.SendData) and command.connection is client
    )


def _assert_no_upstream(observed: list[commands.Command]) -> None:
    assert not any(
        isinstance(command, (commands.OpenConnection, commands.SendData))
        and isinstance(command.connection, connection.Server)
        for command in observed
    )


@pytest.mark.parametrize("framing", ["content-length", "chunked", "http2"])
@pytest.mark.parametrize("capture_body", [False, True])
@pytest.mark.parametrize("body_queued", [False, True], ids=["headers-only", "queued-body"])
@pytest.mark.parametrize("denial", ["permission_denied", "unknown_endpoint"])
async def test_header_firewall_denial_stops_upload_before_eof(
    tmp_path: Path,
    framing: Literal["content-length", "chunked", "http2"],
    capture_body: bool,
    body_queued: bool,
    denial: str,
    usage_webhook_server: UsageWebhookServer,
) -> None:
    registry_path = _denied_upload_registry(tmp_path, capture_body=capture_body)
    auth_fetch = AsyncMock(side_effect=AssertionError("denied upload requested credentials"))
    path = "/upload" if denial == "permission_denied" else "/unknown"
    body_fragment = b"x" * 16384
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
        patch.object(auth, "get_firewall_headers", auth_fetch),
    ):
        addon_context.options.update(
            okou_api_url=usage_webhook_server.api_url,
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
                    (b":path", path.encode()),
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
                f"POST {path} HTTP/1.1\r\nHost: api.github.com\r\n"
                "Expect: 100-continue\r\n" + body_header + "\r\n"
            ).encode()
            partial_body = (
                f"{len(body_fragment):x}\r\n".encode() + body_fragment + b"\r\n"
                if framing == "chunked"
                else body_fragment
            )

        observed = list(http_layer.handle_event(events.DataReceived(client, request_head)))
        headers_hook = next(
            command for command in observed if isinstance(command, HttpRequestHeadersHook)
        )
        if body_queued:
            observed.extend(http_layer.handle_event(events.DataReceived(client, partial_body)))
        await addon_context.master.addons.invoke_addon(mitm_addon, headers_hook)
        observed.extend(
            await _drive_http_event(
                addon_context, http_layer, events.HookCompleted(headers_hook, None)
            )
        )
        # Further body input must remain rejected; no EOF is ever supplied.
        observed.extend(
            await _drive_http_event(
                addon_context, http_layer, events.DataReceived(client, partial_body)
            )
        )

        client_bytes = _client_bytes(observed, client)
        if http2 is None:
            assert any(
                isinstance(command, commands.CloseConnection) and command.connection is client
                for command in observed
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
                for command in observed
            )

        assert sum(isinstance(command, HttpErrorHook) for command in observed) == 1
        assert not any(isinstance(command, HttpRequestHook) for command in observed)
        _assert_no_upstream(observed)
        flow = headers_hook.flow
        assert flow.live is False
        assert flow.error is not None
        assert flow.error.msg == Error.KILLED_MESSAGE
        assert flow.response is None
        assert flow.request.raw_content is None
        assert flow.request.stream is False
        assert "Authorization" not in flow.request.headers
        assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
        assert metadata_keys.AUTH_BASE_FORWARD_ADMISSION not in flow.metadata
        assert metadata_keys.AWS_SIGV4_BODY_ADMISSION not in flow.metadata
        assert metadata_keys.HTTP_REQUEST_START_MONOTONIC not in flow.metadata
        assert request_classification.REQUEST_CLASSIFICATION_METADATA_KEY not in flow.metadata
        assert auth_base_forwarder.forward_request_admission_state_for_tests() == (0, 0)
        assert aws_sigv4_body_admission.state_for_tests() == (0, 0)
        auth_fetch.assert_not_called()

        network_entries = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
        assert len(network_entries) == 1
        assert network_entries[0]["action"] == "DENY"
        assert network_entries[0]["request_size"] == 0
        assert network_entries[0]["status"] == 0
        assert "response_body" not in network_entries[0]
        proxy_entries = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
        denial_entries = [entry for entry in proxy_entries if entry["type"] == "firewall_block"]
        assert len(denial_entries) == 1
        assert denial_entries[0]["reason"] == denial

        if http2 is not None:
            # Resetting one upload must not close the HTTP/2 connection. A
            # subsequent finished request still receives the structured 403.
            http2.send_headers(
                3,
                [
                    (b":method", b"POST"),
                    (b":scheme", b"https"),
                    (b":authority", b"api.github.com"),
                    (b":path", b"/upload"),
                ],
                end_stream=True,
            )
            next_commands = await _drive_http_event(
                addon_context, http_layer, events.DataReceived(client, http2.data_to_send())
            )
            next_events = http2.receive_data(_client_bytes(next_commands, client))
            assert any(
                isinstance(event, h2_events.ResponseReceived)
                and event.stream_id == 3
                and (b":status", b"403") in event.headers
                for event in next_events
            )
            assert any(
                isinstance(event, h2_events.StreamEnded) and event.stream_id == 3
                for event in next_events
            )
            _assert_no_upstream(next_commands)

        usage.flush_usage_events(trigger="test")
        assert usage_webhook_server.request_count == 0
        auth_fetch.assert_not_called()


@pytest.mark.parametrize("body_size", [0, 1, STREAM_BUFFER_LIMIT, None])
@pytest.mark.parametrize("capture_body", [False, True])
async def test_bounded_and_bodyless_firewall_denials_keep_structured_response(
    tmp_path: Path,
    body_size: int | None,
    capture_body: bool,
) -> None:
    registry_path = _denied_upload_registry(tmp_path, capture_body=capture_body)
    auth_fetch = AsyncMock(side_effect=AssertionError("denied request requested credentials"))
    peer = h11.Connection(h11.CLIENT)
    method = b"POST" if body_size is not None else b"GET"
    request_headers = [(b"Host", b"api.github.com")]
    if body_size is not None:
        request_headers.append((b"Content-Length", str(body_size).encode()))
    request_head = peer.send(h11.Request(method=method, target=b"/upload", headers=request_headers))
    body = b"x" * (body_size or 0)
    body_bytes = peer.send(h11.Data(data=body)) + peer.send(h11.EndOfMessage())
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
            alpn=b"http/1.1",
            host="api.github.com",
            mode=HTTPMode.transparent,
        )
        observed = await _drive_http_event(
            addon_context, http_layer, events.DataReceived(client, request_head)
        )
        observed.extend(
            await _drive_http_event(
                addon_context, http_layer, events.DataReceived(client, body_bytes)
            )
        )
        peer.receive_data(_client_bytes(observed, client))
        response_events = []
        while (event := peer.next_event()) not in (h11.NEED_DATA, h11.PAUSED):
            response_events.append(event)
        assert any(
            isinstance(event, h11.Response) and event.status_code == 403
            for event in response_events
        )
        response_body = b"".join(
            event.data for event in response_events if isinstance(event, h11.Data)
        )
        denial = json.loads(response_body)
        assert denial["error"] == "permission_denied"
        assert denial["reason"] == (
            "permission_denied" if body_size is not None else "unknown_endpoint"
        )
        assert not any(isinstance(command, HttpErrorHook) for command in observed)
        assert sum(isinstance(command, HttpRequestHook) for command in observed) == 1
        _assert_no_upstream(observed)
        auth_fetch.assert_not_called()
        network_entries = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
        assert len(network_entries) == 1
        assert network_entries[0]["action"] == "DENY"
        assert network_entries[0]["status"] == 403
