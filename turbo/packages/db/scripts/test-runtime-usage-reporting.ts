import assert from "node:assert/strict";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { modelUsageDisplayProviderSql } from "../src/runtime/model-usage-reporting";
import { usageEvent } from "../src/schema/usage-event";

// Constant-only SQL fixtures exercise the actual projection without fabricating
// business rows, requiring a runtime switch, or touching settled ledger data.
const url = process.env.DATABASE_URL;
if (!url)
  throw new Error("DATABASE_URL is required for the reporting validator");
const database = postgres(url, { max: 1 });
try {
  const cases = [
    ["model", "okou-1.0", "okou-1.0", "okou-1.0"],
    ["model", "auto", "@preset/okou-1-0", "@preset/okou-1-0"],
    ["model", "auto", "@preset/okou-experimental", "@preset/okou-experimental"],
    ["model", "okou-1.0", "@preset/okou-1-0-dsf", "@preset/okou-1-0-dsf"],
    ["model", null, "@preset/deleted-run", "@preset/deleted-run"],
    ["connector", "auto", "github", "github"],
    ["image", "auto", "gpt-image-2", "gpt-image-2"],
    ["model", "gpt-6-sol", "legacy-alias", "gpt-6-sol"],
  ] as const;
  for (const [kind, selected, provider, expected] of cases) {
    const query = new PgDialect().sqlToQuery(sql`
      WITH agent_runs AS (SELECT ${selected}::text AS selected_model),
      usage_event AS (SELECT ${kind}::text AS kind, ${provider}::text AS provider)
      SELECT ${modelUsageDisplayProviderSql(usageEvent)} AS provider
      FROM usage_event CROSS JOIN agent_runs
    `);
    const params = query.params.map((value) => {
      if (value !== null && typeof value !== "string") {
        throw new Error("Reporting fixtures must bind only strings or NULL");
      }
      return value;
    });
    const rows = await database.unsafe(query.sql, params);
    assert.deepStrictEqual(
      rows.map((row) => {
        return row.provider;
      }),
      [expected],
    );
  }
  console.log(
    `Runtime reporting identity: ${cases.length} SQL fixtures passed`,
  );
} finally {
  await database.end();
}
