import { agentRuns } from "@okouai/db/runtime/agent-run";

import type {
  ConnectorCatalogSyncAttemptReport,
  ConnectorCatalogSyncFailureCode,
} from "@okouai/api-contracts/contracts/connector-catalog-sync";
import { orgCustomConnectorOauthConfigs } from "@okouai/db/schema/org-custom-connector-oauth-config";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { connectors } from "@okouai/db/schema/connector";
import { connectorCatalog } from "@okouai/db/runtime/connector-catalog";
import { command } from "ccstate";
import { ne } from "drizzle-orm";
import {
  CONNECTOR_CATALOG_ACTIVE_KEY,
  SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
  type ConnectorCatalogArtifact,
} from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import {
  CONNECTOR_CATALOG_ACTIVE_MAX_BYTES,
  connectorCatalogArtifactFailureCode,
  connectorCatalogArtifactRelationshipRule,
  validateConnectorCatalogCandidateBytes,
  parseConnectorCatalogActivePointer,
  type ConnectorCatalogActivePointer,
  type ValidatedConnectorCatalogCandidate,
} from "@okouai/connectors/connector-catalog/artifacts/loader";
import { CONNECTOR_CATALOG_MAX_RAW_BYTES } from "@okouai/connectors/connector-catalog/contracts";
import type { ConnectorCatalogRelationshipRule } from "@okouai/connectors/connector-catalog/artifacts/relationship-error";

import { logger } from "../../lib/log";
import { writeDb$, type Db } from "../external/db";
import {
  downloadS3BufferWithMaxBytes,
  S3ObjectSizeLimitError,
} from "../external/s3";
import { safeSync, settle } from "../utils";
import {
  immutableCatalogHash$,
  prepareImmutableCatalogEntries$,
} from "./connector-catalog-immutable.service";
import {
  connectorCatalogSkillFailure,
  type ConnectorCatalogSkillFailure,
} from "./connector-catalog-skill-registration.service";
import {
  connectorCatalogSource,
  type ConnectorCatalogSource,
} from "./connector-catalog-source";
import {
  materializeConnectorRuntimeSnapshot,
  type ConnectorRuntimeSnapshot,
} from "./connector-catalog-runtime.service";
import {
  ExternalConnectorCatalogUnavailableError,
  loadAcceptedConnectorCatalogSnapshot,
} from "./connector-catalog-external-reader.service";
import { loadCustomConnectorPermissionBundle } from "./custom-connector-permission-bundle.service";
import {
  uniqueConnectorRuntimeTargets,
  connectorRuntimeWakeupCondition,
  publishConnectorRuntimeWakeupRows,
  reportConnectorRuntimeWakeupDiscoveryFailure,
  type ConnectorRuntimeWakeupBusinessArgs,
} from "./connector-runtime-wakeup.service";
import {
  builtinCatalogWakeupReadPlan,
  builtinCatalogWakeupAccountsByOrg,
} from "./connector-catalog-builtin-wakeup-plan";
import {
  customCatalogWakeupConnectorsByRef,
  customConnectorPermissionBundleFingerprint,
  customCatalogWakeupReadPlan,
  catalogWakeupRunColumns,
  customCatalogWakeup,
  builtinCatalogWakeup,
  customCatalogWakeupSummary,
} from "./connector-catalog-wakeup-plan";

const log = logger("connector-catalog:sync");

class ConnectorCatalogPersistenceError extends Error {
  constructor() {
    super("Connector catalog snapshot persistence failed");
    this.name = "ConnectorCatalogPersistenceError";
  }
}

function reportCatalogWakeupDiscoveryFailure(
  wakeup: ConnectorRuntimeWakeupBusinessArgs,
  error: unknown,
): void {
  reportConnectorRuntimeWakeupDiscoveryFailure({
    orgId: wakeup.scope.orgId,
    scopedToUser: wakeup.scope.userId !== undefined,
    scopedToAgent: wakeup.scope.agentId !== undefined,
    targetCount: uniqueConnectorRuntimeTargets(wakeup.targets).length,
    error,
  });
}

function reportCatalogWakeupFailures(
  results: readonly (
    { readonly ok: true } | { readonly ok: false; readonly error: unknown }
  )[],
): void {
  for (const result of results) {
    if (!result.ok) {
      log.warn("Failed to publish connector catalog runtime wakeups", {
        error: result.error,
      });
    }
  }
}

async function publishCatalogRuntimeWakeups(args: {
  readonly db: Db;
  readonly previousSnapshot: ConnectorRuntimeSnapshot | undefined;
  readonly currentArtifact: ConnectorCatalogArtifact;
}): Promise<void> {
  const results = await Promise.all([
    settle(
      (async () => {
        const readPlan = customCatalogWakeupReadPlan(args.currentArtifact);
        const currentCatalog = readPlan.catalog;
        const rows = await args.db
          .select(readPlan.columns)
          .from(orgCustomConnectors)
          .leftJoin(orgCustomConnectorOauthConfigs, readPlan.oauthCondition)
          .where(readPlan.condition);

        const connectorIdsByRef = customCatalogWakeupConnectorsByRef(rows);
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
            const wakeupDb = args.db;
            const wakeup = customCatalogWakeup(orgId, customConnectorIds);
            await (async () => {
              const result = await settle(
                (async () => {
                  const targets = uniqueConnectorRuntimeTargets(wakeup.targets);
                  if (targets.length === 0) {
                    return;
                  }

                  const rows = await wakeupDb
                    .select(catalogWakeupRunColumns())
                    .from(agentRuns)

                    .where(connectorRuntimeWakeupCondition(wakeup.scope));

                  await publishConnectorRuntimeWakeupRows({
                    scope: wakeup.scope,
                    targets,
                    rows,
                  });
                })(),
              );
              if (!result.ok) {
                reportCatalogWakeupDiscoveryFailure(wakeup, result.error);
              }
            })();
          }),
        );
        log.debug(
          "Evaluated Custom connector catalog wakeups",
          customCatalogWakeupSummary(connectorIdsByRef.size, affectedByOrg),
        );
      })(),
    ),
    settle(
      (async () => {
        const plan = builtinCatalogWakeupReadPlan({
          previousArtifact: args.previousSnapshot?.acceptedSnapshot.artifact,
          currentArtifact: args.currentArtifact,
        });
        if (!plan.needsRead) {
          return;
        }
        const accounts = await args.db
          .selectDistinct(plan.columns)
          .from(connectors)
          .where(plan.condition);
        const byOrg = builtinCatalogWakeupAccountsByOrg(accounts);
        const pending = byOrg.entries();
        async function publishOrgWakeups() {
          for (const [orgId, slugs] of pending) {
            const wakeupDb = args.db;
            const wakeup = builtinCatalogWakeup(orgId, slugs);
            await (async () => {
              const result = await settle(
                (async () => {
                  const targets = uniqueConnectorRuntimeTargets(wakeup.targets);
                  if (targets.length === 0) {
                    return;
                  }

                  const rows = await wakeupDb
                    .select(catalogWakeupRunColumns())
                    .from(agentRuns)

                    .where(connectorRuntimeWakeupCondition(wakeup.scope));

                  await publishConnectorRuntimeWakeupRows({
                    scope: wakeup.scope,
                    targets,
                    rows,
                  });
                })(),
              );
              if (!result.ok) {
                reportCatalogWakeupDiscoveryFailure(wakeup, result.error);
              }
            })();
          }
        }
        await Promise.all(
          Array.from({ length: Math.min(4, byOrg.size) }, publishOrgWakeups),
        );
      })(),
    ),
  ]);
  reportCatalogWakeupFailures(results);
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

function rejectedAttempt(args: {
  readonly source: ConnectorCatalogSource;
  readonly failureCode: ConnectorCatalogSyncFailureCode;
  readonly pointer?: ConnectorCatalogActivePointer;
  readonly relationshipRule?: ConnectorCatalogRelationshipRule;
  readonly servingHash: string | null;
}): ConnectorCatalogSyncAttemptReport {
  // Nothing is persisted for a rejection. Each scheduled attempt revalidates
  // the publication and this log line is the operational record.
  log.warn("Connector catalog candidate rejected", {
    sourceId: args.source.sourceId,
    schemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
    failureCode: args.failureCode,
    retainedServingHash: args.servingHash,
    ...(args.pointer
      ? {
          catalogVersion: args.pointer.catalogVersion,
          catalogDigest: args.pointer.catalogDigest,
        }
      : {}),
    ...(args.relationshipRule === undefined
      ? {}
      : { relationshipRule: args.relationshipRule }),
  });
  return { outcome: "rejected", failureCode: args.failureCode };
}

type PointerLoadResult =
  | {
      readonly kind: "loaded";
      readonly pointer: ConnectorCatalogActivePointer;
    }
  | { readonly kind: "rejected"; readonly error: unknown };

const loadPointerForSync$ = command(
  async (
    { get },
    source: ConnectorCatalogSource,
    signal: AbortSignal,
  ): Promise<PointerLoadResult> => {
    const downloaded = await settle(
      get(
        downloadS3BufferWithMaxBytes(
          source.bucket,
          CONNECTOR_CATALOG_ACTIVE_KEY,
          CONNECTOR_CATALOG_ACTIVE_MAX_BYTES,
          signal,
        ),
      ),
      signal,
    );
    signal.throwIfAborted();
    if (!downloaded.ok) {
      return { kind: "rejected", error: downloaded.error };
    }
    const parsed = safeSync(() => {
      return parseConnectorCatalogActivePointer(downloaded.value);
    });
    return "ok" in parsed
      ? { kind: "loaded", pointer: parsed.ok }
      : { kind: "rejected", error: parsed.error };
  },
);

type CandidateLoadResult =
  | {
      readonly kind: "loaded";
      readonly candidate: ValidatedConnectorCatalogCandidate;
    }
  | { readonly kind: "rejected"; readonly error: unknown };

const loadCandidateForSync$ = command(
  async (
    { get },
    source: ConnectorCatalogSource,
    pointer: ConnectorCatalogActivePointer,
    signal: AbortSignal,
  ): Promise<CandidateLoadResult> => {
    const downloaded = await settle(
      get(
        downloadS3BufferWithMaxBytes(
          source.bucket,
          pointer.catalogKey,
          CONNECTOR_CATALOG_MAX_RAW_BYTES,
          signal,
        ),
      ),
      signal,
    );
    signal.throwIfAborted();
    const result = downloaded.ok
      ? safeSync(() => {
          return validateConnectorCatalogCandidateBytes({
            pointer,
            rawBytes: downloaded.value,
          });
        })
      : { error: downloaded.error };
    return "ok" in result
      ? { kind: "loaded", candidate: result.ok }
      : { kind: "rejected", error: result.error };
  },
);

type PublishResult =
  | { readonly kind: "published"; readonly switched: boolean }
  | {
      readonly kind: "rejected";
      readonly failure: ConnectorCatalogSkillFailure;
    };

// The caller has completed every entry at `hash`. Last writer wins; the
// conditional upsert returns a row only when it inserts or changes the pointer.
const publishCatalogPointer$ = command(
  async (
    { set },
    args: { readonly schemaVersion: number; readonly hash: string },
    signal: AbortSignal,
  ): Promise<{ readonly switched: boolean }> => {
    signal.throwIfAborted();
    const changed = await set(writeDb$)
      .insert(connectorCatalog)
      .values({ schemaVersion: args.schemaVersion, hash: args.hash })
      .onConflictDoUpdate({
        target: connectorCatalog.schemaVersion,
        set: { hash: args.hash },
        setWhere: ne(connectorCatalog.hash, args.hash),
      })
      .returning({ hash: connectorCatalog.hash });
    // Cancellation after this atomic statement commits cannot undo publication.
    signal.throwIfAborted();
    return { switched: changed.length === 1 };
  },
);

// Entries first, pointer second. Failed or interrupted preparation leaves the
// previous generation serving and at most an unreferenced partial generation
// that the next attempt reuses.
const publishCandidate$ = command(
  async (
    { set },
    args: {
      readonly source: ConnectorCatalogSource;
      readonly candidate: ValidatedConnectorCatalogCandidate;
    },
    signal: AbortSignal,
  ): Promise<PublishResult> => {
    const hash = args.candidate.identity.catalogDigest;
    const result = await settle(
      (async () => {
        await set(
          prepareImmutableCatalogEntries$,
          { artifact: args.candidate.artifact, hash },
          signal,
        );
        signal.throwIfAborted();
        const { switched } = await set(
          publishCatalogPointer$,
          {
            schemaVersion: args.candidate.artifact.artifactSchemaVersion,
            hash,
          },
          signal,
        );
        return switched;
      })(),
    );
    signal.throwIfAborted();
    if (result.ok) {
      return { kind: "published", switched: result.value };
    }
    const failure = connectorCatalogSkillFailure(result.error);
    if (failure) {
      return { kind: "rejected", failure };
    }
    log.error("Connector catalog publication failed", {
      sourceId: args.source.sourceId,
      catalogDigest: hash,
      error: result.error,
    });
    throw new ConnectorCatalogPersistenceError();
  },
);

/**
 * Validate the official publication, prepare its complete immutable entries,
 * then move the pointer. One scheduled cron is the production writer and the
 * last writer wins; there is no compare-and-swap, sync state or rejection
 * cache. A rejected candidate leaves the current pointer serving.
 */
export const syncConnectorCatalog$ = command(
  async (
    { set },
    signal: AbortSignal,
  ): Promise<ConnectorCatalogSyncAttemptReport> => {
    const source = connectorCatalogSource();
    const servingHash = await set(immutableCatalogHash$, signal);
    const pointerResult = await set(loadPointerForSync$, source, signal);
    if (pointerResult.kind === "rejected") {
      return rejectedAttempt({
        source,
        failureCode: classifySyncFailure(pointerResult.error),
        servingHash,
      });
    }
    const { pointer } = pointerResult;
    // The pointer only references complete generations, and every generation
    // was validated before it was published, so an equal hash is unchanged.
    if (pointer.catalogDigest === servingHash) {
      log.debug("Connector catalog unchanged", {
        sourceId: source.sourceId,
        catalogDigest: servingHash,
      });
      return { outcome: "unchanged", failureCode: null };
    }

    const candidateResult = await set(
      loadCandidateForSync$,
      source,
      pointer,
      signal,
    );
    if (candidateResult.kind === "rejected") {
      return rejectedAttempt({
        source,
        failureCode: classifySyncFailure(candidateResult.error),
        pointer,
        relationshipRule: connectorCatalogArtifactRelationshipRule(
          candidateResult.error,
        ),
        servingHash,
      });
    }
    const { candidate } = candidateResult;

    // Compare permission bundles against the generation serving before the
    // switch. A cold catalog has no previous runtime snapshot.
    const db = set(writeDb$);
    const previousSnapshotResult = await settle(
      (async () => {
        return materializeConnectorRuntimeSnapshot(
          await loadAcceptedConnectorCatalogSnapshot(db),
        );
      })(),
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

    const published = await set(
      publishCandidate$,
      { source, candidate },
      signal,
    );
    if (published.kind === "rejected") {
      return rejectedAttempt({
        source,
        failureCode: published.failure.code,
        pointer,
        servingHash,
      });
    }
    log.debug("Connector catalog published", {
      sourceId: source.sourceId,
      schemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
      catalogVersion: candidate.identity.catalogVersion,
      catalogDigest: candidate.identity.catalogDigest,
      previousHash: servingHash,
      rawBytes: candidate.rawBytes.byteLength,
      switched: published.switched,
    });
    if (published.switched) {
      await publishCatalogRuntimeWakeups({
        db,
        currentArtifact: candidate.artifact,
        previousSnapshot: previousSnapshotResult.ok
          ? previousSnapshotResult.value
          : undefined,
      });
    }
    signal.throwIfAborted();
    return { outcome: "accepted", failureCode: null };
  },
);
