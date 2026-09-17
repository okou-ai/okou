import { randomUUID } from "node:crypto";

import { PI_SKILLS_ROOT } from "@okouai/api-contracts/contracts/runners";
import { getCustomSkillStorageName } from "@okouai/core/storage-names";
import type { PiStableContextBuildInput } from "@okouai/db/jsonb-contracts/pi-stable-context";
import {
  piStableContextArtifactResources,
  piStableContextGenerations,
  piStableContextHeads,
  piStableContextPublications,
} from "@okouai/db/schema/pi-stable-context";
import {
  and,
  asc,
  eq,
  exists,
  inArray,
  isNotNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import {
  piStableContextInputDigest,
  piStableContextVariantDigest,
} from "./pi-stable-context-digest.service";
import { recapturePiStableContextInput } from "./pi-stable-context-recapture.service";

export const PI_STABLE_CONTEXT_AGENT_SUBJECT = "@agent";
export const PI_STABLE_CONTEXT_AGENT_INSTRUCTIONS_PUBLICATION_KEY =
  "agent-instructions";

export function piStableContextWorkflowPublicationKey(
  workflowId: string,
): string {
  return `workflow:${workflowId}`;
}

export function piStableContextWorkflowInvalidationOptions(args: {
  readonly kind: "upsert" | "delete";
  readonly workflow: {
    readonly workflowId: string;
    readonly name: string;
    readonly officialDefinitionName: string | null;
  };
}): PiStableContextInvalidationOptions {
  return {
    transformInput(input) {
      if (!input.semantic) {
        return null;
      }
      const previous = input.semantic.connectorScope.workflows;
      const matchingIndex = previous.findIndex((workflow) => {
        return workflow.workflowId === args.workflow.workflowId;
      });
      const workflows = previous.filter((workflow) => {
        return workflow.workflowId !== args.workflow.workflowId;
      });
      if (args.kind === "upsert") {
        workflows.splice(
          matchingIndex === -1 ? workflows.length : matchingIndex,
          0,
          args.workflow,
        );
      }
      const connectorScope = {
        ...input.semantic.connectorScope,
        workflows,
      };
      const storageName = getCustomSkillStorageName(args.workflow.workflowId);
      const mountPath = `${PI_SKILLS_ROOT}/${args.workflow.name}`;
      const keepMount = (mount: { readonly name: string }) => {
        return args.kind === "upsert" || mount.name !== storageName;
      };
      return {
        ...input,
        semantic: { ...input.semantic, connectorScope },
        source: {
          ...input.source,
          connectorScopeDigest: piStableContextVariantDigest(connectorScope),
        },
        storageMounts: input.storageMounts.filter(keepMount).map((mount) => {
          return mount.name === storageName ? { ...mount, mountPath } : mount;
        }),
        persistedStorageMounts: input.persistedStorageMounts
          .filter(keepMount)
          .map((mount) => {
            return mount.name === storageName ? { ...mount, mountPath } : mount;
          }),
      };
    },
  };
}

export interface PiStableContextScope {
  readonly orgId: string;
  readonly agentId: string;
  /** Omit for agent-wide identity, public workflow, or shared resource writes. */
  readonly userId?: string;
}

export interface PiStableContextPublicationFence {
  readonly scope: PiStableContextScope;
  readonly publicationKey: string;
  readonly generation: number;
  readonly token: string;
}

function subjectForScope(scope: PiStableContextScope): string {
  return scope.userId ?? PI_STABLE_CONTEXT_AGENT_SUBJECT;
}

function generationScopeCondition(scope: PiStableContextScope) {
  return and(
    eq(piStableContextGenerations.orgId, scope.orgId),
    eq(piStableContextGenerations.agentId, scope.agentId),
    eq(piStableContextGenerations.subject, subjectForScope(scope)),
  );
}

function publicationKeyCondition(
  scope: PiStableContextScope,
  publicationKey: string,
) {
  return and(
    eq(piStableContextPublications.orgId, scope.orgId),
    eq(piStableContextPublications.agentId, scope.agentId),
    eq(piStableContextPublications.subject, subjectForScope(scope)),
    eq(piStableContextPublications.publicationKey, publicationKey),
  );
}

function publicationScopeCondition(fence: PiStableContextPublicationFence) {
  return and(
    publicationKeyCondition(fence.scope, fence.publicationKey),
    eq(piStableContextPublications.generation, fence.generation),
    eq(piStableContextPublications.token, fence.token),
  );
}

function headScopeCondition(scope: PiStableContextScope) {
  const base = and(
    eq(piStableContextHeads.orgId, scope.orgId),
    eq(piStableContextHeads.agentId, scope.agentId),
  );
  return scope.userId
    ? and(base, eq(piStableContextHeads.userId, scope.userId))
    : base;
}

export interface PiStableContextInvalidationOptions {
  readonly transformInput?: (
    input: PiStableContextBuildInput,
  ) =>
    | PiStableContextBuildInput
    | null
    | Promise<PiStableContextBuildInput | null>;
}

async function invalidateKnownHeads(
  db: Db,
  scope: PiStableContextScope,
  options?: PiStableContextInvalidationOptions,
): Promise<void> {
  await invalidateHeadSet(db, headScopeCondition(scope), options);
}

async function advanceGeneration(
  db: Db,
  scope: PiStableContextScope,
  state: { readonly kind: "ready" } | { readonly kind: "pending" },
  options?: PiStableContextInvalidationOptions,
): Promise<number> {
  const updatedAt = nowDate();
  const subject = subjectForScope(scope);
  const [row] = await db
    .insert(piStableContextGenerations)
    .values({
      orgId: scope.orgId,
      agentId: scope.agentId,
      subject,
      publicationState: state.kind,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: [
        piStableContextGenerations.orgId,
        piStableContextGenerations.agentId,
        piStableContextGenerations.subject,
      ],
      set: {
        generation: sql`${piStableContextGenerations.generation} + 1`,
        // A single-stage write invalidates every head but must not expose a
        // scope while an independent multi-stage source is still publishing.
        publicationState:
          state.kind === "pending"
            ? "pending"
            : sql`${piStableContextGenerations.publicationState}`,
        updatedAt,
      },
    })
    .returning({ generation: piStableContextGenerations.generation });
  if (!row) {
    throw new Error("Stable-context generation advance returned no row");
  }
  await invalidateKnownHeads(db, scope, options);
  return row.generation;
}

/** Atomically invalidate known projections for a single-stage source write. */
export async function invalidatePiStableContext(
  db: Db,
  scope: PiStableContextScope,
  options?: PiStableContextInvalidationOptions,
): Promise<number> {
  return await advanceGeneration(db, scope, { kind: "ready" }, options);
}

async function invalidateHeadSet(
  db: Db,
  condition: ReturnType<typeof eq> | ReturnType<typeof and>,
  options?: PiStableContextInvalidationOptions,
): Promise<void> {
  const captured = await db
    .select({
      id: piStableContextHeads.id,
      generation: piStableContextHeads.generation,
      orgId: piStableContextHeads.orgId,
      userId: piStableContextHeads.userId,
      agentId: piStableContextHeads.agentId,
      input: piStableContextHeads.input,
    })
    .from(piStableContextHeads)
    .where(
      and(
        condition,
        isNotNull(piStableContextHeads.input),
        isNotNull(piStableContextHeads.inputDigest),
      ),
    )
    .orderBy(asc(piStableContextHeads.id))
    .limit(16)
    .for("update");
  const invalidatedAt = nowDate();
  await db
    .update(piStableContextHeads)
    .set({
      generation: sql`${piStableContextHeads.generation} + 1`,
      status: "missing",
      input: null,
      inputDigest: null,
      artifactDigest: null,
      validityHorizon: null,
      leaseId: null,
      leaseExpiresAt: null,
      availableAt: invalidatedAt,
      attemptCount: 0,
      lastErrorClass: null,
      updatedAt: invalidatedAt,
    })
    .where(condition);
  // Preserve at most one worker batch of exact captured variants as durable
  // write-time demand. Larger scopes remain bounded and recover canonically.
  for (const head of captured) {
    if (!head.input) {
      continue;
    }
    const subjects = [PI_STABLE_CONTEXT_AGENT_SUBJECT, head.userId];
    const generations = await db
      .select({
        subject: piStableContextGenerations.subject,
        generation: piStableContextGenerations.generation,
      })
      .from(piStableContextGenerations)
      .where(
        and(
          eq(piStableContextGenerations.orgId, head.orgId),
          eq(piStableContextGenerations.agentId, head.agentId),
          inArray(piStableContextGenerations.subject, subjects),
        ),
      );
    const bySubject = new Map(
      generations.map((generation) => {
        return [generation.subject, generation.generation] as const;
      }),
    );
    const agentGeneration = bySubject.get(PI_STABLE_CONTEXT_AGENT_SUBJECT);
    const userGeneration = bySubject.get(head.userId);
    if (agentGeneration === undefined || userGeneration === undefined) {
      continue;
    }
    const transformed = options?.transformInput
      ? await options.transformInput(head.input)
      : head.input;
    const recaptured = transformed
      ? await recapturePiStableContextInput(db, transformed, invalidatedAt)
      : null;
    if (!recaptured) {
      continue;
    }
    const input: PiStableContextBuildInput = {
      ...recaptured,
      source: {
        ...recaptured.source,
        agentGeneration,
        userGeneration,
      },
    };
    await db
      .update(piStableContextHeads)
      .set({
        generation: head.generation + 1,
        agentGeneration,
        userGeneration,
        status: "pending",
        input,
        inputDigest: piStableContextInputDigest(input),
        artifactDigest: null,
        validityHorizon: input.source.validityHorizon
          ? new Date(input.source.validityHorizon)
          : null,
        leaseId: null,
        leaseExpiresAt: null,
        availableAt: invalidatedAt,
        attemptCount: 0,
        lastErrorClass: null,
        updatedAt: invalidatedAt,
      })
      .where(
        and(
          eq(piStableContextHeads.id, head.id),
          eq(piStableContextHeads.generation, head.generation + 1),
        ),
      );
  }
}

function requireCondition(
  condition: SQL | undefined,
  description: string,
): SQL {
  if (!condition) {
    throw new Error(`Stable-context ${description} condition is empty`);
  }
  return condition;
}

async function advanceGenerationSet(db: Db, condition: SQL): Promise<void> {
  await db
    .select({
      orgId: piStableContextGenerations.orgId,
      agentId: piStableContextGenerations.agentId,
      subject: piStableContextGenerations.subject,
    })
    .from(piStableContextGenerations)
    .where(condition)
    .orderBy(
      asc(piStableContextGenerations.orgId),
      asc(piStableContextGenerations.agentId),
      asc(piStableContextGenerations.subject),
    )
    .for("update");
  await db
    .update(piStableContextGenerations)
    .set({
      generation: sql`${piStableContextGenerations.generation} + 1`,
      updatedAt: nowDate(),
    })
    .where(condition);
}

/** Bulk invalidation for a user-scoped feature/profile source writer. */
export async function invalidatePiStableContextsForUser(
  db: Db,
  args: { readonly orgId: string; readonly userId: string },
): Promise<void> {
  await advanceGenerationSet(
    db,
    requireCondition(
      and(
        eq(piStableContextGenerations.orgId, args.orgId),
        eq(piStableContextGenerations.subject, args.userId),
      ),
      "user generation",
    ),
  );
  await invalidateHeadSet(
    db,
    and(
      eq(piStableContextHeads.orgId, args.orgId),
      eq(piStableContextHeads.userId, args.userId),
    ),
  );
}

/** Bulk invalidation for an organization-wide catalog or feature writer. */
export async function invalidatePiStableContextsForOrg(
  db: Db,
  orgId: string,
): Promise<void> {
  await advanceGenerationSet(db, eq(piStableContextGenerations.orgId, orgId));
  await invalidateHeadSet(db, eq(piStableContextHeads.orgId, orgId));
}

/** Bulk invalidation for the shared official connector/workflow catalog. */
export async function invalidateAllPiStableContexts(db: Db): Promise<void> {
  await advanceGenerationSet(db, sql`TRUE`);
  await invalidateHeadSet(db, sql`TRUE`);
}

/** Test catalog sources own only heads captured under their exact source ID. */
export async function invalidatePiStableContextsForCatalogSource(
  db: Db,
  sourceId: string,
): Promise<void> {
  const headCondition = requireCondition(
    and(
      isNotNull(piStableContextHeads.input),
      sql`${piStableContextHeads.input} -> 'source' ->> 'catalogSourceId' = ${sourceId}`,
    ),
    "catalog head",
  );
  const owners = await db
    .selectDistinct({
      orgId: piStableContextHeads.orgId,
      userId: piStableContextHeads.userId,
      agentId: piStableContextHeads.agentId,
    })
    .from(piStableContextHeads)
    .where(headCondition)
    .orderBy(
      asc(piStableContextHeads.orgId),
      asc(piStableContextHeads.agentId),
      asc(piStableContextHeads.userId),
    );
  const scopes = owners.flatMap((owner) => {
    return [
      { orgId: owner.orgId, agentId: owner.agentId },
      {
        orgId: owner.orgId,
        agentId: owner.agentId,
        userId: owner.userId,
      },
    ];
  });
  if (scopes.length === 0) {
    return;
  }
  await lockPiStableContextGenerationScopes(db, scopes);
  await advanceGenerationSet(
    db,
    requireCondition(
      or(
        ...scopes.map((scope) => {
          return generationScopeCondition(scope);
        }),
      ),
      "catalog generation",
    ),
  );
  await invalidateHeadSet(db, headCondition);
}

/** Begin one keyed metadata-first publication. The scope stays pending until all keys settle. */
export async function beginPiStableContextPublication(
  db: Db,
  scope: PiStableContextScope,
  publicationKey: string,
  options?: PiStableContextInvalidationOptions,
): Promise<PiStableContextPublicationFence> {
  const token = randomUUID();
  return await db.transaction(async (tx) => {
    const generation = await advanceGeneration(
      tx,
      scope,
      { kind: "pending" },
      options,
    );
    const updatedAt = nowDate();
    await tx
      .insert(piStableContextPublications)
      .values({
        orgId: scope.orgId,
        agentId: scope.agentId,
        subject: subjectForScope(scope),
        publicationKey,
        generation,
        token,
        createdAt: updatedAt,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: [
          piStableContextPublications.orgId,
          piStableContextPublications.agentId,
          piStableContextPublications.subject,
          piStableContextPublications.publicationKey,
        ],
        set: { generation, token, createdAt: updatedAt, updatedAt },
      });
    return { scope, publicationKey, generation, token };
  });
}

function rebindStorageMount(
  mount: PiStableContextBuildInput["storageMounts"][number],
  resource: {
    readonly storageId: string;
    readonly versionId: string;
    readonly archiveSize: number;
    readonly fileCount: number;
  },
): PiStableContextBuildInput["storageMounts"][number] {
  if (mount.storageId !== resource.storageId) {
    return mount;
  }
  const { empty: _empty, ...canonical } = mount;
  return {
    ...canonical,
    versionId: resource.versionId,
    archiveSize: resource.archiveSize,
    ...(resource.fileCount === 0 ? { empty: true as const } : {}),
  };
}

/** Commit bounded demand for contexts that depend on an advanced Storage HEAD. */
export async function enqueuePiStableContextStorageDemands(
  db: Db,
  resource: {
    readonly storageId: string;
    readonly versionId: string;
    readonly archiveSize: number;
    readonly fileCount: number;
  },
): Promise<void> {
  const dependent = or(
    exists(
      db
        .select({ ordinal: piStableContextArtifactResources.ordinal })
        .from(piStableContextArtifactResources)
        .where(
          and(
            eq(
              piStableContextArtifactResources.artifactDigest,
              piStableContextHeads.artifactDigest,
            ),
            eq(piStableContextArtifactResources.storageId, resource.storageId),
          ),
        ),
    ),
    // Pending/running heads deliberately have no artifact binding. Their
    // immutable input remains the durable dependency index between successive
    // Storage commits, so A→B and independent multi-Storage writes coalesce.
    sql`${piStableContextHeads.input} @> ${JSON.stringify({
      storageMounts: [{ storageId: resource.storageId }],
    })}::jsonb`,
  );
  const heads = await db
    .select({
      id: piStableContextHeads.id,
      generation: piStableContextHeads.generation,
      input: piStableContextHeads.input,
    })
    .from(piStableContextHeads)
    .where(
      and(
        dependent,
        isNotNull(piStableContextHeads.input),
        isNotNull(piStableContextHeads.inputDigest),
      ),
    )
    .orderBy(asc(piStableContextHeads.id))
    .limit(16)
    .for("update");
  const availableAt = nowDate();
  await db
    .update(piStableContextHeads)
    .set({
      generation: sql`${piStableContextHeads.generation} + 1`,
      status: "missing",
      input: null,
      inputDigest: null,
      artifactDigest: null,
      validityHorizon: null,
      leaseId: null,
      leaseExpiresAt: null,
      availableAt,
      attemptCount: 0,
      lastErrorClass: null,
      updatedAt: availableAt,
    })
    .where(dependent);
  for (const head of heads) {
    if (!head.input) {
      continue;
    }
    let changed = false;
    const storageMounts = head.input.storageMounts.map((mount) => {
      if (mount.storageId !== resource.storageId) {
        return mount;
      }
      changed = true;
      return rebindStorageMount(mount, resource);
    });
    if (!changed) {
      continue;
    }
    const input: PiStableContextBuildInput = {
      ...head.input,
      storageMounts,
      persistedStorageMounts: head.input.persistedStorageMounts.map((mount) => {
        return mount.storageId === resource.storageId
          ? { ...mount, version: resource.versionId }
          : mount;
      }),
    };
    await db
      .update(piStableContextHeads)
      .set({
        generation: head.generation + 1,
        agentGeneration: input.source.agentGeneration,
        userGeneration: input.source.userGeneration,
        status: "pending",
        input,
        inputDigest: piStableContextInputDigest(input),
        artifactDigest: null,
        validityHorizon: input.source.validityHorizon
          ? new Date(input.source.validityHorizon)
          : null,
        leaseId: null,
        leaseExpiresAt: null,
        availableAt,
        attemptCount: 0,
        lastErrorClass: null,
        updatedAt: availableAt,
      })
      .where(
        and(
          eq(piStableContextHeads.id, head.id),
          eq(piStableContextHeads.generation, head.generation + 1),
        ),
      );
  }
}

/** Rebind captured demand to the exact Storage version committed by a source publisher. */
export async function refreshPiStableContextStorageDemands(
  db: Db,
  fence: PiStableContextPublicationFence,
  resource: {
    readonly storageId: string;
    readonly versionId: string;
    readonly archiveSize: number;
    readonly fileCount: number;
  },
): Promise<void> {
  const heads = await db
    .select({
      id: piStableContextHeads.id,
      generation: piStableContextHeads.generation,
      input: piStableContextHeads.input,
    })
    .from(piStableContextHeads)
    .where(
      and(
        headScopeCondition(fence.scope),
        isNotNull(piStableContextHeads.input),
        isNotNull(piStableContextHeads.inputDigest),
      ),
    )
    .orderBy(asc(piStableContextHeads.id))
    .limit(16)
    .for("update");
  const availableAt = nowDate();
  for (const head of heads) {
    if (!head.input) {
      continue;
    }
    let changed = false;
    const storageMounts = head.input.storageMounts.map((mount) => {
      if (mount.storageId !== resource.storageId) {
        return mount;
      }
      changed = true;
      return rebindStorageMount(mount, resource);
    });
    if (!changed) {
      continue;
    }
    const input: PiStableContextBuildInput = {
      ...head.input,
      storageMounts,
      persistedStorageMounts: head.input.persistedStorageMounts.map((mount) => {
        return mount.storageId === resource.storageId
          ? { ...mount, version: resource.versionId }
          : mount;
      }),
    };
    await db
      .update(piStableContextHeads)
      .set({
        generation: head.generation + 1,
        status: "pending",
        input,
        inputDigest: piStableContextInputDigest(input),
        artifactDigest: null,
        validityHorizon: input.source.validityHorizon
          ? new Date(input.source.validityHorizon)
          : null,
        leaseId: null,
        leaseExpiresAt: null,
        availableAt,
        attemptCount: 0,
        lastErrorClass: null,
        updatedAt: availableAt,
      })
      .where(
        and(
          eq(piStableContextHeads.id, head.id),
          eq(piStableContextHeads.generation, head.generation),
        ),
      );
  }
}

async function updatePublicationReadiness(
  db: Db,
  scope: PiStableContextScope,
): Promise<void> {
  const [remaining] = await db
    .select({ token: piStableContextPublications.token })
    .from(piStableContextPublications)
    .where(
      and(
        eq(piStableContextPublications.orgId, scope.orgId),
        eq(piStableContextPublications.agentId, scope.agentId),
        eq(piStableContextPublications.subject, subjectForScope(scope)),
      ),
    )
    .limit(1);
  await db
    .update(piStableContextGenerations)
    .set({
      publicationState: remaining ? "pending" : "ready",
      updatedAt: nowDate(),
    })
    .where(generationScopeCondition(scope));
}

/** Retire a deleted source's abandoned publication without exposing mixed state. */
export async function retirePiStableContextPublication(
  db: Db,
  scope: PiStableContextScope,
  publicationKey: string,
): Promise<boolean> {
  const [generation] = await db
    .select({ generation: piStableContextGenerations.generation })
    .from(piStableContextGenerations)
    .where(generationScopeCondition(scope))
    .for("update")
    .limit(1);
  if (!generation) {
    return false;
  }
  const [retired] = await db
    .delete(piStableContextPublications)
    .where(
      and(
        eq(piStableContextPublications.orgId, scope.orgId),
        eq(piStableContextPublications.agentId, scope.agentId),
        eq(piStableContextPublications.subject, subjectForScope(scope)),
        eq(piStableContextPublications.publicationKey, publicationKey),
      ),
    )
    .returning({ token: piStableContextPublications.token });
  await updatePublicationReadiness(db, scope);
  return retired !== undefined;
}

/**
 * Complete one exact source publication. Current readiness is restored only
 * after every independent publication key in the scope has completed.
 */
export async function completePiStableContextPublication(
  db: Db,
  fence: PiStableContextPublicationFence,
): Promise<boolean> {
  const [generation] = await db
    .select({ generation: piStableContextGenerations.generation })
    .from(piStableContextGenerations)
    .where(generationScopeCondition(fence.scope))
    .for("update")
    .limit(1);
  if (!generation) {
    return false;
  }
  const [completed] = await db
    .delete(piStableContextPublications)
    .where(publicationScopeCondition(fence))
    .returning({ token: piStableContextPublications.token });
  if (!completed) {
    return false;
  }
  await updatePublicationReadiness(db, fence.scope);
  return true;
}

/**
 * Materialize and lock generation scopes in one global order. Multi-scope
 * writers must call this before inspecting publication keys so they never
 * retain a user generation while waiting for the shared Agent generation.
 */
export async function lockPiStableContextGenerationScopes(
  db: Db,
  scopes: readonly PiStableContextScope[],
): Promise<void> {
  const canonical = [
    ...new Map(
      scopes.map((scope) => {
        return [
          `${scope.orgId}\0${scope.agentId}\0${subjectForScope(scope)}`,
          scope,
        ] as const;
      }),
    ).entries(),
  ]
    .sort(([left], [right]) => {
      return left.localeCompare(right);
    })
    .map(([, scope]) => {
      return scope;
    });
  for (const scope of canonical) {
    await db
      .insert(piStableContextGenerations)
      .values({
        orgId: scope.orgId,
        agentId: scope.agentId,
        subject: subjectForScope(scope),
      })
      .onConflictDoNothing();
    const [locked] = await db
      .select({ generation: piStableContextGenerations.generation })
      .from(piStableContextGenerations)
      .where(generationScopeCondition(scope))
      .for("update")
      .limit(1);
    if (!locked) {
      throw new Error("Stable-context generation lock is unavailable");
    }
  }
}

/**
 * Lock and detect any unfinished publication for one source key. Callers that
 * mutate source ownership use this after locking the source row, so a metadata
 * commit cannot be retired before its matching Storage commit.
 */
export async function lockPiStableContextPublicationKey(
  db: Db,
  scope: PiStableContextScope,
  publicationKey: string,
): Promise<boolean> {
  const [generation] = await db
    .select({ generation: piStableContextGenerations.generation })
    .from(piStableContextGenerations)
    .where(generationScopeCondition(scope))
    .for("update")
    .limit(1);
  if (!generation) {
    return false;
  }
  const [current] = await db
    .select({ token: piStableContextPublications.token })
    .from(piStableContextPublications)
    .where(publicationKeyCondition(scope, publicationKey))
    .for("update")
    .limit(1);
  return current !== undefined;
}

/** Serialize resource HEAD publication and reject only a superseded same-key writer. */
export async function lockPiStableContextPublication(
  db: Db,
  fence: PiStableContextPublicationFence,
): Promise<boolean> {
  const [generation] = await db
    .select({ generation: piStableContextGenerations.generation })
    .from(piStableContextGenerations)
    .where(generationScopeCondition(fence.scope))
    .for("update")
    .limit(1);
  if (!generation) {
    return false;
  }
  const [current] = await db
    .select({ token: piStableContextPublications.token })
    .from(piStableContextPublications)
    .where(publicationScopeCondition(fence))
    .for("update")
    .limit(1);
  return current !== undefined;
}
