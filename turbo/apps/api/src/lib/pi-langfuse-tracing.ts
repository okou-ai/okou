import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";

import {
  elapsedSinceApiStartMs,
  type PiLangfuseParent,
} from "@okouai/api-contracts/contracts/runners";
import type { PiApiFirstTurnResult } from "@okouai/pi-agent-runtime/api";
import {
  type LangfuseGeneration,
  LangfuseOtelSpanAttributes,
  type LangfuseSpan,
  startObservation,
} from "@langfuse/tracing";
import {
  context,
  isSpanContextValid,
  ROOT_CONTEXT,
  TraceFlags,
  type Attributes,
  type SpanContext,
} from "@opentelemetry/api";

import { safeSync, settleIncludingAbort } from "../signals/utils";
import { PI_LANGFUSE_MAX_CAPTURED_CHARS } from "./pi-langfuse-debug";
import { singleton } from "./singleton";

const LANGFUSE_TRACE_NAME = "Pi Agent Run";

function traceTags(): string[] {
  return ["pi", "api-first", "internal-debug"];
}

const PI_LANGFUSE_RUN_END_TO_END_OBSERVATION_NAME = "Run End-to-End";

/** Complete API-side observation set used by the start-time export filter. */
export const PI_LANGFUSE_API_OBSERVATION_NAMES: readonly string[] =
  Object.freeze([
    "API First Turn",
    "API LLM Call",
    "Ownership Transfer",
    PI_LANGFUSE_RUN_END_TO_END_OBSERVATION_NAME,
  ]);

export interface PiApiFirstTurnTraceContext {
  readonly rootSpanContext: SpanContext;
  readonly runId: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly end: (error?: unknown) => void;
}

export interface PiApiFirstTurnTraceResult {
  readonly result: PiApiFirstTurnResult;
  readonly traceContext?: PiApiFirstTurnTraceContext;
}

interface PiLangfuseOwnershipTransfer {
  readonly parent: PiLangfuseParent;
  readonly end: (error?: unknown) => void;
}

interface PiApiFirstTurnTraceArgs {
  readonly enabled: boolean;
  readonly runId: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly prompt: string;
  readonly model: string;
  readonly provider: string;
  readonly execute: () => Promise<PiApiFirstTurnResult>;
}

interface PiRunEndToEndTraceArgs {
  readonly enabled: boolean;
  readonly runId: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly apiStartedAt: number | undefined;
  readonly terminalCommittedAt: number;
  readonly terminalStatus: "completed" | "failed";
}

export function normalizePiLangfuseTraceId(runId: string): string | undefined {
  const traceId = runId.replaceAll("-", "").toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(traceId) || /^0+$/.test(traceId)) {
    return undefined;
  }
  return traceId;
}

function randomHexId(bytes: number): string {
  let id = randomBytes(bytes).toString("hex");
  while (/^0+$/.test(id)) {
    id = randomBytes(bytes).toString("hex");
  }
  return id;
}

interface ForcedPiLangfuseIds {
  readonly traceId: string;
  readonly spanId: string;
}

const forcedPiLangfuseIds = singleton(() => {
  return new AsyncLocalStorage<ForcedPiLangfuseIds>();
});

/**
 * Preserve normal OpenTelemetry randomness while allowing the retrospective
 * run root to reuse the parent ID published before Sandbox ownership transfer.
 */
export const piLangfuseIdGenerator = Object.freeze({
  generateTraceId(): string {
    return forcedPiLangfuseIds.peek()?.getStore()?.traceId ?? randomHexId(16);
  },
  generateSpanId(): string {
    return forcedPiLangfuseIds.peek()?.getStore()?.spanId ?? randomHexId(8);
  },
});

function runEndToEndSpanId(traceId: string): string {
  const digest = createHash("sha256")
    .update(`vm0.pi.run-end-to-end:${traceId}`)
    .digest("hex");
  for (let offset = 0; offset <= digest.length - 16; offset += 16) {
    const spanId = digest.slice(offset, offset + 16);
    if (!/^0+$/.test(spanId)) {
      return spanId;
    }
  }
  return "0000000000000001";
}

function runEndToEndSpanContext(traceId: string): SpanContext {
  return {
    traceId,
    spanId: runEndToEndSpanId(traceId),
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  };
}

function traceAttributes(args: {
  readonly sessionId: string;
  readonly userId: string;
}): Attributes {
  return {
    [LangfuseOtelSpanAttributes.TRACE_NAME]: LANGFUSE_TRACE_NAME,
    [LangfuseOtelSpanAttributes.TRACE_SESSION_ID]: args.sessionId,
    [LangfuseOtelSpanAttributes.TRACE_USER_ID]: args.userId,
    [LangfuseOtelSpanAttributes.TRACE_TAGS]: traceTags(),
  };
}

function stampObservation(
  observation: LangfuseSpan | LangfuseGeneration,
  args: {
    readonly sessionId: string;
    readonly userId: string;
    readonly attributes: Attributes;
  },
): void {
  observation.otelSpan.setAttributes({
    ...traceAttributes(args),
    "vm0.pi.telemetry.schema_version": 1,
    ...args.attributes,
  });
}

export function recordPiLangfuseRunEndToEnd(
  args: PiRunEndToEndTraceArgs,
): void {
  const traceId = normalizePiLangfuseTraceId(args.runId);
  const durationMs = elapsedSinceApiStartMs(
    args.apiStartedAt,
    args.terminalCommittedAt,
  );
  if (
    !args.enabled ||
    !traceId ||
    durationMs === undefined ||
    !Number.isInteger(args.terminalCommittedAt) ||
    args.apiStartedAt === undefined ||
    args.terminalCommittedAt < args.apiStartedAt
  ) {
    return;
  }

  const apiStartedAt = new Date(args.apiStartedAt);
  const terminalCommittedAt = new Date(args.terminalCommittedAt);
  const rootSpanContext = runEndToEndSpanContext(traceId);
  const started = safeSync(() => {
    return context.with(ROOT_CONTEXT, () => {
      return forcedPiLangfuseIds().run(rootSpanContext, () => {
        return startObservation(
          PI_LANGFUSE_RUN_END_TO_END_OBSERVATION_NAME,
          {
            level: args.terminalStatus === "failed" ? "ERROR" : undefined,
            metadata: {
              source: "vm0-api",
              run_id: args.runId,
              api_started_at: apiStartedAt.toISOString(),
              terminal_committed_at: terminalCommittedAt.toISOString(),
              duration_ms: durationMs,
              terminal_status: args.terminalStatus,
              content_capture: "metadata-only",
            },
          },
          {
            asType: "span",
            startTime: apiStartedAt,
          },
        );
      });
    });
  });
  if ("error" in started) {
    return;
  }

  const observation = started.ok;
  safeSync(() => {
    stampObservation(observation, {
      sessionId: args.sessionId,
      userId: args.userId,
      attributes: {
        "vm0.pi.run_id": args.runId,
        "vm0.pi.phase": "run-end-to-end",
        "vm0.pi.langfuse_debug": true,
        "vm0.pi.e2e.duration_ms": durationMs,
        "vm0.pi.terminal_committed_at": terminalCommittedAt.toISOString(),
      },
    });
  });
  safeSync(() => {
    observation.end(terminalCommittedAt);
  });
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

const LANGFUSE_KEY_TOKEN = /\b[sp]k-lf-[\w-]+\b/g;
const CAPTURE_REDACTION_MARK = "[redacted-langfuse-secret]";

interface PiLangfuseTextMeta {
  readonly truncated: boolean;
  readonly orig_len: number;
  readonly kept_len?: number;
  readonly sha256?: string;
}

interface PiLangfuseTextCapture {
  readonly text: string;
  readonly meta: PiLangfuseTextMeta;
}

/** Mirror the official plugin's text shape and limit before shared export. */
function capturePiLangfuseText(text: string): PiLangfuseTextCapture {
  const redacted = text.replace(LANGFUSE_KEY_TOKEN, CAPTURE_REDACTION_MARK);
  if (text.length <= PI_LANGFUSE_MAX_CAPTURED_CHARS) {
    return {
      text: redacted,
      meta: { truncated: false, orig_len: text.length },
    };
  }
  const captured = redacted.slice(0, PI_LANGFUSE_MAX_CAPTURED_CHARS);
  return {
    text: captured,
    meta: {
      truncated: true,
      orig_len: text.length,
      kept_len: captured.length,
      sha256: createHash("sha256").update(text).digest("hex"),
    },
  };
}

function assistantGenerationOutput(result: PiApiFirstTurnResult): {
  readonly value: unknown;
  readonly textMeta: PiLangfuseTextMeta;
  readonly toolCount: number;
} {
  const text = result.assistantMessage.content
    .flatMap((content) => {
      return content.type === "text" ? [content.text] : [];
    })
    .join("");
  const capturedText = capturePiLangfuseText(text);
  const toolCalls = result.assistantMessage.content.flatMap((content) => {
    return content.type === "toolCall"
      ? [
          {
            id: capturePiLangfuseText(content.id).text,
            name: capturePiLangfuseText(content.name).text,
          },
        ]
      : [];
  });
  return {
    value: {
      role: "assistant",
      ...(capturedText.text ? { content: capturedText.text } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    },
    textMeta: capturedText.meta,
    toolCount: toolCalls.length,
  };
}

function assistantTextLength(result: PiApiFirstTurnResult): number {
  return result.assistantMessage.content.reduce((length, content) => {
    return content.type === "text" ? length + content.text.length : length;
  }, 0);
}

function usageDetails(
  result: PiApiFirstTurnResult,
): Record<string, number> | undefined {
  const usage = result.assistantMessage.usage;
  const details = {
    ...(usage.input > 0 ? { input: usage.input } : {}),
    ...(usage.output > 0 ? { output: usage.output } : {}),
    ...(usage.cacheRead > 0
      ? { cache_read_input_tokens: usage.cacheRead }
      : {}),
    ...(usage.cacheWrite > 0
      ? { cache_creation_input_tokens: usage.cacheWrite }
      : {}),
  };
  return Object.keys(details).length > 0 ? details : undefined;
}

function safeEnd(observation: LangfuseSpan | LangfuseGeneration): void {
  safeSync(() => {
    observation.end();
  });
}

function startApiTrace(
  args: PiApiFirstTurnTraceArgs,
): LangfuseSpan | undefined {
  const traceId = normalizePiLangfuseTraceId(args.runId);
  if (!args.enabled || !traceId) {
    return undefined;
  }

  let root: LangfuseSpan | undefined;
  const started = safeSync(() => {
    root = startObservation(
      "API First Turn",
      {
        metadata: {
          source: "vm0-api",
          run_id: args.runId,
          session_id: args.sessionId,
          prompt_chars: args.prompt.length,
          content_capture: "metadata-only",
        },
      },
      {
        asType: "span",
        parentSpanContext: runEndToEndSpanContext(traceId),
      },
    );
    stampObservation(root, {
      sessionId: args.sessionId,
      userId: args.userId,
      attributes: {
        "vm0.pi.run_id": args.runId,
        "vm0.pi.phase": "api-first",
        "vm0.pi.langfuse_debug": true,
      },
    });
    return root;
  });
  if ("ok" in started) {
    return started.ok;
  }
  if (root) {
    safeEnd(root);
  }
  return undefined;
}

function startGeneration(
  root: LangfuseSpan,
  args: PiApiFirstTurnTraceArgs,
): LangfuseGeneration | undefined {
  let generation: LangfuseGeneration | undefined;
  const started = safeSync(() => {
    const input = capturePiLangfuseText(args.prompt);
    generation = root.startObservation(
      "API LLM Call",
      {
        input: { role: "user", content: input.text },
        model: args.model,
        metadata: {
          provider: args.provider,
          prompt_chars: args.prompt.length,
          user_text_meta: input.meta,
          content_capture: "official-plugin-parity",
        },
      },
      { asType: "generation" },
    );
    stampObservation(generation, {
      sessionId: args.sessionId,
      userId: args.userId,
      attributes: {
        "vm0.pi.run_id": args.runId,
        "vm0.pi.phase": "api-first-generation",
        "vm0.pi.langfuse_debug": true,
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": args.provider,
        "gen_ai.request.model": args.model,
      },
    });
    return generation;
  });
  if ("ok" in started) {
    return started.ok;
  }
  if (generation) {
    safeEnd(generation);
  }
  return undefined;
}

function updateGeneration(
  generation: LangfuseGeneration | undefined,
  result: PiApiFirstTurnResult,
): void {
  if (!generation) {
    return;
  }
  safeSync(() => {
    const stopReason = result.assistantMessage.stopReason;
    const output = assistantGenerationOutput(result);
    generation.update({
      output: output.value,
      usageDetails: usageDetails(result),
      level:
        stopReason === "error" || stopReason === "aborted"
          ? "ERROR"
          : undefined,
      statusMessage:
        stopReason === "error" || stopReason === "aborted"
          ? `Pi provider result: ${stopReason}`
          : undefined,
      metadata: {
        stop_reason: stopReason,
        response_id_present: Boolean(result.assistantMessage.responseId),
        assistant_text_chars: assistantTextLength(result),
        assistant_content_blocks: result.assistantMessage.content.length,
        handoff_required: result.handoffRequired,
        assistant_text_meta: output.textMeta,
        tool_count: output.toolCount,
        content_capture: "official-plugin-parity",
      },
    });
  });
}

function sampledSpanContext(
  observation: LangfuseSpan | LangfuseGeneration,
): SpanContext | undefined {
  const context = observation.otelSpan.spanContext();
  if (
    !isSpanContextValid(context) ||
    !(context.traceFlags & TraceFlags.SAMPLED)
  ) {
    return undefined;
  }
  return context;
}

function createApiFirstTurnTraceContext(args: {
  readonly root: LangfuseSpan;
  readonly rootSpanContext: SpanContext;
  readonly runId: string;
  readonly sessionId: string;
  readonly userId: string;
}): PiApiFirstTurnTraceContext {
  let ended = false;
  return {
    rootSpanContext: args.rootSpanContext,
    runId: args.runId,
    sessionId: args.sessionId,
    userId: args.userId,
    end(error?: unknown): void {
      if (ended) {
        return;
      }
      ended = true;
      if (error !== undefined) {
        safeSync(() => {
          args.root.update({
            level: "ERROR",
            statusMessage: `Pi API first turn failed after provider response: ${errorName(error)}`,
            metadata: { post_provider_error_name: errorName(error) },
          });
        });
      }
      safeEnd(args.root);
    },
  };
}

/**
 * Start the real transfer observation only after the API commit decides that
 * Sandbox will own the run. The observation remains open while H1 is
 * published, so a failed publication cannot look like a successful handoff.
 */
export function startPiLangfuseOwnershipTransfer(
  traceContext: PiApiFirstTurnTraceContext | undefined,
): PiLangfuseOwnershipTransfer | undefined {
  if (!traceContext) {
    return undefined;
  }

  let ownership: LangfuseSpan | undefined;
  const started = safeSync(() => {
    ownership = startObservation(
      "Ownership Transfer",
      {
        metadata: {
          source: "vm0-api",
          run_id: traceContext.runId,
          target: "sandbox",
        },
      },
      {
        asType: "span",
        parentSpanContext: traceContext.rootSpanContext,
      },
    );
    stampObservation(ownership, {
      sessionId: traceContext.sessionId,
      userId: traceContext.userId,
      attributes: {
        "vm0.pi.run_id": traceContext.runId,
        "vm0.pi.phase": "ownership-transfer",
        "vm0.pi.langfuse_debug": true,
      },
    });
    return ownership;
  });
  if ("error" in started) {
    if (ownership) {
      safeEnd(ownership);
    }
    return undefined;
  }

  const context = sampledSpanContext(started.ok);
  if (!context) {
    safeEnd(started.ok);
    return undefined;
  }

  let ended = false;
  const observation = started.ok;
  return {
    parent: {
      traceId: context.traceId,
      spanId: context.spanId,
      traceFlags: 1,
      sessionId: traceContext.sessionId,
    },
    end(error?: unknown): void {
      if (ended) {
        return;
      }
      ended = true;
      safeSync(() => {
        observation.update(
          error === undefined
            ? { metadata: { publication: "published" } }
            : {
                level: "ERROR",
                statusMessage: `Pi ownership transfer failed: ${errorName(error)}`,
                metadata: {
                  publication: "failed",
                  error_name: errorName(error),
                },
              },
        );
      });
      safeEnd(observation);
    },
  };
}

async function executeTraceOperation(
  execute: () => Promise<PiApiFirstTurnResult>,
): Promise<PiApiFirstTurnResult> {
  return await execute();
}

function updateApiTraceResult(
  root: LangfuseSpan,
  result: PiApiFirstTurnResult,
): void {
  safeSync(() => {
    root.update({
      level:
        result.assistantMessage.stopReason === "error" ||
        result.assistantMessage.stopReason === "aborted"
          ? "ERROR"
          : undefined,
      metadata: {
        stop_reason: result.assistantMessage.stopReason,
        handoff_required: result.handoffRequired,
        assistant_text_chars: assistantTextLength(result),
        content_capture: "metadata-only",
      },
    });
  });
}

function updateApiTraceFailure(
  root: LangfuseSpan,
  generation: LangfuseGeneration | undefined,
  error: unknown,
): void {
  safeSync(() => {
    generation?.update({
      level: "ERROR",
      statusMessage: `Pi provider exception: ${errorName(error)}`,
      metadata: { error_name: errorName(error) },
    });
    root.update({
      level: "ERROR",
      statusMessage: `Pi API first turn failed: ${errorName(error)}`,
      metadata: { error_name: errorName(error) },
    });
  });
}

/**
 * Trace one API-first provider turn without changing ownership or error
 * semantics. API generation input/output mirrors the official Pi plugin's
 * bounded user/assistant projection and intentionally travels through the
 * shared global provider to both Axiom and Langfuse. Ancestor and terminal
 * observations remain metadata-only.
 */
export async function tracePiApiFirstTurn(
  args: PiApiFirstTurnTraceArgs,
): Promise<PiApiFirstTurnTraceResult> {
  const root = startApiTrace(args);
  if (!root) {
    return { result: await args.execute() };
  }

  const generation = startGeneration(root, args);
  const executed = await settleIncludingAbort(
    executeTraceOperation(args.execute),
  );
  if (!executed.ok) {
    updateApiTraceFailure(root, generation, executed.error);
    if (generation) {
      safeEnd(generation);
    }
    safeEnd(root);
    throw executed.error;
  }

  const result = executed.value;
  updateGeneration(generation, result);
  updateApiTraceResult(root, result);
  if (generation) {
    safeEnd(generation);
  }

  const rootSpanContext = sampledSpanContext(root);
  if (!rootSpanContext) {
    safeEnd(root);
    return { result };
  }
  return {
    result,
    traceContext: createApiFirstTurnTraceContext({
      root,
      rootSpanContext,
      runId: args.runId,
      sessionId: args.sessionId,
      userId: args.userId,
    }),
  };
}
