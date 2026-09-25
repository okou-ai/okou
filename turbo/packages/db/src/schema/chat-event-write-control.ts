import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** One global, durable activation decision. No user or organization overrides. */
export const chatEventWriteControl = pgTable(
  "chat_event_write_control",
  {
    id: text("id").primaryKey().default("global"),
    activatedAt: timestamp("activated_at"),
  },
  (table) => {
    return [
      check("chat_event_write_control_singleton", sql`${table.id} = 'global'`),
    ];
  },
);
