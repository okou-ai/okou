import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const client = new Client({ connectionString: databaseUrl });
await client.connect();
const testSchema = `custom_model_retirement_${randomUUID().replaceAll("-", "")}`;
const sql = await readFile(
  new URL(
    "../src/migrations/1319_retire_custom_model_configuration.sql",
    import.meta.url,
  ),
  "utf8",
);

// The operator converts Custom orgs before merge. The migration is contraction
// only: it must not rewrite subscriptions, credentials, credits or preferences.
assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|CASCADE)\b/i);
assert.match(sql, /DROP TABLE "org_model_policies"/);
assert.match(sql, /DROP TABLE "model_provider_surfaces"/);
assert.match(sql, /DROP TABLE "model_provider_connections"/);
assert.match(sql, /DROP COLUMN "model_mode"/);

try {
  await client.query("BEGIN");
  await client.query(`CREATE SCHEMA "${testSchema}"`);
  await client.query(`SET LOCAL search_path TO "${testSchema}"`);
  await client.query(`
    CREATE TABLE org_metadata (
      org_id text PRIMARY KEY, credits bigint NOT NULL, tier text NOT NULL,
      model_mode text NOT NULL DEFAULT 'custom',
      CONSTRAINT chk_org_metadata_model_mode CHECK (model_mode IN ('auto','custom'))
    );
    CREATE TABLE secrets (id text PRIMARY KEY, value text NOT NULL);
    CREATE TABLE model_provider_connections (
      id text PRIMARY KEY, secret_id text REFERENCES secrets(id)
    );
    CREATE TABLE model_provider_surfaces (
      id text PRIMARY KEY, connection_id text REFERENCES model_provider_connections(id)
    );
    CREATE TABLE org_model_policies (
      id text PRIMARY KEY, surface_id text REFERENCES model_provider_surfaces(id)
    );
    CREATE TABLE model_providers (id text PRIMARY KEY, owner text NOT NULL);
    CREATE TABLE model_provider_accounts (id text PRIMARY KEY, provider_id text REFERENCES model_providers(id));
    CREATE TABLE model_provider_account_secrets (id text PRIMARY KEY, account_id text REFERENCES model_provider_accounts(id));
    CREATE TABLE run_model_catalog (id text PRIMARY KEY, label text NOT NULL);
    CREATE TABLE model_routes (id text PRIMARY KEY, model text REFERENCES run_model_catalog(id));
    CREATE TABLE usage_pricing (id text PRIMARY KEY, price bigint NOT NULL);
    CREATE TABLE org_members_metadata (id text PRIMARY KEY, selected_model text NOT NULL);
    CREATE TABLE workflows (id text PRIMARY KEY, model text NOT NULL);
    CREATE TABLE workflow_automations (id text PRIMARY KEY, workflow_id text REFERENCES workflows(id), enabled boolean NOT NULL);
    INSERT INTO org_metadata VALUES ('org_fixture',-24,'pro','auto');
    INSERT INTO secrets VALUES ('personal-secret','fixture-ciphertext');
    INSERT INTO model_providers VALUES ('personal-provider','member');
    INSERT INTO model_provider_accounts VALUES ('personal-account','personal-provider');
    INSERT INTO model_provider_account_secrets VALUES ('account-secret','personal-account');
    INSERT INTO run_model_catalog VALUES ('subscription-model','Personal subscription model');
    INSERT INTO model_routes VALUES ('personal-route','subscription-model');
    INSERT INTO usage_pricing VALUES ('auto-price',1200);
    INSERT INTO org_members_metadata VALUES ('member','subscription-model');
    INSERT INTO workflows VALUES ('workflow','subscription-model');
    INSERT INTO workflow_automations VALUES ('automation','workflow',true);
    INSERT INTO model_provider_connections VALUES ('retired-gateway','personal-secret');
    INSERT INTO model_provider_surfaces VALUES ('retired-surface','retired-gateway');
    INSERT INTO org_model_policies VALUES ('retired-policy','retired-surface');
  `);
  const retained = [
    "secrets",
    "model_providers",
    "model_provider_accounts",
    "model_provider_account_secrets",
    "run_model_catalog",
    "model_routes",
    "usage_pricing",
    "org_members_metadata",
    "workflows",
    "workflow_automations",
  ];
  const before = new Map<string, unknown>();
  for (const table of retained) {
    before.set(
      table,
      (await client.query(`SELECT * FROM "${table}" ORDER BY id`)).rows,
    );
  }
  const orgBefore = (
    await client.query(
      "SELECT org_id, credits, tier FROM org_metadata ORDER BY org_id",
    )
  ).rows;
  await client.query("SET LOCAL lock_timeout = '1s'");
  await client.query("SET LOCAL statement_timeout = '10s'");
  await client.query(sql);
  for (const table of [
    "org_model_policies",
    "model_provider_surfaces",
    "model_provider_connections",
  ]) {
    assert.deepEqual(
      (
        await client.query("SELECT to_regclass($1) AS retired", [
          `${testSchema}.${table}`,
        ])
      ).rows,
      [{ retired: null }],
    );
  }
  const mode = await client.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema=$1 AND table_name='org_metadata' AND column_name='model_mode'",
    [testSchema],
  );
  assert.equal(mode.rows[0]?.count, 0);
  assert.deepEqual(
    (
      await client.query(
        "SELECT org_id, credits, tier FROM org_metadata ORDER BY org_id",
      )
    ).rows,
    orgBefore,
  );
  for (const table of retained) {
    assert.deepEqual(
      (await client.query(`SELECT * FROM "${table}" ORDER BY id`)).rows,
      before.get(table),
      `${table} must remain unchanged`,
    );
  }
  console.log(
    "Custom model tables/mode dropped; personal subscriptions, Auto pricing, credits and automations retained",
  );
} finally {
  await client.query("ROLLBACK");
  await client.end();
}
