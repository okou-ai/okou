import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import { usagePackOverdraftTransfers } from "@okouai/db/schema/usage-pack-overdraft-transfer";
import { and, asc, eq, lt, sql } from "drizzle-orm";
import type { Tx } from "../../lib/db-types";
import { nowDate } from "../../lib/time";
import { expireOrgCreditsInTransaction } from "./org-credit-expiration.service";

/** Call before grant locks. Settlement and legacy repair use the same lock order. */
export async function lockUsagePackWallet(
  tx: Pick<Tx, "select">,
  orgId: string,
) {
  const [wallet] = await tx
    .select({ orgId: orgMetadata.orgId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .for("update");
  if (!wallet) {
    throw new Error("Usage settlement organization wallet is missing");
  }
}

/**
 * Only the caller's transaction may move debt. Zeroing a locked negative grant,
 * debiting its organization and retaining the audit receipt commit together.
 * Includes expired grants; expiry and member removal must not forgive debt.
 */
export async function transferUsagePackOverdraftsInTransaction(
  tx: Pick<Tx, "select" | "insert" | "update" | "execute">,
  owner: { readonly orgId: string; readonly userId?: string },
  at = nowDate(),
) {
  await lockUsagePackWallet(tx, owner.orgId);
  const grants = await tx
    .select()
    .from(usagePackCreditGrants)
    .where(
      and(
        eq(usagePackCreditGrants.orgId, owner.orgId),
        owner.userId === undefined
          ? undefined
          : eq(usagePackCreditGrants.userId, owner.userId),
        lt(usagePackCreditGrants.remainingAmount, 0),
      ),
    )
    .orderBy(asc(usagePackCreditGrants.id))
    .for("update");
  if (grants.length === 0) {
    return;
  }
  await expireOrgCreditsInTransaction(tx, owner.orgId, at);
  const amount = grants.reduce((total, grant) => {
    return total - grant.remainingAmount;
  }, 0);
  if (!Number.isSafeInteger(amount)) {
    throw new Error("Usage pack overdraft exceeds safe integer precision");
  }
  await tx.insert(usagePackOverdraftTransfers).values(
    grants.map((grant) => {
      return {
        orgId: owner.orgId,
        userId: grant.userId,
        creditGrantId: grant.id,
        amount: -grant.remainingAmount,
        createdAt: at,
      };
    }),
  );
  for (const grant of grants) {
    await tx
      .update(usagePackCreditGrants)
      .set({ remainingAmount: 0 })
      .where(eq(usagePackCreditGrants.id, grant.id));
  }
  await tx
    .update(orgMetadata)
    .set({ credits: sql`${orgMetadata.credits} - ${amount}`, updatedAt: at })
    .where(eq(orgMetadata.orgId, owner.orgId));
}
