import { morningBriefNativeSchedules } from "@okouai/db/schema/morning-brief-native-schedule";
import { and, eq } from "drizzle-orm";

import { db } from "../lib/db";

/**
 * Read the historical Native-named schedule for the surviving Official
 * Workflow reconciliation tests. No Native cron or collection endpoint remains.
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
