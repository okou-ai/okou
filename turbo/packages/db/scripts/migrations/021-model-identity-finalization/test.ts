import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { z } from "zod";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { agentRuns } from "../../../src/runtime/agent-run";
import { applyPendingMigrations } from "../../migration-runner";
import { validateCanonicalModelSelections } from "../../test-canonical-model-selections-permanent";
import { DRIZZLE_MIGRATE_OUT } from "../../../drizzle.config";
import { apiTestEnvironment } from "../../../../../apps/api/src/__tests__/test-environment";

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
const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
const journal = z
  .object({ entries: z.array(z.object({ tag: z.string(), when: z.number() })) })
  .parse(
    JSON.parse(
      await readFile(`${DRIZZLE_MIGRATE_OUT}/meta/_journal.json`, "utf8"),
    ),
  );
const addition = journal.entries.find((entry) => {
  return entry.tag === "1367_enforce_canonical_model_capture";
});
const validation = journal.entries.find((entry) => {
  return entry.tag === "1368_validate_canonical_model_capture";
});
assert(addition && validation, "final_constraint_migrations_required");
try {
  // Historical operator inputs belong on the prepared Release 1 schema.
  await applyPendingMigrations(sql, { beforeMillis: addition.when });
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
        "../../../src/migrations/1364_prepare_canonical_auto_catalog.sql",
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
  // The historical Pi producer reported the selected alias. Missing usage
  // observations must not turn its upstream preset into a new usage identity.
  const reference = "00000000-0000-4000-8000-000000000006";
  const cancelledAlias = "00000000-0000-4000-8000-000000000007";
  const unsafeAuto = "00000000-0000-4000-8000-000000000008";
  const wrongRuntime = "00000000-0000-4000-8000-000000000009";
  const completedAlias = "00000000-0000-4000-8000-000000000010";
  for (const id of [
    reference,
    cancelledAlias,
    unsafeAuto,
    wrongRuntime,
    completedAlias,
  ]) {
    await db.query(
      `INSERT INTO agent_runs (id,session_id,user_id,org_id,status,prompt,trigger_source,autonomy_budget,
      model_provider,selected_model,model_runtime_provider,model_runtime_model,built_in_model_key_id,launch_snapshot,created_at)
      VALUES ($1,$2,'identity-test-owner','identity-test-org',$3,'alias','web',0,'built-in',$4,'openrouter-codex',$5,$6,'{"schemaVersion":1,"framework":"pi","runnerProfile":"migration-test"}','2026-01-01')`,
      [
        id,
        session,
        id === completedAlias ? "completed" : "cancelled",
        id === unsafeAuto ? "auto" : "okou-1.0-max",
        id === wrongRuntime ? "@preset/unrelated" : "@preset/okou-1-0-max",
        key,
      ],
    );
  }
  function runnerUsage(id: string, provider: string) {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("runner-usage.ts", import.meta.url)),
        id,
        provider,
      ],
      {
        env: { ...env, ...apiTestEnvironment, DATABASE_URL: url.toString() },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
  }
  runnerUsage(reference, "okou-1.0-max");
  runnerUsage(unsafeAuto, "@preset/okou-1-0-max");
  await db.query("DELETE FROM usage_event WHERE run_id=$1", [unsafeAuto]);
  await db.query("DELETE FROM billing_run_attribution WHERE run_id=$1", [
    unsafeAuto,
  ]);
  await db.query("DELETE FROM agent_runs WHERE id=$1", [unsafeAuto]);
  assert.equal(cli("runs", ["--after", alias, "--migrate"]).updated, 1);
  const cancellationPreview = cli("runs", ["--after", reference], true);
  assert.equal(cancellationPreview.classifications.cancelled_alias, 1);
  assert.equal(cancellationPreview.updated, 0);
  assert.equal(cli("runs", ["--after", reference, "--migrate"]).updated, 1);
  const normalizedCancellation = (
    await db.query(
      "SELECT selected_model,model_runtime_model,model_usage_provider FROM agent_runs WHERE id=$1",
      [cancelledAlias],
    )
  ).rows[0];
  assert.deepEqual(normalizedCancellation, {
    selected_model: "auto",
    model_runtime_model: "@preset/okou-1-0-max",
    model_usage_provider: "okou-1.0-max",
  });
  runnerUsage(cancelledAlias, "okou-1.0-max");
  for (const after of [cancelledAlias, wrongRuntime]) {
    const rejected = cli("runs", ["--after", after, "--migrate"]);
    assert.equal(rejected.updated, 0);
    assert.equal(rejected.classifications.no_original_usage_identity, 1);
  }
  await db.query("DELETE FROM agent_runs WHERE id=ANY($1::uuid[])", [
    [wrongRuntime, completedAlias],
  ]);
  const historicalOwner = randomUUID();
  const nativeCodex = randomUUID();
  await db.query(
    `INSERT INTO agent_runs (id,session_id,user_id,org_id,status,prompt,trigger_source,autonomy_budget,model_provider,model_provider_id,selected_model)
    VALUES ($1,$2,'identity-test-owner','identity-test-org','completed','retained owner','web',0,'built-in',$3,'historical-model')`,
    [historicalOwner, session, account],
  );
  await db.query(
    `INSERT INTO agent_runs (id,session_id,user_id,org_id,status,prompt,trigger_source,autonomy_budget,
    model_provider,model_provider_id,model_provider_account_identity,selected_model,model_runtime_provider,model_runtime_model)
    VALUES ($1,$2,'identity-test-owner','identity-test-org','completed','native Codex','web',0,'codex-oauth-token',$3,'exact-account','historical-model','openai-codex','historical-upstream')`,
    [nativeCodex, session, account],
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
  // Finish the retained decision through explicit revocation, then run the
  // independently authorized operator page before constraint installation.
  await db.query(
    `INSERT INTO chat_events (chat_thread_id,seq_id,event_type,revokes_event_id)
    SELECT chat_thread_id,4,'control.revoke',id FROM chat_events WHERE chat_thread_id=$1 AND seq_id=3`,
    [thread],
  );
  assert.equal(cli("events", ["--migrate"]).updated, 1);
  // A completed personal execution may outlive the account without ever having
  // proven upstream identity. Deletion must not force invented capture data.
  const unknownIdentity = randomUUID();
  const historicalProvider = randomUUID();
  const historicalAccount = randomUUID();
  await db.query(
    `INSERT INTO model_providers (id,type,user_id,org_id)
    VALUES ($1,'claude-code-oauth-token','identity-test-owner','identity-test-org')`,
    [historicalProvider],
  );
  await db.query(
    `INSERT INTO model_provider_accounts (id,model_provider_id,type,user_id,org_id,workspace_name)
    VALUES ($1,$2,'claude-code-oauth-token','identity-test-owner','identity-test-org','retained workspace')`,
    [historicalAccount, historicalProvider],
  );
  await db.query(
    `INSERT INTO agent_runs (id,session_id,user_id,org_id,status,prompt,trigger_source,autonomy_budget,
    model_provider,selected_model,model_runtime_provider,model_runtime_model,model_provider_id,model_provider_credential_scope,created_at)
    VALUES ($1,$2,'identity-test-owner','identity-test-org','completed','unknown upstream identity','web',0,
    'claude-code-oauth-token','claude-sonnet-5-5','claude-code-oauth-token','claude-sonnet-5-5',$3,'member','2026-01-01')`,
    [unknownIdentity, session, historicalAccount],
  );
  await db.query("DELETE FROM model_providers WHERE id=$1", [
    historicalProvider,
  ]);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM model_provider_accounts WHERE id=$1",
        [historicalAccount],
      )
    ).rows[0].n,
    0,
  );
  const unknownBefore = (
    await db.query(
      "SELECT model_provider_id,model_provider_account_identity,model_runtime_provider,model_runtime_model FROM agent_runs WHERE id=$1",
      [unknownIdentity],
    )
  ).rows[0];
  assert.equal(unknownBefore.model_provider_id, historicalAccount);
  assert.equal(unknownBefore.model_provider_account_identity, null);

  const partial = randomUUID();
  await db.query(
    `INSERT INTO agent_runs (id,session_id,user_id,org_id,status,prompt,trigger_source,autonomy_budget,model_runtime_provider)
    VALUES ($1,$2,'identity-test-owner','identity-test-org','completed','unknown','web',0,'codex-oauth-token')`,
    [partial, session],
  );
  const preflight = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("backfill.ts", import.meta.url)),
      "--mode",
      "preflight",
      "--before",
      "2026-01-02T00:00:00Z",
    ],
    {
      env: { ...env, PGOPTIONS: "-c default_transaction_read_only=on" },
      encoding: "utf8",
    },
  );
  assert.equal(preflight.status, 2, preflight.stderr);
  assert.equal(JSON.parse(preflight.stdout).agent_runs_runtime_pair_check, 1);
  assert.equal(
    JSON.parse(preflight.stdout).agent_runs_personal_capture_check,
    0,
  );
  await applyPendingMigrations(sql, { beforeMillis: validation.when });
  assert.equal(
    (
      await db.query(`SELECT bool_and(NOT convalidated) AS pending FROM pg_constraint WHERE conname IN
    ('agent_runs_runtime_pair_check','chat_events_canonical_selection_check')`)
    ).rows[0].pending,
    true,
  );
  // NOT VALID is immediately enforced on new writes, not a writer grace period.
  await assert.rejects(
    db.query(`UPDATE agent_runs SET prompt='touch partial' WHERE id=$1`, [
      partial,
    ]),
    /runtime_pair_check/,
  );
  await assert.rejects(applyPendingMigrations(sql), /runtime_pair_check/);
  await db.query(
    `UPDATE agent_runs SET model_runtime_provider=NULL WHERE id=$1`,
    [partial],
  );
  await applyPendingMigrations(sql);
  assert.equal(
    (
      await db.query(`SELECT bool_and(convalidated) AS ready FROM pg_constraint WHERE conname IN
    ('agent_runs_runtime_pair_check','chat_events_canonical_selection_check')`)
    ).rows[0].ready,
    true,
  );

  assert.deepEqual(
    (
      await db.query(
        "UPDATE agent_runs SET summary='retained after account deletion' WHERE id=$1 RETURNING model_provider_id,model_provider_account_identity,model_runtime_provider,model_runtime_model",
        [unknownIdentity],
      )
    ).rows[0],
    unknownBefore,
  );
  // Current admission also supports accounts without upstream profile evidence.
  // Complete executable capture still requires runtime and the local account ID.
  const currentProvider = randomUUID();
  const currentAccount = randomUUID();
  const currentUnknown = randomUUID();
  await db.query(
    `INSERT INTO model_providers (id,type,user_id,org_id)
    VALUES ($1,'claude-code-oauth-token','identity-test-owner','identity-test-org')`,
    [currentProvider],
  );
  await db.query(
    `INSERT INTO model_provider_accounts (id,model_provider_id,type,user_id,org_id)
    VALUES ($1,$2,'claude-code-oauth-token','identity-test-owner','identity-test-org')`,
    [currentAccount, currentProvider],
  );
  await db.query(
    `INSERT INTO agent_runs (id,session_id,user_id,org_id,status,prompt,trigger_source,autonomy_budget,
    model_provider,selected_model,model_runtime_provider,model_runtime_model,model_provider_id,model_provider_credential_scope,launch_snapshot)
    VALUES ($1,$2,'identity-test-owner','identity-test-org','pending','current unknown identity','web',0,
    'claude-code-oauth-token','claude-sonnet-5-5','claude-code-oauth-token','claude-sonnet-5-5',$3,'member','{"schemaVersion":3,"framework":"claude-code","runnerProfile":"test"}')`,
    [currentUnknown, session, currentAccount],
  );
  for (const assignment of [
    "model_provider_account_identity=''",
    "model_provider_id=NULL",
    "selected_model='auto'",
    "model_runtime_provider='anthropic'",
  ]) {
    await assert.rejects(
      db.query(`UPDATE agent_runs SET ${assignment} WHERE id=$1`, [
        currentUnknown,
      ]),
      /personal_capture_check/,
    );
  }
  await assert.rejects(
    db.query(
      "UPDATE agent_runs SET model_runtime_provider=NULL,model_runtime_model=NULL WHERE id=$1",
      [currentUnknown],
    ),
    /personal_capture_check/,
  );

  await assert.rejects(
    db.query("UPDATE agent_runs SET status='pending' WHERE id=$1", [
      historicalOwner,
    ]),
    /builtin_capture_owner_check/,
  );
  await assert.rejects(
    db.query(
      "UPDATE agent_runs SET model_runtime_provider='openrouter-codex',model_runtime_model='unexpected' WHERE id=$1",
      [historicalOwner],
    ),
    /builtin_capture_owner_check/,
  );
  await assert.rejects(
    db.query(
      "UPDATE agent_runs SET model_runtime_provider='anthropic' WHERE id=$1",
      [nativeCodex],
    ),
    /personal_capture_check/,
  );
  assert.equal(
    (
      await db.query("SELECT model_provider_id FROM agent_runs WHERE id=$1", [
        historicalOwner,
      ])
    ).rows[0].model_provider_id,
    account,
  );

  // Release 1's runtime mapping/column factory is unchanged: execute its actual
  // implicit SELECT, UPDATE RETURNING and INSERT column lists after tightening.
  const orm = drizzle(db);
  const original = await orm
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, legacy));
  const returned = await orm
    .update(agentRuns)
    .set({ summary: "late finalization" })
    .where(eq(agentRuns.id, legacy))
    .returning();
  assert.equal(
    returned[0]?.modelUsageProvider,
    original[0]?.modelUsageProvider,
  );
  const inserted = await orm
    .insert(agentRuns)
    .values({
      id: randomUUID(),
      sessionId: session,
      userId: "identity-test-owner",
      orgId: "identity-test-org",
      status: "completed",
      prompt: "uncaptured",
    })
    .returning();
  assert.equal(inserted[0]?.selectedModel, null);
  assert.equal(inserted[0]?.modelRuntimeModel, null);
  await validateCanonicalModelSelections(url.toString());
  for (const mode of ["preflight", "verify"]) {
    const reconciliation = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("backfill.ts", import.meta.url)),
        "--mode",
        mode,
        "--before",
        "2026-01-02T00:00:00Z",
      ],
      {
        env: { ...env, PGOPTIONS: "-c default_transaction_read_only=on" },
        encoding: "utf8",
      },
    );
    assert.equal(reconciliation.status, 0, reconciliation.stderr);
    const report = JSON.parse(reconciliation.stdout);
    if (mode === "preflight")
      assert.equal(report.agent_runs_runtime_pair_check, 0);
    else assert.equal(report.compacted_managed_model_rows, 1);
  }
  console.log(
    "model identity: prepared operator pages, reconciliation, separately committed CHECK/VALIDATE, immediate new-write enforcement, lifecycle exceptions and Release 1 ORM shapes passed",
  );
} finally {
  await sql.end();
  await db.end();
  await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end();
}
