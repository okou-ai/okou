import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { chatThreads } from "./chat-thread";
import { storages } from "./storage";

// No Run/Thread/Agent/Org FK: deleting a trigger must not refund a user's day.
// Account deletion explicitly removes this user-owned control record.
export const piMemoryStage1Days = pgTable(
  "pi_memory_stage1_days",
  {
    userId: text("user_id").primaryKey(),
    day: date("day").notNull(),
    orgId: text("org_id").notNull(),
    triggerThreadId: uuid("trigger_thread_id").notNull(),
    requestedAt: timestamp("requested_at").notNull(),
    consumedAt: timestamp("consumed_at"),
  },
  (table) => {
    return [
      index("idx_pi_memory_stage1_days_pending")
        .on(table.day)
        .where(sql`${table.consumedAt} IS NULL`),
    ];
  },
);

// Frozen metadata, not extra blob references. Candidate service owns the blob.
// Slots survive source/Storage deletion until the next interactive UTC day.
export const piMemoryStage1Selections = pgTable(
  "pi_memory_stage1_selections",
  {
    userId: text("user_id")
      .notNull()
      .references(
        () => {
          return piMemoryStage1Days.userId;
        },
        { onDelete: "cascade" },
      ),
    slot: integer("slot").notNull(),
    day: date("day").notNull(),
    orgId: text("org_id").notNull(),
    chatThreadId: uuid("chat_thread_id").notNull(),
    memoryStorageId: uuid("memory_storage_id").notNull(),
    piSessionId: varchar("pi_session_id", { length: 255 }).notNull(),
    sourceRunId: uuid("source_run_id").notNull(),
    sourceHistoryHash: varchar("source_history_hash", { length: 64 }).notNull(),
    sourceCompletedAt: timestamp("source_completed_at").notNull(),
    sourceActivityAt: timestamp("source_activity_at").notNull(),
  },
  (table) => {
    return [
      primaryKey({ columns: [table.userId, table.slot] }),
      unique("pi_memory_stage1_selections_thread_unique").on(
        table.userId,
        table.chatThreadId,
      ),
      check(
        "pi_memory_stage1_selections_slot_check",
        sql`${table.slot} BETWEEN 1 AND 2`,
      ),
    ];
  },
);

export const piMemoryStage1Watermarks = pgTable(
  "pi_memory_stage1_watermarks",
  {
    memoryStorageId: uuid("memory_storage_id").notNull(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    chatThreadId: uuid("chat_thread_id")
      .notNull()
      .references(
        () => {
          return chatThreads.id;
        },
        { onDelete: "cascade" },
      ),
    sourceActivityAt: timestamp("source_activity_at").notNull(),
    sourceHistoryHash: varchar("source_history_hash", { length: 64 }).notNull(),
  },
  (table) => {
    return [
      primaryKey({ columns: [table.memoryStorageId, table.chatThreadId] }),
      foreignKey({
        name: "pi_memory_stage1_watermarks_storage_owner_fk",
        columns: [table.memoryStorageId, table.orgId, table.userId],
        foreignColumns: [storages.id, storages.orgId, storages.userId],
      }).onDelete("cascade"),
    ];
  },
);
