import { check, index, pgTable, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { orgPlanEntitlementColumns } from "../columns/org-plan-entitlement";

/**
 * Current org plan capability snapshot.
 *
 * Stripe product metadata and Atom grants are copied here at delivery time so
 * runtime admission can make local decisions without reading Stripe.
 */
export const orgPlanEntitlements = pgTable(
  "org_plan_entitlements",
  orgPlanEntitlementColumns(),
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
