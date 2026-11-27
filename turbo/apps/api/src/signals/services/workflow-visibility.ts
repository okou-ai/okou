import { pgBooleanDecoder } from "../../lib/db-structured-result";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import {
  archivedProactiveWorkflows,
  workflows,
} from "@okouai/db/schema/workflow";
import {
  and,
  eq,
  getTableColumns,
  isNull,
  or,
  sql,
  type SQLWrapper,
} from "drizzle-orm";

// A single SQL statement sees either the live row or the atomically archived row.
const { chatThreadId: _archivedThread, ...archivedColumns } = getTableColumns(
  archivedProactiveWorkflows,
);
export const readableWorkflows = new QueryBuilder()
  .select({
    ...getTableColumns(workflows),
    archived: sql`false`.mapWith(pgBooleanDecoder).as("archived"),
  })
  .from(workflows)
  .unionAll(
    new QueryBuilder()
      .select({
        ...archivedColumns,
        archived: sql`true`.mapWith(pgBooleanDecoder).as("archived"),
      })
      .from(archivedProactiveWorkflows),
  )
  .as("readable_workflows");

/** Scope the surrounding query to the caller's workspace. */
export function visibleWorkflowCondition(
  userId: string | SQLWrapper,
  source: {
    readonly visibility: SQLWrapper;
    readonly ownerUserId: SQLWrapper;
  } = workflows,
) {
  return or(eq(source.visibility, "public"), eq(source.ownerUserId, userId));
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
