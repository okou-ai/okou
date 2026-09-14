import { command } from "ccstate";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { orgUsageAllowanceEntitlements } from "@okouai/db/schema/org-usage-allowance";
import { and, eq, gt, inArray, isNotNull, lte } from "drizzle-orm";

import { writeDb$ } from "../external/db";
import { getStripeClient } from "../external/stripe-client";
import { nowDate } from "../../lib/time";
import { logger } from "../../lib/log";

const L = logger("OrgBillingPeriod");
const ACTIVE_USAGE_ALLOWANCE_STATUSES = [
  "active",
  "manual_active",
  "trialing",
  "past_due",
  "unpaid",
] as const;

interface OrgBillingPeriod {
  readonly start: Date;
  readonly end: Date;
}

function resolveUsageAllowancePeriod(
  row:
    | {
        readonly allowancePeriodStart: Date | null;
        readonly allowancePeriodEnd: Date | null;
      }
    | undefined,
): OrgBillingPeriod | null {
  if (!row?.allowancePeriodStart || !row.allowancePeriodEnd) {
    return null;
  }

  return {
    start: row.allowancePeriodStart,
    end: row.allowancePeriodEnd,
  };
}

interface StoredBillingPeriod {
  readonly start: Date | null;
  readonly end: Date | null;
}

function resolveStoredBillingPeriod(args: {
  readonly planStart: Date | null;
  readonly planEnd: Date | null;
  readonly metadataEnd: Date | null;
}): StoredBillingPeriod {
  // Older API versions can update orgMetadata first during a rolling
  // deployment. Prefer its later end, but let equal entitlement periods
  // supply the exact start.
  if (
    args.planEnd !== null &&
    (args.metadataEnd === null ||
      args.planEnd.getTime() >= args.metadataEnd.getTime())
  ) {
    return { start: args.planStart, end: args.planEnd };
  }
  return { start: null, end: args.metadataEnd };
}

/**
 * Resolve an org's current billing period `{ start, end }`.
 *
 * Reads the exact period stored for an active usage-allowance subscription
 * first because that subscription owns the credit-usage billing cycle across
 * plan tiers. Falls back to `orgPlanEntitlements`, including non-monthly
 * Custom plan grants, and then to
 * `orgMetadata.currentPeriodEnd`; if missing or expired AND a
 * `stripeSubscriptionId` exists, retrieves the Stripe subscription and writes
 * the refreshed value back to orgMetadata. This API service owns the runtime
 * behavior and preserves the Stripe-API rationale and past-dated guard.
 *
 * Returns `null` for free-tier orgs (no subscription, no period). Callers
 * MUST short-circuit on null — there is no synthetic period for the free
 * tier; spend admission already handles per-request cap enforcement.
 *
 * In Stripe v2025 API, `current_period_end` was removed from the top-level
 * Subscription object. The replacement is
 * `subscription.items.data[i].current_period_end` — the end time of the
 * subscription item's current billing period. Do NOT read
 * `invoice.period_end` (that's the accrual period for the invoice, not the
 * subscription period, and for renewal invoices collapses to the invoice
 * creation moment, which would cause this function to re-fetch Stripe on
 * every call).
 */
export const getOrgBillingPeriod$ = command(
  async (
    { set },
    orgId: string,
    signal: AbortSignal,
  ): Promise<OrgBillingPeriod | null> => {
    const writeDb = set(writeDb$);
    const now = nowDate();

    const [orgRow] = await writeDb
      .select({
        allowancePeriodStart: orgUsageAllowanceEntitlements.effectiveAt,
        allowancePeriodEnd: orgUsageAllowanceEntitlements.expiresAt,
        planPeriodStart: orgPlanEntitlements.currentPeriodStart,
        planPeriodEnd: orgPlanEntitlements.currentPeriodEnd,
        currentPeriodEnd: orgMetadata.currentPeriodEnd,
        stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
      })
      .from(orgMetadata)
      .leftJoin(
        orgPlanEntitlements,
        eq(orgPlanEntitlements.orgId, orgMetadata.orgId),
      )
      .leftJoin(
        orgUsageAllowanceEntitlements,
        and(
          eq(orgUsageAllowanceEntitlements.orgId, orgMetadata.orgId),
          inArray(orgUsageAllowanceEntitlements.status, [
            ...ACTIVE_USAGE_ALLOWANCE_STATUSES,
          ]),
          isNotNull(orgUsageAllowanceEntitlements.stripeSubscriptionId),
          lte(orgUsageAllowanceEntitlements.effectiveAt, now),
          gt(orgUsageAllowanceEntitlements.expiresAt, now),
        ),
      )
      .where(eq(orgMetadata.orgId, orgId))
      .limit(1);
    signal.throwIfAborted();

    const allowancePeriod = resolveUsageAllowancePeriod(orgRow);
    if (allowancePeriod) {
      L.debug("billing period resolved", {
        orgId,
        source: "usage_allowance",
        periodStart: allowancePeriod.start,
        periodEnd: allowancePeriod.end,
      });
      return allowancePeriod;
    }

    const storedPeriod = resolveStoredBillingPeriod({
      planStart: orgRow?.planPeriodStart ?? null,
      planEnd: orgRow?.planPeriodEnd ?? null,
      metadataEnd: orgRow?.currentPeriodEnd ?? null,
    });
    let periodStart = storedPeriod.start;
    let periodEnd = storedPeriod.end;

    if ((!periodEnd || periodEnd < now) && orgRow?.stripeSubscriptionId) {
      if (periodEnd && periodEnd < now) {
        L.warn("currentPeriodEnd is stale, refreshing from Stripe", {
          orgId,
          currentPeriodEnd: periodEnd,
        });
      }
      const stripe = getStripeClient();
      const subscription = await stripe.subscriptions.retrieve(
        orgRow.stripeSubscriptionId,
      );
      signal.throwIfAborted();
      const itemPeriodEnd = subscription.items.data[0]?.current_period_end;
      if (itemPeriodEnd) {
        const refreshed = new Date(itemPeriodEnd * 1000);
        // Don't cache a past-dated period. If Stripe returns a past-dated
        // current_period_end for a subscription we believe is active,
        // something is wrong (stale Stripe data, field confusion from a
        // future code change, or an orphaned subscription). Log at warn
        // and return null without caching — caching the bad value would
        // cause an infinite "refresh from Stripe" loop on every call.
        if (refreshed < now) {
          L.warn("refreshed periodEnd still in past, not caching", {
            orgId,
            stripeSubscriptionId: orgRow.stripeSubscriptionId,
            periodEnd: refreshed,
          });
          return null;
        }
        periodStart = null;
        periodEnd = refreshed;
        await writeDb
          .update(orgMetadata)
          .set({ currentPeriodEnd: periodEnd, updatedAt: nowDate() })
          .where(eq(orgMetadata.orgId, orgId));
        signal.throwIfAborted();
      }
    }

    if (periodEnd) {
      if (!periodStart) {
        periodStart = new Date(periodEnd);
        periodStart.setMonth(periodStart.getMonth() - 1);
      }
      L.debug("billing period resolved", { orgId, periodStart, periodEnd });
      return { start: periodStart, end: periodEnd };
    }

    return null;
  },
);
