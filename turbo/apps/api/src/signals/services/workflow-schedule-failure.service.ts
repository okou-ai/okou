import { MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { chatAutomationContext } from "@okouai/db/schema/chat-automation-context";
import { command } from "ccstate";
import { morningBriefNativeSchedules } from "@okouai/db/schema/morning-brief-native-schedule";
import { morningBriefScheduleClaims } from "@okouai/db/schema/morning-brief-schedule-claim";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { and, eq } from "drizzle-orm";

import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import {
  morningBriefNativeOwnerCompatibilitySql,
  morningBriefScheduleWhere,
  morningBriefLegacyWriterAuthorityFromRow,
} from "./morning-brief-native-schedule.service";
import { settleLegacyMorningBriefSql } from "./morning-brief-legacy-settlement-sql";
import { settleMorningBriefSchedulePreRunFailure$ } from "./morning-brief-schedule-claim.service";
import { calculateNextRun } from "./time-automation";
import type { AutomationRow } from "./workflow-automation-launch.service";

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

interface PreRunFailureInput {
  readonly automation: AutomationRow;
  readonly failure: PreRunFailure;
  readonly stillDueAt?: Date;
}

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
    const lineage = {
      orgId: automation.orgId,
      userId: automation.ownerUserId,
      workflowId: automation.workflowId,
      automationId: automation.id,
    };
    const outcome = await db.transaction(async (tx) => {
      let [native] = await tx
        .select()
        .from(morningBriefNativeSchedules)
        .where(morningBriefScheduleWhere(lineage))
        .limit(1)
        .for("update");
      if (!native) {
        await tx.execute(morningBriefNativeOwnerCompatibilitySql(lineage));
        [native] = await tx
          .select()
          .from(morningBriefNativeSchedules)
          .where(morningBriefScheduleWhere(lineage))
          .limit(1)
          .for("update");
      }
      const authority = morningBriefLegacyWriterAuthorityFromRow(
        native,
        lineage,
      );
      if (authority.kind === "ordinary") {
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
        !current ||
        authority.row.phase !== "legacy" ||
        (stillDueAt !== undefined &&
          current.nextRunAt?.getTime() !== stillDueAt.getTime()) ||
        (current.scheduleType !== "once" && !current.enabled)
      ) {
        return { disabled: false, consecutiveFailures: 0 };
      }
      const failureTime = nowDate();
      const consecutiveFailures =
        current.consecutiveFailures + (failure.isCreditError ? 0 : 1);
      const shouldDisable =
        !failure.isCreditError &&
        consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
      const nextRunAt = advanceAfterPreRunFailure(
        current,
        failureTime,
        shouldDisable,
      );
      await tx
        .update(workflowAutomations)
        .set({
          consecutiveFailures,
          ...(shouldDisable
            ? { enabled: false, officialIntendedEnabled: false }
            : {}),
          nextRunAt,
          updatedAt: failureTime,
        })
        .where(eq(workflowAutomations.id, current.id));
      const { rowCount } = await tx.execute(
        settleLegacyMorningBriefSql(lineage, authority.row, {
          enabled: !shouldDisable,
          cronExpression: current.cronExpression,
          timezone: current.timezone,
          nextRunAt,
          at: failureTime,
        }),
      );
      if (rowCount !== 1) {
        throw new Error("Morning Brief settlement authority changed");
      }
      signal.throwIfAborted();
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
    logPreRunFailure(automation, failure);
    if (await set(recordSelectedMorningBriefPreRunFailure$, args, signal)) {
      return;
    }
    const db = set(writeDb$);
    const failureTime = nowDate();
    const newFailureCount =
      automation.consecutiveFailures + (failure.isCreditError ? 0 : 1);
    const shouldDisable =
      !failure.isCreditError && newFailureCount >= MAX_CONSECUTIVE_FAILURES;
    const nextRunAt = advanceAfterPreRunFailure(
      automation,
      failureTime,
      shouldDisable,
    );
    await db
      .update(workflowAutomations)
      .set({
        consecutiveFailures: newFailureCount,
        ...(shouldDisable ? { enabled: false } : {}),
        nextRunAt,
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
      );
    signal.throwIfAborted();
    if (shouldDisable) {
      log.warn("Workflow automation auto-disabled after consecutive failures", {
        automationId: automation.id,
        workflowId: automation.workflowId,
        orgId: automation.orgId,
        userId: automation.ownerUserId,
        error: failure.message,
        consecutiveFailures: newFailureCount,
      });
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
    logPreRunFailure(args.automation, args.failure);
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
