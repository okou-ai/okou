import { z } from "zod";
import { pgInt8ToSafeIntegerSchema } from "../../lib/db-raw-rows";

import {
  piStableContextGenerations,
  piStableContextPublications,
} from "@okouai/db/schema/pi-stable-context";
import { and, eq, sql, type SQL } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";

/**
 * Reserve-before-IO ordering for Agent instructions and workflow volume
 * publication. A newer reservation replaces the exact key/token, so an older,
 * slower preparation can no longer publish its Storage HEAD.
 *
 * The rows still live in the retained `pi_stable_context_generations` and
 * `pi_stable_context_publications` tables; only this fence uses them now.
 */
const AGENT_SUBJECT = "@agent";
export const AGENT_INSTRUCTIONS_PUBLICATION_KEY = "agent-instructions";

export function workflowPublicationKey(workflowId: string): string {
  return `workflow:${workflowId}`;
}

export interface PublicationFenceScope {
  readonly orgId: string;
  readonly agentId: string;
  /** Omit for agent-wide identity, public workflow, or shared resource writes. */
  readonly userId?: string;
}

export interface StoragePublicationFence {
  readonly scope: PublicationFenceScope;
  readonly publicationKey: string;
  readonly generation: number;
  readonly token: string;
}

function subjectForScope(scope: PublicationFenceScope): string {
  return scope.userId ?? AGENT_SUBJECT;
}

export function generationScopeCondition(scope: PublicationFenceScope): SQL {
  return sql`${eq(piStableContextGenerations.orgId, scope.orgId)} AND ${eq(piStableContextGenerations.agentId, scope.agentId)} AND ${eq(piStableContextGenerations.subject, subjectForScope(scope))}`;
}

export function publicationKeyCondition(
  scope: PublicationFenceScope,
  publicationKey: string,
): SQL {
  return sql`${eq(piStableContextPublications.orgId, scope.orgId)} AND ${eq(piStableContextPublications.agentId, scope.agentId)} AND ${eq(piStableContextPublications.subject, subjectForScope(scope))} AND ${eq(piStableContextPublications.publicationKey, publicationKey)}`;
}

export function publicationScopeCondition(fence: StoragePublicationFence): SQL {
  return sql`${publicationKeyCondition(fence.scope, fence.publicationKey)} AND ${eq(piStableContextPublications.generation, fence.generation)} AND ${eq(piStableContextPublications.token, fence.token)}`;
}

export const publicationGenerationReceiptSchema = z.object({
  generation: pgInt8ToSafeIntegerSchema,
});

export function publicationFenceFromReceipt(
  receipts: readonly { readonly generation: number }[],
  scope: PublicationFenceScope,
  publicationKey: string,
  token: string,
): StoragePublicationFence {
  const [receipt] = receipts;
  if (!receipt) {
    throw new Error("Publication fence reservation returned no row");
  }
  return { scope, publicationKey, token, generation: receipt.generation };
}

/** The reservation's scope generation and exact key/token are one statement. */
export function beginPublicationSql(
  scope: PublicationFenceScope,
  publicationKey: string,
  token: string,
  at: Date,
): SQL {
  return sql`WITH advanced AS (
    INSERT INTO ${piStableContextGenerations} (org_id, agent_id, subject, publication_state, updated_at)
    VALUES (${scope.orgId}, ${scope.agentId}, ${subjectForScope(scope)}, 'pending', ${at.toISOString()}::timestamp)
    ON CONFLICT (org_id, agent_id, subject) DO UPDATE SET generation = ${piStableContextGenerations.generation} + 1,
      publication_state = 'pending', updated_at = EXCLUDED.updated_at RETURNING generation
  ), reserved AS (
    INSERT INTO ${piStableContextPublications} (org_id, agent_id, subject, publication_key, generation, token, created_at, updated_at)
    SELECT ${scope.orgId}, ${scope.agentId}, ${subjectForScope(scope)}, ${publicationKey}, generation, ${token}::uuid,
      ${at.toISOString()}::timestamp, ${at.toISOString()}::timestamp FROM advanced
    ON CONFLICT (org_id, agent_id, subject, publication_key) DO UPDATE SET generation = EXCLUDED.generation,
      token = EXCLUDED.token, created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at RETURNING generation
  ) SELECT generation FROM reserved`;
}

/** An actual pending publication write precedes token consumption, matching reservation order. */
export function publicationScopePendingSql(
  scope: PublicationFenceScope,
  at: Date,
): SQL {
  return sql`UPDATE ${piStableContextGenerations} SET publication_state = 'pending', updated_at = ${at.toISOString()}::timestamp
    WHERE ${generationScopeCondition(scope)}`;
}

export function publicationReadinessSql(
  scope: PublicationFenceScope,
  at: Date,
): SQL {
  return sql`UPDATE ${piStableContextGenerations} SET publication_state = CASE WHEN EXISTS (
    SELECT 1 FROM ${piStableContextPublications} WHERE org_id = ${scope.orgId} AND agent_id = ${scope.agentId} AND subject = ${subjectForScope(scope)}
  ) THEN 'pending' ELSE 'ready' END, updated_at = ${at.toISOString()}::timestamp WHERE ${generationScopeCondition(scope)}`;
}

export function completePublicationSql(fence: StoragePublicationFence): SQL {
  return sql`DELETE FROM ${piStableContextPublications} WHERE ${publicationScopeCondition(fence)} AND EXISTS (SELECT 1 FROM ${piStableContextGenerations} WHERE ${generationScopeCondition(fence.scope)})`;
}

export function retirePublicationSql(
  scope: PublicationFenceScope,
  key: string,
): SQL {
  return sql`DELETE FROM ${piStableContextPublications} WHERE ${publicationKeyCondition(scope, key)} AND EXISTS (SELECT 1 FROM ${piStableContextGenerations} WHERE ${generationScopeCondition(scope)})`;
}

function publicationGenerationValues(scopes: readonly PublicationFenceScope[]) {
  return [
    ...new Map(
      scopes.map((scope) => {
        return [
          `${scope.orgId}\0${scope.agentId}\0${subjectForScope(scope)}`,
          scope,
        ];
      }),
    ).values(),
  ].map((scope) => {
    return {
      orgId: scope.orgId,
      agentId: scope.agentId,
      subject: subjectForScope(scope),
    };
  });
}

/** Create missing scope generation rows without advancing existing ones. */
export async function ensurePublicationGenerations(
  tx: Tx,
  scopes: readonly PublicationFenceScope[],
): Promise<void> {
  await tx
    .insert(piStableContextGenerations)
    .values(publicationGenerationValues(scopes))
    .onConflictDoNothing();
}

/** Whether this exact reservation still owns its publication key. */
export async function publicationFenceIsCurrent(
  tx: Tx,
  fence: StoragePublicationFence,
): Promise<boolean> {
  const [publication] = await tx
    .select({ token: piStableContextPublications.token })
    .from(piStableContextPublications)
    .where(publicationScopeCondition(fence))
    .limit(1);
  return publication !== undefined;
}

/** Whether any reservation of this key is still in flight for its scope. */
export async function publicationIsPending(
  tx: Tx,
  scope: PublicationFenceScope,
  publicationKey: string,
): Promise<boolean> {
  const [publication] = await tx
    .select({ token: piStableContextPublications.token })
    .from(piStableContextPublications)
    .innerJoin(
      piStableContextGenerations,
      and(
        eq(piStableContextGenerations.orgId, piStableContextPublications.orgId),
        eq(
          piStableContextGenerations.agentId,
          piStableContextPublications.agentId,
        ),
        eq(
          piStableContextGenerations.subject,
          piStableContextPublications.subject,
        ),
      ),
    )
    .where(publicationKeyCondition(scope, publicationKey))
    .limit(1);
  return publication !== undefined;
}

/**
 * Consume this exact reservation after owning its scope generation row.
 * Returns false when a newer reservation superseded it.
 */
export async function consumePublicationFence(
  tx: Tx,
  fence: StoragePublicationFence,
  at: Date,
): Promise<boolean> {
  // Generation before publication, matching beginPublicationSql. Both are
  // ordinary writes; zero rows means this fence was superseded.
  const [generation] = await tx
    .update(piStableContextGenerations)
    .set({ updatedAt: at })
    .where(generationScopeCondition(fence.scope))
    .returning({ generation: piStableContextGenerations.generation });
  const [publication] = generation
    ? await tx
        .delete(piStableContextPublications)
        .where(publicationScopeCondition(fence))
        .returning({ token: piStableContextPublications.token })
    : [];
  return publication !== undefined;
}
