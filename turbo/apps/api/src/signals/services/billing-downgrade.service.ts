import { command } from "ccstate";
import type { OrgTier } from "@okouai/api-contracts/contracts/orgs";
import { orgConcurrencySubscriptions } from "@okouai/db/schema/org-concurrency-subscription";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { and, eq, sql } from "drizzle-orm";
import {
  usagePackAllocationChanges,
  usagePackSubscriptions,
} from "@okouai/db/schema/usage-pack-subscription";
import { pgTextDecoder } from "../../lib/db-structured-result";

import { logger } from "../../lib/log";
import { writeDb$ } from "../external/db";
import { settle } from "../utils";
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

import { concurrencySubscriptionUpdatedAt } from "./concurrency-subscription-write";

const L = logger("BillingDowngrade");

const TIER_RANK = Object.freeze<Record<OrgTier, number>>({
  free: 0,
  "limited-free-1": 0,
  pro: 1,
  team: 2,
  custom: 3,
});
const CANCELED_SUBSCRIPTION_TARGET_TIER = "limited-free-1";
type CancellationTargetTier = typeof CANCELED_SUBSCRIPTION_TARGET_TIER;
type DowngradeTargetTier = CancellationTargetTier | "pro";

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
  | {
      readonly ok: false;
      readonly reason: "no_subscription";
    }
  | {
      readonly ok: false;
      readonly reason: "billing_changed";
    }
  | {
      readonly ok: false;
      readonly reason: "invalid_target_tier";
      readonly currentTier: OrgTier;
      readonly targetTier: DowngradeTargetTier;
    };

export interface EmptyUsagePackCancellation {
  readonly orgId: string;
  readonly usagePackSubscriptionId: string;
  readonly allocationChangeId: string;
}

interface DowngradeArgs {
  readonly orgId: string;
  readonly targetTier: DowngradeTargetTier;
  readonly returnUrl?: string;
  readonly requirePaymentMethod?: boolean;
  readonly usagePackRemoval?: EmptyUsagePackCancellation;
}

interface PreparedDowngrade {
  readonly effectiveDate: Date;
  readonly scheduleId: string | null;
  readonly cancelAtPeriodEnd: boolean;
}

class DowngradePublicationConflict extends Error {}

interface DowngradeOrg {
  readonly tier: string;
  readonly stripeCustomerId: string | null;
  readonly stripeSubscriptionId: string;
  readonly currentPeriodEnd: Date | null;
  readonly pendingSubscriptionScheduleId: string | null;
  readonly pendingSubscriptionTargetTier: string | null;
}

interface DowngradeContext {
  readonly stripe: ReturnType<typeof getStripeClient>;
  readonly orgId: string;
  readonly org: DowngradeOrg;
  readonly concurrency: ConcurrencyChangeState | null;
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
  signal: AbortSignal,
): Promise<PreparedDowngrade> {
  const subscription = await context.stripe.subscriptions.retrieve(
    context.org.stripeSubscriptionId,
  );
  signal.throwIfAborted();

  const scheduleId =
    context.org.pendingSubscriptionScheduleId ??
    subscriptionScheduleId(subscription);
  const currentItem = subscriptionCurrentItem(subscription);
  const currentPhaseRange = subscriptionItemPhaseRange(currentItem);
  let effectiveDate =
    context.org.currentPeriodEnd ?? new Date(currentPhaseRange.endDate * 1000);
  const concurrency = context.concurrency;

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
  signal.throwIfAborted();

  return { effectiveDate, scheduleId, cancelAtPeriodEnd: true };
}

async function scheduleDowngradeToPro(
  context: DowngradeContext,
  subscription: StripeSubscription,
  signal: AbortSignal,
): Promise<PreparedDowngrade> {
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
  signal.throwIfAborted();

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
  const concurrency = context.concurrency;
  const existingAddOnSchedule =
    existingScheduleId &&
    context.org.pendingSubscriptionScheduleId !== existingScheduleId &&
    hasPendingConcurrencyChange(concurrency)
      ? await context.stripe.subscriptionSchedules.retrieve(existingScheduleId)
      : null;
  signal.throwIfAborted();

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
  signal.throwIfAborted();

  const effectiveDate = new Date(endDate * 1000);
  return { effectiveDate, scheduleId, cancelAtPeriodEnd: false };
}

interface DowngradeSnapshot {
  readonly org: DowngradeOrg;
  readonly concurrency: ConcurrencyChangeState | null;
  readonly usagePack: {
    readonly subscriptionSnapshot: string;
    readonly subscriptionRowVersion: string;
    readonly changeSnapshot: string;
    readonly changeRowVersion: string;
  } | null;
}

const downgradeSnapshot$ = command(
  async (
    { set },
    args: DowngradeArgs,
    signal: AbortSignal,
  ): Promise<DowngradeSnapshot | null> => {
    const db = set(writeDb$);
    const [org] = await db
      .select({
        tier: orgMetadata.tier,
        stripeCustomerId: orgMetadata.stripeCustomerId,
        stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
        currentPeriodEnd: orgMetadata.currentPeriodEnd,
        pendingSubscriptionScheduleId:
          orgMetadata.pendingSubscriptionScheduleId,
        pendingSubscriptionTargetTier:
          orgMetadata.pendingSubscriptionTargetTier,
      })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, args.orgId))
      .limit(1);
    signal.throwIfAborted();
    if (!org?.stripeSubscriptionId) {
      return null;
    }
    const [concurrency] = await db
      .select({
        cancelAtPeriodEnd: orgConcurrencySubscriptions.cancelAtPeriodEnd,
        currentPeriodEnd: orgConcurrencySubscriptions.currentPeriodEnd,
        scheduledSlots: orgConcurrencySubscriptions.scheduledSlots,
        scheduledChangeAt: orgConcurrencySubscriptions.scheduledChangeAt,
      })
      .from(orgConcurrencySubscriptions)
      .where(
        and(
          eq(orgConcurrencySubscriptions.orgId, args.orgId),
          eq(
            orgConcurrencySubscriptions.stripeSubscriptionId,
            org.stripeSubscriptionId,
          ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    const removal = args.usagePackRemoval;
    const [usagePack] = removal
      ? await db
          .select({
            subscriptionSnapshot: sql`${usagePackSubscriptions}::text`.mapWith(
              pgTextDecoder,
            ),
            subscriptionRowVersion:
              sql`${usagePackSubscriptions}.xmin::text`.mapWith(pgTextDecoder),
            changeSnapshot: sql`${usagePackAllocationChanges}::text`.mapWith(
              pgTextDecoder,
            ),
            changeRowVersion:
              sql`${usagePackAllocationChanges}.xmin::text`.mapWith(
                pgTextDecoder,
              ),
          })
          .from(usagePackSubscriptions)
          .innerJoin(
            usagePackAllocationChanges,
            and(
              eq(
                usagePackAllocationChanges.usagePackSubscriptionId,
                usagePackSubscriptions.id,
              ),
              eq(usagePackAllocationChanges.id, removal.allocationChangeId),
              eq(usagePackAllocationChanges.orgId, args.orgId),
              eq(usagePackAllocationChanges.kind, "removal"),
              eq(usagePackAllocationChanges.status, "applying"),
            ),
          )
          .where(
            and(
              eq(usagePackSubscriptions.id, removal.usagePackSubscriptionId),
              eq(usagePackSubscriptions.orgId, args.orgId),
              eq(
                usagePackSubscriptions.stripeSubscriptionId,
                org.stripeSubscriptionId,
              ),
            ),
          )
          .limit(1)
      : [];
    signal.throwIfAborted();
    return {
      org: { ...org, stripeSubscriptionId: org.stripeSubscriptionId },
      concurrency: concurrency ?? null,
      usagePack: usagePack ?? null,
    };
  },
);

const publishDowngrade$ = command(
  async (
    { set },
    args: DowngradeArgs & {
      readonly snapshot: DowngradeSnapshot;
      readonly prepared: PreparedDowngrade;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const { org, concurrency, usagePack } = args.snapshot;
    const { prepared } = args;
    const removal = args.usagePackRemoval;
    const superseded = supersededConcurrencyChanges(
      concurrency ?? null,
      prepared.effectiveDate,
    );
    const at = nowDate();
    const publication = await settle(
      db.transaction(async (tx) => {
        // Stripe has applied the schedule; record it as main did. Debits and
        // webhooks rewrite these rows, so no row-version guard applies here.
        await tx
          .update(orgMetadata)
          .set({
            cancelAtPeriodEnd: prepared.cancelAtPeriodEnd,
            pendingSubscriptionScheduleId: prepared.scheduleId,
            pendingSubscriptionTargetTier: args.targetTier,
            pendingSubscriptionChangeAt: prepared.effectiveDate,
            currentPeriodEnd: prepared.effectiveDate,
            updatedAt: at,
          })
          .where(eq(orgMetadata.orgId, args.orgId));
        if (concurrency && (superseded.cancel || superseded.scheduled)) {
          await tx
            .update(orgConcurrencySubscriptions)
            .set({
              ...(superseded.cancel ? { cancelAtPeriodEnd: false } : {}),
              ...(superseded.scheduled
                ? { scheduledSlots: null, scheduledChangeAt: null }
                : {}),
              updatedAt: concurrencySubscriptionUpdatedAt(at),
            })
            .where(
              and(
                eq(orgConcurrencySubscriptions.orgId, args.orgId),
                eq(
                  orgConcurrencySubscriptions.stripeSubscriptionId,
                  org.stripeSubscriptionId,
                ),
              ),
            );
        }
        if (removal && usagePack) {
          const [canceled] = await tx
            .update(usagePackSubscriptions)
            .set({
              cancelAtPeriodEnd: true,
              updatedAt: at,
            })
            .where(
              and(
                eq(usagePackSubscriptions.id, removal.usagePackSubscriptionId),
                sql`${usagePackSubscriptions}::text = ${usagePack.subscriptionSnapshot}`,
                sql`${usagePackSubscriptions}.xmin::text = ${usagePack.subscriptionRowVersion}`,
              ),
            )
            .returning({ id: usagePackSubscriptions.id });
          const [scheduled] = await tx
            .update(usagePackAllocationChanges)
            .set({
              status: "scheduled",
              stripeScheduleId: null,
              effectiveAt: prepared.effectiveDate,
              updatedAt: at,
            })
            .where(
              and(
                eq(usagePackAllocationChanges.id, removal.allocationChangeId),
                sql`${usagePackAllocationChanges}::text = ${usagePack.changeSnapshot}`,
                sql`${usagePackAllocationChanges}.xmin::text = ${usagePack.changeRowVersion}`,
              ),
            )
            .returning({ id: usagePackAllocationChanges.id });
          if (!canceled || !scheduled) {
            throw new DowngradePublicationConflict();
          }
        }
      }),
      signal,
    );
    signal.throwIfAborted();
    if (!publication.ok) {
      if (publication.error instanceof DowngradePublicationConflict) {
        return false;
      }
      throw publication.error;
    }
    return true;
  },
);

/** Prepare Stripe work, then atomically publish the original local snapshots. */
export const downgradeSubscription$ = command(
  async (
    { set },
    args: DowngradeArgs,
    signal: AbortSignal,
  ): Promise<DowngradeResult> => {
    const snapshot = await set(downgradeSnapshot$, args, signal);
    signal.throwIfAborted();
    if (!snapshot) {
      return { ok: false, reason: "no_subscription" };
    }
    const { org, concurrency, usagePack } = snapshot;
    const removal = args.usagePackRemoval;
    const currentTier = org.tier as OrgTier;
    if (TIER_RANK[args.targetTier] >= TIER_RANK[currentTier]) {
      return {
        ok: false,
        reason: "invalid_target_tier",
        currentTier,
        targetTier: args.targetTier,
      };
    }
    if (
      removal &&
      (!usagePack ||
        removal.orgId !== args.orgId ||
        args.targetTier !== CANCELED_SUBSCRIPTION_TARGET_TIER)
    ) {
      return { ok: false, reason: "billing_changed" };
    }
    const stripe = getStripeClient();
    const context: DowngradeContext = {
      stripe,
      orgId: args.orgId,
      org,
      concurrency: concurrency ?? null,
    };
    let prepared: PreparedDowngrade;
    if (args.targetTier === CANCELED_SUBSCRIPTION_TARGET_TIER) {
      prepared = await scheduleCancellationAtPeriodEnd(context, signal);
      signal.throwIfAborted();
    } else {
      const subscription = await stripe.subscriptions.retrieve(
        org.stripeSubscriptionId,
      );
      signal.throwIfAborted();
      if (args.requirePaymentMethod !== false) {
        const paymentMethod = await billingDefaultPaymentMethodStatus({
          stripe,
          org: context.org,
          subscription,
        });
        signal.throwIfAborted();
        if (!paymentMethod.ready) {
          if (!paymentMethod.customerId) {
            throw new Error(
              "Stripe subscription has no customer for downgrade",
            );
          }
          if (!args.returnUrl) {
            throw new Error(
              "returnUrl is required to collect a payment method",
            );
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
          signal.throwIfAborted();
          return { ok: true, status: "payment_method_required", checkoutUrl };
        }
      }
      prepared = await scheduleDowngradeToPro(context, subscription, signal);
      signal.throwIfAborted();
    }
    const published = await set(
      publishDowngrade$,
      { ...args, snapshot, prepared },
      signal,
    );
    signal.throwIfAborted();
    if (!published) {
      return { ok: false, reason: "billing_changed" };
    }
    const effectiveDate = prepared.effectiveDate.toISOString();
    L.debug("subscription downgrade scheduled", {
      orgId: args.orgId,
      from: currentTier,
      to: args.targetTier,
      effectiveDate,
    });
    return { ok: true, status: "scheduled", effectiveDate };
  },
);

export const cancelEmptyUsagePackSubscription$ = command(
  async (
    { set },
    cancellation: EmptyUsagePackCancellation,
    signal: AbortSignal,
  ): Promise<void> => {
    const result = await set(
      downgradeSubscription$,
      {
        orgId: cancellation.orgId,
        targetTier: CANCELED_SUBSCRIPTION_TARGET_TIER,
        requirePaymentMethod: false,
        usagePackRemoval: cancellation,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!result.ok) {
      throw new Error(
        `Failed to cancel empty usage pack subscription: ${result.reason}`,
      );
    }
    if (result.status !== "scheduled") {
      throw new Error("Usage pack cancellation unexpectedly requires payment");
    }
  },
);
