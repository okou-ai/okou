import {
  bigint,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const FILE_ORIGINS = ["user", "agent", "system"] as const;
export type FileOrigin = (typeof FILE_ORIGINS)[number];

/**
 * Pure binary file metadata (File Storage domain).
 * Stores binary file records without `run_id`, permission fields,
 * or hosted-site placeholder rows. Unshared files are accessible only
 * to their `(ownerUserId, orgId)`.
 */
export const files = pgTable(
  "files",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    storageKey: text("storage_key"),
    filename: text("filename"),
    contentType: text("content_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    checksumSha256: varchar("checksum_sha256", { length: 64 }),
    origin: varchar("origin", { length: 16 }).$type<FileOrigin>().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => {
    return [
      check(
        "files_origin_check",
        sql`${table.origin} IN ('user', 'agent', 'system')`,
      ),
      check("files_org_id_nonempty", sql`length(${table.orgId}) > 0`),
      index("files_owner_created_idx")
        .on(
          table.orgId,
          table.ownerUserId,
          table.createdAt.desc(),
          table.id.desc(),
        )
        .where(sql`${table.deletedAt} IS NULL`),
      index("files_storage_key_idx")
        .on(table.storageKey)
        .where(sql`${table.storageKey} IS NOT NULL`),
    ];
  },
);
