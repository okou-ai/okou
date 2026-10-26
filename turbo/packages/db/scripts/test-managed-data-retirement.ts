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
        'provider_cost_usd_micros', 4000, 5, 'compacted', '2026-10-19', 1250, 1000000, 10),
      (gen_random_uuid(), 'data-retirement-org', 'owner', 'social', 'socialkit',
        'request', 1, 3, 'processed', '2026-10-20', NULL, NULL, NULL)`;
  // Current Router and model events retain their original billing state.
  await sql`INSERT INTO usage_event
    (idempotency_key, org_id, user_id, kind, provider, category, quantity)
    VALUES
      (gen_random_uuid(), 'data-retirement-org', 'owner', 'data-search', 'data-router', 'credits', 4),
      (gen_random_uuid(), 'data-retirement-org', 'owner', 'model', 'retained-model', 'tokens.input', 100)`;
  await sql`INSERT INTO usage_event_hourly_rollup
    (processed_hour, org_id, user_id, kind, provider, category, quantity, credits_charged)
    VALUES ('2026-10-18', 'data-retirement-org', 'owner', 'maps', 'google-maps', 'geocoding', 2, 12)`;
  // Preserve current prices that share a vendor or kind with retired tariffs.
  await sql`INSERT INTO usage_pricing (kind, provider, category, unit_price, unit_size)
    VALUES
      ('model', 'google-maps', 'tokens.input', 2000, 1000000),
      ('maps', 'retained-provider', 'retained-category', 7, 1),
      ('data-search', 'data-router', 'credits', 1, 1)`;
}

async function seedRetiredJobs(sql: postgres.Sql) {
  await sql`INSERT INTO commerce_jobs (org_id, user_id, operation, marketplace, status, request)
    VALUES ('data-retirement-org', 'owner', 'search', 'amazon.com', 'failed', '{}')`;
  await sql`INSERT INTO data_search_jobs
    (org_id, user_id, request_id, capability, request, plan, status, provider_name,
      provider_endpoint, estimated_cost_usd_micros, unit_price, unit_size,
      max_credits, reserved_credits)
    VALUES ('data-retirement-org', 'owner', gen_random_uuid(), 'company-search', '{}', '{}',
      'unknown', 'monid/apollo', 'search', 12800, 1250, 1000000, 16, 16)`;
  await sql`INSERT INTO social_data_jobs
    (org_id, user_id, request_id, platform, operation, request, status, provider_name,
      provider_endpoint, estimated_cost_usd_micros, actual_cost_usd_micros,
      unit_price, unit_size, max_credits, reserved_credits, credits_charged)
    VALUES ('data-retirement-org', 'owner', gen_random_uuid(), 'weibo', 'search', '{}',
      'completed', 'monid', 'search', 8000, 8000, 1250, 1000000, 20, 0, 10)`;
  await sql`INSERT INTO socialkit_download_jobs
    (org_id, user_id, status, request, credits_charged)
    VALUES ('data-retirement-org', 'owner', 'link_failed', '{}', 3)`;
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

/** Discard legacy jobs while preserving billing history and current usage. */
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
    return entry.tag === "1464_retire_managed_data_storage";
  });
  assert.ok(retirement);
  const admin = postgres(databaseUrl, { max: 1 });
  const name = `data_retirement_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  let created = false;
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    created = true;
    const sql = postgres(url.toString(), { max: 1 });
    try {
      await applyPendingMigrations(sql, { beforeMillis: retirement.when });
      await seedRetainedBilling(sql);
      await seedRetiredJobs(sql);
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

      const requestId = randomUUID();
      await sql`INSERT INTO usage_event
        (idempotency_key, org_id, user_id, kind, provider, category, quantity,
          credits_charged, status, processed_at)
        VALUES (${requestId}, 'data-retirement-org', 'owner', 'data-search',
          'data-router', 'credits', 6, 6, 'processed', '2026-10-25')`;
      assert.deepEqual(
        Array.from(
          await sql`SELECT provider, category, quantity::text, credits_charged::text
            FROM usage_event WHERE idempotency_key = ${requestId}`,
        ),
        [
          {
            provider: "data-router",
            category: "credits",
            quantity: "6",
            credits_charged: "6",
          },
        ],
      );
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
    } finally {
      await sql.end();
    }
  } finally {
    try {
      if (created) await admin.unsafe(`DROP DATABASE "${name}"`);
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
    "Managed Data retirement preserves billing and current Router usage",
  );
}
