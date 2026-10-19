"""Bound completed WebSocket history without retaining large messages.

Mitmproxy shares each flow's message list across addon hook dispatch. Registered
flows therefore defer trimming to the event loop, preserving unchanged history
for subsequent synchronous addon hooks in the same dispatch. Activated Responses
messages also hold history across their awaited native hook so an earlier
deferred trim cannot remove a message before its inspection starts. Unregistered
ordinary flows keep mitmproxy's normal history for small messages. The callback
retains the latest complete registered-flow message when it is within the
history boundary and releases larger messages on every flow. Pre-hook message
assembly is bounded separately by ``websocket_framing``.

See ``tests/test_websocket_retention.py`` and
``tests/test_deferred_scheduler.py`` for the executable contract.
"""

from mitmproxy import http, websocket

import deferred_callbacks
import flow_metadata

_WEBSOCKET_MESSAGE_TRIM_SCHEDULED = "_websocket_message_trim_scheduled"
_WEBSOCKET_MESSAGE_HOOK_ACTIVE = "_websocket_message_hook_active"
MAX_RETAINED_MESSAGE_BYTES = 16 * 1024 * 1024


def _message_is_large(message: websocket.WebSocketMessage) -> bool:
    return len(message.content) > MAX_RETAINED_MESSAGE_BYTES


def schedule_message_trim(flow: http.HTTPFlow) -> None:
    """Schedule one deferred history trim when this WebSocket flow needs one.

    Small ordinary flows without a run ID and flows without a WebSocket are
    left unchanged. Large messages on every flow are released after synchronous
    hook dispatch. Repeated calls coalesce into one pending callback, leaving
    history intact until control returns to the event loop.
    """
    websocket_data = flow.websocket
    if websocket_data is None or not websocket_data.messages:
        return
    if not flow_metadata.run_id(flow.metadata) and not _message_is_large(
        websocket_data.messages[-1]
    ):
        return
    if flow.metadata.get(_WEBSOCKET_MESSAGE_TRIM_SCHEDULED, False):
        return
    flow.metadata[_WEBSOCKET_MESSAGE_TRIM_SCHEDULED] = True
    deferred_callbacks.call_soon(_trim_messages, flow)


def hold_message(flow: http.HTTPFlow) -> None:
    """Protect a native message from earlier deferred trims during its hook."""
    flow.metadata[_WEBSOCKET_MESSAGE_HOOK_ACTIVE] = True


def release_message(flow: http.HTTPFlow) -> None:
    flow.metadata.pop(_WEBSOCKET_MESSAGE_HOOK_ACTIVE, None)
    schedule_message_trim(flow)


def release_terminal_messages(flow: http.HTTPFlow) -> None:
    """Release retained messages at a registered flow's terminal boundary.

    The scheduling marker is removed before registered history is cleared or
    large unregistered messages are removed. A callback that was already queued
    may still run afterward and safely observes the updated list.
    """
    flow.metadata.pop(_WEBSOCKET_MESSAGE_TRIM_SCHEDULED, None)
    flow.metadata.pop(_WEBSOCKET_MESSAGE_HOOK_ACTIVE, None)
    websocket_data = flow.websocket
    if websocket_data is None:
        return
    if flow_metadata.run_id(flow.metadata):
        websocket_data.messages.clear()
        return
    websocket_data.messages[:] = [
        message for message in websocket_data.messages if not _message_is_large(message)
    ]


def _trim_messages(flow: http.HTTPFlow) -> None:
    flow.metadata.pop(_WEBSOCKET_MESSAGE_TRIM_SCHEDULED, None)
    if flow.metadata.get(_WEBSOCKET_MESSAGE_HOOK_ACTIVE, False):
        return
    websocket_data = flow.websocket
    if websocket_data is None or not websocket_data.messages:
        return
    if not flow_metadata.run_id(flow.metadata):
        websocket_data.messages[:] = [
            message for message in websocket_data.messages if not _message_is_large(message)
        ]
        return
    latest = websocket_data.messages[-1]
    if _message_is_large(latest):
        websocket_data.messages.clear()
        return
    websocket_data.messages[:] = [latest]
