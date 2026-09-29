import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { and, eq, gt, lte, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

export class OrgCreditExpirationRequired extends Error {
  constructor(readonly orgId: string) {
    super(`Organization ${orgId} has credits awaiting expiration`);
    this.name = "OrgCreditExpirationRequired";
  }
}

export function expiredOrgCreditsWhere(orgId: string, at: Date) {
  return and(
    eq(creditExpiresRecord.orgId, orgId),
    gt(creditExpiresRecord.remaining, 0),
    lte(creditExpiresRecord.expiresAt, at),
  );
}

/** Execute only while owning this organization's wallet row. */
export function pendingOrgCreditExpirationQuery(orgId: string, at: Date) {
  return new QueryBuilder()
    .select({ id: creditExpiresRecord.id })
    .from(creditExpiresRecord)
    .where(expiredOrgCreditsWhere(orgId, at))
    .limit(1)
    .as("pending_org_credit_expiration");
}

export function requireNoPendingOrgCreditExpiration(
  orgId: string,
  pending: { readonly id: string } | undefined,
): void {
  if (pending) {
    throw new OrgCreditExpirationRequired(orgId);
  }
}

/**
 * R1 compatibility: expiration is still one atomic wallet clamp. The pre-R1
 * adders do not reject expired remainder, so committing partial expiration can
 * erase or retain the wrong part of a concurrent purchase. R2 can bound this
 * command only after all those adders, debt clearers and extenders drain.
 */
export function atomicOrgCreditExpirationSql(orgId: string, at: Date) {
  return sql`WITH expired AS MATERIALIZED (
    SELECT ${creditExpiresRecord.id} AS id,
           ${creditExpiresRecord.remaining} AS remaining
    FROM ${creditExpiresRecord}
    WHERE ${expiredOrgCreditsWhere(orgId, at)}
    ORDER BY ${creditExpiresRecord.expiresAt}, ${creditExpiresRecord.id}
    FOR UPDATE
  ), cleared AS (
    UPDATE ${creditExpiresRecord} SET remaining = 0
    FROM expired WHERE ${creditExpiresRecord.id} = expired.id
    RETURNING expired.remaining
  ), total AS (
    SELECT sum(remaining) AS amount FROM cleared
  )
  UPDATE ${orgMetadata}
  SET credits = GREATEST(${orgMetadata.credits} - total.amount, 0),
      updated_at = ${sql.param(at, orgMetadata.updatedAt)}
  FROM total
  WHERE ${orgMetadata.orgId} = ${orgId} AND total.amount > 0`;
}

/** Existing invoice identity and its arithmetic balance increment commit together. */
export function orgCreditInvoiceGrantSql(
  orgId: string,
  grant: {
    readonly source: string;
    readonly stripeInvoiceId: string;
    readonly amount: number;
    readonly expiresAt: Date;
  },
  at: Date,
) {
  return sql`WITH receipt AS (
    INSERT INTO ${creditExpiresRecord} (org_id, source, stripe_invoice_id, amount, remaining, expires_at)
    VALUES (${orgId}, ${grant.source}, ${grant.stripeInvoiceId}, ${grant.amount}, ${grant.amount}, ${sql.param(grant.expiresAt, creditExpiresRecord.expiresAt)})
    ON CONFLICT DO NOTHING RETURNING id
  ) UPDATE ${orgMetadata} SET credits = credits + ${grant.amount}, updated_at = ${sql.param(at, orgMetadata.updatedAt)}
    WHERE ${orgMetadata.orgId} = ${orgId} AND EXISTS (SELECT 1 FROM receipt)`;
}

export function trialCreditExtensionWhere(orgId: string, amount: number) {
  return and(
    eq(creditExpiresRecord.orgId, orgId),
    eq(creditExpiresRecord.source, "subscription_renewal"),
    eq(creditExpiresRecord.amount, amount),
    gt(creditExpiresRecord.remaining, 0),
  );
}
