import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { z } from "zod";
import { applyPendingMigrations } from "./migration-runner";

const journalSchema = z.object({
  entries: z.array(z.object({ tag: z.string(), when: z.number() })),
});

async function seedRetainedBilling(sql: postgres.Sql) {
  await sql`INSERT INTO org_metadata (org_id, credits)
    VALUES ('data-retirement-org', 123456)`;
  await sql`INSERT INTO usage_pack_credit_grants
    (org_id, user_id, grant_type, idempotency_key, original_amount, remaining_amount, expires_at)
    VALUES ('data-retirement-org', 'owner', 'purchased', 'data-retirement-grant', 1000, 777, '2027-01-01')`;
  await sql`INSERT INTO usage_event
    (idempotency_key, org_id, user_id, kind, provider, category, quantity,
      credits_charged, status, processed_at, pricing_unit_price, pricing_unit_size, pricing_credits_limit)
    VALUES
      (gen_random_uuid(), 'data-retirement-org', 'owner', 'social', 'monid/weibo',
        'provider_cost_usd_micros', 8000, 10, 'processed', '2026-10-20', 1250, 1000000, 20),
      (gen_random_uuid(), 'data-retirement-org', 'owner', 'data-search', 'monid/apollo',
        'provider_cost_usd_micros', 4000, 5, 'compacted', '2026-10-19', 1250, 1000000, 10)`;
  // Current Router and model events must not block retirement while unsettled.
  await sql`INSERT INTO usage_event
    (idempotency_key, org_id, user_id, kind, provider, category, quantity)
    VALUES
      (gen_random_uuid(), 'data-retirement-org', 'owner', 'data-search', 'data-router', 'credits', 4),
      (gen_random_uuid(), 'data-retirement-org', 'owner', 'model', 'retained-model', 'tokens.input', 100)`;
  await sql`INSERT INTO usage_event_hourly_rollup
    (processed_hour, org_id, user_id, kind, provider, category, quantity, credits_charged)
    VALUES ('2026-10-18', 'data-retirement-org', 'owner', 'maps', 'google-maps', 'geocoding', 2, 12)`;
  // Sharing a vendor or kind with a retired key must not remove other prices.
  await sql`INSERT INTO usage_pricing (kind, provider, category, unit_price, unit_size)
    VALUES
      ('model', 'google-maps', 'tokens.input', 2000, 1000000),
      ('maps', 'retained-provider', 'retained-category', 7, 1),
      ('data-search', 'data-router', 'credits', 1, 1)`;
}

async function retainedBilling(sql: postgres.Sql) {
  return JSON.stringify([
    Array.from(await sql`SELECT * FROM org_metadata ORDER BY org_id`),
    Array.from(await sql`SELECT * FROM usage_pack_credit_grants ORDER BY id`),
    Array.from(
      await sql`SELECT id, idempotency_key, org_id, user_id, run_id,
      billing_run_id, billing_anchor_at, billing_context, kind, provider, category,
      quantity, credits_charged, status, billing_error, created_at, processed_at
      FROM usage_event ORDER BY id`,
    ),
    Array.from(await sql`SELECT * FROM usage_event_hourly_rollup ORDER BY id`),
    Array.from(
      await sql`SELECT id, kind, provider, category, unit_price, unit_size, created_at, updated_at
      FROM usage_pricing
      WHERE kind = 'model' OR provider IN ('retained-provider', 'data-router')
      ORDER BY id`,
    ),
  ]);
}

async function rejectionState(sql: postgres.Sql) {
  return JSON.stringify([
    await retainedBilling(sql),
    Array.from(await sql`SELECT * FROM commerce_jobs ORDER BY id`),
    Array.from(await sql`SELECT * FROM data_search_jobs ORDER BY id`),
    Array.from(await sql`SELECT * FROM social_data_jobs ORDER BY id`),
    Array.from(await sql`SELECT * FROM socialkit_download_jobs ORDER BY id`),
    Array.from(await sql`SELECT * FROM usage_event ORDER BY id`),
    Array.from(await sql`SELECT * FROM usage_pricing ORDER BY id`),
    Array.from(
      await sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`,
    ),
    Array.from(
      await sql`SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position`,
    ),
    Array.from(
      await sql`SELECT conrelid::regclass::text AS relation, conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY relation, conname`,
    ),
    Array.from(
      await sql`SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' ORDER BY indexname`,
    ),
    Array.from(
      await sql`SELECT viewname, definition FROM pg_views
      WHERE schemaname = 'public' ORDER BY viewname`,
    ),
    Array.from(
      await sql`SELECT proname, prosrc FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace ORDER BY oid`,
    ),
  ]);
}

async function seedRejection(sql: postgres.Sql, scenario: string) {
  if (scenario === "commerce-history") {
    await sql`INSERT INTO commerce_jobs (org_id, user_id, operation, marketplace, status, request, result)
      VALUES ('data-retirement-org', 'owner', 'search', 'amazon.com', 'completed', '{}', '{"creditsCharged":3}')`;
  }
  if (scenario === "data-search-history") {
    await sql`INSERT INTO data_search_jobs
      (org_id, user_id, request_id, capability, request, plan, status, provider_name,
        provider_endpoint, estimated_cost_usd_micros, actual_cost_usd_micros,
        unit_price, unit_size, max_credits, reserved_credits, credits_charged)
      VALUES ('data-retirement-org', 'owner', gen_random_uuid(), 'company-search', '{}', '{}',
        'completed', 'monid/apollo', 'search', 800, 800, 1250, 1000000, 5, 0, 1)`;
  }
  if (scenario === "social-data-history") {
    await sql`INSERT INTO social_data_jobs
      (org_id, user_id, request_id, platform, operation, request, status, provider_name,
        provider_endpoint, estimated_cost_usd_micros, actual_cost_usd_micros,
        unit_price, unit_size, max_credits, reserved_credits, credits_charged)
      VALUES ('data-retirement-org', 'owner', gen_random_uuid(), 'weibo', 'search', '{}',
        'completed', 'monid', 'search', 800, 800, 1250, 1000000, 5, 0, 1)`;
  }
  if (scenario === "socialkit-history") {
    await sql`INSERT INTO socialkit_download_jobs
      (org_id, user_id, status, request, credits_charged)
      VALUES ('data-retirement-org', 'owner', 'completed', '{}', 3)`;
  }
  if (scenario === "pending-data") {
    await sql`INSERT INTO usage_event
      (idempotency_key, org_id, user_id, kind, provider, category, quantity)
      VALUES (gen_random_uuid(), 'data-retirement-org', 'owner', 'data-search', 'unlisted-provider', 'request', 1)`;
  }
  if (scenario === "pending-snapshot") {
    await sql`UPDATE usage_event SET pricing_unit_price = 1, pricing_unit_size = 1, pricing_credits_limit = 10
      WHERE kind = 'model' AND provider = 'retained-model'`;
  }
  if (scenario === "missing-receipt") {
    await sql`UPDATE usage_event SET credits_charged = NULL WHERE kind = 'social'`;
  }
  if (scenario === "missing-processed-time") {
    await sql`UPDATE usage_event SET processed_at = NULL WHERE kind = 'social'`;
  }
  if (scenario === "billing-error") {
    await sql`UPDATE usage_event SET billing_error = 'missing_pricing' WHERE kind = 'social'`;
  }
  if (scenario === "dependent-index") {
    await sql`CREATE INDEX retirement_snapshot_consumer ON usage_event (pricing_unit_price)`;
  }
  if (scenario === "dependent-check") {
    await sql`ALTER TABLE usage_pricing ADD CONSTRAINT retirement_conversion_consumer
      CHECK (source_cost_usd_micros_per_credit IS NULL OR source_cost_usd_micros_per_credit >= 1)`;
  }
  if (scenario === "dependent-view") {
    await sql`CREATE VIEW retirement_job_consumer AS SELECT id FROM data_search_jobs`;
  }
  if (scenario === "column-view") {
    await sql`CREATE VIEW retirement_snapshot_consumer AS SELECT pricing_unit_size FROM usage_event`;
  }
  if (scenario === "string-bodied-function") {
    await sql`CREATE FUNCTION retirement_job_count() RETURNS bigint LANGUAGE sql
      AS 'SELECT count(*) FROM public.commerce_jobs'`;
  }
}

/** Preserve billing facts and reject data loss using the real preceding schema. */
export async function validateManagedDataRetirement(databaseUrl: string) {
  const journal = journalSchema.parse(
    JSON.parse(
      await readFile(
        new URL("../src/migrations/meta/_journal.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const retirement = journal.entries.find((entry) => {
    return entry.tag === "1462_retire_managed_data_storage";
  });
  assert.ok(retirement);
  const admin = postgres(databaseUrl, { max: 1 });
  const baselineName = `data_retirement_base_${randomUUID().replaceAll("-", "")}`;
  const baselineUrl = new URL(databaseUrl);
  baselineUrl.pathname = `/${baselineName}`;
  let baselineCreated = false;
  try {
    await admin.unsafe(`CREATE DATABASE "${baselineName}"`);
    baselineCreated = true;
    const baseline = postgres(baselineUrl.toString(), { max: 1 });
    try {
      await applyPendingMigrations(baseline, { beforeMillis: retirement.when });
      await seedRetainedBilling(baseline);
    } finally {
      await baseline.end();
    }

    for (const scenario of [
      "success",
      "commerce-history",
      "data-search-history",
      "social-data-history",
      "socialkit-history",
      "pending-data",
      "pending-snapshot",
      "missing-receipt",
      "missing-processed-time",
      "billing-error",
      "dependent-index",
      "dependent-check",
      "dependent-view",
      "column-view",
      "string-bodied-function",
    ]) {
      const name = `data_retirement_${randomUUID().replaceAll("-", "")}`;
      const url = new URL(databaseUrl);
      url.pathname = `/${name}`;
      await admin.unsafe(
        `CREATE DATABASE "${name}" TEMPLATE "${baselineName}"`,
      );
      const sql = postgres(url.toString(), { max: 1 });
      try {
        if (scenario === "success") {
          const original = await retainedBilling(sql);
          const originalJournal = Array.from(
            await sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`,
          );
          await applyPendingMigrations(sql, {
            beforeMillis: retirement.when + 1,
          });
          assert.equal(await retainedBilling(sql), original);
          const applied = Array.from(
            await sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`,
          );
          assert.equal(applied.length, originalJournal.length + 1);
          assert.equal(applied.at(-1)?.created_at, String(retirement.when));
          assert.deepEqual(
            Array.from(
              await sql`SELECT kind, provider, category FROM usage_pricing
              WHERE kind = 'maps' AND provider = 'google-maps' AND category = 'geocoding'`,
            ),
            [],
          );
          // The live writer can still publish a new Router debit after contraction.
          await sql`INSERT INTO usage_event
            (idempotency_key, org_id, user_id, kind, provider, category, quantity,
              credits_charged, status, processed_at)
            VALUES (gen_random_uuid(), 'data-retirement-org', 'owner', 'data-search',
              'data-router', 'credits', 6, 6, 'processed', '2026-10-25')`;
          const afterWrite = await retainedBilling(sql);
          await applyPendingMigrations(sql, {
            beforeMillis: retirement.when + 1,
          });
          assert.equal(await retainedBilling(sql), afterWrite);
          assert.deepEqual(
            Array.from(
              await sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`,
            ),
            applied,
          );
          continue;
        }

        await seedRejection(sql, scenario);
        const before = await rejectionState(sql);
        const code = [
          "dependent-index",
          "dependent-check",
          "dependent-view",
          "column-view",
          "string-bodied-function",
        ].includes(scenario)
          ? "2BP01"
          : "55000";
        await assert.rejects(
          applyPendingMigrations(sql, { beforeMillis: retirement.when + 1 }),
          { code },
          scenario,
        );
        assert.equal(await rejectionState(sql), before, scenario);
      } finally {
        await sql.end();
        await admin.unsafe(`DROP DATABASE "${name}"`);
      }
    }
  } finally {
    try {
      if (baselineCreated)
        await admin.unsafe(`DROP DATABASE "${baselineName}"`);
    } finally {
      await admin.end();
    }
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  await validateManagedDataRetirement(process.env.DATABASE_URL);
  console.log(
    "Managed Data retirement preserves billing and rejects unsafe contraction",
  );
}
