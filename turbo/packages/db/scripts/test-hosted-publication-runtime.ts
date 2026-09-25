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

// The entire transition runs against one newly created database. The configured
// DATABASE_URL supplies only the connection to create/drop that isolated fixture.
const configuredUrl = process.env.DATABASE_URL;
assert.ok(configuredUrl, "DATABASE_URL is required");
const adminUrl = new URL(configuredUrl);
adminUrl.pathname = "/postgres";
const database = `host_runtime_${randomUUID().replaceAll("-", "")}`;
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
const transition = journal.entries.find((entry) => {
  return entry.tag.endsWith("_hosted_publication_manifest_versions");
});
const defaults = journal.entries.find((entry) => {
  return entry.tag.endsWith("_hosted_publication_runtime_defaults");
});
assert.ok(transition);
assert.ok(defaults);
const transitionEntry = transition;
const defaultsEntry = defaults;
const fixture = await mkdtemp(join(tmpdir(), "host-runtime-"));
const originalDirectory = process.cwd();
const migrations = join(fixture, "src/migrations");

async function frontier(stage: "before" | "transition" | "latest") {
  const entries = journal.entries.filter((entry) => {
    if (stage === "latest") {
      return true;
    }
    return stage === "transition"
      ? entry.idx <= defaultsEntry.idx
      : entry.idx < transitionEntry.idx;
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

function manifest(siteId: string, deploymentId: string): HostedSiteManifest {
  return {
    version: 1,
    deploymentId,
    siteId,
    publicSlug: siteId,
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

async function insertSite() {
  const siteId = randomUUID();
  await client.query(
    `INSERT INTO hosted_sites
      (id, org_id, user_id, public_brand, slug, public_slug, next_deployment_version)
     VALUES ($1::uuid, 'host-runtime-org', 'host-runtime-owner', 'okou', $1::text, $1::text, 27)`,
    [siteId],
  );
  return siteId;
}

async function insertHistoricalDeployment(args: {
  readonly siteId: string;
  readonly private: boolean;
  readonly status: string;
  readonly version: number | null;
  readonly manifestVersion: number | string | null | undefined;
}) {
  const id = randomUUID();
  const table = args.private
    ? "private_hosted_deployments"
    : "hosted_deployments";
  const storedManifest = {
    ...manifest(args.siteId, id),
    ...(args.private ? { access: "owner-private-v1" } : {}),
    ...(args.manifestVersion === undefined
      ? {}
      : { deploymentVersion: args.manifestVersion }),
  };
  await client.query(
    `INSERT INTO ${table}
      (id, site_id, org_id, user_id, public_brand, status, deployment_version,
       artifact_url, r2_prefix, manifest, manifest_hash, content_hash, file_count, size_bytes, url)
     VALUES ($1, $2, 'host-runtime-org', 'historical-uploader', 'okou', $3, $4,
       $5, $6, $7, $8, $9, 1, 17, $5)`,
    [
      id,
      args.siteId,
      args.status,
      args.version,
      `/artifacts/${id}/index.html`,
      `retained-prefix/${id}`,
      storedManifest,
      "a".repeat(64),
      "c".repeat(64),
    ],
  );
  return { id, ...args };
}

async function retainedState(includeMutableManifest: boolean) {
  const deploymentProjection = includeMutableManifest
    ? "to_jsonb(d)"
    : "(to_jsonb(d) - 'manifest' - 'manifest_hash') || jsonb_build_object('files', d.manifest->'files')";
  return (
    await client.query(`SELECT jsonb_build_object(
      'sites', (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM hosted_sites s),
      'public', (SELECT jsonb_agg(${deploymentProjection} ORDER BY id) FROM hosted_deployments d),
      'private', (SELECT jsonb_agg(${deploymentProjection} ORDER BY id) FROM private_hosted_deployments d),
      'shares', (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM artifact_shares s)
    ) AS state`)
  ).rows;
}

async function assertUncommittedTransition() {
  const rows = z
    .array(z.object({ migrations: z.number(), mirror: z.string().nullable() }))
    .parse(
      (
        await client.query(
          `SELECT (SELECT count(*)::integer FROM drizzle.__drizzle_migrations
              WHERE created_at >= $1) AS migrations,
            to_regprocedure('public.mirror_hosted_site_active_version()')::text AS mirror`,
          [transitionEntry.when],
        )
      ).rows,
    );
  assert.deepEqual(rows, [{ migrations: 0, mirror: null }]);
}

// Phase-A API writes at the 1172 frontier. The current ORM names the column
// that 1244 renamed, so this spells out the phase-A statements in SQL.
async function exercisePhaseARuntime() {
  const ids = z.array(z.object({ id: z.string() }));
  const insertSite = async (slug: string) => {
    const [site] = ids.parse(
      (
        await client.query(
          `INSERT INTO hosted_sites (org_id, user_id, public_brand, slug, public_slug)
           VALUES ('host-runtime-org', 'host-runtime-owner', 'okou', $1, $1)
           RETURNING id`,
          [slug],
        )
      ).rows,
    );
    assert.ok(site);
    return site.id;
  };
  const siteId = await insertSite(randomUUID());
  const deploymentId = randomUUID();
  await client.query(
    `INSERT INTO hosted_deployments
      (id, site_id, org_id, user_id, public_brand, manifest, manifest_hash,
       content_hash, r2_prefix, file_count, size_bytes, url)
     VALUES ($1, $2, 'host-runtime-org', 'host-runtime-owner', 'okou', $3,
       $4, $5, $6, 1, 17, $7)`,
    [
      deploymentId,
      siteId,
      { ...manifest(siteId, deploymentId), deploymentVersion: 1 },
      "d".repeat(64),
      "e".repeat(64),
      `retained-prefix/${deploymentId}`,
      `https://dpl-${deploymentId}.okou.app`,
    ],
  );
  const privateId = randomUUID();
  const privateSiteId = await insertSite(privateId);
  // A separate immutable publication may legitimately have the same number.
  await client.query(
    `INSERT INTO private_hosted_deployments
      (id, site_id, org_id, user_id, public_brand, status, artifact_url, r2_prefix,
       manifest, manifest_hash, content_hash, file_count, size_bytes, url)
     SELECT $2, $3, org_id, user_id, public_brand, status, $4, r2_prefix,
       $5, manifest_hash, content_hash, file_count, size_bytes, url
     FROM hosted_deployments WHERE id = $1`,
    [
      deploymentId,
      privateId,
      privateSiteId,
      `/artifacts/${privateId}/index.html`,
      {
        ...manifest(privateSiteId, privateId),
        access: "owner-private-v1",
        deploymentVersion: 1,
      },
    ],
  );
  const bound = z.array(z.object({ active_deployment_id: z.string() })).parse(
    (
      await client.query(
        `UPDATE hosted_sites SET active_deployment_id = $2 WHERE id = $1
           RETURNING active_deployment_id`,
        [siteId, deploymentId],
      )
    ).rows,
  );
  assert.deepEqual(bound, [{ active_deployment_id: deploymentId }]);
  return { siteId, deploymentId, privateId };
}

async function exerciseRuntime() {
  const db = drizzle(client);
  const id = randomUUID();
  const [site] = await db
    .insert(hostedSites)
    .values({
      orgId: "host-runtime-org",
      userId: "host-runtime-owner",
      linkLayoutSegment: "okou",
      slug: id,
      publicSlug: id,
    })
    .returning();
  assert.ok(site);
  const deploymentId = randomUUID();
  const [deployment] = await db
    .insert(hostedDeployments)
    .values({
      id: deploymentId,
      siteId: site.id,
      orgId: site.orgId,
      userId: site.userId,
      linkLayoutSegment: "okou",
      manifest: { ...manifest(site.id, deploymentId), deploymentVersion: 1 },
      manifestHash: "d".repeat(64),
      contentHash: "e".repeat(64),
      r2Prefix: `retained-prefix/${deploymentId}`,
      fileCount: 1,
      sizeBytes: 17,
      url: `https://dpl-${deploymentId}.okou.app`,
    })
    .returning();
  assert.ok(deployment);
  const privateId = randomUUID();
  const [privateSite] = await db
    .insert(hostedSites)
    .values({
      orgId: site.orgId,
      userId: site.userId,
      linkLayoutSegment: "okou",
      slug: privateId,
      publicSlug: privateId,
    })
    .returning();
  assert.ok(privateSite);
  // A separate immutable publication may legitimately have the same number.
  const [privateDeployment] = await db
    .insert(privateHostedDeployments)
    .values({
      ...deployment,
      id: privateId,
      siteId: privateSite.id,
      artifactUrl: `/artifacts/${privateId}/index.html`,
      manifest: {
        ...manifest(privateSite.id, privateId),
        access: "owner-private-v1",
        deploymentVersion: 1,
      },
    })
    .returning();
  assert.ok(privateDeployment);
  const [selected] = await db
    .select()
    .from(privateHostedDeployments)
    .where(eq(privateHostedDeployments.id, privateId));
  assert.deepEqual(selected, privateDeployment);
  const [bound] = await db
    .update(hostedSites)
    .set({ activeDeploymentId: deploymentId })
    .where(eq(hostedSites.id, site.id))
    .returning();
  assert.equal(bound?.activeDeploymentId, deploymentId);
  return { siteId: site.id, deploymentId, privateId };
}

await admin.connect();
try {
  await admin.query(`CREATE DATABASE "${database}"`);
  await frontier("before");
  await apply();
  await client.connect();
  const siteId = await insertSite();
  const historical = [];
  for (const [index, status] of [
    "ready",
    "uploading",
    "failed",
    "deleted",
  ].entries()) {
    for (const isPrivate of [false, true]) {
      const version = index + (isPrivate ? 11 : 1);
      historical.push(
        await insertHistoricalDeployment({
          siteId,
          private: isPrivate,
          status,
          version,
          manifestVersion:
            index === 0 ? version : index === 1 ? undefined : "stale",
        }),
      );
    }
  }
  for (const manifestVersion of [undefined, null, 14]) {
    historical.push(
      await insertHistoricalDeployment({
        siteId,
        private: false,
        status: "ready",
        version: null,
        manifestVersion,
      }),
    );
  }
  const active = historical[0];
  assert.ok(active);
  await client.query(
    `UPDATE hosted_sites SET active_deployment_id = $2, active_deployment_version = 1 WHERE id = $1`,
    [siteId, active.id],
  );
  await client.query(
    `INSERT INTO artifact_shares (org_id, user_id, public_brand, target_kind, target_id)
     VALUES ('host-runtime-org', 'host-runtime-owner', 'okou', 'html', $1)`,
    [siteId],
  );
  await frontier("transition");

  // Refuse to guess which historical alias/version was authoritative.
  await client.query(
    `UPDATE hosted_sites SET active_deployment_version = 99 WHERE id = $1`,
    [siteId],
  );
  const inconsistent = await retainedState(true);
  await assert.rejects(apply, /inconsistent public alias/u);
  assert.deepEqual(await retainedState(true), inconsistent);
  await assertUncommittedTransition();
  await client.query(
    `UPDATE hosted_sites SET active_deployment_version = 1 WHERE id = $1`,
    [siteId],
  );

  // A failed migration journal write must also roll back normalized manifests.
  await client.query(`CREATE FUNCTION public.reject_host_runtime_journal()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'host runtime journal failure';
    END; $$`);
  await client.query(`CREATE TRIGGER reject_host_runtime_journal
    BEFORE INSERT ON drizzle.__drizzle_migrations FOR EACH ROW
    EXECUTE FUNCTION public.reject_host_runtime_journal()`);
  const beforeJournalFailure = await retainedState(true);
  await assert.rejects(apply, /host runtime journal failure/u);
  assert.deepEqual(await retainedState(true), beforeJournalFailure);
  await assertUncommittedTransition();
  await client.query(
    `DROP TRIGGER reject_host_runtime_journal ON drizzle.__drizzle_migrations`,
  );
  await client.query(`DROP FUNCTION public.reject_host_runtime_journal()`);

  // The production runner's one-second lock limit bounds a contended rollout.
  const locker = new Client({ connectionString: fixtureUrl.toString() });
  await locker.connect();
  try {
    await locker.query("BEGIN");
    await locker.query("LOCK TABLE hosted_sites IN ROW EXCLUSIVE MODE");
    await assert.rejects(apply, /lock timeout/u);
    assert.deepEqual(await retainedState(true), beforeJournalFailure);
    await assertUncommittedTransition();
  } finally {
    await locker.query("ROLLBACK");
    await locker.end();
  }

  const preserved = await retainedState(false);
  await apply();
  assert.deepEqual(await retainedState(false), preserved);
  for (const deployment of historical) {
    const table = deployment.private
      ? "private_hosted_deployments"
      : "hosted_deployments";
    const rows = z
      .array(
        z.object({
          manifest: z.record(z.string(), z.unknown()),
          manifest_hash: z.string(),
        }),
      )
      .parse(
        (
          await client.query(
            `SELECT manifest, manifest_hash FROM ${table} WHERE id = $1`,
            [deployment.id],
          )
        ).rows,
      );
    const row = rows[0];
    assert.ok(row);
    assert.equal(
      row.manifest.deploymentVersion,
      deployment.version ?? undefined,
    );
    const changed =
      deployment.version === null
        ? deployment.manifestVersion !== undefined
        : deployment.manifestVersion !== deployment.version;
    assert.equal(row.manifest_hash === "a".repeat(64), !changed);
  }
  const normalized = await retainedState(true);
  await apply();
  assert.deepEqual(await retainedState(true), normalized);

  const current = await exercisePhaseARuntime();
  const compatibility = z
    .array(
      z.object({
        next: z.number(),
        active: z.number(),
        deployment: z.number(),
      }),
    )
    .parse(
      (
        await client.query(
          `SELECT s.next_deployment_version AS next,
      s.active_deployment_version AS active, d.deployment_version AS deployment
      FROM hosted_sites s JOIN hosted_deployments d ON d.id = s.active_deployment_id
      WHERE s.id = $1`,
          [current.siteId],
        )
      ).rows,
    );
  assert.deepEqual(compatibility, [{ next: 2, active: 1, deployment: 1 }]);

  // The preceding API can still allocate and read a historical same-site upload.
  await client.query(
    `UPDATE hosted_sites SET next_deployment_version = next_deployment_version + 1
    WHERE id = $1 RETURNING next_deployment_version - 1`,
    [current.siteId],
  );
  const oldWriter = await insertHistoricalDeployment({
    siteId: current.siteId,
    private: false,
    status: "ready",
    version: 2,
    manifestVersion: 2,
  });
  await client.query(
    `UPDATE hosted_sites SET active_deployment_id = $2 WHERE id = $1`,
    [current.siteId, oldWriter.id],
  );
  assert.deepEqual(
    (
      await client.query(
        `SELECT active_deployment_id, active_deployment_version, next_deployment_version
    FROM hosted_sites WHERE id = $1`,
        [current.siteId],
      )
    ).rows,
    [
      {
        active_deployment_id: oldWriter.id,
        active_deployment_version: 2,
        next_deployment_version: 3,
      },
    ],
  );
  await assert.rejects(
    client.query(
      `UPDATE hosted_sites SET active_deployment_id = $2 WHERE id = $1`,
      [current.siteId, current.privateId],
    ),
    /query returned no rows/u,
  );
  await client.query(
    `UPDATE hosted_sites SET active_deployment_id = NULL WHERE id = $1`,
    [current.siteId],
  );
  assert.deepEqual(
    (
      await client.query(
        `SELECT active_deployment_version FROM hosted_sites WHERE id = $1`,
        [current.siteId],
      )
    ).rows,
    [{ active_deployment_version: null }],
  );

  // Apply every later migration, including the phase-B contraction and the
  // link-layout rename, then repeat real INSERT/SELECT/RETURNING statements.
  // This proves the current runtime has no hidden ORM column dependency.
  await frontier("latest");
  await apply();
  await exerciseRuntime();
  console.log(
    "Hosted publication normalization, preserved history, mixed writers, rollback, and contracted-schema runtime passed",
  );
} finally {
  await client.end();
  await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin.end();
  await rm(fixture, { recursive: true, force: true });
}
