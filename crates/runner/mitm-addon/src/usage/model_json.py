"""Shared cross-provider model JSON response usage inspection."""

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Literal, NamedTuple, assert_never

from . import anthropic_messages, openai_chat_completions, openai_responses
from .json_selective import JsonExtractionResult, JsonSelectiveExtractor, ScalarField
from .json_selective import Path as JsonPath

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
    """Usage projection from one model JSON response.

    Attributes:
        usage: Protocol-specific normalized usage data, or ``None`` when no usage is present or
            usage extraction did not complete. When usage extraction does not complete,
            ``usage_error`` contains the parser diagnostic.
        usage_error: The usage parser diagnostic when extraction did not complete. This is
            ``None`` when no usage is present in complete JSON or usage was extracted
            successfully.
    """

    usage: dict | None
    usage_error: str | None


class ModelJsonResponseInspector:
    """Incrementally inspect one content-decoded model JSON response for usage.

    One bounded :class:`JsonSelectiveExtractor` selects the protocol's usage fields and is
    limited to 65,536 work units.

    Feed chunks from one response with :meth:`feed`, use :meth:`accepts_more_input` to determine
    whether the parser can accept another chunk, and call :meth:`finish` exactly once after all
    input has been supplied.
    """

    def __init__(self, protocol: ModelUsageProtocol) -> None:
        self._registration = _model_json_usage_registration(protocol)
        self._extractor = JsonSelectiveExtractor(
            scalar_fields=dict(self._registration.scalar_fields()),
            object_presence_paths=self._registration.object_presence_paths(),
            value_presence_paths=self._registration.value_presence_paths(),
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
        """Finalize the response and return the usage inspection.

        Call once after all response chunks have been fed. The returned ``usage`` and
        ``usage_error`` follow the selected protocol's usage contract.
        """
        usage, usage_error = self._registration.usage_from_result(self._extractor.finish())
        return ModelJsonResponseInspection(usage, usage_error)


def create_model_json_response_inspector(
    protocol: ModelUsageProtocol,
) -> ModelJsonResponseInspector:
    """Create a bounded usage inspector for one model JSON response.

    Args:
        protocol: Model JSON protocol to inspect: ``"anthropic_messages"``,
            ``"openai_chat_completions"``, or ``"openai_responses"``.

    Returns:
        A response-scoped :class:`ModelJsonResponseInspector`. Feed content-decoded JSON chunks
        with ``feed()``, consult ``accepts_more_input()`` before supplying another chunk, and
        call ``finish()`` exactly once after the response is complete. Usage is collected by one
        selective parser, bounded to 65,536 work units.
    """
    return ModelJsonResponseInspector(protocol)


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
