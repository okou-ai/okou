import {
  pgTable,
  varchar,
  bigint,
  integer,
  timestamp,
  index,
  boolean,
  check,
  primaryKey,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Blobs table.
 *
 * Content-addressable storage keyed by the raw, unencoded bytes. Encoded storage
 * formats such as gzip keep the same content hash and raw size while recording
 * the physical object size separately.
 */
export const blobs = pgTable(
  "blobs",
  {
    /** SHA-256 hash of the raw content bytes */
    hash: varchar("hash", { length: 64 }).primaryKey(),
    /** Raw content size in bytes */
    rawSize: bigint("raw_size", { mode: "number" }).notNull(),
    /** Physical storage encoding for this raw-content hash */
    encoding: varchar("encoding", { length: 16 }).notNull(),
    /** Encoded object size in bytes */
    encodedSize: bigint("encoded_size", { mode: "number" }).notNull(),
    /** Reference count for garbage collection */
    refCount: integer("ref_count").notNull().default(1),
    /** Exact-hash collector claim. Retainers must fail while bytes are being removed. */
    erasurePending: boolean("erasure_pending").notNull().default(false),
    /** Covers upload URLs issued before this coordination protocol was deployed. */
    erasureEligibleAt: timestamp("erasure_eligible_at", { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '49 hours'`),
    /** Timestamp when the blob was first uploaded */
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      // Index for garbage collection queries
      index("idx_blobs_ref_count").on(table.refCount),
      check(
        "blobs_erasure_pending_zero_refs",
        sql`NOT ${table.erasurePending} OR ${table.refCount} = 0`,
      ),
    ];
  },
);

/** A URL or direct writer may upload before it establishes a reference. The
 * intent remains through the URL's lifetime, including after a successful
 * checkpoint, so a late PUT cannot recreate bytes after an erasure proof.
 * Only the content hash and random run/hash identity are stored here.
 */
export const blobUploadIntents = pgTable(
  "blob_upload_intents",
  {
    hash: varchar("hash", { length: 64 })
      .notNull()
      .references(() => {
        return blobs.hash;
      }),
    intentId: uuid("intent_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => {
    return [
      primaryKey({ columns: [table.hash, table.intentId] }),
      index("blob_upload_intents_expires_at").on(table.expiresAt),
    ];
  },
);
