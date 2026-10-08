import { z } from "zod";
import { pgInt8ToSafeIntegerSchema } from "../../lib/db-raw-rows";

import {
  storagePublicationGenerations,
  storagePublicationTokens,
} from "@okouai/db/schema/storage-publication-fence";
import { and, eq, sql, type SQL } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";

/**
 * Reserve-before-IO ordering for Agent instructions and workflow volume
 * publication. A newer reservation replaces the exact key/token, so an older,
 * slower preparation can no longer publish its Storage HEAD.
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
  return sql`${eq(storagePublicationGenerations.orgId, scope.orgId)} AND ${eq(storagePublicationGenerations.agentId, scope.agentId)} AND ${eq(storagePublicationGenerations.subject, subjectForScope(scope))}`;
}

export function publicationKeyCondition(
  scope: PublicationFenceScope,
  publicationKey: string,
): SQL {
  return sql`${eq(storagePublicationTokens.orgId, scope.orgId)} AND ${eq(storagePublicationTokens.agentId, scope.agentId)} AND ${eq(storagePublicationTokens.subject, subjectForScope(scope))} AND ${eq(storagePublicationTokens.publicationKey, publicationKey)}`;
}

export function publicationScopeCondition(fence: StoragePublicationFence): SQL {
  return sql`${publicationKeyCondition(fence.scope, fence.publicationKey)} AND ${eq(storagePublicationTokens.generation, fence.generation)} AND ${eq(storagePublicationTokens.token, fence.token)}`;
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
    INSERT INTO ${storagePublicationGenerations} (org_id, agent_id, subject, updated_at)
    VALUES (${scope.orgId}, ${scope.agentId}, ${subjectForScope(scope)}, ${at.toISOString()}::timestamp)
    ON CONFLICT (org_id, agent_id, subject) DO UPDATE SET generation = ${storagePublicationGenerations.generation} + 1,
      updated_at = EXCLUDED.updated_at RETURNING generation
  ), reserved AS (
    INSERT INTO ${storagePublicationTokens} (org_id, agent_id, subject, publication_key, generation, token, created_at, updated_at)
    SELECT ${scope.orgId}, ${scope.agentId}, ${subjectForScope(scope)}, ${publicationKey}, generation, ${token}::uuid,
      ${at.toISOString()}::timestamp, ${at.toISOString()}::timestamp FROM advanced
    ON CONFLICT (org_id, agent_id, subject, publication_key) DO UPDATE SET generation = EXCLUDED.generation,
      token = EXCLUDED.token, created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at RETURNING generation
  ) SELECT generation FROM reserved`;
}

/**
 * Lock the scope generation row before touching its tokens, matching
 * reservation order. Zero rows means the scope was deleted.
 */
export function lockPublicationScopeSql(
  scope: PublicationFenceScope,
  at: Date,
): SQL {
  return sql`UPDATE ${storagePublicationGenerations} SET updated_at = ${at.toISOString()}::timestamp
    WHERE ${generationScopeCondition(scope)}`;
}

export function completePublicationSql(fence: StoragePublicationFence): SQL {
  return sql`DELETE FROM ${storagePublicationTokens} WHERE ${publicationScopeCondition(fence)} AND EXISTS (SELECT 1 FROM ${storagePublicationGenerations} WHERE ${generationScopeCondition(fence.scope)})`;
}

export function retirePublicationSql(
  scope: PublicationFenceScope,
  key: string,
): SQL {
  return sql`DELETE FROM ${storagePublicationTokens} WHERE ${publicationKeyCondition(scope, key)} AND EXISTS (SELECT 1 FROM ${storagePublicationGenerations} WHERE ${generationScopeCondition(scope)})`;
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
    .insert(storagePublicationGenerations)
    .values(publicationGenerationValues(scopes))
    .onConflictDoNothing();
}

/** Whether any reservation of this key is still in flight for its scope. */
export async function publicationIsPending(
  tx: Tx,
  scope: PublicationFenceScope,
  publicationKey: string,
): Promise<boolean> {
  const [publication] = await tx
    .select({ token: storagePublicationTokens.token })
    .from(storagePublicationTokens)
    .innerJoin(
      storagePublicationGenerations,
      and(
        eq(storagePublicationGenerations.orgId, storagePublicationTokens.orgId),
        eq(
          storagePublicationGenerations.agentId,
          storagePublicationTokens.agentId,
        ),
        eq(
          storagePublicationGenerations.subject,
          storagePublicationTokens.subject,
        ),
      ),
    )
    .where(publicationKeyCondition(scope, publicationKey))
    .limit(1);
  return publication !== undefined;
}
