import { SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION } from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import { connectorCatalog } from "@okouai/db/runtime/connector-catalog";
import { computed } from "ccstate";
import { eq } from "drizzle-orm";

import { db$ } from "../external/db";

export const acceptedConnectorCatalogRelease$ = computed(async (get) => {
  const [catalog] = await get(db$)
    .select({
      schemaVersion: connectorCatalog.schemaVersion,
      catalogDigest: connectorCatalog.hash,
      catalogVersion: connectorCatalog.catalogVersion,
    })
    .from(connectorCatalog)
    .where(
      eq(
        connectorCatalog.schemaVersion,
        SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
      ),
    );
  return catalog ?? null;
});
