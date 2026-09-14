import type {
  AssistantMessage,
  Context,
  Message,
  ToolCall,
} from "@earendil-works/pi-ai";

import { projectPiMemoryCitationSegments } from "@okouai/api-contracts/contracts/pi-memory-citations";

import { PI_MEMORY_STAGE1_REASONING } from "./memory-background-config";
import { piAgentStreamForConfig, resolvePiAgentModel } from "./model";
import { MemoryPiSession } from "./session-memory";
import {
  PI_MEMORY_STAGE1_SYSTEM_PROMPT,
  renderPiMemoryStage1Input,
} from "./stage1-prompts";
import type { PiAgentModelConfig } from "./types";

import {
  boundStage1Evidence,
  isRecord,
  PiMemoryStage1BudgetError,
  PI_MEMORY_STAGE1_OUTPUT_TOKENS,
  selectStage1Evidence,
  serializeStage1Payload,
  stage1InputBudgets,
  stage1TokenCount,
  type PiMemoryStage1Evidence,
} from "./stage1-input";
import {
  redactPiMemoryStage1Segments,
  redactPiMemoryStage1Secrets,
} from "./stage1-secrets";

const MEMORY_TOOL_PREFIX = "memories.";
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

function textFromContent(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content
    .flatMap((item) => {
      switch (item.type) {
        case "text":
          return [item.text];
        case "image":
          return ["[image omitted]"];
        case "thinking":
        case "toolCall":
          return [];
        default:
          throw new Error("Unsupported Pi memory Stage 1 content");
      }
    })
    .join("");
}

function canonicalJson(value: unknown): unknown {
  // Redact leaf text before JSON escaping can hide quoted shell assignments.
  if (typeof value === "string") return redactPiMemoryStage1Secrets(value);
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

function assistantKind(
  signature: string | undefined,
): PiMemoryStage1Evidence["kind"] {
  // SDK 0.85.1's optional TextSignatureV1. Legacy/absent phases retain
  // upstream non-commentary priority without claiming a known final phase.
  if (signature) {
    try {
      const value: unknown = JSON.parse(signature);
      if (isRecord(value) && value.v === 1 && typeof value.id === "string") {
        if (value.phase === "final_answer") return "final";
        if (value.phase === "commentary") return "commentary";
      }
    } catch {
      // A legacy opaque id is valid SDK data, but has no phase provenance.
    }
  }
  return "assistant";
}

function isOtherAgentEnvelope(text: string): boolean {
  return (
    /^Message Type: (?:MESSAGE|FINAL_ANSWER)\r?\nTask name: [^\r\n]+\r?\nSender: [^\r\n]+\r?\nPayload:\r?\n[\s\S]+$/u.test(
      text,
    ) ||
    /^<subagent_notification>\s*[\s\S]+\s*<\/subagent_notification>$/u.test(
      text,
    )
  );
}

function appendAssistantEvidence(
  message: AssistantMessage,
  rows: PiMemoryStage1Evidence[],
  pending: Map<string, ToolCall>,
): void {
  if (!assistantIsUsable(message)) return;
  const texts = message.content.flatMap((item) => {
    return item.type === "text" ? [item] : [];
  });
  const visible = projectPiMemoryCitationSegments(
    texts.map((item) => {
      return item.text;
    }),
  );
  const redacted = redactPiMemoryStage1Segments(visible.visibleSegments);
  const otherAgent = isOtherAgentEnvelope(
    texts
      .map((item) => {
        return item.text;
      })
      .join("")
      .trim(),
  );
  let textIndex = 0;
  for (const item of message.content) {
    switch (item.type) {
      case "text": {
        const content = redacted[textIndex]?.trim();
        textIndex += 1;
        if (content)
          rows.push({
            kind: otherAgent
              ? "other_agent"
              : assistantKind(item.textSignature),
            content,
          });
        break;
      }
      case "toolCall":
        if (!isMemoryTool(item)) pending.set(item.id, item);
        break;
      case "thinking":
        break;
      default:
        throw new Error("Unsupported Pi memory Stage 1 content");
    }
  }
}

/** Classify only the validated, settled canonical active branch. */
export function projectPiMemoryStage1Evidence(args: {
  readonly jsonl: string;
  readonly expectedSessionId: string;
}): PiMemoryStage1Evidence[] {
  const session = MemoryPiSession.fromJsonl(args.jsonl);
  if (session.getSessionId() !== args.expectedSessionId) {
    throw new Error("Pi memory Stage 1 source session id mismatch");
  }
  if (!session.isSettledCheckpoint()) {
    throw new Error("Pi memory Stage 1 source is not settled");
  }
  const rows: PiMemoryStage1Evidence[] = [];
  const pending = new Map<string, ToolCall>();
  for (const entry of session.getBranchEntries()) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    switch (message.role) {
      case "user": {
        const content = textFromContent(message.content).trim();
        if (content && !isRuntimeOrMemoryFeedback(content)) {
          rows.push({
            kind: isOtherAgentEnvelope(content) ? "other_agent" : "human",
            content: redactPiMemoryStage1Secrets(content),
          });
        }
        break;
      }
      case "assistant": {
        appendAssistantEvidence(message, rows, pending);
        break;
      }
      case "toolResult": {
        const call = pending.get(message.toolCallId);
        if (!call || call.name !== message.toolName) break;
        pending.delete(message.toolCallId);
        // Pi has no registered paired human-input tool. Arbitrary tool names
        // never promote results. Keep call/question and result atomic at Tool.
        rows.push({
          kind: "tool",
          content: redactPiMemoryStage1Secrets(
            `Tool: ${call.name}\nArguments: ${JSON.stringify(canonicalJson(call.arguments))}\nResult${message.isError ? " (error)" : ""}: ${textFromContent(message.content).trim()}`,
          ),
        });
        break;
      }
      case "bashExecution":
      case "branchSummary":
      case "compactionSummary":
      case "custom":
        break;
      default:
        throw new Error("Unsupported Pi memory Stage 1 message");
    }
  }
  // Pi has no safe Context provenance or audio content type. Runtime context,
  // recalled memory, reasoning and custom records stay excluded, not retagged.
  return boundStage1Evidence(rows);
}

function shapeProviderPayload(
  payload: unknown,
  evidence: readonly PiMemoryStage1Evidence[],
  contextWindow: number,
): unknown {
  // Normalize once so the exact object returned to the SDK is plain JSON.
  const normalized: unknown = JSON.parse(serializeStage1Payload(payload));
  if (
    !isRecord(normalized) ||
    !Array.isArray(normalized.input) ||
    normalized.input.length !== 2 ||
    normalized.max_output_tokens !== PI_MEMORY_STAGE1_OUTPUT_TOKENS ||
    normalized.tools !== undefined
  ) {
    throw new PiMemoryStage1BudgetError("input_payload_unmeasurable");
  }
  const [system, user] = normalized.input;
  if (
    !isRecord(system) ||
    !["system", "developer"].includes(String(system.role)) ||
    system.content !== PI_MEMORY_STAGE1_SYSTEM_PROMPT ||
    !isRecord(user) ||
    user.role !== "user" ||
    !Array.isArray(user.content) ||
    user.content.length !== 1
  ) {
    throw new PiMemoryStage1BudgetError("input_payload_unmeasurable");
  }
  const part: unknown = user.content[0];
  if (
    !isRecord(part) ||
    part.type !== "input_text" ||
    part.text !== renderPiMemoryStage1Input("")
  ) {
    throw new PiMemoryStage1BudgetError("input_payload_unmeasurable");
  }
  const budget = stage1InputBudgets(contextWindow);
  const overhead = stage1TokenCount(serializeStage1Payload(normalized));
  let allowance = budget.request - overhead - 32;
  let historyAllowance = budget.history;
  if (allowance <= 0)
    throw new PiMemoryStage1BudgetError("input_budget_exceeded");
  // Boundary merges in BPE can change additive row counts. Re-select by tier
  // with a smaller budget; never apply a whole-history head/tail truncation.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const history = selectStage1Evidence(evidence, historyAllowance, allowance);
    part.text = renderPiMemoryStage1Input(history);
    const serialized = serializeStage1Payload(normalized);
    const tokens = stage1TokenCount(serialized);
    const historyTokens = stage1TokenCount(history);
    if (tokens <= budget.request && historyTokens <= budget.history)
      return normalized;
    allowance -= Math.max(128, tokens - budget.request);
    historyAllowance -= Math.max(128, historyTokens - budget.history);
  }
  throw new PiMemoryStage1BudgetError("input_budget_exceeded");
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
    readonly evidence: readonly PiMemoryStage1Evidence[];
    readonly requestId: string;
  },
  signal?: AbortSignal,
): Promise<PiMemoryStage1ProviderResult> {
  const model = resolvePiAgentModel(args.model);
  if (!model || model.api !== "openai-responses") {
    throw new PiMemoryStage1ProviderError();
  }
  const context: Context = {
    systemPrompt: PI_MEMORY_STAGE1_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: renderPiMemoryStage1Input(""),
        timestamp: 0,
      },
    ],
    tools: [],
  };
  let budgetError: PiMemoryStage1BudgetError | undefined;
  const message = await consumeAssistantMessage(
    piAgentStreamForConfig(args.model)(model, context, {
      apiKey: args.model.apiKey,
      reasoning: PI_MEMORY_STAGE1_REASONING,
      samplingParams: {
        max_output_tokens: PI_MEMORY_STAGE1_OUTPUT_TOKENS,
        text: {
          format: {
            type: "json_schema",
            name: "pi_memory_stage1",
            strict: true,
            schema: PI_MEMORY_STAGE1_RESPONSE_SCHEMA,
          },
        },
      },
      onPayload: (payload) => {
        try {
          return shapeProviderPayload(
            payload,
            args.evidence,
            model.contextWindow,
          );
        } catch (error) {
          budgetError =
            error instanceof PiMemoryStage1BudgetError
              ? error
              : new PiMemoryStage1BudgetError("input_payload_unmeasurable");
          throw budgetError;
        }
      },
      sessionId: args.requestId,
      signal,
    }),
  );
  // The SDK folds onPayload exceptions into terminal stream messages.
  if (budgetError) throw budgetError;
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
