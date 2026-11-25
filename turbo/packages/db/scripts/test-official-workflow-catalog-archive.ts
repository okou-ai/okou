import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { officialWorkflowArchivedSnapshotSchema } from "@okouai/api-contracts/contracts/official-workflow-catalog";

export async function validateOfficialWorkflowCatalogArchive(
  databaseUrl: string,
) {
  const migration = await readFile(
    new URL(
      "../src/migrations/1636_archive_official_workflow_installations.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const client = new Client({ connectionString: databaseUrl });
  const schema = "workflow_archive_" + randomUUID().replaceAll("-", "");
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(`
      CREATE TABLE workflows (id int PRIMARY KEY, official_definition_name text, official_installation_state text);
      CREATE TABLE official_workflow_catalog_releases (id text PRIMARY KEY, payload jsonb NOT NULL);
      CREATE TABLE official_workflow_catalog_state (authority text PRIMARY KEY, accepted_release_id text REFERENCES official_workflow_catalog_releases);
      CREATE TABLE official_workflow_definition_revisions (definition_name text, revision text, payload jsonb, content_bundle jsonb, PRIMARY KEY (definition_name, revision));
      CREATE TABLE official_workflow_reconciliation_work (id int PRIMARY KEY);
      INSERT INTO workflows VALUES (1,'proactive-planning','installed'), (2,'morning-brief','installed'), (3,NULL,NULL);
    `);
    const name = "proactive-planning";
    const revision = "a".repeat(64);
    const contentBundle = { sha256: "c".repeat(64), archiveBytes: 210 };
    const definition = {
      schemaVersion: 2,
      name,
      revision,
      blueprints: [],
      workflow: {
        displayName: "Planning",
        description: "Retired planning workflow",
        instruction: "Read references/plan.md.",
        files: [
          {
            path: "references/plan.md",
            content: "Plan from the original owner's notes.",
          },
        ],
      },
    };
    const snapshot = officialWorkflowArchivedSnapshotSchema.parse({
      lifecycle: "retired",
      revision: { definition, contentBundle },
    });
    await client.query(
      "INSERT INTO official_workflow_catalog_releases VALUES ('last', $1)",
      [
        {
          schemaVersion: 4,
          definitions: [
            { name, revision, lifecycle: "retired", contentBundle },
          ],
        },
      ],
    );
    await client.query(
      "INSERT INTO official_workflow_catalog_state VALUES ('official','last')",
    );
    // Stop before removing an installed owner's only source.
    await assert.rejects(client.query(migration), /no readable snapshot/);
    await client.query(
      "INSERT INTO official_workflow_definition_revisions VALUES ($1,$2,$3,$4)",
      [name, revision, definition, contentBundle],
    );

    const prepare = migration
      .split("--> statement-breakpoint")
      .filter((statement) => {
        return !statement.includes("-- okou:after-api-promotion");
      })
      .join("\n");
    await client.query(prepare);
    const snapshots = async () => {
      return (
        await client.query<{ id: number; snapshot: unknown }>(
          "SELECT id, archived_official_snapshot AS snapshot FROM workflows ORDER BY id",
        )
      ).rows;
    };
    assert.deepEqual(await snapshots(), [
      { id: 1, snapshot },
      { id: 2, snapshot: null },
      { id: 3, snapshot: null },
    ]);
    assert.equal(
      (
        await client.query(
          "SELECT count(*) AS count FROM official_workflow_catalog_state",
        )
      ).rows[0]?.count,
      "1",
    );

    // An outgoing request can still install another owner before the cutover.
    await client.query(
      "INSERT INTO workflows VALUES (4,'proactive-planning','installed')",
    );
    await client.query(migration);
    await client.query(migration);
    assert.deepEqual(await snapshots(), [
      { id: 1, snapshot },
      { id: 2, snapshot: null },
      { id: 3, snapshot: null },
      { id: 4, snapshot },
    ]);
    assert.deepEqual(
      (
        await client.query(
          "SELECT relname FROM pg_class WHERE relnamespace = current_schema()::regnamespace AND relname LIKE 'official_workflow_%'",
        )
      ).rows,
      [],
    );
  } finally {
    try {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await client.end();
    }
  }
}
