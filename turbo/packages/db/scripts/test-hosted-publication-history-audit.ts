import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "pg";
import postgres from "postgres";
import { z } from "zod";
import { applyPendingMigrations } from "./migration-runner";

// Exercise the shipped psql interface on a newly migrated, disposable database.
// No historical business rows are fabricated: empty populations test the receipt
// and session safety, not mixed/deleted/corrupt historical population coverage.
// The audit requires the existing hosting/share/upload relations and the 1255
// link_layout_segment rename; missing historical prerequisites must fail.
const databaseUrl = process.env.DATABASE_URL;
assert.ok(
  databaseUrl,
  "DATABASE_URL is required for a disposable test database",
);
const adminUrl = new URL(databaseUrl);
adminUrl.pathname = "/postgres";
const fixtureUrl = new URL(adminUrl);
const suffix = randomUUID().replaceAll("-", "");
const database = `host_history_${suffix}`;
const role = `host_history_reader_${suffix}`;
fixtureUrl.pathname = `/${database}`;
const admin = new Client({ connectionString: adminUrl.toString() });
const writer = new Client({ connectionString: fixtureUrl.toString() });
const auditFile = fileURLToPath(
  new URL("./audit-hosted-publication-history.sql", import.meta.url),
);
const execute = promisify(execFile);
const processResultSchema = z.object({
  code: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
});
const counts = z.record(z.string(), z.number().int().nonnegative().safe());
const receiptSchema = z.strictObject({
  receipt_version: z.literal("hosted_publication_history_v3"),
  observed_at: z.iso.datetime({ offset: true }),
  finished_at: z.iso.datetime({ offset: true }),
  transaction: z.strictObject({
    read_only: z.literal("on"),
    isolation: z.literal("repeatable read"),
    ending: z.literal("implicit_commit"),
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

async function runAudit(commands: readonly string[] = [], asReader = false) {
  // psql -f sends each statement separately in its own autocommit transaction.
  // A single driver query(source) would start before the defaults take effect.
  const url = new URL(fixtureUrl);
  url.searchParams.set(
    "options",
    "-c default_transaction_read_only=off -c default_transaction_isolation=serializable -c row_security=on -c timezone=America/New_York -c search_path=pg_catalog",
  );
  // libpq URI options require percent-encoded spaces, not form-encoded +.
  url.search = url.searchParams.toString().replaceAll("+", "%20");
  const args = [
    "--dbname",
    url.toString(),
    "-X",
    "-q",
    "-A",
    "-t",
    "-v",
    "ON_ERROR_STOP=1",
    "-v",
    "VERBOSITY=verbose",
  ];
  if (asReader) {
    args.push("-c", `SET ROLE "${role}"`);
  }
  args.push("-f", auditFile);
  for (const command of commands) {
    args.push("-c", command);
  }
  try {
    const result = await execute("psql", args, {
      env: process.env,
    });
    return { code: 0, ...result };
  } catch (error) {
    const parsed = processResultSchema.safeParse(error);
    if (!parsed.success) {
      throw error;
    }
    return parsed.data;
  }
}

function receiptFrom(stdout: string) {
  const lines = stdout.trim().split("\n");
  assert.equal(
    lines.length,
    1,
    "The audit must emit exactly one aggregate receipt",
  );
  const [line] = lines;
  assert.ok(line);
  const receipt = receiptSchema.parse(JSON.parse(line));
  assert.ok(Date.parse(receipt.finished_at) >= Date.parse(receipt.observed_at));
  return receipt;
}

let roleCreated = false;
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
  const result = await runAudit();
  assert.equal(result.code, 0, result.stderr);
  const receipt = receiptFrom(result.stdout);
  for (const section of [
    receipt.population,
    receipt.multiplicity,
    receipt.deployment_integrity,
    receipt.pointer_integrity,
    receipt.shares,
    receipt.uploaded_references,
  ]) {
    assert.ok(Object.keys(section).length > 0);
    for (const value of Object.values(section)) {
      assert.equal(value, 0);
    }
  }
  console.log(
    "PASS shipped psql file, aggregate receipt, clocks and empty migrated populations (not historical population coverage)",
  );

  const settings = await runAudit([
    `SELECT jsonb_build_object(
    'read_only', current_setting('transaction_read_only'),
    'isolation', current_setting('transaction_isolation'),
    'statement_timeout', current_setting('statement_timeout'),
    'lock_timeout', current_setting('lock_timeout'),
    'idle_timeout', current_setting('idle_in_transaction_session_timeout'),
    'work_mem', current_setting('work_mem'),
    'parallel_workers', current_setting('max_parallel_workers_per_gather'),
    'jit', current_setting('jit'), 'row_security', current_setting('row_security'),
    'timezone', current_setting('timezone'), 'search_path', current_setting('search_path'))`,
  ]);
  assert.equal(settings.code, 0, settings.stderr);
  const lines = settings.stdout.trim().split("\n");
  assert.equal(lines.length, 2);
  const [receiptLine, settingsLine] = lines;
  assert.ok(receiptLine);
  assert.ok(settingsLine);
  receiptFrom(receiptLine);
  assert.deepEqual(JSON.parse(settingsLine), {
    read_only: "on",
    isolation: "repeatable read",
    statement_timeout: "30s",
    lock_timeout: "3s",
    idle_timeout: "15s",
    work_mem: "16MB",
    parallel_workers: "0",
    jit: "off",
    row_security: "off",
    timezone: "UTC",
    search_path: "pg_catalog, public",
  });
  for (const command of [
    "DELETE FROM public.hosted_sites",
    "CREATE TABLE forbidden_audit_write (id integer)",
    "SELECT * FROM public.hosted_sites FOR UPDATE",
  ]) {
    const rejected = await runAudit([command, "SELECT 'must not execute'"]);
    assert.equal(rejected.code, 1, rejected.stderr);
    assert.match(rejected.stderr, /25006/);
    receiptFrom(rejected.stdout);
  }
  console.log(
    "PASS effective read settings override startup defaults; DML, DDL and row write locks fail with no later command",
  );

  await writer.query(`CREATE ROLE "${role}" NOLOGIN`);
  roleCreated = true;
  await writer.query(`GRANT SELECT ON public.hosted_sites, public.hosted_deployments,
    public.private_hosted_deployments, public.artifact_shares, public.run_uploaded_files TO "${role}"`);
  const reader = await runAudit([], true);
  assert.equal(reader.code, 0, reader.stderr);
  receiptFrom(reader.stdout);
  await writer.query(
    "ALTER TABLE public.hosted_sites ENABLE ROW LEVEL SECURITY",
  );
  try {
    const rejected = await runAudit([], true);
    assert.equal(rejected.code, 3, rejected.stderr);
    assert.match(rejected.stderr, /42501/);
    assert.match(rejected.stderr, /row-level security/);
    assert.equal(rejected.stdout, "");
  } finally {
    await writer.query(
      "ALTER TABLE public.hosted_sites DISABLE ROW LEVEL SECURITY",
    );
  }
  console.log(
    "PASS unfiltered census fails for an RLS-subject reader instead of hiding rows",
  );

  await writer.query(
    "ALTER TABLE public.private_hosted_deployments RENAME TO unavailable_hosted_history",
  );
  try {
    const rejected = await runAudit();
    assert.equal(rejected.code, 3, rejected.stderr);
    assert.match(rejected.stderr, /42P01/);
    assert.equal(rejected.stdout, "");
  } finally {
    await writer.query(
      "ALTER TABLE public.unavailable_hosted_history RENAME TO private_hosted_deployments",
    );
  }
  const after = await runAudit();
  assert.equal(after.code, 0, after.stderr);
  const {
    observed_at: _observed,
    finished_at: _finished,
    ...unchanged
  } = receiptFrom(after.stdout);
  const {
    observed_at: _beforeObserved,
    finished_at: _beforeFinished,
    ...before
  } = receipt;
  assert.deepEqual(unchanged, before);
  console.log(
    "PASS unavailable history fails without a receipt; fresh sessions recover and leave history unchanged",
  );
} finally {
  if (roleCreated) {
    await writer.query(`DROP OWNED BY "${role}"`);
    await writer.query(`DROP ROLE "${role}"`);
  }
  await writer.end();
  // DROP without FORCE also proves every awaited psql process closed its session,
  // on successful and failed audits. No settings leak into a reusable client.
  await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
  await admin.end();
}
