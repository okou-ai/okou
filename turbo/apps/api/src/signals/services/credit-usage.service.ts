import { command } from "ccstate";
import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import { usagePricing } from "@okouai/db/schema/usage-pricing";
import { and, asc, eq, gt, inArray, lte, sql } from "drizzle-orm";

import { recordBillingOperationTimings } from "../external/sandbox-op-log";
import { writeDb$ } from "../external/db";
import { nowDate } from "../../lib/time";
import { logger } from "../../lib/log";
import { usageUnderbillingFields } from "../usage-underbilling";
import { safeSync, tapError } from "../utils";
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
import { findUsagePricing, usagePricingByKey } from "./built-in-route-pricing";

const L = logger("CreditUsage");

type WriteTx = Tx;

async function deductOrgCredits(
  tx: WriteTx,
  orgId: string,
  amount: number,
): Promise<number> {
  const [debit] = await writeOrgMetadataWithDefaultPlanEntitlement(
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
        .returning({
          orgId: orgMetadata.orgId,
          tier: orgMetadata.tier,
          credits: orgMetadata.credits,
        });
    },
  );
  if (!debit) {
    throw new Error("Organization debit returned no metadata row");
  }
  return debit.credits;
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
): Promise<{ readonly credits: number; readonly rows: number }> {
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
    return { credits: 0, rows: 0 };
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
  return { credits: totalExpired, rows: expired.length };
}

async function deductFromExpiresRecords(
  tx: WriteTx,
  orgId: string,
  amount: number,
  at: Date,
): Promise<number> {
  if (amount <= 0) {
    return 0;
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
  const updates: { readonly id: string; readonly remaining: number }[] = [];
  for (const record of records) {
    if (left <= 0) {
      break;
    }
    const deduct = Math.min(left, record.remaining);
    updates.push({ id: record.id, remaining: record.remaining - deduct });
    left -= deduct;
  }

  const [first, second] = updates;
  if (updates.length === 2 && first && second) {
    // The ordered SELECT already locked both rows; persist the same FEFO results
    // with one statement instead of two round trips.
    await tx
      .update(creditExpiresRecord)
      .set({
        remaining: sql`CASE ${creditExpiresRecord.id}
          WHEN ${first.id} THEN ${first.remaining}::bigint
          WHEN ${second.id} THEN ${second.remaining}::bigint
          ELSE ${creditExpiresRecord.remaining} END`,
      })
      .where(inArray(creditExpiresRecord.id, [first.id, second.id]));
  } else {
    for (const update of updates) {
      await tx
        .update(creditExpiresRecord)
        .set({ remaining: update.remaining })
        .where(eq(creditExpiresRecord.id, update.id));
    }
  }
  // If left > 0, the excess comes from non-expiring credits — that's fine.
  return records.length;
}

async function deductFromUsagePackCredits(
  tx: WriteTx,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly amount: number;
    readonly at: Date;
  },
): Promise<{ readonly sharedCredits: number; readonly grantRows: number }> {
  if (args.amount <= 0) {
    return { sharedCredits: 0, grantRows: 0 };
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
  return { sharedCredits: remainingCharge, grantRows: grants.length };
}

interface SettlementWorkObservation {
  readonly lockWaitMs: number;
  readonly orgLockWaitMs: number;
  readonly settlementWorkMs: number;
  readonly pendingReadMs: number;
  readonly pricingReadMs: number;
  readonly pricingCalculationMs: number;
  readonly allowanceMs: number;
  readonly allowanceAllocationReadMs: number;
  readonly allowanceAnchorMs: number;
  readonly allowanceWindowLockMs: number;
  readonly allowanceWindowIssueMs: number;
  readonly allowanceAllocateMs: number;
  readonly allowanceWindowWriteMs: number;
  readonly allowanceAllocationWriteMs: number;
  readonly eventWriteMs: number;
  readonly grantDeductionMs: number;
  readonly orgCreditMs: number;
  readonly orgBalanceReadMs: number;
  readonly orgExpireCreditsMs: number;
  readonly orgDebitMs: number;
  readonly orgExpiryLotDeductionMs: number;
  // Standalone settlement only; inline managed callers own a larger transaction.
  readonly transactionDurationMs?: number;
  readonly pendingEvents: number;
  readonly pricingRows: number;
  readonly affectedUsers: number;
  readonly grantRows: number;
  readonly expiredRows: number;
  readonly expiryRows: number;
}

export interface ProcessOrgUsageEventsResult {
  readonly sharedCreditsCharged: number;
  readonly runIds: readonly string[];
  readonly lowBalanceAlert: CreditLowBalanceAlertArgs | null;
  readonly work: SettlementWorkObservation;
}

interface UsageEventRecord {
  readonly id: string;
  readonly runId: string | null;
  readonly billingAnchorAt: Date | null;
  readonly idempotencyKey: string;
  readonly userId: string;
  readonly kind: string;
  readonly provider: string;
  readonly category: string;
  readonly quantity: number;
  readonly pricingUnitPrice: number | null;
  readonly pricingUnitSize: number | null;
  readonly pricingCreditsLimit: number | null;
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
  const pricingByKey = usagePricingByKey(pricingRecords);
  const pricedEvents: PricedUsageEvent[] = [];
  for (const record of records) {
    if (
      record.pricingUnitPrice !== null &&
      record.pricingUnitSize !== null &&
      record.pricingCreditsLimit !== null
    ) {
      const numerator =
        BigInt(record.quantity) * BigInt(record.pricingUnitPrice);
      const denominator = BigInt(record.pricingUnitSize);
      const credits = (numerator + denominator - 1n) / denominator;
      const limit = BigInt(record.pricingCreditsLimit);
      pricedEvents.push({
        record,
        grossCredits: Number(credits < limit ? credits : limit),
        billingError: null,
      });
      continue;
    }
    const lookupProvider = resolveUsagePricingProvider(
      pricingResolution,
      record.kind,
      record.provider,
    );
    const lookup = findUsagePricing(
      pricingByKey,
      record.kind,
      lookupProvider,
      record.category,
    );

    if (!lookup) {
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

    const { pricing, exact } = lookup;
    if (!exact) {
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
      billingError: exact ? null : "fallback_pricing",
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

// These are awaited application wall times, not exclusive database durations.
function elapsedSettlementPhaseMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 1000) / 1000;
}

function completedSettlementWork(
  work: SettlementWorkObservation,
  startedAt: number,
): SettlementWorkObservation {
  return {
    ...work,
    settlementWorkMs: Math.round(performance.now() - startedAt),
  };
}

async function settleMemberGrants(
  tx: WriteTx,
  orgId: string,
  charges: ReadonlyMap<string, number>,
  at: Date,
): Promise<{ readonly sharedCredits: number; readonly grantRows: number }> {
  let sharedCredits = 0;
  let grantRows = 0;
  const sortedCharges = [...charges.entries()].sort(([left], [right]) => {
    return left.localeCompare(right);
  });
  for (const [userId, amount] of sortedCharges) {
    const deduction = await deductFromUsagePackCredits(tx, {
      orgId,
      userId,
      amount,
      at,
    });
    sharedCredits += deduction.sharedCredits;
    grantRows += deduction.grantRows;
  }
  return { sharedCredits, grantRows };
}

interface SettlementLockObservation {
  readonly startedAt: number;
  readonly lockWaitMs: number;
  readonly orgLockWaitMs: number;
}

async function acquireSettlementLocksWithObservation(
  tx: WriteTx,
  orgId: string,
): Promise<SettlementLockObservation> {
  const startedAt = performance.now();
  await lockUsageEventCompaction(tx, "shared");
  await lockUsageEventCompaction(tx, "shared", orgId);
  const compactionLockAcquiredAt = performance.now();
  await lockOrgCredits(tx, orgId);
  const orgLockAcquiredAt = performance.now();
  return {
    startedAt,
    lockWaitMs: Math.round(compactionLockAcquiredAt - startedAt),
    orgLockWaitMs: Math.round(orgLockAcquiredAt - compactionLockAcquiredAt),
  };
}

async function readPendingUsageEventsWithTiming(tx: WriteTx, orgId: string) {
  const startedAt = performance.now();
  const pendingRecords = await tx
    .select({
      id: usageEvent.id,
      runId: usageEvent.runId,
      billingAnchorAt: usageEvent.billingAnchorAt,
      idempotencyKey: usageEvent.idempotencyKey,
      userId: usageEvent.userId,
      kind: usageEvent.kind,
      provider: usageEvent.provider,
      category: usageEvent.category,
      quantity: usageEvent.quantity,
      pricingUnitPrice: usageEvent.pricingUnitPrice,
      pricingUnitSize: usageEvent.pricingUnitSize,
      pricingCreditsLimit: usageEvent.pricingCreditsLimit,
      createdAt: usageEvent.createdAt,
    })
    .from(usageEvent)
    .where(and(eq(usageEvent.orgId, orgId), eq(usageEvent.status, "pending")));
  return { pendingRecords, pendingReadMs: elapsedSettlementPhaseMs(startedAt) };
}

export async function processOrgUsageEventsInTransaction(
  tx: WriteTx,
  orgId: string,
  pricingResolution: UsagePricingResolution,
  signal: AbortSignal,
): Promise<ProcessOrgUsageEventsResult> {
  const observation = await acquireSettlementLocksWithObservation(tx, orgId);
  signal.throwIfAborted();
  return await processOrgUsageEventsInLockedTransaction(
    tx,
    orgId,
    pricingResolution,
    observation,
    signal,
  );
}

function initialSettlementWork(observation: SettlementLockObservation) {
  const { lockWaitMs, orgLockWaitMs } = observation;
  // Count already-read rows, not additional queries under the financial lock.
  return {
    lockWaitMs,
    orgLockWaitMs,
    settlementWorkMs: 0,
    pendingReadMs: 0,
    pricingReadMs: 0,
    pricingCalculationMs: 0,
    allowanceMs: 0,
    allowanceAllocationReadMs: 0,
    allowanceAnchorMs: 0,
    allowanceWindowLockMs: 0,
    allowanceWindowIssueMs: 0,
    allowanceAllocateMs: 0,
    allowanceWindowWriteMs: 0,
    allowanceAllocationWriteMs: 0,
    eventWriteMs: 0,
    grantDeductionMs: 0,
    orgCreditMs: 0,
    orgBalanceReadMs: 0,
    orgExpireCreditsMs: 0,
    orgDebitMs: 0,
    orgExpiryLotDeductionMs: 0,
    pendingEvents: 0,
    pricingRows: 0,
    affectedUsers: 0,
    grantRows: 0,
    expiredRows: 0,
    expiryRows: 0,
  };
}

async function settleOrgCreditsWithTiming(
  tx: WriteTx,
  orgId: string,
  amount: number,
  at: Date,
  work: ReturnType<typeof initialSettlementWork>,
): Promise<CreditLowBalanceAlertArgs | null> {
  const orgCreditStartedAt = performance.now();
  // Order matters: settle expired credits BEFORE the new deduction.
  const balanceReadStartedAt = performance.now();
  const beforeCredits = await getOrgCredits(tx, orgId);
  work.orgBalanceReadMs = elapsedSettlementPhaseMs(balanceReadStartedAt);

  const expireCreditsStartedAt = performance.now();
  const expired = await expireCredits(tx, orgId, at);
  work.orgExpireCreditsMs = elapsedSettlementPhaseMs(expireCreditsStartedAt);
  work.expiredRows = expired.rows;
  const effectiveBeforeCredits = Math.max(beforeCredits - expired.credits, 0);

  const debitStartedAt = performance.now();
  const afterCredits = await deductOrgCredits(tx, orgId, amount);
  work.orgDebitMs = elapsedSettlementPhaseMs(debitStartedAt);

  const expiryLotDeductionStartedAt = performance.now();
  work.expiryRows = await deductFromExpiresRecords(tx, orgId, amount, at);
  work.orgExpiryLotDeductionMs = elapsedSettlementPhaseMs(
    expiryLotDeductionStartedAt,
  );
  const lowBalanceAlert =
    effectiveBeforeCredits > LOW_CREDIT_EMAIL_ALERT_THRESHOLD_CREDITS &&
    afterCredits <= LOW_CREDIT_EMAIL_ALERT_THRESHOLD_CREDITS
      ? {
          orgId,
          remainingCredits: afterCredits,
          thresholdCredits: LOW_CREDIT_EMAIL_ALERT_THRESHOLD_CREDITS,
        }
      : null;
  work.orgCreditMs = elapsedSettlementPhaseMs(orgCreditStartedAt);
  return lowBalanceAlert;
}

// The caller must already hold shared compaction and organization credit locks
// in this transaction. Observations cover this settlement call, not any earlier
// waits in the caller's larger transaction.
export async function processOrgUsageEventsInLockedTransaction(
  tx: WriteTx,
  orgId: string,
  pricingResolution: UsagePricingResolution,
  observation: SettlementLockObservation,
  signal: AbortSignal,
): Promise<ProcessOrgUsageEventsResult> {
  const { startedAt } = observation;
  const work = initialSettlementWork(observation);

  const { pendingRecords, pendingReadMs } =
    await readPendingUsageEventsWithTiming(tx, orgId);
  work.pendingReadMs = pendingReadMs;

  work.pendingEvents = pendingRecords.length;
  if (pendingRecords.length === 0) {
    return {
      sharedCreditsCharged: 0,
      runIds: [],
      lowBalanceAlert: null,
      work: completedSettlementWork(work, startedAt),
    };
  }
  const runIds = [
    ...new Set(
      pendingRecords.flatMap((record) => {
        return record.runId ? [record.runId] : [];
      }),
    ),
  ];

  const pricingReadStartedAt = performance.now();
  const pricingRecords = await tx.select().from(usagePricing);
  work.pricingReadMs = elapsedSettlementPhaseMs(pricingReadStartedAt);
  work.pricingRows = pricingRecords.length;
  const pricingCalculationStartedAt = performance.now();
  const pricedEvents = priceUsageEvents(
    pendingRecords,
    pricingRecords,
    orgId,
    pricingResolution,
  );
  work.pricingCalculationMs = elapsedSettlementPhaseMs(
    pricingCalculationStartedAt,
  );

  const allowanceStartedAt = performance.now();
  const allowance = await applyUsageAllowanceToUsageEventsInLockedTransaction(
    tx,
    {
      orgId,
      events: pricedEvents.map((event) => {
        return {
          usageEventId: event.record.id,
          runId: event.record.runId,
          billingAnchorAt: event.record.billingAnchorAt,
          grossUnits: event.grossCredits,
          occurredAt: event.record.createdAt,
        };
      }),
    },
  );
  const { allowanceByUsageEvent, timings: allowanceTimings } = allowance;
  work.allowanceMs = elapsedSettlementPhaseMs(allowanceStartedAt);
  work.allowanceAllocationReadMs = allowanceTimings.allocationReadMs;
  work.allowanceAnchorMs = allowanceTimings.anchorMs;
  work.allowanceWindowLockMs = allowanceTimings.windowLockMs;
  work.allowanceWindowIssueMs = allowanceTimings.windowIssueMs;
  work.allowanceAllocateMs = allowanceTimings.allocateMs;
  work.allowanceWindowWriteMs = allowanceTimings.windowWriteMs;
  work.allowanceAllocationWriteMs = allowanceTimings.allocationWriteMs;
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
  const eventWriteStartedAt = performance.now();
  await markUsageEventsProcessed(tx, settlementOutcomes);
  work.eventWriteMs = elapsedSettlementPhaseMs(eventWriteStartedAt);
  signal.throwIfAborted();

  const settlementTime = nowDate();
  work.affectedUsers = billableCreditsByUser.size;
  const grantDeductionStartedAt = performance.now();
  const grantDeduction = await settleMemberGrants(
    tx,
    orgId,
    billableCreditsByUser,
    settlementTime,
  );
  work.grantDeductionMs = elapsedSettlementPhaseMs(grantDeductionStartedAt);
  const sharedCreditsCharged = grantDeduction.sharedCredits;
  work.grantRows = grantDeduction.grantRows;
  signal.throwIfAborted();

  const lowBalanceAlert =
    sharedCreditsCharged > 0
      ? await settleOrgCreditsWithTiming(
          tx,
          orgId,
          sharedCreditsCharged,
          settlementTime,
          work,
        )
      : null;
  signal.throwIfAborted();
  return {
    sharedCreditsCharged,
    runIds,
    lowBalanceAlert,
    work: completedSettlementWork(work, startedAt),
  };
}

export const completeProcessedOrgUsage$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly result: ProcessOrgUsageEventsResult;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const { orgId, result } = args;
    const { sharedCreditsCharged, runIds, lowBalanceAlert } = result;
    signal.throwIfAborted();
    // Postcommit only: a rollback is not reported as a completed settlement.
    // No org, user, run or event ID is sent with these timing operations.
    if (result.work.pendingEvents > 0) {
      // The ledger has committed. Best-effort telemetry must not turn its
      // receipt into a failed response; safeSync still propagates cancellation.
      safeSync(() => {
        const work = result.work;
        const timingScope =
          work.transactionDurationMs === undefined ? "inline" : "standalone";
        recordBillingOperationTimings([
          {
            actionType: "api_billing_settlement_work",
            durationMs: work.settlementWorkMs,
            success: true,
            dimensions: {
              timing_scope: timingScope,
              pending_events: work.pendingEvents,
              pricing_rows: work.pricingRows,
              compaction_lock_wait_ms: work.lockWaitMs,
              org_lock_wait_ms: work.orgLockWaitMs,
              pending_read_ms: work.pendingReadMs,
              pricing_read_ms: work.pricingReadMs,
              pricing_calculation_ms: work.pricingCalculationMs,
              allowance_ms: work.allowanceMs,
              allowance_allocation_read_ms: work.allowanceAllocationReadMs,
              allowance_anchor_ms: work.allowanceAnchorMs,
              allowance_window_lock_ms: work.allowanceWindowLockMs,
              allowance_window_issue_ms: work.allowanceWindowIssueMs,
              allowance_allocate_ms: work.allowanceAllocateMs,
              allowance_window_write_ms: work.allowanceWindowWriteMs,
              allowance_allocation_write_ms: work.allowanceAllocationWriteMs,
              event_write_ms: work.eventWriteMs,
              grant_deduction_ms: work.grantDeductionMs,
              org_credit_ms: work.orgCreditMs,
              org_balance_read_ms: work.orgBalanceReadMs,
              org_expire_credits_ms: work.orgExpireCreditsMs,
              org_debit_ms: work.orgDebitMs,
              org_expiry_lot_deduction_ms: work.orgExpiryLotDeductionMs,
              affected_users: work.affectedUsers,
              grant_rows: work.grantRows,
              expired_rows: work.expiredRows,
              expiry_rows: work.expiryRows,
            },
          },
          {
            actionType: "api_billing_settlement_compaction_lock_wait",
            durationMs: work.lockWaitMs,
            success: true,
            dimensions: { timing_scope: timingScope },
          },
          {
            actionType: "api_billing_settlement_org_lock_wait",
            durationMs: work.orgLockWaitMs,
            success: true,
            dimensions: { timing_scope: timingScope },
          },
          ...(work.transactionDurationMs === undefined
            ? []
            : [
                {
                  actionType: "api_billing_settlement_transaction",
                  durationMs: work.transactionDurationMs,
                  success: true,
                  dimensions: { timing_scope: "standalone" },
                },
              ]),
        ]);
      });
    }

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

/**
 * Atomically settle pending usage, including allowance and member credit packs,
 * before running recharge, notification, and usage-event delivery effects.
 * Effects run after COMMIT so callers never retain ledger locks during I/O.
 */
export const processOrgUsageEvents$ = command(
  async ({ get, set }, orgId: string, signal: AbortSignal): Promise<void> => {
    const writeDb = set(writeDb$);
    const pricingResolution = get(usagePricingResolution$);
    const transactionStartedAt = performance.now();
    const result = await writeDb.transaction((tx) => {
      return processOrgUsageEventsInTransaction(
        tx,
        orgId,
        pricingResolution,
        signal,
      );
    });
    signal.throwIfAborted();
    const transactionDurationMs = Math.round(
      performance.now() - transactionStartedAt,
    );
    await set(
      completeProcessedOrgUsage$,
      {
        orgId,
        result: { ...result, work: { ...result.work, transactionDurationMs } },
      },
      signal,
    );
  },
);
