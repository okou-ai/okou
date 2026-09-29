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
import { writeDb$, type Db } from "../external/db";
import { now, nowDate } from "../../lib/time";
import { tapError } from "../utils";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import { runWorkflowAutomationNow$ } from "./workflow-automation-run.service";
import {
  scheduleTriggerContext,
  type DueWorkflowAutomation,
  type AutomationRow,
  type RunWorkflowAutomationNowArgs,
  type RunWorkflowAutomationResult,
  type ScheduleUnclaimed,
  type WorkflowScheduleClaimPlan,
} from "./pick-chat-run.service";
import {
  bindMorningBriefScheduleClaimQueueEvent,
  claimMorningBriefSchedule,
  isCanonicalMorningBriefAutomation,
} from "./morning-brief-schedule-claim.service";
import {
  preRunFailureFromError,
  recordPreRunFailure,
  settleJournaledSchedulePreRunFailure,
} from "./workflow-schedule-failure.service";
import { workflowAutomationCanFire } from "./workflow-automation-access.service";
import { buildWorkflowScheduleAutomationBrief } from "./workflow-automation-brief.service";
import { ensureWorkflowUserAutomationThread } from "./workflow-user-automation-thread.service";
import {
  deferWorkflowSchedule,
  skipExpiredWorkflowSchedule,
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
    },
    signal,
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
        // A stale preflight must not claim a disabled row or turn a newly
        // classified Morning Brief into an unjournaled legacy Run.
        eq(workflowAutomations.enabled, true),
        automation.officialBlueprintKey === MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY
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
        await settleJournaledSchedulePreRunFailure(args.db, {
          automation,
          claimId,
          failure: preRunFailureFromError(error),
        });
        return;
      }
      // Failing before any claim is not authority to mutate the schedule: a
      // competing tick may already own this occurrence. The update only lands
      // while the original due instant is still unconsumed.
      await recordPreRunFailure(
        args.db,
        automation,
        preRunFailureFromError(error),
        signal,
        args.scheduledAnchorAt ?? undefined,
      );
    },
  };
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

async function dueWorkflowAutomationRows(
  db: Db,
  args: DueSelection,
  signal: AbortSignal,
): Promise<DueWorkflowAutomationRow[]> {
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
}

/** A departed owner is disabled before expiry can advance its obligation. */
async function dueWorkflowAutomationOwnerIsMember(
  db: Db,
  row: DueWorkflowAutomationRow,
  currentTime: Date,
  signal: AbortSignal,
): Promise<boolean> {
  const ownerIsMember = await hasOrgMembership(db, {
    orgId: row.automation.orgId,
    userId: row.automation.ownerUserId,
  });
  signal.throwIfAborted();
  if (ownerIsMember) {
    return true;
  }
  log.warn("Disabling workflow automation: owner is no longer an org member", {
    automationId: row.automation.id,
    workflowId: row.automation.workflowId,
    orgId: row.automation.orgId,
    userId: row.automation.ownerUserId,
  });
  await db
    .update(workflowAutomations)
    .set({ enabled: false, nextRunAt: null, updatedAt: currentTime })
    .where(eq(workflowAutomations.id, row.automation.id));
  signal.throwIfAborted();
  return false;
}

async function dueWorkflowAutomationIsFireable(
  db: Db,
  row: DueWorkflowAutomationRow,
  currentTime: Date,
  signal: AbortSignal,
): Promise<boolean> {
  if (
    !(await dueWorkflowAutomationOwnerIsMember(db, row, currentTime, signal))
  ) {
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
      automationId: row.automation.id,
      workflowId: row.automation.workflowId,
      orgId: row.automation.orgId,
      userId: row.automation.ownerUserId,
      agentId: row.agentId,
    });
    return false;
  }
  return true;
}

async function retireDepartedOwner(
  context: { db: Db; currentTime: Date; expiryEnabled: boolean },
  row: DueWorkflowAutomationRow,
  signal: AbortSignal,
): Promise<boolean> {
  const anchor = row.automation.nextRunAt;
  if (
    !context.expiryEnabled ||
    !anchor ||
    !scheduleExpired(anchor, nowDate())
  ) {
    return false;
  }
  return !(await dueWorkflowAutomationOwnerIsMember(
    context.db,
    row,
    context.currentTime,
    signal,
  ));
}

type WorkflowPollerArgs = {
  readonly db: Db;
  readonly automationId?: string;
  readonly workflowId?: string;
  readonly startRun: (
    input: RunWorkflowAutomationNowArgs,
    signal: AbortSignal,
  ) => Promise<RunWorkflowAutomationResult>;
};

type PollCounters = { executed: number; skipped: number; expired: number };

async function loadDueWorkflowRows(
  db: Db,
  args: {
    readonly currentTime: Date;
    readonly automationId?: string;
    readonly workflowId?: string;
    readonly expiryEnabled: boolean;
  },
  signal: AbortSignal,
): Promise<DueWorkflowAutomationRow[]> {
  const common = {
    at: args.currentTime,
    automationId: args.automationId,
    workflowId: args.workflowId,
  };
  if (!args.expiryEnabled) {
    return await dueWorkflowAutomationRows(db, common, signal);
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
      ...(await dueWorkflowAutomationRows(db, { ...common, mode }, signal)),
    );
  }
  return rows;
}

async function launchClaimedDueRow(
  args: {
    readonly poller: WorkflowPollerArgs;
    readonly row: DueWorkflowAutomationRow;
    readonly claimed: AutomationRow;
    readonly scheduledAnchorAt: Date | null;
    readonly journaled: boolean;
    readonly currentTime: Date;
    readonly expiryEnabled: boolean;
    readonly counters: PollCounters;
  },
  signal: AbortSignal,
): Promise<void> {
  const { poller, row, claimed, currentTime, counters } = args;
  const execution = journaledScheduleExecution(
    {
      db: poller.db,
      automation: claimed,
      scheduledAnchorAt: args.journaled ? args.scheduledAnchorAt : null,
      claimedAt: currentTime,
    },
    signal,
  );
  const chatThreadId = await tapError(
    ensureDueWorkflowAutomationChatThread(poller.db, row, currentTime),
    async (error) => {
      await execution.recordFailure(error);
      counters.skipped++;
    },
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
    startDueWorkflowAutomation(
      {
        startRun: poller.startRun,
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
      counters.skipped++;
    },
  );
  signal.throwIfAborted();
  if (!result) {
    return;
  }
  if (execution.unclaimed()) {
    if (args.expiryEnabled && args.scheduledAnchorAt) {
      await deferWorkflowSchedule(poller.db, {
        automationId: row.automation.id,
        anchor: args.scheduledAnchorAt,
        at: nowDate(),
        reason: "unavailable",
      });
    }
    counters.skipped++;
    return;
  }
  counters.executed++;
}

async function executeDueWorkflowAutomations(
  args: WorkflowPollerArgs,
  signal: AbortSignal,
): Promise<ExecuteResult> {
  const currentTime = nowDate();
  const expiryEnabled = scheduleExpiryEnabled();
  const rows = await loadDueWorkflowRows(
    args.db,
    {
      currentTime,
      automationId: args.automationId,
      workflowId: args.workflowId,
      expiryEnabled,
    },
    signal,
  );
  const counters: PollCounters = { executed: 0, skipped: 0, expired: 0 };
  const skipIfExpired = async (
    row: DueWorkflowAutomationRow,
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
    const outcome = await skipExpiredWorkflowSchedule(args.db, {
      automationId: row.automation.id,
      anchor,
      at,
    });
    if (outcome === "held") {
      await deferWorkflowSchedule(args.db, {
        automationId: row.automation.id,
        anchor,
        at,
        reason: "held",
      });
    }
    signal.throwIfAborted();
    if (outcome === "skipped") {
      counters.expired++;
    }
    counters.skipped++;
    return true;
  };

  const expiryContext = { db: args.db, currentTime, expiryEnabled };
  for (const row of rows) {
    if (await retireDepartedOwner(expiryContext, row, signal)) {
      counters.skipped++;
      continue;
    }
    // Retire an expired slot before the potentially expensive pause check.
    if (await skipIfExpired(row)) {
      continue;
    }
    if (
      !(await dueWorkflowAutomationIsFireable(
        args.db,
        row,
        currentTime,
        signal,
      ))
    ) {
      if (await skipIfExpired(row)) {
        continue;
      }
      if (expiryEnabled && row.automation.nextRunAt) {
        await deferWorkflowSchedule(args.db, {
          automationId: row.automation.id,
          anchor: row.automation.nextRunAt,
          at: nowDate(),
          reason: "not_fireable",
        });
      }
      counters.skipped++;
      continue;
    }
    if (await skipIfExpired(row)) {
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
      if (!(await skipIfExpired(row))) {
        counters.skipped++;
      }
      continue;
    }

    await launchClaimedDueRow(
      {
        poller: args,
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

// The test-only route exercises the same poller lanes without scanning another
// suite's concurrently due automations. Production ticks remain unscoped.
export const executeDueWorkflowAutomationsForWorkflow$ = command(
  async ({ set }, workflowId: string, signal: AbortSignal) => {
    return await executeDueWorkflowAutomations(
      {
        db: set(writeDb$),
        workflowId,
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
