import { workflowScheduleSkips } from "@okouai/db/schema/workflow-schedule-skip";
import { eq } from "drizzle-orm";

import { db } from "../lib/db";

// These audit ledgers are internal-only: no production API reads them. Route
// tests use this narrow exception to check one owned occurrence's durable skip.
export async function readWorkflowScheduleSkipsFixture(automationId: string) {
  return await db()
    .select()
    .from(workflowScheduleSkips)
    .where(eq(workflowScheduleSkips.automationId, automationId));
}
