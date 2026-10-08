import { randomUUID } from "node:crypto";

import {
  usagePackAllocations,
  usagePackPendingSnapshotGuards,
  usagePackSubscriptions,
} from "@okouai/db/schema/usage-pack-subscription";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";

import { testContext } from "../../../__tests__/test-context";
import type { ApiDb } from "../../../lib/db-types";
import { env } from "../../../lib/env";
import {
  barrierQueryBinds,
  barrierQueryText,
  withDatabaseTransactionBarrierFixture,
} from "../../../test-fixtures/database-transaction-barrier";
import { settle } from "../../utils";
import {
  repairUsagePackPendingSnapshotGuards,
  UsagePackPendingSnapshotConflict,
  writeUsagePackPendingSnapshots,
} from "../usage-pack-pending-snapshot.service";

const context = testContext();

// HTTP callers cannot select installed triggers, grandfathered/corrupt guard
// state, org movement or database lock interleavings. Each case owns its current schema. Historical 0954 trigger and mixed-version
// ordering cases are retired with their compatibility protocol.
async function createHarness() {
  const schema = `pending_scope_${randomUUID().replaceAll("-", "")}`;
  const adminPool = new Pool({ connectionString: env("DATABASE_URL"), max: 1 });
  const admin = drizzle(adminPool);
  const pool = new Pool({
    connectionString: env("DATABASE_URL"),
    max: 4,
    options: `-c search_path=${schema},public -c statement_timeout=10000`,
  });
  const db = drizzle(pool);
  const destroy = async () => {
    const closed = await settle(pool.end());
    const dropped = await settle(
      admin.execute(
        sql`DROP SCHEMA IF EXISTS ${sql.identifier(schema)} CASCADE`,
      ),
    );
    const adminClosed = await settle(adminPool.end());
    for (const result of [closed, dropped, adminClosed]) {
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
          await tx.execute(sql`CREATE SCHEMA ${sql.identifier(schema)}`);
          await tx.execute(
            sql`CREATE TABLE usage_pack_subscriptions (LIKE public.usage_pack_subscriptions INCLUDING ALL)`,
          );
          await tx.execute(
            sql`CREATE TABLE usage_pack_allocations (LIKE public.usage_pack_allocations INCLUDING ALL)`,
          );
          await tx.execute(
            sql`ALTER TABLE usage_pack_allocations ADD FOREIGN KEY (usage_pack_subscription_id) REFERENCES usage_pack_subscriptions (id) ON DELETE CASCADE`,
          );
          await tx.execute(
            sql`CREATE TABLE usage_pack_pending_snapshot_guards (LIKE public.usage_pack_pending_snapshot_guards INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`,
          );
          await tx.execute(
            sql`CREATE UNIQUE INDEX uq_usage_pack_subscriptions_pending_org ON usage_pack_pending_snapshot_guards (org_id)`,
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

function values(orgId: string, status = "purchase_pending") {
  return {
    id: randomUUID(),
    orgId,
    tier: "pro" as const,
    stripePlanPriceId: "price_plan",
    stripeCustomerId: `cus_${orgId}`,
    subscriptionStatus: status,
  };
}

async function insert(db: ApiDb, row: ReturnType<typeof values>) {
  await writeUsagePackPendingSnapshots(db, [row.orgId], async (tx) => {
    await tx.insert(usagePackSubscriptions).values(row);
  });
  return row.id;
}

async function transition(
  db: ApiDb,
  orgId: string,
  id: string,
  status: string,
) {
  await writeUsagePackPendingSnapshots(db, [orgId], async (tx) => {
    await tx
      .update(usagePackSubscriptions)
      .set({ subscriptionStatus: status })
      .where(eq(usagePackSubscriptions.id, id));
  });
}

async function guard(db: ApiDb, orgId: string) {
  const [row] = await db
    .select()
    .from(usagePackPendingSnapshotGuards)
    .where(eq(usagePackPendingSnapshotGuards.orgId, orgId));
  return row?.pendingSnapshotCount;
}

async function grandfather(db: ApiDb, orgId: string) {
  const rows = [values(orgId), values(orgId, "checkout_pending")];
  await db.transaction(async (tx) => {
    for (const row of rows) {
      // Reproduce the pre-0954 data and its exact migration backfill without
      // ever disabling a shared trigger or modifying other tests' rows.
      await tx
        .delete(usagePackPendingSnapshotGuards)
        .where(eq(usagePackPendingSnapshotGuards.orgId, orgId));
      await tx.insert(usagePackSubscriptions).values(row);
    }
    await repairUsagePackPendingSnapshotGuards(tx, [orgId]);
  });
  return rows;
}

describe("pending snapshots on the current schema", () => {
  let harness: Awaited<ReturnType<typeof createHarness>>;
  beforeEach(async () => {
    harness = await createHarness();
  });
  afterEach(async () => {
    await harness.destroy();
  });

  it("admits one concurrent purchase and rejects another without duplicating its count", async () => {
    const orgId = `org_${randomUUID()}`;
    const outcomes = await Promise.allSettled([
      insert(harness.db, values(orgId)),
      insert(harness.db, values(orgId)),
    ]);
    expect(
      outcomes
        .map((outcome) => {
          return outcome.status;
        })
        .sort(),
    ).toStrictEqual(["fulfilled", "rejected"]);
    await expect(guard(harness.db, orgId)).resolves.toBe(1);
    await expect(
      harness.db.select().from(usagePackSubscriptions),
    ).resolves.toHaveLength(1);
  });

  // HTTP cannot schedule a commit between a database read and its delivery.
  // This infrastructure regression keeps real queries and isolated schemas;
  // the checkout route's existing concurrent-confirmation case covers HTTP.
  it.each(["write", "repair"] as const)(
    "reads a consistent pending count when a transition commits during %s",
    async (operation) => {
      const row = values(`org_${randomUUID()}`);
      await insert(harness.db, row);

      await withDatabaseTransactionBarrierFixture(
        {
          select(queryArgs) {
            const text = barrierQueryText(queryArgs);
            return (
              text.startsWith("select ") &&
              text.includes('from "usage_pack_pending_snapshot_guards"') &&
              barrierQueryBinds(queryArgs, row.orgId)
            );
          },
          stopAt(_queryArgs, selectingStatement) {
            return selectingStatement;
          },
          pauseAfter: true,
          async work(barrier) {
            // Keep the real read result, then commit another writer before
            // delivering it. Separate guard/root reads would see two snapshots.
            const pending = settle(
              operation === "repair"
                ? repairUsagePackPendingSnapshotGuards(harness.db, [row.orgId])
                : writeUsagePackPendingSnapshots(
                    harness.db,
                    [row.orgId],
                    async (tx) => {
                      await tx
                        .update(usagePackSubscriptions)
                        .set({ subscriptionStatus: "canceled" })
                        .where(
                          and(
                            eq(usagePackSubscriptions.id, row.id),
                            eq(usagePackSubscriptions.orgId, row.orgId),
                            eq(
                              usagePackSubscriptions.subscriptionStatus,
                              "purchase_pending",
                            ),
                          ),
                        );
                    },
                  ),
            );
            onTestFinished(async () => {
              await pending;
            });
            await barrier.entered;
            await transition(harness.db, row.orgId, row.id, "active");
            barrier.release();
            const outcome = await pending;
            if (operation === "repair") {
              expect(outcome).toStrictEqual({ ok: true, value: undefined });
            } else {
              expect(outcome).toMatchObject({
                ok: false,
                error: expect.any(UsagePackPendingSnapshotConflict),
              });
            }
          },
        },
        context.signal,
      );

      await expect(guard(harness.db, row.orgId)).resolves.toBe(0);
      await expect(
        harness.db
          .select({ status: usagePackSubscriptions.subscriptionStatus })
          .from(usagePackSubscriptions)
          .where(eq(usagePackSubscriptions.id, row.id)),
      ).resolves.toStrictEqual([{ status: "active" }]);
      await insert(harness.db, values(row.orgId));
      await expect(guard(harness.db, row.orgId)).resolves.toBe(1);
    },
  );

  it("keeps repeated pending-to-pending transitions idempotent", async () => {
    const row = values(`org_${randomUUID()}`);
    await insert(harness.db, row);
    await transition(harness.db, row.orgId, row.id, "checkout_pending");
    await transition(harness.db, row.orgId, row.id, "checkout_pending");
    await expect(guard(harness.db, row.orgId)).resolves.toBe(1);
    await expect(insert(harness.db, values(row.orgId))).rejects.toMatchObject({
      message:
        "Another usage-pack purchase is already pending for this organization",
    });
  });

  it.each([
    "active",
    "incomplete",
    "canceled",
    "incomplete_expired",
    "invalid",
    "checkout_expired",
  ])("releases %s and permits the next purchase", async (status) => {
    const row = values(`org_${randomUUID()}`);
    await insert(harness.db, row);
    await transition(harness.db, row.orgId, row.id, status);
    await transition(harness.db, row.orgId, row.id, status);
    await expect(guard(harness.db, row.orgId)).resolves.toBe(0);
    await insert(harness.db, values(row.orgId));
    await expect(guard(harness.db, row.orgId)).resolves.toBe(1);
  });

  it("releases deletion and tolerates a repeated delete", async () => {
    const row = values(`org_${randomUUID()}`);
    await insert(harness.db, row);
    for (let attempt = 0; attempt < 2; attempt++) {
      await writeUsagePackPendingSnapshots(
        harness.db,
        [row.orgId],
        async (tx) => {
          await tx
            .delete(usagePackSubscriptions)
            .where(eq(usagePackSubscriptions.id, row.id));
        },
      );
    }
    await expect(guard(harness.db, row.orgId)).resolves.toBe(0);
    await insert(harness.db, values(row.orgId));
  });

  it("rolls back both the primary write and guard on a later failure", async () => {
    const row = values(`org_${randomUUID()}`);
    await expect(
      writeUsagePackPendingSnapshots(harness.db, [row.orgId], async (tx) => {
        await tx.insert(usagePackSubscriptions).values(row);
        await tx.insert(usagePackAllocations).values({
          usagePackSubscriptionId: row.id,
          orgId: row.orgId,
          userId: `user_${randomUUID()}`,
          usagePackUsd: 1,
          stripePriceId: "price_invalid",
        });
      }),
    ).rejects.toMatchObject({
      cause: {
        code: "23514",
        constraint: "chk_usage_pack_allocations_package",
      },
    });
    await expect(
      harness.db.select().from(usagePackSubscriptions),
    ).resolves.toStrictEqual([]);
    await insert(harness.db, row);
    await expect(guard(harness.db, row.orgId)).resolves.toBe(1);
    await expect(
      writeUsagePackPendingSnapshots(harness.db, [row.orgId], async (tx) => {
        await tx
          .delete(usagePackSubscriptions)
          .where(eq(usagePackSubscriptions.id, row.id));
        throw new Error("cleanup failed");
      }),
    ).rejects.toThrow("cleanup failed");
    await expect(guard(harness.db, row.orgId)).resolves.toBe(1);
  });

  it("preserves grandfathered pending counts until all old purchases release", async () => {
    const orgId = `org_${randomUUID()}`;
    const [first, second] = await grandfather(harness.db, orgId);
    if (!first || !second) {
      throw new Error("Expected grandfathered rows");
    }
    await expect(guard(harness.db, orgId)).resolves.toBe(2);
    await transition(harness.db, orgId, first.id, "checkout_pending");
    await expect(insert(harness.db, values(orgId))).rejects.toMatchObject({
      message:
        "Another usage-pack purchase is already pending for this organization",
    });
    await transition(harness.db, orgId, first.id, "canceled");
    await expect(guard(harness.db, orgId)).resolves.toBe(1);
    await expect(insert(harness.db, values(orgId))).rejects.toMatchObject({
      message:
        "Another usage-pack purchase is already pending for this organization",
    });
    await transition(harness.db, orgId, second.id, "checkout_expired");
    await insert(harness.db, values(orgId));
    await expect(guard(harness.db, orgId)).resolves.toBe(1);
  });

  it("retires several grandfathered snapshots and allocates their replacement atomically", async () => {
    const orgId = `org_${randomUUID()}`;
    await grandfather(harness.db, orgId);
    await writeUsagePackPendingSnapshots(harness.db, [orgId], async (tx) => {
      await tx
        .update(usagePackSubscriptions)
        .set({ subscriptionStatus: "checkout_expired" })
        .where(eq(usagePackSubscriptions.orgId, orgId));
      await tx.insert(usagePackSubscriptions).values(values(orgId));
    });
    await expect(guard(harness.db, orgId)).resolves.toBe(1);
  });

  it("moves pending ownership and rolls back a move into an occupied organization", async () => {
    const row = values(`org_${randomUUID()}`);
    const target = `org_${randomUUID()}`;
    await insert(harness.db, row);
    await writeUsagePackPendingSnapshots(
      harness.db,
      [target, row.orgId],
      async (tx) => {
        await tx
          .update(usagePackSubscriptions)
          .set({ orgId: target })
          .where(eq(usagePackSubscriptions.id, row.id));
      },
    );
    await expect(guard(harness.db, row.orgId)).resolves.toBe(0);
    await expect(guard(harness.db, target)).resolves.toBe(1);
    await insert(harness.db, values(row.orgId));
    await expect(
      writeUsagePackPendingSnapshots(
        harness.db,
        [row.orgId, target],
        async (tx) => {
          await tx
            .update(usagePackSubscriptions)
            .set({ orgId: row.orgId })
            .where(eq(usagePackSubscriptions.id, row.id));
        },
      ),
    ).rejects.toMatchObject({
      message:
        "Another usage-pack purchase is already pending for this organization",
    });
    await expect(guard(harness.db, row.orgId)).resolves.toBe(1);
    await expect(guard(harness.db, target)).resolves.toBe(1);
    await expect(
      harness.db
        .select({ orgId: usagePackSubscriptions.orgId })
        .from(usagePackSubscriptions)
        .where(eq(usagePackSubscriptions.id, row.id)),
    ).resolves.toStrictEqual([{ orgId: target }]);
  });

  it("rejects a stale lifecycle reference after its subscription moves organizations", async () => {
    const row = values(`org_${randomUUID()}`);
    const target = `org_${randomUUID()}`;
    await insert(harness.db, row);
    await writeUsagePackPendingSnapshots(
      harness.db,
      [row.orgId, target],
      async (tx) => {
        await tx
          .update(usagePackSubscriptions)
          .set({ orgId: target })
          .where(eq(usagePackSubscriptions.id, row.id));
      },
    );
    await expect(
      writeUsagePackPendingSnapshots(
        harness.db,
        [row.orgId],
        async (tx) => {
          await tx
            .update(usagePackSubscriptions)
            .set({ subscriptionStatus: "canceled" })
            .where(eq(usagePackSubscriptions.id, row.id));
        },
        [row.id],
      ),
    ).rejects.toThrow("outside its locked scope");
    await expect(guard(harness.db, target)).resolves.toBe(1);
    await expect(
      harness.db
        .select({ status: usagePackSubscriptions.subscriptionStatus })
        .from(usagePackSubscriptions)
        .where(eq(usagePackSubscriptions.id, row.id)),
    ).resolves.toStrictEqual([{ status: "purchase_pending" }]);
    await transition(harness.db, target, row.id, "canceled");
    await expect(guard(harness.db, target)).resolves.toBe(0);
  });

  it("requires both organizations for a move, including non-pending rows", async () => {
    const row = values(`org_${randomUUID()}`, "active");
    await insert(harness.db, row);
    await expect(
      writeUsagePackPendingSnapshots(harness.db, [row.orgId], async (tx) => {
        await tx
          .update(usagePackSubscriptions)
          .set({ orgId: `org_${randomUUID()}` })
          .where(eq(usagePackSubscriptions.id, row.id));
      }),
    ).rejects.toThrow("outside its locked scope");
    await expect(guard(harness.db, row.orgId)).resolves.toBe(0);
  });

  it("fails closed on corrupt counts and repairs from actual pending rows explicitly", async () => {
    const row = values(`org_${randomUUID()}`);
    await insert(harness.db, row);
    await harness.db
      .update(usagePackPendingSnapshotGuards)
      .set({ pendingSnapshotCount: 0 })
      .where(eq(usagePackPendingSnapshotGuards.orgId, row.orgId));
    await expect(
      transition(harness.db, row.orgId, row.id, "canceled"),
    ).rejects.toThrow("requires repair");
    await repairUsagePackPendingSnapshotGuards(harness.db, [row.orgId]);
    await transition(harness.db, row.orgId, row.id, "canceled");
    await expect(guard(harness.db, row.orgId)).resolves.toBe(0);
  });
});
