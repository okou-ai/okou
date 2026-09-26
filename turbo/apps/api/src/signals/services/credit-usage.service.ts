import { command } from "ccstate";
import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import { usagePricing } from "@okouai/db/schema/usage-pricing";
import { and, asc, eq, gt, lte, sql } from "drizzle-orm";

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
import { projectCommittedRunUsage$ } from "./usage-chat-projection-worker.service";
import { enqueueSettledRunUsageProjection } from "./usage-chat-projection-outbox.service";
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
  // Standalone settlement only; inline managed callers own a larger transaction.
  readonly transactionDurationMs?: number;
  readonly pendingEvents: number;
  readonly pricingRows: number;
  readonly affectedUsers: number;
  readonly grantRows: number;
  readonly expiredRows: number;
  readonly expiryRows: number;
  readonly projectionRuns: number;
  readonly projectionWriteMs: number;
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

function completedSettlementWork(
  work: SettlementWorkObservation,
  startedAt: number,
): SettlementWorkObservation {
  return {
    ...work,
    settlementWorkMs: Math.round(performance.now() - startedAt),
  };
}

function distinctRunIds(
  records: readonly Pick<UsageEventRecord, "runId">[],
): string[] {
  return [
    ...new Set(
      records.flatMap((record) => {
        return record.runId ? [record.runId] : [];
      }),
    ),
  ];
}

async function enqueueProjectionWithObservation(
  tx: WriteTx,
  records: readonly Pick<UsageEventRecord, "runId">[],
): Promise<number> {
  const startedAt = performance.now();
  await enqueueSettledRunUsageProjection(tx, records);
  return Math.round(performance.now() - startedAt);
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

async function acquireSettlementLocksWithObservation(
  tx: WriteTx,
  orgId: string,
) {
  // Count already-read rows, not additional queries under the financial lock.
  // Inline managed callers may have taken these locks before this function.
  const startedAt = performance.now();
  await lockUsageEventCompaction(tx, "shared");
  const compactionLockAcquiredAt = performance.now();
  await lockOrgCredits(tx, orgId);
  const orgLockAcquiredAt = performance.now();
  return {
    startedAt,
    work: {
      lockWaitMs: Math.round(compactionLockAcquiredAt - startedAt),
      orgLockWaitMs: Math.round(orgLockAcquiredAt - compactionLockAcquiredAt),
      settlementWorkMs: 0,
      pendingEvents: 0,
      pricingRows: 0,
      affectedUsers: 0,
      grantRows: 0,
      expiredRows: 0,
      expiryRows: 0,
      projectionRuns: 0,
      projectionWriteMs: 0,
    },
  };
}

export async function processOrgUsageEventsInTransaction(
  tx: WriteTx,
  orgId: string,
  pricingResolution: UsagePricingResolution,
  signal: AbortSignal,
): Promise<ProcessOrgUsageEventsResult> {
  const { startedAt, work } = await acquireSettlementLocksWithObservation(
    tx,
    orgId,
  );

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

  work.pendingEvents = pendingRecords.length;
  if (pendingRecords.length === 0) {
    return {
      sharedCreditsCharged: 0,
      runIds: [],
      lowBalanceAlert: null,
      work: completedSettlementWork(work, startedAt),
    };
  }
  const runIds = distinctRunIds(pendingRecords);

  const pricingRecords = await tx.select().from(usagePricing);
  work.pricingRows = pricingRecords.length;
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
          billingAnchorAt: event.record.billingAnchorAt,
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
  work.affectedUsers = billableCreditsByUser.size;
  const grantDeduction = await settleMemberGrants(
    tx,
    orgId,
    billableCreditsByUser,
    settlementTime,
  );
  const sharedCreditsCharged = grantDeduction.sharedCredits;
  work.grantRows = grantDeduction.grantRows;
  signal.throwIfAborted();

  let lowBalanceAlert: CreditLowBalanceAlertArgs | null = null;
  if (sharedCreditsCharged > 0) {
    // Order matters: settle expired credits BEFORE the new deduction.
    const beforeCredits = await getOrgCredits(tx, orgId);
    const expired = await expireCredits(tx, orgId, settlementTime);
    work.expiredRows = expired.rows;
    const effectiveBeforeCredits = Math.max(beforeCredits - expired.credits, 0);
    await deductOrgCredits(tx, orgId, sharedCreditsCharged);
    const afterCredits = await getOrgCredits(tx, orgId);
    work.expiryRows = await deductFromExpiresRecords(
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
  // Commit the content-free presentation obligation with the financial result.
  // No chat table, snapshot, or R2 read participates in this transaction.
  work.projectionWriteMs = await enqueueProjectionWithObservation(
    tx,
    pendingRecords,
  );
  work.projectionRuns = runIds.length;
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
              affected_users: work.affectedUsers,
              grant_rows: work.grantRows,
              expired_rows: work.expiredRows,
              expiry_rows: work.expiryRows,
              projection_runs: work.projectionRuns,
            },
          },
          {
            actionType: "api_billing_projection_outbox_write",
            durationMs: work.projectionWriteMs,
            success: true,
            dimensions: {
              timing_scope: timingScope,
              projection_runs: work.projectionRuns,
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
      await tapError(set(projectCommittedRunUsage$, runId, signal), (error) => {
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
