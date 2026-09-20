import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { ExportArtifactUrls } from "@okouai/db/jsonb-contracts/export-job";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
export type { ExportArtifactUrl } from "@okouai/db/jsonb-contracts/export-job";

/**
 * Export Jobs table
 * Tracks async GDPR data export operations.
 * Jobs produce a ZIP file uploaded to R2 with a time-limited download link.
 * Follows the compose_jobs pattern for status tracking and idempotency.
 */
export const exportJobs = pgTable(
  "export_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    publicBrand: text("public_brand")
      .$type<PublicBrand>()
      .default("vm0")
      .notNull(),
    // pending -> running -> completed | failed
    status: varchar("status", { length: 20 }).notNull(),
    // NULL preserves exports admitted by the outgoing one-call executor.
    executionMode: text("execution_mode").$type<"durable-v1">(),
    s3Key: text("s3_key"),
    artifactUrls: jsonb("artifact_urls").$type<ExportArtifactUrls>(),
    error: text("error"),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  (table) => {
    return [
      // Index for finding active jobs by user (rate limit + idempotency check)
      index("idx_export_jobs_user_status").on(table.userId, table.status),
      // Index for cleanup job (finding expired jobs)
      index("idx_export_jobs_created").on(table.createdAt),
      // Partial unique index: only one active (pending/running) job per user.
      // Enforces idempotency at the DB level, preventing concurrent exports.
      uniqueIndex("idx_export_jobs_user_active")
        .on(table.userId)
        .where(sql`status IN ('pending', 'running')`),
    ];
  },
);
