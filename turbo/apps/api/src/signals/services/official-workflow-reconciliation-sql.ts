import { contentBundleSchema } from "@okouai/api-contracts/contracts/content-bundle";
import type { OfficialWorkflowAcceptedDefinition } from "@okouai/api-contracts/contracts/official-workflow-catalog";
import { SYSTEM_ORG_ID, VOLUME_ORG_USER_ID } from "@okouai/core/storage-names";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import {
  officialWorkflowCatalogReleases,
  officialWorkflowCatalogState,
  officialWorkflowDefinitionRevisions,
} from "@okouai/db/schema/official-workflow-catalog";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { and, eq, sql } from "drizzle-orm";
import { boolean, object, string, unknown as zUnknown, type output } from "zod";

import {
  acceptedCatalogFromRow,
  acceptedRevisionFromRow,
  OFFICIAL_WORKFLOW_CATALOG_AUTHORITY,
  type AcceptedOfficialWorkflowCatalog,
} from "./official-workflow-catalog-read.service";

export const acceptedCatalogRowSchema = object({
  releaseId: string(),
  payload: zUnknown(),
});
export const acceptedRevisionRowSchema = object({
  definitionName: string(),
  revision: string(),
  payload: zUnknown(),
  storageName: string().nullable(),
  storageId: string().nullable(),
  storageVersion: string().nullable(),
  contentBundle: contentBundleSchema.nullable(),
});

function acceptedCatalogAuthorityCondition() {
  return eq(
    officialWorkflowCatalogState.authority,
    OFFICIAL_WORKFLOW_CATALOG_AUTHORITY,
  );
}

/** Keep the pointer's SHARE fence and the subsequent snapshot reads separate. */
export function acceptedCatalogLockStatement() {
  return sql`SELECT ${officialWorkflowCatalogState.authority}
    FROM ${officialWorkflowCatalogState}
    WHERE ${acceptedCatalogAuthorityCondition()} FOR SHARE`;
}

export function acceptedCatalogReadStatement() {
  return sql`SELECT ${officialWorkflowCatalogState.acceptedReleaseId} AS "releaseId",
      ${officialWorkflowCatalogReleases.payload} AS payload
    FROM ${officialWorkflowCatalogState}
    INNER JOIN ${officialWorkflowCatalogReleases}
      ON ${officialWorkflowCatalogReleases.id} = ${officialWorkflowCatalogState.acceptedReleaseId}
    WHERE ${acceptedCatalogAuthorityCondition()} LIMIT 1`;
}

/** Locate only the first named Definition; the original payload still parses at runtime. */
export function acceptedCatalogDefinitionRevision(definitionName: string) {
  return sql`(SELECT CASE WHEN jsonb_typeof(definition.value->'revision') = 'string'
      THEN definition.value->>'revision' END
    FROM jsonb_array_elements(CASE
      WHEN jsonb_typeof(${officialWorkflowCatalogReleases.payload}->'definitions') = 'array'
      THEN ${officialWorkflowCatalogReleases.payload}->'definitions' ELSE '[]'::jsonb END)
      WITH ORDINALITY AS definition(value, ordinal)
    WHERE jsonb_typeof(definition.value->'name') = 'string'
      AND definition.value->>'name' = ${definitionName}
    ORDER BY definition.ordinal LIMIT 1)`;
}

export function acceptedRevisionReadStatement(
  definition: Pick<OfficialWorkflowAcceptedDefinition, "name" | "revision">,
) {
  const storageCondition = and(
    eq(storages.id, officialWorkflowDefinitionRevisions.storageId),
    eq(storages.name, officialWorkflowDefinitionRevisions.storageName),
    eq(storages.orgId, SYSTEM_ORG_ID),
    eq(storages.userId, VOLUME_ORG_USER_ID),
  );
  const versionCondition = and(
    eq(storageVersions.id, officialWorkflowDefinitionRevisions.storageVersion),
    eq(
      storageVersions.storageId,
      officialWorkflowDefinitionRevisions.storageId,
    ),
  );
  const identityCondition = and(
    eq(officialWorkflowDefinitionRevisions.definitionName, definition.name),
    eq(officialWorkflowDefinitionRevisions.revision, definition.revision),
  );
  return sql`SELECT ${officialWorkflowDefinitionRevisions.definitionName} AS "definitionName",
      ${officialWorkflowDefinitionRevisions.revision} AS revision,
      ${officialWorkflowDefinitionRevisions.payload} AS payload,
      ${officialWorkflowDefinitionRevisions.storageName} AS "storageName",
      ${officialWorkflowDefinitionRevisions.storageId} AS "storageId",
      ${officialWorkflowDefinitionRevisions.storageVersion} AS "storageVersion",
      ${officialWorkflowDefinitionRevisions.contentBundle} AS "contentBundle"
    FROM ${officialWorkflowDefinitionRevisions}
    LEFT JOIN ${storages} ON ${storageCondition}
    LEFT JOIN ${storageVersions} ON ${versionCondition}
    WHERE ${identityCondition} AND (
      (${officialWorkflowDefinitionRevisions.storageId} IS NULL AND ${officialWorkflowDefinitionRevisions.storageVersion} IS NULL)
      OR (${storages.id} IS NOT NULL AND ${storageVersions.id} IS NOT NULL)
    ) LIMIT 1`;
}

export const webhookTierRowSchema = object({
  entitlementExists: boolean(),
  orgExists: boolean(),
  restrictedBuiltInModels: boolean().nullable(),
  allowed: boolean().nullable(),
});

/**
 * Two primary-key probes retain entitlement-before-org locking. The materialized
 * entitlement is the fallback's dependency, so an existing entitlement never
 * locks org metadata. Return one row even when both owners are absent.
 */
export function webhookTierLockStatement(orgId: string) {
  return sql`WITH entitlement AS MATERIALIZED (
    SELECT ${orgPlanEntitlements.restrictedBuiltInModels} AS restricted, ${orgPlanEntitlements.workflowWebhookTriggerAllowed} AS allowed
    FROM ${orgPlanEntitlements} WHERE ${orgPlanEntitlements.orgId} = ${orgId} LIMIT 1 FOR UPDATE
  ), missing_org AS MATERIALIZED (
    SELECT ${orgMetadata.orgId} FROM ${orgMetadata}
    WHERE ${orgMetadata.orgId} = ${orgId} AND NOT EXISTS (SELECT 1 FROM entitlement) LIMIT 1 FOR UPDATE
  ) SELECT EXISTS (SELECT 1 FROM entitlement) AS "entitlementExists",
    EXISTS (SELECT 1 FROM missing_org) AS "orgExists",
    (SELECT restricted FROM entitlement) AS "restrictedBuiltInModels", (SELECT allowed FROM entitlement) AS allowed`;
}

export function webhookTierFromRows(
  rows: readonly output<typeof webhookTierRowSchema>[],
  orgId: string,
) {
  const [row] = rows;
  if (!row) {
    throw new Error("Official webhook entitlement projection is incomplete");
  }
  if (!row.entitlementExists) {
    if (row.orgExists) {
      throw new Error(`Missing org plan entitlement for ${orgId}`);
    }
    return false;
  }
  if (row.restrictedBuiltInModels === null) {
    throw new Error(
      `Unexpected NULL restricted_built_in_models for org plan entitlement ${orgId}`,
    );
  }
  return boolean().parse(row.allowed);
}

export interface AcceptedBlueprintIdentity {
  readonly definitionName: string;
  readonly blueprintKey: string;
  readonly fingerprint: string;
  readonly activeDefinitionOnly: boolean;
}

export function acceptedBlueprintDefinitionFromRows(
  rows: readonly output<typeof acceptedCatalogRowSchema>[],
  args: AcceptedBlueprintIdentity,
) {
  const [row] = rows;
  return matchingAcceptedBlueprintDefinition(acceptedCatalogFromRow(row), args);
}

export function acceptedRevisionBlueprintRowsMatch(
  rows: readonly output<typeof acceptedRevisionRowSchema>[],
  args: AcceptedBlueprintIdentity,
) {
  const [row] = rows;
  return acceptedRevisionBlueprintMatches(row, args);
}

export function matchingAcceptedBlueprintDefinition(
  catalog: AcceptedOfficialWorkflowCatalog | null,
  args: AcceptedBlueprintIdentity,
): OfficialWorkflowAcceptedDefinition | null {
  const definition = catalog?.payload.definitions.find((candidate) => {
    return candidate.name === args.definitionName;
  });
  const blueprint = definition?.blueprints.find((candidate) => {
    return candidate.key === args.blueprintKey;
  });
  return !definition ||
    (args.activeDefinitionOnly && definition.lifecycle !== "active") ||
    blueprint?.fingerprint !== args.fingerprint
    ? null
    : definition;
}

export function acceptedRevisionBlueprintMatches(
  row: Parameters<typeof acceptedRevisionFromRow>[0] | undefined,
  args: AcceptedBlueprintIdentity,
): boolean {
  return (
    row !== undefined &&
    acceptedRevisionFromRow(row).definition.blueprints.find((candidate) => {
      return candidate.key === args.blueprintKey;
    })?.fingerprint === args.fingerprint
  );
}
