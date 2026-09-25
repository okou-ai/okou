import { morningBriefNativeSchedules } from "@okouai/db/schema/morning-brief-native-schedule";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { and, eq } from "drizzle-orm";

import { db } from "../lib/db";

/**
 * Read historical Native-named schedule and legacy automation rows for the
 * surviving Official Workflow reconciliation tests. No Native cron or
 * collection endpoint remains.
 */

interface MorningBriefNativeOwner {
  readonly orgId: string;
  readonly userId: string;
}

export async function readNativeSchedule(owner: MorningBriefNativeOwner) {
  const [row] = await db()
    .select()
    .from(morningBriefNativeSchedules)
    .where(
      and(
        eq(morningBriefNativeSchedules.orgId, owner.orgId),
        eq(morningBriefNativeSchedules.userId, owner.userId),
      ),
    )
    .limit(1);
  return row;
}

export async function readLegacyAutomation(automationId: string) {
  const [row] = await db()
    .select()
    .from(workflowAutomations)
    .where(eq(workflowAutomations.id, automationId))
    .limit(1);
  return row;
}
