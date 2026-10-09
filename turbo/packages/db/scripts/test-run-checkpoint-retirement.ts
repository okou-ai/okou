import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import postgres from "postgres";
import { z } from "zod";

import { applyPendingMigrations } from "./migration-runner";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const journal = z
  .object({ entries: z.array(z.object({ tag: z.string(), when: z.number() })) })
  .parse(
    JSON.parse(
      await readFile(
        new URL("../src/migrations/meta/_journal.json", import.meta.url),
        "utf8",
      ),
    ),
  );
const migration = journal.entries.find(({ tag }) => {
  return tag.endsWith("_retire_generic_run_checkpoints");
});
assert.ok(migration, "Checkpoint contraction must remain in the journal");
const admin = new Client({ connectionString: databaseUrl });
await admin.connect();
const databaseName = `checkpoint_contraction_${randomUUID().replaceAll("-", "")}`;
await admin.query(`CREATE DATABASE "${databaseName}"`);
const url = new URL(databaseUrl);
url.pathname = `/${databaseName}`;
const migrationSql = postgres(url.toString(), { max: 1, onnotice: () => {} });
const client = new Client({ connectionString: url.toString() });
await client.connect();

async function retainedState() {
  const tables = [
    "agents",
    "agent_sessions",
    "agent_runs",
    "conversations",
    "blobs",
    "storages",
    "storage_versions",
    "storage_version_lineage",
    "pi_memory_phase2_checkpoints",
  ];
  const result: Record<string, readonly unknown[]> = {};
  const rowSchema = z.object({ value: z.record(z.string(), z.unknown()) });
  for (const table of tables) {
    const rows = await client.query(
      `SELECT to_jsonb(t) AS value FROM "${table}" t ORDER BY to_jsonb(t)::text`,
    );
    result[table] = rows.rows.map((row: unknown) => {
      return rowSchema.parse(row).value;
    });
  }
  const jobs = await client.query(
    "SELECT to_jsonb(t) - 'last_maintenance_checkpoint_id' AS value FROM pi_memory_phase2_jobs t ORDER BY memory_storage_id",
  );
  result.pi_memory_phase2_jobs = jobs.rows.map((row: unknown) => {
    return rowSchema.parse(row).value;
  });
  return result;
}

try {
  await applyPendingMigrations(migrationSql, { beforeMillis: migration.when });
  const agentId = randomUUID();
  const sessionId = randomUUID();
  const runId = randomUUID();
  const conversationId = randomUUID();
  const checkpointId = randomUUID();
  const storageId = randomUUID();
  const historyHash = "a".repeat(64);
  const versionId = "b".repeat(64);
  const baseVersionId = "c".repeat(64);
  const digest = "d".repeat(64);
  const result = {
    agentSessionId: sessionId,
    conversationId,
    checkpointId,
    artifact: { memory: versionId },
  };
  await client.query(
    "INSERT INTO agents (id, org_id, owner, name) VALUES ($1, 'retirement-org', 'retirement-user', 'retained-agent')",
    [agentId],
  );
  await client.query(
    "INSERT INTO agent_sessions (id, agent_id, org_id, user_id) VALUES ($1, $2, 'retirement-org', 'retirement-user')",
    [sessionId, agentId],
  );
  await client.query(
    "INSERT INTO agent_runs (id, session_id, org_id, user_id, prompt, status, result) VALUES ($1, $2, 'retirement-org', 'retirement-user', 'retained run', 'completed', $3)",
    [runId, sessionId, JSON.stringify(result)],
  );
  await client.query(
    "INSERT INTO blobs (hash, raw_size, encoded_size, encoding, ref_count) VALUES ($1, 1, 1, 'identity', 1)",
    [historyHash],
  );
  await client.query(
    "INSERT INTO conversations (id, run_id, cli_agent_type, cli_agent_session_id, cli_agent_session_history_hash) VALUES ($1, $2, 'pi', 'retained-native-session', $3)",
    [conversationId, runId, historyHash],
  );
  await client.query(
    "UPDATE agent_sessions SET conversation_id = $1 WHERE id = $2",
    [conversationId, sessionId],
  );
  await client.query(
    "INSERT INTO checkpoints (id, run_id, conversation_id, storage_mounts) VALUES ($1, $2, $3, '[]')",
    [checkpointId, runId, conversationId],
  );
  await client.query(
    "INSERT INTO storages (id, org_id, user_id, name, s3_prefix) VALUES ($1::uuid, 'retirement-org', 'retirement-user', 'memory', $1::text)",
    [storageId],
  );
  await client.query(
    "INSERT INTO storage_versions (id, storage_id, s3_key, archive_size, created_by) VALUES ($1, $2, 'retained-version', 0, 'retirement-user')",
    [versionId, storageId],
  );
  await client.query("UPDATE storages SET head_version_id = $1 WHERE id = $2", [
    versionId,
    storageId,
  ]);
  await client.query(
    "INSERT INTO storage_version_lineage (storage_id, version_id, parent_version_id, run_id) VALUES ($1, $2, $3, $4)",
    [storageId, versionId, baseVersionId, runId],
  );
  await client.query(
    "INSERT INTO pi_memory_phase2_checkpoints (run_id, memory_storage_id, org_id, user_id, lease_token, claimed_revision, claimed_base_version_id, selection_digest, version_id) VALUES ($1, $2, 'retirement-org', 'retirement-user', $3, 1, $4, $5, $6)",
    [runId, storageId, randomUUID(), baseVersionId, digest, versionId],
  );
  await client.query(
    "INSERT INTO pi_memory_phase2_jobs (memory_storage_id, org_id, user_id, status, input_revision, completed_revision, last_maintenance_run_id, last_maintenance_revision, last_maintenance_base_version_id, last_maintenance_selection_digest, last_maintenance_checkpoint_id, last_maintenance_checkpoint_version_id, last_maintenance_outcome) VALUES ($1, 'retirement-org', 'retirement-user', 'idle', 1, 1, $2, 1, $3, $4, $5, $6, 'published')",
    [storageId, runId, baseVersionId, digest, checkpointId, versionId],
  );

  const before = await retainedState();
  await applyPendingMigrations(migrationSql, {
    beforeMillis: migration.when + 1,
  });
  assert.deepEqual(await retainedState(), before);
  await applyPendingMigrations(migrationSql, {
    beforeMillis: migration.when + 1,
  });
  assert.deepEqual(await retainedState(), before);
  console.log(
    "Checkpoint contraction preserves historical Runs/results, native continuation, blob retains, Storage versions/lineage and memory publication receipts.",
  );
} finally {
  await client.end();
  await migrationSql.end();
  await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  await admin.end();
}
