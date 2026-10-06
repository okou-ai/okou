import { createHash } from "node:crypto";

import { createStore } from "ccstate";
import { getConnectorAuthProviderRegistrationCapabilities } from "@okouai/connectors/auth-providers";
import {
  connectorCatalog,
  connectorCatalogEntries,
  connectorCatalogActiveSnapshot,
  connectorCatalogCompatibilityEvaluation,
  connectorCatalogSyncState,
} from "@okouai/db/schema/connector-catalog";
import type { ConnectorCatalogCompatibilityEvaluationPayload } from "@okouai/db/jsonb-contracts/connector-catalog";
import { and, asc, eq } from "drizzle-orm";

import { mockOptionalEnv } from "../lib/env";
import type { Tx } from "../lib/db-types";
import { closeDbPool } from "../lib/db";
import { settleIncludingAbort } from "../signals/utils";
import { writeDb$ } from "../signals/external/db";
import { nowDate } from "../lib/time";
import {
  connectorCatalogArtifactSchema,
  SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
  type ConnectorCatalogArtifact,
} from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import { encodeConnectorCatalogSnapshot } from "@okouai/connectors/connector-catalog/artifacts/loader";
import {
  connectorCatalogFirewallConfig,
  validateConnectorCatalogArtifact,
} from "@okouai/connectors/connector-catalog/artifacts/relationships";
import {
  connectorCatalogExecutableCapabilityState,
  connectorCatalogCompatibilityEvaluationSchema,
  persistConnectorCatalogCompatibility,
} from "../signals/services/connector-catalog-compatibility.service";
import { connectorCatalogSource } from "../signals/services/connector-catalog-source";
import {
  immutableCatalogEntryColumns,
  immutableCatalogValues,
} from "../signals/services/connector-catalog-immutable.service";
import {
  currentConnectorCatalogValidatorIdentity,
  type ConnectorCatalogValidationAuthority,
} from "../signals/services/connector-catalog-validator-authority";
import { API_TEST_CONNECTOR_CATALOG_ARTIFACT } from "./connector-catalog-artifact";

export const API_TEST_CONNECTOR_CATALOG = connectorCatalogArtifactSchema.parse(
  API_TEST_CONNECTOR_CATALOG_ARTIFACT,
);

validateConnectorCatalogArtifact(API_TEST_CONNECTOR_CATALOG);

export const API_TEST_CONNECTOR_FIREWALL_CONFIGS =
  API_TEST_CONNECTOR_CATALOG.connectors.flatMap((connector) => {
    const firewall = connectorCatalogFirewallConfig(connector);
    return firewall === null ? [] : [firewall];
  });

export const API_TEST_CONNECTOR_CATALOG_SOURCE = connectorCatalogSource();

export async function installSharedApiTestConnectorCatalog(): Promise<void> {
  const installation = await settleIncludingAbort(
    installApiTestConnectorCatalog({
      sourceId: API_TEST_CONNECTOR_CATALOG_SOURCE.sourceId,
      ifAbsent: true,
    }),
  );
  // Startup owns this connection, not the case's database authority. Cases
  // may deliberately choose an unavailable endpoint before their first read.
  const shutdown = await settleIncludingAbort(closeDbPool());
  if (!installation.ok) {
    throw installation.error;
  }
  if (!shutdown.ok) {
    throw shutdown.error;
  }
}

const DEFAULT_API_TEST_CONNECTOR_CATALOG_VERSION =
  API_TEST_CONNECTOR_CATALOG.catalogVersion;

function apiTestConnectorCatalogKey(catalogVersion: string): string {
  return (
    `connectors/v${String(SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION)}/` +
    `releases/${catalogVersion}/catalog.json`
  );
}

const store = createStore();

function sha256Digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function mockApiTestConnectorProviderConfiguration(): void {
  const requiredNames = new Set(
    getConnectorAuthProviderRegistrationCapabilities().flatMap(
      (registration) => {
        return registration.requiredConfigurationNames;
      },
    ),
  );
  for (const name of requiredNames) {
    mockOptionalEnv(name, `api-test-${name.toLowerCase()}`);
  }
}

async function prepareSharedCatalogRows(args: {
  readonly tx: Tx;
  readonly syncState: typeof connectorCatalogSyncState.$inferInsert;
  readonly catalog: ConnectorCatalogArtifact;
  readonly hash: string;
  readonly activatedAt: Date;
}): Promise<boolean> {
  // The winning INSERT and all fixture rows commit together. Concurrent
  // workers wait on that conflict instead of replacing shared authority.
  const inserted = await args.tx
    .insert(connectorCatalogSyncState)
    .values(args.syncState)
    .onConflictDoNothing()
    .returning();
  if (inserted.length === 0) {
    const [snapshot] = await args.tx
      .select({ hash: connectorCatalogActiveSnapshot.catalogDigest })
      .from(connectorCatalogActiveSnapshot)
      .where(
        and(
          eq(connectorCatalogActiveSnapshot.sourceId, args.syncState.sourceId),
          eq(
            connectorCatalogActiveSnapshot.schemaVersion,
            args.syncState.schemaVersion,
          ),
        ),
      );
    if (snapshot?.hash !== args.hash) {
      throw new Error(
        "Shared test catalog identity does not match the fixed fixture",
      );
    }
    return false;
  }
  const { connectors, ...catalogHeader } = args.catalog;
  await args.tx
    .insert(connectorCatalogEntries)
    .values(
      connectors.map((connector) => {
        return {
          hash: args.hash,
          slug: connector.slug,
          payload: connector,
          ...immutableCatalogEntryColumns(connector),
        };
      }),
    )
    .onConflictDoNothing();
  await args.tx
    .insert(connectorCatalog)
    .values({
      schemaVersion: args.catalog.artifactSchemaVersion,
      hash: args.hash,
      catalogVersion: args.catalog.catalogVersion,
      activatedAt: args.activatedAt,
      catalogHeader,
      entrySlugs: connectors
        .map((connector) => {
          return connector.slug;
        })
        .sort(),
    })
    .onConflictDoNothing();
  return true;
}

function requireOwnedLegacyCatalogSource(sourceId: string): void {
  if (sourceId === API_TEST_CONNECTOR_CATALOG_SOURCE.sourceId) {
    throw new Error(
      "Legacy catalog mutation must own a separate source; the shared test catalog is immutable",
    );
  }
}

async function publishOwnedImmutableCatalog(args: {
  readonly tx: Tx;
  readonly catalog: ConnectorCatalogArtifact;
  readonly hash: string;
  readonly activatedAt: Date;
}): Promise<void> {
  await args.tx
    .insert(connectorCatalogEntries)
    .values(
      args.catalog.connectors.map((connector) => {
        return {
          hash: args.hash,
          slug: connector.slug,
          payload: connector,
          ...immutableCatalogEntryColumns(connector),
        };
      }),
    )
    .onConflictDoNothing();
  const values = immutableCatalogValues(
    args.catalog,
    args.hash,
    args.activatedAt,
  );
  await args.tx.insert(connectorCatalog).values(values).onConflictDoUpdate({
    target: connectorCatalog.schemaVersion,
    set: values,
  });
}

export async function installApiTestConnectorCatalog(
  options: {
    readonly catalogVersion?: string;
    readonly sourceId?: string;
    readonly catalog?: ConnectorCatalogArtifact;
    readonly ifAbsent?: boolean;
  } = {},
): Promise<void> {
  const catalogVersion =
    options.catalogVersion ??
    options.catalog?.catalogVersion ??
    DEFAULT_API_TEST_CONNECTOR_CATALOG_VERSION;
  const catalog =
    options.catalog ??
    (catalogVersion === DEFAULT_API_TEST_CONNECTOR_CATALOG_VERSION
      ? API_TEST_CONNECTOR_CATALOG
      : connectorCatalogArtifactSchema.parse({
          ...API_TEST_CONNECTOR_CATALOG_ARTIFACT,
          catalogVersion,
        }));
  validateConnectorCatalogArtifact(catalog);
  const rawBytes = Buffer.from(`${JSON.stringify(catalog)}\n`);
  const catalogDigest = sha256Digest(rawBytes);
  const catalogGzip = encodeConnectorCatalogSnapshot(rawBytes);
  const sourceId = options.sourceId ?? connectorCatalogSource().sourceId;
  if (!options.ifAbsent) {
    requireOwnedLegacyCatalogSource(sourceId);
  }
  const capability = connectorCatalogExecutableCapabilityState();
  const activatedAt = nowDate();
  const db = store.set(writeDb$);
  const syncStateValues = {
    revision: 1,
    lastObservedCatalogVersion: catalogVersion,
    lastObservedCatalogKey: apiTestConnectorCatalogKey(catalogVersion),
    lastObservedCatalogDigest: catalogDigest,
    lastObservedPointerEtag: null,
    lastAttemptAt: activatedAt,
    lastAttemptOutcome: "accepted" as const,
    lastAttemptReusedCachedRejection: false,
    lastSuccessAt: activatedAt,
    lastFailureCode: null,
    lastRejectedCatalogVersion: null,
    lastRejectedCatalogKey: null,
    lastRejectedCatalogDigest: null,
    lastRejectedPointerEtag: null,
    lastRejectedFailureCode: null,
    lastRejectedBackendVersion: null,
    lastRejectedBuildCommitSha: null,
  };
  const snapshotValues = {
    catalogVersion,
    catalogKey: apiTestConnectorCatalogKey(catalogVersion),
    catalogDigest,
    catalogRawSize: rawBytes.byteLength,
    catalogGzip,
    activatedAt,
  };

  await db.transaction(async (tx) => {
    const syncState = {
      sourceId,
      schemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
      ...syncStateValues,
    };
    if (options.ifAbsent) {
      const installed = await prepareSharedCatalogRows({
        tx,
        syncState,
        catalog,
        hash: catalogDigest,
        activatedAt,
      });
      if (!installed) {
        return;
      }
    } else {
      // Generation-owning fixtures publish the same pointer/entries as cron.
      await publishOwnedImmutableCatalog({
        tx,
        catalog,
        hash: catalogDigest,
        activatedAt,
      });
      await tx
        .insert(connectorCatalogSyncState)
        .values(syncState)
        .onConflictDoUpdate({
          target: [
            connectorCatalogSyncState.sourceId,
            connectorCatalogSyncState.schemaVersion,
          ],
          set: syncStateValues,
        });
    }
    await tx
      .insert(connectorCatalogActiveSnapshot)
      .values({
        sourceId,
        schemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
        ...snapshotValues,
      })
      .onConflictDoUpdate({
        target: [
          connectorCatalogActiveSnapshot.sourceId,
          connectorCatalogActiveSnapshot.schemaVersion,
        ],
        set: snapshotValues,
      });
    await persistConnectorCatalogCompatibility({
      db: tx,
      sourceId,
      identity: {
        catalogVersion,
        catalogDigest,
      },
      artifact: catalog,
      capability,
      validator: currentConnectorCatalogValidatorIdentity(),
    });
  });
}

export async function readApiTestConnectorCatalogSnapshot(
  sourceId: string,
): Promise<{
  readonly catalogVersion: string;
  readonly catalogDigest: string;
  readonly catalogRawSize: number;
  readonly catalogGzip: Buffer;
}> {
  const db = store.set(writeDb$);
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
    .limit(1);
  if (snapshot === undefined) {
    throw new Error("Expected an active API test connector catalog snapshot");
  }
  return snapshot;
}

export function captureApiTestConnectorCatalogCleanup(): () => Promise<void> {
  const { sourceId } = connectorCatalogSource();
  if (sourceId === API_TEST_CONNECTOR_CATALOG_SOURCE.sourceId) {
    throw new Error("The shared test catalog must not be deleted by a test");
  }
  return async () => {
    await deleteApiTestConnectorCatalogSource(sourceId);
  };
}

async function deleteApiTestConnectorCatalogSource(
  sourceId: string,
): Promise<void> {
  const db = store.set(writeDb$);
  await db.transaction(async (tx) => {
    // Remove source children before their sync-state parent.
    await tx
      .delete(connectorCatalogCompatibilityEvaluation)
      .where(eq(connectorCatalogCompatibilityEvaluation.sourceId, sourceId));
    await tx
      .delete(connectorCatalogActiveSnapshot)
      .where(eq(connectorCatalogActiveSnapshot.sourceId, sourceId));
    await tx
      .delete(connectorCatalogSyncState)
      .where(eq(connectorCatalogSyncState.sourceId, sourceId));
  });
}

interface ApiTestConnectorCatalogIdentity {
  readonly sourceId: string;
  readonly catalogVersion: string;
  readonly catalogDigest: string;
  readonly capabilityDigest: string;
}

async function currentApiTestConnectorCatalogIdentity(): Promise<ApiTestConnectorCatalogIdentity> {
  const sourceId = connectorCatalogSource().sourceId;
  const capabilityDigest = connectorCatalogExecutableCapabilityState().digest;
  const db = store.set(writeDb$);
  const [identity] = await db
    .select({
      catalogVersion: connectorCatalogActiveSnapshot.catalogVersion,
      catalogDigest: connectorCatalogActiveSnapshot.catalogDigest,
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
  if (identity === undefined) {
    throw new Error("Expected an active API test connector catalog");
  }
  return { sourceId, capabilityDigest, ...identity };
}

function currentApiTestConnectorCatalogCompatibilityWhere(
  identity: ApiTestConnectorCatalogIdentity,
) {
  return and(
    eq(connectorCatalogCompatibilityEvaluation.sourceId, identity.sourceId),
    eq(
      connectorCatalogCompatibilityEvaluation.schemaVersion,
      SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
    ),
    eq(
      connectorCatalogCompatibilityEvaluation.catalogVersion,
      identity.catalogVersion,
    ),
    eq(
      connectorCatalogCompatibilityEvaluation.catalogDigest,
      identity.catalogDigest,
    ),
    eq(
      connectorCatalogCompatibilityEvaluation.executableCapabilityDigest,
      identity.capabilityDigest,
    ),
  );
}

function requireSingleCatalogMutation(
  rows: readonly unknown[],
  operation: string,
): void {
  if (rows.length !== 1) {
    throw new Error(
      `Expected ${operation} to affect one connector catalog row`,
    );
  }
}

export function apiTestConnectorCatalogValidationAuthority(): ConnectorCatalogValidationAuthority {
  const validator = currentConnectorCatalogValidatorIdentity();
  return {
    validatorVersion: validator.validatorVersion,
    buildCommitSha: validator.buildCommitSha,
  };
}

interface ApiTestConnectorCatalogCompatibilityEvaluation {
  readonly catalogVersion: string;
  readonly catalogDigest: string;
  readonly capabilityDigest: string;
  readonly validationAuthority: ConnectorCatalogValidationAuthority | null;
  readonly evaluatedAt: string;
  readonly payload: unknown;
}

export async function readApiTestConnectorCatalogCompatibilityEvaluations(): Promise<
  readonly ApiTestConnectorCatalogCompatibilityEvaluation[]
> {
  const sourceId = connectorCatalogSource().sourceId;
  const db = store.set(writeDb$);
  const rows = await db
    .select({
      catalogVersion: connectorCatalogCompatibilityEvaluation.catalogVersion,
      catalogDigest: connectorCatalogCompatibilityEvaluation.catalogDigest,
      capabilityDigest:
        connectorCatalogCompatibilityEvaluation.executableCapabilityDigest,
      catalogValidationBackendVersion:
        connectorCatalogCompatibilityEvaluation.catalogValidationBackendVersion,
      catalogValidationBuildCommitSha:
        connectorCatalogCompatibilityEvaluation.catalogValidationBuildCommitSha,
      evaluatedAt: connectorCatalogCompatibilityEvaluation.evaluatedAt,
      payload: connectorCatalogCompatibilityEvaluation.filteredAuthMethods,
    })
    .from(connectorCatalogCompatibilityEvaluation)
    .where(
      and(
        eq(connectorCatalogCompatibilityEvaluation.sourceId, sourceId),
        eq(
          connectorCatalogCompatibilityEvaluation.schemaVersion,
          SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
        ),
      ),
    )
    .orderBy(
      asc(connectorCatalogCompatibilityEvaluation.catalogDigest),
      asc(connectorCatalogCompatibilityEvaluation.executableCapabilityDigest),
    );
  return rows.map((row) => {
    return {
      catalogVersion: row.catalogVersion,
      catalogDigest: row.catalogDigest,
      capabilityDigest: row.capabilityDigest,
      validationAuthority:
        row.catalogValidationBackendVersion === null
          ? null
          : {
              validatorVersion: row.catalogValidationBackendVersion,
              buildCommitSha: row.catalogValidationBuildCommitSha,
            },
      evaluatedAt: row.evaluatedAt.toISOString(),
      payload: row.payload,
    };
  });
}

export async function readApiTestConnectorCatalogValidationAuthority(): Promise<ConnectorCatalogValidationAuthority | null> {
  const identity = await currentApiTestConnectorCatalogIdentity();
  const db = store.set(writeDb$);
  const [row] = await db
    .select({
      catalogValidationBackendVersion:
        connectorCatalogCompatibilityEvaluation.catalogValidationBackendVersion,
      catalogValidationBuildCommitSha:
        connectorCatalogCompatibilityEvaluation.catalogValidationBuildCommitSha,
    })
    .from(connectorCatalogCompatibilityEvaluation)
    .where(currentApiTestConnectorCatalogCompatibilityWhere(identity))
    .limit(1);
  if (row === undefined) {
    throw new Error(
      "Expected a current API test connector catalog compatibility evaluation",
    );
  }
  return row.catalogValidationBackendVersion === null
    ? null
    : {
        validatorVersion: row.catalogValidationBackendVersion,
        buildCommitSha: row.catalogValidationBuildCommitSha,
      };
}

export async function setApiTestConnectorCatalogValidationAuthority(
  authority: ConnectorCatalogValidationAuthority | null,
): Promise<void> {
  const identity = await currentApiTestConnectorCatalogIdentity();
  const db = store.set(writeDb$);
  const updated = await db
    .update(connectorCatalogCompatibilityEvaluation)
    .set({
      catalogValidationBackendVersion: authority?.validatorVersion ?? null,
      catalogValidationBuildCommitSha: authority?.buildCommitSha ?? null,
    })
    .where(currentApiTestConnectorCatalogCompatibilityWhere(identity))
    .returning({ sourceId: connectorCatalogCompatibilityEvaluation.sourceId });
  requireSingleCatalogMutation(updated, "validation-authority update");
}

export async function corruptApiTestConnectorCatalogActiveSnapshotPayload(): Promise<void> {
  const identity = await currentApiTestConnectorCatalogIdentity();
  const db = store.set(writeDb$);
  const updated = await db
    .update(connectorCatalogActiveSnapshot)
    .set({ catalogGzip: Buffer.from("invalid-gzip", "utf8") })
    .where(
      and(
        eq(connectorCatalogActiveSnapshot.sourceId, identity.sourceId),
        eq(
          connectorCatalogActiveSnapshot.schemaVersion,
          SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
        ),
        eq(
          connectorCatalogActiveSnapshot.catalogVersion,
          identity.catalogVersion,
        ),
        eq(
          connectorCatalogActiveSnapshot.catalogDigest,
          identity.catalogDigest,
        ),
      ),
    )
    .returning({ sourceId: connectorCatalogActiveSnapshot.sourceId });
  requireSingleCatalogMutation(updated, "active snapshot payload corruption");
}

export async function invalidateApiTestConnectorCatalogCompatibility(): Promise<void> {
  const identity = await currentApiTestConnectorCatalogIdentity();
  const db = store.set(writeDb$);
  const updated = await db
    .update(connectorCatalogCompatibilityEvaluation)
    .set({
      filteredAuthMethods: {
        filteredAuthMethods: [
          {
            connectorSlug: "external-test",
            authMethodId: "api-token",
            reasons: [],
          },
        ],
      },
    })
    .where(currentApiTestConnectorCatalogCompatibilityWhere(identity))
    .returning({ sourceId: connectorCatalogCompatibilityEvaluation.sourceId });
  requireSingleCatalogMutation(updated, "compatibility corruption");
}

export async function replaceApiTestConnectorCatalogFilteredAuthMethods(
  filteredAuthMethods: ConnectorCatalogCompatibilityEvaluationPayload["filteredAuthMethods"],
): Promise<void> {
  const identity = await currentApiTestConnectorCatalogIdentity();
  const payload = connectorCatalogCompatibilityEvaluationSchema.parse({
    filteredAuthMethods,
  });
  const db = store.set(writeDb$);
  const updated = await db
    .update(connectorCatalogCompatibilityEvaluation)
    .set({ filteredAuthMethods: payload })
    .where(currentApiTestConnectorCatalogCompatibilityWhere(identity))
    .returning({ sourceId: connectorCatalogCompatibilityEvaluation.sourceId });
  requireSingleCatalogMutation(updated, "compatibility filter replacement");
}

export async function deleteApiTestConnectorCatalogCompatibilityEvaluation(
  capabilityDigest: string,
): Promise<void> {
  const identity = await currentApiTestConnectorCatalogIdentity();
  const db = store.set(writeDb$);
  const deleted = await db
    .delete(connectorCatalogCompatibilityEvaluation)
    .where(
      currentApiTestConnectorCatalogCompatibilityWhere({
        ...identity,
        capabilityDigest,
      }),
    )
    .returning({ sourceId: connectorCatalogCompatibilityEvaluation.sourceId });
  requireSingleCatalogMutation(deleted, "compatibility evaluation deletion");
}
