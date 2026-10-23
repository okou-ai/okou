import {
  usagePackAllocationChanges,
  usagePackInvoiceFulfillments,
} from "@okouai/db/schema/usage-pack-subscription";
import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import { usagePackCreditRefunds } from "@okouai/db/schema/usage-pack-credit-refund";
import {
  and,
  eq,
  getTableColumns,
  isNull,
  isNotNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  PgDialect,
  QueryBuilder,
  type PgTable,
  type PgColumn,
} from "drizzle-orm/pg-core";
import * as z from "zod";
import { zodDriverValueDecoder } from "../../lib/db-structured-result";
import { pgTimestampWithoutTimezoneToDateSchema } from "../../lib/db-raw-rows";

type Change = typeof usagePackAllocationChanges.$inferSelect;
export interface UpgradeInvoicePublicationFacts {
  readonly change: Change;
  readonly invoiceId: string;
  readonly purchasedCredits: number;
  readonly bonusCredits: number;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly completedAt: Date;
  readonly grantCreatedAt: string | null;
  readonly refundCalculationValid: boolean;
  readonly refundAmountValid: boolean;
  readonly sourceAmountCents: number | null;
  readonly sourceInvoiceLine: string | null;
}
function returned(columns: Readonly<Record<string, PgColumn>>) {
  return Object.entries(columns).map(([name, field]) => {
    return { path: [name], field };
  });
}
function insertSelect(
  table: PgTable,
  selection: SQL,
  conflict: PgColumn,
  columns: Readonly<Record<string, PgColumn>>,
) {
  return new PgDialect().buildInsertQuery({
    table,
    values: selection,
    select: true,
    onConflict: sql`(${sql.identifier(conflict.name)}) DO UPDATE SET ${sql.identifier(conflict.name)} = ${conflict}`,
    returning: returned(columns),
  });
}
function invoiceReceiptInsert(f: UpgradeInvoicePublicationFacts) {
  const t = usagePackInvoiceFulfillments;
  return new PgDialect().buildInsertQuery({
    table: t,
    values: [
      {
        stripeInvoiceId: sql.param(f.invoiceId, t.stripeInvoiceId),
        usagePackSubscriptionId: sql.param(
          f.change.usagePackSubscriptionId,
          t.usagePackSubscriptionId,
        ),
        periodStart: sql.param(f.periodStart, t.periodStart),
        periodEnd: sql.param(f.periodEnd, t.periodEnd),
        createdAt: sql.param(f.completedAt, t.createdAt),
      },
    ],
    onConflict: sql`do nothing`,
    returning: returned(getTableColumns(t)),
  });
}
function invoiceReceiptConflict(f: UpgradeInvoicePublicationFacts) {
  const t = usagePackInvoiceFulfillments;
  return insertSelect(
    t,
    sql`SELECT ${sql.param(f.invoiceId, t.stripeInvoiceId)}, ${sql.param(f.change.usagePackSubscriptionId, t.usagePackSubscriptionId)}::uuid, ${sql.param(f.periodStart, t.periodStart)}::timestamp, ${sql.param(f.periodEnd, t.periodEnd)}::timestamp, ${sql.param(f.completedAt, t.createdAt)}::timestamp WHERE NOT EXISTS (SELECT 1 FROM receipt_insert)`,
    t.stripeInvoiceId,
    getTableColumns(t),
  );
}
function upgradeChangeIdentity(change: Change) {
  return and(
    eq(usagePackAllocationChanges.orgId, change.orgId),
    eq(
      usagePackAllocationChanges.usagePackSubscriptionId,
      change.usagePackSubscriptionId,
    ),
    eq(usagePackAllocationChanges.kind, change.kind),
    sql`${usagePackAllocationChanges.subscriptionChangeId} IS NOT DISTINCT FROM ${change.subscriptionChangeId}`,
    sql`${usagePackAllocationChanges.userId} IS NOT DISTINCT FROM ${change.userId}`,
    sql`${usagePackAllocationChanges.sourceAllocationId} IS NOT DISTINCT FROM ${change.sourceAllocationId}`,
    sql`${usagePackAllocationChanges.replacementAllocationId} IS NOT DISTINCT FROM ${change.replacementAllocationId}`,
    sql`${usagePackAllocationChanges.sourceStripePriceId} IS NOT DISTINCT FROM ${change.sourceStripePriceId}`,
    sql`${usagePackAllocationChanges.targetStripePriceId} IS NOT DISTINCT FROM ${change.targetStripePriceId}`,
    sql`${usagePackAllocationChanges.sourceUsagePackUsd} IS NOT DISTINCT FROM ${change.sourceUsagePackUsd}`,
    sql`${usagePackAllocationChanges.targetUsagePackUsd} IS NOT DISTINCT FROM ${change.targetUsagePackUsd}`,
  );
}
function claimUpgradeChange(f: UpgradeInvoicePublicationFacts) {
  const t = usagePackAllocationChanges;
  return new PgDialect().buildUpdateQuery({
    table: t,
    set: {
      status: sql.param("completed", t.status),
      stripeInvoiceId: sql.param(f.invoiceId, t.stripeInvoiceId),
      completedAt: sql.param(f.completedAt, t.completedAt),
      updatedAt: sql.param(f.completedAt, t.updatedAt),
    },
    where: and(
      eq(t.id, f.change.id),
      eq(t.kind, "upgrade"),
      eq(t.status, "applied"),
      upgradeChangeIdentity(f.change),
      isNotNull(t.replacementAllocationId),
      or(isNull(t.stripeInvoiceId), eq(t.stripeInvoiceId, f.invoiceId)),
      sql`EXISTS (SELECT 1 FROM receipt_insert)`,
    ),
    joins: [],
    returning: returned({ id: t.id }),
  });
}
function upgradeGrantWinner(
  f: UpgradeInvoicePublicationFacts,
  type: "purchased" | "bonus",
) {
  const t = usagePackCreditGrants;
  const amount = type === "purchased" ? f.purchasedCredits : f.bonusCredits;
  const dependency =
    type === "purchased"
      ? sql`${f.refundCalculationValid}`
      : sql`(${f.purchasedCredits} <= 0 OR EXISTS (SELECT 1 FROM refund_valid))`;
  return insertSelect(
    t,
    sql`SELECT gen_random_uuid(), ${sql.param(f.change.orgId, t.orgId)}, ${sql.param(f.change.userId, t.userId)}, ${sql.param(type, t.grantType)}, ${sql.param(`usage-pack-change:${f.change.id}:${f.invoiceId}:${type}`, t.idempotencyKey)}, ${sql.param(amount, t.originalAmount)}, ${sql.param(amount, t.remainingAmount)}, ${sql.param(f.periodEnd, t.expiresAt)}::timestamp, ${f.grantCreatedAt}::timestamp FROM claimed WHERE ${amount} > 0 AND ${dependency}`,
    t.idempotencyKey,
    {
      id: t.id,
      orgId: t.orgId,
      userId: t.userId,
      grantType: t.grantType,
      originalAmount: t.originalAmount,
      expiresAt: t.expiresAt,
    },
  );
}
function upgradeRefundWinner(f: UpgradeInvoicePublicationFacts) {
  const t = usagePackCreditRefunds;
  return insertSelect(
    t,
    sql`SELECT id, ${sql.param(f.change.orgId, t.orgId)}, ${sql.param(f.change.userId, t.userId)}, 'invoice', ${sql.param(f.invoiceId, t.stripeInvoiceId)}, ${sql.param(f.sourceInvoiceLine, t.stripeInvoiceLineId)}, NULL, ${sql.param(f.sourceAmountCents, t.sourceAmountCents)}::bigint, 'available', NULL, NULL, NULL, NULL, NULL, 1, NULL, NULL, ${f.grantCreatedAt}::timestamp, ${f.grantCreatedAt}::timestamp FROM purchased_valid WHERE ${f.refundAmountValid}`,
    t.creditGrantId,
    {
      creditGrantId: t.creditGrantId,
      orgId: t.orgId,
      userId: t.userId,
      sourceType: t.sourceType,
      stripeInvoiceId: t.stripeInvoiceId,
      stripeInvoiceLineId: t.stripeInvoiceLineId,
      stripePaymentIntentId: t.stripePaymentIntentId,
      sourceAmountCents: t.sourceAmountCents,
    },
  );
}
function validGrant(
  f: UpgradeInvoicePublicationFacts,
  type: "purchased" | "bonus",
) {
  const amount = type === "purchased" ? f.purchasedCredits : f.bonusCredits;
  const source =
    type === "purchased" ? sql`purchased_winner` : sql`bonus_winner`;
  return sql`SELECT id FROM ${source} WHERE org_id = ${f.change.orgId} AND user_id = ${f.change.userId} AND grant_type = ${type} AND original_amount = ${amount} AND date_trunc('milliseconds', expires_at) = ${sql.param(f.periodEnd, usagePackCreditGrants.expiresAt)}::timestamp`;
}
function positivePublicationCtes(f: UpgradeInvoicePublicationFacts) {
  const qb = new QueryBuilder();
  return [
    qb.$with("purchased_winner", {}).as(upgradeGrantWinner(f, "purchased")),
    qb.$with("purchased_valid", {}).as(validGrant(f, "purchased")),
    qb.$with("refund_winner", {}).as(upgradeRefundWinner(f)),
    qb
      .$with("refund_valid", {})
      .as(
        sql`SELECT credit_grant_id FROM refund_winner WHERE org_id = ${f.change.orgId} AND user_id = ${f.change.userId} AND source_type = 'invoice' AND stripe_invoice_id IS NOT DISTINCT FROM ${f.invoiceId} AND stripe_invoice_line_id IS NOT DISTINCT FROM ${f.sourceInvoiceLine} AND stripe_payment_intent_id IS NULL AND source_amount_cents = ${f.sourceAmountCents}::bigint`,
      ),
    qb.$with("bonus_winner", {}).as(upgradeGrantWinner(f, "bonus")),
    qb.$with("bonus_valid", {}).as(validGrant(f, "bonus")),
  ];
}
function publicationGuard(
  f: UpgradeInvoicePublicationFacts,
  positive: boolean,
) {
  const guards = positive
    ? sql`
 WHEN ${f.purchasedCredits} > 0 AND NOT ${f.refundCalculationValid} THEN '__TX0271_ATOMIC_GUARD_V1_REFUND_CALC__'
 WHEN ${f.purchasedCredits} > 0 AND NOT EXISTS (SELECT 1 FROM purchased_valid) THEN '__TX0271_ATOMIC_GUARD_V1_PURCHASED_GRANT__'
 WHEN ${f.purchasedCredits} > 0 AND NOT ${f.refundAmountValid} THEN '__TX0271_ATOMIC_GUARD_V1_REFUND_AMOUNT__'
 WHEN ${f.purchasedCredits} > 0 AND NOT EXISTS (SELECT 1 FROM refund_valid) THEN '__TX0271_ATOMIC_GUARD_V1_REFUND_SOURCE__'
 WHEN ${f.bonusCredits} > 0 AND NOT EXISTS (SELECT 1 FROM bonus_valid) THEN '__TX0271_ATOMIC_GUARD_V1_BONUS_GRANT__'`
    : sql.empty();
  return sql`(CASE WHEN NOT inserted THEN '0' WHEN NOT EXISTS (SELECT 1 FROM claimed) THEN '__TX0271_ATOMIC_GUARD_V1_CHANGE__' ${guards} ELSE '0' END)::integer`;
}
/** Non-executing schema-aware leaves: no session, Db, Tx, callback or clock. */
export function upgradeInvoicePublicationPlan(
  f: UpgradeInvoicePublicationFacts,
) {
  const qb = new QueryBuilder();
  const positive = f.purchasedCredits > 0 || f.bonusCredits > 0;
  return {
    ctes: [
      qb.$with("receipt_insert", {}).as(invoiceReceiptInsert(f)),
      qb.$with("receipt_conflict_winner", {}).as(invoiceReceiptConflict(f)),
      qb
        .$with("receipt", {})
        .as(
          sql`SELECT true AS inserted, stripe_invoice_id, usage_pack_subscription_id, period_start, period_end FROM receipt_insert UNION ALL SELECT false, stripe_invoice_id, usage_pack_subscription_id, period_start, period_end FROM receipt_conflict_winner`,
        ),
      qb.$with("claimed", {}).as(claimUpgradeChange(f)),
      ...(positive ? positivePublicationCtes(f) : []),
    ],
    fields: {
      inserted: sql`inserted`.mapWith(zodDriverValueDecoder(z.boolean())),
      stripeInvoiceId: sql`stripe_invoice_id`.mapWith(
        zodDriverValueDecoder(z.string()),
      ),
      receiptSubscriptionId: sql`usage_pack_subscription_id`.mapWith(
        zodDriverValueDecoder(z.uuid()),
      ),
      receiptPeriodStart: sql`period_start::text`.mapWith(
        zodDriverValueDecoder(
          pgTimestampWithoutTimezoneToDateSchema.nullable(),
        ),
      ),
      receiptPeriodEnd: sql`period_end::text`.mapWith(
        zodDriverValueDecoder(pgTimestampWithoutTimezoneToDateSchema),
      ),
      atomicGuard: publicationGuard(f, positive).mapWith(
        zodDriverValueDecoder(z.literal(0)),
      ),
    },
  };
}
