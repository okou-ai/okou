import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Durable cleanup identities for immutable screenshot candidates, including
 * rejected uploads. An accepted preview keeps its identity dormant while the
 * screenshot pointer references it; replacement/removal makes it eligible.
 * The row deliberately has no thread foreign key: cleanup must remain retryable
 * after the owning thread is deleted.
 */
export const browserSessionScreenshotDeletions = pgTable(
  "browser_session_screenshot_deletions",
  {
    objectKey: text("object_key").primaryKey(),
    chatThreadId: uuid("chat_thread_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
);
