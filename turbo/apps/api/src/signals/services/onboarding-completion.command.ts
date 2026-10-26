import type { OnboardingIndustry } from "@okouai/api-contracts/contracts/onboarding";
import { orgTierSchema } from "@okouai/api-contracts/contracts/orgs";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { object, string } from "zod";
import { parseRawRows } from "../../lib/db-raw-rows";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { orgPlanEntitlementValues } from "./org-plan-entitlements.service";

interface OrgOnboardingCompletion {
  readonly orgId: string;
  readonly userId: string;
  readonly industry?: OnboardingIndustry;
}

const createdMetadataSchema = object({
  org_id: string(),
  tier: string(),
});

/** Metadata and entitlement bootstrap commit together. */
export const markOrgOnboardingComplete$ = command(
  async ({ set }, args: OrgOnboardingCompletion, signal: AbortSignal) => {
    const db = set(writeDb$);
    const now = nowDate();
    const industry =
      args.industry === undefined ? {} : { onboardingIndustry: args.industry };
    signal.throwIfAborted();
    const metadata = db
      .insert(orgMetadataCanonicalWrites)
      .values({
        orgId: args.orgId,
        onboardingComplete: true,
        ...industry,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: orgMetadataCanonicalWrites.orgId })
      .returning({ orgId: orgMetadata.orgId, tier: orgMetadata.tier })
      .getSQL();
    // Join canonical values to the actual returned tier. An unknown tier still
    // completes metadata without publishing an entitlement.
    const entitlementRows = orgTierSchema.options.map((tier) => {
      const values = orgPlanEntitlementValues(
        { orgId: args.orgId, tier, source: "org_metadata_migration" },
        { stripeSubscriptionId: null, sourceMetadata: {} },
      );
      return sql`(${values.planKey}, ${values.planRank}::integer,
        ${values.source}, ${values.status}, ${values.baseConcurrencyLimit}::integer,
        ${values.canBuyConcurrency}::boolean, ${values.canBuyCredits}::boolean,
        ${values.showUsagePack}::boolean, ${values.autoRechargeAllowed}::boolean,
        ${values.restrictedBuiltInModels}::boolean,
        ${values.workflowWebhookTriggerAllowed}::boolean,
        ${values.audioLifetimeLimit}::integer, ${values.audioDailyRateLimit}::integer,
        ${values.audioDailyDurationSeconds}::integer, ${values.stripeSubscriptionId},
        ${values.stripePriceId},
        ${sql.param(values.currentPeriodStart, orgPlanEntitlements.currentPeriodStart)}::timestamp,
        ${sql.param(values.currentPeriodEnd, orgPlanEntitlements.currentPeriodEnd)}::timestamp,
        ${sql.param(values.cancelAt, orgPlanEntitlements.cancelAt)}::timestamp,
        ${sql.param(values.expiresAt, orgPlanEntitlements.expiresAt)}::timestamp,
        ${sql.param(values.sourceMetadata, orgPlanEntitlements.sourceMetadata)}::jsonb,
        ${sql.param(values.updatedAt, orgPlanEntitlements.updatedAt)}::timestamp)`;
    });
    // Keep the partial Plan target list: Drizzle insert-select requires every
    // column and would replace omitted database defaults. Both DML CTEs execute
    // once, atomically, even though only the metadata identity is selected.
    const [created] = parseRawRows(
      createdMetadataSchema,
      await db.execute(sql`WITH created_metadata AS (${metadata}), entitlement_values (
        plan_key, plan_rank, source, status, base_concurrency_limit,
        can_buy_concurrency, can_buy_credits, show_usage_pack, auto_recharge_allowed,
        restricted_built_in_models, workflow_webhook_trigger_allowed,
        audio_lifetime_limit, audio_daily_rate_limit, audio_daily_duration_seconds,
        stripe_subscription_id, stripe_price_id, current_period_start,
        current_period_end, cancel_at, expires_at, source_metadata, updated_at
      ) AS (VALUES ${sql.join(entitlementRows, sql`, `)}), created_entitlement AS (
        INSERT INTO ${orgPlanEntitlements} (
          org_id, plan_key, plan_rank, source, status, base_concurrency_limit,
          can_buy_concurrency, can_buy_credits, show_usage_pack, auto_recharge_allowed,
          restricted_built_in_models, workflow_webhook_trigger_allowed,
          audio_lifetime_limit, audio_daily_rate_limit, audio_daily_duration_seconds,
          stripe_subscription_id, stripe_price_id, current_period_start,
          current_period_end, cancel_at, expires_at, source_metadata, updated_at
        ) SELECT created_metadata.org_id, entitlement_values.* FROM created_metadata
          JOIN entitlement_values ON ${eq(sql`created_metadata.tier`, sql`entitlement_values.plan_key`)}
        ON CONFLICT (org_id) DO NOTHING
      ) SELECT org_id, tier FROM created_metadata LIMIT 1`),
    );
    // A conflicting INSERT can wait for a creator invisible to its statement
    // snapshot. Keep this UPDATE in a separate, fresh snapshot; existing
    // metadata never repairs or replaces Plan.
    const [written] = created
      ? [created]
      : await db
          .update(orgMetadataCanonicalWrites)
          .set({ onboardingComplete: true, ...industry, updatedAt: now })
          .where(
            and(
              eq(orgMetadataCanonicalWrites.orgId, args.orgId),
              eq(orgMetadataCanonicalWrites.onboardingComplete, false),
            ),
          )
          .returning({ orgId: orgMetadata.orgId, tier: orgMetadata.tier });
    if (!written) {
      return false;
    }
    // Autocommit may already be durable when cancellation is observed here.
    signal.throwIfAborted();
    return true;
  },
);
