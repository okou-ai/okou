import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const client = new Client({ connectionString: databaseUrl });
await client.connect();
const schema = `legacy_free_retirement_${randomUUID().replaceAll("-", "")}`;
const migration = await readFile(
  new URL(
    "../src/migrations/1314_retire_legacy_free_tier.sql",
    import.meta.url,
  ),
  "utf8",
);

async function snapshot(table: "org_metadata" | "org_plan_entitlements") {
  return (
    await client.query<{ value: Record<string, unknown> }>(
      `SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY org_id`,
    )
  ).rows.map((row) => {
    return row.value;
  });
}

async function expectRejected(statement: string, constraint: string) {
  await client.query("SAVEPOINT rejected_write");
  try {
    await assert.rejects(client.query(statement), (error: unknown) => {
      return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23514" &&
        "constraint" in error &&
        error.constraint === constraint
      );
    });
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT rejected_write");
    await client.query("RELEASE SAVEPOINT rejected_write");
  }
}

try {
  await client.query("BEGIN");
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET LOCAL search_path TO "${schema}"`);
  await client.query(`
    CREATE TABLE org_metadata (
      org_id text PRIMARY KEY,
      tier text NOT NULL DEFAULT 'limited-free-1',
      credits bigint NOT NULL DEFAULT 0,
      stripe_subscription_id text,
      subscription_status text,
      pending_subscription_schedule_id text,
      pending_subscription_target_tier text,
      pending_subscription_change_at timestamp,
      model_mode text NOT NULL DEFAULT 'custom',
      onboarding_complete boolean NOT NULL DEFAULT true,
      updated_at timestamp NOT NULL DEFAULT '2026-01-01'
    );
    CREATE TABLE org_plan_entitlements (
      org_id text PRIMARY KEY,
      plan_key text NOT NULL,
      plan_rank integer NOT NULL DEFAULT 0,
      source text NOT NULL DEFAULT 'manual',
      status text NOT NULL DEFAULT 'active',
      base_concurrency_limit integer NOT NULL DEFAULT 1,
      can_buy_concurrency boolean NOT NULL DEFAULT false,
      can_buy_credits boolean NOT NULL DEFAULT true,
      show_usage_pack boolean NOT NULL DEFAULT false,
      auto_recharge_allowed boolean NOT NULL DEFAULT false,
      support_byok boolean NOT NULL DEFAULT false,
      restricted_built_in_models boolean NOT NULL DEFAULT false,
      video_generation_allowed boolean NOT NULL DEFAULT true,
      workflow_webhook_trigger_allowed boolean NOT NULL DEFAULT false,
      audio_lifetime_limit integer DEFAULT 10,
      audio_daily_rate_limit integer NOT NULL DEFAULT 10,
      audio_daily_duration_seconds integer NOT NULL DEFAULT 600,
      stripe_subscription_id text,
      stripe_price_id text,
      expires_at timestamp,
      metadata_hash text,
      source_metadata jsonb NOT NULL DEFAULT '{"audit":"preserve"}',
      updated_at timestamp NOT NULL DEFAULT '2026-01-01'
    );
    INSERT INTO org_metadata (org_id, tier, credits) VALUES
      ('legacy', 'free', 12345),
      ('limited', 'limited-free-1', 75),
      ('paid', 'team', 20000);
    UPDATE org_metadata SET
      stripe_subscription_id = 'sub_paid', subscription_status = 'active',
      pending_subscription_schedule_id = 'schedule_paid',
      pending_subscription_target_tier = 'free',
      pending_subscription_change_at = '2026-12-01'
    WHERE org_id = 'paid';
    INSERT INTO org_plan_entitlements (org_id, plan_key, status) VALUES
      ('legacy', 'free', 'suspended'),
      ('entitlement_only', 'free', 'active'),
      ('limited', 'limited-free-1', 'active'),
      ('paid', 'team', 'active');
    UPDATE org_plan_entitlements SET
      stripe_price_id = 'historical_price', expires_at = '2027-01-01',
      metadata_hash = 'old-capability-hash'
    WHERE plan_key = 'free';
  `);

  const metadataBefore = await snapshot("org_metadata");
  const entitlementsBefore = await snapshot("org_plan_entitlements");

  // A failed migration must roll back both the DDL and all original data.
  for (const setup of [
    `INSERT INTO org_metadata (org_id, tier) VALUES ('unsafe', 'free')`,
    `INSERT INTO org_metadata (org_id, tier) VALUES ('unsafe', 'free');
     INSERT INTO org_plan_entitlements (org_id, plan_key) VALUES ('unsafe', 'pro')`,
    `INSERT INTO org_metadata (org_id, tier) VALUES ('unsafe', 'pro');
     INSERT INTO org_plan_entitlements (org_id, plan_key) VALUES ('unsafe', 'free')`,
    `INSERT INTO org_plan_entitlements (org_id, plan_key, stripe_subscription_id)
     VALUES ('unsafe', 'free', 'sub_linked')`,
    `INSERT INTO org_metadata (org_id, tier, subscription_status)
     VALUES ('unsafe', 'free', 'active');
     INSERT INTO org_plan_entitlements (org_id, plan_key) VALUES ('unsafe', 'free')`,
    `INSERT INTO org_metadata (org_id, tier, pending_subscription_schedule_id)
     VALUES ('unsafe', 'free', 'schedule_linked');
     INSERT INTO org_plan_entitlements (org_id, plan_key) VALUES ('unsafe', 'free')`,
  ]) {
    await client.query("SAVEPOINT unsafe_migration");
    await client.query(setup);
    await assert.rejects(client.query(migration), (error: unknown) => {
      return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "P0001"
      );
    });
    await client.query("ROLLBACK TO SAVEPOINT unsafe_migration");
    await client.query("RELEASE SAVEPOINT unsafe_migration");
    assert.deepEqual(await snapshot("org_metadata"), metadataBefore);
    assert.deepEqual(
      await snapshot("org_plan_entitlements"),
      entitlementsBefore,
    );
    const constraints = await client.query(`
      SELECT conname FROM pg_constraint
      WHERE connamespace = '${schema}'::regnamespace
        AND conname LIKE '%not_free'
    `);
    assert.equal(constraints.rowCount, 0);
  }

  await client.query(migration);
  const metadataAfter = await snapshot("org_metadata");
  assert.equal(metadataAfter.length, metadataBefore.length);
  for (const before of metadataBefore) {
    const after = metadataAfter.find((row) => {
      return row.org_id === before.org_id;
    });
    assert.ok(after);
    assert.deepEqual(after, {
      ...before,
      tier: before.tier === "free" ? "limited-free-1" : before.tier,
      pending_subscription_target_tier:
        before.pending_subscription_target_tier === "free"
          ? "limited-free-1"
          : before.pending_subscription_target_tier,
      updated_at:
        before.org_id === "limited" ? before.updated_at : after.updated_at,
    });
  }
  const entitlementsAfter = await snapshot("org_plan_entitlements");
  assert.equal(entitlementsAfter.length, entitlementsBefore.length);
  for (const before of entitlementsBefore) {
    const after = entitlementsAfter.find((row) => {
      return row.org_id === before.org_id;
    });
    assert.ok(after);
    assert.deepEqual(
      after,
      before.plan_key === "free"
        ? {
            ...before,
            plan_key: "limited-free-1",
            plan_rank: 0,
            base_concurrency_limit: 2,
            can_buy_concurrency: false,
            can_buy_credits: false,
            show_usage_pack: false,
            auto_recharge_allowed: false,
            support_byok: true,
            restricted_built_in_models: true,
            video_generation_allowed: false,
            workflow_webhook_trigger_allowed: false,
            audio_lifetime_limit: 10,
            audio_daily_rate_limit: 10,
            audio_daily_duration_seconds: 600,
            metadata_hash: null,
            updated_at: after.updated_at,
          }
        : before,
    );
  }
  const constraints = await client.query<{ convalidated: boolean }>(`
    SELECT convalidated FROM pg_constraint
    WHERE connamespace = '${schema}'::regnamespace
      AND conname LIKE '%not_free'
  `);
  assert.equal(constraints.rowCount, 3);
  assert.ok(
    constraints.rows.every((row) => {
      return row.convalidated;
    }),
  );

  for (const statement of [
    `INSERT INTO org_metadata (org_id, tier) VALUES ('new_free', 'free')`,
    `UPDATE org_metadata SET tier = 'free' WHERE org_id = 'limited'`,
  ]) {
    await expectRejected(statement, "chk_org_metadata_tier_not_free");
  }
  for (const statement of [
    `INSERT INTO org_metadata (org_id, pending_subscription_target_tier) VALUES ('new_pending', 'free')`,
    `UPDATE org_metadata SET pending_subscription_target_tier = 'free' WHERE org_id = 'paid'`,
  ]) {
    await expectRejected(statement, "chk_org_metadata_pending_target_not_free");
  }
  for (const statement of [
    `INSERT INTO org_plan_entitlements (org_id, plan_key) VALUES ('new_entitlement', 'free')`,
    `UPDATE org_plan_entitlements SET plan_key = 'free' WHERE org_id = 'limited'`,
  ]) {
    await expectRejected(
      statement,
      "chk_org_plan_entitlements_plan_key_not_free",
    );
  }
  console.log(
    "Legacy Free retirement: preservation, entitlement-only rows, paid pending targets, rollback and write rejection passed",
  );
} finally {
  await client.query("ROLLBACK");
  await client.end();
}
