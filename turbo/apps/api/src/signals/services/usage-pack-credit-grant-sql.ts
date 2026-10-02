import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import { usagePackCreditRefunds } from "@okouai/db/schema/usage-pack-credit-refund";
import { sql } from "drizzle-orm";

export interface InvoiceUsagePackCreditGrant {
  readonly orgId: string;
  readonly userId: string;
  readonly grantType: "purchased" | "bonus";
  readonly idempotencyKey: string;
  readonly amount: number;
  readonly expiresAt: Date;
  readonly refund?:
    | {
        readonly invoiceId: string;
        readonly invoiceLineId: string | null;
        readonly amountCents: number;
      }
    | {
        readonly paymentIntentId: string;
        readonly amountCents: number;
      };
}

/**
 * The command executes this statement and requires rowCount === 1. Conflict
 * updates retain every mutable grant/refund field; only identical immutable
 * payment identities return a row. A mismatch aborts the owning transaction.
 */
export function invoiceUsagePackCreditGrantSql(
  grant: InvoiceUsagePackCreditGrant,
) {
  const refund = grant.refund;
  if (
    refund &&
    (grant.grantType !== "purchased" ||
      !Number.isSafeInteger(refund.amountCents) ||
      refund.amountCents < 0)
  ) {
    throw new Error("Invalid usage pack refund source");
  }
  const credit = sql`INSERT INTO ${usagePackCreditGrants}
    (org_id, user_id, grant_type, idempotency_key, original_amount, remaining_amount, expires_at)
    VALUES (${grant.orgId}, ${grant.userId}, ${grant.grantType}, ${grant.idempotencyKey}, ${grant.amount}, ${grant.amount}, ${sql.param(grant.expiresAt, usagePackCreditGrants.expiresAt)})
    ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
    WHERE ${usagePackCreditGrants.orgId} = EXCLUDED.org_id
      AND ${usagePackCreditGrants.userId} = EXCLUDED.user_id
      AND ${usagePackCreditGrants.grantType} = EXCLUDED.grant_type
      AND ${usagePackCreditGrants.originalAmount} = EXCLUDED.original_amount
      AND ${usagePackCreditGrants.expiresAt} = EXCLUDED.expires_at
    RETURNING id`;
  if (!refund) {
    return credit;
  }
  const paymentIntent = "paymentIntentId" in refund;
  const sourceType = paymentIntent ? "payment_intent" : "invoice";
  const invoiceId = paymentIntent ? null : refund.invoiceId;
  const invoiceLineId = paymentIntent ? null : refund.invoiceLineId;
  const paymentIntentId = paymentIntent ? refund.paymentIntentId : null;
  return sql`WITH grant_row AS (${credit})
    INSERT INTO ${usagePackCreditRefunds}
      (credit_grant_id, org_id, user_id, source_type, stripe_invoice_id, stripe_invoice_line_id, stripe_payment_intent_id, source_amount_cents)
    SELECT id, ${grant.orgId}, ${grant.userId}, ${sourceType}, ${invoiceId}, ${invoiceLineId}, ${paymentIntentId}, ${refund.amountCents} FROM grant_row
    ON CONFLICT (credit_grant_id) DO UPDATE SET credit_grant_id = EXCLUDED.credit_grant_id
    WHERE ${usagePackCreditRefunds.orgId} = EXCLUDED.org_id
      AND ${usagePackCreditRefunds.userId} = EXCLUDED.user_id
      AND ${usagePackCreditRefunds.sourceType} = EXCLUDED.source_type
      AND ${usagePackCreditRefunds.stripeInvoiceId} IS NOT DISTINCT FROM EXCLUDED.stripe_invoice_id
      AND ${usagePackCreditRefunds.stripeInvoiceLineId} IS NOT DISTINCT FROM EXCLUDED.stripe_invoice_line_id
      AND ${usagePackCreditRefunds.stripePaymentIntentId} IS NOT DISTINCT FROM EXCLUDED.stripe_payment_intent_id
      AND ${usagePackCreditRefunds.sourceAmountCents} = EXCLUDED.source_amount_cents
    RETURNING credit_grant_id`;
}
