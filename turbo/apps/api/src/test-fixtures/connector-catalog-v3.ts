import { createHash } from "node:crypto";

import { encodeConnectorCatalogSnapshot } from "@okouai/connectors/connector-catalog/artifacts/loader";
import {
  connectorCatalogActiveSnapshot,
  connectorCatalogSyncState,
} from "@okouai/db/schema/connector-catalog";
import { createStore } from "ccstate";

import { nowDate } from "../lib/time";
import { writeDb$ } from "../signals/external/db";
import { connectorCatalogSource } from "../signals/services/connector-catalog-source";

/**
 * Historical-state exception: the current production sync endpoint accepts only
 * v4, so an accepted snapshot left by an older v3 API cannot be created through
 * today's API. Callers own a unique source bucket. Assertions stay on routes.
 */
export async function installAcceptedV3ConnectorCatalog(args: {
  readonly catalogVersion: string;
  readonly catalogBytes: Uint8Array;
}): Promise<void> {
  const sourceId = connectorCatalogSource().sourceId;
  const catalogDigest = `sha256:${createHash("sha256")
    .update(args.catalogBytes)
    .digest("hex")}`;
  const catalogKey = `connectors/v3/releases/${args.catalogVersion}/catalog.json`;
  const activatedAt = nowDate();
  const db = createStore().set(writeDb$);
  await db.transaction(async (tx) => {
    await tx.insert(connectorCatalogSyncState).values({
      sourceId,
      schemaVersion: 3,
      revision: 1,
      lastObservedCatalogVersion: args.catalogVersion,
      lastObservedCatalogKey: catalogKey,
      lastObservedCatalogDigest: catalogDigest,
      lastAttemptAt: activatedAt,
      lastAttemptOutcome: "accepted",
      lastAttemptReusedCachedRejection: false,
      lastSuccessAt: activatedAt,
    });
    await tx.insert(connectorCatalogActiveSnapshot).values({
      sourceId,
      schemaVersion: 3,
      catalogVersion: args.catalogVersion,
      catalogKey,
      catalogDigest,
      catalogRawSize: args.catalogBytes.byteLength,
      catalogGzip: encodeConnectorCatalogSnapshot(args.catalogBytes),
      activatedAt,
    });
  });
}
