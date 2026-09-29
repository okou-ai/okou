import { command } from "ccstate";
import { retireMarketingMetadata } from "../../lib/marketing-metadata";
import type { UsagePackDeferredSchedule } from "@okouai/db/jsonb-contracts/usage-pack-deferred-schedule";
import type {
  MemberUsagePack,
  UsagePackChangeConfirmResponse,
  UsagePackSubscriptionChangePreviewResponse,
  UsagePackUsd,
} from "@okouai/api-contracts/contracts/billing";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import {
  usagePackAllocationChanges,
  usagePackAllocations,
  usagePackSubscriptionChanges,
  usagePackSubscriptions,
} from "@okouai/db/schema/usage-pack-subscription";
import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  isNotNull,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import {
  getStripeClient,
  type StripeInvoice,
  type StripeInvoiceCreatePreviewParams,
  type StripeInvoiceLine,
  type StripePriceRecurring,
  type StripeSchedulePhase,
  type StripeSchedulePhaseDiscountParam,
  type StripeSchedulePhaseItemParam,
  type StripeSchedulePhaseParam,
  type StripeSubscription,
  type StripeSubscriptionItem,
  type StripeSubscriptionSchedule,
  type StripeSubscriptionScheduleUpdateParams,
  type StripeSubscriptionUpdateItemParam,
} from "../external/stripe-client";
import { settle } from "../utils";
import {
  calculateUsagePackAdditionCreditGrant,
  calculateUsagePackUpgradeCreditGrants,
  failScheduledUsagePackAllocationChangesForSchedule,
  fulfillUsagePackSubscriptionChangeInvoice,
  reconcileUsagePackAllocationChangeSubscription,
  usagePackInvoiceFulfillmentExists,
  usagePackBillingCompatibilityLockSql,
  type UsagePackChangeInvoiceInput,
} from "./usage-pack-allocation-change.service";
import type { BillingReconciliationScope } from "./billing-reconciliation-scope";
import { completeBillingOperationInvoice } from "./billing-operation-invoice.service";
import { deferredScheduleMatchesRequest } from "./usage-pack-deferred-schedule.service";
import {
  setStripeSubscriptionPaymentMethod,
  type BillingPurchasePaymentMethod,
} from "./billing-payment-method.service";
import {
  canceledUsageAllowanceScheduleMetadata,
  subscriptionScheduleHasNoFutureChanges,
} from "./stripe-subscription-schedules.service";
import {
  activeUsagePackPlanPriceId,
  activeUsagePackPriceId,
  isUsagePackPlanPriceId,
  tierForKnownPriceId,
  usagePackUsdForKnownPriceId,
} from "./billing-checkout.service";

const PREVIEW_TTL_MS = 15 * 60 * 1000;
const RECONCILIATION_DELAY_MS = 5 * 60 * 1000;
const PAYMENT_CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;
const L = logger("UsagePackPlanChange");
const OPEN_ALLOCATION_CHANGE_STATUSES = [
  "previewed",
  "applying",
  "pending_payment",
  "scheduled",
  "applied",
] as const;
const OPEN_SUBSCRIPTION_CHANGE_STATUSES = [
  "previewed",
  "applying",
  "pending_payment",
] as const;
const PROJECTED_ALLOCATION_STATUSES = [
  "pending_payment",
  "active",
  "pending_invitation",
] as const;
const TERMINAL_SUBSCRIPTION_STATUSES = [
  "canceled",
  "incomplete_expired",
  "invalid",
] as const;

type UsagePackTier = "pro" | "team";
type UsagePackSubscriptionRow = typeof usagePackSubscriptions.$inferSelect;
type UsagePackAllocationRow = typeof usagePackAllocations.$inferSelect;
type UsagePackAllocationChangeRow =
  typeof usagePackAllocationChanges.$inferSelect;
type UsagePackAllocationChangeInsert =
  typeof usagePackAllocationChanges.$inferInsert;
type UsagePackSubscriptionChangeRow =
  typeof usagePackSubscriptionChanges.$inferSelect;
type WriteTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

interface UsagePackSubscriptionChangeContext {
  readonly subscription: UsagePackSubscriptionRow;
  readonly allocations: readonly UsagePackAllocationRow[];
  readonly openAllocationChanges: readonly UsagePackAllocationChangeRow[];
  readonly openSubscriptionChanges: readonly {
    readonly id: string;
    readonly status: UsagePackSubscriptionChangeRow["status"];
  }[];
  readonly pendingPlanScheduleId: string | null;
  readonly pendingPlanTargetTier: string | null;
}

type PreparedAllocationChange =
  | {
      readonly kind: "addition";
      readonly userId: string;
      readonly targetUsagePackUsd: UsagePackUsd;
      readonly targetStripePriceId: string;
    }
  | {
      readonly kind: "upgrade" | "downgrade";
      readonly source: UsagePackAllocationRow;
      readonly targetUsagePackUsd: UsagePackUsd;
      readonly targetStripePriceId: string;
    }
  | {
      readonly kind: "removal";
      readonly source: UsagePackAllocationRow;
      readonly targetUsagePackUsd: null;
      readonly targetStripePriceId: null;
    };

interface PreparedSubscriptionChange {
  readonly context: UsagePackSubscriptionChangeContext;
  readonly subscription: StripeSubscription;
  readonly planItem: StripeSubscriptionItem;
  readonly targetPlanPriceId: string;
  readonly allocationChanges: readonly PreparedAllocationChange[];
  readonly period: { readonly start: number; readonly end: number };
  readonly prorationTimestamp: number;
  readonly hasImmediateChanges: boolean;
  readonly hasScheduledChanges: boolean;
  readonly existingScheduleId: string | null;
  readonly attachedSchedule: StripeSubscriptionSchedule | null;
}

interface PersistSubscriptionChangePreviewArgs {
  readonly prepared: PreparedSubscriptionChange;
  readonly targetTier: UsagePackTier;
  readonly immediateAmountCents: number;
  readonly nextRecurringAmountCents: number;
  readonly currency: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly effectiveAt: Date;
}

type UsagePackSubscriptionChangeInvoiceInput = UsagePackChangeInvoiceInput;

export type UsagePackSubscriptionChangePreviewResult =
  | {
      readonly status: "ready";
      readonly preview: UsagePackSubscriptionChangePreviewResponse;
    }
  | { readonly status: "not_found" }
  | { readonly status: "same_configuration" }
  | { readonly status: "invalid_members" }
  | { readonly status: "plan_ending" }
  | { readonly status: "conflict" };

export type UsagePackSubscriptionChangeConfirmResult =
  | {
      readonly status: "confirmed";
      readonly response: UsagePackChangeConfirmResponse;
    }
  | { readonly status: "not_found" }
  | { readonly status: "expired" }
  | { readonly status: "plan_ending" }
  | { readonly status: "conflict" };

type UsagePackSubscriptionChangeInvoiceOutcome =
  | { readonly handled: false; readonly orgId: null }
  | {
      readonly handled: true;
      readonly orgId: string;
      readonly subscription: StripeSubscription;
    };

const usagePackSubscriptionPreviewContext$ = command(
  async (
    { set },
    orgId: string,
    signal: AbortSignal,
  ): Promise<UsagePackSubscriptionChangeContext | null> => {
    const db = set(writeDb$);
    const [subscription] = await db
      .select()
      .from(usagePackSubscriptions)
      .where(
        and(
          eq(usagePackSubscriptions.orgId, orgId),
          isNotNull(usagePackSubscriptions.stripeSubscriptionId),
          notInArray(usagePackSubscriptions.subscriptionStatus, [
            ...TERMINAL_SUBSCRIPTION_STATUSES,
          ]),
        ),
      )
      .orderBy(desc(usagePackSubscriptions.updatedAt))
      .limit(1);
    signal.throwIfAborted();
    if (!subscription) {
      return null;
    }
    const [allocations, openAllocationChanges, openSubscriptionChanges, orgs] =
      await Promise.all([
        db
          .select()
          .from(usagePackAllocations)
          .where(
            eq(usagePackAllocations.usagePackSubscriptionId, subscription.id),
          ),
        db
          .select()
          .from(usagePackAllocationChanges)
          .where(
            and(
              eq(
                usagePackAllocationChanges.usagePackSubscriptionId,
                subscription.id,
              ),
              inArray(usagePackAllocationChanges.status, [
                ...OPEN_ALLOCATION_CHANGE_STATUSES,
              ]),
              or(
                isNull(usagePackAllocationChanges.subscriptionChangeId),
                ne(usagePackAllocationChanges.status, "previewed"),
              ),
            ),
          ),
        db
          .select({
            id: usagePackSubscriptionChanges.id,
            status: usagePackSubscriptionChanges.status,
          })
          .from(usagePackSubscriptionChanges)
          .where(
            and(
              eq(
                usagePackSubscriptionChanges.usagePackSubscriptionId,
                subscription.id,
              ),
              inArray(usagePackSubscriptionChanges.status, [
                ...OPEN_SUBSCRIPTION_CHANGE_STATUSES,
              ]),
            ),
          )
          .limit(1),
        db
          .select({
            pendingPlanScheduleId: orgMetadata.pendingSubscriptionScheduleId,
            pendingPlanTargetTier: orgMetadata.pendingSubscriptionTargetTier,
          })
          .from(orgMetadata)
          .where(eq(orgMetadata.orgId, orgId))
          .limit(1),
      ]);
    signal.throwIfAborted();
    const org = orgs[0];
    if (!org) {
      throw new Error("Usage pack subscription lost its organization");
    }
    return {
      subscription,
      allocations,
      openAllocationChanges,
      openSubscriptionChanges,
      pendingPlanScheduleId: org.pendingPlanScheduleId,
      pendingPlanTargetTier: org.pendingPlanTargetTier,
    };
  },
);

function stripeObjectId(
  value: string | { readonly id: string } | null | undefined,
): string | null {
  return typeof value === "string" ? value : (value?.id ?? null);
}

function stripeSubscriptionWillEnd(
  subscription: Pick<StripeSubscription, "cancel_at" | "cancel_at_period_end">,
): boolean {
  return (
    subscription.cancel_at_period_end === true ||
    (subscription.cancel_at !== null && subscription.cancel_at !== undefined)
  );
}

function stripeSubscriptionChangeConflictStatus(
  subscription: StripeSubscription,
  hasScheduledChanges: boolean,
): "plan_ending" | "conflict" | null {
  if (subscription.pending_update) {
    return "conflict";
  }
  if (hasScheduledChanges && stripeSubscriptionWillEnd(subscription)) {
    return "plan_ending";
  }
  return null;
}

function isProjectedAllocation(allocation: UsagePackAllocationRow): boolean {
  return PROJECTED_ALLOCATION_STATUSES.some((status) => {
    return allocation.status === status;
  });
}

function activeMemberAllocations(
  allocations: readonly UsagePackAllocationRow[],
): readonly UsagePackAllocationRow[] {
  return allocations.filter((allocation) => {
    return allocation.status === "active" && allocation.userId !== null;
  });
}

function packageQuantitiesFromAllocations(
  allocations: readonly UsagePackAllocationRow[],
): ReadonlyMap<string, number> {
  const quantities = new Map<string, number>();
  for (const allocation of allocations) {
    if (!isProjectedAllocation(allocation)) {
      continue;
    }
    quantities.set(
      allocation.stripePriceId,
      (quantities.get(allocation.stripePriceId) ?? 0) + 1,
    );
  }
  return quantities;
}

function packageQuantitiesFromSubscription(
  subscription: StripeSubscription,
): ReadonlyMap<string, number> {
  const quantities = new Map<string, number>();
  for (const item of subscription.items.data) {
    if (usagePackUsdForKnownPriceId(item.price.id) === null) {
      continue;
    }
    const quantity = item.quantity ?? 1;
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw new Error(
        `Usage pack subscription item ${item.price.id} has an invalid quantity`,
      );
    }
    quantities.set(
      item.price.id,
      (quantities.get(item.price.id) ?? 0) + quantity,
    );
  }
  return quantities;
}

function quantitiesMatch(
  left: ReadonlyMap<string, number>,
  right: ReadonlyMap<string, number>,
): boolean {
  return (
    left.size === right.size &&
    [...left].every(([priceId, quantity]) => {
      return right.get(priceId) === quantity;
    })
  );
}

function currentPlanItem(
  context: UsagePackSubscriptionChangeContext,
  subscription: StripeSubscription,
): StripeSubscriptionItem {
  const planItem = subscriptionPlanItem(subscription);
  if (
    planItem.price.id !== context.subscription.stripePlanPriceId ||
    tierForKnownPriceId(planItem.price.id) !== context.subscription.tier
  ) {
    throw new Error("Stripe usage pack plan is out of sync");
  }
  return planItem;
}

function subscriptionPlanItem(
  subscription: StripeSubscription,
): StripeSubscriptionItem {
  const planItems = subscription.items.data.filter((item) => {
    return isUsagePackPlanPriceId(item.price.id);
  });
  const planItem = planItems[0];
  if (planItems.length !== 1 || !planItem || (planItem.quantity ?? 1) !== 1) {
    throw new Error("Stripe usage pack subscription has an invalid base plan");
  }
  return planItem;
}

function subscriptionPlanTier(subscription: StripeSubscription): UsagePackTier {
  const tier = tierForKnownPriceId(subscriptionPlanItem(subscription).price.id);
  if (!tier) {
    throw new Error("Stripe usage pack subscription has an invalid base plan");
  }
  return tier;
}

function validateStripeSubscription(
  context: UsagePackSubscriptionChangeContext,
  subscription: StripeSubscription,
): StripeSubscriptionItem {
  if (
    subscription.id !== context.subscription.stripeSubscriptionId ||
    stripeObjectId(subscription.customer) !==
      context.subscription.stripeCustomerId
  ) {
    throw new Error("Stripe subscription does not match the usage pack record");
  }
  if (
    !quantitiesMatch(
      packageQuantitiesFromAllocations(context.allocations),
      packageQuantitiesFromSubscription(subscription),
    )
  ) {
    throw new Error("Stripe usage pack quantities are out of sync");
  }
  return currentPlanItem(context, subscription);
}

function usagePackPeriod(subscription: StripeSubscription): {
  readonly start: number;
  readonly end: number;
} {
  const packageItems = subscription.items.data.filter((item) => {
    return (
      isUsagePackPlanPriceId(item.price.id) ||
      usagePackUsdForKnownPriceId(item.price.id) !== null
    );
  });
  const first = packageItems[0];
  const start = first?.current_period_start;
  const end = first?.current_period_end;
  if (
    typeof start !== "number" ||
    typeof end !== "number" ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    end <= start ||
    packageItems.some((item) => {
      return (
        item.current_period_start !== start || item.current_period_end !== end
      );
    })
  ) {
    throw new Error("Usage pack subscription has an invalid billing period");
  }
  return { start, end };
}

function memberSelectionsMatch(
  selections: readonly MemberUsagePack[],
  allocations: readonly UsagePackAllocationRow[],
): boolean {
  const selectedIds = new Set(
    selections.map((selection) => {
      return selection.memberId;
    }),
  );
  return (
    selectedIds.size === selections.length &&
    allocations.every((allocation) => {
      return allocation.userId !== null && selectedIds.has(allocation.userId);
    })
  );
}

function allocationSnapshotsMatch(
  expected: readonly UsagePackAllocationRow[],
  actual: readonly UsagePackAllocationRow[],
): boolean {
  if (expected.length !== actual.length) {
    return false;
  }
  const actualById = new Map(
    actual.map((allocation) => {
      return [allocation.id, allocation] as const;
    }),
  );
  return expected.every((allocation) => {
    const current = actualById.get(allocation.id);
    return (
      current?.status === allocation.status &&
      current.userId === allocation.userId &&
      current.invitationId === allocation.invitationId &&
      current.usagePackUsd === allocation.usagePackUsd &&
      current.stripePriceId === allocation.stripePriceId
    );
  });
}

function prepareAllocationChanges(
  selections: readonly MemberUsagePack[],
  allocations: readonly UsagePackAllocationRow[],
): readonly PreparedAllocationChange[] | null {
  if (!memberSelectionsMatch(selections, allocations)) {
    return null;
  }
  const allocationsByMember = new Map(
    allocations.map((allocation) => {
      if (!allocation.userId) {
        throw new Error("Usage pack allocation has no member");
      }
      return [allocation.userId, allocation] as const;
    }),
  );
  return selections.flatMap(
    (selection): readonly PreparedAllocationChange[] => {
      const source = allocationsByMember.get(selection.memberId);
      const targetUsagePackUsd = selection.usagePackUsd;
      if (targetUsagePackUsd === 0) {
        return source
          ? [
              {
                kind: "removal",
                source,
                targetUsagePackUsd: null,
                targetStripePriceId: null,
              },
            ]
          : [];
      }
      const targetStripePriceId = activeUsagePackPriceId(targetUsagePackUsd);
      if (!targetStripePriceId) {
        throw new Error(
          `Usage pack $${targetUsagePackUsd} Price is not configured`,
        );
      }
      if (!source) {
        return [
          {
            kind: "addition",
            userId: selection.memberId,
            targetUsagePackUsd,
            targetStripePriceId,
          },
        ];
      }
      if (targetUsagePackUsd === source.usagePackUsd) {
        return [];
      }
      return [
        {
          source,
          targetUsagePackUsd,
          targetStripePriceId,
          kind:
            targetUsagePackUsd > source.usagePackUsd
              ? ("upgrade" as const)
              : ("downgrade" as const),
        },
      ];
    },
  );
}

function adjustedPackageQuantities(
  allocations: readonly UsagePackAllocationRow[],
  changes: readonly PreparedAllocationChange[],
  include: (change: PreparedAllocationChange) => boolean,
): ReadonlyMap<string, number> {
  const quantities = new Map(packageQuantitiesFromAllocations(allocations));
  for (const change of changes) {
    if (!include(change)) {
      continue;
    }
    if (change.kind !== "addition") {
      const sourceQuantity = quantities.get(change.source.stripePriceId) ?? 0;
      if (sourceQuantity <= 0) {
        throw new Error("Usage pack source quantity disappeared");
      }
      if (sourceQuantity === 1) {
        quantities.delete(change.source.stripePriceId);
      } else {
        quantities.set(change.source.stripePriceId, sourceQuantity - 1);
      }
    }
    if (change.kind !== "removal") {
      quantities.set(
        change.targetStripePriceId,
        (quantities.get(change.targetStripePriceId) ?? 0) + 1,
      );
    }
  }
  return quantities;
}

function subscriptionUpdateItems(
  subscription: StripeSubscription,
  planItem: StripeSubscriptionItem,
  targetPlanPriceId: string,
  targetPackageQuantities: ReadonlyMap<string, number>,
): StripeSubscriptionUpdateItemParam[] {
  const items: StripeSubscriptionUpdateItemParam[] = [];
  if (planItem.price.id !== targetPlanPriceId) {
    items.push({
      id: planItem.id,
      price: targetPlanPriceId,
      quantity: 1,
    });
  }
  const remaining = new Map(targetPackageQuantities);
  for (const item of subscription.items.data) {
    if (usagePackUsdForKnownPriceId(item.price.id) === null) {
      continue;
    }
    const currentQuantity = item.quantity ?? 1;
    const targetQuantity = remaining.get(item.price.id) ?? 0;
    remaining.delete(item.price.id);
    if (targetQuantity === currentQuantity) {
      continue;
    }
    items.push(
      targetQuantity === 0
        ? { id: item.id, deleted: true }
        : { id: item.id, quantity: targetQuantity },
    );
  }
  for (const [price, quantity] of remaining) {
    items.push({ price, quantity });
  }
  return items;
}

function invoiceLinePriceId(line: StripeInvoiceLine): string | null {
  const price = line.pricing?.price_details?.price;
  return typeof price === "string" ? price : (price?.id ?? null);
}

function invoiceLineAmountWithTax(line: StripeInvoiceLine): number {
  const exclusiveTax = (line.taxes ?? []).reduce((total, tax) => {
    return tax.tax_behavior === "exclusive" ? total + tax.amount : total;
  }, 0);
  const amount = line.amount + exclusiveTax;
  if (!Number.isSafeInteger(amount)) {
    throw new Error(`Stripe invoice line ${line.id} has an invalid amount`);
  }
  return amount;
}

function immediateProrationAmount(
  invoice: StripeInvoice,
  prorationTimestamp: number,
): number {
  const lines = invoice.lines.data.filter((line) => {
    const priceId = invoiceLinePriceId(line);
    return (
      line.parent?.subscription_item_details?.proration === true &&
      line.period.start === prorationTimestamp &&
      priceId !== null &&
      (isUsagePackPlanPriceId(priceId) ||
        usagePackUsdForKnownPriceId(priceId) !== null)
    );
  });
  const amount = lines.reduce((total, line) => {
    return total + invoiceLineAmountWithTax(line);
  }, 0);
  if (lines.length === 0 || !Number.isSafeInteger(amount) || amount < 0) {
    throw new Error("Stripe immediate preview has an invalid amount");
  }
  return amount;
}

function recurringAmount(invoice: StripeInvoice): number {
  if (
    !Number.isSafeInteger(invoice.amount_due) ||
    invoice.amount_due < 0 ||
    invoice.currency.length !== 3
  ) {
    throw new Error("Stripe recurring preview has an invalid amount");
  }
  return invoice.amount_due;
}

function scheduledSubscriptionRecurringPreviewParams(
  subscription: StripeSubscription,
  items: readonly StripeSchedulePhaseItemParam[],
): StripeInvoiceCreatePreviewParams {
  const customerId = stripeObjectId(subscription.customer);
  if (!customerId) {
    throw new Error(`Stripe subscription ${subscription.id} has no customer`);
  }
  return {
    customer: customerId,
    preview_mode: "recurring",
    subscription_details: {
      items: [...items],
    },
  };
}

function subscriptionChangeRecurringPreviewParams(args: {
  readonly prepared: PreparedSubscriptionChange;
  readonly finalItems: readonly StripeSubscriptionUpdateItemParam[];
  readonly immediatePackageQuantities: ReadonlyMap<string, number>;
  readonly finalPackageQuantities: ReadonlyMap<string, number>;
}): StripeInvoiceCreatePreviewParams {
  const attachedSchedule = args.prepared.attachedSchedule;
  if (
    attachedSchedule &&
    (args.prepared.hasScheduledChanges ||
      (args.prepared.existingScheduleId && args.prepared.hasImmediateChanges))
  ) {
    return {
      schedule: attachedSchedule.id,
      preview_mode: "next",
      schedule_details: deferredUsagePackChangeScheduleParams({
        subscription: args.prepared.subscription,
        schedule: attachedSchedule,
        effectiveAt: args.prepared.period.end,
        currentPlanPriceId:
          args.prepared.context.subscription.tier === "pro" &&
          args.prepared.targetPlanPriceId !==
            args.prepared.context.subscription.stripePlanPriceId
            ? args.prepared.targetPlanPriceId
            : args.prepared.context.subscription.stripePlanPriceId,
        currentQuantities: args.immediatePackageQuantities,
        targetPlanPriceId: args.prepared.targetPlanPriceId,
        quantities: args.finalPackageQuantities,
      }),
    };
  }
  if (attachedSchedule) {
    return scheduledSubscriptionRecurringPreviewParams(
      args.prepared.subscription,
      finalScheduleItems(
        args.prepared.subscription,
        args.prepared.targetPlanPriceId,
        args.finalPackageQuantities,
      ),
    );
  }
  return {
    subscription: args.prepared.subscription.id,
    preview_mode: "recurring",
    subscription_details: { items: [...args.finalItems] },
  };
}

function planIsUpgrade(source: UsagePackTier, target: UsagePackTier): boolean {
  return source === "pro" && target === "team";
}

function planIsDowngrade(
  source: UsagePackTier,
  target: UsagePackTier,
): boolean {
  return source === "team" && target === "pro";
}

function restorableScheduleId(
  changes: readonly UsagePackAllocationChangeRow[],
): string | null {
  const scheduleId = changes[0]?.stripeScheduleId;
  if (!scheduleId) {
    return null;
  }
  return changes.every((change) => {
    return (
      change.status === "scheduled" &&
      (change.kind === "downgrade" ||
        (change.kind === "removal" && change.subscriptionChangeId !== null)) &&
      change.stripeScheduleId === scheduleId
    );
  })
    ? scheduleId
    : null;
}

async function scheduledAllocationChanges(
  db: Pick<Db, "select">,
  subscriptionId: string,
): Promise<readonly UsagePackAllocationChangeRow[]> {
  return await db
    .select()
    .from(usagePackAllocationChanges)
    .where(
      and(
        eq(usagePackAllocationChanges.usagePackSubscriptionId, subscriptionId),
        eq(usagePackAllocationChanges.status, "scheduled"),
      ),
    );
}

function replacementScheduleId(
  changes: readonly UsagePackAllocationChangeRow[],
): string | null {
  const scheduleId = changes[0]?.stripeScheduleId;
  if (!scheduleId) {
    if (
      changes.some((change) => {
        return change.stripeScheduleId !== null;
      })
    ) {
      throw new Error(
        "Usage pack replacement has inconsistent Stripe schedules",
      );
    }
    return null;
  }
  if (
    !changes.every((change) => {
      return change.stripeScheduleId === scheduleId;
    })
  ) {
    throw new Error("Usage pack replacement has inconsistent Stripe schedules");
  }
  return scheduleId;
}

async function pendingPlanReplacementScheduleId(
  db: Pick<Db, "select">,
  root: UsagePackSubscriptionChangeRow,
): Promise<string | null> {
  if (!planIsDowngrade(root.sourceTier, root.targetTier)) {
    return null;
  }
  const [org] = await db
    .select({
      tier: orgMetadata.tier,
      scheduleId: orgMetadata.pendingSubscriptionScheduleId,
      targetTier: orgMetadata.pendingSubscriptionTargetTier,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, root.orgId))
    .limit(1);
  if (!org) {
    throw new Error("Usage pack subscription lost its organization");
  }
  return org.tier === root.sourceTier && org.targetTier === root.targetTier
    ? org.scheduleId
    : null;
}

type ExistingSchedulePreparation =
  | { readonly status: "ready"; readonly scheduleId: string | null }
  | { readonly status: "same_configuration" | "conflict" };

type SubscriptionChangePreparation =
  | { readonly status: "ready"; readonly prepared: PreparedSubscriptionChange }
  | {
      readonly status: "resumed";
      readonly preview: UsagePackSubscriptionChangePreviewResponse;
    }
  | {
      readonly status:
        | "not_found"
        | "same_configuration"
        | "invalid_members"
        | "plan_ending"
        | "conflict";
    };

function prepareExistingSchedule(args: {
  readonly openAllocationChanges: readonly UsagePackAllocationChangeRow[];
  readonly ownedPlanScheduleId: string | null;
  readonly sameConfiguration: boolean;
}): ExistingSchedulePreparation {
  if (args.ownedPlanScheduleId) {
    const ownsOpenChanges = args.openAllocationChanges.every((change) => {
      return (
        change.status === "scheduled" &&
        change.stripeScheduleId === args.ownedPlanScheduleId
      );
    });
    return ownsOpenChanges
      ? { status: "ready", scheduleId: args.ownedPlanScheduleId }
      : { status: "conflict" };
  }
  if (args.openAllocationChanges.length === 0) {
    return args.sameConfiguration
      ? { status: "same_configuration" }
      : { status: "ready", scheduleId: null };
  }
  const scheduleId = restorableScheduleId(args.openAllocationChanges);
  if (!scheduleId) {
    return { status: "conflict" };
  }
  return { status: "ready", scheduleId };
}

const resumeOpenSubscriptionChange$ = command(
  async (
    { set },
    input: {
      readonly context: UsagePackSubscriptionChangeContext;
      readonly targetTier: UsagePackTier;
      readonly memberUsagePacks: readonly MemberUsagePack[];
    },
    signal: AbortSignal,
  ): Promise<SubscriptionChangePreparation | null> => {
    const resumableChange = input.context.openSubscriptionChanges.find(
      (change) => {
        return change.status !== "previewed";
      },
    );
    if (!resumableChange) {
      return null;
    }
    const stored = await set(
      storedSubscriptionChange$,
      resumableChange.id,
      signal,
    );
    if (!stored) {
      throw new Error(
        `Open usage pack subscription change ${resumableChange.id} disappeared`,
      );
    }
    return storedSubscriptionChangeMatchesRequest(stored, input)
      ? {
          status: "resumed",
          preview: storedSubscriptionChangePreview(stored.root),
        }
      : { status: "conflict" };
  },
);

type AttachedSchedulePreparation =
  | {
      readonly status: "ready";
      readonly schedule: StripeSubscriptionSchedule | null;
    }
  | { readonly status: "conflict" };

async function prepareAttachedUsagePackSchedule(
  args: {
    readonly subscription: StripeSubscription;
    readonly existingScheduleId: string | null;
    readonly hasImmediateChanges: boolean;
  },
  signal: AbortSignal,
): Promise<AttachedSchedulePreparation> {
  const attachedScheduleId = stripeObjectId(args.subscription.schedule);
  if (
    args.existingScheduleId &&
    attachedScheduleId !== args.existingScheduleId
  ) {
    return { status: "conflict" };
  }
  if (!attachedScheduleId) {
    return { status: "ready", schedule: null };
  }
  const schedule =
    await getStripeClient().subscriptionSchedules.retrieve(attachedScheduleId);
  signal.throwIfAborted();
  const allowed =
    args.existingScheduleId !== null ||
    subscriptionScheduleHasNoFutureChanges(args.subscription, schedule) ||
    (!args.hasImmediateChanges &&
      subscriptionSchedulePreservesUsagePackConfiguration(
        args.subscription,
        schedule,
      ));
  return allowed ? { status: "ready", schedule } : { status: "conflict" };
}

const prepareSubscriptionChange$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly targetTier: UsagePackTier;
      readonly memberUsagePacks: readonly MemberUsagePack[];
    },
    signal: AbortSignal,
  ): Promise<SubscriptionChangePreparation> => {
    const context = await set(
      usagePackSubscriptionPreviewContext$,
      args.orgId,
      signal,
    );
    if (!context || !context.subscription.stripeSubscriptionId) {
      return { status: "not_found" };
    }
    const resumed = await set(
      resumeOpenSubscriptionChange$,
      { context, ...args },
      signal,
    );
    if (resumed) {
      return resumed;
    }
    const allocationChanges = prepareAllocationChanges(
      args.memberUsagePacks,
      activeMemberAllocations(context.allocations),
    );
    if (!allocationChanges) {
      return { status: "invalid_members" };
    }
    const sameConfiguration =
      context.subscription.tier === args.targetTier &&
      allocationChanges.length === 0;
    const hasImmediateChanges =
      planIsUpgrade(context.subscription.tier, args.targetTier) ||
      allocationChanges.some((change) => {
        return change.kind === "addition" || change.kind === "upgrade";
      });
    const hasScheduledChanges =
      planIsDowngrade(context.subscription.tier, args.targetTier) ||
      allocationChanges.some((change) => {
        return change.kind === "downgrade" || change.kind === "removal";
      });
    if (context.subscription.cancelAtPeriodEnd && hasScheduledChanges) {
      return { status: "plan_ending" };
    }
    const ownedPlanScheduleId =
      planIsDowngrade(context.subscription.tier, args.targetTier) &&
      context.pendingPlanTargetTier === args.targetTier
        ? context.pendingPlanScheduleId
        : null;
    const existingSchedule = prepareExistingSchedule({
      openAllocationChanges: context.openAllocationChanges,
      ownedPlanScheduleId,
      sameConfiguration,
    });
    if (existingSchedule.status !== "ready") {
      return { status: existingSchedule.status };
    }
    const existingScheduleId = existingSchedule.scheduleId;
    const targetPlanPriceId =
      context.subscription.tier === args.targetTier
        ? context.subscription.stripePlanPriceId
        : activeUsagePackPlanPriceId(args.targetTier);
    if (!targetPlanPriceId) {
      throw new Error(
        `${args.targetTier} usage pack plan Price is not configured`,
      );
    }
    const stripe = getStripeClient();
    const subscription = await stripe.subscriptions.retrieve(
      context.subscription.stripeSubscriptionId,
      { expand: ["latest_invoice"] },
    );
    signal.throwIfAborted();
    const stripeConflictStatus = stripeSubscriptionChangeConflictStatus(
      subscription,
      hasScheduledChanges,
    );
    if (stripeConflictStatus) {
      return { status: stripeConflictStatus };
    }
    const attachedSchedule = await prepareAttachedUsagePackSchedule(
      { subscription, existingScheduleId, hasImmediateChanges },
      signal,
    );
    if (attachedSchedule.status === "conflict") {
      return attachedSchedule;
    }
    const planItem = validateStripeSubscription(context, subscription);
    const period = usagePackPeriod(subscription);
    const requestedTimestamp = Math.floor(nowDate().getTime() / 1000);
    const prorationTimestamp = Math.min(
      Math.max(requestedTimestamp, period.start),
      period.end - 1,
    );
    return {
      status: "ready",
      prepared: {
        context,
        subscription,
        planItem,
        targetPlanPriceId,
        allocationChanges,
        period,
        prorationTimestamp,
        hasImmediateChanges,
        hasScheduledChanges,
        existingScheduleId,
        attachedSchedule: attachedSchedule.schedule,
      },
    };
  },
);

async function lockUsagePackBillingOrg(
  tx: Pick<WriteTx, "execute">,
  orgId: string,
): Promise<void> {
  await tx.execute(usagePackBillingCompatibilityLockSql(orgId));
}

function retirePlanPreviewSql(orgId: string, at: Date) {
  // Retire a real expired/superseded Plan intent and its child previews together.
  // The publication command executes this after locking their subscription root.
  const timestamp = at.toISOString();
  return sql`
    WITH retired AS (
      UPDATE ${usagePackSubscriptionChanges}
      SET status = 'failed',
          failure_reason = CASE WHEN preview_expires_at <= ${timestamp}
            THEN 'preview_expired' ELSE 'preview_superseded' END,
          completed_at = ${timestamp}, updated_at = ${timestamp}
      WHERE org_id = ${orgId} AND status = 'previewed'
      RETURNING id, failure_reason
    )
    UPDATE ${usagePackAllocationChanges} AS allocation_change
    SET status = 'failed',
        failure_reason = COALESCE(
          (SELECT retired.failure_reason FROM retired
           WHERE retired.id = allocation_change.subscription_change_id),
          'preview_expired'),
        completed_at = ${timestamp}, updated_at = ${timestamp}
    WHERE EXISTS (SELECT 1 FROM retired
                  WHERE retired.id = allocation_change.subscription_change_id)
       OR (allocation_change.org_id = ${orgId}
           AND allocation_change.status = 'previewed'
           AND allocation_change.preview_expires_at <= ${timestamp})
  `;
}

function subscriptionPreviewSnapshotMatches(
  prepared: PreparedSubscriptionChange,
  current: {
    readonly subscription: UsagePackSubscriptionRow;
    readonly org: typeof orgMetadata.$inferSelect | undefined;
    readonly openAllocation: readonly UsagePackAllocationChangeRow[];
    readonly openSubscription: readonly UsagePackSubscriptionChangeRow[];
    readonly allocations: readonly UsagePackAllocationRow[];
  },
): boolean | "plan_ending" {
  const { context } = prepared;
  const { subscription, org, openAllocation, openSubscription, allocations } =
    current;
  if (
    subscription.tier !== context.subscription.tier ||
    subscription.stripePlanPriceId !== context.subscription.stripePlanPriceId
  ) {
    return false;
  }
  if (prepared.hasScheduledChanges && subscription.cancelAtPeriodEnd) {
    return "plan_ending";
  }
  if (
    !org ||
    org.tier !== context.subscription.tier ||
    org.pendingSubscriptionScheduleId !== context.pendingPlanScheduleId ||
    org.pendingSubscriptionTargetTier !== context.pendingPlanTargetTier
  ) {
    return false;
  }
  const expectedOpenAllocationIds = new Set(
    context.openAllocationChanges.map((change) => {
      return change.id;
    }),
  );
  const openAllocationMatches = prepared.existingScheduleId
    ? openAllocation.length === expectedOpenAllocationIds.size &&
      openAllocation.every((change) => {
        return (
          expectedOpenAllocationIds.has(change.id) &&
          change.status === "scheduled" &&
          (change.kind === "downgrade" ||
            (change.kind === "removal" &&
              change.subscriptionChangeId !== null)) &&
          change.stripeScheduleId === prepared.existingScheduleId
        );
      })
    : openAllocation.length === 0;
  return (
    openAllocationMatches &&
    openSubscription.length === 0 &&
    allocationSnapshotsMatch(context.allocations, allocations)
  );
}

function allocationChangePreviewValue(
  change: PreparedAllocationChange,
  rootId: string,
  args: PersistSubscriptionChangePreviewArgs,
): UsagePackAllocationChangeInsert {
  const userId =
    change.kind === "addition" ? change.userId : change.source.userId;
  if (!userId) {
    throw new Error("Usage pack allocation change has no member");
  }
  const { context } = args.prepared;
  return {
    usagePackSubscriptionId: context.subscription.id,
    subscriptionChangeId: rootId,
    orgId: context.subscription.orgId,
    userId,
    sourceAllocationId: change.kind === "addition" ? null : change.source.id,
    kind: change.kind,
    sourceUsagePackUsd:
      change.kind === "addition" ? null : change.source.usagePackUsd,
    sourceStripePriceId:
      change.kind === "addition" ? null : change.source.stripePriceId,
    targetUsagePackUsd: change.targetUsagePackUsd,
    targetStripePriceId: change.targetStripePriceId,
    prorationTimestamp: args.prepared.prorationTimestamp,
    immediateAmountCents: null,
    nextRecurringAmountCents: null,
    currency: args.currency,
    stripeScheduleId: args.prepared.existingScheduleId,
    effectiveAt:
      change.kind === "addition" || change.kind === "upgrade"
        ? new Date(args.prepared.prorationTimestamp * 1000)
        : new Date(args.prepared.period.end * 1000),
    previewExpiresAt: args.expiresAt,
    createdAt: args.createdAt,
    updatedAt: args.createdAt,
  };
}

function subscriptionChangePreviewValues(
  args: PersistSubscriptionChangePreviewArgs,
): typeof usagePackSubscriptionChanges.$inferInsert {
  const { context } = args.prepared;
  return {
    usagePackSubscriptionId: context.subscription.id,
    orgId: context.subscription.orgId,
    sourceTier: context.subscription.tier,
    targetTier: args.targetTier,
    prorationTimestamp: args.prepared.prorationTimestamp,
    immediateAmountCents: args.immediateAmountCents,
    nextRecurringAmountCents: args.nextRecurringAmountCents,
    currency: args.currency,
    previewExpiresAt: args.expiresAt,
    effectiveAt: args.effectiveAt,
    createdAt: args.createdAt,
    updatedAt: args.createdAt,
  };
}

const persistSubscriptionChangePreview$ = command(
  async (
    { set },
    args: PersistSubscriptionChangePreviewArgs,
    signal: AbortSignal,
  ): Promise<UsagePackSubscriptionChangeRow | "plan_ending" | null> => {
    const db = set(writeDb$);
    const { context } = args.prepared;
    const result = await db.transaction(async (tx) => {
      await tx.execute(
        usagePackBillingCompatibilityLockSql(context.subscription.orgId),
      );
      const [subscription] = await tx
        .select()
        .from(usagePackSubscriptions)
        .where(
          and(
            eq(usagePackSubscriptions.id, context.subscription.id),
            eq(usagePackSubscriptions.orgId, context.subscription.orgId),
          ),
        )
        .for("update")
        .limit(1);
      if (!subscription) {
        return null;
      }
      await tx.execute(
        retirePlanPreviewSql(context.subscription.orgId, args.createdAt),
      );
      const [openAllocation, openSubscription, orgs] = await Promise.all([
        tx
          .select()
          .from(usagePackAllocationChanges)
          .where(
            and(
              eq(
                usagePackAllocationChanges.usagePackSubscriptionId,
                subscription.id,
              ),
              inArray(usagePackAllocationChanges.status, [
                ...OPEN_ALLOCATION_CHANGE_STATUSES,
              ]),
            ),
          ),
        tx
          .select()
          .from(usagePackSubscriptionChanges)
          .where(
            and(
              eq(
                usagePackSubscriptionChanges.usagePackSubscriptionId,
                subscription.id,
              ),
              inArray(usagePackSubscriptionChanges.status, [
                ...OPEN_SUBSCRIPTION_CHANGE_STATUSES,
              ]),
            ),
          )
          .limit(1),
        tx
          .select()
          .from(orgMetadata)
          .where(eq(orgMetadata.orgId, subscription.orgId))
          .for("update")
          .limit(1),
      ]);
      const allocations = await tx
        .select()
        .from(usagePackAllocations)
        .where(
          eq(usagePackAllocations.usagePackSubscriptionId, subscription.id),
        )
        .for("update");
      signal.throwIfAborted();
      const snapshot = subscriptionPreviewSnapshotMatches(args.prepared, {
        subscription,
        org: orgs[0],
        openAllocation,
        openSubscription,
        allocations,
      });
      if (snapshot !== true) {
        return snapshot === "plan_ending" ? snapshot : null;
      }
      const [root] = await tx
        .insert(usagePackSubscriptionChanges)
        .values(subscriptionChangePreviewValues(args))
        .returning();
      if (!root) {
        throw new Error("Failed to persist usage pack subscription preview");
      }
      if (args.prepared.allocationChanges.length > 0) {
        await tx.insert(usagePackAllocationChanges).values(
          args.prepared.allocationChanges.map((change) => {
            return allocationChangePreviewValue(change, root.id, args);
          }),
        );
      }
      return root;
    });
    signal.throwIfAborted();
    return result;
  },
);

async function immediateUsagePackUpgradeCreditGrant(
  prepared: PreparedSubscriptionChange,
): Promise<{
  readonly purchasedCredits: number;
  readonly bonusCredits: number;
  readonly totalCredits: number;
  readonly expiresAt: string;
}> {
  const inputs = prepared.allocationChanges.flatMap((change) => {
    return change.kind === "upgrade"
      ? [
          {
            sourceAllocation: change.source,
            sourceStripePriceId: change.source.stripePriceId,
            targetStripePriceId: change.targetStripePriceId,
          },
        ]
      : [];
  });
  const grants = await calculateUsagePackUpgradeCreditGrants(inputs, {
    start: prepared.prorationTimestamp,
    end: prepared.period.end,
  });
  const additionGrants = await Promise.all(
    prepared.allocationChanges.flatMap((change) => {
      return change.kind === "addition"
        ? [
            calculateUsagePackAdditionCreditGrant(
              change.targetStripePriceId,
              prepared.period,
              prepared.prorationTimestamp,
            ),
          ]
        : [];
    }),
  );
  let purchasedCredits = 0;
  let bonusCredits = 0;
  for (const grant of [...grants, ...additionGrants]) {
    purchasedCredits += grant.purchasedCredits;
    bonusCredits += grant.bonusCredits;
  }
  const totalCredits = purchasedCredits + bonusCredits;
  if (
    !Number.isSafeInteger(purchasedCredits) ||
    !Number.isSafeInteger(bonusCredits) ||
    !Number.isSafeInteger(totalCredits)
  ) {
    throw new Error("Usage pack upgrade credits are too large");
  }
  return {
    purchasedCredits,
    bonusCredits,
    totalCredits,
    expiresAt: new Date(prepared.period.end * 1000).toISOString(),
  };
}

function subscriptionChangeEffectiveAt(
  prepared: PreparedSubscriptionChange,
  targetTier: UsagePackTier,
): Date {
  const timestamp =
    planIsDowngrade(prepared.context.subscription.tier, targetTier) ||
    (!prepared.hasImmediateChanges && prepared.hasScheduledChanges)
      ? prepared.period.end
      : prepared.prorationTimestamp;
  return new Date(timestamp * 1000);
}

async function previewSubscriptionChangeInvoices(
  args: {
    readonly prepared: PreparedSubscriptionChange;
    readonly immediateItems: readonly StripeSubscriptionUpdateItemParam[];
    readonly finalItems: readonly StripeSubscriptionUpdateItemParam[];
    readonly immediatePackageQuantities: ReadonlyMap<string, number>;
    readonly finalPackageQuantities: ReadonlyMap<string, number>;
  },
  signal: AbortSignal,
): Promise<{
  readonly recurringPreview: StripeInvoice | null;
  readonly immediatePreview: StripeInvoice | null;
}> {
  const { prepared } = args;
  const stripe = getStripeClient();
  const subscriptionWillEnd = stripeSubscriptionWillEnd(prepared.subscription);
  const [recurringPreview, immediatePreview] = await Promise.all([
    subscriptionWillEnd
      ? null
      : stripe.invoices.createPreview(
          subscriptionChangeRecurringPreviewParams({
            prepared,
            finalItems: args.finalItems,
            immediatePackageQuantities: args.immediatePackageQuantities,
            finalPackageQuantities: args.finalPackageQuantities,
          }),
        ),
    prepared.hasImmediateChanges
      ? stripe.invoices.createPreview({
          subscription: prepared.subscription.id,
          preview_mode: "next",
          subscription_details: {
            ...(prepared.subscription.cancel_at_period_end
              ? { cancel_at_period_end: false }
              : prepared.subscription.cancel_at !== null &&
                  prepared.subscription.cancel_at !== undefined
                ? { cancel_at: "" as const }
                : {}),
            items: [...args.immediateItems],
            proration_behavior: "always_invoice",
            proration_date: prepared.prorationTimestamp,
          },
        })
      : null,
  ]);
  signal.throwIfAborted();
  return { recurringPreview, immediatePreview };
}

export const previewUsagePackSubscriptionChange$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly targetTier: UsagePackTier;
      readonly memberUsagePacks: readonly MemberUsagePack[];
    },
    signal: AbortSignal,
  ): Promise<UsagePackSubscriptionChangePreviewResult> => {
    const result = await set(prepareSubscriptionChange$, args, signal);
    if (result.status === "resumed") {
      return { status: "ready", preview: result.preview };
    }
    if (result.status !== "ready") {
      return result;
    }
    const { prepared } = result;
    const immediatePackageQuantities = adjustedPackageQuantities(
      prepared.context.allocations,
      prepared.allocationChanges,
      (change) => {
        return change.kind === "addition" || change.kind === "upgrade";
      },
    );
    const finalPackageQuantities = adjustedPackageQuantities(
      prepared.context.allocations,
      prepared.allocationChanges,
      () => {
        return true;
      },
    );
    const immediatePlanPriceId = planIsUpgrade(
      prepared.context.subscription.tier,
      args.targetTier,
    )
      ? prepared.targetPlanPriceId
      : prepared.context.subscription.stripePlanPriceId;
    const immediateItems = subscriptionUpdateItems(
      prepared.subscription,
      prepared.planItem,
      immediatePlanPriceId,
      immediatePackageQuantities,
    );
    const finalItems = subscriptionUpdateItems(
      prepared.subscription,
      prepared.planItem,
      prepared.targetPlanPriceId,
      finalPackageQuantities,
    );
    const [invoicePreviews, immediateCreditGrant] = await Promise.all([
      previewSubscriptionChangeInvoices(
        {
          prepared,
          immediateItems,
          finalItems,
          immediatePackageQuantities,
          finalPackageQuantities,
        },
        signal,
      ),
      immediateUsagePackUpgradeCreditGrant(prepared),
    ]);
    signal.throwIfAborted();
    const { recurringPreview, immediatePreview } = invoicePreviews;
    const currency = recurringPreview?.currency ?? immediatePreview?.currency;
    if (!currency) {
      throw new Error("Stripe subscription preview has no currency");
    }
    if (
      recurringPreview &&
      immediatePreview &&
      recurringPreview.currency !== immediatePreview.currency
    ) {
      throw new Error(
        "Stripe subscription previews returned different currencies",
      );
    }
    const createdAt = nowDate();
    const expiresAt = new Date(createdAt.getTime() + PREVIEW_TTL_MS);
    const effectiveAt = subscriptionChangeEffectiveAt(
      prepared,
      args.targetTier,
    );
    const immediateAmountCents = immediatePreview
      ? immediateProrationAmount(immediatePreview, prepared.prorationTimestamp)
      : 0;
    const nextRecurringAmountCents = recurringPreview
      ? recurringAmount(recurringPreview)
      : 0;
    const change = await set(
      persistSubscriptionChangePreview$,
      {
        prepared,
        targetTier: args.targetTier,
        immediateAmountCents,
        nextRecurringAmountCents,
        currency,
        createdAt,
        expiresAt,
        effectiveAt,
      },
      signal,
    );
    if (change === "plan_ending") {
      return { status: "plan_ending" };
    }
    if (!change) {
      return { status: "conflict" };
    }
    return {
      status: "ready",
      preview: {
        changeId: change.id,
        sourceTier: change.sourceTier,
        targetTier: change.targetTier,
        immediateAmountCents,
        immediateCreditGrant,
        nextRecurringAmountCents,
        currency,
        effectiveAt: effectiveAt.toISOString(),
        prorationDate: new Date(
          prepared.prorationTimestamp * 1000,
        ).toISOString(),
        expiresAt: expiresAt.toISOString(),
      },
    };
  },
);

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

function subscriptionRecurringDuration(
  subscription: StripeSubscription,
): StripePriceRecurring {
  const recurring = subscription.items.data.find((item) => {
    return isUsagePackPlanPriceId(item.price.id);
  })?.price.recurring;
  if (!recurring) {
    throw new Error("Usage pack base plan is not recurring");
  }
  return {
    interval: recurring.interval,
    interval_count: recurring.interval_count,
  };
}

function newUsagePackChangeScheduleParams(args: {
  readonly subscription: StripeSubscription;
  readonly period: { readonly start: number; readonly end: number };
  readonly targetPlanPriceId: string;
  readonly quantities: ReadonlyMap<string, number>;
}): StripeSubscriptionScheduleUpdateParams {
  const discounts = subscriptionPhaseDiscounts(args.subscription);
  return {
    end_behavior: "release",
    proration_behavior: "none",
    phases: [
      phaseWithDiscounts(
        {
          start_date: args.period.start,
          end_date: args.period.end,
          items: subscriptionPhaseItems(args.subscription),
          proration_behavior: "none",
        },
        discounts,
      ),
      phaseWithDiscounts(
        {
          start_date: args.period.end,
          duration: subscriptionRecurringDuration(args.subscription),
          items: finalScheduleItems(
            args.subscription,
            args.targetPlanPriceId,
            args.quantities,
          ),
          proration_behavior: "none",
        },
        discounts,
      ),
    ],
  };
}

function projectedPackageQuantities(
  allocations: readonly UsagePackAllocationRow[],
  changes: readonly UsagePackAllocationChangeRow[],
  include: (change: UsagePackAllocationChangeRow) => boolean,
): ReadonlyMap<string, number> {
  const priceByMember = new Map<string, string>();
  for (const allocation of allocations) {
    if (allocation.userId && isProjectedAllocation(allocation)) {
      priceByMember.set(allocation.userId, allocation.stripePriceId);
    }
  }
  for (const change of changes) {
    if (!include(change)) {
      continue;
    }
    if (change.kind === "removal") {
      priceByMember.delete(change.userId);
      continue;
    }
    if (!change.targetStripePriceId) {
      throw new Error(`Subscription change ${change.id} has no target Price`);
    }
    priceByMember.set(change.userId, change.targetStripePriceId);
  }
  const quantities = new Map<string, number>();
  for (const priceId of priceByMember.values()) {
    quantities.set(priceId, (quantities.get(priceId) ?? 0) + 1);
  }
  for (const allocation of allocations) {
    if (allocation.invitationId && isProjectedAllocation(allocation)) {
      quantities.set(
        allocation.stripePriceId,
        (quantities.get(allocation.stripePriceId) ?? 0) + 1,
      );
    }
  }
  return quantities;
}

function finalScheduleItems(
  subscription: StripeSubscription,
  targetPlanPriceId: string,
  quantities: ReadonlyMap<string, number>,
): StripeSchedulePhaseItemParam[] {
  const unrelated = subscription.items.data
    .filter((item) => {
      return (
        !isUsagePackPlanPriceId(item.price.id) &&
        usagePackUsdForKnownPriceId(item.price.id) === null
      );
    })
    .map((item) => {
      return { price: item.price.id, quantity: item.quantity ?? 1 };
    });
  return [
    ...unrelated,
    { price: targetPlanPriceId, quantity: 1 },
    ...[...quantities].map(([price, quantity]) => {
      return { price, quantity };
    }),
  ];
}

async function loadStoredSubscriptionChange(
  db: Pick<Db, "select">,
  changeId: string,
): Promise<{
  readonly root: UsagePackSubscriptionChangeRow;
  readonly allocationChanges: readonly UsagePackAllocationChangeRow[];
  readonly subscription: UsagePackSubscriptionRow;
  readonly allocations: readonly UsagePackAllocationRow[];
} | null> {
  const [root] = await db
    .select()
    .from(usagePackSubscriptionChanges)
    .where(eq(usagePackSubscriptionChanges.id, changeId))
    .limit(1);
  if (!root) {
    return null;
  }
  const [allocationChanges, subscriptions, allocations] = await Promise.all([
    db
      .select()
      .from(usagePackAllocationChanges)
      .where(eq(usagePackAllocationChanges.subscriptionChangeId, root.id)),
    db
      .select()
      .from(usagePackSubscriptions)
      .where(eq(usagePackSubscriptions.id, root.usagePackSubscriptionId))
      .limit(1),
    db
      .select()
      .from(usagePackAllocations)
      .where(
        eq(
          usagePackAllocations.usagePackSubscriptionId,
          root.usagePackSubscriptionId,
        ),
      ),
  ]);
  const subscription = subscriptions[0];
  if (!subscription) {
    throw new Error(`Subscription change ${root.id} lost its subscription`);
  }
  return { root, allocationChanges, subscription, allocations };
}

const storedSubscriptionChange$ = command(
  async (
    { set },
    changeId: string,
    signal: AbortSignal,
  ): Promise<StoredSubscriptionChange | null> => {
    const db = set(writeDb$);
    const [root] = await db
      .select()
      .from(usagePackSubscriptionChanges)
      .where(eq(usagePackSubscriptionChanges.id, changeId))
      .limit(1);
    signal.throwIfAborted();
    if (!root) {
      return null;
    }
    const [allocationChanges, subscriptions, allocations] = await Promise.all([
      db
        .select()
        .from(usagePackAllocationChanges)
        .where(eq(usagePackAllocationChanges.subscriptionChangeId, root.id)),
      db
        .select()
        .from(usagePackSubscriptions)
        .where(eq(usagePackSubscriptions.id, root.usagePackSubscriptionId))
        .limit(1),
      db
        .select()
        .from(usagePackAllocations)
        .where(
          eq(
            usagePackAllocations.usagePackSubscriptionId,
            root.usagePackSubscriptionId,
          ),
        ),
    ]);
    signal.throwIfAborted();
    const subscription = subscriptions[0];
    if (!subscription) {
      throw new Error(`Subscription change ${root.id} lost its subscription`);
    }
    return { root, allocationChanges, subscription, allocations };
  },
);

function storedSubscriptionChangeMatchesRequest(
  stored: NonNullable<Awaited<ReturnType<typeof loadStoredSubscriptionChange>>>,
  args: {
    readonly targetTier: UsagePackTier;
    readonly memberUsagePacks: readonly MemberUsagePack[];
  },
): boolean {
  if (stored.root.targetTier !== args.targetTier) {
    return false;
  }
  const targetUsagePackByMember = new Map(
    activeMemberAllocations(stored.allocations).map((allocation) => {
      if (!allocation.userId) {
        throw new Error("Active usage pack allocation has no member");
      }
      return [allocation.userId, allocation.usagePackUsd] as const;
    }),
  );
  for (const change of stored.allocationChanges) {
    if (change.kind === "removal") {
      targetUsagePackByMember.delete(change.userId);
      continue;
    }
    if (change.targetUsagePackUsd === null) {
      throw new Error(`Subscription change ${change.id} has no target package`);
    }
    targetUsagePackByMember.set(change.userId, change.targetUsagePackUsd);
  }
  const paidSelections = args.memberUsagePacks.filter((selection) => {
    return selection.usagePackUsd !== 0;
  });
  return (
    targetUsagePackByMember.size === paidSelections.length &&
    paidSelections.every((selection) => {
      return (
        targetUsagePackByMember.get(selection.memberId) ===
        selection.usagePackUsd
      );
    })
  );
}

function storedSubscriptionChangePreview(
  root: UsagePackSubscriptionChangeRow,
): UsagePackSubscriptionChangePreviewResponse {
  return {
    changeId: root.id,
    sourceTier: root.sourceTier,
    targetTier: root.targetTier,
    immediateAmountCents: root.immediateAmountCents,
    nextRecurringAmountCents: root.nextRecurringAmountCents,
    currency: root.currency,
    effectiveAt: root.effectiveAt.toISOString(),
    prorationDate: new Date(root.prorationTimestamp * 1000).toISOString(),
    expiresAt: (
      root.stripePendingUpdateExpiresAt ?? root.previewExpiresAt
    ).toISOString(),
  };
}

async function persistDeferredSubscriptionChangeSchedule(
  db: Db,
  stored: NonNullable<Awaited<ReturnType<typeof loadStoredSubscriptionChange>>>,
  scheduleId: string,
  effectiveAt: Date,
): Promise<void> {
  const updatedAt = nowDate();
  const allocationReplacementScheduleId = replacementScheduleId(
    stored.allocationChanges,
  );
  const hasDeferredChanges =
    planIsDowngrade(stored.root.sourceTier, stored.root.targetTier) ||
    stored.allocationChanges.some((change) => {
      return change.kind === "downgrade" || change.kind === "removal";
    });
  await db.transaction(async (tx) => {
    await lockUsagePackBillingOrg(tx, stored.root.orgId);
    const [root] = await tx
      .select()
      .from(usagePackSubscriptionChanges)
      .where(eq(usagePackSubscriptionChanges.id, stored.root.id))
      .limit(1);
    if (!root || root.status === "failed") {
      throw new Error("Deferred subscription change is no longer applicable");
    }
    if (root.status === "completed") {
      return;
    }
    const planReplacementScheduleId = await pendingPlanReplacementScheduleId(
      tx,
      stored.root,
    );
    const unrecordedReplacementScheduleId =
      stored.allocationChanges.length === 0
        ? restorableScheduleId(
            await scheduledAllocationChanges(tx, stored.subscription.id),
          )
        : null;
    if (
      allocationReplacementScheduleId &&
      planReplacementScheduleId &&
      allocationReplacementScheduleId !== planReplacementScheduleId
    ) {
      throw new Error(
        "Usage pack replacement has inconsistent Stripe schedules",
      );
    }
    const supersededScheduleId =
      allocationReplacementScheduleId ??
      planReplacementScheduleId ??
      unrecordedReplacementScheduleId;
    if (supersededScheduleId) {
      await tx
        .update(usagePackAllocationChanges)
        .set({
          status: "failed",
          failureReason: "scheduled_change_superseded",
          completedAt: updatedAt,
          updatedAt,
        })
        .where(
          and(
            eq(
              usagePackAllocationChanges.usagePackSubscriptionId,
              stored.subscription.id,
            ),
            eq(usagePackAllocationChanges.status, "scheduled"),
            eq(
              usagePackAllocationChanges.stripeScheduleId,
              supersededScheduleId,
            ),
          ),
        );
    }
    await tx
      .update(usagePackAllocationChanges)
      .set({
        status: "scheduled",
        stripeScheduleId: scheduleId,
        effectiveAt,
        updatedAt,
      })
      .where(
        and(
          eq(usagePackAllocationChanges.subscriptionChangeId, stored.root.id),
          inArray(usagePackAllocationChanges.kind, ["downgrade", "removal"]),
          inArray(usagePackAllocationChanges.status, [
            "applying",
            "pending_payment",
          ]),
        ),
      );
    await tx
      .update(usagePackSubscriptionChanges)
      .set({
        status: "completed",
        effectiveAt: hasDeferredChanges ? effectiveAt : root.effectiveAt,
        completedAt: updatedAt,
        updatedAt,
      })
      .where(eq(usagePackSubscriptionChanges.id, stored.root.id));
    if (planIsDowngrade(stored.root.sourceTier, stored.root.targetTier)) {
      await tx
        .update(orgMetadata)
        .set({
          cancelAtPeriodEnd: false,
          pendingSubscriptionScheduleId: scheduleId,
          pendingSubscriptionTargetTier: stored.root.targetTier,
          pendingSubscriptionChangeAt: effectiveAt,
          currentPeriodEnd: effectiveAt,
          updatedAt,
        })
        .where(eq(orgMetadata.orgId, stored.root.orgId));
    }
  });
}

async function storeDeferredScheduleRequest(
  db: Db,
  stored: StoredSubscriptionChange,
  request: UsagePackDeferredSchedule,
): Promise<UsagePackSubscriptionChangeRow> {
  return await db.transaction(async (tx) => {
    await lockUsagePackBillingOrg(tx, stored.root.orgId);
    const [root] = await tx
      .select()
      .from(usagePackSubscriptionChanges)
      .where(eq(usagePackSubscriptionChanges.id, stored.root.id))
      .limit(1);
    if (!root || root.status === "failed") {
      throw new Error("Deferred subscription change is no longer applicable");
    }
    if (root.status === "completed" || root.deferredSchedule) {
      return root;
    }
    const [updated] = await tx
      .update(usagePackSubscriptionChanges)
      .set({ deferredSchedule: request })
      .where(eq(usagePackSubscriptionChanges.id, root.id))
      .returning();
    if (!updated) {
      throw new Error("Deferred subscription change disappeared");
    }
    return updated;
  });
}

async function completeDeferredScheduleRequest(
  db: Db,
  stored: StoredSubscriptionChange,
  request: UsagePackDeferredSchedule,
  schedule: StripeSubscriptionSchedule | null,
  signal: AbortSignal | undefined,
): Promise<Date> {
  // A replay after an unknown Stripe result can finish the local transaction
  // from current provider state without resubmitting the schedule update.
  if (!schedule || !deferredScheduleMatchesRequest(schedule, request)) {
    if (request.effectiveAt <= Math.floor(nowDate().getTime() / 1000)) {
      throw new Error(
        "Deferred subscription change passed its billing boundary",
      );
    }
    await getStripeClient().subscriptionSchedules.update(
      request.scheduleId,
      request.params,
      {
        idempotencyKey: `usage-pack-subscription-change:${stored.root.id}:schedule-update`,
      },
    );
    signal?.throwIfAborted();
  }
  const effectiveAt = new Date(request.effectiveAt * 1000);
  await persistDeferredSubscriptionChangeSchedule(
    db,
    stored,
    request.scheduleId,
    effectiveAt,
  );
  return effectiveAt;
}

function deferredSubscriptionChangeTarget(
  stored: StoredSubscriptionChange,
  periodEnd: number,
): {
  readonly targetPlanPriceId: string;
  readonly quantities: ReadonlyMap<string, number>;
  readonly effectiveAt: number;
} {
  const targetPlanPriceId =
    stored.root.sourceTier === stored.root.targetTier
      ? stored.subscription.stripePlanPriceId
      : activeUsagePackPlanPriceId(stored.root.targetTier);
  if (!targetPlanPriceId) {
    throw new Error(
      `${stored.root.targetTier} usage pack plan Price is not configured`,
    );
  }
  const quantities = projectedPackageQuantities(
    stored.allocations,
    stored.allocationChanges,
    () => {
      return true;
    },
  );
  // Deferred allocation dates are immutable preview intent. In a mixed change
  // the root's effectiveAt may instead describe the immediate upgrade.
  const deferredAllocation = stored.allocationChanges.find((change) => {
    return change.kind === "downgrade" || change.kind === "removal";
  });
  const effectiveAt = Math.floor(
    (
      deferredAllocation?.effectiveAt ??
      (planIsDowngrade(stored.root.sourceTier, stored.root.targetTier)
        ? stored.root.effectiveAt
        : new Date(periodEnd * 1000))
    ).getTime() / 1000,
  );
  return { targetPlanPriceId, quantities, effectiveAt };
}

async function scheduleDeferredSubscriptionChange(
  db: Db,
  original: StoredSubscriptionChange,
  subscription: StripeSubscription,
  signal: AbortSignal | undefined,
): Promise<Date> {
  const stored = await loadStoredSubscriptionChange(db, original.root.id);
  if (!stored || stored.root.status === "failed") {
    throw new Error("Deferred subscription change is no longer applicable");
  }
  if (stored.root.status === "completed") {
    return stored.root.effectiveAt;
  }
  const period = usagePackPeriod(subscription);
  const stripe = getStripeClient();
  const existingScheduleId = stripeObjectId(subscription.schedule);
  if (
    stored.root.deferredSchedule &&
    existingScheduleId !== stored.root.deferredSchedule.scheduleId
  ) {
    throw new Error("Deferred subscription schedule is no longer attached");
  }
  const existingSchedule = existingScheduleId
    ? await stripe.subscriptionSchedules.retrieve(existingScheduleId)
    : null;
  signal?.throwIfAborted();
  if (stored.root.deferredSchedule) {
    return await completeDeferredScheduleRequest(
      db,
      stored,
      stored.root.deferredSchedule,
      existingSchedule,
      signal,
    );
  }
  const { targetPlanPriceId, quantities, effectiveAt } =
    deferredSubscriptionChangeTarget(stored, period.end);
  if (
    !existingSchedule &&
    effectiveAt <= Math.floor(nowDate().getTime() / 1000)
  ) {
    throw new Error("Deferred subscription change passed its billing boundary");
  }
  const createdSchedule = existingScheduleId
    ? null
    : await stripe.subscriptionSchedules.create(
        { from_subscription: subscription.id },
        {
          idempotencyKey: `usage-pack-subscription-change:${stored.root.id}:schedule-create`,
        },
      );
  signal?.throwIfAborted();
  const scheduleId = existingScheduleId ?? createdSchedule?.id;
  if (!scheduleId) {
    throw new Error("Stripe did not return a subscription schedule ID");
  }
  const scheduleParams = existingSchedule
    ? deferredUsagePackChangeScheduleParams({
        subscription,
        schedule: existingSchedule,
        effectiveAt,
        currentPlanPriceId: subscriptionPlanItem(subscription).price.id,
        currentQuantities: packageQuantitiesFromSubscription(subscription),
        targetPlanPriceId,
        quantities,
      })
    : newUsagePackChangeScheduleParams({
        subscription,
        period: { start: period.start, end: effectiveAt },
        targetPlanPriceId,
        quantities,
      });
  const root = await storeDeferredScheduleRequest(db, stored, {
    scheduleId,
    effectiveAt,
    params: scheduleParams,
  });
  signal?.throwIfAborted();
  if (root.status === "completed") {
    return root.effectiveAt;
  }
  if (!root.deferredSchedule) {
    throw new Error(
      "Deferred subscription change has no stored Stripe request",
    );
  }
  return await completeDeferredScheduleRequest(
    db,
    stored,
    root.deferredSchedule,
    existingSchedule,
    signal,
  );
}

function expandedLatestInvoice(
  subscription: StripeSubscription,
): StripeInvoice | null {
  return subscription.latest_invoice &&
    typeof subscription.latest_invoice !== "string"
    ? subscription.latest_invoice
    : null;
}

const markPreparedChangeApplying$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly changeId: string;
      readonly subscriptionId: string;
    },
    signal: AbortSignal,
  ): Promise<UsagePackSubscriptionChangeRow | null> => {
    const db = set(writeDb$);
    const result = await db.transaction(async (tx) => {
      await tx.execute(usagePackBillingCompatibilityLockSql(args.orgId));
      const [subscription] = await tx
        .select({ id: usagePackSubscriptions.id })
        .from(usagePackSubscriptions)
        .where(
          and(
            eq(usagePackSubscriptions.id, args.subscriptionId),
            eq(usagePackSubscriptions.orgId, args.orgId),
          ),
        )
        .for("update")
        .limit(1);
      if (!subscription) {
        return null;
      }
      const [root] = await tx
        .select()
        .from(usagePackSubscriptionChanges)
        .where(
          and(
            eq(usagePackSubscriptionChanges.id, args.changeId),
            eq(usagePackSubscriptionChanges.orgId, args.orgId),
            eq(
              usagePackSubscriptionChanges.usagePackSubscriptionId,
              subscription.id,
            ),
          ),
        )
        .for("update")
        .limit(1);
      signal.throwIfAborted();
      if (!root || root.status !== "previewed") {
        return null;
      }
      const at = nowDate();
      if (root.previewExpiresAt <= at) {
        await tx
          .update(usagePackSubscriptionChanges)
          .set({
            status: "failed",
            failureReason: "preview_expired",
            completedAt: at,
            updatedAt: at,
          })
          .where(eq(usagePackSubscriptionChanges.id, root.id));
        await tx
          .update(usagePackAllocationChanges)
          .set({
            status: "failed",
            failureReason: "preview_expired",
            completedAt: at,
            updatedAt: at,
          })
          .where(eq(usagePackAllocationChanges.subscriptionChangeId, root.id));
        return null;
      }
      const [updated] = await tx
        .update(usagePackSubscriptionChanges)
        .set({ status: "applying", updatedAt: at })
        .where(eq(usagePackSubscriptionChanges.id, root.id))
        .returning();
      await tx
        .update(usagePackAllocationChanges)
        .set({ status: "applying", updatedAt: at })
        .where(
          and(
            eq(usagePackAllocationChanges.subscriptionChangeId, root.id),
            eq(usagePackAllocationChanges.status, "previewed"),
          ),
        );
      return updated ?? null;
    });
    signal.throwIfAborted();
    return result;
  },
);

async function failApplyingSubscriptionChange(
  db: Db,
  root: UsagePackSubscriptionChangeRow,
  failureReason: string,
): Promise<void> {
  const completedAt = nowDate();
  await db.transaction(async (tx) => {
    await lockUsagePackBillingOrg(tx, root.orgId);
    await tx
      .update(usagePackSubscriptionChanges)
      .set({
        status: "failed",
        failureReason,
        completedAt,
        updatedAt: completedAt,
      })
      .where(
        and(
          eq(usagePackSubscriptionChanges.id, root.id),
          eq(usagePackSubscriptionChanges.status, "applying"),
        ),
      );
    await tx
      .update(usagePackAllocationChanges)
      .set({
        status: "failed",
        failureReason,
        completedAt,
        updatedAt: completedAt,
      })
      .where(
        and(
          eq(usagePackAllocationChanges.subscriptionChangeId, root.id),
          eq(usagePackAllocationChanges.status, "applying"),
        ),
      );
  });
}

async function confirmationResponseForStoredChange(
  root: UsagePackSubscriptionChangeRow,
  allocationChanges: readonly UsagePackAllocationChangeRow[],
  signal: AbortSignal,
): Promise<UsagePackChangeConfirmResponse | null> {
  if (root.status === "pending_payment") {
    if (!root.stripeInvoiceId) {
      throw new Error(`Subscription change ${root.id} has no Stripe invoice`);
    }
    const invoice = await getStripeClient().invoices.retrieve(
      root.stripeInvoiceId,
    );
    signal.throwIfAborted();
    return {
      status: invoice.status === "paid" ? "processing" : "pending_payment",
      effectiveAt: root.effectiveAt.toISOString(),
      hostedInvoiceUrl: null,
    };
  }
  if (root.status === "completed") {
    return {
      status:
        planIsDowngrade(root.sourceTier, root.targetTier) ||
        allocationChanges.some((change) => {
          return change.status === "scheduled";
        })
          ? "scheduled"
          : "completed",
      effectiveAt: root.effectiveAt.toISOString(),
      hostedInvoiceUrl: null,
    };
  }
  return null;
}

type StoredSubscriptionChange = NonNullable<
  Awaited<ReturnType<typeof loadStoredSubscriptionChange>>
>;

type SubscriptionChangeConfirmationPreparation =
  | { readonly ready: true; readonly stored: StoredSubscriptionChange }
  | {
      readonly ready: false;
      readonly result: UsagePackSubscriptionChangeConfirmResult;
    };

const prepareSubscriptionChangeConfirmation$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly changeId: string;
    },
    signal: AbortSignal,
  ): Promise<SubscriptionChangeConfirmationPreparation> => {
    let stored = await set(storedSubscriptionChange$, args.changeId, signal);
    if (!stored || stored.root.orgId !== args.orgId) {
      return { ready: false, result: { status: "not_found" } };
    }
    if (stored.root.status === "failed") {
      return {
        ready: false,
        result:
          stored.root.failureReason === "preview_expired"
            ? { status: "expired" }
            : { status: "conflict" },
      };
    }
    if (stored.root.status === "applying") {
      if (!stored.subscription.stripeSubscriptionId) {
        throw new Error("Usage pack subscription disappeared during retry");
      }
      return { ready: true, stored };
    }
    const existing = await confirmationResponseForStoredChange(
      stored.root,
      stored.allocationChanges,
      signal,
    );
    if (existing) {
      return {
        ready: false,
        result: { status: "confirmed", response: existing },
      };
    }
    const applying = await set(
      markPreparedChangeApplying$,
      {
        ...args,
        subscriptionId: stored.subscription.id,
      },
      signal,
    );
    if (!applying) {
      stored = await set(storedSubscriptionChange$, args.changeId, signal);
      return {
        ready: false,
        result:
          stored?.root.failureReason === "preview_expired"
            ? { status: "expired" }
            : { status: "conflict" },
      };
    }
    stored = await set(storedSubscriptionChange$, args.changeId, signal);
    if (!stored || !stored.subscription.stripeSubscriptionId) {
      throw new Error(
        "Usage pack subscription disappeared during confirmation",
      );
    }
    return { ready: true, stored };
  },
);

function applyImmediatePackageChanges(
  packageQuantities: Map<string, number>,
  packageChanges: readonly UsagePackAllocationChangeRow[],
): void {
  for (const change of packageChanges) {
    if (!change.targetStripePriceId) {
      throw new Error(`Subscription change ${change.id} has no target Price`);
    }
    if (change.kind !== "addition") {
      if (!change.sourceStripePriceId) {
        throw new Error(`Subscription change ${change.id} has no source Price`);
      }
      const sourceQuantity = packageQuantities.get(change.sourceStripePriceId);
      if (!sourceQuantity) {
        throw new Error(
          `Subscription change ${change.id} lost its source Price`,
        );
      }
      if (sourceQuantity === 1) {
        packageQuantities.delete(change.sourceStripePriceId);
      } else {
        packageQuantities.set(change.sourceStripePriceId, sourceQuantity - 1);
      }
    }
    packageQuantities.set(
      change.targetStripePriceId,
      (packageQuantities.get(change.targetStripePriceId) ?? 0) + 1,
    );
  }
}

async function recordImmediateSubscriptionChangeInvoice(
  db: Db,
  stored: StoredSubscriptionChange,
  invoice: StripeInvoice,
  pendingUpdateExpiresAt: Date | null,
  pendingPayment: boolean,
): Promise<void> {
  const updatedAt = nowDate();
  await db.transaction(async (tx) => {
    await tx
      .update(usagePackSubscriptionChanges)
      .set({
        status: pendingPayment ? "pending_payment" : "applying",
        stripeInvoiceId: invoice.id,
        stripePendingUpdateExpiresAt: pendingUpdateExpiresAt,
        updatedAt,
      })
      .where(eq(usagePackSubscriptionChanges.id, stored.root.id));
    await tx
      .update(usagePackAllocationChanges)
      .set({
        status: pendingPayment ? "pending_payment" : "applying",
        stripePendingUpdateExpiresAt: pendingUpdateExpiresAt,
        updatedAt,
      })
      .where(
        eq(usagePackAllocationChanges.subscriptionChangeId, stored.root.id),
      );
  });
}

function subscriptionPendingUpdateExpiresAt(
  subscription: StripeSubscription,
): Date | null {
  const expiresAt = subscription.pending_update?.expires_at;
  if (expiresAt === undefined) {
    return null;
  }
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
    throw new Error("Stripe subscription pending update has an invalid expiry");
  }
  return new Date(expiresAt * 1000);
}

async function applyImmediateSubscriptionChange(
  db: Db,
  args: {
    readonly stored: StoredSubscriptionChange;
    readonly subscription: StripeSubscription;
    readonly planItem: StripeSubscriptionItem;
    readonly hasPlanUpgrade: boolean;
    readonly immediatePackageChanges: readonly UsagePackAllocationChangeRow[];
    readonly paymentMethod?: BillingPurchasePaymentMethod;
  },
  signal: AbortSignal,
): Promise<UsagePackSubscriptionChangeConfirmResult> {
  const packageQuantities = new Map(
    packageQuantitiesFromAllocations(args.stored.allocations),
  );
  applyImmediatePackageChanges(packageQuantities, args.immediatePackageChanges);
  const targetPlanPriceId = args.hasPlanUpgrade
    ? activeUsagePackPlanPriceId("team")
    : args.stored.subscription.stripePlanPriceId;
  if (!targetPlanPriceId) {
    throw new Error("Team usage pack plan Price is not configured");
  }
  const stripe = getStripeClient();
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
      items: subscriptionUpdateItems(
        args.subscription,
        args.planItem,
        targetPlanPriceId,
        packageQuantities,
      ),
      payment_behavior: "pending_if_incomplete",
      proration_behavior: "always_invoice",
      proration_date: args.stored.root.prorationTimestamp,
      expand: ["latest_invoice.payment_intent"],
    },
    {
      idempotencyKey: `usage-pack-subscription-change:${args.stored.root.id}:apply`,
    },
  );
  signal.throwIfAborted();
  const invoice = expandedLatestInvoice(updatedSubscription);
  if (!invoice) {
    throw new Error("Stripe did not create a subscription change invoice");
  }
  const pendingUpdateExpiresAt =
    subscriptionPendingUpdateExpiresAt(updatedSubscription);
  const payment = await completeBillingOperationInvoice(
    stripe,
    invoice,
    `usage-pack-subscription:${args.stored.root.id}`,
    signal,
  );
  const pending = payment.status === "pending_payment";
  await recordImmediateSubscriptionChangeInvoice(
    db,
    args.stored,
    invoice,
    pendingUpdateExpiresAt,
    pending,
  );
  return {
    status: "confirmed",
    response: {
      status: pending ? "pending_payment" : "processing",
      effectiveAt: args.stored.root.effectiveAt.toISOString(),
      hostedInvoiceUrl:
        payment.status === "pending_payment" ? payment.hostedInvoiceUrl : null,
    },
  };
}

function isScheduledSubscriptionRestore(
  stored: StoredSubscriptionChange,
): boolean {
  return (
    stored.root.sourceTier === stored.root.targetTier &&
    stored.allocationChanges.length === 0
  );
}

function schedulePhaseDiscounts(
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

function schedulePhaseItem(
  item: NonNullable<StripeSchedulePhase["items"]>[number],
): StripeSchedulePhaseItemParam {
  const price = stripeObjectId(item.price);
  const quantity = item.quantity ?? 1;
  if (!price || !Number.isSafeInteger(quantity) || quantity < 1) {
    throw new Error("Stripe subscription schedule phase has invalid items");
  }
  const discounts = schedulePhaseDiscounts(item.discounts ?? []);
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
      ? { metadata: retireMarketingMetadata(item.metadata) }
      : {}),
    ...(taxRates.length > 0 ? { tax_rates: taxRates } : {}),
  };
}

function isUsagePackSchedulePrice(priceId: string): boolean {
  return (
    isUsagePackPlanPriceId(priceId) ||
    usagePackUsdForKnownPriceId(priceId) !== null
  );
}

function usagePackQuantityEntries(
  items: readonly { readonly priceId: string; readonly quantity: number }[],
): readonly (readonly [string, number])[] | null {
  const quantities = new Map<string, number>();
  for (const item of items) {
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) {
      return null;
    }
    if (isUsagePackSchedulePrice(item.priceId)) {
      quantities.set(
        item.priceId,
        (quantities.get(item.priceId) ?? 0) + item.quantity,
      );
    }
  }
  return [...quantities].sort(([left], [right]) => {
    return left.localeCompare(right);
  });
}

function subscriptionUsagePackQuantityEntries(
  subscription: StripeSubscription,
): readonly (readonly [string, number])[] | null {
  return usagePackQuantityEntries(
    subscription.items.data.map((item) => {
      return { priceId: item.price.id, quantity: item.quantity ?? 1 };
    }),
  );
}

function schedulePhaseUsagePackQuantityEntries(
  phase: StripeSchedulePhase,
): readonly (readonly [string, number])[] | null {
  if (!phase.items) {
    return null;
  }
  const items = phase.items.flatMap((item) => {
    const priceId = stripeObjectId(item.price);
    return priceId ? [{ priceId, quantity: item.quantity ?? 1 }] : [];
  });
  return items.length === phase.items.length
    ? usagePackQuantityEntries(items)
    : null;
}

function usagePackQuantityEntriesMatch(
  left: readonly (readonly [string, number])[],
  right: readonly (readonly [string, number])[],
): boolean {
  return (
    left.length === right.length &&
    left.every(([priceId, quantity], index) => {
      const expected = right[index];
      return expected?.[0] === priceId && expected[1] === quantity;
    })
  );
}

function subscriptionSchedulePreservesUsagePackConfiguration(
  subscription: StripeSubscription,
  schedule: StripeSubscriptionSchedule,
): boolean {
  const currentPhase = schedule.current_phase;
  const expected = subscriptionUsagePackQuantityEntries(subscription);
  if (schedule.end_behavior !== "release" || !currentPhase || !expected) {
    return false;
  }
  const currentPhaseIndex = schedule.phases.findIndex((phase) => {
    return (
      phase.start_date === currentPhase.start_date &&
      phase.end_date === currentPhase.end_date
    );
  });
  if (currentPhaseIndex === -1) {
    return false;
  }
  let expectedStart = currentPhase.start_date;
  return schedule.phases.slice(currentPhaseIndex).every((phase) => {
    const actual = schedulePhaseUsagePackQuantityEntries(phase);
    const valid =
      phase.start_date === expectedStart &&
      phase.end_date > phase.start_date &&
      (phase.add_invoice_items?.length ?? 0) === 0 &&
      actual !== null &&
      usagePackQuantityEntriesMatch(actual, expected);
    expectedStart = phase.end_date;
    return valid;
  });
}

function schedulePhaseParamWithItems(
  phase: StripeSchedulePhase,
  args: {
    readonly startDate?: number;
    readonly endDate?: number;
    readonly duration?: StripePriceRecurring;
    readonly items: readonly StripeSchedulePhaseItemParam[];
    readonly metadataOverlay: Readonly<Record<string, string>> | null;
  },
): StripeSchedulePhaseParam {
  if (
    (args.endDate === undefined) === (args.duration === undefined) ||
    (args.endDate !== undefined &&
      args.endDate <= (args.startDate ?? phase.start_date))
  ) {
    throw new Error("Stripe subscription schedule has an invalid phase");
  }
  const discounts = schedulePhaseDiscounts(phase.discounts ?? []);
  const metadata = args.metadataOverlay
    ? { ...phase.metadata, ...args.metadataOverlay }
    : phase.metadata;
  return {
    start_date: args.startDate ?? phase.start_date,
    ...(args.endDate === undefined
      ? { duration: args.duration }
      : { end_date: args.endDate }),
    ...(phase.currency ? { currency: phase.currency } : {}),
    items: [...args.items],
    ...(metadata ? { metadata: retireMarketingMetadata(metadata) } : {}),
    proration_behavior: phase.proration_behavior ?? "none",
    ...(discounts.length > 0 ? { discounts } : {}),
  };
}

function copiedSchedulePhaseItems(
  phase: StripeSchedulePhase,
): readonly StripeSchedulePhaseItemParam[] {
  if (!phase.items) {
    throw new Error("Stripe subscription schedule phase has no items");
  }
  return phase.items.map(schedulePhaseItem);
}

function usagePackScheduleItems(
  phase: StripeSchedulePhase,
  targetPlanPriceId: string,
  quantities: ReadonlyMap<string, number>,
): readonly StripeSchedulePhaseItemParam[] {
  if (!phase.items) {
    throw new Error("Stripe subscription schedule phase has no items");
  }
  const existingUsagePackItems = new Map(
    phase.items.flatMap((item) => {
      const priceId = stripeObjectId(item.price);
      return priceId && isUsagePackSchedulePrice(priceId)
        ? [[priceId, item] as const]
        : [];
    }),
  );
  const unrelatedItems = phase.items.flatMap((item) => {
    const priceId = stripeObjectId(item.price);
    if (!priceId) {
      throw new Error("Stripe subscription schedule phase has invalid items");
    }
    return isUsagePackSchedulePrice(priceId) ? [] : [schedulePhaseItem(item)];
  });
  const targets = [
    [targetPlanPriceId, 1] as const,
    ...[...quantities].map(([priceId, quantity]) => {
      return [priceId, quantity] as const;
    }),
  ];
  return [
    ...unrelatedItems,
    ...targets.map(([price, quantity]) => {
      const existing = existingUsagePackItems.get(price);
      return {
        ...(existing ? schedulePhaseItem(existing) : {}),
        price,
        quantity,
      };
    }),
  ];
}

function currentUsagePackScheduleItems(
  phase: StripeSchedulePhase,
  planPriceId: string,
  quantities: ReadonlyMap<string, number>,
): readonly StripeSchedulePhaseItemParam[] {
  const actual = schedulePhaseUsagePackQuantityEntries(phase);
  const expected = usagePackQuantityEntries([
    { priceId: planPriceId, quantity: 1 },
    ...[...quantities].map(([priceId, quantity]) => {
      return { priceId, quantity };
    }),
  ]);
  return actual && expected && usagePackQuantityEntriesMatch(actual, expected)
    ? copiedSchedulePhaseItems(phase)
    : usagePackScheduleItems(phase, planPriceId, quantities);
}

function deferredUsagePackChangeScheduleParams(args: {
  readonly subscription: StripeSubscription;
  readonly schedule: StripeSubscriptionSchedule;
  readonly effectiveAt: number;
  readonly currentPlanPriceId: string;
  readonly currentQuantities: ReadonlyMap<string, number>;
  readonly targetPlanPriceId: string;
  readonly quantities: ReadonlyMap<string, number>;
}): NonNullable<StripeInvoiceCreatePreviewParams["schedule_details"]> {
  if (args.schedule.end_behavior !== "release") {
    throw new Error("Stripe subscription schedule cannot change usage packs");
  }
  const phases = currentAndFutureSchedulePhases(args.schedule);
  const firstPhase = phases[0];
  const finalPhase = phases[phases.length - 1];
  if (!firstPhase || !finalPhase || args.effectiveAt <= firstPhase.start_date) {
    throw new Error("Stripe subscription schedule cannot change usage packs");
  }
  const metadataOverlay = canceledUsageAllowanceScheduleMetadata(
    args.subscription,
  );
  const updatedPhases = phases.flatMap((phase) => {
    // Stripe may keep the old phase items after a direct subscription update.
    // Rebuild every pre-boundary phase from the paid current configuration so
    // updating the schedule cannot undo an immediate upgrade.
    const currentItems = currentUsagePackScheduleItems(
      phase,
      args.currentPlanPriceId,
      args.currentQuantities,
    );
    if (phase.end_date <= args.effectiveAt) {
      return [
        schedulePhaseParamWithItems(phase, {
          endDate: phase.end_date,
          items: currentItems,
          metadataOverlay,
        }),
      ];
    }
    const targetItems = usagePackScheduleItems(
      phase,
      args.targetPlanPriceId,
      args.quantities,
    );
    if (phase.start_date >= args.effectiveAt) {
      return [
        schedulePhaseParamWithItems(phase, {
          endDate: phase.end_date,
          items: targetItems,
          metadataOverlay,
        }),
      ];
    }
    return [
      schedulePhaseParamWithItems(phase, {
        endDate: args.effectiveAt,
        items: currentItems,
        metadataOverlay,
      }),
      schedulePhaseParamWithItems(phase, {
        startDate: args.effectiveAt,
        endDate: phase.end_date,
        items: targetItems,
        metadataOverlay,
      }),
    ];
  });
  if (args.effectiveAt > finalPhase.end_date) {
    updatedPhases.push(
      schedulePhaseParamWithItems(finalPhase, {
        startDate: finalPhase.end_date,
        endDate: args.effectiveAt,
        items: currentUsagePackScheduleItems(
          finalPhase,
          args.currentPlanPriceId,
          args.currentQuantities,
        ),
        metadataOverlay,
      }),
    );
  }
  if (args.effectiveAt >= finalPhase.end_date) {
    updatedPhases.push(
      schedulePhaseParamWithItems(finalPhase, {
        startDate: args.effectiveAt,
        duration: subscriptionRecurringDuration(args.subscription),
        items: usagePackScheduleItems(
          finalPhase,
          args.targetPlanPriceId,
          args.quantities,
        ),
        metadataOverlay,
      }),
    );
  }
  return {
    end_behavior: "release",
    proration_behavior: "none",
    phases: updatedPhases,
  };
}

function currentAndFutureSchedulePhases(
  schedule: StripeSubscriptionSchedule,
): readonly StripeSchedulePhase[] {
  const currentPhase = schedule.current_phase;
  if (!currentPhase) {
    throw new Error("Stripe subscription schedule has no current phase");
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
    throw new Error("Stripe subscription schedule cannot be safely restored");
  }
  return phases;
}

function restoredUsagePackScheduleParams(
  subscription: StripeSubscription,
  schedule: StripeSubscriptionSchedule,
): StripeSubscriptionScheduleUpdateParams {
  if (
    schedule.end_behavior !== "cancel" &&
    schedule.end_behavior !== "release"
  ) {
    throw new Error("Stripe subscription schedule cannot be safely restored");
  }
  const phases = currentAndFutureSchedulePhases(schedule);
  const currentItems = phases[0]?.items;
  if (!currentItems) {
    throw new Error("Stripe subscription schedule has no current items");
  }
  const currentPackageItems = new Map(
    currentItems.flatMap((item) => {
      const priceId = stripeObjectId(item.price);
      return priceId && usagePackUsdForKnownPriceId(priceId) !== null
        ? [[priceId, item] as const]
        : [];
    }),
  );
  const activePackageItems = subscription.items.data.flatMap((item) => {
    if (usagePackUsdForKnownPriceId(item.price.id) === null) {
      return [];
    }
    const currentItem = currentPackageItems.get(item.price.id);
    return [
      {
        ...(currentItem ? schedulePhaseItem(currentItem) : {}),
        price: item.price.id,
        quantity: item.quantity ?? 1,
      },
    ];
  });
  const metadataOverlay = canceledUsageAllowanceScheduleMetadata(subscription);
  return {
    end_behavior: schedule.end_behavior,
    proration_behavior: "none",
    phases: phases.map((phase) => {
      if (!phase.items) {
        throw new Error("Stripe subscription schedule phase has no items");
      }
      const discounts = schedulePhaseDiscounts(phase.discounts ?? []);
      return {
        start_date: phase.start_date,
        end_date: phase.end_date,
        ...(phase.currency ? { currency: phase.currency } : {}),
        items: [
          ...phase.items.flatMap((item) => {
            const priceId = stripeObjectId(item.price);
            return priceId && usagePackUsdForKnownPriceId(priceId) !== null
              ? []
              : [schedulePhaseItem(item)];
          }),
          ...activePackageItems,
        ],
        ...(phase.metadata || metadataOverlay
          ? {
              metadata: retireMarketingMetadata({
                ...phase.metadata,
                ...metadataOverlay,
              }),
            }
          : {}),
        proration_behavior: phase.proration_behavior ?? "none",
        ...(discounts.length > 0 ? { discounts } : {}),
      };
    }),
  };
}

async function restoreScheduledSubscriptionChange(
  db: Db,
  stored: StoredSubscriptionChange,
  subscription: StripeSubscription,
  signal: AbortSignal,
): Promise<UsagePackSubscriptionChangeConfirmResult> {
  const scheduledChanges = await scheduledAllocationChanges(
    db,
    stored.subscription.id,
  );
  signal.throwIfAborted();
  const scheduleId = restorableScheduleId(scheduledChanges);
  const stripeScheduleId = stripeObjectId(subscription.schedule);
  if (
    !scheduleId ||
    (stripeScheduleId !== null && stripeScheduleId !== scheduleId)
  ) {
    await failApplyingSubscriptionChange(
      db,
      stored.root,
      "scheduled_restore_conflict",
    );
    return { status: "conflict" };
  }
  if (stripeScheduleId === scheduleId) {
    const stripe = getStripeClient();
    const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId);
    signal.throwIfAborted();
    await stripe.subscriptionSchedules.update(
      scheduleId,
      restoredUsagePackScheduleParams(subscription, schedule),
      {
        idempotencyKey: `usage-pack-subscription-change:${stored.root.id}:restore-schedule`,
      },
    );
    signal.throwIfAborted();
  }
  const completedAt = nowDate();
  await db.transaction(async (tx) => {
    await lockUsagePackBillingOrg(tx, stored.root.orgId);
    await failScheduledUsagePackAllocationChangesForSchedule(tx, {
      scheduleId,
      completedAt,
    });
    await tx
      .update(usagePackSubscriptionChanges)
      .set({
        status: "completed",
        effectiveAt: completedAt,
        completedAt,
        updatedAt: completedAt,
      })
      .where(
        and(
          eq(usagePackSubscriptionChanges.id, stored.root.id),
          eq(usagePackSubscriptionChanges.status, "applying"),
        ),
      );
  });
  return {
    status: "confirmed",
    response: {
      status: "completed",
      effectiveAt: completedAt.toISOString(),
      hostedInvoiceUrl: null,
    },
  };
}

async function prepareApplicableSubscription(
  args: {
    readonly db: Db;
    readonly stored: StoredSubscriptionChange;
    readonly subscription: StripeSubscription;
    readonly supersededScheduleId: string | null;
    readonly hasImmediateChanges: boolean;
  },
  signal: AbortSignal,
): Promise<
  | { readonly status: "ready"; readonly subscription: StripeSubscription }
  | { readonly status: "conflict" }
> {
  const attachedScheduleId = stripeObjectId(args.subscription.schedule);
  if (args.supersededScheduleId || !attachedScheduleId) {
    return { status: "ready", subscription: args.subscription };
  }
  const stripe = getStripeClient();
  const schedule =
    await stripe.subscriptionSchedules.retrieve(attachedScheduleId);
  signal.throwIfAborted();
  const neutralSchedule = subscriptionScheduleHasNoFutureChanges(
    args.subscription,
    schedule,
  );
  if (
    !neutralSchedule &&
    (args.hasImmediateChanges ||
      !subscriptionSchedulePreservesUsagePackConfiguration(
        args.subscription,
        schedule,
      ))
  ) {
    await failApplyingSubscriptionChange(
      args.db,
      args.stored.root,
      "unexpected_schedule_conflict",
    );
    return { status: "conflict" };
  }
  if (!args.hasImmediateChanges) {
    return { status: "ready", subscription: args.subscription };
  }
  await stripe.subscriptionSchedules.release(attachedScheduleId);
  signal.throwIfAborted();
  return {
    status: "ready",
    subscription: { ...args.subscription, schedule: null },
  };
}

type ReplacementScheduleResolution =
  | { readonly status: "ready"; readonly scheduleId: string | null }
  | { readonly status: "conflict" };

async function resolveReplacementSchedule(
  db: Db,
  stored: StoredSubscriptionChange,
  subscription: StripeSubscription,
  signal: AbortSignal,
): Promise<ReplacementScheduleResolution> {
  const allocationScheduleId = replacementScheduleId(stored.allocationChanges);
  const planScheduleId = await pendingPlanReplacementScheduleId(
    db,
    stored.root,
  );
  signal.throwIfAborted();
  if (
    allocationScheduleId &&
    planScheduleId &&
    allocationScheduleId !== planScheduleId
  ) {
    await failApplyingSubscriptionChange(
      db,
      stored.root,
      "scheduled_replacement_conflict",
    );
    return { status: "conflict" };
  }
  const scheduledChanges = await db
    .select()
    .from(usagePackAllocationChanges)
    .where(
      and(
        eq(
          usagePackAllocationChanges.usagePackSubscriptionId,
          stored.subscription.id,
        ),
        eq(usagePackAllocationChanges.status, "scheduled"),
      ),
    );
  signal.throwIfAborted();
  const scheduledPackageScheduleId = restorableScheduleId(scheduledChanges);
  // A plan-only upgrade has no allocation-change row to carry the schedule ID.
  const scheduleId =
    allocationScheduleId ??
    planScheduleId ??
    (stored.allocationChanges.length === 0 ? scheduledPackageScheduleId : null);
  if (!scheduleId) {
    return { status: "ready", scheduleId: null };
  }
  const ownsPlanSchedule = planScheduleId === scheduleId;
  const ownsPackageSchedule = scheduledPackageScheduleId === scheduleId;
  if (
    stripeObjectId(subscription.schedule) !== scheduleId ||
    (!ownsPlanSchedule && !ownsPackageSchedule)
  ) {
    await failApplyingSubscriptionChange(
      db,
      stored.root,
      "scheduled_replacement_conflict",
    );
    return { status: "conflict" };
  }
  return { status: "ready", scheduleId };
}

async function applyStoredSubscriptionChange(
  db: Db,
  stored: StoredSubscriptionChange,
  paymentMethod: BillingPurchasePaymentMethod | undefined,
  signal: AbortSignal,
): Promise<UsagePackSubscriptionChangeConfirmResult> {
  const subscriptionId = stored.subscription.stripeSubscriptionId;
  if (!subscriptionId) {
    throw new Error("Usage pack subscription has no Stripe subscription ID");
  }
  const stripe = getStripeClient();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ["latest_invoice"],
  });
  signal.throwIfAborted();
  if (subscription.pending_update) {
    await failApplyingSubscriptionChange(
      db,
      stored.root,
      "stripe_pending_update_conflict",
    );
    return { status: "conflict" };
  }
  const context: UsagePackSubscriptionChangeContext = {
    subscription: stored.subscription,
    allocations: stored.allocations,
    openAllocationChanges: [],
    openSubscriptionChanges: [],
    pendingPlanScheduleId: null,
    pendingPlanTargetTier: null,
  };
  const planItem = validateStripeSubscription(context, subscription);
  if (isScheduledSubscriptionRestore(stored)) {
    return await restoreScheduledSubscriptionChange(
      db,
      stored,
      subscription,
      signal,
    );
  }
  const replacementSchedule = await resolveReplacementSchedule(
    db,
    stored,
    subscription,
    signal,
  );
  if (replacementSchedule.status === "conflict") {
    return replacementSchedule;
  }
  const supersededScheduleId = replacementSchedule.scheduleId;
  const hasPlanUpgrade = planIsUpgrade(
    stored.root.sourceTier,
    stored.root.targetTier,
  );
  const immediatePackageChanges = stored.allocationChanges.filter((change) => {
    return change.kind === "addition" || change.kind === "upgrade";
  });
  const hasImmediateChanges =
    hasPlanUpgrade || immediatePackageChanges.length > 0;
  const hasScheduledChanges =
    planIsDowngrade(stored.root.sourceTier, stored.root.targetTier) ||
    stored.allocationChanges.some((change) => {
      return change.kind === "downgrade" || change.kind === "removal";
    });
  if (hasScheduledChanges && stripeSubscriptionWillEnd(subscription)) {
    await failApplyingSubscriptionChange(
      db,
      stored.root,
      "subscription_ending_conflict",
    );
    return { status: "plan_ending" };
  }
  const applicable = await prepareApplicableSubscription(
    {
      db,
      stored,
      subscription,
      supersededScheduleId,
      hasImmediateChanges,
    },
    signal,
  );
  if (applicable.status === "conflict") {
    return applicable;
  }
  const applicableSubscription = applicable.subscription;
  if (!hasImmediateChanges) {
    if (!hasScheduledChanges) {
      throw new Error("Stored usage pack subscription change has no changes");
    }
    const effectiveAt = await scheduleDeferredSubscriptionChange(
      db,
      stored,
      applicableSubscription,
      signal,
    );
    return {
      status: "confirmed",
      response: {
        status: "scheduled",
        effectiveAt: effectiveAt.toISOString(),
        hostedInvoiceUrl: null,
      },
    };
  }
  return await applyImmediateSubscriptionChange(
    db,
    {
      stored,
      subscription: applicableSubscription,
      planItem,
      hasPlanUpgrade,
      immediatePackageChanges,
      paymentMethod,
    },
    signal,
  );
}

export const confirmUsagePackSubscriptionChange$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly changeId: string;
      readonly paymentMethod?: BillingPurchasePaymentMethod;
    },
    signal: AbortSignal,
  ): Promise<UsagePackSubscriptionChangeConfirmResult> => {
    const preparation = await set(
      prepareSubscriptionChangeConfirmation$,
      args,
      signal,
    );
    if (!preparation.ready) {
      return preparation.result;
    }
    // Confirmation admission is owned above. The existing provider application
    // graph still forwards a database and remains unfinished Release 1 work.
    const db = set(writeDb$);
    return await applyStoredSubscriptionChange(
      db,
      preparation.stored,
      args.paymentMethod,
      signal,
    );
  },
);

function invoiceSubscriptionId(
  invoice: UsagePackSubscriptionChangeInvoiceInput,
): string | null {
  return stripeObjectId(invoice.parent?.subscription_details?.subscription);
}

async function findSubscriptionChangeForInvoice(
  db: Pick<Db, "select">,
  invoice: UsagePackSubscriptionChangeInvoiceInput,
): Promise<UsagePackSubscriptionChangeRow | null> {
  const [bound] = await db
    .select()
    .from(usagePackSubscriptionChanges)
    .where(eq(usagePackSubscriptionChanges.stripeInvoiceId, invoice.id))
    .limit(1);
  if (bound) {
    return bound;
  }
  const subscriptionId = invoiceSubscriptionId(invoice);
  if (!subscriptionId) {
    return null;
  }
  const [subscription] = await db
    .select({ id: usagePackSubscriptions.id })
    .from(usagePackSubscriptions)
    .where(eq(usagePackSubscriptions.stripeSubscriptionId, subscriptionId))
    .limit(1);
  if (!subscription) {
    return null;
  }
  const [candidate] = await db
    .select()
    .from(usagePackSubscriptionChanges)
    .where(
      and(
        eq(
          usagePackSubscriptionChanges.usagePackSubscriptionId,
          subscription.id,
        ),
        inArray(usagePackSubscriptionChanges.status, [
          "applying",
          "pending_payment",
        ]),
      ),
    )
    .orderBy(desc(usagePackSubscriptionChanges.createdAt))
    .limit(1);
  return candidate ?? null;
}

async function replacesScheduledPackageChange(
  db: Pick<Db, "select">,
  stored: StoredSubscriptionChange,
): Promise<boolean> {
  if (
    stored.allocationChanges.some((change) => {
      return change.stripeScheduleId !== null;
    })
  ) {
    return true;
  }
  return (
    stored.allocationChanges.length === 0 &&
    (await scheduledAllocationChanges(db, stored.subscription.id)).length > 0
  );
}

export async function handleUsagePackSubscriptionChangeInvoicePaid(
  db: Db,
  invoice: UsagePackSubscriptionChangeInvoiceInput,
): Promise<UsagePackSubscriptionChangeInvoiceOutcome> {
  const root = await findSubscriptionChangeForInvoice(db, invoice);
  if (!root) {
    return { handled: false, orgId: null };
  }
  if (invoice.status !== "paid" && invoice.paid !== true) {
    throw new Error(
      `Usage pack subscription change invoice ${invoice.id} is not paid`,
    );
  }
  const stored = await loadStoredSubscriptionChange(db, root.id);
  if (!stored?.subscription.stripeSubscriptionId) {
    throw new Error(`Subscription change ${root.id} lost its subscription`);
  }
  const subscriptionId = invoiceSubscriptionId(invoice);
  if (subscriptionId !== stored.subscription.stripeSubscriptionId) {
    throw new Error(
      `Subscription change invoice ${invoice.id} has the wrong subscription`,
    );
  }
  if (
    stripeObjectId(invoice.customer) !== stored.subscription.stripeCustomerId
  ) {
    throw new Error(
      `Subscription change invoice ${invoice.id} has the wrong customer`,
    );
  }
  const subscription = await getStripeClient().subscriptions.retrieve(
    subscriptionId,
    { expand: ["latest_invoice"] },
  );
  // Completed invoices can be replayed after renewal, restoration, or a later
  // plan change. Return current Stripe truth without applying the old intent.
  if (stored.root.status === "completed") {
    return { handled: true, orgId: root.orgId, subscription };
  }
  if (stored.root.status === "failed") {
    throw new Error(`Subscription change ${root.id} is no longer applicable`);
  }
  // A saved schedule alone does not prove this invoice's credits were fulfilled.
  if (
    stored.root.deferredSchedule &&
    (await usagePackInvoiceFulfillmentExists(
      db,
      invoice.id,
      stored.subscription.id,
    ))
  ) {
    await scheduleDeferredSubscriptionChange(
      db,
      stored,
      subscription,
      undefined,
    );
    return { handled: true, orgId: root.orgId, subscription };
  }
  const expectedImmediateTier = planIsUpgrade(root.sourceTier, root.targetTier)
    ? root.targetTier
    : root.sourceTier;
  if (subscriptionPlanTier(subscription) !== expectedImmediateTier) {
    throw new Error(
      `Subscription change invoice ${invoice.id} was paid before the plan change was applied`,
    );
  }
  const period = usagePackPeriod(subscription);
  await reconcileUsagePackAllocationChangeSubscription(db, subscription);
  await fulfillUsagePackSubscriptionChangeInvoice(db, {
    subscriptionChangeId: root.id,
    prorationTimestamp: root.prorationTimestamp,
    periodStart: period.start,
    periodEnd: period.end,
    invoice,
  });
  const refreshed = await loadStoredSubscriptionChange(db, root.id);
  if (!refreshed) {
    throw new Error(`Subscription change ${root.id} disappeared`);
  }
  const hasDeferredChanges =
    planIsDowngrade(root.sourceTier, root.targetTier) ||
    refreshed.allocationChanges.some((change) => {
      return change.kind === "downgrade" || change.kind === "removal";
    });
  if (
    hasDeferredChanges ||
    (await replacesScheduledPackageChange(db, refreshed))
  ) {
    await scheduleDeferredSubscriptionChange(
      db,
      refreshed,
      subscription,
      undefined,
    );
  } else {
    const completedAt = nowDate();
    await db
      .update(usagePackSubscriptionChanges)
      .set({ status: "completed", completedAt, updatedAt: completedAt })
      .where(eq(usagePackSubscriptionChanges.id, root.id));
  }
  return { handled: true, orgId: root.orgId, subscription };
}

async function failExpiredPendingSubscriptionChange(
  db: Db,
  root: UsagePackSubscriptionChangeRow,
): Promise<void> {
  const completedAt = nowDate();
  await db.transaction(async (tx) => {
    await tx
      .update(usagePackSubscriptionChanges)
      .set({
        status: "failed",
        failureReason: "pending_update_expired",
        completedAt,
        updatedAt: completedAt,
      })
      .where(eq(usagePackSubscriptionChanges.id, root.id));
    await tx
      .update(usagePackAllocationChanges)
      .set({
        status: "failed",
        failureReason: "pending_update_expired",
        completedAt,
        updatedAt: completedAt,
      })
      .where(eq(usagePackAllocationChanges.subscriptionChangeId, root.id));
  });
}

async function rollbackUnpaidSubscriptionChange(
  db: Db,
  stored: NonNullable<Awaited<ReturnType<typeof loadStoredSubscriptionChange>>>,
  subscription: StripeSubscription,
  invoice: StripeInvoice | null,
  signal: AbortSignal,
): Promise<void> {
  const stripe = getStripeClient();
  if (invoice?.status === "open") {
    await stripe.invoices.voidInvoice(
      invoice.id,
      {},
      {
        idempotencyKey: `usage-pack-subscription-change:${stored.root.id}:void`,
      },
    );
    signal.throwIfAborted();
  }
  const items = subscriptionUpdateItems(
    subscription,
    subscriptionPlanItem(subscription),
    stored.subscription.stripePlanPriceId,
    packageQuantitiesFromAllocations(stored.allocations),
  );
  if (items.length > 0) {
    await stripe.subscriptions.update(
      subscription.id,
      {
        items,
        proration_behavior: "none",
      },
      {
        idempotencyKey: `usage-pack-subscription-change:${stored.root.id}:rollback`,
      },
    );
    signal.throwIfAborted();
  }
  await failExpiredPendingSubscriptionChange(db, stored.root);
}

async function expireSubscriptionChangePreviews(
  db: Db,
  at: Date,
  scope: BillingReconciliationScope | undefined,
): Promise<number> {
  const expired = await db
    .update(usagePackSubscriptionChanges)
    .set({
      status: "failed",
      failureReason: "preview_expired",
      completedAt: at,
      updatedAt: at,
    })
    .where(
      and(
        scope
          ? inArray(usagePackSubscriptionChanges.orgId, [...scope.orgIds])
          : undefined,
        eq(usagePackSubscriptionChanges.status, "previewed"),
        lte(usagePackSubscriptionChanges.previewExpiresAt, at),
      ),
    )
    .returning({ id: usagePackSubscriptionChanges.id });
  if (expired.length > 0) {
    await db
      .update(usagePackAllocationChanges)
      .set({
        status: "failed",
        failureReason: "preview_expired",
        completedAt: at,
        updatedAt: at,
      })
      .where(
        inArray(
          usagePackAllocationChanges.subscriptionChangeId,
          expired.map((root) => {
            return root.id;
          }),
        ),
      );
  }
  return expired.length;
}

async function subscriptionChangeInvoice(
  root: UsagePackSubscriptionChangeRow,
  subscription: StripeSubscription,
  signal: AbortSignal,
): Promise<StripeInvoice | null> {
  const latestInvoice = expandedLatestInvoice(subscription);
  if (!root.stripeInvoiceId || latestInvoice?.id === root.stripeInvoiceId) {
    return latestInvoice;
  }
  const invoice = await getStripeClient().invoices.retrieve(
    root.stripeInvoiceId,
  );
  signal.throwIfAborted();
  return invoice;
}

function pendingSubscriptionPaymentExpired(
  root: UsagePackSubscriptionChangeRow,
  at: Date,
  paymentExpiredBefore: Date,
): boolean {
  return (
    root.status === "pending_payment" &&
    ((root.stripePendingUpdateExpiresAt !== null &&
      root.stripePendingUpdateExpiresAt <= at) ||
      (root.stripePendingUpdateExpiresAt === null &&
        root.updatedAt <= paymentExpiredBefore))
  );
}

function immediateSubscriptionProjectionMatches(
  stored: StoredSubscriptionChange,
  subscription: StripeSubscription,
): boolean {
  const expectedImmediateTier = planIsUpgrade(
    stored.root.sourceTier,
    stored.root.targetTier,
  )
    ? stored.root.targetTier
    : stored.root.sourceTier;
  const expectedPackageQuantities = projectedPackageQuantities(
    stored.allocations,
    stored.allocationChanges,
    (change) => {
      return change.kind === "addition" || change.kind === "upgrade";
    },
  );
  return (
    subscriptionPlanTier(subscription) === expectedImmediateTier &&
    quantitiesMatch(
      expectedPackageQuantities,
      packageQuantitiesFromSubscription(subscription),
    )
  );
}

async function reconcileSubscriptionChangeCandidate(
  db: Db,
  args: {
    readonly root: UsagePackSubscriptionChangeRow;
    readonly at: Date;
    readonly paymentExpiredBefore: Date;
  },
  signal: AbortSignal,
): Promise<string | null> {
  const stored = await loadStoredSubscriptionChange(db, args.root.id);
  const subscriptionId = stored?.subscription.stripeSubscriptionId;
  if (!stored || !subscriptionId) {
    return null;
  }
  const subscription = await getStripeClient().subscriptions.retrieve(
    subscriptionId,
    { expand: ["latest_invoice"] },
  );
  signal.throwIfAborted();
  if (subscription.pending_update) {
    return null;
  }
  const invoice = await subscriptionChangeInvoice(
    args.root,
    subscription,
    signal,
  );
  if (invoice?.status === "paid") {
    const outcome = await handleUsagePackSubscriptionChangeInvoicePaid(
      db,
      invoice,
    );
    return outcome.handled ? outcome.orgId : null;
  }
  if (
    pendingSubscriptionPaymentExpired(
      args.root,
      args.at,
      args.paymentExpiredBefore,
    )
  ) {
    await rollbackUnpaidSubscriptionChange(
      db,
      stored,
      subscription,
      invoice,
      signal,
    );
    return args.root.orgId;
  }
  if (!immediateSubscriptionProjectionMatches(stored, subscription)) {
    await failExpiredPendingSubscriptionChange(db, args.root);
    return args.root.orgId;
  }
  return null;
}

export async function reconcileUsagePackSubscriptionChanges(
  db: Db,
  scope: BillingReconciliationScope | undefined,
  signal: AbortSignal,
): Promise<{
  readonly reconciled: number;
  readonly orgIds: readonly string[];
}> {
  signal.throwIfAborted();
  const at = nowDate();
  const staleBefore = new Date(at.getTime() - RECONCILIATION_DELAY_MS);
  const paymentExpiredBefore = new Date(
    at.getTime() - PAYMENT_CONFIRMATION_TTL_MS,
  );
  const expiredCount = await expireSubscriptionChangePreviews(db, at, scope);
  const candidates = await db
    .select()
    .from(usagePackSubscriptionChanges)
    .where(
      and(
        scope
          ? inArray(usagePackSubscriptionChanges.orgId, [...scope.orgIds])
          : undefined,
        inArray(usagePackSubscriptionChanges.status, [
          "applying",
          "pending_payment",
        ]),
        lte(usagePackSubscriptionChanges.updatedAt, staleBefore),
      ),
    )
    .limit(100);
  const orgIds = new Set<string>();
  let reconciled = expiredCount;
  for (const root of candidates) {
    const result = await settle(
      reconcileSubscriptionChangeCandidate(
        db,
        {
          root,
          at,
          paymentExpiredBefore,
        },
        signal,
      ),
      signal,
    );
    if (!result.ok) {
      L.error("usage pack subscription change reconciliation failed", {
        subscriptionChangeId: root.id,
        orgId: root.orgId,
        usagePackSubscriptionId: root.usagePackSubscriptionId,
        error: result.error,
      });
      continue;
    }
    if (result.value) {
      reconciled += 1;
      orgIds.add(result.value);
    }
  }
  return { reconciled, orgIds: [...orgIds] };
}
