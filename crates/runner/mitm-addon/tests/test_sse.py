"""Tests for the bounded usage SSE scanner."""

import pytest

from usage.sse import SseUsageScanner


class _CaptureHandler:
    def __init__(self, target_events: set[str | None]) -> None:
        self.target_events = target_events
        self.current: bytearray | None = None
        self.started: list[str | None] = []
        self.events: list[tuple[str | None, bytes]] = []
        self.discarded: list[str | None] = []

    def should_capture_event(self, event_name: str | None) -> bool:
        return event_name in self.target_events

    def on_event_start(self, event_name: str | None) -> None:
        self.started.append(event_name)
        self.current = bytearray()

    def on_data(self, chunk: bytes) -> None:
        assert self.current is not None
        self.current.extend(chunk)

    def on_data_separator(self) -> None:
        self.on_data(b"\n")

    def on_event_end(self, event_name: str | None) -> None:
        assert self.current is not None
        self.events.append((event_name, bytes(self.current)))
        self.current = None

    def on_event_discard(self, event_name: str | None) -> None:
        self.discarded.append(event_name)
        self.current = None


class _FindTrackingBytes(bytes):
    find_calls: list[tuple[bytes, int, int | None]]

    def __new__(cls, value: bytes) -> _FindTrackingBytes:
        instance = super().__new__(cls, value)
        instance.find_calls = []
        return instance

    def find(self, sub: bytes, start: int = 0, end: int | None = None) -> int:
        self.find_calls.append((sub, start, end))
        if end is None:
            return super().find(sub, start)
        return super().find(sub, start, end)


@pytest.mark.parametrize(
    "bom_chunks",
    [
        pytest.param((b"\xef\xbb\xbf",), id="one-chunk"),
        pytest.param((b"\xef", b"\xbb\xbf"), id="one-plus-two"),
        pytest.param((b"\xef\xbb", b"\xbf"), id="two-plus-one"),
        pytest.param((b"\xef", b"\xbb", b"\xbf"), id="three-chunks"),
    ],
)
def test_ignores_one_leading_utf8_bom_across_chunks(bom_chunks: tuple[bytes, ...]) -> None:
    handler = _CaptureHandler({"target"})
    scanner = SseUsageScanner(handler)

    for chunk in bom_chunks:
        scanner.feed(chunk)
    scanner.feed(b"event: target\ndata: ok\n\n")

    assert handler.events == [("target", b"ok")]
    assert handler.discarded == []


@pytest.mark.parametrize("partial_bom", [b"\xef", b"\xef\xbb"])
def test_preserves_mismatched_partial_bom_at_stream_start(partial_bom: bytes) -> None:
    handler = _CaptureHandler({"target"})
    scanner = SseUsageScanner(handler)

    scanner.feed(partial_bom + b"event: target\ndata: ignored\n\n")

    assert handler.started == []
    assert handler.events == []
    assert handler.discarded == []


@pytest.mark.parametrize(
    "prefix",
    [
        pytest.param(b"\xef\xbb\xbf\xef\xbb\xbf", id="second-bom"),
        pytest.param(b": comment\n\xef\xbb\xbf", id="later-bom"),
    ],
)
def test_does_not_strip_utf8_bom_after_stream_start(prefix: bytes) -> None:
    handler = _CaptureHandler({"target"})
    scanner = SseUsageScanner(handler)

    scanner.feed(prefix + b"event: target\ndata: ignored\n\n")

    assert handler.started == []
    assert handler.events == []
    assert handler.discarded == []


def test_preserves_utf8_bom_in_captured_data() -> None:
    handler = _CaptureHandler({"target"})
    scanner = SseUsageScanner(handler)

    scanner.feed(b"\xef\xbb\xbfevent: target\ndata: \xef\xbb\xbfpayload\n\n")

    assert handler.events == [("target", b"\xef\xbb\xbfpayload")]
    assert handler.discarded == []


@pytest.mark.parametrize(
    ("preferred_newline", "other_newline"),
    [
        (b"\n", b"\r"),
        (b"\r", b"\n"),
    ],
)
def test_data_line_search_bounds_other_line_ending_before_preferred_match(
    preferred_newline: bytes,
    other_newline: bytes,
) -> None:
    handler = _CaptureHandler({"target"})
    scanner = SseUsageScanner(handler)
    data_prefix = b"event: target" + preferred_newline + b"data: "
    chunk = _FindTrackingBytes(
        data_prefix + b"payload" + preferred_newline + b"data: " + b"x" * 10_000 + other_newline
    )
    data_start = len(data_prefix)
    data_end = data_start + len(b"payload")

    scanner.feed(chunk)

    assert handler.started == ["target"]
    assert handler.events == []
    assert handler.discarded == []
    assert chunk.find_calls[:2] == [
        (preferred_newline, data_start, None),
        (other_newline, data_start, data_end),
    ]


def test_streams_target_multi_data_with_newline_injection() -> None:
    handler = _CaptureHandler({"target"})
    scanner = SseUsageScanner(handler)

    scanner.feed(b"eve")
    scanner.feed(b"nt: target\nda")
    scanner.feed(b'ta: {"a":')
    scanner.feed(b"\ndata:")
    scanner.feed(b" 1}\n\n")

    assert handler.started == ["target"]
    assert handler.events == [("target", b'{"a":\n1}')]
    assert handler.discarded == []


def test_finish_flushes_current_event_without_blank_line() -> None:
    handler = _CaptureHandler({"target"})
    scanner = SseUsageScanner(handler)

    scanner.feed(b"event: target\ndata: ok")
    scanner.finish()
    scanner.finish()

    assert handler.events == [("target", b"ok")]


def test_callable_scanner_feeds_chunks_and_finish_flushes() -> None:
    handler = _CaptureHandler({"target"})
    scanner = SseUsageScanner(handler)

    scanner(b"event: target\n")
    scanner(b"data: ok")
    scanner.finish()

    assert handler.events == [("target", b"ok")]


def test_ignores_comment_only_frame() -> None:
    handler = _CaptureHandler({"target"})
    scanner = SseUsageScanner(handler)

    scanner.feed(b": heartbeat\n\n")

    assert handler.started == []
    assert handler.events == []
    assert handler.discarded == []


def test_comment_does_not_break_event_stream() -> None:
    handler = _CaptureHandler({"target"})
    scanner = SseUsageScanner(handler)

    scanner.feed(b"event: target\n: keepalive\ndata: ok\n\n")

    assert handler.events == [("target", b"ok")]
    assert handler.discarded == []


def test_bare_data_field_without_colon_emits_empty_data() -> None:
    handler = _CaptureHandler({"target"})
    scanner = SseUsageScanner(handler)

    scanner.feed(b"event: target\ndata\n\n")

    assert handler.started == ["target"]
    assert handler.events == [("target", b"")]
    assert handler.discarded == []


def test_supports_no_optional_space_and_split_crlf() -> None:
    handler = _CaptureHandler({"target"})
    scanner = SseUsageScanner(handler)

    scanner.feed(b"event:target\r")
    scanner.feed(b"\ndata:payload\r")
    scanner.feed(b"\n\r")
    scanner.feed(b"\n")

    assert handler.events == [("target", b"payload")]


def test_can_capture_data_before_target_event_name() -> None:
    handler = _CaptureHandler({"target"})
    scanner = SseUsageScanner(handler, capture_data_without_event=True)

    scanner.feed(b"data: ok\n")
    scanner.feed(b"event: target\n\n")

    assert handler.events == [("target", b"ok")]


def test_discards_data_before_ignored_event_name() -> None:
    handler = _CaptureHandler({"target"})
    scanner = SseUsageScanner(handler, capture_data_without_event=True)

    scanner.feed(b"data: ignored\n")
    scanner.feed(b"event: ignored\n\n")

    assert handler.events == []
    assert handler.discarded == ["ignored"]


def test_event_name_can_change_before_data_starts() -> None:
    handler = _CaptureHandler({"target"})
    scanner = SseUsageScanner(handler)

    scanner.feed(b"event: ignored\n")
    scanner.feed(b"event: target\n")
    scanner.feed(b"data: ok\n\n")

    assert handler.events == [("target", b"ok")]
    assert handler.discarded == []


def test_target_after_discarded_data_does_not_emit_partial_event() -> None:
    handler = _CaptureHandler({"target"})
    scanner = SseUsageScanner(handler)

    scanner.feed(b"event: ignored\n")
    scanner.feed(b"data: already-discarded\n")
    scanner.feed(b"event: target\n")
    scanner.feed(b"data: partial\n\n")

    assert handler.events == []
    assert handler.discarded == []


@pytest.mark.parametrize("newline", [b"\n", b"\r\n", b"\r"])
def test_supports_sse_line_endings(newline: bytes) -> None:
    handler = _CaptureHandler({"target"})
    scanner = SseUsageScanner(handler)

    scanner.feed(b"event: target" + newline + b"data: payload" + newline + newline)

    assert handler.events == [("target", b"payload")]


@pytest.mark.parametrize(
    ("hint_newline", "data_newline", "later_newline"),
    [
        (b"\n", b"\r", b"\n"),
        (b"\r", b"\n", b"\r"),
    ],
)
def test_data_line_uses_earliest_line_ending_when_hint_prefers_later_match(
    hint_newline: bytes,
    data_newline: bytes,
    later_newline: bytes,
) -> None:
    handler = _CaptureHandler({"target"})
    scanner = SseUsageScanner(handler)

    scanner.feed(
        b"event: target"
        + hint_newline
        + b"data: payload"
        + data_newline
        + b"ignored"
        + later_newline
        + later_newline
    )

    assert handler.events == [("target", b"payload")]
    assert handler.discarded == []


@pytest.mark.parametrize("newline", [b"\n", b"\r"])
def test_streams_many_data_lines_in_one_chunk(newline: bytes) -> None:
    handler = _CaptureHandler({"target"})
    scanner = SseUsageScanner(handler)
    payloads = [f"line-{i}".encode() for i in range(1000)]

    scanner.feed(
        b"event: target"
        + newline
        + b"".join(b"data: " + payload + newline for payload in payloads)
        + newline
    )

    assert handler.events == [("target", b"\n".join(payloads))]
    assert handler.discarded == []


def test_discards_many_cr_only_data_lines_and_recovers_in_same_chunk() -> None:
    handler = _CaptureHandler({"target"})
    scanner = SseUsageScanner(handler)

    scanner.feed(
        b"event: ignored\r"
        + (b"data: ignored\r" * 1000)
        + b"\r"
        + b"event: target\r"
        + b"data: ok\r"
        + b"\r"
    )

    assert handler.events == [("target", b"ok")]
    assert handler.discarded == []


def test_skips_large_ignored_event_and_recovers_in_same_chunk() -> None:
    handler = _CaptureHandler({"target"})
    scanner = SseUsageScanner(handler)

    scanner.feed(
        b"event: ignored\n"
        + b"data: "
        + b"x" * 200_000
        + b"\n\n"
        + b"event: target\n"
        + b"data: ok\n\n"
    )

    assert handler.events == [("target", b"ok")]
    assert handler.discarded == []


def test_long_malformed_control_line_recovers_for_next_event() -> None:
    handler = _CaptureHandler({"target"})
    scanner = SseUsageScanner(handler)

    scanner.feed(b"x" * 5000 + b"\n" + b"event: target\n" + b"data: ok\n\n")

    assert handler.events == [("target", b"ok")]


def test_long_malformed_control_line_does_not_retain_cross_chunk_continuation() -> None:
    max_control_line_bytes = 16
    handler = _CaptureHandler({"target"})
    scanner = SseUsageScanner(handler, max_control_line_bytes=max_control_line_bytes)

    scanner.feed(b"x" * (max_control_line_bytes + 1))
    for _ in range(64):
        scanner.feed(b"y" * 4096)
        assert len(scanner._line_buf) <= max_control_line_bytes

    scanner.feed(b"\nevent: target\ndata: ok\n\n")

    assert handler.events == [("target", b"ok")]


def test_long_malformed_control_line_discards_current_event() -> None:
    handler = _CaptureHandler({"target"})
    scanner = SseUsageScanner(handler)

    scanner.feed(
        b"event: target\n"
        b"data: partial\n" + b"x" * 5000 + b"\n\n" + b"event: target\n" + b"data: ok\n\n"
    )

    assert handler.discarded == ["target"]
    assert handler.events == [("target", b"ok")]
