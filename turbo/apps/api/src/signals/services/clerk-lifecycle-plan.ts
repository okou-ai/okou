import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agents } from "@okouai/db/schema/agent";
import { agentSessions } from "@okouai/db/runtime/agent-session";
import { blobs } from "@okouai/db/schema/blob";
import { deleteRunHistoriesSql } from "@okouai/db/operations/run-history-deletion";
import {
  storagePublicationGenerations,
  storagePublicationTokens,
} from "@okouai/db/schema/storage-publication-fence";
import { and, eq, gte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { safeSqlStateCode } from "../../lib/pg-errors";

class ClerkReferenceAccountingError extends Error {}

export function throwClerkLifecycleFailure(error: unknown): never {
  if (error instanceof ClerkReferenceAccountingError) {
    throw error;
  }
  throw new Error("Conversation history deletion database operation failed", {
    cause: { code: safeSqlStateCode(error) },
  });
}

export type ClerkDeletionScope =
  | { readonly kind: "organization"; readonly orgId: string }
  | { readonly kind: "user"; readonly userId: string };

export const releasedConversationSweepSchema = z.object({
  deletedRuns: z.number().int().nonnegative(),
  deletedConversations: z.number().int().nonnegative(),
  releasedHashes: z.number().int().nonnegative(),
  releasedReferences: z.number().int().nonnegative(),
  matchedHashes: z.number().int().nonnegative(),
});
type ReleasedConversationSweep = z.infer<
  typeof releasedConversationSweepSchema
>;

/** Delete the exact Run snapshot and release the winning rows' held hashes. */
export function releaseRunHistoriesSql(runIds: readonly string[]) {
  return sql`WITH removed AS (
    ${deleteRunHistoriesSql(runIds)}
  ), release_plan AS (
    SELECT hash, count(*)::int AS release_count FROM removed
    WHERE hash IS NOT NULL GROUP BY hash
  ), released AS (
    UPDATE ${blobs} SET ref_count = ${blobs.refCount} - release_plan.release_count
    FROM release_plan
    WHERE ${and(eq(blobs.hash, sql`release_plan.hash`), gte(blobs.refCount, sql`release_plan.release_count`))}
    RETURNING ${blobs.hash}
  ) SELECT
    (SELECT count(*)::int FROM removed) AS "deletedRuns",
    (SELECT count(*)::int FROM removed WHERE "hadConversation") AS "deletedConversations",
    (SELECT count(*)::int FROM release_plan) AS "releasedHashes",
    (SELECT coalesce(sum(release_count), 0)::int FROM release_plan) AS "releasedReferences",
    (SELECT count(*)::int FROM released) AS "matchedHashes"`;
}

export function requireReleasedConversationReferences(
  rows: readonly ReleasedConversationSweep[],
  expectedRuns: number,
): ConversationDeletionReceipt {
  const [row] = rows;
  if (!row || row.deletedRuns !== expectedRuns) {
    throwLateRunConversation();
  }
  if (row.matchedHashes !== row.releasedHashes) {
    throw new ClerkReferenceAccountingError(
      "Conversation history reference accounting failed: missing or insufficient blob references",
    );
  }
  return {
    deletedConversations: row.deletedConversations,
    releasedReferences: row.releasedReferences,
    releasedHashes: row.releasedHashes,
  };
}

/**
 * Delete the user's Sessions only when no Run remains under them.
 *
 * The target Runs and their references were already removed. A Run created in
 * one of these Sessions after that snapshot would otherwise be removed by the
 * Session cascade together with its conversation, leaking the blob reference.
 * The guard keeps such a Session; the caller then fails the job attempt.
 */
export function runFreeUserSessionDeleteSql(userId: string) {
  return sql`DELETE FROM ${agentSessions}
    WHERE ${agentSessions.userId} = ${userId}
    AND NOT EXISTS (
      SELECT 1 FROM ${agentRuns} WHERE ${agentRuns.sessionId} = ${agentSessions.id}
    )`;
}

/** Same guard for the organization's Agent cascade (Agent -> Session -> Run). */
export function runFreeAgentDeleteSql(
  orgId: string,
  agentIds: readonly string[],
) {
  return sql`DELETE FROM ${agents}
    WHERE ${agents.orgId} = ${orgId}
    AND ${agents.id} = ANY(${sql.param(agentIds)}::uuid[])
    AND NOT EXISTS (
      SELECT 1 FROM ${agentRuns}
      WHERE ${eq(agentRuns.agentId, agents.id)}
    )
    AND NOT EXISTS (
      SELECT 1 FROM ${agentSessions}
      JOIN ${agentRuns} ON ${eq(agentRuns.sessionId, agentSessions.id)}
      WHERE ${eq(agentSessions.agentId, agents.id)}
    )`;
}

/** Remove storage publication generations, then their tokens. */
export function clerkPublicationFenceCleanupSql(
  scope: ClerkDeletionScope,
  agentIds: readonly string[],
) {
  const ownedAgents = sql`ANY(${sql.param(agentIds)}::uuid[])`;
  const generation =
    scope.kind === "organization"
      ? eq(storagePublicationGenerations.orgId, scope.orgId)
      : or(
          eq(storagePublicationGenerations.subject, scope.userId),
          eq(storagePublicationGenerations.agentId, ownedAgents),
        );
  const publication =
    scope.kind === "organization"
      ? eq(storagePublicationTokens.orgId, scope.orgId)
      : or(
          eq(storagePublicationTokens.subject, scope.userId),
          eq(storagePublicationTokens.agentId, ownedAgents),
        );
  if (!generation || !publication) {
    throw new Error("Publication fence lifecycle conditions must be present");
  }
  return [
    sql`SELECT ${storagePublicationGenerations.orgId} FROM ${storagePublicationGenerations}
      WHERE ${generation} ORDER BY ${storagePublicationGenerations.orgId},
      ${storagePublicationGenerations.agentId}, ${storagePublicationGenerations.subject} FOR UPDATE`,
    sql`DELETE FROM ${storagePublicationGenerations} WHERE ${generation}`,
    sql`DELETE FROM ${storagePublicationTokens} WHERE ${publication}`,
  ];
}

export interface ConversationDeletionReceipt {
  readonly deletedConversations: number;
  readonly releasedReferences: number;
  readonly releasedHashes: number;
}

export function emptyConversationDeletionReceipt(): ConversationDeletionReceipt {
  return { deletedConversations: 0, releasedReferences: 0, releasedHashes: 0 };
}

/**
 * A target Run gained a conversation, or a late Run appeared under a Session
 * or Agent being deleted, after this transaction's snapshot. Roll back once;
 * the deletion job's existing attempt schedule re-runs it from current rows.
 */
export function throwLateRunConversation(): never {
  throw new ClerkReferenceAccountingError(
    "Conversation deletion conflicted with a concurrent run or conversation write",
  );
}
