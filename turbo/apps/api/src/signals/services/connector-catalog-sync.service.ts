import { isDeepStrictEqual } from "node:util";

import type {
  ConnectorCatalogSyncFailureCode,
  ConnectorCatalogDiagnostics,
} from "@okouai/api-contracts/contracts/connector-catalog-diagnostics";
import type { ConnectorCatalogSyncResponse } from "@okouai/api-contracts/contracts/cron";
import {
  connectorCatalogActiveSnapshot,
  connectorCatalogSyncState,
} from "@okouai/db/schema/connector-catalog";
import { orgCustomConnectorOauthConfigs } from "@okouai/db/schema/org-custom-connector-oauth-config";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { connectors } from "@okouai/db/schema/connector";
import { command } from "ccstate";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { pgTextDecoder } from "../../lib/db-structured-result";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { db$, writeDb$, type Db, type ReadonlyDb } from "../external/db";
import {
  downloadS3BufferWithMaxBytes,
  downloadS3BufferWithMaxBytesIfChanged,
  S3ObjectSizeLimitError,
  type ConditionalS3BufferDownload,
} from "../external/s3";
import { safeSync, settle } from "../utils";
import {
  CONNECTOR_CATALOG_ACTIVE_KEY,
  SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
  type ConnectorCatalogArtifact,
  type ConnectorCatalogArtifactConnector,
} from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import {
  CONNECTOR_CATALOG_ACTIVE_MAX_BYTES,
  connectorCatalogArtifactFailureCode,
  connectorCatalogArtifactRelationshipRule,
  encodeConnectorCatalogSnapshot,
  loadConnectorCatalogCandidate,
  parseConnectorCatalogActivePointer,
  type ConnectorCatalogActivePointer,
  type ConnectorCatalogArtifactReader,
  type ValidatedConnectorCatalogCandidate,
} from "@okouai/connectors/connector-catalog/artifacts/loader";
import type { ConnectorCatalogRelationshipRule } from "@okouai/connectors/connector-catalog/artifacts/relationship-error";
import {
  connectorCatalogExecutableCapabilityState,
  persistConnectorCatalogCompatibility,
  type ExecutableCapabilityState,
} from "./connector-catalog-compatibility.service";
import {
  connectorCatalogRejectionIsReusable,
  currentConnectorCatalogRejectionIdentity,
  currentConnectorCatalogValidatorIdentity,
  type ConnectorCatalogRejectionAuthority,
  type ConnectorCatalogRejectionValidatorIdentity,
  type ConnectorCatalogValidatorIdentity,
} from "./connector-catalog-validator-authority";
import {
  connectorCatalogSkillFailure,
  prepareConnectorCatalogSkills,
  registerPreparedConnectorCatalogSkills,
  type ConnectorCatalogSkillFailure,
  type PreparedConnectorSkillRegistration,
} from "./connector-catalog-skill-registration.service";
import {
  connectorCatalogSource,
  connectorCatalogSourceIsTestScoped,
  type ConnectorCatalogSource,
} from "./connector-catalog-source";
import {
  loadConnectorRuntimeSnapshot,
  type ConnectorRuntimeSnapshot,
} from "./connector-catalog-runtime.service";
import { ExternalConnectorCatalogUnavailableError } from "./connector-catalog-external-reader.service";
import { persistConnectorCatalogRuntimeProjection } from "./connector-catalog-runtime-projection.service";
import {
  invalidateAllPiStableContexts,
  invalidatePiStableContextsForCatalogSource,
} from "./pi-stable-context-generation.service";
import { loadCustomConnectorPermissionBundle } from "./custom-connector-permission-bundle.service";
import { publishConnectorRuntimeSyncWakeups } from "./connector-runtime-wakeup.service";
import { effectiveCustomConnectorPermissionBundleRef } from "./feishu-custom-connector-permissions";
import { createAcceptedConnectorServerFirewallCatalog } from "./connector-server-firewall-catalog.service";

const log = logger("connector-catalog:sync");

type ConnectorCatalogRawSyncStatus = Omit<
  ConnectorCatalogDiagnostics,
  "filtering" | "credentialStorage"
>;
type ConnectorCatalogRawSyncResponse = Omit<
  ConnectorCatalogSyncResponse,
  "filtering" | "credentialStorage"
>;

interface SyncStateSnapshot {
  readonly revision: number;
  readonly lastObservedCatalogVersion: string | null;
  readonly lastObservedCatalogKey: string | null;
  readonly lastObservedCatalogDigest: string | null;
  readonly lastObservedPointerEtag: string | null;
  readonly lastAttemptAt: Date | null;
  readonly lastAttemptOutcome: "accepted" | "unchanged" | "rejected" | null;
  readonly lastAttemptReusedCachedRejection: boolean | null;
  readonly lastSuccessAt: Date | null;
  readonly lastFailureCode: ConnectorCatalogSyncFailureCode | null;
  readonly lastRejectedCatalogVersion: string | null;
  readonly lastRejectedCatalogKey: string | null;
  readonly lastRejectedCatalogDigest: string | null;
  readonly lastRejectedPointerEtag: string | null;
  readonly lastRejectedFailureCode: ConnectorCatalogSyncFailureCode | null;
  readonly lastRejectedBackendVersion: string | null;
  readonly lastRejectedBuildCommitSha: string | null;
  readonly activeCatalogVersion: string | null;
  readonly activeCatalogKey: string | null;
  readonly activeCatalogDigest: string | null;
  readonly activatedAt: Date | null;
}

interface PointerObservation {
  readonly pointer: ConnectorCatalogActivePointer | null;
  readonly etag: string | null;
}

interface RejectedCandidate {
  readonly pointer: ConnectorCatalogActivePointer | null;
  readonly pointerEtag: string | null;
  readonly failureCode: ConnectorCatalogSyncFailureCode;
}

type CandidateCommitResult =
  | "accepted"
  | "retry"
  | {
      readonly kind: "rejected";
      readonly failure: ConnectorCatalogSkillFailure;
    };

class CandidateCommitRetry extends Error {}

class ConnectorCatalogPersistenceError extends Error {
  constructor() {
    super("Connector catalog snapshot persistence failed");
    this.name = "ConnectorCatalogPersistenceError";
  }
}

function customConnectorPermissionBundleFingerprint(
  bundle: Awaited<ReturnType<typeof loadCustomConnectorPermissionBundle>>,
): string | null {
  if (!bundle) {
    return null;
  }
  return JSON.stringify({
    connectorSlug: bundle.connectorSlug,
    permissions: bundle.permissions,
    defaultPolicies: Object.entries(bundle.defaultPolicies).sort(
      ([left], [right]) => {
        return left.localeCompare(right);
      },
    ),
  });
}

async function publishCatalogPermissionBundleWakeupsInner(args: {
  readonly db: Db;
  readonly previousSnapshot: ConnectorRuntimeSnapshot | undefined;
  readonly currentArtifact: ConnectorCatalogArtifact;
}): Promise<void> {
  const currentCatalog = createAcceptedConnectorServerFirewallCatalog({
    artifact: args.currentArtifact,
    runtimeMethodsForSlug: () => {
      return [];
    },
  });
  const rows = await args.db
    .select({
      id: orgCustomConnectors.id,
      orgId: orgCustomConnectors.orgId,
      slug: orgCustomConnectors.slug,
      authMode: orgCustomConnectors.authMode,
      prefixTemplates: orgCustomConnectors.prefixTemplates,
      permissionBundleRef: orgCustomConnectors.permissionBundleRef,
      oauthProviderAdapter: orgCustomConnectorOauthConfigs.providerAdapter,
    })
    .from(orgCustomConnectors)
    .leftJoin(
      orgCustomConnectorOauthConfigs,
      and(
        eq(orgCustomConnectorOauthConfigs.connectorId, orgCustomConnectors.id),
        eq(orgCustomConnectorOauthConfigs.orgId, orgCustomConnectors.orgId),
      ),
    )
    .where(eq(orgCustomConnectors.enabled, true));

  const connectorIdsByRef = new Map<
    string,
    { readonly orgId: string; readonly connectorId: string }[]
  >();
  for (const row of rows) {
    const ref = effectiveCustomConnectorPermissionBundleRef({
      slug: row.slug,
      authMode: row.authMode,
      oauthProviderAdapter: row.oauthProviderAdapter,
      prefixTemplates: row.prefixTemplates,
      permissionBundleRef: row.permissionBundleRef,
    });
    if (!ref) {
      continue;
    }
    const connectors = connectorIdsByRef.get(ref) ?? [];
    connectors.push({ orgId: row.orgId, connectorId: row.id });
    connectorIdsByRef.set(ref, connectors);
  }

  const affectedByOrg = new Map<string, string[]>();
  for (const [ref, connectors] of connectorIdsByRef) {
    const [previousBundle, currentBundle] = await Promise.all([
      args.previousSnapshot
        ? loadCustomConnectorPermissionBundle({
            catalog: args.previousSnapshot.serverFirewallMetadata,
            ref,
          })
        : null,
      loadCustomConnectorPermissionBundle({
        catalog: currentCatalog,
        ref,
      }),
    ]);
    if (
      customConnectorPermissionBundleFingerprint(previousBundle) ===
      customConnectorPermissionBundleFingerprint(currentBundle)
    ) {
      continue;
    }
    for (const connector of connectors) {
      const connectorIds = affectedByOrg.get(connector.orgId) ?? [];
      connectorIds.push(connector.connectorId);
      affectedByOrg.set(connector.orgId, connectorIds);
    }
  }

  await Promise.all(
    [...affectedByOrg].map(async ([orgId, customConnectorIds]) => {
      await publishConnectorRuntimeSyncWakeups({
        db: args.db,
        scope: { orgId },
        targets: customConnectorIds.map((customConnectorId) => {
          return { kind: "custom" as const, customConnectorId };
        }),
      });
    }),
  );
  log.debug("Evaluated Custom connector catalog wakeups", {
    permissionBundleRefCount: connectorIdsByRef.size,
    affectedOrgCount: affectedByOrg.size,
    affectedCustomConnectorCount: [...affectedByOrg.values()].reduce(
      (count, connectorIds) => {
        return count + connectorIds.length;
      },
      0,
    ),
  });
}

function mcpRuntimeConfig(
  connector: ConnectorCatalogArtifactConnector | undefined,
) {
  return connector
    ? {
        mcp: connector.mcp,
        authMethods: connector.authMethods,
        firewall: connector.firewall,
      }
    : undefined;
}

async function publishMcpCatalogWakeups(args: {
  readonly db: Db;
  readonly previousSnapshot: ConnectorRuntimeSnapshot | undefined;
  readonly currentArtifact: ConnectorCatalogArtifact;
}): Promise<void> {
  const previous = new Map(
    args.previousSnapshot?.acceptedSnapshot.artifact.connectors.map(
      (connector) => {
        return [connector.slug, connector] as const;
      },
    ),
  );
  const current = new Map(
    args.currentArtifact.connectors.map((connector) => {
      return [connector.slug, connector] as const;
    }),
  );
  const changedSlugs = [
    ...new Set([...previous.keys(), ...current.keys()]),
  ].filter((slug) => {
    const before = previous.get(slug);
    const after = current.get(slug);
    return (
      (before?.mcp !== undefined || after?.mcp !== undefined) &&
      !isDeepStrictEqual(mcpRuntimeConfig(before), mcpRuntimeConfig(after))
    );
  });
  if (changedSlugs.length === 0) {
    return;
  }
  const accounts = await args.db
    .selectDistinct({
      orgId: connectors.orgId,
      connectorSlug: sql`${connectors.connectorSlug}`
        .mapWith(pgTextDecoder)
        .as("connector_slug"),
    })
    .from(connectors)
    .where(
      and(
        isNull(connectors.customConnectorId),
        inArray(connectors.connectorSlug, changedSlugs),
      ),
    );
  const byOrg = new Map<string, string[]>();
  for (const account of accounts) {
    const slugs = byOrg.get(account.orgId) ?? [];
    slugs.push(account.connectorSlug);
    byOrg.set(account.orgId, slugs);
  }
  const pending = byOrg.entries();
  async function publishOrgWakeups() {
    for (const [orgId, slugs] of pending) {
      await publishConnectorRuntimeSyncWakeups({
        db: args.db,
        scope: { orgId },
        targets: slugs.map((connectorSlug) => {
          return { kind: "builtin" as const, connectorSlug };
        }),
      });
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(4, byOrg.size) }, publishOrgWakeups),
  );
}

async function publishCatalogRuntimeWakeups(args: {
  readonly db: Db;
  readonly previousSnapshot: ConnectorRuntimeSnapshot | undefined;
  readonly currentArtifact: ConnectorCatalogArtifact;
}): Promise<void> {
  const results = await Promise.all([
    settle(publishCatalogPermissionBundleWakeupsInner(args)),
    settle(publishMcpCatalogWakeups(args)),
  ]);
  for (const result of results) {
    if (!result.ok) {
      log.warn("Failed to publish connector catalog runtime wakeups", {
        error: result.error,
      });
    }
  }
}

async function readSyncState(
  db: ReadonlyDb,
  sourceId: string,
): Promise<SyncStateSnapshot | undefined> {
  const [state] = await db
    .select({
      revision: connectorCatalogSyncState.revision,
      lastObservedCatalogVersion:
        connectorCatalogSyncState.lastObservedCatalogVersion,
      lastObservedCatalogKey: connectorCatalogSyncState.lastObservedCatalogKey,
      lastObservedCatalogDigest:
        connectorCatalogSyncState.lastObservedCatalogDigest,
      lastObservedPointerEtag:
        connectorCatalogSyncState.lastObservedPointerEtag,
      lastAttemptAt: connectorCatalogSyncState.lastAttemptAt,
      lastAttemptOutcome: connectorCatalogSyncState.lastAttemptOutcome,
      lastAttemptReusedCachedRejection:
        connectorCatalogSyncState.lastAttemptReusedCachedRejection,
      lastSuccessAt: connectorCatalogSyncState.lastSuccessAt,
      lastFailureCode: connectorCatalogSyncState.lastFailureCode,
      lastRejectedCatalogVersion:
        connectorCatalogSyncState.lastRejectedCatalogVersion,
      lastRejectedCatalogKey: connectorCatalogSyncState.lastRejectedCatalogKey,
      lastRejectedCatalogDigest:
        connectorCatalogSyncState.lastRejectedCatalogDigest,
      lastRejectedPointerEtag:
        connectorCatalogSyncState.lastRejectedPointerEtag,
      lastRejectedFailureCode:
        connectorCatalogSyncState.lastRejectedFailureCode,
      lastRejectedBackendVersion:
        connectorCatalogSyncState.lastRejectedBackendVersion,
      lastRejectedBuildCommitSha:
        connectorCatalogSyncState.lastRejectedBuildCommitSha,
      activeCatalogVersion: connectorCatalogActiveSnapshot.catalogVersion,
      activeCatalogKey: connectorCatalogActiveSnapshot.catalogKey,
      activeCatalogDigest: connectorCatalogActiveSnapshot.catalogDigest,
      activatedAt: connectorCatalogActiveSnapshot.activatedAt,
    })
    .from(connectorCatalogSyncState)
    .leftJoin(
      connectorCatalogActiveSnapshot,
      and(
        eq(
          connectorCatalogActiveSnapshot.sourceId,
          connectorCatalogSyncState.sourceId,
        ),
        eq(
          connectorCatalogActiveSnapshot.schemaVersion,
          connectorCatalogSyncState.schemaVersion,
        ),
      ),
    )
    .where(
      and(
        eq(connectorCatalogSyncState.sourceId, sourceId),
        eq(
          connectorCatalogSyncState.schemaVersion,
          SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
        ),
      ),
    )
    .limit(1);
  return state;
}

function rejectedCandidateFromState(
  state: SyncStateSnapshot | undefined,
): RejectedCandidate | undefined {
  if (!state?.lastRejectedFailureCode) {
    return undefined;
  }

  const hasPointerIdentity =
    state.lastRejectedCatalogVersion !== null &&
    state.lastRejectedCatalogKey !== null &&
    state.lastRejectedCatalogDigest !== null;
  return {
    pointer: hasPointerIdentity
      ? {
          catalogVersion: state.lastRejectedCatalogVersion,
          catalogKey: state.lastRejectedCatalogKey,
          catalogDigest: state.lastRejectedCatalogDigest,
        }
      : null,
    pointerEtag: state.lastRejectedPointerEtag,
    failureCode: state.lastRejectedFailureCode,
  };
}

function rejectionAuthorityFromState(
  state: SyncStateSnapshot,
): ConnectorCatalogRejectionAuthority {
  if (state.lastRejectedBackendVersion === null) {
    throw new Error("Connector catalog rejection authority is incomplete");
  }
  return {
    backendVersion: state.lastRejectedBackendVersion,
    buildCommitSha: state.lastRejectedBuildCommitSha,
  };
}

function activeStatusFromState(
  state: SyncStateSnapshot | undefined,
): ConnectorCatalogRawSyncStatus["active"] {
  if (!state?.activeCatalogVersion) {
    return null;
  }
  if (
    !state.activatedAt ||
    !state.activeCatalogKey ||
    !state.activeCatalogDigest
  ) {
    throw new Error("Connector catalog active snapshot is incomplete");
  }
  return {
    catalogVersion: state.activeCatalogVersion,
    catalogDigest: state.activeCatalogDigest,
    activatedAt: state.activatedAt.toISOString(),
  };
}

function lastAttemptStatusFromState(
  state: SyncStateSnapshot | undefined,
): ConnectorCatalogRawSyncStatus["lastAttempt"] {
  if (!state?.lastAttemptAt && !state?.lastAttemptOutcome) {
    return null;
  }
  if (!state?.lastAttemptAt || !state.lastAttemptOutcome) {
    throw new Error("Connector catalog attempt state is incomplete");
  }
  if (state.lastAttemptReusedCachedRejection === null) {
    throw new Error("Connector catalog attempt cache provenance is incomplete");
  }
  return {
    at: state.lastAttemptAt.toISOString(),
    outcome: state.lastAttemptOutcome,
    failureCode: state.lastFailureCode,
    reusedCachedRejection: state.lastAttemptReusedCachedRejection,
  };
}

function rejectedCandidateStatusFromState(
  state: SyncStateSnapshot | undefined,
): ConnectorCatalogRawSyncStatus["rejectedCandidate"] {
  if (!state || state.lastAttemptOutcome !== "rejected") {
    return null;
  }
  const candidate = rejectedCandidateFromState(state);
  if (!candidate) {
    return null;
  }
  const authority = rejectionAuthorityFromState(state);
  return {
    catalogVersion: candidate.pointer?.catalogVersion ?? null,
    catalogDigest: candidate.pointer?.catalogDigest ?? null,
    failureCode: candidate.failureCode,
    backendVersion: authority.backendVersion,
  };
}

function statusFromState(
  state: SyncStateSnapshot | undefined,
): ConnectorCatalogRawSyncStatus {
  const active = activeStatusFromState(state);
  return {
    schemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
    state:
      active === null
        ? "never-synced"
        : state?.lastAttemptOutcome === "rejected"
          ? "stale"
          : "current",
    active,
    lastAttempt: lastAttemptStatusFromState(state),
    lastSuccessAt: state?.lastSuccessAt?.toISOString() ?? null,
    rejectedCandidate: rejectedCandidateStatusFromState(state),
  };
}

function pointerMatchesActiveState(
  pointer: ConnectorCatalogActivePointer,
  state: SyncStateSnapshot | undefined,
): boolean {
  return (
    pointer.catalogVersion === state?.activeCatalogVersion &&
    pointer.catalogKey === state.activeCatalogKey &&
    pointer.catalogDigest === state.activeCatalogDigest
  );
}

function observedPointerFromState(
  state: SyncStateSnapshot | undefined,
): ConnectorCatalogActivePointer | undefined {
  if (
    !state?.lastObservedCatalogVersion ||
    !state.lastObservedCatalogKey ||
    !state.lastObservedCatalogDigest
  ) {
    return undefined;
  }
  return {
    catalogVersion: state.lastObservedCatalogVersion,
    catalogKey: state.lastObservedCatalogKey,
    catalogDigest: state.lastObservedCatalogDigest,
  };
}

function cachedRejectionForPointer(
  observation: PointerObservation & {
    readonly pointer: ConnectorCatalogActivePointer;
  },
  state: SyncStateSnapshot | undefined,
  validator: ConnectorCatalogRejectionValidatorIdentity,
): ConnectorCatalogSyncFailureCode | undefined {
  const rejectedCandidate = rejectedCandidateFromState(state);
  if (!state || !rejectedCandidate?.pointer) {
    return undefined;
  }
  if (
    observation.pointer.catalogVersion !==
      rejectedCandidate.pointer.catalogVersion ||
    observation.pointer.catalogKey !== rejectedCandidate.pointer.catalogKey ||
    observation.pointer.catalogDigest !==
      rejectedCandidate.pointer.catalogDigest ||
    observation.etag !== rejectedCandidate.pointerEtag ||
    !connectorCatalogRejectionIsReusable({
      authority: rejectionAuthorityFromState(state),
      validator,
    })
  ) {
    return undefined;
  }
  return rejectedCandidate.failureCode;
}

function cachedRejectionForObservedEtag(
  state: SyncStateSnapshot | undefined,
  validator: ConnectorCatalogRejectionValidatorIdentity,
): ConnectorCatalogSyncFailureCode | undefined {
  const rejectedCandidate = rejectedCandidateFromState(state);
  if (
    !state?.lastObservedPointerEtag ||
    !rejectedCandidate ||
    state.lastObservedPointerEtag !== rejectedCandidate.pointerEtag ||
    !connectorCatalogRejectionIsReusable({
      authority: rejectionAuthorityFromState(state),
      validator,
    })
  ) {
    return undefined;
  }
  return rejectedCandidate.failureCode;
}

function classifySyncFailure(error: unknown): ConnectorCatalogSyncFailureCode {
  const artifactFailureCode = connectorCatalogArtifactFailureCode(error);
  if (artifactFailureCode) {
    return artifactFailureCode;
  }
  if (error instanceof S3ObjectSizeLimitError) {
    return "object-too-large";
  }
  return "source-unavailable";
}

function cacheableRejectedCandidate(
  observation: PointerObservation | undefined,
  failureCode: ConnectorCatalogSyncFailureCode,
): RejectedCandidate | undefined {
  if (
    failureCode === "source-unavailable" ||
    (!observation?.pointer && !observation?.etag)
  ) {
    return undefined;
  }
  return {
    pointer: observation.pointer,
    pointerEtag: observation.etag,
    failureCode,
  };
}

function rejectedCandidateValues(
  candidate: RejectedCandidate | undefined,
  validator: ConnectorCatalogRejectionValidatorIdentity,
) {
  if (!candidate) {
    return {};
  }
  return {
    lastRejectedCatalogVersion: candidate.pointer?.catalogVersion ?? null,
    lastRejectedCatalogKey: candidate.pointer?.catalogKey ?? null,
    lastRejectedCatalogDigest: candidate.pointer?.catalogDigest ?? null,
    lastRejectedPointerEtag: candidate.pointerEtag,
    lastRejectedFailureCode: candidate.failureCode,
    lastRejectedBackendVersion: validator.backendVersion,
    lastRejectedBuildCommitSha: validator.buildCommitSha,
  };
}

function clearedRejectedCandidateValues() {
  return {
    lastRejectedCatalogVersion: null,
    lastRejectedCatalogKey: null,
    lastRejectedCatalogDigest: null,
    lastRejectedPointerEtag: null,
    lastRejectedFailureCode: null,
    lastRejectedBackendVersion: null,
    lastRejectedBuildCommitSha: null,
  };
}

function pointerObservationValues(observation: PointerObservation | undefined) {
  if (!observation) {
    return {};
  }
  return {
    lastObservedCatalogVersion: observation.pointer?.catalogVersion ?? null,
    lastObservedCatalogKey: observation.pointer?.catalogKey ?? null,
    lastObservedCatalogDigest: observation.pointer?.catalogDigest ?? null,
    lastObservedPointerEtag: observation.etag,
  };
}

async function recordRejectedAttempt(args: {
  readonly db: Db;
  readonly sourceId: string;
  readonly baseline: SyncStateSnapshot | undefined;
  readonly attemptedAt: Date;
  readonly failureCode: ConnectorCatalogSyncFailureCode;
  readonly rejectedCandidate?: RejectedCandidate;
  readonly pointerObservation?: PointerObservation;
  readonly reusedCachedRejection: boolean;
  readonly validator: ConnectorCatalogRejectionValidatorIdentity;
}): Promise<boolean> {
  const rejectedValues = rejectedCandidateValues(
    args.rejectedCandidate,
    args.validator,
  );
  const observationValues = pointerObservationValues(args.pointerObservation);
  const nextRevision = (args.baseline?.revision ?? 0) + 1;
  if (!args.baseline) {
    const inserted = await args.db
      .insert(connectorCatalogSyncState)
      .values({
        sourceId: args.sourceId,
        schemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
        revision: nextRevision,
        lastAttemptAt: args.attemptedAt,
        lastAttemptOutcome: "rejected",
        lastAttemptReusedCachedRejection: args.reusedCachedRejection,
        lastFailureCode: args.failureCode,
        ...observationValues,
        ...rejectedValues,
      })
      .onConflictDoNothing()
      .returning({ sourceId: connectorCatalogSyncState.sourceId });
    return inserted.length === 1;
  }

  const updated = await args.db
    .update(connectorCatalogSyncState)
    .set({
      revision: nextRevision,
      lastAttemptAt: args.attemptedAt,
      lastAttemptOutcome: "rejected",
      lastAttemptReusedCachedRejection: args.reusedCachedRejection,
      lastFailureCode: args.failureCode,
      ...observationValues,
      ...rejectedValues,
    })
    .where(
      and(
        eq(connectorCatalogSyncState.sourceId, args.sourceId),
        eq(
          connectorCatalogSyncState.schemaVersion,
          SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
        ),
        eq(connectorCatalogSyncState.revision, args.baseline.revision),
      ),
    )
    .returning({ sourceId: connectorCatalogSyncState.sourceId });
  return updated.length === 1;
}

async function recordUnchangedAttempt(args: {
  readonly db: Db;
  readonly sourceId: string;
  readonly baseline: SyncStateSnapshot;
  readonly attemptedAt: Date;
  readonly pointerObservation?: PointerObservation;
}): Promise<boolean> {
  const observationValues = pointerObservationValues(args.pointerObservation);
  const nextRevision = args.baseline.revision + 1;
  const updated = await args.db
    .update(connectorCatalogSyncState)
    .set({
      revision: nextRevision,
      lastAttemptAt: args.attemptedAt,
      lastAttemptOutcome: "unchanged",
      lastAttemptReusedCachedRejection: false,
      lastSuccessAt: args.attemptedAt,
      lastFailureCode: null,
      ...clearedRejectedCandidateValues(),
      ...observationValues,
    })
    .where(
      and(
        eq(connectorCatalogSyncState.sourceId, args.sourceId),
        eq(
          connectorCatalogSyncState.schemaVersion,
          SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
        ),
        eq(connectorCatalogSyncState.revision, args.baseline.revision),
      ),
    )
    .returning({ sourceId: connectorCatalogSyncState.sourceId });
  return updated.length === 1;
}

function activeSnapshotValues(
  candidate: ValidatedConnectorCatalogCandidate,
  catalogGzip: Buffer,
  activatedAt: Date,
) {
  return {
    catalogVersion: candidate.identity.catalogVersion,
    catalogKey: candidate.identity.catalogKey,
    catalogDigest: candidate.identity.catalogDigest,
    catalogRawSize: candidate.rawBytes.byteLength,
    catalogGzip,
    activatedAt,
  };
}

async function activateCandidate(args: {
  readonly db: Db;
  readonly sourceId: string;
  readonly baseline: SyncStateSnapshot | undefined;
  readonly candidate: ValidatedConnectorCatalogCandidate;
  readonly catalogGzip: Buffer;
  readonly pointerObservation: PointerObservation;
  readonly attemptedAt: Date;
}): Promise<void> {
  const nextRevision = (args.baseline?.revision ?? 0) + 1;
  const stateValues = {
    ...pointerObservationValues(args.pointerObservation),
    lastAttemptAt: args.attemptedAt,
    lastAttemptOutcome: "accepted" as const,
    lastAttemptReusedCachedRejection: false,
    lastSuccessAt: args.attemptedAt,
    lastFailureCode: null,
    ...clearedRejectedCandidateValues(),
  };
  if (!args.baseline) {
    const inserted = await args.db
      .insert(connectorCatalogSyncState)
      .values({
        sourceId: args.sourceId,
        schemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
        revision: nextRevision,
        ...stateValues,
      })
      .onConflictDoNothing()
      .returning({ sourceId: connectorCatalogSyncState.sourceId });
    if (inserted.length === 0) {
      throw new CandidateCommitRetry();
    }
  } else {
    const updated = await args.db
      .update(connectorCatalogSyncState)
      .set({
        revision: nextRevision,
        ...stateValues,
      })
      .where(
        and(
          eq(connectorCatalogSyncState.sourceId, args.sourceId),
          eq(
            connectorCatalogSyncState.schemaVersion,
            SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
          ),
          eq(connectorCatalogSyncState.revision, args.baseline.revision),
        ),
      )
      .returning({ sourceId: connectorCatalogSyncState.sourceId });
    if (updated.length === 0) {
      throw new CandidateCommitRetry();
    }
  }

  const snapshotValues = activeSnapshotValues(
    args.candidate,
    args.catalogGzip,
    args.attemptedAt,
  );
  await args.db
    .insert(connectorCatalogActiveSnapshot)
    .values({
      sourceId: args.sourceId,
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
}

async function commitCandidate(
  args: {
    readonly db: Db;
    readonly sourceId: string;
    readonly baseline: SyncStateSnapshot | undefined;
    readonly candidate: ValidatedConnectorCatalogCandidate;
    readonly catalogGzip: Buffer;
    readonly skillRegistrations: readonly PreparedConnectorSkillRegistration[];
    readonly pointerObservation: PointerObservation;
    readonly attemptedAt: Date;
    readonly capability: ExecutableCapabilityState;
    readonly validator: ConnectorCatalogValidatorIdentity;
  },
  signal: AbortSignal,
): Promise<CandidateCommitResult> {
  const result = await settle(
    args.db.transaction(async (tx) => {
      await registerPreparedConnectorCatalogSkills(
        {
          db: tx,
          registrations: args.skillRegistrations,
        },
        signal,
      );
      await activateCandidate({ ...args, db: tx });
      await persistConnectorCatalogCompatibility({
        db: tx,
        sourceId: args.sourceId,
        identity: args.candidate.identity,
        artifact: args.candidate.artifact,
        capability: args.capability,
        validator: args.validator,
      });
      await persistConnectorCatalogRuntimeProjection({
        db: tx,
        sourceId: args.sourceId,
        identity: args.candidate.identity,
        artifact: args.candidate.artifact,
        validator: args.validator,
      });
      if (connectorCatalogSourceIsTestScoped()) {
        await invalidatePiStableContextsForCatalogSource(tx, args.sourceId);
      } else {
        await invalidateAllPiStableContexts(tx);
      }
      return "accepted" as const;
    }),
  );
  if (result.ok) {
    return result.value;
  }
  if (result.error instanceof CandidateCommitRetry) {
    return "retry";
  }
  const skillFailure = connectorCatalogSkillFailure(result.error);
  if (skillFailure) {
    return { kind: "rejected", failure: skillFailure };
  }
  throw new ConnectorCatalogPersistenceError();
}

async function responseFromState(args: {
  readonly db: ReadonlyDb;
  readonly sourceId: string;
  readonly outcome: ConnectorCatalogRawSyncResponse["outcome"];
}): Promise<ConnectorCatalogRawSyncResponse> {
  const state = await readSyncState(args.db, args.sourceId);
  return {
    outcome: args.outcome,
    ...statusFromState(state),
  };
}

async function rejectCandidate(args: {
  readonly db: Db;
  readonly source: ConnectorCatalogSource;
  readonly baseline: SyncStateSnapshot | undefined;
  readonly failureCode: ConnectorCatalogSyncFailureCode;
  readonly relationshipRule?: ConnectorCatalogRelationshipRule;
  readonly rejectedCandidate?: RejectedCandidate;
  readonly pointerObservation?: PointerObservation;
  readonly reusedCachedRejection: boolean;
  readonly validator: ConnectorCatalogRejectionValidatorIdentity;
}): Promise<ConnectorCatalogRawSyncResponse | undefined> {
  const committed = await recordRejectedAttempt({
    db: args.db,
    sourceId: args.source.sourceId,
    baseline: args.baseline,
    attemptedAt: nowDate(),
    failureCode: args.failureCode,
    rejectedCandidate: args.rejectedCandidate,
    pointerObservation: args.pointerObservation,
    reusedCachedRejection: args.reusedCachedRejection,
    validator: args.validator,
  });
  if (!committed) {
    return undefined;
  }

  const retainedActiveSnapshot = Boolean(args.baseline?.activeCatalogVersion);
  const pointer = args.reusedCachedRejection
    ? rejectedCandidateFromState(args.baseline)?.pointer
    : args.pointerObservation?.pointer;
  const fields = {
    sourceId: args.source.sourceId,
    schemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
    failureCode: args.failureCode,
    retainedActiveSnapshot,
    reusedCachedRejection: args.reusedCachedRejection,
    ...(pointer
      ? {
          catalogVersion: pointer.catalogVersion,
          catalogDigest: pointer.catalogDigest,
        }
      : {}),
    ...(args.relationshipRule === undefined
      ? {}
      : { relationshipRule: args.relationshipRule }),
  };
  if (args.reusedCachedRejection && retainedActiveSnapshot) {
    log.debug("Connector catalog candidate rejected", fields);
  } else {
    log.warn("Connector catalog candidate rejected", fields);
  }
  return await responseFromState({
    db: args.db,
    sourceId: args.source.sourceId,
    outcome: "rejected",
  });
}

interface ConnectorCatalogSyncRuntime {
  readonly capability: ExecutableCapabilityState;
  readonly db: Db;
  readonly reader: ConnectorCatalogArtifactReader;
  readonly readActivePointer: (
    ifNoneMatch: string | null,
  ) => Promise<ConditionalS3BufferDownload>;
  readonly source: ConnectorCatalogSource;
  readonly rejectionValidator: ConnectorCatalogRejectionValidatorIdentity;
  readonly validator: ConnectorCatalogValidatorIdentity;
}

type SyncAttemptResult =
  | { readonly kind: "retry" }
  | {
      readonly kind: "complete";
      readonly response: ConnectorCatalogRawSyncResponse;
    };

type CandidateLoadResult =
  | SyncAttemptResult
  | {
      readonly kind: "loaded";
      readonly candidate: ValidatedConnectorCatalogCandidate;
    };

type PointerLoadResult =
  | SyncAttemptResult
  | { readonly kind: "not-modified" }
  | {
      readonly kind: "loaded";
      readonly pointer: ConnectorCatalogActivePointer;
      readonly etag: string | null;
    };

interface RejectSyncAttemptOptions {
  readonly relationshipRule?: ConnectorCatalogRelationshipRule;
  readonly pointerObservation?: PointerObservation;
  readonly cacheable?: boolean;
  readonly reusedCachedRejection?: boolean;
}

async function rejectSyncAttempt(
  runtime: ConnectorCatalogSyncRuntime,
  baseline: SyncStateSnapshot | undefined,
  failureCode: ConnectorCatalogSyncFailureCode,
  options: RejectSyncAttemptOptions | undefined,
  signal: AbortSignal,
): Promise<SyncAttemptResult> {
  const resolvedOptions = options ?? {};
  const reusedCachedRejection = resolvedOptions.reusedCachedRejection ?? false;
  const response = await rejectCandidate({
    db: runtime.db,
    source: runtime.source,
    baseline,
    failureCode,
    relationshipRule: resolvedOptions.relationshipRule,
    rejectedCandidate:
      !reusedCachedRejection && (resolvedOptions.cacheable ?? true)
        ? cacheableRejectedCandidate(
            resolvedOptions.pointerObservation,
            failureCode,
          )
        : undefined,
    pointerObservation: resolvedOptions.pointerObservation,
    reusedCachedRejection,
    validator: runtime.rejectionValidator,
  });
  signal.throwIfAborted();
  return response ? { kind: "complete", response } : { kind: "retry" };
}

async function loadPointerForSync(
  runtime: ConnectorCatalogSyncRuntime,
  baseline: SyncStateSnapshot | undefined,
  signal: AbortSignal,
): Promise<PointerLoadResult> {
  const conditionalEtag =
    baseline?.lastObservedPointerEtag &&
    (observedPointerFromState(baseline) ||
      cachedRejectionForObservedEtag(baseline, runtime.rejectionValidator))
      ? baseline.lastObservedPointerEtag
      : null;
  const downloaded = await settle(
    runtime.readActivePointer(conditionalEtag),
    signal,
  );
  signal.throwIfAborted();
  if (!downloaded.ok) {
    const pointerObservation =
      downloaded.error instanceof S3ObjectSizeLimitError &&
      downloaded.error.etag !== null
        ? { pointer: null, etag: downloaded.error.etag }
        : undefined;
    return await rejectSyncAttempt(
      runtime,
      baseline,
      classifySyncFailure(downloaded.error),
      { pointerObservation },
      signal,
    );
  }
  if (downloaded.value.kind === "not-modified") {
    return downloaded.value;
  }

  const { buffer, etag } = downloaded.value;
  const parsed = safeSync(() => {
    return parseConnectorCatalogActivePointer(buffer);
  });
  if (!("ok" in parsed)) {
    return await rejectSyncAttempt(
      runtime,
      baseline,
      classifySyncFailure(parsed.error),
      { pointerObservation: { pointer: null, etag } },
      signal,
    );
  }
  return {
    kind: "loaded",
    pointer: parsed.ok,
    etag,
  };
}

async function loadCandidateForSync(
  runtime: ConnectorCatalogSyncRuntime,
  baseline: SyncStateSnapshot | undefined,
  pointerObservation: PointerObservation & {
    readonly pointer: ConnectorCatalogActivePointer;
  },
  signal: AbortSignal,
): Promise<CandidateLoadResult> {
  const result = await settle(
    loadConnectorCatalogCandidate({
      reader: runtime.reader,
      pointer: pointerObservation.pointer,
    }),
    signal,
  );
  signal.throwIfAborted();
  if (!result.ok) {
    return await rejectSyncAttempt(
      runtime,
      baseline,
      classifySyncFailure(result.error),
      {
        pointerObservation,
        relationshipRule: connectorCatalogArtifactRelationshipRule(
          result.error,
        ),
      },
      signal,
    );
  }
  return { kind: "loaded", candidate: result.value };
}

async function completeUnchangedSync(
  runtime: ConnectorCatalogSyncRuntime,
  baseline: SyncStateSnapshot,
  pointerObservation: PointerObservation | undefined,
  signal: AbortSignal,
): Promise<SyncAttemptResult> {
  const committed = await recordUnchangedAttempt({
    db: runtime.db,
    sourceId: runtime.source.sourceId,
    baseline,
    attemptedAt: nowDate(),
    pointerObservation,
  });
  signal.throwIfAborted();
  if (!committed) {
    return { kind: "retry" };
  }
  const response = await responseFromState({
    db: runtime.db,
    sourceId: runtime.source.sourceId,
    outcome: "unchanged",
  });
  signal.throwIfAborted();
  return { kind: "complete", response };
}

async function commitValidatedCandidate(
  runtime: ConnectorCatalogSyncRuntime,
  args: {
    readonly baseline: SyncStateSnapshot | undefined;
    readonly candidate: ValidatedConnectorCatalogCandidate;
    readonly skillRegistrations: readonly PreparedConnectorSkillRegistration[];
    readonly pointerObservation: PointerObservation;
  },
  signal: AbortSignal,
): Promise<SyncAttemptResult> {
  // Compare permission bundles against the accepted v4 serving state. A cold
  // catalog has no previous runtime snapshot.
  const previousSnapshotResult = await settle(
    loadConnectorRuntimeSnapshot(runtime.db),
    signal,
  );
  signal.throwIfAborted();
  if (
    !previousSnapshotResult.ok &&
    !(
      previousSnapshotResult.error instanceof
        ExternalConnectorCatalogUnavailableError &&
      previousSnapshotResult.error.reason === "missing_current_identity"
    )
  ) {
    log.warn("Failed to load previous connector runtime snapshot", {
      error: previousSnapshotResult.error,
    });
  }
  const catalogGzip = encodeConnectorCatalogSnapshot(args.candidate.rawBytes);
  const outcome = await commitCandidate(
    {
      db: runtime.db,
      sourceId: runtime.source.sourceId,
      baseline: args.baseline,
      candidate: args.candidate,
      catalogGzip,
      capability: runtime.capability,
      validator: runtime.validator,
      skillRegistrations: args.skillRegistrations,
      pointerObservation: args.pointerObservation,
      attemptedAt: nowDate(),
    },
    signal,
  );
  if (outcome === "retry") {
    signal.throwIfAborted();
    return { kind: "retry" };
  }
  if (typeof outcome !== "string") {
    signal.throwIfAborted();
    return await rejectSyncAttempt(
      runtime,
      args.baseline,
      outcome.failure.code,
      {
        pointerObservation: args.pointerObservation,
        cacheable: outcome.failure.cacheable,
      },
      signal,
    );
  }
  log.debug("Connector catalog sync completed", {
    sourceId: runtime.source.sourceId,
    schemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
    catalogVersion: args.candidate.identity.catalogVersion,
    catalogDigest: args.candidate.identity.catalogDigest,
    rawBytes: args.candidate.rawBytes.byteLength,
    compressedBytes: catalogGzip.byteLength,
    outcome,
  });
  await publishCatalogRuntimeWakeups({
    db: runtime.db,
    currentArtifact: args.candidate.artifact,
    previousSnapshot: previousSnapshotResult.ok
      ? previousSnapshotResult.value
      : undefined,
  });
  signal.throwIfAborted();
  const response = await responseFromState({
    db: runtime.db,
    sourceId: runtime.source.sourceId,
    outcome,
  });
  signal.throwIfAborted();
  return { kind: "complete", response };
}

type CandidateSkillPreparationResult =
  | SyncAttemptResult
  | {
      readonly kind: "prepared";
      readonly registrations: readonly PreparedConnectorSkillRegistration[];
    };

async function prepareCandidateSkillsForSync(
  runtime: ConnectorCatalogSyncRuntime,
  baseline: SyncStateSnapshot | undefined,
  candidate: ValidatedConnectorCatalogCandidate,
  pointerObservation: PointerObservation,
  signal: AbortSignal,
): Promise<CandidateSkillPreparationResult> {
  const prepared = await settle(
    prepareConnectorCatalogSkills(
      {
        db: runtime.db,
        artifact: candidate.artifact,
      },
      signal,
    ),
    signal,
  );
  if (prepared.ok) {
    return { kind: "prepared", registrations: prepared.value };
  }
  const failure = connectorCatalogSkillFailure(prepared.error);
  if (!failure) {
    throw prepared.error;
  }
  return await rejectSyncAttempt(
    runtime,
    baseline,
    failure.code,
    {
      pointerObservation,
      cacheable: failure.cacheable,
    },
    signal,
  );
}

async function syncConnectorCatalogAttempt(
  runtime: ConnectorCatalogSyncRuntime,
  signal: AbortSignal,
): Promise<SyncAttemptResult> {
  const baseline = await readSyncState(runtime.db, runtime.source.sourceId);
  signal.throwIfAborted();
  const pointerResult = await loadPointerForSync(runtime, baseline, signal);
  if (pointerResult.kind === "retry" || pointerResult.kind === "complete") {
    return pointerResult;
  }

  let pointerObservation: PointerObservation & {
    readonly pointer: ConnectorCatalogActivePointer;
  };
  if (pointerResult.kind === "not-modified") {
    if (!baseline) {
      return await rejectSyncAttempt(
        runtime,
        baseline,
        "source-unavailable",
        undefined,
        signal,
      );
    }
    const cachedFailure = cachedRejectionForObservedEtag(
      baseline,
      runtime.rejectionValidator,
    );
    if (cachedFailure) {
      return await rejectSyncAttempt(
        runtime,
        baseline,
        cachedFailure,
        {
          reusedCachedRejection: true,
        },
        signal,
      );
    }
    const observedPointer = observedPointerFromState(baseline);
    if (!observedPointer) {
      return await rejectSyncAttempt(
        runtime,
        baseline,
        "source-unavailable",
        undefined,
        signal,
      );
    }
    pointerObservation = {
      pointer: observedPointer,
      etag: baseline.lastObservedPointerEtag,
    };
  } else {
    pointerObservation = {
      pointer: pointerResult.pointer,
      etag: pointerResult.etag,
    };
  }

  const { pointer } = pointerObservation;
  if (pointerMatchesActiveState(pointer, baseline)) {
    if (!baseline) {
      throw new Error("Connector catalog active snapshot disappeared");
    }
    return await completeUnchangedSync(
      runtime,
      baseline,
      pointerObservation,
      signal,
    );
  }

  const cachedFailure = cachedRejectionForPointer(
    pointerObservation,
    baseline,
    runtime.rejectionValidator,
  );
  if (cachedFailure) {
    return await rejectSyncAttempt(
      runtime,
      baseline,
      cachedFailure,
      {
        pointerObservation,
        reusedCachedRejection: true,
      },
      signal,
    );
  }

  const candidateResult = await loadCandidateForSync(
    runtime,
    baseline,
    pointerObservation,
    signal,
  );
  if (candidateResult.kind !== "loaded") {
    return candidateResult;
  }
  const skillPreparation = await prepareCandidateSkillsForSync(
    runtime,
    baseline,
    candidateResult.candidate,
    pointerObservation,
    signal,
  );
  if (skillPreparation.kind !== "prepared") {
    return skillPreparation;
  }
  return await commitValidatedCandidate(
    runtime,
    {
      baseline,
      candidate: candidateResult.candidate,
      skillRegistrations: skillPreparation.registrations,
      pointerObservation,
    },
    signal,
  );
}

export const connectorCatalogStatus$ = command(
  async (
    { get },
    signal: AbortSignal,
  ): Promise<ConnectorCatalogRawSyncStatus> => {
    const source = connectorCatalogSource();
    const state = await readSyncState(get(db$), source.sourceId);
    signal.throwIfAborted();
    return statusFromState(state);
  },
);

export const syncConnectorCatalog$ = command(
  async (
    { get, set },
    signal: AbortSignal,
  ): Promise<ConnectorCatalogRawSyncResponse> => {
    const source = connectorCatalogSource();
    const runtime: ConnectorCatalogSyncRuntime = {
      capability: connectorCatalogExecutableCapabilityState(),
      db: set(writeDb$),
      source,
      rejectionValidator: currentConnectorCatalogRejectionIdentity(),
      validator: currentConnectorCatalogValidatorIdentity(),
      readActivePointer: async (ifNoneMatch) => {
        const result = await get(
          downloadS3BufferWithMaxBytesIfChanged(
            source.bucket,
            CONNECTOR_CATALOG_ACTIVE_KEY,
            CONNECTOR_CATALOG_ACTIVE_MAX_BYTES,
            ifNoneMatch,
            signal,
          ),
        );
        signal.throwIfAborted();
        return result;
      },
      reader: {
        readArtifact: async (key, maxBytes) => {
          const bytes = await get(
            downloadS3BufferWithMaxBytes(source.bucket, key, maxBytes, signal),
          );
          signal.throwIfAborted();
          return bytes;
        },
      },
    };

    while (true) {
      signal.throwIfAborted();
      const result = await syncConnectorCatalogAttempt(runtime, signal);
      signal.throwIfAborted();
      if (result.kind === "retry") {
        continue;
      }
      return result.response;
    }
  },
);
