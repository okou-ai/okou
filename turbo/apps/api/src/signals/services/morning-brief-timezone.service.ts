import { MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { isValidTimeZone } from "@okouai/core/timezone";
import {
  morningBriefNativeOccurrences,
  morningBriefNativeSchedules,
} from "@okouai/db/schema/morning-brief-native-schedule";
import { morningBriefScheduleClaims } from "@okouai/db/schema/morning-brief-schedule-claim";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, desc, eq, isNull } from "drizzle-orm";
import { delay } from "signal-timers";
import { z } from "zod";
import { parseRawRows } from "../../lib/db-raw-rows";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import type { MorningBriefMemberIdentity } from "./morning-brief-enrollment-data.service";
import {
  morningBriefLogicalChoicePlan,
  morningBriefNativeOwnerCompatibilitySql,
  morningBriefScheduleWhere,
} from "./morning-brief-native-schedule.service";
import {
  morningBriefPreferenceCompatibilitySql,
  morningBriefTimezoneTargetSql,
} from "./morning-brief-preference-sql";
import { calculateNextRun } from "./time-automation";

const lockRow = z.object({ acquired: z.boolean() });
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

/** A timezone edit preserves enabled choice and every admitted execution's epoch. */
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
    while (true) {
      signal.throwIfAborted();
      const acquired = await db.transaction(async (tx) => {
        const lock = parseRawRows(
          lockRow,
          await tx.execute(morningBriefPreferenceCompatibilitySql(owner)),
        );
        if (lock[0]?.acquired !== true) {
          return false;
        }
        const [target] = parseRawRows(
          timezoneTarget,
          await tx.execute(morningBriefTimezoneTargetSql(owner)),
        );
        if (!target?.timezone || !isValidTimeZone(target.timezone)) {
          return true;
        }
        const { workflowId, timezone } = target;
        let [native] = await tx
          .select()
          .from(morningBriefNativeSchedules)
          .where(morningBriefScheduleWhere(owner))
          .limit(1)
          .for("update");
        if (native === undefined) {
          await tx.execute(morningBriefNativeOwnerCompatibilitySql(owner));
          [native] = await tx
            .select()
            .from(morningBriefNativeSchedules)
            .where(morningBriefScheduleWhere(owner))
            .limit(1)
            .for("update");
        }
        const automations = await tx
          .select()
          .from(workflowAutomations)
          .where(
            and(
              eq(workflowAutomations.workflowId, workflowId),
              eq(
                workflowAutomations.officialBlueprintKey,
                MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY,
              ),
            ),
          )
          .for("update");
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
              native.legacyAutomationId === null
                ? isNull(morningBriefScheduleClaims.automationId)
                : eq(
                    morningBriefScheduleClaims.automationId,
                    native.legacyAutomationId,
                  ),
            )
            .orderBy(desc(morningBriefScheduleClaims.claimSequence))
            .limit(1);
          const plan = morningBriefLogicalChoicePlan(
            native,
            { timezone },
            occurrence,
            native.phase === "legacy" &&
              native.legacyAutomationId !== null &&
              claim?.settlement === "unsettled",
            at,
          );
          await tx
            .update(morningBriefNativeSchedules)
            .set(plan.values)
            .where(
              and(
                morningBriefScheduleWhere(owner),
                eq(morningBriefNativeSchedules.ownerEpoch, native.ownerEpoch),
              ),
            );
        }
        for (const row of automations) {
          const values = automationTimezoneValues(row, timezone, at);
          if (values !== undefined) {
            await tx
              .update(workflowAutomations)
              .set(values)
              .where(eq(workflowAutomations.id, row.id));
          }
        }
        signal.throwIfAborted();
        return true;
      });
      signal.throwIfAborted();
      if (acquired) {
        return;
      }
      await delay(25, { signal });
    }
  },
);
