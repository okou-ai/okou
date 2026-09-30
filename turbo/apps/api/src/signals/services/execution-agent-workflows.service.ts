import { workflows } from "@okouai/db/schema/workflow";
import { computed, type Computed } from "ccstate";
import { and, eq, isNull, or } from "drizzle-orm";
import { db$ } from "../external/db";
import { workflowsForRunFromRows } from "./workflow-data.service";

export interface AgentWorkflowSelectionScope {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
}

export interface SelectedAgentWorkflow {
  readonly workflowId: string;
  readonly name: string;
  readonly officialDefinitionName: string | null;
}

/** Normalize visible definitions without resolving their executable artifacts. */
export function createAgentWorkflowSelection(
  scope: AgentWorkflowSelectionScope,
): Computed<Promise<readonly SelectedAgentWorkflow[]>> {
  return computed(async (get) => {
    const rows = await get(db$)
      .select({
        id: workflows.id,
        name: workflows.name,
        visibility: workflows.visibility,
        ownerUserId: workflows.ownerUserId,
        officialDefinitionName: workflows.officialDefinitionName,
        createdAt: workflows.createdAt,
      })
      .from(workflows)
      .where(
        and(
          eq(workflows.orgId, scope.orgId),
          eq(workflows.agentId, scope.agentId),
          or(
            isNull(workflows.officialDefinitionName),
            eq(workflows.officialInstallationState, "installed"),
          ),
          or(
            eq(workflows.visibility, "public"),
            eq(workflows.ownerUserId, scope.userId),
          ),
        ),
      );
    return workflowsForRunFromRows(rows, scope.userId);
  });
}
