import { and, eq, isNotNull } from "drizzle-orm";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import {
  officialWorkflowCatalogReleases,
  officialWorkflowDefinitionRevisions,
} from "@okouai/db/schema/official-workflow-catalog";
import { workflows } from "@okouai/db/schema/workflow";
import {
  acceptedCatalogDefinitionRevision,
  acceptedOfficialWorkflowCatalogReadPlan,
} from "./official-workflow-catalog-read.service";
import { proactiveWorkflowOwnerPreferenceQuery } from "./proactive-workflow-owner";

/** Read the release, its exact bundle revision, and installation authority with the Automation. */
export function officialWorkflowSourcePlan(scope: {
  readonly orgId: string;
  readonly userId: string;
}) {
  const catalog = acceptedOfficialWorkflowCatalogReadPlan();
  const preferences = proactiveWorkflowOwnerPreferenceQuery(
    scope,
    workflows.agentId,
    {
      prerequisite: isNotNull(officialWorkflowCatalogReleases.id),
    },
  ).as("official_workflow_preferences");
  return {
    catalogCondition: and(
      catalog.condition,
      eq(workflowAutomations.orgId, scope.orgId),
      eq(workflowAutomations.ownerUserId, scope.userId),
      eq(workflows.orgId, scope.orgId),
      eq(workflows.ownerUserId, scope.userId),
      eq(workflows.visibility, "private"),
      eq(workflows.officialInstallationState, "installed"),
      isNotNull(workflows.officialDefinitionName),
      isNotNull(workflowAutomations.officialBlueprintKey),
    ),
    releaseJoin: catalog.join,
    preferences,
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
      proactivePreferences: {
        memberUserId: preferences.memberUserId,
        suggestionsEnabled: preferences.suggestionsEnabled,
      },
    },
  };
}
