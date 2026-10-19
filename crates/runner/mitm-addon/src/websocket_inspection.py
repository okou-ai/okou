"""Await bounded Responses message inspection on its native hook owner."""

from collections.abc import Awaitable, Generator

from mitmproxy import http

import flow_metadata
import flow_metadata_keys as metadata_keys
import model_websocket_usage
import usage
import websocket_retention
from response_inspection import CooperativeResponseInspection


def _message_steps(
    flow: http.HTTPFlow, body: bytes, *, from_client: bool
) -> Generator[None, None, None]:
    if from_client:
        client = yield from usage.inspect_openai_responses_client_event_steps(body)
        if model_websocket_usage.is_enabled(flow):
            model_websocket_usage.observe_client_event(flow, client)
        return
    event = usage.inspect_openai_responses_event_json(body)
    inspection = yield from usage.inspect_openai_responses_server_event_steps(
        event,
        include_lifecycle=model_websocket_usage.should_inspect_server_lifecycle(flow, event),
    )
    model_websocket_usage.feed_usage(flow, inspection)


def inspect_message(flow: http.HTTPFlow) -> Awaitable[None] | None:
    """Complete cheap messages inline; defer remaining work to the awaited hook."""
    if not flow.websocket or not flow.websocket.messages:
        return None
    message = flow.websocket.messages[-1]
    if (
        not flow_metadata.run_id(flow.metadata)
        or not model_websocket_usage.is_enabled(flow)
        or (message.from_client and not model_websocket_usage.should_observe_client_event(flow))
    ):
        websocket_retention.schedule_message_trim(flow)
        return None
    if metadata_keys.WEBSOCKET_INSPECTION in flow.metadata:
        raise RuntimeError("WebSocket inspection must finish before the next message hook")
    from_client = message.from_client
    owner = CooperativeResponseInspection(
        lambda body: _message_steps(flow, body, from_client=from_client),
        lambda _reason: model_websocket_usage.interrupt_inspection(flow),
    )
    flow.metadata[metadata_keys.WEBSOCKET_INSPECTION] = owner
    try:
        body = message.content.encode() if isinstance(message.content, str) else message.content
        owner.feed(body)
    except BaseException:
        release(flow)
        websocket_retention.schedule_message_trim(flow)
        raise
    if owner.has_pending():
        return _complete_message(flow, owner)
    release(flow)
    websocket_retention.schedule_message_trim(flow)
    return None


async def _complete_message(flow: http.HTTPFlow, owner: CooperativeResponseInspection) -> None:
    try:
        await owner.drain()
    finally:
        if flow.metadata.get(metadata_keys.WEBSOCKET_INSPECTION) is owner:
            release(flow)
        websocket_retention.schedule_message_trim(flow)


def release(flow: http.HTTPFlow) -> None:
    """Invalidate pending inspection before terminal reporting and cleanup."""
    owner = flow.metadata.pop(metadata_keys.WEBSOCKET_INSPECTION, None)
    if isinstance(owner, CooperativeResponseInspection):
        owner.close()
