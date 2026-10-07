import { z } from "zod";
import {
  CONNECTOR_CATALOG_VALIDATION_FAILURE_CODES,
  connectorCatalogCompatibilityReasonSchema,
} from "@okouai/connectors/connector-catalog/contracts";

import {
  connectorAuthMethodIdSchema,
  connectorSlugSchema,
} from "./connector-identity";

export const connectorCatalogSyncFailureCodeSchema = z.enum([
  "source-unavailable",
  ...CONNECTOR_CATALOG_VALIDATION_FAILURE_CODES,
]);

export { connectorCatalogCompatibilityReasonSchema };

export const connectorCatalogFilteredAuthMethodSchema = z.object({
  connectorSlug: connectorSlugSchema,
  authMethodId: connectorAuthMethodIdSchema,
  reasons: z.array(connectorCatalogCompatibilityReasonSchema).min(1),
});

export const connectorCatalogFilteredAuthMethodsSchema = z.array(
  connectorCatalogFilteredAuthMethodSchema,
);

export const connectorCatalogFilteringStatusSchema = z.object({
  capabilityDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  evaluatedAt: z.string().datetime().nullable(),
  stale: z.boolean(),
  filteredAuthMethods: connectorCatalogFilteredAuthMethodsSchema,
});

export const connectorCredentialStorageReadinessSchema = z.object({
  missingConnectorVersions: z.number().int().nonnegative(),
  unownedConnectorSecrets: z.number().int().nonnegative(),
  unownedConnectorVariables: z.number().int().nonnegative(),
  unresolvedBridgeCredentials: z.number().int().nonnegative(),
});

const connectorCatalogStateSchema = z.enum([
  "never-synced",
  "current",
  "stale",
]);

/**
 * The sync writer's report of the attempt it just made. Nothing about the
 * attempt is persisted: a later request cannot see it, and staff diagnostics
 * do not carry it. `failureCode` is set only for a rejected attempt.
 */
export const connectorCatalogSyncAttemptReportSchema = z.object({
  outcome: z.enum(["accepted", "unchanged", "rejected"]),
  failureCode: connectorCatalogSyncFailureCodeSchema.nullable(),
});

/**
 * Staff diagnostics derived from the current `connector_catalog` pointer and
 * the immutable entries at its hash. Sync history (`lastAttempt`,
 * `lastSuccessAt`, `rejectedCandidate`) and activation time cannot be derived
 * from them and are omitted.
 */
export const connectorCatalogDiagnosticsSchema = z.object({
  schemaVersion: z.literal(4),
  // Staff diagnostics report `never-synced` or `current`. The cron sync
  // response reports `stale` when its own attempt was rejected while an
  // existing pointer keeps serving.
  state: connectorCatalogStateSchema,
  // Both fields carry the pointer hash; `catalogVersion` is a legacy alias.
  active: z
    .object({
      catalogVersion: z.string(),
      catalogDigest: z.string(),
    })
    .nullable(),
  // Null without a published pointer. An `entryCount` of zero is an
  // unavailable generation.
  pointer: z
    .object({
      schemaVersion: z.number().int().positive(),
      hash: z.string(),
      entryCount: z.number().int().nonnegative(),
    })
    .nullable(),
  filtering: connectorCatalogFilteringStatusSchema,
  credentialStorage: connectorCredentialStorageReadinessSchema,
});

export type ConnectorCatalogSyncFailureCode = z.infer<
  typeof connectorCatalogSyncFailureCodeSchema
>;
export type { ConnectorCatalogCompatibilityReason } from "@okouai/connectors/connector-catalog/contracts";
export type ConnectorCatalogFilteredAuthMethod = z.infer<
  typeof connectorCatalogFilteredAuthMethodSchema
>;
export type ConnectorCatalogFilteringStatus = z.infer<
  typeof connectorCatalogFilteringStatusSchema
>;
export type ConnectorCredentialStorageReadiness = z.infer<
  typeof connectorCredentialStorageReadinessSchema
>;
export type ConnectorCatalogDiagnostics = z.infer<
  typeof connectorCatalogDiagnosticsSchema
>;
export type ConnectorCatalogSyncAttemptReport = z.infer<
  typeof connectorCatalogSyncAttemptReportSchema
>;
