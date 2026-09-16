import { randomUUID } from "node:crypto";

import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import type { ApiDb, Tx } from "../../../lib/db-types";
import {
  pgBooleanDecoder,
  pgIntegerDecoder,
} from "../../../lib/db-structured-result";
import { env } from "../../../lib/env";
import { createDeferredPromise, settle } from "../../utils";
import {
  ensureOrgMetadataPlanEntitlement,
  upsertOrgPlanEntitlement,
  writeOrgMetadataWithDefaultPlanEntitlement,
} from "../org-plan-entitlements.service";
import { loadOrgPlanCapabilities } from "../org-plan-entitlement-read.service";

const context = testContext();

// These infrastructure cases inject constraints, historical corrupt rows and
// a blocked transaction interleaving that production APIs cannot construct.
// Private current-schema tables isolate those faults from the route suites.
// Routine plan, billing and invitation behavior is covered through HTTP.
interface EntitlementHarness {
  readonly db: ApiDb;
  readonly destroy: () => Promise<void>;
}

async function createHarness(): Promise<EntitlementHarness> {
  const schemaName = `entitlement_${randomUUID().replaceAll("-", "")}`;
  const adminPool = new Pool({
    connectionString: env("DATABASE_URL"),
    max: 1,
    allowExitOnIdle: true,
  });
  const adminDb = drizzle(adminPool);
  const pool = new Pool({
    connectionString: env("DATABASE_URL"),
    max: 4,
    allowExitOnIdle: true,
    options: `-c search_path=${schemaName},public -c statement_timeout=10000`,
  });
  const db = drizzle(pool);
  const destroy = async () => {
    const poolClosed = await settle(pool.end());
    const schemaDropped = await settle(
      adminDb.execute(
        sql`DROP SCHEMA IF EXISTS ${sql.identifier(schemaName)} CASCADE`,
      ),
    );
    const adminClosed = await settle(adminPool.end());
    for (const result of [poolClosed, schemaDropped, adminClosed]) {
      if (!result.ok) {
        throw result.error;
      }
    }
  };
  const initialized = await settle(
    (async () => {
      const setupClient = await pool.connect();
      const created = await settle(
        drizzle(setupClient).transaction(async (tx) => {
          await tx.execute(sql`CREATE SCHEMA ${sql.identifier(schemaName)}`);
          await tx.execute(
            sql`CREATE TABLE org_metadata (LIKE public.org_metadata INCLUDING ALL)`,
          );
          await tx.execute(
            sql`CREATE TABLE org_plan_entitlements (LIKE public.org_plan_entitlements INCLUDING ALL)`,
          );
        }),
      );
      setupClient.release();
      if (!created.ok) {
        throw created.error;
      }
    })(),
  );
  if (!initialized.ok) {
    await destroy();
    throw initialized.error;
  }
  return { db, destroy };
}

async function createMetadata(
  tx: Tx,
  orgId: string,
  tier?: string,
): Promise<void> {
  const rows = await tx
    .insert(orgMetadataCanonicalWrites)
    .values({ orgId, ...(tier === undefined ? {} : { tier }) })
    .onConflictDoNothing({ target: orgMetadataCanonicalWrites.orgId })
    .returning({ orgId: orgMetadata.orgId, tier: orgMetadata.tier });
  for (const row of rows) {
    await ensureOrgMetadataPlanEntitlement(tx, row);
  }
}

function entitlement(db: ApiDb, orgId: string) {
  return db
    .select()
    .from(orgPlanEntitlements)
    .where(eq(orgPlanEntitlements.orgId, orgId));
}

describe("entitlement transaction integrity", () => {
  let harness: EntitlementHarness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.destroy();
  });

  it("preserves an existing manual entitlement when metadata is created", async () => {
    // A manual entitlement predating metadata has no production creation API.
    const orgId = `org_${randomUUID()}`;
    await harness.db.insert(orgPlanEntitlements).values({
      orgId,
      planKey: "custom",
      planRank: 3,
      source: "manual",
      status: "manual_active",
      baseConcurrencyLimit: 27,
      canBuyCredits: false,
      restrictedBuiltInModels: false,
      sourceMetadata: { preserved: "manual" },
    });
    const before = await entitlement(harness.db, orgId);
    await harness.db.transaction(async (tx) => {
      await createMetadata(tx, orgId, "free");
    });
    await expect(entitlement(harness.db, orgId)).resolves.toStrictEqual(before);
  });

  it("does not invent an entitlement for an unknown legacy tier", async () => {
    // Current APIs cannot submit an unknown historical tier.
    const orgId = `org_${randomUUID()}`;
    await harness.db.transaction(async (tx) => {
      await createMetadata(tx, orgId, "unknown-legacy-tier");
    });
    await expect(entitlement(harness.db, orgId)).resolves.toStrictEqual([]);
  });

  it("keeps a pre-existing missing entitlement visible during an ordinary metadata update", async () => {
    const orgId = `org_${randomUUID()}`;
    await harness.db.transaction(async (tx) => {
      await createMetadata(tx, orgId, "free");
    });
    // A historical corrupt state is not constructible through a product API.
    await harness.db
      .delete(orgPlanEntitlements)
      .where(eq(orgPlanEntitlements.orgId, orgId));
    await harness.db.transaction(async (tx) => {
      await writeOrgMetadataWithDefaultPlanEntitlement(
        tx,
        orgId,
        async (writeTx) => {
          return await writeTx
            .insert(orgMetadataCanonicalWrites)
            .values({ orgId, credits: 5 })
            .onConflictDoUpdate({
              target: orgMetadataCanonicalWrites.orgId,
              set: { credits: 5 },
            })
            .returning({ orgId: orgMetadata.orgId, tier: orgMetadata.tier });
        },
      );
    });
    await expect(
      harness.db.select({ credits: orgMetadata.credits }).from(orgMetadata),
    ).resolves.toStrictEqual([{ credits: 5 }]);
    await expect(loadOrgPlanCapabilities(harness.db, orgId)).rejects.toThrow(
      `Missing org plan entitlement for ${orgId}`,
    );
  });

  it("rolls back metadata if its companion entitlement write fails", async () => {
    await harness.db.execute(sql`
      ALTER TABLE org_plan_entitlements ADD CONSTRAINT reject_credit_purchasing
      CHECK (NOT can_buy_credits)
    `);
    const orgId = `org_${randomUUID()}`;
    await expect(
      harness.db.transaction(async (tx) => {
        await createMetadata(tx, orgId, "pro");
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(
      harness.db.select().from(orgMetadata).where(eq(orgMetadata.orgId, orgId)),
    ).resolves.toStrictEqual([]);
    await expect(entitlement(harness.db, orgId)).resolves.toStrictEqual([]);
  });

  it("rolls back capability and status changes after a later failure", async () => {
    const orgId = `org_${randomUUID()}`;
    await harness.db.transaction(async (tx) => {
      await upsertOrgPlanEntitlement(tx, {
        orgId,
        tier: "pro",
        source: "stripe_subscription",
      });
    });
    const before = await entitlement(harness.db, orgId);
    await expect(
      harness.db.transaction(async (tx) => {
        await upsertOrgPlanEntitlement(tx, {
          orgId,
          tier: "pro-suspend",
          source: "stripe_subscription",
        });
        throw new Error("later operation failed");
      }),
    ).rejects.toThrow("later operation failed");
    await expect(entitlement(harness.db, orgId)).resolves.toStrictEqual(before);
  });

  it("preserves a concurrently committed paid entitlement during metadata creation", async () => {
    const orgId = `org_${randomUUID()}`;
    const locked = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    const contenderPid = createDeferredPromise<number>(context.signal);
    const paid = harness.db.transaction(async (tx) => {
      await upsertOrgPlanEntitlement(tx, {
        orgId,
        tier: "pro",
        source: "stripe_subscription",
      });
      locked.resolve();
      await release.promise;
    });
    await Promise.race([locked.promise, paid]);
    const metadata = harness.db.transaction(async (tx) => {
      const [backend] = await tx
        .select({
          pid: sql`pg_backend_pid()`.mapWith(pgIntegerDecoder),
        })
        .from(sql`(SELECT 1) AS backend`);
      if (!backend) {
        throw new Error("Expected transaction backend");
      }
      contenderPid.resolve(backend.pid);
      await createMetadata(tx, orgId, "free");
    });
    const completed = Promise.all([paid, metadata]);
    const verification = await settle(
      Promise.race([
        contenderPid.promise,
        metadata.then(() => {
          throw new Error("Expected contender backend before completion");
        }),
      ]).then(async (pid) => {
        await expect
          .poll(async () => {
            const [state] = await harness.db
              .select({
                blocked: sql`cardinality(pg_blocking_pids(${pid})) > 0`.mapWith(
                  pgBooleanDecoder,
                ),
              })
              .from(sql`(SELECT 1) AS blocking_state`);
            return state?.blocked;
          })
          .toBe(true);
      }),
    );
    release.resolve();
    const completion = await settle(completed);
    if (!verification.ok) {
      throw verification.error;
    }
    if (!completion.ok) {
      throw completion.error;
    }
    expect((await entitlement(harness.db, orgId))[0]).toMatchObject({
      planKey: "pro",
      source: "stripe_subscription",
      canBuyCredits: true,
    });
    await expect(
      harness.db.select({ orgId: orgMetadata.orgId }).from(orgMetadata),
    ).resolves.toStrictEqual([{ orgId }]);
  });
});
