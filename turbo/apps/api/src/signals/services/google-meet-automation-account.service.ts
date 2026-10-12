import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { and, eq } from "drizzle-orm";

import type { Db, ReadonlyDb } from "../external/db";
import { resolveWorkflowAutomationConnectorId } from "./workflow-automation-account.service";

export async function resolveGoogleMeetAutomationConnectorId(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly workflowId: string;
  },
): Promise<string | null> {
  return await resolveWorkflowAutomationConnectorId(db, {
    ...args,
    connectorSlug: "google-meet",
  });
}

export async function reprojectGoogleMeetAutomationsForOwner(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
  },
): Promise<void> {
  const automations = await db
    .select({
      id: workflowAutomations.id,
      workflowId: workflowAutomations.workflowId,
      eventConnectorId: workflowAutomations.eventConnectorId,
    })
    .from(workflowAutomations)
    .where(
      and(
        eq(workflowAutomations.orgId, args.orgId),
        eq(workflowAutomations.ownerUserId, args.userId),
        eq(workflowAutomations.kind, "event"),
        eq(workflowAutomations.eventType, "google-meet-transcript-generated"),
      ),
    );

  for (const automation of automations) {
    const eventConnectorId = await resolveGoogleMeetAutomationConnectorId(db, {
      ...args,
      workflowId: automation.workflowId,
    });
    if (automation.eventConnectorId === eventConnectorId) {
      continue;
    }
    await db
      .update(workflowAutomations)
      .set({ eventConnectorId })
      .where(eq(workflowAutomations.id, automation.id));
  }
}
