import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import postgres from "postgres";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { z } from "zod";
import { DRIZZLE_MIGRATE_OUT } from "../drizzle.config";
import { applyPendingMigrations } from "./migration-runner";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const databaseName = `canonical_selection_${randomUUID().replaceAll("-", "")}`;
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
  return item.tag.endsWith("_canonical_selected_model_history");
});
assert.ok(entry);
const nextEntry = journal.entries.find((item) => {
  return item.when > entry.when;
});
assert.ok(nextEntry);
const migration = readMigrationFiles({
  migrationsFolder: DRIZZLE_MIGRATE_OUT,
}).find((item) => {
  return item.folderMillis === entry.when;
});
assert.ok(migration);
await admin.query(`CREATE DATABASE "${databaseName}"`);
const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
try {
  await applyPendingMigrations(sql, { beforeMillis: entry.when });
  const user = `user-${randomUUID()}`;
  const org = `org-${randomUUID()}`;
  const thread = randomUUID();
  const personalThread = randomUUID();
  const session = randomUUID();
  const run = randomUUID();
  const input = randomUUID();
  const settings = {
    auto: { effort: "low" },
    "okou-1.0": { effort: "medium" },
    "okou-1.0-pro": { effort: "high" },
    "okou-1.0-max": { effort: "xhigh" },
    "@preset/captured": { effort: "high" },
    "gpt-6-luna": { effort: "xhigh" },
    "retained-personal": { effort: "medium" },
  };
  const personalSettings = {
    "gpt-6-luna": { effort: "xhigh" },
    "retained-personal": { effort: "medium" },
  };
  await sql`INSERT INTO chat_threads (id, user_id, selected_model, model_settings, updated_at) VALUES
    (${thread}, ${user}, NULL, ${sql.json(settings)}, '2026-01-01'),
    (${personalThread}, ${user}, 'gpt-6-luna', ${sql.json(settings)}, '2026-01-01')`;
  await sql`INSERT INTO chat_threads (user_id, selected_model, model_settings)
    SELECT ${user}, CASE WHEN n % 2 = 0 THEN 'okou-1.0' ELSE NULL END, ${sql.json(settings)}
    FROM generate_series(1, 2001) AS n`;
  await sql`INSERT INTO org_members_metadata (org_id, user_id, selected_model, model_settings, service_tier)
    VALUES (${org}, ${user}, 'gpt-6-luna', ${sql.json(settings)}, 'priority')`;
  await sql`INSERT INTO org_members_metadata (org_id, user_id, selected_model, model_settings)
    SELECT ${org}, 'legacy-' || n::text, NULL, ${sql.json(settings)} FROM generate_series(1, 2001) AS n`;
  await sql`INSERT INTO chat_thread_events (user_id, org_id, chat_thread_id, seq_id, kind, selected_model, model_settings, model_settings_patch)
    VALUES (${user}, ${org}, ${thread}, 1, 'created', NULL, ${sql.json(settings)}, NULL),
    (${user}, ${org}, ${thread}, 2, 'model_selection_updated', 'okou-1.0', NULL, '{"model":"@preset/captured","effort":"high"}'),
    (${user}, ${org}, ${thread}, 3, 'renamed', NULL, NULL, NULL),
    (${user}, ${org}, ${personalThread}, 4, 'model_selection_updated', 'gpt-6-luna', NULL, '{"model":"gpt-6-luna","effort":"xhigh"}')`;
  await sql`INSERT INTO chat_thread_events (user_id, org_id, chat_thread_id, seq_id, kind, selected_model)
    SELECT ${user}, ${org}, ${thread}, n + 4, 'model_selection_updated', NULL FROM generate_series(1, 2001) AS n`;
  await sql`INSERT INTO agent_sessions (id, user_id, org_id) VALUES (${session}, ${user}, ${org})`;
  // Captured execution and both native-history formats survive selected-data conversion.
  await sql`INSERT INTO agent_runs (id, session_id, user_id, org_id, status, prompt, trigger_source, autonomy_budget, selected_model, model_provider, model_runtime_provider, model_runtime_model, built_in_model_key_id, launch_snapshot)
    VALUES (${run}, ${session}, ${user}, ${org}, 'completed', 'history', 'chat', 0, 'okou-1.0', 'built-in', 'openrouter-codex', '@preset/retained-runtime', ${randomUUID()}, '{"schemaVersion":1,"framework":"pi","runnerProfile":"vm0/default"}')`;
  await sql`INSERT INTO conversations (run_id, cli_agent_type, cli_agent_session_id, cli_agent_session_history, cli_agent_session_history_hash)
    VALUES (${run}, 'pi', 'retained-pi-session', '{"model":"@preset/retained-runtime","api":"openai-responses"}', ${"a".repeat(64)})`;
  await sql`INSERT INTO chat_events (id, chat_thread_id, event_type, context_type, seq_id, payload, model_selection)
    VALUES (${input}, ${thread}, 'input.prompt', 'web', 1,
      '{"userMessage":{"version":1,"parts":[{"type":"text","text":"keep"},{"type":"model","selectedModel":"okou-1.0"}]}}',
      '{"selectedModel":"okou-1.0","reasoningEffort":null,"codexServiceTier":null}')`;
  await sql`INSERT INTO chat_events (chat_thread_id, event_type, context_type, seq_id, payload)
    VALUES (${thread}, 'input.prompt', 'web', 2, '{"userMessage":{"version":1,"parts":[{"type":"text","text":"uncaptured"}]}}')`;
  await assert.rejects(
    applyPendingMigrations(sql, { beforeMillis: nextEntry.when }),
    /Unconsumed legacy model decisions/,
  );
  const [before] =
    await sql`SELECT selected_model FROM chat_threads WHERE id = ${thread}`;
  assert.equal(
    before?.selected_model,
    null,
    "gate failure rolls back before contraction",
  );
  await sql`INSERT INTO chat_events (chat_thread_id, event_type, revokes_event_id, seq_id)
    VALUES (${thread}, 'control.revoke', ${input}, 3)`;
  const [originalPersonal] =
    await sql`SELECT updated_at FROM chat_threads WHERE id = ${personalThread}`;
  const retainedRun = await sql`SELECT * FROM agent_runs WHERE id = ${run}`;
  const retainedHistory =
    await sql`SELECT * FROM conversations WHERE run_id = ${run}`;
  // Isolate this historical transform from later additive columns and renames.
  await applyPendingMigrations(sql, { beforeMillis: nextEntry.when });
  const [threads] =
    await sql`SELECT count(*)::int AS total, count(*) FILTER (WHERE selected_model = 'auto')::int AS auto,
    count(*) FILTER (WHERE model_settings = ${sql.json(personalSettings)})::int AS settings FROM chat_threads WHERE user_id = ${user}`;
  assert.deepEqual(threads, { total: 2003, auto: 2002, settings: 2003 });
  const [personal] =
    await sql`SELECT selected_model, updated_at FROM chat_threads WHERE id = ${personalThread}`;
  assert.equal(personal?.selected_model, "gpt-6-luna");
  assert.deepEqual(personal?.updated_at, originalPersonal?.updated_at);
  const [member] =
    await sql`SELECT selected_model, model_settings, service_tier FROM org_members_metadata WHERE org_id = ${org} AND user_id = ${user}`;
  assert.deepEqual(member, {
    selected_model: "gpt-6-luna",
    model_settings: personalSettings,
    service_tier: "priority",
  });
  const [members] =
    await sql`SELECT count(*)::int AS auto FROM org_members_metadata WHERE org_id = ${org} AND selected_model = 'auto'`;
  assert.equal(members?.auto, 2001);
  const events =
    await sql`SELECT kind, selected_model, model_settings, model_settings_patch FROM chat_thread_events WHERE user_id = ${user} ORDER BY seq_id LIMIT 4`;
  assert.deepEqual(Array.from(events), [
    {
      kind: "created",
      selected_model: "auto",
      model_settings: personalSettings,
      model_settings_patch: null,
    },
    {
      kind: "model_selection_updated",
      selected_model: "auto",
      model_settings: null,
      model_settings_patch: null,
    },
    {
      kind: "renamed",
      selected_model: null,
      model_settings: null,
      model_settings_patch: null,
    },
    {
      kind: "model_selection_updated",
      selected_model: "gpt-6-luna",
      model_settings: null,
      model_settings_patch: { model: "gpt-6-luna", effort: "xhigh" },
    },
  ]);
  const inputs =
    await sql`SELECT payload, model_selection FROM chat_events WHERE chat_thread_id = ${thread} ORDER BY seq_id`;
  assert.deepEqual(inputs[0]?.model_selection, {
    selectedModel: "auto",
    reasoningEffort: null,
    codexServiceTier: null,
  });
  assert.deepEqual(inputs[0]?.payload, {
    userMessage: {
      version: 1,
      parts: [
        { type: "text", text: "keep" },
        { type: "model", selectedModel: "auto" },
      ],
    },
  });
  assert.equal(inputs[1]?.model_selection, null, "SQL NULL remains uncaptured");
  assert.deepEqual(
    await sql`SELECT * FROM agent_runs WHERE id = ${run}`,
    retainedRun,
  );
  assert.deepEqual(
    await sql`SELECT * FROM conversations WHERE run_id = ${run}`,
    retainedHistory,
  );
  // Replay the historical transform, not the non-idempotent constraint DDL.
  const ddlStart = migration.sql.findIndex((statement) => {
    return statement.includes('ALTER TABLE "chat_threads"');
  });
  assert.ok(ddlStart > 0);
  await sql.unsafe(migration.sql.slice(0, ddlStart).join("\n")).simple();
  assert.deepEqual(
    await sql`SELECT payload, model_selection FROM chat_events WHERE chat_thread_id = ${thread} ORDER BY seq_id`,
    inputs,
  );
  const [omitted] =
    await sql`INSERT INTO chat_threads (user_id) VALUES (${user}) RETURNING selected_model`;
  assert.equal(
    omitted?.selected_model,
    "auto",
    "outgoing omission gets the canonical default",
  );
  const [omittedMember] =
    await sql`INSERT INTO org_members_metadata (org_id, user_id) VALUES (${org}, ${randomUUID()}) RETURNING selected_model`;
  assert.equal(omittedMember?.selected_model, "auto");
  await assert.rejects(
    sql`UPDATE chat_threads SET selected_model = NULL WHERE id = ${thread}`,
    /not-null/,
  );
  await assert.rejects(
    sql`UPDATE chat_threads SET selected_model = '' WHERE id = ${thread}`,
    /chat_threads_selected_model_check/,
  );
  await assert.rejects(
    sql`UPDATE chat_threads SET model_settings = '{"@preset/new":{"effort":"high"}}' WHERE id = ${thread}`,
    /chat_threads_explicit_model_settings_check/,
  );
  await assert.rejects(
    sql`UPDATE chat_events SET model_selection = '{}' WHERE id = ${input}`,
    /chat_events_model_selection_check/,
  );
  await assert.rejects(
    sql`UPDATE chat_events SET model_selection = '{"selectedModel":""}' WHERE id = ${input}`,
    /chat_events_model_selection_check/,
  );
  await assert.rejects(
    sql`UPDATE chat_events SET payload = '{"userMessage":{"parts":[{"type":"model","selectedModel":""}]}}' WHERE id = ${input}`,
    /chat_events_model_annotation_check/,
  );
  await assert.rejects(
    sql`UPDATE agent_runs SET status = 'running', model_runtime_model = NULL WHERE id = ${run}`,
    /agent_runs_executable_builtin_capture_check/,
  );
  await sql`UPDATE agent_runs SET status = 'failed', model_runtime_model = NULL WHERE id = ${run}`;
  await sql`UPDATE agent_runs SET status = 'running', model_runtime_model = '@preset/retained-runtime' WHERE id = ${run}`;
  console.log(
    "canonical selected history: migration, replay, optional decisions and lifecycle constraints passed",
  );
} finally {
  await sql.end();
  await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await admin.end();
}
