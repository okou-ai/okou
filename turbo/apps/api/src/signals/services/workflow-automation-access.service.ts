import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { workflowAutomations, workflows } from "@okouai/db/schema/workflow";
import { agents } from "@okouai/db/schema/agent";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";

import { writeDb$ } from "../external/db";
import {
  visibleWorkflowCondition,
  type WorkflowAgentInfo,
} from "./workflow-data.service";

type WorkflowAutomationRow = typeof workflowAutomations.$inferSelect;

function canReadAgent(
  agent: Pick<WorkflowAgentInfo, "visibility" | "owner">,
  userId: string,
): boolean {
  return agent.visibility === "public" || agent.owner === userId;
}

export const workflowAutomationCanFire$ = command(
  async (
    { set },
    args: {
      readonly automation: WorkflowAutomationRow;
      readonly agentId: string;
      readonly allowClaimedOnceScheduleAutomation?: boolean;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const { automation } = args;
    const claimedOnceSchedule =
      args.allowClaimedOnceScheduleAutomation === true &&
      automation.kind === "schedule" &&
      automation.scheduleType === "once" &&
      automation.nextRunAt === null &&
      automation.lastRunAt !== null;
    if (
      (!automation.enabled && !claimedOnceSchedule) ||
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
        owner: agents.owner,
        visibility: agents.visibility,
      })
      .from(workflows)
      .innerJoin(agents, eq(workflows.agentId, agents.id))
      .where(
        and(
          eq(workflows.id, automation.workflowId),
          eq(workflows.orgId, automation.orgId),
          eq(workflows.agentId, args.agentId),
          visibleWorkflowCondition({
            userId: automation.ownerUserId,
            role: member.role,
          }),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return (
      visible !== undefined && canReadAgent(visible, automation.ownerUserId)
    );
  },
);
