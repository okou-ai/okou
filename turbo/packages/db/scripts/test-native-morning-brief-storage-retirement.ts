import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const client = new Client({ connectionString: databaseUrl });
await client.connect();
const testSchema = `native_brief_retirement_${randomUUID().replaceAll("-", "")}`;

async function migration(name: string): Promise<string> {
  return (
    await readFile(
      new URL(`../src/migrations/${name}.sql`, import.meta.url),
      "utf8",
    )
  ).replaceAll('"public".', `"${testSchema}".`);
}

const retiredTables = [
  "morning_brief_native_schedule_skips",
  "morning_brief_native_occurrences",
  "morning_brief_native_schedules",
  "morning_brief_deliveries",
  "morning_brief_generations",
  "morning_brief_collection_occurrences",
  "morning_brief_installed_preferences",
];
const retainedTables = [
  "agents",
  "org_members_cache",
  "org_members_metadata",
  "chat_threads",
  "chat_events",
  "email_outbox",
  "workflow_automations",
  "workflow_schedule_skips",
  "morning_brief_platform_generation_receipts",
];

async function rows(table: string): Promise<unknown[]> {
  return (await client.query(`SELECT * FROM "${table}" ORDER BY 1, 2`)).rows;
}

async function tableRows(tables: readonly string[]): Promise<unknown[][]> {
  const result: unknown[][] = [];
  for (const table of tables) {
    result.push(await rows(table));
  }
  return result;
}

try {
  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0407; new non-billing transactions are prohibited.
  await client.query("BEGIN");
  await client.query(`CREATE SCHEMA "${testSchema}"`);
  await client.query(`SET LOCAL search_path TO "${testSchema}"`);
  // Retained roots expose the actual foreign-key targets of the historical
  // Native migrations. The full migration suite also compares current schemas.
  await client.query(`
    CREATE TABLE agents (id uuid PRIMARY KEY, description text);
    CREATE TABLE org_members_cache (org_id text, user_id text, PRIMARY KEY (org_id, user_id));
    CREATE TABLE org_members_metadata (org_id text, user_id text, PRIMARY KEY (org_id, user_id));
    CREATE TABLE chat_threads (id uuid PRIMARY KEY, title text);
    CREATE TABLE chat_events (id uuid PRIMARY KEY, thread_id uuid REFERENCES chat_threads(id), body text);
    CREATE TABLE email_outbox (id uuid PRIMARY KEY, template text, status text);
    CREATE TABLE workflow_automations (id uuid PRIMARY KEY, next_run_at timestamp);
  `);
  for (const name of [
    "1149_morning_brief_installed_preferences",
    "1151_morning_brief_collection_occurrences",
    "1152_morning_brief_platform_generation",
    "1157_morning_brief_deliveries",
    "1164_odd_victor_mancha",
    "1212_jazzy_magma",
  ]) {
    await client.query(await migration(name));
  }
  // One fixture UUID is reused across independent entity tables. Legacy
  // deliveries retain chat/outbox references and a receipt shares the attempt.
  await client.query(`
    INSERT INTO agents VALUES ('00000000-0000-4000-8000-000000000001', 'retained agent');
    INSERT INTO org_members_cache VALUES ('org', 'owner');
    INSERT INTO org_members_metadata VALUES ('org', 'owner');
    INSERT INTO chat_threads VALUES ('00000000-0000-4000-8000-000000000001', 'Morning Brief history');
    INSERT INTO chat_events VALUES ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'previous brief');
    INSERT INTO email_outbox VALUES ('00000000-0000-4000-8000-000000000001', 'official-automation-result', 'sent');
    INSERT INTO workflow_automations (id, next_run_at)
      VALUES ('00000000-0000-4000-8000-000000000001', '2026-10-08 08:00:00');
    INSERT INTO workflow_schedule_skips VALUES ('00000000-0000-4000-8000-000000000001', '2026-10-07 08:00:00', '2026-10-07 09:00:00');
    INSERT INTO morning_brief_installed_preferences
      (org_id, user_id, projection_version, workflow_id, automation_id, agent_id, chat_thread_id, enabled, timezone)
      VALUES ('org', 'owner', 1, '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', true, 'UTC');
    INSERT INTO morning_brief_collection_occurrences
      (org_id, user_id, scheduled_for, collection_kind, collection_version, window_start, window_end, timezone, membership_id, workflow_id, automation_id, agent_id, slack_workspace_id, slack_user_id, status, attempt, outcome, claimed_at, finished_at)
      VALUES ('org', 'owner', '2026-09-20 08:00:00', 'slack', 1, '2026-09-19', '2026-09-20', 'UTC', 'membership', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'workspace', 'slack-user', 'completed', 1, 'partial', '2026-09-20 08:00:00', '2026-09-20 08:01:00');
    INSERT INTO morning_brief_collection_occurrences
      (org_id, user_id, scheduled_for, collection_kind, collection_version, window_start, window_end, timezone, membership_id, workflow_id, automation_id, agent_id, slack_workspace_id, slack_user_id, status, attempt, lease_token, lease_expires_at, claimed_at)
      VALUES ('org', 'owner', '2026-09-21 08:00:00', 'slack', 1, '2026-09-20', '2026-09-21', 'UTC', 'membership', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'workspace', 'slack-user', 'running', 1, '00000000-0000-4000-8000-000000000001', '2026-09-21 08:01:00', '2026-09-21 08:00:00');
    INSERT INTO morning_brief_generations
      (org_id, user_id, scheduled_for, collection_kind, collection_version, execution_purpose, attempt_id, state, membership_id, agent_id, model, prompt_version, result_schema_version, language, language_source, input_digest, input_items, included_items, input_reduced, source_coverage, reserved_at, reservation_expires_at, expires_at)
      VALUES ('org', 'owner', '2026-09-20 08:00:00', 'slack', 1, 'production', '00000000-0000-4000-8000-000000000001', 'reserved', 'membership', '00000000-0000-4000-8000-000000000001', 'historical-model', 1, 1, 'en', 'default', 'digest', 1, 1, false, 'partial', '2026-09-20 08:00:00', '2026-09-20 08:01:00', '2026-09-21');
    INSERT INTO morning_brief_platform_generation_receipts
      (attempt_id, operation, provider, requested_model, outcome, cost_state, cost_value, cost_unit, cost_source, started_at, finished_at)
      VALUES ('00000000-0000-4000-8000-000000000001', 'morning-brief', 'historical-provider', 'historical-model', 'response_received', 'reported', 0.012345678901, 'provider-unit', 'chat_completion_usage_cost', '2026-09-20 08:00:00', '2026-09-20 08:01:00');
    INSERT INTO morning_brief_deliveries
      (org_id, user_id, scheduled_for, collection_kind, collection_version, execution_purpose, result_attempt_id, membership_id, workflow_id, automation_id, agent_id, chat_thread_id, chat_event_id, result_digest, email_resolution, email_outbox_id, delivered_at)
      VALUES ('org', 'owner', '2026-09-20 08:00:00', 'slack', 1, 'production', '00000000-0000-4000-8000-000000000001', 'membership', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'digest', 'sent', '00000000-0000-4000-8000-000000000001', '2026-09-20 08:01:00');
    INSERT INTO morning_brief_native_schedules
      (org_id, user_id, enabled, timezone, phase, target, owner_epoch, membership_id, agent_id, chat_thread_id, materialized_at)
      VALUES ('org', 'owner', true, 'UTC', 'legacy', 'legacy', 1, 'membership', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '2026-09-20');
    INSERT INTO morning_brief_native_occurrences
      (org_id, user_id, scheduled_for, owner_epoch, membership_id, timezone, state, outcome, generation_attempt_id, claimed_at, settled_at)
      VALUES ('org', 'owner', '2026-09-20 08:00:00', 1, 'membership', 'UTC', 'settled', 'delivered', '00000000-0000-4000-8000-000000000001', '2026-09-20 08:00:00', '2026-09-20 08:01:00');
    INSERT INTO morning_brief_native_schedule_skips VALUES ('org', 'owner', 1, '2026-09-19 08:00:00', '2026-09-19 09:00:00');
  `);
  const retainedBefore = await tableRows(retainedTables);
  const retiredBefore = await tableRows(retiredTables);
  assert.ok(
    retiredBefore.every((records) => {
      return records.length > 0;
    }),
  );
  const dropSql = await migration("1342_drop_native_morning_brief_storage");
  await client.query("SET LOCAL lock_timeout = '1s'");
  await client.query("SET LOCAL statement_timeout = '10s'");

  // Depend on the last table to ensure even preceding successful drops roll
  // back. A cascading drop would silently remove this unexpected consumer.
  await client.query(
    "CREATE VIEW unexpected_consumer AS SELECT * FROM morning_brief_installed_preferences",
  );
  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0408; new non-billing transactions are prohibited.
  await client.query("SAVEPOINT blocked_contraction");
  await assert.rejects(client.query(dropSql), (error: unknown) => {
    return error instanceof Error && "code" in error && error.code === "2BP01";
  });
  await client.query("ROLLBACK TO SAVEPOINT blocked_contraction");
  assert.deepEqual(await tableRows(retiredTables), retiredBefore);
  assert.equal((await rows("unexpected_consumer")).length, 1);
  await client.query("DROP VIEW unexpected_consumer");

  await client.query(dropSql);
  for (const table of retiredTables) {
    assert.deepEqual(
      (
        await client.query("SELECT to_regclass($1) AS retired", [
          `${testSchema}.${table}`,
        ])
      ).rows,
      [{ retired: null }],
    );
  }
  assert.deepEqual(await tableRows(retainedTables), retainedBefore);
  // The anonymous ledger remains writable after the owner store is gone.
  await client.query(`
    INSERT INTO morning_brief_platform_generation_receipts
      (attempt_id, operation, provider, requested_model, outcome, cost_state, started_at, finished_at)
      VALUES ('00000000-0000-4000-8000-000000000002', 'morning-brief', 'historical-provider', 'historical-model', 'invocation_unknown', 'invocation_unknown', '2026-09-21', '2026-09-21');
  `);
  assert.equal(
    (await rows("morning_brief_platform_generation_receipts")).length,
    2,
  );
  console.log(
    "Native Morning Brief storage dropped; cost receipts, workflow schedules, chat and email retained; unexpected dependencies roll back every drop",
  );
} finally {
  await client.query("ROLLBACK");
  await client.end();
}
