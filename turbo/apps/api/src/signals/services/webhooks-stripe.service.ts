import { publishLegacyPlanInvoice$ } from "./legacy-plan-invoice.service";
import { legacyPlanInvoiceAdmission } from "./legacy-plan-invoice";
import {
  areDuplicateInitialPurchases,
  refundDuplicateSubscriptionInvoice,
} from "./billing-duplicate-subscription.service";
import { retireMarketingMetadata } from "../../lib/marketing-metadata";
import { invoiceUsagePackCreditGrantSql } from "./usage-pack-credit-grant-sql";
import {
  orgCreditInvoiceGrantSql,
  pendingOrgCreditExpirationQuery,
  requireNoPendingOrgCreditExpiration,
} from "./org-credit-expiration";
import { grantPurchasedOrgCredits$ } from "./org-credit-grant.service";
import {
  orgTierSchema,
  type OrgTier,
} from "@okouai/api-contracts/contracts/orgs";
import { expireOrgCredits$ } from "./org-credit-expiration.service";
import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgConcurrencyEntitlements } from "@okouai/db/schema/org-concurrency-entitlement";
import { orgConcurrencySubscriptions } from "@okouai/db/schema/org-concurrency-subscription";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import {
  usagePackSubscriptions,
  usagePackAllocations,
} from "@okouai/db/schema/usage-pack-subscription";
import { command } from "ccstate";
import { and, eq, gt, inArray, isNull, notInArray, or, sql } from "drizzle-orm";

import { env } from "../../lib/env";
import { pgTextDecoder } from "../../lib/db-structured-result";
import { logger } from "../../lib/log";
import { now, nowDate } from "../../lib/time";
import { clerk$ } from "../external/clerk";
import { waitUntil } from "../context/wait-until";
import { writeDb$, type Db } from "../external/db";
import {
  getStripeClient,
  isStripeResourceMissingError,
  listAllStripeSubscriptions,
  type StripeCheckoutSession,
  type StripeInvoice,
  type StripePaymentIntent,
  type StripeProductRef,
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
import { downgradeSubscription$ } from "./billing-downgrade.service";
import {
  BILLING_DOWNGRADE_PURPOSE,
  BILLING_PURCHASE_PURPOSE,
  BILLING_RESTORE_PURPOSE,
} from "./billing-payment-method.service";
import { restoreSubscription$ } from "./billing-restore.service";
import { publishBillingChangedForOrg } from "./billing-realtime.service";
import { pickOrgQueuedChatThreads$ } from "./chat-thread-queue-drain.service";
import {
  CONCURRENCY_SUBSCRIPTION_PURPOSE,
  isConcurrencyPriceId,
} from "./org-concurrency-entitlements.service";
import { disableIneligibleWorkflowWebhookAutomationsForOrg } from "./workflow-webhook-automation-entitlement.service";
import {
  ensureOrgMetadataPlanEntitlement,
  orgPlanEntitlementValues,
  orgPlanEntitlementOrgIdForStripeSubscription,
  upsertOrgPlanEntitlement,
  writeOrgMetadataWithPlanEntitlements,
} from "./org-plan-entitlements.service";
import type { Tx } from "../../lib/db-types";
import {
  handleUsagePackCheckoutCompleted$,
  handleUsagePackInvoicePaid$,
  handleUsagePackSubscriptionCreated,
  handleUsagePackSubscriptionDeleted,
  handleUsagePackSubscriptionUpdated,
} from "./usage-pack-subscription.service";
import { failScheduledUsagePackAllocationChangesForSchedule } from "./usage-pack-allocation-change.service";
import {
  handleUsagePackInvitationCheckoutFailed$,
  handleUsagePackInvitationCheckoutPaid$,
  handleUsagePackInvitationInvoicePaid$,
  handleUsagePackInvitationPaymentIntentSucceeded$,
} from "./usage-pack-invitation-purchase.service";
import {
  handleUsagePackMigrationInvoicePaid$,
  handleUsagePackMigrationSubscriptionUpdated$,
} from "./usage-pack-subscription-migration.service";

import { concurrencySubscriptionUpdatedAt } from "./concurrency-subscription-write";
import {
  archivedSubscriptionHasSurvivingComponents,
  archivedSubscriptionHasSurvivingPlan,
  isArchivedUsageAllowanceMetadata,
  survivingStripeBillingInvoiceLines,
} from "./archived-allowance";

const L = logger("WebhookStripe");

type BillingDowngradeCheckoutTargetTier = "limited-free-1" | "pro";
const CANCELED_SUBSCRIPTION_TARGET_TIER = "limited-free-1";

type WriteTx = Tx;
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
  readonly billing_reason?: string | null;
  readonly id: string;
  readonly amount_paid: number;
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
      readonly price?: {
        readonly id: string;
        readonly product?: StripeProductRef | null;
      } | null;
      readonly pricing?: {
        readonly price_details?: {
          readonly price?:
            | string
            | {
                readonly id: string;
                readonly product?: StripeProductRef | null;
              }
            | null;
          readonly product?: StripeProductRef | null;
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
  readonly items?: SubscriptionInput["items"];
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

export interface SubscriptionInvoiceDetails {
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

function subscriptionPeriodEnd(subscription: SubscriptionInput): Date | null {
  const periodEndUnix = knownBillingPlanPriceItem(
    subscription.items.data,
  )?.current_period_end;
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
  readonly hasSchedule: boolean;
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
    hasSchedule:
      subscription.schedule !== null && subscription.schedule !== undefined,
    cancelAtPeriodEnd:
      subscription.cancel_at_period_end &&
      knownBillingPlanPriceItem(subscription.items.data) === undefined,
  };
}

async function retrieveConcurrencySubscriptionState(
  subscriptionId: string,
): Promise<ConcurrencySubscriptionState | null> {
  const result = await settle(
    getStripeClient().subscriptions.retrieve(subscriptionId),
  );
  if (!result.ok) {
    if (isStripeResourceMissingError(result.error)) {
      return null;
    }
    throw result.error;
  }
  return concurrencySubscriptionState(result.value);
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
    case "limited-free-1": {
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

function isArchivedUsageAllowanceInvoice(invoice: InvoiceInput): boolean {
  return (
    isArchivedUsageAllowanceMetadata(invoice.metadata) ||
    isArchivedUsageAllowanceMetadata(
      invoice.parent?.subscription_details?.metadata,
    )
  );
}

async function invoiceWithoutArchivedAllowanceLines(
  invoice: InvoiceInput,
  signal: AbortSignal,
): Promise<InvoiceInput | null> {
  const archivalHeader = isArchivedUsageAllowanceInvoice(invoice);
  const lines = await survivingStripeBillingInvoiceLines(
    invoice.lines.data,
    [invoice.metadata, invoice.parent?.subscription_details?.metadata],
    getStripeClient(),
    signal,
  );
  // Do not allow invoice-level grant metadata to resurrect an excluded line.
  if ((archivalHeader || invoice.lines.data.length > 0) && lines.length === 0) {
    return null;
  }
  return {
    ...invoice,
    metadata: survivingInvoiceGrantMetadata(invoice, lines),
    lines: { ...invoice.lines, data: lines },
  };
}

function survivingInvoiceGrantMetadata(
  invoice: InvoiceInput,
  lines: readonly InvoiceLineInput[],
): Record<string, string> | null {
  if (
    !isArchivedUsageAllowanceInvoice(invoice) &&
    lines.length === invoice.lines.data.length
  ) {
    return invoice.metadata;
  }
  const metadata = { ...invoice.metadata };
  // Header-only credit amounts/subtotals are not attributable to the surviving components.
  if (
    metadata.type === "auto_recharge" ||
    metadata.type === "credit_purchase"
  ) {
    delete metadata.type;
  }
  if (metadata.purpose === "credit_purchase") {
    delete metadata.purpose;
  }
  if (
    !lines.some((line) => {
      return invoiceLinePriceId(line) === atomGrantPriceId();
    })
  ) {
    if (metadata.type === ATOM_GRANT_PURPOSE) {
      delete metadata.type;
    }
    if (metadata.purpose === ATOM_GRANT_PURPOSE) {
      delete metadata.purpose;
    }
  }
  return metadata;
}

function isAtomGrantInvoice(invoice: InvoiceInput): boolean {
  if (isArchivedUsageAllowanceInvoice(invoice)) {
    return false;
  }

  return (
    invoice.metadata?.purpose === ATOM_GRANT_PURPOSE ||
    invoice.metadata?.type === ATOM_GRANT_PURPOSE ||
    (invoiceAtomGrantLine(invoice) !== null &&
      !invoice.lines.data.some((line) => {
        const priceId = invoiceLinePriceId(line);
        return (
          priceId !== null && tierForKnownPlanPrice({ id: priceId }) !== null
        );
      }))
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

function shouldHandleStripeBillingEvent(event: StripeWebhookEvent): boolean {
  const metadataCandidates = stripePreviewMetadataForEvent(event);
  if (metadataCandidates === null) {
    return true;
  }
  // Archival identity is isolated by billing component, not by whole event.
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

function atomPlanInvoiceWalletColumns() {
  return {
    orgId: orgMetadata.orgId,
    lastProcessedInvoiceId: orgMetadata.lastProcessedInvoiceId,
    stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
    subscriptionStatus: orgMetadata.subscriptionStatus,
    tier: orgMetadata.tier,
    planEntitlementSource: orgPlanEntitlements.source,
    planEntitlementPeriodEnd: orgPlanEntitlements.currentPeriodEnd,
    planEntitlementSourceMetadata: orgPlanEntitlements.sourceMetadata,
  };
}

const handleAutoRechargeInvoicePaid$ = command(
  async (
    { set },
    invoice: Pick<InvoiceInput, "id" | "metadata">,
    signal: AbortSignal,
  ): Promise<PaidWebhookOutcome> => {
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

    await set(
      grantPurchasedOrgCredits$,
      {
        orgId,
        source: "auto_recharge",
        stripeInvoiceId: invoice.id,
        amount: creditsAmount,
        expiresAt: autoRechargeNeverExpiresAt(),
        clearAutoRechargePending: true,
      },
      signal,
    );
    return { handled: true, drainOrgId: orgId };
  },
);

const handleCreditPurchaseInvoicePaid$ = command(
  async (
    { set },
    invoice: Pick<InvoiceInput, "id" | "metadata" | "subtotal">,
    signal: AbortSignal,
  ): Promise<PaidWebhookOutcome> => {
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
      L.warn(
        "credit_purchase invoice has invalid credits expiration metadata",
        {
          invoiceId: invoice.id,
          orgId,
          creditsExpiresAt:
            metadata[CREDIT_PURCHASE_EXPIRES_AT_METADATA_KEY] ?? null,
        },
      );
      return { handled: true, drainOrgId: null };
    }

    await set(
      grantPurchasedOrgCredits$,
      {
        orgId,
        source: "credit_purchase",
        stripeInvoiceId: invoice.id,
        amount: creditsAmount,
        expiresAt,
      },
      signal,
    );

    return { handled: true, drainOrgId: orgId };
  },
);

const grantAtomMemberCredits$ = command(
  async (
    { set },
    args: {
      readonly invoiceId: string;
      readonly details: AtomUsagePackCreditGrantInvoiceDetails;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const { invoiceId, details } = args;
    const grant = invoiceUsagePackCreditGrantSql({
      orgId: details.orgId,
      userId: details.userId,
      grantType: "bonus",
      idempotencyKey: `atom-usage-pack:${invoiceId}:${details.userId}`,
      amount: details.credits,
      expiresAt: details.creditsExpiresAt,
    });
    await db.transaction(async (tx) => {
      const [wallet] = await tx
        .select({ customerId: orgMetadata.stripeCustomerId })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, details.orgId))
        .for("update");
      const [activePlan] = await tx
        .select({ orgId: orgPlanEntitlements.orgId })
        .from(orgPlanEntitlements)
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
        .for("update");
      if (!activePlan || wallet?.customerId !== details.customerId) {
        throw new Error(
          `Atom usage pack grant ${invoiceId} requires an active Pro or Team plan`,
        );
      }
      if ((await tx.execute(grant)).rowCount !== 1) {
        throw new Error("Atom member grant invoice identity changed");
      }
      signal.throwIfAborted();
    });
    signal.throwIfAborted();
  },
);

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

function atomPlanInvoiceDisposition(args: {
  readonly invoice: InvoiceInput;
  readonly details: AtomPlanGrantInvoiceDetails;
  readonly lockedOrg: LockedInvoicePaidOrg;
}) {
  if (args.lockedOrg.lastProcessedInvoiceId === args.invoice.id) {
    // Paid receipt identity alone does not authorize cleanup after another
    // purchase has replaced the Plan binding but has not delivered its invoice.
    return args.lockedOrg.tier === args.details.tier &&
      args.lockedOrg.subscriptionStatus === ATOM_GRANT_SUBSCRIPTION_STATUS &&
      args.lockedOrg.stripeSubscriptionId === null
      ? "duplicate"
      : "superseded";
  }
  if (atomUsagePackGrantWouldNotExtendEntitlement(args)) {
    return "member_only";
  }
  if (
    atomGrantWouldReplaceWithSameOrLowerTier({
      lockedOrg: args.lockedOrg,
      targetTier: args.details.tier,
    })
  ) {
    return "rejected";
  }
  return "publish";
}

function atomPlanInvoiceMetadata(
  invoice: InvoiceInput,
  details: AtomPlanGrantInvoiceDetails,
) {
  return {
    tier: details.tier,
    ...(details.customerId ? { stripeCustomerId: details.customerId } : {}),
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
  };
}

function atomGrantPlanEntitlementValues(
  invoice: InvoiceInput,
  details: AtomPlanGrantInvoiceDetails,
) {
  const grantLine = invoiceAtomGrantLine(invoice);
  const periodStart = grantLine?.period.start;
  const sourceMetadata = retireMarketingMetadata({
    ...invoice.metadata,
    atomPlanInvoiceId: invoice.id,
  });
  return {
    ...orgPlanEntitlementValues(
      {
        orgId: details.orgId,
        tier: details.tier,
        source: "stripe_atom_grant",
        currentPeriodStart:
          typeof periodStart === "number" ? new Date(periodStart * 1000) : null,
        currentPeriodEnd: details.grantExpiresAt,
        expiresAt: details.grantExpiresAt,
        stripePriceId: grantLine ? invoiceLinePriceId(grantLine) : null,
        showUsagePack: invoice.metadata?.planVersion === "usagePack",
        sourceMetadata,
      },
      { stripeSubscriptionId: null, sourceMetadata },
    ),
    stripeProductId: null,
    metadataHash: null,
  };
}

function atomPlanOrgCreditGrantSql(
  invoiceId: string,
  details: AtomPlanGrantInvoiceDetails,
) {
  return orgCreditInvoiceGrantSql(
    details.orgId,
    {
      source: "subscription_renewal",
      stripeInvoiceId: invoiceId,
      amount: details.credits,
      expiresAt: details.creditExpiresAt,
    },
    nowDate(),
  );
}

function atomPlanMemberCreditGrantSql(
  invoiceId: string,
  orgId: string,
  member: AtomMemberUsagePackDetails,
) {
  return invoiceUsagePackCreditGrantSql({
    orgId,
    userId: member.userId,
    grantType: "bonus",
    idempotencyKey: `atom-redeem-usage-pack:${invoiceId}:${member.userId}`,
    amount: member.credits,
    expiresAt: member.expiresAt,
  });
}

const prepareAtomPlanInvoice$ = command(
  async (
    { set },
    input: {
      readonly invoice: InvoiceInput;
      readonly details: AtomPlanGrantInvoiceDetails;
    },
    signal: AbortSignal,
  ): Promise<readonly string[]> => {
    const db = set(writeDb$);
    const { invoice, details } = input;
    const [current] = await db
      .select(atomPlanInvoiceWalletColumns())
      .from(orgMetadata)
      .leftJoin(
        orgPlanEntitlements,
        eq(orgPlanEntitlements.orgId, orgMetadata.orgId),
      )
      .where(eq(orgMetadata.orgId, details.orgId));
    signal.throwIfAborted();
    const disposition = current
      ? atomPlanInvoiceDisposition({ invoice, details, lockedOrg: current })
      : "publish";
    if (
      disposition === "member_only" ||
      disposition === "rejected" ||
      disposition === "superseded"
    ) {
      return [];
    }
    if (disposition === "publish" && details.credits > 0) {
      await set(expireOrgCredits$, details.orgId, signal);
    }
    const replaced = details.customerId
      ? await replacedAtomGrantSubscriptionIdsForCustomer({
          customerId: details.customerId,
        })
      : [];
    signal.throwIfAborted();
    return replaced;
  },
);

const publishAtomPlanInvoice$ = command(
  async (
    { set },
    input: {
      readonly invoice: InvoiceInput;
      readonly details: AtomPlanGrantInvoiceDetails;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const { invoice, details } = input;
    return await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(orgMetadataCanonicalWrites)
        .values({
          orgId: details.orgId,
          ...(details.customerId
            ? { stripeCustomerId: details.customerId }
            : {}),
        })
        .onConflictDoNothing({ target: orgMetadataCanonicalWrites.orgId })
        .returning({ tier: orgMetadata.tier });
      const insertedTier = orgTierSchema.safeParse(inserted?.tier);
      if (insertedTier.success) {
        await tx
          .insert(orgPlanEntitlements)
          .values(
            orgPlanEntitlementValues(
              {
                orgId: details.orgId,
                tier: insertedTier.data,
                source: "org_metadata_migration",
              },
              { stripeSubscriptionId: null, sourceMetadata: {} },
            ),
          )
          .onConflictDoNothing({ target: orgPlanEntitlements.orgId });
      }
      const [lockedOrg] = await tx
        .select(atomPlanInvoiceWalletColumns())
        .from(orgMetadata)
        .leftJoin(
          orgPlanEntitlements,
          eq(orgPlanEntitlements.orgId, orgMetadata.orgId),
        )
        .where(eq(orgMetadata.orgId, details.orgId))
        .for("update", { of: orgMetadata });
      if (!lockedOrg) {
        return {
          processed: false,
          cancelReplaced: false,
          oldSubscriptionId: null,
        };
      }
      const disposition = atomPlanInvoiceDisposition({
        invoice,
        details,
        lockedOrg,
      });
      if (disposition === "rejected" || disposition === "superseded") {
        if (disposition === "rejected") {
          rejectAtomGrantTierReplacement({ invoice, details, lockedOrg });
        }
        return {
          processed: false,
          cancelReplaced: false,
          oldSubscriptionId: null,
        };
      }
      let writeMetadata = disposition === "publish";
      let grantMember = true;
      if (writeMetadata && details.credits > 0) {
        const [pending] = await tx
          .select()
          .from(pendingOrgCreditExpirationQuery(details.orgId, nowDate()));
        requireNoPendingOrgCreditExpiration(details.orgId, pending);
        const grantCount = (
          await tx.execute(atomPlanOrgCreditGrantSql(invoice.id, details))
        ).rowCount;
        if (grantCount !== 1) {
          writeMetadata = false;
          grantMember = false;
        }
      }
      if (writeMetadata) {
        await tx
          .update(orgMetadata)
          .set(atomPlanInvoiceMetadata(invoice, details))
          .where(eq(orgMetadata.orgId, details.orgId));
      }
      if (
        disposition !== "member_only" &&
        (writeMetadata ||
          (lockedOrg.tier === details.tier &&
            lockedOrg.subscriptionStatus === ATOM_GRANT_SUBSCRIPTION_STATUS &&
            lockedOrg.stripeSubscriptionId === null))
      ) {
        const values = atomGrantPlanEntitlementValues(invoice, details);
        await tx.insert(orgPlanEntitlements).values(values).onConflictDoUpdate({
          target: orgPlanEntitlements.orgId,
          set: values,
        });
      }
      if (grantMember && details.memberUsagePack) {
        const member = details.memberUsagePack;
        const grantCount = (
          await tx.execute(
            atomPlanMemberCreditGrantSql(invoice.id, details.orgId, member),
          )
        ).rowCount;
        if (grantCount !== 1) {
          throw new Error("Atom bundled member grant invoice identity changed");
        }
      }
      signal.throwIfAborted();
      return {
        processed: true,
        cancelReplaced: disposition !== "member_only",
        oldSubscriptionId: lockedOrg.stripeSubscriptionId,
      };
    });
  },
);

const handleAtomGrantInvoicePaid$ = command(
  async (
    { set },
    invoice: InvoiceInput,
    signal: AbortSignal,
  ): Promise<PaidWebhookOutcome> => {
    if (!isAtomGrantInvoice(invoice)) {
      return { handled: false, drainOrgId: null };
    }

    const details = atomGrantInvoiceDetails(invoice);
    if (!details) {
      return { handled: true, drainOrgId: null };
    }

    if (details.kind === "credits") {
      await set(
        grantPurchasedOrgCredits$,
        {
          orgId: details.orgId,
          source: "credit_purchase",
          stripeInvoiceId: invoice.id,
          amount: details.credits,
          expiresAt: details.creditExpiresAt,
        },
        signal,
      );
      L.debug("atom credit grant invoice processed", {
        invoiceId: invoice.id,
        orgId: details.orgId,
        credits: details.credits,
        creditExpiresAt: details.creditExpiresAt.toISOString(),
      });
      return { handled: true, drainOrgId: details.orgId };
    }

    if (details.kind === "usagePackCredits") {
      await set(
        grantAtomMemberCredits$,
        { invoiceId: invoice.id, details },
        signal,
      );
      signal.throwIfAborted();
      L.debug("atom member usage pack credit grant invoice processed", {
        invoiceId: invoice.id,
        orgId: details.orgId,
        userId: details.userId,
        credits: details.credits,
        creditsExpiresAt: details.creditsExpiresAt.toISOString(),
      });
      return { handled: true, drainOrgId: details.orgId };
    }

    const replacedSubscriptionIds = await set(
      prepareAtomPlanInvoice$,
      { invoice, details },
      signal,
    );
    const result = await set(
      publishAtomPlanInvoice$,
      { invoice, details },
      signal,
    );
    if (!result.processed) {
      return { handled: true, drainOrgId: null };
    }
    if (result.cancelReplaced) {
      await cancelReplacedSubscriptionsAfterAtomGrant({
        orgId: details.orgId,
        invoiceId: invoice.id,
        subscriptionIds: [
          ...replacedSubscriptionIds,
          ...(result.oldSubscriptionId ? [result.oldSubscriptionId] : []),
        ],
      });
      signal.throwIfAborted();
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
  },
);

const handleOneTimePurchaseCompleted$ = command(
  async (
    { set },
    session: CheckoutSessionInput,
    paidAt: Date,
    signal: AbortSignal,
  ): Promise<string | null> => {
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

    await set(
      grantPurchasedOrgCredits$,
      {
        orgId,
        source: campaign.source,
        stripeInvoiceId: session.id,
        amount: campaign.credits,
        expiresAt,
      },
      signal,
    );

    return orgId;
  },
);

const handleCreditPurchaseCompleted$ = command(
  async (
    { set },
    session: CheckoutSessionInput,
    signal: AbortSignal,
  ): Promise<string | null> => {
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
      L.warn(
        "credit_purchase checkout has invalid credits expiration metadata",
        {
          sessionId: session.id,
          orgId,
          creditsExpiresAt:
            metadata[CREDIT_PURCHASE_EXPIRES_AT_METADATA_KEY] ?? null,
        },
      );
      return null;
    }

    await set(
      grantPurchasedOrgCredits$,
      {
        orgId,
        source: "credit_purchase",
        stripeInvoiceId: session.id,
        amount: creditsAmount,
        expiresAt,
      },
      signal,
    );

    return orgId;
  },
);

const handlePaidCheckoutPurpose$ = command(
  async (
    { set },
    session: CheckoutSessionInput,
    purpose: "one_time_purchase",
    paidAt: Date,
    signal: AbortSignal,
  ): Promise<PaidWebhookOutcome> => {
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

    const drainOrgId = await set(
      handleOneTimePurchaseCompleted$,
      session,
      paidAt,
      signal,
    );
    return { handled: true, drainOrgId };
  },
);

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
  if (value === "pro") {
    return value;
  }
  if (value === "limited-free-1") {
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

const billingSetupSubscriptionState$ = command(
  async (
    { set },
    args: {
      readonly metadata: {
        readonly orgId: string;
        readonly subscriptionId: string;
      };
      readonly subscriptionScope: "plan" | "purchase";
    },
    signal: AbortSignal,
  ) => {
    const { metadata, subscriptionScope } = args;
    const db = set(writeDb$);
    const [org] = await db
      .select({
        stripeCustomerId: orgMetadata.stripeCustomerId,
        stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
      })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, metadata.orgId))
      .limit(1);
    signal.throwIfAborted();
    let subscriptionMatches =
      org?.stripeSubscriptionId === metadata.subscriptionId;
    let expectedCustomerId = org?.stripeCustomerId ?? null;
    if (subscriptionScope === "purchase") {
      const [usagePackRows, concurrencyRows] = await Promise.all([
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
      signal.throwIfAborted();
      subscriptionMatches ||=
        usagePackRows.length > 0 || concurrencyRows.length > 0;
      expectedCustomerId ??= usagePackRows[0]?.stripeCustomerId ?? null;
    }
    return { org, subscriptionMatches, expectedCustomerId };
  },
);

const applyBillingSetupPaymentMethod$ = command(
  async (
    { set },
    args: {
      readonly session: CheckoutSessionInput;
      readonly metadata: {
        readonly orgId: string;
        readonly subscriptionId: string;
      };
      readonly purpose: "restore" | "downgrade" | "purchase";
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const { session, metadata, purpose } = args;
    if (session.mode !== "setup") {
      L.warn(`billing ${purpose} checkout completed with unexpected mode`, {
        sessionId: session.id,
        mode: session.mode ?? null,
      });
      return false;
    }
    const customerId = checkoutCustomerId(session);
    if (!customerId) {
      L.warn(`billing ${purpose} checkout completed without customer`, {
        sessionId: session.id,
        orgId: metadata.orgId,
      });
      return false;
    }

    const { org, subscriptionMatches, expectedCustomerId } = await set(
      billingSetupSubscriptionState$,
      {
        metadata,
        subscriptionScope: purpose === "purchase" ? "purchase" : "plan",
      },
      signal,
    );
    if (
      !org ||
      !subscriptionMatches ||
      (expectedCustomerId !== null && expectedCustomerId !== customerId)
    ) {
      L.warn(
        `billing ${purpose} checkout no longer matches org billing state`,
        {
          sessionId: session.id,
          orgId: metadata.orgId,
          customerId,
          metadataSubscriptionId: metadata.subscriptionId,
          orgStripeCustomerId: org?.stripeCustomerId ?? null,
          orgStripeSubscriptionId: org?.stripeSubscriptionId ?? null,
          subscriptionScope: purpose === "purchase" ? "purchase" : "plan",
        },
      );
      return false;
    }
    const stripe = getStripeClient();
    const paymentMethodId = await checkoutSetupPaymentMethodId(stripe, session);
    signal.throwIfAborted();
    if (!paymentMethodId) {
      L.warn(`billing ${purpose} checkout has no setup payment method`, {
        sessionId: session.id,
        orgId: metadata.orgId,
      });
      return false;
    }
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });
    signal.throwIfAborted();
    return true;
  },
);

const handleBillingSetupCheckoutCompleted$ = command(
  async (
    { set },
    session: CheckoutSessionInput,
    signal: AbortSignal,
  ): Promise<CheckoutCompletedOutcome | null> => {
    const restore = billingRestoreCheckoutMetadata(session);
    const downgrade = billingDowngradeCheckoutMetadata(session);
    const purchase = billingPurchaseCheckoutMetadata(session);
    const metadata = restore ?? downgrade ?? purchase;
    if (!metadata) {
      return null;
    }
    const purpose = restore ? "restore" : downgrade ? "downgrade" : "purchase";
    const ignored = { drainOrgId: null, orgIds: [] };
    const paymentMethodSet = await set(
      applyBillingSetupPaymentMethod$,
      {
        session,
        metadata,
        purpose,
      },
      signal,
    );
    if (!paymentMethodSet) {
      return ignored;
    }
    if (restore) {
      const result = await set(
        restoreSubscription$,
        {
          orgId: restore.orgId,
          requirePaymentMethod: false,
        },
        signal,
      );
      if (!result.ok) {
        L.warn("billing restore checkout could not restore subscription", {
          sessionId: session.id,
          orgId: restore.orgId,
          reason: result.reason,
        });
        return ignored;
      }
    } else if (downgrade) {
      const result = await set(
        downgradeSubscription$,
        {
          orgId: downgrade.orgId,
          targetTier: downgrade.targetTier,
          requirePaymentMethod: false,
        },
        signal,
      );
      if (!result.ok) {
        L.warn("billing downgrade checkout could not downgrade subscription", {
          sessionId: session.id,
          orgId: downgrade.orgId,
          reason: result.reason,
        });
        return ignored;
      }
    }
    signal.throwIfAborted();
    return { drainOrgId: null, orgIds: [metadata.orgId] };
  },
);

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

async function prepareConcurrencyInvoiceEntitlements(
  db: Db,
  getClerk: ClerkClientProvider,
  invoice: InvoiceInput,
): Promise<
  | PaidWebhookOutcome
  | {
      readonly orgId: string;
      readonly subscriptionId: string;
      readonly values: readonly ConcurrencyInvoiceEntitlementValue[];
    }
> {
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

  return { orgId: org.orgId, subscriptionId, values };
}

interface PreparedConcurrencyInvoice {
  readonly invoiceId: string;
  readonly orgId: string;
  readonly subscriptionId: string;
  readonly values: readonly ConcurrencyInvoiceEntitlementValue[];
}

class ConcurrencyProjectionChangedError extends Error {
  constructor() {
    super("Concurrency subscription changed during invoice reconciliation");
  }
}

function retiredConcurrencyState(
  known: { readonly stripePriceId: string; readonly slots: number } | undefined,
): ConcurrencySubscriptionState | null {
  if (!known) {
    return null;
  }
  return {
    stripePriceId: known.stripePriceId,
    slots: known.slots,
    subscriptionStatus: "canceled",
    currentPeriodEnd: nowDate(),
    cancelAtPeriodEnd: false,
    hasSchedule: false,
  };
}

const publishConcurrencyInvoice$ = command(
  async (
    { set },
    prepared: PreparedConcurrencyInvoice,
  ): Promise<PaidWebhookOutcome> => {
    const { orgId, subscriptionId, values } = prepared;
    const db = set(writeDb$);
    const [existing] = await db
      .select({
        subscriptionId: orgConcurrencySubscriptions.stripeSubscriptionId,
        stripePriceId: orgConcurrencySubscriptions.stripePriceId,
        slots: orgConcurrencySubscriptions.slots,
        rowVersion: sql`${orgConcurrencySubscriptions}.xmin::text`.mapWith(
          pgTextDecoder,
        ),
        updatedAtText:
          sql`${orgConcurrencySubscriptions.updatedAt}::text`.mapWith(
            pgTextDecoder,
          ),
      })
      .from(orgConcurrencySubscriptions)
      .where(
        eq(orgConcurrencySubscriptions.stripeSubscriptionId, subscriptionId),
      )
      .limit(1);
    if (!existing && values.length === 0) {
      return { handled: true, drainOrgId: orgId };
    }
    const originalVersion = and(
      eq(orgConcurrencySubscriptions.stripeSubscriptionId, subscriptionId),
      existing
        ? and(
            eq(
              orgConcurrencySubscriptions.updatedAt,
              sql`${existing.updatedAtText}::timestamp`,
            ),
            sql`${orgConcurrencySubscriptions}.xmin::text = ${existing.rowVersion}`,
          )
        : undefined,
    );
    // Snapshot and Stripe I/O complete before entering the bounded SQL commit.
    const state = await retrieveConcurrencySubscriptionState(subscriptionId);
    const projectionState =
      state ?? retiredConcurrencyState(existing ?? values.at(-1));
    if (!projectionState) {
      return { handled: true, drainOrgId: orgId };
    }
    await db.transaction(async (tx) => {
      // Payment evidence remains valid even after the renewable subscription or
      // concurrency item disappears. Record its immutable invoice identity without
      // reviving a current projection from that historical payment.
      const insertedRows =
        values.length === 0
          ? []
          : await tx
              .insert(orgConcurrencyEntitlements)
              .values([...values])
              .onConflictDoNothing()
              .returning({ id: orgConcurrencyEntitlements.id });
      const projection = {
        orgId: orgId,
        stripePriceId: projectionState.stripePriceId,
        slots: projectionState.slots,
        subscriptionStatus: projectionState.subscriptionStatus,
        currentPeriodEnd: projectionState.currentPeriodEnd,
        cancelAtPeriodEnd: projectionState.cancelAtPeriodEnd,
        ...(!state ? { scheduledSlots: null, scheduledChangeAt: null } : {}),
      };
      const written = existing
        ? await tx
            .update(orgConcurrencySubscriptions)
            .set({
              ...projection,
              updatedAt: concurrencySubscriptionUpdatedAt(nowDate()),
            })
            .where(originalVersion)
            .returning({ id: orgConcurrencySubscriptions.stripeSubscriptionId })
        : await tx
            .insert(orgConcurrencySubscriptions)
            .values({
              ...projection,
              stripeSubscriptionId: subscriptionId,
              updatedAt: nowDate(),
            })
            .onConflictDoNothing({
              target: orgConcurrencySubscriptions.stripeSubscriptionId,
            })
            .returning({
              id: orgConcurrencySubscriptions.stripeSubscriptionId,
            });
      if (written.length === 0) {
        // Roll back the related invoice inserts and let Stripe retry the entire
        // delivery against current state. A stale result is never a success.
        throw new ConcurrencyProjectionChangedError();
      }
      return { insertedLines: insertedRows.length, state: projectionState };
    });

    return { handled: true, drainOrgId: orgId };
  },
);

const reconcileConcurrencyInvoice$ = command(
  async (
    { set },
    prepared: PreparedConcurrencyInvoice,
  ): Promise<PaidWebhookOutcome> => {
    // One conditional publication. A contending delivery that changed the
    // projection makes this one fail as a whole; Stripe redelivers it against
    // the committed state. No in-process re-run.
    return await set(publishConcurrencyInvoice$, prepared);
  },
);

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

/**
 * A Plan invoice whose organization entitlement is held by another live
 * subscription bought concurrently as an initial purchase is a duplicate: it
 * is refunded instead of granted, whatever its tier. Read before publication
 * so neither a rejection nor a tier upgrade grants it.
 */
async function planInvoiceIsDuplicateInitialPurchase(
  db: Db,
  publication: Parameters<typeof legacyPlanInvoiceAdmission>[1],
): Promise<boolean> {
  const [wallet] = await db
    .select()
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, publication.orgId));
  return (
    !!wallet?.stripeSubscriptionId &&
    wallet.stripeSubscriptionId !== publication.subscriptionId &&
    wallet.lastProcessedInvoiceId !== publication.invoiceId &&
    (wallet.subscriptionStatus === "active" ||
      wallet.subscriptionStatus === "trialing" ||
      wallet.subscriptionStatus === "past_due") &&
    (wallet.currentPeriodEnd === null || wallet.currentPeriodEnd > nowDate()) &&
    (await areDuplicateInitialPurchases(
      publication.subscriptionId,
      wallet.stripeSubscriptionId,
    ))
  );
}

/** Refund and cancel a duplicate initial Plan purchase instead of granting it. */
async function refundDuplicateInitialPlanPurchase(
  db: Db,
  invoice: InvoiceInput,
  publication: Parameters<typeof legacyPlanInvoiceAdmission>[1],
): Promise<boolean> {
  // Only a subscription's first invoice can be a duplicate initial purchase.
  if (
    invoice.billing_reason !== "subscription_create" ||
    !(await planInvoiceIsDuplicateInitialPurchase(db, publication))
  ) {
    return false;
  }
  await refundDuplicateSubscriptionInvoice(invoice, publication.subscriptionId);
  return true;
}

async function bindSubscriptionToCustomerOrg(
  db: Db,
  args: BindSubscriptionToCustomerOrgArgs,
): Promise<readonly string[]> {
  if (!archivedSubscriptionHasSurvivingPlan(args.subscription)) {
    return [];
  }
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

function tierFromSubscription(subscription: StripeSubscription) {
  if (!archivedSubscriptionHasSurvivingPlan(subscription)) {
    return null;
  }
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
  readonly invoiceId: string;
  readonly subscriptionIds: readonly string[];
}): Promise<void> {
  if (args.subscriptionIds.length === 0) {
    return;
  }

  const stripe = getStripeClient();
  for (const oldSubscriptionId of new Set(args.subscriptionIds)) {
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
  if (!archivedSubscriptionHasSurvivingPlan(subscription)) {
    return null;
  }
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

const handleCheckoutCompleted$ = command(
  async (
    { set },
    session: CheckoutSessionInput,
    paidAt: Date,
    signal: AbortSignal,
  ): Promise<CheckoutCompletedOutcome> => {
    if (isArchivedUsageAllowanceMetadata(session.metadata)) {
      return { drainOrgId: null, orgIds: [] };
    }
    const db = set(writeDb$);

    const usagePackInvitation = await set(
      handleUsagePackInvitationCheckoutPaid$,
      session,
      paidAt,
      signal,
    );
    signal.throwIfAborted();
    if (usagePackInvitation.handled) {
      return {
        drainOrgId: null,
        orgIds: usagePackInvitation.orgId ? [usagePackInvitation.orgId] : [],
      };
    }

    if (session.metadata?.purpose === "credit_purchase") {
      const invoiceId = checkoutSessionInvoiceId(session);
      if (!invoiceId) {
        const drainOrgId = await set(
          handleCreditPurchaseCompleted$,
          session,
          signal,
        );
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

    const oneTimePurchaseResult = await set(
      handlePaidCheckoutPurpose$,
      session,
      "one_time_purchase",
      paidAt,
      signal,
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
    signal.throwIfAborted();
    if (isArchivedUsageAllowanceMetadata(subscription.metadata)) {
      return { drainOrgId: null, orgIds: [] };
    }
    const usagePackOutcome = await set(
      handleUsagePackCheckoutCompleted$,
      session,
      subscription,
      signal,
    );
    signal.throwIfAborted();
    const orgIds = await bindSubscriptionToCustomerOrg(db, {
      customerId,
      subscription: usagePackOutcome.subscription ?? subscription,
      source: "checkout.session.completed",
    });
    signal.throwIfAborted();
    return {
      drainOrgId: null,
      orgIds: [
        ...new Set([
          ...orgIds,
          ...(usagePackOutcome.orgId ? [usagePackOutcome.orgId] : []),
        ]),
      ],
    };
  },
);

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
  if (isArchivedUsageAllowanceMetadata(subscription.metadata)) {
    return [];
  }
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

const handlePlanSubscriptionInvoicePaid$ = command(
  async (
    { get, set },
    args: {
      readonly invoice: InvoiceInput;
      readonly concurrencyResult: PaidWebhookOutcome;
      readonly fallbackDrainOrgId: string | null;
    },
    signal: AbortSignal,
  ): Promise<string | null> => {
    const db = set(writeDb$);
    const getClerk = (): ClerkClient => {
      return get(clerk$);
    };
    const { invoice, concurrencyResult, fallbackDrainOrgId } = args;
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
    signal.throwIfAborted();
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
    signal.throwIfAborted();
    if (!details) {
      return concurrencyResult.drainOrgId ?? fallbackDrainOrgId;
    }

    const publication = {
      invoiceId: invoice.id,
      customerId,
      subscriptionId,
      orgId: org.orgId,
      details,
    };
    if (await refundDuplicateInitialPlanPurchase(db, invoice, publication)) {
      signal.throwIfAborted();
      return org.orgId;
    }
    const replacedSubscriptionIds =
      legacyPlanInvoiceAdmission(org, publication) === "rejected"
        ? []
        : await replacedPlanSubscriptionIdsForCustomer({
            customerId,
            newSubscriptionId: subscriptionId,
            targetTier: details.tier,
          });
    signal.throwIfAborted();
    const result = await set(publishLegacyPlanInvoice$, publication, signal);
    signal.throwIfAborted();
    if (!result.processed) {
      // A concurrent first purchase can publish between the check above and
      // this publication; the rejected loser is then refunded here instead.
      const refunded = await refundDuplicateInitialPlanPurchase(
        db,
        invoice,
        publication,
      );
      signal.throwIfAborted();
      return refunded
        ? org.orgId
        : (concurrencyResult.drainOrgId ?? fallbackDrainOrgId);
    }
    if (result.cancelReplaced) {
      await cancelReplacedPlanSubscriptions({
        orgId: org.orgId,
        invoiceId: invoice.id,
        newSubscriptionId: subscriptionId,
        oldSubscriptionIds: [
          ...replacedSubscriptionIds,
          ...(result.replacedSubscriptionId
            ? [result.replacedSubscriptionId]
            : []),
        ],
      });
      signal.throwIfAborted();
    }
    return org.orgId;
  },
);

const handleConcurrencyInvoicePaid$ = command(
  async (
    { get, set },
    invoice: InvoiceInput,
    signal: AbortSignal,
  ): Promise<PaidWebhookOutcome> => {
    const prepared = await prepareConcurrencyInvoiceEntitlements(
      set(writeDb$),
      () => {
        return get(clerk$);
      },
      invoice,
    );
    signal.throwIfAborted();
    return "handled" in prepared
      ? prepared
      : await set(reconcileConcurrencyInvoice$, {
          ...prepared,
          invoiceId: invoice.id,
        });
  },
);

const handleInvoicePaid$ = command(
  async (
    { set },
    invoice: InvoiceInput,
    signal: AbortSignal,
  ): Promise<string | null> => {
    const liveInvoice = await invoiceWithoutArchivedAllowanceLines(
      invoice,
      signal,
    );
    signal.throwIfAborted();
    if (!liveInvoice) {
      return null;
    }
    invoice = liveInvoice;
    // Definitive archive roots own only the proven independent concurrency path.
    // Correlation handlers can re-fetch an unfiltered invoice, so never enter them.
    if (isArchivedUsageAllowanceInvoice(invoice)) {
      return (await set(handleConcurrencyInvoicePaid$, invoice, signal))
        .drainOrgId;
    }
    const migrationResult = await set(
      handleUsagePackMigrationInvoicePaid$,
      invoice,
      signal,
    );
    signal.throwIfAborted();
    if (migrationResult.handled) {
      return migrationResult.orgId;
    }

    const invitationResult = await set(
      handleUsagePackInvitationInvoicePaid$,
      invoice,
      signal,
    );
    signal.throwIfAborted();
    if (invitationResult.handled) {
      return invitationResult.orgId;
    }

    const usagePackResult = await set(
      handleUsagePackInvoicePaid$,
      invoice,
      signal,
    );
    signal.throwIfAborted();
    const invoiceLines = invoice.lines?.data ?? [];
    const hasCustomPlanInvoiceLine = invoiceLines.some((line) => {
      const priceId = invoiceLinePriceId(line);
      return priceId
        ? tierForKnownPlanPrice({ id: priceId }) === "custom"
        : false;
    });
    if (usagePackResult.handled && !hasCustomPlanInvoiceLine) {
      const concurrencyResult = await set(
        handleConcurrencyInvoicePaid$,
        invoice,
        signal,
      );
      return concurrencyResult.drainOrgId ?? usagePackResult.orgId;
    }
    if (!usagePackResult.handled) {
      const autoRechargeResult = await set(
        handleAutoRechargeInvoicePaid$,
        invoice,
        signal,
      );
      signal.throwIfAborted();
      if (autoRechargeResult.handled) {
        return autoRechargeResult.drainOrgId;
      }

      const creditPurchaseResult = await set(
        handleCreditPurchaseInvoicePaid$,
        invoice,
        signal,
      );
      signal.throwIfAborted();
      if (creditPurchaseResult.handled) {
        return creditPurchaseResult.drainOrgId;
      }
    }

    const atomGrantResult = await set(
      handleAtomGrantInvoicePaid$,
      invoice,
      signal,
    );
    signal.throwIfAborted();
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
    const componentDrainOrgId = usagePackResult.orgId;
    const planDrainOrgId = shouldHandlePlanInvoice
      ? await set(
          handlePlanSubscriptionInvoicePaid$,
          {
            invoice,
            concurrencyResult: { handled: false, drainOrgId: null },
            fallbackDrainOrgId: componentDrainOrgId,
          },
          signal,
        )
      : componentDrainOrgId;
    const concurrencyResult = await set(
      handleConcurrencyInvoicePaid$,
      invoice,
      signal,
    );
    return concurrencyResult.drainOrgId ?? planDrainOrgId;
  },
);

const publishConcurrencySubscription$ = command(
  async (
    { set },
    subscription: SubscriptionInput,
  ): Promise<readonly string[]> => {
    const db = set(writeDb$);
    const [existing] = await db
      .select({
        orgId: orgConcurrencySubscriptions.orgId,
        rowVersion: sql`${orgConcurrencySubscriptions}.xmin::text`.mapWith(
          pgTextDecoder,
        ),
        cancelAtPeriodEnd: orgConcurrencySubscriptions.cancelAtPeriodEnd,
        scheduledSlots: orgConcurrencySubscriptions.scheduledSlots,
        updatedAtText:
          sql`${orgConcurrencySubscriptions.updatedAt}::text`.mapWith(
            pgTextDecoder,
          ),
      })
      .from(orgConcurrencySubscriptions)
      .where(
        eq(orgConcurrencySubscriptions.stripeSubscriptionId, subscription.id),
      )
      .limit(1);
    if (!existing) {
      return [];
    }

    // An equal quantity does not make an event current: cancellation, status,
    // renewal and schedule can change independently. Read Stripe for every
    // projection and publish only against the database snapshot it started from.
    const state = await retrieveConcurrencySubscriptionState(subscription.id);
    return await db.transaction(async (tx) => {
      if (!state) {
        const rows = await tx
          .update(orgConcurrencySubscriptions)
          .set({
            subscriptionStatus: "canceled",
            cancelAtPeriodEnd: false,
            scheduledSlots: null,
            scheduledChangeAt: null,
            currentPeriodEnd: nowDate(),
            updatedAt: concurrencySubscriptionUpdatedAt(nowDate()),
          })
          .where(
            and(
              eq(
                orgConcurrencySubscriptions.stripeSubscriptionId,
                subscription.id,
              ),
              eq(
                orgConcurrencySubscriptions.updatedAt,
                sql`${existing.updatedAtText}::timestamp`,
              ),
              sql`${orgConcurrencySubscriptions}.xmin::text = ${existing.rowVersion}`,
            ),
          )
          .returning({ orgId: orgConcurrencySubscriptions.orgId });
        if (rows.length === 0) {
          throw new Error(
            "Concurrency subscription changed during Stripe reconciliation",
          );
        }
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
            (existing.cancelAtPeriodEnd && state.hasSchedule),
          ...(existing.scheduledSlots === state.slots
            ? { scheduledSlots: null, scheduledChangeAt: null }
            : {}),
          updatedAt: concurrencySubscriptionUpdatedAt(nowDate()),
        })
        .where(
          and(
            eq(
              orgConcurrencySubscriptions.stripeSubscriptionId,
              subscription.id,
            ),
            eq(
              orgConcurrencySubscriptions.updatedAt,
              sql`${existing.updatedAtText}::timestamp`,
            ),
            sql`${orgConcurrencySubscriptions}.xmin::text = ${existing.rowVersion}`,
          ),
        )
        .returning({ orgId: orgConcurrencySubscriptions.orgId });

      if (rows.length === 0) {
        throw new Error(
          "Concurrency subscription changed during Stripe reconciliation",
        );
      }
      return rows.map((row) => {
        return row.orgId;
      });
    });
  },
);

interface LegacyPlanPublication {
  readonly orgId: string;
  readonly subscription: SubscriptionInput;
  readonly previousAttributes: SubscriptionPreviousAttributes | undefined;
  readonly scheduledEnd: Date | null;
}

function legacyPlanPublication(args: Omit<LegacyPlanPublication, "orgId">) {
  const { subscription, previousAttributes, scheduledEnd } = args;
  const willCancel =
    subscriptionWillCancel(subscription) || scheduledEnd !== null;
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
  return {
    planItem,
    planTier,
    trialEnd: trialShortened ? trialEnd : null,
    target:
      planTier === "custom" && metadataOrgId
        ? or(
            eq(orgMetadata.stripeSubscriptionId, subscription.id),
            and(
              eq(orgMetadata.orgId, metadataOrgId),
              eq(orgMetadata.tier, "custom"),
              isNull(orgMetadata.stripeSubscriptionId),
            ),
          )
        : eq(orgMetadata.stripeSubscriptionId, subscription.id),
    values: {
      ...(planTier
        ? { tier: planTier, stripeSubscriptionId: subscription.id }
        : {}),
      subscriptionStatus: subscription.status,
      cancelAtPeriodEnd: willCancel,
      updatedAt: nowDate(),
      ...(scheduledEnd ? { currentPeriodEnd: scheduledEnd } : {}),
      ...(scheduledEnd && pendingScheduleId
        ? {
            pendingSubscriptionScheduleId: pendingScheduleId,
            pendingSubscriptionTargetTier: CANCELED_SUBSCRIPTION_TARGET_TIER,
            pendingSubscriptionChangeAt: scheduledEnd,
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
    },
  };
}

function trialShorteningWhere(orgId: string, end: Date) {
  return and(
    eq(creditExpiresRecord.orgId, orgId),
    eq(creditExpiresRecord.source, "subscription_renewal"),
    gt(creditExpiresRecord.expiresAt, end),
    gt(creditExpiresRecord.remaining, 0),
  );
}

function legacyPlanEntitlement(
  args: LegacyPlanPublication,
  input: {
    readonly tier: BillingSubscriptionTier;
    readonly item: SubscriptionInput["items"]["data"][number];
    readonly showUsagePack: boolean;
    readonly owner: string | undefined;
  },
) {
  const duplicateOwner =
    input.owner !== undefined && input.owner !== args.orgId;
  const metadata = retireMarketingMetadata(args.subscription.metadata ?? {});
  return {
    ...orgPlanEntitlementValues(
      {
        orgId: args.orgId,
        tier: input.tier,
        source: "stripe_subscription",
        status: args.subscription.status,
        stripeSubscriptionId: args.subscription.id,
        stripePriceId: input.item.price.id,
        currentPeriodStart: input.item.current_period_start
          ? new Date(input.item.current_period_start * 1000)
          : null,
        currentPeriodEnd: input.item.current_period_end
          ? new Date(input.item.current_period_end * 1000)
          : null,
        cancelAt: args.scheduledEnd,
        expiresAt: args.scheduledEnd,
        showUsagePack: input.showUsagePack,
      },
      {
        stripeSubscriptionId: duplicateOwner ? null : args.subscription.id,
        sourceMetadata: duplicateOwner
          ? {
              ...metadata,
              stripeSubscriptionSnapshotSkipped:
                "duplicate_stripe_subscription_id",
            }
          : metadata,
      },
    ),
    stripeProductId: null,
    metadataHash: null,
  };
}

const publishLegacyPlanSubscription$ = command(
  async (
    { set },
    args: LegacyPlanPublication,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const prepared = legacyPlanPublication(args);
    const lots = prepared.trialEnd
      ? await db
          .select({ id: creditExpiresRecord.id })
          .from(creditExpiresRecord)
          .where(trialShorteningWhere(args.orgId, prepared.trialEnd))
      : [];
    signal.throwIfAborted();
    const lotIds = lots.map((row) => {
      return row.id;
    });
    const result = await db.transaction(async (tx) => {
      // No row lock: publish the plan projection as a conditional write on the
      // subscription binding first; the wallet row it writes then orders the
      // credit-lot re-check below against grant writers.
      const publication = legacyPlanPublication(args);
      const [wallet] = await tx
        .update(orgMetadata)
        .set(publication.values)
        .where(and(eq(orgMetadata.orgId, args.orgId), prepared.target))
        .returning({ orgId: orgMetadata.orgId });
      if (!wallet) {
        return false;
      }
      if (publication.trialEnd) {
        const [unprepared] = await tx
          .select({ id: creditExpiresRecord.id })
          .from(creditExpiresRecord)
          .where(
            and(
              trialShorteningWhere(args.orgId, publication.trialEnd),
              notInArray(creditExpiresRecord.id, lotIds),
            ),
          )
          .limit(1);
        if (unprepared) {
          throw new Error(
            "Subscription credit lots changed during trial shortening",
          );
        }
      }
      if (publication.planTier && publication.planItem) {
        const [memberPack] = await tx
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
                args.subscription.id,
              ),
              notInArray(usagePackSubscriptions.subscriptionStatus, [
                "canceled",
                "incomplete_expired",
                "invalid",
              ]),
              inArray(usagePackAllocations.status, [
                "pending_payment",
                "active",
                "pending_invitation",
                "paid_pending_invitation",
              ]),
            ),
          )
          .limit(1);
        const [owner] = await tx
          .select({ orgId: orgPlanEntitlements.orgId })
          .from(orgPlanEntitlements)
          .where(
            eq(orgPlanEntitlements.stripeSubscriptionId, args.subscription.id),
          )
          .limit(1);
        const entitlement = legacyPlanEntitlement(args, {
          tier: publication.planTier,
          item: publication.planItem,
          showUsagePack: memberPack !== undefined,
          owner: owner?.orgId,
        });
        await tx
          .insert(orgPlanEntitlements)
          .values(entitlement)
          .onConflictDoUpdate({
            target: orgPlanEntitlements.orgId,
            set: entitlement,
          });
      }
      if (publication.trialEnd) {
        await tx
          .update(creditExpiresRecord)
          .set({ expiresAt: publication.trialEnd })
          .where(
            and(
              trialShorteningWhere(args.orgId, publication.trialEnd),
              inArray(creditExpiresRecord.id, lotIds),
            ),
          );
      }
      signal.throwIfAborted();
      return true;
    });
    signal.throwIfAborted();
    return result;
  },
);

const handleSubscriptionUpdatedLegacy$ = command(
  async (
    { set },
    subscription: SubscriptionInput,
    previousAttributes: SubscriptionPreviousAttributes | undefined,
    signal: AbortSignal,
  ): Promise<readonly string[]> => {
    const db = set(writeDb$);
    const concurrencyOrgIds = await set(
      publishConcurrencySubscription$,
      subscription,
    );
    signal.throwIfAborted();
    if (!archivedSubscriptionHasSurvivingPlan(subscription)) {
      return concurrencyOrgIds;
    }
    const scheduledEnd = await subscriptionScheduledEnd(
      getStripeClient(),
      subscription,
    );
    signal.throwIfAborted();
    const input = { subscription, previousAttributes, scheduledEnd };
    const targets = await db
      .select({ orgId: orgMetadata.orgId })
      .from(orgMetadata)
      .where(legacyPlanPublication(input).target);
    signal.throwIfAborted();
    const planOrgIds: string[] = [];
    for (const target of targets) {
      if (
        await set(
          publishLegacyPlanSubscription$,
          { ...input, orgId: target.orgId },
          signal,
        )
      ) {
        planOrgIds.push(target.orgId);
      }
      signal.throwIfAborted();
    }
    return [...new Set([...concurrencyOrgIds, ...planOrgIds])];
  },
);

const handleSubscriptionUpdated$ = command(
  async (
    { set },
    subscription: SubscriptionInput,
    previousAttributes: SubscriptionPreviousAttributes | undefined,
    signal: AbortSignal,
  ): Promise<readonly string[]> => {
    if (!archivedSubscriptionHasSurvivingComponents(subscription)) {
      return [];
    }
    const db = set(writeDb$);
    if (isArchivedUsageAllowanceMetadata(subscription.metadata)) {
      const orgIds = await set(publishConcurrencySubscription$, subscription);
      signal.throwIfAborted();
      return orgIds;
    }
    const migrationOutcome = await set(
      handleUsagePackMigrationSubscriptionUpdated$,
      subscription,
      signal,
    );
    if (migrationOutcome.handled) {
      return migrationOutcome.orgId ? [migrationOutcome.orgId] : [];
    }
    const usagePackOutcome = await handleUsagePackSubscriptionUpdated(
      db,
      subscription,
    );
    signal.throwIfAborted();
    const orgIds = await set(
      handleSubscriptionUpdatedLegacy$,
      usagePackOutcome.subscription ?? subscription,
      previousAttributes,
      signal,
    );
    signal.throwIfAborted();
    return [
      ...new Set([
        ...orgIds,
        ...(usagePackOutcome.orgId ? [usagePackOutcome.orgId] : []),
      ]),
    ];
  },
);

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
  const concurrencyRows = await db
    .update(orgConcurrencySubscriptions)
    .set({
      subscriptionStatus: "canceled",
      cancelAtPeriodEnd: false,
      currentPeriodEnd: nowDate(),
      updatedAt: concurrencySubscriptionUpdatedAt(nowDate()),
    })
    .where(
      eq(orgConcurrencySubscriptions.stripeSubscriptionId, subscription.id),
    )
    .returning({ orgId: orgConcurrencySubscriptions.orgId });

  if (!archivedSubscriptionHasSurvivingPlan(subscription)) {
    return concurrencyRows.map((row) => {
      return row.orgId;
    });
  }
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
  // Existing concurrency bindings, not an Allowance/Plan price overlap, own archive-root deletion.
  if (isArchivedUsageAllowanceMetadata(subscription.metadata)) {
    return await handleSubscriptionDeletedLegacy(db, subscription);
  }
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
export const reconcileStripeSubscriptionSnapshot$ = command(
  async (
    { get, set },
    subscription: StripeSubscription,
    signal: AbortSignal,
  ): Promise<StripeSubscriptionSnapshotReconciliation> => {
    if (!archivedSubscriptionHasSurvivingComponents(subscription)) {
      return { orgIds: [], downgradedOrgIds: [], paidInvoiceId: null };
    }
    const db = set(writeDb$);
    const getClerk = (): ClerkClient => {
      return get(clerk$);
    };
    const terminal =
      subscription.status === "canceled" ||
      subscription.status === "ended" ||
      subscription.status === "incomplete_expired";
    if (terminal) {
      const downgradedOrgId = archivedSubscriptionHasSurvivingPlan(subscription)
        ? await paidPlanOrgIdForSubscription(db, subscription.id)
        : null;
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

    for (const orgId of await set(
      handleSubscriptionUpdated$,
      subscription,
      reconciliationPreviousAttributes(subscription),
      signal,
    )) {
      orgIds.add(orgId);
    }
    signal.throwIfAborted();

    const paidInvoice = await latestPaidInvoiceForSubscription(
      subscription,
      signal,
    );
    const invoiceOrgId = paidInvoice
      ? await set(handleInvoicePaid$, paidInvoice, signal)
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
  },
);

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
    { set },
    input: {
      readonly session: StripeCheckoutSession;
      readonly paidAt: Date;
    },
    signal: AbortSignal,
  ): Promise<readonly string[]> => {
    if (
      !isCurrentStripePreviewMetadata(input.session.metadata) ||
      isArchivedUsageAllowanceMetadata(input.session.metadata)
    ) {
      return [];
    }

    const db = set(writeDb$);
    const setupResult = await set(
      handleBillingSetupCheckoutCompleted$,
      input.session,
      signal,
    );
    const result =
      setupResult ??
      (await set(
        handleCheckoutCompleted$,
        input.session,
        input.paidAt,
        signal,
      ));
    signal.throwIfAborted();

    const orgIds = new Set(result.orgIds);
    if (result.drainOrgId) {
      orgIds.add(result.drainOrgId);
    }
    await publishBillingChanges(db, orgIds, signal);
    if (result.drainOrgId) {
      waitUntil(
        set(
          pickOrgQueuedChatThreads$,
          { orgId: result.drainOrgId },
          new AbortController().signal,
        ),
      );
    }
    return [...orgIds];
  },
);

export const reconcilePaidStripeInvoice$ = command(
  async (
    { set },
    invoice: StripeInvoice,
    signal: AbortSignal,
  ): Promise<string | null> => {
    const db = set(writeDb$);
    const orgId = await set(handleInvoicePaid$, invoice, signal);
    signal.throwIfAborted();
    if (!orgId) {
      return null;
    }

    await publishBillingChanges(db, new Set([orgId]), signal);
    waitUntil(
      set(pickOrgQueuedChatThreads$, { orgId }, new AbortController().signal),
    );
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

    if (!shouldHandleStripeBillingEvent(event)) {
      L.debug("ignoring Stripe event outside the active billing scope", {
        type: event.type,
        id: event.id,
      });
      return;
    }

    switch (event.kind) {
      case "payment_intent.succeeded": {
        const usagePackInvitation = await set(
          handleUsagePackInvitationPaymentIntentSucceeded$,
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
        const setupResult = await set(
          handleBillingSetupCheckoutCompleted$,
          event.object,
          signal,
        );
        const result =
          setupResult ??
          (await set(
            handleCheckoutCompleted$,
            event.object,
            new Date(event.created * 1000),
            signal,
          ));
        signal.throwIfAborted();
        drainOrgId = result.drainOrgId;
        addBillingChangedOrgIds(billingChangedOrgIds, result.orgIds);
        break;
      }
      case "checkout.session.failed": {
        await set(
          handleUsagePackInvitationCheckoutFailed$,
          event.object,
          signal,
        );
        break;
      }
      case "invoice.paid": {
        drainOrgId = await set(handleInvoicePaid$, event.object, signal);
        if (drainOrgId) {
          billingChangedOrgIds.add(drainOrgId);
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
        const orgIds = await set(
          handleSubscriptionUpdated$,
          event.object,
          event.previousAttributes,
          signal,
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
      const queueSignal = new AbortController().signal;
      waitUntil(
        set(pickOrgQueuedChatThreads$, { orgId: drainOrgId }, queueSignal),
      );
    }
  },
);
