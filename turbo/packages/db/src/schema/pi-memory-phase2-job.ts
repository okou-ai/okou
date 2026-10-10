import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { storages } from "./storage";

export const PI_MEMORY_PHASE2_JOB_STATUSES = [
  "idle",
  "pending",
  "leased",
  "retryable_failure",
  "terminal_failure",
] as const;

export type PiMemoryPhase2JobStatus =
  (typeof PI_MEMORY_PHASE2_JOB_STATUSES)[number];

export const PI_MEMORY_PHASE2_MAX_ATTEMPTS = 3;
export const PI_MEMORY_PHASE2_MAX_SELECTED_CANDIDATES = 256;
export const PI_MEMORY_PHASE2_MAX_SELECTED_UTF8_BYTES = 21_036_800;

/**
 * Serialized Phase 2 control state for one canonical user memory Storage.
 * Generated memory content remains outside this row.
 */
export const piMemoryPhase2Jobs = pgTable(
  "pi_memory_phase2_jobs",
  {
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
    /**
     * Compatibility marker for outgoing API versions and deployed constraints.
     * Current attempts use leaseToken and maintenanceRunId. Remove after old
     * APIs/leases drain, rollback excludes them, and writers stop naming this column.
     */
    legacyLeaseToken: uuid("legacy_lease_token"),
    /** Compatibility copy of leaseToken; retire with legacyLeaseToken under #37970. */
    sandboxLeaseToken: uuid("sandbox_lease_token"),
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
    /** Compatibility output; current readers derive the version from the Job result. */
    lastMaintenancePublicationVersionId: varchar(
      "last_maintenance_checkpoint_version_id",
      { length: 64 },
    ),
    lastMaintenanceOutcome: varchar("last_maintenance_outcome", {
      length: 32,
    }).$type<"published" | "no_diff" | "failed">(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({
        name: "pi_memory_phase2_jobs_pkey",
        columns: [table.memoryStorageId],
      }),
      foreignKey({
        name: "pi_memory_phase2_jobs_storage_owner_fk",
        columns: [table.memoryStorageId, table.orgId, table.userId],
        foreignColumns: [storages.id, storages.orgId, storages.userId],
      }).onDelete("cascade"),
      index("idx_pi_memory_phase2_jobs_claimable")
        .on(
          table.status,
          table.retryAt,
          table.leaseExpiresAt,
          table.lastSucceededAt,
          table.updatedAt,
          table.memoryStorageId,
        )
        .where(
          sql`${table.completedRevision} < ${table.inputRevision} AND ${table.status} IN ('pending', 'leased', 'retryable_failure')`,
        ),
      index("idx_pi_memory_phase2_jobs_user_export").on(
        table.userId,
        table.orgId,
        table.memoryStorageId,
      ),
      index("idx_pi_memory_phase2_jobs_maintenance_run")
        .on(table.maintenanceRunId)
        .where(sql`${table.maintenanceRunId} IS NOT NULL`),
      check(
        "pi_memory_phase2_jobs_status_check",
        sql`${table.status} IN ('idle', 'pending', 'leased', 'retryable_failure', 'terminal_failure')`,
      ),
      check(
        "pi_memory_phase2_jobs_revisions_check",
        sql`${table.inputRevision} > 0 AND
          ${table.completedRevision} >= 0 AND
          ${table.completedRevision} <= ${table.inputRevision} AND
          ${table.reconciliationRevision} >= 0 AND
          ${table.reconciliationRevision} <= ${table.inputRevision} AND
          (
            ${table.claimedRevision} IS NULL OR (
              ${table.completedRevision} < ${table.claimedRevision} AND
              ${table.claimedRevision} <= ${table.inputRevision}
            )
          )`,
      ),
      check(
        "pi_memory_phase2_jobs_retry_count_check",
        sql`${table.retryCount} >= 0 AND ${table.retryCount} <= 3`,
      ),
      check(
        "pi_memory_phase2_jobs_error_class_check",
        sql`${table.lastErrorClass} IS NULL OR ${table.lastErrorClass} ~ '^[a-z][a-z0-9_]{0,127}$'`,
      ),
      check(
        "pi_memory_phase2_jobs_version_ids_check",
        sql`(${table.claimedBaseVersionId} IS NULL OR ${table.claimedBaseVersionId} ~ '^[0-9a-f]{64}$') AND
          (${table.lastObservedHeadVersionId} IS NULL OR ${table.lastObservedHeadVersionId} ~ '^[0-9a-f]{64}$') AND
          (${table.lastConflictingHeadVersionId} IS NULL OR ${table.lastConflictingHeadVersionId} ~ '^[0-9a-f]{64}$') AND
          (${table.lastPublishedVersionId} IS NULL OR ${table.lastPublishedVersionId} ~ '^[0-9a-f]{64}$') AND
          (${table.lastMaintenanceBaseVersionId} IS NULL OR ${table.lastMaintenanceBaseVersionId} ~ '^[0-9a-f]{64}$') AND
          (${table.lastMaintenanceSelectionDigest} IS NULL OR ${table.lastMaintenanceSelectionDigest} ~ '^[0-9a-f]{64}$') AND
          (${table.lastMaintenancePublicationVersionId} IS NULL OR ${table.lastMaintenancePublicationVersionId} ~ '^[0-9a-f]{64}$')`,
      ),
      check(
        "pi_memory_phase2_jobs_execution_fence_check",
        sql`(
          ${table.status} = 'leased' AND (
            (
              ${table.legacyLeaseToken} IS NOT NULL AND
              ${table.legacyLeaseToken} = ${table.leaseToken} AND
              ${table.sandboxLeaseToken} IS NULL AND
              ${table.maintenanceRunId} IS NULL
            ) OR (
              ${table.legacyLeaseToken} IS NULL AND
              ${table.sandboxLeaseToken} IS NOT NULL AND
              ${table.sandboxLeaseToken} = ${table.leaseToken}
            )
          )
        ) OR (
          ${table.status} <> 'leased' AND
          ${table.sandboxLeaseToken} IS NULL AND
          ${table.maintenanceRunId} IS NULL
        )`,
      ),
      check(
        "pi_memory_phase2_jobs_maintenance_history_check",
        sql`(
          ${table.lastMaintenanceRunId} IS NULL AND
          ${table.lastMaintenanceRevision} IS NULL AND
          ${table.lastMaintenanceBaseVersionId} IS NULL AND
          ${table.lastMaintenanceSelectionDigest} IS NULL AND
          ${table.lastMaintenancePublicationVersionId} IS NULL AND
          ${table.lastMaintenanceOutcome} IS NULL
        ) OR (
          ${table.lastMaintenanceRunId} IS NOT NULL AND
          ${table.lastMaintenanceRevision} IS NOT NULL AND
          ${table.lastMaintenanceRevision} > 0 AND
          ${table.lastMaintenanceBaseVersionId} IS NOT NULL AND
          ${table.lastMaintenanceSelectionDigest} IS NOT NULL AND
          ${table.lastMaintenanceOutcome} IN ('published', 'no_diff', 'failed') AND
          (
            (
              ${table.lastMaintenanceOutcome} = 'failed' AND
              ${table.lastMaintenancePublicationVersionId} IS NULL
            ) OR (
              ${table.lastMaintenanceOutcome} IN ('published', 'no_diff') AND
              ${table.lastMaintenancePublicationVersionId} IS NOT NULL
            )
          )
        )`,
      ),
      check(
        "pi_memory_phase2_jobs_conflict_check",
        sql`(${table.conflictCount} = 0 AND ${table.lastConflictAt} IS NULL AND ${table.lastConflictingHeadVersionId} IS NULL) OR
          (${table.conflictCount} > 0 AND ${table.lastConflictAt} IS NOT NULL AND ${table.lastConflictingHeadVersionId} IS NOT NULL)`,
      ),
      check(
        "pi_memory_phase2_jobs_publication_check",
        sql`(${table.lastPublishedVersionId} IS NULL AND ${table.lastPublishedAt} IS NULL) OR
          (${table.lastPublishedVersionId} IS NOT NULL AND ${table.lastPublishedAt} IS NOT NULL)`,
      ),
      check(
        "pi_memory_phase2_jobs_selection_check",
        sql`(
          ${table.claimedSelectionDigest} IS NULL AND
          ${table.claimedSelectedCount} IS NULL AND
          ${table.claimedSelectedUtf8Bytes} IS NULL
        ) OR (
          ${table.claimedSelectionDigest} IS NOT NULL AND
          ${table.claimedSelectedCount} IS NOT NULL AND
          ${table.claimedSelectedUtf8Bytes} IS NOT NULL AND
          ${table.claimedSelectionDigest} ~ '^[0-9a-f]{64}$' AND
          ${table.claimedSelectedCount} >= 0 AND
          ${table.claimedSelectedCount} <= 256 AND
          ${table.claimedSelectedUtf8Bytes} >= 0 AND
          ${table.claimedSelectedUtf8Bytes} <= 21036800
        )`,
      ),
      check(
        "pi_memory_phase2_jobs_state_check",
        sql`(
          ${table.status} = 'idle' AND
          ${table.completedRevision} = ${table.inputRevision} AND
          ${table.claimedRevision} IS NULL AND
          ${table.claimedBaseVersionId} IS NULL AND
          ${table.leaseToken} IS NULL AND
          ${table.leaseExpiresAt} IS NULL AND
          ${table.retryCount} = 0 AND
          ${table.retryAt} IS NULL AND
          ${table.lastErrorClass} IS NULL AND
          ${table.claimedSelectionDigest} IS NULL AND
          ${table.claimedSelectedCount} IS NULL AND
          ${table.claimedSelectedUtf8Bytes} IS NULL
        ) OR (
          ${table.status} = 'pending' AND
          ${table.completedRevision} < ${table.inputRevision} AND
          ${table.claimedRevision} IS NULL AND
          ${table.claimedBaseVersionId} IS NULL AND
          ${table.leaseToken} IS NULL AND
          ${table.leaseExpiresAt} IS NULL AND
          ${table.retryCount} = 0 AND
          ${table.retryAt} IS NULL AND
          ${table.lastErrorClass} IS NULL AND
          ${table.claimedSelectionDigest} IS NULL AND
          ${table.claimedSelectedCount} IS NULL AND
          ${table.claimedSelectedUtf8Bytes} IS NULL
        ) OR (
          ${table.status} = 'leased' AND
          ${table.claimedRevision} IS NOT NULL AND
          ${table.claimedBaseVersionId} IS NOT NULL AND
          ${table.completedRevision} < ${table.claimedRevision} AND
          ${table.claimedRevision} <= ${table.inputRevision} AND
          ${table.leaseToken} IS NOT NULL AND
          ${table.leaseExpiresAt} IS NOT NULL AND
          ${table.retryCount} >= 0 AND
          ${table.retryCount} < 3 AND
          ${table.retryAt} IS NULL AND
          ${table.lastErrorClass} IS NULL AND
          ${table.claimedSelectionDigest} IS NOT NULL AND
          ${table.claimedSelectedCount} IS NOT NULL AND
          ${table.claimedSelectedUtf8Bytes} IS NOT NULL
        ) OR (
          ${table.status} = 'retryable_failure' AND
          ${table.completedRevision} < ${table.inputRevision} AND
          ${table.claimedRevision} IS NULL AND
          ${table.claimedBaseVersionId} IS NULL AND
          ${table.leaseToken} IS NULL AND
          ${table.leaseExpiresAt} IS NULL AND
          ${table.retryCount} > 0 AND
          ${table.retryCount} < 3 AND
          ${table.retryAt} IS NOT NULL AND
          ${table.lastErrorClass} IS NOT NULL AND
          ${table.claimedSelectionDigest} IS NULL AND
          ${table.claimedSelectedCount} IS NULL AND
          ${table.claimedSelectedUtf8Bytes} IS NULL
        ) OR (
          ${table.status} = 'terminal_failure' AND
          ${table.completedRevision} < ${table.inputRevision} AND
          ${table.claimedRevision} IS NULL AND
          ${table.claimedBaseVersionId} IS NULL AND
          ${table.leaseToken} IS NULL AND
          ${table.leaseExpiresAt} IS NULL AND
          ${table.retryCount} = 3 AND
          ${table.retryAt} IS NULL AND
          ${table.lastErrorClass} IS NOT NULL AND
          ${table.claimedSelectionDigest} IS NULL AND
          ${table.claimedSelectedCount} IS NULL AND
          ${table.claimedSelectedUtf8Bytes} IS NULL
        )`,
      ),
    ];
  },
);
