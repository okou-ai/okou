import { selectDueMorningBriefWorkflow$ } from "./morning-brief-workflow-selection.service";
import { workflowAutomationSnapshot } from "./workflow-automation-snapshot";
import { MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import {
  workflows,
  workflowUserAutomationThreads,
} from "@okouai/db/schema/workflow";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { command } from "ccstate";
import { and, eq, gte, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { logger } from "../../lib/log";
import { now, nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { tapError } from "../utils";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import { isCanonicalMorningBriefAutomation$ } from "./morning-brief-schedule-claim.service";
import {
  scheduleTriggerContext,
  type AutomationRow,
  type DueWorkflowAutomation,
  type RunWorkflowAutomationResult,
  type WorkflowScheduleClaimPlan,
} from "./workflow-automation-enqueue.service";
import { runWorkflowAutomationNow$ } from "./workflow-automation-run.service";
import { WorkflowScheduleAdmissionError } from "./workflow-schedule-queue.service";

import { SCHEDULE_GRACE_MS, scheduleExpired } from "./schedule-expiry-policy";
import { workflowAutomationCanFire$ } from "./workflow-automation-access.service";
import { buildWorkflowScheduleAutomationBrief } from "./workflow-automation-brief.service";
import {
  deferWorkflowSchedule$,
  skipExpiredWorkflowSchedule$,
} from "./workflow-schedule-expiry.service";
import {
  preRunFailureFromError,
  recordPreRunFailure$,
  settleJournaledSchedulePreRunFailure$,
} from "./workflow-schedule-failure.service";
import { ensureWorkflowUserAutomationThread$ } from "./workflow-user-automation-thread.service";

const log = logger("WorkflowAutomationPoller");

// The two lanes never sum above the tick cap. Expired Morning Brief anchors
// cannot use the capacity reserved for other due automations.
const DUE_BATCH_LIMIT = 200;
const EXPIRED_BATCH_LIMIT = 35;

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

const startDueWorkflowAutomation$ = command(
  async (
    { set },
    args: {
      readonly due: DueWorkflowAutomation;
      readonly row: DueWorkflowAutomationRow;
      readonly currentTime: Date;
      readonly scheduleContext: ReturnType<typeof scheduleTriggerContext>;
      readonly scheduleClaim: WorkflowScheduleClaimPlan | undefined;
    },
    signal: AbortSignal,
  ): Promise<RunWorkflowAutomationResult> => {
    const { automation } = args.due;
    return await set(
      runWorkflowAutomationNow$,
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
      },
      signal,
    );
  },
);

/**
 * Claim a due workflow automation via an optimistic lock on `next_run_at`: clear
 * the next run and stamp `last_run_at`. A one-time automation stays readable
 * until its queued event claims a run, so a draining previous API version does
 * not discard the event during rollout. Recurrence advance happens in the
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
          eq(workflowAutomations.id, automation.id),
          eq(workflowAutomations.nextRunAt, automation.nextRunAt),
          // A stale preflight must not claim a disabled row or turn a newly
          // classified Morning Brief into an unjournaled legacy Run.
          eq(workflowAutomations.enabled, true),
          automation.officialBlueprintKey ===
            MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY
            ? eq(
                workflowAutomations.officialBlueprintKey,
                MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY,
              )
            : or(
                isNull(workflowAutomations.officialBlueprintKey),
                ne(
                  workflowAutomations.officialBlueprintKey,
                  MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY,
                ),
              ),
          automation.officialBlueprintKey ===
            MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY
            ? gte(
                workflowAutomations.nextRunAt,
                new Date(nowDate().getTime() - SCHEDULE_GRACE_MS),
              )
            : undefined,
        ),
      )
      .returning(workflowAutomationColumns());
    signal.throwIfAborted();
    return claimed ?? null;
  },
);

type DueMode = "morning-brief-expired" | "legacy";

const DUE_MODE_LIMIT: Readonly<Record<DueMode, number>> = Object.freeze({
  legacy: DUE_BATCH_LIMIT - EXPIRED_BATCH_LIMIT,
  "morning-brief-expired": EXPIRED_BATCH_LIMIT,
});

interface DueSelection {
  readonly at: Date;
  readonly mode?: DueMode;
}

function scheduleModeFilter(mode: DueMode, at: Date) {
  if (mode === "morning-brief-expired") {
    return and(
      eq(
        workflowAutomations.officialBlueprintKey,
        MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY,
      ),
      lt(
        workflowAutomations.nextRunAt,
        new Date(at.getTime() - SCHEDULE_GRACE_MS),
      ),
      or(
        sql`${workflowAutomations.deferredAnchorAt} IS DISTINCT FROM ${workflowAutomations.nextRunAt}`,
        isNull(workflowAutomations.deferredUntil),
        lte(workflowAutomations.deferredUntil, at),
      ),
    );
  }

  // Old Morning Brief anchors must not occupy the entire due batch. A bounded
  // separate lane skips them to the future; other automations run when claimed.
  return or(
    isNull(workflowAutomations.officialBlueprintKey),
    ne(
      workflowAutomations.officialBlueprintKey,
      MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY,
    ),
    gte(
      workflowAutomations.nextRunAt,
      new Date(at.getTime() - SCHEDULE_GRACE_MS),
    ),
  );
}

const dueWorkflowAutomationRows$ = command(
  async (
    { set },
    args: DueSelection,
    signal: AbortSignal,
  ): Promise<DueWorkflowAutomationRow[]> => {
    const db = set(writeDb$);
    const mode = args.mode ?? "legacy";
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
          eq(workflowAutomations.enabled, true),
          eq(workflowAutomations.kind, "schedule"),
          lte(workflowAutomations.nextRunAt, args.at),
          scheduleModeFilter(mode, args.at),
        ),
      )
      .orderBy(workflowAutomations.nextRunAt, workflowAutomations.id)
      .limit(DUE_MODE_LIMIT[mode]);
    signal.throwIfAborted();
    return rows;
  },
);

/** A departed owner is disabled before expiry can advance its obligation. */
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
      { automation: row.automation, agentId: row.agentId },
      signal,
    );
    signal.throwIfAborted();
    if (!canFire) {
      log.debug("Workflow automation skipped: automation is paused", {
        automationId: row.automation.id,
        workflowId: row.automation.workflowId,
        orgId: row.automation.orgId,
        userId: row.automation.ownerUserId,
        agentId: row.agentId,
      });
      return false;
    }
    return true;
  },
);

const retireDepartedOwner$ = command(
  async (
    { set },
    row: DueWorkflowAutomationRow,
    currentTime: Date,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const anchor = row.automation.nextRunAt;
    if (
      row.automation.officialBlueprintKey !==
        MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY ||
      !anchor ||
      !scheduleExpired(anchor, nowDate())
    ) {
      return false;
    }
    return !(await set(
      dueWorkflowAutomationOwnerIsMember$,
      row,
      currentTime,
      signal,
    ));
  },
);

type PollCounters = {
  executed: number;
  skipped: number;
  expired: number;
  oldestExpiredAnchorAgeMs: number;
};

const loadDueWorkflowRows$ = command(
  async (
    { set },
    currentTime: Date,
    signal: AbortSignal,
  ): Promise<DueWorkflowAutomationRow[]> => {
    const expired = await set(
      dueWorkflowAutomationRows$,
      { at: currentTime, mode: "morning-brief-expired" },
      signal,
    );
    signal.throwIfAborted();
    const due = await set(
      dueWorkflowAutomationRows$,
      { at: currentTime },
      signal,
    );
    signal.throwIfAborted();
    return [...expired, ...due];
  },
);

const launchClaimedDueRow$ = command(
  async (
    { set },
    args: {
      readonly row: DueWorkflowAutomationRow;
      readonly claimed: AutomationRow;
      readonly scheduledAnchorAt: Date | null;
      readonly journaled: boolean;
      readonly currentTime: Date;
      readonly counters: PollCounters;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const { row, claimed, currentTime, counters } = args;
    const scheduleClaim: WorkflowScheduleClaimPlan | undefined =
      args.journaled && args.scheduledAnchorAt !== null
        ? {
            claimId: randomUUID(),
            automationId: claimed.id,
            orgId: claimed.orgId,
            ownerUserId: claimed.ownerUserId,
            workflowId: claimed.workflowId,
            scheduledAnchorAt: args.scheduledAnchorAt,
            claimedAt: currentTime,
            automationSnapshot: workflowAutomationSnapshot(claimed),
          }
        : undefined;
    const recordFailure = async (error: unknown) => {
      log.error("Workflow automation pre-run failed", {
        automationId: claimed.id,
        workflowId: claimed.workflowId,
        orgId: claimed.orgId,
        userId: claimed.ownerUserId,
        error,
      });
      if (
        scheduleClaim &&
        (error instanceof WorkflowScheduleAdmissionError || signal.aborted)
      ) {
        await set(settleJournaledSchedulePreRunFailure$, {
          automation: claimed,
          claimId: scheduleClaim.claimId,
          failure: preRunFailureFromError(error),
        });
      } else {
        await set(
          recordPreRunFailure$,
          {
            automation: claimed,
            failure: preRunFailureFromError(error),
            stillDueAt: args.journaled
              ? (args.scheduledAnchorAt ?? undefined)
              : undefined,
          },
          signal,
        );
      }
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
              agentId: row.agentId,
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
    const due: DueWorkflowAutomation = {
      automation: claimed,
      agentId: row.agentId,
      chatThreadId,
    };
    const scheduleContext = scheduleTriggerContext({
      automation: claimed,
      workflowName: row.workflowName,
      firedAt: currentTime,
    });
    const result = await tapError(
      set(
        startDueWorkflowAutomation$,
        {
          due,
          row,
          currentTime,
          scheduleContext,
          scheduleClaim,
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

const skipExpiredDueRow$ = command(
  async (
    { set },
    row: DueWorkflowAutomationRow,
    counters: PollCounters,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const anchor = row.automation.nextRunAt;
    if (
      row.automation.officialBlueprintKey !==
        MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY ||
      anchor === null ||
      !scheduleExpired(anchor, nowDate())
    ) {
      return false;
    }
    const at = nowDate();
    const outcome = await set(
      skipExpiredWorkflowSchedule$,
      {
        automationId: row.automation.id,
        anchor,
        at,
      },
      signal,
    );
    if (outcome === "held") {
      await set(
        deferWorkflowSchedule$,
        {
          automationId: row.automation.id,
          anchor,
          at,
        },
        signal,
      );
    }
    signal.throwIfAborted();
    if (outcome === "skipped") {
      counters.expired++;
      counters.oldestExpiredAnchorAgeMs = Math.max(
        counters.oldestExpiredAnchorAgeMs,
        at.getTime() - anchor.getTime(),
      );
    }
    counters.skipped++;
    return true;
  },
);

export const executeDueWorkflowAutomations$ = command(
  async ({ set }, signal: AbortSignal): Promise<ExecuteResult> => {
    const currentTime = nowDate();
    const rows = await set(loadDueWorkflowRows$, currentTime, signal);
    const counters: PollCounters = {
      executed: 0,
      skipped: 0,
      expired: 0,
      oldestExpiredAnchorAgeMs: 0,
    };

    for (const original of rows) {
      let row = original;
      if (await set(retireDepartedOwner$, row, currentTime, signal)) {
        counters.skipped++;
        continue;
      }
      // Retire an expired slot before the potentially expensive pause check.
      if (await set(skipExpiredDueRow$, row, counters, signal)) {
        continue;
      }
      if (
        !(await set(dueWorkflowAutomationIsFireable$, row, currentTime, signal))
      ) {
        if (await set(skipExpiredDueRow$, row, counters, signal)) {
          continue;
        }
        counters.skipped++;
        continue;
      }
      if (await set(skipExpiredDueRow$, row, counters, signal)) {
        continue;
      }

      // The journaled path keeps the pre-claim `next_run_at` and consumes it
      // inside the queue admission transaction, so its preparation runs before
      // anything touches the schedule.
      const scheduledAnchorAt = row.automation.nextRunAt;
      const journaled =
        scheduledAnchorAt !== null &&
        (await set(isCanonicalMorningBriefAutomation$, row.automation, signal));
      signal.throwIfAborted();
      if (journaled) {
        const selected = await set(
          selectDueMorningBriefWorkflow$,
          {
            automation: row.automation,
            agentId: row.agentId,
            workflowName: row.workflowName,
          },
          signal,
        );
        if (!selected) {
          counters.skipped++;
          continue;
        }
        row = { ...row, ...selected };
      }

      const claimed = journaled
        ? row.automation
        : await set(claimAutomation$, row.automation, currentTime, signal);
      signal.throwIfAborted();
      if (!claimed) {
        if (!(await set(skipExpiredDueRow$, row, counters, signal))) {
          counters.skipped++;
        }
        continue;
      }

      await set(
        launchClaimedDueRow$,
        {
          row,
          claimed,
          scheduledAnchorAt,
          journaled,
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
