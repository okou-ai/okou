import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { z } from "zod";
import { formatRunBalanceError } from "@okouai/api-contracts/contracts/run-balance-errors";

interface Fixture {
  readonly name: string;
  readonly error: string | null;
  readonly provider?: string | null;
  readonly runtimeProvider?: string | null;
  readonly framework?: string | null;
  readonly reason?: string | null;
  readonly status?: string;
  readonly balance?: boolean;
}

const providerReason = "provider_insufficient_credits";
const rowsSchema = z.array(
  z.looseObject({
    id: z.string(),
    failure_reason: z.string().nullable(),
    model_provider: z.string().nullable(),
  }),
);
const fixtures: Fixture[] = [
  {
    name: "retained Claude BYOK",
    error: "Credit balance is too low",
    provider: "anthropic-api-key",
    balance: true,
  },
  {
    name: "built-in terminal",
    error: " Credit balance is too low\n",
    provider: "built-in",
    balance: true,
  },
  {
    name: "trusted launch framework with unknown owner",
    error: "Credit balance is too low",
    framework: "claude-code",
    balance: true,
  },
  {
    name: "persisted runtime provider",
    error: "Credit balance is too low",
    runtimeProvider: "openrouter-api-key",
    balance: true,
  },
  {
    name: "OpenRouter affordability",
    error:
      "API Error: 402 This request requires more credits. You can only afford 100 tokens.",
    provider: "openrouter-codex",
    reason: "insufficient_credits",
    balance: true,
  },
  { name: "unknown framework", error: "Credit balance is too low" },
  {
    name: "explicit different framework",
    error: "Credit balance is too low",
    provider: "anthropic-api-key",
    framework: "codex",
  },
  { name: "absent error", error: null },
  {
    name: "platform credits",
    error:
      "API Error: 402 Insufficient credits. Add credits or configure your own API key to continue.",
    provider: "built-in",
    reason: "insufficient_credits",
  },
  {
    name: "platform envelope",
    error: 'API Error: 402 {"error":"insufficient_credits"}',
    reason: "insufficient_credits",
  },
  { name: "generic payment status", error: "API Error: 402 Payment required" },
  {
    name: "quoted user content",
    error: "The tool said Credit balance is too low",
    provider: "anthropic-api-key",
  },
  {
    name: "successful content containing an error envelope",
    error: 'Example: {"error":{"code":"billing"}}',
  },
  { name: "invalid JSON", error: 'API Error: 402 {"error":' },
  {
    name: "invalid typed field",
    error: 'API Error: 402 {"error":{"code":"billing","message":false}}',
  },
  {
    name: "first valid nonbilling envelope wins",
    error:
      'API Error: 402 {"error":{},"type":"response.failed","response":{"error":{"code":"billing"}}}',
  },
  {
    name: "string status is not a billing code",
    error: 'API Error: 402 {"error":{"code":"402"}}',
  },
  ...["completed", "running", "pending", "cancelled"].map((status) => {
    return {
      name: `preserve ${status} run`,
      status,
      error: "Credit balance is too low",
      provider: "anthropic-api-key",
    };
  }),
  ...["future_reason", "provider_overloaded", providerReason, ""].map(
    (reason) => {
      return {
        name: `preserve structured reason ${reason}`,
        reason,
        error: "Credit balance is too low",
        provider: "anthropic-api-key",
      };
    },
  ),
];

for (const error of [
  { code: "billing_hard_limit_reached" },
  { type: "INSUFFICIENT_QUOTA" },
  { code: 402 },
  {
    type: "invalid_request_error",
    message: "Your credit balance is too low to access the Anthropic API.",
  },
]) {
  for (const body of [
    { error },
    { type: "response.failed", response: { error } },
    { choices: [{ error }] },
    { type: "error", ...error },
  ]) {
    // A top-level error envelope requires type=error. A billing type belongs
    // inside an error object, not in place of that discriminator.
    const balance =
      !("type" in body) ||
      body.type === "response.failed" ||
      body.type === "error";
    fixtures.push({
      name: `typed provider ${JSON.stringify(body)}`,
      error: `Unexpected status 400 Bad Request: ${JSON.stringify(body)}`,
      provider: "built-in",
      balance,
    });
  }
}

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const client = new Client({ connectionString: databaseUrl });
await client.connect();
const schema = `provider_balance_${randomUUID().replaceAll("-", "")}`;
const migration = await readFile(
  new URL(
    "../src/migrations/1144_normalize_provider_balance_failures.sql",
    import.meta.url,
  ),
  "utf8",
);

try {
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout = '1s'");
  await client.query("SET LOCAL statement_timeout = '10s'");
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET LOCAL search_path TO "${schema}"`);
  // This transition fixture is deliberately historical: current API callers
  // cannot create the retired combination of terminal cause and raw evidence.
  await client.query(`CREATE TABLE agent_runs (
    id text PRIMARY KEY,
    status text NOT NULL,
    error text,
    failure_reason text,
    model_provider text,
    model_runtime_provider text,
    launch_snapshot jsonb,
    untouched jsonb NOT NULL DEFAULT '{"diagnostics":"retained"}'
  )`);
  for (const fixture of fixtures) {
    await client.query(
      `INSERT INTO agent_runs
        (id, status, error, failure_reason, model_provider, model_runtime_provider, launch_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        fixture.name,
        fixture.status ?? "failed",
        fixture.error,
        fixture.reason ?? null,
        fixture.provider ?? null,
        fixture.runtimeProvider ?? null,
        fixture.framework ? { framework: fixture.framework } : null,
      ],
    );
  }
  await client.query(`INSERT INTO agent_runs (id, status, error)
    SELECT 'unrelated-' || n, 'failed', 'Unrelated execution error'
    FROM generate_series(1, 30000) AS n`);
  const before = rowsSchema.parse(
    (await client.query("SELECT * FROM agent_runs ORDER BY id")).rows,
  );
  await client.query("SAVEPOINT before_balance_migration");
  await client.query(migration);
  const after = rowsSchema.parse(
    (await client.query("SELECT * FROM agent_runs ORDER BY id")).rows,
  );
  const eligible = new Set(
    fixtures
      .filter((fixture) => {
        return fixture.balance;
      })
      .map((fixture) => {
        return fixture.name;
      }),
  );
  assert.deepEqual(
    after,
    before.map((row) => {
      return eligible.has(row.id)
        ? { ...row, failure_reason: providerReason }
        : row;
    }),
    "Only the recognized failed terminal causes change; raw evidence stays intact",
  );
  for (const row of after) {
    if (!eligible.has(row.id)) {
      continue;
    }
    assert.equal(
      formatRunBalanceError({
        failureReason: row.failure_reason,
        modelProvider: row.model_provider,
      }),
      row.model_provider === "built-in" || row.model_provider === null
        ? "The current model is unavailable."
        : "Your connected model provider account has insufficient balance.",
    );
  }
  await client.query("ROLLBACK TO SAVEPOINT before_balance_migration");
  assert.deepEqual(
    (await client.query("SELECT * FROM agent_runs ORDER BY id")).rows,
    before,
    "The complete transform rolls back atomically",
  );
  await client.query(migration);
  await client.query(migration);
  assert.deepEqual(
    (await client.query("SELECT * FROM agent_runs ORDER BY id")).rows,
    after,
    "Retry preserves already-normalized rows",
  );
  console.log(
    `Provider balance migration passed ${fixtures.length} cases and 30000 retained unrelated rows`,
  );
} finally {
  await client.query("ROLLBACK");
  await client.end();
}
