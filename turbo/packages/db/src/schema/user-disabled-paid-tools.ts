import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/** Sparse personal preferences: a row means the tool is disabled. */
export const userDisabledPaidTools = pgTable(
  "user_disabled_paid_tools",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    toolId: text("tool_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({ columns: [table.orgId, table.userId, table.toolId] }),
      index("idx_user_disabled_paid_tools_user_id").on(table.userId),
    ];
  },
);
