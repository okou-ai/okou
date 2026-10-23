import { dataSearchJobs } from "@okouai/db/schema/data-search-job";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { and, eq, getTableColumns, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { pgTextDecoder } from "../../lib/db-structured-result";
import { UsageSettlementSnapshotConflict } from "./credit-usage-batch";
import {
  managedUsageReceiptCredits,
  type ManagedUsageRecordArgs,
} from "./managed-usage-record";

type Job = typeof dataSearchJobs.$inferSelect;

function dataSearchJobSelection() {
  return {
    ...getTableColumns(dataSearchJobs),
    xmin: sql`${dataSearchJobs}.xmin::text`.mapWith(pgTextDecoder).as("xmin"),
  };
}

/** The final receipt CAS rejects any job changed since this plain read. */
export function dataSearchJobQuery(orgId: string, jobId: string) {
  return new QueryBuilder()
    .select(dataSearchJobSelection())
    .from(dataSearchJobs)
    .where(and(eq(dataSearchJobs.orgId, orgId), eq(dataSearchJobs.id, jobId)))
    .as("settlement_data_search_job");
}

function dataSearchSettledWhere(job: Job & { readonly xmin: string }) {
  return sql`${dataSearchJobs.id} = ${job.id}
    AND ${dataSearchJobs.orgId} = ${job.orgId}
    AND ${dataSearchJobs.creditsCharged} IS NULL
    AND ${dataSearchJobs}.xmin::text = ${job.xmin}`;
}

export function requireDataSearchSettlement(
  updated: number | null | undefined,
) {
  if (updated !== 1) {
    throw new UsageSettlementSnapshotConflict(
      "Data Search settlement changed before its charge was recorded",
    );
  }
}

function dataSearchUsageArgs(
  job: Job | undefined,
): ManagedUsageRecordArgs | undefined {
  if (!job) {
    return undefined;
  }
  if (job.actualCostUsdMicros === null) {
    throw new Error("Completed Data Search job has no settlement cost");
  }
  if (job.actualCostUsdMicros === 0 || job.maxCredits === 0) {
    return undefined;
  }
  // Provider cost, not result count, determines billing, including empty results.
  return {
    actor: {
      orgId: job.orgId,
      userId: job.userId,
      ...(job.billingRunId ? { runId: job.billingRunId } : {}),
    },
    resource: {
      kind: "data-search",
      provider: job.providerName,
      category: "provider_cost_usd_micros",
      quantity: job.actualCostUsdMicros,
    },
    label: "Okou Data Search",
    idempotencyKey: job.usageIdempotencyKey,
    pricingSnapshot: {
      unitPrice: job.unitPrice,
      unitSize: job.unitSize,
      creditsLimit: job.maxCredits,
    },
  };
}

function dataSearchValues(
  args: ManagedUsageRecordArgs | undefined,
  receipt: typeof usageEvent.$inferSelect | undefined,
  at: Date,
) {
  return {
    creditsCharged: args ? managedUsageReceiptCredits(args, receipt) : 0,
    reservedCredits: 0,
    completedAt: at,
    updatedAt: at,
  };
}

/** Pure receipt write; a zero-row CAS rolls back the debit in its owning transaction. */
export function dataSearchReceiptSql(
  job: Job & { readonly xmin: string },
  args: ManagedUsageRecordArgs | undefined,
  receipt: typeof usageEvent.$inferSelect | undefined,
  at: Date,
) {
  const values = dataSearchValues(args, receipt, at);
  return sql`UPDATE ${dataSearchJobs}
    SET credits_charged = ${values.creditsCharged}, reserved_credits = 0,
      completed_at = ${sql.param(at, dataSearchJobs.completedAt)},
      updated_at = ${sql.param(at, dataSearchJobs.updatedAt)}
    WHERE ${dataSearchSettledWhere(job)}`;
}

export function dataSearchClaimUnavailable(
  jobId: string | undefined,
  job: Job | undefined,
) {
  return jobId !== undefined && (!job || job.creditsCharged !== null);
}

function dataSearchSettlementPlan(job: Job | undefined) {
  const usage = dataSearchUsageArgs(job);
  return { usage, processPending: job === undefined || usage !== undefined };
}

export interface PreparedDataSearchSettlement {
  readonly job: Job & { readonly xmin: string };
  readonly plan: ReturnType<typeof dataSearchSettlementPlan>;
  readonly grossCredits: number;
}

export function prepareDataSearchSettlement(
  job: (Job & { readonly xmin: string }) | undefined,
): PreparedDataSearchSettlement | undefined {
  if (!job || job.creditsCharged !== null) {
    return undefined;
  }
  const plan = dataSearchSettlementPlan(job);
  const price = plan.usage?.pricingSnapshot;
  const quantity = BigInt(plan.usage?.resource.quantity ?? 0);
  const credits = price
    ? (quantity * BigInt(price.unitPrice) + BigInt(price.unitSize) - 1n) /
      BigInt(price.unitSize)
    : 0n;
  return {
    job,
    plan,
    grossCredits: price
      ? Number(
          credits < BigInt(price.creditsLimit)
            ? credits
            : BigInt(price.creditsLimit),
        )
      : 0,
  };
}
