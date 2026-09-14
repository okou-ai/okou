import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { agentRuns } from "./agent-run";
import type {
  BuiltInGenerationError,
  BuiltInGenerationRequest,
  BuiltInGenerationResult,
} from "@okouai/db/jsonb-contracts/built-in-generation-job";
export type { BuiltInGenerationError } from "@okouai/db/jsonb-contracts/built-in-generation-job";

export const BUILT_IN_GENERATION_TYPES = [
  "image",
  "video",
  "presentation",
  "website",
] as const;
export type BuiltInGenerationType = (typeof BUILT_IN_GENERATION_TYPES)[number];

export const BUILT_IN_GENERATION_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
] as const;
export type BuiltInGenerationStatus =
  (typeof BUILT_IN_GENERATION_STATUSES)[number];

export const builtInGenerationJobs = pgTable(
  "built_in_generation_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    type: varchar("type", { length: 32 })
      .$type<BuiltInGenerationType>()
      .notNull(),
    status: varchar("status", { length: 20 })
      .$type<BuiltInGenerationStatus>()
      .default("queued")
      .notNull(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    runId: uuid("run_id").references(
      () => {
        return agentRuns.id;
      },
      { onDelete: "set null" },
    ),
    // Preserve the original association across a late provider callback. This
    // metadata follows the job's normal deletion lifecycle, not billing retention.
    billingRunId: uuid("billing_run_id"),
    billingContext: text("billing_context").notNull().default("legacy_unknown"),
    request: jsonb("request").$type<BuiltInGenerationRequest>().notNull(),
    result: jsonb("result").$type<BuiltInGenerationResult>(),
    error: jsonb("error").$type<BuiltInGenerationError>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
  },
  (table) => {
    return [
      index("idx_built_in_generation_jobs_user_created").on(
        table.userId,
        table.createdAt.desc(),
      ),
      index("idx_built_in_generation_jobs_org_status").on(
        table.orgId,
        table.status,
      ),
      index("idx_built_in_generation_jobs_run").on(table.runId),
    ];
  },
);
