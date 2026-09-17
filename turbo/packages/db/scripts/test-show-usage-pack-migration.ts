import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { Client } from "pg";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const client = new Client({ connectionString: databaseUrl });
await client.connect();
const schema = `show_usage_pack_${randomUUID().replaceAll("-", "")}`;

try {
  await client.query("BEGIN");
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET LOCAL search_path TO "${schema}"`);
  await client.query(
    await readFile(
      new URL(
        "./fixtures/show-usage-pack-before-migration.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );

  const expected: { org_id: string; show_usage_pack: boolean }[] = [];
  const sources = [
    "stripe_subscription",
    "stripe_atom_grant",
    "org_metadata_bootstrap",
    "org_metadata_migration",
  ];
  for (const source of sources) {
    for (const tier of ["pro", "team", "custom", "limited-free-1"]) {
      for (const required of [true, false]) {
        const orgId = `${source}_${tier}_${required}`;
        await client.query(
          `INSERT INTO org_plan_entitlements (
            org_id, plan_key, plan_rank, source,
            member_invite_usage_pack_required, restricted_built_in_models
          ) VALUES ($1, $2, 1, $3, $4, false)`,
          [orgId, tier, source, required],
        );
        expected.push({
          org_id: orgId,
          show_usage_pack: required && (tier === "pro" || tier === "team"),
        });
      }
    }
  }
  const migration = await readFile(
    new URL("../src/migrations/1090_show_usage_pack.sql", import.meta.url),
    "utf8",
  );
  await client.query(migration);
  const backfilled = await client.query(
    "SELECT org_id, show_usage_pack FROM org_plan_entitlements ORDER BY org_id",
  );
  assert.deepEqual(
    backfilled.rows,
    expected.sort((left, right) => {
      return left.org_id.localeCompare(right.org_id);
    }),
  );
  const cleanup = await readFile(
    new URL(
      "../src/migrations/1092_retire_show_usage_pack_compatibility.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await client.query(cleanup);
  const retained = await client.query(
    "SELECT org_id, show_usage_pack FROM org_plan_entitlements ORDER BY org_id",
  );
  assert.deepEqual(retained.rows, backfilled.rows);

  console.log("Usage pack historical backfill and retained data checks passed");
} finally {
  await client.query("ROLLBACK");
  await client.end();
}
