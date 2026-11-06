"""Bound connection-error logging before interpolation and JSON encoding."""

from collections import deque
from pathlib import Path
from unittest.mock import patch

import pytest
from mitmproxy import connection
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.flow import Error
from mitmproxy.proxy import commands, events
from mitmproxy.proxy.layers.http import HttpLayer
from mitmproxy.proxy.layers.http._hooks import HttpErrorHook, HttpRequestHook
from mitmproxy.test import taddons

import flow_metadata_keys as metadata_keys
import logging_utils
import mitm_addon
import request_classification
import usage
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.mitmproxy_http_framing_helpers import start_http_layer
from tests.request_handler_helpers import _sandbox_without_firewalls, _write_registry


class _UnprocessedError(str):
    """Oversized native text must only be measured, never traversed for logging."""

    def __str__(self):
        raise AssertionError("oversized original converted to string")

    def __format__(self, format_spec):
        raise AssertionError("oversized original interpolated")

    def __getitem__(self, key):
        raise AssertionError("oversized original sliced")

    def encode(self, encoding="utf-8", errors="strict"):
        raise AssertionError("oversized original encoded")


@pytest.mark.parametrize(
    "error_text",
    [
        pytest.param("connection reset by peer", id="ordinary"),
        pytest.param("x" * 4096, id="ascii-limit"),
        pytest.param("\U0001f600" * 4096, id="non-bmp-limit"),
        pytest.param('"\\\x00' * 1365 + "x", id="json-escaping-limit"),
        pytest.param("x" * 4097, id="one-over-limit"),
        pytest.param("\U0001f600" * 1_048_576, id="large-unicode"),
    ],
)
async def test_connection_error_is_projected_before_log_processing(
    tmp_path, real_flow, mitm_ctx, monkeypatch, error_text
):
    registry_path = _write_registry(tmp_path, sandbox_info=_sandbox_without_firewalls(tmp_path))
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="example.com",
        path="/path?token=secret#fragment",
    )
    oversized = len(error_text) > 4096
    original = _UnprocessedError(error_text) if oversized else error_text
    expected = f"[connection error omitted: {len(original)} characters]" if oversized else original
    encoded_logs = []
    encode = logging_utils._encode_jsonl_entry

    def check_before_encoding(entry, log_name):
        assert entry["error"] == expected
        if oversized:
            assert entry["error"] is not original
        if log_name == "proxy":
            assert entry["message"] == f"Error: {expected}: https://example.com/path"
        encoded_logs.append(log_name)
        return encode(entry, log_name)

    with mitm_ctx(registry_path=str(registry_path)):
        assert mitm_addon.requestheaders(flow) is None
        await mitm_addon.request(flow)
        assert flow.response is None
        flow.error = Error(original)
        native_error = flow.error
        monkeypatch.setattr(logging_utils, "_encode_jsonl_entry", check_before_encoding)
        assert mitm_addon.error(flow) is None

    assert flow.error is native_error
    assert flow.error.msg is original
    assert encoded_logs == ["network", "proxy"]
    [network] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    [proxy] = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
    assert network["status"] == 0
    assert network["action"] == "ALLOW"
    assert network["error"] == proxy["error"] == expected
    assert proxy["type"] == "connection_error"
    assert proxy["message"] == f"Error: {expected}: https://example.com/path"
    assert metadata_keys.HTTP_REQUEST_START_MONOTONIC not in flow.metadata
    assert request_classification.REQUEST_CLASSIFICATION_METADATA_KEY not in flow.metadata
    for name in ("net.jsonl", "proxy.jsonl"):
        # Includes worst-case JSON escaping at the exact verbatim boundary.
        assert (tmp_path / name).stat().st_size < 100_000


@pytest.mark.parametrize(
    ("network_enabled", "proxy_enabled"), [(True, False), (False, True), (False, False)]
)
async def test_oversized_connection_error_with_disabled_log_paths(
    tmp_path, real_flow, mitm_ctx, network_enabled, proxy_enabled
):
    sandbox = _sandbox_without_firewalls(
        tmp_path,
        sandbox_fields={
            "networkLogPath": str(tmp_path / "net.jsonl") if network_enabled else "",
            "proxyLogPath": str(tmp_path / "proxy.jsonl") if proxy_enabled else "",
        },
    )
    registry_path = _write_registry(tmp_path, sandbox_info=sandbox)
    flow = real_flow(with_response=False, client_ip="10.200.0.5")
    original = _UnprocessedError("x" * 4097)
    with mitm_ctx(registry_path=str(registry_path)):
        assert mitm_addon.requestheaders(flow) is None
        await mitm_addon.request(flow)
        flow.error = Error(original)
        assert mitm_addon.error(flow) is None

    assert flow.error.msg is original
    for enabled, name in ((network_enabled, "net.jsonl"), (proxy_enabled, "proxy.jsonl")):
        path = tmp_path / name
        if enabled:
            [entry] = read_jsonl_entries_after_flush(path)
            assert entry["error"] == "[connection error omitted: 4097 characters]"
        else:
            assert not path.exists()
    assert usage.counters.delivery_snapshot()["flows"] == 0
    assert flow.request.stream is False


async def _drive_http_event(
    addon_context: taddons.context,
    http_layer: HttpLayer,
    event: events.Event,
) -> list[commands.Command]:
    """Run real hooks, completing only the external upstream socket boundary."""
    pending = deque(http_layer.handle_event(event))
    observed = []
    while pending:
        command = pending.popleft()
        observed.append(command)
        if isinstance(command, commands.StartHook):
            native_error = command.flow.error if isinstance(command, HttpErrorHook) else None
            await addon_context.master.addons.invoke_addon(mitm_addon, command)
            if isinstance(command, HttpErrorHook):
                assert command.flow.error is native_error
            pending.extend(http_layer.handle_event(events.HookCompleted(command, None)))
        elif isinstance(command, commands.OpenConnection):
            assert not command.connection.tls
            command.connection.state = connection.ConnectionState.OPEN
            command.connection.peername = ("203.0.113.20", 80)
            pending.extend(http_layer.handle_event(events.OpenConnectionCompleted(command, None)))
    return observed


@pytest.mark.parametrize(
    "payload",
    [
        pytest.param(b"x" * 512, id="ordinary-native-error"),
        pytest.param(b"x" * 65_536, id="64k-native-error"),
        pytest.param(b"x" * 1_048_576, id="1m-native-error"),
        pytest.param(b'"\\\x00\xff' * 16_384, id="escaped-native-error"),
    ],
)
async def test_incomplete_response_head_eof_logs_bounded_native_error(
    tmp_path: Path, payload: bytes
) -> None:
    registry_path = _write_registry(tmp_path, sandbox_info=_sandbox_without_firewalls(tmp_path))
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        addon_context.options.update(
            okou_api_url="https://api.okou.ai",
            okou_proxy_registry_path=str(registry_path),
        )
        client, http_layer = start_http_layer(
            addon_context, alpn=b"http/1.1", host="example.com", server_port=80
        )
        request_bytes = b"GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n"
        observed = await _drive_http_event(
            addon_context, http_layer, events.DataReceived(client, request_bytes)
        )
        request_hook = next(cmd for cmd in observed if isinstance(cmd, HttpRequestHook))
        flow = request_hook.flow
        assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
        assert flow.response is None
        forwarded = b"".join(
            cmd.data
            for cmd in observed
            if isinstance(cmd, commands.SendData) and cmd.connection is flow.server_conn
        )
        assert forwarded == b"GET / HTTP/1.1\r\nHost: example.com\r\n\r\n"

        incomplete_head = b"HTTP/1.1 200 OK\r\nX-Probe: " + payload
        for offset in range(0, len(incomplete_head), 8192):
            observed = await _drive_http_event(
                addon_context,
                http_layer,
                events.DataReceived(flow.server_conn, incomplete_head[offset : offset + 8192]),
            )
            assert observed == []
        observed = await _drive_http_event(
            addon_context, http_layer, events.ConnectionClosed(flow.server_conn)
        )

    [error_hook] = [cmd for cmd in observed if isinstance(cmd, HttpErrorHook)]
    assert error_hook.flow is flow
    assert flow.error is not None
    native_text = f"unexpected server response: {incomplete_head!r}"
    assert flow.error.msg == native_text
    expected = (
        f"[connection error omitted: {len(native_text)} characters]"
        if len(native_text) > 4096
        else native_text
    )
    [network] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    [proxy] = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
    assert network["error"] == proxy["error"] == expected
    assert network["action"] == "ALLOW"
    assert network["status"] == 0
    assert proxy["type"] == "connection_error"
    assert proxy["message"] == f"Error: {expected}: http://example.com/"
    assert flow.live is False
    assert flow.request.stream is False
    assert usage.counters.delivery_snapshot()["flows"] == 0
    assert metadata_keys.HTTP_REQUEST_START_MONOTONIC not in flow.metadata
    assert request_classification.REQUEST_CLASSIFICATION_METADATA_KEY not in flow.metadata
    for name in ("net.jsonl", "proxy.jsonl"):
        assert (tmp_path / name).stat().st_size < 2_000
