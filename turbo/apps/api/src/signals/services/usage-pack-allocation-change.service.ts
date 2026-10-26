import { subscriptionInvoicePublicationPlan } from "./usage-pack-subscription-invoice-sql";
import { prepareUsagePackMemberRemovalPlan } from "./usage-pack-member-removal-plan";
import { upgradeInvoicePublicationPlan } from "./usage-pack-upgrade-invoice-sql";
import { conflictingUsagePackMutationSql } from "./usage-pack-mutation-admission";
import {
  grantSubscriptionOwnershipQuery,
  grantWalletOwnershipQuery,
  requireGrantOwnership,
} from "./usage-pack-grant-ownership";
import {
  type UsagePackChangeConfirmResponse,
  type UsagePackChangePreviewResponse,
  type UsagePackManagementResponse,
  type UsagePackUsd,
  USAGE_PACKS_USD,
} from "@okouai/api-contracts/contracts/billing";
import { orgMetadata } from "@okouai/db/schema/org-metadata";

import {
  usagePackAllocationChanges,
  usagePackAllocations,
  usagePackInvoiceFulfillments,
  usagePackSubscriptionChanges,
  usagePackSubscriptionMigrations,
  usagePackSubscriptions,
} from "@okouai/db/schema/usage-pack-subscription";
import {
  DrizzleQueryError,
  type SQL,
  count,
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNull,
  isNotNull,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { type PgUpdateSetSource, QueryBuilder } from "drizzle-orm/pg-core";
import { command, computed, type Computed } from "ccstate";
import {
  zodDriverValueDecoder,
  pgInt8ToSafeIntegerDecoder,
  nullableDriverValueDecoder,
} from "../../lib/db-structured-result";

import {
  contextJsonProjection,
  contextJsonRows,
  contextProjectionSchema,
} from "./context-rowset";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { db$, rawSqlReadDb$, writeDb$ } from "../external/db";
import {
  getStripeClient,
  type StripeClient,
  type StripeInvoice,
  type StripeInvoiceAutomaticTaxParam,
  type StripeInvoiceCreatePreviewParams,
  type StripeInvoiceLine,
  type StripePriceRecurring,
  type StripeRef,
  type StripeSchedulePhase,
  type StripeSchedulePhaseDiscountParam,
  type StripeSchedulePhaseItemParam,
  type StripeSchedulePhaseParam,
  type StripeSubscription,
  type StripeSubscriptionSchedule,
  type StripeSubscriptionUpdateItemParam,
} from "../external/stripe-client";
import { settle, safeSync } from "../utils";
import type { UsagePackCreditGrantArgs } from "./usage-pack-credit.service";
import { sourceColumns } from "./usage-pack-credit-refund.service";

import { literal, object, record, string, unknown as zUnknown } from "zod";
import { parseRawRows } from "../../lib/db-raw-rows";
import { completeBillingOperationInvoice } from "./billing-operation-invoice.service";
import { subscriptionSchedulePhasesEndingAt } from "./stripe-subscription-schedules.service";
import {
  setStripeSubscriptionPaymentMethod,
  type BillingPurchasePaymentMethod,
} from "./billing-payment-method.service";
import type { EmptyUsagePackCancellation } from "./billing-downgrade.service";
import {
  activeUsagePackPriceId,
  isUsagePackPlanPriceId,
  usagePackUsdForKnownPriceId,
} from "./billing-checkout.service";
const retainedMutationRowSchema = record(string(), zUnknown());

const PREVIEW_TTL_MS = 15 * 60 * 1000;
const CHANGE_RECONCILIATION_DELAY_MS = 5 * 60 * 1000;
const STRIPE_INVOICE_LINE_PAGE_SIZE = 100;
const CREDITS_PER_DOLLAR = 1000;
const CREDITS_PER_CENT = CREDITS_PER_DOLLAR / 100;
const L = logger("UsagePackAllocationChange");
const OPEN_CHANGE_STATUSES = [
  "previewed",
  "applying",
  "pending_payment",
  "scheduled",
  "applied",
] as const;
const PROJECTED_USAGE_PACK_ALLOCATION_STATUSES = [
  "pending_payment",
  "active",
  "pending_invitation",
] as const;
const TERMINAL_SUBSCRIPTION_STATUSES = [
  "canceled",
  "incomplete_expired",
  "invalid",
] as const;

type UsagePackSubscriptionRow = typeof usagePackSubscriptions.$inferSelect;
type UsagePackAllocationRow = typeof usagePackAllocations.$inferSelect;
type UsagePackAllocationChangeRow =
  typeof usagePackAllocationChanges.$inferSelect;
type UsagePackSubscriptionChangeRow =
  typeof usagePackSubscriptionChanges.$inferSelect;
type OpenUsagePackAllocationChangeStatus = Exclude<
  UsagePackAllocationChangeRow["status"],
  "completed" | "failed"
>;

interface UsagePackChangeContext {
  readonly subscription: UsagePackSubscriptionRow;
  readonly allocations: readonly UsagePackAllocationRow[];
  readonly changes: readonly UsagePackAllocationChangeRow[];
}

interface UsagePackPeriod {
  readonly start: number;
  readonly end: number;
}

interface UsagePackUpgradeCreditGrantInput {
  readonly sourceAllocation: {
    readonly id: string;
    readonly currentPeriodStart: Date | null;
    readonly currentPeriodEnd: Date | null;
  };
  readonly sourceStripePriceId: string;
  readonly targetStripePriceId: string;
}

interface UsagePackUpgradeCreditGrant {
  readonly purchasedCredits: number;
  readonly bonusCredits: number;
}

function isProjectedUsagePackAllocation(
  allocation: UsagePackAllocationRow,
): boolean {
  return PROJECTED_USAGE_PACK_ALLOCATION_STATUSES.some((status) => {
    return allocation.status === status;
  });
}

function withAcceptedInvitationAllocations(
  context: UsagePackChangeContext,
): UsagePackChangeContext {
  return {
    ...context,
    allocations: context.allocations.map((allocation) => {
      return allocation.status === "paid_pending_invitation" &&
        allocation.userId
        ? { ...allocation, status: "pending_payment" }
        : allocation;
    }),
  };
}

interface UsagePackChangePreviewArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly targetUsagePackUsd: UsagePackUsd;
}

interface StripeUsagePackChangePreview {
  readonly kind: "upgrade" | "downgrade";
  readonly targetStripePriceId: string;
  readonly prorationTimestamp: number;
  readonly immediateAmountCents: number;
  readonly nextRecurringAmountCents: number;
  readonly currency: string;
  readonly effectiveAt: Date;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

interface UsagePackChangeSubscriptionInput {
  readonly id: string;
  readonly customer?: string | { readonly id: string } | null;
  readonly status: string;
  readonly cancel_at?: number | null;
  readonly cancel_at_period_end?: boolean;
  readonly metadata?: Record<string, string> | null;
  readonly schedule?: string | { readonly id: string } | null;
  readonly discounts?: readonly StripeRef[];
  readonly pending_update?: {
    readonly expires_at: number;
  } | null;
  readonly latest_invoice?: string | UsagePackChangeInvoiceInput | null;
  readonly items: {
    readonly data: readonly {
      readonly id?: string;
      readonly price: {
        readonly id: string;
        readonly recurring?: {
          readonly interval: StripePriceRecurring["interval"];
          readonly interval_count: number;
        } | null;
      };
      readonly quantity?: number | null;
      readonly current_period_start?: number | null;
      readonly current_period_end?: number | null;
    }[];
  };
}

interface UsagePackChangeInvoiceLineInput {
  readonly id?: string;
  readonly amount?: number | null;
  readonly discount_amounts?: readonly { readonly amount: number }[] | null;
  readonly subtotal?: number | null;
  readonly quantity?: number | null;
  readonly price?: { readonly id: string } | null;
  readonly pricing?: {
    readonly price_details?: {
      readonly price?: string | { readonly id: string } | null;
    } | null;
  } | null;
  readonly proration?: boolean;
  readonly taxes?:
    | readonly {
        readonly amount: number;
        readonly tax_behavior: "exclusive" | "inclusive";
      }[]
    | null;
  readonly period: { readonly start?: number; readonly end: number };
  readonly parent: {
    readonly type: "subscription_item_details" | "invoice_item_details";
    readonly subscription_item_details?: {
      readonly proration: boolean;
    } | null;
    readonly invoice_item_details?: {
      readonly proration: boolean;
    } | null;
  } | null;
}

export interface UsagePackChangeInvoiceInput {
  readonly id: string;
  readonly customer: string | { readonly id: string } | null;
  readonly metadata: Record<string, string> | null;
  readonly status?: string | null;
  readonly paid?: boolean;
  readonly total?: number;
  readonly amount_paid?: number;
  readonly hosted_invoice_url?: string | null;
  readonly lines: { readonly data: readonly UsagePackChangeInvoiceLineInput[] };
  readonly parent: {
    readonly subscription_details: {
      readonly metadata?: Record<string, string> | null;
      readonly subscription: string | { readonly id: string };
    } | null;
  } | null;
}

type UsagePackChangePreviewResult =
  | {
      readonly status: "ready";
      readonly preview: UsagePackChangePreviewResponse;
    }
  | { readonly status: "not_found" }
  | { readonly status: "same_package" }
  | { readonly status: "plan_ending" }
  | { readonly status: "conflict" };

type UsagePackChangeConfirmResult =
  | {
      readonly status: "confirmed";
      readonly response: UsagePackChangeConfirmResponse;
    }
  | { readonly status: "not_found" }
  | { readonly status: "expired" }
  | { readonly status: "plan_ending" }
  | { readonly status: "conflict" };

type UsagePackChangeInvoiceOutcome =
  | { readonly handled: false; readonly orgId: null }
  | { readonly handled: true; readonly orgId: string };

function usagePackUsd(value: number): UsagePackUsd {
  const matched = USAGE_PACKS_USD.find((candidate) => {
    return candidate === value;
  });
  if (!matched) {
    throw new Error(`Invalid usage pack amount: ${value}`);
  }
  return matched;
}

function openManagementChangeStatus(
  status: UsagePackAllocationChangeRow["status"],
): OpenUsagePackAllocationChangeStatus {
  switch (status) {
    case "previewed":
    case "applying":
    case "pending_payment":
    case "scheduled":
    case "applied": {
      return status;
    }
    case "completed":
    case "failed": {
      throw new Error(`Invalid open usage pack change status: ${status}`);
    }
  }
}

function stripeObjectId(
  value: string | { readonly id: string } | null | undefined,
): string | null {
  return typeof value === "string" ? value : (value?.id ?? null);
}

function unixDate(value: number | null | undefined): Date | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return null;
  }
  return new Date(value * 1000);
}

function invoiceLinePriceId(
  line: UsagePackChangeInvoiceLineInput,
): string | null {
  return (
    line.price?.id ?? stripeObjectId(line.pricing?.price_details?.price ?? null)
  );
}

function invoiceLineAmount(
  line: UsagePackChangeInvoiceLineInput,
): number | null {
  const amount = line.subtotal ?? line.amount;
  return typeof amount === "number" && Number.isSafeInteger(amount)
    ? amount
    : null;
}

function invoiceLineRefundableAmountWithTax(
  line: UsagePackChangeInvoiceLineInput,
): number | null {
  const amount = line.amount ?? line.subtotal;
  if (typeof amount !== "number" || !Number.isSafeInteger(amount)) {
    return null;
  }
  const discountAmount = (line.discount_amounts ?? []).reduce(
    (total, discount) => {
      return total + discount.amount;
    },
    0,
  );
  const exclusiveTax = (line.taxes ?? []).reduce((total, tax) => {
    return tax.tax_behavior === "exclusive" ? total + tax.amount : total;
  }, 0);
  const refundableAmount =
    amount + (amount < 0 ? discountAmount : -discountAmount) + exclusiveTax;
  return Number.isSafeInteger(refundableAmount) ? refundableAmount : null;
}

function invoiceLineIsProration(
  line: UsagePackChangeInvoiceLineInput,
): boolean {
  if (line.parent?.type === "subscription_item_details") {
    return (
      line.parent.subscription_item_details?.proration ??
      line.proration ??
      false
    );
  }
  if (line.parent?.type === "invoice_item_details") {
    return (
      line.parent.invoice_item_details?.proration ?? line.proration ?? false
    );
  }
  return line.proration ?? false;
}

function invoiceSubscriptionId(
  invoice: UsagePackChangeInvoiceInput,
): string | null {
  return stripeObjectId(invoice.parent?.subscription_details?.subscription);
}

function subscriptionScheduleId(
  subscription: UsagePackChangeSubscriptionInput,
): string | null {
  return stripeObjectId(subscription.schedule);
}

function usagePackSubscriptionIdFromMetadata(
  metadata: Readonly<Record<string, string>> | null | undefined,
): string | null {
  if (metadata?.purpose !== "usage_pack_subscription") {
    return null;
  }
  return metadata.usagePackSubscriptionId ?? null;
}

function usagePackChangeContextSelection(usagePackSubscriptionId: string) {
  const allocationColumns = getTableColumns(usagePackAllocations);
  const changeColumns = getTableColumns(usagePackAllocationChanges);
  const allocationSchema = contextProjectionSchema(allocationColumns);
  const changeSchema = contextProjectionSchema(changeColumns);
  const allocations = new QueryBuilder()
    .select({
      payload: contextJsonProjection(allocationColumns)
        .mapWith(zodDriverValueDecoder(allocationSchema))
        .as("payload"),
    })
    .from(usagePackAllocations)
    .where(
      eq(usagePackAllocations.usagePackSubscriptionId, usagePackSubscriptionId),
    );
  const changes = new QueryBuilder()
    .select({
      payload: contextJsonProjection(changeColumns)
        .mapWith(zodDriverValueDecoder(changeSchema))
        .as("payload"),
    })
    .from(usagePackAllocationChanges)
    .where(
      and(
        eq(
          usagePackAllocationChanges.usagePackSubscriptionId,
          usagePackSubscriptionId,
        ),
        inArray(usagePackAllocationChanges.status, [...OPEN_CHANGE_STATUSES]),
      ),
    );
  return {
    subscription: usagePackSubscriptions,
    allocations: contextJsonRows(allocations).mapWith(
      zodDriverValueDecoder(allocationSchema.array()),
    ),
    changes: contextJsonRows(changes).mapWith(
      zodDriverValueDecoder(changeSchema.array()),
    ),
  };
}

function activeMemberAllocations(
  context: UsagePackChangeContext,
): readonly UsagePackAllocationRow[] {
  return context.allocations.filter((allocation) => {
    return allocation.userId !== null && allocation.status === "active";
  });
}

function activeAllocationForMember(
  context: UsagePackChangeContext,
  userId: string,
): UsagePackAllocationRow | null {
  return (
    activeMemberAllocations(context).find((allocation) => {
      return allocation.userId === userId;
    }) ?? null
  );
}

function packageQuantitiesForAllocations(
  allocations: readonly UsagePackAllocationRow[],
): ReadonlyMap<string, number> {
  const quantities = new Map<string, number>();
  for (const allocation of allocations) {
    if (!isProjectedUsagePackAllocation(allocation)) {
      continue;
    }
    quantities.set(
      allocation.stripePriceId,
      (quantities.get(allocation.stripePriceId) ?? 0) + 1,
    );
  }
  return quantities;
}

function packageQuantitiesForSubscription(
  subscription: UsagePackChangeSubscriptionInput,
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

function validateStripeSubscriptionIdentity(
  context: UsagePackChangeContext,
  subscription: UsagePackChangeSubscriptionInput,
): void {
  if (subscription.id !== context.subscription.stripeSubscriptionId) {
    throw new Error("Stripe subscription does not match the usage pack record");
  }
  if (
    stripeObjectId(subscription.customer) !==
    context.subscription.stripeCustomerId
  ) {
    throw new Error("Stripe customer does not match the usage pack record");
  }
}

function validateCurrentStripeProjection(
  context: UsagePackChangeContext,
  subscription: UsagePackChangeSubscriptionInput,
): void {
  validateStripeSubscriptionIdentity(context, subscription);
  validateStripePackageQuantities(
    subscription,
    packageQuantitiesForAllocations(context.allocations),
  );
}

function validateStripePackageQuantities(
  subscription: UsagePackChangeSubscriptionInput,
  expectedQuantities: ReadonlyMap<string, number>,
): void {
  if (
    !quantitiesMatch(
      expectedQuantities,
      packageQuantitiesForSubscription(subscription),
    )
  ) {
    throw new Error("Stripe usage pack quantities are out of sync");
  }
}

function usagePackItemPeriod(subscription: UsagePackChangeSubscriptionInput): {
  readonly start: number;
  readonly end: number;
} {
  const usagePackItems = subscription.items.data.filter((item) => {
    return (
      isUsagePackPlanPriceId(item.price.id) ||
      usagePackUsdForKnownPriceId(item.price.id) !== null
    );
  });
  const first = usagePackItems[0];
  const start = first?.current_period_start;
  const end = first?.current_period_end;
  if (
    typeof start !== "number" ||
    typeof end !== "number" ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    end <= start ||
    usagePackItems.some((item) => {
      return (
        item.current_period_start !== start || item.current_period_end !== end
      );
    })
  ) {
    throw new Error("Usage pack subscription has an invalid billing period");
  }
  return { start, end };
}

function subscriptionItemId(
  item: UsagePackChangeSubscriptionInput["items"]["data"][number],
): string {
  if (!item.id) {
    throw new Error(`Stripe subscription item ${item.price.id} has no ID`);
  }
  return item.id;
}

function changeUpdateItems(
  subscription: UsagePackChangeSubscriptionInput,
  sourcePriceId: string,
  targetPriceId: string,
): StripeSubscriptionUpdateItemParam[] {
  const source = subscription.items.data.find((item) => {
    return item.price.id === sourcePriceId;
  });
  if (!source) {
    throw new Error(`Stripe subscription is missing ${sourcePriceId}`);
  }
  const sourceQuantity = source.quantity ?? 1;
  if (!Number.isSafeInteger(sourceQuantity) || sourceQuantity <= 0) {
    throw new Error(
      `Stripe subscription has an invalid ${sourcePriceId} quantity`,
    );
  }
  const target = subscription.items.data.find((item) => {
    return item.price.id === targetPriceId;
  });
  const targetQuantity = target?.quantity ?? 0;
  if (!Number.isSafeInteger(targetQuantity) || targetQuantity < 0) {
    throw new Error(
      `Stripe subscription has an invalid ${targetPriceId} quantity`,
    );
  }

  return [
    sourceQuantity === 1
      ? { id: subscriptionItemId(source), deleted: true }
      : { id: subscriptionItemId(source), quantity: sourceQuantity - 1 },
    target
      ? { id: subscriptionItemId(target), quantity: targetQuantity + 1 }
      : { price: targetPriceId, quantity: 1 },
  ];
}

function safeInvoiceAmount(invoice: StripeInvoice, label: string): number {
  if (
    !Number.isSafeInteger(invoice.amount_due) ||
    invoice.amount_due < 0 ||
    invoice.currency.length !== 3
  ) {
    throw new Error(`Stripe ${label} preview has an invalid amount`);
  }
  return invoice.amount_due;
}

function invoiceLineAmountWithTax(line: StripeInvoiceLine): number {
  const discountAmount = (line.discount_amounts ?? []).reduce(
    (total, discount) => {
      return total + discount.amount;
    },
    0,
  );
  const exclusiveTax = (line.taxes ?? []).reduce((total, tax) => {
    return tax.tax_behavior === "exclusive" ? total + tax.amount : total;
  }, 0);
  const amount = line.amount - discountAmount + exclusiveTax;
  if (!Number.isSafeInteger(amount)) {
    throw new Error("Stripe usage pack preview line has an invalid amount");
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

function invoiceAutomaticTaxParam(
  invoice: StripeInvoice,
): StripeInvoiceAutomaticTaxParam | null {
  if (invoice.automatic_tax?.enabled !== true) {
    return null;
  }
  const liability = invoice.automatic_tax.liability;
  if (!liability) {
    return { enabled: true };
  }
  if (liability.type === "self") {
    return { enabled: true, liability: { type: "self" } };
  }
  const account = stripeObjectId(liability.account);
  if (!account) {
    throw new Error("Stripe automatic tax liability has no account");
  }
  return { enabled: true, liability: { type: "account", account } };
}

function invoiceLineTaxRateIds(line: StripeInvoiceLine): readonly string[] {
  return [
    ...new Set(
      (line.taxes ?? []).map((tax) => {
        const taxRateId = tax.tax_rate_details?.tax_rate;
        if (!taxRateId) {
          throw new Error("Stripe invitation preview tax has no Tax Rate");
        }
        return taxRateId;
      }),
    ),
  ];
}

function usagePackAllocationAdditionCharge(
  invoice: StripeInvoice,
  lines: readonly StripeInvoiceLine[],
  stripePriceId: string,
  prorationTimestamp: number,
): Pick<
  UsagePackAllocationAdditionChargePreview,
  "amountCents" | "automaticTax" | "invoiceItems"
> {
  const prorationLines = lines.filter((line) => {
    return (
      invoiceLinePriceId(line) === stripePriceId &&
      invoiceLineIsProration(line) &&
      line.period.start === prorationTimestamp
    );
  });
  const automaticTax = invoiceAutomaticTaxParam(invoice);
  const invoiceItems = prorationLines.map((line) => {
    if (!Number.isSafeInteger(line.amount)) {
      throw new Error("Stripe invitation preview line has an invalid amount");
    }
    return {
      amountCents: line.amount,
      taxRateIds: automaticTax ? [] : invoiceLineTaxRateIds(line),
    };
  });
  const netAmountCents = invoiceItems.reduce((total, item) => {
    return total + item.amountCents;
  }, 0);
  const amount = prorationLines.reduce((total, line) => {
    return total + invoiceLineAmountWithTax(line);
  }, 0);
  if (
    invoice.currency.length !== 3 ||
    prorationLines.length === 0 ||
    !Number.isSafeInteger(netAmountCents) ||
    !Number.isSafeInteger(amount)
  ) {
    throw new Error("Stripe invitation preview has an invalid amount");
  }
  return {
    amountCents: Math.max(0, amount),
    automaticTax,
    invoiceItems: automaticTax
      ? netAmountCents > 0
        ? [{ amountCents: netAmountCents, taxRateIds: [] }]
        : []
      : invoiceItems,
  };
}

function expiredUsagePackPreviewCondition(orgId: string, at: Date) {
  return and(
    eq(usagePackAllocationChanges.orgId, orgId),
    eq(usagePackAllocationChanges.status, "previewed"),
    lte(usagePackAllocationChanges.previewExpiresAt, at),
  );
}

function failedUsagePackPreviewValues(
  at: Date,
  reason: string,
): PgUpdateSetSource<typeof usagePackAllocationChanges> {
  return {
    status: "failed",
    failureReason: reason,
    completedAt: at,
    updatedAt: at,
  };
}

function usagePackManagementResponse(
  context: UsagePackChangeContext | null,
): UsagePackManagementResponse | null {
  if (!context) {
    return null;
  }
  const changesByUserId = new Map<string, UsagePackAllocationChangeRow>();
  for (const change of context.changes) {
    if (change.status === "previewed") {
      continue;
    }
    const existing = changesByUserId.get(change.userId);
    // A newer aggregate may copy an already accepted future downgrade while
    // another member's upgrade awaits payment. That unpaid copy cannot turn
    // the identical accepted schedule into a pending-payment promise. The
    // partial unique index admits only one scheduled/applied change per user.
    if (
      existing?.status === "scheduled" &&
      change.status === "pending_payment" &&
      change.subscriptionChangeId !== null &&
      existing.kind === change.kind &&
      existing.sourceAllocationId === change.sourceAllocationId &&
      existing.targetUsagePackUsd === change.targetUsagePackUsd &&
      existing.targetStripePriceId === change.targetStripePriceId &&
      existing.effectiveAt?.getTime() === change.effectiveAt?.getTime()
    ) {
      continue;
    }
    changesByUserId.set(change.userId, change);
  }
  return {
    tier: context.subscription.tier,
    supportsFreeMembers: true,
    currentPeriodEnd:
      context.subscription.currentPeriodEnd?.toISOString() ?? null,
    supportsMemberAdditions: true,
    allocations: activeMemberAllocations(context).map((allocation) => {
      const change = changesByUserId.get(allocation.userId ?? "");
      return {
        id: allocation.id,
        memberId: allocation.userId ?? "",
        usagePackUsd: usagePackUsd(allocation.usagePackUsd),
        currentPeriodEnd: allocation.currentPeriodEnd?.toISOString() ?? null,
        pendingChange: change
          ? {
              id: change.id,
              kind: change.kind,
              status: openManagementChangeStatus(change.status),
              targetUsagePackUsd:
                change.targetUsagePackUsd === null
                  ? null
                  : usagePackUsd(change.targetUsagePackUsd),
              effectiveAt: change.effectiveAt?.toISOString() ?? null,
            }
          : null,
      };
    }),
  };
}

export const getUsagePackManagement$ = command(
  async (
    { get },
    orgId: string,
  ): Promise<UsagePackManagementResponse | null> => {
    const db = get(db$);
    const context = await (async (): Promise<UsagePackChangeContext | null> => {
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
      if (!subscription) {
        return null;
      }
      const usagePackSubscriptionId = subscription.id;
      return await (async (): Promise<UsagePackChangeContext | null> => {
        const allocationColumns = getTableColumns(usagePackAllocations);
        const changeColumns = getTableColumns(usagePackAllocationChanges);
        const allocationSchema = contextProjectionSchema(allocationColumns);
        const changeSchema = contextProjectionSchema(changeColumns);
        const allocations = db
          .select({
            payload: contextJsonProjection(allocationColumns)
              .mapWith(zodDriverValueDecoder(allocationSchema))
              .as("payload"),
          })
          .from(usagePackAllocations)
          .where(
            eq(
              usagePackAllocations.usagePackSubscriptionId,
              usagePackSubscriptionId,
            ),
          );
        const changes = db
          .select({
            payload: contextJsonProjection(changeColumns)
              .mapWith(zodDriverValueDecoder(changeSchema))
              .as("payload"),
          })
          .from(usagePackAllocationChanges)
          .where(
            and(
              eq(
                usagePackAllocationChanges.usagePackSubscriptionId,
                usagePackSubscriptionId,
              ),
              inArray(usagePackAllocationChanges.status, [
                ...OPEN_CHANGE_STATUSES,
              ]),
            ),
          );
        // Allocation replacement and its change-status transition commit together.
        // One statement prevents mixing child rows from either side of that commit.
        const [context] = await db
          .select({
            subscription: usagePackSubscriptions,
            allocations: contextJsonRows(allocations).mapWith(
              zodDriverValueDecoder(allocationSchema.array()),
            ),
            changes: contextJsonRows(changes).mapWith(
              zodDriverValueDecoder(changeSchema.array()),
            ),
          })
          .from(usagePackSubscriptions)
          .where(eq(usagePackSubscriptions.id, usagePackSubscriptionId))
          .limit(1);
        return context ?? null;
      })();
    })();
    return usagePackManagementResponse(context);
  },
);

export function usagePackManagement(orgId$: Computed<string>) {
  return computed(async (get): Promise<UsagePackManagementResponse | null> => {
    const db = get(db$);
    const orgId = get(orgId$);
    const context = await (async (): Promise<UsagePackChangeContext | null> => {
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
      if (!subscription) {
        return null;
      }
      const usagePackSubscriptionId = subscription.id;
      return await (async () => {
        const allocationColumns = getTableColumns(usagePackAllocations);
        const changeColumns = getTableColumns(usagePackAllocationChanges);
        const allocationSchema = contextProjectionSchema(allocationColumns);
        const changeSchema = contextProjectionSchema(changeColumns);
        const allocations = db
          .select({
            payload: contextJsonProjection(allocationColumns)
              .mapWith(zodDriverValueDecoder(allocationSchema))
              .as("payload"),
          })
          .from(usagePackAllocations)
          .where(
            eq(
              usagePackAllocations.usagePackSubscriptionId,
              usagePackSubscriptionId,
            ),
          );
        const changes = db
          .select({
            payload: contextJsonProjection(changeColumns)
              .mapWith(zodDriverValueDecoder(changeSchema))
              .as("payload"),
          })
          .from(usagePackAllocationChanges)
          .where(
            and(
              eq(
                usagePackAllocationChanges.usagePackSubscriptionId,
                usagePackSubscriptionId,
              ),
              inArray(usagePackAllocationChanges.status, [
                ...OPEN_CHANGE_STATUSES,
              ]),
            ),
          );
        // Allocation replacement and its change-status transition commit together.
        // One statement prevents mixing child rows from either side of that commit.
        const [context] = await db
          .select({
            subscription: usagePackSubscriptions,
            allocations: contextJsonRows(allocations).mapWith(
              zodDriverValueDecoder(allocationSchema.array()),
            ),
            changes: contextJsonRows(changes).mapWith(
              zodDriverValueDecoder(changeSchema.array()),
            ),
          })
          .from(usagePackSubscriptions)
          .where(eq(usagePackSubscriptions.id, usagePackSubscriptionId))
          .limit(1);
        return context ?? null;
      })();
    })();
    return usagePackManagementResponse(context);
  });
}

function usagePackSubscriptionWillEnd(
  subscription: UsagePackChangeSubscriptionInput,
): boolean {
  return (
    subscription.cancel_at_period_end === true ||
    (subscription.cancel_at !== null && subscription.cancel_at !== undefined)
  );
}

function usagePackChangePreviewBlock(
  subscription: UsagePackChangeSubscriptionInput,
  kind: "upgrade" | "downgrade",
): "plan_ending" | null | undefined {
  if (subscription.pending_update) {
    return null;
  }
  if (kind === "downgrade" && usagePackSubscriptionWillEnd(subscription)) {
    return "plan_ending";
  }
  return undefined;
}

function usagePackChangeRecurringPreviewParams(
  subscription: UsagePackChangeSubscriptionInput,
  items: StripeSubscriptionUpdateItemParam[],
  sourcePriceId: string,
  targetPriceId: string,
): StripeInvoiceCreatePreviewParams {
  if (!subscriptionScheduleId(subscription)) {
    return {
      subscription: subscription.id,
      preview_mode: "recurring",
      subscription_details: { items },
    };
  }
  const customerId = stripeObjectId(subscription.customer);
  if (!customerId) {
    throw new Error(`Stripe subscription ${subscription.id} has no customer`);
  }
  const quantities = new Map(packageQuantitiesForSubscription(subscription));
  const sourceQuantity = quantities.get(sourcePriceId);
  if (!sourceQuantity) {
    throw new Error(`Stripe subscription is missing ${sourcePriceId}`);
  }
  if (sourceQuantity === 1) {
    quantities.delete(sourcePriceId);
  } else {
    quantities.set(sourcePriceId, sourceQuantity - 1);
  }
  quantities.set(targetPriceId, (quantities.get(targetPriceId) ?? 0) + 1);
  const discounts = subscriptionPhaseDiscounts(subscription);
  return {
    customer: customerId,
    preview_mode: "recurring",
    discounts: discounts.length > 0 ? discounts : "",
    subscription_details: {
      items: projectedScheduleItems(subscription, quantities),
    },
  };
}

async function previewUsagePackChangeInStripe(
  context: UsagePackChangeContext,
  source: UsagePackAllocationRow,
  stripeSubscriptionId: string,
  targetUsagePackUsd: UsagePackUsd,
  signal: AbortSignal,
): Promise<StripeUsagePackChangePreview | "plan_ending" | null> {
  const targetStripePriceId = activeUsagePackPriceId(targetUsagePackUsd);
  if (!targetStripePriceId) {
    throw new Error(
      `Usage pack $${targetUsagePackUsd} Price is not configured`,
    );
  }
  const stripe = getStripeClient();
  const subscription =
    await stripe.subscriptions.retrieve(stripeSubscriptionId);
  signal.throwIfAborted();
  validateCurrentStripeProjection(context, subscription);
  const kind =
    targetUsagePackUsd > source.usagePackUsd ? "upgrade" : "downgrade";
  const block = usagePackChangePreviewBlock(subscription, kind);
  if (block !== undefined) {
    return block;
  }
  const period = usagePackItemPeriod(subscription);
  const requestedProrationTimestamp = Math.floor(nowDate().getTime() / 1000);
  const prorationTimestamp = Math.min(
    Math.max(requestedProrationTimestamp, period.start),
    period.end - 1,
  );
  const subscriptionWillEnd = usagePackSubscriptionWillEnd(subscription);
  const items = changeUpdateItems(
    subscription,
    source.stripePriceId,
    targetStripePriceId,
  );
  const recurringPreviewPromise = subscriptionWillEnd
    ? null
    : stripe.invoices.createPreview(
        usagePackChangeRecurringPreviewParams(
          subscription,
          items,
          source.stripePriceId,
          targetStripePriceId,
        ),
      );
  const immediatePreviewPromise =
    kind === "upgrade"
      ? stripe.invoices.createPreview({
          subscription: subscription.id,
          preview_mode: "next",
          subscription_details: {
            ...(subscription.cancel_at_period_end === true
              ? { cancel_at_period_end: false }
              : subscription.cancel_at !== null &&
                  subscription.cancel_at !== undefined
                ? { cancel_at: "" as const }
                : {}),
            items,
            proration_behavior: "always_invoice",
            proration_date: prorationTimestamp,
          },
        })
      : null;
  const [recurringPreview, immediatePreview] = await Promise.all([
    recurringPreviewPromise,
    immediatePreviewPromise,
  ]);
  signal.throwIfAborted();
  const currency = recurringPreview?.currency ?? immediatePreview?.currency;
  if (!currency) {
    throw new Error("Stripe usage pack preview has no currency");
  }
  if (
    recurringPreview &&
    immediatePreview &&
    immediatePreview.currency !== currency
  ) {
    throw new Error("Stripe usage pack previews returned different currencies");
  }
  const createdAt = nowDate();
  return {
    kind,
    targetStripePriceId,
    prorationTimestamp,
    immediateAmountCents: immediatePreview
      ? safeInvoiceAmount(immediatePreview, "immediate")
      : 0,
    nextRecurringAmountCents: recurringPreview
      ? safeInvoiceAmount(recurringPreview, "recurring")
      : 0,
    currency,
    effectiveAt:
      kind === "upgrade"
        ? new Date(prorationTimestamp * 1000)
        : new Date(period.end * 1000),
    createdAt,
    expiresAt: new Date(createdAt.getTime() + PREVIEW_TTL_MS),
  };
}

export function usagePackPreviewSubscriptionMatches(
  expected: UsagePackSubscriptionRow,
  current: UsagePackSubscriptionRow,
): boolean {
  return (
    current.id === expected.id &&
    current.orgId === expected.orgId &&
    current.tier === expected.tier &&
    current.stripePlanPriceId === expected.stripePlanPriceId &&
    current.stripeCustomerId === expected.stripeCustomerId &&
    current.stripeSubscriptionId === expected.stripeSubscriptionId &&
    current.subscriptionStatus === expected.subscriptionStatus &&
    current.cancelAtPeriodEnd === expected.cancelAtPeriodEnd &&
    current.currentPeriodStart?.getTime() ===
      expected.currentPeriodStart?.getTime() &&
    current.currentPeriodEnd?.getTime() === expected.currentPeriodEnd?.getTime()
  );
}

function allocationChangePreviewValues(
  context: UsagePackChangeContext,
  source: UsagePackAllocationRow,
  args: UsagePackChangePreviewArgs,
  preview: StripeUsagePackChangePreview,
) {
  return {
    usagePackSubscriptionId: context.subscription.id,
    orgId: args.orgId,
    userId: args.userId,
    sourceAllocationId: source.id,
    kind: preview.kind,
    sourceUsagePackUsd: source.usagePackUsd,
    sourceStripePriceId: source.stripePriceId,
    targetUsagePackUsd: args.targetUsagePackUsd,
    targetStripePriceId: preview.targetStripePriceId,
    prorationTimestamp: preview.prorationTimestamp,
    immediateAmountCents: preview.immediateAmountCents,
    nextRecurringAmountCents: preview.nextRecurringAmountCents,
    currency: preview.currency,
    effectiveAt: preview.effectiveAt,
    previewExpiresAt: preview.expiresAt,
    createdAt: preview.createdAt,
    updatedAt: preview.createdAt,
  };
}

function allocationChangePreviewDefaultSource() {
  return {
    id: sql`gen_random_uuid()`.mapWith(usagePackAllocationChanges.id).as("id"),
    subscriptionChangeId: sql`NULL`
      .mapWith(
        nullableDriverValueDecoder(
          usagePackAllocationChanges.subscriptionChangeId,
        ),
      )
      .as("subscriptionChangeId"),
    replacementAllocationId: sql`NULL`
      .mapWith(
        nullableDriverValueDecoder(
          usagePackAllocationChanges.replacementAllocationId,
        ),
      )
      .as("replacementAllocationId"),
    status: sql`'previewed'`
      .mapWith(usagePackAllocationChanges.status)
      .as("status"),
    stripeInvoiceId: sql`NULL`
      .mapWith(
        nullableDriverValueDecoder(usagePackAllocationChanges.stripeInvoiceId),
      )
      .as("stripeInvoiceId"),
    stripeScheduleId: sql`NULL`
      .mapWith(
        nullableDriverValueDecoder(usagePackAllocationChanges.stripeScheduleId),
      )
      .as("stripeScheduleId"),
    stripePendingUpdateExpiresAt: sql`NULL`
      .mapWith(
        nullableDriverValueDecoder(
          usagePackAllocationChanges.stripePendingUpdateExpiresAt,
        ),
      )
      .as("stripePendingUpdateExpiresAt"),
    failureReason: sql`NULL`
      .mapWith(
        nullableDriverValueDecoder(usagePackAllocationChanges.failureReason),
      )
      .as("failureReason"),
    completedAt: sql`NULL`
      .mapWith(
        nullableDriverValueDecoder(usagePackAllocationChanges.completedAt),
      )
      .as("completedAt"),
  };
}

function allocationChangePreviewSource(
  values: ReturnType<typeof allocationChangePreviewValues>,
) {
  const defaults = allocationChangePreviewDefaultSource();
  return {
    id: defaults.id,
    usagePackSubscriptionId:
      sql`${sql.param(values.usagePackSubscriptionId, usagePackAllocationChanges.usagePackSubscriptionId)}`
        .mapWith(usagePackAllocationChanges.usagePackSubscriptionId)
        .as("usagePackSubscriptionId"),
    subscriptionChangeId: defaults.subscriptionChangeId,
    orgId: sql`${sql.param(values.orgId, usagePackAllocationChanges.orgId)}`
      .mapWith(usagePackAllocationChanges.orgId)
      .as("orgId"),
    userId: sql`${sql.param(values.userId, usagePackAllocationChanges.userId)}`
      .mapWith(usagePackAllocationChanges.userId)
      .as("userId"),
    sourceAllocationId:
      sql`${sql.param(values.sourceAllocationId, usagePackAllocationChanges.sourceAllocationId)}`
        .mapWith(
          nullableDriverValueDecoder(
            usagePackAllocationChanges.sourceAllocationId,
          ),
        )
        .as("sourceAllocationId"),
    replacementAllocationId: defaults.replacementAllocationId,
    kind: sql`${sql.param(values.kind, usagePackAllocationChanges.kind)}`
      .mapWith(usagePackAllocationChanges.kind)
      .as("kind"),
    status: defaults.status,
    sourceUsagePackUsd:
      sql`${sql.param(values.sourceUsagePackUsd, usagePackAllocationChanges.sourceUsagePackUsd)}`
        .mapWith(
          nullableDriverValueDecoder(
            usagePackAllocationChanges.sourceUsagePackUsd,
          ),
        )
        .as("sourceUsagePackUsd"),
    sourceStripePriceId:
      sql`${sql.param(values.sourceStripePriceId, usagePackAllocationChanges.sourceStripePriceId)}`
        .mapWith(
          nullableDriverValueDecoder(
            usagePackAllocationChanges.sourceStripePriceId,
          ),
        )
        .as("sourceStripePriceId"),
    targetUsagePackUsd:
      sql`${sql.param(values.targetUsagePackUsd, usagePackAllocationChanges.targetUsagePackUsd)}`
        .mapWith(
          nullableDriverValueDecoder(
            usagePackAllocationChanges.targetUsagePackUsd,
          ),
        )
        .as("targetUsagePackUsd"),
    targetStripePriceId:
      sql`${sql.param(values.targetStripePriceId, usagePackAllocationChanges.targetStripePriceId)}`
        .mapWith(
          nullableDriverValueDecoder(
            usagePackAllocationChanges.targetStripePriceId,
          ),
        )
        .as("targetStripePriceId"),
    prorationTimestamp:
      sql`${sql.param(values.prorationTimestamp, usagePackAllocationChanges.prorationTimestamp)}`
        .mapWith(
          nullableDriverValueDecoder(
            usagePackAllocationChanges.prorationTimestamp,
          ),
        )
        .as("prorationTimestamp"),
    immediateAmountCents:
      sql`${sql.param(values.immediateAmountCents, usagePackAllocationChanges.immediateAmountCents)}`
        .mapWith(
          nullableDriverValueDecoder(
            usagePackAllocationChanges.immediateAmountCents,
          ),
        )
        .as("immediateAmountCents"),
    nextRecurringAmountCents:
      sql`${sql.param(values.nextRecurringAmountCents, usagePackAllocationChanges.nextRecurringAmountCents)}`
        .mapWith(
          nullableDriverValueDecoder(
            usagePackAllocationChanges.nextRecurringAmountCents,
          ),
        )
        .as("nextRecurringAmountCents"),
    currency:
      sql`${sql.param(values.currency, usagePackAllocationChanges.currency)}`
        .mapWith(
          nullableDriverValueDecoder(usagePackAllocationChanges.currency),
        )
        .as("currency"),
    effectiveAt:
      sql`${sql.param(values.effectiveAt, usagePackAllocationChanges.effectiveAt)}`
        .mapWith(
          nullableDriverValueDecoder(usagePackAllocationChanges.effectiveAt),
        )
        .as("effectiveAt"),
    previewExpiresAt:
      sql`${sql.param(values.previewExpiresAt, usagePackAllocationChanges.previewExpiresAt)}`
        .mapWith(
          nullableDriverValueDecoder(
            usagePackAllocationChanges.previewExpiresAt,
          ),
        )
        .as("previewExpiresAt"),
    stripeInvoiceId: defaults.stripeInvoiceId,
    stripeScheduleId: defaults.stripeScheduleId,
    stripePendingUpdateExpiresAt: defaults.stripePendingUpdateExpiresAt,
    failureReason: defaults.failureReason,
    completedAt: defaults.completedAt,
    createdAt:
      sql`${sql.param(values.createdAt, usagePackAllocationChanges.createdAt)}`
        .mapWith(usagePackAllocationChanges.createdAt)
        .as("createdAt"),
    updatedAt:
      sql`${sql.param(values.updatedAt, usagePackAllocationChanges.updatedAt)}`
        .mapWith(usagePackAllocationChanges.updatedAt)
        .as("updatedAt"),
  };
}

const usagePackPreviewRetirementFailure = object({
  code: literal("22012"),
});

const persistUsagePackChangePreview$ = command(
  async (
    { set },
    input: {
      readonly context: UsagePackChangeContext;
      readonly source: UsagePackAllocationRow;
      readonly args: UsagePackChangePreviewArgs;
      readonly preview: StripeUsagePackChangePreview;
    },
    signal: AbortSignal,
  ): Promise<UsagePackAllocationChangeRow | undefined> => {
    const { context, source, args, preview } = input;
    const db = set(writeDb$);
    // A quote is not accepted financial intent. Existing uniqueness handles
    // competing quotes; confirmation revalidates before claiming payment.
    const [root] = await db
      .select()
      .from(usagePackSubscriptions)
      .where(
        and(
          eq(usagePackSubscriptions.orgId, args.orgId),
          eq(usagePackSubscriptions.id, context.subscription.id),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (
      !root ||
      !usagePackPreviewSubscriptionMatches(context.subscription, root)
    ) {
      return undefined;
    }
    // A Plan preview may have committed while Stripe prepared these prices.
    // This observation rejects an already-visible competing quote; it is not
    // cross-table payment arbitration.
    const [planChange] = await db
      .select({ id: usagePackSubscriptionChanges.id })
      .from(usagePackSubscriptionChanges)
      .where(
        and(
          eq(usagePackSubscriptionChanges.orgId, args.orgId),
          inArray(usagePackSubscriptionChanges.status, [
            "previewed",
            "applying",
            "pending_payment",
          ]),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (planChange) {
      return undefined;
    }
    // Observe and retire the same expiry set. If a waiting UPDATE loses a row
    // to a completed competing change, reject publication from this statement's
    // older source snapshot instead of publishing a stale quote.
    const expiryCondition = and(
      eq(usagePackAllocationChanges.orgId, args.orgId),
      eq(usagePackAllocationChanges.status, "previewed"),
      lte(usagePackAllocationChanges.previewExpiresAt, preview.createdAt),
    );
    const expiring = db
      .$with("expiring_allocation_previews")
      .as(
        db
          .select({ id: usagePackAllocationChanges.id })
          .from(usagePackAllocationChanges)
          .where(expiryCondition),
      );
    const retired = db.$with("retired_allocation_previews").as(
      db
        .update(usagePackAllocationChanges)
        .set({
          status: "failed",
          failureReason: "preview_expired",
          completedAt: preview.createdAt,
          updatedAt: preview.createdAt,
        })
        .where(
          and(
            expiryCondition,
            inArray(
              usagePackAllocationChanges.id,
              db.select({ id: expiring.id }).from(expiring),
            ),
          ),
        )
        .returning({ id: usagePackAllocationChanges.id }),
    );
    const allRetired = eq(
      db.select({ count: count() }).from(retired),
      db.select({ count: count() }).from(expiring),
    );
    const previewSource = allocationChangePreviewSource(
      allocationChangePreviewValues(context, source, args, preview),
    );
    const result = await settle(
      db
        .with(expiring, retired)
        .insert(usagePackAllocationChanges)
        .select(
          db
            .select(previewSource)
            .from(usagePackAllocations)
            .where(
              and(
                eq(usagePackAllocations.id, source.id),
                eq(usagePackAllocations.status, "active"),
                eq(usagePackAllocations.orgId, args.orgId),
                eq(usagePackAllocations.userId, args.userId),
                eq(
                  usagePackAllocations.usagePackSubscriptionId,
                  context.subscription.id,
                ),
                eq(usagePackAllocations.usagePackUsd, source.usagePackUsd),
                eq(usagePackAllocations.stripePriceId, source.stripePriceId),
                eq(sql`1 / CASE WHEN ${allRetired} THEN 1 ELSE 0 END`, 1),
              ),
            ),
        )
        .onConflictDoNothing()
        .returning(),
    );
    signal.throwIfAborted();
    if (result.ok) {
      return result.value[0];
    }
    // This statement emits 22012 only when competing retirement wins. Its
    // rollback preserves atomicity; the caller exposes the usual conflict.
    if (
      result.error instanceof DrizzleQueryError &&
      usagePackPreviewRetirementFailure.safeParse(result.error.cause).success
    ) {
      return undefined;
    }
    throw result.error;
  },
);

const usagePackAllocationPreviewContext$ = command(
  async (
    { set },
    orgId: string,
    signal: AbortSignal,
  ): Promise<UsagePackChangeContext | null> => {
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
    const [allocations, changes] = await Promise.all([
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
              ...OPEN_CHANGE_STATUSES,
            ]),
          ),
        ),
    ]);
    signal.throwIfAborted();
    return { subscription, allocations, changes };
  },
);

function storedUsagePackChangePreview(
  change: UsagePackAllocationChangeRow,
): UsagePackChangePreviewResponse {
  if (
    (change.kind !== "upgrade" && change.kind !== "downgrade") ||
    change.sourceUsagePackUsd === null ||
    change.targetUsagePackUsd === null ||
    change.immediateAmountCents === null ||
    change.nextRecurringAmountCents === null ||
    change.currency === null ||
    change.effectiveAt === null ||
    change.prorationTimestamp === null ||
    change.previewExpiresAt === null
  ) {
    throw new Error(`Usage pack change ${change.id} has no preview snapshot`);
  }
  return {
    changeId: change.id,
    kind: change.kind,
    sourceUsagePackUsd: usagePackUsd(change.sourceUsagePackUsd),
    targetUsagePackUsd: usagePackUsd(change.targetUsagePackUsd),
    immediateAmountCents: change.immediateAmountCents,
    nextRecurringAmountCents: change.nextRecurringAmountCents,
    currency: change.currency,
    effectiveAt: change.effectiveAt.toISOString(),
    prorationDate: new Date(change.prorationTimestamp * 1000).toISOString(),
    expiresAt: (
      change.stripePendingUpdateExpiresAt ?? change.previewExpiresAt
    ).toISOString(),
  };
}

/**
 * A quote prices changes against Stripe's current items. Converge any
 * temporary configuration drift from the accepted local records first, so a
 * stale late write is repaired instead of blocking the member's change. A
 * failed repair leaves the quote's own quantity validation authoritative.
 */
const repairUsagePackConfigurationBeforeQuote$ = command(
  async (
    { set },
    usagePackSubscriptionId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const repaired = await settle(
      set(
        syncUsagePackSubscriptionConfiguration$,
        usagePackSubscriptionId,
        signal,
      ),
      signal,
    );
    if (!repaired.ok) {
      L.warn("usage pack configuration repair before quote failed", {
        usagePackSubscriptionId,
        error: repaired.error,
      });
    }
  },
);

export const previewUsagePackAllocationChange$ = command(
  async (
    { set },
    args: UsagePackChangePreviewArgs,
    signal: AbortSignal,
  ): Promise<UsagePackChangePreviewResult> => {
    const db = set(writeDb$);
    const [openSubscriptionChange] = await db
      .select({ id: usagePackSubscriptionChanges.id })
      .from(usagePackSubscriptionChanges)
      .where(
        and(
          eq(usagePackSubscriptionChanges.orgId, args.orgId),
          inArray(usagePackSubscriptionChanges.status, [
            "previewed",
            "applying",
            "pending_payment",
          ]),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (openSubscriptionChange) {
      return { status: "conflict" };
    }
    const context = await set(
      usagePackAllocationPreviewContext$,
      args.orgId,
      signal,
    );
    const stripeSubscriptionId = context?.subscription.stripeSubscriptionId;
    if (!context || !stripeSubscriptionId) {
      return { status: "not_found" };
    }
    const existing = context.changes.find((change) => {
      return (
        change.subscriptionChangeId === null && change.userId === args.userId
      );
    });
    if (
      existing &&
      (existing.status !== "previewed" ||
        (existing.previewExpiresAt !== null &&
          existing.previewExpiresAt > nowDate()))
    ) {
      return existing.targetUsagePackUsd === args.targetUsagePackUsd
        ? { status: "ready", preview: storedUsagePackChangePreview(existing) }
        : { status: "conflict" };
    }
    const source = activeAllocationForMember(context, args.userId);
    if (!source) {
      return { status: "not_found" };
    }
    if (source.usagePackUsd === args.targetUsagePackUsd) {
      return { status: "same_package" };
    }
    if (
      context.subscription.cancelAtPeriodEnd &&
      args.targetUsagePackUsd < source.usagePackUsd
    ) {
      return { status: "plan_ending" };
    }
    await set(
      repairUsagePackConfigurationBeforeQuote$,
      context.subscription.id,
      signal,
    );
    const preview = await previewUsagePackChangeInStripe(
      context,
      source,
      stripeSubscriptionId,
      args.targetUsagePackUsd,
      signal,
    );
    if (preview === "plan_ending") {
      return { status: "plan_ending" };
    }
    if (!preview) {
      return { status: "conflict" };
    }
    const change = await set(
      persistUsagePackChangePreview$,
      { context, source, args, preview },
      signal,
    );
    if (!change) {
      return { status: "conflict" };
    }
    return {
      status: "ready",
      preview: {
        changeId: change.id,
        kind: preview.kind,
        sourceUsagePackUsd: usagePackUsd(source.usagePackUsd),
        targetUsagePackUsd: args.targetUsagePackUsd,
        immediateAmountCents: preview.immediateAmountCents,
        nextRecurringAmountCents: preview.nextRecurringAmountCents,
        currency: preview.currency,
        effectiveAt: preview.effectiveAt.toISOString(),
        prorationDate: new Date(
          preview.prorationTimestamp * 1000,
        ).toISOString(),
        expiresAt: preview.expiresAt.toISOString(),
      },
    };
  },
);

function subscriptionPhaseDiscounts(
  subscription: UsagePackChangeSubscriptionInput,
): StripeSchedulePhaseDiscountParam[] {
  const discounts = subscription.discounts ?? [];
  return discounts.flatMap((discount) => {
    const id = stripeObjectId(discount);
    return id ? [{ discount: id }] : [];
  });
}

function subscriptionRecurringDuration(
  subscription: UsagePackChangeSubscriptionInput,
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

function projectedPackageQuantities(
  context: UsagePackChangeContext,
  proposedChange: UsagePackAllocationChangeRow,
): ReadonlyMap<string, number> {
  const packageByOwner = new Map<string, string>();
  for (const allocation of context.allocations) {
    if (!isProjectedUsagePackAllocation(allocation)) {
      continue;
    }
    packageByOwner.set(
      allocationOwnerKey(allocation),
      allocation.stripePriceId,
    );
  }
  const scheduledChanges = [
    ...context.changes.filter((change) => {
      return change.status === "scheduled" && change.id !== proposedChange.id;
    }),
    proposedChange,
  ];
  for (const change of scheduledChanges) {
    const ownerKey = `user:${change.userId}`;
    if (change.kind === "removal") {
      packageByOwner.delete(ownerKey);
    } else if (change.targetStripePriceId) {
      packageByOwner.set(ownerKey, change.targetStripePriceId);
    }
  }

  const quantities = new Map<string, number>();
  for (const priceId of packageByOwner.values()) {
    quantities.set(priceId, (quantities.get(priceId) ?? 0) + 1);
  }
  return quantities;
}

function projectedScheduleItems(
  subscription: UsagePackChangeSubscriptionInput,
  quantities: ReadonlyMap<string, number>,
): StripeSchedulePhaseItemParam[] {
  const preservedItems = subscription.items.data
    .filter((item) => {
      return usagePackUsdForKnownPriceId(item.price.id) === null;
    })
    .map((item) => {
      return { price: item.price.id, quantity: item.quantity ?? 1 };
    });
  return [
    ...preservedItems,
    ...[...quantities].map(([price, quantity]) => {
      return { price, quantity };
    }),
  ];
}

function subscriptionProjectionUpdateItems(
  subscription: UsagePackChangeSubscriptionInput,
  quantities: ReadonlyMap<string, number>,
): StripeSubscriptionUpdateItemParam[] {
  const remaining = new Map(quantities);
  const items: StripeSubscriptionUpdateItemParam[] = [];
  for (const item of subscription.items.data) {
    if (usagePackUsdForKnownPriceId(item.price.id) === null) {
      continue;
    }
    const quantity = remaining.get(item.price.id);
    remaining.delete(item.price.id);
    items.push(
      quantity
        ? { id: subscriptionItemId(item), quantity }
        : { id: subscriptionItemId(item), deleted: true },
    );
  }
  return [
    ...items,
    ...[...remaining].map(([price, quantity]) => {
      return { price, quantity };
    }),
  ];
}

function projectionFingerprint(
  quantities: ReadonlyMap<string, number>,
): string {
  return [...quantities]
    .map(([priceId, quantity]) => {
      const packageUsd = usagePackUsdForKnownPriceId(priceId);
      if (packageUsd === null) {
        throw new Error(`Unknown usage pack Price ${priceId}`);
      }
      return `${packageUsd}-${quantity}`;
    })
    .sort()
    .join("_");
}

export interface UsagePackAllocationAdditionPreview {
  readonly amountCents: number;
  readonly currency: string;
  readonly currentPeriodStart: Date;
  readonly currentPeriodEnd: Date;
  readonly prorationTimestamp: number;
}

export interface UsagePackAllocationAdditionChargePreview extends UsagePackAllocationAdditionPreview {
  readonly automaticTax: StripeInvoiceAutomaticTaxParam | null;
  readonly invoiceItems: readonly {
    readonly amountCents: number;
    readonly taxRateIds: readonly string[];
  }[];
}

interface UsagePackAllocationAdditionArgs {
  readonly usagePackSubscriptionId: string;
  readonly stripePriceId: string;
  readonly prorationTimestamp?: number;
}

async function previewUsagePackAllocationAdditionForContext(
  context: UsagePackChangeContext | null,
  args: UsagePackAllocationAdditionArgs,
  signal: AbortSignal,
): Promise<UsagePackAllocationAdditionChargePreview> {
  const stripeSubscriptionId = context?.subscription.stripeSubscriptionId;
  if (!context || !stripeSubscriptionId) {
    throw new Error("Usage pack subscription is not ready");
  }
  const stripe = getStripeClient();
  const subscription =
    await stripe.subscriptions.retrieve(stripeSubscriptionId);
  signal.throwIfAborted();
  validateCurrentStripeProjection(context, subscription);
  if (subscription.pending_update) {
    throw new Error("Usage pack subscription has a pending payment update");
  }
  const period = usagePackItemPeriod(subscription);
  const requestedTimestamp =
    args.prorationTimestamp ?? Math.floor(nowDate().getTime() / 1000);
  if (
    !Number.isSafeInteger(requestedTimestamp) ||
    (args.prorationTimestamp !== undefined &&
      (requestedTimestamp < period.start || requestedTimestamp >= period.end))
  ) {
    throw new Error("Usage pack invitation proration timestamp is invalid");
  }
  const prorationTimestamp = Math.min(
    Math.max(requestedTimestamp, period.start),
    period.end - 1,
  );
  const target = subscription.items.data.find((item) => {
    return item.price.id === args.stripePriceId;
  });
  const currentQuantity = target ? (target.quantity ?? 1) : 0;
  if (!Number.isSafeInteger(currentQuantity) || currentQuantity < 0) {
    throw new Error("Usage pack subscription has an invalid quantity");
  }
  const preview = await stripe.invoices.createPreview({
    subscription: subscription.id,
    preview_mode: "next",
    subscription_details: {
      items: [
        target
          ? {
              id: subscriptionItemId(target),
              quantity: currentQuantity + 1,
            }
          : { price: args.stripePriceId, quantity: 1 },
      ],
      proration_behavior: "always_invoice",
      proration_date: prorationTimestamp,
    },
  });
  signal.throwIfAborted();
  const previewLines = await listCompleteInvoiceLines(stripe, preview, signal);
  signal.throwIfAborted();
  const charge = usagePackAllocationAdditionCharge(
    preview,
    previewLines,
    args.stripePriceId,
    prorationTimestamp,
  );
  return {
    ...charge,
    currency: preview.currency,
    currentPeriodStart: new Date(period.start * 1000),
    currentPeriodEnd: new Date(period.end * 1000),
    prorationTimestamp,
  };
}

export const previewUsagePackAllocationAddition$ = command(
  async (
    { set },
    args: UsagePackAllocationAdditionArgs,
    signal: AbortSignal,
  ): Promise<UsagePackAllocationAdditionChargePreview> => {
    const db = set(writeDb$);
    const [subscription] = await db
      .select()
      .from(usagePackSubscriptions)
      .where(eq(usagePackSubscriptions.id, args.usagePackSubscriptionId))
      .limit(1);
    signal.throwIfAborted();
    if (!subscription) {
      throw new Error("Usage pack subscription is not ready");
    }
    const [allocations, changes] = await Promise.all([
      db
        .select()
        .from(usagePackAllocations)
        .where(
          eq(
            usagePackAllocations.usagePackSubscriptionId,
            args.usagePackSubscriptionId,
          ),
        ),
      db
        .select()
        .from(usagePackAllocationChanges)
        .where(
          and(
            eq(
              usagePackAllocationChanges.usagePackSubscriptionId,
              args.usagePackSubscriptionId,
            ),
            inArray(usagePackAllocationChanges.status, [
              ...OPEN_CHANGE_STATUSES,
            ]),
          ),
        ),
    ]);
    signal.throwIfAborted();
    await set(
      repairUsagePackConfigurationBeforeQuote$,
      args.usagePackSubscriptionId,
      signal,
    );
    return await previewUsagePackAllocationAdditionForContext(
      { subscription, allocations, changes },
      args,
      signal,
    );
  },
);

/**
 * An operation-owned projection keeps its idempotency key. An identity-only
 * configuration repair sends none: it sets absolute quantities, so replay is
 * harmless, while a reused key could suppress a later repair of the same drift.
 */
function projectionRequestOptions(
  operationId: string | null,
  projectionId: string,
  target: "schedule" | "subscription",
): { readonly idempotencyKey: string } | undefined {
  return operationId
    ? {
        idempotencyKey: `usage-pack-projection:${operationId}:${projectionId}:${target}`,
      }
    : undefined;
}

async function syncUsagePackProjection(
  subscription: UsagePackChangeSubscriptionInput,
  args: {
    readonly currentQuantities: ReadonlyMap<string, number>;
    readonly renewalQuantities: ReadonlyMap<string, number>;
    readonly operationId: string | null;
    readonly schedule?: StripeSubscriptionSchedule;
  },
  signal?: AbortSignal,
): Promise<void> {
  if (args.currentQuantities.size === 0) {
    throw new Error("A usage pack subscription must retain a package");
  }
  if (args.renewalQuantities.size === 0) {
    throw new Error("A usage pack subscription must renew with a package");
  }
  const projectionId = `${projectionFingerprint(args.currentQuantities)}:${projectionFingerprint(args.renewalQuantities)}`;
  const stripe = getStripeClient();
  const scheduleId = subscriptionScheduleId(subscription);
  if (scheduleId) {
    const schedule =
      args.schedule ??
      (await stripe.subscriptionSchedules.retrieve(scheduleId));
    signal?.throwIfAborted();
    await stripe.subscriptionSchedules.update(
      scheduleId,
      {
        end_behavior: "release",
        proration_behavior: "none",
        phases: projectedUsagePackSchedulePhases(subscription, schedule, args),
      },
      projectionRequestOptions(args.operationId, projectionId, "schedule"),
    );
  } else if (
    !quantitiesMatch(
      args.currentQuantities,
      packageQuantitiesForSubscription(subscription),
    )
  ) {
    await stripe.subscriptions.update(
      subscription.id,
      {
        items: subscriptionProjectionUpdateItems(
          subscription,
          args.currentQuantities,
        ),
        proration_behavior: "none",
      },
      projectionRequestOptions(args.operationId, projectionId, "subscription"),
    );
  }
  signal?.throwIfAborted();
}

const USAGE_PACK_CONFIGURATION_SWEEP_PAGE_SIZE = 100;
const USAGE_PACK_CONFIGURATION_SWEEP_BUCKETS = 24;
const FINANCIAL_ALLOCATION_CHANGE_STATUSES = [
  "applying",
  "pending_payment",
] as const;
const FINANCIAL_PLAN_CHANGE_STATUSES = ["applying", "pending_payment"] as const;
const OPEN_MIGRATION_STATUSES = ["applying", "revising", "scheduled"] as const;

export type UsagePackConfigurationSyncResult =
  | { readonly status: "unchanged" | "updated" }
  | {
      readonly status: "deferred";
      readonly reason:
        | "missing_subscription"
        | "financial_change_in_flight"
        | "migration_in_flight"
        | "stripe_pending_update"
        | "empty_projection"
        | "scheduled_plan_change"
        | "missing_renewal_schedule";
    };

interface UsagePackConfigurationSource {
  readonly context: UsagePackChangeContext;
  readonly financialChangeInFlight: boolean;
  readonly migrationInFlight: boolean;
}

/**
 * Reads the accepted local business records that declare one usage pack
 * subscription's Stripe configuration. No transaction is needed: the result is
 * a point-in-time projection and every later sync reloads it again.
 */
const loadUsagePackConfigurationSource$ = command(
  async (
    { set },
    usagePackSubscriptionId: string,
    signal?: AbortSignal,
  ): Promise<UsagePackConfigurationSource | null> => {
    const db = set(writeDb$);
    const [subscription] = await db
      .select()
      .from(usagePackSubscriptions)
      .where(eq(usagePackSubscriptions.id, usagePackSubscriptionId))
      .limit(1);
    signal?.throwIfAborted();
    if (
      !subscription?.stripeSubscriptionId ||
      TERMINAL_SUBSCRIPTION_STATUSES.some((status) => {
        return subscription.subscriptionStatus === status;
      })
    ) {
      return null;
    }
    const [allocations, changes, planChanges, migrations] = await Promise.all([
      db
        .select()
        .from(usagePackAllocations)
        .where(
          eq(
            usagePackAllocations.usagePackSubscriptionId,
            usagePackSubscriptionId,
          ),
        ),
      db
        .select()
        .from(usagePackAllocationChanges)
        .where(
          and(
            eq(
              usagePackAllocationChanges.usagePackSubscriptionId,
              usagePackSubscriptionId,
            ),
            inArray(usagePackAllocationChanges.status, [
              ...OPEN_CHANGE_STATUSES,
            ]),
          ),
        ),
      db
        .select({ id: usagePackSubscriptionChanges.id })
        .from(usagePackSubscriptionChanges)
        .where(
          and(
            eq(
              usagePackSubscriptionChanges.usagePackSubscriptionId,
              usagePackSubscriptionId,
            ),
            inArray(usagePackSubscriptionChanges.status, [
              ...FINANCIAL_PLAN_CHANGE_STATUSES,
            ]),
          ),
        )
        .limit(1),
      db
        .select({ id: usagePackSubscriptionMigrations.id })
        .from(usagePackSubscriptionMigrations)
        .where(
          and(
            eq(
              usagePackSubscriptionMigrations.stripeSubscriptionId,
              subscription.stripeSubscriptionId,
            ),
            inArray(usagePackSubscriptionMigrations.status, [
              ...OPEN_MIGRATION_STATUSES,
            ]),
          ),
        )
        .limit(1),
    ]);
    signal?.throwIfAborted();
    return {
      context: { subscription, allocations, changes },
      financialChangeInFlight:
        planChanges.length > 0 ||
        changes.some((change) => {
          return FINANCIAL_ALLOCATION_CHANGE_STATUSES.some((status) => {
            return change.status === status;
          });
        }),
      migrationInFlight: migrations.length > 0,
    };
  },
);

/**
 * Pure projection of accepted local records: current recurring packages and
 * the packages that renew after already-scheduled changes. A previewed quote
 * is not intent and does not participate.
 */
function desiredUsagePackConfiguration(context: UsagePackChangeContext): {
  readonly current: ReadonlyMap<string, number>;
  readonly renewal: ReadonlyMap<string, number>;
} {
  return {
    current: packageQuantitiesForAllocations(context.allocations),
    renewal: projectedQuantitiesAfterChanges(
      context,
      context.changes.filter((change) => {
        return change.status === "scheduled";
      }),
    ),
  };
}

function schedulePhaseQuantities(
  phase: StripeSchedulePhase | undefined,
  kind: "package" | "other",
): ReadonlyMap<string, number> {
  const quantities = new Map<string, number>();
  for (const item of phase?.items ?? []) {
    const priceId = stripeObjectId(item.price);
    if (
      !priceId ||
      (usagePackUsdForKnownPriceId(priceId) === null) !== (kind === "other")
    ) {
      continue;
    }
    quantities.set(
      priceId,
      (quantities.get(priceId) ?? 0) + (item.quantity ?? 1),
    );
  }
  return quantities;
}

/**
 * Stripe's current phase and the single phase that follows it. A schedule
 * releasing after its current phase renews with that phase's items. More
 * future phases belong to another workflow and are not rewritten here.
 */
function currentAndRenewalSchedulePhases(
  schedule: StripeSubscriptionSchedule,
  at: Date,
): {
  readonly current: StripeSchedulePhase;
  readonly renewal: StripeSchedulePhase;
} | null {
  const seconds = Math.floor(at.getTime() / 1000);
  const index = schedule.phases.findIndex((phase) => {
    return (
      phase.start_date === schedule.current_phase?.start_date &&
      phase.end_date === schedule.current_phase.end_date
    );
  });
  const current = schedule.phases[index];
  const renewal = schedule.phases[index + 1];
  if (
    !current ||
    schedule.end_behavior !== "release" ||
    schedule.phases.length - index > 2 ||
    current.start_date > seconds ||
    current.end_date <= seconds ||
    (renewal && renewal.start_date !== current.end_date)
  ) {
    return null;
  }
  return { current, renewal: renewal ?? current };
}

function projectedPhaseItems(
  phase: StripeSchedulePhaseParam,
  quantities: ReadonlyMap<string, number>,
): StripeSchedulePhaseItemParam[] {
  const existing = new Map(
    phase.items.map((item) => {
      return [item.price, item];
    }),
  );
  return [
    ...phase.items.filter((item) => {
      return usagePackUsdForKnownPriceId(item.price) === null;
    }),
    ...[...quantities].map(([price, quantity]) => {
      return { ...existing.get(price), price, quantity };
    }),
  ];
}

function projectedUsagePackSchedulePhases(
  subscription: UsagePackChangeSubscriptionInput,
  schedule: StripeSubscriptionSchedule,
  args: {
    readonly currentQuantities: ReadonlyMap<string, number>;
    readonly renewalQuantities: ReadonlyMap<string, number>;
  },
): StripeSchedulePhaseParam[] {
  const phases = currentAndRenewalSchedulePhases(schedule, nowDate());
  const period = usagePackItemPeriod(subscription);
  if (!phases || phases.current.end_date !== period.end) {
    throw new Error(
      "Stripe usage pack schedule does not match the current period",
    );
  }
  // Billing periods can start before the current schedule phase after a
  // mid-period update. Retain Stripe's writable phase boundaries and settings.
  const [current, renewal] = subscriptionSchedulePhasesEndingAt(
    schedule,
    phases.renewal.end_date,
  );
  if (!current) {
    throw new Error("Stripe usage pack schedule has no current phase");
  }
  const projected = [
    {
      ...current,
      items: projectedPhaseItems(current, args.currentQuantities),
    },
  ];
  if (renewal) {
    projected.push({
      ...renewal,
      items: projectedPhaseItems(renewal, args.renewalQuantities),
    });
  } else if (!quantitiesMatch(args.currentQuantities, args.renewalQuantities)) {
    const { end_date: startDate, ...settings } = current;
    projected.push({
      ...settings,
      start_date: startDate,
      duration: subscriptionRecurringDuration(subscription),
      items: projectedPhaseItems(current, args.renewalQuantities),
    });
  }
  return projected;
}

function subscriptionOtherQuantities(
  subscription: UsagePackChangeSubscriptionInput,
): ReadonlyMap<string, number> {
  const quantities = new Map<string, number>();
  for (const item of subscription.items.data) {
    if (usagePackUsdForKnownPriceId(item.price.id) !== null) {
      continue;
    }
    quantities.set(
      item.price.id,
      (quantities.get(item.price.id) ?? 0) + (item.quantity ?? 1),
    );
  }
  return quantities;
}

/**
 * Converges one usage pack Stripe subscription to the latest accepted local
 * business records. It carries only the subscription identity, reloads local
 * intent each time and never replays a caller's captured quantities, so a late
 * stale write is repaired by any later sync. Repairs use no proration and never
 * create invoices, grants or refunds. Paid operations still in flight own their
 * payment workflow; the sync defers instead of replacing their invoice.
 */
export const syncUsagePackSubscriptionConfiguration$ = command(
  async (
    { set },
    usagePackSubscriptionId: string,
    signal?: AbortSignal,
  ): Promise<UsagePackConfigurationSyncResult> => {
    const source = await set(
      loadUsagePackConfigurationSource$,
      usagePackSubscriptionId,
      signal,
    );
    const stripeSubscriptionId =
      source?.context.subscription.stripeSubscriptionId;
    if (!source || !stripeSubscriptionId) {
      return { status: "deferred", reason: "missing_subscription" };
    }
    if (source.financialChangeInFlight) {
      return { status: "deferred", reason: "financial_change_in_flight" };
    }
    if (source.migrationInFlight) {
      return { status: "deferred", reason: "migration_in_flight" };
    }
    const desired = desiredUsagePackConfiguration(source.context);
    if (desired.current.size === 0 || desired.renewal.size === 0) {
      return { status: "deferred", reason: "empty_projection" };
    }
    const stripe = getStripeClient();
    const subscription = (await stripe.subscriptions.retrieve(
      stripeSubscriptionId,
    )) as UsagePackChangeSubscriptionInput;
    signal?.throwIfAborted();
    validateStripeSubscriptionIdentity(source.context, subscription);
    if (subscription.pending_update) {
      return { status: "deferred", reason: "stripe_pending_update" };
    }
    const currentMatches = quantitiesMatch(
      desired.current,
      packageQuantitiesForSubscription(subscription),
    );
    const scheduleId = subscriptionScheduleId(subscription);
    if (!scheduleId) {
      if (!currentMatches) {
        await syncUsagePackProjection(
          subscription,
          {
            currentQuantities: desired.current,
            renewalQuantities: desired.current,
            operationId: null,
          },
          signal,
        );
      }
      if (!quantitiesMatch(desired.current, desired.renewal)) {
        return { status: "deferred", reason: "missing_renewal_schedule" };
      }
      return { status: currentMatches ? "unchanged" : "updated" };
    }
    const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId);
    signal?.throwIfAborted();
    const phases = currentAndRenewalSchedulePhases(schedule, nowDate());
    if (
      !phases ||
      !quantitiesMatch(
        schedulePhaseQuantities(phases.renewal, "other"),
        subscriptionOtherQuantities(subscription),
      )
    ) {
      return { status: "deferred", reason: "scheduled_plan_change" };
    }
    if (
      currentMatches &&
      quantitiesMatch(
        schedulePhaseQuantities(phases.current, "package"),
        desired.current,
      ) &&
      quantitiesMatch(
        schedulePhaseQuantities(phases.renewal, "package"),
        desired.renewal,
      )
    ) {
      return { status: "unchanged" };
    }
    await syncUsagePackProjection(
      subscription,
      {
        currentQuantities: desired.current,
        renewalQuantities: desired.renewal,
        operationId: null,
        schedule,
      },
      signal,
    );
    return { status: "updated" };
  },
);

/**
 * Daily configuration reconciliation. The hourly billing cron visits one of
 * 24 stable identity buckets, so every active subscription is compared at
 * least once per day without a dirty flag or cursor column. Scoped runs visit
 * every subscription of the requested organizations. Paging happens outside
 * any transaction and each identity is synced independently.
 */
export const syncUsagePackSubscriptionConfigurations$ = command(
  async (
    { set },
    signal: AbortSignal,
  ): Promise<{ readonly updated: number; readonly failed: number }> => {
    const db = set(writeDb$);
    const bucket =
      nowDate().getUTCHours() % USAGE_PACK_CONFIGURATION_SWEEP_BUCKETS;
    let after: string | null = null;
    let updated = 0;
    let failed = 0;
    for (;;) {
      const page: readonly { readonly id: string }[] = await db
        .select({ id: usagePackSubscriptions.id })
        .from(usagePackSubscriptions)
        .where(
          and(
            isNotNull(usagePackSubscriptions.stripeSubscriptionId),
            notInArray(usagePackSubscriptions.subscriptionStatus, [
              ...TERMINAL_SUBSCRIPTION_STATUSES,
            ]),
            sql`(hashtext(${usagePackSubscriptions.id}::text) & 2147483647) % ${USAGE_PACK_CONFIGURATION_SWEEP_BUCKETS} = ${bucket}`,
            after ? gt(usagePackSubscriptions.id, after) : undefined,
          ),
        )
        .orderBy(asc(usagePackSubscriptions.id))
        .limit(USAGE_PACK_CONFIGURATION_SWEEP_PAGE_SIZE);
      signal.throwIfAborted();
      for (const { id } of page) {
        const result = await settle(
          set(syncUsagePackSubscriptionConfiguration$, id, signal),
          signal,
        );
        if (!result.ok) {
          failed += 1;
          L.warn("usage pack configuration reconciliation failed", {
            usagePackSubscriptionId: id,
            error: result.error,
          });
          continue;
        }
        if (result.value.status === "updated") {
          updated += 1;
        }
      }
      const last = page.at(-1);
      if (!last || page.length < USAGE_PACK_CONFIGURATION_SWEEP_PAGE_SIZE) {
        return { updated, failed };
      }
      after = last.id;
    }
  },
);

async function scheduleUsagePackAllocationChange(
  context: UsagePackChangeContext,
  change: UsagePackAllocationChangeRow,
  subscription: UsagePackChangeSubscriptionInput,
  signal: AbortSignal | undefined,
  operationId = change.id,
): Promise<{ readonly scheduleId: string; readonly effectiveAt: Date }> {
  const period = usagePackItemPeriod(subscription);
  const targetQuantities = projectedPackageQuantities(context, change);
  if (targetQuantities.size === 0) {
    throw new Error(
      "A usage pack subscription cannot be scheduled without a package",
    );
  }
  const stripe = getStripeClient();
  const existingScheduleId = subscriptionScheduleId(subscription);
  const createdSchedule = existingScheduleId
    ? null
    : await stripe.subscriptionSchedules.create(
        { from_subscription: subscription.id },
        { idempotencyKey: `usage-pack-change:${operationId}:schedule-create` },
      );
  signal?.throwIfAborted();
  const scheduleId = existingScheduleId ?? createdSchedule?.id;
  if (!scheduleId) {
    throw new Error("Stripe did not return a subscription schedule ID");
  }
  const schedule =
    createdSchedule ??
    (await stripe.subscriptionSchedules.retrieve(scheduleId));
  signal?.throwIfAborted();
  await stripe.subscriptionSchedules.update(
    scheduleId,
    {
      end_behavior: "release",
      proration_behavior: "none",
      phases: projectedUsagePackSchedulePhases(subscription, schedule, {
        currentQuantities: packageQuantitiesForSubscription(subscription),
        renewalQuantities: targetQuantities,
      }),
    },
    { idempotencyKey: `usage-pack-change:${operationId}:schedule-update` },
  );
  signal?.throwIfAborted();
  return {
    scheduleId,
    effectiveAt: new Date(period.end * 1000),
  };
}

function memberRemovalReservationContext(
  context: UsagePackChangeContext | null,
  userId: string,
) {
  if (!context?.subscription.stripeSubscriptionId) {
    throw new Error("Usage pack subscription is not ready for member removal");
  }
  const blockingChange = context.changes.find((change) => {
    return (
      change.status === "applying" ||
      change.status === "pending_payment" ||
      change.status === "applied"
    );
  });
  if (blockingChange) {
    throw new Error(
      `Usage pack billing change ${blockingChange.id} must finish before member removal`,
    );
  }
  const existing = context.changes.find((change) => {
    return change.userId === userId;
  });
  if (existing?.status === "scheduled" && existing.kind !== "removal") {
    throw new Error(
      `Usage pack change ${existing.id} must finish before member removal`,
    );
  }
  const existingRemoval = existing?.kind === "removal" ? existing : null;
  return { context, existing, existingRemoval };
}

function memberRemovalReservationValues(
  context: UsagePackChangeContext,
  allocation: UsagePackAllocationRow,
  args: { readonly orgId: string; readonly userId: string },
  at: Date,
): typeof usagePackAllocationChanges.$inferInsert {
  return {
    usagePackSubscriptionId: context.subscription.id,
    orgId: args.orgId,
    userId: args.userId,
    sourceAllocationId: allocation.id,
    kind: "removal",
    status: "previewed",
    sourceUsagePackUsd: allocation.usagePackUsd,
    sourceStripePriceId: allocation.stripePriceId,
    immediateAmountCents: 0,
    nextRecurringAmountCents: 0,
    previewExpiresAt: new Date(at.getTime() + PREVIEW_TTL_MS),
    createdAt: at,
    updatedAt: at,
  };
}

export const reserveUsagePackMemberRemoval$ = command(
  async function reserveUsagePackMemberRemoval(
    { set },
    args: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<string | null> {
    const db = set(writeDb$);
    signal.throwIfAborted();
    const at = nowDate();
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0267; new non-billing transactions are prohibited.
    const reservationId = await db.transaction(async (tx) => {
      await tx
        .update(usagePackAllocationChanges)
        .set(failedUsagePackPreviewValues(at, "preview_expired"))
        .where(expiredUsagePackPreviewCondition(args.orgId, at));
      const [allocation] = await tx
        .select()
        .from(usagePackAllocations)
        .where(
          and(
            eq(usagePackAllocations.orgId, args.orgId),
            eq(usagePackAllocations.userId, args.userId),
            eq(usagePackAllocations.status, "active"),
          ),
        )
        .for("update")
        .limit(1);
      if (!allocation) {
        return null;
      }
      const [subscription] = await tx
        .select()
        .from(usagePackSubscriptions)
        .where(
          and(
            eq(usagePackSubscriptions.orgId, args.orgId),
            isNotNull(usagePackSubscriptions.stripeSubscriptionId),
            notInArray(usagePackSubscriptions.subscriptionStatus, [
              ...TERMINAL_SUBSCRIPTION_STATUSES,
            ]),
          ),
        )
        .orderBy(desc(usagePackSubscriptions.updatedAt))
        .limit(1);
      let loaded: UsagePackChangeContext | null = null;
      if (subscription) {
        // Allocation replacement and its change-status transition commit together.
        // One statement prevents mixing child rows from either side of that commit.
        const [context] = await tx
          .select(usagePackChangeContextSelection(subscription.id))
          .from(usagePackSubscriptions)
          .where(eq(usagePackSubscriptions.id, subscription.id))
          .limit(1);
        loaded = context ?? null;
      }
      const { context, existing, existingRemoval } =
        memberRemovalReservationContext(loaded, args.userId);
      await tx
        .update(usagePackAllocationChanges)
        .set(failedUsagePackPreviewValues(at, "member_removal_reserved"))
        .where(
          invalidatedUsagePackPreviewCondition({
            orgId: args.orgId,
            ...(existingRemoval
              ? { preservedChangeId: existingRemoval.id }
              : {}),
          }),
        );
      if (existingRemoval) {
        if (existingRemoval.status === "previewed") {
          await tx
            .update(usagePackAllocationChanges)
            .set({
              previewExpiresAt: new Date(at.getTime() + PREVIEW_TTL_MS),
              updatedAt: at,
            })
            .where(eq(usagePackAllocationChanges.id, existingRemoval.id));
        }
        return existingRemoval.id;
      }
      if (existing) {
        await tx
          .update(usagePackAllocationChanges)
          .set(failedUsagePackPreviewValues(at, "member_removal_reserved"))
          .where(eq(usagePackAllocationChanges.id, existing.id));
      }
      const [reservation] = await tx
        .insert(usagePackAllocationChanges)
        .values(memberRemovalReservationValues(context, allocation, args, at))
        // The same member's reservations queue on its active allocation row.
        // Another member's committed open change keeps the active-org unique
        // index occupied; that is the same blocking outcome as above.
        .onConflictDoNothing()
        .returning({ id: usagePackAllocationChanges.id });
      if (!reservation) {
        throw new Error(
          "A usage pack billing change must finish before member removal",
        );
      }
      return reservation.id;
    });
    signal.throwIfAborted();
    return reservationId;
  },
);

export const cancelUsagePackMemberRemovalReservation$ = command(
  async ({ set }, reservationId: string | null): Promise<void> => {
    if (!reservationId) {
      return;
    }
    const db = set(writeDb$);
    const at = nowDate();
    await db
      .update(usagePackAllocationChanges)
      .set({
        status: "failed",
        failureReason: "member_removal_failed",
        completedAt: at,
        updatedAt: at,
      })
      .where(
        and(
          eq(usagePackAllocationChanges.id, reservationId),
          eq(usagePackAllocationChanges.kind, "removal"),
          eq(usagePackAllocationChanges.status, "previewed"),
        ),
      );
  },
);

function invalidatedUsagePackPreviewCondition(args: {
  readonly orgId: string;
  readonly preservedChangeId?: string;
}) {
  return args.preservedChangeId
    ? and(
        eq(usagePackAllocationChanges.orgId, args.orgId),
        eq(usagePackAllocationChanges.status, "previewed"),
        ne(usagePackAllocationChanges.id, args.preservedChangeId),
      )
    : and(
        eq(usagePackAllocationChanges.orgId, args.orgId),
        eq(usagePackAllocationChanges.status, "previewed"),
      );
}

const prepareUsagePackMemberRemoval$ = command(
  async function prepareUsagePackMemberRemoval(
    { set },
    args: { readonly orgId: string; readonly userId: string },
  ): Promise<{
    readonly context: UsagePackChangeContext;
    readonly change: UsagePackAllocationChangeRow;
  } | null> {
    const db = set(writeDb$);

    const at = nowDate();
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0268; new non-billing transactions are prohibited.
    return await db.transaction(async (tx) => {
      const plan = prepareUsagePackMemberRemovalPlan(args, at);
      let step = plan.next();
      while (!step.done) {
        const statement = step.value;
        let rows: readonly unknown[] = [];
        if (statement.kind === "timestamp") {
          rows = [nowDate()];
        } else if (statement.kind === "read") {
          rows = parseRawRows(
            retainedMutationRowSchema,
            await tx.execute(statement.sql),
          );
        } else {
          await tx.execute(statement.sql);
        }
        step = plan.next(rows);
      }
      return step.value;
    });
  },
);

interface ScheduledUsagePackChange {
  readonly effectiveAt: Date;
  readonly stripeScheduleId: string | null;
}

type DeferredUsagePackChangeResult =
  | ScheduledUsagePackChange
  | {
      readonly emptyCancellation: EmptyUsagePackCancellation;
    };

async function applyDeferredUsagePackChange(
  context: UsagePackChangeContext,
  change: UsagePackAllocationChangeRow,
  subscription: UsagePackChangeSubscriptionInput,
  signal: AbortSignal | undefined,
): Promise<DeferredUsagePackChangeResult> {
  if (change.kind === "upgrade") {
    throw new Error("Usage pack upgrades cannot be deferred");
  }
  const remainingQuantities = projectedPackageQuantities(context, change);
  if (remainingQuantities.size > 0) {
    const scheduled = await scheduleUsagePackAllocationChange(
      context,
      change,
      subscription,
      signal,
    );
    return {
      effectiveAt: scheduled.effectiveAt,
      stripeScheduleId: scheduled.scheduleId,
    };
  }
  if (change.kind !== "removal") {
    throw new Error("A usage pack downgrade must retain a package");
  }
  return {
    emptyCancellation: {
      orgId: context.subscription.orgId,
      usagePackSubscriptionId: context.subscription.id,
      allocationChangeId: change.id,
    },
  };
}

const scheduleDeferredUsagePackChange$ = command(
  async function scheduleDeferredUsagePackChange(
    { set },
    context: UsagePackChangeContext,
    change: UsagePackAllocationChangeRow,
    subscription: UsagePackChangeSubscriptionInput,
    signal: AbortSignal | undefined,
  ): Promise<DeferredUsagePackChangeResult> {
    const db = set(writeDb$);

    const scheduled = await applyDeferredUsagePackChange(
      context,
      change,
      subscription,
      signal,
    );
    if ("emptyCancellation" in scheduled) {
      return scheduled;
    }
    const updatedAt = nowDate();
    await db
      .update(usagePackAllocationChanges)
      .set({
        status: "scheduled",
        stripeScheduleId: scheduled.stripeScheduleId,
        effectiveAt: scheduled.effectiveAt,
        updatedAt,
      })
      .where(
        and(
          eq(usagePackAllocationChanges.id, change.id),
          eq(usagePackAllocationChanges.status, "applying"),
        ),
      );
    signal?.throwIfAborted();
    return scheduled;
  },
);

const applyImmediateUsagePackMemberRemoval$ = command(
  async function applyImmediateUsagePackMemberRemoval(
    { set },
    context: UsagePackChangeContext,
    change: UsagePackAllocationChangeRow,
    subscription: UsagePackChangeSubscriptionInput,
    signal: AbortSignal,
  ): Promise<void> {
    if (change.kind !== "removal") {
      throw new Error("Only usage pack removals can be applied immediately");
    }
    validateStripeSubscriptionIdentity(context, subscription);
    const currentQuantities = projectedQuantitiesAfterChanges(context, [
      change,
    ]);
    const sourceQuantities = packageQuantitiesForAllocations(
      context.allocations,
    );
    const stripeQuantities = packageQuantitiesForSubscription(subscription);
    // The removal writes absolute quantities derived from local allocations, so
    // temporary configuration drift is repaired rather than blocking removal.
    // A pending paid update still owns Stripe; do not discard its invoice.
    if (
      subscription.pending_update &&
      !quantitiesMatch(stripeQuantities, sourceQuantities) &&
      !quantitiesMatch(stripeQuantities, currentQuantities)
    ) {
      throw new Error("Stripe usage pack quantities are out of sync");
    }
    const scheduledChanges = context.changes.filter((candidate) => {
      return candidate.id !== change.id && candidate.status === "scheduled";
    });
    const renewalQuantities = projectedQuantitiesAfterChanges(context, [
      ...scheduledChanges,
      change,
    ]);
    await syncUsagePackProjection(
      subscription,
      {
        currentQuantities,
        renewalQuantities,
        operationId: `${change.id}:member-removal`,
      },
      signal,
    );
    const scheduleId = subscriptionScheduleId(subscription);
    if (
      scheduleId &&
      change.stripeScheduleId === scheduleId &&
      scheduledChanges.length === 0
    ) {
      const released = await set(releaseUnusedMemberRemovalSchedule$, {
        orgId: context.subscription.orgId,
        scheduleId,
      });
      if (signal.aborted) {
        if (released) {
          signal.throwIfAborted();
        }
      }
    }
    const period = usagePackItemPeriod(subscription);
    const effectiveTimestamp = Math.min(
      Math.max(Math.floor(nowDate().getTime() / 1000), period.start),
      period.end - 1,
    );
    await set(commitReflectedUsagePackChanges$, context, [change], {
      start: effectiveTimestamp,
      end: period.end,
    });
    signal.throwIfAborted();
  },
);

export const removeUsagePackMemberAllocation$ = command(
  async function removeUsagePackMemberAllocation(
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<EmptyUsagePackCancellation | null> {
    const prepared = await set(prepareUsagePackMemberRemoval$, args);
    signal.throwIfAborted();
    if (!prepared) {
      return null;
    }
    const stripeSubscriptionId =
      prepared.context.subscription.stripeSubscriptionId;
    if (!stripeSubscriptionId) {
      throw new Error("Usage pack subscription has no Stripe subscription");
    }
    const stripeSubscription =
      await getStripeClient().subscriptions.retrieve(stripeSubscriptionId);
    signal.throwIfAborted();
    const remainingQuantities = projectedQuantitiesAfterChanges(
      prepared.context,
      [prepared.change],
    );
    if (remainingQuantities.size === 0) {
      validateCurrentStripeProjection(prepared.context, stripeSubscription);
      const deferred = await set(
        scheduleDeferredUsagePackChange$,
        prepared.context,
        prepared.change,
        stripeSubscription,
        signal,
      );
      if ("emptyCancellation" in deferred) {
        return deferred.emptyCancellation;
      }
    } else {
      await set(
        applyImmediateUsagePackMemberRemoval$,
        prepared.context,
        prepared.change,
        stripeSubscription,
        signal,
      );
    }
    return null;
  },
);

function latestInvoice(subscription: StripeSubscription): StripeInvoice | null {
  return subscription.latest_invoice &&
    typeof subscription.latest_invoice !== "string"
    ? subscription.latest_invoice
    : null;
}

function pendingUpdateExpiry(subscription: StripeSubscription): Date | null {
  return unixDate(subscription.pending_update?.expires_at);
}

function allocationOwnerKey(allocation: UsagePackAllocationRow): string {
  if (allocation.userId) {
    return `user:${allocation.userId}`;
  }
  if (allocation.invitationId) {
    return `invitation:${allocation.invitationId}`;
  }
  throw new Error(`Usage pack allocation ${allocation.id} has no owner`);
}

function projectedQuantitiesAfterChanges(
  context: UsagePackChangeContext,
  changes: readonly UsagePackAllocationChangeRow[],
): ReadonlyMap<string, number> {
  const packageByOwner = new Map<string, string>();
  for (const allocation of context.allocations) {
    if (isProjectedUsagePackAllocation(allocation)) {
      packageByOwner.set(
        allocationOwnerKey(allocation),
        allocation.stripePriceId,
      );
    }
  }
  for (const change of changes) {
    const ownerKey = `user:${change.userId}`;
    const currentPriceId = packageByOwner.get(ownerKey);
    if (
      (change.kind === "addition" && currentPriceId !== undefined) ||
      (change.kind !== "addition" &&
        currentPriceId !== change.sourceStripePriceId)
    ) {
      throw new Error(
        `Usage pack change ${change.id} no longer matches its source allocation`,
      );
    }
    if (change.kind === "removal") {
      packageByOwner.delete(ownerKey);
    } else if (change.targetStripePriceId) {
      packageByOwner.set(ownerKey, change.targetStripePriceId);
    } else {
      throw new Error(`Usage pack change ${change.id} has no target Price`);
    }
  }

  const quantities = new Map<string, number>();
  for (const priceId of packageByOwner.values()) {
    quantities.set(priceId, (quantities.get(priceId) ?? 0) + 1);
  }
  return quantities;
}

function deduplicateChangeSets(
  sets: readonly (readonly UsagePackAllocationChangeRow[])[],
): readonly (readonly UsagePackAllocationChangeRow[])[] {
  const seen = new Set<string>();
  return sets.filter((changes) => {
    if (changes.length === 0) {
      return false;
    }
    const key = changes
      .map((change) => {
        return change.id;
      })
      .sort()
      .join(":");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function changesReflectedBySubscription(
  context: UsagePackChangeContext,
  subscription: UsagePackChangeSubscriptionInput,
): readonly UsagePackAllocationChangeRow[] {
  const actualQuantities = packageQuantitiesForSubscription(subscription);
  const currentQuantities = packageQuantitiesForAllocations(
    context.allocations,
  );
  if (quantitiesMatch(actualQuantities, currentQuantities)) {
    return [];
  }
  const activationContext = withAcceptedInvitationAllocations(context);
  if (
    quantitiesMatch(
      actualQuantities,
      packageQuantitiesForAllocations(activationContext.allocations),
    )
  ) {
    return [];
  }

  const period = usagePackItemPeriod(subscription);
  const periodStart = new Date(period.start * 1000);
  const scheduled = context.changes.filter((change) => {
    if (change.status === "scheduled") {
      return change.effectiveAt !== null && change.effectiveAt <= periodStart;
    }
    if (
      change.status !== "applying" ||
      change.kind === "addition" ||
      change.kind === "upgrade"
    ) {
      return false;
    }
    const source = context.allocations.find((allocation) => {
      return allocation.id === change.sourceAllocationId;
    });
    return (
      source?.currentPeriodEnd !== null &&
      source?.currentPeriodEnd !== undefined &&
      source.currentPeriodEnd <= periodStart
    );
  });
  const immediateChanges = !subscription.pending_update
    ? context.changes.filter((change) => {
        return (
          (change.kind === "addition" || change.kind === "upgrade") &&
          (change.status === "applying" || change.status === "pending_payment")
        );
      })
    : [];
  const candidates = deduplicateChangeSets([
    [...scheduled, ...immediateChanges],
    scheduled,
    immediateChanges,
  ]);
  const reflected = candidates.find((changes) => {
    return [context, activationContext].some((candidateContext) => {
      return quantitiesMatch(
        projectedQuantitiesAfterChanges(candidateContext, changes),
        actualQuantities,
      );
    });
  });
  if (!reflected) {
    throw new Error(
      `Stripe usage pack quantities do not match an open allocation change for ${subscription.id}`,
    );
  }
  return reflected;
}

const reflectedUsagePackBatchFailure = object({ code: literal("22012") });

const commitReflectedUsagePackChanges$ = command(
  async function commitReflectedUsagePackChanges(
    { set },
    context: UsagePackChangeContext,
    changes: readonly UsagePackAllocationChangeRow[],
    period: UsagePackPeriod,
  ): Promise<number> {
    if (changes.length === 0) {
      return 0;
    }
    const db = set(writeDb$);
    const updatedAt = nowDate();
    const capturedIds = reflectedUsagePackChangeIds(changes);
    const current = await db
      .select()
      .from(usagePackAllocationChanges)
      .where(
        inArray(
          usagePackAllocationChanges.id,
          sql`(SELECT value::uuid FROM jsonb_array_elements_text(${capturedIds}::jsonb))`,
        ),
      );
    const prepared = reflectedUsagePackChanges(context, changes, current);
    if (!prepared?.length) {
      return 0;
    }
    const input = reflectedUsagePackChangeInput(prepared);
    const sourceCount = sql`(${db.select({ value: count() }).from(input).where(ne(input.kind, "addition"))})`;
    const retired = db.$with("reflected_retired_allocations").as(
      db
        .update(usagePackAllocations)
        .set({ status: "inactive", updatedAt })
        .from(input)
        .where(and(ne(input.kind, "addition"), reflectedSourceCondition(input)))
        .returning({ id: usagePackAllocations.id }),
    );
    const retiredCount = sql`(${db.select({ value: count() }).from(retired)})`;
    // All source winners precede replacements, including the zero-source case.
    const replacement = db.$with("reflected_replacement_allocations").as(
      db
        .insert(usagePackAllocations)
        .select(
          db
            .select(
              reflectedReplacementValues(context, input, period, updatedAt),
            )
            .from(input)
            .where(
              and(ne(input.kind, "removal"), eq(retiredCount, sourceCount)),
            ),
        )
        .onConflictDoNothing({
          target: [usagePackAllocations.orgId, usagePackAllocations.userId],
          where: sql`${usagePackAllocations.userId} IS NOT NULL AND ${usagePackAllocations.status} <> 'inactive'`,
        })
        .returning({
          id: usagePackAllocations.id,
          userId: usagePackAllocations.userId,
        }),
    );
    const replacementCount = sql`(${db.select({ value: count() }).from(replacement)})`;
    const targetCount = sql`(${db.select({ value: count() }).from(input).where(ne(input.kind, "removal"))})`;
    const superseded = db.$with("reflected_superseded_changes").as(
      db
        .update(usagePackAllocationChanges)
        .set({
          status: "failed",
          failureReason: "scheduled_change_superseded",
          completedAt: updatedAt,
          updatedAt,
        })
        .from(input)
        .where(
          and(
            reflectedSupersededScheduleCondition(input),
            eq(replacementCount, targetCount),
          ),
        )
        .returning({ id: usagePackAllocationChanges.id }),
    );
    const supersededCount = sql`(${db.select({ value: count() }).from(superseded)})`;
    const replacementId = sql`(${db.select({ id: replacement.id }).from(replacement).where(eq(replacement.userId, input.userId))})`;
    const published = db.$with("reflected_published_changes").as(
      db
        .update(usagePackAllocationChanges)
        .set(
          reflectedPublicationValues(input, replacementId, period, updatedAt),
        )
        .from(input)
        .where(
          and(
            reflectedPublicationCondition(input),
            eq(retiredCount, sourceCount),
            eq(replacementCount, targetCount),
            sql`${supersededCount} >= 0`,
          ),
        )
        .returning({ id: usagePackAllocationChanges.id }),
    );
    const publishedCount = sql`(${db.select({ value: count() }).from(published)})`;
    const inputCount = sql`(${db.select({ value: count() }).from(input)})`;
    // A lost source, replacement or final identity aborts every write in the batch.
    const result = await settle(
      db
        .with(input, retired, replacement, superseded, published)
        .select({
          applied:
            sql`${publishedCount} / CASE WHEN ${eq(publishedCount, inputCount)} THEN 1 ELSE 0 END`.mapWith(
              pgInt8ToSafeIntegerDecoder,
            ),
        })
        .from(sql`(SELECT 1) AS reflected_batch_result`),
    );
    if (result.ok) {
      const row = result.value[0];
      if (!row) {
        throw new Error("Reflected usage pack batch returned no result");
      }
      return row.applied;
    }
    if (
      result.error instanceof DrizzleQueryError &&
      reflectedUsagePackBatchFailure.safeParse(result.error.cause).success
    ) {
      return 0;
    }
    throw result.error;
  },
);

const canceledUsagePackInputColumns = Object.freeze({
  id: usagePackAllocationChanges.id,
  orgId: usagePackAllocationChanges.orgId,
  usagePackSubscriptionId: usagePackAllocationChanges.usagePackSubscriptionId,
  userId: usagePackAllocationChanges.userId,
  kind: usagePackAllocationChanges.kind,
  status: usagePackAllocationChanges.status,
  subscriptionChangeId: usagePackAllocationChanges.subscriptionChangeId,
  sourceAllocationId: usagePackAllocationChanges.sourceAllocationId,
  replacementAllocationId: usagePackAllocationChanges.replacementAllocationId,
  sourceStripePriceId: usagePackAllocationChanges.sourceStripePriceId,
  targetStripePriceId: usagePackAllocationChanges.targetStripePriceId,
  sourceUsagePackUsd: usagePackAllocationChanges.sourceUsagePackUsd,
  targetUsagePackUsd: usagePackAllocationChanges.targetUsagePackUsd,
  effectiveAt: usagePackAllocationChanges.effectiveAt,
});

/** Actual captured change rows, carried in one parameter without a bind-count limit. */
function canceledUsagePackChangeInput(
  subscription: Pick<
    typeof usagePackSubscriptions.$inferSelect,
    "id" | "orgId"
  >,
  finalizable: readonly UsagePackAllocationChangeRow[],
) {
  const rows = finalizable.map((change) => {
    if (
      change.orgId !== subscription.orgId ||
      change.usagePackSubscriptionId !== subscription.id
    ) {
      throw new Error(
        "Canceled usage pack change belongs to another billing owner",
      );
    }
    if (
      change.kind === "removal" &&
      (change.status === "scheduled" || change.status === "applying") &&
      (!change.sourceAllocationId || !change.sourceStripePriceId)
    ) {
      throw new Error(`Usage pack removal ${change.id} has no source`);
    }
    return {
      id: change.id,
      org_id: change.orgId,
      usage_pack_subscription_id: change.usagePackSubscriptionId,
      user_id: change.userId,
      kind: change.kind,
      status: change.status,
      subscription_change_id: change.subscriptionChangeId,
      source_allocation_id: change.sourceAllocationId,
      replacement_allocation_id: change.replacementAllocationId,
      source_stripe_price_id: change.sourceStripePriceId,
      target_stripe_price_id: change.targetStripePriceId,
      source_usage_pack_usd: change.sourceUsagePackUsd,
      target_usage_pack_usd: change.targetUsagePackUsd,
      effective_at: change.effectiveAt?.toISOString() ?? null,
    };
  });
  return new QueryBuilder().$with(
    "canceled_change_input",
    canceledUsagePackInputColumns,
  ).as(sql`
    SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS captured(
      id uuid, org_id text, usage_pack_subscription_id uuid, user_id text,
      kind text, status text, subscription_change_id uuid, source_allocation_id uuid,
      replacement_allocation_id uuid, source_stripe_price_id text,
      target_stripe_price_id text, source_usage_pack_usd integer,
      target_usage_pack_usd integer, effective_at timestamp
    )
  `);
}

type CanceledUsagePackInput = ReturnType<typeof canceledUsagePackChangeInput>;

/** Repeated references to the same real source need only one identical UPDATE. */
function canceledUsagePackRemovalSources(input: CanceledUsagePackInput) {
  const query = new QueryBuilder();
  return query.$with("canceled_removal_sources").as(
    query
      .selectDistinct({
        id: input.sourceAllocationId,
        orgId: input.orgId,
        usagePackSubscriptionId: input.usagePackSubscriptionId,
        userId: input.userId,
        stripePriceId: input.sourceStripePriceId,
      })
      .from(input)
      .where(
        and(
          eq(input.kind, "removal"),
          inArray(input.status, ["scheduled", "applying"]),
        ),
      ),
  );
}

function canceledUsagePackAllocationCondition(
  source: ReturnType<typeof canceledUsagePackRemovalSources>,
) {
  return and(
    eq(usagePackAllocations.id, source.id),
    eq(usagePackAllocations.orgId, source.orgId),
    eq(
      usagePackAllocations.usagePackSubscriptionId,
      source.usagePackSubscriptionId,
    ),
    eq(usagePackAllocations.userId, source.userId),
    eq(usagePackAllocations.stripePriceId, source.stripePriceId),
  );
}

/** The original fulfillment identity and expected status, with column operands. */
function canceledUsagePackChangeCondition(input: CanceledUsagePackInput) {
  return and(
    eq(usagePackAllocationChanges.id, input.id),
    eq(usagePackAllocationChanges.status, input.status),
    eq(usagePackAllocationChanges.orgId, input.orgId),
    eq(
      usagePackAllocationChanges.usagePackSubscriptionId,
      input.usagePackSubscriptionId,
    ),
    eq(usagePackAllocationChanges.kind, input.kind),
    sql`${usagePackAllocationChanges.subscriptionChangeId} IS NOT DISTINCT FROM ${input.subscriptionChangeId}`,
    sql`${usagePackAllocationChanges.userId} IS NOT DISTINCT FROM ${input.userId}`,
    sql`${usagePackAllocationChanges.sourceAllocationId} IS NOT DISTINCT FROM ${input.sourceAllocationId}`,
    sql`${usagePackAllocationChanges.replacementAllocationId} IS NOT DISTINCT FROM ${input.replacementAllocationId}`,
    sql`${usagePackAllocationChanges.sourceStripePriceId} IS NOT DISTINCT FROM ${input.sourceStripePriceId}`,
    sql`${usagePackAllocationChanges.targetStripePriceId} IS NOT DISTINCT FROM ${input.targetStripePriceId}`,
    sql`${usagePackAllocationChanges.sourceUsagePackUsd} IS NOT DISTINCT FROM ${input.sourceUsagePackUsd}`,
    sql`${usagePackAllocationChanges.targetUsagePackUsd} IS NOT DISTINCT FROM ${input.targetUsagePackUsd}`,
  );
}

function canceledUsagePackChangeValues(
  input: CanceledUsagePackInput,
  at: Date,
) {
  const completed = sql`${eq(input.kind, "removal")} AND ${inArray(input.status, ["scheduled", "applying"])}`;
  return {
    status: sql`CASE WHEN ${completed} THEN 'completed' ELSE 'failed' END`,
    failureReason: sql`CASE WHEN ${completed} THEN NULL ELSE 'subscription_canceled' END`,
    effectiveAt: sql`COALESCE(${input.effectiveAt}, ${sql.param(at, usagePackAllocationChanges.effectiveAt)})`,
    completedAt: at,
    updatedAt: at,
  };
}

const canceledUsagePackBatchFailure = object({ code: literal("22012") });

const finalizeCanceledUsagePackChanges$ = command(
  async function finalizeCanceledUsagePackChanges(
    { set },
    context: UsagePackChangeContext,
  ): Promise<number> {
    const db = set(writeDb$);
    const finalizable = context.changes.filter((change) => {
      return change.status !== "applied";
    });
    if (finalizable.length === 0) {
      return 0;
    }
    const at = nowDate();
    const input = canceledUsagePackChangeInput(
      context.subscription,
      finalizable,
    );
    const sources = canceledUsagePackRemovalSources(input);
    // Keep source allocations before their referencing changes. Every old
    // identity/status condition must win or the complete batch rolls back.
    const retired = db
      .$with("canceled_retired_allocations")
      .as(
        db
          .update(usagePackAllocations)
          .set({ status: "inactive", updatedAt: at })
          .from(sources)
          .where(canceledUsagePackAllocationCondition(sources))
          .returning({ id: usagePackAllocations.id }),
      );
    const retiredCount = sql`(${db.select({ value: count() }).from(retired)})`;
    const sourceCount = sql`(${db.select({ value: count() }).from(sources)})`;
    const finalized = db.$with("canceled_finalized_changes").as(
      db
        .update(usagePackAllocationChanges)
        .set(canceledUsagePackChangeValues(input, at))
        .from(input)
        .where(
          and(
            canceledUsagePackChangeCondition(input),
            eq(retiredCount, sourceCount),
          ),
        )
        .returning({ id: usagePackAllocationChanges.id }),
    );
    const finalizedCount = sql`(${db.select({ value: count() }).from(finalized)})`;
    const inputCount = sql`(${db.select({ value: count() }).from(input)})`;
    // The denominator depends on actual RETURNING counts, so PostgreSQL checks
    // it at execution rather than folding a constant error during planning.
    // 22012 is emitted only by this batch guard; it aborts every preceding CTE.
    const result = await settle(
      db
        .with(input, sources, retired, finalized)
        .select({
          finalized:
            sql`${finalizedCount} / CASE WHEN ${eq(finalizedCount, inputCount)} THEN 1 ELSE 0 END`.mapWith(
              pgInt8ToSafeIntegerDecoder,
            ),
        })
        .from(sql`(SELECT 1) AS canceled_batch_result`),
    );
    if (result.ok) {
      const row = result.value[0];
      if (!row) {
        throw new Error("Canceled usage pack batch returned no result");
      }
      return row.finalized;
    }
    if (
      result.error instanceof DrizzleQueryError &&
      canceledUsagePackBatchFailure.safeParse(result.error.cause).success
    ) {
      return 0;
    }
    throw result.error;
  },
);

async function refreshScheduledChangesForUpgrade(
  context: UsagePackChangeContext,
  subscription: UsagePackChangeSubscriptionInput,
  appliedUpgrade: UsagePackAllocationChangeRow,
): Promise<void> {
  const hasScheduledChange = context.changes.some((change) => {
    return change.status === "scheduled";
  });
  if (!hasScheduledChange) {
    return;
  }
  await scheduleUsagePackAllocationChange(
    context,
    appliedUpgrade,
    subscription,
    undefined,
    `${appliedUpgrade.id}:schedule-refresh`,
  );
}

export const reconcileUsagePackAllocationChangeSubscription$ = command(
  async function reconcileUsagePackAllocationChangeSubscription(
    { set },
    subscription: UsagePackChangeSubscriptionInput,
  ): Promise<{ readonly reconciled: number; readonly orgId: string | null }> {
    const boundId = await set(
      boundUsagePackSubscriptionIdOwned$,
      subscription.id,
    );
    const usagePackSubscriptionId =
      boundId ??
      (await set(
        activeMetadataUsagePackSubscriptionIdOwned$,
        usagePackSubscriptionIdFromMetadata(subscription.metadata),
      ));
    if (!usagePackSubscriptionId) {
      return { reconciled: 0, orgId: null };
    }
    const context = await set(
      loadUsagePackChangeContextForPhase$,
      usagePackSubscriptionId,
    );
    if (!context) {
      throw new Error(
        `Unknown usage pack subscription: ${usagePackSubscriptionId}`,
      );
    }
    if (!context.subscription.stripeSubscriptionId) {
      return { reconciled: 0, orgId: context.subscription.orgId };
    }
    if (subscription.id !== context.subscription.stripeSubscriptionId) {
      throw new Error(
        "Stripe subscription does not match the usage pack record",
      );
    }
    if (
      subscription.status === "canceled" ||
      subscription.status === "incomplete_expired"
    ) {
      const reconciled = await set(finalizeCanceledUsagePackChanges$, context);
      return { reconciled, orgId: context.subscription.orgId };
    }

    const reflected = changesReflectedBySubscription(context, subscription);
    const period = usagePackItemPeriod(subscription);
    const appliedUpgrade = reflected.find((change) => {
      return change.kind === "upgrade" && change.subscriptionChangeId === null;
    });
    if (appliedUpgrade) {
      await refreshScheduledChangesForUpgrade(
        context,
        subscription,
        appliedUpgrade,
      );
    }
    const reconciled = await set(
      commitReflectedUsagePackChanges$,
      context,
      reflected,
      period,
    );
    return { reconciled, orgId: context.subscription.orgId };
  },
);

export const reconcileUsagePackAllocationChangeSubscriptionDeleted$ = command(
  async function reconcileUsagePackAllocationChangeSubscriptionDeleted(
    { set },
    subscription: {
      readonly id: string;
      readonly metadata?: Readonly<Record<string, string>> | null;
    },
  ): Promise<void> {
    const boundId = await set(
      boundUsagePackSubscriptionIdOwned$,
      subscription.id,
    );
    const usagePackSubscriptionId =
      boundId ??
      (await set(
        activeMetadataUsagePackSubscriptionIdOwned$,
        usagePackSubscriptionIdFromMetadata(subscription.metadata),
      ));
    if (!usagePackSubscriptionId) {
      return;
    }
    const context = await set(
      loadUsagePackChangeContextForPhase$,
      usagePackSubscriptionId,
    );
    if (!context) {
      throw new Error(
        `Unknown usage pack subscription: ${usagePackSubscriptionId}`,
      );
    }
    if (!context.subscription.stripeSubscriptionId) {
      return;
    }
    if (context.subscription.stripeSubscriptionId !== subscription.id) {
      throw new Error("Deleted Stripe subscription does not match usage pack");
    }
    await set(finalizeCanceledUsagePackChanges$, context);
  },
);

function positiveBonusCredits(
  metadata: Readonly<Record<string, string>>,
  priceId: string,
): number {
  const value = metadata.bonusCredits;
  if (!value || !/^[1-9]\d*$/.test(value)) {
    throw new Error(
      `Usage pack Price ${priceId} has invalid Product bonus credits`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Usage pack Price ${priceId} bonus credits are too large`);
  }
  return parsed;
}

async function usagePackCreditsForPrice(
  priceId: string,
): Promise<{ readonly purchased: number; readonly bonus: number }> {
  const price = await getStripeClient().prices.retrieve(priceId, {
    expand: ["product"],
  });
  if (
    price.id !== priceId ||
    price.currency !== "usd" ||
    price.unit_amount === null ||
    !Number.isSafeInteger(price.unit_amount) ||
    price.unit_amount <= 0
  ) {
    throw new Error(`Usage pack Price ${priceId} has an invalid USD amount`);
  }
  if (typeof price.product === "string" || "deleted" in price.product) {
    throw new Error(`Usage pack Price ${priceId} has no active Product`);
  }
  const purchased = Math.floor((price.unit_amount * CREDITS_PER_DOLLAR) / 100);
  if (!Number.isSafeInteger(purchased) || purchased <= 0) {
    throw new Error(`Usage pack Price ${priceId} credits are too large`);
  }
  return {
    purchased,
    bonus: positiveBonusCredits(price.product.metadata, priceId),
  };
}

function upgradeProrationPeriod(
  invoice: UsagePackChangeInvoiceInput,
  change: UsagePackAllocationChangeRow,
): UsagePackPeriod | null {
  const matchingLines = invoice.lines.data.filter((line) => {
    const priceId = invoiceLinePriceId(line);
    const amount = invoiceLineAmount(line);
    return (
      invoiceLineIsProration(line) &&
      amount !== null &&
      ((priceId === change.sourceStripePriceId && amount <= 0) ||
        (priceId === change.targetStripePriceId && amount >= 0))
    );
  });
  const sourceLine = matchingLines.find((line) => {
    return invoiceLinePriceId(line) === change.sourceStripePriceId;
  });
  const targetLine = matchingLines.find((line) => {
    return invoiceLinePriceId(line) === change.targetStripePriceId;
  });
  if (!sourceLine || !targetLine) {
    return null;
  }
  const start = targetLine.period.start;
  const end = targetLine.period.end;
  if (
    typeof start !== "number" ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    end <= start ||
    sourceLine.period.start !== start ||
    sourceLine.period.end !== end ||
    change.prorationTimestamp !== start
  ) {
    throw new Error(
      `Usage pack change invoice ${invoice.id} has an invalid proration period`,
    );
  }
  return { start, end };
}

interface UsagePackUpgradeRefundInvoiceSource {
  readonly invoiceLineId: string | null;
  readonly amountCents: number;
}

function upgradeRefundInvoiceSource(
  invoice: UsagePackChangeInvoiceInput,
  change: UsagePackAllocationChangeRow,
): UsagePackUpgradeRefundInvoiceSource | null {
  if (!change.targetStripePriceId) {
    return null;
  }
  const matchingLines = invoice.lines.data.filter((line) => {
    const amount = invoiceLineAmount(line);
    const priceId = invoiceLinePriceId(line);
    return (
      invoiceLineIsProration(line) &&
      amount !== null &&
      // Stripe can reprice the entire quantity for a shared source Price.
      // Its positive line for members retaining that Price must offset the
      // negative line for the old aggregate quantity.
      (priceId === change.sourceStripePriceId ||
        (priceId === change.targetStripePriceId && amount >= 0)) &&
      line.period.start === change.prorationTimestamp
    );
  });
  const targetLine = matchingLines.find((line) => {
    return invoiceLinePriceId(line) === change.targetStripePriceId;
  });
  const sourceLine = change.sourceStripePriceId
    ? matchingLines.find((line) => {
        return (
          invoiceLinePriceId(line) === change.sourceStripePriceId &&
          (invoiceLineAmount(line) ?? 0) <= 0
        );
      })
    : undefined;
  if (!targetLine || (change.sourceStripePriceId && !sourceLine)) {
    return null;
  }
  let amountCents = 0;
  for (const line of matchingLines) {
    const amount = invoiceLineRefundableAmountWithTax(line);
    if (amount === null) {
      return null;
    }
    amountCents += amount;
  }
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) {
    throw new Error(
      `Usage pack change invoice ${invoice.id} has an invalid refundable amount`,
    );
  }
  return { invoiceLineId: targetLine.id ?? null, amountCents };
}

function proratedCreditDelta(
  sourceCredits: number,
  targetCredits: number,
  sourceAllocation: UsagePackUpgradeCreditGrantInput["sourceAllocation"],
  prorationPeriod: UsagePackPeriod,
): number {
  if (
    !sourceAllocation.currentPeriodStart ||
    !sourceAllocation.currentPeriodEnd
  ) {
    throw new Error(
      `Usage pack allocation ${sourceAllocation.id} has no billing period`,
    );
  }
  const periodStart = Math.floor(
    sourceAllocation.currentPeriodStart.getTime() / 1000,
  );
  const periodEnd = Math.floor(
    sourceAllocation.currentPeriodEnd.getTime() / 1000,
  );
  if (
    periodEnd !== prorationPeriod.end ||
    prorationPeriod.start < periodStart ||
    prorationPeriod.start >= periodEnd
  ) {
    throw new Error(
      `Usage pack allocation ${sourceAllocation.id} does not match the proration period`,
    );
  }
  const creditDelta = targetCredits - sourceCredits;
  if (creditDelta <= 0 || !Number.isSafeInteger(creditDelta)) {
    throw new Error("Usage pack upgrade does not increase credits");
  }
  return proratedCreditAmount(creditDelta, periodStart, prorationPeriod);
}

function proratedCreditAmount(
  credits: number,
  periodStart: number,
  prorationPeriod: UsagePackPeriod,
): number {
  if (
    !Number.isSafeInteger(credits) ||
    credits <= 0 ||
    !Number.isSafeInteger(periodStart) ||
    prorationPeriod.start < periodStart ||
    prorationPeriod.start >= prorationPeriod.end
  ) {
    throw new Error("Usage pack prorated credits have an invalid period");
  }
  const prorated = Math.floor(
    (credits * (prorationPeriod.end - prorationPeriod.start)) /
      (prorationPeriod.end - periodStart),
  );
  if (!Number.isSafeInteger(prorated) || prorated < 0) {
    throw new Error("Usage pack prorated credits are invalid");
  }
  return prorated;
}

export async function calculateUsagePackAdditionCreditGrant(
  targetStripePriceId: string,
  period: UsagePackPeriod,
  prorationTimestamp: number,
): Promise<UsagePackUpgradeCreditGrant> {
  const credits = await usagePackCreditsForPrice(targetStripePriceId);
  const prorationPeriod = { start: prorationTimestamp, end: period.end };
  return {
    purchasedCredits: proratedCreditAmount(
      credits.purchased,
      period.start,
      prorationPeriod,
    ),
    bonusCredits: proratedCreditAmount(
      credits.bonus,
      period.start,
      prorationPeriod,
    ),
  };
}

export async function calculateUsagePackUpgradeCreditGrants(
  inputs: readonly UsagePackUpgradeCreditGrantInput[],
  prorationPeriod: UsagePackPeriod,
): Promise<readonly UsagePackUpgradeCreditGrant[]> {
  const priceIds = new Set<string>();
  for (const input of inputs) {
    priceIds.add(input.sourceStripePriceId);
    priceIds.add(input.targetStripePriceId);
  }
  const creditEntries = await Promise.all(
    [...priceIds].map(async (priceId) => {
      return [priceId, await usagePackCreditsForPrice(priceId)] as const;
    }),
  );
  const creditsByPriceId = new Map(creditEntries);
  return inputs.map((input) => {
    const sourceCredits = creditsByPriceId.get(input.sourceStripePriceId);
    const targetCredits = creditsByPriceId.get(input.targetStripePriceId);
    if (!sourceCredits || !targetCredits) {
      throw new Error("Usage pack upgrade credits could not be loaded");
    }
    return {
      purchasedCredits: proratedCreditDelta(
        sourceCredits.purchased,
        targetCredits.purchased,
        input.sourceAllocation,
        prorationPeriod,
      ),
      bonusCredits: proratedCreditDelta(
        sourceCredits.bonus,
        targetCredits.bonus,
        input.sourceAllocation,
        prorationPeriod,
      ),
    };
  });
}

function existingInvoiceFulfillmentMatches(
  existing:
    | Pick<
        typeof usagePackInvoiceFulfillments.$inferSelect,
        "usagePackSubscriptionId"
      >
    | undefined,
  invoiceId: string,
  usagePackSubscriptionId: string,
): boolean {
  if (!existing) {
    return false;
  }
  if (existing.usagePackSubscriptionId !== usagePackSubscriptionId) {
    throw new Error(
      `Invoice ${invoiceId} is already bound to another usage pack subscription`,
    );
  }
  return true;
}

const findUsagePackChangeForInvoice$ = command(
  async function findUsagePackChangeForInvoice(
    { get },
    usagePackSubscriptionId: string,
    invoice: UsagePackChangeInvoiceInput,
  ): Promise<UsagePackAllocationChangeRow | null> {
    const db = get(db$);

    const [bound] = await db
      .select()
      .from(usagePackAllocationChanges)
      .where(
        and(
          eq(usagePackAllocationChanges.stripeInvoiceId, invoice.id),
          isNull(usagePackAllocationChanges.subscriptionChangeId),
        ),
      )
      .limit(1);
    if (bound) {
      if (bound.usagePackSubscriptionId !== usagePackSubscriptionId) {
        throw new Error(
          `Invoice ${invoice.id} is bound to another usage pack change`,
        );
      }
      return bound;
    }

    const [candidate] = await db
      .select()
      .from(usagePackAllocationChanges)
      .where(
        and(
          eq(
            usagePackAllocationChanges.usagePackSubscriptionId,
            usagePackSubscriptionId,
          ),
          eq(usagePackAllocationChanges.kind, "upgrade"),
          isNull(usagePackAllocationChanges.subscriptionChangeId),
          inArray(usagePackAllocationChanges.status, [
            "applying",
            "pending_payment",
            "applied",
          ]),
          isNull(usagePackAllocationChanges.subscriptionChangeId),
          isNull(usagePackAllocationChanges.stripeInvoiceId),
        ),
      )
      .orderBy(desc(usagePackAllocationChanges.createdAt))
      .limit(1);
    if (!candidate || upgradeProrationPeriod(invoice, candidate) === null) {
      return null;
    }
    return candidate;
  },
);

function requireInvoiceFulfillmentReceipt(
  existing: typeof usagePackInvoiceFulfillments.$inferSelect | undefined,
  values: typeof usagePackInvoiceFulfillments.$inferInsert,
): void {
  if (
    !existing ||
    existing.usagePackSubscriptionId !== values.usagePackSubscriptionId ||
    existing.periodStart?.getTime() !== values.periodStart?.getTime() ||
    existing.periodEnd.getTime() !== values.periodEnd.getTime()
  ) {
    throw new Error(
      "Invoice fulfillment receipt belongs to different business facts",
    );
  }
}

const commitUsagePackUpgradeInvoice$ = command(
  async ({ set }, args: UpgradeInvoiceCommitArgs): Promise<void> => {
    const db = set(writeDb$);
    const prepared = await set(prepareUpgradeInvoicePublication$, args);
    if (!prepared) {
      return;
    }
    const { change, grantCreatedAt } = prepared;
    const completedAt = nowDate();
    const periodStart = new Date(args.prorationPeriod.start * 1000);
    const periodEnd = new Date(args.prorationPeriod.end * 1000);
    const facts = prepareUpgradeInvoiceRefundFacts(args, change);
    const plan = upgradeInvoicePublicationPlan({
      change,
      invoiceId: args.invoice.id,
      purchasedCredits: args.purchasedCredits,
      bonusCredits: args.bonusCredits,
      periodStart,
      periodEnd,
      completedAt,
      grantCreatedAt,
      ...facts,
    });
    const publication = await settle(
      db
        .with(...plan.ctes)
        .select(plan.fields)
        .from(sql`receipt`),
    );
    if (!publication.ok) {
      adaptUpgradeInvoicePublicationError(publication.error, change, facts);
    }

    const rows = publication.value;
    const winner = rows[0];
    if (rows.length !== 1 || !winner) {
      throw new Error("Expected one upgrade invoice receipt");
    }
    if (
      !winner.inserted &&
      (winner.receiptSubscriptionId !== change.usagePackSubscriptionId ||
        winner.receiptPeriodStart?.getTime() !== periodStart.getTime() ||
        winner.receiptPeriodEnd.getTime() !== periodEnd.getTime())
    ) {
      throw new Error(
        "Invoice fulfillment receipt belongs to different business facts",
      );
    }
  },
);

type UpgradeInvoiceCommitArgs = {
  readonly change: UsagePackAllocationChangeRow;
  readonly invoice: UsagePackChangeInvoiceInput;
  readonly purchasedCredits: number;
  readonly bonusCredits: number;
  readonly prorationPeriod: UsagePackPeriod;
};
const prepareUpgradeInvoicePublication$ = command(
  async ({ get }, args: UpgradeInvoiceCommitArgs) => {
    const db = get(rawSqlReadDb$);
    const positive = args.purchasedCredits > 0 || args.bonusCredits > 0;
    let grantCreatedAt: string | null = null;
    if (positive) {
      const clocks = parseRawRows(
        object({ created_at: string() }).strict(),
        await db.execute(
          sql`SELECT transaction_timestamp()::timestamp::text AS created_at`,
        ),
      );
      if (clocks.length !== 1 || !clocks[0]) {
        throw new Error("Expected one upgrade phase clock");
      }
      grantCreatedAt = clocks[0].created_at;
    }
    const [subscription] = await db
      .select()
      .from(
        grantSubscriptionOwnershipQuery(
          args.change.orgId,
          args.change.usagePackSubscriptionId,
        ),
      );
    const [wallet] = await db
      .select()
      .from(grantWalletOwnershipQuery(args.change.orgId));
    requireGrantOwnership(subscription, wallet);
    const [change] = await db
      .select()
      .from(usagePackAllocationChanges)
      .where(eq(usagePackAllocationChanges.id, args.change.id))
      .limit(1);
    if (
      !change ||
      change.orgId !== args.change.orgId ||
      change.usagePackSubscriptionId !== args.change.usagePackSubscriptionId
    ) {
      throw new Error(`Unknown or moved usage pack change: ${args.change.id}`);
    }
    const [earlyReceipt] = await db
      .select({
        subscriptionId: usagePackInvoiceFulfillments.usagePackSubscriptionId,
      })
      .from(usagePackInvoiceFulfillments)
      .where(eq(usagePackInvoiceFulfillments.stripeInvoiceId, args.invoice.id))
      .limit(1);
    if (earlyReceipt) {
      if (earlyReceipt.subscriptionId !== change.usagePackSubscriptionId) {
        throw new Error(
          `Invoice ${args.invoice.id} is already bound to another usage pack subscription`,
        );
      }
      return null;
    }
    if (
      change.kind !== "upgrade" ||
      change.status !== "applied" ||
      !change.replacementAllocationId
    ) {
      throw new Error(
        `Usage pack change ${change.id} is not ready for fulfillment`,
      );
    }
    if (change.stripeInvoiceId && change.stripeInvoiceId !== args.invoice.id) {
      throw new Error(`Usage pack change ${change.id} has another invoice`);
    }

    return { change, grantCreatedAt };
  },
);
function prepareUpgradeInvoiceRefundFacts(
  args: UpgradeInvoiceCommitArgs,
  change: UsagePackAllocationChangeRow,
) {
  let refundCalculationError: unknown;
  let refundAmountError: Error | undefined;
  let refundCalculationValid = true;
  let refundAmountValid = true;
  let sourceAmountCents: number | null = null;
  let sourceInvoiceLine: string | null = null;
  if (args.purchasedCredits > 0) {
    const computation = safeSync(() => {
      return upgradeRefundInvoiceSource(args.invoice, change);
    });
    if ("error" in computation) {
      refundCalculationValid = false;
      refundCalculationError = computation.error;
    } else {
      const source = computation.ok;
      const amount =
        source?.amountCents ??
        Math.floor(args.purchasedCredits / CREDITS_PER_CENT);
      sourceInvoiceLine = source?.invoiceLineId ?? null;
      if (!Number.isSafeInteger(amount) || amount < 0) {
        refundAmountValid = false;
        refundAmountError = new Error(
          "Usage pack refund source amount cannot be negative",
        );
      } else {
        sourceAmountCents = amount;
      }
    }
  }

  return {
    refundCalculationError,
    refundAmountError,
    refundCalculationValid,
    refundAmountValid,
    sourceAmountCents,
    sourceInvoiceLine,
  };
}
function adaptUpgradeInvoicePublicationError(
  error: unknown,
  change: UsagePackAllocationChangeRow,
  facts: ReturnType<typeof prepareUpgradeInvoiceRefundFacts>,
): never {
  if (
    error instanceof DrizzleQueryError &&
    typeof error.cause === "object" &&
    error.cause !== null &&
    "code" in error.cause &&
    error.cause.code === "22P02" &&
    "message" in error.cause &&
    typeof error.cause.message === "string"
  ) {
    const message = error.cause.message;
    const tokens = [
      "CHANGE",
      "REFUND_CALC",
      "PURCHASED_GRANT",
      "REFUND_AMOUNT",
      "REFUND_SOURCE",
      "BONUS_GRANT",
    ].filter((stage) => {
      return message.includes(`__TX0271_ATOMIC_GUARD_V1_${stage}__`);
    });
    if (tokens.length === 1) {
      switch (tokens[0]) {
        case "CHANGE": {
          throw new Error(
            `Usage pack change ${change.id} changed before fulfillment`,
          );
        }
        case "REFUND_CALC": {
          if (!facts.refundCalculationValid) {
            throw facts.refundCalculationError;
          }
          break;
        }
        case "REFUND_AMOUNT": {
          if (facts.refundAmountError) {
            throw facts.refundAmountError;
          }
          break;
        }
        case "PURCHASED_GRANT":
        case "BONUS_GRANT": {
          throw new Error("Usage pack credit grant idempotency key conflict");
        }
        case "REFUND_SOURCE": {
          throw new Error("Usage pack credit refund source conflict");
        }
      }
    }
  }
  throw error;
}

interface SubscriptionChangeFulfillmentArgs {
  readonly subscriptionChangeId: string;
  readonly prorationTimestamp: number;
  readonly periodStart: number;
  readonly periodEnd: number;
  readonly invoice: UsagePackChangeInvoiceInput;
}

interface PreparedSubscriptionChangeGrant {
  readonly change: UsagePackAllocationChangeRow;
  readonly purchasedCredits: number;
  readonly bonusCredits: number;
  readonly stripeInvoiceLineId: string | null;
  readonly sourceAmountCents: number;
}

const prepareSubscriptionChangeFulfillment$ = command(
  async (
    { get },
    args: SubscriptionChangeFulfillmentArgs,
  ): Promise<{
    readonly expectedRoot: UsagePackSubscriptionChangeRow;
    readonly preparedGrants: readonly PreparedSubscriptionChangeGrant[];
  }> => {
    const db = get(db$);
    const [changes, roots] = await Promise.all([
      db
        .select()
        .from(usagePackAllocationChanges)
        .where(
          eq(
            usagePackAllocationChanges.subscriptionChangeId,
            args.subscriptionChangeId,
          ),
        ),
      db
        .select()
        .from(usagePackSubscriptionChanges)
        .where(eq(usagePackSubscriptionChanges.id, args.subscriptionChangeId))
        .limit(1),
    ]);
    const expectedRoot = roots[0];
    if (!expectedRoot) {
      throw new Error(
        `Unknown usage pack subscription change: ${args.subscriptionChangeId}`,
      );
    }
    if (
      changes.length === 0 &&
      expectedRoot.sourceTier === expectedRoot.targetTier
    ) {
      throw new Error(
        `Subscription change ${expectedRoot.id} has neither a plan nor package change`,
      );
    }
    const immediateChanges = changes.filter((change) => {
      return change.kind === "addition" || change.kind === "upgrade";
    });
    const prorationPeriod = {
      start: args.prorationTimestamp,
      end: args.periodEnd,
    };
    const preparedGrants = await Promise.all(
      immediateChanges.map(async (change) => {
        if (!change.targetStripePriceId) {
          throw new Error(
            `Subscription change allocation ${change.id} has no target Price`,
          );
        }
        if (change.kind === "addition") {
          const grant = await calculateUsagePackAdditionCreditGrant(
            change.targetStripePriceId,
            { start: args.periodStart, end: args.periodEnd },
            args.prorationTimestamp,
          );
          const refundSource = upgradeRefundInvoiceSource(args.invoice, change);
          return {
            change,
            ...grant,
            stripeInvoiceLineId: refundSource?.invoiceLineId ?? null,
            sourceAmountCents:
              refundSource?.amountCents ??
              Math.floor(grant.purchasedCredits / CREDITS_PER_CENT),
          };
        }
        if (!change.sourceAllocationId || !change.sourceStripePriceId) {
          throw new Error(
            `Subscription change allocation ${change.id} has no source`,
          );
        }
        const [sourceAllocation] = await db
          .select()
          .from(usagePackAllocations)
          .where(eq(usagePackAllocations.id, change.sourceAllocationId))
          .limit(1);
        if (!sourceAllocation) {
          throw new Error(
            `Subscription change allocation ${change.id} is incomplete`,
          );
        }
        const [sourceCredits, targetCredits] = await Promise.all([
          usagePackCreditsForPrice(change.sourceStripePriceId),
          usagePackCreditsForPrice(change.targetStripePriceId),
        ]);
        const purchasedCredits = proratedCreditDelta(
          sourceCredits.purchased,
          targetCredits.purchased,
          sourceAllocation,
          prorationPeriod,
        );
        const refundSource = upgradeRefundInvoiceSource(args.invoice, change);
        return {
          change,
          purchasedCredits,
          bonusCredits: proratedCreditDelta(
            sourceCredits.bonus,
            targetCredits.bonus,
            sourceAllocation,
            prorationPeriod,
          ),
          stripeInvoiceLineId: refundSource?.invoiceLineId ?? null,
          sourceAmountCents:
            refundSource?.amountCents ??
            Math.floor(purchasedCredits / CREDITS_PER_CENT),
        };
      }),
    );
    return { expectedRoot, preparedGrants };
  },
);

function fulfillmentChangeIdentity(change: UsagePackAllocationChangeRow) {
  return and(
    eq(usagePackAllocationChanges.orgId, change.orgId),
    eq(
      usagePackAllocationChanges.usagePackSubscriptionId,
      change.usagePackSubscriptionId,
    ),
    eq(usagePackAllocationChanges.kind, change.kind),
    sql`${usagePackAllocationChanges.subscriptionChangeId} IS NOT DISTINCT FROM ${change.subscriptionChangeId}`,
    sql`${usagePackAllocationChanges.userId} IS NOT DISTINCT FROM ${change.userId}`,
    sql`${usagePackAllocationChanges.sourceAllocationId} IS NOT DISTINCT FROM ${change.sourceAllocationId}`,
    sql`${usagePackAllocationChanges.replacementAllocationId} IS NOT DISTINCT FROM ${change.replacementAllocationId}`,
    sql`${usagePackAllocationChanges.sourceStripePriceId} IS NOT DISTINCT FROM ${change.sourceStripePriceId}`,
    sql`${usagePackAllocationChanges.targetStripePriceId} IS NOT DISTINCT FROM ${change.targetStripePriceId}`,
    sql`${usagePackAllocationChanges.sourceUsagePackUsd} IS NOT DISTINCT FROM ${change.sourceUsagePackUsd}`,
    sql`${usagePackAllocationChanges.targetUsagePackUsd} IS NOT DISTINCT FROM ${change.targetUsagePackUsd}`,
  );
}

function requireSubscriptionChangeFulfillmentRoot(
  root: UsagePackSubscriptionChangeRow | undefined,
  expectedRoot: UsagePackSubscriptionChangeRow,
  subscriptionChangeId: string,
): UsagePackSubscriptionChangeRow {
  if (
    !root ||
    root.orgId !== expectedRoot.orgId ||
    root.usagePackSubscriptionId !== expectedRoot.usagePackSubscriptionId
  ) {
    throw new Error(
      `Unknown usage pack subscription change: ${subscriptionChangeId}`,
    );
  }
  return root;
}

function subscriptionChangeFulfillmentCondition(
  change: UsagePackAllocationChangeRow,
) {
  return and(
    eq(usagePackAllocationChanges.id, change.id),
    inArray(usagePackAllocationChanges.kind, ["addition", "upgrade"]),
    eq(usagePackAllocationChanges.status, "applied"),
    fulfillmentChangeIdentity(change),
    isNotNull(usagePackAllocationChanges.replacementAllocationId),
  );
}

function subscriptionChangePurchasedGrantValues(
  rootId: string,
  change: UsagePackAllocationChangeRow,
  args: SubscriptionChangeFulfillmentArgs,
  prepared: PreparedSubscriptionChangeGrant,
): UsagePackCreditGrantArgs {
  return {
    orgId: change.orgId,
    userId: change.userId,
    grantType: "purchased",
    idempotencyKey: `usage-pack-subscription-change:${rootId}:${change.id}:${args.invoice.id}:purchased`,
    amount: prepared.purchasedCredits,
    expiresAt: new Date(args.periodEnd * 1000),
    refundSource: {
      type: "invoice",
      invoiceId: args.invoice.id,
      invoiceLineId: prepared.stripeInvoiceLineId,
      amountCents: prepared.sourceAmountCents,
    },
  };
}

function subscriptionChangeBonusGrantValues(
  rootId: string,
  change: UsagePackAllocationChangeRow,
  args: SubscriptionChangeFulfillmentArgs,
  prepared: PreparedSubscriptionChangeGrant,
): UsagePackCreditGrantArgs {
  return {
    orgId: change.orgId,
    userId: change.userId,
    grantType: "bonus",
    idempotencyKey: `usage-pack-subscription-change:${rootId}:${change.id}:${args.invoice.id}:bonus`,
    amount: prepared.bonusCredits,
    expiresAt: new Date(args.periodEnd * 1000),
  };
}

function subscriptionChangeGrants(
  rootId: string,
  change: UsagePackAllocationChangeRow,
  args: SubscriptionChangeFulfillmentArgs,
  prepared: PreparedSubscriptionChangeGrant,
): UsagePackCreditGrantArgs[] {
  return [
    ...(prepared.purchasedCredits > 0
      ? [subscriptionChangePurchasedGrantValues(rootId, change, args, prepared)]
      : []),
    ...(prepared.bonusCredits > 0
      ? [subscriptionChangeBonusGrantValues(rootId, change, args, prepared)]
      : []),
  ];
}

function subscriptionChangeReceiptValues(
  root: UsagePackSubscriptionChangeRow,
  args: SubscriptionChangeFulfillmentArgs,
) {
  return {
    stripeInvoiceId: args.invoice.id,
    usagePackSubscriptionId: root.usagePackSubscriptionId,
    periodStart: new Date(args.prorationTimestamp * 1000),
    periodEnd: new Date(args.periodEnd * 1000),
  };
}

function invoiceFulfillmentCondition(invoiceId: string) {
  return eq(usagePackInvoiceFulfillments.stripeInvoiceId, invoiceId);
}

function adaptSubscriptionInvoicePublicationError(
  error: unknown,
  changes: readonly {
    readonly prepared: PreparedSubscriptionChangeGrant;
    readonly grants: readonly {
      readonly source: ReturnType<
        typeof safeSync<ReturnType<typeof sourceColumns>>
      > | null;
    }[];
  }[],
): never {
  if (
    !(error instanceof DrizzleQueryError) ||
    typeof error.cause !== "object" ||
    error.cause === null ||
    !("code" in error.cause) ||
    error.cause.code !== "22P02" ||
    !("message" in error.cause) ||
    typeof error.cause.message !== "string"
  ) {
    throw error;
  }
  const match =
    /^invalid input syntax for type integer: "__TX0272_ATOMIC_GUARD_V1_(CHANGE|GRANT|REFUND_AMOUNT|REFUND_SOURCE)_(\d+)(?:_(\d+))?__"$/.exec(
      error.cause.message,
    );
  const change = match ? changes[Number(match[2])] : undefined;
  if (!match || !change) {
    throw error;
  }
  switch (match[1]) {
    case "CHANGE": {
      throw new Error(
        `Subscription change allocation ${change.prepared.change.id} is not ready for fulfillment`,
      );
    }
    case "GRANT": {
      throw new Error("Usage pack credit grant idempotency key conflict");
    }
    case "REFUND_SOURCE": {
      throw new Error("Usage pack credit refund source conflict");
    }
    case "REFUND_AMOUNT": {
      const source = change.grants[Number(match[3])]?.source;
      if (source && "error" in source) {
        throw source.error;
      }
      break;
    }
  }
  throw error;
}

export const fulfillUsagePackSubscriptionChangeInvoice$ = command(
  async function fulfillUsagePackSubscriptionChangeInvoice(
    { set },
    args: SubscriptionChangeFulfillmentArgs,
  ): Promise<void> {
    const db = set(writeDb$);
    const { expectedRoot, preparedGrants } = await set(
      prepareSubscriptionChangeFulfillment$,
      args,
    );
    const [subscription] = await db
      .select()
      .from(
        grantSubscriptionOwnershipQuery(
          expectedRoot.orgId,
          expectedRoot.usagePackSubscriptionId,
        ),
      );
    const [wallet] = await db
      .select()
      .from(grantWalletOwnershipQuery(expectedRoot.orgId));
    requireGrantOwnership(subscription, wallet);
    const [storedRoot] = await db
      .select()
      .from(usagePackSubscriptionChanges)
      .where(eq(usagePackSubscriptionChanges.id, args.subscriptionChangeId))
      .limit(1);
    const root = requireSubscriptionChangeFulfillmentRoot(
      storedRoot,
      expectedRoot,
      args.subscriptionChangeId,
    );
    const [existing] = await db
      .select({
        usagePackSubscriptionId:
          usagePackInvoiceFulfillments.usagePackSubscriptionId,
      })
      .from(usagePackInvoiceFulfillments)
      .where(invoiceFulfillmentCondition(args.invoice.id))
      .limit(1);
    if (
      existingInvoiceFulfillmentMatches(
        existing,
        args.invoice.id,
        root.usagePackSubscriptionId,
      )
    ) {
      return;
    }

    const values = subscriptionChangeReceiptValues(root, args);
    const changes = preparedGrants.map((prepared) => {
      const completedAt = nowDate();
      return {
        prepared,
        completedAt,
        id: prepared.change.id,
        condition: subscriptionChangeFulfillmentCondition(prepared.change),
        grants: subscriptionChangeGrants(
          root.id,
          prepared.change,
          args,
          prepared,
        ).map((grant) => {
          const refundSource = grant.refundSource;
          const source = refundSource
            ? safeSync(() => {
                return sourceColumns(refundSource);
              })
            : null;
          return { grant, source };
        }),
      };
    });
    const plan = subscriptionInvoicePublicationPlan(
      values,
      changes.map((change) => {
        return {
          ...change,
          grants: change.grants.map(({ grant, source }) => {
            return {
              grant,
              source: source && "ok" in source ? source.ok : null,
            };
          }),
        };
      }),
    );
    const publication = await settle(
      db
        .with(...plan.ctes)
        .select(plan.fields)
        .from(plan.from),
    );
    if (!publication.ok) {
      adaptSubscriptionInvoicePublicationError(publication.error, changes);
    }
    const rows = publication.value;
    if (rows.length !== 1 || !rows[0]) {
      throw new Error("Expected one subscription invoice publication result");
    }
    if (!rows[0].inserted) {
      // A concurrent receipt winner can be invisible to the statement snapshot.
      // No dependent write ran; validate it using the original fresh-read rule.
      const [winner] = await db
        .select()
        .from(usagePackInvoiceFulfillments)
        .where(invoiceFulfillmentCondition(values.stripeInvoiceId))
        .limit(1);
      requireInvoiceFulfillmentReceipt(winner, values);
    }
  },
);

const CANCELED_CHANGE_FAILURE_REASON = "subscription_canceled";
const CANCELED_CHANGE_REFUNDED_FAILURE_REASON =
  "subscription_canceled_refunded";
const CANCELED_CHANGE_REFUND_PURPOSE = "usage_pack_change_canceled_refund";

function isCanceledChangeForInvoice(
  change: UsagePackAllocationChangeRow,
  invoiceId: string,
): boolean {
  return (
    change.status === "failed" &&
    change.stripeInvoiceId === invoiceId &&
    (change.failureReason === CANCELED_CHANGE_FAILURE_REASON ||
      change.failureReason === CANCELED_CHANGE_REFUNDED_FAILURE_REASON)
  );
}

async function existingCanceledChangeCreditNote(
  stripe: StripeClient,
  invoiceId: string,
  changeId: string,
): Promise<boolean> {
  const page = await stripe.creditNotes.list({
    invoice: invoiceId,
    limit: 100,
  });
  const existing = page.data.some((creditNote) => {
    return (
      creditNote.metadata?.purpose === CANCELED_CHANGE_REFUND_PURPOSE &&
      creditNote.metadata.changeId === changeId
    );
  });
  if (!existing && page.has_more) {
    throw new Error(`Stripe invoice ${invoiceId} has too many credit notes`);
  }
  return existing;
}

/**
 * A pending upgrade whose subscription was deleted before its invoice was
 * paid can never be fulfilled. Credit the whole paid invoice back instead of
 * granting. The bound change row (unique stripe_invoice_id) identifies the
 * invoice; the Stripe idempotency key and the credit note metadata keep the
 * refund single even when the local record below is lost.
 */
const refundCanceledUsagePackChangeInvoice$ = command(
  async function refundCanceledUsagePackChangeInvoice(
    { set },
    change: UsagePackAllocationChangeRow,
    invoice: UsagePackChangeInvoiceInput,
  ): Promise<void> {
    const db = set(writeDb$);

    if (change.failureReason === CANCELED_CHANGE_REFUNDED_FAILURE_REASON) {
      return;
    }
    const total = invoice.total;
    const amountPaid = invoice.amount_paid;
    if (
      total === undefined ||
      amountPaid === undefined ||
      !Number.isSafeInteger(total) ||
      !Number.isSafeInteger(amountPaid) ||
      amountPaid < 0 ||
      amountPaid > total
    ) {
      throw new Error(
        `Usage pack change invoice ${invoice.id} has invalid paid amounts`,
      );
    }
    if (total > 0) {
      const stripe = getStripeClient();
      if (
        !(await existingCanceledChangeCreditNote(stripe, invoice.id, change.id))
      ) {
        // Customer-balance funded parts return to the balance; the charged part
        // is refunded to the original payment method.
        await stripe.creditNotes.create(
          {
            invoice: invoice.id,
            amount: total,
            refund_amount: amountPaid,
            ...(total > amountPaid
              ? { credit_amount: total - amountPaid }
              : {}),
            reason: "order_change",
            metadata: {
              purpose: CANCELED_CHANGE_REFUND_PURPOSE,
              changeId: change.id,
              invoiceId: invoice.id,
            },
          },
          {
            idempotencyKey: `usage-pack-change:${change.id}:${invoice.id}:canceled-refund`,
          },
        );
      }
    }
    const at = nowDate();
    await db
      .update(usagePackAllocationChanges)
      .set({
        failureReason: CANCELED_CHANGE_REFUNDED_FAILURE_REASON,
        updatedAt: at,
      })
      .where(
        and(
          eq(usagePackAllocationChanges.id, change.id),
          eq(usagePackAllocationChanges.status, "failed"),
          eq(usagePackAllocationChanges.stripeInvoiceId, invoice.id),
          eq(
            usagePackAllocationChanges.failureReason,
            CANCELED_CHANGE_FAILURE_REASON,
          ),
        ),
      );
  },
);

/**
 * Subscription deletion makes the usage pack record terminal, so its paid
 * pending-upgrade invoice no longer resolves through the active binding. The
 * change row's unique stripe_invoice_id still identifies the canceled change.
 */
const refundCanceledChangeOfTerminalSubscription$ = command(
  async function refundCanceledChangeOfTerminalSubscription(
    { get, set },
    invoice: UsagePackChangeInvoiceInput,
  ): Promise<UsagePackChangeInvoiceOutcome> {
    const db = get(db$);

    const [change] = await db
      .select()
      .from(usagePackAllocationChanges)
      .where(
        and(
          eq(usagePackAllocationChanges.stripeInvoiceId, invoice.id),
          isNull(usagePackAllocationChanges.subscriptionChangeId),
        ),
      )
      .limit(1);
    if (!change || !isCanceledChangeForInvoice(change, invoice.id)) {
      return { handled: false, orgId: null };
    }
    const [subscription] = await db
      .select()
      .from(usagePackSubscriptions)
      .where(eq(usagePackSubscriptions.id, change.usagePackSubscriptionId))
      .limit(1);
    if (
      !subscription ||
      subscription.orgId !== change.orgId ||
      !subscription.stripeSubscriptionId ||
      subscription.stripeSubscriptionId !== invoiceSubscriptionId(invoice) ||
      subscription.stripeCustomerId !== stripeObjectId(invoice.customer)
    ) {
      throw new Error(
        `Usage pack change invoice ${invoice.id} does not match its change owner`,
      );
    }
    if (invoice.status !== "paid" && invoice.paid !== true) {
      throw new Error(`Usage pack change invoice ${invoice.id} is not paid`);
    }
    await set(refundCanceledUsagePackChangeInvoice$, change, invoice);
    return { handled: true, orgId: change.orgId };
  },
);

export const handleUsagePackAllocationChangeInvoicePaid$ = command(
  async function handleUsagePackAllocationChangeInvoicePaid(
    { set },
    invoice: UsagePackChangeInvoiceInput,
  ): Promise<UsagePackChangeInvoiceOutcome> {
    const usagePackSubscriptionId = await set(
      invoiceUsagePackSubscriptionIdOwned$,
      invoice,
    );
    if (!usagePackSubscriptionId) {
      return await set(refundCanceledChangeOfTerminalSubscription$, invoice);
    }
    const context = await set(
      loadUsagePackChangeContextForPhase$,
      usagePackSubscriptionId,
    );
    if (!context) {
      throw new Error(
        `Unknown usage pack subscription: ${usagePackSubscriptionId}`,
      );
    }
    if (
      await set(
        usagePackInvoiceFulfillmentExistsOwned$,
        invoice.id,
        usagePackSubscriptionId,
      )
    ) {
      return { handled: true, orgId: context.subscription.orgId };
    }
    const change = await set(
      findUsagePackChangeForInvoice$,
      usagePackSubscriptionId,
      invoice,
    );
    if (!change) {
      return { handled: false, orgId: null };
    }
    if (invoice.status !== "paid" && invoice.paid !== true) {
      throw new Error(`Usage pack change invoice ${invoice.id} is not paid`);
    }
    const subscriptionId = invoiceSubscriptionId(invoice);
    if (
      !subscriptionId ||
      subscriptionId !== context.subscription.stripeSubscriptionId
    ) {
      throw new Error(
        `Usage pack change invoice ${invoice.id} has the wrong subscription`,
      );
    }
    if (
      stripeObjectId(invoice.customer) !== context.subscription.stripeCustomerId
    ) {
      throw new Error(
        `Usage pack change invoice ${invoice.id} has the wrong customer`,
      );
    }
    const stripeSubscription =
      await getStripeClient().subscriptions.retrieve(subscriptionId);
    await set(
      reconcileUsagePackAllocationChangeSubscription$,
      stripeSubscription,
    );
    if (
      change.kind !== "upgrade" ||
      !change.sourceAllocationId ||
      !change.sourceStripePriceId
    ) {
      throw new Error(`Usage pack change ${change.id} is not an upgrade`);
    }

    const { reconciledChange, sourceAllocation } = await set(
      loadUpgradeInvoiceObservation$,
      change.id,
      change.sourceAllocationId,
    );
    if (isCanceledChangeForInvoice(reconciledChange, invoice.id)) {
      await set(
        refundCanceledUsagePackChangeInvoice$,
        reconciledChange,
        invoice,
      );
      return { handled: true, orgId: context.subscription.orgId };
    }
    const prorationPeriod = upgradeProrationPeriod(invoice, reconciledChange);
    if (!prorationPeriod) {
      throw new Error(
        `Usage pack change invoice ${invoice.id} has no proration lines`,
      );
    }
    if (
      !reconciledChange.sourceStripePriceId ||
      !reconciledChange.targetStripePriceId
    ) {
      throw new Error(`Usage pack change ${change.id} has incomplete Prices`);
    }
    const [sourceCredits, targetCredits] = await Promise.all([
      usagePackCreditsForPrice(reconciledChange.sourceStripePriceId),
      usagePackCreditsForPrice(reconciledChange.targetStripePriceId),
    ]);
    const purchasedCredits = proratedCreditDelta(
      sourceCredits.purchased,
      targetCredits.purchased,
      sourceAllocation,
      prorationPeriod,
    );
    const bonusCredits = proratedCreditDelta(
      sourceCredits.bonus,
      targetCredits.bonus,
      sourceAllocation,
      prorationPeriod,
    );
    await set(commitUsagePackUpgradeInvoice$, {
      change: reconciledChange,
      invoice,
      purchasedCredits,
      bonusCredits,
      prorationPeriod,
    });
    return { handled: true, orgId: context.subscription.orgId };
  },
);

const failExpiredUsagePackUpgrade$ = command(
  async function failExpiredUsagePackUpgrade(
    { set },
    context: UsagePackChangeContext,
    subscription: UsagePackChangeSubscriptionInput,
    at: Date,
  ): Promise<number> {
    const db = set(writeDb$);

    if (subscription.pending_update) {
      return 0;
    }
    validateCurrentStripeProjection(context, subscription);
    const staleBefore = new Date(at.getTime() - CHANGE_RECONCILIATION_DELAY_MS);
    const [failed] = await db
      .update(usagePackAllocationChanges)
      .set({
        status: "failed",
        failureReason: "pending_update_expired",
        completedAt: at,
        updatedAt: at,
      })
      .where(
        and(
          eq(
            usagePackAllocationChanges.usagePackSubscriptionId,
            context.subscription.id,
          ),
          eq(usagePackAllocationChanges.kind, "upgrade"),
          inArray(usagePackAllocationChanges.status, [
            "applying",
            "pending_payment",
          ]),
          or(
            lte(usagePackAllocationChanges.stripePendingUpdateExpiresAt, at),
            and(
              isNull(usagePackAllocationChanges.stripePendingUpdateExpiresAt),
              lte(usagePackAllocationChanges.updatedAt, staleBefore),
            ),
          ),
        ),
      )
      .returning({ id: usagePackAllocationChanges.id });
    return failed ? 1 : 0;
  },
);

async function paidUpgradeInvoiceForSubscription(
  subscription: StripeSubscription,
): Promise<UsagePackChangeInvoiceInput | null> {
  const expanded = latestInvoice(subscription);
  if (expanded) {
    return expanded.status === "paid"
      ? (expanded as UsagePackChangeInvoiceInput)
      : null;
  }
  if (typeof subscription.latest_invoice !== "string") {
    return null;
  }
  const invoice = await getStripeClient().invoices.retrieve(
    subscription.latest_invoice,
  );
  return invoice.status === "paid"
    ? (invoice as UsagePackChangeInvoiceInput)
    : null;
}

const usagePackChangeCandidateSubscriptionIds$ = command(
  async function usagePackChangeCandidateSubscriptionIds(
    { get },
    at: Date,
    staleBefore: Date,
  ): Promise<readonly string[]> {
    const db = get(db$);

    const rows = await db
      .select({
        usagePackSubscriptionId:
          usagePackAllocationChanges.usagePackSubscriptionId,
      })
      .from(usagePackAllocationChanges)
      .where(
        and(
          or(
            and(
              inArray(usagePackAllocationChanges.status, [
                "applying",
                "pending_payment",
              ]),
              lte(usagePackAllocationChanges.updatedAt, staleBefore),
            ),
            eq(usagePackAllocationChanges.status, "applied"),
            and(
              eq(usagePackAllocationChanges.status, "scheduled"),
              lte(usagePackAllocationChanges.effectiveAt, at),
            ),
          ),
        ),
      )
      .limit(100);
    return [
      ...new Set(
        rows.map((row) => {
          return row.usagePackSubscriptionId;
        }),
      ),
    ];
  },
);

const reconcileUsagePackAllocationChangeCandidate$ = command(
  async function reconcileUsagePackAllocationChangeCandidate(
    { set },
    usagePackSubscriptionId: string,
    at: Date,
    signal: AbortSignal,
  ): Promise<{
    readonly reconciled: number;
    readonly orgIds: readonly string[];
    readonly emptyCancellations: readonly EmptyUsagePackCancellation[];
  }> {
    let reconciled = 0;
    const orgIds = new Set<string>();
    const emptyCancellations: EmptyUsagePackCancellation[] = [];
    const context = await set(
      loadUsagePackChangeContextForPhase$,
      usagePackSubscriptionId,
    );
    signal.throwIfAborted();
    if (!context?.subscription.stripeSubscriptionId) {
      return { reconciled, orgIds: [...orgIds], emptyCancellations };
    }
    const subscription = await getStripeClient().subscriptions.retrieve(
      context.subscription.stripeSubscriptionId,
      { expand: ["latest_invoice"] },
    );
    signal.throwIfAborted();
    const reflected = await set(
      reconcileCandidateUsagePackSubscription$,
      subscription,
    );
    signal.throwIfAborted();
    reconciled = reflected.reconciled;
    for (const id of reflected.orgIds) {
      orgIds.add(id);
    }
    const deferred = await set(
      prepareCandidateDeferredAtCheckpoint$,
      usagePackSubscriptionId,
      subscription,
      signal,
    );
    if (deferred.kind === "missing") {
      return { reconciled, orgIds: [...orgIds], emptyCancellations };
    }
    if (deferred.kind === "schedule") {
      await set(
        finishCandidateDeferredSchedule$,
        deferred,
        subscription,
        signal,
      );
      reconciled += 1;
    }
    if (deferred.kind === "cancellation") {
      emptyCancellations.push(deferred.cancellation);
    }
    const hasOpenUpgrade = deferred.context.changes.some((change) => {
      return change.subscriptionChangeId === null && change.kind === "upgrade";
    });
    let invoice: UsagePackChangeInvoiceInput | null = null;
    if (hasOpenUpgrade) {
      invoice = await paidUpgradeInvoiceForSubscription(subscription);
      signal.throwIfAborted();
    }
    const finished = await set(finishCandidateUsagePackInvoice$, {
      usagePackSubscriptionId,
      subscription,
      at,
      invoice,
      reconciled,
      orgIds: [...orgIds],
      emptyCancellations,
    });
    signal.throwIfAborted();
    return finished;
  },
);

export const reconcileUsagePackAllocationChanges$ = command(
  async function reconcileUsagePackAllocationChanges(
    { set },
    signal: AbortSignal,
  ): Promise<{
    readonly reconciled: number;
    readonly orgIds: readonly string[];
    readonly emptyCancellations: readonly EmptyUsagePackCancellation[];
  }> {
    const db = set(writeDb$);

    signal.throwIfAborted();
    const at = nowDate();
    const staleBefore = new Date(at.getTime() - CHANGE_RECONCILIATION_DELAY_MS);
    const expiredPreviews = await db
      .update(usagePackAllocationChanges)
      .set({
        status: "failed",
        failureReason: "preview_expired",
        completedAt: at,
        updatedAt: at,
      })
      .where(
        and(
          eq(usagePackAllocationChanges.status, "previewed"),
          lte(usagePackAllocationChanges.previewExpiresAt, at),
        ),
      )
      .returning({ id: usagePackAllocationChanges.id });
    signal.throwIfAborted();

    const subscriptionIds = await set(
      usagePackChangeCandidateSubscriptionIds$,
      at,
      staleBefore,
    );
    signal.throwIfAborted();
    const orgIds = new Set<string>();
    const emptyCancellations: EmptyUsagePackCancellation[] = [];
    let reconciled = expiredPreviews.length;
    for (const usagePackSubscriptionId of subscriptionIds) {
      const result = await settle(
        set(
          reconcileUsagePackAllocationChangeCandidate$,
          usagePackSubscriptionId,
          at,
          signal,
        ),
        signal,
      );
      if (!result.ok) {
        L.error("usage pack allocation change reconciliation failed", {
          usagePackSubscriptionId,
          error: result.error,
        });
        continue;
      }
      reconciled += result.value.reconciled;
      emptyCancellations.push(...result.value.emptyCancellations);
      for (const orgId of result.value.orgIds) {
        orgIds.add(orgId);
      }
    }
    return { reconciled, orgIds: [...orgIds], emptyCancellations };
  },
);

function existingConfirmationResponse(
  change: UsagePackAllocationChangeRow,
): UsagePackChangeConfirmResponse | null {
  switch (change.status) {
    case "applied": {
      return {
        status: "processing",
        effectiveAt: change.effectiveAt?.toISOString() ?? null,
        hostedInvoiceUrl: null,
      };
    }
    case "pending_payment": {
      return {
        status: "pending_payment",
        effectiveAt: change.effectiveAt?.toISOString() ?? null,
        hostedInvoiceUrl: null,
      };
    }
    case "scheduled": {
      return {
        status: "scheduled",
        effectiveAt: change.effectiveAt?.toISOString() ?? null,
        hostedInvoiceUrl: null,
      };
    }
    case "completed": {
      return {
        status: "completed",
        effectiveAt: change.effectiveAt?.toISOString() ?? null,
        hostedInvoiceUrl: null,
      };
    }
    case "previewed":
    case "applying":
    case "failed": {
      return null;
    }
  }
}

type PreparedUsagePackChangeConfirmation =
  | { readonly status: "ready"; readonly change: UsagePackAllocationChangeRow }
  | {
      readonly status: "resuming";
      readonly change: UsagePackAllocationChangeRow;
    }
  | {
      readonly status: "existing";
      readonly response: UsagePackChangeConfirmResponse;
    }
  | { readonly status: "not_found" }
  | { readonly status: "expired" }
  | { readonly status: "conflict" };

/**
 * Before a previewed member change is claimed for payment, converge temporary
 * Stripe drift from local allocations. Once claimed, the change is a financial
 * operation and the identity sync defers to it.
 */
export const repairUsagePackConfigurationBeforeConfirmation$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly changeId: string },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const [change] = await db
      .select({
        usagePackSubscriptionId:
          usagePackAllocationChanges.usagePackSubscriptionId,
      })
      .from(usagePackAllocationChanges)
      .where(
        and(
          eq(usagePackAllocationChanges.id, args.changeId),
          eq(usagePackAllocationChanges.orgId, args.orgId),
          eq(usagePackAllocationChanges.status, "previewed"),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!change) {
      return;
    }
    await set(
      repairUsagePackConfigurationBeforeQuote$,
      change.usagePackSubscriptionId,
      signal,
    );
  },
);

function activeAllocationSourceCondition(
  change: UsagePackAllocationChangeRow,
  source: typeof usagePackAllocations.$inferSelect,
) {
  return sql`EXISTS (${new QueryBuilder()
    .select({ id: usagePackAllocations.id })
    .from(usagePackAllocations)
    .where(
      and(
        eq(usagePackAllocations.id, source.id),
        eq(usagePackAllocations.orgId, change.orgId),
        eq(
          usagePackAllocations.usagePackSubscriptionId,
          change.usagePackSubscriptionId,
        ),
        eq(usagePackAllocations.userId, change.userId),
        eq(usagePackAllocations.status, "active"),
        eq(usagePackAllocations.stripePriceId, source.stripePriceId),
        eq(usagePackAllocations.usagePackUsd, source.usagePackUsd),
      ),
    )})`;
}

export const prepareUsagePackChangeConfirmation$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly changeId: string },
    signal: AbortSignal,
  ): Promise<PreparedUsagePackChangeConfirmation> => {
    const db = set(writeDb$);
    const at = nowDate();
    const result = await (async () => {
      // The existing live standalone-operation uniqueness plus the real
      // preview -> applying transition admits this stored financial intent.
      const [found] = await db
        .select({ change: usagePackAllocationChanges })
        .from(usagePackAllocationChanges)
        .innerJoin(
          usagePackSubscriptions,
          and(
            eq(
              usagePackSubscriptions.id,
              usagePackAllocationChanges.usagePackSubscriptionId,
            ),
            eq(usagePackSubscriptions.orgId, usagePackAllocationChanges.orgId),
          ),
        )
        .where(
          and(
            eq(usagePackAllocationChanges.id, args.changeId),
            eq(usagePackAllocationChanges.orgId, args.orgId),
          ),
        )
        .limit(1);
      const change = found?.change;
      if (!change) {
        return { status: "not_found" as const };
      }
      const existing = existingConfirmationResponse(change);
      if (existing) {
        return { status: "existing" as const, response: existing };
      }
      if (change.status === "failed") {
        return { status: "conflict" as const };
      }
      if (
        (
          await db.execute(
            conflictingUsagePackMutationSql({
              subscriptionId: change.usagePackSubscriptionId,
              allocationChangeId: change.id,
            }),
          )
        ).rowCount
      ) {
        return { status: "conflict" as const };
      }
      if (change.status === "applying") {
        return { status: "resuming" as const, change };
      }
      const previewedChange = and(
        eq(usagePackAllocationChanges.id, change.id),
        eq(usagePackAllocationChanges.status, "previewed"),
        fulfillmentChangeIdentity(change),
      );
      if (!change.previewExpiresAt || change.previewExpiresAt <= at) {
        const [expired] = await db
          .update(usagePackAllocationChanges)
          .set({
            status: "failed",
            failureReason: "preview_expired",
            completedAt: at,
            updatedAt: at,
          })
          .where(previewedChange)
          .returning({ id: usagePackAllocationChanges.id });
        return expired
          ? { status: "expired" as const }
          : { status: "conflict" as const };
      }
      if (!change.sourceAllocationId) {
        throw new Error(`Usage pack change ${change.id} has no source`);
      }
      // The source is revalidated again when the Stripe result is reflected.
      const [source] = await db
        .select()
        .from(usagePackAllocations)
        .where(eq(usagePackAllocations.id, change.sourceAllocationId))
        .limit(1);
      if (
        !source ||
        source.status !== "active" ||
        source.userId !== change.userId ||
        source.usagePackUsd !== change.sourceUsagePackUsd ||
        source.stripePriceId !== change.sourceStripePriceId
      ) {
        await db
          .update(usagePackAllocationChanges)
          .set({
            status: "failed",
            failureReason: "allocation_changed",
            completedAt: at,
            updatedAt: at,
          })
          .where(previewedChange);
        return { status: "conflict" as const };
      }
      const [prepared] = await db
        .update(usagePackAllocationChanges)
        .set({ status: "applying", updatedAt: at })
        .where(
          and(
            previewedChange,
            sql`NOT EXISTS (${conflictingUsagePackMutationSql({ subscriptionId: change.usagePackSubscriptionId, allocationChangeId: change.id })})`,
            activeAllocationSourceCondition(change, source),
          ),
        )
        .returning();
      return prepared
        ? { status: "ready" as const, change: prepared }
        : { status: "conflict" as const };
    })();
    signal.throwIfAborted();
    return result;
  },
);

const confirmUsagePackDowngrade$ = command(
  async function confirmUsagePackDowngrade(
    { set },
    context: UsagePackChangeContext,
    change: UsagePackAllocationChangeRow,
    subscription: StripeSubscription,
    signal: AbortSignal,
  ): Promise<UsagePackChangeConfirmResult> {
    if (
      !change.sourceStripePriceId ||
      !change.targetStripePriceId ||
      change.targetUsagePackUsd === null
    ) {
      throw new Error("Usage pack downgrade has no target package");
    }
    const scheduled = await set(
      scheduleDeferredUsagePackChange$,
      context,
      change,
      subscription,
      signal,
    );
    if ("emptyCancellation" in scheduled) {
      throw new Error("A usage pack downgrade must retain a package");
    }
    return {
      status: "confirmed",
      response: {
        status: "scheduled",
        effectiveAt: scheduled.effectiveAt.toISOString(),
        hostedInvoiceUrl: null,
      },
    };
  },
);

const confirmUsagePackUpgrade$ = command(async function confirmUsagePackUpgrade(
  { set },
  args: {
    readonly change: UsagePackAllocationChangeRow;
    readonly subscription: StripeSubscription;
    readonly paymentMethod: BillingPurchasePaymentMethod | undefined;
  },
  signal: AbortSignal,
): Promise<UsagePackChangeConfirmResult> {
  const db = set(writeDb$);

  const { change, subscription, paymentMethod } = args;
  if (
    !change.sourceStripePriceId ||
    !change.targetStripePriceId ||
    change.targetUsagePackUsd === null
  ) {
    throw new Error("Usage pack upgrade has no target package");
  }
  if (subscription.pending_update) {
    throw new Error("Stripe subscription already has a pending update");
  }
  if (change.prorationTimestamp === null) {
    throw new Error("Usage pack upgrade has no proration timestamp");
  }
  const items = changeUpdateItems(
    subscription,
    change.sourceStripePriceId,
    change.targetStripePriceId,
  );
  const stripe = getStripeClient();
  if (paymentMethod) {
    await setStripeSubscriptionPaymentMethod(
      stripe,
      subscription.id,
      paymentMethod,
      signal,
    );
  }
  const updatedSubscription = await stripe.subscriptions.update(
    subscription.id,
    {
      items,
      payment_behavior: "pending_if_incomplete",
      proration_behavior: "always_invoice",
      proration_date: change.prorationTimestamp,
      expand: ["latest_invoice.payment_intent"],
    },
    { idempotencyKey: `usage-pack-change:${change.id}:apply` },
  );
  signal.throwIfAborted();
  const invoice = latestInvoice(updatedSubscription);
  if (!invoice) {
    throw new Error("Stripe did not create a usage pack change invoice");
  }
  const payment = await completeBillingOperationInvoice(
    stripe,
    invoice,
    `usage-pack-allocation:${change.id}`,
    signal,
  );
  const pendingExpiry = pendingUpdateExpiry(updatedSubscription);
  const pending = payment.status === "pending_payment";
  const updatedAt = nowDate();
  await db
    .update(usagePackAllocationChanges)
    .set({
      status: pending ? "pending_payment" : "applying",
      stripeInvoiceId: invoice.id,
      stripePendingUpdateExpiresAt: pendingExpiry,
      effectiveAt:
        change.effectiveAt ?? new Date(change.prorationTimestamp * 1000),
      updatedAt,
    })
    .where(
      and(
        eq(usagePackAllocationChanges.id, change.id),
        eq(usagePackAllocationChanges.status, "applying"),
      ),
    );
  signal.throwIfAborted();

  if (!pending) {
    await set(
      reconcileUsagePackAllocationChangeSubscription$,
      updatedSubscription,
    );
    signal.throwIfAborted();
    if (invoice.status === "paid") {
      await set(
        handleUsagePackAllocationChangeInvoicePaid$,
        invoice as UsagePackChangeInvoiceInput,
      );
      signal.throwIfAborted();
    }
  }
  return await set(finishUsagePackUpgradeConfirmation$, {
    change,
    prorationTimestamp: change.prorationTimestamp,
    pending,
    payment,
  });
});

const resumeUsagePackChangeConfirmation$ = command(
  async function resumeUsagePackChangeConfirmation(
    { set },
    change: UsagePackAllocationChangeRow,
    subscription: StripeSubscription,
    signal: AbortSignal,
  ): Promise<UsagePackChangeConfirmResult | null> {
    await set(reconcileUsagePackAllocationChangeSubscription$, subscription);
    signal.throwIfAborted();
    const prepared = await set(
      prepareUsagePackResumeAtCheckpoint$,
      change,
      subscription,
      signal,
    );
    if (prepared.kind === "terminal") {
      return prepared.result;
    }
    if (prepared.kind === "invoice") {
      if (!prepared.invoice) {
        return prepared.stored;
      }
      await set(handleUsagePackAllocationChangeInvoicePaid$, prepared.invoice);
      signal.throwIfAborted();
    }
    return await set(readStoredUsagePackConfirmation$, change.id);
  },
);

export const confirmUsagePackAllocationChange$ = command(
  async function confirmUsagePackAllocationChange(
    { set },
    args: {
      readonly orgId: string;
      readonly changeId: string;
      readonly paymentMethod?: BillingPurchasePaymentMethod;
      readonly prepared: PreparedUsagePackChangeConfirmation;
    },
    signal: AbortSignal,
  ): Promise<UsagePackChangeConfirmResult> {
    const prepared = args.prepared;
    if (prepared.status === "existing") {
      return { status: "confirmed", response: prepared.response };
    }
    if (prepared.status !== "ready" && prepared.status !== "resuming") {
      return prepared;
    }
    const change = prepared.change;
    const { context, subscription } = await set(
      prepareUsagePackConfirmationContext$,
      change,
    );
    signal.throwIfAborted();
    const resumed = await set(
      resumeUsagePackChangeConfirmation$,
      change,
      subscription,
      signal,
    );
    if (resumed) {
      return resumed;
    }
    validateCurrentStripeProjection(context, subscription);
    if (
      change.kind === "downgrade" &&
      (context.subscription.cancelAtPeriodEnd ||
        usagePackSubscriptionWillEnd(subscription))
    ) {
      return await set(finishEndingUsagePackChange$, change.id);
    }
    if (change.kind === "downgrade") {
      return await set(
        confirmUsagePackDowngrade$,
        context,
        change,
        subscription,
        signal,
      );
    }
    if (change.kind !== "upgrade") {
      throw new Error("Usage pack removal cannot be confirmed manually");
    }
    return await set(
      confirmUsagePackUpgrade$,
      {
        change,
        subscription,
        paymentMethod: args.paymentMethod,
      },
      signal,
    );
  },
);

/** One unsignalled observation phase; its caller owns the existing checkpoint. */
const loadUsagePackChangeContextForPhase$ = command(
  async (
    { get },
    usagePackSubscriptionId: string,
  ): Promise<UsagePackChangeContext | null> => {
    const db = get(db$);
    const allocationColumns = getTableColumns(usagePackAllocations);
    const changeColumns = getTableColumns(usagePackAllocationChanges);
    const allocationSchema = contextProjectionSchema(allocationColumns);
    const changeSchema = contextProjectionSchema(changeColumns);
    const allocations = db
      .select({
        payload: contextJsonProjection(allocationColumns)
          .mapWith(zodDriverValueDecoder(allocationSchema))
          .as("payload"),
      })
      .from(usagePackAllocations)
      .where(
        eq(
          usagePackAllocations.usagePackSubscriptionId,
          usagePackSubscriptionId,
        ),
      );
    const changes = db
      .select({
        payload: contextJsonProjection(changeColumns)
          .mapWith(zodDriverValueDecoder(changeSchema))
          .as("payload"),
      })
      .from(usagePackAllocationChanges)
      .where(
        and(
          eq(
            usagePackAllocationChanges.usagePackSubscriptionId,
            usagePackSubscriptionId,
          ),
          inArray(usagePackAllocationChanges.status, [...OPEN_CHANGE_STATUSES]),
        ),
      );
    const [context] = await db
      .select({
        subscription: usagePackSubscriptions,
        allocations: contextJsonRows(allocations).mapWith(
          zodDriverValueDecoder(allocationSchema.array()),
        ),
        changes: contextJsonRows(changes).mapWith(
          zodDriverValueDecoder(changeSchema.array()),
        ),
      })
      .from(usagePackSubscriptions)
      .where(eq(usagePackSubscriptions.id, usagePackSubscriptionId))
      .limit(1);
    return context ?? null;
  },
);

/** Existence diagnosis and provider retrieval precede the original single check. */
const prepareUsagePackConfirmationContext$ = command(
  async (
    { set },
    change: UsagePackAllocationChangeRow,
  ): Promise<{
    readonly context: UsagePackChangeContext;
    readonly subscription: StripeSubscription;
  }> => {
    const context = await set(
      loadUsagePackChangeContextForPhase$,
      change.usagePackSubscriptionId,
    );
    if (!context || !context.subscription.stripeSubscriptionId) {
      throw new Error(
        "Usage pack subscription disappeared during confirmation",
      );
    }
    const subscription = await getStripeClient().subscriptions.retrieve(
      context.subscription.stripeSubscriptionId,
    );
    return { context, subscription };
  },
);

/** The complete terminal status/response phase intentionally has no Abort check. */
const finishUsagePackUpgradeConfirmation$ = command(
  async (
    { get },
    args: {
      readonly change: UsagePackAllocationChangeRow;
      readonly prorationTimestamp: number;
      readonly pending: boolean;
      readonly payment: Awaited<
        ReturnType<typeof completeBillingOperationInvoice>
      >;
    },
  ): Promise<UsagePackChangeConfirmResult> => {
    const db = get(db$);
    const [finalChange] = await db
      .select({ status: usagePackAllocationChanges.status })
      .from(usagePackAllocationChanges)
      .where(eq(usagePackAllocationChanges.id, args.change.id))
      .limit(1);
    const completed = finalChange?.status === "completed";
    return {
      status: "confirmed",
      response: {
        status: completed
          ? "completed"
          : args.pending
            ? "pending_payment"
            : "processing",
        effectiveAt:
          args.change.effectiveAt?.toISOString() ??
          new Date(args.prorationTimestamp * 1000).toISOString(),
        hostedInvoiceUrl:
          args.payment.status === "pending_payment"
            ? args.payment.hostedInvoiceUrl
            : null,
      },
    };
  },
);

const readStoredUsagePackConfirmation$ = command(
  async (
    { get },
    changeId: string,
  ): Promise<UsagePackChangeConfirmResult | null> => {
    const db = get(db$);
    const [change] = await db
      .select()
      .from(usagePackAllocationChanges)
      .where(eq(usagePackAllocationChanges.id, changeId))
      .limit(1);
    if (!change) {
      return { status: "not_found" };
    }
    if (change.status === "failed") {
      return { status: "conflict" };
    }
    const response = existingConfirmationResponse(change);
    return response ? { status: "confirmed", response } : null;
  },
);

type UsagePackResumePreparation =
  | {
      readonly kind: "terminal";
      readonly result: UsagePackChangeConfirmResult | null;
    }
  | {
      readonly kind: "invoice";
      readonly stored: UsagePackChangeConfirmResult;
      readonly invoice: UsagePackChangeInvoiceInput | null;
    }
  | { readonly kind: "pending" };

/** Each nonterminal result ends at an original, conditional cancellation point. */
const prepareUsagePackResume$ = command(
  async (
    { set },
    change: UsagePackAllocationChangeRow,
    subscription: StripeSubscription,
  ): Promise<UsagePackResumePreparation> => {
    const stored = await set(readStoredUsagePackConfirmation$, change.id);
    if (stored) {
      if (
        stored.status === "confirmed" &&
        stored.response.status === "processing" &&
        change.kind === "upgrade"
      ) {
        const invoice = await paidUpgradeInvoiceForSubscription(subscription);
        return { kind: "invoice", stored, invoice };
      }
      return { kind: "terminal", result: stored };
    }
    if (change.kind !== "upgrade" || !subscription.pending_update) {
      return { kind: "terminal", result: null };
    }
    const updatedAt = nowDate();
    const db = set(writeDb$);
    await db
      .update(usagePackAllocationChanges)
      .set({
        status: "pending_payment",
        stripeInvoiceId: stripeObjectId(subscription.latest_invoice),
        stripePendingUpdateExpiresAt: pendingUpdateExpiry(subscription),
        effectiveAt:
          change.effectiveAt ??
          (change.prorationTimestamp === null
            ? null
            : new Date(change.prorationTimestamp * 1000)),
        updatedAt,
      })
      .where(
        and(
          eq(usagePackAllocationChanges.id, change.id),
          eq(usagePackAllocationChanges.status, "applying"),
        ),
      );
    return { kind: "pending" };
  },
);

type UsagePackCandidateDeferredPreparation =
  | { readonly kind: "missing" }
  | { readonly kind: "unchanged"; readonly context: UsagePackChangeContext }
  | {
      readonly kind: "cancellation";
      readonly context: UsagePackChangeContext;
      readonly cancellation: EmptyUsagePackCancellation;
    }
  | {
      readonly kind: "schedule";
      readonly context: UsagePackChangeContext;
      readonly change: UsagePackAllocationChangeRow;
      readonly period: UsagePackPeriod;
      readonly targetQuantities: ReadonlyMap<string, number>;
      readonly existingScheduleId: string | null;
      readonly createdSchedule: StripeSubscriptionSchedule | null;
    };

/** Read, diagnose, and finish the first provider phase before its existing check. */
const prepareCandidateDeferredSchedule$ = command(
  async (
    { set },
    usagePackSubscriptionId: string,
    subscription: StripeSubscription,
  ): Promise<UsagePackCandidateDeferredPreparation> => {
    const context = await set(
      loadUsagePackChangeContextForPhase$,
      usagePackSubscriptionId,
    );
    if (!context) {
      return { kind: "missing" };
    }
    const change = context.changes.find((candidate) => {
      return (
        candidate.subscriptionChangeId === null &&
        candidate.status === "applying" &&
        candidate.kind !== "upgrade"
      );
    });
    if (!change) {
      return { kind: "unchanged", context };
    }
    validateCurrentStripeProjection(context, subscription);
    // This is the original applyDeferred preparation, including both calculations.
    const remainingQuantities = projectedPackageQuantities(context, change);
    if (remainingQuantities.size === 0) {
      if (change.kind !== "removal") {
        throw new Error("A usage pack downgrade must retain a package");
      }
      return {
        kind: "cancellation",
        context,
        cancellation: {
          orgId: context.subscription.orgId,
          usagePackSubscriptionId: context.subscription.id,
          allocationChangeId: change.id,
        },
      };
    }
    const period = usagePackItemPeriod(subscription);
    const targetQuantities = projectedPackageQuantities(context, change);
    if (targetQuantities.size === 0) {
      throw new Error(
        "A usage pack subscription cannot be scheduled without a package",
      );
    }
    const existingScheduleId = subscriptionScheduleId(subscription);
    const createdSchedule = existingScheduleId
      ? null
      : await getStripeClient().subscriptionSchedules.create(
          { from_subscription: subscription.id },
          { idempotencyKey: `usage-pack-change:${change.id}:schedule-create` },
        );
    return {
      kind: "schedule",
      context,
      change,
      period,
      targetQuantities,
      existingScheduleId,
      createdSchedule,
    };
  },
);

const finishCandidateDeferredSchedule$ = command(
  async (
    { set },
    prepared: Extract<
      UsagePackCandidateDeferredPreparation,
      { kind: "schedule" }
    >,
    subscription: StripeSubscription,
    signal: AbortSignal,
  ): Promise<void> => {
    const scheduleId =
      prepared.existingScheduleId ?? prepared.createdSchedule?.id;
    if (!scheduleId) {
      throw new Error("Stripe did not return a subscription schedule ID");
    }
    const stripe = getStripeClient();
    const schedule =
      prepared.createdSchedule ??
      (await stripe.subscriptionSchedules.retrieve(scheduleId));
    signal.throwIfAborted();
    await stripe.subscriptionSchedules.update(
      scheduleId,
      {
        end_behavior: "release",
        proration_behavior: "none",
        phases: projectedUsagePackSchedulePhases(subscription, schedule, {
          currentQuantities: packageQuantitiesForSubscription(subscription),
          renewalQuantities: prepared.targetQuantities,
        }),
      },
      {
        idempotencyKey: `usage-pack-change:${prepared.change.id}:schedule-update`,
      },
    );
    signal.throwIfAborted();
    const updatedAt = nowDate();
    const db = set(writeDb$);
    await db
      .update(usagePackAllocationChanges)
      .set({
        status: "scheduled",
        stripeScheduleId: scheduleId,
        effectiveAt: new Date(prepared.period.end * 1000),
        updatedAt,
      })
      .where(
        and(
          eq(usagePackAllocationChanges.id, prepared.change.id),
          eq(usagePackAllocationChanges.status, "applying"),
        ),
      );
    signal.throwIfAborted();
  },
);

/** A failed ending-plan change plus its response is one terminal phase. */
const finishEndingUsagePackChange$ = command(
  async ({ set }, changeId: string): Promise<UsagePackChangeConfirmResult> => {
    const failedAt = nowDate();
    const db = set(writeDb$);
    await db
      .update(usagePackAllocationChanges)
      .set({
        status: "failed",
        failureReason: "subscription_ending_conflict",
        completedAt: failedAt,
        updatedAt: failedAt,
      })
      .where(
        and(
          eq(usagePackAllocationChanges.id, changeId),
          eq(usagePackAllocationChanges.status, "applying"),
        ),
      );
    return { status: "plan_ending" };
  },
);

/** A terminal stored answer has no later cancellation observation to reproduce. */
const prepareUsagePackResumeAtCheckpoint$ = command(
  async (
    { set },
    change: UsagePackAllocationChangeRow,
    subscription: StripeSubscription,
    signal: AbortSignal,
  ): Promise<UsagePackResumePreparation> => {
    const prepared = await set(prepareUsagePackResume$, change, subscription);
    if (signal.aborted) {
      if (prepared.kind !== "terminal") {
        signal.throwIfAborted();
      }
    }
    return prepared;
  },
);

/** Only a prepared schedule has reached scheduleUsagePackAllocationChange's first check. */
const prepareCandidateDeferredAtCheckpoint$ = command(
  async (
    { set },
    usagePackSubscriptionId: string,
    subscription: StripeSubscription,
    signal: AbortSignal,
  ): Promise<UsagePackCandidateDeferredPreparation> => {
    const prepared = await set(
      prepareCandidateDeferredSchedule$,
      usagePackSubscriptionId,
      subscription,
    );
    if (signal.aborted) {
      if (prepared.kind === "schedule") {
        signal.throwIfAborted();
      }
    }
    return prepared;
  },
);

const boundUsagePackSubscriptionIdOwned$ = command(
  async function boundUsagePackSubscriptionIdOwned(
    { get },
    stripeSubscriptionId: string | null,
  ): Promise<string | null> {
    const db = get(db$);

    if (!stripeSubscriptionId) {
      return null;
    }
    const [subscription] = await db
      .select({ id: usagePackSubscriptions.id })
      .from(usagePackSubscriptions)
      .where(
        and(
          eq(usagePackSubscriptions.stripeSubscriptionId, stripeSubscriptionId),
          notInArray(usagePackSubscriptions.subscriptionStatus, [
            ...TERMINAL_SUBSCRIPTION_STATUSES,
          ]),
        ),
      )
      .limit(1);
    return subscription?.id ?? null;
  },
);

const activeMetadataUsagePackSubscriptionIdOwned$ = command(
  async function activeMetadataUsagePackSubscriptionIdOwned(
    { get },
    metadataId: string | null,
  ): Promise<string | null> {
    const db = get(db$);

    if (!metadataId) {
      return null;
    }
    const [subscription] = await db
      .select({ id: usagePackSubscriptions.id })
      .from(usagePackSubscriptions)
      .where(
        and(
          eq(usagePackSubscriptions.id, metadataId),
          notInArray(usagePackSubscriptions.subscriptionStatus, [
            ...TERMINAL_SUBSCRIPTION_STATUSES,
          ]),
        ),
      )
      .limit(1);
    return subscription?.id ?? null;
  },
);

const invoiceUsagePackSubscriptionIdOwned$ = command(
  async function invoiceUsagePackSubscriptionIdOwned(
    { set },
    invoice: UsagePackChangeInvoiceInput,
  ): Promise<string | null> {
    const boundId = await set(
      boundUsagePackSubscriptionIdOwned$,
      invoiceSubscriptionId(invoice),
    );
    if (boundId) {
      return boundId;
    }
    const ids = new Set(
      [
        usagePackSubscriptionIdFromMetadata(invoice.metadata),
        usagePackSubscriptionIdFromMetadata(
          invoice.parent?.subscription_details?.metadata,
        ),
      ].filter((id): id is string => {
        return id !== null;
      }),
    );
    if (ids.size > 1) {
      throw new Error("Stripe usage pack invoice metadata has conflicting IDs");
    }
    return await set(
      activeMetadataUsagePackSubscriptionIdOwned$,
      ids.values().next().value ?? null,
    );
  },
);

export const usagePackInvoiceFulfillmentExistsOwned$ = command(
  async function usagePackInvoiceFulfillmentExistsOwned(
    { get },
    invoiceId: string,
    usagePackSubscriptionId: string,
  ): Promise<boolean> {
    const db = get(db$);

    const [existing] = await db
      .select({
        usagePackSubscriptionId:
          usagePackInvoiceFulfillments.usagePackSubscriptionId,
      })
      .from(usagePackInvoiceFulfillments)
      .where(eq(usagePackInvoiceFulfillments.stripeInvoiceId, invoiceId))
      .limit(1);
    return existingInvoiceFulfillmentMatches(
      existing,
      invoiceId,
      usagePackSubscriptionId,
    );
  },
);

/** Reconciliation and its ordinary count publication finish before the old checkpoint. */
const reconcileCandidateUsagePackSubscription$ = command(
  async ({ set }, subscription: StripeSubscription) => {
    const result = await set(
      reconcileUsagePackAllocationChangeSubscription$,
      subscription,
    );
    return {
      reconciled: result.reconciled,
      orgIds: result.orgId ? [result.orgId] : [],
    };
  },
);
/** Invoice handling, refreshed context, expiry and final result are one original uninterruptible phase. */
const finishCandidateUsagePackInvoice$ = command(
  async (
    { set },
    args: {
      readonly usagePackSubscriptionId: string;
      readonly subscription: StripeSubscription;
      readonly at: Date;
      readonly invoice: UsagePackChangeInvoiceInput | null;
      readonly reconciled: number;
      readonly orgIds: readonly string[];
      readonly emptyCancellations: readonly EmptyUsagePackCancellation[];
    },
  ) => {
    let reconciled = args.reconciled;
    const orgIds = new Set(args.orgIds);
    if (args.invoice) {
      const outcome = await set(
        handleUsagePackAllocationChangeInvoicePaid$,
        args.invoice,
      );
      reconciled += outcome.handled ? 1 : 0;
      if (outcome.orgId) {
        orgIds.add(outcome.orgId);
      }
    }
    const afterInvoice = await set(
      loadUsagePackChangeContextForPhase$,
      args.usagePackSubscriptionId,
    );
    if (afterInvoice) {
      reconciled += await set(
        failExpiredUsagePackUpgrade$,
        afterInvoice,
        args.subscription,
        args.at,
      );
    }
    return {
      reconciled,
      orgIds: [...orgIds],
      emptyCancellations: args.emptyCancellations,
    };
  },
);
/** The organization diagnosis and conditional provider release share the original no-check interval. */
const releaseUnusedMemberRemovalSchedule$ = command(
  async (
    { get },
    args: { readonly orgId: string; readonly scheduleId: string },
  ): Promise<boolean> => {
    const db = get(db$);
    const [org] = await db
      .select({
        pendingSubscriptionScheduleId:
          orgMetadata.pendingSubscriptionScheduleId,
      })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, args.orgId))
      .limit(1);
    if (!org) {
      throw new Error("Usage pack subscription lost its organization");
    }
    if (org.pendingSubscriptionScheduleId === args.scheduleId) {
      return false;
    }
    await getStripeClient().subscriptionSchedules.release(args.scheduleId);
    return true;
  },
);

const loadUpgradeInvoiceObservation$ = command(
  async ({ get }, changeId: string, sourceAllocationId: string) => {
    const db = get(db$);
    const [reconciledChanges, sourceAllocations] = await Promise.all([
      db
        .select()
        .from(usagePackAllocationChanges)
        .where(eq(usagePackAllocationChanges.id, changeId))
        .limit(1),
      db
        .select()
        .from(usagePackAllocations)
        .where(eq(usagePackAllocations.id, sourceAllocationId))
        .limit(1),
    ]);
    const reconciledChange = reconciledChanges[0];
    const sourceAllocation = sourceAllocations[0];
    if (!reconciledChange || !sourceAllocation) {
      throw new Error(`Usage pack change ${changeId} disappeared`);
    }
    return { reconciledChange, sourceAllocation };
  },
);

function reflectedUsagePackChangeIds(
  changes: readonly UsagePackAllocationChangeRow[],
) {
  return JSON.stringify(
    changes.map((change) => {
      return change.id;
    }),
  );
}

/** Read observations are not payment arbitration; the final existing CAS is. */
function reflectedUsagePackChanges(
  context: UsagePackChangeContext,
  expected: readonly UsagePackAllocationChangeRow[],
  current: readonly UsagePackAllocationChangeRow[],
): readonly UsagePackAllocationChangeRow[] | null {
  const byId = new Map(
    current.map((change) => {
      return [change.id, change];
    }),
  );
  const seen = new Set<string>();
  const prepared: UsagePackAllocationChangeRow[] = [];
  const identity = [
    "orgId",
    "usagePackSubscriptionId",
    "kind",
    "subscriptionChangeId",
    "userId",
    "sourceAllocationId",
    "replacementAllocationId",
    "sourceStripePriceId",
    "targetStripePriceId",
    "sourceUsagePackUsd",
    "targetUsagePackUsd",
  ] as const;
  for (const original of expected) {
    if (seen.has(original.id)) {
      continue;
    }
    seen.add(original.id);
    const change = byId.get(original.id);
    if (
      !change ||
      change.status === "applied" ||
      change.status === "completed"
    ) {
      continue;
    }
    if (
      change.status !== original.status ||
      change.replacementAllocationId ||
      identity.some((field) => {
        return change[field] !== original[field];
      })
    ) {
      return null;
    }
    requireReflectedChangeOwner(context, change);
    // The old schedule retirement would invalidate this row's final status CAS.
    if (
      change.kind === "upgrade" &&
      change.status === "scheduled" &&
      change.subscriptionChangeId &&
      change.stripeScheduleId
    ) {
      return null;
    }
    prepared.push(change);
  }
  return prepared;
}

/** Actual immutable intent fields, one bound JSON value for the complete batch. */
function reflectedUsagePackChangeInput(
  changes: readonly UsagePackAllocationChangeRow[],
) {
  const rows = changes.map((change) => {
    if (
      change.kind !== "addition" &&
      (!change.sourceAllocationId || !change.sourceStripePriceId)
    ) {
      throw new Error(`Usage pack change ${change.id} has no source`);
    }
    if (
      change.kind !== "removal" &&
      (change.targetUsagePackUsd === null || !change.targetStripePriceId)
    ) {
      throw new Error(`Usage pack change ${change.id} has no target`);
    }
    return {
      id: change.id,
      org_id: change.orgId,
      usage_pack_subscription_id: change.usagePackSubscriptionId,
      user_id: change.userId,
      kind: change.kind,
      status: change.status,
      subscription_change_id: change.subscriptionChangeId,
      source_allocation_id: change.sourceAllocationId,
      replacement_allocation_id: change.replacementAllocationId,
      source_stripe_price_id: change.sourceStripePriceId,
      target_stripe_price_id: change.targetStripePriceId,
      source_usage_pack_usd: change.sourceUsagePackUsd,
      target_usage_pack_usd:
        change.targetUsagePackUsd === null
          ? null
          : usagePackUsd(change.targetUsagePackUsd),
      effective_at: change.effectiveAt?.toISOString() ?? null,
      stripe_schedule_id: change.stripeScheduleId,
    };
  });
  return new QueryBuilder().$with("reflected_change_input", {
    ...canceledUsagePackInputColumns,
    stripeScheduleId: usagePackAllocationChanges.stripeScheduleId,
  }).as(sql`
    SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS captured(
      id uuid, org_id text, usage_pack_subscription_id uuid, user_id text,
      kind text, status text, subscription_change_id uuid, source_allocation_id uuid,
      replacement_allocation_id uuid, source_stripe_price_id text,
      target_stripe_price_id text, source_usage_pack_usd integer,
      target_usage_pack_usd integer, effective_at timestamp, stripe_schedule_id text
    )
  `);
}

type ReflectedUsagePackInput = ReturnType<typeof reflectedUsagePackChangeInput>;

function reflectedSourceCondition(input: ReflectedUsagePackInput) {
  return and(
    eq(usagePackAllocations.id, input.sourceAllocationId),
    eq(usagePackAllocations.orgId, input.orgId),
    eq(
      usagePackAllocations.usagePackSubscriptionId,
      input.usagePackSubscriptionId,
    ),
    eq(usagePackAllocations.status, "active"),
    eq(usagePackAllocations.userId, input.userId),
    eq(usagePackAllocations.stripePriceId, input.sourceStripePriceId),
  );
}

function reflectedReplacementValues(
  context: UsagePackChangeContext,
  input: ReflectedUsagePackInput,
  period: UsagePackPeriod,
  updatedAt: Date,
) {
  return {
    id: sql`${usagePackAllocations.id.default}`
      .mapWith(usagePackAllocations.id)
      .as("id"),
    usagePackSubscriptionId: sql`${context.subscription.id}`
      .mapWith(usagePackAllocations.usagePackSubscriptionId)
      .as("usage_pack_subscription_id"),
    orgId: sql`${context.subscription.orgId}`
      .mapWith(usagePackAllocations.orgId)
      .as("org_id"),
    userId: input.userId,
    invitationId: sql`NULL`
      .mapWith(usagePackAllocations.invitationId)
      .as("invitation_id"),
    usagePackUsd: sql`${input.targetUsagePackUsd}`
      .mapWith(usagePackAllocations.usagePackUsd)
      .as("usage_pack_usd"),
    stripePriceId: sql`${input.targetStripePriceId}`
      .mapWith(usagePackAllocations.stripePriceId)
      .as("stripe_price_id"),
    status: sql`'active'`.mapWith(usagePackAllocations.status).as("status"),
    currentPeriodStart:
      sql`${sql.param(new Date(period.start * 1000), usagePackAllocations.currentPeriodStart)}`
        .mapWith(usagePackAllocations.currentPeriodStart)
        .as("current_period_start"),
    currentPeriodEnd:
      sql`${sql.param(new Date(period.end * 1000), usagePackAllocations.currentPeriodEnd)}`
        .mapWith(usagePackAllocations.currentPeriodEnd)
        .as("current_period_end"),
    createdAt: sql`${sql.param(updatedAt, usagePackAllocations.createdAt)}`
      .mapWith(usagePackAllocations.createdAt)
      .as("created_at"),
    updatedAt: sql`${sql.param(updatedAt, usagePackAllocations.updatedAt)}`
      .mapWith(usagePackAllocations.updatedAt)
      .as("updated_at"),
  };
}

function reflectedSupersededScheduleCondition(input: ReflectedUsagePackInput) {
  return and(
    eq(input.kind, "upgrade"),
    isNotNull(input.subscriptionChangeId),
    isNotNull(input.stripeScheduleId),
    eq(usagePackAllocationChanges.orgId, input.orgId),
    eq(usagePackAllocationChanges.userId, input.userId),
    eq(usagePackAllocationChanges.status, "scheduled"),
    eq(usagePackAllocationChanges.stripeScheduleId, input.stripeScheduleId),
  );
}

function reflectedPublicationValues(
  input: ReflectedUsagePackInput,
  replacementId: SQL,
  period: UsagePackPeriod,
  updatedAt: Date,
): PgUpdateSetSource<typeof usagePackAllocationChanges> {
  const deferred = sql`${inArray(input.kind, ["downgrade", "removal"])}`;
  return {
    replacementAllocationId: sql`CASE WHEN ${eq(input.kind, "removal")} THEN NULL ELSE ${replacementId} END`,
    status: sql`CASE WHEN ${deferred} THEN 'completed' ELSE 'applied' END`,
    completedAt: sql`CASE WHEN ${deferred} THEN ${sql.param(updatedAt, usagePackAllocationChanges.completedAt)}::timestamp ELSE NULL END`,
    effectiveAt: sql`COALESCE(${input.effectiveAt}, CASE WHEN ${deferred} THEN ${sql.param(new Date(period.start * 1000), usagePackAllocationChanges.effectiveAt)}::timestamp ELSE ${sql.param(updatedAt, usagePackAllocationChanges.effectiveAt)}::timestamp END)`,
    updatedAt,
  };
}

function reflectedPublicationCondition(input: ReflectedUsagePackInput) {
  return and(
    eq(usagePackAllocationChanges.id, input.id),
    eq(usagePackAllocationChanges.status, input.status),
    eq(usagePackAllocationChanges.orgId, input.orgId),
    eq(
      usagePackAllocationChanges.usagePackSubscriptionId,
      input.usagePackSubscriptionId,
    ),
    eq(usagePackAllocationChanges.kind, input.kind),
    sql`${usagePackAllocationChanges.subscriptionChangeId} IS NOT DISTINCT FROM ${input.subscriptionChangeId}`,
    sql`${usagePackAllocationChanges.userId} IS NOT DISTINCT FROM ${input.userId}`,
    sql`${usagePackAllocationChanges.sourceAllocationId} IS NOT DISTINCT FROM ${input.sourceAllocationId}`,
    sql`${usagePackAllocationChanges.replacementAllocationId} IS NOT DISTINCT FROM ${input.replacementAllocationId}`,
    sql`${usagePackAllocationChanges.sourceStripePriceId} IS NOT DISTINCT FROM ${input.sourceStripePriceId}`,
    sql`${usagePackAllocationChanges.targetStripePriceId} IS NOT DISTINCT FROM ${input.targetStripePriceId}`,
    sql`${usagePackAllocationChanges.sourceUsagePackUsd} IS NOT DISTINCT FROM ${input.sourceUsagePackUsd}`,
    sql`${usagePackAllocationChanges.targetUsagePackUsd} IS NOT DISTINCT FROM ${input.targetUsagePackUsd}`,
  );
}

function requireReflectedChangeOwner(
  context: UsagePackChangeContext,
  change: UsagePackAllocationChangeRow,
) {
  if (
    change.orgId !== context.subscription.orgId ||
    change.usagePackSubscriptionId !== context.subscription.id
  ) {
    throw new Error(
      "Reflected usage pack change belongs to another billing owner",
    );
  }
}
