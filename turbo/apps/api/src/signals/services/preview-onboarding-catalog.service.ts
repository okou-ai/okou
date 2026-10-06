import {
  ONBOARDING_RECOMMENDATION_CONNECTOR_SLUGS,
  ONBOARDING_WORKFLOW_CONNECTOR_SLUGS,
} from "@okouai/api-contracts/contracts/onboarding";
import {
  connectorCatalog,
  connectorCatalogEntries,
  connectorCatalogActiveSnapshot,
  connectorCatalogSyncState,
} from "@okouai/db/schema/connector-catalog";
import {
  CONNECTOR_CATALOG_ACTIVE_KEY,
  type ConnectorCatalogArtifact,
} from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import {
  CONNECTOR_CATALOG_ACTIVE_MAX_BYTES,
  encodeConnectorCatalogSnapshot,
  parseConnectorCatalogActivePointer,
  validateConnectorCatalogCandidateBytes,
} from "@okouai/connectors/connector-catalog/artifacts/loader";
import { CONNECTOR_CATALOG_MAX_RAW_BYTES } from "@okouai/connectors/connector-catalog/contracts";
import { command } from "ccstate";
import { eq, sql } from "drizzle-orm";

import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { downloadS3BufferWithMaxBytes } from "../external/s3";
import { immutableCatalogValues } from "./connector-catalog-immutable.service";
import {
  connectorCatalogSource,
  type ConnectorCatalogSource,
} from "./connector-catalog-source";
import {
  connectorCatalogExecutableCapabilityState,
  persistConnectorCatalogCompatibility,
} from "./connector-catalog-compatibility.service";
import { persistConnectorCatalogRuntimeProjection } from "./connector-catalog-runtime-projection.service";
import { currentConnectorCatalogValidatorIdentity } from "./connector-catalog-validator-authority";
import {
  prepareConnectorCatalogSkills,
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
    const registrations = await prepareConnectorCatalogSkills(
      { db: set(writeDb$), artifact: projection },
      signal,
    );
    await set(registerPreparedConnectorCatalogSkills$, registrations, signal);
    const timestamp = nowDate();
    const validator = currentConnectorCatalogValidatorIdentity();
    const capability = connectorCatalogExecutableCapabilityState();
    const current = immutableCatalogValues(
      projection,
      candidate.identity.catalogDigest,
      timestamp,
    );
    const state = {
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
    };
    const snapshot = {
      sourceId: source.sourceId,
      schemaVersion: candidate.artifact.artifactSchemaVersion,
      catalogVersion: candidate.identity.catalogVersion,
      catalogKey: candidate.identity.catalogKey,
      catalogDigest: candidate.identity.catalogDigest,
      catalogRawSize: candidate.rawBytes.length,
      catalogGzip: encodeConnectorCatalogSnapshot(candidate.rawBytes),
      activatedAt: timestamp,
    };
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
      // Replace this preview generation atomically, including inherited rows.
      // No per-connector SQL or readback; published-byte validation is retained.
      await tx
        .delete(connectorCatalogEntries)
        .where(eq(connectorCatalogEntries.hash, current.hash));
      await tx.insert(connectorCatalogEntries).values(
        projection.connectors.map((entry) => {
          return { hash: current.hash, slug: entry.slug, payload: entry };
        }),
      );
      await tx.insert(connectorCatalog).values(current).onConflictDoUpdate({
        target: connectorCatalog.schemaVersion,
        set: current,
      });
      await persistConnectorCatalogCompatibility({
        db: tx,
        sourceId: source.sourceId,
        identity: candidate.identity,
        artifact: projection,
        capability,
        validator,
      });
      await persistConnectorCatalogRuntimeProjection({
        db: tx,
        sourceId: source.sourceId,
        identity: candidate.identity,
        artifact: projection,
        validator,
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
