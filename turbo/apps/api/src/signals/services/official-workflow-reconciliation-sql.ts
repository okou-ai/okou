import type { OfficialWorkflowAcceptedDefinition } from "@okouai/api-contracts/contracts/official-workflow-catalog";
import { SYSTEM_ORG_ID, VOLUME_ORG_USER_ID } from "@okouai/core/storage-names";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { googleFormsAutomationCursors } from "@okouai/db/schema/google-forms-event";
import {
  officialWorkflowCatalogReleases,
  officialWorkflowCatalogState,
  officialWorkflowDefinitionRevisions,
} from "@okouai/db/schema/official-workflow-catalog";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import {
  officialWorkflowAutomationIdentities,
  workflowWebhookAutomations,
  workflows,
} from "@okouai/db/schema/workflow";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import {
  acceptedCatalogFromRow,
  acceptedRevisionFromRow,
  OFFICIAL_WORKFLOW_CATALOG_AUTHORITY,
  type AcceptedOfficialWorkflowCatalog,
} from "./official-workflow-catalog-read.service";
import type { OfficialAutomationRow } from "./official-workflow-installation.service";
import type { OfficialAutomationEventPreparation } from "./workflow-automation.service";

export const acceptedCatalogRowSchema = z.object({
  releaseId: z.string(),
  payload: z.unknown(),
});
export const acceptedRevisionRowSchema = z.object({
  definitionName: z.string(),
  revision: z.string(),
  payload: z.unknown(),
  storageName: z.string(),
  storageId: z.string(),
  storageVersion: z.string(),
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
      ${officialWorkflowDefinitionRevisions.storageVersion} AS "storageVersion"
    FROM ${officialWorkflowDefinitionRevisions}
    INNER JOIN ${storages} ON ${storageCondition}
    INNER JOIN ${storageVersions} ON ${versionCondition}
    WHERE ${identityCondition} LIMIT 1`;
}

/** Preserve existing webhook credentials; preparation is needed only for a new subtype. */
export function officialWebhookSubtypeMutation(
  desired: Pick<OfficialAutomationRow, "id" | "eventType">,
  webhookExists: boolean,
  credentials: OfficialAutomationEventPreparation["webhookCredentials"],
  tierEligible: boolean,
  currentTime: Date,
) {
  const automationCondition = eq(
    workflowWebhookAutomations.automationId,
    desired.id,
  );
  if (desired.eventType !== "webhook-received") {
    return {
      kind: "ready" as const,
      statement: webhookExists
        ? sql`DELETE FROM ${workflowWebhookAutomations} WHERE ${automationCondition}`
        : null,
    };
  }
  if (!tierEligible) {
    return {
      kind: "failed" as const,
      message: "Webhook automations require a Team or Custom workspace",
    };
  }
  const timestamp = currentTime.toISOString();
  if (webhookExists) {
    return {
      kind: "ready" as const,
      statement: sql`UPDATE ${workflowWebhookAutomations}
      SET disabled_reason = NULL, updated_at = ${timestamp}::timestamp WHERE ${automationCondition}`,
    };
  }
  if (!credentials) {
    throw new Error("Missing prepared Official webhook credentials");
  }
  return {
    kind: "ready" as const,
    statement: sql`INSERT INTO ${workflowWebhookAutomations}
    (automation_id, token_hash, encrypted_token, encrypted_secret, secret_last_four, created_at, updated_at)
    VALUES (${desired.id}::uuid, ${credentials.tokenHash}, ${credentials.encryptedToken},
      ${credentials.encryptedSecret}, ${credentials.secretLastFour}, ${timestamp}::timestamp, ${timestamp}::timestamp)`,
  };
}

export const webhookTierRowSchema = z.object({
  entitlementExists: z.boolean(),
  orgExists: z.boolean(),
  restrictedBuiltInModels: z.boolean().nullable(),
  allowed: z.boolean().nullable(),
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
  rows: readonly z.output<typeof webhookTierRowSchema>[],
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
  return z.boolean().parse(row.allowed);
}

export function installedWorkflowLockStatement(condition: SQL) {
  return sql`SELECT ${workflows.id} AS id FROM ${workflows} WHERE ${condition} LIMIT 1 FOR UPDATE`;
}

export function activeAutomationIdentityLockStatement(condition: SQL) {
  return sql`SELECT ${officialWorkflowAutomationIdentities.id} AS id FROM ${officialWorkflowAutomationIdentities}
    WHERE ${condition} LIMIT 1 FOR UPDATE`;
}

export function automationWebhookReadStatement(automationId: string) {
  return sql`SELECT ${workflowWebhookAutomations.automationId} AS id FROM ${workflowWebhookAutomations}
    WHERE ${workflowWebhookAutomations.automationId} = ${automationId}::uuid LIMIT 1`;
}

export function activeAutomationIdentityUpsertStatement(
  automation: OfficialAutomationRow,
  currentTime: Date,
) {
  if (!automation.officialBlueprintKey) {
    throw new Error("Official Workflow automation identity is incomplete");
  }
  const timestamp = currentTime.toISOString();
  return sql`INSERT INTO ${officialWorkflowAutomationIdentities}
    (id, workflow_id, automation_id, blueprint_key, state, retained_parameter_bindings,
      retained_intended_enabled, retained_applied_fingerprint, created_at, updated_at)
    VALUES (${automation.id}::uuid, ${automation.workflowId}::uuid, ${automation.id}::uuid,
      ${automation.officialBlueprintKey}, 'active', NULL, NULL, NULL, ${timestamp}::timestamp, ${timestamp}::timestamp)
    ON CONFLICT (workflow_id, blueprint_key) DO UPDATE SET automation_id = ${automation.id}::uuid,
      state = 'active', retained_parameter_bindings = NULL, retained_intended_enabled = NULL,
      retained_applied_fingerprint = NULL, updated_at = ${timestamp}::timestamp`;
}

export function installationUpdatedStatement(
  workflowId: string,
  userId: string,
  currentTime: Date,
) {
  return sql`UPDATE ${workflows} SET updated_by = ${userId}, updated_at = ${currentTime.toISOString()}::timestamp
    WHERE ${workflows.id} = ${workflowId}::uuid`;
}

export function deleteGoogleFormsCursorStatement(automationId: string) {
  return sql`DELETE FROM ${googleFormsAutomationCursors}
    WHERE ${googleFormsAutomationCursors.automationId} = ${automationId}::uuid`;
}

export interface AcceptedBlueprintIdentity {
  readonly definitionName: string;
  readonly blueprintKey: string;
  readonly fingerprint: string;
  readonly activeDefinitionOnly: boolean;
}

export function acceptedBlueprintDefinitionFromRows(
  rows: readonly z.output<typeof acceptedCatalogRowSchema>[],
  args: AcceptedBlueprintIdentity,
) {
  const [row] = rows;
  return matchingAcceptedBlueprintDefinition(acceptedCatalogFromRow(row), args);
}

export function acceptedRevisionBlueprintRowsMatch(
  rows: readonly z.output<typeof acceptedRevisionRowSchema>[],
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
