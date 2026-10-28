import type { deletedRunHistorySchema } from "@okouai/db/operations/run-history-deletion";
import { blobs } from "@okouai/db/schema/blob";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { output } from "zod";

import { logger } from "../../lib/log";
import { safeSqlStateCode } from "../../lib/pg-errors";

const L = logger("ConversationHistoryDeletion");

export function deletedRunHistoryReferences(
  rows: readonly output<typeof deletedRunHistorySchema>[],
) {
  const references = new Map<string, number>();
  for (const row of rows) {
    if (row.hash !== null) {
      references.set(row.hash, (references.get(row.hash) ?? 0) + 1);
    }
  }
  return { references, deletedRuns: rows.length };
}

export function conversationReferenceBatches(
  removed: ReturnType<typeof deletedRunHistoryReferences>,
) {
  const references = [...removed.references]
    .sort(([a], [b]) => {
      return a.localeCompare(b);
    })
    .map(([hash, references]) => {
      return { hash, release_count: references };
    });
  const batches: (typeof references)[] = [];
  for (let offset = 0; offset < references.length; offset += 500) {
    batches.push(references.slice(offset, offset + 500));
  }
  return {
    batches,
    receipt: {
      deletedRuns: removed.deletedRuns,
      releasedReferences: references.reduce((total, entry) => {
        return total + entry.release_count;
      }, 0),
      releasedHashes: references.length,
    },
  };
}
type ReferenceBatch = ReturnType<
  typeof conversationReferenceBatches
>["batches"][number];
export function conversationBlobLockCondition(batch: ReferenceBatch) {
  return inArray(
    blobs.hash,
    batch.map((entry) => {
      return entry.hash;
    }),
  );
}
export function conversationBlobReleaseValues(batch: ReferenceBatch) {
  return {
    values: { refCount: sql`${blobs.refCount} - removed.release_count` },
    from: sql`jsonb_to_recordset(${JSON.stringify(batch)}::jsonb) AS removed(hash text, release_count integer)`,
    where: and(
      eq(blobs.hash, sql`removed.hash`),
      gte(blobs.refCount, sql`removed.release_count`),
    ),
  };
}
export function conversationDeletionDatabaseError(error: unknown) {
  return new Error("Conversation history deletion database operation failed", {
    cause: { code: safeSqlStateCode(error) },
  });
}

/** Only call after the owning transaction promise resolves successfully. */
export function logCommittedConversationDeletion(
  source: "agent" | "threadless",
  receipt: ReturnType<typeof conversationReferenceBatches>["receipt"],
) {
  if (receipt.deletedRuns > 0 || receipt.releasedReferences > 0) {
    L.debug("Run history deletion committed", { source, ...receipt });
  }
}
