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
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, text } from "drizzle-orm/pg-core";
import { Client, DatabaseError, Query } from "pg";
import postgres from "postgres";
import { z } from "zod";
import {
  hostedDeploymentColumns,
  hostedSiteColumns,
  privateHostedDeploymentColumns,
} from "../src/columns/hosted-site";
import type { HostedSiteManifest } from "../src/jsonb-contracts/hosted-site";
import { applyFixtureMigrations } from "./fixtures/migrate-with-empty-instructions";

// Runtime mapping at the 1173 frontier. A later migration renamed
// `public_brand` to `link_layout_segment`; this frontier keeps the old name.
function frontierLayoutColumn() {
  return text("public_brand").$type<"okou" | "vm0">().notNull().default("okou");
}
const { linkLayoutSegment: _siteLayout, ...siteColumns } = hostedSiteColumns();
const hostedSites = pgTable("hosted_sites", {
  ...siteColumns,
  publicBrand: frontierLayoutColumn(),
});
const { linkLayoutSegment: _deploymentLayout, ...deploymentColumns } =
  hostedDeploymentColumns(() => {
    return hostedSites.id;
  });
const hostedDeployments = pgTable("hosted_deployments", {
  ...deploymentColumns,
  publicBrand: frontierLayoutColumn(),
});
const { linkLayoutSegment: _privateLayout, ...privateDeploymentColumns } =
  privateHostedDeploymentColumns(() => {
    return hostedSites.id;
  });
const privateHostedDeployments = pgTable("private_hosted_deployments", {
  ...privateDeploymentColumns,
  publicBrand: frontierLayoutColumn(),
});

// Run the shipped A -> B transition in a newly created database, including
// deliberately inconsistent pre-contraction rows that current APIs cannot emit.
const configuredUrl = process.env.DATABASE_URL;
assert.ok(configuredUrl, "DATABASE_URL is required");
const adminUrl = new URL(configuredUrl);
adminUrl.pathname = "/postgres";
const database = `host_contract_${randomUUID().replaceAll("-", "")}`;
const fixtureUrl = new URL(adminUrl);
fixtureUrl.pathname = `/${database}`;
const admin = new Client({ connectionString: adminUrl.toString() });
const client = new Client({ connectionString: fixtureUrl.toString() });
const source = fileURLToPath(new URL("../src/migrations", import.meta.url));
const journal = z
  .object({
    entries: z.array(
      z.object({ idx: z.number(), tag: z.string(), when: z.number() }).loose(),
    ),
  })
  .loose()
  .parse(
    JSON.parse(await readFile(join(source, "meta/_journal.json"), "utf8")),
  );
const target = journal.entries.find((entry) => {
  return entry.tag.endsWith("_retire_hosted_publication_version_columns");
});
assert.ok(target);
const contraction = target;
const fixture = await mkdtemp(join(tmpdir(), "host-contract-"));
const originalDirectory = process.cwd();
const migrations = join(fixture, "src/migrations");

async function frontier(includeContraction: boolean) {
  const entries = journal.entries.filter((entry) => {
    return (
      entry.idx < contraction.idx ||
      (includeContraction && entry.idx === contraction.idx)
    );
  });
  await mkdir(join(migrations, "meta"), { recursive: true });
  for (const entry of entries) {
    await copyFile(
      join(source, `${entry.tag}.sql`),
      join(migrations, `${entry.tag}.sql`),
    );
  }
  await writeFile(
    join(migrations, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries }),
  );
}

async function apply() {
  const sql = postgres(fixtureUrl.toString(), { max: 1, onnotice: () => {} });
  process.chdir(fixture);
  try {
    await applyFixtureMigrations(sql);
  } finally {
    process.chdir(originalDirectory);
    await sql.end();
  }
}

function manifest(
  siteId: string,
  deploymentId: string,
  version: number | null,
): HostedSiteManifest {
  return {
    version: 1,
    deploymentId,
    siteId,
    publicSlug: siteId,
    ...(version === null ? {} : { deploymentVersion: version }),
    createdAt: "2026-09-18T00:00:00.000Z",
    spaFallback: false,
    files: {
      "/index.html": {
        path: "/index.html",
        contentType: "text/html",
        size: 17,
        sha256: "b".repeat(64),
      },
    },
  };
}

async function insertSite(deleted = false) {
  const id = randomUUID();
  const [site] = await drizzle(client)
    .insert(hostedSites)
    .values({
      id,
      orgId: "contract-org",
      userId: "contract-owner",
      publicBrand: "okou",
      slug: id,
      publicSlug: id,
      deletedAt: deleted ? new Date("2026-09-17T00:00:00.000Z") : null,
    })
    .returning();
  assert.ok(site);
  return site;
}

async function insertHistoricalDeployment(args: {
  readonly siteId: string;
  readonly private: boolean;
  readonly status: string;
  readonly version: number | null;
}) {
  const id = randomUUID();
  const table = args.private
    ? "private_hosted_deployments"
    : "hosted_deployments";
  await client.query(
    `INSERT INTO ${table}
    (id, site_id, org_id, user_id, public_brand, status, deployment_version,
     artifact_url, r2_prefix, manifest, manifest_hash, content_hash, file_count, size_bytes, url)
    VALUES ($1, $2, 'contract-org', 'historical-uploader', 'okou', $3, $4,
      $5, $6, $7, $8, $8, 1, 17, $5)`,
    [
      id,
      args.siteId,
      args.status,
      args.version,
      `/artifacts/${id}/index.html`,
      `retained-prefix/${id}`,
      {
        ...manifest(args.siteId, id, args.version),
        ...(args.private ? { access: "owner-private-v1" } : {}),
      },
      "a".repeat(64),
    ],
  );
  return { id, ...args };
}

async function state() {
  return (
    await client.query(`SELECT jsonb_build_object(
    'sites', (SELECT jsonb_agg(to_jsonb(s) - 'next_deployment_version' - 'active_deployment_version' ORDER BY id) FROM hosted_sites s),
    'public', (SELECT jsonb_agg(to_jsonb(d) - 'deployment_version' ORDER BY id) FROM hosted_deployments d),
    'private', (SELECT jsonb_agg(to_jsonb(d) - 'deployment_version' ORDER BY id) FROM private_hosted_deployments d),
    'shares', (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM artifact_shares s),
    'files', (SELECT jsonb_agg(to_jsonb(f) ORDER BY id) FROM run_uploaded_files f)
  ) AS state`)
  ).rows;
}

async function physicalState() {
  return (
    await client.query(`SELECT jsonb_build_object(
    'sites', (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM hosted_sites s),
    'public', (SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM hosted_deployments d),
    'private', (SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM private_hosted_deployments d),
    'columns', (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.attrelid, a.attnum) FROM pg_attribute a
      WHERE a.attrelid IN ('hosted_sites'::regclass, 'hosted_deployments'::regclass, 'private_hosted_deployments'::regclass)),
    'indexes', (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.indexrelid) FROM pg_index i
      WHERE i.indrelid IN ('hosted_sites'::regclass, 'hosted_deployments'::regclass, 'private_hosted_deployments'::regclass)),
    'mirror', (SELECT jsonb_build_object('oid', oid, 'body', prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.mirror_hosted_site_active_version()')),
    'triggers', (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) FROM pg_trigger t WHERE t.tgrelid = 'hosted_sites'::regclass),
    'journal', (SELECT jsonb_agg(to_jsonb(j) ORDER BY id) FROM drizzle.__drizzle_migrations j)
  ) AS state`)
  ).rows;
}

async function rejectUnchanged(
  pattern: RegExp | ((error: unknown) => boolean),
) {
  const before = await physicalState();
  await assert.rejects(apply, pattern);
  assert.deepEqual(await physicalState(), before);
}

async function exerciseRuntime() {
  const db = drizzle(client);
  for (const privatePublication of [false, true]) {
    const site = await insertSite();
    const id = randomUUID();
    const table = privatePublication
      ? privateHostedDeployments
      : hostedDeployments;
    const [deployment] = await db
      .insert(table)
      .values({
        id,
        siteId: site.id,
        orgId: site.orgId,
        userId: site.userId,
        publicBrand: "okou",
        artifactUrl: `/artifacts/${id}/index.html`,
        r2Prefix: `new-prefix/${id}`,
        manifest: {
          ...manifest(site.id, id, 1),
          ...(privatePublication
            ? { access: "owner-private-v1" as const }
            : {}),
        },
        manifestHash: "c".repeat(64),
        contentHash: "d".repeat(64),
        fileCount: 1,
        sizeBytes: 17,
        url: `https://dpl-${id}.okou.app`,
      })
      .returning();
    assert.ok(deployment);
    const [selected] = await db.select().from(table).where(eq(table.id, id));
    assert.deepEqual(selected, deployment);
    if (!privatePublication) {
      const [bound] = await db
        .update(hostedSites)
        .set({ activeDeploymentId: id })
        .where(eq(hostedSites.id, site.id))
        .returning();
      assert.equal(bound?.activeDeploymentId, id);
    }
  }
}

await admin.connect();
try {
  await admin.query(`CREATE DATABASE "${database}"`);
  await frontier(false);
  await apply();
  await client.connect();
  const activeSite = await insertSite();
  const deletedSite = await insertSite(true);
  const historical = [];
  for (const site of [activeSite, deletedSite]) {
    for (const [index, status] of [
      "ready",
      "uploading",
      "failed",
      "deleted",
    ].entries()) {
      for (const isPrivate of [false, true]) {
        historical.push(
          await insertHistoricalDeployment({
            siteId: site.id,
            private: isPrivate,
            status,
            version: index + (isPrivate ? 11 : 1),
          }),
        );
      }
    }
  }
  historical.push(
    await insertHistoricalDeployment({
      siteId: activeSite.id,
      private: false,
      status: "ready",
      version: null,
    }),
  );
  historical.push(
    await insertHistoricalDeployment({
      siteId: activeSite.id,
      private: false,
      status: "ready",
      version: null,
    }),
  );
  const active = historical[0];
  assert.ok(active);
  await client.query(
    `UPDATE hosted_sites SET active_deployment_id = $2 WHERE id = $1`,
    [activeSite.id, active.id],
  );
  await client.query(
    `INSERT INTO artifact_shares (org_id, user_id, public_brand, target_kind, target_id)
    VALUES ('contract-org', 'contract-owner', 'okou', 'html', $1)`,
    [activeSite.id],
  );
  await client.query(
    `INSERT INTO run_uploaded_files (source, external_id, user_id, org_id, metadata)
    VALUES ('web', $1, 'contract-owner', 'contract-org', $2)`,
    [
      randomUUID(),
      {
        artifactKind: "hosted-site",
        siteId: activeSite.id,
        deploymentId: active.id,
        deploymentVersion: 1,
      },
    ],
  );
  await frontier(true);

  await client.query(
    `UPDATE hosted_deployments SET deployment_version = 90 WHERE id = $1`,
    [active.id],
  );
  await rejectUnchanged(/unpreserved version mapping/u);
  await client.query(
    `UPDATE hosted_deployments SET deployment_version = 1 WHERE id = $1`,
    [active.id],
  );
  await client.query(
    `UPDATE hosted_sites SET active_deployment_version = 90 WHERE id = $1`,
    [activeSite.id],
  );
  await rejectUnchanged(/inconsistent public alias/u);
  await client.query(
    `UPDATE hosted_sites SET active_deployment_version = 1 WHERE id = $1`,
    [activeSite.id],
  );

  await client.query(
    `CREATE VIEW public.host_version_dependency AS SELECT deployment_version FROM public.hosted_deployments`,
  );
  await rejectUnchanged(/unexpected column dependency/u);
  await client.query(`DROP VIEW public.host_version_dependency`);
  await client.query(
    `ALTER TABLE hosted_deployments ADD CONSTRAINT host_version_dependency CHECK (deployment_version IS NULL OR deployment_version > 0)`,
  );
  await rejectUnchanged(/unexpected column dependency/u);
  await client.query(
    `ALTER TABLE hosted_deployments DROP CONSTRAINT host_version_dependency`,
  );
  await client.query(`CREATE FUNCTION public.host_version_dependency() RETURNS integer LANGUAGE plpgsql AS $$
    DECLARE result integer; BEGIN SELECT next_deployment_version INTO result FROM public.hosted_sites LIMIT 1; RETURN result; END; $$`);
  await rejectUnchanged(/persisted SQL reference/u);
  await client.query(`DROP FUNCTION public.host_version_dependency()`);

  await client.query(`CREATE FUNCTION public.reject_host_contract_journal() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'host contraction journal failure'; END; $$`);
  await client.query(`CREATE TRIGGER reject_host_contract_journal BEFORE INSERT ON drizzle.__drizzle_migrations
    FOR EACH ROW EXECUTE FUNCTION public.reject_host_contract_journal()`);
  await rejectUnchanged(/host contraction journal failure/u);
  await client.query(
    `DROP TRIGGER reject_host_contract_journal ON drizzle.__drizzle_migrations`,
  );
  await client.query(`DROP FUNCTION public.reject_host_contract_journal()`);

  const locker = new Client({ connectionString: fixtureUrl.toString() });
  const errors: unknown[] = [];
  const onClientError = (error: unknown) => {
    errors.push(error);
  };
  // COPY cannot bind parameters in this simple-query protocol. The only
  // interpolated value is our existing fixture-owned, validated UUID.
  const siteId = z.guid().parse(activeSite.id);
  const copySql = `COPY (
    SELECT s.id, ordinal, repeat('x', 8192)
    FROM public.hosted_sites s
    CROSS JOIN generate_series(1, 8192) AS ordinal
    WHERE s.id = '${siteId}'::uuid
  ) TO STDOUT`;
  const firstRow = `${siteId}\t1\t${"x".repeat(8192)}\n`;
  class PausedCopy extends Query<Record<string, unknown>, []> {
    receivedData = false;

    handleCopyData(message: { chunk: unknown }): void {
      if (this.receivedData) return;
      this.receivedData = true;
      try {
        assert.ok(Buffer.isBuffer(message.chunk));
        assert.equal(message.chunk.toString("utf8"), firstRow);
        locker.connection.stream.pause();
        this.emit("firstCopyData", { ready: true });
      } catch (error) {
        this.emit("firstCopyData", { error });
      }
    }
  }
  // This ordinary read holds ACCESS SHARE against shipped 1173's ACCESS
  // EXCLUSIVE. One site's finite 8192 rows bound padding to ~64 MiB.
  const resource = new PausedCopy(copySql);
  let resourceEnded = false;
  const outcome = new Promise<{ error: unknown } | { completed: true }>(
    (resolveOutcome) => {
      resource.once("error", (error: unknown) => {
        resourceEnded = true;
        resolveOutcome({ error });
      });
      resource.once("end", () => {
        resourceEnded = true;
        resolveOutcome({ completed: true });
      });
    },
  );
  const firstData = new Promise<{ ready: true } | { error: unknown }>(
    (resolveFirst) => {
      resource.once("firstCopyData", resolveFirst);
    },
  );
  // All observers precede submission. Both outcomes fulfill, so even setup
  // failure owns early error/end without an unhandled rejection.
  const ready = Promise.race([firstData, outcome]);
  locker.on("error", onClientError);
  client.on("error", onClientError);
  let pid: number | undefined;
  let submitted = false;
  let attemptOutcome:
    Promise<{ error: unknown } | { completed: true }> | undefined;
  try {
    await locker.connect();
    const backend = await locker.query<{ pid: unknown }>(
      "SELECT pg_backend_pid() AS pid",
    );
    assert.equal(backend.rowCount, 1);
    const value = backend.rows[0]?.pid;
    assert.ok(
      typeof value === "number" && Number.isSafeInteger(value) && value > 0,
    );
    pid = value;
    locker.query(resource);
    submitted = true;
    const first = await ready;
    if ("error" in first) throw first.error;
    assert.ok("ready" in first, "COPY completed before readiness");
    assert.equal(locker.connection.stream.isPaused(), true);
    assert.equal(resourceEnded, false);
    // The COPY connection is busy. Independently prove that this exact PID
    // still executes this COPY and holds the actual conflicting relation lock.
    const live = await client.query(
      `SELECT a.pid, a.state, a.query, l.mode, l.granted
      FROM pg_stat_activity a JOIN pg_locks l ON l.pid = a.pid
      WHERE a.pid = $1 AND a.datname = current_database()
        AND l.locktype = 'relation'
        AND l.relation = 'public.hosted_sites'::regclass
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
      "Read-only COPY ready:",
      JSON.stringify({
        ...live.rows[0],
        firstRowBytes: Buffer.byteLength(firstRow),
        exactFirstRow: true,
      }),
    );
    assert.equal(errors.length, 0);
    attemptOutcome = rejectUnchanged((error: unknown) => {
      assert.ok(error instanceof postgres.PostgresError);
      assert.equal(error.code, "55P03");
      assert.match(error.message, /lock timeout/u);
      return true;
    }).then(
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
      // Attempt every release step independently, retaining primary and
      // cleanup failures. Fixture DROP DATABASE must not release this resource.
      try {
        locker.connection.stream.resume();
      } catch (error) {
        errors.push(error);
      }
      try {
        const result = await outcome;
        assert.ok("error" in result, "COPY completed without cancellation");
        const error = result.error;
        if (!(error instanceof DatabaseError) || error.code !== "57014") {
          errors.push(error);
        }
        assert.ok(error instanceof DatabaseError);
        assert.equal(error.code, "57014");
        assert.equal(cancellationRequested, true);
        cancellationDrained = true;
      } catch (error) {
        errors.push(error);
      }
      try {
        // This query waits for COPY's ReadyForQuery and its own idle ACK.
        const releaseACK = await locker.query("SELECT pg_backend_pid() AS pid");
        assert.deepEqual(releaseACK.rows, [{ pid }]);
        assert.equal(locker.getTransactionStatus(), "I");
        console.log(
          "Read-only COPY release:",
          JSON.stringify({
            pid,
            cancellationRequested,
            cancellationDrained,
            transactionStatus: locker.getTransactionStatus(),
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
      await locker.end();
    } catch (error) {
      errors.push(error);
    }
    client.off("error", onClientError);
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Hosted publication COPY blocker failed");
  }
  console.log(
    "Read-only COPY: migration 55P03; complete physical state unchanged; cancellation and idle release verified",
  );

  const before = await state();
  await apply();
  assert.deepEqual(await state(), before);
  await apply();
  assert.deepEqual(await state(), before);
  for (const deployment of historical) {
    const table = deployment.private
      ? "private_hosted_deployments"
      : "hosted_deployments";
    assert.deepEqual(
      (
        await client.query(
          `SELECT id FROM ${table} WHERE id = $1 AND site_id = $2
      AND (manifest->>'deploymentVersion')::integer IS NOT DISTINCT FROM $3::integer`,
          [deployment.id, deployment.siteId, deployment.version],
        )
      ).rows,
      [{ id: deployment.id }],
    );
  }
  await exerciseRuntime();
  const columns = (
    await client.query(`SELECT attname FROM pg_attribute WHERE NOT attisdropped
    AND attrelid IN ('hosted_sites'::regclass, 'hosted_deployments'::regclass, 'private_hosted_deployments'::regclass)
    AND attname IN ('active_deployment_version', 'next_deployment_version', 'deployment_version')`)
  ).rows;
  assert.deepEqual(columns, []);
  assert.deepEqual(
    (
      await client.query(
        `SELECT to_regprocedure('public.mirror_hosted_site_active_version()')::text AS mirror`,
      )
    ).rows,
    [{ mirror: null }],
  );
  console.log(
    "Hosted publication contraction preserves all history and permissions, rejects drift, rolls back atomically, and supports the phase-A runtime",
  );
} finally {
  await client.end();
  await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin.end();
  await rm(fixture, { recursive: true, force: true });
}
