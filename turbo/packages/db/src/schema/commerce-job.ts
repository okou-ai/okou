import type {
  CommerceJobError,
  CommerceJobMarketplace,
  CommerceJobOperation,
  CommerceJobRequest,
  CommerceJobResult,
  CommerceJobStatus,
} from "@okouai/db/jsonb-contracts/commerce-job";
import {
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const commerceJobs = pgTable(
  "commerce_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    // Billing attribution survives the originating run's completion or deletion.
    runId: uuid("run_id"),
    operation: text("operation").$type<CommerceJobOperation>().notNull(),
    marketplace: text("marketplace").$type<CommerceJobMarketplace>().notNull(),
    // Pending is submission-only; persist the provider task ID before running.
    // Stale pending submissions fail as unknown outcomes and must never resubmit.
    status: text("status")
      .$type<CommerceJobStatus>()
      .default("pending")
      .notNull(),
    request: jsonb("request").$type<CommerceJobRequest>().notNull(),
    providerTaskId: text("provider_task_id"),
    providerCostUsd: doublePrecision("provider_cost_usd"),
    result: jsonb("result").$type<CommerceJobResult>(),
    error: jsonb("error").$type<CommerceJobError>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_commerce_jobs_status_created_at").on(
        table.status,
        table.createdAt,
      ),
    ];
  },
);
