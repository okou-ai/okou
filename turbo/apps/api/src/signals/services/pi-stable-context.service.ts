import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  piResourceSnapshotSchema,
  type PiMemoryRecallSelection,
  type PiResourceSnapshot,
  type StoredStorageMountEntry,
} from "@okouai/api-contracts/contracts/runners";
import type {
  PiStableContextBuildInput,
  PiStableContextOwner,
  PiStableContextProjection,
  PiStableContextPromptProjection,
  PiStableContextSemanticInput,
  PiStableContextSourceVector,
  PiStableContextStorageMount,
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
import { lockCanonicalAgentMutation } from "./agent-mutation-lock.service";
import { PI_STABLE_CONTEXT_AGENT_SUBJECT } from "./pi-stable-context-generation.service";
import { admitPiStableContextSubjects } from "./pi-stable-context-erasure.service";
import { recapturePiStableContextInput } from "./pi-stable-context-recapture.service";

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
  const subjects = [
    { subjectKind: "user" as const, subjectId: owner.userId },
    { subjectKind: "organization" as const, subjectId: owner.orgId },
    {
      subjectKind: "user" as const,
      subjectId: owner.resourceOwner.userId,
    },
    {
      subjectKind: "organization" as const,
      subjectId: owner.resourceOwner.orgId,
    },
  ];
  const admitted = await admitPiStableContextSubjects(tx, [
    ...new Map(
      subjects.map((subject) => {
        return [
          `${subject.subjectKind}:${subject.subjectId}`,
          subject,
        ] as const;
      }),
    ).values(),
  ]);
  if (!admitted) {
    return false;
  }
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
  await lockCanonicalAgentMutation(tx, owner.agentId);
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
  return await args.db.transaction(async (tx) => {
    if (!(await lockStableContextOwnerAuthority(tx, args.owner))) {
      return null;
    }
    if (!(await lockMatchingReadyGenerations(tx, args.owner, generations))) {
      return null;
    }
    const recaptured = await recapturePiStableContextInput(
      tx,
      capturedInput,
      args.checkedAt,
    );
    if (!recaptured) {
      return null;
    }
    const input: PiStableContextBuildInput = {
      ...recaptured,
      source: {
        ...recaptured.source,
        agentGeneration: generations.agentGeneration,
        userGeneration: generations.userGeneration,
      },
    };
    const inputDigest = piStableContextInputDigest(input);
    const initialValues = {
      orgId: args.owner.orgId,
      userId: args.owner.userId,
      agentId: args.owner.agentId,
      variantDigest: args.variantDigest,
      generation: 1,
      agentGeneration: generations.agentGeneration,
      userGeneration: generations.userGeneration,
      status: "pending" as const,
      input,
      inputDigest,
      artifactDigest: null,
      validityHorizon: validityHorizon(input.source),
      leaseId: null,
      leaseExpiresAt: null,
      availableAt: nowDate(),
      attemptCount: 0,
      lastErrorClass: null,
      updatedAt: nowDate(),
    };
    // Insert-first makes the unique owner/variant row the serialization point.
    // A concurrent loser waits for the winner, then locks and reuses/advances it.
    const [inserted] = await tx
      .insert(piStableContextHeads)
      .values(initialValues)
      .onConflictDoNothing()
      .returning({ id: piStableContextHeads.id });
    if (inserted) {
      return {
        headId: inserted.id,
        generation: 1,
        input,
        inputDigest,
      };
    }
    const [existing] = await tx
      .select({
        id: piStableContextHeads.id,
        generation: piStableContextHeads.generation,
        inputDigest: piStableContextHeads.inputDigest,
        status: piStableContextHeads.status,
        agentGeneration: piStableContextHeads.agentGeneration,
        userGeneration: piStableContextHeads.userGeneration,
      })
      .from(piStableContextHeads)
      .where(
        and(
          eq(piStableContextHeads.orgId, args.owner.orgId),
          eq(piStableContextHeads.userId, args.owner.userId),
          eq(piStableContextHeads.agentId, args.owner.agentId),
          eq(piStableContextHeads.variantDigest, args.variantDigest),
        ),
      )
      .for("update")
      .limit(1);
    if (!existing) {
      throw new Error("Stable-context demand disappeared during registration");
    }
    const unchanged =
      existing.inputDigest === inputDigest &&
      existing.agentGeneration === generations.agentGeneration &&
      existing.userGeneration === generations.userGeneration;
    if (unchanged && existing.status === "pending") {
      return {
        headId: existing.id,
        generation: existing.generation,
        input,
        inputDigest,
      };
    }
    const nextGeneration = existing.generation + 1;
    const [head] = await tx
      .update(piStableContextHeads)
      .set({
        ...initialValues,
        generation: nextGeneration,
      })
      .where(eq(piStableContextHeads.id, existing.id))
      .returning({ id: piStableContextHeads.id });
    if (!head) {
      throw new Error("Stable-context demand publication returned no row");
    }
    return {
      headId: head.id,
      generation: nextGeneration,
      input,
      inputDigest,
    };
  });
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
    // Admission is first, then canonical Agent and resource parents, then the
    // head. This matches source mutation/erasure order and prevents both
    // post-erasure resurrection and Agent/head or Storage/head lock cycles.
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
    if (
      !indexed ||
      indexed.storageId !== mount.storageId ||
      indexed.archiveSize !== mount.archiveSize
    ) {
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
  return isDeepStrictEqual(
    buildInputIdentity(args, generations).storageMounts,
    demand.input.storageMounts,
  );
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
