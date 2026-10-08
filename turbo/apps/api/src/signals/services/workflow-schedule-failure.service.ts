import { MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { chatAutomationContext } from "@okouai/db/schema/chat-automation-context";
import { morningBriefScheduleClaims } from "@okouai/db/schema/morning-brief-schedule-claim";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";

import { pgTextDecoder } from "../../lib/db-structured-result";

import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { settle } from "../utils";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import { settleMorningBriefSchedulePreRunFailure$ } from "./morning-brief-schedule-claim.service";
import { calculateNextRun } from "./time-automation";
import type { AutomationRow } from "./workflow-automation-enqueue.service";

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

/** A concurrent writer changed the selected Official automation. */
class StalePreRunFailure extends Error {}

const STALE_PRE_RUN_FAILURE = {
  disabled: false,
  consecutiveFailures: 0,
} as const;

function preRunFailureOutcome(
  counted: { readonly consecutiveFailures: number },
  failure: PreRunFailure,
) {
  return {
    disabled:
      !failure.isCreditError &&
      counted.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES,
    consecutiveFailures: counted.consecutiveFailures,
  };
}

interface PreRunFailureInput {
  readonly automation: AutomationRow;
  readonly failure: PreRunFailure;
  readonly stillDueAt?: Date;
}

/** Count only the still-due Official row version; a winning concurrent writer remains authoritative. */
const recordSelectedMorningBriefPreRunFailure$ = command(
  async (
    { set },
    args: PreRunFailureInput,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const { automation, failure, stillDueAt } = args;
    if (
      automation.officialBlueprintKey !== MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY
    ) {
      return false;
    }
    const db = set(writeDb$);
    const settled = await settle(
      db.transaction(async (tx) => {
        const [current] = await tx
          .select({
            ...workflowAutomationColumns(),
            rowVersion: sql`${workflowAutomations}.xmin::text`.mapWith(
              pgTextDecoder,
            ),
          })
          .from(workflowAutomations)
          .where(eq(workflowAutomations.id, automation.id))
          .limit(1);
        if (
          !current ||
          (stillDueAt !== undefined &&
            current.nextRunAt?.getTime() !== stillDueAt.getTime()) ||
          (current.scheduleType !== "once" && !current.enabled)
        ) {
          return STALE_PRE_RUN_FAILURE;
        }
        const failureTime = nowDate();
        const shouldDisable =
          !failure.isCreditError &&
          current.consecutiveFailures + 1 >= MAX_CONSECUTIVE_FAILURES;
        const nextRunAt = advanceAfterPreRunFailure(
          current,
          failureTime,
          shouldDisable,
        );
        const [updated] = await tx
          .update(workflowAutomations)
          .set({
            consecutiveFailures: sql`${workflowAutomations.consecutiveFailures} + ${failure.isCreditError ? 0 : 1}`,
            ...(shouldDisable
              ? { enabled: false, officialIntendedEnabled: false }
              : {}),
            nextRunAt,
            updatedAt: failureTime,
          })
          .where(
            and(
              eq(workflowAutomations.id, current.id),
              sql`${workflowAutomations}.xmin::text = ${current.rowVersion}`,
            ),
          )
          .returning({
            consecutiveFailures: workflowAutomations.consecutiveFailures,
          });
        if (!updated) {
          throw new StalePreRunFailure();
        }
        signal.throwIfAborted();
        return preRunFailureOutcome(updated, failure);
      }),
      signal,
    );
    signal.throwIfAborted();
    if (!settled.ok && !(settled.error instanceof StalePreRunFailure)) {
      throw settled.error;
    }
    const outcome = settled.ok ? settled.value : STALE_PRE_RUN_FAILURE;
    if (outcome === undefined) {
      return false;
    }
    if (outcome.disabled) {
      log.debug(
        "Workflow automation auto-disabled after consecutive failures",
        {
          automationId: automation.id,
          workflowId: automation.workflowId,
          orgId: automation.orgId,
          userId: automation.ownerUserId,
          error: failure.message,
          consecutiveFailures: outcome.consecutiveFailures,
        },
      );
    }
    return true;
  },
);

/** Only a still-unconsumed anchor may publish a pre-claim failure successor. */
export const recordPreRunFailure$ = command(
  async (
    { set },
    args: PreRunFailureInput,
    signal: AbortSignal,
  ): Promise<void> => {
    const { automation, failure, stillDueAt } = args;
    if (await set(recordSelectedMorningBriefPreRunFailure$, args, signal)) {
      return;
    }
    const db = set(writeDb$);
    const failureTime = nowDate();
    const increment = failure.isCreditError ? 0 : 1;
    const threshold = sql`${workflowAutomations.consecutiveFailures} + ${increment} >= ${MAX_CONSECUTIVE_FAILURES}`;
    const nextRunAt = advanceAfterPreRunFailure(automation, failureTime, false);
    const [updated] = await db
      .update(workflowAutomations)
      .set({
        consecutiveFailures: sql`${workflowAutomations.consecutiveFailures} + ${increment}`,
        ...(failure.isCreditError
          ? {}
          : {
              enabled: sql`CASE WHEN ${threshold} THEN false ELSE ${workflowAutomations.enabled} END`,
            }),
        nextRunAt: failure.isCreditError
          ? nextRunAt
          : sql`CASE WHEN ${threshold} THEN NULL ELSE ${nextRunAt}::timestamp END`,
        updatedAt: failureTime,
      })
      .where(
        and(
          eq(workflowAutomations.id, automation.id),
          automation.scheduleType === "once"
            ? undefined
            : eq(workflowAutomations.enabled, true),
          stillDueAt
            ? eq(workflowAutomations.nextRunAt, stillDueAt)
            : undefined,
        ),
      )
      .returning({
        consecutiveFailures: workflowAutomations.consecutiveFailures,
      });
    signal.throwIfAborted();
    if (
      !failure.isCreditError &&
      updated &&
      updated.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES
    ) {
      log.debug(
        "Workflow automation auto-disabled after consecutive failures",
        {
          automationId: automation.id,
          workflowId: automation.workflowId,
          orgId: automation.orgId,
          userId: automation.ownerUserId,
          error: failure.message,
          consecutiveFailures: updated.consecutiveFailures,
        },
      );
    }
  },
);

export const settleJournaledSchedulePreRunFailure$ = command(
  async (
    { set },
    args: {
      readonly automation: AutomationRow;
      readonly claimId: string;
      readonly failure: PreRunFailure;
    },
    signal?: AbortSignal,
  ): Promise<void> => {
    await set(
      settleMorningBriefSchedulePreRunFailure$,
      {
        automationId: args.automation.id,
        claimId: args.claimId,
        isCreditError: args.failure.isCreditError,
      },
      signal,
    );
  },
);

/** Resolve the exact rejected input before settling its own schedule occurrence. */
export const settleRejectedAutomationInput$ = command(
  async (
    { set },
    args: {
      readonly contextId: string | null;
      readonly queueEventId: string;
      readonly error: { readonly code: string; readonly message: string };
    },
    signal: AbortSignal,
  ): Promise<void> => {
    if (args.contextId === null) {
      return;
    }
    const db = set(writeDb$);
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
    const failure = {
      message: `${args.error.code}: ${args.error.message}`,
      isCreditError: args.error.code === "INSUFFICIENT_CREDITS",
    };
    const [claim] = await db
      .select({ id: morningBriefScheduleClaims.id })
      .from(morningBriefScheduleClaims)
      .where(eq(morningBriefScheduleClaims.queueEventId, args.queueEventId))
      .limit(1);
    signal.throwIfAborted();
    if (claim) {
      await set(
        settleJournaledSchedulePreRunFailure$,
        { automation, claimId: claim.id, failure },
        signal,
      );
    } else {
      await set(recordPreRunFailure$, { automation, failure }, signal);
    }
  },
);
