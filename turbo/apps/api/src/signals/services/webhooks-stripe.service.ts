import type { OrgTier } from "@okouai/api-contracts/contracts/orgs";
import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgConcurrencyEntitlements } from "@okouai/db/schema/org-concurrency-entitlement";
import { orgConcurrencySubscriptions } from "@okouai/db/schema/org-concurrency-subscription";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { usagePackSubscriptions } from "@okouai/db/schema/usage-pack-subscription";
import {
  orgUsageAllowanceEntitlements,
  orgUsageAllowanceWindows,
} from "@okouai/db/schema/org-usage-allowance";
import { command } from "ccstate";
import { and, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { now, nowDate, timestampWithoutTimeZone } from "../../lib/time";
import { clerk$ } from "../external/clerk";
import { writeDb$, type Db } from "../external/db";
import {
  getStripeClient,
  isStripeResourceMissingError,
  listAllStripeSubscriptions,
  type StripeCheckoutSession,
  type StripeInvoice,
  type StripePaymentIntent,
  type StripeSubscription,
  type StripeWebhookEvent,
} from "../external/stripe-client";
import { settle } from "../utils";
import { getCampaign } from "./one-time-products";
import {
  checkoutTierConflictMessage,
  checkoutWouldReplaceWithSameOrLowerTier,
  isUsagePackPlanPriceId,
  knownBillingPlanPriceItem,
  type BillingSubscriptionTier,
  tierForKnownPlanPrice,
} from "./billing-checkout.service";
import { isCurrentStripePreviewMetadata } from "./stripe-preview-metadata.service";
import {
  subscriptionScheduleCancellationEnd,
  subscriptionScheduleId,
} from "./stripe-subscription-schedules.service";
import { downgradeSubscriptionForOrg } from "./billing-downgrade.service";
import {
  BILLING_DOWNGRADE_PURPOSE,
  BILLING_PURCHASE_PURPOSE,
  BILLING_RESTORE_PURPOSE,
} from "./billing-payment-method.service";
import { restoreSubscriptionForOrg } from "./billing-restore.service";
import { publishBillingChangedForOrg } from "./billing-realtime.service";
import { drainOrgQueueToCapacity$ } from "./agent-run-lifecycle.service";
import {
  CONCURRENCY_SUBSCRIPTION_PURPOSE,
  isConcurrencyPriceId,
} from "./org-concurrency-entitlements.service";
import { disableIneligibleWorkflowWebhookAutomationsForOrg } from "./workflow-webhook-automation-entitlement.service";
import {
  ensureOrgMetadataPlanEntitlement,
  orgPlanEntitlementOrgIdForStripeSubscription,
  upsertOrgPlanEntitlement,
  writeOrgMetadataWithPlanEntitlements,
  writeOrgMetadataWithDefaultPlanEntitlement,
} from "./org-plan-entitlements.service";
import type { Tx } from "../../lib/db-types";
import {
  handleUsagePackCheckoutCompleted,
  handleUsagePackInvoicePaid,
  handleUsagePackSubscriptionCreated,
  handleUsagePackSubscriptionDeleted,
  handleUsagePackSubscriptionUpdated,
  stripeSubscriptionUsesMemberUsagePacks,
} from "./usage-pack-subscription.service";
import { createUsagePackCreditGrant } from "./usage-pack-credit.service";
import { failScheduledUsagePackAllocationChangesForSchedule } from "./usage-pack-allocation-change.service";
import {
  handleUsagePackInvitationCheckoutFailed,
  handleUsagePackInvitationCheckoutPaid,
  handleUsagePackInvitationInvoicePaid,
  handleUsagePackInvitationPaymentIntentSucceeded,
} from "./usage-pack-invitation-purchase.service";
import {
  handleUsagePackMigrationInvoicePaid,
  handleUsagePackMigrationSubscriptionUpdated,
} from "./usage-pack-subscription-migration.service";

const L = logger("WebhookStripe");

type BillingDowngradeCheckoutTargetTier =
  | "limited-free-1"
  | "pro-suspend"
  | "pro";
const CANCELED_SUBSCRIPTION_TARGET_TIER = "limited-free-1";

type WriteTx = Tx;
type UsageAllowanceSubscriptionUpdateStore = Pick<Db, "select" | "update">;
type ClerkClient = ReturnType<typeof clerk$.read>;
type ClerkClientProvider = () => ClerkClient;

interface CheckoutSessionInput {
  readonly id: string;
  readonly invoice?: string | { readonly id: string } | null;
  readonly subscription: string | { readonly id: string } | null;
  readonly customer: string | { readonly id: string } | null;
  readonly payment_intent?: string | { readonly id: string } | null;
  readonly metadata: Record<string, string> | null;
  readonly mode?: string | null;
  readonly setup_intent?:
    | string
    | {
        readonly id: string;
        readonly payment_method?: string | { readonly id: string } | null;
      }
    | null;
  readonly amount_subtotal?: number | null;
  readonly amount_total?: number | null;
  readonly payment_status?: string | null;
  readonly currency?: string | null;
}

interface InvoiceInput {
  readonly id: string;
  readonly customer: string | { readonly id: string } | null;
  readonly metadata: Record<string, string> | null;
  readonly subtotal?: number | null;
  readonly lines: {
    readonly data: readonly {
      readonly id?: string;
      readonly amount?: number | null;
      readonly discount_amounts?: readonly { readonly amount: number }[] | null;
      readonly subtotal?: number | null;
      readonly quantity?: number | null;
      readonly metadata?: Record<string, string> | null;
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
          readonly proration_details?: {
            readonly credited_items?: unknown;
          } | null;
        } | null;
        readonly invoice_item_details?: {
          readonly proration: boolean;
          readonly proration_details?: {
            readonly credited_items?: unknown;
          } | null;
        } | null;
      } | null;
    }[];
  };
  readonly parent: {
    readonly subscription_details: {
      readonly metadata?: Record<string, string> | null;
      readonly subscription: string | { readonly id: string };
    } | null;
  } | null;
}

type InvoiceLineInput = InvoiceInput["lines"]["data"][number];

interface SubscriptionInput {
  readonly id: string;
  readonly customer?: string | { readonly id: string } | null;
  readonly status: string;
  readonly metadata?: Record<string, string> | null;
  readonly trial_end?: number | null;
  readonly cancel_at?: number | null;
  readonly cancel_at_period_end: boolean;
  readonly schedule?: string | { readonly id: string } | null;
  readonly items: {
    readonly data: readonly {
      readonly price: {
        readonly id: string;
        readonly product?: string | { readonly id: string } | null;
      };
      readonly quantity?: number | null;
      readonly current_period_start?: number | null;
      readonly current_period_end?: number | null;
    }[];
  };
}

interface SubscriptionDeletedInput {
  readonly id: string;
  readonly metadata?: Record<string, string> | null;
}

interface SubscriptionPreviousAttributes {
  readonly trial_end?: number | null;
  readonly cancel_at?: number | null;
  readonly cancel_at_period_end?: boolean;
  readonly schedule?: string | { readonly id: string } | null;
}

interface SubscriptionScheduleInput {
  readonly id: string;
}

interface CheckoutSubscriptionContext {
  readonly customerId: string;
  readonly subscriptionId: string;
}

interface BillingRestoreCheckoutOutcome {
  readonly handled: boolean;
  readonly orgId: string | null;
}

interface CheckoutCompletedOutcome {
  readonly drainOrgId: string | null;
  readonly orgIds: readonly string[];
}

interface InvoicePaidOrg {
  readonly orgId: string;
  readonly lastProcessedInvoiceId: string | null;
  readonly stripeSubscriptionId: string | null;
  readonly subscriptionStatus: string | null;
  readonly tier: string;
}

interface LockedInvoicePaidOrg extends InvoicePaidOrg {
  readonly planEntitlementSource: string | null;
  readonly planEntitlementPeriodEnd: Date | null;
  readonly planEntitlementSourceMetadata: Readonly<
    Record<string, string>
  > | null;
}

interface SubscriptionInvoiceDetails {
  readonly subscription: SubscriptionInput;
  readonly tier: BillingSubscriptionTier;
  readonly priceId: string;
  readonly credits: number;
  readonly periodStartDate: Date | null;
  readonly periodEndDate: Date;
  readonly scheduledEndDate: Date | null;
  readonly expiresAt: Date;
}

interface PaidWebhookOutcome {
  readonly handled: boolean;
  readonly drainOrgId: string | null;
}

type AtomGrantTier = Extract<OrgTier, "pro" | "team" | "custom">;

interface AtomMemberUsagePackDetails {
  readonly userId: string;
  readonly credits: number;
  readonly expiresAt: Date;
}

interface AtomPlanGrantInvoiceDetails {
  readonly kind: "plan";
  readonly orgId: string;
  readonly tier: AtomGrantTier;
  readonly grantExpiresAt: Date | null;
  readonly creditExpiresAt: Date;
  readonly customerId: string | null;
  readonly credits: number;
  readonly memberUsagePack: AtomMemberUsagePackDetails | null;
}

interface AtomCreditGrantInvoiceDetails {
  readonly kind: "credits";
  readonly orgId: string;
  readonly creditExpiresAt: Date;
  readonly customerId: string | null;
  readonly credits: number;
}

interface AtomUsagePackCreditGrantInvoiceDetails {
  readonly kind: "usagePackCredits";
  readonly orgId: string;
  readonly userId: string;
  readonly creditsExpiresAt: Date;
  readonly customerId: string;
  readonly credits: number;
}

type AtomGrantInvoiceDetails =
  | AtomPlanGrantInvoiceDetails
  | AtomCreditGrantInvoiceDetails
  | AtomUsagePackCreditGrantInvoiceDetails;

interface UsageAllowanceInvoiceDetails {
  readonly orgId: string;
  readonly shortWindowSeconds: number;
  readonly shortWindowUnits: number;
  readonly weeklyWindowSeconds: number;
  readonly weeklyWindowUnits: number;
  readonly effectiveAt: Date;
  readonly expiresAt: Date;
  readonly customerId: string | null;
  readonly subscriptionId: string;
  readonly active: boolean;
}

interface UsageAllowanceMetadataSource {
  readonly metadata: Record<string, string>;
  readonly source: "invoice" | "product";
  readonly line: InvoiceLineInput;
}

function subscriptionPeriodEnd(subscription: SubscriptionInput): Date | null {
  const periodEndUnix = subscription.items.data[0]?.current_period_end;
  return typeof periodEndUnix === "number"
    ? new Date(periodEndUnix * 1000)
    : null;
}

function concurrencySubscriptionItem(subscription: SubscriptionInput):
  | {
      readonly price: { readonly id: string };
      readonly quantity?: number | null;
      readonly current_period_end?: number | null;
    }
  | undefined {
  return subscription.items.data.find((item) => {
    return isConcurrencyPriceId(item.price.id);
  });
}

function concurrencySubscriptionPeriodEnd(
  subscription: SubscriptionInput,
): Date | null {
  const periodEndUnix =
    concurrencySubscriptionItem(subscription)?.current_period_end;
  return typeof periodEndUnix === "number"
    ? new Date(periodEndUnix * 1000)
    : null;
}

function concurrencySubscriptionSlots(
  subscription: SubscriptionInput,
): number | null {
  const quantity = concurrencySubscriptionItem(subscription)?.quantity;
  return typeof quantity === "number" && quantity > 0 ? quantity : null;
}

interface ConcurrencySubscriptionState {
  readonly stripePriceId: string;
  readonly slots: number;
  readonly subscriptionStatus: string;
  readonly currentPeriodEnd: Date | null;
  readonly cancelAtPeriodEnd: boolean;
}

function concurrencySubscriptionState(
  subscription: SubscriptionInput,
): ConcurrencySubscriptionState | null {
  const item = concurrencySubscriptionItem(subscription);
  const slots = concurrencySubscriptionSlots(subscription);
  if (!item || !slots) {
    return null;
  }

  return {
    stripePriceId: item.price.id,
    slots,
    subscriptionStatus: subscription.status,
    currentPeriodEnd: concurrencySubscriptionPeriodEnd(subscription),
    cancelAtPeriodEnd:
      subscription.cancel_at_period_end &&
      knownBillingPlanPriceItem(subscription.items.data) === undefined,
  };
}

async function retrieveConcurrencySubscriptionState(
  subscriptionId: string,
): Promise<ConcurrencySubscriptionState | null> {
  const subscription =
    await getStripeClient().subscriptions.retrieve(subscriptionId);
  return concurrencySubscriptionState(subscription);
}

async function lockConcurrencySubscriptionState(
  tx: WriteTx,
  subscriptionId: string,
): Promise<void> {
  const lockKey = `stripe_concurrency_subscription:${subscriptionId}`;
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
  );
}

function subscriptionCancelAt(subscription: SubscriptionInput): Date | null {
  return typeof subscription.cancel_at === "number"
    ? new Date(subscription.cancel_at * 1000)
    : null;
}

function subscriptionWillCancel(subscription: SubscriptionInput): boolean {
  return (
    subscription.cancel_at_period_end ||
    subscriptionCancelAt(subscription) !== null
  );
}

async function subscriptionScheduledEnd(
  stripe: ReturnType<typeof getStripeClient>,
  subscription: SubscriptionInput,
): Promise<Date | null> {
  return (
    subscriptionCancelAt(subscription) ??
    (await subscriptionScheduleCancellationEnd(stripe, subscription)) ??
    (subscription.cancel_at_period_end
      ? subscriptionPeriodEnd(subscription)
      : null)
  );
}

function usageAllowanceSubscriptionEnd(
  subscription: SubscriptionInput,
): Date | null {
  const periodEnd = subscriptionPeriodEnd(subscription);
  const cancelAt = subscriptionCancelAt(subscription);
  if (!periodEnd) {
    return null;
  }
  const allowanceCancelAtValue = subscription.metadata?.allowanceCancelAt;
  const allowanceCancelAt = allowanceCancelAtValue
    ? new Date(allowanceCancelAtValue)
    : null;
  return [cancelAt, allowanceCancelAt]
    .filter((value): value is Date => {
      return value !== null && !Number.isNaN(value.getTime());
    })
    .reduce((earliest, value) => {
      return value < earliest ? value : earliest;
    }, periodEnd);
}

function customerIdFromSubscription(
  subscription: SubscriptionInput,
): string | null {
  return typeof subscription.customer === "string"
    ? subscription.customer
    : (subscription.customer?.id ?? null);
}

function subscriptionTrialEnd(subscription: SubscriptionInput): Date | null {
  return typeof subscription.trial_end === "number"
    ? new Date(subscription.trial_end * 1000)
    : null;
}

function subscriptionPendingChangeCleared(
  subscription: SubscriptionInput,
  previousAttributes: SubscriptionPreviousAttributes | undefined,
  willCancel: boolean,
): boolean {
  if (willCancel || subscriptionScheduleId(subscription)) {
    return false;
  }

  return (
    previousAttributes?.schedule !== undefined ||
    previousAttributes?.cancel_at !== undefined ||
    previousAttributes?.cancel_at_period_end === true
  );
}

function requiredSubscriptionTrialEnd(subscription: SubscriptionInput): Date {
  const trialEnd = subscriptionTrialEnd(subscription);
  if (!trialEnd) {
    throw new Error(
      `trialing subscription has no trial_end (subscriptionId=${subscription.id})`,
    );
  }
  return trialEnd;
}

function monthlyCreditsForTier(tier: OrgTier): number {
  switch (tier) {
    case "free": {
      return 0;
    }
    case "limited-free-1": {
      return 0;
    }
    case "pro-suspend": {
      return 0;
    }
    case "custom": {
      return 0;
    }
    case "pro": {
      return 20_000;
    }
    case "team": {
      return 120_000;
    }
  }
}

function subscriptionCreditExpiresAt(
  subscription: SubscriptionInput,
  periodEndDate: Date,
): Date {
  const atomGrantExpiresAt = atomDayGrantCreditExpiresAt(subscription);
  if (atomGrantExpiresAt) {
    return atomGrantExpiresAt;
  }

  if (subscription.status === "trialing") {
    return requiredSubscriptionTrialEnd(subscription);
  }

  const expiresAt = new Date(periodEndDate);
  expiresAt.setMonth(expiresAt.getMonth() + 1);
  return expiresAt;
}

const CREDITS_PER_DOLLAR = 1000;
const CREDIT_PURCHASE_EXPIRES_AT_METADATA_KEY = "creditsExpiresAt";
const ATOM_GRANT_EXPIRES_AT_METADATA_KEY = "atomGrantExpiresAt";
const ATOM_GRANT_PURPOSE = "atom_grant";
const ATOM_GRANT_SUBSCRIPTION_STATUS = "atom_grant";
const USAGE_ALLOWANCE_PURPOSE = "usage_allowance";

function isAtomDayGrantSource(source: string | undefined): boolean {
  return source === "atom_entitlement" || source === "atom_redeem_code";
}

function atomDayGrantCreditExpiresAt(
  subscription: SubscriptionInput,
): Date | null {
  const metadata = subscription.metadata ?? {};
  if (!isAtomDayGrantSource(metadata.source)) {
    return null;
  }

  const duration = metadata.duration;
  if (!duration || !/^\d+d$/.test(duration)) {
    return null;
  }

  const cancelAt = subscriptionCancelAt(subscription);
  if (!cancelAt) {
    return null;
  }

  const metadataExpiresAt = metadata[ATOM_GRANT_EXPIRES_AT_METADATA_KEY];
  if (metadataExpiresAt) {
    const date = new Date(metadataExpiresAt);
    if (
      !Number.isNaN(date.getTime()) &&
      Math.floor(date.getTime() / 1000) ===
        Math.floor(cancelAt.getTime() / 1000)
    ) {
      return date;
    }
  }

  return cancelAt;
}

function creditsFromAmountCents(
  amountCents: number | null | undefined,
): number {
  if (amountCents === undefined || amountCents === null) {
    return Number.NaN;
  }
  return Math.floor((amountCents * CREDITS_PER_DOLLAR) / 100);
}

function creditPurchaseAmount(session: CheckoutSessionInput): number {
  const metadata = session.metadata ?? {};
  if (metadata.creditsAmountMode === "amount_subtotal") {
    return creditsFromAmountCents(
      session.amount_subtotal ?? session.amount_total,
    );
  }
  if (metadata.creditsAmountMode === "amount_total") {
    return creditsFromAmountCents(session.amount_total);
  }
  return Number(metadata.creditsAmount);
}

function checkoutSessionInvoiceId(
  session: CheckoutSessionInput,
): string | null {
  if (typeof session.invoice === "string") {
    return session.invoice;
  }
  return session.invoice?.id ?? null;
}

function autoRechargeNeverExpiresAt(): Date {
  return new Date("2999-12-31T00:00:00Z");
}

function parseMetadataDate(value: string): Date | null {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return null;
  }

  const parsedDate = /^\d+$/.test(trimmedValue)
    ? new Date(Number(trimmedValue) * 1000)
    : new Date(trimmedValue);

  return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
}

function creditPurchaseExpiresAt(
  metadata: Readonly<Record<string, string>>,
): Date | null {
  const expiresAtValue = metadata[CREDIT_PURCHASE_EXPIRES_AT_METADATA_KEY];
  if (!expiresAtValue) {
    return autoRechargeNeverExpiresAt();
  }

  const expiresAt = parseMetadataDate(expiresAtValue);
  if (!expiresAt || expiresAt.getTime() <= now()) {
    return null;
  }

  return expiresAt;
}

function atomGrantPriceId(): string | null {
  return env("ATOM_GRANT_PRICE") ?? null;
}

function invoiceAtomGrantLine(invoice: InvoiceInput): InvoiceLineInput | null {
  const priceId = atomGrantPriceId();
  if (!priceId) {
    return null;
  }
  return (
    invoice.lines.data.find((line) => {
      return invoiceLinePriceId(line) === priceId;
    }) ?? null
  );
}

function invoiceMergedMetadata(invoice: InvoiceInput): Record<string, string> {
  return {
    ...invoice.parent?.subscription_details?.metadata,
    ...invoice.metadata,
  };
}

function isUsageAllowanceMetadata(
  metadata: Readonly<Record<string, string>> | null | undefined,
): boolean {
  return (
    metadata?.purpose === USAGE_ALLOWANCE_PURPOSE ||
    metadata?.type === USAGE_ALLOWANCE_PURPOSE
  );
}

function isAtomGrantInvoice(invoice: InvoiceInput): boolean {
  if (isUsageAllowanceMetadata(invoiceMergedMetadata(invoice))) {
    return false;
  }

  return (
    invoice.metadata?.purpose === ATOM_GRANT_PURPOSE ||
    invoice.metadata?.type === ATOM_GRANT_PURPOSE ||
    invoiceAtomGrantLine(invoice) !== null
  );
}

function atomGrantTier(value: string | undefined): AtomGrantTier | null {
  return value === "pro" || value === "team" || value === "custom"
    ? value
    : null;
}

function atomGrantTierRank(tier: string | null | undefined): number {
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
    default: {
      return 0;
    }
  }
}

function atomGrantTierConflictMessage(args: {
  readonly currentTier: string | null | undefined;
  readonly targetTier: AtomGrantTier;
}): string {
  return `Cannot apply Atom ${args.targetTier} grant while current tier is ${args.currentTier ?? "unknown"}`;
}

function atomGrantExpiresAt(
  metadata: Readonly<Record<string, string>>,
  line: InvoiceLineInput | null,
): Date | null {
  const metadataExpiresAt = metadata[ATOM_GRANT_EXPIRES_AT_METADATA_KEY];
  if (metadataExpiresAt) {
    const expiresAt = parseMetadataDate(metadataExpiresAt);
    if (expiresAt && expiresAt.getTime() > now()) {
      return expiresAt;
    }
    return null;
  }

  if (metadata.duration === "forever") {
    return null;
  }

  const periodEnd = line?.period.end;
  if (!periodEnd) {
    return null;
  }

  const expiresAt = new Date(periodEnd * 1000);
  return expiresAt.getTime() > now() ? expiresAt : null;
}

function atomGrantCreditExpiresAt(grantExpiresAt: Date | null): Date {
  if (grantExpiresAt) {
    return grantExpiresAt;
  }

  return autoRechargeNeverExpiresAt();
}

function atomUsagePackGrantExpiresAt(
  metadata: Readonly<Record<string, string>>,
  line: InvoiceLineInput,
): Date | null {
  const creditsExpiresAt = metadata.creditsExpiresAt
    ? parseMetadataDate(metadata.creditsExpiresAt)
    : null;
  if (
    !creditsExpiresAt ||
    creditsExpiresAt.getTime() <= now() ||
    typeof line.period.start !== "number" ||
    typeof line.period.end !== "number" ||
    line.period.end <= line.period.start ||
    line.period.end * 1000 !== creditsExpiresAt.getTime()
  ) {
    return null;
  }

  return creditsExpiresAt;
}

function atomUsagePackCreditGrantInvoiceDetails(
  invoice: InvoiceInput,
  metadata: Readonly<Record<string, string>>,
  line: InvoiceLineInput,
): AtomUsagePackCreditGrantInvoiceDetails | null {
  const orgId = metadata.orgId;
  const customerId = customerIdFromInvoice(invoice);
  const credits = Number(metadata.creditsAmount);
  const creditsExpiresAt = atomUsagePackGrantExpiresAt(metadata, line);
  if (
    metadata.source !== "atom_usage_pack_credits" ||
    !orgId ||
    !metadata.userId ||
    !customerId ||
    !Number.isSafeInteger(credits) ||
    credits <= 0 ||
    !creditsExpiresAt
  ) {
    L.warn("atom usage pack credit grant invoice has invalid metadata", {
      invoiceId: invoice.id,
      hasOrgId: Boolean(orgId),
      hasUserId: Boolean(metadata.userId),
      creditsAmount: metadata.creditsAmount ?? null,
      creditsExpiresAt: metadata.creditsExpiresAt ?? null,
    });
    return null;
  }

  return {
    kind: "usagePackCredits",
    orgId,
    userId: metadata.userId,
    creditsExpiresAt,
    customerId,
    credits,
  };
}

function atomPlanMemberUsagePackDetails(
  invoice: InvoiceInput,
  metadata: Readonly<Record<string, string>>,
  line: InvoiceLineInput,
):
  | { readonly valid: true; readonly value: AtomMemberUsagePackDetails | null }
  | { readonly valid: false } {
  const hasMetadata =
    metadata.userId !== undefined ||
    metadata.creditsAmount !== undefined ||
    metadata.creditsExpiresAt !== undefined;
  if (!hasMetadata) {
    return { valid: true, value: null };
  }

  const expiresAt = atomUsagePackGrantExpiresAt(metadata, line);
  const credits = Number(metadata.creditsAmount);
  if (
    metadata.planVersion !== "usagePack" ||
    metadata.source !== "atom_redeem_code" ||
    !metadata.userId ||
    !Number.isSafeInteger(credits) ||
    credits <= 0 ||
    !expiresAt
  ) {
    L.warn("atom redeem plan grant has invalid member usage pack metadata", {
      invoiceId: invoice.id,
      orgId: metadata.orgId ?? null,
      hasUserId: Boolean(metadata.userId),
      creditsAmount: metadata.creditsAmount ?? null,
      creditsExpiresAt: metadata.creditsExpiresAt ?? null,
    });
    return { valid: false };
  }

  return {
    valid: true,
    value: { userId: metadata.userId, credits, expiresAt },
  };
}

function atomCreditGrantInvoiceDetails(
  invoice: InvoiceInput,
  metadata: Readonly<Record<string, string>>,
): AtomCreditGrantInvoiceDetails | null {
  const orgId = metadata.orgId;
  const credits = Number(metadata.creditsAmount);
  const creditExpiresAt = creditPurchaseExpiresAt(metadata);
  if (
    !orgId ||
    !Number.isSafeInteger(credits) ||
    credits <= 0 ||
    !creditExpiresAt
  ) {
    L.warn("atom credit grant invoice has invalid metadata", {
      invoiceId: invoice.id,
      hasOrgId: Boolean(orgId),
      creditsAmount: metadata.creditsAmount ?? null,
      creditsExpiresAt:
        metadata[CREDIT_PURCHASE_EXPIRES_AT_METADATA_KEY] ?? null,
    });
    return null;
  }

  return {
    kind: "credits",
    orgId,
    creditExpiresAt,
    customerId: customerIdFromInvoice(invoice),
    credits,
  };
}

function atomGrantInvoiceDetails(
  invoice: InvoiceInput,
): AtomGrantInvoiceDetails | null {
  const metadata = invoice.metadata ?? {};
  const line = invoiceAtomGrantLine(invoice);
  const configuredPriceId = atomGrantPriceId();
  if (!configuredPriceId) {
    L.warn(
      "atom grant invoice received but ATOM_GRANT_PRICE is not configured",
      {
        invoiceId: invoice.id,
      },
    );
    return null;
  }
  if (!line) {
    L.warn("atom grant invoice missing configured grant price", {
      invoiceId: invoice.id,
      configuredPriceId,
    });
    return null;
  }

  if (metadata.grantType === "usage_pack_credits") {
    return atomUsagePackCreditGrantInvoiceDetails(invoice, metadata, line);
  }
  if (metadata.grantType === "credits") {
    return atomCreditGrantInvoiceDetails(invoice, metadata);
  }
  const orgId = metadata.orgId;
  const customerId = customerIdFromInvoice(invoice);
  const tier = atomGrantTier(metadata.tier ?? metadata.planId);
  const grantExpiresAt = atomGrantExpiresAt(metadata, line);
  if (!orgId || !tier) {
    L.warn("atom grant invoice has invalid metadata", {
      invoiceId: invoice.id,
      hasOrgId: Boolean(orgId),
      tier: metadata.tier ?? metadata.planId ?? null,
      metadata,
    });
    return null;
  }
  if (metadata.duration !== "forever" && !grantExpiresAt) {
    L.warn("atom grant invoice has invalid grant expiration", {
      invoiceId: invoice.id,
      orgId,
      duration: metadata.duration ?? null,
      atomGrantExpiresAt: metadata[ATOM_GRANT_EXPIRES_AT_METADATA_KEY] ?? null,
    });
    return null;
  }
  const memberUsagePack = atomPlanMemberUsagePackDetails(
    invoice,
    metadata,
    line,
  );
  if (!memberUsagePack.valid) {
    return null;
  }

  return {
    kind: "plan",
    orgId,
    tier,
    grantExpiresAt,
    creditExpiresAt: atomGrantCreditExpiresAt(grantExpiresAt),
    customerId,
    credits:
      metadata.planVersion === "usagePack" ? 0 : monthlyCreditsForTier(tier),
    memberUsagePack: memberUsagePack.value,
  };
}

function atomGrantWouldReplaceWithSameOrLowerTier(args: {
  readonly lockedOrg: LockedInvoicePaidOrg;
  readonly targetTier: AtomGrantTier;
}): boolean {
  if (
    args.lockedOrg.subscriptionStatus === ATOM_GRANT_SUBSCRIPTION_STATUS &&
    args.lockedOrg.stripeSubscriptionId === null &&
    args.lockedOrg.tier === args.targetTier
  ) {
    return false;
  }

  return (
    atomGrantTierRank(args.lockedOrg.tier) >= atomGrantTierRank(args.targetTier)
  );
}

function atomUsagePackGrantWouldNotExtendEntitlement(args: {
  readonly invoice: InvoiceInput;
  readonly details: AtomPlanGrantInvoiceDetails;
  readonly lockedOrg: LockedInvoicePaidOrg;
}): boolean {
  if (
    args.invoice.metadata?.planVersion !== "usagePack" ||
    args.lockedOrg.planEntitlementSource !== "stripe_atom_grant" ||
    args.lockedOrg.planEntitlementSourceMetadata?.planVersion !== "usagePack" ||
    args.lockedOrg.tier !== args.details.tier
  ) {
    return false;
  }

  const currentPeriodEnd = args.lockedOrg.planEntitlementPeriodEnd;
  if (currentPeriodEnd === null) {
    return true;
  }

  return (
    args.details.grantExpiresAt !== null &&
    args.details.grantExpiresAt <= currentPeriodEnd
  );
}

function positiveMetadataInteger(
  metadata: Readonly<Record<string, string>>,
  key: string,
): number | null {
  const value = Number(metadata[key]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function hasUsageAllowanceWindowMetadata(
  metadata: Readonly<Record<string, string>>,
): boolean {
  return (
    positiveMetadataInteger(metadata, "shortWindowSeconds") !== null &&
    positiveMetadataInteger(metadata, "shortWindowUnits") !== null &&
    positiveMetadataInteger(metadata, "weeklyWindowSeconds") !== null &&
    positiveMetadataInteger(metadata, "weeklyWindowUnits") !== null
  );
}

function allowanceSubscriptionMetadataOverlay(
  metadata: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => {
      return (
        key.startsWith("allowance") ||
        key === "shortWindowSeconds" ||
        key === "shortWindowUnits" ||
        key === "weeklyWindowSeconds" ||
        key === "weeklyWindowUnits"
      );
    }),
  );
}

async function usageAllowanceMetadataSource(
  invoice: InvoiceInput,
): Promise<UsageAllowanceMetadataSource | null> {
  const invoiceMetadata = invoiceMergedMetadata(invoice);
  for (const line of invoice.lines.data) {
    const lineMetadata = line.metadata ?? {};
    if (
      isUsageAllowanceMetadata(lineMetadata) &&
      hasUsageAllowanceWindowMetadata(lineMetadata)
    ) {
      return {
        metadata: {
          ...lineMetadata,
          ...allowanceSubscriptionMetadataOverlay(invoiceMetadata),
        },
        source: "invoice",
        line,
      };
    }
  }

  if (
    isUsageAllowanceMetadata(invoiceMetadata) &&
    hasUsageAllowanceWindowMetadata(invoiceMetadata)
  ) {
    const line = invoice.lines.data.find((candidate) => {
      return invoiceLinePriceId(candidate) !== null;
    });
    return line ? { metadata: invoiceMetadata, source: "invoice", line } : null;
  }

  for (const line of invoice.lines.data) {
    const priceId = invoiceLinePriceId(line);
    if (!priceId) {
      continue;
    }
    if (
      tierForKnownPlanPrice({ id: priceId }) !== null ||
      isConcurrencyPriceId(priceId) ||
      priceId === atomGrantPriceId()
    ) {
      continue;
    }
    const price = await getStripeClient().prices.retrieve(priceId, {
      expand: ["product"],
    });
    if (!price) {
      continue;
    }
    const product = price.product;
    if (!product) {
      continue;
    }
    if (typeof product === "string" || "deleted" in product) {
      continue;
    }
    const productMetadata = product.metadata ?? {};
    if (
      isUsageAllowanceMetadata(productMetadata) &&
      hasUsageAllowanceWindowMetadata(productMetadata)
    ) {
      return {
        metadata: {
          ...productMetadata,
          ...allowanceSubscriptionMetadataOverlay(invoiceMetadata),
        },
        source: "product",
        line,
      };
    }
  }
  return null;
}

async function usageAllowanceInvoiceDetails(
  invoice: InvoiceInput,
): Promise<UsageAllowanceInvoiceDetails | null> {
  const metadataSource = await usageAllowanceMetadataSource(invoice);
  if (!metadataSource) {
    return null;
  }
  const { metadata, source, line } = metadataSource;

  const orgId = metadata.orgId;
  const shortWindowSeconds = positiveMetadataInteger(
    metadata,
    "shortWindowSeconds",
  );
  const shortWindowUnits = positiveMetadataInteger(
    metadata,
    "shortWindowUnits",
  );
  const weeklyWindowSeconds = positiveMetadataInteger(
    metadata,
    "weeklyWindowSeconds",
  );
  const weeklyWindowUnits = positiveMetadataInteger(
    metadata,
    "weeklyWindowUnits",
  );
  const subscriptionId = subscriptionIdFromInvoice(invoice);
  const effectiveAt =
    typeof line.period.start === "number"
      ? new Date(line.period.start * 1000)
      : nowDate();
  const periodEnd = new Date(line.period.end * 1000);
  const configuredEnd = metadata.allowanceCancelAt
    ? new Date(metadata.allowanceCancelAt)
    : null;
  const expiresAt =
    configuredEnd &&
    !Number.isNaN(configuredEnd.getTime()) &&
    configuredEnd < periodEnd
      ? configuredEnd
      : periodEnd;
  const active =
    metadata.allowanceStatus !== "canceled" && expiresAt > effectiveAt;

  if (
    !orgId ||
    !shortWindowSeconds ||
    !shortWindowUnits ||
    !weeklyWindowSeconds ||
    !weeklyWindowUnits
  ) {
    L.warn("usage allowance invoice has invalid metadata", {
      invoiceId: invoice.id,
      hasOrgId: Boolean(orgId),
      source,
      metadata,
    });
    return null;
  }

  if (!subscriptionId) {
    L.warn("usage allowance invoice is not a subscription period invoice", {
      invoiceId: invoice.id,
      orgId,
      hasSubscriptionId: Boolean(subscriptionId),
      hasPeriodEnd: true,
    });
    return null;
  }

  if (!active && metadata.allowanceStatus !== "canceled") {
    L.warn("usage allowance invoice has invalid entitlement time range", {
      invoiceId: invoice.id,
      orgId,
      effectiveAt: effectiveAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
    return null;
  }

  return {
    orgId,
    shortWindowSeconds,
    shortWindowUnits,
    weeklyWindowSeconds,
    weeklyWindowUnits,
    effectiveAt,
    expiresAt,
    customerId: customerIdFromInvoice(invoice),
    subscriptionId,
    active,
  };
}

async function handleUsageAllowanceInvoicePaid(
  db: Db,
  invoice: InvoiceInput,
): Promise<PaidWebhookOutcome> {
  const details = await usageAllowanceInvoiceDetails(invoice);
  if (!details) {
    return { handled: false, drainOrgId: null };
  }
  const existingRows = await db
    .select({
      effectiveAt: orgUsageAllowanceEntitlements.effectiveAt,
      stripeSubscriptionId: orgUsageAllowanceEntitlements.stripeSubscriptionId,
    })
    .from(orgUsageAllowanceEntitlements)
    .where(eq(orgUsageAllowanceEntitlements.orgId, details.orgId))
    .limit(1);
  const existing = existingRows[0];
  if (!details.active) {
    if (
      existing?.stripeSubscriptionId &&
      existing.stripeSubscriptionId !== details.subscriptionId
    ) {
      L.warn("stale canceled usage allowance invoice ignored", {
        invoiceId: invoice.id,
        orgId: details.orgId,
        currentSubscriptionId: existing.stripeSubscriptionId,
        invoiceSubscriptionId: details.subscriptionId,
      });
      return { handled: true, drainOrgId: null };
    }
    const canceledAt = nowDate();
    await db.transaction(async (tx) => {
      const rows = await tx
        .update(orgUsageAllowanceEntitlements)
        .set({
          status: "canceled",
          expiresAt: canceledAt,
          updatedAt: canceledAt,
        })
        .where(
          and(
            eq(orgUsageAllowanceEntitlements.orgId, details.orgId),
            or(
              isNull(orgUsageAllowanceEntitlements.stripeSubscriptionId),
              eq(
                orgUsageAllowanceEntitlements.stripeSubscriptionId,
                details.subscriptionId,
              ),
            ),
          ),
        )
        .returning({ orgId: orgUsageAllowanceEntitlements.orgId });
      await expireActiveUsageAllowanceWindows(tx, {
        orgIds: rows.map((row) => {
          return row.orgId;
        }),
        at: canceledAt,
        updatedAt: canceledAt,
      });
    });
    return { handled: true, drainOrgId: details.orgId };
  }
  if (
    existing?.stripeSubscriptionId &&
    existing.stripeSubscriptionId !== details.subscriptionId &&
    existing.effectiveAt.getTime() >= details.effectiveAt.getTime()
  ) {
    L.warn("stale usage allowance invoice ignored", {
      invoiceId: invoice.id,
      orgId: details.orgId,
      currentSubscriptionId: existing.stripeSubscriptionId,
      invoiceSubscriptionId: details.subscriptionId,
      currentEffectiveAt: existing.effectiveAt.toISOString(),
      invoiceEffectiveAt: details.effectiveAt.toISOString(),
    });
    return { handled: true, drainOrgId: null };
  }

  const updatedAt = nowDate();
  await db
    .insert(orgUsageAllowanceEntitlements)
    .values({
      orgId: details.orgId,
      source: "atom_usage_allowance",
      status: "active",
      shortWindowSeconds: details.shortWindowSeconds,
      shortWindowUnits: details.shortWindowUnits,
      weeklyWindowSeconds: details.weeklyWindowSeconds,
      weeklyWindowUnits: details.weeklyWindowUnits,
      effectiveAt: details.effectiveAt,
      expiresAt: details.expiresAt,
      stripeCustomerId: details.customerId,
      stripeSubscriptionId: details.subscriptionId,
      stripeInvoiceId: invoice.id,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: orgUsageAllowanceEntitlements.orgId,
      set: {
        source: "atom_usage_allowance",
        status: "active",
        shortWindowSeconds: details.shortWindowSeconds,
        shortWindowUnits: details.shortWindowUnits,
        weeklyWindowSeconds: details.weeklyWindowSeconds,
        weeklyWindowUnits: details.weeklyWindowUnits,
        effectiveAt: details.effectiveAt,
        expiresAt: details.expiresAt,
        stripeCustomerId: details.customerId,
        stripeSubscriptionId: details.subscriptionId,
        stripeInvoiceId: invoice.id,
        updatedAt,
      },
    });

  L.debug("usage allowance invoice processed", {
    invoiceId: invoice.id,
    orgId: details.orgId,
    subscriptionId: details.subscriptionId,
    expiresAt: details.expiresAt?.toISOString() ?? null,
  });
  return { handled: true, drainOrgId: details.orgId };
}

function stripePreviewMetadataForEvent(
  event: StripeWebhookEvent,
): readonly (Readonly<Record<string, string>> | null | undefined)[] | null {
  switch (event.kind) {
    case "checkout.session.paid":
    case "checkout.session.failed": {
      return [event.object.metadata];
    }
    case "invoice.paid": {
      return [
        event.object.metadata,
        event.object.parent?.subscription_details?.metadata,
      ];
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      return [event.object.metadata];
    }
    default: {
      return null;
    }
  }
}

function shouldHandleStripePreviewEvent(event: StripeWebhookEvent): boolean {
  const metadataCandidates = stripePreviewMetadataForEvent(event);
  if (metadataCandidates === null) {
    return true;
  }
  return metadataCandidates.some((metadata) => {
    return isCurrentStripePreviewMetadata(metadata);
  });
}

function stripeObjectId(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value !== "object" || value === null || !("id" in value)) {
    return null;
  }
  return typeof value.id === "string" ? value.id : null;
}

async function paymentIntentMatchesCurrentStripePreview(
  stripe: ReturnType<typeof getStripeClient>,
  paymentIntent: StripePaymentIntent,
  customerId: string,
): Promise<boolean> {
  if (isCurrentStripePreviewMetadata(paymentIntent.metadata)) {
    return true;
  }

  const customer = await stripe.customers.retrieve(customerId);
  if ("deleted" in customer && customer.deleted) {
    return false;
  }
  return isCurrentStripePreviewMetadata(customer.metadata);
}

async function handlePaymentIntentSucceeded(
  paymentIntent: StripePaymentIntent,
): Promise<void> {
  const customerId = stripeObjectId(paymentIntent.customer);
  const paymentMethodId = stripeObjectId(paymentIntent.payment_method);
  if (!customerId || !paymentMethodId) {
    return;
  }

  const stripe = getStripeClient();
  if (
    !(await paymentIntentMatchesCurrentStripePreview(
      stripe,
      paymentIntent,
      customerId,
    ))
  ) {
    return;
  }

  const paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodId);
  if (
    paymentMethod.type !== "card" ||
    stripeObjectId(paymentMethod.customer) !== customerId
  ) {
    return;
  }

  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: paymentMethodId },
  });
}

function addBillingChangedOrgIds(
  target: Set<string>,
  orgIds: Iterable<string>,
): void {
  for (const orgId of orgIds) {
    target.add(orgId);
  }
}

async function grantOrgCredits(
  tx: WriteTx,
  orgId: string,
  amount: number,
): Promise<void> {
  await writeOrgMetadataWithDefaultPlanEntitlement(
    tx,
    orgId,
    async (writeTx) => {
      return await writeTx
        .insert(orgMetadataCanonicalWrites)
        .values({
          orgId,
          credits: amount,
          createdAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .onConflictDoUpdate({
          target: orgMetadataCanonicalWrites.orgId,
          set: {
            credits: sql`${orgMetadata.credits} + ${amount}`,
            updatedAt: sql`now()`,
          },
        })
        .returning({ orgId: orgMetadata.orgId, tier: orgMetadata.tier });
    },
  );
}

async function createExpiresRecord(
  tx: WriteTx,
  orgId: string,
  params: {
    readonly source: string;
    readonly stripeInvoiceId: string;
    readonly amount: number;
    readonly expiresAt: Date;
  },
): Promise<boolean> {
  const rows = await tx
    .insert(creditExpiresRecord)
    .values({
      orgId,
      source: params.source,
      stripeInvoiceId: params.stripeInvoiceId,
      amount: params.amount,
      remaining: params.amount,
      expiresAt: params.expiresAt,
    })
    .onConflictDoNothing()
    .returning({ id: creditExpiresRecord.id });

  return rows.length > 0;
}

async function lockInvoicePaidOrg(
  tx: WriteTx,
  orgId: string,
): Promise<LockedInvoicePaidOrg | null> {
  const [org] = await tx
    .select({
      orgId: orgMetadata.orgId,
      lastProcessedInvoiceId: orgMetadata.lastProcessedInvoiceId,
      stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
      subscriptionStatus: orgMetadata.subscriptionStatus,
      tier: orgMetadata.tier,
      planEntitlementSource: orgPlanEntitlements.source,
      planEntitlementPeriodEnd: orgPlanEntitlements.currentPeriodEnd,
      planEntitlementSourceMetadata: orgPlanEntitlements.sourceMetadata,
    })
    .from(orgMetadata)
    .leftJoin(
      orgPlanEntitlements,
      eq(orgPlanEntitlements.orgId, orgMetadata.orgId),
    )
    .where(eq(orgMetadata.orgId, orgId))
    .for("update", { of: orgMetadata })
    .limit(1);

  return org ?? null;
}

async function existingTrialPlanCredits(
  tx: WriteTx,
  args: {
    readonly orgId: string;
    readonly credits: number;
  },
): Promise<boolean> {
  const rows = await tx
    .select({ id: creditExpiresRecord.id })
    .from(creditExpiresRecord)
    .where(
      and(
        eq(creditExpiresRecord.orgId, args.orgId),
        eq(creditExpiresRecord.source, "subscription_renewal"),
        eq(creditExpiresRecord.amount, args.credits),
      ),
    )
    .for("update");

  return rows.length > 0;
}

async function refreshTrialPlanCredits(
  tx: WriteTx,
  args: {
    readonly orgId: string;
    readonly credits: number;
    readonly expiresAt: Date;
  },
): Promise<void> {
  await tx
    .update(creditExpiresRecord)
    .set({ expiresAt: args.expiresAt })
    .where(
      and(
        eq(creditExpiresRecord.orgId, args.orgId),
        eq(creditExpiresRecord.source, "subscription_renewal"),
        eq(creditExpiresRecord.amount, args.credits),
        gt(creditExpiresRecord.remaining, 0),
      ),
    );
}

async function expireCredits(tx: WriteTx, orgId: string): Promise<number> {
  const expired = await tx
    .select({
      id: creditExpiresRecord.id,
      remaining: creditExpiresRecord.remaining,
    })
    .from(creditExpiresRecord)
    .where(
      and(
        eq(creditExpiresRecord.orgId, orgId),
        lte(creditExpiresRecord.expiresAt, nowDate()),
        gt(creditExpiresRecord.remaining, 0),
      ),
    )
    .for("update");

  if (expired.length === 0) {
    return 0;
  }

  const totalExpired = expired.reduce((sum, record) => {
    return sum + record.remaining;
  }, 0);

  for (const record of expired) {
    await tx
      .update(creditExpiresRecord)
      .set({ remaining: 0 })
      .where(eq(creditExpiresRecord.id, record.id));
  }

  if (totalExpired > 0) {
    await tx
      .update(orgMetadata)
      .set({
        credits: sql`GREATEST(${orgMetadata.credits} - ${totalExpired}, 0)`,
        updatedAt: nowDate(),
      })
      .where(eq(orgMetadata.orgId, orgId));
  }

  L.debug("expired credits settled", { orgId, totalExpired });
  return totalExpired;
}

async function handleAutoRechargeInvoicePaid(
  db: Db,
  invoice: Pick<InvoiceInput, "id" | "metadata">,
): Promise<PaidWebhookOutcome> {
  const metadata = invoice.metadata;
  if (!metadata || metadata.type !== "auto_recharge") {
    return { handled: false, drainOrgId: null };
  }

  const orgId = metadata.orgId;
  const creditsAmount = Number(metadata.creditsAmount);
  if (!orgId || !creditsAmount || Number.isNaN(creditsAmount)) {
    L.warn("Auto-recharge invoice has invalid metadata", {
      invoiceId: invoice.id,
      metadata,
    });
    return { handled: false, drainOrgId: null };
  }

  const grantResult = await db.transaction(
    async (tx): Promise<"duplicate" | "granted"> => {
      const inserted = await createExpiresRecord(tx, orgId, {
        source: "auto_recharge",
        stripeInvoiceId: invoice.id,
        amount: creditsAmount,
        expiresAt: autoRechargeNeverExpiresAt(),
      });

      if (!inserted) {
        L.debug("Auto-recharge invoice already processed", {
          orgId,
          invoiceId: invoice.id,
        });
        return "duplicate";
      }

      await grantOrgCredits(tx, orgId, creditsAmount);
      await tx
        .update(orgMetadata)
        .set({ autoRechargePendingAt: null, updatedAt: nowDate() })
        .where(eq(orgMetadata.orgId, orgId));
      return "granted";
    },
  );

  if (grantResult === "granted") {
    L.debug("Auto-recharge credits granted", {
      orgId,
      creditsAmount,
      invoiceId: invoice.id,
    });
  }

  return { handled: true, drainOrgId: orgId };
}

async function handleCreditPurchaseInvoicePaid(
  db: Db,
  invoice: Pick<InvoiceInput, "id" | "metadata" | "subtotal">,
): Promise<PaidWebhookOutcome> {
  const metadata = invoice.metadata;
  if (
    !metadata ||
    (metadata.type !== "credit_purchase" &&
      metadata.purpose !== "credit_purchase")
  ) {
    return { handled: false, drainOrgId: null };
  }

  const orgId = metadata.orgId;
  const creditsAmount = creditsFromAmountCents(invoice.subtotal);
  if (!orgId || !creditsAmount || Number.isNaN(creditsAmount)) {
    L.warn("credit_purchase invoice has invalid metadata or subtotal", {
      invoiceId: invoice.id,
      hasOrgId: Boolean(orgId),
      subtotal: invoice.subtotal ?? null,
      metadata,
    });
    return { handled: true, drainOrgId: null };
  }

  const expiresAt = creditPurchaseExpiresAt(metadata);
  if (!expiresAt) {
    L.warn("credit_purchase invoice has invalid credits expiration metadata", {
      invoiceId: invoice.id,
      orgId,
      creditsExpiresAt:
        metadata[CREDIT_PURCHASE_EXPIRES_AT_METADATA_KEY] ?? null,
    });
    return { handled: true, drainOrgId: null };
  }

  await db.transaction(async (tx) => {
    const inserted = await createExpiresRecord(tx, orgId, {
      source: "credit_purchase",
      stripeInvoiceId: invoice.id,
      amount: creditsAmount,
      expiresAt,
    });

    if (!inserted) {
      L.debug("credit_purchase invoice already processed", {
        invoiceId: invoice.id,
        orgId,
      });
      return;
    }

    await grantOrgCredits(tx, orgId, creditsAmount);
  });

  return { handled: true, drainOrgId: orgId };
}

async function processAtomCreditGrantInvoicePaid(
  db: Db,
  invoice: InvoiceInput,
  details: AtomCreditGrantInvoiceDetails,
): Promise<void> {
  await db.transaction(async (tx) => {
    const inserted = await createExpiresRecord(tx, details.orgId, {
      source: "credit_purchase",
      stripeInvoiceId: invoice.id,
      amount: details.credits,
      expiresAt: details.creditExpiresAt,
    });
    if (!inserted) {
      L.debug("atom credit grant invoice already processed", {
        invoiceId: invoice.id,
        orgId: details.orgId,
      });
      return;
    }

    await grantOrgCredits(tx, details.orgId, details.credits);
  });
}

async function processAtomUsagePackCreditGrantInvoicePaid(
  db: Db,
  invoice: InvoiceInput,
  details: AtomUsagePackCreditGrantInvoiceDetails,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [activePlan] = await tx
      .select({
        stripeCustomerId: orgMetadata.stripeCustomerId,
      })
      .from(orgPlanEntitlements)
      .innerJoin(orgMetadata, eq(orgMetadata.orgId, orgPlanEntitlements.orgId))
      .where(
        and(
          eq(orgPlanEntitlements.orgId, details.orgId),
          inArray(orgPlanEntitlements.planKey, ["pro", "team"]),
          eq(orgPlanEntitlements.status, "active"),
          or(
            isNull(orgPlanEntitlements.expiresAt),
            gt(orgPlanEntitlements.expiresAt, nowDate()),
          ),
        ),
      )
      .for("update")
      .limit(1);
    if (!activePlan || activePlan.stripeCustomerId !== details.customerId) {
      throw new Error(
        `Atom usage pack grant ${invoice.id} requires an active Pro or Team plan`,
      );
    }

    await createUsagePackCreditGrant(tx, {
      orgId: details.orgId,
      userId: details.userId,
      grantType: "bonus",
      idempotencyKey: `atom-usage-pack:${invoice.id}:${details.userId}`,
      amount: details.credits,
      expiresAt: details.creditsExpiresAt,
    });
  });
}

function rejectAtomGrantTierReplacement(args: {
  readonly invoice: InvoiceInput;
  readonly details: AtomPlanGrantInvoiceDetails;
  readonly lockedOrg: LockedInvoicePaidOrg;
}): void {
  if (
    args.invoice.metadata?.planVersion === "usagePack" &&
    args.lockedOrg.stripeSubscriptionId !== null
  ) {
    L.warn(
      "atom usage-pack grant is waiting for the existing subscription deletion",
      {
        invoiceId: args.invoice.id,
        orgId: args.details.orgId,
        currentTier: args.lockedOrg.tier,
        targetTier: args.details.tier,
        stripeSubscriptionId: args.lockedOrg.stripeSubscriptionId,
      },
    );
    throw new Error(
      `Cannot apply Atom ${args.details.tier} usage-pack grant while subscription ${args.lockedOrg.stripeSubscriptionId} still owns tier ${args.lockedOrg.tier}; retry after customer.subscription.deleted`,
    );
  }

  L.warn("atom grant invoice rejected tier replacement", {
    invoiceId: args.invoice.id,
    orgId: args.details.orgId,
    currentTier: args.lockedOrg.tier,
    targetTier: args.details.tier,
    reason: atomGrantTierConflictMessage({
      currentTier: args.lockedOrg.tier,
      targetTier: args.details.tier,
    }),
  });
}

async function grantAtomRedeemMemberUsagePack(
  tx: WriteTx,
  invoice: InvoiceInput,
  details: AtomPlanGrantInvoiceDetails,
): Promise<void> {
  if (!details.memberUsagePack) {
    return;
  }

  await createUsagePackCreditGrant(tx, {
    orgId: details.orgId,
    userId: details.memberUsagePack.userId,
    grantType: "bonus",
    idempotencyKey: `atom-redeem-usage-pack:${invoice.id}:${details.memberUsagePack.userId}`,
    amount: details.memberUsagePack.credits,
    expiresAt: details.memberUsagePack.expiresAt,
  });
}

async function insertStripeCustomerOrgMetadata(
  tx: WriteTx,
  args: { readonly orgId: string; readonly customerId?: string | null },
): Promise<boolean> {
  const rows = await tx
    .insert(orgMetadataCanonicalWrites)
    .values({
      orgId: args.orgId,
      ...(args.customerId ? { stripeCustomerId: args.customerId } : {}),
    })
    .onConflictDoNothing({ target: orgMetadataCanonicalWrites.orgId })
    .returning({ orgId: orgMetadata.orgId, tier: orgMetadata.tier });
  for (const row of rows) {
    await ensureOrgMetadataPlanEntitlement(tx, row);
  }
  return rows.length > 0;
}

async function processAtomPlanGrantInvoicePaid(
  db: Db,
  invoice: InvoiceInput,
  details: AtomPlanGrantInvoiceDetails,
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    await insertStripeCustomerOrgMetadata(tx, details);
    const lockedOrg = await lockInvoicePaidOrg(tx, details.orgId);
    if (!lockedOrg) {
      return false;
    }
    if (lockedOrg.lastProcessedInvoiceId === invoice.id) {
      if (
        lockedOrg.tier === details.tier &&
        lockedOrg.subscriptionStatus === ATOM_GRANT_SUBSCRIPTION_STATUS &&
        lockedOrg.stripeSubscriptionId === null
      ) {
        await upsertAtomGrantPlanEntitlement(tx, invoice, details);
      }
      await grantAtomRedeemMemberUsagePack(tx, invoice, details);
      await cancelReplacedSubscriptionsAfterAtomGrant({
        orgId: details.orgId,
        customerId: details.customerId,
        invoiceId: invoice.id,
        knownOldSubscriptionId: lockedOrg.stripeSubscriptionId,
      });
      L.debug("atom grant invoice already processed", {
        invoiceId: invoice.id,
        orgId: details.orgId,
      });
      return true;
    }
    if (
      atomUsagePackGrantWouldNotExtendEntitlement({
        invoice,
        details,
        lockedOrg,
      })
    ) {
      await grantAtomRedeemMemberUsagePack(tx, invoice, details);
      return true;
    }
    if (
      atomGrantWouldReplaceWithSameOrLowerTier({
        lockedOrg,
        targetTier: details.tier,
      })
    ) {
      rejectAtomGrantTierReplacement({ invoice, details, lockedOrg });
      return false;
    }

    if (details.credits > 0) {
      await expireCredits(tx, details.orgId);
      const inserted = await createExpiresRecord(tx, details.orgId, {
        source: "subscription_renewal",
        stripeInvoiceId: invoice.id,
        amount: details.credits,
        expiresAt: details.creditExpiresAt,
      });
      if (!inserted) {
        if (
          lockedOrg.tier === details.tier &&
          lockedOrg.subscriptionStatus === ATOM_GRANT_SUBSCRIPTION_STATUS &&
          lockedOrg.stripeSubscriptionId === null
        ) {
          await upsertAtomGrantPlanEntitlement(tx, invoice, details);
        }
        await cancelReplacedSubscriptionsAfterAtomGrant({
          orgId: details.orgId,
          customerId: details.customerId,
          invoiceId: invoice.id,
          knownOldSubscriptionId: lockedOrg.stripeSubscriptionId,
        });
        L.debug("atom grant invoice credits already processed", {
          invoiceId: invoice.id,
          orgId: details.orgId,
        });
        return true;
      }

      await grantOrgCredits(tx, details.orgId, details.credits);
    }
    await writeOrgMetadataWithPlanEntitlements(tx, {
      writeOrgMetadata: async (writeTx) => {
        return await writeTx
          .update(orgMetadata)
          .set({
            tier: details.tier,
            ...(details.customerId
              ? { stripeCustomerId: details.customerId }
              : {}),
            stripeSubscriptionId: null,
            subscriptionStatus: ATOM_GRANT_SUBSCRIPTION_STATUS,
            cancelAtPeriodEnd: details.grantExpiresAt !== null,
            onboardingPaymentPending: false,
            lastProcessedInvoiceId: invoice.id,
            currentPeriodEnd: details.grantExpiresAt,
            pendingSubscriptionScheduleId: null,
            pendingSubscriptionTargetTier: details.grantExpiresAt
              ? CANCELED_SUBSCRIPTION_TARGET_TIER
              : null,
            pendingSubscriptionChangeAt: details.grantExpiresAt,
            updatedAt: nowDate(),
          })
          .where(eq(orgMetadata.orgId, details.orgId))
          .returning({ orgId: orgMetadata.orgId });
      },
      writePlanEntitlement: async (writeTx) => {
        await upsertAtomGrantPlanEntitlement(writeTx, invoice, details);
      },
    });
    await grantAtomRedeemMemberUsagePack(tx, invoice, details);
    await cancelReplacedSubscriptionsAfterAtomGrant({
      orgId: details.orgId,
      customerId: details.customerId,
      invoiceId: invoice.id,
      knownOldSubscriptionId: lockedOrg.stripeSubscriptionId,
    });
    return true;
  });
}

async function upsertAtomGrantPlanEntitlement(
  tx: WriteTx,
  invoice: InvoiceInput,
  details: AtomPlanGrantInvoiceDetails,
): Promise<void> {
  const grantLine = invoiceAtomGrantLine(invoice);
  const periodStart = grantLine?.period.start;
  await upsertOrgPlanEntitlement(tx, {
    orgId: details.orgId,
    tier: details.tier,
    source: "stripe_atom_grant",
    currentPeriodStart:
      typeof periodStart === "number" ? new Date(periodStart * 1000) : null,
    currentPeriodEnd: details.grantExpiresAt,
    expiresAt: details.grantExpiresAt,
    stripePriceId: grantLine ? invoiceLinePriceId(grantLine) : null,
    showUsagePack: invoice.metadata?.planVersion === "usagePack",
    sourceMetadata: {
      ...invoice.metadata,
      atomPlanInvoiceId: invoice.id,
    },
  });
}

async function handleAtomGrantInvoicePaid(
  db: Db,
  invoice: InvoiceInput,
): Promise<PaidWebhookOutcome> {
  if (!isAtomGrantInvoice(invoice)) {
    return { handled: false, drainOrgId: null };
  }

  const details = atomGrantInvoiceDetails(invoice);
  if (!details) {
    return { handled: true, drainOrgId: null };
  }

  if (details.kind === "credits") {
    await processAtomCreditGrantInvoicePaid(db, invoice, details);
    L.debug("atom credit grant invoice processed", {
      invoiceId: invoice.id,
      orgId: details.orgId,
      credits: details.credits,
      creditExpiresAt: details.creditExpiresAt.toISOString(),
    });
    return { handled: true, drainOrgId: details.orgId };
  }

  if (details.kind === "usagePackCredits") {
    await processAtomUsagePackCreditGrantInvoicePaid(db, invoice, details);
    L.debug("atom member usage pack credit grant invoice processed", {
      invoiceId: invoice.id,
      orgId: details.orgId,
      userId: details.userId,
      credits: details.credits,
      creditsExpiresAt: details.creditsExpiresAt.toISOString(),
    });
    return { handled: true, drainOrgId: details.orgId };
  }

  const processed = await processAtomPlanGrantInvoicePaid(db, invoice, details);
  if (!processed) {
    return { handled: true, drainOrgId: null };
  }

  L.debug("atom grant invoice processed", {
    invoiceId: invoice.id,
    orgId: details.orgId,
    tier: details.tier,
    grantExpiresAt: details.grantExpiresAt?.toISOString() ?? null,
    creditExpiresAt: details.creditExpiresAt.toISOString(),
    memberUsagePackCredits: details.memberUsagePack?.credits ?? 0,
    memberUsagePackUserId: details.memberUsagePack?.userId ?? null,
  });
  return { handled: true, drainOrgId: details.orgId };
}

async function handleOneTimePurchaseCompleted(
  db: Db,
  session: CheckoutSessionInput,
  paidAt: Date,
): Promise<string | null> {
  const metadata = session.metadata ?? {};
  const orgId = metadata.orgId;
  const campaignKey = metadata.campaignKey;

  if (!orgId || !campaignKey) {
    L.warn("one_time_purchase missing metadata", {
      sessionId: session.id,
      hasOrgId: Boolean(orgId),
      hasCampaignKey: Boolean(campaignKey),
    });
    return null;
  }

  const campaign = getCampaign(campaignKey);
  if (!campaign) {
    L.warn("one_time_purchase unknown campaign; skipping", {
      sessionId: session.id,
      campaignKey,
    });
    return null;
  }

  const expiresAt = new Date(
    paidAt.getTime() + campaign.expiresDays * 24 * 60 * 60 * 1000,
  );

  await db.transaction(async (tx) => {
    const inserted = await createExpiresRecord(tx, orgId, {
      source: campaign.source,
      stripeInvoiceId: session.id,
      amount: campaign.credits,
      expiresAt,
    });

    if (!inserted) {
      L.debug("one_time_purchase already processed", {
        sessionId: session.id,
        orgId,
      });
      return;
    }

    await grantOrgCredits(tx, orgId, campaign.credits);
  });

  return orgId;
}

async function handleCreditPurchaseCompleted(
  db: Db,
  session: CheckoutSessionInput,
): Promise<string | null> {
  if (session.payment_status !== "paid") {
    L.debug("credit_purchase checkout completed before payment settled", {
      sessionId: session.id,
      paymentStatus: session.payment_status ?? null,
    });
    return null;
  }

  const metadata = session.metadata ?? {};
  const orgId = metadata.orgId;
  const creditsAmount = creditPurchaseAmount(session);

  if (!orgId || !creditsAmount || Number.isNaN(creditsAmount)) {
    L.warn("credit_purchase checkout has invalid metadata or amount", {
      sessionId: session.id,
      hasOrgId: Boolean(orgId),
      amountSubtotal: session.amount_subtotal ?? null,
      amountTotal: session.amount_total ?? null,
      metadata,
    });
    return null;
  }

  const expiresAt = creditPurchaseExpiresAt(metadata);
  if (!expiresAt) {
    L.warn("credit_purchase checkout has invalid credits expiration metadata", {
      sessionId: session.id,
      orgId,
      creditsExpiresAt:
        metadata[CREDIT_PURCHASE_EXPIRES_AT_METADATA_KEY] ?? null,
    });
    return null;
  }

  await db.transaction(async (tx) => {
    const inserted = await createExpiresRecord(tx, orgId, {
      source: "credit_purchase",
      stripeInvoiceId: session.id,
      amount: creditsAmount,
      expiresAt,
    });

    if (!inserted) {
      L.debug("credit_purchase checkout already processed", {
        sessionId: session.id,
        orgId,
      });
      return;
    }

    await grantOrgCredits(tx, orgId, creditsAmount);
  });

  return orgId;
}

async function handlePaidCheckoutPurpose(
  db: Db,
  session: CheckoutSessionInput,
  purpose: "one_time_purchase",
  paidAt: Date,
): Promise<PaidWebhookOutcome> {
  if (session.metadata?.purpose !== purpose) {
    return { handled: false, drainOrgId: null };
  }

  if (session.payment_status !== "paid") {
    L.debug(`${purpose} checkout completed before payment settled`, {
      sessionId: session.id,
      paymentStatus: session.payment_status ?? null,
    });
    return { handled: true, drainOrgId: null };
  }

  const drainOrgId = await handleOneTimePurchaseCompleted(db, session, paidAt);
  return { handled: true, drainOrgId };
}

function checkoutSubscriptionContext(
  session: CheckoutSessionInput,
): CheckoutSubscriptionContext | null {
  const subscriptionId =
    typeof session.subscription === "string"
      ? session.subscription
      : session.subscription?.id;
  if (!subscriptionId) {
    L.warn("checkout.session.completed without subscription ID", {
      sessionId: session.id,
    });
    return null;
  }

  const customerId =
    typeof session.customer === "string"
      ? session.customer
      : session.customer?.id;
  if (!customerId) {
    L.warn("checkout.session.completed without customer ID", {
      sessionId: session.id,
    });
    return null;
  }

  return { customerId, subscriptionId };
}

function checkoutCustomerId(session: CheckoutSessionInput): string | null {
  return typeof session.customer === "string"
    ? session.customer
    : (session.customer?.id ?? null);
}

function setupIntentPaymentMethodId(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const setupIntent = value as {
    readonly payment_method?: string | { readonly id: string } | null;
  };
  const paymentMethod = setupIntent.payment_method;
  if (typeof paymentMethod === "string") {
    return paymentMethod;
  }
  return paymentMethod?.id ?? null;
}

async function checkoutSetupPaymentMethodId(
  stripe: ReturnType<typeof getStripeClient>,
  session: CheckoutSessionInput,
): Promise<string | null> {
  const directPaymentMethodId = setupIntentPaymentMethodId(
    session.setup_intent,
  );
  if (directPaymentMethodId) {
    return directPaymentMethodId;
  }

  const refreshed = await stripe.checkout.sessions.retrieve(session.id, {
    expand: ["setup_intent"],
  });
  return setupIntentPaymentMethodId(
    (refreshed as { readonly setup_intent?: unknown }).setup_intent,
  );
}

function billingRestoreCheckoutMetadata(
  session: CheckoutSessionInput,
): { readonly orgId: string; readonly subscriptionId: string } | null {
  if (session.metadata?.purpose !== BILLING_RESTORE_PURPOSE) {
    return null;
  }

  const orgId = session.metadata.orgId;
  const subscriptionId = session.metadata.subscriptionId;
  if (!orgId || !subscriptionId) {
    L.warn("billing restore checkout missing metadata", {
      sessionId: session.id,
      orgId: orgId ?? null,
      subscriptionId: subscriptionId ?? null,
    });
    return null;
  }
  return { orgId, subscriptionId };
}

function billingPurchaseCheckoutMetadata(
  session: CheckoutSessionInput,
): { readonly orgId: string; readonly subscriptionId: string } | null {
  if (session.metadata?.purpose !== BILLING_PURCHASE_PURPOSE) {
    return null;
  }
  const orgId = session.metadata.orgId;
  const subscriptionId = session.metadata.subscriptionId;
  if (!orgId || !subscriptionId) {
    L.warn("billing purchase checkout missing metadata", {
      sessionId: session.id,
      orgId: orgId ?? null,
      subscriptionId: subscriptionId ?? null,
    });
    return null;
  }
  return { orgId, subscriptionId };
}

function billingDowngradeTargetTier(
  value: string | undefined,
): BillingDowngradeCheckoutTargetTier | null {
  if (
    value === "pro" ||
    value === "limited-free-1" ||
    value === "pro-suspend"
  ) {
    return value;
  }
  return null;
}

function billingDowngradeCheckoutMetadata(session: CheckoutSessionInput): {
  readonly orgId: string;
  readonly subscriptionId: string;
  readonly targetTier: BillingDowngradeCheckoutTargetTier;
} | null {
  if (session.metadata?.purpose !== BILLING_DOWNGRADE_PURPOSE) {
    return null;
  }

  const orgId = session.metadata.orgId;
  const subscriptionId = session.metadata.subscriptionId;
  const targetTier = billingDowngradeTargetTier(session.metadata.targetTier);
  if (!orgId || !subscriptionId || !targetTier) {
    L.warn("billing downgrade checkout missing metadata", {
      sessionId: session.id,
      orgId: orgId ?? null,
      subscriptionId: subscriptionId ?? null,
      targetTier: session.metadata.targetTier ?? null,
    });
    return null;
  }
  return { orgId, subscriptionId, targetTier };
}

async function billingSetupSubscriptionState(
  db: Db,
  metadata: { readonly orgId: string; readonly subscriptionId: string },
  subscriptionScope: "plan" | "purchase",
): Promise<{
  readonly org:
    | {
        readonly stripeCustomerId: string | null;
        readonly stripeSubscriptionId: string | null;
      }
    | undefined;
  readonly subscriptionMatches: boolean;
  readonly expectedCustomerId: string | null;
}> {
  const [org] = await db
    .select({
      stripeCustomerId: orgMetadata.stripeCustomerId,
      stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, metadata.orgId))
    .limit(1);
  if (subscriptionScope === "plan") {
    return {
      org,
      subscriptionMatches:
        org?.stripeSubscriptionId === metadata.subscriptionId,
      expectedCustomerId: org?.stripeCustomerId ?? null,
    };
  }

  const [usagePackSubscriptionsRows, concurrencySubscriptionsRows] =
    await Promise.all([
      db
        .select({ stripeCustomerId: usagePackSubscriptions.stripeCustomerId })
        .from(usagePackSubscriptions)
        .where(
          and(
            eq(usagePackSubscriptions.orgId, metadata.orgId),
            eq(
              usagePackSubscriptions.stripeSubscriptionId,
              metadata.subscriptionId,
            ),
          ),
        )
        .limit(1),
      db
        .select({
          stripeSubscriptionId:
            orgConcurrencySubscriptions.stripeSubscriptionId,
        })
        .from(orgConcurrencySubscriptions)
        .where(
          and(
            eq(orgConcurrencySubscriptions.orgId, metadata.orgId),
            eq(
              orgConcurrencySubscriptions.stripeSubscriptionId,
              metadata.subscriptionId,
            ),
          ),
        )
        .limit(1),
    ]);
  const usagePackSubscription = usagePackSubscriptionsRows[0];
  const concurrencySubscription = concurrencySubscriptionsRows[0];
  return {
    org,
    subscriptionMatches:
      org?.stripeSubscriptionId === metadata.subscriptionId ||
      usagePackSubscription !== undefined ||
      concurrencySubscription !== undefined,
    expectedCustomerId:
      org?.stripeCustomerId ?? usagePackSubscription?.stripeCustomerId ?? null,
  };
}

async function applyBillingSetupPaymentMethod(
  db: Db,
  session: CheckoutSessionInput,
  metadata: { readonly orgId: string; readonly subscriptionId: string },
  logContext: string,
  subscriptionScope: "plan" | "purchase" = "plan",
): Promise<boolean> {
  if (session.mode !== "setup") {
    L.warn(`billing ${logContext} checkout completed with unexpected mode`, {
      sessionId: session.id,
      mode: session.mode ?? null,
    });
    return false;
  }

  const customerId = checkoutCustomerId(session);
  if (!customerId) {
    L.warn(`billing ${logContext} checkout completed without customer`, {
      sessionId: session.id,
      orgId: metadata.orgId,
    });
    return false;
  }

  const { org, subscriptionMatches, expectedCustomerId } =
    await billingSetupSubscriptionState(db, metadata, subscriptionScope);

  if (
    !org ||
    !subscriptionMatches ||
    (expectedCustomerId !== null && expectedCustomerId !== customerId)
  ) {
    L.warn(
      `billing ${logContext} checkout no longer matches org billing state`,
      {
        sessionId: session.id,
        orgId: metadata.orgId,
        customerId,
        metadataSubscriptionId: metadata.subscriptionId,
        orgStripeCustomerId: org?.stripeCustomerId ?? null,
        orgStripeSubscriptionId: org?.stripeSubscriptionId ?? null,
        subscriptionScope,
      },
    );
    return false;
  }

  const stripe = getStripeClient();
  const paymentMethodId = await checkoutSetupPaymentMethodId(stripe, session);
  if (!paymentMethodId) {
    L.warn(`billing ${logContext} checkout has no setup payment method`, {
      sessionId: session.id,
      orgId: metadata.orgId,
    });
    return false;
  }

  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: paymentMethodId },
  });
  return true;
}

async function handleBillingRestoreCheckoutCompleted(
  db: Db,
  session: CheckoutSessionInput,
): Promise<BillingRestoreCheckoutOutcome> {
  const metadata = billingRestoreCheckoutMetadata(session);
  if (!metadata) {
    return { handled: false, orgId: null };
  }
  const paymentMethodSet = await applyBillingSetupPaymentMethod(
    db,
    session,
    metadata,
    "restore",
  );
  if (!paymentMethodSet) {
    return { handled: true, orgId: null };
  }

  const restoreResult = await restoreSubscriptionForOrg(db, {
    orgId: metadata.orgId,
    requirePaymentMethod: false,
  });
  if (!restoreResult.ok) {
    L.warn("billing restore checkout could not restore subscription", {
      sessionId: session.id,
      orgId: metadata.orgId,
      reason: restoreResult.reason,
    });
    return { handled: true, orgId: null };
  }

  return { handled: true, orgId: metadata.orgId };
}

async function handleBillingPurchaseCheckoutCompleted(
  db: Db,
  session: CheckoutSessionInput,
): Promise<BillingRestoreCheckoutOutcome> {
  const metadata = billingPurchaseCheckoutMetadata(session);
  if (!metadata) {
    return { handled: false, orgId: null };
  }
  const paymentMethodSet = await applyBillingSetupPaymentMethod(
    db,
    session,
    metadata,
    "purchase",
    "purchase",
  );
  return {
    handled: true,
    orgId: paymentMethodSet ? metadata.orgId : null,
  };
}

async function handleBillingDowngradeCheckoutCompleted(
  db: Db,
  session: CheckoutSessionInput,
): Promise<BillingRestoreCheckoutOutcome> {
  const metadata = billingDowngradeCheckoutMetadata(session);
  if (!metadata) {
    return { handled: false, orgId: null };
  }
  const paymentMethodSet = await applyBillingSetupPaymentMethod(
    db,
    session,
    metadata,
    "downgrade",
  );
  if (!paymentMethodSet) {
    return { handled: true, orgId: null };
  }

  const downgradeResult = await downgradeSubscriptionForOrg(db, {
    orgId: metadata.orgId,
    targetTier: metadata.targetTier,
    requirePaymentMethod: false,
  });
  if (!downgradeResult.ok) {
    L.warn("billing downgrade checkout could not downgrade subscription", {
      sessionId: session.id,
      orgId: metadata.orgId,
      reason: downgradeResult.reason,
    });
    return { handled: true, orgId: null };
  }

  return { handled: true, orgId: metadata.orgId };
}

async function shouldSkipSubscriptionBinding(
  db: Db,
  args: {
    readonly customerId: string;
    readonly subscriptionId: string;
    readonly subscriptionStatus: string;
    readonly tier: BillingSubscriptionTier;
  },
): Promise<boolean> {
  const [existing] = await db
    .select({
      stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
      subscriptionStatus: orgMetadata.subscriptionStatus,
      tier: orgMetadata.tier,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.stripeCustomerId, args.customerId))
    .limit(1);

  if (existing?.stripeSubscriptionId === args.subscriptionId) {
    L.debug("subscription binding already processed", {
      subscriptionId: args.subscriptionId,
    });
    return true;
  }
  if (
    args.subscriptionStatus === "incomplete" &&
    (existing?.subscriptionStatus === "active" ||
      existing?.subscriptionStatus === "trialing")
  ) {
    L.debug("provisional subscription cannot replace an active subscription", {
      customerId: args.customerId,
      subscriptionId: args.subscriptionId,
      currentSubscriptionId: existing.stripeSubscriptionId,
      currentSubscriptionStatus: existing.subscriptionStatus,
    });
    return true;
  }
  if (
    checkoutWouldReplaceWithSameOrLowerTier({
      currentTier: existing?.tier,
      targetTier: args.tier,
    })
  ) {
    L.warn("subscription binding rejected tier replacement", {
      customerId: args.customerId,
      subscriptionId: args.subscriptionId,
      currentTier: existing?.tier ?? null,
      targetTier: args.tier,
      reason: checkoutTierConflictMessage({
        currentTier: existing?.tier,
        targetTier: args.tier,
      }),
    });
    return true;
  }

  return false;
}

async function orgHasStripeCustomer(
  db: Db,
  customerId: string,
): Promise<boolean> {
  const [existing] = await db
    .select({ orgId: orgMetadata.orgId })
    .from(orgMetadata)
    .where(eq(orgMetadata.stripeCustomerId, customerId))
    .limit(1);

  return Boolean(existing);
}

function isClerkNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  return (
    Reflect.get(error, "statusCode") === 404 ||
    Reflect.get(error, "code") === "NOT_FOUND" ||
    Reflect.get(error, "name") === "NotFoundError"
  );
}

async function clerkOrganizationExists(
  clerk: ClerkClient,
  orgId: string,
): Promise<boolean> {
  const result = await settle(
    clerk.organizations.getOrganization({ organizationId: orgId }),
  );
  if (result.ok) {
    return true;
  }
  if (isClerkNotFound(result.error)) {
    return false;
  }
  throw result.error;
}

async function bindStripeCustomerToOrgMetadata(
  db: Db,
  args: {
    readonly orgId: string;
    readonly customerId: string;
  },
): Promise<boolean> {
  const rows = await db
    .update(orgMetadata)
    .set({ stripeCustomerId: args.customerId, updatedAt: nowDate() })
    .where(
      and(
        eq(orgMetadata.orgId, args.orgId),
        isNull(orgMetadata.stripeCustomerId),
      ),
    )
    .returning({ orgId: orgMetadata.orgId });

  return rows.length > 0;
}

async function insertStripeCustomerForClerkOrg(
  db: Db,
  getClerk: ClerkClientProvider,
  args: {
    readonly orgId: string;
    readonly customerId: string;
    readonly subscriptionId: string;
  },
): Promise<boolean> {
  const existsInClerk = await clerkOrganizationExists(getClerk(), args.orgId);
  if (!existsInClerk) {
    L.warn("stripe customer metadata references missing Clerk org", {
      customerId: args.customerId,
      subscriptionId: args.subscriptionId,
      orgId: args.orgId,
    });
    return false;
  }

  const inserted = await db.transaction(async (tx) => {
    return await insertStripeCustomerOrgMetadata(tx, args);
  });

  if (inserted) {
    L.debug("inserted org metadata from Stripe customer metadata", {
      customerId: args.customerId,
      subscriptionId: args.subscriptionId,
      orgId: args.orgId,
    });
    return true;
  }

  return await bindStripeCustomerToOrgMetadata(db, args);
}

async function bindStripeCustomerFromMetadata(
  db: Db,
  getClerk: ClerkClientProvider,
  args: {
    readonly customerId: string;
    readonly subscriptionId: string;
  },
): Promise<boolean> {
  if (await orgHasStripeCustomer(db, args.customerId)) {
    return true;
  }

  const stripe = getStripeClient();
  const customer = await stripe.customers.retrieve(args.customerId);
  if ("deleted" in customer && customer.deleted) {
    L.warn("stripe customer was deleted before org binding", {
      customerId: args.customerId,
      subscriptionId: args.subscriptionId,
    });
    return false;
  }

  const orgId = customer.metadata.orgId;
  if (!orgId) {
    L.warn("stripe customer has no org metadata", {
      customerId: args.customerId,
      subscriptionId: args.subscriptionId,
    });
    return false;
  }

  if (
    await bindStripeCustomerToOrgMetadata(db, {
      orgId,
      customerId: args.customerId,
    })
  ) {
    return true;
  }

  const [org] = await db
    .select({ stripeCustomerId: orgMetadata.stripeCustomerId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);

  if (!org) {
    return await insertStripeCustomerForClerkOrg(db, getClerk, {
      orgId,
      customerId: args.customerId,
      subscriptionId: args.subscriptionId,
    });
  }

  L.warn("stripe customer metadata could not bind org", {
    customerId: args.customerId,
    subscriptionId: args.subscriptionId,
    orgId,
    existingStripeCustomerId: org?.stripeCustomerId ?? null,
  });
  return false;
}

async function invoicePaidOrgForCustomer(
  db: Db,
  customerId: string,
): Promise<InvoicePaidOrg | null> {
  const [org] = await db
    .select({
      orgId: orgMetadata.orgId,
      lastProcessedInvoiceId: orgMetadata.lastProcessedInvoiceId,
      stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
      subscriptionStatus: orgMetadata.subscriptionStatus,
      tier: orgMetadata.tier,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.stripeCustomerId, customerId))
    .limit(1);

  return org ?? null;
}

async function invoicePaidOrgForCustomerOrMetadata(
  db: Db,
  getClerk: ClerkClientProvider,
  args: {
    readonly customerId: string;
    readonly subscriptionId: string;
  },
): Promise<InvoicePaidOrg | null> {
  const org = await invoicePaidOrgForCustomer(db, args.customerId);
  if (org) {
    return org;
  }

  const bound = await bindStripeCustomerFromMetadata(db, getClerk, args);
  return bound ? await invoicePaidOrgForCustomer(db, args.customerId) : null;
}

interface ConcurrencyInvoiceEntitlementValue {
  readonly orgId: string;
  readonly stripeSubscriptionId: string;
  readonly stripeInvoiceId: string;
  readonly stripeInvoiceLineId: string;
  readonly stripePriceId: string;
  readonly slots: number;
  readonly startsAt: Date;
  readonly expiresAt: Date;
}

function concurrencyInvoiceEntitlementValue(args: {
  readonly invoice: InvoiceInput;
  readonly line: InvoiceLineInput;
  readonly index: number;
  readonly orgId: string;
  readonly subscriptionId: string;
}): ConcurrencyInvoiceEntitlementValue | null {
  const priceId = invoiceLinePriceId(args.line);
  const startsAtUnix = args.line.period.start;
  const expiresAtUnix = args.line.period.end;
  const slots = invoiceLineQuantity(args.line);
  if (
    !priceId ||
    typeof startsAtUnix !== "number" ||
    typeof expiresAtUnix !== "number" ||
    !slots
  ) {
    L.warn("concurrency invoice line missing price or period", {
      invoiceId: args.invoice.id,
      orgId: args.orgId,
      lineId: args.line.id ?? null,
      hasPriceId: Boolean(priceId),
      hasPeriodStart: typeof startsAtUnix === "number",
      hasPeriodEnd: typeof expiresAtUnix === "number",
      hasPositiveQuantity: slots !== null,
    });
    return null;
  }

  return {
    orgId: args.orgId,
    stripeSubscriptionId: args.subscriptionId,
    stripeInvoiceId: args.invoice.id,
    stripeInvoiceLineId: invoiceLineId(args.invoice, args.line, args.index),
    stripePriceId: priceId,
    slots,
    startsAt: new Date(startsAtUnix * 1000),
    expiresAt: new Date(expiresAtUnix * 1000),
  };
}

async function upsertConcurrencySubscriptionState(
  tx: WriteTx,
  args: {
    readonly orgId: string;
    readonly subscriptionId: string;
    readonly state: ConcurrencySubscriptionState;
  },
): Promise<void> {
  const updatedAt = nowDate();
  await tx
    .insert(orgConcurrencySubscriptions)
    .values({
      orgId: args.orgId,
      stripeSubscriptionId: args.subscriptionId,
      stripePriceId: args.state.stripePriceId,
      slots: args.state.slots,
      subscriptionStatus: args.state.subscriptionStatus,
      currentPeriodEnd: args.state.currentPeriodEnd,
      cancelAtPeriodEnd: args.state.cancelAtPeriodEnd,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: orgConcurrencySubscriptions.stripeSubscriptionId,
      set: {
        orgId: args.orgId,
        stripePriceId: args.state.stripePriceId,
        slots: args.state.slots,
        subscriptionStatus: args.state.subscriptionStatus,
        currentPeriodEnd: args.state.currentPeriodEnd,
        cancelAtPeriodEnd: args.state.cancelAtPeriodEnd,
        updatedAt,
      },
    });
}

function concurrencyInvoiceSubscriptionState(
  values: readonly ConcurrencyInvoiceEntitlementValue[],
): ConcurrencySubscriptionState | null {
  const activeValues = values.filter((value) => {
    return value.expiresAt > nowDate();
  });
  const currentValues = activeValues.length > 0 ? activeValues : values;
  const firstValue = currentValues[0];
  if (!firstValue) {
    return null;
  }

  return {
    stripePriceId: firstValue.stripePriceId,
    slots: currentValues.reduce((sum, value) => {
      return sum + value.slots;
    }, 0),
    subscriptionStatus: "active",
    currentPeriodEnd: currentValues.reduce((latest, value) => {
      return value.expiresAt > latest ? value.expiresAt : latest;
    }, firstValue.expiresAt),
    cancelAtPeriodEnd: false,
  };
}

async function handleConcurrencyInvoicePaid(
  db: Db,
  getClerk: ClerkClientProvider,
  invoice: InvoiceInput,
): Promise<PaidWebhookOutcome> {
  const lines = concurrencyInvoiceLines(invoice);
  const hasConcurrencyPurpose = invoiceHasConcurrencyPurpose(invoice);
  if (lines.length === 0 && !hasConcurrencyPurpose) {
    return { handled: false, drainOrgId: null };
  }

  const subscriptionId = subscriptionIdFromInvoice(invoice);
  if (!subscriptionId) {
    L.warn("concurrency invoice.paid without subscription; skipping", {
      invoiceId: invoice.id,
    });
    return { handled: true, drainOrgId: null };
  }

  const customerId = customerIdFromInvoice(invoice);
  if (!customerId) {
    L.warn("concurrency invoice.paid without customer ID", {
      invoiceId: invoice.id,
    });
    return { handled: true, drainOrgId: null };
  }

  const org = await invoicePaidOrgForCustomerOrMetadata(db, getClerk, {
    customerId,
    subscriptionId,
  });
  if (!org) {
    L.warn("concurrency invoice.paid for unknown customer", {
      customerId,
      invoiceId: invoice.id,
      subscriptionId,
    });
    return { handled: true, drainOrgId: null };
  }

  const values = lines.flatMap(({ line, index }) => {
    const value = concurrencyInvoiceEntitlementValue({
      invoice,
      line,
      index,
      orgId: org.orgId,
      subscriptionId,
    });
    return value ? [value] : [];
  });

  if (values.length === 0) {
    L.warn("concurrency invoice.paid had no usable entitlement lines", {
      invoiceId: invoice.id,
      orgId: org.orgId,
      subscriptionId,
    });
  }

  const persisted = await db.transaction(async (tx) => {
    await lockConcurrencySubscriptionState(tx, subscriptionId);
    const [existing] = await tx
      .select({
        subscriptionId: orgConcurrencySubscriptions.stripeSubscriptionId,
      })
      .from(orgConcurrencySubscriptions)
      .where(
        eq(orgConcurrencySubscriptions.stripeSubscriptionId, subscriptionId),
      )
      .limit(1);
    const state = existing
      ? await retrieveConcurrencySubscriptionState(subscriptionId)
      : concurrencyInvoiceSubscriptionState(values);
    if (!state) {
      return null;
    }
    const insertedRows =
      values.length === 0
        ? []
        : await tx
            .insert(orgConcurrencyEntitlements)
            .values(values)
            .onConflictDoNothing()
            .returning({ id: orgConcurrencyEntitlements.id });
    await upsertConcurrencySubscriptionState(tx, {
      orgId: org.orgId,
      subscriptionId,
      state,
    });
    return { insertedLines: insertedRows.length, state };
  });

  if (!persisted) {
    L.warn("concurrency invoice.paid subscription has no concurrency item", {
      invoiceId: invoice.id,
      orgId: org.orgId,
      subscriptionId,
    });
    return { handled: true, drainOrgId: org.orgId };
  }

  L.debug("concurrency invoice.paid processed", {
    invoiceId: invoice.id,
    orgId: org.orgId,
    subscriptionId,
    insertedLines: persisted.insertedLines,
    slots: persisted.state.slots,
  });

  return { handled: true, drainOrgId: org.orgId };
}

type BindSubscriptionToCustomerOrgArgs = {
  readonly customerId: string;
  readonly subscription: SubscriptionInput;
} & (
  | { readonly source: "checkout.session.completed" }
  | {
      readonly source: "customer.subscription.created";
      readonly getClerk: ClerkClientProvider;
    }
);

async function bindSubscriptionToCustomerOrg(
  db: Db,
  args: BindSubscriptionToCustomerOrgArgs,
): Promise<readonly string[]> {
  if (
    args.source === "customer.subscription.created" &&
    !(await bindStripeCustomerFromMetadata(db, args.getClerk, {
      customerId: args.customerId,
      subscriptionId: args.subscription.id,
    }))
  ) {
    return [];
  }

  const planItem = knownBillingPlanPriceItem(args.subscription.items.data);
  const tier = planItem ? tierForKnownPlanPrice(planItem.price) : null;
  if (!planItem || !tier) {
    const firstPriceId = args.subscription.items.data[0]?.price.id;
    if (firstPriceId && isConcurrencyPriceId(firstPriceId)) {
      return [];
    }
    L.debug("subscription has no known plan item", {
      subscriptionId: args.subscription.id,
      source: args.source,
    });
    return [];
  }
  if (
    await shouldSkipSubscriptionBinding(db, {
      customerId: args.customerId,
      subscriptionId: args.subscription.id,
      subscriptionStatus: args.subscription.status,
      tier,
    })
  ) {
    return [];
  }

  const rows = await db
    .update(orgMetadata)
    .set({
      stripeSubscriptionId: args.subscription.id,
      subscriptionStatus: args.subscription.status,
      cancelAtPeriodEnd: subscriptionWillCancel(args.subscription),
      updatedAt: nowDate(),
    })
    .where(eq(orgMetadata.stripeCustomerId, args.customerId))
    .returning({ orgId: orgMetadata.orgId });

  if (rows.length === 0) {
    L.warn("subscription customer has no matching org", {
      customerId: args.customerId,
      subscriptionId: args.subscription.id,
      source: args.source,
    });
  }
  return rows.map((row) => {
    return row.orgId;
  });
}

function invoiceWouldReplaceWithSameOrLowerTier(args: {
  readonly currentSubscriptionId: string | null;
  readonly subscriptionId: string;
  readonly currentTier: string;
  readonly targetTier: BillingSubscriptionTier;
}): boolean {
  return (
    args.currentSubscriptionId !== null &&
    args.currentSubscriptionId !== args.subscriptionId &&
    checkoutWouldReplaceWithSameOrLowerTier({
      currentTier: args.currentTier,
      targetTier: args.targetTier,
    })
  );
}

function replacedPlanSubscriptionId(args: {
  readonly currentSubscriptionId: string | null;
  readonly currentSubscriptionStatus: string | null;
  readonly currentTier: string;
  readonly newSubscriptionId: string;
  readonly targetTier: BillingSubscriptionTier;
}): string | null {
  if (
    !args.currentSubscriptionId ||
    args.currentSubscriptionId === args.newSubscriptionId
  ) {
    return null;
  }

  const replacesPaidTier =
    (args.targetTier === "team" && args.currentTier === "pro") ||
    (args.targetTier === "custom" &&
      (args.currentTier === "pro" || args.currentTier === "team"));
  if (replacesPaidTier || args.currentSubscriptionStatus === "trialing") {
    return args.currentSubscriptionId;
  }

  return null;
}

function tierFromSubscription(subscription: StripeSubscription) {
  const planItem = knownBillingPlanPriceItem(subscription.items.data);
  if (!planItem) {
    return null;
  }
  return tierForKnownPlanPrice(planItem.price);
}

function isReplaceablePlanSubscription(args: {
  readonly newSubscriptionId: string;
  readonly subscription: StripeSubscription;
  readonly targetTier: BillingSubscriptionTier;
}): boolean {
  const subscription = args.subscription;
  const currentTier = tierFromSubscription(subscription);
  const replacesTier =
    (args.targetTier === "team" && currentTier === "pro") ||
    (args.targetTier === "custom" &&
      (currentTier === "pro" || currentTier === "team"));
  return (
    subscription.id !== args.newSubscriptionId &&
    (subscription.status === "active" || subscription.status === "trialing") &&
    replacesTier
  );
}

async function replacedPlanSubscriptionIdsForCustomer(args: {
  readonly customerId: string;
  readonly newSubscriptionId: string;
  readonly targetTier: BillingSubscriptionTier;
}): Promise<readonly string[]> {
  if (args.targetTier !== "team" && args.targetTier !== "custom") {
    return [];
  }

  const stripe = getStripeClient();
  const subscriptions = await listAllStripeSubscriptions(stripe, {
    customer: args.customerId,
    status: "all",
  });

  return subscriptions
    .filter((subscription) => {
      return isReplaceablePlanSubscription({
        newSubscriptionId: args.newSubscriptionId,
        subscription,
        targetTier: args.targetTier,
      });
    })
    .map((subscription) => {
      return subscription.id;
    });
}

async function cancelReplacedPlanSubscriptions(args: {
  readonly orgId: string;
  readonly invoiceId: string;
  readonly oldSubscriptionIds: readonly string[];
  readonly newSubscriptionId: string;
}): Promise<void> {
  const stripe = getStripeClient();
  for (const oldSubscriptionId of new Set(args.oldSubscriptionIds)) {
    const cancelResult = await settle(
      stripe.subscriptions.cancel(oldSubscriptionId, {
        invoice_now: false,
        prorate: false,
      }),
    );
    if (!cancelResult.ok) {
      if (!isStripeResourceMissingError(cancelResult.error)) {
        throw cancelResult.error;
      }
      L.warn("replaced plan subscription is already absent", {
        orgId: args.orgId,
        invoiceId: args.invoiceId,
        oldSubscriptionId,
        newSubscriptionId: args.newSubscriptionId,
      });
      continue;
    }
    L.debug("canceled replaced plan subscription after invoice paid", {
      orgId: args.orgId,
      invoiceId: args.invoiceId,
      oldSubscriptionId,
      newSubscriptionId: args.newSubscriptionId,
    });
  }
}

async function cancelReplacedPlanSubscriptionsAfterInvoice(args: {
  readonly orgId: string;
  readonly customerId: string;
  readonly invoiceId: string;
  readonly newSubscriptionId: string;
  readonly targetTier: BillingSubscriptionTier;
  readonly knownOldSubscriptionId: string | null;
}): Promise<void> {
  const replacedSubscriptionIds = [
    ...(args.knownOldSubscriptionId ? [args.knownOldSubscriptionId] : []),
    ...(await replacedPlanSubscriptionIdsForCustomer({
      customerId: args.customerId,
      newSubscriptionId: args.newSubscriptionId,
      targetTier: args.targetTier,
    })),
  ];
  if (replacedSubscriptionIds.length === 0) {
    return;
  }

  await cancelReplacedPlanSubscriptions({
    orgId: args.orgId,
    invoiceId: args.invoiceId,
    oldSubscriptionIds: replacedSubscriptionIds,
    newSubscriptionId: args.newSubscriptionId,
  });
}

function isReplaceablePaidSubscriptionForAtomGrant(
  subscription: StripeSubscription,
): boolean {
  return (
    (subscription.status === "active" || subscription.status === "trialing") &&
    tierFromSubscription(subscription) !== null
  );
}

async function replacedAtomGrantSubscriptionIdsForCustomer(args: {
  readonly customerId: string;
}): Promise<readonly string[]> {
  const stripe = getStripeClient();
  const subscriptions = await listAllStripeSubscriptions(stripe, {
    customer: args.customerId,
    status: "all",
  });

  return subscriptions
    .filter((subscription) => {
      return isReplaceablePaidSubscriptionForAtomGrant(subscription);
    })
    .map((subscription) => {
      return subscription.id;
    });
}

async function cancelReplacedSubscriptionsAfterAtomGrant(args: {
  readonly orgId: string;
  readonly customerId: string | null;
  readonly invoiceId: string;
  readonly knownOldSubscriptionId: string | null;
}): Promise<void> {
  const replacedSubscriptionIds = [
    ...(args.knownOldSubscriptionId ? [args.knownOldSubscriptionId] : []),
    ...(args.customerId
      ? await replacedAtomGrantSubscriptionIdsForCustomer({
          customerId: args.customerId,
        })
      : []),
  ];
  if (replacedSubscriptionIds.length === 0) {
    return;
  }

  const stripe = getStripeClient();
  for (const oldSubscriptionId of new Set(replacedSubscriptionIds)) {
    const cancelResult = await settle(
      stripe.subscriptions.cancel(oldSubscriptionId, {
        invoice_now: false,
        prorate: false,
      }),
    );
    if (!cancelResult.ok) {
      if (!isStripeResourceMissingError(cancelResult.error)) {
        throw cancelResult.error;
      }
      L.warn("replaced subscription already absent during Atom grant", {
        orgId: args.orgId,
        invoiceId: args.invoiceId,
        oldSubscriptionId,
      });
      continue;
    }
    L.debug("canceled replaced subscription after Atom grant invoice paid", {
      orgId: args.orgId,
      invoiceId: args.invoiceId,
      oldSubscriptionId,
    });
  }
}

function subscriptionIdFromInvoice(invoice: InvoiceInput): string | null {
  const subscription = invoice.parent?.subscription_details?.subscription;
  return typeof subscription === "string"
    ? subscription
    : (subscription?.id ?? null);
}

function customerIdFromInvoice(invoice: InvoiceInput): string | null {
  return typeof invoice.customer === "string"
    ? invoice.customer
    : (invoice.customer?.id ?? null);
}

function invoiceLinePriceId(line: InvoiceLineInput): string | null {
  const pricingPrice = line.pricing?.price_details?.price;
  if (typeof pricingPrice === "string") {
    return line.price?.id ?? pricingPrice;
  }
  return line.price?.id ?? pricingPrice?.id ?? null;
}

function invoiceLineQuantity(line: InvoiceLineInput): number | null {
  if (line.quantity === undefined || line.quantity === null) {
    return 1;
  }
  return line.quantity > 0 ? line.quantity : null;
}

function invoiceLineId(
  invoice: InvoiceInput,
  line: InvoiceLineInput,
  index: number,
): string {
  return line.id ?? `${invoice.id}:${index}`;
}

function invoiceHasConcurrencyPurpose(invoice: InvoiceInput): boolean {
  return (
    invoice.metadata?.purpose === CONCURRENCY_SUBSCRIPTION_PURPOSE ||
    invoice.parent?.subscription_details?.metadata?.purpose ===
      CONCURRENCY_SUBSCRIPTION_PURPOSE
  );
}

function invoiceLineCreditsPreviousItems(line: InvoiceLineInput): boolean {
  const subscriptionCreditedItems =
    line.parent?.subscription_item_details?.proration_details?.credited_items;
  const invoiceCreditedItems =
    line.parent?.invoice_item_details?.proration_details?.credited_items;
  return (
    (subscriptionCreditedItems !== undefined &&
      subscriptionCreditedItems !== null) ||
    (invoiceCreditedItems !== undefined && invoiceCreditedItems !== null)
  );
}

function concurrencyInvoiceLines(
  invoice: InvoiceInput,
): readonly { readonly line: InvoiceLineInput; readonly index: number }[] {
  return invoice.lines.data.flatMap((line, index) => {
    const priceId = invoiceLinePriceId(line);
    return priceId &&
      isConcurrencyPriceId(priceId) &&
      invoiceLineQuantity(line) !== null &&
      !invoiceLineCreditsPreviousItems(line) &&
      (line.amount === undefined || line.amount === null || line.amount >= 0)
      ? [{ line, index }]
      : [];
  });
}

function subscriptionPeriodEndFromInvoice(
  invoice: InvoiceInput,
  orgId: string,
  planPriceId: string,
): Date {
  const subscriptionLine = invoice.lines.data.find((line) => {
    return (
      line.parent?.type === "subscription_item_details" &&
      invoiceLinePriceId(line) === planPriceId
    );
  });
  const periodEndUnix = subscriptionLine?.period.end;
  if (!periodEndUnix) {
    throw new Error(
      `invoice.paid has no subscription line item with period.end (invoiceId=${invoice.id}, orgId=${orgId})`,
    );
  }
  return new Date(periodEndUnix * 1000);
}

function subscriptionPeriodStartFromInvoice(
  invoice: InvoiceInput,
  planPriceId: string,
): Date | null {
  const periodStartUnix = invoice.lines.data.find((line) => {
    return (
      line.parent?.type === "subscription_item_details" &&
      invoiceLinePriceId(line) === planPriceId
    );
  })?.period.start;
  return typeof periodStartUnix === "number"
    ? new Date(periodStartUnix * 1000)
    : null;
}

async function subscriptionInvoiceDetails(
  invoice: InvoiceInput,
  args: {
    readonly subscriptionId: string;
    readonly orgId: string;
  },
): Promise<SubscriptionInvoiceDetails | null> {
  const stripe = getStripeClient();
  const subscription = await stripe.subscriptions.retrieve(args.subscriptionId);
  const planItem = knownBillingPlanPriceItem(subscription.items.data);
  const tier = planItem ? tierForKnownPlanPrice(planItem.price) : null;
  if (!planItem || !tier) {
    L.debug("subscription has no known plan item", {
      subscriptionId: args.subscriptionId,
    });
    return null;
  }
  const priceId = planItem.price.id;
  const usagePackPlan = isUsagePackPlanPriceId(priceId);

  const hasPlanInvoiceLine = invoice.lines.data.some((line) => {
    return (
      line.parent?.type === "subscription_item_details" &&
      invoiceLinePriceId(line) === priceId
    );
  });
  if (!hasPlanInvoiceLine) {
    return null;
  }

  const credits = usagePackPlan ? 0 : monthlyCreditsForTier(tier);
  if (credits <= 0 && tier !== "custom" && !usagePackPlan) {
    L.warn("no credits to grant for tier", {
      tier,
      invoiceId: invoice.id,
      orgId: args.orgId,
    });
    return null;
  }

  const periodEndDate = subscriptionPeriodEndFromInvoice(
    invoice,
    args.orgId,
    priceId,
  );
  const scheduledEndDate =
    (await subscriptionScheduledEnd(stripe, subscription)) ??
    (subscriptionWillCancel(subscription) ? periodEndDate : null);
  return {
    subscription,
    tier,
    priceId,
    credits,
    periodStartDate: subscriptionPeriodStartFromInvoice(invoice, priceId),
    periodEndDate,
    scheduledEndDate,
    expiresAt: subscriptionCreditExpiresAt(subscription, periodEndDate),
  };
}

async function updateSubscriptionInvoiceMetadata(
  tx: WriteTx,
  args: {
    readonly orgId: string;
    readonly invoiceId: string;
    readonly subscriptionId: string;
    readonly details: SubscriptionInvoiceDetails;
  },
): Promise<void> {
  const scheduleId = subscriptionScheduleId(args.details.subscription);
  const willCancel =
    subscriptionWillCancel(args.details.subscription) ||
    args.details.scheduledEndDate !== null;
  const pendingChangeAt = args.details.scheduledEndDate;

  await writeOrgMetadataWithPlanEntitlements(tx, {
    writeOrgMetadata: async (writeTx) => {
      return await writeTx
        .update(orgMetadata)
        .set({
          tier: args.details.tier,
          stripeSubscriptionId: args.subscriptionId,
          subscriptionStatus: args.details.subscription.status,
          cancelAtPeriodEnd: willCancel,
          onboardingPaymentPending: false,
          lastProcessedInvoiceId: args.invoiceId,
          currentPeriodEnd: pendingChangeAt ?? args.details.periodEndDate,
          pendingSubscriptionScheduleId: pendingChangeAt ? scheduleId : null,
          pendingSubscriptionTargetTier: pendingChangeAt
            ? CANCELED_SUBSCRIPTION_TARGET_TIER
            : null,
          pendingSubscriptionChangeAt: pendingChangeAt,
          updatedAt: nowDate(),
        })
        .where(eq(orgMetadata.orgId, args.orgId))
        .returning({ orgId: orgMetadata.orgId });
    },
    writePlanEntitlement: async (writeTx, row) => {
      await upsertSubscriptionPlanEntitlement(writeTx, {
        orgId: row.orgId,
        subscriptionId: args.subscriptionId,
        details: args.details,
      });
    },
  });
}

async function upsertSubscriptionPlanEntitlement(
  tx: WriteTx,
  args: {
    readonly orgId: string;
    readonly subscriptionId: string;
    readonly details: SubscriptionInvoiceDetails;
  },
): Promise<void> {
  const showUsagePack = await stripeSubscriptionUsesMemberUsagePacks(tx, {
    orgId: args.orgId,
    stripeSubscriptionId: args.subscriptionId,
  });
  await upsertOrgPlanEntitlement(tx, {
    orgId: args.orgId,
    tier: args.details.tier,
    source: "stripe_subscription",
    status: args.details.subscription.status,
    stripeSubscriptionId: args.subscriptionId,
    stripePriceId: args.details.priceId,
    currentPeriodStart: args.details.periodStartDate,
    currentPeriodEnd: args.details.periodEndDate,
    cancelAt: args.details.scheduledEndDate,
    expiresAt: args.details.scheduledEndDate,
    showUsagePack,
  });
}

function subscriptionPlanEntitlementIsCurrent(
  lockedOrg: LockedInvoicePaidOrg,
  args: {
    readonly subscriptionId: string;
    readonly details: SubscriptionInvoiceDetails;
  },
): boolean {
  return (
    lockedOrg.tier === args.details.tier &&
    lockedOrg.stripeSubscriptionId === args.subscriptionId
  );
}

async function processNoCreditSubscriptionInvoicePaid(
  tx: WriteTx,
  args: {
    readonly invoice: InvoiceInput;
    readonly customerId: string;
    readonly subscriptionId: string;
    readonly orgId: string;
    readonly details: SubscriptionInvoiceDetails;
    readonly replacedSubscriptionId: string | null;
  },
): Promise<void> {
  await expireCredits(tx, args.orgId);
  await updateSubscriptionInvoiceMetadata(tx, {
    orgId: args.orgId,
    invoiceId: args.invoice.id,
    subscriptionId: args.subscriptionId,
    details: args.details,
  });
  await cancelReplacedPlanSubscriptionsAfterInvoice({
    orgId: args.orgId,
    customerId: args.customerId,
    invoiceId: args.invoice.id,
    newSubscriptionId: args.subscriptionId,
    targetTier: args.details.tier,
    knownOldSubscriptionId: args.replacedSubscriptionId,
  });
}

async function reconcileAlreadyProcessedSubscriptionInvoice(
  tx: WriteTx,
  args: {
    readonly customerId: string;
    readonly details: SubscriptionInvoiceDetails;
    readonly invoiceId: string;
    readonly lockedOrg: LockedInvoicePaidOrg;
    readonly orgId: string;
    readonly replacedSubscriptionId: string | null;
    readonly subscriptionId: string;
  },
): Promise<void> {
  if (subscriptionPlanEntitlementIsCurrent(args.lockedOrg, args)) {
    await upsertSubscriptionPlanEntitlement(tx, {
      orgId: args.orgId,
      subscriptionId: args.subscriptionId,
      details: args.details,
    });
  }
  await cancelReplacedPlanSubscriptionsAfterInvoice({
    orgId: args.orgId,
    customerId: args.customerId,
    invoiceId: args.invoiceId,
    newSubscriptionId: args.subscriptionId,
    targetTier: args.details.tier,
    knownOldSubscriptionId: args.replacedSubscriptionId,
  });
  L.debug("invoice.paid already processed by concurrent delivery", {
    invoiceId: args.invoiceId,
    orgId: args.orgId,
  });
}

async function processSubscriptionInvoicePaid(
  tx: WriteTx,
  args: {
    readonly invoice: InvoiceInput;
    readonly customerId: string;
    readonly subscriptionId: string;
    readonly orgId: string;
    readonly details: SubscriptionInvoiceDetails;
  },
): Promise<boolean> {
  const lockedOrg = await lockInvoicePaidOrg(tx, args.orgId);
  if (!lockedOrg) {
    return false;
  }
  const replacedSubscriptionId = replacedPlanSubscriptionId({
    currentSubscriptionId: lockedOrg.stripeSubscriptionId,
    currentSubscriptionStatus: lockedOrg.subscriptionStatus,
    currentTier: lockedOrg.tier,
    newSubscriptionId: args.subscriptionId,
    targetTier: args.details.tier,
  });

  if (lockedOrg.lastProcessedInvoiceId === args.invoice.id) {
    await reconcileAlreadyProcessedSubscriptionInvoice(tx, {
      ...args,
      invoiceId: args.invoice.id,
      lockedOrg,
      replacedSubscriptionId,
    });
    return true;
  }

  if (
    invoiceWouldReplaceWithSameOrLowerTier({
      currentSubscriptionId: lockedOrg.stripeSubscriptionId,
      subscriptionId: args.subscriptionId,
      currentTier: lockedOrg.tier,
      targetTier: args.details.tier,
    })
  ) {
    L.warn("invoice.paid rejected tier replacement", {
      customerId: args.customerId,
      invoiceId: args.invoice.id,
      subscriptionId: args.subscriptionId,
      currentSubscriptionId: lockedOrg.stripeSubscriptionId,
      currentTier: lockedOrg.tier,
      targetTier: args.details.tier,
      reason: checkoutTierConflictMessage({
        currentTier: lockedOrg.tier,
        targetTier: args.details.tier,
      }),
    });
    return false;
  }

  if (args.details.credits === 0) {
    await processNoCreditSubscriptionInvoicePaid(tx, {
      ...args,
      replacedSubscriptionId,
    });
    return true;
  }

  const trialingExistingSubscription =
    args.details.subscription.status === "trialing" &&
    lockedOrg.stripeSubscriptionId === args.subscriptionId &&
    lockedOrg.tier === args.details.tier &&
    (await existingTrialPlanCredits(tx, {
      orgId: args.orgId,
      credits: args.details.credits,
    }));

  if (trialingExistingSubscription) {
    await refreshTrialPlanCredits(tx, {
      orgId: args.orgId,
      credits: args.details.credits,
      expiresAt: args.details.expiresAt,
    });
    await updateSubscriptionInvoiceMetadata(tx, {
      orgId: args.orgId,
      invoiceId: args.invoice.id,
      subscriptionId: args.subscriptionId,
      details: args.details,
    });
    return true;
  }

  await expireCredits(tx, args.orgId);

  const inserted = await createExpiresRecord(tx, args.orgId, {
    source: "subscription_renewal",
    stripeInvoiceId: args.invoice.id,
    amount: args.details.credits,
    expiresAt: args.details.expiresAt,
  });
  if (!inserted) {
    if (subscriptionPlanEntitlementIsCurrent(lockedOrg, args)) {
      await upsertSubscriptionPlanEntitlement(tx, {
        orgId: args.orgId,
        subscriptionId: args.subscriptionId,
        details: args.details,
      });
    }
    L.debug("invoice.paid already processed by concurrent delivery", {
      invoiceId: args.invoice.id,
      orgId: args.orgId,
    });
    return true;
  }

  await grantOrgCredits(tx, args.orgId, args.details.credits);
  await updateSubscriptionInvoiceMetadata(tx, {
    orgId: args.orgId,
    invoiceId: args.invoice.id,
    subscriptionId: args.subscriptionId,
    details: args.details,
  });
  await cancelReplacedPlanSubscriptionsAfterInvoice({
    orgId: args.orgId,
    customerId: args.customerId,
    invoiceId: args.invoice.id,
    newSubscriptionId: args.subscriptionId,
    targetTier: args.details.tier,
    knownOldSubscriptionId: replacedSubscriptionId,
  });
  return true;
}

function billingSetupCheckoutOutcome(
  result: BillingRestoreCheckoutOutcome,
): CheckoutCompletedOutcome {
  return {
    drainOrgId: null,
    orgIds: result.orgId === null ? [] : [result.orgId],
  };
}

async function handleBillingSetupCheckoutCompleted(
  db: Db,
  session: CheckoutSessionInput,
): Promise<CheckoutCompletedOutcome | null> {
  const restoreResult = await handleBillingRestoreCheckoutCompleted(
    db,
    session,
  );
  if (restoreResult.handled) {
    return billingSetupCheckoutOutcome(restoreResult);
  }
  const downgradeResult = await handleBillingDowngradeCheckoutCompleted(
    db,
    session,
  );
  if (downgradeResult.handled) {
    return billingSetupCheckoutOutcome(downgradeResult);
  }
  const purchaseResult = await handleBillingPurchaseCheckoutCompleted(
    db,
    session,
  );
  return purchaseResult.handled
    ? billingSetupCheckoutOutcome(purchaseResult)
    : null;
}

async function handleCheckoutCompleted(
  db: Db,
  getClerk: ClerkClientProvider,
  session: CheckoutSessionInput,
  paidAt: Date,
  signal: AbortSignal,
): Promise<CheckoutCompletedOutcome> {
  const usagePackInvitation = await handleUsagePackInvitationCheckoutPaid(
    db,
    getClerk(),
    session,
    paidAt,
    signal,
  );
  if (usagePackInvitation.handled) {
    return {
      drainOrgId: null,
      orgIds: usagePackInvitation.orgId ? [usagePackInvitation.orgId] : [],
    };
  }

  const billingSetupResult = await handleBillingSetupCheckoutCompleted(
    db,
    session,
  );
  if (billingSetupResult) {
    return billingSetupResult;
  }

  if (session.metadata?.purpose === "credit_purchase") {
    const invoiceId = checkoutSessionInvoiceId(session);
    if (!invoiceId) {
      const drainOrgId = await handleCreditPurchaseCompleted(db, session);
      return {
        drainOrgId,
        orgIds: drainOrgId === null ? [] : [drainOrgId],
      };
    }

    L.debug("credit_purchase checkout completed; waiting for invoice.paid", {
      sessionId: session.id,
      invoiceId,
      paymentStatus: session.payment_status ?? null,
    });
    return { drainOrgId: null, orgIds: [] };
  }

  const oneTimePurchaseResult = await handlePaidCheckoutPurpose(
    db,
    session,
    "one_time_purchase",
    paidAt,
  );
  if (oneTimePurchaseResult.handled) {
    return {
      drainOrgId: oneTimePurchaseResult.drainOrgId,
      orgIds:
        oneTimePurchaseResult.drainOrgId === null
          ? []
          : [oneTimePurchaseResult.drainOrgId],
    };
  }

  if (session.metadata?.purpose === CONCURRENCY_SUBSCRIPTION_PURPOSE) {
    return { drainOrgId: null, orgIds: [] };
  }

  const checkoutContext = checkoutSubscriptionContext(session);
  if (!checkoutContext) {
    return { drainOrgId: null, orgIds: [] };
  }
  const { customerId, subscriptionId } = checkoutContext;

  const stripe = getStripeClient();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const usagePackOutcome = await handleUsagePackCheckoutCompleted(
    db,
    session,
    subscription,
  );
  const orgIds = await bindSubscriptionToCustomerOrg(db, {
    customerId,
    subscription: usagePackOutcome.subscription ?? subscription,
    source: "checkout.session.completed",
  });
  return {
    drainOrgId: null,
    orgIds: [
      ...new Set([
        ...orgIds,
        ...(usagePackOutcome.orgId ? [usagePackOutcome.orgId] : []),
      ]),
    ],
  };
}

async function handleSubscriptionCreatedLegacy(
  db: Db,
  getClerk: ClerkClientProvider,
  subscription: SubscriptionInput,
): Promise<readonly string[]> {
  const customerId = customerIdFromSubscription(subscription);
  if (!customerId) {
    L.warn("customer.subscription.created without customer ID", {
      subscriptionId: subscription.id,
    });
    return [];
  }

  return await bindSubscriptionToCustomerOrg(db, {
    customerId,
    subscription,
    source: "customer.subscription.created",
    getClerk,
  });
}

async function handleSubscriptionCreated(
  db: Db,
  getClerk: ClerkClientProvider,
  subscription: SubscriptionInput,
): Promise<readonly string[]> {
  const usagePackOutcome = await handleUsagePackSubscriptionCreated(
    db,
    subscription,
  );
  const orgIds = await handleSubscriptionCreatedLegacy(
    db,
    getClerk,
    usagePackOutcome.subscription ?? subscription,
  );
  return [
    ...new Set([
      ...orgIds,
      ...(usagePackOutcome.orgId ? [usagePackOutcome.orgId] : []),
    ]),
  ];
}

async function handlePlanSubscriptionInvoicePaid(
  db: Db,
  getClerk: ClerkClientProvider,
  invoice: InvoiceInput,
  concurrencyResult: PaidWebhookOutcome,
  fallbackDrainOrgId: string | null,
): Promise<string | null> {
  const subscriptionId = subscriptionIdFromInvoice(invoice);
  if (!subscriptionId) {
    L.warn("invoice.paid without subscription; skipping", {
      invoiceId: invoice.id,
    });
    return concurrencyResult.drainOrgId ?? fallbackDrainOrgId;
  }

  const customerId = customerIdFromInvoice(invoice);
  if (!customerId) {
    L.warn("invoice.paid without customer ID", { invoiceId: invoice.id });
    return concurrencyResult.drainOrgId ?? fallbackDrainOrgId;
  }

  const org = await invoicePaidOrgForCustomerOrMetadata(db, getClerk, {
    customerId,
    subscriptionId,
  });
  if (!org) {
    L.warn("invoice.paid for unknown customer", {
      customerId,
      invoiceId: invoice.id,
    });
    return concurrencyResult.drainOrgId ?? fallbackDrainOrgId;
  }
  if (
    concurrencyResult.handled &&
    org.stripeSubscriptionId !== subscriptionId
  ) {
    return concurrencyResult.drainOrgId ?? fallbackDrainOrgId;
  }

  const details = await subscriptionInvoiceDetails(invoice, {
    subscriptionId,
    orgId: org.orgId,
  });
  if (!details) {
    return concurrencyResult.drainOrgId ?? fallbackDrainOrgId;
  }

  const processed = await db.transaction(async (tx) => {
    return await processSubscriptionInvoicePaid(tx, {
      invoice,
      customerId,
      subscriptionId,
      orgId: org.orgId,
      details,
    });
  });
  return processed
    ? org.orgId
    : (concurrencyResult.drainOrgId ?? fallbackDrainOrgId);
}

async function handleInvoicePaid(
  db: Db,
  getClerk: ClerkClientProvider,
  invoice: InvoiceInput,
  signal: AbortSignal,
): Promise<string | null> {
  const migrationResult = await handleUsagePackMigrationInvoicePaid(
    db,
    invoice,
  );
  if (migrationResult.handled) {
    return migrationResult.orgId;
  }

  const invitationResult = await handleUsagePackInvitationInvoicePaid(
    db,
    getClerk(),
    invoice,
    signal,
  );
  if (invitationResult.handled) {
    return invitationResult.orgId;
  }

  const usagePackResult = await handleUsagePackInvoicePaid(db, invoice);
  const invoiceLines = invoice.lines?.data ?? [];
  const hasCustomPlanInvoiceLine = invoiceLines.some((line) => {
    const priceId = invoiceLinePriceId(line);
    return priceId
      ? tierForKnownPlanPrice({ id: priceId }) === "custom"
      : false;
  });
  if (usagePackResult.handled && !hasCustomPlanInvoiceLine) {
    const concurrencyResult = await handleConcurrencyInvoicePaid(
      db,
      getClerk,
      invoice,
    );
    return concurrencyResult.drainOrgId ?? usagePackResult.orgId;
  }
  if (!usagePackResult.handled) {
    const autoRechargeResult = await handleAutoRechargeInvoicePaid(db, invoice);
    if (autoRechargeResult.handled) {
      return autoRechargeResult.drainOrgId;
    }

    const creditPurchaseResult = await handleCreditPurchaseInvoicePaid(
      db,
      invoice,
    );
    if (creditPurchaseResult.handled) {
      return creditPurchaseResult.drainOrgId;
    }
  }

  const usageAllowanceResult = await handleUsageAllowanceInvoicePaid(
    db,
    invoice,
  );

  const atomGrantResult = await handleAtomGrantInvoicePaid(db, invoice);
  if (atomGrantResult.handled) {
    return atomGrantResult.drainOrgId;
  }

  const hasPlanInvoiceLine = invoiceLines.some((line) => {
    const priceId = invoiceLinePriceId(line);
    return priceId ? tierForKnownPlanPrice({ id: priceId }) !== null : false;
  });
  const shouldHandlePlanInvoice =
    hasPlanInvoiceLine &&
    (!usagePackResult.handled || hasCustomPlanInvoiceLine);
  const componentDrainOrgId =
    usageAllowanceResult.drainOrgId ?? usagePackResult.orgId;
  const planDrainOrgId = shouldHandlePlanInvoice
    ? await handlePlanSubscriptionInvoicePaid(
        db,
        getClerk,
        invoice,
        { handled: false, drainOrgId: null },
        componentDrainOrgId,
      )
    : componentDrainOrgId;
  const concurrencyResult = await handleConcurrencyInvoicePaid(
    db,
    getClerk,
    invoice,
  );
  return concurrencyResult.drainOrgId ?? planDrainOrgId;
}

async function handleConcurrencySubscriptionUpdated(
  db: Db,
  subscription: SubscriptionInput,
): Promise<readonly string[]> {
  return await db.transaction(async (tx) => {
    await lockConcurrencySubscriptionState(tx, subscription.id);
    const [existing] = await tx
      .select({
        orgId: orgConcurrencySubscriptions.orgId,
        slots: orgConcurrencySubscriptions.slots,
        cancelAtPeriodEnd: orgConcurrencySubscriptions.cancelAtPeriodEnd,
        scheduledSlots: orgConcurrencySubscriptions.scheduledSlots,
      })
      .from(orgConcurrencySubscriptions)
      .where(
        eq(orgConcurrencySubscriptions.stripeSubscriptionId, subscription.id),
      )
      .limit(1);
    if (!existing) {
      return [];
    }

    const eventState = concurrencySubscriptionState(subscription);
    const state =
      eventState?.slots === existing.slots
        ? eventState
        : await retrieveConcurrencySubscriptionState(subscription.id);
    if (!state) {
      const rows = await tx
        .update(orgConcurrencySubscriptions)
        .set({
          subscriptionStatus: "canceled",
          cancelAtPeriodEnd: false,
          scheduledSlots: null,
          scheduledChangeAt: null,
          currentPeriodEnd: nowDate(),
          updatedAt: nowDate(),
        })
        .where(
          eq(orgConcurrencySubscriptions.stripeSubscriptionId, subscription.id),
        )
        .returning({ orgId: orgConcurrencySubscriptions.orgId });
      return rows.map((row) => {
        return row.orgId;
      });
    }

    const rows = await tx
      .update(orgConcurrencySubscriptions)
      .set({
        stripePriceId: state.stripePriceId,
        slots: state.slots,
        subscriptionStatus: state.subscriptionStatus,
        currentPeriodEnd: state.currentPeriodEnd,
        cancelAtPeriodEnd:
          state.cancelAtPeriodEnd ||
          (existing.cancelAtPeriodEnd &&
            subscription.schedule !== null &&
            subscription.schedule !== undefined),
        ...(existing.scheduledSlots === state.slots
          ? { scheduledSlots: null, scheduledChangeAt: null }
          : {}),
        updatedAt: nowDate(),
      })
      .where(
        eq(orgConcurrencySubscriptions.stripeSubscriptionId, subscription.id),
      )
      .returning({ orgId: orgConcurrencySubscriptions.orgId });

    return rows.map((row) => {
      return row.orgId;
    });
  });
}

type UsageAllowanceSubscriptionUpdateTarget =
  | { readonly by: "subscription"; readonly orgIds: readonly string[] }
  | {
      readonly by: "org";
      readonly orgId: string;
      readonly currentStripeSubscriptionId: string | null;
    };

interface UsageAllowanceSubscriptionCreditsUpdate {
  readonly shortWindowUnits: number;
  readonly weeklyWindowUnits: number;
}

async function usageAllowanceSubscriptionUpdateTarget(
  db: Pick<UsageAllowanceSubscriptionUpdateStore, "select">,
  subscription: Pick<SubscriptionInput, "id" | "items" | "metadata">,
): Promise<UsageAllowanceSubscriptionUpdateTarget | null> {
  const subscriptionRows = await db
    .select({ orgId: orgUsageAllowanceEntitlements.orgId })
    .from(orgUsageAllowanceEntitlements)
    .where(
      eq(orgUsageAllowanceEntitlements.stripeSubscriptionId, subscription.id),
    );
  if (subscriptionRows.length > 0) {
    return {
      by: "subscription",
      orgIds: subscriptionRows.map((row) => {
        return row.orgId;
      }),
    };
  }

  const metadataOrgId = subscription.metadata?.orgId;
  if (
    !metadataOrgId ||
    (!subscription.metadata?.allowancePriceId &&
      !hasUsageAllowanceWindowMetadata(subscription.metadata ?? {}))
  ) {
    return null;
  }

  const orgRows = await db
    .select({
      orgId: orgUsageAllowanceEntitlements.orgId,
      allowanceSubscriptionId:
        orgUsageAllowanceEntitlements.stripeSubscriptionId,
      planSubscriptionId: orgMetadata.stripeSubscriptionId,
      planTier: orgMetadata.tier,
    })
    .from(orgUsageAllowanceEntitlements)
    .innerJoin(
      orgMetadata,
      eq(orgMetadata.orgId, orgUsageAllowanceEntitlements.orgId),
    )
    .where(eq(orgUsageAllowanceEntitlements.orgId, metadataOrgId))
    .limit(1);
  const orgRow = orgRows[0];
  if (!orgRow) {
    return null;
  }

  const planItem = knownBillingPlanPriceItem(subscription.items.data);
  const establishesCustomMainSubscription =
    orgRow.planSubscriptionId === null &&
    orgRow.planTier === "custom" &&
    planItem !== undefined &&
    tierForKnownPlanPrice(planItem.price) === "custom";
  if (
    orgRow.allowanceSubscriptionId !== null &&
    orgRow.allowanceSubscriptionId !== subscription.id &&
    orgRow.planSubscriptionId !== subscription.id &&
    !establishesCustomMainSubscription
  ) {
    return null;
  }

  return {
    by: "org",
    orgId: orgRow.orgId,
    currentStripeSubscriptionId: orgRow.allowanceSubscriptionId,
  };
}

function usageAllowanceSubscriptionCreditsUpdate(
  subscription: Pick<SubscriptionInput, "metadata">,
): UsageAllowanceSubscriptionCreditsUpdate | null {
  const metadata = subscription.metadata;
  if (!metadata || metadata.allowanceStatus === "canceled") {
    return null;
  }

  const shortWindowUnits = positiveMetadataInteger(
    metadata,
    "shortWindowUnits",
  );
  const weeklyWindowUnits = positiveMetadataInteger(
    metadata,
    "weeklyWindowUnits",
  );
  if (!shortWindowUnits || !weeklyWindowUnits) {
    return null;
  }

  return { shortWindowUnits, weeklyWindowUnits };
}

async function updateActiveUsageAllowanceWindowLimits(
  db: Pick<UsageAllowanceSubscriptionUpdateStore, "update">,
  args: {
    readonly orgIds: readonly string[];
    readonly credits: UsageAllowanceSubscriptionCreditsUpdate;
    readonly at: Date;
    readonly updatedAt: Date;
  },
): Promise<void> {
  await Promise.all(
    args.orgIds.flatMap((orgId) => {
      return [
        db
          .update(orgUsageAllowanceWindows)
          .set({
            unitLimit: args.credits.shortWindowUnits,
            updatedAt: args.updatedAt,
          })
          .where(
            and(
              eq(orgUsageAllowanceWindows.orgId, orgId),
              eq(orgUsageAllowanceWindows.kind, "short"),
              lte(orgUsageAllowanceWindows.startsAt, args.at),
              gt(orgUsageAllowanceWindows.expiresAt, args.at),
            ),
          ),
        db
          .update(orgUsageAllowanceWindows)
          .set({
            unitLimit: args.credits.weeklyWindowUnits,
            updatedAt: args.updatedAt,
          })
          .where(
            and(
              eq(orgUsageAllowanceWindows.orgId, orgId),
              eq(orgUsageAllowanceWindows.kind, "weekly"),
              lte(orgUsageAllowanceWindows.startsAt, args.at),
              gt(orgUsageAllowanceWindows.expiresAt, args.at),
            ),
          ),
      ];
    }),
  );
}

async function expireActiveUsageAllowanceWindows(
  db: Pick<UsageAllowanceSubscriptionUpdateStore, "update">,
  args: {
    readonly orgIds: readonly string[];
    readonly at: Date;
    readonly updatedAt: Date;
  },
): Promise<void> {
  await Promise.all(
    args.orgIds.map((orgId) => {
      return db
        .update(orgUsageAllowanceWindows)
        .set({
          expiresAt: sql`GREATEST(${timestampWithoutTimeZone(args.at)}::timestamp, ${orgUsageAllowanceWindows.startsAt} + INTERVAL '1 millisecond')`,
          updatedAt: args.updatedAt,
        })
        .where(
          and(
            eq(orgUsageAllowanceWindows.orgId, orgId),
            lte(orgUsageAllowanceWindows.startsAt, args.at),
            gt(orgUsageAllowanceWindows.expiresAt, args.at),
          ),
        );
    }),
  );
}

async function handleUsageAllowanceSubscriptionUpdated(
  db: Db,
  subscription: SubscriptionInput,
): Promise<readonly string[]> {
  return await db.transaction(async (tx) => {
    const target = await usageAllowanceSubscriptionUpdateTarget(
      tx,
      subscription,
    );
    if (!target) {
      return [];
    }

    const periodEnd = usageAllowanceSubscriptionEnd(subscription);
    const allowanceCancelAt = subscription.metadata?.allowanceCancelAt
      ? new Date(subscription.metadata.allowanceCancelAt)
      : null;
    const terminalStatus =
      subscription.status === "canceled" ||
      subscription.status === "incomplete_expired" ||
      subscription.metadata?.allowanceStatus === "canceled" ||
      (allowanceCancelAt !== null &&
        !Number.isNaN(allowanceCancelAt.getTime()) &&
        allowanceCancelAt <= nowDate());
    const updatedAt = nowDate();
    const credits = usageAllowanceSubscriptionCreditsUpdate(subscription);
    const rows = await tx
      .update(orgUsageAllowanceEntitlements)
      .set({
        status: terminalStatus ? "canceled" : subscription.status,
        ...(terminalStatus
          ? { expiresAt: updatedAt }
          : periodEnd
            ? { expiresAt: periodEnd }
            : {}),
        ...(credits
          ? {
              shortWindowUnits: credits.shortWindowUnits,
              weeklyWindowUnits: credits.weeklyWindowUnits,
            }
          : {}),
        stripeSubscriptionId: subscription.id,
        updatedAt,
      })
      .where(
        target.by === "subscription"
          ? eq(
              orgUsageAllowanceEntitlements.stripeSubscriptionId,
              subscription.id,
            )
          : and(
              eq(orgUsageAllowanceEntitlements.orgId, target.orgId),
              target.currentStripeSubscriptionId === null
                ? isNull(orgUsageAllowanceEntitlements.stripeSubscriptionId)
                : eq(
                    orgUsageAllowanceEntitlements.stripeSubscriptionId,
                    target.currentStripeSubscriptionId,
                  ),
            ),
      )
      .returning({ orgId: orgUsageAllowanceEntitlements.orgId });

    const orgIds = rows.map((row) => {
      return row.orgId;
    });

    if (terminalStatus) {
      await expireActiveUsageAllowanceWindows(tx, {
        orgIds,
        at: updatedAt,
        updatedAt,
      });
    } else if (credits) {
      await updateActiveUsageAllowanceWindowLimits(tx, {
        orgIds,
        credits,
        at: updatedAt,
        updatedAt,
      });
    }

    return orgIds;
  });
}

async function upsertSubscriptionUpdatedPlanEntitlements(
  tx: WriteTx,
  args: {
    readonly rows: readonly { readonly orgId: string }[];
    readonly tier: BillingSubscriptionTier;
    readonly planItem: SubscriptionInput["items"]["data"][number];
    readonly subscription: SubscriptionInput;
    readonly scheduledEnd: Date | null;
  },
): Promise<void> {
  const itemPeriodStart = args.planItem.current_period_start
    ? new Date(args.planItem.current_period_start * 1000)
    : null;
  const itemPeriodEnd = args.planItem.current_period_end
    ? new Date(args.planItem.current_period_end * 1000)
    : null;
  for (const row of args.rows) {
    const showUsagePack = await stripeSubscriptionUsesMemberUsagePacks(tx, {
      orgId: row.orgId,
      stripeSubscriptionId: args.subscription.id,
    });
    await upsertOrgPlanEntitlement(tx, {
      orgId: row.orgId,
      tier: args.tier,
      source: "stripe_subscription",
      status: args.subscription.status,
      stripeSubscriptionId: args.subscription.id,
      stripePriceId: args.planItem.price.id,
      currentPeriodStart: itemPeriodStart,
      currentPeriodEnd: itemPeriodEnd,
      cancelAt: args.scheduledEnd,
      expiresAt: args.scheduledEnd,
      showUsagePack,
      sourceMetadata: args.subscription.metadata ?? {},
    });
  }
}

async function handleSubscriptionUpdatedLegacy(
  db: Db,
  subscription: SubscriptionInput,
  previousAttributes: SubscriptionPreviousAttributes | undefined,
): Promise<readonly string[]> {
  const allowanceOrgIds = await handleUsageAllowanceSubscriptionUpdated(
    db,
    subscription,
  );
  const concurrencyOrgIds = await handleConcurrencySubscriptionUpdated(
    db,
    subscription,
  );
  const stripe = getStripeClient();
  const periodEnd = await subscriptionScheduledEnd(stripe, subscription);
  const willCancel = subscriptionWillCancel(subscription) || periodEnd !== null;
  const pendingScheduleId = subscriptionScheduleId(subscription);
  const clearPendingChange = subscriptionPendingChangeCleared(
    subscription,
    previousAttributes,
    willCancel,
  );
  const trialEnd = subscriptionTrialEnd(subscription);
  const previousTrialEnd =
    typeof previousAttributes?.trial_end === "number"
      ? new Date(previousAttributes.trial_end * 1000)
      : null;
  const trialShortened =
    subscription.status === "trialing" &&
    trialEnd !== null &&
    previousTrialEnd !== null &&
    trialEnd < previousTrialEnd;
  const planItem = knownBillingPlanPriceItem(subscription.items.data);
  const planTier = planItem ? tierForKnownPlanPrice(planItem.price) : null;
  const metadataOrgId = subscription.metadata?.orgId;
  const planTarget =
    planTier === "custom" && metadataOrgId
      ? or(
          eq(orgMetadata.stripeSubscriptionId, subscription.id),
          and(
            eq(orgMetadata.orgId, metadataOrgId),
            eq(orgMetadata.tier, "custom"),
            isNull(orgMetadata.stripeSubscriptionId),
          ),
        )
      : eq(orgMetadata.stripeSubscriptionId, subscription.id);

  const planOrgIds = await db.transaction(async (tx) => {
    const rows = await tx
      .update(orgMetadata)
      .set({
        ...(planTier ? { tier: planTier } : {}),
        ...(planTier ? { stripeSubscriptionId: subscription.id } : {}),
        subscriptionStatus: subscription.status,
        cancelAtPeriodEnd: willCancel,
        updatedAt: nowDate(),
        ...(periodEnd ? { currentPeriodEnd: periodEnd } : {}),
        ...(periodEnd && pendingScheduleId
          ? {
              pendingSubscriptionScheduleId: pendingScheduleId,
              pendingSubscriptionTargetTier: CANCELED_SUBSCRIPTION_TARGET_TIER,
              pendingSubscriptionChangeAt: periodEnd,
            }
          : {}),
        ...(clearPendingChange
          ? {
              pendingSubscriptionScheduleId: null,
              pendingSubscriptionTargetTier: null,
              pendingSubscriptionChangeAt: null,
            }
          : {}),
        ...(trialShortened ? { currentPeriodEnd: trialEnd } : {}),
      })
      .where(planTarget)
      .returning({ orgId: orgMetadata.orgId });

    if (planTier && planItem) {
      await upsertSubscriptionUpdatedPlanEntitlements(tx, {
        rows,
        tier: planTier,
        planItem,
        subscription,
        scheduledEnd: periodEnd,
      });
    }

    if (!trialShortened) {
      return rows.map((row) => {
        return row.orgId;
      });
    }

    for (const row of rows) {
      await tx
        .update(creditExpiresRecord)
        .set({ expiresAt: trialEnd })
        .where(
          and(
            eq(creditExpiresRecord.orgId, row.orgId),
            eq(creditExpiresRecord.source, "subscription_renewal"),
            gt(creditExpiresRecord.expiresAt, trialEnd),
            gt(creditExpiresRecord.remaining, 0),
          ),
        );
    }
    return rows.map((row) => {
      return row.orgId;
    });
  });
  return [
    ...new Set([...allowanceOrgIds, ...concurrencyOrgIds, ...planOrgIds]),
  ];
}

async function handleSubscriptionUpdated(
  db: Db,
  subscription: SubscriptionInput,
  previousAttributes: SubscriptionPreviousAttributes | undefined,
): Promise<readonly string[]> {
  const migrationOutcome = await handleUsagePackMigrationSubscriptionUpdated(
    db,
    subscription,
  );
  if (migrationOutcome.handled) {
    return migrationOutcome.orgId ? [migrationOutcome.orgId] : [];
  }
  const usagePackOutcome = await handleUsagePackSubscriptionUpdated(
    db,
    subscription,
  );
  const orgIds = await handleSubscriptionUpdatedLegacy(
    db,
    usagePackOutcome.subscription ?? subscription,
    previousAttributes,
  );
  return [
    ...new Set([
      ...orgIds,
      ...(usagePackOutcome.orgId ? [usagePackOutcome.orgId] : []),
    ]),
  ];
}

async function handleSubscriptionScheduleReleased(
  db: Db,
  schedule: SubscriptionScheduleInput,
  releasedAt: Date,
): Promise<readonly string[]> {
  const updatedAt = nowDate();
  const { rows, usagePackOrgIds } = await db.transaction(async (tx) => {
    const usagePackOrgIds =
      await failScheduledUsagePackAllocationChangesForSchedule(tx, {
        scheduleId: schedule.id,
        completedAt: updatedAt,
        effectiveAfter: releasedAt,
      });
    const rows = await tx
      .update(orgMetadata)
      .set({
        cancelAtPeriodEnd: false,
        pendingSubscriptionScheduleId: null,
        pendingSubscriptionTargetTier: null,
        pendingSubscriptionChangeAt: null,
        updatedAt,
      })
      .where(eq(orgMetadata.pendingSubscriptionScheduleId, schedule.id))
      .returning({ orgId: orgMetadata.orgId });
    return { rows, usagePackOrgIds };
  });

  const orgIds = [
    ...new Set([
      ...usagePackOrgIds,
      ...rows.map((row) => {
        return row.orgId;
      }),
    ]),
  ];

  if (orgIds.length > 0) {
    L.debug("subscription schedule released; cleared pending billing change", {
      scheduleId: schedule.id,
      orgIds,
    });
  }
  return orgIds;
}

async function handleSubscriptionScheduleEnded(
  db: Db,
  schedule: SubscriptionScheduleInput,
): Promise<readonly string[]> {
  const rows = await db
    .update(orgMetadata)
    .set({
      pendingSubscriptionScheduleId: null,
      pendingSubscriptionTargetTier: null,
      pendingSubscriptionChangeAt: null,
      updatedAt: nowDate(),
    })
    .where(eq(orgMetadata.pendingSubscriptionScheduleId, schedule.id))
    .returning({ orgId: orgMetadata.orgId });

  if (rows.length > 0) {
    L.debug("subscription schedule ended; cleared pending billing change", {
      scheduleId: schedule.id,
      orgIds: rows.map((row) => {
        return row.orgId;
      }),
    });
  }
  return rows.map((row) => {
    return row.orgId;
  });
}

async function handleSubscriptionDeletedLegacy(
  db: Db,
  subscription: SubscriptionDeletedInput,
): Promise<readonly string[]> {
  const allowanceRows = await db.transaction(async (tx) => {
    const canceledAt = nowDate();
    const rows = await tx
      .update(orgUsageAllowanceEntitlements)
      .set({
        status: "canceled",
        expiresAt: canceledAt,
        updatedAt: canceledAt,
      })
      .where(
        eq(orgUsageAllowanceEntitlements.stripeSubscriptionId, subscription.id),
      )
      .returning({ orgId: orgUsageAllowanceEntitlements.orgId });
    await expireActiveUsageAllowanceWindows(tx, {
      orgIds: rows.map((row) => {
        return row.orgId;
      }),
      at: canceledAt,
      updatedAt: canceledAt,
    });
    return rows;
  });
  const concurrencyRows = await db
    .update(orgConcurrencySubscriptions)
    .set({
      subscriptionStatus: "canceled",
      cancelAtPeriodEnd: false,
      currentPeriodEnd: nowDate(),
      updatedAt: nowDate(),
    })
    .where(
      eq(orgConcurrencySubscriptions.stripeSubscriptionId, subscription.id),
    )
    .returning({ orgId: orgConcurrencySubscriptions.orgId });

  const planRows = await db.transaction(async (tx) => {
    const downgraded = await writeOrgMetadataWithPlanEntitlements(tx, {
      writeOrgMetadata: async (writeTx) => {
        return await writeTx
          .update(orgMetadata)
          .set({
            tier: CANCELED_SUBSCRIPTION_TARGET_TIER,
            subscriptionStatus: "canceled",
            stripeSubscriptionId: null,
            cancelAtPeriodEnd: false,
            currentPeriodEnd: null,
            pendingSubscriptionScheduleId: null,
            pendingSubscriptionTargetTier: null,
            pendingSubscriptionChangeAt: null,
            updatedAt: nowDate(),
          })
          .where(eq(orgMetadata.stripeSubscriptionId, subscription.id))
          .returning({ orgId: orgMetadata.orgId });
      },
      writePlanEntitlement: async (writeTx, row) => {
        await upsertOrgPlanEntitlement(writeTx, {
          orgId: row.orgId,
          tier: CANCELED_SUBSCRIPTION_TARGET_TIER,
          source: "stripe_subscription",
          sourceMetadata: subscription.metadata ?? {},
        });
      },
    });

    const persistedOrgId =
      downgraded.length === 0
        ? await orgPlanEntitlementOrgIdForStripeSubscription(
            tx,
            subscription.id,
          )
        : null;
    const [persistedOrg] = persistedOrgId
      ? await tx
          .select({
            tier: orgMetadata.tier,
            stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
          })
          .from(orgMetadata)
          .where(eq(orgMetadata.orgId, persistedOrgId))
          .limit(1)
      : [];
    const replayedDowngradeOrgId =
      persistedOrg?.tier === CANCELED_SUBSCRIPTION_TARGET_TIER &&
      persistedOrg.stripeSubscriptionId === null
        ? persistedOrgId
        : null;
    if (replayedDowngradeOrgId) {
      await upsertOrgPlanEntitlement(tx, {
        orgId: replayedDowngradeOrgId,
        tier: CANCELED_SUBSCRIPTION_TARGET_TIER,
        source: "stripe_subscription",
        sourceMetadata: subscription.metadata ?? {},
      });
    }
    return [
      ...downgraded.map((row) => {
        return row.orgId;
      }),
      ...(replayedDowngradeOrgId ? [replayedDowngradeOrgId] : []),
    ].map((orgId) => {
      return { orgId };
    });
  });
  return [
    ...new Set([
      ...allowanceRows.map((row) => {
        return row.orgId;
      }),
      ...concurrencyRows.map((row) => {
        return row.orgId;
      }),
      ...planRows.map((row) => {
        return row.orgId;
      }),
    ]),
  ];
}

async function handleSubscriptionDeleted(
  db: Db,
  subscription: SubscriptionDeletedInput,
): Promise<readonly string[]> {
  const usagePackOutcome = await handleUsagePackSubscriptionDeleted(
    db,
    subscription,
  );
  const orgIds = await handleSubscriptionDeletedLegacy(db, subscription);
  return [
    ...new Set([
      ...orgIds,
      ...(usagePackOutcome.orgId ? [usagePackOutcome.orgId] : []),
    ]),
  ];
}

export interface StripeSubscriptionSnapshotReconciliation {
  readonly orgIds: readonly string[];
  readonly downgradedOrgIds: readonly string[];
  readonly paidInvoiceId: string | null;
}

async function latestPaidInvoiceForSubscription(
  subscription: StripeSubscription,
  signal: AbortSignal,
): Promise<StripeInvoice | null> {
  const latestInvoice = subscription.latest_invoice;
  if (
    latestInvoice &&
    typeof latestInvoice !== "string" &&
    latestInvoice.status === "paid"
  ) {
    return latestInvoice;
  }

  const page = await getStripeClient().invoices.list({
    subscription: subscription.id,
    status: "paid",
    limit: 1,
  });
  signal.throwIfAborted();
  return page.data[0] ?? null;
}

function reconciliationPreviousAttributes(
  subscription: StripeSubscription,
): SubscriptionPreviousAttributes {
  return {
    // A current-state reconciliation has no event delta. Supplying a previous
    // schedule marker lets the normal update path clear a pending change when
    // Stripe no longer has a cancellation or attached schedule.
    schedule: "billing-reconciliation",
    ...(subscription.status === "trialing" &&
    typeof subscription.trial_end === "number"
      ? { trial_end: subscription.trial_end + 1 }
      : {}),
  };
}

async function paidPlanOrgIdForSubscription(
  db: Db,
  subscriptionId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ orgId: orgMetadata.orgId, tier: orgMetadata.tier })
    .from(orgMetadata)
    .where(eq(orgMetadata.stripeSubscriptionId, subscriptionId))
    .limit(1);
  return row &&
    (row.tier === "pro" || row.tier === "team" || row.tier === "custom")
    ? row.orgId
    : null;
}

/**
 * Replays the idempotent Stripe webhook projections from a current
 * subscription snapshot. The billing cron uses this when delivery of any
 * subscription or paid-invoice webhook may have been missed.
 */
export async function reconcileStripeSubscriptionSnapshot(
  db: Db,
  getClerk: ClerkClientProvider,
  subscription: StripeSubscription,
  signal: AbortSignal,
): Promise<StripeSubscriptionSnapshotReconciliation> {
  const terminal =
    subscription.status === "canceled" ||
    subscription.status === "ended" ||
    subscription.status === "incomplete_expired";
  if (terminal) {
    const downgradedOrgId = await paidPlanOrgIdForSubscription(
      db,
      subscription.id,
    );
    signal.throwIfAborted();
    const orgIds = await handleSubscriptionDeleted(db, subscription);
    signal.throwIfAborted();
    return {
      orgIds,
      downgradedOrgIds: downgradedOrgId ? [downgradedOrgId] : [],
      paidInvoiceId: null,
    };
  }

  const orgIds = new Set<string>();
  // A snapshot is current state, not a creation event. The strict usage-pack
  // creation path intentionally rejects an invalid initial shape, but that is
  // wrong for reconciliation: a valid Custom subscription can currently have
  // no usage-pack items because their removal webhook was missed. Bind any
  // unrecorded main plan first, then let the update projection deactivate or
  // repair the usage-pack component from current Stripe truth.
  for (const orgId of await handleSubscriptionCreatedLegacy(
    db,
    getClerk,
    subscription,
  )) {
    orgIds.add(orgId);
  }
  signal.throwIfAborted();

  for (const orgId of await handleSubscriptionUpdated(
    db,
    subscription,
    reconciliationPreviousAttributes(subscription),
  )) {
    orgIds.add(orgId);
  }
  signal.throwIfAborted();

  const paidInvoice = await latestPaidInvoiceForSubscription(
    subscription,
    signal,
  );
  const invoiceOrgId = paidInvoice
    ? await handleInvoicePaid(db, getClerk, paidInvoice, signal)
    : null;
  signal.throwIfAborted();
  if (invoiceOrgId) {
    orgIds.add(invoiceOrgId);
  }

  return {
    orgIds: [...orgIds],
    downgradedOrgIds: [],
    paidInvoiceId: paidInvoice?.id ?? null,
  };
}

/** Reconciles a locally referenced subscription that Stripe no longer has. */
export async function reconcileMissingStripeSubscription(
  db: Db,
  subscriptionId: string,
  signal: AbortSignal,
): Promise<StripeSubscriptionSnapshotReconciliation> {
  const downgradedOrgId = await paidPlanOrgIdForSubscription(
    db,
    subscriptionId,
  );
  signal.throwIfAborted();
  const orgIds = await handleSubscriptionDeleted(db, {
    id: subscriptionId,
    metadata: {},
  });
  signal.throwIfAborted();
  return {
    orgIds,
    downgradedOrgIds: downgradedOrgId ? [downgradedOrgId] : [],
    paidInvoiceId: null,
  };
}

async function publishBillingChanges(
  db: Db,
  orgIds: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<void> {
  for (const orgId of orgIds) {
    await disableIneligibleWorkflowWebhookAutomationsForOrg(
      db,
      { orgId },
      signal,
    );
    signal.throwIfAborted();
    await publishBillingChangedForOrg(db, orgId);
    signal.throwIfAborted();
  }
}

export const reconcilePaidStripeCheckoutSession$ = command(
  async (
    { get, set },
    input: {
      readonly session: StripeCheckoutSession;
      readonly paidAt: Date;
    },
    signal: AbortSignal,
  ): Promise<readonly string[]> => {
    if (!isCurrentStripePreviewMetadata(input.session.metadata)) {
      return [];
    }

    const db = set(writeDb$);
    const getClerk = (): ClerkClient => {
      return get(clerk$);
    };
    const result = await handleCheckoutCompleted(
      db,
      getClerk,
      input.session,
      input.paidAt,
      signal,
    );
    signal.throwIfAborted();

    const orgIds = new Set(result.orgIds);
    if (result.drainOrgId) {
      orgIds.add(result.drainOrgId);
    }
    await publishBillingChanges(db, orgIds, signal);
    if (result.drainOrgId) {
      await set(drainOrgQueueToCapacity$, { orgId: result.drainOrgId }, signal);
      signal.throwIfAborted();
    }
    return [...orgIds];
  },
);

export const reconcilePaidStripeInvoice$ = command(
  async (
    { get, set },
    invoice: StripeInvoice,
    signal: AbortSignal,
  ): Promise<string | null> => {
    const db = set(writeDb$);
    const getClerk = (): ClerkClient => {
      return get(clerk$);
    };
    const orgId = await handleInvoicePaid(db, getClerk, invoice, signal);
    signal.throwIfAborted();
    if (!orgId) {
      return null;
    }

    await publishBillingChanges(db, new Set([orgId]), signal);
    await set(drainOrgQueueToCapacity$, { orgId }, signal);
    signal.throwIfAborted();
    return orgId;
  },
);

export const handleStripeWebhookEvent$ = command(
  async (
    { get, set },
    event: StripeWebhookEvent,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const getClerk = (): ClerkClient => {
      return get(clerk$);
    };
    let drainOrgId: string | null = null;
    const billingChangedOrgIds = new Set<string>();
    L.debug("stripe webhook received", { type: event.type, id: event.id });

    if (!shouldHandleStripePreviewEvent(event)) {
      L.debug("ignoring Stripe preview event for a different job", {
        type: event.type,
        id: event.id,
      });
      return;
    }

    switch (event.kind) {
      case "payment_intent.succeeded": {
        const usagePackInvitation =
          await handleUsagePackInvitationPaymentIntentSucceeded(
            db,
            getClerk(),
            event.object,
            new Date(event.created * 1000),
            signal,
          );
        signal.throwIfAborted();
        if (usagePackInvitation.handled) {
          if (usagePackInvitation.orgId) {
            billingChangedOrgIds.add(usagePackInvitation.orgId);
          }
          break;
        }
        await handlePaymentIntentSucceeded(event.object);
        signal.throwIfAborted();
        break;
      }
      case "checkout.session.paid": {
        const result = await handleCheckoutCompleted(
          db,
          getClerk,
          event.object,
          new Date(event.created * 1000),
          signal,
        );
        signal.throwIfAborted();
        drainOrgId = result.drainOrgId;
        addBillingChangedOrgIds(billingChangedOrgIds, result.orgIds);
        break;
      }
      case "checkout.session.failed": {
        await handleUsagePackInvitationCheckoutFailed(db, event.object);
        signal.throwIfAborted();
        break;
      }
      case "invoice.paid": {
        const paidDrainOrgId = await handleInvoicePaid(
          db,
          getClerk,
          event.object,
          signal,
        );
        signal.throwIfAborted();
        drainOrgId = paidDrainOrgId;
        if (paidDrainOrgId) {
          billingChangedOrgIds.add(paidDrainOrgId);
        }
        break;
      }
      case "customer.subscription.created": {
        const orgIds = await handleSubscriptionCreated(
          db,
          getClerk,
          event.object,
        );
        signal.throwIfAborted();
        addBillingChangedOrgIds(billingChangedOrgIds, orgIds);
        break;
      }
      case "customer.subscription.updated": {
        const orgIds = await handleSubscriptionUpdated(
          db,
          event.object,
          event.previousAttributes,
        );
        signal.throwIfAborted();
        addBillingChangedOrgIds(billingChangedOrgIds, orgIds);
        break;
      }
      case "customer.subscription.deleted": {
        const orgIds = await handleSubscriptionDeleted(db, event.object);
        signal.throwIfAborted();
        addBillingChangedOrgIds(billingChangedOrgIds, orgIds);
        break;
      }
      case "subscription_schedule.released": {
        const orgIds = await handleSubscriptionScheduleReleased(
          db,
          event.object,
          new Date(event.created * 1000),
        );
        signal.throwIfAborted();
        addBillingChangedOrgIds(billingChangedOrgIds, orgIds);
        break;
      }
      case "subscription_schedule.ended": {
        const orgIds = await handleSubscriptionScheduleEnded(db, event.object);
        signal.throwIfAborted();
        addBillingChangedOrgIds(billingChangedOrgIds, orgIds);
        break;
      }
      default: {
        L.debug("ignoring unhandled Stripe event", { type: event.type });
      }
    }

    signal.throwIfAborted();
    await publishBillingChanges(db, billingChangedOrgIds, signal);

    if (drainOrgId) {
      await set(drainOrgQueueToCapacity$, { orgId: drainOrgId }, signal);
      signal.throwIfAborted();
    }
  },
);
