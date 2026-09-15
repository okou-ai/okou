import {
  type BillingPurchaseConfirmResponse,
  USAGE_PACKS_USD,
  type UsagePackCatalogItem,
  type UsagePackPurchasePreviewResponse,
  type UsagePackUsd,
} from "@okouai/api-contracts/contracts/billing";
import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import {
  USAGE_PACK_ALLOCATION_STATUSES,
  usagePackAllocations,
  usagePackInvoiceFulfillments,
  usagePackSubscriptions,
} from "@okouai/db/schema/usage-pack-subscription";
import { command } from "ccstate";
import { z } from "zod";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notExists,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

import { pgBooleanDecoder } from "../../lib/db-structured-result";
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
import { settle } from "../utils";
import { getOrCreateStripeCustomer$ } from "./billing-customer.service";
import { persistOrgAcquisitionAttribution$ } from "./acquisition-attribution.service";
import { upsertOrgPlanEntitlement } from "./org-plan-entitlements.service";
import { stripePreviewMetadata } from "./stripe-preview-metadata.service";
import {
  handleUsagePackAllocationChangeInvoicePaid,
  lockUsagePackBillingOrg,
  reconcileUsagePackAllocationChanges,
  reconcileUsagePackAllocationChangeSubscription,
  reconcileUsagePackAllocationChangeSubscriptionDeleted,
} from "./usage-pack-allocation-change.service";
import { createUsagePackCreditGrant } from "./usage-pack-credit.service";
import {
  handleUsagePackSubscriptionChangeInvoicePaid,
  reconcileUsagePackSubscriptionChanges,
} from "./usage-pack-plan-change.service";
import type { BillingReconciliationScope } from "./billing-reconciliation-scope";
import { completeBillingOperationInvoiceWithInvoice } from "./billing-operation-invoice.service";
import { writeUsagePackPendingSnapshots } from "./usage-pack-pending-snapshot.service";
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
type UsagePackPurchaseDb = Pick<Db, "select" | "update">;

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
  readonly adAttribution?: Readonly<Record<string, string | undefined>>;
}

interface StartUsagePackPurchaseArgs extends CreateUsagePackCheckoutSessionArgs {
  readonly supportsInAppPreview: boolean;
  readonly sourceSubscriptionId: string | null;
}

type StartUsagePackPurchaseResult =
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
  adAttribution: z.record(z.string(), z.string()).optional(),
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

interface CommitUsagePackFulfillmentArgs {
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

export async function usagePackSubscriptionSchemaAvailable(
  db: Pick<Db, "select">,
): Promise<boolean> {
  const [state] = await db
    .select({
      available:
        sql`to_regclass('public.usage_pack_subscriptions') IS NOT NULL AND to_regclass('public.usage_pack_allocations') IS NOT NULL AND to_regclass('public.usage_pack_invoice_fulfillments') IS NOT NULL`.mapWith(
          pgBooleanDecoder,
        ),
    })
    .from(sql`(SELECT 1) AS schema_probe`)
    .limit(1);
  return state?.available ?? false;
}

export async function usagePackPurchaseSerializationSchemaAvailable(
  db: Pick<Db, "select">,
): Promise<boolean> {
  const [state] = await db
    .select({
      available: sql`to_regclass('usage_pack_subscriptions') IS NOT NULL
          AND to_regclass('usage_pack_allocations') IS NOT NULL
          AND to_regclass('usage_pack_invoice_fulfillments') IS NOT NULL
          AND to_regclass('usage_pack_pending_snapshot_guards') IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM pg_index i
            JOIN pg_attribute a ON a.attrelid = i.indrelid
              AND a.attnum = i.indkey[0]
            WHERE i.indexrelid = to_regclass('uq_usage_pack_subscriptions_pending_org')
              AND i.indrelid = to_regclass('usage_pack_pending_snapshot_guards')
              AND i.indisunique AND i.indisvalid AND i.indisready
              AND i.indnkeyatts = 1 AND i.indpred IS NULL
              AND a.attname = 'org_id' AND a.attnotnull
          )
          AND EXISTS (
            SELECT 1 FROM pg_attribute
            WHERE attrelid = to_regclass('usage_pack_pending_snapshot_guards')
              AND attname = 'pending_snapshot_count'
              AND atttypid = 'integer'::regtype AND attnotnull AND NOT attisdropped
          )
          AND EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = to_regclass('usage_pack_pending_snapshot_guards')
              AND conname = 'chk_usage_pack_pending_snapshot_guard_count'
              AND contype = 'c' AND convalidated
          )`.mapWith(pgBooleanDecoder),
    })
    .from(sql`(SELECT 1) AS schema_probe`)
    .limit(1);
  return state?.available ?? false;
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

function usagePackCheckoutMetadata(args: {
  readonly orgId: string;
  readonly tier: SubscriptionCheckoutTier;
  readonly planPriceId: string;
  readonly usagePackSubscriptionId: string;
  readonly adAttribution:
    | Readonly<Record<string, string | undefined>>
    | undefined;
}): StripeMetadataParam {
  const metadata = usagePackSubscriptionMetadata(args);
  for (const [key, value] of Object.entries(args.adAttribution ?? {})) {
    if (value) {
      metadata[key] = value;
    }
  }
  return metadata;
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
  usagePackSubscriptionId: string,
): Promise<void> {
  const at = nowDate();
  const [pending] = await tx
    .select({ id: usagePackSubscriptions.id })
    .from(usagePackSubscriptions)
    .where(
      and(
        eq(usagePackSubscriptions.id, usagePackSubscriptionId),
        inArray(usagePackSubscriptions.subscriptionStatus, [
          ...USAGE_PACK_PURCHASE_SNAPSHOT_STATUSES,
        ]),
      ),
    )
    .for("update")
    .limit(1);
  if (!pending) {
    return;
  }
  await tx
    .update(usagePackAllocations)
    .set({ status: "inactive", updatedAt: at })
    .where(
      eq(usagePackAllocations.usagePackSubscriptionId, usagePackSubscriptionId),
    );
  await tx
    .update(usagePackSubscriptions)
    .set({ subscriptionStatus: "checkout_expired", updatedAt: at })
    .where(eq(usagePackSubscriptions.id, usagePackSubscriptionId));
}

type PendingUsagePackCheckoutResolution =
  | { readonly kind: "create" }
  | { readonly kind: "redirect"; readonly url: string }
  | { readonly kind: "retry" }
  | { readonly kind: "reuse"; readonly usagePackSubscriptionId: string };

async function resolvePendingUsagePackSnapshots(
  tx: WriteTx,
  args: {
    readonly snapshots: readonly UsagePackContext[];
    readonly matches: (context: UsagePackContext) => boolean;
    readonly preferredSnapshotId: string | undefined;
  },
): Promise<PendingUsagePackCheckoutResolution> {
  if (args.preferredSnapshotId === undefined) {
    const matchingSnapshot = args.snapshots.find(args.matches);
    for (const snapshot of args.snapshots) {
      if (snapshot !== matchingSnapshot) {
        await retireUsagePackCheckout(tx, snapshot.subscription.id);
      }
    }
    return matchingSnapshot
      ? {
          kind: "reuse",
          usagePackSubscriptionId: matchingSnapshot.subscription.id,
        }
      : { kind: "create" };
  }
  const preferred = args.snapshots.find((context) => {
    return context.subscription.id === args.preferredSnapshotId;
  });
  if (
    !preferred ||
    preferred.subscription.stripeCheckoutSessionId ||
    preferred.subscription.stripeSubscriptionId ||
    !args.matches(preferred)
  ) {
    return { kind: "retry" };
  }
  for (const snapshot of args.snapshots) {
    if (snapshot.subscription.id !== args.preferredSnapshotId) {
      await retireUsagePackCheckout(tx, snapshot.subscription.id);
    }
  }
  return {
    kind: "reuse",
    usagePackSubscriptionId: args.preferredSnapshotId,
  };
}

async function resolvePendingUsagePackCheckout(
  tx: WriteTx,
  args: CreateUsagePackCheckoutSessionArgs,
  customerId: string,
  preferredSnapshotId: string | undefined,
  signal: AbortSignal,
): Promise<PendingUsagePackCheckoutResolution> {
  const configurationMatches = (context: UsagePackContext) => {
    return (
      context.subscription.tier === args.tier &&
      context.subscription.stripePlanPriceId === args.planPriceId &&
      context.subscription.stripeCustomerId === customerId &&
      usagePackCheckoutAllocationsMatch(context.allocations, args.allocations)
    );
  };
  const snapshotMatches = (context: UsagePackContext) => {
    return (
      context.subscription.subscriptionStatus === "purchase_pending" &&
      configurationMatches(context)
    );
  };
  const stripe = getStripeClient();
  const contexts = await pendingUsagePackCheckoutContexts(tx, args.orgId);
  const snapshots = contexts.filter((context) => {
    return !context.subscription.stripeCheckoutSessionId;
  });
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
        configurationMatches(context)
      );
    });
  for (const entry of resolved) {
    if (entry === retained) {
      continue;
    }
    if (entry.session.status === "open") {
      await stripe.checkout.sessions.expire(entry.session.id);
      signal.throwIfAborted();
    }
    await retireUsagePackCheckout(tx, entry.context.subscription.id);
  }
  if (retained) {
    for (const snapshot of snapshots) {
      await retireUsagePackCheckout(tx, snapshot.subscription.id);
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
    matches: snapshotMatches,
    preferredSnapshotId,
  });
}

function definedAttribution(
  attribution: Readonly<Record<string, string | undefined>> | undefined,
): Record<string, string> | undefined {
  const entries = Object.entries(attribution ?? {}).filter(
    (entry): entry is [string, string] => {
      return entry[1] !== undefined;
    },
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
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
  | { readonly kind: "redirect"; readonly url: string }
  | { readonly kind: "snapshot"; readonly usagePackSubscriptionId: string };

async function prepareUsagePackPurchaseSnapshot(
  db: Db,
  args: CreateUsagePackCheckoutSessionArgs,
  customerId: string,
  signal: AbortSignal,
): Promise<PreparedUsagePackPurchaseSnapshot> {
  return await writeUsagePackPendingSnapshots(db, [args.orgId], async (tx) => {
    signal.throwIfAborted();
    const resolution = await resolvePendingUsagePackCheckout(
      tx,
      args,
      customerId,
      undefined,
      signal,
    );
    if (resolution.kind === "redirect") {
      return resolution;
    }
    if (resolution.kind === "retry") {
      throw new Error("Usage pack snapshot preparation unexpectedly retried");
    }
    const usagePackSubscriptionId =
      resolution.kind === "reuse"
        ? resolution.usagePackSubscriptionId
        : await insertUsagePackPurchaseSnapshot(tx, args, customerId);
    signal.throwIfAborted();
    return { kind: "snapshot", usagePackSubscriptionId };
  });
}

async function createUsagePackCheckoutForSnapshot(args: {
  readonly db: Pick<Db, "update">;
  readonly stripe: StripeClient;
  readonly purchase: CreateUsagePackCheckoutSessionArgs;
  readonly customerId: string;
  readonly usagePackSubscriptionId: string;
}): Promise<string> {
  const metadata = usagePackCheckoutMetadata({
    orgId: args.purchase.orgId,
    tier: args.purchase.tier,
    planPriceId: args.purchase.planPriceId,
    usagePackSubscriptionId: args.usagePackSubscriptionId,
    adAttribution: args.purchase.adAttribution,
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
  // Stripe cannot be rolled back. Correlate or expire the Session before the
  // caller's transaction observes cancellation.
  if (!session.url) {
    await args.stripe.checkout.sessions.expire(session.id);
    throw new Error("Stripe checkout session did not return a URL");
  }
  const correlated = await args.db
    .update(usagePackSubscriptions)
    .set({
      stripeCheckoutSessionId: session.id,
      subscriptionStatus: "checkout_pending",
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(usagePackSubscriptions.id, args.usagePackSubscriptionId),
        inArray(usagePackSubscriptions.subscriptionStatus, [
          ...USAGE_PACK_PURCHASE_SNAPSHOT_STATUSES,
        ]),
        isNull(usagePackSubscriptions.stripeCheckoutSessionId),
        isNull(usagePackSubscriptions.stripeSubscriptionId),
      ),
    )
    .returning({ id: usagePackSubscriptions.id });
  if (correlated.length !== 1) {
    await args.stripe.checkout.sessions.expire(session.id);
    throw new Error("Usage pack checkout snapshot changed during creation");
  }
  return session.url;
}

async function createSerializedUsagePackCheckout(
  db: Db,
  args: CreateUsagePackCheckoutSessionArgs,
  customerId: string,
  initialSnapshotId: string,
  signal: AbortSignal,
): Promise<StartUsagePackPurchaseResult> {
  let preferredSnapshotId = initialSnapshotId;
  while (true) {
    const attempt = await writeUsagePackPendingSnapshots(
      db,
      [args.orgId],
      async (lockTx) => {
        signal.throwIfAborted();
        const resolution = await resolvePendingUsagePackCheckout(
          lockTx,
          args,
          customerId,
          preferredSnapshotId,
          signal,
        );
        if (resolution.kind === "redirect") {
          return { kind: "complete" as const, url: resolution.url };
        }
        if (resolution.kind !== "reuse") {
          return { kind: "retry" as const };
        }
        return {
          kind: "complete" as const,
          url: await createUsagePackCheckoutForSnapshot({
            db: lockTx,
            stripe: getStripeClient(),
            purchase: args,
            customerId,
            usagePackSubscriptionId: resolution.usagePackSubscriptionId,
          }),
        };
      },
    );
    if (attempt.kind === "complete") {
      return { status: "checkout", url: attempt.url };
    }
    const prepared = await prepareUsagePackPurchaseSnapshot(
      db,
      args,
      customerId,
      signal,
    );
    if (prepared.kind === "redirect") {
      return { status: "checkout", url: prepared.url };
    }
    preferredSnapshotId = prepared.usagePackSubscriptionId;
  }
}

const createUsagePackCheckoutSession$ = command(
  async (
    { set },
    args: CreateUsagePackCheckoutSessionArgs,
    signal: AbortSignal,
  ): Promise<StartUsagePackPurchaseResult> => {
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
    const db = set(writeDb$);
    const prepared = await prepareUsagePackPurchaseSnapshot(
      db,
      args,
      customerId,
      signal,
    );
    if (prepared.kind === "redirect") {
      return { status: "checkout", url: prepared.url };
    }
    return await createSerializedUsagePackCheckout(
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

interface SerializedUsagePackPurchasePreviewInput {
  readonly db: Db;
  readonly stripe: StripeClient;
  readonly purchase: StartUsagePackPurchaseArgs;
  readonly customerId: string;
  readonly preferredSnapshotId: string;
  readonly route: {
    readonly customerId: string;
    readonly paymentMethodId: string;
  };
}

type SerializedUsagePackPurchasePreviewAttempt =
  | { readonly kind: "retry" }
  | {
      readonly kind: "complete";
      readonly result: StartUsagePackPurchaseResult;
    };

async function createSerializedUsagePackPurchasePreviewAttempt(
  input: SerializedUsagePackPurchasePreviewInput,
  signal: AbortSignal,
): Promise<SerializedUsagePackPurchasePreviewAttempt> {
  const { purchase, route, stripe } = input;
  return await writeUsagePackPendingSnapshots(
    input.db,
    [purchase.orgId],
    async (lockTx) => {
      signal.throwIfAborted();
      const resolution = await resolvePendingUsagePackCheckout(
        lockTx,
        purchase,
        input.customerId,
        input.preferredSnapshotId,
        signal,
      );
      if (resolution.kind === "redirect") {
        return {
          kind: "complete",
          result: { status: "checkout", url: resolution.url },
        };
      }
      if (resolution.kind !== "reuse") {
        return { kind: "retry" };
      }
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
      const refreshed = await lockTx
        .update(usagePackSubscriptions)
        .set({ updatedAt: issuedAt })
        .where(
          and(
            eq(usagePackSubscriptions.id, resolution.usagePackSubscriptionId),
            eq(usagePackSubscriptions.subscriptionStatus, "purchase_pending"),
            isNull(usagePackSubscriptions.stripeCheckoutSessionId),
            isNull(usagePackSubscriptions.stripeSubscriptionId),
          ),
        )
        .returning({ id: usagePackSubscriptions.id });
      if (refreshed.length !== 1) {
        return { kind: "retry" };
      }
      const attribution = definedAttribution(purchase.adAttribution);
      const payload: UsagePackPurchasePreviewToken = {
        version: 1,
        usagePackSubscriptionId: resolution.usagePackSubscriptionId,
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
        ...(attribution ? { adAttribution: attribution } : {}),
        expiresAt,
      };
      return {
        kind: "complete",
        result: {
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
        },
      };
    },
  );
}

async function createSerializedUsagePackPurchasePreview(
  input: SerializedUsagePackPurchasePreviewInput,
  signal: AbortSignal,
): Promise<StartUsagePackPurchaseResult> {
  let preferredSnapshotId = input.preferredSnapshotId;
  while (true) {
    const attempt = await createSerializedUsagePackPurchasePreviewAttempt(
      { ...input, preferredSnapshotId },
      signal,
    );
    if (attempt.kind === "complete") {
      return attempt.result;
    }
    const prepared = await prepareUsagePackPurchaseSnapshot(
      input.db,
      input.purchase,
      input.customerId,
      signal,
    );
    if (prepared.kind === "redirect") {
      return { status: "checkout", url: prepared.url };
    }
    preferredSnapshotId = prepared.usagePackSubscriptionId;
  }
}

export const startUsagePackPurchase$ = command(
  async (
    { set },
    args: StartUsagePackPurchaseArgs,
    signal: AbortSignal,
  ): Promise<StartUsagePackPurchaseResult> => {
    if (!args.supportsInAppPreview) {
      return await set(createUsagePackCheckoutSession$, args, signal);
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
    if (prepared.kind === "redirect") {
      return { status: "checkout", url: prepared.url };
    }
    if (route.kind === "checkout") {
      return await createSerializedUsagePackCheckout(
        db,
        args,
        customerId,
        prepared.usagePackSubscriptionId,
        signal,
      );
    }
    return await createSerializedUsagePackPurchasePreview(
      {
        db,
        stripe,
        purchase: args,
        customerId,
        preferredSnapshotId: prepared.usagePackSubscriptionId,
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
    .for("update")
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

async function existingUsagePackPurchaseResult(
  args: {
    readonly db: UsagePackPurchaseDb;
    readonly orgId: string;
    readonly preview: UsagePackPurchasePreviewToken;
    readonly snapshot: UsagePackPurchaseSnapshot;
  },
  signal: AbortSignal,
): Promise<ConfirmUsagePackPurchaseResult | null> {
  const { db, orgId, preview, snapshot } = args;
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
    const completion = await completeBillingOperationInvoiceWithInvoice(
      stripe,
      expandedLatestInvoice(existing),
      `usage-pack:${preview.usagePackSubscriptionId}`,
      signal,
      { payOpenInvoice: true },
    );
    return {
      status: "confirmed",
      ...completion,
    };
  }
  const active = await activeUsagePackBillingContext(db, orgId);
  signal.throwIfAborted();
  if (
    active &&
    active.usagePackSubscriptionId !== preview.usagePackSubscriptionId
  ) {
    return { status: "invalid_preview" };
  }
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
  const competing = subscriptions.some((candidate) => {
    return (
      candidate.id !== preview.sourceSubscriptionId &&
      candidate.metadata?.orgId === orgId &&
      candidate.id !== existingSummary?.id &&
      candidate.items.data.some((item) => {
        return tierForKnownPriceId(item.price.id) !== null;
      }) &&
      candidate.status !== "canceled" &&
      candidate.status !== "incomplete_expired"
    );
  });
  if (competing) {
    return { status: "invalid_preview" };
  }
  if (!existingSummary) {
    return null;
  }
  const existing = await stripe.subscriptions.retrieve(existingSummary.id, {
    expand: ["latest_invoice"],
  });
  signal.throwIfAborted();
  await db
    .update(usagePackSubscriptions)
    .set({
      stripeSubscriptionId: existing.id,
      subscriptionStatus: existing.status,
      updatedAt: nowDate(),
    })
    .where(eq(usagePackSubscriptions.id, preview.usagePackSubscriptionId));
  signal.throwIfAborted();
  const completion = await completeBillingOperationInvoiceWithInvoice(
    stripe,
    expandedLatestInvoice(existing),
    `usage-pack:${preview.usagePackSubscriptionId}`,
    signal,
    { payOpenInvoice: true },
  );
  return {
    status: "confirmed",
    ...completion,
  };
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

async function confirmUsagePackPurchaseSnapshot(
  db: UsagePackPurchaseDb,
  orgId: string,
  preview: UsagePackPurchasePreviewToken,
  snapshot: UsagePackPurchaseSnapshot,
  signal: AbortSignal,
): Promise<ConfirmUsagePackPurchaseResult> {
  const existingResult = await existingUsagePackPurchaseResult(
    {
      db,
      orgId,
      preview,
      snapshot,
    },
    signal,
  );
  if (existingResult) {
    return existingResult;
  }
  const { allocations } = snapshot;
  const stripe = getStripeClient();
  const purchase: CreateUsagePackCheckoutSessionArgs = {
    orgId,
    tier: preview.tier,
    planPriceId: preview.planPriceId,
    allocations,
    successUrl: preview.successUrl,
    cancelUrl: preview.cancelUrl,
    adAttribution: preview.adAttribution,
  };
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
    return {
      status: "confirmed",
      response: {
        status: "checkout_required",
        checkoutUrl: await createUsagePackCheckoutForSnapshot({
          db,
          stripe,
          purchase,
          customerId: preview.customerId,
          usagePackSubscriptionId: preview.usagePackSubscriptionId,
        }),
      },
      paidInvoice: null,
    };
  }
  if (
    route.customerId !== preview.customerId ||
    route.paymentMethodId !== preview.paymentMethodId
  ) {
    return { status: "invalid_preview" };
  }
  const items = [
    { price: preview.planPriceId, quantity: 1 },
    ...usagePackLineItems(allocations),
  ];
  if (
    !(await usagePackPurchasePreviewStillMatches(
      stripe,
      preview,
      items,
      signal,
    ))
  ) {
    return { status: "invalid_preview" };
  }
  const metadata = usagePackCheckoutMetadata({
    orgId,
    tier: preview.tier,
    planPriceId: preview.planPriceId,
    usagePackSubscriptionId: preview.usagePackSubscriptionId,
    adAttribution: preview.adAttribution,
  });
  const created = await stripe.subscriptions.create(
    {
      customer: preview.customerId,
      items,
      ...stripeBillingPurchasePaymentParams(route),
      metadata,
      payment_behavior: "default_incomplete",
      expand: ["latest_invoice"],
    },
    {
      idempotencyKey: `usage-pack:${preview.usagePackSubscriptionId}:subscription`,
    },
  );
  signal.throwIfAborted();
  await db
    .update(usagePackSubscriptions)
    .set({
      stripeSubscriptionId: created.id,
      subscriptionStatus: created.status,
      updatedAt: nowDate(),
    })
    .where(eq(usagePackSubscriptions.id, preview.usagePackSubscriptionId));
  signal.throwIfAborted();
  const completion = await completeBillingOperationInvoiceWithInvoice(
    stripe,
    expandedLatestInvoice(created),
    `usage-pack:${preview.usagePackSubscriptionId}`,
    signal,
    { payOpenInvoice: true },
  );
  return {
    status: "confirmed",
    ...completion,
  };
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
    return await writeUsagePackPendingSnapshots(db, [orgId], async (tx) => {
      signal.throwIfAborted();
      const snapshot = await loadUsagePackPurchaseSnapshot(
        tx,
        orgId,
        preview,
        signal,
      );
      if (!snapshot) {
        return { status: "invalid_preview" as const };
      }
      return await confirmUsagePackPurchaseSnapshot(
        tx,
        orgId,
        preview,
        snapshot,
        signal,
      );
    });
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

async function requireUsagePackSubscriptionSchema(db: Db): Promise<void> {
  if (!(await usagePackSubscriptionSchemaAvailable(db))) {
    throw new Error("Usage pack subscription schema is unavailable");
  }
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

export async function handleUsagePackCheckoutCompleted(
  db: Db,
  session: UsagePackCheckoutSessionInput,
  subscription: UsagePackSubscriptionInput,
): Promise<UsagePackLifecycleOutcome> {
  const usagePackSubscriptionId = oneUsagePackSubscriptionId(session.metadata);
  if (!usagePackSubscriptionId) {
    return { handled: false, orgId: null };
  }
  await requireUsagePackSubscriptionSchema(db);

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
  const context = await synchronizeUsagePackSubscriptionState(db, {
    usagePackSubscriptionId,
    checkoutSessionId: session.id,
    subscription,
  });
  if (context.subscription.stripeCustomerId !== customerId) {
    throw new Error(
      `Usage pack Checkout Session ${session.id} resolved the wrong customer`,
    );
  }
  return {
    handled: true,
    orgId: context.subscription.orgId,
    subscription,
  };
}

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
  if (!(await usagePackSubscriptionSchemaAvailable(db))) {
    const metadataId = oneUsagePackSubscriptionId(eventSubscription.metadata);
    if (metadataId) {
      throw new Error("Usage pack subscription schema is unavailable");
    }
    return { handled: false, orgId: null };
  }
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
  if (!(await usagePackSubscriptionSchemaAvailable(db))) {
    const metadataId = oneUsagePackSubscriptionId(subscription.metadata);
    if (metadataId) {
      throw new Error("Usage pack subscription schema is unavailable");
    }
    return { handled: false, orgId: null };
  }
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

function usagePackGrantIdempotencyKey(
  invoiceId: string,
  allocationId: string,
  grantType: "purchased" | "bonus",
): string {
  return `usage-pack:${invoiceId}:${allocationId}:${grantType}`;
}

async function requireCurrentFulfillmentAllocations(
  tx: WriteTx,
  subscription: UsagePackSubscriptionRow,
  args: CommitUsagePackFulfillmentArgs,
): Promise<void> {
  const allocationIds = args.fulfillment.allocations.map((allocation) => {
    return allocation.allocationId;
  });
  const currentAllocations = await tx
    .select({ id: usagePackAllocations.id })
    .from(usagePackAllocations)
    .where(
      and(
        eq(usagePackAllocations.usagePackSubscriptionId, subscription.id),
        inArray(usagePackAllocations.id, allocationIds),
        inArray(usagePackAllocations.status, [
          ...(subscription.subscriptionStatus === "canceled"
            ? USAGE_PACK_ALLOCATION_STATUSES
            : [
                ...PAYABLE_USAGE_PACK_ALLOCATION_STATUSES,
                "paid_pending_invitation" as const,
              ]),
        ]),
      ),
    );
  if (currentAllocations.length !== allocationIds.length) {
    throw new Error(
      `Usage pack allocations changed while fulfilling invoice ${args.invoice.id}`,
    );
  }
}

async function createUsagePackMemberGrants(
  tx: WriteTx,
  subscription: UsagePackSubscriptionRow,
  args: CommitUsagePackFulfillmentArgs,
): Promise<void> {
  for (const allocation of args.fulfillment.allocations) {
    if (!allocation.userId) {
      continue;
    }
    if (allocation.purchasedCredits > 0) {
      await createUsagePackCreditGrant(tx, {
        orgId: subscription.orgId,
        userId: allocation.userId,
        grantType: "purchased",
        idempotencyKey: usagePackGrantIdempotencyKey(
          args.invoice.id,
          allocation.allocationId,
          "purchased",
        ),
        amount: allocation.purchasedCredits,
        expiresAt: args.fulfillment.periodEnd,
        refundSource: {
          type: "invoice",
          invoiceId: args.invoice.id,
          invoiceLineId: allocation.stripeInvoiceLineId,
          amountCents: allocation.sourceAmountCents,
        },
      });
    }
    if (allocation.bonusCredits > 0) {
      await createUsagePackCreditGrant(tx, {
        orgId: subscription.orgId,
        userId: allocation.userId,
        grantType: "bonus",
        idempotencyKey: usagePackGrantIdempotencyKey(
          args.invoice.id,
          allocation.allocationId,
          "bonus",
        ),
        amount: allocation.bonusCredits,
        expiresAt: args.fulfillment.periodEnd,
      });
    }
  }
}

async function clearNegativeOrgCreditsForFirstPaidUpgrade(
  tx: WriteTx,
  subscription: UsagePackSubscriptionRow,
  invoiceId: string,
): Promise<void> {
  // Free onboarding grants also store an idempotency key in stripeInvoiceId.
  const priorPaidCreditGrant = tx
    .select({ id: creditExpiresRecord.id })
    .from(creditExpiresRecord)
    .where(
      and(
        eq(creditExpiresRecord.orgId, subscription.orgId),
        isNotNull(creditExpiresRecord.stripeInvoiceId),
        inArray(creditExpiresRecord.source, [
          "subscription_renewal",
          "credit_purchase",
          "auto_recharge",
          "one_time_purchase",
        ]),
      ),
    );
  const priorFulfillment = tx
    .select({
      stripeInvoiceId: usagePackInvoiceFulfillments.stripeInvoiceId,
    })
    .from(usagePackInvoiceFulfillments)
    .innerJoin(
      usagePackSubscriptions,
      eq(
        usagePackSubscriptions.id,
        usagePackInvoiceFulfillments.usagePackSubscriptionId,
      ),
    )
    .where(eq(usagePackSubscriptions.orgId, subscription.orgId));
  const cleared = await tx
    .update(orgMetadata)
    .set({ credits: 0, updatedAt: nowDate() })
    .where(
      and(
        eq(orgMetadata.orgId, subscription.orgId),
        lt(orgMetadata.credits, 0),
        isNull(orgMetadata.lastProcessedInvoiceId),
        notExists(priorPaidCreditGrant),
        notExists(priorFulfillment),
      ),
    )
    .returning({ orgId: orgMetadata.orgId });
  if (cleared.length === 0) {
    return;
  }
  L.debug("negative organization credits cleared on first paid upgrade", {
    invoiceId,
    orgId: subscription.orgId,
    usagePackSubscriptionId: subscription.id,
  });
}

async function persistUsagePackPlanState(
  tx: WriteTx,
  subscription: UsagePackSubscriptionRow,
  args: {
    readonly stripeSubscription: UsagePackSubscriptionInput;
    readonly shape: ValidatedSubscriptionShape;
    readonly periodStart: Date | null;
    readonly periodEnd: Date;
    readonly updatedAt: Date;
  },
): Promise<void> {
  await tx
    .update(usagePackSubscriptions)
    .set({
      tier: args.shape.tier,
      stripePlanPriceId: args.shape.planPriceId,
      stripeSubscriptionId: args.stripeSubscription.id,
      subscriptionStatus: args.stripeSubscription.status,
      currentPeriodStart: args.periodStart,
      currentPeriodEnd: args.periodEnd,
      cancelAtPeriodEnd: usagePackSubscriptionWillCancel(
        args.stripeSubscription,
      ),
      updatedAt: args.updatedAt,
    })
    .where(eq(usagePackSubscriptions.id, subscription.id));

  if (!args.shape.projectsOrgPlan) {
    return;
  }

  const orgRows = await tx
    .update(orgMetadata)
    .set({
      tier: args.shape.tier,
      stripeSubscriptionId: args.stripeSubscription.id,
      subscriptionStatus: args.stripeSubscription.status,
      currentPeriodEnd: args.periodEnd,
      cancelAtPeriodEnd: usagePackSubscriptionWillCancel(
        args.stripeSubscription,
      ),
      updatedAt: args.updatedAt,
    })
    .where(
      and(
        eq(orgMetadata.orgId, subscription.orgId),
        eq(orgMetadata.stripeCustomerId, subscription.stripeCustomerId),
      ),
    )
    .returning({ orgId: orgMetadata.orgId });
  if (orgRows.length !== 1) {
    throw new Error(
      `Usage pack subscription ${subscription.id} has no matching organization billing record`,
    );
  }

  const cancelAt =
    unixDate(args.stripeSubscription.cancel_at) ??
    (args.stripeSubscription.cancel_at_period_end ? args.periodEnd : null);
  await upsertOrgPlanEntitlement(tx, {
    orgId: subscription.orgId,
    tier: args.shape.tier,
    source: "stripe_subscription",
    status: args.stripeSubscription.status,
    stripeSubscriptionId: args.stripeSubscription.id,
    stripePriceId: args.shape.planPriceId,
    currentPeriodStart: args.periodStart,
    currentPeriodEnd: args.periodEnd,
    cancelAt,
    expiresAt: cancelAt,
    showUsagePack: true,
  });
}

async function advanceUsagePackProjection(
  tx: WriteTx,
  subscription: UsagePackSubscriptionRow,
  args: CommitUsagePackFulfillmentArgs,
): Promise<void> {
  if (subscription.subscriptionStatus === "canceled") {
    return;
  }
  const updatedAt = nowDate();
  const advancesProjection =
    subscription.currentPeriodEnd === null ||
    subscription.currentPeriodEnd <= args.fulfillment.periodEnd;
  if (!advancesProjection) {
    if (!subscription.stripeSubscriptionId) {
      await tx
        .update(usagePackSubscriptions)
        .set({ stripeSubscriptionId: args.subscription.id, updatedAt })
        .where(eq(usagePackSubscriptions.id, subscription.id));
    }
    return;
  }

  for (const allocation of args.fulfillment.allocations) {
    await tx
      .update(usagePackAllocations)
      .set({
        status: allocation.userId ? "active" : "pending_invitation",
        currentPeriodStart: args.fulfillment.periodStart,
        currentPeriodEnd: args.fulfillment.periodEnd,
        updatedAt,
      })
      .where(eq(usagePackAllocations.id, allocation.allocationId));
  }
  await persistUsagePackPlanState(tx, subscription, {
    stripeSubscription: args.subscription,
    shape: args.shape,
    periodStart: args.fulfillment.periodStart,
    periodEnd: args.fulfillment.periodEnd,
    updatedAt,
  });
}

async function activateUsagePackPlanFromSubscription(
  db: Db,
  subscription: UsagePackSubscriptionInput,
): Promise<UsagePackLifecycleOutcome> {
  await requireUsagePackSubscriptionSchema(db);
  const usagePackSubscriptionId = await resolveUsagePackSubscriptionId(db, {
    stripeSubscriptionId: subscription.id,
    metadata: [subscription.metadata],
  });
  if (!usagePackSubscriptionId) {
    return { handled: false, orgId: null };
  }
  const context = await loadUsagePackContext(db, usagePackSubscriptionId);
  validateUsagePackSubscriptionCorrelation(
    context,
    subscription,
    usagePackSubscriptionId,
  );
  const shape = requireUsagePackSubscriptionShape(context, subscription);
  if (!shape.periodStart) {
    throw new Error(
      `Usage pack subscription ${subscription.id} has no current period start`,
    );
  }
  await writeUsagePackPendingSnapshots(
    db,
    [context.subscription.orgId],
    async (tx) => {
      const [lockedSubscription] = await tx
        .select()
        .from(usagePackSubscriptions)
        .where(eq(usagePackSubscriptions.id, usagePackSubscriptionId))
        .for("update")
        .limit(1);
      if (!lockedSubscription) {
        throw new Error(
          `Usage pack subscription ${usagePackSubscriptionId} disappeared during plan activation`,
        );
      }
      await persistUsagePackPlanState(tx, lockedSubscription, {
        stripeSubscription: subscription,
        shape,
        periodStart: shape.periodStart,
        periodEnd: shape.periodEnd,
        updatedAt: nowDate(),
      });
    },
    [usagePackSubscriptionId],
  );
  return { handled: true, orgId: context.subscription.orgId, subscription };
}

async function commitUsagePackFulfillmentTransaction(
  tx: WriteTx,
  args: CommitUsagePackFulfillmentArgs,
): Promise<void> {
  const [lockedSubscription] = await tx
    .select()
    .from(usagePackSubscriptions)
    .where(eq(usagePackSubscriptions.id, args.context.subscription.id))
    .for("update")
    .limit(1);
  if (!lockedSubscription) {
    throw new Error(
      `Usage pack subscription ${args.context.subscription.id} disappeared during fulfillment`,
    );
  }
  if (
    await usagePackInvoiceAlreadyFulfilled(
      tx,
      args.invoice.id,
      lockedSubscription.id,
    )
  ) {
    return;
  }
  if (
    lockedSubscription.stripeSubscriptionId &&
    lockedSubscription.stripeSubscriptionId !== args.subscription.id
  ) {
    throw new Error(
      `Usage pack subscription ${lockedSubscription.id} changed Stripe subscriptions during fulfillment`,
    );
  }

  await requireCurrentFulfillmentAllocations(tx, lockedSubscription, args);
  await clearNegativeOrgCreditsForFirstPaidUpgrade(
    tx,
    lockedSubscription,
    args.invoice.id,
  );
  await createUsagePackMemberGrants(tx, lockedSubscription, args);
  await advanceUsagePackProjection(tx, lockedSubscription, args);
  await tx.insert(usagePackInvoiceFulfillments).values({
    stripeInvoiceId: args.invoice.id,
    usagePackSubscriptionId: lockedSubscription.id,
    periodStart: args.fulfillment.periodStart,
    periodEnd: args.fulfillment.periodEnd,
  });
}

async function commitUsagePackFulfillment(
  db: Db,
  args: CommitUsagePackFulfillmentArgs,
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockUsagePackBillingOrg(tx, args.context.subscription.orgId);
    await writeUsagePackPendingSnapshots(
      tx,
      [args.context.subscription.orgId],
      async (writeTx) => {
        await commitUsagePackFulfillmentTransaction(writeTx, args);
      },
      [args.context.subscription.id],
    );
  });
}

export async function handleUsagePackInvoicePaid(
  db: Db,
  invoice: UsagePackInvoiceInput,
): Promise<UsagePackLifecycleOutcome> {
  const hasUsagePackLine = invoiceHasUsagePackLine(invoice);
  if (!(await usagePackSubscriptionSchemaAvailable(db))) {
    const metadataId = oneUsagePackSubscriptionId(
      invoice.metadata,
      invoice.parent?.subscription_details?.metadata,
    );
    if (!metadataId && !hasUsagePackLine) {
      return { handled: false, orgId: null };
    }
    throw new Error("Usage pack subscription schema is unavailable");
  }
  const usagePackSubscriptionId = await resolveUsagePackSubscriptionId(db, {
    stripeSubscriptionId: invoiceSubscriptionId(invoice),
    metadata: [
      invoice.metadata,
      invoice.parent?.subscription_details?.metadata,
    ],
    includeTerminalBinding: hasUsagePackLine,
  });
  if (!usagePackSubscriptionId) {
    return { handled: false, orgId: null };
  }
  const subscriptionChangeOutcome =
    await handleUsagePackSubscriptionChangeInvoicePaid(db, invoice);
  if (subscriptionChangeOutcome.handled) {
    await activateUsagePackPlanFromSubscription(
      db,
      subscriptionChangeOutcome.subscription,
    );
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
  if (changeOutcome.handled) {
    return changeOutcome;
  }
  if (!hasUsagePackLine && !isUsagePackPlanChangeInvoice(invoice)) {
    return { handled: false, orgId: null };
  }
  const context = await loadUsagePackContext(db, usagePackSubscriptionId);
  if (
    await usagePackInvoiceAlreadyFulfilled(
      db,
      invoice.id,
      usagePackSubscriptionId,
    )
  ) {
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
  await reconcileUsagePackAllocationChangeSubscription(db, subscription);
  const reconciledContext = await loadUsagePackContext(
    db,
    usagePackSubscriptionId,
  );
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
    await activateUsagePackPlanFromSubscription(db, subscription);
    await db
      .insert(usagePackInvoiceFulfillments)
      .values({
        stripeInvoiceId: invoice.id,
        usagePackSubscriptionId,
        periodStart: shape.periodStart,
        periodEnd: shape.periodEnd,
      })
      .onConflictDoNothing();
    return { handled: true, orgId: reconciledContext.subscription.orgId };
  }
  const prepared = await prepareUsagePackFulfillment(
    reconciledContext,
    subscription,
    invoice,
  );
  await commitUsagePackFulfillment(db, {
    context: reconciledContext,
    subscription,
    invoice,
    ...prepared,
  });

  L.debug("usage pack invoice fulfilled", {
    invoiceId: invoice.id,
    usagePackSubscriptionId,
    orgId: reconciledContext.subscription.orgId,
    allocations: prepared.fulfillment.allocations.length,
    periodEnd: prepared.fulfillment.periodEnd.toISOString(),
  });
  return { handled: true, orgId: reconciledContext.subscription.orgId };
}

interface ReconcileUsagePackSubscriptionResult {
  readonly reconciled: number;
  readonly orgIds: readonly string[];
}

async function retireStaleUsagePackSnapshot(
  db: Db,
  candidate: UsagePackSubscriptionRow,
  pendingSnapshotStaleBefore: Date,
  signal: AbortSignal,
): Promise<void> {
  await writeUsagePackPendingSnapshots(
    db,
    [candidate.orgId],
    async (tx) => {
      signal.throwIfAborted();
      const [staleSnapshot] = await tx
        .select({ id: usagePackSubscriptions.id })
        .from(usagePackSubscriptions)
        .where(
          and(
            eq(usagePackSubscriptions.id, candidate.id),
            eq(usagePackSubscriptions.orgId, candidate.orgId),
            inArray(usagePackSubscriptions.subscriptionStatus, [
              ...USAGE_PACK_PURCHASE_SNAPSHOT_STATUSES,
            ]),
            isNull(usagePackSubscriptions.stripeSubscriptionId),
            isNull(usagePackSubscriptions.stripeCheckoutSessionId),
            lte(usagePackSubscriptions.updatedAt, pendingSnapshotStaleBefore),
          ),
        )
        .limit(1);
      if (staleSnapshot) {
        await retireUsagePackCheckout(tx, staleSnapshot.id);
      }
    },
    [candidate.id],
  );
}

async function reconcileUsagePackSubscriptionCandidate(
  db: Db,
  stripe: StripeClient,
  candidate: UsagePackSubscriptionRow,
  pendingSnapshotStaleBefore: Date,
  signal: AbortSignal,
): Promise<ReconcileUsagePackSubscriptionResult> {
  const orgIds = new Set<string>();
  let subscriptionId = candidate.stripeSubscriptionId;
  if (!subscriptionId && !candidate.stripeCheckoutSessionId) {
    await retireStaleUsagePackSnapshot(
      db,
      candidate,
      pendingSnapshotStaleBefore,
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
        await writeUsagePackPendingSnapshots(
          db,
          [candidate.orgId],
          async (tx) => {
            await retireUsagePackCheckout(tx, candidate.id);
          },
          [candidate.id],
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
    const checkoutOutcome = await handleUsagePackCheckoutCompleted(
      db,
      session,
      checkoutSubscription,
    );
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
  const invoiceOutcome = await handleUsagePackInvoicePaid(db, invoice);
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
}

export async function reconcileUsagePackSubscriptions(
  db: Db,
  scope: BillingReconciliationScope | undefined,
  signal: AbortSignal,
): Promise<ReconcileUsagePackSubscriptionResult> {
  if (!(await usagePackSubscriptionSchemaAvailable(db))) {
    return { reconciled: 0, orgIds: [] };
  }
  signal.throwIfAborted();

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

  const stripe = getStripeClient();
  const orgIds = new Set([
    ...subscriptionChanges.orgIds,
    ...allocationChanges.orgIds,
  ]);
  let reconciled =
    subscriptionChanges.reconciled + allocationChanges.reconciled;
  for (const candidate of candidates) {
    const result = await settle(
      reconcileUsagePackSubscriptionCandidate(
        db,
        stripe,
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
  return { reconciled, orgIds: [...orgIds] };
}
