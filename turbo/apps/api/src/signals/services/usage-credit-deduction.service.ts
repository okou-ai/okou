import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import type { Tx } from "../../lib/db-types";
import { expireOrgCreditsInTransaction } from "./org-credit-expiration.service";
import {
  lockUsagePackWallet,
  transferUsagePackOverdraftsInTransaction,
} from "./usage-pack-overdraft-transfer.service";
import {
  planMemberGrantDeductions,
  planExpiryLotDeductions,
} from "./credit-usage-settlement-plan";

/** Re-read cash after acquiring financial locks, never spend a prepared balance twice. */
export async function prepareUsageCashInTransaction(
  tx: Tx,
  orgId: string,
  charges: ReadonlyMap<string, number>,
  at: Date,
) {
  if (!(await lockUsagePackWallet(tx, orgId))) {
    throw new Error("Usage settlement organization wallet is missing");
  }
  const users = [...charges]
    .filter(([, amount]) => {
      return amount > 0;
    })
    .map(([userId]) => {
      return userId;
    })
    .sort();
  const grants =
    users.length > 0
      ? await tx
          .select()
          .from(usagePackCreditGrants)
          .where(
            and(
              eq(usagePackCreditGrants.orgId, orgId),
              inArray(usagePackCreditGrants.userId, users),
              gt(usagePackCreditGrants.remainingAmount, 0),
              gt(usagePackCreditGrants.expiresAt, at),
            ),
          )
          .orderBy(asc(usagePackCreditGrants.id))
          .for("update")
      : [];
  grants.sort((left, right) => {
    return (
      (left.grantType === right.grantType
        ? 0
        : left.grantType === "purchased"
          ? -1
          : 1) ||
      left.expiresAt.getTime() - right.expiresAt.getTime() ||
      left.id.localeCompare(right.id)
    );
  });
  const deduction = planMemberGrantDeductions(charges, grants);
  if (deduction.sharedCredits > 0) {
    await expireOrgCreditsInTransaction(tx, orgId, at);
  }
  // Repair expires first as well: never clamp away a freshly transferred debt.
  await transferUsagePackOverdraftsInTransaction(tx, { orgId }, at);
  const lots =
    deduction.sharedCredits > 0
      ? await tx
          .select()
          .from(creditExpiresRecord)
          .where(
            and(
              eq(creditExpiresRecord.orgId, orgId),
              gt(creditExpiresRecord.remaining, 0),
              gt(creditExpiresRecord.expiresAt, at),
            ),
          )
          .orderBy(
            asc(creditExpiresRecord.expiresAt),
            asc(creditExpiresRecord.id),
          )
          .for("update")
      : [];
  return {
    deduction,
    expiry: planExpiryLotDeductions(lots, deduction.sharedCredits, at),
  };
}
