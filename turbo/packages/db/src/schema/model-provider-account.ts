import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { modelProviders } from "./model-provider";

/**
 * Concrete personal subscription credentials attached to one logical model
 * provider route. Organization model providers remain stored only in
 * `model_providers`.
 */
export const modelProviderAccounts = pgTable(
  "model_provider_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    modelProviderId: uuid("model_provider_id")
      .notNull()
      .references(
        () => {
          return modelProviders.id;
        },
        { onDelete: "cascade" },
      ),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    type: varchar("type", { length: 50 }).notNull(),
    authMethod: varchar("auth_method", { length: 50 }),
    isActive: boolean("is_active").notNull().default(false),
    disconnectedAt: timestamp("disconnected_at"),
    externalAccountId: varchar("external_account_id", { length: 255 }),
    accountEmail: varchar("account_email", { length: 320 }),
    workspaceName: varchar("workspace_name", { length: 255 }),
    planType: varchar("plan_type", { length: 32 }),
    tokenExpiresAt: timestamp("token_expires_at"),
    needsReconnect: boolean("needs_reconnect").notNull().default(false),
    lastRefreshErrorCode: varchar("last_refresh_error_code", { length: 64 }),
    subscriptionResetPeriod: varchar("subscription_reset_period", {
      length: 64,
    }),
    subscriptionNextResetAt: timestamp("subscription_next_reset_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_model_provider_accounts_provider").on(table.modelProviderId),
      index("idx_model_provider_accounts_owner_type").on(
        table.orgId,
        table.userId,
        table.type,
      ),
      uniqueIndex("idx_model_provider_accounts_one_active")
        .on(table.modelProviderId)
        .where(sql`${table.isActive} = true`),
    ];
  },
);

export const modelProviderAccountSecrets = pgTable(
  "model_provider_account_secrets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    modelProviderAccountId: uuid("model_provider_account_id")
      .notNull()
      .references(
        () => {
          return modelProviderAccounts.id;
        },
        { onDelete: "cascade" },
      ),
    name: varchar("name", { length: 255 }).notNull(),
    encryptedValue: text("encrypted_value").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_model_provider_account_secrets_account_name").on(
        table.modelProviderAccountId,
        table.name,
      ),
    ];
  },
);
