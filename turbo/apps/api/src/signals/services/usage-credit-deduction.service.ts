import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import type {
  planMemberGrantDeductions,
  planExpiryLotDeductions,
} from "./credit-usage-settlement-plan";

export function requireUsageCashWallet(
  wallet: { readonly orgId: string } | undefined,
) {
  if (!wallet) {
    throw new Error("Usage settlement organization wallet is missing");
  }
}

export function usageCashWork(
  deduction: ReturnType<typeof planMemberGrantDeductions>,
  expiry: ReturnType<typeof planExpiryLotDeductions>,
) {
  return {
    ...deduction.work,
    expiredRows: expiry.expiredRows,
    expiryRows: expiry.expiryRows,
  };
}

/** Pure queries: the owning transaction locks the wallet before reading cash. */
export function usageCashQueries(
  orgId: string,
  charges: ReadonlyMap<string, number>,
  at: Date,
) {
  const users = [...charges]
    .filter(([, amount]) => {
      return amount > 0;
    })
    .map(([userId]) => {
      return userId;
    });
  const builder = new QueryBuilder();
  return {
    wallet: builder
      .select({ orgId: orgMetadata.orgId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .for("update")
      .as("usage_cash_wallet"),
    grants: builder
      .select({
        id: usagePackCreditGrants.id,
        userId: usagePackCreditGrants.userId,
        remainingAmount: usagePackCreditGrants.remainingAmount,
      })
      .from(usagePackCreditGrants)
      .where(
        and(
          eq(usagePackCreditGrants.orgId, orgId),
          inArray(usagePackCreditGrants.userId, users),
          gt(usagePackCreditGrants.remainingAmount, 0),
          gt(usagePackCreditGrants.expiresAt, at),
        ),
      )
      .orderBy(
        sql`CASE WHEN ${usagePackCreditGrants.grantType} = 'purchased' THEN 0 ELSE 1 END`,
        asc(usagePackCreditGrants.expiresAt),
        asc(usagePackCreditGrants.id),
      )
      .for("update")
      .as("usage_cash_grants"),
  };
}

export function usageCashExpiryLotsQuery(orgId: string, at: Date) {
  return new QueryBuilder()
    .select({
      id: creditExpiresRecord.id,
      remaining: creditExpiresRecord.remaining,
      expiresAt: creditExpiresRecord.expiresAt,
    })
    .from(creditExpiresRecord)
    .where(
      and(
        eq(creditExpiresRecord.orgId, orgId),
        gt(creditExpiresRecord.remaining, 0),
        gt(creditExpiresRecord.expiresAt, at),
      ),
    )
    .orderBy(asc(creditExpiresRecord.expiresAt), asc(creditExpiresRecord.id))
    .for("update")
    .as("usage_cash_expiry_lots");
}
