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
  const link = randomUUID();
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
  const sourceContext = randomUUID();
  const unmatchedContext = randomUUID();
  await client.query(
    "INSERT INTO chat_agent_run_context(id,source_chat_thread_id,source_agent_id) VALUES($1,$3,$4),($2,$3,$2)",
    [sourceContext, unmatchedContext, sourceThread, sourceAgent],
  );
  await client.query(
    `INSERT INTO telegram_chat_thread_routes(id,telegram_official_user_link_id,chat_id,root_message_id,chat_thread_id)
     SELECT ('00000000-0000-4000-8000-' || lpad(value::text,12,'0'))::uuid,
       $1, '-10042', value::text,
       ('00000000-0000-4000-8000-' || lpad(value::text,12,'0'))::uuid
     FROM generate_series(1,1005) value`,
    [link],
  );
  await client.query(
    `INSERT INTO chat_telegram_context(chat_thread_id,chat_id,message_id,message_thread_id,chat_type,user_link_id,user_link_kind)
     SELECT chat_thread_id, chat_id, root_message_id, 37, 'supergroup', $1, 'official'
     FROM telegram_chat_thread_routes`,
    [link],
  );
  const firstRoute = "00000000-0000-4000-8000-000000000001";
  await client.query(
    `INSERT INTO chat_telegram_context(chat_thread_id,chat_id,message_id,message_thread_id,chat_type,user_link_id,user_link_kind,created_at)
     VALUES($1,'-10042','wrong-owner',999,'supergroup',$2,'official',now()+interval '1 hour')`,
    [firstRoute, randomUUID()],
  );
  const phoneRoute = randomUUID();
  const teamsRoute = randomUUID();
  const githubRoute = randomUUID();
  await client.query(
    "INSERT INTO agentphone_chat_thread_routes(id,agentphone_user_link_id,root_message_id,chat_thread_id) VALUES($1,$2,'root',$1)",
    [phoneRoute, link],
  );
  await client.query(
    "INSERT INTO chat_agentphone_context(chat_thread_id,user_link_id,message_id,is_group,group_id,channel,from_number,to_number,agentphone_agent_id) VALUES($1,$2,'message',true,'group-42','imessage','+15550000001','+15550000002','phone-agent')",
    [phoneRoute, link],
  );
  await client.query(
    "INSERT INTO teams_chat_thread_routes(id,connection_id,conversation_id,thread_id,user_id,chat_thread_id) VALUES($1,$2,'conversation','topic','user',$1)",
    [teamsRoute, link],
  );
  await client.query(
    "INSERT INTO chat_teams_context(chat_thread_id,connection_id,tenant_id,conversation_id,conversation_type,channel_id,activity_id,thread_id,service_url,public_brand,sender_user_id) VALUES($1,$2,'tenant','conversation','channel','channel-42','activity','topic','https://teams.invalid','okou','sender')",
    [teamsRoute, link],
  );
  await client.query(
    "INSERT INTO github_chat_thread_routes(id,installation_id,repo,subject_number,user_id,chat_thread_id) VALUES($1,$2,'example/repo',42,'user',$1)",
    [githubRoute, link],
  );
  await client.query(
    "INSERT INTO chat_github_context(chat_thread_id,repo,subject_number,subject_kind) VALUES($1,'example/repo',42,'pull_request')",
    [githubRoute],
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
  return { firstRoute, sourceContext, unmatchedContext };
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
        "SELECT count(*)::int AS count FROM telegram_chat_thread_routes WHERE message_thread_id=37",
      )
    ).rows[0]?.count,
    1005,
  );
  assert.equal(
    (await client.query("SELECT group_id FROM agentphone_chat_thread_routes"))
      .rows[0]?.group_id,
    "group-42",
  );
  assert.equal(
    (await client.query("SELECT channel_id FROM teams_chat_thread_routes"))
      .rows[0]?.channel_id,
    "channel-42",
  );
  assert.equal(
    (await client.query("SELECT subject_kind FROM github_chat_thread_routes"))
      .rows[0]?.subject_kind,
    "pull_request",
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
export async function verifyRoutingAndReceiptPreparation() {
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
      return statement.includes('CALL "prepare_chat_event_delivery_routes"');
    });
    assert.ok(callIndex > 0);
    for (const statement of statements.slice(0, callIndex)) {
      await client.query(statement);
    }
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT id FROM telegram_chat_thread_routes WHERE id='00000000-0000-4000-8000-000000001001' FOR UPDATE",
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
      "SELECT count(*)::int AS count FROM telegram_chat_thread_routes WHERE delivery_message_id IS NOT NULL",
    );
    assert.equal(committed.rows[0]?.count, 1000);
    await blocker.query("ROLLBACK");
    for (const statement of statements.slice(callIndex)) {
      await client.query(statement);
    }
    await assertPreparedRows(client, prepared);
    await client.query(
      "UPDATE telegram_chat_thread_routes SET message_thread_id=99 WHERE id=$1",
      [prepared.firstRoute],
    );
    // Retry includes concurrent-index recovery and every committed procedure.
    for (const statement of statements) {
      await client.query(statement);
    }
    assert.equal(
      (
        await client.query(
          "SELECT message_thread_id FROM telegram_chat_thread_routes WHERE id=$1",
          [prepared.firstRoute],
        )
      ).rows[0]?.message_thread_id,
      99,
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
      "Bounded routing preparation, scope, historical deletion receipts and migration retry passed\n",
    );
  } finally {
    await blocker.end();
    await client.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.end();
  }
}
