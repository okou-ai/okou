"""Bounded byte languages for path authorization; never produce forwarding data."""

from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import NamedTuple
from unicodedata import normalize
from urllib.parse import unquote_to_bytes

from path_security import has_unsafe_path

MAX_PATH_CHARACTERS = 65_536
MAX_DECODE_DEPTH = 5
MAX_GRAPH_STATES = 262_144
MAX_GRAPH_EDGES = 1_048_576
MAX_LABEL_BYTES = 4_194_304
MAX_REQUEST_WORK = 8_388_608
MAX_COMPILE_WORK = 16_777_216
_HEX = b"0123456789ABCDEF"
_HEX_VALUES = {x: int(chr(x), 16) for x in b"0123456789ABCDEFabcdef"}
_PERCENT = ord("%")
_ESCAPE_SIZE = 3
_ASCII_SIZE = 128
_UTF8_CONTINUATION_MIN = 128
_UTF8_CONTINUATION_MAX = 191
_UTF8_WIDTHS = ((range(194, 224), 2), (range(224, 240), 3), (range(240, 245), 4))
_UTF8_LEADS = (
    (range(194, 224), 1, 128, 191),
    (range(224, 225), 2, 160, 191),
    (range(225, 237), 2, 128, 191),
    (range(237, 238), 2, 128, 159),
    (range(238, 240), 2, 128, 191),
    (range(240, 241), 3, 144, 191),
    (range(241, 244), 3, 128, 191),
    (range(244, 245), 3, 128, 143),
)
_UNRESERVED = frozenset(b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._~-")
_ESCAPED_DATA = frozenset(b' "<>[]^`{|}')


class AnalysisLimitError(ValueError):
    """A bounded proof did not complete; callers must never interpret it as outside."""


class InvalidPathError(ValueError):
    """The raw/full-chain path is outside the admitted security domain."""


@dataclass
class WorkBudget:
    limit: int = MAX_REQUEST_WORK
    used: int = 0

    def charge(self, amount: int = 1) -> None:
        if amount < 0 or amount > self.limit - self.used:
            raise AnalysisLimitError("path analysis work limit")
        self.used += amount


class Edge(NamedTuple):
    target: int
    symbol: int | None


@dataclass
class PathGraph:
    budget: WorkBudget
    edges: list[list[Edge]] = field(default_factory=lambda: [[]])
    start: int = 0
    finals: set[int] = field(default_factory=set)
    edge_count: int = 0
    label_bytes: int = 0
    state_limit: int = MAX_GRAPH_STATES
    edge_limit: int = MAX_GRAPH_EDGES
    label_limit: int = MAX_LABEL_BYTES
    _productive: frozenset[int] | None = field(default=None, init=False, repr=False)

    def productive_nodes(self) -> frozenset[int]:
        if self._productive is not None:
            return self._productive
        self.budget.charge(len(self.edges))
        reverse: list[list[int]] = [[] for _ in self.edges]
        for source, outgoing in enumerate(self.edges):
            for edge in outgoing:
                self.budget.charge()
                reverse[edge.target].append(source)
        productive = set(self.finals)
        pending = list(self.finals)
        while pending:
            self.budget.charge()
            for source in reverse[pending.pop()]:
                self.budget.charge()
                if source not in productive:
                    productive.add(source)
                    pending.append(source)
        self._productive = frozenset(productive)
        return self._productive

    def node(self) -> int:
        self.budget.charge()
        if len(self.edges) >= self.state_limit:
            raise AnalysisLimitError("path graph state limit")
        self.edges.append([])
        return len(self.edges) - 1

    def connect(self, source: int, target: int, symbol: int | None) -> None:
        self.budget.charge()
        if self.edge_count >= self.edge_limit:
            raise AnalysisLimitError("path graph edge limit")
        size = 0 if symbol is None else 1
        if self.label_bytes + size > self.label_limit:
            raise AnalysisLimitError("path graph label limit")
        self.edges[source].append(Edge(target, symbol))
        self.edge_count += 1
        self.label_bytes += size

    def emit(self, source: int, target: int, symbols: tuple[int, ...]) -> None:
        for symbol in symbols[:-1]:
            next_node = self.node()
            self.connect(source, next_node, symbol)
            source = next_node
        self.connect(source, target, symbols[-1] if symbols else None)


def hex_value(symbol: int | None) -> int | None:
    if symbol is None:
        return None
    return _HEX_VALUES.get(symbol)


def decoding_graph(symbols: tuple[int, ...], budget: WorkBudget) -> PathGraph:
    """A shortcut edge records one decoded byte and its original dependency depth."""
    graph = PathGraph(budget)
    depths: list[dict[Edge, int]] = [{}]
    for symbol in symbols:
        end = graph.node()
        depths.append({})
        edge = Edge(end, symbol)
        graph.connect(end - 1, end, symbol)
        depths[end - 1][edge] = 0
    graph.finals.add(len(symbols))
    for depth in range(1, MAX_DECODE_DEPTH + 1):
        additions: dict[tuple[int, Edge], int] = {}
        for source, outgoing in enumerate(depths):
            for first, first_depth in tuple(outgoing.items()):
                budget.charge()
                if first.symbol != _PERCENT:
                    continue
                for second, second_depth in tuple(depths[first.target].items()):
                    budget.charge()
                    high = hex_value(second.symbol)
                    if high is None:
                        continue
                    for third, third_depth in tuple(depths[second.target].items()):
                        budget.charge()
                        low = hex_value(third.symbol)
                        required = max(first_depth, second_depth, third_depth) + 1
                        if low is None or required != depth:
                            continue
                        edge = Edge(third.target, high * 16 + low)
                        previous = outgoing.get(edge)
                        if previous is None or required < previous:
                            if len(additions) >= MAX_GRAPH_EDGES - graph.edge_count:
                                raise AnalysisLimitError("path shortcut edge limit")
                            additions[source, edge] = required
        if not additions:
            break
        for (source, edge), required in additions.items():
            previous = depths[source].get(edge)
            if previous is None:
                graph.connect(source, edge.target, edge.symbol)
            if previous is None or required < previous:
                depths[source][edge] = required
    return graph


Buffer = tuple[int, ...]
RewriteStep = Callable[[Buffer, int], tuple[Buffer, Buffer]]


def rewrite_graph(graph: PathGraph, step: RewriteStep) -> PathGraph:
    """Compose a deterministic buffered byte transducer with an acyclic language."""
    result = PathGraph(graph.budget)
    terminal = result.node()
    result.finals.add(terminal)
    states: dict[tuple[int, Buffer], int] = {(graph.start, ()): result.start}
    pending: deque[tuple[int, Buffer]] = deque([(graph.start, ())])
    while pending:
        source, buffer = pending.popleft()
        out_source = states[source, buffer]
        if source in graph.finals:
            result.emit(out_source, terminal, buffer)
        for edge in graph.edges[source]:
            graph.budget.charge()
            next_buffer, emitted = (
                (buffer, ()) if edge.symbol is None else step(buffer, edge.symbol)
            )
            key = edge.target, next_buffer
            target = states.get(key)
            if target is None:
                target = result.node()
                states[key] = target
                pending.append(key)
            result.emit(out_source, target, emitted)
    return result


def _percent_step(buffer: Buffer, symbol: int) -> tuple[Buffer, Buffer]:
    if not buffer:
        return ((_PERCENT,), ()) if symbol == _PERCENT else ((), (symbol,))
    value = hex_value(symbol)
    if len(buffer) == 1 and value is not None:
        return ((_PERCENT, symbol), ())
    if len(buffer) == _ESCAPE_SIZE - 1 and value is not None:
        high = _HEX_VALUES[buffer[1]]
        decoded = high * 16 + value
        encoded = (_PERCENT, _HEX[high], _HEX[value])
        return (), (decoded,) if decoded in _UNRESERVED else encoded
    next_buffer, output = _percent_step((), symbol)
    return next_buffer, buffer + output


def _utf8_escape_prefix(buffer: Buffer) -> tuple[bool, int]:
    """Return whether an escaped-scalar buffer can still complete, and its width."""
    if not buffer or buffer[0] != _PERCENT:
        return False, 0
    if len(buffer) < _ESCAPE_SIZE:
        return all(hex_value(x) is not None for x in buffer[1:]), 0
    values: list[int] = []
    for index in range(0, len(buffer), _ESCAPE_SIZE):
        piece = buffer[index : index + _ESCAPE_SIZE]
        if piece[0] != _PERCENT or any(hex_value(x) is None for x in piece[1:]):
            return False, 0
        if len(piece) < _ESCAPE_SIZE:
            return True, 0
        high, low = _HEX_VALUES[piece[1]], _HEX_VALUES[piece[2]]
        values.append(high * 16 + low)
    first = values[0]
    width = next((size for leading, size in _UTF8_WIDTHS if first in leading), 0)
    if not width or len(values) > width:
        return False, 0
    if any(not _UTF8_CONTINUATION_MIN <= x <= _UTF8_CONTINUATION_MAX for x in values[1:]):
        return False, 0
    return True, width if len(values) == width else 0


def _utf8_escape_step(buffer: Buffer, symbol: int) -> tuple[Buffer, Buffer]:
    pending = (*buffer, symbol)
    output: list[int] = []
    while pending:
        possible, width = _utf8_escape_prefix(pending)
        if possible and not width:
            return pending, tuple(output)
        if width:
            raw = bytes(
                int(bytes(pending[index + 1 : index + _ESCAPE_SIZE]).decode("ascii"), 16)
                for index in range(0, len(pending), _ESCAPE_SIZE)
            )
            try:
                raw.decode("utf-8")
            except UnicodeError:
                possible = False
            if possible:
                return (), tuple(output) + tuple(raw)
        output.append(pending[0])
        pending = pending[1:]
    return (), tuple(output)


def _data_step(buffer: Buffer, symbol: int) -> tuple[Buffer, Buffer]:
    if symbol in _ESCAPED_DATA:
        return (), (_PERCENT, _HEX[symbol // 16], _HEX[symbol % 16])
    return buffer, (symbol,)


Utf8State = tuple[int, int, int]
_UTF8_START: Utf8State = (0, 0, 0)


def _utf8_next(state: Utf8State, symbol: int) -> Utf8State | None:
    remaining, lower, upper = state
    if remaining:
        if not lower <= symbol <= upper:
            return None
        return (
            (remaining - 1, _UTF8_CONTINUATION_MIN, _UTF8_CONTINUATION_MAX)
            if remaining > 1
            else _UTF8_START
        )
    if symbol < _ASCII_SIZE:
        return _UTF8_START
    for leading, count, minimum, maximum in _UTF8_LEADS:
        if symbol in leading:
            return count, minimum, maximum
    return None


def valid_utf8_graph(graph: PathGraph) -> PathGraph:
    result = PathGraph(graph.budget)
    states = {(graph.start, _UTF8_START): result.start}
    pending = deque([(graph.start, _UTF8_START)])
    while pending:
        source, state = pending.popleft()
        out_source = states[source, state]
        if source in graph.finals and state == _UTF8_START:
            result.finals.add(out_source)
        for edge in graph.edges[source]:
            graph.budget.charge()
            next_state = state if edge.symbol is None else _utf8_next(state, edge.symbol)
            if next_state is None:
                continue
            key = edge.target, next_state
            target = states.get(key)
            if target is None:
                target = result.node()
                states[key] = target
                pending.append(key)
            result.connect(out_source, target, edge.symbol)
    return result


def path_language(symbols: tuple[int, ...], budget: WorkBudget) -> PathGraph:
    graph = decoding_graph(symbols, budget)
    if _PERCENT not in symbols:
        return rewrite_graph(graph, _data_step) if _ESCAPED_DATA.intersection(symbols) else graph
    graph = valid_utf8_graph(graph)
    graph = rewrite_graph(graph, _percent_step)
    graph = rewrite_graph(graph, _utf8_escape_step)
    return rewrite_graph(graph, _data_step)


def request_language(path: str, budget: WorkBudget | None = None) -> PathGraph:
    if len(path) > MAX_PATH_CHARACTERS:
        raise AnalysisLimitError("path character limit")
    work = budget or WorkBudget()
    work.charge(len(path))
    if has_unsafe_path(path):
        raise InvalidPathError("unsafe or malformed path")
    current = path
    for _ in range(MAX_DECODE_DEPTH + 1):
        work.charge(len(current))
        normalized = normalize("NFKC", current)
        if any(boundary in current or boundary in normalized for boundary in ("?", "#")):
            raise InvalidPathError("path interpretation introduces a URL boundary")
        if "%" not in current:
            break
        current = unquote_to_bytes(current).decode("utf-8")
    return path_language(tuple((path or "/").encode("utf-8")), work)


def validate_literal_decoding(literal: str, budget: WorkBudget) -> None:
    """A malformed full literal chain cannot disappear in the partial-view filter."""
    current = literal
    for depth in range(MAX_DECODE_DEPTH + 1):
        if "%" not in current:
            return
        budget.charge(len(current.encode("utf-8")))
        for index, char in enumerate(current):
            if char == "%" and (
                index + _ESCAPE_SIZE > len(current)
                or any(ord(x) not in _HEX_VALUES for x in current[index + 1 : index + _ESCAPE_SIZE])
            ):
                raise InvalidPathError("malformed declaration literal escape")
        try:
            decoded = unquote_to_bytes(current).decode("utf-8")
        except UnicodeError as exc:
            raise InvalidPathError("malformed declaration literal UTF-8") from exc
        if decoded == current:
            return
        if depth == MAX_DECODE_DEPTH:
            raise InvalidPathError("declaration literal decoding depth")
        current = decoded
