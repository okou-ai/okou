import { socialDataJobs } from "@okouai/db/schema/social-data-job";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { usageEventHourlyRollup } from "@okouai/db/schema/usage-event-hourly-rollup";
import { eq } from "drizzle-orm";

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
