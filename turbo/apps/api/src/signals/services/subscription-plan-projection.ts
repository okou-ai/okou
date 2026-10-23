import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { and, eq, exists, ne, sql, type SQL } from "drizzle-orm";
import { PgDialect, QueryBuilder } from "drizzle-orm/pg-core";
import {
  orgPlanEntitlementUpdateValues,
  type orgPlanEntitlementValues,
} from "./org-plan-entitlements.service";

type PlanEntitlementProjection = ReturnType<typeof orgPlanEntitlementValues>;

/** Preserve the existing duplicate-owner decision within the publication snapshot. */
function stripeSubscriptionSnapshotSql(values: PlanEntitlementProjection) {
  const query = new QueryBuilder();
  const duplicateOwner = values.stripeSubscriptionId
    ? exists(
        query
          .select({ orgId: orgPlanEntitlements.orgId })
          .from(orgPlanEntitlements)
          .where(
            and(
              eq(
                orgPlanEntitlements.stripeSubscriptionId,
                values.stripeSubscriptionId,
              ),
              ne(orgPlanEntitlements.orgId, values.orgId),
            ),
          ),
      )
    : sql`false`;
  const duplicateMetadata = {
    ...values.sourceMetadata,
    stripeSubscriptionSnapshotSkipped: "duplicate_stripe_subscription_id",
  };
  return {
    stripeSubscriptionId: sql`CASE WHEN ${duplicateOwner} THEN NULL
      ELSE ${sql.param(values.stripeSubscriptionId, orgPlanEntitlements.stripeSubscriptionId)} END`,
    sourceMetadata: sql`CASE WHEN ${duplicateOwner}
      THEN ${sql.param(duplicateMetadata, orgPlanEntitlements.sourceMetadata)}::jsonb
      ELSE ${sql.param(values.sourceMetadata, orgPlanEntitlements.sourceMetadata)}::jsonb END`,
  };
}

function stripePlanEntitlementUpdateSet(
  values: PlanEntitlementProjection,
): SQL {
  const reset = orgPlanEntitlementUpdateValues(values);
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
    showUsagePack: sql`excluded.show_usage_pack`,
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
    stripeSubscriptionId: sql`excluded.stripe_subscription_id`,
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
    sourceMetadata: sql`excluded.source_metadata`,
    updatedAt: sql.param(reset.updatedAt, orgPlanEntitlements.updatedAt),
  });
}

/** Bind this capability projection only to the actual organization UPDATE result. */
export function stripePlanEntitlementInsertSql(
  parentOrgIds: SQL,
  values: PlanEntitlementProjection,
  showUsagePack: SQL = sql
    .param(values.showUsagePack, orgPlanEntitlements.showUsagePack)
    .getSQL(),
): SQL {
  const updateSet = stripePlanEntitlementUpdateSet(values);
  const snapshot = stripeSubscriptionSnapshotSql(values);
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
  ) SELECT updated_plan_rows.org_id,
    ${sql.param(values.planKey, orgPlanEntitlements.planKey)},
    ${sql.param(values.planRank, orgPlanEntitlements.planRank)},
    ${sql.param(values.source, orgPlanEntitlements.source)},
    ${sql.param(values.status, orgPlanEntitlements.status)},
    ${sql.param(values.baseConcurrencyLimit, orgPlanEntitlements.baseConcurrencyLimit)},
    ${sql.param(values.canBuyConcurrency, orgPlanEntitlements.canBuyConcurrency)},
    ${sql.param(values.canBuyCredits, orgPlanEntitlements.canBuyCredits)},
    ${showUsagePack},
    ${sql.param(values.autoRechargeAllowed, orgPlanEntitlements.autoRechargeAllowed)},
    ${sql.param(values.restrictedBuiltInModels, orgPlanEntitlements.restrictedBuiltInModels)},
    ${sql.param(values.workflowWebhookTriggerAllowed, orgPlanEntitlements.workflowWebhookTriggerAllowed)},
    ${sql.param(values.audioLifetimeLimit, orgPlanEntitlements.audioLifetimeLimit)},
    ${sql.param(values.audioDailyRateLimit, orgPlanEntitlements.audioDailyRateLimit)},
    ${sql.param(values.audioDailyDurationSeconds, orgPlanEntitlements.audioDailyDurationSeconds)},
    ${snapshot.stripeSubscriptionId},
    ${sql.param(values.stripePriceId, orgPlanEntitlements.stripePriceId)},
    ${sql.param(values.currentPeriodStart, orgPlanEntitlements.currentPeriodStart)},
    ${sql.param(values.currentPeriodEnd, orgPlanEntitlements.currentPeriodEnd)},
    ${sql.param(values.cancelAt, orgPlanEntitlements.cancelAt)},
    ${sql.param(values.expiresAt, orgPlanEntitlements.expiresAt)},
    ${snapshot.sourceMetadata},
    ${sql.param(values.updatedAt, orgPlanEntitlements.updatedAt)}
  FROM (${parentOrgIds}) AS updated_plan_rows
  WHERE true
  ON CONFLICT (${sql.identifier(orgPlanEntitlements.orgId.name)})
  DO UPDATE SET ${updateSet}`;
}
