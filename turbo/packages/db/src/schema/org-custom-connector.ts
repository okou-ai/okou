import {
  bigint,
  boolean,
  check,
  foreignKey,
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  unique,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type {
  OrgCustomConnectorFields,
  OrgCustomConnectorHeaderInjections,
  OrgCustomConnectorPrefixTemplates,
  OrgCustomConnectorQueryInjections,
} from "@okouai/db/jsonb-contracts/org-custom-connector";

import { storageVersions } from "./storage";

export type {
  OrgCustomConnectorField,
  OrgCustomConnectorHeaderInjection,
  OrgCustomConnectorQueryInjection,
} from "@okouai/db/jsonb-contracts/org-custom-connector";

export type OrgCustomConnectorAuthMode =
  "none" | "manual" | "oauth" | "automatic";
export type OrgCustomConnectorMcpTransport = "streamable-http";

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
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    slug: varchar("slug", { length: 64 }).notNull(),
    displayName: varchar("display_name", { length: 128 }).notNull(),
    prefixTemplates: jsonb("prefix_templates")
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<OrgCustomConnectorPrefixTemplates>(),
    fields: jsonb("fields")
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<OrgCustomConnectorFields>(),
    headerInjections: jsonb("header_injections")
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<OrgCustomConnectorHeaderInjections>(),
    queryInjections: jsonb("query_injections")
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<OrgCustomConnectorQueryInjections>(),
    authMode: varchar("auth_mode", { length: 16 })
      .$type<OrgCustomConnectorAuthMode>()
      .notNull()
      .default("manual"),
    enabled: boolean("enabled").notNull().default(true),
    permissionBundleRef: varchar("permission_bundle_ref", { length: 128 }),
    mcpEndpoint: text("mcp_endpoint"),
    mcpTransport: varchar("mcp_transport", {
      length: 32,
    }).$type<OrgCustomConnectorMcpTransport>(),
    skillMarkdown: text("skill_markdown"),
    skillStorageVersionId: varchar("skill_storage_version_id", {
      length: 64,
    }),
    storageVersion: bigint("storage_version", { mode: "number" })
      .notNull()
      .default(1),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
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
      foreignKey({
        name: "fk_org_custom_connectors_skill_storage_version",
        columns: [table.skillStorageVersionId],
        foreignColumns: [storageVersions.id],
      }).onDelete("restrict"),
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
        "chk_org_custom_connectors_skill_version_pair",
        sql`(
          (${table.skillMarkdown} IS NULL AND ${table.skillStorageVersionId} IS NULL)
          OR (
            ${table.skillMarkdown} IS NOT NULL
            AND ${table.skillStorageVersionId} IS NOT NULL
          )
        )`,
      ),
    ];
  },
);
