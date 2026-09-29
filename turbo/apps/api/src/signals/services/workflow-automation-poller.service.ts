import { randomUUID } from "node:crypto";
import { WorkflowScheduleAdmissionError } from "./workflow-schedule-queue.service";
import { MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import {
  workflowUserAutomationThreads,
  workflowAutomations,
  workflows,
} from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, eq, gte, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { logger } from "../../lib/log";
import { writeDb$ } from "../external/db";
import { now, nowDate } from "../../lib/time";
import { tapError } from "../utils";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import { runWorkflowAutomationNow$ } from "./workflow-automation-run.service";
import {
  scheduleTriggerContext,
  type DueWorkflowAutomation,
  type AutomationRow,
  type RunWorkflowAutomationResult,
} from "./workflow-automation-launch.service";
import { isCanonicalMorningBriefAutomation$ } from "./morning-brief-schedule-claim.service";
import type { WorkflowScheduleClaimPlan } from "./workflow-chat-event-queue.service";
import {
  preRunFailureFromError,
  recordPreRunFailure$,
  settleJournaledSchedulePreRunFailure$,
} from "./workflow-schedule-failure.service";
import { workflowAutomationCanFire$ } from "./workflow-automation-access.service";
import { buildWorkflowScheduleAutomationBrief } from "./workflow-automation-brief.service";
import { ensureWorkflowUserAutomationThread$ } from "./workflow-user-automation-thread.service";
import {
  deferWorkflowSchedule$,
  skipExpiredWorkflowSchedule$,
} from "./workflow-schedule-expiry.service";
import {
  SCHEDULE_GRACE_MS,
  scheduleExpired,
  scheduleExpiryEnabled,
} from "./schedule-expiry-policy";

const log = logger("WorkflowAutomationPoller");

const DUE_BATCH_LIMIT = 200;
// Reserved lanes never sum above the legacy tick cap. A poison head in any
// lane cannot use the capacity reserved for fresh and one-time obligations.
const FRESH_BATCH_LIMIT = 120;
const RETRY_BATCH_LIMIT = 15;
const EXPIRED_BATCH_LIMIT = 35;
const ONCE_BATCH_LIMIT = 15;
const ONCE_RETRY_BATCH_LIMIT = 5;
const ONCE_EXPIRED_BATCH_LIMIT = 10;

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
          scheduleExpiryEnabled() ||
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

type DueMode =
  | "legacy"
  | "fresh"
  | "retry"
  | "expired"
  | "once"
  | "once-retry"
  | "once-expired";

const DUE_MODE_LIMIT: Readonly<Record<DueMode, number>> = Object.freeze({
  legacy: DUE_BATCH_LIMIT,
  fresh: FRESH_BATCH_LIMIT,
  retry: RETRY_BATCH_LIMIT,
  expired: EXPIRED_BATCH_LIMIT,
  once: ONCE_BATCH_LIMIT,
  "once-retry": ONCE_RETRY_BATCH_LIMIT,
  "once-expired": ONCE_EXPIRED_BATCH_LIMIT,
});

interface DueSelection {
  readonly at: Date;
  readonly automationId?: string;
  readonly workflowId?: string;
  readonly mode?: DueMode;
}

function scheduleModeFilter(mode: DueMode, at: Date) {
  if (mode === "legacy") {
    // While general expiry is off, old Morning Brief anchors must not occupy
    // the entire due batch. They remain untouched until a safe skip contract
    // can move them; other due automations still retain their legacy policy.
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
  const cutoff = new Date(at.getTime() - SCHEDULE_GRACE_MS);
  const once = mode.startsWith("once");
  const expired = mode === "expired" || mode === "once-expired";
  const retry = mode === "retry" || mode === "once-retry";
  const eligibleDeferral = or(
    sql`${workflowAutomations.deferredAnchorAt} IS DISTINCT FROM ${workflowAutomations.nextRunAt}`,
    isNull(workflowAutomations.deferredUntil),
    lte(workflowAutomations.deferredUntil, at),
  );
  const deferral = retry
    ? and(
        eq(workflowAutomations.deferredAnchorAt, workflowAutomations.nextRunAt),
        lte(workflowAutomations.deferredUntil, at),
      )
    : expired
      ? eligibleDeferral
      : or(
          sql`${workflowAutomations.deferredAnchorAt} IS DISTINCT FROM ${workflowAutomations.nextRunAt}`,
          isNull(workflowAutomations.deferredUntil),
        );
  return and(
    once
      ? eq(workflowAutomations.scheduleType, "once")
      : or(
          eq(workflowAutomations.scheduleType, "cron"),
          eq(workflowAutomations.scheduleType, "loop"),
        ),
    expired
      ? lt(workflowAutomations.nextRunAt, cutoff)
      : gte(workflowAutomations.nextRunAt, cutoff),
    deferral,
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
          args.automationId === undefined
            ? undefined
            : eq(workflowAutomations.id, args.automationId),
          args.workflowId === undefined
            ? undefined
            : eq(workflowAutomations.workflowId, args.workflowId),
          eq(workflowAutomations.enabled, true),
          eq(workflowAutomations.kind, "schedule"),
          lte(workflowAutomations.nextRunAt, args.at),
          scheduleModeFilter(mode, args.at),
        ),
      )
      .orderBy(
        ...(mode === "retry" || mode === "once-retry"
          ? [
              workflowAutomations.deferredUntil,
              workflowAutomations.nextRunAt,
              workflowAutomations.id,
            ]
          : [workflowAutomations.nextRunAt, workflowAutomations.id]),
      )
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
    log.warn(
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
    context: { currentTime: Date; expiryEnabled: boolean },
    row: DueWorkflowAutomationRow,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const anchor = row.automation.nextRunAt;
    if (
      !context.expiryEnabled ||
      !anchor ||
      !scheduleExpired(anchor, nowDate())
    ) {
      return false;
    }
    return !(await set(
      dueWorkflowAutomationOwnerIsMember$,
      row,
      context.currentTime,
      signal,
    ));
  },
);

type WorkflowPollerArgs = {
  readonly automationId?: string;
  readonly workflowId?: string;
};

type PollCounters = { executed: number; skipped: number; expired: number };

const loadDueWorkflowRows$ = command(
  async (
    { set },
    args: {
      readonly currentTime: Date;
      readonly automationId?: string;
      readonly workflowId?: string;
      readonly expiryEnabled: boolean;
    },
    signal: AbortSignal,
  ): Promise<DueWorkflowAutomationRow[]> => {
    const common = {
      at: args.currentTime,
      automationId: args.automationId,
      workflowId: args.workflowId,
    };
    if (!args.expiryEnabled) {
      return await set(dueWorkflowAutomationRows$, common, signal);
    }
    const modes: readonly DueMode[] = [
      "expired",
      "fresh",
      "retry",
      "once-expired",
      "once",
      "once-retry",
    ];
    const rows: DueWorkflowAutomationRow[] = [];
    for (const mode of modes) {
      rows.push(
        ...(await set(dueWorkflowAutomationRows$, { ...common, mode }, signal)),
      );
    }
    return rows;
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
      readonly expiryEnabled: boolean;
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
          }
        : undefined;
    const recordFailure = async (error: unknown) => {
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
      if (args.expiryEnabled && args.scheduledAnchorAt) {
        await set(
          deferWorkflowSchedule$,
          {
            automationId: row.automation.id,
            anchor: args.scheduledAnchorAt,
            at: nowDate(),
            reason: "unavailable",
          },
          signal,
        );
      }
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
    expiryEnabled: boolean,
    counters: PollCounters,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const anchor = row.automation.nextRunAt;
    if (
      !expiryEnabled ||
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
          reason: "held",
        },
        signal,
      );
    }
    signal.throwIfAborted();
    if (outcome === "skipped") {
      counters.expired++;
    }
    counters.skipped++;
    return true;
  },
);

const executeDueWorkflowAutomationsImpl$ = command(
  async (
    { set },
    args: WorkflowPollerArgs,
    signal: AbortSignal,
  ): Promise<ExecuteResult> => {
    const currentTime = nowDate();
    const expiryEnabled = scheduleExpiryEnabled();
    const rows = await set(
      loadDueWorkflowRows$,
      {
        currentTime,
        automationId: args.automationId,
        workflowId: args.workflowId,
        expiryEnabled,
      },
      signal,
    );
    const counters: PollCounters = { executed: 0, skipped: 0, expired: 0 };

    const expiryContext = { currentTime, expiryEnabled };
    for (const row of rows) {
      if (await set(retireDepartedOwner$, expiryContext, row, signal)) {
        counters.skipped++;
        continue;
      }
      // Retire an expired slot before the potentially expensive pause check.
      if (await set(skipExpiredDueRow$, row, expiryEnabled, counters, signal)) {
        continue;
      }
      if (
        !(await set(dueWorkflowAutomationIsFireable$, row, currentTime, signal))
      ) {
        if (
          await set(skipExpiredDueRow$, row, expiryEnabled, counters, signal)
        ) {
          continue;
        }
        if (expiryEnabled && row.automation.nextRunAt) {
          await set(
            deferWorkflowSchedule$,
            {
              automationId: row.automation.id,
              anchor: row.automation.nextRunAt,
              at: nowDate(),
              reason: "not_fireable",
            },
            signal,
          );
        }
        counters.skipped++;
        continue;
      }
      if (await set(skipExpiredDueRow$, row, expiryEnabled, counters, signal)) {
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

      const claimed = journaled
        ? row.automation
        : await set(claimAutomation$, row.automation, currentTime, signal);
      signal.throwIfAborted();
      if (!claimed) {
        if (
          !(await set(skipExpiredDueRow$, row, expiryEnabled, counters, signal))
        ) {
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
          expiryEnabled,
          counters,
        },
        signal,
      );
    }

    log.debug("execute-workflow-automations tick complete", {
      dueCount: rows.length,
      ...counters,
    });
    if (counters.expired > 0) {
      log.warn("Expired unclaimed workflow schedule anchors", {
        expired: counters.expired,
      });
    }
    return { executed: counters.executed, skipped: counters.skipped };
  },
);

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
    return await set(executeDueWorkflowAutomationsImpl$, {}, signal);
  },
);

// The test-only route exercises the same poller lanes without scanning another
// suite's concurrently due automations. Production ticks remain unscoped.
export const executeDueWorkflowAutomationsForWorkflow$ = command(
  async ({ set }, workflowId: string, signal: AbortSignal) => {
    return await set(
      executeDueWorkflowAutomationsImpl$,
      {
        workflowId,
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
    return await set(
      executeDueWorkflowAutomationsImpl$,
      {
        automationId,
      },
      signal,
    );
  },
);
