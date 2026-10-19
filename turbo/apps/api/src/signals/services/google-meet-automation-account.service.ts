import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { and, eq } from "drizzle-orm";

import type { Db } from "../external/db";
import {
  workflowAutomationDefaultAccountReadPlan,
  workflowAutomationSelectedAccountReadPlan,
} from "./workflow-automation-account.service";

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
    const workflowScope = {
      ...args,
      workflowId: automation.workflowId,
    };
    const eventConnectorId = await (async () => {
      const accountScope = {
        ...workflowScope,
        connectorSlug: "google-meet" as const,
      };
      return await (async () => {
        const selected =
          workflowAutomationSelectedAccountReadPlan(accountScope);
        const [selection] = await db
          .select(selected.columns)
          .from(selected.from)
          .innerJoin(selected.join.table, selected.join.on)
          .where(selected.where)
          .limit(selected.limit);
        if (selection) {
          return selection.connectorId;
        }
        const fallback = workflowAutomationDefaultAccountReadPlan(accountScope);
        const [defaultAccount] = await db
          .select(fallback.columns)
          .from(fallback.from)
          .where(fallback.where)
          .limit(fallback.limit);
        return defaultAccount?.connectorId ?? null;
      })();
    })();
    if (automation.eventConnectorId === eventConnectorId) {
      continue;
    }
    await db
      .update(workflowAutomations)
      .set({ eventConnectorId })
      .where(eq(workflowAutomations.id, automation.id));
  }
}
