import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { and, eq, gt, inArray, lte, notInArray, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

export const ORG_CREDIT_EXPIRATION_BATCH_SIZE = 100;

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

/** A wallet owner checks completeness before choosing the R1 compatibility path. */
export function omittedOrgCreditExpirationQuery(
  orgId: string,
  at: Date,
  ids: readonly string[],
) {
  return new QueryBuilder()
    .select({ id: creditExpiresRecord.id })
    .from(creditExpiresRecord)
    .where(
      and(
        expiredOrgCreditsWhere(orgId, at),
        notInArray(creditExpiresRecord.id, ids),
      ),
    )
    .limit(1)
    .as("omitted_org_credit_expiration");
}

/** Only the finite prepared identities can be cleared by this write. */
export function boundedOrgCreditExpirationSql(
  orgId: string,
  at: Date,
  ids: readonly string[],
) {
  if (ids.length === 0 || ids.length > ORG_CREDIT_EXPIRATION_BATCH_SIZE) {
    throw new Error("Invalid organization credit expiration batch");
  }
  return orgCreditExpirationSql(orgId, at, ids);
}

/**
 * R1 compatibility: expiration is still one atomic wallet clamp. The pre-R1
 * adders do not reject expired remainder, so committing partial expiration can
 * erase or retain the wrong part of a concurrent purchase. Remove this fallback
 * only after all those adders, debt clearers and extenders drain. The bounded
 * owner already executes the finite write when its prepared set is complete.
 */
export function atomicOrgCreditExpirationSql(orgId: string, at: Date) {
  return orgCreditExpirationSql(orgId, at);
}

function orgCreditExpirationSql(
  orgId: string,
  at: Date,
  ids?: readonly string[],
) {
  return sql`WITH expired AS MATERIALIZED (
    SELECT ${creditExpiresRecord.id} AS id,
           ${creditExpiresRecord.remaining} AS remaining
    FROM ${creditExpiresRecord}
    WHERE ${and(expiredOrgCreditsWhere(orgId, at), ids ? inArray(creditExpiresRecord.id, ids) : undefined)}
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
