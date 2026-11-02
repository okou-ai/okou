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
  const runId = randomUUID();

  try {
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
        INSERT INTO "agent_runs" (
          "id", "user_id", "org_id", "status", "prompt"
        ) VALUES ($1, $2, $3, 'pending', 'official provenance schema')
      `,
      [runId, userId, orgId],
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
    const bundle = { sha256: "c".repeat(64), archiveBytes: 200 };
    const bundleDefinition = {
      name: "daily-brief",
      revision: "a".repeat(64),
      contentBundle: bundle,
    };
    const v2 = { schemaVersion: 2, definitions: [bundleDefinition] };
    await client.query(
      "UPDATE agent_runs SET official_workflow_provenance=$1::jsonb WHERE id=$2",
      [JSON.stringify(v2), runId],
    );
    assert.deepEqual(
      (
        await client.query(
          "SELECT official_workflow_provenance AS provenance FROM agent_runs WHERE id=$1",
          [runId],
        )
      ).rows,
      [{ provenance: v2 }],
    );
    const malformed = [
      { ...v2, definitions: [] },
      {
        ...v2,
        definitions: [
          {
            ...bundleDefinition,
            artifact: validProvenance.definitions[0].artifact,
          },
        ],
      },
      { schemaVersion: 1, definitions: [bundleDefinition] },
      ...[0, 1.5, 33554433, "200", null].map((archiveBytes) => {
        return {
          ...v2,
          definitions: [
            { ...bundleDefinition, contentBundle: { ...bundle, archiveBytes } },
          ],
        };
      }),
      {
        ...v2,
        definitions: [
          { ...bundleDefinition, contentBundle: { archiveBytes: 200 } },
        ],
      },
      {
        ...v2,
        definitions: [
          { ...bundleDefinition, contentBundle: { ...bundle, extra: true } },
        ],
      },
      {
        ...v2,
        definitions: [validProvenance.definitions[0], bundleDefinition],
      },
    ];
    for (const value of malformed) {
      await assert.rejects(
        client.query(
          "UPDATE agent_runs SET official_workflow_provenance=$1::jsonb WHERE id=$2",
          [JSON.stringify(value), runId],
        ),
        (error: unknown) => {
          return (
            databaseErrorCode(error) === "23514" &&
            databaseErrorConstraint(error) === constraintName
          );
        },
      );
    }
    const revisionName = `bundle-check-${identity.slice(0, 8)}`;
    try {
      await client.query(
        `INSERT INTO official_workflow_definition_revisions (definition_name,revision,payload,content_bundle) VALUES ($1,$2,$3,$4)`,
        [
          revisionName,
          "a".repeat(64),
          {
            schemaVersion: 3,
            name: revisionName,
            revision: "a".repeat(64),
            workflow: {
              displayName: "Report",
              description: "Report",
              instruction: "Report",
              files: [],
            },
            blueprints: [],
          },
          bundle,
        ],
      );
      for (const value of [
        null,
        {},
        { sha256: "bad", archiveBytes: 200 },
        { ...bundle, archiveBytes: 0 },
        { ...bundle, archiveBytes: 1.5 },
        { ...bundle, extra: true },
      ]) {
        await assert.rejects(
          client.query(
            "UPDATE official_workflow_definition_revisions SET content_bundle=$1 WHERE definition_name=$2",
            [value, revisionName],
          ),
        );
      }
      await assert.rejects(
        client.query(
          "UPDATE official_workflow_definition_revisions SET storage_name=$1 WHERE definition_name=$2",
          ["partial-identity", revisionName],
        ),
        (error: unknown) => {
          return (
            databaseErrorConstraint(error) ===
            "official_workflow_definition_revision_delivery_check"
          );
        },
      );
    } finally {
      await client.query(
        "DELETE FROM official_workflow_definition_revisions WHERE definition_name=$1",
        [revisionName],
      );
    }

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
    try {
      await client.query('DELETE FROM "agent_runs" WHERE "id" = $1', [runId]);
    } finally {
      await client.end();
    }
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
