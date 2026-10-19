import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { agentphoneUserLinks } from "./agentphone-user-link";

/** One optional contact card following a new binding's text-only welcome. */
export const agentphoneContactCardDeliveries = pgTable(
  "agentphone_contact_card_deliveries",
  {
    userLinkId: uuid("user_link_id").primaryKey(),
    status: text("status", {
      enum: ["pending", "unknown", "sent", "failed"],
    })
      .default("pending")
      .notNull(),
    conversationId: text("conversation_id"),
    attemptMessageId: text("attempt_message_id"),
    attemptedAt: timestamp("attempted_at"),
    providerMessageId: text("provider_message_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      foreignKey({
        name: "agentphone_contact_card_user_link_fk",
        columns: [table.userLinkId],
        foreignColumns: [agentphoneUserLinks.id],
      }).onDelete("cascade"),
      check(
        "agentphone_contact_card_status",
        sql`${table.status} IN ('pending', 'unknown', 'sent', 'failed')`,
      ),
      check(
        "agentphone_contact_card_attempt",
        sql`${table.status} = 'pending' OR (${table.conversationId} IS NOT NULL AND ${table.attemptMessageId} IS NOT NULL AND ${table.attemptedAt} IS NOT NULL)`,
      ),
      check(
        "agentphone_contact_card_receipt",
        sql`(${table.status} = 'sent') = (${table.providerMessageId} IS NOT NULL)`,
      ),
    ];
  },
);
