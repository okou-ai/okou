import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { expect, onTestFinished, test } from "vitest";

test("entry column migrations preserve payloads and backfill bundled and absent skills", async () => {
  const migrationDirectory = new URL(
    "../../../../packages/db/src/migrations/",
    import.meta.url,
  );
  const db = new PGlite();
  onTestFinished(async () => {
    await db.close();
  });
  await db.exec(`CREATE TABLE connector_catalog_entries (
      hash text NOT NULL, slug text NOT NULL, payload jsonb NOT NULL,
      PRIMARY KEY (hash, slug)
    )`);
  const versionId = "a".repeat(64);
  const entries = [
    {
      slug: "bundled",
      label: "Bundled connector",
      description: "Description",
      category: "productivity",
      authMethods: [{ id: "token" }],
      firewall: { kind: "generated", config: { rules: [] } },
      skill: {
        kind: "bundled",
        storageName: "connector-skill@bundled",
        versionId,
        storageVersionPrefix: `__system__/volume/connector-skill@bundled/${versionId}`,
      },
    },
    {
      slug: "no-skill",
      label: "No skill connector",
      description: "Other description",
      category: "communication",
      authMethods: [{ id: "oauth" }],
      firewall: { kind: "none" },
      skill: { kind: "none" },
      mcp: {
        transport: "streamable-http",
        endpoint: "https://mcp.example.com/mcp",
      },
    },
  ];
  for (const entry of entries) {
    await db.query(
      "INSERT INTO connector_catalog_entries VALUES ('catalog', $1, $2)",
      [entry.slug, JSON.stringify(entry)],
    );
  }
  for (const name of [
    "1325_connector_catalog_entry_columns.sql",
    "1326_backfill_connector_catalog_entry_columns.sql",
    "1327_connector_catalog_mcp_endpoint.sql",
    "1328_backfill_connector_catalog_mcp_endpoint.sql",
  ]) {
    await db.exec(await readFile(new URL(name, migrationDirectory), "utf8"));
  }
  const expected = entries.map((entry) => {
    return {
      hash: "catalog",
      slug: entry.slug,
      payload: entry,
      label: entry.label,
      description: entry.description,
      category: entry.category,
      auth_methods: entry.authMethods,
      firewall: entry.firewall,
      storage_name: entry.skill.storageName ?? null,
      version_id: entry.skill.versionId ?? null,
      mcp_endpoint: entry.mcp?.endpoint ?? null,
    };
  });
  expect(
    (await db.query("SELECT * FROM connector_catalog_entries ORDER BY slug"))
      .rows,
  ).toStrictEqual(expected);
  // Old API/new DB remains writable during the expand-only rollout.
  await db.query(
    "INSERT INTO connector_catalog_entries (hash, slug, payload) VALUES ('old-api', $1, $2)",
    [entries[0]?.slug, JSON.stringify(entries[0])],
  );
  const backfill = await readFile(
    new URL(
      "1326_backfill_connector_catalog_entry_columns.sql",
      migrationDirectory,
    ),
    "utf8",
  );
  await db.exec(backfill);
  await db.exec(backfill);
  expect(
    (
      await db.query(
        "SELECT * FROM connector_catalog_entries WHERE hash = 'old-api'",
      )
    ).rows,
  ).toStrictEqual([{ ...expected[0], hash: "old-api" }]);
});
