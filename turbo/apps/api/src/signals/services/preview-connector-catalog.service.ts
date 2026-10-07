import {
  connectorCatalog,
  connectorCatalogActiveSnapshot,
  connectorCatalogSyncState,
  connectorCatalogCompatibilityEvaluation,
} from "@okouai/db/schema/connector-catalog";
import {
  CONNECTOR_CATALOG_ACTIVE_KEY,
  SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
} from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import {
  CONNECTOR_CATALOG_ACTIVE_MAX_BYTES,
  encodeConnectorCatalogSnapshot,
  parseConnectorCatalogActivePointer,
  validateConnectorCatalogCandidateBytes,
  type ValidatedConnectorCatalogCandidate,
} from "@okouai/connectors/connector-catalog/artifacts/loader";
import { CONNECTOR_CATALOG_MAX_RAW_BYTES } from "@okouai/connectors/connector-catalog/contracts";
import { command } from "ccstate";
import { and, eq, ne, sql } from "drizzle-orm";

import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { downloadS3BufferWithMaxBytes } from "../external/s3";
import {
  immutableCatalogValues,
  prepareImmutableCatalogEntries$,
} from "./connector-catalog-immutable.service";
import {
  connectorCatalogSource,
  type ConnectorCatalogSource,
} from "./connector-catalog-source";
import {
  connectorCatalogExecutableCapabilityState,
  connectorCatalogCompatibilityValues,
  connectorCatalogCompatibilityEvaluationSchema,
  evaluateConnectorCatalogCompatibility,
  type ExecutableCapabilityState,
} from "./connector-catalog-compatibility.service";
import {
  currentConnectorCatalogValidatorIdentity,
  type ConnectorCatalogValidatorIdentity,
} from "./connector-catalog-validator-authority";

const loadPreviewCatalogCandidate$ = command(
  async ({ get }, source: ConnectorCatalogSource, signal: AbortSignal) => {
    const pointerBytes = await get(
      downloadS3BufferWithMaxBytes(
        source.bucket,
        CONNECTOR_CATALOG_ACTIVE_KEY,
        CONNECTOR_CATALOG_ACTIVE_MAX_BYTES,
        signal,
      ),
    );
    signal.throwIfAborted();
    const pointer = parseConnectorCatalogActivePointer(pointerBytes);
    const rawBytes = await get(
      downloadS3BufferWithMaxBytes(
        source.bucket,
        pointer.catalogKey,
        CONNECTOR_CATALOG_MAX_RAW_BYTES,
        signal,
      ),
    );
    signal.throwIfAborted();
    return validateConnectorCatalogCandidateBytes({ pointer, rawBytes });
  },
);

function previewCatalogWriteValues(args: {
  readonly candidate: ValidatedConnectorCatalogCandidate;
  readonly sourceId: string;
  readonly timestamp: Date;
  readonly validator: ConnectorCatalogValidatorIdentity;
  readonly capability: ExecutableCapabilityState;
}) {
  const { candidate, sourceId, timestamp, validator, capability } = args;
  const compatibility = connectorCatalogCompatibilityValues({
    sourceId,
    identity: candidate.identity,
    capabilityDigest: capability.digest,
    validator,
    evaluatedAt: timestamp,
    payload: connectorCatalogCompatibilityEvaluationSchema.parse({
      filteredAuthMethods: evaluateConnectorCatalogCompatibility({
        artifact: candidate.artifact,
        capability,
      }),
    }),
  });
  return {
    compatibilityDeleteWhere: and(
      eq(connectorCatalogCompatibilityEvaluation.sourceId, sourceId),
      eq(
        connectorCatalogCompatibilityEvaluation.schemaVersion,
        SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
      ),
      ne(
        connectorCatalogCompatibilityEvaluation.catalogDigest,
        candidate.identity.catalogDigest,
      ),
    ),
    compatibility,
    current: immutableCatalogValues(
      candidate.artifact,
      candidate.identity.catalogDigest,
      timestamp,
    ),
    state: {
      lastObservedCatalogVersion: candidate.identity.catalogVersion,
      lastObservedCatalogKey: candidate.identity.catalogKey,
      lastObservedCatalogDigest: candidate.identity.catalogDigest,
      lastObservedPointerEtag: null,
      lastAttemptAt: timestamp,
      lastAttemptOutcome: "accepted" as const,
      lastAttemptReusedCachedRejection: false,
      lastSuccessAt: timestamp,
      lastFailureCode: null,
      lastRejectedCatalogVersion: null,
      lastRejectedCatalogKey: null,
      lastRejectedCatalogDigest: null,
      lastRejectedPointerEtag: null,
      lastRejectedFailureCode: null,
      lastRejectedBackendVersion: null,
      lastRejectedBuildCommitSha: null,
    },
    snapshot: {
      sourceId,
      schemaVersion: candidate.artifact.artifactSchemaVersion,
      catalogVersion: candidate.identity.catalogVersion,
      catalogKey: candidate.identity.catalogKey,
      catalogDigest: candidate.identity.catalogDigest,
      catalogRawSize: candidate.rawBytes.length,
      catalogGzip: encodeConnectorCatalogSnapshot(candidate.rawBytes),
      activatedAt: timestamp,
    },
  };
}

// Preview initialization of the complete validated official publication, not
// a new publication. Entry preparation is the production synchronizer's: it
// registers bundled skills for, then writes, every entry missing at this hash.
// The pointer switches only after that whole generation exists.
export const seedPreviewConnectorCatalog$ = command(
  async ({ set }, signal: AbortSignal) => {
    if (env("ENV") !== "preview") {
      throw new Error(
        "Preview connector catalog seed is restricted to preview",
      );
    }
    const source = connectorCatalogSource();
    const candidate = await set(loadPreviewCatalogCandidate$, source, signal);
    signal.throwIfAborted();
    await set(
      prepareImmutableCatalogEntries$,
      {
        artifact: candidate.artifact,
        hash: candidate.identity.catalogDigest,
      },
      signal,
    );
    signal.throwIfAborted();
    const {
      compatibilityDeleteWhere,
      compatibility,
      current,
      state,
      snapshot,
    } = previewCatalogWriteValues({
      candidate,
      sourceId: source.sourceId,
      timestamp: nowDate(),
      validator: currentConnectorCatalogValidatorIdentity(),
      capability: connectorCatalogExecutableCapabilityState(),
    });
    signal.throwIfAborted();
    await set(writeDb$).transaction(async (tx) => {
      await tx
        .insert(connectorCatalogSyncState)
        .values({
          sourceId: source.sourceId,
          schemaVersion: snapshot.schemaVersion,
          revision: 1,
          ...state,
        })
        .onConflictDoUpdate({
          target: [
            connectorCatalogSyncState.sourceId,
            connectorCatalogSyncState.schemaVersion,
          ],
          set: {
            ...state,
            revision: sql`${connectorCatalogSyncState.revision} + 1`,
          },
        });
      signal.throwIfAborted();
      await tx
        .insert(connectorCatalogActiveSnapshot)
        .values(snapshot)
        .onConflictDoUpdate({
          target: [
            connectorCatalogActiveSnapshot.sourceId,
            connectorCatalogActiveSnapshot.schemaVersion,
          ],
          set: snapshot,
        });
      signal.throwIfAborted();
      await tx.insert(connectorCatalog).values(current).onConflictDoUpdate({
        target: connectorCatalog.schemaVersion,
        set: current,
      });
      signal.throwIfAborted();
      await tx
        .delete(connectorCatalogCompatibilityEvaluation)
        .where(compatibilityDeleteWhere);
      signal.throwIfAborted();
      await tx
        .insert(connectorCatalogCompatibilityEvaluation)
        .values(compatibility)
        .onConflictDoUpdate({
          target: [
            connectorCatalogCompatibilityEvaluation.sourceId,
            connectorCatalogCompatibilityEvaluation.schemaVersion,
            connectorCatalogCompatibilityEvaluation.catalogVersion,
            connectorCatalogCompatibilityEvaluation.catalogDigest,
            connectorCatalogCompatibilityEvaluation.executableCapabilityDigest,
          ],
          set: {
            catalogValidationBackendVersion:
              compatibility.catalogValidationBackendVersion,
            catalogValidationBuildCommitSha:
              compatibility.catalogValidationBuildCommitSha,
            evaluatedAt: compatibility.evaluatedAt,
            filteredAuthMethods: compatibility.filteredAuthMethods,
          },
        });
      signal.throwIfAborted();
    });
    signal.throwIfAborted();
    return {
      catalogVersion: candidate.identity.catalogVersion,
      catalogDigest: candidate.identity.catalogDigest,
      connectorSlugs: current.entrySlugs,
    };
  },
);
