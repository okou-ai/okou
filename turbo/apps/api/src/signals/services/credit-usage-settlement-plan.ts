import {
  usageSnapshotCondition,
  type PendingUsageSnapshot,
} from "./credit-usage-batch";
import type { SocialSettlementClaim } from "./social-data-settlement-plan";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import { and, eq, sql } from "drizzle-orm";
import { orgTierSchema } from "@okouai/api-contracts/contracts/orgs";
import { orgPlanEntitlementValues } from "./org-plan-entitlements.service";
import { LOW_CREDIT_EMAIL_ALERT_THRESHOLD_CREDITS } from "./credit-low-balance-alert.service";
import type {
  PricedUsageEvent,
  ProcessOrgUsageEventsResult,
  SettlementWorkObservation,
} from "./credit-usage-pricing";

function initialSettlementObservation(): SettlementWorkObservation {
  return {
    lockWaitMs: 0,
    settlementWorkMs: 0,
    pendingEvents: 0,
    pricingRows: 0,
    affectedUsers: 0,
    grantRows: 0,
    expiredRows: 0,
    expiryRows: 0,
  };
}

export function settlementObservation(pricingRows: number) {
  return {
    startedAt: performance.now(),
    work: { ...initialSettlementObservation(), pricingRows },
  };
}

export function planUsageCharges(
  events: readonly PricedUsageEvent[],
  allowance: ReadonlyMap<string, number>,
) {
  const byUser = new Map<string, number>();
  const outcomes = events.map((event) => {
    const creditsCharged =
      event.grossCredits - (allowance.get(event.record.id) ?? 0);
    byUser.set(
      event.record.userId,
      (byUser.get(event.record.userId) ?? 0) + creditsCharged,
    );
    return {
      id: event.record.id,
      creditsCharged,
      billingError: event.billingError,
    };
  });
  return { byUser, outcomes };
}

export function settledEventsSql(
  plan: ReturnType<typeof planUsageCharges>,
  at: Date,
) {
  const source = sql`unnest(${sql.param(
    plan.outcomes.map((outcome) => {
      return outcome.id;
    }),
  )}::uuid[],
    ${sql.param(
      plan.outcomes.map((outcome) => {
        return outcome.creditsCharged;
      }),
    )}::bigint[],
    ${sql.param(
      plan.outcomes.map((outcome) => {
        return outcome.billingError;
      }),
    )}::varchar(50)[]) AS settlement(id, credits_charged, billing_error)`;
  return sql`UPDATE ${usageEvent}
    SET credits_charged = settlement.credits_charged,
        status = 'processed',
        processed_at = ${sql.param(at, usageEvent.processedAt)},
        billing_error = settlement.billing_error
    FROM ${source}
    WHERE ${usageEvent.id} = settlement.id`;
}

export interface ConditionalDeduction {
  readonly id: string;
  readonly amount: number;
}

export function planMemberGrantDeductions(
  charges: ReadonlyMap<string, number>,
  grants: readonly {
    id: string;
    userId: string;
    remainingAmount: number;
  }[],
) {
  const remaining = new Map(charges);
  const updates: ConditionalDeduction[] = [];
  for (const grant of grants) {
    const charge = remaining.get(grant.userId) ?? 0;
    if (charge <= 0) {
      continue;
    }
    const amount = Math.min(charge, grant.remainingAmount);
    updates.push({ id: grant.id, amount });
    remaining.set(grant.userId, charge - amount);
  }
  return {
    updates,
    work: { affectedUsers: charges.size, grantRows: grants.length },
    sharedCredits: [...remaining.values()].reduce((total, charge) => {
      return total + charge;
    }, 0),
  };
}

function deductionSource(updates: readonly ConditionalDeduction[]) {
  return sql`unnest(${sql.param(
    updates.map((update) => {
      return update.id;
    }),
  )}::uuid[], ${sql.param(
    updates.map((update) => {
      return update.amount;
    }),
  )}::bigint[]) AS deduction(id, amount)`;
}

/** Apply the prepared split atomically; concurrent overdraft is accepted. */
export function memberGrantDeductionsSql(
  updates: readonly ConditionalDeduction[],
) {
  return sql`UPDATE ${usagePackCreditGrants} SET remaining_amount = remaining_amount - deduction.amount
    FROM ${deductionSource(updates)}
    WHERE ${usagePackCreditGrants.id} = deduction.id`;
}

export function planExpiryLotDeductions(
  lots: readonly {
    id: string;
    remaining: number;
    expiresAt: Date;
  }[],
  amount: number,
  at: Date,
) {
  let left = amount;
  let expired = 0;
  let expiredRows = 0;
  let expiryRows = 0;
  const updates: ConditionalDeduction[] = [];
  for (const lot of lots) {
    if (lot.expiresAt <= at) {
      expired += lot.remaining;
      expiredRows += 1;
      updates.push({ id: lot.id, amount: lot.remaining });
    } else {
      expiryRows += 1;
      if (left <= 0) {
        continue;
      }
      const deduction = Math.min(left, lot.remaining);
      updates.push({ id: lot.id, amount: deduction });
      left -= deduction;
    }
  }
  return { updates, expired, expiredRows, expiryRows };
}

/** Same atomic decrement and accepted overdraft as member grants. */
export function expiryLotDeductionsSql(
  updates: readonly ConditionalDeduction[],
) {
  return sql`UPDATE ${creditExpiresRecord} SET remaining = remaining - deduction.amount
    FROM ${deductionSource(updates)}
    WHERE ${creditExpiresRecord.id} = deduction.id`;
}

/** A missing target is a billing bug; a changed balance is not. */
export function requireConditionalDeductions(
  kind: "grant" | "expiry lot",
  planned: readonly unknown[],
  updated: number | null,
) {
  if (updated !== planned.length) {
    throw new Error(`Usage ${kind} disappeared before its deduction`);
  }
}

export function settlementBalanceValue(amount: number, expired: number) {
  // Preserve debt when nothing expired; expiry alone clamps the available
  // balance before the new charge, matching the existing wallet contract.
  const before =
    expired > 0
      ? sql`GREATEST(${orgMetadata.credits} - ${expired}, 0)`
      : sql`${orgMetadata.credits}`;
  return sql`${before} - ${amount}`;
}

export function settlementDefaultPlan(
  metadata: { readonly orgId: string; readonly tier: string } | undefined,
) {
  if (!metadata) {
    return null;
  }
  const tier = orgTierSchema.safeParse(metadata.tier);
  return tier.success
    ? orgPlanEntitlementValues(
        {
          orgId: metadata.orgId,
          tier: tier.data,
          source: "org_metadata_migration",
        },
        { stripeSubscriptionId: null, sourceMetadata: {} },
      )
    : null;
}

export function settlementReceipt(
  orgId: string,
  events: readonly PricedUsageEvent[],
  args: {
    readonly amount: number;
    readonly afterCredits: number;
    readonly work: SettlementWorkObservation;
  },
): ProcessOrgUsageEventsResult {
  const threshold = LOW_CREDIT_EMAIL_ALERT_THRESHOLD_CREDITS;
  // The debit is one atomic statement: after = max(before - expired, 0) -
  // amount when lots expired, otherwise before - amount. Its own result
  // therefore yields the available balance it debited, max(before - expired,
  // 0), without reading the wallet row earlier in the transaction.
  const availableBefore = Math.max(args.afterCredits + args.amount, 0);
  return {
    sharedCreditsCharged: args.amount,
    runIds: [
      ...new Set(
        events.flatMap((event) => {
          return event.record.runId ? [event.record.runId] : [];
        }),
      ),
    ],
    lowBalanceAlert:
      args.amount > 0 &&
      availableBefore > threshold &&
      args.afterCredits <= threshold
        ? {
            orgId,
            remainingCredits: args.afterCredits,
            thresholdCredits: threshold,
          }
        : null,
    work: args.work,
  };
}

export function settlementDebitValues(
  amount: number,
  expired: number,
  at: Date,
) {
  return { credits: settlementBalanceValue(amount, expired), updatedAt: at };
}

export function completeSettlementReceipt(
  result: ProcessOrgUsageEventsResult,
  startedAt: number,
) {
  const durationMs = Math.round(performance.now() - startedAt);
  return {
    ...result,
    work: {
      ...result.work,
      settlementWorkMs: durationMs,
      transactionDurationMs: durationMs,
    },
  };
}

/**
 * Only pending usage can be claimed. The claim and all debits share one
 * transaction, so rollback releases the claim and concurrent callers never
 * charge a processed event again.
 */
export function claimUsageWhere(
  orgId: string,
  snapshots: readonly PendingUsageSnapshot[],
  socialKey?: string,
) {
  return and(
    socialKey
      ? eq(usageEvent.idempotencyKey, socialKey)
      : usageSnapshotCondition(snapshots),
    eq(usageEvent.orgId, orgId),
    eq(usageEvent.status, "pending"),
  );
}

export function orgDebitPlan(
  orgId: string,
  amount: number,
  expired: number,
  at: Date,
) {
  return {
    values: { orgId, credits: -amount },
    conflict: {
      target: orgMetadataCanonicalWrites.orgId,
      set: settlementDebitValues(amount, expired, at),
    },
  };
}

export function emptySettlementReceipt(
  work: SettlementWorkObservation,
): ProcessOrgUsageEventsResult {
  return { sharedCreditsCharged: 0, runIds: [], lowBalanceAlert: null, work };
}

export function hasNoStandaloneUsage(
  events: readonly { readonly id: string }[],
  social: SocialSettlementClaim | undefined,
): boolean {
  return events.length === 0 && social === undefined;
}
