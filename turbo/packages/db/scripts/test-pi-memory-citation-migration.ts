import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";
import postgres from "postgres";

import { applyFixtureMigrations } from "./fixtures/migrate-with-empty-instructions";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const database = `migration_pi_citations_${randomUUID().replaceAll("-", "")}`;
const adminUrl = new URL(databaseUrl);
adminUrl.pathname = "/postgres";
const testUrl = new URL(databaseUrl);
testUrl.pathname = `/${database}`;
const admin = new Client({ connectionString: adminUrl.toString() });
await admin.connect();
await admin.query(`CREATE DATABASE "${database}"`);
const client = new Client({ connectionString: testUrl.toString() });
await client.connect();
const migrationSql = postgres(testUrl.toString(), { max: 1 });
const fixtureDirectory = await mkdtemp(
  join(tmpdir(), "pi-citation-migration-"),
);
const migrationDirectory = join(fixtureDirectory, "src/migrations");
const sourceDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../src/migrations",
);
const sourceJournal = JSON.parse(
  await readFile(join(sourceDirectory, "meta/_journal.json"), "utf8"),
) as { entries: { idx: number; tag: string; when: number }[] };
const citationMigration = sourceJournal.entries.find((entry) => {
  return entry.tag === "1081_nasty_cloak";
});
assert.ok(
  citationMigration,
  "Pi citation migration is missing from the journal",
);
const legacyBufferMigration = sourceJournal.entries.find((entry) => {
  return entry.tag === "1083_fuzzy_dragon_lord";
});
assert.ok(
  legacyBufferMigration,
  "Legacy Pi request buffer migration is missing from the journal",
);
const oldEntry = {
  idx: 0,
  version: "7",
  when: 1,
  tag: "0000_pi_citation_old_reader",
  breakpoints: true,
};
const citationEntry = {
  ...citationMigration,
  version: "7",
  breakpoints: true,
};
const legacyBufferEntry = {
  ...legacyBufferMigration,
  version: "7",
  breakpoints: true,
};
const originalDirectory = process.cwd();

async function writeJournal(entries: readonly unknown[]): Promise<void> {
  await writeFile(
    join(migrationDirectory, "meta/_journal.json"),
    JSON.stringify({ version: "7", dialect: "postgresql", entries }),
  );
}

try {
  await mkdir(join(migrationDirectory, "meta"), { recursive: true });
  await writeFile(
    join(migrationDirectory, `${oldEntry.tag}.sql`),
    `CREATE TABLE agent_runs (id uuid PRIMARY KEY);
--> statement-breakpoint
CREATE TABLE chat_output_materializations (
  run_id uuid PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  latest_result_text text,
  latest_output_text text
);`,
  );
  await copyFile(
    join(sourceDirectory, `${citationMigration.tag}.sql`),
    join(migrationDirectory, `${citationMigration.tag}.sql`),
  );
  await copyFile(
    join(sourceDirectory, `${legacyBufferMigration.tag}.sql`),
    join(migrationDirectory, `${legacyBufferMigration.tag}.sql`),
  );
  await writeJournal([oldEntry]);
  process.chdir(fixtureDirectory);
  await applyFixtureMigrations(migrationSql);

  const runId = randomUUID();
  await client.query("INSERT INTO agent_runs (id) VALUES ($1)", [runId]);
  await client.query(
    "INSERT INTO chat_output_materializations (run_id, latest_output_text) VALUES ($1, 'old writer')",
    [runId],
  );

  await writeJournal([oldEntry, citationEntry]);
  await applyFixtureMigrations(migrationSql);
  await client.query(
    "UPDATE chat_output_materializations SET latest_output_text = 'old writer after migration' WHERE run_id = $1",
    [runId],
  );
  await client.query(
    `INSERT INTO run_output_memory_citations (run_id, sequence_number, citation)
     VALUES ($1, 7, $2::jsonb)
     ON CONFLICT DO NOTHING`,
    [
      runId,
      JSON.stringify({
        entries: [
          { path: "memory.md", lineStart: 1, lineEnd: 2, note: "used" },
        ],
        rolloutIds: [],
      }),
    ],
  );
  await writeJournal([oldEntry, citationEntry, legacyBufferEntry]);
  await applyFixtureMigrations(migrationSql);
  await client.query(
    "UPDATE chat_output_materializations SET latest_output_text = 'old writer after buffer migration' WHERE run_id = $1",
    [runId],
  );
  const stagedEvent = JSON.stringify({
    type: "assistant",
    sequenceNumber: 8,
    message: { content: [{ type: "text", text: "private pending" }] },
  });
  await client.query(
    `INSERT INTO run_output_legacy_pi_events (run_id, sequence_number, serialized_event)
     VALUES ($1, 8, $2)
     ON CONFLICT DO NOTHING`,
    [runId, stagedEvent],
  );
  await client.query(
    `INSERT INTO run_output_legacy_pi_events (run_id, sequence_number, serialized_event)
     VALUES ($1, 8, $2)
     ON CONFLICT DO NOTHING`,
    [runId, stagedEvent],
  );
  const result = await client.query(
    `SELECT m.latest_output_text, c.sequence_number, c.citation,
            p.sequence_number AS pending_sequence_number,
            p.serialized_event
     FROM chat_output_materializations m
     JOIN run_output_memory_citations c ON c.run_id = m.run_id
     JOIN run_output_legacy_pi_events p ON p.run_id = m.run_id
     WHERE m.run_id = $1`,
    [runId],
  );
  assert.deepEqual(result.rows, [
    {
      latest_output_text: "old writer after buffer migration",
      sequence_number: 7,
      citation: {
        entries: [
          { path: "memory.md", lineStart: 1, lineEnd: 2, note: "used" },
        ],
        rolloutIds: [],
      },
      pending_sequence_number: 8,
      serialized_event: stagedEvent,
    },
  ]);
  await client.query(
    "DELETE FROM run_output_legacy_pi_events WHERE run_id = $1 AND sequence_number = 8",
    [runId],
  );
  assert.equal(
    (
      await client.query(
        "SELECT count(*)::int AS count FROM run_output_legacy_pi_events WHERE run_id = $1",
        [runId],
      )
    ).rows[0]?.count,
    0,
  );
  console.log(
    "Pi citation migrations preserve old writers and add replay-safe transient buffering.",
  );
} finally {
  process.chdir(originalDirectory);
  await migrationSql.end();
  await rm(fixtureDirectory, { recursive: true, force: true });
  await client.end();
  await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
  await admin.end();
}
