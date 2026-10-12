import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  pgTable,
  timestamp,
  uuid,
  varchar,
  text,
} from "drizzle-orm/pg-core";

import { agentRuns } from "./agent-run";
import { storages } from "./storage";

/**
 * Migration-owned compatibility storage. The runtime no longer reads or writes
 * receipts. Drop only after the storage-independent API is independently
 * deployed, old statements/leases drain, and rollback excludes old writers.
 * Follow-up: #39171.
 */
export const piMemoryPhase2PublicationReceipts = pgTable(
  "pi_memory_phase2_checkpoints",
  {
    runId: uuid("run_id")
      .primaryKey()
      .references(
        () => {
          return agentRuns.id;
        },
        { onDelete: "cascade" },
      ),
    memoryStorageId: uuid("memory_storage_id").notNull(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    leaseToken: uuid("lease_token").notNull(),
    claimedRevision: integer("claimed_revision").notNull(),
    claimedBaseVersionId: varchar("claimed_base_version_id", {
      length: 64,
    }).notNull(),
    selectionDigest: varchar("selection_digest", { length: 64 }).notNull(),
    versionId: varchar("version_id", { length: 64 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      foreignKey({
        columns: [table.memoryStorageId, table.orgId, table.userId],
        foreignColumns: [storages.id, storages.orgId, storages.userId],
        name: "pi_memory_phase2_checkpoints_storage_owner_fk",
      }).onDelete("cascade"),
      check(
        "pi_memory_phase2_checkpoints_identity_check",
        sql`${table.claimedRevision} > 0 AND
      ${table.claimedBaseVersionId} ~ '^[0-9a-f]{64}$' AND
      ${table.selectionDigest} ~ '^[0-9a-f]{64}$' AND
      ${table.versionId} ~ '^[0-9a-f]{64}$'`,
      ),
    ];
  },
);
