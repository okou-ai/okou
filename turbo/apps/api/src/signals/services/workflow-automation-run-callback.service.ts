import { command } from "ccstate";
import { MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { and, eq } from "drizzle-orm";
import { writeDb$, type Db } from "../external/db";
import type { Tx } from "../../lib/db-types";
import { testOverride } from "../../lib/singleton";
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
  lockMorningBriefLegacyWriterAuthority,
  settleSelectedLegacyMorningBriefObligation,
  type MorningBriefLegacyLineage,
  type MorningBriefLegacyWriterAuthority,
} from "./morning-brief-native-schedule.service";
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

interface UnjournaledCallbackLineageReadSnapshot {
  readonly automationId: string;
  readonly lineageKind: "morning-brief" | "ordinary-or-absent";
}

type UnjournaledCallbackLineageReadHook = (
  snapshot: UnjournaledCallbackLineageReadSnapshot,
) => Promise<void>;

const unjournaledCallbackLineageReadHook = testOverride<
  UnjournaledCallbackLineageReadHook | undefined
>(() => {
  return undefined;
});

export function setUnjournaledCallbackLineageReadHookForTest(
  hook: UnjournaledCallbackLineageReadHook,
): void {
  unjournaledCallbackLineageReadHook.set(hook);
}

export function clearUnjournaledCallbackLineageReadHookForTest(): void {
  unjournaledCallbackLineageReadHook.clear();
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
): MorningBriefLegacyLineage | undefined {
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

async function resolveMorningBriefCallbackLineage(
  db: Pick<Db, "select">,
  automationId: string,
): Promise<MorningBriefLegacyLineage | undefined> {
  const [candidate] = await db
    .select({
      orgId: workflowAutomations.orgId,
      ownerUserId: workflowAutomations.ownerUserId,
      workflowId: workflowAutomations.workflowId,
      officialBlueprintKey: workflowAutomations.officialBlueprintKey,
    })
    .from(workflowAutomations)
    .where(eq(workflowAutomations.id, automationId))
    .limit(1);
  return morningBriefCallbackLineage(automationId, candidate);
}

function sameMorningBriefCallbackLineage(
  left: MorningBriefLegacyLineage,
  right: MorningBriefLegacyLineage,
): boolean {
  return (
    left.orgId === right.orgId &&
    left.userId === right.userId &&
    left.workflowId === right.workflowId &&
    left.automationId === right.automationId
  );
}

async function callbackFailedForCredits(
  tx: Tx,
  callback: InternalRunCallbackEnvelope,
  orgId: string,
): Promise<boolean> {
  if (callback.status !== "failed") {
    return false;
  }
  const [run] = await tx
    .select({ failureReason: agentRuns.failureReason })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, callback.runId), eq(agentRuns.orgId, orgId)))
    .limit(1);
  return run?.failureReason === "insufficient_credits";
}

type UnjournaledCallbackSettlementAttempt =
  | {
      readonly kind: "settled";
      readonly result: InternalRunCallbackDispatchResult;
    }
  | {
      readonly kind: "retry-selected";
      readonly lineage: MorningBriefLegacyLineage;
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
  readonly lineage: MorningBriefLegacyLineage | undefined;
  readonly authority: MorningBriefLegacyWriterAuthority;
  readonly automation: typeof workflowAutomations.$inferSelect | undefined;
}): UnjournaledCallbackLineageRevalidation {
  const lockedLineage = morningBriefCallbackLineage(
    args.automationId,
    args.automation,
  );
  if (args.lineage === undefined && lockedLineage !== undefined) {
    // The optimistic ordinary/absent read became a Morning Brief row before
    // this lock. Release this transaction and retry from durable authority;
    // never acquire the schedule after the automation row.
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
  if (
    args.authority.kind === "selected" &&
    (args.authority.row.phase !== "legacy" ||
      !args.authority.row.enabled ||
      args.authority.row.nextRunAt !== null ||
      args.automation.nextRunAt !== null)
  ) {
    // A selected compatibility callback owns only the pre-S7a empty slot. A
    // cutover or a writer that already published a successor wins unchanged.
    return skippedUnjournaledCallbackSettlement();
  }
  return { kind: "continue", automation: args.automation };
}

async function attemptUnjournaledWorkflowAutomationCallbackSettlement(
  tx: Tx,
  args: {
    readonly automationId: string;
    readonly callback: InternalRunCallbackEnvelope;
    readonly lineage: MorningBriefLegacyLineage | undefined;
  },
  signal?: AbortSignal,
): Promise<UnjournaledCallbackSettlementAttempt> {
  const authority: MorningBriefLegacyWriterAuthority =
    args.lineage === undefined
      ? { kind: "ordinary", fence: { kind: "ordinary" } }
      : await lockMorningBriefLegacyWriterAuthority(tx, args.lineage);
  if (authority.kind === "stale") {
    return skippedUnjournaledCallbackSettlement();
  }
  const [lockedAutomation] = await tx
    .select(workflowAutomationColumns())
    .from(workflowAutomations)
    .where(eq(workflowAutomations.id, args.automationId))
    .limit(1)
    .for("update");
  signal?.throwIfAborted();
  const revalidation = revalidateUnjournaledCallbackLineage({
    automationId: args.automationId,
    lineage: args.lineage,
    authority,
    automation: lockedAutomation,
  });
  if (revalidation.kind !== "continue") {
    return revalidation;
  }
  const automation = revalidation.automation;
  const completedAt = nowDate();
  const isCreditError = await callbackFailedForCredits(
    tx,
    args.callback,
    automation.orgId,
  );
  signal?.throwIfAborted();
  const consecutiveFailures =
    args.callback.status === "completed"
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
      ...(shouldDisable && authority.kind === "selected"
        ? { officialIntendedEnabled: false }
        : {}),
      nextRunAt,
      updatedAt: completedAt,
    })
    .where(
      and(
        eq(workflowAutomations.id, args.automationId),
        eq(workflowAutomations.enabled, true),
      ),
    );
  if (args.lineage !== undefined) {
    await settleSelectedLegacyMorningBriefObligation(
      tx,
      args.lineage,
      authority,
      {
        enabled: !shouldDisable,
        cronExpression: automation.cronExpression,
        timezone: automation.timezone,
        nextRunAt,
        at: completedAt,
      },
    );
  }
  signal?.throwIfAborted();
  return { kind: "settled", result: { success: true } };
}

async function settleUnjournaledWorkflowAutomationCallback(
  db: Db,
  args: {
    readonly automationId: string;
    readonly callback: InternalRunCallbackEnvelope;
    readonly lineage: MorningBriefLegacyLineage | undefined;
  },
  signal?: AbortSignal,
): Promise<InternalRunCallbackDispatchResult> {
  const attempt = async (
    lineage: MorningBriefLegacyLineage | undefined,
  ): Promise<UnjournaledCallbackSettlementAttempt> => {
    return await db.transaction(async (tx) => {
      return await attemptUnjournaledWorkflowAutomationCallbackSettlement(
        tx,
        { ...args, lineage },
        signal,
      );
    });
  };
  const first = await attempt(args.lineage);
  if (first.kind === "settled") {
    return first.result;
  }
  const retried = await attempt(first.lineage);
  return retried.kind === "settled"
    ? retried.result
    : { success: true, skipped: true };
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
  });
  signal?.throwIfAborted();
  if (settled) {
    return { success: true };
  }

  // Historical, manual and every unjournaled unrelated execution keeps the
  // exact behavior below. A selected Morning Brief additionally takes durable
  // authority before the legacy row and becomes a no-op after cutover.
  const lineage = await resolveMorningBriefCallbackLineage(
    db,
    payload.data.automationId,
  );
  await unjournaledCallbackLineageReadHook.get()?.({
    automationId: payload.data.automationId,
    lineageKind: lineage === undefined ? "ordinary-or-absent" : "morning-brief",
  });
  signal?.throwIfAborted();
  return await settleUnjournaledWorkflowAutomationCallback(
    db,
    {
      automationId: payload.data.automationId,
      callback: input.callback,
      lineage,
    },
    signal,
  );
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
