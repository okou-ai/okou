import {
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import type {
  ChatThreadDraftAttachments,
  ChatThreadDraftUserMessage,
} from "@okouai/db/jsonb-contracts/chat-thread";

/**
 * Thread composer draft, stored off the hot `chat_threads` row.
 *
 * A draft is written on every keystroke batch while event projection, the run
 * queue and the read cursor all keep updating the thread row itself, so the two
 * workloads contend for one tuple. This table is the only draft store the API
 * reads and writes; see the parent issue #36173.
 *
 * A saved draft is one row and a cleared draft is no row, the same shape as
 * `agent_drafts`. There is deliberately no foreign key to `chat_threads`: a
 * draft write must not lock the thread row. Thread deletion removes the row
 * itself; a row left behind by another deletion path is unreachable and is
 * deletion cleanup's concern.
 *
 * The primary key includes the owner, so a draft write addresses only the
 * caller's own row without reading `chat_threads`.
 */
export const chatThreadDrafts = pgTable(
  "chat_thread_drafts",
  {
    chatThreadId: uuid("chat_thread_id").notNull(),
    /**
     * Owner of the thread, copied at write time so reads and the per-user
     * drafts listing use this table alone.
     */
    userId: text("user_id").notNull(),
    /** Canonical rich document for the thread composer's saved draft. */
    draftUserMessage: jsonb("draft_user_message")
      .$type<ChatThreadDraftUserMessage>()
      .notNull(),
    /**
     * Draft attachment metadata for the thread's composer. Only completed
     * uploads. Null when no draft attachments are saved.
     */
    draftAttachments:
      jsonb("draft_attachments").$type<ChatThreadDraftAttachments>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      // Keyed by the thread and its owner, so a write can only ever address
      // the caller's own draft row and never needs to read the thread.
      primaryKey({
        name: "chat_thread_drafts_chat_thread_id_user_id_pk",
        columns: [table.chatThreadId, table.userId],
      }),
      index("idx_chat_thread_drafts_user").on(table.userId),
    ];
  },
);
