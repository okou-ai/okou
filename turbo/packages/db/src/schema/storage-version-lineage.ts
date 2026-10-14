import { pgTable, uuid, varchar, timestamp, index } from "drizzle-orm/pg-core";
import { storages } from "./storage";

/**
 * Storage version lineage table
 * Records parent-child relationships between artifact/memory versions
 * produced by agent runs, enabling detection of detached versions
 * when parallel runs overwrite HEAD.
 *
 * Only tracks agent runs — CLI uploads are NOT tracked.
 * All writeback Storage mounts are supported.
 */
export const storageVersionLineage = pgTable(
  "storage_version_lineage",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    storageId: uuid("storage_id")
      .notNull()
      .references(
        () => {
          return storages.id;
        },
        { onDelete: "cascade" },
      ),
    versionId: varchar("version_id", { length: 64 }).notNull(),
    parentVersionId: varchar("parent_version_id", { length: 64 }).notNull(),
    runId: uuid("run_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_storage_version_lineage_storage_version").on(
        table.storageId,
        table.versionId,
      ),
      index("idx_storage_version_lineage_storage_parent").on(
        table.storageId,
        table.parentVersionId,
      ),
      index("idx_storage_version_lineage_run").on(table.runId),
    ];
  },
);
