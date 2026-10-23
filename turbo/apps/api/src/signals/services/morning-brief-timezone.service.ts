import { MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { isValidTimeZone } from "@okouai/core/timezone";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import * as z from "zod";
import { parseRawRows } from "../../lib/db-raw-rows";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { pgTextDecoder } from "../../lib/db-structured-result";
import { settle } from "../utils";
import { morningBriefTimezoneTargetSql } from "./morning-brief-preference-sql";
import { calculateNextRun } from "./time-automation";

const timezoneTarget = z.object({
  workflowId: z.string(),
  timezone: z.string().nullable(),
});

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

/** Preserve user choice and an in-flight slot; concurrent Official writes return a conflict. */
export const synchronizeMorningBriefTimezone$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly member: { readonly userId: string };
    },
    signal: AbortSignal,
  ): Promise<"synchronized" | "conflict"> => {
    const owner = { orgId: args.orgId, userId: args.member.userId };
    const db = set(writeDb$);
    signal.throwIfAborted();
    const [target] = parseRawRows(
      timezoneTarget,
      await db.execute(morningBriefTimezoneTargetSql(owner)),
    );
    signal.throwIfAborted();
    if (!target?.timezone || !isValidTimeZone(target.timezone)) {
      return "synchronized";
    }
    const { workflowId, timezone } = target;
    const automationsOutcome = await settle(
      db
        .select({
          row: workflowAutomations,
          version: sql`${workflowAutomations}.xmin::text`.mapWith(
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
        ),
      signal,
    );
    if (!automationsOutcome.ok) {
      throw automationsOutcome.error;
    }
    const at = nowDate();
    // The partial unique index allows at most one row for this non-null key.
    for (const { row, version } of automationsOutcome.value) {
      const values = automationTimezoneValues(row, timezone, at);
      if (values === undefined) {
        continue;
      }
      const appliedOutcome = await settle(
        db
          .update(workflowAutomations)
          .set(values)
          .where(
            and(
              eq(workflowAutomations.id, row.id),
              sql`${workflowAutomations}.xmin::text = ${version}`,
            ),
          )
          .returning({ id: workflowAutomations.id }),
        signal,
      );
      if (!appliedOutcome.ok) {
        throw appliedOutcome.error;
      }
      const [applied] = appliedOutcome.value;
      if (applied === undefined) {
        return "conflict";
      }
    }
    signal.throwIfAborted();
    return "synchronized";
  },
);
