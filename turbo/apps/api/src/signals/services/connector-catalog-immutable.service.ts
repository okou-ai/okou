import { and, eq, type SQL } from "drizzle-orm";
import {
  connectorCatalog,
  connectorCatalogEntries,
} from "@okouai/db/schema/connector-catalog";
import {
  connectorCatalogArtifactConnectorSchema,
  type ConnectorCatalogArtifact,
} from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import { connectorCatalogRuntimeProjectionPayload } from "@okouai/connectors/connector-catalog/runtime-projection";
import type { Db, SqlMutationDb } from "../external/db";
import {
  invalidateAllPiStableContextsSql,
  invalidatePiStableContextsForCatalogSourceSql,
} from "./pi-stable-context-generation.service";

type CatalogPreparationDb = SqlMutationDb;
type CatalogActivationDb = CatalogPreparationDb & {
  execute(query: SQL): Promise<unknown>;
};

export class ImmutableCatalogActivationConflict extends Error {}

export async function readImmutableCatalogHash(
  db: Pick<Db, "select">,
  schemaVersion: number,
): Promise<string | null> {
  const [current] = await db
    .select({ hash: connectorCatalog.hash })
    .from(connectorCatalog)
    .where(eq(connectorCatalog.schemaVersion, schemaVersion));
  return current?.hash ?? null;
}

// JSONB normalizes object key ordering. Compare canonical original connector
// bytes, never a capability-filtered projection or a partially rebuilt payload.
export async function prepareImmutableCatalogEntries(
  args: {
    readonly db: CatalogPreparationDb;
    readonly artifact: ConnectorCatalogArtifact;
    readonly hash: string;
  },
  signal: AbortSignal,
): Promise<void> {
  for (const connector of args.artifact.connectors) {
    signal.throwIfAborted();
    await args.db
      .insert(connectorCatalogEntries)
      .values({
        hash: args.hash,
        slug: connector.slug,
        payload: { ...connector },
      })
      .onConflictDoNothing();
    const [stored] = await args.db
      .select({ payload: connectorCatalogEntries.payload })
      .from(connectorCatalogEntries)
      .where(
        and(
          eq(connectorCatalogEntries.hash, args.hash),
          eq(connectorCatalogEntries.slug, connector.slug),
        ),
      );
    if (
      !stored ||
      !connectorCatalogRuntimeProjectionPayload(
        connectorCatalogArtifactConnectorSchema.parse(stored.payload),
      ).equals(connectorCatalogRuntimeProjectionPayload(connector))
    ) {
      throw new Error("Immutable connector catalog entry content conflicts");
    }
  }
  const rows = await args.db
    .select({ slug: connectorCatalogEntries.slug })
    .from(connectorCatalogEntries)
    .where(eq(connectorCatalogEntries.hash, args.hash));
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
}

// The caller owns the transaction, shared with the legacy authority bridge.
// A failed CAS rolls back that bridge too; immutable preparation remains reusable.
export async function activateImmutableCatalog(
  args: {
    readonly db: CatalogActivationDb;
    readonly artifact: ConnectorCatalogArtifact;
    readonly hash: string;
    readonly baselineHash: string | null;
    readonly activatedAt: Date;
    readonly catalogSourceId: string | null;
  },
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted();
  if (args.baselineHash === args.hash) {
    const [current] = await args.db
      .select({ hash: connectorCatalog.hash })
      .from(connectorCatalog)
      .where(
        eq(connectorCatalog.schemaVersion, args.artifact.artifactSchemaVersion),
      )
      .for("update");
    if (current?.hash !== args.hash) {
      throw new ImmutableCatalogActivationConflict();
    }
    return false;
  }
  const { connectors, ...header } = args.artifact;
  const values = {
    schemaVersion: args.artifact.artifactSchemaVersion,
    hash: args.hash,
    activatedAt: args.activatedAt,
    catalogVersion: args.artifact.catalogVersion,
    catalogHeader: { ...header },
    entrySlugs: connectors
      .map((entry) => {
        return entry.slug;
      })
      .sort(),
  };
  const switched =
    args.baselineHash === null
      ? await args.db
          .insert(connectorCatalog)
          .values(values)
          .onConflictDoNothing()
          .returning({ hash: connectorCatalog.hash })
      : await args.db
          .update(connectorCatalog)
          .set(values)
          .where(
            and(
              eq(
                connectorCatalog.schemaVersion,
                args.artifact.artifactSchemaVersion,
              ),
              eq(connectorCatalog.hash, args.baselineHash),
            ),
          )
          .returning({ hash: connectorCatalog.hash });
  if (switched.length !== 1) {
    throw new ImmutableCatalogActivationConflict();
  }
  await args.db.execute(
    args.catalogSourceId === null
      ? invalidateAllPiStableContextsSql(args.activatedAt)
      : invalidatePiStableContextsForCatalogSourceSql(
          args.catalogSourceId,
          args.activatedAt,
        ),
  );
  signal.throwIfAborted();
  return true;
}
