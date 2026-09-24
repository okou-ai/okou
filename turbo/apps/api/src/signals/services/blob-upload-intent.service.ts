import { eq, sql } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";

import { blobUploadIntents, blobs } from "@okouai/db/schema/blob";

import type { Tx } from "../../lib/db-types";
import { executeRawRows } from "../../lib/db-raw-rows";

const INTENT_NAMESPACE = "0e6a26d4-3231-4218-98ec-6ab1b09077ef";
const EXPIRY_BATCH_SIZE = 500;

/** Reserve the exact hash before returning an upload URL or starting a direct
 * upload. The blob row lock serializes this with an eraser's transition into
 * erasure_pending. An intent remains for 49 hours, longer than the 48-hour
 * signed URL, even when the first checkpoint has already retained the blob.
 */
export async function reserveBlobUploadIntent(
  tx: Tx,
  args: { readonly hash: string; readonly runId: string },
): Promise<void> {
  const [blob] = await tx
    .select({ erasurePending: blobs.erasurePending })
    .from(blobs)
    .where(eq(blobs.hash, args.hash))
    .for("update")
    .limit(1);
  if (!blob || blob.erasurePending) {
    throw new Error("Session history blob is being erased");
  }
  const intentId = uuidv5(
    JSON.stringify([args.runId, args.hash]),
    INTENT_NAMESPACE,
  );
  await tx
    .insert(blobUploadIntents)
    .values({
      hash: args.hash,
      intentId,
      expiresAt: sql`clock_timestamp() + interval '49 hours'`,
    })
    .onConflictDoUpdate({
      target: [blobUploadIntents.hash, blobUploadIntents.intentId],
      set: {
        expiresAt: sql`greatest(${blobUploadIntents.expiresAt}, clock_timestamp() + interval '49 hours')`,
      },
    });
}

/** Bound expiry work so successful uploads do not retain an intent row forever.
 * The deletion predicate is repeated after candidate selection: an exact-hash
 * reservation that extends the intent while this query waits cannot be pruned.
 */
export async function pruneExpiredBlobUploadIntents(
  db: NodePgDatabase<Record<string, never>>,
): Promise<number> {
  const removed = await executeRawRows(
    db,
    sql`
    DELETE FROM blob_upload_intents AS target
    USING (
      SELECT hash, intent_id
      FROM blob_upload_intents
      WHERE expires_at <= clock_timestamp()
      ORDER BY expires_at
      LIMIT ${EXPIRY_BATCH_SIZE}
    ) AS expired
    WHERE target.hash = expired.hash
      AND target.intent_id = expired.intent_id
      AND target.expires_at <= clock_timestamp()
    RETURNING target.hash AS hash
  `,
    z.object({ hash: z.string() }),
  );
  return removed.length;
}
