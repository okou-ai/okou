import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

const officialBindingConstraint = "workflow_automations_official_binding_check";

function databaseErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function databaseErrorConstraint(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("constraint" in error)) {
    return undefined;
  }
  return typeof error.constraint === "string" ? error.constraint : undefined;
}

export async function validateOfficialAutomationResultEmailSchema(
  databaseUrl: string,
): Promise<void> {
  console.log("=== Validate Official Automation result-email schema ===\n");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0411; new non-billing transactions are prohibited.
  await client.query("BEGIN");

  try {
    const identity = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const officialAutomationId = randomUUID();
    const ordinaryAutomationId = randomUUID();
    const orgId = `official-result-org-${identity}`;
    const userId = `official-result-user-${identity}`;
    const definitionName = `official-result-${identity}`;

    await client.query(
      `
        INSERT INTO "agents" ("id", "org_id", "owner", "name")
        VALUES ($1, $2, $3, $4)
      `,
      [agentId, orgId, userId, definitionName],
    );
    await client.query(
      `
        INSERT INTO "workflows" (
          "id", "org_id", "name", "created_by", "owner_user_id",
          "agent_id", "updated_by", "official_definition_name",
          "official_installation_state"
        ) VALUES ($1, $2, $3, $4, $4, $5, $4, $3, 'installed')
      `,
      [workflowId, orgId, definitionName, userId, agentId],
    );
    await client.query(
      `
        INSERT INTO "workflow_automations" (
          "id", "org_id", "workflow_id", "owner_user_id",
          "kind", "schedule_type", "interval_seconds"
        ) VALUES
          ($1, $2, $3, $4, 'schedule', 'loop', 60),
          ($5, $2, $3, $4, 'schedule', 'loop', 120)
      `,
      [officialAutomationId, orgId, workflowId, userId, ordinaryAutomationId],
    );

    const ordinaryBefore = await client.query<{
      resultEmailEnabled: boolean | null;
    }>(
      `
        SELECT "official_result_email_enabled" AS "resultEmailEnabled"
        FROM "workflow_automations"
        WHERE "id" = $1
      `,
      [ordinaryAutomationId],
    );
    assert.deepEqual(ordinaryBefore.rows, [{ resultEmailEnabled: null }]);

    await client.query(
      `
        UPDATE "workflow_automations"
        SET
          "official_blueprint_key" = 'pulse',
          "official_applied_fingerprint" = $1,
          "official_reconciliation_status" = 'current',
          "official_parameter_bindings" = '[]'::jsonb,
          "official_intended_enabled" = true,
          "official_result_email_enabled" = false
        WHERE "id" = $2
      `,
      ["a".repeat(64), officialAutomationId],
    );
    const officialDisabled = await client.query<{
      resultEmailEnabled: boolean | null;
    }>(
      `
        SELECT "official_result_email_enabled" AS "resultEmailEnabled"
        FROM "workflow_automations"
        WHERE "id" = $1
      `,
      [officialAutomationId],
    );
    assert.deepEqual(officialDisabled.rows, [{ resultEmailEnabled: false }]);

    await client.query(
      `
        UPDATE "workflow_automations"
        SET "official_result_email_enabled" = true
        WHERE "id" = $1
      `,
      [officialAutomationId],
    );
    const officialEnabled = await client.query<{
      resultEmailEnabled: boolean | null;
    }>(
      `
        SELECT "official_result_email_enabled" AS "resultEmailEnabled"
        FROM "workflow_automations"
        WHERE "id" = $1
      `,
      [officialAutomationId],
    );
    assert.deepEqual(officialEnabled.rows, [{ resultEmailEnabled: true }]);

    await assert.rejects(
      client.query(
        `
          UPDATE "workflow_automations"
          SET "official_result_email_enabled" = true
          WHERE "id" = $1
        `,
        [ordinaryAutomationId],
      ),
      (error: unknown) => {
        return (
          databaseErrorCode(error) === "23514" &&
          databaseErrorConstraint(error) === officialBindingConstraint
        );
      },
    );

    console.log("   ✅ ordinary Automations retain a null projection");
    console.log("   ✅ Official Automations retain an explicit boolean\n");
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
}
