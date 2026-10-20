import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import postgres from "postgres";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { PgDialect } from "drizzle-orm/pg-core";
import { z } from "zod";
import { DRIZZLE_MIGRATE_OUT } from "../drizzle.config";
import { applyFixtureMigrations } from "./fixtures/migrate-with-empty-instructions";
import { deleteRunHistoriesSql } from "../src/operations/run-history-deletion";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const databaseName = `native_runtime_${randomUUID().replaceAll("-", "")}`;
const admin = new Client({ connectionString: databaseUrl });
await admin.connect();
const url = new URL(databaseUrl);
url.pathname = `/${databaseName}`;
const journal = z
  .object({ entries: z.array(z.object({ tag: z.string(), when: z.number() })) })
  .parse(
    JSON.parse(
      await readFile(`${DRIZZLE_MIGRATE_OUT}/meta/_journal.json`, "utf8"),
    ),
  );
const entry = journal.entries.find((item) => {
  return item.tag.endsWith("_retire_session_conversation_runtime");
});
assert.ok(entry, "Runtime cutover migration must exist");
const migration = readMigrationFiles({
  migrationsFolder: DRIZZLE_MIGRATE_OUT,
}).find((item) => {
  return item.folderMillis === entry.when;
});
assert.ok(migration);
await admin.query(`CREATE DATABASE "${databaseName}"`);
const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
try {
  await applyFixtureMigrations(sql, { beforeMillis: migration.folderMillis });
  const agentId = randomUUID();
  const threadId = randomUUID();
  const sessionId = randomUUID();
  const runId = randomUUID();
  const admissionId = randomUUID();
  const conversationId = randomUUID();
  const hash = "b".repeat(64);
  await sql`INSERT INTO agents (id, org_id, owner, name) VALUES (${agentId}, 'org-native', 'user-native', 'runtime-cutover')`;
  await sql`INSERT INTO agent_sessions (id, user_id, org_id, agent_id) VALUES (${sessionId}, 'user-native', 'org-native', ${agentId})`;
  await sql`INSERT INTO chat_threads (id, user_id, agent_id, agent_session_id, agent_session_run_id) VALUES (${threadId}, 'user-native', ${agentId}, ${sessionId}, ${admissionId})`;
  for (const id of [runId, admissionId]) {
    await sql`INSERT INTO agent_runs (id, user_id, org_id, session_id, status, prompt, trigger_source, autonomy_budget, chat_thread_id)
      VALUES (${id}, 'user-native', 'org-native', ${sessionId}, 'completed', 'Historical input', 'web', 32, ${threadId})`;
  }
  await sql`INSERT INTO blobs (hash, raw_size, encoding, encoded_size, ref_count) VALUES (${hash}, 10, 'identity', 10, 1)`;
  await sql`INSERT INTO conversations (id, run_id, cli_agent_type, cli_agent_session_id, cli_agent_session_history_hash) VALUES (${conversationId}, ${runId}, 'pi', ${threadId}, ${hash})`;
  await sql`UPDATE agent_sessions SET conversation_id = ${conversationId} WHERE id = ${sessionId}`;
  const before =
    await sql`SELECT id, user_id, org_id, session_id, status, prompt, result, created_at FROM agent_runs ORDER BY id`;
  await sql`UPDATE agent_runs SET user_id = 'different-owner' WHERE id = ${runId}`;
  await assert.rejects(
    applyFixtureMigrations(sql, { beforeMillis: migration.folderMillis + 1 }),
    /Run\/Session ownership is inconsistent/,
  );
  assert.equal(
    (
      await sql`SELECT count(*)::int AS count FROM information_schema.columns WHERE table_name = 'chat_threads' AND column_name = 'framework'`
    )[0]?.count,
    0,
  );
  await sql`UPDATE agent_runs SET user_id = 'user-native' WHERE id = ${runId}`;
  await sql`UPDATE agent_runs SET framework = 'pi', framework_session_id = ${threadId}, legacy_conversation_history_hash = NULL WHERE id = ${runId}`;
  await assert.rejects(
    applyFixtureMigrations(sql, { beforeMillis: migration.folderMillis + 1 }),
    /Prepared native output mirrors diverged/,
  );
  await sql`UPDATE agent_runs SET framework = NULL, framework_session_id = NULL WHERE id = ${runId}`;
  const privateRunId = randomUUID();
  const privateSessionId = randomUUID();
  const privateConversationId = randomUUID();
  const privateReceipt = {
    agentSessionId: privateSessionId,
    conversationId: privateConversationId,
    storageOutputs: [
      {
        name: "memory",
        mountPath: "/home/user/.pi/agent/memory",
        version: "c".repeat(64),
      },
    ],
  };
  await sql`INSERT INTO agent_sessions (id, user_id, org_id) VALUES (${privateSessionId}, 'user-native', 'org-native')`;
  await sql`INSERT INTO agent_runs (id, user_id, org_id, session_id, status, prompt, trigger_source, autonomy_budget, launch_snapshot, result, cancellation_recovery_completed)
    VALUES (${privateRunId}, 'user-native', 'org-native', ${privateSessionId}, 'cancelled', 'Private maintenance', 'web', 32, ${sql.json({ schemaVersion: 3, framework: "pi", runnerProfile: "test" })}, ${sql.json(privateReceipt)}, false)`;
  await sql`INSERT INTO conversations (id, run_id, cli_agent_type, cli_agent_session_id) VALUES (${privateConversationId}, ${privateRunId}, 'pi', ${privateRunId})`;
  await sql`UPDATE agent_sessions SET conversation_id = ${privateConversationId} WHERE id = ${privateSessionId}`;
  await applyFixtureMigrations(sql, {
    beforeMillis: migration.folderMillis + 1,
  });
  assert.deepEqual(
    Array.from(
      await sql`SELECT id, user_id, org_id, session_id, status, prompt, result, created_at FROM agent_runs WHERE id IN (${runId}, ${admissionId}) ORDER BY id`,
    ),
    Array.from(before),
  );
  assert.deepEqual(
    (
      await sql`SELECT result, cancellation_recovery_completed FROM agent_runs WHERE id = ${privateRunId}`
    )[0],
    {
      result: {
        ...privateReceipt,
        framework: "pi",
        frameworkSessionId: privateRunId,
      },
      cancellation_recovery_completed: false,
    },
  );
  // The prepared outgoing writer may still complete after this migration. Its
  // genuine Run mirrors and legacy exact-output receipt remain independently
  // available without consulting Session or Conversation in the new runtime.
  await sql`UPDATE agent_runs SET result = ${sql.json(privateReceipt)}, framework = 'pi', framework_session_id = ${privateRunId}, legacy_conversation_history_hash = NULL WHERE id = ${privateRunId}`;
  assert.deepEqual(
    (
      await sql`SELECT framework, framework_session_id, result FROM agent_runs WHERE id = ${privateRunId}`
    )[0],
    {
      framework: "pi",
      framework_session_id: privateRunId,
      result: privateReceipt,
    },
  );
  assert.deepEqual(
    (
      await sql`SELECT agent_id, framework, framework_session_id, legacy_conversation_history_hash FROM agent_runs WHERE id = ${runId}`
    )[0],
    {
      agent_id: agentId,
      framework: "pi",
      framework_session_id: threadId,
      legacy_conversation_history_hash: hash,
    },
  );
  assert.deepEqual(
    (
      await sql`SELECT framework, framework_session_id, framework_session_run_id FROM chat_threads WHERE id = ${threadId}`
    )[0],
    {
      framework: "pi",
      framework_session_id: threadId,
      framework_session_run_id: runId,
    },
  );
  assert.equal(
    (await sql`SELECT ref_count FROM blobs WHERE hash = ${hash}`)[0]?.ref_count,
    1,
  );
  assert.equal(
    (await sql`SELECT count(*)::int AS count FROM conversations`)[0]?.count,
    2,
  );
  const nativeId = randomUUID();
  await sql`INSERT INTO agent_runs (id, user_id, org_id, agent_id, status, prompt, trigger_source, autonomy_budget, chat_thread_id, launch_snapshot)
    VALUES (${nativeId}, 'user-native', 'org-native', ${agentId}, 'running', 'Native input', 'web', 32, ${threadId}, ${sql.json({ schemaVersion: 5, framework: "pi", runnerProfile: "test" })})`;
  assert.equal(
    (
      await sql`SELECT count(*)::int AS count FROM agent_runs WHERE session_id IN (SELECT id FROM agent_sessions WHERE agent_id = ${agentId}) AND status = 'running'`
    )[0]?.count,
    0,
  );
  assert.equal(
    (
      await sql`SELECT count(*)::int AS count FROM agent_runs WHERE agent_id = ${agentId} AND status = 'running'`
    )[0]?.count,
    1,
  );
  await sql`DELETE FROM agent_runs WHERE id = ${nativeId}`;
  await sql`DELETE FROM agent_sessions WHERE id = ${sessionId}`;
  assert.equal(
    (
      await sql`SELECT count(*)::int AS count FROM agent_runs WHERE id IN (${runId}, ${admissionId})`
    )[0]?.count,
    2,
  );
  assert.equal(
    (
      await sql`SELECT count(*)::int AS count FROM agent_runs WHERE session_id IS NULL`
    )[0]?.count,
    2,
  );
  assert.equal(
    (await sql`SELECT ref_count FROM blobs WHERE hash = ${hash}`)[0]?.ref_count,
    1,
  );
  const currentHash = "d".repeat(64);
  await sql`INSERT INTO blobs (hash, raw_size, encoding, encoded_size, ref_count) VALUES (${currentHash}, 12, 'identity', 12, 1)`;
  await sql`UPDATE agent_runs SET legacy_conversation_history_hash = ${currentHash} WHERE id = ${runId}`;
  await sql`UPDATE blobs SET ref_count = 0 WHERE hash = ${hash}`;
  const query = new PgDialect().sqlToQuery(deleteRunHistoriesSql([runId]));
  const deleted = await sql.unsafe(
    query.sql,
    z.array(z.array(z.uuid())).parse(query.params),
  );
  assert.deepEqual(Array.from(deleted), [{ id: runId, hash: currentHash }]);
  assert.equal(
    (
      await sql`SELECT count(*)::int AS count FROM conversations WHERE run_id = ${runId}`
    )[0]?.count,
    0,
  );
} finally {
  await sql.end();
  await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  await admin.end();
}
