"""OpenAI-compatible Chat Completions usage parsing primitives."""

import json
import math
from collections.abc import Callable

from .json_selective import (
    FIRST_ARRAY_ELEMENT,
    JsonExtractionResult,
    JsonSelectiveExtractor,
    Path,
    ScalarField,
    json_nesting_within_limit,
)
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
)
from .openai_tokens import input_partition_overlaps, is_usage_quantity, partition_input_tokens
from .quantities import MAX_USAGE_QUANTITY
from .sse import SseUsageScanner

_CHAT_COMPLETIONS_MAX_WORK_UNITS = 65_536
_CHAT_COMPLETIONS_SSE_FAST_PATH_MAX_BYTES = 1024
_JSON_MAX_NUMBER_BYTES = 128
_DONE_SENTINEL = b"[DONE]"
_DONE_PREFIX_MAX_BYTES = 16
_SseUsageParseErrorCallback = Callable[[str, str], None]

_CHAT_COMPLETIONS_CHUNK_KEYS = frozenset(
    (
        "id",
        "object",
        "created",
        "model",
        "service_tier",
        "system_fingerprint",
        "choices",
    )
)
_CHAT_COMPLETIONS_CHOICE_KEYS = frozenset(
    (
        "index",
        "delta",
        "logprobs",
        "finish_reason",
    )
)
_UTF8_SURROGATE_MIN = 0xD800
_UTF8_SURROGATE_MAX = 0xDFFF

_TOP_LEVEL_USAGE_PATH = ("usage",)
_FIRST_CHOICE_USAGE_PATH = ("choices", FIRST_ARRAY_ELEMENT, "usage")
_USAGE_PATHS = (_TOP_LEVEL_USAGE_PATH, _FIRST_CHOICE_USAGE_PATH)
_CACHED_TOKENS_SUFFIX = ("prompt_tokens_details", "cached_tokens")

_CHAT_COMPLETIONS_SCALAR_FIELDS = {
    ("id",): ScalarField("string", max_bytes=1024),
    ("model",): ScalarField("string", max_bytes=1024),
    ("service_tier",): ScalarField("string", max_bytes=1024),
    **{
        (*prefix, field): ScalarField(
            "int",
            max_bytes=64,
            max_int_value=MAX_USAGE_QUANTITY,
        )
        for prefix in _USAGE_PATHS
        for field in (
            "prompt_tokens",
            "completion_tokens",
            "prompt_cache_hit_tokens",
        )
    },
    **{
        (*prefix, "prompt_tokens_details", field): ScalarField(
            "int",
            max_bytes=64,
            max_int_value=MAX_USAGE_QUANTITY,
        )
        for prefix in _USAGE_PATHS
        for field in ("cached_tokens", "cache_write_tokens")
    },
}
_USAGE_VALUE_PRESENCE_PATHS = {
    *_USAGE_PATHS,
    *{(*prefix, *_CACHED_TOKENS_SUFFIX) for prefix in _USAGE_PATHS},
}


class _JsonObjectPairs(list[tuple[str, object]]):
    """Decoded JSON object that preserves member order and duplicates."""


class _FastPathRejectedError(ValueError):
    """Internal signal that bounded JSON must use the authoritative extractor."""


def _parse_bounded_json_int(value: str) -> int:
    if len(value) > _JSON_MAX_NUMBER_BYTES:
        raise _FastPathRejectedError
    return int(value)


def _parse_bounded_json_float(value: str) -> float:
    if len(value) > _JSON_MAX_NUMBER_BYTES:
        raise _FastPathRejectedError
    parsed = float(value)
    if not math.isfinite(parsed):
        raise _FastPathRejectedError
    return parsed


def _reject_json_constant(value: str) -> object:
    raise _FastPathRejectedError(value)


def _contains_surrogate(value: str) -> bool:
    return any(_UTF8_SURROGATE_MIN <= ord(char) <= _UTF8_SURROGATE_MAX for char in value)


def _json_value_is_unambiguous(value: object) -> bool:
    if isinstance(value, str):
        return not _contains_surrogate(value)
    if isinstance(value, _JsonObjectPairs):
        keys: set[str] = set()
        for key, child in value:
            if key in keys or _contains_surrogate(key) or not _json_value_is_unambiguous(child):
                return False
            keys.add(key)
        return True
    if isinstance(value, list):
        return all(_json_value_is_unambiguous(child) for child in value)
    return value is None or type(value) in (bool, int, float)


def _object_values(value: object) -> dict[str, object] | None:
    if not isinstance(value, _JsonObjectPairs):
        return None
    return dict(value)


def _optional_string_has_type(values: dict[str, object], key: str, *, nullable: bool) -> bool:
    if key not in values:
        return True
    value = values[key]
    return isinstance(value, str) or (nullable and value is None)


def _is_canonical_usage_free_delta(body: bytes) -> bool:
    """Return whether bounded JSON is a strict ordinary Chat Completions chunk."""

    if not body or len(body) > _CHAT_COMPLETIONS_SSE_FAST_PATH_MAX_BYTES:
        return False
    if not json_nesting_within_limit(body):
        return False
    try:
        decoded = json.loads(
            body.decode("utf-8"),
            object_pairs_hook=_JsonObjectPairs,
            parse_int=_parse_bounded_json_int,
            parse_float=_parse_bounded_json_float,
            parse_constant=_reject_json_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, _FastPathRejectedError, RecursionError):
        return False
    if not _json_value_is_unambiguous(decoded):
        return False

    values = _object_values(decoded)
    if values is None or not set(values).issubset(_CHAT_COMPLETIONS_CHUNK_KEYS):
        return False
    if values.get("object") != "chat.completion.chunk":
        return False
    if not _optional_string_has_type(values, "id", nullable=False):
        return False
    if not _optional_string_has_type(values, "model", nullable=False):
        return False
    if not _optional_string_has_type(values, "service_tier", nullable=True):
        return False
    if not _optional_string_has_type(values, "system_fingerprint", nullable=True):
        return False
    if "created" in values and type(values["created"]) is not int:
        return False

    choices = values.get("choices")
    if not isinstance(choices, list) or not choices:
        return False
    for choice in choices:
        choice_values = _object_values(choice)
        if choice_values is None or not set(choice_values).issubset(_CHAT_COMPLETIONS_CHOICE_KEYS):
            return False
        if type(choice_values.get("index")) is not int:
            return False
        if not isinstance(choice_values.get("delta"), _JsonObjectPairs):
            return False
        if not _optional_string_has_type(choice_values, "finish_reason", nullable=True):
            return False
        if "logprobs" in choice_values and not (
            choice_values["logprobs"] is None
            or isinstance(choice_values["logprobs"], _JsonObjectPairs)
        ):
            return False
    return True


def _new_extractor(
    *,
    include_usage: bool = True,
    include_failure: bool = False,
) -> JsonSelectiveExtractor:
    return JsonSelectiveExtractor(
        scalar_fields=combined_scalar_fields(
            _CHAT_COMPLETIONS_SCALAR_FIELDS,
            include_usage=include_usage,
            include_failure=include_failure,
        ),
        object_presence_paths=set(_USAGE_PATHS) if include_usage else set(),
        value_presence_paths=combined_value_presence_paths(
            tuple(_USAGE_VALUE_PRESENCE_PATHS),
            include_usage=include_usage,
            include_failure=include_failure,
        ),
        max_number_bytes=_JSON_MAX_NUMBER_BYTES,
        max_work_units=_CHAT_COMPLETIONS_MAX_WORK_UNITS,
    )


def _selected_usage_path(result: JsonExtractionResult) -> Path | None:
    if _TOP_LEVEL_USAGE_PATH in result.value_present:
        return _TOP_LEVEL_USAGE_PATH
    if _FIRST_CHOICE_USAGE_PATH in result.value_present:
        return _FIRST_CHOICE_USAGE_PATH
    return None


def _store_quantity(target: dict, category: str, value: object) -> None:
    if is_usage_quantity(value):
        target[category] = value


def _usage_snapshot(result: JsonExtractionResult) -> dict | None:
    usage_path = _selected_usage_path(result)
    if usage_path is None:
        return None
    if usage_path not in result.object_present:
        return {}

    cached_tokens_path = (*usage_path, *_CACHED_TOKENS_SUFFIX)
    cached_tokens = (
        result.values.get(cached_tokens_path)
        if cached_tokens_path in result.value_present
        else result.values.get((*usage_path, "prompt_cache_hit_tokens"))
    )
    input_tokens, cache_read_tokens, cache_creation_tokens = partition_input_tokens(
        result.values.get((*usage_path, "prompt_tokens")),
        cached_tokens,
        result.values.get((*usage_path, "prompt_tokens_details", "cache_write_tokens")),
    )

    usage: dict = {}
    if input_partition_overlaps(
        result.values.get((*usage_path, "prompt_tokens")),
        cached_tokens,
        result.values.get((*usage_path, "prompt_tokens_details", "cache_write_tokens")),
    ):
        usage["input_partition_incomplete"] = True
    _store_quantity(usage, MODEL_USAGE_CATEGORY_INPUT, input_tokens)
    _store_quantity(
        usage,
        MODEL_USAGE_CATEGORY_OUTPUT,
        result.values.get((*usage_path, "completion_tokens")),
    )
    _store_quantity(usage, MODEL_USAGE_CATEGORY_CACHE_READ, cache_read_tokens)
    _store_quantity(
        usage,
        MODEL_USAGE_CATEGORY_CACHE_CREATION,
        cache_creation_tokens,
    )

    if not any(category in usage for category in MODEL_USAGE_CATEGORIES):
        return {}

    model = result.values.get(("model",))
    if isinstance(model, str) and model:
        usage["model"] = model
    message_id = result.values.get(("id",))
    if isinstance(message_id, str) and message_id:
        usage["message_id"] = message_id
    service_tier = result.values.get(("service_tier",))
    if isinstance(service_tier, str) and service_tier:
        usage["service_tier"] = service_tier
    return usage


class _OpenAIChatCompletionsSseUsageHandler:
    def __init__(
        self,
        usage: dict,
        *,
        on_parse_error: _SseUsageParseErrorCallback | None = None,
        on_usage: Callable[[dict], None] | None = None,
        on_done: Callable[[], None] | None = None,
        include_usage: bool = True,
        failure_observer: ModelHttpFailureObserver | None = None,
    ) -> None:
        self._usage = usage
        self._on_parse_error = on_parse_error
        self._on_usage = on_usage
        self._on_done = on_done
        self._include_usage = include_usage
        self._failure_observer = failure_observer
        self._extractor = _new_extractor(
            include_usage=include_usage,
            include_failure=failure_observer is not None,
        )
        self._event_data = bytearray()
        self._using_extractor = False

    def should_capture_event(self, event_name: str | None) -> bool:
        """Capture named and eventless compatible frames."""
        return True

    def on_event_start(self, event_name: str | None) -> None:
        self._event_data.clear()
        self._using_extractor = False

    def on_data(self, chunk: bytes) -> None:
        if self._using_extractor:
            self._extractor.feed(chunk)
            return

        remaining = max(
            _CHAT_COMPLETIONS_SSE_FAST_PATH_MAX_BYTES - len(self._event_data),
            0,
        )
        self._event_data.extend(chunk[:remaining])
        if len(chunk) > remaining:
            self._extractor.feed(bytes(self._event_data))
            self._event_data.clear()
            self._using_extractor = True
            self._extractor.feed(chunk[remaining:])

    def on_data_separator(self) -> None:
        self.on_data(b"\n")

    def on_event_end(self, event_name: str | None) -> None:
        if not self._using_extractor:
            event_data = bytes(self._event_data)
            self._event_data.clear()
            if len(event_data) <= _DONE_PREFIX_MAX_BYTES and event_data.strip() == _DONE_SENTINEL:
                if self._include_usage and self._on_done is not None:
                    self._on_done()
                if self._failure_observer is not None:
                    self._failure_observer.observe(
                        ModelHttpFailureEvidence(
                            event_name=event_name,
                            is_done=True,
                            is_valid=True,
                        )
                    )
                return
            if _is_canonical_usage_free_delta(event_data):
                if self._failure_observer is not None:
                    self._failure_observer.observe(
                        ModelHttpFailureEvidence(
                            event_name=event_name,
                            has_choices=True,
                            is_valid=True,
                        )
                    )
                return
            self._extractor.feed(event_data)
        self._using_extractor = False

        result = self._extractor.finish()
        self._extractor.reset()
        if not result.complete:
            if self._failure_observer is not None:
                self._failure_observer.observe(
                    failure_evidence_from_result(result, event_name=event_name)
                )
            if self._include_usage:
                self._usage.clear()
            if (
                self._include_usage
                and result.error is not None
                and self._on_parse_error is not None
            ):
                self._on_parse_error(event_name or "eventless", result.error)
            return

        if self._failure_observer is not None:
            self._failure_observer.observe(
                failure_evidence_from_result(result, event_name=event_name)
            )
        if not self._include_usage:
            return

        snapshot = _usage_snapshot(result)
        if snapshot is None:
            return
        self._usage.clear()
        self._usage.update(snapshot)
        if self._on_usage is not None:
            self._on_usage(snapshot)

    def on_event_discard(self, event_name: str | None) -> None:
        self._extractor.reset()
        self._event_data.clear()
        self._using_extractor = False
        if self._failure_observer is not None:
            self._failure_observer.observe(ModelHttpFailureEvidence(event_name=event_name))
        if self._include_usage:
            self._usage.clear()
            if self._on_parse_error is not None:
                self._on_parse_error(event_name or "eventless", "sse event discarded")


def create_openai_chat_completions_sse_usage_extractor(
    on_parse_error: _SseUsageParseErrorCallback | None = None,
    *,
    on_usage: Callable[[dict], None] | None = None,
    on_done: Callable[[], None] | None = None,
    include_usage: bool = True,
    failure_observer: ModelHttpFailureObserver | None = None,
) -> tuple[SseUsageScanner, dict]:
    """Create an incremental usage parser for Chat Completions SSE bytes.

    Returns ``(scanner, usage)``. Callers feed arbitrary byte chunks that still
    contain SSE framing to the callable *scanner* (or its ``feed()`` method) and
    retain *usage* as a live mutable accumulator. Usage extracted at a complete
    event boundary updates that same dict in place. After the final decoded
    bytes have been fed, callers must invoke ``scanner.finish()`` to finalize a
    captured trailing event when the stream ends without a blank-line terminator.

    ``on_usage`` observes each valid snapshot before later frames can replace
    it. ``on_done`` observes the protocol's end sentinel. Both are disabled
    with usage extraction and do not change billing admission.
    """
    usage: dict = {}
    parser = SseUsageScanner(
        _OpenAIChatCompletionsSseUsageHandler(
            usage,
            on_parse_error=on_parse_error,
            on_usage=on_usage,
            on_done=on_done,
            include_usage=include_usage,
            failure_observer=failure_observer,
        ),
        capture_data_without_event=True,
    )
    return parser, usage


def model_json_scalar_fields() -> dict:
    """Return Chat Completions JSON fields selected for usage inspection."""

    return dict(_CHAT_COMPLETIONS_SCALAR_FIELDS)


def model_json_object_presence_paths() -> set[Path]:
    return set(_USAGE_PATHS)


def model_json_value_presence_paths() -> set[Path]:
    return set(_USAGE_VALUE_PRESENCE_PATHS)


def model_json_usage_from_result(
    result: JsonExtractionResult,
) -> tuple[dict | None, str | None]:
    """Map one complete shared JSON extraction into Chat Completions usage."""

    if not result.complete:
        return None, result.error
    usage = _usage_snapshot(result)
    if usage is None or not any(category in usage for category in MODEL_USAGE_CATEGORIES):
        return None, None
    return usage, None
