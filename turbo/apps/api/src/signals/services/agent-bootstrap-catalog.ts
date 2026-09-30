import {
  connectorCatalogActiveSnapshot,
  connectorCatalogCompatibilityEvaluation,
  connectorCatalogRuntimeProjections,
  connectorCatalogRuntimeProjectionSets,
} from "@okouai/db/schema/connector-catalog";
import { SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION } from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { computed } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import { db$ } from "../external/db";
import { connectorCatalogSource } from "./connector-catalog-source";
import { connectorCatalogExecutableCapabilityState } from "./connector-catalog-compatibility.service";
import { currentConnectorCatalogValidatorIdentity } from "./connector-catalog-validator-authority";
import {
  resolveProjectionIdentity,
  type CapturedConnectorCatalogIdentity,
} from "./connector-catalog-runtime-projection.service";

export type AgentCatalogProjectionRow = Pick<
  typeof connectorCatalogRuntimeProjections.$inferSelect,
  "connectorSlug" | "connectorDigest" | "connectorPayload"
>;

export interface AgentBootstrapCatalog {
  readonly captured: CapturedConnectorCatalogIdentity;
  readonly connectorSlugs: readonly ConnectorSlug[];
  readonly rows: readonly AgentCatalogProjectionRow[];
}

/** Each graph instance reads the current global identity, never a request identity. */
export function createAgentCatalogIdentity() {
  return computed(async (get): Promise<CapturedConnectorCatalogIdentity> => {
    const sourceId = connectorCatalogSource().sourceId;
    const capabilityDigest = connectorCatalogExecutableCapabilityState().digest;
    const validator = currentConnectorCatalogValidatorIdentity();
    const [row] = await get(db$)
      .select({
        projectionSetId: connectorCatalogRuntimeProjectionSets.id,
        schemaVersion: connectorCatalogActiveSnapshot.schemaVersion,
        catalogVersion: connectorCatalogActiveSnapshot.catalogVersion,
        catalogDigest: connectorCatalogActiveSnapshot.catalogDigest,
        projectionVersion:
          connectorCatalogRuntimeProjectionSets.projectionVersion,
        connectorCount: connectorCatalogRuntimeProjectionSets.connectorCount,
        projectionValidationBackendVersion:
          connectorCatalogRuntimeProjectionSets.catalogValidationBackendVersion,
        projectionValidationBuildCommitSha:
          connectorCatalogRuntimeProjectionSets.catalogValidationBuildCommitSha,
        evaluatedCapabilityDigest:
          connectorCatalogCompatibilityEvaluation.executableCapabilityDigest,
        compatibilityValidationBackendVersion:
          connectorCatalogCompatibilityEvaluation.catalogValidationBackendVersion,
        compatibilityValidationBuildCommitSha:
          connectorCatalogCompatibilityEvaluation.catalogValidationBuildCommitSha,
        filteredAuthMethods:
          connectorCatalogCompatibilityEvaluation.filteredAuthMethods,
      })
      .from(connectorCatalogActiveSnapshot)
      .leftJoin(
        connectorCatalogRuntimeProjectionSets,
        and(
          eq(
            connectorCatalogRuntimeProjectionSets.sourceId,
            connectorCatalogActiveSnapshot.sourceId,
          ),
          eq(
            connectorCatalogRuntimeProjectionSets.schemaVersion,
            connectorCatalogActiveSnapshot.schemaVersion,
          ),
          eq(
            connectorCatalogRuntimeProjectionSets.catalogVersion,
            connectorCatalogActiveSnapshot.catalogVersion,
          ),
          eq(
            connectorCatalogRuntimeProjectionSets.catalogDigest,
            connectorCatalogActiveSnapshot.catalogDigest,
          ),
        ),
      )
      .leftJoin(
        connectorCatalogCompatibilityEvaluation,
        and(
          eq(
            connectorCatalogCompatibilityEvaluation.sourceId,
            connectorCatalogActiveSnapshot.sourceId,
          ),
          eq(
            connectorCatalogCompatibilityEvaluation.schemaVersion,
            connectorCatalogActiveSnapshot.schemaVersion,
          ),
          eq(
            connectorCatalogCompatibilityEvaluation.catalogVersion,
            connectorCatalogActiveSnapshot.catalogVersion,
          ),
          eq(
            connectorCatalogCompatibilityEvaluation.catalogDigest,
            connectorCatalogActiveSnapshot.catalogDigest,
          ),
          eq(
            connectorCatalogCompatibilityEvaluation.executableCapabilityDigest,
            capabilityDigest,
          ),
        ),
      )
      .where(
        and(
          eq(connectorCatalogActiveSnapshot.sourceId, sourceId),
          eq(
            connectorCatalogActiveSnapshot.schemaVersion,
            SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
          ),
        ),
      )
      .limit(1);
    return {
      identity:
        row === undefined
          ? undefined
          : {
              sourceId,
              schemaVersion: row.schemaVersion,
              catalogVersion: row.catalogVersion,
              catalogDigest: row.catalogDigest,
              capabilityDigest,
            },
      projection: resolveProjectionIdentity({
        sourceId,
        capabilityDigest,
        validator,
        row,
      }),
    };
  });
}

export function createAgentCatalogProjectionRows(
  projectionSetId: string,
  connectorSlugs: readonly ConnectorSlug[],
) {
  return computed(
    async (get): Promise<readonly AgentCatalogProjectionRow[]> => {
      if (connectorSlugs.length === 0) {
        return [];
      }
      return await get(db$)
        .select({
          connectorSlug: connectorCatalogRuntimeProjections.connectorSlug,
          connectorDigest: connectorCatalogRuntimeProjections.connectorDigest,
          connectorPayload: connectorCatalogRuntimeProjections.connectorPayload,
        })
        .from(connectorCatalogRuntimeProjections)
        .where(
          and(
            eq(
              connectorCatalogRuntimeProjections.projectionSetId,
              projectionSetId,
            ),
            inArray(connectorCatalogRuntimeProjections.connectorSlug, [
              ...connectorSlugs,
            ]),
          ),
        );
    },
  );
}
