"""OpenAI Responses API usage parsing primitives.

This module handles the OpenAI Responses entry points that feed
model-provider usage billing:

- SSE streams via ``create_openai_responses_sse_usage_extractor``, consumed by
  ``response_streaming.py`` for ``text/event-stream`` responses.
- Non-streaming JSON bodies through provider field registration and result
  mapping consumed by the shared response inspector in ``response_streaming.py``.
- Single-frame WebSocket event JSON via
  ``inspect_openai_responses_client_event_json``,
  ``inspect_openai_responses_event_json``, and
  ``inspect_openai_responses_server_event``, consumed by ``mitm_addon.py`` and
  ``model_websocket_usage.py`` for client request intent, event-type timing,
  shared server failure evidence, lifecycle correlation, and usage received
  over upgrades.
  ``extract_openai_responses_usage_from_event`` retains the usage-only facade.
- Per-event usage aggregation via ``merge_openai_responses_usage_result``,
  used by ``response_streaming.py`` for terminal SSE events and
  ``model_websocket_usage.py`` for WebSocket events.
"""

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Literal

import openai_responses_events

from .json_probe import TopLevelStringFieldProbeResult, probe_top_level_string_field
from .json_selective import (
    JSON_INTEGER_VALUE_LIMIT_EXCEEDED,
    JSON_WORK_LIMIT_EXCEEDED,
    JsonExtractionResult,
    JsonSelectiveExtractor,
    ScalarField,
)
from .json_selective import Path as JsonPath
from .model_http import (
    ModelHttpFailureEvidence,
    ModelHttpFailureObserver,
    combined_scalar_fields,
    combined_value_presence_paths,
    failure_evidence_from_result,
)
from .model_tokens import (
    MODEL_USAGE_CATEGORIES,
    MODEL_USAGE_CATEGORY_CACHE_CREATION,
    MODEL_USAGE_CATEGORY_CACHE_READ,
    MODEL_USAGE_CATEGORY_INPUT,
    MODEL_USAGE_CATEGORY_OUTPUT,
    update_model_usage_quantity,
)
from .openai_tokens import input_partition_overlaps
from .openai_tokens import is_usage_quantity as _is_usage_quantity
from .openai_tokens import partition_input_tokens as _partition_input_tokens
from .quantities import MAX_USAGE_QUANTITY
from .sse import SseUsageScanner

_SseUsageParseErrorCallback = Callable[[str, str], None]
_SseTerminalUsageCallback = Callable[[dict], None]
_ResponsesEventTypeClassification = Literal[
    "terminal",
    "known_non_usage",
    "unknown",
    "unresolved",
    "pending",
]
_OpenAIResponsesClientRequestKind = Literal["create", "unknown"]
_RESPONSES_EVENT_TERMINAL: _ResponsesEventTypeClassification = "terminal"
_RESPONSES_EVENT_KNOWN_NON_USAGE: _ResponsesEventTypeClassification = "known_non_usage"
_RESPONSES_EVENT_UNKNOWN: _ResponsesEventTypeClassification = "unknown"
_RESPONSES_EVENT_UNRESOLVED: _ResponsesEventTypeClassification = "unresolved"
_RESPONSES_EVENT_PENDING: _ResponsesEventTypeClassification = "pending"
_JSON_PREFILTER_MAX_DEPTH = 256
_JSON_PREFILTER_MAX_STRING_BYTES = 1024
# Responses events normally expose ``type`` near the top of the JSON body.
# After this bounded prefix, fall back to the full selective extractor so rare
# terminal events with late ``type`` fields still report usage.
_RESPONSES_EVENT_PREFILTER_MAX_BYTES = 4096
# Bound dense syntax and slow scalar inspection while retaining the selective
# parser's bulk-scan path for ordinary large content strings.
_RESPONSES_MAX_WORK_UNITS = 65_536
OPENAI_RESPONSES_WEBSOCKET_WORK_LIMIT_ERROR = "work_limit_exceeded"


@dataclass(frozen=True)
class OpenAIResponsesClientEvent:
    """Bounded observations from one client-originated Responses frame."""

    event_type: str | None
    is_prewarm: bool
    request_kind: _OpenAIResponsesClientRequestKind = "unknown"
    work_limit_exceeded: bool = False


@dataclass(frozen=True)
class OpenAIResponsesServerLifecycle:
    """Bounded lifecycle observations needed before WebSocket settlement."""

    event_type: str | None
    response_id: str | None
    is_valid: bool = False
    work_limit_exceeded: bool = False

    @property
    def is_created(self) -> bool:
        return self.event_type == openai_responses_events.SERVER_CREATED_EVENT

    @property
    def is_terminal(self) -> bool:
        return self.event_type in openai_responses_events.TERMINAL_EVENTS

    @property
    def is_error(self) -> bool:
        return self.event_type == openai_responses_events.SERVER_ERROR_EVENT


@dataclass(frozen=True)
class OpenAIResponsesServerFailureEvidence:
    """Bounded machine evidence consumed by trusted failure reporting."""

    event_type: str | None
    response_id: str | None
    failure_codes: tuple[str, ...]
    is_valid: bool = False


@dataclass(frozen=True)
class OpenAIResponsesServerEventInspection:
    """Shared failure, lifecycle, and usage observations from one server frame."""

    lifecycle: OpenAIResponsesServerLifecycle | None
    usage: dict | None
    usage_error: str | None
    failure: OpenAIResponsesServerFailureEvidence


@dataclass(frozen=True)
class OpenAIResponsesEvent:
    """One inspected Responses WebSocket event.

    ``event_type`` is the top-level string ``type`` observed by the bounded
    prefix probe. It is ``None`` when that probe cannot return a value, including
    when the field is beyond the prefix, oversized, non-string, or missing, or
    when syntax is malformed before the field is complete. ``None`` does not mean
    that usage extraction cannot classify the retained complete frame.
    """

    event_type: str | None
    _body: bytes = field(repr=False)
    _classification: _ResponsesEventTypeClassification


_RESPONSES_RESPONSE_SCALAR_FIELDS = {
    ("id",): ScalarField("string", max_bytes=1024),
    ("model",): ScalarField("string", max_bytes=1024),
    ("service_tier",): ScalarField("string", max_bytes=1024),
    ("usage", "input_tokens"): ScalarField("int", max_bytes=64, max_int_value=MAX_USAGE_QUANTITY),
    ("usage", "output_tokens"): ScalarField("int", max_bytes=64, max_int_value=MAX_USAGE_QUANTITY),
    ("usage", "input_tokens_details", "cached_tokens"): ScalarField(
        "int", max_bytes=64, max_int_value=MAX_USAGE_QUANTITY
    ),
    ("usage", "input_tokens_details", "cache_write_tokens"): ScalarField(
        "int", max_bytes=64, max_int_value=MAX_USAGE_QUANTITY
    ),
}

_RESPONSES_SSE_RESPONSE_SCALAR_FIELDS = {
    **_RESPONSES_RESPONSE_SCALAR_FIELDS,
    **{("response", *path): field for path, field in _RESPONSES_RESPONSE_SCALAR_FIELDS.items()},
}
_RESPONSES_SSE_SCALAR_FIELDS = {
    ("type",): ScalarField("string", max_bytes=1024, overflow_policy="discard"),
    **_RESPONSES_SSE_RESPONSE_SCALAR_FIELDS,
}
_RESPONSES_WEBSOCKET_RESPONSE_SCALAR_FIELDS = {
    **_RESPONSES_RESPONSE_SCALAR_FIELDS,
    ("usage", "input_tokens"): ScalarField("int", max_bytes=128),
    ("usage", "output_tokens"): ScalarField("int", max_bytes=128),
    ("usage", "input_tokens_details", "cached_tokens"): ScalarField("int", max_bytes=128),
    ("usage", "input_tokens_details", "cache_write_tokens"): ScalarField("int", max_bytes=128),
}
_RESPONSES_WEBSOCKET_SSE_RESPONSE_SCALAR_FIELDS = {
    **_RESPONSES_WEBSOCKET_RESPONSE_SCALAR_FIELDS,
    **{
        ("response", *path): field
        for path, field in _RESPONSES_WEBSOCKET_RESPONSE_SCALAR_FIELDS.items()
    },
}
_RESPONSES_WEBSOCKET_SSE_SCALAR_FIELDS = {
    ("type",): ScalarField("string", max_bytes=1024, overflow_policy="discard"),
    **_RESPONSES_WEBSOCKET_SSE_RESPONSE_SCALAR_FIELDS,
}
_RESPONSES_WEBSOCKET_USAGE_QUANTITY_PATHS = tuple(
    path
    for path, field in _RESPONSES_WEBSOCKET_SSE_RESPONSE_SCALAR_FIELDS.items()
    if field.kind == "int"
)
_RESPONSES_CLIENT_SCALAR_FIELDS = {
    ("type",): ScalarField("string", max_bytes=1024, overflow_policy="discard"),
    ("generate",): ScalarField("bool"),
}
_RESPONSES_LIFECYCLE_SCALAR_FIELDS = {
    ("type",): ScalarField("string", max_bytes=1024, overflow_policy="discard"),
    ("response", "id"): ScalarField("string", max_bytes=1024),
}
_RESPONSES_FAILURE_CODE_PATHS = (
    ("error", "metadata", "error_type"),
    ("error", "error_type"),
    ("response", "error_type"),
    ("response", "error", "error_type"),
    ("error_type",),
    ("response", "error", "code"),
    ("error", "code"),
    ("response", "error", "type"),
    ("error", "type"),
)
_RESPONSES_FAILURE_SCALAR_FIELDS = {
    **_RESPONSES_LIFECYCLE_SCALAR_FIELDS,
    ("code",): ScalarField("string", max_bytes=128, overflow_policy="discard"),
    **{
        path: ScalarField("string", max_bytes=128, overflow_policy="discard")
        for path in _RESPONSES_FAILURE_CODE_PATHS
    },
}
_UNAVAILABLE_FAILURE_EVIDENCE = OpenAIResponsesServerFailureEvidence(None, None, ())


def inspect_openai_responses_client_event_json(body: bytes) -> OpenAIResponsesClientEvent:
    """Inspect client event timing and exact non-generating request intent."""
    observed_event_type = _inspect_openai_responses_event_type_json(body)
    extractor = JsonSelectiveExtractor(
        scalar_fields=_RESPONSES_CLIENT_SCALAR_FIELDS,
        scalar_consistency_paths={("type",), ("generate",)},
        max_work_units=_RESPONSES_MAX_WORK_UNITS,
    )
    extractor.feed(body)
    result = extractor.finish()
    if not result.complete:
        return OpenAIResponsesClientEvent(
            observed_event_type,
            False,
            "unknown",
            result.error == JSON_WORK_LIMIT_EXCEEDED,
        )

    type_is_consistent = extractor.selected_scalar_values_are_consistent(("type",))
    generate_is_consistent = extractor.selected_scalar_values_are_consistent(("generate",))
    event_type = result.values.get(("type",))
    if not type_is_consistent or not isinstance(event_type, str):
        return OpenAIResponsesClientEvent(observed_event_type, False, "unknown")
    if event_type != openai_responses_events.CLIENT_CREATE_EVENT:
        return OpenAIResponsesClientEvent(observed_event_type, False, "unknown")
    if not generate_is_consistent:
        return OpenAIResponsesClientEvent(observed_event_type, False, "unknown")

    return OpenAIResponsesClientEvent(
        observed_event_type,
        result.values.get(("generate",)) is False,
        "create",
    )


def inspect_openai_responses_event_json(body: bytes) -> OpenAIResponsesEvent:
    """Retain one complete Responses event and probe its prefix for ``type``.

    The returned ``event_type`` is only the bounded-prefix observation; this
    function does not fully parse or validate the frame. Pass the returned event
    to ``inspect_openai_responses_server_event`` for shared failure, lifecycle,
    and usage inspection, or to ``extract_openai_responses_usage_from_event``
    when only usage is needed.
    """
    result = _probe_responses_event_type(body)
    return OpenAIResponsesEvent(
        event_type=_observed_responses_event_type(result),
        _body=body,
        _classification=_classify_responses_event_type_result(result),
    )


def _inspect_openai_responses_event_type_json(body: bytes) -> str | None:
    """Probe one Responses frame for its top-level ``type`` without retaining it."""
    return _observed_responses_event_type(_probe_responses_event_type(body))


def _lifecycle_from_extraction(
    event: OpenAIResponsesEvent,
    extractor: JsonSelectiveExtractor,
    result: JsonExtractionResult,
) -> OpenAIResponsesServerLifecycle:
    if not result.complete:
        return OpenAIResponsesServerLifecycle(
            event.event_type,
            None,
            False,
            result.error == JSON_WORK_LIMIT_EXCEEDED,
        )
    if not extractor.selected_scalar_values_are_consistent(("type",)):
        return OpenAIResponsesServerLifecycle(event.event_type, None, False)
    event_type = result.values.get(("type",))
    if not isinstance(event_type, str):
        return OpenAIResponsesServerLifecycle(event.event_type, None, False)
    if event_type == openai_responses_events.SERVER_ERROR_EVENT:
        return OpenAIResponsesServerLifecycle(event_type, None, True)
    if event_type not in openai_responses_events.SERVER_LIFECYCLE_EVENTS:
        return OpenAIResponsesServerLifecycle(event_type, None, True)
    response_id = result.values.get(("response", "id"))
    if (
        not extractor.selected_scalar_values_are_consistent(("response", "id"))
        or not isinstance(response_id, str)
        or not response_id
    ):
        return OpenAIResponsesServerLifecycle(event_type, None, False)
    return OpenAIResponsesServerLifecycle(event_type, response_id, True)


def _usage_from_extraction(
    result: JsonExtractionResult,
    data_event_type: _ResponsesEventTypeClassification | None,
) -> tuple[dict | None, str | None]:
    if not result.complete:
        error = (
            OPENAI_RESPONSES_WEBSOCKET_WORK_LIMIT_ERROR
            if result.error == JSON_WORK_LIMIT_EXCEEDED
            else None
        )
        if result.error == JSON_INTEGER_VALUE_LIMIT_EXCEEDED:
            error = result.error
        return None, error

    if any(
        isinstance(value := result.values.get(path), int)
        and not isinstance(value, bool)
        and value > MAX_USAGE_QUANTITY
        for path in _RESPONSES_WEBSOCKET_USAGE_QUANTITY_PATHS
    ):
        return None, JSON_INTEGER_VALUE_LIMIT_EXCEEDED

    extracted_usage: dict = {}
    _store_sse_result_values(
        result.values,
        extracted_usage,
        event_name=None,
        data_event_type=data_event_type,
    )
    if not any(category in extracted_usage for category in MODEL_USAGE_CATEGORIES):
        return None, None
    return extracted_usage, None


def _failure_from_extraction(
    result: JsonExtractionResult,
) -> OpenAIResponsesServerFailureEvidence:
    if not result.complete:
        return OpenAIResponsesServerFailureEvidence(None, None, (), False)

    event_type_value = result.values.get(("type",))
    event_type = event_type_value if isinstance(event_type_value, str) else None
    response_id_value = result.values.get(("response", "id"))
    response_id = response_id_value if isinstance(response_id_value, str) else None
    failure_codes = tuple(
        value
        for path in _RESPONSES_FAILURE_CODE_PATHS
        if isinstance((value := result.values.get(path)), str)
    )
    top_level_code = result.values.get(("code",))
    if event_type == openai_responses_events.SERVER_ERROR_EVENT and isinstance(top_level_code, str):
        failure_codes = (*failure_codes, top_level_code)
    return OpenAIResponsesServerFailureEvidence(
        event_type,
        response_id,
        failure_codes,
        True,
    )


def _failure_from_prefix(event: OpenAIResponsesEvent) -> OpenAIResponsesServerFailureEvidence:
    return OpenAIResponsesServerFailureEvidence(event.event_type, None, (), True)


def inspect_openai_responses_server_event(
    event: OpenAIResponsesEvent,
    *,
    include_lifecycle: bool,
    include_usage: bool = True,
    include_failure: bool = False,
) -> OpenAIResponsesServerEventInspection:
    """Inspect one server frame with at most one bounded full-body parse."""
    lifecycle: OpenAIResponsesServerLifecycle | None = None
    needs_lifecycle_parse = include_lifecycle
    if (
        include_lifecycle
        and event.event_type is not None
        and event.event_type not in openai_responses_events.SERVER_LIFECYCLE_EVENTS
    ):
        lifecycle = OpenAIResponsesServerLifecycle(event.event_type, None, True)
        needs_lifecycle_parse = False

    needs_usage_parse = include_usage and event._classification != _RESPONSES_EVENT_KNOWN_NON_USAGE
    needs_failure_parse = include_failure and (
        event._classification != _RESPONSES_EVENT_KNOWN_NON_USAGE
        or event.event_type in openai_responses_events.SERVER_LIFECYCLE_EVENTS
    )
    if not needs_lifecycle_parse and not needs_usage_parse and not needs_failure_parse:
        failure = _failure_from_prefix(event) if include_failure else _UNAVAILABLE_FAILURE_EVIDENCE
        return OpenAIResponsesServerEventInspection(lifecycle, None, None, failure)

    data_event_type = _resolved_data_event_type(event._classification)
    scalar_fields: dict[JsonPath, ScalarField] = {}
    if needs_usage_parse:
        scalar_fields.update(
            _RESPONSES_WEBSOCKET_SSE_SCALAR_FIELDS
            if data_event_type is None or needs_lifecycle_parse
            else _RESPONSES_WEBSOCKET_SSE_RESPONSE_SCALAR_FIELDS
        )
    if needs_lifecycle_parse:
        scalar_fields.update(_RESPONSES_LIFECYCLE_SCALAR_FIELDS)
    if needs_failure_parse:
        scalar_fields.update(_RESPONSES_FAILURE_SCALAR_FIELDS)

    consistency_paths = {("type",), ("response", "id")} if needs_lifecycle_parse else None
    extractor = JsonSelectiveExtractor(
        scalar_fields=scalar_fields,
        scalar_consistency_paths=consistency_paths,
        max_work_units=_RESPONSES_MAX_WORK_UNITS,
    )
    extractor.feed(event._body)
    result = extractor.finish()

    if needs_lifecycle_parse:
        lifecycle = _lifecycle_from_extraction(event, extractor, result)
    usage_result, usage_error = (
        _usage_from_extraction(result, data_event_type) if needs_usage_parse else (None, None)
    )
    failure = (
        _failure_from_extraction(result) if needs_failure_parse else _UNAVAILABLE_FAILURE_EVIDENCE
    )
    return OpenAIResponsesServerEventInspection(lifecycle, usage_result, usage_error, failure)


def _probe_responses_event_type(body: bytes) -> TopLevelStringFieldProbeResult:
    return probe_top_level_string_field(
        body[:_RESPONSES_EVENT_PREFILTER_MAX_BYTES],
        "type",
        max_depth=_JSON_PREFILTER_MAX_DEPTH,
        max_string_bytes=_JSON_PREFILTER_MAX_STRING_BYTES,
    )


def _observed_responses_event_type(result: TopLevelStringFieldProbeResult) -> str | None:
    return result.value if result.status == "found" and result.value is not None else None


def _classify_responses_event_type_result(
    result: TopLevelStringFieldProbeResult,
) -> _ResponsesEventTypeClassification:
    if result.status == "incomplete":
        return _RESPONSES_EVENT_PENDING
    if result.status != "found" or result.value is None:
        if result.field_seen:
            return _RESPONSES_EVENT_UNKNOWN
        return _RESPONSES_EVENT_UNRESOLVED
    return _classify_responses_event_name(result.value)


def _classify_responses_event_name(event_name: str) -> _ResponsesEventTypeClassification:
    if event_name in openai_responses_events.TERMINAL_EVENTS:
        return _RESPONSES_EVENT_TERMINAL
    if event_name in openai_responses_events.KNOWN_NON_USAGE_EVENTS:
        return _RESPONSES_EVENT_KNOWN_NON_USAGE
    return _RESPONSES_EVENT_UNKNOWN


def _resolved_data_event_type(
    event_type: _ResponsesEventTypeClassification,
) -> _ResponsesEventTypeClassification | None:
    if event_type in (_RESPONSES_EVENT_PENDING, _RESPONSES_EVENT_UNRESOLVED):
        return None
    return event_type


def _is_known_terminal_usage_event(value: object) -> bool:
    return isinstance(value, str) and value in openai_responses_events.TERMINAL_EVENTS


def _is_known_non_usage_event(value: object) -> bool:
    return isinstance(value, str) and value in openai_responses_events.KNOWN_NON_USAGE_EVENTS


def _has_positive_usage_quantity(values: dict) -> bool:
    for category in MODEL_USAGE_CATEGORIES:
        value = values.get(category)
        if _is_usage_quantity(value) and value > 0:
            return True
    return False


def _has_usage_quantity(values: dict) -> bool:
    return any(_is_usage_quantity(values.get(category)) for category in MODEL_USAGE_CATEGORIES)


def _normalized_input_snapshot(values: dict) -> tuple[int, int | None, int | None] | None:
    ordinary_input_tokens = values.get(MODEL_USAGE_CATEGORY_INPUT)
    if not _is_usage_quantity(ordinary_input_tokens):
        return None

    cached_tokens = values.get(MODEL_USAGE_CATEGORY_CACHE_READ)
    if not _is_usage_quantity(cached_tokens):
        cached_tokens = None

    cache_write_tokens = values.get(MODEL_USAGE_CATEGORY_CACHE_CREATION)
    if not _is_usage_quantity(cache_write_tokens):
        cache_write_tokens = None

    input_tokens = ordinary_input_tokens
    if cached_tokens is not None:
        input_tokens += cached_tokens
    if cache_write_tokens is not None:
        input_tokens += cache_write_tokens
    return input_tokens, cached_tokens, cache_write_tokens


def _merge_input_partition(target: dict, source: dict) -> None:
    source_snapshot = _normalized_input_snapshot(source)
    if source_snapshot is None:
        return

    merged_raw: dict = {}
    for snapshot in (_normalized_input_snapshot(target), source_snapshot):
        if snapshot is None:
            continue
        input_tokens, cached_tokens, cache_write_tokens = snapshot
        update_model_usage_quantity(merged_raw, MODEL_USAGE_CATEGORY_INPUT, input_tokens)
        update_model_usage_quantity(merged_raw, MODEL_USAGE_CATEGORY_CACHE_READ, cached_tokens)
        update_model_usage_quantity(
            merged_raw,
            MODEL_USAGE_CATEGORY_CACHE_CREATION,
            cache_write_tokens,
        )

    ordinary_input_tokens, cached_tokens, cache_write_tokens = _partition_input_tokens(
        merged_raw.get(MODEL_USAGE_CATEGORY_INPUT),
        merged_raw.get(MODEL_USAGE_CATEGORY_CACHE_READ),
        merged_raw.get(MODEL_USAGE_CATEGORY_CACHE_CREATION),
    )
    if ordinary_input_tokens is None:
        return

    target[MODEL_USAGE_CATEGORY_INPUT] = ordinary_input_tokens
    for category, value in (
        (MODEL_USAGE_CATEGORY_CACHE_READ, cached_tokens),
        (MODEL_USAGE_CATEGORY_CACHE_CREATION, cache_write_tokens),
    ):
        if value is None:
            target.pop(category, None)
        else:
            target[category] = value


def _store_response_values(values: dict, target: dict, prefix: tuple[str, ...] = ()) -> None:
    if input_partition_overlaps(
        values.get((*prefix, "usage", "input_tokens")),
        values.get((*prefix, "usage", "input_tokens_details", "cached_tokens")),
        values.get((*prefix, "usage", "input_tokens_details", "cache_write_tokens")),
    ):
        target["input_partition_incomplete"] = True
    model = values.get((*prefix, "model"))
    if isinstance(model, str) and model:
        target["model"] = model

    message_id = values.get((*prefix, "id"))
    if isinstance(message_id, str) and message_id:
        target["message_id"] = message_id

    service_tier = values.get((*prefix, "service_tier"))
    if isinstance(service_tier, str) and service_tier:
        target["service_tier"] = service_tier

    uncached_input_tokens, cached_tokens, cache_creation_tokens = _partition_input_tokens(
        values.get((*prefix, "usage", "input_tokens")),
        values.get((*prefix, "usage", "input_tokens_details", "cached_tokens")),
        values.get((*prefix, "usage", "input_tokens_details", "cache_write_tokens")),
    )
    update_model_usage_quantity(
        target,
        MODEL_USAGE_CATEGORY_INPUT,
        uncached_input_tokens,
    )
    update_model_usage_quantity(
        target,
        MODEL_USAGE_CATEGORY_OUTPUT,
        values.get((*prefix, "usage", "output_tokens")),
    )

    update_model_usage_quantity(
        target,
        MODEL_USAGE_CATEGORY_CACHE_READ,
        cached_tokens,
    )
    update_model_usage_quantity(
        target,
        MODEL_USAGE_CATEGORY_CACHE_CREATION,
        cache_creation_tokens,
    )


def merge_openai_responses_usage_result(target: dict, source: dict) -> None:
    """Fold a Responses usage event into a per-flow usage accumulator.

    ``response_streaming.py`` uses this for terminal SSE events and
    ``model_websocket_usage.py`` uses it for single-frame WebSocket event JSON,
    where multiple events may describe the same upstream response. Output usage
    uses positive-wins semantics directly. Input usage is first reconstructed
    into total input, cache reads, and cache writes; those raw components use
    positive-wins semantics before being repartitioned atomically. This
    preserves the input partition when a later event reports a zero or omits one
    cache detail.

    Metadata follows usage ownership. When the accumulator already has positive
    usage and the source has no positive usage quantity, source metadata is
    ignored so trailing no-usage events cannot relabel the billed model or
    ``message_id``. Otherwise non-empty ``model``, ``message_id``, and
    ``service_tier`` values from the source are copied.
    """

    target_has_positive_quantity = _has_positive_usage_quantity(target)
    if source.get("input_partition_incomplete") is True:
        target["input_partition_incomplete"] = True
    source_has_positive_quantity = _has_positive_usage_quantity(source)
    _merge_input_partition(target, source)
    update_model_usage_quantity(
        target,
        MODEL_USAGE_CATEGORY_OUTPUT,
        source.get(MODEL_USAGE_CATEGORY_OUTPUT),
    )

    if target_has_positive_quantity and not source_has_positive_quantity:
        return

    model = source.get("model")
    if isinstance(model, str) and model:
        target["model"] = model

    message_id = source.get("message_id")
    if isinstance(message_id, str) and message_id:
        target["message_id"] = message_id

    service_tier = source.get("service_tier")
    if isinstance(service_tier, str) and service_tier:
        target["service_tier"] = service_tier


def _has_response_wrapper_values(values: dict) -> bool:
    return any(path[:1] == ("response",) for path in values)


def _store_sse_result_values(
    values: dict,
    target: dict,
    *,
    event_name: str | None,
    data_event_type: _ResponsesEventTypeClassification | None = None,
    data_event_identity_consistent: bool = True,
    on_observation: Callable[[dict, bool], None] | None = None,
) -> dict | None:
    data_type = values.get(("type",))
    if (
        _is_known_non_usage_event(event_name)
        or data_event_type == _RESPONSES_EVENT_KNOWN_NON_USAGE
        or (data_event_type is None and _is_known_non_usage_event(data_type))
    ):
        return None
    event_identity = event_name if event_name is not None else data_type
    is_known_terminal_usage_event = (
        _is_known_terminal_usage_event(event_identity)
        or data_event_type == _RESPONSES_EVENT_TERMINAL
        or (data_event_type is None and _is_known_terminal_usage_event(data_type))
    )

    prefix = ("response",) if _has_response_wrapper_values(values) else ()
    source: dict = {}
    _store_response_values(values, source, prefix)
    if not is_known_terminal_usage_event and not _has_usage_quantity(source):
        return None
    merge_openai_responses_usage_result(target, source)

    terminal = (
        data_event_identity_consistent
        and _is_known_terminal_usage_event(event_identity)
        and data_event_type in (None, _RESPONSES_EVENT_TERMINAL)
        and (event_name is None or data_type is None or data_type == event_name)
    )
    if on_observation is not None:
        on_observation(target, terminal)

    if not _has_positive_usage_quantity(source):
        return None
    if not data_event_identity_consistent:
        return None
    if event_name is None:
        if not _is_known_terminal_usage_event(data_type):
            return None
        if data_event_type not in (None, _RESPONSES_EVENT_TERMINAL):
            return None
        return source
    if not _is_known_terminal_usage_event(event_name):
        return None
    if data_event_type not in (None, _RESPONSES_EVENT_TERMINAL):
        return None
    if data_type is not None and data_type != event_name:
        return None
    return source


def create_openai_responses_sse_usage_extractor(
    on_parse_error: _SseUsageParseErrorCallback | None = None,
    on_terminal_usage: _SseTerminalUsageCallback | None = None,
    *,
    on_observation: Callable[[dict, bool], None] | None = None,
    include_usage: bool = True,
    failure_observer: ModelHttpFailureObserver | None = None,
) -> tuple[SseUsageScanner, dict]:
    """Create an incremental usage parser for content-decoded Responses SSE bytes.

    Returns ``(scanner, usage)``. Callers feed arbitrary byte chunks that still
    contain SSE framing to the callable *scanner* (or its ``feed()`` method) and
    retain *usage* as a live mutable accumulator. Usage extracted at a complete
    event boundary updates that same dict in place. After the final chunk,
    callers invoke ``scanner.finish()`` to finalize a captured trailing event
    when the stream ends without a blank-line terminator.

    When captured event JSON cannot be parsed or exceeds an extractor bound,
    ``on_parse_error(event_type, error)`` is called only if the final event
    identity is a canonical terminal Responses event. Known non-usage events
    and malformed non-terminal or unknown events remain silent. HTTP content
    decoding and its errors are outside this parser; callers feed decoded output
    and handle decoder completion separately.

    ``on_terminal_usage(usage)`` is called after a complete, recognized terminal
    event with compatible SSE/JSON identity contributes positive usage. The
    callback receives that event's normalized usage snapshot, not the live
    accumulator. This lets transport finalizers retain only terminal-proven
    values without changing forward-compatible extraction from unknown events.

    ``on_observation(usage, terminal)`` observes each extracted snapshot,
    including provider zero, independently of positive-only billing recovery.
    ``terminal`` requires a recognized, consistent terminal event identity.
    """

    usage: dict = {}
    parser = SseUsageScanner(
        _OpenAIResponsesSseUsageHandler(
            usage,
            on_parse_error=on_parse_error,
            on_terminal_usage=on_terminal_usage,
            on_observation=on_observation,
            include_usage=include_usage,
            failure_observer=failure_observer,
        ),
        # Some compatible streams omit SSE event names and carry the terminal
        # response type in the JSON payload.
        capture_data_without_event=True,
    )
    return parser, usage


class _OpenAIResponsesSseUsageHandler:
    def __init__(
        self,
        usage: dict,
        *,
        on_parse_error: _SseUsageParseErrorCallback | None = None,
        on_terminal_usage: _SseTerminalUsageCallback | None = None,
        on_observation: Callable[[dict, bool], None] | None = None,
        include_usage: bool = True,
        failure_observer: ModelHttpFailureObserver | None = None,
    ) -> None:
        self._usage = usage
        self._extractor: JsonSelectiveExtractor | None = None
        self._eventless_prefix: bytearray | None = None
        self._named_event_prefix: bytearray | None = None
        self._named_event_name: str | None = None
        self._data_event_type: _ResponsesEventTypeClassification | None = None
        self._discard_eventless_event = False
        self._discard_named_event = False
        self._on_parse_error = on_parse_error
        self._on_terminal_usage = on_terminal_usage
        self._on_observation = on_observation
        self._include_usage = include_usage
        self._failure_observer = failure_observer

    def should_capture_event(self, event_name: str | None) -> bool:
        return (
            event_name is None
            or (self._include_usage and not _is_known_non_usage_event(event_name))
            or (
                self._failure_observer is not None
                and self._failure_observer.needs_sse_event(event_name)
            )
        )

    def on_event_start(self, event_name: str | None) -> None:
        self._reset_event_state()
        if event_name is None:
            self._eventless_prefix = bytearray()
            return
        self._named_event_name = event_name
        self._named_event_prefix = bytearray()

    def on_data(self, chunk: bytes) -> None:
        if self._discard_eventless_event or self._discard_named_event:
            return
        if self._extractor is not None:
            self._extractor.feed(chunk)
            return
        if self._named_event_prefix is not None:
            self._feed_named_event_data(chunk)
            return
        if self._eventless_prefix is not None:
            self._feed_eventless_data(chunk)

    def on_data_separator(self) -> None:
        self.on_data(b"\n")

    def on_event_end(self, event_name: str | None) -> None:
        if self._eventless_prefix is not None:
            prefix = bytes(self._eventless_prefix)
            self._eventless_prefix = None
            probe = _probe_responses_event_type(prefix)
            event_type = _classify_responses_event_type_result(probe)
            if self._should_capture_event_data(
                event_name=None,
                data_event_type=event_type,
                data_event_name=_observed_responses_event_type(probe),
            ):
                self._start_full_extractor_from_prefix(prefix, event_type)
        if self._named_event_prefix is not None and self._data_event_type is None:
            prefix = bytes(self._named_event_prefix)
            self._named_event_prefix = None
            probe = _probe_responses_event_type(prefix)
            event_type = _classify_responses_event_type_result(probe)
            if self._should_capture_event_data(
                event_name=event_name,
                data_event_type=event_type,
                data_event_name=_observed_responses_event_type(probe),
            ):
                self._start_full_extractor_from_prefix(prefix, event_type)
        extractor = self._extractor
        data_event_type = self._data_event_type
        self._reset_event_state()
        if extractor is None:
            return
        result = extractor.finish()
        if self._failure_observer is not None:
            self._failure_observer.observe(
                failure_evidence_from_result(result, event_name=event_name)
            )
        if not self._include_usage:
            return
        if result.complete:
            terminal_usage = _store_sse_result_values(
                result.values,
                self._usage,
                event_name=event_name,
                data_event_type=data_event_type,
                data_event_identity_consistent=(
                    (self._on_terminal_usage is None and self._on_observation is None)
                    or extractor.selected_scalar_values_are_consistent(("type",))
                ),
                on_observation=self._on_observation,
            )
            if terminal_usage is not None and self._on_terminal_usage is not None:
                self._on_terminal_usage(terminal_usage)
            return
        event_type = event_name
        if event_type is None:
            data_type = extractor.observed_scalar_for_diagnostics(("type",))
            if isinstance(data_type, str):
                event_type = data_type
        if (
            event_type is not None
            and event_type in openai_responses_events.TERMINAL_EVENTS
            and result.error
            and self._on_parse_error is not None
        ):
            self._on_parse_error(event_type, result.error)

    def on_event_discard(self, event_name: str | None) -> None:
        self._reset_event_state()
        if self._failure_observer is not None and self._failure_observer.needs_sse_event(
            event_name
        ):
            self._failure_observer.observe(ModelHttpFailureEvidence(event_name=event_name))

    def _reset_event_state(self) -> None:
        self._extractor = None
        self._eventless_prefix = None
        self._named_event_prefix = None
        self._named_event_name = None
        self._data_event_type = None
        self._discard_eventless_event = False
        self._discard_named_event = False

    def _should_capture_event_data(
        self,
        *,
        event_name: str | None,
        data_event_type: _ResponsesEventTypeClassification,
        data_event_name: str | None,
    ) -> bool:
        # Named frames must retain evidence requested for their SSE identity,
        # even when the payload claims to be an ordinary non-usage event.
        # Only eventless capture uses the payload identity for failure filtering.
        return data_event_type != _RESPONSES_EVENT_KNOWN_NON_USAGE or (
            self._failure_observer is not None
            and self._failure_observer.needs_sse_event(
                event_name if event_name is not None else data_event_name
            )
        )

    def _start_full_extractor(self, *, include_type: bool = True) -> JsonSelectiveExtractor:
        usage_fields = (
            _RESPONSES_SSE_SCALAR_FIELDS if include_type else _RESPONSES_SSE_RESPONSE_SCALAR_FIELDS
        )
        self._extractor = JsonSelectiveExtractor(
            scalar_fields=combined_scalar_fields(
                usage_fields,
                include_usage=self._include_usage,
                include_failure=self._failure_observer is not None,
            ),
            value_presence_paths=combined_value_presence_paths(
                (),
                include_usage=self._include_usage,
                include_failure=self._failure_observer is not None,
            ),
            scalar_consistency_paths=(
                {("type",)}
                if self._include_usage
                and (self._on_terminal_usage is not None or self._on_observation is not None)
                else None
            ),
            max_work_units=_RESPONSES_MAX_WORK_UNITS,
        )
        return self._extractor

    def _should_include_type_scalar(self) -> bool:
        return (
            self._data_event_type is None
            or (self._include_usage and self._on_parse_error is not None)
            or (self._include_usage and self._on_terminal_usage is not None)
            or (self._include_usage and self._on_observation is not None)
            or self._failure_observer is not None
        )

    def _start_full_extractor_from_prefix(
        self,
        prefix: bytes,
        event_type: _ResponsesEventTypeClassification,
    ) -> None:
        self._data_event_type = _resolved_data_event_type(event_type)
        extractor = self._start_full_extractor(include_type=self._should_include_type_scalar())
        extractor.feed(prefix)

    def _feed_eventless_data(self, chunk: bytes) -> None:
        prefix = self._eventless_prefix
        if prefix is None:
            return

        remaining = max(_RESPONSES_EVENT_PREFILTER_MAX_BYTES - len(prefix), 0)
        captured_len = min(len(chunk), remaining)
        if captured_len:
            prefix.extend(chunk[:captured_len])

        if captured_len == len(chunk) and len(prefix) < _RESPONSES_EVENT_PREFILTER_MAX_BYTES:
            return

        prefix_bytes = bytes(prefix)
        self._eventless_prefix = None
        probe = _probe_responses_event_type(prefix_bytes)
        event_type = _classify_responses_event_type_result(probe)
        if not self._should_capture_event_data(
            event_name=None,
            data_event_type=event_type,
            data_event_name=_observed_responses_event_type(probe),
        ):
            self._discard_eventless_event = True
            return

        self._start_full_extractor_from_prefix(prefix_bytes, event_type)
        if self._extractor is not None and captured_len < len(chunk):
            self._extractor.feed(chunk[captured_len:])

    def _feed_named_event_data(self, chunk: bytes) -> None:
        prefix = self._named_event_prefix
        if prefix is None:
            return

        remaining = max(_RESPONSES_EVENT_PREFILTER_MAX_BYTES - len(prefix), 0)
        captured_len = min(len(chunk), remaining)
        if captured_len:
            prefix.extend(chunk[:captured_len])

        if captured_len == len(chunk) and len(prefix) < _RESPONSES_EVENT_PREFILTER_MAX_BYTES:
            return

        prefix_bytes = bytes(prefix)
        self._named_event_prefix = None
        probe = _probe_responses_event_type(prefix_bytes)
        event_type = _classify_responses_event_type_result(probe)
        if not self._should_capture_event_data(
            event_name=self._named_event_name,
            data_event_type=event_type,
            data_event_name=_observed_responses_event_type(probe),
        ):
            self._discard_named_event = True
            return

        self._start_full_extractor_from_prefix(prefix_bytes, event_type)
        if self._extractor is not None and captured_len < len(chunk):
            self._extractor.feed(chunk[captured_len:])


def model_json_scalar_fields() -> dict:
    """Return Responses JSON fields selected for usage inspection."""

    return dict(_RESPONSES_RESPONSE_SCALAR_FIELDS)


def model_json_usage_from_result(
    result: JsonExtractionResult,
) -> tuple[dict | None, str | None]:
    """Map one complete shared JSON extraction into Responses usage."""

    if not result.complete:
        return None, result.error
    usage: dict = {}
    _store_response_values(result.values, usage)
    if not any(category in usage for category in MODEL_USAGE_CATEGORIES):
        return None, None
    return usage, None


def extract_openai_responses_usage_from_event(
    event: OpenAIResponsesEvent,
) -> tuple[dict | None, str | None]:
    """Extract usage and an inspection error from a retained Responses event.

    When prefix inspection leaves the event classification unresolved, this
    function selectively examines the complete retained frame and can resolve a
    top-level ``type`` independently of ``event.event_type``.

    Returns ``(usage, None)`` when usage is extracted. Exhausting the selective
    parser's work budget returns ``(None, "work_limit_exceeded")`` and an
    out-of-range selected usage integer returns the bounded parser error. Known
    non-usage events, other incomplete or malformed frames, and frames without
    extractable usage return ``(None, None)``.
    """
    inspection = inspect_openai_responses_server_event(event, include_lifecycle=False)
    return inspection.usage, inspection.usage_error
