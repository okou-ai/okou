import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

/** Invariants shared by replayed migrations and a freshly generated schema. */
export async function validateCanonicalModelSelections(databaseUrl: string) {
  const db = new Client({ connectionString: databaseUrl });
  await db.connect();
  const user = `selection-${randomUUID()}`;
  const org = `selection-${randomUUID()}`;
  const thread = randomUUID();
  const input = randomUUID();
  const session = randomUUID();
  const run = randomUUID();
  try {
    const defaults = await db.query(
      `INSERT INTO chat_threads (id, user_id) VALUES ($1,$2) RETURNING selected_model`,
      [thread, user],
    );
    assert.deepEqual(defaults.rows, [{ selected_model: "auto" }]);
    const member = await db.query(
      `INSERT INTO org_members_metadata (org_id, user_id) VALUES ($1,$2) RETURNING selected_model`,
      [org, user],
    );
    assert.deepEqual(member.rows, [{ selected_model: "auto" }]);
    await assert.rejects(
      db.query(`UPDATE chat_threads SET selected_model = '' WHERE id = $1`, [
        thread,
      ]),
      /chat_threads_selected_model_check/,
    );
    await assert.rejects(
      db.query(`UPDATE chat_threads SET selected_model = NULL WHERE id = $1`, [
        thread,
      ]),
      /not-null/,
    );
    await assert.rejects(
      db.query(
        `UPDATE org_members_metadata SET selected_model = '' WHERE org_id = $1 AND user_id = $2`,
        [org, user],
      ),
      /org_members_metadata_selected_model_check/,
    );
    await db.query(
      `UPDATE chat_threads SET selected_model = 'gpt-6-luna', model_settings = '{"gpt-6-luna":{"effort":"high"}}' WHERE id = $1`,
      [thread],
    );
    await assert.rejects(
      db.query(
        `UPDATE chat_threads SET model_settings = '{"auto":{"effort":"high"}}' WHERE id = $1`,
        [thread],
      ),
      /explicit_model_settings_check/,
    );
    await assert.rejects(
      db.query(
        `UPDATE org_members_metadata SET model_settings = '{"@preset/captured":{"effort":"high"}}' WHERE org_id = $1 AND user_id = $2`,
        [org, user],
      ),
      /explicit_model_settings_check/,
    );
    // Optional control/event fields remain absent, rather than invented Auto.
    await db.query(
      `INSERT INTO chat_thread_events (user_id,org_id,chat_thread_id,seq_id,kind) VALUES ($1,$2,$3,1,'renamed')`,
      [user, org, thread],
    );
    await assert.rejects(
      db.query(
        `INSERT INTO chat_thread_events (user_id,org_id,chat_thread_id,seq_id,kind,selected_model) VALUES ($1,$2,$3,2,'model_selection_updated','')`,
        [user, org, thread],
      ),
      /chat_thread_events_selected_model_check/,
    );
    await db.query(
      `INSERT INTO chat_events (id,chat_thread_id,event_type,context_type,seq_id,payload) VALUES ($1,$2,'input.prompt','web',1,'{"userMessage":{"version":1,"parts":[{"type":"text","text":"uncaptured"}]}}')`,
      [input, thread],
    );
    assert.deepEqual(
      (
        await db.query(`SELECT model_selection FROM chat_events WHERE id=$1`, [
          input,
        ])
      ).rows,
      [{ model_selection: null }],
    );
    for (const invalid of [
      {},
      { selectedModel: null },
      { selectedModel: "" },
    ]) {
      await assert.rejects(
        db.query(`UPDATE chat_events SET model_selection=$1 WHERE id=$2`, [
          invalid,
          input,
        ]),
        /chat_events_model_selection_check/,
      );
    }
    await db.query(
      `UPDATE chat_events SET model_selection='{"selectedModel":"auto","reasoningEffort":null,"codexServiceTier":null}' WHERE id=$1`,
      [input],
    );
    await assert.rejects(
      db.query(
        `UPDATE chat_events SET payload='{"userMessage":{"parts":[{"type":"model","selectedModel":""}]}}' WHERE id=$1`,
        [input],
      ),
      /chat_events_model_annotation_check/,
    );
    await db.query(
      `INSERT INTO agent_sessions (id,user_id,org_id) VALUES ($1,$2,$3)`,
      [session, user, org],
    );
    await db.query(
      `INSERT INTO agent_runs (id,session_id,user_id,org_id,status,prompt,trigger_source,autonomy_budget,model_provider,launch_snapshot)
      VALUES ($1,$2,$3,$4,'failed','unresolved','chat',0,'built-in','{"schemaVersion":1,"framework":"pi","runnerProfile":"vm0/default"}')`,
      [run, session, user, org],
    );
    await assert.rejects(
      db.query(`UPDATE agent_runs SET status='running' WHERE id=$1`, [run]),
      /agent_runs_executable_builtin_capture_check/,
    );
    await db.query(
      `UPDATE agent_runs SET selected_model='auto',model_runtime_provider='openrouter-codex',model_runtime_model='@preset/captured',model_usage_provider='@preset/captured',built_in_model_key_id=$1,status='running' WHERE id=$2`,
      [randomUUID(), run],
    );
    await assert.rejects(
      db.query(`UPDATE agent_runs SET model_runtime_model='' WHERE id=$1`, [
        run,
      ]),
      /agent_runs_executable_builtin_capture_check/,
    );
    for (const change of [
      `model_usage_provider=NULL`,
      `model_provider_id='${randomUUID()}'`,
      `model_provider_account_identity='personal-account'`,
      `built_in_model_key_id=NULL`,
      `model_long_context_min_total_input_tokens=0`,
    ]) {
      await assert.rejects(
        db.query(`UPDATE agent_runs SET ${change} WHERE id=$1`, [run]),
        /builtin_capture_owner_check|executable_builtin_capture_check|usage_capture_check/,
      );
    }
    for (const selected of [
      "okou-1.0",
      "okou-1.0-pro",
      "okou-1.0-max",
      "@preset/runtime-only",
    ]) {
      for (const statement of [
        `UPDATE chat_threads SET selected_model=$1 WHERE id='${thread}'`,
        `UPDATE org_members_metadata SET selected_model=$1 WHERE org_id='${org}' AND user_id='${user}'`,
        `UPDATE agent_runs SET selected_model=$1 WHERE id='${run}'`,
        `UPDATE chat_events SET model_selection=jsonb_build_object('selectedModel',$1::text) WHERE id='${input}'`,
        `UPDATE chat_events SET payload=jsonb_build_object('userMessage',jsonb_build_object('parts',jsonb_build_array(jsonb_build_object('type','model','selectedModel',$1::text)))) WHERE id='${input}'`,
      ]) {
        await assert.rejects(
          db.query(statement, [selected]),
          /canonical_(selection|annotation)_check/,
        );
      }
    }
    await assert.rejects(
      db.query(
        `INSERT INTO chat_thread_events (user_id,org_id,chat_thread_id,seq_id,kind) VALUES ($1,$2,$3,3,'model_selection_updated')`,
        [user, org, thread],
      ),
      /chat_thread_events_canonical_selection_check/,
    );
    // A canonical historical personal ID need not exist in today's catalog.
    await db.query(
      `UPDATE agent_runs SET status='completed', model_provider='codex-oauth-token',
      selected_model='retained-personal-model', model_runtime_provider=NULL, model_runtime_model=NULL,
      model_usage_provider=NULL, built_in_model_key_id=NULL WHERE id=$1`,
      [run],
    );
    await assert.rejects(
      db.query(`UPDATE agent_runs SET status='running' WHERE id=$1`, [run]),
      /personal_capture_check/,
    );
    await assert.rejects(
      db.query(
        `UPDATE agent_runs SET model_runtime_model='original-upstream' WHERE id=$1`,
        [run],
      ),
      /runtime_pair_check|personal_capture_check/,
    );
    await db.query(
      `UPDATE agent_runs SET model_runtime_provider='codex-oauth-token', model_runtime_model='original-upstream',
      model_provider_id=$1, model_provider_account_identity='permanent-account', status='pending' WHERE id=$2`,
      [randomUUID(), run],
    );
    for (const change of [
      `model_provider_account_identity=NULL`,
      `model_provider_id=NULL`,
      `model_runtime_provider='claude-code-oauth-token'`,
      `built_in_model_key_id='${randomUUID()}'`,
    ]) {
      await assert.rejects(
        db.query(`UPDATE agent_runs SET ${change} WHERE id=$1`, [run]),
        /personal_capture_check/,
      );
    }
    await db.query(`UPDATE agent_runs SET status='completed' WHERE id=$1`, [
      run,
    ]);
    // Known execution does not retroactively invent a missing selected decision.
    await db.query(`UPDATE agent_runs SET selected_model=NULL WHERE id=$1`, [
      run,
    ]);
    assert.deepEqual(
      (
        await db.query(
          `SELECT model_runtime_model,model_provider_account_identity,built_in_model_key_id FROM agent_runs WHERE id=$1`,
          [run],
        )
      ).rows,
      [
        {
          model_runtime_model: "original-upstream",
          model_provider_account_identity: "permanent-account",
          built_in_model_key_id: null,
        },
      ],
    );
  } finally {
    await db.query(`DELETE FROM agent_runs WHERE id=$1`, [run]);
    await db.query(`DELETE FROM agent_sessions WHERE id=$1`, [session]);
    await db.query(
      `DELETE FROM chat_thread_events WHERE user_id=$1 AND org_id=$2`,
      [user, org],
    );
    await db.query(`DELETE FROM chat_threads WHERE id=$1`, [thread]);
    await db.query(
      `DELETE FROM org_members_metadata WHERE user_id=$1 AND org_id=$2`,
      [user, org],
    );
    await db.end();
  }
}
