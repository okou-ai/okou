import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  PI_MEMORY_PHASE2_JOB_STATUSES,
  PI_MEMORY_PHASE2_MAX_ATTEMPTS,
  PI_MEMORY_PHASE2_MAX_SELECTED_CANDIDATES,
  PI_MEMORY_PHASE2_MAX_SELECTED_UTF8_BYTES,
  piMemoryPhase2Jobs,
} from "../schema/pi-memory-phase2-job";
import { storages } from "../schema/storage";

describe("Pi memory Phase 2 job schema", () => {
  it("owns one job per exact Storage owner with claim and export indexes", () => {
    const config = getTableConfig(piMemoryPhase2Jobs);
    expect(config.primaryKeys).toHaveLength(1);
    expect(config.primaryKeys[0]?.getName()).toBe("pi_memory_phase2_jobs_pkey");
    expect(
      config.primaryKeys[0]?.columns.map((column) => {
        return column.name;
      }),
    ).toStrictEqual(["memory_storage_id"]);

    const ownerForeignKey = config.foreignKeys.find((foreignKey) => {
      return foreignKey.getName() === "pi_memory_phase2_jobs_storage_owner_fk";
    });
    expect(ownerForeignKey?.onDelete).toBe("cascade");
    expect(ownerForeignKey?.reference().foreignTable).toBe(storages);
    expect(
      ownerForeignKey?.reference().columns.map((column) => {
        return column.name;
      }),
    ).toStrictEqual(["memory_storage_id", "org_id", "user_id"]);

    expect(
      config.indexes.map((candidate) => {
        return candidate.config.name;
      }),
    ).toStrictEqual([
      "idx_pi_memory_phase2_jobs_claimable",
      "idx_pi_memory_phase2_jobs_user_export",
      "idx_pi_memory_phase2_jobs_maintenance_run",
    ]);
    expect(config.columns).toHaveLength(36);
  });

  it("pins every status, revision, retry, selection, and payload boundary", () => {
    expect(PI_MEMORY_PHASE2_JOB_STATUSES).toStrictEqual([
      "idle",
      "pending",
      "leased",
      "retryable_failure",
      "terminal_failure",
    ]);
    expect(PI_MEMORY_PHASE2_MAX_ATTEMPTS).toBe(3);
    expect(PI_MEMORY_PHASE2_MAX_SELECTED_CANDIDATES).toBe(256);
    expect(PI_MEMORY_PHASE2_MAX_SELECTED_UTF8_BYTES).toBe(21_036_800);

    const dialect = new PgDialect();
    const checks = Object.fromEntries(
      getTableConfig(piMemoryPhase2Jobs).checks.map((candidate) => {
        return [candidate.name, dialect.sqlToQuery(candidate.value).sql];
      }),
    );
    expect(Object.keys(checks)).toStrictEqual([
      "pi_memory_phase2_jobs_status_check",
      "pi_memory_phase2_jobs_revisions_check",
      "pi_memory_phase2_jobs_retry_count_check",
      "pi_memory_phase2_jobs_error_class_check",
      "pi_memory_phase2_jobs_version_ids_check",
      "pi_memory_phase2_jobs_execution_fence_check",
      "pi_memory_phase2_jobs_maintenance_history_check",
      "pi_memory_phase2_jobs_conflict_check",
      "pi_memory_phase2_jobs_publication_check",
      "pi_memory_phase2_jobs_selection_check",
      "pi_memory_phase2_jobs_state_check",
    ]);
    expect(checks.pi_memory_phase2_jobs_status_check).toContain(
      "terminal_failure",
    );
    expect(checks.pi_memory_phase2_jobs_revisions_check).toContain(
      '"completed_revision" < "pi_memory_phase2_jobs"."claimed_revision"',
    );
    expect(checks.pi_memory_phase2_jobs_retry_count_check).toContain("<= 3");
    expect(checks.pi_memory_phase2_jobs_error_class_check).toContain("{0,127}");
    expect(checks.pi_memory_phase2_jobs_version_ids_check).toContain(
      "claimed_base_version_id",
    );
    expect(checks.pi_memory_phase2_jobs_execution_fence_check).toContain(
      "sandbox_lease_token",
    );
    expect(checks.pi_memory_phase2_jobs_maintenance_history_check).toContain(
      "last_maintenance_checkpoint_version_id",
    );
    expect(checks.pi_memory_phase2_jobs_conflict_check).toContain(
      "last_conflicting_head_version_id",
    );
    expect(checks.pi_memory_phase2_jobs_publication_check).toContain(
      "last_published_at",
    );
    expect(checks.pi_memory_phase2_jobs_selection_check).toContain("<= 256");
    expect(checks.pi_memory_phase2_jobs_selection_check).toContain(
      '"claimed_selected_count" IS NOT NULL',
    );
    expect(checks.pi_memory_phase2_jobs_selection_check).toContain(
      "<= 21036800",
    );

    const stateCheck = checks.pi_memory_phase2_jobs_state_check;
    expect(stateCheck).toBeDefined();
    if (stateCheck === undefined) {
      throw new Error("Expected the Pi memory Phase 2 state constraint");
    }
    expect(stateCheck).toMatch(
      /"status" = 'idle'[\s\S]*?"completed_revision" = "pi_memory_phase2_jobs"\."input_revision"/u,
    );
    expect(stateCheck).toMatch(
      /"status" = 'pending'[\s\S]*?"completed_revision" < "pi_memory_phase2_jobs"\."input_revision"/u,
    );
    expect(stateCheck).toMatch(
      /"status" = 'leased'[\s\S]*?"claimed_revision" IS NOT NULL[\s\S]*?"claimed_base_version_id" IS NOT NULL[\s\S]*?"claimed_selection_digest" IS NOT NULL/u,
    );
    expect(stateCheck).toMatch(
      /"status" = 'retryable_failure'[\s\S]*?"retry_count" < 3/u,
    );
    expect(stateCheck).toMatch(
      /"status" = 'terminal_failure'[\s\S]*?"retry_count" = 3/u,
    );
  });
});
