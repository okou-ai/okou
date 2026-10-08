import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { usagePackCreditDebtEntries } from "@okouai/db/schema/usage-pack-credit-debt";
import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import { and, asc, eq, gt, lt, or, sql, sum } from "drizzle-orm";
import { pgInt8ToSafeIntegerDecoder } from "../../lib/db-structured-result";
import type { Db } from "../external/db";
import { nowDate } from "../../lib/time";

type CreditStore = Pick<Db, "select" | "insert" | "update">;

export function usagePackBalanceCondition(at: Date) {
  return or(
    lt(usagePackCreditGrants.remainingAmount, 0),
    gt(usagePackCreditGrants.expiresAt, at),
  );
}

/** Scalar liability sum, including debts whose original grant has expired. */
export function usagePackDebtAmountSql(orgId: string, userId: string) {
  return sql`COALESCE((SELECT ${sum(usagePackCreditDebtEntries.amount)} FROM ${usagePackCreditDebtEntries}
    WHERE ${eq(usagePackCreditDebtEntries.orgId, orgId)} AND ${eq(usagePackCreditDebtEntries.userId, userId)}), 0)`;
}

/** Acquire before reading financial rows; callers must own the transaction. */
export async function lockUsageCreditWallet(
  db: Pick<Db, "select">,
  orgId: string,
) {
  const [wallet] = await db
    .select({ credits: orgMetadata.credits })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .for("update");
  if (!wallet) throw new Error("Usage credit wallet is missing");
  return wallet.credits;
}

/** Call only within a transaction. Legacy negatives are preserved as audit entries. */
export async function repayUsagePackDebtInTransaction(
  db: CreditStore,
  owner: { readonly orgId: string; readonly userId?: string },
  at = nowDate(),
) {
  await lockUsageCreditWallet(db, owner.orgId);
  const rows = await db
    .select()
    .from(usagePackCreditGrants)
    .where(
      and(
        eq(usagePackCreditGrants.orgId, owner.orgId),
        owner.userId === undefined
          ? undefined
          : eq(usagePackCreditGrants.userId, owner.userId),
        usagePackBalanceCondition(at),
      ),
    )
    .orderBy(
      asc(usagePackCreditGrants.userId),
      asc(usagePackCreditGrants.grantType),
      asc(usagePackCreditGrants.expiresAt),
      asc(usagePackCreditGrants.id),
    )
    .for("update");
  for (const grant of rows) {
    if (grant.remainingAmount >= 0) continue;
    await db.insert(usagePackCreditDebtEntries).values({
      orgId: owner.orgId,
      userId: grant.userId,
      amount: -grant.remainingAmount,
      kind: "legacy_overdraft",
      creditGrantId: grant.id,
    });
    await db
      .update(usagePackCreditGrants)
      .set({ remainingAmount: 0 })
      .where(eq(usagePackCreditGrants.id, grant.id));
  }
  const debts = await db
    .select({
      userId: usagePackCreditDebtEntries.userId,
      amount:
        sql`COALESCE(${sum(usagePackCreditDebtEntries.amount)}, 0)::bigint`.mapWith(
          pgInt8ToSafeIntegerDecoder,
        ),
    })
    .from(usagePackCreditDebtEntries)
    .where(
      and(
        eq(usagePackCreditDebtEntries.orgId, owner.orgId),
        owner.userId === undefined
          ? undefined
          : eq(usagePackCreditDebtEntries.userId, owner.userId),
      ),
    )
    .groupBy(usagePackCreditDebtEntries.userId);
  const remaining = new Map(debts.map((debt) => [debt.userId, debt.amount]));
  if (debts.some((debt) => debt.amount < 0))
    throw new Error("Member debt ledger cannot be overpaid");
  // Purchased before bonus, then earliest expiry: the same priority as consumption.
  const funding = rows
    .filter((row) => row.remainingAmount > 0 && row.expiresAt > at)
    .sort(
      (left, right) =>
        left.userId.localeCompare(right.userId) ||
        (left.grantType === right.grantType
          ? 0
          : left.grantType === "purchased"
            ? -1
            : 1) ||
        left.expiresAt.getTime() - right.expiresAt.getTime() ||
        left.id.localeCompare(right.id),
    );
  for (const grant of funding) {
    const amount = Math.min(
      grant.remainingAmount,
      remaining.get(grant.userId) ?? 0,
    );
    if (amount <= 0) continue;
    await db
      .update(usagePackCreditGrants)
      .set({
        remainingAmount: sql`${usagePackCreditGrants.remainingAmount} - ${amount}`,
      })
      .where(eq(usagePackCreditGrants.id, grant.id));
    await db
      .insert(usagePackCreditDebtEntries)
      .values({
        orgId: owner.orgId,
        userId: grant.userId,
        amount: -amount,
        kind: "repayment",
        creditGrantId: grant.id,
      });
    remaining.set(grant.userId, (remaining.get(grant.userId) ?? 0) - amount);
  }
}
