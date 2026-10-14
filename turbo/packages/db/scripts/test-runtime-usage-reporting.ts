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
    ["model", "gpt-6-sol", "legacy-alias", "legacy-alias"],
    [
      "model",
      "claude-opus-5-5",
      "anthropic/claude-opus-4.8",
      "anthropic/claude-opus-4.8",
    ],
    ["model", "gpt-6-sol", "", "unknown"],
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
  // Both finalized ledger representations use the same projection, without a
  // Run relation. Constants protect identity, quantity and settled Credit totals.
  const query = new PgDialect().sqlToQuery(sql`
    WITH usage_event AS (
      SELECT 'model'::text AS kind, 'openai/gpt-6-luna'::text AS provider,
             17::bigint AS credits, 1000::bigint AS quantity
      UNION ALL
      SELECT 'model', '@preset/retired-operator-preset', 23, 2000
    ), usage_event_hourly_rollup AS (SELECT * FROM usage_event)
    SELECT ${modelUsageDisplayProviderSql(usageEvent)} AS provider, credits, quantity
    FROM usage_event
    UNION ALL
    SELECT ${modelUsageDisplayProviderSql({ provider: sql`usage_event_hourly_rollup.provider` })} AS provider, credits, quantity
    FROM usage_event_hourly_rollup
  `);
  const rows = await database.unsafe(query.sql);
  assert.deepStrictEqual(rows.slice(0, 2), rows.slice(2));
  assert.equal(
    rows.reduce((total, row) => {
      return total + Number(row.credits);
    }, 0),
    80,
  );
  assert.equal(
    rows.reduce((total, row) => {
      return total + Number(row.quantity);
    }, 0),
    6000,
  );
  console.log(
    `Runtime reporting identity: ${cases.length} SQL fixtures passed`,
  );
} finally {
  await database.end();
}
