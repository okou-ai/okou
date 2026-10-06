import {
  ONBOARDING_RECOMMENDATION_CONNECTOR_SLUGS,
  ONBOARDING_WORKFLOW_CONNECTOR_SLUGS,
} from "@okouai/api-contracts/contracts/onboarding";
import {
  connectorCatalog,
  connectorCatalogEntries,
  connectorCatalogActiveSnapshot,
  connectorCatalogSyncState,
  connectorCatalogCompatibilityEvaluation,
} from "@okouai/db/schema/connector-catalog";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import {
  CONNECTOR_CATALOG_ACTIVE_KEY,
  SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
  type ConnectorCatalogArtifact,
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
import { and, eq, inArray, ne, sql } from "drizzle-orm";

import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { downloadS3BufferWithMaxBytes } from "../external/s3";
import {
  immutableCatalogEntryColumns,
  immutableCatalogValues,
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
import {
  connectorCatalogSkillRegistrationValues,
  registerPreparedConnectorCatalogSkills$,
} from "./connector-catalog-skill-registration.service";

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

const preparePreviewCatalogSkills$ = command(
  async ({ get }, artifact: ConnectorCatalogArtifact, signal: AbortSignal) => {
    const versionIds = artifact.connectors.flatMap((entry) => {
      return entry.skill.kind === "bundled" ? [entry.skill.versionId] : [];
    });
    if (versionIds.length === 0) {
      return [];
    }
    const rows = await get(db$)
      .select({
        id: storageVersions.id,
        storageId: storageVersions.storageId,
        orgId: storages.orgId,
        userId: storages.userId,
        name: storages.name,
        s3Prefix: storages.s3Prefix,
        s3Key: storageVersions.s3Key,
      })
      .from(storageVersions)
      .innerJoin(storages, eq(storageVersions.storageId, storages.id))
      .where(inArray(storageVersions.id, [...new Set(versionIds)]));
    signal.throwIfAborted();
    return connectorCatalogSkillRegistrationValues(artifact, rows);
  },
);

function previewCatalogProjection(artifact: ConnectorCatalogArtifact) {
  const slugs = new Set<string>([
    ...ONBOARDING_RECOMMENDATION_CONNECTOR_SLUGS,
    ...ONBOARDING_WORKFLOW_CONNECTOR_SLUGS,
    // Existing Runner E2E exercises these official manual connectors.
    "algolia",
    "bentoml",
    "discord-webhook",
    "serpapi",
    "twilio",
    "zendesk",
  ]);
  const connectors = artifact.connectors.filter((entry) => {
    return slugs.has(entry.slug);
  });
  if (connectors.length !== slugs.size) {
    throw new Error(
      "Published catalog is missing preview onboarding/E2E connectors",
    );
  }
  return { ...artifact, connectors };
}

function previewCatalogWriteValues(args: {
  readonly candidate: ValidatedConnectorCatalogCandidate;
  readonly projection: ConnectorCatalogArtifact;
  readonly sourceId: string;
  readonly timestamp: Date;
  readonly validator: ConnectorCatalogValidatorIdentity;
  readonly capability: ExecutableCapabilityState;
}) {
  const { candidate, projection, sourceId, timestamp, validator, capability } =
    args;
  const compatibility = connectorCatalogCompatibilityValues({
    sourceId,
    identity: candidate.identity,
    capabilityDigest: capability.digest,
    validator,
    evaluatedAt: timestamp,
    payload: connectorCatalogCompatibilityEvaluationSchema.parse({
      filteredAuthMethods: evaluateConnectorCatalogCompatibility({
        artifact: projection,
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
      projection,
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

// Preview materialization, not a new publication. The full validated official
// snapshot/digest remains the source; only its onboarding/E2E rows are installed.
export const seedPreviewOnboardingCatalog$ = command(
  async ({ set }, signal: AbortSignal) => {
    if (env("ENV") !== "preview") {
      throw new Error("Onboarding catalog seed is restricted to preview");
    }
    const source = connectorCatalogSource();
    const candidate = await set(loadPreviewCatalogCandidate$, source, signal);
    signal.throwIfAborted();
    const projection = previewCatalogProjection(candidate.artifact);
    const registrations = await set(
      preparePreviewCatalogSkills$,
      projection,
      signal,
    );
    await set(registerPreparedConnectorCatalogSkills$, registrations, signal);
    const {
      compatibilityDeleteWhere,
      compatibility,
      current,
      state,
      snapshot,
    } = previewCatalogWriteValues({
      candidate,
      projection,
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
      // Replace this preview generation atomically, including inherited rows.
      // No per-connector SQL or readback; published-byte validation is retained.
      await tx
        .delete(connectorCatalogEntries)
        .where(eq(connectorCatalogEntries.hash, current.hash));
      signal.throwIfAborted();
      await tx.insert(connectorCatalogEntries).values(
        projection.connectors.map((entry) => {
          return {
            hash: current.hash,
            slug: entry.slug,
            payload: entry,
            ...immutableCatalogEntryColumns(entry),
          };
        }),
      );
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
