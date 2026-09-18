import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import postgres from "postgres";
import { z } from "zod";
import { applyPendingMigrations } from "./migration-runner";

// Historical corruption cannot be constructed through today's hosting API.
// This audit's boundary is PostgreSQL; every fixture write targets a fresh,
// test-owned database with current migrations, never the input DATABASE_URL.
const databaseUrl = process.env.DATABASE_URL;
assert.ok(
  databaseUrl,
  "DATABASE_URL is required for a disposable test database",
);
const adminUrl = new URL(databaseUrl);
adminUrl.pathname = "/postgres";
const fixtureUrl = new URL(adminUrl);
const database = `host_history_${randomUUID().replaceAll("-", "")}`;
fixtureUrl.pathname = `/${database}`;
const admin = new Client({ connectionString: adminUrl.toString() });
const writer = new Client({ connectionString: fixtureUrl.toString() });
const auditor = new Client({ connectionString: fixtureUrl.toString() });
const source = await readFile(
  new URL("./audit-hosted-publication-history.sql", import.meta.url),
  "utf8",
);
const queryStart = source.indexOf("WITH deployments AS MATERIALIZED");
assert.ok(queryStart > 0);
const preamble = source.slice(0, queryStart);
const query = source.slice(queryStart, source.lastIndexOf("ROLLBACK;"));
const counts = z.record(z.string(), z.number().int().nonnegative().safe());
const receiptSchema = z.strictObject({
  receipt_version: z.literal("hosted_publication_history_v1"),
  observed_at: z.string(),
  finished_at: z.string(),
  transaction: z.strictObject({
    read_only: z.literal("on"),
    isolation: z.literal("repeatable read"),
    ending: z.literal("rollback"),
    statement_timeout: z.literal("30s"),
    lock_timeout: z.literal("3s"),
  }),
  coverage: z.strictObject({
    all_deployment_statuses: z.literal(true),
    deleted_sites_included: z.literal(true),
    r2_objects_and_aliases_verified: z.literal(false),
    share_policies_verified: z.literal(false),
    catalog_and_chat_references_verified: z.literal(false),
    serving_and_rollback_writers_verified: z.literal(false),
    authorizes_migration_or_deletion: z.literal(false),
  }),
  population: counts,
  multiplicity: counts,
  deployment_integrity: counts,
  pointer_integrity: counts,
  shares: counts,
  uploaded_references: counts,
});
const rowSchema = z.object({ hosted_publication_history_audit: receiptSchema });

async function readReceipt() {
  const rows = z.array(rowSchema).parse((await auditor.query(query)).rows);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.ok(row);
  return row.hosted_publication_history_audit;
}

async function runFile() {
  const results = z
    .array(z.object({ command: z.string(), rows: z.array(z.unknown()) }))
    .parse(await auditor.query(source));
  const selections = results.filter((result) => {
    return result.command === "SELECT";
  });
  assert.equal(selections.length, 1);
  const selection = selections[0];
  assert.ok(selection);
  assert.equal(selection.rows.length, 1);
  return rowSchema.parse(selection.rows[0]).hosted_publication_history_audit;
}

async function state() {
  return (
    await writer.query(`SELECT jsonb_build_object(
      'sites', (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM hosted_sites s),
      'public', (SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM hosted_deployments d),
      'private', (SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM private_hosted_deployments d),
      'shares', (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM artifact_shares s),
      'files', (SELECT jsonb_agg(to_jsonb(f) ORDER BY id) FROM run_uploaded_files f)
    ) AS state`)
  ).rows;
}

async function site(user = "audit-owner", brand = "okou", deleted = false) {
  const id = randomUUID();
  await writer.query(
    `INSERT INTO hosted_sites (id, org_id, user_id, slug, public_slug, public_brand, deleted_at)
      VALUES ($1::uuid, 'audit-org', $2, $1::text, $1::text, $3, CASE WHEN $4 THEN now() ELSE NULL END)`,
    [id, user, brand, deleted],
  );
  return id;
}

async function deployment(args: {
  site: string;
  private: boolean;
  version: number | null;
  status: string;
  immutable?: boolean;
  user?: string;
}) {
  const id = randomUUID();
  const table = args.private
    ? "private_hosted_deployments"
    : "hosted_deployments";
  await writer.query(
    `INSERT INTO ${table}
      (id, site_id, org_id, user_id, public_brand, status, deployment_version,
       artifact_url, r2_prefix, manifest, manifest_hash, content_hash, file_count, size_bytes, url)
      VALUES ($1, $2, 'audit-org', $3, 'okou', $4, $5,
        'private-url-sentinel', 'private-path-sentinel', $6, $7, $7, 1, 10, 'private-url-sentinel')`,
    [
      id,
      args.site,
      args.user ?? "audit-owner",
      args.status,
      args.version,
      JSON.stringify({ version: 1, immutableContent: args.immutable }),
      "a".repeat(64),
    ],
  );
  return id;
}

async function file(metadata: object, user = "audit-owner") {
  await writer.query(
    `INSERT INTO run_uploaded_files (source, external_id, user_id, org_id, metadata)
      VALUES ('web', $1, $2, 'audit-org', $3)`,
    [randomUUID(), user, JSON.stringify(metadata)],
  );
}

await admin.connect();
try {
  await admin.query(`CREATE DATABASE "${database}"`);
  const migration = postgres(fixtureUrl.toString(), {
    max: 1,
    onnotice: () => {},
  });
  try {
    await applyPendingMigrations(migration);
  } finally {
    await migration.end();
  }
  await writer.connect();
  await auditor.connect();
  const mixed = await site();
  const deleted = await site("audit-owner", "okou", true);
  const missingPointer = await site();
  const wrongPointer = await site("other-owner", "vm0");
  const failed = await site();
  const first = await deployment({
    site: mixed,
    private: false,
    version: 1,
    status: "ready",
    immutable: true,
  });
  await deployment({
    site: mixed,
    private: false,
    version: 2,
    status: "uploading",
  });
  await deployment({
    site: mixed,
    private: true,
    version: 3,
    status: "ready",
    immutable: true,
  });
  const legacy = await deployment({
    site: deleted,
    private: false,
    version: null,
    status: "ready",
  });
  await deployment({
    site: deleted,
    private: true,
    version: 1,
    status: "deleted",
  });
  const failure = await deployment({
    site: failed,
    private: true,
    version: 1,
    status: "failed",
    user: "other-owner",
  });
  for (const [siteId, deploymentId, version] of [
    [mixed, first, 1],
    [deleted, legacy, null],
    [missingPointer, randomUUID(), 2],
    [wrongPointer, first, 2],
    [failed, failure, 1],
  ]) {
    await writer.query(
      "UPDATE hosted_sites SET active_deployment_id = $2, active_deployment_version = $3 WHERE id = $1",
      [siteId, deploymentId, version],
    );
  }
  for (const target of [mixed, deleted, randomUUID()]) {
    await writer.query(
      `INSERT INTO artifact_shares (user_id, org_id, public_brand, target_kind, target_id)
        VALUES ('audit-owner', 'audit-org', 'okou', 'html', $1)`,
      [target],
    );
  }
  await file({
    artifactKind: "hosted-site",
    deploymentId: first,
    siteId: mixed,
  });
  await file({
    artifactKind: "presentation-html",
    deploymentId: "not-a-uuid",
    siteId: mixed,
  });
  await file({ generatedBy: "zero-official-website", siteId: mixed });
  await file({ deploymentId: first, siteId: deleted }, "other-owner");
  await file({ artifactKind: "file" });

  const before = await state();
  const receipt = await runFile();
  assert.deepEqual(
    await state(),
    before,
    "The shipped SQL must not mutate any history",
  );
  assert.deepEqual(receipt.population, {
    sites: 5,
    deleted_sites: 1,
    sites_without_deployments: 2,
    deployments: 6,
    public_deployments: 3,
    private_deployments: 3,
    ready_deployments: 3,
    uploading_deployments: 1,
    failed_deployments: 1,
    deleted_deployments: 1,
    unknown_status_deployments: 0,
    null_version_deployments: 1,
    version_one_deployments: 3,
    later_version_deployments: 2,
    nonpositive_version_deployments: 0,
    marked_immutable_deployments: 2,
    unmarked_deployments: 4,
  });
  assert.deepEqual(receipt.multiplicity, {
    multiple_deployment_sites: 2,
    deployments_in_multiple_deployment_sites: 5,
    multiple_ready_deployment_sites: 1,
    multiple_numbered_version_sites: 1,
    mixed_namespace_sites: 2,
    maximum_deployments_per_site: 3,
    duplicate_deployment_ids: 0,
    duplicate_site_version_pairs: 0,
  });
  assert.deepEqual(receipt.deployment_integrity, {
    missing_sites: 0,
    deployments_on_deleted_sites: 2,
    org_mismatches: 0,
    user_mismatches: 1,
    brand_mismatches: 0,
  });
  assert.deepEqual(receipt.pointer_integrity, {
    absent_pointers: 0,
    version_without_pointer: 0,
    missing_targets: 1,
    ambiguous_targets: 0,
    different_site_targets: 1,
    different_owner_targets: 2,
    different_brand_targets: 1,
    not_ready_targets: 1,
    private_targets: 1,
    different_version_targets: 1,
  });
  assert.deepEqual(receipt.shares, {
    html_share_rows: 3,
    missing_site_targets: 1,
    deleted_site_targets: 1,
    org_mismatches: 0,
    user_mismatches: 0,
    brand_mismatches: 0,
  });
  assert.deepEqual(receipt.uploaded_references, {
    hosted_reference_rows: 4,
    absent_deployment_references: 1,
    missing_deployment_targets: 1,
    ambiguous_deployment_targets: 0,
    absent_site_references: 0,
    different_site_targets: 1,
    different_owner_targets: 1,
  });
  const serialized = JSON.stringify(receipt);
  for (const forbidden of [
    mixed,
    first,
    "audit-owner",
    "audit-org",
    "private-url-sentinel",
    "private-path-sentinel",
  ]) {
    assert.ok(
      !serialized.includes(forbidden),
      "The receipt must be aggregate-only",
    );
  }
  console.log(
    "PASS complete mixed and deleted history, unfinished uploads, legacy versions, pointer and reference observations, aggregate-only unchanged state",
  );

  await auditor.query(preamble);
  const snapshot = await readReceipt();
  await site();
  assert.deepEqual((await readReceipt()).population, snapshot.population);
  await assert.rejects(auditor.query("DELETE FROM hosted_sites"), {
    code: "25006",
  });
  await auditor.query("ROLLBACK");
  assert.equal((await runFile()).population.sites, 6);
  console.log(
    "PASS repeatable-read snapshot and enforced read-only transaction",
  );

  await writer.query(
    "ALTER TABLE private_hosted_deployments RENAME TO unavailable_hosted_history",
  );
  try {
    await assert.rejects(runFile(), { code: "42P01" });
  } finally {
    await auditor.query("ROLLBACK");
    await writer.query(
      "ALTER TABLE unavailable_hosted_history RENAME TO private_hosted_deployments",
    );
  }
  console.log(
    "PASS unavailable private history fails instead of reporting zero",
  );
} finally {
  await auditor.end();
  await writer.end();
  await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
  await admin.end();
}
