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

function isOfficialBindingViolation(error: unknown): boolean {
  return (
    databaseErrorCode(error) === "23514" &&
    databaseErrorConstraint(error) === officialBindingConstraint
  );
}

/**
 * The retained `official_result_email_enabled` column is outside the runtime
 * mapping. Ordinary Automations must keep it NULL; Official Automations accept
 * NULL (current writers) and the booleans written by earlier APIs, while every
 * other Official binding invariant stays enforced.
 */
export async function validateOfficialAutomationResultEmailSchema(
  databaseUrl: string,
): Promise<void> {
  console.log("=== Validate Official Automation binding schema ===\n");
  const client = new Client({ connectionString: databaseUrl });
  const identity = randomUUID();
  const agentId = randomUUID();
  let agentCreated = false;

  try {
    await client.connect();
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
    agentCreated = true;
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

    const readResultEmail = async (automationId: string) => {
      const result = await client.query<{
        resultEmailEnabled: boolean | null;
      }>(
        `
          SELECT "official_result_email_enabled" AS "resultEmailEnabled"
          FROM "workflow_automations"
          WHERE "id" = $1
        `,
        [automationId],
      );
      return result.rows;
    };

    assert.deepEqual(await readResultEmail(ordinaryAutomationId), [
      { resultEmailEnabled: null },
    ]);
    for (const value of [false, true]) {
      await assert.rejects(
        client.query(
          `
            UPDATE "workflow_automations"
            SET "official_result_email_enabled" = $1
            WHERE "id" = $2
          `,
          [value, ordinaryAutomationId],
        ),
        isOfficialBindingViolation,
      );
    }

    // Current writers mark an Official Automation without naming the column.
    await client.query(
      `
        UPDATE "workflow_automations"
        SET
          "official_blueprint_key" = 'pulse',
          "official_applied_fingerprint" = $1,
          "official_reconciliation_status" = 'current',
          "official_parameter_bindings" = '[]'::jsonb,
          "official_intended_enabled" = true
        WHERE "id" = $2
      `,
      ["a".repeat(64), officialAutomationId],
    );
    assert.deepEqual(await readResultEmail(officialAutomationId), [
      { resultEmailEnabled: null },
    ]);
    // Earlier APIs still write booleans on Official rows.
    for (const value of [false, true, null]) {
      await client.query(
        `
          UPDATE "workflow_automations"
          SET "official_result_email_enabled" = $1
          WHERE "id" = $2
        `,
        [value, officialAutomationId],
      );
      assert.deepEqual(await readResultEmail(officialAutomationId), [
        { resultEmailEnabled: value },
      ]);
    }

    const invalidOfficialUpdates = [
      `"official_applied_fingerprint" = 'not-a-fingerprint'`,
      `"official_reconciliation_status" = 'unknown'`,
      `"official_parameter_bindings" = '{}'::jsonb`,
      `"official_intended_enabled" = NULL`,
      // An Official row cannot become partially ordinary.
      `"official_blueprint_key" = NULL`,
    ];
    for (const assignment of invalidOfficialUpdates) {
      await assert.rejects(
        client.query(
          `UPDATE "workflow_automations" SET ${assignment} WHERE "id" = $1`,
          [officialAutomationId],
        ),
        isOfficialBindingViolation,
        assignment,
      );
    }
    // Ordinary rows cannot carry a partial Official projection.
    await assert.rejects(
      client.query(
        `
          UPDATE "workflow_automations"
          SET "official_intended_enabled" = true
          WHERE "id" = $1
        `,
        [ordinaryAutomationId],
      ),
      isOfficialBindingViolation,
    );

    console.log("   ✅ ordinary Automations keep a null result-email column");
    console.log(
      "   ✅ Official Automations accept null or retained booleans and keep their bindings\n",
    );
  } finally {
    try {
      if (agentCreated) {
        // Existing foreign keys cascade to this agent's workflow and automations.
        await client.query(`DELETE FROM "agents" WHERE "id" = $1`, [agentId]);
      }
    } finally {
      await client.end();
    }
  }
}
