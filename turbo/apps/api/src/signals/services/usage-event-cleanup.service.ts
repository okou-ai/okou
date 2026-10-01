import { orgUsageAllowanceEntitlements } from "@okouai/db/schema/org-usage-allowance";
import { socialDataJobs } from "@okouai/db/schema/social-data-job";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { usageEventHourlyRollup } from "@okouai/db/schema/usage-event-hourly-rollup";
import { eq } from "drizzle-orm";

import type { Db } from "../external/db";
import { lockUsageEventCompaction } from "./usage-event-compaction-lock.service";

export async function deleteOrgUsageData(db: Db, orgId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await lockUsageEventCompaction(tx, { orgId, mode: "exclusive" });
    await tx.delete(socialDataJobs).where(eq(socialDataJobs.orgId, orgId));
    await tx
      .delete(usageEventHourlyRollup)
      .where(eq(usageEventHourlyRollup.orgId, orgId));
    await tx.delete(usageEvent).where(eq(usageEvent.orgId, orgId));
    await tx
      .delete(orgUsageAllowanceEntitlements)
      .where(eq(orgUsageAllowanceEntitlements.orgId, orgId));
  });
}

export async function deleteUserUsageData(
  db: Db,
  userId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    // User cleanup spans orgs. Retain legacy global exclusion first, then
    // native relation protection; do not guess a stable owner set from IDs.
    await lockUsageEventCompaction(tx);
    await tx.delete(socialDataJobs).where(eq(socialDataJobs.userId, userId));
    await tx
      .delete(usageEventHourlyRollup)
      .where(eq(usageEventHourlyRollup.userId, userId));
    await tx.delete(usageEvent).where(eq(usageEvent.userId, userId));
  });
}
