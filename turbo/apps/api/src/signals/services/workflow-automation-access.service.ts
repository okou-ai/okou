import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { workflows } from "@okouai/db/schema/workflow";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { command } from "ccstate";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { loadProactiveWorkflowsEligibility$ } from "./proactive-workflows-eligibility.service";
import {
  PROACTIVE_WORKFLOW_DEFINITIONS,
  proactiveWorkflowKind,
} from "./proactive-workflow-definitions";

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
        definitionName: workflows.officialDefinitionName,
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
    const proactiveKind = proactiveWorkflowKind(
      visible?.definitionName ?? null,
    );
    if (proactiveKind !== null) {
      const eligibility = await set(
        loadProactiveWorkflowsEligibility$,
        { orgId: automation.orgId, userId: automation.ownerUserId },
        signal,
      );
      if (
        !eligibility[proactiveKind].active ||
        eligibility.agentId !== args.agentId
      ) {
        return false;
      }
      // Agent and mode changes wait for the previous proactive check.
      // The current schedule already serializes its own occurrences.
      const [otherCheck] = await db
        .select({ id: agentRuns.id })
        .from(activeAgentRuns)
        .innerJoin(agentRuns, eq(agentRuns.id, activeAgentRuns.runId))
        .where(
          and(
            eq(activeAgentRuns.orgId, automation.orgId),
            eq(activeAgentRuns.userId, automation.ownerUserId),
            inArray(agentRuns.status, ["pending", "running"]),
            sql`${agentRuns.workflowAutomationId} IS DISTINCT FROM ${automation.id}::uuid`,
            or(
              ...Object.values(PROACTIVE_WORKFLOW_DEFINITIONS).map(
                (definition) => {
                  return sql`${agentRuns.officialWorkflowProvenance} @> ${JSON.stringify({ definitions: [{ name: definition.name }] })}::jsonb`;
                },
              ),
            ),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (otherCheck) {
        return false;
      }
    }
    return (
      visible !== undefined && canReadAgent(visible, automation.ownerUserId)
    );
  },
);
