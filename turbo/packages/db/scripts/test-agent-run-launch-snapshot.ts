import assert from "node:assert/strict";
import { Client } from "pg";

const constraintName = "agent_runs_launch_snapshot_check";

interface CanonicalAgentFixture {
  readonly agentId: string;
  readonly sessionId: string;
  readonly suffix: string;
}

interface CanonicalAgentRunFixture extends CanonicalAgentFixture {
  readonly runId: string;
}

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

async function expectConstraintViolation(
  client: Client,
  runId: string,
  value: unknown,
): Promise<void> {
  await assert.rejects(
    client.query(
      `
        UPDATE "agent_runs"
        SET "launch_snapshot" = $1::jsonb
        WHERE "id" = $2
      `,
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

async function seedCanonicalAgentAndSession(
  client: Client,
  fixture: CanonicalAgentFixture,
): Promise<void> {
  await client.query(
    `
      INSERT INTO "agents" ("id", "org_id", "owner", "name")
      VALUES ($1, $2, $3, $4)
    `,
    [
      fixture.agentId,
      `launch-snapshot-${fixture.suffix}-org`,
      `launch-snapshot-${fixture.suffix}-user`,
      `launch snapshot ${fixture.suffix}`,
    ],
  );
  await client.query(
    `
      INSERT INTO "agent_sessions" (
        "id", "user_id", "org_id", "agent_id"
      ) VALUES ($1, $2, $3, $4)
    `,
    [
      fixture.sessionId,
      `launch-snapshot-${fixture.suffix}-user`,
      `launch-snapshot-${fixture.suffix}-org`,
      fixture.agentId,
    ],
  );
}

async function seedCanonicalAgentRun(
  client: Client,
  fixture: CanonicalAgentRunFixture,
): Promise<void> {
  await seedCanonicalAgentAndSession(client, fixture);
  await client.query(
    `
      INSERT INTO "agent_runs" (
        "id", "user_id", "org_id", "session_id", "status", "prompt"
      ) VALUES ($1, $2, $3, $4, 'pending', $5)
    `,
    [
      fixture.runId,
      `launch-snapshot-${fixture.suffix}-user`,
      `launch-snapshot-${fixture.suffix}-org`,
      fixture.sessionId,
      `launch snapshot ${fixture.suffix}`,
    ],
  );
}

async function readLaunchSnapshotCatalog(client: Client): Promise<{
  readonly columnDefault: string | null;
  readonly hasMissing: boolean;
  readonly isNullable: "NO" | "YES";
  readonly type: string;
}> {
  const result = await client.query<{
    columnDefault: string | null;
    hasMissing: boolean;
    isNullable: "NO" | "YES";
    type: string;
  }>(`
    SELECT
      "column_row"."data_type" AS "type",
      "column_row"."is_nullable" AS "isNullable",
      "column_row"."column_default" AS "columnDefault",
      "attribute_row"."atthasmissing" AS "hasMissing"
    FROM "information_schema"."columns" AS "column_row"
    INNER JOIN "pg_attribute" AS "attribute_row"
      ON "attribute_row"."attrelid" = 'public.agent_runs'::regclass
      AND "attribute_row"."attname" = "column_row"."column_name"
      AND NOT "attribute_row"."attisdropped"
    WHERE "column_row"."table_schema" = 'public'
      AND "column_row"."table_name" = 'agent_runs'
      AND "column_row"."column_name" = 'launch_snapshot'
  `);
  assert.equal(result.rows.length, 1);
  return result.rows[0]!;
}

async function readConstraintCatalog(client: Client): Promise<{
  readonly definition: string;
  readonly validated: boolean;
}> {
  const result = await client.query<{
    definition: string;
    validated: boolean;
  }>(
    `
      SELECT
        pg_get_constraintdef("oid", true) AS "definition",
        "convalidated" AS "validated"
      FROM "pg_constraint"
      WHERE "conrelid" = 'public.agent_runs'::regclass
        AND "conname" = $1
    `,
    [constraintName],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0]!;
}

async function validateConstraintValues(
  client: Client,
  runId: string,
  supportsV2: boolean,
  supportsV3: boolean,
): Promise<void> {
  await client.query(
    `UPDATE "agent_runs" SET "launch_snapshot" = NULL WHERE "id" = $1`,
    [runId],
  );

  for (const framework of ["claude-code", "codex", "pi"] as const) {
    await client.query(
      `
        UPDATE "agent_runs"
        SET "launch_snapshot" = $1::jsonb
        WHERE "id" = $2
      `,
      [
        JSON.stringify({
          schemaVersion: 1,
          framework,
          runnerProfile: "vm0/default",
        }),
        runId,
      ],
    );
  }

  if (supportsV2) {
    for (const framework of ["claude-code", "codex", "pi"] as const) {
      for (const piMemoryGenerationEnabled of [false, true]) {
        await client.query(
          `
            UPDATE "agent_runs"
            SET "launch_snapshot" = $1::jsonb
            WHERE "id" = $2
          `,
          [
            JSON.stringify({
              schemaVersion: 2,
              framework,
              runnerProfile: "vm0/default",
              piMemoryGenerationEnabled,
            }),
            runId,
          ],
        );
      }
    }
  }

  if (supportsV3) {
    for (const framework of ["claude-code", "codex", "pi"] as const) {
      await client.query(
        `
          UPDATE "agent_runs"
          SET "launch_snapshot" = $1::jsonb
          WHERE "id" = $2
        `,
        [
          JSON.stringify({
            schemaVersion: 3,
            framework,
            runnerProfile: "vm0/default",
          }),
          runId,
        ],
      );
    }
  }

  await client.query(
    `
      UPDATE "agent_runs"
      SET "launch_snapshot" = $1::jsonb
      WHERE "id" = $2
    `,
    [
      JSON.stringify({
        schemaVersion: 1,
        framework: "codex",
        runnerProfile: "x".repeat(255),
      }),
      runId,
    ],
  );

  const inferenceSnapshot = {
    schemaVersion: 4,
    framework: "pi",
    executionMode: "api-inference",
    inferenceContractVersion: 1,
  };
  await client.query(
    'UPDATE "agent_runs" SET "launch_snapshot" = $1::jsonb WHERE "id" = $2',
    [JSON.stringify(inferenceSnapshot), runId],
  );
  for (const key of Object.keys(inferenceSnapshot)) {
    const incomplete = Object.fromEntries(
      Object.entries(inferenceSnapshot).filter(([field]) => {
        return field !== key;
      }),
    );
    await expectConstraintViolation(client, runId, incomplete);
  }
  await expectConstraintViolation(client, runId, {
    ...inferenceSnapshot,
    runnerProfile: "fabricated",
  });
  await expectConstraintViolation(client, runId, {
    ...inferenceSnapshot,
    framework: "codex",
  });
  await expectConstraintViolation(client, runId, {
    ...inferenceSnapshot,
    inferenceContractVersion: 2,
  });
  await expectConstraintViolation(client, runId, {
    ...inferenceSnapshot,
    executionMode: null,
  });
  const invalidObjects: readonly unknown[] = [
    { framework: "codex", runnerProfile: "vm0/default" },
    { schemaVersion: 1, runnerProfile: "vm0/default" },
    { schemaVersion: 1, framework: "codex" },
    {
      schemaVersion: 1,
      framework: "codex",
      runnerProfile: "vm0/default",
      extra: "rejected",
    },
    { schemaVersion: 2, framework: "codex", runnerProfile: "vm0/default" },
    {
      schemaVersion: 2,
      framework: "codex",
      runnerProfile: "vm0/default",
      piMemoryGenerationEnabled: "true",
    },
    {
      schemaVersion: 2,
      framework: "codex",
      runnerProfile: "vm0/default",
      piMemoryGenerationEnabled: true,
      extra: "rejected",
    },
    {
      schemaVersion: 3,
      framework: "codex",
      runnerProfile: "vm0/default",
      piMemoryGenerationEnabled: true,
    },
    {
      schemaVersion: 3,
      framework: "codex",
      runnerProfile: "vm0/default",
      extra: "rejected",
    },
    { schemaVersion: 3, framework: "codex" },
    { schemaVersion: 3, runnerProfile: "vm0/default" },
    { schemaVersion: 3, framework: "gemini", runnerProfile: "vm0/default" },
    { schemaVersion: 3, framework: "codex", runnerProfile: "" },
    { schemaVersion: 3, framework: "codex", runnerProfile: "x".repeat(256) },
    { schemaVersion: 4, framework: "codex", runnerProfile: "vm0/default" },
    { schemaVersion: "3", framework: "codex", runnerProfile: "vm0/default" },
    ...(!supportsV2
      ? [
          {
            schemaVersion: 2,
            framework: "codex",
            runnerProfile: "vm0/default",
            piMemoryGenerationEnabled: true,
          },
        ]
      : []),
    {
      schemaVersion: "1",
      framework: "codex",
      runnerProfile: "vm0/default",
    },
    { schemaVersion: 1, framework: 1, runnerProfile: "vm0/default" },
    { schemaVersion: 1, framework: "codex", runnerProfile: 1 },
    { schemaVersion: 1, framework: "gemini", runnerProfile: "vm0/default" },
    { schemaVersion: 1, framework: "codex", runnerProfile: "" },
    {
      schemaVersion: 1,
      framework: "codex",
      runnerProfile: "x".repeat(256),
    },
    [],
    1,
    null,
  ];
  for (const value of invalidObjects) {
    await expectConstraintViolation(client, runId, value);
  }

  await client.query(
    `UPDATE "agent_runs" SET "launch_snapshot" = NULL WHERE "id" = $1`,
    [runId],
  );
}

export async function validateAgentRunLaunchSnapshotSchema(
  databaseUrl: string,
): Promise<void> {
  console.log("=== Validate fresh Agent Run launch-snapshot schema ===\n");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const fixture = {
    agentId: "00000000-0000-4000-8000-000000093311",
    runId: "00000000-0000-4000-8000-000000093313",
    sessionId: "00000000-0000-4000-8000-000000093312",
    suffix: "fresh",
  } as const;
  try {
    assert.deepEqual(await readLaunchSnapshotCatalog(client), {
      type: "jsonb",
      isNullable: "YES",
      columnDefault: null,
      hasMissing: false,
    });
    assert.equal((await readConstraintCatalog(client)).validated, true);
    await seedCanonicalAgentRun(client, fixture);
    await validateConstraintValues(client, fixture.runId, true, true);
    console.log(
      "   ✅ fresh schema matches the nullable strict v1/v2/v3/v4 contract\n",
    );
  } finally {
    await client.end();
  }
}
