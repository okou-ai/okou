import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import {
  usagePackAllocations,
  usagePackInvoiceFulfillments,
  usagePackSubscriptions,
  USAGE_PACK_ALLOCATION_STATUSES,
} from "@okouai/db/schema/usage-pack-subscription";
import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  notExists,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { orgPlanEntitlementValues } from "./org-plan-entitlements.service";
import {
  invoiceUsagePackCreditGrantSql,
  type InvoiceUsagePackCreditGrant,
} from "./usage-pack-credit-grant-sql";
import type { CommitUsagePackFulfillmentArgs } from "./usage-pack-subscription.service";

type Subscription = typeof usagePackSubscriptions.$inferSelect;
export function fulfillmentRootsWhere(args: CommitUsagePackFulfillmentArgs) {
  return or(
    eq(usagePackSubscriptions.orgId, args.context.subscription.orgId),
    eq(usagePackSubscriptions.id, args.context.subscription.id),
  );
}

const LIVE_ORG_SUBSCRIPTION_STATUSES = [
  "active",
  "trialing",
  "past_due",
] as const;

/**
 * An organization binds its paid entitlement once. A different live
 * subscription already bound to it (another initial purchase that won, of
 * either family) keeps the binding; the losing payment is refunded instead.
 */
export function orgAcceptsSubscriptionWhere(subscriptionId: string, at: Date) {
  return or(
    isNull(orgMetadata.stripeSubscriptionId),
    eq(orgMetadata.stripeSubscriptionId, subscriptionId),
    isNull(orgMetadata.subscriptionStatus),
    notInArray(orgMetadata.subscriptionStatus, [
      ...LIVE_ORG_SUBSCRIPTION_STATUSES,
    ]),
    lt(orgMetadata.currentPeriodEnd, at),
  );
}

function pendingFulfillmentSnapshot(status: string) {
  return status === "checkout_pending" || status === "purchase_pending";
}

export function fulfillmentRootSnapshot(
  args: CommitUsagePackFulfillmentArgs,
  roots: readonly Subscription[],
) {
  if (
    roots.some((root) => {
      return root.orgId !== args.context.subscription.orgId;
    })
  ) {
    throw new Error("Usage pack subscription moved outside its locked scope");
  }
  const subscription = roots.find((root) => {
    return root.id === args.context.subscription.id;
  });
  if (!subscription) {
    throw new Error(
      `Usage pack subscription ${args.context.subscription.id} disappeared during fulfillment`,
    );
  }
  return {
    subscription,
    pendingCount: roots.filter((root) => {
      return pendingFulfillmentSnapshot(root.subscriptionStatus);
    }).length,
  };
}

export function fulfillmentAllocationWhere(
  args: CommitUsagePackFulfillmentArgs,
  subscription: Subscription,
) {
  return and(
    eq(usagePackAllocations.usagePackSubscriptionId, subscription.id),
    inArray(
      usagePackAllocations.id,
      args.fulfillment.allocations.map((allocation) => {
        return allocation.allocationId;
      }),
    ),
    inArray(
      usagePackAllocations.status,
      subscription.subscriptionStatus === "canceled"
        ? [...USAGE_PACK_ALLOCATION_STATUSES]
        : [
            "pending_payment",
            "active",
            "pending_invitation",
            "paid_pending_invitation",
          ],
    ),
  );
}

export function requireFulfillmentAllocationSnapshot(
  args: CommitUsagePackFulfillmentArgs,
  rows: readonly (typeof usagePackAllocations.$inferSelect)[],
  subscription: Subscription,
) {
  if (
    subscription.stripeSubscriptionId &&
    subscription.stripeSubscriptionId !== args.subscription.id
  ) {
    throw new Error(
      `Usage pack subscription ${subscription.id} changed Stripe subscriptions during fulfillment`,
    );
  }
  const changed = args.fulfillment.allocations.some((allocation) => {
    const row = rows.find((candidate) => {
      return candidate.id === allocation.allocationId;
    });
    const prepared = args.context.allocations.find((candidate) => {
      return candidate.id === allocation.allocationId;
    });
    return (
      !row ||
      !prepared ||
      row.userId !== allocation.userId ||
      row.stripePriceId !== prepared.stripePriceId
    );
  });
  if (changed || rows.length !== args.fulfillment.allocations.length) {
    throw new Error(
      `Usage pack allocations changed while fulfilling invoice ${args.invoice.id}`,
    );
  }
}

export function firstPaidUpgradeDebtWhere(orgId: string) {
  const paidGrant = new QueryBuilder()
    .select({ id: creditExpiresRecord.id })
    .from(creditExpiresRecord)
    .where(
      and(
        eq(creditExpiresRecord.orgId, orgId),
        isNotNull(creditExpiresRecord.stripeInvoiceId),
        inArray(creditExpiresRecord.source, [
          "subscription_renewal",
          "credit_purchase",
          "auto_recharge",
          "one_time_purchase",
        ]),
      ),
    );
  const paidFulfillment = new QueryBuilder()
    .select({ id: usagePackInvoiceFulfillments.stripeInvoiceId })
    .from(usagePackInvoiceFulfillments)
    .innerJoin(
      usagePackSubscriptions,
      eq(
        usagePackSubscriptions.id,
        usagePackInvoiceFulfillments.usagePackSubscriptionId,
      ),
    )
    .where(eq(usagePackSubscriptions.orgId, orgId));
  return and(
    eq(orgMetadata.orgId, orgId),
    lt(orgMetadata.credits, 0),
    isNull(orgMetadata.lastProcessedInvoiceId),
    notExists(paidGrant),
    notExists(paidFulfillment),
  );
}

function fulfillmentGrantStatements(args: CommitUsagePackFulfillmentArgs) {
  const grants: InvoiceUsagePackCreditGrant[] = [];
  for (const allocation of args.fulfillment.allocations) {
    if (!allocation.userId) {
      continue;
    }
    for (const grantType of ["purchased", "bonus"] as const) {
      const amount =
        grantType === "purchased"
          ? allocation.purchasedCredits
          : allocation.bonusCredits;
      if (amount <= 0) {
        continue;
      }
      grants.push({
        orgId: args.context.subscription.orgId,
        userId: allocation.userId,
        grantType,
        idempotencyKey: `usage-pack:${args.invoice.id}:${allocation.allocationId}:${grantType}`,
        amount,
        expiresAt: args.fulfillment.periodEnd,
        ...(grantType === "purchased"
          ? {
              refund: {
                invoiceId: args.invoice.id,
                invoiceLineId: allocation.stripeInvoiceLineId,
                amountCents: allocation.sourceAmountCents,
              },
            }
          : {}),
      });
    }
  }
  return grants.map(invoiceUsagePackCreditGrantSql);
}

export function fulfillmentProjection(
  args: CommitUsagePackFulfillmentArgs,
  subscription: Subscription,
  at: Date,
) {
  const advance =
    subscription.subscriptionStatus !== "canceled" &&
    (subscription.currentPeriodEnd === null ||
      subscription.currentPeriodEnd <= args.fulfillment.periodEnd);
  const willCancel =
    args.subscription.cancel_at_period_end ||
    (typeof args.subscription.cancel_at === "number" &&
      Number.isSafeInteger(args.subscription.cancel_at) &&
      args.subscription.cancel_at > 0);
  const values = {
    tier: args.shape.tier,
    stripePlanPriceId: args.shape.planPriceId,
    stripeSubscriptionId: args.subscription.id,
    subscriptionStatus: args.subscription.status,
    currentPeriodStart: args.fulfillment.periodStart,
    currentPeriodEnd: args.fulfillment.periodEnd,
    cancelAtPeriodEnd: willCancel,
    updatedAt: at,
  };
  return {
    advance,
    values: advance
      ? values
      : !subscription.stripeSubscriptionId &&
          subscription.subscriptionStatus !== "canceled"
        ? { stripeSubscriptionId: args.subscription.id, updatedAt: at }
        : {},
    orgWhere: and(
      eq(orgMetadata.orgId, subscription.orgId),
      eq(orgMetadata.stripeCustomerId, subscription.stripeCustomerId),
      orgAcceptsSubscriptionWhere(args.subscription.id, at),
    ),
    orgValues: {
      tier: values.tier,
      stripeSubscriptionId: values.stripeSubscriptionId,
      subscriptionStatus: values.subscriptionStatus,
      currentPeriodEnd: values.currentPeriodEnd,
      cancelAtPeriodEnd: values.cancelAtPeriodEnd,
      updatedAt: at,
    },
  };
}

export function fulfillmentPlanEntitlement(
  args: CommitUsagePackFulfillmentArgs,
  subscriptionOwner: string | undefined,
) {
  const orgId = args.context.subscription.orgId;
  const duplicateOwner =
    subscriptionOwner !== undefined && subscriptionOwner !== orgId;
  const cancelAt =
    typeof args.subscription.cancel_at === "number" &&
    Number.isSafeInteger(args.subscription.cancel_at) &&
    args.subscription.cancel_at > 0
      ? new Date(args.subscription.cancel_at * 1000)
      : args.subscription.cancel_at_period_end
        ? args.fulfillment.periodEnd
        : null;
  return {
    ...orgPlanEntitlementValues(
      {
        orgId,
        tier: args.shape.tier,
        source: "stripe_subscription",
        status: args.subscription.status,
        stripeSubscriptionId: args.subscription.id,
        stripePriceId: args.shape.planPriceId,
        currentPeriodStart: args.fulfillment.periodStart,
        currentPeriodEnd: args.fulfillment.periodEnd,
        cancelAt,
        expiresAt: cancelAt,
        showUsagePack: true,
      },
      {
        stripeSubscriptionId: duplicateOwner ? null : args.subscription.id,
        sourceMetadata: duplicateOwner
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

export function fulfillmentPreparedWrites(
  args: CommitUsagePackFulfillmentArgs,
) {
  return {
    grants: fulfillmentGrantStatements(args),
    allocationValues: {
      status: sql`CASE WHEN ${usagePackAllocations.userId} IS NULL THEN 'pending_invitation' ELSE 'active' END`,
      currentPeriodStart: args.fulfillment.periodStart,
      currentPeriodEnd: args.fulfillment.periodEnd,
    },
    allocationWhere: and(
      eq(
        usagePackAllocations.usagePackSubscriptionId,
        args.context.subscription.id,
      ),
      inArray(
        usagePackAllocations.id,
        args.fulfillment.allocations.map((allocation) => {
          return allocation.allocationId;
        }),
      ),
    ),
    receipt: {
      stripeInvoiceId: args.invoice.id,
      usagePackSubscriptionId: args.context.subscription.id,
      periodStart: args.fulfillment.periodStart,
      periodEnd: args.fulfillment.periodEnd,
    },
  };
}

export function fulfillmentReceiptCommitted(
  args: CommitUsagePackFulfillmentArgs,
  receipt: typeof usagePackInvoiceFulfillments.$inferSelect | undefined,
) {
  if (
    receipt &&
    receipt.usagePackSubscriptionId !== args.context.subscription.id
  ) {
    throw new Error(
      `Invoice ${args.invoice.id} is already bound to a different usage pack subscription`,
    );
  }
  return receipt !== undefined;
}

export function finalFulfillmentPendingCount(
  args: CommitUsagePackFulfillmentArgs,
  prior: { readonly subscription: Subscription; readonly pendingCount: number },
  advance: boolean,
) {
  const wasPending = pendingFulfillmentSnapshot(
    prior.subscription.subscriptionStatus,
  );
  const isPending = pendingFulfillmentSnapshot(
    advance ? args.subscription.status : prior.subscription.subscriptionStatus,
  );
  const count = prior.pendingCount - Number(wasPending) + Number(isPending);
  if (count > 1 && isPending && !wasPending) {
    throw new Error(
      "Another usage-pack purchase is already pending for this organization",
    );
  }
  return count;
}
