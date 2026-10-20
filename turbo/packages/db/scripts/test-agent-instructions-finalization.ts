import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import postgres from "postgres";
import { z } from "zod";
import { applyPendingMigrations } from "./migration-runner";
import { validatePermanentAgentInstructions } from "./test-agent-instructions-permanent";

assert.ok(
  process.env.DATABASE_URL,
  "DATABASE_URL is required (disposable PostgreSQL only)",
);
const journal = z
  .object({ entries: z.array(z.object({ tag: z.string(), when: z.number() })) })
  .parse(
    JSON.parse(
      readFileSync(
        new URL("../src/migrations/meta/_journal.json", import.meta.url),
        "utf8",
      ),
    ),
  );
const finalization = journal.entries.find((entry) => {
  return entry.tag.endsWith("_finalize_agent_instructions");
});
assert.ok(finalization);
const admin = new Client({ connectionString: process.env.DATABASE_URL });
await admin.connect();
const name = `instruction_finalization_${randomUUID().replaceAll("-", "")}`;
await admin.query(`CREATE DATABASE "${name}"`);
const url = new URL(process.env.DATABASE_URL);
url.pathname = `/${name}`;
const migrations = postgres(url.toString(), { max: 1, onnotice: () => {} });
const client = new Client({ connectionString: url.toString() });
try {
  await client.connect();
  await applyPendingMigrations(migrations, { beforeMillis: finalization.when });
  const missing = randomUUID();
  const authored = randomUUID();
  const body = "\uFEFF  preserved instructions\r\n中文\n";
  await client.query(
    `INSERT INTO agents (id, org_id, owner, name, instructions) VALUES
    ($1, 'instruction-org', 'instruction-owner', 'missing', NULL),
    ($2, 'instruction-org', 'instruction-owner', 'authored', $3)`,
    [missing, authored, body],
  );
  await assert.rejects(applyPendingMigrations(migrations), { code: "23502" });
  assert.deepEqual(
    (
      await client.query("SELECT instructions FROM agents WHERE id=$1", [
        missing,
      ])
    ).rows,
    [{ instructions: null }],
  );
  assert.deepEqual(
    (
      await client.query("SELECT instructions FROM agents WHERE id=$1", [
        authored,
      ])
    ).rows,
    [{ instructions: body }],
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations WHERE created_at=$1",
        [finalization.when],
      )
    ).rows,
    [{ count: 0 }],
  );
  // This exact fixture represents an accepted empty repair, independently of SQL promotion.
  await client.query(
    "UPDATE agents SET instructions='' WHERE id=$1 AND instructions IS NULL",
    [missing],
  );
  await applyPendingMigrations(migrations);
  assert.deepEqual(
    (
      await client.query("SELECT instructions FROM agents WHERE id=$1", [
        authored,
      ])
    ).rows,
    [{ instructions: body }],
  );
  // The outgoing DB writer remains legal after the constraint is installed.
  await client.query("UPDATE agents SET instructions=$2 WHERE id=$1", [
    missing,
    body,
  ]);
  await validatePermanentAgentInstructions(url.toString());
  console.log(
    "Agent instruction finalization preserves content and rejects unmigrated NULLs.",
  );
} finally {
  await client.end();
  await migrations.end();
  await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end();
}
