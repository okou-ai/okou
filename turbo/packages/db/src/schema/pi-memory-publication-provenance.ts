import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { storages } from "./storage";

export const PI_MEMORY_PUBLICATION_WRITERS = ["pi", "reconciler"] as const;
export type PiMemoryPublicationWriter =
  (typeof PI_MEMORY_PUBLICATION_WRITERS)[number];

export const PI_MEMORY_PUBLICATION_OUTCOMES = [
  "published",
  "conflicted",
] as const;
export type PiMemoryPublicationOutcome =
  (typeof PI_MEMORY_PUBLICATION_OUTCOMES)[number];

/**
 * Content-free provenance for prepared memory publication attempts accepted by
 * an exact live Phase 2 lease.
 */
export const piMemoryPublicationProvenance = pgTable(
  "pi_memory_publication_provenance",
  {
    id: uuid("id").defaultRandom().notNull(),
    memoryStorageId: uuid("memory_storage_id").notNull(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    claimedRevision: integer("claimed_revision").notNull(),
    inputRevision: integer("input_revision").notNull(),
    reconciliationRevision: integer("reconciliation_revision").notNull(),
    selectionDigest: varchar("selection_digest", { length: 64 }).notNull(),
    selectedCount: integer("selected_count").notNull(),
    selectedUtf8Bytes: integer("selected_utf8_bytes").notNull(),
    baseVersionId: varchar("base_version_id", { length: 64 }).notNull(),
    preparedVersionId: varchar("prepared_version_id", { length: 64 }).notNull(),
    observedHeadVersionId: varchar("observed_head_version_id", {
      length: 64,
    }).notNull(),
    writer: varchar("writer", { length: 16 })
      .$type<PiMemoryPublicationWriter>()
      .notNull(),
    outcome: varchar("outcome", { length: 16 })
      .$type<PiMemoryPublicationOutcome>()
      .notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    archiveSize: bigint("archive_size", { mode: "number" }).notNull(),
    fileCount: integer("file_count").notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => {
    return [
      primaryKey({
        name: "pi_memory_publication_provenance_pkey",
        columns: [table.id],
      }),
      foreignKey({
        name: "pi_memory_publication_provenance_storage_owner_fk",
        columns: [table.memoryStorageId, table.orgId, table.userId],
        foreignColumns: [storages.id, storages.orgId, storages.userId],
      }).onDelete("cascade"),
      uniqueIndex("idx_pi_memory_publication_provenance_attempt").on(
        table.memoryStorageId,
        table.claimedRevision,
        table.baseVersionId,
        table.preparedVersionId,
      ),
      index("idx_pi_memory_publication_provenance_user_export").on(
        table.userId,
        table.orgId,
        table.memoryStorageId,
        table.createdAt,
      ),
      check(
        "pi_memory_publication_provenance_revisions_check",
        sql`${table.claimedRevision} > 0 AND
          ${table.inputRevision} >= ${table.claimedRevision} AND
          ${table.reconciliationRevision} >= 0 AND
          ${table.reconciliationRevision} <= ${table.inputRevision}`,
      ),
      check(
        "pi_memory_publication_provenance_selection_check",
        sql`${table.selectionDigest} ~ '^[0-9a-f]{64}$' AND
          ${table.selectedCount} >= 0 AND ${table.selectedCount} <= 256 AND
          ${table.selectedUtf8Bytes} >= 0 AND ${table.selectedUtf8Bytes} <= 21036800`,
      ),
      check(
        "pi_memory_publication_provenance_versions_check",
        sql`${table.baseVersionId} ~ '^[0-9a-f]{64}$' AND
          ${table.preparedVersionId} ~ '^[0-9a-f]{64}$' AND
          ${table.observedHeadVersionId} ~ '^[0-9a-f]{64}$' AND
          ${table.baseVersionId} <> ${table.preparedVersionId}`,
      ),
      check(
        "pi_memory_publication_provenance_writer_check",
        sql`${table.writer} IN ('pi', 'reconciler')`,
      ),
      check(
        "pi_memory_publication_provenance_outcome_check",
        sql`${table.outcome} IN ('published', 'conflicted') AND
          (${table.outcome} <> 'published' OR ${table.observedHeadVersionId} = ${table.preparedVersionId})`,
      ),
      check(
        "pi_memory_publication_provenance_counts_check",
        sql`${table.size} >= 0 AND ${table.archiveSize} >= 0 AND ${table.fileCount} >= 0`,
      ),
    ];
  },
);
