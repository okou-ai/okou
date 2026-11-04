import { and, asc, count, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { OfficialWorkflowAcceptedDefinition } from "@okouai/api-contracts/contracts/official-workflow-catalog";
import { officialWorkflowCatalogState } from "@okouai/db/schema/official-workflow-catalog";
import { workflows } from "@okouai/db/schema/workflow";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { OFFICIAL_WORKFLOW_CATALOG_AUTHORITY } from "./official-workflow-catalog-read.service";
import {
  observedDeliveryMatches,
  pinnedOfficialWorkflowBundles,
  blueprintIdentities,
  blueprintIdentitiesMatch,
  acceptedDefinitionForName,
  acceptedRevisionsMatchDefinitions,
  exactMountsMatch,
} from "./official-workflow-run.service";
import { pendingCreditPlanSql } from "./pending-launch-credit-plan";
import type { PreparedCommitPreparedLaunchArgs } from "./thread-claim-run.service";

function capturedOfficialDefinitions(
  args: PreparedCommitPreparedLaunchArgs,
): readonly OfficialWorkflowAcceptedDefinition[] | null {
  const observation = args.context.officialWorkflowRun;
  const facts = args.context.officialWorkflowFacts;
  if (
    !observation ||
    !facts ||
    facts.catalog.releaseId !== observation.releaseId
  ) {
    return null;
  }
  const accepted: OfficialWorkflowAcceptedDefinition[] = [];
  for (const expected of observation.definitions) {
    const definition = acceptedDefinitionForName(
      facts.catalog.payload.definitions,
      expected.name,
    );
    if (
      !definition ||
      definition.revision !== expected.revision ||
      !observedDeliveryMatches(expected, definition) ||
      !blueprintIdentitiesMatch(
        expected.blueprints,
        blueprintIdentities(definition),
      )
    ) {
      return null;
    }
    accepted.push(definition);
  }
  const expectedBundles = pinnedOfficialWorkflowBundles(observation);
  const capturedBundles =
    args.persistence.payload.executionContext.officialWorkflowBundles ?? [];
  if (
    expectedBundles.length !== capturedBundles.length ||
    expectedBundles.some((bundle) => {
      return !capturedBundles.some((captured) => {
        return (
          captured.sha256 === bundle.sha256 &&
          captured.archiveBytes === bundle.archiveBytes &&
          captured.mountPath === bundle.mountPath
        );
      });
    })
  ) {
    return null;
  }
  const revisions = accepted.map((definition) => {
    return (
      facts.revisions.get(
        JSON.stringify([definition.name, definition.revision]),
      ) ?? null
    );
  });
  return acceptedRevisionsMatchDefinitions(accepted, revisions) &&
    exactMountsMatch(observation, args.launch.runStorageMounts)
    ? accepted
    : null;
}

function officialInstallationLockSql(
  ids: readonly string[],
  prerequisite: SQL,
) {
  return sql`SELECT ${workflows.id} AS id, ${workflows.orgId} AS "orgId",
    ${workflows.agentId} AS "agentId", ${workflows.ownerUserId} AS "ownerUserId",
    ${workflows.name} AS name, ${workflows.visibility} AS visibility,
    ${workflows.officialDefinitionName} AS "definitionName",
    ${workflows.officialInstallationState} AS "installationState"
    FROM ${workflows} WHERE ${and(inArray(workflows.id, ids), prerequisite)}
    ORDER BY ${asc(workflows.id)} FOR UPDATE`;
}

function officialAutomationLockSql(id: string, prerequisite: SQL) {
  return sql`SELECT ${workflowAutomations.id} AS id,
    ${workflowAutomations.orgId} AS "orgId", ${workflowAutomations.workflowId} AS "workflowId",
    ${workflowAutomations.ownerUserId} AS "ownerUserId",
    ${workflowAutomations.officialBlueprintKey} AS "blueprintKey",
    ${workflowAutomations.officialAppliedFingerprint} AS fingerprint,
    ${workflowAutomations.officialReconciliationStatus} AS "reconciliationStatus",
    ${workflows.officialDefinitionName} AS "definitionName"
    FROM ${workflowAutomations} INNER JOIN ${workflows}
      ON ${eq(workflows.id, workflowAutomations.workflowId)}
    WHERE ${and(eq(workflowAutomations.id, id), prerequisite)} LIMIT 1 FOR UPDATE`;
}

/** Existing catalog -> plan -> installation -> automation locks, within publication. */
export function pendingOfficialAdmissionGuardSql(
  args: PreparedCommitPreparedLaunchArgs,
) {
  const observation = args.context.officialWorkflowRun;
  if (!observation) {
    return sql`SELECT 'ready'::text AS reason`;
  }
  if (!capturedOfficialDefinitions(args)) {
    return sql`SELECT 'official'::text AS reason`;
  }
  const definitions = observation.definitions;
  const expected = JSON.stringify(
    definitions.map((definition) => {
      return {
        id: definition.workflowId,
        name: definition.workflowName,
        definition: definition.name,
      };
    }),
  );
  const blueprints = JSON.stringify(
    definitions.flatMap((definition) => {
      return definition.blueprints.map((blueprint) => {
        return {
          workflowId: definition.workflowId,
          definition: definition.name,
          ...blueprint,
        };
      });
    }),
  );
  const catalog = sql`SELECT ${officialWorkflowCatalogState.acceptedReleaseId} AS release
    FROM ${officialWorkflowCatalogState}
    WHERE ${eq(officialWorkflowCatalogState.authority, OFFICIAL_WORKFLOW_CATALOG_AUTHORITY)}
    FOR SHARE`;
  const catalogReady = sql`EXISTS (SELECT 1 FROM launch_official_catalog
    WHERE release = ${observation.releaseId})`;
  const plan = args.enforceBuiltInCredits
    ? pendingCreditPlanSql(args.createArgs.orgId, catalogReady)
    : sql`SELECT NULL::jsonb AS caps, false AS "orgExists" WHERE ${catalogReady}`;
  const planReady = sql`${catalogReady} AND EXISTS (
    SELECT 1 FROM launch_official_plan WHERE caps IS NOT NULL OR NOT "orgExists")`;
  // Lock the original ID set first, then validate returned versions. Filtering
  // ownership before FOR UPDATE would skip rows that reconciliation changes.
  const installation = officialInstallationLockSql(
    definitions.map((definition) => {
      return definition.workflowId;
    }),
    planReady,
  );
  const installationReady = sql`${planReady} AND
    (SELECT ${count()} FROM launch_official_installation AS installed
      WHERE installed."orgId" = ${args.createArgs.orgId}
        AND installed."ownerUserId" = ${args.createArgs.userId}
        AND installed.visibility = 'private' AND installed."installationState" = 'installed'
        AND installed."agentId" = ${args.context.resolved.agentId}::uuid
        AND EXISTS (SELECT 1 FROM jsonb_to_recordset(${expected}::jsonb)
          AS expected(id uuid, name text, definition text)
          WHERE expected.id = installed.id AND expected.name = installed.name
            AND expected.definition = installed."definitionName")) = ${definitions.length}`;
  const automationId = args.createArgs.agentRunMetadata?.workflowAutomationId;
  const automation = automationId
    ? officialAutomationLockSql(automationId, installationReady)
    : sql`SELECT 1 WHERE false`;
  const automationReady = automationId
    ? sql`EXISTS (SELECT 1 FROM launch_official_automation AS automation
      WHERE automation."orgId" = ${args.createArgs.orgId}
        AND automation."ownerUserId" = ${args.createArgs.userId}
        AND ((automation."blueprintKey" IS NULL AND automation."definitionName" IS NULL)
          OR (automation."reconciliationStatus" = 'current' AND EXISTS (
            SELECT 1 FROM jsonb_to_recordset(${blueprints}::jsonb)
              AS expected("workflowId" uuid, definition text, key text, fingerprint text)
            WHERE expected."workflowId" = automation."workflowId"
              AND expected.definition = automation."definitionName"
              AND expected.key = automation."blueprintKey"
              AND expected.fingerprint = automation.fingerprint))))`
    : sql`true`;
  return sql`WITH launch_official_catalog AS MATERIALIZED (${catalog}),
    launch_official_plan AS MATERIALIZED (${plan}),
    launch_official_installation AS MATERIALIZED (${installation}),
    launch_official_automation AS MATERIALIZED (${automation})
    SELECT CASE WHEN NOT ${catalogReady} THEN 'official'
      WHEN NOT EXISTS (SELECT 1 FROM launch_official_plan WHERE caps IS NOT NULL OR NOT "orgExists") THEN 'plan'
      WHEN NOT ${installationReady} THEN 'official'
      WHEN NOT ${automationReady} THEN 'official'
      ELSE 'ready' END::text AS reason`;
}
