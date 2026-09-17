import { randomUUID } from "node:crypto";

import {
  piStableContextGenerations,
  piStableContextHeads,
} from "@okouai/db/schema/pi-stable-context";
import { and, eq, sql } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";

export const PI_STABLE_CONTEXT_AGENT_SUBJECT = "@agent";

export interface PiStableContextScope {
  readonly orgId: string;
  readonly agentId: string;
  /** Omit for agent-wide identity, public workflow, or shared resource writes. */
  readonly userId?: string;
}

export interface PiStableContextPublicationFence {
  readonly scope: PiStableContextScope;
  readonly generation: number;
  readonly token: string;
}

function subjectForScope(scope: PiStableContextScope): string {
  return scope.userId ?? PI_STABLE_CONTEXT_AGENT_SUBJECT;
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

async function invalidateKnownHeads(
  db: Db,
  scope: PiStableContextScope,
): Promise<void> {
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
      availableAt: nowDate(),
      attemptCount: 0,
      lastErrorClass: null,
      updatedAt: nowDate(),
    })
    .where(headScopeCondition(scope));
}

async function advanceGeneration(
  db: Db,
  scope: PiStableContextScope,
  state:
    | { readonly kind: "ready" }
    | { readonly kind: "pending"; readonly token: string },
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
      publicationToken: state.kind === "pending" ? state.token : null,
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
        publicationState: state.kind,
        publicationToken: state.kind === "pending" ? state.token : null,
        updatedAt,
      },
    })
    .returning({ generation: piStableContextGenerations.generation });
  if (!row) {
    throw new Error("Stable-context generation advance returned no row");
  }
  await invalidateKnownHeads(db, scope);
  return row.generation;
}

/** Atomically invalidate known projections for a single-stage source write. */
export async function invalidatePiStableContext(
  db: Db,
  scope: PiStableContextScope,
): Promise<number> {
  return await advanceGeneration(db, scope, { kind: "ready" });
}

async function invalidateHeadSet(
  db: Db,
  condition: ReturnType<typeof eq> | ReturnType<typeof and>,
): Promise<void> {
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
      availableAt: nowDate(),
      attemptCount: 0,
      lastErrorClass: null,
      updatedAt: nowDate(),
    })
    .where(condition);
}

/** Bulk invalidation for a user-scoped feature/profile source writer. */
export async function invalidatePiStableContextsForUser(
  db: Db,
  args: { readonly orgId: string; readonly userId: string },
): Promise<void> {
  await db
    .update(piStableContextGenerations)
    .set({
      generation: sql`${piStableContextGenerations.generation} + 1`,
      publicationState: "ready",
      publicationToken: null,
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(piStableContextGenerations.orgId, args.orgId),
        eq(piStableContextGenerations.subject, args.userId),
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
  await db
    .update(piStableContextGenerations)
    .set({
      generation: sql`${piStableContextGenerations.generation} + 1`,
      publicationState: "ready",
      publicationToken: null,
      updatedAt: nowDate(),
    })
    .where(eq(piStableContextGenerations.orgId, orgId));
  await invalidateHeadSet(db, eq(piStableContextHeads.orgId, orgId));
}

/** Bulk invalidation for the shared official connector/workflow catalog. */
export async function invalidateAllPiStableContexts(db: Db): Promise<void> {
  await db.update(piStableContextGenerations).set({
    generation: sql`${piStableContextGenerations.generation} + 1`,
    publicationState: "ready",
    publicationToken: null,
    updatedAt: nowDate(),
  });
  await db.update(piStableContextHeads).set({
    generation: sql`${piStableContextHeads.generation} + 1`,
    status: "missing",
    input: null,
    inputDigest: null,
    artifactDigest: null,
    validityHorizon: null,
    leaseId: null,
    leaseExpiresAt: null,
    availableAt: nowDate(),
    attemptCount: 0,
    lastErrorClass: null,
    updatedAt: nowDate(),
  });
}

/** Begin a metadata-first publication. No projection is readable while pending. */
export async function beginPiStableContextPublication(
  db: Db,
  scope: PiStableContextScope,
): Promise<PiStableContextPublicationFence> {
  const token = randomUUID();
  const generation = await advanceGeneration(db, scope, {
    kind: "pending",
    token,
  });
  return { scope, generation, token };
}

/**
 * Complete the exact metadata generation together with its resource HEAD. A
 * stale publisher is retained as immutable Storage history but cannot make a
 * newer generation ready.
 */
export async function completePiStableContextPublication(
  db: Db,
  fence: PiStableContextPublicationFence,
): Promise<boolean> {
  const [completed] = await db
    .update(piStableContextGenerations)
    .set({
      publicationState: "ready",
      publicationToken: null,
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(piStableContextGenerations.orgId, fence.scope.orgId),
        eq(piStableContextGenerations.agentId, fence.scope.agentId),
        eq(piStableContextGenerations.subject, subjectForScope(fence.scope)),
        eq(piStableContextGenerations.generation, fence.generation),
        eq(piStableContextGenerations.publicationState, "pending"),
        eq(piStableContextGenerations.publicationToken, fence.token),
      ),
    )
    .returning({ generation: piStableContextGenerations.generation });
  return completed !== undefined;
}

/** Serialize resource HEAD publication and reject a superseded writer. */
export async function lockPiStableContextPublication(
  db: Db,
  fence: PiStableContextPublicationFence,
): Promise<boolean> {
  const [current] = await db
    .select({ generation: piStableContextGenerations.generation })
    .from(piStableContextGenerations)
    .where(
      and(
        eq(piStableContextGenerations.orgId, fence.scope.orgId),
        eq(piStableContextGenerations.agentId, fence.scope.agentId),
        eq(piStableContextGenerations.subject, subjectForScope(fence.scope)),
        eq(piStableContextGenerations.generation, fence.generation),
        eq(piStableContextGenerations.publicationState, "pending"),
        eq(piStableContextGenerations.publicationToken, fence.token),
      ),
    )
    .for("update")
    .limit(1);
  return current !== undefined;
}
