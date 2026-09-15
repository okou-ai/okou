"""TCP admission contracts through the pinned transport and production addon hooks."""

import json
from collections import deque
from collections.abc import Iterator
from pathlib import Path
from typing import cast
from unittest.mock import patch

import pytest
from mitmproxy import connection
from mitmproxy.proxy import commands, events, server_hooks
from mitmproxy.proxy.context import Context
from mitmproxy.proxy.layers.tcp import TcpEndHook, TcpErrorHook, TCPLayer, TcpStartHook
from mitmproxy.test import taddons

import mitm_addon
from tests.jsonl_log_helpers import jsonl_exists_after_flush, read_jsonl_entries_after_flush

_CLIENT_IP = "10.200.0.5"
_CLIENT_PAYLOAD = b"SSH-2.0-client\r\n"
_SERVER_PAYLOAD = b"SSH-2.0-server\r\n"


@pytest.fixture
def addon_context(tmp_path: Path) -> Iterator[taddons.context]:
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(mitm_addon) as addon_context,
    ):
        addon_context.configure(
            mitm_addon, okou_proxy_registry_path=str(tmp_path / "registry.json")
        )
        yield addon_context


def _write_registry(tmp_path: Path, *, run_id: str = "tcp-admission-run") -> None:
    (tmp_path / "registry.json").write_text(
        json.dumps(
            {
                "sandboxes": {
                    _CLIENT_IP: {
                        "runId": run_id,
                        "cliAgentType": "codex",
                        "billableFirewalls": [],
                        "networkLogPath": str(tmp_path / "network.jsonl"),
                        "proxyLogPath": str(tmp_path / "proxy.jsonl"),
                    }
                }
            }
        )
    )


def _tcp_layer(
    addon_context: taddons.context,
    *,
    connected: bool,
    client_ip: str = _CLIENT_IP,
    ignore: bool = False,
) -> TCPLayer:
    client = connection.Client(
        peername=(client_ip, 12345),
        sockname=("127.0.0.1", 8080),
        state=connection.ConnectionState.OPEN,
    )
    context = Context(client, addon_context.options)
    context.server.address = ("tcp.example.com", 22)
    if connected:
        context.server.timestamp_start = 1.0
        context.server.state = connection.ConnectionState.OPEN
    return TCPLayer(context, ignore=ignore)


async def _handle_event(
    addon_context: taddons.context,
    tcp_layer: TCPLayer,
    event: events.Event,
    *,
    connect_error: str | None = None,
) -> list[commands.Command]:
    """Complete real layer commands at the hook and transport boundaries."""
    observed: list[commands.Command] = []
    pending = deque([event])
    while pending:
        emitted = list(tcp_layer.handle_event(pending.popleft()))
        observed.extend(emitted)
        for command in emitted:
            if isinstance(command, commands.StartHook):
                await addon_context.master.addons.handle_lifecycle(command)
                pending.append(events.HookCompleted(command))
            elif isinstance(command, commands.OpenConnection):
                data = server_hooks.ServerConnectionHookData(
                    server=command.connection, client=tcp_layer.context.client
                )
                await addon_context.master.addons.handle_lifecycle(
                    server_hooks.ServerConnectHook(data)
                )
                error = command.connection.error or connect_error
                if error is None:
                    command.connection.timestamp_start = 1.0
                    command.connection.state = connection.ConnectionState.OPEN
                pending.append(events.OpenConnectionCompleted(command, error))
            elif isinstance(command, commands.CloseConnection):
                if isinstance(command, commands.CloseTcpConnection) and command.half_close:
                    command.connection.state &= ~connection.ConnectionState.CAN_WRITE
                elif command.connection.state is not connection.ConnectionState.CLOSED:
                    command.connection.state = connection.ConnectionState.CLOSED
                    pending.append(events.ConnectionClosed(command.connection))
    return observed


@pytest.mark.parametrize("connected", [False, True], ids=["new-upstream", "connected-upstream"])
@pytest.mark.parametrize("registry_state", ["missing", "malformed", "invalid-sandbox"])
async def test_rejected_admission_closes_transport_without_forwarding(
    tmp_path: Path, addon_context: taddons.context, connected: bool, registry_state: str
) -> None:
    if registry_state == "malformed":
        (tmp_path / "registry.json").write_text("{")
    elif registry_state == "invalid-sandbox":
        _write_registry(tmp_path, run_id="")

    tcp_layer = _tcp_layer(addon_context, connected=connected)
    client, server = tcp_layer.context.client, tcp_layer.context.server
    [start_hook] = list(tcp_layer.handle_event(events.Start()))
    assert isinstance(start_hook, TcpStartHook)

    # These bytes arrive while the blocking admission hook owns the layer.
    assert not list(tcp_layer.handle_event(events.DataReceived(client, _CLIENT_PAYLOAD)))
    if connected:
        assert not list(tcp_layer.handle_event(events.DataReceived(server, _SERVER_PAYLOAD)))
    await addon_context.master.addons.handle_lifecycle(start_hook)
    observed = await _handle_event(addon_context, tcp_layer, events.HookCompleted(start_hook))
    for peer, payload in [(client, _CLIENT_PAYLOAD), (server, _SERVER_PAYLOAD)]:
        observed.extend(
            await _handle_event(addon_context, tcp_layer, events.DataReceived(peer, payload))
        )

    assert not any(isinstance(command, commands.SendData) for command in observed)
    assert not any(isinstance(command, commands.OpenConnection) for command in observed)
    assert {
        command.connection for command in observed if isinstance(command, commands.CloseConnection)
    } == {client, server}
    assert client.state is connection.ConnectionState.CLOSED
    assert server.state is connection.ConnectionState.CLOSED
    assert sum(isinstance(command, TcpErrorHook) for command in observed) == 1
    assert not any(isinstance(command, TcpEndHook) for command in observed)
    assert not jsonl_exists_after_flush(tmp_path / "network.jsonl")


@pytest.mark.parametrize("connected", [False, True], ids=["new-upstream", "connected-upstream"])
@pytest.mark.parametrize("admission", ["registered", "unregistered", "missing-peer", "ignored"])
async def test_admitted_tcp_preserves_forwarding_and_logging(
    tmp_path: Path, addon_context: taddons.context, connected: bool, admission: str
) -> None:
    _write_registry(tmp_path)
    tcp_layer = _tcp_layer(
        addon_context,
        connected=connected,
        client_ip="192.0.2.5" if admission == "unregistered" else _CLIENT_IP,
        ignore=admission == "ignored",
    )
    client, server = tcp_layer.context.client, tcp_layer.context.server
    if admission == "missing-peer":
        client.peername = cast(tuple[str, int], None)
    observed = await _handle_event(addon_context, tcp_layer, events.Start())
    for peer, payload in [(client, _CLIENT_PAYLOAD), (server, _SERVER_PAYLOAD)]:
        observed.extend(
            await _handle_event(addon_context, tcp_layer, events.DataReceived(peer, payload))
        )
    assert [
        (command.connection, command.data)
        for command in observed
        if isinstance(command, commands.SendData)
    ] == [(server, _CLIENT_PAYLOAD), (client, _SERVER_PAYLOAD)]

    for peer in (client, server):
        peer.state &= ~connection.ConnectionState.CAN_READ
        observed.extend(
            await _handle_event(addon_context, tcp_layer, events.ConnectionClosed(peer))
        )
    assert not any(isinstance(command, TcpErrorHook) for command in observed)
    assert sum(isinstance(command, TcpEndHook) for command in observed) == (
        0 if admission == "ignored" else 1
    )
    if admission == "registered":
        [entry] = read_jsonl_entries_after_flush(tmp_path / "network.jsonl")
        assert entry["type"] == "tcp"
        assert entry["host"] == "tcp.example.com"
        assert entry["port"] == 22
        assert entry["request_size"] == len(_CLIENT_PAYLOAD)
        assert entry["response_size"] == len(_SERVER_PAYLOAD)
        assert "error" not in entry
    else:
        assert not jsonl_exists_after_flush(tmp_path / "network.jsonl")


async def test_admitted_tcp_preserves_upstream_connection_errors(
    tmp_path: Path, addon_context: taddons.context
) -> None:
    _write_registry(tmp_path)
    tcp_layer = _tcp_layer(addon_context, connected=False)
    observed = await _handle_event(
        addon_context, tcp_layer, events.Start(), connect_error="connection refused"
    )

    assert not any(isinstance(command, commands.SendData) for command in observed)
    assert tcp_layer.context.client.state is connection.ConnectionState.CLOSED
    assert sum(isinstance(command, TcpErrorHook) for command in observed) == 1
    assert not any(isinstance(command, TcpEndHook) for command in observed)
    [entry] = read_jsonl_entries_after_flush(tmp_path / "network.jsonl")
    assert entry["error"] == "connection refused"
    assert entry["request_size"] == 0
    assert entry["response_size"] == 0
