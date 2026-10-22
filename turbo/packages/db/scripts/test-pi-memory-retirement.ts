import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import postgres from "postgres";
import { applyPendingMigrations } from "./migration-runner";

const contraction = "0001_retire_pi_memory.sql";
const execFileAsync = promisify(execFile);
const baseline = `
CREATE TABLE blobs (hash text PRIMARY KEY, ref_count integer NOT NULL);
CREATE TABLE storages (id text PRIMARY KEY, content jsonb NOT NULL);
CREATE TABLE storage_versions (id text PRIMARY KEY, content jsonb NOT NULL);
CREATE TABLE storage_version_lineage (id text PRIMARY KEY, content jsonb NOT NULL);
CREATE TABLE run_output_memory_citations (id text PRIMARY KEY, content jsonb NOT NULL);
CREATE TABLE usage_event_hourly_rollup (id text PRIMARY KEY, credits_charged bigint NOT NULL);
CREATE TABLE agent_runs (id uuid PRIMARY KEY, status text NOT NULL, completed_at timestamp, result jsonb);
CREATE TABLE agent_run_callbacks (id text PRIMARY KEY, run_id uuid REFERENCES agent_runs, status text, internal_kind text, payload jsonb);
CREATE INDEX idx_agent_run_callbacks_pi_memory ON agent_run_callbacks (run_id) WHERE internal_kind = 'pi-memory:phase2';
CREATE TABLE usage_event (id text PRIMARY KEY, run_id uuid, billing_run_id uuid, billing_context text, processed_at timestamp, credits_charged bigint);
CREATE TABLE user_feature_switches (id text PRIMARY KEY, switches jsonb NOT NULL);
CREATE TABLE pi_memory_stage1_candidates (id text PRIMARY KEY, source_history_hash text REFERENCES blobs, status text);
CREATE TABLE pi_memory_phase2_jobs (id text PRIMARY KEY, status text, maintenance_run_id uuid);
CREATE TABLE memory_summary_projections (id text PRIMARY KEY, status text);
CREATE TABLE pi_memory_publication_provenance (id text PRIMARY KEY);
CREATE TABLE pi_memory_stage1_days (id text PRIMARY KEY);
CREATE TABLE pi_memory_stage1_selections (id text REFERENCES pi_memory_stage1_days);
CREATE TABLE pi_memory_stage1_watermarks (id text PRIMARY KEY);
INSERT INTO blobs VALUES ('shared-history', 3), ('candidate-only', 1), ('native-only', 1);
INSERT INTO storages VALUES ('native-memory', '{"head":"native-version","files":["MEMORY.md"]}');
INSERT INTO storage_versions VALUES ('native-version', '{"content":"native memory"}');
INSERT INTO storage_version_lineage VALUES ('native-lineage', '{"parent":"previous-version"}');
INSERT INTO run_output_memory_citations VALUES ('native-citation', '{"source":"MEMORY.md"}');
INSERT INTO usage_event_hourly_rollup VALUES ('historical-stage1-cost', 123);
INSERT INTO agent_runs VALUES ('11111111-1111-4111-8111-111111111111', 'completed', (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - interval '3 hours', '{"framework":"pi"}');
INSERT INTO agent_run_callbacks VALUES ('maintenance', '11111111-1111-4111-8111-111111111111', 'delivered', 'pi-memory:phase2', '{}'), ('ordinary', NULL, 'delivered', 'chat', '{}');
INSERT INTO usage_event VALUES ('settled-history', NULL, NULL, 'pi_memory_stage1', (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - interval '1 day', 456);
INSERT INTO user_feature_switches VALUES ('staff', '{"piMemory":true,"otherSwitch":false}'), ('ordinary', '{"otherSwitch":true}');
INSERT INTO pi_memory_stage1_candidates VALUES ('candidate-1', 'shared-history', 'succeeded'), ('candidate-2', 'shared-history', 'succeeded'), ('candidate-3', 'candidate-only', 'pending');
INSERT INTO pi_memory_phase2_jobs VALUES ('dormant-job', 'pending', NULL);
INSERT INTO memory_summary_projections VALUES ('projection', 'ready');
`;

/** Exercise the real migration and migrator only in owned disposable databases. */
export async function validatePiMemoryRetirement(
  databaseUrl: string,
): Promise<void> {
  const source = await readFile(
    new URL("../src/migrations/1444_retire_pi_memory.sql", import.meta.url),
    "utf8",
  );
  const directory = await mkdtemp(path.join(tmpdir(), "pi-memory-retirement-"));
  const originalDirectory = process.cwd();
  const admin = postgres(databaseUrl, { max: 1 });
  const entries = [
    { idx: 0, version: "7", when: 1, tag: "0000_baseline", breakpoints: true },
    {
      idx: 1,
      version: "7",
      when: 2,
      tag: "0001_retire_pi_memory",
      breakpoints: true,
    },
  ];
  const migrations = path.join(directory, "src/migrations");
  const writeJournal = async (following: boolean) => {
    await writeFile(
      path.join(migrations, "meta/_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: following
          ? [
              ...entries,
              {
                idx: 2,
                version: "7",
                when: 3,
                tag: "0002_following",
                breakpoints: true,
              },
            ]
          : entries,
      }),
    );
  };
  try {
    await mkdir(path.join(migrations, "meta"), { recursive: true });
    await writeFile(path.join(migrations, "0000_baseline.sql"), baseline);
    await writeFile(path.join(migrations, contraction), source);
    await writeFile(
      path.join(migrations, "0002_following.sql"),
      "CREATE TABLE following_release (id integer PRIMARY KEY);",
    );
    process.chdir(directory);
    for (const scenario of [
      "success",
      "lease",
      "callback",
      "late-usage-window",
      "unsettled-usage",
      "blob-undercount",
      "dependent-view",
      "following-migration",
    ]) {
      await writeJournal(false);
      const name = `pi_memory_retirement_${randomUUID().replaceAll("-", "")}`;
      await admin.unsafe(`CREATE DATABASE "${name}"`);
      const url = new URL(databaseUrl);
      url.pathname = `/${name}`;
      const sql = postgres(url.toString(), { max: 1 });
      try {
        await applyPendingMigrations(sql, { beforeMillis: 2 });
        const preserved = async () => {
          const result = [];
          for (const table of [
            "storages",
            "storage_versions",
            "storage_version_lineage",
            "run_output_memory_citations",
            "usage_event",
            "usage_event_hourly_rollup",
            "agent_runs",
          ]) {
            result.push(
              Array.from(
                await sql.unsafe(`SELECT * FROM "${table}" ORDER BY id`),
              ),
            );
          }
          return JSON.stringify(result);
        };
        const original = await preserved();
        if (scenario === "success") {
          assert.deepEqual(
            await applyPendingMigrations(sql, { deferMigration: contraction }),
            { deferredMigration: contraction },
          );
          const resultFile = path.join(directory, "migration-result.json");
          await execFileAsync(
            process.execPath,
            [
              fileURLToPath(
                new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url),
              ),
              fileURLToPath(new URL("./migrate.ts", import.meta.url)),
              "--defer",
              contraction,
              "--result-file",
              resultFile,
            ],
            {
              cwd: directory,
              env: { ...process.env, DATABASE_URL: url.toString() },
            },
          );
          assert.deepEqual(JSON.parse(await readFile(resultFile, "utf8")), {
            deferredMigration: contraction,
          });
          assert.equal(await preserved(), original);
          assert.deepEqual(
            Array.from(
              await sql`SELECT ref_count FROM blobs WHERE hash = 'shared-history'`,
            ),
            [{ ref_count: 3 }],
          );
          await applyPendingMigrations(sql);
          assert.equal(await preserved(), original);
          assert.deepEqual(
            Array.from(
              await sql`SELECT hash, ref_count FROM blobs ORDER BY hash`,
            ),
            [
              { hash: "candidate-only", ref_count: 0 },
              { hash: "native-only", ref_count: 1 },
              { hash: "shared-history", ref_count: 1 },
            ],
          );
          assert.deepEqual(
            Array.from(
              await sql`SELECT id FROM agent_run_callbacks ORDER BY id`,
            ),
            [{ id: "ordinary" }],
          );
          assert.deepEqual(
            Array.from(
              await sql`SELECT switches FROM user_feature_switches WHERE id = 'staff'`,
            ),
            [{ switches: { otherSwitch: false } }],
          );
          await writeJournal(true);
          assert.deepEqual(
            await applyPendingMigrations(sql, { deferMigration: contraction }),
            { deferredMigration: null },
          );
          await sql`INSERT INTO following_release VALUES (1)`;
          assert.deepEqual(
            Array.from(await sql`SELECT * FROM following_release`),
            [{ id: 1 }],
          );
          continue;
        }
        if (scenario === "lease")
          await sql`UPDATE pi_memory_phase2_jobs SET status = 'leased'`;
        if (scenario === "callback")
          await sql`UPDATE agent_run_callbacks SET status = 'pending' WHERE id = 'maintenance'`;
        if (scenario === "late-usage-window")
          await sql`UPDATE agent_runs SET completed_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')`;
        if (scenario === "unsettled-usage")
          await sql`INSERT INTO usage_event VALUES ('unsettled', '11111111-1111-4111-8111-111111111111', NULL, 'run', NULL, NULL)`;
        if (scenario === "blob-undercount")
          await sql`UPDATE blobs SET ref_count = 1 WHERE hash = 'shared-history'`;
        if (scenario === "dependent-view")
          await sql`CREATE VIEW candidate_consumer AS SELECT * FROM pi_memory_stage1_candidates`;
        if (scenario === "following-migration") await writeJournal(true);
        const before = JSON.stringify([
          Array.from(await sql`SELECT * FROM blobs ORDER BY hash`),
          Array.from(await sql`SELECT * FROM agent_run_callbacks ORDER BY id`),
          Array.from(
            await sql`SELECT * FROM user_feature_switches ORDER BY id`,
          ),
          Array.from(
            await sql`SELECT * FROM pi_memory_stage1_candidates ORDER BY id`,
          ),
        ]);
        await assert.rejects(
          applyPendingMigrations(
            sql,
            scenario === "following-migration"
              ? { deferMigration: contraction }
              : {},
          ),
        );
        assert.equal(
          JSON.stringify([
            Array.from(await sql`SELECT * FROM blobs ORDER BY hash`),
            Array.from(
              await sql`SELECT * FROM agent_run_callbacks ORDER BY id`,
            ),
            Array.from(
              await sql`SELECT * FROM user_feature_switches ORDER BY id`,
            ),
            Array.from(
              await sql`SELECT * FROM pi_memory_stage1_candidates ORDER BY id`,
            ),
          ]),
          before,
        );
        assert.deepEqual(
          Array.from(
            await sql`SELECT created_at::text FROM drizzle.__drizzle_migrations ORDER BY created_at`,
          ),
          [{ created_at: "1" }],
        );
      } finally {
        await sql.end();
        await admin.unsafe(`DROP DATABASE "${name}"`);
      }
    }
  } finally {
    process.chdir(originalDirectory);
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  await validatePiMemoryRetirement(process.env.DATABASE_URL);
  console.log(
    "Pi memory retirement migration and deferred publication checks passed",
  );
}
