import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import postgres from "postgres";
import { z } from "zod";

import { DRIZZLE_MIGRATE_OUT } from "../drizzle.config";
import { schema } from "../src/index";
import { agentRuns } from "../src/runtime/agent-run";
import { applyPendingMigrations } from "./migration-runner";

// Keep this transition contract through #40886's physical release and its
// drain/rollback gate. A disposable DROP proves SQL compatibility, not rollout.
const journal = z
  .object({ entries: z.array(z.object({ tag: z.string(), when: z.number() })) })
  .parse(
    JSON.parse(
      await readFile(`${DRIZZLE_MIGRATE_OUT}/meta/_journal.json`, "utf8"),
    ),
  );
const contraction = journal.entries.find((entry) => {
  return entry.tag.endsWith("_drop_run_credit_admission");
});
assert.ok(
  contraction,
  "Retain the actual contraction through release acceptance",
);
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
const auditSql = await readFile(
  "./scripts/audit-run-credit-admission-retirement.sql",
  "utf8",
);

async function readAudit() {
  const results = z
    .array(z.object({ rows: z.array(z.record(z.string(), z.unknown())) }))
    .parse(await client.query(auditSql));
  return results.flatMap((result) => {
    return result.rows;
  });
}

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
  await applyPendingMigrations(migrationSql, {
    beforeMillis: contraction.when,
  });
  await client.connect();

  // Historical inputs belong to this transition, not the current ORM schema.
  const historical = z
    .array(z.object({ id: z.uuid(), credit_admitted: z.boolean() }))
    .parse(
      (
        await client.query(
          `INSERT INTO agent_runs (user_id, org_id, status, prompt, credit_admitted)
           VALUES ('credit-preparation-owner', 'credit-preparation-org', 'failed', 'Retained historical marker', true),
                  ('credit-preparation-owner', 'credit-preparation-org', 'failed', 'Retained historical marker', false)
           RETURNING id, credit_admitted`,
        )
      ).rows,
    );
  assert.deepEqual(
    historical.map((run) => {
      return run.credit_admitted;
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
  const beforeContraction = await client.query(
    "SELECT to_jsonb(r) AS row FROM agent_runs r ORDER BY id",
  );
  const journalQuery = "SELECT * FROM drizzle.__drizzle_migrations ORDER BY id";
  const journalBefore = await client.query(journalQuery);
  assert.deepEqual(await readAudit(), [
    {
      column_name: "credit_admitted",
      column_type: "boolean",
      not_null: true,
      default_value: "false",
    },
  ]);

  for (const dependency of [
    {
      create: "CREATE INDEX run_credit_index ON agent_runs (credit_admitted)",
      drop: "DROP INDEX run_credit_index",
    },
    {
      create:
        "ALTER TABLE agent_runs ADD CONSTRAINT run_credit_check CHECK (credit_admitted IS NOT NULL)",
      drop: "ALTER TABLE agent_runs DROP CONSTRAINT run_credit_check",
    },
    {
      create:
        "CREATE VIEW run_credit_view AS SELECT credit_admitted FROM agent_runs",
      drop: "DROP VIEW run_credit_view",
    },
    {
      create:
        "CREATE FUNCTION run_credit_routine() RETURNS boolean LANGUAGE sql AS $$ SELECT credit_admitted FROM agent_runs LIMIT 1 $$",
      drop: "DROP FUNCTION run_credit_routine()",
    },
    {
      create:
        "CREATE FUNCTION run_credit_parsed_routine() RETURNS boolean LANGUAGE sql RETURN (SELECT credit_admitted FROM agent_runs LIMIT 1)",
      drop: "DROP FUNCTION run_credit_parsed_routine()",
    },
    {
      create:
        "CREATE VIEW run_credit_whole_row_view AS SELECT agent_runs AS run FROM agent_runs",
      drop: "DROP VIEW run_credit_whole_row_view",
    },
    {
      create:
        "CREATE FUNCTION run_credit_row_type(run agent_runs) RETURNS text LANGUAGE sql AS $$ SELECT run.prompt $$",
      drop: "DROP FUNCTION run_credit_row_type(agent_runs)",
    },
    {
      create:
        "CREATE TABLE run_credit_row_storage AS SELECT agent_runs AS run FROM agent_runs",
      drop: "DROP TABLE run_credit_row_storage",
    },
    {
      create:
        "CREATE TABLE run_credit_array_storage AS SELECT ARRAY[agent_runs] AS runs FROM agent_runs",
      drop: "DROP TABLE run_credit_array_storage",
    },
    {
      create:
        "CREATE FUNCTION run_credit_array_type(runs agent_runs[]) RETURNS text LANGUAGE sql AS $$ SELECT (runs[1]).prompt $$",
      drop: "DROP FUNCTION run_credit_array_type(agent_runs[])",
    },
    {
      create: "CREATE DOMAIN run_credit_row_domain AS agent_runs",
      drop: "DROP DOMAIN run_credit_row_domain",
    },
    {
      create:
        "ALTER TABLE agent_runs ALTER COLUMN credit_admitted SET DEFAULT true",
      drop: "ALTER TABLE agent_runs ALTER COLUMN credit_admitted SET DEFAULT false",
    },
    {
      create:
        "CREATE FUNCTION run_credit_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$; CREATE TRIGGER run_credit_trigger BEFORE UPDATE ON agent_runs FOR EACH ROW EXECUTE FUNCTION run_credit_trigger()",
      drop: "DROP TRIGGER run_credit_trigger ON agent_runs; DROP FUNCTION run_credit_trigger()",
    },
    {
      create: "CREATE TABLE run_credit_child () INHERITS (agent_runs)",
      drop: "DROP TABLE run_credit_child",
    },
  ]) {
    await client.query(dependency.create);
    try {
      assert.ok(
        (await readAudit()).some((row) => {
          return typeof row.unexpected_dependency === "string";
        }),
        "Read-only preflight must report the unexpected consumer",
      );
      await assert.rejects(
        applyPendingMigrations(migrationSql, {
          beforeMillis: contraction.when + 1,
        }),
        (error: unknown) => {
          return (
            error instanceof Error &&
            "code" in error &&
            error.code === "2BP01" &&
            error.message.includes(
              "Unexpected Run credit-admission dependencies",
            )
          );
        },
      );
      assert.deepEqual(
        (await client.query(journalQuery)).rows,
        journalBefore.rows,
        "Rejected contraction must not advance the journal",
      );
      assert.deepEqual(
        (
          await client.query(
            "SELECT to_jsonb(r) AS row FROM agent_runs r ORDER BY id",
          )
        ).rows,
        beforeContraction.rows,
        "Rejected contraction must preserve every Run field",
      );
    } finally {
      await client.query(dependency.drop);
    }
  }

  await applyPendingMigrations(migrationSql, {
    beforeMillis: contraction.when + 1,
  });
  assert.deepEqual(
    (
      await client.query(
        "SELECT to_jsonb(r) AS row FROM agent_runs r ORDER BY id",
      )
    ).rows,
    surviving.rows,
  );
  const journalAfter = await client.query(journalQuery);
  await applyPendingMigrations(migrationSql, {
    beforeMillis: contraction.when + 1,
  });
  assert.deepEqual((await client.query(journalQuery)).rows, journalAfter.rows);
  assert.deepEqual(
    (
      await client.query(
        "SELECT to_jsonb(r) AS row FROM agent_runs r ORDER BY id",
      )
    ).rows,
    surviving.rows,
    "Migrator replay must preserve all surviving Run fields",
  );
  await exerciseRuntime("Contracted physical column");
  assert.equal((await db.query.agentRuns.findMany()).length, 4);
  console.log(
    "Run credit-admission contraction preserves Runs/runtime SQL, rejects unexpected consumers without journal advancement, and replays without effects.",
  );
} finally {
  try {
    await client.end();
  } finally {
    try {
      await migrationSql.end();
    } finally {
      try {
        if (created) {
          await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
        }
      } finally {
        await admin.end();
      }
    }
  }
}
