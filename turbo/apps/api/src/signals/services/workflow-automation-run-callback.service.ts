import { advanceInFlightSchedule } from "./workflow-schedule-settlement";
import { command } from "ccstate";
import { MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { and, eq } from "drizzle-orm";
import { writeDb$ } from "../external/db";
import { nowDate } from "../../lib/time";
import { advanceTimeAutomationAfterCompletion } from "./time-automation";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import type {
  InternalRunCallbackDispatchResult,
  InternalRunCallbackEnvelope,
  InternalRunCallbackKind,
} from "./internal-run-callback";
import { settleMorningBriefScheduleForRun$ } from "./morning-brief-schedule-claim.service";
import {
  automationCronCallbackPayloadSchema,
  type AutomationCronCallbackPayload,
  automationLoopCallbackPayloadSchema,
  type AutomationLoopCallbackPayload,
} from "./automation-callback-payload";

const MAX_CONSECUTIVE_FAILURES = 3;
interface MorningBriefCallbackLineage {
  readonly orgId: string;
  readonly userId: string;
  readonly workflowId: string;
  readonly automationId: string;
}

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

interface MorningBriefCallbackLineageCandidate {
  readonly orgId: string;
  readonly ownerUserId: string | null;
  readonly workflowId: string;
  readonly officialBlueprintKey: string | null;
}

function morningBriefCallbackLineage(
  automationId: string,
  candidate: MorningBriefCallbackLineageCandidate | undefined,
): MorningBriefCallbackLineage | undefined {
  return candidate?.officialBlueprintKey ===
    MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY && candidate.ownerUserId !== null
    ? {
        orgId: candidate.orgId,
        userId: candidate.ownerUserId,
        workflowId: candidate.workflowId,
        automationId,
      }
    : undefined;
}

function sameMorningBriefCallbackLineage(
  left: MorningBriefCallbackLineage,
  right: MorningBriefCallbackLineage,
): boolean {
  return (
    left.orgId === right.orgId &&
    left.userId === right.userId &&
    left.workflowId === right.workflowId &&
    left.automationId === right.automationId
  );
}

type UnjournaledCallbackSettlementAttempt =
  | {
      readonly kind: "settled";
      readonly result: InternalRunCallbackDispatchResult;
    }
  | {
      readonly kind: "retry-selected";
      readonly lineage: MorningBriefCallbackLineage;
    };

type UnjournaledRecurringAutomation =
  typeof workflowAutomations.$inferSelect & {
    readonly scheduleType: "cron" | "loop";
  };

type UnjournaledCallbackLineageRevalidation =
  | UnjournaledCallbackSettlementAttempt
  | {
      readonly kind: "continue";
      readonly automation: UnjournaledRecurringAutomation;
    };

function isUnjournaledRecurringAutomation(
  automation: typeof workflowAutomations.$inferSelect | undefined,
): automation is UnjournaledRecurringAutomation {
  return (
    automation !== undefined &&
    automation.enabled &&
    (automation.scheduleType === "cron" || automation.scheduleType === "loop")
  );
}

function skippedUnjournaledCallbackSettlement(): UnjournaledCallbackSettlementAttempt {
  return {
    kind: "settled",
    result: { success: true, skipped: true },
  };
}

function revalidateUnjournaledCallbackLineage(args: {
  readonly automationId: string;
  readonly lineage: MorningBriefCallbackLineage | undefined;
  readonly automation: typeof workflowAutomations.$inferSelect | undefined;
}): UnjournaledCallbackLineageRevalidation {
  const lockedLineage = morningBriefCallbackLineage(
    args.automationId,
    args.automation,
  );
  if (args.lineage === undefined && lockedLineage !== undefined) {
    // The optimistic ordinary/absent read became a Morning Brief row before
    // this read. Release this transaction and retry from Official identity;
    // never publish a successor on a stale identity.
    return { kind: "retry-selected", lineage: lockedLineage };
  }
  if (
    args.lineage !== undefined &&
    (lockedLineage === undefined ||
      !sameMorningBriefCallbackLineage(args.lineage, lockedLineage))
  ) {
    return skippedUnjournaledCallbackSettlement();
  }
  if (!isUnjournaledRecurringAutomation(args.automation)) {
    return skippedUnjournaledCallbackSettlement();
  }
  if (args.lineage !== undefined && args.automation.nextRunAt !== null) {
    // A pre-journal Morning Brief callback owns only the empty slot. A
    // toggle or a writer that already published a successor wins unchanged.
    return skippedUnjournaledCallbackSettlement();
  }
  return { kind: "continue", automation: args.automation };
}

interface WorkflowCallbackSettlementInput {
  readonly automationId: string;
  readonly callback: InternalRunCallbackEnvelope;
  readonly lineage: MorningBriefCallbackLineage | undefined;
}

/** Settle pre-journal callbacks under the Official empty-slot fence; ordinary recurrences retain their existing contract. */
const attemptUnjournaledWorkflowAutomationCallbackSettlement$ = command(
  async (
    { set },
    args: WorkflowCallbackSettlementInput,
    signal?: AbortSignal,
  ): Promise<UnjournaledCallbackSettlementAttempt> => {
    const db = set(writeDb$);
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0332; new non-billing transactions are prohibited.
    const result = await db.transaction(async (tx) => {
      const [snapshot] = await tx
        .select(workflowAutomationColumns())
        .from(workflowAutomations)
        .where(eq(workflowAutomations.id, args.automationId))
        .limit(1);
      const revalidation = revalidateUnjournaledCallbackLineage({
        automationId: args.automationId,
        lineage: args.lineage,
        automation: snapshot,
      });
      if (revalidation.kind !== "continue") {
        return revalidation;
      }
      const automation = revalidation.automation;
      const completedAt = nowDate();
      let isCreditError = false;
      if (args.callback.status === "failed") {
        const [run] = await tx
          .select({ failureReason: agentRuns.failureReason })
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.id, args.callback.runId),
              eq(agentRuns.orgId, automation.orgId),
            ),
          )
          .limit(1);
        isCreditError = run?.failureReason === "insufficient_credits";
      }
      const nextRunAt = advanceTimeAutomationAfterCompletion({
        scheduleType: automation.scheduleType,
        cronExpression: automation.cronExpression,
        intervalSeconds: automation.intervalSeconds,
        timezone: automation.timezone,
        completedAt,
        shouldDisable: false,
      });
      const advanced = await advanceInFlightSchedule(tx, {
        automationId: args.automationId,
        read: automation,
        automationValues: {
          consecutiveFailures: 0,
          nextRunAt,
          updatedAt: completedAt,
        },
        ordinaryFailure: {
          reset: args.callback.status === "completed",
          increment:
            args.callback.status === "failed" && !isCreditError ? 1 : 0,
          disableAt: MAX_CONSECUTIVE_FAILURES,
        },
        at: completedAt,
        // A Morning Brief compatibility callback owns only the empty slot; an
        // ordinary recurrence keeps its pre-existing enabled-only predicate.
        requireEmptySlot: args.lineage !== undefined,
        requireUnjournaledSlot: args.lineage !== undefined,
      });
      signal?.throwIfAborted();
      return advanced === "advanced"
        ? ({ kind: "settled", result: { success: true } } as const)
        : skippedUnjournaledCallbackSettlement();
    });
    signal?.throwIfAborted();
    return result;
  },
);

const settleUnjournaledWorkflowAutomationCallback$ = command(
  async (
    { set },
    args: WorkflowCallbackSettlementInput,
    signal?: AbortSignal,
  ): Promise<InternalRunCallbackDispatchResult> => {
    const first = await set(
      attemptUnjournaledWorkflowAutomationCallbackSettlement$,
      args,
      signal,
    );
    if (first.kind === "settled") {
      return first.result;
    }
    const retried = await set(
      attemptUnjournaledWorkflowAutomationCallbackSettlement$,
      { ...args, lineage: first.lineage },
      signal,
    );
    return retried.kind === "settled"
      ? retried.result
      : { success: true, skipped: true };
  },
);

/** Complete the exact journaled occurrence, or preserve the ordinary recurrence contract. */
export const handleWorkflowAutomationInternalCallback$ = command(
  async (
    { set },
    input: HandleWorkflowAutomationInternalCallbackInput,
    signal: AbortSignal,
  ): Promise<InternalRunCallbackDispatchResult> => {
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
    const settled = await set(
      settleMorningBriefScheduleForRun$,
      {
        automationId: payload.data.automationId,
        runId: input.callback.runId,
        settlement:
          input.callback.status === "completed" ? "completed" : "failed",
      },
      signal,
    );
    if (settled) {
      return { success: true };
    }
    const db = set(writeDb$);
    const [candidate] = await db
      .select({
        orgId: workflowAutomations.orgId,
        ownerUserId: workflowAutomations.ownerUserId,
        workflowId: workflowAutomations.workflowId,
        officialBlueprintKey: workflowAutomations.officialBlueprintKey,
      })
      .from(workflowAutomations)
      .where(eq(workflowAutomations.id, payload.data.automationId))
      .limit(1);
    signal.throwIfAborted();
    return await set(
      settleUnjournaledWorkflowAutomationCallback$,
      {
        automationId: payload.data.automationId,
        callback: input.callback,
        lineage: morningBriefCallbackLineage(
          payload.data.automationId,
          candidate,
        ),
      },
      signal,
    );
  },
);
