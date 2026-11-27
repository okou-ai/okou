import { workflows } from "@okouai/db/schema/workflow";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { LEGACY_PROACTIVE_WORKFLOW_NAMES } from "./proactive-workflow-definitions";
import { and, eq, inArray, or } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import type { ProactiveScheduleOwner } from "./proactive-member-preferences.service";

/** Disarm retained installations when a membership leaves, including during an upgrade. */
export function departedMemberProactiveAutomations(
  owner: ProactiveScheduleOwner,
) {
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
            inArray(workflows.officialDefinitionName, [
              ...LEGACY_PROACTIVE_WORKFLOW_NAMES,
            ]),
          ),
        ),
    ),
    or(
      eq(workflowAutomations.officialIntendedEnabled, true),
      eq(workflowAutomations.enabled, true),
    ),
  );
}
