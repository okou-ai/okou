import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { z } from "zod";

const databaseUrl = process.env.DATABASE_URL;
assert(databaseUrl, "DATABASE_URL_required_for_disposable_test_database");
const admin = new Client({ connectionString: databaseUrl });
await admin.connect();
const name = `identity021_${randomUUID().replaceAll("-", "")}`;
await admin.query(`CREATE DATABASE "${name}"`);
const url = new URL(databaseUrl);
url.pathname = `/${name}`;
const env = { ...process.env, DATABASE_URL: url.toString() };
const db = new Client({ connectionString: url.toString() });
await db.connect();
const reportSchema = z.object({
  scanned: z.number(),
  updated: z.number(),
  next_cursor: z.string().nullable(),
  classifications: z.record(z.string(), z.number()),
});
function cli(mode: string, extra: string[] = [], readOnly = false) {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("backfill.ts", import.meta.url)),
      "--mode",
      mode,
      "--before",
      "2026-01-02T00:00:00Z",
      "--limit",
      "1",
      ...extra,
    ],
    {
      env: {
        ...env,
        ...(readOnly
          ? { PGOPTIONS: "-c default_transaction_read_only=on" }
          : {}),
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return reportSchema.parse(JSON.parse(result.stdout));
}
try {
  const migrated = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("../../migrate.ts", import.meta.url)),
    ],
    { env, encoding: "utf8" },
  );
  assert.equal(migrated.status, 0, migrated.stderr);
  const session = randomUUID();
  await db.query(
    "INSERT INTO agent_sessions (id,user_id,org_id) VALUES ($1,'identity-test-owner','identity-test-org')",
    [session],
  );
  const legacy = "00000000-0000-4000-8000-000000000001";
  const personal = "00000000-0000-4000-8000-000000000002";
  const missing = "00000000-0000-4000-8000-000000000003";
  const newer = "00000000-0000-4000-8000-000000000004";
  const account = randomUUID();
  const key = randomUUID();
  // Historical operational inputs are constructed against real current constraints.
  // The outgoing writer may omit both new capture columns after expansion.
  await db.query(
    `INSERT INTO agent_runs (id,session_id,user_id,org_id,status,prompt,trigger_source,autonomy_budget,
    model_provider,selected_model,model_runtime_provider,model_runtime_model,built_in_model_key_id,created_at)
    VALUES ($1,$2,'identity-test-owner','identity-test-org','completed','retained','web',0,'built-in','okou-1.0','openrouter-codex','@preset/original',$3,'2026-01-01')`,
    [legacy, session, key],
  );
  for (const [id, createdAt] of [
    [personal, "2026-01-01"],
    [missing, "2026-01-01"],
    [newer, "2026-01-03"],
  ]) {
    await db.query(
      `INSERT INTO agent_runs (id,session_id,user_id,org_id,status,prompt,trigger_source,autonomy_budget,
      model_provider,selected_model,model_provider_id,model_provider_account_identity,created_at)
      VALUES ($1,$2,'identity-test-owner','identity-test-org','pending','retained','web',0,'codex-oauth-token','gpt-6-sol',$3,'exact-account',$4)`,
      [id, session, account, createdAt],
    );
  }
  await db.query(
    `INSERT INTO runner_job_queue (run_id,runner_group,expires_at,execution_context) VALUES ($1,'test',now(),$2)`,
    [
      personal,
      JSON.stringify({
        environment: { OPENAI_MODEL: "gpt-6-original" },
        secretConnectorMetadataMap: {
          CHATGPT_ACCESS_TOKEN: {
            sourceType: "model-provider",
            sourceUserId: "identity-test-owner",
            sourceId: account,
            metadataKey: "codex-oauth-token",
          },
        },
      }),
    ],
  );
  const dry = cli("runs", [], true);
  assert.equal(dry.updated, 0);
  assert.equal(dry.classifications.legacy_auto, 1);
  const competing = new Client({ connectionString: url.toString() });
  await competing.connect();
  try {
    const batchSql = await readFile(
      new URL("runs.sql", import.meta.url),
      "utf8",
    );
    const reports = await Promise.all([
      db.query(batchSql, ["2026-01-02T00:00:00Z", null, 1, true]),
      competing.query(batchSql, ["2026-01-02T00:00:00Z", null, 1, true]),
    ]);
    const updatesByPage = new Map<string | null, number>();
    for (const result of reports) {
      const report = reportSchema.parse(result.rows[0]);
      updatesByPage.set(
        report.next_cursor,
        (updatesByPage.get(report.next_cursor) ?? 0) + report.updated,
      );
    }
    assert.equal(updatesByPage.get(legacy), 1);
    assert(
      [...updatesByPage.values()].every((updated) => {
        return updated <= 1;
      }),
      "a competing pass may advance to the next eligible identity, but cannot replace a capture twice",
    );
  } finally {
    await competing.end();
  }
  const capture = (
    await db.query("SELECT * FROM agent_runs WHERE id=$1", [legacy])
  ).rows[0];
  assert.equal(capture.selected_model, "auto");
  assert.equal(capture.model_runtime_model, "@preset/original");
  assert.equal(capture.model_usage_provider, "okou-1.0");
  assert.equal(capture.model_long_context_min_total_input_tokens, 272001);
  const recovered = cli("runs", ["--after", legacy, "--migrate"]);
  assert(recovered.updated <= 1);
  const bound = (
    await db.query("SELECT * FROM agent_runs WHERE id=$1", [personal])
  ).rows[0];
  assert.equal(bound.model_runtime_model, "gpt-6-original");
  assert.equal(bound.model_runtime_provider, "codex-oauth-token");
  assert.equal(bound.built_in_model_key_id, null);
  assert.equal(bound.model_usage_provider, null);
  const blocked = cli("runs", ["--after", personal, "--migrate"]);
  assert.equal(blocked.updated, 0);
  assert.equal(blocked.scanned, 1);
  assert.equal(blocked.classifications.no_account_bound_execution_evidence, 1);
  assert.equal(
    cli("runs", ["--after", missing]).scanned,
    0,
    "cutoff excludes new producers",
  );
  assert.equal(
    cli("runs", ["--migrate"]).updated,
    0,
    "repeat does not reinterpret captures",
  );
  const before = (
    await db.query("SELECT * FROM model_routes WHERE model='okou-1.0'")
  ).rows;
  await db.query(
    await readFile(
      new URL(
        "../../../src/migrations/1363_prepare_canonical_auto_catalog.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.deepEqual(
    (await db.query("SELECT * FROM model_routes WHERE model='okou-1.0'")).rows,
    before,
    "outgoing route remains unchanged",
  );
  assert.equal(
    (await db.query("SELECT count(*) FROM model_routes WHERE model='auto'"))
      .rows[0].count,
    "1",
  );
  // Compacted original usage is independent execution evidence for replacement aliases.
  const alias = "00000000-0000-4000-8000-000000000005";
  await db.query(
    `INSERT INTO agent_runs (id,session_id,user_id,org_id,status,prompt,trigger_source,autonomy_budget,
    model_provider,selected_model,model_runtime_provider,model_runtime_model,built_in_model_key_id,created_at)
    VALUES ($1,$2,'identity-test-owner','identity-test-org','completed','alias','web',0,'built-in','okou-1.0-max','openrouter-codex','@preset/original',$3,'2026-01-01')`,
    [alias, session, key],
  );
  await db.query(
    `INSERT INTO usage_event_hourly_rollup (processed_hour,org_id,user_id,run_id,kind,provider,category,quantity,credits_charged)
    VALUES ('2026-01-01','identity-test-org','identity-test-owner',$1,'model','original-alias-provider','input.long_context',10,7)`,
    [alias],
  );
  const originalUsage = (
    await db.query("SELECT * FROM usage_event_hourly_rollup WHERE run_id=$1", [
      alias,
    ])
  ).rows;
  assert.equal(cli("runs", ["--after", newer, "--migrate"]).updated, 1);
  const aliasCapture = (
    await db.query("SELECT * FROM agent_runs WHERE id=$1", [alias])
  ).rows[0];
  assert.equal(aliasCapture.selected_model, "auto");
  assert.equal(aliasCapture.model_usage_provider, "original-alias-provider");
  assert.deepEqual(
    (
      await db.query(
        "SELECT * FROM usage_event_hourly_rollup WHERE run_id=$1",
        [alias],
      )
    ).rows,
    originalUsage,
  );
  const thread = randomUUID();
  await db.query(
    "INSERT INTO chat_threads (id,user_id) VALUES ($1,'identity-test-owner')",
    [thread],
  );
  const event = randomUUID();
  const untouched = randomUUID();
  const payload = {
    userMessage: {
      version: 1,
      parts: [
        { type: "text", text: "preserve" },
        { type: "model", selectedModel: "okou-1.0-pro", serviceTier: "fast" },
      ],
    },
    preserved: { nativeReference: "immutable" },
  };
  await db.query(
    `INSERT INTO chat_events (id,chat_thread_id,seq_id,event_type,context_type,run_id,model_selection,payload,created_at)
    VALUES ($1,$2,1,'input.prompt','web',$3,'{"selectedModel":"okou-1.0-max"}',$4,'2026-01-01')`,
    [event, thread, legacy, JSON.stringify(payload)],
  );
  await db.query(
    `INSERT INTO chat_events (id,chat_thread_id,seq_id,event_type,payload,created_at) VALUES ($1,$2,2,'output.message','{"content":"unchanged"}','2026-01-01')`,
    [untouched, thread],
  );
  assert.equal(cli("events", [], true).updated, 0);
  assert.equal(cli("events", ["--migrate"]).updated, 1);
  const row = (await db.query("SELECT * FROM chat_events WHERE id=$1", [event]))
    .rows[0];
  assert.equal(row.model_selection.selectedModel, "auto");
  assert.deepEqual(row.payload.preserved, payload.preserved);
  assert.deepEqual(row.payload.userMessage.parts, [
    { type: "text", text: "preserve" },
    { type: "model", selectedModel: "auto" },
  ]);
  assert.equal(
    (
      await db.query("SELECT model_selection FROM chat_events WHERE id=$1", [
        untouched,
      ])
    ).rows[0].model_selection,
    null,
  );
  assert.equal(cli("events", ["--migrate"]).scanned, 0);
  await db.query(
    `INSERT INTO chat_events (id,chat_thread_id,seq_id,event_type,context_type,model_selection,payload,created_at)
    VALUES ($1,$2,3,'input.prompt','web','{"selectedModel":"okou-1.0-pro"}',$3,'2026-01-01')`,
    [randomUUID(), thread, JSON.stringify(payload)],
  );
  assert.equal(
    cli("events", ["--migrate"]).classifications.unconsumed_decision,
    1,
  );
  console.log(
    "model identity finalization: real schema, read-only previews, bounded commits/concurrent replay, cutoff, execution/account provenance, compacted history preservation, optional decisions and catalog compatibility passed",
  );
} finally {
  await db.end();
  await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end();
}
