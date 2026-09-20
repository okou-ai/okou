import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { Client } from "pg";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");

const client = new Client({ connectionString: databaseUrl });
await client.connect();
const schema = `pro_suspend_retirement_${randomUUID().replaceAll("-", "")}`;
const before = "2026-01-01 00:00:00";

async function expectCheckViolation(statement: string): Promise<void> {
  await client.query("SAVEPOINT expected_check_violation");
  try {
    await assert.rejects(client.query(statement), (error: unknown) => {
      return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23514"
      );
    });
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT expected_check_violation");
    await client.query("RELEASE SAVEPOINT expected_check_violation");
  }
}

try {
  await client.query("BEGIN");
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET LOCAL search_path TO "${schema}"`);
  await client.query(`
    CREATE TABLE org_metadata (
      org_id text PRIMARY KEY,
      credits bigint NOT NULL DEFAULT 0,
      tier text NOT NULL DEFAULT 'limited-free-1',
      stripe_subscription_id text,
      subscription_status text,
      pending_subscription_target_tier text,
      onboarding_complete boolean NOT NULL DEFAULT false,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    );

    CREATE TABLE org_plan_entitlements (
      org_id text PRIMARY KEY,
      plan_key text NOT NULL,
      plan_rank integer NOT NULL,
      source text NOT NULL,
      status text NOT NULL,
      base_concurrency_limit integer NOT NULL,
      can_buy_concurrency boolean NOT NULL,
      can_buy_credits boolean NOT NULL,
      show_usage_pack boolean NOT NULL,
      auto_recharge_allowed boolean NOT NULL,
      support_byok boolean NOT NULL,
      restricted_built_in_models boolean NOT NULL,
      video_generation_allowed boolean NOT NULL,
      workflow_webhook_trigger_allowed boolean NOT NULL,
      audio_lifetime_limit integer,
      audio_daily_rate_limit integer NOT NULL,
      audio_daily_duration_seconds integer NOT NULL,
      stripe_subscription_id text,
      stripe_price_id text,
      current_period_start timestamp,
      current_period_end timestamp,
      cancel_at timestamp,
      expires_at timestamp,
      metadata_version text NOT NULL DEFAULT '1',
      metadata_hash text,
      source_metadata jsonb NOT NULL DEFAULT '{}',
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    );
  `);

  await client.query(
    `
      INSERT INTO org_metadata (
        org_id,
        credits,
        tier,
        stripe_subscription_id,
        subscription_status,
        pending_subscription_target_tier,
        onboarding_complete,
        created_at,
        updated_at
      ) VALUES
        ('legacy', 12345, 'pro-suspend', NULL, 'canceled', NULL, true, $1, $1),
        ('pending', 50, 'team', 'sub_pending', 'active', 'pro-suspend', true, $1, $1),
        ('limited', 75, 'limited-free-1', NULL, NULL, NULL, false, $1, $1)
    `,
    [before],
  );
  await client.query(
    `
      INSERT INTO org_plan_entitlements (
        org_id,
        plan_key,
        plan_rank,
        source,
        status,
        base_concurrency_limit,
        can_buy_concurrency,
        can_buy_credits,
        show_usage_pack,
        auto_recharge_allowed,
        support_byok,
        restricted_built_in_models,
        video_generation_allowed,
        workflow_webhook_trigger_allowed,
        audio_lifetime_limit,
        audio_daily_rate_limit,
        audio_daily_duration_seconds,
        stripe_subscription_id,
        stripe_price_id,
        current_period_start,
        current_period_end,
        cancel_at,
        expires_at,
        metadata_hash,
        source_metadata,
        created_at,
        updated_at
      ) VALUES
        (
          'legacy', 'pro-suspend', 9, 'org_metadata_migration', 'suspended',
          0, true, true, true, true, true, false, true, true,
          0, 0, 0, 'sub_historical', 'price_historical',
          '2025-12-01', '2026-01-01', '2026-01-01', '2026-02-01',
          'historical-hash', '{"audit":"preserve"}', $1, $1
        ),
        (
          'limited', 'limited-free-1', 0, 'org_metadata_bootstrap', 'active',
          1, false, false, false, false, false, true, false, false,
          10, 10, 600, NULL, NULL, NULL, NULL, NULL, NULL,
          NULL, '{"untouched":true}', $1, $1
        )
    `,
    [before],
  );

  const unchangedMetadataBefore = (
    await client.query(
      "SELECT to_jsonb(row_value) AS value FROM org_metadata AS row_value WHERE org_id = 'limited'",
    )
  ).rows[0]?.value;
  const unchangedEntitlementBefore = (
    await client.query(
      "SELECT to_jsonb(row_value) AS value FROM org_plan_entitlements AS row_value WHERE org_id = 'limited'",
    )
  ).rows[0]?.value;

  const migration = await readFile(
    new URL(
      "../src/migrations/1177_retire_pro_suspend_tier.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await client.query(migration);

  const metadata = await client.query<{
    credits: string;
    onboardingComplete: boolean;
    orgId: string;
    pendingTarget: string | null;
    stripeSubscriptionId: string | null;
    subscriptionStatus: string | null;
    tier: string;
    updatedAt: string;
  }>(`
    SELECT
      org_id AS "orgId",
      credits::text,
      tier,
      stripe_subscription_id AS "stripeSubscriptionId",
      subscription_status AS "subscriptionStatus",
      pending_subscription_target_tier AS "pendingTarget",
      onboarding_complete AS "onboardingComplete",
      updated_at::text AS "updatedAt"
    FROM org_metadata
    ORDER BY org_id
  `);
  assert.deepEqual(
    metadata.rows.map(({ updatedAt: _updatedAt, ...row }) => {
      return row;
    }),
    [
      {
        orgId: "legacy",
        credits: "12345",
        tier: "limited-free-1",
        stripeSubscriptionId: null,
        subscriptionStatus: "canceled",
        pendingTarget: null,
        onboardingComplete: true,
      },
      {
        orgId: "limited",
        credits: "75",
        tier: "limited-free-1",
        stripeSubscriptionId: null,
        subscriptionStatus: null,
        pendingTarget: null,
        onboardingComplete: false,
      },
      {
        orgId: "pending",
        credits: "50",
        tier: "team",
        stripeSubscriptionId: "sub_pending",
        subscriptionStatus: "active",
        pendingTarget: "limited-free-1",
        onboardingComplete: true,
      },
    ],
  );
  const legacyMetadata = metadata.rows.find((row) => {
    return row.orgId === "legacy";
  });
  const limitedMetadata = metadata.rows.find((row) => {
    return row.orgId === "limited";
  });
  const pendingMetadata = metadata.rows.find((row) => {
    return row.orgId === "pending";
  });
  assert.ok(legacyMetadata);
  assert.ok(limitedMetadata);
  assert.ok(pendingMetadata);
  assert.notEqual(legacyMetadata.updatedAt, "2026-01-01 00:00:00");
  assert.equal(limitedMetadata.updatedAt, "2026-01-01 00:00:00");
  assert.notEqual(pendingMetadata.updatedAt, "2026-01-01 00:00:00");

  const entitlement = (
    await client.query<{
      audioDailyDurationSeconds: number;
      audioDailyRateLimit: number;
      audioLifetimeLimit: number | null;
      autoRechargeAllowed: boolean;
      baseConcurrencyLimit: number;
      canBuyConcurrency: boolean;
      canBuyCredits: boolean;
      cancelAt: string | null;
      createdAt: string;
      currentPeriodEnd: string | null;
      currentPeriodStart: string | null;
      expiresAt: string | null;
      metadataHash: string | null;
      metadataVersion: string;
      planKey: string;
      planRank: number;
      restrictedBuiltInModels: boolean;
      showUsagePack: boolean;
      source: string;
      sourceMetadata: unknown;
      status: string;
      stripePriceId: string | null;
      stripeSubscriptionId: string | null;
      supportByok: boolean;
      updatedAt: string;
      videoGenerationAllowed: boolean;
      workflowWebhookTriggerAllowed: boolean;
    }>(`
      SELECT
        plan_key AS "planKey",
        plan_rank AS "planRank",
        source,
        status,
        base_concurrency_limit AS "baseConcurrencyLimit",
        can_buy_concurrency AS "canBuyConcurrency",
        can_buy_credits AS "canBuyCredits",
        show_usage_pack AS "showUsagePack",
        auto_recharge_allowed AS "autoRechargeAllowed",
        support_byok AS "supportByok",
        restricted_built_in_models AS "restrictedBuiltInModels",
        video_generation_allowed AS "videoGenerationAllowed",
        workflow_webhook_trigger_allowed AS "workflowWebhookTriggerAllowed",
        audio_lifetime_limit AS "audioLifetimeLimit",
        audio_daily_rate_limit AS "audioDailyRateLimit",
        audio_daily_duration_seconds AS "audioDailyDurationSeconds",
        stripe_subscription_id AS "stripeSubscriptionId",
        stripe_price_id AS "stripePriceId",
        current_period_start::text AS "currentPeriodStart",
        current_period_end::text AS "currentPeriodEnd",
        cancel_at::text AS "cancelAt",
        expires_at::text AS "expiresAt",
        metadata_version AS "metadataVersion",
        metadata_hash AS "metadataHash",
        source_metadata AS "sourceMetadata",
        created_at::text AS "createdAt",
        updated_at::text AS "updatedAt"
      FROM org_plan_entitlements
      WHERE org_id = 'legacy'
    `)
  ).rows[0];
  assert.ok(entitlement);
  assert.deepEqual(
    {
      ...entitlement,
      updatedAt: undefined,
    },
    {
      planKey: "limited-free-1",
      planRank: 0,
      source: "org_metadata_migration",
      status: "active",
      baseConcurrencyLimit: 1,
      canBuyConcurrency: false,
      canBuyCredits: false,
      showUsagePack: false,
      autoRechargeAllowed: false,
      supportByok: false,
      restrictedBuiltInModels: true,
      videoGenerationAllowed: false,
      workflowWebhookTriggerAllowed: false,
      audioLifetimeLimit: 10,
      audioDailyRateLimit: 10,
      audioDailyDurationSeconds: 600,
      stripeSubscriptionId: "sub_historical",
      stripePriceId: "price_historical",
      currentPeriodStart: "2025-12-01 00:00:00",
      currentPeriodEnd: "2026-01-01 00:00:00",
      cancelAt: "2026-01-01 00:00:00",
      expiresAt: "2026-02-01 00:00:00",
      metadataVersion: "1",
      metadataHash: "historical-hash",
      sourceMetadata: { audit: "preserve" },
      createdAt: "2026-01-01 00:00:00",
      updatedAt: undefined,
    },
  );
  assert.notEqual(entitlement.updatedAt, "2026-01-01 00:00:00");

  assert.deepEqual(
    (
      await client.query(
        "SELECT to_jsonb(row_value) AS value FROM org_metadata AS row_value WHERE org_id = 'limited'",
      )
    ).rows[0]?.value,
    unchangedMetadataBefore,
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT to_jsonb(row_value) AS value FROM org_plan_entitlements AS row_value WHERE org_id = 'limited'",
      )
    ).rows[0]?.value,
    unchangedEntitlementBefore,
  );

  assert.deepEqual(
    (
      await client.query(`
        SELECT conname AS name, convalidated AS validated
        FROM pg_constraint
        WHERE conname IN (
          'chk_org_metadata_tier_not_pro_suspend',
          'chk_org_metadata_pending_target_not_pro_suspend',
          'chk_org_plan_entitlements_plan_key_not_pro_suspend'
        )
        ORDER BY conname
      `)
    ).rows,
    [
      {
        name: "chk_org_metadata_pending_target_not_pro_suspend",
        validated: true,
      },
      { name: "chk_org_metadata_tier_not_pro_suspend", validated: true },
      {
        name: "chk_org_plan_entitlements_plan_key_not_pro_suspend",
        validated: true,
      },
    ],
  );

  await expectCheckViolation(
    "INSERT INTO org_metadata (org_id, tier) VALUES ('rejected-tier', 'pro-suspend')",
  );
  await expectCheckViolation(
    "UPDATE org_metadata SET pending_subscription_target_tier = 'pro-suspend' WHERE org_id = 'limited'",
  );
  await expectCheckViolation(
    `
      INSERT INTO org_plan_entitlements (
        org_id, plan_key, plan_rank, source, status,
        base_concurrency_limit, can_buy_concurrency, can_buy_credits,
        show_usage_pack, auto_recharge_allowed, support_byok,
        restricted_built_in_models, video_generation_allowed,
        workflow_webhook_trigger_allowed, audio_daily_rate_limit,
        audio_daily_duration_seconds
      ) VALUES (
        'rejected-plan', 'pro-suspend', 0, 'test', 'suspended',
        0, false, false, false, false, false, true, false, false, 0, 0
      )
    `,
  );

  console.log(
    "✅ pro-suspend metadata, pending targets, and complete entitlement capabilities migrate to limited-free-1",
  );
  console.log(
    "✅ unrelated rows and billing provenance remain unchanged, and validated constraints reject the retired tier",
  );
} finally {
  await client.query("ROLLBACK");
  await client.end();
}
