import {
  automationWorkflowJoinCondition,
  dispatchableWorkflowCondition,
} from "./workflow-visibility";
import { workflowAutomationSnapshot } from "./workflow-automation-snapshot";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { orgMembersMetadata } from "@okouai/db/runtime/org-members-metadata";
import {
  workflows,
  workflowUserAutomationThreads,
} from "@okouai/db/schema/workflow";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { command } from "ccstate";
import { and, eq, exists, isNotNull, lte, or, sql } from "drizzle-orm";
import { logger } from "../../lib/log";
import { now, nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { tapError } from "../utils";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import {
  scheduleTriggerContext,
  type AutomationRow,
  type RunWorkflowAutomationResult,
  type WorkflowRecurringScheduleClaim,
} from "./workflow-automation-enqueue.service";
import { runWorkflowAutomationNow$ } from "./workflow-automation-run.service";

import { workflowAutomationCanFire$ } from "./workflow-automation-access.service";
import { buildWorkflowScheduleAutomationBrief } from "./workflow-automation-brief.service";
import { skipInactiveOwnerSchedule$ } from "./workflow-schedule-expiry.service";
import { platformScheduleOwnerIsActive$ } from "./platform-schedule-activity.service";
import {
  preRunFailureFromError,
  recordPreRunFailure$,
} from "./workflow-schedule-failure.service";
import { ensureWorkflowUserAutomationThread$ } from "./workflow-user-automation-thread.service";

const log = logger("WorkflowAutomationPoller");

const DUE_BATCH_LIMIT = 200;

interface ExecuteResult {
  readonly executed: number;
  readonly skipped: number;
}

interface DueWorkflowAutomationRow {
  readonly automation: AutomationRow;
  readonly workflowName: string;
  readonly workflowDisplayName: string | null;
  readonly chatThreadId: string | null;
  readonly userTimezone: string | null;
}

const startDueWorkflowAutomation$ = command(
  async (
    { set },
    args: {
      readonly automation: AutomationRow;
      readonly chatThreadId: string;
      readonly row: DueWorkflowAutomationRow;
      readonly currentTime: Date;
      readonly scheduleContext: ReturnType<typeof scheduleTriggerContext>;
      readonly recurringScheduleClaim:
        WorkflowRecurringScheduleClaim | undefined;
    },
    signal: AbortSignal,
  ): Promise<RunWorkflowAutomationResult> => {
    const { automation } = args;
    return await set(
      runWorkflowAutomationNow$,
      {
        automation,
        chatThreadId: args.chatThreadId,
        automationContext: args.scheduleContext,
        apiStartTime: now(),
        recurringScheduleClaim: args.recurringScheduleClaim,
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
      },
      signal,
    );
  },
);

/**
 * Claim a due workflow automation via an optimistic lock on `next_run_at`: clear
 * the next run and stamp `last_run_at`. A one-time automation stays readable
 * until its queued event claims a run. Recurrence advance happens in the
 * completion callback. Returns the claimed row, or null when another tick won
 * the race.
 */
const claimAutomation$ = command(
  async (
    { set },
    automation: AutomationRow,
    currentTime: Date,
    signal: AbortSignal,
  ): Promise<AutomationRow | null> => {
    const db = set(writeDb$);
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
          exists(
            db
              .select({ id: workflows.id })
              .from(workflows)
              .where(
                and(
                  automationWorkflowJoinCondition(),
                  dispatchableWorkflowCondition(),
                ),
              ),
          ),
          eq(workflowAutomations.id, automation.id),
          eq(workflowAutomations.nextRunAt, automation.nextRunAt),
          eq(workflowAutomations.enabled, true),
          eq(workflowAutomations.kind, "schedule"),
          // Ordinary recurring schedules are claimed by queue admission.
          or(
            isNotNull(workflowAutomations.officialBlueprintKey),
            eq(workflowAutomations.scheduleType, "once"),
          ),
          sql`${workflowAutomations.officialBlueprintKey} IS NOT DISTINCT FROM ${automation.officialBlueprintKey}::text`,
        ),
      )
      .returning(workflowAutomationColumns());
    signal.throwIfAborted();
    return claimed ?? null;
  },
);

const dueWorkflowAutomationRows$ = command(
  async (
    { set },
    at: Date,
    signal: AbortSignal,
  ): Promise<DueWorkflowAutomationRow[]> => {
    const db = set(writeDb$);
    const rows = await db
      .select({
        automation: workflowAutomationColumns(),
        workflowName: workflows.name,
        workflowDisplayName: workflows.displayName,
        chatThreadId: workflowUserAutomationThreads.chatThreadId,
        userTimezone: orgMembersMetadata.timezone,
      })
      .from(workflowAutomations)
      .innerJoin(workflows, automationWorkflowJoinCondition())
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
          eq(workflowAutomations.enabled, true),
          eq(workflowAutomations.kind, "schedule"),
          lte(workflowAutomations.nextRunAt, at),
          dispatchableWorkflowCondition(),
        ),
      )
      .orderBy(workflowAutomations.nextRunAt, workflowAutomations.id)
      .limit(DUE_BATCH_LIMIT);
    signal.throwIfAborted();
    return rows;
  },
);

/** Disable outstanding schedules when the owner has left the workspace. */
const dueWorkflowAutomationOwnerIsMember$ = command(
  async (
    { set },
    row: DueWorkflowAutomationRow,
    currentTime: Date,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const [membership] = await db
      .select({ userId: orgMembersCache.userId })
      .from(orgMembersCache)
      .where(
        and(
          eq(orgMembersCache.orgId, row.automation.orgId),
          eq(orgMembersCache.userId, row.automation.ownerUserId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (membership) {
      return true;
    }
    log.debug(
      "Disabling workflow automation: owner is no longer an org member",
      {
        automationId: row.automation.id,
        workflowId: row.automation.workflowId,
        orgId: row.automation.orgId,
        userId: row.automation.ownerUserId,
      },
    );
    await db
      .update(workflowAutomations)
      .set({ enabled: false, nextRunAt: null, updatedAt: currentTime })
      .where(eq(workflowAutomations.id, row.automation.id));
    signal.throwIfAborted();
    return false;
  },
);

const dueWorkflowAutomationIsFireable$ = command(
  async (
    { set },
    row: DueWorkflowAutomationRow,
    currentTime: Date,
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (
      !(await set(
        dueWorkflowAutomationOwnerIsMember$,
        row,
        currentTime,
        signal,
      ))
    ) {
      return false;
    }
    const canFire = await set(
      workflowAutomationCanFire$,
      { automation: row.automation },
      signal,
    );
    signal.throwIfAborted();
    if (!canFire) {
      log.debug("Workflow automation skipped: automation is paused", {
        automationId: row.automation.id,
        workflowId: row.automation.workflowId,
        orgId: row.automation.orgId,
        userId: row.automation.ownerUserId,
      });
      return false;
    }
    return true;
  },
);

type PollCounters = {
  executed: number;
  skipped: number;
  inactiveOwner: number;
};

const launchClaimedDueRow$ = command(
  async (
    { set },
    args: {
      readonly row: DueWorkflowAutomationRow;
      readonly claimed: AutomationRow;
      readonly recurringScheduleClaim:
        WorkflowRecurringScheduleClaim | undefined;
      readonly currentTime: Date;
      readonly counters: PollCounters;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const { row, claimed, currentTime, counters } = args;
    const recordFailure = async (error: unknown) => {
      log.error("Workflow automation pre-run failed", {
        automationId: claimed.id,
        workflowId: claimed.workflowId,
        orgId: claimed.orgId,
        userId: claimed.ownerUserId,
        error,
      });
      await set(
        recordPreRunFailure$,
        {
          automation: claimed,
          failure: preRunFailureFromError(error),
          stillDueAt: args.recurringScheduleClaim?.scheduledAnchorAt,
          recurringScheduleClaim: args.recurringScheduleClaim,
        },
        signal,
      );
      counters.skipped++;
    };
    const chatThreadId = await tapError(
      row.chatThreadId
        ? Promise.resolve(row.chatThreadId)
        : set(
            ensureWorkflowUserAutomationThread$,
            {
              orgId: row.automation.orgId,
              userId: row.automation.ownerUserId,
              workflowId: row.automation.workflowId,
              workflowTitle: row.workflowDisplayName ?? row.workflowName,
              currentTime,
            },
            signal,
          ),
      recordFailure,
    );
    signal.throwIfAborted();
    if (!chatThreadId) {
      return;
    }
    const scheduleContext = scheduleTriggerContext({
      automation: claimed,
      workflowName: row.workflowName,
      firedAt: currentTime,
    });
    const result = await tapError(
      set(
        startDueWorkflowAutomation$,
        {
          automation: claimed,
          chatThreadId,
          row,
          currentTime,
          scheduleContext,
          recurringScheduleClaim: args.recurringScheduleClaim,
        },
        signal,
      ),
      recordFailure,
    );
    signal.throwIfAborted();
    if (!result) {
      return;
    }
    if (result.scheduleOccurrence === "superseded") {
      counters.skipped++;
      return;
    }
    counters.executed++;
  },
);

/**
 * Official schedules run at the platform's expense, so their owner must have
 * started a manual Run recently. Departed and paused owners keep the checks
 * that run first; a concurrently claimed occurrence continues normally.
 */
const skipInactiveOwnerDueRow$ = command(
  async (
    { set },
    row: DueWorkflowAutomationRow,
    currentTime: Date,
    counters: PollCounters,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const { automation } = row;
    if (
      automation.officialBlueprintKey === null ||
      (await set(
        platformScheduleOwnerIsActive$,
        { orgId: automation.orgId, userId: automation.ownerUserId },
        currentTime,
        signal,
      )) ||
      !(await set(
        skipInactiveOwnerSchedule$,
        { automation, at: currentTime },
        signal,
      ))
    ) {
      return false;
    }
    counters.inactiveOwner++;
    counters.skipped++;
    return true;
  },
);

export const executeDueWorkflowAutomations$ = command(
  async ({ set }, signal: AbortSignal): Promise<ExecuteResult> => {
    const currentTime = nowDate();
    const rows = await set(dueWorkflowAutomationRows$, currentTime, signal);
    const counters: PollCounters = {
      executed: 0,
      skipped: 0,
      inactiveOwner: 0,
    };

    for (const row of rows) {
      if (
        !(await set(dueWorkflowAutomationIsFireable$, row, currentTime, signal))
      ) {
        counters.skipped++;
        continue;
      }
      if (
        await set(skipInactiveOwnerDueRow$, row, currentTime, counters, signal)
      ) {
        continue;
      }

      const scheduledAnchorAt = row.automation.nextRunAt;
      const recurringScheduleClaim =
        scheduledAnchorAt !== null &&
        row.automation.officialBlueprintKey === null &&
        (row.automation.scheduleType === "cron" ||
          row.automation.scheduleType === "loop")
          ? {
              scheduledAnchorAt,
              claimedAt: currentTime,
              automationSnapshot: workflowAutomationSnapshot(row.automation),
            }
          : undefined;
      const claimed = recurringScheduleClaim
        ? row.automation
        : await set(claimAutomation$, row.automation, currentTime, signal);
      signal.throwIfAborted();
      if (!claimed) {
        counters.skipped++;
        continue;
      }

      await set(
        launchClaimedDueRow$,
        {
          row,
          claimed,
          recurringScheduleClaim,
          currentTime,
          counters,
        },
        signal,
      );
    }

    log.debug("execute-workflow-automations tick complete", {
      dueCount: rows.length,
      ...counters,
    });
    return { executed: counters.executed, skipped: counters.skipped };
  },
);
