import { command } from "ccstate";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { and, eq } from "drizzle-orm";
import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../../lib/time";
import { advanceTimeAutomationAfterCompletion } from "./time-automation";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import type {
  InternalRunCallbackDispatchResult,
  InternalRunCallbackEnvelope,
  InternalRunCallbackKind,
} from "./internal-run-callback";
import { settleMorningBriefScheduleForRun } from "./morning-brief-schedule-claim.service";
import {
  automationCronCallbackPayloadSchema,
  type AutomationCronCallbackPayload,
  automationLoopCallbackPayloadSchema,
  type AutomationLoopCallbackPayload,
} from "./automation-callback-payload";

const MAX_CONSECUTIVE_FAILURES = 3;

type WorkflowAutomationInternalRunCallbackKind = Extract<
  InternalRunCallbackKind,
  "workflow-automation:cron" | "workflow-automation:loop"
>;

type WorkflowAutomationPayload =
  | { readonly kind: "cron"; readonly data: AutomationCronCallbackPayload }
  | { readonly kind: "loop"; readonly data: AutomationLoopCallbackPayload };

interface HandleWorkflowAutomationInternalCallbackInput {
  readonly kind: WorkflowAutomationInternalRunCallbackKind;
  readonly callback: InternalRunCallbackEnvelope;
}

function parseWorkflowAutomationPayload(
  kind: WorkflowAutomationInternalRunCallbackKind,
  payload: unknown,
): WorkflowAutomationPayload | null {
  switch (kind) {
    case "workflow-automation:cron": {
      const result = automationCronCallbackPayloadSchema.safeParse(payload);
      return result.success ? { kind: "cron", data: result.data } : null;
    }
    case "workflow-automation:loop": {
      const result = automationLoopCallbackPayloadSchema.safeParse(payload);
      return result.success ? { kind: "loop", data: result.data } : null;
    }
  }
}

/**
 * Advance a workflow schedule automation after its run completes: cron advances to
 * the next occurrence from the completion time, loop by its interval; a
 * disabled automation (e.g. a claimed one-time automation) does not recur. Consecutive
 * unexpected failures auto-disable the automation after three. Insufficient
 * credits leave the schedule enabled for its next occurrence. It is keyed on
 * `workflow_automations`.
 */
export async function handleWorkflowAutomationInternalCallback(
  db: Db,
  input: HandleWorkflowAutomationInternalCallbackInput,
  signal?: AbortSignal,
): Promise<InternalRunCallbackDispatchResult> {
  const payload = parseWorkflowAutomationPayload(
    input.kind,
    input.callback.payload,
  );
  if (!payload) {
    return { success: false, error: "Invalid or missing payload" };
  }

  if (input.callback.status === "progress") {
    return { success: true, skipped: true };
  }

  // A journaled occurrence owns its own settlement: the binding committed with
  // the Run itself, so it is authoritative even before the post-return
  // `lastRunId` write, and a duplicate or superseded callback settles nothing.
  const settled = await settleMorningBriefScheduleForRun(db, {
    automationId: payload.data.automationId,
    runId: input.callback.runId,
    settlement: input.callback.status === "completed" ? "completed" : "failed",
    resolveIsCreditError: () => {
      return isInsufficientCreditsRun(db, input.callback);
    },
    settledAt: nowDate(),
  });
  signal?.throwIfAborted();
  if (settled) {
    return { success: true };
  }

  // Historical, manual and every unjournaled legacy execution keeps the exact
  // behavior below. It is deliberately unchanged and carries no journaled
  // protection; S7b removes it once no unjournaled execution can still call
  // back. It never infers an anchor for a run it does not recognize.
  return await db.transaction(async (tx) => {
    // Serialize completion with schedule edits so the entire current schedule
    // remains authoritative until its next run has been written.
    const [automation] = await tx
      .select(workflowAutomationColumns())
      .from(workflowAutomations)
      .where(eq(workflowAutomations.id, payload.data.automationId))
      .limit(1)
      .for("update");
    signal?.throwIfAborted();

    if (
      !automation ||
      !automation.enabled ||
      (automation.scheduleType !== "cron" && automation.scheduleType !== "loop")
    ) {
      // A newly configured one-time schedule keeps its own next run.
      return { success: true, skipped: true };
    }

    const completedAt = nowDate();
    const [failedRun] =
      input.callback.status === "failed"
        ? await tx
            .select({ failureReason: agentRuns.failureReason })
            .from(agentRuns)
            .where(
              and(
                eq(agentRuns.id, input.callback.runId),
                eq(agentRuns.orgId, automation.orgId),
              ),
            )
            .limit(1)
        : [];
    signal?.throwIfAborted();
    const isCreditError = failedRun?.failureReason === "insufficient_credits";
    const consecutiveFailures =
      input.callback.status === "completed"
        ? 0
        : automation.consecutiveFailures + (isCreditError ? 0 : 1);
    const shouldDisable =
      !isCreditError && consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
    const nextRunAt = advanceTimeAutomationAfterCompletion({
      scheduleType: automation.scheduleType,
      cronExpression: automation.cronExpression,
      intervalSeconds: automation.intervalSeconds,
      timezone: automation.timezone,
      completedAt,
      shouldDisable,
    });

    await tx
      .update(workflowAutomations)
      .set({
        consecutiveFailures,
        ...(shouldDisable && { enabled: false }),
        nextRunAt,
        updatedAt: completedAt,
      })
      .where(
        and(
          eq(workflowAutomations.id, payload.data.automationId),
          eq(workflowAutomations.enabled, true),
        ),
      );
    signal?.throwIfAborted();

    return { success: true };
  });
}

/**
 * The failure reason comes from the authoritative Run rather than the callback
 * payload. The caller has already matched this exact Run to its journaled
 * occurrence, which is what authorizes reading it by id alone.
 */
async function isInsufficientCreditsRun(
  db: Db,
  callback: InternalRunCallbackEnvelope,
): Promise<boolean> {
  if (callback.status === "completed") {
    return false;
  }
  const [run] = await db
    .select({ failureReason: agentRuns.failureReason })
    .from(agentRuns)
    .where(eq(agentRuns.id, callback.runId))
    .limit(1);
  return run?.failureReason === "insufficient_credits";
}

export const handleWorkflowAutomationInternalCallback$ = command(
  async (
    { set },
    input: HandleWorkflowAutomationInternalCallbackInput,
    signal: AbortSignal,
  ): Promise<InternalRunCallbackDispatchResult> => {
    return await handleWorkflowAutomationInternalCallback(
      set(writeDb$),
      input,
      signal,
    );
  },
);
