import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import {
  usagePackSubscriptions,
  usagePackAllocations,
} from "@okouai/db/schema/usage-pack-subscription";
import {
  and,
  eq,
  exists,
  gt,
  not,
  inArray,
  ne,
  notInArray,
  sql,
  type SQL,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import type { orgPlanEntitlementValues } from "./org-plan-entitlements.service";

function legacyPlanMemberPackPresence(
  orgId: string,
  subscriptionId: string,
): SQL {
  return exists(
    new QueryBuilder()
      .select({ id: usagePackAllocations.id })
      .from(usagePackSubscriptions)
      .innerJoin(
        usagePackAllocations,
        eq(
          usagePackAllocations.usagePackSubscriptionId,
          usagePackSubscriptions.id,
        ),
      )
      .where(
        and(
          eq(usagePackSubscriptions.orgId, orgId),
          eq(usagePackSubscriptions.stripeSubscriptionId, subscriptionId),
          notInArray(usagePackSubscriptions.subscriptionStatus, [
            "canceled",
            "incomplete_expired",
            "invalid",
          ]),
          inArray(usagePackAllocations.status, [
            "pending_payment",
            "active",
            "pending_invitation",
            "paid_pending_invitation",
          ]),
        ),
      ),
  );
}

/** Pure SQL/values only; parentOrgIds selects the owning wallet UPDATE RETURNING. */
export function legacyPlanSubscriptionEntitlementPublication(
  values: ReturnType<typeof orgPlanEntitlementValues>,
  parentOrgIds: SQL,
  subscriptionId: string,
) {
  const otherOwner = exists(
    new QueryBuilder()
      .select({ orgId: orgPlanEntitlements.orgId })
      .from(orgPlanEntitlements)
      .where(
        and(
          eq(orgPlanEntitlements.stripeSubscriptionId, subscriptionId),
          ne(orgPlanEntitlements.orgId, values.orgId),
        ),
      ),
  );
  const projected = {
    ...values,
    stripeProductId: null,
    metadataHash: null,
    showUsagePack: values.showUsagePack
      ? legacyPlanMemberPackPresence(values.orgId, subscriptionId)
      : sql`false`,
    stripeSubscriptionId: sql`CASE WHEN ${otherOwner} THEN NULL ELSE ${subscriptionId} END`,
    sourceMetadata: sql`CASE WHEN ${otherOwner} THEN ${sql.param(
      {
        ...values.sourceMetadata,
        stripeSubscriptionSnapshotSkipped: "duplicate_stripe_subscription_id",
      },
      orgPlanEntitlements.sourceMetadata,
    )}::jsonb
    ELSE ${sql.param(values.sourceMetadata, orgPlanEntitlements.sourceMetadata)}::jsonb END`,
  };
  // The installed INSERT SELECT builder requires all 27 columns in schema order.
  // Keep current schema defaults on insert and exclude them from conflict SET.
  return {
    values: projected,
    source: sql`SELECT
    legacy_plan_rows.org_id,
    ${sql.param(values.planKey, orgPlanEntitlements.planKey)},
    ${sql.param(values.planRank, orgPlanEntitlements.planRank)},
    ${sql.param(values.source, orgPlanEntitlements.source)},
    ${sql.param(values.status, orgPlanEntitlements.status)},
    ${sql.param(values.baseConcurrencyLimit, orgPlanEntitlements.baseConcurrencyLimit)},
    ${sql.param(values.canBuyConcurrency, orgPlanEntitlements.canBuyConcurrency)},
    ${sql.param(values.canBuyCredits, orgPlanEntitlements.canBuyCredits)},
    ${projected.showUsagePack},
    ${sql.param(values.autoRechargeAllowed, orgPlanEntitlements.autoRechargeAllowed)},
    ${sql.param(values.restrictedBuiltInModels, orgPlanEntitlements.restrictedBuiltInModels)},
    ${sql.param(values.workflowWebhookTriggerAllowed, orgPlanEntitlements.workflowWebhookTriggerAllowed)},
    ${sql.param(values.audioLifetimeLimit, orgPlanEntitlements.audioLifetimeLimit)},
    ${sql.param(values.audioDailyRateLimit, orgPlanEntitlements.audioDailyRateLimit)},
    ${sql.param(values.audioDailyDurationSeconds, orgPlanEntitlements.audioDailyDurationSeconds)},
    ${projected.stripeSubscriptionId},
    NULL,
    ${sql.param(values.stripePriceId, orgPlanEntitlements.stripePriceId)},
    ${sql.param(values.currentPeriodStart, orgPlanEntitlements.currentPeriodStart)},
    ${sql.param(values.currentPeriodEnd, orgPlanEntitlements.currentPeriodEnd)},
    ${sql.param(values.cancelAt, orgPlanEntitlements.cancelAt)},
    ${sql.param(values.expiresAt, orgPlanEntitlements.expiresAt)},
    '1', NULL, ${projected.sourceMetadata}, now()::timestamp,
    ${sql.param(values.updatedAt, orgPlanEntitlements.updatedAt)}
    FROM (${parentOrgIds}) AS legacy_plan_rows WHERE true`,
  };
}

export function trialShorteningWhere(orgId: string, end: Date) {
  return and(
    eq(creditExpiresRecord.orgId, orgId),
    eq(creditExpiresRecord.source, "subscription_renewal"),
    gt(creditExpiresRecord.expiresAt, end),
    gt(creditExpiresRecord.remaining, 0),
  );
}

export function unpreparedLegacyPlanTrialLots(
  orgId: string,
  end: Date,
  lotIds: readonly string[],
): SQL {
  return exists(
    new QueryBuilder()
      .select({ id: creditExpiresRecord.id })
      .from(creditExpiresRecord)
      .where(
        and(
          trialShorteningWhere(orgId, end),
          not(legacyPlanTrialLotMembership(lotIds)),
        ),
      ),
  );
}

/** One array binding keeps the prepared/unprepared cohorts below the old parameter budget. */
export function legacyPlanTrialLotMembership(lotIds: readonly string[]): SQL {
  return eq(creditExpiresRecord.id, sql`ANY(${sql.param(lotIds)}::uuid[])`);
}
