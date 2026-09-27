import { performance } from "node:perf_hooks";

import { normalizeBuildCommitSha } from "../../lib/build-info";
import { env } from "../../lib/env";
import { now } from "../../lib/time";
import { recordApiOperationTimings } from "../external/sandbox-op-log";
import { onRejection, settleIncludingAbort } from "../utils";
import type {
  ApiDispatchTimingActionType,
  ApiDispatchTimingCollector,
  ApiDispatchTimingDimensionsInput,
} from "./api-dispatch-timing.service";

export type WorkflowAdmissionSchedulePath =
  | "non_schedule"
  | "unjournaled_schedule"
  | "journaled_schedule";

export type WorkflowAdmissionOutcome =
  | "inserted"
  | "coalesced"
  | "superseded"
  | "untracked_pending"
  | "failed";

type AdmissionTimingRecorder = Pick<
  ApiDispatchTimingCollector,
  "recordDuration"
>;

/** Instrumentation must never replace the result or error of a durable write. */
export async function recordWorkflowAdmissionDuration(
  timing: AdmissionTimingRecorder | undefined,
  actionType: ApiDispatchTimingActionType,
  durationMs: number,
  dimensions?: ApiDispatchTimingDimensionsInput,
): Promise<void> {
  await settleIncludingAbort(() => {
    timing?.recordDuration(actionType, "nested", durationMs, now(), dimensions);
  });
}

export async function measureWorkflowAdmissionStep<T>(
  timing: AdmissionTimingRecorder | undefined,
  actionType: ApiDispatchTimingActionType,
  operation: () => Promise<T>,
  dimensions?: ApiDispatchTimingDimensionsInput,
): Promise<T> {
  if (!timing) {
    return await operation();
  }
  const startedAt = performance.now();
  return await operation().finally(async () => {
    await recordWorkflowAdmissionDuration(
      timing,
      actionType,
      performance.now() - startedAt,
      dimensions,
    );
  });
}

/** Preserve the admission result and count exactly one terminal attempt, even on abort. */
export async function censusWorkflowAdmission<T>(
  schedulePath: WorkflowAdmissionSchedulePath,
  operation: Promise<T>,
  outcomeOf: (result: T) => WorkflowAdmissionOutcome,
): Promise<T> {
  const result = await onRejection(operation, async () => {
    await recordWorkflowAdmissionAttempt(schedulePath, "failed");
  });
  await recordWorkflowAdmissionAttempt(schedulePath, outcomeOf(result));
  return result;
}

/** One content-free census event per attempt, including work that has no Run. */
export async function recordWorkflowAdmissionAttempt(
  schedulePath: WorkflowAdmissionSchedulePath,
  outcome: WorkflowAdmissionOutcome,
): Promise<void> {
  // Includes AbortError from the telemetry client, not from the admission.
  await settleIncludingAbort(() => {
    const apiCommitSha = normalizeBuildCommitSha(env("GIT_COMMIT_SHA"));
    recordApiOperationTimings([
      {
        actionType: "api_dispatch_workflow_admission_attempt",
        durationMs: 0,
        success: outcome !== "failed",
        dimensions: {
          schedule_path: schedulePath,
          admission_outcome: outcome,
          ...(apiCommitSha ? { api_commit_sha: apiCommitSha } : {}),
        },
      },
    ]);
  });
}
