import { z } from "zod";

export const CONNECTOR_CATALOG_MAX_RAW_BYTES = 64 * 1024 * 1024;
export const BUILTIN_FIREWALL_CATALOG_MAX_BYTES = 16 * 1024 * 1024;

export const CONNECTOR_CATALOG_VALIDATION_FAILURE_CODES = [
  "object-too-large",
  "invalid-json",
  "invalid-pointer",
  "invalid-reference",
  "digest-mismatch",
  "unsupported-schema",
  "invalid-artifact",
  "public-leakage",
  "relationship-mismatch",
  "invalid-compression",
] as const;

export const connectorCatalogValidationFailureCodeSchema = z.enum(
  CONNECTOR_CATALOG_VALIDATION_FAILURE_CODES,
);

export type ConnectorCatalogValidationFailureCode = z.infer<
  typeof connectorCatalogValidationFailureCodeSchema
>;

export const connectorCatalogCompatibilityReasonSchema = z.enum([
  "unsupported-generic-strategy",
  "missing-grant-provider",
  "missing-access-provider",
  "missing-revoke-provider",
  "provider-contract-mismatch",
  "missing-platform-configuration",
]);

export type ConnectorCatalogCompatibilityReason = z.infer<
  typeof connectorCatalogCompatibilityReasonSchema
>;
