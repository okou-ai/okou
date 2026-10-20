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
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, DatabaseError, Query } from "pg";
import postgres from "postgres";
import { z } from "zod";
import { applyFixtureMigrations } from "./fixtures/migrate-with-empty-instructions";

// DDL, catalog corruption and journal failures are infrastructure boundaries.
// Each case owns a database at the actual pre-1132 migration frontier.
const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const migrations = fileURLToPath(new URL("../src/migrations", import.meta.url));
const originalDirectory = process.cwd();
const fixture = await mkdtemp(join(tmpdir(), "prepared-domain-retirement-"));
const fixtureMigrations = join(fixture, "src/migrations");
const tag = "1132_retire_prepared_domain_triggers";
const journal = JSON.parse(
  await readFile(join(migrations, "meta/_journal.json"), "utf8"),
) as {
  entries: { idx: number; tag: string; when: number }[];
};
const retirement = journal.entries.find((entry) => {
  return entry.tag === tag;
});
assert.ok(retirement);
const frontier = retirement;
const template = `domain_template_${randomUUID().replaceAll("-", "")}`;
const adminUrl = new URL(databaseUrl);
adminUrl.pathname = "/postgres";
const admin = new Client({ connectionString: adminUrl.toString() });
await admin.connect();

function urlFor(database: string) {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}
async function writeFrontier(includeRetirement: boolean) {
  const entries = journal.entries.filter((entry) => {
    return (
      entry.idx < frontier.idx ||
      (includeRetirement && entry.idx === frontier.idx)
    );
  });
  await mkdir(join(fixtureMigrations, "meta"), { recursive: true });
  for (const entry of entries) {
    await copyFile(
      join(migrations, `${entry.tag}.sql`),
      join(fixtureMigrations, `${entry.tag}.sql`),
    );
  }
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
  process.chdir(fixture);
  try {
    await applyFixtureMigrations(sql);
  } finally {
    process.chdir(originalDirectory);
    await sql.end();
  }
}
const tables = [
  "org_metadata",
  "org_plan_entitlements",
  "org_custom_connectors",
  "org_custom_connector_oauth_configs",
  "hosted_sites",
  "hosted_deployments",
  "usage_pack_subscriptions",
  "usage_pack_pending_snapshot_guards",
] as const;
async function data(client: Client) {
  const result = [];
  for (const table of tables) {
    result.push(
      (
        await client.query(
          `SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`,
        )
      ).rows,
    );
  }
  return result;
}
async function catalog(client: Client) {
  return (
    await client.query(`SELECT jsonb_build_object(
    'triggers', (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) FROM pg_trigger t
      WHERE tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace)),
    'functions', (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM pg_proc p
      WHERE pronamespace = 'public'::regnamespace),
    'journal', (SELECT jsonb_agg(to_jsonb(j) ORDER BY id) FROM drizzle.__drizzle_migrations j)
  ) AS state`)
  ).rows;
}
async function constraints(client: Client) {
  return (
    await client.query(`SELECT jsonb_build_object(
    'constraints', (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.oid) FROM pg_constraint c
      WHERE connamespace = 'public'::regnamespace AND contype <> 't'),
    'indexes', (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.indexrelid) FROM pg_index i
      JOIN pg_class t ON t.oid = i.indrelid WHERE t.relnamespace = 'public'::regnamespace),
    'privacy', (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) FROM pg_trigger t
      WHERE tgrelid = 'public.privacy_choices'::regclass)
  ) AS state`)
  ).rows;
}
async function scenario(
  name: string,
  run: (client: Client, url: string) => Promise<void>,
) {
  const database = `domain_case_${randomUUID().replaceAll("-", "")}`;
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
  pattern = /Prepared domain retirement/,
) {
  await scenario(name, async (client, url) => {
    await client.query(setup);
    const before = { data: await data(client), catalog: await catalog(client) };
    await assert.rejects(apply(url), pattern);
    assert.deepEqual(
      { data: await data(client), catalog: await catalog(client) },
      before,
    );
  });
}
try {
  await writeFrontier(false);
  await admin.query(`CREATE DATABASE "${template}" TEMPLATE template0`);
  await apply(urlFor(template));
  const seed = new Client({ connectionString: urlFor(template) });
  await seed.connect();
  try {
    await seed.query(`
      INSERT INTO org_metadata (org_id, tier) VALUES ('domain-org', 'free'), ('domain-manual', 'pro');
      UPDATE org_plan_entitlements SET source = 'manual', can_buy_credits = false WHERE org_id = 'domain-manual';
      INSERT INTO org_custom_connectors (org_id, slug, display_name, auth_mode, created_by, mcp_endpoint, mcp_transport)
      VALUES ('domain-org', '_retirement', 'Retirement fixture', 'none', 'domain-user', 'https://mcp.example.test', 'streamable-http');
      INSERT INTO hosted_sites (org_id, user_id, slug, public_slug, public_brand)
      VALUES ('domain-org', 'domain-user', 'retirement', 'retirement', 'okou');
      INSERT INTO hosted_deployments (site_id, org_id, user_id, status, r2_prefix,
        manifest, manifest_hash, content_hash, file_count, size_bytes, url, public_brand)
      SELECT id, org_id, user_id, 'uploading', 'fixture', '{}'::jsonb,
        repeat('0',64), repeat('0',64), 0, 0, 'https://retirement.invalid', public_brand FROM hosted_sites;
      INSERT INTO usage_pack_subscriptions
        (org_id, tier, stripe_plan_price_id, stripe_customer_id, subscription_status)
      VALUES ('domain-org', 'pro', 'price_fixture', 'cus_fixture', 'checkout_pending');
    `);
  } finally {
    await seed.end();
  }
  await writeFrontier(true);
  await scenario(
    "all eight retired atomically, data/constraints/privacy unchanged, retry idempotent",
    async (client, url) => {
      const before = await data(client);
      const preserved = await constraints(client);
      const notices: string[] = [];
      await apply(url, {
        onnotice: (notice) => {
          if (notice.message !== undefined) {
            notices.push(notice.message);
          }
        },
      });
      assert.deepEqual(await data(client), before);
      assert.deepEqual(await constraints(client), preserved);
      const counts = await client.query(
        `SELECT
      (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN
        (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace)) AS triggers,
      (SELECT count(*)::int FROM drizzle.__drizzle_migrations WHERE created_at = $1) AS journal`,
        [frontier.when],
      );
      assert.deepEqual(counts.rows, [{ triggers: 19, journal: 1 }]);
      assert.match(notices.join("\n"), /prepared_domain_trigger_retirement_v1/);
      assert.match(notices.join("\n"), /"pending_guard_mismatches": 0/);
      assert.ok(!notices.join("\n").includes("domain-user"));
      const after = await catalog(client);
      await apply(url);
      assert.deepEqual(await catalog(client), after);
    },
  );
  await scenario(
    "grandfathered pending roots preserve exact count",
    async (client, url) => {
      await client.query(`DELETE FROM usage_pack_pending_snapshot_guards;
      INSERT INTO usage_pack_subscriptions
        (org_id, tier, stripe_plan_price_id, stripe_customer_id, subscription_status)
      VALUES ('domain-org', 'pro', 'price_second', 'cus_second', 'purchase_pending');
      UPDATE usage_pack_pending_snapshot_guards SET pending_snapshot_count = 2`);
      const before = await data(client);
      await apply(url);
      assert.deepEqual(await data(client), before);
    },
  );
  for (const [name, setup] of [
    [
      "missing entitlement",
      "DELETE FROM org_plan_entitlements WHERE org_id = 'domain-org'",
    ],
    [
      "managed credit drift",
      "UPDATE org_plan_entitlements SET can_buy_credits = false WHERE org_id = 'domain-org'",
    ],
    [
      "OAuth pair drift",
      "SET session_replication_role = replica; UPDATE org_custom_connectors SET auth_mode = 'oauth', header_injections = jsonb_build_array(jsonb_build_object('name', 'Authorization', 'valueTemplate', 'Bearer fixture')); SET session_replication_role = origin",
    ],
    [
      "missing requested slug",
      "SET session_replication_role = replica; UPDATE hosted_sites SET requested_slug = NULL; SET session_replication_role = origin",
    ],
    [
      "deployment organization drift",
      "UPDATE hosted_deployments SET org_id = 'wrong-org'",
    ],
    ["missing guard", "DELETE FROM usage_pack_pending_snapshot_guards"],
    [
      "wrong guard count",
      "UPDATE usage_pack_pending_snapshot_guards SET pending_snapshot_count = 2",
    ],
    [
      "disabled trigger",
      "ALTER TABLE hosted_sites DISABLE TRIGGER canonicalize_hosted_site_scope_0753",
    ],
    [
      "missing trigger",
      "DROP TRIGGER sync_usage_pack_pending_snapshot_guard_0954 ON usage_pack_subscriptions",
    ],
    [
      "changed function",
      "CREATE OR REPLACE FUNCTION enforce_hosted_deployment_scope_0753() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$",
    ],
    [
      "function search path drift",
      "ALTER FUNCTION enforce_hosted_deployment_scope_0753() SET search_path = pg_catalog",
    ],
  ]) {
    assert.ok(name && setup);
    await reject(name, setup);
  }
  await reject(
    "dependent trigger prevents partial retirement",
    `CREATE TRIGGER dependent_host_scope
    BEFORE INSERT ON hosted_deployments FOR EACH ROW EXECUTE FUNCTION enforce_hosted_deployment_scope_0753()`,
    /depend/,
  );
  await reject(
    "journal failure restores dropped triggers and all rows",
    `CREATE FUNCTION reject_domain_journal() RETURNS trigger
    LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'domain journal failure'; END$$;
    CREATE TRIGGER reject_domain_journal BEFORE INSERT ON drizzle.__drizzle_migrations
    FOR EACH ROW EXECUTE FUNCTION reject_domain_journal()`,
    /domain journal failure/,
  );
  await scenario(
    "default lock timeout leaves data/catalog/journal untouched",
    async (client, url) => {
      const blocker = new Client({ connectionString: url });
      const errors: unknown[] = [];
      let failClient: (result: { error: unknown }) => void = () => {};
      const clientFailure = new Promise<{ error: unknown }>((resolve) => {
        failClient = resolve;
      });
      const onClientError = (error: unknown) => {
        errors.push(error);
        failClient({ error });
      };
      let ending = false;
      blocker.on("error", onClientError);
      blocker.on("end", () => {
        if (!ending) {
          onClientError(new Error("COPY client ended before release"));
        }
      });
      client.on("error", onClientError);
      let pid: number | undefined;
      let submitted = false;
      let resourceEnded = false;
      let attemptOutcome:
        Promise<{ error: unknown } | { completed: true }> | undefined;
      // The native client and Query resource belong only to this scenario.
      let outcome:
        Promise<{ error: unknown } | { completed: true }> | undefined;
      let receivedRows = 0;
      let receivedBytes = 0;
      const started = performance.now();
      try {
        await blocker.connect();
        const subscription = z
          .tuple([z.object({ id: z.guid() })])
          .parse(
            (
              await client.query(
                "SELECT id FROM public.usage_pack_subscriptions WHERE org_id = $1",
                ["domain-org"],
              )
            ).rows,
          )[0];
        // COPY uses simple-query protocol and cannot bind values. Interpolate
        // only the actual sole fixture UUID after runtime validation.
        const copySql = `COPY (
          SELECT s.id, ordinal, repeat('x', 8192)
          FROM public.usage_pack_subscriptions s
          CROSS JOIN generate_series(1, 8192) AS ordinal
          WHERE s.id = '${subscription.id}'::uuid
        ) TO STDOUT`;
        const firstRow = `${subscription.id}\t1\t${"x".repeat(8192)}\n`;
        class PausedCopy extends Query<Record<string, unknown>, []> {
          handleCopyData(message: { chunk: unknown }): void {
            try {
              assert.ok(Buffer.isBuffer(message.chunk));
              receivedRows += 1;
              receivedBytes += message.chunk.length;
              if (receivedRows !== 1) return;
              assert.equal(message.chunk.toString("utf8"), firstRow);
              blocker.connection.stream.pause();
              this.emit("firstCopyData", { ready: true });
            } catch (error) {
              this.emit("firstCopyData", { error });
            }
          }
        }
        // One PK-selected subscription, 8192 rows and 8192 bytes of padding
        // per row bound this ordinary ACCESS SHARE read to about 64 MiB.
        const resource = new PausedCopy(copySql);
        outcome = new Promise<{ error: unknown } | { completed: true }>(
          (resolve) => {
            resource.once("error", (error: unknown) => {
              resourceEnded = true;
              resolve({ error });
            });
            resource.once("end", () => {
              resourceEnded = true;
              resolve({ completed: true });
            });
          },
        );
        const firstData = new Promise<{ ready: true } | { error: unknown }>(
          (resolve) => {
            resource.once("firstCopyData", resolve);
          },
        );
        // Every observer precedes submission. All stored outcomes fulfill,
        // including client failures, so setup failure owns early rejection.
        const ready = Promise.race([firstData, outcome, clientFailure]);
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
        if ("error" in first) throw first.error;
        assert.ok("ready" in first, "COPY completed before readiness");
        assert.equal(blocker.connection.stream.isPaused(), true);
        assert.equal(resourceEnded, false);
        const live = await client.query(
          `SELECT a.pid, a.state, a.query, l.mode, l.granted
          FROM pg_stat_activity a JOIN pg_locks l ON l.pid = a.pid
          WHERE a.pid = $1 AND a.datname = current_database()
            AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
            AND l.locktype = 'relation'
            AND l.relation = 'public.usage_pack_subscriptions'::regclass
            AND l.mode = 'AccessShareLock' AND l.granted`,
          [pid],
        );
        assert.deepEqual(live.rows, [
          {
            pid,
            state: "active",
            query: copySql,
            mode: "AccessShareLock",
            granted: true,
          },
        ]);
        console.log(
          "Prepared domain read-only COPY ready:",
          JSON.stringify({
            ...live.rows[0],
            subscriptionId: subscription.id,
            firstRowBytes: Buffer.byteLength(firstRow),
            exactFirstRow: true,
            maximumRows: 8192,
            paddingBytesPerRow: 8192,
          }),
        );
        assert.equal(errors.length, 0);
        const before = await catalog(client);
        attemptOutcome = (async () => {
          await assert.rejects(apply(url), (error: unknown) => {
            assert.ok(error instanceof postgres.PostgresError);
            assert.equal(error.code, "55P03");
            assert.match(error.message, /lock timeout/u);
            console.log(
              "Prepared domain migration rejected:",
              JSON.stringify({
                name: error.name,
                code: error.code,
                message: error.message,
              }),
            );
            return true;
          });
          assert.deepEqual(await catalog(client), before);
        })().then(
          () => {
            return { completed: true as const };
          },
          (error: unknown) => {
            return { error };
          },
        );
        await Promise.race([
          attemptOutcome.then((result) => {
            if ("error" in result) throw result.error;
          }),
          outcome.then((result) => {
            if ("error" in result) throw result.error;
            assert.fail("COPY completed before the migration timeout");
          }),
          clientFailure.then((result) => {
            throw result.error;
          }),
        ]);
        assert.equal(resourceEnded, false);
      } catch (error) {
        errors.push(error);
      } finally {
        if (submitted) {
          let cancellationRequested = false;
          let cancellationDrained = false;
          try {
            if (!resourceEnded) {
              assert.ok(pid !== undefined);
              const cancelled = await client.query(
                "SELECT pg_cancel_backend($1) AS cancelled",
                [pid],
              );
              assert.deepEqual(cancelled.rows, [{ cancelled: true }]);
              cancellationRequested = true;
            }
          } catch (error) {
            errors.push(error);
          }
          // Attempt each release step independently and retain all failures.
          // DROP DATABASE is never used as the resource release mechanism.
          try {
            blocker.connection.stream.resume();
          } catch (error) {
            errors.push(error);
          }
          try {
            assert.ok(outcome);
            const result = await Promise.race([outcome, clientFailure]);
            assert.ok("error" in result, "COPY completed without cancellation");
            const error = result.error;
            if (!(error instanceof DatabaseError) || error.code !== "57014") {
              errors.push(error);
            }
            assert.ok(error instanceof DatabaseError);
            assert.equal(error.code, "57014");
            assert.equal(cancellationRequested, true);
            cancellationDrained = true;
            console.log(
              "Prepared domain COPY drained:",
              JSON.stringify({ pid, code: error.code, message: error.message }),
            );
          } catch (error) {
            errors.push(error);
          }
          try {
            // The same client's query waits for COPY ReadyForQuery and its
            // own idle ACK; a cancellation request alone proves no release.
            const releaseACK = await blocker.query(
              "SELECT pg_backend_pid() AS pid",
            );
            assert.deepEqual(releaseACK.rows, [{ pid }]);
            assert.equal(blocker.getTransactionStatus(), "I");
            console.log(
              "Prepared domain read-only COPY release:",
              JSON.stringify({
                pid,
                cancellationRequested,
                cancellationDrained,
                transactionStatus: blocker.getTransactionStatus(),
                receivedRows,
                receivedBytes,
                elapsedMs: Math.round(performance.now() - started),
              }),
            );
          } catch (error) {
            errors.push(error);
          }
        }
        if (attemptOutcome) {
          const result = await attemptOutcome;
          if ("error" in result && !errors.includes(result.error)) {
            errors.push(result.error);
          }
        }
        try {
          ending = true;
          await blocker.end();
          console.log("Prepared domain COPY client ended");
        } catch (error) {
          errors.push(error);
        }
        client.off("error", onClientError);
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "Prepared domain COPY blocker failed");
      }
    },
  );
  await scenario(
    "audit sees a writer committed while table locks were waiting",
    async (client, url) => {
      const writer = new Client({ connectionString: url });
      const applicationName = `domain_migration_${randomUUID()}`;
      const errors: unknown[] = [];
      let failClient: (result: { error: unknown }) => void = () => {};
      const clientFailure = new Promise<{ error: unknown }>((resolve) => {
        failClient = resolve;
      });
      const onClientError = (error: unknown) => {
        errors.push(error);
        failClient({ error });
      };
      let ending = false;
      let writerClosed = false;
      const onWriterEnd = () => {
        if (!ending) onClientError(new Error("Writer ended before release"));
      };
      const onObserverEnd = () => {
        onClientError(new Error("Observer ended before writer cleanup"));
      };
      client.on("end", onObserverEnd);
      writer.on("error", onClientError);
      writer.on("end", onWriterEnd);
      client.on("error", onClientError);
      class PausedCopy extends Query<Record<string, unknown>, []> {
        paused = false;

        handleCopyData(message: { chunk: unknown }): void {
          if (!this.paused) {
            this.paused = true;
            writer.connection.stream.pause();
            this.emit("firstCopyData", { chunk: message.chunk });
          }
        }
      }
      // Consume every unrestricted UPDATE receipt before the fixed 64 MiB
      // output. Normal COPY completion, never cancellation, commits this write.
      const copySql = `COPY (
  WITH changed AS (
    UPDATE public.usage_pack_pending_snapshot_guards
    SET pending_snapshot_count = 2
    RETURNING org_id, pending_snapshot_count
  ), receipt AS (
    SELECT count(*)::int AS changed_rows,
      min(org_id) AS first_org_id,
      max(org_id) AS last_org_id,
      min(pending_snapshot_count) AS min_count,
      max(pending_snapshot_count) AS max_count
    FROM changed
  )
  SELECT pg_backend_pid() AS writer_pid,
    receipt.changed_rows, receipt.first_org_id, receipt.last_org_id,
    receipt.min_count, receipt.max_count, n.ordinal, repeat('x', 8192)
  FROM receipt
  CROSS JOIN generate_series(1, 8192) AS n(ordinal)
  ORDER BY n.ordinal
) TO STDOUT WITH (FORMAT text);`;
      const resource = new PausedCopy(copySql);
      let resourceEnded = false;
      const outcome = new Promise<{ error: unknown } | { result: unknown }>(
        (resolve) => {
          resource.once("error", (error: unknown) => {
            resourceEnded = true;
            resolve({ error });
          });
          resource.once("end", (result: unknown) => {
            resourceEnded = true;
            resolve({ result });
          });
        },
      );
      const firstData = new Promise<{ chunk: unknown }>((resolve) => {
        resource.once("firstCopyData", resolve);
      });
      const ready = Promise.race([firstData, outcome, clientFailure]);
      const pidSchema = z.number().int().positive().max(2147483647);
      const guardSchema = z.tuple([
        z
          .object({
            org_id: z.literal("domain-org"),
            pending_snapshot_count: z.literal(1),
          })
          .strict(),
      ]);
      const guardsSql = `SELECT org_id, pending_snapshot_count
FROM public.usage_pack_pending_snapshot_guards
ORDER BY org_id;`;
      let pid: number | undefined;
      let submissionAttempted = false;
      let submitted = false;
      let idleAcknowledged = false;
      let writerRolledBack = false;
      let initialData: Awaited<ReturnType<typeof data>> | undefined;
      let waiting: Promise<{ error: unknown } | { observed: true }> | undefined;
      let snapshot:
        | Promise<
            { error: unknown } | { state: Awaited<ReturnType<typeof catalog>> }
          >
        | undefined;
      let attemptOutcome:
        Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
      let attemptEnded = false;
      const started = performance.now();
      async function releaseFailedCopy() {
        let cancellationRequested = false;
        let cancelledWrite = false;
        try {
          if (!resourceEnded) {
            assert.ok(pid !== undefined);
            const cancelled = await client.query(
              "SELECT pg_cancel_backend($1::integer) AS cancelled;",
              [pid],
            );
            cancellationRequested = true;
            assert.equal(cancelled.rowCount, 1);
            assert.deepEqual(cancelled.rows, [{ cancelled: true }]);
          }
        } catch (error) {
          errors.push(error);
        }
        // Each cleanup is independent; a request never proves rollback.
        try {
          writer.connection.stream.resume();
        } catch (error) {
          errors.push(error);
        }
        try {
          const terminal = await Promise.race([outcome, clientFailure]);
          if ("error" in terminal) {
            if (!errors.includes(terminal.error)) errors.push(terminal.error);
            assert.ok(terminal.error instanceof DatabaseError);
            if (cancellationRequested)
              assert.equal(terminal.error.code, "57014");
            cancelledWrite = terminal.error.code === "57014";
            writerRolledBack = true;
            console.log(
              "Prepared domain writer failure terminal:",
              JSON.stringify({
                pid,
                cancellationRequested,
                code: terminal.error.code,
                message: terminal.error.message,
              }),
            );
          } else {
            console.log(
              "Prepared domain writer cleanup observed commit:",
              JSON.stringify(terminal),
            );
            assert.equal(
              cancellationRequested,
              false,
              "Cancellation raced a committed writer; this is not rollback",
            );
          }
        } catch (error) {
          errors.push(error);
        }
        try {
          const ack = await writer.query("SELECT pg_backend_pid() AS pid;");
          assert.equal(ack.rowCount, 1);
          assert.deepEqual(ack.rows, [{ pid }]);
          assert.equal(writer.getTransactionStatus(), "I");
          idleAcknowledged = true;
          console.log(
            "Prepared domain writer cleanup idle:",
            JSON.stringify({
              pid,
              transactionStatus: writer.getTransactionStatus(),
              cancellationRequested,
              cancelledWrite,
            }),
          );
        } catch (error) {
          errors.push(error);
        }
        if (attemptOutcome) {
          const actual = await attemptOutcome;
          console.log("Prepared domain writer cleanup apply:", actual);
        }
      }
      async function settleObservers() {
        if (attemptOutcome) {
          const actual = await attemptOutcome;
          if (!actual.ok && errors.length > 0 && !errors.includes(actual.error))
            errors.push(actual.error);
        }
        if (waiting) {
          const actual = await waiting;
          if ("error" in actual && !errors.includes(actual.error))
            errors.push(actual.error);
        }
        if (snapshot) {
          const actual = await snapshot;
          if ("error" in actual && !errors.includes(actual.error))
            errors.push(actual.error);
        }
        if (errors.length > 0 && submitted && idleAcknowledged && initialData) {
          try {
            const actualData = await data(client);
            console.log(
              "Prepared domain writer cleanup data:",
              JSON.stringify({ writerRolledBack, data: actualData }),
            );
            if (writerRolledBack) assert.deepEqual(actualData, initialData);
          } catch (error) {
            errors.push(error);
          }
        }
      }
      try {
        initialData = await data(client);
        const guards = await client.query(guardsSql);
        assert.equal(guards.rowCount, 1);
        guardSchema.parse(guards.rows);
        const roots = await client.query(`SELECT org_id, subscription_status
FROM public.usage_pack_subscriptions
WHERE subscription_status IN ('checkout_pending', 'purchase_pending')
ORDER BY org_id, subscription_status;`);
        assert.equal(roots.rowCount, 1);
        assert.deepEqual(roots.rows, [
          { org_id: "domain-org", subscription_status: "checkout_pending" },
        ]);
        await writer.connect();
        const backend = await writer.query("SELECT pg_backend_pid() AS pid;");
        assert.equal(backend.rowCount, 1);
        pid = z
          .tuple([z.object({ pid: pidSchema }).strict()])
          .parse(backend.rows)[0].pid;
        submissionAttempted = true;
        assert.equal(writer.query(resource), resource);
        submitted = true;
        const first = await ready;
        if ("error" in first) throw first.error;
        assert.ok("chunk" in first, "COPY ended before writer readiness");
        assert.ok(Buffer.isBuffer(first.chunk));
        const expectedFirst = Buffer.from(
          `${pid}\t1\tdomain-org\tdomain-org\t2\t2\t1\t${"x".repeat(8192)}\n`,
          "utf8",
        );
        assert.deepEqual(first.chunk, expectedFirst);
        assert.equal(writer.connection.stream.isPaused(), true);
        assert.equal(resourceEnded, false);
        assert.equal(errors.length, 0);
        // Read the old committed guard before the exclusive migration queues.
        const oldGuards = await client.query(guardsSql);
        assert.equal(oldGuards.rowCount, 1);
        guardSchema.parse(oldGuards.rows);
        console.log(
          "Prepared domain writer ready:",
          JSON.stringify({
            pid,
            copySql,
            parameters: [],
            firstRow: first.chunk.toString("utf8"),
            oldGuards: oldGuards.rows,
          }),
        );
        attemptOutcome = apply(url, {
          connection: { application_name: applicationName },
        }).then(
          () => {
            attemptEnded = true;
            return { ok: true as const };
          },
          (error: unknown) => {
            attemptEnded = true;
            return { ok: false as const, error };
          },
        );
        const deadline = performance.now() + 1000;
        waiting = (async () => {
          let blocked = false;
          let samples = 0;
          while (!blocked && performance.now() < deadline) {
            const state = await client.query(
              `SELECT m.pid AS migration_pid, w.pid AS writer_pid,
  m.state AS migration_state, m.wait_event_type AS migration_wait_type,
  m.wait_event AS migration_wait, w.state AS writer_state,
  w.wait_event_type AS writer_wait_type, w.wait_event AS writer_wait,
  g.mode AS writer_lock_mode, q.mode AS migration_lock_mode,
  m.query AS migration_query
FROM pg_stat_activity AS m
JOIN pg_stat_activity AS w ON w.pid = $2::integer
JOIN pg_locks AS g ON g.pid = w.pid
  AND g.locktype = 'relation'
  AND g.database = (SELECT oid FROM pg_database WHERE datname = current_database())
  AND g.relation = 'public.usage_pack_pending_snapshot_guards'::regclass
  AND g.mode = 'RowExclusiveLock' AND g.granted
JOIN pg_locks AS q ON q.pid = m.pid
  AND q.locktype = 'relation'
  AND q.database = g.database AND q.relation = g.relation
  AND q.mode = 'AccessExclusiveLock' AND NOT q.granted
WHERE m.application_name = $1::text
  AND m.datname = current_database() AND w.datname = current_database()
  AND m.pid <> w.pid AND m.pid <> pg_backend_pid()
  AND m.state = 'active' AND m.wait_event_type = 'Lock'
  AND m.wait_event = 'relation'
  AND w.state = 'active' AND w.wait_event_type = 'Client'
  AND w.wait_event = 'ClientWrite'
  AND w.pid = ANY (pg_blocking_pids(m.pid))
  AND position('LOCK TABLE public.usage_pack_subscriptions,' IN m.query) > 0;`,
              [applicationName, pid],
            );
            samples += 1;
            assert.ok(state.rowCount === 0 || state.rowCount === 1);
            if (state.rowCount === 1) {
              const receipt = z
                .tuple([
                  z
                    .object({
                      migration_pid: pidSchema,
                      writer_pid: z.literal(pid),
                      migration_state: z.literal("active"),
                      migration_wait_type: z.literal("Lock"),
                      migration_wait: z.literal("relation"),
                      writer_state: z.literal("active"),
                      writer_wait_type: z.literal("Client"),
                      writer_wait: z.literal("ClientWrite"),
                      writer_lock_mode: z.literal("RowExclusiveLock"),
                      migration_lock_mode: z.literal("AccessExclusiveLock"),
                      migration_query: z
                        .string()
                        .includes(
                          "LOCK TABLE public.usage_pack_subscriptions,",
                        ),
                    })
                    .strict(),
                ])
                .parse(state.rows)[0];
              assert.notEqual(receipt.migration_pid, pid);
              blocked = true;
              console.log(
                "Prepared domain writer wait:",
                JSON.stringify({
                  ...receipt,
                  samples,
                  parameters: [applicationName, pid],
                  elapsedMs: performance.now() - started,
                  observationDeadlineMs: 1000,
                  lockTimeout: "1s",
                  statementTimeout: "10s",
                }),
              );
            }
            if (!blocked)
              await new Promise((resolve) => {
                return setTimeout(resolve, 5);
              });
          }
          assert.ok(
            blocked,
            "Observe the actual migration waiting on the writer",
          );
        })().then(
          () => {
            return { observed: true as const };
          },
          (error: unknown) => {
            return { error };
          },
        );
        const earlyCopy = outcome.then((result) => {
          if ("error" in result) throw result.error;
          assert.fail("COPY completed before normal writer release");
        });
        const earlyApply = attemptOutcome.then((result) => {
          if (!result.ok) throw result.error;
          assert.fail("Migration completed before normal writer release");
        });
        const earlyClient = clientFailure.then((result) => {
          throw result.error;
        });
        const observed = await Promise.race([
          waiting,
          earlyCopy,
          earlyApply,
          earlyClient,
        ]);
        if ("error" in observed) throw observed.error;
        // Only catalog/journal reads may run behind the queued exclusive lock.
        snapshot = catalog(client).then(
          (state) => {
            return { state };
          },
          (error: unknown) => {
            return { error };
          },
        );
        const before = await Promise.race([
          snapshot,
          earlyCopy,
          earlyApply,
          earlyClient,
        ]);
        if ("error" in before) throw before.error;
        assert.equal(resourceEnded, false);
        assert.equal(attemptEnded, false);
        assert.equal(errors.length, 0);
        writer.connection.stream.resume();
        const completed = await Promise.race([outcome, clientFailure]);
        if ("error" in completed) throw completed.error;
        const copyResult = z
          .object({ rowCount: z.literal(8192), command: z.literal("COPY") })
          .parse(completed.result);
        const ack = await writer.query("SELECT pg_backend_pid() AS pid;");
        assert.equal(ack.rowCount, 1);
        assert.deepEqual(ack.rows, [{ pid }]);
        assert.equal(writer.getTransactionStatus(), "I");
        idleAcknowledged = true;
        console.log(
          "Prepared domain writer committed:",
          JSON.stringify({
            pid,
            ...copyResult,
            transactionStatus: writer.getTransactionStatus(),
            elapsedMs: performance.now() - started,
          }),
        );
        const result = await attemptOutcome;
        assert.equal(result.ok, false);
        assert.ok(!result.ok);
        assert.ok(result.error instanceof postgres.PostgresError);
        assert.equal(result.error.code, "P0001");
        const prefix = "Prepared domain retirement invariant audit failed: ";
        assert.ok(result.error.message.startsWith(prefix));
        const detail: unknown = JSON.parse(
          result.error.message.slice(prefix.length),
        );
        z.object({
          pending_guard_mismatches: z.literal(1),
          matched_triggers: z.literal(8),
          matched_functions: z.literal(8),
          missing_entitlements: z.literal(0),
          managed_credit_mismatches: z.literal(0),
          oauth_pair_mismatches: z.literal(0),
          oauth_orphans: z.literal(0),
          missing_requested_slugs: z.literal(0),
          deployment_org_mismatches: z.literal(0),
          grandfathered_organizations: z.literal(0),
        }).parse(detail);
        console.log(
          "Prepared domain writer audit rejected:",
          JSON.stringify({
            name: result.error.name,
            code: result.error.code,
            message: result.error.message,
            detail: result.error.detail,
          }),
        );
        const committedGuards = await client.query(guardsSql);
        assert.equal(committedGuards.rowCount, 1);
        assert.deepEqual(committedGuards.rows, [
          { org_id: "domain-org", pending_snapshot_count: 2 },
        ]);
        const expectedData = structuredClone(initialData);
        expectedData[7] = [
          { row: { org_id: "domain-org", pending_snapshot_count: 2 } },
        ];
        assert.deepEqual(await data(client), expectedData);
        assert.deepEqual(await catalog(client), before.state);
        console.log(
          "Prepared domain writer state: guard 2 persisted; only known guard delta across eight tables; original full catalog/journal unchanged",
        );
      } catch (error) {
        errors.push(error);
      } finally {
        // A synchronous submit throw can leave send state uncertain. Inspect
        // only this owned PID before deciding whether a resource was started.
        if (submissionAttempted && !submitted) {
          try {
            const live = await client.query(
              "SELECT state, query FROM pg_stat_activity WHERE pid = $1::integer AND datname = current_database()",
              [pid],
            );
            console.log(
              "Prepared domain writer uncertain submission:",
              JSON.stringify(live.rows),
            );
            submitted = live.rows.some((row: Record<string, unknown>) => {
              return row.query === copySql;
            });
            assert.ok(
              submitted ||
                (live.rows.length === 1 && live.rows[0]?.state === "idle"),
              "Writer submission/release remains unverified",
            );
            if (!submitted) {
              const ack = await writer.query("SELECT pg_backend_pid() AS pid;");
              assert.equal(ack.rowCount, 1);
              assert.deepEqual(ack.rows, [{ pid }]);
              assert.equal(writer.getTransactionStatus(), "I");
              idleAcknowledged = true;
            }
          } catch (error) {
            errors.push(error);
          }
        }
        if (submitted && !idleAcknowledged) {
          await releaseFailedCopy();
        }
        await settleObservers();
        try {
          assert.ok(
            !submissionAttempted || idleAcknowledged,
            "No idle ACK; writer close is not certified safe",
          );
          ending = true;
          await writer.end();
          writerClosed = true;
        } catch (error) {
          errors.push(error);
        }
        if (writerClosed) {
          writer.off("error", onClientError);
          writer.off("end", onWriterEnd);
        }
        client.off("error", onClientError);
        client.off("end", onObserverEnd);
      }
      if (errors.length > 0)
        throw new AggregateError(
          errors,
          "Prepared domain committed writer failed",
        );
    },
  );
  await scenario("stale isolation snapshot rejected", async (client, url) => {
    const before = await catalog(client);
    await assert.rejects(
      apply(url, {
        connection: { default_transaction_isolation: "repeatable read" },
      }),
      /requires read committed/,
    );
    assert.deepEqual(await catalog(client), before);
  });
  await scenario(
    "bounded synthetic load retains the default migration timeouts",
    async (client, url) => {
      await client.query(`
      INSERT INTO org_metadata (org_id, tier)
        SELECT 'scale-' || n, 'free' FROM generate_series(1, 10000) n;
      INSERT INTO usage_pack_subscriptions
        (org_id, tier, stripe_plan_price_id, stripe_customer_id, subscription_status)
        SELECT 'scale-' || n, 'pro', 'scale-price', 'scale-customer-' || n, 'checkout_pending'
        FROM generate_series(1, 10000) n;
      INSERT INTO org_custom_connectors (org_id, slug, display_name, auth_mode, created_by, mcp_endpoint, mcp_transport)
        SELECT 'scale-' || n, '_scale', 'Scale fixture', 'none', 'scale-user', 'https://mcp.example.test', 'streamable-http'
        FROM generate_series(1, 10000) n;
      INSERT INTO hosted_sites (org_id, user_id, slug, public_slug, public_brand)
        SELECT 'scale-' || n, 'scale-user', 'scale', 'scale-' || n, 'okou'
        FROM generate_series(1, 10000) n;
      INSERT INTO hosted_deployments (site_id, org_id, user_id, status, r2_prefix,
        manifest, manifest_hash, content_hash, file_count, size_bytes, url, public_brand)
        SELECT id, org_id, user_id, 'uploading', 'scale', '{}'::jsonb,
          repeat('0',64), repeat('0',64), 0, 0, 'https://scale.invalid', public_brand
        FROM hosted_sites CROSS JOIN generate_series(1, 2) n WHERE org_id LIKE 'scale-%';
      ANALYZE org_metadata; ANALYZE org_plan_entitlements;
      ANALYZE usage_pack_subscriptions; ANALYZE usage_pack_pending_snapshot_guards;
      ANALYZE org_custom_connectors; ANALYZE org_custom_connector_oauth_configs;
      ANALYZE hosted_sites; ANALYZE hosted_deployments;
    `);
      const notices: string[] = [];
      const start = performance.now();
      await apply(url, {
        onnotice: (notice) => {
          if (notice.message !== undefined) {
            notices.push(notice.message);
          }
        },
      });
      const receipt = notices.join("\n");
      assert.match(receipt, /"metadata_rows": 10002/);
      assert.match(receipt, /"subscription_rows": 10001/);
      assert.match(receipt, /"deployment_rows": 20001/);
      assert.match(receipt, /"pending_guard_mismatches": 0/);
      console.log(
        `Synthetic 10000 organizations / pending roots / connectors / sites, 20000 deployments: ${Math.round(performance.now() - start)} ms, default 1s lock / 10s statement limits.`,
      );
    },
  );
} finally {
  process.chdir(originalDirectory);
  await admin.query(`DROP DATABASE IF EXISTS "${template}"`);
  await admin.end();
  await rm(fixture, { recursive: true, force: true });
}
console.log("Prepared domain trigger retirement transition validated");
