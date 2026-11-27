import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { workflows } from "@okouai/db/schema/workflow";
import { and, eq, isNull, or, type SQLWrapper } from "drizzle-orm";

/** Scope the surrounding query to the caller's workspace. */
export function visibleWorkflowCondition(userId: string | SQLWrapper) {
  return or(
    eq(workflows.visibility, "public"),
    eq(workflows.ownerUserId, userId),
  );
}

/** Collection and slash resolution expose only user-authored workflows. */
export function userWorkflowCondition(userId: string) {
  return and(
    isNull(workflows.officialDefinitionName),
    visibleWorkflowCondition(userId),
  );
}

/** An event can read only a definition visible to its owner in the same workspace. */
export function automationWorkflowJoinCondition() {
  return and(
    eq(workflows.id, workflowAutomations.workflowId),
    eq(workflows.orgId, workflowAutomations.orgId),
    visibleWorkflowCondition(workflowAutomations.ownerUserId),
  );
}

export function dispatchableWorkflowCondition() {
  return isNull(workflows.officialDefinitionName);
}
