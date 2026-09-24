import {
  morningBriefNativeScheduleSkips,
  workflowScheduleSkips,
} from "@okouai/db/schema/workflow-schedule-skip";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { and, eq } from "drizzle-orm";

import { db } from "../lib/db";

/** Seed a large expired head for the real unscoped cron fairness regression. */
export async function seedExpiredSchedulesFixture(args: {
  readonly orgId: string;
  readonly workflowId: string;
  readonly ownerUserId: string;
  readonly at: Date;
  readonly count: number;
}): Promise<void> {
  await db()
    .insert(workflowAutomations)
    .values(
      Array.from({ length: args.count }, () => ({
        orgId: args.orgId,
        workflowId: args.workflowId,
        ownerUserId: args.ownerUserId,
        kind: "schedule" as const,
        scheduleType: "loop" as const,
        intervalSeconds: 900,
        nextRunAt: args.at,
      })),
    );
}

/** Read-only audit receipts for scheduler route regression tests. */
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
