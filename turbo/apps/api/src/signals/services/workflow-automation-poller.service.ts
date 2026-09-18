import { MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import {
  workflowUserAutomationThreads,
  workflowAutomations,
  workflows,
} from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, eq, lte } from "drizzle-orm";
import { logger } from "../../lib/log";
import { writeDb$, type Db } from "../external/db";
import { now, nowDate } from "../../lib/time";
import { tapError } from "../utils";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import { calculateNextRun } from "./time-automation";
import { runWorkflowAutomationNow$ } from "./workflow-automation-run.service";
import {
  scheduleTriggerContext,
  type DueWorkflowAutomation,
  type RunFailure,
  type AutomationRow,
  type RunWorkflowAutomationNowArgs,
  type RunWorkflowAutomationResult,
} from "./workflow-automation-launch.service";
import {
  bindMorningBriefScheduleClaimQueueEvent,
  claimMorningBriefSchedule,
  isCanonicalMorningBriefAutomation,
  loadMorningBriefScheduleClaimByQueueEvent,
  settleMorningBriefSchedulePreRunFailure,
} from "./morning-brief-schedule-claim.service";
import type {
  ScheduleUnclaimed,
  WorkflowScheduleClaimPlan,
} from "./workflow-chat-event-queue.service";
import {
  lockMorningBriefLegacyWriterAuthority,
  settleSelectedLegacyMorningBriefObligation,
} from "./morning-brief-native-schedule.service";
import { workflowAutomationCanFire } from "./workflow-automation-access.service";
import { buildWorkflowScheduleAutomationBrief } from "./workflow-automation-brief.service";
import { ensureWorkflowUserAutomationThread } from "./workflow-user-automation-thread.service";

const log = logger("WorkflowAutomationPoller");

const MAX_CONSECUTIVE_FAILURES = 3;
const DUE_BATCH_LIMIT = 200;

interface ExecuteResult {
  readonly executed: number;
  readonly skipped: number;
}

interface DueWorkflowAutomationRow {
  readonly automation: AutomationRow;
  readonly agentId: string;
  readonly workflowName: string;
  readonly workflowDisplayName: string | null;
  readonly chatThreadId: string | null;
  readonly userTimezone: string | null;
}

async function startDueWorkflowAutomation(
  args: {
    readonly startRun: (
      input: RunWorkflowAutomationNowArgs,
      signal: AbortSignal,
    ) => Promise<RunWorkflowAutomationResult>;
    readonly due: DueWorkflowAutomation;
    readonly row: DueWorkflowAutomationRow;
    readonly currentTime: Date;
    readonly scheduleContext: ReturnType<typeof scheduleTriggerContext>;
    readonly scheduleClaim: WorkflowScheduleClaimPlan | undefined;
  },
  signal: AbortSignal,
): Promise<RunWorkflowAutomationResult> {
  const { automation } = args.due;
  return await args.startRun(
    {
      due: args.due,
      automationContext: args.scheduleContext,
      apiStartTime: now(),
      ...(args.scheduleClaim ? { scheduleClaim: args.scheduleClaim } : {}),
      triggerBrief:
        buildWorkflowScheduleAutomationBrief({
          createdAt: args.currentTime,
          scheduleType: automation.scheduleType,
          cronExpression: automation.cronExpression,
          intervalSeconds: automation.intervalSeconds,
          atTime: automation.atTime,
          automationTimezone: automation.timezone,
          userTimezone: args.row.userTimezone,
        }) ?? undefined,
      dispatchFailedCallbacks: dispatchFailedRunCallbacks,
    },
    signal,
  );
}

function isRunFailure(error: unknown): error is RunFailure {
  return (
    typeof error === "object" &&
    error !== null &&
    "kind" in error &&
    (error.kind === "conflict" || error.kind === "run_error")
  );
}

function failureMessage(error: unknown): string {
  if (!isRunFailure(error)) {
    return error instanceof Error ? error.message : String(error);
  }
  if (error.kind === "run_error") {
    return `${error.response.status} ${error.response.body.error.code}: ${error.response.body.error.message}`;
  }
  return error.message;
}

function isInsufficientCreditsFailure(error: unknown): boolean {
  return (
    isRunFailure(error) &&
    error.kind === "run_error" &&
    error.response.body.error.code === "INSUFFICIENT_CREDITS"
  );
}

async function hasOrgMembership(
  db: Db,
  args: { readonly orgId: string; readonly userId: string },
): Promise<boolean> {
  const [membership] = await db
    .select({ userId: orgMembersCache.userId })
    .from(orgMembersCache)
    .where(
      and(
        eq(orgMembersCache.orgId, args.orgId),
        eq(orgMembersCache.userId, args.userId),
      ),
    )
    .limit(1);
  return membership !== undefined;
}

/**
 * Claim a due workflow automation via an optimistic lock on `next_run_at`: clear
 * the next run and stamp `last_run_at`. A one-time automation stays readable
 * until its queued event claims a run, so a draining previous API version does
 * not discard the event during rollout. Recurrence advance happens in the
 * completion callback. Returns the claimed row, or null when another tick won
 * the race.
 */
async function claimAutomation(
  db: Db,
  automation: AutomationRow,
  currentTime: Date,
): Promise<AutomationRow | null> {
  if (!automation.nextRunAt) {
    return null;
  }
  const [claimed] = await db
    .update(workflowAutomations)
    .set({
      nextRunAt: null,
      lastRunAt: currentTime,
      updatedAt: currentTime,
    })
    .where(
      and(
        eq(workflowAutomations.id, automation.id),
        eq(workflowAutomations.nextRunAt, automation.nextRunAt),
      ),
    )
    .returning(workflowAutomationColumns());
  return claimed ?? null;
}

/**
 * The journaled variant of the claim above.
 *
 * It does not consume the schedule here. The plan runs inside the queue
 * admission transaction, so clearing `next_run_at`, recording the occurrence
 * and inserting the queue event either all commit or all roll back.
 */
function morningBriefScheduleClaimPlan(args: {
  readonly automation: AutomationRow;
  readonly scheduledAnchorAt: Date;
  readonly claimedAt: Date;
  readonly onClaimed: (claimId: string) => void;
  readonly onUnclaimed: (reason: ScheduleUnclaimed) => void;
}): WorkflowScheduleClaimPlan {
  return {
    claim: async (tx) => {
      const attempt = await claimMorningBriefSchedule(tx, {
        automationId: args.automation.id,
        owner: {
          orgId: args.automation.orgId,
          ownerUserId: args.automation.ownerUserId,
          workflowId: args.automation.workflowId,
        },
        scheduledAnchorAt: args.scheduledAnchorAt,
        claimedAt: args.claimedAt,
      });
      if (attempt.kind === "unavailable") {
        args.onUnclaimed("superseded");
        return { kind: "unavailable" };
      }
      args.onClaimed(attempt.claim.id);
      return { kind: "claimed", claimId: attempt.claim.id };
    },
    bindQueueEvent: bindMorningBriefScheduleClaimQueueEvent,
    recordedClaimForQueueEvent: async (tx, queueEventId) => {
      const recorded = await loadMorningBriefScheduleClaimByQueueEvent(
        tx,
        queueEventId,
      );
      if (!recorded) {
        args.onUnclaimed("untracked_pending_event");
      }
      return recorded?.id;
    },
  };
}

interface JournaledScheduleExecution {
  readonly scheduleClaim: WorkflowScheduleClaimPlan | undefined;
  /** Whether the occurrence was left unconsumed, logged once when it was. */
  readonly unclaimed: () => boolean;
  readonly recordFailure: (error: unknown) => Promise<void>;
}

/**
 * The per-tick state a journaled occurrence needs: the claim plan the queue
 * admission runs, whether that plan consumed the schedule, and the settlement
 * the failure paths use. An unjournaled tick gets no plan and keeps the legacy
 * pre-run failure update.
 */
function journaledScheduleExecution(
  args: {
    readonly db: Db;
    readonly automation: AutomationRow;
    readonly scheduledAnchorAt: Date | null;
    readonly claimedAt: Date;
  },
  signal: AbortSignal,
): JournaledScheduleExecution {
  const { automation } = args;
  let claimId: string | undefined;
  let unclaimedReason: ScheduleUnclaimed | undefined;
  return {
    scheduleClaim:
      args.scheduledAnchorAt === null
        ? undefined
        : morningBriefScheduleClaimPlan({
            automation,
            scheduledAnchorAt: args.scheduledAnchorAt,
            claimedAt: args.claimedAt,
            onClaimed: (claimed) => {
              claimId = claimed;
            },
            onUnclaimed: (reason) => {
              unclaimedReason = reason;
            },
          }),
    unclaimed: () => {
      if (unclaimedReason === undefined) {
        return false;
      }
      // The schedule was never consumed, so this tick fired nothing and the
      // same due instant remains for the next one.
      log.debug("Workflow automation schedule occurrence was not claimed", {
        automationId: automation.id,
        orgId: automation.orgId,
        userId: automation.ownerUserId,
        reason: unclaimedReason,
      });
      return true;
    },
    recordFailure: async (error) => {
      // A journaled occurrence settles through the shared operation that the
      // completion callback uses; only an unjournaled tick keeps the legacy
      // update that can overlap a failed-Run callback.
      if (claimId !== undefined) {
        await settleMorningBriefSchedulePreRunFailure(args.db, {
          automationId: automation.id,
          claimId,
          isCreditError: isInsufficientCreditsFailure(error),
        });
        logPreRunFailure(automation, error);
        return;
      }
      // Failing before any claim is not authority to mutate the schedule: a
      // competing tick may already own this occurrence. The update only lands
      // while the original due instant is still unconsumed.
      await recordPreRunFailure(
        args.db,
        automation,
        error,
        signal,
        args.scheduledAnchorAt ?? undefined,
      );
    },
  };
}

function advanceAfterPreRunFailure(
  automation: AutomationRow,
  failureTime: Date,
  shouldDisable: boolean,
): Date | null {
  if (shouldDisable) {
    return null;
  }
  if (automation.scheduleType === "cron" && automation.cronExpression) {
    return calculateNextRun(
      automation.cronExpression,
      automation.timezone,
      failureTime,
    );
  }
  if (automation.scheduleType === "loop" && automation.intervalSeconds) {
    return new Date(failureTime.getTime() + automation.intervalSeconds * 1000);
  }
  return null;
}

function logPreRunFailure(automation: AutomationRow, error: unknown): void {
  const context = {
    automationId: automation.id,
    workflowId: automation.workflowId,
    orgId: automation.orgId,
    userId: automation.ownerUserId,
    error: failureMessage(error),
  };
  if (isInsufficientCreditsFailure(error)) {
    log.debug("Workflow automation skipped: insufficient credits", context);
  } else {
    log.error("Workflow automation pre-run failed", context);
  }
}

async function recordSelectedMorningBriefPreRunFailure(
  db: Db,
  automation: AutomationRow,
  error: unknown,
  signal: AbortSignal,
  stillDueAt?: Date,
): Promise<boolean> {
  if (
    automation.officialBlueprintKey !== MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY ||
    automation.ownerUserId === null
  ) {
    return false;
  }
  const isCreditError = isInsufficientCreditsFailure(error);
  const outcome = await db.transaction(async (tx) => {
    const lineage = {
      orgId: automation.orgId,
      userId: automation.ownerUserId,
      workflowId: automation.workflowId,
      automationId: automation.id,
    };
    const authority = await lockMorningBriefLegacyWriterAuthority(tx, lineage);
    if (authority.kind === "ordinary") {
      // Additional Morning Brief installations are not durable authority. Keep
      // their exact legacy pre-run failure path below.
      return undefined;
    }
    if (authority.kind === "stale") {
      return { disabled: false, consecutiveFailures: 0 };
    }
    const [current] = await tx
      .select(workflowAutomationColumns())
      .from(workflowAutomations)
      .where(eq(workflowAutomations.id, automation.id))
      .limit(1)
      .for("update");
    if (
      current === undefined ||
      authority.row.phase !== "legacy" ||
      (stillDueAt !== undefined &&
        current.nextRunAt?.getTime() !== stillDueAt.getTime()) ||
      (current.scheduleType !== "once" && !current.enabled)
    ) {
      return { disabled: false, consecutiveFailures: 0 };
    }
    const failureTime = nowDate();
    const consecutiveFailures = isCreditError
      ? current.consecutiveFailures
      : current.consecutiveFailures + 1;
    const shouldDisable =
      !isCreditError && consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
    const nextRunAt = advanceAfterPreRunFailure(
      current,
      failureTime,
      shouldDisable,
    );
    await tx
      .update(workflowAutomations)
      .set({
        consecutiveFailures,
        ...(shouldDisable ? { enabled: false } : {}),
        ...(shouldDisable ? { officialIntendedEnabled: false } : {}),
        nextRunAt,
        updatedAt: failureTime,
      })
      .where(eq(workflowAutomations.id, current.id));
    await settleSelectedLegacyMorningBriefObligation(tx, lineage, authority, {
      enabled: !shouldDisable,
      cronExpression: current.cronExpression,
      timezone: current.timezone,
      nextRunAt,
      at: failureTime,
    });
    return { disabled: shouldDisable, consecutiveFailures };
  });
  signal.throwIfAborted();
  if (outcome === undefined) {
    return false;
  }
  if (outcome.disabled) {
    log.warn("Workflow automation auto-disabled after consecutive failures", {
      automationId: automation.id,
      workflowId: automation.workflowId,
      orgId: automation.orgId,
      userId: automation.ownerUserId,
      error: failureMessage(error),
      consecutiveFailures: outcome.consecutiveFailures,
    });
  }
  return true;
}

/**
 * `stillDueAt` restricts the update to the exact unconsumed occurrence this
 * tick resolved. A journal-aware tick that failed before it acquired any claim
 * passes it, so it can never republish a schedule, raise a failure count or
 * disable an automation that another tick already claimed or that a user has
 * since rescheduled. Legacy unjournaled ticks pass nothing and keep their exact
 * previous behavior.
 */
async function recordPreRunFailure(
  db: Db,
  automation: AutomationRow,
  error: unknown,
  signal: AbortSignal,
  stillDueAt?: Date,
): Promise<void> {
  const isCreditError = isInsufficientCreditsFailure(error);
  const context = {
    automationId: automation.id,
    workflowId: automation.workflowId,
    orgId: automation.orgId,
    userId: automation.ownerUserId,
    error: failureMessage(error),
  };
  logPreRunFailure(automation, error);

  if (
    await recordSelectedMorningBriefPreRunFailure(
      db,
      automation,
      error,
      signal,
      stillDueAt,
    )
  ) {
    return;
  }

  const failureTime = nowDate();
  const newFailureCount = isCreditError
    ? automation.consecutiveFailures
    : automation.consecutiveFailures + 1;
  const shouldDisable =
    !isCreditError && newFailureCount >= MAX_CONSECUTIVE_FAILURES;
  const nextRunAt = advanceAfterPreRunFailure(
    automation,
    failureTime,
    shouldDisable,
  );
  const stillOwnsOccurrence = stillDueAt
    ? eq(workflowAutomations.nextRunAt, stillDueAt)
    : undefined;
  const automationIsStillEligible =
    automation.scheduleType === "once"
      ? and(eq(workflowAutomations.id, automation.id), stillOwnsOccurrence)
      : and(
          eq(workflowAutomations.id, automation.id),
          eq(workflowAutomations.enabled, true),
          stillOwnsOccurrence,
        );

  await db
    .update(workflowAutomations)
    .set({
      consecutiveFailures: newFailureCount,
      ...(shouldDisable ? { enabled: false } : {}),
      nextRunAt,
      updatedAt: failureTime,
    })
    .where(automationIsStillEligible);
  signal.throwIfAborted();

  if (shouldDisable) {
    log.warn("Workflow automation auto-disabled after consecutive failures", {
      ...context,
      consecutiveFailures: newFailureCount,
    });
  }
}

async function ensureDueWorkflowAutomationChatThread(
  db: Db,
  row: DueWorkflowAutomationRow,
  currentTime: Date,
): Promise<string> {
  if (row.chatThreadId) {
    return row.chatThreadId;
  }
  return await db.transaction(async (tx) => {
    return await ensureWorkflowUserAutomationThread(tx, {
      orgId: row.automation.orgId,
      userId: row.automation.ownerUserId,
      workflowId: row.automation.workflowId,
      agentId: row.agentId,
      workflowTitle: row.workflowDisplayName ?? row.workflowName,
      currentTime,
    });
  });
}

async function dueWorkflowAutomationRows(
  db: Db,
  currentTime: Date,
  signal: AbortSignal,
  automationId?: string,
): Promise<DueWorkflowAutomationRow[]> {
  const rows = await db
    .select({
      automation: workflowAutomationColumns(),
      agentId: workflows.agentId,
      workflowName: workflows.name,
      workflowDisplayName: workflows.displayName,
      chatThreadId: workflowUserAutomationThreads.chatThreadId,
      userTimezone: orgMembersMetadata.timezone,
    })
    .from(workflowAutomations)
    .innerJoin(workflows, eq(workflowAutomations.workflowId, workflows.id))
    .leftJoin(
      workflowUserAutomationThreads,
      and(
        eq(workflowUserAutomationThreads.orgId, workflowAutomations.orgId),
        eq(
          workflowUserAutomationThreads.userId,
          workflowAutomations.ownerUserId,
        ),
        eq(
          workflowUserAutomationThreads.workflowId,
          workflowAutomations.workflowId,
        ),
      ),
    )
    .leftJoin(
      orgMembersMetadata,
      and(
        eq(orgMembersMetadata.orgId, workflowAutomations.orgId),
        eq(orgMembersMetadata.userId, workflowAutomations.ownerUserId),
      ),
    )
    .where(
      and(
        automationId === undefined
          ? undefined
          : eq(workflowAutomations.id, automationId),
        eq(workflowAutomations.enabled, true),
        eq(workflowAutomations.kind, "schedule"),
        lte(workflowAutomations.nextRunAt, currentTime),
      ),
    )
    .limit(DUE_BATCH_LIMIT);
  signal.throwIfAborted();
  return rows;
}

/**
 * Membership and pause gates, unchanged. A departed owner disables the
 * automation and clears its schedule exactly as before.
 */
async function dueWorkflowAutomationIsFireable(
  db: Db,
  row: DueWorkflowAutomationRow,
  currentTime: Date,
  signal: AbortSignal,
): Promise<boolean> {
  const context = {
    automationId: row.automation.id,
    workflowId: row.automation.workflowId,
    orgId: row.automation.orgId,
    userId: row.automation.ownerUserId,
  };
  const ownerIsMember = await hasOrgMembership(db, {
    orgId: row.automation.orgId,
    userId: row.automation.ownerUserId,
  });
  signal.throwIfAborted();
  if (!ownerIsMember) {
    log.warn(
      "Disabling workflow automation: owner is no longer an org member",
      context,
    );
    await db
      .update(workflowAutomations)
      .set({ enabled: false, nextRunAt: null, updatedAt: currentTime })
      .where(eq(workflowAutomations.id, row.automation.id));
    signal.throwIfAborted();
    return false;
  }

  const canFire = await workflowAutomationCanFire(
    db,
    { automation: row.automation, agentId: row.agentId },
    signal,
  );
  signal.throwIfAborted();
  if (!canFire) {
    log.debug("Workflow automation skipped: automation is paused", {
      ...context,
      agentId: row.agentId,
    });
    return false;
  }
  return true;
}

async function executeDueWorkflowAutomations(
  args: {
    readonly db: Db;
    readonly automationId?: string;
    readonly startRun: (
      input: RunWorkflowAutomationNowArgs,
      signal: AbortSignal,
    ) => Promise<RunWorkflowAutomationResult>;
  },
  signal: AbortSignal,
): Promise<ExecuteResult> {
  const currentTime = nowDate();
  const rows = await dueWorkflowAutomationRows(
    args.db,
    currentTime,
    signal,
    args.automationId,
  );
  let executed = 0;
  let skipped = 0;

  for (const row of rows) {
    if (
      !(await dueWorkflowAutomationIsFireable(
        args.db,
        row,
        currentTime,
        signal,
      ))
    ) {
      skipped++;
      continue;
    }

    // The journaled path keeps the pre-claim `next_run_at` and consumes it
    // inside the queue admission transaction, so its preparation runs before
    // anything touches the schedule.
    const scheduledAnchorAt = row.automation.nextRunAt;
    const journaled =
      scheduledAnchorAt !== null &&
      (await isCanonicalMorningBriefAutomation(args.db, row.automation));
    signal.throwIfAborted();

    const claimed = journaled
      ? row.automation
      : await claimAutomation(args.db, row.automation, currentTime);
    signal.throwIfAborted();
    if (!claimed) {
      skipped++;
      continue;
    }

    const execution = journaledScheduleExecution(
      {
        db: args.db,
        automation: claimed,
        scheduledAnchorAt: journaled ? scheduledAnchorAt : null,
        claimedAt: currentTime,
      },
      signal,
    );

    const chatThreadId = await tapError(
      ensureDueWorkflowAutomationChatThread(args.db, row, currentTime),
      async (error) => {
        await execution.recordFailure(error);
        skipped++;
      },
    );
    signal.throwIfAborted();
    if (!chatThreadId) {
      continue;
    }

    const due: DueWorkflowAutomation = {
      automation: claimed,
      agentId: row.agentId,
      chatThreadId,
    };

    // The tick owns the fire time, so it builds the trigger line here rather
    // than letting a later drain guess it from its own clock.
    const scheduleContext = scheduleTriggerContext({
      automation: claimed,
      workflowName: row.workflowName,
      firedAt: currentTime,
    });
    const result = await tapError(
      startDueWorkflowAutomation(
        {
          startRun: args.startRun,
          due,
          row,
          currentTime,
          scheduleContext,
          scheduleClaim: execution.scheduleClaim,
        },
        signal,
      ),
      async (error) => {
        await execution.recordFailure(error);
        skipped++;
      },
    );
    signal.throwIfAborted();
    if (!result) {
      continue;
    }
    if (execution.unclaimed()) {
      skipped++;
      continue;
    }
    if (result.kind === "enqueued") {
      executed++;
      continue;
    }
    if (result.kind !== "ok") {
      await execution.recordFailure(result);
      skipped++;
      continue;
    }
    executed++;
  }

  log.debug("execute-workflow-automations tick complete", {
    dueCount: rows.length,
    executed,
    skipped,
  });
  return { executed, skipped };
}

/**
 * Time poller over `workflow_automations`, run from the
 * execute-workflow-automations cron route. Mirrors the automation poller: scan
 * enabled automations whose `next_run_at` is due, optimistic-lock claim the due
 * row, then fire a run that injects
 * the workflow skill (via the agent's attachment) and carries the recurrence
 * completion callback.
 */
export const executeDueWorkflowAutomations$ = command(
  async ({ set }, signal: AbortSignal): Promise<ExecuteResult> => {
    return await executeDueWorkflowAutomations(
      {
        db: set(writeDb$),
        startRun: (input, childSignal) => {
          return set(runWorkflowAutomationNow$, input, childSignal);
        },
      },
      signal,
    );
  },
);

export const executeDueWorkflowAutomationsForAutomation$ = command(
  async (
    { set },
    automationId: string,
    signal: AbortSignal,
  ): Promise<ExecuteResult> => {
    return await executeDueWorkflowAutomations(
      {
        db: set(writeDb$),
        automationId,
        startRun: (input, childSignal) => {
          return set(runWorkflowAutomationNow$, input, childSignal);
        },
      },
      signal,
    );
  },
);
