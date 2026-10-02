import { index, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { agentphoneMessages } from "./agentphone-message";

/**
 * Per-message access grants for locally archived AgentPhone group messages.
 * Group membership is evaluated from the roster captured for that message.
 */
export const agentphoneMessageVisibility = pgTable(
  "agentphone_message_visibility",
  {
    messageId: uuid("message_id")
      .notNull()
      .references(
        () => {
          return agentphoneMessages.id;
        },
        { onDelete: "cascade" },
      ),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
  },
  (table) => {
    return [
      primaryKey({
        columns: [table.messageId, table.orgId, table.userId],
      }),
      index("idx_agentphone_message_visibility_member").on(
        table.orgId,
        table.userId,
        table.messageId,
      ),
    ];
  },
);
