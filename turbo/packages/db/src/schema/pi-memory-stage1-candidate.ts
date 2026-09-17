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

import { blobs } from "./blob";
import { storages } from "./storage";

export const PI_MEMORY_STAGE1_CANDIDATE_STATUSES = [
  "pending",
  "leased",
  "succeeded",
  "succeeded_no_output",
  "retryable_failure",
  "terminal_failure",
] as const;

export type PiMemoryStage1CandidateStatus =
  (typeof PI_MEMORY_STAGE1_CANDIDATE_STATUSES)[number];

/**
 * Metadata-only Stage 1 generation control row for one native Pi session.
 * The source JSONL remains in the content-addressed blob store. Lifecycle writes
 * and parent deletion explicitly account through the API candidate service.
 * The guarded retirement in #33975 removes the legacy trigger and function;
 * raw candidate ownership writes and parent cascades are unsupported.
 */
export const piMemoryStage1Candidates = pgTable(
  "pi_memory_stage1_candidates",
  {
    memoryStorageId: uuid("memory_storage_id").notNull(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    piSessionId: varchar("pi_session_id", { length: 255 }).notNull(),
    sourceRunId: uuid("source_run_id").notNull(),
    sourceHistoryHash: varchar("source_history_hash", { length: 64 })
      .notNull()
      .references(() => {
        return blobs.hash;
      }),
    sourceCompletedAt: timestamp("source_completed_at").notNull(),
    eligibleAt: timestamp("eligible_at").notNull(),
    status: varchar("status", { length: 32 })
      .$type<PiMemoryStage1CandidateStatus>()
      .default("pending")
      .notNull(),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at"),
    retryAt: timestamp("retry_at"),
    retryCount: integer("retry_count").default(0).notNull(),
    lastErrorClass: varchar("last_error_class", { length: 128 }),
    rawMemory: text("raw_memory"),
    rolloutSummary: text("rollout_summary"),
    rolloutSlug: varchar("rollout_slug", { length: 255 }),
    generatedAt: timestamp("generated_at"),
    lastSelectedSourceHistoryHash: varchar(
      "last_selected_source_history_hash",
      { length: 64 },
    ),
    usageCount: integer("usage_count").default(0).notNull(),
    lastUsedAt: timestamp("last_used_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({
        name: "pi_memory_stage1_candidates_pkey",
        columns: [table.memoryStorageId, table.piSessionId],
      }),
      foreignKey({
        name: "pi_memory_stage1_candidates_storage_owner_fk",
        columns: [table.memoryStorageId, table.orgId, table.userId],
        foreignColumns: [storages.id, storages.orgId, storages.userId],
      }).onDelete("cascade"),
      index("idx_pi_memory_stage1_candidates_eligible")
        .on(table.eligibleAt, table.retryAt)
        .where(sql`${table.status} IN ('pending', 'retryable_failure')`),
      index("idx_pi_memory_stage1_candidates_expired_lease")
        .on(table.leaseExpiresAt)
        .where(sql`${table.status} = 'leased'`),
      index("idx_pi_memory_stage1_candidates_phase2")
        .on(table.memoryStorageId, table.generatedAt, table.piSessionId)
        .where(sql`${table.status} IN ('succeeded', 'succeeded_no_output')`),
      check(
        "pi_memory_stage1_candidates_status_check",
        sql`${table.status} IN (
          'pending',
          'leased',
          'succeeded',
          'succeeded_no_output',
          'retryable_failure',
          'terminal_failure'
        )`,
      ),
      check(
        "pi_memory_stage1_candidates_source_hash_check",
        sql`${table.sourceHistoryHash} ~ '^[0-9a-f]{64}$'`,
      ),
      check(
        "pi_memory_stage1_candidates_selected_hash_check",
        sql`${table.lastSelectedSourceHistoryHash} IS NULL OR ${table.lastSelectedSourceHistoryHash} = ${table.sourceHistoryHash}`,
      ),
      check(
        "pi_memory_stage1_candidates_counts_check",
        sql`${table.retryCount} >= 0 AND ${table.usageCount} >= 0`,
      ),
      check(
        "pi_memory_stage1_candidates_lease_check",
        sql`(
          ${table.status} = 'leased' AND
          ${table.leaseToken} IS NOT NULL AND
          ${table.leaseExpiresAt} IS NOT NULL
        ) OR (
          ${table.status} <> 'leased' AND
          ${table.leaseToken} IS NULL AND
          ${table.leaseExpiresAt} IS NULL
        )`,
      ),
      check(
        "pi_memory_stage1_candidates_state_check",
        sql`(
          ${table.status} IN ('pending', 'leased') AND
          ${table.retryAt} IS NULL AND
          ${table.lastErrorClass} IS NULL AND
          ${table.rawMemory} IS NULL AND
          ${table.rolloutSummary} IS NULL AND
          ${table.rolloutSlug} IS NULL AND
          ${table.generatedAt} IS NULL AND
          ${table.lastSelectedSourceHistoryHash} IS NULL
        ) OR (
          ${table.status} = 'succeeded' AND
          ${table.retryAt} IS NULL AND
          ${table.lastErrorClass} IS NULL AND
          ${table.rawMemory} IS NOT NULL AND
          ${table.rolloutSummary} IS NOT NULL AND
          ${table.generatedAt} IS NOT NULL
        ) OR (
          ${table.status} = 'succeeded_no_output' AND
          ${table.retryAt} IS NULL AND
          ${table.lastErrorClass} IS NULL AND
          ${table.rawMemory} IS NULL AND
          ${table.rolloutSummary} IS NULL AND
          ${table.rolloutSlug} IS NULL AND
          ${table.generatedAt} IS NOT NULL
        ) OR (
          ${table.status} = 'retryable_failure' AND
          ${table.retryAt} IS NOT NULL AND
          ${table.lastErrorClass} IS NOT NULL AND
          ${table.rawMemory} IS NULL AND
          ${table.rolloutSummary} IS NULL AND
          ${table.rolloutSlug} IS NULL AND
          ${table.generatedAt} IS NULL AND
          ${table.lastSelectedSourceHistoryHash} IS NULL
        ) OR (
          ${table.status} = 'terminal_failure' AND
          ${table.retryAt} IS NULL AND
          ${table.lastErrorClass} IS NOT NULL AND
          ${table.rawMemory} IS NULL AND
          ${table.rolloutSummary} IS NULL AND
          ${table.rolloutSlug} IS NULL AND
          ${table.generatedAt} IS NULL AND
          ${table.lastSelectedSourceHistoryHash} IS NULL
        )`,
      ),
    ];
  },
);
