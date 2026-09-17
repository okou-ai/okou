import type {
  ConnectorCatalogFilteredAuthMethod,
  ConnectorCatalogFilteringStatus,
} from "@okouai/api-contracts/contracts/connector-catalog-diagnostics";
import {
  connectorCatalogActiveSnapshot,
  connectorCatalogCompatibilityEvaluation,
  connectorCatalogSyncState,
} from "@okouai/db/schema/connector-catalog";
import type {
  ConnectorCatalogCompatibilityEvaluationPayload,
  ConnectorCatalogCompatibilityFilteredAuthMethod,
} from "@okouai/db/jsonb-contracts/connector-catalog";
import { command } from "ccstate";
import { and, eq, isNull, lte, ne, or, sql } from "drizzle-orm";
import { optionalEnv } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { db$, writeDb$, type Db, type ReadonlyDb } from "../external/db";
import {
  SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
  type ConnectorCatalogArtifact,
} from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import { decodeConnectorCatalogSnapshot } from "@okouai/connectors/connector-catalog/artifacts/loader";
import {
  connectorCatalogCompatibilityEvaluationSchema,
  connectorCatalogExecutableCapabilityState as buildConnectorCatalogExecutableCapabilityState,
  evaluateConnectorCatalogCompatibility,
  type ExecutableCapabilityState,
} from "@okouai/connectors/connector-catalog/compatibility";
import { connectorCatalogSource } from "./connector-catalog-source";
import {
  connectorCatalogValidationAuthorityIsCurrentOrNewer,
  currentConnectorCatalogValidatorIdentity,
  type ConnectorCatalogValidatorIdentity,
} from "./connector-catalog-validator-authority";

export {
  connectorCatalogCompatibilityEvaluationSchema,
  evaluateConnectorCatalogCompatibility,
};
export type { ExecutableCapabilityState };

interface ConnectorCatalogCompatibilityIdentity {
  readonly catalogVersion: string;
  readonly catalogDigest: string;
}

interface CanonicalSnapshot extends ConnectorCatalogCompatibilityIdentity {
  readonly catalogRawSize: number;
  readonly catalogGzip: Buffer;
}

export function connectorCatalogExecutableCapabilityState(): ExecutableCapabilityState {
  return buildConnectorCatalogExecutableCapabilityState({
    isConfigured: (name) => {
      return optionalEnv(name) !== undefined;
    },
  });
}

export function connectorCatalogExecutableCapabilityDigest(): string {
  return connectorCatalogExecutableCapabilityState().digest;
}

async function deleteReplacedEvaluations(args: {
  readonly db: Db;
  readonly sourceId: string;
  readonly catalogDigest: string;
}): Promise<void> {
  await args.db
    .delete(connectorCatalogCompatibilityEvaluation)
    .where(
      and(
        eq(connectorCatalogCompatibilityEvaluation.sourceId, args.sourceId),
        eq(
          connectorCatalogCompatibilityEvaluation.schemaVersion,
          SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
        ),
        ne(
          connectorCatalogCompatibilityEvaluation.catalogDigest,
          args.catalogDigest,
        ),
      ),
    );
}

async function persistConnectorCatalogCompatibilityEvaluation(args: {
  readonly db: Db;
  readonly sourceId: string;
  readonly identity: ConnectorCatalogCompatibilityIdentity;
  readonly capabilityDigest: string;
  readonly validator: ConnectorCatalogValidatorIdentity;
  readonly evaluatedAt: Date;
  readonly payload: ConnectorCatalogCompatibilityEvaluationPayload;
}): Promise<void> {
  await args.db
    .insert(connectorCatalogCompatibilityEvaluation)
    .values({
      sourceId: args.sourceId,
      schemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
      catalogVersion: args.identity.catalogVersion,
      catalogDigest: args.identity.catalogDigest,
      executableCapabilityDigest: args.capabilityDigest,
      catalogValidationBackendVersion: args.validator.validatorVersion,
      catalogValidationBuildCommitSha: args.validator.buildCommitSha,
      evaluatedAt: args.evaluatedAt,
      filteredAuthMethods: args.payload,
    })
    .onConflictDoUpdate({
      target: [
        connectorCatalogCompatibilityEvaluation.sourceId,
        connectorCatalogCompatibilityEvaluation.schemaVersion,
        connectorCatalogCompatibilityEvaluation.catalogVersion,
        connectorCatalogCompatibilityEvaluation.catalogDigest,
        connectorCatalogCompatibilityEvaluation.executableCapabilityDigest,
      ],
      set: {
        catalogValidationBackendVersion: args.validator.validatorVersion,
        catalogValidationBuildCommitSha: args.validator.buildCommitSha,
        evaluatedAt: args.evaluatedAt,
        filteredAuthMethods: args.payload,
      },
      // A draining older API release must not downgrade an attestation written
      // by a newer release during a rolling deployment.
      setWhere: or(
        isNull(
          connectorCatalogCompatibilityEvaluation.catalogValidationBackendVersion,
        ),
        lte(
          sql`string_to_array(${connectorCatalogCompatibilityEvaluation.catalogValidationBackendVersion}, '.')::numeric[]`,
          sql`string_to_array(${args.validator.validatorVersion}, '.')::numeric[]`,
        ),
      ),
    });
}

export async function persistConnectorCatalogCompatibility(args: {
  readonly db: Db;
  readonly sourceId: string;
  readonly identity: ConnectorCatalogCompatibilityIdentity;
  readonly artifact: ConnectorCatalogArtifact;
  readonly capability: ExecutableCapabilityState;
  readonly validator: ConnectorCatalogValidatorIdentity;
}): Promise<void> {
  await deleteReplacedEvaluations({
    db: args.db,
    sourceId: args.sourceId,
    catalogDigest: args.identity.catalogDigest,
  });
  const filteredAuthMethods = evaluateConnectorCatalogCompatibility({
    artifact: args.artifact,
    capability: args.capability,
  });
  const evaluatedAt = nowDate();
  const payload = connectorCatalogCompatibilityEvaluationSchema.parse({
    filteredAuthMethods,
  });
  await persistConnectorCatalogCompatibilityEvaluation({
    ...args,
    capabilityDigest: args.capability.digest,
    evaluatedAt,
    payload,
  });
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

async function activeSnapshotForUpdate(
  db: Db,
  sourceId: string,
): Promise<CanonicalSnapshot | undefined> {
  const [snapshot] = await db
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
    .limit(1)
    .for("update");
  return snapshot;
}

function staleFilteringStatus(
  capabilityDigest: string,
): ConnectorCatalogFilteringStatus {
  return {
    capabilityDigest,
    evaluatedAt: null,
    stale: true,
    filteredAuthMethods: [],
  };
}

async function reconcileCompatibility(args: {
  readonly db: Db;
  readonly sourceId: string;
  readonly capability: ExecutableCapabilityState;
  readonly validator: ConnectorCatalogValidatorIdentity;
}): Promise<void> {
  const hasState = await lockSyncState(args.db, args.sourceId);
  if (!hasState) {
    return;
  }
  const snapshot = await activeSnapshotForUpdate(args.db, args.sourceId);
  if (snapshot === undefined) {
    return;
  }

  const [existing] = await args.db
    .select({
      catalogValidationBackendVersion:
        connectorCatalogCompatibilityEvaluation.catalogValidationBackendVersion,
      catalogValidationBuildCommitSha:
        connectorCatalogCompatibilityEvaluation.catalogValidationBuildCommitSha,
    })
    .from(connectorCatalogCompatibilityEvaluation)
    .where(
      and(
        eq(connectorCatalogCompatibilityEvaluation.sourceId, args.sourceId),
        eq(
          connectorCatalogCompatibilityEvaluation.schemaVersion,
          SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
        ),
        eq(
          connectorCatalogCompatibilityEvaluation.catalogVersion,
          snapshot.catalogVersion,
        ),
        eq(
          connectorCatalogCompatibilityEvaluation.catalogDigest,
          snapshot.catalogDigest,
        ),
        eq(
          connectorCatalogCompatibilityEvaluation.executableCapabilityDigest,
          args.capability.digest,
        ),
      ),
    )
    .limit(1);
  if (
    existing !== undefined &&
    existing.catalogValidationBackendVersion !== null &&
    connectorCatalogValidationAuthorityIsCurrentOrNewer({
      authority: {
        validatorVersion: existing.catalogValidationBackendVersion,
        buildCommitSha: existing.catalogValidationBuildCommitSha,
      },
      validator: args.validator,
    })
  ) {
    return;
  }

  const decoded = decodeConnectorCatalogSnapshot(snapshot);
  await persistConnectorCatalogCompatibility({
    db: args.db,
    sourceId: args.sourceId,
    identity: snapshot,
    artifact: decoded.artifact,
    capability: args.capability,
    validator: args.validator,
  });
}

function diagnosticFilteredAuthMethods(
  filteredAuthMethods: readonly ConnectorCatalogCompatibilityFilteredAuthMethod[],
): ConnectorCatalogFilteredAuthMethod[] {
  return filteredAuthMethods.map((method) => {
    return {
      connectorSlug: method.connectorSlug,
      authMethodId: method.authMethodId,
      reasons: [...method.reasons],
    };
  });
}

async function compatibilityStatus(args: {
  readonly db: ReadonlyDb;
  readonly sourceId: string;
  readonly capabilityDigest: string;
  readonly snapshot: ConnectorCatalogCompatibilityIdentity | null;
}): Promise<ConnectorCatalogFilteringStatus> {
  if (args.snapshot === null) {
    return staleFilteringStatus(args.capabilityDigest);
  }

  const [result] = await args.db
    .select({
      evaluatedAt: connectorCatalogCompatibilityEvaluation.evaluatedAt,
      filteredAuthMethods:
        connectorCatalogCompatibilityEvaluation.filteredAuthMethods,
    })
    .from(connectorCatalogCompatibilityEvaluation)
    .where(
      and(
        eq(connectorCatalogCompatibilityEvaluation.sourceId, args.sourceId),
        eq(
          connectorCatalogCompatibilityEvaluation.schemaVersion,
          SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
        ),
        eq(
          connectorCatalogCompatibilityEvaluation.catalogVersion,
          args.snapshot.catalogVersion,
        ),
        eq(
          connectorCatalogCompatibilityEvaluation.catalogDigest,
          args.snapshot.catalogDigest,
        ),
        eq(
          connectorCatalogCompatibilityEvaluation.executableCapabilityDigest,
          args.capabilityDigest,
        ),
      ),
    )
    .limit(1);
  if (result === undefined) {
    return staleFilteringStatus(args.capabilityDigest);
  }
  return {
    capabilityDigest: args.capabilityDigest,
    evaluatedAt: result.evaluatedAt.toISOString(),
    stale: false,
    filteredAuthMethods: diagnosticFilteredAuthMethods(
      connectorCatalogCompatibilityEvaluationSchema.parse(
        result.filteredAuthMethods,
      ).filteredAuthMethods,
    ),
  };
}

export const reconcileConnectorCatalogCompatibility$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    const source = connectorCatalogSource();
    const capability = connectorCatalogExecutableCapabilityState();
    const validator = currentConnectorCatalogValidatorIdentity();
    await set(writeDb$).transaction(async (tx) => {
      await reconcileCompatibility({
        db: tx,
        sourceId: source.sourceId,
        capability,
        validator,
      });
    });
    signal.throwIfAborted();
  },
);

export const connectorCatalogCompatibilityStatus$ = command(
  async (
    { get },
    snapshot: ConnectorCatalogCompatibilityIdentity | null,
    signal: AbortSignal,
  ): Promise<ConnectorCatalogFilteringStatus> => {
    const source = connectorCatalogSource();
    const capability = connectorCatalogExecutableCapabilityState();
    const status = await compatibilityStatus({
      db: get(db$),
      sourceId: source.sourceId,
      capabilityDigest: capability.digest,
      snapshot,
    });
    signal.throwIfAborted();
    return status;
  },
);
