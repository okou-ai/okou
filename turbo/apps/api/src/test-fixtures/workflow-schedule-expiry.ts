import {
  morningBriefNativeScheduleSkips,
  workflowScheduleSkips,
} from "@okouai/db/schema/workflow-schedule-skip";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { and, eq } from "drizzle-orm";

import { db } from "../lib/db";

/**
 * Reproduce a historical mixed-version Morning Brief mirror divergence.
 * No production endpoint can write only the legacy row while leaving the
 * authoritative native owner untouched; fence this exceptional fixture to
 * one test-owned automation and its exact previous anchor.
 */
export async function skewLegacyMorningBriefAnchorFixture(args: {
  readonly automationId: string;
  readonly expectedAnchor: Date;
  readonly staleAnchor: Date;
}): Promise<void> {
  const [updated] = await db()
    .update(workflowAutomations)
    .set({ nextRunAt: args.staleAnchor })
    .where(
      and(
        eq(workflowAutomations.id, args.automationId),
        eq(workflowAutomations.nextRunAt, args.expectedAnchor),
      ),
    )
    .returning({ id: workflowAutomations.id });
  if (!updated) {
    throw new Error("Morning Brief legacy anchor was not at its expected slot");
  }
}

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
