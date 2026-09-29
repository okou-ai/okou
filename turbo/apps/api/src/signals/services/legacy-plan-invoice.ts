import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import {
  usagePackAllocations,
  usagePackSubscriptions,
} from "@okouai/db/schema/usage-pack-subscription";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { checkoutWouldReplaceWithSameOrLowerTier } from "./billing-checkout.service";
import { orgPlanEntitlementValues } from "./org-plan-entitlements.service";
import { trialCreditExtensionWhere } from "./org-credit-expiration";
import { subscriptionScheduleId } from "./stripe-subscription-schedules.service";
import type { SubscriptionInvoiceDetails } from "./webhooks-stripe.service";

export interface LegacyPlanInvoice {
  readonly invoiceId: string;
  readonly customerId: string;
  readonly subscriptionId: string;
  readonly orgId: string;
  readonly details: SubscriptionInvoiceDetails;
}

export type LegacyPlanInvoiceWallet = Pick<
  typeof orgMetadata.$inferSelect,
  | "tier"
  | "stripeSubscriptionId"
  | "subscriptionStatus"
  | "lastProcessedInvoiceId"
>;

export function legacyPlanInvoiceAdmission(
  wallet: LegacyPlanInvoiceWallet,
  args: LegacyPlanInvoice,
): "duplicate" | "rejected" | "publish" {
  if (wallet.lastProcessedInvoiceId === args.invoiceId) {
    // A subscription-created delivery can replace the binding before its own
    // invoice arrives. The previous invoice no longer owns replacement cleanup.
    return legacyPlanEntitlementIsCurrent(wallet, args)
      ? "duplicate"
      : "rejected";
  }
  if (
    wallet.stripeSubscriptionId &&
    wallet.stripeSubscriptionId !== args.subscriptionId &&
    checkoutWouldReplaceWithSameOrLowerTier({
      currentTier: wallet.tier,
      targetTier: args.details.tier,
    })
  ) {
    return "rejected";
  }
  return "publish";
}

export function replacedLegacyPlanSubscriptionId(
  wallet: LegacyPlanInvoiceWallet,
  args: LegacyPlanInvoice,
): string | null {
  if (
    !wallet.stripeSubscriptionId ||
    wallet.stripeSubscriptionId === args.subscriptionId
  ) {
    return null;
  }
  const replacesPaidTier =
    (args.details.tier === "team" && wallet.tier === "pro") ||
    (args.details.tier === "custom" &&
      (wallet.tier === "pro" || wallet.tier === "team"));
  return replacesPaidTier || wallet.subscriptionStatus === "trialing"
    ? wallet.stripeSubscriptionId
    : null;
}

export function legacyPlanEntitlementIsCurrent(
  wallet: LegacyPlanInvoiceWallet,
  args: LegacyPlanInvoice,
): boolean {
  return (
    wallet.tier === args.details.tier &&
    wallet.stripeSubscriptionId === args.subscriptionId
  );
}

export function legacyPlanInvoiceMetadata(args: LegacyPlanInvoice, at: Date) {
  const { details } = args;
  const pendingChangeAt = details.scheduledEndDate;
  return {
    tier: details.tier,
    stripeSubscriptionId: args.subscriptionId,
    subscriptionStatus: details.subscription.status,
    cancelAtPeriodEnd:
      details.subscription.cancel_at_period_end ||
      typeof details.subscription.cancel_at === "number" ||
      pendingChangeAt !== null,
    onboardingPaymentPending: false,
    lastProcessedInvoiceId: args.invoiceId,
    currentPeriodEnd: pendingChangeAt ?? details.periodEndDate,
    pendingSubscriptionScheduleId: pendingChangeAt
      ? subscriptionScheduleId(details.subscription)
      : null,
    pendingSubscriptionTargetTier: pendingChangeAt ? "limited-free-1" : null,
    pendingSubscriptionChangeAt: pendingChangeAt,
    updatedAt: at,
  };
}

export function legacyPlanInvoiceEntitlement(
  args: LegacyPlanInvoice,
  hasMemberPack: boolean,
  stripeOwnerOrgId: string | undefined,
) {
  const duplicate = stripeOwnerOrgId && stripeOwnerOrgId !== args.orgId;
  return {
    ...orgPlanEntitlementValues(
      {
        orgId: args.orgId,
        tier: args.details.tier,
        source: "stripe_subscription",
        status: args.details.subscription.status,
        stripePriceId: args.details.priceId,
        currentPeriodStart: args.details.periodStartDate,
        currentPeriodEnd: args.details.periodEndDate,
        cancelAt: args.details.scheduledEndDate,
        expiresAt: args.details.scheduledEndDate,
        showUsagePack: hasMemberPack,
      },
      {
        stripeSubscriptionId: duplicate ? null : args.subscriptionId,
        sourceMetadata: duplicate
          ? {
              stripeSubscriptionSnapshotSkipped:
                "duplicate_stripe_subscription_id",
            }
          : {},
      },
    ),
    stripeProductId: null,
    metadataHash: null,
  };
}

export function legacyPlanMemberPackQuery(args: LegacyPlanInvoice) {
  return new QueryBuilder()
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
        eq(usagePackSubscriptions.orgId, args.orgId),
        eq(usagePackSubscriptions.stripeSubscriptionId, args.subscriptionId),
        notInArray(usagePackSubscriptions.subscriptionStatus, [
          "canceled",
          "incomplete_expired",
          "invalid",
        ]),
        inArray(usagePackAllocations.status, [
          "pending_payment",
          "pending_invitation",
          "paid_pending_invitation",
          "active",
        ]),
      ),
    )
    .limit(1)
    .as("legacy_invoice_member_pack");
}

export function legacyPlanEntitlementOwnerQuery(subscriptionId: string) {
  return new QueryBuilder()
    .select({ orgId: orgPlanEntitlements.orgId })
    .from(orgPlanEntitlements)
    .where(eq(orgPlanEntitlements.stripeSubscriptionId, subscriptionId))
    .limit(1)
    .as("legacy_invoice_entitlement_owner");
}

export function legacyPlanTrialHistoryQuery(args: LegacyPlanInvoice) {
  return new QueryBuilder()
    .select({ id: creditExpiresRecord.id })
    .from(creditExpiresRecord)
    .where(
      and(
        eq(creditExpiresRecord.orgId, args.orgId),
        eq(creditExpiresRecord.source, "subscription_renewal"),
        eq(creditExpiresRecord.amount, args.details.credits),
      ),
    )
    .limit(1)
    .as("legacy_invoice_trial_history");
}

export function legacyPlanOmittedTrialQuery(
  args: LegacyPlanInvoice,
  trialIds: readonly string[],
) {
  return new QueryBuilder()
    .select({ id: creditExpiresRecord.id })
    .from(creditExpiresRecord)
    .where(
      and(
        trialCreditExtensionWhere(args.orgId, args.details.credits),
        notInArray(creditExpiresRecord.id, [...trialIds]),
      ),
    )
    .limit(1)
    .as("legacy_invoice_omitted_trial");
}
