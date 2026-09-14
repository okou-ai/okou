import { MORNING_BRIEF_OFFICIAL_DEFINITION_NAME } from "@okouai/api-contracts/contracts/morning-brief-preference";
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
import { workflowAutomationCanFire } from "./workflow-automation-access.service";
import { buildWorkflowScheduleAutomationBrief } from "./workflow-automation-brief.service";
import { ensureWorkflowUserAutomationThread } from "./workflow-user-automation-thread.service";
import { hasMorningBriefSources } from "./morning-brief-sources.service";

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
  readonly officialDefinitionName: string | null;
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
  },
  signal: AbortSignal,
): Promise<RunWorkflowAutomationResult> {
  const { automation } = args.due;
  return await args.startRun(
    {
      due: args.due,
      automationContext: args.scheduleContext,
      apiStartTime: now(),
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

function nextRunAfterSkippedExecution(
  automation: AutomationRow,
  after: Date,
): Date | null {
  if (automation.scheduleType === "cron" && automation.cronExpression) {
    return calculateNextRun(
      automation.cronExpression,
      automation.timezone,
      after,
    );
  }
  if (automation.scheduleType === "loop" && automation.intervalSeconds) {
    return new Date(after.getTime() + automation.intervalSeconds * 1000);
  }
  return null;
}

async function recordPreRunFailure(
  db: Db,
  automation: AutomationRow,
  error: unknown,
  signal: AbortSignal,
): Promise<void> {
  const isCreditError = isInsufficientCreditsFailure(error);
  const context = {
    automationId: automation.id,
    workflowId: automation.workflowId,
    orgId: automation.orgId,
    userId: automation.ownerUserId,
    error: failureMessage(error),
  };
  if (isCreditError) {
    log.debug("Workflow automation skipped: insufficient credits", context);
  } else {
    log.error("Workflow automation pre-run failed", context);
  }

  const failureTime = nowDate();
  const newFailureCount = isCreditError
    ? automation.consecutiveFailures
    : automation.consecutiveFailures + 1;
  const shouldDisable =
    !isCreditError && newFailureCount >= MAX_CONSECUTIVE_FAILURES;
  const nextRunAt = shouldDisable
    ? null
    : nextRunAfterSkippedExecution(automation, failureTime);
  const automationIsStillEligible =
    automation.scheduleType === "once"
      ? eq(workflowAutomations.id, automation.id)
      : and(
          eq(workflowAutomations.id, automation.id),
          eq(workflowAutomations.enabled, true),
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
      officialDefinitionName: workflows.officialDefinitionName,
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

async function skipEmptyMorningBrief(
  db: Db,
  row: DueWorkflowAutomationRow,
  currentTime: Date,
  signal: AbortSignal,
): Promise<boolean> {
  if (
    row.officialDefinitionName !== MORNING_BRIEF_OFFICIAL_DEFINITION_NAME ||
    !row.automation.nextRunAt ||
    (await hasMorningBriefSources(
      db,
      {
        orgId: row.automation.orgId,
        userId: row.automation.ownerUserId,
        excludedThreadId: row.chatThreadId,
      },
      signal,
    ))
  ) {
    return false;
  }
  // Advance only this occurrence. No Run was attempted, so preserve the
  // last-run history and failure count and keep future delivery enabled.
  await db
    .update(workflowAutomations)
    .set({
      nextRunAt: nextRunAfterSkippedExecution(row.automation, currentTime),
      updatedAt: currentTime,
    })
    .where(
      and(
        eq(workflowAutomations.id, row.automation.id),
        eq(workflowAutomations.enabled, true),
        eq(workflowAutomations.nextRunAt, row.automation.nextRunAt),
      ),
    );
  signal.throwIfAborted();
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
    const ownerIsMember = await hasOrgMembership(args.db, {
      orgId: row.automation.orgId,
      userId: row.automation.ownerUserId,
    });
    signal.throwIfAborted();
    if (!ownerIsMember) {
      log.warn(
        "Disabling workflow automation: owner is no longer an org member",
        {
          automationId: row.automation.id,
          orgId: row.automation.orgId,
          userId: row.automation.ownerUserId,
        },
      );
      await args.db
        .update(workflowAutomations)
        .set({ enabled: false, nextRunAt: null, updatedAt: currentTime })
        .where(eq(workflowAutomations.id, row.automation.id));
      signal.throwIfAborted();
      skipped++;
      continue;
    }

    const canFire = await workflowAutomationCanFire(
      args.db,
      {
        automation: row.automation,
        agentId: row.agentId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!canFire) {
      log.debug("Workflow automation skipped: automation is paused", {
        automationId: row.automation.id,
        workflowId: row.automation.workflowId,
        agentId: row.agentId,
        orgId: row.automation.orgId,
        userId: row.automation.ownerUserId,
      });
      skipped++;
      continue;
    }

    if (await skipEmptyMorningBrief(args.db, row, currentTime, signal)) {
      skipped++;
      continue;
    }

    const claimed = await claimAutomation(args.db, row.automation, currentTime);
    signal.throwIfAborted();
    if (!claimed) {
      skipped++;
      continue;
    }

    const chatThreadId = await tapError(
      ensureDueWorkflowAutomationChatThread(args.db, row, currentTime),
      async (error) => {
        await recordPreRunFailure(args.db, claimed, error, signal);
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
        { startRun: args.startRun, due, row, currentTime, scheduleContext },
        signal,
      ),
      async (error) => {
        await recordPreRunFailure(args.db, claimed, error, signal);
        skipped++;
      },
    );
    signal.throwIfAborted();
    if (!result) {
      continue;
    }
    if (result.kind === "enqueued") {
      executed++;
      continue;
    }
    if (result.kind !== "ok") {
      await recordPreRunFailure(args.db, claimed, result, signal);
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
