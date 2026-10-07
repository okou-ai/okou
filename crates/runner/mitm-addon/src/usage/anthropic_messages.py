"""Anthropic Messages API usage parsing primitives."""

from collections.abc import Callable

from .json_selective import JsonExtractionResult, JsonSelectiveExtractor, ScalarField
from .model_http import (
    ModelHttpFailureEvidence,
    ModelHttpFailureObserver,
    combined_scalar_fields,
    combined_value_presence_paths,
    failure_evidence_from_result,
)
from .model_tokens import ANTHROPIC_USAGE_FIELD_CATEGORIES, update_model_usage_quantity
from .quantities import MAX_USAGE_QUANTITY
from .sse import SseUsageScanner

_ANTHROPIC_MESSAGES_USAGE_EVENTS = frozenset(("message_start", "message_delta"))
_ANTHROPIC_MESSAGES_ACCOUNTING_EVENTS = frozenset(
    (*_ANTHROPIC_MESSAGES_USAGE_EVENTS, "message_stop")
)
# Bound dense syntax and slow scalar inspection while retaining the selective
# parser's bulk-scan path for ordinary large content strings.
_ANTHROPIC_MESSAGES_MAX_WORK_UNITS = 65_536
_SseUsageParseErrorCallback = Callable[[str, str], None]
AnthropicMessagesAccountingEventCallback = Callable[[str], None]

_MODEL_JSON_SCALAR_FIELDS = {
    ("id",): ScalarField("string", max_bytes=1024),
    ("model",): ScalarField("string", max_bytes=1024),
    **{
        ("usage", field): ScalarField(
            "int",
            max_bytes=64,
            max_int_value=MAX_USAGE_QUANTITY,
        )
        for field in ANTHROPIC_USAGE_FIELD_CATEGORIES
    },
}

_ANTHROPIC_SSE_SCALAR_FIELDS = {
    ("type",): ScalarField("string", max_bytes=1024),
    ("message", "id"): ScalarField("string", max_bytes=1024),
    ("message", "model"): ScalarField("string", max_bytes=1024),
    **{
        ("message", "usage", field): ScalarField(
            "int",
            max_bytes=64,
            max_int_value=MAX_USAGE_QUANTITY,
        )
        for field in ANTHROPIC_USAGE_FIELD_CATEGORIES
    },
    **{
        ("usage", field): ScalarField(
            "int",
            max_bytes=64,
            max_int_value=MAX_USAGE_QUANTITY,
        )
        for field in ANTHROPIC_USAGE_FIELD_CATEGORIES
    },
}


def _store_selected_usage_values(values: dict, target: dict, prefix: tuple[str, ...]) -> None:
    """Store usage quantities using positive-wins, zero-does-not-clobber semantics.

    Some provider update payloads echo fields from earlier events as ``0``.
    Preserve an already-recorded quantity in that case, while still recording
    initial zero values when a category has not appeared yet.
    """
    for raw_field, category in ANTHROPIC_USAGE_FIELD_CATEGORIES.items():
        update_model_usage_quantity(target, category, values.get((*prefix, raw_field)))


def create_anthropic_messages_sse_usage_extractor(
    on_parse_error: _SseUsageParseErrorCallback | None = None,
    on_accounting_event: AnthropicMessagesAccountingEventCallback | None = None,
    *,
    include_usage: bool = True,
    failure_observer: ModelHttpFailureObserver | None = None,
) -> tuple[SseUsageScanner, dict]:
    """Create an incremental SSE parser that extracts usage from Anthropic API streams.

    Anthropic-shaped model providers use the Anthropic Messages API streaming
    format. Usage data appears in two SSE events:

    - ``message_start`` — ``message.usage`` contains input token counts and
      ``message.model`` identifies the model.
    - ``message_delta`` — ``usage`` contains the final ``output_tokens`` count.

    Returns ``(scanner, usage)``. The callable *scanner* is an
    ``SseUsageScanner``; callers pass arbitrary content-decoded byte chunks
    that still contain SSE framing to *scanner* (or its ``feed()`` method) and
    retain *usage* as a live mutable accumulator. Usage extracted at a complete
    event boundary updates that same dict in place. After all decoded bytes
    have been fed, callers must invoke ``scanner.finish()`` to finalize a
    captured trailing event when the stream ends without a blank-line terminator.

    ``include_usage`` controls both usage extraction and delivery of the
    callbacks described below. When it is ``False``, usage parsing is disabled
    and neither ``on_parse_error`` nor ``on_accounting_event`` is called, even
    when provided. ``failure_observer`` is independent of
    this option and continues to receive failure evidence for events it
    requests.

    When a captured event cannot be parsed or exceeds an extractor bound,
    ``on_parse_error(event_type, error)`` receives the resolved event identity
    and parser diagnostic only for ``message_start`` and ``message_delta``.
    Event-less frames can use a completed JSON ``type`` scalar as their
    identity. Malformed frames without a usable usage-event identity and
    malformed non-usage events remain silent.

    ``on_accounting_event(event_type)`` receives only successfully parsed
    ``message_start``, ``message_delta``, and ``message_stop`` event identities.
    Unlike usage extraction, requesting this callback makes ``message_stop`` a
    captured event so callers can distinguish terminal from partial accounting.
    No selected scalar value or response payload crosses this callback boundary.

    HTTP content decoding and decoder errors remain caller-owned; this parser
    receives decoded bytes and owns only SSE framing and selected JSON fields.
    """
    usage: dict = {}
    parser = SseUsageScanner(
        _AnthropicMessagesSseUsageHandler(
            usage,
            on_parse_error=on_parse_error,
            on_accounting_event=on_accounting_event,
            include_usage=include_usage,
            failure_observer=failure_observer,
        ),
        # Anthropic-shaped streams can omit SSE event names and rely on JSON
        # "type" fields to classify message_start/message_delta payloads.
        capture_data_without_event=True,
    )
    return parser, usage


class _AnthropicMessagesSseUsageHandler:
    def __init__(
        self,
        usage: dict,
        *,
        on_parse_error: _SseUsageParseErrorCallback | None = None,
        on_accounting_event: AnthropicMessagesAccountingEventCallback | None = None,
        include_usage: bool = True,
        failure_observer: ModelHttpFailureObserver | None = None,
    ) -> None:
        self._usage = usage
        self._extractor: JsonSelectiveExtractor | None = None
        self._on_parse_error = on_parse_error
        self._on_accounting_event = on_accounting_event
        self._include_usage = include_usage
        self._failure_observer = failure_observer

    def should_capture_event(self, event_name: str | None) -> bool:
        usage_needs_event = self._include_usage and (
            event_name in _ANTHROPIC_MESSAGES_USAGE_EVENTS
            or (event_name == "message_stop" and self._on_accounting_event is not None)
        )
        return usage_needs_event or (
            self._failure_observer is not None
            and self._failure_observer.needs_sse_event(event_name)
        )

    def on_event_start(self, event_name: str | None) -> None:
        self._extractor = JsonSelectiveExtractor(
            scalar_fields=combined_scalar_fields(
                _ANTHROPIC_SSE_SCALAR_FIELDS,
                include_usage=self._include_usage,
                include_failure=self._failure_observer is not None,
            ),
            value_presence_paths=combined_value_presence_paths(
                (),
                include_usage=self._include_usage,
                include_failure=self._failure_observer is not None,
            ),
            max_work_units=_ANTHROPIC_MESSAGES_MAX_WORK_UNITS,
        )

    def on_data(self, chunk: bytes) -> None:
        if self._extractor is not None:
            self._extractor.feed(chunk)

    def on_data_separator(self) -> None:
        self.on_data(b"\n")

    def on_event_end(self, event_name: str | None) -> None:
        extractor = self._extractor
        self._extractor = None
        if extractor is None:
            return

        result = extractor.finish()
        if self._failure_observer is not None:
            self._failure_observer.observe(
                failure_evidence_from_result(result, event_name=event_name)
            )
        if not self._include_usage:
            return
        if not result.complete:
            event_type = event_name
            if event_type is None:
                data_type = extractor.observed_scalar_for_diagnostics(("type",))
                if isinstance(data_type, str):
                    event_type = data_type
            if (
                event_type is not None
                and event_type in _ANTHROPIC_MESSAGES_USAGE_EVENTS
                and result.error
                and self._on_parse_error is not None
            ):
                self._on_parse_error(event_type, result.error)
            return

        data_type = result.values.get(("type",))
        event_type = event_name
        if event_type is None and isinstance(data_type, str):
            event_type = data_type
        if isinstance(data_type, str) and event_name is not None and data_type != event_name:
            return

        if event_type == "message_start":
            model = result.values.get(("message", "model"))
            if isinstance(model, str) and model:
                self._usage["model"] = model
            message_id = result.values.get(("message", "id"))
            if isinstance(message_id, str) and message_id:
                self._usage["message_id"] = message_id
            _store_selected_usage_values(result.values, self._usage, ("message", "usage"))
        elif event_type == "message_delta":
            _store_selected_usage_values(result.values, self._usage, ("usage",))

        if (
            self._on_accounting_event is not None
            and event_type in _ANTHROPIC_MESSAGES_ACCOUNTING_EVENTS
        ):
            self._on_accounting_event(event_type)

    def on_event_discard(self, event_name: str | None) -> None:
        self._extractor = None
        if self._failure_observer is not None and self._failure_observer.needs_sse_event(
            event_name
        ):
            self._failure_observer.observe(ModelHttpFailureEvidence(event_name=event_name))


def model_json_scalar_fields() -> dict:
    """Return Anthropic JSON fields selected for usage inspection."""

    return dict(_MODEL_JSON_SCALAR_FIELDS)


def model_json_usage_from_result(
    result: JsonExtractionResult,
) -> tuple[dict | None, str | None]:
    """Map one complete shared JSON extraction into Anthropic usage."""

    if not result.complete:
        return None, result.error
    usage: dict = {}
    model = result.values.get(("model",))
    if isinstance(model, str) and model:
        usage["model"] = model
    _store_selected_usage_values(result.values, usage, ("usage",))
    if not usage:
        return None, None
    message_id = result.values.get(("id",))
    if isinstance(message_id, str) and message_id:
        usage["message_id"] = message_id
    return usage, None
