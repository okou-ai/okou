import { CONNECTOR_CATALOG_ACTIVE_KEY } from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import {
  CONNECTOR_CATALOG_ACTIVE_MAX_BYTES,
  parseConnectorCatalogActivePointer,
  validateConnectorCatalogCandidateBytes,
} from "@okouai/connectors/connector-catalog/artifacts/loader";
import { CONNECTOR_CATALOG_MAX_RAW_BYTES } from "@okouai/connectors/connector-catalog/contracts";
import { command } from "ccstate";

import { env } from "../../lib/env";
import { writeDb$ } from "../external/db";
import { downloadS3BufferWithMaxBytes } from "../external/s3";
import {
  prepareImmutableCatalogEntries$,
  publishImmutableCatalogPointer,
} from "./connector-catalog-immutable.service";
import {
  connectorCatalogSource,
  type ConnectorCatalogSource,
} from "./connector-catalog-source";

const loadPreviewCatalogCandidate$ = command(
  async ({ get }, source: ConnectorCatalogSource, signal: AbortSignal) => {
    const pointerBytes = await get(
      downloadS3BufferWithMaxBytes(
        source.bucket,
        CONNECTOR_CATALOG_ACTIVE_KEY,
        CONNECTOR_CATALOG_ACTIVE_MAX_BYTES,
        signal,
      ),
    );
    signal.throwIfAborted();
    const pointer = parseConnectorCatalogActivePointer(pointerBytes);
    const rawBytes = await get(
      downloadS3BufferWithMaxBytes(
        source.bucket,
        pointer.catalogKey,
        CONNECTOR_CATALOG_MAX_RAW_BYTES,
        signal,
      ),
    );
    signal.throwIfAborted();
    return validateConnectorCatalogCandidateBytes({ pointer, rawBytes });
  },
);

// Preview initialization of the complete validated official publication, not
// a new publication. Entry preparation is the production synchronizer's: it
// registers bundled skills for, then writes, every entry missing at this hash.
// The pointer switches only after that whole generation exists. The response
// describes the validated publication; nothing beyond the pointer hash is
// stored for it.
export const seedPreviewConnectorCatalog$ = command(
  async ({ set }, signal: AbortSignal) => {
    if (env("ENV") !== "preview") {
      throw new Error(
        "Preview connector catalog seed is restricted to preview",
      );
    }
    const source = connectorCatalogSource();
    const candidate = await set(loadPreviewCatalogCandidate$, source, signal);
    signal.throwIfAborted();
    const hash = candidate.identity.catalogDigest;
    await set(
      prepareImmutableCatalogEntries$,
      { artifact: candidate.artifact, hash },
      signal,
    );
    signal.throwIfAborted();
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0232; new non-billing transactions are prohibited.
    await set(writeDb$).transaction(async (tx) => {
      await publishImmutableCatalogPointer(tx, {
        schemaVersion: candidate.artifact.artifactSchemaVersion,
        hash,
      });
      signal.throwIfAborted();
    });
    signal.throwIfAborted();
    return {
      catalogVersion: candidate.identity.catalogVersion,
      catalogDigest: hash,
      connectorSlugs: candidate.artifact.connectors
        .map((connector) => {
          return connector.slug;
        })
        .sort(),
    };
  },
);
