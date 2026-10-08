"""Bounded selective JSON extraction.

The scanner keeps only selected scalars and object keys needed to resolve
selected paths, while skipping unselected values by JSON syntax. Callers create
one extractor per JSON document, call :meth:`JsonSelectiveExtractor.feed` with
byte chunks, and call :meth:`JsonSelectiveExtractor.finish` once to finalize the
result.

Paths are tuples of object keys. For example, ``("usage", "input_tokens")``
matches ``{"usage": {"input_tokens": 1}}``. ``FIRST_ARRAY_ELEMENT`` selects
only index zero of an array. Wildcards are supported only by
``wildcard_array_count_paths`` and each wildcard pattern must contain exactly
one ``"*"`` segment. For example, ``("includes", "*")`` records the array
lengths for keys such as ``includes.users`` and ``includes.tweets``.
"""

import json
import json.decoder
import re
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from enum import Enum, auto
from typing import Literal, TypeVar, cast


class _PathMarker(Enum):
    UNKNOWN_KEY = auto()
    FIRST_ARRAY_ELEMENT = auto()
    OTHER_ARRAY_ELEMENT = auto()


FIRST_ARRAY_ELEMENT = _PathMarker.FIRST_ARRAY_ELEMENT
PathSegment = str | _PathMarker
Path = tuple[PathSegment, ...]
WildcardPath = tuple[str, ...]
_ScalarPath = TypeVar("_ScalarPath", bound=Path)
ScalarKind = Literal["string", "int", "bool"]
ScalarOverflowPolicy = Literal["error", "discard"]
_JsonStringScanner = Callable[[str, int, bool], tuple[str, int]]
# `scanstring` is the stdlib JSON string scanner, but typeshed does not expose it.
_SCAN_JSON_STRING = cast(_JsonStringScanner, vars(json.decoder)["scanstring"])
_UNKNOWN_KEY = _PathMarker.UNKNOWN_KEY
_OTHER_ARRAY_ELEMENT = _PathMarker.OTHER_ARRAY_ELEMENT
_INTERNAL_PATH_MARKERS = frozenset(
    (
        _UNKNOWN_KEY,
        FIRST_ARRAY_ELEMENT,
        _OTHER_ARRAY_ELEMENT,
        "\0__json_selective_unknown_key__",
        "\0__json_selective_array_element__",
    )
)
_JSON_CONTROL_CHAR_MAX = 0x20
# These are the only bytes that can change discarded string state while
# scanning an ordinary ASCII prefix.
_DISCARDED_STRING_STATE_BYTE_RE = re.compile(rb'[\x00-\x1f"\\\x80-\xff]')
# Possessive repetition validates discarded raw UTF-8 without retaining the
# matched span or backtracking over it.
_DISCARDED_STRING_UTF8_SPAN_RE = re.compile(
    rb"(?:"
    rb"[\x20-\x21\x23-\x5b\x5d-\x7f]"
    rb"|[\xc2-\xdf][\x80-\xbf]"
    rb"|\xe0[\xa0-\xbf][\x80-\xbf]"
    rb"|[\xe1-\xec\xee-\xef][\x80-\xbf]{2}"
    rb"|\xed[\x80-\x9f][\x80-\xbf]"
    rb"|\xf0[\x90-\xbf][\x80-\xbf]{2}"
    rb"|[\xf1-\xf3][\x80-\xbf]{3}"
    rb"|\xf4[\x80-\x8f][\x80-\xbf]{2}"
    rb")*+"
)
_UTF8_ONE_BYTE_MAX = 0x80
_UTF8_CONT_MIN = 0x80
_UTF8_CONT_MAX = 0xBF
_UTF8_TWO_BYTE_MIN = 0xC2
_UTF8_TWO_BYTE_MAX = 0xDF
_UTF8_THREE_BYTE_MIN = 0xE0
_UTF8_THREE_BYTE_MAX = 0xEF
_UTF8_FOUR_BYTE_MIN = 0xF0
_UTF8_FOUR_BYTE_MAX = 0xF4
_UTF8_MIN_TWO_BYTE_CODEPOINT = 0x80
_UTF8_MIN_THREE_BYTE_CODEPOINT = 0x800
_UTF8_MIN_FOUR_BYTE_CODEPOINT = 0x10000
_UTF8_MAX_CODEPOINT = 0x10FFFF
_UTF8_SURROGATE_MIN = 0xD800
_UTF8_SURROGATE_MAX = 0xDFFF
_DEFAULT_MAX_DEPTH = 256
_SLOW_SCALAR_BYTES_PER_WORK_UNIT = 32
_DISCARDED_STRING_BULK_BYTES_PER_WORK_UNIT = 64 * 1024
JSON_WORK_LIMIT_EXCEEDED = "work limit exceeded"
JSON_INTEGER_VALUE_LIMIT_EXCEEDED = "integer value limit exceeded"
_JSON_CONTAINER_OR_QUOTE_RE = re.compile(rb'["{}\[\]]')
_JSON_STRING_ESCAPE_OR_QUOTE_RE = re.compile(rb'["\\]')


def _validate_positive_int(name: str, value: int) -> None:
    if not isinstance(value, int) or isinstance(value, bool):
        raise TypeError(f"{name} must be an integer")
    if value <= 0:
        raise ValueError(f"{name} must be a positive integer")


def json_nesting_within_limit(body: bytes, *, max_depth: int = _DEFAULT_MAX_DEPTH) -> bool:
    """Return whether JSON container nesting stays within ``max_depth``.

    This is a boundedness guard, not a JSON validator. The fast path accepts
    payloads with at most ``max_depth`` opening delimiters. The slow path
    ignores delimiters inside strings before tracking structural object and
    array depth, rejecting unterminated strings. Both paths take linear work
    and constant auxiliary memory. Callers must still parse the body to
    validate it.
    """
    _validate_positive_int("max_depth", max_depth)
    if body.count(b"{") + body.count(b"[") <= max_depth:
        return True

    depth = 0
    position = 0
    while match := _JSON_CONTAINER_OR_QUOTE_RE.search(body, position):
        token = body[match.start()]
        position = match.end()
        if token == ord('"'):
            # Search only unconsumed spans. Single-byte matches avoid retaining
            # a long string's backtracking state or retrying a failed string
            # from each escaped quote.
            while string_match := _JSON_STRING_ESCAPE_OR_QUOTE_RE.search(body, position):
                position = string_match.end()
                if body[string_match.start()] == ord('"'):
                    break
                position += 1  # A backslash consumes the next byte, even a quote.
            else:
                return False
        elif token in (ord("{"), ord("[")):
            depth += 1
            if depth > max_depth:
                return False
        else:
            depth -= 1
    return True


@dataclass(frozen=True)
class ScalarField:
    """Selected scalar field configuration.

    ``kind`` must be ``"string"``, ``"int"``, or ``"bool"``. ``max_bytes``
    limits selected string and integer tokens; ``max_int_value`` optionally
    limits selected integer values; booleans use fixed JSON literals.
    ``overflow_policy`` defaults to ``"error"``, which fails extraction with
    ``"string limit exceeded"`` or ``"number limit exceeded"``. Selected
    strings may use ``"discard"`` to stop retaining an oversized optional
    observation while continuing to validate the document.
    """

    kind: ScalarKind
    max_bytes: int = 4096
    overflow_policy: ScalarOverflowPolicy = "error"
    max_int_value: int | None = None

    def __post_init__(self) -> None:
        if self.kind not in ("string", "int", "bool"):
            raise ValueError("scalar field kind must be 'string', 'int', or 'bool'")
        _validate_positive_int("scalar field max_bytes", self.max_bytes)
        if self.overflow_policy not in ("error", "discard"):
            raise ValueError("scalar field overflow_policy must be 'error' or 'discard'")
        if self.kind != "string" and self.overflow_policy == "discard":
            raise ValueError("scalar field overflow_policy 'discard' requires a string field")
        if self.max_int_value is not None:
            if self.kind != "int":
                raise ValueError("scalar field max_int_value requires an integer field")
            _validate_positive_int("scalar field max_int_value", self.max_int_value)


@dataclass
class JsonExtractionResult:
    """Final extraction result returned by :meth:`JsonSelectiveExtractor.finish`.

    ``complete`` is true only when the JSON document parsed successfully.
    ``values`` contains selected scalar values, ``array_counts`` contains exact
    array path lengths, ``wildcard_array_counts`` contains per-wildcard-key array
    lengths, ``object_present`` contains observed object paths, and
    ``value_present`` contains paths where any JSON value appeared.

    The normal observation containers follow the final occurrence of each object
    member. When a later duplicate replaces an earlier parent or changes its
    value kind, observations rooted at the earlier value are cleared before the
    later value is parsed. This includes descendant scalar values, exact and
    wildcard array counts, object presence, and value presence.

    Configured scalar-consistency tracking is separate from the normal result
    containers and evaluates every occurrence, including overwritten duplicates.

    When ``complete`` is false, all observation containers are empty and
    ``error`` describes the parse or bound failure. This prevents callers from
    consuming partial observations.
    """

    complete: bool
    values: dict[Path, object] = field(default_factory=dict)
    array_counts: dict[Path, int] = field(default_factory=dict)
    wildcard_array_counts: dict[WildcardPath, dict[str, int]] = field(default_factory=dict)
    object_present: set[Path] = field(default_factory=set)
    value_present: set[Path] = field(default_factory=set)
    error: str | None = None


@dataclass
class _Frame:
    kind: Literal["object", "array"]
    path: Path
    state: str
    collect_keys: bool | None = None
    pending_key: PathSegment | None = None
    count_path: Path | None = None
    wildcard_counts: list[tuple[WildcardPath, str]] = field(default_factory=list)


@dataclass
class _StringState:
    role: Literal["key", "selected", "skip"]
    path: Path | None
    max_bytes: int
    raw: bytearray | None
    overflow_policy: ScalarOverflowPolicy = "error"
    escape: bool = False
    has_escape: bool = False
    unicode_remaining: int = 0
    utf8_remaining: int = 0
    utf8_codepoint: int = 0
    utf8_min_codepoint: int = 0


@dataclass
class _NumberState:
    path: Path
    selected: bool
    raw: bytearray | None
    max_bytes: int
    bytes_seen: int = 0
    phase: str = "start"


@dataclass
class _LiteralState:
    literal: bytes
    path: Path
    selected_value: bool | None = None
    offset: int = 0


@dataclass
class _ScalarConsistency:
    occurrences: int = 0
    valid_occurrences: int = 0
    first_value: object | None = None
    conflicting: bool = False


class JsonSelectiveExtractor:
    """Streaming, bounded JSON extractor for a fixed observation set.

    The extractor observes five kinds of data while parsing:

    - ``scalar_fields`` captures selected string, integer, or boolean values.
    - ``array_count_paths`` counts arrays at exact paths.
    - ``wildcard_array_count_paths`` counts arrays at wildcard paths with one
      ``"*"`` segment, recording counts by the concrete wildcard key.
    - ``object_presence_paths`` records exact paths where JSON objects appear.
    - ``value_presence_paths`` records exact paths where any JSON value appears.

    Duplicate object members are parsed in input order. Normal result
    observations follow the final occurrence of each member: a later duplicate
    clears observations rooted at the earlier value before parsing its
    replacement. A parent replacement or value-kind change therefore clears
    earlier descendant scalar, exact array-count, wildcard array-count,
    object-presence, and value-presence observations. Unrelated wildcard
    observations are retained.

    Configured ``scalar_consistency_paths`` tracks every occurrence, including
    values overwritten in the normal result. See
    ``tests/test_json_selective_observations.py`` and
    ``tests/test_json_selective_strings.py`` for focused contract examples.

    Oversized selected scalars fail extraction by default. Selected strings with
    ``overflow_policy="discard"`` instead drop that observation and continue
    validation. Oversized object keys are treated as unknown keys, so selected
    descendants below that key cannot match. Objects that are array elements do
    not match normal object-path observations.
    """

    def __init__(
        self,
        *,
        scalar_fields: Mapping[_ScalarPath, ScalarField] | None = None,
        array_count_paths: Iterable[Path] | None = None,
        wildcard_array_count_paths: Iterable[WildcardPath] | None = None,
        object_presence_paths: Iterable[Path] | None = None,
        value_presence_paths: Iterable[Path] | None = None,
        scalar_consistency_paths: Iterable[Path] | None = None,
        max_depth: int = _DEFAULT_MAX_DEPTH,
        max_key_bytes: int = 1024,
        max_number_bytes: int = 128,
        max_wildcard_keys: int = 256,
        max_work_units: int | None = None,
    ) -> None:
        """Create an extractor for selected JSON observations.

        ``max_depth`` bounds nested objects and arrays and fails with
        ``"max depth exceeded"``. ``max_key_bytes`` bounds object key capture;
        keys above the limit become unknown keys rather than parser errors.
        ``max_number_bytes`` bounds number tokens and fails with
        ``"number limit exceeded"``. ``max_wildcard_keys`` bounds distinct
        wildcard keys and fails with ``"max wildcard keys exceeded"``.
        ``max_work_units`` optionally bounds total parser work across all
        chunks and fails with ``"work limit exceeded"``.
        ``scalar_consistency_paths`` tracks whether every occurrence of a
        selected scalar path has the expected kind and the same value,
        including occurrences later overwritten by a duplicate object member.
        """
        self.scalar_fields: dict[Path, ScalarField] = {}
        if scalar_fields is not None:
            for path, field_config in scalar_fields.items():
                self.scalar_fields[path] = field_config
        self.array_count_paths: set[Path] = (
            set(array_count_paths) if array_count_paths is not None else set()
        )
        self.wildcard_array_count_paths: set[WildcardPath] = (
            set(wildcard_array_count_paths) if wildcard_array_count_paths is not None else set()
        )
        self.object_presence_paths: set[Path] = (
            set(object_presence_paths) if object_presence_paths is not None else set()
        )
        self.value_presence_paths: set[Path] = (
            set(value_presence_paths) if value_presence_paths is not None else set()
        )
        self._scalar_consistency_paths: set[Path] = (
            set(scalar_consistency_paths) if scalar_consistency_paths is not None else set()
        )
        self.max_depth = max_depth
        self.max_key_bytes = max_key_bytes
        self.max_number_bytes = max_number_bytes
        self.max_wildcard_keys = max_wildcard_keys
        self.max_work_units = max_work_units
        _validate_extractor_config(
            self.scalar_fields,
            self.array_count_paths,
            self.wildcard_array_count_paths,
            self.object_presence_paths,
            self.value_presence_paths,
            self._scalar_consistency_paths,
            max_depth=self.max_depth,
            max_key_bytes=self.max_key_bytes,
            max_number_bytes=self.max_number_bytes,
            max_wildcard_keys=self.max_wildcard_keys,
            max_work_units=self.max_work_units,
        )
        key_collection_paths = _build_key_collection_paths(
            set(self.scalar_fields)
            | self.array_count_paths
            | self.wildcard_array_count_paths
            | self.object_presence_paths
            | self.value_presence_paths
        )
        self._exact_key_collection_paths = {
            path for path in key_collection_paths if "*" not in path
        }
        self._wildcard_key_collection_paths = key_collection_paths - (
            self._exact_key_collection_paths
        )
        self._clearable_exact_observation_paths = _build_observation_clear_paths(
            set(self.scalar_fields)
            | self.array_count_paths
            | self.object_presence_paths
            | self.value_presence_paths
        )

        self.values: dict[Path, object] = {}
        self.array_counts: dict[Path, int] = {}
        self.wildcard_array_counts: dict[WildcardPath, dict[str, int]] = {}
        self.object_present: set[Path] = set()
        self.value_present: set[Path] = set()
        self._scalar_consistency: dict[Path, _ScalarConsistency] = {}

        self._stack: list[_Frame] = []
        self._root_done = False
        self._error: str | None = None
        self._string: _StringState | None = None
        self._number: _NumberState | None = None
        self._literal: _LiteralState | None = None
        self._work_units_used = 0
        self._slow_work_bytes_remaining = 0
        self._discarded_string_bulk_work_bytes_remaining = 0

    def reset(self) -> None:
        """Reset document state while retaining the fixed observation configuration."""
        self.values.clear()
        self.array_counts.clear()
        self.wildcard_array_counts.clear()
        self.object_present.clear()
        self.value_present.clear()
        self._scalar_consistency.clear()

        self._stack.clear()
        self._root_done = False
        self._error = None
        self._string = None
        self._number = None
        self._literal = None
        self._work_units_used = 0
        self._slow_work_bytes_remaining = 0
        self._discarded_string_bulk_work_bytes_remaining = 0

    def accepts_more_input(self) -> bool:
        """Return whether later bytes can still affect this document parser.

        A completed root remains active so trailing data is still validated.
        Only a permanent parse or configured-bound error stops input.
        """

        return self._error is None

    def feed(self, chunk: bytes) -> None:
        """Consume the next bytes for this JSON document.

        Feed may be called repeatedly before ``finish()``. If the extractor has
        already recorded an error, later chunks are ignored and cannot recover
        the parser.
        """
        if self._error:
            return
        i = 0
        if self.max_work_units is None:
            while i < len(chunk) and not self._error:
                if self._string is not None:
                    i = self._consume_string(chunk, i)
                elif self._number is not None:
                    i = self._consume_number(chunk, i)
                elif self._literal is not None:
                    i = self._consume_literal(chunk, i)
                else:
                    i = self._consume_main(chunk, i)
            return

        while i < len(chunk) and not self._error:
            if self._string is not None:
                i = self._consume_string(chunk, i)
            elif self._number is not None:
                i = self._consume_number(chunk, i)
            elif self._literal is not None:
                i = self._consume_literal(chunk, i)
            else:
                if not self._consume_work_unit():
                    return
                i = self._consume_main(chunk, i)

    def observed_scalar_for_diagnostics(self, path: Path) -> object | None:
        """Return one completed selected scalar for diagnostics only.

        This may expose a scalar observed before a later parse error. Callers
        must not use it for billing or normal extraction; ``finish().values``
        remains the authoritative complete-document result.
        """
        return self.values.get(path)

    def selected_scalar_values_are_consistent(self, path: Path) -> bool:
        """Return whether every occurrence is a valid, identical selected scalar.

        An absent field is consistent. Callers must use this only after a
        complete extraction result; it intentionally considers every
        occurrence, including overwritten duplicate object keys, so identity
        checks can reject conflicting input.
        """
        if path not in self._scalar_consistency_paths:
            raise ValueError("scalar consistency path was not configured")
        consistency = self._scalar_consistency.get(path)
        if consistency is None:
            return True
        return (
            consistency.valid_occurrences == consistency.occurrences and not consistency.conflicting
        )

    def finish(self) -> JsonExtractionResult:
        """Finalize the current document and return the extraction result.

        Call once after all chunks have been fed. If parsing is incomplete,
        invalid, or a strict configured bound was exceeded, the returned result
        has ``complete=False`` and empty observation containers.
        """
        if not self._error and self._number is not None:
            self._finish_number()

        if not self._error:
            if self._literal is not None:
                self._error = "incomplete literal"
            elif self._string is not None:
                self._error = "incomplete string"
            elif self._stack or not self._root_done:
                self._error = "incomplete json"

        complete = self._error is None and self._root_done and not self._stack
        return JsonExtractionResult(
            complete=complete,
            values=dict(self.values) if complete else {},
            array_counts=dict(self.array_counts) if complete else {},
            wildcard_array_counts={
                pattern: dict(counts) for pattern, counts in self.wildcard_array_counts.items()
            }
            if complete
            else {},
            object_present=set(self.object_present) if complete else set(),
            value_present=set(self.value_present) if complete else set(),
            error=self._error,
        )

    def _consume_main(self, chunk: bytes, i: int) -> int:
        b = chunk[i]
        if b in b" \t\r\n":
            return i + 1

        if self._root_done:
            self._error = "trailing data after root value"
            return i + 1

        if not self._stack:
            return self._start_value((), chunk, i)

        frame = self._stack[-1]
        if frame.kind == "object":
            return self._consume_object(frame, chunk, i)
        return self._consume_array(frame, chunk, i)

    def _consume_object(self, frame: _Frame, chunk: bytes, i: int) -> int:
        b = chunk[i]
        if frame.state in ("key_or_end", "key"):
            if b == ord("}"):
                if frame.state == "key_or_end":
                    return self._end_container(i)
                self._error = "expected object key"
                return i + 1
            if b != ord('"'):
                self._error = (
                    "expected object key or end"
                    if frame.state == "key_or_end"
                    else "expected object key"
                )
                return i + 1
            if frame.collect_keys is None:
                collect_keys = frame.path in self._exact_key_collection_paths
                if not collect_keys and self._wildcard_key_collection_paths:
                    collect_keys = _matches_any_path_pattern(
                        self._wildcard_key_collection_paths, frame.path
                    )
                frame.collect_keys = collect_keys
            self._string = _StringState(
                role="key",
                path=None,
                max_bytes=self.max_key_bytes,
                raw=bytearray() if frame.collect_keys else None,
            )
            return i + 1

        if frame.state == "colon":
            if b != ord(":"):
                self._error = "expected colon"
            else:
                frame.state = "value"
            return i + 1

        if frame.state == "value":
            if frame.pending_key is None:
                self._error = "missing object key"
                return i + 1
            value_path = (*frame.path, frame.pending_key)
            self._clear_observations_for_path(value_path)
            return self._start_value(value_path, chunk, i)

        if frame.state == "comma_or_end":
            if b == ord(","):
                frame.pending_key = None
                frame.state = "key"
            elif b == ord("}"):
                return self._end_container(i)
            else:
                self._error = "expected object comma or end"
            return i + 1

        self._error = "invalid object parser state"
        return i + 1

    def _consume_array(self, frame: _Frame, chunk: bytes, i: int) -> int:
        b = chunk[i]
        if frame.state in ("value_or_end", "value"):
            if b == ord("]"):
                if frame.state == "value_or_end":
                    return self._end_container(i)
                self._error = "expected json value"
                return i + 1
            if not _is_json_value_start(b):
                self._error = "expected json value"
                return i + 1
            is_first_element = frame.state == "value_or_end"
            self._count_array_element(frame)
            element_path = FIRST_ARRAY_ELEMENT if is_first_element else _OTHER_ARRAY_ELEMENT
            return self._start_value((*frame.path, element_path), chunk, i, from_array=True)

        if frame.state == "comma_or_end":
            if b == ord(","):
                frame.state = "value"
            elif b == ord("]"):
                return self._end_container(i)
            else:
                self._error = "expected array comma or end"
            return i + 1

        self._error = "invalid array parser state"
        return i + 1

    def _start_value(self, path: Path, chunk: bytes, i: int, *, from_array: bool = False) -> int:
        if path in self.value_presence_paths:
            self.value_present.add(path)
        if path in self._scalar_consistency_paths:
            consistency = self._scalar_consistency.setdefault(path, _ScalarConsistency())
            consistency.occurrences += 1
        b = chunk[i]
        if b == ord("{"):
            self._start_object(path, from_array=from_array)
            return i + 1
        if b == ord("["):
            self._start_array(path)
            return i + 1
        if b == ord('"'):
            field = self.scalar_fields.get(path)
            if field and field.kind == "string":
                self._string = _StringState(
                    role="selected",
                    path=path,
                    max_bytes=field.max_bytes,
                    raw=bytearray(),
                    overflow_policy=field.overflow_policy,
                )
            else:
                self._string = _StringState(
                    role="skip",
                    path=path,
                    max_bytes=0,
                    raw=None,
                )
            return i + 1
        if b == ord("-") or ord("0") <= b <= ord("9"):
            field = self.scalar_fields.get(path, None)
            selected = bool(field and field.kind == "int")
            self._number = _NumberState(
                path=path,
                selected=selected,
                raw=bytearray() if selected else None,
                max_bytes=min(self.max_number_bytes, field.max_bytes)
                if selected and field
                else self.max_number_bytes,
            )
            return self._consume_number(chunk, i)
        if b == ord("t"):
            field = self.scalar_fields.get(path)
            self._literal = _LiteralState(
                b"true",
                path,
                selected_value=True if field and field.kind == "bool" else None,
            )
            return self._consume_literal(chunk, i)
        if b == ord("f"):
            field = self.scalar_fields.get(path)
            self._literal = _LiteralState(
                b"false",
                path,
                selected_value=False if field and field.kind == "bool" else None,
            )
            return self._consume_literal(chunk, i)
        if b == ord("n"):
            self._literal = _LiteralState(b"null", path)
            return self._consume_literal(chunk, i)
        self._error = "expected json value"
        return i + 1

    def _start_object(self, path: Path, *, from_array: bool = False) -> None:
        if len(self._stack) >= self.max_depth:
            self._error = "max depth exceeded"
            return
        if not from_array and path in self.object_presence_paths:
            self.object_present.add(path)
        self._stack.append(_Frame(kind="object", path=path, state="key_or_end"))

    def _start_array(self, path: Path) -> None:
        if len(self._stack) >= self.max_depth:
            self._error = "max depth exceeded"
            return

        count_path = path if path in self.array_count_paths else None
        if count_path is not None:
            self.array_counts[count_path] = 0
        wildcard_counts = self._wildcard_matches(path)
        if self._error:
            return
        self._stack.append(
            _Frame(
                kind="array",
                path=path,
                state="value_or_end",
                count_path=count_path,
                wildcard_counts=wildcard_counts,
            )
        )

    def _wildcard_matches(self, path: Path) -> list[tuple[WildcardPath, str]]:
        matches = []
        for pattern in self.wildcard_array_count_paths:
            if not _path_matches_pattern(pattern, path):
                continue
            wildcard_index = pattern.index("*")
            key = path[wildcard_index]
            if not isinstance(key, str):
                continue
            counts = self.wildcard_array_counts.setdefault(pattern, {})
            if key not in counts and len(counts) >= self.max_wildcard_keys:
                self._error = "max wildcard keys exceeded"
                return matches
            counts[key] = 0
            matches.append((pattern, key))
        return matches

    def _clear_observations_for_path(self, path: Path) -> None:
        can_clear_exact = path in self._clearable_exact_observation_paths
        can_clear_wildcard = bool(self.wildcard_array_counts) and any(
            _wildcard_observation_can_be_cleared_by_path(pattern, path)
            for pattern in self.wildcard_array_counts
        )
        if not can_clear_exact and not can_clear_wildcard:
            return

        if can_clear_exact:
            for observed_path in _find_paths_with_prefix(self.values, path) or ():
                del self.values[observed_path]
            for observed_path in _find_paths_with_prefix(self.array_counts, path) or ():
                del self.array_counts[observed_path]
            for observed_path in _find_paths_with_prefix(self.object_present, path) or ():
                self.object_present.remove(observed_path)
            for observed_path in _find_paths_with_prefix(self.value_present, path) or ():
                self.value_present.remove(observed_path)

        if can_clear_wildcard:
            for pattern, counts in list(self.wildcard_array_counts.items()):
                if not _wildcard_observation_can_be_cleared_by_path(pattern, path):
                    continue
                self._clear_wildcard_observations_for_path(pattern, counts, path)
                if not counts:
                    self.wildcard_array_counts.pop(pattern, None)

    def _clear_wildcard_observations_for_path(
        self, pattern: WildcardPath, counts: dict[str, int], path: Path
    ) -> None:
        if len(path) > len(pattern):
            return
        try:
            wildcard_index = pattern.index("*")
        except ValueError:
            counts.clear()
            return

        if not _path_prefix_matches_pattern(pattern, path):
            return

        if len(path) <= wildcard_index:
            counts.clear()
            return
        key = path[wildcard_index]
        if isinstance(key, str):
            counts.pop(key, None)

    def _count_array_element(self, frame: _Frame) -> None:
        if frame.count_path is not None:
            self.array_counts[frame.count_path] = self.array_counts.get(frame.count_path, 0) + 1
        for pattern, key in frame.wildcard_counts:
            counts = self.wildcard_array_counts.setdefault(pattern, {})
            counts[key] = counts.get(key, 0) + 1

    def _end_container(self, i: int) -> int:
        if not self._stack:
            self._error = "unexpected container end"
            return i + 1
        self._stack.pop()
        self._value_complete()
        return i + 1

    def _value_complete(self) -> None:
        if not self._stack:
            self._root_done = True
            return
        parent = self._stack[-1]
        if (parent.kind == "object" and parent.state == "value") or (
            parent.kind == "array" and parent.state in ("value_or_end", "value")
        ):
            parent.state = "comma_or_end"
        else:
            self._error = "value completed in invalid parser state"

    def _consume_string(self, chunk: bytes, i: int) -> int:
        state = self._string
        if state is None:
            self._error = "missing string parser state"
            return i
        work_limited = self.max_work_units is not None
        if _can_bulk_skip_discarded_string_byte(state, chunk[i]):
            end = (
                self._discarded_string_bulk_work_span_end(len(chunk), i)
                if work_limited
                else len(chunk)
            )
            if self._error:
                return i
            match = _DISCARDED_STRING_STATE_BYTE_RE.search(chunk, i, end)
            if match is None:
                if work_limited:
                    self._discarded_string_bulk_work_bytes_remaining -= end - i
                return end
            skipped = match.start() - i
            if work_limited:
                self._discarded_string_bulk_work_bytes_remaining -= skipped
            return i + skipped

        if _can_bulk_validate_discarded_utf8(state, chunk[i]):
            end = (
                self._discarded_string_bulk_work_span_end(len(chunk), i)
                if work_limited
                else len(chunk)
            )
            if self._error:
                return i
            match = _DISCARDED_STRING_UTF8_SPAN_RE.match(chunk, i, end)
            match_end = match.end() if match is not None else i
            if match_end > i:
                if work_limited:
                    self._discarded_string_bulk_work_bytes_remaining -= match_end - i
                return match_end

        if _is_discarded_raw_utf8_byte(state, chunk[i]):
            if work_limited:
                self._discarded_string_bulk_work_span_end(len(chunk), i)
                if self._error:
                    return i
            self._accept_string_byte(state, chunk[i])
            if work_limited:
                self._discarded_string_bulk_work_bytes_remaining -= 1
            return i + 1

        end = self._slow_work_span_end(len(chunk), i) if work_limited else len(chunk)
        if self._error:
            return i
        start = i
        try:
            while i < end:
                if _can_bulk_skip_discarded_string_byte(state, chunk[i]):
                    break
                b = chunk[i]
                i += 1

                if state.unicode_remaining:
                    if not _is_hex_byte(b):
                        self._error = "invalid unicode escape"
                        return i
                    self._append_string_byte(state, b)
                    if self._error:
                        return i
                    state.unicode_remaining -= 1
                    continue

                if state.escape:
                    if b not in b'"\\/bfnrtu':
                        self._error = "invalid string escape"
                        return i
                    self._append_string_byte(state, b)
                    if self._error:
                        return i
                    state.escape = False
                    if b == ord("u"):
                        state.unicode_remaining = 4
                    continue

                if b == ord("\\"):
                    self._accept_string_byte(state, b)
                    if self._error:
                        return i
                    state.has_escape = True
                    state.escape = True
                    continue

                if b == ord('"'):
                    self._finish_string(state)
                    self._string = None
                    return i

                if b < _JSON_CONTROL_CHAR_MAX:
                    self._error = "control character in string"
                    return i
                self._accept_string_byte(state, b)
                if self._error:
                    return i
        finally:
            if work_limited:
                self._slow_work_bytes_remaining -= i - start
        return i

    def _accept_string_byte(self, state: _StringState, b: int) -> None:
        self._validate_string_byte(state, b)
        if not self._error:
            self._append_string_byte(state, b)

    def _validate_string_byte(self, state: _StringState, b: int) -> None:
        if state.utf8_remaining:
            if not _is_utf8_continuation(b):
                self._error = "invalid string"
                return
            state.utf8_codepoint = (state.utf8_codepoint << 6) | (b & 0x3F)
            state.utf8_remaining -= 1
            if state.utf8_remaining == 0 and not _is_valid_utf8_codepoint(
                state.utf8_codepoint, state.utf8_min_codepoint
            ):
                self._error = "invalid string"
            return

        if b < _UTF8_ONE_BYTE_MAX:
            return
        if _UTF8_TWO_BYTE_MIN <= b <= _UTF8_TWO_BYTE_MAX:
            state.utf8_remaining = 1
            state.utf8_codepoint = b & 0x1F
            state.utf8_min_codepoint = _UTF8_MIN_TWO_BYTE_CODEPOINT
            return
        if _UTF8_THREE_BYTE_MIN <= b <= _UTF8_THREE_BYTE_MAX:
            state.utf8_remaining = 2
            state.utf8_codepoint = b & 0x0F
            state.utf8_min_codepoint = _UTF8_MIN_THREE_BYTE_CODEPOINT
            return
        if _UTF8_FOUR_BYTE_MIN <= b <= _UTF8_FOUR_BYTE_MAX:
            state.utf8_remaining = 3
            state.utf8_codepoint = b & 0x07
            state.utf8_min_codepoint = _UTF8_MIN_FOUR_BYTE_CODEPOINT
            return
        self._error = "invalid string"

    def _append_string_byte(self, state: _StringState, b: int) -> None:
        if state.raw is None:
            return
        state.raw.append(b)
        if len(state.raw) > state.max_bytes:
            if state.role == "key" or state.overflow_policy == "discard":
                state.raw = None
                return
            self._error = "string limit exceeded"

    def _finish_string(self, state: _StringState) -> None:
        if state.utf8_remaining:
            self._error = "invalid string"
            return
        try:
            value = (
                _UNKNOWN_KEY
                if state.raw is None
                else _decode_json_string(state.raw, has_escape=state.has_escape)
            )
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
            self._error = "invalid string"
            return
        if state.role == "key":
            if _contains_surrogate(value):
                value = _UNKNOWN_KEY
            if not self._stack or self._stack[-1].kind != "object":
                self._error = "object key outside object"
                return
            frame = self._stack[-1]
            frame.pending_key = value
            frame.state = "colon"
            return
        if state.path is None:
            self._error = "missing selected string path"
            return
        if state.raw is None:
            self._value_complete()
            return
        if _contains_surrogate(value):
            self._value_complete()
            return
        self._record_scalar_consistency(state.path, value)
        self.values[state.path] = value
        self._value_complete()

    def _consume_number(self, chunk: bytes, i: int) -> int:
        state = self._number
        if state is None:
            self._error = "missing number parser state"
            return i
        work_limited = self.max_work_units is not None
        end = self._slow_work_span_end(len(chunk), i) if work_limited else len(chunk)
        if self._error:
            return i
        start = i
        while i < end:
            b = chunk[i]
            if b in b" \t\r\n,]}":
                self._finish_number()
                break
            self._accept_number_byte(state, b)
            if self._error:
                i += 1
                break
            i += 1
        if work_limited:
            self._slow_work_bytes_remaining -= i - start
        return i

    def _accept_number_byte(self, state: _NumberState, b: int) -> None:
        phase = state.phase
        if phase == "start":
            if b == ord("-"):
                state.phase = "after_minus"
            elif b == ord("0"):
                state.phase = "zero"
            elif ord("1") <= b <= ord("9"):
                state.phase = "int"
            else:
                self._error = "invalid number"
                return
        elif phase == "after_minus":
            if b == ord("0"):
                state.phase = "zero"
            elif ord("1") <= b <= ord("9"):
                state.phase = "int"
            else:
                self._error = "invalid number"
                return
        elif phase == "zero":
            if b == ord("."):
                state.phase = "dot"
            elif b in b"eE":
                state.phase = "exp"
            else:
                self._error = "invalid number"
                return
        elif phase == "int":
            if ord("0") <= b <= ord("9"):
                pass
            elif b == ord("."):
                state.phase = "dot"
            elif b in b"eE":
                state.phase = "exp"
            else:
                self._error = "invalid number"
                return
        elif phase == "dot":
            if ord("0") <= b <= ord("9"):
                state.phase = "frac"
            else:
                self._error = "invalid number"
                return
        elif phase == "frac":
            if ord("0") <= b <= ord("9"):
                pass
            elif b in b"eE":
                state.phase = "exp"
            else:
                self._error = "invalid number"
                return
        elif phase == "exp":
            if b in b"+-":
                state.phase = "exp_sign"
            elif ord("0") <= b <= ord("9"):
                state.phase = "exp_digits"
            else:
                self._error = "invalid number"
                return
        elif phase == "exp_sign":
            if ord("0") <= b <= ord("9"):
                state.phase = "exp_digits"
            else:
                self._error = "invalid number"
                return
        elif phase == "exp_digits":
            if not ord("0") <= b <= ord("9"):
                self._error = "invalid number"
                return
        else:
            self._error = "invalid number"
            return

        state.bytes_seen += 1
        if state.bytes_seen > state.max_bytes:
            self._error = "number limit exceeded"
            return
        if state.raw is not None:
            state.raw.append(b)

    def _finish_number(self) -> None:
        state = self._number
        if state is None:
            return
        self._number = None
        if state.phase not in ("zero", "int", "frac", "exp_digits"):
            self._error = "invalid number"
            return
        if not state.selected:
            self._value_complete()
            return
        try:
            token = bytes(state.raw or b"").decode("ascii")
            value = json.loads(token)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            self._error = "invalid number"
            return
        if state.selected and isinstance(value, int) and not isinstance(value, bool):
            field = self.scalar_fields[state.path]
            if field.max_int_value is not None and value > field.max_int_value:
                self._error = JSON_INTEGER_VALUE_LIMIT_EXCEEDED
                return
            self._record_scalar_consistency(state.path, value)
            self.values[state.path] = value
        self._value_complete()

    def _record_scalar_consistency(self, path: Path, value: object) -> None:
        consistency = self._scalar_consistency.get(path)
        if consistency is None:
            return
        if consistency.valid_occurrences == 0:
            consistency.first_value = value
        elif consistency.first_value != value:
            consistency.conflicting = True
        consistency.valid_occurrences += 1

    def _consume_literal(self, chunk: bytes, i: int) -> int:
        state = self._literal
        if state is None:
            self._error = "missing literal parser state"
            return i
        work_limited = self.max_work_units is not None
        end = self._slow_work_span_end(len(chunk), i) if work_limited else len(chunk)
        if self._error:
            return i
        start = i
        while i < end and state.offset < len(state.literal):
            if chunk[i] != state.literal[state.offset]:
                self._error = "invalid literal"
                i += 1
                break
            i += 1
            state.offset += 1
        if work_limited:
            self._slow_work_bytes_remaining -= i - start
        if not self._error and state.offset == len(state.literal):
            self._literal = None
            if state.selected_value is not None:
                self._record_scalar_consistency(state.path, state.selected_value)
                self.values[state.path] = state.selected_value
            self._value_complete()
        return i

    def _consume_work_unit(self) -> bool:
        if self.max_work_units is None:
            return True
        if self._work_units_used >= self.max_work_units:
            self._error = JSON_WORK_LIMIT_EXCEEDED
            return False
        self._work_units_used += 1
        return True

    def _slow_work_span_end(self, chunk_len: int, i: int) -> int:
        if self.max_work_units is None:
            return chunk_len
        if self._slow_work_bytes_remaining == 0:
            if not self._consume_work_unit():
                return i
            self._slow_work_bytes_remaining = _SLOW_SCALAR_BYTES_PER_WORK_UNIT
        return min(chunk_len, i + self._slow_work_bytes_remaining)

    def _discarded_string_bulk_work_span_end(self, chunk_len: int, i: int) -> int:
        if self.max_work_units is None:
            return chunk_len
        if self._discarded_string_bulk_work_bytes_remaining == 0:
            if not self._consume_work_unit():
                return i
            self._discarded_string_bulk_work_bytes_remaining = (
                _DISCARDED_STRING_BULK_BYTES_PER_WORK_UNIT
            )
        return min(chunk_len, i + self._discarded_string_bulk_work_bytes_remaining)


def _is_hex_byte(b: int) -> bool:
    return ord("0") <= b <= ord("9") or ord("a") <= b <= ord("f") or ord("A") <= b <= ord("F")


def _decode_json_string(raw: bytearray, *, has_escape: bool) -> str:
    text = raw.decode("utf-8")
    if not has_escape:
        return text

    scan_input = f'{text}"'
    value, end = _SCAN_JSON_STRING(scan_input, 0, True)
    if end != len(scan_input):
        raise ValueError("json string scanner did not consume full token")
    return value


def _is_json_value_start(b: int) -> bool:
    return b in b'{["tfn-' or ord("0") <= b <= ord("9")


def _is_discarded_ascii_string_byte(b: int) -> bool:
    return _JSON_CONTROL_CHAR_MAX <= b < _UTF8_ONE_BYTE_MAX and b not in b'"\\'


def _can_bulk_skip_discarded_string_byte(state: _StringState, b: int) -> bool:
    return (
        state.raw is None
        and not state.escape
        and not state.unicode_remaining
        and not state.utf8_remaining
        and _is_discarded_ascii_string_byte(b)
    )


def _can_bulk_validate_discarded_utf8(state: _StringState, b: int) -> bool:
    return not state.utf8_remaining and _is_discarded_raw_utf8_byte(state, b)


def _is_discarded_raw_utf8_byte(state: _StringState, b: int) -> bool:
    return (
        state.raw is None
        and not state.escape
        and not state.unicode_remaining
        and b >= _UTF8_ONE_BYTE_MAX
    )


def _validate_extractor_config(
    scalar_fields: dict[Path, ScalarField],
    array_count_paths: set[Path],
    wildcard_array_count_paths: set[WildcardPath],
    object_presence_paths: set[Path],
    value_presence_paths: set[Path],
    scalar_consistency_paths: set[Path],
    *,
    max_depth: int,
    max_key_bytes: int,
    max_number_bytes: int,
    max_wildcard_keys: int,
    max_work_units: int | None,
) -> None:
    for name, value in (
        ("max_depth", max_depth),
        ("max_key_bytes", max_key_bytes),
        ("max_number_bytes", max_number_bytes),
        ("max_wildcard_keys", max_wildcard_keys),
    ):
        _validate_positive_int(name, value)
    if max_work_units is not None:
        _validate_positive_int("max_work_units", max_work_units)

    for scalar_field in scalar_fields.values():
        if not isinstance(scalar_field, ScalarField):
            raise TypeError("scalar fields must map to ScalarField")

    _validate_exact_paths("scalar field paths", set(scalar_fields))
    _validate_exact_paths("array count paths", array_count_paths)
    _validate_exact_paths("object presence paths", object_presence_paths)
    _validate_exact_paths("value presence paths", value_presence_paths)
    _validate_exact_paths("scalar consistency paths", scalar_consistency_paths)
    if not scalar_consistency_paths <= set(scalar_fields):
        raise ValueError("scalar consistency paths must reference scalar fields")

    for path in wildcard_array_count_paths:
        _validate_wildcard_path(path)
        if path.count("*") != 1:
            raise ValueError("wildcard array count paths must contain exactly one '*'")


def _validate_exact_paths(name: str, paths: set[Path]) -> None:
    for path in paths:
        _validate_path(name, path)
        if "*" in path:
            raise ValueError(f"{name} must not contain '*'")


def _validate_path(name: str, path: Path) -> None:
    if not isinstance(path, tuple) or any(
        not isinstance(segment, str) and segment is not FIRST_ARRAY_ELEMENT for segment in path
    ):
        raise TypeError(f"{name} must be tuple[str | FIRST_ARRAY_ELEMENT, ...]")


def _validate_wildcard_path(path: WildcardPath) -> None:
    if not isinstance(path, tuple) or any(not isinstance(segment, str) for segment in path):
        raise TypeError("wildcard array count paths must be tuple[str, ...]")


def _is_utf8_continuation(b: int) -> bool:
    return _UTF8_CONT_MIN <= b <= _UTF8_CONT_MAX


def _is_valid_utf8_codepoint(codepoint: int, min_codepoint: int) -> bool:
    return (
        min_codepoint <= codepoint <= _UTF8_MAX_CODEPOINT
        and not _UTF8_SURROGATE_MIN <= codepoint <= _UTF8_SURROGATE_MAX
    )


def _contains_surrogate(value: object) -> bool:
    return isinstance(value, str) and any(
        _UTF8_SURROGATE_MIN <= ord(ch) <= _UTF8_SURROGATE_MAX for ch in value
    )


def _matches_any_path_pattern(patterns: set[Path], path: Path) -> bool:
    return any(_path_matches_pattern(pattern, path) for pattern in patterns)


def _path_matches_pattern(pattern: Path, path: Path) -> bool:
    return len(pattern) == len(path) and _path_prefix_matches_pattern(pattern, path)


def _path_prefix_matches_pattern(pattern: Path, path: Path) -> bool:
    if len(path) > len(pattern):
        return False
    return all(
        (expected == "*" and actual not in _INTERNAL_PATH_MARKERS) or expected == actual
        for expected, actual in zip(pattern, path, strict=False)
    )


def _is_path_prefix(prefix: Path, path: Path) -> bool:
    return len(prefix) <= len(path) and path[: len(prefix)] == prefix


def _build_key_collection_paths(paths: set[Path]) -> set[Path]:
    return {path[:idx] for path in paths for idx in range(len(path))}


def _build_observation_clear_paths(paths: set[Path]) -> set[Path]:
    return {path[:idx] for path in paths for idx in range(len(path) + 1)}


def _wildcard_observation_can_be_cleared_by_path(pattern: WildcardPath, path: Path) -> bool:
    return len(path) <= len(pattern) and _path_prefix_matches_pattern(pattern, path)


def _find_paths_with_prefix(paths: Iterable[Path], prefix: Path) -> list[Path] | None:
    matches: list[Path] | None = None
    for observed_path in paths:
        if not _is_path_prefix(prefix, observed_path):
            continue
        if matches is None:
            matches = []
        matches.append(observed_path)
    return matches
