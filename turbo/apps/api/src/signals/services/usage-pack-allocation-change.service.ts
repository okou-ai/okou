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
import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import {
  usagePackAllocationChanges,
  usagePackAllocations,
  usagePackInvoiceFulfillments,
  usagePackSubscriptionChanges,
  usagePackSubscriptionMigrations,
  usagePackSubscriptions,
} from "@okouai/db/schema/usage-pack-subscription";
import {
  and,
  asc,
  desc,
  eq,
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
import { command } from "ccstate";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
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
import { settle } from "../utils";
import { createUsagePackCreditGrant } from "./usage-pack-credit.service";
import { prepareUsagePackMemberCreditRefunds } from "./usage-pack-credit-refund.service";
import { completeBillingOperationInvoice } from "./billing-operation-invoice.service";
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
type WriteTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
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

export async function failScheduledUsagePackAllocationChangesForSchedule(
  db: Pick<Db, "update">,
  args: {
    readonly scheduleId: string;
    readonly completedAt: Date;
    readonly effectiveAfter?: Date;
  },
): Promise<readonly string[]> {
  const rows = await db
    .update(usagePackAllocationChanges)
    .set({
      status: "failed",
      failureReason: "scheduled_change_restored",
      completedAt: args.completedAt,
      updatedAt: args.completedAt,
    })
    .where(
      and(
        eq(usagePackAllocationChanges.status, "scheduled"),
        eq(usagePackAllocationChanges.stripeScheduleId, args.scheduleId),
        ...(args.effectiveAfter
          ? [
              or(
                isNull(usagePackAllocationChanges.effectiveAt),
                gt(usagePackAllocationChanges.effectiveAt, args.effectiveAfter),
              ),
            ]
          : []),
      ),
    )
    .returning({ orgId: usagePackAllocationChanges.orgId });
  return [
    ...new Set(
      rows.map((row) => {
        return row.orgId;
      }),
    ),
  ];
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

async function boundUsagePackSubscriptionId(
  db: Pick<Db, "select">,
  stripeSubscriptionId: string | null,
): Promise<string | null> {
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
}

async function activeMetadataUsagePackSubscriptionId(
  db: Pick<Db, "select">,
  metadataId: string | null,
): Promise<string | null> {
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
}

async function invoiceUsagePackSubscriptionId(
  db: Pick<Db, "select">,
  invoice: UsagePackChangeInvoiceInput,
): Promise<string | null> {
  const boundId = await boundUsagePackSubscriptionId(
    db,
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
  return await activeMetadataUsagePackSubscriptionId(
    db,
    ids.values().next().value ?? null,
  );
}

async function loadUsagePackChangeContextBySubscriptionId(
  db: Pick<Db, "select">,
  usagePackSubscriptionId: string,
): Promise<UsagePackChangeContext | null> {
  const [subscription] = await db
    .select()
    .from(usagePackSubscriptions)
    .where(eq(usagePackSubscriptions.id, usagePackSubscriptionId))
    .limit(1);
  if (!subscription) {
    return null;
  }
  const [allocations, changes] = await Promise.all([
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
          inArray(usagePackAllocationChanges.status, [...OPEN_CHANGE_STATUSES]),
        ),
      ),
  ]);
  return { subscription, allocations, changes };
}

async function loadUsagePackChangeContextForOrg(
  db: Pick<Db, "select">,
  orgId: string,
): Promise<UsagePackChangeContext | null> {
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
  return await loadUsagePackChangeContextBySubscriptionId(db, subscription.id);
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

async function expireStaleUsagePackPreviews(
  tx: WriteTx,
  orgId: string,
  at: Date,
): Promise<void> {
  await tx
    .update(usagePackAllocationChanges)
    .set({
      status: "failed",
      failureReason: "preview_expired",
      completedAt: at,
      updatedAt: at,
    })
    .where(
      and(
        eq(usagePackAllocationChanges.orgId, orgId),
        eq(usagePackAllocationChanges.status, "previewed"),
        lte(usagePackAllocationChanges.previewExpiresAt, at),
      ),
    );
}

export async function getUsagePackManagement(
  db: Pick<Db, "select">,
  orgId: string,
): Promise<UsagePackManagementResponse | null> {
  const context = await loadUsagePackChangeContextForOrg(db, orgId);
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
): typeof usagePackAllocationChanges.$inferInsert {
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
    const [change] = await db.transaction(async (tx) => {
      // A quote is not accepted financial intent. Existing uniqueness handles
      // competing quotes; confirmation revalidates before claiming payment.
      const [root] = await tx
        .select()
        .from(usagePackSubscriptions)
        .where(
          and(
            eq(usagePackSubscriptions.orgId, args.orgId),
            eq(usagePackSubscriptions.id, context.subscription.id),
          ),
        )
        .limit(1);
      if (
        !root ||
        !usagePackPreviewSubscriptionMatches(context.subscription, root)
      ) {
        return [];
      }
      // A Plan preview may have committed while Stripe prepared these prices.
      // This observation rejects an already-visible competing quote; it is not
      // cross-table payment arbitration.
      const [planChange] = await tx
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
      if (planChange) {
        return [];
      }
      await tx
        .update(usagePackAllocationChanges)
        .set({
          status: "failed",
          failureReason: "preview_expired",
          completedAt: preview.createdAt,
          updatedAt: preview.createdAt,
        })
        .where(
          and(
            eq(usagePackAllocationChanges.orgId, args.orgId),
            eq(usagePackAllocationChanges.status, "previewed"),
            lte(usagePackAllocationChanges.previewExpiresAt, preview.createdAt),
          ),
        );
      const [lockedSource] = await tx
        .select()
        .from(usagePackAllocations)
        .where(eq(usagePackAllocations.id, source.id))
        .limit(1);
      signal.throwIfAborted();
      if (
        !lockedSource ||
        lockedSource.status !== "active" ||
        lockedSource.orgId !== args.orgId ||
        lockedSource.userId !== args.userId ||
        lockedSource.usagePackSubscriptionId !== context.subscription.id ||
        lockedSource.usagePackUsd !== source.usagePackUsd ||
        lockedSource.stripePriceId !== source.stripePriceId
      ) {
        return [];
      }
      return await tx
        .insert(usagePackAllocationChanges)
        .values(allocationChangePreviewValues(context, source, args, preview))
        .onConflictDoNothing()
        .returning();
    });
    signal.throwIfAborted();
    return change;
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

function subscriptionPhaseItems(
  subscription: UsagePackChangeSubscriptionInput,
): StripeSchedulePhaseItemParam[] {
  return subscription.items.data.map((item) => {
    return {
      price: item.price.id,
      quantity: item.quantity ?? 1,
    };
  });
}

function subscriptionPhaseDiscounts(
  subscription: UsagePackChangeSubscriptionInput,
): StripeSchedulePhaseDiscountParam[] {
  const discounts = subscription.discounts ?? [];
  return discounts.flatMap((discount) => {
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
    const period = usagePackItemPeriod(subscription);
    const discounts = subscriptionPhaseDiscounts(subscription);
    await stripe.subscriptionSchedules.update(
      scheduleId,
      {
        end_behavior: "release",
        proration_behavior: "none",
        phases: [
          phaseWithDiscounts(
            {
              start_date: period.start,
              end_date: period.end,
              items: projectedScheduleItems(
                subscription,
                args.currentQuantities,
              ),
              proration_behavior: "none",
            },
            discounts,
          ),
          phaseWithDiscounts(
            {
              start_date: period.end,
              duration: subscriptionRecurringDuration(subscription),
              items: projectedScheduleItems(
                subscription,
                args.renewalQuantities,
              ),
              proration_behavior: "none",
            },
            discounts,
          ),
        ],
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
 * The phase covering `at` and the single phase that follows it. A schedule
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
    return phase.start_date <= seconds && seconds < phase.end_date;
  });
  const current = schedule.phases[index];
  if (!current || schedule.phases.length - index > 2) {
    return null;
  }
  return { current, renewal: schedule.phases[index + 1] ?? current };
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
  const discounts = subscriptionPhaseDiscounts(subscription);
  await stripe.subscriptionSchedules.update(
    scheduleId,
    {
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
            duration: subscriptionRecurringDuration(subscription),
            items: projectedScheduleItems(subscription, targetQuantities),
            proration_behavior: "none",
          },
          discounts,
        ),
      ],
    },
    { idempotencyKey: `usage-pack-change:${operationId}:schedule-update` },
  );
  signal?.throwIfAborted();
  return {
    scheduleId,
    effectiveAt: new Date(period.end * 1000),
  };
}

export async function reserveUsagePackMemberRemoval(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
  },
  signal: AbortSignal,
): Promise<string | null> {
  signal.throwIfAborted();
  const at = nowDate();
  const reservationId = await db.transaction(async (tx) => {
    await expireStaleUsagePackPreviews(tx, args.orgId, at);
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
    const context = await loadUsagePackChangeContextForOrg(tx, args.orgId);
    if (!context?.subscription.stripeSubscriptionId) {
      throw new Error(
        "Usage pack subscription is not ready for member removal",
      );
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
      return change.userId === args.userId;
    });
    if (existing?.status === "scheduled" && existing.kind !== "removal") {
      throw new Error(
        `Usage pack change ${existing.id} must finish before member removal`,
      );
    }
    const existingRemoval = existing?.kind === "removal" ? existing : null;
    await invalidateUsagePackChangePreviews(tx, {
      orgId: args.orgId,
      at,
      reason: "member_removal_reserved",
      ...(existingRemoval ? { preservedChangeId: existingRemoval.id } : {}),
    });
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
        .set({
          status: "failed",
          failureReason: "member_removal_reserved",
          completedAt: at,
          updatedAt: at,
        })
        .where(eq(usagePackAllocationChanges.id, existing.id));
    }
    const [reservation] = await tx
      .insert(usagePackAllocationChanges)
      .values({
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
      })
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
}

export async function cancelUsagePackMemberRemovalReservation(
  db: Db,
  reservationId: string | null,
): Promise<void> {
  if (!reservationId) {
    return;
  }
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
}

async function invalidateUsagePackChangePreviews(
  tx: WriteTx,
  args: {
    readonly orgId: string;
    readonly at: Date;
    readonly reason: string;
    readonly preservedChangeId?: string;
  },
): Promise<void> {
  await tx
    .update(usagePackAllocationChanges)
    .set({
      status: "failed",
      failureReason: args.reason,
      completedAt: args.at,
      updatedAt: args.at,
    })
    .where(
      args.preservedChangeId
        ? and(
            eq(usagePackAllocationChanges.orgId, args.orgId),
            eq(usagePackAllocationChanges.status, "previewed"),
            ne(usagePackAllocationChanges.id, args.preservedChangeId),
          )
        : and(
            eq(usagePackAllocationChanges.orgId, args.orgId),
            eq(usagePackAllocationChanges.status, "previewed"),
          ),
    );
}

async function activateExistingUsagePackRemoval(
  tx: WriteTx,
  context: UsagePackChangeContext,
  existing: UsagePackAllocationChangeRow,
  at: Date,
): Promise<{
  readonly context: UsagePackChangeContext;
  readonly change: UsagePackAllocationChangeRow;
}> {
  if (
    existing.status !== "previewed" &&
    existing.status !== "applying" &&
    existing.status !== "scheduled"
  ) {
    throw new Error(`Usage pack removal ${existing.id} has an invalid status`);
  }
  const [activated] =
    existing.status === "applying"
      ? [existing]
      : await tx
          .update(usagePackAllocationChanges)
          .set({ status: "applying", effectiveAt: null, updatedAt: at })
          .where(
            and(
              eq(usagePackAllocationChanges.id, existing.id),
              inArray(usagePackAllocationChanges.status, [
                "previewed",
                "scheduled",
              ]),
            ),
          )
          .returning();
  if (!activated) {
    throw new Error(
      `Usage pack removal ${existing.id} changed while activating`,
    );
  }
  await invalidateUsagePackChangePreviews(tx, {
    orgId: existing.orgId,
    at,
    reason: "member_removed",
  });
  const refreshedContext = await loadUsagePackChangeContextBySubscriptionId(
    tx,
    context.subscription.id,
  );
  if (!refreshedContext) {
    throw new Error("Usage pack subscription disappeared during removal");
  }
  return { context: refreshedContext, change: activated };
}

async function prepareUsagePackMemberRemoval(
  db: Db,
  args: { readonly orgId: string; readonly userId: string },
): Promise<{
  readonly context: UsagePackChangeContext;
  readonly change: UsagePackAllocationChangeRow;
} | null> {
  const at = nowDate();
  return await db.transaction(async (tx) => {
    // Refund amounts come from the member's grant rows that this read keeps
    // stable through zeroing; open changes stay single by active-org index.
    await prepareUsagePackMemberCreditRefunds(tx, args);
    await tx
      .update(usagePackCreditGrants)
      .set({ remainingAmount: 0 })
      .where(
        and(
          eq(usagePackCreditGrants.orgId, args.orgId),
          eq(usagePackCreditGrants.userId, args.userId),
        ),
      );
    const context = await loadUsagePackChangeContextForOrg(tx, args.orgId);
    if (!context) {
      return null;
    }
    const source = activeAllocationForMember(context, args.userId);
    if (!source) {
      return null;
    }
    const existing = context.changes.find((change) => {
      return change.userId === args.userId;
    });
    if (existing?.kind === "removal") {
      return await activateExistingUsagePackRemoval(tx, context, existing, at);
    }
    if (
      existing &&
      existing.status !== "previewed" &&
      existing.status !== "scheduled"
    ) {
      throw new Error(
        `Usage pack allocation for ${args.userId} has a paid change in progress`,
      );
    }
    if (existing) {
      await tx
        .update(usagePackAllocationChanges)
        .set({
          status: "failed",
          failureReason: "member_removed",
          completedAt: at,
          updatedAt: at,
        })
        .where(eq(usagePackAllocationChanges.id, existing.id));
    }
    await invalidateUsagePackChangePreviews(tx, {
      orgId: args.orgId,
      at,
      reason: "member_removed",
    });
    const [change] = await tx
      .insert(usagePackAllocationChanges)
      .values({
        usagePackSubscriptionId: context.subscription.id,
        orgId: args.orgId,
        userId: args.userId,
        sourceAllocationId: source.id,
        kind: "removal",
        status: "applying",
        sourceUsagePackUsd: source.usagePackUsd,
        sourceStripePriceId: source.stripePriceId,
        immediateAmountCents: 0,
        nextRecurringAmountCents: 0,
        createdAt: at,
        updatedAt: at,
      })
      .returning();
    if (!change) {
      throw new Error("Failed to create usage pack member removal");
    }
    const refreshedContext = await loadUsagePackChangeContextBySubscriptionId(
      tx,
      context.subscription.id,
    );
    if (!refreshedContext) {
      throw new Error("Usage pack subscription disappeared during removal");
    }
    return { context: refreshedContext, change };
  });
}

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

async function scheduleDeferredUsagePackChange(
  db: Db,
  context: UsagePackChangeContext,
  change: UsagePackAllocationChangeRow,
  subscription: UsagePackChangeSubscriptionInput,
  signal: AbortSignal | undefined,
): Promise<DeferredUsagePackChangeResult> {
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
}

async function applyImmediateUsagePackMemberRemoval(
  db: Db,
  context: UsagePackChangeContext,
  change: UsagePackAllocationChangeRow,
  subscription: UsagePackChangeSubscriptionInput,
  signal: AbortSignal,
): Promise<void> {
  if (change.kind !== "removal") {
    throw new Error("Only usage pack removals can be applied immediately");
  }
  validateStripeSubscriptionIdentity(context, subscription);
  const currentQuantities = projectedQuantitiesAfterChanges(context, [change]);
  const sourceQuantities = packageQuantitiesForAllocations(context.allocations);
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
    const [org] = await db
      .select({
        pendingSubscriptionScheduleId:
          orgMetadata.pendingSubscriptionScheduleId,
      })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, context.subscription.orgId))
      .limit(1);
    if (!org) {
      throw new Error("Usage pack subscription lost its organization");
    }
    if (org.pendingSubscriptionScheduleId !== scheduleId) {
      await getStripeClient().subscriptionSchedules.release(scheduleId);
      signal.throwIfAborted();
    }
  }
  const period = usagePackItemPeriod(subscription);
  const effectiveTimestamp = Math.min(
    Math.max(Math.floor(nowDate().getTime() / 1000), period.start),
    period.end - 1,
  );
  await commitReflectedUsagePackChanges(db, context, [change], {
    start: effectiveTimestamp,
    end: period.end,
  });
  signal.throwIfAborted();
}

export async function removeUsagePackMemberAllocation(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
  },
  signal: AbortSignal,
): Promise<EmptyUsagePackCancellation | null> {
  const prepared = await prepareUsagePackMemberRemoval(db, args);
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
    const deferred = await scheduleDeferredUsagePackChange(
      db,
      prepared.context,
      prepared.change,
      stripeSubscription,
      signal,
    );
    if ("emptyCancellation" in deferred) {
      return deferred.emptyCancellation;
    }
  } else {
    await applyImmediateUsagePackMemberRemoval(
      db,
      prepared.context,
      prepared.change,
      stripeSubscription,
      signal,
    );
  }
  return null;
}

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

class ReflectedUsagePackSnapshotChanged extends Error {}

async function retireReflectedChangeSource(
  tx: WriteTx,
  change: UsagePackAllocationChangeRow,
  updatedAt: Date,
): Promise<void> {
  if (change.kind === "addition") {
    // The existing live-member unique index arbitrates replacement insertion.
    return;
  }
  if (!change.sourceAllocationId || !change.sourceStripePriceId) {
    throw new Error(`Usage pack change ${change.id} has no source`);
  }
  const [source] = await tx
    .update(usagePackAllocations)
    .set({ status: "inactive", updatedAt })
    .where(
      and(
        eq(usagePackAllocations.id, change.sourceAllocationId),
        eq(usagePackAllocations.orgId, change.orgId),
        eq(
          usagePackAllocations.usagePackSubscriptionId,
          change.usagePackSubscriptionId,
        ),
        eq(usagePackAllocations.status, "active"),
        eq(usagePackAllocations.userId, change.userId),
        eq(usagePackAllocations.stripePriceId, change.sourceStripePriceId),
      ),
    )
    .returning({ id: usagePackAllocations.id });
  if (!source) {
    throw new ReflectedUsagePackSnapshotChanged();
  }
}

async function createReflectedChangeReplacement(
  tx: WriteTx,
  context: UsagePackChangeContext,
  change: UsagePackAllocationChangeRow,
  period: UsagePackPeriod,
  updatedAt: Date,
): Promise<string | null> {
  if (change.kind === "removal") {
    return null;
  }
  if (change.targetUsagePackUsd === null || !change.targetStripePriceId) {
    throw new Error(`Usage pack change ${change.id} has no target`);
  }
  const [replacement] = await tx
    .insert(usagePackAllocations)
    .values({
      usagePackSubscriptionId: context.subscription.id,
      orgId: context.subscription.orgId,
      userId: change.userId,
      usagePackUsd: usagePackUsd(change.targetUsagePackUsd),
      stripePriceId: change.targetStripePriceId,
      status: "active",
      currentPeriodStart: new Date(period.start * 1000),
      currentPeriodEnd: new Date(period.end * 1000),
      createdAt: updatedAt,
      updatedAt,
    })
    .onConflictDoNothing({
      target: [usagePackAllocations.orgId, usagePackAllocations.userId],
      where: sql`${usagePackAllocations.userId} IS NOT NULL AND ${usagePackAllocations.status} <> 'inactive'`,
    })
    .returning({ id: usagePackAllocations.id });
  if (!replacement) {
    // Roll back source retirement too; never adopt another operation's row.
    throw new ReflectedUsagePackSnapshotChanged();
  }
  return replacement.id;
}

async function commitReflectedUsagePackChanges(
  db: Db,
  context: UsagePackChangeContext,
  changes: readonly UsagePackAllocationChangeRow[],
  period: UsagePackPeriod,
): Promise<number> {
  if (changes.length === 0) {
    return 0;
  }
  const result = await settle(
    db.transaction(async (tx) => {
      let applied = 0;
      const updatedAt = nowDate();
      for (const expectedChange of changes) {
        const [change] = await tx
          .select()
          .from(usagePackAllocationChanges)
          .where(eq(usagePackAllocationChanges.id, expectedChange.id))
          .limit(1);
        if (
          !change ||
          change.status === "applied" ||
          change.status === "completed"
        ) {
          continue;
        }
        if (
          change.status !== expectedChange.status ||
          change.replacementAllocationId
        ) {
          throw new ReflectedUsagePackSnapshotChanged();
        }
        if (
          change.orgId !== context.subscription.orgId ||
          change.usagePackSubscriptionId !== context.subscription.id
        ) {
          throw new Error(
            "Reflected usage pack change belongs to another billing owner",
          );
        }
        await retireReflectedChangeSource(tx, change, updatedAt);
        const replacementAllocationId = await createReflectedChangeReplacement(
          tx,
          context,
          change,
          period,
          updatedAt,
        );

        if (
          change.kind === "upgrade" &&
          change.subscriptionChangeId &&
          change.stripeScheduleId
        ) {
          // The paid upgrade replaces an older downgrade for this member. Retire
          // the old row before this one becomes applied; the partial unique index
          // permits only one scheduled/applied change per member.
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
                eq(usagePackAllocationChanges.orgId, change.orgId),
                eq(usagePackAllocationChanges.userId, change.userId),
                eq(usagePackAllocationChanges.status, "scheduled"),
                eq(
                  usagePackAllocationChanges.stripeScheduleId,
                  change.stripeScheduleId,
                ),
              ),
            );
        }

        const completed =
          change.kind !== "addition" && change.kind !== "upgrade";
        const [published] = await tx
          .update(usagePackAllocationChanges)
          .set({
            replacementAllocationId,
            status: completed ? "completed" : "applied",
            completedAt: completed ? updatedAt : null,
            effectiveAt:
              change.effectiveAt ??
              (change.kind === "addition" || change.kind === "upgrade"
                ? updatedAt
                : new Date(period.start * 1000)),
            updatedAt,
          })
          .where(
            and(
              eq(usagePackAllocationChanges.id, change.id),
              eq(usagePackAllocationChanges.status, expectedChange.status),
              fulfillmentChangeIdentity(expectedChange),
            ),
          )
          .returning({ id: usagePackAllocationChanges.id });
        if (!published) {
          throw new ReflectedUsagePackSnapshotChanged();
        }
        applied += 1;
      }
      return applied;
    }),
  );
  if (result.ok) {
    return result.value;
  }
  if (result.error instanceof ReflectedUsagePackSnapshotChanged) {
    return 0;
  }
  throw result.error;
}

class CanceledUsagePackSnapshotChanged extends Error {}

async function finalizeCanceledUsagePackChanges(
  db: Db,
  context: UsagePackChangeContext,
): Promise<number> {
  const finalizable = context.changes.filter((change) => {
    return change.status !== "applied";
  });
  if (finalizable.length === 0) {
    return 0;
  }
  const at = nowDate();
  const result = await settle(
    db.transaction(async (tx) => {
      // Each transition is conditional on the change status it was read in.
      // A paid invoice publication that commits first makes this batch roll
      // back; one that loses finds the failed change through its own status
      // condition, so neither order publishes a grant twice.
      let finalized = 0;
      for (const change of finalizable) {
        if (
          change.orgId !== context.subscription.orgId ||
          change.usagePackSubscriptionId !== context.subscription.id
        ) {
          throw new Error(
            "Canceled usage pack change belongs to another billing owner",
          );
        }
        const completed =
          change.kind === "removal" &&
          (change.status === "scheduled" || change.status === "applying");
        if (completed) {
          if (!change.sourceAllocationId || !change.sourceStripePriceId) {
            throw new Error(`Usage pack removal ${change.id} has no source`);
          }
          // Mutate the real source before its referencing change, matching
          // deletion's parent/child order without any SELECT lock.
          const [retired] = await tx
            .update(usagePackAllocations)
            .set({ status: "inactive", updatedAt: at })
            .where(
              and(
                eq(usagePackAllocations.id, change.sourceAllocationId),
                eq(usagePackAllocations.orgId, change.orgId),
                eq(
                  usagePackAllocations.usagePackSubscriptionId,
                  change.usagePackSubscriptionId,
                ),
                eq(usagePackAllocations.userId, change.userId),
                eq(
                  usagePackAllocations.stripePriceId,
                  change.sourceStripePriceId,
                ),
              ),
            )
            .returning({ id: usagePackAllocations.id });
          if (!retired) {
            throw new CanceledUsagePackSnapshotChanged();
          }
        }
        const [finalizedChange] = await tx
          .update(usagePackAllocationChanges)
          .set({
            status: completed ? "completed" : "failed",
            failureReason: completed ? null : "subscription_canceled",
            effectiveAt: change.effectiveAt ?? at,
            completedAt: at,
            updatedAt: at,
          })
          .where(
            and(
              eq(usagePackAllocationChanges.id, change.id),
              eq(usagePackAllocationChanges.status, change.status),
              fulfillmentChangeIdentity(change),
            ),
          )
          .returning({ id: usagePackAllocationChanges.id });
        if (!finalizedChange) {
          // A paid/applied/completed winner must not be overwritten. Roll back
          // every mutation in this stale batch; the normal next visit reloads.
          throw new CanceledUsagePackSnapshotChanged();
        }
        finalized += 1;
      }
      return finalized;
    }),
  );
  if (result.ok) {
    return result.value;
  }
  if (result.error instanceof CanceledUsagePackSnapshotChanged) {
    return 0;
  }
  throw result.error;
}

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

export async function reconcileUsagePackAllocationChangeSubscription(
  db: Db,
  subscription: UsagePackChangeSubscriptionInput,
): Promise<{ readonly reconciled: number; readonly orgId: string | null }> {
  const boundId = await boundUsagePackSubscriptionId(db, subscription.id);
  const usagePackSubscriptionId =
    boundId ??
    (await activeMetadataUsagePackSubscriptionId(
      db,
      usagePackSubscriptionIdFromMetadata(subscription.metadata),
    ));
  if (!usagePackSubscriptionId) {
    return { reconciled: 0, orgId: null };
  }
  const context = await loadUsagePackChangeContextBySubscriptionId(
    db,
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
    throw new Error("Stripe subscription does not match the usage pack record");
  }
  if (
    subscription.status === "canceled" ||
    subscription.status === "incomplete_expired"
  ) {
    const reconciled = await finalizeCanceledUsagePackChanges(db, context);
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
  const reconciled = await commitReflectedUsagePackChanges(
    db,
    context,
    reflected,
    period,
  );
  return { reconciled, orgId: context.subscription.orgId };
}

export async function reconcileUsagePackAllocationChangeSubscriptionDeleted(
  db: Db,
  subscription: {
    readonly id: string;
    readonly metadata?: Readonly<Record<string, string>> | null;
  },
): Promise<void> {
  const boundId = await boundUsagePackSubscriptionId(db, subscription.id);
  const usagePackSubscriptionId =
    boundId ??
    (await activeMetadataUsagePackSubscriptionId(
      db,
      usagePackSubscriptionIdFromMetadata(subscription.metadata),
    ));
  if (!usagePackSubscriptionId) {
    return;
  }
  const context = await loadUsagePackChangeContextBySubscriptionId(
    db,
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
  await finalizeCanceledUsagePackChanges(db, context);
}

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

export async function usagePackInvoiceFulfillmentExists(
  db: Pick<Db, "select">,
  invoiceId: string,
  usagePackSubscriptionId: string,
): Promise<boolean> {
  const [existing] = await db
    .select({
      usagePackSubscriptionId:
        usagePackInvoiceFulfillments.usagePackSubscriptionId,
    })
    .from(usagePackInvoiceFulfillments)
    .where(eq(usagePackInvoiceFulfillments.stripeInvoiceId, invoiceId))
    .limit(1);
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

async function findUsagePackChangeForInvoice(
  db: Pick<Db, "select">,
  usagePackSubscriptionId: string,
  invoice: UsagePackChangeInvoiceInput,
): Promise<UsagePackAllocationChangeRow | null> {
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
}

async function insertInvoiceFulfillmentReceipt(
  tx: WriteTx,
  values: typeof usagePackInvoiceFulfillments.$inferInsert,
): Promise<boolean> {
  const [inserted] = await tx
    .insert(usagePackInvoiceFulfillments)
    .values(values)
    .onConflictDoNothing()
    .returning({
      stripeInvoiceId: usagePackInvoiceFulfillments.stripeInvoiceId,
    });
  if (inserted) {
    return true;
  }
  const [existing] = await tx
    .select()
    .from(usagePackInvoiceFulfillments)
    .where(
      eq(usagePackInvoiceFulfillments.stripeInvoiceId, values.stripeInvoiceId),
    )
    .limit(1);
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
  return false;
}

async function commitUsagePackUpgradeInvoice(
  db: Db,
  args: {
    readonly change: UsagePackAllocationChangeRow;
    readonly invoice: UsagePackChangeInvoiceInput;
    readonly purchasedCredits: number;
    readonly bonusCredits: number;
    readonly prorationPeriod: UsagePackPeriod;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [subscription] = await tx
      .select()
      .from(
        grantSubscriptionOwnershipQuery(
          args.change.orgId,
          args.change.usagePackSubscriptionId,
        ),
      );
    const [wallet] = await tx
      .select()
      .from(grantWalletOwnershipQuery(args.change.orgId));
    requireGrantOwnership(subscription, wallet);
    const [change] = await tx
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
    if (
      await usagePackInvoiceFulfillmentExists(
        tx,
        args.invoice.id,
        change.usagePackSubscriptionId,
      )
    ) {
      return;
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
    const completedAt = nowDate();
    // The existing financial receipt is the real invoice identity, not a
    // coordination marker. Only its insertion winner proceeds; rollback of
    // any later amount/state check also rolls back this receipt.
    const inserted = await insertInvoiceFulfillmentReceipt(tx, {
      stripeInvoiceId: args.invoice.id,
      usagePackSubscriptionId: change.usagePackSubscriptionId,
      periodStart: new Date(args.prorationPeriod.start * 1000),
      periodEnd: new Date(args.prorationPeriod.end * 1000),
      createdAt: completedAt,
    });
    if (!inserted) {
      return;
    }
    // Claim the exact validated state before any grant: a concurrent writer
    // that moved the change leaves zero rows and rolls the whole receipt back.
    const [claimed] = await tx
      .update(usagePackAllocationChanges)
      .set({
        status: "completed",
        stripeInvoiceId: args.invoice.id,
        completedAt,
        updatedAt: completedAt,
      })
      .where(
        and(
          eq(usagePackAllocationChanges.id, change.id),
          eq(usagePackAllocationChanges.kind, "upgrade"),
          eq(usagePackAllocationChanges.status, "applied"),
          fulfillmentChangeIdentity(change),
          isNotNull(usagePackAllocationChanges.replacementAllocationId),
          or(
            isNull(usagePackAllocationChanges.stripeInvoiceId),
            eq(usagePackAllocationChanges.stripeInvoiceId, args.invoice.id),
          ),
        ),
      )
      .returning({ id: usagePackAllocationChanges.id });
    if (!claimed) {
      throw new Error(
        `Usage pack change ${change.id} changed before fulfillment`,
      );
    }
    if (args.purchasedCredits > 0) {
      const refundSource = upgradeRefundInvoiceSource(args.invoice, change);
      await createUsagePackCreditGrant(tx, {
        orgId: change.orgId,
        userId: change.userId,
        grantType: "purchased",
        idempotencyKey: `usage-pack-change:${change.id}:${args.invoice.id}:purchased`,
        amount: args.purchasedCredits,
        expiresAt: new Date(args.prorationPeriod.end * 1000),
        refundSource: {
          type: "invoice",
          invoiceId: args.invoice.id,
          invoiceLineId: refundSource?.invoiceLineId ?? null,
          amountCents:
            refundSource?.amountCents ??
            Math.floor(args.purchasedCredits / CREDITS_PER_CENT),
        },
      });
    }
    if (args.bonusCredits > 0) {
      await createUsagePackCreditGrant(tx, {
        orgId: change.orgId,
        userId: change.userId,
        grantType: "bonus",
        idempotencyKey: `usage-pack-change:${change.id}:${args.invoice.id}:bonus`,
        amount: args.bonusCredits,
        expiresAt: new Date(args.prorationPeriod.end * 1000),
      });
    }
  });
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

async function prepareSubscriptionChangeFulfillment(
  db: Db,
  args: SubscriptionChangeFulfillmentArgs,
): Promise<{
  readonly expectedRoot: UsagePackSubscriptionChangeRow;
  readonly preparedGrants: readonly PreparedSubscriptionChangeGrant[];
}> {
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
}

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

async function fulfillPreparedSubscriptionChange(
  tx: WriteTx,
  args: SubscriptionChangeFulfillmentArgs,
  expectedRoot: UsagePackSubscriptionChangeRow,
  preparedGrants: readonly PreparedSubscriptionChangeGrant[],
): Promise<void> {
  // Root identity and invoice receipt are existing business facts. The
  // unique receipt insertion arbitrates duplicate fulfillment without a key.
  const [root] = await tx
    .select()
    .from(usagePackSubscriptionChanges)
    .where(eq(usagePackSubscriptionChanges.id, args.subscriptionChangeId))
    .limit(1);
  if (
    !root ||
    root.orgId !== expectedRoot.orgId ||
    root.usagePackSubscriptionId !== expectedRoot.usagePackSubscriptionId
  ) {
    throw new Error(
      `Unknown usage pack subscription change: ${args.subscriptionChangeId}`,
    );
  }
  if (
    await usagePackInvoiceFulfillmentExists(
      tx,
      args.invoice.id,
      root.usagePackSubscriptionId,
    )
  ) {
    return;
  }
  const inserted = await insertInvoiceFulfillmentReceipt(tx, {
    stripeInvoiceId: args.invoice.id,
    usagePackSubscriptionId: root.usagePackSubscriptionId,
    periodStart: new Date(args.prorationTimestamp * 1000),
    periodEnd: new Date(args.periodEnd * 1000),
  });
  if (!inserted) {
    return;
  }
  for (const prepared of preparedGrants) {
    const completedAt = nowDate();
    // Conditional transition instead of a row lock: only an applied
    // addition/upgrade with a replacement can be completed, exactly once.
    const [change] = await tx
      .update(usagePackAllocationChanges)
      .set({ status: "completed", completedAt, updatedAt: completedAt })
      .where(
        and(
          eq(usagePackAllocationChanges.id, prepared.change.id),
          inArray(usagePackAllocationChanges.kind, ["addition", "upgrade"]),
          eq(usagePackAllocationChanges.status, "applied"),
          fulfillmentChangeIdentity(prepared.change),
          isNotNull(usagePackAllocationChanges.replacementAllocationId),
        ),
      )
      .returning();
    if (!change) {
      throw new Error(
        `Subscription change allocation ${prepared.change.id} is not ready for fulfillment`,
      );
    }
    if (prepared.purchasedCredits > 0) {
      await createUsagePackCreditGrant(tx, {
        orgId: change.orgId,
        userId: change.userId,
        grantType: "purchased",
        idempotencyKey: `usage-pack-subscription-change:${root.id}:${change.id}:${args.invoice.id}:purchased`,
        amount: prepared.purchasedCredits,
        expiresAt: new Date(args.periodEnd * 1000),
        refundSource: {
          type: "invoice",
          invoiceId: args.invoice.id,
          invoiceLineId: prepared.stripeInvoiceLineId,
          amountCents: prepared.sourceAmountCents,
        },
      });
    }
    if (prepared.bonusCredits > 0) {
      await createUsagePackCreditGrant(tx, {
        orgId: change.orgId,
        userId: change.userId,
        grantType: "bonus",
        idempotencyKey: `usage-pack-subscription-change:${root.id}:${change.id}:${args.invoice.id}:bonus`,
        amount: prepared.bonusCredits,
        expiresAt: new Date(args.periodEnd * 1000),
      });
    }
  }
}

export async function fulfillUsagePackSubscriptionChangeInvoice(
  db: Db,
  args: SubscriptionChangeFulfillmentArgs,
): Promise<void> {
  const { expectedRoot, preparedGrants } =
    await prepareSubscriptionChangeFulfillment(db, args);
  await db.transaction(async (tx) => {
    const [subscription] = await tx
      .select()
      .from(
        grantSubscriptionOwnershipQuery(
          expectedRoot.orgId,
          expectedRoot.usagePackSubscriptionId,
        ),
      );
    const [wallet] = await tx
      .select()
      .from(grantWalletOwnershipQuery(expectedRoot.orgId));
    requireGrantOwnership(subscription, wallet);
    await fulfillPreparedSubscriptionChange(
      tx,
      args,
      expectedRoot,
      preparedGrants,
    );
  });
}

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
async function refundCanceledUsagePackChangeInvoice(
  db: Db,
  change: UsagePackAllocationChangeRow,
  invoice: UsagePackChangeInvoiceInput,
): Promise<void> {
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
          ...(total > amountPaid ? { credit_amount: total - amountPaid } : {}),
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
}

/**
 * Subscription deletion makes the usage pack record terminal, so its paid
 * pending-upgrade invoice no longer resolves through the active binding. The
 * change row's unique stripe_invoice_id still identifies the canceled change.
 */
async function refundCanceledChangeOfTerminalSubscription(
  db: Db,
  invoice: UsagePackChangeInvoiceInput,
): Promise<UsagePackChangeInvoiceOutcome> {
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
  await refundCanceledUsagePackChangeInvoice(db, change, invoice);
  return { handled: true, orgId: change.orgId };
}

export async function handleUsagePackAllocationChangeInvoicePaid(
  db: Db,
  invoice: UsagePackChangeInvoiceInput,
): Promise<UsagePackChangeInvoiceOutcome> {
  const usagePackSubscriptionId = await invoiceUsagePackSubscriptionId(
    db,
    invoice,
  );
  if (!usagePackSubscriptionId) {
    return await refundCanceledChangeOfTerminalSubscription(db, invoice);
  }
  const context = await loadUsagePackChangeContextBySubscriptionId(
    db,
    usagePackSubscriptionId,
  );
  if (!context) {
    throw new Error(
      `Unknown usage pack subscription: ${usagePackSubscriptionId}`,
    );
  }
  if (
    await usagePackInvoiceFulfillmentExists(
      db,
      invoice.id,
      usagePackSubscriptionId,
    )
  ) {
    return { handled: true, orgId: context.subscription.orgId };
  }
  const change = await findUsagePackChangeForInvoice(
    db,
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
  await reconcileUsagePackAllocationChangeSubscription(db, stripeSubscription);
  if (
    change.kind !== "upgrade" ||
    !change.sourceAllocationId ||
    !change.sourceStripePriceId
  ) {
    throw new Error(`Usage pack change ${change.id} is not an upgrade`);
  }

  const [reconciledChanges, sourceAllocations] = await Promise.all([
    db
      .select()
      .from(usagePackAllocationChanges)
      .where(eq(usagePackAllocationChanges.id, change.id))
      .limit(1),
    db
      .select()
      .from(usagePackAllocations)
      .where(eq(usagePackAllocations.id, change.sourceAllocationId))
      .limit(1),
  ]);
  const reconciledChange = reconciledChanges[0];
  const sourceAllocation = sourceAllocations[0];
  if (!reconciledChange || !sourceAllocation) {
    throw new Error(`Usage pack change ${change.id} disappeared`);
  }
  if (isCanceledChangeForInvoice(reconciledChange, invoice.id)) {
    await refundCanceledUsagePackChangeInvoice(db, reconciledChange, invoice);
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
  await commitUsagePackUpgradeInvoice(db, {
    change: reconciledChange,
    invoice,
    purchasedCredits,
    bonusCredits,
    prorationPeriod,
  });
  return { handled: true, orgId: context.subscription.orgId };
}

async function failExpiredUsagePackUpgrade(
  db: Db,
  context: UsagePackChangeContext,
  subscription: UsagePackChangeSubscriptionInput,
  at: Date,
): Promise<number> {
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
}

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

async function retryApplyingDeferredUsagePackChange(
  db: Db,
  context: UsagePackChangeContext,
  subscription: StripeSubscription,
  signal: AbortSignal,
): Promise<{
  readonly reconciled: number;
  readonly cancellation?: EmptyUsagePackCancellation;
}> {
  const change = context.changes.find((candidate) => {
    return (
      candidate.subscriptionChangeId === null &&
      candidate.status === "applying" &&
      candidate.kind !== "upgrade"
    );
  });
  if (!change) {
    return { reconciled: 0 };
  }
  validateCurrentStripeProjection(context, subscription);
  const deferred = await scheduleDeferredUsagePackChange(
    db,
    context,
    change,
    subscription,
    signal,
  );
  return "emptyCancellation" in deferred
    ? { reconciled: 0, cancellation: deferred.emptyCancellation }
    : { reconciled: 1 };
}

async function usagePackChangeCandidateSubscriptionIds(
  db: Pick<Db, "select">,
  at: Date,
  staleBefore: Date,
): Promise<readonly string[]> {
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
}

async function reconcileUsagePackAllocationChangeCandidate(
  db: Db,
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
  const context = await loadUsagePackChangeContextBySubscriptionId(
    db,
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
  const result = await reconcileUsagePackAllocationChangeSubscription(
    db,
    subscription,
  );
  reconciled += result.reconciled;
  if (result.orgId) {
    orgIds.add(result.orgId);
  }
  signal.throwIfAborted();

  const refreshed = await loadUsagePackChangeContextBySubscriptionId(
    db,
    usagePackSubscriptionId,
  );
  if (!refreshed) {
    return { reconciled, orgIds: [...orgIds], emptyCancellations };
  }
  const deferred = await retryApplyingDeferredUsagePackChange(
    db,
    refreshed,
    subscription,
    signal,
  );
  reconciled += deferred.reconciled;
  if (deferred.cancellation) {
    emptyCancellations.push(deferred.cancellation);
  }
  const hasOpenUpgrade = refreshed.changes.some((change) => {
    return change.subscriptionChangeId === null && change.kind === "upgrade";
  });
  if (hasOpenUpgrade) {
    const invoice = await paidUpgradeInvoiceForSubscription(subscription);
    signal.throwIfAborted();
    if (invoice) {
      const outcome = await handleUsagePackAllocationChangeInvoicePaid(
        db,
        invoice,
      );
      reconciled += outcome.handled ? 1 : 0;
      if (outcome.orgId) {
        orgIds.add(outcome.orgId);
      }
    }
  }
  const afterInvoice = await loadUsagePackChangeContextBySubscriptionId(
    db,
    usagePackSubscriptionId,
  );
  if (afterInvoice) {
    reconciled += await failExpiredUsagePackUpgrade(
      db,
      afterInvoice,
      subscription,
      at,
    );
  }
  signal.throwIfAborted();
  return { reconciled, orgIds: [...orgIds], emptyCancellations };
}

export async function reconcileUsagePackAllocationChanges(
  db: Db,
  signal: AbortSignal,
): Promise<{
  readonly reconciled: number;
  readonly orgIds: readonly string[];
  readonly emptyCancellations: readonly EmptyUsagePackCancellation[];
}> {
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

  const subscriptionIds = await usagePackChangeCandidateSubscriptionIds(
    db,
    at,
    staleBefore,
  );
  signal.throwIfAborted();
  const orgIds = new Set<string>();
  const emptyCancellations: EmptyUsagePackCancellation[] = [];
  let reconciled = expiredPreviews.length;
  for (const usagePackSubscriptionId of subscriptionIds) {
    const result = await settle(
      reconcileUsagePackAllocationChangeCandidate(
        db,
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
}

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
  db: Pick<Db, "select">,
  change: UsagePackAllocationChangeRow,
  source: typeof usagePackAllocations.$inferSelect,
) {
  return sql`EXISTS (${db
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
    const result = await db.transaction(async (tx) => {
      // The existing live standalone-operation uniqueness plus the real
      // preview -> applying transition admits this stored financial intent.
      const [found] = await tx
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
          await tx.execute(
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
        const [expired] = await tx
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
      const [source] = await tx
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
        await tx
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
      const [prepared] = await tx
        .update(usagePackAllocationChanges)
        .set({ status: "applying", updatedAt: at })
        .where(
          and(
            previewedChange,
            sql`NOT EXISTS (${conflictingUsagePackMutationSql({ subscriptionId: change.usagePackSubscriptionId, allocationChangeId: change.id })})`,
            activeAllocationSourceCondition(tx, change, source),
          ),
        )
        .returning();
      return prepared
        ? { status: "ready" as const, change: prepared }
        : { status: "conflict" as const };
    });
    signal.throwIfAborted();
    return result;
  },
);

async function confirmUsagePackDowngrade(
  db: Db,
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
  const scheduled = await scheduleDeferredUsagePackChange(
    db,
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
}

async function confirmUsagePackUpgrade(
  db: Db,
  args: {
    readonly change: UsagePackAllocationChangeRow;
    readonly subscription: StripeSubscription;
    readonly paymentMethod: BillingPurchasePaymentMethod | undefined;
  },
  signal: AbortSignal,
): Promise<UsagePackChangeConfirmResult> {
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
    await reconcileUsagePackAllocationChangeSubscription(
      db,
      updatedSubscription,
    );
    signal.throwIfAborted();
    if (invoice.status === "paid") {
      await handleUsagePackAllocationChangeInvoicePaid(
        db,
        invoice as UsagePackChangeInvoiceInput,
      );
      signal.throwIfAborted();
    }
  }
  const [finalChange] = await db
    .select({ status: usagePackAllocationChanges.status })
    .from(usagePackAllocationChanges)
    .where(eq(usagePackAllocationChanges.id, change.id))
    .limit(1);
  const completed = finalChange?.status === "completed";
  return {
    status: "confirmed",
    response: {
      status: completed
        ? "completed"
        : pending
          ? "pending_payment"
          : "processing",
      effectiveAt:
        change.effectiveAt?.toISOString() ??
        new Date(change.prorationTimestamp * 1000).toISOString(),
      hostedInvoiceUrl:
        payment.status === "pending_payment" ? payment.hostedInvoiceUrl : null,
    },
  };
}

async function storedUsagePackConfirmationResult(
  db: Db,
  changeId: string,
): Promise<UsagePackChangeConfirmResult | null> {
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
}

async function resumeUsagePackChangeConfirmation(
  db: Db,
  change: UsagePackAllocationChangeRow,
  subscription: StripeSubscription,
  signal: AbortSignal,
): Promise<UsagePackChangeConfirmResult | null> {
  await reconcileUsagePackAllocationChangeSubscription(db, subscription);
  signal.throwIfAborted();
  let stored = await storedUsagePackConfirmationResult(db, change.id);
  if (stored) {
    if (
      stored.status === "confirmed" &&
      stored.response.status === "processing" &&
      change.kind === "upgrade"
    ) {
      const invoice = await paidUpgradeInvoiceForSubscription(subscription);
      signal.throwIfAborted();
      if (invoice) {
        await handleUsagePackAllocationChangeInvoicePaid(db, invoice);
        signal.throwIfAborted();
        stored = await storedUsagePackConfirmationResult(db, change.id);
      }
    }
    return stored;
  }
  if (change.kind !== "upgrade" || !subscription.pending_update) {
    return null;
  }
  const updatedAt = nowDate();
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
  signal.throwIfAborted();
  return await storedUsagePackConfirmationResult(db, change.id);
}

async function failApplyingUsagePackChangeForEndingPlan(
  db: Db,
  changeId: string,
): Promise<void> {
  const failedAt = nowDate();
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
}

export async function confirmUsagePackAllocationChange(
  db: Db,
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
  const context = await loadUsagePackChangeContextBySubscriptionId(
    db,
    change.usagePackSubscriptionId,
  );
  if (!context || !context.subscription.stripeSubscriptionId) {
    throw new Error("Usage pack subscription disappeared during confirmation");
  }
  const stripe = getStripeClient();
  const subscription = await stripe.subscriptions.retrieve(
    context.subscription.stripeSubscriptionId,
  );
  signal.throwIfAborted();
  const resumed = await resumeUsagePackChangeConfirmation(
    db,
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
    await failApplyingUsagePackChangeForEndingPlan(db, change.id);
    return { status: "plan_ending" };
  }
  if (change.kind === "downgrade") {
    return await confirmUsagePackDowngrade(
      db,
      context,
      change,
      subscription,
      signal,
    );
  }
  if (change.kind !== "upgrade") {
    throw new Error("Usage pack removal cannot be confirmed manually");
  }
  return await confirmUsagePackUpgrade(
    db,
    {
      change,
      subscription,
      paymentMethod: args.paymentMethod,
    },
    signal,
  );
}
