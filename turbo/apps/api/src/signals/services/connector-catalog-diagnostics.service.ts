import type {
  ConnectorCatalogDiagnostics,
  ConnectorCatalogFilteringStatus,
} from "@okouai/api-contracts/contracts/connector-catalog-diagnostics";
import {
  connectorCatalog,
  connectorCatalogEntries,
} from "@okouai/db/schema/connector-catalog";
import {
  SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
  connectorCatalogAuthMethodSchema,
} from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import { connectorSlugSchema } from "@okouai/connectors/connector-catalog/artifacts/common";
import { connectorMcpSchema } from "@okouai/connectors/connector-catalog/artifacts/source";
import { command } from "ccstate";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";

import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { db$, type ReadonlyDb } from "../external/db";
import {
  connectorCatalogExecutableCapabilityState,
  evaluateConnectorCatalogCompatibility,
  type ExecutableCapabilityState,
} from "./connector-catalog-compatibility.service";
import { loadConnectorCredentialReadiness$ } from "./connector-credential-readiness.service";
import {
  connectorCatalogCompatibilityColumns,
  materializeConnectorCatalogCompatibilityRow,
} from "./connector-catalog-columns";

const log = logger("connector-catalog:diagnostics");

type CatalogDiagnostics = Omit<
  ConnectorCatalogDiagnostics,
  "credentialStorage"
>;

async function readCurrentPointer(db: ReadonlyDb) {
  const [pointer] = await db
    .select({
      schemaVersion: connectorCatalog.schemaVersion,
      hash: connectorCatalog.hash,
    })
    .from(connectorCatalog)
    .where(
      eq(
        connectorCatalog.schemaVersion,
        SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
      ),
    )
    .limit(1);
  return pointer;
}

// The entry fields compatibility evaluation reads.
const compatibilityInputSchema = z.object({
  slug: connectorSlugSchema,
  authMethods: z.array(connectorCatalogAuthMethodSchema),
  mcp: connectorMcpSchema.optional(),
});

async function readCompatibilityInputs(db: ReadonlyDb, hash: string) {
  // Entries are immutable and retained by hash, so reading them after the
  // pointer cannot mix generations even if the pointer moves in between.
  // Only the fields compatibility reads leave the database; descriptions and
  // other presentation fields can make a generation tens of MiB.
  const rows = await db
    .select({
      slug: connectorCatalogCompatibilityColumns.slug,
      authMethods: connectorCatalogCompatibilityColumns.authMethods,
      mcp: connectorCatalogCompatibilityColumns.mcp,
    })
    .from(connectorCatalogEntries)
    .where(eq(connectorCatalogEntries.hash, hash))
    .orderBy(asc(connectorCatalogEntries.slug));
  return rows.map((row) => {
    return compatibilityInputSchema.parse(
      materializeConnectorCatalogCompatibilityRow(row),
    );
  });
}

function unavailableFiltering(
  capability: ExecutableCapabilityState,
): ConnectorCatalogFilteringStatus {
  return {
    capabilityDigest: capability.digest,
    evaluatedAt: null,
    stale: true,
    filteredAuthMethods: [],
  };
}

/**
 * Catalog diagnostics for the cron sync response, derived only from the
 * current pointer and the immutable entries at its hash, with compatibility
 * evaluated on demand. Sync history (last attempt, last success, rejected
 * candidate) and activation time are not derivable from those and are not
 * reported.
 */
async function currentCatalogDiagnostics(
  db: ReadonlyDb,
  signal: AbortSignal,
): Promise<CatalogDiagnostics> {
  const capability = connectorCatalogExecutableCapabilityState();
  const pointer = await readCurrentPointer(db);
  signal.throwIfAborted();
  if (pointer === undefined) {
    return {
      schemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
      state: "never-synced",
      active: null,
      pointer: null,
      filtering: unavailableFiltering(capability),
    };
  }

  const entries = await readCompatibilityInputs(db, pointer.hash);
  signal.throwIfAborted();
  const identity = {
    active: { catalogDigest: pointer.hash },
    pointer: {
      schemaVersion: pointer.schemaVersion,
      hash: pointer.hash,
      entryCount: entries.length,
    },
  };
  if (entries.length === 0) {
    // Every published generation has entries; an empty one cannot serve and
    // compatibility over it is meaningless, so report it unavailable.
    log.warn("Connector catalog pointer has no entries", {
      schemaVersion: pointer.schemaVersion,
      hash: pointer.hash,
    });
    return {
      schemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
      state: "current",
      ...identity,
      filtering: unavailableFiltering(capability),
    };
  }

  const filteredAuthMethods = evaluateConnectorCatalogCompatibility({
    artifact: { connectors: entries },
    capability,
  });
  return {
    schemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
    state: "current",
    ...identity,
    filtering: {
      capabilityDigest: capability.digest,
      evaluatedAt: nowDate().toISOString(),
      stale: false,
      filteredAuthMethods: filteredAuthMethods.map((method) => {
        return {
          connectorSlug: method.connectorSlug,
          authMethodId: method.authMethodId,
          reasons: [...method.reasons],
        };
      }),
    },
  };
}

export const connectorCatalogDiagnostics$ = command(
  async (
    { get, set },
    signal: AbortSignal,
  ): Promise<ConnectorCatalogDiagnostics> => {
    const catalog = await currentCatalogDiagnostics(get(db$), signal);
    const credentialStorage = await set(loadConnectorCredentialReadiness$);
    signal.throwIfAborted();
    return { ...catalog, credentialStorage };
  },
);
