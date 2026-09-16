import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { Client } from "pg";

const { values } = parseArgs({
  options: {
    day: { type: "string" },
    "org-id": { type: "string" },
    "user-id": { type: "string" },
  },
});
assert.ok(
  values.day && /^\d{4}-\d{2}-\d{2}$/.test(values.day),
  "--day YYYY-MM-DD (UTC) is required",
);
assert.equal(
  new Date(`${values.day}T00:00:00Z`).toISOString().slice(0, 10),
  values.day,
  "invalid UTC day",
);
assert.ok(
  !values["user-id"] || values["org-id"],
  "--user-id requires --org-id",
);
assert.ok(
  process.env.DATABASE_URL,
  "DATABASE_URL is required; use only an authorized database",
);
const query = await readFile(
  new URL("../../../../ops/pi-memory-stage1/v1/ledger.sql", import.meta.url),
  "utf8",
);
const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await client.query(
    "SET LOCAL TIME ZONE 'UTC'; SET LOCAL lock_timeout = '1s'; SET LOCAL statement_timeout = '5s'",
  );
  const result = await client.query(query, [
    values.day,
    values["org-id"] ?? null,
    values["user-id"] ?? null,
    {},
  ]);
  await client.query("COMMIT");
  console.log(JSON.stringify(result.rows[0].report, null, 2));
} finally {
  await client.end();
}
