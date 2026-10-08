import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { and, eq, gt, lte, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { z } from "zod";

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

/**
 * A plain read in the settling transaction. Expiration that commits after it
 * clears only lots that expired after this read (the serial order "settle,
 * then expire"); a clear that races a planned lot deduction is rejected by one
 * of the two conditional writes, and that writer reports a deterministic
 * conflict instead of re-reading.
 */
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

export class OrgCreditExpirationConflict extends Error {
  constructor(readonly orgId: string) {
    super(`Organization ${orgId} credit expiration lost a concurrent write`);
    this.name = "OrgCreditExpirationConflict";
  }
}

export interface OrgCreditExpirationOutcome {
  /** The organization wallet row existed in the statement snapshot. */
  readonly wallet: boolean;
  readonly expected: number;
  readonly cleared: number;
}

export const orgCreditExpirationOutcomeRow = z.object({
  wallet: z.boolean(),
  expected: z.coerce.number().int(),
  cleared: z.coerce.number().int(),
});

export function orgCreditExpirationOutcome(
  rows: readonly OrgCreditExpirationOutcome[],
): OrgCreditExpirationOutcome {
  const [row] = rows;
  if (!row) {
    throw new Error("Organization credit expiration returned no outcome");
  }
  return row;
}

/**
 * A lot the statement snapshot selected but did not clear was changed by a
 * concurrent writer that committed first. When that writer was another
 * expiration (or an extension that un-expired the lot), no expired remainder
 * is left and its own clamp covered those lots: this outcome is complete.
 * Only expired remainder that is still present afterwards is a conflict;
 * throwing rolls the owning transaction back and the caller reports it once
 * (the next writer or cron cycle expires again), never an in-place re-read.
 */
export function requireCompleteOrgCreditExpiration(
  orgId: string,
  outcome: OrgCreditExpirationOutcome,
  remaining: { readonly id: string } | undefined,
): void {
  if (outcome.wallet && outcome.cleared !== outcome.expected && remaining) {
    throw new OrgCreditExpirationConflict(orgId);
  }
}

/**
 * One statement, no explicit row lock, over the complete expired cohort (R1
 * compatibility: pre-R1 adders do not reject expired remainder, so expiration
 * stays one atomic wallet clamp). The snapshot selects the expired lots with
 * their row versions; each lot is cleared only if it still has that version
 * (EvalPlanQual re-checks a lot another writer changed while this statement
 * waited for it). The wallet clamp is atomic arithmetic over the amounts
 * actually cleared. The caller rejects `cleared <> expected`, so a partially
 * applied clamp with expired remainder left behind never commits.
 */
export function orgCreditExpirationSql(orgId: string, at: Date) {
  return sql`WITH wallet AS MATERIALIZED (
    SELECT EXISTS (
      SELECT 1 FROM ${orgMetadata} WHERE ${orgMetadata.orgId} = ${orgId}
    ) AS present
  ), expired AS MATERIALIZED (
    SELECT ${creditExpiresRecord.id} AS id,
           ${creditExpiresRecord.remaining} AS remaining,
           ${creditExpiresRecord}.xmin::text AS observed_xmin
    FROM ${creditExpiresRecord}, wallet
    WHERE ${expiredOrgCreditsWhere(orgId, at)} AND wallet.present
  ), cleared AS (
    UPDATE ${creditExpiresRecord} SET remaining = 0
    FROM expired
    WHERE ${creditExpiresRecord.id} = expired.id
      AND ${creditExpiresRecord}.xmin::text = expired.observed_xmin
    RETURNING expired.remaining
  ), total AS (
    SELECT count(*)::int AS rows, COALESCE(sum(remaining), 0) AS amount
    FROM cleared
  ), debited AS (
    UPDATE ${orgMetadata}
    SET credits = GREATEST(${orgMetadata.credits} - total.amount, 0),
        updated_at = ${sql.param(at, orgMetadata.updatedAt)}
    FROM total
    WHERE ${orgMetadata.orgId} = ${orgId} AND total.amount > 0
    RETURNING ${orgMetadata.orgId}
  )
  SELECT wallet.present AS wallet,
         (SELECT count(*)::int FROM expired) AS expected, total.rows AS cleared
  FROM wallet, total`;
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
