import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  lt,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { pgTextDecoder } from "../../lib/db-structured-result";
import { UsageSettlementSnapshotConflict } from "./credit-usage-batch";
import { planExpiryLotDeductions } from "./credit-usage-settlement-plan";

export interface PreparedUsageExpiryLot {
  readonly id: string;
  readonly remaining: number;
  readonly expiresAt: Date;
  readonly expiresText: string;
  readonly xmin: string;
}
export interface PreparedUsageExpiryPrefix {
  readonly lots: readonly PreparedUsageExpiryLot[];
  readonly frontier: PreparedUsageExpiryLot | null;
}
export interface UsageExpiryScope {
  readonly orgId: string;
  readonly amount: number;
  readonly at: Date;
  readonly prefix: PreparedUsageExpiryPrefix;
}
export function expiryPrefixSelection() {
  return {
    id: creditExpiresRecord.id,
    remaining: creditExpiresRecord.remaining,
    expiresAt: creditExpiresRecord.expiresAt,
    expiresText: sql`${creditExpiresRecord.expiresAt}::text`
      .mapWith(pgTextDecoder)
      .as("expires_text"),
    xmin: sql`${creditExpiresRecord}.xmin::text`
      .mapWith(pgTextDecoder)
      .as("xmin"),
  };
}
export function expiryPageAfter(cursor: PreparedUsageExpiryLot | undefined) {
  return cursor
    ? or(
        gt(
          creditExpiresRecord.expiresAt,
          sql`${cursor.expiresText}::timestamp`,
        ),
        and(
          eq(
            creditExpiresRecord.expiresAt,
            sql`${cursor.expiresText}::timestamp`,
          ),
          gt(creditExpiresRecord.id, cursor.id),
        ),
      )
    : undefined;
}
export function expiryPrefixForAmount(
  lots: readonly PreparedUsageExpiryLot[],
  amount: number,
) {
  let remaining = amount;
  const selected: PreparedUsageExpiryLot[] = [];
  for (const lot of lots) {
    if (remaining <= 0) {
      break;
    }
    selected.push(lot);
    remaining -= lot.remaining;
  }
  return {
    lots: selected,
    remaining,
    frontier: remaining <= 0 ? (selected.at(-1) ?? null) : null,
  };
}
export function usageExpiryScope(
  orgId: string,
  prepared: PreparedUsageExpiryPrefix,
  amount: number,
  at: Date,
): UsageExpiryScope {
  return {
    orgId,
    amount,
    at,
    prefix: expiryPrefixForAmount(prepared.lots, amount),
  };
}

/**
 * Expiration admission has already established that no expired remainder
 * exists. Plain read; expiryLotDeductionsSql re-checks each observed xmin.
 */
export function expiryLotsQuery(scope: UsageExpiryScope) {
  return new QueryBuilder()
    .select(expiryPrefixSelection())
    .from(creditExpiresRecord)
    .where(
      and(
        eq(creditExpiresRecord.orgId, scope.orgId),
        gt(creditExpiresRecord.remaining, 0),
        inArray(
          creditExpiresRecord.id,
          scope.prefix.lots.map((lot) => {
            return lot.id;
          }),
        ),
      ),
    )
    .orderBy(asc(creditExpiresRecord.expiresAt), asc(creditExpiresRecord.id))
    .as("settlement_expiry_lots");
}
export function unseenExpiryQuery(scope: UsageExpiryScope) {
  const frontier = scope.prefix.frontier;
  return new QueryBuilder()
    .select({ id: creditExpiresRecord.id })
    .from(creditExpiresRecord)
    .where(
      and(
        eq(creditExpiresRecord.orgId, scope.orgId),
        gt(creditExpiresRecord.remaining, 0),
        gt(creditExpiresRecord.expiresAt, scope.at),
        notInArray(
          creditExpiresRecord.id,
          scope.prefix.lots.map((lot) => {
            return lot.id;
          }),
        ),
        frontier
          ? or(
              lt(
                creditExpiresRecord.expiresAt,
                sql`${frontier.expiresText}::timestamp`,
              ),
              and(
                eq(
                  creditExpiresRecord.expiresAt,
                  sql`${frontier.expiresText}::timestamp`,
                ),
                lt(creditExpiresRecord.id, frontier.id),
              ),
            )
          : undefined,
      ),
    )
    .limit(1)
    .as("unseen_usage_expiry_lot");
}
export function planCurrentExpiryDeduction(
  scope: UsageExpiryScope,
  lots: readonly PreparedUsageExpiryLot[],
  unseen: { id: string } | undefined,
) {
  const current = new Map(
    lots.map((lot) => {
      return [lot.id, lot];
    }),
  );
  if (
    unseen ||
    scope.prefix.lots.some((lot) => {
      const row = current.get(lot.id);
      return !row || row.xmin !== lot.xmin || row.expiresAt <= scope.at;
    })
  ) {
    throw new UsageSettlementSnapshotConflict(
      "Usage expiry prefix changed during preparation",
    );
  }
  const plan = planExpiryLotDeductions(lots, scope.amount, scope.at);
  return {
    ...plan,
    work: { expiredRows: plan.expiredRows, expiryRows: plan.expiryRows },
  };
}
