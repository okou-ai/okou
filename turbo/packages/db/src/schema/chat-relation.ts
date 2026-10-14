import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** Accepted cross-chat actions. Provenance IDs outlive live threads and hot events. */
export const chatRelations = pgTable(
  "chat_relations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    type: text("type", { enum: ["created", "message"] }).notNull(),
    sourceChatThreadId: uuid("source_chat_thread_id").notNull(),
    targetChatThreadId: uuid("target_chat_thread_id").notNull(),
    sourceRunId: uuid("source_run_id").notNull(),
    targetRunId: uuid("target_run_id"),
    // The original accepted input, even after a run replaces it when consuming it.
    messageEventId: uuid("message_event_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      check(
        "chat_relations_different_threads",
        sql`${table.sourceChatThreadId} <> ${table.targetChatThreadId}`,
      ),
      check(
        "chat_relations_shape",
        sql`(${table.type} = 'created' AND ${table.messageEventId} IS NULL AND ${table.targetRunId} IS NULL) OR (${table.type} = 'message' AND ${table.messageEventId} IS NOT NULL)`,
      ),
      uniqueIndex("chat_relations_created_target_unique")
        .on(table.targetChatThreadId)
        .where(sql`${table.type} = 'created'`),
      uniqueIndex("chat_relations_message_event_unique")
        .on(table.messageEventId)
        .where(sql`${table.type} = 'message'`),
      index("chat_relations_source_idx").on(
        table.orgId,
        table.userId,
        table.sourceChatThreadId,
        table.type,
        table.createdAt.desc(),
        table.id.desc(),
      ),
      index("chat_relations_target_idx").on(
        table.orgId,
        table.userId,
        table.targetChatThreadId,
        table.type,
        table.createdAt.desc(),
        table.id.desc(),
      ),
    ];
  },
);
