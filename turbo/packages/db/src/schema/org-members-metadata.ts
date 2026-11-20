import { sql } from "drizzle-orm";
import { check, pgTable, primaryKey } from "drizzle-orm/pg-core";
import { orgMembersMetadataColumns } from "../columns/org-members-metadata";

/** Per-member preferences and their database constraints. */
export const orgMembersMetadata = pgTable(
  "org_members_metadata",
  orgMembersMetadataColumns(),
  (table) => {
    return [
      primaryKey({ columns: [table.orgId, table.userId] }),
      check(
        "org_members_metadata_canonical_selection_check",
        sql`${table.selectedModel} NOT IN ('okou-1.0', 'okou-1.0-pro', 'okou-1.0-max') AND ${table.selectedModel} NOT LIKE '@preset/%'`,
      ),
      check(
        "org_members_metadata_selected_model_check",
        sql`char_length(${table.selectedModel}) > 0`,
      ),
      check(
        "org_members_metadata_explicit_model_settings_check",
        sql`jsonb_typeof(${table.modelSettings}) = 'object' AND NOT jsonb_path_exists(${table.modelSettings}, '$.keyvalue() ? (@.key == "auto" || @.key == "okou-1.0" || @.key == "okou-1.0-pro" || @.key == "okou-1.0-max" || @.key starts with "@preset/")')`,
      ),
      check(
        "chk_org_members_metadata_service_tier",
        sql`${table.serviceTier} IS NULL OR ${table.serviceTier} = 'priority'`,
      ),
    ];
  },
);
