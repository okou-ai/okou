import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import postgres from "postgres";
import { z } from "zod";
import { archiveSchema, preparationCommit, sha256, tables } from "./format";

const exec = promisify(execFile);
const baseUri = z.string().parse(process.env.DATABASE_URL);
const database = postgres(baseUri, { max: 1, onnotice() {} });
const root = await mkdtemp(path.join(os.tmpdir(), "managed-retirement-test-"));
const sourceName = `managed_source_${randomUUID().replaceAll("-", "")}`;
const restoreName = `managed_restore_${randomUUID().replaceAll("-", "")}`;
const sourceUri = new URL(baseUri);
sourceUri.pathname = `/${sourceName}`;
const restoreUri = new URL(baseUri);
restoreUri.pathname = `/${restoreName}`;
const credentialFile = path.join(root, "source.url");
const restoreCredentialFile = path.join(root, "restore.url");
const archiveDir = path.join(root, "archive");
const approvalFile = path.join(root, "approval.json");
await writeFile(credentialFile, sourceUri.toString(), { mode: 0o600 });
await writeFile(restoreCredentialFile, restoreUri.toString(), { mode: 0o600 });
const cli = path.join(import.meta.dirname, "retire.ts");
const run = async (args: string[]) => {
  return exec(process.execPath, ["--import", "tsx", cli, ...args], {
    env: {
      ...process.env,
      DATABASE_URL_FILE: credentialFile,
      RESTORE_DATABASE_URL_FILE: restoreCredentialFile,
    },
    maxBuffer: 1024 * 1024,
  });
};
let source: postgres.Sql | undefined;
let restore: postgres.Sql | undefined;
try {
  await database.unsafe(`CREATE DATABASE ${sourceName}`);
  await database.unsafe(`CREATE DATABASE ${restoreName}`);
  source = postgres(sourceUri.toString(), { max: 1, onnotice() {} });
  restore = postgres(restoreUri.toString(), { max: 1, onnotice() {} });
  for (const table of tables) {
    const ddl = `CREATE TABLE public.${table} (
      id uuid PRIMARY KEY, org_id text NOT NULL, user_id text NOT NULL,
      status text NOT NULL, credits_charged bigint, reserved_credits bigint,
      max_credits bigint, actual_cost_usd_micros bigint, completed_at timestamp,
      upstream_run_id text, request jsonb, result jsonb,
      created_at timestamp NOT NULL DEFAULT now(), exact_integer bigint
    )`;
    await source.unsafe(ddl);
    await restore.unsafe(ddl);
  }
  await source`CREATE TABLE usage_event (id integer PRIMARY KEY, kind text, provider text,
    status text, processed_at timestamp, credits_charged bigint, billing_error text,
    pricing_unit_price bigint, pricing_unit_size bigint, pricing_credits_limit bigint)`;
  await source`INSERT INTO usage_event VALUES (1,'social','socialkit','processed',now(),105,NULL,NULL,NULL,NULL)`;
  await source`CREATE TABLE org_metadata (org_id text PRIMARY KEY,credits bigint)`;
  await source`INSERT INTO org_metadata VALUES ('owner',9007199254740993)`;
  await source`CREATE TABLE usage_pack_credit_grants (id integer PRIMARY KEY,remaining_amount bigint)`;
  await source`INSERT INTO usage_pack_credit_grants VALUES (1,700)`;
  const unknownId = randomUUID();
  const completedId = randomUUID();
  await source`INSERT INTO data_search_jobs (id,org_id,user_id,status,credits_charged,reserved_credits,max_credits,request,exact_integer)
    VALUES (${unknownId},'owner','user','unknown',NULL,16,16,'{"secret":"private-request"}',9007199254740993)`;
  await source`INSERT INTO data_search_jobs (id,org_id,user_id,status,credits_charged,reserved_credits,max_credits,actual_cost_usd_micros,completed_at)
    VALUES (${completedId},'owner','user','completed',0,0,1,0,now())`;
  await source`INSERT INTO commerce_jobs (id,org_id,user_id,status,credits_charged,request)
    VALUES (${randomUUID()},'owner','user','failed',NULL,'{"signedUrl":"https://private.invalid/?secret=value"}')`;
  await source`INSERT INTO social_data_jobs (id,org_id,user_id,status,credits_charged,completed_at)
    VALUES (${randomUUID()},'owner','user','completed',10,now())`;
  const linkIds = Array.from({ length: 9 }, () => {
    return randomUUID();
  });
  for (const [index, id] of linkIds.entries()) {
    await source`INSERT INTO socialkit_download_jobs (id,org_id,user_id,status,credits_charged)
      VALUES (${id},'owner','user','link_failed',${index === 0 ? 25 : 10})`;
  }
  await source`INSERT INTO socialkit_download_jobs (id,org_id,user_id,status,credits_charged,completed_at)
    VALUES (${randomUUID()},'owner','user','provider_failed',NULL,now()),
    (${randomUUID()},'owner','user','completed',1,now())`;
  const financialBefore = JSON.stringify([
    await source`SELECT to_jsonb(t)::text FROM usage_event t`,
    await source`SELECT to_jsonb(t)::text FROM org_metadata t`,
    await source`SELECT to_jsonb(t)::text FROM usage_pack_credit_grants t`,
  ]);
  const initial = await run([]);
  assert.equal(JSON.parse(initial.stdout).result, "dry-run");
  assert.equal(initial.stdout.includes("private-request"), false);
  assert.equal(initial.stdout.includes("secret=value"), false);
  const archived = await run(["--archive", archiveDir]);
  assert.equal(JSON.parse(archived.stdout).result, "archived");
  const archiveBytes = await readFile(path.join(archiveDir, "archive.json"));
  const archive = archiveSchema.parse(
    JSON.parse(archiveBytes.toString("utf8")),
  );
  assert.ok(
    archive.snapshot.tables[1]?.rows.some((row) => {
      return row.document.includes("9007199254740993");
    }),
  );
  const verified = await run([
    "--verify-restore",
    archiveDir,
    "--expect-restore-host",
    `${restoreUri.hostname}:${restoreUri.port || "5432"}`,
    "--expect-restore-database",
    restoreName,
  ]);
  assert.equal(JSON.parse(verified.stdout).result, "restore-verified");
  assert.equal(
    (
      await restore`SELECT exact_integer::text AS value FROM data_search_jobs WHERE id=${unknownId}`
    )[0]?.value,
    "9007199254740993",
  );
  const approval = {
    archiveSha256: sha256(archiveBytes),
    retainedArchiveUri: "private-test-retention://fixture/archive",
    retainedArchiveSha256: sha256(archiveBytes),
    retainedDumpSha256: archive.dumpSha256,
    retainedCopyVerifiedAt: new Date().toISOString(),
    productionCommit: preparationCommit,
    cutoverAt: new Date(Date.now() - 3_600_000).toISOString(),
    productionProofUrl:
      "https://github.com/okou-ai/okou/actions/runs/40257421225",
    platformAbsorbsUnconfirmedCost: true,
    additionalUserCharge: 0,
    refundOrCompensation: 0,
    unknownJobId: unknownId,
    linkFailedJobIds: linkIds,
  };
  await writeFile(approvalFile, JSON.stringify(approval), { mode: 0o600 });
  const apply = [
    "--migrate",
    "--archive",
    archiveDir,
    "--approval-file",
    approvalFile,
    "--expect-host",
    `${sourceUri.hostname}:${sourceUri.port || "5432"}`,
    "--expect-database",
    sourceName,
  ];
  await source`UPDATE data_search_jobs SET request='{"changed":true}' WHERE id=${unknownId}`;
  await assert.rejects(run(apply), (error: unknown) => {
    return (
      error instanceof Error &&
      "stderr" in error &&
      typeof error.stderr === "string" &&
      error.stderr.includes("SourceRowsChanged")
    );
  });
  assert.equal(
    (
      await source`SELECT count(*)::int AS count FROM socialkit_download_jobs`
    )[0]?.count,
    11,
  );
  await source`UPDATE data_search_jobs SET request='{"secret":"private-request"}' WHERE id=${unknownId}`;
  await writeFile(
    approvalFile,
    JSON.stringify({ ...approval, refundOrCompensation: 105 }),
    { mode: 0o600 },
  );
  await assert.rejects(run(apply));
  await writeFile(approvalFile, JSON.stringify(approval), { mode: 0o600 });
  await source`CREATE TABLE unexpected_retirement_consumer (job_id uuid REFERENCES data_search_jobs(id) ON DELETE CASCADE)`;
  await source`INSERT INTO unexpected_retirement_consumer VALUES (${unknownId})`;
  await assert.rejects(run(apply));
  assert.equal(
    (
      await source`SELECT count(*)::int AS count FROM unexpected_retirement_consumer`
    )[0]?.count,
    1,
  );
  assert.equal(
    (
      await source`SELECT count(*)::int AS count FROM socialkit_download_jobs`
    )[0]?.count,
    11,
  );
  await source`DROP TABLE unexpected_retirement_consumer`;
  const migrated = await run(apply);
  assert.equal(JSON.parse(migrated.stdout).result, "retired");
  for (const table of tables) {
    assert.equal(
      (await source.unsafe(`SELECT count(*)::int AS count FROM ${table}`))[0]
        ?.count,
      0,
    );
  }
  const financialAfter = JSON.stringify([
    await source`SELECT to_jsonb(t)::text FROM usage_event t`,
    await source`SELECT to_jsonb(t)::text FROM org_metadata t`,
    await source`SELECT to_jsonb(t)::text FROM usage_pack_credit_grants t`,
  ]);
  assert.equal(financialAfter, financialBefore);
  assert.equal(JSON.parse((await run(apply)).stdout).result, "already-retired");
  // Simulate a committed deletion whose final receipt was lost. Reconcile only;
  // do not issue another DELETE or invent historical deleted counts.
  await rm(path.join(archiveDir, "retirement-receipt.json"));
  assert.equal(JSON.parse((await run(apply)).stdout).result, "already-retired");
  const reconciliation = JSON.parse(
    await readFile(
      path.join(archiveDir, "retirement-reconciliation.json"),
      "utf8",
    ),
  );
  assert.equal(reconciliation.observedState, "all-four-tables-empty");
  assert.equal(reconciliation.deleted, undefined);
  assert.equal(migrated.stdout.includes("private-request"), false);
  process.stdout.write(
    "Managed Data archive/restore/retirement acceptance passed.\n",
  );
} finally {
  await source?.end();
  await restore?.end();
  await database.unsafe(`DROP DATABASE IF EXISTS ${sourceName}`);
  await database.unsafe(`DROP DATABASE IF EXISTS ${restoreName}`);
  await database.end();
  await rm(root, { recursive: true, force: true });
}
