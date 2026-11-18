import { and, eq, isNotNull, sql } from "drizzle-orm";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import {
  officialWorkflowCatalogReleases,
  officialWorkflowDefinitionRevisions,
} from "@okouai/db/schema/official-workflow-catalog";
import { workflows } from "@okouai/db/schema/workflow";
import { pgBooleanDecoder } from "../../lib/db-structured-result";
import {
  acceptedCatalogDefinitionRevision,
  acceptedOfficialWorkflowCatalogReadPlan,
} from "./official-workflow-catalog-read.service";
import { PROACTIVE_WORKFLOW_DEFINITIONS } from "./proactive-workflow-definitions";
import { proactiveWorkflowOwnerEnabledSql } from "./proactive-workflow-owner";

/** Read the release, its exact bundle revision, and installation authority with the Automation. */
export function officialWorkflowSourcePlan(
  scope: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string;
  },
  requirePreference: boolean,
) {
  const catalog = acceptedOfficialWorkflowCatalogReadPlan();
  const { suggestions, learning } = PROACTIVE_WORKFLOW_DEFINITIONS;
  return {
    catalogCondition: and(
      catalog.condition,
      eq(workflowAutomations.orgId, scope.orgId),
      eq(workflowAutomations.ownerUserId, scope.userId),
      eq(workflows.orgId, scope.orgId),
      eq(workflows.agentId, scope.agentId),
      eq(workflows.ownerUserId, scope.userId),
      eq(workflows.visibility, "private"),
      eq(workflows.officialInstallationState, "installed"),
      isNotNull(workflows.officialDefinitionName),
      isNotNull(workflowAutomations.officialBlueprintKey),
    ),
    releaseJoin: catalog.join,
    revisionJoin: and(
      eq(
        officialWorkflowDefinitionRevisions.definitionName,
        workflows.officialDefinitionName,
      ),
      eq(
        officialWorkflowDefinitionRevisions.revision,
        acceptedCatalogDefinitionRevision(workflows.officialDefinitionName),
      ),
    ),
    columns: {
      officialCatalog: {
        releaseId: officialWorkflowCatalogReleases.id,
        payload: officialWorkflowCatalogReleases.payload,
        hiddenThreadDefinitionNames:
          officialWorkflowCatalogReleases.hiddenThreadDefinitionNames,
      },
      officialRevision: {
        definitionName: officialWorkflowDefinitionRevisions.definitionName,
        revision: officialWorkflowDefinitionRevisions.revision,
        payload: officialWorkflowDefinitionRevisions.payload,
        contentBundle: officialWorkflowDefinitionRevisions.contentBundle,
      },
      proactiveOwnerEnabled: sql`CASE ${workflows.officialDefinitionName}
        WHEN ${suggestions.name} THEN ${proactiveWorkflowOwnerEnabledSql(scope, scope.agentId, "suggestions", requirePreference)}
        WHEN ${learning.name} THEN ${proactiveWorkflowOwnerEnabledSql(scope, scope.agentId, "learning", requirePreference)}
        ELSE true END`.mapWith(pgBooleanDecoder),
    },
  };
}
