import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { chatThreads } from "./chat-thread";
import { teamsOrgConnections } from "./teams-org-connection";

/**
 * Stable mapping from one Teams user's view of a Teams reply thread to the
 * canonical Okou chat thread that owns its queue and session chain.
 */
export const teamsChatThreadRoutes = pgTable(
  "teams_chat_thread_routes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(
        () => {
          return teamsOrgConnections.id;
        },
        { onDelete: "cascade" },
      ),
    conversationId: varchar("conversation_id", { length: 255 }).notNull(),
    threadId: varchar("thread_id", { length: 255 }).notNull(),
    conversationType: varchar("conversation_type", { length: 32 }),
    channelId: varchar("channel_id", { length: 255 }),
    serviceUrl: text("service_url"),
    userId: text("user_id").notNull(),
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
      index("idx_teams_chat_thread_routes_thread").on(table.chatThreadId),
      uniqueIndex(
        "idx_teams_chat_thread_routes_conn_conversation_thread_user",
      ).on(
        table.connectionId,
        table.conversationId,
        table.threadId,
        table.userId,
      ),
    ];
  },
);
