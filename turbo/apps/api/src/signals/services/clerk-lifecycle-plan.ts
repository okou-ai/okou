import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agents } from "@okouai/db/schema/agent";
import { agentSessions } from "@okouai/db/schema/agent-session";
import {
  artifacts,
  imageArtifacts,
  videoArtifacts,
} from "@okouai/db/schema/artifact";
import { blobs } from "@okouai/db/schema/blob";
import { conversations } from "@okouai/db/schema/conversation";
import { emailOutbox } from "@okouai/db/schema/email-outbox";
import { morningBriefDeliveries } from "@okouai/db/schema/morning-brief-delivery";
import {
  piStableContextArtifacts,
  piStableContextGenerations,
  piStableContextHeads,
  piStableContextPublications,
} from "@okouai/db/schema/pi-stable-context";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
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
  deletedConversations: z.number().int().nonnegative(),
  releasedHashes: z.number().int().nonnegative(),
  releasedReferences: z.number().int().nonnegative(),
  matchedHashes: z.number().int().nonnegative(),
});
type ReleasedConversationSweep = z.infer<
  typeof releasedConversationSweepSchema
>;

/**
 * Delete the target Runs' conversations and release their blob references in
 * ONE statement, so no interleaving writer can observe a deleted conversation
 * whose reference is still held. Each decrement is conditional arithmetic on
 * the current row version; a missing or insufficient blob leaves its hash
 * unmatched, which the caller rejects to roll back the whole transaction.
 * No explicit row lock is taken: the Run rows stay unlocked until the
 * conversation-free DELETE below.
 */
export function releaseRunConversationsSql(runIds: readonly string[]) {
  return sql`WITH removed AS (
    DELETE FROM ${conversations}
    WHERE ${conversations.runId} = ANY(${sql.param(runIds)}::uuid[])
    RETURNING ${conversations.cliAgentSessionHistoryHash} AS hash
  ), release_plan AS (
    SELECT hash, count(*)::int AS release_count FROM removed
    WHERE hash IS NOT NULL GROUP BY hash
  ), released AS (
    UPDATE ${blobs} SET ref_count = ${blobs.refCount} - release_plan.release_count
    FROM release_plan
    WHERE ${and(eq(blobs.hash, sql`release_plan.hash`), gte(blobs.refCount, sql`release_plan.release_count`))}
    RETURNING ${blobs.hash}
  ) SELECT
    (SELECT count(*)::int FROM removed) AS "deletedConversations",
    (SELECT count(*)::int FROM release_plan) AS "releasedHashes",
    (SELECT coalesce(sum(release_count), 0)::int FROM release_plan) AS "releasedReferences",
    (SELECT count(*)::int FROM released) AS "matchedHashes"`;
}

export function requireReleasedConversationReferences(
  rows: readonly ReleasedConversationSweep[],
): ConversationDeletionReceipt {
  const [row] = rows;
  if (!row || row.matchedHashes !== row.releasedHashes) {
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

export function runCatalogCleanupSql(runIds: readonly string[]) {
  const ownedFiles = sql`SELECT ${runUploadedFiles.id} FROM ${runUploadedFiles}
    WHERE ${runUploadedFiles.runId} = ANY(${sql.param(runIds)}::uuid[])`;
  return [
    sql`SELECT ${runUploadedFiles.id} FROM ${runUploadedFiles}
      WHERE ${runUploadedFiles.runId} = ANY(${sql.param(runIds)}::uuid[])
      ORDER BY ${runUploadedFiles.id} FOR UPDATE`,
    sql`DELETE FROM ${artifacts} WHERE
      (${artifacts.kind} = 'file' AND ${artifacts.entityId} IN (${ownedFiles}))
      OR (${artifacts.kind} = 'image' AND ${artifacts.entityId} IN (
        SELECT ${imageArtifacts.id} FROM ${imageArtifacts} WHERE ${imageArtifacts.fileId} IN (${ownedFiles})
      ))
      OR (${artifacts.kind} = 'video' AND ${artifacts.entityId} IN (
        SELECT ${videoArtifacts.id} FROM ${videoArtifacts} WHERE ${videoArtifacts.fileId} IN (${ownedFiles})
      ))`,
  ];
}

/**
 * Only delete Runs that have no conversation, so the Run cascade never drops a
 * conversation (and its blob reference) this deletion did not release. A Run
 * that gained a conversation after the release statement survives, and the
 * short RETURNING count makes the caller roll back deterministically.
 *
 * Release 2 switches `conversations.run_id` from ON DELETE CASCADE to RESTRICT
 * once no deployed deleter relies on the cascade; that also turns a conversation
 * committed while this DELETE waits on the Run row into an FK error.
 */
export function conversationFreeRunDeleteSql(runIds: readonly string[]) {
  return sql`WITH deleted AS (
    DELETE FROM ${agentRuns}
    WHERE ${agentRuns.id} = ANY(${sql.param(runIds)}::uuid[])
    AND NOT EXISTS (
      SELECT 1 FROM ${conversations} WHERE ${conversations.runId} = ${agentRuns.id}
    )
    RETURNING 1
  ) SELECT count(*)::int AS "deletedRuns" FROM deleted`;
}

export const deletedRunCountSchema = z.object({
  deletedRuns: z.number().int().nonnegative(),
});

/**
 * Delete the user's Sessions only when no Run remains under them.
 *
 * The target Runs were already deleted conversation-first. A Run created in
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
      SELECT 1 FROM ${agentSessions}
      JOIN ${agentRuns} ON ${agentRuns.sessionId} = ${agentSessions.id}
      WHERE ${agentSessions.agentId} = ${agents.id}
    )`;
}

/** Remove generation fences before ordered heads and artifact cascades. */
export function clerkStableContextCleanupSql(
  scope: ClerkDeletionScope,
  agentIds: readonly string[],
) {
  const ownedAgents = sql`ANY(${sql.param(agentIds)}::uuid[])`;
  const generation =
    scope.kind === "organization"
      ? eq(piStableContextGenerations.orgId, scope.orgId)
      : or(
          eq(piStableContextGenerations.subject, scope.userId),
          eq(piStableContextGenerations.agentId, ownedAgents),
        );
  const publication =
    scope.kind === "organization"
      ? eq(piStableContextPublications.orgId, scope.orgId)
      : or(
          eq(piStableContextPublications.subject, scope.userId),
          eq(piStableContextPublications.agentId, ownedAgents),
        );
  const heads =
    scope.kind === "organization"
      ? eq(piStableContextHeads.orgId, scope.orgId)
      : or(
          eq(piStableContextHeads.userId, scope.userId),
          eq(piStableContextHeads.agentId, ownedAgents),
        );
  if (!generation || !publication || !heads) {
    throw new Error("Stable-context lifecycle conditions must be present");
  }
  return [
    sql`SELECT ${piStableContextGenerations.orgId} FROM ${piStableContextGenerations}
      WHERE ${generation} ORDER BY ${piStableContextGenerations.orgId},
      ${piStableContextGenerations.agentId}, ${piStableContextGenerations.subject} FOR UPDATE`,
    sql`DELETE FROM ${piStableContextGenerations} WHERE ${generation}`,
    sql`DELETE FROM ${piStableContextPublications} WHERE ${publication}`,
    sql`SELECT ${piStableContextHeads.id} FROM ${piStableContextHeads}
      WHERE ${heads} ORDER BY ${piStableContextHeads.id} FOR UPDATE`,
    sql`DELETE FROM ${piStableContextHeads} WHERE ${heads}`,
    ...(scope.kind === "user"
      ? [
          sql`DELETE FROM ${piStableContextArtifacts} WHERE ${eq(piStableContextArtifacts.userId, scope.userId)}`,
        ]
      : []),
  ];
}

export function revokeAgentDeliveriesSql(agentIds: readonly string[]) {
  return sql`WITH revoked AS (
    DELETE FROM ${morningBriefDeliveries}
    WHERE ${morningBriefDeliveries.agentId} = ANY(${sql.param(agentIds)}::uuid[])
    RETURNING ${morningBriefDeliveries.emailOutboxId} AS outbox_id
  ) DELETE FROM ${emailOutbox} WHERE ${emailOutbox.id} IN (
    SELECT outbox_id FROM revoked WHERE outbox_id IS NOT NULL
  )`;
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
