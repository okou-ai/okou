import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { eq } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { retireMarketingMetadata } from "../../lib/marketing-metadata";
import { orgPlanEntitlementValues } from "./org-plan-entitlements.service";
import {
  usagePackSqlRows,
  usagePackSqlWrite,
  usagePackSqlClock,
  usagePackSqlSelection,
  usagePackSqlRow,
  usagePackSqlInsert,
  usagePackSqlUpdate,
  type UsagePackRetainedFinancialPlan as FinancialPlan,
} from "./usage-pack-retained-sql";
const CANCELED_SUBSCRIPTION_TARGET_TIER = "limited-free-1";
interface DeletedSubscription {
  readonly id: string;
  readonly metadata?: Readonly<Record<string, string>> | null;
}
function* canceledPlanEntitlementPlan(
  orgId: string,
  metadata: Readonly<Record<string, string>>,
): FinancialPlan<void> {
  const entitlementArgs = {
    orgId: orgId,
    tier: CANCELED_SUBSCRIPTION_TARGET_TIER,
    source: "stripe_subscription",
    sourceMetadata: metadata,
  } as const;
  const sourceMetadata = retireMarketingMetadata(
    entitlementArgs.sourceMetadata,
  );
  const values = orgPlanEntitlementValues(
    entitlementArgs,
    {
      stripeSubscriptionId: null,
      sourceMetadata,
    },
    yield* usagePackSqlClock(),
  );
  yield* usagePackSqlWrite(
    usagePackSqlInsert(orgPlanEntitlements, values, {
      conflict: {
        target: orgPlanEntitlements.orgId,
        set: {
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
        },
      },
    }),
  );
}
export function* canceledPlanSubscriptionPlan(
  subscription: DeletedSubscription,
): FinancialPlan<readonly { orgId: string }[]> {
  const downgraded = yield* usagePackSqlRows(
    usagePackSqlUpdate(
      orgMetadata,
      {
        tier: CANCELED_SUBSCRIPTION_TARGET_TIER,
        subscriptionStatus: "canceled",
        stripeSubscriptionId: null,
        cancelAtPeriodEnd: false,
        currentPeriodEnd: null,
        pendingSubscriptionScheduleId: null,
        pendingSubscriptionTargetTier: null,
        pendingSubscriptionChangeAt: null,
        updatedAt: yield* usagePackSqlClock(),
      },
      eq(orgMetadata.stripeSubscriptionId, subscription.id),
      { orgId: orgMetadata.orgId },
    ),
    usagePackSqlRow({ orgId: orgMetadata.orgId }),
  );
  for (const row of downgraded) {
    yield* canceledPlanEntitlementPlan(row.orgId, subscription.metadata ?? {});
  }

  let persistedOrgId: string | null = null;
  if (downgraded.length === 0) {
    const [owner] = yield* usagePackSqlRows(
      new QueryBuilder()
        .select(usagePackSqlSelection({ orgId: orgPlanEntitlements.orgId }))
        .from(orgPlanEntitlements)
        .where(eq(orgPlanEntitlements.stripeSubscriptionId, subscription.id))
        .limit(1)
        .getSQL(),
      usagePackSqlRow({ orgId: orgPlanEntitlements.orgId }),
    );
    persistedOrgId = owner?.orgId ?? null;
  }
  const [persistedOrg] = persistedOrgId
    ? yield* usagePackSqlRows(
        new QueryBuilder()
          .select(
            usagePackSqlSelection({
              tier: orgMetadata.tier,
              stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
            }),
          )
          .from(orgMetadata)
          .where(eq(orgMetadata.orgId, persistedOrgId))
          .limit(1)
          .getSQL(),
        usagePackSqlRow({
          tier: orgMetadata.tier,
          stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
        }),
      )
    : [];
  const replayedDowngradeOrgId =
    persistedOrg?.tier === CANCELED_SUBSCRIPTION_TARGET_TIER &&
    persistedOrg.stripeSubscriptionId === null
      ? persistedOrgId
      : null;
  if (replayedDowngradeOrgId) {
    yield* canceledPlanEntitlementPlan(
      replayedDowngradeOrgId,
      subscription.metadata ?? {},
    );
  }
  return [
    ...downgraded.map((row) => {
      return row.orgId;
    }),
    ...(replayedDowngradeOrgId ? [replayedDowngradeOrgId] : []),
  ].map((orgId) => {
    return { orgId };
  });
}
