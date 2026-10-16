import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import type { OrgPlanEntitlementSourceMetadata } from "@okouai/db/jsonb-contracts/org-plan-entitlement";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { orgPlanEntitlementValues } from "./org-plan-entitlements.service";
import { ORG_PLAN_ENTITLEMENT_TIER_VALUES } from "./org-plan-entitlement-tier-values";

type PlanEntitlementProjection = Omit<
  ReturnType<typeof orgPlanEntitlementValues>,
  "orgId"
>;

/** Pure canceled capability values; organization identity comes only from SQL RETURNING. */
export function canceledPlanEntitlementProjection(
  sourceMetadata: OrgPlanEntitlementSourceMetadata,
  at: Date,
): PlanEntitlementProjection {
  const limits = ORG_PLAN_ENTITLEMENT_TIER_VALUES["limited-free-1"];
  return {
    planKey: "limited-free-1",
    planRank: limits.planRank,
    source: "stripe_subscription",
    status: "active",
    baseConcurrencyLimit: limits.baseConcurrencyLimit,
    canBuyConcurrency: limits.canBuyConcurrency,
    canBuyCredits: limits.canBuyCredits,
    showUsagePack: false,
    autoRechargeAllowed: limits.autoRechargeAllowed,
    restrictedBuiltInModels: limits.restrictedBuiltInModels,
    workflowWebhookTriggerAllowed: limits.workflowWebhookAutomationAllowed,
    audioLifetimeLimit: limits.audioLifetimeLimit,
    audioDailyRateLimit: limits.audioDailyRateLimit,
    audioDailyDurationSeconds: limits.audioDailyDurationSeconds,
    stripeSubscriptionId: null,
    stripePriceId: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAt: null,
    expiresAt: null,
    sourceMetadata,
    updatedAt: at,
  };
}

export function canceledPlanEntitlementConflictValues(
  values: PlanEntitlementProjection,
) {
  return {
    planKey: values.planKey,
    planRank: values.planRank,
    source: values.source,
    status: values.status,
    baseConcurrencyLimit: values.baseConcurrencyLimit,
    canBuyConcurrency: values.canBuyConcurrency,
    canBuyCredits: values.canBuyCredits,
    showUsagePack: values.showUsagePack,
    autoRechargeAllowed: values.autoRechargeAllowed,
    restrictedBuiltInModels: values.restrictedBuiltInModels,
    workflowWebhookTriggerAllowed: values.workflowWebhookTriggerAllowed,
    audioLifetimeLimit: values.audioLifetimeLimit,
    audioDailyRateLimit: values.audioDailyRateLimit,
    audioDailyDurationSeconds: values.audioDailyDurationSeconds,
    stripeSubscriptionId: values.stripeSubscriptionId,
    stripeProductId: null,
    stripePriceId: values.stripePriceId,
    currentPeriodStart: values.currentPeriodStart,
    currentPeriodEnd: values.currentPeriodEnd,
    cancelAt: values.cancelAt,
    expiresAt: values.expiresAt,
    metadataHash: null,
    sourceMetadata: values.sourceMetadata,
    updatedAt: values.updatedAt,
  };
}

function canceledPlanEntitlementUpdateSet(
  values: PlanEntitlementProjection,
): SQL {
  const reset = canceledPlanEntitlementConflictValues(values);
  return new PgDialect().buildUpdateSet(orgPlanEntitlements, {
    planKey: sql.param(reset.planKey, orgPlanEntitlements.planKey),
    planRank: sql.param(reset.planRank, orgPlanEntitlements.planRank),
    source: sql.param(reset.source, orgPlanEntitlements.source),
    status: sql.param(reset.status, orgPlanEntitlements.status),
    baseConcurrencyLimit: sql.param(
      reset.baseConcurrencyLimit,
      orgPlanEntitlements.baseConcurrencyLimit,
    ),
    canBuyConcurrency: sql.param(
      reset.canBuyConcurrency,
      orgPlanEntitlements.canBuyConcurrency,
    ),
    canBuyCredits: sql.param(
      reset.canBuyCredits,
      orgPlanEntitlements.canBuyCredits,
    ),
    showUsagePack: sql.param(
      reset.showUsagePack,
      orgPlanEntitlements.showUsagePack,
    ),
    autoRechargeAllowed: sql.param(
      reset.autoRechargeAllowed,
      orgPlanEntitlements.autoRechargeAllowed,
    ),
    restrictedBuiltInModels: sql.param(
      reset.restrictedBuiltInModels,
      orgPlanEntitlements.restrictedBuiltInModels,
    ),
    workflowWebhookTriggerAllowed: sql.param(
      reset.workflowWebhookTriggerAllowed,
      orgPlanEntitlements.workflowWebhookTriggerAllowed,
    ),
    audioLifetimeLimit: sql.param(
      reset.audioLifetimeLimit,
      orgPlanEntitlements.audioLifetimeLimit,
    ),
    audioDailyRateLimit: sql.param(
      reset.audioDailyRateLimit,
      orgPlanEntitlements.audioDailyRateLimit,
    ),
    audioDailyDurationSeconds: sql.param(
      reset.audioDailyDurationSeconds,
      orgPlanEntitlements.audioDailyDurationSeconds,
    ),
    stripeSubscriptionId: sql.param(
      reset.stripeSubscriptionId,
      orgPlanEntitlements.stripeSubscriptionId,
    ),
    stripeProductId: sql.param(
      reset.stripeProductId,
      orgPlanEntitlements.stripeProductId,
    ),
    stripePriceId: sql.param(
      reset.stripePriceId,
      orgPlanEntitlements.stripePriceId,
    ),
    currentPeriodStart: sql.param(
      reset.currentPeriodStart,
      orgPlanEntitlements.currentPeriodStart,
    ),
    currentPeriodEnd: sql.param(
      reset.currentPeriodEnd,
      orgPlanEntitlements.currentPeriodEnd,
    ),
    cancelAt: sql.param(reset.cancelAt, orgPlanEntitlements.cancelAt),
    expiresAt: sql.param(reset.expiresAt, orgPlanEntitlements.expiresAt),
    metadataHash: sql.param(
      reset.metadataHash,
      orgPlanEntitlements.metadataHash,
    ),
    sourceMetadata: sql.param(
      reset.sourceMetadata,
      orgPlanEntitlements.sourceMetadata,
    ),
    updatedAt: sql.param(reset.updatedAt, orgPlanEntitlements.updatedAt),
  });
}

/** Pure SQL only. parentOrgIds must be the SELECT of this command's actual parent RETURNING. */
export function canceledPlanEntitlementInsertSql(
  parentOrgIds: SQL,
  values: PlanEntitlementProjection,
): SQL {
  const updateSet = canceledPlanEntitlementUpdateSet(values);
  return sql`INSERT INTO ${orgPlanEntitlements} (
    ${sql.identifier(orgPlanEntitlements.orgId.name)},
    ${sql.identifier(orgPlanEntitlements.planKey.name)},
    ${sql.identifier(orgPlanEntitlements.planRank.name)},
    ${sql.identifier(orgPlanEntitlements.source.name)},
    ${sql.identifier(orgPlanEntitlements.status.name)},
    ${sql.identifier(orgPlanEntitlements.baseConcurrencyLimit.name)},
    ${sql.identifier(orgPlanEntitlements.canBuyConcurrency.name)},
    ${sql.identifier(orgPlanEntitlements.canBuyCredits.name)},
    ${sql.identifier(orgPlanEntitlements.showUsagePack.name)},
    ${sql.identifier(orgPlanEntitlements.autoRechargeAllowed.name)},
    ${sql.identifier(orgPlanEntitlements.restrictedBuiltInModels.name)},
    ${sql.identifier(orgPlanEntitlements.workflowWebhookTriggerAllowed.name)},
    ${sql.identifier(orgPlanEntitlements.audioLifetimeLimit.name)},
    ${sql.identifier(orgPlanEntitlements.audioDailyRateLimit.name)},
    ${sql.identifier(orgPlanEntitlements.audioDailyDurationSeconds.name)},
    ${sql.identifier(orgPlanEntitlements.stripeSubscriptionId.name)},
    ${sql.identifier(orgPlanEntitlements.stripePriceId.name)},
    ${sql.identifier(orgPlanEntitlements.currentPeriodStart.name)},
    ${sql.identifier(orgPlanEntitlements.currentPeriodEnd.name)},
    ${sql.identifier(orgPlanEntitlements.cancelAt.name)},
    ${sql.identifier(orgPlanEntitlements.expiresAt.name)},
    ${sql.identifier(orgPlanEntitlements.sourceMetadata.name)},
    ${sql.identifier(orgPlanEntitlements.updatedAt.name)}
  ) SELECT canceled_plan_rows.org_id,
    ${sql.param(values.planKey, orgPlanEntitlements.planKey)},
    ${sql.param(values.planRank, orgPlanEntitlements.planRank)},
    ${sql.param(values.source, orgPlanEntitlements.source)},
    ${sql.param(values.status, orgPlanEntitlements.status)},
    ${sql.param(values.baseConcurrencyLimit, orgPlanEntitlements.baseConcurrencyLimit)},
    ${sql.param(values.canBuyConcurrency, orgPlanEntitlements.canBuyConcurrency)},
    ${sql.param(values.canBuyCredits, orgPlanEntitlements.canBuyCredits)},
    ${sql.param(values.showUsagePack, orgPlanEntitlements.showUsagePack)},
    ${sql.param(values.autoRechargeAllowed, orgPlanEntitlements.autoRechargeAllowed)},
    ${sql.param(values.restrictedBuiltInModels, orgPlanEntitlements.restrictedBuiltInModels)},
    ${sql.param(values.workflowWebhookTriggerAllowed, orgPlanEntitlements.workflowWebhookTriggerAllowed)},
    ${sql.param(values.audioLifetimeLimit, orgPlanEntitlements.audioLifetimeLimit)},
    ${sql.param(values.audioDailyRateLimit, orgPlanEntitlements.audioDailyRateLimit)},
    ${sql.param(values.audioDailyDurationSeconds, orgPlanEntitlements.audioDailyDurationSeconds)},
    ${sql.param(values.stripeSubscriptionId, orgPlanEntitlements.stripeSubscriptionId)},
    ${sql.param(values.stripePriceId, orgPlanEntitlements.stripePriceId)},
    ${sql.param(values.currentPeriodStart, orgPlanEntitlements.currentPeriodStart)},
    ${sql.param(values.currentPeriodEnd, orgPlanEntitlements.currentPeriodEnd)},
    ${sql.param(values.cancelAt, orgPlanEntitlements.cancelAt)},
    ${sql.param(values.expiresAt, orgPlanEntitlements.expiresAt)},
    ${sql.param(values.sourceMetadata, orgPlanEntitlements.sourceMetadata)},
    ${sql.param(values.updatedAt, orgPlanEntitlements.updatedAt)}
  FROM (${parentOrgIds}) AS canceled_plan_rows
  WHERE true
  ON CONFLICT (${sql.identifier(orgPlanEntitlements.orgId.name)})
  DO UPDATE SET ${updateSet}`;
}
