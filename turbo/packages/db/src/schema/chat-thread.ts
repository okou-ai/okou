import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  unique,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { chatThreadColumns } from "../columns/chat-thread";

/**
 * Chat Threads table
 * User-facing conversation thread identity, created before any run starts.
 * Event sequence positions are allocated in `chat_event_sequences`.
 */
export const chatThreads = pgTable(
  "chat_threads",
  {
    ...chatThreadColumns(),
    // Physical-only until the runtime projection is deployed and outgoing APIs
    // and incompatible rollback artifacts have drained. Drop in a later release.
    provenance: varchar("provenance", { length: 32 }),
  },
  (table) => {
    return [
      unique("uq_chat_threads_id_user").on(table.id, table.userId),
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
