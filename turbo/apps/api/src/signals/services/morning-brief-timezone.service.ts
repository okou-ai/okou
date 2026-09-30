import { MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { isValidTimeZone } from "@okouai/core/timezone";
import {
  morningBriefNativeOccurrences,
  morningBriefNativeSchedules,
} from "@okouai/db/schema/morning-brief-native-schedule";
import { morningBriefScheduleClaims } from "@okouai/db/schema/morning-brief-schedule-claim";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { parseRawRows } from "../../lib/db-raw-rows";
import { pgTextDecoder } from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import type { MorningBriefMemberIdentity } from "./morning-brief-enrollment-data.service";
import {
  MorningBriefSnapshotChanged,
  morningBriefLogicalChoicePlan,
  morningBriefNativeRowVersionCondition,
  morningBriefScheduleWhere,
  readMorningBriefNativeScheduleForWrite,
  withFreshMorningBriefSnapshot,
} from "./morning-brief-native-schedule.service";
import {
  awaitMorningBriefPreferenceCompatibility,
  morningBriefTimezoneTargetSql,
} from "./morning-brief-preference-sql";
import { calculateNextRun } from "./time-automation";

const timezoneTarget = z.object({
  workflowId: z.string(),
  timezone: z.string().nullable(),
});

function unsettledOccurrenceWhere(owner: MorningBriefMemberIdentity) {
  return and(
    eq(morningBriefNativeOccurrences.orgId, owner.orgId),
    eq(morningBriefNativeOccurrences.userId, owner.userId),
    isNull(morningBriefNativeOccurrences.settledAt),
  );
}

function automationTimezoneValues(
  row: typeof workflowAutomations.$inferSelect,
  timezone: string,
  at: Date,
) {
  if (
    row.scheduleType !== "cron" ||
    !row.cronExpression ||
    row.timezone === timezone
  ) {
    return undefined;
  }
  return {
    timezone,
    nextRunAt:
      row.enabled && row.nextRunAt
        ? calculateNextRun(row.cronExpression, timezone, at)
        : null,
    updatedAt: at,
  };
}

/**
 * A timezone edit preserves enabled choice and every admitted execution's epoch.
 *
 * No lock is held and no row is locked. The native row and each Morning Brief
 * automation are read with their row versions, their successors are computed
 * from the current cron and the timezone read in the same transaction, and
 * each is written with a conditional UPDATE on that version. A concurrent
 * settlement, toggle, reconciliation or timezone commit rolls the attempt back
 * and it recomputes from fresh state. An installation that commits after this
 * read runs this synchronization itself once installed, so one of the two
 * writers always observes the other.
 */
export const synchronizeMorningBriefTimezone$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly member: { readonly userId: string };
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const owner = { orgId: args.orgId, userId: args.member.userId };
    const db = set(writeDb$);
    signal.throwIfAborted();
    await awaitMorningBriefPreferenceCompatibility(db, owner);
    signal.throwIfAborted();
    await withFreshMorningBriefSnapshot(() => {
      return db.transaction(async (tx) => {
        const [target] = parseRawRows(
          timezoneTarget,
          await tx.execute(morningBriefTimezoneTargetSql(owner)),
        );
        if (!target?.timezone || !isValidTimeZone(target.timezone)) {
          return;
        }
        const { workflowId, timezone } = target;
        const native = await readMorningBriefNativeScheduleForWrite(tx, owner);
        const automations = await tx
          .select({
            row: workflowAutomations,
            rowVersion: sql`${workflowAutomations}.xmin::text`.mapWith(
              pgTextDecoder,
            ),
          })
          .from(workflowAutomations)
          .where(
            and(
              eq(workflowAutomations.workflowId, workflowId),
              eq(
                workflowAutomations.officialBlueprintKey,
                MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY,
              ),
            ),
          );
        const at = nowDate();
        if (native !== undefined) {
          const [occurrence] = await tx
            .select()
            .from(morningBriefNativeOccurrences)
            .where(unsettledOccurrenceWhere(owner))
            .orderBy(morningBriefNativeOccurrences.scheduledFor)
            .limit(1);
          const [claim] = await tx
            .select({ settlement: morningBriefScheduleClaims.settlement })
            .from(morningBriefScheduleClaims)
            .where(
              native.row.legacyAutomationId === null
                ? isNull(morningBriefScheduleClaims.automationId)
                : eq(
                    morningBriefScheduleClaims.automationId,
                    native.row.legacyAutomationId,
                  ),
            )
            .orderBy(desc(morningBriefScheduleClaims.claimSequence))
            .limit(1);
          const plan = morningBriefLogicalChoicePlan(
            native.row,
            { timezone },
            occurrence,
            native.row.phase === "legacy" &&
              native.row.legacyAutomationId !== null &&
              claim?.settlement === "unsettled",
            at,
          );
          const [applied] = await tx
            .update(morningBriefNativeSchedules)
            .set(plan.values)
            .where(
              and(
                morningBriefScheduleWhere(owner),
                morningBriefNativeRowVersionCondition(native.rowVersion),
              ),
            )
            .returning({
              ownerEpoch: morningBriefNativeSchedules.ownerEpoch,
            });
          if (applied === undefined) {
            throw new MorningBriefSnapshotChanged();
          }
        }
        for (const { row, rowVersion } of automations) {
          const values = automationTimezoneValues(row, timezone, at);
          if (values === undefined) {
            continue;
          }
          const [applied] = await tx
            .update(workflowAutomations)
            .set(values)
            .where(
              and(
                eq(workflowAutomations.id, row.id),
                sql`${workflowAutomations}.xmin::text = ${rowVersion}`,
              ),
            )
            .returning({ id: workflowAutomations.id });
          if (applied === undefined) {
            throw new MorningBriefSnapshotChanged();
          }
        }
        signal.throwIfAborted();
      });
    }, signal);
    signal.throwIfAborted();
  },
);
