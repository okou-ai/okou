import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/**
 * Model Providers table
 * A member's logical personal subscription provider (Claude Code or Codex).
 * OAuth state, account metadata and credentials live on
 * `model_provider_accounts`.
 */
export const modelProviders = pgTable(
  "model_providers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    type: varchar("type", { length: 50 }).notNull(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_model_providers_org").on(table.orgId),
      uniqueIndex("idx_model_providers_org_user_type").on(
        table.orgId,
        table.userId,
        table.type,
      ),
    ];
  },
);
