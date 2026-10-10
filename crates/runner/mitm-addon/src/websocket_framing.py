"""Bound decoded WebSocket messages before mitmproxy's addon hooks.

See the [WebSocket framing contract](../../../../docs/runner/mitm-addon-testing.md)
for the limits, lifecycle invariants, and version-re-audit boundary for this
private adaptation.
"""

from __future__ import annotations

import zlib
from collections.abc import Generator
from dataclasses import dataclass
from typing import Literal, cast

import wsproto
from mitmproxy import connection, http
from mitmproxy.proxy import commands
from mitmproxy.proxy.layers import websocket
from wsproto import events
from wsproto.extensions import Extension, PerMessageDeflate
from wsproto.frame_protocol import CloseReason, FrameDecoder, FrameProtocol, Opcode, RsvBits

import deferred_callbacks
import flow_metadata
from logging_utils import log_proxy_entry

MAX_DECODED_MESSAGE_BYTES = 256 * 1024 * 1024
MAX_AGGREGATE_DECODED_BYTES = 1024 * 1024 * 1024
MAX_MESSAGE_DATA_FRAMES = 8_192

_EMPTY_DEFLATE_BLOCK = b"\x00\x00\xff\xff"
_CONNECTION_MARKER_ATTRIBUTE = "_bounded_websocket_framing"
_MESSAGE_LIMIT_VIOLATION_ATTRIBUTE = "_websocket_message_limit_violation"
_ORIGINAL_WEBSOCKET_CONNECTION = websocket.WebsocketConnection

_MessageLimitReason = Literal[
    "decoded_message_bytes",
    "aggregate_decoded_bytes",
    "message_data_frames",
]
_MessageLimitUnit = Literal["bytes", "frames"]


@dataclass(frozen=True)
class _MessageLimitViolation:
    reason: _MessageLimitReason
    unit: _MessageLimitUnit
    limit_value: int
    observed_value: int
    observed_is_lower_bound: bool


@dataclass
class _AggregateDecodedBudget:
    """Decoded-byte ownership shared on mitmproxy's event-loop thread."""

    decoded_bytes: int = 0

    @property
    def remaining_bytes(self) -> int:
        return max(
            0,
            MAX_AGGREGATE_DECODED_BYTES - self.decoded_bytes,
        )

    def reserve(self, size: int) -> bool:
        if size > self.remaining_bytes:
            return False
        self.decoded_bytes += size
        return True

    def release(self, size: int) -> None:
        if size > self.decoded_bytes:
            raise RuntimeError("WebSocket aggregate decoded-byte ownership underflow")
        self.decoded_bytes -= size

    def reset_for_tests(self) -> None:
        self.decoded_bytes = 0


_aggregate_decoded_budget = _AggregateDecodedBudget()


@dataclass
class _MessageBudget:
    conn: connection.Connection
    max_decoded_bytes: int
    max_data_frames: int
    aggregate_budget: _AggregateDecodedBudget
    decoded_bytes: int = 0
    data_frames: int = 0

    @property
    def remaining_bytes(self) -> int:
        message_remaining = self.max_decoded_bytes - self.decoded_bytes
        return min(message_remaining, self.aggregate_budget.remaining_bytes)

    def _record_violation(
        self,
        *,
        reason: _MessageLimitReason,
        unit: _MessageLimitUnit,
        limit_value: int,
        observed_value: int,
        observed_is_lower_bound: bool = False,
    ) -> None:
        if isinstance(
            getattr(self.conn, _MESSAGE_LIMIT_VIOLATION_ATTRIBUTE, None),
            _MessageLimitViolation,
        ):
            return
        setattr(
            self.conn,
            _MESSAGE_LIMIT_VIOLATION_ATTRIBUTE,
            _MessageLimitViolation(
                reason=reason,
                unit=unit,
                limit_value=limit_value,
                observed_value=observed_value,
                observed_is_lower_bound=observed_is_lower_bound,
            ),
        )

    def reserve_bytes(self, size: int) -> bool:
        observed_message_bytes = self.decoded_bytes + size
        if observed_message_bytes > self.max_decoded_bytes:
            self._record_violation(
                reason="decoded_message_bytes",
                unit="bytes",
                limit_value=self.max_decoded_bytes,
                observed_value=observed_message_bytes,
            )
            return False
        if not self.aggregate_budget.reserve(size):
            self._record_violation(
                reason="aggregate_decoded_bytes",
                unit="bytes",
                limit_value=MAX_AGGREGATE_DECODED_BYTES,
                observed_value=self.aggregate_budget.decoded_bytes + size,
            )
            return False
        self.decoded_bytes += size
        return True

    def reject_bounded_decode_output(self, minimum_size: int) -> None:
        observed_message_bytes = self.decoded_bytes + minimum_size
        if observed_message_bytes > self.max_decoded_bytes:
            self._record_violation(
                reason="decoded_message_bytes",
                unit="bytes",
                limit_value=self.max_decoded_bytes,
                observed_value=observed_message_bytes,
                observed_is_lower_bound=True,
            )
            return
        observed_aggregate_bytes = self.aggregate_budget.decoded_bytes + minimum_size
        if observed_aggregate_bytes <= MAX_AGGREGATE_DECODED_BYTES:
            raise RuntimeError("WebSocket bounded decode rejected below its aggregate limit")
        self._record_violation(
            reason="aggregate_decoded_bytes",
            unit="bytes",
            limit_value=MAX_AGGREGATE_DECODED_BYTES,
            observed_value=observed_aggregate_bytes,
            observed_is_lower_bound=True,
        )

    def reserve_frame(self) -> bool:
        if self.data_frames >= self.max_data_frames:
            self._record_violation(
                reason="message_data_frames",
                unit="frames",
                limit_value=self.max_data_frames,
                observed_value=self.data_frames + 1,
            )
            return False
        self.data_frames += 1
        return True

    def finish_message(self) -> None:
        decoded_bytes = self.decoded_bytes
        if decoded_bytes:
            deferred_callbacks.call_soon(self.aggregate_budget.release, decoded_bytes)
        self.decoded_bytes = 0
        self.data_frames = 0

    def reset(self) -> None:
        if self.decoded_bytes:
            self.aggregate_budget.release(self.decoded_bytes)
        self.decoded_bytes = 0
        self.data_frames = 0


class _DecodedMessageLimit(Extension):
    """Count decoded data after negotiated inbound extensions run."""

    name = "vm0-decoded-message-limit"

    def __init__(self, budget: _MessageBudget) -> None:
        self._budget = budget
        self._opcode: Opcode | None = None
        self._frame_started = False

    def enabled(self) -> bool:
        return True

    def offer(self) -> bool:
        return False

    def frame_inbound_header(
        self,
        proto: FrameDecoder | FrameProtocol,
        opcode: Opcode,
        rsv: RsvBits,
        payload_length: int,
    ) -> RsvBits:
        self._opcode = opcode
        return RsvBits(False, False, False)

    def frame_inbound_payload_data(
        self,
        proto: FrameDecoder | FrameProtocol,
        data: bytes,
    ) -> bytes | CloseReason:
        opcode = self._opcode
        if opcode is None:
            raise RuntimeError("WebSocket payload arrived without a frame header")
        if opcode.iscontrol():
            return data

        if not self._frame_started:
            self._frame_started = True
            if not self._budget.reserve_frame():
                return CloseReason.MESSAGE_TOO_BIG

        if not self._budget.reserve_bytes(len(data)):
            return CloseReason.MESSAGE_TOO_BIG
        return data

    def frame_inbound_complete(
        self,
        proto: FrameDecoder | FrameProtocol,
        fin: bool,
    ) -> None:
        opcode = self._opcode
        if opcode is None:
            raise RuntimeError("WebSocket frame completed without a frame header")
        self._opcode = None
        self._frame_started = False

    def clear(self) -> None:
        self._opcode = None
        self._frame_started = False
        self._budget.reset()


class _BoundedPerMessageDeflate(PerMessageDeflate):
    """Apply the shared decoded-message budget while inflating input."""

    def __init__(self, source: PerMessageDeflate, budget: _MessageBudget) -> None:
        super().__init__(
            client_no_context_takeover=source.client_no_context_takeover,
            client_max_window_bits=source.client_max_window_bits,
            server_no_context_takeover=source.server_no_context_takeover,
            server_max_window_bits=source.server_max_window_bits,
        )
        if not source.enabled():
            raise RuntimeError("mitmproxy passed a disabled permessage-deflate extension")
        self.finalize(self.name)
        self._budget = budget

    def _discard_inbound_state(self) -> None:
        self._decompressor = None
        self._inbound_is_compressible = None
        self._inbound_compressed = None
        self._budget.reset()

    def clear(self) -> None:
        self._compressor = None
        self._discard_inbound_state()

    def _decompress_bounded(self, data: bytes) -> bytes | CloseReason:
        decompressor = self._decompressor
        if decompressor is None:
            raise RuntimeError("compressed WebSocket data arrived without a decompressor")
        remaining = self._budget.remaining_bytes
        try:
            decoded = decompressor.decompress(data, remaining + 1)
        except zlib.error:
            self._discard_inbound_state()
            return CloseReason.INVALID_FRAME_PAYLOAD_DATA

        if len(decoded) > remaining or decompressor.unconsumed_tail:
            self._budget.reject_bounded_decode_output(remaining + 1)
            self._discard_inbound_state()
            return CloseReason.MESSAGE_TOO_BIG
        return decoded

    def frame_inbound_header(
        self,
        proto: FrameDecoder | FrameProtocol,
        opcode: Opcode,
        rsv: RsvBits,
        payload_length: int,
    ) -> RsvBits | CloseReason:
        inbound_compressed = self._inbound_compressed
        result = super().frame_inbound_header(proto, opcode, rsv, payload_length)
        if opcode.iscontrol():
            # Keep the parent's RSV checks without letting an idle control
            # header initialize the next data message's compression marker.
            self._inbound_compressed = inbound_compressed
        return result

    def frame_inbound_payload_data(
        self,
        proto: FrameDecoder | FrameProtocol,
        data: bytes,
    ) -> bytes | CloseReason:
        if not self._inbound_compressed or not self._inbound_is_compressible:
            return data
        return self._decompress_bounded(bytes(data))

    def frame_inbound_complete(
        self,
        proto: FrameDecoder | FrameProtocol,
        fin: bool,
    ) -> bytes | CloseReason | None:
        # A final control frame does not complete an interrupted data message.
        if not fin or not self._inbound_is_compressible:
            return None
        if not self._inbound_compressed:
            self._inbound_compressed = None
            return None

        decoded = self._decompress_bounded(_EMPTY_DEFLATE_BLOCK)
        if isinstance(decoded, CloseReason):
            return decoded
        if not self._budget.reserve_bytes(len(decoded)):
            self._discard_inbound_state()
            return CloseReason.MESSAGE_TOO_BIG

        if proto.client:
            no_context_takeover = self.server_no_context_takeover
        else:
            no_context_takeover = self.client_no_context_takeover
        if no_context_takeover:
            self._decompressor = None

        self._inbound_compressed = None
        return decoded


class _BoundedWebsocketConnection(_ORIGINAL_WEBSOCKET_CONNECTION):
    """Pinned mitmproxy connection with bounded inbound message state."""

    def __init__(
        self,
        connection_type: wsproto.ConnectionType,
        extensions: list[Extension] | None = None,
        trailing_data: bytes = b"",
        *,
        conn: connection.Connection,
    ) -> None:
        budget = _MessageBudget(
            conn=conn,
            max_decoded_bytes=MAX_DECODED_MESSAGE_BYTES,
            max_data_frames=MAX_MESSAGE_DATA_FRAMES,
            aggregate_budget=_aggregate_decoded_budget,
        )
        bounded_extensions: list[Extension] = []
        bounded_deflates: list[_BoundedPerMessageDeflate] = []
        for extension in extensions or []:
            if isinstance(extension, PerMessageDeflate):
                bounded_deflate = _BoundedPerMessageDeflate(extension, budget)
                bounded_extensions.append(bounded_deflate)
                bounded_deflates.append(bounded_deflate)
            else:
                bounded_extensions.append(extension)

        message_limit = _DecodedMessageLimit(budget)
        bounded_extensions.append(message_limit)
        super().__init__(
            connection_type,
            bounded_extensions,
            trailing_data,
            conn=conn,
        )
        self._message_limit = message_limit
        self._bounded_deflates = bounded_deflates
        self.frame_buf = [self._mutable_fragment()]

    @staticmethod
    def _mutable_fragment(data: bytes = b"") -> bytes:
        # mitmproxy types frame_buf as list[bytes], but bytearray is accepted by
        # bytes.join and makes its existing ``frame_buf[-1] += data`` mutate.
        return cast(bytes, bytearray(data))

    def _ensure_mutable_fragment(self) -> None:
        if not self.frame_buf:
            self.frame_buf.append(self._mutable_fragment())
        elif isinstance(self.frame_buf[-1], bytes):
            self.frame_buf[-1] = self._mutable_fragment(self.frame_buf[-1])

    def _clear_partial_state(self) -> None:
        self.frame_buf = [self._mutable_fragment()]
        self._message_limit.clear()
        for extension in self._bounded_deflates:
            extension.clear()

    def events(self) -> Generator[events.Event, None, None]:
        try:
            for event in super().events():
                if isinstance(event, events.CloseConnection):
                    self._clear_partial_state()
                try:
                    yield event
                finally:
                    if isinstance(event, events.Message) and event.message_finished:
                        self._message_limit._budget.finish_message()
                    self._ensure_mutable_fragment()
        finally:
            self._ensure_mutable_fragment()

    def send2(self, event: events.Event) -> commands.SendData:
        if isinstance(event, events.CloseConnection):
            self._clear_partial_state()
        return super().send2(event)


setattr(_BoundedWebsocketConnection, _CONNECTION_MARKER_ATTRIBUTE, True)


def log_limit_violation(flow: http.HTTPFlow) -> None:
    """Write and consume content-free framing diagnostics for a terminal flow."""
    for direction, conn in (
        ("client_to_server", flow.client_conn),
        ("server_to_client", flow.server_conn),
    ):
        violation = getattr(conn, _MESSAGE_LIMIT_VIOLATION_ATTRIBUTE, None)
        if not isinstance(violation, _MessageLimitViolation):
            continue
        delattr(conn, _MESSAGE_LIMIT_VIOLATION_ATTRIBUTE)
        log_proxy_entry(
            flow_metadata.proxy_log_path(flow.metadata),
            "warn",
            "WebSocket message rejected by framing limit",
            type="websocket_framing_limit",
            reason=violation.reason,
            direction=direction,
            limit_unit=violation.unit,
            limit_value=violation.limit_value,
            observed_value=violation.observed_value,
            observed_is_lower_bound=violation.observed_is_lower_bound,
            close_code=int(CloseReason.MESSAGE_TOO_BIG),
            run_id=flow_metadata.run_id(flow.metadata),
            flow_id=flow.id,
            firewall_name=flow_metadata.firewall_name(flow.metadata),
        )


def release_flow_state(flow: http.HTTPFlow) -> None:
    """Release connection-scoped diagnostic state."""
    for conn in (flow.client_conn, flow.server_conn):
        if hasattr(conn, _MESSAGE_LIMIT_VIOLATION_ATTRIBUTE):
            delattr(conn, _MESSAGE_LIMIT_VIOLATION_ATTRIBUTE)


def reset_aggregate_budget_for_tests() -> None:
    """Reset aggregate decoded-byte ownership between tests."""
    _aggregate_decoded_budget.reset_for_tests()


def install_websocket_framing() -> None:
    """Install the pinned connection class once."""
    current_connection = websocket.WebsocketConnection
    if hasattr(current_connection, _CONNECTION_MARKER_ATTRIBUTE):
        return
    if current_connection is not _ORIGINAL_WEBSOCKET_CONNECTION:
        raise RuntimeError("mitmproxy WebsocketConnection has an incompatible shape")
    websocket.WebsocketConnection = _BoundedWebsocketConnection
