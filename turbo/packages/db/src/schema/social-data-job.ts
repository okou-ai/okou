import type {
  SocialDataOperation,
  SocialDataPlatform,
} from "@okouai/api-contracts/contracts/social-data";
import type {
  SocialDataJobError,
  SocialDataJobRequest,
  SocialDataJobResult,
} from "@okouai/db/jsonb-contracts/social-data-job";
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

export const SOCIAL_DATA_JOB_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "unknown",
] as const;

export const socialDataJobs = pgTable(
  "social_data_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    requestId: uuid("request_id").notNull(),
    billingRunId: uuid("billing_run_id"),
    platform: varchar("platform", { length: 16 })
      .$type<SocialDataPlatform>()
      .notNull(),
    operation: varchar("operation", { length: 16 })
      .$type<SocialDataOperation>()
      .notNull(),
    request: jsonb("request").$type<SocialDataJobRequest>().notNull(),
    status: varchar("status", { length: 16 })
      .$type<(typeof SOCIAL_DATA_JOB_STATUSES)[number]>()
      .default("pending")
      .notNull(),
    providerName: text("provider_name").notNull(),
    providerEndpoint: text("provider_endpoint").notNull(),
    upstreamRunId: text("upstream_run_id"),
    result: jsonb("result").$type<SocialDataJobResult>(),
    error: jsonb("error").$type<SocialDataJobError>(),
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
    claimExpiresAt: timestamp("claim_expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  (table) => {
    return [
      uniqueIndex("uq_social_data_jobs_request").on(
        table.orgId,
        table.userId,
        table.requestId,
      ),
      uniqueIndex("uq_social_data_jobs_usage").on(table.usageIdempotencyKey),
      uniqueIndex("uq_social_data_jobs_upstream").on(table.upstreamRunId),
      index("idx_social_data_jobs_owner_id").on(
        table.orgId,
        table.userId,
        table.id.desc(),
      ),
      index("idx_social_data_jobs_reserved")
        .on(table.orgId)
        .where(sql`${table.reservedCredits} > 0`),
      check(
        "social_data_jobs_status_check",
        sql`${table.status} IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'unknown')`,
      ),
      check(
        "social_data_jobs_amounts_check",
        sql`${table.estimatedCostUsdMicros} >= 0
          AND ${table.actualCostUsdMicros} >= 0
          AND ${table.unitPrice} >= 0 AND ${table.unitSize} > 0
          AND ${table.maxCredits} >= 0
          AND ${table.reservedCredits} >= 0
          AND ${table.reservedCredits} <= ${table.maxCredits}
          AND ${table.creditsCharged} >= 0
          AND ${table.creditsCharged} <= ${table.maxCredits}`,
      ),
    ];
  },
);
