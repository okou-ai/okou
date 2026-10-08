import {
  boolean,
  integer,
  jsonb,
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { telegramOfficialUserLinks } from "./telegram-official-user-link";
import type { TelegramMessageEntities } from "@okouai/db/jsonb-contracts/telegram-message";
export type { TelegramMessageEntity } from "@okouai/db/jsonb-contracts/telegram-message";

/**
 * Telegram Messages table
 * Stores messages received by the bot for context retrieval.
 * Telegram Bot API has no history API, so we must store messages ourselves.
 * Messages are retained for 30 days (cleaned up by cron job).
 */
export const telegramMessages = pgTable(
  "telegram_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    officialOrgId: text("official_org_id").notNull(),
    officialUserLinkId: uuid("official_user_link_id").references(
      () => {
        return telegramOfficialUserLinks.id;
      },
      { onDelete: "set null" },
    ),
    chatId: varchar("chat_id", { length: 255 }).notNull(),
    messageId: varchar("message_id", { length: 255 }).notNull(),
    fromUserId: varchar("from_user_id", { length: 255 }).notNull(),
    fromUsername: varchar("from_username", { length: 255 }),
    fromDisplayName: varchar("from_display_name", { length: 255 }),
    text: text("text"),
    /** Telegram file_id for downloadable attachments — used for context downloads */
    fileId: varchar("file_id", { length: 255 }),
    fileType: varchar("file_type", { length: 32 }),
    fileName: text("file_name"),
    fileMimeType: varchar("file_mime_type", { length: 255 }),
    fileSize: integer("file_size"),
    fileWidth: integer("file_width"),
    fileHeight: integer("file_height"),
    fileDuration: integer("file_duration"),
    entities: jsonb("entities").$type<TelegramMessageEntities>(),
    isBot: boolean("is_bot").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_telegram_messages_official_unique")
        .on(table.officialOrgId, table.chatId, table.messageId)
        .where(sql`official_org_id IS NOT NULL`),
      index("idx_telegram_messages_official_chat")
        .on(table.officialOrgId, table.chatId)
        .where(sql`official_org_id IS NOT NULL`),
      // Index for 30-day cleanup cron
      index("idx_telegram_messages_created_at").on(table.createdAt),
    ];
  },
);
