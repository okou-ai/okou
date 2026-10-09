import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { storages, storageVersions } from "./storage";

export type MemorySummaryProjectionStatus =
  "pending" | "running" | "ready" | "missing" | "invalid" | "over_limit";

/**
 * Durable projection of one canonical user memory Storage version's root
 * memory_summary.md. Rows are immutable terminal results unless a ready row
 * fails its read-time integrity check and is requeued for repair.
 */
export const memorySummaryProjections = pgTable(
  "memory_summary_projections",
  {
    memoryStorageId: uuid("memory_storage_id")
      .notNull()
      .references(
        () => {
          return storages.id;
        },
        { onDelete: "cascade" },
      ),
    storageVersionId: varchar("storage_version_id", { length: 64 })
      .notNull()
      .references(
        () => {
          return storageVersions.id;
        },
        { onDelete: "cascade" },
      ),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    status: varchar("status", { length: 16 })
      .$type<MemorySummaryProjectionStatus>()
      .notNull()
      .default("pending"),
    leaseId: uuid("lease_id"),
    leaseExpiresAt: timestamp("lease_expires_at"),
    availableAt: timestamp("available_at").defaultNow().notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    lastErrorClass: varchar("last_error_class", { length: 128 }),
    content: text("content"),
    sourceHash: varchar("source_hash", { length: 64 }),
    sourceSize: integer("source_size"),
    tokenCount: integer("token_count"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({
        columns: [table.memoryStorageId, table.storageVersionId],
      }),
      index("idx_memory_summary_projections_pending")
        .on(table.availableAt, table.memoryStorageId, table.storageVersionId)
        .where(sql`${table.status} = 'pending'`),
      index("idx_memory_summary_projections_expired_lease")
        .on(table.leaseExpiresAt, table.memoryStorageId, table.storageVersionId)
        .where(sql`${table.status} = 'running'`),
      index("idx_memory_summary_projections_owner").on(
        table.orgId,
        table.userId,
        table.memoryStorageId,
        table.storageVersionId,
      ),
      check(
        "memory_summary_projections_status_check",
        sql`${table.status} IN ('pending', 'running', 'ready', 'missing', 'invalid', 'over_limit')`,
      ),
      check(
        "memory_summary_projections_lease_check",
        sql`(
          ${table.status} = 'running'
          AND ${table.leaseId} IS NOT NULL
          AND ${table.leaseExpiresAt} IS NOT NULL
        ) OR (
          ${table.status} <> 'running'
          AND ${table.leaseId} IS NULL
          AND ${table.leaseExpiresAt} IS NULL
        )`,
      ),
      check(
        "memory_summary_projections_content_check",
        sql`(
          ${table.status} = 'ready'
          AND ${table.content} IS NOT NULL
          AND ${table.sourceHash} IS NOT NULL
          AND ${table.sourceSize} IS NOT NULL
          AND ${table.tokenCount} IS NOT NULL
        ) OR (
          ${table.status} <> 'ready'
          AND ${table.content} IS NULL
          AND ${table.sourceHash} IS NULL
          AND ${table.sourceSize} IS NULL
          AND ${table.tokenCount} IS NULL
        )`,
      ),
      check(
        "memory_summary_projections_attempt_count_check",
        sql`${table.attemptCount} >= 0`,
      ),
      check(
        "memory_summary_projections_source_size_check",
        sql`${table.sourceSize} IS NULL OR ${table.sourceSize} >= 0`,
      ),
      check(
        "memory_summary_projections_token_count_check",
        sql`${table.tokenCount} IS NULL OR ${table.tokenCount} >= 0`,
      ),
    ];
  },
);
