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

const execFileAsync = promisify(execFile);
const retainedTables = [
  "storages",
  "storage_versions",
  "storage_version_lineage",
  "run_output_memory_citations",
  "usage_event_hourly_rollup",
  "pi_resource_version_indexes",
  "storage_publication_generations",
  "storage_publication_tokens",
];
const baseline = `
CREATE TABLE blobs (hash text PRIMARY KEY, ref_count integer NOT NULL);
${retainedTables
  .map((table) => {
    return `CREATE TABLE ${table} (id text PRIMARY KEY, content jsonb NOT NULL);
INSERT INTO ${table} VALUES ('native-memory', '{"content":"preserved native memory and billing"}');`;
  })
  .join("\n")}
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
INSERT INTO agent_runs VALUES ('11111111-1111-4111-8111-111111111111', 'completed', (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - interval '3 hours', '{"framework":"pi"}');
INSERT INTO agent_run_callbacks VALUES ('maintenance', '11111111-1111-4111-8111-111111111111', 'delivered', 'pi-memory:phase2', '{}'), ('ordinary', NULL, 'delivered', 'chat', '{}');
INSERT INTO usage_event VALUES ('settled-history', NULL, NULL, 'pi_memory_stage1', (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - interval '1 day', 456);
INSERT INTO user_feature_switches VALUES ('staff', '{"piMemory":true,"otherSwitch":false}'), ('ordinary', '{"otherSwitch":true}');
INSERT INTO pi_memory_stage1_candidates VALUES ('candidate-1', 'shared-history', 'succeeded'), ('candidate-2', 'shared-history', 'succeeded'), ('candidate-3', 'candidate-only', 'pending');
INSERT INTO pi_memory_phase2_jobs VALUES ('dormant-job', 'pending', NULL);
INSERT INTO memory_summary_projections VALUES ('projection', 'ready');
`;

/** Replay normal and already-contracted preview schemas in disposable DBs. */
export async function validatePiMemoryRetirement(
  databaseUrl: string,
): Promise<void> {
  const source = await readFile(
    new URL(
      "../src/migrations/1448_retire_pi_memory_tables.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const directory = await mkdtemp(path.join(tmpdir(), "pi-memory-retirement-"));
  const originalDirectory = process.cwd();
  const admin = postgres(databaseUrl, { max: 1 });
  const migrations = path.join(directory, "src/migrations");
  try {
    await mkdir(path.join(migrations, "meta"), { recursive: true });
    await writeFile(path.join(migrations, "0000_baseline.sql"), baseline);
    await writeFile(path.join(migrations, "0001_retire_pi_memory.sql"), source);
    await writeFile(
      path.join(migrations, "0003_already_contracted.sql"),
      source,
    );
    await writeFile(
      path.join(migrations, "0002_following.sql"),
      "CREATE TABLE following_release (id integer PRIMARY KEY);",
    );
    await writeFile(
      path.join(migrations, "meta/_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: [
          "baseline",
          "retire_pi_memory",
          "following",
          "already_contracted",
        ].map((tag, index) => {
          return {
            idx: index,
            version: "7",
            when: index + 1,
            tag: `${String(index).padStart(4, "0")}_${tag}`,
            breakpoints: true,
          };
        }),
      }),
    );
    process.chdir(directory);
    for (const scenario of [
      "success",
      "extraction-lease",
      "maintenance-lease",
      "maintenance-run",
      "projection-lease",
      "callback",
      "late-usage-window",
      "unsettled-stage1-usage",
      "unsettled-maintenance-usage",
      "blob-undercount",
      "dependent-view",
      "partial-schema",
    ]) {
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
            ...retainedTables,
            "usage_event",
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
          await execFileAsync(
            process.execPath,
            [
              fileURLToPath(
                new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url),
              ),
              fileURLToPath(new URL("./migrate.ts", import.meta.url)),
            ],
            {
              cwd: directory,
              env: { ...process.env, DATABASE_URL: url.toString() },
            },
          );
          assert.equal(await preserved(), original);
          const expectedBlobs = [
            { hash: "candidate-only", ref_count: 0 },
            { hash: "native-only", ref_count: 1 },
            { hash: "shared-history", ref_count: 1 },
          ];
          assert.deepEqual(
            Array.from(
              await sql`SELECT hash, ref_count FROM blobs ORDER BY hash`,
            ),
            expectedBlobs,
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
          await sql`INSERT INTO following_release VALUES (1)`;
          await applyPendingMigrations(sql);
          assert.equal(await preserved(), original);
          assert.deepEqual(
            Array.from(
              await sql`SELECT hash, ref_count FROM blobs ORDER BY hash`,
            ),
            expectedBlobs,
          );
          assert.deepEqual(
            Array.from(await sql`SELECT * FROM following_release`),
            [{ id: 1 }],
          );
          assert.deepEqual(
            Array.from(
              await sql`SELECT created_at::text FROM drizzle.__drizzle_migrations ORDER BY created_at`,
            ),
            ["1", "2", "3", "4"].map((createdAt) => {
              return { created_at: createdAt };
            }),
          );
          continue;
        }
        if (scenario === "extraction-lease")
          await sql`UPDATE pi_memory_stage1_candidates SET status = 'leased'`;
        if (scenario === "maintenance-lease")
          await sql`UPDATE pi_memory_phase2_jobs SET status = 'leased'`;
        if (scenario === "maintenance-run")
          await sql`UPDATE pi_memory_phase2_jobs SET maintenance_run_id = '11111111-1111-4111-8111-111111111111'`;
        if (scenario === "projection-lease")
          await sql`UPDATE memory_summary_projections SET status = 'running'`;
        if (scenario === "callback")
          await sql`UPDATE agent_run_callbacks SET status = 'pending' WHERE id = 'maintenance'`;
        if (scenario === "late-usage-window")
          await sql`UPDATE agent_runs SET completed_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')`;
        if (scenario === "unsettled-stage1-usage")
          await sql`INSERT INTO usage_event VALUES ('unsettled', NULL, NULL, 'pi_memory_stage1', NULL, NULL)`;
        if (scenario === "unsettled-maintenance-usage")
          await sql`INSERT INTO usage_event VALUES ('unsettled', NULL, '11111111-1111-4111-8111-111111111111', 'run', NULL, NULL)`;
        if (scenario === "blob-undercount")
          await sql`UPDATE blobs SET ref_count = 1 WHERE hash = 'shared-history'`;
        if (scenario === "dependent-view")
          await sql`CREATE VIEW candidate_consumer AS SELECT * FROM pi_memory_stage1_candidates`;
        if (scenario === "partial-schema")
          await sql`DROP TABLE pi_memory_publication_provenance`;
        const state = async () => {
          const result = [await preserved()];
          result.push(
            JSON.stringify(
              Array.from(await sql`SELECT * FROM blobs ORDER BY hash`),
            ),
          );
          for (const table of [
            "agent_run_callbacks",
            "user_feature_switches",
            "pi_memory_stage1_candidates",
            "pi_memory_phase2_jobs",
            "memory_summary_projections",
          ]) {
            result.push(
              JSON.stringify(
                Array.from(
                  await sql.unsafe(`SELECT * FROM "${table}" ORDER BY id`),
                ),
              ),
            );
          }
          return JSON.stringify(result);
        };
        const before = await state();
        await assert.rejects(applyPendingMigrations(sql));
        assert.equal(await state(), before);
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
    "Pi memory retirement, native preservation and ordinary migration batching passed",
  );
}
