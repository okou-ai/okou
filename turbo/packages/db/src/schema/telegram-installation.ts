import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { agents } from "./agent";

/**
 * Telegram Installations table
 * Stores bot-level tokens and default agent for Telegram bot integrations.
 * One record per Telegram bot. Each bot has exactly one default agent.
 *
 * Ownership model: each installation is owned by an individual Okou user.
 * A user may register multiple bots; different users' bots are isolated.
 */
export const telegramInstallations = pgTable(
  "telegram_installations",
  {
    telegramBotId: varchar("telegram_bot_id", { length: 255 }).primaryKey(),
    botUsername: varchar("bot_username", { length: 255 }),
    // Bot token encrypted with the persistent-secret KMS rollout envelope.
    encryptedBotToken: text("encrypted_bot_token").notNull(),
    // Secret token for webhook verification (X-Telegram-Bot-Api-Secret-Token)
    webhookSecret: varchar("webhook_secret", { length: 255 }).notNull(),
    // Bot default agent — always set at registration time.
    defaultAgentId: uuid("default_agent_id").references(
      () => {
        return agents.id;
      },
      { onDelete: "cascade" },
    ),
    // Owner: the Okou user who registered the bot (Clerk user ID).
    ownerUserId: text("owner_user_id").notNull(),
    // Org anchor: snapshot of the owner's current org at registration time.
    orgId: text("org_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_telegram_installations_owner").on(table.ownerUserId),
      index("idx_telegram_installations_org").on(table.orgId),
    ];
  },
);
