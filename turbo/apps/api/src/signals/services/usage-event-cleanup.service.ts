import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { orgUsageAllowanceEntitlements } from "@okouai/db/schema/org-usage-allowance";
import { socialDataJobs } from "@okouai/db/schema/social-data-job";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { usageEventHourlyRollup } from "@okouai/db/schema/usage-event-hourly-rollup";
import { eq } from "drizzle-orm";

import type { Db } from "../external/db";
import { lockUsageEventCompaction } from "./usage-event-compaction-lock.service";

export async function deleteOrgUsageData(db: Db, orgId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await lockUsageEventCompaction(tx);
    await lockUsageEventCompaction(tx, "exclusive", orgId);
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
    // The existing global lock still bridges serving versions. Inventory all
    // organizations this user can affect, including Run FK parents, before
    // taking scoped locks in a stable order. New pending webhook rows already
    // bypass the global lock; they do not justify inventing a new user fence.
    await lockUsageEventCompaction(tx);
    const orgIds = new Set<string>();
    const raw = await tx
      .selectDistinct({ orgId: usageEvent.orgId })
      .from(usageEvent)
      .where(eq(usageEvent.userId, userId));
    const hourly = await tx
      .selectDistinct({ orgId: usageEventHourlyRollup.orgId })
      .from(usageEventHourlyRollup)
      .where(eq(usageEventHourlyRollup.userId, userId));
    const jobs = await tx
      .selectDistinct({ orgId: socialDataJobs.orgId })
      .from(socialDataJobs)
      .where(eq(socialDataJobs.userId, userId));
    const sessions = await tx
      .selectDistinct({ orgId: agentSessions.orgId })
      .from(agentSessions)
      .where(eq(agentSessions.userId, userId));
    const runs = await tx
      .selectDistinct({ orgId: agentRuns.orgId })
      .from(agentRuns)
      .where(eq(agentRuns.userId, userId));
    for (const row of [...raw, ...hourly, ...jobs, ...sessions, ...runs]) {
      orgIds.add(row.orgId);
    }
    for (const orgId of [...orgIds].sort()) {
      await lockUsageEventCompaction(tx, "exclusive", orgId);
    }
    await tx.delete(socialDataJobs).where(eq(socialDataJobs.userId, userId));
    await tx
      .delete(usageEventHourlyRollup)
      .where(eq(usageEventHourlyRollup.userId, userId));
    await tx.delete(usageEvent).where(eq(usageEvent.userId, userId));
  });
}
