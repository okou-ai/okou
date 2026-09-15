"""Shared bounded failure evidence for model-provider HTTP body inspection."""

from collections.abc import Mapping
from dataclasses import dataclass, replace
from typing import Protocol

from .json_selective import (
    FIRST_ARRAY_ELEMENT,
    JsonExtractionResult,
    ScalarField,
)
from .json_selective import Path as JsonPath

_MAX_FAILURE_STRING_BYTES = 128
_BALANCE_MESSAGE_PATH = ("error", "message")
_MAX_BALANCE_MESSAGE_BYTES = 512

FAILURE_SCALAR_FIELDS: Mapping[JsonPath, ScalarField] = {
    _BALANCE_MESSAGE_PATH: ScalarField("string", max_bytes=_MAX_BALANCE_MESSAGE_BYTES),
    ("type",): ScalarField("string", max_bytes=_MAX_FAILURE_STRING_BYTES),
    ("code",): ScalarField("string", max_bytes=_MAX_FAILURE_STRING_BYTES),
    ("status",): ScalarField("string", max_bytes=_MAX_FAILURE_STRING_BYTES),
    ("error_type",): ScalarField("string", max_bytes=_MAX_FAILURE_STRING_BYTES),
    ("error", "type"): ScalarField("string", max_bytes=_MAX_FAILURE_STRING_BYTES),
    ("error", "code"): ScalarField("string", max_bytes=_MAX_FAILURE_STRING_BYTES),
    ("error", "error_type"): ScalarField("string", max_bytes=_MAX_FAILURE_STRING_BYTES),
    ("error", "metadata", "error_type"): ScalarField("string", max_bytes=_MAX_FAILURE_STRING_BYTES),
    ("response", "id"): ScalarField("string", max_bytes=_MAX_FAILURE_STRING_BYTES),
    ("response", "status"): ScalarField("string", max_bytes=_MAX_FAILURE_STRING_BYTES),
    ("response", "error_type"): ScalarField("string", max_bytes=_MAX_FAILURE_STRING_BYTES),
    ("response", "error", "type"): ScalarField("string", max_bytes=_MAX_FAILURE_STRING_BYTES),
    ("response", "error", "code"): ScalarField("string", max_bytes=_MAX_FAILURE_STRING_BYTES),
    ("response", "error", "error_type"): ScalarField("string", max_bytes=_MAX_FAILURE_STRING_BYTES),
    ("choices", FIRST_ARRAY_ELEMENT, "error", "metadata", "error_type"): ScalarField(
        "string", max_bytes=_MAX_FAILURE_STRING_BYTES
    ),
}

FAILURE_VALUE_PRESENCE_PATHS = (
    ("error",),
    ("response", "error"),
    ("choices", FIRST_ARRAY_ELEMENT, "error"),
    ("choices",),
)

_FAILURE_CODE_PATHS = (
    ("error", "metadata", "error_type"),
    ("choices", FIRST_ARRAY_ELEMENT, "error", "metadata", "error_type"),
    ("error", "error_type"),
    ("response", "error_type"),
    ("response", "error", "error_type"),
    ("error_type",),
    ("response", "error", "code"),
    ("error", "code"),
    ("response", "error", "type"),
    ("error", "type"),
)


@dataclass(frozen=True)
class ModelHttpFailureEvidence:
    """Immutable failure-classification evidence from one JSON document or SSE event.

    The fields are a bounded projection of the selected JSON values and SSE framing state. An
    evidence instance is invalid by default. For evidence created by
    :func:`failure_evidence_from_result`, ``is_valid`` is true only when extraction completed and
    no failure-sensitive string exceeded the 128-byte bound. Incomplete or overflowed extraction
    preserves the event identity and ``is_done`` marker, but must not be interpreted as a
    successful or failed payload.

    Fields:
        event_name: The optional SSE framing event name. It is independent from ``payload_type``;
            a named SSE event and the JSON ``type`` value must be compared when both are present.
            It is ``None`` for eventless frames and complete JSON documents.
        payload_type: The optional top-level JSON ``type`` string. It describes the payload and is
            not an SSE event name or an HTTP status.
        status: The optional top-level JSON ``status`` string.
        response_status: The optional ``response.status`` JSON string. Neither status field is the
            HTTP response status.
        response_id: The optional ``response.id`` JSON string used to identify a response.
        failure_codes: An ordered tuple of every non-null recognized failure-code string. Values
            are collected in this order: ``error.metadata.error_type``, the first choice's
            ``error.metadata.error_type``, ``error.error_type``, ``response.error_type``,
            ``response.error.error_type``, top-level ``error_type``, ``response.error.code``,
            ``error.code``, ``response.error.type``, and ``error.type``. When ``payload_type`` is
            ``"error"``, the top-level JSON ``code`` is appended after those values. Values are
            not deduplicated. The exact Anthropic insufficient-balance message on an
            ``invalid_request_error`` envelope appends the normalized ``billing`` code.
            This optional message evidence is bounded separately to 512 bytes; its
            absence or overflow does not invalidate an otherwise recognized code.
        has_error: Whether a configured error value is present at ``error``, ``response.error``,
            or the first choice's ``error`` path. This records presence, not truthiness.
        has_choices: Whether the top-level ``choices`` value is present. This records presence,
            including an empty or otherwise non-error value.
        is_done: Whether the caller identified the Chat Completions ``[DONE]`` sentinel. This is
            a caller-provided completion marker and does not assert that a JSON payload parsed.
        is_valid: Whether the evidence is complete and within the failure extraction bounds, or is
            an explicitly valid ``[DONE]`` sentinel. Consumers must treat ``False`` as ambiguous
            evidence rather than infer a provider success or failure.
    """

    event_name: str | None = None
    payload_type: str | None = None
    status: str | None = None
    response_status: str | None = None
    response_id: str | None = None
    failure_codes: tuple[str, ...] = ()
    has_error: bool = False
    has_choices: bool = False
    is_done: bool = False
    is_valid: bool = False


class ModelHttpFailureObserver(Protocol):
    """Parser-free consumer of shared model HTTP failure evidence."""

    def needs_sse_event(self, event_name: str | None) -> bool:
        """Return whether an SSE event must be captured and selectively parsed.

        SSE framing calls this before allocating a full JSON extractor. Returning ``False`` permits
        the caller to discard the event body and skip both selective JSON parsing and an
        ``observe()`` call for that event. Returning ``True`` requires the caller to retain enough
        of the event to produce evidence, including invalid evidence when parsing cannot complete.
        ``event_name`` may be ``None`` for an eventless frame.
        """
        raise NotImplementedError

    def observe(self, evidence: ModelHttpFailureEvidence) -> None:
        """Consume evidence for one captured SSE event.

        Callers use this path once per captured event after its selective extraction attempt. The
        evidence may be valid JSON-derived data, event-name-only data from a discarded or empty
        path, or invalid data when parsing is incomplete or exceeds a failure-sensitive bound. A
        concrete observer decides how to interpret ``event_name`` and ``payload_type`` when both
        identities are present.
        """
        raise NotImplementedError

    def observe_json(self, evidence: ModelHttpFailureEvidence) -> None:
        """Consume evidence projected from one complete non-SSE JSON document.

        This is the complete-document path and is distinct from ``observe()``, which represents
        one SSE event. Callers invoke it after the bounded JSON extractor finishes; the evidence
        therefore has no SSE framing identity unless a concrete caller supplies one separately.
        """
        raise NotImplementedError

    def finish(self) -> object:
        """Return the observer's reduced result for response finalization.

        The returned object is implementation-defined. The method may be called again by another
        finalization hook after parser input has been finished; for unchanged observer state,
        repeated calls must be safe and return the same current reduction without reprocessing
        input or performing one-shot finalization. Flow settlement is a separate responsibility of
        the concrete observer or its caller and is not implied by this parser-free protocol.
        """
        raise NotImplementedError


def combined_scalar_fields(
    usage_fields: Mapping[JsonPath, ScalarField],
    *,
    include_usage: bool,
    include_failure: bool,
) -> dict[JsonPath, ScalarField]:
    """Return the exact selected-field union for the active consumers."""

    fields = dict(usage_fields) if include_usage else {}
    if include_failure:
        for path, field in FAILURE_SCALAR_FIELDS.items():
            if path not in fields:
                fields[path] = replace(field, overflow_policy="discard") if include_usage else field
    return fields


def combined_value_presence_paths(
    usage_paths: tuple[JsonPath, ...],
    *,
    include_usage: bool,
    include_failure: bool,
) -> set[JsonPath]:
    paths = set(usage_paths) if include_usage else set()
    if include_failure:
        paths.update(FAILURE_VALUE_PRESENCE_PATHS)
    return paths


def failure_evidence_from_result(
    result: JsonExtractionResult,
    *,
    event_name: str | None = None,
    is_done: bool = False,
) -> ModelHttpFailureEvidence:
    """Project one shared extraction result into the strict failure evidence contract."""

    if not result.complete or _failure_fields_overflowed(result):
        return ModelHttpFailureEvidence(event_name=event_name, is_done=is_done)

    payload_type = _string_value(result, ("type",))
    failure_codes = tuple(
        value for path in _FAILURE_CODE_PATHS if (value := _string_value(result, path)) is not None
    )
    top_level_code = _string_value(result, ("code",))
    if payload_type == "error" and top_level_code is not None:
        failure_codes = (*failure_codes, top_level_code)
    balance_message = _string_value(result, _BALANCE_MESSAGE_PATH)
    if (
        payload_type == "error"
        and _string_value(result, ("error", "type")) == "invalid_request_error"
        and _BALANCE_MESSAGE_PATH not in result.discarded_scalar_paths
        and result.selected_string_max_raw_bytes.get(_BALANCE_MESSAGE_PATH, 0)
        <= _MAX_BALANCE_MESSAGE_BYTES
        and balance_message is not None
        and balance_message.startswith(
            "Your credit balance is too low to access the Anthropic API."
        )
    ):
        failure_codes = (*failure_codes, "billing")
    return ModelHttpFailureEvidence(
        event_name=event_name,
        payload_type=payload_type,
        status=_string_value(result, ("status",)),
        response_status=_string_value(result, ("response", "status")),
        response_id=_string_value(result, ("response", "id")),
        failure_codes=failure_codes,
        has_error=any(
            path in result.value_present
            for path in (
                ("error",),
                ("response", "error"),
                ("choices", FIRST_ARRAY_ELEMENT, "error"),
            )
        ),
        has_choices=("choices",) in result.value_present,
        is_done=is_done,
        is_valid=True,
    )


def _failure_fields_overflowed(result: JsonExtractionResult) -> bool:
    code_paths = FAILURE_SCALAR_FIELDS.keys() - {_BALANCE_MESSAGE_PATH}
    if result.discarded_scalar_paths.intersection(code_paths):
        return True
    return any(
        raw_bytes > _MAX_FAILURE_STRING_BYTES
        for path, raw_bytes in result.selected_string_max_raw_bytes.items()
        if path in code_paths
    )


def _string_value(result: JsonExtractionResult, path: JsonPath) -> str | None:
    value = result.values.get(path)
    return value if isinstance(value, str) else None
