import {
  boolean,
  integer,
  jsonb,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import type { OrgPlanEntitlementSourceMetadata } from "../jsonb-contracts/org-plan-entitlement";

/** Canonical columns shared by application and migration mappings. */
export function orgPlanEntitlementColumns() {
  return {
    orgId: text("org_id").primaryKey(),
    planKey: text("plan_key").notNull(),
    planRank: integer("plan_rank").notNull(),
    source: varchar("source", { length: 50 }).notNull(),
    status: varchar("status", { length: 30 }).notNull().default("active"),
    baseConcurrencyLimit: integer("base_concurrency_limit")
      .notNull()
      .default(0),
    canBuyConcurrency: boolean("can_buy_concurrency").notNull().default(false),
    canBuyCredits: boolean("can_buy_credits").notNull().default(false),
    showUsagePack: boolean("show_usage_pack").notNull().default(false),
    autoRechargeAllowed: boolean("auto_recharge_allowed")
      .notNull()
      .default(false),
    supportByok: boolean("support_byok").notNull().default(false),
    restrictedBuiltInModels: boolean("restricted_built_in_models").notNull(),
    videoGenerationAllowed: boolean("video_generation_allowed")
      .notNull()
      .default(false),
    workflowWebhookTriggerAllowed: boolean("workflow_webhook_trigger_allowed")
      .notNull()
      .default(false),
    audioLifetimeLimit: integer("audio_lifetime_limit"),
    audioDailyRateLimit: integer("audio_daily_rate_limit").notNull().default(0),
    audioDailyDurationSeconds: integer("audio_daily_duration_seconds")
      .notNull()
      .default(0),
    stripeSubscriptionId: text("stripe_subscription_id"),
    stripeProductId: text("stripe_product_id"),
    stripePriceId: text("stripe_price_id"),
    currentPeriodStart: timestamp("current_period_start"),
    currentPeriodEnd: timestamp("current_period_end"),
    cancelAt: timestamp("cancel_at"),
    expiresAt: timestamp("expires_at"),
    metadataVersion: text("metadata_version").notNull().default("1"),
    metadataHash: text("metadata_hash"),
    sourceMetadata: jsonb("source_metadata")
      .$type<OrgPlanEntitlementSourceMetadata>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  };
}
