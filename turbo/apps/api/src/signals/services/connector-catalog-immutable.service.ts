import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import {
  connectorCatalog,
  connectorCatalogEntries,
} from "@okouai/db/schema/connector-catalog";
import {
  connectorCatalogArtifactConnectorSchema,
  SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
  type ConnectorCatalogArtifact,
} from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import { connectorCatalogRuntimeProjectionPayload } from "@okouai/connectors/connector-catalog/runtime-projection";
import { db$, writeDb$ } from "../external/db";

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

// JSONB normalizes key order; compare canonical original payload bytes, not
// capability-filtered projections. Partial inserts remain reusable on retry.
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
    for (const connector of args.artifact.connectors) {
      signal.throwIfAborted();
      await db
        .insert(connectorCatalogEntries)
        .values({
          hash: args.hash,
          slug: connector.slug,
          payload: { ...connector },
        })
        .onConflictDoNothing();
      signal.throwIfAborted();
      const [stored] = await db
        .select({ payload: connectorCatalogEntries.payload })
        .from(connectorCatalogEntries)
        .where(
          and(
            eq(connectorCatalogEntries.hash, args.hash),
            eq(connectorCatalogEntries.slug, connector.slug),
          ),
        );
      signal.throwIfAborted();
      if (
        !stored ||
        !connectorCatalogRuntimeProjectionPayload(
          connectorCatalogArtifactConnectorSchema.parse(stored.payload),
        ).equals(connectorCatalogRuntimeProjectionPayload(connector))
      ) {
        throw new Error("Immutable connector catalog entry content conflicts");
      }
    }
    const rows = await db
      .select({ slug: connectorCatalogEntries.slug })
      .from(connectorCatalogEntries)
      .where(eq(connectorCatalogEntries.hash, args.hash));
    signal.throwIfAborted();
    const expected = args.artifact.connectors
      .map((entry) => {
        return entry.slug;
      })
      .sort();
    const actual = rows
      .map((entry) => {
        return entry.slug;
      })
      .sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        "Immutable connector catalog entry manifest does not match",
      );
    }
    signal.throwIfAborted();
  },
);

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
