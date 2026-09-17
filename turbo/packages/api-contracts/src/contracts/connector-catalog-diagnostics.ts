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

export const connectorCatalogDiagnosticsSchema = z.object({
  schemaVersion: z.literal(4),
  state: z.enum(["never-synced", "current", "stale"]),
  active: z
    .object({
      catalogVersion: z.string(),
      catalogDigest: z.string(),
      activatedAt: z.string().datetime(),
    })
    .nullable(),
  lastAttempt: z
    .object({
      at: z.string().datetime(),
      outcome: z.enum(["accepted", "unchanged", "rejected"]),
      failureCode: connectorCatalogSyncFailureCodeSchema.nullable(),
      reusedCachedRejection: z.boolean(),
    })
    .nullable(),
  lastSuccessAt: z.string().datetime().nullable(),
  rejectedCandidate: z
    .object({
      catalogVersion: z.string().nullable(),
      catalogDigest: z
        .string()
        .regex(/^sha256:[a-f0-9]{64}$/u)
        .nullable(),
      failureCode: connectorCatalogSyncFailureCodeSchema,
      backendVersion: z
        .string()
        .regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u),
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
