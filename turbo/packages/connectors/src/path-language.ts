/** Bounded path languages. Graphs are proof inputs, never forwarding data. */
import { hasUnsafeFirewallPath } from "./firewall-types";
export const MAX_PATH_CHARACTERS = 65_536;
export const MAX_DECODE_DEPTH = 5;
export const MAX_GRAPH_STATES = 262_144;
export const MAX_GRAPH_EDGES = 1_048_576;
export const MAX_LABEL_BYTES = 4_194_304;
export const MAX_REQUEST_WORK = 8_388_608;
export const MAX_COMPILE_WORK = 16_777_216;

const HEX = "0123456789ABCDEF";
const UNRESERVED = /^[A-Za-z0-9._~-]$/;
const ESCAPED_DATA = new Set(
  [...` "<>[]^\u0060{|}`].map((x) => {
    return x.charCodeAt(0);
  }),
);
const encoder = new TextEncoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true });

export class AnalysisLimitError extends Error {}
export class InvalidPathError extends Error {}

export class WorkBudget {
  used = 0;
  constructor(readonly limit = MAX_REQUEST_WORK) {}
  charge(amount = 1): void {
    if (amount < 0 || amount > this.limit - this.used) {
      throw new AnalysisLimitError("path analysis work limit");
    }
    this.used += amount;
  }
}

export interface PathEdge {
  readonly target: number;
  readonly symbol: number | null;
}

export class PathGraph {
  readonly edges: PathEdge[][] = [[]];
  private productive: ReadonlySet<number> | undefined;

  productiveNodes(): ReadonlySet<number> {
    if (this.productive !== undefined) return this.productive;
    this.budget.charge(this.edges.length);
    const reverse: number[][] = this.edges.map(() => {
      return [];
    });
    this.edges.forEach((outgoing, source) => {
      for (const edge of outgoing) {
        this.budget.charge();
        reverse[edge.target]!.push(source);
      }
    });
    const productive = new Set(this.finals);
    const pending = [...this.finals];
    while (pending.length > 0) {
      this.budget.charge();
      for (const source of reverse[pending.pop()!]!) {
        this.budget.charge();
        if (!productive.has(source)) {
          productive.add(source);
          pending.push(source);
        }
      }
    }
    this.productive = productive;
    return productive;
  }
  readonly start = 0;
  readonly finals = new Set<number>();
  edgeCount = 0;
  labelBytes = 0;
  constructor(
    readonly budget: WorkBudget,
    readonly stateLimit = MAX_GRAPH_STATES,
    readonly edgeLimit = MAX_GRAPH_EDGES,
    readonly labelLimit = MAX_LABEL_BYTES,
  ) {}
  node(): number {
    this.budget.charge();
    if (this.edges.length >= this.stateLimit) {
      throw new AnalysisLimitError("path graph state limit");
    }
    this.edges.push([]);
    return this.edges.length - 1;
  }
  connect(source: number, target: number, symbol: number | null): void {
    this.budget.charge();
    if (this.edgeCount >= this.edgeLimit) {
      throw new AnalysisLimitError("path graph edge limit");
    }
    const size = symbol === null ? 0 : 1;
    if (this.labelBytes + size > this.labelLimit) {
      throw new AnalysisLimitError("path graph label limit");
    }
    this.edges[source]!.push({ target, symbol });
    this.edgeCount += 1;
    this.labelBytes += size;
  }
  emit(source: number, target: number, symbols: readonly number[]): void {
    for (const symbol of symbols.slice(0, -1)) {
      const next = this.node();
      this.connect(source, next, symbol);
      source = next;
    }
    this.connect(source, target, symbols.at(-1) ?? null);
  }
}

function hexValue(symbol: number | null): number | null {
  if (symbol === null || symbol < 0) return null;
  const position = HEX.indexOf(String.fromCharCode(symbol).toUpperCase());
  return position < 0 ? null : position;
}

function decodingGraph(
  symbols: readonly number[],
  budget: WorkBudget,
): PathGraph {
  const graph = new PathGraph(budget);
  const depths: Map<string, { edge: PathEdge; depth: number }>[] = [new Map()];
  for (const symbol of symbols) {
    const end = graph.node();
    depths.push(new Map());
    const edge = { target: end, symbol };
    graph.connect(end - 1, end, symbol);
    depths[end - 1]!.set(`${end}:${symbol}`, { edge, depth: 0 });
  }
  graph.finals.add(symbols.length);
  for (let depth = 1; depth <= MAX_DECODE_DEPTH; depth += 1) {
    const additions = new Map<
      string,
      { source: number; edge: PathEdge; depth: number }
    >();
    for (const [source, outgoing] of depths.entries()) {
      for (const first of outgoing.values()) {
        budget.charge();
        if (first.edge.symbol !== 37) continue;
        for (const second of depths[first.edge.target]!.values()) {
          budget.charge();
          const high = hexValue(second.edge.symbol);
          if (high === null) continue;
          for (const third of depths[second.edge.target]!.values()) {
            budget.charge();
            const low = hexValue(third.edge.symbol);
            const required =
              Math.max(first.depth, second.depth, third.depth) + 1;
            if (low === null || required !== depth) continue;
            const edge = { target: third.edge.target, symbol: high * 16 + low };
            const previous = outgoing.get(`${edge.target}:${edge.symbol}`);
            if (previous !== undefined && previous.depth <= required) continue;
            if (additions.size >= MAX_GRAPH_EDGES - graph.edgeCount) {
              throw new AnalysisLimitError("path shortcut edge limit");
            }
            additions.set(`${source}:${edge.target}:${edge.symbol}`, {
              source,
              edge,
              depth: required,
            });
          }
        }
      }
    }
    if (additions.size === 0) break;
    for (const item of additions.values()) {
      const key = `${item.edge.target}:${item.edge.symbol}`;
      const previous = depths[item.source]!.get(key);
      if (previous === undefined)
        graph.connect(item.source, item.edge.target, item.edge.symbol);
      if (previous === undefined || item.depth < previous.depth) {
        depths[item.source]!.set(key, { edge: item.edge, depth: item.depth });
      }
    }
  }
  return graph;
}

type BufferState = readonly number[];
type RewriteStep = (
  buffer: BufferState,
  symbol: number,
) => readonly [BufferState, BufferState];

function rewriteGraph(graph: PathGraph, step: RewriteStep): PathGraph {
  const result = new PathGraph(graph.budget);
  const terminal = result.node();
  result.finals.add(terminal);
  const keyOf = (node: number, buffer: BufferState): string => {
    return `${node}|${buffer.join(",")}`;
  };
  const states = new Map([[keyOf(graph.start, []), result.start]]);
  const pending: { source: number; buffer: BufferState }[] = [
    { source: graph.start, buffer: [] },
  ];
  for (let index = 0; index < pending.length; index += 1) {
    const { source, buffer } = pending[index]!;
    const outSource = states.get(keyOf(source, buffer))!;
    if (graph.finals.has(source)) result.emit(outSource, terminal, buffer);
    for (const edge of graph.edges[source]!) {
      graph.budget.charge();
      const [nextBuffer, emitted] =
        edge.symbol === null ? [buffer, []] : step(buffer, edge.symbol);
      const key = keyOf(edge.target, nextBuffer);
      let target = states.get(key);
      if (target === undefined) {
        target = result.node();
        states.set(key, target);
        pending.push({ source: edge.target, buffer: nextBuffer });
      }
      result.emit(outSource, target, emitted);
    }
  }
  return result;
}

function percentStep(
  buffer: BufferState,
  symbol: number,
): readonly [BufferState, BufferState] {
  if (buffer.length === 0) return symbol === 37 ? [[37], []] : [[], [symbol]];
  const value = hexValue(symbol);
  if (buffer.length === 1 && value !== null) return [[37, symbol], []];
  if (buffer.length === 2 && value !== null) {
    const high = hexValue(buffer[1]!)!;
    const decoded = high * 16 + value;
    const char = String.fromCharCode(decoded);
    return [
      [],
      UNRESERVED.test(char)
        ? [decoded]
        : [37, HEX.charCodeAt(high), HEX.charCodeAt(value)],
    ];
  }
  const [nextBuffer, output] = percentStep([], symbol);
  return [nextBuffer, [...buffer, ...output]];
}

function utf8EscapePrefix(buffer: BufferState): readonly [boolean, number] {
  if (buffer.length === 0 || buffer[0] !== 37) return [false, 0];
  if (buffer.length < 3)
    return [
      buffer.slice(1).every((x) => {
        return hexValue(x) !== null;
      }),
      0,
    ];
  const values: number[] = [];
  for (let index = 0; index < buffer.length; index += 3) {
    const piece = buffer.slice(index, index + 3);
    if (
      piece[0] !== 37 ||
      piece.slice(1).some((x) => {
        return hexValue(x) === null;
      })
    )
      return [false, 0];
    if (piece.length < 3) return [true, 0];
    values.push(hexValue(piece[1]!)! * 16 + hexValue(piece[2]!)!);
  }
  const first = values[0]!;
  const width =
    first >= 194 && first <= 223
      ? 2
      : first >= 224 && first <= 239
        ? 3
        : first >= 240 && first <= 244
          ? 4
          : 0;
  if (
    width === 0 ||
    values.length > width ||
    values.slice(1).some((x) => {
      return x < 128 || x > 191;
    })
  )
    return [false, 0];
  return [true, values.length === width ? width : 0];
}

function utf8EscapeStep(
  buffer: BufferState,
  symbol: number,
): readonly [BufferState, BufferState] {
  let pending = [...buffer, symbol];
  const output: number[] = [];
  while (pending.length > 0) {
    const [possible, width] = utf8EscapePrefix(pending);
    if (possible && width === 0) return [pending, output];
    if (width > 0) {
      const bytes: number[] = [];
      for (let index = 0; index < pending.length; index += 3) {
        bytes.push(
          hexValue(pending[index + 1]!)! * 16 + hexValue(pending[index + 2]!)!,
        );
      }
      let valid = true;
      try {
        strictDecoder.decode(new Uint8Array(bytes));
      } catch {
        valid = false;
      }
      if (valid) return [[], [...output, ...bytes]];
    }
    output.push(pending[0]!);
    pending = pending.slice(1);
  }
  return [[], output];
}

function dataStep(
  buffer: BufferState,
  symbol: number,
): readonly [BufferState, BufferState] {
  return ESCAPED_DATA.has(symbol)
    ? [
        [],
        [
          37,
          HEX.charCodeAt(Math.floor(symbol / 16)),
          HEX.charCodeAt(symbol % 16),
        ],
      ]
    : [buffer, [symbol]];
}

type Utf8State = readonly [number, number, number];
const UTF8_START: Utf8State = [0, 0, 0];
function utf8Next(state: Utf8State, symbol: number): Utf8State | null {
  const [remaining, lower, upper] = state;
  if (remaining > 0) {
    if (symbol < lower || symbol > upper) return null;
    return remaining > 1 ? [remaining - 1, 128, 191] : UTF8_START;
  }
  if (symbol < 128) return UTF8_START;
  if (symbol >= 194 && symbol <= 223) return [1, 128, 191];
  if (symbol >= 224 && symbol <= 239)
    return [2, symbol === 224 ? 160 : 128, symbol === 237 ? 159 : 191];
  if (symbol >= 240 && symbol <= 244)
    return [3, symbol === 240 ? 144 : 128, symbol === 244 ? 143 : 191];
  return null;
}

function validUtf8Graph(graph: PathGraph): PathGraph {
  const result = new PathGraph(graph.budget);
  const keyOf = (node: number, state: Utf8State): string => {
    return `${node}|${state.join(",")}`;
  };
  const states = new Map([[keyOf(graph.start, UTF8_START), result.start]]);
  const pending: { source: number; state: Utf8State }[] = [
    { source: graph.start, state: UTF8_START },
  ];
  for (let index = 0; index < pending.length; index += 1) {
    const { source, state } = pending[index]!;
    const outSource = states.get(keyOf(source, state))!;
    if (graph.finals.has(source) && state[0] === 0)
      result.finals.add(outSource);
    for (const edge of graph.edges[source]!) {
      graph.budget.charge();
      const nextState =
        edge.symbol === null ? state : utf8Next(state, edge.symbol);
      if (nextState === null) continue;
      const key = keyOf(edge.target, nextState);
      let target = states.get(key);
      if (target === undefined) {
        target = result.node();
        states.set(key, target);
        pending.push({ source: edge.target, state: nextState });
      }
      result.connect(outSource, target, edge.symbol);
    }
  }
  return result;
}

export function pathLanguage(
  symbols: readonly number[],
  budget: WorkBudget,
): PathGraph {
  let graph = decodingGraph(symbols, budget);
  if (!symbols.includes(37))
    return symbols.some((x) => {
      return ESCAPED_DATA.has(x);
    })
      ? rewriteGraph(graph, dataStep)
      : graph;
  graph = validUtf8Graph(graph);
  graph = rewriteGraph(graph, percentStep);
  graph = rewriteGraph(graph, utf8EscapeStep);
  return rewriteGraph(graph, dataStep);
}

export function encodePathLiteral(value: string): number[] {
  for (const char of value) {
    const point = char.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff)
      throw new InvalidPathError("invalid path Unicode scalar");
  }
  return [...encoder.encode(value)];
}

export function requestLanguage(
  path: string,
  budget = new WorkBudget(),
): PathGraph {
  let length = 0;
  for (const _char of path) {
    length += 1;
    if (length > MAX_PATH_CHARACTERS)
      throw new AnalysisLimitError("path character limit");
  }
  budget.charge(length);
  if (hasUnsafeFirewallPath(path))
    throw new InvalidPathError("unsafe or malformed path");
  let current = path;
  for (let depth = 0; depth <= MAX_DECODE_DEPTH; depth += 1) {
    budget.charge([...current].length);
    if (/[?#]/.test(current) || /[?#]/.test(current.normalize("NFKC")))
      throw new InvalidPathError(
        "path interpretation introduces a URL boundary",
      );
    if (!current.includes("%")) break;
    current = decodeURIComponent(current);
  }
  return pathLanguage(encodePathLiteral(path || "/"), budget);
}

export function validateLiteralDecoding(
  literal: string,
  budget: WorkBudget,
): void {
  let current = literal;
  for (let depth = 0; depth <= MAX_DECODE_DEPTH; depth += 1) {
    if (!current.includes("%")) return;
    budget.charge(encoder.encode(current).length);
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      throw new InvalidPathError("malformed declaration literal encoding");
    }
    if (decoded === current) return;
    if (depth === MAX_DECODE_DEPTH)
      throw new InvalidPathError("declaration literal decoding depth");
    current = decoded;
  }
}
