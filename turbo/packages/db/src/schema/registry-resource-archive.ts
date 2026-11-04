import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

/** Verified immutable archives. Storage IDs are not part of their identity or lifetime. */
export const registryResourceArchives = pgTable(
  "registry_resource_archives",
  {
    resourceId: text("resource_id").notNull(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    archiveBytes: bigint("archive_bytes", { mode: "number" }).notNull(),
    versionId: varchar("version_id", { length: 64 }).notNull(),
    fileCount: integer("file_count").notNull(),
    totalBytes: bigint("total_bytes", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({ columns: [table.resourceId, table.sha256] }),
      check(
        "chk_registry_resource_archive_id",
        sql`${table.resourceId} ~ '^(skill|template|design-system|color-system|image-style):[a-z0-9][a-z0-9-]*$'`,
      ),
      check(
        "chk_registry_resource_archive_digests",
        sql`${table.sha256} ~ '^[a-f0-9]{64}$' AND ${table.versionId} ~ '^[a-f0-9]{64}$'`,
      ),
      check(
        "chk_registry_resource_archive_limits",
        sql`${table.archiveBytes} BETWEEN 1 AND 33554432 AND ${table.totalBytes} BETWEEN 0 AND 33554432 AND ${table.fileCount} BETWEEN 1 AND 501`,
      ),
    ];
  },
);

/** Current presentation runbooks; fixed resource downloads remain selected by digest. */
export const registryResourceHeads = pgTable(
  "registry_resource_heads",
  {
    resourceId: text("resource_id").primaryKey(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      check(
        "chk_registry_resource_head_id",
        sql`${table.resourceId} ~ '^template:html-ppt-[a-z0-9]+(-[a-z0-9]+)*-runbook$'`,
      ),
      foreignKey({
        name: "fk_registry_resource_head_archive",
        columns: [table.resourceId, table.sha256],
        foreignColumns: [
          registryResourceArchives.resourceId,
          registryResourceArchives.sha256,
        ],
      }),
    ];
  },
);
