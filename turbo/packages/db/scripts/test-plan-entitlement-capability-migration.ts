import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { Client } from "pg";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const client = new Client({ connectionString: databaseUrl });
await client.connect();
const schema = `plan_capability_${randomUUID().replaceAll("-", "")}`;
const originalUpdatedAt = "2026-01-01 00:00:00";

try {
  await client.query("BEGIN");
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET LOCAL search_path TO "${schema}"`);
  await client.query(`
    CREATE TABLE org_plan_entitlements (
      org_id text PRIMARY KEY,
      plan_key text NOT NULL,
      source varchar(50) NOT NULL,
      base_concurrency_limit integer NOT NULL,
      support_byok boolean NOT NULL,
      updated_at timestamp NOT NULL
    )
  `);

  const expected: {
    org_id: string;
    base_concurrency_limit: number;
    support_byok: boolean;
    updated: boolean;
  }[] = [];
  const managedSources = [
    "stripe_subscription",
    "stripe_atom_grant",
    "org_metadata_bootstrap",
    "org_metadata_migration",
  ] as const;
  const stalePlans = [
    { planKey: "free", beforeLimit: 1, afterLimit: 2, supportByok: true },
    {
      planKey: "limited-free-1",
      beforeLimit: 1,
      afterLimit: 2,
      supportByok: true,
    },
    { planKey: "pro", beforeLimit: 2, afterLimit: 3, supportByok: true },
    { planKey: "team", beforeLimit: 10, afterLimit: 10, supportByok: true },
    { planKey: "custom", beforeLimit: 10, afterLimit: 10, supportByok: true },
    {
      planKey: "pro-suspend",
      beforeLimit: 0,
      afterLimit: 0,
      supportByok: false,
    },
  ] as const;

  for (const source of managedSources) {
    for (const plan of stalePlans) {
      const orgId = `${source}_${plan.planKey}`;
      await client.query(
        `INSERT INTO org_plan_entitlements (
          org_id, plan_key, source, base_concurrency_limit, support_byok, updated_at
        ) VALUES ($1, $2, $3, $4, false, $5)`,
        [orgId, plan.planKey, source, plan.beforeLimit, originalUpdatedAt],
      );
      expected.push({
        org_id: orgId,
        base_concurrency_limit: plan.afterLimit,
        support_byok: plan.supportByok,
        updated: plan.planKey !== "pro-suspend",
      });
    }
  }

  for (const planKey of ["free", "limited-free-1", "pro"] as const) {
    const orgId = `manual_${planKey}`;
    await client.query(
      `INSERT INTO org_plan_entitlements (
        org_id, plan_key, source, base_concurrency_limit, support_byok, updated_at
      ) VALUES ($1, $2, 'manual', 27, false, $3)`,
      [orgId, planKey, originalUpdatedAt],
    );
    expected.push({
      org_id: orgId,
      base_concurrency_limit: 27,
      support_byok: false,
      updated: false,
    });
  }

  await client.query(
    `INSERT INTO org_plan_entitlements (
      org_id, plan_key, source, base_concurrency_limit, support_byok, updated_at
    ) VALUES ('already_current', 'limited-free-1', 'org_metadata_bootstrap', 2, true, $1)`,
    [originalUpdatedAt],
  );
  expected.push({
    org_id: "already_current",
    base_concurrency_limit: 2,
    support_byok: true,
    updated: false,
  });

  const migration = await readFile(
    new URL(
      "../src/migrations/1187_expand_free_concurrency_byok.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await client.query(migration);

  const result = await client.query<{
    org_id: string;
    base_concurrency_limit: number;
    support_byok: boolean;
    updated: boolean;
  }>(`
    SELECT
      org_id,
      base_concurrency_limit,
      support_byok,
      updated_at IS DISTINCT FROM TIMESTAMP '2026-01-01 00:00:00' AS updated
    FROM org_plan_entitlements
    ORDER BY org_id
  `);

  assert.deepEqual(
    result.rows,
    expected.sort((left, right) => {
      return left.org_id.localeCompare(right.org_id);
    }),
  );
  console.log("Plan entitlement concurrency and BYOK backfill checks passed");
} finally {
  await client.query("ROLLBACK");
  await client.end();
}
