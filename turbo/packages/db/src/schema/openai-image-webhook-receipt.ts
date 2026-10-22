import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Provider event identity deduplicates deliveries, including before a generation
// has persisted its response ID. Never retain the provider payload here.
export const openaiImageWebhookReceipts = pgTable(
  "openai_image_webhook_receipts",
  {
    eventId: text("event_id").primaryKey(),
    responseId: text("response_id").notNull(),
    eventType: text("event_type").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    processedAt: timestamp("processed_at"),
  },
  (table) => {
    return [
      index("idx_openai_image_webhook_receipts_response_id").on(
        table.responseId,
      ),
      index("idx_openai_image_webhook_receipts_processed_at").on(
        table.processedAt,
        table.updatedAt,
      ),
    ];
  },
);
