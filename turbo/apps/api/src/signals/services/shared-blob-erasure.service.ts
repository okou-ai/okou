import { createStore } from "ccstate";
import { and, desc, eq, lte, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { blobUploadIntents, blobs } from "@okouai/db/schema/blob";

import { env } from "../../lib/env";
import { pgBooleanDecoder } from "../../lib/db-structured-result";
import { deleteS3Objects, s3ObjectExists } from "../external/s3";
import {
  resumeSessionHistoryBlobKey,
  SESSION_HISTORY_ENCODING_GZIP,
  SESSION_HISTORY_ENCODING_IDENTITY,
  SESSION_HISTORY_ENCODING_ZSTD,
} from "./session-history-blobs";

type Db = NodePgDatabase<Record<string, never>>;

export type BlobErasureResult =
  | { readonly outcome: "shared" | "absent" | "erased" }
  | {
      readonly outcome: "pending";
      readonly reason:
        | "eligible_at"
        | "upload_intent"
        | "metadata_missing"
        | "verification_failed";
      readonly retryAt?: Date;
    };

const ENCODINGS = [
  SESSION_HISTORY_ENCODING_IDENTITY,
  SESSION_HISTORY_ENCODING_GZIP,
  SESSION_HISTORY_ENCODING_ZSTD,
] as const;

/** Claim one content hash. A concurrent uploader must reserve under the same
 * exact blob row lock, while a retainer must reject erasure_pending. Never
 * hold a database transaction across the R2 call.
 */
async function claimBlobErasure(db: Db, hash: string) {
  return await db.transaction(async (tx) => {
    const [blob] = await tx
      .select({
        hash: blobs.hash,
        refCount: blobs.refCount,
        erasurePending: blobs.erasurePending,
        erasureEligibleAt: blobs.erasureEligibleAt,
        eligible: sql`${blobs.erasureEligibleAt} <= clock_timestamp()`.mapWith(
          pgBooleanDecoder,
        ),
      })
      .from(blobs)
      .where(eq(blobs.hash, hash))
      .for("update")
      .limit(1);
    if (!blob) {
      return "absent" as const;
    }
    if (blob.refCount > 0) {
      return "shared" as const;
    }
    await tx
      .delete(blobUploadIntents)
      .where(
        and(
          eq(blobUploadIntents.hash, hash),
          lte(blobUploadIntents.expiresAt, sql`clock_timestamp()`),
        ),
      );
    const [pending] = await tx
      .select({ expiresAt: blobUploadIntents.expiresAt })
      .from(blobUploadIntents)
      .where(eq(blobUploadIntents.hash, hash))
      .orderBy(desc(blobUploadIntents.expiresAt))
      .limit(1);
    if (pending) {
      return { reason: "upload_intent" as const, retryAt: pending.expiresAt };
    }
    if (blob.erasurePending) {
      return "claimed" as const;
    }
    if (!blob.eligible) {
      return {
        reason: "eligible_at" as const,
        retryAt: blob.erasureEligibleAt,
      };
    }
    await tx
      .update(blobs)
      .set({ erasurePending: true })
      .where(eq(blobs.hash, hash));
    return "claimed" as const;
  });
}

/** Erase all known physical encodings for an unreferenced content hash, then
 * remove its metadata. The pending claim survives process death and replays
 * the same idempotent deletes. A shared ref never loses its bytes.
 */
export async function eraseUnreferencedSharedBlob(
  db: Db,
  hash: string,
  signal: AbortSignal,
): Promise<BlobErasureResult> {
  if (!/^[a-f0-9]{64}$/u.test(hash)) {
    return { outcome: "pending", reason: "metadata_missing" };
  }
  const claim = await claimBlobErasure(db, hash);
  if (claim === "shared") {
    return { outcome: "shared" };
  }
  if (typeof claim === "object") {
    return { outcome: "pending", ...claim };
  }
  const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
  const keys = ENCODINGS.map((encoding) => {
    return resumeSessionHistoryBlobKey(hash, encoding);
  });
  const store = createStore();
  if (claim === "absent") {
    const found = await Promise.all(
      keys.map(async (key) => {
        return await store.get(s3ObjectExists(bucket, key));
      }),
    );
    return found.includes(true)
      ? { outcome: "pending", reason: "metadata_missing" }
      : { outcome: "absent" };
  }
  signal.throwIfAborted();
  await store.get(deleteS3Objects(bucket, keys, signal));
  signal.throwIfAborted();
  const found = await Promise.all(
    keys.map(async (key) => {
      return await store.get(s3ObjectExists(bucket, key));
    }),
  );
  if (found.includes(true)) {
    return { outcome: "pending", reason: "verification_failed" };
  }
  const [removed] = await db
    .delete(blobs)
    .where(
      and(
        eq(blobs.hash, hash),
        eq(blobs.erasurePending, true),
        eq(blobs.refCount, 0),
      ),
    )
    .returning({ hash: blobs.hash });
  return removed
    ? { outcome: "erased" }
    : { outcome: "pending", reason: "verification_failed" };
}
