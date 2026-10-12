import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
} from "drizzle-orm/pg-core";

import { storages } from "./storage";

import { piMemoryPhase2JobColumns } from "../columns/pi-memory-phase2-job";

/**
 * Serialized Phase 2 control state for one canonical user memory Storage.
 * Generated memory content remains outside this row.
 */
export const piMemoryPhase2Jobs = pgTable(
  "pi_memory_phase2_jobs",
  piMemoryPhase2JobColumns(),
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
          (${table.lastMaintenanceSelectionDigest} IS NULL OR ${table.lastMaintenanceSelectionDigest} ~ '^[0-9a-f]{64}$')`,
      ),
      check(
        "pi_memory_phase2_jobs_execution_fence_check",
        sql`${table.status} = 'leased' OR ${table.maintenanceRunId} IS NULL`,
      ),
      check(
        "pi_memory_phase2_jobs_maintenance_history_check",
        sql`(
          ${table.lastMaintenanceRunId} IS NULL AND
          ${table.lastMaintenanceRevision} IS NULL AND
          ${table.lastMaintenanceBaseVersionId} IS NULL AND
          ${table.lastMaintenanceSelectionDigest} IS NULL AND
          ${table.lastMaintenanceOutcome} IS NULL
        ) OR (
          ${table.lastMaintenanceRunId} IS NOT NULL AND
          ${table.lastMaintenanceRevision} IS NOT NULL AND
          ${table.lastMaintenanceRevision} > 0 AND
          ${table.lastMaintenanceBaseVersionId} IS NOT NULL AND
          ${table.lastMaintenanceSelectionDigest} IS NOT NULL AND
          ${table.lastMaintenanceOutcome} IS NOT NULL AND
          ${table.lastMaintenanceOutcome} IN ('published', 'no_diff', 'failed') AND
          (
            ${table.lastMaintenanceOutcome} <> 'published' OR
            ${table.lastPublishedVersionId} IS NOT NULL
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
