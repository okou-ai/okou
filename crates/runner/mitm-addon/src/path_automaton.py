"""Immutable source NFAs and exact bounded request-local subset products."""

from collections.abc import Mapping
from dataclasses import dataclass, field
from itertools import groupby
from typing import NamedTuple

from firewall_matching.patterns import (
    SegmentLiteral,
    SegmentParam,
    _compiled_rule_path_is_valid,
    compile_path_pattern,
)
from path_language import (
    MAX_COMPILE_WORK,
    MAX_GRAPH_EDGES,
    MAX_GRAPH_STATES,
    MAX_LABEL_BYTES,
    MAX_PATH_CHARACTERS,
    AnalysisLimitError,
    Edge,
    PathGraph,
    WorkBudget,
    path_language,
    validate_literal_decoding,
)

MAX_SOURCE_FORMS = 256
MAX_CORE_STATES = 262_144
MAX_CORE_TRANSITIONS = 1_048_576
_PARAM = -1
_PLUS = -2
_STAR = -3
_ANY = -4
_NONSLASH = -5
_SLASH = 47


class PatternNfa(NamedTuple):
    edges: tuple[tuple[Edge, ...], ...]
    accepting: frozenset[int]
    universal: frozenset[int]
    label_bytes: int


def epsilon_closure(graph: PathGraph, seeds: set[int]) -> frozenset[int]:
    closure = set(seeds)
    pending = list(seeds)
    while pending:
        for edge in graph.edges[pending.pop()]:
            graph.budget.charge()
            if edge.symbol is None and edge.target not in closure:
                closure.add(edge.target)
                pending.append(edge.target)
    return frozenset(closure)


def _accepts_symbol(edge_symbol: int, symbol: int) -> bool:
    return edge_symbol in (symbol, _ANY) or (edge_symbol == _NONSLASH and symbol != _SLASH)


@dataclass
class PatternBuilder:
    graph: PathGraph
    cursor: int = 0

    def literal(self, values: tuple[int, ...]) -> None:
        for value in values:
            target = self.graph.node()
            self.graph.connect(self.cursor, target, value)
            self.cursor = target

    def parameter(self, suffix: tuple[int, ...]) -> None:
        body = self.graph.node()
        self.graph.connect(self.cursor, body, _NONSLASH)
        self.graph.connect(body, body, _NONSLASH)
        self.cursor = body
        self.literal(suffix)

    def greedy(self, plus: bool) -> None:
        if plus:
            matched = self.graph.node()
            self.graph.connect(self.cursor, self.cursor, _ANY)
            self.graph.connect(self.cursor, matched, _NONSLASH)
            self.cursor = matched
        self.graph.connect(self.cursor, self.cursor, _ANY)


def _segments(tokens: tuple[int, ...]) -> list[tuple[int, ...]]:
    if not tokens or tokens == (_SLASH,):
        return []
    result: list[tuple[int, ...]] = []
    current: list[int] = []
    for value in tokens[1:] if tokens[0] == _SLASH else tokens:
        if value == _SLASH:
            result.append(tuple(current))
            current = []
        else:
            current.append(value)
    result.append(tuple(current))
    return result


def _append_segments(builder: PatternBuilder, segments: list[tuple[int, ...]]) -> None:
    for index, segment in enumerate(segments):
        if segment == (_STAR,):
            end = builder.graph.node()
            builder.graph.connect(builder.cursor, end, None)
            if index:
                builder.literal((_SLASH,))
            builder.greedy(False)
            builder.graph.connect(builder.cursor, end, None)
            builder.cursor = end
            return
        if index:
            builder.literal((_SLASH,))
        if segment == (_PLUS,):
            builder.greedy(True)
            return
        if _PARAM in segment:
            position = segment.index(_PARAM)
            builder.literal(segment[:position])
            builder.parameter(segment[position + 1 :])
        else:
            builder.literal(segment)


def compile_form(
    tokens: tuple[int, ...],
    budget: WorkBudget,
    *,
    optional_terminal_slash: bool = False,
    state_limit: int = MAX_CORE_STATES,
    edge_limit: int = MAX_CORE_TRANSITIONS,
    label_limit: int = MAX_LABEL_BYTES,
) -> PatternNfa:
    graph = PathGraph(
        budget, state_limit=state_limit, edge_limit=edge_limit, label_limit=label_limit
    )
    builder = PatternBuilder(graph)
    builder.literal((_SLASH,))
    _append_segments(builder, _segments(tokens))
    graph.finals.add(builder.cursor)
    if optional_terminal_slash:
        builder.literal((_SLASH,))
        graph.finals.add(builder.cursor)
    universal: set[int] = set()
    for source, outgoing in enumerate(graph.edges):
        for edge in outgoing:
            budget.charge()
            if (
                edge.target == source
                and edge.symbol == _ANY
                and epsilon_closure(graph, {source}).intersection(graph.finals)
            ):
                universal.add(source)
    budget.charge(len(graph.edges) + graph.edge_count)
    return PatternNfa(
        tuple(tuple(outgoing) for outgoing in graph.edges),
        frozenset(graph.finals),
        frozenset(universal),
        graph.label_bytes,
    )


class MatchProof(NamedTuple):
    possible: bool
    certain: bool


@dataclass
class _SubsetMachine:
    nfa: PatternNfa
    budget: WorkBudget
    subsets: list[frozenset[int]] = field(default_factory=list)
    identities: dict[frozenset[int], int] = field(default_factory=dict)
    transitions: dict[tuple[int, int], int] = field(default_factory=dict)
    label_bytes: int = 0

    def closure(self, seeds: set[int]) -> frozenset[int]:
        self.budget.charge(len(seeds) * 2)
        result = set(seeds)
        pending = list(seeds)
        while pending:
            self.budget.charge()
            for edge in self.nfa.edges[pending.pop()]:
                self.budget.charge()
                if edge.symbol is None and edge.target not in result:
                    if (len(result) + 1) * 8 > MAX_LABEL_BYTES:
                        raise AnalysisLimitError("request epsilon-closure storage limit")
                    self.budget.charge()
                    result.add(edge.target)
                    pending.append(edge.target)
        self.budget.charge(len(result))
        return frozenset(result)

    def intern(self, subset: frozenset[int]) -> int:
        self.budget.charge(len(subset) + 1)
        known = self.identities.get(subset)
        if known is not None:
            return known
        if len(self.subsets) >= MAX_GRAPH_STATES:
            raise AnalysisLimitError("request subset state limit")
        size = len(subset) * 8
        if self.label_bytes + size > MAX_LABEL_BYTES:
            raise AnalysisLimitError("request subset storage limit")
        result = len(self.subsets)
        self.subsets.append(subset)
        self.identities[subset] = result
        self.label_bytes += size
        return result

    def step(self, identity: int, symbol: int) -> int:
        self.budget.charge()
        key = identity, symbol
        known = self.transitions.get(key)
        if known is not None:
            return known
        if len(self.transitions) >= MAX_GRAPH_EDGES:
            raise AnalysisLimitError("request subset transition limit")
        seeds: set[int] = set()
        for source in self.subsets[identity]:
            for edge in self.nfa.edges[source]:
                self.budget.charge()
                if edge.symbol is not None and _accepts_symbol(edge.symbol, symbol):
                    seeds.add(edge.target)
        target = self.intern(self.closure(seeds))
        self.budget.charge()
        self.transitions[key] = target
        return target


def match_graph(graph: PathGraph, nfa: PatternNfa) -> MatchProof:
    productive = graph.productive_nodes()
    machine = _SubsetMachine(nfa, graph.budget)
    start = machine.intern(machine.closure({0}))
    initial = graph.start, start
    seen = {initial}
    pending = [initial]
    possible = False
    rejected = False
    while pending:
        source, identity = pending.pop()
        graph.budget.charge()
        if source not in productive:
            continue
        subset = machine.subsets[identity]
        if not subset:
            rejected = True
            continue
        graph.budget.charge(len(subset))
        if subset.intersection(nfa.universal):
            possible = True
            continue
        if source in graph.finals:
            accepted = bool(subset.intersection(nfa.accepting))
            possible |= accepted
            rejected |= not accepted
        for edge in graph.edges[source]:
            graph.budget.charge()
            target = (
                edge.target,
                identity if edge.symbol is None else machine.step(identity, edge.symbol),
            )
            if target not in seen:
                if len(seen) >= MAX_CORE_STATES:
                    raise AnalysisLimitError("path product state limit")
                seen.add(target)
                pending.append(target)
    if not possible and not rejected:
        raise AnalysisLimitError("empty request language")
    return MatchProof(possible, possible and not rejected)


def pattern_tokens(pattern: str) -> tuple[int, ...]:
    compiled = compile_path_pattern(pattern)
    if compiled is None or not _compiled_rule_path_is_valid(compiled):
        raise ValueError("invalid source path pattern")
    tokens: list[int] = [_SLASH]
    for index, segment in enumerate(compiled.segments):
        if index:
            tokens.append(_SLASH)
        if isinstance(segment, SegmentLiteral):
            tokens.extend(segment.value.encode("utf-8"))
        elif isinstance(segment, SegmentParam):
            tokens.extend(segment.prefix.encode("utf-8"))
            tokens.append(
                _PLUS if segment.greedy == "+" else _STAR if segment.greedy == "*" else _PARAM
            )
            tokens.extend(segment.suffix.encode("utf-8"))
    return tuple(tokens)


def concrete_forms(tokens: tuple[int, ...], budget: WorkBudget) -> tuple[tuple[int, ...], ...]:
    """Enumerate distinct catalog forms after subset sharing, never request views."""
    graph = path_language(tokens, budget)
    initial = epsilon_closure(graph, {graph.start})
    moves: dict[frozenset[int], tuple[tuple[int, frozenset[int]], ...]] = {}
    retained = 0
    transitions = 0

    def outgoing(subset: frozenset[int]) -> tuple[tuple[int, frozenset[int]], ...]:
        nonlocal retained, transitions
        known = moves.get(subset)
        if known is not None:
            return known
        if len(moves) >= MAX_GRAPH_STATES or retained + len(subset) * 8 > MAX_LABEL_BYTES:
            raise AnalysisLimitError("source subset state limit")
        grouped: dict[int, set[int]] = {}
        for source in subset:
            for edge in graph.edges[source]:
                budget.charge()
                if edge.symbol is not None:
                    grouped.setdefault(edge.symbol, set()).add(edge.target)
        if transitions + len(grouped) > MAX_GRAPH_EDGES:
            raise AnalysisLimitError("source subset edge limit")
        result = tuple(
            (symbol, epsilon_closure(graph, seeds)) for symbol, seeds in sorted(grouped.items())
        )
        moves[subset] = result
        retained += len(subset) * 8
        transitions += len(grouped)
        return result

    forms: list[tuple[int, ...]] = []
    prefix: list[int] = []
    stack = [(initial, -1)]
    labels = 0
    while stack:
        budget.charge()
        subset, position = stack[-1]
        if position == -1 and subset.intersection(graph.finals):
            if len(forms) >= MAX_SOURCE_FORMS or labels + len(prefix) > MAX_LABEL_BYTES:
                raise AnalysisLimitError("declaration form limit")
            budget.charge(len(prefix))
            forms.append(tuple(prefix))
            labels += len(prefix)
        alternatives = outgoing(subset)
        position += 1
        if position >= len(alternatives):
            stack.pop()
            if stack:
                prefix.pop()
            continue
        stack[-1] = subset, position
        symbol, target = alternatives[position]
        prefix.append(symbol)
        stack.append((target, -1))
    if not forms:
        raise AnalysisLimitError("empty declaration language")
    return tuple(forms)


PathPriority = tuple[int, ...]


def form_priority(tokens: tuple[int, ...]) -> PathPriority:
    counts = [0] * 7
    segments = _segments(tokens)
    counts[6] = len(segments)
    for segment in segments:
        literal = tuple(x for x in segment if x >= 0)
        counts[5] += len(bytes(literal).decode("utf-8"))
        if all(x >= 0 for x in segment):
            counts[0] += 1
        elif literal:
            counts[1] += 1
        elif segment == (_PLUS,):
            counts[3] += 1
        elif segment == (_STAR,):
            counts[4] -= 1
        else:
            counts[2] += 1
    return counts[0], counts[1], counts[2], counts[3], counts[4], counts[5], counts[6]


class CompiledForm(NamedTuple):
    nfa: PatternNfa
    priority: PathPriority


class Applicability(NamedTuple):
    possible: bool
    certain: bool
    minimum: PathPriority | None
    maximum: PathPriority | None


@dataclass
class PathCompiler:
    """Snapshot-owned immutable source NFAs; source identities stay with the caller."""

    budget: WorkBudget = field(default_factory=lambda: WorkBudget(MAX_COMPILE_WORK))
    states: int = 0
    transitions: int = 0
    label_bytes: int = 0
    acceptors: dict[tuple[tuple[int, ...], bool], PatternNfa] = field(default_factory=dict)

    def source_tokens(self, pattern: str, *, parameterized: bool) -> tuple[int, ...]:
        if len(pattern) > MAX_PATH_CHARACTERS:
            raise AnalysisLimitError("source path character limit")
        data = pattern.encode("utf-8")
        self.budget.charge(len(data))
        tokens = pattern_tokens(pattern) if parameterized and pattern else tuple(data)
        self.validate_tokens(tokens)
        return tokens

    def validate_tokens(self, tokens: tuple[int, ...]) -> None:
        if ord("%") in tokens:
            for literal, chunk in groupby(tokens, lambda symbol: symbol >= 0):
                if literal:
                    validate_literal_decoding(bytes(chunk).decode("utf-8"), self.budget)

    def acceptor(
        self, form: tuple[int, ...], *, optional_terminal_slash: bool = False
    ) -> PatternNfa:
        key = form, optional_terminal_slash
        known = self.acceptors.get(key)
        if known is not None:
            return known
        if self.states >= MAX_CORE_STATES:
            raise AnalysisLimitError("core NFA state limit")
        known = compile_form(
            form,
            self.budget,
            optional_terminal_slash=optional_terminal_slash,
            state_limit=MAX_CORE_STATES - self.states,
            edge_limit=MAX_CORE_TRANSITIONS - self.transitions,
            label_limit=MAX_LABEL_BYTES - self.label_bytes,
        )
        states = len(known.edges)
        transitions = sum(len(row) for row in known.edges)
        if self.states + states > MAX_CORE_STATES:
            raise AnalysisLimitError("core NFA state limit")
        if self.transitions + transitions > MAX_CORE_TRANSITIONS:
            raise AnalysisLimitError("core NFA transition limit")
        if self.label_bytes + known.label_bytes > MAX_LABEL_BYTES:
            raise AnalysisLimitError("core literal label limit")
        self.states += states
        self.transitions += transitions
        self.label_bytes += known.label_bytes
        self.acceptors[key] = known
        return known

    def compile(self, pattern: str) -> tuple[CompiledForm, ...]:
        forms = concrete_forms(self.source_tokens(pattern, parameterized=True), self.budget)
        compiled: list[CompiledForm] = []
        for form in forms:
            compiled.append(CompiledForm(self.acceptor(form), form_priority(form)))
        return tuple(compiled)

    def compile_api(
        self,
        raw_base_path: str,
        *,
        parameterized: bool,
        rule: str | None = None,
        typed_base: tuple[int, ...] | None = None,
    ) -> tuple[CompiledForm, ...]:
        """Keep each interpreted prefix cut correlated with its relative route.

        The URL parser's already-stripped path must not be used here: a single
        optional terminal slash is removed separately from every literal view.
        Greedy base parameters consume the entire remainder in the raw matcher.
        """
        if typed_base is None:
            base_tokens = self.source_tokens(raw_base_path, parameterized=parameterized)
        else:
            if len(raw_base_path) > MAX_PATH_CHARACTERS:
                raise AnalysisLimitError("source path character limit")
            self.budget.charge(len(raw_base_path.encode("utf-8")))
            base_tokens = typed_base
            self.validate_tokens(base_tokens)
        bases = concrete_forms(base_tokens, self.budget)
        routes = (
            (None,)
            if rule is None
            else concrete_forms(self.source_tokens(rule, parameterized=True), self.budget)
        )
        compiled: list[CompiledForm] = []
        seen: set[tuple[tuple[int, ...] | None, PathPriority, bool]] = set()
        for raw_base in bases:
            base = raw_base[:-1] if raw_base and raw_base[-1] == _SLASH else raw_base
            for route in routes:
                self.budget.charge()
                priority = (base_priority(base),) + (() if route is None else form_priority(route))
                tokens, optional_slash = _compose_source(base, route)
                identity = tokens, priority, optional_slash
                if identity in seen:
                    continue
                if len(seen) >= MAX_SOURCE_FORMS:
                    raise AnalysisLimitError("combined declaration form limit")
                seen.add(identity)
                compiled.append(
                    CompiledForm(
                        _REJECT_ALL
                        if tokens is None
                        else self.acceptor(tokens, optional_terminal_slash=optional_slash),
                        priority,
                    )
                )
        return tuple(compiled)


def _compose_source(
    base: tuple[int, ...], route: tuple[int, ...] | None
) -> tuple[tuple[int, ...] | None, bool]:
    greedy_base = bool(base and base[-1] in (_PLUS, _STAR))
    if route is None:
        return (base if greedy_base else (*base, _SLASH, _STAR)), False
    if greedy_base:
        # A greedy base exhausts the path; only relative root can apply.
        return (base if route in ((_SLASH,), (_SLASH, _STAR)) else None), False
    if route == (_SLASH,):
        return base or (_SLASH,), bool(base)
    return (*base, *route), False


_REJECT_ALL = PatternNfa(((),), frozenset(), frozenset(), 0)


def base_priority(tokens: tuple[int, ...]) -> int:
    if not tokens:
        return 0
    if tokens == (_SLASH,):
        return 1
    score = 0
    for segment in _segments(tokens):
        literal = tuple(x for x in segment if x >= 0)
        length = len(bytes(literal).decode("utf-8"))
        if len(literal) == len(segment):
            score += 1_000 + length
        elif literal:
            score += 100 + length
        elif segment == (_PLUS,):
            score += 1
        elif segment != (_STAR,):
            score += 10
    return score


@dataclass
class PathAnalysis:
    graph: PathGraph
    proofs: dict[int, tuple[PatternNfa, MatchProof]] = field(default_factory=dict)

    def applicability(self, forms: tuple[CompiledForm, ...]) -> Applicability:
        return applicability(self.graph, forms, self.proofs)


def applicability(
    graph: PathGraph,
    forms: tuple[CompiledForm, ...],
    proofs: dict[int, tuple[PatternNfa, MatchProof]] | None = None,
) -> Applicability:
    if not forms:
        raise AnalysisLimitError("incomplete declaration language")
    possible = False
    certain = True
    minimum: PathPriority | None = None
    maximum: PathPriority | None = None
    memo = {} if proofs is None else proofs
    for form in forms:
        graph.budget.charge()
        known = memo.get(id(form.nfa))
        if known is None:
            if len(memo) >= MAX_CORE_STATES:
                raise AnalysisLimitError("request acceptor memo limit")
            proof = match_graph(graph, form.nfa)
            memo[id(form.nfa)] = form.nfa, proof
        else:
            proof = known[1]
        possible |= proof.possible
        certain &= proof.certain
        if proof.possible:
            minimum = form.priority if minimum is None else min(minimum, form.priority)
            maximum = form.priority if maximum is None else max(maximum, form.priority)
    return Applicability(possible, certain, minimum, maximum)


class SelectionCandidate(NamedTuple):
    owner: str
    proof: Applicability
    tie_rank: int
    raw_priority: PathPriority | None = None


def certifies_selection(
    candidates: Mapping[str, SelectionCandidate],
    *,
    original_owner_sources: frozenset[str],
    selected: str,
    explicit_owner_intent: bool,
    budget: WorkBudget,
) -> bool:
    """Certify a raw winner using matching-conditioned priority envelopes.

    Priorities contain the existing base tier and relative-rule coordinates;
    the caller supplies its unchanged policy/order tie rank. Other owners may
    change below the winner, but an equal tier needs the existing usable intent.
    This function supplies no route, captures, owner or credentials.
    """
    winner = candidates.get(selected)
    if winner is None or not winner.proof.certain or winner.proof.minimum is None:
        return False
    possible: set[str] = set()
    certain: set[str] = set()
    for identity, candidate in candidates.items():
        budget.charge()
        proof = candidate.proof
        if candidate.owner == winner.owner:
            if proof.possible:
                possible.add(identity)
            if proof.certain:
                certain.add(identity)
        if not proof.possible or identity == selected:
            continue
        if proof.maximum is None:
            return False
        comparison = (winner.proof.minimum > proof.maximum) - (winner.proof.minimum < proof.maximum)
        if comparison < 0:
            return False
        if comparison == 0:
            if candidate.owner != winner.owner:
                if not explicit_owner_intent:
                    return False
            else:
                if (
                    winner.raw_priority is not None
                    and candidate.raw_priority is not None
                    and winner.raw_priority != candidate.raw_priority
                ):
                    # A newly tied API can introduce conflicting auth bindings,
                    # even if declaration order would retain the raw route.
                    return False
                if candidate.tie_rank > winner.tie_rank:
                    return False
    return possible == certain == original_owner_sources
