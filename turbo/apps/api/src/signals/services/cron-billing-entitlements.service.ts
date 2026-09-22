import type { OrgTier } from "@okouai/api-contracts/contracts/orgs";
import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgConcurrencySubscriptions } from "@okouai/db/schema/org-concurrency-subscription";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgUsageAllowanceEntitlements } from "@okouai/db/schema/org-usage-allowance";
import { usagePackSubscriptions } from "@okouai/db/schema/usage-pack-subscription";
import { command } from "ccstate";
import {
  and,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { clerk$ } from "../external/clerk";
import {
  getStripeClient,
  isStripeResourceMissingError,
  listAllStripeSubscriptions,
  listUndeliveredStripePaidCheckoutSessions,
  listUndeliveredStripePaidInvoices,
  type StripeInvoice,
  type StripeSubscription,
  type StripeSubscriptionListStatus,
} from "../external/stripe-client";
import { settle } from "../utils";
import type { BillingReconciliationScope } from "./billing-reconciliation-scope";
import {
  CONCURRENCY_SUBSCRIPTION_PAYMENT_FAILED_STATUSES,
  isConcurrencyPriceId,
} from "./org-concurrency-entitlements.service";
import {
  upsertOrgPlanEntitlement,
  writeOrgMetadataWithPlanEntitlements,
} from "./org-plan-entitlements.service";
import {
  knownBillingPlanPriceItem,
  knownPlanPriceItem,
  tierForKnownPlanPrice,
} from "./billing-checkout.service";
import {
  reconcileUsagePackSubscriptions,
  stripeSubscriptionUsesMemberUsagePacks,
} from "./usage-pack-subscription.service";
import { reconcileUsagePackCreditRefunds } from "./usage-pack-credit-refund.service";
import { reconcileUsagePackInvitationPurchases } from "./usage-pack-invitation-purchase.service";
import { reconcileUsagePackSubscriptionMigrations } from "./usage-pack-subscription-migration.service";
import { disableIneligibleWorkflowWebhookAutomationsForOrg } from "./workflow-webhook-automation-entitlement.service";
import { isCurrentStripePreviewMetadata } from "./stripe-preview-metadata.service";
import {
  reconcileMissingStripeSubscription,
  reconcilePaidStripeCheckoutSession$,
  reconcilePaidStripeInvoice$,
  reconcileStripeSubscriptionSnapshot,
  type StripeSubscriptionSnapshotReconciliation,
} from "./webhooks-stripe.service";
import type { Tx } from "../../lib/db-types";

const L = logger("CronBillingEntitlements");
const PAID_TIERS = ["pro", "team", "custom"] as const;
const ENTITLEMENT_PERIOD_REFRESH_STATUSES = ["active", "trialing"] as const;
const PAYMENT_FAILED_SUBSCRIPTION_STATUSES = ["past_due", "unpaid"] as const;
const USAGE_ALLOWANCE_RECONCILE_STATUSES = [
  ...ENTITLEMENT_PERIOD_REFRESH_STATUSES,
  ...PAYMENT_FAILED_SUBSCRIPTION_STATUSES,
] as const;
const PAYMENT_FAILURE_DOWNGRADE_GRACE_MS = 24 * 60 * 60 * 1000;
const ATOM_GRANT_SUBSCRIPTION_STATUS = "atom_grant";
const TERMINAL_USAGE_ALLOWANCE_STATUSES = [
  "canceled",
  "incomplete_expired",
] as const;
const CANCELED_SUBSCRIPTION_TARGET_TIER = "limited-free-1";
const DISCOVERABLE_STRIPE_SUBSCRIPTION_STATUSES = [
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "paused",
  "incomplete",
] as const satisfies readonly StripeSubscriptionListStatus[];
const TERMINAL_LOCAL_SUBSCRIPTION_STATUSES = [
  "canceled",
  "incomplete_expired",
  "invalid",
] as const;

interface SubscriptionInput {
  readonly id: string;
  readonly status: string;
  readonly metadata?: Record<string, string> | null;
  readonly cancel_at?: number | null;
  readonly cancel_at_period_end: boolean;
  readonly items: {
    readonly data: readonly {
      readonly id?: string;
      readonly price: {
        readonly id: string;
        readonly product?: string | { readonly id: string } | null;
      };
      readonly quantity?: number | null;
      readonly current_period_end?: number | null;
    }[];
  };
}

interface BillingCandidate {
  readonly orgId: string;
  readonly stripeSubscriptionId: string | null;
}

interface StripeBillingCandidate {
  readonly orgId: string;
  readonly stripeSubscriptionId: string;
}

interface AtomGrantCandidate {
  readonly orgId: string;
}

interface ConcurrencyCandidate {
  readonly orgId: string;
  readonly stripeSubscriptionId: string;
}

interface UsageAllowanceCandidate {
  readonly orgId: string;
  readonly stripeSubscriptionId: string;
}

interface DowngradedSubscription {
  readonly orgId: string;
  readonly subscriptionId: string | null;
  readonly status: string | null;
}

interface ExpiredConcurrencySubscription {
  readonly orgId: string;
  readonly subscriptionId: string;
  readonly status: string | null;
}

interface ReconciledUsageAllowance {
  readonly orgId: string;
  readonly subscriptionId: string;
  readonly status: string | null;
}

interface UsageAllowanceCandidateRow {
  readonly orgId: string;
  readonly stripeSubscriptionId: string | null;
}

interface UsagePackMigrationReconciliation {
  readonly reconciled: number;
  readonly orgIds: readonly string[];
}

function logUsagePackMigrationReconciliation(
  reconciliation: UsagePackMigrationReconciliation,
): void {
  if (reconciliation.reconciled > 0) {
    L.warn("usage pack subscription migrations reconciled from Stripe", {
      count: reconciliation.reconciled,
      orgIds: reconciliation.orgIds.slice(0, 10),
    });
  }
}

interface ReconcileCandidateRows {
  readonly candidates: readonly BillingCandidate[];
  readonly atomGrantCandidates: readonly AtomGrantCandidate[];
  readonly concurrencyCandidates: readonly ConcurrencyCandidate[];
  readonly usageAllowanceCandidates: readonly UsageAllowanceCandidateRow[];
}

interface ReconcileBillingContext {
  readonly db: Db;
  readonly stripe: ReturnType<typeof getStripeClient>;
  readonly now: Date;
  readonly staleBefore: Date;
}

interface ReconciledCandidateRows {
  readonly downgraded: readonly DowngradedSubscription[];
  readonly expiredConcurrency: readonly ExpiredConcurrencySubscription[];
  readonly reconciledUsageAllowances: readonly ReconciledUsageAllowance[];
}

type ReconcileTx = Tx;
type ClerkClient = ReturnType<typeof clerk$.read>;

interface StripeSubscriptionDiscovery {
  readonly subscriptions: readonly StripeSubscription[];
  readonly missingSubscriptionIds: readonly string[];
  readonly failedSubscriptionIds: readonly string[];
}

interface StripeSubscriptionSweepResult {
  readonly attempted: number;
  readonly reconciled: number;
  readonly failed: number;
  readonly paidInvoices: number;
  readonly changedOrgIds: readonly string[];
  readonly downgraded: readonly DowngradedSubscription[];
}

interface UndeliveredPaidInvoiceSweepResult {
  readonly discovered: number;
  readonly replayed: number;
  readonly failed: number;
  readonly orgIds: readonly string[];
}

interface UndeliveredPaidCheckoutSweepResult {
  readonly discovered: number;
  readonly replayed: number;
  readonly failed: number;
  readonly orgIds: readonly string[];
}

function localSubscriptionStatusIsReconcileable(
  status: string | null,
): boolean {
  return (
    status === null ||
    !TERMINAL_LOCAL_SUBSCRIPTION_STATUSES.includes(
      status as (typeof TERMINAL_LOCAL_SUBSCRIPTION_STATUSES)[number],
    )
  );
}

function stripeSubscriptionIsDiscoverable(
  subscription: StripeSubscription,
): boolean {
  return DISCOVERABLE_STRIPE_SUBSCRIPTION_STATUSES.includes(
    subscription.status as (typeof DISCOVERABLE_STRIPE_SUBSCRIPTION_STATUSES)[number],
  );
}

function stripeSubscriptionLooksBillingRelated(
  subscription: StripeSubscription,
): boolean {
  return (
    Boolean(subscription.metadata?.orgId) ||
    knownBillingPlanPriceItem(subscription.items.data) !== undefined
  );
}

async function listStripeSubscriptionPages(
  stripe: ReturnType<typeof getStripeClient>,
  params: {
    readonly customer?: string;
    readonly status: StripeSubscriptionListStatus;
  },
  signal: AbortSignal,
): Promise<readonly StripeSubscription[]> {
  return await listAllStripeSubscriptions(
    stripe,
    {
      ...params,
      expand: ["data.latest_invoice"],
    },
    signal,
  );
}

async function loadScopedStripeCustomerIds(
  db: Db,
  scope: BillingReconciliationScope | undefined,
): Promise<readonly string[]> {
  if (!scope) {
    return [];
  }
  const rows = await db
    .select({ stripeCustomerId: orgMetadata.stripeCustomerId })
    .from(orgMetadata)
    .where(
      and(
        inArray(orgMetadata.orgId, [...scope.orgIds]),
        isNotNull(orgMetadata.stripeCustomerId),
      ),
    );
  return [
    ...new Set(
      rows.flatMap((row) => {
        return row.stripeCustomerId ? [row.stripeCustomerId] : [];
      }),
    ),
  ];
}

async function loadKnownStripeSubscriptionIds(
  db: Db,
  scope: BillingReconciliationScope | undefined,
): Promise<readonly string[]> {
  const [planRows, concurrencyRows, allowanceRows, usagePackRows] =
    await Promise.all([
      db
        .select({ subscriptionId: orgMetadata.stripeSubscriptionId })
        .from(orgMetadata)
        .where(
          and(
            scope ? inArray(orgMetadata.orgId, [...scope.orgIds]) : undefined,
            isNotNull(orgMetadata.stripeSubscriptionId),
          ),
        ),
      db
        .select({
          subscriptionId: orgConcurrencySubscriptions.stripeSubscriptionId,
          status: orgConcurrencySubscriptions.subscriptionStatus,
        })
        .from(orgConcurrencySubscriptions)
        .where(
          scope
            ? inArray(orgConcurrencySubscriptions.orgId, [...scope.orgIds])
            : undefined,
        ),
      db
        .select({
          subscriptionId: orgUsageAllowanceEntitlements.stripeSubscriptionId,
          status: orgUsageAllowanceEntitlements.status,
        })
        .from(orgUsageAllowanceEntitlements)
        .where(
          and(
            scope
              ? inArray(orgUsageAllowanceEntitlements.orgId, [...scope.orgIds])
              : undefined,
            isNotNull(orgUsageAllowanceEntitlements.stripeSubscriptionId),
            notInArray(orgUsageAllowanceEntitlements.status, [
              ...TERMINAL_LOCAL_SUBSCRIPTION_STATUSES,
            ]),
          ),
        ),
      db
        .select({
          subscriptionId: usagePackSubscriptions.stripeSubscriptionId,
          status: usagePackSubscriptions.subscriptionStatus,
        })
        .from(usagePackSubscriptions)
        .where(
          and(
            scope
              ? inArray(usagePackSubscriptions.orgId, [...scope.orgIds])
              : undefined,
            isNotNull(usagePackSubscriptions.stripeSubscriptionId),
            notInArray(usagePackSubscriptions.subscriptionStatus, [
              ...TERMINAL_LOCAL_SUBSCRIPTION_STATUSES,
            ]),
          ),
        ),
    ]);

  return [
    ...new Set([
      ...planRows.flatMap((row) => {
        return row.subscriptionId ? [row.subscriptionId] : [];
      }),
      ...concurrencyRows.flatMap((row) => {
        return localSubscriptionStatusIsReconcileable(row.status)
          ? [row.subscriptionId]
          : [];
      }),
      ...allowanceRows.flatMap((row) => {
        return row.subscriptionId ? [row.subscriptionId] : [];
      }),
      ...usagePackRows.flatMap((row) => {
        return row.subscriptionId ? [row.subscriptionId] : [];
      }),
    ]),
  ];
}

async function discoverStripeSubscriptions(
  db: Db,
  stripe: ReturnType<typeof getStripeClient>,
  scope: BillingReconciliationScope | undefined,
  signal: AbortSignal,
): Promise<StripeSubscriptionDiscovery> {
  const discovered = new Map<string, StripeSubscription>();
  const scopedCustomerIds = await loadScopedStripeCustomerIds(db, scope);
  signal.throwIfAborted();
  const listedSubscriptions = scope
    ? (
        await Promise.all(
          scopedCustomerIds.map(async (customerId) => {
            return await listStripeSubscriptionPages(
              stripe,
              { customer: customerId, status: "all" },
              signal,
            );
          }),
        )
      ).flat()
    : (
        await Promise.all(
          DISCOVERABLE_STRIPE_SUBSCRIPTION_STATUSES.map(async (status) => {
            return await listStripeSubscriptionPages(
              stripe,
              { status },
              signal,
            );
          }),
        )
      ).flat();
  signal.throwIfAborted();

  for (const subscription of listedSubscriptions) {
    if (
      stripeSubscriptionIsDiscoverable(subscription) &&
      isCurrentStripePreviewMetadata(subscription.metadata) &&
      (scope || stripeSubscriptionLooksBillingRelated(subscription))
    ) {
      discovered.set(subscription.id, subscription);
    }
  }

  const knownSubscriptionIds = await loadKnownStripeSubscriptionIds(db, scope);
  signal.throwIfAborted();
  const missingSubscriptionIds: string[] = [];
  const failedSubscriptionIds: string[] = [];
  for (const subscriptionId of knownSubscriptionIds) {
    if (discovered.has(subscriptionId)) {
      continue;
    }
    const retrieved = await settle(
      stripe.subscriptions.retrieve(subscriptionId, {
        expand: ["latest_invoice"],
      }),
    );
    signal.throwIfAborted();
    if (retrieved.ok) {
      discovered.set(retrieved.value.id, retrieved.value);
    } else if (isStripeResourceMissingError(retrieved.error)) {
      missingSubscriptionIds.push(subscriptionId);
    } else {
      failedSubscriptionIds.push(subscriptionId);
      L.warn("Stripe subscription retrieval failed during discovery", {
        subscriptionId,
        error: retrieved.error,
      });
    }
  }

  return {
    subscriptions: [...discovered.values()],
    missingSubscriptionIds,
    failedSubscriptionIds,
  };
}

function collectStripeSubscriptionSnapshot(
  changedOrgIds: Set<string>,
  downgraded: DowngradedSubscription[],
  subscriptionId: string,
  status: string | null,
  result: StripeSubscriptionSnapshotReconciliation,
): number {
  for (const orgId of result.orgIds) {
    changedOrgIds.add(orgId);
  }
  for (const orgId of result.downgradedOrgIds) {
    downgraded.push({ orgId, subscriptionId, status });
  }
  return result.paidInvoiceId ? 1 : 0;
}

async function reconcileStripeSubscriptionSnapshots(
  db: Db,
  stripe: ReturnType<typeof getStripeClient>,
  clerk: ClerkClient,
  scope: BillingReconciliationScope | undefined,
  signal: AbortSignal,
): Promise<StripeSubscriptionSweepResult> {
  const discovery = await discoverStripeSubscriptions(
    db,
    stripe,
    scope,
    signal,
  );
  const changedOrgIds = new Set<string>();
  const downgraded: DowngradedSubscription[] = [];
  let paidInvoices = 0;
  let reconciled = 0;
  let failed = discovery.failedSubscriptionIds.length;

  for (const subscription of discovery.subscriptions) {
    const result = await settle(
      reconcileStripeSubscriptionSnapshot(
        db,
        () => {
          return clerk;
        },
        subscription,
        signal,
      ),
      signal,
    );
    if (!result.ok) {
      failed += 1;
      L.warn("Stripe subscription snapshot reconciliation failed", {
        subscriptionId: subscription.id,
        status: subscription.status,
        error: result.error,
      });
      continue;
    }
    reconciled += 1;
    paidInvoices += collectStripeSubscriptionSnapshot(
      changedOrgIds,
      downgraded,
      subscription.id,
      subscription.status,
      result.value,
    );
  }
  for (const subscriptionId of discovery.missingSubscriptionIds) {
    const result = await settle(
      reconcileMissingStripeSubscription(db, subscriptionId, signal),
      signal,
    );
    if (!result.ok) {
      failed += 1;
      L.warn("missing Stripe subscription reconciliation failed", {
        subscriptionId,
        error: result.error,
      });
      continue;
    }
    reconciled += 1;
    collectStripeSubscriptionSnapshot(
      changedOrgIds,
      downgraded,
      subscriptionId,
      null,
      result.value,
    );
  }

  return {
    attempted:
      discovery.subscriptions.length +
      discovery.missingSubscriptionIds.length +
      discovery.failedSubscriptionIds.length,
    reconciled,
    failed,
    paidInvoices,
    changedOrgIds: [...changedOrgIds],
    downgraded,
  };
}

async function disableIneligibleWorkflowWebhooksForOrgs(
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
  }
}

function paidInvoiceBelongsToCurrentEnvironment(
  invoice: StripeInvoice,
): boolean {
  return [
    invoice.metadata,
    invoice.parent?.subscription_details?.metadata,
  ].some((metadata) => {
    return isCurrentStripePreviewMetadata(metadata);
  });
}

export const reconcileUndeliveredStripePaidCheckoutSessions$ = command(
  async (
    { set },
    signal: AbortSignal,
  ): Promise<UndeliveredPaidCheckoutSweepResult> => {
    const events = await listUndeliveredStripePaidCheckoutSessions(signal);
    const orgIds = new Set<string>();
    let replayed = 0;
    let failed = 0;
    for (const event of events) {
      const result = await settle(
        set(
          reconcilePaidStripeCheckoutSession$,
          {
            session: event.session,
            paidAt: new Date(event.created * 1000),
          },
          signal,
        ),
        signal,
      );
      if (!result.ok) {
        failed += 1;
        L.warn("undelivered Stripe paid Checkout reconciliation failed", {
          eventId: event.eventId,
          eventType: event.eventType,
          sessionId: event.session.id,
          error: result.error,
        });
        continue;
      }
      replayed += 1;
      for (const orgId of result.value) {
        orgIds.add(orgId);
      }
    }
    if (events.length > 0) {
      L.warn("undelivered Stripe paid Checkouts reconciled", {
        discovered: events.length,
        replayed,
        failed,
        orgs: orgIds.size,
      });
    }
    return {
      discovered: events.length,
      replayed,
      failed,
      orgIds: [...orgIds],
    };
  },
);

export const reconcileUndeliveredStripePaidInvoices$ = command(
  async (
    { set },
    signal: AbortSignal,
  ): Promise<UndeliveredPaidInvoiceSweepResult> => {
    const events = await listUndeliveredStripePaidInvoices(signal);
    const orgIds = new Set<string>();
    let replayed = 0;
    let failed = 0;
    for (const event of events) {
      if (!paidInvoiceBelongsToCurrentEnvironment(event.invoice)) {
        continue;
      }
      const result = await settle(
        set(reconcilePaidStripeInvoice$, event.invoice, signal),
        signal,
      );
      if (!result.ok) {
        failed += 1;
        L.warn("undelivered Stripe paid invoice reconciliation failed", {
          eventId: event.eventId,
          invoiceId: event.invoice.id,
          error: result.error,
        });
        continue;
      }
      replayed += 1;
      if (result.value) {
        orgIds.add(result.value);
      }
    }
    return {
      discovered: events.length,
      replayed,
      failed,
      orgIds: [...orgIds],
    };
  },
);

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

function subscriptionScheduledEnd(
  subscription: SubscriptionInput,
): Date | null {
  return (
    subscriptionCancelAt(subscription) ?? subscriptionPeriodEnd(subscription)
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

function subscriptionCanRefreshPaidThrough(
  subscription: SubscriptionInput,
): boolean {
  return ENTITLEMENT_PERIOD_REFRESH_STATUSES.includes(
    subscription.status as (typeof ENTITLEMENT_PERIOD_REFRESH_STATUSES)[number],
  );
}

function subscriptionIsPaymentFailed(subscription: SubscriptionInput): boolean {
  return PAYMENT_FAILED_SUBSCRIPTION_STATUSES.includes(
    subscription.status as (typeof PAYMENT_FAILED_SUBSCRIPTION_STATUSES)[number],
  );
}

function subscriptionIsTerminalUsageAllowance(
  subscription: SubscriptionInput,
): boolean {
  return (
    subscription.metadata?.allowanceStatus === "canceled" ||
    TERMINAL_USAGE_ALLOWANCE_STATUSES.includes(
      subscription.status as (typeof TERMINAL_USAGE_ALLOWANCE_STATUSES)[number],
    )
  );
}

function knownOrgTier(value: string): OrgTier {
  switch (value) {
    case "free":
    case "limited-free-1":
    case "pro":
    case "team":
    case "custom": {
      return value;
    }
    default: {
      throw new Error(`Unknown org tier: ${value}`);
    }
  }
}

async function upsertStripeSubscriptionPlanSnapshot(
  tx: ReconcileTx,
  args: {
    readonly orgId: string;
    readonly tier: OrgTier;
    readonly subscription: SubscriptionInput;
    readonly stripeSubscriptionId: string | null;
    readonly stripePriceId?: string | null;
    readonly status?: string;
  },
): Promise<void> {
  const scheduledEnd = subscriptionScheduledEnd(args.subscription);
  const cancelAt = subscriptionWillCancel(args.subscription)
    ? scheduledEnd
    : null;
  const showUsagePack =
    args.stripeSubscriptionId !== null &&
    (args.tier === "pro" || args.tier === "team" || args.tier === "custom") &&
    (await stripeSubscriptionUsesMemberUsagePacks(tx, {
      orgId: args.orgId,
      stripeSubscriptionId: args.stripeSubscriptionId,
    }));
  await upsertOrgPlanEntitlement(tx, {
    orgId: args.orgId,
    tier: args.tier,
    source: "stripe_subscription",
    status: args.status,
    stripeSubscriptionId: args.stripeSubscriptionId,
    stripePriceId: args.stripePriceId ?? null,
    currentPeriodEnd: scheduledEnd,
    cancelAt,
    expiresAt: cancelAt,
    showUsagePack,
    sourceMetadata: args.subscription.metadata ?? {},
  });
}

function currentUsageAllowanceCandidateWhere(
  candidate: UsageAllowanceCandidate,
) {
  return and(
    eq(
      orgUsageAllowanceEntitlements.stripeSubscriptionId,
      candidate.stripeSubscriptionId,
    ),
    inArray(orgUsageAllowanceEntitlements.status, [
      ...USAGE_ALLOWANCE_RECONCILE_STATUSES,
    ]),
  );
}

async function updateUsageAllowanceCandidate(
  context: ReconcileBillingContext,
  candidate: UsageAllowanceCandidate,
  values: {
    readonly status: string;
    readonly expiresAt: Date;
  },
  signal: AbortSignal,
): Promise<ReconciledUsageAllowance[]> {
  const rows = await context.db
    .update(orgUsageAllowanceEntitlements)
    .set({
      status: values.status,
      expiresAt: values.expiresAt,
      updatedAt: context.now,
    })
    .where(currentUsageAllowanceCandidateWhere(candidate))
    .returning({
      orgId: orgUsageAllowanceEntitlements.orgId,
      subscriptionId: orgUsageAllowanceEntitlements.stripeSubscriptionId,
      status: orgUsageAllowanceEntitlements.status,
    });
  signal.throwIfAborted();
  return rows.map((row) => {
    return {
      ...row,
      subscriptionId: row.subscriptionId ?? candidate.stripeSubscriptionId,
    };
  });
}

interface SyncedBillingFields {
  readonly subscriptionStatus: string;
  readonly cancelAtPeriodEnd: boolean;
  readonly updatedAt: Date;
  readonly currentPeriodEnd?: Date;
}

function currentBillingCandidateWhere(candidate: StripeBillingCandidate) {
  return and(
    eq(orgMetadata.orgId, candidate.orgId),
    eq(orgMetadata.stripeSubscriptionId, candidate.stripeSubscriptionId),
    inArray(orgMetadata.tier, PAID_TIERS),
    inArray(orgMetadata.subscriptionStatus, [
      ...PAYMENT_FAILED_SUBSCRIPTION_STATUSES,
    ]),
  );
}

async function reconcileCanceledBillingCandidate(
  context: ReconcileBillingContext,
  candidate: StripeBillingCandidate,
  subscription: SubscriptionInput,
  signal: AbortSignal,
): Promise<DowngradedSubscription[]> {
  const { db, now } = context;
  const rows = await db.transaction(async (tx) => {
    return await writeOrgMetadataWithPlanEntitlements(tx, {
      writeOrgMetadata: async (writeTx) => {
        return await writeTx
          .update(orgMetadata)
          .set({
            tier: CANCELED_SUBSCRIPTION_TARGET_TIER,
            subscriptionStatus: "canceled",
            stripeSubscriptionId: null,
            cancelAtPeriodEnd: false,
            currentPeriodEnd: null,
            updatedAt: now,
          })
          .where(currentBillingCandidateWhere(candidate))
          .returning({
            orgId: orgMetadata.orgId,
            status: orgMetadata.subscriptionStatus,
          });
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
  });
  signal.throwIfAborted();

  return rows.map((row) => {
    return { ...row, subscriptionId: candidate.stripeSubscriptionId };
  });
}

async function refreshRecoveredBillingCandidate(
  context: ReconcileBillingContext,
  candidate: StripeBillingCandidate,
  subscription: SubscriptionInput,
  syncedFields: SyncedBillingFields,
  signal: AbortSignal,
): Promise<void> {
  const { db } = context;
  const planItem = knownBillingPlanPriceItem(subscription.items.data);
  const priceId = planItem?.price.id ?? subscription.items.data[0]?.price.id;
  const tier = planItem
    ? (tierForKnownPlanPrice(planItem.price) ?? undefined)
    : undefined;

  await db.transaction(async (tx) => {
    await writeOrgMetadataWithPlanEntitlements(tx, {
      writeOrgMetadata: async (writeTx) => {
        return await writeTx
          .update(orgMetadata)
          .set({
            ...syncedFields,
            ...(tier ? { tier } : {}),
          })
          .where(currentBillingCandidateWhere(candidate))
          .returning({
            orgId: orgMetadata.orgId,
          });
      },
      writePlanEntitlement: async (writeTx, row) => {
        if (!tier) {
          return;
        }
        await upsertStripeSubscriptionPlanSnapshot(writeTx, {
          orgId: row.orgId,
          tier,
          subscription,
          stripeSubscriptionId: candidate.stripeSubscriptionId,
          stripePriceId: priceId,
          status: subscription.status,
        });
      },
    });
  });
  signal.throwIfAborted();
}

async function refreshPaymentFailedPaidThroughCandidate(
  context: ReconcileBillingContext,
  candidate: StripeBillingCandidate,
  subscription: SubscriptionInput,
  syncedFields: SyncedBillingFields,
  signal: AbortSignal,
): Promise<void> {
  const { db } = context;
  await db.transaction(async (tx) => {
    await writeOrgMetadataWithPlanEntitlements(tx, {
      writeOrgMetadata: async (writeTx) => {
        return await writeTx
          .update(orgMetadata)
          .set(syncedFields)
          .where(currentBillingCandidateWhere(candidate))
          .returning({
            orgId: orgMetadata.orgId,
            tier: orgMetadata.tier,
          });
      },
      writePlanEntitlement: async (writeTx, row) => {
        await upsertStripeSubscriptionPlanSnapshot(writeTx, {
          orgId: row.orgId,
          tier: knownOrgTier(row.tier),
          subscription,
          stripeSubscriptionId: candidate.stripeSubscriptionId,
          stripePriceId:
            knownPlanPriceItem(subscription.items.data)?.price.id ??
            subscription.items.data[0]?.price.id ??
            null,
          status: subscription.status,
        });
      },
    });
  });
  signal.throwIfAborted();
}

async function downgradePaymentFailedBillingCandidate(
  context: ReconcileBillingContext,
  candidate: StripeBillingCandidate,
  subscription: SubscriptionInput,
  syncedFields: SyncedBillingFields,
  signal: AbortSignal,
): Promise<DowngradedSubscription[]> {
  const { db } = context;
  const rows = await db.transaction(async (tx) => {
    return await writeOrgMetadataWithPlanEntitlements(tx, {
      writeOrgMetadata: async (writeTx) => {
        return await writeTx
          .update(orgMetadata)
          .set({
            tier: CANCELED_SUBSCRIPTION_TARGET_TIER,
            ...syncedFields,
          })
          .where(currentBillingCandidateWhere(candidate))
          .returning({
            orgId: orgMetadata.orgId,
            subscriptionId: orgMetadata.stripeSubscriptionId,
            status: orgMetadata.subscriptionStatus,
          });
      },
      writePlanEntitlement: async (writeTx, row) => {
        await upsertStripeSubscriptionPlanSnapshot(writeTx, {
          orgId: row.orgId,
          tier: CANCELED_SUBSCRIPTION_TARGET_TIER,
          subscription,
          stripeSubscriptionId: row.subscriptionId,
          stripePriceId:
            knownPlanPriceItem(subscription.items.data)?.price.id ??
            subscription.items.data[0]?.price.id ??
            null,
        });
      },
    });
  });
  signal.throwIfAborted();
  return rows;
}

async function reconcileBillingCandidate(
  context: ReconcileBillingContext,
  candidate: BillingCandidate,
  signal: AbortSignal,
): Promise<DowngradedSubscription[]> {
  const { stripe, now, staleBefore } = context;
  if (!candidate.stripeSubscriptionId) {
    return [];
  }
  const stripeCandidate: StripeBillingCandidate = {
    orgId: candidate.orgId,
    stripeSubscriptionId: candidate.stripeSubscriptionId,
  };

  const subscription = (await stripe.subscriptions.retrieve(
    stripeCandidate.stripeSubscriptionId,
  )) as SubscriptionInput;
  signal.throwIfAborted();

  const stripePeriodEnd = subscriptionPeriodEnd(subscription);
  const scheduledEnd = subscriptionScheduledEnd(subscription);
  const syncedFields = {
    subscriptionStatus: subscription.status,
    cancelAtPeriodEnd: subscriptionWillCancel(subscription),
    updatedAt: now,
    ...(scheduledEnd ? { currentPeriodEnd: scheduledEnd } : {}),
  };

  if (subscription.status === "canceled") {
    return await reconcileCanceledBillingCandidate(
      context,
      stripeCandidate,
      subscription,
      signal,
    );
  }

  if (!subscriptionIsPaymentFailed(subscription)) {
    if (!subscriptionCanRefreshPaidThrough(subscription)) {
      L.warn(
        "payment-failed local subscription has unexpected Stripe status; skipping downgrade",
        {
          orgId: candidate.orgId,
          subscriptionId: stripeCandidate.stripeSubscriptionId,
          status: subscription.status,
        },
      );
      return [];
    }

    await refreshRecoveredBillingCandidate(
      context,
      stripeCandidate,
      subscription,
      syncedFields,
      signal,
    );
    return [];
  }

  if (!stripePeriodEnd) {
    L.warn(
      "payment-failed subscription missing paid-through in Stripe; downgrading",
      {
        orgId: candidate.orgId,
        subscriptionId: stripeCandidate.stripeSubscriptionId,
        status: subscription.status,
      },
    );
  } else if (stripePeriodEnd > staleBefore) {
    await refreshPaymentFailedPaidThroughCandidate(
      context,
      stripeCandidate,
      subscription,
      syncedFields,
      signal,
    );
    return [];
  }

  return await downgradePaymentFailedBillingCandidate(
    context,
    stripeCandidate,
    subscription,
    syncedFields,
    signal,
  );
}

async function expireOrgCredits(
  db: Db,
  orgId: string,
  now: Date,
): Promise<number> {
  return await db.transaction(async (tx) => {
    const expired = await tx
      .select({
        id: creditExpiresRecord.id,
        remaining: creditExpiresRecord.remaining,
      })
      .from(creditExpiresRecord)
      .where(
        and(
          eq(creditExpiresRecord.orgId, orgId),
          lte(creditExpiresRecord.expiresAt, now),
          gt(creditExpiresRecord.remaining, 0),
        ),
      )
      .for("update");

    const totalExpired = expired.reduce((sum, record) => {
      return sum + record.remaining;
    }, 0);
    if (totalExpired <= 0) {
      return 0;
    }

    for (const record of expired) {
      await tx
        .update(creditExpiresRecord)
        .set({ remaining: 0 })
        .where(eq(creditExpiresRecord.id, record.id));
    }

    await tx
      .update(orgMetadata)
      .set({
        credits: sql`GREATEST(${orgMetadata.credits} - ${totalExpired}, 0)`,
        updatedAt: now,
      })
      .where(eq(orgMetadata.orgId, orgId));

    return totalExpired;
  });
}

async function reconcileAtomGrantCandidate(
  context: ReconcileBillingContext,
  candidate: AtomGrantCandidate,
  signal: AbortSignal,
): Promise<DowngradedSubscription[]> {
  const { db, now } = context;
  await expireOrgCredits(db, candidate.orgId, now);
  signal.throwIfAborted();

  const rows = await db.transaction(async (tx) => {
    return await writeOrgMetadataWithPlanEntitlements(tx, {
      writeOrgMetadata: async (writeTx) => {
        return await writeTx
          .update(orgMetadata)
          .set({
            tier: CANCELED_SUBSCRIPTION_TARGET_TIER,
            subscriptionStatus: "expired",
            cancelAtPeriodEnd: false,
            currentPeriodEnd: null,
            pendingSubscriptionScheduleId: null,
            pendingSubscriptionTargetTier: null,
            pendingSubscriptionChangeAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(orgMetadata.orgId, candidate.orgId),
              inArray(orgMetadata.tier, PAID_TIERS),
              isNull(orgMetadata.stripeSubscriptionId),
              eq(
                orgMetadata.subscriptionStatus,
                ATOM_GRANT_SUBSCRIPTION_STATUS,
              ),
              isNotNull(orgMetadata.currentPeriodEnd),
              lte(orgMetadata.currentPeriodEnd, now),
            ),
          )
          .returning({
            orgId: orgMetadata.orgId,
            subscriptionId: orgMetadata.stripeSubscriptionId,
            status: orgMetadata.subscriptionStatus,
          });
      },
      writePlanEntitlement: async (writeTx, row) => {
        await upsertOrgPlanEntitlement(writeTx, {
          orgId: row.orgId,
          tier: CANCELED_SUBSCRIPTION_TARGET_TIER,
          source: "stripe_atom_grant",
        });
      },
    });
  });
  signal.throwIfAborted();
  return rows;
}

async function reconcileConcurrencyCandidate(
  context: ReconcileBillingContext,
  candidate: ConcurrencyCandidate,
  signal: AbortSignal,
): Promise<ExpiredConcurrencySubscription[]> {
  const { db, stripe, now, staleBefore } = context;
  const subscription = (await stripe.subscriptions.retrieve(
    candidate.stripeSubscriptionId,
  )) as SubscriptionInput;
  signal.throwIfAborted();

  const item = concurrencySubscriptionItem(subscription);
  const periodEnd = concurrencySubscriptionPeriodEnd(subscription);
  const slots = concurrencySubscriptionSlots(subscription);
  const isPaymentFailed = subscriptionIsPaymentFailed(subscription);
  const syncedFields = {
    subscriptionStatus: subscription.status,
    cancelAtPeriodEnd:
      subscription.cancel_at_period_end &&
      knownBillingPlanPriceItem(subscription.items.data) === undefined,
    updatedAt: now,
    ...(periodEnd ? { currentPeriodEnd: periodEnd } : {}),
    ...(item ? { stripePriceId: item.price.id } : {}),
    ...(slots ? { slots } : {}),
  };
  const currentCandidate = and(
    eq(
      orgConcurrencySubscriptions.stripeSubscriptionId,
      candidate.stripeSubscriptionId,
    ),
    inArray(orgConcurrencySubscriptions.subscriptionStatus, [
      ...CONCURRENCY_SUBSCRIPTION_PAYMENT_FAILED_STATUSES,
    ]),
  );

  if (subscription.status === "canceled") {
    const rows = await db
      .update(orgConcurrencySubscriptions)
      .set({
        subscriptionStatus: "canceled",
        cancelAtPeriodEnd: false,
        currentPeriodEnd: now,
        updatedAt: now,
      })
      .where(currentCandidate)
      .returning({
        orgId: orgConcurrencySubscriptions.orgId,
        subscriptionId: orgConcurrencySubscriptions.stripeSubscriptionId,
        status: orgConcurrencySubscriptions.subscriptionStatus,
      });
    signal.throwIfAborted();
    return rows;
  }

  if (!isPaymentFailed) {
    if (!item) {
      L.warn(
        "payment-failed concurrency subscription has unexpected Stripe price; skipping",
        {
          orgId: candidate.orgId,
          subscriptionId: candidate.stripeSubscriptionId,
          status: subscription.status,
        },
      );
      return [];
    }

    await db
      .update(orgConcurrencySubscriptions)
      .set(syncedFields)
      .where(currentCandidate);
    signal.throwIfAborted();
    return [];
  }

  if (!periodEnd) {
    L.warn(
      "payment-failed concurrency subscription missing paid-through in Stripe; expiring",
      {
        orgId: candidate.orgId,
        subscriptionId: candidate.stripeSubscriptionId,
        status: subscription.status,
      },
    );
  } else if (periodEnd > staleBefore) {
    await db
      .update(orgConcurrencySubscriptions)
      .set(syncedFields)
      .where(currentCandidate);
    signal.throwIfAborted();
    return [];
  }

  const rows = await db
    .update(orgConcurrencySubscriptions)
    .set({
      ...syncedFields,
      subscriptionStatus: subscription.status,
    })
    .where(currentCandidate)
    .returning({
      orgId: orgConcurrencySubscriptions.orgId,
      subscriptionId: orgConcurrencySubscriptions.stripeSubscriptionId,
      status: orgConcurrencySubscriptions.subscriptionStatus,
    });
  signal.throwIfAborted();
  return rows;
}

async function reconcileUsageAllowanceCandidate(
  context: ReconcileBillingContext,
  candidate: UsageAllowanceCandidate,
  signal: AbortSignal,
): Promise<ReconciledUsageAllowance[]> {
  const { stripe, now, staleBefore } = context;
  const subscription = (await stripe.subscriptions.retrieve(
    candidate.stripeSubscriptionId,
  )) as SubscriptionInput;
  signal.throwIfAborted();

  const periodEnd = usageAllowanceSubscriptionEnd(subscription);
  const canRefreshPaidThrough = subscriptionCanRefreshPaidThrough(subscription);
  const isPaymentFailed = subscriptionIsPaymentFailed(subscription);
  const allowancePriceId = subscription.metadata?.allowancePriceId;
  const sharedAllowanceItem = allowancePriceId
    ? subscription.items.data.find((item) => {
        return item.price.id === allowancePriceId;
      })
    : undefined;

  if (
    periodEnd &&
    periodEnd <= now &&
    sharedAllowanceItem?.id &&
    knownBillingPlanPriceItem(subscription.items.data)
  ) {
    await stripe.subscriptions.update(subscription.id, {
      items: [{ id: sharedAllowanceItem.id, deleted: true }],
      metadata: {
        ...subscription.metadata,
        allowanceStatus: "canceled",
        allowanceCancelAt: periodEnd.toISOString(),
      },
      proration_behavior: "none",
    });
    signal.throwIfAborted();
    return await updateUsageAllowanceCandidate(
      context,
      candidate,
      { status: "canceled", expiresAt: periodEnd },
      signal,
    );
  }

  if (subscriptionIsTerminalUsageAllowance(subscription)) {
    return await updateUsageAllowanceCandidate(
      context,
      candidate,
      {
        status: "canceled",
        expiresAt: now,
      },
      signal,
    );
  }

  if (!isPaymentFailed) {
    if (!canRefreshPaidThrough) {
      L.warn("expired usage allowance has unexpected Stripe status; skipping", {
        orgId: candidate.orgId,
        subscriptionId: candidate.stripeSubscriptionId,
        status: subscription.status,
      });
      return [];
    }

    if (!periodEnd || periodEnd <= now) {
      L.warn(
        "expired usage allowance subscription missing future paid-through in Stripe",
        {
          orgId: candidate.orgId,
          subscriptionId: candidate.stripeSubscriptionId,
          status: subscription.status,
          periodEnd,
        },
      );
      return [];
    }

    return await updateUsageAllowanceCandidate(
      context,
      candidate,
      {
        status: subscription.status,
        expiresAt: periodEnd,
      },
      signal,
    );
  }

  if (!periodEnd) {
    L.warn(
      "payment-failed usage allowance subscription missing paid-through in Stripe; expiring",
      {
        orgId: candidate.orgId,
        subscriptionId: candidate.stripeSubscriptionId,
        status: subscription.status,
      },
    );
  } else if (periodEnd > staleBefore) {
    return await updateUsageAllowanceCandidate(
      context,
      candidate,
      {
        status: subscription.status,
        expiresAt: periodEnd,
      },
      signal,
    );
  }

  return await updateUsageAllowanceCandidate(
    context,
    candidate,
    {
      status: "canceled",
      expiresAt: now,
    },
    signal,
  );
}

async function loadReconcileCandidateRows(
  db: Db,
  now: Date,
  staleBefore: Date,
  scope: BillingReconciliationScope | undefined,
): Promise<ReconcileCandidateRows> {
  const [
    candidates,
    atomGrantCandidates,
    concurrencyCandidates,
    usageAllowanceCandidates,
  ] = await Promise.all([
    db
      .select({
        orgId: orgMetadata.orgId,
        stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
      })
      .from(orgMetadata)
      .where(
        and(
          scope ? inArray(orgMetadata.orgId, [...scope.orgIds]) : undefined,
          inArray(orgMetadata.tier, PAID_TIERS),
          isNotNull(orgMetadata.stripeSubscriptionId),
          inArray(orgMetadata.subscriptionStatus, [
            ...PAYMENT_FAILED_SUBSCRIPTION_STATUSES,
          ]),
          or(
            isNull(orgMetadata.currentPeriodEnd),
            lte(orgMetadata.currentPeriodEnd, staleBefore),
          ),
        ),
      ),
    db
      .select({
        orgId: orgMetadata.orgId,
      })
      .from(orgMetadata)
      .where(
        and(
          scope ? inArray(orgMetadata.orgId, [...scope.orgIds]) : undefined,
          inArray(orgMetadata.tier, PAID_TIERS),
          isNull(orgMetadata.stripeSubscriptionId),
          eq(orgMetadata.subscriptionStatus, ATOM_GRANT_SUBSCRIPTION_STATUS),
          isNotNull(orgMetadata.currentPeriodEnd),
          lte(orgMetadata.currentPeriodEnd, now),
        ),
      ),
    db
      .select({
        orgId: orgConcurrencySubscriptions.orgId,
        stripeSubscriptionId: orgConcurrencySubscriptions.stripeSubscriptionId,
      })
      .from(orgConcurrencySubscriptions)
      .where(
        and(
          scope
            ? inArray(orgConcurrencySubscriptions.orgId, [...scope.orgIds])
            : undefined,
          inArray(orgConcurrencySubscriptions.subscriptionStatus, [
            ...CONCURRENCY_SUBSCRIPTION_PAYMENT_FAILED_STATUSES,
          ]),
          or(
            isNull(orgConcurrencySubscriptions.currentPeriodEnd),
            lte(orgConcurrencySubscriptions.currentPeriodEnd, staleBefore),
          ),
        ),
      ),
    db
      .select({
        orgId: orgUsageAllowanceEntitlements.orgId,
        stripeSubscriptionId:
          orgUsageAllowanceEntitlements.stripeSubscriptionId,
      })
      .from(orgUsageAllowanceEntitlements)
      .where(
        and(
          scope
            ? inArray(orgUsageAllowanceEntitlements.orgId, [...scope.orgIds])
            : undefined,
          isNotNull(orgUsageAllowanceEntitlements.stripeSubscriptionId),
          inArray(orgUsageAllowanceEntitlements.status, [
            ...USAGE_ALLOWANCE_RECONCILE_STATUSES,
          ]),
          isNotNull(orgUsageAllowanceEntitlements.expiresAt),
          lte(orgUsageAllowanceEntitlements.expiresAt, now),
        ),
      ),
  ]);

  return {
    candidates,
    atomGrantCandidates,
    concurrencyCandidates,
    usageAllowanceCandidates,
  };
}

async function reconcileCandidateRows(
  context: ReconcileBillingContext,
  rows: ReconcileCandidateRows,
  signal: AbortSignal,
): Promise<ReconciledCandidateRows> {
  const downgraded: DowngradedSubscription[] = [];
  const expiredConcurrency: ExpiredConcurrencySubscription[] = [];
  const reconciledUsageAllowances: ReconciledUsageAllowance[] = [];

  for (const candidate of rows.candidates) {
    const result = await settle(
      reconcileBillingCandidate(context, candidate, signal),
      signal,
    );
    if (!result.ok) {
      L.warn("billing plan candidate reconciliation failed", {
        orgId: candidate.orgId,
        subscriptionId: candidate.stripeSubscriptionId,
        error: result.error,
      });
      continue;
    }
    downgraded.push(...result.value);
  }
  for (const candidate of rows.atomGrantCandidates) {
    const result = await settle(
      reconcileAtomGrantCandidate(context, candidate, signal),
      signal,
    );
    if (!result.ok) {
      L.warn("Atom grant candidate reconciliation failed", {
        orgId: candidate.orgId,
        error: result.error,
      });
      continue;
    }
    downgraded.push(...result.value);
  }
  for (const candidate of rows.concurrencyCandidates) {
    const result = await settle(
      reconcileConcurrencyCandidate(context, candidate, signal),
      signal,
    );
    if (!result.ok) {
      L.warn("concurrency candidate reconciliation failed", {
        orgId: candidate.orgId,
        subscriptionId: candidate.stripeSubscriptionId,
        error: result.error,
      });
      continue;
    }
    expiredConcurrency.push(...result.value);
  }
  for (const candidate of rows.usageAllowanceCandidates) {
    if (!candidate.stripeSubscriptionId) {
      L.warn("usage allowance candidate has no Stripe subscription", {
        orgId: candidate.orgId,
      });
      continue;
    }
    const result = await settle(
      reconcileUsageAllowanceCandidate(
        context,
        {
          orgId: candidate.orgId,
          stripeSubscriptionId: candidate.stripeSubscriptionId,
        },
        signal,
      ),
      signal,
    );
    if (!result.ok) {
      L.warn("usage allowance candidate reconciliation failed", {
        orgId: candidate.orgId,
        subscriptionId: candidate.stripeSubscriptionId,
        error: result.error,
      });
      continue;
    }
    reconciledUsageAllowances.push(...result.value);
  }

  return { downgraded, expiredConcurrency, reconciledUsageAllowances };
}

const reconcileBillingEntitlementsForScope$ = command(
  async (
    { get, set },
    scope: BillingReconciliationScope | undefined,
    signal: AbortSignal,
  ): Promise<{ readonly downgraded: number }> => {
    const db = set(writeDb$);
    const stripe = getStripeClient();
    const now = nowDate();
    const staleBefore = new Date(
      now.getTime() - PAYMENT_FAILURE_DOWNGRADE_GRACE_MS,
    );

    if (!scope) {
      const checkoutReplay = await settle(
        set(reconcileUndeliveredStripePaidCheckoutSessions$, signal),
        signal,
      );
      if (!checkoutReplay.ok) {
        L.warn("undelivered Stripe paid Checkout sweep failed", {
          error: checkoutReplay.error,
        });
      }
      signal.throwIfAborted();

      const replay = await settle(
        set(reconcileUndeliveredStripePaidInvoices$, signal),
        signal,
      );
      if (!replay.ok) {
        L.warn("undelivered Stripe paid invoice sweep failed", {
          error: replay.error,
        });
      }
    }
    signal.throwIfAborted();

    const usagePackMigrationReconciliation =
      await reconcileUsagePackSubscriptionMigrations(db, scope, signal);
    signal.throwIfAborted();
    await reconcileUsagePackSubscriptions(db, scope, signal);
    signal.throwIfAborted();
    await reconcileUsagePackCreditRefunds(db, scope, signal);
    signal.throwIfAborted();
    const clerk = get(clerk$);
    const invitationPurchasesReconciled =
      await reconcileUsagePackInvitationPurchases(db, clerk, scope, signal);
    signal.throwIfAborted();
    const stripeSubscriptionSweep = await reconcileStripeSubscriptionSnapshots(
      db,
      stripe,
      clerk,
      scope,
      signal,
    );
    signal.throwIfAborted();

    const candidateRows = await loadReconcileCandidateRows(
      db,
      now,
      staleBefore,
      scope,
    );
    signal.throwIfAborted();

    const reconciledCandidates = await reconcileCandidateRows(
      { db, stripe, now, staleBefore },
      candidateRows,
      signal,
    );
    const downgraded = [
      ...stripeSubscriptionSweep.downgraded,
      ...reconciledCandidates.downgraded,
    ];
    const { expiredConcurrency, reconciledUsageAllowances } =
      reconciledCandidates;

    await disableIneligibleWorkflowWebhooksForOrgs(
      db,
      new Set(
        downgraded.map((subscription) => {
          return subscription.orgId;
        }),
      ),
      signal,
    );

    if (expiredConcurrency.length > 0) {
      L.warn("stale payment-failed concurrency subscriptions expired", {
        count: expiredConcurrency.length,
        subscriptionIds: expiredConcurrency.slice(0, 10).map((row) => {
          return row.subscriptionId;
        }),
      });
    }
    if (reconciledUsageAllowances.length > 0) {
      L.warn("expired usage allowances reconciled from Stripe", {
        count: reconciledUsageAllowances.length,
        subscriptionIds: reconciledUsageAllowances.slice(0, 10).map((row) => {
          return row.subscriptionId;
        }),
      });
    }
    logUsagePackMigrationReconciliation(usagePackMigrationReconciliation);
    if (invitationPurchasesReconciled > 0) {
      L.warn("usage pack invitation purchases reconciled", {
        count: invitationPurchasesReconciled,
      });
    }
    return { downgraded: downgraded.length };
  },
);

export const reconcileBillingEntitlements$ = command(
  async ({ set }, signal: AbortSignal) => {
    return await set(reconcileBillingEntitlementsForScope$, undefined, signal);
  },
);

export const reconcileBillingEntitlementsForOrganizations$ = command(
  async ({ set }, orgIds: readonly string[], signal: AbortSignal) => {
    return await set(reconcileBillingEntitlementsForScope$, { orgIds }, signal);
  },
);
