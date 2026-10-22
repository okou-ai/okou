import { retireMarketingMetadata } from "../../lib/marketing-metadata";
import type { OrgTier } from "@okouai/api-contracts/contracts/orgs";
import type { OrgPlanEntitlementSourceMetadata } from "@okouai/db/jsonb-contracts/org-plan-entitlement";
import { nowDate } from "../../lib/time";
import { ORG_PLAN_ENTITLEMENT_TIER_VALUES } from "./org-plan-entitlement-tier-values";

export interface UpsertOrgPlanEntitlementArgs {
  readonly orgId: string;
  readonly tier: OrgTier;
  readonly source:
    | "stripe_subscription"
    | "stripe_atom_grant"
    | "org_metadata_bootstrap"
    | "org_metadata_migration";
  readonly status?: string;
  readonly stripeSubscriptionId?: string | null;
  readonly stripePriceId?: string | null;
  readonly currentPeriodStart?: Date | null;
  readonly currentPeriodEnd?: Date | null;
  readonly cancelAt?: Date | null;
  readonly expiresAt?: Date | null;
  readonly showUsagePack?: boolean;
  readonly sourceMetadata?: OrgPlanEntitlementSourceMetadata;
}

interface ResolvedStripeSubscriptionSnapshot {
  readonly stripeSubscriptionId: string | null;
  readonly sourceMetadata: OrgPlanEntitlementSourceMetadata;
}

export function resolveStripeSubscriptionSnapshot(
  args: Pick<
    UpsertOrgPlanEntitlementArgs,
    "orgId" | "stripeSubscriptionId" | "sourceMetadata"
  >,
  existingOrgId: string | null = null,
): ResolvedStripeSubscriptionSnapshot {
  const sourceMetadata = retireMarketingMetadata(args.sourceMetadata ?? {});
  const stripeSubscriptionId = args.stripeSubscriptionId ?? null;
  if (!stripeSubscriptionId) {
    return { stripeSubscriptionId: null, sourceMetadata };
  }

  if (!existingOrgId || existingOrgId === args.orgId) {
    return { stripeSubscriptionId, sourceMetadata };
  }

  return {
    stripeSubscriptionId: null,
    sourceMetadata: {
      ...sourceMetadata,
      stripeSubscriptionSnapshotSkipped: "duplicate_stripe_subscription_id",
    },
  };
}

export function orgPlanEntitlementValues(
  args: UpsertOrgPlanEntitlementArgs,
  stripeSubscriptionSnapshot: ResolvedStripeSubscriptionSnapshot,
  at?: Date,
) {
  const limits = ORG_PLAN_ENTITLEMENT_TIER_VALUES[args.tier];
  const updatedAt = at ?? nowDate();
  const showUsagePack =
    (args.tier === "pro" || args.tier === "team") &&
    args.showUsagePack === true;
  return {
    orgId: args.orgId,
    planKey: args.tier,
    planRank: limits.planRank,
    source: args.source,
    status: args.status ?? "active",
    baseConcurrencyLimit: limits.baseConcurrencyLimit,
    canBuyConcurrency: limits.canBuyConcurrency,
    canBuyCredits: limits.canBuyCredits,
    showUsagePack,
    autoRechargeAllowed: limits.autoRechargeAllowed,
    restrictedBuiltInModels: limits.restrictedBuiltInModels,
    workflowWebhookTriggerAllowed: limits.workflowWebhookAutomationAllowed,
    audioLifetimeLimit: limits.audioLifetimeLimit,
    audioDailyRateLimit: limits.audioDailyRateLimit,
    audioDailyDurationSeconds: limits.audioDailyDurationSeconds,
    stripeSubscriptionId: stripeSubscriptionSnapshot.stripeSubscriptionId,
    stripePriceId: args.stripePriceId ?? null,
    currentPeriodStart: args.currentPeriodStart ?? null,
    currentPeriodEnd: args.currentPeriodEnd ?? null,
    cancelAt: args.cancelAt ?? null,
    expiresAt: args.expiresAt ?? null,
    sourceMetadata: stripeSubscriptionSnapshot.sourceMetadata,
    updatedAt,
  };
}

export function orgPlanEntitlementUpdateValues(
  values: ReturnType<typeof orgPlanEntitlementValues>,
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
