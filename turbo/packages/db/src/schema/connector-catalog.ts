import { integer, jsonb, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

import type { ImmutableConnectorCatalogEntry } from "@okouai/db/jsonb-contracts/immutable-connector-catalog";

// One pointer row per artifact schema version. The pointer only moves after
// every entry of its generation exists; the hash is the generation identity.
export const connectorCatalog = pgTable("connector_catalog", {
  schemaVersion: integer("schema_version").primaryKey(),
  hash: text("hash").notNull(),
});

// Immutable, retained generations keyed by content hash. The complete
// validated publisher entry is the only stored representation.
export const connectorCatalogEntries = pgTable(
  "connector_catalog_entries",
  {
    hash: text("hash").notNull(),
    slug: text("slug").notNull(),
    payload: jsonb("payload").$type<ImmutableConnectorCatalogEntry>().notNull(),
  },
  (table) => {
    return [primaryKey({ columns: [table.hash, table.slug] })];
  },
);
