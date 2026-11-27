import { LEGACY_PROACTIVE_WORKFLOW_NAMES } from "./proactive-workflow-definitions";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { workflows } from "@okouai/db/schema/workflow";
import { and, eq, isNull, notInArray, or, type SQLWrapper } from "drizzle-orm";

/** Scope the surrounding query to the caller's workspace. */
export function visibleWorkflowCondition(userId: string | SQLWrapper) {
  return or(
    eq(workflows.visibility, "public"),
    eq(workflows.ownerUserId, userId),
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
  return or(
    isNull(workflows.officialDefinitionName),
    notInArray(workflows.officialDefinitionName, [
      ...LEGACY_PROACTIVE_WORKFLOW_NAMES,
    ]),
  );
}
