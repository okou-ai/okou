import {
  bigint,
  boolean,
  jsonb,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type {
  OrgCustomConnectorFields,
  OrgCustomConnectorHeaderInjections,
  OrgCustomConnectorPrefixTemplates,
  OrgCustomConnectorQueryInjections,
} from "@okouai/db/jsonb-contracts/org-custom-connector";
import { connectorSkillBundleColumns } from "./connector-skill-bundle";

export type OrgCustomConnectorAuthMode =
  "none" | "manual" | "oauth" | "automatic";
export type OrgCustomConnectorMcpTransport = "streamable-http";

export function orgCustomConnectorColumns() {
  return {
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
    ...connectorSkillBundleColumns(),
    storageVersion: bigint("storage_version", { mode: "number" })
      .notNull()
      .default(1),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  };
}
