import type { PiResourceVersionIndex } from "@okouai/db/jsonb-contracts/pi-resource-version-index";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { storageVersions } from "./storage";

export const piResourceVersionIndexes = pgTable(
  "pi_resource_version_indexes",
  {
    storageVersionId: varchar("storage_version_id", { length: 64 }).notNull(),
    extractorVersion: integer("extractor_version").notNull(),
    status: varchar("status", { length: 16 })
      .$type<"pending" | "running" | "ready" | "unindexable">()
      .notNull()
      .default("pending"),
    projection: jsonb("projection").$type<PiResourceVersionIndex>(),
    sourceArchiveSize: bigint("source_archive_size", { mode: "number" }),
    projectionHash: varchar("projection_hash", { length: 64 }),
    leaseId: uuid("lease_id"),
    leaseExpiresAt: timestamp("lease_expires_at"),
    availableAt: timestamp("available_at").defaultNow().notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({
        name: "pi_resource_version_indexes_pk",
        columns: [table.storageVersionId, table.extractorVersion],
      }),
      foreignKey({
        name: "pi_resource_version_indexes_version_fk",
        columns: [table.storageVersionId],
        foreignColumns: [storageVersions.id],
      }).onDelete("cascade"),
      index("pi_resource_version_indexes_pending_idx")
        .on(table.extractorVersion, table.availableAt)
        .where(sql`${table.status} = 'pending'`),
      index("pi_resource_version_indexes_lease_idx")
        .on(table.extractorVersion, table.leaseExpiresAt)
        .where(sql`${table.status} = 'running'`),
      check(
        "pi_resource_version_indexes_status_check",
        sql`${table.status} IN ('pending', 'running', 'ready', 'unindexable')`,
      ),
      check(
        "pi_resource_version_indexes_projection_check",
        sql`(${table.status} = 'ready' AND ${table.projection} IS NOT NULL AND ${table.projectionHash} IS NOT NULL AND ${table.sourceArchiveSize} IS NOT NULL) OR (${table.status} <> 'ready' AND ${table.projection} IS NULL AND ${table.projectionHash} IS NULL)`,
      ),
      check(
        "pi_resource_version_indexes_lease_check",
        sql`(${table.status} = 'running' AND ${table.leaseId} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL) OR (${table.status} <> 'running' AND ${table.leaseId} IS NULL AND ${table.leaseExpiresAt} IS NULL)`,
      ),
      check(
        "pi_resource_version_indexes_size_check",
        sql`${table.sourceArchiveSize} IS NULL OR ${table.sourceArchiveSize} >= 0`,
      ),
      check(
        "pi_resource_version_indexes_attempt_check",
        sql`${table.attemptCount} >= 0`,
      ),
    ];
  },
);
