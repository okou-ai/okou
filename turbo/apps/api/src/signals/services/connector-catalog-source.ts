import { createHash } from "node:crypto";

import { env } from "../../lib/env";
import { safeUrlParse } from "../utils";

export interface ConnectorCatalogSource {
  readonly bucket: string;
  readonly sourceId: string;
}

const CONNECTOR_CATALOG_PERSISTED_SNAPSHOT_GENERATION = 3;

export function connectorCatalogSource(): ConnectorCatalogSource {
  const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
  const endpoint =
    env("S3_ENDPOINT") ??
    `https://${env("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`;
  const endpointUrl = safeUrlParse(endpoint);
  if (
    endpointUrl === undefined ||
    (endpointUrl.protocol !== "http:" && endpointUrl.protocol !== "https:")
  ) {
    throw new Error("Connector catalog source endpoint is invalid");
  }
  const authority = endpointUrl.origin;
  // Generation 3 isolates snapshots accepted under the 64 MiB ceiling from
  // rollback APIs whose generation-2 persisted decoder is capped at 32 MiB.
  // A persisted decoder ceiling change must use a new stable generation.
  const sourceId = createHash("sha256")
    .update(authority)
    .update("\0")
    .update(bucket)
    .update("\0connector-catalog-persisted-snapshot-generation:")
    .update(String(CONNECTOR_CATALOG_PERSISTED_SNAPSHOT_GENERATION))
    .digest("hex");
  return { bucket, sourceId };
}
