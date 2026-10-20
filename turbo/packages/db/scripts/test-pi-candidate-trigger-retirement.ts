import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
import { promisify } from "node:util";
import { Client, DatabaseError, Query } from "pg";
import postgres from "postgres";
import { applyFixtureMigrations } from "./fixtures/migrate-with-empty-instructions";

// Infrastructure boundary: only PostgreSQL can construct catalog drift, corrupt
// historical ownership, DDL wait snapshots and a failing migration journal.
// Every scenario owns a whole database copied from the actual pre-C migrations.
const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const originalDirectory = process.cwd();
const directory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../src/migrations",
);
const tag = "1121_retire_pi_candidate_reference_trigger";
const journal = JSON.parse(
  await readFile(join(directory, "meta/_journal.json"), "utf8"),
) as {
  entries: { idx: number; tag: string; when: number }[];
};
const foundRetirement = journal.entries.find((entry) => {
  return entry.tag === tag;
});
assert.ok(foundRetirement, "Active candidate retirement transition is missing");
const retirement = foundRetirement;
const fixtureDirectory = await mkdtemp(
  join(tmpdir(), "pi-candidate-retirement-"),
);
const fixtureMigrations = join(fixtureDirectory, "src/migrations");
const template = `pi_retirement_${randomUUID().replaceAll("-", "")}`;
const adminUrl = new URL(databaseUrl);
adminUrl.pathname = "/postgres";
const admin = new Client({ connectionString: adminUrl.toString() });
await admin.connect();
const migrationText = await readFile(join(directory, `${tag}.sql`), "utf8");
const [lockStatement, validationStatement] = migrationText.split(
  "--> statement-breakpoint",
);
assert.ok(
  lockStatement && validationStatement,
  "Lock and audit must be independent statements",
);
const parent = "00000000-0000-4000-8000-000000033975";
const session = "00000000-0000-4000-8000-000000033972";
const sourceRun = "00000000-0000-4000-8000-000000033973";
const hash = "a".repeat(64);
const trigger = "pi_memory_stage1_candidate_blob_ref_count_trigger";
const functionName = "pi_memory_stage1_candidate_blob_ref_count";

function urlFor(database: string) {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

async function writeFrontier(includeRetirement: boolean) {
  const entries = journal.entries.filter((entry) => {
    return (
      entry.idx < retirement.idx ||
      (includeRetirement && entry.idx === retirement.idx)
    );
  });
  await mkdir(join(fixtureMigrations, "meta"), { recursive: true });
  for (const entry of entries) {
    await copyFile(
      join(directory, `${entry.tag}.sql`),
      join(fixtureMigrations, `${entry.tag}.sql`),
    );
  }
  // Only this test-owned journal frontier is shortened. Shipped files and the
  // generated repository journal are never edited by the validator.
  await writeFile(
    join(fixtureMigrations, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries }),
  );
}

async function apply(
  url: string,
  options: postgres.Options<Record<string, never>> = {},
) {
  const sql = postgres(url, { max: 1, onnotice: () => {}, ...options });
  process.chdir(fixtureDirectory);
  try {
    await applyFixtureMigrations(sql);
  } finally {
    process.chdir(originalDirectory);
    await sql.end();
  }
}

async function snapshot(client: Client) {
  return (
    await client.query(`SELECT jsonb_build_object(
    'triggers', (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) FROM pg_trigger t WHERE tgrelid = 'public.pi_memory_stage1_candidates'::regclass),
    'functions', (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM pg_proc p WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'pi_memory_stage1_candidate_blob_ref_count%'),
    'candidates', (SELECT jsonb_agg(to_jsonb(c) ORDER BY pi_session_id) FROM pi_memory_stage1_candidates c),
    'blobs', (SELECT jsonb_agg(to_jsonb(b) ORDER BY hash) FROM blobs b),
    'storages', (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM storages s),
    'journal', (SELECT jsonb_agg(to_jsonb(j) ORDER BY id) FROM drizzle.__drizzle_migrations j)
  ) AS state`)
  ).rows;
}

async function assertRetired(client: Client) {
  assert.deepEqual(
    (
      await client.query(
        `SELECT
    (SELECT count(*)::int FROM pg_trigger WHERE tgrelid = 'public.pi_memory_stage1_candidates'::regclass AND NOT tgisinternal) AS triggers,
    (SELECT count(*)::int FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = '${functionName}') AS functions,
    (SELECT count(*)::int FROM drizzle.__drizzle_migrations WHERE created_at = $1) AS journal`,
        [retirement.when],
      )
    ).rows,
    [{ triggers: 0, functions: 0, journal: 1 }],
  );
}

async function scenario(
  name: string,
  run: (client: Client, url: string) => Promise<void>,
) {
  const database = `pi_case_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE "${template}"`);
  const url = urlFor(database);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await run(client, url);
    console.log(`PASS ${name}`);
  } finally {
    await client.end();
    await admin.query(`DROP DATABASE "${database}"`);
  }
}

async function reject(
  name: string,
  setup: string,
  pattern: RegExp = /Pi candidate retirement/,
) {
  await scenario(name, async (client, url) => {
    await client.query(setup);
    const before = await snapshot(client);
    await assert.rejects(apply(url), pattern);
    assert.deepEqual(
      await snapshot(client),
      before,
      "Failure must preserve catalog, data and journal",
    );
  });
}

function insertRun(id: string) {
  return `INSERT INTO agent_runs (id, session_id, org_id, user_id, prompt, status, trigger_source, autonomy_budget)
    VALUES ('${id}', '${session}', 'retirement-org', 'retirement-user', 'fixture', 'completed', 'web', 0)`;
}

async function waitForLock(client: Client, applicationName: string) {
  const deadline = performance.now() + 4000;
  while (performance.now() < deadline) {
    await client.query("SELECT pg_stat_clear_snapshot()");
    const result = await client.query(
      `SELECT 1 FROM pg_stat_activity
      WHERE application_name = $1 AND wait_event_type = 'Lock'`,
      [applicationName],
    );
    if (result.rowCount === 1) return;
    // Wait on the DB's observable lock state, not an assumed interleaving.
    await new Promise((resolveWait) => {
      return setTimeout(resolveWait, 10);
    });
  }
  assert.fail("Expected migration to wait for the candidate relation lock");
}

try {
  await admin.query(`CREATE DATABASE "${template}"`);
  await writeFrontier(false);
  await apply(urlFor(template));
  const seed = new Client({ connectionString: urlFor(template) });
  await seed.connect();
  try {
    await seed.query(`INSERT INTO agents (id, org_id, owner, name)
      VALUES ('${session}', 'retirement-org', 'retirement-user', 'retirement-agent');
      INSERT INTO agent_sessions (id, agent_id, org_id, user_id)
      VALUES ('${session}', '${session}', 'retirement-org', 'retirement-user');
      INSERT INTO storages (id, org_id, user_id, name, s3_prefix)
      VALUES ('${parent}', 'retirement-org', 'retirement-user', 'memory', 'fixture');
      INSERT INTO blobs (hash, ref_count, raw_size, encoding, encoded_size)
      VALUES ('${hash}', 0, 0, 'identity', 0);
      INSERT INTO pi_memory_stage1_candidates
        (memory_storage_id, org_id, user_id, pi_session_id, source_run_id, source_history_hash,
         source_completed_at, eligible_at, created_at)
      VALUES ('${parent}', 'retirement-org', 'retirement-user', 'session', '${sourceRun}', '${hash}',
        '2026-09-11', '2026-09-11', '2026-09-11');`);
  } finally {
    await seed.end();
  }
  await writeFrontier(true);

  await scenario(
    "original configuration and balanced candidate ledger",
    async (client, url) => {
      const before = (await client.query("SELECT * FROM blobs")).rows;
      await apply(url);
      await assertRetired(client);
      assert.deepEqual(
        (await client.query("SELECT * FROM blobs")).rows,
        before,
      );
    },
  );
  await scenario(
    "precise residual survives without a ledger rewrite",
    async (client, url) => {
      await client.query("UPDATE blobs SET ref_count = 2");
      const notices: string[] = [];
      await apply(url, {
        onnotice: (notice) => {
          assert.ok(typeof notice.message === "string");
          notices.push(notice.message);
        },
      });
      await assertRetired(client);
      assert.match(notices.join("\n"), /"old_source_deleted_run_residuals": 1/);
      assert.deepEqual(
        (await client.query("SELECT ref_count FROM blobs")).rows,
        [{ ref_count: 2 }],
      );
    },
  );
  await scenario(
    "classification is not a ten-hash allowance",
    async (client, url) => {
      await client.query(`INSERT INTO blobs (hash, ref_count, raw_size, encoding, encoded_size)
      SELECT lpad(to_hex(n), 64, '0'), 1, 0, 'identity', 0 FROM generate_series(1, 10) n;
      INSERT INTO pi_memory_stage1_candidates
        (memory_storage_id, org_id, user_id, pi_session_id, source_run_id, source_history_hash,
         source_completed_at, eligible_at, created_at)
      SELECT '${parent}', 'retirement-org', 'retirement-user', n::text, gen_random_uuid(), lpad(to_hex(n), 64, '0'),
        '2026-09-11', '2026-09-11', '2026-09-11' FROM generate_series(1, 10) n;
      UPDATE blobs SET ref_count = 2 WHERE hash = '${hash}';`);
      const notices: string[] = [];
      await apply(url, {
        onnotice: (notice) => {
          assert.ok(typeof notice.message === "string");
          notices.push(notice.message);
        },
      });
      await assertRetired(client);
      assert.match(
        notices.join("\n"),
        /"old_source_deleted_run_residuals": 11/,
      );
      assert.deepEqual(
        (
          await client.query(
            "SELECT count(*)::int AS count FROM blobs WHERE ref_count = 2",
          )
        ).rows,
        [{ count: 11 }],
      );
    },
  );
  const otherRun = "00000000-0000-4000-8000-000000033974";
  const conversation = `${insertRun(otherRun)};
    INSERT INTO conversations (run_id, cli_agent_type, cli_agent_session_id, cli_agent_session_history_hash)
    VALUES ('${otherRun}', 'pi', 'conversation', '${hash}')`;
  const extraCandidate = `INSERT INTO pi_memory_stage1_candidates
    (memory_storage_id, org_id, user_id, pi_session_id, source_run_id, source_history_hash, source_completed_at, eligible_at, created_at)
    SELECT memory_storage_id, org_id, user_id, 'second', source_run_id, source_history_hash, source_completed_at, eligible_at, created_at
    FROM pi_memory_stage1_candidates`;
  for (const [name, setup] of [
    [
      "one candidate plus one conversation at two",
      `${conversation}; UPDATE blobs SET ref_count = 2`,
    ],
    ["two candidates at two", extraCandidate],
  ] as const) {
    await scenario(`balanced ${name}`, async (client, url) => {
      await client.query(setup);
      await apply(url);
      await assertRetired(client);
      assert.deepEqual(
        (await client.query("SELECT ref_count FROM blobs")).rows,
        [{ ref_count: 2 }],
      );
    });
  }

  const invalidCatalog = [
    [
      "missing trigger",
      `DROP TRIGGER ${trigger} ON pi_memory_stage1_candidates`,
    ],
    [
      "missing trigger and function",
      `DROP TRIGGER ${trigger} ON pi_memory_stage1_candidates; DROP FUNCTION ${functionName}()`,
    ],
    [
      "disabled trigger",
      `ALTER TABLE pi_memory_stage1_candidates DISABLE TRIGGER ${trigger}`,
    ],
    [
      "replica trigger",
      `ALTER TABLE pi_memory_stage1_candidates ENABLE REPLICA TRIGGER ${trigger}`,
    ],
    [
      "always trigger",
      `ALTER TABLE pi_memory_stage1_candidates ENABLE ALWAYS TRIGGER ${trigger}`,
    ],
    [
      "renamed trigger",
      `ALTER TRIGGER ${trigger} ON pi_memory_stage1_candidates RENAME TO unexpected_trigger`,
    ],
    [
      "extra trigger",
      `CREATE TRIGGER extra_trigger AFTER INSERT ON pi_memory_stage1_candidates FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
    ],
    [
      "wrong update attribute",
      `DROP TRIGGER ${trigger} ON pi_memory_stage1_candidates; CREATE TRIGGER ${trigger} AFTER INSERT OR DELETE OR UPDATE OF status ON pi_memory_stage1_candidates FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
    ],
    [
      "filtered trigger",
      `DROP TRIGGER ${trigger} ON pi_memory_stage1_candidates; CREATE TRIGGER ${trigger} AFTER INSERT ON pi_memory_stage1_candidates FOR EACH ROW WHEN (NEW.status = 'pending') EXECUTE FUNCTION ${functionName}()`,
    ],
    [
      "trigger arguments",
      `DROP TRIGGER ${trigger} ON pi_memory_stage1_candidates; CREATE TRIGGER ${trigger} AFTER INSERT OR DELETE OR UPDATE OF source_history_hash ON pi_memory_stage1_candidates FOR EACH ROW EXECUTE FUNCTION ${functionName}('unexpected')`,
    ],
    [
      "deferred trigger",
      `DROP TRIGGER ${trigger} ON pi_memory_stage1_candidates; CREATE CONSTRAINT TRIGGER ${trigger} AFTER INSERT OR DELETE OR UPDATE ON pi_memory_stage1_candidates DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
    ],
    [
      "altered function body",
      `CREATE OR REPLACE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$`,
    ],
    [
      "renamed function",
      `ALTER FUNCTION ${functionName}() RENAME TO pi_memory_stage1_candidate_blob_ref_count_renamed`,
    ],
    [
      "function configuration",
      `ALTER FUNCTION ${functionName}() SET search_path = pg_catalog`,
    ],
    ["function security", `ALTER FUNCTION ${functionName}() SECURITY DEFINER`],
    ["function volatility", `ALTER FUNCTION ${functionName}() STABLE`],
    ["function strictness", `ALTER FUNCTION ${functionName}() STRICT`],
    ["function parallelism", `ALTER FUNCTION ${functionName}() PARALLEL SAFE`],
    [
      "overloaded function",
      `CREATE FUNCTION ${functionName}(integer) RETURNS integer LANGUAGE sql AS 'SELECT $1'`,
    ],
  ];
  for (const [name, setup] of invalidCatalog) {
    assert.ok(name && setup);
    await reject(name, setup, /Unexpected Pi candidate retirement catalog/);
  }

  const invalidOwnership = [
    [
      "missing blob",
      "SET session_replication_role = replica; DELETE FROM blobs; SET session_replication_role = origin",
    ],
    [
      "missing storage",
      "SET session_replication_role = replica; DELETE FROM storages; SET session_replication_role = origin",
    ],
    [
      "wrong org",
      "SET session_replication_role = replica; UPDATE storages SET org_id = 'wrong'; SET session_replication_role = origin",
    ],
    [
      "wrong user",
      "SET session_replication_role = replica; UPDATE storages SET user_id = 'wrong'; SET session_replication_role = origin",
    ],
    ["wrong namespace", "UPDATE storages SET name = 'artifacts'"],
    [
      "org namespace",
      "SET session_replication_role = replica; UPDATE storages SET user_id = '__org__'; UPDATE pi_memory_stage1_candidates SET user_id = '__org__'; SET session_replication_role = origin",
    ],
    ["insufficient count", "UPDATE blobs SET ref_count = 0"],
    ["negative count", "UPDATE blobs SET ref_count = -1"],
    [
      "residual current source run",
      `${insertRun(sourceRun)}; UPDATE blobs SET ref_count = 2`,
    ],
    [
      "residual with current conversation and real excess",
      `${conversation}; UPDATE blobs SET ref_count = 3`,
    ],
    [
      "residual with extra candidate and real excess",
      `${extraCandidate}; UPDATE blobs SET ref_count = 3`,
    ],
    [
      "residual created at cutoff",
      "UPDATE pi_memory_stage1_candidates SET created_at = '2026-09-14 01:11:38'; UPDATE blobs SET ref_count = 2",
    ],
    [
      "residual completed at cutoff",
      "UPDATE pi_memory_stage1_candidates SET source_completed_at = '2026-09-14 01:11:38'; UPDATE blobs SET ref_count = 2",
    ],
    ["residual different excess", "UPDATE blobs SET ref_count = 3"],
    ["conversation ownership shortfall", conversation],
  ];
  for (const [name, setup] of invalidOwnership) {
    assert.ok(name && setup);
    await reject(name, setup, /Pi candidate retirement ownership audit failed/);
  }

  for (const isolation of ["repeatable read", "serializable"] as const) {
    await scenario(`reject ${isolation}`, async (client, url) => {
      const before = await snapshot(client);
      await assert.rejects(
        apply(url, {
          connection: { default_transaction_isolation: isolation },
        }),
        /requires read committed and origin/,
      );
      assert.deepEqual(await snapshot(client), before);
    });
  }
  await scenario("reject replication bypass", async (client, url) => {
    const before = await snapshot(client);
    await assert.rejects(
      apply(url, { connection: { session_replication_role: "replica" } }),
      /requires read committed and origin/,
    );
    assert.deepEqual(await snapshot(client), before);
  });
  await reject(
    "journal failure rolls back drop",
    `ALTER TABLE drizzle.__drizzle_migrations
    ADD CONSTRAINT inject_journal_failure CHECK (created_at <> ${retirement.when})`,
    /inject_journal_failure/,
  );
  await scenario(
    "post-drop failure rolls back catalog, data and journal despite NOTICE",
    async (client, url) => {
      const before = await snapshot(client);
      const notices: string[] = [];
      await writeFile(
        join(fixtureMigrations, `${tag}.sql`),
        `${migrationText}
--> statement-breakpoint
UPDATE public.blobs SET ref_count = ref_count + 100;
--> statement-breakpoint
SELECT 1 / 0;`,
      );
      try {
        await assert.rejects(
          apply(url, {
            onnotice: (notice) => {
              assert.ok(typeof notice.message === "string");
              notices.push(notice.message);
            },
          }),
          /division by zero/,
        );
        assert.ok(
          notices.some((notice) => {
            return notice.includes('"transaction_status": "pending_commit"');
          }),
        );
        assert.deepEqual(await snapshot(client), before);
      } finally {
        await writeFile(join(fixtureMigrations, `${tag}.sql`), migrationText);
      }
    },
  );

  await scenario(
    "migration waits then audits a fresh writer commit",
    async (client, url) => {
      const writer = new Client({ connectionString: url });
      const observer = new Client({ connectionString: url });
      class PausedCopy extends Query<Record<string, unknown>, []> {
        paused = false;

        handleCopyData(message: { chunk: unknown }): void {
          if (!this.paused) {
            this.paused = true;
            writer.connection.stream.pause();
            this.emit("firstCopyData", message.chunk);
          }
        }
      }

      // The real writer stays uncommitted while its ordinary candidate read
      // conflicts with the migration. COPY bounds streamed output to ~64 MiB.
      const resource = new PausedCopy(`COPY (
        WITH changed AS (
          UPDATE blobs SET ref_count = 3 RETURNING hash, ref_count
        )
        SELECT c.pi_session_id, c.source_history_hash, changed.ref_count,
          ordinal, repeat('x', 8192)
        FROM pi_memory_stage1_candidates c
        JOIN changed ON changed.hash = c.source_history_hash
        CROSS JOIN generate_series(1, 8192) AS ordinal
      ) TO STDOUT`);
      let resourceEnded = false;
      const outcome = new Promise<
        { error: unknown } | { rowCount: number | null }
      >((resolveOutcome) => {
        resource.once("error", (error: unknown) => {
          resourceEnded = true;
          resolveOutcome({ error });
        });
        resource.once("end", (result: { rowCount: number | null }) => {
          resourceEnded = true;
          resolveOutcome({ rowCount: result.rowCount });
        });
      });
      const firstData = new Promise<unknown>((resolveFirst) => {
        resource.once("firstCopyData", resolveFirst);
      });
      // Own early error/end before submission without an unhandled rejection.
      const ready = Promise.race([firstData, outcome]);
      const errors: unknown[] = [];
      const onClientError = (error: unknown) => {
        errors.push(error);
      };
      writer.on("error", onClientError);
      observer.on("error", onClientError);
      let pid: number | undefined;
      let submitted = false;
      let waiting: Promise<void> | undefined;
      let attemptOutcome:
        Promise<{ error: unknown } | { completed: true }> | undefined;
      try {
        await writer.connect();
        await observer.connect();
        const backend = await writer.query<{ pid: unknown }>(
          "SELECT pg_backend_pid() AS pid",
        );
        assert.equal(backend.rowCount, 1);
        const value = backend.rows[0]?.pid;
        assert.ok(
          typeof value === "number" && Number.isSafeInteger(value) && value > 0,
        );
        pid = value;
        writer.query(resource);
        submitted = true;
        const first = await ready;
        assert.ok(Buffer.isBuffer(first), "COPY ended before writer readiness");
        assert.equal(
          first.toString("utf8"),
          `session\t${hash}\t3\t1\t${"x".repeat(8192)}\n`,
        );
        assert.equal(writer.connection.stream.isPaused(), true);
        assert.equal(resourceEnded, false);
        const attempt = apply(url, {
          connection: { application_name: "pi-retirement-wait" },
        });
        attemptOutcome = attempt.then(
          () => {
            return { completed: true as const };
          },
          (error: unknown) => {
            return { error };
          },
        );
        // The COPY client is busy. Observe the original actual migration wait
        // from this scenario's separate connection and own early termination.
        waiting = waitForLock(observer, "pi-retirement-wait");
        await Promise.race([
          waiting,
          attemptOutcome.then((result) => {
            if ("error" in result) throw result.error;
            assert.fail("Migration completed before writer release");
          }),
          outcome.then((result) => {
            if ("error" in result) throw result.error;
            assert.fail("COPY completed before the migration wait");
          }),
        ]);
        writer.connection.stream.resume();
        const result = await outcome;
        if ("error" in result) throw result.error;
        assert.equal(result.rowCount, 8192);
        // Normal COPY end commits the unrestricted UPDATE. This query waits
        // for ReadyForQuery and obtains its own idle acknowledgement.
        assert.deepEqual(
          (await writer.query("SELECT ref_count FROM blobs")).rows,
          [{ ref_count: 3 }],
        );
        assert.equal(writer.getTransactionStatus(), "I");
        await assert.rejects(
          attempt,
          /Pi candidate retirement ownership audit failed/,
        );
      } catch (error) {
        errors.push(error);
      } finally {
        if (submitted) {
          let cancellationRequested = false;
          try {
            if (!resourceEnded) {
              assert.ok(pid !== undefined);
              const cancelled = await observer.query(
                "SELECT pg_cancel_backend($1) AS cancelled",
                [pid],
              );
              assert.deepEqual(cancelled.rows, [{ cancelled: true }]);
              cancellationRequested = true;
            }
          } catch (error) {
            errors.push(error);
          }
          // Attempt every release step independently and retain all failures.
          try {
            writer.connection.stream.resume();
          } catch (error) {
            errors.push(error);
          }
          try {
            const result = await outcome;
            if (cancellationRequested) {
              assert.ok("error" in result);
              assert.ok(result.error instanceof DatabaseError);
              assert.equal(result.error.code, "57014");
            } else if ("error" in result) {
              errors.push(result.error);
            }
          } catch (error) {
            errors.push(error);
          }
          try {
            const releaseACK = await writer.query(
              "SELECT pg_backend_pid() AS pid",
            );
            assert.deepEqual(releaseACK.rows, [{ pid }]);
            assert.equal(writer.getTransactionStatus(), "I");
          } catch (error) {
            errors.push(error);
          }
        }
        if (attemptOutcome) await attemptOutcome;
        if (waiting) {
          try {
            await waiting;
          } catch (error) {
            errors.push(error);
          }
        }
        try {
          await writer.end();
        } catch (error) {
          errors.push(error);
        }
        try {
          await observer.end();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) {
        throw new AggregateError(errors, "Fresh writer COPY fixture failed");
      }
      assert.deepEqual(
        (
          await client.query(`SELECT ref_count, (SELECT count(*)::int FROM pg_trigger
      WHERE tgrelid = 'public.pi_memory_stage1_candidates'::regclass AND NOT tgisinternal) AS triggers FROM blobs`)
        ).rows,
        [{ ref_count: 3, triggers: 1 }],
      );
    },
  );
  await scenario(
    "one-second relation lock timeout preserves B",
    async (client, url) => {
      const before = await snapshot(client);
      const blocker = new Client({ connectionString: url });
      class PausedCopy extends Query<Record<string, unknown>, []> {
        paused = false;

        handleCopyData(message: { chunk: unknown }): void {
          if (!this.paused) {
            this.paused = true;
            blocker.connection.stream.pause();
            this.emit("firstCopyData", message.chunk);
          }
        }
      }

      // An ordinary in-flight read holds ACCESS SHARE against the migration's
      // ACCESS EXCLUSIVE. COPY emits during execution; bound output to ~64 MiB.
      const resource = new PausedCopy(`COPY (
        SELECT pi_session_id, source_history_hash, ordinal, repeat('x', 8192)
        FROM public.pi_memory_stage1_candidates
        CROSS JOIN generate_series(1, 8192) AS ordinal
      ) TO STDOUT`);
      let resourceEnded = false;
      const outcome = new Promise<unknown>((resolveOutcome) => {
        resource.once("error", (error: unknown) => {
          resourceEnded = true;
          resolveOutcome(error);
        });
        resource.once("end", () => {
          resourceEnded = true;
          resolveOutcome(new Error("COPY completed before cancellation"));
        });
      });
      const firstData = new Promise<unknown>((resolveFirst) => {
        resource.once("firstCopyData", resolveFirst);
      });
      // Install every observer before submission. Early failure or normal
      // completion cannot stand in for a live, conflicting read.
      const ready = Promise.race([
        firstData,
        outcome.then((error) => {
          throw error;
        }),
      ]);
      const errors: unknown[] = [];
      blocker.on("error", (error: unknown) => {
        errors.push(error);
      });
      let pid: number | undefined;
      let submitted = false;
      try {
        await blocker.connect();
        const backend = await blocker.query<{ pid: unknown }>(
          "SELECT pg_backend_pid() AS pid",
        );
        assert.equal(backend.rowCount, 1);
        const value = backend.rows[0]?.pid;
        assert.ok(
          typeof value === "number" && Number.isSafeInteger(value) && value > 0,
        );
        pid = value;
        blocker.query(resource);
        submitted = true;
        const first = await ready;
        assert.ok(Buffer.isBuffer(first));
        assert.equal(
          first.toString("utf8"),
          `session\t${hash}\t1\t${"x".repeat(8192)}\n`,
        );
        assert.equal(blocker.connection.stream.isPaused(), true);
        assert.equal(resourceEnded, false);
        await assert.rejects(apply(url), (error: unknown) => {
          assert.ok(error instanceof postgres.PostgresError);
          assert.equal(error.code, "55P03");
          assert.match(error.message, /lock timeout/);
          return true;
        });
      } catch (error) {
        errors.push(error);
      } finally {
        if (submitted) {
          let cancellationRequested = false;
          try {
            if (!resourceEnded) {
              const cancelled = await client.query<{ cancelled: unknown }>(
                "SELECT pg_cancel_backend($1) AS cancelled",
                [pid],
              );
              assert.deepEqual(cancelled.rows, [{ cancelled: true }]);
              cancellationRequested = true;
            }
          } catch (error) {
            errors.push(error);
          }
          // Each release step is attempted even if an earlier assertion fails.
          try {
            blocker.connection.stream.resume();
          } catch (error) {
            errors.push(error);
          }
          try {
            const error = await outcome;
            assert.ok(error instanceof DatabaseError);
            assert.equal(error.code, "57014");
            assert.equal(cancellationRequested, true);
          } catch (error) {
            errors.push(error);
          }
          try {
            // Wait for the target ReadyForQuery and this query's own idle ACK.
            // A successful cancel request alone does not establish release.
            const releaseACK = await blocker.query<{ pid: unknown }>(
              "SELECT pg_backend_pid() AS pid",
            );
            assert.deepEqual(releaseACK.rows, [{ pid }]);
            assert.equal(blocker.getTransactionStatus(), "I");
          } catch (error) {
            errors.push(error);
          }
        }
        try {
          await blocker.end();
        } catch (error) {
          errors.push(error);
        }
        try {
          assert.deepEqual(await snapshot(client), before);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "Relation-timeout resource failed");
      }
      console.log(
        "Read-only COPY: exact first row; migration 55P03; exact-PID cancel, 57014, drained, same-client idle I; complete snapshot unchanged.",
      );
    },
  );

  await scenario(
    "production-sized census and existing migration log receipt",
    async (client, url) => {
      // Synthetic metadata at the measured 2026-09-14 scale, with unrelated blobs
      // deliberately outside the candidate reconciliation scope. No production data.
      await client.query(`INSERT INTO blobs (hash, ref_count, raw_size, encoding, encoded_size)
      SELECT lpad(to_hex(n), 64, '0'), 0, 0, 'identity', 0 FROM generate_series(1, 310577) n;
      INSERT INTO pi_memory_stage1_candidates
        (memory_storage_id, org_id, user_id, pi_session_id, source_run_id, source_history_hash, source_completed_at, eligible_at, created_at)
      SELECT '${parent}', 'retirement-org', 'retirement-user', n::text, gen_random_uuid(), lpad(to_hex(n), 64, '0'),
        '2026-09-11', '2026-09-11', '2026-09-11' FROM generate_series(1, 1314) n;
      INSERT INTO agent_runs (session_id, org_id, user_id, prompt, status, trigger_source, autonomy_budget)
      SELECT '${session}', 'retirement-scale', n::text, 'fixture', 'completed', 'web', 0 FROM generate_series(1, 274989) n;
      INSERT INTO conversations (run_id, cli_agent_type, cli_agent_session_id, cli_agent_session_history_hash)
      SELECT id, 'pi', user_id, lpad(to_hex(user_id::int), 64, '0') FROM agent_runs WHERE org_id = 'retirement-scale';
      UPDATE blobs b SET ref_count = b.ref_count + 1 FROM conversations v
        WHERE b.hash = v.cli_agent_session_history_hash;
      ANALYZE pi_memory_stage1_candidates; ANALYZE conversations; ANALYZE blobs; ANALYZE agent_runs;`);
      // Record default-runner NOTICE via the actual CLI entry point, not an API
      // logger mock or a special production diagnostic. CLI completion follows COMMIT.
      const start = performance.now();
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        [
          fileURLToPath(import.meta.resolve("tsx/cli")),
          fileURLToPath(new URL("./migrate.ts", import.meta.url)),
        ],
        {
          cwd: fixtureDirectory,
          env: { ...process.env, DATABASE_URL: url },
          maxBuffer: 1024 * 1024,
        },
      );
      const output = stdout + stderr;
      assert.match(output, /pi_candidate_retirement_v1/);
      assert.match(output, /"candidate_rows": 1315/);
      assert.match(output, /"balanced_hashes": 1315/);
      assert.match(output, /"post_drop_absent": true/);
      assert.match(output, /Migrations complete/);
      assert.ok(
        output.indexOf("pi_candidate_retirement_v1") <
          output.indexOf("Migrations complete"),
      );
      for (const identity of [
        parent,
        sourceRun,
        hash,
        "retirement-org",
        "retirement-user",
      ])
        assert.ok(!output.includes(identity));
      await assertRetired(client);
      console.log(
        `Synthetic scale: 1315 candidates / 310578 blobs / 274989 conversations; migration CLI ${Math.round(performance.now() - start)} ms (default 1s lock / 10s statement limits).`,
      );
      console.log(
        output.split("\n").find((line) => {
          return line.includes("pi_candidate_retirement_v1");
        }),
      );
    },
  );
} finally {
  process.chdir(originalDirectory);
  await admin.query(`DROP DATABASE IF EXISTS "${template}"`);
  await admin.end();
  await rm(fixtureDirectory, { recursive: true, force: true });
}
console.log("Pi candidate trigger retirement transition validated");
