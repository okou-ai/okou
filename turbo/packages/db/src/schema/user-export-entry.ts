import type { UserExportEntryMetadata } from "@okouai/db/jsonb-contracts/user-export-entry";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { exportJobs } from "./export-job";

/** Ordered immutable source inventory and resumable byte-scan progress. */
export const userExportEntries = pgTable(
  "user_export_entries",
  {
    jobId: uuid("job_id")
      .notNull()
      .references(
        () => {
          return exportJobs.id;
        },
        { onDelete: "cascade" },
      ),
    ordinal: integer("ordinal").notNull(),
    path: text("path").notNull(),
    sourceKey: text("source_key").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    crc32: bigint("crc32", { mode: "number" }).default(0).notNull(),
    scannedBytes: bigint("scanned_bytes", { mode: "number" })
      .default(0)
      .notNull(),
    localOffset: bigint("local_offset", { mode: "number" })
      .default(0)
      .notNull(),
    centralOffset: bigint("central_offset", { mode: "number" })
      .default(0)
      .notNull(),
    metadata: jsonb("metadata")
      .$type<UserExportEntryMetadata>()
      .default({})
      .notNull(),
    ready: boolean("ready").default(false).notNull(),
  },
  (table) => {
    return [
      primaryKey({ columns: [table.jobId, table.ordinal] }),
      uniqueIndex("idx_user_export_entries_path").on(table.jobId, table.path),
      index("idx_user_export_entries_local_offset").on(
        table.jobId,
        table.localOffset,
      ),
      index("idx_user_export_entries_central_offset").on(
        table.jobId,
        table.centralOffset,
      ),
      index("idx_user_export_entries_source_key").on(table.sourceKey),
      check("user_export_entries_ordinal_check", sql`${table.ordinal} >= 0`),
      check(
        "user_export_entries_bytes_check",
        sql`${table.size} BETWEEN 0 AND 9007199254740991 AND
          ${table.scannedBytes} BETWEEN 0 AND ${table.size} AND
          ${table.localOffset} BETWEEN 0 AND 9007199254740991 AND
          ${table.centralOffset} BETWEEN 0 AND 9007199254740991`,
      ),
      check(
        "user_export_entries_crc32_check",
        sql`${table.crc32} BETWEEN 0 AND 4294967295`,
      ),
    ];
  },
);

/** Successfully uploaded deterministic parts of one export ZIP. */
export const userExportParts = pgTable(
  "user_export_parts",
  {
    jobId: uuid("job_id")
      .notNull()
      .references(
        () => {
          return exportJobs.id;
        },
        { onDelete: "cascade" },
      ),
    partNumber: integer("part_number").notNull(),
    etag: text("etag").notNull(),
  },
  (table) => {
    return [
      primaryKey({ columns: [table.jobId, table.partNumber] }),
      check(
        "user_export_parts_number_check",
        sql`${table.partNumber} BETWEEN 1 AND 10000`,
      ),
    ];
  },
);
