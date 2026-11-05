import { check, integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { connectorCatalogColumns } from "../columns/connector-catalog";

// One pointer row per artifact schema version. The pointer only moves after
// every entry of its generation exists; the hash is the generation identity.
export const connectorCatalog = pgTable("connector_catalog", {
  schemaVersion: integer("schema_version").primaryKey(),
  hash: text("hash").notNull(),
  catalogVersion: text("catalog_version"),
});

export const connectorCatalogEntries = pgTable(
  "connector_catalog_entries",
  connectorCatalogColumns(),
  (table) => {
    return [
      primaryKey({ columns: [table.hash, table.slug] }),
      check(
        "connector_catalog_entries_skill_content_bundle_check",
        sql`(
          (${table.skillContentBundle} IS NULL AND ${table.skillContentBundleSourceVersionId} IS NULL)
          OR (
            ${table.skillContentBundle} IS NOT NULL
            AND ${table.skillContentBundleSourceVersionId} IS NOT NULL
            AND ${table.skillContentBundleSourceVersionId} ~ '^[0-9a-f]{64}$'
            AND ${table.skill}->>'kind' = 'bundled'
            AND ${table.skill}->>'versionId' = ${table.skillContentBundleSourceVersionId}
            AND jsonb_typeof(${table.skillContentBundle}) = 'object'
            AND ${table.skillContentBundle} ?& ARRAY['sha256', 'archiveBytes']
            AND (${table.skillContentBundle} - 'sha256' - 'archiveBytes') = '{}'::jsonb
            AND jsonb_typeof(${table.skillContentBundle}->'sha256') = 'string'
            AND ${table.skillContentBundle}->>'sha256' ~ '^[0-9a-f]{64}$'
            AND CASE WHEN jsonb_typeof(${table.skillContentBundle}->'archiveBytes') = 'number'
              THEN (${table.skillContentBundle}->>'archiveBytes')::numeric BETWEEN 1 AND 33554432
                AND trunc((${table.skillContentBundle}->>'archiveBytes')::numeric) = (${table.skillContentBundle}->>'archiveBytes')::numeric
                AND ${table.skillContentBundle}->>'archiveBytes' = ${table.skill}->>'archiveSize'
              ELSE false
            END
          )
        ) IS TRUE`,
      ),
    ];
  },
);
