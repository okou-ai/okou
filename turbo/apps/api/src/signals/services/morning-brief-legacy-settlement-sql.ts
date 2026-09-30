import { morningBriefNativeSchedules } from "@okouai/db/schema/morning-brief-native-schedule";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Tx } from "../../lib/db-types";
import { settle } from "../utils";
import { advanceTimeAutomationAfterCompletion } from "./time-automation";
import type {
  MorningBriefLegacyLineage,
  MorningBriefNativeScheduleRow,
} from "./morning-brief-native-schedule.service";

export interface LegacyMorningBriefSettlement {
  readonly enabled: boolean;
  readonly cronExpression: string | null;
  readonly timezone: string;
  readonly nextRunAt: Date | null;
  readonly at: Date;
}

/**
 * Final values of a legacy settlement, including explicit native revocation.
 *
 * Epoch alone does not fence a schedule or timezone edit, which deliberately
 * keeps the epoch. The choice and recurrence the settlement was computed from
 * are therefore part of the predicate, so a writer that did not lock the row
 * gets zero rows instead of overwriting a concurrent edit.
 */
export function settleLegacyMorningBriefSql(
  lineage: MorningBriefLegacyLineage,
  current: MorningBriefNativeScheduleRow,
  args: LegacyMorningBriefSettlement,
) {
  const revokes = args.enabled !== current.enabled;
  const nextRunAt = args.enabled ? args.nextRunAt : null;
  return sql`
    WITH updated AS (
      UPDATE morning_brief_native_schedules SET enabled = ${args.enabled},
        cron_expression = ${args.cronExpression}, timezone = ${args.timezone},
        owner_epoch = ${current.ownerEpoch + (revokes ? 1 : 0)},
        next_run_at = ${nextRunAt}, schedule_owner = ${nextRunAt === null ? null : "legacy"},
        updated_at = ${args.at}
      WHERE org_id = ${lineage.orgId} AND user_id = ${lineage.userId}
        AND owner_epoch = ${current.ownerEpoch} AND phase = 'legacy'
        AND enabled = ${current.enabled}
        AND cron_expression IS NOT DISTINCT FROM ${current.cronExpression}
        AND timezone = ${current.timezone}
        AND legacy_workflow_id = ${lineage.workflowId}::uuid
        AND legacy_automation_id = ${lineage.automationId}::uuid
      RETURNING owner_epoch
    ), revoked AS (
      UPDATE morning_brief_native_occurrences SET state = 'settled', outcome = 'revoked',
        settled_at = ${args.at}, lease_token = NULL, lease_expires_at = NULL,
        deferred_until = NULL, delivery_pending = false, updated_at = ${args.at}
      WHERE ${revokes} AND org_id = ${lineage.orgId} AND user_id = ${lineage.userId}
        AND owner_epoch = ${current.ownerEpoch} AND settled_at IS NULL
        AND EXISTS (SELECT 1 FROM updated)
    ) SELECT 1 FROM updated
  `;
}

/**
 * The in-flight settlement mirror, fenced on ownership but not on recurrence.
 *
 * Unlike {@link settleLegacyMorningBriefSql} it does not require the cron and
 * timezone it read: a schedule edit that committed in between is not a lost
 * race here, because {@link advanceInFlightSchedule} recomputes the successor
 * from the recurrence the automation write returns and rewrites this mirror
 * while it still holds the row.
 */
function settleInFlightLegacyMorningBriefSql(
  lineage: MorningBriefLegacyLineage,
  current: MorningBriefNativeScheduleRow,
  args: LegacyMorningBriefSettlement,
) {
  const revokes = args.enabled !== current.enabled;
  const nextRunAt = args.enabled ? args.nextRunAt : null;
  return sql`
    WITH updated AS (
      UPDATE morning_brief_native_schedules SET enabled = ${args.enabled},
        cron_expression = ${args.cronExpression}, timezone = ${args.timezone},
        owner_epoch = ${current.ownerEpoch + (revokes ? 1 : 0)},
        next_run_at = ${nextRunAt}, schedule_owner = ${nextRunAt === null ? null : "legacy"},
        updated_at = ${args.at}
      WHERE org_id = ${lineage.orgId} AND user_id = ${lineage.userId}
        AND owner_epoch = ${current.ownerEpoch} AND phase = 'legacy'
        AND enabled = ${current.enabled}
        AND legacy_workflow_id = ${lineage.workflowId}::uuid
        AND legacy_automation_id = ${lineage.automationId}::uuid
      RETURNING owner_epoch
    ), revoked AS (
      UPDATE morning_brief_native_occurrences SET state = 'settled', outcome = 'revoked',
        settled_at = ${args.at}, lease_token = NULL, lease_expires_at = NULL,
        deferred_until = NULL, delivery_pending = false, updated_at = ${args.at}
      WHERE ${revokes} AND org_id = ${lineage.orgId} AND user_id = ${lineage.userId}
        AND owner_epoch = ${current.ownerEpoch} AND settled_at IS NULL
        AND EXISTS (SELECT 1 FROM updated)
    ) SELECT 1 FROM updated
  `;
}

/** A newer toggle, cutover, revocation or settlement already owns the successor. */
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
  readonly shouldDisable: boolean;
  readonly at: Date;
  /** Only an empty (in-flight) slot may be advanced; a published one wins. */
  readonly requireEmptySlot: boolean;
  /** The selected legacy Morning Brief mirror, written first per lock order. */
  readonly legacy?: {
    readonly lineage: MorningBriefLegacyLineage;
    readonly row: MorningBriefNativeScheduleRow;
  };
}

/**
 * Advance an in-flight schedule once, from the recurrence committed at write time.
 *
 * Runs in a savepoint and never re-reads or retries. The native mirror and the
 * automation are conditional UPDATEs (native first, per the documented order).
 * Zero rows means another writer already published, revoked or cut over the
 * successor: the savepoint rolls back and the result is `superseded`, the same
 * outcome a fresh read would produce. The automation write returns the
 * recurrence it committed against; if a cron or timezone edit landed after the
 * read, the successor is recomputed from those returned columns and rewritten
 * while this transaction still holds both rows, so the edit applies to this
 * settlement as documented.
 */
export async function advanceInFlightSchedule(
  tx: Tx,
  args: InFlightScheduleAdvance,
): Promise<"advanced" | "superseded"> {
  const result = await settle(
    tx.transaction(async (sp) => {
      if (args.legacy) {
        const { rowCount } = await sp.execute(
          settleInFlightLegacyMorningBriefSql(
            args.legacy.lineage,
            args.legacy.row,
            {
              enabled: !args.shouldDisable,
              cronExpression: args.read.cronExpression,
              timezone: args.read.timezone,
              nextRunAt: args.automationValues.nextRunAt,
              at: args.at,
            },
          ),
        );
        if (rowCount !== 1) {
          throw new InFlightScheduleSuperseded();
        }
      }
      const [committed] = await sp
        .update(workflowAutomations)
        .set(args.automationValues)
        .where(
          and(
            eq(workflowAutomations.id, args.automationId),
            eq(workflowAutomations.enabled, true),
            args.requireEmptySlot
              ? isNull(workflowAutomations.nextRunAt)
              : undefined,
          ),
        )
        .returning({
          scheduleType: workflowAutomations.scheduleType,
          cronExpression: workflowAutomations.cronExpression,
          intervalSeconds: workflowAutomations.intervalSeconds,
          timezone: workflowAutomations.timezone,
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
        shouldDisable: args.shouldDisable,
      });
      await sp
        .update(workflowAutomations)
        .set({ nextRunAt })
        .where(eq(workflowAutomations.id, args.automationId));
      if (args.legacy) {
        await sp
          .update(morningBriefNativeSchedules)
          .set({
            cronExpression: committed.cronExpression,
            timezone: committed.timezone,
            nextRunAt,
            scheduleOwner: nextRunAt === null ? null : "legacy",
          })
          .where(
            and(
              eq(morningBriefNativeSchedules.orgId, args.legacy.lineage.orgId),
              eq(
                morningBriefNativeSchedules.userId,
                args.legacy.lineage.userId,
              ),
            ),
          );
      }
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
