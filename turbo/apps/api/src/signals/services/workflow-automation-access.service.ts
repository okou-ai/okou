import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { workflows } from "@okouai/db/schema/workflow";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { writeDb$ } from "../external/db";
import {
  visibleWorkflowCondition,
  dispatchableWorkflowCondition,
} from "./workflow-visibility";

type WorkflowAutomationRow = typeof workflowAutomations.$inferSelect;

export const workflowAutomationCanFire$ = command(
  async (
    { set },
    args: {
      readonly automation: WorkflowAutomationRow;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const { automation } = args;
    if (
      !automation.enabled ||
      (automation.officialBlueprintKey !== null &&
        automation.officialReconciliationStatus !== "current")
    ) {
      return false;
    }
    const db = set(writeDb$);
    const [member] = await db
      .select({ role: orgMembersCache.role })
      .from(orgMembersCache)
      .where(
        and(
          eq(orgMembersCache.orgId, automation.orgId),
          eq(orgMembersCache.userId, automation.ownerUserId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!member) {
      return false;
    }
    const [visible] = await db
      .select({
        id: workflows.id,
      })
      .from(workflows)
      .where(
        and(
          eq(workflows.id, automation.workflowId),
          eq(workflows.orgId, automation.orgId),
          visibleWorkflowCondition(automation.ownerUserId),
          dispatchableWorkflowCondition(),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return visible !== undefined;
  },
);
