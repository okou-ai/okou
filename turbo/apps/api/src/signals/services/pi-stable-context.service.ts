import { customConnectorDefinitionHasStableSkill } from "./pi-stable-context-recapture.service";
import { parseRawRows } from "../../lib/db-raw-rows";
import type { z } from "zod";
import {
  piSourceFactsReceiptSchema,
  piSourceFactsSql,
  piCatalogEntriesReceiptSchema,
  piCatalogEntriesSql,
  piStorageFactsReceiptSchema,
  piStorageFactsSql,
  type PiStorageFact,
  type PiStorageReadRequest,
} from "./pi-stable-context-capture.service";
import {
  type ImmutableConnectorCatalogCapture,
  materializeImmutableConnectorRuntimeSelection,
  type ImmutableConnectorRuntimeSelection,
} from "./connector-catalog-entries.service";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type { ImmutableConnectorCatalogEntry } from "@okouai/db/jsonb-contracts/immutable-connector-catalog";
import { randomUUID } from "node:crypto";
import { hasImmutablePiCatalogSource } from "./pi-stable-context-source.service";
import { isDeepStrictEqual } from "node:util";
import {
  piResourceSnapshotSchema,
  type PiMemoryRecallSelection,
  type PiResourceSnapshot,
  type StoredStorageMountEntry,
  PI_SKILLS_ROOT,
} from "@okouai/api-contracts/contracts/runners";
import type {
  PiStableContextBuildInput,
  PiStableContextOwner,
  PiStableContextProjection,
  PiStableContextPromptProjection,
  PiStableContextSemanticInput,
  PiStableContextSourceVector,
  PiStableContextStorageMount,
  PiStableContextPromptInputs,
} from "@okouai/db/jsonb-contracts/pi-stable-context";
import type { PiResourceSnapshotV1 } from "@okouai/db/jsonb-contracts/pi-resource-snapshot";
import { agents } from "@okouai/db/schema/agent";
import {
  piStableContextArtifactResources,
  piStableContextArtifacts,
  piStableContextGenerations,
  piStableContextHeads,
} from "@okouai/db/schema/pi-stable-context";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import type { PersistedStorageMount } from "@okouai/db/types";
import { computed, type Computed } from "ccstate";
import { and, asc, eq, inArray, lt, lte, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { PI_RESOURCE_EXTRACTOR_VERSION } from "../../lib/pi-resource-index";
import type { Tx } from "../../lib/db-types";
import { now, nowDate } from "../../lib/time";
import { settle } from "../utils";
import type { Db } from "../external/db";
import { recordSandboxOperation } from "../external/sandbox-op-log";
import {
  buildPiResourceSnapshotFromIndexes,
  PI_RESOURCE_SNAPSHOT_MAX_BYTES,
  piResourceDiscoveryMounts,
  piResourceSnapshotDigest,
  preparePiResourceSnapshot,
  UnsupportedPiResourceError,
} from "./pi-resource-snapshot.service";
import { readPiResourceVersionIndexes } from "./pi-resource-version-index.service";
import {
  PI_STABLE_CONTEXT_SCHEMA_VERSION,
  piStableContextArtifactDigest,
  piStableContextInputDigest,
  piStableContextVariantDigest,
} from "./pi-stable-context-digest.service";
import { PI_STABLE_CONTEXT_AGENT_SUBJECT } from "./pi-stable-context-generation.service";
import { permissionGrantsToFirewallPolicies } from "@okouai/connectors/firewall-metadata/policy";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import {
  getCustomConnectorSkillName,
  getCustomConnectorSkillStorageName,
  getCustomSkillStorageName,
  getOfficialWorkflowDefinitionStorageName,
  SYSTEM_ORG_ID,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import {
  agentConnectorScopeFromRows,
} from "./agent-connector-scope.service";
import { buildAgentIdentityPrompt } from "./agent-identity-prompt.service";
import {
  buildAgentToolsPrompt,
  buildAgentToolsPromptInputs,
} from "./agent-tools-prompt.service";
import { uniqueSortedConnectorSlugs } from "./connector-catalog-runtime.service";
import { expandConnectorServerFirewallPolicies } from "./connector-server-firewall-catalog.service";
import { userFeatureSwitchOverridesFromRows } from "./feature-switch-scope";
import { acceptedCatalogFromRow } from "./official-workflow-catalog-read.service";
import { normalizeMountOverlay } from "./storage-mount-overlay";
import { workflowsForRunFromRows } from "./workflow-data.service";
import { connectorCatalog } from "@okouai/db/schema/connector-catalog";
import { SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION } from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import { connectorCatalogExecutableCapabilityState } from "./connector-catalog-compatibility.service";
import { customConnectorPermissionBundleDependencySlug } from "./custom-connector-permission-bundle.service";

export { piStableContextArtifactDigest, piStableContextVariantDigest };
const PI_STABLE_CONTEXT_LEASE_MS = 5 * 60 * 1000;
const PI_STABLE_CONTEXT_RETRY_MS = 5000;
const PI_STABLE_CONTEXT_WORK_LIMIT = 16;
const PI_STABLE_CONTEXT_MAX_ATTEMPTS = 5;

type StableSourceWithoutGenerations = Omit<
  PiStableContextSourceVector,
  "agentGeneration" | "userGeneration" | "extractorVersion"
>;

interface PreparePiStableContextArgs {
  readonly db: Db;
  readonly owner: PiStableContextOwner;
  readonly variantDigest: string;
  readonly buildPrompt: () => PiStableContextPromptProjection;
  readonly semantic?: PiStableContextSemanticInput;
  readonly source: StableSourceWithoutGenerations;
  readonly mounts: readonly StoredStorageMountEntry[];
  readonly persistedStorageMounts: readonly PersistedStorageMount[];
  readonly memoryRecall?: PiMemoryRecallSelection;
  readonly eligible: boolean;
  readonly checkedAt: Date;
  readonly runId?: string;
  readonly beforeSourceGenerationInitialization?: () => Promise<void>;
  readonly beforeDemandRegistration?: () => Promise<void>;
}

type PiStableContextReadKind =
  | "ready"
  | "missing"
  | "pending"
  | "source_pending"
  | "unindexable"
  | "failed"
  | "dynamic";

interface PreparedPiStableContext {
  readonly digest: string;
  readonly snapshot: PiResourceSnapshot;
  readonly prompt: PiStableContextPromptProjection;
  readonly kind: PiStableContextReadKind;
}

interface SourceGenerations {
  readonly agentGeneration: number;
  readonly userGeneration: number;
  readonly ready: boolean;
}

interface StableContextDemand {
  readonly headId: string;
  readonly generation: number;
  readonly input: PiStableContextBuildInput;
  readonly inputDigest: string;
}

interface ClaimedStableContextWork extends StableContextDemand {
  readonly leaseId: string;
  readonly attemptCount: number;
}

interface StableContextWorkResult {
  claimed: number;
  ready: number;
  pending: number;
  unindexable: number;
  failed: number;
  stale: number;
}

interface PiStableContextWorkScope {
  readonly headIds: readonly string[];
}

function stableStorageMount(
  mount: StoredStorageMountEntry,
): PiStableContextStorageMount {
  return {
    orgId: mount.orgId,
    userId: mount.userId,
    name: mount.name,
    storageId: mount.storageId,
    versionId: mount.versionId,
    mountPath: mount.mountPath,
    ...(mount.archiveSize === undefined
      ? {}
      : { archiveSize: mount.archiveSize }),
    ...(mount.empty === undefined ? {} : { empty: mount.empty }),
    ...(mount.baselineCandidate === undefined
      ? {}
      : { baselineCandidate: mount.baselineCandidate }),
    ...(mount.instructionsTargetFilename === undefined
      ? {}
      : { instructionsTargetFilename: mount.instructionsTargetFilename }),
    ...(mount.missingRootPolicy === undefined
      ? {}
      : { missingRootPolicy: mount.missingRootPolicy }),
    ...(mount.writeback === undefined ? {} : { writeback: mount.writeback }),
  };
}

function stablePersistedMount(
  mount: PersistedStorageMount,
): PersistedStorageMount {
  const { piMemoryRecall: _memoryRecall, ...stable } = mount;
  return stable;
}

function storageMountForComposer(
  mount: PiStableContextStorageMount,
): StoredStorageMountEntry {
  return {
    ...mount,
    // The worker never downloads archives. This field only satisfies the
    // canonical in-memory mount contract after an exact index is selected.
    ...(mount.empty ? {} : { archiveUrl: "stable-context://indexed" }),
  };
}

async function lockStableContextOwnerAuthority(
  tx: Tx,
  owner: PiStableContextOwner,
): Promise<boolean> {
  const [executingMember] = await tx
    .select({ userId: orgMembersCache.userId })
    .from(orgMembersCache)
    .where(
      and(
        eq(orgMembersCache.orgId, owner.orgId),
        eq(orgMembersCache.userId, owner.userId),
      ),
    )
    .for("key share")
    .limit(1);
  if (!executingMember) {
    return false;
  }
  const [agent] = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.id, owner.agentId),
        eq(agents.orgId, owner.resourceOwner.orgId),
        eq(agents.owner, owner.resourceOwner.userId),
      ),
    )
    .for("key share")
    .limit(1);
  return agent !== undefined;
}

type StableContextInputIdentity = Omit<
  PiStableContextBuildInput,
  "prompt" | "semantic"
>;

function buildInputIdentity(
  args: PreparePiStableContextArgs,
  generations: SourceGenerations,
): StableContextInputIdentity {
  const stableMounts = piResourceDiscoveryMounts(args.mounts);
  const stableMountKeys = new Set(
    stableMounts.map((mount) => {
      return JSON.stringify([
        mount.storageId,
        mount.versionId,
        mount.mountPath,
      ]);
    }),
  );
  return {
    schemaVersion: PI_STABLE_CONTEXT_SCHEMA_VERSION,
    owner: args.owner,
    source: {
      ...args.source,
      agentGeneration: generations.agentGeneration,
      userGeneration: generations.userGeneration,
      extractorVersion: PI_RESOURCE_EXTRACTOR_VERSION,
    },
    storageMounts: stableMounts.map(stableStorageMount),
    persistedStorageMounts: args.persistedStorageMounts
      .filter((mount) => {
        return (
          mount.version !== undefined &&
          stableMountKeys.has(
            JSON.stringify([mount.storageId, mount.version, mount.mountPath]),
          )
        );
      })
      .map(stablePersistedMount),
  };
}

function buildInput(
  args: PreparePiStableContextArgs,
  generations: SourceGenerations,
): PiStableContextBuildInput {
  return {
    ...buildInputIdentity(args, generations),
    prompt: args.buildPrompt(),
    ...(args.semantic ? { semantic: args.semantic } : {}),
  };
}

function projectionInputIdentity(
  projection: PiStableContextProjection,
): StableContextInputIdentity {
  return {
    schemaVersion: projection.schemaVersion,
    owner: projection.owner,
    source: projection.source,
    storageMounts: projection.storageMounts,
    persistedStorageMounts: projection.persistedStorageMounts,
  };
}

export function piStableContextProjectionFromInput(
  input: PiStableContextBuildInput,
  resourceSnapshot: PiResourceSnapshotV1,
): PiStableContextProjection {
  return {
    schemaVersion: PI_STABLE_CONTEXT_SCHEMA_VERSION,
    owner: input.owner,
    source: input.source,
    prompt: input.prompt,
    storageMounts: input.storageMounts,
    persistedStorageMounts: input.persistedStorageMounts,
    resourceSnapshot,
  };
}

function baseResourceSnapshot(
  snapshot: PiResourceSnapshot,
): PiResourceSnapshotV1 {
  return {
    schemaVersion: 1,
    agentsFiles: snapshot.agentsFiles,
    skills: snapshot.skills,
  };
}

function bindMemoryRecall(
  snapshot: PiResourceSnapshotV1,
  memoryRecall: PiMemoryRecallSelection | undefined,
): PiResourceSnapshot {
  const bound: PiResourceSnapshot = memoryRecall
    ? { ...snapshot, schemaVersion: 2, memoryRecall }
    : snapshot;
  if (
    Buffer.byteLength(JSON.stringify(bound), "utf8") >
    PI_RESOURCE_SNAPSHOT_MAX_BYTES
  ) {
    throw new Error("Pi resource snapshot exceeds its size limit");
  }
  return piResourceSnapshotSchema.parse(bound);
}

function validityHorizon(source: PiStableContextSourceVector): Date | null {
  return source.validityHorizon ? new Date(source.validityHorizon) : null;
}

function horizonIsValid(
  source: PiStableContextSourceVector,
  checkedAt: Date,
): boolean {
  const horizon = validityHorizon(source);
  return horizon === null || horizon.getTime() > checkedAt.getTime();
}

async function ensureSourceGenerationsInTransaction(
  db: Tx,
  owner: PiStableContextOwner,
): Promise<SourceGenerations> {
  const subjects = [PI_STABLE_CONTEXT_AGENT_SUBJECT, owner.userId];
  await db
    .insert(piStableContextGenerations)
    .values(
      subjects.map((subject) => {
        return {
          orgId: owner.orgId,
          agentId: owner.agentId,
          subject,
        };
      }),
    )
    .onConflictDoNothing();
  const rows = await db
    .select({
      subject: piStableContextGenerations.subject,
      generation: piStableContextGenerations.generation,
      publicationState: piStableContextGenerations.publicationState,
    })
    .from(piStableContextGenerations)
    .where(
      and(
        eq(piStableContextGenerations.orgId, owner.orgId),
        eq(piStableContextGenerations.agentId, owner.agentId),
        inArray(piStableContextGenerations.subject, subjects),
      ),
    );
  const bySubject = new Map(
    rows.map((row) => {
      return [row.subject, row] as const;
    }),
  );
  const agent = bySubject.get(PI_STABLE_CONTEXT_AGENT_SUBJECT);
  const user = bySubject.get(owner.userId);
  if (!agent || !user) {
    throw new Error("Stable-context source generation is unavailable");
  }
  return {
    agentGeneration: agent.generation,
    userGeneration: user.generation,
    ready:
      agent.publicationState === "ready" && user.publicationState === "ready",
  };
}

async function ensureSourceGenerations(
  db: Db,
  owner: PiStableContextOwner,
): Promise<SourceGenerations | null> {
  return await db.transaction(async (tx) => {
    if (!(await lockStableContextOwnerAuthority(tx, owner))) {
      return null;
    }
    return await ensureSourceGenerationsInTransaction(tx, owner);
  });
}

async function readReadyProjection(args: PreparePiStableContextArgs): Promise<{
  readonly projection: PiStableContextProjection;
  readonly generations: SourceGenerations;
} | null> {
  const agentGeneration = alias(
    piStableContextGenerations,
    "stable_context_agent_generation",
  );
  const userGeneration = alias(
    piStableContextGenerations,
    "stable_context_user_generation",
  );
  const [row] = await args.db
    .select({
      projection: piStableContextArtifacts.projection,
      headInput: piStableContextHeads.input,
      artifactDigest: piStableContextArtifacts.digest,
      agentGeneration: agentGeneration.generation,
      userGeneration: userGeneration.generation,
      agentState: agentGeneration.publicationState,
      userState: userGeneration.publicationState,
    })
    .from(piStableContextHeads)
    .innerJoin(
      piStableContextArtifacts,
      eq(piStableContextArtifacts.digest, piStableContextHeads.artifactDigest),
    )
    .innerJoin(
      agentGeneration,
      and(
        eq(agentGeneration.orgId, piStableContextHeads.orgId),
        eq(agentGeneration.agentId, piStableContextHeads.agentId),
        eq(agentGeneration.subject, PI_STABLE_CONTEXT_AGENT_SUBJECT),
      ),
    )
    .innerJoin(
      userGeneration,
      and(
        eq(userGeneration.orgId, piStableContextHeads.orgId),
        eq(userGeneration.agentId, piStableContextHeads.agentId),
        eq(userGeneration.subject, piStableContextHeads.userId),
      ),
    )
    .where(
      and(
        eq(piStableContextHeads.orgId, args.owner.orgId),
        eq(piStableContextHeads.userId, args.owner.userId),
        eq(piStableContextHeads.agentId, args.owner.agentId),
        eq(piStableContextHeads.variantDigest, args.variantDigest),
        eq(piStableContextHeads.status, "ready"),
        eq(piStableContextHeads.agentGeneration, agentGeneration.generation),
        eq(piStableContextHeads.userGeneration, userGeneration.generation),
      ),
    )
    .limit(1);
  if (!row || row.agentState !== "ready" || row.userState !== "ready") {
    return null;
  }
  const generations = {
    agentGeneration: row.agentGeneration,
    userGeneration: row.userGeneration,
    ready: true,
  };
  const expectedIdentity = buildInputIdentity(args, generations);
  const projection = row.projection;
  if (
    !piReadyBindingSourcesMatch(
      row.headInput,
      projection,
      connectorCatalogExecutableCapabilityState().digest,
    )
  ) {
    return null;
  }
  if (
    piStableContextVariantDigest(expectedIdentity) !==
      piStableContextVariantDigest(projectionInputIdentity(projection)) ||
    piStableContextArtifactDigest(projection) !== row.artifactDigest ||
    !horizonIsValid(projection.source, args.checkedAt)
  ) {
    return null;
  }
  return { projection, generations };
}

async function lockMatchingReadyGenerations(
  tx: Tx,
  owner: PiStableContextOwner,
  generations: SourceGenerations,
): Promise<boolean> {
  const subjects = [PI_STABLE_CONTEXT_AGENT_SUBJECT, owner.userId];
  const currentGenerations = await tx
    .select({
      subject: piStableContextGenerations.subject,
      generation: piStableContextGenerations.generation,
      publicationState: piStableContextGenerations.publicationState,
    })
    .from(piStableContextGenerations)
    .where(
      and(
        eq(piStableContextGenerations.orgId, owner.orgId),
        eq(piStableContextGenerations.agentId, owner.agentId),
        inArray(piStableContextGenerations.subject, subjects),
      ),
    )
    .orderBy(asc(piStableContextGenerations.subject))
    .for("update");
  const currentBySubject = new Map(
    currentGenerations.map((row) => {
      return [row.subject, row] as const;
    }),
  );
  const currentAgent = currentBySubject.get(PI_STABLE_CONTEXT_AGENT_SUBJECT);
  const currentUser = currentBySubject.get(owner.userId);
  return (
    currentAgent?.publicationState === "ready" &&
    currentUser?.publicationState === "ready" &&
    currentAgent.generation === generations.agentGeneration &&
    currentUser.generation === generations.userGeneration
  );
}

async function registerDemand(
  args: PreparePiStableContextArgs,
  generations: SourceGenerations,
): Promise<StableContextDemand | null> {
  const capturedInput = buildInput(args, generations);
  const result = await settle(
    args.db.transaction(
      async (tx) => {
        const expected = expectsPiCatalog(capturedInput);
        const [current] = expected
          ? await tx
              .select(piCatalogCaptureColumns())
              .from(connectorCatalog)
              .where(
                eq(
                  connectorCatalog.schemaVersion,
                  SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
                ),
              )
              .for("share")
          : [];
        requireExpectedPiCatalog(expected, current);
        if (
          !(await lockStableContextOwnerAuthority(tx, args.owner)) ||
          !(await lockMatchingReadyGenerations(tx, args.owner, generations))
        ) {
          return null;
        }
        const facts = requirePiReceipt(
          parseRawRows(
            piSourceFactsReceiptSchema,
            await tx.execute(piSourceFactsSql(args.owner, args.checkedAt)),
          ),
        ).facts;
        const plan = piCapturePlan(capturedInput, current, facts);
        const entries = requirePiReceipt(
          parseRawRows(
            piCatalogEntriesReceiptSchema,
            await tx.execute(
              piCatalogEntriesSql(plan.current?.hash ?? null, plan.slugs),
            ),
          ),
        ).entries;
        const prepared = await piPreparedRecapture(
          capturedInput,
          facts,
          plan,
          entries,
        );
        if (!prepared) {
          return null;
        }
        const requests = piStorageRequests(capturedInput, prepared.desired);
        const rows = requirePiReceipt(
          parseRawRows(
            piStorageFactsReceiptSchema,
            await tx.execute(piStorageFactsSql(requests)),
          ),
        ).facts;
        const recaptured = piInputFromPrepared(capturedInput, prepared, rows);
        if (!recaptured) {
          return null;
        }
        const input = {
          ...recaptured,
          source: {
            ...recaptured.source,
            agentGeneration: generations.agentGeneration,
            userGeneration: generations.userGeneration,
          },
        };
        const inputDigest = piStableContextInputDigest(input);
        const initialValues = piDemandValues(
          input,
          args.variantDigest,
          inputDigest,
          nowDate(),
        );
        // Current fencing also serializes a first head and old-shape conversion.
        const [inserted] = await tx
          .insert(piStableContextHeads)
          .values(initialValues)
          .onConflictDoNothing()
          .returning({ id: piStableContextHeads.id });
        if (inserted) {
          return { headId: inserted.id, generation: 1, input, inputDigest };
        }
        const existing = requirePiReceipt(
          await tx
            .select(piDemandHeadColumns())
            .from(piStableContextHeads)
            .where(piHeadOwnerCondition(args.owner, args.variantDigest))
            .for("update")
            .limit(1),
        );
        if (piDemandIsUnchanged(existing, inputDigest, generations)) {
          return {
            headId: existing.id,
            generation: existing.generation,
            input,
            inputDigest,
          };
        }
        const generation = existing.generation + 1;
        const head = requirePiReceipt(
          await tx
            .update(piStableContextHeads)
            .set({ ...initialValues, generation })
            .where(eq(piStableContextHeads.id, existing.id))
            .returning({ id: piStableContextHeads.id }),
        );
        return { headId: head.id, generation, input, inputDigest };
      },
      { isolationLevel: "read committed" },
    ),
  );
  if (!result.ok) {
    if (result.error instanceof PiCatalogDependencyDiscovered) {
      return null;
    }
    throw result.error;
  }
  return result.value;
}

function projectionResources(projection: PiStableContextProjection) {
  return projection.storageMounts.map((mount, ordinal) => {
    return {
      ordinal,
      storageId: mount.storageId,
      storageVersionId: mount.versionId,
    };
  });
}

async function publishProjection(
  db: Db,
  demand: Pick<
    StableContextDemand,
    "headId" | "generation" | "input" | "inputDigest"
  > & { readonly leaseId?: string },
  projection: PiStableContextProjection,
  afterResourceLock?: (tx: Tx) => Promise<void>,
  afterArtifactLock?: (tx: Tx) => Promise<void>,
): Promise<boolean> {
  const artifactDigest = piStableContextArtifactDigest(projection);
  const condition = and(
    eq(piStableContextHeads.id, demand.headId),
    eq(piStableContextHeads.generation, demand.generation),
    eq(piStableContextHeads.inputDigest, demand.inputDigest),
    eq(
      piStableContextHeads.agentGeneration,
      demand.input.source.agentGeneration,
    ),
    eq(piStableContextHeads.userGeneration, demand.input.source.userGeneration),
    demand.leaseId
      ? and(
          eq(piStableContextHeads.status, "running"),
          eq(piStableContextHeads.leaseId, demand.leaseId),
        )
      : inArray(piStableContextHeads.status, [
          "pending",
          "failed",
          "unindexable",
        ]),
  );
  return await db.transaction(async (tx) => {
    // Owner authority and canonical Agent first, then resource parents, then
    // the head. This matches source mutation order and prevents Agent/head or
    // Storage/head lock cycles.
    if (!(await lockStableContextOwnerAuthority(tx, demand.input.owner))) {
      return false;
    }
    const resources = projectionResources(projection);
    const storageIds = [
      ...new Set(
        resources.map((resource) => {
          return resource.storageId;
        }),
      ),
    ].sort();
    const versionIds = [
      ...new Set(
        resources.map((resource) => {
          return resource.storageVersionId;
        }),
      ),
    ].sort();
    if (storageIds.length > 0) {
      await tx
        .select({ id: storages.id })
        .from(storages)
        .where(inArray(storages.id, storageIds))
        .orderBy(asc(storages.id))
        .for("key share");
    }
    if (versionIds.length > 0) {
      await tx
        .select({ id: storageVersions.id })
        .from(storageVersions)
        .where(inArray(storageVersions.id, versionIds))
        .orderBy(asc(storageVersions.id))
        .for("key share");
    }
    await afterResourceLock?.(tx);
    const [head] = await tx
      .select({ id: piStableContextHeads.id })
      .from(piStableContextHeads)
      .where(condition)
      .for("update")
      .limit(1);
    if (!head) {
      return false;
    }
    await tx
      .insert(piStableContextArtifacts)
      .values({
        digest: artifactDigest,
        orgId: projection.owner.orgId,
        userId: projection.owner.userId,
        agentId: projection.owner.agentId,
        projection,
      })
      .onConflictDoUpdate({
        target: piStableContextArtifacts.digest,
        // Exact digest means exact immutable projection identity. A no-op
        // update deliberately retains the artifact row lock through head
        // attachment so GC cannot delete a reused artifact in between.
        set: { digest: artifactDigest },
      });
    if (resources.length > 0) {
      await tx
        .insert(piStableContextArtifactResources)
        .values(
          resources.map((resource) => {
            return { artifactDigest, ...resource };
          }),
        )
        .onConflictDoNothing();
    }
    await afterArtifactLock?.(tx);
    const [published] = await tx
      .update(piStableContextHeads)
      .set({
        status: "ready",
        artifactDigest,
        validityHorizon: validityHorizon(projection.source),
        leaseId: null,
        leaseExpiresAt: null,
        lastErrorClass: null,
        updatedAt: nowDate(),
      })
      .where(condition)
      .returning({ id: piStableContextHeads.id });
    return published !== undefined;
  });
}

function indexedProjection(
  input: PiStableContextBuildInput,
  indexes: Awaited<ReturnType<typeof readPiResourceVersionIndexes>>["indexes"],
): PiStableContextProjection {
  const mounts = piResourceDiscoveryMounts(
    input.storageMounts.map(storageMountForComposer),
  );
  const projections = mounts.map((mount) => {
    if (mount.empty) {
      return null;
    }
    const indexed = indexes.get(mount.versionId);
    // The source's gzip length is not part of the logical Storage identity.
    // A captured mount and its ready index can describe different encodings.
    if (!indexed || indexed.storageId !== mount.storageId) {
      throw new Error("Stable-context resource index identity changed");
    }
    return indexed.projection;
  });
  const snapshot = buildPiResourceSnapshotFromIndexes(mounts, projections);
  if (snapshot.schemaVersion !== 1) {
    throw new Error(
      "Stable-context resource snapshot unexpectedly bound memory",
    );
  }
  return piStableContextProjectionFromInput(input, snapshot);
}

function canonicalSnapshotMatchesDemand(
  args: PreparePiStableContextArgs,
  generations: SourceGenerations,
  demand: StableContextDemand,
): boolean {
  const { prompt: _prompt, semantic: _semantic, ...identity } = demand.input;
  return isDeepStrictEqual(buildInputIdentity(args, generations), identity);
}

async function publishCanonicalRepair(
  db: Db,
  demand: StableContextDemand,
  snapshot: PiResourceSnapshot,
): Promise<boolean> {
  return await publishProjection(
    db,
    demand,
    piStableContextProjectionFromInput(
      demand.input,
      baseResourceSnapshot(snapshot),
    ),
  );
}

export function bindPiStableContextProjection(
  projection: PiStableContextProjection,
  memoryRecall: PiMemoryRecallSelection | undefined,
): { readonly digest: string; readonly snapshot: PiResourceSnapshot } {
  const mounts = piResourceDiscoveryMounts(
    projection.storageMounts.map(storageMountForComposer),
  );
  return {
    digest: piResourceSnapshotDigest(mounts, memoryRecall),
    snapshot: bindMemoryRecall(projection.resourceSnapshot, memoryRecall),
  };
}

function prepareCanonical(
  args: PreparePiStableContextArgs,
  signal?: AbortSignal,
): Computed<
  Promise<{ readonly digest: string; readonly snapshot: PiResourceSnapshot }>
> {
  return preparePiResourceSnapshot(
    {
      db: args.db,
      mounts: args.mounts,
      ...(args.memoryRecall ? { memoryRecall: args.memoryRecall } : {}),
      ...(args.runId ? { runId: args.runId } : {}),
    },
    signal,
  );
}

export function preparePiStableContext(
  args: PreparePiStableContextArgs,
  signal?: AbortSignal,
): Computed<Promise<PreparedPiStableContext>> {
  return computed(async (get): Promise<PreparedPiStableContext> => {
    const startedAt = performance.now();
    if (!args.eligible) {
      const canonical = await get(prepareCanonical(args, signal));
      return { ...canonical, prompt: args.buildPrompt(), kind: "dynamic" };
    }
    const ready = await readReadyProjection(args);
    signal?.throwIfAborted();
    if (ready) {
      const result = bindPiStableContextProjection(
        ready.projection,
        args.memoryRecall,
      );
      if (args.runId) {
        recordSandboxOperation({
          sandboxType: "runner",
          actionType: "pi_stable_context_prepare",
          runId: args.runId,
          success: true,
          durationMs: performance.now() - startedAt,
          dimensions: { projection_state: "ready" },
        });
      }
      return { ...result, prompt: ready.projection.prompt, kind: "ready" };
    }

    await args.beforeSourceGenerationInitialization?.();
    signal?.throwIfAborted();
    const generations = await ensureSourceGenerations(args.db, args.owner);
    signal?.throwIfAborted();
    if (!generations) {
      const canonical = await get(prepareCanonical(args, signal));
      return { ...canonical, prompt: args.buildPrompt(), kind: "missing" };
    }
    if (!generations.ready) {
      const canonical = await get(prepareCanonical(args, signal));
      return {
        ...canonical,
        prompt: args.buildPrompt(),
        kind: "source_pending",
      };
    }
    await args.beforeDemandRegistration?.();
    signal?.throwIfAborted();
    const demand = await registerDemand(args, generations);
    signal?.throwIfAborted();
    const canonical = await get(prepareCanonical(args, signal));
    signal?.throwIfAborted();
    const published =
      demand === null ||
      !canonicalSnapshotMatchesDemand(args, generations, demand)
        ? false
        : await publishCanonicalRepair(args.db, demand, canonical.snapshot);
    signal?.throwIfAborted();
    if (args.runId) {
      recordSandboxOperation({
        sandboxType: "runner",
        actionType: "pi_stable_context_prepare",
        runId: args.runId,
        success: true,
        durationMs: performance.now() - startedAt,
        dimensions: {
          projection_state: published ? "missing_repaired" : "stale_repair",
        },
      });
    }
    return { ...canonical, prompt: args.buildPrompt(), kind: "missing" };
  });
}

async function claimStableContextWork(
  db: Db,
  signal: AbortSignal,
  scope?: PiStableContextWorkScope,
): Promise<readonly ClaimedStableContextWork[]> {
  const currentTime = nowDate();
  const leaseExpiresAt = new Date(
    currentTime.getTime() + PI_STABLE_CONTEXT_LEASE_MS,
  );
  return await db.transaction(async (tx) => {
    const rows = await tx
      .select({
        headId: piStableContextHeads.id,
        generation: piStableContextHeads.generation,
        input: piStableContextHeads.input,
        inputDigest: piStableContextHeads.inputDigest,
        attemptCount: piStableContextHeads.attemptCount,
      })
      .from(piStableContextHeads)
      .where(
        and(
          scope ? inArray(piStableContextHeads.id, scope.headIds) : undefined,
          lte(piStableContextHeads.availableAt, currentTime),
          or(
            and(
              inArray(piStableContextHeads.status, ["pending", "failed"]),
              lt(
                piStableContextHeads.attemptCount,
                PI_STABLE_CONTEXT_MAX_ATTEMPTS,
              ),
            ),
            and(
              eq(piStableContextHeads.status, "running"),
              lte(piStableContextHeads.leaseExpiresAt, currentTime),
            ),
          ),
        ),
      )
      .orderBy(
        asc(piStableContextHeads.availableAt),
        asc(piStableContextHeads.id),
      )
      .limit(PI_STABLE_CONTEXT_WORK_LIMIT)
      .for("update", { skipLocked: true });
    const claimed: ClaimedStableContextWork[] = [];
    for (const row of rows) {
      if (row.attemptCount >= PI_STABLE_CONTEXT_MAX_ATTEMPTS) {
        await tx
          .update(piStableContextHeads)
          .set({
            status: "failed",
            leaseId: null,
            leaseExpiresAt: null,
            lastErrorClass: "lease_expired_exhausted",
            updatedAt: currentTime,
          })
          .where(
            and(
              eq(piStableContextHeads.id, row.headId),
              eq(piStableContextHeads.generation, row.generation),
              eq(piStableContextHeads.status, "running"),
              lte(piStableContextHeads.leaseExpiresAt, currentTime),
            ),
          );
        continue;
      }
      if (!row.input || !row.inputDigest) {
        continue;
      }
      if (
        !hasImmutablePiCatalogSource(
          row.input.source,
          connectorCatalogExecutableCapabilityState().digest,
        )
      ) {
        await tx
          .update(piStableContextHeads)
          .set({
            status: "missing",
            input: null,
            inputDigest: null,
            artifactDigest: null,
            leaseId: null,
            leaseExpiresAt: null,
            lastErrorClass: null,
            updatedAt: currentTime,
          })
          .where(eq(piStableContextHeads.id, row.headId));
        continue;
      }
      const leaseId = randomUUID();
      const [updated] = await tx
        .update(piStableContextHeads)
        .set({
          status: "running",
          leaseId,
          leaseExpiresAt,
          attemptCount: row.attemptCount + 1,
          updatedAt: currentTime,
        })
        .where(
          and(
            eq(piStableContextHeads.id, row.headId),
            eq(piStableContextHeads.generation, row.generation),
          ),
        )
        .returning({ id: piStableContextHeads.id });
      if (updated) {
        claimed.push({
          ...row,
          input: row.input,
          inputDigest: row.inputDigest,
          leaseId,
          attemptCount: row.attemptCount + 1,
        });
      }
    }
    signal.throwIfAborted();
    return claimed;
  });
}

async function releaseWork(
  db: Db,
  work: ClaimedStableContextWork,
  status: "pending" | "unindexable" | "failed",
  errorClass: string | null,
): Promise<boolean> {
  const [released] = await db
    .update(piStableContextHeads)
    .set({
      status,
      leaseId: null,
      leaseExpiresAt: null,
      artifactDigest: null,
      availableAt: new Date(now() + PI_STABLE_CONTEXT_RETRY_MS),
      lastErrorClass: errorClass,
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(piStableContextHeads.id, work.headId),
        eq(piStableContextHeads.generation, work.generation),
        eq(piStableContextHeads.status, "running"),
        eq(piStableContextHeads.leaseId, work.leaseId),
      ),
    )
    .returning({ id: piStableContextHeads.id });
  return released !== undefined;
}

function errorClass(error: unknown): string {
  return error instanceof Error
    ? error.constructor.name.slice(0, 128)
    : "unknown";
}

interface StableContextWorkHooks {
  readonly beforePublish?: () => Promise<void>;
  readonly afterResourceLock?: (tx: Tx) => Promise<void>;
  readonly afterArtifactLock?: (tx: Tx) => Promise<void>;
}

async function buildStableContextWorkItem(
  db: Db,
  work: ClaimedStableContextWork,
  signal: AbortSignal,
  hooks?: StableContextWorkHooks,
): Promise<keyof Omit<StableContextWorkResult, "claimed" | "failed">> {
  const mounts = piResourceDiscoveryMounts(
    work.input.storageMounts.map(storageMountForComposer),
  );
  const indexed = await readPiResourceVersionIndexes(
    db,
    mounts.flatMap((mount) => {
      return mount.empty ? [] : [mount.versionId];
    }),
    signal,
  );
  if (indexed.misses.unindexable > 0) {
    return (await releaseWork(db, work, "unindexable", "resource_unindexable"))
      ? "unindexable"
      : "stale";
  }
  if (
    indexed.misses.pending > 0 ||
    indexed.misses.running > 0 ||
    indexed.misses.missing > 0
  ) {
    return (await releaseWork(db, work, "pending", "resource_pending"))
      ? "pending"
      : "stale";
  }
  const projection = indexedProjection(work.input, indexed.indexes);
  await hooks?.beforePublish?.();
  signal.throwIfAborted();
  return (await publishProjection(
    db,
    work,
    projection,
    hooks?.afterResourceLock,
    hooks?.afterArtifactLock,
  ))
    ? "ready"
    : "stale";
}

async function executeStableContextWorkItem(
  db: Db,
  work: ClaimedStableContextWork,
  signal: AbortSignal,
  hooks?: StableContextWorkHooks,
): Promise<keyof Omit<StableContextWorkResult, "claimed">> {
  const built = await settle(
    buildStableContextWorkItem(db, work, signal, hooks),
  );
  signal.throwIfAborted();
  if (built.ok) {
    return built.value;
  }
  const terminal =
    built.error instanceof UnsupportedPiResourceError
      ? "unindexable"
      : "failed";
  return (await releaseWork(db, work, terminal, errorClass(built.error)))
    ? terminal
    : "stale";
}

/** Bounded lease worker shared by cron and targeted test fixtures. */
export async function executePiStableContextWork(
  db: Db,
  signal: AbortSignal,
  hooks?: StableContextWorkHooks & {
    readonly scope?: PiStableContextWorkScope;
  },
): Promise<StableContextWorkResult> {
  const work = await claimStableContextWork(db, signal, hooks?.scope);
  const result: StableContextWorkResult = {
    claimed: work.length,
    ready: 0,
    pending: 0,
    unindexable: 0,
    failed: 0,
    stale: 0,
  };
  for (const item of work) {
    signal.throwIfAborted();
    const outcome = await executeStableContextWorkItem(db, item, signal, hooks);
    result[outcome]++;
  }
  return result;
}

interface StableContextSourceSnapshot {
  readonly agentIdentity: string;
  readonly promptInputs: PiStableContextPromptInputs;
  readonly connectorScope: PiStableContextSemanticInput["connectorScope"];
  readonly permissionPolicies: ReturnType<
    typeof permissionGrantsToFirewallPolicies
  >;
  readonly permissionValidityHorizon: string | null;
  readonly catalogSelection:
    | { readonly kind: "empty" }
    | {
        readonly kind: "scoped";
        readonly selection: ImmutableConnectorRuntimeSelection;
      };
}

interface DesiredDynamicMount {
  readonly kind: "custom_connector" | "injected";
  readonly orgId: string;
  readonly storageName: string;
  readonly versionId: string | undefined;
  readonly expectedStorageId?: string;
  readonly mountPath: string;
}

interface ResolvedDynamicMount {
  readonly desired: DesiredDynamicMount;
  readonly storage: PiStableContextStorageMount;
  readonly persisted: PersistedStorageMount;
}

function featurePromptInputs(
  previous: PiStableContextPromptInputs,
  featureContext: FeatureSwitchContext,
): PiStableContextPromptInputs {
  return buildAgentToolsPromptInputs({
    featureSwitchContext: featureContext,
    triggerSource: previous.triggerSource,
    cloudBrowserEnabled: previous.cloudBrowserEnabled,
  });
}

function customConnectorMounts(
  snapshot: StableContextSourceSnapshot,
  orgId: string,
): readonly DesiredDynamicMount[] {
  return snapshot.connectorScope.customConnectorDefinitions.flatMap(
    (definition) => {
      if (
        !customConnectorDefinitionHasStableSkill(
          definition,
          snapshot.promptInputs,
        )
      ) {
        return [];
      }
      return [
        {
          kind: "custom_connector" as const,
          orgId,
          storageName: getCustomConnectorSkillStorageName(
            definition.customConnectorId,
          ),
          versionId: definition.skillStorageVersionId,
          mountPath: `${PI_SKILLS_ROOT}/${getCustomConnectorSkillName(
            definition.connectorSlug,
            definition.customConnectorId,
          )}`,
        },
      ];
    },
  );
}

function builtinConnectorMounts(
  snapshot: StableContextSourceSnapshot,
): readonly DesiredDynamicMount[] | null {
  if (snapshot.catalogSelection.kind === "empty") {
    return [];
  }
  const selection = snapshot.catalogSelection.selection;
  const desired: DesiredDynamicMount[] = [];
  for (const slug of snapshot.connectorScope.allowedConnectorSlugs) {
    const connector = selection.connectors.get(slug);
    if (!connector) {
      return null;
    }
    if (connector.skill.kind !== "none") {
      desired.push({
        kind: "injected",
        orgId: SYSTEM_ORG_ID,
        storageName: connector.skill.storageName,
        versionId: connector.skill.versionId,
        mountPath: `${PI_SKILLS_ROOT}/${slug}`,
      });
    }
  }
  return desired;
}

function dynamicStorageIdentities(
  semantic: PiStableContextSemanticInput,
  orgId: string,
): ReadonlySet<string> {
  const identities = new Set<string>();
  const add = (storageOrgId: string, name: string) => {
    identities.add(`${storageOrgId}\0${name}`);
  };
  for (const definition of semantic.connectorScope.customConnectorDefinitions) {
    add(
      orgId,
      getCustomConnectorSkillStorageName(definition.customConnectorId),
    );
  }
  for (const workflow of semantic.connectorScope.workflows) {
    if (workflow.officialDefinitionName === null) {
      add(orgId, getCustomSkillStorageName(workflow.workflowId));
    } else {
      add(
        SYSTEM_ORG_ID,
        getOfficialWorkflowDefinitionStorageName(
          workflow.officialDefinitionName,
        ),
      );
    }
  }
  return identities;
}

function mergeDynamicMounts<
  T extends {
    readonly orgId: string;
    readonly name: string;
    readonly mountPath: string;
  },
>(args: {
  readonly current: readonly T[];
  readonly resolved: readonly ResolvedDynamicMount[];
  readonly previousSemantic: PiStableContextSemanticInput;
  readonly nextSemantic: PiStableContextSemanticInput;
  readonly ownerOrgId: string;
  readonly select: (mount: ResolvedDynamicMount) => T;
}): readonly T[] {
  const previous = dynamicStorageIdentities(
    args.previousSemantic,
    args.ownerOrgId,
  );
  const next = dynamicStorageIdentities(args.nextSemantic, args.ownerOrgId);
  const desired = new Set(
    args.resolved.map((mount) => {
      return `${mount.storage.orgId}\0${mount.storage.name}`;
    }),
  );
  const isDynamic = (mount: T) => {
    const identity = `${mount.orgId}\0${mount.name}`;
    return (
      previous.has(identity) ||
      next.has(identity) ||
      desired.has(identity) ||
      (mount.orgId === SYSTEM_ORG_ID &&
        mount.name.startsWith("connector-skill@"))
    );
  };
  const firstDynamicIndex = args.current.findIndex(isDynamic);
  const base = args.current.filter((mount) => {
    return !isDynamic(mount);
  });
  const custom = args.resolved
    .filter((mount) => {
      return mount.desired.kind === "custom_connector";
    })
    .map(args.select);
  const injected = args.resolved
    .filter((mount) => {
      return mount.desired.kind === "injected";
    })
    .map(args.select);
  const firstSkillIndex = base.findIndex((mount) => {
    return mount.mountPath.startsWith(`${PI_SKILLS_ROOT}/`);
  });
  if (firstSkillIndex === -1) {
    const insertion =
      firstDynamicIndex === -1 ? base.length : firstDynamicIndex;
    return [
      ...base.slice(0, insertion),
      ...custom,
      ...injected,
      ...base.slice(insertion),
    ];
  }
  const withCustom = [
    ...base.slice(0, firstSkillIndex),
    ...custom,
    ...base.slice(firstSkillIndex),
  ];
  let lastSkillIndex = -1;
  for (let index = 0; index < withCustom.length; index += 1) {
    if (withCustom[index]?.mountPath.startsWith(`${PI_SKILLS_ROOT}/`)) {
      lastSkillIndex = index;
    }
  }
  return [
    ...withCustom.slice(0, lastSkillIndex + 1),
    ...injected,
    ...withCustom.slice(lastSkillIndex + 1),
  ];
}

/**
 * Rebuilds every mutable source component from one post-write DB snapshot.
 * The returned value is immutable worker input; a missing referenced artifact
 * leaves the head missing instead of publishing a mixed generation.
 */

class PiCatalogDependencyDiscovered extends Error {}

function recapturePiStableContextInput(
  input: PiStableContextBuildInput & {
    readonly semantic: PiStableContextSemanticInput;
  },
  snapshot: StableContextSourceSnapshot,
  latestInstructions: {
    readonly storageMounts: readonly PiStableContextStorageMount[];
    readonly persistedStorageMounts: readonly PersistedStorageMount[];
  },
  resolved: readonly ResolvedDynamicMount[],
): PiStableContextBuildInput {
  const semantic: PiStableContextSemanticInput = {
    promptInputs: snapshot.promptInputs,
    connectorScope: snapshot.connectorScope,
  };
  const permissionDigest = piStableContextVariantDigest(
    snapshot.permissionPolicies ?? null,
  );
  return {
    ...input,
    prompt: {
      ...input.prompt,
      agentIdentity: snapshot.agentIdentity,
      tools: buildAgentToolsPrompt(snapshot.promptInputs),
    },
    semantic,
    source: {
      ...input.source,
      catalog:
        snapshot.catalogSelection.kind === "scoped"
          ? snapshot.catalogSelection.selection.catalogIdentity
          : null,
      agentIdentityDigest: piStableContextVariantDigest(snapshot.agentIdentity),
      featurePromptDigest: piStableContextVariantDigest(snapshot.promptInputs),
      permissionDigest,
      connectorScopeDigest: piStableContextVariantDigest(
        snapshot.connectorScope,
      ),
      validityHorizon: snapshot.permissionValidityHorizon,
    },
    storageMounts: normalizeMountOverlay(
      mergeDynamicMounts({
        current: latestInstructions.storageMounts,
        resolved,
        previousSemantic: input.semantic,
        nextSemantic: semantic,
        ownerOrgId: input.owner.orgId,
        select(mount) {
          return mount.storage;
        },
      }),
    ),
    persistedStorageMounts: normalizeMountOverlay(
      mergeDynamicMounts({
        current: latestInstructions.persistedStorageMounts,
        resolved,
        previousSemantic: input.semantic,
        nextSemantic: semantic,
        ownerOrgId: input.owner.orgId,
        select(mount) {
          return mount.persisted;
        },
      }),
    ),
  };
}

function workflowMounts(
  snapshot: StableContextSourceSnapshot,
  orgId: string,
  catalog: ReturnType<typeof acceptedCatalogFromRow>,
): readonly DesiredDynamicMount[] | null {
  const desired: DesiredDynamicMount[] = [];
  for (const workflow of snapshot.connectorScope.workflows) {
    if (workflow.officialDefinitionName === null) {
      desired.push({
        kind: "injected",
        orgId,
        storageName: getCustomSkillStorageName(workflow.workflowId),
        versionId: undefined,
        mountPath: `${PI_SKILLS_ROOT}/${workflow.name}`,
      });
      continue;
    }
    const definition = catalog?.payload.definitions.find((candidate) => {
      return candidate.name === workflow.officialDefinitionName;
    });
    if (!definition) {
      return null;
    }
    desired.push({
      kind: "injected",
      orgId: SYSTEM_ORG_ID,
      storageName: definition.artifact.storageName,
      versionId: definition.artifact.storageVersion,
      expectedStorageId: definition.artifact.storageId,
      mountPath: `${PI_SKILLS_ROOT}/${workflow.name}`,
    });
  }
  return desired;
}

function piDemandValues(
  input: PiStableContextBuildInput,
  variantDigest: string,
  inputDigest: string,
  at: Date,
) {
  return {
    orgId: input.owner.orgId,
    userId: input.owner.userId,
    agentId: input.owner.agentId,
    variantDigest: variantDigest,
    generation: 1,
    agentGeneration: input.source.agentGeneration,
    userGeneration: input.source.userGeneration,
    status: "pending" as const,
    input,
    inputDigest,
    artifactDigest: null,
    validityHorizon: validityHorizon(input.source),
    leaseId: null,
    leaseExpiresAt: null,
    availableAt: at,
    attemptCount: 0,
    lastErrorClass: null,
    updatedAt: at,
  };
}

type PiSourceFacts = z.infer<typeof piSourceFactsReceiptSchema>["facts"];
function piCatalogCaptureColumns() {
  return {
    schemaVersion: connectorCatalog.schemaVersion,
    hash: connectorCatalog.hash,
    header: connectorCatalog.catalogHeader,
    entrySlugs: connectorCatalog.entrySlugs,
  };
}
function expectsPiCatalog(input: PiStableContextBuildInput): boolean {
  return (
    input.source.catalog !== null ||
    Boolean(
      input.semantic &&
      (input.semantic.connectorScope.allowedConnectorSlugs.length ||
        input.semantic.connectorScope.allowedCustomConnectorIds.length),
    )
  );
}
function piHeadOwnerCondition(owner: PiStableContextOwner, variant: string) {
  const condition = and(
    eq(piStableContextHeads.orgId, owner.orgId),
    eq(piStableContextHeads.userId, owner.userId),
    eq(piStableContextHeads.agentId, owner.agentId),
    eq(piStableContextHeads.variantDigest, variant),
  );
  if (!condition) {
    throw new Error("Stable-context head condition is empty");
  }
  return condition;
}
function piMetadataSlugs(facts: PiSourceFacts) {
  return uniqueSortedConnectorSlugs(
    facts.custom.flatMap((row) => {
      const slug =
        row.permissionBundleRef === null
          ? null
          : customConnectorPermissionBundleDependencySlug(
              row.permissionBundleRef,
            );
      return slug ? [slug] : [];
    }),
  );
}
function piCatalogSelection(
  captured: ImmutableConnectorCatalogCapture | undefined,
  dependent: boolean,
  slugs: readonly ConnectorSlug[],
  metadata: readonly ConnectorSlug[],
  entries: readonly ImmutableConnectorCatalogEntry[],
): StableContextSourceSnapshot["catalogSelection"] {
  if (!dependent) {
    return { kind: "empty" };
  }
  if (!captured) {
    throw new PiCatalogDependencyDiscovered();
  }
  return {
    kind: "scoped",
    selection: materializeImmutableConnectorRuntimeSelection({
      capturedCatalog: captured,
      entries,
      requestedConnectorSlugs: slugs,
      metadataConnectorSlugs: metadata,
      capability: connectorCatalogExecutableCapabilityState(),
    }),
  };
}
async function piSnapshotFromFacts(
  input: PiStableContextBuildInput,
  facts: PiSourceFacts,
  scope: ReturnType<typeof agentConnectorScopeFromRows>,
  catalogSelection: StableContextSourceSnapshot["catalogSelection"],
): Promise<StableContextSourceSnapshot> {
  if (!input.semantic) {
    throw new Error("Stable-context recapture requires semantic input");
  }
  const stored = permissionGrantsToFirewallPolicies(facts.grants);
  const permissionPolicies =
    catalogSelection.kind === "empty"
      ? stored
      : await expandConnectorServerFirewallPolicies({
          catalog: catalogSelection.selection.serverFirewalls,
          stored,
          connectorSlugs: [...scope.allowedConnectorSlugs],
        });
  const horizons = facts.grants.flatMap((grant) => {
    return grant.expiresAt ? [grant.expiresAt.getTime()] : [];
  });
  return {
    agentIdentity: buildAgentIdentityPrompt(facts.agent) ?? "",
    promptInputs: featurePromptInputs(input.semantic.promptInputs, {
      orgId: input.owner.orgId,
      userId: input.owner.userId,
      email: facts.email ?? undefined,
      overrides: userFeatureSwitchOverridesFromRows(
        facts.features,
        input.owner.userId,
      ),
    }),
    connectorScope: {
      ...scope,
      workflows: workflowsForRunFromRows(facts.workflows, input.owner.userId),
    },
    permissionPolicies,
    permissionValidityHorizon: horizons.length
      ? new Date(Math.min(...horizons)).toISOString()
      : null,
    catalogSelection,
  };
}
function piDesiredMounts(
  snapshot: StableContextSourceSnapshot,
  orgId: string,
  official: PiSourceFacts["official"],
): readonly DesiredDynamicMount[] | null {
  const workflow = workflowMounts(
    snapshot,
    orgId,
    acceptedCatalogFromRow(official ?? undefined),
  );
  const builtin = builtinConnectorMounts(snapshot);
  return workflow && builtin
    ? [...customConnectorMounts(snapshot, orgId), ...builtin, ...workflow]
    : null;
}
function piStorageRequests(
  input: PiStableContextBuildInput,
  desired: readonly DesiredDynamicMount[],
): readonly PiStorageReadRequest[] {
  return [
    ...desired.map((mount) => {
      return {
        orgId: mount.orgId,
        userId: VOLUME_ORG_USER_ID,
        name: mount.storageName,
        ...(mount.expectedStorageId
          ? { storageId: mount.expectedStorageId }
          : {}),
        ...(mount.versionId ? { versionId: mount.versionId } : {}),
      };
    }),
    ...input.storageMounts.flatMap((mount) => {
      return mount.instructionsTargetFilename === undefined
        ? []
        : [
            {
              orgId: mount.orgId,
              userId: mount.userId,
              name: mount.name,
              storageId: mount.storageId,
            },
          ];
    }),
  ];
}
function piRecapturedInput(
  input: PiStableContextBuildInput,
  snapshot: StableContextSourceSnapshot,
  desired: readonly DesiredDynamicMount[],
  rows: readonly PiStorageFact[],
): PiStableContextBuildInput | null {
  if (!input.semantic) {
    throw new Error("Stable-context recapture requires semantic input");
  }
  const resolved: ResolvedDynamicMount[] = [];
  for (const mount of desired) {
    const row = rows.find((candidate) => {
      return (
        candidate.orgId === mount.orgId &&
        candidate.userId === VOLUME_ORG_USER_ID &&
        candidate.name === mount.storageName &&
        (!mount.expectedStorageId ||
          candidate.storageId === mount.expectedStorageId) &&
        (mount.versionId
          ? candidate.versionId === mount.versionId
          : candidate.isHead)
      );
    });
    if (!row) {
      return null;
    }
    resolved.push({
      desired: mount,
      storage: {
        orgId: row.orgId,
        userId: row.userId,
        name: row.name,
        storageId: row.storageId,
        versionId: row.versionId,
        mountPath: mount.mountPath,
        archiveSize: row.archiveSize,
        ...(row.fileCount === 0 ? { empty: true as const } : {}),
      },
      persisted: {
        orgId: row.orgId,
        userId: row.userId,
        name: row.name,
        storageId: row.storageId,
        version: row.versionId,
        mountPath: mount.mountPath,
      },
    });
  }
  const latest = new Map<string, PiStorageFact>();
  for (const mount of input.storageMounts) {
    if (mount.instructionsTargetFilename === undefined) {
      continue;
    }
    const row = rows.find((candidate) => {
      return (
        candidate.isHead &&
        candidate.storageId === mount.storageId &&
        candidate.orgId === mount.orgId &&
        candidate.userId === mount.userId &&
        candidate.name === mount.name
      );
    });
    if (!row) {
      return null;
    }
    latest.set(mount.storageId, row);
  }
  const storageMounts = input.storageMounts.map((mount) => {
    const row = latest.get(mount.storageId);
    if (!row || mount.instructionsTargetFilename === undefined) {
      return mount;
    }
    const { empty: _empty, ...previous } = mount;
    return {
      ...previous,
      versionId: row.versionId,
      archiveSize: row.archiveSize,
      ...(row.fileCount === 0 ? { empty: true as const } : {}),
    };
  });
  const persistedStorageMounts = input.persistedStorageMounts.map((mount) => {
    const row = latest.get(mount.storageId);
    return row ? { ...mount, version: row.versionId } : mount;
  });
  return recapturePiStableContextInput(
    { ...input, semantic: input.semantic },
    snapshot,
    { storageMounts, persistedStorageMounts },
    resolved,
  );
}

function piReadyBindingSourcesMatch(
  input: PiStableContextBuildInput | null,
  projection: PiStableContextProjection,
  capabilityDigest: string,
): boolean {
  if (
    !input ||
    !hasImmutablePiCatalogSource(input.source, capabilityDigest) ||
    !hasImmutablePiCatalogSource(projection.source, capabilityDigest)
  ) {
    return false;
  }
  const { prompt: _prompt, semantic: _semantic, ...identity } = input;
  return (
    piStableContextVariantDigest(identity) ===
    piStableContextVariantDigest(projectionInputIdentity(projection))
  );
}

function requirePiReceipt<T>(rows: readonly T[]): T {
  const [row] = rows;
  if (!row) {
    throw new Error("Stable-context required receipt is missing");
  }
  return row;
}
function requireExpectedPiCatalog(
  expected: boolean,
  current: ImmutableConnectorCatalogCapture | undefined,
): void {
  if (expected && !current) {
    throw new Error("Immutable connector catalog current is missing");
  }
}
function piCapturePlan(
  input: PiStableContextBuildInput,
  current: ImmutableConnectorCatalogCapture | undefined,
  facts: PiSourceFacts,
) {
  const scope = agentConnectorScopeFromRows({
    connectorRows: facts.builtin,
    customConnectorRows: facts.custom,
  });
  const metadata = piMetadataSlugs(facts);
  const dependent =
    scope.allowedConnectorSlugs.length > 0 ||
    scope.allowedCustomConnectorIds.length > 0;
  if (
    (dependent && !current) ||
    (!input.semantic && (dependent || input.source.catalog !== null))
  ) {
    throw new PiCatalogDependencyDiscovered();
  }
  return {
    current: dependent ? current : undefined,
    scope,
    metadata,
    dependent,
    slugs: [...scope.allowedConnectorSlugs, ...metadata],
  };
}
async function piPreparedRecapture(
  input: PiStableContextBuildInput,
  facts: PiSourceFacts,
  plan: ReturnType<typeof piCapturePlan>,
  entries: readonly ImmutableConnectorCatalogEntry[],
) {
  const selection = piCatalogSelection(
    plan.current,
    plan.dependent,
    plan.scope.allowedConnectorSlugs,
    plan.metadata,
    entries,
  );
  const snapshot = input.semantic
    ? await piSnapshotFromFacts(input, facts, plan.scope, selection)
    : null;
  const desired = snapshot
    ? piDesiredMounts(snapshot, input.owner.orgId, facts.official)
    : [];
  return desired ? { snapshot, desired } : null;
}
function piInputFromPrepared(
  input: PiStableContextBuildInput,
  prepared: NonNullable<Awaited<ReturnType<typeof piPreparedRecapture>>>,
  rows: readonly PiStorageFact[],
) {
  return prepared.snapshot
    ? piRecapturedInput(input, prepared.snapshot, prepared.desired, rows)
    : input;
}
function piDemandHeadColumns() {
  return {
    id: piStableContextHeads.id,
    generation: piStableContextHeads.generation,
    inputDigest: piStableContextHeads.inputDigest,
    status: piStableContextHeads.status,
    agentGeneration: piStableContextHeads.agentGeneration,
    userGeneration: piStableContextHeads.userGeneration,
  };
}
function piDemandIsUnchanged(
  existing: {
    readonly inputDigest: string | null;
    readonly status: string;
    readonly agentGeneration: number;
    readonly userGeneration: number;
  },
  digest: string,
  generations: SourceGenerations,
): boolean {
  return (
    existing.status === "pending" &&
    existing.inputDigest === digest &&
    existing.agentGeneration === generations.agentGeneration &&
    existing.userGeneration === generations.userGeneration
  );
}
