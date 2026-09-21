import { lockErasureSubjects } from "@okouai/db/operations/account-erasure";
import { orgUsageAllowanceEntitlements } from "@okouai/db/schema/org-usage-allowance";
import { socialDataJobs } from "@okouai/db/schema/social-data-job";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { usageEventHourlyRollup } from "@okouai/db/schema/usage-event-hourly-rollup";
import { eq } from "drizzle-orm";

import type { Db } from "../external/db";
import { lockUsageEventCompaction } from "./usage-event-compaction-lock.service";

export async function deleteOrgUsageData(db: Db, orgId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await lockErasureSubjects(tx, [
      { subjectKind: "organization", subjectId: orgId },
    ]);
    await lockUsageEventCompaction(tx);
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
    await lockErasureSubjects(tx, [{ subjectKind: "user", subjectId: userId }]);
    await lockUsageEventCompaction(tx);
    await tx.delete(socialDataJobs).where(eq(socialDataJobs.userId, userId));
    await tx
      .delete(usageEventHourlyRollup)
      .where(eq(usageEventHourlyRollup.userId, userId));
    await tx.delete(usageEvent).where(eq(usageEvent.userId, userId));
  });
}
