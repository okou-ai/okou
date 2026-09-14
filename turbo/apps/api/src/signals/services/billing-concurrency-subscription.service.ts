import { retireImpactMetadata } from "../../lib/impact-marketing";
import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import type {
  ConcurrencySubscriptionChangePreviewResponse,
  ConcurrencySubscriptionChangeResponse,
} from "@okouai/api-contracts/contracts/billing";
import { orgConcurrencySubscriptions } from "@okouai/db/schema/org-concurrency-subscription";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgPlanEntitlements } from "@okouai/db/schema/org-plan-entitlement";
import { orgUsageAllowanceEntitlements } from "@okouai/db/schema/org-usage-allowance";
import {
  usagePackAllocationChanges,
  usagePackSubscriptionChanges,
} from "@okouai/db/schema/usage-pack-subscription";
import { and, eq } from "drizzle-orm";

import {
  getStripeClient,
  stripeErrorInfo,
  type StripeClient,
  type StripeInvoice,
  type StripeInvoiceCreatePreviewParams,
  type StripeInvoiceLine,
  type StripePriceRecurring,
  type StripeRef,
  type StripeSchedulePhase,
  type StripeSchedulePhaseDiscountParam,
  type StripeSchedulePhaseItemParam,
  type StripeSchedulePhaseParam,
  type StripeSubscription,
  type StripeSubscriptionItem,
  type StripeSubscriptionSchedule,
  type StripeSubscriptionUpdateItemParam,
} from "../external/stripe-client";
import { nowDate } from "../../lib/time";
import { db$, writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { settle } from "../utils";
import {
  activeConcurrencySubscriptions,
  isConcurrencyPriceId,
} from "./org-concurrency-entitlements.service";
import { completeBillingOperationInvoice } from "./billing-operation-invoice.service";
import {
  setStripeSubscriptionPaymentMethod,
  type BillingPurchasePaymentMethod,
} from "./billing-payment-method.service";
import {
  canceledUsageAllowanceScheduleMetadata,
  subscriptionScheduleHasNoFutureChanges,
} from "./stripe-subscription-schedules.service";

const CONCURRENCY_SUBSCRIPTION_QUANTITY_MAX = 1000;
const STRIPE_INVOICE_LINE_PAGE_SIZE = 100;

interface ConcurrencySubscriptionArgs {
  readonly orgId: string;
  readonly subscriptionId: string;
}

interface ConcurrencySubscriptionChangeArgs extends ConcurrencySubscriptionArgs {
  readonly quantity: number;
}

interface ConfirmedConcurrencySubscriptionChangeArgs extends ConcurrencySubscriptionChangeArgs {
  readonly paymentMethod?: BillingPurchasePaymentMethod;
}

interface StripeConcurrencySubscriptionChangeArgs extends ConcurrencySubscriptionArgs {
  readonly quantity: number;
  readonly mode: "absolute" | "increase" | "reduce";
  readonly hasScheduledConcurrencyChange: boolean;
  readonly paymentMethod?: BillingPurchasePaymentMethod;
}

interface AddStripeConcurrencySubscriptionItemArgs extends ConcurrencySubscriptionArgs {
  readonly priceId: string;
  readonly quantity: number;
  readonly paymentMethod?: BillingPurchasePaymentMethod;
}

type CancelConcurrencySubscriptionResult =
  | {
      readonly ok: true;
      readonly currentPeriodEnd: string | null;
    }
  | {
      readonly ok: false;
      readonly reason: "not_found" | "pending_update" | "plan_ending";
    };

type PreviewConcurrencySubscriptionChangeResult =
  | {
      readonly ok: true;
      readonly preview: ConcurrencySubscriptionChangePreviewResponse;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "not_found"
        | "canceling"
        | "invalid_quantity"
        | "no_change"
        | "pending_update"
        | "plan_ending";
    };

type ChangeConcurrencySubscriptionResult =
  | {
      readonly ok: true;
      readonly response: ConcurrencySubscriptionChangeResponse;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "not_found"
        | "canceling"
        | "invalid_quantity"
        | "pending_update"
        | "plan_ending";
    };

type StripeConcurrencySubscriptionChangeResult =
  | {
      readonly ok: true;
      readonly response: ConcurrencySubscriptionChangeResponse;
      readonly subscription: StripeSubscription;
    }
  | {
      readonly ok: false;
      readonly reason: "invalid_quantity" | "pending_update" | "plan_ending";
    };

async function findActiveConcurrencySubscription(
  db: ReadonlyDb,
  args: ConcurrencySubscriptionArgs,
): Promise<
  Awaited<ReturnType<typeof activeConcurrencySubscriptions>>[number] | null
> {
  const subscriptions = await activeConcurrencySubscriptions(
    db,
    args.orgId,
    nowDate(),
  );
  return (
    subscriptions.find((candidate) => {
      return candidate.id === args.subscriptionId;
    }) ?? null
  );
}

type SharedBillingSubscriptionKind = "plan" | "allowance" | null;

async function sharedBillingSubscriptionKind(
  db: ReadonlyDb,
  args: ConcurrencySubscriptionArgs,
): Promise<SharedBillingSubscriptionKind> {
  const [plan] = await db
    .select({ orgId: orgPlanEntitlements.orgId })
    .from(orgPlanEntitlements)
    .where(
      and(
        eq(orgPlanEntitlements.orgId, args.orgId),
        eq(orgPlanEntitlements.stripeSubscriptionId, args.subscriptionId),
      ),
    )
    .limit(1);
  if (plan) {
    return "plan";
  }
  const [allowance] = await db
    .select({ orgId: orgUsageAllowanceEntitlements.orgId })
    .from(orgUsageAllowanceEntitlements)
    .where(
      and(
        eq(orgUsageAllowanceEntitlements.orgId, args.orgId),
        eq(
          orgUsageAllowanceEntitlements.stripeSubscriptionId,
          args.subscriptionId,
        ),
      ),
    )
    .limit(1);
  return allowance ? "allowance" : null;
}

async function writeScheduledConcurrencyChange(
  db: Db,
  args: {
    readonly orgId: string;
    readonly subscriptionId: string;
    readonly quantity: number | null;
    readonly effectiveAt: string | null;
  },
): Promise<void> {
  await db
    .update(orgConcurrencySubscriptions)
    .set({
      scheduledSlots: args.quantity,
      scheduledChangeAt: args.effectiveAt ? new Date(args.effectiveAt) : null,
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(orgConcurrencySubscriptions.orgId, args.orgId),
        eq(
          orgConcurrencySubscriptions.stripeSubscriptionId,
          args.subscriptionId,
        ),
      ),
    );
}

function concurrencySubscriptionItem(
  items: readonly StripeSubscriptionItem[],
): {
  readonly id: string;
  readonly priceId: string;
  readonly quantity: number;
} | null {
  const item = concurrencyPriceItem(items);
  if (!item || !item.quantity) {
    return null;
  }
  return { id: item.id, priceId: item.price.id, quantity: item.quantity };
}

function requiredConcurrencySubscriptionItem(
  items: readonly StripeSubscriptionItem[],
): NonNullable<ReturnType<typeof concurrencySubscriptionItem>> {
  const item = concurrencySubscriptionItem(items);
  if (!item) {
    throw new Error("Concurrency subscription has no active concurrency item");
  }
  return item;
}

function concurrencyPriceItem(
  items: readonly StripeSubscriptionItem[],
): StripeSubscriptionItem | undefined {
  return items.find((candidate) => {
    return isConcurrencyPriceId(candidate.price.id);
  });
}

function stripeObjectId(value: StripeRef | undefined): string | null {
  if (typeof value === "string") {
    return value;
  }
  return value?.id ?? null;
}

type ConcurrencyScheduleOwner = "plan" | "shared" | null;

async function concurrencyScheduleOwner(
  db: ReadonlyDb,
  orgId: string,
  subscriptionId: string,
  schedule: StripeSubscriptionSchedule,
): Promise<ConcurrencyScheduleOwner> {
  const [usagePackChange] = await db
    .select({
      subscriptionChangeId: usagePackAllocationChanges.subscriptionChangeId,
      sourceTier: usagePackSubscriptionChanges.sourceTier,
      targetTier: usagePackSubscriptionChanges.targetTier,
    })
    .from(usagePackAllocationChanges)
    .leftJoin(
      usagePackSubscriptionChanges,
      eq(
        usagePackSubscriptionChanges.id,
        usagePackAllocationChanges.subscriptionChangeId,
      ),
    )
    .where(
      and(
        eq(usagePackAllocationChanges.orgId, orgId),
        eq(usagePackAllocationChanges.stripeScheduleId, schedule.id),
        eq(usagePackAllocationChanges.status, "scheduled"),
      ),
    )
    .limit(1);
  if (usagePackChange) {
    return usagePackChange.subscriptionChangeId !== null &&
      usagePackChange.sourceTier !== usagePackChange.targetTier
      ? "plan"
      : "shared";
  }

  const [sharedSubscription] = await db
    .select({
      planPriceId: orgPlanEntitlements.stripePriceId,
      allowanceOrgId: orgUsageAllowanceEntitlements.orgId,
      pendingPlanScheduleId: orgMetadata.pendingSubscriptionScheduleId,
    })
    .from(orgPlanEntitlements)
    .leftJoin(
      orgUsageAllowanceEntitlements,
      and(
        eq(orgUsageAllowanceEntitlements.orgId, orgPlanEntitlements.orgId),
        eq(
          orgUsageAllowanceEntitlements.stripeSubscriptionId,
          orgPlanEntitlements.stripeSubscriptionId,
        ),
      ),
    )
    .leftJoin(orgMetadata, eq(orgMetadata.orgId, orgPlanEntitlements.orgId))
    .where(
      and(
        eq(orgPlanEntitlements.orgId, orgId),
        eq(orgPlanEntitlements.stripeSubscriptionId, subscriptionId),
      ),
    )
    .limit(1);
  if (
    !sharedSubscription?.planPriceId ||
    (!sharedSubscription.allowanceOrgId &&
      schedule.end_behavior !== "cancel" &&
      sharedSubscription.pendingPlanScheduleId !== schedule.id)
  ) {
    return null;
  }
  return schedulePreservesPlanItem(schedule, sharedSubscription.planPriceId)
    ? "shared"
    : "plan";
}

function subscriptionPhaseItems(
  subscription: StripeSubscription,
): StripeSchedulePhaseItemParam[] {
  return subscription.items.data.map((item) => {
    return { price: item.price.id, quantity: item.quantity ?? 1 };
  });
}

function subscriptionPhaseDiscounts(
  subscription: StripeSubscription,
): StripeSchedulePhaseDiscountParam[] {
  return (subscription.discounts ?? []).flatMap((discount) => {
    const id = stripeObjectId(discount);
    return id ? [{ discount: id }] : [];
  });
}

function phaseWithDiscounts(
  phase: StripeSchedulePhaseParam,
  discounts: readonly StripeSchedulePhaseDiscountParam[],
): StripeSchedulePhaseParam {
  return discounts.length === 0
    ? phase
    : { ...phase, discounts: [...discounts] };
}

function schedulePhaseItems(
  phase: StripeSchedulePhase,
): StripeSchedulePhaseItemParam[] {
  if (!phase.items || phase.items.length === 0) {
    throw new Error("Stripe subscription schedule phase has no items");
  }
  return phase.items.map((item) => {
    const price = stripeObjectId(item.price);
    const quantity = item.quantity ?? 1;
    if (!price || !Number.isSafeInteger(quantity) || quantity < 1) {
      throw new Error("Stripe subscription schedule phase has invalid items");
    }
    const discounts = scheduleDiscounts(item.discounts ?? []);
    const taxRates = (item.tax_rates ?? []).map((taxRate) => {
      const id = stripeObjectId(taxRate);
      if (!id) {
        throw new Error(
          "Stripe subscription schedule item has an invalid tax rate",
        );
      }
      return id;
    });
    return {
      price,
      quantity,
      ...(discounts.length > 0 ? { discounts } : {}),
      ...(item.metadata
        ? { metadata: retireImpactMetadata(item.metadata) }
        : {}),
      ...(taxRates.length > 0 ? { tax_rates: taxRates } : {}),
    };
  });
}

function scheduleDiscounts(
  discounts: NonNullable<StripeSchedulePhase["discounts"]>,
): StripeSchedulePhaseDiscountParam[] {
  return discounts.map((discount) => {
    const discountId = stripeObjectId(discount.discount);
    if (discountId) {
      return { discount: discountId };
    }
    const couponId = stripeObjectId(discount.coupon);
    if (couponId) {
      return { coupon: couponId };
    }
    const promotionCodeId = stripeObjectId(discount.promotion_code);
    if (promotionCodeId) {
      return { promotion_code: promotionCodeId };
    }
    throw new Error(
      "Stripe subscription schedule phase has an invalid discount",
    );
  });
}

function scheduleEndBehavior(
  schedule: StripeSubscriptionSchedule,
): "cancel" | "release" {
  if (
    schedule.end_behavior !== "cancel" &&
    schedule.end_behavior !== "release"
  ) {
    throw new Error("Stripe subscription schedule cannot be safely updated");
  }
  return schedule.end_behavior;
}

function scheduleFinalEnd(schedule: StripeSubscriptionSchedule): number {
  const finalEnd = schedule.phases.reduce<number | null>((latest, phase) => {
    return latest === null || phase.end_date > latest ? phase.end_date : latest;
  }, schedule.current_phase?.end_date ?? null);
  if (finalEnd === null) {
    throw new Error("Stripe subscription schedule has no end date");
  }
  return finalEnd;
}

async function planConcurrencyEnd(
  db: ReadonlyDb,
  orgId: string,
  schedule: StripeSubscriptionSchedule,
): Promise<number | null> {
  if (schedule.end_behavior === "cancel") {
    return scheduleFinalEnd(schedule);
  }

  const [org] = await db
    .select({
      pendingScheduleId: orgMetadata.pendingSubscriptionScheduleId,
      pendingTargetTier: orgMetadata.pendingSubscriptionTargetTier,
      pendingChangeAt: orgMetadata.pendingSubscriptionChangeAt,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  if (
    org?.pendingScheduleId !== schedule.id ||
    (org.pendingTargetTier !== "pro" &&
      org.pendingTargetTier !== "limited-free-1" &&
      org.pendingTargetTier !== "pro-suspend") ||
    org.pendingChangeAt === null
  ) {
    return null;
  }
  return Math.floor(org.pendingChangeAt.getTime() / 1000);
}

function currentAndFutureSchedulePhases(
  schedule: StripeSubscriptionSchedule,
): readonly StripeSchedulePhase[] {
  const currentPhase = schedule.current_phase;
  scheduleEndBehavior(schedule);
  if (!currentPhase) {
    throw new Error("Stripe subscription schedule cannot be safely updated");
  }
  const currentPhaseIndex = schedule.phases.findIndex((phase) => {
    return (
      phase.start_date === currentPhase.start_date &&
      phase.end_date === currentPhase.end_date
    );
  });
  if (currentPhaseIndex === -1) {
    throw new Error("Stripe subscription schedule lost its current phase");
  }
  const phases = schedule.phases.slice(currentPhaseIndex);
  if (
    phases.length === 0 ||
    phases.some((phase) => {
      return (phase.add_invoice_items?.length ?? 0) > 0;
    })
  ) {
    throw new Error("Stripe subscription schedule cannot be safely updated");
  }
  return phases;
}

function schedulePreservesPlanItem(
  schedule: StripeSubscriptionSchedule,
  planPriceId: string,
): boolean {
  const phases = currentAndFutureSchedulePhases(schedule);
  const currentPhase = phases[0];
  if (!currentPhase) {
    throw new Error("Stripe subscription schedule lost its current phase");
  }
  const currentPlanItem = schedulePhaseItems(currentPhase).find((item) => {
    return item.price === planPriceId;
  });
  return (
    currentPlanItem !== undefined &&
    phases.every((phase) => {
      return schedulePhaseItems(phase).some((item) => {
        return (
          item.price === currentPlanItem.price &&
          item.quantity === currentPlanItem.quantity
        );
      });
    })
  );
}

function schedulePhaseParams(
  phase: StripeSchedulePhase,
  args: {
    readonly items: StripeSchedulePhaseItemParam[];
    readonly metadataOverlay: Readonly<Record<string, string>> | null;
    readonly period?: { readonly start: number; readonly end: number };
  },
): StripeSchedulePhaseParam {
  const period = args.period ?? {
    start: phase.start_date,
    end: phase.end_date,
  };
  if (period.end <= period.start) {
    throw new Error("Stripe subscription schedule phase has an invalid period");
  }
  const metadata = args.metadataOverlay
    ? { ...phase.metadata, ...args.metadataOverlay }
    : phase.metadata;
  return phaseWithDiscounts(
    {
      start_date: period.start,
      end_date: period.end,
      ...(phase.currency ? { currency: phase.currency } : {}),
      items: args.items,
      ...(metadata ? { metadata: retireImpactMetadata(metadata) } : {}),
      proration_behavior: phase.proration_behavior ?? "none",
    },
    scheduleDiscounts(phase.discounts ?? []),
  );
}

function concurrencySchedulePhaseItems(
  phase: StripeSchedulePhase,
  priceId: string,
  targetQuantity: number,
): StripeSchedulePhaseItemParam[] {
  const items = schedulePhaseItems(phase);
  const existingConcurrencyItem = items.find((item) => {
    return isConcurrencyPriceId(item.price);
  });
  return [
    ...items.filter((item) => {
      return !isConcurrencyPriceId(item.price);
    }),
    ...(targetQuantity > 0
      ? [
          {
            ...existingConcurrencyItem,
            price: priceId,
            quantity: targetQuantity,
          },
        ]
      : []),
  ];
}

function concurrencyScheduleMergeParams(args: {
  readonly subscription: StripeSubscription;
  readonly schedule: StripeSubscriptionSchedule;
  readonly priceId: string;
  readonly targetQuantity: number;
  readonly prorationBehavior: "always_invoice" | "none";
}): NonNullable<StripeInvoiceCreatePreviewParams["schedule_details"]> {
  const metadataOverlay = canceledUsageAllowanceScheduleMetadata(
    args.subscription,
  );
  return {
    end_behavior: scheduleEndBehavior(args.schedule),
    proration_behavior: args.prorationBehavior,
    phases: currentAndFutureSchedulePhases(args.schedule).map((phase) => {
      return schedulePhaseParams(phase, {
        items: concurrencySchedulePhaseItems(
          phase,
          args.priceId,
          args.targetQuantity,
        ),
        metadataOverlay,
      });
    }),
  };
}

function planEndingConcurrencyScheduleMergeParams(args: {
  readonly subscription: StripeSubscription;
  readonly schedule: StripeSubscriptionSchedule;
  readonly priceId: string;
  readonly targetQuantity: number;
  readonly endsAt: number;
  readonly prorationBehavior: "always_invoice" | "none";
}): NonNullable<StripeInvoiceCreatePreviewParams["schedule_details"]> {
  const phases = currentAndFutureSchedulePhases(args.schedule);
  const firstPhase = phases[0];
  const finalPhase = phases[phases.length - 1];
  if (
    !firstPhase ||
    !finalPhase ||
    args.endsAt <= firstPhase.start_date ||
    args.endsAt > finalPhase.end_date
  ) {
    throw new Error("Stripe subscription schedule cannot be safely updated");
  }
  const metadataOverlay = canceledUsageAllowanceScheduleMetadata(
    args.subscription,
  );
  return {
    end_behavior: scheduleEndBehavior(args.schedule),
    proration_behavior: args.prorationBehavior,
    phases: phases.flatMap((phase) => {
      const activeItems = concurrencySchedulePhaseItems(
        phase,
        args.priceId,
        args.targetQuantity,
      );
      if (phase.end_date <= args.endsAt) {
        return [
          schedulePhaseParams(phase, {
            items: activeItems,
            metadataOverlay,
          }),
        ];
      }
      const endedItems = concurrencySchedulePhaseItems(phase, args.priceId, 0);
      if (phase.start_date >= args.endsAt) {
        return [
          schedulePhaseParams(phase, {
            items: endedItems,
            metadataOverlay,
          }),
        ];
      }
      return [
        schedulePhaseParams(phase, {
          items: activeItems,
          metadataOverlay,
          period: { start: phase.start_date, end: args.endsAt },
        }),
        schedulePhaseParams(phase, {
          items: endedItems,
          metadataOverlay,
          period: { start: args.endsAt, end: phase.end_date },
        }),
      ];
    }),
  };
}

function deferredConcurrencyScheduleMergeParams(args: {
  readonly subscription: StripeSubscription;
  readonly schedule: StripeSubscriptionSchedule;
  readonly priceId: string;
  readonly targetQuantity: number;
  readonly effectiveAt: number;
}): NonNullable<StripeInvoiceCreatePreviewParams["schedule_details"]> {
  const phases = currentAndFutureSchedulePhases(args.schedule);
  const firstPhase = phases[0];
  const finalPhase = phases[phases.length - 1];
  if (
    !firstPhase ||
    !finalPhase ||
    args.effectiveAt <= firstPhase.start_date ||
    args.effectiveAt >= finalPhase.end_date
  ) {
    throw new Error("Stripe subscription schedule cannot be safely updated");
  }
  const metadataOverlay = canceledUsageAllowanceScheduleMetadata(
    args.subscription,
  );
  return {
    end_behavior: scheduleEndBehavior(args.schedule),
    proration_behavior: "none",
    phases: phases.flatMap((phase) => {
      if (phase.end_date <= args.effectiveAt) {
        return [
          schedulePhaseParams(phase, {
            items: schedulePhaseItems(phase),
            metadataOverlay,
          }),
        ];
      }
      const updatedItems = concurrencySchedulePhaseItems(
        phase,
        args.priceId,
        args.targetQuantity,
      );
      if (phase.start_date >= args.effectiveAt) {
        return [
          schedulePhaseParams(phase, {
            items: updatedItems,
            metadataOverlay,
          }),
        ];
      }
      return [
        schedulePhaseParams(phase, {
          items: schedulePhaseItems(phase),
          metadataOverlay,
          period: {
            start: phase.start_date,
            end: args.effectiveAt,
          },
        }),
        schedulePhaseParams(phase, {
          items: updatedItems,
          metadataOverlay,
          period: {
            start: args.effectiveAt,
            end: phase.end_date,
          },
        }),
      ];
    }),
  };
}

function concurrencyItemPeriod(item: StripeSubscriptionItem): {
  readonly start: number;
  readonly end: number;
} {
  if (item.current_period_end <= item.current_period_start) {
    throw new Error("Concurrency subscription has an invalid billing period");
  }
  return {
    start: item.current_period_start,
    end: item.current_period_end,
  };
}

function concurrencySchedulePeriod(
  item: StripeSubscriptionItem,
  schedule: StripeSubscriptionSchedule | null,
): { readonly start: number; readonly end: number } {
  const itemPeriod = concurrencyItemPeriod(item);
  const start = schedule?.current_phase?.start_date ?? itemPeriod.start;
  if (itemPeriod.end <= start) {
    throw new Error("Concurrency schedule has an invalid current period");
  }
  return { start, end: itemPeriod.end };
}

function concurrencyRecurringDuration(
  item: StripeSubscriptionItem,
): StripePriceRecurring {
  const recurring = item.price.recurring;
  if (!recurring) {
    throw new Error("Concurrency subscription price is not recurring");
  }
  return {
    interval: recurring.interval,
    interval_count: recurring.interval_count,
  };
}

function scheduleFutureItems(
  subscription: StripeSubscription,
  schedule: StripeSubscriptionSchedule | null,
  targetQuantity: number,
): StripeSchedulePhaseItemParam[] {
  const scheduledItems = schedule?.phases[schedule.phases.length - 1]?.items;
  const baseItems =
    scheduledItems && scheduledItems.length > 0
      ? scheduledItems.flatMap((item) => {
          const price = stripeObjectId(item.price);
          return price ? [{ price, quantity: item.quantity ?? 1 }] : [];
        })
      : subscriptionPhaseItems(subscription);
  const currentItem = concurrencyPriceItem(subscription.items.data);
  if (!currentItem) {
    throw new Error("Concurrency subscription has no active concurrency item");
  }
  return [
    ...baseItems.filter((item) => {
      return !isConcurrencyPriceId(item.price);
    }),
    ...(targetQuantity > 0
      ? [{ price: currentItem.price.id, quantity: targetQuantity }]
      : []),
  ];
}

function concurrencyScheduleUpdateParams(
  subscription: StripeSubscription,
  schedule: StripeSubscriptionSchedule | null,
  targetQuantity: number,
  period: { readonly start: number; readonly end: number },
): NonNullable<StripeInvoiceCreatePreviewParams["schedule_details"]> {
  const item = concurrencyPriceItem(subscription.items.data);
  if (!item?.quantity) {
    throw new Error("Concurrency subscription has no active concurrency item");
  }
  const discounts = subscriptionPhaseDiscounts(subscription);
  return {
    end_behavior: "release",
    proration_behavior: "none",
    phases: [
      phaseWithDiscounts(
        {
          start_date: period.start,
          end_date: period.end,
          items: subscriptionPhaseItems(subscription),
          proration_behavior: "none",
        },
        discounts,
      ),
      phaseWithDiscounts(
        {
          start_date: period.end,
          duration: concurrencyRecurringDuration(item),
          items: scheduleFutureItems(subscription, schedule, targetQuantity),
          proration_behavior: "none",
        },
        discounts,
      ),
    ],
  };
}

async function scheduleConcurrencyChange(
  subscription: StripeSubscription,
  targetQuantity: number,
  signal: AbortSignal,
): Promise<Date> {
  const item = concurrencyPriceItem(subscription.items.data);
  if (!item?.quantity) {
    throw new Error("Concurrency subscription has no active concurrency item");
  }
  const stripe = getStripeClient();
  const existingScheduleId = stripeObjectId(subscription.schedule);
  const existingSchedule = existingScheduleId
    ? await stripe.subscriptionSchedules.retrieve(existingScheduleId)
    : null;
  signal.throwIfAborted();
  const createdSchedule = existingScheduleId
    ? null
    : await stripe.subscriptionSchedules.create(
        { from_subscription: subscription.id },
        {
          idempotencyKey: `concurrency-change:${subscription.id}:${randomUUID()}:schedule-create`,
        },
      );
  signal.throwIfAborted();
  const schedule = existingSchedule ?? createdSchedule;
  const scheduleId = existingScheduleId ?? schedule?.id;
  if (!scheduleId) {
    throw new Error("Stripe did not return a subscription schedule ID");
  }
  const schedulePeriod = concurrencySchedulePeriod(item, schedule);
  await stripe.subscriptionSchedules.update(
    scheduleId,
    concurrencyScheduleUpdateParams(
      subscription,
      existingSchedule,
      targetQuantity,
      schedulePeriod,
    ),
    {
      idempotencyKey: `concurrency-change:${subscription.id}:${randomUUID()}:schedule-update`,
    },
  );
  signal.throwIfAborted();
  return new Date(schedulePeriod.end * 1000);
}

function expandedLatestInvoice(
  subscription: StripeSubscription,
): StripeInvoice | null {
  return subscription.latest_invoice &&
    typeof subscription.latest_invoice !== "string"
    ? subscription.latest_invoice
    : null;
}

async function appliedConcurrencyChangeResponse(
  stripe: StripeClient,
  subscription: StripeSubscription,
  targetQuantity: number,
  signal: AbortSignal,
): Promise<ConcurrencySubscriptionChangeResponse> {
  const invoice = expandedLatestInvoice(subscription);
  if (!invoice) {
    return { status: "processing", hostedInvoiceUrl: null };
  }
  const result = await completeBillingOperationInvoice(
    stripe,
    invoice,
    `concurrency:${subscription.id}:${targetQuantity}`,
    signal,
  );
  if (result.status === "pending_payment") {
    return result;
  }
  return { status: "processing", hostedInvoiceUrl: null };
}

function latestInvoiceId(subscription: StripeSubscription): string | null {
  const invoice = subscription.latest_invoice;
  return typeof invoice === "string" ? invoice : (invoice?.id ?? null);
}

function isConcurrencyPaymentActionRequired(error: unknown): boolean {
  const code = stripeErrorInfo(error)?.code;
  return (
    code === "authentication_required" ||
    code === "invoice_payment_intent_requires_action" ||
    code === "payment_intent_action_required"
  );
}

async function appliedScheduledConcurrencyChangeResponse(
  stripe: StripeClient,
  subscription: StripeSubscription,
  previousInvoiceId: string | null,
  settleInvoice: boolean,
  signal: AbortSignal,
): Promise<ConcurrencySubscriptionChangeResponse> {
  let invoice = expandedLatestInvoice(subscription);
  let paymentError: unknown;
  if (
    !invoice ||
    invoice.id === previousInvoiceId ||
    invoice.paid === true ||
    invoice.status === "paid"
  ) {
    return { status: "processing", hostedInvoiceUrl: null };
  }
  if (!settleInvoice) {
    return { status: "processing", hostedInvoiceUrl: null };
  }

  const idempotencyKeyPrefix = `concurrency-change:${subscription.id}:${invoice.id}`;
  if (invoice.status === "draft") {
    invoice = await stripe.invoices.finalizeInvoice(
      invoice.id,
      {},
      { idempotencyKey: `${idempotencyKeyPrefix}:finalize` },
    );
    signal.throwIfAborted();
  }
  if (invoice.status === "open") {
    const paid = await settle(
      stripe.invoices.pay(
        invoice.id,
        {},
        { idempotencyKey: `${idempotencyKeyPrefix}:pay` },
      ),
      signal,
    );
    if (paid.ok) {
      invoice = paid.value;
    } else {
      paymentError = paid.error;
      invoice = await stripe.invoices.retrieve(invoice.id);
      signal.throwIfAborted();
    }
  }
  if (invoice.paid === true || invoice.status === "paid") {
    return { status: "completed", hostedInvoiceUrl: null };
  }
  if (!invoice.hosted_invoice_url) {
    if (paymentError && !isConcurrencyPaymentActionRequired(paymentError)) {
      throw paymentError;
    }
    throw new Error("Stripe concurrency invoice could not be paid");
  }
  return {
    status: "pending_payment",
    hostedInvoiceUrl: invoice.hosted_invoice_url,
  };
}

async function applyConcurrencyToAttachedSchedule(
  stripe: StripeClient,
  args: {
    readonly subscription: StripeSubscription;
    readonly scheduleId: string;
    readonly schedule: StripeSubscriptionSchedule;
    readonly priceId: string;
    readonly targetQuantity: number;
    readonly prorationBehavior: "always_invoice" | "none";
    readonly planEndsAt?: number;
  },
  signal: AbortSignal,
): Promise<{
  readonly response: ConcurrencySubscriptionChangeResponse;
  readonly subscription: StripeSubscription;
}> {
  const previousInvoiceId = latestInvoiceId(args.subscription);
  await stripe.subscriptionSchedules.update(
    args.scheduleId,
    args.planEndsAt === undefined
      ? concurrencyScheduleMergeParams({
          subscription: args.subscription,
          schedule: args.schedule,
          priceId: args.priceId,
          targetQuantity: args.targetQuantity,
          prorationBehavior: args.prorationBehavior,
        })
      : planEndingConcurrencyScheduleMergeParams({
          subscription: args.subscription,
          schedule: args.schedule,
          priceId: args.priceId,
          targetQuantity: args.targetQuantity,
          endsAt: args.planEndsAt,
          prorationBehavior: args.prorationBehavior,
        }),
    {
      idempotencyKey: `concurrency-change:${args.subscription.id}:${randomUUID()}:schedule-update`,
    },
  );
  signal.throwIfAborted();
  const updatedSubscription = await stripe.subscriptions.retrieve(
    args.subscription.id,
    { expand: ["latest_invoice"] },
  );
  signal.throwIfAborted();
  return {
    response: await appliedScheduledConcurrencyChangeResponse(
      stripe,
      updatedSubscription,
      previousInvoiceId,
      args.prorationBehavior === "always_invoice",
      signal,
    ),
    subscription: updatedSubscription,
  };
}

async function scheduleConcurrencyOnSharedSchedule(
  stripe: StripeClient,
  args: {
    readonly subscription: StripeSubscription;
    readonly scheduleId: string;
    readonly schedule: StripeSubscriptionSchedule;
    readonly priceId: string;
    readonly targetQuantity: number;
  },
  signal: AbortSignal,
): Promise<Date> {
  const item = concurrencyPriceItem(args.subscription.items.data);
  if (!item?.quantity) {
    throw new Error("Concurrency subscription has no active concurrency item");
  }
  const effectiveAt = concurrencyItemPeriod(item).end;
  await stripe.subscriptionSchedules.update(
    args.scheduleId,
    deferredConcurrencyScheduleMergeParams({
      subscription: args.subscription,
      schedule: args.schedule,
      priceId: args.priceId,
      targetQuantity: args.targetQuantity,
      effectiveAt,
    }),
    {
      idempotencyKey: `concurrency-change:${args.subscription.id}:${randomUUID()}:schedule-update`,
    },
  );
  signal.throwIfAborted();
  return new Date(effectiveAt * 1000);
}

export const addStripeConcurrencySubscriptionItem$ = command(
  async (
    { get },
    args: AddStripeConcurrencySubscriptionItemArgs,
    signal: AbortSignal,
  ): Promise<StripeConcurrencySubscriptionChangeResult> => {
    if (
      !Number.isSafeInteger(args.quantity) ||
      args.quantity < 1 ||
      args.quantity > CONCURRENCY_SUBSCRIPTION_QUANTITY_MAX
    ) {
      return { ok: false, reason: "invalid_quantity" };
    }

    const stripe = getStripeClient();
    const subscription = await stripe.subscriptions.retrieve(
      args.subscriptionId,
      { expand: ["latest_invoice"] },
    );
    signal.throwIfAborted();

    if (subscription.pending_update) {
      const pendingItem = concurrencyPriceItem(
        subscription.pending_update.subscription_items ?? [],
      );
      return pendingItem?.quantity === args.quantity
        ? {
            ok: true,
            response: await appliedConcurrencyChangeResponse(
              stripe,
              subscription,
              args.quantity,
              signal,
            ),
            subscription,
          }
        : { ok: false, reason: "pending_update" };
    }

    const currentItem = concurrencyPriceItem(subscription.items.data);
    if (currentItem?.quantity === args.quantity) {
      return {
        ok: true,
        response: { status: "completed", hostedInvoiceUrl: null },
        subscription,
      };
    }
    const schedulePreparation = await prepareConcurrencySchedule(
      get(db$),
      stripe,
      {
        orgId: args.orgId,
        subscription,
        hasScheduledConcurrencyChange: false,
      },
      signal,
    );
    if (!schedulePreparation.ok) {
      return { ok: false, reason: "pending_update" };
    }
    if (
      schedulePreparation.kind === "plan" ||
      schedulePreparation.kind === "shared"
    ) {
      const applied = await applyConcurrencyToAttachedSchedule(
        stripe,
        {
          subscription,
          scheduleId: schedulePreparation.id,
          schedule: schedulePreparation.schedule,
          priceId: currentItem?.price.id ?? args.priceId,
          targetQuantity: args.quantity,
          prorationBehavior: "always_invoice",
          ...(schedulePreparation.kind === "plan"
            ? { planEndsAt: schedulePreparation.endsAt }
            : {}),
        },
        signal,
      );
      return {
        ok: true,
        response: applied.response,
        subscription: applied.subscription,
      };
    }
    if (schedulePreparation.kind === "neutral") {
      await stripe.subscriptionSchedules.release(schedulePreparation.id, {
        preserve_cancel_date: true,
      });
      signal.throwIfAborted();
    }

    if (args.paymentMethod) {
      await setStripeSubscriptionPaymentMethod(
        stripe,
        subscription.id,
        args.paymentMethod,
        signal,
      );
    }

    const updatedSubscription = await stripe.subscriptions.update(
      subscription.id,
      {
        items: [
          currentItem
            ? { id: currentItem.id, quantity: args.quantity }
            : { price: args.priceId, quantity: args.quantity },
        ],
        payment_behavior: "pending_if_incomplete",
        proration_behavior: "always_invoice",
        proration_date: Math.floor(nowDate().getTime() / 1000),
        expand: ["latest_invoice"],
      },
    );
    signal.throwIfAborted();
    return {
      ok: true,
      response: await appliedConcurrencyChangeResponse(
        stripe,
        updatedSubscription,
        args.quantity,
        signal,
      ),
      subscription: updatedSubscription,
    };
  },
);

function invoiceLinePriceId(line: StripeInvoiceLine): string | null {
  const price = line.pricing?.price_details?.price;
  return typeof price === "string"
    ? price
    : (price?.id ?? line.price?.id ?? null);
}

function invoiceLineAmountWithTax(line: StripeInvoiceLine): number {
  const exclusiveTax = (line.taxes ?? []).reduce((total, tax) => {
    return tax.tax_behavior === "exclusive" ? total + tax.amount : total;
  }, 0);
  const amount = line.amount + exclusiveTax;
  if (!Number.isSafeInteger(amount)) {
    throw new Error("Stripe concurrency preview line has an invalid amount");
  }
  return amount;
}

async function listCompleteInvoiceLines(
  stripe: StripeClient,
  invoice: StripeInvoice,
  signal: AbortSignal,
): Promise<readonly StripeInvoiceLine[]> {
  if (!invoice.lines.has_more) {
    return invoice.lines.data;
  }
  const lines: StripeInvoiceLine[] = [];
  let startingAfter: string | undefined;
  while (true) {
    const page = await stripe.invoices.listLineItems(invoice.id, {
      limit: STRIPE_INVOICE_LINE_PAGE_SIZE,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    signal.throwIfAborted();
    lines.push(...page.data);
    if (!page.has_more) {
      return lines;
    }
    const last = page.data.at(-1);
    if (!last?.id) {
      throw new Error(
        `Stripe invoice ${invoice.id} returned an incomplete line-item page`,
      );
    }
    startingAfter = last.id;
  }
}

function recurringConcurrencyAmount(
  invoice: StripeInvoice,
  lines: readonly StripeInvoiceLine[],
  allowNoConcurrencyLines = false,
): number {
  const concurrencyLines = lines.filter((line) => {
    const priceId = invoiceLinePriceId(line);
    return priceId !== null && isConcurrencyPriceId(priceId);
  });
  const amount = concurrencyLines.reduce((total, line) => {
    return total + invoiceLineAmountWithTax(line);
  }, 0);
  if (
    invoice.currency.length !== 3 ||
    (!allowNoConcurrencyLines && concurrencyLines.length === 0) ||
    !Number.isSafeInteger(amount) ||
    amount < 0
  ) {
    throw new Error(
      "Stripe concurrency recurring preview has an invalid amount",
    );
  }
  return amount;
}

function preparedScheduleEndsConcurrency(
  schedule: AvailableConcurrencySchedule,
): boolean {
  if (schedule.kind === "plan") {
    return true;
  }
  return (
    (schedule.kind === "concurrency" || schedule.kind === "shared") &&
    schedule.schedule.end_behavior === "cancel"
  );
}

function immediateProrationAmount(
  lines: readonly StripeInvoiceLine[],
  prorationTimestamp: number,
): number {
  const prorationLines = lines.filter((line) => {
    const priceId = invoiceLinePriceId(line);
    return (
      line.parent?.subscription_item_details?.proration === true &&
      line.period.start === prorationTimestamp &&
      priceId !== null &&
      isConcurrencyPriceId(priceId)
    );
  });
  const amount = prorationLines.reduce((total, line) => {
    return total + invoiceLineAmountWithTax(line);
  }, 0);
  if (prorationLines.length === 0 || !Number.isSafeInteger(amount)) {
    throw new Error("Stripe concurrency preview has an invalid amount");
  }
  return Math.max(0, amount);
}

async function concurrencyPreviewLines(
  stripe: StripeClient,
  immediatePreview: StripeInvoice,
  recurringPreview: StripeInvoice,
  signal: AbortSignal,
): Promise<
  readonly [readonly StripeInvoiceLine[], readonly StripeInvoiceLine[]]
> {
  if (immediatePreview.currency !== recurringPreview.currency) {
    throw new Error(
      "Stripe concurrency previews returned different currencies",
    );
  }
  const lines = await Promise.all([
    listCompleteInvoiceLines(stripe, immediatePreview, signal),
    listCompleteInvoiceLines(stripe, recurringPreview, signal),
  ]);
  signal.throwIfAborted();
  return lines;
}

interface StripeConcurrencySubscriptionPreviewArgs extends ConcurrencySubscriptionArgs {
  readonly priceId?: string;
  readonly quantity: number;
  readonly mode: "absolute" | "increase";
  readonly hasScheduledConcurrencyChange: boolean;
}

function previewTargetQuantity(
  currentQuantity: number,
  args: StripeConcurrencySubscriptionPreviewArgs,
): number {
  return args.mode === "increase"
    ? currentQuantity + args.quantity
    : args.quantity;
}

function concurrencyPreviewPriceId(
  item: StripeSubscriptionItem | undefined,
  args: StripeConcurrencySubscriptionPreviewArgs,
): string {
  const priceId = item?.price.id ?? args.priceId;
  if (!priceId) {
    throw new Error("Concurrency subscription has no active concurrency item");
  }
  return priceId;
}

interface DeferredConcurrencyPreviewArgs {
  readonly item: StripeSubscriptionItem;
  readonly currentQuantity: number;
  readonly targetQuantity: number;
  readonly recurringPreview: StripeInvoice;
  readonly recurringLines: readonly StripeInvoiceLine[];
}

function deferredConcurrencyPreviewResponse(
  args: DeferredConcurrencyPreviewArgs,
): PreviewConcurrencySubscriptionChangeResult {
  return {
    ok: true,
    preview: {
      currentQuantity: args.currentQuantity,
      targetQuantity: args.targetQuantity,
      immediateAmountCents: 0,
      nextRecurringAmountCents: recurringConcurrencyAmount(
        args.recurringPreview,
        args.recurringLines,
      ),
      currency: args.recurringPreview.currency,
      ...(args.targetQuantity < args.currentQuantity
        ? {
            effectiveAt: new Date(
              concurrencyItemPeriod(args.item).end * 1000,
            ).toISOString(),
          }
        : {}),
    },
  };
}

interface ScheduledConcurrencyPreview {
  readonly id: string;
  readonly item: StripeSubscriptionItem | null;
  readonly kind: "concurrency" | "plan" | "shared";
  readonly priceId: string;
  readonly schedule: StripeSubscriptionSchedule;
  readonly planEndsAt?: number;
}

function scheduledConcurrencyPreview(
  schedule: AvailableConcurrencySchedule,
  item: StripeSubscriptionItem | undefined,
  priceId: string,
): ScheduledConcurrencyPreview | null {
  switch (schedule.kind) {
    case "concurrency":
    case "shared": {
      return {
        id: schedule.id,
        item: item ?? null,
        kind: schedule.kind,
        priceId,
        schedule: schedule.schedule,
      };
    }
    case "plan": {
      return {
        id: schedule.id,
        item: item ?? null,
        kind: schedule.kind,
        priceId,
        schedule: schedule.schedule,
        planEndsAt: schedule.endsAt,
      };
    }
    case "neutral":
    case "none": {
      return null;
    }
  }
}

function concurrencyRecurringPreviewParams(
  subscription: StripeSubscription,
  items: StripeSubscriptionUpdateItemParam[],
  currentQuantity: number,
  targetQuantity: number,
  scheduledPreview: ScheduledConcurrencyPreview | null,
): StripeInvoiceCreatePreviewParams {
  if (!scheduledPreview) {
    return {
      subscription: subscription.id,
      preview_mode: "recurring",
      subscription_details: { items },
    };
  }
  if (scheduledPreview.kind === "shared") {
    if (targetQuantity >= currentQuantity) {
      return {
        schedule: scheduledPreview.id,
        preview_mode: "next",
        schedule_details: concurrencyScheduleMergeParams({
          subscription,
          schedule: scheduledPreview.schedule,
          priceId: scheduledPreview.priceId,
          targetQuantity,
          prorationBehavior: "none",
        }),
      };
    }
    if (!scheduledPreview.item) {
      throw new Error("Concurrency schedule has no active concurrency item");
    }
    return {
      schedule: scheduledPreview.id,
      preview_mode: "next",
      schedule_details: deferredConcurrencyScheduleMergeParams({
        subscription,
        schedule: scheduledPreview.schedule,
        priceId: scheduledPreview.priceId,
        targetQuantity,
        effectiveAt: concurrencyItemPeriod(scheduledPreview.item).end,
      }),
    };
  }
  if (scheduledPreview.kind === "plan") {
    if (scheduledPreview.planEndsAt === undefined) {
      throw new Error("Plan schedule has no concurrency end date");
    }
    return {
      schedule: scheduledPreview.id,
      preview_mode: "next",
      schedule_details: planEndingConcurrencyScheduleMergeParams({
        subscription,
        schedule: scheduledPreview.schedule,
        priceId: scheduledPreview.priceId,
        targetQuantity,
        endsAt: scheduledPreview.planEndsAt,
        prorationBehavior: "none",
      }),
    };
  }
  if (!scheduledPreview.item) {
    throw new Error("Concurrency schedule has no active concurrency item");
  }
  return {
    schedule: scheduledPreview.id,
    preview_mode: "next",
    schedule_details: concurrencyScheduleUpdateParams(
      subscription,
      targetQuantity < currentQuantity ? scheduledPreview.schedule : null,
      targetQuantity,
      concurrencySchedulePeriod(
        scheduledPreview.item,
        scheduledPreview.schedule,
      ),
    ),
  };
}

type PreparedConcurrencySchedule =
  | { readonly ok: true; readonly kind: "none" }
  | { readonly ok: true; readonly kind: "neutral"; readonly id: string }
  | {
      readonly ok: true;
      readonly kind: "concurrency";
      readonly id: string;
      readonly schedule: StripeSubscriptionSchedule;
    }
  | {
      readonly ok: true;
      readonly kind: "shared";
      readonly id: string;
      readonly schedule: StripeSubscriptionSchedule;
    }
  | {
      readonly ok: true;
      readonly kind: "plan";
      readonly id: string;
      readonly schedule: StripeSubscriptionSchedule;
      readonly endsAt: number;
    }
  | { readonly ok: false };

type AvailableConcurrencySchedule = Exclude<
  PreparedConcurrencySchedule,
  { readonly ok: false }
>;

function concurrencySubscriptionCancellationEnd(
  subscription: StripeSubscription,
  billingPeriodItem: StripeSubscriptionItem,
  schedule: AvailableConcurrencySchedule,
): number | null {
  if (
    (schedule.kind === "concurrency" ||
      schedule.kind === "plan" ||
      schedule.kind === "shared") &&
    schedule.schedule.end_behavior === "cancel"
  ) {
    return scheduleFinalEnd(schedule.schedule);
  }
  if (schedule.kind === "plan") {
    return schedule.endsAt;
  }
  if (subscription.cancel_at !== null && subscription.cancel_at !== undefined) {
    return subscription.cancel_at;
  }
  return subscription.cancel_at_period_end
    ? concurrencyItemPeriod(billingPeriodItem).end
    : null;
}

function planEndsBeforeDeferredConcurrencyChange(
  subscription: StripeSubscription,
  item: StripeSubscriptionItem,
  schedule: AvailableConcurrencySchedule,
): boolean {
  if (schedule.kind === "plan") {
    return true;
  }
  const cancellationEnd = concurrencySubscriptionCancellationEnd(
    subscription,
    item,
    schedule,
  );
  return (
    cancellationEnd !== null &&
    cancellationEnd <= concurrencyItemPeriod(item).end
  );
}

async function prepareConcurrencySchedule(
  db: ReadonlyDb,
  stripe: StripeClient,
  args: {
    readonly orgId: string;
    readonly subscription: StripeSubscription;
    readonly hasScheduledConcurrencyChange: boolean;
  },
  signal: AbortSignal,
): Promise<PreparedConcurrencySchedule> {
  const scheduleId = stripeObjectId(args.subscription.schedule);
  if (!scheduleId) {
    return { ok: true, kind: "none" };
  }
  const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId);
  signal.throwIfAborted();
  const owner = await concurrencyScheduleOwner(
    db,
    args.orgId,
    args.subscription.id,
    schedule,
  );
  signal.throwIfAborted();
  if (owner === "plan") {
    const endsAt = await planConcurrencyEnd(db, args.orgId, schedule);
    signal.throwIfAborted();
    return endsAt === null
      ? { ok: false }
      : { ok: true, kind: "plan", id: scheduleId, schedule, endsAt };
  }
  if (owner === "shared") {
    return { ok: true, kind: "shared", id: scheduleId, schedule };
  }
  if (args.hasScheduledConcurrencyChange) {
    return { ok: true, kind: "concurrency", id: scheduleId, schedule };
  }
  return subscriptionScheduleHasNoFutureChanges(args.subscription, schedule)
    ? { ok: true, kind: "neutral", id: scheduleId }
    : { ok: false };
}

async function schedulePreparedConcurrencyReduction(
  args: {
    readonly stripe: StripeClient;
    readonly subscription: StripeSubscription;
    readonly schedule: AvailableConcurrencySchedule;
    readonly item: NonNullable<ReturnType<typeof concurrencySubscriptionItem>>;
    readonly targetQuantity: number;
  },
  signal: AbortSignal,
): Promise<Date> {
  return args.schedule.kind === "shared"
    ? await scheduleConcurrencyOnSharedSchedule(
        args.stripe,
        {
          subscription: args.subscription,
          scheduleId: args.schedule.id,
          schedule: args.schedule.schedule,
          priceId: args.item.priceId,
          targetQuantity: args.targetQuantity,
        },
        signal,
      )
    : await scheduleConcurrencyChange(
        args.subscription,
        args.targetQuantity,
        signal,
      );
}

async function previewConcurrencyIncrease(
  stripe: StripeClient,
  args: {
    readonly subscription: StripeSubscription;
    readonly items: StripeSubscriptionUpdateItemParam[];
    readonly currentQuantity: number;
    readonly targetQuantity: number;
    readonly recurringPreviewParams: StripeInvoiceCreatePreviewParams;
    readonly schedulePreparation: AvailableConcurrencySchedule;
    readonly prorationTimestamp: number;
  },
  signal: AbortSignal,
): Promise<PreviewConcurrencySubscriptionChangeResult> {
  const subscriptionWillEnd =
    args.subscription.cancel_at_period_end ||
    (args.subscription.cancel_at !== null &&
      args.subscription.cancel_at !== undefined);
  const [immediatePreview, recurringPreviewResult] = await Promise.all([
    stripe.invoices.createPreview({
      subscription: args.subscription.id,
      preview_mode: "next",
      subscription_details: {
        ...(args.subscription.cancel_at_period_end
          ? { cancel_at_period_end: false }
          : args.subscription.cancel_at !== null &&
              args.subscription.cancel_at !== undefined
            ? { cancel_at: "" as const }
            : {}),
        items: args.items,
        proration_behavior: "always_invoice",
        proration_date: args.prorationTimestamp,
      },
    }),
    subscriptionWillEnd
      ? null
      : settle(
          stripe.invoices.createPreview(args.recurringPreviewParams),
          signal,
        ),
  ]);
  signal.throwIfAborted();
  let recurringPreview: StripeInvoice | null;
  if (recurringPreviewResult === null) {
    recurringPreview = null;
  } else if (!recurringPreviewResult.ok) {
    const cancellationSchedule =
      (args.schedulePreparation.kind === "concurrency" ||
        args.schedulePreparation.kind === "plan" ||
        args.schedulePreparation.kind === "shared") &&
      args.schedulePreparation.schedule.end_behavior === "cancel";
    if (
      stripeErrorInfo(recurringPreviewResult.error)?.code !==
        "invoice_upcoming_none" ||
      !cancellationSchedule
    ) {
      throw recurringPreviewResult.error;
    }
    recurringPreview = null;
  } else {
    recurringPreview = recurringPreviewResult.value;
  }
  if (!recurringPreview) {
    const immediateLines = await listCompleteInvoiceLines(
      stripe,
      immediatePreview,
      signal,
    );
    return {
      ok: true,
      preview: {
        currentQuantity: args.currentQuantity,
        targetQuantity: args.targetQuantity,
        immediateAmountCents: immediateProrationAmount(
          immediateLines,
          args.prorationTimestamp,
        ),
        nextRecurringAmountCents: 0,
        currency: immediatePreview.currency,
      },
    };
  }

  const [immediateLines, recurringLines] = await concurrencyPreviewLines(
    stripe,
    immediatePreview,
    recurringPreview,
    signal,
  );
  return {
    ok: true,
    preview: {
      currentQuantity: args.currentQuantity,
      targetQuantity: args.targetQuantity,
      immediateAmountCents: immediateProrationAmount(
        immediateLines,
        args.prorationTimestamp,
      ),
      nextRecurringAmountCents: recurringConcurrencyAmount(
        recurringPreview,
        recurringLines,
        preparedScheduleEndsConcurrency(args.schedulePreparation),
      ),
      currency: recurringPreview.currency,
    },
  };
}

export const previewStripeConcurrencySubscriptionChange$ = command(
  async (
    { get },
    args: StripeConcurrencySubscriptionPreviewArgs,
    signal: AbortSignal,
  ): Promise<PreviewConcurrencySubscriptionChangeResult> => {
    const stripe = getStripeClient();
    const subscription = await stripe.subscriptions.retrieve(
      args.subscriptionId,
    );
    signal.throwIfAborted();
    const item = concurrencyPriceItem(subscription.items.data);
    const concurrencyPriceId = concurrencyPreviewPriceId(item, args);
    if (subscription.pending_update) {
      return { ok: false, reason: "pending_update" };
    }
    const currentQuantity = item?.quantity ?? 0;
    const targetQuantity = previewTargetQuantity(currentQuantity, args);
    if (
      !Number.isSafeInteger(targetQuantity) ||
      targetQuantity < 1 ||
      targetQuantity > CONCURRENCY_SUBSCRIPTION_QUANTITY_MAX
    ) {
      return { ok: false, reason: "invalid_quantity" };
    }
    const schedulePreparation = await prepareConcurrencySchedule(
      get(db$),
      stripe,
      {
        orgId: args.orgId,
        subscription,
        hasScheduledConcurrencyChange: args.hasScheduledConcurrencyChange,
      },
      signal,
    );
    if (!schedulePreparation.ok) {
      return { ok: false, reason: "pending_update" };
    }
    if (
      targetQuantity === currentQuantity &&
      !args.hasScheduledConcurrencyChange
    ) {
      return { ok: false, reason: "no_change" };
    }

    const prorationTimestamp = Math.floor(nowDate().getTime() / 1000);
    const items = [
      item
        ? { id: item.id, quantity: targetQuantity }
        : { price: args.priceId, quantity: targetQuantity },
    ];
    const scheduledPreview = scheduledConcurrencyPreview(
      schedulePreparation,
      item,
      concurrencyPriceId,
    );
    if (
      item &&
      targetQuantity < currentQuantity &&
      planEndsBeforeDeferredConcurrencyChange(
        subscription,
        item,
        schedulePreparation,
      )
    ) {
      return { ok: false, reason: "plan_ending" };
    }
    const recurringPreviewParams = concurrencyRecurringPreviewParams(
      subscription,
      items,
      currentQuantity,
      targetQuantity,
      scheduledPreview,
    );
    const deferred = targetQuantity <= currentQuantity;
    if (deferred) {
      if (!item) {
        throw new Error(
          "Deferred concurrency change has no active concurrency item",
        );
      }
      const recurringPreview = await stripe.invoices.createPreview(
        recurringPreviewParams,
      );
      signal.throwIfAborted();
      const recurringLines = await listCompleteInvoiceLines(
        stripe,
        recurringPreview,
        signal,
      );
      return deferredConcurrencyPreviewResponse({
        item,
        currentQuantity,
        targetQuantity,
        recurringPreview,
        recurringLines,
      });
    }

    return await previewConcurrencyIncrease(
      stripe,
      {
        subscription,
        items,
        currentQuantity,
        targetQuantity,
        recurringPreviewParams,
        schedulePreparation,
        prorationTimestamp,
      },
      signal,
    );
  },
);

function concurrencyChangeTargetQuantity(
  args: Pick<StripeConcurrencySubscriptionChangeArgs, "mode" | "quantity">,
  currentQuantity: number,
): number | null {
  const targetQuantity =
    args.mode === "increase" ? currentQuantity + args.quantity : args.quantity;
  if (
    !Number.isSafeInteger(targetQuantity) ||
    targetQuantity < 1 ||
    targetQuantity > CONCURRENCY_SUBSCRIPTION_QUANTITY_MAX ||
    (args.mode === "reduce" && targetQuantity > currentQuantity)
  ) {
    return null;
  }
  return targetQuantity;
}

async function applyImmediateConcurrencySubscriptionChange(
  stripe: StripeClient,
  args: {
    readonly subscription: StripeSubscription;
    readonly item: NonNullable<ReturnType<typeof concurrencySubscriptionItem>>;
    readonly targetQuantity: number;
    readonly paymentMethod: BillingPurchasePaymentMethod | undefined;
  },
  signal: AbortSignal,
): Promise<StripeConcurrencySubscriptionChangeResult> {
  if (args.targetQuantity === args.item.quantity) {
    return {
      ok: true,
      response: { status: "completed", hostedInvoiceUrl: null },
      subscription: { ...args.subscription, schedule: null },
    };
  }

  if (args.paymentMethod) {
    await setStripeSubscriptionPaymentMethod(
      stripe,
      args.subscription.id,
      args.paymentMethod,
      signal,
    );
  }

  const updatedSubscription = await stripe.subscriptions.update(
    args.subscription.id,
    {
      items: [{ id: args.item.id, quantity: args.targetQuantity }],
      payment_behavior: "pending_if_incomplete",
      proration_behavior: "always_invoice",
      proration_date: Math.floor(nowDate().getTime() / 1000),
      expand: ["latest_invoice"],
    },
  );
  signal.throwIfAborted();
  return {
    ok: true,
    response: await appliedConcurrencyChangeResponse(
      stripe,
      updatedSubscription,
      args.targetQuantity,
      signal,
    ),
    subscription: updatedSubscription,
  };
}

async function appliedPendingConcurrencyChange(
  stripe: StripeClient,
  subscription: StripeSubscription,
  targetQuantity: number,
  signal: AbortSignal,
): Promise<StripeConcurrencySubscriptionChangeResult | null> {
  if (!subscription.pending_update) {
    return null;
  }
  const pendingItem = concurrencySubscriptionItem(
    subscription.pending_update.subscription_items ?? [],
  );
  return pendingItem?.quantity === targetQuantity
    ? {
        ok: true,
        response: await appliedConcurrencyChangeResponse(
          stripe,
          subscription,
          targetQuantity,
          signal,
        ),
        subscription,
      }
    : { ok: false, reason: "pending_update" };
}

async function applyConcurrencyToPreparedSchedule(
  stripe: StripeClient,
  args: {
    readonly subscription: StripeSubscription;
    readonly item: NonNullable<ReturnType<typeof concurrencySubscriptionItem>>;
    readonly targetQuantity: number;
    readonly schedule: AvailableConcurrencySchedule;
  },
  signal: AbortSignal,
): Promise<StripeConcurrencySubscriptionChangeResult | null> {
  if (
    (args.schedule.kind !== "plan" && args.schedule.kind !== "shared") ||
    args.targetQuantity < args.item.quantity
  ) {
    return null;
  }
  const applied = await applyConcurrencyToAttachedSchedule(
    stripe,
    {
      subscription: args.subscription,
      scheduleId: args.schedule.id,
      schedule: args.schedule.schedule,
      priceId: args.item.priceId,
      targetQuantity: args.targetQuantity,
      prorationBehavior:
        args.targetQuantity > args.item.quantity ? "always_invoice" : "none",
      ...(args.schedule.kind === "plan"
        ? { planEndsAt: args.schedule.endsAt }
        : {}),
    },
    signal,
  );
  return {
    ok: true,
    response: applied.response,
    subscription: applied.subscription,
  };
}

const applyStripeConcurrencySubscriptionChange$ = command(
  async (
    { get },
    args: StripeConcurrencySubscriptionChangeArgs,
    signal: AbortSignal,
  ): Promise<StripeConcurrencySubscriptionChangeResult> => {
    const stripe = getStripeClient();
    const subscription = await stripe.subscriptions.retrieve(
      args.subscriptionId,
      { expand: ["latest_invoice"] },
    );
    signal.throwIfAborted();
    const item = requiredConcurrencySubscriptionItem(subscription.items.data);
    const stripeItem = concurrencyPriceItem(subscription.items.data);
    if (!stripeItem) {
      throw new Error(
        "Concurrency subscription has no active concurrency item",
      );
    }
    const targetQuantity = concurrencyChangeTargetQuantity(args, item.quantity);
    if (targetQuantity === null) {
      return { ok: false, reason: "invalid_quantity" };
    }

    const pendingChange = await appliedPendingConcurrencyChange(
      stripe,
      subscription,
      targetQuantity,
      signal,
    );
    if (pendingChange) {
      return pendingChange;
    }
    const schedulePreparation = await prepareConcurrencySchedule(
      get(db$),
      stripe,
      {
        orgId: args.orgId,
        subscription,
        hasScheduledConcurrencyChange: args.hasScheduledConcurrencyChange,
      },
      signal,
    );
    if (!schedulePreparation.ok) {
      return { ok: false, reason: "pending_update" };
    }
    if (
      targetQuantity === item.quantity &&
      !args.hasScheduledConcurrencyChange
    ) {
      return {
        ok: true,
        response: { status: "completed", hostedInvoiceUrl: null },
        subscription,
      };
    }

    if (
      targetQuantity < item.quantity &&
      planEndsBeforeDeferredConcurrencyChange(
        subscription,
        stripeItem,
        schedulePreparation,
      )
    ) {
      return { ok: false, reason: "plan_ending" };
    }

    const scheduledChange = await applyConcurrencyToPreparedSchedule(
      stripe,
      {
        subscription,
        item,
        targetQuantity,
        schedule: schedulePreparation,
      },
      signal,
    );
    if (scheduledChange) {
      return scheduledChange;
    }

    if (targetQuantity < item.quantity) {
      const effectiveAt = await schedulePreparedConcurrencyReduction(
        {
          stripe,
          subscription,
          schedule: schedulePreparation,
          item,
          targetQuantity,
        },
        signal,
      );
      return {
        ok: true,
        response: {
          status: "completed",
          hostedInvoiceUrl: null,
          effectiveAt: effectiveAt.toISOString(),
        },
        subscription,
      };
    }

    if (schedulePreparation.kind !== "none") {
      await stripe.subscriptionSchedules.release(schedulePreparation.id, {
        preserve_cancel_date: true,
      });
      signal.throwIfAborted();
    }
    return await applyImmediateConcurrencySubscriptionChange(
      stripe,
      {
        subscription,
        item,
        targetQuantity,
        paymentMethod: args.paymentMethod,
      },
      signal,
    );
  },
);

export const previewConcurrencySubscriptionChange$ = command(
  async (
    { get, set },
    args: ConcurrencySubscriptionChangeArgs,
    signal: AbortSignal,
  ): Promise<PreviewConcurrencySubscriptionChangeResult> => {
    const subscription = await findActiveConcurrencySubscription(
      get(db$),
      args,
    );
    signal.throwIfAborted();
    if (!subscription) {
      return { ok: false, reason: "not_found" };
    }
    if (subscription.cancelAtPeriodEnd) {
      return { ok: false, reason: "canceling" };
    }
    return await set(
      previewStripeConcurrencySubscriptionChange$,
      {
        ...args,
        mode: "absolute",
        hasScheduledConcurrencyChange: subscription.scheduledQuantity !== null,
      },
      signal,
    );
  },
);

export const changeConcurrencySubscription$ = command(
  async (
    { get, set },
    args: ConfirmedConcurrencySubscriptionChangeArgs,
    signal: AbortSignal,
  ): Promise<ChangeConcurrencySubscriptionResult> => {
    const subscription = await findActiveConcurrencySubscription(
      get(db$),
      args,
    );
    signal.throwIfAborted();
    if (!subscription) {
      return { ok: false, reason: "not_found" };
    }
    if (subscription.cancelAtPeriodEnd) {
      return { ok: false, reason: "canceling" };
    }
    const result = await set(
      applyStripeConcurrencySubscriptionChange$,
      {
        orgId: args.orgId,
        subscriptionId: args.subscriptionId,
        quantity: args.quantity,
        mode: "absolute",
        hasScheduledConcurrencyChange: subscription.scheduledQuantity !== null,
        paymentMethod: args.paymentMethod,
      },
      signal,
    );
    if (result.ok) {
      if (result.response.status === "checkout_required") {
        throw new Error(
          "Stripe concurrency change unexpectedly required Checkout",
        );
      }
      const scheduled =
        args.quantity < subscription.quantity &&
        result.response.effectiveAt !== undefined;
      await writeScheduledConcurrencyChange(set(writeDb$), {
        orgId: args.orgId,
        subscriptionId: args.subscriptionId,
        quantity: scheduled ? args.quantity : null,
        effectiveAt: scheduled ? (result.response.effectiveAt ?? null) : null,
      });
      signal.throwIfAborted();
    }
    return result;
  },
);

export const cancelConcurrencySubscription$ = command(
  async (
    { get, set },
    args: ConcurrencySubscriptionArgs,
    signal: AbortSignal,
  ): Promise<CancelConcurrencySubscriptionResult> => {
    const subscription = await findActiveConcurrencySubscription(
      get(db$),
      args,
    );
    signal.throwIfAborted();
    if (!subscription) {
      return { ok: false, reason: "not_found" };
    }
    const stripe = getStripeClient();
    const db = get(db$);
    if ((await sharedBillingSubscriptionKind(db, args)) !== null) {
      const stripeSubscription = await stripe.subscriptions.retrieve(
        args.subscriptionId,
      );
      signal.throwIfAborted();
      const schedulePreparation = await prepareConcurrencySchedule(
        db,
        stripe,
        {
          orgId: args.orgId,
          subscription: stripeSubscription,
          hasScheduledConcurrencyChange:
            subscription.scheduledQuantity !== null,
        },
        signal,
      );
      if (!schedulePreparation.ok) {
        return { ok: false, reason: "pending_update" };
      }
      const item = concurrencySubscriptionItem(stripeSubscription.items.data);
      if (!item) {
        throw new Error(
          "Concurrency subscription has no active concurrency item",
        );
      }
      const stripeItem = concurrencyPriceItem(stripeSubscription.items.data);
      if (!stripeItem) {
        throw new Error(
          "Concurrency subscription has no active concurrency item",
        );
      }
      if (
        planEndsBeforeDeferredConcurrencyChange(
          stripeSubscription,
          stripeItem,
          schedulePreparation,
        )
      ) {
        return { ok: false, reason: "plan_ending" };
      }
      if (schedulePreparation.kind === "shared") {
        await scheduleConcurrencyOnSharedSchedule(
          stripe,
          {
            subscription: stripeSubscription,
            scheduleId: schedulePreparation.id,
            schedule: schedulePreparation.schedule,
            priceId: item.priceId,
            targetQuantity: 0,
          },
          signal,
        );
      } else {
        await scheduleConcurrencyChange(stripeSubscription, 0, signal);
      }
    } else {
      await stripe.subscriptions.update(args.subscriptionId, {
        cancel_at_period_end: true,
      });
    }
    signal.throwIfAborted();

    await set(writeDb$)
      .update(orgConcurrencySubscriptions)
      .set({
        cancelAtPeriodEnd: true,
        scheduledSlots: null,
        scheduledChangeAt: null,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(orgConcurrencySubscriptions.orgId, args.orgId),
          eq(
            orgConcurrencySubscriptions.stripeSubscriptionId,
            args.subscriptionId,
          ),
        ),
      );
    signal.throwIfAborted();

    return {
      ok: true,
      currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
    };
  },
);

type RestoreConcurrencyStripeResult =
  | "restored"
  | "not_found"
  | "pending_update"
  | "plan_ending";

async function restoreScheduledConcurrencyChange(
  stripe: StripeClient,
  db: ReadonlyDb,
  args: ConcurrencySubscriptionArgs & {
    readonly quantity: number;
    readonly shared: boolean;
    readonly restoreSubscriptionCancellation: boolean;
  },
  signal: AbortSignal,
): Promise<RestoreConcurrencyStripeResult> {
  const stripeSubscription = await stripe.subscriptions.retrieve(
    args.subscriptionId,
  );
  signal.throwIfAborted();
  const item = concurrencySubscriptionItem(stripeSubscription.items.data);
  if (!item) {
    return "not_found";
  }

  const scheduleId = stripeObjectId(stripeSubscription.schedule);
  if (!scheduleId) {
    if (item.quantity !== args.quantity) {
      return "not_found";
    }
    if (args.restoreSubscriptionCancellation) {
      await stripe.subscriptions.update(args.subscriptionId, {
        cancel_at_period_end: false,
      });
    }
    return "restored";
  }
  if (!args.shared) {
    await stripe.subscriptionSchedules.release(scheduleId, {
      preserve_cancel_date: true,
    });
    return "restored";
  }

  const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId);
  signal.throwIfAborted();
  const owner = await concurrencyScheduleOwner(
    db,
    args.orgId,
    stripeSubscription.id,
    schedule,
  );
  signal.throwIfAborted();
  if (owner === "plan") {
    const planEndsAt = await planConcurrencyEnd(db, args.orgId, schedule);
    signal.throwIfAborted();
    if (planEndsAt === null) {
      return "plan_ending";
    }
    await applyConcurrencyToAttachedSchedule(
      stripe,
      {
        subscription: stripeSubscription,
        scheduleId,
        schedule,
        priceId: item.priceId,
        targetQuantity: args.quantity,
        prorationBehavior: "none",
        planEndsAt,
      },
      signal,
    );
    return "restored";
  }
  if (owner === "shared") {
    await applyConcurrencyToAttachedSchedule(
      stripe,
      {
        subscription: stripeSubscription,
        scheduleId,
        schedule,
        priceId: item.priceId,
        targetQuantity: args.quantity,
        prorationBehavior: "none",
      },
      signal,
    );
  } else {
    await stripe.subscriptionSchedules.release(scheduleId, {
      preserve_cancel_date: true,
    });
  }
  return "restored";
}

export const restoreConcurrencySubscription$ = command(
  async (
    { get, set },
    args: ConcurrencySubscriptionArgs,
    signal: AbortSignal,
  ): Promise<CancelConcurrencySubscriptionResult> => {
    const subscription = await findActiveConcurrencySubscription(
      get(db$),
      args,
    );
    signal.throwIfAborted();
    if (
      !subscription ||
      (!subscription.cancelAtPeriodEnd &&
        subscription.scheduledQuantity === null)
    ) {
      return { ok: false, reason: "not_found" };
    }

    const stripe = getStripeClient();
    const db = get(db$);
    const sharedKind = await sharedBillingSubscriptionKind(db, args);
    signal.throwIfAborted();
    if (sharedKind !== null || subscription.scheduledQuantity !== null) {
      const stripeResult = await restoreScheduledConcurrencyChange(
        stripe,
        db,
        {
          ...args,
          quantity: subscription.quantity,
          shared: sharedKind !== null,
          restoreSubscriptionCancellation:
            sharedKind === "allowance" &&
            subscription.cancelAtPeriodEnd &&
            subscription.scheduledQuantity === null,
        },
        signal,
      );
      if (stripeResult !== "restored") {
        return { ok: false, reason: stripeResult };
      }
    } else {
      await stripe.subscriptions.update(args.subscriptionId, {
        cancel_at_period_end: false,
      });
    }
    signal.throwIfAborted();

    await set(writeDb$)
      .update(orgConcurrencySubscriptions)
      .set({
        cancelAtPeriodEnd: false,
        scheduledSlots: null,
        scheduledChangeAt: null,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(orgConcurrencySubscriptions.orgId, args.orgId),
          eq(
            orgConcurrencySubscriptions.stripeSubscriptionId,
            args.subscriptionId,
          ),
        ),
      );
    signal.throwIfAborted();

    return {
      ok: true,
      currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
    };
  },
);
