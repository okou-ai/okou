import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { applyPendingMigrations } from "./migration-runner";

export async function validateOfficialWorkflowIdentityRetirement(
  databaseUrl: string,
  migrationMillis: number,
) {
  const sql = postgres(databaseUrl, { max: 1 });
  const workflowId = randomUUID();
  const automationId = randomUUID();
  const newWorkflowId = randomUUID();
  const migration = await readFile(
    new URL(
      "../src/migrations/1637_retire_official_workflow_automation_identities.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const promote = () => {
    return sql.unsafe(migration).simple();
  };
  const schedules = () => {
    return sql`SELECT * FROM workflow_automations WHERE workflow_id IN (${workflowId}, ${newWorkflowId}) ORDER BY id`;
  };
  try {
    await applyPendingMigrations(sql, { beforeMillis: migrationMillis });
    await sql`INSERT INTO workflows (id, org_id, owner_user_id, name, created_by, updated_by,
        official_definition_name, official_installation_state)
      VALUES (${workflowId}, 'identity-test', 'owner', 'morning-brief', 'owner', 'owner', 'morning-brief', 'installed')`;
    await sql`INSERT INTO workflow_automations (id, org_id, owner_user_id, workflow_id,
        kind, schedule_type, cron_expression, timezone, enabled, consecutive_failures,
        official_intended_enabled, official_blueprint_key, official_applied_fingerprint,
        official_parameter_bindings, official_reconciliation_status)
      VALUES (${automationId}, 'identity-test', 'owner', ${workflowId}, 'schedule', 'cron', '15 6 * * *',
        'Asia/Shanghai', false, 3, true, 'daily-delivery', repeat('a', 64),
        '[{"key":"cron","value":"15 6 * * *"}]', 'current')`;
    await sql`INSERT INTO official_workflow_automation_identities
      (id, workflow_id, automation_id, blueprint_key, state)
      VALUES (${automationId}, ${workflowId}, ${automationId}, 'daily-delivery', 'active')`;
    await applyPendingMigrations(sql, {
      beforeMillis: migrationMillis + 1,
      beforeApiPromotion: true,
    });

    // An outgoing writer can still persist a detached choice after preparation.
    await sql`UPDATE official_workflow_automation_identities
      SET state = 'removed', automation_id = NULL, retained_intended_enabled = false,
        retained_parameter_bindings = '[]', retained_applied_fingerprint = repeat('b', 64)
      WHERE id = ${automationId}`;
    await assert.rejects(promote, /independent state or does not match/);
    const [choice] =
      await sql`SELECT retained_intended_enabled, retained_parameter_bindings,
      retained_applied_fingerprint FROM official_workflow_automation_identities WHERE id = ${automationId}`;
    assert.deepEqual(choice, {
      retained_intended_enabled: false,
      retained_parameter_bindings: [],
      retained_applied_fingerprint: "b".repeat(64),
    });

    await sql`UPDATE official_workflow_automation_identities SET state = 'active',
      automation_id = id, blueprint_key = 'other-blueprint', retained_intended_enabled = NULL,
      retained_parameter_bindings = NULL, retained_applied_fingerprint = NULL WHERE id = ${automationId}`;
    await assert.rejects(promote, /independent state or does not match/);
    await sql`UPDATE official_workflow_automation_identities SET blueprint_key = 'daily-delivery' WHERE id = ${automationId}`;

    // The incoming API can already have created a schedule without an identity.
    await sql`INSERT INTO workflows (id, org_id, owner_user_id, name, created_by, updated_by,
        official_definition_name, official_installation_state)
      VALUES (${newWorkflowId}, 'identity-test', 'new-owner', 'morning-brief',
        'new-owner', 'new-owner', 'morning-brief', 'installed')`;
    await sql`INSERT INTO workflow_automations (org_id, owner_user_id, workflow_id,
        kind, schedule_type, cron_expression, timezone, enabled, official_intended_enabled,
        official_blueprint_key, official_applied_fingerprint, official_parameter_bindings, official_reconciliation_status)
      VALUES ('identity-test', 'new-owner', ${newWorkflowId}, 'schedule', 'cron', '10 7 * * *', 'UTC',
        true, true, 'daily-delivery', repeat('a', 64), '[{"key":"cron","value":"10 7 * * *"}]', 'current')`;
    const before = await schedules();
    await promote();
    assert.deepEqual(await schedules(), before);
    const [deleted] =
      await sql`SELECT public.delete_workflow_rows('identity-test', ${workflowId}, true, 'installed')->>'deleted' AS deleted`;
    assert.equal(deleted?.deleted, "true");
    assert.deepEqual(
      [...(await schedules())],
      before.filter((row) => {
        return row.id !== automationId;
      }),
    );
  } finally {
    await sql.end();
  }
}
