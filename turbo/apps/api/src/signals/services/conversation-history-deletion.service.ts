import {
  deleteRunHistoriesSql,
  deletedRunHistorySchema,
} from "@okouai/db/operations/run-history-deletion";
import { blobs } from "@okouai/db/schema/blob";
import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { logger } from "../../lib/log";
import { safeSqlStateCode } from "../../lib/pg-errors";
import { settle } from "../utils";
import { parseRawRows } from "../../lib/db-raw-rows";
import type { output } from "zod";

const L = logger("ConversationHistoryDeletion");
const DELETION_BATCH_SIZE = 500;

async function contentFreeDatabaseOperation<T>(
  operation: Promise<T>,
): Promise<T> {
  const result = await settle(operation);
  if (!result.ok) {
    // Drizzle errors embed SQL and parameters, including history hashes. Keep
    // only SQLSTATE so existing 55P03 conflict handling survives redaction.
    throw new Error("Conversation history deletion database operation failed", {
      cause: { code: safeSqlStateCode(result.error) },
    });
  }
  return result.value;
}

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

/** The caller must hold every target Run FOR UPDATE until commit. */
export async function deleteLockedRunHistories(
  tx: Tx,
  runIds: readonly string[],
) {
  const historyDeletionQuery = deleteRunHistoriesSql(runIds);
  const historyDeletionSchema = deletedRunHistorySchema;
  const rows = await contentFreeDatabaseOperation(
    (async () => {
      return parseRawRows(
        historyDeletionSchema,
        await tx.execute(historyDeletionQuery),
      );
    })(),
  );
  if (rows.length !== runIds.length) {
    throw new Error("Conversation deletion lost a locked run");
  }
  return deletedRunHistoryReferences(rows);
}

/**
 * Run this LAST, after parent cascades and Storage mutations, in the SAME
 * transaction as deleteLockedRunHistories. Never acquire parents after blobs:
 * completion and candidate cleanup hold parents before their blob writes.
 */
export async function releaseDeletedConversationReferences(
  tx: Tx,
  removed: Awaited<ReturnType<typeof deletedRunHistoryReferences>>,
) {
  const references = [...removed.references]
    .sort(([a], [b]) => {
      return a.localeCompare(b);
    })
    .map(([hash, references]) => {
      return { hash, release_count: references };
    });
  for (
    let offset = 0;
    offset < references.length;
    offset += DELETION_BATCH_SIZE
  ) {
    const batch = references.slice(offset, offset + DELETION_BATCH_SIZE);
    // Preserve the existing nonblocking blob acquisition and rollback boundary.
    // Lock hashes in one global order before UPDATE's unspecified row order.
    const locked = await contentFreeDatabaseOperation(
      tx
        .select({ hash: blobs.hash })
        .from(blobs)
        .where(
          inArray(
            blobs.hash,
            batch.map((entry) => {
              return entry.hash;
            }),
          ),
        )
        .orderBy(asc(blobs.hash))
        .for("update", { noWait: true }),
    );
    // A missing old retain cannot be replaced by another owner's concurrent
    // INSERT between this lock statement and UPDATE's fresh snapshot.
    if (locked.length !== batch.length) {
      throw new Error(
        "Conversation history reference accounting failed: missing blob references",
      );
    }
    const released = await contentFreeDatabaseOperation(
      tx
        .update(blobs)
        .set({ refCount: sql`${blobs.refCount} - removed.release_count` })
        .from(
          sql`jsonb_to_recordset(${JSON.stringify(batch)}::jsonb)
          AS removed(hash text, release_count integer)`,
        )
        .where(
          and(
            eq(blobs.hash, sql`removed.hash`),
            gte(blobs.refCount, sql`removed.release_count`),
          ),
        ),
    );
    if (released.rowCount !== batch.length) {
      throw new Error(
        "Conversation history reference accounting failed: missing or insufficient blob references",
      );
    }
  }
  return {
    deletedRuns: removed.deletedRuns,
    releasedReferences: references.reduce((total, entry) => {
      return total + entry.release_count;
    }, 0),
    releasedHashes: references.length,
  };
}

/** Only call after the owning transaction promise resolves successfully. */
export function logCommittedConversationDeletion(
  source: "agent" | "threadless",
  receipt: Awaited<ReturnType<typeof releaseDeletedConversationReferences>>,
) {
  if (receipt.deletedRuns > 0 || receipt.releasedReferences > 0) {
    L.debug("Run history deletion committed", { source, ...receipt });
  }
}
