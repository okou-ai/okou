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
 * Ordinary Automations carry no Official projection, and every Official
 * Automation carries a complete, well-formed one.
 */
export async function validateOfficialAutomationBindingSchema(
  databaseUrl: string,
): Promise<void> {
  console.log("=== Validate Official Automation binding schema ===\n");
  const client = new Client({ connectionString: databaseUrl });
  const identity = randomUUID();
  const workflowId = randomUUID();
  let workflowCreated = false;

  try {
    await client.connect();
    const officialAutomationId = randomUUID();
    const ordinaryAutomationId = randomUUID();
    const orgId = `official-binding-org-${identity}`;
    const userId = `official-binding-user-${identity}`;
    const definitionName = `official-binding-${identity}`;

    await client.query(
      `
        INSERT INTO "workflows" (
          "id", "org_id", "name", "created_by", "owner_user_id",
          "updated_by", "official_definition_name",
          "official_installation_state"
        ) VALUES ($1, $2, $3, $4, $4, $4, $3, 'installed')
      `,
      [workflowId, orgId, definitionName, userId],
    );
    workflowCreated = true;
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

    console.log(
      "   ✅ ordinary and Official Automations keep their binding invariants\n",
    );
  } finally {
    try {
      if (workflowCreated) {
        await client.query(`DELETE FROM "workflows" WHERE "id" = $1`, [
          workflowId,
        ]);
      }
    } finally {
      await client.end();
    }
  }
}
