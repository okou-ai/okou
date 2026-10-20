import {
  bigint,
  check,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const chatThreadSnapshots = pgTable(
  "chat_thread_snapshots",
  {
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    latestEventId: uuid("latest_event_id"),
    /** Sequence position represented by the compacted snapshot. */
    latestEventSeqId: bigint("latest_event_seq_id", { mode: "number" }),
    /** Opaque key of an immutable R2 snapshot object. */
    objectKey: text("object_key"),
    /** SHA-256 of the compressed snapshot bytes, independent of its key. */
    contentDigest: text("content_digest"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [primaryKey({ columns: [table.userId, table.orgId] })];
  },
);

/**
 * One reusable pagination position per bucket/partition in the GC rotation.
 * The cycle ID fences stale checkpoints after a partition wraps; it is not a
 * deletion lease.
 */
export const chatThreadSnapshotGcState = pgTable(
  "chat_thread_snapshot_gc_state",
  {
    bucket: text("bucket").notNull(),
    prefix: text("prefix").notNull(),
    cursorObjectKey: text("cursor_object_key"),
    cycleId: uuid("cycle_id").defaultRandom().notNull(),
  },
  (table) => {
    return [
      primaryKey({ columns: [table.bucket, table.prefix] }),
      check(
        "chat_thread_snapshot_gc_prefix_check",
        sql`${table.prefix} ~ '^chat-thread-snapshots/v1/[0-9a-f]{2}$'`,
      ),
      check(
        "chat_thread_snapshot_gc_cursor_check",
        sql`${table.cursorObjectKey} IS NULL OR starts_with(${table.cursorObjectKey}, ${table.prefix})`,
      ),
    ];
  },
);
