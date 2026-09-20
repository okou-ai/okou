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
import { Client } from "pg";
import postgres from "postgres";
import { z } from "zod";
import {
  hostedDeployments,
  hostedSites,
  privateHostedDeployments,
} from "../src/runtime/hosted-site";
import type { HostedSiteManifest } from "../src/jsonb-contracts/hosted-site";
import { applyPendingMigrations } from "./migration-runner";

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
    await applyPendingMigrations(sql);
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

async function rejectUnchanged(pattern: RegExp) {
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
  await locker.connect();
  try {
    await locker.query("BEGIN");
    await locker.query("LOCK TABLE hosted_sites IN ACCESS SHARE MODE");
    await rejectUnchanged(/lock timeout/u);
  } finally {
    await locker.query("ROLLBACK");
    await locker.end();
  }

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
