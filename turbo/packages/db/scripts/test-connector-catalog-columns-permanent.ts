import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq, inArray } from "drizzle-orm";
import { connectorCatalogArtifactSchema } from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import { connectorCatalogEntryColumns } from "@okouai/connectors/connector-catalog/entry-columns";
import { connectorCatalogEntries } from "../src/runtime/connector-catalog";

const requiredColumns = [
  "label",
  "description",
  "category",
  "icon",
  "tags",
  "generation",
  "auth_methods",
  "skill",
  "firewall",
  "permission_summary",
];

// Caller owns the transaction and search_path; usable both after the transition
// migration and against replayed/fresh current schemas, including after DROP.
export async function validateConnectorCatalogColumnContract(client: Client) {
  const raw: unknown = JSON.parse(
    await readFile(
      new URL(
        "../../connectors/src/__tests__/fixtures/published-v4-catalog.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const catalog = connectorCatalogArtifactSchema.parse(raw);
  const nonMcp = catalog.connectors.find((connector) => {
    return connector.mcp === undefined;
  });
  const mcp = catalog.connectors.find((connector) => {
    return connector.mcp !== undefined;
  });
  assert.ok(nonMcp);
  assert.ok(mcp);
  const hash = `column-contract-${randomUUID()}`;
  const expected = [nonMcp, mcp]
    .map((connector) => {
      return {
        hash,
        slug: connector.slug,
        ...connectorCatalogEntryColumns(connector),
      };
    })
    .sort((a, b) => {
      return a.slug.localeCompare(b.slug);
    });
  const db = drizzle(client);
  const inserted = await db
    .insert(connectorCatalogEntries)
    .values(expected)
    .returning();
  assert.deepEqual(inserted, expected);
  const selected = await db
    .select()
    .from(connectorCatalogEntries)
    .where(eq(connectorCatalogEntries.hash, hash))
    .orderBy(connectorCatalogEntries.slug);
  assert.deepEqual(selected, expected);
  // A same-hash retry preserves the immutable preparation receipt.
  const retried = await db
    .insert(connectorCatalogEntries)
    .values(
      expected.map((entry) => {
        return {
          ...entry,
          label: "retry must not replace an existing entry",
          permissionSummary: {
            ...entry.permissionSummary,
            hasDefaultPolicyOverrides:
              !entry.permissionSummary.hasDefaultPolicyOverrides,
          },
        };
      }),
    )
    .onConflictDoNothing()
    .returning();
  assert.deepEqual(retried, []);
  assert.deepEqual(
    await db
      .select()
      .from(connectorCatalogEntries)
      .where(eq(connectorCatalogEntries.hash, hash))
      .orderBy(connectorCatalogEntries.slug),
    expected,
    "same-hash retry must not recompute stored summaries or overwrite projections",
  );

  for (const column of requiredColumns) {
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0376; new non-billing transactions are prohibited.
    await client.query("SAVEPOINT required_column");
    await assert.rejects(
      client.query(
        `UPDATE connector_catalog_entries SET "${column}" = NULL WHERE hash = $1`,
        [hash],
      ),
      (error: unknown) => {
        return (
          error instanceof Error &&
          "code" in error &&
          error.code === "23502" &&
          "column" in error &&
          error.column === column
        );
      },
    );
    await client.query("ROLLBACK TO SAVEPOINT required_column");
    await client.query("RELEASE SAVEPOINT required_column");
  }
  await db
    .delete(connectorCatalogEntries)
    .where(eq(connectorCatalogEntries.hash, hash));
}

export async function validatePermanentConnectorCatalogColumns(
  databaseUrl: string,
) {
  // The migration suite owns an exclusive disposable database. This owner never
  // calls the transitional SAVEPOINT helper above or changes its search_path.
  const client = new Client({ connectionString: databaseUrl });
  const db = drizzle(client);
  const errors: unknown[] = [];
  const observeError = (error: Error) => {
    errors.push(error);
  };
  client.on("error", observeError);
  const hash = `column-contract-${randomUUID()}`;
  const slugs: string[] = [];
  let connected = false;
  let ownsEntries = false;
  try {
    const raw: unknown = JSON.parse(
      await readFile(
        new URL(
          "../../connectors/src/__tests__/fixtures/published-v4-catalog.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const catalog = connectorCatalogArtifactSchema.parse(raw);
    const nonMcp = catalog.connectors.find((connector) => {
      return connector.mcp === undefined;
    });
    const mcp = catalog.connectors.find((connector) => {
      return connector.mcp !== undefined;
    });
    assert.ok(nonMcp);
    assert.ok(mcp);
    const expected = [nonMcp, mcp]
      .map((connector) => {
        return {
          hash,
          slug: connector.slug,
          ...connectorCatalogEntryColumns(connector),
        };
      })
      .sort((a, b) => {
        return a.slug.localeCompare(b.slug);
      });
    slugs.push(
      ...expected.map((entry) => {
        return entry.slug;
      }),
    );
    assert.equal(new Set(slugs).size, 2);

    await client.connect();
    connected = true;
    assert.deepEqual(
      (await client.query("SELECT current_schema() AS schema")).rows,
      [{ schema: "public" }],
      "permanent probes must address the public schema",
    );
    const payload = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'connector_catalog_entries'
         AND column_name = 'payload'`,
    );
    assert.deepEqual(payload.rows, [], "payload is physically retired");
    assert.deepEqual(
      await db
        .select()
        .from(connectorCatalogEntries)
        .where(eq(connectorCatalogEntries.hash, hash)),
      [],
      "a collision grants no right to mutate or clean that generation",
    );
    if (errors.length > 0) throw errors[0];
    // The empty precondition is scoped to this exclusive job database; it is
    // not concurrency arbitration for a shared application database.
    ownsEntries = true;

    const inserted = await db
      .insert(connectorCatalogEntries)
      .values(expected)
      .returning();
    assert.deepEqual(inserted, expected);
    const selected = await db
      .select()
      .from(connectorCatalogEntries)
      .where(eq(connectorCatalogEntries.hash, hash))
      .orderBy(connectorCatalogEntries.slug);
    assert.deepEqual(selected, expected);
    const retried = await db
      .insert(connectorCatalogEntries)
      .values(
        expected.map((entry) => {
          return {
            ...entry,
            label: "retry must not replace an existing entry",
            permissionSummary: {
              ...entry.permissionSummary,
              hasDefaultPolicyOverrides:
                !entry.permissionSummary.hasDefaultPolicyOverrides,
            },
          };
        }),
      )
      .onConflictDoNothing()
      .returning();
    assert.deepEqual(retried, []);
    assert.deepEqual(
      await db
        .select()
        .from(connectorCatalogEntries)
        .where(eq(connectorCatalogEntries.hash, hash))
        .orderBy(connectorCatalogEntries.slug),
      expected,
      "same-hash retry must not recompute stored summaries or overwrite projections",
    );

    for (const column of requiredColumns) {
      // Each UPDATE is one autocommit statement. Keep the native pg error,
      // including its exact column, rather than accepting an ORM wrapper.
      await assert.rejects(
        client.query(
          `UPDATE connector_catalog_entries SET "${column}" = NULL WHERE hash = $1`,
          [hash],
        ),
        (error: unknown) => {
          return (
            error instanceof Error &&
            "code" in error &&
            error.code === "23502" &&
            "column" in error &&
            error.column === column
          );
        },
      );
      // Await the same client's next real query: both rows must survive every
      // failed statement, and the client must remain usable without recovery SQL.
      assert.deepEqual(
        await db
          .select()
          .from(connectorCatalogEntries)
          .where(eq(connectorCatalogEntries.hash, hash))
          .orderBy(connectorCatalogEntries.slug),
        expected,
        `failed ${column} probe preserves both complete projections`,
      );
    }
    if (errors.length > 0) throw errors[0];
  } catch (error: unknown) {
    errors.push(error);
  } finally {
    if (connected && ownsEntries) {
      // No broad hash deletion: these two slugs are the only owned entries.
      try {
        await db
          .delete(connectorCatalogEntries)
          .where(
            and(
              eq(connectorCatalogEntries.hash, hash),
              inArray(connectorCatalogEntries.slug, slugs),
            ),
          );
      } catch (error: unknown) {
        errors.push(error);
      }
      // Observe cleanup separately even when DELETE failed. Never adopt or
      // delete unexpected third-slug rows merely to make this assertion pass.
      try {
        assert.deepEqual(
          await db
            .select()
            .from(connectorCatalogEntries)
            .where(eq(connectorCatalogEntries.hash, hash)),
          [],
          "the owned generation is absent after disposal",
        );
      } catch (error: unknown) {
        errors.push(error);
      }
    }
    try {
      await client.end();
    } catch (error: unknown) {
      errors.push(error);
    }
    client.removeListener("error", observeError);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      "Permanent catalog columns or disposal failed",
      {
        cause: errors[0],
      },
    );
  }
}
