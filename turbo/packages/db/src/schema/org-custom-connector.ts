import {
  check,
  index,
  pgTable,
  unique,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { orgCustomConnectorColumns } from "../columns/org-custom-connector";

export type {
  OrgCustomConnectorField,
  OrgCustomConnectorHeaderInjection,
  OrgCustomConnectorQueryInjection,
} from "@okouai/db/jsonb-contracts/org-custom-connector";

export type {
  OrgCustomConnectorAuthMode,
  OrgCustomConnectorMcpTransport,
} from "../columns/org-custom-connector";

/**
 * Org-defined custom connectors (v1 of the connector gallery).
 *
 * This is the single organization-owned identity for both manual and OAuth
 * custom connectors. Authentication-specific state lives in the corresponding
 * value or OAuth connection tables.
 */
export const orgCustomConnectors = pgTable(
  "org_custom_connectors",
  {
    ...orgCustomConnectorColumns(),
    // Retained for rollback to API 2.100.1, which still writes the mirror.
    skillStorageVersionId: varchar("skill_storage_version_id", { length: 64 }),
  },
  (table) => {
    return [
      index("idx_org_custom_connectors_org").on(table.orgId),
      uniqueIndex("idx_org_custom_connectors_org_slug").on(
        table.orgId,
        table.slug,
      ),
      unique("idx_org_custom_connectors_id_org").on(table.id, table.orgId),
      index("idx_org_custom_connectors_skill_storage_version").on(
        table.skillStorageVersionId,
      ),
      check(
        "chk_org_custom_connectors_slug",
        sql`left(${table.slug}, 1) = '_'`,
      ),
      check(
        "chk_org_custom_connectors_auth_mode",
        sql`${table.authMode} IN ('none', 'manual', 'oauth', 'automatic')`,
      ),
      check(
        "chk_org_custom_connectors_automatic_oauth_mcp",
        sql`(
          ${table.authMode} <> 'automatic'
          OR (
            ${table.mcpEndpoint} IS NOT NULL
            AND ${table.mcpTransport} = 'streamable-http'
          )
        )`,
      ),
      check(
        "chk_org_custom_connectors_mcp",
        sql`(
          jsonb_typeof(${table.prefixTemplates}) = 'array'
          AND jsonb_typeof(${table.fields}) = 'array'
          AND jsonb_typeof(${table.headerInjections}) = 'array'
          AND jsonb_typeof(${table.queryInjections}) = 'array'
          AND (
            (
              ${table.mcpEndpoint} IS NULL
              AND ${table.mcpTransport} IS NULL
              AND ${table.prefixTemplates} <> '[]'::jsonb
              AND (
                (
                  ${table.authMode} = 'none'
                  AND NOT jsonb_path_exists(
                    ${table.fields},
                    '$[*] ? (@.kind == "secret")'
                  )
                  AND ${table.headerInjections} = '[]'::jsonb
                  AND ${table.queryInjections} = '[]'::jsonb
                ) OR (
                  ${table.authMode} IN ('manual', 'oauth')
                  AND (
                    ${table.headerInjections} <> '[]'::jsonb
                    OR ${table.queryInjections} <> '[]'::jsonb
                  )
                )
              )
            ) OR (
              ${table.mcpEndpoint} IS NOT NULL
              AND btrim(${table.mcpEndpoint}) <> ''
              AND ${table.mcpTransport} IS NOT NULL
              AND ${table.mcpTransport} = 'streamable-http'
              AND ${table.prefixTemplates} = '[]'::jsonb
              AND (
                (
                  ${table.authMode} IN ('none', 'automatic')
                  AND ${table.fields} = '[]'::jsonb
                  AND ${table.headerInjections} = '[]'::jsonb
                  AND ${table.queryInjections} = '[]'::jsonb
                ) OR (
                  ${table.authMode} IN ('manual', 'oauth')
                  AND (
                    ${table.headerInjections} <> '[]'::jsonb
                    OR ${table.queryInjections} <> '[]'::jsonb
                  )
                )
              )
              AND ${table.permissionBundleRef} IS NULL
            )
          )
        )`,
      ),
      check(
        "chk_org_custom_connectors_storage_version_positive",
        sql`${table.storageVersion} > 0`,
      ),
      check(
        "chk_org_custom_connectors_skill_size",
        sql`${table.skillMarkdown} IS NULL OR octet_length(${table.skillMarkdown}) <= 65536`,
      ),
      check(
        "org_custom_connectors_skill_content_bundle_check",
        sql`(
          (${table.skillContentBundle} IS NULL AND ${table.skillContentBundleSourceVersionId} IS NULL)
          OR (
            ${table.skillContentBundle} IS NOT NULL
            AND ${table.skillContentBundleSourceVersionId} IS NOT NULL
            AND ${table.skillContentBundleSourceVersionId} ~ '^[0-9a-f]{64}$'
            AND jsonb_typeof(${table.skillContentBundle}) = 'object'
            AND ${table.skillContentBundle} ?& ARRAY['sha256', 'archiveBytes']
            AND (${table.skillContentBundle} - 'sha256' - 'archiveBytes') = '{}'::jsonb
            AND jsonb_typeof(${table.skillContentBundle}->'sha256') = 'string'
            AND ${table.skillContentBundle}->>'sha256' ~ '^[0-9a-f]{64}$'
            AND CASE WHEN jsonb_typeof(${table.skillContentBundle}->'archiveBytes') = 'number'
              THEN (${table.skillContentBundle}->>'archiveBytes')::numeric BETWEEN 1 AND 33554432
                AND trunc((${table.skillContentBundle}->>'archiveBytes')::numeric) = (${table.skillContentBundle}->>'archiveBytes')::numeric
              ELSE false
            END
          )
        ) IS TRUE`,
      ),
      check(
        "chk_org_custom_connectors_skill_publication_pair",
        sql`(${table.skillMarkdown} IS NULL) = (${table.skillContentBundleSourceVersionId} IS NULL)`,
      ),
    ];
  },
);
