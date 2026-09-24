import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { chatThreads } from "./chat-thread";

export const chatTelegramContext = pgTable(
  "chat_telegram_context",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    chatThreadId: uuid("chat_thread_id")
      .notNull()
      .references(
        () => {
          return chatThreads.id;
        },
        { onDelete: "cascade" },
      ),
    chatId: text("chat_id").notNull(),
    messageId: text("message_id").notNull(),
    messageThreadId: integer("message_thread_id"),
    /**
     * Server-private Telegram launch material retained with the trigger
     * context. Thread context is frozen at admission because re-reading the
     * Telegram message history at claim would include messages received later.
     * Safety depends on read paths projecting only explicitly required columns.
     */
    messageText: text("message_text"),
    threadContext: text("thread_context"),
    rootMessageId: text("root_message_id"),
    thinkingMessageId: text("thinking_message_id"),
    /** Product brand derived from the Telegram webhook hostname at ingress. */
    publicBrand: text("public_brand").$type<PublicBrand>(),
    userLinkId: uuid("user_link_id"),
    userLinkKind: text("user_link_kind").$type<"custom" | "official">(),
    chatType: text("chat_type").notNull(),
    senderUserId: text("sender_user_id"),
    senderDisplayName: text("sender_display_name"),
    senderUsername: text("sender_username"),
    senderLanguage: text("sender_language"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("chat_telegram_context_thread_idx").on(table.chatThreadId)],
);
