import { createHash } from "node:crypto";

import { createStore } from "ccstate";
import { getConnectorAuthProviderRegistrationCapabilities } from "@okouai/connectors/auth-providers";
import {
  connectorCatalogActiveSnapshot,
  connectorCatalogCompatibilityEvaluation,
  connectorCatalogRuntimeProjections,
  connectorCatalogRuntimeProjectionSets,
  connectorCatalogSyncState,
} from "@okouai/db/schema/connector-catalog";
import type { ConnectorCatalogCompatibilityEvaluationPayload } from "@okouai/db/jsonb-contracts/connector-catalog";
import { and, asc, eq } from "drizzle-orm";

import { mockOptionalEnv } from "../lib/env";
import { writeDb$, type Db } from "../signals/external/db";
import { nowDate } from "../lib/time";
import {
  connectorCatalogArtifactSchema,
  SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
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
import {
  clearConnectorCatalogExternalReaderIdentityReadHookForTest,
  setConnectorCatalogExternalReaderIdentityReadHookForTest,
} from "../signals/services/connector-catalog-external-reader.service";
import {
  CONNECTOR_CATALOG_RUNTIME_PROJECTION_VERSION,
  clearConnectorCatalogRuntimeProjectionIdentityReadHookForTest,
  persistConnectorCatalogRuntimeProjection,
  setConnectorCatalogRuntimeProjectionIdentityReadHookForTest,
} from "../signals/services/connector-catalog-runtime-projection.service";
import { connectorCatalogSource } from "../signals/services/connector-catalog-source";
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

export async function installApiTestConnectorCatalog(
  options: {
    readonly catalogVersion?: string;
    readonly runtimeProjection?: boolean;
    readonly sourceId?: string;
  } = {},
): Promise<void> {
  const catalogVersion =
    options.catalogVersion ?? DEFAULT_API_TEST_CONNECTOR_CATALOG_VERSION;
  const catalog =
    catalogVersion === DEFAULT_API_TEST_CONNECTOR_CATALOG_VERSION
      ? API_TEST_CONNECTOR_CATALOG
      : connectorCatalogArtifactSchema.parse({
          ...API_TEST_CONNECTOR_CATALOG_ARTIFACT,
          catalogVersion,
        });
  validateConnectorCatalogArtifact(catalog);
  const rawBytes = Buffer.from(`${JSON.stringify(catalog)}\n`);
  const catalogDigest = sha256Digest(rawBytes);
  const catalogGzip = encodeConnectorCatalogSnapshot(rawBytes);
  const sourceId = options.sourceId ?? connectorCatalogSource().sourceId;
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
    await tx
      .insert(connectorCatalogSyncState)
      .values({
        sourceId,
        schemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
        ...syncStateValues,
      })
      .onConflictDoUpdate({
        target: [
          connectorCatalogSyncState.sourceId,
          connectorCatalogSyncState.schemaVersion,
        ],
        set: syncStateValues,
      });
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
    if (options.runtimeProjection === true) {
      await persistConnectorCatalogRuntimeProjection({
        db: tx,
        sourceId,
        identity: { catalogVersion, catalogDigest },
        artifact: catalog,
        validator: currentConnectorCatalogValidatorIdentity(),
      });
    }
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

export function setApiTestConnectorCatalogRuntimeProjectionIdentityReadHook(
  hook: () => Promise<void>,
): void {
  setConnectorCatalogRuntimeProjectionIdentityReadHookForTest(hook);
}

export function clearApiTestConnectorCatalogRuntimeProjectionIdentityReplacements(): void {
  clearConnectorCatalogRuntimeProjectionIdentityReadHookForTest();
}

export function setApiTestConnectorCatalogExternalReaderIdentityReadHook(
  hook: () => Promise<void>,
): void {
  setConnectorCatalogExternalReaderIdentityReadHookForTest(hook);
}

export function setApiTestConnectorCatalogExternalReaderIdentityReplacements(
  catalogVersions: readonly [first: string, second: string],
): void {
  const [firstCatalogVersion, secondCatalogVersion] = catalogVersions;
  let nextCatalogVersion = firstCatalogVersion;
  setConnectorCatalogExternalReaderIdentityReadHookForTest(async () => {
    const catalogVersion = nextCatalogVersion;
    nextCatalogVersion = secondCatalogVersion;
    await installApiTestConnectorCatalog({ catalogVersion });
  });
}

export function clearApiTestConnectorCatalogExternalReaderIdentityReplacements(): void {
  clearConnectorCatalogExternalReaderIdentityReadHookForTest();
}

interface ApiTestConnectorCatalogIdentity {
  readonly sourceId: string;
  readonly catalogVersion: string;
  readonly catalogDigest: string;
  readonly capabilityDigest: string;
}

function currentApiTestConnectorCatalogRuntimeProjectionSetWhere(
  identity: ApiTestConnectorCatalogIdentity,
) {
  return and(
    eq(connectorCatalogRuntimeProjectionSets.sourceId, identity.sourceId),
    eq(
      connectorCatalogRuntimeProjectionSets.schemaVersion,
      SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
    ),
    eq(
      connectorCatalogRuntimeProjectionSets.catalogVersion,
      identity.catalogVersion,
    ),
    eq(
      connectorCatalogRuntimeProjectionSets.catalogDigest,
      identity.catalogDigest,
    ),
    eq(
      connectorCatalogRuntimeProjectionSets.projectionVersion,
      CONNECTOR_CATALOG_RUNTIME_PROJECTION_VERSION,
    ),
  );
}

async function currentApiTestConnectorCatalogRuntimeProjectionSet(
  db: Db,
  identity: ApiTestConnectorCatalogIdentity,
): Promise<
  { readonly id: string; readonly connectorCount: number } | undefined
> {
  const [projectionSet] = await db
    .select({
      id: connectorCatalogRuntimeProjectionSets.id,
      connectorCount: connectorCatalogRuntimeProjectionSets.connectorCount,
    })
    .from(connectorCatalogRuntimeProjectionSets)
    .where(currentApiTestConnectorCatalogRuntimeProjectionSetWhere(identity))
    .limit(1);
  return projectionSet;
}

async function requireCurrentApiTestConnectorCatalogRuntimeProjectionSet(
  db: Db,
  identity: ApiTestConnectorCatalogIdentity,
): Promise<{ readonly id: string; readonly connectorCount: number }> {
  const projectionSet =
    await currentApiTestConnectorCatalogRuntimeProjectionSet(db, identity);
  if (projectionSet === undefined) {
    throw new Error("API test connector runtime projection set is unavailable");
  }
  return projectionSet;
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

export async function replaceApiTestConnectorCatalogStoredBytes(args: {
  readonly catalogVersion: string;
  readonly rawBytes: Uint8Array;
  readonly catalogValidationAuthority: ConnectorCatalogValidationAuthority | null;
  readonly retainCatalogDigest?: boolean;
}): Promise<void> {
  const identity = await currentApiTestConnectorCatalogIdentity();
  const rawBytes = Buffer.from(args.rawBytes);
  const catalogDigest =
    args.retainCatalogDigest === true
      ? identity.catalogDigest
      : sha256Digest(rawBytes);
  const db = store.set(writeDb$);
  await db.transaction(async (tx) => {
    const updatedCompatibility = await tx
      .update(connectorCatalogCompatibilityEvaluation)
      .set({
        catalogVersion: args.catalogVersion,
        catalogDigest,
        catalogValidationBackendVersion:
          args.catalogValidationAuthority?.validatorVersion ?? null,
        catalogValidationBuildCommitSha:
          args.catalogValidationAuthority?.buildCommitSha ?? null,
      })
      .where(currentApiTestConnectorCatalogCompatibilityWhere(identity))
      .returning({
        sourceId: connectorCatalogCompatibilityEvaluation.sourceId,
      });
    requireSingleCatalogMutation(
      updatedCompatibility,
      "stored compatibility replacement",
    );
    const updatedSnapshot = await tx
      .update(connectorCatalogActiveSnapshot)
      .set({
        catalogVersion: args.catalogVersion,
        catalogDigest,
        catalogRawSize: rawBytes.byteLength,
        catalogGzip: encodeConnectorCatalogSnapshot(rawBytes),
      })
      .where(
        and(
          eq(connectorCatalogActiveSnapshot.sourceId, identity.sourceId),
          eq(
            connectorCatalogActiveSnapshot.schemaVersion,
            SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
          ),
        ),
      )
      .returning({ sourceId: connectorCatalogActiveSnapshot.sourceId });
    requireSingleCatalogMutation(
      updatedSnapshot,
      "stored catalog snapshot replacement",
    );
  });
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

export async function deleteApiTestConnectorCatalogCompatibility(): Promise<void> {
  const identity = await currentApiTestConnectorCatalogIdentity();
  const db = store.set(writeDb$);
  const deleted = await db
    .delete(connectorCatalogCompatibilityEvaluation)
    .where(currentApiTestConnectorCatalogCompatibilityWhere(identity))
    .returning({ sourceId: connectorCatalogCompatibilityEvaluation.sourceId });
  requireSingleCatalogMutation(deleted, "compatibility deletion");
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

export async function deleteApiTestConnectorCatalogRuntimeProjectionRow(
  connectorSlug: string,
): Promise<void> {
  const identity = await currentApiTestConnectorCatalogIdentity();
  const db = store.set(writeDb$);
  const projectionSet =
    await requireCurrentApiTestConnectorCatalogRuntimeProjectionSet(
      db,
      identity,
    );
  const deleted = await db
    .delete(connectorCatalogRuntimeProjections)
    .where(
      and(
        eq(
          connectorCatalogRuntimeProjections.projectionSetId,
          projectionSet.id,
        ),
        eq(connectorCatalogRuntimeProjections.connectorSlug, connectorSlug),
      ),
    )
    .returning({
      connectorSlug: connectorCatalogRuntimeProjections.connectorSlug,
    });
  requireSingleCatalogMutation(deleted, "runtime projection row deletion");
}

export async function corruptApiTestConnectorCatalogRuntimeProjectionDigest(
  connectorSlug: string,
): Promise<void> {
  const identity = await currentApiTestConnectorCatalogIdentity();
  const db = store.set(writeDb$);
  const projectionSet =
    await requireCurrentApiTestConnectorCatalogRuntimeProjectionSet(
      db,
      identity,
    );
  const updated = await db
    .update(connectorCatalogRuntimeProjections)
    .set({ connectorDigest: `sha256:${"0".repeat(64)}` })
    .where(
      and(
        eq(
          connectorCatalogRuntimeProjections.projectionSetId,
          projectionSet.id,
        ),
        eq(connectorCatalogRuntimeProjections.connectorSlug, connectorSlug),
      ),
    )
    .returning({
      connectorSlug: connectorCatalogRuntimeProjections.connectorSlug,
    });
  requireSingleCatalogMutation(updated, "runtime projection digest corruption");
}

export async function corruptApiTestConnectorCatalogRuntimeProjectionPayload(
  connectorSlug: string,
  connectorPayload: Buffer = Buffer.from("{}", "utf8"),
): Promise<void> {
  const identity = await currentApiTestConnectorCatalogIdentity();
  const db = store.set(writeDb$);
  const projectionSet =
    await requireCurrentApiTestConnectorCatalogRuntimeProjectionSet(
      db,
      identity,
    );
  const updated = await db
    .update(connectorCatalogRuntimeProjections)
    .set({
      connectorDigest: sha256Digest(connectorPayload),
      connectorPayload,
    })
    .where(
      and(
        eq(
          connectorCatalogRuntimeProjections.projectionSetId,
          projectionSet.id,
        ),
        eq(connectorCatalogRuntimeProjections.connectorSlug, connectorSlug),
      ),
    )
    .returning({
      connectorSlug: connectorCatalogRuntimeProjections.connectorSlug,
    });
  requireSingleCatalogMutation(
    updated,
    "runtime projection payload corruption",
  );
}

export async function expireApiTestConnectorCatalogRuntimeProjectionAuthority(): Promise<void> {
  await setApiTestConnectorCatalogRuntimeProjectionAuthority({
    validatorVersion: "1.0.0",
    buildCommitSha: null,
  });
}

export async function setApiTestConnectorCatalogRuntimeProjectionAuthority(
  authority: ConnectorCatalogValidationAuthority,
): Promise<void> {
  const identity = await currentApiTestConnectorCatalogIdentity();
  const db = store.set(writeDb$);
  const projectionSet =
    await requireCurrentApiTestConnectorCatalogRuntimeProjectionSet(
      db,
      identity,
    );
  const updated = await db
    .update(connectorCatalogRuntimeProjectionSets)
    .set({
      catalogValidationBackendVersion: authority.validatorVersion,
      catalogValidationBuildCommitSha: authority.buildCommitSha,
    })
    .where(eq(connectorCatalogRuntimeProjectionSets.id, projectionSet.id))
    .returning({ id: connectorCatalogRuntimeProjectionSets.id });
  requireSingleCatalogMutation(updated, "runtime projection authority expiry");
}

export async function readApiTestConnectorCatalogRuntimeProjectionAuthority(): Promise<ConnectorCatalogValidationAuthority | null> {
  const identity = await currentApiTestConnectorCatalogIdentity();
  const db = store.set(writeDb$);
  const [projectionSet] = await db
    .select({
      validatorVersion:
        connectorCatalogRuntimeProjectionSets.catalogValidationBackendVersion,
      buildCommitSha:
        connectorCatalogRuntimeProjectionSets.catalogValidationBuildCommitSha,
    })
    .from(connectorCatalogRuntimeProjectionSets)
    .where(currentApiTestConnectorCatalogRuntimeProjectionSetWhere(identity))
    .limit(1);
  if (projectionSet === undefined || projectionSet.validatorVersion === null) {
    return null;
  }
  return {
    validatorVersion: projectionSet.validatorVersion,
    buildCommitSha: projectionSet.buildCommitSha,
  };
}

export async function readApiTestConnectorCatalogRuntimeProjection(): Promise<{
  readonly connectorCount: number;
  readonly connectorSlugs: readonly string[];
} | null> {
  const identity = await currentApiTestConnectorCatalogIdentity();
  const db = store.set(writeDb$);
  const setRow = await currentApiTestConnectorCatalogRuntimeProjectionSet(
    db,
    identity,
  );
  if (setRow === undefined) {
    return null;
  }
  const rows = await db
    .select({ connectorSlug: connectorCatalogRuntimeProjections.connectorSlug })
    .from(connectorCatalogRuntimeProjections)
    .where(eq(connectorCatalogRuntimeProjections.projectionSetId, setRow.id))
    .orderBy(asc(connectorCatalogRuntimeProjections.connectorSlug));
  return {
    connectorCount: setRow.connectorCount,
    connectorSlugs: rows.map((row) => {
      return row.connectorSlug;
    }),
  };
}

export async function deleteApiTestConnectorCatalogRuntimeProjectionSet(): Promise<void> {
  const identity = await currentApiTestConnectorCatalogIdentity();
  const db = store.set(writeDb$);
  const deleted = await db
    .delete(connectorCatalogRuntimeProjectionSets)
    .where(currentApiTestConnectorCatalogRuntimeProjectionSetWhere(identity))
    .returning({ sourceId: connectorCatalogRuntimeProjectionSets.sourceId });
  requireSingleCatalogMutation(deleted, "runtime projection set deletion");
}
