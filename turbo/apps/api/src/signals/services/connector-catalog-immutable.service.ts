import { command } from "ccstate";
import { eq } from "drizzle-orm";
import {
  connectorCatalog,
  connectorCatalogEntries,
} from "@okouai/db/schema/connector-catalog";
import {
  SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
  type ConnectorCatalogArtifact,
  type ConnectorCatalogArtifactConnector,
} from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import { db$, writeDb$ } from "../external/db";
import {
  prepareConnectorCatalogSkills,
  registerPreparedConnectorCatalogSkills$,
} from "./connector-catalog-skill-registration.service";

const IMMUTABLE_CATALOG_ENTRY_INSERT_BATCH_SIZE = 100;

export const immutableCatalogHash$ = command(
  async ({ get }, signal: AbortSignal): Promise<string | null> => {
    signal.throwIfAborted();
    const [current] = await get(db$)
      .select({ hash: connectorCatalog.hash })
      .from(connectorCatalog)
      .where(
        eq(
          connectorCatalog.schemaVersion,
          SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
        ),
      );
    signal.throwIfAborted();
    return current?.hash ?? null;
  },
);

// Entry existence is the preparation receipt: every writer must finish storage
// registration before publishing an entry. Partial generations are reusable;
// only the owning sync command can publish the catalog pointer afterward.
export const prepareImmutableCatalogEntries$ = command(
  async (
    { set },
    args: {
      readonly artifact: ConnectorCatalogArtifact;
      readonly hash: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    signal.throwIfAborted();
    const existing = await db
      .select({ slug: connectorCatalogEntries.slug })
      .from(connectorCatalogEntries)
      .where(eq(connectorCatalogEntries.hash, args.hash));
    signal.throwIfAborted();
    const existingSlugs = new Set(
      existing.map((entry) => {
        return entry.slug;
      }),
    );
    const missing = args.artifact.connectors.filter((entry) => {
      return !existingSlugs.has(entry.slug);
    });
    if (missing.length === 0) {
      return;
    }
    const registrations = await prepareConnectorCatalogSkills(
      { db, artifact: { ...args.artifact, connectors: missing } },
      signal,
    );
    await set(registerPreparedConnectorCatalogSkills$, registrations, signal);
    signal.throwIfAborted();
    // Bounded multi-row statements keep a cold ~4,600-entry generation from
    // paying one database round trip per entry. Each batch is independently
    // idempotent; batches follow publication order for every preparer.
    for (
      let offset = 0;
      offset < missing.length;
      offset += IMMUTABLE_CATALOG_ENTRY_INSERT_BATCH_SIZE
    ) {
      await db
        .insert(connectorCatalogEntries)
        .values(
          missing
            .slice(offset, offset + IMMUTABLE_CATALOG_ENTRY_INSERT_BATCH_SIZE)
            .map((connector) => {
              return {
                hash: args.hash,
                slug: connector.slug,
                payload: { ...connector },
                ...immutableCatalogEntryColumns(connector),
              };
            }),
        )
        .onConflictDoNothing();
      signal.throwIfAborted();
    }
  },
);

// Shared by full sync, preview initialization and fixture writers.
// The complete publisher payload remains the immutable source of truth.
export function immutableCatalogEntryColumns(
  connector: ConnectorCatalogArtifactConnector,
) {
  return {
    label: connector.label,
    description: connector.description,
    category: connector.category,
    authMethods: connector.authMethods,
    firewall: connector.firewall,
    storageName:
      connector.skill.kind === "bundled" ? connector.skill.storageName : null,
    versionId:
      connector.skill.kind === "bundled" ? connector.skill.versionId : null,
    mcpEndpoint: connector.mcp?.endpoint ?? null,
  };
}

// Pure values only. The owning sync command performs CAS and Pi SQL in its
// transaction callback, together with the unchanged legacy acceptance bridge.
export function immutableCatalogValues(
  artifact: ConnectorCatalogArtifact,
  hash: string,
  activatedAt: Date,
) {
  const { connectors, ...header } = artifact;
  return {
    schemaVersion: artifact.artifactSchemaVersion,
    hash,
    activatedAt,
    catalogVersion: artifact.catalogVersion,
    catalogHeader: { ...header },
    entrySlugs: connectors
      .map((entry) => {
        return entry.slug;
      })
      .sort(),
  };
}
