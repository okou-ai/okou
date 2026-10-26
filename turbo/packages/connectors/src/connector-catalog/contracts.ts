import { enum as zEnum, type infer as zInfer } from "zod";

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
] as const;

export const connectorCatalogValidationFailureCodeSchema = zEnum(
  CONNECTOR_CATALOG_VALIDATION_FAILURE_CODES,
);

export type ConnectorCatalogValidationFailureCode = zInfer<
  typeof connectorCatalogValidationFailureCodeSchema
>;

export const connectorCatalogCompatibilityReasonSchema = zEnum([
  "unsupported-protocol",
  "missing-grant-provider",
  "missing-access-provider",
  "missing-revoke-provider",
  "provider-contract-mismatch",
  "missing-platform-configuration",
]);

export type ConnectorCatalogCompatibilityReason = zInfer<
  typeof connectorCatalogCompatibilityReasonSchema
>;
