import { integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { connectorCatalogColumns } from "../columns/connector-catalog";

// One pointer row per artifact schema version. The pointer only moves after
// every entry of its generation exists; the hash is the generation identity.
export const connectorCatalog = pgTable("connector_catalog", {
  schemaVersion: integer("schema_version").primaryKey(),
  hash: text("hash").notNull(),
});

export const connectorCatalogEntries = pgTable(
  "connector_catalog_entries",
  connectorCatalogColumns(),
  (table) => {
    return [primaryKey({ columns: [table.hash, table.slug] })];
  },
);
