import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { and, eq, gt, or, sql } from "drizzle-orm";
import { pgTextDecoder } from "../../lib/db-structured-result";

export interface PreparedUsageExpiryLot {
  readonly id: string;
  readonly remaining: number;
  readonly expiresAt: Date;
  readonly expiresText: string;
}
export interface PreparedUsageExpiryPrefix {
  readonly lots: readonly PreparedUsageExpiryLot[];
}
export function expiryPrefixSelection() {
  return {
    id: creditExpiresRecord.id,
    remaining: creditExpiresRecord.remaining,
    expiresAt: creditExpiresRecord.expiresAt,
    expiresText: sql`${creditExpiresRecord.expiresAt}::text`
      .mapWith(pgTextDecoder)
      .as("expires_text"),
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
  return { lots: selected, remaining };
}
