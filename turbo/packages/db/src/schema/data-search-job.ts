import type {
  DataSearchJobRequest,
  DataSearchJobResult,
  DataSearchJobError,
  DataSearchJobPlan,
} from "@okouai/db/jsonb-contracts/data-search-job";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const dataSearchJobs = pgTable(
  "data_search_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    requestId: uuid("request_id").notNull(),
    billingRunId: uuid("billing_run_id"),
    capability: text("capability").notNull(),
    request: jsonb("request").$type<DataSearchJobRequest>().notNull(),
    plan: jsonb("plan").$type<DataSearchJobPlan>().notNull(),
    status: varchar("status", { length: 16 })
      .$type<
        "pending" | "running" | "completed" | "failed" | "cancelled" | "unknown"
      >()
      .default("pending")
      .notNull(),
    providerName: text("provider_name").notNull(),
    providerEndpoint: text("provider_endpoint").notNull(),
    upstreamRunId: text("upstream_run_id"),
    result: jsonb("result").$type<DataSearchJobResult>(),
    error: jsonb("error").$type<DataSearchJobError>(),
    estimatedCostUsdMicros: bigint("estimated_cost_usd_micros", {
      mode: "number",
    }).notNull(),
    actualCostUsdMicros: bigint("actual_cost_usd_micros", { mode: "number" }),
    unitPrice: bigint("unit_price", { mode: "number" }).notNull(),
    unitSize: bigint("unit_size", { mode: "number" }).notNull(),
    maxCredits: bigint("max_credits", { mode: "number" }).notNull(),
    reservedCredits: bigint("reserved_credits", { mode: "number" }).notNull(),
    creditsCharged: bigint("credits_charged", { mode: "number" }),
    usageIdempotencyKey: uuid("usage_idempotency_key")
      .defaultRandom()
      .notNull(),
    startedAt: timestamp("started_at"),
    stopRequestedAt: timestamp("stop_requested_at"),
    stopSubmittedAt: timestamp("stop_submitted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  (table) => {
    return [
      uniqueIndex("uq_data_search_jobs_request").on(
        table.orgId,
        table.userId,
        table.requestId,
      ),
      uniqueIndex("uq_data_search_jobs_usage").on(table.usageIdempotencyKey),
      uniqueIndex("uq_data_search_jobs_upstream").on(
        table.providerName,
        table.upstreamRunId,
      ),
      index("idx_data_search_jobs_owner").on(
        table.orgId,
        table.userId,
        table.createdAt.desc(),
        table.id.desc(),
      ),
      index("idx_data_search_jobs_reserved")
        .on(table.orgId)
        .where(sql`${table.creditsCharged} IS NULL`),
      check(
        "data_search_jobs_status_check",
        sql`${table.status} IN ('pending','running','completed','failed','cancelled','unknown')`,
      ),
      check(
        "data_search_jobs_amounts_check",
        sql`${table.estimatedCostUsdMicros} >= 0 AND ${table.actualCostUsdMicros} >= 0 AND ${table.unitPrice} >= 0 AND ${table.unitSize} > 0 AND ${table.maxCredits} >= 0 AND ${table.reservedCredits} >= 0 AND ${table.reservedCredits} <= ${table.maxCredits} AND ${table.creditsCharged} >= 0 AND ${table.creditsCharged} <= ${table.maxCredits}`,
      ),
    ];
  },
);
