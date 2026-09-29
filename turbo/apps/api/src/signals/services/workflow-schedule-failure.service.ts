import { MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { chatAutomationContext } from "@okouai/db/schema/chat-automation-context";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { and, eq } from "drizzle-orm";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import {
  lockMorningBriefLegacyWriterAuthority,
  settleSelectedLegacyMorningBriefObligation,
} from "./morning-brief-native-schedule.service";
import {
  morningBriefScheduleClaimIdForQueueEvent,
  settleMorningBriefSchedulePreRunFailure,
} from "./morning-brief-schedule-claim.service";
import { calculateNextRun } from "./time-automation";
import type { AutomationRow } from "./pick-chat-run.service";

const log = logger("WorkflowScheduleFailure");

const MAX_CONSECUTIVE_FAILURES = 3;

/** A schedule tick that started no run, as its schedule accounting sees it. */
interface PreRunFailure {
  readonly message: string;
  readonly isCreditError: boolean;
}

/** A tick that threw before its queue input committed. */
export function preRunFailureFromError(error: unknown): PreRunFailure {
  return {
    message: error instanceof Error ? error.message : String(error),
    isCreditError: false,
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

function logPreRunFailure(
  automation: AutomationRow,
  failure: PreRunFailure,
): void {
  const context = {
    automationId: automation.id,
    workflowId: automation.workflowId,
    orgId: automation.orgId,
    userId: automation.ownerUserId,
    error: failure.message,
  };
  if (failure.isCreditError) {
    log.debug("Workflow automation skipped: insufficient credits", context);
  } else {
    log.error("Workflow automation pre-run failed", context);
  }
}

async function recordSelectedMorningBriefPreRunFailure(
  db: Db,
  automation: AutomationRow,
  failure: PreRunFailure,
  signal: AbortSignal,
  stillDueAt?: Date,
): Promise<boolean> {
  if (
    automation.officialBlueprintKey !== MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY ||
    automation.ownerUserId === null
  ) {
    return false;
  }
  const isCreditError = failure.isCreditError;
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
      error: failure.message,
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
export async function recordPreRunFailure(
  db: Db,
  automation: AutomationRow,
  failure: PreRunFailure,
  signal: AbortSignal,
  stillDueAt?: Date,
): Promise<void> {
  const isCreditError = failure.isCreditError;
  const context = {
    automationId: automation.id,
    workflowId: automation.workflowId,
    orgId: automation.orgId,
    userId: automation.ownerUserId,
    error: failure.message,
  };
  logPreRunFailure(automation, failure);

  if (
    await recordSelectedMorningBriefPreRunFailure(
      db,
      automation,
      failure,
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

/** Settle a journaled Morning Brief occurrence whose tick started no run. */
export async function settleJournaledSchedulePreRunFailure(
  db: Db,
  args: {
    readonly automation: AutomationRow;
    readonly claimId: string;
    readonly failure: PreRunFailure;
  },
): Promise<void> {
  await settleMorningBriefSchedulePreRunFailure(db, {
    automationId: args.automation.id,
    claimId: args.claimId,
    isCreditError: args.failure.isCreditError,
  });
  logPreRunFailure(args.automation, args.failure);
}

/**
 * A scheduled tick the pick rejected started no run, so no completion
 * callback advances its schedule. Settle it as a pre-run failure: a journaled
 * Morning Brief occurrence through its claim, any other tick through the
 * automation's failure count and next run.
 */
async function settleRejectedScheduleTick(
  db: Db,
  args: {
    readonly automation: AutomationRow;
    readonly queueEventId: string;
    readonly error: { readonly code: string; readonly message: string };
  },
  signal: AbortSignal,
): Promise<void> {
  const failure: PreRunFailure = {
    message: `${args.error.code}: ${args.error.message}`,
    isCreditError: args.error.code === "INSUFFICIENT_CREDITS",
  };
  const claimId = await morningBriefScheduleClaimIdForQueueEvent(
    db,
    args.queueEventId,
  );
  signal.throwIfAborted();
  if (claimId !== null) {
    await settleJournaledSchedulePreRunFailure(db, {
      automation: args.automation,
      claimId,
      failure,
    });
    return;
  }
  await recordPreRunFailure(db, args.automation, failure, signal);
}

/**
 * Recover the producer's settlement from the durable input, even when the
 * assembler failed before it could read the automation. Only the consumer
 * that persisted the rejection calls this; a competing consumer does not
 * advance the same schedule again.
 */
export async function settleRejectedAutomationInput(
  db: Db,
  args: {
    readonly contextId: string | null;
    readonly queueEventId: string;
    readonly error: { readonly code: string; readonly message: string };
  },
  signal: AbortSignal,
): Promise<void> {
  if (args.contextId === null) {
    return;
  }
  const [context] = await db
    .select({ automationId: chatAutomationContext.automationId })
    .from(chatAutomationContext)
    .where(
      and(
        eq(chatAutomationContext.id, args.contextId),
        eq(chatAutomationContext.eventType, "schedule"),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!context) {
    return;
  }
  const [automation] = await db
    .select(workflowAutomationColumns())
    .from(workflowAutomations)
    .where(eq(workflowAutomations.id, context.automationId))
    .limit(1);
  signal.throwIfAborted();
  if (!automation) {
    return;
  }
  await settleRejectedScheduleTick(
    db,
    { automation, queueEventId: args.queueEventId, error: args.error },
    signal,
  );
}
