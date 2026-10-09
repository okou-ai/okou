import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { chatThreads } from "./chat-thread";

/**
 * Pointers for immutable, canonical R2 Chat Event Snapshot objects. Updating a
 * pointer first uploads a new content-addressed object, then atomically
 * replaces the cursor and object key. Snapshot refreshes reuse the stored
 * prefix and append only Raw Events after its cursor; full PostgreSQL rebuilds
 * are valid only when a thread has never had a Snapshot.
 */
export const chatEventSnapshots = pgTable(
  "chat_event_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    chatThreadId: uuid("chat_thread_id")
      .references(
        () => {
          return chatThreads.id;
        },
        { onDelete: "cascade" },
      )
      .notNull(),
    /** Highest physical stream position covered, including body-omitted rows. */
    lastSeqId: bigint("last_seq_id", { mode: "number" }).notNull(),
    /** Last physical event observed through the coverage watermark. */
    lastEventId: uuid("last_event_id").notNull(),
    /** Last retained event exposed as the logical cursor. */
    terminalEventId: uuid("terminal_event_id"),
    /** Sequence position paired with terminal_event_id, or zero for an empty body. */
    terminalSeqId: bigint("terminal_seq_id", { mode: "number" }),
    /**
     * NDJSON line-shape version, retained as a publication invariant. Each
     * thread has at most one pointer per version.
     */
    archiveSchemaVersion: integer("archive_schema_version")
      .default(8)
      .notNull(),
    /** Immutable content-addressed object referenced by this pointer. */
    objectKey: text("object_key").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("chat_event_snapshots_thread_idx").on(table.chatThreadId),
      index("chat_event_snapshots_object_key_idx").on(table.objectKey),
      uniqueIndex("chat_event_snapshots_thread_version_unique").on(
        table.chatThreadId,
        table.archiveSchemaVersion,
      ),
      check(
        "chat_event_snapshots_archive_schema_version_check",
        sql`${table.archiveSchemaVersion} = 8`,
      ),
      check(
        "chat_event_snapshots_terminal_cursor_check",
        sql`(
          ${table.terminalEventId} IS NULL
          AND ${table.terminalSeqId} = 0
        ) OR (
          ${table.terminalEventId} IS NOT NULL
          AND ${table.terminalSeqId} > 0
          AND ${table.terminalSeqId} <= ${table.lastSeqId}
        )`,
      ),
    ];
  },
);

/**
 * One reusable pagination position per bucket/shard in the existing GC rotation.
 * The cycle ID fences stale checkpoints after that shard wraps; it is not a
 * deletion lease. Failed work does not block another shard's progress.
 */
export const chatEventSnapshotGcState = pgTable(
  "chat_event_snapshot_gc_state",
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
        "chat_event_snapshot_gc_prefix_check",
        sql`${table.prefix} ~ '^chat-events/[0-9a-f]{3}$'`,
      ),
      check(
        "chat_event_snapshot_gc_cursor_check",
        sql`${table.cursorObjectKey} IS NULL OR starts_with(${table.cursorObjectKey}, ${table.prefix})`,
      ),
    ];
  },
);

/**
 * Durable cycle state for the global Snapshot candidate scan. The time fence
 * keeps new activity out of an in-progress cycle, while the stable thread-ID
 * cursor guarantees every fixed cohort is exhausted before wrapping. Snapshot
 * publication remains owned by the exact pointer CAS on chat_event_snapshots.
 */
export const chatEventSnapshotScanState = pgTable(
  "chat_event_snapshot_scan_state",
  {
    scope: text("scope").primaryKey(),
    cursorChatThreadId: uuid("cursor_chat_thread_id"),
    cycleUpperBoundLastMessageAt: timestamp(
      "cycle_upper_bound_last_message_at",
      { precision: 3 },
    )
      .defaultNow()
      .notNull(),
  },
  (table) => {
    return [
      check(
        "chat_event_snapshot_scan_state_scope_check",
        sql`${table.scope} = 'global'`,
      ),
    ];
  },
);
