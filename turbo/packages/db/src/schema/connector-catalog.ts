import { jsonb, pgTable, primaryKey } from "drizzle-orm/pg-core";
import type { ImmutableConnectorCatalogEntry } from "@okouai/db/jsonb-contracts/immutable-connector-catalog";
import { connectorCatalogColumns } from "../columns/connector-catalog";

export { connectorCatalog } from "../runtime/connector-catalog";

// Physical schema only: retain payload until the payload-independent API has
// shipped. Runtime queries use ../runtime/connector-catalog instead.
export const connectorCatalogEntries = pgTable(
  "connector_catalog_entries",
  {
    ...connectorCatalogColumns(),
    payload: jsonb("payload").$type<ImmutableConnectorCatalogEntry>(),
  },
  (table) => {
    return [primaryKey({ columns: [table.hash, table.slug] })];
  },
);
