import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Where the chat event retention sweep resumes, keyed by sweep scope. Rows the
 * sweep had to hold are passed over until the sweep restarts from the oldest
 * row, instead of being rescanned on every run.
 */
export const chatEventRetentionCursors = pgTable(
  "chat_event_retention_cursors",
  {
    scopeKey: text("scope_key").primaryKey(),
    /** Last scanned `chat_events.created_at`, compared at full precision. */
    lastCreatedAt: timestamp("last_created_at", { mode: "string" }).notNull(),
    lastEventId: uuid("last_event_id").notNull(),
    sweepStartedAt: timestamp("sweep_started_at").notNull(),
  },
);
