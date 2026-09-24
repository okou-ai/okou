import {
  morningBriefNativeScheduleSkips,
  workflowScheduleSkips,
} from "@okouai/db/schema/workflow-schedule-skip";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { and, eq } from "drizzle-orm";

import { db } from "../lib/db";
import { dueWorkflowAutomationRows } from "../signals/services/workflow-automation-poller.service";

/** Seed a large expired head for the fixture-scoped poller query. */
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
      Array.from({ length: args.count }, () => {
        return {
          orgId: args.orgId,
          workflowId: args.workflowId,
          ownerUserId: args.ownerUserId,
          kind: "schedule" as const,
          scheduleType: "loop" as const,
          intervalSeconds: 900,
          nextRunAt: args.at,
        };
      }),
    );
}

/** Select with the production candidate query, bounded to the fixture Workflow. */
export async function readDueScheduleCandidateIdsFixture(args: {
  readonly workflowId: string;
  readonly at: Date;
  readonly signal: AbortSignal;
}) {
  const [expired, fresh] = await Promise.all([
    dueWorkflowAutomationRows(
      db(),
      args.at,
      args.signal,
      undefined,
      "expired",
      args.workflowId,
    ),
    dueWorkflowAutomationRows(
      db(),
      args.at,
      args.signal,
      undefined,
      "fresh",
      args.workflowId,
    ),
  ]);
  return {
    expired: expired.map((row) => {
      return row.automation.id;
    }),
    fresh: fresh.map((row) => {
      return row.automation.id;
    }),
  };
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
