import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import {
  connectorCatalogActiveSnapshot,
  connectorCatalogCompatibilityEvaluation,
  connectorCatalogRuntimeProjections,
  connectorCatalogRuntimeProjectionSets,
  connectorCatalogSyncState,
} from "@okouai/db/schema/connector-catalog";
import { command } from "ccstate";
import { and, count, eq, inArray } from "drizzle-orm";

import { testOverride } from "../../lib/singleton";
import { writeDb$, type Db, type ReadonlyDb } from "../external/db";
import {
  SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
  type ConnectorCatalogArtifact,
} from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import { decodeConnectorCatalogSnapshot } from "@okouai/connectors/connector-catalog/artifacts/loader";
import { connectorCatalogCompatibilityEvaluationSchema } from "@okouai/connectors/connector-catalog/compatibility";
import {
  CONNECTOR_CATALOG_RUNTIME_PROJECTION_VERSION,
  connectorCatalogAuthMethodKey,
  connectorCatalogRuntimeProjectionDigest,
  connectorCatalogRuntimeProjectionPayload,
  validateConnectorCatalogRuntimeProjectionRows,
  type ConnectorCatalogRuntimeProjectionFallbackReason,
  type ConnectorCatalogRuntimeProjectionIdentity,
  type ConnectorCatalogRuntimeProjectionReadyIdentity,
  type ConnectorCatalogRuntimeProjectionRow,
  type ConnectorCatalogRuntimeProjectionRowsRead,
  type ConnectorCatalogRuntimeProjectionRowSetIdentity,
  type ConnectorCatalogRuntimeProjectionValidationTiming,
} from "@okouai/connectors/connector-catalog/runtime-projection";
import { connectorCatalogExecutableCapabilityState } from "./connector-catalog-compatibility.service";
import { connectorCatalogSource } from "./connector-catalog-source";
import {
  connectorCatalogValidationAuthorityIsCurrent,
  connectorCatalogValidationAuthorityIsCurrentOrNewer,
  currentConnectorCatalogValidatorIdentity,
  type ConnectorCatalogValidationAuthority,
  type ConnectorCatalogValidatorIdentity,
} from "./connector-catalog-validator-authority";

export {
  CONNECTOR_CATALOG_RUNTIME_PROJECTION_VERSION,
  validateConnectorCatalogRuntimeProjectionRows,
};
export type {
  ConnectorCatalogRuntimeProjectionFallbackReason,
  ConnectorCatalogRuntimeProjectionIdentity,
  ConnectorCatalogRuntimeProjectionReadyIdentity,
  ConnectorCatalogRuntimeProjectionRowsRead,
  ConnectorCatalogRuntimeProjectionValidationTiming,
};

type ConnectorCatalogRuntimeProjectionIdentityRead =
  | {
      readonly kind: "ready";
      readonly projection: ConnectorCatalogRuntimeProjectionReadyIdentity;
    }
  | {
      readonly kind: "fallback";
      readonly reason: Extract<
        ConnectorCatalogRuntimeProjectionFallbackReason,
        | "not_ready"
        | "unsupported"
        | "compatibility_not_ready"
        | "invalid_compatibility"
      >;
    };

type ConnectorCatalogRuntimeProjectionIdentityReadHook = () => Promise<void>;

const projectionIdentityReadHook = testOverride<
  ConnectorCatalogRuntimeProjectionIdentityReadHook | undefined
>(() => {
  return undefined;
});

export function setConnectorCatalogRuntimeProjectionIdentityReadHookForTest(
  hook: ConnectorCatalogRuntimeProjectionIdentityReadHook,
): void {
  projectionIdentityReadHook.set(hook);
}

export function clearConnectorCatalogRuntimeProjectionIdentityReadHookForTest(): void {
  projectionIdentityReadHook.clear();
}

function persistedConnectorCatalogValidationAuthority(args: {
  readonly backendVersion: string | null;
  readonly validationRevision: string | null;
}): ConnectorCatalogValidationAuthority | null {
  return args.backendVersion === null
    ? null
    : {
        validatorVersion: args.backendVersion,
        buildCommitSha: args.validationRevision,
      };
}

export async function persistConnectorCatalogRuntimeProjection(args: {
  readonly db: Db;
  readonly sourceId: string;
  readonly identity: {
    readonly catalogVersion: string;
    readonly catalogDigest: string;
  };
  readonly artifact: ConnectorCatalogArtifact;
  readonly validator: ConnectorCatalogValidatorIdentity;
}): Promise<void> {
  await args.db
    .delete(connectorCatalogRuntimeProjectionSets)
    .where(
      and(
        eq(connectorCatalogRuntimeProjectionSets.sourceId, args.sourceId),
        eq(
          connectorCatalogRuntimeProjectionSets.schemaVersion,
          SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
        ),
      ),
    );
  const [projectionSet] = await args.db
    .insert(connectorCatalogRuntimeProjectionSets)
    .values({
      sourceId: args.sourceId,
      schemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
      catalogVersion: args.identity.catalogVersion,
      catalogDigest: args.identity.catalogDigest,
      projectionVersion: CONNECTOR_CATALOG_RUNTIME_PROJECTION_VERSION,
      connectorCount: args.artifact.connectors.length,
      catalogValidationBackendVersion: args.validator.validatorVersion,
      catalogValidationBuildCommitSha: args.validator.buildCommitSha,
    })
    .returning({ id: connectorCatalogRuntimeProjectionSets.id });
  if (projectionSet === undefined) {
    throw new Error("Connector runtime projection set insert returned no row");
  }
  await args.db.insert(connectorCatalogRuntimeProjections).values(
    args.artifact.connectors.map((connector) => {
      const connectorPayload =
        connectorCatalogRuntimeProjectionPayload(connector);
      return {
        projectionSetId: projectionSet.id,
        connectorSlug: connector.slug,
        connectorDigest:
          connectorCatalogRuntimeProjectionDigest(connectorPayload),
        connectorPayload,
      };
    }),
  );
}

async function queryProjectionIdentity(
  db: ReadonlyDb,
  sourceId: string,
  capabilityDigest: string,
) {
  const [row] = await db
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
  return row;
}

async function readProjectionIdentity(
  db: ReadonlyDb,
): Promise<ConnectorCatalogRuntimeProjectionIdentityRead> {
  const sourceId = connectorCatalogSource().sourceId;
  const capabilityDigest = connectorCatalogExecutableCapabilityState().digest;
  const validator = currentConnectorCatalogValidatorIdentity();
  const row = await queryProjectionIdentity(db, sourceId, capabilityDigest);
  // Route integration tests use this seam to replace the active identity after
  // the read, making both retry generations deterministic without timing sleeps.
  await projectionIdentityReadHook.get()?.();
  if (
    row === undefined ||
    row.projectionSetId === null ||
    row.projectionVersion === null
  ) {
    return { kind: "fallback", reason: "not_ready" };
  }
  if (row.connectorCount === null) {
    return { kind: "fallback", reason: "unsupported" };
  }
  if (row.projectionVersion !== CONNECTOR_CATALOG_RUNTIME_PROJECTION_VERSION) {
    return { kind: "fallback", reason: "unsupported" };
  }
  const compatibilityAuthority = persistedConnectorCatalogValidationAuthority({
    backendVersion: row.compatibilityValidationBackendVersion,
    validationRevision: row.compatibilityValidationBuildCommitSha,
  });
  if (
    row.evaluatedCapabilityDigest === null ||
    compatibilityAuthority === null
  ) {
    return { kind: "fallback", reason: "compatibility_not_ready" };
  }
  if (
    !connectorCatalogValidationAuthorityIsCurrent({
      authority: compatibilityAuthority,
      validator,
    })
  ) {
    return { kind: "fallback", reason: "compatibility_not_ready" };
  }
  const projectionAuthority = persistedConnectorCatalogValidationAuthority({
    backendVersion: row.projectionValidationBackendVersion,
    validationRevision: row.projectionValidationBuildCommitSha,
  });
  if (
    projectionAuthority === null ||
    !connectorCatalogValidationAuthorityIsCurrent({
      authority: projectionAuthority,
      validator,
    })
  ) {
    return { kind: "fallback", reason: "not_ready" };
  }
  const compatibility = connectorCatalogCompatibilityEvaluationSchema.safeParse(
    row.filteredAuthMethods,
  );
  if (!compatibility.success) {
    return { kind: "fallback", reason: "invalid_compatibility" };
  }
  return {
    kind: "ready",
    projection: {
      identity: {
        projectionSetId: row.projectionSetId,
        sourceId,
        schemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
        catalogVersion: row.catalogVersion,
        catalogDigest: row.catalogDigest,
        capabilityDigest,
        projectionVersion: row.projectionVersion,
        connectorCount: row.connectorCount,
      },
      filteredMethodKeys: new Set(
        compatibility.data.filteredAuthMethods.map((method) => {
          return connectorCatalogAuthMethodKey(
            method.connectorSlug,
            method.authMethodId,
          );
        }),
      ),
    },
  };
}

export async function readConnectorCatalogRuntimeProjectionIdentity(
  db: ReadonlyDb,
): Promise<ConnectorCatalogRuntimeProjectionIdentityRead> {
  return await readProjectionIdentity(db);
}

function projectionIdentityWhere(
  identity: ConnectorCatalogRuntimeProjectionRowSetIdentity,
) {
  // The opaque set ID is the projection generation boundary. Querying child
  // rows by source/schema would allow a concurrent replacement to mix the
  // identity read from one generation with connector rows from the next.
  return eq(
    connectorCatalogRuntimeProjections.projectionSetId,
    identity.projectionSetId,
  );
}

export async function queryConnectorCatalogRuntimeProjectionRows(args: {
  readonly db: ReadonlyDb;
  readonly projection: ConnectorCatalogRuntimeProjectionReadyIdentity;
  readonly connectorSlugs: readonly ConnectorSlug[];
}): Promise<readonly ConnectorCatalogRuntimeProjectionRow[]> {
  if (args.connectorSlugs.length === 0) {
    return [];
  }
  const where = and(
    projectionIdentityWhere(args.projection.identity),
    inArray(connectorCatalogRuntimeProjections.connectorSlug, [
      ...args.connectorSlugs,
    ]),
  );
  return await args.db
    .select({
      connectorSlug: connectorCatalogRuntimeProjections.connectorSlug,
      connectorDigest: connectorCatalogRuntimeProjections.connectorDigest,
      connectorPayload: connectorCatalogRuntimeProjections.connectorPayload,
    })
    .from(connectorCatalogRuntimeProjections)
    .where(where);
}

export async function countConnectorCatalogRuntimeProjectionRows(args: {
  readonly db: ReadonlyDb;
  readonly identity: ConnectorCatalogRuntimeProjectionRowSetIdentity;
}): Promise<number> {
  const [row] = await args.db
    .select({ value: count() })
    .from(connectorCatalogRuntimeProjections)
    .where(projectionIdentityWhere(args.identity));
  if (row === undefined) {
    throw new Error("Connector runtime projection count query returned no row");
  }
  return row.value;
}

async function lockSyncState(db: Db, sourceId: string): Promise<boolean> {
  const [state] = await db
    .select({ sourceId: connectorCatalogSyncState.sourceId })
    .from(connectorCatalogSyncState)
    .where(
      and(
        eq(connectorCatalogSyncState.sourceId, sourceId),
        eq(
          connectorCatalogSyncState.schemaVersion,
          SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
        ),
      ),
    )
    .limit(1)
    .for("update");
  return state !== undefined;
}

export const reconcileConnectorCatalogRuntimeProjection$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    const sourceId = connectorCatalogSource().sourceId;
    const validator = currentConnectorCatalogValidatorIdentity();
    await db.transaction(async (tx) => {
      if (!(await lockSyncState(tx, sourceId))) {
        return;
      }
      const [snapshot] = await tx
        .select({
          catalogVersion: connectorCatalogActiveSnapshot.catalogVersion,
          catalogDigest: connectorCatalogActiveSnapshot.catalogDigest,
          catalogRawSize: connectorCatalogActiveSnapshot.catalogRawSize,
          catalogGzip: connectorCatalogActiveSnapshot.catalogGzip,
        })
        .from(connectorCatalogActiveSnapshot)
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
      if (snapshot === undefined) {
        return;
      }
      const [ready] = await tx
        .select({
          projectionSetId: connectorCatalogRuntimeProjectionSets.id,
          connectorCount: connectorCatalogRuntimeProjectionSets.connectorCount,
          validationBackendVersion:
            connectorCatalogRuntimeProjectionSets.catalogValidationBackendVersion,
          validationBuildCommitSha:
            connectorCatalogRuntimeProjectionSets.catalogValidationBuildCommitSha,
        })
        .from(connectorCatalogRuntimeProjectionSets)
        .where(
          and(
            eq(connectorCatalogRuntimeProjectionSets.sourceId, sourceId),
            eq(
              connectorCatalogRuntimeProjectionSets.schemaVersion,
              SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
            ),
            eq(
              connectorCatalogRuntimeProjectionSets.catalogVersion,
              snapshot.catalogVersion,
            ),
            eq(
              connectorCatalogRuntimeProjectionSets.catalogDigest,
              snapshot.catalogDigest,
            ),
            eq(
              connectorCatalogRuntimeProjectionSets.projectionVersion,
              CONNECTOR_CATALOG_RUNTIME_PROJECTION_VERSION,
            ),
          ),
        )
        .limit(1);
      if (ready !== undefined) {
        const authority = persistedConnectorCatalogValidationAuthority({
          backendVersion: ready.validationBackendVersion,
          validationRevision: ready.validationBuildCommitSha,
        });
        // Preserve an attestation from the same or a newer validator package.
        if (
          authority !== null &&
          connectorCatalogValidationAuthorityIsCurrentOrNewer({
            authority,
            validator,
          })
        ) {
          const actualCount = await countConnectorCatalogRuntimeProjectionRows({
            db: tx,
            identity: {
              projectionSetId: ready.projectionSetId,
              sourceId,
              schemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
              catalogVersion: snapshot.catalogVersion,
              catalogDigest: snapshot.catalogDigest,
              projectionVersion: CONNECTOR_CATALOG_RUNTIME_PROJECTION_VERSION,
              connectorCount: ready.connectorCount,
            },
          });
          if (actualCount === ready.connectorCount) {
            return;
          }
        }
      }
      const decoded = decodeConnectorCatalogSnapshot(snapshot);
      await persistConnectorCatalogRuntimeProjection({
        db: tx,
        sourceId,
        identity: snapshot,
        artifact: decoded.artifact,
        validator,
      });
    });
    signal.throwIfAborted();
  },
);
