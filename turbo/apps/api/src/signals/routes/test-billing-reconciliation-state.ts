import {
  BILLING_RECONCILIATION_FIXTURE_KINDS,
  testBillingReconciliationStateContract,
  type BillingReconciliationFixtureKind,
  type TestBillingReconciliationStateActionBody,
  type TestBillingReconciliationStateActionResponse,
} from "@okouai/api-contracts/contracts/test-billing-reconciliation-state";
import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgConcurrencySubscriptions } from "@okouai/db/schema/org-concurrency-subscription";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { orgUsageAllowanceEntitlements } from "@okouai/db/schema/org-usage-allowance";
import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import { usagePackCreditRefunds } from "@okouai/db/schema/usage-pack-credit-refund";
import {
  usagePackAllocations,
  usagePackAllocationChanges,
  usagePackInvitationPurchases,
  usagePackSubscriptionChanges,
  usagePackSubscriptionMigrations,
  usagePackSubscriptions,
} from "@okouai/db/schema/usage-pack-subscription";
import { command } from "ccstate";
import { and, inArray, isNotNull } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { nowDate } from "../../lib/time";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  reconcileBillingEntitlementsForOrganizations$,
  reconcileUndeliveredStripePaidCheckoutSessions$,
  reconcileUndeliveredStripePaidInvoices$,
} from "../services/cron-billing-entitlements.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";
import { ensureOrgMetadataPlanEntitlement } from "../services/org-plan-entitlements.service";

const DAY_MS = 24 * 60 * 60 * 1000;

const actionBody$ = bodyResultOf(testBillingReconciliationStateContract.action);
const reconcileBody$ = bodyResultOf(
  testBillingReconciliationStateContract.reconcile,
);

interface FixtureReference {
  readonly kind: BillingReconciliationFixtureKind;
  readonly orgId: string;
  readonly stripeSubscriptionId: string | null;
  readonly stripeCheckoutSessionId: string | null;
  readonly stripePaymentIntentId: string | null;
}

function fixtureReference(
  marker: string,
  kind: BillingReconciliationFixtureKind,
): FixtureReference {
  const orgId = `org_billing_reconciliation_${kind}_${marker}`;
  switch (kind) {
    case "plan-subscription":
    case "concurrency":
    case "usage-allowance": {
      return {
        kind,
        orgId,
        stripeSubscriptionId: `sub_billing_reconciliation_${kind}_${marker}`,
        stripeCheckoutSessionId: null,
        stripePaymentIntentId: null,
      };
    }
    case "usage-pack-subscription": {
      return {
        kind,
        orgId,
        stripeSubscriptionId: `sub_billing_reconciliation_${kind}_${marker}`,
        stripeCheckoutSessionId: `cs_billing_reconciliation_${kind}_${marker}`,
        stripePaymentIntentId: null,
      };
    }
    case "usage-pack-invitation": {
      return {
        kind,
        orgId,
        stripeSubscriptionId: null,
        stripeCheckoutSessionId: `cs_billing_reconciliation_${kind}_${marker}`,
        stripePaymentIntentId: null,
      };
    }
    case "usage-pack-refund": {
      return {
        kind,
        orgId,
        stripeSubscriptionId: null,
        stripeCheckoutSessionId: null,
        stripePaymentIntentId: `pi_billing_reconciliation_${kind}_${marker}`,
      };
    }
    case "atom-grant":
    case "usage-pack-subscription-change":
    case "usage-pack-allocation-change":
    case "usage-pack-migration": {
      return {
        kind,
        orgId,
        stripeSubscriptionId: null,
        stripeCheckoutSessionId: null,
        stripePaymentIntentId: null,
      };
    }
  }
}

function fixtureReferences(marker: string): readonly FixtureReference[] {
  return BILLING_RECONCILIATION_FIXTURE_KINDS.map((kind) => {
    return fixtureReference(marker, kind);
  });
}

function requireFixtureReference(
  fixtures: readonly FixtureReference[],
  kind: BillingReconciliationFixtureKind,
): FixtureReference {
  const fixture = fixtures.find((candidate) => {
    return candidate.kind === kind;
  });
  if (!fixture) {
    throw new Error(`Missing billing reconciliation fixture ${kind}`);
  }
  return fixture;
}

async function insertUsagePackSubscription(
  tx: Tx,
  fixture: FixtureReference,
  values: {
    readonly subscriptionStatus: string;
    readonly stripeCheckoutSessionId?: string | null;
    readonly stripeSubscriptionId?: string | null;
    readonly currentPeriodStart?: Date | null;
    readonly currentPeriodEnd?: Date | null;
    readonly updatedAt: Date;
  },
): Promise<string> {
  const [subscription] = await tx
    .insert(usagePackSubscriptions)
    .values({
      orgId: fixture.orgId,
      tier: "pro",
      stripePlanPriceId: `price_plan_${fixture.kind}`,
      stripeCustomerId: `cus_${fixture.kind}_${fixture.orgId}`,
      subscriptionStatus: values.subscriptionStatus,
      stripeCheckoutSessionId: values.stripeCheckoutSessionId ?? null,
      stripeSubscriptionId: values.stripeSubscriptionId ?? null,
      currentPeriodStart: values.currentPeriodStart ?? null,
      currentPeriodEnd: values.currentPeriodEnd ?? null,
      updatedAt: values.updatedAt,
    })
    .returning({ id: usagePackSubscriptions.id });
  if (!subscription) {
    throw new Error(`Failed to seed ${fixture.kind}`);
  }
  return subscription.id;
}

interface FixtureTimes {
  readonly old: Date;
  readonly older: Date;
  readonly future: Date;
}

type FixtureMode = NonNullable<
  Extract<
    TestBillingReconciliationStateActionBody,
    { readonly action: "seed" }
  >["mode"]
>;

async function insertOrganizationFixtures(
  tx: Tx,
  fixtures: readonly FixtureReference[],
  times: FixtureTimes,
  mode: FixtureMode,
): Promise<void> {
  const metadataRows = await tx
    .insert(orgMetadataCanonicalWrites)
    .values(
      fixtures.map((fixture) => {
        switch (fixture.kind) {
          case "plan-subscription": {
            if (mode === "unbound") {
              return {
                orgId: fixture.orgId,
                tier: "limited-free-1",
                stripeCustomerId: `cus_${fixture.orgId}`,
                subscriptionStatus: "missing",
                updatedAt: times.old,
              };
            }
            return {
              orgId: fixture.orgId,
              tier: "pro",
              stripeSubscriptionId: fixture.stripeSubscriptionId,
              subscriptionStatus: mode === "active" ? "active" : "past_due",
              currentPeriodEnd: mode === "active" ? times.future : times.old,
              updatedAt: times.old,
            };
          }
          case "atom-grant": {
            if (mode === "unbound") {
              return {
                orgId: fixture.orgId,
                tier: "limited-free-1",
                credits: 0,
                stripeCustomerId: `cus_${fixture.orgId}`,
                subscriptionStatus: "missing",
                updatedAt: times.old,
              };
            }
            return {
              orgId: fixture.orgId,
              tier: "team",
              credits: 100,
              subscriptionStatus: "atom_grant",
              currentPeriodEnd: times.old,
              updatedAt: times.old,
            };
          }
          case "concurrency":
          case "usage-allowance":
          case "usage-pack-subscription":
          case "usage-pack-subscription-change":
          case "usage-pack-allocation-change":
          case "usage-pack-refund":
          case "usage-pack-migration":
          case "usage-pack-invitation": {
            return { orgId: fixture.orgId, updatedAt: times.old };
          }
        }
        throw new Error(
          `Unsupported billing reconciliation fixture ${fixture.kind}`,
        );
      }),
    )
    .returning({
      orgId: orgMetadataCanonicalWrites.orgId,
      tier: orgMetadataCanonicalWrites.tier,
    });
  for (const metadata of metadataRows) {
    await ensureOrgMetadataPlanEntitlement(tx, metadata);
  }
}

async function insertCoreBillingFixtures(
  tx: Tx,
  fixtures: readonly FixtureReference[],
  times: FixtureTimes,
  mode: FixtureMode,
): Promise<void> {
  const atomGrant = requireFixtureReference(fixtures, "atom-grant");
  await tx.insert(creditExpiresRecord).values({
    orgId: atomGrant.orgId,
    source: "subscription_renewal",
    amount: 100,
    remaining: 100,
    expiresAt: times.old,
  });

  const concurrency = requireFixtureReference(fixtures, "concurrency");
  if (!concurrency.stripeSubscriptionId) {
    throw new Error("Concurrency fixture requires a subscription ID");
  }
  await tx.insert(orgConcurrencySubscriptions).values({
    orgId: concurrency.orgId,
    stripeSubscriptionId: concurrency.stripeSubscriptionId,
    stripePriceId: "price_billing_reconciliation_concurrency",
    slots: 2,
    subscriptionStatus: mode === "active" ? "active" : "past_due",
    currentPeriodEnd: mode === "active" ? times.future : times.old,
    updatedAt: times.old,
  });

  const usageAllowance = requireFixtureReference(fixtures, "usage-allowance");
  await tx.insert(orgUsageAllowanceEntitlements).values({
    orgId: usageAllowance.orgId,
    source: "stripe_subscription",
    status: mode === "active" ? "active" : "past_due",
    shortWindowSeconds: 3600,
    shortWindowUnits: 1000,
    weeklyWindowUnits: 10_000,
    effectiveAt: times.older,
    expiresAt: mode === "active" ? times.future : times.old,
    stripeSubscriptionId: usageAllowance.stripeSubscriptionId,
    updatedAt: times.old,
  });
}

async function insertUsagePackSubscriptionFixture(
  tx: Tx,
  fixtures: readonly FixtureReference[],
  times: FixtureTimes,
  mode: FixtureMode,
): Promise<void> {
  const fixture = requireFixtureReference(fixtures, "usage-pack-subscription");
  const subscriptionId = await insertUsagePackSubscription(tx, fixture, {
    subscriptionStatus: mode === "active" ? "active" : "checkout_pending",
    stripeCheckoutSessionId:
      mode === "active" ? null : fixture.stripeCheckoutSessionId,
    stripeSubscriptionId:
      mode === "active" ? fixture.stripeSubscriptionId : null,
    currentPeriodStart: mode === "active" ? times.old : null,
    currentPeriodEnd: mode === "active" ? times.future : null,
    updatedAt: times.old,
  });
  if (mode === "active") {
    await tx.insert(usagePackAllocations).values({
      usagePackSubscriptionId: subscriptionId,
      orgId: fixture.orgId,
      userId: `user_${fixture.orgId}`,
      usagePackUsd: 20,
      stripePriceId: `price_usage_pack_${fixture.kind}`,
      status: "active",
      currentPeriodStart: times.old,
      currentPeriodEnd: times.future,
      updatedAt: times.old,
    });
  }
}

async function insertUsagePackSubscriptionChangeFixture(
  tx: Tx,
  fixtures: readonly FixtureReference[],
  times: FixtureTimes,
): Promise<void> {
  const fixture = requireFixtureReference(
    fixtures,
    "usage-pack-subscription-change",
  );
  const parentId = await insertUsagePackSubscription(tx, fixture, {
    subscriptionStatus: "canceled",
    updatedAt: times.old,
  });
  await tx.insert(usagePackSubscriptionChanges).values({
    usagePackSubscriptionId: parentId,
    orgId: fixture.orgId,
    sourceTier: "pro",
    targetTier: "team",
    status: "previewed",
    prorationTimestamp: Math.floor(times.old.getTime() / 1000),
    immediateAmountCents: 0,
    nextRecurringAmountCents: 0,
    currency: "usd",
    previewExpiresAt: times.old,
    effectiveAt: times.future,
    updatedAt: times.old,
  });
}

async function insertUsagePackAllocationChangeFixture(
  tx: Tx,
  fixtures: readonly FixtureReference[],
  times: FixtureTimes,
): Promise<void> {
  const fixture = requireFixtureReference(
    fixtures,
    "usage-pack-allocation-change",
  );
  const parentId = await insertUsagePackSubscription(tx, fixture, {
    subscriptionStatus: "canceled",
    updatedAt: times.old,
  });
  await tx.insert(usagePackAllocationChanges).values({
    usagePackSubscriptionId: parentId,
    orgId: fixture.orgId,
    userId: `user_${fixture.orgId}`,
    kind: "addition",
    status: "previewed",
    targetUsagePackUsd: 20,
    targetStripePriceId: "price_billing_reconciliation_usage_pack_20",
    prorationTimestamp: Math.floor(times.old.getTime() / 1000),
    immediateAmountCents: 0,
    nextRecurringAmountCents: 2000,
    currency: "usd",
    effectiveAt: times.future,
    previewExpiresAt: times.old,
    updatedAt: times.old,
  });
}

async function insertUsagePackRefundFixture(
  tx: Tx,
  fixtures: readonly FixtureReference[],
  marker: string,
  times: FixtureTimes,
): Promise<void> {
  const fixture = requireFixtureReference(fixtures, "usage-pack-refund");
  const [creditGrant] = await tx
    .insert(usagePackCreditGrants)
    .values({
      orgId: fixture.orgId,
      userId: `user_${fixture.orgId}`,
      grantType: "purchased",
      idempotencyKey: `billing-reconciliation-refund-${marker}`,
      originalAmount: 100,
      remainingAmount: 100,
      expiresAt: times.future,
    })
    .returning({ id: usagePackCreditGrants.id });
  if (!creditGrant || !fixture.stripePaymentIntentId) {
    throw new Error("Failed to seed usage pack refund");
  }
  await tx.insert(usagePackCreditRefunds).values({
    creditGrantId: creditGrant.id,
    orgId: fixture.orgId,
    userId: `user_${fixture.orgId}`,
    sourceType: "payment_intent",
    stripePaymentIntentId: fixture.stripePaymentIntentId,
    sourceAmountCents: 100,
    status: "pending",
    refundCredits: 100,
    requestedAmountCents: 100,
    updatedAt: times.old,
  });
}

async function insertUsagePackMigrationFixture(
  tx: Tx,
  fixtures: readonly FixtureReference[],
  times: FixtureTimes,
): Promise<void> {
  const fixture = requireFixtureReference(fixtures, "usage-pack-migration");
  await tx.insert(usagePackSubscriptionMigrations).values({
    orgId: fixture.orgId,
    sourceTier: "pro",
    targetTier: "team",
    stripeCustomerId: `cus_${fixture.orgId}`,
    stripeSubscriptionId: `sub_${fixture.orgId}`,
    legacyStripePriceId: "price_billing_reconciliation_legacy",
    legacyStripeItemId: `si_${fixture.orgId}`,
    stripePlanPriceId: "price_billing_reconciliation_plan_team",
    status: "previewed",
    currentRecurringAmountCents: 1000,
    nextRecurringAmountCents: 2000,
    recurringDifferenceCents: 1000,
    currency: "usd",
    effectiveAt: times.future,
    previewExpiresAt: times.old,
    updatedAt: times.old,
  });
}

async function insertUsagePackInvitationFixture(
  tx: Tx,
  fixtures: readonly FixtureReference[],
  marker: string,
  times: FixtureTimes,
): Promise<void> {
  const fixture = requireFixtureReference(fixtures, "usage-pack-invitation");
  const parentId = await insertUsagePackSubscription(tx, fixture, {
    subscriptionStatus: "canceled",
    updatedAt: times.old,
  });
  await tx.insert(usagePackInvitationPurchases).values({
    usagePackSubscriptionId: parentId,
    orgId: fixture.orgId,
    normalizedEmail: `member-${marker}@example.test`,
    role: "member",
    inviterUserId: `inviter_${marker}`,
    usagePackUsd: 20,
    stripePriceId: "price_billing_reconciliation_usage_pack_20",
    status: "checkout_pending",
    currentPeriodStart: times.older,
    currentPeriodEnd: times.future,
    prorationTimestamp: Math.floor(times.old.getTime() / 1000),
    unitAmountCents: 2000,
    expectedAmountCents: 1000,
    currency: "usd",
    stripeCheckoutSessionId: fixture.stripeCheckoutSessionId,
    stripeCheckoutExpiresAt: times.old,
    updatedAt: times.old,
  });
}

async function insertUsagePackFixtures(
  tx: Tx,
  fixtures: readonly FixtureReference[],
  marker: string,
  times: FixtureTimes,
  mode: FixtureMode,
): Promise<void> {
  await insertUsagePackSubscriptionFixture(tx, fixtures, times, mode);
  await insertUsagePackSubscriptionChangeFixture(tx, fixtures, times);
  await insertUsagePackAllocationChangeFixture(tx, fixtures, times);
  await insertUsagePackRefundFixture(tx, fixtures, marker, times);
  await insertUsagePackMigrationFixture(tx, fixtures, times);
  await insertUsagePackInvitationFixture(tx, fixtures, marker, times);
}

async function seedBillingReconciliationState(
  db: Db,
  marker: string,
  mode: FixtureMode,
  signal: AbortSignal,
): Promise<readonly FixtureReference[]> {
  const fixtures = fixtureReferences(marker);
  const at = nowDate();
  const times = {
    old: new Date(at.getTime() - 2 * DAY_MS),
    older: new Date(at.getTime() - 3 * DAY_MS),
    future: new Date(at.getTime() + 30 * DAY_MS),
  };

  await db.transaction(async (tx) => {
    await insertOrganizationFixtures(tx, fixtures, times, mode);
    await insertCoreBillingFixtures(tx, fixtures, times, mode);
    await insertUsagePackFixtures(tx, fixtures, marker, times, mode);
  });
  signal.throwIfAborted();
  return fixtures;
}

function requireStateRow<T>(
  row: T | undefined,
  kind: BillingReconciliationFixtureKind,
): T {
  if (!row) {
    throw new Error(`Missing billing reconciliation state for ${kind}`);
  }
  return row;
}

async function readBillingReconciliationState(
  db: Db,
  marker: string,
  signal: AbortSignal,
) {
  const fixtures = fixtureReferences(marker);
  const rows = await loadBillingReconciliationStateRows(
    db,
    fixtures.map((fixture) => {
      return fixture.orgId;
    }),
  );
  signal.throwIfAborted();
  return {
    candidates: fixtures.map((fixture) => {
      return candidateStateForFixture(fixture, rows);
    }),
    creditExpirations: rows.creditExpirationRows.flatMap((row) => {
      return row.stripeInvoiceId
        ? [
            {
              stripeInvoiceId: row.stripeInvoiceId,
              expiresAt: row.expiresAt.toISOString(),
            },
          ]
        : [];
    }),
  };
}

async function loadBillingReconciliationStateRows(
  db: Db,
  orgIds: readonly string[],
) {
  const [
    orgRows,
    concurrencyRows,
    usageAllowanceRows,
    usagePackSubscriptionRows,
    subscriptionChangeRows,
    allocationChangeRows,
    refundRows,
    migrationRows,
    invitationRows,
    creditExpirationRows,
  ] = await Promise.all([
    db
      .select({
        orgId: orgMetadata.orgId,
        tier: orgMetadata.tier,
        credits: orgMetadata.credits,
        subscriptionStatus: orgMetadata.subscriptionStatus,
        stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
      })
      .from(orgMetadata)
      .where(inArray(orgMetadata.orgId, orgIds)),
    db
      .select({
        orgId: orgConcurrencySubscriptions.orgId,
        status: orgConcurrencySubscriptions.subscriptionStatus,
        stripeSubscriptionId: orgConcurrencySubscriptions.stripeSubscriptionId,
      })
      .from(orgConcurrencySubscriptions)
      .where(inArray(orgConcurrencySubscriptions.orgId, orgIds)),
    db
      .select({
        orgId: orgUsageAllowanceEntitlements.orgId,
        status: orgUsageAllowanceEntitlements.status,
        stripeSubscriptionId:
          orgUsageAllowanceEntitlements.stripeSubscriptionId,
      })
      .from(orgUsageAllowanceEntitlements)
      .where(inArray(orgUsageAllowanceEntitlements.orgId, orgIds)),
    db
      .select({
        orgId: usagePackSubscriptions.orgId,
        status: usagePackSubscriptions.subscriptionStatus,
        stripeSubscriptionId: usagePackSubscriptions.stripeSubscriptionId,
      })
      .from(usagePackSubscriptions)
      .where(inArray(usagePackSubscriptions.orgId, orgIds)),
    db
      .select({
        orgId: usagePackSubscriptionChanges.orgId,
        status: usagePackSubscriptionChanges.status,
      })
      .from(usagePackSubscriptionChanges)
      .where(inArray(usagePackSubscriptionChanges.orgId, orgIds)),
    db
      .select({
        orgId: usagePackAllocationChanges.orgId,
        status: usagePackAllocationChanges.status,
      })
      .from(usagePackAllocationChanges)
      .where(inArray(usagePackAllocationChanges.orgId, orgIds)),
    db
      .select({
        orgId: usagePackCreditRefunds.orgId,
        status: usagePackCreditRefunds.status,
      })
      .from(usagePackCreditRefunds)
      .where(inArray(usagePackCreditRefunds.orgId, orgIds)),
    db
      .select({
        orgId: usagePackSubscriptionMigrations.orgId,
        status: usagePackSubscriptionMigrations.status,
      })
      .from(usagePackSubscriptionMigrations)
      .where(inArray(usagePackSubscriptionMigrations.orgId, orgIds)),
    db
      .select({
        orgId: usagePackInvitationPurchases.orgId,
        status: usagePackInvitationPurchases.status,
      })
      .from(usagePackInvitationPurchases)
      .where(inArray(usagePackInvitationPurchases.orgId, orgIds)),
    db
      .select({
        stripeInvoiceId: creditExpiresRecord.stripeInvoiceId,
        expiresAt: creditExpiresRecord.expiresAt,
      })
      .from(creditExpiresRecord)
      .where(
        and(
          inArray(creditExpiresRecord.orgId, orgIds),
          isNotNull(creditExpiresRecord.stripeInvoiceId),
        ),
      ),
  ]);
  return {
    orgRows,
    concurrencyRows,
    usageAllowanceRows,
    usagePackSubscriptionRows,
    subscriptionChangeRows,
    allocationChangeRows,
    refundRows,
    migrationRows,
    invitationRows,
    creditExpirationRows,
  };
}

type BillingReconciliationStateRows = Awaited<
  ReturnType<typeof loadBillingReconciliationStateRows>
>;
type CandidateState = Extract<
  TestBillingReconciliationStateActionResponse,
  { readonly action: "read" }
>["candidates"][number];

function stateRowForOrg<T extends { readonly orgId: string }>(
  rows: readonly T[],
  fixture: FixtureReference,
): T {
  return requireStateRow(
    rows.find((candidate) => {
      return candidate.orgId === fixture.orgId;
    }),
    fixture.kind,
  );
}

function simpleCandidateState(
  fixture: FixtureReference,
  status: string,
  stripeSubscriptionId: string | null,
): CandidateState {
  return {
    kind: fixture.kind,
    orgId: fixture.orgId,
    status,
    tier: null,
    credits: null,
    stripeSubscriptionId,
  };
}

function candidateStateForFixture(
  fixture: FixtureReference,
  rows: BillingReconciliationStateRows,
): CandidateState {
  switch (fixture.kind) {
    case "plan-subscription":
    case "atom-grant": {
      const row = stateRowForOrg(rows.orgRows, fixture);
      if (!row.subscriptionStatus) {
        throw new Error(`Missing subscription status for ${fixture.kind}`);
      }
      return {
        kind: fixture.kind,
        orgId: fixture.orgId,
        status: row.subscriptionStatus,
        tier: row.tier,
        credits: row.credits,
        stripeSubscriptionId: row.stripeSubscriptionId,
      };
    }
    case "concurrency": {
      const row = stateRowForOrg(rows.concurrencyRows, fixture);
      if (!row.status) {
        throw new Error(`Missing subscription status for ${fixture.kind}`);
      }
      return simpleCandidateState(
        fixture,
        row.status,
        row.stripeSubscriptionId,
      );
    }
    case "usage-allowance": {
      const row = stateRowForOrg(rows.usageAllowanceRows, fixture);
      return simpleCandidateState(
        fixture,
        row.status,
        row.stripeSubscriptionId,
      );
    }
    case "usage-pack-subscription": {
      const row = stateRowForOrg(rows.usagePackSubscriptionRows, fixture);
      return simpleCandidateState(
        fixture,
        row.status,
        row.stripeSubscriptionId,
      );
    }
    case "usage-pack-subscription-change": {
      const row = stateRowForOrg(rows.subscriptionChangeRows, fixture);
      return simpleCandidateState(fixture, row.status, null);
    }
    case "usage-pack-allocation-change": {
      const row = stateRowForOrg(rows.allocationChangeRows, fixture);
      return simpleCandidateState(fixture, row.status, null);
    }
    case "usage-pack-refund": {
      const row = stateRowForOrg(rows.refundRows, fixture);
      return simpleCandidateState(fixture, row.status, null);
    }
    case "usage-pack-migration": {
      const row = stateRowForOrg(rows.migrationRows, fixture);
      return simpleCandidateState(fixture, row.status, null);
    }
    case "usage-pack-invitation": {
      const row = stateRowForOrg(rows.invitationRows, fixture);
      return simpleCandidateState(fixture, row.status, null);
    }
  }
  throw new Error("Unsupported billing reconciliation fixture");
}

async function cleanupBillingReconciliationState(
  db: Db,
  marker: string,
  signal: AbortSignal,
): Promise<void> {
  const orgIds = fixtureReferences(marker).map((fixture) => {
    return fixture.orgId;
  });
  await db.transaction(async (tx) => {
    await tx
      .delete(usagePackSubscriptionMigrations)
      .where(inArray(usagePackSubscriptionMigrations.orgId, orgIds));
    await tx
      .delete(usagePackSubscriptions)
      .where(inArray(usagePackSubscriptions.orgId, orgIds));
    await tx
      .delete(usagePackCreditGrants)
      .where(inArray(usagePackCreditGrants.orgId, orgIds));
    await tx
      .delete(orgConcurrencySubscriptions)
      .where(inArray(orgConcurrencySubscriptions.orgId, orgIds));
    await tx
      .delete(orgUsageAllowanceEntitlements)
      .where(inArray(orgUsageAllowanceEntitlements.orgId, orgIds));
    await tx
      .delete(creditExpiresRecord)
      .where(inArray(creditExpiresRecord.orgId, orgIds));
    await tx
      .delete(orgPlanEntitlements)
      .where(inArray(orgPlanEntitlements.orgId, orgIds));
    await tx.delete(orgMetadata).where(inArray(orgMetadata.orgId, orgIds));
  });
  signal.throwIfAborted();
}

const mutateTestBillingReconciliationState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(actionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const db = set(writeDb$);
    switch (bodyResult.data.action) {
      case "seed": {
        const fixtures = await seedBillingReconciliationState(
          db,
          bodyResult.data.marker,
          bodyResult.data.mode ?? "stale",
          signal,
        );
        return {
          status: 200 as const,
          body: { action: "seeded" as const, fixtures },
        };
      }
      case "read": {
        const state = await readBillingReconciliationState(
          db,
          bodyResult.data.marker,
          signal,
        );
        return {
          status: 200 as const,
          body: { action: "read" as const, ...state },
        };
      }
      case "cleanup": {
        await cleanupBillingReconciliationState(
          db,
          bodyResult.data.marker,
          signal,
        );
        return {
          status: 200 as const,
          body: { action: "ok" as const },
        };
      }
    }
  },
);

const reconcileTestBillingState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(reconcileBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    if (bodyResult.data.replayUndeliveredPaidCheckouts) {
      await set(reconcileUndeliveredStripePaidCheckoutSessions$, signal);
      signal.throwIfAborted();
    }
    if (bodyResult.data.replayUndeliveredPaidInvoices) {
      await set(reconcileUndeliveredStripePaidInvoices$, signal);
      signal.throwIfAborted();
    }
    const result = await set(
      reconcileBillingEntitlementsForOrganizations$,
      bodyResult.data.orgIds,
      signal,
    );
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: { success: true as const, ...result },
    };
  },
);

export const testBillingReconciliationStateRoutes: readonly RouteEntry[] = [
  {
    route: testBillingReconciliationStateContract.action,
    handler: mutateTestBillingReconciliationState$,
  },
  {
    route: testBillingReconciliationStateContract.reconcile,
    handler: reconcileTestBillingState$,
  },
];
