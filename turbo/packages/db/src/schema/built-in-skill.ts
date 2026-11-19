import {
  boolean,
  check,
  jsonb,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { ContentBundle } from "@okouai/db/jsonb-contracts/content-bundle";

export const builtInSkills = pgTable(
  "built_in_skills",
  {
    url: text("url").primaryKey(),
    versionHash: varchar("version_hash", { length: 64 }).notNull(),
    contentBundle: jsonb("content_bundle").$type<ContentBundle>().notNull(),
    contentBundleSourceVersionHash: varchar(
      "content_bundle_source_version_hash",
      {
        length: 64,
      },
    ).notNull(),
    commitSha: varchar("commit_sha", { length: 40 }),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    // The cutover migration activates the complete catalog together.
    authoritative: boolean("authoritative").default(false).notNull(),
  },
  (table) => [
    check(
      "built_in_skills_bundle_version_check",
      sql`${table.versionHash} ~ '^[0-9a-f]{64}$'
        AND ${table.contentBundleSourceVersionHash} = ${table.versionHash}`,
    ),
  ],
);
