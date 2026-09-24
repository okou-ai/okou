import {
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { chatThreads } from "./chat-thread";
import { discordOrgConnections } from "./discord-org-connection";

/** Sticky canonical chat ownership for one user's guild thread or DM session. */
export const discordChatThreadRoutes = pgTable(
  "discord_chat_thread_routes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    connectionId: uuid("connection_id").notNull(),
    channelId: varchar("channel_id", { length: 255 }).notNull(),
    sessionKey: text("session_key").notNull(),
    userId: text("user_id").notNull(),
    chatThreadId: uuid("chat_thread_id").notNull(),
    /** Persisted after native thread creation; absent while that side effect is retried. */
    destinationChannelId: varchar("destination_channel_id", { length: 255 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      unique("uq_discord_chat_thread_routes_session").on(
        table.connectionId,
        table.channelId,
        table.sessionKey,
        table.userId,
      ),
      unique("uq_discord_chat_thread_routes_connection").on(
        table.id,
        table.connectionId,
      ),
      unique("uq_discord_chat_thread_routes_context").on(
        table.id,
        table.connectionId,
        table.chatThreadId,
      ),
      foreignKey({
        name: "discord_chat_thread_routes_connection_owner_fk",
        columns: [table.connectionId, table.userId],
        foreignColumns: [
          discordOrgConnections.id,
          discordOrgConnections.userId,
        ],
      }).onDelete("cascade"),
      foreignKey({
        name: "discord_chat_thread_routes_chat_owner_fk",
        columns: [table.chatThreadId, table.userId],
        foreignColumns: [chatThreads.id, chatThreads.userId],
      }).onDelete("cascade"),
      index("idx_discord_chat_thread_routes_chat").on(table.chatThreadId),
    ];
  },
);
