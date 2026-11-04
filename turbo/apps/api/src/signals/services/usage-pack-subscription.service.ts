import {
  activationAllocationWhere,
  activationEntitlementValues,
  activationEntitlementInsertValues,
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
import {
  iso,
  literal,
  number,
  object,
  string,
  uuid,
  enum as zEnum,
  url as zUrl,
  type infer as zInfer,
} from "zod";

import {
  and,
  asc,
  desc,
  eq,
  exists,
  count,
  sql,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notInArray,
  or,
} from "drizzle-orm";

import { logger } from "../../lib/log";
import { safeSqlStateCode } from "../../lib/pg-errors";
import { pgIntegerDecoder } from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import {
  getStripeClient,
  listAllStripeSubscriptions,
  type StripeClient,
  type StripeInvoice,
  type StripeMetadataParam,
  type StripePrice,
  type StripeSubscription,
} from "../external/stripe-client";
import { settle, settleIncludingAbort } from "../utils";
import { getOrCreateStripeCustomer$ } from "./billing-customer.service";
import { refundDuplicateSubscriptionInvoice } from "./billing-duplicate-subscription.service";

import { stripePreviewMetadata } from "./stripe-preview-metadata.service";
import {
  handleUsagePackAllocationChangeInvoicePaid$,
  reconcileUsagePackAllocationChanges$,
  reconcileUsagePackAllocationChangeSubscription$,
  reconcileUsagePackAllocationChangeSubscriptionDeleted$,
} from "./usage-pack-allocation-change.service";
import {
  handleUsagePackSubscriptionChangeInvoicePaid$,
  reconcileUsagePackSubscriptionChanges$,
} from "./usage-pack-plan-change.service";
import { completeBillingOperationInvoiceWithInvoice } from "./billing-operation-invoice.service";
import {
  assertPendingSnapshotPublished,
  usagePackPendingSnapshotCountWrite,
  writeUsagePackPendingSnapshots$,
  pendingSnapshotResult,
} from "./usage-pack-pending-snapshot.service";
import {
  usagePackCheckoutAllocationsMatch,
  usagePackCheckoutConfigurationMatches,
  pendingUsagePackCheckoutFingerprint,
  UsagePackPendingSnapshotConflict,
} from "./usage-pack-pending-snapshot-plan";
import {
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
export const MANAGED_USAGE_PACK_ALLOCATION_STATUSES = [
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
export const TERMINAL_USAGE_PACK_SUBSCRIPTION_STATUSES = [
  "canceled",
  "incomplete_expired",
  "invalid",
] as const;
const L = logger("UsagePackSubscription");

type UsagePackSubscriptionRow = typeof usagePackSubscriptions.$inferSelect;
type UsagePackAllocationRow = typeof usagePackAllocations.$inferSelect;

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

export interface CreateUsagePackCheckoutSessionArgs {
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

const usagePackPurchasePreviewTokenSchema = object({
  version: literal(1),
  usagePackSubscriptionId: uuid(),
  orgId: string().min(1),
  customerId: string().min(1),
  sourceSubscriptionId: string().min(1).nullable(),
  paymentMethodId: string().min(1),
  tier: zEnum(["pro", "team"]),
  planPriceId: string().min(1),
  immediateAmountCents: number().int().nonnegative(),
  nextRecurringAmountCents: number().int().nonnegative(),
  currency: string().length(3),
  successUrl: zUrl(),
  cancelUrl: zUrl(),
  expiresAt: iso.datetime(),
});

type UsagePackPurchasePreviewToken = zInfer<
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
  readonly amount_paid: number;
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

export interface UsagePackContext {
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

const pendingUsagePackCheckoutContexts$ = command(
  async function pendingUsagePackCheckoutContexts(
    { get },
    orgId: string,
  ): Promise<readonly UsagePackContext[]> {
    const db = get(db$);

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
  },
);

export interface PreparedPendingUsagePackCheckout {
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

function hasCheckoutSession(context: UsagePackContext): boolean {
  return context.subscription.stripeCheckoutSessionId !== null;
}

/**
 * Stripe reads and expirations run before the billing_purchase compatibility
 * transaction. A superseded open Session is expired before its snapshot
 * retires, preserving the "never an unretired payable Session" order. The
 * commit below re-reads the rows; if a Checkout-bearing row moved, the request
 * fails with a conflict instead of re-running.
 */
const preparePendingUsagePackCheckout$ = command(
  async function preparePendingUsagePackCheckout(
    { set },
    args: CreateUsagePackCheckoutSessionArgs,
    customerId: string,
    signal: AbortSignal,
  ): Promise<PreparedPendingUsagePackCheckout> {
    const stripe = getStripeClient();
    const contexts = await set(pendingUsagePackCheckoutContexts$, args.orgId);
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
  },
);

/**
 * Local-only commit of a prepared resolution; performs no provider I/O.
 * Session-less snapshots are resolved from the rows read here, so concurrent
 * identical requests converge on one snapshot without any re-run.
 */

type PreparedUsagePackPurchaseSnapshot =
  | { readonly kind: "conflict" }
  | { readonly kind: "redirect"; readonly url: string }
  | { readonly kind: "snapshot"; readonly usagePackSubscriptionId: string };

/**
 * One pass: provider reads, then one local commit. A concurrent request that
 * changed a Checkout-bearing row makes this one a deterministic conflict.
 */
const prepareUsagePackPurchaseSnapshot$ = command(
  async function prepareUsagePackPurchaseSnapshot(
    { set },
    args: CreateUsagePackCheckoutSessionArgs,
    customerId: string,
    signal: AbortSignal,
  ): Promise<PreparedUsagePackPurchaseSnapshot> {
    const prepared = await set(
      preparePendingUsagePackCheckout$,
      args,
      customerId,
      signal,
    );
    return pendingSnapshotResult(
      await set(
        writeUsagePackPendingSnapshots$,
        { kind: "prepare-purchase", purchase: args, customerId, prepared },
        signal,
      ),
      "prepare-purchase",
    );
  },
);

type UsagePackCheckoutCorrelation =
  "correlated" | "superseded" | "retired" | "changed";

/**
 * Publish one known Session only to the same actual uncorrelated purchase
 * owner and commercial snapshot. Conditional publication, not an advisory
 * acquisition, selects the canonical Session before its URL is exposed.
 */
const correlateUsagePackCheckout$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly usagePackSubscriptionId: string;
      readonly sessionId: string;
      readonly customerId: string;
      readonly planPriceId: string;
      readonly tier: CreateUsagePackCheckoutSessionArgs["tier"];
    },
  ): Promise<UsagePackCheckoutCorrelation> => {
    const db = set(writeDb$);
    const correlated = await db
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
    const [current] = await db
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
    const [replacement] = await db
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
  },
);

/**
 * Correlate a Session created by the claim winner itself. Moving the claimed
 * snapshot back to a pending status goes through the pending-snapshot
 * transaction; no other pending snapshot can exist while the claim holds.
 */
const correlateClaimedUsagePackCheckout$ = command(
  async function correlateClaimedUsagePackCheckout(
    { set },
    args: {
      readonly orgId: string;
      readonly usagePackSubscriptionId: string;
      readonly sessionId: string;
      readonly customerId: string;
      readonly planPriceId: string;
      readonly tier: CreateUsagePackCheckoutSessionArgs["tier"];
    },
  ): Promise<UsagePackCheckoutCorrelation> {
    return pendingSnapshotResult(
      await set(writeUsagePackPendingSnapshots$, {
        kind: "correlate-claim",
        orgId: args.orgId,
        rootId: args.usagePackSubscriptionId,
        sessionId: args.sessionId,
        customerId: args.customerId,
        planPriceId: args.planPriceId,
        tier: args.tier,
      }),
      "correlate-claim",
    );
  },
);

/**
 * Create and correlate the Checkout Session of a selected snapshot. Returns
 * null when the snapshot was retired without a successor or taken by another
 * transition; the caller reports a conflict instead of selecting again.
 */
const createUsagePackCheckoutForSnapshot$ = command(
  async (
    { set },
    args: {
      readonly purchase: CreateUsagePackCheckoutSessionArgs;
      readonly customerId: string;
      readonly usagePackSubscriptionId: string;
      readonly fromClaim?: boolean;
    },
  ): Promise<string | null> => {
    const stripe = getStripeClient();
    const metadata = usagePackSubscriptionMetadata({
      orgId: args.purchase.orgId,
      tier: args.purchase.tier,
      planPriceId: args.purchase.planPriceId,
      usagePackSubscriptionId: args.usagePackSubscriptionId,
    });
    const session = await stripe.checkout.sessions.create(
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
      await stripe.checkout.sessions.expire(session.id);
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
      ? await set(correlateClaimedUsagePackCheckout$, correlationArgs)
      : await set(correlateUsagePackCheckout$, correlationArgs);
    if (correlation === "correlated") {
      return session.url;
    }
    // The Session never became payable through a retained snapshot.
    await stripe.checkout.sessions.expire(session.id);
    if (correlation === "superseded") {
      // A later purchase retired this snapshot after it was selected: the same
      // outcome as this request completing first and then being superseded.
      return session.url;
    }
    return null;
  },
);

const createUsagePackCheckout$ = command(
  async (
    { set },
    args: CreateUsagePackCheckoutSessionArgs,
    customerId: string,
    usagePackSubscriptionId: string,
    signal: AbortSignal,
  ): Promise<StartUsagePackPurchaseResult> => {
    // Provider I/O runs after the snapshot selection commits; the Session is
    // published by the conditional correlation, and a lost correlation is a
    // deterministic conflict.
    const url = await set(createUsagePackCheckoutForSnapshot$, {
      purchase: args,
      customerId,
      usagePackSubscriptionId,
    });
    signal.throwIfAborted();
    return url === null ? { status: "conflict" } : { status: "checkout", url };
  },
);

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

    const prepared = await set(
      prepareUsagePackPurchaseSnapshot$,
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
    return await set(
      createUsagePackCheckout$,
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
    const prepared = await set(
      prepareUsagePackPurchaseSnapshot$,
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
      return await set(
        createUsagePackCheckout$,
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
const claimUsagePackPurchase$ = command(async function claimUsagePackPurchase(
  { set },
  orgId: string,
  preview: UsagePackPurchasePreviewToken,
): Promise<boolean> {
  const at = nowDate();
  const planClaimStaleBefore = new Date(
    at.getTime() - PLAN_PURCHASE_CLAIM_STALE_MS,
  );
  return pendingSnapshotResult(
    await set(writeUsagePackPendingSnapshots$, {
      kind: "claim-purchase",
      orgId,
      rootId: preview.usagePackSubscriptionId,
      at,
      planClaimStaleBefore,
    }),
    "claim-purchase",
  );
});

/**
 * Retire a claim that never created a subscription. The claim status is not
 * a pending-snapshot status, so the guard count does not change.
 */
const retireUsagePackPurchaseClaim$ = command(
  async (
    { set },
    orgId: string,
    usagePackSubscriptionId: string,
  ): Promise<void> => {
    const db = set(writeDb$);
    const updatedAt = nowDate();
    const retired = db.$with("retired_purchase_claim").as(
      db
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
        .returning({ id: usagePackSubscriptions.id }),
    );
    // Only an actual returned parent owns retirement of all associated children.
    await db
      .with(retired)
      .update(usagePackAllocations)
      .set({ status: "inactive", updatedAt })
      .from(retired)
      .where(eq(usagePackAllocations.usagePackSubscriptionId, retired.id));
  },
);

/**
 * Publish the winner's subscription to its claimed snapshot. A webhook that
 * already bound the same idempotent subscription counts as published.
 */
const publishUsagePackPurchaseSubscription$ = command(
  async function publishUsagePackPurchaseSubscription(
    { set },
    orgId: string,
    usagePackSubscriptionId: string,
    subscription: StripeSubscription,
  ): Promise<boolean> {
    return pendingSnapshotResult(
      await set(writeUsagePackPendingSnapshots$, {
        kind: "publish-purchase",
        orgId,
        rootId: usagePackSubscriptionId,
        subscription,
      }),
      "publish-purchase",
    );
  },
);

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

const confirmUsagePackPurchaseSnapshot$ = command(
  async (
    { set },
    orgId: string,
    preview: UsagePackPurchasePreviewToken,
    snapshot: UsagePackPurchaseSnapshot,
    providerSignal: AbortSignal,
  ): Promise<ConfirmUsagePackPurchaseResult> => {
    const existingResult = await existingUsagePackPurchaseResult(
      preview,
      snapshot,
      providerSignal,
    );
    if (existingResult) {
      return existingResult;
    }
    if (!(await set(claimUsagePackPurchase$, orgId, preview))) {
      // Deterministic loser: another purchase owns the organization. No
      // provider call was made.
      return { status: "invalid_preview" };
    }
    providerSignal.throwIfAborted();
    const stripe = getStripeClient();
    // Before creation nothing irreversible exists, so a failure retires the
    // claim and its preview. After creation the claim stays until published
    // here, by the subscription webhook, or by reconciliation.
    const admitted = await settleIncludingAbort(
      admitClaimedUsagePackPurchase(
        stripe,
        orgId,
        preview,
        snapshot,
        providerSignal,
      ),
    );
    if (!admitted.ok) {
      await set(
        retireUsagePackPurchaseClaim$,
        orgId,
        preview.usagePackSubscriptionId,
      );
      throw admitted.error;
    }
    const admission = admitted.value;
    if (admission.kind === "invalid") {
      await set(
        retireUsagePackPurchaseClaim$,
        orgId,
        preview.usagePackSubscriptionId,
      );
      return { status: "invalid_preview" };
    }
    if (admission.kind === "checkout") {
      const checkout = await settleIncludingAbort(
        set(createUsagePackCheckoutForSnapshot$, {
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
      );
      if (!checkout.ok) {
        await set(
          retireUsagePackPurchaseClaim$,
          orgId,
          preview.usagePackSubscriptionId,
        );
        throw checkout.error;
      }
      const checkoutUrl = checkout.value;
      providerSignal.throwIfAborted();
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
    providerSignal.throwIfAborted();
    if (
      !(await set(
        publishUsagePackPurchaseSubscription$,
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
    providerSignal.throwIfAborted();
    return await completeUsagePackPurchaseSubscription(
      stripe,
      preview,
      subscription,
      providerSignal,
    );
  },
);

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
    const snapshot = await (async (
      stageSignal: AbortSignal,
    ): Promise<UsagePackPurchaseSnapshot | null> => {
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
      stageSignal.throwIfAborted();
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
    })(signal);
    if (!snapshot) {
      return { status: "invalid_preview" };
    }
    return await set(
      confirmUsagePackPurchaseSnapshot$,
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
    Readonly<Record<string, string>> | null | undefined
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

function stripeObjectId(value: StripeObjectReference | null | undefined) {
  return typeof value === "string" ? value : (value?.id ?? null);
}

function unixDate(value: number | null | undefined): Date | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return null;
  }
  return new Date(value * 1000);
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

const synchronizeUsagePackSubscriptionState$ = command(
  async function synchronizeUsagePackSubscriptionState(
    { set },
    args: {
      readonly usagePackSubscriptionId: string;
      readonly checkoutSessionId?: string;
      readonly subscription: UsagePackSubscriptionInput;
    },
  ): Promise<UsagePackContext> {
    const context = await set(
      loadUsagePackContextOwned$,
      args.usagePackSubscriptionId,
    );
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

    pendingSnapshotResult(
      await set(writeUsagePackPendingSnapshots$, {
        kind: "synchronize",
        orgId: context.subscription.orgId,
        rootId: args.usagePackSubscriptionId,
        checkoutSessionId: args.checkoutSessionId,
        subscription: args.subscription,
        shape,
      }),
      "synchronize",
    );
    return context;
  },
);

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

function usagePackCheckoutRoot(
  roots: readonly UsagePackSubscriptionRow[],
  orgId: string,
  usagePackSubscriptionId: string,
) {
  if (
    roots.some((root) => {
      return root.orgId !== orgId;
    })
  ) {
    throw new Error("Usage pack subscription moved outside its locked scope");
  }
  const subscription = roots.find((root) => {
    return root.id === usagePackSubscriptionId;
  });
  if (!subscription) {
    throw new Error(
      `Unknown usage pack subscription: ${usagePackSubscriptionId}`,
    );
  }
  return subscription;
}

interface UsagePackCheckoutPublication {
  readonly orgId: string;
  readonly usagePackSubscriptionId: string;
  readonly checkoutSessionId: string;
  readonly customerId: string;
  readonly subscription: UsagePackSubscriptionInput;
}

function assertUsagePackCheckoutPendingCount(
  guard: { readonly pendingSnapshotCount: number } | undefined,
  before: number,
): void {
  if (guard ? guard.pendingSnapshotCount !== before : before !== 0) {
    throw new Error("Usage pack pending snapshot guard requires repair");
  }
}

function usagePackCheckoutPublicationShape(
  context: UsagePackContext,
  args: UsagePackCheckoutPublication,
) {
  validateUsagePackSubscriptionCorrelation(
    context,
    args.subscription,
    args.usagePackSubscriptionId,
  );
  if (
    context.subscription.stripeCustomerId !== args.customerId ||
    (context.subscription.stripeCheckoutSessionId &&
      context.subscription.stripeCheckoutSessionId !== args.checkoutSessionId)
  ) {
    throw new Error(
      `Checkout Session ${args.checkoutSessionId} does not match the local usage pack snapshot`,
    );
  }
  return requireUsagePackSubscriptionShape(context, args.subscription);
}

function usagePackCheckoutPublicationValues(
  args: UsagePackCheckoutPublication,
  shape: ValidatedSubscriptionShape,
  updatedAt: Date,
) {
  const cancelAtPeriodEnd = usagePackSubscriptionWillCancel(args.subscription);
  return {
    root: {
      tier: shape.tier,
      stripePlanPriceId: shape.planPriceId,
      stripeSubscriptionId: args.subscription.id,
      subscriptionStatus: args.subscription.status,
      stripeCheckoutSessionId: args.checkoutSessionId,
      cancelAtPeriodEnd,
      updatedAt,
    },
    org: {
      subscriptionStatus: args.subscription.status,
      cancelAtPeriodEnd,
      updatedAt,
    },
  };
}

const publishUsagePackCheckoutState$ = command(
  async (
    { get, set },
    args: UsagePackCheckoutPublication,
    signal: AbortSignal,
  ): Promise<void> => {
    const readDb = get(db$);
    const { subscription } = args;
    const roots = await readDb
      .select()
      .from(usagePackSubscriptions)
      .where(
        or(
          eq(usagePackSubscriptions.orgId, args.orgId),
          eq(usagePackSubscriptions.id, args.usagePackSubscriptionId),
        ),
      )
      .orderBy(asc(usagePackSubscriptions.id));
    signal.throwIfAborted();
    const localSubscription = usagePackCheckoutRoot(
      roots,
      args.orgId,
      args.usagePackSubscriptionId,
    );
    const [guard] = await readDb
      .select()
      .from(usagePackPendingSnapshotGuards)
      .where(eq(usagePackPendingSnapshotGuards.orgId, args.orgId));
    signal.throwIfAborted();
    const counts = checkoutPendingSnapshotCounts(
      roots,
      args.usagePackSubscriptionId,
      subscription.status,
    );
    assertUsagePackCheckoutPendingCount(guard, counts.before);
    const allocations = await readDb
      .select()
      .from(usagePackAllocations)
      .where(
        eq(
          usagePackAllocations.usagePackSubscriptionId,
          args.usagePackSubscriptionId,
        ),
      );
    signal.throwIfAborted();
    const shape = usagePackCheckoutPublicationShape(
      { subscription: localSubscription, allocations },
      args,
    );
    const values = usagePackCheckoutPublicationValues(args, shape, nowDate());
    const db = set(writeDb$);
    const published = db
      .$with("published_usage_pack_checkout")
      .as(
        db
          .update(usagePackSubscriptions)
          .set(values.root)
          .where(unchangedSubscriptionRootWhere(localSubscription))
          .returning({ id: usagePackSubscriptions.id }),
      );
    const projected = db.$with("projected_usage_pack_checkout").as(
      db
        .update(orgMetadata)
        .set(values.org)
        .where(
          and(
            eq(orgMetadata.orgId, args.orgId),
            eq(orgMetadata.stripeSubscriptionId, subscription.id),
            shape.projectsOrgPlan ? undefined : sql`false`,
            exists(db.select({ id: published.id }).from(published)),
          ),
        )
        .returning({ orgId: orgMetadata.orgId }),
    );
    // The existing count condition arbitrates both bootstrap and publication.
    // Only the actual root winner can create or advance the guard.
    const publishedCount = db.$with("published_checkout_pending_count").as(
      db
        .insert(usagePackPendingSnapshotGuards)
        .select(
          db
            .select({
              orgId: sql`${args.orgId}`
                .mapWith(usagePackPendingSnapshotGuards.orgId)
                .as("org_id"),
              pendingSnapshotCount: sql`${counts.after}::int`
                .mapWith(usagePackPendingSnapshotGuards.pendingSnapshotCount)
                .as("pending_snapshot_count"),
            })
            .from(published)
            .where(eq(published.id, args.usagePackSubscriptionId)),
        )
        .onConflictDoUpdate({
          target: usagePackPendingSnapshotGuards.orgId,
          set: { pendingSnapshotCount: counts.after },
          setWhere: eq(
            usagePackPendingSnapshotGuards.pendingSnapshotCount,
            counts.before,
          ),
        })
        .returning({ orgId: usagePackPendingSnapshotGuards.orgId }),
    );
    const publication = await settleIncludingAbort(
      (async () => {
        // An aggregate emits even for a lost root. A lost count publication
        // instead raises 22012 and rolls back the root and optional projection.
        return await db
          .with(published, projected, publishedCount)
          .select({
            roots: count(published.id),
            guard:
              sql`(CASE WHEN ${count(published.id)} = 0 THEN 1 ELSE 1 / ${count(publishedCount.orgId)} END)::int`.mapWith(
                pgIntegerDecoder,
              ),
          })
          .from(published)
          .leftJoin(publishedCount, eq(publishedCount.orgId, args.orgId));
      })(),
    );
    signal.throwIfAborted();
    if (!publication.ok) {
      if (safeSqlStateCode(publication.error) === "22012") {
        throw new UsagePackPendingSnapshotConflict(
          "Usage pack pending snapshot count changed during publication",
          { cause: publication.error },
        );
      }
      throw publication.error;
    }
    if (publication.value[0]?.roots !== 1) {
      throw new Error("Usage pack snapshot changed during publication");
    }
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

const deactivateInvalidUsagePackSubscription$ = command(
  async function deactivateInvalidUsagePackSubscription(
    { set },
    context: UsagePackContext,
    subscription: UsagePackSubscriptionInput,
    reason: string,
    subscriptionStatus: string | undefined = "invalid",
  ): Promise<void> {
    pendingSnapshotResult(
      await set(writeUsagePackPendingSnapshots$, {
        kind: "deactivate",
        orgId: context.subscription.orgId,
        rootId: context.subscription.id,
        subscription,
        reason,
        status: subscriptionStatus,
      }),
      "deactivate",
    );
  },
);

const handleUsagePackSubscriptionChanged$ = command(
  async function handleUsagePackSubscriptionChanged(
    { set },
    eventSubscription: UsagePackSubscriptionInput,
    invalidShape: "throw" | "deactivate",
  ): Promise<UsagePackLifecycleOutcome> {
    const usagePackSubscriptionId = await set(
      resolveUsagePackSubscriptionIdOwned$,
      {
        stripeSubscriptionId: eventSubscription.id,
        metadata: [eventSubscription.metadata],
      },
    );
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
      await set(
        reconcileUsagePackAllocationChangeSubscriptionDeleted$,
        currentSubscription,
      );
    } else {
      await set(
        reconcileUsagePackAllocationChangeSubscription$,
        currentSubscription,
      );
    }
    const context = await set(
      loadUsagePackContextOwned$,
      usagePackSubscriptionId,
    );
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
      await set(
        deactivateInvalidUsagePackSubscription$,
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
      await set(
        deactivateInvalidUsagePackSubscription$,
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
      await set(
        deactivateInvalidUsagePackSubscription$,
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

    await set(synchronizeUsagePackSubscriptionState$, {
      usagePackSubscriptionId,
      subscription: currentSubscription,
    });
    return {
      handled: true,
      orgId: context.subscription.orgId,
      subscription: currentSubscription,
    };
  },
);

export const handleUsagePackSubscriptionCreated$ = command(
  async function handleUsagePackSubscriptionCreated(
    { set },
    subscription: UsagePackSubscriptionInput,
  ): Promise<UsagePackLifecycleOutcome> {
    return await set(
      handleUsagePackSubscriptionChanged$,
      subscription,
      "throw",
    );
  },
);

export const handleUsagePackSubscriptionUpdated$ = command(
  async function handleUsagePackSubscriptionUpdated(
    { set },
    subscription: UsagePackSubscriptionInput,
  ): Promise<UsagePackLifecycleOutcome> {
    return await set(
      handleUsagePackSubscriptionChanged$,
      subscription,
      "deactivate",
    );
  },
);

export const handleUsagePackSubscriptionDeleted$ = command(
  async function handleUsagePackSubscriptionDeleted(
    { set },
    subscription: Pick<UsagePackSubscriptionInput, "id" | "metadata">,
  ): Promise<UsagePackLifecycleOutcome> {
    const usagePackSubscriptionId = await set(
      resolveUsagePackSubscriptionIdOwned$,
      {
        stripeSubscriptionId: subscription.id,
        metadata: [subscription.metadata],
      },
    );
    if (!usagePackSubscriptionId) {
      return { handled: false, orgId: null };
    }
    await set(
      reconcileUsagePackAllocationChangeSubscriptionDeleted$,
      subscription,
    );
    const context = await set(
      loadUsagePackContextOwned$,
      usagePackSubscriptionId,
    );
    if (
      context.subscription.stripeSubscriptionId &&
      context.subscription.stripeSubscriptionId !== subscription.id
    ) {
      throw new Error(
        `Deleted Stripe subscription ${subscription.id} does not match the local usage pack snapshot`,
      );
    }

    pendingSnapshotResult(
      await set(writeUsagePackPendingSnapshots$, {
        kind: "delete",
        orgId: context.subscription.orgId,
        rootId: usagePackSubscriptionId,
        subscriptionId: subscription.id,
      }),
      "delete",
    );
    return { handled: true, orgId: context.subscription.orgId };
  },
);

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

const usagePackInvoiceAlreadyFulfilled$ = command(
  async function usagePackInvoiceAlreadyFulfilled(
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
    if (!existing) {
      return false;
    }
    if (existing.usagePackSubscriptionId !== usagePackSubscriptionId) {
      throw new Error(
        `Invoice ${invoiceId} is already bound to a different usage pack subscription`,
      );
    }
    return true;
  },
);

/** Another live subscription already holds the organization entitlement. */
class DuplicateUsagePackEntitlement extends Error {}

function throwUsagePackOrgBillingMismatch(
  org: { readonly orgId: string } | undefined,
  orgId: string,
  subscription: UsagePackSubscriptionRow,
): never {
  if (org) {
    throw new DuplicateUsagePackEntitlement(
      `Organization ${orgId} entitlement belongs to another live subscription`,
    );
  }
  throw new Error(
    `Usage pack subscription ${subscription.id} has no matching organization billing record`,
  );
}

function subscriptionOrgWhere(
  orgId: string,
  subscription: UsagePackSubscriptionRow,
) {
  return and(
    eq(orgMetadata.orgId, orgId),
    eq(orgMetadata.stripeCustomerId, subscription.stripeCustomerId),
  );
}

const activationPublicationFailureSchema = object({
  code: literal("22P02"),
  message: zEnum([
    'invalid input syntax for type integer: "usage_pack_activation_root"',
    'invalid input syntax for type integer: "usage_pack_activation_org"',
    'invalid input syntax for type integer: "usage_pack_activation_count"',
  ]),
});

const prepareUsagePackPlanActivation$ = command(
  async ({ get }, args: UsagePackPlanActivation, signal: AbortSignal) => {
    const readDb = get(db$);
    const orgId = args.context.subscription.orgId;
    const roots = await readDb
      .select()
      .from(usagePackSubscriptions)
      .where(activationRootsWhere(args))
      .orderBy(asc(usagePackSubscriptions.id));
    signal.throwIfAborted();
    const subscription = activationRoot(args, roots);
    const [guard] = await readDb
      .select()
      .from(usagePackPendingSnapshotGuards)
      .where(eq(usagePackPendingSnapshotGuards.orgId, orgId));
    signal.throwIfAborted();
    const counts = activationPendingCounts(args, roots);
    assertUsagePackCheckoutPendingCount(guard, counts.before);
    const allocations = await readDb
      .select()
      .from(usagePackAllocations)
      .where(activationAllocationWhere(args))
      .orderBy(asc(usagePackAllocations.id));
    signal.throwIfAborted();
    const context = { subscription, allocations };
    validateUsagePackSubscriptionCorrelation(
      context,
      args.subscription,
      subscription.id,
    );
    const shape = requireUsagePackSubscriptionShape(context, args.subscription);
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
    const [owner] = shape.projectsOrgPlan
      ? await readDb
          .select({ orgId: orgPlanEntitlements.orgId })
          .from(orgPlanEntitlements)
          .where(
            eq(orgPlanEntitlements.stripeSubscriptionId, args.subscription.id),
          )
          .limit(1)
      : [];
    signal.throwIfAborted();
    const entitlement = activationEntitlementValues(args, shape, owner?.orgId);
    return { orgId, subscription, guard, counts, shape, values, entitlement };
  },
);

const commitUsagePackPlanActivation$ = command(
  async (
    { get, set },
    args: UsagePackPlanActivation,
    signal: AbortSignal,
  ): Promise<void> => {
    const { orgId, subscription, guard, counts, shape, values, entitlement } =
      await set(prepareUsagePackPlanActivation$, args, signal);
    const db = set(writeDb$);
    const activated = db.$with("activated_usage_pack_plan").as(
      db
        .update(usagePackSubscriptions)
        .set(values)
        .where(
          and(
            activationUnchangedAllocationsWhere(args),
            unchangedSubscriptionRootWhere(subscription),
          ),
        )
        .returning({ id: usagePackSubscriptions.id }),
    );
    const projected = db.$with("projected_usage_pack_plan").as(
      db
        .update(orgMetadata)
        .set(activationOrgValues(args.subscription, shape, values.updatedAt))
        .where(
          and(
            eq(orgMetadata.orgId, orgId),
            eq(orgMetadata.stripeCustomerId, subscription.stripeCustomerId),
            orgAcceptsSubscriptionWhere(args.subscription.id, values.updatedAt),
            shape.projectsOrgPlan ? undefined : sql`false`,
            exists(db.select({ id: activated.id }).from(activated)),
          ),
        )
        .returning({ orgId: orgMetadata.orgId }),
    );
    const installed = db.$with("activated_usage_pack_entitlement").as(
      db
        .insert(orgPlanEntitlements)
        .select(
          sql`SELECT ${activationEntitlementInsertValues(entitlement)} FROM ${projected}`,
        )
        .onConflictDoUpdate({
          target: orgPlanEntitlements.orgId,
          set: entitlement,
        })
        .returning({ orgId: orgPlanEntitlements.orgId }),
    );
    const countInsert = db.insert(usagePackPendingSnapshotGuards).select(
      db
        .select({
          orgId: sql`${orgId}`
            .mapWith(usagePackPendingSnapshotGuards.orgId)
            .as("org_id"),
          pendingSnapshotCount: sql`${counts.after}::int`
            .mapWith(usagePackPendingSnapshotGuards.pendingSnapshotCount)
            .as("pending_snapshot_count"),
        })
        .from(activated)
        .where(
          shape.projectsOrgPlan
            ? exists(db.select({ orgId: installed.orgId }).from(installed))
            : undefined,
        ),
    );
    const publishedCount = db.$with("activated_usage_pack_pending_count").as(
      (counts.before === counts.after
        ? countInsert.onConflictDoNothing()
        : countInsert.onConflictDoUpdate({
            target: usagePackPendingSnapshotGuards.orgId,
            set: { pendingSnapshotCount: counts.after },
            setWhere: eq(
              usagePackPendingSnapshotGuards.pendingSnapshotCount,
              counts.before,
            ),
          })
      ).returning({ orgId: usagePackPendingSnapshotGuards.orgId }),
    );
    const rootCount = sql`(${db.select({ value: count() }).from(activated)})`;
    const orgCount = sql`(${db.select({ value: count() }).from(projected)})`;
    const countPublished = or(
      exists(db.select({ orgId: publishedCount.orgId }).from(publishedCount)),
      counts.before === counts.after && guard !== undefined
        ? sql`true`
        : undefined,
    );
    // Every failed publication aborts the statement, including earlier CTE writes.
    // Distinct internal sentinels preserve the root, duplicate-plan and count errors.
    const publication = await settleIncludingAbort(
      (async () => {
        return await db
          .with(activated, projected, installed, publishedCount)
          .select({
            committed: sql`(CASE
              WHEN ${rootCount} <> 1 THEN 'usage_pack_activation_root'
              WHEN ${shape.projectsOrgPlan} AND ${orgCount} <> 1 THEN 'usage_pack_activation_org'
              WHEN NOT (${countPublished}) THEN 'usage_pack_activation_count'
              ELSE '1' END)::int`.mapWith(pgIntegerDecoder),
          })
          .from(sql`(SELECT 1) AS usage_pack_activation_result`);
      })(),
    );
    signal.throwIfAborted();
    if (publication.ok) {
      return;
    }
    const failure = activationPublicationFailureSchema.safeParse(
      publication.error instanceof Error ? publication.error.cause : undefined,
    );
    if (!failure.success) {
      throw publication.error;
    }
    if (failure.data.message.endsWith('"usage_pack_activation_root"')) {
      throw new Error(
        "Usage pack subscription or allocations changed during plan activation",
        { cause: publication.error },
      );
    }
    if (failure.data.message.endsWith('"usage_pack_activation_count"')) {
      throw new UsagePackPendingSnapshotConflict(
        "Usage pack pending snapshot count changed during publication",
        { cause: publication.error },
      );
    }
    const [org] = await get(db$)
      .select({ orgId: orgMetadata.orgId })
      .from(orgMetadata)
      .where(subscriptionOrgWhere(orgId, subscription));
    signal.throwIfAborted();
    throwUsagePackOrgBillingMismatch(org, orgId, subscription);
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
    // eslint-disable-next-line api/no-db-transaction -- Billing atomicity: invoice grants/refund sources, receipt and subscription/allocation/organization/count publication must roll back together on a later financial rejection; single-statement alternative: one CTE snapshot cannot preserve fresh receipt/allocation reads after subscription-lock waits or later whole-invoice grant/count rejection.
    await db.transaction(async (tx) => {
      // Duplicate invoice deliveries queue on the root rows below and then see
      // the committed receipt; the receipt primary key and the grant
      // idempotency keys keep the grant single either way.
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
        .orderBy(asc(usagePackAllocations.id));
      requireFulfillmentAllocationSnapshot(args, allocations, subscription);
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
          await (async (): Promise<never> => {
            const [org] = await tx
              .select({ orgId: orgMetadata.orgId })
              .from(orgMetadata)
              .where(subscriptionOrgWhere(orgId, subscription));
            return throwUsagePackOrgBillingMismatch(org, orgId, subscription);
          })();
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
      const countWrite = usagePackPendingSnapshotCountWrite(
        orgId,
        pendingCount,
        finalFulfillmentPendingCount(args, owned, projection.advance),
      );
      if (countWrite) {
        const [publishedCount] = await tx
          .update(usagePackPendingSnapshotGuards)
          .set(countWrite.values)
          .where(countWrite.condition)
          .returning({ orgId: usagePackPendingSnapshotGuards.orgId });
        assertPendingSnapshotPublished(publishedCount);
      }
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
    const hasUsagePackLine = invoiceHasUsagePackLine(invoice);
    const usagePackSubscriptionId = await set(
      resolveUsagePackSubscriptionIdOwned$,
      {
        stripeSubscriptionId: invoiceSubscriptionId(invoice),
        metadata: [
          invoice.metadata,
          invoice.parent?.subscription_details?.metadata,
        ],
        includeTerminalBinding: hasUsagePackLine,
      },
    );
    signal.throwIfAborted();
    if (!usagePackSubscriptionId) {
      return { handled: false, orgId: null };
    }
    const subscriptionChangeOutcome = await set(
      handleUsagePackSubscriptionChangeInvoicePaid$,
      invoice,
    );
    signal.throwIfAborted();
    if (subscriptionChangeOutcome.handled) {
      await set(
        activateUsagePackPlanFromSubscription$,
        subscriptionChangeOutcome.subscription,
        signal,
      );
      signal.throwIfAborted();
      return subscriptionChangeOutcome;
    }
    const changeOutcome = await set(
      handleUsagePackAllocationChangeInvoicePaid$,
      invoice,
    );
    signal.throwIfAborted();
    if (changeOutcome.handled) {
      return changeOutcome;
    }
    if (!hasUsagePackLine && !isUsagePackPlanChangeInvoice(invoice)) {
      return { handled: false, orgId: null };
    }
    const context = await set(
      loadUsagePackContextOwned$,
      usagePackSubscriptionId,
    );
    signal.throwIfAborted();
    const fulfilled = await set(
      usagePackInvoiceAlreadyFulfilled$,
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
    await set(reconcileUsagePackAllocationChangeSubscription$, subscription);
    signal.throwIfAborted();
    const reconciledContext = await set(
      loadUsagePackContextOwned$,
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
      await set(savePlanChangeInvoiceReceipt$, {
        invoiceId: invoice.id,
        usagePackSubscriptionId,
        periodStart: shape.periodStart,
        periodEnd: shape.periodEnd,
      });
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

interface RetireReconciledUsagePackSnapshotArgs {
  readonly orgId: string;
  readonly usagePackSubscriptionId: string;
  readonly expiredCheckoutSessionId: string | null;
  readonly staleBefore: Date;
}

function reconciledSnapshotRetirementWhere(
  args: RetireReconciledUsagePackSnapshotArgs,
) {
  return and(
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
  );
}

function reconciledSnapshotPendingCount(
  roots: readonly {
    readonly orgId: string;
    readonly status: string;
  }[],
  orgId: string,
): number {
  if (
    roots.some((root) => {
      return root.orgId !== orgId;
    })
  ) {
    throw new Error("Usage pack subscription moved outside its locked scope");
  }
  return roots.filter((root) => {
    return (
      root.status === "checkout_pending" || root.status === "purchase_pending"
    );
  }).length;
}

const retireReconciledUsagePackSnapshot$ = command(
  async (
    { set },
    args: RetireReconciledUsagePackSnapshotArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    const db = set(writeDb$);
    const roots = await db
      .select({
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
    signal.throwIfAborted();
    const pendingCount = reconciledSnapshotPendingCount(roots, args.orgId);
    const [guard] = await db
      .select()
      .from(usagePackPendingSnapshotGuards)
      .where(eq(usagePackPendingSnapshotGuards.orgId, args.orgId));
    signal.throwIfAborted();
    assertUsagePackCheckoutPendingCount(guard, pendingCount);
    const updatedAt = nowDate();
    // Only the actual retirement can deactivate allocations and decrement the
    // existing pending count. All three writes share this one statement.
    const retired = db
      .$with("retired_reconciled_usage_pack_snapshot")
      .as(
        db
          .update(usagePackSubscriptions)
          .set({ subscriptionStatus: "checkout_expired", updatedAt })
          .where(reconciledSnapshotRetirementWhere(args))
          .returning({ id: usagePackSubscriptions.id }),
      );
    const deactivated = db
      .$with("deactivated_reconciled_usage_pack_snapshot")
      .as(
        db
          .update(usagePackAllocations)
          .set({ status: "inactive", updatedAt })
          .where(
            and(
              eq(
                usagePackAllocations.usagePackSubscriptionId,
                args.usagePackSubscriptionId,
              ),
              exists(db.select({ id: retired.id }).from(retired)),
            ),
          )
          .returning({ id: usagePackAllocations.id }),
      );
    const after = sql`${pendingCount} - (${db.select({ count: count() }).from(retired)})`;
    const countWrite = guard
      ? db
          .update(usagePackPendingSnapshotGuards)
          .set({ pendingSnapshotCount: after })
          .where(
            and(
              eq(usagePackPendingSnapshotGuards.orgId, args.orgId),
              eq(
                usagePackPendingSnapshotGuards.pendingSnapshotCount,
                pendingCount,
              ),
              exists(db.select({ id: retired.id }).from(retired)),
            ),
          )
          .returning({ orgId: usagePackPendingSnapshotGuards.orgId })
      : db
          .insert(usagePackPendingSnapshotGuards)
          .values({ orgId: args.orgId, pendingSnapshotCount: after })
          .onConflictDoUpdate({
            target: usagePackPendingSnapshotGuards.orgId,
            set: { pendingSnapshotCount: after },
            setWhere: eq(
              usagePackPendingSnapshotGuards.pendingSnapshotCount,
              pendingCount,
            ),
          })
          .returning({ orgId: usagePackPendingSnapshotGuards.orgId });
    const published = db
      .$with("published_reconciled_snapshot_count")
      .as(countWrite);
    // The aggregate also runs for an empty retirement. A lost count write raises
    // 22012, rolling back every CTE, including a newly bootstrapped zero guard.
    const publication = await settleIncludingAbort(
      db
        .with(retired, deactivated, published)
        .select({
          guard:
            sql`(CASE WHEN ${count(retired.id)} = 0 AND ${guard !== undefined} THEN 1 ELSE 1 / (${db.select({ count: count() }).from(published)}) END)::int`.mapWith(
              pgIntegerDecoder,
            ),
        })
        .from(retired),
    );
    signal.throwIfAborted();
    if (!publication.ok) {
      if (safeSqlStateCode(publication.error) === "22012") {
        throw new UsagePackPendingSnapshotConflict(
          "Usage pack pending snapshot count changed during publication",
          { cause: publication.error },
        );
      }
      throw publication.error;
    }
  },
);

/**
 * A stale claim: its winner stopped before publishing. Stripe is read by the
 * claim's idempotent identity; a created subscription is returned for the
 * normal synchronization, otherwise the claim retires without any provider
 * write. Other candidates pass through with their bound subscription.
 */
const resolveStaleClaim$ = command(
  async (
    { set },
    candidate: UsagePackSubscriptionRow,
    signal: AbortSignal,
  ): Promise<
    | { readonly kind: "retired" }
    | { readonly kind: "subscription"; readonly subscriptionId: string | null }
  > => {
    const stripe = getStripeClient();
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
    await set(retireUsagePackPurchaseClaim$, candidate.orgId, candidate.id);
    signal.throwIfAborted();
    return { kind: "retired" };
  },
);

const reconcileUsagePackSubscriptionCandidate$ = command(
  async (
    { set },
    candidate: UsagePackSubscriptionRow,
    pendingSnapshotStaleBefore: Date,
    signal: AbortSignal,
  ): Promise<ReconcileUsagePackSubscriptionResult> => {
    const stripe = getStripeClient();
    const orgIds = new Set<string>();
    const claim = await set(resolveStaleClaim$, candidate, signal);
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
    const syncOutcome = await set(
      handleUsagePackSubscriptionUpdated$,
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
    signal: AbortSignal,
  ): Promise<
    ReconcileUsagePackSubscriptionResult & {
      readonly emptyCancellations: readonly EmptyUsagePackCancellation[];
    }
  > => {
    signal.throwIfAborted();
    const db = set(writeDb$);

    const subscriptionChanges = await set(
      reconcileUsagePackSubscriptionChanges$,
      signal,
    );
    const allocationChanges = await set(
      reconcileUsagePackAllocationChanges$,
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

const resolveUsagePackSubscriptionIdOwned$ = command(
  async function resolveUsagePackSubscriptionIdOwned(
    { get },
    args: {
      readonly stripeSubscriptionId: string | null;
      readonly metadata: readonly (
        Readonly<Record<string, string>> | null | undefined
      )[];
      readonly includeTerminalBinding?: boolean;
    },
  ): Promise<string | null> {
    const db = get(db$);

    const stripeSubscriptionId = args.stripeSubscriptionId;
    const includeTerminal = args.includeTerminalBinding ?? false;
    if (stripeSubscriptionId) {
      const [subscription] = await db
        .select({ id: usagePackSubscriptions.id })
        .from(usagePackSubscriptions)
        .where(
          includeTerminal
            ? eq(
                usagePackSubscriptions.stripeSubscriptionId,
                stripeSubscriptionId,
              )
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
      const boundId = subscription?.id ?? null;
      if (boundId) {
        return boundId;
      }
    }
    const metadataId = oneUsagePackSubscriptionId(...args.metadata);
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
  },
);

const loadUsagePackContextOwned$ = command(
  async function loadUsagePackContextOwned(
    { get },
    usagePackSubscriptionId: string,
  ): Promise<UsagePackContext> {
    const db = get(db$);

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
        eq(
          usagePackAllocations.usagePackSubscriptionId,
          usagePackSubscriptionId,
        ),
      );
    return { subscription, allocations };
  },
);

const savePlanChangeInvoiceReceipt$ = command(
  async (
    { set },
    args: {
      readonly invoiceId: string;
      readonly usagePackSubscriptionId: string;
      readonly periodStart: Date | null;
      readonly periodEnd: Date;
    },
  ): Promise<void> => {
    const db = set(writeDb$);
    await db
      .insert(usagePackInvoiceFulfillments)
      .values({
        stripeInvoiceId: args.invoiceId,
        usagePackSubscriptionId: args.usagePackSubscriptionId,
        periodStart: args.periodStart,
        periodEnd: args.periodEnd,
      })
      .onConflictDoNothing();
  },
);
