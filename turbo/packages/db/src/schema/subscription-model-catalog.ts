import { sql } from "drizzle-orm";
import {
  check,
  integer,
  pgTable,
  uniqueIndex,
  uuid,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

/** Models exposed to members by a connected personal subscription in Auto mode. */
export const subscriptionModelCatalog = pgTable(
  "subscription_model_catalog",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    subscriptionType: varchar("subscription_type", { length: 40 }).notNull(),
    model: varchar("model", { length: 255 }).notNull(),
    displayName: varchar("display_name", { length: 128 }).notNull(),
    efforts: text("efforts").array().notNull(),
    // Standard is implicit; priority is an optional additional service tier.
    serviceTier: varchar("service_tier", { length: 20 }),
    sortOrder: integer("sort_order").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_subscription_model_catalog_type_model").on(
      table.subscriptionType,
      table.model,
    ),
    check(
      "chk_subscription_model_catalog_type",
      sql`${table.subscriptionType} IN ('claude-code-oauth-token', 'codex-oauth-token')`,
    ),
    check(
      "chk_subscription_model_catalog_service_tier",
      sql`${table.serviceTier} IS NULL OR ${table.serviceTier} = 'priority'`,
    ),
  ],
);
