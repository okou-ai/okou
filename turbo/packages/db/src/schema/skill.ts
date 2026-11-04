import {
  pgTable,
  uuid,
  text,
  varchar,
  bigint,
  integer,
  timestamp,
  index,
  jsonb,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { storages } from "./storage";
import type { SkillFrontmatter } from "@okouai/db/jsonb-contracts/skill";
import type { ContentBundle } from "@okouai/db/jsonb-contracts/content-bundle";

/**
 * Skills table
 * Global cache of GitHub-hosted skills. Each row represents one skill
 * identified by its canonical GitHub tree URL. Skills are shared across
 * all orgs — not org-scoped.
 */
export const skills = pgTable(
  "skills",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    url: text("url").unique().notNull(),
    name: text("name").notNull(),
    fullPath: text("full_path").notNull(),
    storageId: uuid("storage_id").references(() => {
      return storages.id;
    }),
    versionHash: varchar("version_hash", { length: 64 }),
    contentBundle: jsonb("content_bundle").$type<ContentBundle>(),
    // Logical source version whose files produced contentBundle.
    contentBundleSourceVersionHash: varchar(
      "content_bundle_source_version_hash",
      {
        length: 64,
      },
    ),
    commitSha: varchar("commit_sha", { length: 40 }),
    frontmatter: jsonb("frontmatter").$type<SkillFrontmatter>(),
    s3Key: text("s3_key"),
    size: bigint("size", { mode: "number" }).notNull().default(0),
    fileCount: integer("file_count").notNull().default(0),
    syncedAt: timestamp("synced_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_skills_name").on(table.name),
      index("idx_skills_storage_id").on(table.storageId),
      check(
        "skills_content_bundle_check",
        sql`(
          (${table.contentBundle} IS NULL AND ${table.contentBundleSourceVersionHash} IS NULL)
          OR (
            ${table.contentBundle} IS NOT NULL
            AND ${table.contentBundleSourceVersionHash} IS NOT NULL
            AND ${table.contentBundleSourceVersionHash} ~ '^[0-9a-f]{64}$'
            AND jsonb_typeof(${table.contentBundle}) = 'object'
            AND ${table.contentBundle} ?& ARRAY['sha256', 'archiveBytes']
            AND (${table.contentBundle} - 'sha256' - 'archiveBytes') = '{}'::jsonb
            AND jsonb_typeof(${table.contentBundle}->'sha256') = 'string'
            AND ${table.contentBundle}->>'sha256' ~ '^[0-9a-f]{64}$'
            AND CASE WHEN jsonb_typeof(${table.contentBundle}->'archiveBytes') = 'number'
              THEN (${table.contentBundle}->>'archiveBytes')::numeric BETWEEN 1 AND 33554432
                AND trunc((${table.contentBundle}->>'archiveBytes')::numeric) = (${table.contentBundle}->>'archiveBytes')::numeric
              ELSE false
            END
          )
        )`,
      ),
    ];
  },
);
