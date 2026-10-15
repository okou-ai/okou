import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { blobs } from "../schema/blob";
import { piMemoryStage1Candidates } from "../schema/pi-memory-stage1-candidate";
import { storages } from "../schema/storage";

describe("Pi memory Stage 1 candidate schema", () => {
  it("uses exact owner/session identity with worker and Phase 2 indexes", () => {
    const config = getTableConfig(piMemoryStage1Candidates);
    expect(config.primaryKeys).toHaveLength(1);
    expect(
      config.primaryKeys[0]?.columns.map((column) => {
        return column.name;
      }),
    ).toStrictEqual(["memory_storage_id", "pi_session_id"]);

    const ownerForeignKey = config.foreignKeys.find((foreignKey) => {
      return (
        foreignKey.getName() === "pi_memory_stage1_candidates_storage_owner_fk"
      );
    });
    expect(ownerForeignKey?.onDelete).toBe("cascade");
    expect(ownerForeignKey?.reference().foreignTable).toBe(storages);
    expect(
      ownerForeignKey?.reference().columns.map((column) => {
        return column.name;
      }),
    ).toStrictEqual(["memory_storage_id", "org_id", "user_id"]);

    const blobForeignKey = config.foreignKeys.find((foreignKey) => {
      return foreignKey.reference().foreignTable === blobs;
    });
    expect(
      blobForeignKey?.reference().columns.map((column) => {
        return column.name;
      }),
    ).toStrictEqual(["source_history_hash"]);

    expect(
      config.indexes.map((candidate) => {
        return candidate.config.name;
      }),
    ).toStrictEqual([
      "idx_pi_memory_stage1_candidates_eligible",
      "idx_pi_memory_stage1_candidates_expired_lease",
      "idx_pi_memory_stage1_candidates_phase2",
    ]);
  });

  it("enforces bounded states, leases, hashes, and counters", () => {
    const dialect = new PgDialect();
    const checks = Object.fromEntries(
      getTableConfig(piMemoryStage1Candidates).checks.map((candidate) => {
        return [candidate.name, dialect.sqlToQuery(candidate.value).sql];
      }),
    );
    expect(Object.keys(checks)).toStrictEqual([
      "pi_memory_stage1_candidates_source_format_check",
      "pi_memory_stage1_candidates_status_check",
      "pi_memory_stage1_candidates_source_hash_check",
      "pi_memory_stage1_candidates_selected_hash_check",
      "pi_memory_stage1_candidates_counts_check",
      "pi_memory_stage1_candidates_lease_check",
      "pi_memory_stage1_candidates_state_check",
    ]);
    expect(checks.pi_memory_stage1_candidates_status_check).toContain(
      "succeeded_no_output",
    );
    expect(checks.pi_memory_stage1_candidates_status_check).toContain(
      "retryable_failure",
    );
    expect(checks.pi_memory_stage1_candidates_status_check).toContain(
      "terminal_failure",
    );
    expect(checks.pi_memory_stage1_candidates_source_hash_check).toContain(
      "^[0-9a-f]{64}$",
    );
    expect(checks.pi_memory_stage1_candidates_lease_check).toContain(
      "lease_token",
    );
    expect(checks.pi_memory_stage1_candidates_counts_check).toContain(
      "usage_count",
    );
    expect(checks.pi_memory_stage1_candidates_selected_hash_check).toContain(
      '"last_selected_source_history_hash" IS NULL OR',
    );
    expect(checks.pi_memory_stage1_candidates_selected_hash_check).toContain(
      '"last_selected_source_history_hash" = "pi_memory_stage1_candidates"."source_history_hash"',
    );
    const stateCheck = checks.pi_memory_stage1_candidates_state_check;
    expect(stateCheck).toBeDefined();
    if (stateCheck === undefined) {
      throw new Error("Expected the Stage 1 candidate state constraint");
    }
    expect(
      stateCheck.match(/"last_selected_source_history_hash" IS NULL/gu),
    ).toHaveLength(3);
    expect(stateCheck).toMatch(
      /"status" = 'succeeded'[\s\S]*?"generated_at" IS NOT NULL\s+\) OR \(/u,
    );
    expect(stateCheck).toMatch(
      /"status" = 'succeeded_no_output'[\s\S]*?"generated_at" IS NOT NULL\s+\) OR \(/u,
    );
  });
});
