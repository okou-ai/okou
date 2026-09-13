import { logger } from "../../lib/log";
import { now, nowDate } from "../../lib/time";
import { waitUntil } from "../context/wait-until";
import { flushAxiom, getDatasetName, ingestToAxiom } from "../external/axiom";
import {
  isLlmConfigured,
  OpenRouterRequestError,
} from "../external/openrouter";
import {
  isTransientProviderFailure,
  openRouterFailureReason,
  openRouterFailureTokenCounts,
  type OpenRouterFailureReason,
  type OpenRouterTokenCounts,
} from "../external/openrouter-failure";
import { onRejection, safeSync, settle } from "../utils";

type AuxiliaryFeature =
  | "chat_title"
  | "shared_thread_title"
  | "chat_activity_summary"
  | "chat_initial_thinking"
  | "run_summary"
  | "recommended_followups"
  | "notification_summary";
type Outcome = "success" | "degraded" | "cancelled" | "error" | "skipped";
type Reason =
  | OpenRouterFailureReason
  | "none"
  | "caller_cancelled"
  | "not_applicable"
  // The provider returned well-formed text the feature itself cannot use.
  | "unusable_output";

/**
 * Provider-outcome detail the generation closure observes and the boundary
 * cannot infer from the returned value. Token counts are integers, so they
 * carry no payload risk while showing how much of the shared thinking-plus-
 * output budget a generation actually spent.
 */
interface AuxiliaryGenerationDetail {
  readonly truncated: boolean;
  readonly tokens: OpenRouterTokenCounts;
}

export type RecordAuxiliaryGenerationDetail = (
  detail: AuxiliaryGenerationDetail,
) => void;

interface AuxiliaryResult {
  readonly feature: AuxiliaryFeature;
  readonly outcome: Outcome;
  readonly reason: Reason;
  readonly tokens: OpenRouterTokenCounts;
  /** Present only when the provider asked for a delay; bounded upstream. */
  readonly retryAfterMs?: number;
  readonly runId?: string;
  readonly startedAt: number;
}

/**
 * A `rate_limited` outcome only justifies waiting when the provider says how
 * long to wait. Nothing consumes this delay yet: record it first so the choice
 * between honoring `Retry-After` and backing off blindly rests on production
 * evidence rather than on the header's assumed presence.
 */
function retryAfterMilliseconds(error: unknown): number | undefined {
  return error instanceof OpenRouterRequestError &&
    error.retryAfterMs !== undefined
    ? Math.trunc(error.retryAfterMs)
    : undefined;
}

/** Reasons the caller can do nothing about: counted, never warned. */
function isDegradedReason(reason: Reason): boolean {
  switch (reason) {
    case "output_truncated":
    case "unexpected_tool_calls": {
      return true;
    }
    case "caller_cancelled":
    case "not_applicable":
    case "none":
    case "unusable_output": {
      return false;
    }
    default: {
      return isTransientProviderFailure(reason);
    }
  }
}

const log = logger("api:auxiliary-generation");

async function deliverResult(result: AuxiliaryResult): Promise<void> {
  const elapsed = now() - result.startedAt;
  const ingested = safeSync(() => {
    return ingestToAxiom(getDatasetName("web-logs"), [
      {
        _time: nowDate().toISOString(),
        type: "auxiliary_generation_result",
        source: "api",
        feature: result.feature,
        outcome: result.outcome,
        reason: result.reason,
        duration_ms: Number.isFinite(elapsed)
          ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, elapsed))
          : 0,
        ...(result.tokens.completionTokens === undefined
          ? {}
          : { completion_tokens: result.tokens.completionTokens }),
        ...(result.tokens.reasoningTokens === undefined
          ? {}
          : { reasoning_tokens: result.tokens.reasoningTokens }),
        ...(result.retryAfterMs === undefined
          ? {}
          : { retry_after_ms: result.retryAfterMs }),
        // One rate-limit window rejects several independent generations at
        // once, so an event count alone overstates how many runs it reached.
        ...(result.runId === undefined ? {} : { run_id: result.runId }),
      },
    ]);
  });
  if ("ok" in ingested && ingested.ok) {
    await flushAxiom({ client: "telemetry" });
  }
}

function recordResult(result: AuxiliaryResult): void {
  // A title/callback may finish after the response's flush. Register its own
  // flush with the same request lifetime; exporter failure is never business failure.
  waitUntil(Promise.allSettled([deliverResult(result)]));
}

/**
 * The finite reason and error kind carry the whole signal. This deliberately
 * reports no source locations: production runs a bundle whose frames are
 * `file:///var/task/index.js:...`, so a first-party stack filter matched
 * nothing there while remaining a standing risk of admitting a provider
 * message or a file path into the diagnostic.
 */
function diagnose(
  feature: AuxiliaryFeature,
  reason: Reason,
  error: unknown,
  context: Readonly<{ runId?: string; threadId?: string }> | undefined,
): void {
  const fields = {
    feature,
    reason,
    ...context,
    errorKind:
      error instanceof OpenRouterRequestError
        ? "openrouter_request"
        : error instanceof TypeError
          ? "type_error"
          : error instanceof SyntaxError
            ? "syntax_error"
            : "unknown",
    ...(error instanceof OpenRouterRequestError
      ? {
          status: error.status,
          errorCode: error.errorCode,
          errorParam: error.errorParam,
          errorType: error.errorType,
          retryAfterMs: error.retryAfterMs,
        }
      : {}),
  };
  log.warn("Auxiliary generation failed", fields);
}

/** Only generation and feature output interpretation belong inside this boundary. */
export async function generateAuxiliary<T>(
  args: {
    readonly feature: AuxiliaryFeature;
    readonly generate: (record: RecordAuxiliaryGenerationDetail) => Promise<T>;
    readonly usable: (value: T) => boolean;
    /**
     * Set by a caller whose empty interpreted result is an omission it already
     * handles: the outcome stays counted in `auxiliary_generation_result` and
     * produces no diagnostic at any level. It describes the interpreted return
     * value only, never a thrown provider error.
     */
    readonly unusableOutput?: "expected";
    readonly diagnosticContext?: Readonly<{
      runId?: string;
      threadId?: string;
    }>;
  },
  signal?: AbortSignal,
): Promise<T | undefined> {
  const startedAt = now();
  const runId = args.diagnosticContext?.runId;
  let detail: AuxiliaryGenerationDetail | undefined;
  const result = await settle(
    onRejection(
      (async () => {
        signal?.throwIfAborted();
        if (!isLlmConfigured()) {
          recordResult({
            feature: args.feature,
            outcome: "skipped",
            reason: "not_applicable",
            tokens: {},
            ...(runId === undefined ? {} : { runId }),
            startedAt,
          });
          return undefined;
        }
        const value = await args.generate((reported) => {
          detail = reported;
        });
        signal?.throwIfAborted();
        const usable = args.usable(value);
        // Truncation classifies first even when the shortened text turns out to
        // be unusable: the token ceiling is the known, non-actionable cause, and
        // reporting it as a defect would restore the noise this replaces.
        const truncated = detail?.truncated === true;
        // A caller that declares its empty result expected keeps the reason and
        // the counted event; only the diagnostic goes away. Truncation still
        // classifies ahead of it, so a usable shortened sibling output stays
        // `output_truncated` rather than being reported as a plain success.
        const outcome = truncated
          ? "degraded"
          : usable
            ? "success"
            : args.unusableOutput === "expected"
              ? "degraded"
              : "error";
        if (outcome === "error") {
          diagnose(
            args.feature,
            "unusable_output",
            undefined,
            args.diagnosticContext,
          );
        }
        recordResult({
          feature: args.feature,
          outcome,
          reason: truncated
            ? "output_truncated"
            : usable
              ? "none"
              : "unusable_output",
          tokens: detail?.tokens ?? {},
          ...(runId === undefined ? {} : { runId }),
          startedAt,
        });
        return value;
      })(),
      (error) => {
        // A late, unrelated rejection must not be reclassified just because the
        // caller has since aborted. Preserve the exact cancellation reason.
        const cancelled = signal?.aborted === true && error === signal.reason;
        const reason = cancelled
          ? "caller_cancelled"
          : openRouterFailureReason(error);
        const outcome = cancelled
          ? "cancelled"
          : isDegradedReason(reason)
            ? "degraded"
            : "error";
        if (outcome === "error") {
          diagnose(args.feature, reason, error, args.diagnosticContext);
        }
        const retryAfterMs = retryAfterMilliseconds(error);
        recordResult({
          feature: args.feature,
          outcome,
          reason,
          tokens: openRouterFailureTokenCounts(error),
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
          ...(runId === undefined ? {} : { runId }),
          startedAt,
        });
      },
    ),
  );
  if (!result.ok) {
    if (signal?.aborted && result.error === signal.reason) {
      throw result.error;
    }
    return undefined;
  }
  return result.value;
}
