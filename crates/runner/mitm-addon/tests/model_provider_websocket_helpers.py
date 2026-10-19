"""Shared WebSocket helpers for model-provider usage tests."""

import json
from collections.abc import Awaitable

import pytest
from mitmproxy import http, websocket
from wsproto.frame_protocol import Opcode

import mitm_addon
import model_websocket_usage
from tests.deferred_callback_helpers import (
    ScheduledCallback,
    capture_deferred_callbacks,
    run_deferred_callbacks,
)
from usage.json_selective import JsonSelectiveExtractor

type ScheduledWebSocketTrim = ScheduledCallback


def capture_deferred_websocket_trims(
    monkeypatch: pytest.MonkeyPatch,
) -> list[ScheduledWebSocketTrim]:
    return capture_deferred_callbacks(monkeypatch)


def capture_openai_responses_extractor_feeds(
    monkeypatch: pytest.MonkeyPatch,
) -> list[bytes]:
    """Record full-body extractor feeds while retaining the real parser."""
    observed: list[bytes] = []
    original_feed = JsonSelectiveExtractor.feed

    def record_feed(extractor: JsonSelectiveExtractor, chunk: bytes) -> None:
        observed.append(chunk)
        original_feed(extractor, chunk)

    monkeypatch.setattr(JsonSelectiveExtractor, "feed", record_feed)
    return observed


def run_deferred_websocket_trims(scheduled: list[ScheduledWebSocketTrim]) -> None:
    run_deferred_callbacks(scheduled)


def _make_websocket_message(
    *,
    from_client: bool,
    content: bytes,
) -> websocket.WebSocketMessage:
    return websocket.WebSocketMessage(
        Opcode.TEXT,
        from_client=from_client,
        content=content,
    )


def append_websocket_message(
    flow: http.HTTPFlow,
    *,
    from_client: bool,
    content: bytes,
) -> websocket.WebSocketMessage:
    message = _make_websocket_message(from_client=from_client, content=content)
    websocket_data = flow.websocket
    if websocket_data is None:
        websocket_data = websocket.WebSocketData(messages=[])
        flow.websocket = websocket_data
    websocket_data.messages.append(message)
    return message


def openai_websocket_usage_frame(
    response_id: str,
    *,
    input_tokens: int = 10,
    output_tokens: int = 4,
    model: str = "gpt-5.5",
) -> bytes:
    return json.dumps(
        {
            "type": "response.completed",
            "response": {
                "id": response_id,
                "model": model,
                "usage": {"input_tokens": input_tokens, "output_tokens": output_tokens},
            },
        }
    ).encode()


def set_websocket_message(
    flow: http.HTTPFlow,
    *,
    from_client: bool,
    content: bytes,
) -> None:
    flow.websocket = websocket.WebSocketData(messages=[])
    append_websocket_message(flow, from_client=from_client, content=content)


def _assert_model_websocket_usage_started(flow: http.HTTPFlow) -> None:
    assert model_websocket_usage.is_enabled(flow)


def feed_websocket_server_message(flow: http.HTTPFlow, content: bytes) -> Awaitable[None] | None:
    _assert_model_websocket_usage_started(flow)
    set_websocket_message(flow, from_client=False, content=content)
    return mitm_addon.websocket_message(flow)


def feed_websocket_client_message(flow: http.HTTPFlow, content: bytes) -> Awaitable[None] | None:
    _assert_model_websocket_usage_started(flow)
    set_websocket_message(flow, from_client=True, content=content)
    return mitm_addon.websocket_message(flow)


def feed_websocket_server_text_message(flow: http.HTTPFlow, content: str) -> None:
    _assert_model_websocket_usage_started(flow)
    set_websocket_message(flow, from_client=False, content=content.encode())
    assert flow.websocket is not None
    object.__setattr__(flow.websocket.messages[-1], "content", content)
    mitm_addon.websocket_message(flow)
