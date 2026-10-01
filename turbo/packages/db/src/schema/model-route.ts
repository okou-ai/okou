import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { runModelCatalog } from "./run-model-catalog";

/**
 * Execution routes for catalog models. Names and ordering come only from
 * `run_model_catalog`.
 *
 * - `provider_type` is the route the organization or member selects:
 *   `built-in`, a BYOK provider type, or a personal subscription type.
 * - `concrete_provider_type` is the provider that serves the request. Built-in
 *   routes list one row per candidate, tried in ascending `priority`; other
 *   routes serve themselves.
 * - `subscription_type` is set only for the Auto-mode personal subscription
 *   routes backed by a member's connected personal subscription.
 * - `service_tiers` lists optional tiers besides the implicit Standard tier.
 * - `pricing_kind`/`pricing_provider` link a Built-in route to its
 *   `usage_pricing` rows, which remain the billing authority. No foreign key is
 *   possible because `usage_pricing` is keyed by category as well.
 * - `long_context_min_total_input_tokens` is the inclusive total-input
 *   boundary (input + cache read + cache creation) at which usage on a
 *   Built-in route bills the `.long_context` pricing categories. NULL means
 *   the route bills a single tier; it is part of the route's pricing rule, so
 *   BYOK and subscription routes never carry one.
 */
export const modelRoutes = pgTable(
  "model_routes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    model: varchar("model", { length: 255 })
      .notNull()
      .references(() => {
        return runModelCatalog.model;
      }),
    providerType: varchar("provider_type", { length: 64 }).notNull(),
    concreteProviderType: varchar("concrete_provider_type", {
      length: 64,
    }).notNull(),
    subscriptionType: varchar("subscription_type", { length: 40 }),
    upstreamModel: varchar("upstream_model", { length: 255 }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    priority: integer("priority").notNull().default(0),
    serviceTiers: text("service_tiers").array().notNull(),
    defaultServiceTier: varchar("default_service_tier", { length: 20 }),
    efforts: text("efforts").array().notNull(),
    defaultEffort: varchar("default_effort", { length: 20 }),
    priceTier: varchar("price_tier", { length: 8 }),
    pricingKind: varchar("pricing_kind", { length: 30 }),
    pricingProvider: varchar("pricing_provider", { length: 100 }),
    longContextMinTotalInputTokens: integer(
      "long_context_min_total_input_tokens",
    ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      unique("uq_model_routes_identity")
        .on(
          table.model,
          table.providerType,
          table.subscriptionType,
          table.concreteProviderType,
        )
        .nullsNotDistinct(),
      unique("uq_model_routes_priority")
        .on(
          table.model,
          table.providerType,
          table.subscriptionType,
          table.priority,
        )
        .nullsNotDistinct(),
      check(
        "chk_model_routes_provider_type",
        sql`${table.providerType} IN ('claude-code-oauth-token', 'anthropic-api-key', 'openrouter-api-key', 'deepseek', 'vercel-ai-gateway', 'openrouter-codex', 'vercel-ai-gateway-codex', 'openai-api-key', 'codex-oauth-token', 'azure-foundry', 'aws-bedrock', 'custom-anthropic-messages', 'custom-openai-responses', 'built-in')`,
      ),
      check(
        "chk_model_routes_concrete_provider_type",
        sql`CASE WHEN ${table.providerType} = 'built-in' THEN ${table.concreteProviderType} IN ('anthropic-api-key', 'openrouter-api-key', 'deepseek', 'openrouter-codex', 'openai-api-key') ELSE ${table.concreteProviderType} = ${table.providerType} END`,
      ),
      check(
        "chk_model_routes_subscription_type",
        sql`${table.subscriptionType} IS NULL OR (${table.subscriptionType} IN ('claude-code-oauth-token', 'codex-oauth-token') AND ${table.subscriptionType} = ${table.providerType})`,
      ),
      check("chk_model_routes_priority", sql`${table.priority} >= 0`),
      check(
        "chk_model_routes_service_tiers",
        sql`${table.serviceTiers} <@ ARRAY['priority', 'ultrafast']::text[] AND (${table.defaultServiceTier} IS NULL OR ${table.defaultServiceTier} = ANY(${table.serviceTiers}))`,
      ),
      check(
        "chk_model_routes_efforts",
        sql`${table.efforts} <@ ARRAY['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'extra', 'ultracode']::text[] AND (${table.defaultEffort} IS NULL OR ${table.defaultEffort} = ANY(${table.efforts}))`,
      ),
      check(
        "chk_model_routes_price_tier",
        sql`${table.priceTier} IS NULL OR (${table.providerType} = 'built-in' AND ${table.priceTier} IN ('$', '$$', '$$$', '$$$$'))`,
      ),
      check(
        "chk_model_routes_pricing_link",
        sql`CASE WHEN ${table.providerType} = 'built-in' THEN ${table.pricingKind} = 'model' AND ${table.pricingProvider} IS NOT NULL ELSE ${table.pricingKind} IS NULL AND ${table.pricingProvider} IS NULL END`,
      ),
      check(
        "chk_model_routes_long_context_threshold",
        sql`${table.longContextMinTotalInputTokens} IS NULL OR (${table.providerType} = 'built-in' AND ${table.longContextMinTotalInputTokens} > 0)`,
      ),
    ];
  },
);
