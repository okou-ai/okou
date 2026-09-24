import {
  morningBriefNativeScheduleSkips,
  workflowScheduleSkips,
} from "@okouai/db/schema/workflow-schedule-skip";
import { and, eq } from "drizzle-orm";

import { db } from "../lib/db";

// These audit ledgers are internal-only: no production API reads them. Route
// tests use this narrow exception to check one owned occurrence's durable skip.
export async function readWorkflowScheduleSkipsFixture(automationId: string) {
  return await db()
    .select()
    .from(workflowScheduleSkips)
    .where(eq(workflowScheduleSkips.automationId, automationId));
}

export async function readNativeScheduleSkipsFixture(owner: {
  readonly orgId: string;
  readonly userId: string;
}) {
  return await db()
    .select()
    .from(morningBriefNativeScheduleSkips)
    .where(
      and(
        eq(morningBriefNativeScheduleSkips.orgId, owner.orgId),
        eq(morningBriefNativeScheduleSkips.userId, owner.userId),
      ),
    );
}
