import { boolean, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

/** Delivery choices are personal to a workspace. */
export const feedPreferences = pgTable(
  "feed_preferences",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    suggestions: boolean("suggestions").notNull().default(true),
    whatsNew: boolean("whats_new").notNull().default(true),
    offers: boolean("offers").notNull().default(true),
    systemUpdates: boolean("system_updates").notNull().default(true),
  },
  (table) => {
    return [primaryKey({ columns: [table.orgId, table.userId] })];
  },
);
