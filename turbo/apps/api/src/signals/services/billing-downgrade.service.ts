import { command } from "ccstate";
import type { OrgTier } from "@okouai/api-contracts/contracts/orgs";
import { orgConcurrencySubscriptions } from "@okouai/db/schema/org-concurrency-subscription";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { and, eq } from "drizzle-orm";

import { logger } from "../../lib/log";
import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../../lib/time";
import {
  getStripeClient,
  type StripePrice,
  type StripePriceRecurring,
  type StripeSchedulePhaseDiscountParam,
  type StripeSchedulePhaseItemParam,
  type StripeSchedulePhaseParam,
  type StripeSubscription,
  type StripeSubscriptionItem,
  type StripeSubscriptionSchedule,
} from "../external/stripe-client";
import {
  canceledUsageAllowanceScheduleMetadata,
  subscriptionScheduleFinalEnd,
  subscriptionScheduleId,
  subscriptionSchedulePhasesEndingAt,
  subscriptionSchedulePhasesReplacingPriceAt,
} from "./stripe-subscription-schedules.service";
import {
  activePriceId,
  activeUsagePackPlanPriceId,
  isUsagePackPlanPriceId,
  knownBillingPlanPriceItem,
} from "./billing-checkout.service";
import { isConcurrencyPriceId } from "./org-concurrency-entitlements.service";
import {
  BILLING_DOWNGRADE_PURPOSE,
  billingDefaultPaymentMethodStatus,
  createBillingSetupCheckout,
} from "./billing-payment-method.service";

const L = logger("BillingDowngrade");

const TIER_RANK = Object.freeze<Record<OrgTier, number>>({
  free: 0,
  "limited-free-1": 0,
  "pro-suspend": 0,
  pro: 1,
  team: 2,
  custom: 3,
});
const CANCELED_SUBSCRIPTION_TARGET_TIER = "limited-free-1";
type CancellationTargetTier = typeof CANCELED_SUBSCRIPTION_TARGET_TIER;
type LegacyCancellationTargetTier = "pro-suspend";
type DowngradeTargetTier =
  | CancellationTargetTier
  | LegacyCancellationTargetTier
  | "pro";

type DowngradeResult =
  | {
      readonly ok: true;
      readonly status: "scheduled";
      readonly effectiveDate: string | null;
    }
  | {
      readonly ok: true;
      readonly status: "payment_method_required";
      readonly checkoutUrl: string;
    }
  | { readonly ok: false; readonly reason: "no_subscription" }
  | {
      readonly ok: false;
      readonly reason: "invalid_target_tier";
      readonly currentTier: OrgTier;
      readonly targetTier: DowngradeTargetTier;
    };

interface DowngradeArgs {
  readonly orgId: string;
  readonly targetTier: DowngradeTargetTier;
  readonly returnUrl: string;
}

interface DowngradeSubscriptionForOrgArgs {
  readonly orgId: string;
  readonly targetTier: DowngradeTargetTier;
  readonly returnUrl?: string;
  readonly requirePaymentMethod?: boolean;
}

interface DowngradeOrg {
  readonly tier: string;
  readonly stripeCustomerId: string | null;
  readonly stripeSubscriptionId: string;
  readonly currentPeriodEnd: Date | null;
  readonly pendingSubscriptionScheduleId: string | null;
  readonly pendingSubscriptionTargetTier: string | null;
}

interface DowngradeContext {
  readonly db: Db;
  readonly stripe: ReturnType<typeof getStripeClient>;
  readonly orgId: string;
  readonly org: DowngradeOrg;
}

function subscriptionPhaseRange(
  schedule: StripeSubscriptionSchedule,
  subscriptionItem: StripeSubscriptionItem,
): { readonly startDate: number; readonly endDate: number } {
  const startDate =
    schedule.current_phase?.start_date ?? subscriptionItem.current_period_start;
  const endDate =
    schedule.current_phase?.end_date ?? subscriptionItem.current_period_end;

  if (endDate <= startDate) {
    throw new Error("Subscription period end must be after period start");
  }

  return { startDate, endDate };
}

function phaseDuration(price: StripePrice): StripePriceRecurring {
  const recurring = price.recurring;
  if (!recurring) {
    throw new Error("Subscription price is not recurring");
  }

  return {
    interval: recurring.interval,
    interval_count: recurring.interval_count,
  };
}

function schedulePhaseItem(
  priceId: string,
  quantity: number | undefined,
): StripeSchedulePhaseItemParam {
  return {
    price: priceId,
    quantity: quantity ?? 1,
  };
}

function stripeObjectId(
  value: string | { readonly id: string } | null,
): string | null {
  if (typeof value === "string") {
    return value;
  }
  return value?.id ?? null;
}

function subscriptionSchedulePhaseDiscounts(
  subscription: StripeSubscription,
): StripeSchedulePhaseDiscountParam[] {
  const discounts = subscription.discounts ?? [];
  return discounts.flatMap((discount) => {
    const discountId = stripeObjectId(discount);
    return discountId ? [{ discount: discountId }] : [];
  });
}

function phaseWithDiscounts(
  phase: StripeSchedulePhaseParam,
  discounts: StripeSchedulePhaseDiscountParam[],
): StripeSchedulePhaseParam {
  if (discounts.length === 0) {
    return phase;
  }

  return {
    ...phase,
    discounts,
  };
}

function subscriptionCurrentItem(
  subscription: StripeSubscription,
): StripeSubscriptionItem {
  const currentItem = knownBillingPlanPriceItem(subscription.items.data);
  if (!currentItem) {
    throw new Error("Subscription has no known plan item");
  }
  return currentItem;
}

function subscriptionPhaseItems(
  subscription: StripeSubscription,
): StripeSchedulePhaseItemParam[] {
  return subscription.items.data.map((item) => {
    return schedulePhaseItem(item.price.id, item.quantity);
  });
}

function subscriptionItemPhaseRange(subscriptionItem: StripeSubscriptionItem): {
  readonly startDate: number;
  readonly endDate: number;
} {
  const startDate = subscriptionItem.current_period_start;
  const endDate = subscriptionItem.current_period_end;

  if (endDate <= startDate) {
    throw new Error("Subscription period end must be after period start");
  }

  return { startDate, endDate };
}

function subscriptionCancelAt(subscription: StripeSubscription): Date | null {
  return typeof subscription.cancel_at === "number"
    ? new Date(subscription.cancel_at * 1000)
    : null;
}

function dateUnixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

function shouldReplacePendingDowngradeSchedule(
  context: DowngradeContext,
  scheduleId: string,
): boolean {
  return (
    context.org.tier === "team" &&
    context.org.pendingSubscriptionScheduleId === scheduleId &&
    context.org.pendingSubscriptionTargetTier === "pro"
  );
}

interface ConcurrencyChangeState {
  readonly cancelAtPeriodEnd: boolean;
  readonly currentPeriodEnd: Date | null;
  readonly scheduledSlots: number | null;
  readonly scheduledChangeAt: Date | null;
}

async function concurrencyChangeState(
  context: DowngradeContext,
): Promise<ConcurrencyChangeState | null> {
  const [concurrency] = await context.db
    .select({
      cancelAtPeriodEnd: orgConcurrencySubscriptions.cancelAtPeriodEnd,
      currentPeriodEnd: orgConcurrencySubscriptions.currentPeriodEnd,
      scheduledSlots: orgConcurrencySubscriptions.scheduledSlots,
      scheduledChangeAt: orgConcurrencySubscriptions.scheduledChangeAt,
    })
    .from(orgConcurrencySubscriptions)
    .where(
      and(
        eq(orgConcurrencySubscriptions.orgId, context.orgId),
        eq(
          orgConcurrencySubscriptions.stripeSubscriptionId,
          context.org.stripeSubscriptionId,
        ),
      ),
    )
    .limit(1);
  return concurrency ?? null;
}

function supersededConcurrencyChanges(
  concurrency: ConcurrencyChangeState | null,
  effectiveDate: Date,
): { readonly cancel: boolean; readonly scheduled: boolean } {
  const cancelSuperseded =
    concurrency?.cancelAtPeriodEnd === true &&
    (!concurrency.currentPeriodEnd ||
      concurrency.currentPeriodEnd >= effectiveDate);
  const scheduledChangeSuperseded =
    concurrency?.scheduledSlots !== null &&
    concurrency?.scheduledSlots !== undefined &&
    (!concurrency.scheduledChangeAt ||
      concurrency.scheduledChangeAt >= effectiveDate);
  return { cancel: cancelSuperseded, scheduled: scheduledChangeSuperseded };
}

async function clearConcurrencyChangeSupersededByPlanEnd(
  context: DowngradeContext,
  concurrency: ConcurrencyChangeState | null,
  effectiveDate: Date,
): Promise<void> {
  const superseded = supersededConcurrencyChanges(concurrency, effectiveDate);
  if (!superseded.cancel && !superseded.scheduled) {
    return;
  }

  await context.db
    .update(orgConcurrencySubscriptions)
    .set({
      ...(superseded.cancel ? { cancelAtPeriodEnd: false } : {}),
      ...(superseded.scheduled
        ? { scheduledSlots: null, scheduledChangeAt: null }
        : {}),
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(orgConcurrencySubscriptions.orgId, context.orgId),
        eq(
          orgConcurrencySubscriptions.stripeSubscriptionId,
          context.org.stripeSubscriptionId,
        ),
      ),
    );
}

function hasPendingConcurrencyChange(
  concurrency: ConcurrencyChangeState | null,
): boolean {
  return (
    concurrency?.cancelAtPeriodEnd === true ||
    (concurrency?.scheduledSlots !== null &&
      concurrency?.scheduledSlots !== undefined)
  );
}

async function scheduleCancellationOnExistingSchedule(
  context: DowngradeContext,
  subscription: StripeSubscription,
  scheduleId: string,
  effectiveDate: Date,
  concurrency: ConcurrencyChangeState | null,
): Promise<Date> {
  if (shouldReplacePendingDowngradeSchedule(context, scheduleId)) {
    const discounts = subscriptionSchedulePhaseDiscounts(subscription);
    const currentPhaseRange = subscriptionItemPhaseRange(
      subscriptionCurrentItem(subscription),
    );
    await context.stripe.subscriptionSchedules.update(scheduleId, {
      end_behavior: "cancel",
      proration_behavior: "none",
      phases: [
        phaseWithDiscounts(
          {
            start_date: currentPhaseRange.startDate,
            end_date: currentPhaseRange.endDate,
            items: subscriptionPhaseItems(subscription),
            proration_behavior: "none",
          },
          discounts,
        ),
      ],
    });
    return effectiveDate;
  }

  const schedule =
    await context.stripe.subscriptionSchedules.retrieve(scheduleId);
  if (
    context.org.pendingSubscriptionScheduleId === scheduleId ||
    !hasPendingConcurrencyChange(concurrency)
  ) {
    await context.stripe.subscriptionSchedules.update(scheduleId, {
      end_behavior: "cancel",
      proration_behavior: "none",
    });
    return subscriptionScheduleFinalEnd(schedule) ?? effectiveDate;
  }

  await context.stripe.subscriptionSchedules.update(scheduleId, {
    end_behavior: "cancel",
    proration_behavior: "none",
    phases: [
      ...subscriptionSchedulePhasesEndingAt(
        schedule,
        dateUnixSeconds(effectiveDate),
        canceledUsageAllowanceScheduleMetadata(subscription),
      ),
    ],
  });
  return effectiveDate;
}

async function scheduleCancellationWithoutSchedule(
  context: DowngradeContext,
  subscription: StripeSubscription,
  effectiveDate: Date,
  currentPhaseEnd: number,
): Promise<Date> {
  const cancelAt = subscriptionCancelAt(subscription);
  if (cancelAt) {
    return cancelAt;
  }

  if (
    context.org.currentPeriodEnd &&
    dateUnixSeconds(context.org.currentPeriodEnd) > currentPhaseEnd
  ) {
    await context.stripe.subscriptions.update(
      context.org.stripeSubscriptionId,
      {
        cancel_at: dateUnixSeconds(context.org.currentPeriodEnd),
      },
    );
    return context.org.currentPeriodEnd;
  }

  await context.stripe.subscriptions.update(context.org.stripeSubscriptionId, {
    cancel_at_period_end: true,
  });
  return effectiveDate;
}

async function scheduleCancellationAtPeriodEnd(
  context: DowngradeContext,
  signal?: AbortSignal,
): Promise<string> {
  const subscription = await context.stripe.subscriptions.retrieve(
    context.org.stripeSubscriptionId,
  );
  signal?.throwIfAborted();

  const scheduleId =
    context.org.pendingSubscriptionScheduleId ??
    subscriptionScheduleId(subscription);
  const currentItem = subscriptionCurrentItem(subscription);
  const currentPhaseRange = subscriptionItemPhaseRange(currentItem);
  let effectiveDate =
    context.org.currentPeriodEnd ?? new Date(currentPhaseRange.endDate * 1000);
  const concurrency = await concurrencyChangeState(context);
  signal?.throwIfAborted();

  if (scheduleId) {
    effectiveDate = await scheduleCancellationOnExistingSchedule(
      context,
      subscription,
      scheduleId,
      effectiveDate,
      concurrency,
    );
  } else {
    effectiveDate = await scheduleCancellationWithoutSchedule(
      context,
      subscription,
      effectiveDate,
      currentPhaseRange.endDate,
    );
  }
  signal?.throwIfAborted();

  await clearConcurrencyChangeSupersededByPlanEnd(
    context,
    concurrency,
    effectiveDate,
  );
  signal?.throwIfAborted();

  await context.db
    .update(orgMetadata)
    .set({
      cancelAtPeriodEnd: true,
      pendingSubscriptionScheduleId: scheduleId,
      pendingSubscriptionTargetTier: CANCELED_SUBSCRIPTION_TARGET_TIER,
      pendingSubscriptionChangeAt: effectiveDate,
      currentPeriodEnd: effectiveDate,
      updatedAt: nowDate(),
    })
    .where(eq(orgMetadata.orgId, context.orgId));
  signal?.throwIfAborted();

  const effectiveDateIso = effectiveDate.toISOString();
  L.debug("subscription cancellation initiated", {
    orgId: context.orgId,
    targetTier: CANCELED_SUBSCRIPTION_TARGET_TIER,
    effectiveDate: effectiveDateIso,
  });
  return effectiveDateIso;
}

async function scheduleDowngradeToPro(
  context: DowngradeContext,
  currentTier: OrgTier,
  subscription: StripeSubscription,
  signal?: AbortSignal,
): Promise<string> {
  const currentItem = subscriptionCurrentItem(subscription);
  const proPriceId = isUsagePackPlanPriceId(currentItem.price.id)
    ? activeUsagePackPlanPriceId("pro")
    : activePriceId("pro");
  if (!proPriceId) {
    throw new Error("Pro plan price ID not configured");
  }

  const existingScheduleId =
    context.org.pendingSubscriptionScheduleId ??
    subscriptionScheduleId(subscription);
  const createdSchedule = existingScheduleId
    ? null
    : await context.stripe.subscriptionSchedules.create({
        from_subscription: context.org.stripeSubscriptionId,
      });
  signal?.throwIfAborted();

  const scheduleId = existingScheduleId ?? createdSchedule?.id;
  if (!scheduleId) {
    throw new Error("Subscription schedule ID is missing");
  }

  const { startDate, endDate } = createdSchedule
    ? subscriptionPhaseRange(createdSchedule, currentItem)
    : subscriptionItemPhaseRange(currentItem);
  const currentPriceId = currentItem.price.id;
  const quantity = currentItem.quantity;
  const discounts = subscriptionSchedulePhaseDiscounts(subscription);
  const concurrency = await concurrencyChangeState(context);
  signal?.throwIfAborted();
  const existingAddOnSchedule =
    existingScheduleId &&
    context.org.pendingSubscriptionScheduleId !== existingScheduleId &&
    hasPendingConcurrencyChange(concurrency)
      ? await context.stripe.subscriptionSchedules.retrieve(existingScheduleId)
      : null;
  signal?.throwIfAborted();

  const phases = existingAddOnSchedule
    ? subscriptionSchedulePhasesReplacingPriceAt(existingAddOnSchedule, {
        effectiveAt: endDate,
        sourcePriceId: currentPriceId,
        targetPriceId: proPriceId,
        targetQuantity: quantity ?? 1,
      }).map((phase) => {
        return phase.start_date !== undefined && phase.start_date >= endDate
          ? {
              ...phase,
              items: phase.items.filter((item) => {
                return !isConcurrencyPriceId(item.price);
              }),
            }
          : phase;
      })
    : [
        phaseWithDiscounts(
          {
            start_date: startDate,
            end_date: endDate,
            items: subscriptionPhaseItems(subscription),
            proration_behavior: "none",
          },
          discounts,
        ),
        phaseWithDiscounts(
          {
            start_date: endDate,
            duration: phaseDuration(currentItem.price),
            items: subscription.items.data.flatMap((item) => {
              if (isConcurrencyPriceId(item.price.id)) {
                return [];
              }
              return [
                schedulePhaseItem(
                  item.price.id === currentPriceId ? proPriceId : item.price.id,
                  item.price.id === currentPriceId ? quantity : item.quantity,
                ),
              ];
            }),
            proration_behavior: "none",
          },
          discounts,
        ),
      ];

  await context.stripe.subscriptionSchedules.update(scheduleId, {
    end_behavior: "release",
    proration_behavior: "none",
    phases,
  });
  signal?.throwIfAborted();

  const effectiveDate = new Date(endDate * 1000);
  await clearConcurrencyChangeSupersededByPlanEnd(
    context,
    concurrency,
    effectiveDate,
  );
  signal?.throwIfAborted();

  await context.db
    .update(orgMetadata)
    .set({
      cancelAtPeriodEnd: false,
      pendingSubscriptionScheduleId: scheduleId,
      pendingSubscriptionTargetTier: "pro",
      pendingSubscriptionChangeAt: effectiveDate,
      currentPeriodEnd: effectiveDate,
      updatedAt: nowDate(),
    })
    .where(eq(orgMetadata.orgId, context.orgId));
  signal?.throwIfAborted();

  const effectiveDateIso = effectiveDate.toISOString();
  L.debug("subscription downgrade scheduled", {
    orgId: context.orgId,
    from: currentTier,
    to: "pro",
    effectiveDate: effectiveDateIso,
  });
  return effectiveDateIso;
}

/**
 * Downgrade an org's Stripe subscription. Two branches:
 * - `* → limited-free-1`: schedules cancellation and flips the local
 *   `cancelAtPeriodEnd` flag. Existing `cancel_at`, fixed-term paid-through
 *   dates, and external schedule final ends are preserved.
 * - `team → pro`: schedules a period-end phase change to Pro. effectiveDate
 *   is the current phase end ISO string.
 */
export async function downgradeSubscriptionForOrg(
  db: Db,
  args: DowngradeSubscriptionForOrgArgs,
  signal?: AbortSignal,
): Promise<DowngradeResult> {
  const [org] = await db
    .select({
      tier: orgMetadata.tier,
      stripeCustomerId: orgMetadata.stripeCustomerId,
      stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
      currentPeriodEnd: orgMetadata.currentPeriodEnd,
      pendingSubscriptionScheduleId: orgMetadata.pendingSubscriptionScheduleId,
      pendingSubscriptionTargetTier: orgMetadata.pendingSubscriptionTargetTier,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, args.orgId))
    .limit(1);
  signal?.throwIfAborted();

  if (!org?.stripeSubscriptionId) {
    return { ok: false, reason: "no_subscription" };
  }

  const currentTier = org.tier as OrgTier;
  if (TIER_RANK[args.targetTier] >= TIER_RANK[currentTier]) {
    return {
      ok: false,
      reason: "invalid_target_tier",
      currentTier,
      targetTier: args.targetTier,
    };
  }

  const stripe = getStripeClient();
  const downgradeOrg: DowngradeOrg = {
    tier: org.tier,
    stripeCustomerId: org.stripeCustomerId,
    stripeSubscriptionId: org.stripeSubscriptionId,
    currentPeriodEnd: org.currentPeriodEnd,
    pendingSubscriptionScheduleId: org.pendingSubscriptionScheduleId,
    pendingSubscriptionTargetTier: org.pendingSubscriptionTargetTier,
  };
  const context = {
    db,
    stripe,
    orgId: args.orgId,
    org: downgradeOrg,
  };

  if (
    args.targetTier === CANCELED_SUBSCRIPTION_TARGET_TIER ||
    args.targetTier === "pro-suspend"
  ) {
    const effectiveDate = await scheduleCancellationAtPeriodEnd(
      context,
      signal,
    );
    return { ok: true, status: "scheduled", effectiveDate };
  }

  const subscription = await stripe.subscriptions.retrieve(
    org.stripeSubscriptionId,
  );
  signal?.throwIfAborted();

  if (args.requirePaymentMethod !== false) {
    const paymentMethod = await billingDefaultPaymentMethodStatus({
      stripe,
      org: downgradeOrg,
      subscription,
    });
    if (!paymentMethod.ready) {
      if (!paymentMethod.customerId) {
        throw new Error("Stripe subscription has no customer for downgrade");
      }
      if (!args.returnUrl) {
        throw new Error("returnUrl is required to collect a payment method");
      }

      const checkoutUrl = await createBillingSetupCheckout({
        stripe,
        purpose: BILLING_DOWNGRADE_PURPOSE,
        orgId: args.orgId,
        customerId: paymentMethod.customerId,
        subscriptionId: org.stripeSubscriptionId,
        returnUrl: args.returnUrl,
        metadata: { targetTier: args.targetTier },
      });
      return { ok: true, status: "payment_method_required", checkoutUrl };
    }
  }

  const effectiveDate = await scheduleDowngradeToPro(
    context,
    currentTier,
    subscription,
    signal,
  );
  return { ok: true, status: "scheduled", effectiveDate };
}

export const downgradeSubscription$ = command(
  async (
    { set },
    args: DowngradeArgs,
    signal: AbortSignal,
  ): Promise<DowngradeResult> => {
    const writeDb = set(writeDb$);
    return await downgradeSubscriptionForOrg(writeDb, args, signal);
  },
);
