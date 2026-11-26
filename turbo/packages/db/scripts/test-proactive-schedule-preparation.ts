import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { applyPendingMigrations } from "./migration-runner";

/** Exercise the actual copy against the outgoing schema, before any new API is serving. */
export async function validateProactiveSchedulePreparation(
  databaseUrl: string,
  migrationMillis: number,
) {
  const db = postgres(databaseUrl, { max: 1 });
  const org = "proactive-handoff-test";
  const thread = randomUUID();
  const lastRun = randomUUID();
  try {
    await applyPendingMigrations(db, { beforeMillis: migrationMillis });
    await db`INSERT INTO org_members_metadata (org_id, user_id, timezone, proactive_suggestions_enabled) VALUES
      (${org}, 'enabled', 'Asia/Kathmandu', true), (${org}, 'waiting', null, true),
      (${org}, 'paused', 'Asia/Shanghai', false), (${org}, 'unrelated', 'UTC', false)`;
    await db`INSERT INTO morning_brief_enrollments (org_id, user_id, state) VALUES
      (${org}, 'waiting', 'pending'), (${org}, 'unknown', 'checking'),
      (${org}, 'opt-out', 'cancelled'), (${org}, 'gone', 'departed')`;
    await db`INSERT INTO workflows (org_id, owner_user_id, name, official_definition_name, created_by, updated_by)
      SELECT ${org}, owner, name, definition, owner, owner FROM (VALUES
        ('enabled', 'morning-brief', 'morning-brief'), ('enabled', 'agent-suggestions', 'agent-suggestions'),
        ('enabled', 'proactive-learning', 'proactive-learning'), ('paused', 'internal-test-morning-brief', 'internal-test-morning-brief'),
        ('gone', 'morning-brief', 'morning-brief'), ('unrelated', 'proactive-action', 'proactive-action'),
        ('unrelated', 'morning-brief', NULL)) AS f(owner, name, definition)`;
    await db`INSERT INTO workflow_automations (org_id, owner_user_id, workflow_id, kind, schedule_type,
      cron_expression, timezone, enabled, next_run_at, last_run_id, consecutive_failures,
      official_intended_enabled, official_blueprint_key, official_applied_fingerprint, official_parameter_bindings,
      official_reconciliation_status, deferred_anchor_at, deferred_until, deferred_reason)
      SELECT org_id, owner_user_id, id, 'schedule', 'cron', '51 6 * * *', 'Asia/Kathmandu',
        owner_user_id <> 'paused',
        CASE WHEN name <> 'proactive-learning' THEN timestamp '2030-05-01 01:06:00' END, ${lastRun}, 0,
        true, CASE name WHEN 'proactive-learning' THEN 'nightly-learning'
          WHEN 'agent-suggestions' THEN 'hourly-check' WHEN 'proactive-action' THEN 'hourly-check' ELSE 'daily-delivery' END,
        repeat('a', 64), '[]'::jsonb,
        CASE WHEN owner_user_id = 'paused' THEN 'needs_reconfiguration' ELSE 'current' END,
        CASE WHEN name = 'morning-brief' THEN timestamp '2030-05-01 01:06:00' END,
        CASE WHEN name = 'morning-brief' THEN timestamp '2030-05-01 01:08:00' END,
        CASE WHEN name = 'morning-brief' THEN 'held' END
      FROM workflows WHERE org_id = ${org}`;
    await db`INSERT INTO chat_threads (id, org_id, user_id, hidden) VALUES (${thread}, ${org}, 'enabled', true)`;
    // A malformed binding for a different owner must never hand over that owner's conversation.
    await db`INSERT INTO workflow_user_automation_threads (org_id, user_id, workflow_id, chat_thread_id)
      SELECT org_id, owner_user_id, id, ${thread} FROM workflows WHERE org_id = ${org}
      AND official_definition_name IN ('morning-brief', 'internal-test-morning-brief')`;
    const outgoing = () => {
      return db`SELECT * FROM workflow_automations WHERE org_id = ${org} ORDER BY id`;
    };
    const original = await outgoing();
    await applyPendingMigrations(db, { beforeMillis: migrationMillis + 1 });
    assert.deepEqual(await outgoing(), original);
    const rows =
      await db`SELECT user_id, task, intended_enabled, enabled, timezone, chat_thread_id
      FROM proactive_schedules WHERE org_id = ${org} ORDER BY user_id, task`;
    assert.deepEqual(
      rows.map((r) => {
        return [
          r.user_id,
          r.task,
          r.intended_enabled,
          r.enabled,
          r.timezone,
          r.chat_thread_id,
        ];
      }),
      [
        ["enabled", "learning", true, true, "Asia/Kathmandu", null],
        ["enabled", "morning-brief", true, true, "Asia/Kathmandu", thread],
        ["enabled", "suggestions", true, true, "Asia/Kathmandu", null],
        ["opt-out", "morning-brief", false, false, null, null],
        ["paused", "morning-brief", true, false, "Asia/Kathmandu", null],
        ["waiting", "learning", true, false, null, null],
        ["waiting", "morning-brief", true, false, null, null],
        ["waiting", "suggestions", true, false, "UTC", null],
      ],
    );
    const [brief] =
      await db`SELECT next_run_at::text, last_run_id, deferred_until::text, deferred_reason
      FROM proactive_schedules WHERE org_id = ${org} AND user_id = 'enabled' AND task = 'morning-brief'`;
    assert.deepEqual(brief, {
      next_run_at: "2030-05-01 01:06:00",
      last_run_id: lastRun,
      deferred_until: "2030-05-01 01:08:00",
      deferred_reason: "held",
    });
    const [learning] = await db`SELECT next_run_at FROM proactive_schedules
      WHERE org_id = ${org} AND user_id = 'enabled' AND task = 'learning'`;
    assert.deepEqual(learning, { next_run_at: null });

    // A choice changed while the outgoing API is serving must be visible in the final handoff input.
    await db`UPDATE org_members_metadata SET proactive_suggestions_enabled = false WHERE org_id = ${org} AND user_id = 'enabled'`;
    const choices =
      await db`SELECT s.intended_enabled AS copied, l.intended_enabled AS live FROM proactive_schedules s
      JOIN legacy_proactive_schedules l USING (org_id, user_id, task)
      WHERE s.org_id = ${org} AND s.user_id = 'enabled' AND s.task <> 'morning-brief'`;
    assert.equal(choices.length, 2);
    assert.ok(
      choices.every((r) => {
        return r.copied === true && r.live === false;
      }),
    );
  } finally {
    await db.end();
  }
}
