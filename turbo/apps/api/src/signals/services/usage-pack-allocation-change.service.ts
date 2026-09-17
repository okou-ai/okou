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
  usagePackSubscriptions,
} from "@okouai/db/schema/usage-pack-subscription";
import {
  and,
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
import { pgBooleanDecoder } from "../../lib/db-structured-result";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import {
  getStripeClient,
  type StripeClient,
  type StripeInvoice,
  type StripeInvoiceAutomaticTaxParam,
  type StripeInvoiceLine,
  type StripePriceRecurring,
  type StripeRef,
  type StripeSchedulePhaseDiscountParam,
  type StripeSchedulePhaseItemParam,
  type StripeSchedulePhaseParam,
  type StripeSubscription,
  type StripeSubscriptionUpdateItemParam,
} from "../external/stripe-client";
import { settle } from "../utils";
import { createUsagePackCreditGrant } from "./usage-pack-credit.service";
import { prepareUsagePackMemberCreditRefunds } from "./usage-pack-credit-refund.service";
import type { BillingReconciliationScope } from "./billing-reconciliation-scope";
import { completeBillingOperationInvoice } from "./billing-operation-invoice.service";
import {
  setStripeSubscriptionPaymentMethod,
  type BillingPurchasePaymentMethod,
} from "./billing-payment-method.service";
import { downgradeSubscriptionForOrg } from "./billing-downgrade.service";
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

export async function usagePackAllocationChangeSchemaAvailable(
  db: Pick<Db, "select">,
): Promise<boolean> {
  const [state] = await db
    .select({
      available:
        sql`to_regclass('public.usage_pack_allocation_changes') IS NOT NULL`.mapWith(
          pgBooleanDecoder,
        ),
    })
    .from(sql`(SELECT 1) AS schema_probe`)
    .limit(1);
  return state?.available ?? false;
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

export async function lockUsagePackBillingOrg(
  tx: Pick<WriteTx, "execute">,
  orgId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`usage_pack_billing:${orgId}`}, 0))`,
  );
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
  supportsMemberAdditions = false,
): Promise<UsagePackManagementResponse | null> {
  const context = await loadUsagePackChangeContextForOrg(db, orgId);
  if (!context) {
    return null;
  }
  const changesByUserId = new Map(
    context.changes
      .filter((change) => {
        return change.status !== "previewed";
      })
      .map((change) => {
        return [change.userId, change] as const;
      }),
  );
  return {
    tier: context.subscription.tier,
    supportsFreeMembers: true,
    currentPeriodEnd:
      context.subscription.currentPeriodEnd?.toISOString() ?? null,
    ...(supportsMemberAdditions ? { supportsMemberAdditions: true } : {}),
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
    : stripe.invoices.createPreview({
        subscription: subscription.id,
        preview_mode: "recurring",
        subscription_details: {
          items,
        },
      });
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

async function persistUsagePackChangePreview(
  db: Db,
  context: UsagePackChangeContext,
  source: UsagePackAllocationRow,
  args: UsagePackChangePreviewArgs,
  preview: StripeUsagePackChangePreview,
): Promise<UsagePackAllocationChangeRow | undefined> {
  const [change] = await db.transaction(async (tx) => {
    await lockUsagePackBillingOrg(tx, args.orgId);
    await expireStaleUsagePackPreviews(tx, args.orgId, preview.createdAt);
    const [lockedSource] = await tx
      .select()
      .from(usagePackAllocations)
      .where(eq(usagePackAllocations.id, source.id))
      .for("update")
      .limit(1);
    if (
      !lockedSource ||
      lockedSource.status !== "active" ||
      lockedSource.usagePackUsd !== source.usagePackUsd ||
      lockedSource.stripePriceId !== source.stripePriceId
    ) {
      return [];
    }
    return await tx
      .insert(usagePackAllocationChanges)
      .values({
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
      })
      .onConflictDoNothing()
      .returning();
  });
  return change;
}

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

export async function previewUsagePackAllocationChange(
  db: Db,
  args: UsagePackChangePreviewArgs,
  signal: AbortSignal,
): Promise<UsagePackChangePreviewResult> {
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
  if (openSubscriptionChange) {
    return { status: "conflict" };
  }
  const context = await loadUsagePackChangeContextForOrg(db, args.orgId);
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
  const change = await persistUsagePackChangePreview(
    db,
    context,
    source,
    args,
    preview,
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
      prorationDate: new Date(preview.prorationTimestamp * 1000).toISOString(),
      expiresAt: preview.expiresAt.toISOString(),
    },
  };
}

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

export async function previewUsagePackAllocationAddition(
  db: Pick<Db, "select">,
  args: {
    readonly usagePackSubscriptionId: string;
    readonly stripePriceId: string;
    readonly prorationTimestamp?: number;
  },
  signal: AbortSignal,
): Promise<UsagePackAllocationAdditionChargePreview> {
  const context = await loadUsagePackChangeContextBySubscriptionId(
    db,
    args.usagePackSubscriptionId,
  );
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

async function syncUsagePackProjection(
  subscription: UsagePackChangeSubscriptionInput,
  args: {
    readonly currentQuantities: ReadonlyMap<string, number>;
    readonly renewalQuantities: ReadonlyMap<string, number>;
    readonly operationId: string;
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
      {
        idempotencyKey: `usage-pack-projection:${args.operationId}:${projectionId}:schedule`,
      },
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
      {
        idempotencyKey: `usage-pack-projection:${args.operationId}:${projectionId}:subscription`,
      },
    );
  }
  signal?.throwIfAborted();
}

type UsagePackInvitationProjectionChange =
  | {
      readonly kind: "accept";
      readonly allocationId: string;
      readonly userId: string;
    }
  | { readonly kind: "remove"; readonly allocationId: string };

function contextForInvitationProjection(
  context: UsagePackChangeContext,
  change: UsagePackInvitationProjectionChange,
): UsagePackChangeContext {
  const allocation = context.allocations.find((candidate) => {
    return candidate.id === change.allocationId;
  });
  if (change.kind === "remove") {
    if (allocation?.status !== "inactive") {
      throw new Error("Removed invitation allocation is not inactive");
    }
    return context;
  }
  if (
    allocation?.userId !== change.userId ||
    (allocation.status !== "paid_pending_invitation" &&
      allocation.status !== "active")
  ) {
    throw new Error("Accepted invitation allocation is not ready");
  }
  return withAcceptedInvitationAllocations(context);
}

async function syncUsagePackInvitationProjection(
  db: Pick<Db, "select">,
  args: {
    readonly usagePackSubscriptionId: string;
    readonly operationId: string;
    readonly change: UsagePackInvitationProjectionChange;
  },
  signal?: AbortSignal,
): Promise<void> {
  const context = await loadUsagePackChangeContextBySubscriptionId(
    db,
    args.usagePackSubscriptionId,
  );
  const stripeSubscriptionId = context?.subscription.stripeSubscriptionId;
  if (!context || !stripeSubscriptionId) {
    throw new Error("Usage pack subscription is not ready");
  }
  const subscription =
    await getStripeClient().subscriptions.retrieve(stripeSubscriptionId);
  signal?.throwIfAborted();
  if (
    subscription.id !== stripeSubscriptionId ||
    stripeObjectId(subscription.customer) !==
      context.subscription.stripeCustomerId
  ) {
    throw new Error("Stripe subscription does not match the usage pack record");
  }
  const projectionContext = contextForInvitationProjection(
    context,
    args.change,
  );
  const currentQuantities = packageQuantitiesForAllocations(
    projectionContext.allocations,
  );
  const scheduledChanges = projectionContext.changes.filter((change) => {
    return change.status === "scheduled";
  });
  const renewalQuantities = projectedQuantitiesAfterChanges(
    projectionContext,
    scheduledChanges,
  );
  await syncUsagePackProjection(
    subscription,
    {
      currentQuantities,
      renewalQuantities,
      operationId: args.operationId,
    },
    signal,
  );
}

/**
 * Converges Stripe to the local allocation projection without creating a
 * current-period proration. This is safe to retry after invitation acceptance.
 */
export async function syncUsagePackAllocationProjection(
  db: Pick<Db, "select">,
  args: {
    readonly usagePackSubscriptionId: string;
    readonly operationId: string;
    readonly includedAllocationId: string;
    readonly includedUserId: string;
  },
  signal?: AbortSignal,
): Promise<void> {
  await syncUsagePackInvitationProjection(
    db,
    {
      usagePackSubscriptionId: args.usagePackSubscriptionId,
      operationId: args.operationId,
      change: {
        kind: "accept",
        allocationId: args.includedAllocationId,
        userId: args.includedUserId,
      },
    },
    signal,
  );
}

/** Removes a refunded, already-billed invitation from current and renewal quantities. */
export async function syncUsagePackAllocationProjectionAfterInvitationRemoval(
  db: Pick<Db, "select">,
  args: {
    readonly usagePackSubscriptionId: string;
    readonly operationId: string;
    readonly removedAllocationId: string;
  },
): Promise<void> {
  await syncUsagePackInvitationProjection(db, {
    usagePackSubscriptionId: args.usagePackSubscriptionId,
    operationId: args.operationId,
    change: { kind: "remove", allocationId: args.removedAllocationId },
  });
}

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
  if (!(await usagePackAllocationChangeSchemaAvailable(db))) {
    return null;
  }
  signal.throwIfAborted();
  const at = nowDate();
  const reservationId = await db.transaction(async (tx) => {
    await lockUsagePackBillingOrg(tx, args.orgId);
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
      .returning({ id: usagePackAllocationChanges.id });
    if (!reservation) {
      throw new Error("Failed to reserve usage pack member removal");
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
    await lockUsagePackBillingOrg(tx, args.orgId);
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

interface DeferredUsagePackChangeResult {
  readonly effectiveAt: Date;
  readonly stripeScheduleId: string | null;
}

async function applyDeferredUsagePackChange(
  db: Db,
  context: UsagePackChangeContext,
  change: UsagePackAllocationChangeRow,
  subscription: UsagePackChangeSubscriptionInput,
  signal: AbortSignal | undefined,
): Promise<DeferredUsagePackChangeResult> {
  if (change.kind === "upgrade") {
    throw new Error("Usage pack upgrades cannot be deferred");
  }
  const period = usagePackItemPeriod(subscription);
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
  const cancellation = await downgradeSubscriptionForOrg(
    db,
    {
      orgId: context.subscription.orgId,
      targetTier: "limited-free-1",
      requirePaymentMethod: false,
    },
    signal,
  );
  if (!cancellation.ok) {
    throw new Error(
      `Failed to cancel empty usage pack subscription: ${cancellation.reason}`,
    );
  }
  if (cancellation.status !== "scheduled") {
    throw new Error("Usage pack cancellation unexpectedly requires payment");
  }
  await db
    .update(usagePackSubscriptions)
    .set({ cancelAtPeriodEnd: true, updatedAt: nowDate() })
    .where(eq(usagePackSubscriptions.id, context.subscription.id));
  signal?.throwIfAborted();
  return {
    effectiveAt: cancellation.effectiveDate
      ? new Date(cancellation.effectiveDate)
      : new Date(period.end * 1000),
    stripeScheduleId: null,
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
    db,
    context,
    change,
    subscription,
    signal,
  );
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
  if (
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
): Promise<boolean> {
  if (!(await usagePackAllocationChangeSchemaAvailable(db))) {
    await db.transaction(async (tx) => {
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
    });
    signal.throwIfAborted();
    return false;
  }
  const prepared = await prepareUsagePackMemberRemoval(db, args);
  signal.throwIfAborted();
  if (!prepared) {
    return false;
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
    await scheduleDeferredUsagePackChange(
      db,
      prepared.context,
      prepared.change,
      stripeSubscription,
      signal,
    );
  } else {
    await applyImmediateUsagePackMemberRemoval(
      db,
      prepared.context,
      prepared.change,
      stripeSubscription,
      signal,
    );
  }
  return true;
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

async function retireReflectedChangeSource(
  tx: WriteTx,
  change: UsagePackAllocationChangeRow,
  updatedAt: Date,
): Promise<void> {
  if (change.kind === "addition") {
    const [existing] = await tx
      .select({ id: usagePackAllocations.id })
      .from(usagePackAllocations)
      .where(
        and(
          eq(usagePackAllocations.orgId, change.orgId),
          eq(usagePackAllocations.userId, change.userId),
          ne(usagePackAllocations.status, "inactive"),
        ),
      )
      .for("update")
      .limit(1);
    if (existing) {
      throw new Error(
        `Usage pack addition ${change.id} already has an allocation`,
      );
    }
    return;
  }
  if (!change.sourceAllocationId || !change.sourceStripePriceId) {
    throw new Error(`Usage pack change ${change.id} has no source`);
  }
  const [source] = await tx
    .select()
    .from(usagePackAllocations)
    .where(eq(usagePackAllocations.id, change.sourceAllocationId))
    .for("update")
    .limit(1);
  if (
    !source ||
    source.status !== "active" ||
    source.userId !== change.userId ||
    source.stripePriceId !== change.sourceStripePriceId
  ) {
    throw new Error(
      `Usage pack change ${change.id} has no current source allocation`,
    );
  }
  await tx
    .update(usagePackAllocations)
    .set({ status: "inactive", updatedAt })
    .where(eq(usagePackAllocations.id, source.id));
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
    .returning({ id: usagePackAllocations.id });
  if (!replacement) {
    throw new Error(
      `Failed to create replacement for usage pack change ${change.id}`,
    );
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
  return await db.transaction(async (tx) => {
    await lockUsagePackBillingOrg(tx, context.subscription.orgId);
    let applied = 0;
    const updatedAt = nowDate();
    for (const expectedChange of changes) {
      const [change] = await tx
        .select()
        .from(usagePackAllocationChanges)
        .where(eq(usagePackAllocationChanges.id, expectedChange.id))
        .for("update")
        .limit(1);
      if (
        !change ||
        change.status === "applied" ||
        change.status === "completed"
      ) {
        continue;
      }
      if (change.status === "failed" || change.replacementAllocationId) {
        throw new Error(
          `Usage pack change ${expectedChange.id} changed during reconciliation`,
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

      const completed = change.kind !== "addition" && change.kind !== "upgrade";
      await tx
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
        .where(eq(usagePackAllocationChanges.id, change.id));
      applied += 1;
    }
    return applied;
  });
}

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
  return await db.transaction(async (tx) => {
    await lockUsagePackBillingOrg(tx, context.subscription.orgId);
    let finalized = 0;
    for (const expected of finalizable) {
      const [change] = await tx
        .select()
        .from(usagePackAllocationChanges)
        .where(eq(usagePackAllocationChanges.id, expected.id))
        .for("update")
        .limit(1);
      if (!change || change.status === "applied") {
        continue;
      }
      const completed =
        change.kind === "removal" &&
        (change.status === "scheduled" || change.status === "applying");
      if (completed) {
        if (!change.sourceAllocationId) {
          throw new Error(`Usage pack removal ${change.id} has no source`);
        }
        await tx
          .update(usagePackAllocations)
          .set({ status: "inactive", updatedAt: at })
          .where(eq(usagePackAllocations.id, change.sourceAllocationId));
      }
      await tx
        .update(usagePackAllocationChanges)
        .set({
          status: completed ? "completed" : "failed",
          failureReason: completed ? null : "subscription_canceled",
          effectiveAt: change.effectiveAt ?? at,
          completedAt: at,
          updatedAt: at,
        })
        .where(eq(usagePackAllocationChanges.id, change.id));
      finalized += 1;
    }
    return finalized;
  });
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
  if (!(await usagePackAllocationChangeSchemaAvailable(db))) {
    return { reconciled: 0, orgId: null };
  }
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
    return change.kind === "upgrade";
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
  if (!(await usagePackAllocationChangeSchemaAvailable(db))) {
    return;
  }
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
      ((priceId === change.sourceStripePriceId && amount <= 0) ||
        (priceId === change.targetStripePriceId && amount >= 0)) &&
      line.period.start === change.prorationTimestamp
    );
  });
  const targetLine = matchingLines.find((line) => {
    return invoiceLinePriceId(line) === change.targetStripePriceId;
  });
  const sourceLine = change.sourceStripePriceId
    ? matchingLines.find((line) => {
        return invoiceLinePriceId(line) === change.sourceStripePriceId;
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
    const [change] = await tx
      .select()
      .from(usagePackAllocationChanges)
      .where(eq(usagePackAllocationChanges.id, args.change.id))
      .for("update")
      .limit(1);
    if (!change) {
      throw new Error(`Unknown usage pack change: ${args.change.id}`);
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
    const completedAt = nowDate();
    await tx.insert(usagePackInvoiceFulfillments).values({
      stripeInvoiceId: args.invoice.id,
      usagePackSubscriptionId: change.usagePackSubscriptionId,
      periodStart: new Date(args.prorationPeriod.start * 1000),
      periodEnd: new Date(args.prorationPeriod.end * 1000),
      createdAt: completedAt,
    });
    await tx
      .update(usagePackAllocationChanges)
      .set({
        status: "completed",
        stripeInvoiceId: args.invoice.id,
        completedAt,
        updatedAt: completedAt,
      })
      .where(eq(usagePackAllocationChanges.id, change.id));
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

async function fulfillPreparedSubscriptionChange(
  tx: WriteTx,
  args: SubscriptionChangeFulfillmentArgs,
  expectedRoot: UsagePackSubscriptionChangeRow,
  preparedGrants: readonly PreparedSubscriptionChangeGrant[],
): Promise<void> {
  await lockUsagePackBillingOrg(tx, expectedRoot.orgId);
  const [root] = await tx
    .select()
    .from(usagePackSubscriptionChanges)
    .where(eq(usagePackSubscriptionChanges.id, args.subscriptionChangeId))
    .for("update")
    .limit(1);
  if (!root) {
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
  for (const prepared of preparedGrants) {
    const [change] = await tx
      .select()
      .from(usagePackAllocationChanges)
      .where(eq(usagePackAllocationChanges.id, prepared.change.id))
      .for("update")
      .limit(1);
    if (
      !change ||
      (change.kind !== "addition" && change.kind !== "upgrade") ||
      change.status !== "applied" ||
      !change.replacementAllocationId
    ) {
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
    const completedAt = nowDate();
    await tx
      .update(usagePackAllocationChanges)
      .set({ status: "completed", completedAt, updatedAt: completedAt })
      .where(eq(usagePackAllocationChanges.id, change.id));
  }
  await tx.insert(usagePackInvoiceFulfillments).values({
    stripeInvoiceId: args.invoice.id,
    usagePackSubscriptionId: root.usagePackSubscriptionId,
    periodStart: new Date(args.prorationTimestamp * 1000),
    periodEnd: new Date(args.periodEnd * 1000),
  });
}

export async function fulfillUsagePackSubscriptionChangeInvoice(
  db: Db,
  args: SubscriptionChangeFulfillmentArgs,
): Promise<void> {
  const { expectedRoot, preparedGrants } =
    await prepareSubscriptionChangeFulfillment(db, args);
  await db.transaction(async (tx) => {
    await fulfillPreparedSubscriptionChange(
      tx,
      args,
      expectedRoot,
      preparedGrants,
    );
  });
}

export async function handleUsagePackAllocationChangeInvoicePaid(
  db: Db,
  invoice: UsagePackChangeInvoiceInput,
): Promise<UsagePackChangeInvoiceOutcome> {
  if (!(await usagePackAllocationChangeSchemaAvailable(db))) {
    return { handled: false, orgId: null };
  }
  const usagePackSubscriptionId = await invoiceUsagePackSubscriptionId(
    db,
    invoice,
  );
  if (!usagePackSubscriptionId) {
    return { handled: false, orgId: null };
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
): Promise<number> {
  const change = context.changes.find((candidate) => {
    return (
      candidate.subscriptionChangeId === null &&
      candidate.status === "applying" &&
      candidate.kind !== "upgrade"
    );
  });
  if (!change) {
    return 0;
  }
  validateCurrentStripeProjection(context, subscription);
  await scheduleDeferredUsagePackChange(
    db,
    context,
    change,
    subscription,
    signal,
  );
  return 1;
}

async function usagePackChangeCandidateSubscriptionIds(
  db: Pick<Db, "select">,
  at: Date,
  staleBefore: Date,
  scope: BillingReconciliationScope | undefined,
): Promise<readonly string[]> {
  const rows = await db
    .select({
      usagePackSubscriptionId:
        usagePackAllocationChanges.usagePackSubscriptionId,
    })
    .from(usagePackAllocationChanges)
    .where(
      and(
        scope
          ? inArray(usagePackAllocationChanges.orgId, [...scope.orgIds])
          : undefined,
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
}> {
  let reconciled = 0;
  const orgIds = new Set<string>();
  const context = await loadUsagePackChangeContextBySubscriptionId(
    db,
    usagePackSubscriptionId,
  );
  signal.throwIfAborted();
  if (!context?.subscription.stripeSubscriptionId) {
    return { reconciled, orgIds: [...orgIds] };
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
    return { reconciled, orgIds: [...orgIds] };
  }
  reconciled += await retryApplyingDeferredUsagePackChange(
    db,
    refreshed,
    subscription,
    signal,
  );
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
  return { reconciled, orgIds: [...orgIds] };
}

export async function reconcileUsagePackAllocationChanges(
  db: Db,
  scope: BillingReconciliationScope | undefined,
  signal: AbortSignal,
): Promise<{
  readonly reconciled: number;
  readonly orgIds: readonly string[];
}> {
  if (!(await usagePackAllocationChangeSchemaAvailable(db))) {
    return { reconciled: 0, orgIds: [] };
  }
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
        scope
          ? inArray(usagePackAllocationChanges.orgId, [...scope.orgIds])
          : undefined,
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
    scope,
  );
  signal.throwIfAborted();
  const orgIds = new Set<string>();
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
    for (const orgId of result.value.orgIds) {
      orgIds.add(orgId);
    }
  }
  return { reconciled, orgIds: [...orgIds] };
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

async function prepareUsagePackChangeConfirmation(
  db: Db,
  args: { readonly orgId: string; readonly changeId: string },
): Promise<
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
  | { readonly status: "conflict" }
> {
  const at = nowDate();
  return await db.transaction(async (tx) => {
    await lockUsagePackBillingOrg(tx, args.orgId);
    const [change] = await tx
      .select()
      .from(usagePackAllocationChanges)
      .where(
        and(
          eq(usagePackAllocationChanges.id, args.changeId),
          eq(usagePackAllocationChanges.orgId, args.orgId),
        ),
      )
      .for("update")
      .limit(1);
    if (!change) {
      return { status: "not_found" as const };
    }
    if (change.status === "applying") {
      return { status: "resuming" as const, change };
    }
    const existing = existingConfirmationResponse(change);
    if (existing) {
      return { status: "existing" as const, response: existing };
    }
    if (change.status === "failed") {
      return { status: "conflict" as const };
    }
    if (!change.previewExpiresAt || change.previewExpiresAt <= at) {
      await tx
        .update(usagePackAllocationChanges)
        .set({
          status: "failed",
          failureReason: "preview_expired",
          completedAt: at,
          updatedAt: at,
        })
        .where(eq(usagePackAllocationChanges.id, change.id));
      return { status: "expired" as const };
    }
    if (!change.sourceAllocationId) {
      throw new Error(`Usage pack change ${change.id} has no source`);
    }
    const [source] = await tx
      .select()
      .from(usagePackAllocations)
      .where(eq(usagePackAllocations.id, change.sourceAllocationId))
      .for("update")
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
        .where(eq(usagePackAllocationChanges.id, change.id));
      return { status: "conflict" as const };
    }
    const [prepared] = await tx
      .update(usagePackAllocationChanges)
      .set({ status: "applying", updatedAt: at })
      .where(
        and(
          eq(usagePackAllocationChanges.id, change.id),
          eq(usagePackAllocationChanges.status, "previewed"),
        ),
      )
      .returning();
    return prepared
      ? { status: "ready" as const, change: prepared }
      : { status: "conflict" as const };
  });
}

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
  },
  signal: AbortSignal,
): Promise<UsagePackChangeConfirmResult> {
  const prepared = await prepareUsagePackChangeConfirmation(db, args);
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
