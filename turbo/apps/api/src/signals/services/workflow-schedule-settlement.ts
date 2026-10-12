import { workflowAutomations } from "@okouai/db/schema/workflow";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Tx } from "../../lib/db-types";
import { settle } from "../utils";
import { advanceTimeAutomationAfterCompletion } from "./time-automation";

/** A newer toggle, revocation or settlement already owns the successor. */
class InFlightScheduleSuperseded extends Error {}

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
    readonly officialIntendedEnabled?: boolean;
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

/** Advance once under the Official row's enabled/empty-slot fence, applying concurrent recurrence edits. */
export async function advanceInFlightSchedule(
  tx: Tx,
  args: InFlightScheduleAdvance,
): Promise<"advanced" | "superseded"> {
  const result = await settle(
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0345; new non-billing transactions are prohibited.
    tx.transaction(async (sp) => {
      const ordinary = args.ordinaryFailure;
      const nextCount = ordinary?.reset
        ? sql`0`
        : sql`${workflowAutomations.consecutiveFailures} + ${ordinary?.increment ?? 0}`;
      const disable =
        ordinary && !ordinary.reset && ordinary.increment > 0
          ? sql`${nextCount} >= ${ordinary.disableAt}`
          : sql`false`;
      const [committed] = await sp
        .update(workflowAutomations)
        .set({
          ...args.automationValues,
          ...(ordinary
            ? {
                consecutiveFailures: nextCount,
                officialIntendedEnabled: sql`CASE WHEN ${disable} AND ${workflowAutomations.officialBlueprintKey} = 'daily-delivery' THEN false ELSE ${workflowAutomations.officialIntendedEnabled} END`,
                enabled: sql`CASE WHEN ${disable} THEN false ELSE ${workflowAutomations.enabled} END`,
                nextRunAt: sql`CASE WHEN ${disable} THEN NULL ELSE ${args.automationValues.nextRunAt}::timestamp END`,
              }
            : {}),
        })
        .where(
          and(
            eq(workflowAutomations.id, args.automationId),
            eq(workflowAutomations.enabled, true),
            args.requireEmptySlot
              ? isNull(workflowAutomations.nextRunAt)
              : undefined,
            args.requireUnjournaledSlot
              ? sql`NOT EXISTS (SELECT 1 FROM morning_brief_schedule_claims WHERE automation_id = ${args.automationId}::uuid)`
              : undefined,
          ),
        )
        .returning({
          scheduleType: workflowAutomations.scheduleType,
          cronExpression: workflowAutomations.cronExpression,
          intervalSeconds: workflowAutomations.intervalSeconds,
          timezone: workflowAutomations.timezone,
          enabled: workflowAutomations.enabled,
        });
      if (committed === undefined) {
        throw new InFlightScheduleSuperseded();
      }
      if (
        sameScheduleInputs(committed, args.read) ||
        (committed.scheduleType !== "cron" && committed.scheduleType !== "loop")
      ) {
        return "advanced" as const;
      }
      const nextRunAt = advanceTimeAutomationAfterCompletion({
        scheduleType: committed.scheduleType,
        cronExpression: committed.cronExpression,
        intervalSeconds: committed.intervalSeconds,
        timezone: committed.timezone,
        completedAt: args.at,
        shouldDisable: !committed.enabled,
      });
      await sp
        .update(workflowAutomations)
        .set({ nextRunAt })
        .where(eq(workflowAutomations.id, args.automationId));
      return "advanced" as const;
    }),
  );
  if (result.ok) {
    return result.value;
  }
  if (result.error instanceof InFlightScheduleSuperseded) {
    return "superseded";
  }
  throw result.error;
}
