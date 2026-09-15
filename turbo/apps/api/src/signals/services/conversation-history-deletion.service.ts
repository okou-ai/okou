import { agentRunInferenceObjects } from "@okouai/db/schema/pi-inference-object";
import { deleteUnreferencedPiObjects } from "./pi-inference-object.service";
import { assertPiInferenceErasureReady } from "./pi-inference-lifecycle.service";
import {
  agentRunInference,
  agentRunSandboxLease,
} from "@okouai/db/schema/agent-run-inference";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { blobs } from "@okouai/db/schema/blob";
import { conversations } from "@okouai/db/schema/conversation";
import { and, asc, count, eq, gte, inArray, sql } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { logger } from "../../lib/log";
import { safeSqlStateCode } from "../../lib/pg-errors";
import { settle } from "../utils";

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

/** The caller must hold every target Run FOR UPDATE until commit. */
export async function deleteRunConversations(
  tx: Tx,
  runIds: readonly string[],
) {
  await assertPiInferenceErasureReady(tx, runIds);
  const piObjectHashes: string[] = [];
  // All erasure owners call this before parent cascades. Only proven releases
  // may be removed; the lease FK blocks unknown external cleanup atomically.
  for (let offset = 0; offset < runIds.length; offset += DELETION_BATCH_SIZE) {
    const references = await tx
      .select({ hash: agentRunInferenceObjects.hash })
      .from(agentRunInferenceObjects)
      .where(
        inArray(
          agentRunInferenceObjects.runId,
          runIds.slice(offset, offset + DELETION_BATCH_SIZE),
        ),
      );
    piObjectHashes.push(
      ...references.map((reference) => {
        return reference.hash;
      }),
    );
    await tx
      .delete(agentRunSandboxLease)
      .where(
        and(
          inArray(
            agentRunSandboxLease.runId,
            runIds.slice(offset, offset + DELETION_BATCH_SIZE),
          ),
          eq(agentRunSandboxLease.state, "released"),
        ),
      );
    await tx
      .delete(agentRunInference)
      .where(
        inArray(
          agentRunInference.runId,
          runIds.slice(offset, offset + DELETION_BATCH_SIZE),
        ),
      );
  }
  const references = new Map<string, number>();
  let deletedConversations = 0;
  for (let offset = 0; offset < runIds.length; offset += DELETION_BATCH_SIZE) {
    const removed = tx.$with("removed_conversations").as(
      tx
        .delete(conversations)
        .where(
          inArray(
            conversations.runId,
            runIds.slice(offset, offset + DELETION_BATCH_SIZE),
          ),
        )
        .returning({ hash: conversations.cliAgentSessionHistoryHash }),
    );
    const groups = await contentFreeDatabaseOperation(
      tx
        .with(removed)
        .select({ hash: removed.hash, references: count() })
        .from(removed)
        .groupBy(removed.hash),
    );
    for (const group of groups) {
      deletedConversations += group.references;
      if (group.hash !== null) {
        references.set(
          group.hash,
          (references.get(group.hash) ?? 0) + group.references,
        );
      }
    }
  }
  return { references, deletedConversations, piObjectHashes };
}

/** Delete only the locked Run set; a later scoped INSERT is not our evidence. */
export async function deleteLockedRuns(tx: Tx, runIds: readonly string[]) {
  let deletedRuns = 0;
  for (let offset = 0; offset < runIds.length; offset += DELETION_BATCH_SIZE) {
    const result = await contentFreeDatabaseOperation(
      tx
        .delete(agentRuns)
        .where(
          inArray(
            agentRuns.id,
            runIds.slice(offset, offset + DELETION_BATCH_SIZE),
          ),
        ),
    );
    if (result.rowCount === null) {
      throw new Error("Conversation deletion returned no run count");
    }
    deletedRuns += result.rowCount;
  }
  if (deletedRuns !== runIds.length) {
    throw new Error("Conversation deletion lost a locked run");
  }
}

/**
 * Run this LAST, after parent cascades and Storage mutations, in the SAME
 * transaction as deleteRunConversations. Never acquire parents after blobs:
 * completion and candidate cleanup hold parents before their blob writes.
 */
export async function releaseDeletedConversationReferences(
  tx: Tx,
  removed: Awaited<ReturnType<typeof deleteRunConversations>>,
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
    // A checkpoint on another Run can hold this blob before promoting a
    // surviving Session that our SET NULL locked. NOWAIT breaks that cycle;
    // the caller rolls back and uses its existing conflict/retry boundary.
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
  await deleteUnreferencedPiObjects(tx, [...new Set(removed.piObjectHashes)]);
  return {
    deletedConversations: removed.deletedConversations,
    releasedReferences: references.reduce((total, entry) => {
      return total + entry.release_count;
    }, 0),
    releasedHashes: references.length,
  };
}

/** Only call after the owning transaction promise resolves successfully. */
export function logCommittedConversationDeletion(
  source: "agent" | "threadless" | "clerk_user" | "clerk_organization",
  receipt: Awaited<ReturnType<typeof releaseDeletedConversationReferences>>,
) {
  if (receipt.deletedConversations > 0) {
    L.info("Conversation history deletion committed", { source, ...receipt });
  }
}
