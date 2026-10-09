import { expireOrgCreditsAt$ } from "./org-credit-expiration.service";
import { cancelEmptyUsagePackSubscription$ } from "./billing-downgrade.service";
import { isOrgTier, type OrgTier } from "@okouai/api-contracts/contracts/orgs";
import { orgConcurrencySubscriptions } from "@okouai/db/schema/org-concurrency-subscription";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { usagePackSubscriptions } from "@okouai/db/schema/usage-pack-subscription";
import { command } from "ccstate";
import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

import { pgTextDecoder } from "../../lib/db-structured-result";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
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
  tierForKnownPlanPrice,
} from "./billing-checkout.service";
import {
  reconcileUsagePackSubscriptions$,
  stripeSubscriptionUsesMemberUsagePacks,
} from "./usage-pack-subscription.service";
import { reconcileUsagePackCreditRefunds } from "./usage-pack-credit-refund.service";
import { reconcileUsagePackInvitationPurchases$ } from "./usage-pack-invitation-purchase.service";
import { syncUsagePackSubscriptionConfigurations$ } from "./usage-pack-allocation-change.service";
import { reconcileUsagePackSubscriptionMigrations$ } from "./usage-pack-subscription-migration.service";
import { disableIneligibleWorkflowWebhookAutomationsForOrg } from "./workflow-webhook-automation-entitlement.service";
import { isCurrentStripePreviewMetadata } from "./stripe-preview-metadata.service";
import {
  reconcileMissingStripeSubscription,
  reconcilePaidStripeCheckoutSession$,
  reconcilePaidStripeInvoice$,
  reconcileStripeSubscriptionSnapshot$,
  type StripeSubscriptionSnapshotReconciliation,
} from "./webhooks-stripe.service";
import type { Tx } from "../../lib/db-types";
import { concurrencySubscriptionUpdatedAt } from "./concurrency-subscription-write";
import {
  archivedSubscriptionHasSurvivingComponents,
  archivedSubscriptionHasSurvivingPlan,
} from "./archived-allowance";

const L = logger("CronBillingEntitlements");
const PAID_TIERS = ["pro", "team", "custom"] as const;
const ENTITLEMENT_PERIOD_REFRESH_STATUSES = ["active", "trialing"] as const;
const PAYMENT_FAILED_SUBSCRIPTION_STATUSES = ["past_due", "unpaid"] as const;
const PAYMENT_FAILURE_DOWNGRADE_GRACE_MS = 24 * 60 * 60 * 1000;
const ATOM_GRANT_SUBSCRIPTION_STATUS = "atom_grant";
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
  readonly cancelAtPeriodEnd: boolean;
  readonly updatedAtText: string;
  readonly rowVersion: string;
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
}

type ReconcileTx = Tx;

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
    archivedSubscriptionHasSurvivingComponents(subscription) &&
    (Boolean(subscription.metadata?.orgId) ||
      knownBillingPlanPriceItem(subscription.items.data) !== undefined)
  );
}

async function listStripeSubscriptionPages(
  stripe: ReturnType<typeof getStripeClient>,
  params: {
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

async function loadKnownStripeSubscriptionIds(
  db: Db,
): Promise<readonly string[]> {
  const [planRows, concurrencyRows, usagePackRows] = await Promise.all([
    db
      .select({ subscriptionId: orgMetadata.stripeSubscriptionId })
      .from(orgMetadata)
      .where(isNotNull(orgMetadata.stripeSubscriptionId)),
    db
      .select({
        subscriptionId: orgConcurrencySubscriptions.stripeSubscriptionId,
        status: orgConcurrencySubscriptions.subscriptionStatus,
      })
      .from(orgConcurrencySubscriptions),
    db
      .select({
        subscriptionId: usagePackSubscriptions.stripeSubscriptionId,
        status: usagePackSubscriptions.subscriptionStatus,
      })
      .from(usagePackSubscriptions)
      .where(
        and(
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
      ...usagePackRows.flatMap((row) => {
        return row.subscriptionId ? [row.subscriptionId] : [];
      }),
    ]),
  ];
}

async function discoverStripeSubscriptions(
  db: Db,
  stripe: ReturnType<typeof getStripeClient>,
  signal: AbortSignal,
): Promise<StripeSubscriptionDiscovery> {
  const discovered = new Map<string, StripeSubscription>();
  signal.throwIfAborted();
  const listedSubscriptions = (
    await Promise.all(
      DISCOVERABLE_STRIPE_SUBSCRIPTION_STATUSES.map(async (status) => {
        return await listStripeSubscriptionPages(stripe, { status }, signal);
      }),
    )
  ).flat();
  signal.throwIfAborted();

  for (const subscription of listedSubscriptions) {
    if (
      stripeSubscriptionIsDiscoverable(subscription) &&
      isCurrentStripePreviewMetadata(subscription.metadata) &&
      stripeSubscriptionLooksBillingRelated(subscription)
    ) {
      discovered.set(subscription.id, subscription);
    }
  }

  const knownSubscriptionIds = await loadKnownStripeSubscriptionIds(db);
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

const reconcileStripeSubscriptionSnapshots$ = command(
  async (
    { set },
    signal: AbortSignal,
  ): Promise<StripeSubscriptionSweepResult> => {
    const db = set(writeDb$);
    const stripe = getStripeClient();
    const discovery = await discoverStripeSubscriptions(db, stripe, signal);
    const changedOrgIds = new Set<string>();
    const downgraded: DowngradedSubscription[] = [];
    let paidInvoices = 0;
    let reconciled = 0;
    let failed = discovery.failedSubscriptionIds.length;

    for (const subscription of discovery.subscriptions) {
      const result = await settle(
        set(reconcileStripeSubscriptionSnapshot$, subscription, signal),
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
  },
);

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

function knownOrgTier(value: string): OrgTier {
  if (isOrgTier(value)) {
    return value;
  }
  throw new Error(`Unknown org tier: ${value}`);
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
  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0123; new non-billing transactions are prohibited.
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
  const priceId = planItem?.price.id;
  const tier = planItem
    ? (tierForKnownPlanPrice(planItem.price) ?? undefined)
    : undefined;

  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0124; new non-billing transactions are prohibited.
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
  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0125; new non-billing transactions are prohibited.
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
            knownBillingPlanPriceItem(subscription.items.data)?.price.id ??
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
  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0126; new non-billing transactions are prohibited.
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
            knownBillingPlanPriceItem(subscription.items.data)?.price.id ??
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

  if (!archivedSubscriptionHasSurvivingPlan(subscription)) {
    return [];
  }
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

/** Own each expiration before the legacy plan projection runs. */
const expireAtomGrantCandidates$ = command(
  async (
    { set },
    args: {
      readonly candidates: readonly AtomGrantCandidate[];
      readonly at: Date;
    },
    signal: AbortSignal,
  ) => {
    const ready: AtomGrantCandidate[] = [];
    for (const candidate of args.candidates) {
      const { orgId } = candidate;
      const result = await settle(
        set(expireOrgCreditsAt$, { orgId, at: args.at }, signal),
        signal,
      );
      signal.throwIfAborted();
      if (!result.ok) {
        L.warn("Atom grant candidate expiration failed", {
          orgId,
          error: result.error,
        });
        continue;
      }
      ready.push(candidate);
    }
    return ready;
  },
);

async function reconcileAtomGrantCandidate(
  context: ReconcileBillingContext,
  candidate: AtomGrantCandidate,
  signal: AbortSignal,
): Promise<DowngradedSubscription[]> {
  const { db, now } = context;
  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0127; new non-billing transactions are prohibited.
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
  const subscription = await stripe.subscriptions.retrieve(
    candidate.stripeSubscriptionId,
  );
  signal.throwIfAborted();

  // This candidate is already bound to a genuine live concurrency component.
  const item = concurrencySubscriptionItem(subscription);
  const periodEnd = concurrencySubscriptionPeriodEnd(subscription);
  const slots = concurrencySubscriptionSlots(subscription);
  const isPaymentFailed = subscriptionIsPaymentFailed(subscription);
  const syncedFields = {
    subscriptionStatus: subscription.status,
    cancelAtPeriodEnd:
      (subscription.cancel_at_period_end &&
        knownBillingPlanPriceItem(subscription.items.data) === undefined) ||
      (candidate.cancelAtPeriodEnd &&
        subscription.schedule !== null &&
        subscription.schedule !== undefined),
    updatedAt: concurrencySubscriptionUpdatedAt(now),
    ...(periodEnd ? { currentPeriodEnd: periodEnd } : {}),
    ...(item ? { stripePriceId: item.price.id } : {}),
    ...(slots ? { slots } : {}),
  };
  const currentCandidate = and(
    eq(
      orgConcurrencySubscriptions.stripeSubscriptionId,
      candidate.stripeSubscriptionId,
    ),
    eq(
      orgConcurrencySubscriptions.updatedAt,
      sql`${candidate.updatedAtText}::timestamp`,
    ),
    sql`${orgConcurrencySubscriptions}.xmin::text = ${candidate.rowVersion}`,
  );

  if (subscription.status === "canceled") {
    const rows = await db
      .update(orgConcurrencySubscriptions)
      .set({
        subscriptionStatus: "canceled",
        cancelAtPeriodEnd: false,
        currentPeriodEnd: now,
        updatedAt: concurrencySubscriptionUpdatedAt(now),
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

async function loadReconcileCandidateRows(
  db: Db,
  now: Date,
  staleBefore: Date,
): Promise<ReconcileCandidateRows> {
  const [candidates, atomGrantCandidates, concurrencyCandidates] =
    await Promise.all([
      db
        .select({
          orgId: orgMetadata.orgId,
          stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
        })
        .from(orgMetadata)
        .where(
          and(
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
          stripeSubscriptionId:
            orgConcurrencySubscriptions.stripeSubscriptionId,
          cancelAtPeriodEnd: orgConcurrencySubscriptions.cancelAtPeriodEnd,
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
          and(
            or(
              and(
                inArray(orgConcurrencySubscriptions.subscriptionStatus, [
                  ...CONCURRENCY_SUBSCRIPTION_PAYMENT_FAILED_STATUSES,
                ]),
                or(
                  isNull(orgConcurrencySubscriptions.currentPeriodEnd),
                  lte(
                    orgConcurrencySubscriptions.currentPeriodEnd,
                    staleBefore,
                  ),
                ),
              ),
              and(
                inArray(orgConcurrencySubscriptions.subscriptionStatus, [
                  "active",
                  "trialing",
                  ...CONCURRENCY_SUBSCRIPTION_PAYMENT_FAILED_STATUSES,
                ]),
                // Provider observations can arrive out of order during overlap
                // with old webhook writers. Repair each live identity daily;
                // this never creates an invoice, payment or credit grant.
                sql`(hashtext(${orgConcurrencySubscriptions.stripeSubscriptionId}) & 2147483647) % 24 = ${now.getUTCHours()}`,
              ),
            ),
          ),
        ),
    ]);

  return {
    candidates,
    atomGrantCandidates,
    concurrencyCandidates,
  };
}

async function reconcileCandidateRows(
  context: ReconcileBillingContext,
  rows: ReconcileCandidateRows,
  signal: AbortSignal,
): Promise<ReconciledCandidateRows> {
  const downgraded: DowngradedSubscription[] = [];
  const expiredConcurrency: ExpiredConcurrencySubscription[] = [];

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
  return { downgraded, expiredConcurrency };
}

/**
 * Invitation recovery first commits accepted local allocations; the daily
 * configuration sweep then converges Stripe from those records by identity.
 */
const reconcileUsagePackInvitationsAndConfiguration$ = command(
  async ({ set }, signal: AbortSignal): Promise<number> => {
    const invitations = await set(
      reconcileUsagePackInvitationPurchases$,
      signal,
    );
    signal.throwIfAborted();
    const configuration = await settle(
      set(syncUsagePackSubscriptionConfigurations$, signal),
      signal,
    );
    if (!configuration.ok) {
      L.warn("usage pack Stripe configuration sweep failed", {
        error: configuration.error,
      });
    } else if (
      configuration.value.updated > 0 ||
      configuration.value.failed > 0
    ) {
      L.warn("usage pack Stripe configuration reconciled", configuration.value);
    }
    return invitations;
  },
);

export const reconcileBillingEntitlements$ = command(
  async (
    { set },
    signal: AbortSignal,
  ): Promise<{ readonly downgraded: number }> => {
    const db = set(writeDb$);
    const stripe = getStripeClient();
    const now = nowDate();
    const staleBefore = new Date(
      now.getTime() - PAYMENT_FAILURE_DOWNGRADE_GRACE_MS,
    );

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
    signal.throwIfAborted();

    const usagePackMigrationReconciliation = await set(
      reconcileUsagePackSubscriptionMigrations$,
      signal,
    );
    signal.throwIfAborted();
    const usagePackReconciliation = await set(
      reconcileUsagePackSubscriptions$,
      signal,
    );
    signal.throwIfAborted();
    for (const cancellation of usagePackReconciliation.emptyCancellations) {
      const canceled = await settle(
        set(cancelEmptyUsagePackSubscription$, cancellation, signal),
        signal,
      );
      signal.throwIfAborted();
      if (!canceled.ok) {
        L.error("empty usage pack cancellation reconciliation failed", {
          usagePackSubscriptionId: cancellation.usagePackSubscriptionId,
          error: canceled.error,
        });
      }
    }
    await reconcileUsagePackCreditRefunds(db, signal);
    signal.throwIfAborted();

    const invitationPurchasesReconciled = await set(
      reconcileUsagePackInvitationsAndConfiguration$,
      signal,
    );
    const stripeSubscriptionSweep = await set(
      reconcileStripeSubscriptionSnapshots$,
      signal,
    );
    signal.throwIfAborted();

    const candidateRows = await loadReconcileCandidateRows(
      db,
      now,
      staleBefore,
    );
    signal.throwIfAborted();

    const atomGrantCandidates = await set(
      expireAtomGrantCandidates$,
      { candidates: candidateRows.atomGrantCandidates, at: now },
      signal,
    );
    const reconciledCandidates = await reconcileCandidateRows(
      { db, stripe, now, staleBefore },
      { ...candidateRows, atomGrantCandidates },
      signal,
    );
    const downgraded = [
      ...stripeSubscriptionSweep.downgraded,
      ...reconciledCandidates.downgraded,
    ];
    const { expiredConcurrency } = reconciledCandidates;

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
    logUsagePackMigrationReconciliation(usagePackMigrationReconciliation);
    if (invitationPurchasesReconciled > 0) {
      L.warn("usage pack invitation purchases reconciled", {
        count: invitationPurchasesReconciled,
      });
    }
    return { downgraded: downgraded.length };
  },
);
