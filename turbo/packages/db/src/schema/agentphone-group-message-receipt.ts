import { pgTable, uniqueIndex, varchar } from "drizzle-orm/pg-core";

/** Idempotency keys for group webhooks that cannot be safely archived. */
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
