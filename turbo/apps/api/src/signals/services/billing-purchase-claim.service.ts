import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { usagePackSubscriptions } from "@okouai/db/schema/usage-pack-subscription";
import {
  and,
  eq,
  gt,
  isNotNull,
  isNull,
  ne,
  notInArray,
  or,
} from "drizzle-orm";

import { QueryBuilder } from "drizzle-orm/pg-core";

import { BILLING_PURCHASE_PREVIEW_TTL_MS } from "./billing-purchase-preview-token.service";

/**
 * Existing "subscription payment not complete" status reused as the claim
 * marker of an initial purchase whose Stripe subscription is being created.
 *
 * - Plan: `org_metadata.subscription_status` of the organization row.
 * - Usage pack: `usage_pack_subscriptions.subscription_status` of the claimed
 *   snapshot while `stripe_subscription_id` and the Checkout Session are NULL.
 */
export const PLAN_PURCHASE_CLAIM_STATUS = "incomplete";
export const USAGE_PACK_PURCHASE_CLAIM_STATUS = "incomplete";

/**
 * A claim older than twice the preview lifetime cannot belong to a running
 * confirmation. Recovery reads Stripe by the claimed purchase identity before
 * it retires or replaces such a claim.
 */
export const PLAN_PURCHASE_CLAIM_STALE_MS = 2 * BILLING_PURCHASE_PREVIEW_TTL_MS;
export const USAGE_PACK_PURCHASE_CLAIM_STALE_MS =
  2 * BILLING_PURCHASE_PREVIEW_TTL_MS;

const TERMINAL_USAGE_PACK_SUBSCRIPTION_STATUSES = [
  "canceled",
  "incomplete_expired",
  "invalid",
] as const;

/**
 * Usage-pack purchases that block another initial purchase: a claimed
 * snapshot whose subscription is being created, or a live usage-pack
 * subscription other than the purchase's own source subscription.
 */
export function inFlightUsagePackPurchaseQuery(args: {
  readonly orgId: string;
  readonly sourceSubscriptionId: string | null;
  readonly excludeUsagePackSubscriptionId: string | null;
}) {
  return new QueryBuilder()
    .select({ id: usagePackSubscriptions.id })
    .from(usagePackSubscriptions)
    .where(
      and(
        eq(usagePackSubscriptions.orgId, args.orgId),
        args.excludeUsagePackSubscriptionId === null
          ? undefined
          : ne(usagePackSubscriptions.id, args.excludeUsagePackSubscriptionId),
        or(
          and(
            eq(
              usagePackSubscriptions.subscriptionStatus,
              USAGE_PACK_PURCHASE_CLAIM_STATUS,
            ),
            isNull(usagePackSubscriptions.stripeSubscriptionId),
            isNull(usagePackSubscriptions.stripeCheckoutSessionId),
          ),
          and(
            isNotNull(usagePackSubscriptions.stripeSubscriptionId),
            notInArray(usagePackSubscriptions.subscriptionStatus, [
              ...TERMINAL_USAGE_PACK_SUBSCRIPTION_STATUSES,
            ]),
            args.sourceSubscriptionId === null
              ? undefined
              : ne(
                  usagePackSubscriptions.stripeSubscriptionId,
                  args.sourceSubscriptionId,
                ),
          ),
        ),
      ),
    );
}

/** A fresh, unpublished Plan purchase claim on the organization row. */
export function inFlightPlanPurchaseQuery(orgId: string, staleBefore: Date) {
  return new QueryBuilder()
    .select({ orgId: orgMetadata.orgId })
    .from(orgMetadata)
    .where(
      and(
        eq(orgMetadata.orgId, orgId),
        eq(orgMetadata.subscriptionStatus, PLAN_PURCHASE_CLAIM_STATUS),
        isNull(orgMetadata.stripeSubscriptionId),
        gt(orgMetadata.updatedAt, staleBefore),
      ),
    );
}
