import { integer, jsonb, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

import type {
  ImmutableConnectorCatalogEntry,
  ImmutableConnectorCatalogIcon,
  ImmutableConnectorCatalogAuthMethods,
  ImmutableConnectorCatalogMcp,
  ImmutableConnectorCatalogSkill,
  ImmutableConnectorCatalogFirewall,
  ImmutableConnectorCatalogPermissionSummary,
} from "@okouai/db/jsonb-contracts/immutable-connector-catalog";

// One pointer row per artifact schema version. The pointer only moves after
// every entry of its generation exists; the hash is the generation identity.
export const connectorCatalog = pgTable("connector_catalog", {
  schemaVersion: integer("schema_version").primaryKey(),
  hash: text("hash").notNull(),
});

// Immutable, retained generations keyed by content hash. Independent columns
// are nullable only while outgoing API writers can still insert payload alone.
// The publisher payload remains dual-written through the rollback window.
export const connectorCatalogEntries = pgTable(
  "connector_catalog_entries",
  {
    hash: text("hash").notNull(),
    slug: text("slug").notNull(),
    payload: jsonb("payload").$type<ImmutableConnectorCatalogEntry>().notNull(),
    label: text("label"),
    description: text("description"),
    category: text("category"),
    icon: jsonb("icon").$type<ImmutableConnectorCatalogIcon>(),
    tags: text("tags").array(),
    generation: text("generation").array(),
    authMethods:
      jsonb("auth_methods").$type<ImmutableConnectorCatalogAuthMethods>(),
    mcp: jsonb("mcp").$type<ImmutableConnectorCatalogMcp>(),
    skill: jsonb("skill").$type<ImmutableConnectorCatalogSkill>(),
    firewall: jsonb("firewall").$type<ImmutableConnectorCatalogFirewall>(),
    permissionSummary:
      jsonb(
        "permission_summary",
      ).$type<ImmutableConnectorCatalogPermissionSummary>(),
  },
  (table) => {
    return [primaryKey({ columns: [table.hash, table.slug] })];
  },
);
