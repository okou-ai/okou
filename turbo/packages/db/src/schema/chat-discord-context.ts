import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import type {
  ChatDiscordMentionDisplayNames,
  ChatDiscordMessageAssets,
  ChatDiscordMessageFiles,
} from "@okouai/db/jsonb-contracts/chat-discord-context";
import {
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { discordChatThreadRoutes } from "./discord-chat-thread-route";

/** Server-private launch snapshot whose ownership remains relational after admission. */
export const chatDiscordContext = pgTable(
  "chat_discord_context",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    connectionId: uuid("connection_id").notNull(),
    routeId: uuid("route_id").notNull(),
    chatThreadId: uuid("chat_thread_id").notNull(),
    guildId: text("guild_id"),
    channelId: text("channel_id").notNull(),
    messageId: text("message_id").notNull(),
    botUserId: text("bot_user_id").notNull(),
    publicBrand: text("public_brand").$type<PublicBrand>().notNull(),
    conversationContext: text("conversation_context"),
    messageText: text("message_text").notNull(),
    messageFiles: jsonb("message_files")
      .$type<ChatDiscordMessageFiles>()
      .default([])
      .notNull(),
    messageAssets: jsonb("message_assets")
      .$type<ChatDiscordMessageAssets>()
      .default([])
      .notNull(),
    mentionDisplayNames: jsonb("mention_display_names")
      .$type<ChatDiscordMentionDisplayNames>()
      .default({})
      .notNull(),
    senderDisplayName: text("sender_display_name"),
    senderUserId: text("sender_user_id").notNull(),
    channelType: text("channel_type")
      .$type<"channel" | "dm" | "group_dm" | "thread">()
      .notNull(),
    threadId: text("thread_id"),
    destinationChannelId: text("destination_channel_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      foreignKey({
        name: "chat_discord_context_route_owner_fk",
        columns: [table.routeId, table.connectionId, table.chatThreadId],
        foreignColumns: [
          discordChatThreadRoutes.id,
          discordChatThreadRoutes.connectionId,
          discordChatThreadRoutes.chatThreadId,
        ],
      }).onDelete("cascade"),
      index("idx_chat_discord_context_route").on(table.routeId),
      index("idx_chat_discord_context_chat").on(table.chatThreadId),
    ];
  },
);
