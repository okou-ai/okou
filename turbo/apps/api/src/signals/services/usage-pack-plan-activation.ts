import {
  usagePackAllocations,
  usagePackSubscriptions,
} from "@okouai/db/schema/usage-pack-subscription";
import { and, eq, inArray, notExists, notInArray, or } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { orgPlanEntitlementValues } from "./org-plan-entitlements.service";
import type { CommitUsagePackFulfillmentArgs } from "./usage-pack-subscription.service";

type Subscription = typeof usagePackSubscriptions.$inferSelect;
export type UsagePackPlanActivation = Pick<
  CommitUsagePackFulfillmentArgs,
  "context" | "subscription"
>;
type Shape = CommitUsagePackFulfillmentArgs["shape"];

const ACTIVE_ALLOCATION_STATUSES = [
  "pending_payment",
  "active",
  "pending_invitation",
  "paid_pending_invitation",
] as const;
function isPending(status: string) {
  return status === "checkout_pending" || status === "purchase_pending";
}

export function activationRootsWhere(args: UsagePackPlanActivation) {
  return or(
    eq(usagePackSubscriptions.orgId, args.context.subscription.orgId),
    eq(usagePackSubscriptions.id, args.context.subscription.id),
  );
}

export function activationRoot(
  args: UsagePackPlanActivation,
  roots: readonly Subscription[],
) {
  if (
    roots.some((root) => {
      return root.orgId !== args.context.subscription.orgId;
    })
  ) {
    throw new Error("Usage pack subscription moved outside its locked scope");
  }
  const root = roots.find((candidate) => {
    return candidate.id === args.context.subscription.id;
  });
  if (
    !root ||
    ["canceled", "incomplete_expired", "invalid"].includes(
      root.subscriptionStatus,
    )
  ) {
    throw new Error(
      "Usage pack subscription became unavailable during plan activation",
    );
  }
  return root;
}

export function activationPendingCounts(
  args: UsagePackPlanActivation,
  roots: readonly Subscription[],
) {
  const prior = roots.filter((root) => {
    return isPending(root.subscriptionStatus);
  });
  const next = roots.filter((root) => {
    return isPending(
      root.id === args.context.subscription.id
        ? args.subscription.status
        : root.subscriptionStatus,
    );
  });
  if (
    next.length > 1 &&
    next.some((root) => {
      return !prior.some((before) => {
        return before.id === root.id;
      });
    })
  ) {
    throw new Error(
      "Another usage-pack purchase is already pending for this organization",
    );
  }
  return { before: prior.length, after: next.length };
}

export function activationAllocationWhere(args: UsagePackPlanActivation) {
  return and(
    eq(
      usagePackAllocations.usagePackSubscriptionId,
      args.context.subscription.id,
    ),
    inArray(
      usagePackAllocations.id,
      args.context.allocations.map((allocation) => {
        return allocation.id;
      }),
    ),
  );
}

export function activationUnchangedAllocationsWhere(
  args: UsagePackPlanActivation,
) {
  const unprepared = new QueryBuilder()
    .select({ id: usagePackAllocations.id })
    .from(usagePackAllocations)
    .where(
      and(
        eq(
          usagePackAllocations.usagePackSubscriptionId,
          args.context.subscription.id,
        ),
        inArray(usagePackAllocations.status, [...ACTIVE_ALLOCATION_STATUSES]),
        notInArray(
          usagePackAllocations.id,
          args.context.allocations.map((allocation) => {
            return allocation.id;
          }),
        ),
      ),
    );
  return and(
    eq(usagePackSubscriptions.id, args.context.subscription.id),
    notExists(unprepared),
  );
}

export function activationSubscriptionValues(
  subscription: UsagePackPlanActivation["subscription"],
  shape: Shape,
  at: Date,
) {
  return {
    tier: shape.tier,
    stripePlanPriceId: shape.planPriceId,
    stripeSubscriptionId: subscription.id,
    subscriptionStatus: subscription.status,
    currentPeriodStart: shape.periodStart,
    currentPeriodEnd: shape.periodEnd,
    cancelAtPeriodEnd:
      subscription.cancel_at_period_end ||
      (typeof subscription.cancel_at === "number" &&
        Number.isSafeInteger(subscription.cancel_at) &&
        subscription.cancel_at > 0),
    updatedAt: at,
  };
}

export function activationOrgValues(
  subscription: UsagePackPlanActivation["subscription"],
  shape: Shape,
  at: Date,
) {
  const {
    stripePlanPriceId: _price,
    currentPeriodStart: _start,
    ...values
  } = activationSubscriptionValues(subscription, shape, at);
  return values;
}

export function activationEntitlementValues(
  args: UsagePackPlanActivation,
  shape: Shape,
  owner: string | undefined,
) {
  const duplicateOwner =
    owner !== undefined && owner !== args.context.subscription.orgId;
  const cancelAt =
    typeof args.subscription.cancel_at === "number" &&
    Number.isSafeInteger(args.subscription.cancel_at) &&
    args.subscription.cancel_at > 0
      ? new Date(args.subscription.cancel_at * 1000)
      : args.subscription.cancel_at_period_end
        ? shape.periodEnd
        : null;
  return {
    ...orgPlanEntitlementValues(
      {
        orgId: args.context.subscription.orgId,
        tier: shape.tier,
        source: "stripe_subscription",
        status: args.subscription.status,
        stripeSubscriptionId: args.subscription.id,
        stripePriceId: shape.planPriceId,
        currentPeriodStart: shape.periodStart,
        currentPeriodEnd: shape.periodEnd,
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
