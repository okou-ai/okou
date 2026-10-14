"""Ordinary upload forwarding and retention through the real HTTP/1 layer."""

from collections import deque
from pathlib import Path
from typing import Literal
from unittest.mock import patch

import h11
import pytest
from mitmproxy import connection
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.proxy import commands, events
from mitmproxy.proxy.layers.http import HttpLayer
from mitmproxy.proxy.layers.http._hooks import HttpRequestHeadersHook, HttpRequestHook
from mitmproxy.test import taddons

import flow_metadata_keys as metadata_keys
import mitm_addon
import request_classification
from body_limits import STREAM_BUFFER_LIMIT
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.mitmproxy_http_framing_helpers import start_http_layer
from tests.request_handler_helpers import _sandbox_without_firewalls, _write_registry

_HOST = "example.com"
_CHUNK_SIZE = 64 * 1024
_UPLOAD_SIZE = 16 * 1024 * 1024


async def _drive_http_event(
    addon_context: taddons.context,
    http_layer: HttpLayer,
    event: events.Event,
) -> list[commands.Command]:
    """Dispatch actual hooks and complete the synthetic upstream socket boundary."""
    pending = deque(http_layer.handle_event(event))
    observed: list[commands.Command] = []
    while pending:
        command = pending.popleft()
        observed.append(command)
        if isinstance(command, commands.StartHook):
            await addon_context.master.addons.invoke_addon(mitm_addon, command)
            pending.extend(http_layer.handle_event(events.HookCompleted(command, None)))
        elif isinstance(command, commands.OpenConnection):
            assert not command.connection.tls
            command.connection.state = connection.ConnectionState.OPEN
            command.connection.peername = ("203.0.113.20", 80)
            pending.extend(http_layer.handle_event(events.OpenConnectionCompleted(command, None)))
    return observed


def _receive_upstream(observed: list[commands.Command], peer: h11.Connection) -> tuple[bytes, bool]:
    payload = bytearray()
    complete = False
    for command in observed:
        if not isinstance(command, commands.SendData) or not isinstance(
            command.connection, connection.Server
        ):
            continue
        peer.receive_data(command.data)
        while True:
            event = peer.next_event()
            if event is h11.NEED_DATA or event is h11.PAUSED:
                break
            if isinstance(event, h11.Request):
                assert event.method == b"POST"
                assert event.target == b"/upload"
            elif isinstance(event, h11.Data):
                payload.extend(event.data)
            elif isinstance(event, h11.EndOfMessage):
                complete = True
    return bytes(payload), complete


def _request_head(framing: Literal["content-length", "chunked"]) -> bytes:
    body_header = (
        f"Content-Length: {_UPLOAD_SIZE}\r\n"
        if framing == "content-length"
        else "Transfer-Encoding: chunked\r\n"
    )
    return (
        f"POST http://{_HOST}/upload HTTP/1.1\r\nHost: {_HOST}\r\n"
        "Content-Type: application/octet-stream\r\n" + body_header + "\r\n"
    ).encode()


@pytest.mark.parametrize("framing", ["content-length", "chunked"])
@pytest.mark.parametrize("capture_body", [False, True])
async def test_ordinary_upload_forwards_before_eof_with_bounded_retention(
    tmp_path: Path,
    framing: Literal["content-length", "chunked"],
    capture_body: bool,
) -> None:
    registry_path = _write_registry(
        tmp_path,
        sandbox_info=_sandbox_without_firewalls(
            tmp_path, sandbox_fields={"captureNetworkBodies": capture_body}
        ),
    )
    peer = h11.Connection(h11.SERVER)
    forwarded_size = 0
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        addon_context.options.update(
            okou_api_url="https://api.okou.ai",
            okou_proxy_registry_path=str(registry_path),
        )
        client, http_layer = start_http_layer(
            addon_context, alpn=b"http/1.1", host=_HOST, server_port=80
        )
        observed = await _drive_http_event(
            addon_context, http_layer, events.DataReceived(client, _request_head(framing))
        )
        headers_hook = next(cmd for cmd in observed if isinstance(cmd, HttpRequestHeadersHook))
        flow = headers_hook.flow
        assert callable(flow.request.stream)
        assert flow.metadata[metadata_keys.SANDBOX_RUN_ID] == "run-conn-1"
        assert flow.metadata[metadata_keys.CAPTURE_BODY] is capture_body
        assert request_classification.REQUEST_CLASSIFICATION_METADATA_KEY in flow.metadata
        assert _receive_upstream(observed, peer) == (b"", False)

        for index in range(_UPLOAD_SIZE // _CHUNK_SIZE):
            chunk = index.to_bytes(4, "big") + b"\x00\x01\x02\xff" * ((_CHUNK_SIZE - 4) // 4)
            wire = (
                f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n" if framing == "chunked" else chunk
            )
            observed = await _drive_http_event(
                addon_context, http_layer, events.DataReceived(client, wire)
            )
            forwarded, complete = _receive_upstream(observed, peer)
            assert forwarded == chunk
            forwarded_size += len(forwarded)
            final_chunk = index == _UPLOAD_SIZE // _CHUNK_SIZE - 1
            request_complete = final_chunk and framing == "content-length"
            assert complete is request_complete
            assert any(isinstance(cmd, HttpRequestHook) for cmd in observed) is request_complete
            assert flow.request.raw_content is None
            assert flow.metadata[metadata_keys.REQUEST_STREAM_BUFFER_STATE]["total_bytes"] == (
                forwarded_size
            )
            if capture_body:
                assert (
                    len(flow.metadata[metadata_keys.REQUEST_STREAM_BUFFER]) <= STREAM_BUFFER_LIMIT
                )
            else:
                assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata

        if framing == "chunked":
            observed = await _drive_http_event(
                addon_context, http_layer, events.DataReceived(client, b"0\r\n\r\n")
            )
            assert _receive_upstream(observed, peer) == (b"", True)
            assert any(isinstance(cmd, HttpRequestHook) for cmd in observed)
        assert forwarded_size == _UPLOAD_SIZE
        assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
        assert request_classification.REQUEST_CLASSIFICATION_METADATA_KEY not in flow.metadata
        if capture_body:
            assert len(flow.metadata[metadata_keys.REQUEST_STREAM_BUFFER]) == STREAM_BUFFER_LIMIT
            assert flow.metadata[metadata_keys.REQUEST_STREAM_BUFFER_STATE]["truncated"] is True

        response_wire = (
            peer.send(h11.Response(status_code=200, headers=[(b"Content-Length", b"2")]))
            + peer.send(h11.Data(data=b"ok"))
            + peer.send(h11.EndOfMessage())
        )
        observed = await _drive_http_event(
            addon_context, http_layer, events.DataReceived(flow.server_conn, response_wire)
        )
        client_wire = b"".join(
            cmd.data
            for cmd in observed
            if isinstance(cmd, commands.SendData) and cmd.connection is client
        )
        assert client_wire.startswith(b"HTTP/1.1 200")
        assert client_wire.endswith(b"\r\n\r\nok")

    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["request_size"] == _UPLOAD_SIZE
    assert entry["action"] == "ALLOW"
    assert entry["url"] == f"http://{_HOST}/upload"
    assert entry["status"] == 200
    if not capture_body:
        assert "request_body" not in entry
    assert flow.request.stream is False
    assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
    assert metadata_keys.REQUEST_STREAM_BUFFER_STATE not in flow.metadata
    assert metadata_keys.REQUEST_STREAM_COMPLETE not in flow.metadata
    assert metadata_keys.HTTP_REQUEST_START_MONOTONIC not in flow.metadata


async def test_interrupted_no_capture_upload_logs_partial_size_and_releases_state(
    tmp_path: Path,
) -> None:
    registry_path = _write_registry(tmp_path, sandbox_info=_sandbox_without_firewalls(tmp_path))
    peer = h11.Connection(h11.SERVER)
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        addon_context.options.update(
            okou_api_url="https://api.okou.ai",
            okou_proxy_registry_path=str(registry_path),
        )
        client, http_layer = start_http_layer(
            addon_context, alpn=b"http/1.1", host=_HOST, server_port=80
        )
        observed = await _drive_http_event(
            addon_context, http_layer, events.DataReceived(client, _request_head("content-length"))
        )
        flow = next(cmd.flow for cmd in observed if isinstance(cmd, HttpRequestHeadersHook))
        assert callable(flow.request.stream)
        assert _receive_upstream(observed, peer) == (b"", False)
        chunk = b"partial upload" * 8192
        observed = await _drive_http_event(
            addon_context, http_layer, events.DataReceived(client, chunk)
        )
        assert _receive_upstream(observed, peer) == (chunk, False)
        assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
        client.state = connection.ConnectionState.CLOSED
        await _drive_http_event(addon_context, http_layer, events.ConnectionClosed(client))

    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["request_size"] == len(chunk)
    assert "request_body" not in entry
    assert flow.error is not None
    assert flow.request.stream is False
    assert flow.request.raw_content is None
    assert metadata_keys.REQUEST_STREAM_BUFFER_STATE not in flow.metadata
    assert metadata_keys.REQUEST_STREAM_COMPLETE not in flow.metadata
    assert request_classification.REQUEST_CLASSIFICATION_METADATA_KEY not in flow.metadata
    assert metadata_keys.HTTP_REQUEST_START_MONOTONIC not in flow.metadata
