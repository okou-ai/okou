import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { OrgPlanEntitlementSourceMetadata } from "../jsonb-contracts/org-plan-entitlement";

function orgPlanEntitlementColumnsBeforeModelRestriction() {
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
    // Rollout compatibility only; remove after the serving/rollback gate in #32575.
    legacyMemberInviteUsagePackRequired: boolean(
      "member_invite_usage_pack_required",
    )
      .notNull()
      .default(false),
    showUsagePack: boolean("show_usage_pack").notNull().default(false),
    autoRechargeAllowed: boolean("auto_recharge_allowed")
      .notNull()
      .default(false),
    supportByok: boolean("support_byok").notNull().default(false),
  };
}

function orgPlanEntitlementColumnsAfterModelRestriction() {
  return {
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

function canonicalModelRestrictionColumn() {
  return boolean("restricted_built_in_models").notNull();
}

/**
 * Canonical insert projection for the org plan capability snapshot.
 *
 * Drizzle emits every mapped column in an INSERT target list, so active writes
 * use this projection to exclude the legacy compatibility column.
 */
export function orgPlanEntitlementCanonicalColumns() {
  return {
    ...orgPlanEntitlementColumnsBeforeModelRestriction(),
    restrictedBuiltInModels: canonicalModelRestrictionColumn(),
    ...orgPlanEntitlementColumnsAfterModelRestriction(),
  };
}

/**
 * Current org plan capability snapshot.
 *
 * Stripe product metadata and Atom grants are copied here at delivery time so
 * runtime admission can make local decisions without reading Stripe.
 */
export const orgPlanEntitlements = pgTable(
  "org_plan_entitlements",
  {
    ...orgPlanEntitlementColumnsBeforeModelRestriction(),
    ...orgPlanEntitlementColumnsAfterModelRestriction(),
    restrictedBuiltInModels: canonicalModelRestrictionColumn(),
    // Compatibility for outgoing/rollback readers. Current admission uses
    // status; the API mirrors it explicitly after canonical writes (#33747).
    // Canonical inserts omit this column. Column retirement: #32575.
    legacyMemberInvitationAllowed: boolean("member_invitation_allowed")
      .notNull()
      .default(false),
  },
  (table) => {
    return [
      uniqueIndex("uq_org_plan_entitlements_stripe_subscription").on(
        table.stripeSubscriptionId,
      ),
      index("idx_org_plan_entitlements_status").on(table.status),
      index("idx_org_plan_entitlements_source").on(table.source),
      index("idx_org_plan_entitlements_expires").on(table.expiresAt),
      check("chk_org_plan_entitlements_plan_rank", sql`${table.planRank} >= 0`),
      check(
        "chk_org_plan_entitlements_base_concurrency",
        sql`${table.baseConcurrencyLimit} >= 0`,
      ),
      check(
        "chk_org_plan_entitlements_audio_lifetime",
        sql`${table.audioLifetimeLimit} IS NULL OR ${table.audioLifetimeLimit} >= 0`,
      ),
      check(
        "chk_org_plan_entitlements_audio_daily_rate",
        sql`${table.audioDailyRateLimit} >= 0`,
      ),
      check(
        "chk_org_plan_entitlements_audio_daily_duration",
        sql`${table.audioDailyDurationSeconds} >= 0`,
      ),
      check(
        "chk_org_plan_entitlements_period",
        sql`${table.currentPeriodStart} IS NULL OR ${table.currentPeriodEnd} IS NULL OR ${table.currentPeriodEnd} > ${table.currentPeriodStart}`,
      ),
    ];
  },
);
