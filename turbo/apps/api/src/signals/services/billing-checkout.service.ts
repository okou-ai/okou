import { compatibleGoogleAdsAttribution } from "@okouai/core/google-ads-attribution";
import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import type {
  ConcurrencySubscriptionChangePreviewResponse,
  BillingPurchaseConfirmResponse,
  CreditPurchaseConfirmResponse,
  CreditPurchasePreviewResponse,
  PlanPurchasePreviewResponse,
  UsagePackUsd,
} from "@okouai/api-contracts/contracts/billing";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { db$, writeDb$, type Db, type ReadonlyDb } from "../external/db";
import {
  getStripeClient,
  listAllStripeSubscriptions,
  type StripeClient,
  type StripeCheckoutSessionCreateParams,
  type StripeInvoice,
  type StripeMetadataParam,
  type StripeSubscription,
} from "../external/stripe-client";
import { getOrCreateStripeCustomer$ } from "./billing-customer.service";
import { persistOrgAcquisitionAttribution$ } from "./acquisition-attribution.service";
import {
  impactStripeMetadata$,
  readOrgImpactMetadata,
} from "./impact-attribution.service";
import {
  addStripeConcurrencySubscriptionItem$,
  previewStripeConcurrencySubscriptionChange$,
} from "./billing-concurrency-subscription.service";
import { stripePreviewMetadata } from "./stripe-preview-metadata.service";
import {
  completeBillingOperationInvoice,
  completeBillingOperationInvoiceWithInvoice,
} from "./billing-operation-invoice.service";
import { lockBillingPurchaseOrg } from "./billing-purchase-lock.service";
import {
  createBillingPreviewToken,
  parseBillingPreviewToken,
} from "./billing-purchase-preview-token.service";
import {
  resolveBillingPurchaseRoute,
  stripeBillingPurchasePaymentParams,
  type BillingPurchasePaymentMethod,
} from "./billing-payment-method.service";

interface CreateCheckoutSessionArgs {
  readonly orgId: string;
  readonly tier: SubscriptionCheckoutTier;
  readonly priceId: string;
  readonly trialDays?: 7;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly adAttribution?: Readonly<Record<string, string | undefined>>;
  readonly checkoutIdempotencyKey?: string;
}

interface StartPlanPurchaseArgs extends CreateCheckoutSessionArgs {
  readonly supportsInAppPreview: boolean;
  readonly subscriptionId: string | null;
}

type StartPlanPurchaseResult =
  | { readonly status: "checkout"; readonly url: string }
  | {
      readonly status: "preview";
      readonly preview: PlanPurchasePreviewResponse;
    };

type ConfirmPlanPurchaseResult =
  | {
      readonly status: "confirmed";
      readonly response: BillingPurchaseConfirmResponse;
      readonly paidInvoice: StripeInvoice | null;
    }
  | { readonly status: "invalid_preview" };

type WriteTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

interface CompleteCheckoutSessionArgs {
  readonly orgId: string;
  readonly sessionId: string;
}

type CheckoutCompletionResult =
  | {
      readonly status: "completed";
      readonly paidInvoice: StripeInvoice | null;
    }
  | {
      readonly status: "paid_invoice_ready";
      readonly paidInvoice: StripeInvoice;
    }
  | { readonly status: "pending" }
  | { readonly status: "customer_mismatch" }
  | {
      readonly status: "tier_conflict";
      readonly currentTier: string | null;
      readonly targetTier: SubscriptionCheckoutTier;
    };

interface CreateCreditCheckoutSessionArgs {
  readonly orgId: string;
  readonly credits: number;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly checkoutIdempotencyKey?: string;
}

interface PreviewExistingBillingCreditPurchaseArgs {
  readonly orgId: string;
  readonly credits: number;
  readonly successUrl: string;
  readonly cancelUrl: string;
}

type ConfirmExistingBillingCreditPurchaseResult =
  | {
      readonly status: "confirmed";
      readonly response: CreditPurchaseConfirmResponse;
    }
  | { readonly status: "invalid_preview" }
  | { readonly status: "billing_unavailable" };

interface StartConcurrencyPurchaseArgs {
  readonly orgId: string;
  readonly quantity: number;
  readonly priceId: string;
  readonly hasScheduledConcurrencyChange: boolean;
  readonly successUrl: string;
  readonly paymentMethod?: BillingPurchasePaymentMethod;
}

type StartConcurrencyPurchaseResult =
  | { readonly ok: true; readonly url: string }
  | {
      readonly ok: false;
      readonly reason:
        | "invalid_quantity"
        | "missing_plan_subscription"
        | "pending_update"
        | "plan_ending";
    };

type PreviewInitialConcurrencyPurchaseResult =
  | {
      readonly ok: true;
      readonly preview: ConcurrencySubscriptionChangePreviewResponse;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "invalid_quantity"
        | "missing_plan_subscription"
        | "not_found"
        | "canceling"
        | "no_change"
        | "pending_update"
        | "plan_ending";
    };

const CREDITS_PER_DOLLAR = 1000;
const CREDIT_PURCHASE_PREVIEW_TTL_MS = 15 * 60 * 1000;
const CREDIT_PURCHASE_PREVIEW_LINE_METADATA_KEY = "credit_purchase_preview_id";
const STRIPE_SUBSCRIPTION_PRICE_TIERS = ["pro", "team"] as const;
export type SubscriptionCheckoutTier =
  (typeof STRIPE_SUBSCRIPTION_PRICE_TIERS)[number];
export type BillingSubscriptionTier = SubscriptionCheckoutTier | "custom";

export async function orgPlanSubscriptionId(
  db: ReadonlyDb,
  orgId: string,
): Promise<string | null> {
  const [plan] = await db
    .select({
      stripeSubscriptionId: orgPlanEntitlements.stripeSubscriptionId,
    })
    .from(orgPlanEntitlements)
    .where(eq(orgPlanEntitlements.orgId, orgId))
    .limit(1);
  return plan?.stripeSubscriptionId ?? null;
}

const creditPurchasePreviewTokenSchema = z.object({
  version: z.literal(1),
  purchaseId: z.uuid(),
  orgId: z.string().min(1),
  customerId: z.string().min(1),
  paymentMethodId: z.string().min(1),
  couponId: z.string().min(1).nullable(),
  priceId: z.string().min(1),
  quantity: z.number().int().positive(),
  credits: z.number().int().positive(),
  amountCents: z.number().int().nonnegative(),
  impactMetadata: z.record(z.string(), z.string()).optional(),
  currency: z.string().length(3),
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
  expiresAt: z.iso.datetime(),
});

const planPurchasePreviewTokenSchema = z.object({
  version: z.literal(1),
  purchaseId: z.uuid(),
  orgId: z.string().min(1),
  customerId: z.string().min(1),
  sourceSubscriptionId: z.string().min(1).nullable(),
  paymentMethodId: z.string().min(1),
  tier: z.enum(STRIPE_SUBSCRIPTION_PRICE_TIERS),
  priceId: z.string().min(1),
  trialDays: z.literal(7).optional(),
  immediateAmountCents: z.number().int().nonnegative(),
  nextRecurringAmountCents: z.number().int().nonnegative(),
  currency: z.string().length(3),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
  adAttribution: z.record(z.string(), z.string()).optional(),
  expiresAt: z.iso.datetime(),
});

type PlanPurchasePreviewToken = z.infer<typeof planPurchasePreviewTokenSchema>;

type CreditPurchasePreviewToken = z.infer<
  typeof creditPurchasePreviewTokenSchema
>;

function legacyPriceIdsForTier(
  tier: SubscriptionCheckoutTier,
): readonly string[] | undefined {
  switch (tier) {
    case "pro": {
      return env("OKOU_PRICE_PRO");
    }
    case "team": {
      return env("OKOU_PRICE_TEAM");
    }
  }
}

function usagePackPlanPriceIdsForTier(
  tier: SubscriptionCheckoutTier,
): readonly string[] | undefined {
  switch (tier) {
    case "pro": {
      return env("OKOU_PRICE_USAGE_PACK_PLAN_PRO");
    }
    case "team": {
      return env("OKOU_PRICE_USAGE_PACK_PLAN_TEAM");
    }
  }
}

function knownPriceIdsForTier(
  tier: SubscriptionCheckoutTier,
): readonly string[] {
  return [
    ...(legacyPriceIdsForTier(tier) ?? []),
    ...(usagePackPlanPriceIdsForTier(tier) ?? []),
  ];
}

/** Returns the active (first) price ID for a given tier. */
export function activePriceId(
  tier: SubscriptionCheckoutTier,
): string | undefined {
  return legacyPriceIdsForTier(tier)?.[0];
}

export function activeUsagePackPlanPriceId(
  tier: SubscriptionCheckoutTier,
): string | undefined {
  return usagePackPlanPriceIdsForTier(tier)?.[0];
}

function usagePackPriceIds(usagePackUsd: UsagePackUsd): readonly string[] {
  switch (usagePackUsd) {
    case 20: {
      return env("OKOU_PRICE_USAGE_PACK_20") ?? [];
    }
    case 50: {
      return env("OKOU_PRICE_USAGE_PACK_50") ?? [];
    }
    case 100: {
      return env("OKOU_PRICE_USAGE_PACK_100") ?? [];
    }
    case 200: {
      return env("OKOU_PRICE_USAGE_PACK_200") ?? [];
    }
  }
}

export function activeUsagePackPriceId(
  usagePackUsd: UsagePackUsd,
): string | undefined {
  return usagePackPriceIds(usagePackUsd)[0];
}

export function usagePackUsdForKnownPriceId(
  priceId: string,
): UsagePackUsd | null {
  for (const usagePackUsd of [20, 50, 100, 200] as const) {
    if (usagePackPriceIds(usagePackUsd).includes(priceId)) {
      return usagePackUsd;
    }
  }
  return null;
}

export function isUsagePackPlanPriceId(priceId: string): boolean {
  return STRIPE_SUBSCRIPTION_PRICE_TIERS.some((tier) => {
    return usagePackPlanPriceIdsForTier(tier)?.includes(priceId) ?? false;
  });
}

export function tierForKnownPriceId(
  priceId: string,
): SubscriptionCheckoutTier | null {
  for (const tier of STRIPE_SUBSCRIPTION_PRICE_TIERS) {
    if (knownPriceIdsForTier(tier).includes(priceId)) {
      return tier;
    }
  }
  return null;
}

interface PlanPriceItem {
  readonly price: { readonly id: string };
}

interface BillingPlanPriceItem {
  readonly price: { readonly id: string };
}

export function tierForKnownPlanPrice(
  price: BillingPlanPriceItem["price"],
): BillingSubscriptionTier | null {
  const checkoutTier = tierForKnownPriceId(price.id);
  if (checkoutTier) {
    return checkoutTier;
  }
  return env("OKOU_PRICE_CUSTOM")?.includes(price.id) ? "custom" : null;
}

export function knownBillingPlanPriceItem<
  T extends { readonly price?: { readonly id?: string } },
>(items: readonly T[]): (T & BillingPlanPriceItem) | undefined {
  return items.find((item): item is T & BillingPlanPriceItem => {
    return (
      typeof item.price?.id === "string" &&
      tierForKnownPlanPrice({ id: item.price.id }) !== null
    );
  });
}

export function knownPlanPriceItem<T extends PlanPriceItem>(
  items: readonly T[],
): T | undefined {
  return items.find((item) => {
    return tierForKnownPriceId(item.price.id) !== null;
  });
}

function tierFromPriceId(priceId: string): SubscriptionCheckoutTier {
  const tier = tierForKnownPriceId(priceId);
  if (tier) {
    return tier;
  }
  throw new Error(`Unknown Stripe price ID: ${priceId}`);
}

function billingTierRank(tier: string | null | undefined): number {
  switch (tier) {
    case "custom": {
      return 3;
    }
    case "team": {
      return 2;
    }
    case "pro": {
      return 1;
    }
    case "free":
    case "limited-free-1":
    case "pro-suspend":
    default: {
      return 0;
    }
  }
}

function billingTierLabel(tier: string | null | undefined): string {
  switch (tier) {
    case "custom": {
      return "Custom";
    }
    case "team": {
      return "Team";
    }
    case "pro": {
      return "Pro";
    }
    case "free": {
      return "Free";
    }
    case "limited-free-1": {
      return "Limited free";
    }
    case "pro-suspend": {
      return "Pro suspended";
    }
    default: {
      return tier ?? "Pro suspended";
    }
  }
}

export function checkoutWouldReplaceWithSameOrLowerTier(args: {
  readonly currentTier: string | null | undefined;
  readonly targetTier: BillingSubscriptionTier;
}): boolean {
  return billingTierRank(args.currentTier) >= billingTierRank(args.targetTier);
}

export function checkoutTierConflictMessage(args: {
  readonly currentTier: string | null | undefined;
  readonly targetTier: BillingSubscriptionTier;
}): string {
  return `Cannot create ${billingTierLabel(args.targetTier)} checkout while current tier is ${billingTierLabel(args.currentTier)}; use billing management to change plans`;
}

export function activeCustomCreditUnitPriceId(): string | undefined {
  return env("OKOU_PRICE_CUSTOM_CREDIT_UNIT");
}

function createCreditPurchasePreviewToken(
  payload: CreditPurchasePreviewToken,
): string {
  return createBillingPreviewToken(payload);
}

function parseCreditPurchasePreviewToken(
  token: string,
): CreditPurchasePreviewToken | null {
  return parseBillingPreviewToken(token, creditPurchasePreviewTokenSchema);
}

function createPlanPurchasePreviewToken(
  payload: PlanPurchasePreviewToken,
): string {
  return createBillingPreviewToken(payload);
}

function parsePlanPurchasePreviewToken(
  token: string,
): PlanPurchasePreviewToken | null {
  return parseBillingPreviewToken(token, planPurchasePreviewTokenSchema);
}

interface ExistingCreditBilling {
  readonly customerId: string;
  readonly subscriptionId: string | null;
}

async function existingCreditBilling(
  orgId: string,
  db: ReadonlyDb,
): Promise<ExistingCreditBilling | null> {
  const [org] = await db
    .select({
      customerId: orgMetadata.stripeCustomerId,
      subscriptionId: orgMetadata.stripeSubscriptionId,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  if (!org?.customerId) {
    return null;
  }
  return {
    customerId: org.customerId,
    subscriptionId: org.subscriptionId,
  };
}

async function existingCreditCouponId(
  stripe: StripeClient,
  customerId: string,
  signal: AbortSignal,
): Promise<string | null> {
  const customer = await stripe.customers.retrieve(customerId);
  signal.throwIfAborted();
  if ("deleted" in customer && customer.deleted) {
    return null;
  }
  return stripeObjectId(customer.discount?.source.coupon);
}

function assertCreditPurchasePreviewLine(
  invoice: StripeInvoice,
  purchaseId: string,
): void {
  const hasLine = invoice.lines.data.some((candidate) => {
    return (
      candidate.metadata?.[CREDIT_PURCHASE_PREVIEW_LINE_METADATA_KEY] ===
      purchaseId
    );
  });
  if (!hasLine) {
    throw new Error("Stripe credit purchase preview is missing its line item");
  }
}

function creditPurchasePayableAmount(invoice: StripeInvoice): number {
  const amount = invoice.amount_due;
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error("Stripe credit purchase invoice has an invalid amount");
  }
  return amount;
}

export const previewExistingBillingCreditPurchase$ = command(
  async (
    { get, set },
    args: PreviewExistingBillingCreditPurchaseArgs,
    signal: AbortSignal,
  ): Promise<CreditPurchasePreviewResponse | null> => {
    const billing = await existingCreditBilling(args.orgId, get(db$));
    signal.throwIfAborted();
    if (!billing) {
      return null;
    }

    const stripe = getStripeClient();
    const route = await resolveBillingPurchaseRoute(
      {
        stripe,
        supportsInAppPreview: true,
        customerId: billing.customerId,
        subscriptionId: billing.subscriptionId,
      },
      signal,
    );
    if (route.kind === "checkout") {
      return null;
    }
    const couponId = await existingCreditCouponId(
      stripe,
      billing.customerId,
      signal,
    );

    const priceId = activeCustomCreditUnitPriceId();
    if (!priceId) {
      throw new Error("Custom credit price not configured");
    }
    const quantity = Math.ceil(args.credits / CREDITS_PER_DOLLAR);
    const credits = quantity * CREDITS_PER_DOLLAR;
    const purchaseId = randomUUID();
    const invoice = await stripe.invoices.createPreview({
      // Keep this preview independent from the customer's active subscription.
      // Passing the subscribed customer would make `next` include renewal lines,
      // while confirmation creates a standalone invoice for this credit item.
      preview_mode: "next",
      discounts: couponId ? [{ coupon: couponId }] : "",
      invoice_items: [
        {
          price: priceId,
          quantity,
          metadata: {
            [CREDIT_PURCHASE_PREVIEW_LINE_METADATA_KEY]: purchaseId,
          },
        },
      ],
    });
    signal.throwIfAborted();
    if (invoice.currency.length !== 3) {
      throw new Error("Stripe credit purchase preview has an invalid currency");
    }
    assertCreditPurchasePreviewLine(invoice, purchaseId);
    const amountCents = creditPurchasePayableAmount(invoice);
    const expiresAt = new Date(
      nowDate().getTime() + CREDIT_PURCHASE_PREVIEW_TTL_MS,
    ).toISOString();
    const payload: CreditPurchasePreviewToken = {
      version: 1,
      purchaseId,
      orgId: args.orgId,
      customerId: route.customerId,
      paymentMethodId: route.paymentMethodId,
      couponId,
      priceId,
      quantity,
      credits,
      amountCents,
      impactMetadata: await set(impactStripeMetadata$, args.orgId, signal),
      currency: invoice.currency,
      successUrl: args.successUrl,
      cancelUrl: args.cancelUrl,
      expiresAt,
    };
    return {
      status: "preview",
      credits,
      amountCents,
      currency: invoice.currency,
      expiresAt,
      previewToken: createCreditPurchasePreviewToken(payload),
    };
  },
);

async function finalizeCreditPurchaseInvoice(
  stripe: StripeClient,
  invoice: StripeInvoice,
  purchaseId: string,
  signal: AbortSignal,
): Promise<StripeInvoice> {
  if (invoice.status !== "draft") {
    return invoice;
  }
  const finalized = await stripe.invoices.finalizeInvoice(
    invoice.id,
    {},
    { idempotencyKey: `credit-purchase:${purchaseId}:finalize` },
  );
  signal.throwIfAborted();
  return finalized;
}

async function discardChangedCreditPurchaseInvoice(
  stripe: StripeClient,
  invoice: StripeInvoice,
  purchaseId: string,
  signal: AbortSignal,
): Promise<void> {
  if (invoice.status === "draft") {
    await stripe.invoices.del(
      invoice.id,
      {},
      { idempotencyKey: `credit-purchase:${purchaseId}:delete` },
    );
    signal.throwIfAborted();
    return;
  }
  if (invoice.status === "open" || invoice.status === "uncollectible") {
    await stripe.invoices.voidInvoice(
      invoice.id,
      {},
      { idempotencyKey: `credit-purchase:${purchaseId}:void` },
    );
    signal.throwIfAborted();
    return;
  }
  if (invoice.status !== "void") {
    throw new Error("Changed credit purchase invoice could not be discarded");
  }
}

export const confirmExistingBillingCreditPurchase$ = command(
  async (
    { get, set },
    orgId: string,
    previewToken: string,
    signal: AbortSignal,
  ): Promise<ConfirmExistingBillingCreditPurchaseResult> => {
    const preview = parseCreditPurchasePreviewToken(previewToken);
    if (
      !preview ||
      preview.orgId !== orgId ||
      new Date(preview.expiresAt) <= nowDate() ||
      preview.priceId !== activeCustomCreditUnitPriceId()
    ) {
      return { status: "invalid_preview" };
    }

    const billing = await existingCreditBilling(orgId, get(db$));
    signal.throwIfAborted();
    if (!billing || billing.customerId !== preview.customerId) {
      return { status: "billing_unavailable" };
    }
    const stripe = getStripeClient();
    const route = await resolveBillingPurchaseRoute(
      {
        stripe,
        supportsInAppPreview: true,
        customerId: billing.customerId,
        subscriptionId: billing.subscriptionId,
      },
      signal,
    );
    if (route.kind === "checkout") {
      if (!preview.successUrl || !preview.cancelUrl) {
        return { status: "billing_unavailable" };
      }
      const checkoutUrl = await set(
        createCreditCheckoutSession$,
        {
          orgId,
          credits: preview.credits,
          successUrl: preview.successUrl,
          cancelUrl: preview.cancelUrl,
          checkoutIdempotencyKey: `credit-purchase:${preview.purchaseId}:checkout`,
        },
        signal,
      );
      return {
        status: "confirmed",
        response: { status: "checkout_required", checkoutUrl },
      };
    }
    if (
      route.customerId !== preview.customerId ||
      route.paymentMethodId !== preview.paymentMethodId
    ) {
      return { status: "invalid_preview" };
    }

    const metadata: StripeMetadataParam = {
      purpose: "credit_purchase",
      type: "credit_purchase",
      orgId,
      creditsAmountMode: "amount_subtotal",
      requestedCreditsAmount: String(preview.credits),
      creditPurchaseId: preview.purchaseId,
      ...preview.impactMetadata,
      ...stripePreviewMetadata(),
    };
    const invoice = await stripe.invoices.create(
      {
        customer: preview.customerId,
        auto_advance: false,
        ...stripeBillingPurchasePaymentParams(route),
        discounts: preview.couponId ? [{ coupon: preview.couponId }] : "",
        metadata,
      },
      { idempotencyKey: `credit-purchase:${preview.purchaseId}:invoice` },
    );
    signal.throwIfAborted();
    await stripe.invoiceItems.create(
      {
        invoice: invoice.id,
        customer: preview.customerId,
        pricing: { price: preview.priceId },
        quantity: preview.quantity,
        description: `Credit top-up: ${preview.credits.toLocaleString()} credits`,
        metadata: {
          [CREDIT_PURCHASE_PREVIEW_LINE_METADATA_KEY]: preview.purchaseId,
        },
      },
      { idempotencyKey: `credit-purchase:${preview.purchaseId}:invoice-item` },
    );
    signal.throwIfAborted();
    const draftInvoice = await stripe.invoices.retrieve(invoice.id);
    signal.throwIfAborted();
    assertCreditPurchasePreviewLine(draftInvoice, preview.purchaseId);
    const confirmedInvoice = await finalizeCreditPurchaseInvoice(
      stripe,
      draftInvoice,
      preview.purchaseId,
      signal,
    );
    const confirmedAmountCents = creditPurchasePayableAmount(confirmedInvoice);
    // Customer balance can settle the invoice during finalization. A paid
    // invoice is irreversible and its webhook already owns the credit grant.
    if (
      confirmedInvoice.status !== "paid" &&
      (confirmedInvoice.currency !== preview.currency ||
        confirmedAmountCents !== preview.amountCents)
    ) {
      await discardChangedCreditPurchaseInvoice(
        stripe,
        confirmedInvoice,
        preview.purchaseId,
        signal,
      );
      return { status: "invalid_preview" };
    }
    return {
      status: "confirmed",
      response: await completeBillingOperationInvoice(
        stripe,
        confirmedInvoice,
        `credit:${preview.purchaseId}`,
        signal,
        { payOpenInvoice: true },
      ),
    };
  },
);

function checkoutSessionMetadata(args: {
  readonly orgId: string;
  readonly tier: SubscriptionCheckoutTier;
  readonly priceId: string;
  readonly adAttribution:
    | Readonly<Record<string, string | undefined>>
    | undefined;
}): Record<string, string> {
  const metadata: Record<string, string> = {
    orgId: args.orgId,
    tier: args.tier,
    priceId: args.priceId,
  };
  for (const [key, value] of Object.entries(
    compatibleGoogleAdsAttribution(args.adAttribution ?? {}),
  )) {
    if (value) {
      metadata[key] = value;
    }
  }
  Object.assign(metadata, stripePreviewMetadata());
  return metadata;
}

function stripeObjectId(
  value: string | { readonly id: string } | null | undefined,
): string | null {
  if (typeof value === "string") {
    return value;
  }
  return value?.id ?? null;
}

function subscriptionWillCancel(subscription: StripeSubscription): boolean {
  return subscription.cancel_at_period_end || subscription.cancel_at !== null;
}

function definedAttribution(
  attribution: Readonly<Record<string, string | undefined>> | undefined,
): Record<string, string> | undefined {
  const entries = Object.entries(
    compatibleGoogleAdsAttribution(attribution ?? {}),
  ).filter((entry): entry is [string, string] => {
    return entry[1] !== undefined;
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function expandedLatestInvoice(
  subscription: StripeSubscription,
): StripeInvoice | null {
  return subscription.latest_invoice &&
    typeof subscription.latest_invoice !== "string"
    ? subscription.latest_invoice
    : null;
}

async function planPurchaseSubscriptionState(
  args: {
    readonly stripe: StripeClient;
    readonly orgId: string;
    readonly customerId: string;
    readonly purchaseId: string;
    readonly sourceSubscriptionId: string | null;
    readonly targetTier: SubscriptionCheckoutTier;
    readonly targetPriceId: string;
    readonly immediateAmountCents: number;
    readonly currency: string;
  },
  signal: AbortSignal,
): Promise<{
  readonly existing: StripeSubscription | null;
  readonly hasCompetingPurchase: boolean;
}> {
  const subscriptions = await listAllStripeSubscriptions(
    args.stripe,
    { customer: args.customerId, status: "all" },
    signal,
  );
  const exactPurchase = subscriptions.find((subscription) => {
    return subscription.metadata?.billingPurchaseId === args.purchaseId;
  });
  const resumablePurchase = subscriptions.find((subscription) => {
    return (
      subscription.metadata?.orgId === args.orgId &&
      subscription.metadata.billingPurchaseId !== undefined &&
      knownPlanPriceItem(subscription.items.data)?.price.id ===
        args.targetPriceId &&
      subscription.status === "incomplete"
    );
  });
  const existingSummary = exactPurchase ?? resumablePurchase;
  const hasCompetingPurchase = subscriptions.some((subscription) => {
    const tier = tierForKnownPriceId(
      knownPlanPriceItem(subscription.items.data)?.price.id ?? "",
    );
    const isReplaceableActivePlan =
      tier !== null &&
      (subscription.status === "active" ||
        subscription.status === "trialing") &&
      !checkoutWouldReplaceWithSameOrLowerTier({
        currentTier: tier,
        targetTier: args.targetTier,
      });
    return (
      subscription.id !== args.sourceSubscriptionId &&
      subscription.id !== existingSummary?.id &&
      subscription.metadata?.orgId === args.orgId &&
      tier !== null &&
      !isReplaceableActivePlan &&
      subscription.status !== "canceled" &&
      subscription.status !== "incomplete_expired"
    );
  });
  if (!existingSummary) {
    return { existing: null, hasCompetingPurchase };
  }
  const existing = await args.stripe.subscriptions.retrieve(
    existingSummary.id,
    { expand: ["latest_invoice"] },
  );
  signal.throwIfAborted();
  const invoice = expandedLatestInvoice(existing);
  if (
    existingSummary !== exactPurchase &&
    (!invoice ||
      invoice.amount_due !== args.immediateAmountCents ||
      invoice.currency !== args.currency)
  ) {
    return { existing: null, hasCompetingPurchase: true };
  }
  return { existing, hasCompetingPurchase };
}

export const startPlanPurchase$ = command(
  async (
    { set },
    args: StartPlanPurchaseArgs,
    signal: AbortSignal,
  ): Promise<StartPlanPurchaseResult> => {
    if (!args.supportsInAppPreview) {
      return {
        status: "checkout",
        url: await set(createCheckoutSession$, args, signal),
      };
    }

    await set(
      persistOrgAcquisitionAttribution$,
      { orgId: args.orgId, attribution: args.adAttribution },
      signal,
    );
    const customerId = await set(
      getOrCreateStripeCustomer$,
      { orgId: args.orgId, metadata: args.adAttribution },
      signal,
    );
    signal.throwIfAborted();
    const stripe = getStripeClient();
    const route = await resolveBillingPurchaseRoute(
      {
        stripe,
        supportsInAppPreview: true,
        customerId,
        subscriptionId: args.subscriptionId,
      },
      signal,
    );
    if (route.kind === "checkout") {
      return {
        status: "checkout",
        url: await set(createCheckoutSession$, args, signal),
      };
    }

    const invoice = await stripe.invoices.createPreview({
      customer: route.customerId,
      preview_mode: "next",
      subscription_details: {
        items: [{ price: args.priceId, quantity: 1 }],
      },
    });
    signal.throwIfAborted();
    const nextRecurringAmountCents = creditPurchasePayableAmount(invoice);
    if (invoice.currency.length !== 3) {
      throw new Error("Stripe Plan purchase preview has an invalid currency");
    }
    const purchaseId = randomUUID();
    const expiresAt = new Date(
      nowDate().getTime() + CREDIT_PURCHASE_PREVIEW_TTL_MS,
    ).toISOString();
    const token: PlanPurchasePreviewToken = {
      version: 1,
      purchaseId,
      orgId: args.orgId,
      customerId: route.customerId,
      sourceSubscriptionId: args.subscriptionId,
      paymentMethodId: route.paymentMethodId,
      tier: args.tier,
      priceId: args.priceId,
      ...(args.trialDays === undefined ? {} : { trialDays: args.trialDays }),
      immediateAmountCents:
        args.trialDays === undefined ? nextRecurringAmountCents : 0,
      nextRecurringAmountCents,
      currency: invoice.currency,
      successUrl: args.successUrl,
      cancelUrl: args.cancelUrl,
      ...(definedAttribution(args.adAttribution) === undefined
        ? {}
        : { adAttribution: definedAttribution(args.adAttribution) }),
      expiresAt,
    };
    return {
      status: "preview",
      preview: {
        status: "preview",
        purchaseType: "plan",
        tier: args.tier,
        immediateAmountCents: token.immediateAmountCents,
        nextRecurringAmountCents,
        currency: invoice.currency,
        expiresAt,
        previewToken: createPlanPurchasePreviewToken(token),
        ...(args.trialDays === undefined ? {} : { trialDays: args.trialDays }),
      },
    };
  },
);

async function createConfirmedPlanSubscription(
  args: {
    readonly stripe: StripeClient;
    readonly orgId: string;
    readonly preview: PlanPurchasePreviewToken;
    readonly paymentMethod: BillingPurchasePaymentMethod;
  },
  signal: AbortSignal,
): Promise<ConfirmPlanPurchaseResult> {
  const { stripe, orgId, preview, paymentMethod } = args;
  const currentPreview = await stripe.invoices.createPreview({
    customer: preview.customerId,
    preview_mode: "next",
    subscription_details: {
      items: [{ price: preview.priceId, quantity: 1 }],
    },
  });
  signal.throwIfAborted();
  const nextRecurringAmountCents = creditPurchasePayableAmount(currentPreview);
  if (
    currentPreview.currency !== preview.currency ||
    nextRecurringAmountCents !== preview.nextRecurringAmountCents ||
    (preview.trialDays === undefined ? nextRecurringAmountCents : 0) !==
      preview.immediateAmountCents
  ) {
    return { status: "invalid_preview" };
  }

  const metadata: StripeMetadataParam = {
    ...checkoutSessionMetadata({
      orgId,
      tier: preview.tier,
      priceId: preview.priceId,
      adAttribution: preview.adAttribution,
    }),
    billingPurchaseId: preview.purchaseId,
  };
  const subscription = await stripe.subscriptions.create(
    {
      customer: preview.customerId,
      items: [{ price: preview.priceId, quantity: 1 }],
      ...stripeBillingPurchasePaymentParams(paymentMethod),
      metadata,
      payment_behavior: "default_incomplete",
      ...(preview.trialDays === undefined
        ? {}
        : { trial_period_days: preview.trialDays }),
      expand: ["latest_invoice"],
    },
    { idempotencyKey: `plan-purchase:${preview.purchaseId}:subscription` },
  );
  signal.throwIfAborted();
  const completion = await completeBillingOperationInvoiceWithInvoice(
    stripe,
    expandedLatestInvoice(subscription),
    `plan:${preview.purchaseId}`,
    signal,
    { payOpenInvoice: true },
  );
  return {
    status: "confirmed",
    ...completion,
  };
}

async function completeExistingPlanPurchase(
  stripe: StripeClient,
  preview: PlanPurchasePreviewToken,
  subscription: StripeSubscription,
  signal: AbortSignal,
): Promise<ConfirmPlanPurchaseResult> {
  const invoice = expandedLatestInvoice(subscription);
  if (invoice && invoice.status !== "paid") {
    const route = await resolveBillingPurchaseRoute(
      {
        stripe,
        supportsInAppPreview: true,
        customerId: preview.customerId,
        subscriptionId: subscription.id,
        subscription,
      },
      signal,
    );
    if (
      route.kind === "checkout" ||
      route.customerId !== preview.customerId ||
      route.paymentMethodId !== preview.paymentMethodId
    ) {
      return { status: "invalid_preview" };
    }
  }
  const completion = await completeBillingOperationInvoiceWithInvoice(
    stripe,
    invoice,
    `plan:${preview.purchaseId}`,
    signal,
    { payOpenInvoice: true },
  );
  return {
    status: "confirmed",
    ...completion,
  };
}

async function confirmPlanPurchaseTransaction(
  args: {
    readonly tx: WriteTx;
    readonly orgId: string;
    readonly preview: PlanPurchasePreviewToken;
  },
  signal: AbortSignal,
): Promise<ConfirmPlanPurchaseResult> {
  const { tx, orgId, preview } = args;
  await lockBillingPurchaseOrg(tx, orgId);
  signal.throwIfAborted();
  const stripe = getStripeClient();
  const subscriptionState = await planPurchaseSubscriptionState(
    {
      stripe,
      orgId,
      customerId: preview.customerId,
      purchaseId: preview.purchaseId,
      sourceSubscriptionId: preview.sourceSubscriptionId,
      targetTier: preview.tier,
      targetPriceId: preview.priceId,
      immediateAmountCents: preview.immediateAmountCents,
      currency: preview.currency,
    },
    signal,
  );
  if (subscriptionState.existing) {
    return await completeExistingPlanPurchase(
      stripe,
      preview,
      subscriptionState.existing,
      signal,
    );
  }

  const [org] = await tx
    .select({
      customerId: orgMetadata.stripeCustomerId,
      subscriptionId: orgMetadata.stripeSubscriptionId,
      tier: orgMetadata.tier,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .for("update")
    .limit(1);
  signal.throwIfAborted();
  if (
    !org ||
    org.customerId !== preview.customerId ||
    org.subscriptionId !== preview.sourceSubscriptionId ||
    checkoutWouldReplaceWithSameOrLowerTier({
      currentTier: org.tier,
      targetTier: preview.tier,
    }) ||
    subscriptionState.hasCompetingPurchase
  ) {
    return { status: "invalid_preview" };
  }

  const route = await resolveBillingPurchaseRoute(
    {
      stripe,
      supportsInAppPreview: true,
      customerId: preview.customerId,
      subscriptionId: preview.sourceSubscriptionId,
    },
    signal,
  );
  if (route.kind === "checkout") {
    const url = await createPlanCheckoutSession(
      stripe,
      preview.customerId,
      {
        orgId,
        tier: preview.tier,
        priceId: preview.priceId,
        trialDays: preview.trialDays,
        successUrl: preview.successUrl,
        cancelUrl: preview.cancelUrl,
        adAttribution: preview.adAttribution,
        checkoutIdempotencyKey: `plan-purchase:${preview.purchaseId}:checkout`,
      },
      signal,
    );
    return {
      status: "confirmed",
      response: { status: "checkout_required", checkoutUrl: url },
      paidInvoice: null,
    };
  }
  if (
    route.customerId !== preview.customerId ||
    route.paymentMethodId !== preview.paymentMethodId
  ) {
    return { status: "invalid_preview" };
  }
  return await createConfirmedPlanSubscription(
    {
      stripe,
      orgId,
      preview,
      paymentMethod: route,
    },
    signal,
  );
}

export const confirmPlanPurchase$ = command(
  async (
    { set },
    orgId: string,
    previewToken: string,
    signal: AbortSignal,
  ): Promise<ConfirmPlanPurchaseResult> => {
    const preview = parsePlanPurchasePreviewToken(previewToken);
    if (
      !preview ||
      preview.orgId !== orgId ||
      new Date(preview.expiresAt) <= nowDate() ||
      preview.priceId !== activePriceId(preview.tier)
    ) {
      return { status: "invalid_preview" };
    }

    const db = set(writeDb$);
    return await db.transaction(async (tx) => {
      return await confirmPlanPurchaseTransaction(
        {
          tx,
          orgId,
          preview,
        },
        signal,
      );
    });
  },
);

/**
 * Create a Stripe Checkout session for subscription. Returns the
 * checkout session URL. Mirrors apps/web's createCheckoutSession
 * (allow_promotion_codes + subscription metadata orgId tag).
 */
async function createPlanCheckoutSession(
  stripe: StripeClient,
  customerId: string,
  args: CreateCheckoutSessionArgs,
  signal: AbortSignal,
): Promise<string> {
  const metadata = checkoutSessionMetadata({
    orgId: args.orgId,
    tier: args.tier,
    priceId: args.priceId,
    adAttribution: args.adAttribution,
  });
  const params: StripeCheckoutSessionCreateParams = {
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: args.priceId, quantity: 1 }],
    allow_promotion_codes: true,
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
    metadata,
    subscription_data: {
      metadata,
      ...(args.trialDays === undefined
        ? {}
        : { trial_period_days: args.trialDays }),
    },
  };
  const session = args.checkoutIdempotencyKey
    ? await stripe.checkout.sessions.create(params, {
        idempotencyKey: args.checkoutIdempotencyKey,
      })
    : await stripe.checkout.sessions.create(params);
  signal.throwIfAborted();
  if (!session.url) {
    throw new Error("Stripe checkout session did not return a URL");
  }
  return session.url;
}

const createCheckoutSession$ = command(
  async (
    { set },
    args: CreateCheckoutSessionArgs,
    signal: AbortSignal,
  ): Promise<string> => {
    await set(
      persistOrgAcquisitionAttribution$,
      { orgId: args.orgId, attribution: args.adAttribution },
      signal,
    );
    signal.throwIfAborted();

    const customerId = await set(
      getOrCreateStripeCustomer$,
      { orgId: args.orgId, metadata: args.adAttribution },
      signal,
    );
    signal.throwIfAborted();

    return await createPlanCheckoutSession(
      getStripeClient(),
      customerId,
      args,
      signal,
    );
  },
);

export const completeCheckoutSession$ = command(
  async (
    { set },
    args: CompleteCheckoutSessionArgs,
    signal: AbortSignal,
  ): Promise<CheckoutCompletionResult> => {
    const db = set(writeDb$);
    const [org] = await db
      .select({
        stripeCustomerId: orgMetadata.stripeCustomerId,
        stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
        tier: orgMetadata.tier,
      })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, args.orgId))
      .limit(1);
    signal.throwIfAborted();

    const stripe = getStripeClient();
    const session = await stripe.checkout.sessions.retrieve(args.sessionId);
    signal.throwIfAborted();

    const customerId = stripeObjectId(session.customer);
    if (!org || !customerId || customerId !== org.stripeCustomerId) {
      return { status: "customer_mismatch" };
    }

    if (session.status !== "complete" || session.mode !== "subscription") {
      return { status: "pending" };
    }

    const subscriptionId = stripeObjectId(session.subscription);
    if (!subscriptionId) {
      return { status: "pending" };
    }

    const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ["latest_invoice"],
    });
    signal.throwIfAborted();

    const priceId = knownPlanPriceItem(subscription.items.data)?.price.id;
    if (!priceId) {
      return { status: "pending" };
    }

    const tier = tierFromPriceId(priceId);
    if (
      org.stripeSubscriptionId !== subscription.id &&
      checkoutWouldReplaceWithSameOrLowerTier({
        currentTier: org.tier,
        targetTier: tier,
      })
    ) {
      return {
        status: "tier_conflict",
        currentTier: org.tier,
        targetTier: tier,
      };
    }
    const alreadyPaidSubscription =
      org.stripeSubscriptionId === subscription.id && org.tier === tier;

    await db
      .update(orgMetadata)
      .set({
        stripeSubscriptionId: subscription.id,
        subscriptionStatus: subscription.status,
        cancelAtPeriodEnd: subscriptionWillCancel(subscription),
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(orgMetadata.orgId, args.orgId),
          eq(orgMetadata.stripeCustomerId, customerId),
        ),
      );
    signal.throwIfAborted();

    const latestInvoice = expandedLatestInvoice(subscription);
    if (alreadyPaidSubscription) {
      return { status: "completed", paidInvoice: latestInvoice };
    }
    return latestInvoice?.status === "paid"
      ? { status: "paid_invoice_ready", paidInvoice: latestInvoice }
      : { status: "pending" };
  },
);

export const createCreditCheckoutSession$ = command(
  async (
    { set },
    args: CreateCreditCheckoutSessionArgs,
    signal: AbortSignal,
  ): Promise<string> => {
    const customerId = await set(
      getOrCreateStripeCustomer$,
      { orgId: args.orgId },
      signal,
    );
    signal.throwIfAborted();

    const stripe = getStripeClient();
    const customer = await stripe.customers.retrieve(customerId);
    signal.throwIfAborted();
    const customerCoupon =
      "discount" in customer ? customer.discount?.source.coupon : null;
    const customerCouponId =
      typeof customerCoupon === "string" ? customerCoupon : customerCoupon?.id;
    const baseMetadata = {
      purpose: "credit_purchase",
      orgId: args.orgId,
      ...(await readOrgImpactMetadata(set(writeDb$), args.orgId, signal)),
      ...stripePreviewMetadata(),
    };
    const customCreditUnitPriceId = activeCustomCreditUnitPriceId();
    if (!customCreditUnitPriceId) {
      throw new Error("Custom credit price not configured");
    }
    const unitQuantity = Math.ceil(args.credits / CREDITS_PER_DOLLAR);
    const metadata: StripeMetadataParam = {
      ...baseMetadata,
      creditsAmountMode: "amount_subtotal",
      requestedCreditsAmount: String(args.credits),
    };
    const params: StripeCheckoutSessionCreateParams = {
      mode: "payment",
      customer: customerId,
      line_items: [{ price: customCreditUnitPriceId, quantity: unitQuantity }],
      ...(customerCouponId
        ? { discounts: [{ coupon: customerCouponId }] }
        : { allow_promotion_codes: true }),
      invoice_creation: {
        enabled: true,
        invoice_data: {
          metadata: {
            type: "credit_purchase",
            ...metadata,
          },
        },
      },
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
      payment_intent_data: {
        setup_future_usage: "off_session",
        metadata: {
          type: "credit_purchase",
          ...metadata,
        },
      },
      metadata,
    };
    const session = args.checkoutIdempotencyKey
      ? await stripe.checkout.sessions.create(params, {
          idempotencyKey: args.checkoutIdempotencyKey,
        })
      : await stripe.checkout.sessions.create(params);
    signal.throwIfAborted();

    if (!session.url) {
      throw new Error("Stripe checkout session did not return a URL");
    }
    return session.url;
  },
);

export const previewInitialConcurrencyPurchase$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly priceId: string;
      readonly quantity: number;
    },
    signal: AbortSignal,
  ): Promise<PreviewInitialConcurrencyPurchaseResult> => {
    const subscriptionId = await orgPlanSubscriptionId(
      set(writeDb$),
      args.orgId,
    );
    signal.throwIfAborted();
    if (!subscriptionId) {
      return { ok: false, reason: "missing_plan_subscription" };
    }
    return await set(
      previewStripeConcurrencySubscriptionChange$,
      {
        orgId: args.orgId,
        subscriptionId,
        priceId: args.priceId,
        quantity: args.quantity,
        mode: "absolute",
        hasScheduledConcurrencyChange: false,
      },
      signal,
    );
  },
);

export const startConcurrencyPurchase$ = command(
  async (
    { set },
    args: StartConcurrencyPurchaseArgs,
    signal: AbortSignal,
  ): Promise<StartConcurrencyPurchaseResult> => {
    const subscriptionId = await orgPlanSubscriptionId(
      set(writeDb$),
      args.orgId,
    );
    signal.throwIfAborted();
    if (!subscriptionId) {
      return { ok: false, reason: "missing_plan_subscription" };
    }

    const result = await set(
      addStripeConcurrencySubscriptionItem$,
      {
        orgId: args.orgId,
        subscriptionId,
        priceId: args.priceId,
        quantity: args.quantity,
        paymentMethod: args.paymentMethod,
      },
      signal,
    );
    if (!result.ok) {
      return result;
    }
    return {
      ok: true,
      url:
        result.response.status === "pending_payment"
          ? result.response.hostedInvoiceUrl
          : args.successUrl,
    };
  },
);
