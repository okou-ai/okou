import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import postgres from "postgres";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { z } from "zod";
import { DRIZZLE_MIGRATE_OUT } from "../drizzle.config";
import { applyFixtureMigrations } from "./fixtures/migrate-with-empty-instructions";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const databaseName = `run_native_facts_${randomUUID().replaceAll("-", "")}`;
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
  return item.tag.endsWith("_prepare_run_native_facts");
});
assert.ok(entry, "Preparation must remain until the retirement cycle ships");
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
  const sessionId = randomUUID();
  const runId = randomUUID();
  const conversationId = randomUUID();
  const historyHash = "a".repeat(64);
  await sql`INSERT INTO agents (id, org_id, owner, name) VALUES (${agentId}, 'org-native', 'user-native', 'native-preparation')`;
  await sql`INSERT INTO agent_sessions (id, user_id, org_id, agent_id) VALUES (${sessionId}, 'user-native', 'org-native', ${agentId})`;
  const insertOutgoingRun = (id: string) => {
    return sql`INSERT INTO agent_runs (id, user_id, org_id, session_id, status, prompt, result) VALUES (${id}, 'user-native', 'org-native', ${sessionId}, 'completed', 'Preserve history', ${sql.json({ conversationId, agentSessionId: sessionId })}) RETURNING id, session_id`;
  };
  await insertOutgoingRun(runId);
  await sql`INSERT INTO blobs (hash, raw_size, encoding, encoded_size, ref_count) VALUES (${historyHash}, 10, 'identity', 10, 1)`;
  await sql`INSERT INTO conversations (id, run_id, cli_agent_type, cli_agent_session_id, cli_agent_session_history_hash) VALUES (${conversationId}, ${runId}, 'pi', 'native-session', ${historyHash})`;
  await sql`UPDATE agent_sessions SET conversation_id = ${conversationId} WHERE id = ${sessionId}`;
  const before =
    await sql`SELECT to_jsonb(r) AS row FROM agent_runs r WHERE id = ${runId}`;
  const sessionsBefore =
    await sql`SELECT to_jsonb(s) AS row FROM agent_sessions s WHERE id = ${sessionId}`;
  const conversationsBefore =
    await sql`SELECT to_jsonb(c) AS row FROM conversations c WHERE id = ${conversationId}`;
  const blobsBefore =
    await sql`SELECT to_jsonb(b) AS row FROM blobs b WHERE hash = ${historyHash}`;

  await applyFixtureMigrations(sql, {
    beforeMillis: migration.folderMillis + 1,
  });
  const after =
    await sql`SELECT to_jsonb(r) - ARRAY['agent_id', 'framework', 'framework_session_id', 'legacy_conversation_history_hash'] AS row FROM agent_runs r WHERE id = ${runId}`;
  assert.deepEqual(Array.from(after), Array.from(before));
  assert.deepEqual(
    Array.from(
      await sql`SELECT to_jsonb(s) AS row FROM agent_sessions s WHERE id = ${sessionId}`,
    ),
    Array.from(sessionsBefore),
  );
  assert.deepEqual(
    Array.from(
      await sql`SELECT to_jsonb(c) AS row FROM conversations c WHERE id = ${conversationId}`,
    ),
    Array.from(conversationsBefore),
  );
  assert.deepEqual(
    Array.from(
      await sql`SELECT to_jsonb(b) AS row FROM blobs b WHERE hash = ${historyHash}`,
    ),
    Array.from(blobsBefore),
  );
  const [historical] =
    await sql`SELECT agent_id, framework, framework_session_id, legacy_conversation_history_hash FROM agent_runs WHERE id = ${runId}`;
  assert.deepEqual(historical, {
    agent_id: null,
    framework: null,
    framework_session_id: null,
    legacy_conversation_history_hash: null,
  });
  const overlapRunId = randomUUID();
  assert.equal(
    (await insertOutgoingRun(overlapRunId))[0]?.session_id,
    sessionId,
  );
  await sql`UPDATE agent_runs SET completed_at = now() WHERE id = ${overlapRunId}`;
  await sql`UPDATE conversations SET cli_agent_session_id = 'outgoing-native-session' WHERE id = ${conversationId}`;
  await sql`UPDATE agent_sessions SET conversation_id = ${conversationId} WHERE id = ${sessionId}`;
  await sql`UPDATE agent_runs SET agent_id = ${agentId}, framework = 'pi', framework_session_id = 'outgoing-native-session', legacy_conversation_history_hash = ${historyHash} WHERE id = ${runId}`;
  assert.equal(
    (await sql`SELECT ref_count FROM blobs WHERE hash = ${historyHash}`)[0]
      ?.ref_count,
    1,
  );
  await assert.rejects(
    sql`UPDATE agent_runs SET agent_id = ${randomUUID()} WHERE id = ${runId}`,
    /agent_runs_agent_id_agents_id_fk/,
  );
  await assert.rejects(
    sql`UPDATE agent_runs SET session_id = NULL WHERE id = ${runId}`,
    /null value in column "session_id"/,
  );
  await assert.rejects(
    sql`UPDATE agent_runs SET session_id = ${randomUUID()} WHERE id = ${runId}`,
    /agent_runs_session_id_agent_sessions_id_fk/,
  );
  await applyFixtureMigrations(sql, {
    beforeMillis: migration.folderMillis + 1,
  });
  await sql`DELETE FROM agent_sessions WHERE id = ${sessionId}`;
  assert.equal(
    (
      await sql`SELECT count(*)::int AS count FROM agent_runs WHERE id IN (${runId}, ${overlapRunId})`
    )[0]?.count,
    0,
  );
  assert.equal(
    (
      await sql`SELECT count(*)::int AS count FROM conversations WHERE id = ${conversationId}`
    )[0]?.count,
    0,
  );
  console.log(
    "Run native-fact preparation preserves historical rows, outgoing SQL, existing blob retains, and Session constraints/cascades.",
  );
} finally {
  await sql.end();
  await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  await admin.end();
}
