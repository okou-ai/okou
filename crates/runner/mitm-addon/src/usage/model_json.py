"""Shared cross-provider model JSON response inspection."""

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Literal, NamedTuple, assert_never

from . import anthropic_messages, openai_chat_completions, openai_responses
from .json_selective import JsonExtractionResult, JsonSelectiveExtractor, ScalarField
from .json_selective import Path as JsonPath
from .model_http import (
    ModelHttpFailureEvidence,
    combined_scalar_fields,
    combined_value_presence_paths,
    failure_evidence_from_result,
)

ModelUsageProtocol = Literal[
    "anthropic_messages",
    "openai_chat_completions",
    "openai_responses",
]

ModelJsonUsageResult = tuple[dict | None, str | None]


class _ModelJsonUsageRegistration(NamedTuple):
    scalar_fields: Callable[[], Mapping[JsonPath, ScalarField]]
    object_presence_paths: Callable[[], set[JsonPath]]
    value_presence_paths: Callable[[], set[JsonPath]]
    usage_from_result: Callable[[JsonExtractionResult], ModelJsonUsageResult]


_ANTHROPIC_MESSAGES_REGISTRATION = _ModelJsonUsageRegistration(
    scalar_fields=anthropic_messages.model_json_scalar_fields,
    object_presence_paths=set,
    value_presence_paths=set,
    usage_from_result=anthropic_messages.model_json_usage_from_result,
)
_OPENAI_CHAT_COMPLETIONS_REGISTRATION = _ModelJsonUsageRegistration(
    scalar_fields=openai_chat_completions.model_json_scalar_fields,
    object_presence_paths=openai_chat_completions.model_json_object_presence_paths,
    value_presence_paths=openai_chat_completions.model_json_value_presence_paths,
    usage_from_result=openai_chat_completions.model_json_usage_from_result,
)
_OPENAI_RESPONSES_REGISTRATION = _ModelJsonUsageRegistration(
    scalar_fields=openai_responses.model_json_scalar_fields,
    object_presence_paths=set,
    value_presence_paths=set,
    usage_from_result=openai_responses.model_json_usage_from_result,
)


@dataclass(frozen=True)
class ModelJsonResponseInspection:
    """Combined usage and failure projections from one model JSON response.

    The projections are produced by the same bounded, response-scoped parser. Their consumers
    are independently enabled: disabling one produces its documented disabled value without
    suppressing the other projection.

    Attributes:
        usage: Protocol-specific normalized usage data, or ``None`` when usage inspection is
            disabled, no usage is present, or usage extraction did not complete. When usage
            extraction does not complete, ``usage_error`` contains the parser diagnostic.
        usage_error: The usage parser diagnostic when extraction did not complete. This is
            ``None`` when usage inspection is disabled, no usage is present in complete JSON, or
            usage was extracted successfully. With usage disabled, ``None`` does not imply that
            failure inspection completed; check ``failure.is_valid`` independently.
        failure: Bounded :class:`ModelHttpFailureEvidence` for the same JSON document. When
            failure inspection is disabled, this is the default, intentionally invalid evidence.
            When it is enabled, callers must check ``failure.is_valid`` before interpreting the
            projection as provider outcome evidence. Failure-sensitive overflow can invalidate
            this projection while leaving ``usage`` available when both consumers are enabled.
    """

    usage: dict | None
    usage_error: str | None
    failure: ModelHttpFailureEvidence


class ModelJsonResponseInspector:
    """Incrementally inspect one content-decoded model JSON response.

    One bounded :class:`JsonSelectiveExtractor` is shared by the active usage and failure
    consumers. It selects the union of their fields and is limited to 65,536 work units. When
    both consumers are enabled, failure-only strings may be discarded at their bound so that
    usage extraction can remain available. Discarding a failure-sensitive string invalidates
    failure evidence; discarding the optional 512-byte ``error.message`` alone does not, provided
    extraction otherwise completes within the failure-sensitive bounds. With failure inspection
    alone, message overflow stops extraction and produces invalid evidence with no failure codes.
    Always check ``failure.is_valid``; ``usage_error`` is ``None`` whenever usage is disabled,
    including after a failure-only parse error.

    Feed chunks from one response with :meth:`feed`, use :meth:`accepts_more_input` to determine
    whether the parser can accept another chunk, and call :meth:`finish` exactly once after all
    input has been supplied.
    """

    def __init__(
        self,
        protocol: ModelUsageProtocol,
        *,
        include_usage: bool,
        include_failure: bool,
    ) -> None:
        self._registration = _model_json_usage_registration(protocol)
        self._include_usage = include_usage
        self._include_failure = include_failure
        self._extractor = JsonSelectiveExtractor(
            scalar_fields=combined_scalar_fields(
                self._registration.scalar_fields(),
                include_usage=include_usage,
                include_failure=include_failure,
            ),
            object_presence_paths=(
                self._registration.object_presence_paths() if include_usage else set()
            ),
            value_presence_paths=combined_value_presence_paths(
                tuple(self._registration.value_presence_paths()),
                include_usage=include_usage,
                include_failure=include_failure,
            ),
            max_work_units=65_536,
        )

    def feed(self, chunk: bytes) -> None:
        """Feed the next content-decoded JSON bytes for this response.

        Call this method repeatedly as response chunks arrive, before :meth:`finish`. If
        :meth:`accepts_more_input` returns ``False``, the bounded parser has recorded a
        permanent parse or configured-bound error and later chunks cannot recover it.
        """
        self._extractor.feed(chunk)

    def accepts_more_input(self) -> bool:
        """Return whether the bounded parser can accept another response chunk.

        A completed root remains eligible for input so trailing JSON data can still be validated.
        A ``False`` result means that a permanent parse or configured-bound error has stopped
        further parsing; it is not a successful inspection result. Call :meth:`finish` after the
        final accepted chunk.
        """
        return self._extractor.accepts_more_input()

    def finish(self) -> ModelJsonResponseInspection:
        """Finalize the response and return the combined inspection.

        Call once after all response chunks have been fed. The returned ``usage`` and
        ``usage_error`` follow the selected protocol's usage contract. If usage inspection is
        disabled, both usage fields are ``None`` even if failure inspection is invalid. If failure
        inspection is disabled, ``failure`` is a default :class:`ModelHttpFailureEvidence` with
        ``is_valid=False``. When failure inspection is enabled, callers must check
        ``failure.is_valid`` before using it; incomplete parsing or failure-sensitive overflow
        produces invalid evidence. With both consumers enabled, failure-only strings can be
        discarded without losing available usage data;
        discarding only the optional ``error.message`` does not itself invalidate failure evidence.
        With failure inspection alone, optional-message overflow instead stops parsing.
        """
        result = self._extractor.finish()
        usage, usage_error = (
            self._registration.usage_from_result(result) if self._include_usage else (None, None)
        )
        failure = (
            failure_evidence_from_result(result)
            if self._include_failure
            else ModelHttpFailureEvidence()
        )
        return ModelJsonResponseInspection(usage, usage_error, failure)


def create_model_json_response_inspector(
    protocol: ModelUsageProtocol,
    *,
    include_usage: bool,
    include_failure: bool,
) -> ModelJsonResponseInspector:
    """Create a shared bounded inspector for one model JSON response.

    Args:
        protocol: Model JSON protocol to inspect: ``"anthropic_messages"``,
            ``"openai_chat_completions"``, or ``"openai_responses"``.
        include_usage: Whether to derive protocol-specific normalized usage and a usage parsing
            diagnostic. When false, the returned inspection uses ``(None, None)`` for these
            fields.
        include_failure: Whether to derive bounded :class:`ModelHttpFailureEvidence`. When
            false, the returned inspection contains the default invalid evidence instance.

    Returns:
        A response-scoped :class:`ModelJsonResponseInspector`. Feed content-decoded JSON chunks
        with ``feed()``, consult ``accepts_more_input()`` before supplying another chunk, and
        call ``finish()`` exactly once after the response is complete. Usage and failure are
        collected by one selective parser, bounded to 65,536 work units. If both consumers are
        enabled, failure-sensitive string overflow can invalidate the failure projection while
        preserving usage extraction. Optional ``error.message`` overflow alone does not invalidate
        otherwise valid evidence in this mode, but stops extraction in failure-only mode. Check
        ``failure.is_valid`` before interpreting it, even when ``usage_error`` is ``None`` because
        usage inspection is disabled.
    """
    return ModelJsonResponseInspector(
        protocol,
        include_usage=include_usage,
        include_failure=include_failure,
    )


def _model_json_usage_registration(
    protocol: ModelUsageProtocol,
) -> _ModelJsonUsageRegistration:
    if protocol == "anthropic_messages":
        return _ANTHROPIC_MESSAGES_REGISTRATION
    if protocol == "openai_chat_completions":
        return _OPENAI_CHAT_COMPLETIONS_REGISTRATION
    if protocol == "openai_responses":
        return _OPENAI_RESPONSES_REGISTRATION
    return assert_never(protocol)
