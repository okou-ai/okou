/**
 * In-process test fixture for the global `usage_pricing` table.
 *
 * Usage pricing is operator-managed global configuration with no product API
 * (rows are written by ops tooling/migrations in production), so tests cannot
 * construct pricing state through any product endpoint. New route tests use
 * `createUsagePricingFixture` to own unique lookup providers. Raw mutation
 * helpers are reserved for rows whose provider is already proven UUID-, run-,
 * or fixture-owned; they must never target canonical operator identities.
 */
import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { usagePricing } from "@okouai/db/schema/usage-pricing";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { env } from "../lib/env";
import { USAGE_PRICING } from "../scripts/dev-seed";
import { writeDb$, type Db } from "../signals/external/db";
import {
  resolveUsagePricingProvider,
  type UsagePricingProviderResolution,
  type UsagePricingResolution,
} from "../signals/context/usage-pricing-resolution";
import { onRejection } from "../signals/utils";

export interface UsagePricingKey {
  readonly kind: string;
  readonly provider: string;
  readonly category: string;
}

export interface UsagePricingRow extends UsagePricingKey {
  readonly unitPrice: number;
  readonly unitSize: number;
}

export interface UsagePricingFixture {
  readonly resolution: UsagePricingResolution;
  readonly cleanup: () => Promise<void>;
}

interface CreateUsagePricingFixtureOptions {
  readonly configured?: readonly UsagePricingRow[];
  readonly missing?: readonly UsagePricingKey[];
  readonly registerCleanup?: (cleanup: () => Promise<void>) => void;
}

function fixtureDb(): Db {
  return createStore().set(writeDb$);
}

function usagePricingResolution(
  keys: readonly UsagePricingKey[],
): UsagePricingProviderResolution[] {
  const resolution: UsagePricingProviderResolution[] = [];
  for (const key of keys) {
    if (
      resolution.some((entry) => {
        return entry.kind === key.kind && entry.provider === key.provider;
      })
    ) {
      continue;
    }
    resolution.push({
      kind: key.kind,
      provider: key.provider,
      lookupProvider: `pricing-fixture-${randomUUID()}`,
    });
  }
  return resolution;
}

export async function createUsagePricingFixture({
  configured = [],
  missing = [],
  registerCleanup,
}: CreateUsagePricingFixtureOptions): Promise<UsagePricingFixture> {
  const db = fixtureDb();
  const resolution = usagePricingResolution([...configured, ...missing]);
  const cleanup = async () => {
    for (const entry of resolution) {
      await db
        .delete(usagePricing)
        .where(
          and(
            eq(usagePricing.kind, entry.kind),
            eq(usagePricing.provider, entry.lookupProvider),
          ),
        );
    }
  };
  registerCleanup?.(cleanup);
  if (configured.length > 0) {
    await db.insert(usagePricing).values(
      configured.map((row) => {
        return {
          ...row,
          provider: resolveUsagePricingProvider(
            resolution,
            row.kind,
            row.provider,
          ),
        };
      }),
    );
  }

  return { resolution, cleanup };
}

export async function upsertUsagePricingRows(
  rows: readonly UsagePricingRow[],
): Promise<void> {
  if (rows.length === 0) {
    return;
  }

  await fixtureDb()
    .insert(usagePricing)
    .values([...rows])
    .onConflictDoUpdate({
      target: [usagePricing.kind, usagePricing.provider, usagePricing.category],
      set: {
        unitPrice: sql`excluded.unit_price`,
        unitSize: sql`excluded.unit_size`,
        updatedAt: sql`now()`,
      },
    });
}

export async function deleteUsagePricingRows(filter: {
  readonly kind: string;
  readonly provider: string;
  readonly categories: readonly string[];
}): Promise<readonly UsagePricingRow[]> {
  if (filter.categories.length === 0) {
    return [];
  }

  const db = fixtureDb();
  const where = and(
    eq(usagePricing.kind, filter.kind),
    eq(usagePricing.provider, filter.provider),
    inArray(usagePricing.category, [...filter.categories]),
  );
  const rows = await db
    .select({
      kind: usagePricing.kind,
      provider: usagePricing.provider,
      category: usagePricing.category,
      unitPrice: usagePricing.unitPrice,
      unitSize: usagePricing.unitSize,
    })
    .from(usagePricing)
    .where(where);
  await db.delete(usagePricing).where(where);
  return rows;
}

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
 * Built-in run admission requires usage_pricing for every category a route
 * can bill, but API tests migrate without the development seed. Seed the
 * development model pricing into the test database once per run; rows
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
        return row.kind === "model";
      }),
      ...TEST_ONLY_MODEL_PRICING,
    ])
    .onConflictDoNothing({
      target: [usagePricing.kind, usagePricing.provider, usagePricing.category],
    });
}

export async function seedDevelopmentModelPricingForTests(): Promise<void> {
  const client = new Client({ connectionString: env("DATABASE_URL") });
  await client.connect();
  const seeded = drizzle(client)
    .insert(usagePricing)
    .values([
      ...USAGE_PRICING.filter((row) => {
        return row.kind === "model";
      }),
      ...TEST_ONLY_MODEL_PRICING,
    ])
    .onConflictDoNothing({
      target: [usagePricing.kind, usagePricing.provider, usagePricing.category],
    });
  await onRejection(seeded, () => {
    return client.end();
  });
  await client.end();
}
