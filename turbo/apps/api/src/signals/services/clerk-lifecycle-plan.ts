import { agentRuns } from "@okouai/db/runtime/agent-run";
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

export const removedConversationGroupSchema = z.object({
  hash: z.string().nullable(),
  references: z.number().int().nonnegative(),
});

/** Its owner retains the exact Run parents before deleting any children. */
export function removeRunConversationsSql(runIds: readonly string[]) {
  return sql`WITH removed AS (
    DELETE FROM ${conversations}
    WHERE ${conversations.runId} = ANY(${sql.param(runIds)}::uuid[])
    RETURNING ${conversations.cliAgentSessionHistoryHash} AS hash
  ) SELECT hash, count(*)::int AS "references" FROM removed GROUP BY hash`;
}

export function lockedRunCatalogCleanupSql(runIds: readonly string[]) {
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

export function lockedRunDeleteCondition(runIds: readonly string[]) {
  return eq(agentRuns.id, sql`ANY(${sql.param(runIds)}::uuid[])`);
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

type RemovedConversationGroup = z.infer<typeof removedConversationGroupSchema>;
export function conversationReleasePlan(
  rows: readonly RemovedConversationGroup[],
) {
  const references = rows
    .flatMap((row) => {
      return row.hash === null
        ? []
        : [{ hash: row.hash, release_count: row.references }];
    })
    .sort((a, b) => {
      return a.hash.localeCompare(b.hash);
    });
  return {
    references,
    deletedConversations: rows.reduce((sum, row) => {
      return sum + row.references;
    }, 0),
  };
}
type ConversationReleasePlan = ReturnType<typeof conversationReleasePlan>;

export function releaseConversationBlobsSql(plan: ConversationReleasePlan) {
  return sql`UPDATE ${blobs} SET ref_count = ${blobs.refCount} - removed.release_count
    FROM jsonb_to_recordset(${JSON.stringify(plan.references)}::jsonb)
      AS removed(hash text, release_count integer)
    WHERE ${and(eq(blobs.hash, sql`removed.hash`), gte(blobs.refCount, sql`removed.release_count`))}`;
}

export function requireConversationReferences(
  actual: number,
  plan: ConversationReleasePlan,
) {
  if (actual !== plan.references.length) {
    throw new ClerkReferenceAccountingError(
      "Conversation history reference accounting failed: missing or insufficient blob references",
    );
  }
}
export function conversationDeletionReceipt(plan: ConversationReleasePlan) {
  return {
    deletedConversations: plan.deletedConversations,
    releasedReferences: plan.references.reduce((total, entry) => {
      return total + entry.release_count;
    }, 0),
    releasedHashes: plan.references.length,
  };
}
export function requireDeletedRunCount(
  actual: number,
  runIds: readonly string[],
) {
  if (actual !== runIds.length) {
    throw new ClerkReferenceAccountingError(
      "Conversation deletion lost a locked run",
    );
  }
}

export function conversationBlobHashes(plan: ConversationReleasePlan) {
  return plan.references.map((entry) => {
    return entry.hash;
  });
}
