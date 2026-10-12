"""Bounded Server-Sent Events scanner for usage extraction.

The scanner owns only SSE framing: line endings, event names, skipped events,
and ``data`` field boundaries.  Provider modules own JSON parsing and billing
field mapping through the callback interface below.

Some provider usage streams omit SSE ``event:`` names and put the event type in
the JSON ``data:`` payload instead.  For those streams, the scanner can
optimistically capture data before an event name is known while keeping provider
JSON and billing semantics outside this module.
"""

from collections.abc import Iterator
from typing import Protocol

_CR = ord("\r")
_LF = ord("\n")
_CR_BYTE = b"\r"
_LF_BYTE = b"\n"
_SPACE = ord(" ")
_DATA_FIELD_PREFIX = b"data:"
_UTF8_BOM = b"\xef\xbb\xbf"

# Non-data SSE control lines are expected to be tiny.  Cap malformed lines so
# an upstream bug cannot grow memory while we wait for a newline.
_MAX_CONTROL_LINE_BYTES = 4096
# Cooperative steps also bound nonterminating data and discarded/control lines.
_MAX_STEP_BYTES = 4096


class SseUsageEventHandler(Protocol):
    """Provider-owned sink for target SSE event data."""

    def should_capture_event(self, event_name: str | None) -> bool:
        """Return whether data fields for *event_name* should be streamed.

        ``event_name`` is ``None`` before the scanner has seen an ``event:``
        line.  When ``capture_data_without_event`` is enabled, the scanner may
        still start capture for a data-before-event frame and let a later
        ``event:`` line or provider-owned JSON parsing decide the final event.
        """
        raise NotImplementedError

    def on_event_start(self, event_name: str | None) -> None:
        """Called before the first captured data field in an event.

        ``event_name`` may be ``None`` for event-less frames or for data fields
        that arrive before their eventual ``event:`` line.
        """

    def on_data(self, chunk: bytes) -> None:
        """Called with bytes from a captured data field."""

    def on_data_separator(self) -> None:
        """Called between multiple captured data fields in one event."""

    def on_event_end(self, event_name: str | None) -> None:
        """Called when a captured event is finalized.

        This happens at a blank-line boundary or when ``SseUsageScanner.finish()``
        flushes a captured trailing event at end-of-stream without a blank-line
        terminator.

        The value is the final SSE event name if one was seen, or ``None`` if
        the frame ended without an ``event:`` line.
        """

    def on_event_discard(self, event_name: str | None) -> None:
        """Called when an in-progress captured event must be discarded.

        This can happen when an optimistic data-before-event capture is later
        assigned a non-capturable event name.
        """


class SseUsageScanner:
    """Incrementally scan SSE bytes and stream target ``data`` fields.

    This is deliberately not a full EventSource implementation and does not
    return assembled event bodies.  It keeps only bounded control-line state;
    captured ``data`` payload bytes are streamed directly to the handler.
    One optional UTF-8 byte-order mark is ignored only at stream start.

    With ``capture_data_without_event=True``, the first ``data:`` field can
    start a captured event while the current event name is still ``None``.  If a
    later ``event:`` line arrives and the handler accepts that final name, the
    event completes through ``on_event_end(final_event_name)``.  If the final
    name is not capturable, the in-progress event is discarded through
    ``on_event_discard(final_event_name)``.  If no ``event:`` line arrives, the
    event completes through ``on_event_end(None)`` so provider handlers can
    inspect payload fields such as a JSON ``type`` value.
    """

    def __init__(
        self,
        handler: SseUsageEventHandler,
        *,
        max_control_line_bytes: int = _MAX_CONTROL_LINE_BYTES,
        capture_data_without_event: bool = False,
    ) -> None:
        """Create a bounded SSE usage scanner.

        ``capture_data_without_event`` supports provider streams whose event
        type is carried in the JSON payload instead of the SSE ``event:`` field.
        It only affects data fields seen while the current event name is
        ``None``; named events still go through ``should_capture_event``.
        """
        self._handler = handler
        self._max_control_line_bytes = max_control_line_bytes
        self._capture_data_without_event = capture_data_without_event
        self._event_name: str | None = None
        self._line_buf = bytearray()
        self._at_stream_start = True
        self._state = "line"
        self._discard_event = False
        self._skip_next_lf = False
        self._line_ending_hint = _LF
        self._capturing_event = False
        self._captured_data_lines = 0

    def __call__(self, chunk: bytes) -> None:
        self.feed(chunk)

    def feed(self, chunk: bytes) -> None:
        i = 0
        while i < len(chunk):
            byte = chunk[i]
            if self._skip_next_lf:
                self._skip_next_lf = False
                if byte == _LF:
                    i += 1
                    continue

            if self._state == "data":
                i = self._consume_data(chunk, i)
            elif self._state == "data_prefix_space":
                i = self._consume_data_prefix_space(chunk, i)
            elif self._state == "discard_line":
                i = self._consume_discard_line(chunk, i)
            else:
                i = self._consume_line(chunk, i)

    def feed_steps(self, chunk: bytes) -> Iterator[None]:
        """Yield after each event boundary or at most 4 KiB of framing work.

        Use the same synchronous framing implementation on bounded line slices.
        Blank, ignored and malformed frames consume steps too. The caller must
        exhaust this iterator before feeding more input or finalizing the scanner.
        """
        for offset in range(0, len(chunk), _MAX_STEP_BYTES):
            fragment = chunk[offset : offset + _MAX_STEP_BYTES]
            i = 0
            checkpoint = 0
            while i < len(fragment):
                line_end = _find_next_line_ending(fragment, i, self._line_ending_hint)
                end = len(fragment) if line_end == -1 else line_end + 1
                event_boundary = (
                    line_end == i
                    and self._state == "line"
                    and not self._line_buf
                    and not (self._skip_next_lf and fragment[i] == _LF)
                )
                self.feed(fragment[i:end])
                i = end
                if event_boundary:
                    checkpoint = i
                    yield None
            if checkpoint != len(fragment):
                yield None

    def finish(self) -> None:
        """Flush a trailing captured event at end-of-stream without a blank-line terminator."""

        self._at_stream_start = False
        if self._state == "data_prefix_space":
            self._start_data_line()
        elif self._state == "line" and self._line_buf:
            line = bytes(self._line_buf)
            self._line_buf.clear()
            self._process_control_line(line)

        self._state = "line"
        self._line_buf.clear()
        self._skip_next_lf = False
        if self._capturing_event:
            self._finish_event()
        else:
            self._event_name = None
            self._discard_event = False
            self._captured_data_lines = 0

    def _consume_line(self, chunk: bytes, i: int) -> int:
        byte = chunk[i]
        if _is_line_ending(byte):
            self._at_stream_start = False
            self._finish_control_line(byte)
            return i + 1

        self._line_buf.append(byte)
        if self._at_stream_start:
            if _UTF8_BOM.startswith(self._line_buf):
                if self._line_buf == _UTF8_BOM:
                    self._line_buf.clear()
                    self._at_stream_start = False
                return i + 1
            self._at_stream_start = False

        if self._line_buf == _DATA_FIELD_PREFIX:
            self._line_buf.clear()
            self._state = "data_prefix_space"
        elif len(self._line_buf) > self._max_control_line_bytes:
            self._discard_malformed_control_line()
        return i + 1

    def _consume_data_prefix_space(self, chunk: bytes, i: int) -> int:
        byte = chunk[i]
        if _is_line_ending(byte):
            self._start_data_line()
            self._finish_data_or_discard_line(byte)
            return i + 1

        self._start_data_line()
        if byte == _SPACE:
            return i + 1
        return i

    def _consume_data(self, chunk: bytes, i: int) -> int:
        line_end = _find_next_line_ending(chunk, i, self._line_ending_hint)
        if line_end == -1:
            self._handler.on_data(chunk[i:])
            return len(chunk)

        if line_end > i:
            self._handler.on_data(chunk[i:line_end])
        self._finish_data_or_discard_line(chunk[line_end])
        return line_end + 1

    def _consume_discard_line(self, chunk: bytes, i: int) -> int:
        line_end = _find_next_line_ending(chunk, i, self._line_ending_hint)
        if line_end == -1:
            return len(chunk)

        self._finish_data_or_discard_line(chunk[line_end])
        return line_end + 1

    def _finish_control_line(self, line_ending: int) -> None:
        line = bytes(self._line_buf)
        self._line_buf.clear()
        self._process_control_line(line)
        self._state = "line"
        self._line_ending_hint = line_ending
        if line_ending == _CR:
            self._skip_next_lf = True

    def _finish_data_or_discard_line(self, line_ending: int) -> None:
        self._state = "line"
        self._line_ending_hint = line_ending
        if line_ending == _CR:
            self._skip_next_lf = True

    def _process_control_line(self, line: bytes) -> None:
        if line == b"":
            self._finish_event()
            return

        if self._discard_event:
            return

        if line == b"data":
            self._start_data_line()
            self._state = "line"
            return

        if line.startswith(b":"):
            return

        if b":" in line:
            field, value = line.split(b":", 1)
            if value.startswith(b" "):
                value = value[1:]
        else:
            field = line
            value = b""

        if field != b"event":
            return

        event_name = value.decode("utf-8", errors="replace")
        self._event_name = event_name
        if self._capturing_event and not self._handler.should_capture_event(event_name):
            self._discard_current_event(event_name)

    def _start_data_line(self) -> None:
        should_capture = self._handler.should_capture_event(self._event_name) or (
            self._event_name is None and self._capture_data_without_event
        )
        if self._discard_event or not should_capture:
            if not self._capturing_event:
                self._discard_event = True
            else:
                self._discard_current_event(self._event_name)
            self._state = "discard_line"
            return

        if not self._capturing_event:
            self._capturing_event = True
            self._captured_data_lines = 0
            self._handler.on_event_start(self._event_name)
        elif self._captured_data_lines > 0:
            self._handler.on_data_separator()

        self._captured_data_lines += 1
        self._state = "data"

    def _discard_malformed_control_line(self) -> None:
        self._line_buf.clear()
        if self._capturing_event or self._event_name is not None:
            self._discard_current_event(self._event_name)
        self._state = "discard_line"

    def _discard_current_event(self, event_name: str | None) -> None:
        if self._capturing_event:
            self._handler.on_event_discard(event_name)
        self._capturing_event = False
        self._captured_data_lines = 0
        self._discard_event = True

    def _finish_event(self) -> None:
        if self._capturing_event:
            self._handler.on_event_end(self._event_name)
        self._event_name = None
        self._discard_event = False
        self._capturing_event = False
        self._captured_data_lines = 0


def _is_line_ending(byte: int) -> bool:
    return byte in (_LF, _CR)


def _find_next_line_ending(chunk: bytes, start: int, preferred: int) -> int:
    preferred_byte = _LF_BYTE if preferred == _LF else _CR_BYTE
    other_byte = _CR_BYTE if preferred == _LF else _LF_BYTE

    next_preferred = chunk.find(preferred_byte, start)
    if next_preferred == -1:
        return chunk.find(other_byte, start)

    next_other = chunk.find(other_byte, start, next_preferred)
    if next_other == -1:
        return next_preferred
    return next_other
