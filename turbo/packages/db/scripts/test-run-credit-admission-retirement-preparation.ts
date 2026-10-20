import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import postgres from "postgres";

import { schema } from "../src/index";
import { agentRuns } from "../src/runtime/agent-run";
import { agentRuns as physicalRuns } from "../src/schema/agent-run";
import { applyFixtureMigrations } from "./fixtures/migrate-with-empty-instructions";

// Keep this transition contract through #40886's physical release and its
// drain/rollback gate. A disposable DROP proves SQL compatibility, not rollout.
const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const adminUrl = new URL(databaseUrl);
adminUrl.pathname = "/postgres";
const databaseName = `run_credit_preparation_${randomUUID().replaceAll("-", "")}`;
const ownedUrl = new URL(adminUrl);
ownedUrl.pathname = `/${databaseName}`;
const admin = new Client({ connectionString: adminUrl.toString() });
const client = new Client({ connectionString: ownedUrl.toString() });
const migrationSql = postgres(ownedUrl.toString(), {
  max: 1,
  onnotice: () => {},
});
const db = drizzle(client, { schema });
let created = false;

async function exerciseRuntime(prompt: string) {
  const [inserted] = await db
    .insert(agentRuns)
    .values({
      userId: "credit-preparation-owner",
      orgId: "credit-preparation-org",
      status: "failed",
      prompt,
    })
    .returning();
  assert.ok(inserted);
  assert.deepEqual(
    await db.select().from(agentRuns).where(eq(agentRuns.id, inserted.id)),
    [inserted],
  );
  const error = `${prompt}: expected terminal result`;
  const [updated] = await db
    .update(agentRuns)
    .set({ error })
    .where(eq(agentRuns.id, inserted.id))
    .returning();
  assert.deepEqual(updated, { ...inserted, error });
  assert.deepEqual(
    await db.query.agentRuns.findFirst({
      where: eq(agentRuns.id, inserted.id),
    }),
    updated,
  );
  return inserted.id;
}

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  await applyFixtureMigrations(migrationSql);
  await client.connect();

  const historical = await db
    .insert(physicalRuns)
    .values(
      [true, false].map((creditAdmitted) => {
        return {
          userId: "credit-preparation-owner",
          orgId: "credit-preparation-org",
          status: "failed",
          prompt: "Retained historical marker",
          creditAdmitted,
        };
      }),
    )
    .returning();
  assert.deepEqual(
    historical.map((run) => {
      return run.creditAdmitted;
    }),
    [true, false],
  );
  const historicalIds = historical.map((run) => {
    return run.id;
  });
  const historyQuery =
    "SELECT to_jsonb(r) AS row FROM agent_runs r WHERE id = ANY($1::uuid[]) ORDER BY id";
  const before = await client.query(historyQuery, [historicalIds]);

  const preparedId = await exerciseRuntime("Retained physical column");
  assert.deepEqual(
    (await client.query(historyQuery, [historicalIds])).rows,
    before.rows,
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT credit_admitted FROM agent_runs WHERE id = $1",
        [preparedId],
      )
    ).rows,
    [{ credit_admitted: false }],
  );
  const surviving = await client.query(
    "SELECT to_jsonb(r) - 'credit_admitted' AS row FROM agent_runs r ORDER BY id",
  );

  // This connection points only to the uniquely owned disposable database.
  await client.query(
    "ALTER TABLE agent_runs DROP COLUMN credit_admitted RESTRICT",
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT to_jsonb(r) AS row FROM agent_runs r ORDER BY id",
      )
    ).rows,
    surviving.rows,
  );
  await exerciseRuntime("Contracted physical column");
  assert.equal((await db.query.agentRuns.findMany()).length, 4);
  console.log(
    "Run credit-admission preparation preserves marker history/defaults and runtime/root-schema SQL across physical retirement.",
  );
} finally {
  try {
    await client.end();
    await migrationSql.end();
    if (created) {
      await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    }
  } finally {
    await admin.end();
  }
}
