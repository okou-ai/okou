import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { array, guid, object, record, string, unknown } from "zod";

/** Transition coverage for the fixed, explicitly abandoned historical cohort. */
export async function validateHistoricalRunCleanup(databaseUrl: string) {
  const source = await readFile(
    new URL(
      "../src/migrations/1477_retire_historical_run_callbacks.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const manifest =
    /run_ids constant uuid\[\] := ARRAY\[([\s\S]+?)\]::uuid\[\]/.exec(source);
  assert.ok(manifest);
  const runIds = array(guid())
    .length(95)
    .parse(
      [
        ...string()
          .parse(manifest[1])
          .matchAll(/'([0-9a-f-]{36})'/g),
      ].map((match) => {
        return match[1];
      }),
    );
  assert.equal(new Set(runIds).size, 95);
  const firstRunId = guid().parse(runIds[0]);
  const generationRunId = "bed32393-9bd5-4720-952a-5cd717411cdc";
  const generationId = "913d017a-8abe-4124-9377-0861c9ce9e66";
  const controlId = randomUUID();
  const agentId = randomUUID();
  const threadId = randomUUID();
  const extraBilledId = guid().parse(runIds[94]);
  const billedIds = [...runIds.slice(0, 23), generationRunId, extraBilledId];
  const owner = `historical-cleanup-${randomUUID()}`;
  const org = `historical-cleanup-org-${randomUUID()}`;
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  async function readState() {
    const result = await client.query(
      `SELECT jsonb_build_object(
        'runs', (SELECT jsonb_agg(to_jsonb(r) ORDER BY id)
          FROM agent_runs r WHERE user_id = $1),
        'callbacks', (SELECT jsonb_agg(to_jsonb(c) ORDER BY id)
          FROM agent_run_callbacks c WHERE run_id = ANY($2::uuid[])),
        'billing', (SELECT jsonb_agg(to_jsonb(b) ORDER BY run_id)
          FROM billing_run_attribution b WHERE user_id = $1),
        'raw', (SELECT jsonb_agg(to_jsonb(u) ORDER BY id)
          FROM usage_event u WHERE user_id = $1),
        'hourly', (SELECT jsonb_agg(to_jsonb(u) ORDER BY id)
          FROM usage_event_hourly_rollup u WHERE user_id = $1),
        'jobs', (SELECT jsonb_agg(to_jsonb(j) - 'run_id' - 'billing_run_id'
            - 'billing_context' ORDER BY id)
          FROM built_in_generation_jobs j WHERE id = $3::uuid),
        'threads', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id)
          FROM chat_threads t WHERE user_id = $1),
        'files', (SELECT jsonb_agg(to_jsonb(f) ORDER BY id)
          FROM run_uploaded_files f WHERE user_id = $1),
        'outputs', (SELECT jsonb_agg(to_jsonb(m) ORDER BY run_id)
          FROM chat_output_materializations m WHERE run_id = ANY($2::uuid[])),
        'admissions', (SELECT jsonb_agg(to_jsonb(a) ORDER BY id)
          FROM run_built_in_admissions a WHERE run_id = ANY($2::uuid[])),
        'job_identity', (SELECT jsonb_build_object('run_id', run_id,
            'billing_run_id', billing_run_id, 'billing_context', billing_context)
          FROM built_in_generation_jobs WHERE id = $3::uuid)
      ) AS state`,
      [owner, [...runIds, controlId], generationId],
    );
    return object({ state: record(string(), unknown()) }).parse(result.rows[0])
      .state;
  }

  try {
    await client.query("SET statement_timeout = '2s'");
    await client.query(
      `INSERT INTO agents (id, org_id, owner, name)
      VALUES ($1, $2, $3, 'historical-cleanup-fixture')`,
      [agentId, org, owner],
    );
    await client.query(
      `INSERT INTO chat_threads (id, user_id, agent_id, framework,
        framework_session_id, framework_session_run_id)
      VALUES ($1, $2, $3, 'codex', 'preserved-native-session', $4)`,
      [threadId, owner, agentId, firstRunId],
    );
    await client.query(
      `INSERT INTO agent_runs (id, user_id, org_id, agent_id, chat_thread_id,
        status, prompt, trigger_source, autonomy_budget, created_at, completed_at, result)
      SELECT id, $2, $3, $4, $5,
        CASE WHEN id = $6::uuid THEN 'completed'
          WHEN i = 50 THEN 'cancelled'
          WHEN i % 3 = 2 THEN 'failed'
          WHEN i % 3 = 0 THEN 'cancelled' ELSE 'completed' END,
        '', 'web', 0, timestamp '2026-05-01',
        CASE WHEN i = 50 THEN NULL ELSE timestamp '2026-05-02' END,
        '{"test":"abandoned result"}'::jsonb
      FROM unnest($1::uuid[]) WITH ORDINALITY AS targets(id, i)`,
      [runIds, owner, org, agentId, threadId, generationRunId],
    );
    await client.query(
      `INSERT INTO agent_runs (id, user_id, org_id, agent_id, chat_thread_id,
        status, prompt, trigger_source, autonomy_budget, created_at, completed_at)
      VALUES ($1, $2, $3, $4, $5, 'completed', '', 'web', 0,
        timestamp '2026-04-01', timestamp '2026-04-02')`,
      [controlId, owner, org, agentId, threadId],
    );
    await client.query(
      `INSERT INTO agent_run_callbacks (run_id, internal_kind, status, created_at)
      SELECT id, 'chat', 'pending', timestamp '2026-05-01'
      FROM unnest($1::uuid[]) AS targets(id)`,
      [[...runIds, controlId]],
    );
    await client.query(
      `INSERT INTO agent_run_callbacks (run_id, internal_kind, status, delivered_at)
      VALUES ($1, 'workflow-automation:cron', 'pending', NULL),
        ($2, 'chat', 'delivered', timestamp '2026-05-02'),
        ($2, 'chat', 'delivered', timestamp '2026-05-02')`,
      [extraBilledId, firstRunId],
    );
    await client.query(
      `INSERT INTO billing_run_attribution (run_id, org_id, user_id,
        run_started_at, source, thread_id, thread_context, usage_observed,
        run_terminal_status, run_completed_at, run_lifecycle_context)
      SELECT id, org_id, user_id, created_at, 'chat', chat_thread_id, 'thread',
        true, status, completed_at, 'captured'
      FROM agent_runs WHERE id = ANY($1::uuid[])`,
      [billedIds],
    );
    await client.query(
      `INSERT INTO built_in_generation_jobs (id, type, status, org_id,
        user_id, run_id, request, result, created_at, completed_at)
      VALUES ($1, 'image', 'completed', $2, $3, $4, '{}',
        '{"test":"preserved image"}', timestamp '2026-05-01', timestamp '2026-05-02')`,
      [generationId, org, owner, generationRunId],
    );
    await client.query(
      `INSERT INTO usage_event_hourly_rollup (id, processed_hour, org_id,
        user_id, run_id, billing_run_id, billing_anchor_at, billing_context,
        kind, provider, category, quantity, credits_charged)
      SELECT md5($2 || i)::uuid, timestamp '2026-05-02', $3, $2,
        ($1::uuid[])[1 + (i - 1) % 24], ($1::uuid[])[1 + (i - 1) % 24],
        timestamp '2026-05-01', 'run', 'image', 'fixture-provider',
        'output_image', 1, 36 FROM generate_series(1, 95) i`,
      [billedIds, owner, org],
    );
    await client.query(
      `INSERT INTO usage_event (idempotency_key, run_id, billing_run_id,
        billing_anchor_at, billing_context, org_id, user_id, kind, provider,
        category, quantity, credits_charged, status, processed_at)
      VALUES ($1, $2, $2, timestamp '2026-05-01', 'run', $3, $4,
        'model', 'fixture-provider', 'input', 1, 7, 'charged', timestamp '2026-05-02')`,
      [randomUUID(), extraBilledId, org, owner],
    );
    await client.query(
      `INSERT INTO run_uploaded_files
        (run_id, chat_thread_id, source, external_id, user_id, org_id)
      VALUES ($1, $2, 'web', $3, $4, $5)`,
      [firstRunId, threadId, randomUUID(), owner, org],
    );
    await client.query(
      `INSERT INTO chat_output_materializations (run_id, latest_result_text)
      VALUES ($1, 'abandoned output')`,
      [generationRunId],
    );
    await client.query(
      `INSERT INTO run_built_in_admissions (run_id, kind, status, completed_at, expires_at)
      VALUES ($1, 'image', 'completed', timestamp '2026-05-02', timestamp '2026-05-03')`,
      [generationRunId],
    );

    const blockedCases = [
      {
        name: "running target",
        setup: "UPDATE agent_runs SET status = 'running' WHERE id = $1",
        cleanup: "UPDATE agent_runs SET status = 'completed' WHERE id = $1",
      },
      {
        name: "active runner",
        setup: `INSERT INTO active_agent_runs (run_id, org_id, user_id, last_heartbeat_at)
          SELECT id, org_id, user_id, now() FROM agent_runs WHERE id = $1`,
        cleanup: "DELETE FROM active_agent_runs WHERE run_id = $1",
      },
      {
        name: "queued runner",
        setup: `INSERT INTO runner_job_queue (run_id, runner_group, execution_context, expires_at)
          VALUES ($1, 'fixture', '{}', now() + interval '1 hour')`,
        cleanup: "DELETE FROM runner_job_queue WHERE run_id = $1",
      },
      {
        name: "unsettled usage",
        setup: `INSERT INTO usage_event (idempotency_key, run_id, billing_run_id,
          billing_anchor_at, billing_context, org_id, user_id, kind, provider,
          category, quantity, status)
          SELECT gen_random_uuid(), id, id, created_at, 'run', org_id, user_id,
            'model', 'fixture-provider', 'input', 1, 'pending' FROM agent_runs WHERE id = $1`,
        cleanup:
          "DELETE FROM usage_event WHERE run_id = $1 AND status = 'pending'",
      },
      {
        name: "active generation admission",
        setup: `INSERT INTO run_built_in_admissions (run_id, kind, expires_at)
          VALUES ($1, 'image', now() + interval '1 hour')`,
        cleanup:
          "DELETE FROM run_built_in_admissions WHERE run_id = $1 AND status = 'active'",
      },
      {
        name: "pending cancellation recovery",
        setup: `UPDATE agent_runs SET status = 'cancelled', started_at = created_at,
          cancellation_recovery_completed = false WHERE id = $1`,
        cleanup: `UPDATE agent_runs SET status = 'completed', started_at = NULL,
          cancellation_recovery_completed = NULL WHERE id = $1`,
      },
      {
        name: "unsettled Router correlation",
        setup:
          "INSERT INTO data_router_requests (request_id, run_id) VALUES (gen_random_uuid(), $1)",
        cleanup: "DELETE FROM data_router_requests WHERE run_id = $1",
      },
      {
        name: "legacy blob retain",
        setup:
          "UPDATE agent_runs SET legacy_conversation_history_hash = repeat('f', 64) WHERE id = $1",
        cleanup:
          "UPDATE agent_runs SET legacy_conversation_history_hash = NULL WHERE id = $1",
      },
    ];
    for (const scenario of blockedCases) {
      await client.query(scenario.setup, [firstRunId]);
      const before = await readState();
      await assert.rejects(client.query(source), { code: "23514" });
      assert.deepEqual(await readState(), before, scenario.name);
      await client.query(scenario.cleanup, [firstRunId]);
    }
    for (const [column, changed, original] of [
      ["user_id", `${owner}-foreign`, owner],
      ["billing_run_id", controlId, null],
    ] as const) {
      await client.query(
        `UPDATE built_in_generation_jobs SET ${column} = $1 WHERE id = $2`,
        [changed, generationId],
      );
      const before = await readState();
      await assert.rejects(client.query(source), { code: "23514" });
      assert.deepEqual(await readState(), before, column);
      await client.query(
        `UPDATE built_in_generation_jobs SET ${column} = $1 WHERE id = $2`,
        [original, generationId],
      );
    }

    const before = await readState();
    await client.query(source);
    const after = await readState();
    const preservedRows = array(record(string(), unknown()));
    const runs = preservedRows.parse(after.runs);
    assert.deepEqual(
      runs.map((run) => {
        return run.id;
      }),
      [controlId],
    );
    assert.equal(preservedRows.parse(after.callbacks).length, 1);
    assert.equal(after.outputs, null);
    assert.equal(after.admissions, null);
    assert.deepEqual(after.job_identity, {
      run_id: null,
      billing_run_id: generationRunId,
      billing_context: "run",
    });
    for (const name of ["billing", "jobs", "threads", "files"]) {
      assert.deepEqual(after[name], before[name], name);
    }
    for (const name of ["raw", "hourly"]) {
      assert.deepEqual(
        after[name],
        preservedRows.parse(before[name]).map((row) => {
          return { ...row, run_id: null };
        }),
        name,
      );
    }
    await client.query(source);
    assert.deepEqual(
      await readState(),
      after,
      "replay must preserve all retained facts",
    );
    console.log(
      "   ✅ 95 historical Runs retire atomically; billing, generation identity, files and native binding survive",
    );
  } finally {
    await client.query("RESET statement_timeout");
    await client.query("DELETE FROM usage_event WHERE user_id = $1", [owner]);
    await client.query(
      "DELETE FROM usage_event_hourly_rollup WHERE user_id = $1",
      [owner],
    );
    await client.query(
      "DELETE FROM billing_run_attribution WHERE user_id = $1",
      [owner],
    );
    await client.query("DELETE FROM built_in_generation_jobs WHERE id = $1", [
      generationId,
    ]);
    await client.query("DELETE FROM run_uploaded_files WHERE user_id = $1", [
      owner,
    ]);
    await client.query("DELETE FROM agent_runs WHERE user_id = $1", [owner]);
    await client.query("DELETE FROM chat_threads WHERE id = $1", [threadId]);
    await client.query("DELETE FROM agents WHERE id = $1", [agentId]);
    await client.end();
  }
}
