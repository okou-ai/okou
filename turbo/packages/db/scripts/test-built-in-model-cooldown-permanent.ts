import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

interface PreviousCooldownRow {
  readonly providerType: string;
  readonly selectedModel: string;
  readonly unavailableUntil: Date;
  readonly upstreamModel: string;
}

interface CooldownRow extends PreviousCooldownRow {
  readonly connectionObservationStartedAt: Date | null;
  readonly connectionObservationUntil: Date | null;
}

interface ColumnRow {
  readonly characterMaximumLength: number | null;
  readonly columnName: string;
  readonly dataType: string;
  readonly isNullable: "NO" | "YES";
}

const observationPairConstraint =
  "built_in_model_cooldown_observation_pair_check";

const fixture = {
  baseline: {
    providerType: "permanent-provider-baseline",
    selectedModel: "permanent-built-in-model-cooldown-baseline",
    upstreamModel: "permanent-upstream-baseline",
  },
  statement: {
    providerType: "permanent-provider-statements",
    selectedModel: "permanent-built-in-model-cooldown-statements",
    upstreamModel: "permanent-upstream-statements",
  },
  observation: {
    providerType: "permanent-provider-observation",
    selectedModel: "permanent-built-in-model-cooldown-observation",
    upstreamModel: "permanent-upstream-observation",
  },
} as const;

async function readPreviousFixture(
  client: Client,
  identity: {
    readonly providerType: string;
    readonly selectedModel: string;
    readonly upstreamModel: string;
  },
): Promise<readonly PreviousCooldownRow[]> {
  const result = await client.query<PreviousCooldownRow>(
    `
      SELECT
        "selected_model" AS "selectedModel",
        "model_runtime_provider" AS "providerType",
        "model_runtime_model" AS "upstreamModel",
        "unavailable_until" AS "unavailableUntil"
      FROM "built_in_model_candidate_cooldown"
      WHERE "selected_model" = $1
        AND "model_runtime_provider" = $2
        AND "model_runtime_model" = $3
    `,
    [identity.selectedModel, identity.providerType, identity.upstreamModel],
  );
  return result.rows;
}

async function readObservationFixture(
  client: Client,
  identity: {
    readonly providerType: string;
    readonly selectedModel: string;
    readonly upstreamModel: string;
  },
): Promise<readonly CooldownRow[]> {
  const result = await client.query<CooldownRow>(
    `
      SELECT
        "selected_model" AS "selectedModel",
        "model_runtime_provider" AS "providerType",
        "model_runtime_model" AS "upstreamModel",
        "unavailable_until" AS "unavailableUntil",
        "connection_observation_started_at"
          AS "connectionObservationStartedAt",
        "connection_observation_until" AS "connectionObservationUntil"
      FROM "built_in_model_candidate_cooldown"
      WHERE "selected_model" = $1
        AND "model_runtime_provider" = $2
        AND "model_runtime_model" = $3
      FOR UPDATE
    `,
    [identity.selectedModel, identity.providerType, identity.upstreamModel],
  );
  return result.rows;
}

async function assertCanonicalSchema(client: Client): Promise<void> {
  const relations = await client.query<{
    canonicalRelation: string | null;
    legacyRelation: string | null;
  }>(`
    SELECT
      to_regclass('public.built_in_model_candidate_cooldown')::text
        AS "canonicalRelation",
      to_regclass('public.managed_model_candidate_cooldown')::text
        AS "legacyRelation"
  `);
  assert.deepEqual(relations.rows, [
    {
      canonicalRelation: "built_in_model_candidate_cooldown",
      legacyRelation: null,
    },
  ]);

  const columns = await client.query<ColumnRow>(`
    SELECT
      "column_name" AS "columnName",
      "data_type" AS "dataType",
      "is_nullable" AS "isNullable",
      "character_maximum_length" AS "characterMaximumLength"
    FROM "information_schema"."columns"
    WHERE "table_schema" = 'public'
      AND "table_name" = 'built_in_model_candidate_cooldown'
    ORDER BY "ordinal_position"
  `);
  assert.deepEqual(columns.rows, [
    {
      characterMaximumLength: 255,
      columnName: "selected_model",
      dataType: "character varying",
      isNullable: "NO",
    },
    {
      characterMaximumLength: 100,
      columnName: "model_runtime_provider",
      dataType: "character varying",
      isNullable: "NO",
    },
    {
      characterMaximumLength: 255,
      columnName: "model_runtime_model",
      dataType: "character varying",
      isNullable: "NO",
    },
    {
      characterMaximumLength: null,
      columnName: "unavailable_until",
      dataType: "timestamp without time zone",
      isNullable: "NO",
    },
    {
      characterMaximumLength: null,
      columnName: "connection_observation_started_at",
      dataType: "timestamp without time zone",
      isNullable: "YES",
    },
    {
      characterMaximumLength: null,
      columnName: "connection_observation_until",
      dataType: "timestamp without time zone",
      isNullable: "YES",
    },
  ]);

  const primaryKey = await client.query<{ columnName: string }>(`
    SELECT "attribute"."attname" AS "columnName"
    FROM "pg_constraint" AS "constraint"
    INNER JOIN "pg_class" AS "relation"
      ON "relation"."oid" = "constraint"."conrelid"
    INNER JOIN LATERAL unnest("constraint"."conkey") WITH ORDINALITY
      AS "key_column"("attribute_number", "position") ON TRUE
    INNER JOIN "pg_attribute" AS "attribute"
      ON "attribute"."attrelid" = "relation"."oid"
      AND "attribute"."attnum" = "key_column"."attribute_number"
    WHERE "relation"."relname" = 'built_in_model_candidate_cooldown'
      AND "constraint"."contype" = 'p'
    ORDER BY "key_column"."position"
  `);
  assert.deepEqual(
    primaryKey.rows.map((row) => {
      return row.columnName;
    }),
    ["selected_model", "model_runtime_provider", "model_runtime_model"],
  );

  const observationCheck = await client.query<{
    constraintName: string;
    definition: string;
    validated: boolean;
  }>(
    `
      SELECT
        "constraint"."conname" AS "constraintName",
        pg_catalog.pg_get_constraintdef("constraint"."oid", true)
          AS "definition",
        "constraint"."convalidated" AS "validated"
      FROM "pg_catalog"."pg_constraint" AS "constraint"
      WHERE "constraint"."conrelid" =
          'public.built_in_model_candidate_cooldown'::regclass
        AND "constraint"."contype" = 'c'
        AND "constraint"."conname" = $1
    `,
    [observationPairConstraint],
  );
  assert.equal(observationCheck.rows.length, 1);
  const [check] = observationCheck.rows;
  assert.ok(check);
  assert.equal(check.constraintName, observationPairConstraint);
  assert.equal(check.validated, true);
  assert.match(
    check.definition,
    /connection_observation_started_at IS NULL.*connection_observation_until IS NULL.*connection_observation_started_at IS NOT NULL.*connection_observation_until IS NOT NULL/,
  );
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

async function assertObservationPairRejected(
  client: Client,
  columns: string,
  values: readonly Date[],
): Promise<void> {
  await assert.rejects(
    client.query(
      `
        INSERT INTO "built_in_model_candidate_cooldown" (
          "selected_model", "model_runtime_provider", "model_runtime_model",
          "unavailable_until", ${columns}
        )
        VALUES ($1, $2, $3, $4, $5)
      `,
      [
        fixture.observation.selectedModel,
        fixture.observation.providerType,
        fixture.observation.upstreamModel,
        new Date("2026-08-25T09:00:00.000Z"),
        ...values,
      ],
    ),
    (error: unknown) => {
      return (
        databaseErrorCode(error) === "23514" &&
        databaseErrorConstraint(error) === observationPairConstraint
      );
    },
  );
}

async function validateCanonicalStatements(client: Client): Promise<void> {
  const baselineDeadline = new Date("2026-08-25T05:00:00.000Z");
  const initialDeadline = new Date("2026-08-25T07:00:00.000Z");
  const earlierDeadline = new Date("2026-08-25T06:00:00.000Z");
  const laterDeadline = new Date("2026-08-25T08:00:00.000Z");
  const observationStartedAt = new Date("2026-08-25T07:30:00.000Z");
  const observationUntil = new Date("2026-08-25T07:31:00.000Z");

  await client.query(
    `
      INSERT INTO "built_in_model_candidate_cooldown" (
        "selected_model", "model_runtime_provider", "model_runtime_model", "unavailable_until"
      )
      VALUES ($1, $2, $3, $4)
    `,
    [
      fixture.baseline.selectedModel,
      fixture.baseline.providerType,
      fixture.baseline.upstreamModel,
      baselineDeadline,
    ],
  );

  const upsertPreviousVersion = async (
    deadline: Date,
  ): Promise<readonly PreviousCooldownRow[]> => {
    const result = await client.query<PreviousCooldownRow>(
      `
        INSERT INTO "built_in_model_candidate_cooldown" (
          "selected_model", "model_runtime_provider", "model_runtime_model", "unavailable_until"
        )
        VALUES ($1, $2, $3, $4)
        ON CONFLICT ("selected_model", "model_runtime_provider", "model_runtime_model")
        DO UPDATE SET
          "unavailable_until" = GREATEST(
            "built_in_model_candidate_cooldown"."unavailable_until",
            EXCLUDED."unavailable_until"
          )
        RETURNING
          "selected_model" AS "selectedModel",
          "model_runtime_provider" AS "providerType",
          "model_runtime_model" AS "upstreamModel",
          "unavailable_until" AS "unavailableUntil"
      `,
      [
        fixture.statement.selectedModel,
        fixture.statement.providerType,
        fixture.statement.upstreamModel,
        deadline,
      ],
    );
    return result.rows;
  };

  assert.equal(
    (
      await upsertPreviousVersion(initialDeadline)
    )[0]?.unavailableUntil.getTime(),
    initialDeadline.getTime(),
  );
  assert.equal(
    (
      await upsertPreviousVersion(earlierDeadline)
    )[0]?.unavailableUntil.getTime(),
    initialDeadline.getTime(),
  );
  assert.equal(
    (await upsertPreviousVersion(laterDeadline))[0]?.unavailableUntil.getTime(),
    laterDeadline.getTime(),
  );

  await client.query(
    `
      UPDATE "built_in_model_candidate_cooldown"
      SET
        "connection_observation_started_at" = $1,
        "connection_observation_until" = $2
      WHERE "selected_model" = $3
        AND "model_runtime_provider" = $4
        AND "model_runtime_model" = $5
    `,
    [
      observationStartedAt,
      observationUntil,
      fixture.statement.selectedModel,
      fixture.statement.providerType,
      fixture.statement.upstreamModel,
    ],
  );
  const outgoingDeadline = new Date("2026-08-25T08:30:00.000Z");
  assert.equal(
    (
      await upsertPreviousVersion(outgoingDeadline)
    )[0]?.unavailableUntil.getTime(),
    outgoingDeadline.getTime(),
  );
  assert.deepEqual(await readObservationFixture(client, fixture.statement), [
    {
      ...fixture.statement,
      unavailableUntil: outgoingDeadline,
      connectionObservationStartedAt: observationStartedAt,
      connectionObservationUntil: observationUntil,
    },
  ]);

  await client.query(
    `
      UPDATE "built_in_model_candidate_cooldown"
      SET
        "connection_observation_started_at" = NULL,
        "connection_observation_until" = NULL
      WHERE "selected_model" = $1
        AND "model_runtime_provider" = $2
        AND "model_runtime_model" = $3
    `,
    [
      fixture.statement.selectedModel,
      fixture.statement.providerType,
      fixture.statement.upstreamModel,
    ],
  );
  assert.deepEqual(await readObservationFixture(client, fixture.statement), [
    {
      ...fixture.statement,
      unavailableUntil: outgoingDeadline,
      connectionObservationStartedAt: null,
      connectionObservationUntil: null,
    },
  ]);

  await assertObservationPairRejected(
    client,
    '"connection_observation_started_at"',
    [observationStartedAt],
  );
  await assertObservationPairRejected(
    client,
    '"connection_observation_until"',
    [observationUntil],
  );

  const activePreviousVersion = await client.query<PreviousCooldownRow>(
    `
      SELECT
        "selected_model" AS "selectedModel",
        "model_runtime_provider" AS "providerType",
        "model_runtime_model" AS "upstreamModel",
        "unavailable_until" AS "unavailableUntil"
      FROM "built_in_model_candidate_cooldown"
      WHERE "selected_model" = $1
        AND "model_runtime_provider" = $2
        AND "model_runtime_model" = $3
        AND "unavailable_until" > $4
    `,
    [
      fixture.statement.selectedModel,
      fixture.statement.providerType,
      fixture.statement.upstreamModel,
      initialDeadline,
    ],
  );
  assert.equal(
    activePreviousVersion.rows[0]?.unavailableUntil.getTime(),
    outgoingDeadline.getTime(),
  );

  const deletedPreviousVersion = await client.query<PreviousCooldownRow>(
    `
      DELETE FROM "built_in_model_candidate_cooldown"
      WHERE "selected_model" = $1
        AND "model_runtime_provider" = $2
        AND "model_runtime_model" = $3
      RETURNING
        "selected_model" AS "selectedModel",
        "model_runtime_provider" AS "providerType",
        "model_runtime_model" AS "upstreamModel",
        "unavailable_until" AS "unavailableUntil"
    `,
    [
      fixture.statement.selectedModel,
      fixture.statement.providerType,
      fixture.statement.upstreamModel,
    ],
  );
  assert.deepEqual(deletedPreviousVersion.rows, activePreviousVersion.rows);
  assert.equal(
    (
      await readPreviousFixture(client, fixture.baseline)
    )[0]?.unavailableUntil.getTime(),
    baselineDeadline.getTime(),
  );
}

export async function validatePermanentBuiltInModelCooldownState(
  databaseUrl: string,
): Promise<void> {
  console.log("=== Validate permanent built-in model cooldown state ===\n");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await assertCanonicalSchema(client);
    await validateCanonicalStatements(client);

    console.log("   ✅ only the canonical cooldown relation exists");
    console.log("   ✅ canonical columns, key, and paired state are stable");
    console.log("   ✅ outgoing statements preserve deadlines and state");
    console.log("   ✅ observation state can be written and cleared\n");
  } finally {
    await client.query(
      `
        DELETE FROM "built_in_model_candidate_cooldown"
        WHERE "selected_model" IN ($1, $2, $3)
      `,
      [
        fixture.baseline.selectedModel,
        fixture.statement.selectedModel,
        fixture.observation.selectedModel,
      ],
    );
    await client.end();
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL is required");
  validatePermanentBuiltInModelCooldownState(databaseUrl).catch(
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
