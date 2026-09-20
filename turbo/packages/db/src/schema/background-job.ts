import type { BackgroundJobData } from "@okouai/db/jsonb-contracts/background-job";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export type BackgroundJobStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/** Durable control state for handlers that finish work across bounded calls. */
export const backgroundJobs = pgTable(
  "background_jobs",
  {
    id: uuid("id").primaryKey(),
    kind: text("kind").notNull(),
    handlerVersion: integer("handler_version").notNull(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    input: jsonb("input").$type<BackgroundJobData>().notNull(),
    checkpoint: jsonb("checkpoint")
      .$type<BackgroundJobData>()
      .default({})
      .notNull(),
    status: text("status")
      .$type<BackgroundJobStatus>()
      .default("pending")
      .notNull(),
    availableAt: timestamp("available_at").defaultNow().notNull(),
    leaseId: uuid("lease_id"),
    leaseExpiresAt: timestamp("lease_expires_at"),
    failureCount: integer("failure_count").default(0).notNull(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  (table) => {
    return [
      index("idx_background_jobs_pending")
        .on(table.kind, table.handlerVersion, table.availableAt, table.id)
        .where(sql`${table.status} = 'pending'`),
      index("idx_background_jobs_expired_lease")
        .on(table.kind, table.handlerVersion, table.leaseExpiresAt, table.id)
        .where(sql`${table.status} = 'running'`),
      index("idx_background_jobs_owner").on(table.userId, table.orgId),
      check(
        "background_jobs_status_check",
        sql`${table.status} IN ('pending', 'running', 'completed', 'failed', 'cancelled')`,
      ),
      check(
        "background_jobs_handler_version_check",
        sql`${table.handlerVersion} > 0`,
      ),
      check(
        "background_jobs_failure_count_check",
        sql`${table.failureCount} >= 0`,
      ),
      check(
        "background_jobs_lease_check",
        sql`(
          ${table.status} = 'running' AND
          ${table.leaseId} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL
        ) OR (
          ${table.status} <> 'running' AND
          ${table.leaseId} IS NULL AND ${table.leaseExpiresAt} IS NULL
        )`,
      ),
      check(
        "background_jobs_completion_check",
        sql`(
          ${table.status} IN ('pending', 'running') AND ${table.completedAt} IS NULL
        ) OR (
          ${table.status} IN ('completed', 'failed', 'cancelled') AND ${table.completedAt} IS NOT NULL
        )`,
      ),
    ];
  },
);
