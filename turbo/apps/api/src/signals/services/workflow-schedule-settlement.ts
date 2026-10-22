import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { and, eq, isNull, sql } from "drizzle-orm";
import { advanceTimeAutomationAfterCompletion } from "./time-automation";
import { scheduleFailurePauseValues } from "./workflow-schedule-failure-policy";

type ScheduleInputs = Pick<
  typeof workflowAutomations.$inferSelect,
  "scheduleType" | "cronExpression" | "intervalSeconds" | "timezone"
>;

function sameScheduleInputs(left: ScheduleInputs, right: ScheduleInputs) {
  return (
    left.scheduleType === right.scheduleType &&
    left.cronExpression === right.cronExpression &&
    left.intervalSeconds === right.intervalSeconds &&
    left.timezone === right.timezone
  );
}

export interface InFlightScheduleAdvance {
  readonly automationId: string;
  /** The recurrence the successor below was computed from. */
  readonly read: ScheduleInputs & { readonly scheduleType: "cron" | "loop" };
  readonly automationValues: {
    readonly consecutiveFailures: number;
    readonly enabled?: boolean;
    readonly nextRunAt: Date | null;
    readonly updatedAt: Date;
  };
  /** Ordinary callbacks count the committed value, not their read snapshot. */
  readonly ordinaryFailure?: {
    readonly reset: boolean;
    readonly increment: number;
    readonly disableAt: number;
  };
  readonly at: Date;
  /** Only an empty (in-flight) slot may be advanced; a published one wins. */
  readonly requireEmptySlot: boolean;
  /** A pre-journal callback cannot publish into a journaled execution lineage. */
  readonly requireUnjournaledSlot?: boolean;
}

/**
 * Statement data only; each caller owns rollback in its existing transaction.
 * A zero-row UPDATE may retain tuple locks until that outer transaction ends.
 */
export function inFlightScheduleAdvanceValues(args: InFlightScheduleAdvance) {
  const ordinary = args.ordinaryFailure;
  const nextCount = ordinary?.reset
    ? sql`0`
    : sql`${workflowAutomations.consecutiveFailures} + ${ordinary?.increment ?? 0}`;
  const disable =
    ordinary && !ordinary.reset && ordinary.increment > 0
      ? sql`${nextCount} >= ${ordinary.disableAt}`
      : sql`false`;
  return {
    ...args.automationValues,
    ...(ordinary
      ? {
          consecutiveFailures: nextCount,
          ...scheduleFailurePauseValues(
            disable,
            args.automationValues.nextRunAt,
          ),
        }
      : {}),
  };
}

export function inFlightScheduleAdvanceCondition(
  args: InFlightScheduleAdvance,
) {
  return and(
    eq(workflowAutomations.id, args.automationId),
    eq(workflowAutomations.enabled, true),
    args.requireEmptySlot ? isNull(workflowAutomations.nextRunAt) : undefined,
    args.requireUnjournaledSlot
      ? sql`NOT EXISTS (SELECT 1 FROM morning_brief_schedule_claims WHERE automation_id = ${args.automationId}::uuid)`
      : undefined,
  );
}

export function inFlightScheduleAdvanceSelection() {
  return {
    scheduleType: workflowAutomations.scheduleType,
    cronExpression: workflowAutomations.cronExpression,
    intervalSeconds: workflowAutomations.intervalSeconds,
    timezone: workflowAutomations.timezone,
    enabled: workflowAutomations.enabled,
    nextRunAt: workflowAutomations.nextRunAt,
  };
}

/** Recompute from the committed recurrence using the caller's original instant. */
export function inFlightScheduleCorrection(
  committed: ScheduleInputs & {
    readonly enabled: boolean;
    readonly nextRunAt: Date | null;
  },
  args: InFlightScheduleAdvance,
) {
  if (
    sameScheduleInputs(committed, args.read) ||
    (committed.scheduleType !== "cron" && committed.scheduleType !== "loop")
  ) {
    return undefined;
  }
  return {
    nextRunAt: advanceTimeAutomationAfterCompletion({
      scheduleType: committed.scheduleType,
      cronExpression: committed.cronExpression,
      intervalSeconds: committed.intervalSeconds,
      timezone: committed.timezone,
      completedAt: args.at,
      shouldDisable: !committed.enabled && committed.nextRunAt === null,
    }),
  };
}
