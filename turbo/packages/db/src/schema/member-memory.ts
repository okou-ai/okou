import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  varchar,
  bigint,
  integer,
  timestamp,
  unique,
  index,
  foreignKey,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

/** Member-owned authority; the API temporarily mirrors legacy metadata for B/C overlap. */
export const memberMemories = pgTable(
  "member_memories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    objectPrefix: text("object_prefix").notNull(),
    contentSize: bigint("content_size", { mode: "number" })
      .notNull()
      .default(0),
    fileCount: integer("file_count").notNull().default(0),
    headVersionId: varchar("head_version_id", { length: 64 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => {
    return [
      unique("member_memories_member_key").on(table.orgId, table.userId),
      index("member_memories_org_idx").on(table.orgId),
      foreignKey({
        name: "member_memories_head_owned_fk",
        columns: [table.id, table.headVersionId],
        foreignColumns: [memoryVersions.memoryId, memoryVersions.id],
      }),
    ];
  },
);

/** Preserve logical IDs and adopted object addresses, including retained candidates. */
export const memoryVersions = pgTable(
  "memory_versions",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    memoryId: uuid("memory_id")
      .notNull()
      .references(
        (): AnyPgColumn => {
          return memberMemories.id;
        },
        {
          onDelete: "cascade",
        },
      ),
    objectPrefix: text("object_prefix").notNull(),
    contentSize: bigint("content_size", { mode: "number" })
      .notNull()
      .default(0),
    archiveSize: bigint("archive_size", { mode: "number" }).notNull(),
    fileCount: integer("file_count").notNull().default(0),
    message: text("message"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => {
    return [
      unique("memory_versions_memory_id_id_key").on(table.memoryId, table.id),
      check(
        "memory_versions_archive_size_nonnegative",
        sql`${table.archiveSize} >= 0`,
      ),
    ];
  },
);

/** Publication provenance deliberately survives Run-history deletion. */
export const memoryVersionLineage = pgTable(
  "memory_version_lineage",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    memoryId: uuid("memory_id")
      .notNull()
      .references(
        () => {
          return memberMemories.id;
        },
        { onDelete: "cascade" },
      ),
    versionId: varchar("version_id", { length: 64 }).notNull(),
    parentVersionId: varchar("parent_version_id", { length: 64 }).notNull(),
    runId: uuid("run_id").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => {
    return [
      index("memory_version_lineage_version_idx").on(
        table.memoryId,
        table.versionId,
      ),
      index("memory_version_lineage_parent_idx").on(
        table.memoryId,
        table.parentVersionId,
      ),
      index("memory_version_lineage_run_idx").on(table.runId),
    ];
  },
);
