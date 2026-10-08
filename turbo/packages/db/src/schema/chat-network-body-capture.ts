import { index, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

import { chatThreads } from "./chat-thread";

/**
 * Chat inputs whose run captures network request and response bodies. A
 * direct send that asks for capture records its input event here before it
 * enqueues; the pick reads the row for the queue head it launches. The table
 * holds nothing else.
 */
export const chatNetworkBodyCaptures = pgTable(
  "chat_network_body_captures",
  {
    chatEventId: uuid("chat_event_id").primaryKey(),
    chatThreadId: uuid("chat_thread_id")
      .notNull()
      .references(
        () => {
          return chatThreads.id;
        },
        { onDelete: "cascade" },
      ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("chat_network_body_captures_chat_thread_idx").on(
        table.chatThreadId,
      ),
    ];
  },
);
