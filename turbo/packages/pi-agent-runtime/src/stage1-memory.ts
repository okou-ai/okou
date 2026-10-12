import {
  piMemoryStage1TerminalResult,
  type PiMemoryStage1PreparedRequest,
  type PiMemoryStage1ProviderResult,
} from "./stage1-provider";
import {
  preparePiMemoryStage1NativeRequest,
  preparePiMemoryStage1NativePayload,
} from "./stage1-native-request";
import type {
  AssistantMessage,
  Message,
  ToolCall,
} from "@earendil-works/pi-ai";

import { projectPiMemoryCitationSegments } from "@okouai/api-contracts/contracts/pi-memory-citations";

import { piAgentStreamForConfig } from "./model";
import { MemoryPiSession } from "./session-memory";
import type { PiAgentModelConfig } from "./types";

import {
  boundStage1Evidence,
  isRecord,
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
  if (!session.isSettledHistory()) {
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

async function consumeAssistantMessage(
  stream: ReturnType<ReturnType<typeof piAgentStreamForConfig>>,
): Promise<AssistantMessage> {
  for await (const _event of stream) {
    // Stage 1 owns only the terminal structured response.
  }
  return await stream.result();
}

/** Pure complete preparation; API admission receives only the resulting data. */
export function preparePiMemoryStage1Extraction(args: {
  readonly model: PiAgentModelConfig;
  readonly evidence: readonly PiMemoryStage1Evidence[];
  readonly requestId: string;
}): PiMemoryStage1PreparedRequest {
  return {
    model: args.model,
    requestId: args.requestId,
    payload: preparePiMemoryStage1NativePayload(args),
  };
}

export async function runPiMemoryStage1PreparedExtraction(
  prepared: PiMemoryStage1PreparedRequest,
  signal?: AbortSignal,
): Promise<PiMemoryStage1ProviderResult> {
  const plan = preparePiMemoryStage1NativeRequest(prepared.model);
  let preparationError: { readonly error: unknown } | undefined;
  let responseStatus: number | undefined;
  const message = await consumeAssistantMessage(
    piAgentStreamForConfig(prepared.model)(plan.model, plan.context, {
      ...plan.options,
      onObservedResponseStatus: (status) => {
        responseStatus = status;
      },
      // This fixed SDK callback supplies measured data and the existing transport
      // abort check. It receives no caller callback or API graph capability.
      onPayload: () => {
        try {
          signal?.throwIfAborted();
        } catch (error) {
          preparationError = { error };
          throw error;
        }
        return prepared.payload;
      },
      sessionId: prepared.requestId,
      signal,
    }),
  );
  // Preserve the original abort reason after the SDK folds onPayload failures.
  if (preparationError) throw preparationError.error;
  return piMemoryStage1TerminalResult(
    {
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
    },
    {
      stopReason: message.stopReason,
      hasToolCall: message.content.some((item) => {
        return item.type === "toolCall";
      }),
      responseStatus,
    },
  );
}

/** Ordinary runtime callers retain the existing prepare-and-execute operation. */
export async function runPiMemoryStage1Extraction(
  args: {
    readonly model: PiAgentModelConfig;
    readonly evidence: readonly PiMemoryStage1Evidence[];
    readonly requestId: string;
  },
  signal?: AbortSignal,
): Promise<PiMemoryStage1ProviderResult> {
  return await runPiMemoryStage1PreparedExtraction(
    preparePiMemoryStage1Extraction(args),
    signal,
  );
}
