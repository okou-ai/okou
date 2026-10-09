import { socialDataJobs } from "@okouai/db/schema/social-data-job";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { usageEventHourlyRollup } from "@okouai/db/schema/usage-event-hourly-rollup";
import { command } from "ccstate";
import { eq } from "drizzle-orm";
import { writeDb$ } from "../external/db";

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
  ] as const;
}

export const deleteUsageData$ = command(
  async (
    { set },
    args: UsageCleanupScope,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0265; new non-billing transactions are prohibited.
    await db.transaction(async (tx) => {
      const [jobs, ...targets] = usageCleanupTargets(args);
      await tx.delete(jobs.table).where(jobs.condition);
      // Actual raw deletion precedes the rollup deletion. If compaction won
      // those raw rows, this next statement sees and deletes its committed
      // rollups; if cleanup won, compaction consumes no source facts.
      for (const target of targets) {
        await tx.delete(target.table).where(target.condition);
      }
      signal.throwIfAborted();
    });
    signal.throwIfAborted();
  },
);
