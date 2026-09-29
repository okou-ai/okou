import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { workflowAutomations, workflows } from "@okouai/db/schema/workflow";
import { agents } from "@okouai/db/schema/agent";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";

import { writeDb$, type ReadonlyDb } from "../external/db";
import {
  loadVisibleWorkflowById,
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

async function loadWorkflowAutomationOwnerMember(
  db: ReadonlyDb,
  args: { readonly orgId: string; readonly userId: string },
) {
  const [member] = await db
    .select({ role: orgMembersCache.role })
    .from(orgMembersCache)
    .where(
      and(
        eq(orgMembersCache.orgId, args.orgId),
        eq(orgMembersCache.userId, args.userId),
      ),
    )
    .limit(1);
  return member ? { userId: args.userId, role: member.role } : null;
}

async function workflowAutomationOwnerCanReadTarget(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly workflowId: string;
    readonly agentId: string;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const member = await loadWorkflowAutomationOwnerMember(db, args);
  signal.throwIfAborted();
  if (!member) {
    return false;
  }

  const visible = await loadVisibleWorkflowById(db, {
    orgId: args.orgId,
    member,
    workflowId: args.workflowId,
  });
  signal.throwIfAborted();
  if (!visible || visible.workflow.agentId !== args.agentId) {
    return false;
  }

  return canReadAgent(visible.agent, args.userId);
}

export async function workflowAutomationCanFire(
  db: ReadonlyDb,
  args: {
    readonly automation: WorkflowAutomationRow;
    readonly agentId: string;
    readonly allowClaimedOnceScheduleAutomation?: boolean;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const claimedOnceSchedule =
    args.allowClaimedOnceScheduleAutomation === true &&
    args.automation.kind === "schedule" &&
    args.automation.scheduleType === "once" &&
    args.automation.nextRunAt === null &&
    args.automation.lastRunAt !== null;

  if (!args.automation.enabled && !claimedOnceSchedule) {
    return false;
  }
  if (
    args.automation.officialBlueprintKey !== null &&
    args.automation.officialReconciliationStatus !== "current"
  ) {
    return false;
  }

  return await workflowAutomationOwnerCanReadTarget(
    db,
    {
      orgId: args.automation.orgId,
      userId: args.automation.ownerUserId,
      workflowId: args.automation.workflowId,
      agentId: args.agentId,
    },
    signal,
  );
}

export const workflowAutomationCanFire$ = command(
  async (
    { set },
    args: {
      readonly automation: WorkflowAutomationRow;
      readonly agentId: string;
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
