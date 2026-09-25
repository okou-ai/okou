import {
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
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
 * `chat_threads.draft_user_message` and `chat_threads.draft_attachments` are
 * retired: nothing reads or writes them, and the contract release drops them.
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
      // A thread has one owner, so it can never hold two drafts. The next
      // contract release replaces this key with the owner-qualified pair below.
      primaryKey({
        name: "chat_thread_drafts_chat_thread_id_pk",
        columns: [table.chatThreadId],
      }),
      index("idx_chat_thread_drafts_user").on(table.userId),
      // Draft writes target the owner-qualified key. The next contract
      // release makes this pair the primary key.
      uniqueIndex("uq_chat_thread_drafts_thread_user").on(
        table.chatThreadId,
        table.userId,
      ),
    ];
  },
);
