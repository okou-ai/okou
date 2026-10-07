import { connectorCatalogEntryColumns } from "@okouai/connectors/connector-catalog/entry-columns";
import { command } from "ccstate";
import { eq, ne } from "drizzle-orm";
import {
  connectorCatalog,
  connectorCatalogEntries,
} from "@okouai/db/schema/connector-catalog";
import {
  SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
  type ConnectorCatalogArtifact,
} from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import { db$, writeDb$, type Db } from "../external/db";
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
// registration before publishing an entry. An interrupted preparer leaves an
// unreferenced partial generation that a retry at the same hash reuses; entries
// of hashes already captured by readers are never rewritten or deleted.
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
                ...connectorCatalogEntryColumns(connector),
              };
            }),
        )
        .onConflictDoNothing();
      signal.throwIfAborted();
    }
  },
);

// Last writer wins: one scheduled cron owns production publication. The
// caller has completed every entry at `hash` before calling this, so the
// pointer never references a partial generation. The conditional upsert
// returns a row only when it created the pointer or changed its hash, so
// exactly one concurrent writer observes a given switch, even for the first
// publication, and the caller applies switch effects in the same transaction.
export async function publishImmutableCatalogPointer(
  tx: Db,
  args: { readonly schemaVersion: number; readonly hash: string },
): Promise<{ readonly switched: boolean }> {
  const changed = await tx
    .insert(connectorCatalog)
    .values({ schemaVersion: args.schemaVersion, hash: args.hash })
    .onConflictDoUpdate({
      target: connectorCatalog.schemaVersion,
      set: { hash: args.hash },
      setWhere: ne(connectorCatalog.hash, args.hash),
    })
    .returning({ hash: connectorCatalog.hash });
  return { switched: changed.length === 1 };
}
