import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import postgres from "postgres";
import { test } from "node:test";
import { z } from "zod";
import { applyPendingMigrations } from "../../migration-runner";

const adminUrl = new URL(
  process.env.DATABASE_URL ?? "postgresql://localhost/postgres",
);
assert.ok(
  ["localhost", "127.0.0.1", "db", "postgres"].includes(adminUrl.hostname),
  "Cleanup tests require a local disposable PostgreSQL cluster",
);
adminUrl.pathname = "/postgres";
const databaseName = `instruction_cleanup_${randomUUID().replaceAll("-", "")}`;
const ownedUrl = new URL(adminUrl);
ownedUrl.pathname = `/${databaseName}`;
const admin = new Client({ connectionString: adminUrl.toString() });
const client = new Client({ connectionString: ownedUrl.toString() });
const migrations = postgres(ownedUrl.toString(), {
  max: 1,
  onnotice: () => {},
});
const script = fileURLToPath(new URL("./cleanup.ts", import.meta.url));
let directory: string;

await test("retires reviewed instruction Storage through the native CLI", async (suite) => {
  suite.before(async () => {
    directory = await mkdtemp(join(tmpdir(), "instruction-cleanup-test-"));
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    await applyPendingMigrations(migrations);
    await client.connect();
  });
  suite.beforeEach(async () => {
    await client.query(
      "TRUNCATE agents, agent_runs, storages, background_jobs, export_jobs, storage_publication_tokens, storage_publication_generations CASCADE",
    );
  });
  suite.after(async () => {
    await client.end();
    await migrations.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function invoke(args: readonly string[] = []) {
    return await new Promise<{ code: number; stdout: string; stderr: string }>(
      (resolve) => {
        execFile(
          process.execPath,
          ["--import", "tsx", script, ...args],
          {
            env: {
              ...process.env,
              DATABASE_URL: ownedUrl.toString(),
              R2_USER_STORAGES_BUCKET_NAME: "cleanup-test",
            },
            maxBuffer: 2 * 1024 * 1024,
          },
          (error, stdout, stderr) => {
            return resolve({
              code: error
                ? typeof error.code === "number"
                  ? error.code
                  : 1
                : 0,
              stdout,
              stderr,
            });
          },
        );
      },
    );
  }
  async function storage(
    name = "agent-instructions@test",
    userId = "__org__",
    prefix?: string,
  ) {
    const id = randomUUID();
    const orgId = `org-${randomUUID()}`;
    const capturedPrefix = prefix ?? `${orgId}/${id}`;
    await client.query(
      "INSERT INTO storages (id, org_id, user_id, name, s3_prefix) VALUES ($1, $2, $3, $4, $5)",
      [id, orgId, userId, name, capturedPrefix],
    );
    const version = await addVersion(id, capturedPrefix);
    await client.query("UPDATE storages SET head_version_id=$2 WHERE id=$1", [
      id,
      version.id,
    ]);
    return { id, orgId, prefix: capturedPrefix, version: version.id };
  }
  async function addVersion(storageId: string, prefix: string) {
    const id = randomUUID().replaceAll("-", "").repeat(2);
    const key = `${prefix}/${id}`;
    await client.query(
      `INSERT INTO storage_versions (id, storage_id, s3_key, archive_size, created_by)
      VALUES ($1, $2, $3, 32, 'test-owner')`,
      [id, storageId, key],
    );
    return { id, key };
  }
  async function preview() {
    const result = await invoke();
    assert.strictEqual(result.code, 0, result.stderr);
    const manifest = z
      .object({
        format: z.literal(2),
        storages: z.array(
          z.object({
            id: z.uuid(),
            versions: z.array(z.object({ id: z.string(), key: z.string() })),
          }),
        ),
        tokens: z.array(z.unknown()),
      })
      .parse(JSON.parse(result.stdout));
    const path = join(directory, `${randomUUID()}.json`);
    await writeFile(path, result.stdout, { mode: 0o600 });
    return { manifest, path };
  }
  async function apply(path: string) {
    return await invoke([
      "--manifest",
      path,
      "--migrate",
      "--ack-consumer-retirement",
    ]);
  }

  await suite.test(
    "previews only org-owned instruction identities without mutating data",
    async () => {
      const target = await storage();
      await storage("agent-skills@example");
      await storage("agent-instructions@user-data", "ordinary-user");
      const { manifest } = await preview();
      assert.deepStrictEqual(
        manifest.storages.map((row) => {
          return row.id;
        }),
        [target.id],
      );
      assert.deepStrictEqual(
        (await client.query("SELECT count(*)::int AS count FROM storages"))
          .rows,
        [{ count: 3 }],
      );
      assert.deepStrictEqual(
        (await client.query("SELECT id FROM background_jobs")).rows,
        [],
      );
      assert.notStrictEqual((await invoke(["--migrate"])).code, 0);
    },
  );

  await suite.test(
    "atomically retires captured Storage and queues recoverable cleanup while preserving current instructions and shared fences",
    async () => {
      const target = await storage();
      const retained = await storage("agent-skills@retained");
      const agentId = randomUUID();
      const body = "\uFEFF  current database instructions\r\n中文\n";
      await client.query(
        "INSERT INTO agents (id, org_id, owner, name, instructions) VALUES ($1, $2, 'test-owner', 'test', $3)",
        [agentId, target.orgId, body],
      );
      await client.query(
        "INSERT INTO storage_publication_generations (org_id, agent_id, subject) VALUES ($1, $2, '@agent')",
        [target.orgId, agentId],
      );
      for (const key of ["agent-instructions", "workflow:retained"]) {
        await client.query(
          `INSERT INTO storage_publication_tokens (org_id, agent_id, subject, publication_key, generation, token)
        VALUES ($1, $2, '@agent', $3, 1, $4)`,
          [target.orgId, agentId, key, randomUUID()],
        );
      }
      const { path } = await preview();
      const result = await apply(path);
      assert.strictEqual(result.code, 0, result.stderr);
      assert.deepStrictEqual(
        (await client.query("SELECT id FROM storages")).rows,
        [{ id: retained.id }],
      );
      assert.deepStrictEqual(
        (
          await client.query(
            "SELECT id FROM storage_versions WHERE storage_id=$1",
            [target.id],
          )
        ).rows,
        [],
      );
      assert.deepStrictEqual(
        (
          await client.query("SELECT instructions FROM agents WHERE id=$1", [
            agentId,
          ])
        ).rows,
        [{ instructions: body }],
      );
      assert.deepStrictEqual(
        (
          await client.query(
            "SELECT publication_key FROM storage_publication_tokens",
          )
        ).rows,
        [{ publication_key: "workflow:retained" }],
      );
      assert.deepStrictEqual(
        (
          await client.query(
            "SELECT generation::int FROM storage_publication_generations",
          )
        ).rows,
        [{ generation: 1 }],
      );
      assert.deepStrictEqual(
        (await client.query("SELECT kind, status, input FROM background_jobs"))
          .rows,
        [
          {
            kind: "storage-object-cleanup",
            status: "pending",
            input: {
              bucket: "cleanup-test",
              target: { kind: "prefix", value: target.prefix },
            },
          },
        ],
      );
      assert.strictEqual((await apply(path)).code, 2);
      assert.deepStrictEqual(
        (
          await client.query(
            "SELECT count(*)::int AS count FROM background_jobs",
          )
        ).rows,
        [{ count: 1 }],
      );
    },
  );

  await suite.test(
    "retires legacy versions in exact directories outside the registered prefix",
    async () => {
      const target = await storage();
      const outsideRoot = `${target.orgId}/volume/agent-instructions@legacy`;
      const head = await addVersion(target.id, outsideRoot);
      const outside = [head, await addVersion(target.id, outsideRoot)];
      await client.query("UPDATE storages SET head_version_id=$2 WHERE id=$1", [
        target.id,
        head.id,
      ]);
      const { manifest, path } = await preview();
      assert.deepStrictEqual(
        manifest.storages[0]?.versions,
        [
          { id: target.version, key: `${target.prefix}/${target.version}` },
          ...outside,
        ].sort((left, right) => {
          return left.id.localeCompare(right.id);
        }),
      );
      const result = await apply(path);
      assert.strictEqual(result.code, 0, result.stderr);
      assert.deepStrictEqual(
        (await client.query("SELECT id FROM storages")).rows,
        [],
      );
      assert.deepStrictEqual(
        (await client.query("SELECT id FROM storage_versions")).rows,
        [],
      );
      const expectedPrefixes = [
        target.prefix,
        ...outside.map((version) => {
          return version.key;
        }),
      ].sort();
      assert.deepStrictEqual(
        (
          await client.query(
            "SELECT input->'target'->>'value' AS prefix FROM background_jobs ORDER BY prefix",
          )
        ).rows,
        expectedPrefixes.map((prefix) => {
          return { prefix };
        }),
      );
      const receipt = z
        .object({
          status: z.literal("cleanup_queued"),
          jobs: z.array(z.object({ jobId: z.uuid(), prefix: z.string() })),
        })
        .parse(JSON.parse(result.stdout.split("\n")[0] ?? ""));
      assert.deepStrictEqual(
        receipt.jobs
          .map((job) => {
            return job.prefix;
          })
          .sort(),
        expectedPrefixes,
      );
      assert.strictEqual((await apply(path)).code, 2);
      assert.deepStrictEqual(
        (
          await client.query(
            "SELECT count(*)::int AS count FROM background_jobs",
          )
        ).rows,
        [{ count: 3 }],
      );
    },
  );

  await suite.test(
    "skips changed identities, independently changed version inventories, and shared prefixes",
    async () => {
      const changed = await storage();
      const shared = await storage("agent-instructions@shared");
      const versioned = await storage("agent-instructions@versioned");
      const moved = await storage("agent-instructions@moved");
      const { path } = await preview();
      await client.query(
        "UPDATE storages SET name='agent-instructions@edited' WHERE id=$1",
        [changed.id],
      );
      await storage(
        "agent-skills@nested",
        "__org__",
        `${shared.prefix}/nested`,
      );
      await addVersion(versioned.id, versioned.prefix);
      await client.query("UPDATE storage_versions SET s3_key=$2 WHERE id=$1", [
        moved.version,
        `${moved.orgId}/legacy/${moved.version}`,
      ]);
      const result = await apply(path);
      assert.strictEqual(result.code, 2, result.stderr);
      assert.deepStrictEqual(
        (await client.query("SELECT count(*)::int AS count FROM storages"))
          .rows,
        [{ count: 5 }],
      );
      assert.deepStrictEqual(
        (await client.query("SELECT id FROM background_jobs")).rows,
        [],
      );
    },
  );

  await suite.test(
    "retains outside version directories referenced by other Storage, versions, or exports",
    async () => {
      const registered = await storage("agent-instructions@registered");
      const versioned = await storage("agent-instructions@versioned");
      const exported = await storage("agent-instructions@exported");
      const registeredOutside = await addVersion(
        registered.id,
        `${registered.orgId}/legacy`,
      );
      const versionedOutside = await addVersion(
        versioned.id,
        `${versioned.orgId}/legacy`,
      );
      const exportedOutside = await addVersion(
        exported.id,
        `${exported.orgId}/legacy`,
      );
      const { path } = await preview();
      const nested = await storage(
        "agent-skills@nested",
        "__org__",
        `${registeredOutside.key}/nested`,
      );
      const aliased = await storage("agent-skills@aliased");
      await client.query("UPDATE storage_versions SET s3_key=$2 WHERE id=$1", [
        aliased.version,
        versionedOutside.key,
      ]);
      await client.query(
        `INSERT INTO export_jobs (user_id, org_id, status, s3_key)
        VALUES ('test-export-owner', $1, 'completed', $2)`,
        [exported.orgId, `${exportedOutside.key}/archive.tar.gz`],
      );
      const blocked = await apply(path);
      assert.strictEqual(blocked.code, 2, blocked.stderr);
      assert.deepStrictEqual(
        (await client.query("SELECT count(*)::int AS count FROM storages"))
          .rows,
        [{ count: 5 }],
      );
      assert.deepStrictEqual(
        (await client.query("SELECT id FROM background_jobs")).rows,
        [],
      );
      await client.query("DELETE FROM storages WHERE id=ANY($1::uuid[])", [
        [nested.id, aliased.id],
      ]);
      await client.query("DELETE FROM export_jobs WHERE org_id=$1", [
        exported.orgId,
      ]);
      const result = await apply(path);
      assert.strictEqual(result.code, 0, result.stderr);
      assert.deepStrictEqual(
        (
          await client.query(
            "SELECT count(*)::int AS count FROM background_jobs",
          )
        ).rows,
        [{ count: 6 }],
      );
    },
  );

  await suite.test(
    "retains queued, executing and finalizing consumers while allowing settled Run history to survive cleanup",
    async () => {
      for (const state of ["queued", "running", "finalizing"]) {
        const target = await storage(`agent-instructions@${state}`);
        const id = randomUUID();
        const mounts = [{ storageId: target.id, version: target.version }];
        await client.query(
          `INSERT INTO agent_runs (id, org_id, user_id, status, prompt, storage_mounts)
        VALUES ($1, $2, 'test-owner', $3, '', $4::jsonb)`,
          [
            id,
            target.orgId,
            state === "finalizing" ? "completed" : "running",
            JSON.stringify(mounts),
          ],
        );
        if (state === "queued") {
          await client.query(
            `INSERT INTO runner_job_queue (run_id, runner_group, execution_context, expires_at)
          VALUES ($1, 'test-group', $2::jsonb, now() + interval '1 hour')`,
            [
              id,
              JSON.stringify({
                storageMounts: [
                  { storageId: target.id, versionId: target.version },
                ],
              }),
            ],
          );
        }
        if (state === "finalizing") {
          await client.query(
            "INSERT INTO active_agent_runs (run_id, org_id, user_id, last_heartbeat_at) VALUES ($1, $2, 'test-owner', now())",
            [id, target.orgId],
          );
        }
      }
      const first = await preview();
      assert.strictEqual((await apply(first.path)).code, 2);
      assert.deepStrictEqual(
        (await client.query("SELECT id FROM background_jobs")).rows,
        [],
      );
      await client.query("DELETE FROM runner_job_queue");
      await client.query("DELETE FROM active_agent_runs");
      await client.query("UPDATE agent_runs SET status='completed'");
      const settled = await preview();
      const result = await apply(settled.path);
      assert.strictEqual(result.code, 0, result.stderr);
      assert.deepStrictEqual(
        (await client.query("SELECT count(*)::int AS count FROM agent_runs"))
          .rows,
        [{ count: 3 }],
      );
      assert.deepStrictEqual(
        (
          await client.query(
            "SELECT count(*)::int AS count FROM background_jobs",
          )
        ).rows,
        [{ count: 3 }],
      );
    },
  );

  await suite.test(
    "keeps the Storage, all versions and zero jobs when one cleanup target fails registration",
    async () => {
      const target = await storage();
      const outside = await addVersion(target.id, "outside/legacy");
      const { path } = await preview();
      await client.query(
        "ALTER TABLE background_jobs ADD CONSTRAINT reject_cleanup_test CHECK (input->'target'->>'value' NOT LIKE 'outside/%')",
      );
      try {
        assert.notStrictEqual((await apply(path)).code, 0);
        assert.deepStrictEqual(
          (await client.query("SELECT id FROM storages")).rows,
          [{ id: target.id }],
        );
        assert.deepStrictEqual(
          (await client.query("SELECT id FROM storage_versions ORDER BY id"))
            .rows,
          [target.version, outside.id].sort().map((id) => {
            return { id };
          }),
        );
        assert.deepStrictEqual(
          (await client.query("SELECT id FROM background_jobs")).rows,
          [],
        );
      } finally {
        await client.query(
          "ALTER TABLE background_jobs DROP CONSTRAINT reject_cleanup_test",
        );
      }
    },
  );
});
