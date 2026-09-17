import { trace } from "@opentelemetry/api";
import type { PiPreparationObserver } from "@okouai/pi-agent-runtime/api";

import { normalizeBuildCommitSha } from "../../lib/build-info";
import { env } from "../../lib/env";
import type { PiPreparationDiscardReason } from "./pi-api-first-turn-preparation";
import { now } from "../../lib/time";
import { recordSandboxOperation } from "../external/sandbox-op-log";

/** The existing sandbox writer owns delivery, including late phase completion. */
export function piPreparationObserver(runId: string): PiPreparationObserver {
  const traceId = trace.getActiveSpan()?.spanContext().traceId;
  return (observation) => {
    const apiCommitSha = normalizeBuildCommitSha(env("GIT_COMMIT_SHA"));
    recordSandboxOperation({
      sandboxType: "runner",
      actionType: `pi_prepare_${observation.phase}`,
      runId,
      timestamp: new Date(observation.finishedAt).toISOString(),
      durationMs: observation.durationMs,
      success: observation.outcome === "success",
      dimensions: {
        started_at: new Date(observation.startedAt).toISOString(),
        finished_at: new Date(observation.finishedAt).toISOString(),
        outcome: observation.outcome,
        span_kind: "nested",
        ...(traceId ? { trace_id: traceId } : {}),
        ...(apiCommitSha ? { api_commit_sha: apiCommitSha } : {}),
      },
    });
  };
}

/** Wall-clock boundaries are correlated with admission and transport, never summed. */
export function recordPiAdmissionPreparation(
  runId: string,
  outcome:
    | "started"
    | "ready"
    | "failed"
    | "adopted"
    | "discarded"
    | "released",
  startedAt: number,
  discardReason?: PiPreparationDiscardReason,
): void {
  const finishedAt = outcome === "started" ? startedAt : now();
  recordSandboxOperation({
    sandboxType: "runner",
    actionType: "pi_admission_preparation",
    runId,
    timestamp: new Date(finishedAt).toISOString(),
    durationMs: finishedAt - startedAt,
    success: outcome !== "failed",
    dimensions: {
      outcome,
      started_at: new Date(startedAt).toISOString(),
      finished_at: new Date(finishedAt).toISOString(),
      span_kind: "overlapping",
      ...(discardReason ? { discard_reason: discardReason } : {}),
    },
  });
}
