import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { Client } from "pg";
import postgres from "postgres";
import { z } from "zod";
import { applyPendingMigrations } from "./migration-runner";

// This tool's public boundary is PostgreSQL/psql. Corrupt historical fixtures
// cannot be created through the API. All writes use a fresh test-owned database
// with the real current migrations, never the database named by DATABASE_URL.
const databaseUrl = process.env.DATABASE_URL;
assert.ok(
  databaseUrl,
  "DATABASE_URL is required for a disposable test database",
);
const adminUrl = new URL(databaseUrl);
adminUrl.pathname = "/postgres";
const fixtureUrl = new URL(adminUrl);
const database = `history_audit_${randomUUID().replaceAll("-", "")}`;
fixtureUrl.pathname = `/${database}`;
const admin = new Client({ connectionString: adminUrl.toString() });
const writer = new Client({ connectionString: fixtureUrl.toString() });
const auditor = new Client({ connectionString: fixtureUrl.toString() });
const path = new URL(
  "./audit-historical-session-blob-references.sql",
  import.meta.url,
);
const source = await readFile(path, "utf8");
const queryStart = source.indexOf("WITH parameters AS MATERIALIZED");
assert.ok(queryStart > 0);
const preamble = source.slice(0, queryStart);
const query = source.slice(queryStart, source.lastIndexOf("ROLLBACK;"));
const counts = z.record(z.string(), z.number().int());
const receiptSchema = z.strictObject({
  receipt_version: z.literal("historical_session_blob_references_v1"),
  inventory_revision: z.string().regex(/^[0-9a-f]{40}$/),
  scope: z.string(),
  observed_at: z.string(),
  finished_at: z.string(),
  statement_elapsed_ms: z.number().nonnegative(),
  server_version: z.string(),
  transaction: z.strictObject({
    read_only: z.literal("on"),
    isolation: z.literal("repeatable read"),
    started_at: z.string(),
    ending: z.literal("rollback"),
    statement_timeout: z.literal("30s"),
    lock_timeout: z.literal("3s"),
    idle_timeout: z.literal("15s"),
    work_mem: z.literal("16MB"),
    hash_mem_multiplier: z.literal("2"),
    parallel_workers: z.literal("0"),
    row_security: z.literal("off"),
  }),
  cutoffs: z.strictObject({
    timezone: z.literal("UTC"),
    recent_window_hours: z.literal(24),
    recent_observation_cutoff: z.string(),
    old_candidate_b_cutoff: z.literal("2026-09-14T01:11:38"),
    validated: z.literal(true),
  }),
  assumptions: z.strictObject({
    persisted_owners: z.tuple([
      z.literal("conversations"),
      z.literal("pi_memory_stage1_candidates"),
    ]),
    catalog_matches_inventory: z.boolean(),
    current_writer_and_rollout_revalidation_required: z.literal(true),
    out_of_repository_writers_verified: z.literal(false),
    object_existence_verified: z.literal(false),
    counter_mutation_timestamps_available: z.literal(false),
    conversation_hash_replacement_timestamps_available: z.literal(false),
    differences_authorize_repair: z.literal(false),
  }),
  population: counts,
  reconciliation: counts,
  conversations: counts,
  candidate_only: counts,
  catalog: counts,
});

async function readReceipt() {
  const rows = z
    .array(z.object({ historical_session_blob_reference_audit: receiptSchema }))
    .parse((await auditor.query(query)).rows);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.ok(row);
  return row.historical_session_blob_reference_audit;
}

async function runFile() {
  const result = await promisify(execFile)("psql", [
    "-X",
    "--no-password",
    "--set",
    "ON_ERROR_STOP=1",
    "--quiet",
    "--tuples-only",
    "--no-align",
    "--dbname",
    fixtureUrl.toString(),
    "--file",
    path.pathname,
  ]);
  assert.equal(result.stderr, "");
  return receiptSchema.parse(JSON.parse(result.stdout));
}

async function state() {
  return (
    await writer.query(`SELECT jsonb_build_object(
    'blobs', (SELECT jsonb_agg(to_jsonb(b) ORDER BY hash) FROM blobs b),
    'conversations', (SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM conversations c),
    'candidates', (SELECT jsonb_agg(to_jsonb(c) ORDER BY pi_session_id) FROM pi_memory_stage1_candidates c),
    'runs', (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM agent_runs r),
    'sessions', (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM agent_sessions s),
    'storages', (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM storages s),
    'versions', (SELECT jsonb_agg(to_jsonb(v) ORDER BY id) FROM storage_versions v),
    'checkpoints', (SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM checkpoints c),
    'selections', (SELECT jsonb_agg(to_jsonb(s) ORDER BY user_id, slot) FROM pi_memory_stage1_selections s),
    'constraints', (SELECT jsonb_agg(to_jsonb(c) ORDER BY oid) FROM pg_constraint c),
    'triggers', (SELECT jsonb_agg(to_jsonb(t) ORDER BY oid) FROM pg_trigger t)
  ) AS state`)
  ).rows;
}

function hash(index: number) {
  return index.toString(16).padStart(64, "0");
}
const session = randomUUID();
const storage = randomUUID();

async function conversation(
  index: number | null,
  inline: string | null = null,
) {
  const run = randomUUID();
  await writer.query(
    `INSERT INTO agent_runs (id, session_id, org_id, user_id, prompt, status)
    VALUES ($1, $2, 'audit-org', 'audit-user', 'synthetic', 'completed')`,
    [run, session],
  );
  await writer.query(
    `INSERT INTO conversations
    (run_id, cli_agent_type, cli_agent_session_id, cli_agent_session_history_hash,
     cli_agent_session_history, created_at)
    VALUES ($1, 'pi', $2, $3, $4, '2026-09-10')`,
    [run, randomUUID(), index === null ? null : hash(index), inline],
  );
}

async function candidate(index: number, createdAt = "2026-09-10") {
  await writer.query(
    `INSERT INTO pi_memory_stage1_candidates
    (memory_storage_id, org_id, user_id, pi_session_id, source_run_id, source_history_hash,
     source_completed_at, eligible_at, created_at, updated_at, status, last_error_class)
    VALUES ($1, 'audit-org', 'audit-user', $2, $3, $4, $5, $5, $5, $5,
      'terminal_failure', 'synthetic')`,
    [storage, randomUUID(), randomUUID(), hash(index), createdAt],
  );
}

async function seedScale() {
  await writer.query(`TRUNCATE agents, storages, blobs CASCADE;
    INSERT INTO agents (id, org_id, owner, name)
      VALUES ('${session}', 'audit-org', 'audit-user', 'synthetic');
    INSERT INTO agent_sessions (id, agent_id, org_id, user_id)
      SELECT md5('session-' || i)::uuid, '${session}', 'audit-org', 'audit-user'
      FROM generate_series(1, 71876) i;
    INSERT INTO agent_runs (id, session_id, org_id, user_id, prompt, status)
      SELECT md5('run-' || i)::uuid, md5('session-' || (1 + (i - 1) % 71876))::uuid,
        'audit-org', 'audit-user', repeat('synthetic ', 30), 'completed'
      FROM generate_series(1, 282658) i;
    INSERT INTO blobs (hash, ref_count, raw_size, encoding, encoded_size, created_at)
      SELECT lpad(to_hex(i), 64, '0'), CASE WHEN i <= 278538 THEN 1 ELSE 0 END,
        1024, 'identity', 1024, '2026-09-10'
      FROM generate_series(1, 313033) i;
    INSERT INTO conversations
      (id, run_id, cli_agent_type, cli_agent_session_id, cli_agent_session_history_hash, created_at)
      SELECT md5('conversation-' || i)::uuid, md5('run-' || i)::uuid, 'pi',
        md5('cli-' || i), lpad(to_hex(i), 64, '0'), '2026-09-10'
      FROM generate_series(1, 277197) i;
    INSERT INTO checkpoints (run_id, conversation_id, storage_mounts)
      SELECT run_id, id, '[]'::jsonb FROM conversations;
    UPDATE agent_sessions SET conversation_id = md5('conversation-' || i)::uuid
      FROM generate_series(1, 71876) i WHERE id = md5('session-' || i)::uuid;
    INSERT INTO storages (id, org_id, user_id, name, s3_prefix)
      SELECT md5('storage-' || i)::uuid, 'audit-org', 'audit-user-' || i, 'memory',
        'synthetic/' || i FROM generate_series(1, 18194) i;
    INSERT INTO storage_versions (id, storage_id, s3_key, archive_size, created_by)
      SELECT lpad(to_hex(i), 64, '0'), md5('storage-' || (1 + (i - 1) % 18194))::uuid,
        'synthetic/archive-' || i, 1024, 'audit-user'
      FROM generate_series(1, 33068) i;
    INSERT INTO pi_memory_stage1_candidates
      (memory_storage_id, org_id, user_id, pi_session_id, source_run_id, source_history_hash,
       source_completed_at, eligible_at, created_at, updated_at)
      SELECT md5('storage-' || i)::uuid, 'audit-org', 'audit-user-' || i, md5('candidate-' || i),
        md5('run-' || i)::uuid, lpad(to_hex(277197 + i), 64, '0'),
        '2026-09-10', '2026-09-10', '2026-09-10', '2026-09-10'
      FROM generate_series(1, 1341) i;
    ANALYZE blobs; ANALYZE conversations; ANALYZE pi_memory_stage1_candidates;
    ANALYZE storages; ANALYZE agent_runs; ANALYZE agent_sessions; ANALYZE storage_versions;`);
}

async function measurePlan() {
  await auditor.query(preamble);
  try {
    const result = await auditor.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`,
    );
    // Keep plan evidence aggregate-only too: no conditions, identifiers or SQL.
    const planSchema: z.ZodType<PlanNode> = z.lazy(() => {
      return z.object({
        "Node Type": z.string(),
        "Relation Name": z.string().optional(),
        "Index Name": z.string().optional(),
        "Actual Rows": z.number(),
        "Actual Loops": z.number(),
        "Shared Hit Blocks": z.number(),
        "Shared Read Blocks": z.number(),
        "Temp Read Blocks": z.number(),
        "Temp Written Blocks": z.number(),
        "Peak Memory Usage": z.number().optional(),
        "Sort Space Used": z.number().optional(),
        "Sort Space Type": z.string().optional(),
        "Hash Batches": z.number().optional(),
        "HashAgg Batches": z.number().optional(),
        Plans: z.array(planSchema).optional(),
      });
    });
    const parsed = z
      .array(
        z.object({
          "QUERY PLAN": z.array(
            z.object({
              Plan: planSchema,
              "Planning Time": z.number(),
              "Execution Time": z.number(),
            }),
          ),
        }),
      )
      .parse(result.rows);
    const plan = parsed[0]?.["QUERY PLAN"][0];
    assert.ok(plan);
    console.log(
      JSON.stringify({ evidence: "synthetic_current_scale_plan", ...plan }),
    );
    const receipt = await readReceipt();
    assert.equal(receipt.population.blob_rows, 313033);
    assert.equal(receipt.population.conversation_references, 277197);
    assert.equal(receipt.population.candidate_references, 1341);
    assert.equal(receipt.reconciliation.balanced_owned_hashes, 278538);
    assert.equal(receipt.reconciliation.unowned_zero_count_metadata, 34495);
    assert.equal(receipt.reconciliation.all_excess_hashes, 0);
    console.log(
      JSON.stringify({ evidence: "synthetic_current_scale_receipt", receipt }),
    );
  } finally {
    await auditor.query("ROLLBACK");
  }
}

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Actual Rows": number;
  "Actual Loops": number;
  "Shared Hit Blocks": number;
  "Shared Read Blocks": number;
  "Temp Read Blocks": number;
  "Temp Written Blocks": number;
  "Peak Memory Usage"?: number;
  "Sort Space Used"?: number;
  "Sort Space Type"?: string;
  "Hash Batches"?: number;
  "HashAgg Batches"?: number;
  Plans?: PlanNode[];
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
  await writer.query(`INSERT INTO agents (id, org_id, owner, name)
    VALUES ('${session}', 'audit-org', 'audit-user', 'synthetic');
    INSERT INTO agent_sessions (id, agent_id, org_id, user_id)
    VALUES ('${session}', '${session}', 'audit-org', 'audit-user');
    INSERT INTO storages (id, org_id, user_id, name, s3_prefix)
    VALUES ('${storage}', 'audit-org', 'audit-user', 'memory', 'synthetic');`);
  for (const [index, refs] of [
    [1, 5],
    [2, 1],
    [4, -1],
    [5, 0],
    [6, 3],
    [7, 2],
    [8, 2],
    [9, 2],
    [10, 0],
    [11, 1],
  ]) {
    assert.ok(index !== undefined && refs !== undefined);
    await writer.query(
      `INSERT INTO blobs (hash, ref_count, raw_size, encoding, encoded_size, created_at)
      VALUES ($1, $2, 1, 'identity', 1, $3)`,
      [
        hash(index),
        refs,
        index === 10 ? new Date() : index === 11 ? "-infinity" : "2026-09-10",
      ],
    );
  }
  for (const index of [1, 1, 2, 2, 2, 3, 3, 4, 7]) await conversation(index);
  await conversation(null);
  await conversation(null, "private-inline-sentinel");
  await conversation(1, "private-inline-sentinel");
  await candidate(1);
  await candidate(1);
  await candidate(8, "2026-09-14 01:11:37.999999");
  await candidate(9, "2026-09-14 01:11:38");
  await writer.query(`INSERT INTO checkpoints (run_id, conversation_id, storage_mounts)
    SELECT run_id, id, '[]'::jsonb FROM conversations;
    UPDATE agent_sessions SET conversation_id = (SELECT id FROM conversations LIMIT 1);
    INSERT INTO storage_versions (id, storage_id, s3_key, archive_size, created_by)
    VALUES ('${hash(1)}', '${storage}', 'private-path-sentinel', 1, 'audit-user');
    INSERT INTO pi_memory_stage1_days (user_id, day, org_id, trigger_thread_id, requested_at)
    VALUES ('audit-user', '2026-09-14', 'audit-org', '${randomUUID()}', '2026-09-14');
    INSERT INTO pi_memory_stage1_selections
      (user_id, slot, day, org_id, chat_thread_id, memory_storage_id, pi_session_id,
       source_run_id, source_history_hash, source_completed_at, source_activity_at)
    VALUES ('audit-user', 1, '2026-09-14', 'audit-org', '${randomUUID()}', '${storage}',
      'frozen-selection', '${randomUUID()}', '${hash(6)}', '2026-09-10', '2026-09-10');`);

  const before = await state();
  const receipt = await runFile();
  assert.deepEqual(
    await state(),
    before,
    "The whole shipped psql file must leave rows and catalog unchanged",
  );
  assert.equal(receipt.assumptions.catalog_matches_inventory, true);
  assert.deepEqual(receipt.population, {
    union_hashes: 11,
    blob_rows: 10,
    owned_hashes: 7,
    owner_references: 14,
    conversation_references: 10,
    candidate_references: 4,
    shared_hashes: 3,
    shared_conversation_hashes: 3,
    shared_candidate_hashes: 1,
    cross_owner_hashes: 1,
    maximum_owner_multiplicity: 5,
    unrecognized_hash_format: 0,
    recorded_references: 15,
  });
  assert.deepEqual(receipt.conversations, {
    conversation_rows: 12,
    null_history_rows: 1,
    legacy_inline_only_rows: 1,
    hash_with_inline_rows: 1,
  });
  assert.equal(receipt.reconciliation.balanced_owned_hashes, 1);
  assert.equal(receipt.reconciliation.missing_metadata_hashes, 1);
  assert.equal(receipt.reconciliation.missing_metadata_references, 2);
  assert.equal(receipt.reconciliation.under_retained_hashes, 2);
  assert.equal(receipt.reconciliation.under_retained_difference, 4);
  assert.equal(receipt.reconciliation.negative_hashes, 1);
  assert.equal(receipt.reconciliation.excess_owned_hashes, 3);
  assert.equal(receipt.reconciliation.positive_unowned_hashes, 2);
  assert.equal(receipt.reconciliation.all_excess_hashes, 5);
  assert.equal(receipt.reconciliation.excess_reference_difference, 7);
  assert.equal(receipt.reconciliation.unowned_zero_count_metadata, 2);
  assert.equal(receipt.reconciliation.recent_or_active_hashes, 1);
  assert.equal(receipt.reconciliation.nonfinite_time_hashes, 1);
  assert.equal(
    receipt.reconciliation.excess_hashes_with_unknown_counter_history,
    5,
  );
  assert.equal(receipt.candidate_only.balanced_hashes, 1);
  assert.equal(receipt.candidate_only.old_source_deleted_run_residuals, 1);
  assert.equal(receipt.candidate_only.unexplained_hashes, 1);
  const serialized = JSON.stringify(receipt);
  for (const forbidden of [
    session,
    storage,
    hash(1),
    "private-inline-sentinel",
    "private-path-sentinel",
    "audit-user",
    "audit-org",
  ]) {
    assert.ok(!serialized.includes(forbidden), "Receipt leaked fixture data");
  }
  console.log(
    "PASS full population, shared owners, missing metadata, undercounts, preparation, ambiguity, strict B cutoff and content-free unchanged state",
  );

  // The unchanged candidate tool remains the semantic comparison boundary.
  const candidateFile = await promisify(execFile)("psql", [
    "-X",
    "-qAt",
    "--set",
    "ON_ERROR_STOP=1",
    "--dbname",
    fixtureUrl.toString(),
    "--file",
    new URL("./audit-pi-memory-candidate-references.sql", import.meta.url)
      .pathname,
  ]);
  const candidateReceipt = z
    .object({ reconciliation: counts })
    .parse(JSON.parse(candidateFile.stdout));
  for (const [key, value] of Object.entries(candidateReceipt.reconciliation)) {
    assert.equal(receipt.candidate_only[key], value, key);
  }
  console.log("PASS unchanged candidate-only reconciliation equivalence");

  for (const forbidden of [
    "UPDATE blobs SET ref_count = 0",
    "DELETE FROM conversations",
    "CREATE TABLE forbidden_write (id integer)",
    "SELECT * FROM blobs FOR UPDATE",
  ]) {
    await auditor.query(preamble);
    await assert.rejects(auditor.query(forbidden), { code: "25006" });
    await auditor.query("ROLLBACK");
  }
  assert.deepEqual(await state(), before);
  console.log(
    "PASS PostgreSQL rejects DML, DDL and row write locks under the audit transaction",
  );

  await auditor.query(preamble);
  const pinned = await readReceipt();
  await writer.query("BEGIN; SET LOCAL statement_timeout = '2s'");
  await conversation(1);
  await writer.query(
    "UPDATE blobs SET ref_count = ref_count + 1 WHERE hash = $1",
    [hash(1)],
  );
  await writer.query("COMMIT");
  assert.deepEqual((await readReceipt()).population, pinned.population);
  await auditor.query("ROLLBACK");
  assert.equal((await runFile()).population.owner_references, 15);
  console.log(
    "PASS concurrent writer commits without an audit write lock; repeated report reads retain one snapshot",
  );

  await writer.query("BEGIN; LOCK TABLE blobs IN ACCESS EXCLUSIVE MODE");
  try {
    await auditor.query(preamble);
    await assert.rejects(readReceipt(), { code: "55P03" });
  } finally {
    await auditor.query("ROLLBACK");
    await writer.query("ROLLBACK");
  }
  console.log(
    "PASS real DDL contention is bounded by the shipped 3-second lock timeout",
  );

  await writer.query(`BEGIN;
    ALTER TABLE pi_memory_stage1_candidates DROP CONSTRAINT pi_memory_stage1_candidates_source_history_hash_blobs_hash_fk;`);
  await candidate(12);
  await writer.query("COMMIT");
  const missingCandidate = await runFile();
  assert.equal(missingCandidate.candidate_only.missing_source_blobs, 1);
  assert.equal(missingCandidate.reconciliation.missing_metadata_references, 3);
  assert.equal(missingCandidate.assumptions.catalog_matches_inventory, false);
  await writer.query(
    "DELETE FROM pi_memory_stage1_candidates WHERE source_history_hash = $1",
    [hash(12)],
  );
  await writer.query(`ALTER TABLE pi_memory_stage1_candidates
    ADD CONSTRAINT pi_memory_stage1_candidates_source_history_hash_blobs_hash_fk
    FOREIGN KEY (source_history_hash) REFERENCES blobs(hash);
    CREATE TABLE unexpected_owner (hash varchar(64) REFERENCES blobs(hash));`);
  assert.equal((await runFile()).assumptions.catalog_matches_inventory, false);
  await writer.query("DROP TABLE unexpected_owner");
  console.log(
    "PASS corrupt candidate metadata is counted and an unknown FK invalidates catalog completeness",
  );

  await writer.query("UPDATE blobs SET created_at = now() WHERE hash = $1", [
    hash(6),
  ]);
  await writer.query(
    "UPDATE storages SET name = 'unexpected-namespace' WHERE id = $1",
    [storage],
  );
  const ambiguous = await runFile();
  assert.equal(ambiguous.reconciliation.recent_or_active_excess_hashes, 1);
  assert.equal(
    ambiguous.reconciliation.excess_hashes_with_unknown_counter_history,
    5,
  );
  assert.equal(ambiguous.candidate_only.unexpected_storage_namespaces, 4);
  assert.equal(ambiguous.candidate_only.old_source_deleted_run_residuals, 0);
  // Count an unknown historical hash literally; never silently exclude it.
  await writer.query(
    "UPDATE conversations SET cli_agent_session_history_hash = 'unknown-history-format' WHERE cli_agent_session_history_hash IS NULL",
  );
  assert.equal((await runFile()).population.unrecognized_hash_format, 1);
  await auditor.query(preamble);
  await assert.rejects(
    auditor.query(
      query.replace("timestamp '2026-09-14 01:11:38'", "timestamp 'infinity'"),
    ),
    { code: "22012" },
  );
  await auditor.query("ROLLBACK");
  console.log(
    "PASS recent excess, invalid namespace, unknown hashes and invalid cutoff cannot become repair eligibility",
  );

  await seedScale();
  await measurePlan();
  console.log(
    "PASS representative synthetic scale on the complete migrated schema",
  );
} finally {
  await auditor.end();
  await writer.end();
  await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
  await admin.end();
}
