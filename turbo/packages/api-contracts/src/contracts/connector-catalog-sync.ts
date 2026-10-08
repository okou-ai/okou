import { z } from "zod";
import { CONNECTOR_CATALOG_VALIDATION_FAILURE_CODES } from "@okouai/connectors/connector-catalog/contracts";

export const connectorCatalogSyncFailureCodeSchema = z.enum([
  "source-unavailable",
  ...CONNECTOR_CATALOG_VALIDATION_FAILURE_CODES,
]);

/**
 * The sync writer's report of the attempt it just made, which is the whole
 * cron sync response. Nothing about the attempt is persisted. `failureCode` is
 * set only for a rejected attempt.
 */
export const connectorCatalogSyncAttemptReportSchema = z.object({
  outcome: z.enum(["accepted", "unchanged", "rejected"]),
  failureCode: connectorCatalogSyncFailureCodeSchema.nullable(),
});

export type ConnectorCatalogSyncFailureCode = z.infer<
  typeof connectorCatalogSyncFailureCodeSchema
>;
export type ConnectorCatalogSyncAttemptReport = z.infer<
  typeof connectorCatalogSyncAttemptReportSchema
>;
