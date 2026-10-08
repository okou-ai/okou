import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
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
    .values(expected)
    .onConflictDoNothing()
    .returning();
  assert.deepEqual(retried, []);

  for (const column of requiredColumns) {
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
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    await validateConnectorCatalogColumnContract(client);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
}
