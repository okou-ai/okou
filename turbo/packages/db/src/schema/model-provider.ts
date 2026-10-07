import {
  pgTable,
  uuid,
  text,
  varchar,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/**
 * Model Providers table
 * A member's personal subscription provider (Claude Code or Codex) and its
 * OAuth state. Credentials live on `model_provider_accounts`.
 */
export const modelProviders = pgTable(
  "model_providers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    type: varchar("type", { length: 50 }).notNull(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    // OAuth token state (mirrors `connectors`). Set/cleared by the firewall
    // refresh pipeline for OAuth-typed model providers (e.g. codex-oauth-token).
    // null tokenExpiresAt = unknown; refreshable providers auto-refresh on next use.
    tokenExpiresAt: timestamp("token_expires_at"),
    needsReconnect: boolean("needs_reconnect").notNull().default(false),
    // Captures ChatgptRefreshError.code (or equivalent) on refresh failure;
    // null on success or non-OAuth providers. Wave 3 stale-UX renders this.
    lastRefreshErrorCode: varchar("last_refresh_error_code", { length: 64 }),
    // OAuth account metadata captured at connect time. Non-OAuth provider
    // types leave these null. Plan type is unconstrained varchar so upstream
    // providers adding a new tier doesn't break inserts.
    workspaceName: varchar("workspace_name", { length: 255 }),
    planType: varchar("plan_type", { length: 32 }),
    subscriptionResetPeriod: varchar("subscription_reset_period", {
      length: 64,
    }),
    subscriptionNextResetAt: timestamp("subscription_next_reset_at"),
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
