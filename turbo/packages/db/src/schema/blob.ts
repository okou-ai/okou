import {
  pgTable,
  varchar,
  bigint,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

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
    /** Timestamp when the blob was first uploaded */
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      // Index for garbage collection queries
      index("idx_blobs_ref_count").on(table.refCount),
    ];
  },
);
