/** Immutable source NFAs and bounded exact request-local subset products. */
import { parseSegment, splitPathSegments } from "./segment-parser";
import {
  AnalysisLimitError,
  InvalidPathError,
  MAX_COMPILE_WORK,
  MAX_GRAPH_EDGES,
  MAX_GRAPH_STATES,
  MAX_LABEL_BYTES,
  MAX_PATH_CHARACTERS,
  PathGraph,
  type PathEdge,
  WorkBudget,
  encodePathLiteral,
  pathLanguage,
  validateLiteralDecoding,
} from "./path-language";

const MAX_SOURCE_FORMS = 256;
const MAX_CORE_STATES = 262_144;
const MAX_CORE_TRANSITIONS = 1_048_576;
const PARAM = -1;
const PLUS = -2;
const STAR = -3;
const ANY = -4;
const NONSLASH = -5;
const SLASH = 47;
const strictDecoder = new TextDecoder("utf-8", { fatal: true });

interface PatternNfa {
  readonly edges: readonly (readonly PathEdge[])[];
  readonly accepting: ReadonlySet<number>;
  readonly universal: ReadonlySet<number>;
  readonly labelBytes: number;
}

function closure(graph: PathGraph, seeds: ReadonlySet<number>): Set<number> {
  const result = new Set(seeds);
  const pending = [...seeds];
  while (pending.length > 0) {
    for (const edge of graph.edges[pending.pop()!]!) {
      graph.budget.charge();
      if (edge.symbol === null && !result.has(edge.target)) {
        result.add(edge.target);
        pending.push(edge.target);
      }
    }
  }
  return result;
}

function subsetKey(subset: ReadonlySet<number>): string {
  return [...subset]
    .sort((a, b) => {
      return a - b;
    })
    .join(",");
}

function acceptsSymbol(edge: number, symbol: number): boolean {
  return (
    edge === symbol || edge === ANY || (edge === NONSLASH && symbol !== SLASH)
  );
}

class PatternBuilder {
  cursor = 0;
  constructor(readonly graph: PathGraph) {}
  literal(values: readonly number[]): void {
    for (const value of values) {
      const target = this.graph.node();
      this.graph.connect(this.cursor, target, value);
      this.cursor = target;
    }
  }
  parameter(suffix: readonly number[]): void {
    const body = this.graph.node();
    this.graph.connect(this.cursor, body, NONSLASH);
    this.graph.connect(body, body, NONSLASH);
    this.cursor = body;
    this.literal(suffix);
  }
  greedy(plus: boolean): void {
    if (plus) {
      const matched = this.graph.node();
      this.graph.connect(this.cursor, this.cursor, ANY);
      this.graph.connect(this.cursor, matched, NONSLASH);
      this.cursor = matched;
    }
    this.graph.connect(this.cursor, this.cursor, ANY);
  }
}

function segments(tokens: readonly number[]): number[][] {
  if (tokens.length === 0 || (tokens.length === 1 && tokens[0] === SLASH))
    return [];
  const result: number[][] = [];
  let current: number[] = [];
  for (const value of tokens.slice(tokens[0] === SLASH ? 1 : 0)) {
    if (value === SLASH) {
      result.push(current);
      current = [];
    } else current.push(value);
  }
  result.push(current);
  return result;
}

function appendSegments(
  builder: PatternBuilder,
  parts: readonly (readonly number[])[],
): void {
  for (const [index, segment] of parts.entries()) {
    if (segment.length === 1 && segment[0] === STAR) {
      const end = builder.graph.node();
      builder.graph.connect(builder.cursor, end, null);
      if (index > 0) builder.literal([SLASH]);
      builder.greedy(false);
      builder.graph.connect(builder.cursor, end, null);
      builder.cursor = end;
      return;
    }
    if (index > 0) builder.literal([SLASH]);
    if (segment.length === 1 && segment[0] === PLUS) {
      builder.greedy(true);
      return;
    }
    const position = segment.indexOf(PARAM);
    if (position >= 0) {
      builder.literal(segment.slice(0, position));
      builder.parameter(segment.slice(position + 1));
    } else builder.literal(segment);
  }
}

function compileForm(
  tokens: readonly number[],
  budget: WorkBudget,
  optionalTerminalSlash = false,
  stateLimit = MAX_CORE_STATES,
  edgeLimit = MAX_CORE_TRANSITIONS,
  labelLimit = MAX_LABEL_BYTES,
): PatternNfa {
  const graph = new PathGraph(budget, stateLimit, edgeLimit, labelLimit);
  const builder = new PatternBuilder(graph);
  builder.literal([SLASH]);
  appendSegments(builder, segments(tokens));
  graph.finals.add(builder.cursor);
  if (optionalTerminalSlash) {
    builder.literal([SLASH]);
    graph.finals.add(builder.cursor);
  }
  const universal = new Set<number>();
  graph.edges.forEach((outgoing, source) => {
    for (const edge of outgoing) {
      budget.charge();
      if (
        edge.target === source &&
        edge.symbol === ANY &&
        [...closure(graph, new Set([source]))].some((state) => {
          return graph.finals.has(state);
        })
      )
        universal.add(source);
    }
  });
  budget.charge(graph.edges.length + graph.edgeCount);
  return {
    edges: graph.edges.map((outgoing) => {
      return [...outgoing];
    }),
    accepting: new Set(graph.finals),
    universal,
    labelBytes: graph.labelBytes,
  };
}

class SubsetMachine {
  readonly subsets: ReadonlySet<number>[] = [];
  readonly identities = new Map<string, number>();
  readonly transitions = new Map<string, number>();
  labelBytes = 0;
  constructor(
    readonly nfa: PatternNfa,
    readonly budget: WorkBudget,
  ) {}
  closure(seeds: ReadonlySet<number>): ReadonlySet<number> {
    this.budget.charge(seeds.size * 2);
    const result = new Set(seeds);
    const pending = [...seeds];
    while (pending.length > 0) {
      this.budget.charge();
      for (const edge of this.nfa.edges[pending.pop()!]!) {
        this.budget.charge();
        if (edge.symbol === null && !result.has(edge.target)) {
          if ((result.size + 1) * 8 > MAX_LABEL_BYTES)
            throw new AnalysisLimitError(
              "request epsilon-closure storage limit",
            );
          this.budget.charge();
          result.add(edge.target);
          pending.push(edge.target);
        }
      }
    }
    return result;
  }
  intern(subset: ReadonlySet<number>): number {
    this.budget.charge(subset.size * 2 + 1);
    const key = [...subset]
      .sort((a, b) => {
        this.budget.charge();
        return a - b;
      })
      .join(",");
    const known = this.identities.get(key);
    if (known !== undefined) return known;
    if (this.subsets.length >= MAX_GRAPH_STATES)
      throw new AnalysisLimitError("request subset state limit");
    const bytes = subset.size * 8 + key.length;
    if (this.labelBytes + bytes > MAX_LABEL_BYTES)
      throw new AnalysisLimitError("request subset storage limit");
    const identity = this.subsets.length;
    this.subsets.push(subset);
    this.identities.set(key, identity);
    this.labelBytes += bytes;
    return identity;
  }
  step(identity: number, symbol: number): number {
    this.budget.charge();
    const key = `${identity}:${symbol}`;
    const known = this.transitions.get(key);
    if (known !== undefined) return known;
    if (this.transitions.size >= MAX_GRAPH_EDGES)
      throw new AnalysisLimitError("request subset transition limit");
    const seeds = new Set<number>();
    for (const source of this.subsets[identity]!)
      for (const edge of this.nfa.edges[source]!) {
        this.budget.charge();
        if (edge.symbol !== null && acceptsSymbol(edge.symbol, symbol))
          seeds.add(edge.target);
      }
    const target = this.intern(this.closure(seeds));
    this.budget.charge();
    this.transitions.set(key, target);
    return target;
  }
}

function matchGraph(
  graph: PathGraph,
  nfa: PatternNfa,
): { possible: boolean; certain: boolean } {
  const productive = graph.productiveNodes();
  const machine = new SubsetMachine(nfa, graph.budget);
  const start = machine.intern(machine.closure(new Set([0])));
  const seen = new Set([`${graph.start}:${start}`]);
  const pending: (readonly [number, number])[] = [[graph.start, start]];
  let possible = false;
  let rejected = false;
  while (pending.length > 0) {
    const [source, identity] = pending.pop()!;
    graph.budget.charge();
    if (!productive.has(source)) continue;
    const subset = machine.subsets[identity]!;
    if (subset.size === 0) {
      rejected = true;
      continue;
    }
    graph.budget.charge(subset.size);
    if (
      [...subset].some((state) => {
        return nfa.universal.has(state);
      })
    ) {
      possible = true;
      continue;
    }
    if (graph.finals.has(source)) {
      const accepted = [...subset].some((state) => {
        return nfa.accepting.has(state);
      });
      possible ||= accepted;
      rejected ||= !accepted;
    }
    for (const edge of graph.edges[source]!) {
      graph.budget.charge();
      const next =
        edge.symbol === null ? identity : machine.step(identity, edge.symbol);
      const key = `${edge.target}:${next}`;
      if (!seen.has(key)) {
        if (seen.size >= MAX_CORE_STATES)
          throw new AnalysisLimitError("path product state limit");
        seen.add(key);
        pending.push([edge.target, next]);
      }
    }
  }
  if (!possible && !rejected)
    throw new AnalysisLimitError("empty request language");
  return { possible, certain: possible && !rejected };
}

function patternTokens(pattern: string): number[] {
  const tokens = [SLASH];
  const names = new Set<string>();
  const parts = splitPathSegments(pattern);
  for (const [index, text] of parts.entries()) {
    if (index > 0) tokens.push(SLASH);
    const segment = parseSegment(text);
    if (segment.kind === "error")
      throw new InvalidPathError("invalid source path pattern");
    if (segment.kind === "literal") {
      for (const byte of encodePathLiteral(segment.value)) tokens.push(byte);
      continue;
    }
    if (
      names.has(segment.name) ||
      (segment.greedy !== "" &&
        (index !== parts.length - 1 ||
          segment.prefix !== "" ||
          segment.suffix !== ""))
    ) {
      throw new InvalidPathError("invalid source path pattern");
    }
    names.add(segment.name);
    for (const byte of encodePathLiteral(segment.prefix)) tokens.push(byte);
    tokens.push(
      segment.greedy === "+" ? PLUS : segment.greedy === "*" ? STAR : PARAM,
    );
    for (const byte of encodePathLiteral(segment.suffix)) tokens.push(byte);
  }
  return tokens;
}

function concreteForms(
  tokens: readonly number[],
  budget: WorkBudget,
): number[][] {
  const graph = pathLanguage(tokens, budget);
  const initial = closure(graph, new Set([graph.start]));
  const cache = new Map<
    string,
    readonly (readonly [number, ReadonlySet<number>])[]
  >();
  let retained = 0;
  let transitions = 0;
  const outgoing = (
    subset: ReadonlySet<number>,
  ): readonly (readonly [number, ReadonlySet<number>])[] => {
    const key = subsetKey(subset);
    const known = cache.get(key);
    if (known !== undefined) return known;
    if (
      cache.size >= MAX_GRAPH_STATES ||
      retained + subset.size * 8 > MAX_LABEL_BYTES
    )
      throw new AnalysisLimitError("source subset state limit");
    const grouped = new Map<number, Set<number>>();
    for (const source of subset)
      for (const edge of graph.edges[source]!) {
        budget.charge();
        if (edge.symbol === null) continue;
        let targets = grouped.get(edge.symbol);
        if (targets === undefined) {
          targets = new Set();
          grouped.set(edge.symbol, targets);
        }
        targets.add(edge.target);
      }
    if (transitions + grouped.size > MAX_GRAPH_EDGES)
      throw new AnalysisLimitError("source subset edge limit");
    const result = [...grouped.entries()]
      .sort(([a], [b]) => {
        return a - b;
      })
      .map(([symbol, targets]) => {
        return [symbol, closure(graph, targets)] as const;
      });
    cache.set(key, result);
    retained += subset.size * 8;
    transitions += grouped.size;
    return result;
  };
  const forms: number[][] = [];
  const prefix: number[] = [];
  const stack: { subset: ReadonlySet<number>; position: number }[] = [
    { subset: initial, position: -1 },
  ];
  let labels = 0;
  while (stack.length > 0) {
    budget.charge();
    const current = stack.at(-1)!;
    if (
      current.position === -1 &&
      [...current.subset].some((x) => {
        return graph.finals.has(x);
      })
    ) {
      if (
        forms.length >= MAX_SOURCE_FORMS ||
        labels + prefix.length > MAX_LABEL_BYTES
      )
        throw new AnalysisLimitError("declaration form limit");
      budget.charge(prefix.length);
      forms.push([...prefix]);
      labels += prefix.length;
    }
    const alternatives = outgoing(current.subset);
    current.position += 1;
    if (current.position >= alternatives.length) {
      stack.pop();
      if (stack.length > 0) prefix.pop();
      continue;
    }
    const [symbol, target] = alternatives[current.position]!;
    prefix.push(symbol);
    stack.push({ subset: target, position: -1 });
  }
  if (forms.length === 0)
    throw new AnalysisLimitError("empty declaration language");
  return forms;
}

type PathPriority = readonly number[];
function formPriority(tokens: readonly number[]): PathPriority {
  const counts = [0, 0, 0, 0, 0, 0, segments(tokens).length];
  for (const segment of segments(tokens)) {
    const literal = segment.filter((x) => {
      return x >= 0;
    });
    counts[5]! += [...strictDecoder.decode(new Uint8Array(literal))].length;
    if (literal.length === segment.length) counts[0]! += 1;
    else if (literal.length > 0) counts[1]! += 1;
    else if (segment.length === 1 && segment[0] === PLUS) counts[3]! += 1;
    else if (segment.length === 1 && segment[0] === STAR) counts[4]! -= 1;
    else counts[2]! += 1;
  }
  return [
    counts[0]!,
    counts[1]!,
    counts[2]!,
    counts[3]!,
    counts[4]!,
    counts[5]!,
    counts[6]!,
  ];
}

export interface CompiledPathForm {
  readonly nfa: PatternNfa;
  readonly priority: PathPriority;
}
export interface PathApplicability {
  readonly possible: boolean;
  readonly certain: boolean;
  readonly minimum: PathPriority | null;
  readonly maximum: PathPriority | null;
}

export class PathCompiler {
  readonly budget = new WorkBudget(MAX_COMPILE_WORK);
  states = 0;
  transitions = 0;
  labelBytes = 0;
  readonly acceptors = new Map<string, PatternNfa>();
  sourceTokens(pattern: string, parameterized: boolean): number[] {
    let length = 0;
    for (const _char of pattern) {
      length += 1;
      if (length > MAX_PATH_CHARACTERS)
        throw new AnalysisLimitError("source path character limit");
    }
    const data = encodePathLiteral(pattern);
    this.budget.charge(data.length);
    const tokens =
      parameterized && pattern !== "" ? patternTokens(pattern) : data;
    this.validateTokens(tokens);
    return tokens;
  }
  validateTokens(tokens: readonly number[]): void {
    if (tokens.includes(37)) {
      let literal: number[] = [];
      for (const symbol of [...tokens, PARAM]) {
        if (symbol >= 0) literal.push(symbol);
        else if (literal.length > 0) {
          validateLiteralDecoding(
            strictDecoder.decode(new Uint8Array(literal)),
            this.budget,
          );
          literal = [];
        }
      }
    }
  }
  acceptor(form: readonly number[], optionalTerminalSlash = false): PatternNfa {
    const key = `${optionalTerminalSlash ? 1 : 0}:${form.join(",")}`;
    const known = this.acceptors.get(key);
    if (known !== undefined) return known;
    if (this.states >= MAX_CORE_STATES)
      throw new AnalysisLimitError("core NFA state limit");
    const nfa = compileForm(
      form,
      this.budget,
      optionalTerminalSlash,
      MAX_CORE_STATES - this.states,
      MAX_CORE_TRANSITIONS - this.transitions,
      MAX_LABEL_BYTES - this.labelBytes,
    );
    const states = nfa.edges.length;
    const transitions = nfa.edges.reduce((sum, row) => {
      return sum + row.length;
    }, 0);
    if (this.states + states > MAX_CORE_STATES)
      throw new AnalysisLimitError("core NFA state limit");
    if (this.transitions + transitions > MAX_CORE_TRANSITIONS)
      throw new AnalysisLimitError("core NFA transition limit");
    if (this.labelBytes + nfa.labelBytes > MAX_LABEL_BYTES)
      throw new AnalysisLimitError("core literal label limit");
    this.states += states;
    this.transitions += transitions;
    this.labelBytes += nfa.labelBytes;
    this.acceptors.set(key, nfa);
    return nfa;
  }
  compile(pattern: string): readonly CompiledPathForm[] {
    const compiled: CompiledPathForm[] = [];
    for (const form of concreteForms(
      this.sourceTokens(pattern, true),
      this.budget,
    )) {
      compiled.push({ nfa: this.acceptor(form), priority: formPriority(form) });
    }
    return compiled;
  }

  /** Interpret source literals before stripping one base slash; never reparse operators. */
  compileApi(
    rawBasePath: string,
    parameterized: boolean,
    rule?: string,
    typedBase?: readonly number[],
  ): readonly CompiledPathForm[] {
    if (typedBase !== undefined) {
      let length = 0;
      for (const _char of rawBasePath) {
        length += 1;
        if (length > MAX_PATH_CHARACTERS)
          throw new AnalysisLimitError("source path character limit");
      }
      this.budget.charge(encodePathLiteral(rawBasePath).length);
      this.validateTokens(typedBase);
    }
    const baseTokens =
      typedBase ?? this.sourceTokens(rawBasePath, parameterized);
    const bases = concreteForms(baseTokens, this.budget);
    const routes =
      rule === undefined
        ? [null]
        : concreteForms(this.sourceTokens(rule, true), this.budget);
    const compiled: CompiledPathForm[] = [];
    const seen = new Set<string>();
    for (const rawBase of bases) {
      const base = rawBase.at(-1) === SLASH ? rawBase.slice(0, -1) : rawBase;
      for (const route of routes) {
        this.budget.charge();
        const priority =
          route === null
            ? [basePriority(base)]
            : [basePriority(base), ...formPriority(route)];
        const { tokens, optionalSlash } = composeSource(base, route);
        const identity = `${tokens?.join(",") ?? "reject"}:${priority.join(",")}:${optionalSlash ? 1 : 0}`;
        if (seen.has(identity)) continue;
        if (seen.size >= MAX_SOURCE_FORMS)
          throw new AnalysisLimitError("combined declaration form limit");
        seen.add(identity);
        compiled.push({
          nfa:
            tokens === null ? REJECT_ALL : this.acceptor(tokens, optionalSlash),
          priority,
        });
      }
    }
    return compiled;
  }
}

function composeSource(
  base: readonly number[],
  route: readonly number[] | null,
): { tokens: readonly number[] | null; optionalSlash: boolean } {
  const greedyBase = base.at(-1) === PLUS || base.at(-1) === STAR;
  if (route === null)
    return {
      tokens: greedyBase ? base : [...base, SLASH, STAR],
      optionalSlash: false,
    };
  if (greedyBase) {
    const matchesRoot =
      (route.length === 1 && route[0] === SLASH) ||
      (route.length === 2 && route[0] === SLASH && route[1] === STAR);
    return { tokens: matchesRoot ? base : null, optionalSlash: false };
  }
  if (route.length === 1 && route[0] === SLASH)
    return {
      tokens: base.length > 0 ? base : [SLASH],
      optionalSlash: base.length > 0,
    };
  return { tokens: [...base, ...route], optionalSlash: false };
}

const REJECT_ALL: PatternNfa = {
  edges: [[]],
  accepting: new Set(),
  universal: new Set(),
  labelBytes: 0,
};

function basePriority(tokens: readonly number[]): number {
  if (tokens.length === 0) return 0;
  if (tokens.length === 1 && tokens[0] === SLASH) return 1;
  let score = 0;
  for (const segment of segments(tokens)) {
    const literal = segment.filter((x) => {
      return x >= 0;
    });
    const length = [...strictDecoder.decode(new Uint8Array(literal))].length;
    if (literal.length === segment.length) score += 1_000 + length;
    else if (literal.length > 0) score += 100 + length;
    else if (segment.length === 1 && segment[0] === PLUS) score += 1;
    else if (!(segment.length === 1 && segment[0] === STAR)) score += 10;
  }
  return score;
}

function comparePriority(a: PathPriority, b: PathPriority): number {
  for (let index = 0; index < a.length; index += 1)
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  return 0;
}

export function pathApplicability(
  graph: PathGraph,
  forms: readonly CompiledPathForm[],
  memo = new Map<PatternNfa, { possible: boolean; certain: boolean }>(),
): PathApplicability {
  if (forms.length === 0)
    throw new AnalysisLimitError("incomplete declaration language");
  let possible = false;
  let certain = true;
  let minimum: PathPriority | null = null;
  let maximum: PathPriority | null = null;
  for (const form of forms) {
    graph.budget.charge();
    let proof = memo.get(form.nfa);
    if (proof === undefined) {
      if (memo.size >= MAX_CORE_STATES)
        throw new AnalysisLimitError("request acceptor memo limit");
      proof = matchGraph(graph, form.nfa);
      memo.set(form.nfa, proof);
    }
    possible ||= proof.possible;
    certain &&= proof.certain;
    if (proof.possible) {
      if (minimum === null || comparePriority(form.priority, minimum) < 0)
        minimum = form.priority;
      if (maximum === null || comparePriority(form.priority, maximum) > 0)
        maximum = form.priority;
    }
  }
  return { possible, certain, minimum, maximum };
}

export class PathAnalysis {
  private readonly proofs = new Map<
    PatternNfa,
    { possible: boolean; certain: boolean }
  >();
  constructor(readonly graph: PathGraph) {}
  applicability(forms: readonly CompiledPathForm[]): PathApplicability {
    return pathApplicability(this.graph, forms, this.proofs);
  }
}

export interface SelectionCandidate {
  readonly owner: string;
  readonly proof: PathApplicability;
  readonly tieRank: number;
  readonly rawPriority?: readonly number[];
}

function createsSameOwnerTie(
  winner: SelectionCandidate,
  candidate: SelectionCandidate,
): boolean {
  return (
    winner.rawPriority !== undefined &&
    candidate.rawPriority !== undefined &&
    comparePriority(winner.rawPriority, candidate.rawPriority) !== 0
  );
}

/** A proof about the raw selection; it never returns a replacement route. */
export function certifiesSelection(
  candidates: ReadonlyMap<string, SelectionCandidate>,
  originalOwnerSources: ReadonlySet<string>,
  selected: string,
  explicitOwnerIntent: boolean,
  budget: WorkBudget,
): boolean {
  const winner = candidates.get(selected);
  if (
    winner === undefined ||
    !winner.proof.certain ||
    winner.proof.minimum === null
  )
    return false;
  const possible = new Set<string>();
  const certain = new Set<string>();
  for (const [identity, candidate] of candidates) {
    budget.charge();
    const proof = candidate.proof;
    if (candidate.owner === winner.owner) {
      if (proof.possible) possible.add(identity);
      if (proof.certain) certain.add(identity);
    }
    if (!proof.possible || identity === selected) continue;
    if (proof.maximum === null) return false;
    const comparison = comparePriority(winner.proof.minimum, proof.maximum);
    if (comparison < 0) return false;
    if (comparison === 0) {
      if (candidate.owner !== winner.owner) {
        if (!explicitOwnerIntent) return false;
      } else {
        if (createsSameOwnerTie(winner, candidate)) return false;
        if (candidate.tieRank > winner.tieRank) return false;
      }
    }
  }
  return (
    possible.size === originalOwnerSources.size &&
    certain.size === originalOwnerSources.size &&
    [...originalOwnerSources].every((identity) => {
      return possible.has(identity) && certain.has(identity);
    })
  );
}
