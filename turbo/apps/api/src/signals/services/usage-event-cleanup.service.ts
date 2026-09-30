import { orgUsageAllowanceEntitlements } from "@okouai/db/schema/org-usage-allowance";
import { socialDataJobs } from "@okouai/db/schema/social-data-job";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { usageEventHourlyRollup } from "@okouai/db/schema/usage-event-hourly-rollup";
import { command } from "ccstate";
import { eq } from "drizzle-orm";
import { writeDb$ } from "../external/db";
import { usageEventCompactionLockSql } from "./usage-event-compaction-lock.service";

export interface UsageCleanupScope {
  readonly scope: "organization" | "user";
  readonly id: string;
}

/** The owner executes this fixed set of deletes in its own transaction. */
export function usageCleanupTargets({ scope, id }: UsageCleanupScope) {
  const org = scope === "organization";
  return [
    {
      table: socialDataJobs,
      condition: eq(org ? socialDataJobs.orgId : socialDataJobs.userId, id),
    },
    // Raw ownership precedes rollups. A delete waiting on compaction sees the
    // newly committed hourly rows in its following READ COMMITTED statement.
    {
      table: usageEvent,
      condition: eq(org ? usageEvent.orgId : usageEvent.userId, id),
    },
    {
      table: usageEventHourlyRollup,
      condition: eq(
        org ? usageEventHourlyRollup.orgId : usageEventHourlyRollup.userId,
        id,
      ),
    },
    ...(org
      ? [
          {
            table: orgUsageAllowanceEntitlements,
            condition: eq(orgUsageAllowanceEntitlements.orgId, id),
          },
        ]
      : []),
  ] as const;
}

export const deleteUsageData$ = command(
  async (
    { set },
    args: UsageCleanupScope,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    await db.transaction(async (tx) => {
      await tx.execute(usageEventCompactionLockSql());
      const [jobs, ...targets] = usageCleanupTargets(args);
      await tx.delete(jobs.table).where(jobs.condition);
      // The exclusive compaction barrier above already excludes settlement,
      // which holds it shared. The entitlement DELETE owns its row before the
      // window/allocation cascade, the same order as admission and Stripe
      // publication. A user cleanup leaves the organization's entitlement.
      for (const target of targets) {
        await tx.delete(target.table).where(target.condition);
      }
      signal.throwIfAborted();
    });
    signal.throwIfAborted();
  },
);
