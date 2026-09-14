import type {
  AssistantMessage,
  Context,
  Message,
  ToolCall,
} from "@earendil-works/pi-ai";
import { decode, encode } from "gpt-tokenizer/encoding/o200k_base";
import { projectPiMemoryCitationSegments } from "@okouai/api-contracts/contracts/pi-memory-citations";

import { PI_MEMORY_STAGE1_REASONING } from "./memory-background-config";
import { piAgentStreamForConfig, resolvePiAgentModel } from "./model";
import { MemoryPiSession } from "./session-memory";
import {
  PI_MEMORY_STAGE1_SYSTEM_PROMPT,
  renderPiMemoryStage1Input,
} from "./stage1-prompts";
import type { PiAgentModelConfig } from "./types";

const MEMORY_TOOL_PREFIX = "memories.";
const REDACTED_SECRET = "[REDACTED_SECRET]";
const PRIVATE_KEY_BEGIN_PREFIX = "-----BEGIN ";
const PRIVATE_KEY_LABEL_SUFFIX = " PRIVATE KEY";
const PRIVATE_KEY_MARKER_SUFFIX = "-----";
const PRIVATE_KEY_TYPE_MAX_LENGTH = 32;
const AUTHORIZATION_HEADER =
  /(\b(?:authorization|proxy-authorization)\s*:\s*)(?:bearer|basic)\s+[^\s`"'<>]+/giu;
const COOKIE_HEADER = /(\b(?:cookie|set-cookie)\s*:\s*)[^\r\n]+/giu;
const URL_USER_INFO = /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu;
const PROVIDER_TOKEN =
  /(?<![A-Za-z0-9])(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})(?![A-Za-z0-9])/gu;
const SECRET_ASSIGNMENT =
  /((?:["'`]?)(?:api[_-]?key|access[_-]?key|secret|token|password|passwd|private[_-]?key|client[_-]?secret|cookie)(?:["'`]?)\s*(?::|=)\s*)(["'`]?)([^\s,;\r\n"'`]+)(["'`]?)/giu;
const TRUNCATION_MARKER = "\n[... truncated ...]\n";
const EXCLUDED_USER_MARKERS = [
  "<oai-mem-citation>",
  "<memory_context>",
  "<recalled_memories>",
  "# AGENTS.md instructions",
  "<environment_context>",
  "<permissions instructions>",
] as const;

export const PI_MEMORY_STAGE1_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    raw_memory: { type: "string" },
    rollout_summary: { type: "string" },
    rollout_slug: { type: ["string", "null"] },
  },
  required: ["raw_memory", "rollout_summary", "rollout_slug"],
  additionalProperties: false,
} as const;

export interface PiMemoryStage1ProviderUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export interface PiMemoryStage1ProviderResult {
  readonly responseText: string;
  readonly responseId: string | undefined;
  readonly usage: PiMemoryStage1ProviderUsage;
}

export class PiMemoryStage1ProviderError extends Error {
  constructor() {
    super("Pi memory Stage 1 provider request failed");
    this.name = "PiMemoryStage1ProviderError";
  }
}

function privateKeyLabelAt(input: string, start: number): string | null {
  const labelStart = start + PRIVATE_KEY_BEGIN_PREFIX.length;
  const boundedMarker = input.slice(
    labelStart,
    labelStart +
      PRIVATE_KEY_TYPE_MAX_LENGTH +
      PRIVATE_KEY_LABEL_SUFFIX.length +
      PRIVATE_KEY_MARKER_SUFFIX.length,
  );
  const markerEnd = boundedMarker.indexOf(PRIVATE_KEY_MARKER_SUFFIX);
  if (markerEnd < 0) {
    return null;
  }
  const label = boundedMarker.slice(0, markerEnd);
  if (label === "PRIVATE KEY") {
    return label;
  }
  if (!label.endsWith(PRIVATE_KEY_LABEL_SUFFIX)) {
    return null;
  }
  const type = label.slice(0, -PRIVATE_KEY_LABEL_SUFFIX.length);
  if (type.length === 0 || type.length > PRIVATE_KEY_TYPE_MAX_LENGTH) {
    return null;
  }
  for (const character of type) {
    const code = character.charCodeAt(0);
    if (!((code >= 48 && code <= 57) || (code >= 65 && code <= 90))) {
      return null;
    }
  }
  return label;
}

function redactPrivateKeyBlocks(input: string): string {
  const parts: string[] = [];
  let cursor = 0;
  let searchFrom = 0;
  while (searchFrom < input.length) {
    const begin = input.indexOf(PRIVATE_KEY_BEGIN_PREFIX, searchFrom);
    if (begin < 0) {
      break;
    }
    const label = privateKeyLabelAt(input, begin);
    if (label === null) {
      searchFrom = begin + PRIVATE_KEY_BEGIN_PREFIX.length;
      continue;
    }
    const endMarker = `-----END ${label}-----`;
    const end = input.indexOf(
      endMarker,
      begin + PRIVATE_KEY_BEGIN_PREFIX.length + label.length,
    );
    parts.push(input.slice(cursor, begin), REDACTED_SECRET);
    if (end < 0) {
      cursor = input.length;
      break;
    }
    cursor = end + endMarker.length;
    searchFrom = cursor;
  }
  parts.push(input.slice(cursor));
  return parts.join("");
}

/** Deterministic redaction for both Stage 1 trust boundaries. */
export function redactPiMemoryStage1Secrets(input: string): string {
  return redactPrivateKeyBlocks(input)
    .replace(AUTHORIZATION_HEADER, `$1${REDACTED_SECRET}`)
    .replace(COOKIE_HEADER, `$1${REDACTED_SECRET}`)
    .replace(URL_USER_INFO, `$1${REDACTED_SECRET}@`)
    .replace(PROVIDER_TOKEN, REDACTED_SECRET)
    .replace(SECRET_ASSIGNMENT, `$1$2${REDACTED_SECRET}$4`);
}

/** Apply Codex's 70% effective-window head/tail truncation deterministically. */
export function truncatePiMemoryStage1History(args: {
  readonly projectedHistory: string;
  readonly contextWindow: number | null;
  readonly fallbackTokenLimit: number;
  readonly maxBytes: number;
}): { readonly content: string; readonly tokenCount: number } {
  const tokenLimit =
    args.contextWindow === null
      ? args.fallbackTokenLimit
      : Math.max(1, Math.floor(args.contextWindow * 0.7));
  let tokens = encode(args.projectedHistory);
  if (tokens.length > tokenLimit) {
    const markerTokens = encode(TRUNCATION_MARKER);
    const contentBudget = Math.max(0, tokenLimit - markerTokens.length);
    const headCount = Math.ceil(contentBudget / 2);
    const tailCount = Math.floor(contentBudget / 2);
    tokens = [
      ...tokens.slice(0, headCount),
      ...markerTokens,
      ...tokens.slice(tokens.length - tailCount),
    ];
  }
  let content = decode(tokens);
  if (Buffer.byteLength(content, "utf8") > args.maxBytes) {
    const buffer = Buffer.from(content, "utf8");
    const marker = Buffer.from(TRUNCATION_MARKER, "utf8");
    const contentBudget = Math.max(0, args.maxBytes - marker.length);
    const headBytes = Math.ceil(contentBudget / 2);
    const tailBytes = Math.floor(contentBudget / 2);
    content = Buffer.concat([
      buffer.subarray(0, headBytes),
      marker,
      buffer.subarray(buffer.length - tailBytes),
    ]).toString("utf8");
    tokens = encode(content);
  }
  return { content, tokenCount: tokens.length };
}

function textFromContent(content: Message["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((item) => {
      return item.type === "text";
    })
    .map((item) => {
      return item.type === "text" ? item.text : "";
    })
    .join("\n");
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => {
        return left.localeCompare(right);
      })
      .map(([key, item]) => {
        return [key, canonicalJson(item)] as const;
      }),
  );
}

function isMemoryTool(call: ToolCall): boolean {
  return call.name.startsWith(MEMORY_TOOL_PREFIX);
}

function isRuntimeOrMemoryFeedback(text: string): boolean {
  return EXCLUDED_USER_MARKERS.some((marker) => {
    return text.includes(marker);
  });
}

function assistantIsUsable(message: AssistantMessage): boolean {
  return message.stopReason !== "error" && message.stopReason !== "aborted";
}

function appendAssistantProjection(args: {
  readonly message: AssistantMessage;
  readonly toolResults: ReadonlyMap<string, Message>;
  readonly emittedToolIds: Set<string>;
  readonly projected: unknown[];
}): void {
  if (!assistantIsUsable(args.message)) {
    return;
  }
  const citationProjection = projectPiMemoryCitationSegments(
    args.message.content.flatMap((item) => {
      return item.type === "text" ? [item.text] : [];
    }),
  );
  let textIndex = 0;
  for (const item of args.message.content) {
    if (item.type === "text") {
      const content = (
        citationProjection.visibleSegments[textIndex] ?? ""
      ).trim();
      textIndex += 1;
      if (content) {
        args.projected.push({ role: "assistant", content });
      }
    } else if (
      item.type === "toolCall" &&
      args.toolResults.has(item.id) &&
      !isMemoryTool(item)
    ) {
      args.emittedToolIds.add(item.id);
      args.projected.push({
        role: "assistant",
        tool: {
          name: item.name,
          arguments: canonicalJson(item.arguments),
        },
      });
    }
  }
}

/**
 * Parse canonical Pi JSONL and serialize only the official active branch's
 * content-bearing messages. Persisted ids, timestamps, provider metadata,
 * reasoning, custom/runtime messages, and incomplete tools are deliberately
 * absent from the result.
 */
export function projectPiMemoryStage1History(args: {
  readonly jsonl: string;
  readonly expectedSessionId: string;
}): string {
  const session = MemoryPiSession.fromJsonl(args.jsonl);
  if (session.getSessionId() !== args.expectedSessionId) {
    throw new Error("Pi memory Stage 1 source session id mismatch");
  }
  if (!session.isSettledCheckpoint()) {
    throw new Error("Pi memory Stage 1 source is not settled");
  }

  const messages = session.getBranchEntries().flatMap((entry) => {
    return entry.type === "message" ? [entry.message] : [];
  });
  const toolResults = new Map(
    messages.flatMap((message) => {
      return message.role === "toolResult"
        ? [[message.toolCallId, message] as const]
        : [];
    }),
  );
  const emittedToolIds = new Set<string>();
  const projected: unknown[] = [];

  for (const message of messages) {
    switch (message.role) {
      case "user": {
        const content = textFromContent(message.content).trim();
        if (content && !isRuntimeOrMemoryFeedback(content)) {
          projected.push({ role: "user", content });
        }
        break;
      }
      case "assistant": {
        appendAssistantProjection({
          message,
          toolResults,
          emittedToolIds,
          projected,
        });
        break;
      }
      case "toolResult": {
        if (emittedToolIds.has(message.toolCallId)) {
          projected.push({
            role: "tool",
            name: message.toolName,
            content: textFromContent(message.content).trim(),
            is_error: message.isError,
          });
        }
        break;
      }
      case "bashExecution":
      case "branchSummary":
      case "compactionSummary":
      case "custom": {
        break;
      }
      default: {
        const exhaustiveRole: never = message;
        return exhaustiveRole;
      }
    }
  }

  return projected
    .map((item) => {
      return JSON.stringify(item);
    })
    .join("\n");
}

export function resolvePiMemoryStage1ContextWindow(
  config: PiAgentModelConfig,
): number | null {
  const model = resolvePiAgentModel(config);
  return model &&
    Number.isSafeInteger(model.contextWindow) &&
    model.contextWindow > 0
    ? model.contextWindow
    : null;
}

async function consumeAssistantMessage(
  stream: ReturnType<ReturnType<typeof piAgentStreamForConfig>>,
): Promise<AssistantMessage> {
  for await (const _event of stream) {
    // Stage 1 owns only the terminal structured response.
  }
  return await stream.result();
}

export async function runPiMemoryStage1Extraction(
  args: {
    readonly model: PiAgentModelConfig;
    readonly projectedHistory: string;
    readonly requestId: string;
  },
  signal?: AbortSignal,
): Promise<PiMemoryStage1ProviderResult> {
  const model = resolvePiAgentModel(args.model);
  if (!model) {
    throw new PiMemoryStage1ProviderError();
  }
  const context: Context = {
    systemPrompt: PI_MEMORY_STAGE1_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: renderPiMemoryStage1Input(args.projectedHistory),
        timestamp: 0,
      },
    ],
    tools: [],
  };
  const message = await consumeAssistantMessage(
    piAgentStreamForConfig(args.model)(model, context, {
      apiKey: args.model.apiKey,
      reasoning: PI_MEMORY_STAGE1_REASONING,
      samplingParams: {
        max_output_tokens: 32_768,
        text: {
          format: {
            type: "json_schema",
            name: "pi_memory_stage1",
            strict: true,
            schema: PI_MEMORY_STAGE1_RESPONSE_SCHEMA,
          },
        },
      },
      sessionId: args.requestId,
      signal,
    }),
  );
  if (message.stopReason !== "stop") {
    throw new PiMemoryStage1ProviderError();
  }
  if (
    message.content.some((item) => {
      return item.type === "toolCall";
    })
  ) {
    throw new PiMemoryStage1ProviderError();
  }
  return {
    responseText: message.content
      .flatMap((item) => {
        return item.type === "text" ? [item.text] : [];
      })
      .join(""),
    responseId: message.responseId,
    usage: {
      input: message.usage.input,
      output: message.usage.output,
      cacheRead: message.usage.cacheRead,
      cacheWrite: message.usage.cacheWrite,
    },
  };
}
