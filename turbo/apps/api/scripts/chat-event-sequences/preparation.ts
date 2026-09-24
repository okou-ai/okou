import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "pg";
import { sequenceMigration } from "./fixture";

const tables = [
  "agents",
  "chat_threads",
  "chat_thread_events",
  "chat_agent_run_context",
  "chat_telegram_context",
  "telegram_chat_thread_routes",
  "chat_agentphone_context",
  "agentphone_chat_thread_routes",
  "chat_teams_context",
  "teams_chat_thread_routes",
  "chat_github_context",
  "github_chat_thread_routes",
  "chat_slack_context",
  "chat_feishu_context",
  "chat_automation_context",
  "account_erasure_jobs",
  "background_jobs",
  "chat_content_erasure_subjects",
];

async function seedPreparationRows(client: Client) {
  const sourceAgent = randomUUID();
  const sourceThread = randomUUID();
  await client.query(
    "INSERT INTO agents(id,org_id,owner,name) VALUES($1,'source-org','source-user','source')",
    [sourceAgent],
  );
  await client.query(
    "INSERT INTO chat_threads(id,user_id,agent_id) VALUES($1,'source-user',$2)",
    [sourceThread, sourceAgent],
  );
  await client.query(
    `INSERT INTO chat_agent_run_context(id,source_chat_thread_id,source_agent_id)
     SELECT ('00000000-0000-4000-8000-' || lpad(value::text,12,'0'))::uuid, $1, $2
     FROM generate_series(1,1005) value`,
    [sourceThread, sourceAgent],
  );
  const sourceContext = "00000000-0000-4000-8000-000000000001";
  const unmatchedContext = randomUUID();
  await client.query(
    "INSERT INTO chat_agent_run_context(id,source_chat_thread_id,source_agent_id) VALUES($1,$2,$1)",
    [unmatchedContext, sourceThread],
  );
  await client.query(`INSERT INTO account_erasure_jobs(
    id,subject_kind,subject_id,generation,authority_id,decision_ref,decision_sequence,
    confirmation_ref,disposition_version,requested_at,deadline_at,state)
    SELECT ('00000000-0000-4000-8000-' || lpad(value::text,12,'0'))::uuid,
      'user','deleted-user-' || value,1,'11111111-1111-4111-8111-111111111111',
      gen_random_uuid(),value,gen_random_uuid(),1,now()-interval '1 day',now(),'verified_erased'
    FROM generate_series(1,1005) value`);
  await client.query(`INSERT INTO background_jobs(id,kind,handler_version,user_id,org_id,input,status,completed_at)
    VALUES(gen_random_uuid(),'clerk-user-deletion',1,'clerk-deleted-user','deleted-org','{}','completed',now()),
    (gen_random_uuid(),'clerk-user-deletion',1,'still-pending','deleted-org','{}','pending',NULL),
    (gen_random_uuid(),'unrelated',1,'unrelated-user','deleted-org','{}','completed',now())`);
  await client.query(`INSERT INTO chat_content_erasure_subjects(subject_kind,subject_id,source_reference,confirmed_at,completed_at)
    VALUES('user','deleted-user-1','original-receipt','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z')`);
  return { sourceContext, unmatchedContext };
}

async function assertPreparedRows(
  client: Client,
  prepared: {
    readonly sourceContext: string;
    readonly unmatchedContext: string;
  },
) {
  assert.equal(
    (
      await client.query(
        "SELECT count(*)::int AS count FROM chat_agent_run_context WHERE source_org_id='source-org'",
      )
    ).rows[0]?.count,
    1005,
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT source_user_id,source_org_id FROM chat_agent_run_context WHERE id=$1",
        [prepared.sourceContext],
      )
    ).rows[0],
    {
      source_user_id: "source-user",
      source_org_id: "source-org",
    },
  );
  assert.equal(
    (
      await client.query(
        "SELECT source_user_id FROM chat_agent_run_context WHERE id=$1",
        [prepared.unmatchedContext],
      )
    ).rows[0]?.source_user_id,
    null,
  );
  assert.equal(
    (
      await client.query(
        "SELECT count(*)::int AS count FROM chat_content_erasure_subjects",
      )
    ).rows[0]?.count,
    1006,
  );
  const original = (
    await client.query(
      "SELECT source_reference,confirmed_at,completed_at FROM chat_content_erasure_subjects WHERE subject_id='deleted-user-1'",
    )
  ).rows[0];
  assert.equal(original?.source_reference, "original-receipt");
  assert.equal(
    original?.confirmed_at.toISOString(),
    "2026-01-01T00:00:00.000Z",
  );
  assert.equal(
    original?.completed_at.toISOString(),
    "2026-01-02T00:00:00.000Z",
  );
}

/** Exercise deployed preparation SQL against real, populated schema shapes. */
export async function verifyOwnershipAndReceiptPreparation() {
  assert.ok(process.env.DATABASE_URL);
  const base = new URL(process.env.DATABASE_URL);
  assert.ok(["127.0.0.1", "localhost", "postgres"].includes(base.hostname));
  const databaseName = `chat_preparation_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  const admin = new Client({ connectionString: base.toString() });
  const client = new Client({ connectionString: url.toString() });
  const blocker = new Client({ connectionString: url.toString() });

  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    await promisify(execFile)(
      "node",
      ["--import", "tsx", "scripts/migrate.ts"],
      {
        cwd: fileURLToPath(new URL("../../../../packages/db", import.meta.url)),
        env: { ...process.env, DATABASE_URL: url.toString() },
        maxBuffer: 20 * 1024 * 1024,
      },
    );
    await client.connect();
    await blocker.connect();
    await client.query("CREATE SCHEMA preparation");
    // Clones retain actual migrated types, defaults and checks. FK roots are
    // unrelated to the pre-API migration input, so their rows are not copied.
    // Exclude public from search_path: replayed index DDL must stay owned here.
    await client.query("SET search_path TO preparation");
    await blocker.query("SET search_path TO preparation");
    for (const table of tables) {
      await client.query(
        `CREATE TABLE preparation.${table} (LIKE public.${table} INCLUDING ALL)`,
      );
    }
    const prepared = await seedPreparationRows(client);

    const statements = await sequenceMigration(
      "prepare_chat_event_routing_and_cleanup",
    );
    const callIndex = statements.findIndex((statement) => {
      return statement.includes(
        'CALL "backfill_chat_agent_run_context_ownership"',
      );
    });
    assert.ok(callIndex > 0);
    for (const statement of statements.slice(0, callIndex)) {
      await client.query(statement);
    }
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT id FROM chat_agent_run_context WHERE id='00000000-0000-4000-8000-000000001001' FOR UPDATE",
    );
    await client.query("SET lock_timeout='100ms'");
    await assert.rejects(
      client.query(statements[callIndex] ?? ""),
      (error: unknown) => {
        return (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "55P03"
        );
      },
    );
    const committed = await client.query(
      "SELECT count(*)::int AS count FROM chat_agent_run_context WHERE source_user_id IS NOT NULL",
    );
    assert.equal(committed.rows[0]?.count, 1000);
    await blocker.query("ROLLBACK");
    for (const statement of statements.slice(callIndex)) {
      await client.query(statement);
    }
    await assertPreparedRows(client, prepared);
    await client.query(
      "UPDATE chat_agent_run_context SET source_user_id='retained-user' WHERE id=$1",
      [prepared.sourceContext],
    );
    // Retry includes concurrent-index recovery and every committed procedure.
    for (const statement of statements) {
      await client.query(statement);
    }
    assert.equal(
      (
        await client.query(
          "SELECT source_user_id FROM chat_agent_run_context WHERE id=$1",
          [prepared.sourceContext],
        )
      ).rows[0]?.source_user_id,
      "retained-user",
    );
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::int AS count FROM chat_content_erasure_subjects",
        )
      ).rows[0]?.count,
      1006,
    );
    process.stdout.write(
      "Bounded ownership preparation, scope, historical deletion receipts and migration retry passed\n",
    );
  } finally {
    await blocker.end();
    await client.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.end();
  }
}
