/**
 * Adapted under Apache-2.0 from openai/codex commit
 * 3abbf9fe2c6b6910e9de61f6a0c5bb468f74b5c8,
 * codex-rs/memories/write/src/rollout_input.rs.
 * Pi uses exact local tokens and a separate complete-request ceiling.
 */
import { encode } from "gpt-tokenizer/encoding/o200k_base";

const PI_MEMORY_STAGE1_MAX_BYTES = 8 * 1024 * 1024;
export const PI_MEMORY_STAGE1_OUTPUT_TOKENS = 32_768;
const CONTEXT_RESERVE = 8_192;
const REQUEST_TOKEN_LIMIT = 250_000;
const ROW_BYTES = 10_000;
const TOOL_TOKENS = 2_000;
const OMITTED = '{"omitted":"response items omitted"}\n';
const TRUNCATED = "\n[... truncated ...]\n";

const PRIORITY = {
  human: 0,
  final: 1,
  assistant: 1,
  other_agent: 2,
  commentary: 3,
  context: 4,
  tool: 5,
} as const;

/** Transient, redacted evidence; never persisted as a session format. */
export interface PiMemoryStage1Evidence {
  readonly kind: keyof typeof PRIORITY;
  readonly content: string;
}

export class PiMemoryStage1BudgetError extends Error {
  constructor(
    readonly errorClass:
      | "input_budget_invalid"
      | "input_budget_exceeded"
      | "input_payload_unmeasurable",
  ) {
    super("Pi memory Stage 1 input budget rejected");
    this.name = "PiMemoryStage1BudgetError";
  }
}

export function stage1InputBudgets(
  contextWindow: number | null,
  native?: { readonly maxTokens: number },
): {
  history: number;
  request: number;
} {
  const valid =
    contextWindow !== null &&
    Number.isSafeInteger(contextWindow) &&
    contextWindow > 0;
  if (
    native &&
    (!valid || !Number.isSafeInteger(native.maxTokens) || native.maxTokens <= 0)
  ) {
    throw new PiMemoryStage1BudgetError("input_budget_invalid");
  }
  const output = native ? native.maxTokens : PI_MEMORY_STAGE1_OUTPUT_TOKENS;
  const request = valid
    ? Math.min(REQUEST_TOKEN_LIMIT, contextWindow - output - CONTEXT_RESERVE)
    : REQUEST_TOKEN_LIMIT;
  if (request <= 0) {
    throw new PiMemoryStage1BudgetError("input_budget_invalid");
  }
  return {
    history: valid ? Math.floor(contextWindow * 0.7) : 150_000,
    request,
  };
}

export function stage1TokenCount(text: string): number {
  // Treat tokenizer special-token spellings as ordinary untrusted text.
  return encode(text, { disallowedSpecial: new Set() }).length;
}

function renderRow(row: PiMemoryStage1Evidence, content: string): string {
  return `${JSON.stringify({ role: row.kind, content })}\n`;
}

function costs(text: string): { history: number; request: number } {
  return {
    history: stage1TokenCount(text) + 4,
    // The history is itself a string in the provider JSON. Charge escaping too.
    request: stage1TokenCount(JSON.stringify(text)) + 4,
  };
}

function floorBoundary(text: string, offset: number): number {
  const code = text.charCodeAt(offset);
  const previous = text.charCodeAt(offset - 1);
  return code >= 0xdc00 &&
    code <= 0xdfff &&
    previous >= 0xd800 &&
    previous <= 0xdbff
    ? offset - 1
    : offset;
}

interface RenderedRow {
  readonly content: string;
  readonly serialized: string;
  readonly history: number;
  readonly request: number;
}

/** Clip content, then serialize a complete row; never slice serialized JSON. */
function fitRow(
  row: PiMemoryStage1Evidence,
  historyLimit: number,
  requestLimit: number,
): RenderedRow | null {
  if (historyLimit <= 0 || requestLimit <= 0) return null;
  const render = (content: string): RenderedRow | null => {
    const serialized = renderRow(row, content);
    if (Buffer.byteLength(serialized, "utf8") > ROW_BYTES) return null;
    const cost = costs(serialized);
    if (
      cost.history > historyLimit ||
      cost.request > requestLimit ||
      (row.kind === "tool" && cost.history - 4 > TOOL_TOKENS)
    )
      return null;
    return { content, serialized, ...cost };
  };
  const full = render(row.content);
  if (full !== null) return full;
  let low = 0;
  let high = Math.min(row.content.length, ROW_BYTES);
  let fitted: RenderedRow | null = null;
  while (low <= high) {
    const length = Math.floor((low + high) / 2);
    const head = floorBoundary(row.content, Math.ceil(length / 2));
    const tail = floorBoundary(
      row.content,
      row.content.length - Math.floor(length / 2),
    );
    const candidate = render(
      row.content.slice(0, head) + TRUNCATED + row.content.slice(tail),
    );
    if (candidate !== null) {
      fitted = candidate;
      low = length + 1;
    } else {
      high = length - 1;
    }
  }
  return fitted;
}

/** Redaction must precede this boundary, including across content segments. */
export function boundStage1Evidence(
  rows: readonly PiMemoryStage1Evidence[],
): PiMemoryStage1Evidence[] {
  let bytes = 0;
  return rows.map((row) => {
    const rendered = fitRow(row, Infinity, Infinity);
    bytes +=
      rendered === null ? 0 : Buffer.byteLength(rendered.serialized, "utf8");
    if (rendered === null || bytes > PI_MEMORY_STAGE1_MAX_BYTES) {
      throw new PiMemoryStage1BudgetError("input_budget_exceeded");
    }
    return { kind: row.kind, content: rendered.content };
  });
}

/** Tier/newest selection is repeated from the same rows when budgets shrink. */
export function selectStage1Evidence(
  rows: readonly PiMemoryStage1Evidence[],
  historyLimit: number,
  requestLimit: number,
): string {
  const gap = costs(OMITTED);
  let history = historyLimit - gap.history;
  let request = requestLimit - gap.request;
  const selected = new Map<number, string>();
  for (let tier = 0; tier <= 5; tier += 1) {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      if (!row || PRIORITY[row.kind] !== tier) continue;
      const text = fitRow(row, history - gap.history, request - gap.request);
      if (text === null) continue;
      history -= text.history + gap.history;
      request -= text.request + gap.request;
      selected.set(index, text.serialized);
    }
  }
  const output: string[] = [];
  let omitted = false;
  for (let index = 0; index < rows.length; index += 1) {
    const text = selected.get(index);
    if (text !== undefined) {
      output.push(text);
      omitted = false;
    } else if (!omitted) {
      output.push(OMITTED);
      omitted = true;
    }
  }
  return output.join("");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reject non-JSON data instead of silently omitting an unchecked payload. */
export function serializeStage1Payload(payload: unknown): string {
  try {
    const serialized = JSON.stringify(payload, (_key, value: unknown) => {
      if (
        typeof value === "bigint" ||
        typeof value === "function" ||
        typeof value === "symbol" ||
        (typeof value === "number" && !Number.isFinite(value))
      ) {
        throw new PiMemoryStage1BudgetError("input_payload_unmeasurable");
      }
      return value;
    });
    if (typeof serialized !== "string") {
      throw new PiMemoryStage1BudgetError("input_payload_unmeasurable");
    }
    if (Buffer.byteLength(serialized, "utf8") > PI_MEMORY_STAGE1_MAX_BYTES) {
      throw new PiMemoryStage1BudgetError("input_budget_exceeded");
    }
    return serialized;
  } catch (error) {
    if (error instanceof PiMemoryStage1BudgetError) throw error;
    throw new PiMemoryStage1BudgetError("input_payload_unmeasurable");
  }
}
