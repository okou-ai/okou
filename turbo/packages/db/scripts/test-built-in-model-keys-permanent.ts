import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

interface BuiltInModelKeyRow {
  readonly apiKey: string;
  readonly id: string;
  readonly label: string | null;
  readonly vendor: string;
}

interface PreservedBuiltInModelKeyRow extends BuiltInModelKeyRow {
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const fixture = {
  baselineVendor: "permanent-built-in-model-key-baseline",
  conflictVendor: "permanent-built-in-model-key-conflict",
  statementVendor: "permanent-built-in-model-key-statements",
} as const;

async function readKeyByVendor(
  client: Client,
  vendor: string,
): Promise<BuiltInModelKeyRow[]> {
  const result = await client.query<BuiltInModelKeyRow>(
    `
      SELECT
        "id",
        "vendor",
        "api_key" AS "apiKey",
        "label"
      FROM "built_in_model_keys"
      WHERE "vendor" = $1
    `,
    [vendor],
  );
  return result.rows;
}

async function readPreservedKeyByVendor(
  client: Client,
  vendor: string,
): Promise<PreservedBuiltInModelKeyRow[]> {
  const result = await client.query<PreservedBuiltInModelKeyRow>(
    `
      SELECT
        "id",
        "vendor",
        "api_key" AS "apiKey",
        "label",
        "created_at" AS "createdAt",
        "updated_at" AS "updatedAt"
      FROM "built_in_model_keys"
      WHERE "vendor" = $1
    `,
    [vendor],
  );
  return result.rows;
}

async function validateCanonicalColumnOrder(client: Client): Promise<void> {
  const columns = await client.query<{ columnNames: string[] | null }>(`
    SELECT array_agg(
      "column_name"::text ORDER BY "ordinal_position"
    ) AS "columnNames"
    FROM "information_schema"."columns"
    WHERE "table_schema" = 'public'
      AND "table_name" = 'built_in_model_keys'
  `);
  assert.deepEqual(columns.rows, [
    {
      columnNames: [
        "id",
        "vendor",
        "api_key",
        "label",
        "created_at",
        "updated_at",
      ],
    },
  ]);
}

async function validateCanonicalVendorType(client: Client): Promise<void> {
  const vendorType = await client.query<{ formattedType: string }>(`
    SELECT pg_catalog.format_type(
      "attribute"."atttypid",
      "attribute"."atttypmod"
    ) AS "formattedType"
    FROM "pg_catalog"."pg_attribute" AS "attribute"
    INNER JOIN "pg_catalog"."pg_class" AS "relation"
      ON "relation"."oid" = "attribute"."attrelid"
    INNER JOIN "pg_catalog"."pg_namespace" AS "namespace"
      ON "namespace"."oid" = "relation"."relnamespace"
    WHERE "namespace"."nspname" = 'public'
      AND "relation"."relname" = 'built_in_model_keys'
      AND "relation"."relkind" = 'r'
      AND "attribute"."attname" = 'vendor'
      AND "attribute"."attnum" > 0
      AND NOT "attribute"."attisdropped"
  `);
  assert.deepEqual(vendorType.rows, [
    { formattedType: "character varying(50)" },
  ]);
}

async function validateCanonicalRowLock(
  client: Client,
  databaseUrl: string,
  row: BuiltInModelKeyRow,
): Promise<void> {
  const contender = new Client({ connectionString: databaseUrl });
  await contender.connect();
  try {
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0371; new non-billing transactions are prohibited.
    await client.query("BEGIN");
    try {
      const locked = await client.query<BuiltInModelKeyRow>(
        `
          SELECT
            "id",
            "vendor",
            "api_key" AS "apiKey",
            "label"
          FROM "built_in_model_keys"
          WHERE "id" = $1
          FOR UPDATE
        `,
        [row.id],
      );
      assert.deepEqual(locked.rows, [row]);

      // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0372; new non-billing transactions are prohibited.
      await contender.query("BEGIN");
      try {
        await contender.query("SET LOCAL lock_timeout = '100ms'");
        await assert.rejects(
          contender.query(
            `
              UPDATE "built_in_model_keys"
              SET "label" = 'unexpected-lock-winner'
              WHERE "id" = $1
            `,
            [row.id],
          ),
          (error: unknown) => {
            return (
              typeof error === "object" &&
              error !== null &&
              Reflect.get(error, "code") === "55P03"
            );
          },
        );
      } finally {
        await contender.query("ROLLBACK");
      }
    } finally {
      await client.query("ROLLBACK");
    }
  } finally {
    await contender.end();
  }
}

async function validateCanonicalConflictHandling(
  client: Client,
  insertedRows: BuiltInModelKeyRow[],
): Promise<void> {
  const doNothingSql = `
    INSERT INTO "built_in_model_keys" (
      "id", "vendor", "api_key", "label", "created_at", "updated_at"
    )
    VALUES (default, $1, $2, default, default, default)
    ON CONFLICT ("vendor") DO NOTHING
  `;
  const insertedWithoutConflict = await client.query(doNothingSql, [
    fixture.conflictVendor,
    "conflict-key",
  ]);
  assert.equal(insertedWithoutConflict.rowCount, 1);
  const conflictRows = await readKeyByVendor(client, fixture.conflictVendor);
  assert.equal(conflictRows.length, 1);
  assert.equal(conflictRows[0]?.label, null);
  const ignoredConflict = await client.query(doNothingSql, [
    fixture.conflictVendor,
    "ignored-key",
  ]);
  assert.equal(ignoredConflict.rowCount, 0);
  assert.deepEqual(
    await readKeyByVendor(client, fixture.conflictVendor),
    conflictRows,
  );

  const upserted = await client.query<BuiltInModelKeyRow>(
    `
      INSERT INTO "built_in_model_keys" (
        "id", "vendor", "api_key", "label", "created_at", "updated_at"
      )
      VALUES (default, $1, $2, $3, default, default)
      ON CONFLICT ("vendor") DO UPDATE SET "vendor" = $4
      RETURNING
        "id", "vendor", "api_key" AS "apiKey", "label"
    `,
    [
      fixture.statementVendor,
      "conflicting-key",
      "conflicting-label",
      fixture.statementVendor,
    ],
  );
  assert.deepEqual(upserted.rows, insertedRows);
}

async function validateCanonicalStatements(
  client: Client,
  databaseUrl: string,
): Promise<void> {
  const baseline = await client.query<PreservedBuiltInModelKeyRow>(
    `
      INSERT INTO "built_in_model_keys" (
        "id", "vendor", "api_key", "label", "created_at", "updated_at"
      )
      VALUES (default, $1, $2, $3, default, default)
      RETURNING
        "id",
        "vendor",
        "api_key" AS "apiKey",
        "label",
        "created_at" AS "createdAt",
        "updated_at" AS "updatedAt"
    `,
    [fixture.baselineVendor, "baseline-key", "baseline-label"],
  );
  assert.equal(baseline.rows.length, 1);

  const inserted = await client.query<BuiltInModelKeyRow>(
    `
      INSERT INTO "built_in_model_keys" (
        "id", "vendor", "api_key", "label", "created_at", "updated_at"
      )
      VALUES (default, $1, $2, $3, default, default)
      RETURNING
        "id", "vendor", "api_key" AS "apiKey", "label"
    `,
    [fixture.statementVendor, "statement-key", "statement-label"],
  );
  assert.equal(inserted.rows.length, 1);
  const [insertedRow] = inserted.rows;
  assert.ok(insertedRow);
  assert.match(
    insertedRow.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  assert.deepEqual(
    await readKeyByVendor(client, fixture.statementVendor),
    inserted.rows,
  );
  await validateCanonicalConflictHandling(client, inserted.rows);

  const updated = await client.query<BuiltInModelKeyRow>(
    `
      UPDATE "built_in_model_keys"
      SET "label" = $1, "updated_at" = $2
      WHERE "id" = $3
      RETURNING
        "id", "vendor", "api_key" AS "apiKey", "label"
    `,
    ["updated-label", new Date("2026-08-22T00:00:00.000Z"), insertedRow.id],
  );
  const updatedRows = [{ ...insertedRow, label: "updated-label" }];
  assert.deepEqual(updated.rows, updatedRows);
  const [updatedRow] = updated.rows;
  assert.ok(updatedRow);
  await validateCanonicalRowLock(client, databaseUrl, updatedRow);

  const deleted = await client.query<BuiltInModelKeyRow>(
    `
      DELETE FROM "built_in_model_keys"
      WHERE "id" = $1
      RETURNING
        "id", "vendor", "api_key" AS "apiKey", "label"
    `,
    [insertedRow.id],
  );
  assert.deepEqual(deleted.rows, updatedRows);
  assert.deepEqual(await readKeyByVendor(client, fixture.statementVendor), []);
  assert.deepEqual(
    await readPreservedKeyByVendor(client, fixture.baselineVendor),
    baseline.rows,
  );
}

export async function validatePermanentBuiltInModelKeyState(
  databaseUrl: string,
): Promise<void> {
  console.log(
    "=== Validate permanent built-in model key current-schema state ===\n",
  );
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await validateCanonicalColumnOrder(client);
    await validateCanonicalVendorType(client);
    await validateCanonicalStatements(client, databaseUrl);

    console.log("   ✅ canonical current-schema column order is enforced");
    console.log("   ✅ canonical vendor type is character varying(50)");
    console.log(
      "   ✅ canonical statements preserve unrelated rows and support conflict handling, returning, and row locks\n",
    );
  } finally {
    await client.query(
      `
        DELETE FROM "built_in_model_keys"
        WHERE "vendor" IN ($1, $2, $3)
      `,
      [fixture.baselineVendor, fixture.conflictVendor, fixture.statementVendor],
    );
    await client.end();
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL is required");
  validatePermanentBuiltInModelKeyState(databaseUrl).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
