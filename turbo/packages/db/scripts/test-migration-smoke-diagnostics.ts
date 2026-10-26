import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { array, number, object, string } from "zod";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const databaseName = `migration_diagnostics_${randomUUID().replaceAll("-", "")}`;
const directory = await mkdtemp(
  path.join(tmpdir(), "okou-migration-diagnostics-"),
);
const admin = postgres(databaseUrl, { max: 1, onnotice: () => {} });
const url = new URL(databaseUrl);
url.pathname = `/${databaseName}`;
const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
const sensitiveValue = "diagnostic-private-value";

const eventsSchema = array(
  object({
    event: string(),
    file: string(),
    sqlstate: string().nullable().optional(),
    batch: number().nullable().optional(),
    plan: object({
      executionMs: number(),
      nodes: array(
        object({
          parent: number().nullable(),
          measurements: object({
            "Node Type": string(),
            "Actual Rows": number().optional(),
          }),
        }),
      ),
    }).optional(),
  }),
);

async function run(entry: "migrate.ts" | "migrate-smoke.ts") {
  const child = spawn(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      fileURLToPath(new URL(entry, import.meta.url)),
    ],
    { cwd: directory, env: { ...process.env, DATABASE_URL: url.toString() } },
  );
  child.stdout.resume();
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, 1, stderr);
  assert.match(stderr, /statement timeout/);
  assert.ok(
    !stderr.includes(sensitiveValue),
    "diagnostics must not publish SQL values",
  );
  const events = eventsSchema.parse(
    stderr
      .split("\n")
      .filter((line) => {
        return line.startsWith('{"event":');
      })
      .map((line) => {
        return JSON.parse(line);
      }),
  );
  assert.equal(
    events.find((event) => {
      return event.event === "migration_failed";
    })?.sqlstate,
    "57014",
  );
  assert.ok(
    !events.some((event) => {
      return event.event === "migration_completed";
    }),
  );
  assert.equal(
    (
      await sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`
    )[0]?.count,
    0,
  );
  assert.equal(
    (await sql`SELECT to_regclass('must_not_run') AS relation`)[0]?.relation,
    null,
  );
  return events;
}

try {
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  await mkdir(path.join(directory, "src/migrations/meta"), { recursive: true });
  const journalPath = path.join(directory, "src/migrations/meta/_journal.json");
  await writeFile(
    journalPath,
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: [
        {
          idx: 0,
          version: "7",
          when: 1,
          tag: "0000_diagnostic_probe",
          breakpoints: true,
        },
      ],
    }),
  );
  await sql.unsafe(`CREATE TABLE diagnostic_probe(id uuid PRIMARY KEY,value integer NOT NULL DEFAULT 0,note text NOT NULL);
    INSERT INTO diagnostic_probe(id,note) SELECT ('00000000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid,'diagnostic-private-value' FROM generate_series(1,6)i;`);
  const fixturePath = path.join(
    directory,
    "src/migrations/0000_diagnostic_probe.sql",
  );
  const fixture = `-- okou:non-transactional
SET statement_timeout='20ms';
--> statement-breakpoint
-- okou:batch-by-uuid
-- okou:explain-on-timeout
WITH batch AS MATERIALIZED (
  SELECT id FROM diagnostic_probe WHERE ($1::uuid IS NULL OR id>$1::uuid)
    AND note='diagnostic-private-value' ORDER BY id LIMIT 2
), pause AS MATERIALIZED (
  SELECT pg_sleep(CASE WHEN $1::uuid IS NULL THEN 0 ELSE 0.1 END)
), updated AS (
  UPDATE diagnostic_probe p SET value=p.value+1 FROM batch,pause WHERE p.id=batch.id RETURNING p.id
)
SELECT (SELECT id FROM batch ORDER BY id DESC LIMIT 1) AS next_cursor;
--> statement-breakpoint
CREATE TABLE must_not_run(id integer);`;
  await writeFile(fixturePath, fixture);

  // A marker alone never enables write replay through the production entry.
  const production = await run("migrate.ts");
  assert.ok(
    !production.some((event) => {
      return event.event.startsWith("migration_diagnostic_");
    }),
  );
  assert.deepEqual(
    Array.from(await sql`SELECT value FROM diagnostic_probe ORDER BY id`).map(
      (row) => {
        return row.value;
      },
    ),
    [1, 1, 0, 0, 0, 0],
  );

  // The smoke entry alone does not replay statements without an explicit marker.
  await sql`UPDATE diagnostic_probe SET value=0`;
  await writeFile(
    fixturePath,
    fixture.replace("-- okou:explain-on-timeout\n", ""),
  );
  const unmarked = await run("migrate-smoke.ts");
  assert.ok(
    !unmarked.some((event) => {
      return event.event.startsWith("migration_diagnostic_");
    }),
  );
  assert.deepEqual(
    Array.from(await sql`SELECT value FROM diagnostic_probe ORDER BY id`).map(
      (row) => {
        return row.value;
      },
    ),
    [1, 1, 0, 0, 0, 0],
  );

  // Diagnose only the failed second batch, preserve earlier commits, and stop
  // even when EXPLAIN ANALYZE successfully commits that clone-only replay.
  await sql`UPDATE diagnostic_probe SET value=0`;
  await writeFile(fixturePath, fixture);
  const diagnosed = await run("migrate-smoke.ts");
  const plan = diagnosed.find((event) => {
    return event.event === "migration_diagnostic_plan";
  });
  assert.equal(plan?.batch, 2);
  assert.ok(
    plan?.plan?.nodes.some((node) => {
      return node.measurements["Node Type"] === "ModifyTable";
    }),
  );
  assert.deepEqual(
    Array.from(await sql`SELECT value FROM diagnostic_probe ORDER BY id`).map(
      (row) => {
        return row.value;
      },
    ),
    [1, 1, 1, 1, 0, 0],
  );

  // A secondary diagnostic error must never replace the original timeout.
  await sql`UPDATE diagnostic_probe SET value=0`;
  await sql`CREATE SEQUENCE diagnostic_attempt`;
  const failingDiagnostic = fixture
    .replace(
      `pause AS MATERIALIZED (\n  SELECT pg_sleep(CASE WHEN $1::uuid IS NULL THEN 0 ELSE 0.1 END)\n)`,
      `attempt AS MATERIALIZED (SELECT nextval('diagnostic_attempt') AS n),
pause AS MATERIALIZED (SELECT pg_sleep(CASE WHEN n=1 THEN 0.1 ELSE 0 END) FROM attempt)`,
    )
    .replace(
      "SET value=p.value+1 FROM batch,pause",
      "SET value=p.value+1/(CASE WHEN attempt.n=1 THEN 1 ELSE 0 END) FROM batch,pause,attempt",
    );
  assert.notEqual(failingDiagnostic, fixture);
  await writeFile(fixturePath, failingDiagnostic);
  const diagnosticError = await run("migrate-smoke.ts");
  assert.equal(
    diagnosticError.find((event) => {
      return event.event === "migration_diagnostic_failed";
    })?.sqlstate,
    "22012",
  );
  assert.deepEqual(
    Array.from(await sql`SELECT value FROM diagnostic_probe ORDER BY id`).map(
      (row) => {
        return row.value;
      },
    ),
    [0, 0, 0, 0, 0, 0],
  );
} finally {
  await sql.end();
  await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
  await admin.end();
  await rm(directory, { recursive: true, force: true });
}
console.log(
  "Smoke migration diagnostics: opt-in, failed cursor replay, redaction and original failure preserved",
);
