import {
  usagePackAllocationChanges,
  usagePackInvoiceFulfillments,
} from "@okouai/db/schema/usage-pack-subscription";
import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import { usagePackCreditRefunds } from "@okouai/db/schema/usage-pack-credit-refund";
import { and, eq, getTableColumns, or, sql, type SQL } from "drizzle-orm";
import {
  PgDialect,
  QueryBuilder,
  type PgColumn,
  type PgTable,
} from "drizzle-orm/pg-core";
import { boolean, literal } from "zod";
import { zodDriverValueDecoder } from "../../lib/db-structured-result";
import type { UsagePackCreditGrantArgs } from "./usage-pack-credit.service";
import type { sourceColumns } from "./usage-pack-credit-refund.service";

interface GrantPublication {
  readonly grant: UsagePackCreditGrantArgs;
  readonly source: ReturnType<typeof sourceColumns> | null;
}
interface ChangePublication {
  readonly id: string;
  readonly condition: SQL | undefined;
  readonly completedAt: Date;
  readonly grants: readonly GrantPublication[];
}
function returned(columns: Readonly<Record<string, PgColumn>>) {
  return Object.entries(columns).map(([name, field]) => {
    return { path: [name], field };
  });
}
function insertWinner(table: PgTable, selection: SQL, conflict: PgColumn) {
  return new PgDialect().buildInsertQuery({
    table,
    values: selection,
    select: true,
    // Return the current winner without resetting spent credits or a refund's
    // lifecycle. The owning statement validates its immutable business facts.
    onConflict: sql`(${sql.identifier(conflict.name)}) DO UPDATE SET ${sql.identifier(conflict.name)} = ${conflict}`,
    returning: returned(getTableColumns(table)),
  });
}
function grantFacts(changes: readonly ChangePublication[]) {
  return changes.flatMap((change, changeIndex) => {
    return change.grants.map(({ grant, source }, grantIndex) => {
      return {
        change_index: changeIndex,
        grant_index: grantIndex,
        change_id: change.id,
        org_id: grant.orgId,
        user_id: grant.userId,
        grant_type: grant.grantType,
        idempotency_key: grant.idempotencyKey,
        original_amount: grant.amount,
        expires_at: usagePackCreditGrants.expiresAt.mapToDriverValue(
          grant.expiresAt,
        ),
        has_refund: grant.refundSource !== undefined,
        source_valid: source !== null,
        source_type: source?.sourceType ?? null,
        stripe_invoice_id: source?.stripeInvoiceId ?? null,
        stripe_invoice_line_id: source?.stripeInvoiceLineId ?? null,
        stripe_payment_intent_id: source?.stripePaymentIntentId ?? null,
        source_amount_cents: source?.sourceAmountCents ?? null,
      };
    });
  });
}
function receiptInsert(receipt: {
  readonly stripeInvoiceId: string;
  readonly usagePackSubscriptionId: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
}) {
  const t = usagePackInvoiceFulfillments;
  return new PgDialect().buildInsertQuery({
    table: t,
    values: [
      {
        stripeInvoiceId: sql.param(receipt.stripeInvoiceId, t.stripeInvoiceId),
        usagePackSubscriptionId: sql.param(
          receipt.usagePackSubscriptionId,
          t.usagePackSubscriptionId,
        ),
        periodStart: sql.param(receipt.periodStart, t.periodStart),
        periodEnd: sql.param(receipt.periodEnd, t.periodEnd),
      },
    ],
    onConflict: sql`do nothing`,
    returning: returned({ stripeInvoiceId: t.stripeInvoiceId }),
  });
}
function claimChanges(changes: readonly ChangePublication[]) {
  const t = usagePackAllocationChanges;
  return new PgDialect().buildUpdateQuery({
    table: t,
    set: {
      status: sql.param("completed", t.status),
      completedAt: sql`change_facts.completed_at`,
      updatedAt: sql`change_facts.completed_at`,
    },
    from: sql`change_facts`,
    where: and(
      eq(t.id, sql`change_facts.change_id`),
      // An empty list must never turn into an unconstrained UPDATE.
      changes.length
        ? or(
            ...changes.map((change) => {
              return change.condition;
            }),
          )
        : sql`false`,
      sql`EXISTS (SELECT 1 FROM receipt_insert)`,
    ),
    joins: [],
    returning: returned({ id: t.id }),
  });
}
function grantWinners() {
  return insertWinner(
    usagePackCreditGrants,
    sql`SELECT gen_random_uuid(), f.org_id, f.user_id, f.grant_type, f.idempotency_key, f.original_amount, f.original_amount, f.expires_at, CURRENT_TIMESTAMP FROM grant_facts f JOIN claimed c ON c.id = f.change_id`,
    usagePackCreditGrants.idempotencyKey,
  );
}
function refundWinners() {
  return insertWinner(
    usagePackCreditRefunds,
    sql`SELECT id, org_id, user_id, source_type, stripe_invoice_id, stripe_invoice_line_id, stripe_payment_intent_id, source_amount_cents, 'available', NULL, NULL, NULL, NULL, NULL, 1, NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM grant_valid WHERE has_refund AND source_valid`,
    usagePackCreditRefunds.creditGrantId,
  );
}
/** Fixed-size CTE graph; inputs and clocks are ordinary immutable values. */
export function subscriptionInvoicePublicationPlan(
  receipt: Parameters<typeof receiptInsert>[0],
  changes: readonly ChangePublication[],
) {
  const qb = new QueryBuilder();
  const changeFacts = changes.map((change, changeIndex) => {
    return {
      change_index: changeIndex,
      change_id: change.id,
      completed_at: usagePackAllocationChanges.completedAt.mapToDriverValue(
        change.completedAt,
      ),
    };
  });
  const grants = grantFacts(changes);
  return {
    ctes: [
      qb
        .$with("change_facts", {})
        .as(
          sql`SELECT * FROM jsonb_to_recordset(${JSON.stringify(changeFacts)}::jsonb) AS f(change_index integer, change_id uuid, completed_at timestamp)`,
        ),
      qb
        .$with("grant_facts", {})
        .as(
          sql`SELECT * FROM jsonb_to_recordset(${JSON.stringify(grants)}::jsonb) AS f(change_index integer, grant_index integer, change_id uuid, org_id text, user_id text, grant_type text, idempotency_key text, original_amount bigint, expires_at timestamp, has_refund boolean, source_valid boolean, source_type text, stripe_invoice_id text, stripe_invoice_line_id text, stripe_payment_intent_id text, source_amount_cents integer)`,
        ),
      qb.$with("receipt_insert", {}).as(receiptInsert(receipt)),
      qb.$with("claimed", {}).as(claimChanges(changes)),
      qb.$with("grant_winner", {}).as(grantWinners()),
      qb
        .$with("grant_valid", {})
        .as(
          sql`SELECT w.id, f.* FROM grant_winner w JOIN grant_facts f ON w.idempotency_key = f.idempotency_key WHERE w.org_id = f.org_id AND w.user_id = f.user_id AND w.grant_type = f.grant_type AND w.original_amount = f.original_amount AND date_trunc('milliseconds', w.expires_at) = f.expires_at`,
        ),
      qb.$with("refund_winner", {}).as(refundWinners()),
      qb
        .$with("refund_valid", {})
        .as(
          sql`SELECT w.credit_grant_id FROM refund_winner w JOIN grant_valid f ON w.credit_grant_id = f.id WHERE w.org_id = f.org_id AND w.user_id = f.user_id AND w.source_type = f.source_type AND w.stripe_invoice_id IS NOT DISTINCT FROM f.stripe_invoice_id AND w.stripe_invoice_line_id IS NOT DISTINCT FROM f.stripe_invoice_line_id AND w.stripe_payment_intent_id IS NOT DISTINCT FROM f.stripe_payment_intent_id AND w.source_amount_cents = f.source_amount_cents`,
        ),
      qb.$with("failures", {}).as(sql`
 SELECT change_index, -1 AS grant_index, 0 AS stage, '__TX0272_ATOMIC_GUARD_V1_CHANGE_' || change_index || '__' AS token FROM change_facts f WHERE NOT EXISTS (SELECT 1 FROM claimed c WHERE c.id = f.change_id)
 UNION ALL SELECT f.change_index, f.grant_index, 0, '__TX0272_ATOMIC_GUARD_V1_GRANT_' || f.change_index || '_' || f.grant_index || '__' FROM grant_facts f JOIN claimed c ON c.id = f.change_id WHERE NOT EXISTS (SELECT 1 FROM grant_valid v WHERE v.idempotency_key = f.idempotency_key)
 UNION ALL SELECT change_index, grant_index, 1, '__TX0272_ATOMIC_GUARD_V1_REFUND_AMOUNT_' || change_index || '_' || grant_index || '__' FROM grant_valid WHERE has_refund AND NOT source_valid
 UNION ALL SELECT f.change_index, f.grant_index, 2, '__TX0272_ATOMIC_GUARD_V1_REFUND_SOURCE_' || f.change_index || '_' || f.grant_index || '__' FROM grant_valid f WHERE has_refund AND source_valid AND NOT EXISTS (SELECT 1 FROM refund_valid v WHERE v.credit_grant_id = f.id)`),
    ],
    from: sql`(SELECT 1) AS publication`,
    fields: {
      inserted: sql`EXISTS (SELECT 1 FROM receipt_insert)`.mapWith(
        zodDriverValueDecoder(boolean()),
      ),
      atomicGuard:
        sql`(CASE WHEN NOT EXISTS (SELECT 1 FROM receipt_insert) THEN '0' ELSE COALESCE((SELECT token FROM failures ORDER BY change_index, grant_index, stage LIMIT 1), '0') END)::integer`.mapWith(
          zodDriverValueDecoder(literal(0)),
        ),
    },
  };
}
