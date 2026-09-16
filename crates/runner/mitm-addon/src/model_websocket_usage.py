"""Model-provider WebSocket usage lifecycle state and settlement."""

from dataclasses import dataclass, field
from typing import Literal

from mitmproxy import http

import flow_metadata
import flow_metadata_keys as metadata_keys
import openai_responses_events
import run_usage
import usage
from logging_utils import log_proxy_entry

_MODEL_WEBSOCKET_USAGE_ENABLED = "model_websocket_usage_enabled"
_MODEL_WEBSOCKET_PREWARM_STATE = "_model_websocket_prewarm_state"
_MAX_IGNORED_RESPONSE_IDS = 100


@dataclass(slots=True)
class _OpenAIResponsesPrewarmState:
    pending_intent: Literal["normal", "prewarm"] | None = None
    active_intent: Literal["normal", "prewarm"] | None = None
    active_response_id: str | None = None
    ignored_response_diagnostics: dict[str, bool] = field(default_factory=dict)
    ambiguous: bool = False
    ambiguity_diagnostic_emitted: bool = False


_WebSocketCorrelationReason = Literal[
    "overlapping_request",
    "unknown_client_event",
    "invalid_lifecycle",
    "server_error",
    "correlation_cap",
]


def activate(flow: http.HTTPFlow) -> None:
    """Initialize usage state after a confirmed OpenAI Responses upgrade."""
    flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] = {}
    flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE_SOURCES] = {}
    flow.metadata[_MODEL_WEBSOCKET_PREWARM_STATE] = _OpenAIResponsesPrewarmState()
    flow.metadata[_MODEL_WEBSOCKET_USAGE_ENABLED] = True


def is_enabled(flow: http.HTTPFlow) -> bool:
    """Return whether model-provider WebSocket usage extraction is active.

    True means an HTTP 101 response is not terminal for tracked usage and
    reporting must wait for ``websocket_end()``.
    """
    return bool(flow.metadata.get(_MODEL_WEBSOCKET_USAGE_ENABLED, False))


def release_state(flow: http.HTTPFlow) -> None:
    """Disable usage extraction after a terminal WebSocket or error hook."""
    flow.metadata.pop(_MODEL_WEBSOCKET_USAGE_ENABLED, None)
    flow.metadata.pop(_MODEL_WEBSOCKET_PREWARM_STATE, None)


def _clear_correlation_candidate(state: _OpenAIResponsesPrewarmState) -> None:
    state.pending_intent = None
    state.active_intent = None
    state.active_response_id = None


def _lifecycle_ambiguity_reason(
    lifecycle: usage.OpenAIResponsesServerLifecycle,
) -> _WebSocketCorrelationReason:
    if lifecycle.work_limit_exceeded:
        return "correlation_cap"
    return "invalid_lifecycle"


def _mark_correlation_ambiguous(
    flow: http.HTTPFlow,
    state: _OpenAIResponsesPrewarmState,
    reason: _WebSocketCorrelationReason,
) -> None:
    """Disable prewarm exclusion after ownership can no longer be proven."""
    state.ambiguous = True
    run_usage.mark(flow, "ambiguous_response")
    _clear_correlation_candidate(state)
    # Fail-open is sticky for the rest of the flow. Previously ignored IDs
    # must not remain capable of suppressing usage after that transition.
    state.ignored_response_diagnostics.clear()
    if state.ambiguity_diagnostic_emitted:
        return
    log_proxy_entry(
        flow_metadata.proxy_log_path(flow.metadata),
        "warn",
        "Model provider WebSocket usage correlation became ambiguous",
        type="model_usage_correlation",
        disposition="ambiguous",
        reason=reason,
        run_id=flow_metadata.run_id(flow.metadata),
        flow_id=flow.id,
        transport="websocket",
        firewall_name=flow_metadata.firewall_name(flow.metadata),
    )
    state.ambiguity_diagnostic_emitted = True


def _retain_ignored_response_id(
    flow: http.HTTPFlow,
    state: _OpenAIResponsesPrewarmState,
    response_id: str,
) -> bool:
    if response_id in state.ignored_response_diagnostics:
        return True
    if len(state.ignored_response_diagnostics) >= _MAX_IGNORED_RESPONSE_IDS:
        _mark_correlation_ambiguous(flow, state, "correlation_cap")
        return False
    state.ignored_response_diagnostics[response_id] = False
    return True


def should_observe_client_event(flow: http.HTTPFlow) -> bool:
    """Return whether prewarm correlation still needs client evidence."""
    state = flow.metadata.get(_MODEL_WEBSOCKET_PREWARM_STATE)
    return (
        is_enabled(flow)
        and isinstance(state, _OpenAIResponsesPrewarmState)
        and (not state.ambiguous or run_usage.is_tracking(flow))
    )


def observe_client_event(
    flow: http.HTTPFlow,
    event: usage.OpenAIResponsesClientEvent,
) -> None:
    """Track bounded request intent on one WebSocket flow."""
    state = flow.metadata.get(_MODEL_WEBSOCKET_PREWARM_STATE)
    if event.request_kind != "unknown" and not event.is_prewarm:
        run_usage.websocket_pending(flow, pending=True)
    if not isinstance(state, _OpenAIResponsesPrewarmState):
        return

    if event.request_kind == "unknown":
        reason: _WebSocketCorrelationReason = (
            "correlation_cap" if event.work_limit_exceeded else "unknown_client_event"
        )
        _mark_correlation_ambiguous(flow, state, reason)
        return
    if state.ambiguous:
        return
    if state.pending_intent is not None or state.active_intent is not None:
        _mark_correlation_ambiguous(flow, state, "overlapping_request")
        return
    state.pending_intent = "prewarm" if event.is_prewarm else "normal"


def _observe_server_lifecycle(
    flow: http.HTTPFlow,
    state: _OpenAIResponsesPrewarmState,
    lifecycle: usage.OpenAIResponsesServerLifecycle,
) -> None:
    """Advance request intent state at a server lifecycle boundary."""
    if state.ambiguous:
        return
    if lifecycle.is_error:
        reason = "server_error" if lifecycle.is_valid else _lifecycle_ambiguity_reason(lifecycle)
        _mark_correlation_ambiguous(flow, state, reason)
        return
    if lifecycle.is_created:
        if not lifecycle.is_valid:
            _mark_correlation_ambiguous(
                flow,
                state,
                _lifecycle_ambiguity_reason(lifecycle),
            )
            return
        if lifecycle.response_id in state.ignored_response_diagnostics:
            # A retained ID only proves duplicate terminal ownership. Reusing it
            # at a new created boundary cannot be correlated safely.
            _mark_correlation_ambiguous(flow, state, "invalid_lifecycle")
            return
        if state.pending_intent is None or state.active_intent is not None:
            _mark_correlation_ambiguous(flow, state, "invalid_lifecycle")
            return
        state.active_intent = state.pending_intent
        state.active_response_id = lifecycle.response_id
        state.pending_intent = None
        return
    if lifecycle.is_terminal:
        if not lifecycle.is_valid:
            if state.pending_intent is not None or state.active_intent is not None:
                _mark_correlation_ambiguous(
                    flow,
                    state,
                    _lifecycle_ambiguity_reason(lifecycle),
                )
            return
        if lifecycle.response_id in state.ignored_response_diagnostics:
            # A pending request has no bound ID yet, so this could be either an
            # old duplicate or that request's terminal after a missing created
            # boundary. Only an idle flow or a differently bound active response
            # can prove that the retained ID is an old duplicate.
            if state.pending_intent is not None:
                _mark_correlation_ambiguous(flow, state, "invalid_lifecycle")
            return
        if (
            state.active_intent is None
            and state.pending_intent is not None
            and lifecycle.response_id not in state.ignored_response_diagnostics
        ):
            _mark_correlation_ambiguous(flow, state, "invalid_lifecycle")
            return
        if state.active_intent is not None and lifecycle.response_id != state.active_response_id:
            _mark_correlation_ambiguous(flow, state, "invalid_lifecycle")
        return
    if not lifecycle.is_valid and (
        state.pending_intent is not None or state.active_intent is not None
    ):
        _mark_correlation_ambiguous(
            flow,
            state,
            _lifecycle_ambiguity_reason(lifecycle),
        )


def should_inspect_server_lifecycle(
    flow: http.HTTPFlow,
    event: usage.OpenAIResponsesEvent,
) -> bool:
    """Return whether usage correlation needs lifecycle evidence for this frame."""
    if not is_enabled(flow):
        return False
    if run_usage.is_tracking(flow) and (
        event.event_type is None
        or event.event_type in openai_responses_events.SERVER_LIFECYCLE_EVENTS
    ):
        return True
    prewarm_state = flow.metadata.get(_MODEL_WEBSOCKET_PREWARM_STATE)
    return (
        isinstance(prewarm_state, _OpenAIResponsesPrewarmState)
        and not prewarm_state.ambiguous
        and (
            prewarm_state.pending_intent is not None
            or prewarm_state.active_intent is not None
            or bool(prewarm_state.ignored_response_diagnostics)
            or event.event_type is None
            or event.event_type in openai_responses_events.SERVER_LIFECYCLE_EVENTS
        )
    )


def feed_usage(
    flow: http.HTTPFlow,
    inspection: usage.OpenAIResponsesServerEventInspection,
) -> None:
    """Merge inspected model-provider usage from one server WebSocket frame.

    Called from ``websocket_message()`` only for server-originated frames after
    shared provider event inspection. Temporarily writes per-response sources
    while attempting a source-preserving report, then releases them from flow
    metadata. Frames without a response ID fall back to the per-flow usage
    accumulator. Callers must feed each server frame exactly once.
    """
    if not is_enabled(flow):
        return
    prewarm_state = flow.metadata.get(_MODEL_WEBSOCKET_PREWARM_STATE)
    lifecycle = inspection.lifecycle
    if lifecycle is not None and isinstance(prewarm_state, _OpenAIResponsesPrewarmState):
        _observe_server_lifecycle(flow, prewarm_state, lifecycle)
        if lifecycle.is_created and lifecycle.is_valid and prewarm_state.active_intent != "prewarm":
            run_usage.websocket_pending(flow, pending=True)

    usage_result = inspection.usage
    inspection_error = inspection.usage_error
    if inspection_error is not None:
        run_usage.mark(flow, "parse_error")
        if inspection_error == usage.OPENAI_RESPONSES_WEBSOCKET_WORK_LIMIT_ERROR and isinstance(
            prewarm_state, _OpenAIResponsesPrewarmState
        ):
            _mark_correlation_ambiguous(flow, prewarm_state, "correlation_cap")
        log_proxy_entry(
            flow_metadata.proxy_log_path(flow.metadata),
            "warn",
            "Model provider WebSocket usage extraction failed",
            type="usage_event",
            usage_protocol="openai_responses_websocket",
            error=inspection_error,
        )

    message_id_value = usage_result.get("message_id") if usage_result else None
    message_id = (
        message_id_value if isinstance(message_id_value, str) and message_id_value else None
    )
    has_message_id = message_id is not None
    suppressed = False
    if isinstance(prewarm_state, _OpenAIResponsesPrewarmState):
        if (
            lifecycle is not None
            and lifecycle.is_terminal
            and lifecycle.is_valid
            and lifecycle.response_id is not None
        ):
            terminal_id = lifecycle.response_id
            if (
                not prewarm_state.ambiguous
                and prewarm_state.active_intent == "prewarm"
                and prewarm_state.active_response_id == terminal_id
            ):
                suppressed = _retain_ignored_response_id(flow, prewarm_state, terminal_id)
            elif (
                not prewarm_state.ambiguous
                and terminal_id in prewarm_state.ignored_response_diagnostics
            ):
                suppressed = True
            if (
                suppressed
                and message_id == terminal_id
                and usage_result is not None
                and not prewarm_state.ignored_response_diagnostics[terminal_id]
                and usage.has_positive_model_provider_usage(usage_result)
            ):
                usage.log_ignored_model_provider_usage_source(
                    flow,
                    flow_metadata.run_id(flow.metadata),
                    terminal_id,
                    usage_result,
                    reason="responses_generate_false",
                )
                prewarm_state.ignored_response_diagnostics[terminal_id] = True
        if (
            not suppressed
            and usage_result is not None
            and (
                prewarm_state.pending_intent is not None or prewarm_state.active_intent is not None
            )
        ):
            if not has_message_id:
                if lifecycle is None or not lifecycle.is_terminal:
                    _mark_correlation_ambiguous(
                        flow,
                        prewarm_state,
                        "invalid_lifecycle",
                    )
            elif prewarm_state.active_intent is not None:
                active_id = prewarm_state.active_response_id
                if active_id != message_id or lifecycle is None or not lifecycle.is_terminal:
                    _mark_correlation_ambiguous(
                        flow,
                        prewarm_state,
                        "invalid_lifecycle",
                    )
            elif lifecycle is None or not lifecycle.is_terminal:
                _mark_correlation_ambiguous(
                    flow,
                    prewarm_state,
                    "invalid_lifecycle",
                )

    if not suppressed and usage_result:
        if lifecycle is None or not lifecycle.is_terminal:
            # Forward-compatible usage extraction does not prove that an
            # uncorrelated response finished, even when the socket looks idle.
            run_usage.mark(flow, "ambiguous_response")
        run_usage.observe(flow, usage_result, response_id=message_id)
        if has_message_id:
            usage_sources = flow.metadata.get(metadata_keys.MODEL_PROVIDER_USAGE_SOURCES)
            if not isinstance(usage_sources, dict):
                usage_sources = {}
                flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE_SOURCES] = usage_sources
            usage_target = usage_sources.get(message_id)
            if not isinstance(usage_target, dict):
                usage_target = {}
                usage_sources[message_id] = usage_target
            usage.merge_openai_responses_usage_result(usage_target, usage_result)
            run_id = flow_metadata.run_id(flow.metadata)
            usage.report_model_provider_usage_source(
                flow,
                run_id,
                message_id,
                usage_target,
            )
            usage_sources.pop(message_id, None)
        else:
            usage_target = flow.metadata.get(metadata_keys.MODEL_PROVIDER_USAGE)
            if not isinstance(usage_target, dict):
                usage_target = {}
                flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] = usage_target
            usage.merge_openai_responses_usage_result(usage_target, usage_result)

    if lifecycle is not None and lifecycle.is_terminal and not suppressed:
        # A duplicate prewarm terminal can arrive during a different response.
        # It owns no inference observation and cannot settle that active work.
        run_usage.terminal_response(flow)
    elif lifecycle is not None and lifecycle.is_error:
        run_usage.mark(flow, "interrupted")
        run_usage.terminal_response(flow)

    if not isinstance(prewarm_state, _OpenAIResponsesPrewarmState):
        return
    active_response_id = prewarm_state.active_response_id
    if (
        lifecycle is not None
        and lifecycle.is_terminal
        and lifecycle.is_valid
        and not prewarm_state.ambiguous
        and active_response_id is not None
        and active_response_id == lifecycle.response_id
    ):
        if prewarm_state.active_intent == "prewarm":
            _retain_ignored_response_id(flow, prewarm_state, active_response_id)
        prewarm_state.active_intent = None
        prewarm_state.active_response_id = None
