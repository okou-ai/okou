import {
  activationAllocationWhere,
  activationEntitlementValues,
  activationPendingCounts,
  activationUnchangedAllocationsWhere,
  activationOrgValues,
  activationRoot,
  activationRootsWhere,
  activationSubscriptionValues,
  type UsagePackPlanActivation,
} from "./usage-pack-plan-activation";
import {
  firstPaidUpgradeDebtWhere,
  fulfillmentAllocationWhere,
  fulfillmentPreparedWrites,
  fulfillmentReceiptCommitted,
  finalFulfillmentPendingCount,
  fulfillmentPlanEntitlement,
  fulfillmentProjection,
  fulfillmentRootSnapshot,
  fulfillmentRootsWhere,
  orgAcceptsSubscriptionWhere,
  requireFulfillmentAllocationSnapshot,
} from "./usage-pack-fulfillment-plan";
import {
  pendingOrgCreditExpirationQuery,
  requireNoPendingOrgCreditExpiration,
} from "./org-credit-expiration";
import { expireOrgCredits$ } from "./org-credit-expiration.service";
import type { EmptyUsagePackCancellation } from "./billing-downgrade.service";
import {
  type BillingPurchaseConfirmResponse,
  USAGE_PACKS_USD,
  type UsagePackCatalogItem,
  type UsagePackPurchasePreviewResponse,
  type UsagePackUsd,
} from "@okouai/api-contracts/contracts/billing";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import {
  usagePackAllocations,
  usagePackInvoiceFulfillments,
  usagePackPendingSnapshotGuards,
  usagePackSubscriptions,
} from "@okouai/db/schema/usage-pack-subscription";
import { command } from "ccstate";
import { z } from "zod";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notExists,
  notInArray,
  or,
} from "drizzle-orm";

import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import {
  getStripeClient,
  listAllStripeSubscriptions,
  type StripeClient,
  type StripeInvoice,
  type StripeMetadataParam,
  type StripePrice,
  type StripeSubscription,
} from "../external/stripe-client";
import { onRejection, settle } from "../utils";
import { getOrCreateStripeCustomer$ } from "./billing-customer.service";
import { refundDuplicateSubscriptionInvoice } from "./billing-duplicate-subscription.service";
import { upsertOrgPlanEntitlement } from "./org-plan-entitlements.service";
import { stripePreviewMetadata } from "./stripe-preview-metadata.service";
import {
  handleUsagePackAllocationChangeInvoicePaid,
  reconcileUsagePackAllocationChanges,
  reconcileUsagePackAllocationChangeSubscription,
  reconcileUsagePackAllocationChangeSubscriptionDeleted,
} from "./usage-pack-allocation-change.service";
import {
  handleUsagePackSubscriptionChangeInvoicePaid,
  reconcileUsagePackSubscriptionChanges,
} from "./usage-pack-plan-change.service";
import type { BillingReconciliationScope } from "./billing-reconciliation-scope";
import { completeBillingOperationInvoiceWithInvoice } from "./billing-operation-invoice.service";
import {
  publishUsagePackPendingSnapshotCount,
  UsagePackPendingSnapshotConflict,
  writeUsagePackPendingSnapshots,
} from "./usage-pack-pending-snapshot.service";
import {
  inFlightPlanPurchaseQuery,
  inFlightUsagePackPurchaseQuery,
  PLAN_PURCHASE_CLAIM_STALE_MS,
  USAGE_PACK_PURCHASE_CLAIM_STALE_MS,
  USAGE_PACK_PURCHASE_CLAIM_STATUS,
} from "./billing-purchase-claim.service";
import {
  BILLING_PURCHASE_PREVIEW_TTL_MS,
  billingPreviewExpiresAt,
  createBillingPreviewToken,
  parseBillingPreviewToken,
} from "./billing-purchase-preview-token.service";
import {
  activeUsagePackPlanPriceId,
  activeUsagePackPriceId,
  isUsagePackPlanPriceId,
  tierForKnownPlanPrice,
  tierForKnownPriceId,
  type SubscriptionCheckoutTier,
  usagePackUsdForKnownPriceId,
} from "./billing-checkout.service";
import {
  resolveBillingPurchaseRoute,
  stripeBillingPurchasePaymentParams,
  type BillingPurchasePaymentMethod,
} from "./billing-payment-method.service";

const USAGE_PACK_SUBSCRIPTION_PURPOSE = "usage_pack_subscription";
const USAGE_PACK_SUBSCRIPTION_ID_METADATA_KEY = "usagePackSubscriptionId";

const CREDITS_PER_DOLLAR = 1000;
const PAYABLE_USAGE_PACK_ALLOCATION_STATUSES = [
  "pending_payment",
  "active",
  "pending_invitation",
] as const;
const MANAGED_USAGE_PACK_ALLOCATION_STATUSES = [
  ...PAYABLE_USAGE_PACK_ALLOCATION_STATUSES,
  "paid_pending_invitation",
] as const;
const CANCELED_USAGE_PACK_ALLOCATION_STATUSES = [
  "pending_payment",
  "active",
  "pending_invitation",
  "inactive",
] as const;
const USAGE_PACK_RECONCILIATION_DELAY_MS = 5 * 60 * 1000;
const USAGE_PACK_PENDING_SNAPSHOT_STALE_MS = BILLING_PURCHASE_PREVIEW_TTL_MS;
const USAGE_PACK_PURCHASE_SNAPSHOT_STATUSES = [
  "checkout_pending",
  "purchase_pending",
] as const;
const TERMINAL_USAGE_PACK_SUBSCRIPTION_STATUSES = [
  "canceled",
  "incomplete_expired",
  "invalid",
] as const;
const L = logger("UsagePackSubscription");

type UsagePackSubscriptionRow = typeof usagePackSubscriptions.$inferSelect;
type UsagePackAllocationRow = typeof usagePackAllocations.$inferSelect;
type WriteTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

interface ValidatedUsagePackPrice extends UsagePackCatalogItem {
  readonly stripePriceId: string;
  readonly unitAmountCents: number;
}

export type UsagePackCheckoutAllocation =
  | {
      readonly usagePackUsd: UsagePackUsd;
      readonly stripePriceId: string;
      readonly userId: string;
    }
  | {
      readonly usagePackUsd: UsagePackUsd;
      readonly stripePriceId: string;
      readonly invitationId: string;
    };

interface CreateUsagePackCheckoutSessionArgs {
  readonly orgId: string;
  readonly tier: SubscriptionCheckoutTier;
  readonly planPriceId: string;
  readonly allocations: readonly UsagePackCheckoutAllocation[];
  readonly successUrl: string;
  readonly cancelUrl: string;
}

interface StartUsagePackPurchaseArgs extends CreateUsagePackCheckoutSessionArgs {
  readonly supportsInAppPreview: boolean;
  readonly sourceSubscriptionId: string | null;
}

type StartUsagePackPurchaseResult =
  | { readonly status: "conflict" }
  | { readonly status: "checkout"; readonly url: string }
  | {
      readonly status: "preview";
      readonly preview: UsagePackPurchasePreviewResponse;
    };

type ConfirmUsagePackPurchaseResult =
  | {
      readonly status: "confirmed";
      readonly response: BillingPurchaseConfirmResponse;
      readonly paidInvoice: StripeInvoice | null;
    }
  | { readonly status: "invalid_preview" };

const usagePackPurchasePreviewTokenSchema = z.object({
  version: z.literal(1),
  usagePackSubscriptionId: z.uuid(),
  orgId: z.string().min(1),
  customerId: z.string().min(1),
  sourceSubscriptionId: z.string().min(1).nullable(),
  paymentMethodId: z.string().min(1),
  tier: z.enum(["pro", "team"]),
  planPriceId: z.string().min(1),
  immediateAmountCents: z.number().int().nonnegative(),
  nextRecurringAmountCents: z.number().int().nonnegative(),
  currency: z.string().length(3),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
  expiresAt: z.iso.datetime(),
});

type UsagePackPurchasePreviewToken = z.infer<
  typeof usagePackPurchasePreviewTokenSchema
>;

type StripeObjectReference = string | { readonly id: string };

interface UsagePackCheckoutSessionInput {
  readonly id: string;
  readonly customer: StripeObjectReference | null;
  readonly subscription: StripeObjectReference | null;
  readonly metadata: Record<string, string> | null;
  readonly status?: string | null;
  readonly url?: string | null;
}

export interface UsagePackSubscriptionInput {
  readonly id: string;
  readonly customer?: StripeObjectReference | null;
  readonly status: string;
  readonly metadata?: Record<string, string> | null;
  readonly cancel_at?: number | null;
  readonly cancel_at_period_end: boolean;
  readonly items: {
    readonly data: readonly {
      readonly price: { readonly id: string };
      readonly quantity?: number | null;
      readonly current_period_start?: number | null;
      readonly current_period_end?: number | null;
    }[];
  };
}

interface UsagePackInvoiceLineInput {
  readonly id?: string;
  readonly amount?: number | null;
  readonly discount_amounts?: readonly { readonly amount: number }[] | null;
  readonly subtotal?: number | null;
  readonly quantity?: number | null;
  readonly price?: { readonly id: string } | null;
  readonly pricing?: {
    readonly price_details?: {
      readonly price?: StripeObjectReference | null;
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

export interface UsagePackInvoiceInput {
  readonly id: string;
  readonly amount_paid?: number;
  readonly customer: StripeObjectReference | null;
  readonly metadata: Record<string, string> | null;
  readonly status?: string | null;
  readonly paid?: boolean;
  readonly lines: { readonly data: readonly UsagePackInvoiceLineInput[] };
  readonly parent: {
    readonly subscription_details: {
      readonly metadata?: Record<string, string> | null;
      readonly subscription: StripeObjectReference;
    } | null;
  } | null;
}

interface ValidatedSubscriptionShape {
  readonly tier: SubscriptionCheckoutTier;
  readonly planPriceId: string;
  readonly projectsOrgPlan: boolean;
  readonly periodStart: Date | null;
  readonly periodEnd: Date;
  readonly packageQuantities: ReadonlyMap<string, number>;
}

interface UsagePackBasePlanShape {
  readonly tier: SubscriptionCheckoutTier;
  readonly priceId: string;
  readonly projectsOrgPlan: boolean;
}

type InspectedSubscriptionShape =
  | { readonly valid: true; readonly shape: ValidatedSubscriptionShape }
  | { readonly valid: false; readonly reason: string };

type InspectedValue<T> =
  | { readonly valid: true; readonly value: T }
  | { readonly valid: false; readonly reason: string };

interface UsagePackPackageShape {
  readonly periodStart: Date | null;
  readonly periodEnd: Date;
  readonly quantities: ReadonlyMap<string, number>;
}

interface UsagePackContext {
  readonly subscription: UsagePackSubscriptionRow;
  readonly allocations: readonly UsagePackAllocationRow[];
}

interface PreparedUsagePackAllocationGrant {
  readonly allocationId: string;
  readonly userId: string | null;
  readonly purchasedCredits: number;
  readonly bonusCredits: number;
  readonly stripeInvoiceLineId: string | null;
  readonly sourceAmountCents: number;
}

interface PreparedUsagePackFulfillment {
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly allocations: readonly PreparedUsagePackAllocationGrant[];
}

interface PreparedUsagePackPriceCredits {
  readonly priceId: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly purchasedCredits: number;
  readonly bonusCredits: number;
  readonly stripeInvoiceLineId: string | null;
  readonly sourceAmountCents: number;
  readonly quantity: number;
}

export interface CommitUsagePackFulfillmentArgs {
  readonly context: UsagePackContext;
  readonly subscription: UsagePackSubscriptionInput;
  readonly invoice: UsagePackInvoiceInput;
  readonly shape: ValidatedSubscriptionShape;
  readonly fulfillment: PreparedUsagePackFulfillment;
}

interface UsagePackLifecycleOutcome {
  readonly handled: boolean;
  readonly orgId: string | null;
  readonly subscription?: UsagePackSubscriptionInput;
}

function positiveMetadataInteger(
  metadata: Readonly<Record<string, string>>,
  key: string,
): number | null {
  const value = metadata[key];
  if (!value || !/^[1-9]\d*$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function validateUsagePackPrice(
  usagePackUsd: UsagePackUsd,
  stripePriceId: string,
  price: StripePrice,
  requireActive: boolean,
): ValidatedUsagePackPrice {
  if (price.id !== stripePriceId) {
    throw new Error(
      `Stripe returned usage pack Price ${price.id} for ${stripePriceId}`,
    );
  }
  if (requireActive && !price.active) {
    throw new Error(`Usage pack Price ${stripePriceId} is inactive`);
  }
  if (
    price.currency !== "usd" ||
    price.unit_amount === null ||
    !Number.isSafeInteger(price.unit_amount) ||
    price.unit_amount <= 0
  ) {
    throw new Error(
      `Usage pack Price ${stripePriceId} must have a positive integer USD unit amount`,
    );
  }
  if (
    price.type !== "recurring" ||
    price.recurring?.interval !== "month" ||
    price.recurring.interval_count !== 1
  ) {
    throw new Error(`Usage pack Price ${stripePriceId} must recur every month`);
  }

  const product = price.product;
  if (typeof product === "string" || "deleted" in product) {
    throw new Error(
      `Usage pack Price ${stripePriceId} must expand an active Product`,
    );
  }
  const bonusCredits = positiveMetadataInteger(
    product.metadata,
    "bonusCredits",
  );
  if (bonusCredits === null) {
    throw new Error(
      `Usage pack Product ${product.id} has invalid metadata.bonusCredits`,
    );
  }

  const purchasedCredits = Math.floor(
    (price.unit_amount * CREDITS_PER_DOLLAR) / 100,
  );
  const totalCredits = purchasedCredits + bonusCredits;
  if (
    !Number.isSafeInteger(purchasedCredits) ||
    purchasedCredits <= 0 ||
    !Number.isSafeInteger(totalCredits)
  ) {
    throw new Error(`Usage pack Price ${stripePriceId} exceeds credit limits`);
  }

  return {
    usagePackUsd,
    stripePriceId,
    unitAmountCents: price.unit_amount,
    priceUsd: price.unit_amount / 100,
    purchasedCredits,
    bonusCredits,
    totalCredits,
  };
}

async function loadValidatedUsagePackPrice(
  usagePackUsd: UsagePackUsd,
  stripePriceId: string,
  options: { readonly requireActive: boolean },
): Promise<ValidatedUsagePackPrice> {
  const price = await getStripeClient().prices.retrieve(stripePriceId, {
    expand: ["product"],
  });
  return validateUsagePackPrice(
    usagePackUsd,
    stripePriceId,
    price,
    options.requireActive,
  );
}

export async function loadUsagePackCatalog(): Promise<
  readonly UsagePackCatalogItem[]
> {
  const validated = await Promise.all(
    USAGE_PACKS_USD.map(async (usagePackUsd) => {
      const stripePriceId = activeUsagePackPriceId(usagePackUsd);
      if (!stripePriceId) {
        throw new Error(`Usage pack $${usagePackUsd} Price is not configured`);
      }
      return await loadValidatedUsagePackPrice(usagePackUsd, stripePriceId, {
        requireActive: true,
      });
    }),
  );
  return validated.map((item) => {
    return {
      usagePackUsd: item.usagePackUsd,
      priceUsd: item.priceUsd,
      purchasedCredits: item.purchasedCredits,
      bonusCredits: item.bonusCredits,
      totalCredits: item.totalCredits,
    };
  });
}

export async function activeUsagePackBillingContext(
  db: Pick<Db, "select">,
  orgId: string,
): Promise<{
  readonly usagePackSubscriptionId: string;
  readonly stripeCustomerId: string;
  readonly stripeSubscriptionId: string;
} | null> {
  const [subscription] = await db
    .select({
      usagePackSubscriptionId: usagePackSubscriptions.id,
      stripeCustomerId: usagePackSubscriptions.stripeCustomerId,
      stripeSubscriptionId: usagePackSubscriptions.stripeSubscriptionId,
    })
    .from(usagePackSubscriptions)
    .where(
      and(
        eq(usagePackSubscriptions.orgId, orgId),
        isNotNull(usagePackSubscriptions.stripeSubscriptionId),
        notInArray(usagePackSubscriptions.subscriptionStatus, [
          ...TERMINAL_USAGE_PACK_SUBSCRIPTION_STATUSES,
        ]),
      ),
    )
    .orderBy(desc(usagePackSubscriptions.updatedAt))
    .limit(1);
  return subscription?.stripeSubscriptionId
    ? {
        usagePackSubscriptionId: subscription.usagePackSubscriptionId,
        stripeCustomerId: subscription.stripeCustomerId,
        stripeSubscriptionId: subscription.stripeSubscriptionId,
      }
    : null;
}

export function usagePackSubscriptionMetadata(args: {
  readonly orgId: string;
  readonly tier: SubscriptionCheckoutTier;
  readonly planPriceId: string;
  readonly usagePackSubscriptionId: string;
}): StripeMetadataParam {
  return {
    orgId: args.orgId,
    tier: args.tier,
    priceId: args.planPriceId,
    purpose: USAGE_PACK_SUBSCRIPTION_PURPOSE,
    [USAGE_PACK_SUBSCRIPTION_ID_METADATA_KEY]: args.usagePackSubscriptionId,
    ...stripePreviewMetadata(),
  };
}

function usagePackLineItems(
  allocations: readonly UsagePackCheckoutAllocation[],
): readonly { readonly price: string; readonly quantity: number }[] {
  return USAGE_PACKS_USD.flatMap((usagePackUsd) => {
    const selected = allocations.filter((allocation) => {
      return allocation.usagePackUsd === usagePackUsd;
    });
    if (selected.length === 0) {
      return [];
    }
    const stripePriceId = selected[0]?.stripePriceId;
    if (
      !stripePriceId ||
      selected.some((allocation) => {
        return allocation.stripePriceId !== stripePriceId;
      })
    ) {
      throw new Error(`Usage pack $${usagePackUsd} has inconsistent Prices`);
    }
    return [{ price: stripePriceId, quantity: selected.length }];
  });
}

function usagePackCheckoutAllocationsMatch(
  current: readonly UsagePackAllocationRow[],
  requested: readonly UsagePackCheckoutAllocation[],
): boolean {
  return (
    current.length === requested.length &&
    requested.every((candidate) => {
      return current.some((allocation) => {
        const sameOwner =
          "userId" in candidate
            ? allocation.userId === candidate.userId &&
              allocation.invitationId === null
            : allocation.invitationId === candidate.invitationId &&
              allocation.userId === null;
        return (
          sameOwner &&
          allocation.status === "pending_payment" &&
          allocation.usagePackUsd === candidate.usagePackUsd &&
          allocation.stripePriceId === candidate.stripePriceId
        );
      });
    })
  );
}

async function pendingUsagePackCheckoutContexts(
  db: Pick<WriteTx, "select">,
  orgId: string,
): Promise<readonly UsagePackContext[]> {
  const subscriptions = await db
    .select()
    .from(usagePackSubscriptions)
    .where(
      and(
        eq(usagePackSubscriptions.orgId, orgId),
        inArray(usagePackSubscriptions.subscriptionStatus, [
          ...USAGE_PACK_PURCHASE_SNAPSHOT_STATUSES,
        ]),
      ),
    )
    .orderBy(desc(usagePackSubscriptions.updatedAt));
  return await Promise.all(
    subscriptions.map(async (subscription) => {
      const allocations = await db
        .select()
        .from(usagePackAllocations)
        .where(
          eq(usagePackAllocations.usagePackSubscriptionId, subscription.id),
        );
      return { subscription, allocations };
    }),
  );
}

async function retireUsagePackCheckout(
  tx: Pick<WriteTx, "select" | "update">,
  subscription: UsagePackSubscriptionRow,
): Promise<void> {
  const at = nowDate();
  // Conditional transition: only a still-pending snapshot retires, and only
  // the winning transition retires its allocations.
  const [retired] = await tx
    .update(usagePackSubscriptions)
    .set({ subscriptionStatus: "checkout_expired", updatedAt: at })
    .where(
      and(
        eq(usagePackSubscriptions.id, subscription.id),
        eq(usagePackSubscriptions.orgId, subscription.orgId),
        eq(
          usagePackSubscriptions.subscriptionStatus,
          subscription.subscriptionStatus,
        ),
        subscription.stripeCheckoutSessionId === null
          ? isNull(usagePackSubscriptions.stripeCheckoutSessionId)
          : eq(
              usagePackSubscriptions.stripeCheckoutSessionId,
              subscription.stripeCheckoutSessionId,
            ),
        subscription.stripeSubscriptionId === null
          ? isNull(usagePackSubscriptions.stripeSubscriptionId)
          : eq(
              usagePackSubscriptions.stripeSubscriptionId,
              subscription.stripeSubscriptionId,
            ),
        inArray(usagePackSubscriptions.subscriptionStatus, [
          ...USAGE_PACK_PURCHASE_SNAPSHOT_STATUSES,
        ]),
      ),
    )
    .returning({ id: usagePackSubscriptions.id });
  if (!retired) {
    // A losing replacement must roll back, not create another pending row
    // after a competing request has consumed the same source snapshot.
    throw new Error("Usage pack purchase changed during retirement");
  }
  await tx
    .update(usagePackAllocations)
    .set({ status: "inactive", updatedAt: at })
    .where(eq(usagePackAllocations.usagePackSubscriptionId, subscription.id));
}

type PendingUsagePackCheckoutResolution =
  | { readonly kind: "create" }
  | { readonly kind: "redirect"; readonly url: string }
  | { readonly kind: "reuse"; readonly usagePackSubscriptionId: string };

async function resolvePendingUsagePackSnapshots(
  tx: WriteTx,
  args: {
    readonly snapshots: readonly UsagePackContext[];
    readonly matches: (context: UsagePackContext) => boolean;
  },
): Promise<PendingUsagePackCheckoutResolution> {
  const matchingSnapshot = args.snapshots.find(args.matches);
  for (const snapshot of args.snapshots) {
    if (snapshot !== matchingSnapshot) {
      await retireUsagePackCheckout(tx, snapshot.subscription);
    }
  }
  return matchingSnapshot
    ? {
        kind: "reuse",
        usagePackSubscriptionId: matchingSnapshot.subscription.id,
      }
    : { kind: "create" };
}

interface PreparedPendingUsagePackCheckout {
  /** The Checkout-bearing rows whose Stripe Sessions were read below. */
  readonly fingerprint: string;
  readonly resolved: readonly {
    readonly context: UsagePackContext;
    readonly session: UsagePackCheckoutSessionInput;
  }[];
  readonly retained:
    | {
        readonly context: UsagePackContext;
        readonly session: UsagePackCheckoutSessionInput;
      }
    | undefined;
}

type CommittedPendingUsagePackCheckout =
  | PendingUsagePackCheckoutResolution
  | { readonly kind: "stale" };

function usagePackCheckoutConfigurationMatches(
  args: CreateUsagePackCheckoutSessionArgs,
  customerId: string,
  context: UsagePackContext,
): boolean {
  return (
    context.subscription.tier === args.tier &&
    context.subscription.stripePlanPriceId === args.planPriceId &&
    context.subscription.stripeCustomerId === customerId &&
    usagePackCheckoutAllocationsMatch(context.allocations, args.allocations)
  );
}

function hasCheckoutSession(context: UsagePackContext): boolean {
  return context.subscription.stripeCheckoutSessionId !== null;
}

function pendingUsagePackCheckoutFingerprint(
  contexts: readonly UsagePackContext[],
): string {
  return JSON.stringify(
    [...contexts]
      .map(({ subscription, allocations }) => {
        return {
          subscription,
          allocations: [...allocations].sort((left, right) => {
            return left.id.localeCompare(right.id);
          }),
        };
      })
      .sort((left, right) => {
        return left.subscription.id.localeCompare(right.subscription.id);
      }),
  );
}

/**
 * Stripe reads and expirations run before the billing_purchase compatibility
 * transaction. A superseded open Session is expired before its snapshot
 * retires, preserving the "never an unretired payable Session" order. The
 * commit below re-reads the rows; if a Checkout-bearing row moved, the request
 * fails with a conflict instead of re-running.
 */
async function preparePendingUsagePackCheckout(
  db: Pick<Db, "select">,
  args: CreateUsagePackCheckoutSessionArgs,
  customerId: string,
  signal: AbortSignal,
): Promise<PreparedPendingUsagePackCheckout> {
  const stripe = getStripeClient();
  const contexts = await pendingUsagePackCheckoutContexts(db, args.orgId);
  signal.throwIfAborted();
  const resolved: {
    readonly context: UsagePackContext;
    readonly session: UsagePackCheckoutSessionInput;
  }[] = [];
  for (const context of contexts) {
    const sessionId = context.subscription.stripeCheckoutSessionId;
    if (!sessionId) {
      continue;
    }
    const session = (await stripe.checkout.sessions.retrieve(
      sessionId,
    )) as UsagePackCheckoutSessionInput;
    signal.throwIfAborted();
    resolved.push({ context, session });
  }
  const retained =
    resolved.find(({ session }) => {
      return session.status === "complete";
    }) ??
    resolved.find(({ context, session }) => {
      return (
        session.status === "open" &&
        Boolean(session.url) &&
        usagePackCheckoutConfigurationMatches(args, customerId, context)
      );
    });
  for (const entry of resolved) {
    if (entry !== retained && entry.session.status === "open") {
      await stripe.checkout.sessions.expire(entry.session.id);
      signal.throwIfAborted();
    }
  }
  return {
    fingerprint: pendingUsagePackCheckoutFingerprint(
      contexts.filter(hasCheckoutSession),
    ),
    resolved,
    retained,
  };
}

/**
 * Local-only commit of a prepared resolution; performs no provider I/O.
 * Session-less snapshots are resolved from the rows read here, so concurrent
 * identical requests converge on one snapshot without any re-run.
 */
async function commitPendingUsagePackCheckout(
  tx: WriteTx,
  args: CreateUsagePackCheckoutSessionArgs,
  customerId: string,
  prepared: PreparedPendingUsagePackCheckout,
): Promise<CommittedPendingUsagePackCheckout> {
  const current = await pendingUsagePackCheckoutContexts(tx, args.orgId);
  if (
    pendingUsagePackCheckoutFingerprint(current.filter(hasCheckoutSession)) !==
    prepared.fingerprint
  ) {
    return { kind: "stale" };
  }
  const snapshots = current.filter((context) => {
    return !hasCheckoutSession(context);
  });
  const { retained } = prepared;
  for (const entry of prepared.resolved) {
    if (entry !== retained) {
      await retireUsagePackCheckout(tx, entry.context.subscription);
    }
  }
  if (retained) {
    for (const snapshot of snapshots) {
      await retireUsagePackCheckout(tx, snapshot.subscription);
    }
    if (retained.session.status === "complete") {
      return {
        kind: "redirect",
        url: args.successUrl.replace(
          "{CHECKOUT_SESSION_ID}",
          retained.session.id,
        ),
      };
    }
    if (!retained.session.url) {
      throw new Error("Stripe checkout session did not return a URL");
    }
    return {
      kind: "redirect",
      url: retained.session.url,
    };
  }
  return await resolvePendingUsagePackSnapshots(tx, {
    snapshots,
    matches: (context) => {
      return (
        context.subscription.subscriptionStatus === "purchase_pending" &&
        usagePackCheckoutConfigurationMatches(args, customerId, context)
      );
    },
  });
}

async function insertUsagePackPurchaseSnapshot(
  tx: Pick<WriteTx, "insert">,
  args: CreateUsagePackCheckoutSessionArgs,
  customerId: string,
): Promise<string> {
  const [subscription] = await tx
    .insert(usagePackSubscriptions)
    .values({
      orgId: args.orgId,
      tier: args.tier,
      stripePlanPriceId: args.planPriceId,
      stripeCustomerId: customerId,
      subscriptionStatus: "purchase_pending",
    })
    .returning({ id: usagePackSubscriptions.id });
  if (!subscription) {
    throw new Error("Failed to create usage pack subscription snapshot");
  }
  if (args.allocations.length > 0) {
    await tx.insert(usagePackAllocations).values(
      args.allocations.map((allocation) => {
        return {
          usagePackSubscriptionId: subscription.id,
          orgId: args.orgId,
          usagePackUsd: allocation.usagePackUsd,
          stripePriceId: allocation.stripePriceId,
          ...("userId" in allocation
            ? { userId: allocation.userId }
            : { invitationId: allocation.invitationId }),
        };
      }),
    );
  }
  return subscription.id;
}

type PreparedUsagePackPurchaseSnapshot =
  | { readonly kind: "conflict" }
  | { readonly kind: "redirect"; readonly url: string }
  | { readonly kind: "snapshot"; readonly usagePackSubscriptionId: string };

/**
 * One pass: provider reads, then one local commit. A concurrent request that
 * changed a Checkout-bearing row makes this one a deterministic conflict.
 */
async function prepareUsagePackPurchaseSnapshot(
  db: Db,
  args: CreateUsagePackCheckoutSessionArgs,
  customerId: string,
  signal: AbortSignal,
): Promise<PreparedUsagePackPurchaseSnapshot> {
  const prepared = await preparePendingUsagePackCheckout(
    db,
    args,
    customerId,
    signal,
  );
  return await writeUsagePackPendingSnapshots(
    db,
    [args.orgId],
    async (tx): Promise<PreparedUsagePackPurchaseSnapshot> => {
      signal.throwIfAborted();
      // A claimed purchase is creating its Stripe subscription. Its snapshot
      // and allocations stay current until it publishes, so a new purchase
      // is a deterministic conflict rather than a replacement.
      const [claimed] = await tx
        .select({ id: usagePackSubscriptions.id })
        .from(usagePackSubscriptions)
        .where(
          and(
            eq(usagePackSubscriptions.orgId, args.orgId),
            eq(
              usagePackSubscriptions.subscriptionStatus,
              USAGE_PACK_PURCHASE_CLAIM_STATUS,
            ),
            isNull(usagePackSubscriptions.stripeCheckoutSessionId),
            isNull(usagePackSubscriptions.stripeSubscriptionId),
          ),
        )
        .limit(1);
      if (claimed) {
        return { kind: "conflict" };
      }
      const resolution = await commitPendingUsagePackCheckout(
        tx,
        args,
        customerId,
        prepared,
      );
      if (resolution.kind === "stale") {
        return { kind: "conflict" };
      }
      if (resolution.kind === "redirect") {
        return resolution;
      }
      const usagePackSubscriptionId =
        resolution.kind === "reuse"
          ? resolution.usagePackSubscriptionId
          : await insertUsagePackPurchaseSnapshot(tx, args, customerId);
      signal.throwIfAborted();
      return { kind: "snapshot", usagePackSubscriptionId };
    },
  );
}

type UsagePackCheckoutCorrelation =
  | "correlated"
  | "superseded"
  | "retired"
  | "changed";

/**
 * Publish one known Session only to the same actual uncorrelated purchase
 * owner and commercial snapshot. Conditional publication, not an advisory
 * acquisition, selects the canonical Session before its URL is exposed.
 */
async function correlateUsagePackCheckout(
  db: Pick<Db, "transaction">,
  args: {
    readonly orgId: string;
    readonly usagePackSubscriptionId: string;
    readonly sessionId: string;
    readonly customerId: string;
    readonly planPriceId: string;
    readonly tier: CreateUsagePackCheckoutSessionArgs["tier"];
  },
): Promise<UsagePackCheckoutCorrelation> {
  return await db.transaction(async (tx) => {
    const correlated = await tx
      .update(usagePackSubscriptions)
      .set({
        stripeCheckoutSessionId: args.sessionId,
        subscriptionStatus: "checkout_pending",
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(usagePackSubscriptions.id, args.usagePackSubscriptionId),
          eq(usagePackSubscriptions.orgId, args.orgId),
          eq(usagePackSubscriptions.stripeCustomerId, args.customerId),
          eq(usagePackSubscriptions.stripePlanPriceId, args.planPriceId),
          eq(usagePackSubscriptions.tier, args.tier),
          inArray(usagePackSubscriptions.subscriptionStatus, [
            ...USAGE_PACK_PURCHASE_SNAPSHOT_STATUSES,
          ]),
          isNull(usagePackSubscriptions.stripeCheckoutSessionId),
          isNull(usagePackSubscriptions.stripeSubscriptionId),
        ),
      )
      .returning({ id: usagePackSubscriptions.id });
    if (correlated.length === 1) {
      return "correlated";
    }
    const [current] = await tx
      .select({
        status: usagePackSubscriptions.subscriptionStatus,
        sessionId: usagePackSubscriptions.stripeCheckoutSessionId,
        subscriptionId: usagePackSubscriptions.stripeSubscriptionId,
        orgId: usagePackSubscriptions.orgId,
        customerId: usagePackSubscriptions.stripeCustomerId,
        planPriceId: usagePackSubscriptions.stripePlanPriceId,
        tier: usagePackSubscriptions.tier,
      })
      .from(usagePackSubscriptions)
      .where(eq(usagePackSubscriptions.id, args.usagePackSubscriptionId));
    if (
      current?.sessionId === args.sessionId &&
      current.orgId === args.orgId &&
      current.customerId === args.customerId &&
      current.planPriceId === args.planPriceId &&
      current.tier === args.tier
    ) {
      // A concurrent request received the same idempotent Session and won.
      return "correlated";
    }
    if (
      current?.status !== "checkout_expired" ||
      current.sessionId !== null ||
      current.subscriptionId !== null
    ) {
      return "changed";
    }
    const [replacement] = await tx
      .select({ id: usagePackSubscriptions.id })
      .from(usagePackSubscriptions)
      .where(
        and(
          eq(usagePackSubscriptions.orgId, args.orgId),
          ne(usagePackSubscriptions.id, args.usagePackSubscriptionId),
          inArray(usagePackSubscriptions.subscriptionStatus, [
            ...USAGE_PACK_PURCHASE_SNAPSHOT_STATUSES,
          ]),
        ),
      )
      .limit(1);
    // A replacement purchase retired it (superseded); otherwise stale
    // reconciliation retired it without a successor.
    return replacement ? "superseded" : "retired";
  });
}

/**
 * Correlate a Session created by the claim winner itself. Moving the claimed
 * snapshot back to a pending status goes through the pending-snapshot
 * transaction; no other pending snapshot can exist while the claim holds.
 */
async function correlateClaimedUsagePackCheckout(
  db: Db,
  args: {
    readonly orgId: string;
    readonly usagePackSubscriptionId: string;
    readonly sessionId: string;
    readonly customerId: string;
    readonly planPriceId: string;
    readonly tier: CreateUsagePackCheckoutSessionArgs["tier"];
  },
): Promise<UsagePackCheckoutCorrelation> {
  return await writeUsagePackPendingSnapshots(
    db,
    [args.orgId],
    async (tx): Promise<UsagePackCheckoutCorrelation> => {
      const correlated = await tx
        .update(usagePackSubscriptions)
        .set({
          stripeCheckoutSessionId: args.sessionId,
          subscriptionStatus: "checkout_pending",
          updatedAt: nowDate(),
        })
        .where(
          and(
            eq(usagePackSubscriptions.id, args.usagePackSubscriptionId),
            eq(usagePackSubscriptions.orgId, args.orgId),
            eq(usagePackSubscriptions.stripeCustomerId, args.customerId),
            eq(usagePackSubscriptions.stripePlanPriceId, args.planPriceId),
            eq(usagePackSubscriptions.tier, args.tier),
            eq(
              usagePackSubscriptions.subscriptionStatus,
              USAGE_PACK_PURCHASE_CLAIM_STATUS,
            ),
            isNull(usagePackSubscriptions.stripeCheckoutSessionId),
            isNull(usagePackSubscriptions.stripeSubscriptionId),
          ),
        )
        .returning({ id: usagePackSubscriptions.id });
      return correlated.length === 1 ? "correlated" : "changed";
    },
    [args.usagePackSubscriptionId],
  );
}

/**
 * Create and correlate the Checkout Session of a selected snapshot. Returns
 * null when the snapshot was retired without a successor or taken by another
 * transition; the caller reports a conflict instead of selecting again.
 */
async function createUsagePackCheckoutForSnapshot(args: {
  readonly db: Db;
  readonly stripe: StripeClient;
  readonly purchase: CreateUsagePackCheckoutSessionArgs;
  readonly customerId: string;
  readonly usagePackSubscriptionId: string;
  readonly fromClaim?: boolean;
}): Promise<string | null> {
  const metadata = usagePackSubscriptionMetadata({
    orgId: args.purchase.orgId,
    tier: args.purchase.tier,
    planPriceId: args.purchase.planPriceId,
    usagePackSubscriptionId: args.usagePackSubscriptionId,
  });
  const session = await args.stripe.checkout.sessions.create(
    {
      mode: "subscription",
      customer: args.customerId,
      line_items: [
        { price: args.purchase.planPriceId, quantity: 1 },
        ...usagePackLineItems(args.purchase.allocations),
      ],
      allow_promotion_codes: true,
      success_url: args.purchase.successUrl,
      cancel_url: args.purchase.cancelUrl,
      metadata,
      subscription_data: { metadata },
    },
    {
      idempotencyKey: `usage-pack-checkout:${args.usagePackSubscriptionId}`,
    },
  );
  // Stripe cannot be rolled back. Correlate or expire the Session before
  // returning it to the caller.
  if (!session.url) {
    await args.stripe.checkout.sessions.expire(session.id);
    throw new Error("Stripe checkout session did not return a URL");
  }
  const correlationArgs = {
    orgId: args.purchase.orgId,
    usagePackSubscriptionId: args.usagePackSubscriptionId,
    sessionId: session.id,
    customerId: args.customerId,
    planPriceId: args.purchase.planPriceId,
    tier: args.purchase.tier,
  };
  const correlation = args.fromClaim
    ? await correlateClaimedUsagePackCheckout(args.db, correlationArgs)
    : await correlateUsagePackCheckout(args.db, correlationArgs);
  if (correlation === "correlated") {
    return session.url;
  }
  // The Session never became payable through a retained snapshot.
  await args.stripe.checkout.sessions.expire(session.id);
  if (correlation === "superseded") {
    // A later purchase retired this snapshot after it was selected: the same
    // outcome as this request completing first and then being superseded.
    return session.url;
  }
  return null;
}

async function createUsagePackCheckout(
  db: Db,
  args: CreateUsagePackCheckoutSessionArgs,
  customerId: string,
  usagePackSubscriptionId: string,
  signal: AbortSignal,
): Promise<StartUsagePackPurchaseResult> {
  // Provider I/O runs after the snapshot selection commits; the Session is
  // published by the conditional correlation, and a lost correlation is a
  // deterministic conflict.
  const url = await createUsagePackCheckoutForSnapshot({
    db,
    stripe: getStripeClient(),
    purchase: args,
    customerId,
    usagePackSubscriptionId,
  });
  signal.throwIfAborted();
  return url === null ? { status: "conflict" } : { status: "checkout", url };
}

const createUsagePackCheckoutSession$ = command(
  async (
    { set },
    args: CreateUsagePackCheckoutSessionArgs,
    signal: AbortSignal,
  ): Promise<StartUsagePackPurchaseResult> => {
    const customerId = await set(
      getOrCreateStripeCustomer$,
      { orgId: args.orgId },
      signal,
    );
    signal.throwIfAborted();
    const db = set(writeDb$);
    const prepared = await prepareUsagePackPurchaseSnapshot(
      db,
      args,
      customerId,
      signal,
    );
    if (prepared.kind === "conflict") {
      return { status: "conflict" };
    }
    if (prepared.kind === "redirect") {
      return { status: "checkout", url: prepared.url };
    }
    return await createUsagePackCheckout(
      db,
      args,
      customerId,
      prepared.usagePackSubscriptionId,
      signal,
    );
  },
);

function safeInvoiceAmount(invoice: StripeInvoice, label: string): number {
  if (
    !Number.isSafeInteger(invoice.amount_due) ||
    invoice.amount_due < 0 ||
    invoice.currency.length !== 3
  ) {
    throw new Error(`Stripe ${label} preview is invalid`);
  }
  return invoice.amount_due;
}

interface UsagePackPurchasePreviewInput {
  readonly purchase: StartUsagePackPurchaseArgs;
  readonly customerId: string;
  readonly snapshotId: string;
  readonly route: {
    readonly customerId: string;
    readonly paymentMethodId: string;
  };
}

const usagePackPurchasePreviewSnapshot$ = command(
  async (
    { set },
    input: UsagePackPurchasePreviewInput,
    signal: AbortSignal,
  ): Promise<string | null> => {
    const db = set(writeDb$);
    const [snapshot] = await db
      .select()
      .from(usagePackSubscriptions)
      .where(
        and(
          eq(usagePackSubscriptions.id, input.snapshotId),
          eq(usagePackSubscriptions.orgId, input.purchase.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (
      !snapshot ||
      snapshot.subscriptionStatus !== "purchase_pending" ||
      snapshot.stripeCheckoutSessionId ||
      snapshot.stripeSubscriptionId ||
      snapshot.tier !== input.purchase.tier ||
      snapshot.stripePlanPriceId !== input.purchase.planPriceId ||
      snapshot.stripeCustomerId !== input.customerId
    ) {
      return null;
    }
    const allocations = await db
      .select()
      .from(usagePackAllocations)
      .where(eq(usagePackAllocations.usagePackSubscriptionId, snapshot.id));
    signal.throwIfAborted();
    return usagePackCheckoutAllocationsMatch(
      allocations,
      input.purchase.allocations,
    )
      ? snapshot.id
      : null;
  },
);

/**
 * Refresh the snapshot's preview time with one conditional write. Snapshot
 * allocations are immutable, so the snapshot is still this purchase exactly
 * while it remains an uncorrelated `purchase_pending` row.
 */
const publishUsagePackPurchasePreview$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly usagePackSubscriptionId: string;
      readonly issuedAt: Date;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const [refreshed] = await db
      .update(usagePackSubscriptions)
      .set({ updatedAt: args.issuedAt })
      .where(
        and(
          eq(usagePackSubscriptions.id, args.usagePackSubscriptionId),
          eq(usagePackSubscriptions.orgId, args.orgId),
          eq(usagePackSubscriptions.subscriptionStatus, "purchase_pending"),
          isNull(usagePackSubscriptions.stripeCheckoutSessionId),
          isNull(usagePackSubscriptions.stripeSubscriptionId),
        ),
      )
      .returning({ id: usagePackSubscriptions.id });
    signal.throwIfAborted();
    return refreshed !== undefined;
  },
);

const createUsagePackPurchasePreview$ = command(
  async (
    { set },
    input: UsagePackPurchasePreviewInput,
    signal: AbortSignal,
  ): Promise<StartUsagePackPurchaseResult> => {
    const snapshotId = await set(
      usagePackPurchasePreviewSnapshot$,
      input,
      signal,
    );
    if (!snapshotId) {
      return { status: "conflict" };
    }
    const { purchase, route } = input;
    const stripe = getStripeClient();
    const items = [
      { price: purchase.planPriceId, quantity: 1 },
      ...usagePackLineItems(purchase.allocations),
    ];
    const [immediateInvoice, recurringInvoice] = await Promise.all([
      stripe.invoices.createPreview({
        customer: route.customerId,
        preview_mode: "next",
        subscription_details: { items },
      }),
      stripe.invoices.createPreview({
        customer: route.customerId,
        preview_mode: "recurring",
        subscription_details: { items },
      }),
    ]);
    signal.throwIfAborted();
    const immediateAmountCents = safeInvoiceAmount(
      immediateInvoice,
      "usage pack purchase immediate",
    );
    const nextRecurringAmountCents = safeInvoiceAmount(
      recurringInvoice,
      "usage pack purchase recurring",
    );
    if (immediateInvoice.currency !== recurringInvoice.currency) {
      throw new Error(
        "Stripe usage pack purchase previews disagree on currency",
      );
    }
    const issuedAt = nowDate();
    const expiresAt = billingPreviewExpiresAt(issuedAt);
    if (
      !(await set(
        publishUsagePackPurchasePreview$,
        {
          orgId: purchase.orgId,
          usagePackSubscriptionId: snapshotId,
          issuedAt,
        },
        signal,
      ))
    ) {
      // Retired or claimed by another request while pricing: one conflict.
      return { status: "conflict" };
    }
    const payload: UsagePackPurchasePreviewToken = {
      version: 1,
      usagePackSubscriptionId: snapshotId,
      orgId: purchase.orgId,
      customerId: route.customerId,
      sourceSubscriptionId: purchase.sourceSubscriptionId,
      paymentMethodId: route.paymentMethodId,
      tier: purchase.tier,
      planPriceId: purchase.planPriceId,
      immediateAmountCents,
      nextRecurringAmountCents,
      currency: immediateInvoice.currency,
      successUrl: purchase.successUrl,
      cancelUrl: purchase.cancelUrl,
      expiresAt,
    };
    return {
      status: "preview",
      preview: {
        status: "preview",
        purchaseType: "usage_pack",
        tier: purchase.tier,
        immediateAmountCents,
        nextRecurringAmountCents,
        currency: immediateInvoice.currency,
        expiresAt,
        previewToken: createBillingPreviewToken(payload),
      },
    };
  },
);

export const startUsagePackPurchase$ = command(
  async (
    { set },
    args: StartUsagePackPurchaseArgs,
    signal: AbortSignal,
  ): Promise<StartUsagePackPurchaseResult> => {
    if (!args.supportsInAppPreview) {
      return await set(createUsagePackCheckoutSession$, args, signal);
    }
    const customerId = await set(
      getOrCreateStripeCustomer$,
      { orgId: args.orgId },
      signal,
    );
    signal.throwIfAborted();
    const db = set(writeDb$);
    const stripe = getStripeClient();
    const route = await resolveBillingPurchaseRoute(
      {
        stripe,
        supportsInAppPreview: true,
        customerId,
        subscriptionId: args.sourceSubscriptionId,
      },
      signal,
    );
    const prepared = await prepareUsagePackPurchaseSnapshot(
      db,
      args,
      customerId,
      signal,
    );
    if (prepared.kind === "conflict") {
      return { status: "conflict" };
    }
    if (prepared.kind === "redirect") {
      return { status: "checkout", url: prepared.url };
    }
    if (route.kind === "checkout") {
      return await createUsagePackCheckout(
        db,
        args,
        customerId,
        prepared.usagePackSubscriptionId,
        signal,
      );
    }
    return await set(
      createUsagePackPurchasePreview$,
      {
        purchase: args,
        customerId,
        snapshotId: prepared.usagePackSubscriptionId,
        route,
      },
      signal,
    );
  },
);

function expandedLatestInvoice(
  subscription: StripeSubscription,
): StripeInvoice | null {
  return subscription.latest_invoice &&
    typeof subscription.latest_invoice !== "string"
    ? subscription.latest_invoice
    : null;
}

function checkoutAllocationsFromRows(
  rows: readonly {
    readonly usagePackUsd: number;
    readonly stripePriceId: string;
    readonly userId: string | null;
    readonly invitationId: string | null;
  }[],
): readonly UsagePackCheckoutAllocation[] | null {
  const allocations: UsagePackCheckoutAllocation[] = [];
  for (const row of rows) {
    if (!USAGE_PACKS_USD.includes(row.usagePackUsd as UsagePackUsd)) {
      return null;
    }
    const common = {
      usagePackUsd: row.usagePackUsd as UsagePackUsd,
      stripePriceId: row.stripePriceId,
    };
    if (row.userId && !row.invitationId) {
      allocations.push({ ...common, userId: row.userId });
      continue;
    }
    if (row.invitationId && !row.userId) {
      allocations.push({ ...common, invitationId: row.invitationId });
      continue;
    }
    return null;
  }
  return allocations;
}

interface UsagePackPurchaseSnapshot {
  readonly subscription: UsagePackSubscriptionRow;
  readonly allocations: readonly UsagePackCheckoutAllocation[];
}

async function loadUsagePackPurchaseSnapshot(
  db: Pick<Db, "select">,
  orgId: string,
  preview: UsagePackPurchasePreviewToken,
  signal: AbortSignal,
): Promise<UsagePackPurchaseSnapshot | null> {
  const [subscription] = await db
    .select()
    .from(usagePackSubscriptions)
    .where(
      and(
        eq(usagePackSubscriptions.id, preview.usagePackSubscriptionId),
        eq(usagePackSubscriptions.orgId, orgId),
      ),
    )
    .limit(1);
  const allocationRows = await db
    .select({
      usagePackUsd: usagePackAllocations.usagePackUsd,
      stripePriceId: usagePackAllocations.stripePriceId,
      userId: usagePackAllocations.userId,
      invitationId: usagePackAllocations.invitationId,
    })
    .from(usagePackAllocations)
    .where(
      eq(
        usagePackAllocations.usagePackSubscriptionId,
        preview.usagePackSubscriptionId,
      ),
    );
  signal.throwIfAborted();
  const allocations = checkoutAllocationsFromRows(allocationRows);
  if (
    !subscription ||
    subscription.subscriptionStatus === "checkout_expired" ||
    subscription.orgId !== orgId ||
    subscription.stripeCustomerId !== preview.customerId ||
    subscription.tier !== preview.tier ||
    subscription.stripePlanPriceId !== preview.planPriceId ||
    !allocations
  ) {
    return null;
  }
  return { subscription, allocations };
}

function competingUsagePackPurchase(
  subscriptions: readonly StripeSubscription[],
  args: {
    readonly orgId: string;
    readonly sourceSubscriptionId: string | null;
    readonly ownSubscriptionId: string | undefined;
  },
): boolean {
  return subscriptions.some((candidate) => {
    return (
      candidate.id !== args.sourceSubscriptionId &&
      candidate.metadata?.orgId === args.orgId &&
      candidate.id !== args.ownSubscriptionId &&
      candidate.items.data.some((item) => {
        return tierForKnownPriceId(item.price.id) !== null;
      }) &&
      candidate.status !== "canceled" &&
      candidate.status !== "incomplete_expired"
    );
  });
}

/**
 * Local admission: one conditional write on the purchase's existing snapshot
 * row decides the unique winner before any Stripe call.
 *
 * The snapshot moves from `purchase_pending` to the claim status only if no
 * other usage-pack purchase is claimed or live and no fresh Plan claim holds
 * the organization. The pending-snapshot transaction orders it with every
 * snapshot writer for the organization.
 */
async function claimUsagePackPurchase(
  db: Db,
  orgId: string,
  preview: UsagePackPurchasePreviewToken,
): Promise<boolean> {
  const at = nowDate();
  const planClaimStaleBefore = new Date(
    at.getTime() - PLAN_PURCHASE_CLAIM_STALE_MS,
  );
  // Best effort: a concurrent Plan claim may still pass the NOT EXISTS checks.
  // Local entitlement then binds once and the extra payment is refunded. A
  // concurrent pending-count transition that committed first is a conflict.
  const claimed = await settle(
    writeUsagePackPendingSnapshots(
      db,
      [orgId],
      async (tx) => {
        const claimed = await tx
          .update(usagePackSubscriptions)
          .set({
            subscriptionStatus: USAGE_PACK_PURCHASE_CLAIM_STATUS,
            updatedAt: at,
          })
          .where(
            and(
              eq(usagePackSubscriptions.id, preview.usagePackSubscriptionId),
              eq(usagePackSubscriptions.orgId, orgId),
              eq(usagePackSubscriptions.subscriptionStatus, "purchase_pending"),
              isNull(usagePackSubscriptions.stripeCheckoutSessionId),
              isNull(usagePackSubscriptions.stripeSubscriptionId),
              notExists(
                inFlightUsagePackPurchaseQuery(tx, {
                  orgId,
                  sourceSubscriptionId: null,
                  excludeUsagePackSubscriptionId:
                    preview.usagePackSubscriptionId,
                }),
              ),
              notExists(
                inFlightPlanPurchaseQuery(tx, orgId, planClaimStaleBefore),
              ),
            ),
          )
          .returning({ id: usagePackSubscriptions.id });
        return claimed.length === 1;
      },
      [preview.usagePackSubscriptionId],
    ),
  );
  if (claimed.ok) {
    return claimed.value;
  }
  if (claimed.error instanceof UsagePackPendingSnapshotConflict) {
    return false;
  }
  throw claimed.error;
}

/**
 * Retire a claim that never created a subscription. The claim status is not
 * a pending-snapshot status, so the guard count does not change.
 */
async function retireUsagePackPurchaseClaim(
  db: Pick<Db, "transaction">,
  orgId: string,
  usagePackSubscriptionId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const updatedAt = nowDate();
    const [retired] = await tx
      .update(usagePackSubscriptions)
      .set({ subscriptionStatus: "checkout_expired", updatedAt })
      .where(
        and(
          eq(usagePackSubscriptions.id, usagePackSubscriptionId),
          eq(usagePackSubscriptions.orgId, orgId),
          eq(
            usagePackSubscriptions.subscriptionStatus,
            USAGE_PACK_PURCHASE_CLAIM_STATUS,
          ),
          isNull(usagePackSubscriptions.stripeCheckoutSessionId),
          isNull(usagePackSubscriptions.stripeSubscriptionId),
        ),
      )
      .returning({ id: usagePackSubscriptions.id });
    if (!retired) {
      return;
    }
    await tx
      .update(usagePackAllocations)
      .set({ status: "inactive", updatedAt })
      .where(
        eq(
          usagePackAllocations.usagePackSubscriptionId,
          usagePackSubscriptionId,
        ),
      );
  });
}

/**
 * Publish the winner's subscription to its claimed snapshot. A webhook that
 * already bound the same idempotent subscription counts as published.
 */
async function publishUsagePackPurchaseSubscription(
  db: Db,
  orgId: string,
  usagePackSubscriptionId: string,
  subscription: StripeSubscription,
): Promise<boolean> {
  return await writeUsagePackPendingSnapshots(
    db,
    [orgId],
    async (tx) => {
      const published = await tx
        .update(usagePackSubscriptions)
        .set({
          stripeSubscriptionId: subscription.id,
          subscriptionStatus: subscription.status,
          updatedAt: nowDate(),
        })
        .where(
          and(
            eq(usagePackSubscriptions.id, usagePackSubscriptionId),
            eq(usagePackSubscriptions.orgId, orgId),
            eq(
              usagePackSubscriptions.subscriptionStatus,
              USAGE_PACK_PURCHASE_CLAIM_STATUS,
            ),
            isNull(usagePackSubscriptions.stripeCheckoutSessionId),
            isNull(usagePackSubscriptions.stripeSubscriptionId),
          ),
        )
        .returning({ id: usagePackSubscriptions.id });
      if (published.length === 1) {
        return true;
      }
      const [current] = await tx
        .select({
          subscriptionId: usagePackSubscriptions.stripeSubscriptionId,
        })
        .from(usagePackSubscriptions)
        .where(eq(usagePackSubscriptions.id, usagePackSubscriptionId));
      return current?.subscriptionId === subscription.id;
    },
    [usagePackSubscriptionId],
  );
}

async function completeUsagePackPurchaseSubscription(
  stripe: StripeClient,
  preview: UsagePackPurchasePreviewToken,
  subscription: StripeSubscription,
  signal: AbortSignal,
): Promise<ConfirmUsagePackPurchaseResult> {
  const completion = await completeBillingOperationInvoiceWithInvoice(
    stripe,
    expandedLatestInvoice(subscription),
    `usage-pack:${preview.usagePackSubscriptionId}`,
    signal,
    { payOpenInvoice: true },
  );
  return {
    status: "confirmed",
    ...completion,
  };
}

/**
 * Replays of a purchase whose outcome is already published. A snapshot that
 * is still claimed belongs to a running (or crashed) winner and is a
 * conflict; reconciliation resolves a crashed claim from Stripe.
 */
async function existingUsagePackPurchaseResult(
  preview: UsagePackPurchasePreviewToken,
  snapshot: UsagePackPurchaseSnapshot,
  signal: AbortSignal,
): Promise<ConfirmUsagePackPurchaseResult | null> {
  const stripe = getStripeClient();
  if (snapshot.subscription.stripeCheckoutSessionId) {
    const session = (await stripe.checkout.sessions.retrieve(
      snapshot.subscription.stripeCheckoutSessionId,
    )) as UsagePackCheckoutSessionInput;
    signal.throwIfAborted();
    if (session.status === "complete") {
      return {
        status: "confirmed",
        response: {
          status: "checkout_required",
          checkoutUrl: preview.successUrl.replace(
            "{CHECKOUT_SESSION_ID}",
            session.id,
          ),
        },
        paidInvoice: null,
      };
    }
    if (session.status === "open" && session.url) {
      return {
        status: "confirmed",
        response: {
          status: "checkout_required",
          checkoutUrl: session.url,
        },
        paidInvoice: null,
      };
    }
    return { status: "invalid_preview" };
  }
  if (snapshot.subscription.stripeSubscriptionId) {
    const existing = await stripe.subscriptions.retrieve(
      snapshot.subscription.stripeSubscriptionId,
      { expand: ["latest_invoice"] },
    );
    signal.throwIfAborted();
    return await completeUsagePackPurchaseSubscription(
      stripe,
      preview,
      existing,
      signal,
    );
  }
  if (snapshot.subscription.subscriptionStatus !== "purchase_pending") {
    return { status: "invalid_preview" };
  }
  return null;
}

async function usagePackPurchasePreviewStillMatches(
  stripe: StripeClient,
  preview: UsagePackPurchasePreviewToken,
  items: readonly { readonly price: string; readonly quantity: number }[],
  signal: AbortSignal,
): Promise<boolean> {
  const [currentImmediatePreview, currentRecurringPreview] = await Promise.all([
    stripe.invoices.createPreview({
      customer: preview.customerId,
      preview_mode: "next",
      subscription_details: { items: [...items] },
    }),
    stripe.invoices.createPreview({
      customer: preview.customerId,
      preview_mode: "recurring",
      subscription_details: { items: [...items] },
    }),
  ]);
  signal.throwIfAborted();
  return (
    safeInvoiceAmount(
      currentImmediatePreview,
      "usage pack purchase immediate",
    ) === preview.immediateAmountCents &&
    safeInvoiceAmount(
      currentRecurringPreview,
      "usage pack purchase recurring",
    ) === preview.nextRecurringAmountCents &&
    currentImmediatePreview.currency === preview.currency &&
    currentRecurringPreview.currency === preview.currency
  );
}

type ClaimedUsagePackPurchaseAdmission =
  | { readonly kind: "invalid" }
  | { readonly kind: "checkout" }
  | { readonly kind: "resume"; readonly subscription: StripeSubscription }
  | {
      readonly kind: "create";
      readonly items: readonly {
        readonly price: string;
        readonly quantity: number;
      }[];
      readonly paymentMethod: BillingPurchasePaymentMethod & {
        readonly customerId: string;
      };
    };

/** Winner-only provider reads before the single idempotent creation. */
async function admitClaimedUsagePackPurchase(
  stripe: StripeClient,
  orgId: string,
  preview: UsagePackPurchasePreviewToken,
  snapshot: UsagePackPurchaseSnapshot,
  signal: AbortSignal,
): Promise<ClaimedUsagePackPurchaseAdmission> {
  const subscriptions = await listAllStripeSubscriptions(
    stripe,
    { customer: preview.customerId, status: "all" },
    signal,
  );
  const existingSummary = subscriptions.find((candidate) => {
    return (
      candidate.metadata?.[USAGE_PACK_SUBSCRIPTION_ID_METADATA_KEY] ===
      preview.usagePackSubscriptionId
    );
  });
  if (
    competingUsagePackPurchase(subscriptions, {
      orgId,
      sourceSubscriptionId: preview.sourceSubscriptionId,
      ownSubscriptionId: existingSummary?.id,
    })
  ) {
    return { kind: "invalid" };
  }
  if (existingSummary) {
    const existing = await stripe.subscriptions.retrieve(existingSummary.id, {
      expand: ["latest_invoice"],
    });
    signal.throwIfAborted();
    return { kind: "resume", subscription: existing };
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
    // The saved card disappeared after the preview: the winner turns its
    // claim into a hosted Checkout instead of charging.
    return { kind: "checkout" };
  }
  if (
    route.customerId !== preview.customerId ||
    route.paymentMethodId !== preview.paymentMethodId
  ) {
    return { kind: "invalid" };
  }
  const items = [
    { price: preview.planPriceId, quantity: 1 },
    ...usagePackLineItems(snapshot.allocations),
  ];
  if (
    !(await usagePackPurchasePreviewStillMatches(
      stripe,
      preview,
      items,
      signal,
    ))
  ) {
    return { kind: "invalid" };
  }
  return { kind: "create", items, paymentMethod: route };
}

async function confirmUsagePackPurchaseSnapshot(
  db: Db,
  orgId: string,
  preview: UsagePackPurchasePreviewToken,
  snapshot: UsagePackPurchaseSnapshot,
  signal: AbortSignal,
): Promise<ConfirmUsagePackPurchaseResult> {
  const existingResult = await existingUsagePackPurchaseResult(
    preview,
    snapshot,
    signal,
  );
  if (existingResult) {
    return existingResult;
  }
  if (!(await claimUsagePackPurchase(db, orgId, preview))) {
    // Deterministic loser: another purchase owns the organization. No
    // provider call was made.
    return { status: "invalid_preview" };
  }
  signal.throwIfAborted();
  const retire = async () => {
    await retireUsagePackPurchaseClaim(
      db,
      orgId,
      preview.usagePackSubscriptionId,
    );
  };
  const stripe = getStripeClient();
  // Before creation nothing irreversible exists, so a failure retires the
  // claim and its preview. After creation the claim stays until published
  // here, by the subscription webhook, or by reconciliation.
  const admission = await onRejection(
    admitClaimedUsagePackPurchase(stripe, orgId, preview, snapshot, signal),
    retire,
  );
  if (admission.kind === "invalid") {
    await retire();
    return { status: "invalid_preview" };
  }
  if (admission.kind === "checkout") {
    const checkoutUrl = await onRejection(
      createUsagePackCheckoutForSnapshot({
        db,
        stripe,
        purchase: {
          orgId,
          tier: preview.tier,
          planPriceId: preview.planPriceId,
          allocations: snapshot.allocations,
          successUrl: preview.successUrl,
          cancelUrl: preview.cancelUrl,
        },
        customerId: preview.customerId,
        usagePackSubscriptionId: preview.usagePackSubscriptionId,
        fromClaim: true,
      }),
      retire,
    );
    signal.throwIfAborted();
    return checkoutUrl === null
      ? { status: "invalid_preview" }
      : {
          status: "confirmed",
          response: { status: "checkout_required", checkoutUrl },
          paidInvoice: null,
        };
  }
  const subscription =
    admission.kind === "resume"
      ? admission.subscription
      : await stripe.subscriptions.create(
          {
            customer: preview.customerId,
            items: [...admission.items],
            ...stripeBillingPurchasePaymentParams(admission.paymentMethod),
            metadata: usagePackSubscriptionMetadata({
              orgId,
              tier: preview.tier,
              planPriceId: preview.planPriceId,
              usagePackSubscriptionId: preview.usagePackSubscriptionId,
            }),
            payment_behavior: "default_incomplete",
            expand: ["latest_invoice"],
          },
          {
            idempotencyKey: `usage-pack:${preview.usagePackSubscriptionId}:subscription`,
          },
        );
  signal.throwIfAborted();
  if (
    !(await publishUsagePackPurchaseSubscription(
      db,
      orgId,
      preview.usagePackSubscriptionId,
      subscription,
    ))
  ) {
    // Only reachable if stale-claim recovery retired this snapshot while the
    // winner was still running; the subscription was never paid here.
    await abandonUsagePackPurchaseSubscription(
      stripe,
      subscription,
      admission.kind === "create",
    );
    return { status: "invalid_preview" };
  }
  signal.throwIfAborted();
  return await completeUsagePackPurchaseSubscription(
    stripe,
    preview,
    subscription,
    signal,
  );
}

/** Release a subscription that lost publication; it was never paid here. */
async function abandonUsagePackPurchaseSubscription(
  stripe: StripeClient,
  subscription: StripeSubscription,
  createdByThisRequest: boolean,
): Promise<void> {
  if (
    subscription.status === "incomplete" ||
    (createdByThisRequest &&
      subscription.status !== "canceled" &&
      subscription.status !== "incomplete_expired")
  ) {
    await stripe.subscriptions.cancel(subscription.id);
  }
}

export const confirmUsagePackPurchase$ = command(
  async (
    { set },
    orgId: string,
    previewToken: string,
    signal: AbortSignal,
  ): Promise<ConfirmUsagePackPurchaseResult> => {
    const preview = parseBillingPreviewToken(
      previewToken,
      usagePackPurchasePreviewTokenSchema,
    );
    if (
      !preview ||
      preview.orgId !== orgId ||
      preview.planPriceId !== activeUsagePackPlanPriceId(preview.tier) ||
      new Date(preview.expiresAt) <= nowDate()
    ) {
      return { status: "invalid_preview" };
    }
    const db = set(writeDb$);
    const snapshot = await loadUsagePackPurchaseSnapshot(
      db,
      orgId,
      preview,
      signal,
    );
    if (!snapshot) {
      return { status: "invalid_preview" };
    }
    return await confirmUsagePackPurchaseSnapshot(
      db,
      orgId,
      preview,
      snapshot,
      signal,
    );
  },
);

export function usagePackSubscriptionIdFromMetadata(
  metadata: Readonly<Record<string, string>> | null | undefined,
): string | null {
  if (metadata?.purpose !== USAGE_PACK_SUBSCRIPTION_PURPOSE) {
    return null;
  }
  return embeddedUsagePackSubscriptionId(metadata);
}

function embeddedUsagePackSubscriptionId(
  metadata: Readonly<Record<string, string>> | null | undefined,
): string | null {
  const id = metadata?.[USAGE_PACK_SUBSCRIPTION_ID_METADATA_KEY];
  if (!id) {
    return null;
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
  ) {
    throw new Error(`Invalid usage pack subscription ID: ${id}`);
  }
  return id;
}

function oneUsagePackSubscriptionId(
  ...metadataCandidates: readonly (
    | Readonly<Record<string, string>>
    | null
    | undefined
  )[]
): string | null {
  const ids = new Set(
    metadataCandidates.flatMap((metadata) => {
      const id = usagePackSubscriptionIdFromMetadata(metadata);
      return id ? [id] : [];
    }),
  );
  if (ids.size > 1) {
    throw new Error("Stripe usage pack metadata has conflicting local IDs");
  }
  return ids.values().next().value ?? null;
}

async function boundUsagePackSubscriptionId(
  db: Pick<Db, "select">,
  stripeSubscriptionId: string | null,
  includeTerminal: boolean,
): Promise<string | null> {
  if (!stripeSubscriptionId) {
    return null;
  }
  const [subscription] = await db
    .select({ id: usagePackSubscriptions.id })
    .from(usagePackSubscriptions)
    .where(
      includeTerminal
        ? eq(usagePackSubscriptions.stripeSubscriptionId, stripeSubscriptionId)
        : and(
            eq(
              usagePackSubscriptions.stripeSubscriptionId,
              stripeSubscriptionId,
            ),
            notInArray(usagePackSubscriptions.subscriptionStatus, [
              ...TERMINAL_USAGE_PACK_SUBSCRIPTION_STATUSES,
            ]),
          ),
    )
    .limit(1);
  return subscription?.id ?? null;
}

async function activeMetadataUsagePackSubscriptionId(
  db: Pick<Db, "select">,
  metadata: readonly (Readonly<Record<string, string>> | null | undefined)[],
): Promise<string | null> {
  const metadataId = oneUsagePackSubscriptionId(...metadata);
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
          ...TERMINAL_USAGE_PACK_SUBSCRIPTION_STATUSES,
        ]),
      ),
    )
    .limit(1);
  return subscription?.id ?? null;
}

export async function stripeSubscriptionUsesMemberUsagePacks(
  db: Pick<Db, "select">,
  args: {
    readonly orgId: string;
    readonly stripeSubscriptionId: string;
  },
): Promise<boolean> {
  const [allocation] = await db
    .select({ id: usagePackAllocations.id })
    .from(usagePackSubscriptions)
    .innerJoin(
      usagePackAllocations,
      eq(
        usagePackAllocations.usagePackSubscriptionId,
        usagePackSubscriptions.id,
      ),
    )
    .where(
      and(
        eq(usagePackSubscriptions.orgId, args.orgId),
        eq(
          usagePackSubscriptions.stripeSubscriptionId,
          args.stripeSubscriptionId,
        ),
        notInArray(usagePackSubscriptions.subscriptionStatus, [
          ...TERMINAL_USAGE_PACK_SUBSCRIPTION_STATUSES,
        ]),
        inArray(usagePackAllocations.status, [
          ...MANAGED_USAGE_PACK_ALLOCATION_STATUSES,
        ]),
      ),
    )
    .limit(1);
  return allocation !== undefined;
}

async function resolveUsagePackSubscriptionId(
  db: Pick<Db, "select">,
  args: {
    readonly stripeSubscriptionId: string | null;
    readonly metadata: readonly (
      | Readonly<Record<string, string>>
      | null
      | undefined
    )[];
    readonly includeTerminalBinding?: boolean;
  },
): Promise<string | null> {
  const boundId = await boundUsagePackSubscriptionId(
    db,
    args.stripeSubscriptionId,
    args.includeTerminalBinding ?? false,
  );
  if (boundId) {
    return boundId;
  }
  return await activeMetadataUsagePackSubscriptionId(db, args.metadata);
}

function stripeObjectId(value: StripeObjectReference | null | undefined) {
  return typeof value === "string" ? value : (value?.id ?? null);
}

function unixDate(value: number | null | undefined): Date | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return null;
  }
  return new Date(value * 1000);
}

async function loadUsagePackContext(
  db: Pick<Db, "select">,
  usagePackSubscriptionId: string,
): Promise<UsagePackContext> {
  const [subscription] = await db
    .select()
    .from(usagePackSubscriptions)
    .where(eq(usagePackSubscriptions.id, usagePackSubscriptionId))
    .limit(1);
  if (!subscription) {
    throw new Error(
      `Unknown usage pack subscription: ${usagePackSubscriptionId}`,
    );
  }

  const allocations = await db
    .select()
    .from(usagePackAllocations)
    .where(
      eq(usagePackAllocations.usagePackSubscriptionId, usagePackSubscriptionId),
    );
  return { subscription, allocations };
}

function payableUsagePackAllocations(
  context: UsagePackContext,
): readonly UsagePackAllocationRow[] {
  return context.allocations.filter((allocation) => {
    return PAYABLE_USAGE_PACK_ALLOCATION_STATUSES.some((status) => {
      return allocation.status === status;
    });
  });
}

function invoiceEligibleUsagePackAllocations(
  context: UsagePackContext,
): readonly UsagePackAllocationRow[] {
  if (context.subscription.subscriptionStatus === "canceled") {
    return context.allocations.filter((allocation) => {
      return CANCELED_USAGE_PACK_ALLOCATION_STATUSES.some((status) => {
        return allocation.status === status;
      });
    });
  }
  return payableUsagePackAllocations(context);
}

function usagePackSubscriptionWillCancel(
  subscription: UsagePackSubscriptionInput,
): boolean {
  return (
    subscription.cancel_at_period_end ||
    unixDate(subscription.cancel_at) !== null
  );
}

function subscriptionHasCustomPlan(
  subscription: UsagePackSubscriptionInput,
): boolean {
  return subscription.items.data.some((item) => {
    return tierForKnownPlanPrice(item.price) === "custom";
  });
}

function customSubscriptionRemovedUsagePacks(
  subscription: UsagePackSubscriptionInput,
): boolean {
  const hasUsagePack = subscription.items.data.some((item) => {
    return usagePackUsdForKnownPriceId(item.price.id) !== null;
  });
  return subscriptionHasCustomPlan(subscription) && !hasUsagePack;
}

function inspectUsagePackBasePlan(
  context: UsagePackContext,
  subscription: UsagePackSubscriptionInput,
): InspectedValue<UsagePackBasePlanShape> {
  const customPlanItems = subscription.items.data.filter((item) => {
    return tierForKnownPlanPrice(item.price) === "custom";
  });
  if (customPlanItems.length > 1) {
    return {
      valid: false,
      reason: `expected at most one Custom base plan, received ${customPlanItems.length}`,
    };
  }
  const customPlanItem = customPlanItems[0];
  if (customPlanItem) {
    const quantity = customPlanItem.quantity ?? 1;
    if (quantity !== 1) {
      return {
        valid: false,
        reason: `Custom base plan quantity must be one, received ${quantity}`,
      };
    }
    if (
      tierForKnownPriceId(context.subscription.stripePlanPriceId) !==
      context.subscription.tier
    ) {
      return {
        valid: false,
        reason: "local usage pack base plan is not recognized",
      };
    }
    return {
      valid: true,
      value: {
        tier: context.subscription.tier,
        priceId: context.subscription.stripePlanPriceId,
        projectsOrgPlan: false,
      },
    };
  }
  const planItems = subscription.items.data.filter((item) => {
    return isUsagePackPlanPriceId(item.price.id);
  });
  if (planItems.length !== 1) {
    return {
      valid: false,
      reason: `expected one usage pack base plan, received ${planItems.length}`,
    };
  }
  const planItem = planItems[0];
  if (!planItem) {
    return { valid: false, reason: "missing usage pack base plan" };
  }
  const planQuantity = planItem.quantity ?? 1;
  if (planQuantity !== 1) {
    return {
      valid: false,
      reason: `usage pack base plan quantity must be one, received ${planQuantity}`,
    };
  }
  const tier = tierForKnownPriceId(planItem.price.id);
  if (!tier) {
    return {
      valid: false,
      reason: `usage pack base plan ${planItem.price.id} is not recognized`,
    };
  }
  return {
    valid: true,
    value: {
      tier,
      priceId: planItem.price.id,
      projectsOrgPlan: true,
    },
  };
}

function inspectStripeUsagePackPackages(
  subscription: UsagePackSubscriptionInput,
): InspectedValue<UsagePackPackageShape> {
  const quantities = new Map<string, number>();
  let periodStart: Date | null = null;
  let periodEnd: Date | null = null;
  for (const item of subscription.items.data) {
    if (usagePackUsdForKnownPriceId(item.price.id) === null) {
      continue;
    }
    const quantity = item.quantity ?? 1;
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      return {
        valid: false,
        reason: `usage pack Price ${item.price.id} has invalid quantity ${quantity}`,
      };
    }
    quantities.set(
      item.price.id,
      (quantities.get(item.price.id) ?? 0) + quantity,
    );

    const itemPeriodEnd = unixDate(item.current_period_end);
    const itemPeriodStart = unixDate(item.current_period_start);
    if (!itemPeriodEnd) {
      return {
        valid: false,
        reason: `usage pack Price ${item.price.id} has no current period end`,
      };
    }
    if (periodEnd && periodEnd.getTime() !== itemPeriodEnd.getTime()) {
      return {
        valid: false,
        reason: "usage pack items have different current period ends",
      };
    }
    if (
      periodStart &&
      itemPeriodStart &&
      periodStart.getTime() !== itemPeriodStart.getTime()
    ) {
      return {
        valid: false,
        reason: "usage pack items have different current period starts",
      };
    }
    periodStart ??= itemPeriodStart;
    periodEnd = itemPeriodEnd;
  }
  if (quantities.size === 0) {
    const basePlan = subscription.items.data.find((item) => {
      return isUsagePackPlanPriceId(item.price.id);
    });
    periodStart = unixDate(basePlan?.current_period_start);
    periodEnd = unixDate(basePlan?.current_period_end);
  }
  if (!periodEnd) {
    return {
      valid: false,
      reason: "subscription has no recognized usage pack item",
    };
  }
  return { valid: true, value: { quantities, periodStart, periodEnd } };
}

function inspectAllocationQuantities(
  allocations: readonly UsagePackAllocationRow[],
): InspectedValue<ReadonlyMap<string, number>> {
  const quantities = new Map<string, number>();
  for (const allocation of allocations) {
    const usagePackUsd = usagePackUsdForKnownPriceId(allocation.stripePriceId);
    if (usagePackUsd !== allocation.usagePackUsd) {
      return {
        valid: false,
        reason: `allocation ${allocation.id} has an inconsistent usage pack Price`,
      };
    }
    quantities.set(
      allocation.stripePriceId,
      (quantities.get(allocation.stripePriceId) ?? 0) + 1,
    );
  }
  return { valid: true, value: quantities };
}

function usagePackAllocationsForStripeQuantities(
  context: UsagePackContext,
  stripeQuantities: ReadonlyMap<string, number>,
): InspectedValue<readonly UsagePackAllocationRow[]> {
  const current = invoiceEligibleUsagePackAllocations(context);
  const acceptedPending = context.allocations.filter((allocation) => {
    return (
      allocation.status === "paid_pending_invitation" &&
      allocation.userId !== null
    );
  });
  const candidates =
    acceptedPending.length === 0
      ? [current]
      : [current, [...current, ...acceptedPending]];
  let reason = "Local usage pack allocations do not match Stripe";
  for (const candidate of candidates) {
    const inspected = inspectAllocationQuantities(candidate);
    if (!inspected.valid) {
      reason = inspected.reason;
      continue;
    }
    const mismatch = usagePackQuantityMismatchReason(
      stripeQuantities,
      inspected.value,
    );
    if (!mismatch) {
      return { valid: true, value: candidate };
    }
    reason = mismatch;
  }
  return { valid: false, reason };
}

function usagePackQuantityMismatchReason(
  stripeQuantities: ReadonlyMap<string, number>,
  allocationQuantities: ReadonlyMap<string, number>,
): string | null {
  if (allocationQuantities.size !== stripeQuantities.size) {
    return "Stripe package Prices do not match the allocation snapshot";
  }
  for (const [priceId, quantity] of stripeQuantities) {
    if (allocationQuantities.get(priceId) !== quantity) {
      return `Stripe quantity for ${priceId} does not match the allocation snapshot`;
    }
  }
  return null;
}

function inspectUsagePackSubscriptionShape(
  context: UsagePackContext,
  subscription: UsagePackSubscriptionInput,
): InspectedSubscriptionShape {
  const basePlan = inspectUsagePackBasePlan(context, subscription);
  if (!basePlan.valid) {
    return basePlan;
  }
  const packages = inspectStripeUsagePackPackages(subscription);
  if (!packages.valid) {
    return packages;
  }
  const allocations = usagePackAllocationsForStripeQuantities(
    context,
    packages.value.quantities,
  );
  if (!allocations.valid) {
    return allocations;
  }

  return {
    valid: true,
    shape: {
      tier: basePlan.value.tier,
      planPriceId: basePlan.value.priceId,
      projectsOrgPlan: basePlan.value.projectsOrgPlan,
      periodStart: packages.value.periodStart,
      periodEnd: packages.value.periodEnd,
      packageQuantities: packages.value.quantities,
    },
  };
}

function requireUsagePackSubscriptionShape(
  context: UsagePackContext,
  subscription: UsagePackSubscriptionInput,
): ValidatedSubscriptionShape {
  const inspected = inspectUsagePackSubscriptionShape(context, subscription);
  if (!inspected.valid) {
    throw new Error(
      `Invalid usage pack subscription ${subscription.id}: ${inspected.reason}`,
    );
  }
  return inspected.shape;
}

function validateUsagePackSubscriptionCorrelation(
  context: UsagePackContext,
  subscription: UsagePackSubscriptionInput,
  usagePackSubscriptionId: string,
): void {
  const customerId = stripeObjectId(subscription.customer);
  if (!customerId || customerId !== context.subscription.stripeCustomerId) {
    throw new Error(
      `Stripe customer for usage pack subscription ${subscription.id} does not match the local snapshot`,
    );
  }
  if (
    context.subscription.stripeSubscriptionId &&
    context.subscription.stripeSubscriptionId !== subscription.id
  ) {
    throw new Error(
      `Stripe subscription ${subscription.id} does not match the locally bound subscription`,
    );
  }
  if (context.subscription.stripeSubscriptionId) {
    return;
  }
  const metadataId = oneUsagePackSubscriptionId(subscription.metadata);
  if (metadataId !== usagePackSubscriptionId) {
    throw new Error(
      `Stripe subscription ${subscription.id} is missing its local usage pack correlation`,
    );
  }
}

async function synchronizeUsagePackSubscriptionState(
  db: Db,
  args: {
    readonly usagePackSubscriptionId: string;
    readonly checkoutSessionId?: string;
    readonly subscription: UsagePackSubscriptionInput;
  },
): Promise<UsagePackContext> {
  const context = await loadUsagePackContext(db, args.usagePackSubscriptionId);
  validateUsagePackSubscriptionCorrelation(
    context,
    args.subscription,
    args.usagePackSubscriptionId,
  );
  const shape = requireUsagePackSubscriptionShape(context, args.subscription);
  if (
    args.checkoutSessionId &&
    context.subscription.stripeCheckoutSessionId &&
    context.subscription.stripeCheckoutSessionId !== args.checkoutSessionId
  ) {
    throw new Error(
      `Checkout Session ${args.checkoutSessionId} does not match the local usage pack snapshot`,
    );
  }

  await writeUsagePackPendingSnapshots(
    db,
    [context.subscription.orgId],
    async (tx) => {
      const updatedAt = nowDate();
      const cancelAtPeriodEnd = usagePackSubscriptionWillCancel(
        args.subscription,
      );
      await tx
        .update(usagePackSubscriptions)
        .set({
          tier: shape.tier,
          stripePlanPriceId: shape.planPriceId,
          stripeSubscriptionId: args.subscription.id,
          subscriptionStatus: args.subscription.status,
          cancelAtPeriodEnd,
          updatedAt,
          ...(args.checkoutSessionId
            ? { stripeCheckoutSessionId: args.checkoutSessionId }
            : {}),
        })
        .where(eq(usagePackSubscriptions.id, args.usagePackSubscriptionId));
      if (shape.projectsOrgPlan) {
        await tx
          .update(orgMetadata)
          .set({
            subscriptionStatus: args.subscription.status,
            cancelAtPeriodEnd,
            updatedAt,
          })
          .where(
            and(
              eq(orgMetadata.orgId, context.subscription.orgId),
              eq(orgMetadata.stripeSubscriptionId, args.subscription.id),
            ),
          );
      }
    },
    [args.usagePackSubscriptionId],
  );
  return context;
}

function checkoutPendingSnapshotCounts(
  roots: readonly UsagePackSubscriptionRow[],
  usagePackSubscriptionId: string,
  subscriptionStatus: string,
): { readonly before: number; readonly after: number } {
  const isPending = (status: string) => {
    return status === "checkout_pending" || status === "purchase_pending";
  };
  const previous = roots.filter((root) => {
    return isPending(root.subscriptionStatus);
  });
  const next = roots.filter((root) => {
    return isPending(
      root.id === usagePackSubscriptionId
        ? subscriptionStatus
        : root.subscriptionStatus,
    );
  });
  if (
    next.length > 1 &&
    next.some((root) => {
      return !previous.some((candidate) => {
        return candidate.id === root.id;
      });
    })
  ) {
    throw new Error(
      "Another usage-pack purchase is already pending for this organization",
    );
  }
  return { before: previous.length, after: next.length };
}

/** Conditional-write predicate: the root still has the status we read. */
function unchangedSubscriptionRootWhere(root: UsagePackSubscriptionRow) {
  return and(
    eq(usagePackSubscriptions.id, root.id),
    eq(usagePackSubscriptions.orgId, root.orgId),
    eq(usagePackSubscriptions.subscriptionStatus, root.subscriptionStatus),
  );
}

const publishUsagePackCheckoutState$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly usagePackSubscriptionId: string;
      readonly checkoutSessionId: string;
      readonly customerId: string;
      readonly subscription: UsagePackSubscriptionInput;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const { subscription } = args;
    await db.transaction(async (tx) => {
      // Conditioned on the root state this decision was made from.
      const roots = await tx
        .select()
        .from(usagePackSubscriptions)
        .where(
          or(
            eq(usagePackSubscriptions.orgId, args.orgId),
            eq(usagePackSubscriptions.id, args.usagePackSubscriptionId),
          ),
        )
        .orderBy(asc(usagePackSubscriptions.id));
      if (
        roots.some((root) => {
          return root.orgId !== args.orgId;
        })
      ) {
        throw new Error(
          "Usage pack subscription moved outside its locked scope",
        );
      }
      const localSubscription = roots.find((root) => {
        return root.id === args.usagePackSubscriptionId;
      });
      if (!localSubscription) {
        throw new Error(
          `Unknown usage pack subscription: ${args.usagePackSubscriptionId}`,
        );
      }
      await tx
        .insert(usagePackPendingSnapshotGuards)
        .values({ orgId: args.orgId, pendingSnapshotCount: 0 })
        .onConflictDoNothing();
      const [guard] = await tx
        .select()
        .from(usagePackPendingSnapshotGuards)
        .where(eq(usagePackPendingSnapshotGuards.orgId, args.orgId));
      const counts = checkoutPendingSnapshotCounts(
        roots,
        args.usagePackSubscriptionId,
        subscription.status,
      );
      if (!guard || guard.pendingSnapshotCount !== counts.before) {
        throw new Error("Usage pack pending snapshot guard requires repair");
      }
      const allocations = await tx
        .select()
        .from(usagePackAllocations)
        .where(
          eq(
            usagePackAllocations.usagePackSubscriptionId,
            args.usagePackSubscriptionId,
          ),
        );
      signal.throwIfAborted();
      const context = { subscription: localSubscription, allocations };
      validateUsagePackSubscriptionCorrelation(
        context,
        subscription,
        args.usagePackSubscriptionId,
      );
      if (
        localSubscription.stripeCustomerId !== args.customerId ||
        (localSubscription.stripeCheckoutSessionId &&
          localSubscription.stripeCheckoutSessionId !== args.checkoutSessionId)
      ) {
        throw new Error(
          `Checkout Session ${args.checkoutSessionId} does not match the local usage pack snapshot`,
        );
      }
      const shape = requireUsagePackSubscriptionShape(context, subscription);
      const updatedAt = nowDate();
      const cancelAtPeriodEnd = usagePackSubscriptionWillCancel(subscription);
      const [published] = await tx
        .update(usagePackSubscriptions)
        .set({
          tier: shape.tier,
          stripePlanPriceId: shape.planPriceId,
          stripeSubscriptionId: subscription.id,
          subscriptionStatus: subscription.status,
          stripeCheckoutSessionId: args.checkoutSessionId,
          cancelAtPeriodEnd,
          updatedAt,
        })
        .where(unchangedSubscriptionRootWhere(localSubscription))
        .returning({ id: usagePackSubscriptions.id });
      if (!published) {
        throw new Error("Usage pack snapshot changed during publication");
      }
      if (shape.projectsOrgPlan) {
        await tx
          .update(orgMetadata)
          .set({
            subscriptionStatus: subscription.status,
            cancelAtPeriodEnd,
            updatedAt,
          })
          .where(
            and(
              eq(orgMetadata.orgId, args.orgId),
              eq(orgMetadata.stripeSubscriptionId, subscription.id),
            ),
          );
      }
      // Migration 1132 retired the pending-count trigger. Publish only the
      // actual count transition with the subscription's business writes.
      await publishUsagePackPendingSnapshotCount(
        tx,
        args.orgId,
        counts.before,
        counts.after,
      );
    });
  },
);

export const handleUsagePackCheckoutCompleted$ = command(
  async (
    { set },
    session: UsagePackCheckoutSessionInput,
    subscription: UsagePackSubscriptionInput,
    signal: AbortSignal,
  ): Promise<UsagePackLifecycleOutcome> => {
    const usagePackSubscriptionId = oneUsagePackSubscriptionId(
      session.metadata,
    );
    if (!usagePackSubscriptionId) {
      return { handled: false, orgId: null };
    }
    const customerId = stripeObjectId(session.customer);
    const subscriptionId = stripeObjectId(session.subscription);
    if (!customerId || !subscriptionId) {
      throw new Error(
        `Usage pack Checkout Session ${session.id} is missing its customer or subscription`,
      );
    }
    if (subscription.id !== subscriptionId) {
      throw new Error(
        `Usage pack Checkout Session ${session.id} resolved the wrong subscription`,
      );
    }
    const db = set(writeDb$);
    const [localSubscription] = await db
      .select({ orgId: usagePackSubscriptions.orgId })
      .from(usagePackSubscriptions)
      .where(eq(usagePackSubscriptions.id, usagePackSubscriptionId))
      .limit(1);
    signal.throwIfAborted();
    if (!localSubscription) {
      throw new Error(
        `Unknown usage pack subscription: ${usagePackSubscriptionId}`,
      );
    }
    await set(
      publishUsagePackCheckoutState$,
      {
        orgId: localSubscription.orgId,
        usagePackSubscriptionId,
        checkoutSessionId: session.id,
        customerId,
        subscription,
      },
      signal,
    );
    return { handled: true, orgId: localSubscription.orgId, subscription };
  },
);

async function deactivateInvalidUsagePackSubscription(
  db: Db,
  context: UsagePackContext,
  subscription: UsagePackSubscriptionInput,
  reason: string,
  subscriptionStatus = "invalid",
): Promise<void> {
  await writeUsagePackPendingSnapshots(
    db,
    [context.subscription.orgId],
    async (tx) => {
      const updatedAt = nowDate();
      await tx
        .update(usagePackSubscriptions)
        .set({
          stripeSubscriptionId: subscription.id,
          subscriptionStatus,
          cancelAtPeriodEnd: false,
          updatedAt,
        })
        .where(eq(usagePackSubscriptions.id, context.subscription.id));
      await tx
        .update(usagePackAllocations)
        .set({ status: "inactive", updatedAt })
        .where(
          eq(
            usagePackAllocations.usagePackSubscriptionId,
            context.subscription.id,
          ),
        );

      if (subscriptionHasCustomPlan(subscription)) {
        return;
      }

      const downgraded = await tx
        .update(orgMetadata)
        .set({
          tier: "limited-free-1",
          stripeSubscriptionId: null,
          subscriptionStatus,
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          updatedAt,
        })
        .where(
          and(
            eq(orgMetadata.orgId, context.subscription.orgId),
            eq(orgMetadata.stripeSubscriptionId, subscription.id),
          ),
        )
        .returning({ orgId: orgMetadata.orgId });
      for (const row of downgraded) {
        await upsertOrgPlanEntitlement(tx, {
          orgId: row.orgId,
          tier: "limited-free-1",
          source: "stripe_subscription",
          sourceMetadata: {
            ...subscription.metadata,
            usagePackInvalidReason: reason,
          },
        });
      }
    },
    [context.subscription.id],
  );
}

async function handleUsagePackSubscriptionChanged(
  db: Db,
  eventSubscription: UsagePackSubscriptionInput,
  invalidShape: "throw" | "deactivate",
): Promise<UsagePackLifecycleOutcome> {
  const usagePackSubscriptionId = await resolveUsagePackSubscriptionId(db, {
    stripeSubscriptionId: eventSubscription.id,
    metadata: [eventSubscription.metadata],
  });
  if (!usagePackSubscriptionId) {
    return { handled: false, orgId: null };
  }

  const currentSubscription = (await getStripeClient().subscriptions.retrieve(
    eventSubscription.id,
  )) as UsagePackSubscriptionInput;
  const removedUsagePacksFromCustom =
    invalidShape === "deactivate" &&
    customSubscriptionRemovedUsagePacks(currentSubscription);
  if (removedUsagePacksFromCustom) {
    await reconcileUsagePackAllocationChangeSubscriptionDeleted(
      db,
      currentSubscription,
    );
  } else {
    await reconcileUsagePackAllocationChangeSubscription(
      db,
      currentSubscription,
    );
  }
  const context = await loadUsagePackContext(db, usagePackSubscriptionId);
  validateUsagePackSubscriptionCorrelation(
    context,
    currentSubscription,
    usagePackSubscriptionId,
  );
  const inspected = inspectUsagePackSubscriptionShape(
    context,
    currentSubscription,
  );
  if (removedUsagePacksFromCustom && !inspected.valid) {
    await deactivateInvalidUsagePackSubscription(
      db,
      context,
      currentSubscription,
      inspected.reason,
      "canceled",
    );
    L.debug("usage pack component removed from Custom subscription", {
      usagePackSubscriptionId,
      stripeSubscriptionId: currentSubscription.id,
    });
    return {
      handled: true,
      orgId: context.subscription.orgId,
      subscription: currentSubscription,
    };
  }
  if (
    invalidShape === "deactivate" &&
    (currentSubscription.status === "canceled" ||
      currentSubscription.status === "incomplete_expired")
  ) {
    const reason = `terminal Stripe status ${currentSubscription.status}`;
    await deactivateInvalidUsagePackSubscription(
      db,
      context,
      currentSubscription,
      reason,
      currentSubscription.status,
    );
    return {
      handled: true,
      orgId: context.subscription.orgId,
      subscription: currentSubscription,
    };
  }
  if (!inspected.valid) {
    if (invalidShape === "throw") {
      throw new Error(
        `Invalid usage pack subscription ${currentSubscription.id}: ${inspected.reason}`,
      );
    }
    await deactivateInvalidUsagePackSubscription(
      db,
      context,
      currentSubscription,
      inspected.reason,
    );
    L.warn("invalid usage pack subscription deactivated", {
      usagePackSubscriptionId,
      stripeSubscriptionId: currentSubscription.id,
      reason: inspected.reason,
    });
    return {
      handled: true,
      orgId: context.subscription.orgId,
      subscription: currentSubscription,
    };
  }

  await synchronizeUsagePackSubscriptionState(db, {
    usagePackSubscriptionId,
    subscription: currentSubscription,
  });
  return {
    handled: true,
    orgId: context.subscription.orgId,
    subscription: currentSubscription,
  };
}

export async function handleUsagePackSubscriptionCreated(
  db: Db,
  subscription: UsagePackSubscriptionInput,
): Promise<UsagePackLifecycleOutcome> {
  return await handleUsagePackSubscriptionChanged(db, subscription, "throw");
}

export async function handleUsagePackSubscriptionUpdated(
  db: Db,
  subscription: UsagePackSubscriptionInput,
): Promise<UsagePackLifecycleOutcome> {
  return await handleUsagePackSubscriptionChanged(
    db,
    subscription,
    "deactivate",
  );
}

export async function handleUsagePackSubscriptionDeleted(
  db: Db,
  subscription: Pick<UsagePackSubscriptionInput, "id" | "metadata">,
): Promise<UsagePackLifecycleOutcome> {
  const usagePackSubscriptionId = await resolveUsagePackSubscriptionId(db, {
    stripeSubscriptionId: subscription.id,
    metadata: [subscription.metadata],
  });
  if (!usagePackSubscriptionId) {
    return { handled: false, orgId: null };
  }
  await reconcileUsagePackAllocationChangeSubscriptionDeleted(db, subscription);
  const context = await loadUsagePackContext(db, usagePackSubscriptionId);
  if (
    context.subscription.stripeSubscriptionId &&
    context.subscription.stripeSubscriptionId !== subscription.id
  ) {
    throw new Error(
      `Deleted Stripe subscription ${subscription.id} does not match the local usage pack snapshot`,
    );
  }

  await writeUsagePackPendingSnapshots(
    db,
    [context.subscription.orgId],
    async (tx) => {
      const updatedAt = nowDate();
      await tx
        .update(usagePackSubscriptions)
        .set({
          stripeSubscriptionId: subscription.id,
          subscriptionStatus: "canceled",
          cancelAtPeriodEnd: false,
          updatedAt,
        })
        .where(eq(usagePackSubscriptions.id, usagePackSubscriptionId));
      await tx
        .update(usagePackAllocations)
        .set({ status: "inactive", updatedAt })
        .where(
          eq(
            usagePackAllocations.usagePackSubscriptionId,
            usagePackSubscriptionId,
          ),
        );
    },
    [usagePackSubscriptionId],
  );
  return { handled: true, orgId: context.subscription.orgId };
}

function invoiceSubscriptionId(invoice: UsagePackInvoiceInput): string | null {
  return stripeObjectId(invoice.parent?.subscription_details?.subscription);
}

function invoiceLinePriceId(line: UsagePackInvoiceLineInput): string | null {
  return (
    line.price?.id ?? stripeObjectId(line.pricing?.price_details?.price ?? null)
  );
}

function invoiceLineAmount(line: UsagePackInvoiceLineInput): number | null {
  const amount = line.subtotal ?? line.amount;
  return typeof amount === "number" && Number.isSafeInteger(amount)
    ? amount
    : null;
}

function invoiceLineRefundableAmount(
  line: UsagePackInvoiceLineInput,
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
  const refundableAmount = amount - discountAmount + exclusiveTax;
  return Number.isSafeInteger(refundableAmount) && refundableAmount >= 0
    ? refundableAmount
    : null;
}

function invoiceHasUsagePackLine(invoice: UsagePackInvoiceInput): boolean {
  return (invoice.lines?.data ?? []).some((line) => {
    const priceId = invoiceLinePriceId(line);
    return priceId !== null && usagePackUsdForKnownPriceId(priceId) !== null;
  });
}

function invoiceLineIsProration(line: UsagePackInvoiceLineInput): boolean {
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

function isUsagePackPlanChangeInvoice(invoice: UsagePackInvoiceInput): boolean {
  return (
    invoice.lines.data.some((line) => {
      const priceId = invoiceLinePriceId(line);
      return priceId !== null && isUsagePackPlanPriceId(priceId);
    }) &&
    invoice.lines.data.every((line) => {
      const priceId = invoiceLinePriceId(line);
      return priceId === null || usagePackUsdForKnownPriceId(priceId) === null;
    })
  );
}

async function loadFulfillmentCatalog(
  shape: ValidatedSubscriptionShape,
): Promise<ReadonlyMap<string, ValidatedUsagePackPrice>> {
  const entries = await Promise.all(
    [...shape.packageQuantities.keys()].map(async (priceId) => {
      const usagePackUsd = usagePackUsdForKnownPriceId(priceId);
      if (usagePackUsd === null) {
        throw new Error(`Unknown usage pack Price: ${priceId}`);
      }
      const catalogItem = await loadValidatedUsagePackPrice(
        usagePackUsd,
        priceId,
        { requireActive: false },
      );
      return [priceId, catalogItem] as const;
    }),
  );
  return new Map(entries);
}

function prepareUsagePackPriceCredits(
  invoice: UsagePackInvoiceInput,
  shape: ValidatedSubscriptionShape,
  priceId: string,
  subscriptionQuantity: number,
  catalogItem: ValidatedUsagePackPrice,
): PreparedUsagePackPriceCredits {
  const matchingLines = invoice.lines.data.filter((line) => {
    const amount = invoiceLineAmount(line);
    return (
      invoiceLinePriceId(line) === priceId && amount !== null && amount > 0
    );
  });
  if (matchingLines.length !== 1) {
    throw new Error(
      `Invoice ${invoice.id} must have one positive line for usage pack Price ${priceId}`,
    );
  }
  const line = matchingLines[0];
  if (!line) {
    throw new Error(
      `Invoice ${invoice.id} is missing validated usage pack Price ${priceId}`,
    );
  }
  const lineQuantity = line.quantity ?? 1;
  if (lineQuantity !== subscriptionQuantity) {
    throw new Error(
      `Invoice ${invoice.id} quantity for ${priceId} does not match the subscription`,
    );
  }
  const amount = invoiceLineAmount(line);
  if (amount === null || amount <= 0) {
    throw new Error(
      `Invoice ${invoice.id} has an invalid amount for ${priceId}`,
    );
  }
  const sourceAmountCents = invoiceLineRefundableAmount(line);
  if (sourceAmountCents === null) {
    throw new Error(
      `Invoice ${invoice.id} has an invalid refundable amount for ${priceId}`,
    );
  }
  const fullAmount = catalogItem.unitAmountCents * subscriptionQuantity;
  if (!Number.isSafeInteger(fullAmount) || amount > fullAmount) {
    throw new Error(
      `Invoice ${invoice.id} amount for ${priceId} exceeds its configured Price`,
    );
  }
  if (amount < fullAmount && !invoiceLineIsProration(line)) {
    throw new Error(
      `Invoice ${invoice.id} has a partial non-proration line for ${priceId}`,
    );
  }
  const fraction = amount / fullAmount;
  if (!(fraction > 0 && fraction <= 1)) {
    throw new Error(
      `Invoice ${invoice.id} has an invalid paid fraction for ${priceId}`,
    );
  }

  const periodStart = unixDate(line.period.start);
  const periodEnd = unixDate(line.period.end);
  if (!periodStart || !periodEnd || periodEnd <= periodStart) {
    throw new Error(
      `Invoice ${invoice.id} has an invalid period for ${priceId}`,
    );
  }
  if (periodEnd > shape.periodEnd) {
    throw new Error(
      `Invoice ${invoice.id} period for ${priceId} extends beyond Stripe's current period`,
    );
  }
  return {
    priceId,
    periodStart,
    periodEnd,
    purchasedCredits: Math.floor(catalogItem.purchasedCredits * fraction),
    bonusCredits: Math.floor(catalogItem.bonusCredits * fraction),
    stripeInvoiceLineId: line.id ?? null,
    sourceAmountCents,
    quantity: subscriptionQuantity,
  };
}

function commonUsagePackInvoicePeriod(
  invoiceId: string,
  preparedPrices: readonly PreparedUsagePackPriceCredits[],
): { readonly periodStart: Date; readonly periodEnd: Date } {
  const first = preparedPrices[0];
  if (!first) {
    throw new Error(`Invoice ${invoiceId} has no payable usage pack period`);
  }
  const consistent = preparedPrices.every((prepared) => {
    return (
      prepared.periodStart.getTime() === first.periodStart.getTime() &&
      prepared.periodEnd.getTime() === first.periodEnd.getTime()
    );
  });
  if (!consistent) {
    throw new Error(
      `Invoice ${invoiceId} usage pack lines have inconsistent periods`,
    );
  }
  return { periodStart: first.periodStart, periodEnd: first.periodEnd };
}

function prepareUsagePackAllocationGrants(
  context: UsagePackContext,
  preparedPrices: readonly PreparedUsagePackPriceCredits[],
  stripeQuantities: ReadonlyMap<string, number>,
): readonly PreparedUsagePackAllocationGrant[] {
  const creditsByPriceId = new Map(
    preparedPrices.map((prepared) => {
      return [prepared.priceId, prepared] as const;
    }),
  );
  const allocations = usagePackAllocationsForStripeQuantities(
    context,
    stripeQuantities,
  );
  if (!allocations.valid) {
    throw new Error(allocations.reason);
  }
  const sourceIndexes = new Map<string, number>();
  return [...allocations.value]
    .sort((left, right) => {
      return left.id.localeCompare(right.id);
    })
    .map((allocation) => {
      const credits = creditsByPriceId.get(allocation.stripePriceId);
      if (!credits) {
        throw new Error(
          `Allocation ${allocation.id} has no matching invoice line`,
        );
      }
      const sourceIndex = sourceIndexes.get(allocation.stripePriceId) ?? 0;
      sourceIndexes.set(allocation.stripePriceId, sourceIndex + 1);
      const baseSourceAmount = Math.floor(
        credits.sourceAmountCents / credits.quantity,
      );
      const sourceRemainder = credits.sourceAmountCents % credits.quantity;
      const sourceAmountCents =
        baseSourceAmount + (sourceIndex < sourceRemainder ? 1 : 0);
      return {
        allocationId: allocation.id,
        userId: allocation.userId,
        purchasedCredits: credits.purchasedCredits,
        bonusCredits: credits.bonusCredits,
        stripeInvoiceLineId: credits.stripeInvoiceLineId,
        sourceAmountCents,
      };
    });
}

async function prepareUsagePackFulfillment(
  context: UsagePackContext,
  subscription: UsagePackSubscriptionInput,
  invoice: UsagePackInvoiceInput,
): Promise<{
  readonly shape: ValidatedSubscriptionShape;
  readonly fulfillment: PreparedUsagePackFulfillment;
}> {
  const shape = requireUsagePackSubscriptionShape(context, subscription);
  const subscriptionId = invoiceSubscriptionId(invoice);
  if (subscriptionId !== subscription.id) {
    throw new Error(
      `Invoice ${invoice.id} does not belong to usage pack subscription ${subscription.id}`,
    );
  }
  const invoiceCustomerId = stripeObjectId(invoice.customer);
  if (invoiceCustomerId !== context.subscription.stripeCustomerId) {
    throw new Error(
      `Invoice ${invoice.id} customer does not match the usage pack snapshot`,
    );
  }

  const catalogByPriceId = await loadFulfillmentCatalog(shape);
  const preparedPrices = [...shape.packageQuantities].map(
    ([priceId, subscriptionQuantity]) => {
      const catalogItem = catalogByPriceId.get(priceId);
      if (!catalogItem) {
        throw new Error(`Unknown usage pack Price: ${priceId}`);
      }
      return prepareUsagePackPriceCredits(
        invoice,
        shape,
        priceId,
        subscriptionQuantity,
        catalogItem,
      );
    },
  );
  const { periodStart, periodEnd } = commonUsagePackInvoicePeriod(
    invoice.id,
    preparedPrices,
  );

  return {
    shape,
    fulfillment: {
      periodStart,
      periodEnd,
      allocations: prepareUsagePackAllocationGrants(
        context,
        preparedPrices,
        shape.packageQuantities,
      ),
    },
  };
}

async function usagePackInvoiceAlreadyFulfilled(
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
      `Invoice ${invoiceId} is already bound to a different usage pack subscription`,
    );
  }
  return true;
}

/** Another live subscription already holds the organization entitlement. */
class DuplicateUsagePackEntitlement extends Error {}

async function requireOrgBillingRecord(
  tx: Pick<Db, "select">,
  orgId: string,
  subscription: UsagePackSubscriptionRow,
): Promise<never> {
  const [org] = await tx
    .select({ orgId: orgMetadata.orgId })
    .from(orgMetadata)
    .where(
      and(
        eq(orgMetadata.orgId, orgId),
        eq(orgMetadata.stripeCustomerId, subscription.stripeCustomerId),
      ),
    );
  if (org) {
    throw new DuplicateUsagePackEntitlement(
      `Organization ${orgId} entitlement belongs to another live subscription`,
    );
  }
  throw new Error(
    `Usage pack subscription ${subscription.id} has no matching organization billing record`,
  );
}

const commitUsagePackPlanActivation$ = command(
  async (
    { set },
    args: UsagePackPlanActivation,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const orgId = args.context.subscription.orgId;
    await db.transaction(async (tx) => {
      // The subscription write below is conditional on the root status and
      // prepared allocation set it was decided from, and the pending count is
      // published conditionally on the count read here. Allocation writers only
      // admit active roots, so none races this pending root.
      const roots = await tx
        .select()
        .from(usagePackSubscriptions)
        .where(activationRootsWhere(args))
        .orderBy(asc(usagePackSubscriptions.id));
      const subscription = activationRoot(args, roots);
      await tx
        .insert(usagePackPendingSnapshotGuards)
        .values({ orgId, pendingSnapshotCount: 0 })
        .onConflictDoNothing();
      const [guard] = await tx
        .select()
        .from(usagePackPendingSnapshotGuards)
        .where(eq(usagePackPendingSnapshotGuards.orgId, orgId));
      const counts = activationPendingCounts(args, roots);
      if (!guard || guard.pendingSnapshotCount !== counts.before) {
        throw new Error("Usage pack pending snapshot guard requires repair");
      }
      const allocations = await tx
        .select()
        .from(usagePackAllocations)
        .where(activationAllocationWhere(args))
        .orderBy(asc(usagePackAllocations.id));
      const context = { subscription, allocations };
      validateUsagePackSubscriptionCorrelation(
        context,
        args.subscription,
        subscription.id,
      );
      const shape = requireUsagePackSubscriptionShape(
        context,
        args.subscription,
      );
      if (!shape.periodStart) {
        throw new Error(
          `Usage pack subscription ${args.subscription.id} has no current period start`,
        );
      }
      const values = activationSubscriptionValues(
        args.subscription,
        shape,
        nowDate(),
      );
      const updated = await tx
        .update(usagePackSubscriptions)
        .set(values)
        .where(
          and(
            activationUnchangedAllocationsWhere(args),
            unchangedSubscriptionRootWhere(subscription),
          ),
        )
        .returning({ id: usagePackSubscriptions.id });
      if (updated.length !== 1) {
        throw new Error(
          "Usage pack subscription or allocations changed during plan activation",
        );
      }
      if (shape.projectsOrgPlan) {
        const orgRows = await tx
          .update(orgMetadata)
          .set(activationOrgValues(args.subscription, shape, values.updatedAt))
          .where(
            and(
              eq(orgMetadata.orgId, orgId),
              eq(orgMetadata.stripeCustomerId, subscription.stripeCustomerId),
              orgAcceptsSubscriptionWhere(
                args.subscription.id,
                values.updatedAt,
              ),
            ),
          )
          .returning({ orgId: orgMetadata.orgId });
        if (orgRows.length !== 1) {
          await requireOrgBillingRecord(tx, orgId, subscription);
        }
        const [owner] = await tx
          .select({ orgId: orgPlanEntitlements.orgId })
          .from(orgPlanEntitlements)
          .where(
            eq(orgPlanEntitlements.stripeSubscriptionId, args.subscription.id),
          )
          .limit(1);
        const entitlement = activationEntitlementValues(
          args,
          shape,
          owner?.orgId,
        );
        await tx
          .insert(orgPlanEntitlements)
          .values(entitlement)
          .onConflictDoUpdate({
            target: orgPlanEntitlements.orgId,
            set: entitlement,
          });
      }
      await publishUsagePackPendingSnapshotCount(
        tx,
        orgId,
        counts.before,
        counts.after,
      );
      signal.throwIfAborted();
    });
    signal.throwIfAborted();
  },
);

const activateUsagePackPlanFromSubscription$ = command(
  async (
    { set },
    subscription: UsagePackSubscriptionInput,
    signal: AbortSignal,
  ): Promise<UsagePackLifecycleOutcome> => {
    const db = set(writeDb$);
    let [local] = await db
      .select()
      .from(usagePackSubscriptions)
      .where(
        and(
          eq(usagePackSubscriptions.stripeSubscriptionId, subscription.id),
          notInArray(usagePackSubscriptions.subscriptionStatus, [
            ...TERMINAL_USAGE_PACK_SUBSCRIPTION_STATUSES,
          ]),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!local) {
      const metadataId = oneUsagePackSubscriptionId(subscription.metadata);
      if (!metadataId) {
        return { handled: false, orgId: null };
      }
      [local] = await db
        .select()
        .from(usagePackSubscriptions)
        .where(
          and(
            eq(usagePackSubscriptions.id, metadataId),
            notInArray(usagePackSubscriptions.subscriptionStatus, [
              ...TERMINAL_USAGE_PACK_SUBSCRIPTION_STATUSES,
            ]),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
    }
    if (!local) {
      return { handled: false, orgId: null };
    }
    const allocations = await db
      .select()
      .from(usagePackAllocations)
      .where(
        and(
          eq(usagePackAllocations.usagePackSubscriptionId, local.id),
          inArray(usagePackAllocations.status, [
            ...MANAGED_USAGE_PACK_ALLOCATION_STATUSES,
          ]),
        ),
      );
    signal.throwIfAborted();
    const activated = await settle(
      set(
        commitUsagePackPlanActivation$,
        {
          context: { subscription: local, allocations },
          subscription,
        },
        signal,
      ),
    );
    signal.throwIfAborted();
    if (
      !activated.ok &&
      !(activated.error instanceof DuplicateUsagePackEntitlement)
    ) {
      throw activated.error;
    }
    // A losing duplicate stays unactivated; its paid invoice is refunded.
    signal.throwIfAborted();
    return { handled: true, orgId: local.orgId, subscription };
  },
);

const expireFirstPaidUpgradeDebt$ = command(
  async ({ set }, orgId: string, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    const [debt] = await db
      .select({ orgId: orgMetadata.orgId })
      .from(orgMetadata)
      .where(firstPaidUpgradeDebtWhere(orgId));
    signal.throwIfAborted();
    if (debt) {
      await set(expireOrgCredits$, orgId, signal);
    }
  },
);

const commitUsagePackFulfillment$ = command(
  async (
    { set },
    args: CommitUsagePackFulfillmentArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const prepared = fulfillmentPreparedWrites(args);
    const orgId = args.context.subscription.orgId;
    await set(expireFirstPaidUpgradeDebt$, orgId, signal);
    await db.transaction(async (tx) => {
      // Duplicate invoice deliveries queue on the root rows below and then see
      // the committed receipt; allocation rows read for the grant snapshot are
      // likewise held.
      const roots = await tx
        .select()
        .from(usagePackSubscriptions)
        .where(fulfillmentRootsWhere(args))
        .orderBy(asc(usagePackSubscriptions.id))
        .for("update");
      const owned = fulfillmentRootSnapshot(args, roots);
      const { subscription, pendingCount } = owned;
      await tx
        .insert(usagePackPendingSnapshotGuards)
        .values({ orgId, pendingSnapshotCount: 0 })
        .onConflictDoNothing();
      const [guard] = await tx
        .select()
        .from(usagePackPendingSnapshotGuards)
        .where(eq(usagePackPendingSnapshotGuards.orgId, orgId))
        .for("update");
      if (!guard || guard.pendingSnapshotCount !== pendingCount) {
        throw new Error("Usage pack pending snapshot guard requires repair");
      }
      const [receipt] = await tx
        .select()
        .from(usagePackInvoiceFulfillments)
        .where(
          eq(usagePackInvoiceFulfillments.stripeInvoiceId, args.invoice.id),
        );
      if (fulfillmentReceiptCommitted(args, receipt)) {
        return;
      }
      const allocations = await tx
        .select()
        .from(usagePackAllocations)
        .where(fulfillmentAllocationWhere(args, subscription))
        .orderBy(asc(usagePackAllocations.id))
        .for("update");
      requireFulfillmentAllocationSnapshot(args, allocations, subscription);
      await tx
        .select({ orgId: orgMetadata.orgId })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, orgId))
        .for("update");
      const debtWhere = firstPaidUpgradeDebtWhere(orgId);
      const [debt] = await tx
        .select({ orgId: orgMetadata.orgId })
        .from(orgMetadata)
        .where(debtWhere);
      if (debt) {
        const [pending] = await tx
          .select()
          .from(pendingOrgCreditExpirationQuery(orgId, nowDate()));
        requireNoPendingOrgCreditExpiration(orgId, pending);
        await tx
          .update(orgMetadata)
          .set({ credits: 0, updatedAt: nowDate() })
          .where(debtWhere);
      }
      for (const statement of prepared.grants) {
        if ((await tx.execute(statement)).rowCount !== 1) {
          throw new Error(
            "Usage pack credit grant or refund source identity changed",
          );
        }
      }
      const at = nowDate();
      const projection = fulfillmentProjection(args, subscription, at);
      if (projection.advance && args.fulfillment.allocations.length > 0) {
        await tx
          .update(usagePackAllocations)
          .set({ ...prepared.allocationValues, updatedAt: at })
          .where(prepared.allocationWhere);
      }
      if (Object.keys(projection.values).length > 0) {
        await tx
          .update(usagePackSubscriptions)
          .set(projection.values)
          .where(eq(usagePackSubscriptions.id, subscription.id));
      }
      if (projection.advance && args.shape.projectsOrgPlan) {
        const orgs = await tx
          .update(orgMetadata)
          .set(projection.orgValues)
          .where(projection.orgWhere)
          .returning({ orgId: orgMetadata.orgId });
        if (orgs.length !== 1) {
          await requireOrgBillingRecord(tx, orgId, subscription);
        }
        const [owner] = await tx
          .select({ orgId: orgPlanEntitlements.orgId })
          .from(orgPlanEntitlements)
          .where(
            eq(orgPlanEntitlements.stripeSubscriptionId, args.subscription.id),
          )
          .limit(1);
        const values = fulfillmentPlanEntitlement(args, owner?.orgId);
        await tx.insert(orgPlanEntitlements).values(values).onConflictDoUpdate({
          target: orgPlanEntitlements.orgId,
          set: values,
        });
      }
      await tx.insert(usagePackInvoiceFulfillments).values(prepared.receipt);
      await publishUsagePackPendingSnapshotCount(
        tx,
        orgId,
        pendingCount,
        finalFulfillmentPendingCount(args, owned, projection.advance),
      );
      signal.throwIfAborted();
    });
    signal.throwIfAborted();
  },
);

/** Commit a fulfillment, or refund it when another live subscription won. */
const commitOrRefundUsagePackFulfillment$ = command(
  async (
    { set },
    args: CommitUsagePackFulfillmentArgs,
    signal: AbortSignal,
  ): Promise<"committed" | "refunded"> => {
    const committed = await settle(
      set(commitUsagePackFulfillment$, args, signal),
    );
    signal.throwIfAborted();
    if (committed.ok) {
      return "committed";
    }
    if (!(committed.error instanceof DuplicateUsagePackEntitlement)) {
      throw committed.error;
    }
    await refundDuplicateSubscriptionInvoice(
      args.invoice,
      args.subscription.id,
    );
    signal.throwIfAborted();
    L.warn("usage pack duplicate purchase refunded", {
      invoiceId: args.invoice.id,
      usagePackSubscriptionId: args.context.subscription.id,
    });
    return "refunded";
  },
);

export const handleUsagePackInvoicePaid$ = command(
  async (
    { set },
    invoice: UsagePackInvoiceInput,
    signal: AbortSignal,
  ): Promise<UsagePackLifecycleOutcome> => {
    const db = set(writeDb$);
    const hasUsagePackLine = invoiceHasUsagePackLine(invoice);
    const usagePackSubscriptionId = await resolveUsagePackSubscriptionId(db, {
      stripeSubscriptionId: invoiceSubscriptionId(invoice),
      metadata: [
        invoice.metadata,
        invoice.parent?.subscription_details?.metadata,
      ],
      includeTerminalBinding: hasUsagePackLine,
    });
    signal.throwIfAborted();
    if (!usagePackSubscriptionId) {
      return { handled: false, orgId: null };
    }
    const subscriptionChangeOutcome =
      await handleUsagePackSubscriptionChangeInvoicePaid(db, invoice);
    signal.throwIfAborted();
    if (subscriptionChangeOutcome.handled) {
      await set(
        activateUsagePackPlanFromSubscription$,
        subscriptionChangeOutcome.subscription,
        signal,
      );
      signal.throwIfAborted();
      return {
        handled: true,
        orgId: subscriptionChangeOutcome.orgId,
        subscription: subscriptionChangeOutcome.subscription,
      };
    }
    const changeOutcome = await handleUsagePackAllocationChangeInvoicePaid(
      db,
      invoice,
    );
    signal.throwIfAborted();
    if (changeOutcome.handled) {
      return changeOutcome;
    }
    if (!hasUsagePackLine && !isUsagePackPlanChangeInvoice(invoice)) {
      return { handled: false, orgId: null };
    }
    const context = await loadUsagePackContext(db, usagePackSubscriptionId);
    signal.throwIfAborted();
    const fulfilled = await usagePackInvoiceAlreadyFulfilled(
      db,
      invoice.id,
      usagePackSubscriptionId,
    );
    signal.throwIfAborted();
    if (fulfilled) {
      return { handled: true, orgId: context.subscription.orgId };
    }

    const subscriptionId = invoiceSubscriptionId(invoice);
    if (!subscriptionId) {
      throw new Error(
        `Usage pack invoice ${invoice.id} is missing its Stripe subscription`,
      );
    }
    const subscription = (await getStripeClient().subscriptions.retrieve(
      subscriptionId,
    )) as UsagePackSubscriptionInput;
    signal.throwIfAborted();
    await reconcileUsagePackAllocationChangeSubscription(db, subscription);
    signal.throwIfAborted();
    const reconciledContext = await loadUsagePackContext(
      db,
      usagePackSubscriptionId,
    );
    signal.throwIfAborted();
    validateUsagePackSubscriptionCorrelation(
      reconciledContext,
      subscription,
      usagePackSubscriptionId,
    );
    if (isUsagePackPlanChangeInvoice(invoice)) {
      const shape = requireUsagePackSubscriptionShape(
        reconciledContext,
        subscription,
      );
      await set(activateUsagePackPlanFromSubscription$, subscription, signal);
      signal.throwIfAborted();
      await db
        .insert(usagePackInvoiceFulfillments)
        .values({
          stripeInvoiceId: invoice.id,
          usagePackSubscriptionId,
          periodStart: shape.periodStart,
          periodEnd: shape.periodEnd,
        })
        .onConflictDoNothing();
      signal.throwIfAborted();
      return { handled: true, orgId: reconciledContext.subscription.orgId };
    }
    const prepared = await prepareUsagePackFulfillment(
      reconciledContext,
      subscription,
      invoice,
    );
    signal.throwIfAborted();
    const outcome = await set(
      commitOrRefundUsagePackFulfillment$,
      {
        context: reconciledContext,
        subscription,
        invoice,
        ...prepared,
      },
      signal,
    );
    signal.throwIfAborted();
    if (outcome === "refunded") {
      return { handled: true, orgId: reconciledContext.subscription.orgId };
    }

    L.debug("usage pack invoice fulfilled", {
      invoiceId: invoice.id,
      usagePackSubscriptionId,
      orgId: reconciledContext.subscription.orgId,
      allocations: prepared.fulfillment.allocations.length,
      periodEnd: prepared.fulfillment.periodEnd.toISOString(),
    });
    return { handled: true, orgId: reconciledContext.subscription.orgId };
  },
);

interface ReconcileUsagePackSubscriptionResult {
  readonly reconciled: number;
  readonly orgIds: readonly string[];
}

const retireReconciledUsagePackSnapshot$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly usagePackSubscriptionId: string;
      readonly expiredCheckoutSessionId: string | null;
      readonly staleBefore: Date;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    const db = set(writeDb$);
    await db.transaction(async (tx) => {
      // The retirement below is a conditional status transition.
      const roots = await tx
        .select({
          id: usagePackSubscriptions.id,
          orgId: usagePackSubscriptions.orgId,
          status: usagePackSubscriptions.subscriptionStatus,
        })
        .from(usagePackSubscriptions)
        .where(
          or(
            eq(usagePackSubscriptions.orgId, args.orgId),
            eq(usagePackSubscriptions.id, args.usagePackSubscriptionId),
          ),
        )
        .orderBy(asc(usagePackSubscriptions.id));
      if (
        roots.some((root) => {
          return root.orgId !== args.orgId;
        })
      ) {
        throw new Error(
          "Usage pack subscription moved outside its locked scope",
        );
      }
      await tx
        .insert(usagePackPendingSnapshotGuards)
        .values({
          orgId: args.orgId,
          pendingSnapshotCount: 0,
        })
        .onConflictDoNothing();
      const [guard] = await tx
        .select()
        .from(usagePackPendingSnapshotGuards)
        .where(eq(usagePackPendingSnapshotGuards.orgId, args.orgId));
      const pendingCount = roots.filter((root) => {
        return (
          root.status === "checkout_pending" ||
          root.status === "purchase_pending"
        );
      }).length;
      if (!guard || guard.pendingSnapshotCount !== pendingCount) {
        throw new Error("Usage pack pending snapshot guard requires repair");
      }
      signal.throwIfAborted();
      const updatedAt = nowDate();
      const retired = await tx
        .update(usagePackSubscriptions)
        .set({ subscriptionStatus: "checkout_expired", updatedAt })
        .where(
          and(
            eq(usagePackSubscriptions.id, args.usagePackSubscriptionId),
            eq(usagePackSubscriptions.orgId, args.orgId),
            inArray(usagePackSubscriptions.subscriptionStatus, [
              ...USAGE_PACK_PURCHASE_SNAPSHOT_STATUSES,
            ]),
            isNull(usagePackSubscriptions.stripeSubscriptionId),
            args.expiredCheckoutSessionId === null
              ? and(
                  isNull(usagePackSubscriptions.stripeCheckoutSessionId),
                  lte(usagePackSubscriptions.updatedAt, args.staleBefore),
                )
              : eq(
                  usagePackSubscriptions.stripeCheckoutSessionId,
                  args.expiredCheckoutSessionId,
                ),
          ),
        )
        .returning({ id: usagePackSubscriptions.id });
      if (retired.length > 0) {
        await tx
          .update(usagePackAllocations)
          .set({ status: "inactive", updatedAt })
          .where(
            eq(
              usagePackAllocations.usagePackSubscriptionId,
              args.usagePackSubscriptionId,
            ),
          );
      }
      await publishUsagePackPendingSnapshotCount(
        tx,
        args.orgId,
        pendingCount,
        pendingCount - retired.length,
      );
    });
  },
);

/**
 * A stale claim: its winner stopped before publishing. Stripe is read by the
 * claim's idempotent identity; a created subscription is returned for the
 * normal synchronization, otherwise the claim retires without any provider
 * write. Other candidates pass through with their bound subscription.
 */
async function resolveStaleClaim(
  db: Db,
  stripe: StripeClient,
  candidate: UsagePackSubscriptionRow,
  signal: AbortSignal,
): Promise<
  | { readonly kind: "retired" }
  | { readonly kind: "subscription"; readonly subscriptionId: string | null }
> {
  if (
    candidate.stripeSubscriptionId ||
    candidate.stripeCheckoutSessionId ||
    candidate.subscriptionStatus !== USAGE_PACK_PURCHASE_CLAIM_STATUS
  ) {
    return {
      kind: "subscription",
      subscriptionId: candidate.stripeSubscriptionId,
    };
  }
  const subscriptions = await listAllStripeSubscriptions(
    stripe,
    { customer: candidate.stripeCustomerId, status: "all" },
    signal,
  );
  const created = subscriptions.find((subscription) => {
    return (
      subscription.metadata?.[USAGE_PACK_SUBSCRIPTION_ID_METADATA_KEY] ===
      candidate.id
    );
  });
  if (created) {
    return { kind: "subscription", subscriptionId: created.id };
  }
  await retireUsagePackPurchaseClaim(db, candidate.orgId, candidate.id);
  signal.throwIfAborted();
  return { kind: "retired" };
}

const reconcileUsagePackSubscriptionCandidate$ = command(
  async (
    { set },
    candidate: UsagePackSubscriptionRow,
    pendingSnapshotStaleBefore: Date,
    signal: AbortSignal,
  ): Promise<ReconcileUsagePackSubscriptionResult> => {
    const db = set(writeDb$);
    const stripe = getStripeClient();
    const orgIds = new Set<string>();
    const claim = await resolveStaleClaim(db, stripe, candidate, signal);
    if (claim.kind === "retired") {
      return { reconciled: 0, orgIds: [] };
    }
    let subscriptionId = claim.subscriptionId;
    if (!subscriptionId && !candidate.stripeCheckoutSessionId) {
      await set(
        retireReconciledUsagePackSnapshot$,
        {
          orgId: candidate.orgId,
          usagePackSubscriptionId: candidate.id,
          expiredCheckoutSessionId: null,
          staleBefore: pendingSnapshotStaleBefore,
        },
        signal,
      );
      signal.throwIfAborted();
      return { reconciled: 0, orgIds: [] };
    }
    if (!subscriptionId && candidate.stripeCheckoutSessionId) {
      const session = (await stripe.checkout.sessions.retrieve(
        candidate.stripeCheckoutSessionId,
      )) as UsagePackCheckoutSessionInput;
      signal.throwIfAborted();
      if (session.status !== "complete") {
        if (session.status === "expired") {
          await set(
            retireReconciledUsagePackSnapshot$,
            {
              orgId: candidate.orgId,
              usagePackSubscriptionId: candidate.id,
              expiredCheckoutSessionId: candidate.stripeCheckoutSessionId,
              staleBefore: pendingSnapshotStaleBefore,
            },
            signal,
          );
          signal.throwIfAborted();
        }
        return { reconciled: 0, orgIds: [] };
      }
      subscriptionId = stripeObjectId(session.subscription);
      if (!subscriptionId) {
        throw new Error(
          `Completed usage pack Checkout Session ${session.id} has no subscription`,
        );
      }
      const checkoutSubscription = (await stripe.subscriptions.retrieve(
        subscriptionId,
      )) as UsagePackSubscriptionInput;
      signal.throwIfAborted();
      const checkoutOutcome = await set(
        handleUsagePackCheckoutCompleted$,
        session,
        checkoutSubscription,
        signal,
      );
      signal.throwIfAborted();
      if (!checkoutOutcome.handled) {
        throw new Error(
          `Usage pack Checkout Session ${session.id} lost its local correlation`,
        );
      }
      if (checkoutOutcome.orgId) {
        orgIds.add(checkoutOutcome.orgId);
      }
    }
    if (!subscriptionId) {
      return { reconciled: 0, orgIds: [...orgIds] };
    }

    const subscription = (await stripe.subscriptions.retrieve(
      subscriptionId,
    )) as UsagePackSubscriptionInput;
    signal.throwIfAborted();
    const syncOutcome = await handleUsagePackSubscriptionUpdated(
      db,
      subscription,
    );
    signal.throwIfAborted();
    if (!syncOutcome.handled) {
      throw new Error(
        `Usage pack subscription ${subscriptionId} lost its local correlation`,
      );
    }
    if (syncOutcome.orgId) {
      orgIds.add(syncOutcome.orgId);
    }
    if (
      subscription.status === "canceled" ||
      subscription.status === "incomplete_expired"
    ) {
      return { reconciled: 0, orgIds: [...orgIds] };
    }

    const invoices = await stripe.invoices.list({
      subscription: subscriptionId,
      status: "paid",
      limit: 1,
    });
    signal.throwIfAborted();
    const invoice = invoices.data[0] as UsagePackInvoiceInput | undefined;
    if (!invoice) {
      return { reconciled: 0, orgIds: [...orgIds] };
    }
    const invoiceOutcome = await set(
      handleUsagePackInvoicePaid$,
      invoice,
      signal,
    );
    signal.throwIfAborted();
    if (!invoiceOutcome.handled) {
      throw new Error(
        `Paid usage pack invoice ${invoice.id} lost its local correlation`,
      );
    }
    if (invoiceOutcome.orgId) {
      orgIds.add(invoiceOutcome.orgId);
    }
    return { reconciled: 1, orgIds: [...orgIds] };
  },
);

export const reconcileUsagePackSubscriptions$ = command(
  async (
    { set },
    scope: BillingReconciliationScope | undefined,
    signal: AbortSignal,
  ): Promise<
    ReconcileUsagePackSubscriptionResult & {
      readonly emptyCancellations: readonly EmptyUsagePackCancellation[];
    }
  > => {
    signal.throwIfAborted();
    const db = set(writeDb$);

    const subscriptionChanges = await reconcileUsagePackSubscriptionChanges(
      db,
      scope,
      signal,
    );
    const allocationChanges = await reconcileUsagePackAllocationChanges(
      db,
      scope,
      signal,
    );

    const at = nowDate();
    const staleBefore = new Date(
      at.getTime() - USAGE_PACK_RECONCILIATION_DELAY_MS,
    );
    const pendingSnapshotStaleBefore = new Date(
      at.getTime() - USAGE_PACK_PENDING_SNAPSHOT_STALE_MS,
    );
    const claimStaleBefore = new Date(
      at.getTime() - USAGE_PACK_PURCHASE_CLAIM_STALE_MS,
    );
    const candidates = await db
      .select()
      .from(usagePackSubscriptions)
      .where(
        and(
          scope
            ? inArray(usagePackSubscriptions.orgId, [...scope.orgIds])
            : undefined,
          or(
            and(
              isNull(usagePackSubscriptions.stripeSubscriptionId),
              isNull(usagePackSubscriptions.stripeCheckoutSessionId),
              inArray(usagePackSubscriptions.subscriptionStatus, [
                ...USAGE_PACK_PURCHASE_SNAPSHOT_STATUSES,
              ]),
              lte(usagePackSubscriptions.updatedAt, pendingSnapshotStaleBefore),
            ),
            and(
              isNull(usagePackSubscriptions.stripeSubscriptionId),
              isNull(usagePackSubscriptions.stripeCheckoutSessionId),
              eq(
                usagePackSubscriptions.subscriptionStatus,
                USAGE_PACK_PURCHASE_CLAIM_STATUS,
              ),
              lte(usagePackSubscriptions.updatedAt, claimStaleBefore),
            ),
            and(
              isNull(usagePackSubscriptions.stripeSubscriptionId),
              isNotNull(usagePackSubscriptions.stripeCheckoutSessionId),
              eq(usagePackSubscriptions.subscriptionStatus, "checkout_pending"),
              lte(usagePackSubscriptions.updatedAt, staleBefore),
            ),
            and(
              isNotNull(usagePackSubscriptions.stripeSubscriptionId),
              notInArray(usagePackSubscriptions.subscriptionStatus, [
                ...TERMINAL_USAGE_PACK_SUBSCRIPTION_STATUSES,
              ]),
              or(
                and(
                  isNull(usagePackSubscriptions.currentPeriodEnd),
                  lte(usagePackSubscriptions.updatedAt, staleBefore),
                ),
                lte(usagePackSubscriptions.currentPeriodEnd, at),
                and(
                  inArray(usagePackSubscriptions.subscriptionStatus, [
                    "past_due",
                    "unpaid",
                  ]),
                  lte(usagePackSubscriptions.updatedAt, staleBefore),
                ),
              ),
            ),
          ),
        ),
      )
      .limit(100);
    signal.throwIfAborted();

    const orgIds = new Set([
      ...subscriptionChanges.orgIds,
      ...allocationChanges.orgIds,
    ]);
    let reconciled =
      subscriptionChanges.reconciled + allocationChanges.reconciled;
    for (const candidate of candidates) {
      const result = await settle(
        set(
          reconcileUsagePackSubscriptionCandidate$,
          candidate,
          pendingSnapshotStaleBefore,
          signal,
        ),
        signal,
      );
      if (!result.ok) {
        L.error("usage pack subscription reconciliation failed", {
          usagePackSubscriptionId: candidate.id,
          orgId: candidate.orgId,
          stripeSubscriptionId: candidate.stripeSubscriptionId,
          stripeCheckoutSessionId: candidate.stripeCheckoutSessionId,
          error: result.error,
        });
        continue;
      }
      reconciled += result.value.reconciled;
      for (const orgId of result.value.orgIds) {
        orgIds.add(orgId);
      }
    }
    return {
      reconciled,
      orgIds: [...orgIds],
      emptyCancellations: allocationChanges.emptyCancellations,
    };
  },
);
