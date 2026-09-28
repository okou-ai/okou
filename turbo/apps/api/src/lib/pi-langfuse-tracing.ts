import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";

import { elapsedSinceApiStartMs } from "@okouai/api-contracts/contracts/runners";
import {
  LangfuseOtelSpanAttributes,
  type LangfuseSpan,
  startObservation,
} from "@langfuse/tracing";
import {
  context,
  ROOT_CONTEXT,
  TraceFlags,
  type Attributes,
  type SpanContext,
} from "@opentelemetry/api";

import { safeSync } from "../signals/utils";
import { singleton } from "./singleton";

const LANGFUSE_TRACE_NAME = "Pi Agent Run";
const PI_LANGFUSE_API_INSTRUMENTATION_SOURCE = "vm0-api-custom";

function traceTags(): string[] {
  return ["pi", "internal-debug"];
}

const PI_LANGFUSE_RUN_END_TO_END_OBSERVATION_NAME = "Run End-to-End";

/** Complete API-side observation set used by the start-time export filter. */
export const PI_LANGFUSE_API_OBSERVATION_NAMES: readonly string[] =
  Object.freeze([PI_LANGFUSE_RUN_END_TO_END_OBSERVATION_NAME]);

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
  observation: LangfuseSpan,
  args: {
    readonly sessionId: string;
    readonly userId: string;
    readonly attributes: Attributes;
  },
): void {
  observation.otelSpan.setAttributes({
    ...traceAttributes(args),
    "vm0.pi.telemetry.schema_version": 1,
    "vm0.pi.instrumentation_source": PI_LANGFUSE_API_INSTRUMENTATION_SOURCE,
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
              instrumentation_source: PI_LANGFUSE_API_INSTRUMENTATION_SOURCE,
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
