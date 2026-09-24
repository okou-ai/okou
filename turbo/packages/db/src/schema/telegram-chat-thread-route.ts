import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { chatThreads } from "./chat-thread";
import { telegramOfficialUserLinks } from "./telegram-official-user-link";
import { telegramUserLinks } from "./telegram-user-link";

/**
 * Stable mapping from a Telegram reply-chain anchor to the canonical Okou chat
 * thread that owns its queue and session chain.
 */
export const telegramChatThreadRoutes = pgTable(
  "telegram_chat_thread_routes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    telegramUserLinkId: uuid("telegram_user_link_id").references(
      () => {
        return telegramUserLinks.id;
      },
      { onDelete: "cascade" },
    ),
    telegramOfficialUserLinkId: uuid(
      "telegram_official_user_link_id",
    ).references(
      () => {
        return telegramOfficialUserLinks.id;
      },
      { onDelete: "cascade" },
    ),
    chatId: varchar("chat_id", { length: 255 }).notNull(),
    // Nullable until legacy rows are prepared before split writes activate.
    messageThreadId: integer("message_thread_id"),
    chatType: varchar("chat_type", { length: 32 }),
    deliveryMessageId: varchar("delivery_message_id", { length: 255 }),
    rootMessageId: varchar("root_message_id", { length: 255 }).notNull(),
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
      index("idx_telegram_chat_thread_routes_thread").on(table.chatThreadId),
      uniqueIndex("idx_telegram_chat_thread_routes_chat_user_link")
        .on(table.telegramUserLinkId, table.chatId, table.rootMessageId)
        .where(sql`telegram_user_link_id IS NOT NULL`),
      uniqueIndex("idx_telegram_chat_thread_routes_chat_official_link")
        .on(table.telegramOfficialUserLinkId, table.chatId, table.rootMessageId)
        .where(sql`telegram_official_user_link_id IS NOT NULL`),
      index("idx_telegram_chat_thread_routes_user_link")
        .on(table.telegramUserLinkId)
        .where(sql`telegram_user_link_id IS NOT NULL`),
      index("idx_telegram_chat_thread_routes_official_user_link")
        .on(table.telegramOfficialUserLinkId)
        .where(sql`telegram_official_user_link_id IS NOT NULL`),
      check(
        "chk_telegram_chat_thread_routes_one_owner",
        sql`(telegram_user_link_id IS NOT NULL) <> (telegram_official_user_link_id IS NOT NULL)`,
      ),
    ];
  },
);
