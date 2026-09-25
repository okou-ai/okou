import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { chatThreads } from "./chat-thread";
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
 * `agent_drafts`. A row whose values are both null is an older API's cleared
 * tombstone and reads the same as no row.
 *
 * `chat_threads.draft_user_message` and `chat_threads.draft_attachments` are
 * retired: nothing reads or writes them, and the contract release drops them.
 */
export const chatThreadDrafts = pgTable(
  "chat_thread_drafts",
  {
    chatThreadId: uuid("chat_thread_id").notNull(),
    /**
     * Owner of the thread, copied at write time so the per-user drafts listing
     * reads this table alone. Nullable only until the contract release backfills
     * rows an older API inserted without it.
     */
    userId: text("user_id"),
    /** Canonical rich document for the thread composer's saved draft. */
    draftUserMessage:
      jsonb("draft_user_message").$type<ChatThreadDraftUserMessage>(),
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
      // The thread id is the whole key, so a thread can never hold two drafts
      // and the upsert has exactly one conflict target.
      primaryKey({
        name: "chat_thread_drafts_chat_thread_id_pk",
        columns: [table.chatThreadId],
      }),
      foreignKey({
        name: "chat_thread_drafts_chat_thread_id_chat_threads_id_fk",
        columns: [table.chatThreadId],
        foreignColumns: [chatThreads.id],
      }).onDelete("cascade"),
      index("idx_chat_thread_drafts_user").on(table.userId),
      // The same invariant `chat_threads_draft_user_message_check` enforces on
      // the legacy columns: attachments cannot outlive the document they were
      // attached to. Both values null is an older API's cleared tombstone.
      check(
        "chat_thread_drafts_draft_user_message_check",
        sql`${table.draftUserMessage} IS NOT NULL
          OR COALESCE(${table.draftAttachments}, '[]'::jsonb) = '[]'::jsonb`,
      ),
    ];
  },
);
