import { sql } from "drizzle-orm";
import { bigint, check, index, pgTable, unique } from "drizzle-orm/pg-core";
import { chatThreadColumns } from "../columns/chat-thread";
/**
 * Server-private origin classification for a whole chat thread.
 *
 * `ordinary` is only written by a successful new ordinary-Chat insert.
 * `morning_brief` marks a thread that has hosted official Morning Brief
 * content; it is sticky for the life of the thread. A NULL value means the
 * origin is unknown, which is the only honest answer for rows created before
 * this column existed or by a creation path that does not classify itself.
 */
export type ChatThreadProvenance = "ordinary" | "morning_brief";

/** Physical schema retains the legacy allocator until the second release. */
export const chatThreads = pgTable(
  "chat_threads",
  {
    ...chatThreadColumns(),
    /** Last seq_id reserved in this thread; reservations may remain unused. */
    lastChatEventSeqId: bigint("last_chat_event_seq_id", {
      mode: "number",
    })
      .default(0)
      .notNull(),
  },
  (table) => {
    return [
      unique("uq_chat_threads_id_user").on(table.id, table.userId),
      check(
        "chat_threads_computer_access_check",
        sql`NOT (${table.cloudBrowserEnabled} AND ${table.computerUseHostId} IS NOT NULL)`,
      ),
      check(
        "chat_threads_draft_user_message_check",
        sql`${table.draftUserMessage} IS NOT NULL
          OR COALESCE(${table.draftAttachments}, '[]'::jsonb) = '[]'::jsonb`,
      ),
      index("idx_chat_threads_user_agent_updated").on(
        table.userId,
        table.agentId,
        table.updatedAt.desc(),
      ),
      index("idx_chat_threads_user_last_read").on(
        table.userId,
        table.lastReadAt,
      ),
      index("idx_chat_threads_user_agent_pinned")
        .on(table.userId, table.agentId)
        .where(sql`${table.pinnedAt} IS NOT NULL`),
      index("idx_chat_threads_user_agent_last_message").on(
        table.userId,
        table.agentId,
        table.lastMessageAt.desc(),
      ),
      index("idx_chat_threads_user_last_message_id").on(
        table.userId,
        table.lastMessageAt.desc(),
        table.id.desc(),
      ),
    ];
  },
);
