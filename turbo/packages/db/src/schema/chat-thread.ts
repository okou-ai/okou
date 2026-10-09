import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
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

/**
 * Chat Threads table
 * User-facing conversation thread identity, created before any run starts.
 * Event sequence positions are allocated in `chat_event_sequences`.
 */
export const chatThreads = pgTable(
  "chat_threads",
  chatThreadColumns(),
  (table) => {
    return [
      unique("uq_chat_threads_id_user").on(table.id, table.userId),
      check(
        "chat_threads_selected_model_check",
        sql`char_length(${table.selectedModel}) > 0`,
      ),
      check(
        "chat_threads_explicit_model_settings_check",
        sql`jsonb_typeof(${table.modelSettings}) = 'object' AND NOT jsonb_path_exists(${table.modelSettings}, '$.keyvalue() ? (@.key == "auto" || @.key == "okou-1.0" || @.key == "okou-1.0-pro" || @.key == "okou-1.0-max" || @.key starts with "@preset/")')`,
      ),
      uniqueIndex("chat_threads_agent_session_unique").on(table.agentSessionId),
      check(
        "chk_chat_threads_codex_service_tier",
        sql`${table.codexServiceTier} IS NULL OR ${table.codexServiceTier} = 'fast'`,
      ),
      check(
        "chat_threads_computer_access_check",
        sql`NOT (${table.cloudBrowserEnabled} AND ${table.computerUseHostId} IS NOT NULL)`,
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
