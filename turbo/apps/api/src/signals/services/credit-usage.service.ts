import { command } from "ccstate";
import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import { usagePricing } from "@okouai/db/schema/usage-pricing";
import { and, asc, eq, gt, lte, sql } from "drizzle-orm";

import { writeDb$ } from "../external/db";
import { nowDate } from "../../lib/time";
import { logger } from "../../lib/log";
import { usageUnderbillingFields } from "../usage-underbilling";
import { tapError } from "../utils";
import {
  resolveUsagePricingProvider,
  usagePricingResolution$,
  type UsagePricingResolution,
} from "../context/usage-pricing-resolution";
import { maybeEmitRunUsageEvent$ } from "./chat-usage-event.service";
import {
  enqueueCreditLowBalanceAlert$,
  LOW_CREDIT_EMAIL_ALERT_THRESHOLD_CREDITS,
  type CreditLowBalanceAlertArgs,
} from "./credit-low-balance-alert.service";
import { triggerAutoRecharge$ } from "./credit-recharge.service";
import {
  applyUsageAllowanceToUsageEventsInLockedTransaction,
  lockOrgCredits,
} from "./usage-allowance.service";
import type { Tx } from "../../lib/db-types";
import { writeOrgMetadataWithDefaultPlanEntitlement } from "./org-plan-entitlements.service";
import { lockUsageEventCompaction } from "./usage-event-compaction-lock.service";

const L = logger("CreditUsage");

type WriteTx = Tx;

async function deductOrgCredits(
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
          credits: -amount,
          createdAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .onConflictDoUpdate({
          target: orgMetadataCanonicalWrites.orgId,
          set: {
            credits: sql`${orgMetadata.credits} - ${amount}`,
            updatedAt: sql`now()`,
          },
        })
        .returning({ orgId: orgMetadata.orgId, tier: orgMetadata.tier });
    },
  );
}

async function getOrgCredits(tx: WriteTx, orgId: string): Promise<number> {
  const [metadata] = await tx
    .select({ credits: orgMetadata.credits })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  return metadata?.credits ?? 0;
}

async function expireCredits(
  tx: WriteTx,
  orgId: string,
  at: Date,
): Promise<number> {
  const expired = await tx
    .select({
      id: creditExpiresRecord.id,
      remaining: creditExpiresRecord.remaining,
    })
    .from(creditExpiresRecord)
    .where(
      and(
        eq(creditExpiresRecord.orgId, orgId),
        lte(creditExpiresRecord.expiresAt, at),
        gt(creditExpiresRecord.remaining, 0),
      ),
    )
    .for("update");

  if (expired.length === 0) {
    return 0;
  }

  let totalExpired = 0;
  for (const record of expired) {
    totalExpired += record.remaining;
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

async function deductFromExpiresRecords(
  tx: WriteTx,
  orgId: string,
  amount: number,
  at: Date,
): Promise<void> {
  if (amount <= 0) {
    return;
  }

  const records = await tx
    .select({
      id: creditExpiresRecord.id,
      remaining: creditExpiresRecord.remaining,
    })
    .from(creditExpiresRecord)
    .where(
      and(
        eq(creditExpiresRecord.orgId, orgId),
        gt(creditExpiresRecord.remaining, 0),
        gt(creditExpiresRecord.expiresAt, at),
      ),
    )
    .orderBy(asc(creditExpiresRecord.expiresAt))
    .for("update");

  let left = amount;
  for (const record of records) {
    if (left <= 0) {
      break;
    }
    const deduct = Math.min(left, record.remaining);
    await tx
      .update(creditExpiresRecord)
      .set({ remaining: record.remaining - deduct })
      .where(eq(creditExpiresRecord.id, record.id));
    left -= deduct;
  }
  // If left > 0, the excess comes from non-expiring credits — that's fine.
}

async function deductFromUsagePackCredits(
  tx: WriteTx,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly amount: number;
    readonly at: Date;
  },
): Promise<number> {
  if (args.amount <= 0) {
    return 0;
  }

  const grants = await tx
    .select({
      id: usagePackCreditGrants.id,
      remainingAmount: usagePackCreditGrants.remainingAmount,
    })
    .from(usagePackCreditGrants)
    .where(
      and(
        eq(usagePackCreditGrants.orgId, args.orgId),
        eq(usagePackCreditGrants.userId, args.userId),
        gt(usagePackCreditGrants.remainingAmount, 0),
        gt(usagePackCreditGrants.expiresAt, args.at),
      ),
    )
    .orderBy(
      sql`CASE ${usagePackCreditGrants.grantType} WHEN 'purchased' THEN 0 ELSE 1 END`,
      asc(usagePackCreditGrants.expiresAt),
      asc(usagePackCreditGrants.id),
    )
    .for("update");

  let remainingCharge = args.amount;
  for (const grant of grants) {
    if (remainingCharge <= 0) {
      break;
    }
    const deduction = Math.min(remainingCharge, grant.remainingAmount);
    await tx
      .update(usagePackCreditGrants)
      .set({ remainingAmount: grant.remainingAmount - deduction })
      .where(eq(usagePackCreditGrants.id, grant.id));
    remainingCharge -= deduction;
  }
  return remainingCharge;
}

interface ProcessOrgUsageEventsResult {
  readonly sharedCreditsCharged: number;
  readonly runIds: readonly string[];
  readonly lowBalanceAlert: CreditLowBalanceAlertArgs | null;
}

interface UsageEventRecord {
  readonly id: string;
  readonly runId: string | null;
  readonly idempotencyKey: string;
  readonly userId: string;
  readonly kind: string;
  readonly provider: string;
  readonly category: string;
  readonly quantity: number;
  readonly createdAt: Date;
}
type UsagePricingRecord = typeof usagePricing.$inferSelect;
type UsageEventBillingError = "missing_pricing" | "fallback_pricing" | null;

interface PricedUsageEvent {
  readonly record: UsageEventRecord;
  readonly grossCredits: number;
  readonly billingError: UsageEventBillingError;
}

function priceUsageEvents(
  records: readonly UsageEventRecord[],
  pricingRecords: readonly UsagePricingRecord[],
  orgId: string,
  pricingResolution: UsagePricingResolution,
): PricedUsageEvent[] {
  const pricingByKey = new Map(
    pricingRecords.map((pricing) => {
      return [
        `${pricing.kind}|${pricing.provider}|${pricing.category}`,
        pricing,
      ];
    }),
  );
  const pricedEvents: PricedUsageEvent[] = [];
  for (const record of records) {
    const lookupProvider = resolveUsagePricingProvider(
      pricingResolution,
      record.kind,
      record.provider,
    );
    const exactPricing = pricingByKey.get(
      `${record.kind}|${lookupProvider}|${record.category}`,
    );
    const pricing =
      exactPricing ??
      pricingByKey.get(`${record.kind}|${lookupProvider}|__fallback__`);

    if (!pricing) {
      L.error("Missing usage_pricing — charged zero", {
        ...usageUnderbillingFields("missing_pricing", "confirmed"),
        orgId,
        runId: record.runId,
        idempotencyKey: record.idempotencyKey,
        userId: record.userId,
        kind: record.kind,
        provider: record.provider,
        category: record.category,
        quantity: record.quantity,
      });
      pricedEvents.push({
        record,
        grossCredits: 0,
        billingError: "missing_pricing",
      });
      continue;
    }

    if (!exactPricing) {
      L.error("Missing usage_pricing — billed at fallback rate", {
        ...usageUnderbillingFields("fallback_pricing", "confirmed"),
        orgId,
        runId: record.runId,
        idempotencyKey: record.idempotencyKey,
        userId: record.userId,
        kind: record.kind,
        provider: record.provider,
        category: record.category,
        quantity: record.quantity,
        fallbackUnitPrice: pricing.unitPrice,
      });
    }

    pricedEvents.push({
      record,
      grossCredits: Math.ceil(
        (record.quantity * pricing.unitPrice) / pricing.unitSize,
      ),
      billingError: exactPricing ? null : "fallback_pricing",
    });
  }
  return pricedEvents;
}

interface UsageEventSettlementOutcome {
  readonly usageEventId: string;
  readonly creditsCharged: number;
  readonly billingError: UsageEventBillingError;
}

async function markUsageEventsProcessed(
  tx: WriteTx,
  outcomes: readonly UsageEventSettlementOutcome[],
): Promise<void> {
  if (outcomes.length === 0) {
    return;
  }

  const usageEventIds = outcomes.map((outcome) => {
    return outcome.usageEventId;
  });
  const creditsCharged = outcomes.map((outcome) => {
    return outcome.creditsCharged;
  });
  const billingErrors = outcomes.map((outcome) => {
    return outcome.billingError;
  });
  const settlementSource = sql`
    unnest(
      ${sql.param(usageEventIds)}::uuid[],
      ${sql.param(creditsCharged)}::bigint[],
      ${sql.param(billingErrors)}::varchar(50)[]
    ) AS settlement(usage_event_id, credits_charged, billing_error)
  `;
  await tx
    .update(usageEvent)
    .set({
      creditsCharged: sql`settlement.credits_charged`,
      status: "processed",
      processedAt: nowDate(),
      billingError: sql`settlement.billing_error`,
    })
    .from(settlementSource)
    .where(eq(usageEvent.id, sql`settlement.usage_event_id`));
}

async function processOrgUsageEventsInTransaction(
  tx: WriteTx,
  orgId: string,
  pricingResolution: UsagePricingResolution,
  signal: AbortSignal,
): Promise<ProcessOrgUsageEventsResult> {
  // Maintenance must drain settlement before taking ledger or Run locks.
  // Share this admission across orgs, and take it before the credit lock.
  await lockUsageEventCompaction(tx, "shared");
  await lockOrgCredits(tx, orgId);

  const pendingRecords = await tx
    .select({
      id: usageEvent.id,
      runId: usageEvent.runId,
      idempotencyKey: usageEvent.idempotencyKey,
      userId: usageEvent.userId,
      kind: usageEvent.kind,
      provider: usageEvent.provider,
      category: usageEvent.category,
      quantity: usageEvent.quantity,
      createdAt: usageEvent.createdAt,
    })
    .from(usageEvent)
    .where(and(eq(usageEvent.orgId, orgId), eq(usageEvent.status, "pending")));

  if (pendingRecords.length === 0) {
    return {
      sharedCreditsCharged: 0,
      runIds: [],
      lowBalanceAlert: null,
    };
  }
  const runIds = [
    ...new Set(
      pendingRecords.flatMap((record) => {
        return record.runId ? [record.runId] : [];
      }),
    ),
  ];

  const pricingRecords = await tx.select().from(usagePricing);
  const pricedEvents = priceUsageEvents(
    pendingRecords,
    pricingRecords,
    orgId,
    pricingResolution,
  );

  const allowanceByUsageEvent =
    await applyUsageAllowanceToUsageEventsInLockedTransaction(tx, {
      orgId,
      events: pricedEvents.map((event) => {
        return {
          usageEventId: event.record.id,
          runId: event.record.runId,
          grossUnits: event.grossCredits,
          occurredAt: event.record.createdAt,
        };
      }),
    });
  const billableCreditsByUser = new Map<string, number>();
  const settlementOutcomes = pricedEvents.map((event) => {
    const allowanceUnits = allowanceByUsageEvent.get(event.record.id) ?? 0;
    const creditsCharged = event.grossCredits - allowanceUnits;
    billableCreditsByUser.set(
      event.record.userId,
      (billableCreditsByUser.get(event.record.userId) ?? 0) + creditsCharged,
    );
    return {
      usageEventId: event.record.id,
      creditsCharged,
      billingError: event.billingError,
    };
  });
  await markUsageEventsProcessed(tx, settlementOutcomes);
  signal.throwIfAborted();

  const settlementTime = nowDate();
  let sharedCreditsCharged = 0;
  const memberCharges = [...billableCreditsByUser.entries()].sort(
    ([leftUserId], [rightUserId]) => {
      return leftUserId.localeCompare(rightUserId);
    },
  );
  for (const [userId, amount] of memberCharges) {
    sharedCreditsCharged += await deductFromUsagePackCredits(tx, {
      orgId,
      userId,
      amount,
      at: settlementTime,
    });
  }
  signal.throwIfAborted();

  let lowBalanceAlert: CreditLowBalanceAlertArgs | null = null;
  if (sharedCreditsCharged > 0) {
    // Order matters: settle expired credits BEFORE the new deduction.
    const beforeCredits = await getOrgCredits(tx, orgId);
    const totalExpired = await expireCredits(tx, orgId, settlementTime);
    const effectiveBeforeCredits = Math.max(beforeCredits - totalExpired, 0);
    await deductOrgCredits(tx, orgId, sharedCreditsCharged);
    const afterCredits = await getOrgCredits(tx, orgId);
    await deductFromExpiresRecords(
      tx,
      orgId,
      sharedCreditsCharged,
      settlementTime,
    );
    if (
      effectiveBeforeCredits > LOW_CREDIT_EMAIL_ALERT_THRESHOLD_CREDITS &&
      afterCredits <= LOW_CREDIT_EMAIL_ALERT_THRESHOLD_CREDITS
    ) {
      lowBalanceAlert = {
        orgId,
        remainingCredits: afterCredits,
        thresholdCredits: LOW_CREDIT_EMAIL_ALERT_THRESHOLD_CREDITS,
      };
    }
  }
  signal.throwIfAborted();
  return { sharedCreditsCharged, runIds, lowBalanceAlert };
}

/**
 * Atomically process pending usage_event records for an org. Allowance is
 * applied first, then each member's usage pack grants, then shared org credits.
 *
 * Mirrors apps/web's `processOrgUsageEvents`. The transactional invariant
 * is critical: events are marked processed IFF every applicable credit
 * deduction succeeds. If any helper throws, the whole transaction rolls back.
 *
 * Acquires `pg_advisory_xact_lock(hashtext('credit_' || orgId))` —
 * verbatim same key string as web so api and web serialize correctly on
 * the same org during rollout.
 *
 * After the transaction commits and credits are deducted, runs post-billing
 * side effects outside the credit transaction:
 * - `triggerAutoRecharge$` for Stripe top-up when the balance crosses the
 *   recharge threshold.
 * - `enqueueCreditLowBalanceAlert$` when usage crosses the low-credit email
 *   threshold.
 *
 * Both side effects are bounded by the route handler's outer waitUntil
 * envelope. Low-balance alert failures are logged without affecting billing.
 */
export const processOrgUsageEvents$ = command(
  async ({ get, set }, orgId: string, signal: AbortSignal): Promise<void> => {
    const writeDb = set(writeDb$);
    const pricingResolution = get(usagePricingResolution$);

    const { sharedCreditsCharged, runIds, lowBalanceAlert } =
      await writeDb.transaction((tx) => {
        return processOrgUsageEventsInTransaction(
          tx,
          orgId,
          pricingResolution,
          signal,
        );
      });
    signal.throwIfAborted();

    if (sharedCreditsCharged > 0) {
      // Auto-recharge runs OUTSIDE the deduction transaction (Stripe
      // can't be transactional with DB). triggerAutoRecharge$ catches
      // its own errors (clearPendingFlag in catch); the await here is
      // bounded by the route handler's outer waitUntil envelope.
      await set(triggerAutoRecharge$, orgId, signal);
      signal.throwIfAborted();
    }

    if (lowBalanceAlert) {
      await tapError(
        set(enqueueCreditLowBalanceAlert$, lowBalanceAlert, signal),
        (error) => {
          L.error("Failed to enqueue low-credit alert after usage processing", {
            orgId,
            error,
          });
        },
      );
      signal.throwIfAborted();
    }

    for (const runId of runIds) {
      await tapError(set(maybeEmitRunUsageEvent$, runId, signal), (error) => {
        L.error("Failed to emit chat usage message after usage processing", {
          orgId,
          runId,
          error,
        });
      });
      signal.throwIfAborted();
    }
  },
);
