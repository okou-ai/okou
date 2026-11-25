import type { ProactiveWorkflowKind } from "@okouai/api-contracts/contracts/proactive";
import { workflows } from "@okouai/db/schema/workflow";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import {
  PROACTIVE_WORKFLOW_DEFINITIONS,
  RETIRED_PROACTIVE_DEFINITION_NAMES,
} from "./proactive-workflow-definitions";
import { and, eq, exists, isNull, inArray, or } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { orgMembersMetadata } from "@okouai/db/runtime/org-members-metadata";
import type { ProactiveWorkflowOwner } from "./proactive-workflows-eligibility.service";

/** Check the member’s saved choice in the statement admitting the schedule. */
export function proactiveWorkflowOwnerEnabledSql(
  owner: ProactiveWorkflowOwner,
  learningTimezone?: string | null,
) {
  return exists(
    new QueryBuilder()
      .select({ userId: orgMembersMetadata.userId })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, owner.orgId),
          eq(orgMembersMetadata.userId, owner.userId),
          eq(orgMembersMetadata.proactiveSuggestionsEnabled, true),
          learningTimezone === undefined
            ? undefined
            : learningTimezone === null
              ? isNull(orgMembersMetadata.timezone)
              : eq(orgMembersMetadata.timezone, learningTimezone),
        ),
      ),
  );
}

/** Stop only schedules this membership no longer selects, retaining all rows and their history. */
export function inactiveProactiveAutomationCondition(
  owner: ProactiveWorkflowOwner,
  activeKinds: readonly ProactiveWorkflowKind[],
) {
  const inactiveNames: string[] = [...RETIRED_PROACTIVE_DEFINITION_NAMES];
  for (const kind of ["suggestions", "learning"] as const) {
    if (!activeKinds.includes(kind)) {
      inactiveNames.push(PROACTIVE_WORKFLOW_DEFINITIONS[kind].name);
    }
  }
  return and(
    eq(workflowAutomations.orgId, owner.orgId),
    eq(workflowAutomations.ownerUserId, owner.userId),
    inArray(
      workflowAutomations.workflowId,
      new QueryBuilder()
        .select({ id: workflows.id })
        .from(workflows)
        .where(
          and(
            eq(workflows.orgId, owner.orgId),
            eq(workflows.ownerUserId, owner.userId),
            inArray(workflows.officialDefinitionName, inactiveNames),
          ),
        ),
    ),
    or(
      eq(workflowAutomations.officialIntendedEnabled, true),
      eq(workflowAutomations.enabled, true),
    ),
  );
}
