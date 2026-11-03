import { pgTable, uniqueIndex, varchar } from "drizzle-orm/pg-core";

/** Accepted group webhook identities, including legacy unarchived events. */
export const agentphoneGroupMessageReceipts = pgTable(
  "agentphone_group_message_receipts",
  {
    agentphoneMessageId: varchar("agentphone_message_id", {
      length: 255,
    }).primaryKey(),
    webhookId: varchar("webhook_id", { length: 255 }),
  },
  (table) => {
    return [
      uniqueIndex("idx_agentphone_group_message_receipts_webhook_id").on(
        table.webhookId,
      ),
    ];
  },
);
