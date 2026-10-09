import { orgMetadata } from "../schema/org-metadata";
import { creditExpiresRecord } from "../schema/credit-expires-record";
import { usagePackCreditGrants } from "../schema/usage-pack-credit-grant";
import { usagePackOverdraftTransfers } from "../schema/usage-pack-overdraft-transfer";
import { asc, eq, gt, lt, lte, sql } from "drizzle-orm";

/** Pure statement: wallet lock, expiry, grant clearing and audited debt commit atomically. */
export function usagePackOverdraftTransferSql(
  owner: { readonly orgId: string; readonly userId?: string },
  at: Date,
) {
  const member =
    owner.userId === undefined
      ? sql.empty()
      : sql`AND ${eq(usagePackCreditGrants.userId, owner.userId)}`;
  return sql`WITH wallet AS MATERIALIZED (
      SELECT ${orgMetadata.orgId} FROM ${orgMetadata}
      WHERE ${eq(orgMetadata.orgId, owner.orgId)} FOR UPDATE
    ), negative AS MATERIALIZED (
      SELECT ${usagePackCreditGrants.id} AS id,
        ${usagePackCreditGrants.userId} AS user_id,
        -${usagePackCreditGrants.remainingAmount} AS amount
      FROM ${usagePackCreditGrants}
      WHERE ${eq(usagePackCreditGrants.orgId, owner.orgId)}
        AND ${lt(usagePackCreditGrants.remainingAmount, 0)} ${member}
        -- Force wallet-lock evaluation even when no wallet exists; report debt without clearing it.
        AND (SELECT count(*) FROM wallet) >= 0
      ORDER BY ${asc(usagePackCreditGrants.id)} FOR UPDATE
    ), expired AS MATERIALIZED (
      SELECT ${creditExpiresRecord.id} AS id, ${creditExpiresRecord.remaining} AS remaining
      FROM ${creditExpiresRecord} WHERE ${eq(creditExpiresRecord.orgId, owner.orgId)}
        AND ${gt(creditExpiresRecord.remaining, 0)} AND ${lte(creditExpiresRecord.expiresAt, at)}
        AND EXISTS (SELECT 1 FROM wallet) AND EXISTS (SELECT 1 FROM negative)
      ORDER BY ${asc(creditExpiresRecord.id)} FOR UPDATE
    ), cleared_expiry AS (
      UPDATE ${creditExpiresRecord} AS lots SET remaining = 0
      FROM expired WHERE lots.id = expired.id RETURNING expired.remaining
    ), cleared AS (
      UPDATE ${usagePackCreditGrants} AS grants SET remaining_amount = 0
      FROM negative WHERE grants.id = negative.id AND EXISTS (SELECT 1 FROM wallet)
      RETURNING negative.id, negative.user_id, negative.amount
    ), audited AS (
      INSERT INTO ${usagePackOverdraftTransfers} (org_id, user_id, credit_grant_id, amount, created_at)
      SELECT ${owner.orgId}, user_id, id, amount, ${sql.param(at, usagePackOverdraftTransfers.createdAt)} FROM cleared
      RETURNING amount
    ), debited AS (
      UPDATE ${orgMetadata} AS org SET credits =
        (CASE WHEN expiry.amount > 0 THEN GREATEST(org.credits - expiry.amount, 0)
          ELSE org.credits END) - debt.amount,
        updated_at = ${sql.param(at, orgMetadata.updatedAt)}
      FROM (SELECT COALESCE(sum(amount), 0) AS amount FROM audited) AS debt,
        (SELECT COALESCE(sum(remaining), 0) AS amount FROM cleared_expiry) AS expiry
      WHERE org.org_id = ${owner.orgId} AND debt.amount > 0
      RETURNING org.org_id
    ) SELECT EXISTS (SELECT 1 FROM wallet) AS has_wallet,
      (SELECT count(*)::text FROM negative) AS negative_grants,
      (SELECT COALESCE(sum(amount), 0)::text FROM audited) AS amount`;
}
