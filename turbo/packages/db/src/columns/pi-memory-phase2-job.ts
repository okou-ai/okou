import { integer, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

export const PI_MEMORY_PHASE2_JOB_STATUSES = [
  "idle",
  "pending",
  "leased",
  "retryable_failure",
  "terminal_failure",
] as const;

export type PiMemoryPhase2JobStatus =
  (typeof PI_MEMORY_PHASE2_JOB_STATUSES)[number];

export function piMemoryPhase2JobColumns() {
  return {
    memoryStorageId: uuid("memory_storage_id").notNull(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    status: varchar("status", { length: 32 })
      .$type<PiMemoryPhase2JobStatus>()
      .default("pending")
      .notNull(),
    inputRevision: integer("input_revision").default(1).notNull(),
    completedRevision: integer("completed_revision").default(0).notNull(),
    reconciliationRevision: integer("reconciliation_revision")
      .default(0)
      .notNull(),
    claimedRevision: integer("claimed_revision"),
    claimedBaseVersionId: varchar("claimed_base_version_id", { length: 64 }),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at"),
    maintenanceRunId: uuid("maintenance_run_id"),
    retryCount: integer("retry_count").default(0).notNull(),
    retryAt: timestamp("retry_at"),
    lastErrorClass: varchar("last_error_class", { length: 128 }),
    lastSucceededAt: timestamp("last_succeeded_at"),
    claimedSelectionDigest: varchar("claimed_selection_digest", {
      length: 64,
    }),
    claimedSelectedCount: integer("claimed_selected_count"),
    claimedSelectedUtf8Bytes: integer("claimed_selected_utf8_bytes"),
    lastObservedHeadVersionId: varchar("last_observed_head_version_id", {
      length: 64,
    }),
    conflictCount: integer("conflict_count").default(0).notNull(),
    lastConflictAt: timestamp("last_conflict_at"),
    lastConflictingHeadVersionId: varchar("last_conflicting_head_version_id", {
      length: 64,
    }),
    lastPublishedVersionId: varchar("last_published_version_id", {
      length: 64,
    }),
    lastPublishedAt: timestamp("last_published_at"),
    lastMaintenanceRunId: uuid("last_maintenance_run_id"),
    lastMaintenanceRevision: integer("last_maintenance_revision"),
    lastMaintenanceBaseVersionId: varchar("last_maintenance_base_version_id", {
      length: 64,
    }),
    lastMaintenanceSelectionDigest: varchar(
      "last_maintenance_selection_digest",
      { length: 64 },
    ),
    lastMaintenanceOutcome: varchar("last_maintenance_outcome", {
      length: 32,
    }).$type<"published" | "no_diff" | "failed">(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  };
}
