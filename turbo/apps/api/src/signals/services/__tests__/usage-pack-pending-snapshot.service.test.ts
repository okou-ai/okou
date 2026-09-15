import { randomUUID } from "node:crypto";

import {
  usagePackAllocations,
  usagePackPendingSnapshotGuards,
  usagePackSubscriptions,
} from "@okouai/db/schema/usage-pack-subscription";
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
  repairUsagePackPendingSnapshotGuards,
  writeUsagePackPendingSnapshots,
} from "../usage-pack-pending-snapshot.service";

import { usagePackPurchaseSerializationSchemaAvailable } from "../usage-pack-subscription.service";

const context = testContext();

// HTTP callers cannot select installed triggers, grandfathered/corrupt guard
// state, org movement or database lock interleavings. Each case owns its schema.
async function createHarness(retained: boolean) {
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
    db.transaction(async (tx) => {
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
      if (retained) {
        await tx.execute(sql`CREATE TRIGGER sync_usage_pack_pending_snapshot_guard_0954
        AFTER INSERT OR DELETE OR UPDATE OF org_id, subscription_status ON usage_pack_subscriptions
        FOR EACH ROW EXECUTE FUNCTION public.sync_usage_pack_pending_snapshot_guard_0954()`);
      }
    }),
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

async function backendPid(tx: Tx) {
  const [row] = await tx
    .select({ pid: sql`pg_backend_pid()`.mapWith(pgIntegerDecoder) })
    .from(sql`(SELECT 1) AS backend`);
  if (!row) {
    throw new Error("Expected transaction backend");
  }
  return row.pid;
}

async function expectBlocked(db: ApiDb, pid: number) {
  await expect
    .poll(async () => {
      const [row] = await db
        .select({
          blocked: sql`cardinality(pg_blocking_pids(${pid})) > 0`.mapWith(
            pgBooleanDecoder,
          ),
        })
        .from(sql`(SELECT 1) AS blocking_state`);
      return row?.blocked;
    })
    .toBe(true);
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

describe.each([true, false])(
  "pending snapshots with retained trigger: %s",
  (retained) => {
    let harness: Awaited<ReturnType<typeof createHarness>>;
    beforeEach(async () => {
      harness = await createHarness(retained);
    });
    afterEach(async () => {
      await harness.destroy();
    });

    it("keeps checkout available with its guard/index even when the trigger is absent", async () => {
      await expect(
        usagePackPurchaseSerializationSchemaAvailable(harness.db),
      ).resolves.toBeTruthy();
      await harness.db.execute(
        sql`DROP INDEX uq_usage_pack_subscriptions_pending_org`,
      );
      await expect(
        usagePackPurchaseSerializationSchemaAvailable(harness.db),
      ).resolves.toBeFalsy();
      await harness.db.execute(
        sql`CREATE INDEX uq_usage_pack_subscriptions_pending_org ON usage_pack_pending_snapshot_guards (org_id)`,
      );
      await expect(
        usagePackPurchaseSerializationSchemaAvailable(harness.db),
      ).resolves.toBeFalsy();
    });

    it("requires the guard count constraint and non-null count column", async () => {
      await harness.db.execute(
        sql`ALTER TABLE usage_pack_pending_snapshot_guards DROP CONSTRAINT chk_usage_pack_pending_snapshot_guard_count`,
      );
      await expect(
        usagePackPurchaseSerializationSchemaAvailable(harness.db),
      ).resolves.toBeFalsy();
      await harness.db.execute(
        sql`ALTER TABLE usage_pack_pending_snapshot_guards ADD CONSTRAINT chk_usage_pack_pending_snapshot_guard_count CHECK (pending_snapshot_count >= 0)`,
      );
      await harness.db.execute(
        sql`ALTER TABLE usage_pack_pending_snapshot_guards ALTER COLUMN pending_snapshot_count DROP NOT NULL`,
      );
      await expect(
        usagePackPurchaseSerializationSchemaAvailable(harness.db),
      ).resolves.toBeFalsy();
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

    it("keeps repeated pending-to-pending transitions idempotent", async () => {
      const row = values(`org_${randomUUID()}`);
      await insert(harness.db, row);
      await transition(harness.db, row.orgId, row.id, "checkout_pending");
      await transition(harness.db, row.orgId, row.id, "checkout_pending");
      await expect(guard(harness.db, row.orgId)).resolves.toBe(1);
      await expect(insert(harness.db, values(row.orgId))).rejects.toMatchObject(
        retained
          ? {
              cause: {
                code: "23505",
                constraint: "uq_usage_pack_subscriptions_pending_org",
              },
            }
          : {
              message:
                "Another usage-pack purchase is already pending for this organization",
            },
      );
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
      await expect(insert(harness.db, values(orgId))).rejects.toMatchObject(
        retained
          ? {
              cause: {
                code: "23505",
                constraint: "uq_usage_pack_subscriptions_pending_org",
              },
            }
          : {
              message:
                "Another usage-pack purchase is already pending for this organization",
            },
      );
      await transition(harness.db, orgId, first.id, "canceled");
      await expect(guard(harness.db, orgId)).resolves.toBe(1);
      await expect(insert(harness.db, values(orgId))).rejects.toMatchObject(
        retained
          ? {
              cause: {
                code: "23505",
                constraint: "uq_usage_pack_subscriptions_pending_org",
              },
            }
          : {
              message:
                "Another usage-pack purchase is already pending for this organization",
            },
      );
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
      ).rejects.toMatchObject(
        retained
          ? {
              cause: {
                code: "23505",
                constraint: "uq_usage_pack_subscriptions_pending_org",
              },
            }
          : {
              message:
                "Another usage-pack purchase is already pending for this organization",
            },
      );
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

    it("locks opposite organization movements in one deterministic order", async () => {
      const a = values(`org_${randomUUID()}`);
      const b = values(`org_${randomUUID()}`, "active");
      await insert(harness.db, a);
      await insert(harness.db, b);
      await Promise.all([
        writeUsagePackPendingSnapshots(
          harness.db,
          [a.orgId, b.orgId],
          async (tx) => {
            await tx
              .update(usagePackSubscriptions)
              .set({ orgId: b.orgId })
              .where(eq(usagePackSubscriptions.id, a.id));
          },
        ),
        writeUsagePackPendingSnapshots(
          harness.db,
          [b.orgId, a.orgId],
          async (tx) => {
            await tx
              .update(usagePackSubscriptions)
              .set({ orgId: a.orgId })
              .where(eq(usagePackSubscriptions.id, b.id));
          },
        ),
      ]);
      await expect(guard(harness.db, a.orgId)).resolves.toBe(0);
      await expect(guard(harness.db, b.orgId)).resolves.toBe(1);
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

    it("serializes prepared admission behind a terminal transition", async () => {
      const row = values(`org_${randomUUID()}`);
      await insert(harness.db, row);
      const entered = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      const pid = createDeferredPromise<number>(context.signal);
      const terminal = settle(
        writeUsagePackPendingSnapshots(harness.db, [row.orgId], async (tx) => {
          await tx
            .update(usagePackSubscriptions)
            .set({ subscriptionStatus: "canceled" })
            .where(eq(usagePackSubscriptions.id, row.id));
          entered.resolve(undefined);
          await release.promise;
        }),
      );
      await entered.promise;
      const admission = settle(
        harness.db.transaction(async (tx) => {
          pid.resolve(await backendPid(tx));
          await writeUsagePackPendingSnapshots(
            tx,
            [row.orgId],
            async (writeTx) => {
              await writeTx
                .insert(usagePackSubscriptions)
                .values(values(row.orgId));
            },
          );
        }),
      );
      const blocked = await settle(
        expectBlocked(harness.db, await pid.promise),
      );
      release.resolve(undefined);
      await expect(terminal).resolves.toMatchObject({ ok: true });
      await expect(admission).resolves.toMatchObject({ ok: true });
      if (!blocked.ok) {
        throw blocked.error;
      }
      await expect(guard(harness.db, row.orgId)).resolves.toBe(1);
    });
  },
);

describe("outgoing and prepared pending writers on the retained schema", () => {
  let harness: Awaited<ReturnType<typeof createHarness>>;
  beforeEach(async () => {
    harness = await createHarness(true);
  });
  afterEach(async () => {
    await harness.destroy();
  });

  it("waits for a legacy deletion before retiring the remaining grandfathered root", async () => {
    const orgId = `org_${randomUUID()}`;
    const [first, second] = await grandfather(harness.db, orgId);
    if (!first || !second) {
      throw new Error("Expected grandfathered roots");
    }
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    const pid = createDeferredPromise<number>(context.signal);
    const legacy = settle(
      harness.db.transaction(async (tx) => {
        await tx
          .delete(usagePackSubscriptions)
          .where(eq(usagePackSubscriptions.id, second.id));
        entered.resolve(undefined);
        await release.promise;
      }),
    );
    await entered.promise;
    const prepared = settle(
      harness.db.transaction(async (tx) => {
        pid.resolve(await backendPid(tx));
        await writeUsagePackPendingSnapshots(tx, [orgId], async (writeTx) => {
          await writeTx
            .update(usagePackSubscriptions)
            .set({ subscriptionStatus: "canceled" })
            .where(eq(usagePackSubscriptions.id, first.id));
          await writeTx.insert(usagePackSubscriptions).values(values(orgId));
        });
      }),
    );
    const blocked = await settle(expectBlocked(harness.db, await pid.promise));
    release.resolve(undefined);
    await expect(legacy).resolves.toMatchObject({ ok: true });
    await expect(prepared).resolves.toMatchObject({ ok: true });
    if (!blocked.ok) {
      throw blocked.error;
    }
    await expect(guard(harness.db, orgId)).resolves.toBe(1);
  });

  it.each([true, false])(
    "serializes a legacy organization move first: %s",
    async (legacyFirst) => {
      const row = values(`org_${randomUUID()}`);
      const target = `org_${randomUUID()}`;
      await insert(harness.db, row);
      const entered = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      const pid = createDeferredPromise<number>(context.signal);
      const move = async (tx: Tx) => {
        await tx
          .update(usagePackSubscriptions)
          .set({ orgId: target })
          .where(eq(usagePackSubscriptions.id, row.id));
        entered.resolve(undefined);
        await release.promise;
      };
      const first = settle(
        legacyFirst
          ? harness.db.transaction(move)
          : writeUsagePackPendingSnapshots(
              harness.db,
              [target, row.orgId],
              move,
            ),
      );
      await entered.promise;
      const second = settle(
        harness.db.transaction(async (tx) => {
          pid.resolve(await backendPid(tx));
          const cancel = async (writeTx: Tx) => {
            await writeTx
              .update(usagePackSubscriptions)
              .set({ subscriptionStatus: "canceled" })
              .where(eq(usagePackSubscriptions.id, row.id));
          };
          if (legacyFirst) {
            await writeUsagePackPendingSnapshots(
              tx,
              [row.orgId, target],
              cancel,
            );
          } else {
            await cancel(tx);
          }
        }),
      );
      const blocked = await settle(
        expectBlocked(harness.db, await pid.promise),
      );
      release.resolve(undefined);
      await expect(first).resolves.toMatchObject({ ok: true });
      await expect(second).resolves.toMatchObject({ ok: true });
      if (!blocked.ok) {
        throw blocked.error;
      }
      await expect(guard(harness.db, row.orgId)).resolves.toBe(0);
      await expect(guard(harness.db, target)).resolves.toBe(0);
    },
  );

  it.each([true, false])(
    "orders legacy terminal first: %s without repeating its decrement",
    async (legacyFirst) => {
      const row = values(`org_${randomUUID()}`);
      await insert(harness.db, row);
      const entered = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      const pid = createDeferredPromise<number>(context.signal);
      const terminalWrite = async (tx: Tx) => {
        await tx
          .update(usagePackSubscriptions)
          .set({ subscriptionStatus: "canceled" })
          .where(eq(usagePackSubscriptions.id, row.id));
      };
      const first = settle(
        legacyFirst
          ? harness.db.transaction(async (tx) => {
              await terminalWrite(tx);
              entered.resolve(undefined);
              await release.promise;
            })
          : writeUsagePackPendingSnapshots(
              harness.db,
              [row.orgId],
              async () => {
                entered.resolve(undefined);
                await release.promise;
              },
            ),
      );
      await entered.promise;
      const second = settle(
        harness.db.transaction(async (tx) => {
          pid.resolve(await backendPid(tx));
          if (legacyFirst) {
            await writeUsagePackPendingSnapshots(
              tx,
              [row.orgId],
              async (writeTx) => {
                await writeTx
                  .insert(usagePackSubscriptions)
                  .values(values(row.orgId));
              },
            );
          } else {
            await terminalWrite(tx);
          }
        }),
      );
      const blocked = await settle(
        expectBlocked(harness.db, await pid.promise),
      );
      release.resolve(undefined);
      await expect(first).resolves.toMatchObject({ ok: true });
      await expect(second).resolves.toMatchObject({ ok: true });
      if (!blocked.ok) {
        throw blocked.error;
      }
      await expect(guard(harness.db, row.orgId)).resolves.toBe(
        legacyFirst ? 1 : 0,
      );
    },
  );

  it.each([true, false])(
    "orders legacy admission first: %s and rejects a competing writer",
    async (legacyFirst) => {
      const row = values(`org_${randomUUID()}`);
      const entered = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      const pid = createDeferredPromise<number>(context.signal);
      const firstWrite = async (tx: Tx) => {
        await tx.insert(usagePackSubscriptions).values(row);
        entered.resolve(undefined);
        await release.promise;
      };
      const first = settle(
        legacyFirst
          ? harness.db.transaction(firstWrite)
          : writeUsagePackPendingSnapshots(harness.db, [row.orgId], firstWrite),
      );
      await entered.promise;
      const second = settle(
        harness.db.transaction(async (tx) => {
          pid.resolve(await backendPid(tx));
          if (legacyFirst) {
            await writeUsagePackPendingSnapshots(
              tx,
              [row.orgId],
              async (writeTx) => {
                await writeTx
                  .insert(usagePackSubscriptions)
                  .values(values(row.orgId));
              },
            );
          } else {
            await tx.insert(usagePackSubscriptions).values(values(row.orgId));
          }
        }),
      );
      const blocked = await settle(
        expectBlocked(harness.db, await pid.promise),
      );
      release.resolve(undefined);
      await expect(first).resolves.toMatchObject({ ok: true });
      await expect(second).resolves.toMatchObject({ ok: false });
      if (!blocked.ok) {
        throw blocked.error;
      }
      await expect(guard(harness.db, row.orgId)).resolves.toBe(1);
      await expect(
        harness.db.select().from(usagePackSubscriptions),
      ).resolves.toHaveLength(1);
    },
  );
});
