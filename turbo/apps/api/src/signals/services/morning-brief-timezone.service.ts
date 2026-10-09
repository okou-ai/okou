import { MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { isValidTimeZone } from "@okouai/core/timezone";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { parseRawRows } from "../../lib/db-raw-rows";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { pgTextDecoder } from "../../lib/db-structured-result";
import { settle } from "../utils";
import { morningBriefTimezoneTargetSql } from "./morning-brief-preference-sql";
import { calculateNextRun } from "./time-automation";

class StaleMorningBriefTimezone extends Error {}

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
    const outcome = await settle(
      // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0190; new non-billing transactions are prohibited.
      db.transaction(async (tx) => {
        const [target] = parseRawRows(
          timezoneTarget,
          await tx.execute(morningBriefTimezoneTargetSql(owner)),
        );
        if (!target?.timezone || !isValidTimeZone(target.timezone)) {
          return;
        }
        const { workflowId, timezone } = target;
        const automations = await tx
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
          );
        const at = nowDate();
        for (const { row, version } of automations) {
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
                sql`${workflowAutomations}.xmin::text = ${version}`,
              ),
            )
            .returning({ id: workflowAutomations.id });
          if (applied === undefined) {
            throw new StaleMorningBriefTimezone();
          }
        }
        signal.throwIfAborted();
      }),
      signal,
    );
    signal.throwIfAborted();
    if (outcome.ok) {
      return "synchronized";
    }
    if (outcome.error instanceof StaleMorningBriefTimezone) {
      return "conflict";
    }
    throw outcome.error;
  },
);
