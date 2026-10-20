import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { workflows } from "@okouai/db/schema/workflow";
import { and, eq, exists, isNotNull, sql, type SQL } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

/** An unbound legacy Official schedule keeps running until its intent is adopted. */
export function scheduleFailurePauseValues(
  threshold: SQL,
  nextRunAt: Date | null,
) {
  const official = exists(
    new QueryBuilder()
      .select({ id: workflows.id })
      .from(workflows)
      .where(
        and(
          eq(workflows.id, workflowAutomations.workflowId),
          eq(workflows.orgId, workflowAutomations.orgId),
          isNotNull(workflows.officialDefinitionName),
        ),
      ),
  );
  const pause = sql`${threshold} AND (${isNotNull(workflowAutomations.officialBlueprintKey)} OR NOT ${official})`;
  return {
    enabled: sql`CASE WHEN ${pause} THEN false ELSE ${workflowAutomations.enabled} END`,
    nextRunAt: sql`CASE WHEN ${threshold} AND NOT ${official} THEN NULL ELSE ${nextRunAt}::timestamp END`,
  };
}
