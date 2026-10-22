import { commerceJobs } from "@okouai/db/schema/commerce-job";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { and, eq, getTableColumns, inArray, or, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { pgTextDecoder } from "../../lib/db-structured-result";
import { UsageSettlementSnapshotConflict } from "./credit-usage-batch";
import { managedUsageReceiptCredits } from "./managed-usage-record";

export const COMMERCE_RESOURCE = {
  kind: "commerce",
  provider: "dataforseo",
  category: "provider_cost_usd_micros",
} as const;

function commerceSettlementSelection() {
  return {
    ...getTableColumns(commerceJobs),
    xmin: sql`${commerceJobs}.xmin::text`.mapWith(pgTextDecoder).as("xmin"),
  };
}
export type CommerceSettlementJob = typeof commerceJobs.$inferSelect & {
  readonly xmin: string;
};

export function commerceJobQuery(orgId: string, id: string) {
  return new QueryBuilder()
    .select(commerceSettlementSelection())
    .from(commerceJobs)
    .where(and(eq(commerceJobs.orgId, orgId), eq(commerceJobs.id, id)))
    .as("settlement_commerce_job");
}
export function commerceJobsForUsageQuery(
  orgId: string,
  keys: readonly string[],
) {
  return new QueryBuilder()
    .select(commerceSettlementSelection())
    .from(commerceJobs)
    .where(
      and(
        eq(commerceJobs.orgId, orgId),
        inArray(commerceJobs.usageIdempotencyKey, [...keys]),
      ),
    )
    .as("usage_commerce_jobs");
}
export function commerceClaimUnavailable(
  id: string | undefined,
  job: CommerceSettlementJob | undefined,
) {
  return id !== undefined && (!job || job.status !== "running");
}
export function commercePlan(
  prepared: readonly CommerceSettlementJob[],
  job: CommerceSettlementJob | undefined,
) {
  if (!job) {
    return undefined;
  }
  if (
    !prepared.some((row) => {
      return row.id === job.id && row.xmin === job.xmin;
    })
  ) {
    throw new UsageSettlementSnapshotConflict(
      "Commerce checkpoint changed during preparation",
    );
  }
  return commerceUsage(job);
}
function commerceUsage(job: CommerceSettlementJob) {
  if (
    job.status !== "running" ||
    !job.result ||
    job.result.billingQuantity <= 0
  ) {
    throw new UsageSettlementSnapshotConflict(
      "Commerce job is not awaiting billing",
    );
  }
  return {
    actor: {
      orgId: job.orgId,
      userId: job.userId,
      ...(job.runId ? { runId: job.runId } : {}),
    },
    resource: { ...COMMERCE_RESOURCE, quantity: job.result.billingQuantity },
    idempotencyKey: job.usageIdempotencyKey,
    label: "Commerce DataForSEO",
  };
}

function commerceSettledWhere(job: CommerceSettlementJob) {
  return and(
    eq(commerceJobs.id, job.id),
    eq(commerceJobs.orgId, job.orgId),
    eq(commerceJobs.usageIdempotencyKey, job.usageIdempotencyKey),
    eq(commerceJobs.status, "running"),
    sql`${commerceJobs}.xmin::text = ${job.xmin}`,
  );
}

/** Pure SQL plan. The owner executes it after pricing inside the debit transaction.
 * Only actual claimed event IDs can publish receipts, including in global batches.
 * A mismatch rejects the whole debit rather than leaving charged/unpublished work. */
export function commerceReceiptPlan(
  jobs: readonly CommerceSettlementJob[],
  events: readonly (typeof usageEvent.$inferSelect)[],
  at: Date,
) {
  const matched = jobs.filter((job) => {
    const event = events.find((row) => {
      return row.idempotencyKey === job.usageIdempotencyKey;
    });
    if (!event) {
      return false;
    }
    managedUsageReceiptCredits(commerceUsage(job), event);
    return true;
  });
  const where = or(...matched.map(commerceSettledWhere)) ?? sql`false`;
  return {
    expected: matched.length,
    sql: sql`
      UPDATE ${commerceJobs} SET
        status = CASE WHEN ${commerceJobs.error} IS NULL THEN 'completed' ELSE 'failed' END,
        result = jsonb_set(${commerceJobs.result}, '{creditsCharged}', to_jsonb(${usageEvent.creditsCharged})),
        updated_at = ${sql.param(at, commerceJobs.updatedAt)}
      FROM ${usageEvent}
      WHERE ${where}
        AND ${eq(usageEvent.idempotencyKey, commerceJobs.usageIdempotencyKey)}
        AND ${eq(usageEvent.orgId, commerceJobs.orgId)}
        AND ${eq(usageEvent.userId, commerceJobs.userId)}
        AND ${inArray(
          usageEvent.id,
          events.map((event) => {
            return event.id;
          }),
        )}
        AND ${usageEvent.status} = 'processed'
        AND ${usageEvent.creditsCharged} IS NOT NULL
        AND ${usageEvent.billingError} IS NULL
    `,
  };
}
export function requireCommerceSettlement(
  expected: number,
  updated: number | null | undefined,
) {
  if (updated !== expected) {
    throw new UsageSettlementSnapshotConflict(
      "Commerce receipt changed during billing",
    );
  }
}
