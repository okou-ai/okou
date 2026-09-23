import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  jsonb,
  pgTable,
  primaryKey,
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
 * workloads contend for one tuple. Holding the draft in its own child row is
 * what eventually removes that contention; see the parent issue #36173.
 *
 * During the compatibility window `chat_threads.draft_user_message` and
 * `chat_threads.draft_attachments` remain the served values and this table is
 * written alongside them, inside the same transaction. Nothing reads it yet.
 *
 * A cleared draft is a **retained row with null draft values**, never a deleted
 * row. `agent_drafts` deletes on clear, and copying that here would be wrong:
 * the later read cutover falls back to the legacy columns when the child row is
 * missing, so a deleted row would resurrect the draft the user just cleared.
 * Absence must keep meaning "never touched since the table existed".
 */
export const chatThreadDrafts = pgTable(
  "chat_thread_drafts",
  {
    chatThreadId: uuid("chat_thread_id").notNull(),
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
      // The same invariant `chat_threads_draft_user_message_check` enforces on
      // the legacy columns: attachments cannot outlive the document they were
      // attached to. Both values null is the cleared tombstone and is allowed.
      check(
        "chat_thread_drafts_draft_user_message_check",
        sql`${table.draftUserMessage} IS NOT NULL
          OR COALESCE(${table.draftAttachments}, '[]'::jsonb) = '[]'::jsonb`,
      ),
    ];
  },
);
