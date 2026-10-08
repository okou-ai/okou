import { jsonb, text } from "drizzle-orm/pg-core";
import type {
  ImmutableConnectorCatalogIcon,
  ImmutableConnectorCatalogAuthMethods,
  ImmutableConnectorCatalogMcp,
  ImmutableConnectorCatalogSkill,
  ImmutableConnectorCatalogFirewall,
  ImmutableConnectorCatalogPermissionSummary,
} from "@okouai/db/jsonb-contracts/immutable-connector-catalog";

// The runtime and physical schema share every supported column. The retained
// payload column belongs only to the physical schema until the next release.
export function connectorCatalogColumns() {
  return {
    hash: text("hash").notNull(),
    slug: text("slug").notNull(),
    label: text("label").notNull(),
    description: text("description").notNull(),
    category: text("category").notNull(),
    icon: jsonb("icon").$type<ImmutableConnectorCatalogIcon>().notNull(),
    tags: text("tags").array().notNull(),
    generation: text("generation").array().notNull(),
    authMethods: jsonb("auth_methods")
      .$type<ImmutableConnectorCatalogAuthMethods>()
      .notNull(),
    mcp: jsonb("mcp").$type<ImmutableConnectorCatalogMcp>(),
    skill: jsonb("skill").$type<ImmutableConnectorCatalogSkill>().notNull(),
    firewall: jsonb("firewall")
      .$type<ImmutableConnectorCatalogFirewall>()
      .notNull(),
    permissionSummary: jsonb("permission_summary")
      .$type<ImmutableConnectorCatalogPermissionSummary>()
      .notNull(),
  };
}
