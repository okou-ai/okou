/**
 * Legacy in-process fixture for the operator-managed `usage_pricing` table.
 *
 * There is no user API for constructing these rows. A scenario that requires
 * chosen pricing or an exact balance from this fixture cannot be preserved by
 * replacing a test endpoint with this helper. Prefer independently public
 * behavior; delete private-only scenarios as their callers are corrected.
 */

import { usagePricing } from "@okouai/db/schema/usage-pricing";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { z } from "zod";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { env } from "../lib/env";
import { USAGE_PRICING } from "../scripts/dev-seed";

import { onRejection } from "../signals/utils";

/**
 * Pricing the development seed does not carry for an active migrated
 * Built-in route; test-database-only rows, never production data.
 */
const TEST_ONLY_MODEL_PRICING = [
  "tokens.input",
  "tokens.output",
  "tokens.cache_read",
  "tokens.cache_creation",
].flatMap((category) => {
  return [category, `${category}.long_context`].flatMap((base) => {
    return [base, `${base}.fast`].map((tiered) => {
      return {
        kind: "model",
        provider: "gpt-6-sol",
        category: tiered,
        unitPrice: 1,
        unitSize: 1_000_000,
      };
    });
  });
});

/**
 * Built-in admission and paid-tool settlement require their normal product
 * pricing, but API tests migrate without the development seed. Seed those
 * development prices into the test database once per run; rows
 * a test already owns are left untouched.
 *
 * Runs in global setup, so it uses its own short-lived client instead of the
 * app pool singleton: tests that stub DATABASE_URL to an unavailable database
 * rely on their first app DB access creating the pool from that stub.
 */
/** The isolated harness uses the exact same pricing seed on its owned DB. */
export async function seedIsolatedModelPricingForTests<
  TQueryResult extends PgQueryResultHKT,
>(database: PgDatabase<TQueryResult>): Promise<void> {
  await database
    .insert(usagePricing)
    .values([
      ...USAGE_PRICING.filter((row) => {
        return [
          "model",
          "web-search",
          "scrape",
          "social",
          "people-search",
        ].includes(row.kind);
      }),
      ...TEST_ONLY_MODEL_PRICING,
    ])
    .onConflictDoNothing({
      target: [usagePricing.kind, usagePricing.provider, usagePricing.category],
    });
}

export async function seedDevelopmentModelPricingForTests(): Promise<void> {
  const client = new Client({ connectionString: env("DATABASE_URL") });
  const seeded = (async () => {
    await client.connect();
    const timezone = await client.query("SHOW TimeZone");
    if (
      !z.object({ TimeZone: z.literal("UTC") }).safeParse(timezone.rows[0])
        .success
    ) {
      throw new Error("Native API test database must use UTC before seeding");
    }
    await drizzle(client)
      .insert(usagePricing)
      .values([
        ...USAGE_PRICING.filter((row) => {
          return [
            "model",
            "web-search",
            "scrape",
            "social",
            "people-search",
          ].includes(row.kind);
        }),
        ...TEST_ONLY_MODEL_PRICING,
      ])
      .onConflictDoNothing({
        target: [
          usagePricing.kind,
          usagePricing.provider,
          usagePricing.category,
        ],
      });
  })();
  await onRejection(seeded, () => {
    return client.end();
  });
  await client.end();
}
