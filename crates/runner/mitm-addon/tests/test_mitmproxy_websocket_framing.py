"""WebSocket framing integration tests through mitmproxy's real hook pipeline."""

import asyncio
import hashlib
import weakref
import zlib
from collections.abc import AsyncGenerator, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol
from unittest.mock import patch

import pytest
import wsproto
import wsproto.events
import wsproto.extensions
from mitmproxy import connection, http
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.proxy import commands, events
from mitmproxy.proxy.commands import StartHook
from mitmproxy.proxy.context import Context
from mitmproxy.proxy.layers import websocket
from mitmproxy.test import taddons
from mitmproxy.websocket import WebSocketData
from wsproto.connection import Connection as WsprotoConnection
from wsproto.frame_protocol import FrameDecoder, FrameProtocol, Opcode, RsvBits

import flow_metadata_keys as metadata_keys
import mitm_addon
import websocket_framing
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush

_CLIENT_IP = "10.200.0.5"
_HOST = "websocket.example.com"
_PERMESSAGE_DEFLATE = "permessage-deflate"


@pytest.fixture(autouse=True)
async def _reset_aggregate_decoded_budget() -> AsyncGenerator[None, None]:
    websocket_framing.reset_aggregate_budget_for_tests()
    yield
    await asyncio.sleep(0)
    websocket_framing.reset_aggregate_budget_for_tests()


@dataclass
class _RunningWebSocket:
    layer: websocket.WebsocketLayer
    flow: http.HTTPFlow
    client: connection.Client
    server: connection.Server


class _ZlibDecompressor(Protocol):
    def decompress(self, data: bytes, /, max_length: int = 0) -> bytes: ...

    @property
    def unconsumed_tail(self) -> bytes: ...


@dataclass
class _DecompressionStats:
    window_bits: list[int] = field(default_factory=list)
    max_lengths: list[int] = field(default_factory=list)
    output_sizes: list[int] = field(default_factory=list)
    instances: list[weakref.ReferenceType["_TrackingDecompressor"]] = field(default_factory=list)


class _TrackingDecompressor:
    def __init__(self, inner: _ZlibDecompressor, stats: _DecompressionStats) -> None:
        self._inner = inner
        self._stats = stats

    def decompress(self, data: bytes, /, max_length: int = 0) -> bytes:
        decoded = self._inner.decompress(data, max_length)
        self._stats.max_lengths.append(max_length)
        self._stats.output_sizes.append(len(decoded))
        return decoded

    @property
    def unconsumed_tail(self) -> bytes:
        return self._inner.unconsumed_tail


def _track_zlib_decompression(
    monkeypatch: pytest.MonkeyPatch,
) -> _DecompressionStats:
    real_decompressobj = zlib.decompressobj
    stats = _DecompressionStats()

    def tracking_decompressobj(
        wbits: int = zlib.MAX_WBITS,
        zdict: bytes | None = None,
    ) -> _TrackingDecompressor:
        if zdict is None:
            inner = real_decompressobj(wbits)
        else:
            inner = real_decompressobj(wbits, zdict=zdict)
        stats.window_bits.append(wbits)
        tracked = _TrackingDecompressor(inner, stats)
        stats.instances.append(weakref.ref(tracked))
        return tracked

    monkeypatch.setattr(websocket_framing.zlib, "decompressobj", tracking_decompressobj)
    return stats


async def _handle_event(
    addon_context: taddons.context,
    running: _RunningWebSocket,
    event: events.Event,
) -> list[commands.Command]:
    observed: list[commands.Command] = []
    pending = [event]
    while pending:
        emitted = list(running.layer.handle_event(pending.pop(0)))
        observed.extend(emitted)
        for command in emitted:
            if isinstance(command, StartHook):
                await addon_context.master.addons.invoke_addon(mitm_addon, command)
                pending.append(events.HookCompleted(command, None))
    return observed


async def _start_websocket(
    addon_context: taddons.context,
    *,
    permessage_deflate: str | None = None,
    run_id: str | None = None,
    proxy_log_path: Path | None = None,
) -> _RunningWebSocket:
    client = connection.Client(
        peername=(_CLIENT_IP, 12345),
        sockname=("127.0.0.1", 8080),
        state=connection.ConnectionState.OPEN,
    )
    context = Context(client, addon_context.options)
    context.server.address = (_HOST, 443)
    context.server.state = connection.ConnectionState.OPEN

    flow = http.HTTPFlow(context.client, context.server)
    flow.request = http.Request.make(
        "GET",
        f"https://{_HOST}/socket",
        headers={
            "Connection": "upgrade",
            "Upgrade": "websocket",
            "Sec-WebSocket-Version": "13",
        },
    )
    response_headers = {
        "Connection": "upgrade",
        "Upgrade": "websocket",
    }
    if permessage_deflate is not None:
        response_headers["Sec-WebSocket-Extensions"] = permessage_deflate
    flow.response = http.Response.make(101, headers=response_headers)
    flow.websocket = WebSocketData()
    if run_id is not None:
        flow.metadata[metadata_keys.SANDBOX_RUN_ID] = run_id
    if proxy_log_path is not None:
        flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH] = str(proxy_log_path)

    running = _RunningWebSocket(
        layer=websocket.WebsocketLayer(context, flow),
        flow=flow,
        client=context.client,
        server=context.server,
    )
    start_commands = await _handle_event(addon_context, running, events.Start())
    assert sum(isinstance(command, websocket.WebsocketStartHook) for command in start_commands) == 1
    return running


def _peer(
    *,
    from_client: bool,
    permessage_deflate: str | None = None,
) -> WsprotoConnection:
    extensions: list[wsproto.extensions.Extension] = []
    if permessage_deflate is not None:
        extension = wsproto.extensions.PerMessageDeflate()
        extension.finalize(permessage_deflate)
        extensions.append(extension)
    connection_type = (
        wsproto.ConnectionType.CLIENT if from_client else wsproto.ConnectionType.SERVER
    )
    return WsprotoConnection(connection_type, extensions)


def _message_event(
    content: bytes | str,
    *,
    message_finished: bool = True,
) -> wsproto.events.Message:
    if isinstance(content, str):
        return wsproto.events.TextMessage(content, message_finished=message_finished)
    return wsproto.events.BytesMessage(content, message_finished=message_finished)


def _malformed_compressed_binary_frame(*, from_client: bool) -> bytes:
    payload = b"\x04"
    if not from_client:
        return b"\xc2\x01" + payload

    masking_key = b"\x01\x02\x03\x04"
    masked_payload = bytes([payload[0] ^ masking_key[0]])
    return b"\xc2\x81" + masking_key + masked_payload


def _source_connection(
    running: _RunningWebSocket,
    *,
    from_client: bool,
) -> connection.Connection:
    return running.client if from_client else running.server


def _message_hooks(observed: list[commands.Command]) -> list[websocket.WebsocketMessageHook]:
    return [command for command in observed if isinstance(command, websocket.WebsocketMessageHook)]


def _data_sends(observed: list[commands.Command]) -> list[commands.SendData]:
    return [
        command
        for command in observed
        if isinstance(command, commands.SendData) and command.data[0] & 0x0F != 0x08
    ]


def _assert_forwarded_messages(
    running: _RunningWebSocket,
    batches: list[list[commands.Command]],
    *,
    from_client: bool,
    permessage_deflate: str,
    expected: list[bytes],
    is_text: bool = False,
    expected_controls: Sequence[wsproto.events.Ping | wsproto.events.Pong] = (),
) -> None:
    receiver = _peer(
        from_client=not from_client,
        permessage_deflate=permessage_deflate,
    )
    destination = running.server if from_client else running.client
    messages: list[bytes] = []
    fragments: list[bytes] = []
    controls: list[wsproto.events.Ping | wsproto.events.Pong] = []
    for batch in batches:
        for send in _data_sends(batch):
            assert send.connection is destination
            receiver.receive_data(send.data)
            for event in receiver.events():
                if isinstance(event, (wsproto.events.Ping, wsproto.events.Pong)):
                    controls.append(event)
                    continue
                if is_text:
                    assert isinstance(event, wsproto.events.TextMessage)
                    fragments.append(event.data.encode())
                else:
                    assert isinstance(event, wsproto.events.BytesMessage)
                    fragments.append(bytes(event.data))
                if event.message_finished:
                    messages.append(b"".join(fragments))
                    fragments.clear()

    assert fragments == []
    assert messages == expected
    assert controls == list(expected_controls)


def _bounded_source_websocket(
    running: _RunningWebSocket,
    *,
    from_client: bool,
) -> websocket_framing._BoundedWebsocketConnection:
    source = running.layer.client_ws if from_client else running.layer.server_ws
    assert isinstance(source, websocket_framing._BoundedWebsocketConnection)
    return source


def _assert_bounded_source_state_cleared(
    running: _RunningWebSocket,
    *,
    from_client: bool,
) -> None:
    source = _bounded_source_websocket(running, from_client=from_client)
    assert sum(len(fragment) for fragment in source.frame_buf) == 0
    assert len(source._bounded_deflates) == 1
    bounded_deflate = source._bounded_deflates[0]
    assert bounded_deflate._decoder is None
    assert bounded_deflate._data_frame is False
    assert bounded_deflate._message_compressed is False
    assert source._message_limit._budget.decoded_bytes == 0
    assert source._message_limit._budget.data_frames == 0


async def _assert_compressed_fragmented_message_accepted(
    addon_context: taddons.context,
    content: bytes,
    *,
    from_client: bool,
) -> None:
    running = await _start_websocket(
        addon_context,
        permessage_deflate=_PERMESSAGE_DEFLATE,
    )
    peer = _peer(
        from_client=from_client,
        permessage_deflate=_PERMESSAGE_DEFLATE,
    )
    prefix = await _handle_event(
        addon_context,
        running,
        events.DataReceived(
            _source_connection(running, from_client=from_client),
            peer.send(
                _message_event(
                    content[: len(content) // 2],
                    message_finished=False,
                )
            ),
        ),
    )
    complete = await _handle_event(
        addon_context,
        running,
        events.DataReceived(
            _source_connection(running, from_client=from_client),
            peer.send(_message_event(content[len(content) // 2 :])),
        ),
    )

    assert _message_hooks(prefix) == []
    assert _data_sends(prefix) == []
    hooks = _message_hooks(complete)
    sends = _data_sends(complete)
    assert len(hooks) == 1
    assert len(sends) == 2
    hook_index = complete.index(hooks[0])
    assert all(hook_index < complete.index(send) for send in sends)
    assert running.flow.websocket is not None
    assert running.flow.websocket.timestamp_end is None
    assert [message.content for message in running.flow.websocket.messages] == [content]
    _assert_forwarded_messages(
        running,
        [prefix, complete],
        from_client=from_client,
        permessage_deflate=_PERMESSAGE_DEFLATE,
        expected=[content],
    )


async def _assert_compressed_fragmented_byte_limit(
    addon_context: taddons.context,
    content: bytes,
    decoded_limit: int,
    *,
    from_client: bool,
) -> None:
    running = await _start_websocket(
        addon_context,
        permessage_deflate=_PERMESSAGE_DEFLATE,
    )
    peer = _peer(
        from_client=from_client,
        permessage_deflate=_PERMESSAGE_DEFLATE,
    )
    prefix = await _handle_event(
        addon_context,
        running,
        events.DataReceived(
            _source_connection(running, from_client=from_client),
            peer.send(_message_event(content[: 64 * 1024], message_finished=False)),
        ),
    )
    source = _bounded_source_websocket(running, from_client=from_client)

    assert _message_hooks(prefix) == []
    assert _data_sends(prefix) == []
    assert source._message_limit._budget.data_frames == 1
    assert 0 < source._message_limit._budget.decoded_bytes < decoded_limit

    over_limit = await _handle_event(
        addon_context,
        running,
        events.DataReceived(
            _source_connection(running, from_client=from_client),
            peer.send(_message_event(content[64 * 1024 :])),
        ),
    )

    assert _message_hooks(over_limit) == []
    assert _data_sends(over_limit) == []
    assert running.flow.websocket is not None
    assert running.flow.websocket.close_code == 1009
    assert running.flow.websocket.messages == []
    assert not running.flow.live
    _assert_bounded_source_state_cleared(running, from_client=from_client)


async def _assert_compressed_fragmented_frame_limit(
    addon_context: taddons.context,
    *,
    from_client: bool,
) -> None:
    running = await _start_websocket(
        addon_context,
        permessage_deflate=_PERMESSAGE_DEFLATE,
    )
    peer = _peer(
        from_client=from_client,
        permessage_deflate=_PERMESSAGE_DEFLATE,
    )
    prefix = await _handle_event(
        addon_context,
        running,
        events.DataReceived(
            _source_connection(running, from_client=from_client),
            peer.send(_message_event(b"a", message_finished=False)),
        ),
    )
    source = _bounded_source_websocket(running, from_client=from_client)

    assert _message_hooks(prefix) == []
    assert _data_sends(prefix) == []
    assert source._message_limit._budget.data_frames == 1

    over_limit = await _handle_event(
        addon_context,
        running,
        events.DataReceived(
            _source_connection(running, from_client=from_client),
            peer.send(_message_event(b"b")),
        ),
    )

    assert _message_hooks(over_limit) == []
    assert _data_sends(over_limit) == []
    assert running.flow.websocket is not None
    assert running.flow.websocket.close_code == 1009
    assert running.flow.websocket.messages == []
    assert not running.flow.live
    _assert_bounded_source_state_cleared(running, from_client=from_client)


# Only process composition can introduce a conflicting connection class; no
# proxied WebSocket flow can construct this installer state.
def test_install_websocket_framing_rejects_incompatible_connection_class(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class IncompatibleWebsocketConnection:
        pass

    monkeypatch.setattr(websocket, "WebsocketConnection", IncompatibleWebsocketConnection)

    with pytest.raises(
        RuntimeError,
        match="mitmproxy WebsocketConnection has an incompatible shape",
    ):
        websocket_framing.install_websocket_framing()

    assert websocket.WebsocketConnection is IncompatibleWebsocketConnection


def test_install_websocket_framing_preserves_marked_connection_class(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class MarkedWebsocketConnection:
        pass

    setattr(
        MarkedWebsocketConnection,
        websocket_framing._CONNECTION_MARKER_ATTRIBUTE,
        True,
    )
    monkeypatch.setattr(websocket, "WebsocketConnection", MarkedWebsocketConnection)

    websocket_framing.install_websocket_framing()

    assert websocket.WebsocketConnection is MarkedWebsocketConnection


async def test_aggregate_limit_is_shared_across_directions_and_released(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    aggregate_log = tmp_path / "aggregate.jsonl"
    monkeypatch.setattr(websocket_framing, "MAX_DECODED_MESSAGE_BYTES", 10)
    monkeypatch.setattr(websocket_framing, "MAX_AGGREGATE_DECODED_BYTES", 12)

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        holder = await _start_websocket(addon_context, run_id="run-aggregate-holder")
        holder_peer = _peer(from_client=True)
        prefix = await _handle_event(
            addon_context,
            holder,
            events.DataReceived(
                holder.client,
                holder_peer.send(_message_event(b"12345678", message_finished=False)),
            ),
        )

        rejected = await _start_websocket(
            addon_context,
            run_id="run-aggregate-rejected",
            proxy_log_path=aggregate_log,
        )
        over_aggregate = await _handle_event(
            addon_context,
            rejected,
            events.DataReceived(
                rejected.server,
                _peer(from_client=False).send(_message_event(b"12345")),
            ),
        )

        completed = await _handle_event(
            addon_context,
            holder,
            events.DataReceived(
                holder.client,
                holder_peer.send(_message_event(b"90")),
            ),
        )
        assert len(_message_hooks(completed)) == 1
        assert holder.flow.websocket is not None
        assert holder.flow.websocket.messages[-1].content == b"1234567890"
        await asyncio.sleep(0)

        after_release = await _start_websocket(addon_context)
        delivered_after_release = await _handle_event(
            addon_context,
            after_release,
            events.DataReceived(
                after_release.server,
                _peer(from_client=False).send(_message_event(b"1234567890")),
            ),
        )

    assert prefix == []
    assert _message_hooks(over_aggregate) == []
    assert _data_sends(over_aggregate) == []
    assert rejected.flow.websocket is not None
    assert rejected.flow.websocket.close_code == 1009
    assert not rejected.flow.live

    assert len(_message_hooks(delivered_after_release)) == 1
    assert after_release.flow.websocket is not None
    assert after_release.flow.websocket.messages[-1].content == b"1234567890"
    aggregate_entries = read_jsonl_entries_after_flush(aggregate_log)
    aggregate_diagnostic = next(
        entry for entry in aggregate_entries if entry.get("type") == "websocket_framing_limit"
    )
    assert aggregate_diagnostic["reason"] == "aggregate_decoded_bytes"
    assert aggregate_diagnostic["direction"] == "server_to_client"
    assert aggregate_diagnostic["limit_value"] == 12
    assert aggregate_diagnostic["observed_value"] == 13


async def test_completed_message_holds_aggregate_through_hook_and_forwarding(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(websocket_framing, "MAX_DECODED_MESSAGE_BYTES", 8)
    monkeypatch.setattr(websocket_framing, "MAX_AGGREGATE_DECODED_BYTES", 8)

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        holder = await _start_websocket(addon_context)
        pending = list(
            holder.layer.handle_event(
                events.DataReceived(
                    holder.client,
                    _peer(from_client=True).send(_message_event(b"12345678")),
                )
            )
        )
        hooks = _message_hooks(pending)
        assert len(hooks) == 1
        assert _data_sends(pending) == []

        blocked_during_hook = await _start_websocket(addon_context)
        hook_contention = await _handle_event(
            addon_context,
            blocked_during_hook,
            events.DataReceived(
                blocked_during_hook.server,
                _peer(from_client=False).send(_message_event(b"x")),
            ),
        )

        await addon_context.master.addons.invoke_addon(mitm_addon, hooks[0])
        forwarded = await _handle_event(
            addon_context,
            holder,
            events.HookCompleted(hooks[0], None),
        )

        blocked_before_deferred_release = await _start_websocket(addon_context)
        deferred_contention = await _handle_event(
            addon_context,
            blocked_before_deferred_release,
            events.DataReceived(
                blocked_before_deferred_release.client,
                _peer(from_client=True).send(_message_event(b"x")),
            ),
        )

        await asyncio.sleep(0)
        after_release = await _start_websocket(addon_context)
        delivered = await _handle_event(
            addon_context,
            after_release,
            events.DataReceived(
                after_release.client,
                _peer(from_client=True).send(_message_event(b"12345678")),
            ),
        )

    assert blocked_during_hook.flow.websocket is not None
    assert blocked_during_hook.flow.websocket.close_code == 1009
    assert _message_hooks(hook_contention) == []
    assert _data_sends(hook_contention) == []

    assert len(_data_sends(forwarded)) == 1
    assert holder.flow.websocket is not None
    assert holder.flow.websocket.messages[-1].content == b"12345678"

    assert blocked_before_deferred_release.flow.websocket is not None
    assert blocked_before_deferred_release.flow.websocket.close_code == 1009
    assert _message_hooks(deferred_contention) == []
    assert _data_sends(deferred_contention) == []

    assert len(_message_hooks(delivered)) == 1
    assert len(_data_sends(delivered)) == 1
    assert after_release.flow.websocket is not None
    assert after_release.flow.websocket.messages[-1].content == b"12345678"


async def test_partial_message_releases_aggregate_on_connection_close(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(websocket_framing, "MAX_DECODED_MESSAGE_BYTES", 8)
    monkeypatch.setattr(websocket_framing, "MAX_AGGREGATE_DECODED_BYTES", 8)

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        holder = await _start_websocket(addon_context)
        prefix = await _handle_event(
            addon_context,
            holder,
            events.DataReceived(
                holder.client,
                _peer(from_client=True).send(_message_event(b"12345678", message_finished=False)),
            ),
        )

        await _handle_event(
            addon_context,
            holder,
            events.ConnectionClosed(holder.client),
        )

        after_close = await _start_websocket(addon_context)
        delivered = await _handle_event(
            addon_context,
            after_close,
            events.DataReceived(
                after_close.server,
                _peer(from_client=False).send(_message_event(b"12345678")),
            ),
        )

    assert prefix == []
    assert holder.flow.websocket is not None
    assert holder.flow.websocket.timestamp_end is not None
    assert not holder.flow.live

    assert len(_message_hooks(delivered)) == 1
    assert len(_data_sends(delivered)) == 1
    assert after_close.flow.websocket is not None
    assert after_close.flow.websocket.messages[-1].content == b"12345678"


@pytest.mark.parametrize(
    ("frame_limit", "content", "message_finished", "expected_reason", "expected_unit"),
    [
        (8_192, b"12345", True, "decoded_message_bytes", "bytes"),
        (0, b"", False, "message_data_frames", "frames"),
    ],
)
async def test_framing_limit_rejection_writes_content_free_diagnostic(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    frame_limit: int,
    content: bytes,
    message_finished: bool,
    expected_reason: str,
    expected_unit: str,
) -> None:
    proxy_log = tmp_path / f"{expected_reason}.jsonl"
    monkeypatch.setattr(websocket_framing, "MAX_MESSAGE_DATA_FRAMES", frame_limit)
    monkeypatch.setattr(websocket_framing, "MAX_DECODED_MESSAGE_BYTES", 4)
    monkeypatch.setattr(websocket_framing, "MAX_AGGREGATE_DECODED_BYTES", 16)

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        running = await _start_websocket(
            addon_context,
            run_id="run-rejected",
            proxy_log_path=proxy_log,
        )
        rejected = await _handle_event(
            addon_context,
            running,
            events.DataReceived(
                running.client,
                _peer(from_client=True).send(
                    _message_event(content, message_finished=message_finished)
                ),
            ),
        )

    assert _message_hooks(rejected) == []
    assert _data_sends(rejected) == []
    assert running.flow.websocket is not None
    assert running.flow.websocket.close_code == 1009
    entries = read_jsonl_entries_after_flush(proxy_log)
    diagnostic = next(entry for entry in entries if entry.get("type") == "websocket_framing_limit")
    assert diagnostic == {
        "timestamp": diagnostic["timestamp"],
        "level": "warn",
        "message": "WebSocket message rejected by framing limit",
        "type": "websocket_framing_limit",
        "reason": expected_reason,
        "direction": "client_to_server",
        "limit_unit": expected_unit,
        "limit_value": 4 if expected_unit == "bytes" else 0,
        "observed_value": 5 if expected_unit == "bytes" else 1,
        "observed_is_lower_bound": False,
        "close_code": 1009,
        "run_id": "run-rejected",
        "flow_id": running.flow.id,
        "firewall_name": "",
    }
    assert "12345" not in proxy_log.read_text()


@pytest.mark.parametrize(
    ("from_client", "content"),
    [
        (True, b"client-binary"),
        (False, "server-text"),
    ],
)
async def test_decoded_message_limit_applies_to_both_directions(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    from_client: bool,
    content: bytes | str,
) -> None:
    encoded_size = len(content.encode() if isinstance(content, str) else content)
    monkeypatch.setattr(websocket_framing, "MAX_DECODED_MESSAGE_BYTES", encoded_size)

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        running = await _start_websocket(addon_context)
        peer = _peer(from_client=from_client)

        accepted = await _handle_event(
            addon_context,
            running,
            events.DataReceived(
                _source_connection(running, from_client=from_client),
                peer.send(_message_event(content)),
            ),
        )
        rejected = await _handle_event(
            addon_context,
            running,
            events.DataReceived(
                _source_connection(running, from_client=from_client),
                peer.send(_message_event(b"x" * (encoded_size + 1))),
            ),
        )

    assert len(_message_hooks(accepted)) == 1
    assert len(_data_sends(accepted)) == 1
    assert running.flow.websocket is not None
    assert [message.content for message in running.flow.websocket.messages] == [
        content.encode() if isinstance(content, str) else content
    ]
    assert _message_hooks(rejected) == []
    assert _data_sends(rejected) == []
    assert running.flow.websocket.close_code == 1009
    assert not running.flow.live


async def test_read_split_message_reuses_mutable_fragment(
    tmp_path: Path,
) -> None:
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        running = await _start_websocket(addon_context)
        wire = _peer(from_client=False).send(_message_event(b"split-across-reads"))

        await _handle_event(
            addon_context,
            running,
            events.DataReceived(running.server, wire[:6]),
        )
        fragment = running.layer.server_ws.frame_buf[-1]
        first_identity = id(fragment)
        assert isinstance(fragment, bytearray)

        await _handle_event(
            addon_context,
            running,
            events.DataReceived(running.server, wire[6:12]),
        )
        assert id(running.layer.server_ws.frame_buf[-1]) == first_identity

        completed = await _handle_event(
            addon_context,
            running,
            events.DataReceived(running.server, wire[12:]),
        )

    assert len(_message_hooks(completed)) == 1
    assert running.flow.websocket is not None
    assert running.flow.websocket.messages[-1].content == b"split-across-reads"


@pytest.mark.parametrize("from_client", [True, False])
async def test_message_frame_limit_counts_frames_across_read_splits(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    from_client: bool,
) -> None:
    monkeypatch.setattr(websocket_framing, "MAX_MESSAGE_DATA_FRAMES", 1)

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        accepted = await _start_websocket(addon_context)
        accepted_content = b"split-across-reads"
        accepted_wire = _peer(from_client=from_client).send(_message_event(accepted_content))
        accepted_header_size = len(accepted_wire) - len(accepted_content)
        accepted_source = _bounded_source_websocket(
            accepted,
            from_client=from_client,
        )
        accepted_budget = accepted_source._message_limit._budget

        first_read = await _handle_event(
            addon_context,
            accepted,
            events.DataReceived(
                _source_connection(accepted, from_client=from_client),
                accepted_wire[: accepted_header_size + 1],
            ),
        )
        assert first_read == []
        assert accepted_budget.data_frames == 1
        assert accepted_budget.decoded_bytes == 1
        assert accepted_budget.aggregate_budget.decoded_bytes == 1

        second_read = await _handle_event(
            addon_context,
            accepted,
            events.DataReceived(
                _source_connection(accepted, from_client=from_client),
                accepted_wire[accepted_header_size + 1 : accepted_header_size + 2],
            ),
        )
        assert second_read == []
        assert accepted_budget.data_frames == 1
        assert accepted_budget.decoded_bytes == 2
        assert accepted_budget.aggregate_budget.decoded_bytes == 2

        completed = await _handle_event(
            addon_context,
            accepted,
            events.DataReceived(
                _source_connection(accepted, from_client=from_client),
                accepted_wire[accepted_header_size + 2 :],
            ),
        )

        hooks = _message_hooks(completed)
        sends = _data_sends(completed)
        assert len(hooks) == 1
        assert len(sends) == 1
        assert completed.index(hooks[0]) < completed.index(sends[0])
        assert accepted.flow.websocket is not None
        assert accepted.flow.websocket.timestamp_end is None
        assert [message.content for message in accepted.flow.websocket.messages] == [
            accepted_content
        ]
        assert accepted_budget.data_frames == 0
        assert accepted_budget.decoded_bytes == 0
        assert accepted_budget.aggregate_budget.decoded_bytes == len(accepted_content)
        await asyncio.sleep(0)
        assert accepted_budget.aggregate_budget.decoded_bytes == 0

        rejected = await _start_websocket(addon_context)
        rejected_peer = _peer(from_client=from_client)
        first_frame_content = b"first-frame"
        first_frame_wire = rejected_peer.send(
            _message_event(first_frame_content, message_finished=False)
        )
        first_frame_header_size = len(first_frame_wire) - len(first_frame_content)
        rejected_source = _bounded_source_websocket(
            rejected,
            from_client=from_client,
        )
        rejected_budget = rejected_source._message_limit._budget

        first_frame_start = await _handle_event(
            addon_context,
            rejected,
            events.DataReceived(
                _source_connection(rejected, from_client=from_client),
                first_frame_wire[: first_frame_header_size + 1],
            ),
        )
        first_frame_complete = await _handle_event(
            addon_context,
            rejected,
            events.DataReceived(
                _source_connection(rejected, from_client=from_client),
                first_frame_wire[first_frame_header_size + 1 :],
            ),
        )

        assert first_frame_start == []
        assert first_frame_complete == []
        assert rejected_budget.data_frames == 1
        assert rejected_budget.decoded_bytes == len(first_frame_content)
        assert rejected_budget.aggregate_budget.decoded_bytes == len(first_frame_content)

        second_frame_content = b"second-frame"
        second_frame_wire = rejected_peer.send(_message_event(second_frame_content))
        second_frame_header_size = len(second_frame_wire) - len(second_frame_content)
        second_frame_header = await _handle_event(
            addon_context,
            rejected,
            events.DataReceived(
                _source_connection(rejected, from_client=from_client),
                second_frame_wire[:second_frame_header_size],
            ),
        )
        assert second_frame_header == []
        assert rejected_budget.data_frames == 1

        over_limit = await _handle_event(
            addon_context,
            rejected,
            events.DataReceived(
                _source_connection(rejected, from_client=from_client),
                second_frame_wire[second_frame_header_size : second_frame_header_size + 1],
            ),
        )

    assert _message_hooks(over_limit) == []
    assert _data_sends(over_limit) == []
    assert rejected.flow.websocket is not None
    assert rejected.flow.websocket.close_code == 1009
    assert rejected.flow.websocket.messages == []
    assert not rejected.flow.live
    assert sum(len(fragment) for fragment in rejected_source.frame_buf) == 0
    assert rejected_budget.data_frames == 0
    assert rejected_budget.decoded_bytes == 0
    assert rejected_budget.aggregate_budget.decoded_bytes == 0


async def test_fragmented_message_limits_ignore_interleaved_control_frames(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(websocket_framing, "MAX_DECODED_MESSAGE_BYTES", 2)
    monkeypatch.setattr(websocket_framing, "MAX_MESSAGE_DATA_FRAMES", 2)

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        accepted = await _start_websocket(addon_context)
        accepted_peer = _peer(from_client=False)
        first = await _handle_event(
            addon_context,
            accepted,
            events.DataReceived(
                accepted.server,
                accepted_peer.send(_message_event(b"a", message_finished=False)),
            ),
        )
        ping = await _handle_event(
            addon_context,
            accepted,
            events.DataReceived(
                accepted.server,
                accepted_peer.send(wsproto.events.Ping(payload=b"still-open")),
            ),
        )
        final = await _handle_event(
            addon_context,
            accepted,
            events.DataReceived(accepted.server, accepted_peer.send(_message_event(b"b"))),
        )

        rejected = await _start_websocket(addon_context)
        rejected_peer = _peer(from_client=False)
        for _ in range(2):
            observed = await _handle_event(
                addon_context,
                rejected,
                events.DataReceived(
                    rejected.server,
                    rejected_peer.send(_message_event(b"", message_finished=False)),
                ),
            )
            assert _message_hooks(observed) == []
        over_limit = await _handle_event(
            addon_context,
            rejected,
            events.DataReceived(rejected.server, rejected_peer.send(_message_event(b""))),
        )

        byte_rejected = await _start_websocket(addon_context)
        byte_rejected_peer = _peer(from_client=False)
        byte_prefix = await _handle_event(
            addon_context,
            byte_rejected,
            events.DataReceived(
                byte_rejected.server,
                byte_rejected_peer.send(_message_event(b"a", message_finished=False)),
            ),
        )
        byte_over_limit = await _handle_event(
            addon_context,
            byte_rejected,
            events.DataReceived(
                byte_rejected.server,
                byte_rejected_peer.send(_message_event(b"bb")),
            ),
        )

    assert first == []
    assert any(isinstance(command, commands.SendData) for command in ping)
    assert len(_message_hooks(final)) == 1
    assert accepted.flow.websocket is not None
    assert accepted.flow.websocket.messages[-1].content == b"ab"
    assert _message_hooks(over_limit) == []
    assert _data_sends(over_limit) == []
    assert rejected.flow.websocket is not None
    assert rejected.flow.websocket.close_code == 1009
    assert rejected.flow.websocket.messages == []
    assert byte_prefix == []
    assert _message_hooks(byte_over_limit) == []
    assert _data_sends(byte_over_limit) == []
    assert byte_rejected.flow.websocket is not None
    assert byte_rejected.flow.websocket.close_code == 1009
    assert byte_rejected.flow.websocket.messages == []


@pytest.mark.parametrize("from_client", [True, False])
@pytest.mark.parametrize("is_text", [True, False], ids=["text", "binary"])
@pytest.mark.parametrize("control_type", [wsproto.events.Ping, wsproto.events.Pong])
@pytest.mark.parametrize("no_context_takeover", [True, False])
@pytest.mark.parametrize("coalesced", [True, False], ids=["one-read", "separate-reads"])
async def test_compressed_fragmentation_preserves_interleaved_controls(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    from_client: bool,
    is_text: bool,
    control_type: type[wsproto.events.Ping] | type[wsproto.events.Pong],
    no_context_takeover: bool,
    coalesced: bool,
) -> None:
    contents: list[bytes | str] = (
        ["hello 世界", "hello 世界 again"] if is_text else [b"hello world", b"hello world again"]
    )
    plain = "plain" if is_text else b"plain"
    expected = [content.encode() if isinstance(content, str) else content for content in contents]
    expected.insert(1, plain.encode() if isinstance(plain, str) else plain)
    monkeypatch.setattr(websocket_framing, "MAX_DECODED_MESSAGE_BYTES", max(map(len, expected)))
    monkeypatch.setattr(websocket_framing, "MAX_MESSAGE_DATA_FRAMES", 2)
    negotiation = _PERMESSAGE_DEFLATE
    if no_context_takeover:
        negotiation += "; client_no_context_takeover; server_no_context_takeover"

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        running = await _start_websocket(addon_context, permessage_deflate=negotiation)
        sender = _peer(from_client=from_client, permessage_deflate=negotiation)
        controls: list[wsproto.events.Ping | wsproto.events.Pong] = []
        wire: list[bytes] = []
        for index, content in enumerate(contents):
            before = control_type(payload=f"idle heartbeat {index}".encode())
            between = control_type(payload=f"fragment heartbeat {index}".encode())
            after = control_type(payload=f"finished heartbeat {index}".encode())
            controls.extend([before, between, after])
            split = len(content) // 2
            wire.extend(
                [
                    sender.send(before),
                    sender.send(_message_event(content[:split], message_finished=False)),
                    sender.send(between),
                    sender.send(_message_event(content[split:])),
                    sender.send(after),
                ]
            )
            if index == 0:
                wire.append(_peer(from_client=from_client).send(_message_event(plain)))

        batches: list[list[commands.Command]] = []
        for chunk in [b"".join(wire)] if coalesced else wire:
            observed = await _handle_event(
                addon_context,
                running,
                events.DataReceived(_source_connection(running, from_client=from_client), chunk),
            )
            batches.append(observed)
            if not coalesced:
                if chunk[0] & 0x0F in (0x09, 0x0A):
                    assert _message_hooks(observed) == []
                    assert len(_data_sends(observed)) == 1
                elif not chunk[0] & 0x80:
                    assert _message_hooks(observed) == []
                    assert _data_sends(observed) == []

    assert running.flow.websocket is not None
    assert running.flow.websocket.timestamp_end is None
    assert [message.content for message in running.flow.websocket.messages] == expected
    assert sum(len(_message_hooks(batch)) for batch in batches) == len(expected)
    _assert_forwarded_messages(
        running,
        batches,
        from_client=from_client,
        permessage_deflate=negotiation,
        expected=expected,
        is_text=is_text,
        expected_controls=controls,
    )


@pytest.mark.parametrize("from_client", [True, False])
@pytest.mark.parametrize("control_type", [wsproto.events.Ping, wsproto.events.Pong])
@pytest.mark.parametrize("no_context_takeover", [True, False])
@pytest.mark.parametrize("limit", ["message-bytes", "aggregate-bytes", "data-frames"])
async def test_compressed_interleaved_controls_preserve_cumulative_limits(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    from_client: bool,
    control_type: type[wsproto.events.Ping] | type[wsproto.events.Pong],
    no_context_takeover: bool,
    limit: str,
) -> None:
    if limit == "message-bytes":
        monkeypatch.setattr(websocket_framing, "MAX_DECODED_MESSAGE_BYTES", 96 * 1024)
    elif limit == "aggregate-bytes":
        monkeypatch.setattr(websocket_framing, "MAX_AGGREGATE_DECODED_BYTES", 96 * 1024)
    else:
        monkeypatch.setattr(websocket_framing, "MAX_MESSAGE_DATA_FRAMES", 1)
    # Retain decoded prefix bytes, but keep the wire continuation below the
    # remaining budget so skipping decompression cannot mimic a byte overflow.
    content = hashlib.shake_256(b"compressed interleaved control limit").digest(
        64 * 1024
    ) + b"x" * (64 * 1024)
    control = control_type(payload=b"heartbeat")
    negotiation = _PERMESSAGE_DEFLATE
    if no_context_takeover:
        negotiation += "; client_no_context_takeover; server_no_context_takeover"

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        running = await _start_websocket(addon_context, permessage_deflate=negotiation)
        sender = _peer(from_client=from_client, permessage_deflate=negotiation)
        source = _source_connection(running, from_client=from_client)
        prefix = await _handle_event(
            addon_context,
            running,
            events.DataReceived(
                source,
                sender.send(_message_event(content[: 64 * 1024], message_finished=False)),
            ),
        )
        heartbeat = await _handle_event(
            addon_context,
            running,
            events.DataReceived(source, sender.send(control)),
        )
        over_limit = await _handle_event(
            addon_context,
            running,
            events.DataReceived(source, sender.send(_message_event(content[64 * 1024 :]))),
        )

        assert _message_hooks(prefix) == []
        assert _data_sends(prefix) == []
        assert _message_hooks(heartbeat) == []
        assert _message_hooks(over_limit) == []
        assert _data_sends(over_limit) == []
        assert running.flow.websocket is not None
        assert running.flow.websocket.close_code == 1009
        assert running.flow.websocket.messages == []
        assert not running.flow.live
        _assert_forwarded_messages(
            running,
            [prefix, heartbeat, over_limit],
            from_client=from_client,
            permessage_deflate=negotiation,
            expected=[],
            expected_controls=[control],
        )
        _assert_bounded_source_state_cleared(running, from_client=from_client)
        _assert_bounded_source_state_cleared(running, from_client=not from_client)
        assert websocket_framing._aggregate_decoded_budget.decoded_bytes == 0

        healthy = await _start_websocket(addon_context, permessage_deflate=negotiation)
        delivered = await _handle_event(
            addon_context,
            healthy,
            events.DataReceived(
                _source_connection(healthy, from_client=from_client),
                _peer(from_client=from_client, permessage_deflate=negotiation).send(
                    _message_event(b"healthy")
                ),
            ),
        )
        _assert_forwarded_messages(
            healthy,
            [delivered],
            from_client=from_client,
            permessage_deflate=negotiation,
            expected=[b"healthy"],
        )


@pytest.mark.parametrize("from_client", [True, False])
@pytest.mark.parametrize("control_type", [wsproto.events.Ping, wsproto.events.Pong])
@pytest.mark.parametrize("disconnect", [True, False], ids=["disconnect", "close-frame"])
async def test_compressed_interleaved_control_state_clears_on_close(
    tmp_path: Path,
    from_client: bool,
    control_type: type[wsproto.events.Ping] | type[wsproto.events.Pong],
    disconnect: bool,
) -> None:
    content = hashlib.shake_256(b"compressed control terminal cleanup").digest(64 * 1024)
    control = control_type(payload=b"heartbeat")

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        running = await _start_websocket(addon_context, permessage_deflate=_PERMESSAGE_DEFLATE)
        sender = _peer(from_client=from_client, permessage_deflate=_PERMESSAGE_DEFLATE)
        source = _source_connection(running, from_client=from_client)
        prefix = await _handle_event(
            addon_context,
            running,
            events.DataReceived(
                source, sender.send(_message_event(content, message_finished=False))
            ),
        )
        heartbeat = await _handle_event(
            addon_context,
            running,
            events.DataReceived(source, sender.send(control)),
        )
        terminal = (
            events.ConnectionClosed(source)
            if disconnect
            else events.DataReceived(source, sender.send(wsproto.events.CloseConnection(code=1000)))
        )
        await _handle_event(addon_context, running, terminal)

    assert _message_hooks(prefix) == []
    assert _data_sends(prefix) == []
    assert running.flow.websocket is not None
    assert running.flow.websocket.close_code == (1006 if disconnect else 1000)
    assert running.flow.websocket.messages == []
    assert not running.flow.live
    _assert_forwarded_messages(
        running,
        [prefix, heartbeat],
        from_client=from_client,
        permessage_deflate=_PERMESSAGE_DEFLATE,
        expected=[],
        expected_controls=[control],
    )
    _assert_bounded_source_state_cleared(running, from_client=from_client)
    _assert_bounded_source_state_cleared(running, from_client=not from_client)
    assert websocket_framing._aggregate_decoded_budget.decoded_bytes == 0


@pytest.mark.parametrize("from_client", [True, False])
@pytest.mark.parametrize("control_type", [wsproto.events.Ping, wsproto.events.Pong])
async def test_compression_rejects_rsv1_on_control_frames(
    tmp_path: Path,
    from_client: bool,
    control_type: type[wsproto.events.Ping] | type[wsproto.events.Pong],
) -> None:
    wire = _peer(from_client=from_client).send(control_type(payload=b"invalid"))
    wire = bytes([wire[0] | 0x40]) + wire[1:]

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        running = await _start_websocket(addon_context, permessage_deflate=_PERMESSAGE_DEFLATE)
        rejected = await _handle_event(
            addon_context,
            running,
            events.DataReceived(_source_connection(running, from_client=from_client), wire),
        )

    assert _message_hooks(rejected) == []
    assert _data_sends(rejected) == []
    assert running.flow.websocket is not None
    assert running.flow.websocket.close_code == 1002
    assert running.flow.websocket.messages == []
    assert not running.flow.live
    _assert_bounded_source_state_cleared(running, from_client=from_client)


@pytest.mark.parametrize("from_client", [True, False])
@pytest.mark.parametrize("no_takeover_direction", ["client", "server"])
async def test_compression_uses_only_public_dependency_contract(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    from_client: bool,
    no_takeover_direction: str,
) -> None:
    # Model the external extension's public interface without its private state
    # or inbound implementation. Keep real outbound encoding behind that API.
    real_deflate_type = wsproto.extensions.PerMessageDeflate

    class PublicOnlyDeflate(wsproto.extensions.Extension):
        name = _PERMESSAGE_DEFLATE

        def __init__(
            self,
            client_no_context_takeover: bool = False,
            client_max_window_bits: int | None = None,
            server_no_context_takeover: bool = False,
            server_max_window_bits: int | None = None,
        ) -> None:
            self._sender = real_deflate_type(
                client_no_context_takeover=client_no_context_takeover,
                client_max_window_bits=client_max_window_bits,
                server_no_context_takeover=server_no_context_takeover,
                server_max_window_bits=server_max_window_bits,
            )

        @property
        def client_no_context_takeover(self) -> bool:
            return self._sender.client_no_context_takeover

        @property
        def client_max_window_bits(self) -> int:
            return self._sender.client_max_window_bits

        @property
        def server_no_context_takeover(self) -> bool:
            return self._sender.server_no_context_takeover

        @property
        def server_max_window_bits(self) -> int:
            return self._sender.server_max_window_bits

        def enabled(self) -> bool:
            return self._sender.enabled()

        def offer(self) -> bool | str:
            return self._sender.offer()

        def finalize(self, offer: str) -> None:
            self._sender.finalize(offer)

        def frame_inbound_header(
            self,
            proto: FrameDecoder | FrameProtocol,
            opcode: Opcode,
            rsv: RsvBits,
            payload_length: int,
        ) -> RsvBits:
            raise AssertionError("bounded adapter must own inbound header handling")

        def frame_inbound_payload_data(
            self, proto: FrameDecoder | FrameProtocol, data: bytes
        ) -> bytes:
            raise AssertionError("bounded adapter must own inbound decoding")

        def frame_inbound_complete(self, proto: FrameDecoder | FrameProtocol, fin: bool) -> None:
            raise AssertionError("bounded adapter must own inbound completion")

        def frame_outbound(
            self,
            proto: FrameDecoder | FrameProtocol,
            opcode: Opcode,
            rsv: RsvBits,
            data: bytes,
            fin: bool,
        ) -> tuple[RsvBits, bytes]:
            return self._sender.frame_outbound(proto, opcode, rsv, data, fin)

    # Subclassing the real implementation would bypass this public-only
    # dependency boundary and keep the rejected inherited-state coupling.
    assert not issubclass(
        websocket_framing._BoundedPerMessageDeflate, wsproto.extensions.PerMessageDeflate
    )
    monkeypatch.setattr(websocket_framing, "PerMessageDeflate", PublicOnlyDeflate)
    negotiation = (
        f"{_PERMESSAGE_DEFLATE}; client_max_window_bits=9; server_max_window_bits=12; "
        f"{no_takeover_direction}_no_context_takeover"
    )
    contents = [b"shared-prefix-" * 32, b"shared-prefix-" * 32 + b"second"]
    controls: list[wsproto.events.Ping | wsproto.events.Pong] = []
    batches: list[list[commands.Command]] = []

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        with monkeypatch.context() as codec_patch:
            stats = _track_zlib_decompression(codec_patch)
            with monkeypatch.context() as factory_patch:
                factory_patch.setattr(wsproto.extensions, "PerMessageDeflate", PublicOnlyDeflate)
                running = await _start_websocket(addon_context, permessage_deflate=negotiation)
            sender = _peer(from_client=from_client, permessage_deflate=negotiation)
            source = _source_connection(running, from_client=from_client)
            for content in contents:
                ping = wsproto.events.Ping(payload=b"heartbeat")
                controls.append(ping)
                for chunk in (
                    sender.send(_message_event(content[:32], message_finished=False)),
                    sender.send(ping),
                    sender.send(_message_event(content[32:])),
                ):
                    batches.append(
                        await _handle_event(
                            addon_context, running, events.DataReceived(source, chunk)
                        )
                    )

            inbound_no_takeover = no_takeover_direction == ("client" if from_client else "server")
            window_bits = -9 if from_client else -12
            assert stats.window_bits == [window_bits] * (2 if inbound_no_takeover else 1)
            assert all(max_length > 0 for max_length in stats.max_lengths)
            assert running.flow.websocket is not None
            assert [message.content for message in running.flow.websocket.messages] == contents
            assert sum(len(_message_hooks(batch)) for batch in batches) == len(contents)

        _assert_forwarded_messages(
            running,
            batches,
            from_client=from_client,
            permessage_deflate=negotiation,
            expected=contents,
            expected_controls=controls,
        )
        outbound_refs = [
            weakref.ref(
                _bounded_source_websocket(running, from_client=direction)
                ._bounded_deflates[0]
                ._outbound
            )
            for direction in (True, False)
        ]
        await _handle_event(
            addon_context,
            running,
            events.DataReceived(source, sender.send(wsproto.events.CloseConnection(code=1000))),
        )
        # Completed messages retain their aggregate reservation until the next
        # loop turn; terminal cleanup must not double-release those tickets.
        await asyncio.sleep(0)

    assert running.flow.websocket is not None
    assert running.flow.websocket.close_code == 1000
    assert not running.flow.live
    assert all(instance() is None for instance in stats.instances)
    assert all(instance() is None for instance in outbound_refs)
    _assert_bounded_source_state_cleared(running, from_client=True)
    _assert_bounded_source_state_cleared(running, from_client=False)
    assert websocket_framing._aggregate_decoded_budget.decoded_bytes == 0


@pytest.mark.parametrize("from_client", [True, False])
async def test_compression_rejects_rsv1_on_continuation_frames(
    tmp_path: Path,
    from_client: bool,
) -> None:
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        running = await _start_websocket(addon_context, permessage_deflate=_PERMESSAGE_DEFLATE)
        sender = _peer(from_client=from_client, permessage_deflate=_PERMESSAGE_DEFLATE)
        source = _source_connection(running, from_client=from_client)
        prefix = await _handle_event(
            addon_context,
            running,
            events.DataReceived(
                source, sender.send(_message_event(b"first", message_finished=False))
            ),
        )
        continuation = sender.send(_message_event(b"last"))
        invalid = bytes([continuation[0] | 0x40]) + continuation[1:]
        rejected = await _handle_event(addon_context, running, events.DataReceived(source, invalid))

    assert _message_hooks(prefix) == []
    assert _data_sends(prefix) == []
    assert _message_hooks(rejected) == []
    assert _data_sends(rejected) == []
    assert running.flow.websocket is not None
    assert running.flow.websocket.close_code == 1002
    assert running.flow.websocket.messages == []
    assert not running.flow.live
    _assert_bounded_source_state_cleared(running, from_client=from_client)


@pytest.mark.parametrize("from_client", [True, False])
@pytest.mark.parametrize("reserved_bit", [0x20, 0x10], ids=["rsv2", "rsv3"])
@pytest.mark.parametrize("control", [True, False], ids=["control", "data"])
async def test_compression_preserves_other_reserved_bit_validation(
    tmp_path: Path,
    from_client: bool,
    reserved_bit: int,
    control: bool,
) -> None:
    sender = _peer(from_client=from_client, permessage_deflate=_PERMESSAGE_DEFLATE)
    wire = sender.send(
        wsproto.events.Ping(payload=b"invalid") if control else _message_event(b"data")
    )
    wire = bytes([wire[0] | reserved_bit]) + wire[1:]
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        running = await _start_websocket(addon_context, permessage_deflate=_PERMESSAGE_DEFLATE)
        rejected = await _handle_event(
            addon_context,
            running,
            events.DataReceived(_source_connection(running, from_client=from_client), wire),
        )

    assert _message_hooks(rejected) == []
    assert _data_sends(rejected) == []
    assert running.flow.websocket is not None
    assert running.flow.websocket.close_code == 1002
    assert running.flow.websocket.messages == []
    assert not running.flow.live
    _assert_bounded_source_state_cleared(running, from_client=from_client)


@pytest.mark.parametrize("from_client", [True, False])
async def test_compressed_fragmented_message_limits_are_cumulative(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    from_client: bool,
) -> None:
    decoded_limit = 96 * 1024
    content = hashlib.shake_256(b"vm0 compressed fragmented message budget").digest(128 * 1024)
    monkeypatch.setattr(websocket_framing, "MAX_DECODED_MESSAGE_BYTES", decoded_limit)
    monkeypatch.setattr(websocket_framing, "MAX_MESSAGE_DATA_FRAMES", 2)

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        await _assert_compressed_fragmented_message_accepted(
            addon_context,
            content[: 64 * 1024],
            from_client=from_client,
        )
        await _assert_compressed_fragmented_byte_limit(
            addon_context,
            content,
            decoded_limit,
            from_client=from_client,
        )

        monkeypatch.setattr(websocket_framing, "MAX_MESSAGE_DATA_FRAMES", 1)
        await _assert_compressed_fragmented_frame_limit(
            addon_context,
            from_client=from_client,
        )


@pytest.mark.parametrize("from_client", [True, False])
async def test_uncompressed_message_after_deflate_negotiation_clears_state(
    tmp_path: Path,
    from_client: bool,
) -> None:
    contents = [b"uncompressed", b"compressed"]

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        running = await _start_websocket(
            addon_context,
            permessage_deflate=_PERMESSAGE_DEFLATE,
        )
        source = _bounded_source_websocket(running, from_client=from_client)
        assert len(source._bounded_deflates) == 1
        bounded_deflate = source._bounded_deflates[0]

        uncompressed_frame = _peer(from_client=from_client).send(_message_event(contents[0]))
        assert uncompressed_frame[0] & 0x40 == 0
        uncompressed = await _handle_event(
            addon_context,
            running,
            events.DataReceived(
                _source_connection(running, from_client=from_client),
                uncompressed_frame,
            ),
        )

        assert len(_message_hooks(uncompressed)) == 1
        assert len(_data_sends(uncompressed)) == 1
        assert running.flow.websocket is not None
        assert running.flow.websocket.timestamp_end is None
        assert [message.content for message in running.flow.websocket.messages] == contents[:1]
        assert sum(len(fragment) for fragment in source.frame_buf) == 0
        assert bounded_deflate._decoder is None
        assert bounded_deflate._message_compressed is False
        assert source._message_limit._budget.decoded_bytes == 0
        assert source._message_limit._budget.data_frames == 0

        compressed_frame = _peer(
            from_client=from_client,
            permessage_deflate=_PERMESSAGE_DEFLATE,
        ).send(_message_event(contents[1]))
        assert compressed_frame[0] & 0x40 == 0x40
        compressed = await _handle_event(
            addon_context,
            running,
            events.DataReceived(
                _source_connection(running, from_client=from_client),
                compressed_frame,
            ),
        )

    assert len(_message_hooks(compressed)) == 1
    assert len(_data_sends(compressed)) == 1
    assert running.flow.websocket is not None
    assert running.flow.websocket.timestamp_end is None
    assert [message.content for message in running.flow.websocket.messages] == contents
    _assert_forwarded_messages(
        running,
        [uncompressed, compressed],
        from_client=from_client,
        permessage_deflate=_PERMESSAGE_DEFLATE,
        expected=contents,
    )
    assert sum(len(fragment) for fragment in source.frame_buf) == 0
    assert bounded_deflate._decoder is not None
    assert bounded_deflate._message_compressed is False
    assert source._message_limit._budget.decoded_bytes == 0
    assert source._message_limit._budget.data_frames == 0


@pytest.mark.parametrize("from_client", [True, False])
async def test_compression_preserves_context_takeover_and_is_connection_local(
    tmp_path: Path,
    from_client: bool,
) -> None:
    original_permessage_deflate = wsproto.extensions.PerMessageDeflate

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        running = await _start_websocket(
            addon_context,
            permessage_deflate=_PERMESSAGE_DEFLATE,
        )
        peer = _peer(
            from_client=from_client,
            permessage_deflate=_PERMESSAGE_DEFLATE,
        )
        first = await _handle_event(
            addon_context,
            running,
            events.DataReceived(
                _source_connection(running, from_client=from_client),
                peer.send(_message_event(b"shared-prefix-" * 32)),
            ),
        )
        source = _bounded_source_websocket(running, from_client=from_client)
        assert len(source._bounded_deflates) == 1
        bounded_deflate = source._bounded_deflates[0]
        first_decompressor = bounded_deflate._decoder
        assert first_decompressor is not None

        second = await _handle_event(
            addon_context,
            running,
            events.DataReceived(
                _source_connection(running, from_client=from_client),
                peer.send(_message_event(b"shared-prefix-" * 32 + b"second")),
            ),
        )
        assert bounded_deflate._decoder is first_decompressor

    assert wsproto.extensions.PerMessageDeflate is original_permessage_deflate
    assert len(_message_hooks(first)) == 1
    assert len(_message_hooks(second)) == 1
    assert running.flow.websocket is not None
    assert [message.content for message in running.flow.websocket.messages] == [
        b"shared-prefix-" * 32,
        b"shared-prefix-" * 32 + b"second",
    ]
    _assert_forwarded_messages(
        running,
        [first, second],
        from_client=from_client,
        permessage_deflate=_PERMESSAGE_DEFLATE,
        expected=[b"shared-prefix-" * 32, b"shared-prefix-" * 32 + b"second"],
    )


@pytest.mark.parametrize(
    ("from_client", "permessage_deflate"),
    [
        (True, f"{_PERMESSAGE_DEFLATE}; client_no_context_takeover"),
        (False, f"{_PERMESSAGE_DEFLATE}; server_no_context_takeover"),
    ],
)
async def test_compression_releases_negotiated_no_context_takeover_state(
    tmp_path: Path,
    from_client: bool,
    permessage_deflate: str,
) -> None:
    contents = [
        b"shared-prefix-" * 32,
        b"shared-prefix-" * 32 + b"second",
    ]

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        running = await _start_websocket(
            addon_context,
            permessage_deflate=permessage_deflate,
        )
        peer = _peer(
            from_client=from_client,
            permessage_deflate=permessage_deflate,
        )
        source_websocket = running.layer.client_ws if from_client else running.layer.server_ws
        assert isinstance(
            source_websocket,
            websocket_framing._BoundedWebsocketConnection,
        )
        assert len(source_websocket._bounded_deflates) == 1
        bounded_deflate = source_websocket._bounded_deflates[0]

        forwarded: list[list[commands.Command]] = []
        for content in contents:
            delivered = await _handle_event(
                addon_context,
                running,
                events.DataReceived(
                    _source_connection(running, from_client=from_client),
                    peer.send(_message_event(content)),
                ),
            )

            assert len(_message_hooks(delivered)) == 1
            assert len(_data_sends(delivered)) == 1
            assert running.flow.websocket is not None
            assert running.flow.websocket.messages[-1].content == content
            assert bounded_deflate._decoder is None
            forwarded.append(delivered)

    assert running.flow.websocket is not None
    assert [message.content for message in running.flow.websocket.messages] == contents
    _assert_forwarded_messages(
        running,
        forwarded,
        from_client=from_client,
        permessage_deflate=permessage_deflate,
        expected=contents,
    )


@pytest.mark.parametrize("from_client", [True, False])
async def test_malformed_compressed_frame_closes_only_the_rejected_flow(
    tmp_path: Path,
    from_client: bool,
) -> None:
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        rejected = await _start_websocket(
            addon_context,
            permessage_deflate=_PERMESSAGE_DEFLATE,
        )
        malformed = await _handle_event(
            addon_context,
            rejected,
            events.DataReceived(
                _source_connection(rejected, from_client=from_client),
                _malformed_compressed_binary_frame(from_client=from_client),
            ),
        )

        healthy = await _start_websocket(
            addon_context,
            permessage_deflate=_PERMESSAGE_DEFLATE,
        )
        healthy_peer = _peer(
            from_client=from_client,
            permessage_deflate=_PERMESSAGE_DEFLATE,
        )
        delivered = await _handle_event(
            addon_context,
            healthy,
            events.DataReceived(
                _source_connection(healthy, from_client=from_client),
                healthy_peer.send(_message_event(b"healthy-compressed")),
            ),
        )

    assert _message_hooks(malformed) == []
    assert _data_sends(malformed) == []
    assert rejected.flow.websocket is not None
    assert rejected.flow.websocket.close_code == 1007
    assert rejected.flow.websocket.messages == []
    assert not rejected.flow.live

    rejected_source = rejected.layer.client_ws if from_client else rejected.layer.server_ws
    assert isinstance(rejected_source, websocket_framing._BoundedWebsocketConnection)
    assert sum(len(fragment) for fragment in rejected_source.frame_buf) == 0
    assert len(rejected_source._bounded_deflates) == 1
    bounded_deflate = rejected_source._bounded_deflates[0]
    assert bounded_deflate._decoder is None
    assert bounded_deflate._data_frame is False
    assert bounded_deflate._message_compressed is False
    assert rejected_source._message_limit._budget.decoded_bytes == 0
    assert rejected_source._message_limit._budget.data_frames == 0

    assert len(_message_hooks(delivered)) == 1
    assert len(_data_sends(delivered)) == 1
    assert healthy.flow.websocket is not None
    assert healthy.flow.websocket.timestamp_end is None
    assert healthy.flow.websocket.messages[-1].content == b"healthy-compressed"


@pytest.mark.parametrize("from_client", [True, False])
async def test_compressed_overflow_is_bounded_and_does_not_affect_another_flow(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    from_client: bool,
) -> None:
    decoded_limit = 4 * 1024
    monkeypatch.setattr(websocket_framing, "MAX_DECODED_MESSAGE_BYTES", decoded_limit)
    stats = _track_zlib_decompression(monkeypatch)

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        rejected = await _start_websocket(
            addon_context,
            permessage_deflate=_PERMESSAGE_DEFLATE,
            run_id="run-rejected",
        )
        compressed_peer = _peer(
            from_client=from_client,
            permessage_deflate=_PERMESSAGE_DEFLATE,
        )
        overflow = await _handle_event(
            addon_context,
            rejected,
            events.DataReceived(
                _source_connection(rejected, from_client=from_client),
                compressed_peer.send(_message_event(b"x" * (1024 * 1024))),
            ),
        )

        healthy = await _start_websocket(addon_context, run_id="run-healthy")
        healthy_peer = _peer(from_client=False)
        delivered = await _handle_event(
            addon_context,
            healthy,
            events.DataReceived(
                healthy.server,
                healthy_peer.send(_message_event(b"healthy")),
            ),
        )

    assert stats.max_lengths
    assert all(0 < max_length <= decoded_limit + 1 for max_length in stats.max_lengths)
    assert max(stats.output_sizes) <= decoded_limit + 1
    assert all(instance() is None for instance in stats.instances)
    assert _message_hooks(overflow) == []
    assert _data_sends(overflow) == []
    assert rejected.flow.websocket is not None
    assert rejected.flow.websocket.close_code == 1009
    assert rejected.flow.websocket.messages == []
    rejected_source = rejected.layer.client_ws if from_client else rejected.layer.server_ws
    assert sum(len(fragment) for fragment in rejected_source.frame_buf) == 0
    assert len(_message_hooks(delivered)) == 1
    assert len(_data_sends(delivered)) == 1
    assert healthy.flow.websocket is not None
    assert healthy.flow.websocket.timestamp_end is None
    assert healthy.flow.websocket.messages[-1].content == b"healthy"


async def test_compressed_message_uses_aggregate_output_budget(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    aggregate_limit = 96 * 1024
    first_fragment_bytes = 64 * 1024
    content = hashlib.shake_256(b"vm0 aggregate compressed output").digest(160 * 1024)
    monkeypatch.setattr(
        websocket_framing,
        "MAX_DECODED_MESSAGE_BYTES",
        256 * 1024,
    )
    monkeypatch.setattr(
        websocket_framing,
        "MAX_AGGREGATE_DECODED_BYTES",
        aggregate_limit,
    )
    stats = _track_zlib_decompression(monkeypatch)

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        rejected = await _start_websocket(
            addon_context,
            permessage_deflate=_PERMESSAGE_DEFLATE,
        )
        compressed_peer = _peer(
            from_client=True,
            permessage_deflate=_PERMESSAGE_DEFLATE,
        )
        prefix = await _handle_event(
            addon_context,
            rejected,
            events.DataReceived(
                rejected.client,
                compressed_peer.send(
                    _message_event(
                        content[:first_fragment_bytes],
                        message_finished=False,
                    )
                ),
            ),
        )
        rejected_source = _bounded_source_websocket(rejected, from_client=True)
        assert 0 < rejected_source._message_limit._budget.decoded_bytes < aggregate_limit

        overflow = await _handle_event(
            addon_context,
            rejected,
            events.DataReceived(
                rejected.client,
                compressed_peer.send(_message_event(content[first_fragment_bytes:])),
            ),
        )

        healthy = await _start_websocket(addon_context)
        delivered = await _handle_event(
            addon_context,
            healthy,
            events.DataReceived(
                healthy.client,
                _peer(from_client=True).send(_message_event(b"h" * aggregate_limit)),
            ),
        )

    assert prefix == []
    assert stats.max_lengths
    assert all(0 < size <= aggregate_limit + 1 for size in stats.max_lengths)
    assert max(stats.output_sizes) <= aggregate_limit + 1
    assert _message_hooks(overflow) == []
    assert _data_sends(overflow) == []
    assert rejected.flow.websocket is not None
    assert rejected.flow.websocket.close_code == 1009
    _assert_bounded_source_state_cleared(rejected, from_client=True)

    assert len(_message_hooks(delivered)) == 1
    assert healthy.flow.websocket is not None
    assert healthy.flow.websocket.messages[-1].content == b"h" * aggregate_limit
