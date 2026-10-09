import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const constraintName = "agent_runs_official_workflow_provenance_check";

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

export async function validateAgentRunOfficialWorkflowProvenanceSchema(
  databaseUrl: string,
): Promise<void> {
  console.log(
    "=== Validate Agent Run Official Workflow provenance schema ===\n",
  );
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0369; new non-billing transactions are prohibited.
  await client.query("BEGIN");

  try {
    const runId = randomUUID();
    const sessionId = randomUUID();
    const identity = randomUUID();
    const userId = `official-provenance-user-${identity}`;
    const orgId = `official-provenance-org-${identity}`;
    const validProvenance = {
      schemaVersion: 1,
      definitions: [
        {
          name: "daily-brief",
          revision: "a".repeat(64),
          artifact: {
            orgId: "__system__",
            userId: "__org__",
            storageName: "official-workflow-daily-brief",
            storageId: randomUUID(),
            storageVersion: "b".repeat(64),
          },
        },
      ],
    } as const;

    await client.query(
      `
        INSERT INTO "agent_sessions" ("id", "user_id", "org_id")
        VALUES ($1, $2, $3)
      `,
      [sessionId, userId, orgId],
    );
    await client.query(
      `
        INSERT INTO "agent_runs" (
          "id", "user_id", "org_id", "session_id", "status", "prompt"
        ) VALUES ($1, $2, $3, $4, 'pending', 'official provenance schema')
      `,
      [runId, userId, orgId, sessionId],
    );
    await client.query(
      `
        UPDATE "agent_runs"
        SET "official_workflow_provenance" = $1::jsonb
        WHERE "id" = $2
      `,
      [JSON.stringify(validProvenance), runId],
    );
    const validRow = await client.query<{ provenance: unknown }>(
      `
        SELECT "official_workflow_provenance" AS "provenance"
        FROM "agent_runs"
        WHERE "id" = $1
      `,
      [runId],
    );
    assert.deepEqual(validRow.rows, [{ provenance: validProvenance }]);

    const serializedMalformedProvenance = JSON.stringify({
      schemaVersion: 1,
      definitions: [
        {
          name: "daily-brief",
          revision: "a".repeat(64),
          artifact: {
            orgId: "__system__",
            userId: "__org__",
            storageName: "official-workflow-daily-brief",
            storageId: undefined,
            storageVersion: "b".repeat(64),
          },
        },
      ],
    });
    assert.equal(serializedMalformedProvenance.includes('"storageId"'), false);
    await assert.rejects(
      client.query(
        `
          UPDATE "agent_runs"
          SET "official_workflow_provenance" = $1::jsonb
          WHERE "id" = $2
        `,
        [serializedMalformedProvenance, runId],
      ),
      (error: unknown) => {
        return (
          databaseErrorCode(error) === "23514" &&
          databaseErrorConstraint(error) === constraintName
        );
      },
    );

    console.log("   ✅ valid strict provenance is accepted");
    console.log(
      "   ✅ JSON-omitted nested artifact identity is rejected by the exact constraint\n",
    );
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL is required");
  validateAgentRunOfficialWorkflowProvenanceSchema(databaseUrl).catch(
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
